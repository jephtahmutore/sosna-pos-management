/**
 * cashDeposits.js — Branch → HQ Cash Deposit workflow.
 *
 * Branch records a physical cash deposit being sent to HQ; HQ confirms
 * when the cash arrives. On confirm we move the money in BOTH ledgers:
 *   - Branch tenant DB: payment_vouchers entry  (cash OUT, category 'HQ Deposit')
 *   - HQ tenant DB:     cash_receipts entry      (cash IN,  payment_method 'Deposit')
 *
 * Deposit row lives in master.db so both sides read the same record
 * without cross-DB joins (same pattern as stock_transfers).
 *
 * State machine on cash_deposits.status:
 *   PENDING    — branch sent, HQ hasn't confirmed yet
 *   CONFIRMED  — HQ acknowledged receipt, ledger entries written
 *   REJECTED   — HQ rejected (cash didn't arrive / wrong amount). No ledgers move.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
// v1.10.180 — Phase 2b: HQ receives K deposits from branches. K deposits
// are native (they came from customer sales at the branch level, no USD
// basis was ever spent). Pool_native_k grows on confirm.
const hqDb = require('../config/database');
const { poolInflowNative } = require('../config/cashPoolHelper');

function hqAuth(req, res, next) {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Access denied' });
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'sosna-pro-secret-key-2026');
    next();
  } catch (_) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function branchName(slug) {
  try {
    const t = listTenants().find(t => t.slug === slug);
    if (!t) return slug;
    try {
      const db = getTenantDb(slug);
      const row = db.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
      if (row?.business_name) return row.business_name;
    } catch (_) { /* fall through */ }
    return t.business_name || slug;
  } catch (_) { return slug; }
}

// Pick the HQ tenant slug. Sosna's setup: the bare host (sosnazm.com) is
// HQ itself — its tenant DB is registered with a known slug. Fall back
// to 'hq' if the convention changes.
function getHqSlug() {
  try {
    const t = listTenants().find(t => t.slug === 'hq');
    if (t) return 'hq';
    // Sometimes HQ is registered with the bare-host slug
    const bare = listTenants().find(t => /^(sosna|sosnazm|hq)$/i.test(t.slug));
    return bare ? bare.slug : 'hq';
  } catch (_) { return 'hq'; }
}

function nextDepositNumber() {
  const seq = (masterDb.prepare('SELECT COUNT(*) AS n FROM cash_deposits').get()?.n || 0) + 1;
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `DEP-${yyyymmdd}-${String(seq).padStart(4, '0')}`;
}

// ─── POST /cash-deposits — branch records a new deposit being sent ──────────
router.post('/', hqAuth, (req, res) => {
  try {
    const { from_slug, currency, amount, notes, deposit_date, attachment, from_method } = req.body;
    if (!from_slug || !isRegistered(from_slug)) return res.status(400).json({ error: 'Unknown source branch' });
    const ccy = String(currency || '').toUpperCase();
    if (!['USD', 'FRA', 'K'].includes(ccy)) return res.status(400).json({ error: 'currency must be USD, FRA, or K' });
    const amt = parseFloat(amount || 0) || 0;
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });

    // v1.10.167 — overdraft guard on Liquor branches.
    // v1.10.198 — guard is now PER-DRAWER (Cash / Bank / Mobile Money)
    // rather than the pooled Cash & Cash Equivalent. Prior version let
    // an operator deposit e.g. K25,000 "from Mobile Money" when Mobile
    // Money physically had K21,565 — the pool covered it because Cash
    // had K10,565 on top. Reads the branch's per-drawer sub-columns and
    // subtracts prior confirmed/pending deposits FROM THE SAME METHOD.
    // Sosna tri-currency branches still skip (per-currency drawers).
    try {
      const branchDb = getTenantDb(from_slug);
      const bs = branchDb.prepare(`SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`).get();
      const isLiquorK = (bs?.currency_mode || '').toUpperCase() === 'K';
      if (isLiquorK) {
        // Per-drawer column pick. from_method arrives from the modal
        // ('Cash' | 'Bank' | 'Mobile Money'). Default to Cash for
        // safety if a caller omits it.
        const methodToCol = {
          'Cash':         { col: 'cash_amount', ob: 'OB-CASH', label: 'Cash' },
          'Bank':         { col: 'bank_amount', ob: 'OB-BANK', label: 'Bank' },
          'Mobile Money': { col: 'momo_amount', ob: 'OB-MOMO', label: 'Mobile Money' },
        };
        const pick = methodToCol[from_method] || methodToCol['Cash'];
        // Legacy: opening rows might use plain 'OB' without a per-method
        // suffix. Only count 'OB' toward Cash to avoid triple-counting.
        const seedOb = pick.ob === 'OB-CASH' ? [pick.ob, 'OB'] : [pick.ob];
        const seedPlaceholders = seedOb.map(() => '?').join(',');
        const seed = branchDb.prepare(`
          SELECT COALESCE(SUM(receipt_amount), 0) AS s
            FROM cash_book
           WHERE type = 'opening' AND deleted_at IS NULL
             AND reference IN (${seedPlaceholders})
        `).get(...seedOb)?.s || 0;
        const crAll = branchDb.prepare(`
          SELECT COALESCE(SUM(COALESCE(${pick.col}, 0)), 0) AS s
            FROM cash_receipts WHERE deleted_at IS NULL
        `).get()?.s || 0;
        const pvAll = branchDb.prepare(`
          SELECT COALESCE(SUM(COALESCE(${pick.col}, 0)), 0) AS s
            FROM payment_vouchers WHERE deleted_at IS NULL
        `).get()?.s || 0;
        let apAll = 0;
        try {
          apAll = branchDb.prepare(`
            SELECT COALESCE(SUM(COALESCE(${pick.col}, 0)), 0) AS s
              FROM ap_payments WHERE deleted_at IS NULL
          `).get()?.s || 0;
        } catch (_) { /* ap_payments may not exist / may not have the column */ }
        const priorDeposits = masterDb.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS s
            FROM cash_deposits
           WHERE from_slug = ? AND currency = 'K'
             AND from_method = ?
             AND status IN ('PENDING', 'CONFIRMED')
             AND deleted_at IS NULL
        `).get(from_slug, from_method)?.s || 0;
        const drawerBalance = seed + crAll - pvAll - apAll - priorDeposits;
        if (amt > drawerBalance + 0.0001) {
          return res.status(400).json({
            error: `Deposit exceeds ${pick.label} balance (K ${drawerBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}). Reduce the amount or pick a different drawer.`,
            drawer:          pick.label,
            drawer_balance:  drawerBalance,
            attempted:       amt,
          });
        }
      }
    } catch (_) { /* branch DB unavailable — skip guard, don't block */ }

    // v1.10.48 — from_method: physical drawer on Liquor branches
    // ('Cash' | 'Mobile Money' | 'Bank'). Optional; NULL on Sosna
    // tri-currency deposits (they're currency-anchored). Frontend gate
    // decides when to send it based on isLiquorStyle.
    const VALID_METHODS = new Set(['Cash', 'Mobile Money', 'Bank']);
    const method = VALID_METHODS.has(from_method) ? from_method : null;

    // v1.8.59 — no FX rate stored. Physical deposit is just raw currency;
    // any conversion at HQ is a separate Currency Exchange concern.
    // v1.8.60 — accept optional deposit_date (defaults to today) and
    // attachment path (uploaded separately via /api/attachments).
    const looksLikeDate = typeof deposit_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deposit_date);
    const depDate = looksLikeDate ? deposit_date : new Date().toISOString().slice(0, 10);
    const syncId = randomUUID();
    const depositNumber = nextDepositNumber();
    const fromName = branchName(from_slug);

    masterDb.prepare(`
      INSERT INTO cash_deposits (deposit_number, sync_id, from_slug, from_name,
                                 currency, amount, amount_usd, sell_rate, notes,
                                 deposit_date, attachment, from_method,
                                 status, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)
    `).run(
      depositNumber, syncId, from_slug, fromName,
      ccy, amt, 0, null, notes || null,
      depDate, attachment || null, method,
      req.user.id, [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null
    );
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE sync_id = ?').get(syncId);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /cash-deposits — list deposits ────────────────────────────────────
// Query: ?from_slug=kassumbalesa1 (branch's own outgoing list)
//        no params + caller is HQ → returns ALL deposits (used by HQ inbox)
//        ?status=PENDING to filter
router.get('/', hqAuth, (req, res) => {
  try {
    const { from_slug, status } = req.query;
    const where = [];
    const params = [];
    if (from_slug) { where.push('from_slug = ?'); params.push(from_slug); }
    if (status)    { where.push('status = ?');    params.push(status); }
    const sql = `SELECT * FROM cash_deposits ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    const rows = masterDb.prepare(sql).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /cash-deposits/:id/confirm — HQ confirms the cash arrived ──────────
//
// v1.8.59 — REWRITE. A deposit is cash MOVEMENT between drawers, not P&L.
// We no longer write a payment_voucher (= expense, hits profit) on the
// branch or a cash_receipt (= income, hits profit) on HQ — those caused
// phantom profit deltas on both sides.
//
// Instead we just flip the master.db row to CONFIRMED. The Cash Report
// daily aggregation already subtracts confirmed-today outgoing deposits
// from the branch's per-currency Expected, and adds incoming deposits to
// the HQ's per-currency Expected, so drawer reconciliation still works
// — without inventing income/expense events.
router.put('/:id/confirm', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.deleted_at) return res.status(400).json({ error: 'Deposit was deleted; cannot confirm.' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Deposit is already ${row.status}` });
    const confirmedByName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null;
    // v1.10.82 — HQ can override deposit_date at confirm time. Cash Book
    // shows the deposit under whatever date HQ picks here (fallback:
    // confirmed_at, then created_at — see routes/cashBook.js:402).
    // Guard: only YYYY-MM-DD strings; anything else falls back to the
    // existing deposit_date.
    const bodyDate = typeof req.body?.deposit_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.deposit_date)
      ? req.body.deposit_date
      : null;
    // v1.10.134 — HQ picks which of its drawers (Cash / Bank / MoMo) the K
    // deposit lands in at confirm time. Fallback: use the branch-side
    // from_method (Bank branch → Bank HQ, etc.). Only meaningful for K
    // currency; USD/FRA deposits ignore this field.
    const VALID_TO_METHODS = new Set(['Cash', 'Bank', 'Mobile Money']);
    const bodyToMethod = typeof req.body?.to_method === 'string' && VALID_TO_METHODS.has(req.body.to_method)
      ? req.body.to_method
      : (row.from_method && VALID_TO_METHODS.has(row.from_method) ? row.from_method : null);
    if (bodyDate) {
      masterDb.prepare(`
        UPDATE cash_deposits
           SET status = 'CONFIRMED',
               deposit_date = ?,
               to_method = ?,
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now')
         WHERE id = ?
      `).run(bodyDate, bodyToMethod, req.user.id, confirmedByName, req.params.id);
    } else {
      masterDb.prepare(`
        UPDATE cash_deposits
           SET status = 'CONFIRMED',
               to_method = ?,
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now')
         WHERE id = ?
      `).run(bodyToMethod, req.user.id, confirmedByName, req.params.id);
    }
    // v1.10.180 — Phase 2b: K portion of the confirmed deposit lands in
    // HQ's Cash Book as native K (customer sales K remitted from branch).
    // hqDb (backend/sosna.db) holds the pool counters on business_settings.
    const kAmt = parseFloat(row.k_amount) || 0;
    if (kAmt > 0) {
      try { poolInflowNative(hqDb, kAmt); }
      catch (poolErr) { console.warn('[cash-pool] deposit confirm inflow failed:', poolErr.message); }
    }
    const updated = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /cash-deposits/:id/reject — HQ rejects (no ledger writes) ──────────
router.put('/:id/reject', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.deleted_at) return res.status(400).json({ error: 'Deposit was deleted; cannot reject.' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Deposit is already ${row.status}` });
    const confirmedByName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null;
    masterDb.prepare(`
      UPDATE cash_deposits
         SET status = 'REJECTED',
             confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now'),
             reject_reason = ?
       WHERE id = ?
    `).run(req.user.id, confirmedByName, req.body?.reason || null, req.params.id);
    const updated = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /cash-deposits/:id/date — edit accounting date of a CONFIRMED row ──
//
// v1.10.84 — HQ can move a CONFIRMED deposit to a different accounting
// date. Cash Book UNIONs directly from master.cash_deposits so the
// deposit re-lands on the new date automatically on both sides
// (branch's outgoing deduction shifts, HQ's incoming credit shifts).
//
// Only the accounting date changes; amount/currency/status stay put.
// Only CONFIRMED rows are editable through this endpoint — PENDING rows
// use the existing /confirm flow which already accepts a date, and
// REJECTED rows have no ledger effect so editing them is pointless.
router.put('/:id/date', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.deleted_at) return res.status(400).json({ error: 'Deposit was deleted; cannot edit date.' });
    if (row.status !== 'CONFIRMED') {
      return res.status(400).json({ error: `Only CONFIRMED deposits can have their date edited (current: ${row.status}).` });
    }
    const newDate = req.body?.deposit_date;
    if (typeof newDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return res.status(400).json({ error: 'deposit_date must be YYYY-MM-DD.' });
    }
    masterDb.prepare('UPDATE cash_deposits SET deposit_date = ? WHERE id = ?').run(newDate, req.params.id);
    const updated = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /cash-deposits/:id/edit — CONFIRMED-only full edit ─────────────────
//
// v1.10.168 — HQ can correct amount / from_method / notes / date on a
// CONFIRMED deposit. Gated behind reason + admin password (same rigor
// as the delete flow). PENDING deposits are NOT editable through this
// route — HQ hasn't seen the physical cash yet, so if the amount is
// wrong the correct action is Reject and let the branch resend, not
// silent HQ rewrite. REJECTED / DELETED are also locked.
//
// Body: { deposit_date?, amount?, from_method?, notes?, reason, adminId, adminName }
router.put('/:id/edit', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.deleted_at) return res.status(400).json({ error: 'Deposit was deleted; cannot edit.' });
    if (row.status !== 'CONFIRMED') {
      return res.status(400).json({ error: `Only CONFIRMED deposits can be edited (current: ${row.status}). For PENDING, use Confirm or Reject.` });
    }
    const { deposit_date, amount, from_method, notes, reason, adminId, adminName } = req.body || {};
    if (!reason || String(reason).trim().length < 3) {
      return res.status(400).json({ error: 'Reason (min 3 chars) is required for audit.' });
    }
    if (!adminId) {
      return res.status(400).json({ error: 'Admin authorization missing.' });
    }
    // Build the SET clause dynamically — only touch fields the client sent.
    const sets = [];
    const params = [];
    if (deposit_date !== undefined) {
      if (typeof deposit_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deposit_date)) {
        return res.status(400).json({ error: 'deposit_date must be YYYY-MM-DD.' });
      }
      sets.push('deposit_date = ?');
      params.push(deposit_date);
    }
    if (amount !== undefined) {
      const amt = parseFloat(amount);
      if (!isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'amount must be > 0.' });
      }
      sets.push('amount = ?');
      params.push(amt);
    }
    if (from_method !== undefined) {
      const VALID_METHODS = new Set(['Cash', 'Mobile Money', 'Bank']);
      if (from_method !== null && !VALID_METHODS.has(from_method)) {
        return res.status(400).json({ error: 'from_method must be Cash, Mobile Money, or Bank.' });
      }
      sets.push('from_method = ?');
      params.push(from_method || null);
    }
    if (notes !== undefined) {
      sets.push('notes = ?');
      params.push(notes ? String(notes).trim() : null);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'Nothing to edit — send at least one of deposit_date, amount, from_method, notes.' });
    }
    // Audit stamps always update.
    sets.push('edited_at = datetime(\'now\')');
    sets.push('edited_by = ?');           params.push(adminId);
    sets.push('edited_by_name = ?');      params.push(adminName || null);
    sets.push('edit_reason = ?');         params.push(String(reason).trim());
    params.push(req.params.id);
    masterDb.prepare(`UPDATE cash_deposits SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const updated = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /cash-deposits/:id — remove a deposit ───────────────────────────
// v1.8.60 — allow deleting deposits to clean up mistakes / cancelled records.
// v1.10.143 — now a SOFT delete gated by admin password verification. Hard
// delete on a CONFIRMED deposit silently reverses it on both sides (HQ and
// the depositing branch), making the branch's ledger show cash that was
// physically handed over as still on the books. Soft-delete keeps the row
// with an audit trail (deleted_by/deleted_at/delete_reason) so the list
// can render a DELETED badge (same pattern as REJECTED) while balance math
// excludes the row.
// Body: { reason, adminId, adminName } — adminId/Name come from a
//   client-side verify-admin call (same pattern as GRN void). Backend
//   trusts the attestation since only authenticated users reach this route.
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const { reason, adminId, adminName } = req.body || {};
    if (!reason || String(reason).trim().length < 3) {
      return res.status(400).json({ error: 'Reason (min 3 chars) is required for audit.' });
    }
    if (!adminId) {
      return res.status(400).json({ error: 'Admin authorization missing.' });
    }
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.deleted_at) return res.status(400).json({ error: 'Deposit already deleted.' });
    masterDb.prepare(`
      UPDATE cash_deposits
         SET deleted_at      = datetime('now'),
             deleted_by      = ?,
             deleted_by_name = ?,
             delete_reason   = ?
       WHERE id = ?
    `).run(adminId, adminName || null, String(reason).trim(), req.params.id);
    res.json({ message: 'Deposit deleted', ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
