const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// GET /api/ap-payments
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, supplier_id } = req.query;
    let sql = `SELECT ap.*, s.name AS supplier_name_resolved
               FROM ap_payments ap
               LEFT JOIN suppliers s ON s.sync_id = ap.supplier_sync_id
               WHERE ap.deleted_at IS NULL AND ap.tenant_id = ?`;
    const params = [req.user.tenantId];
    if (from) { sql += ' AND ap.date >= ?'; params.push(from); }
    if (to)   { sql += ' AND ap.date <= ?'; params.push(to); }
    // Filter by sync_id derived from requested local id so cross-device
    // records still match.
    if (supplier_id) { sql += ' AND ap.supplier_sync_id = (SELECT sync_id FROM suppliers WHERE id = ?)'; params.push(parseInt(supplier_id)); }
    sql += ' ORDER BY ap.date DESC, ap.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ap-payments — accepts split amounts (cash_amount + bank_amount + momo_amount)
// AND the new triple-currency shape (usd_amount + fra_amount + k_amount)
// used by HQ's AP Record Payment modal (v1.10.78).
// Falls back to the legacy single `amount` + `paid_from` shape for older callers.
router.post('/', auth, (req, res) => {
  try {
    const { supplier_id, supplier_name, cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount,
            amount, description, date, paid_from, invoice_attachment } = req.body;
    const cash = parseFloat(cash_amount || 0) || 0;
    const bank = parseFloat(bank_amount || 0) || 0;
    const momo = parseFloat(momo_amount || 0) || 0;
    const usd  = parseFloat(usd_amount  || 0) || 0;
    const fra  = parseFloat(fra_amount  || 0) || 0;
    const kAmt = parseFloat(k_amount    || 0) || 0;
    // v1.10.78 — total resolution priority: triple-currency sum > method sum > legacy `amount`.
    const ccySum   = usd + fra + kAmt;
    const splitSum = cash + bank + momo;
    const total    = ccySum > 0 ? ccySum : (splitSum > 0 ? splitSum : (parseFloat(amount || 0) || 0));
    if (!(total > 0)) return res.status(400).json({ error: 'Amount is required.' });

    // Derive a paid_from label for display when none provided.
    // v1.10.78 — prefer triple-currency label on HQ; fall back to method label.
    const derivedPaidFrom = paid_from || (() => {
      if (ccySum > 0) {
        const used = [usd > 0 && 'USD', fra > 0 && 'FRA', kAmt > 0 && 'K'].filter(Boolean);
        return used.length === 1 ? used[0] : 'Mixed';
      }
      const used = [cash > 0 && 'Cash', bank > 0 && 'Bank', momo > 0 && 'Mobile Money'].filter(Boolean);
      if (used.length === 0) return 'Main cashier';
      if (used.length === 1) return used[0];
      return 'Mixed';
    })();

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const paymentNum = syncConfig.generateNumber('APR', 'ap_payments');
    const supplierSyncId = req.body.supplier_sync_id
      || (supplier_id ? db.prepare('SELECT sync_id FROM suppliers WHERE id = ?').get(supplier_id)?.sync_id : null)
      || null;
    const info = db.prepare(`
      INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name,
                                amount, cash_amount, bank_amount, momo_amount,
                                usd_amount, fra_amount, k_amount,
                                description, date, paid_from, invoice_attachment, created_by,
                                sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(paymentNum, supplier_id || null, supplierSyncId, supplier_name || null,
           total, cash, bank, momo,
           usd, fra, kAmt,
           description || null, date || new Date().toISOString().split('T')[0],
           derivedPaidFrom, invoice_attachment || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM ap_payments WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ap-payments/:id — supports split amounts on edit too.
router.put('/:id', auth, (req, res) => {
  try {
    const { cash_amount, bank_amount, momo_amount, amount, date, description, paid_from, invoice_attachment } = req.body;
    const cash = parseFloat(cash_amount || 0) || 0;
    const bank = parseFloat(bank_amount || 0) || 0;
    const momo = parseFloat(momo_amount || 0) || 0;
    const splitSum = cash + bank + momo;
    const total    = splitSum > 0 ? splitSum : (parseFloat(amount || 0) || 0);
    if (!(total > 0)) return res.status(400).json({ error: 'Amount is required.' });

    const derivedPaidFrom = paid_from || (() => {
      const used = [cash > 0 && 'Cash', bank > 0 && 'Bank', momo > 0 && 'Mobile Money'].filter(Boolean);
      if (used.length === 1) return used[0];
      if (used.length > 1)   return 'Mixed';
      return null;
    })();

    // invoice_attachment: pass null to clear, omit to keep existing.
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE ap_payments SET amount=?, cash_amount=?, bank_amount=?, momo_amount=?, date=?, description=?, paid_from=?, synced=0, updated_at=datetime('now') WHERE id=? AND deleted_at IS NULL`
      : `UPDATE ap_payments SET amount=?, cash_amount=?, bank_amount=?, momo_amount=?, date=?, description=?, paid_from=?, invoice_attachment=?, synced=0, updated_at=datetime('now') WHERE id=? AND deleted_at IS NULL`;
    const args = keepAttachment
      ? [total, cash, bank, momo, date, description || null, derivedPaidFrom, req.params.id]
      : [total, cash, bank, momo, date, description || null, derivedPaidFrom, invoice_attachment || null, req.params.id];
    db.prepare(sql).run(...args);
    res.json(db.prepare('SELECT * FROM ap_payments WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ap-payments/:id
router.delete('/:id', auth, (req, res) => {
  try {
    db.prepare("UPDATE ap_payments SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Payment deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
