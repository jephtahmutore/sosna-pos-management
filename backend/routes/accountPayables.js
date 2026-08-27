const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
// v1.10.316 — masterDb has hq_grns.supplier_invoice_number populated at
// HQ Generate GRN time. The branch mirror (backend/sosna.db.grn) doesn't
// carry that field so /breakdown had to reach into master to surface it.
let masterDb;
try { masterDb = require('../config/masterDb').masterDb; } catch (_) { masterDb = null; }

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
        -- v1.10.79 — currency of the supplier's most-used cost_currency.
        -- NULL rows count as 'K' (default from the v1.10.79 backfill).
        COALESCE(grn_totals.currency, 'K')   AS currency,
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
          MAX(date) AS last_grn_date,
          -- v1.10.79 — majority currency across the supplier's GRNs.
          -- NULL / empty rows normalise to 'K'.
          (SELECT COALESCE(NULLIF(UPPER(g2.cost_currency), ''), 'K')
             FROM grn g2
            WHERE g2.supplier_sync_id = grn.supplier_sync_id
              AND g2.deleted_at IS NULL
            GROUP BY COALESCE(NULLIF(UPPER(g2.cost_currency), ''), 'K')
            ORDER BY COUNT(*) DESC LIMIT 1) AS currency
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

    // v1.10.315 — also return invoice_number + supplier_invoice_number
    // when the columns exist so the AP statement Reference column can
    // display "INV#…" for each GRN. Wrapped in try so older tenants
    // without the columns don't 500.
    let grns;
    try {
      grns = db.prepare(`
        SELECT id, grn_number, sync_id, date, total_amount, notes,
               invoice_number, supplier_invoice_number
        FROM grn WHERE supplier_sync_id = ? AND deleted_at IS NULL AND tenant_id = ? ORDER BY date ASC
      `).all(supplier.sync_id, req.user.tenantId);
    } catch (_) {
      grns = db.prepare(`
        SELECT id, grn_number, sync_id, date, total_amount, notes
        FROM grn WHERE supplier_sync_id = ? AND deleted_at IS NULL AND tenant_id = ? ORDER BY date ASC
      `).all(supplier.sync_id, req.user.tenantId);
    }
    // v1.10.316 — Sosna's HQ-generated GRNs write supplier_invoice_number
    // to master.hq_grns but NOT to the branch mirror (backend/sosna.db.grn),
    // so the branch-side select above returns nothing for that field.
    // Look each GRN up in masterDb by sync_id and merge the invoice
    // number in when present. Silent-skip if masterDb isn't wired
    // (Electron / older deploy).
    if (masterDb && grns.length > 0) {
      try {
        const syncIds = grns.map(g => g.sync_id).filter(Boolean);
        if (syncIds.length > 0) {
          const placeholders = syncIds.map(() => '?').join(',');
          const rows = masterDb.prepare(
            `SELECT sync_id, supplier_invoice_number FROM hq_grns WHERE sync_id IN (${placeholders})`
          ).all(...syncIds);
          const bySync = Object.fromEntries(rows.map(r => [r.sync_id, r.supplier_invoice_number]));
          for (const g of grns) {
            if (!g.supplier_invoice_number && bySync[g.sync_id]) g.supplier_invoice_number = bySync[g.sync_id];
          }
        }
      } catch (_) { /* master lookup optional */ }
    }

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
