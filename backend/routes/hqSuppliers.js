/**
 * hqSuppliers.js — HQ-level supplier master + AP tracking.
 *
 * AP per supplier is computed live from the source tables, never stored:
 *   purchases = SUM(hq_purchases.total_amount  WHERE supplier matches)
 *   payments  = SUM(hq_supplier_payments.amount WHERE supplier matches)
 *   balance   = purchases - payments   (positive = HQ owes supplier)
 *
 * Matching is a UNION: rows linked by supplier_id (preferred) + rows whose
 * supplier_name matches the master name case-insensitively (fallback for
 * legacy purchases entered before the master existed). This means renaming
 * a supplier here AFTER you have legacy purchases will detach those — fix
 * is to also re-save the affected purchase row, which is rare.
 *
 * Auth: hqAuth (JWT only).
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { masterDb } = require('../config/masterDb');

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

function nextPaymentNumber() {
  const seq = (masterDb.prepare(`SELECT COUNT(*) AS n FROM hq_supplier_payments`).get()?.n || 0) + 1;
  const yr  = new Date().getFullYear();
  return `HSP-${yr}-${String(seq).padStart(5, '0')}`;
}

// Aggregate purchases + payments + credit_notes for one supplier.
// v1.10.52 — was reading `hq_purchases.total_amount` which committed AP
// the moment HQ typed a PO — even before the branch confirmed receipt
// and before HQ generated a GRN. It also ignored supplier credit notes.
// Now mirrors Liquor AP (routes/accountPayables.js):
//   purchases = SUM(hq_grns.final_payable)             ← goods actually received
//   payments  = SUM(hq_supplier_payments.amount)
//   credits   = SUM(hq_supplier_credit_notes.amount)   ← now included
//   balance   = purchases − payments − credits
// hq_grns.final_payable already nets the invoice against the GRN-time CNs,
// but standalone CNs recorded later against the same supplier still need
// to be deducted separately.
function getBalances(supplierId, supplierName) {
  const purchases = masterDb.prepare(`
    SELECT COALESCE(SUM(final_payable), 0) AS s, COUNT(*) AS c
      FROM hq_grns
     WHERE deleted_at IS NULL
       AND (supplier_id = ? OR (supplier_id IS NULL AND LOWER(COALESCE(supplier_name,'')) = LOWER(?)))
  `).get(supplierId, supplierName);
  const payments = masterDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c
      FROM hq_supplier_payments
     WHERE (supplier_id = ? OR (supplier_id IS NULL AND LOWER(COALESCE(supplier_name,'')) = LOWER(?)))
  `).get(supplierId, supplierName);
  // Standalone credit notes NOT already netted into an hq_grn.
  // grn_sync_id IS NULL → recorded independently. Rows attached to a
  // GRN (grn_sync_id set) are already inside hq_grns.final_payable so
  // deducting them twice would double-count.
  const credits = masterDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c
      FROM hq_supplier_credit_notes
     WHERE deleted_at IS NULL
       AND grn_sync_id IS NULL
       AND (supplier_id = ? OR (supplier_id IS NULL AND LOWER(COALESCE(supplier_name,'')) = LOWER(?)))
  `).get(supplierId, supplierName);
  return {
    purchase_count:  purchases.c,
    purchases_total: purchases.s,
    payment_count:   payments.c,
    payments_total:  payments.s,
    credit_count:    credits.c,
    credits_total:   credits.s,
    balance:         purchases.s - payments.s - credits.s,
  };
}

// GET /api/hq/suppliers — list with AP balance per row.
// Optional ?with_purchases=1 includes recent purchases sorted desc.
router.get('/', hqAuth, (req, res) => {
  try {
    const suppliers = masterDb.prepare(`
      SELECT * FROM hq_suppliers WHERE status != 'Deleted' ORDER BY name COLLATE NOCASE ASC
    `).all();
    const enriched = suppliers.map(s => ({ ...s, ...getBalances(s.id, s.name) }));
    res.json({ suppliers: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/suppliers/:id — detail with purchases + payments history.
router.get('/:id', hqAuth, (req, res) => {
  try {
    const s = masterDb.prepare(`SELECT * FROM hq_suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const balances = getBalances(s.id, s.name);
    // v1.10.52 — purchases list now comes from hq_grns (matches the AP
    // balance source above). Older PO rows without a linked GRN don't
    // show up here — they were never really owed until confirmed anyway.
    const purchases = masterDb.prepare(`
      SELECT id, grn_number AS purchase_number, date,
             final_payable AS total_amount,
             'CONFIRMED' AS status,
             supplier_invoice_number AS invoice_number,
             generated_by_hq_name AS created_by_name,
             po_number, items_subtotal, cn_total
        FROM hq_grns
       WHERE deleted_at IS NULL
         AND (supplier_id = ? OR (supplier_id IS NULL AND LOWER(COALESCE(supplier_name,'')) = LOWER(?)))
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id, s.name);
    const payments = masterDb.prepare(`
      SELECT id, payment_number, amount, payment_date, payment_method,
             reference, notes, created_by_name
        FROM hq_supplier_payments
       WHERE supplier_id = ? OR (supplier_id IS NULL AND LOWER(COALESCE(supplier_name,'')) = LOWER(?))
       ORDER BY payment_date DESC, id DESC
       LIMIT 200
    `).all(s.id, s.name);
    const credits = masterDb.prepare(`
      SELECT id, credit_note_number, date, amount, reason, reference, notes,
             created_by_name, grn_sync_id
        FROM hq_supplier_credit_notes
       WHERE deleted_at IS NULL
         AND (supplier_id = ? OR (supplier_id IS NULL AND LOWER(COALESCE(supplier_name,'')) = LOWER(?)))
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id, s.name);
    res.json({ supplier: { ...s, ...balances }, purchases, payments, credits });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/suppliers — create.
router.post('/', hqAuth, (req, res) => {
  try {
    const { name, phone, email, address, contact_person, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    // Reject duplicates (case-insensitive) so the AP fallback stays unambiguous.
    const dup = masterDb.prepare(`SELECT id FROM hq_suppliers WHERE LOWER(name) = LOWER(?) AND status != 'Deleted'`).get(name.trim());
    if (dup) return res.status(400).json({ error: 'A supplier with this name already exists' });
    const info = masterDb.prepare(`
      INSERT INTO hq_suppliers (name, phone, email, address, contact_person, notes)
      VALUES (?,?,?,?,?,?)
    `).run(name.trim(), phone || null, email || null, address || null, contact_person || null, notes || null);
    const row = masterDb.prepare(`SELECT * FROM hq_suppliers WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ ...row, ...getBalances(row.id, row.name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/suppliers/:id — edit.
router.put('/:id', hqAuth, (req, res) => {
  try {
    const s = masterDb.prepare(`SELECT * FROM hq_suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const { name, phone, email, address, contact_person, notes, status } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (name.trim().toLowerCase() !== s.name.toLowerCase()) {
      const dup = masterDb.prepare(`SELECT id FROM hq_suppliers WHERE LOWER(name) = LOWER(?) AND id != ? AND status != 'Deleted'`).get(name.trim(), req.params.id);
      if (dup) return res.status(400).json({ error: 'Another supplier already uses this name' });
    }
    masterDb.prepare(`
      UPDATE hq_suppliers
         SET name = ?, phone = ?, email = ?, address = ?, contact_person = ?, notes = ?,
             status = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(name.trim(), phone || null, email || null, address || null, contact_person || null, notes || null,
           (status === 'Inactive' ? 'Inactive' : 'Active'), req.params.id);
    const row = masterDb.prepare(`SELECT * FROM hq_suppliers WHERE id = ?`).get(req.params.id);
    res.json({ ...row, ...getBalances(row.id, row.name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/suppliers/:id — soft delete (kept for AP history).
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const s = masterDb.prepare(`SELECT * FROM hq_suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const bal = getBalances(s.id, s.name);
    if (bal.purchase_count > 0 || bal.payment_count > 0) {
      // Soft delete so historical records keep their name. Hidden from list.
      masterDb.prepare(`UPDATE hq_suppliers SET status = 'Deleted', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    } else {
      masterDb.prepare(`DELETE FROM hq_suppliers WHERE id = ?`).run(req.params.id);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/suppliers/:id/payments — record a payment to this supplier.
router.post('/:id/payments', hqAuth, (req, res) => {
  try {
    const s = masterDb.prepare(`SELECT * FROM hq_suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const { amount, payment_date, payment_method, reference, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });
    if (!payment_date) return res.status(400).json({ error: 'payment_date is required' });
    const method = ['Cash', 'Bank', 'Mobile Money'].includes(payment_method) ? payment_method : 'Cash';
    const createdBy     = req.user.id || null;
    const createdByName = req.user.firstName || req.user.email || 'HQ';
    masterDb.prepare(`
      INSERT INTO hq_supplier_payments (payment_number, supplier_id, supplier_name,
                                        amount, payment_date, payment_method,
                                        reference, notes, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      nextPaymentNumber(), s.id, s.name,
      amt, payment_date, method, reference || null, notes || null,
      createdBy, createdByName
    );
    res.status(201).json({ success: true, balance: getBalances(s.id, s.name).balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/supplier-payments/:id — reverse a payment (hard delete).
router.delete('/payments/:id', hqAuth, (req, res) => {
  try {
    const p = masterDb.prepare(`SELECT * FROM hq_supplier_payments WHERE id = ?`).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    masterDb.prepare(`DELETE FROM hq_supplier_payments WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
