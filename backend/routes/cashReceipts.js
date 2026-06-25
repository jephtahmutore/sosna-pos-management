const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// Derive per-method splits (cash/bank/momo) from the receipt's payment_method.
// Mirrors the migration backfill rules so on-startup backfills and live INSERTs
// produce identical splits. Unknown / empty payment_method falls into the Cash
// bucket — same catch-all the backfill uses, prevents money from going invisible.
function deriveCRSplits(payment_method, amount) {
  const amt = parseFloat(amount) || 0;
  if (['Bank Transfer', 'Bank', 'Cheque'].includes(payment_method)) return { cash: 0, bank: amt, momo: 0 };
  if (payment_method === 'Mobile Money')                            return { cash: 0, bank: 0,   momo: amt };
  return { cash: amt, bank: 0, momo: 0 }; // 'Cash' + unknown/empty default
}

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY date DESC').all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // v1.8.31 — per-currency totals. Same CASE-WHEN pattern as PV stats
    // (v1.8.25): prefer new usd/fra/k columns, fall back to legacy
    // cash/bank/momo on rows where new columns are 0.
    const usdExpr = `COALESCE(SUM(CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount ELSE COALESCE(cash_amount,0) END), 0)`;
    const fraExpr = `COALESCE(SUM(CASE WHEN COALESCE(fra_amount,0) > 0 THEN fra_amount ELSE COALESCE(bank_amount,0) END), 0)`;
    const kExpr   = `COALESCE(SUM(CASE WHEN COALESCE(k_amount,  0) > 0 THEN k_amount   ELSE COALESCE(momo_amount,0) END), 0)`;
    const totalsRow = (whereExtra, params) => db.prepare(
      `SELECT ${usdExpr} AS usd, ${fraExpr} AS fra, ${kExpr} AS k
       FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?${whereExtra}`
    ).get(...params);
    const today = totalsRow(" AND date = DATE('now')", [tenantId]);
    const month = totalsRow(" AND date >= date('now', 'start of month')", [tenantId]);
    const all   = totalsRow('', [tenantId]);
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    res.json({
      // Legacy USD-only fields kept for any caller still reading them.
      todayReceipts: parseFloat(today.usd) || 0,
      thisMonth:     parseFloat(month.usd) || 0,
      totalReceipts: count.cnt,
      avgReceipt:    count.cnt > 0 ? Math.round((parseFloat(all.usd) || 0) / count.cnt) : 0,
      // v1.8.31 — per-currency breakdowns.
      today: { usd: parseFloat(today.usd) || 0, fra: parseFloat(today.fra) || 0, k: parseFloat(today.k) || 0 },
      month: { usd: parseFloat(month.usd) || 0, fra: parseFloat(month.fra) || 0, k: parseFloat(month.k) || 0 },
      total: { usd: parseFloat(all.usd)   || 0, fra: parseFloat(all.fra)   || 0, k: parseFloat(all.k)   || 0 },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check if a Sales CR exists for a given date + received_from (must be before /:id)
router.get('/check-sales', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, received_from } = req.query;
    if (!date) return res.json({ exists: false });
    const receivedFrom = received_from || 'Sales';
    const row = db.prepare(
      'SELECT id, receipt_number, amount FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ? AND received_from = ? AND date = ?'
    ).get(req.user.tenantId, receivedFrom, date);
    if (row) {
      res.json({ exists: true, ...row });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { received_from, description, payment_method, amount, date,
            cash_amount, bank_amount, momo_amount } = req.body;
    const crDate = date || new Date().toISOString().split('T')[0];
    const receiptNum = syncConfig.generateNumber('CR', 'cash_receipts');
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    // Prefer client-sent per-method splits (the new CR form sends these
    // directly). Fall back to deriving from payment_method for any older
    // caller that still POSTs a single-method receipt.
    const sumSplits = (parseFloat(cash_amount) || 0) + (parseFloat(bank_amount) || 0) + (parseFloat(momo_amount) || 0);
    const splits = sumSplits > 0
      ? { cash: parseFloat(cash_amount) || 0, bank: parseFloat(bank_amount) || 0, momo: parseFloat(momo_amount) || 0 }
      : deriveCRSplits(payment_method, amount);
    const totalAmount = sumSplits > 0 ? sumSplits : parseFloat(amount) || 0;
    const info = db.prepare(
      `INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount,
                                  cash_amount, bank_amount, momo_amount,
                                  date, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    ).run(receiptNum, received_from, description, payment_method, totalAmount,
          splits.cash, splits.bank, splits.momo,
          crDate, req.user.id, randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM cash_receipts WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM cash_receipts WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Receipt not found' });
    db.prepare("UPDATE cash_receipts SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Receipt deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { received_from, description, payment_method, amount, date,
            cash_amount, bank_amount, momo_amount } = req.body;
    const sumSplits = (parseFloat(cash_amount) || 0) + (parseFloat(bank_amount) || 0) + (parseFloat(momo_amount) || 0);
    const splits = sumSplits > 0
      ? { cash: parseFloat(cash_amount) || 0, bank: parseFloat(bank_amount) || 0, momo: parseFloat(momo_amount) || 0 }
      : deriveCRSplits(payment_method, amount);
    const totalAmount = sumSplits > 0 ? sumSplits : parseFloat(amount) || 0;
    const info = db.prepare(
      `UPDATE cash_receipts
          SET received_from=?, description=?, payment_method=?, amount=?,
              cash_amount=?, bank_amount=?, momo_amount=?,
              date=?, updated_at=datetime('now'), synced=0
        WHERE id=?`
    ).run(received_from, description, payment_method, totalAmount,
          splits.cash, splits.bank, splits.momo,
          date, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Receipt not found' });
    const row = db.prepare('SELECT * FROM cash_receipts WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
