const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');

// Supplier ledger — derived from GRN (owed) and AP Payments (paid).
// Optional from/to params restrict the GRN + payment activity to a date range so
// the page shows a period view (totals = period activity, not all-time).
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    const grnDateClause = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const apDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const cnDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const grnParams = [...(from ? [from] : []), ...(to ? [to] : [])];
    const apParams  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const cnParams  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const rows = db.prepare(`
      SELECT
        s.id,
        s.sync_id,
        s.name AS supplier_name,
        s.phone,
        COALESCE(grn_totals.total_amount, 0) AS total_purchases,
        COALESCE(grn_totals.grn_count, 0)    AS grn_count,
        grn_totals.last_grn_date,
        COALESCE(ap_totals.total_paid, 0)    AS total_paid,
        COALESCE(ap_totals.ap_count, 0)      AS pv_count,
        COALESCE(cn_totals.total_credits, 0) AS total_credits,
        COALESCE(cn_totals.cn_count, 0)      AS credit_count,
        COALESCE(grn_totals.total_amount, 0)
          - COALESCE(ap_totals.total_paid, 0)
          - COALESCE(cn_totals.total_credits, 0) AS balance,
        CASE
          WHEN COALESCE(grn_totals.total_amount, 0) = 0                                                           THEN 'No Purchases'
          WHEN COALESCE(grn_totals.total_amount, 0) - COALESCE(ap_totals.total_paid, 0) - COALESCE(cn_totals.total_credits, 0) <= 0 THEN 'Paid'
          WHEN COALESCE(ap_totals.total_paid, 0) > 0 OR COALESCE(cn_totals.total_credits, 0) > 0                  THEN 'Partial'
          ELSE 'Unpaid'
        END AS status
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_sync_id,
          SUM(total_amount) AS total_amount,
          COUNT(*) AS grn_count,
          MAX(date) AS last_grn_date
        FROM grn
        WHERE deleted_at IS NULL${grnDateClause}
        GROUP BY supplier_sync_id
      ) grn_totals ON s.sync_id = grn_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id,
          SUM(amount) AS total_paid,
          COUNT(*) AS ap_count
        FROM ap_payments
        WHERE deleted_at IS NULL${apDateClause}
        GROUP BY supplier_sync_id
      ) ap_totals ON s.sync_id = ap_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id,
          SUM(amount) AS total_credits,
          COUNT(*) AS cn_count
        FROM supplier_credit_notes
        WHERE deleted_at IS NULL${cnDateClause}
        GROUP BY supplier_sync_id
      ) cn_totals ON s.sync_id = cn_totals.supplier_sync_id
      WHERE s.status = 'Active' AND s.deleted_at IS NULL AND s.tenant_id = ?
      ORDER BY balance DESC
    `).all(...grnParams, ...apParams, ...cnParams, req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats derived from supplier ledger. from/to filter GRN/payment activity to a period.
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = req.query;
    const grnDateClause = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const apDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const cnDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const grnParams = [...(from ? [from] : []), ...(to ? [to] : [])];
    const apParams  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const cnParams  = [...(from ? [from] : []), ...(to ? [to] : [])];

    const row = db.prepare(`
      SELECT
        COALESCE(SUM(grn_totals.total_amount), 0)  AS total_purchases,
        COALESCE(SUM(ap_totals.total_paid), 0)     AS total_paid,
        COALESCE(SUM(cn_totals.total_credits), 0)  AS total_credits,
        COALESCE(SUM(grn_totals.total_amount), 0)
          - COALESCE(SUM(ap_totals.total_paid), 0)
          - COALESCE(SUM(cn_totals.total_credits), 0) AS outstanding
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(total_amount) AS total_amount
        FROM grn WHERE deleted_at IS NULL${grnDateClause} GROUP BY supplier_sync_id
      ) grn_totals ON s.sync_id = grn_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_paid
        FROM ap_payments WHERE deleted_at IS NULL${apDateClause}
        GROUP BY supplier_sync_id
      ) ap_totals ON s.sync_id = ap_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_credits
        FROM supplier_credit_notes WHERE deleted_at IS NULL${cnDateClause}
        GROUP BY supplier_sync_id
      ) cn_totals ON s.sync_id = cn_totals.supplier_sync_id
      WHERE s.status = 'Active' AND s.deleted_at IS NULL AND s.tenant_id = ?
    `).get(...grnParams, ...apParams, ...cnParams, tenantId);

    const supplierCount = db.prepare("SELECT COUNT(*) AS cnt FROM suppliers WHERE status = 'Active' AND deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const unpaid = db.prepare(`
      SELECT COUNT(*) AS cnt FROM suppliers s
      INNER JOIN (
        SELECT supplier_sync_id, SUM(total_amount) AS total_amount
        FROM grn WHERE deleted_at IS NULL${grnDateClause} GROUP BY supplier_sync_id
      ) grn_totals ON s.sync_id = grn_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_paid
        FROM ap_payments WHERE deleted_at IS NULL${apDateClause}
        GROUP BY supplier_sync_id
      ) ap_totals ON s.sync_id = ap_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_credits
        FROM supplier_credit_notes WHERE deleted_at IS NULL${cnDateClause}
        GROUP BY supplier_sync_id
      ) cn_totals ON s.sync_id = cn_totals.supplier_sync_id
      WHERE s.status = 'Active' AND s.deleted_at IS NULL AND s.tenant_id = ?
        AND grn_totals.total_amount - COALESCE(ap_totals.total_paid, 0) - COALESCE(cn_totals.total_credits, 0) > 0
    `).get(...grnParams, ...apParams, ...cnParams, tenantId);

    res.json({
      totalPurchases: parseFloat(row.total_purchases),
      totalPaid: parseFloat(row.total_paid),
      totalCredits: parseFloat(row.total_credits),
      outstanding: parseFloat(row.outstanding),
      suppliers: supplierCount.cnt,
      unpaidCount: unpaid.cnt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Supplier breakdown — GRNs + AP payments
router.get('/breakdown/:supplierId', auth, readOnlyGuard, (req, res) => {
  try {
    const supplierId = parseInt(req.params.supplierId);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?').get(supplierId, req.user.tenantId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const grns = db.prepare(`
      SELECT id, grn_number, date, total_amount, notes
      FROM grn WHERE supplier_sync_id = ? AND deleted_at IS NULL AND tenant_id = ? ORDER BY date ASC
    `).all(supplier.sync_id, req.user.tenantId);

    const payments = db.prepare(`
      SELECT id, payment_number, date, amount, description, paid_from
      FROM ap_payments WHERE supplier_id = ? AND deleted_at IS NULL AND tenant_id = ? ORDER BY date ASC
    `).all(supplierId, req.user.tenantId);

    // Credit notes — supplier discounts + crate/bottle returns. Reduce AP
    // balance the same way payments do. Returned as a third section so the
    // modal can show them alongside Purchases and Payments Made.
    const credits = db.prepare(`
      SELECT id, credit_note_number, date, amount, reason, reference, notes
      FROM supplier_credit_notes
      WHERE supplier_sync_id = ? AND deleted_at IS NULL AND tenant_id = ?
      ORDER BY date ASC
    `).all(supplier.sync_id, req.user.tenantId);

    res.json({ supplier, grns, payments, credits });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
