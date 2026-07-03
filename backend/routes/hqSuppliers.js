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
const { randomUUID } = require('crypto');
const { masterDb, listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

// v1.10.71 — Mirror HQ supplier payments into the HQ tenant DB so they
// show up in the Cash Book (which reads from tenant DB, not master).
// HQ's tenant slug is 'hq' by convention; falls back to a bare-host slug
// if the deploy renamed it. Same helper cashDeposits.js uses.
function getHqSlug() {
  try {
    const t = listTenants().find(t => t.slug === 'hq');
    if (t) return 'hq';
    const bare = listTenants().find(t => /^(sosna|sosnazm|hq)$/i.test(t.slug));
    return bare ? bare.slug : 'hq';
  } catch (_) { return 'hq'; }
}

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
  // v1.10.72 — count HSP-prefixed payments in hq.db.ap_payments (single
  // source of truth). Falls back to master.hq_supplier_payments count
  // when the tenant DB isn't available yet — keeps numbering monotonic
  // across the migration window.
  let seq = 0;
  try {
    const hqDb = getTenantDb(getHqSlug());
    if (hqDb) {
      seq = hqDb.prepare(`SELECT COUNT(*) AS n FROM ap_payments WHERE payment_number LIKE 'HSP-%'`).get()?.n || 0;
    }
  } catch (_) { /* fall through */ }
  if (seq === 0) {
    // Migration fallback — respect the old counter so we don't collide.
    seq = masterDb.prepare(`SELECT COUNT(*) AS n FROM hq_supplier_payments`).get()?.n || 0;
  }
  const yr = new Date().getFullYear();
  return `HSP-${yr}-${String(seq + 1).padStart(5, '0')}`;
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
// v1.10.75 — everything (purchases + payments + CNs) now reads from
// HQ tenant DB. Master.hq_* tables kept as a frozen audit trail; no
// code path reads them here anymore. Aligns with the memoised
// architecture: Suppliers/AP is HQ-only, HQ IS a tenant.
function getBalances(supplierId, supplierName) {
  const hqDb = getTenantDb(getHqSlug());
  if (!hqDb) {
    return { purchase_count: 0, purchases_total: 0, payment_count: 0, payments_total: 0,
             credit_count: 0, credits_total: 0, balance: 0 };
  }
  const purchases = hqDb.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS s, COUNT(*) AS c
      FROM grn
     WHERE deleted_at IS NULL
       AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
  `).get(supplierId, supplierName);
  const payments = hqDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c
      FROM ap_payments
     WHERE deleted_at IS NULL
       AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
  `).get(supplierId, supplierName);
  // Standalone credit notes NOT netted into a GRN — grn_sync_id IS NULL.
  // GRN-attached CNs are already inside grn.total_amount (which was
  // populated with hq_grns.final_payable = items_subtotal − cn_total).
  // Tenant supplier_credit_notes has no supplier_name column — filter
  // by supplier_id only. Migration script always populates supplier_id.
  const credits = hqDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c
      FROM supplier_credit_notes
     WHERE deleted_at IS NULL
       AND grn_sync_id IS NULL
       AND supplier_id = ?
  `).get(supplierId);
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

// v1.10.75 — helpers for the CRUD/list/detail routes. Every read AND write
// now targets HQ's tenant DB (hq.db) so Account Payables and HQ Suppliers
// share one source of truth.
function requireHqDb(res) {
  const hqDb = getTenantDb(getHqSlug());
  if (!hqDb) {
    res.status(500).json({ error: 'HQ tenant DB not accessible.' });
    return null;
  }
  return hqDb;
}

// GET /api/hq/suppliers — list with AP balance per row.
router.get('/', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const suppliers = hqDb.prepare(`
      SELECT * FROM suppliers WHERE COALESCE(status, 'Active') != 'Deleted' AND deleted_at IS NULL
       ORDER BY name COLLATE NOCASE ASC
    `).all();
    const enriched = suppliers.map(s => ({ ...s, ...getBalances(s.id, s.name) }));
    res.json({ suppliers: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/suppliers/:id — detail with purchases + payments + credits history.
router.get('/:id', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const balances = getBalances(s.id, s.name);
    // Purchases list from hq.db.grn (migrated from master.hq_grns). Column
    // aliasing preserves the frontend response shape verbatim.
    const purchases = hqDb.prepare(`
      SELECT id, grn_number AS purchase_number, date,
             total_amount,
             COALESCE(status, 'Completed') AS status,
             supplier_invoice_number AS invoice_number,
             (SELECT first_name || ' ' || last_name FROM users u WHERE u.id = grn.created_by) AS created_by_name,
             linked_purchase_number AS po_number
        FROM grn
       WHERE deleted_at IS NULL
         AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id, s.name);
    // Payments list — same shape as the frontend expects (v1.10.72
    // aliasing kept: date → payment_date, paid_from → payment_method).
    const payments = hqDb.prepare(`
      SELECT id,
             payment_number,
             amount,
             date AS payment_date,
             paid_from AS payment_method,
             NULL AS reference,
             description AS notes,
             (SELECT first_name || ' ' || last_name FROM users u WHERE u.id = ap_payments.created_by) AS created_by_name
        FROM ap_payments
       WHERE deleted_at IS NULL
         AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id, s.name);
    const credits = hqDb.prepare(`
      SELECT id, credit_note_number, date, amount, reason, reference, notes,
             (SELECT first_name || ' ' || last_name FROM users u WHERE u.id = supplier_credit_notes.created_by) AS created_by_name,
             grn_sync_id
        FROM supplier_credit_notes
       WHERE deleted_at IS NULL
         AND supplier_id = ?
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id);
    res.json({ supplier: { ...s, ...balances }, purchases, payments, credits });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/suppliers — create.
router.post('/', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const { name, phone, email, address, contact_person, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const dup = hqDb.prepare(
      `SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND COALESCE(status,'Active') != 'Deleted' AND deleted_at IS NULL`
    ).get(name.trim());
    if (dup) return res.status(400).json({ error: 'A supplier with this name already exists' });
    const info = hqDb.prepare(`
      INSERT INTO suppliers (name, phone, email, address, contact_person, status,
                              sync_id, tenant_id, branch_id, device_id, synced,
                              created_at, updated_at)
      VALUES (?,?,?,?,?, 'Active', ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(name.trim(), phone || null, email || null, address || null, contact_person || null,
           randomUUID(), null, null, null);
    const row = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ ...row, ...getBalances(row.id, row.name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/suppliers/:id — edit.
router.put('/:id', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const { name, phone, email, address, contact_person, notes, status } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (name.trim().toLowerCase() !== s.name.toLowerCase()) {
      const dup = hqDb.prepare(
        `SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND id != ? AND COALESCE(status,'Active') != 'Deleted' AND deleted_at IS NULL`
      ).get(name.trim(), req.params.id);
      if (dup) return res.status(400).json({ error: 'Another supplier already uses this name' });
    }
    hqDb.prepare(`
      UPDATE suppliers
         SET name = ?, phone = ?, email = ?, address = ?, contact_person = ?,
             status = ?, updated_at = datetime('now'), synced = 0
       WHERE id = ?
    `).run(name.trim(), phone || null, email || null, address || null, contact_person || null,
           (status === 'Inactive' ? 'Inactive' : 'Active'), req.params.id);
    const row = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    res.json({ ...row, ...getBalances(row.id, row.name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/suppliers/:id — soft delete (kept for AP history).
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const bal = getBalances(s.id, s.name);
    if (bal.purchase_count > 0 || bal.payment_count > 0) {
      hqDb.prepare(`UPDATE suppliers SET status = 'Deleted', deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?`).run(req.params.id);
    } else {
      hqDb.prepare(`DELETE FROM suppliers WHERE id = ?`).run(req.params.id);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/suppliers/:id/payments — record a payment to this supplier.
router.post('/:id/payments', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT id, name, sync_id FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const { amount, payment_date, payment_method, reference, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });
    if (!payment_date) return res.status(400).json({ error: 'payment_date is required' });
    const method = ['Cash', 'Bank', 'Mobile Money'].includes(payment_method) ? payment_method : 'Cash';
    const createdBy = req.user.id || null;
    const paymentNum = nextPaymentNumber();
    const cashAmt = method === 'Cash'         ? amt : 0;
    const bankAmt = method === 'Bank'         ? amt : 0;
    const momoAmt = method === 'Mobile Money' ? amt : 0;
    const description = notes
      ? notes
      : (reference ? `${s.name} · ${reference}` : s.name);
    hqDb.prepare(`
      INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name,
                                amount, cash_amount, bank_amount, momo_amount,
                                description, date, paid_from, created_by,
                                sync_id, tenant_id, branch_id, device_id,
                                synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(
      paymentNum, s.id, s.sync_id, s.name,
      amt, cashAmt, bankAmt, momoAmt,
      description, payment_date, method, createdBy,
      randomUUID(), null, null, null
    );
    res.status(201).json({ success: true, balance: getBalances(s.id, s.name).balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/supplier-payments/:id — reverse a payment.
// v1.10.72 — payments live in HQ tenant DB now. Soft-delete via
// deleted_at so Cash Book's WHERE deleted_at IS NULL drops the row
// while keeping the audit trail.
router.delete('/payments/:id', hqAuth, (req, res) => {
  try {
    const hqDb = getTenantDb(getHqSlug());
    if (!hqDb) return res.status(500).json({ error: 'HQ tenant DB not accessible.' });
    const p = hqDb.prepare(`SELECT * FROM ap_payments WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    hqDb.prepare(`
      UPDATE ap_payments
         SET deleted_at = datetime('now'),
             updated_at = datetime('now'),
             synced     = 0
       WHERE id = ?
    `).run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
