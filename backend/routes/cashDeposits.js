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
    if (bodyDate) {
      masterDb.prepare(`
        UPDATE cash_deposits
           SET status = 'CONFIRMED',
               deposit_date = ?,
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now')
         WHERE id = ?
      `).run(bodyDate, req.user.id, confirmedByName, req.params.id);
    } else {
      masterDb.prepare(`
        UPDATE cash_deposits
           SET status = 'CONFIRMED',
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now')
         WHERE id = ?
      `).run(req.user.id, confirmedByName, req.params.id);
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

// ─── DELETE /cash-deposits/:id — remove a deposit ───────────────────────────
// v1.8.60 — allow deleting deposits to clean up mistakes / cancelled records.
// Branch can delete its own PENDING deposits; HQ can delete anything.
// CONFIRMED deposits should NOT be silently deleted by branches because
// HQ may have already balanced its drawer against them — gate behind HQ.
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    masterDb.prepare('DELETE FROM cash_deposits WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deposit deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
