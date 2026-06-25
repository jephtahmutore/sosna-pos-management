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
    const { from_slug, currency, amount, amount_usd, sell_rate, notes } = req.body;
    if (!from_slug || !isRegistered(from_slug)) return res.status(400).json({ error: 'Unknown source branch' });
    const ccy = String(currency || '').toUpperCase();
    if (!['USD', 'FRA', 'K'].includes(ccy)) return res.status(400).json({ error: 'currency must be USD, FRA, or K' });
    const amt = parseFloat(amount || 0) || 0;
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });
    const amtUsd = parseFloat(amount_usd || 0) || (ccy === 'USD' ? amt : 0);
    const rate   = parseFloat(sell_rate || 0) || null;

    const syncId = randomUUID();
    const depositNumber = nextDepositNumber();
    const fromName = branchName(from_slug);

    masterDb.prepare(`
      INSERT INTO cash_deposits (deposit_number, sync_id, from_slug, from_name,
                                 currency, amount, amount_usd, sell_rate, notes,
                                 status, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)
    `).run(
      depositNumber, syncId, from_slug, fromName,
      ccy, amt, amtUsd, rate, notes || null,
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
// Atomically writes:
//   - branch tenant DB: payment_vouchers row (cash OUT, category='HQ Deposit')
//   - HQ tenant DB:     cash_receipts row    (cash IN,  payment_method='Deposit')
router.put('/:id/confirm', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Deposit is already ${row.status}` });

    const hqSlug = getHqSlug();
    if (!isRegistered(hqSlug)) {
      return res.status(500).json({ error: 'HQ tenant DB not registered — cannot post the cash receipt' });
    }

    const branchDb = getTenantDb(row.from_slug);
    const hqDb     = getTenantDb(hqSlug);
    const confirmedByName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null;
    const today = new Date().toISOString().slice(0, 10);
    const desc  = `Deposit to HQ — ${row.deposit_number}` + (row.notes ? ` — ${row.notes}` : '');

    // Per-currency split for the ledger entries.
    const usdAmt = row.currency === 'USD' ? row.amount : 0;
    const fraAmt = row.currency === 'FRA' ? row.amount : 0;
    const kAmt   = row.currency === 'K'   ? row.amount : 0;

    masterDb.transaction(() => {
      // ── Branch side: write a PV (cash out) ────────────────────────────
      const pvNumber = `PV-${row.deposit_number}`;
      branchDb.prepare(`
        INSERT INTO payment_vouchers (voucher_number, paid_to, description, category, amount,
                                       cash_amount, bank_amount, momo_amount,
                                       usd_amount, fra_amount, k_amount,
                                       date, paid_from, created_by,
                                       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?, 0,0,0, ?,?,?, ?,?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))
      `).run(
        pvNumber, 'HQ', desc, 'HQ Deposit', row.amount_usd,
        usdAmt, fraAmt, kAmt,
        today, 'Cash', req.user.id,
        randomUUID(), null, null, null
      );

      // ── HQ side: write a CR (cash in) ─────────────────────────────────
      const crNumber = `CR-${row.deposit_number}`;
      hqDb.prepare(`
        INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount,
                                    cash_amount, bank_amount, momo_amount,
                                    usd_amount, fra_amount, k_amount,
                                    date, created_by,
                                    sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?, 0,0,0, ?,?,?, ?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))
      `).run(
        crNumber, row.from_name || row.from_slug, desc, 'Deposit', row.amount_usd,
        usdAmt, fraAmt, kAmt,
        today, req.user.id,
        randomUUID(), null, null, null
      );

      // ── Master row: mark CONFIRMED ────────────────────────────────────
      masterDb.prepare(`
        UPDATE cash_deposits
           SET status = 'CONFIRMED',
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now')
         WHERE id = ?
      `).run(req.user.id, confirmedByName, req.params.id);
    })();

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

module.exports = router;
