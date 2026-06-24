const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');

// Derive per-method splits from the voucher's paid_from string. Substring match
// (paid_from is free text like "Main cashier", "Bank — FNB", "MTN MoMo") so
// we lower-case and look for any of the recognised keywords. Same rules the
// migration backfill uses. Unknown / empty → Cash bucket (most common case).
function derivePVSplits(paid_from, amount) {
  const amt = parseFloat(amount) || 0;
  const pf  = (paid_from || '').toLowerCase();
  if (pf.includes('bank') || pf.includes('cheque'))  return { cash: 0, bank: amt, momo: 0 };
  if (pf.includes('mobile') || pf.includes('momo'))  return { cash: 0, bank: 0,   momo: amt };
  return { cash: amt, bank: 0, momo: 0 }; // matches 'Main cashier', 'Cash', 'Drawer', empty, etc.
}

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, paid_from, cashier_id } = req.query;
    let q = 'SELECT * FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?';
    const params = [req.user.tenantId];
    if (date)      { params.push(date);      q += ' AND date = ?'; }
    if (paid_from) { params.push(paid_from); q += ' AND paid_from = ?'; }
    if (cashier_id !== undefined) { params.push(parseInt(cashier_id)); q += ' AND cashier_id = ?'; }
    q += ' ORDER BY date DESC';
    const rows = db.prepare(q).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const today = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ? AND date = DATE('now')").get(tenantId);
    const month = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ? AND date >= date('now', 'start of month')").get(tenantId);
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const avg = db.prepare('SELECT COALESCE(AVG(amount),0) AS avg FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    res.json({
      todayPayments: parseFloat(today.total),
      thisMonth: parseFloat(month.total),
      totalVouchers: count.cnt,
      avgPayment: Math.round(parseFloat(avg.avg))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { paid_to, description, category, amount, date, paid_from, cashier_id, invoice_attachment,
            cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount } = req.body;
    const voucherNum = syncConfig.generateNumber('PV', 'payment_vouchers');
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const cashierId = cashier_id !== undefined ? parseInt(cashier_id) : 0;
    const resolvedPaidFrom = paid_from || 'Main cashier';
    // v1.8.5 — triple-currency. Each in its own currency. Legacy
    // cash/bank/momo still accepted but zeroed when usd/fra/k are sent.
    const usdAmt = parseFloat(usd_amount ?? cash_amount ?? 0) || 0;
    const fraAmt = parseFloat(fra_amount ?? bank_amount ?? 0) || 0;
    const kAmt   = parseFloat(k_amount   ?? momo_amount ?? 0) || 0;
    const sumSplits = usdAmt + fraAmt + kAmt;
    // For the legacy total `amount` column we use whatever the caller sent
    // (the USD-equivalent header), falling back to USD-only if missing.
    const totalAmount = parseFloat(amount) > 0 ? parseFloat(amount) : (sumSplits > 0 ? usdAmt : 0);
    const info = db.prepare(
      `INSERT INTO payment_vouchers (voucher_number, paid_to, description, category, amount,
                                     cash_amount, bank_amount, momo_amount,
                                     usd_amount, fra_amount, k_amount,
                                     date, paid_from, cashier_id, invoice_attachment, created_by,
                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?, 0,0,0, ?,?,?, ?,?,?,?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))`
    ).run(voucherNum, paid_to, description, category, totalAmount,
          usdAmt, fraAmt, kAmt,
          date || new Date().toISOString().split('T')[0],
          resolvedPaidFrom,
          cashierId,
          invoice_attachment || null,
          req.user.id,
          randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(info.lastInsertRowid);
    recalculateDailyProfit(db, row.date, req.user.tenantId);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { paid_to, description, category, amount, date, paid_from, invoice_attachment,
            cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount } = req.body;
    const pvDate = date || new Date().toISOString().split('T')[0];
    const resolvedPaidFrom = paid_from || 'Main cashier';
    // v1.8.5 — triple-currency. Same merge as POST.
    const usdAmt = parseFloat(usd_amount ?? cash_amount ?? 0) || 0;
    const fraAmt = parseFloat(fra_amount ?? bank_amount ?? 0) || 0;
    const kAmt   = parseFloat(k_amount   ?? momo_amount ?? 0) || 0;
    const sumSplits = usdAmt + fraAmt + kAmt;
    const totalAmount = parseFloat(amount) > 0 ? parseFloat(amount) : (sumSplits > 0 ? usdAmt : 0);
    // invoice_attachment: pass null to clear, omit to keep existing
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE payment_vouchers
            SET paid_to=?, description=?, category=?, amount=?,
                cash_amount=0, bank_amount=0, momo_amount=0,
                usd_amount=?, fra_amount=?, k_amount=?,
                date=?, paid_from=?, updated_at=datetime('now'), synced=0
          WHERE id=?`
      : `UPDATE payment_vouchers
            SET paid_to=?, description=?, category=?, amount=?,
                cash_amount=0, bank_amount=0, momo_amount=0,
                usd_amount=?, fra_amount=?, k_amount=?,
                date=?, paid_from=?, invoice_attachment=?, updated_at=datetime('now'), synced=0
          WHERE id=?`;
    const args = keepAttachment
      ? [paid_to, description, category, totalAmount,
         usdAmt, fraAmt, kAmt,
         pvDate, resolvedPaidFrom, req.params.id]
      : [paid_to, description, category, totalAmount,
         usdAmt, fraAmt, kAmt,
         pvDate, resolvedPaidFrom, invoice_attachment || null, req.params.id];
    const info = db.prepare(sql).run(...args);
    if (info.changes === 0) return res.status(404).json({ error: 'Voucher not found' });
    const row = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(req.params.id);
    recalculateDailyProfit(db, pvDate, req.user.tenantId);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const pv = db.prepare('SELECT date FROM payment_vouchers WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    const info = db.prepare("UPDATE payment_vouchers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=? AND deleted_at IS NULL").run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Voucher not found' });
    if (pv) recalculateDailyProfit(db, pv.date, req.user.tenantId);
    res.json({ message: 'Payment voucher deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
