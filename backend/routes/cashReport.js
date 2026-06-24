const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');

// Get all cash reports
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { cashier_id } = req.query;
    let query = `SELECT cr.*, u.first_name || ' ' || u.last_name AS created_by_name,
       CASE WHEN cr.cashier_id = 0 THEN 'All' ELSE cu.first_name || ' ' || cu.last_name END AS cashier_name
       FROM cash_reports cr
       LEFT JOIN users u ON cr.created_by = u.id
       LEFT JOIN users cu ON cr.cashier_id = cu.id
       WHERE cr.deleted_at IS NULL AND cr.tenant_id = ?`;
    const params = [req.user.tenantId];
    if (cashier_id !== undefined && cashier_id !== 'all') {
      query += ' AND cr.cashier_id = ?';
      params.push(parseInt(cashier_id));
    }
    query += ' ORDER BY cr.date DESC';
    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get distinct cashiers that have submitted cash reports (for filter dropdown)
router.get('/users', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT cr.cashier_id,
        CASE WHEN cr.cashier_id = 0 THEN 'All' ELSE u.first_name || ' ' || u.last_name END AS full_name
       FROM cash_reports cr
       LEFT JOIN users u ON cr.cashier_id = u.id
       WHERE cr.deleted_at IS NULL AND cr.tenant_id = ?
       ORDER BY cr.cashier_id`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get distinct users who made sales (optionally filtered by date)
router.get('/sales-cashiers', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, from, to } = req.query;
    let query = `SELECT DISTINCT o.created_by AS id, u.first_name, u.last_name
       FROM orders o
       JOIN users u ON o.created_by = u.id
       WHERE o.deleted_at IS NULL AND o.tenant_id = ?
         AND (o.status IS NULL OR o.status != 'Reversed')`;
    const params = [req.user.tenantId];
    if (date) { query += ' AND DATE(o.created_at) = ?';  params.push(date); }
    if (from) { query += ' AND DATE(o.created_at) >= ?'; params.push(from); }
    if (to)   { query += ' AND DATE(o.created_at) <= ?'; params.push(to); }
    query += ' ORDER BY u.first_name';
    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get report for a specific date (auto-populate from sales data)
// cashier_id=0 or missing = all cashiers combined; cashier_id=N = filter by that user
// from_utc / to_utc: optional SQLite-format UTC datetime range corresponding to the
// LOCAL day. Sent by the frontend so orders.created_at (UTC) gets bucketed to the
// cashier's local day, not the UTC day. Falls back to DATE() match if absent.
router.get('/daily', auth, readOnlyGuard, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cashierId = req.query.cashier_id ? parseInt(req.query.cashier_id) : 0;
    const tenantId = req.user.tenantId;
    const fromUtc = req.query.from_utc;
    const toUtc   = req.query.to_utc;

    // Build the order-date predicate + parameter list
    const useRange = !!(fromUtc && toUtc);
    const orderDateClause = useRange
      ? 'created_at >= ? AND created_at <= ?'
      : 'DATE(created_at) = ?';
    const orderDateParams = useRange ? [fromUtc, toUtc] : [date];

    const userFilter = cashierId > 0 ? ' AND created_by = ?' : '';
    const baseParams = cashierId > 0 ? [...orderDateParams, tenantId, cashierId] : [...orderDateParams, tenantId];

    // v1.8.1 — Sosna is cash-only across 3 currencies (USD / FRA / K).
    // Each bucket is NET of change given out in that same currency.
    //   USD = cash_received - change_amount (USD change)
    //   FRA = fra_received  - fra_change_given
    //   K   = k_received    - k_change_given
    // No more cash/momo/bank split — those columns are legacy and kept at 0.
    const sumOrders = (col) => db.prepare(
      `SELECT COALESCE(SUM(${col}), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).get(...baseParams).total;
    const usdNet = parseFloat(sumOrders('cash_received')) - parseFloat(sumOrders('change_amount'));
    const fraNet = parseFloat(sumOrders('fra_received'))  - parseFloat(sumOrders('fra_change_given'));
    const kNet   = parseFloat(sumOrders('k_received'))    - parseFloat(sumOrders('k_change_given'));

    // CREDIT SALES ISSUED bucket = today's new receivables (unpaid portion of today's sales).
    // This is informational — represents money owed, NOT cash received.
    const creditSales = db.prepare(
      `SELECT COALESCE(SUM(total_amount - amount_received), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')
       AND total_amount > amount_received${userFilter}`
    ).get(...baseParams);

    // PENDING bucket retained for "other" / unrecognised payment methods.
    const pendingSales = db.prepare(
      `SELECT COALESCE(SUM(amount_received), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')
       AND payment_method NOT IN ('Cash', 'Transfer', 'Mobile Money', 'Credit', 'Partial-Credit')${userFilter}`
    ).get(...baseParams);

    const expensesParams = [tenantId, date, cashierId];
    const expenses = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_vouchers
       WHERE deleted_at IS NULL AND tenant_id = ? AND date = ? AND paid_from = 'Cash Drawer' AND cashier_id = ?`
    ).get(...expensesParams);
    // v1.8.14 — per-currency expenses. A PV recorded in FRA reduces FRA
    // drawer (not USD). usd_amount / fra_amount / k_amount come from
    // payment_vouchers (v1.8.5 schema); legacy cash_amount fall back into
    // the USD bucket for older rows. The single `expenses` total above
    // is kept for back-compat with anything that still reads it.
    const expensesByCcy = db.prepare(
      `SELECT
         COALESCE(SUM(usd_amount), 0) + COALESCE(SUM(cash_amount), 0) AS usd,
         COALESCE(SUM(fra_amount), 0) AS fra,
         COALESCE(SUM(k_amount),   0) AS k
       FROM payment_vouchers
       WHERE deleted_at IS NULL AND tenant_id = ? AND date = ? AND paid_from = 'Cash Drawer' AND cashier_id = ?`
    ).get(...expensesParams);

    const totalRevenue = db.prepare(
      `SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders
       WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).get(...baseParams);

    res.json({
      date,
      // v1.8.1 — triple-currency. Each is NET (received minus change) in
      // that currency's own units. UI shows them as three separate rows.
      usd_received: usdNet,
      fra_received: fraNet,
      k_received:   kNet,
      // v1.8.14 — per-currency expenses paid from cash drawer.
      usd_expenses: parseFloat(expensesByCcy.usd) || 0,
      fra_expenses: parseFloat(expensesByCcy.fra) || 0,
      k_expenses:   parseFloat(expensesByCcy.k)   || 0,
      pending: parseFloat(pendingSales.total),
      credit_sales: parseFloat(creditSales.total),
      expenses: parseFloat(expenses.total),
      total_revenue: parseFloat(totalRevenue.total),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create / save cash report
router.post('/', auth, (req, res) => {
  try {
    // v1.8.1 — accept triple-currency fields. Legacy cash/mobile_money/bank
    // still accepted for backwards compatibility (ignored if usd/fra/k sent).
    // v1.8.13 — also accept per-currency Expected snapshots.
    const { date, initial_change, expenses, pending, total,
            after_change, expected, difference, status, comment, cashier_id,
            usd_received, fra_received, k_received,
            usd_expected, fra_expected, k_expected,
            mobile_money, cash, bank } = req.body;
    const usdAmt = parseFloat(usd_received ?? cash ?? 0);
    const fraAmt = parseFloat(fra_received ?? mobile_money ?? 0);
    const kAmt   = parseFloat(k_received   ?? bank ?? 0);
    const usdExp = parseFloat(usd_expected ?? 0) || 0;
    const fraExp = parseFloat(fra_expected ?? 0) || 0;
    const kExp   = parseFloat(k_expected   ?? 0) || 0;

    const cashierId = cashier_id !== undefined ? parseInt(cashier_id) : 0; // 0 = All
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    const existing = db.prepare(
      'SELECT id FROM cash_reports WHERE date = ? AND cashier_id = ? AND deleted_at IS NULL'
    ).get(date, cashierId);
    let row;

    if (existing) {
      db.prepare(
        `UPDATE cash_reports SET
          initial_change=?, usd_received=?, fra_received=?, k_received=?,
          usd_expected=?, fra_expected=?, k_expected=?,
          mobile_money=0, cash=0, bank=0,
          expenses=?, pending=?, total=?,
          after_change=?, expected=?, difference=?, status=?, comment=?,
          cashier_id=?, updated_at=datetime('now'), synced=0
         WHERE date=? AND cashier_id=? AND deleted_at IS NULL`
      ).run(initial_change, usdAmt, fraAmt, kAmt,
             usdExp, fraExp, kExp,
             expenses, pending, total,
             after_change, expected, difference, status, comment,
             cashierId, date, cashierId);
      row = db.prepare('SELECT * FROM cash_reports WHERE date = ? AND cashier_id = ?').get(date, cashierId);
    } else {
      const info = db.prepare(
        `INSERT INTO cash_reports (date, initial_change,
          usd_received, fra_received, k_received,
          usd_expected, fra_expected, k_expected,
          mobile_money, cash, bank,
          expenses, pending, total,
          after_change, expected, difference, status, comment, cashier_id, created_by,
          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?, ?,?,?, ?,?,?, 0,0,0, ?,?,?,?,?,?,?,?,?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))`
      ).run(date, initial_change,
             usdAmt, fraAmt, kAmt,
             usdExp, fraExp, kExp,
             expenses, pending, total,
             after_change, expected, difference, status, comment,
             cashierId, req.user.id,
             randomUUID(), tenantId, branchId, deviceId);
      row = db.prepare('SELECT * FROM cash_reports WHERE id = ?').get(info.lastInsertRowid);
    }

    recalculateDailyProfit(db, date, req.user.tenantId);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
