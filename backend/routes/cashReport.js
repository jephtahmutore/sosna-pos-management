const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
// v1.8.67 — HQ Deposit math removed from Cash Report (per user: in real
// operations the cashier hands cash to the manager, who later sends to
// HQ — so the deposit never affects the till count). The deposit still
// flows through Cash Book (where it belongs at the accounting level).

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
    //   USD = cash_received - usd_change_given (v1.8.68: was change_amount,
    //         which mixed currencies and made FRA-overpaid orders show a
    //         phantom USD surplus. usd_change_given holds ONLY physical USD
    //         the cashier handed back.)
    //   FRA = fra_received  - fra_change_given
    //   K   = k_received    - k_change_given
    // No more cash/momo/bank split — those columns are legacy and kept at 0.
    const sumOrders = (col) => db.prepare(
      `SELECT COALESCE(SUM(${col}), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).get(...baseParams).total;
    // v1.8.67 — Pure POS net. Deposits don't touch the till in Sosna's
    // operational model (cashier → manager → HQ).
    const usdNet = parseFloat(sumOrders('cash_received')) - parseFloat(sumOrders('usd_change_given'));
    const fraNet = parseFloat(sumOrders('fra_received'))  - parseFloat(sumOrders('fra_change_given'));
    const kNet   = parseFloat(sumOrders('k_received'))    - parseFloat(sumOrders('k_change_given'));

    // v1.8.68 — over-collections breakdown. When customer overpays and cashier
    // keeps the surplus, the over-payment lives in the drawer of the currency
    // it was paid in. Reported here so it's visible without polluting any
    // drawer's Diff line.
    const overpaidByCcy = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN overpaid_kept_ccy = 'USD' THEN overpaid_kept_amt ELSE 0 END), 0) AS usd,
         COALESCE(SUM(CASE WHEN overpaid_kept_ccy = 'FRA' THEN overpaid_kept_amt ELSE 0 END), 0) AS fra,
         COALESCE(SUM(CASE WHEN overpaid_kept_ccy = 'K'   THEN overpaid_kept_amt ELSE 0 END), 0) AS k
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).get(...baseParams);

    // v1.8.76 — under-payments (silently absorbed). Walk-in shortages within
    // the $0.10 tolerance keep payment_method='Cash' but have total > received.
    // These represent silent shop LOSS. Attributed to USD column (the shortfall
    // is always computed in USD-equivalent; we don't know which currency the
    // customer was "short in"). Excludes Credit / Partial-Credit (those are
    // tracked separately as customer receivables).
    const underpaidUSD = db.prepare(
      `SELECT COALESCE(SUM(total_amount - amount_received), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')
       AND total_amount > amount_received
       AND payment_method = 'Cash'${userFilter}`
    ).get(...baseParams).total;

    // CREDIT SALES ISSUED bucket = today's new receivables (unpaid portion of today's sales).
    // This is informational — represents money owed, NOT cash received.
    // v1.8.76 — only count rows whose payment_method is actually Credit or
    // Partial-Credit. Walk-in shortages within the $0.10 tolerance still have
    // total_amount > amount_received but payment_method='Cash' (no customer to
    // bill) — those should NOT bleed into the Credit Sales bucket.
    const creditSales = db.prepare(
      `SELECT COALESCE(SUM(total_amount - amount_received), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')
       AND total_amount > amount_received
       AND payment_method IN ('Credit', 'Partial-Credit')${userFilter}`
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
    // v1.8.14 + v1.8.17 — per-currency expenses. A PV recorded in FRA
    // reduces FRA drawer (not USD). Prefer the new usd_amount column when
    // set, else fall back to the legacy cash_amount (per row — adding the
    // two columns together double-counts the rows where both got populated
    // during the v1.8.5 transition).
    const expensesByCcy = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN COALESCE(usd_amount, 0) > 0 THEN usd_amount ELSE COALESCE(cash_amount, 0) END), 0) AS usd,
         COALESCE(SUM(CASE WHEN COALESCE(fra_amount, 0) > 0 THEN fra_amount ELSE COALESCE(bank_amount, 0) END), 0) AS fra,
         COALESCE(SUM(CASE WHEN COALESCE(k_amount,   0) > 0 THEN k_amount   ELSE COALESCE(momo_amount, 0) END), 0) AS k
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
      // v1.8.68 — over-collections kept by cashier (per source currency).
      usd_overpaid_kept: parseFloat(overpaidByCcy.usd) || 0,
      fra_overpaid_kept: parseFloat(overpaidByCcy.fra) || 0,
      k_overpaid_kept:   parseFloat(overpaidByCcy.k)   || 0,
      // v1.8.76 — under-payments silently absorbed (walk-in tolerance shortages).
      // Always USD-attributed since shortfall is computed in USD-equivalent.
      usd_underpaid:     parseFloat(underpaidUSD) || 0,
      pending: parseFloat(pendingSales.total),
      credit_sales: parseFloat(creditSales.total),
      expenses: parseFloat(expenses.total),
      total_revenue: parseFloat(totalRevenue.total),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.8.68 — per-order over-collections for the day. Returns one row per
// order where the cashier kept an over-payment in the drawer (overpaid_kept_amt > 0).
// v1.8.76 — also returns under-payment rows (walk-in shortages within tolerance).
// Each row tagged with `direction`: 'OVER' (kept by cashier) or 'UNDER' (absorbed by shop).
router.get('/overpaid', auth, readOnlyGuard, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cashierId = req.query.cashier_id ? parseInt(req.query.cashier_id) : 0;
    const fromUtc = req.query.from_utc;
    const toUtc   = req.query.to_utc;
    const useRange = !!(fromUtc && toUtc);
    const dateClause = useRange
      ? 'o.created_at >= ? AND o.created_at <= ?'
      : 'DATE(o.created_at) = ?';
    const dateParams = useRange ? [fromUtc, toUtc] : [date];
    const userFilter = cashierId > 0 ? ' AND o.created_by = ?' : '';
    const params = cashierId > 0
      ? [...dateParams, req.user.tenantId, cashierId]
      : [...dateParams, req.user.tenantId];

    // Over-payments kept in drawer
    const overRows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount,
              'OVER' AS direction,
              o.overpaid_kept_ccy AS ccy, o.overpaid_kept_amt AS amt,
              o.selling_rate_used, o.selling_rate_k_used,
              o.created_at,
              u.first_name || ' ' || u.last_name AS cashier_name
         FROM orders o
         LEFT JOIN users u ON o.created_by = u.id
        WHERE ${dateClause} AND o.deleted_at IS NULL AND o.tenant_id = ?
          AND (o.status IS NULL OR o.status != 'Reversed')
          AND COALESCE(o.overpaid_kept_amt, 0) > 0
          ${userFilter}`
    ).all(...params);

    // Under-payments silently absorbed (walk-in tolerance shortages)
    const underRows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount,
              'UNDER' AS direction,
              'USD'  AS ccy, (o.total_amount - o.amount_received) AS amt,
              o.selling_rate_used, o.selling_rate_k_used,
              o.created_at,
              u.first_name || ' ' || u.last_name AS cashier_name
         FROM orders o
         LEFT JOIN users u ON o.created_by = u.id
        WHERE ${dateClause} AND o.deleted_at IS NULL AND o.tenant_id = ?
          AND (o.status IS NULL OR o.status != 'Reversed')
          AND o.total_amount > o.amount_received
          AND o.payment_method = 'Cash'
          ${userFilter}`
    ).all(...params);

    const rows = [...overRows, ...underRows].sort((a, b) =>
      (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(rows);
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
            usd_expenses, fra_expenses, k_expenses,
            mobile_money, cash, bank } = req.body;
    const usdAmt = parseFloat(usd_received ?? cash ?? 0);
    const fraAmt = parseFloat(fra_received ?? mobile_money ?? 0);
    const kAmt   = parseFloat(k_received   ?? bank ?? 0);
    const usdExp = parseFloat(usd_expected ?? 0) || 0;
    const fraExp = parseFloat(fra_expected ?? 0) || 0;
    const kExp   = parseFloat(k_expected   ?? 0) || 0;
    // v1.8.26 — snapshot per-currency expenses paid out of each drawer.
    const usdExpense = parseFloat(usd_expenses ?? 0) || 0;
    const fraExpense = parseFloat(fra_expenses ?? 0) || 0;
    const kExpense   = parseFloat(k_expenses   ?? 0) || 0;

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
          usd_expenses=?, fra_expenses=?, k_expenses=?,
          mobile_money=0, cash=0, bank=0,
          expenses=?, pending=?, total=?,
          after_change=?, expected=?, difference=?, status=?, comment=?,
          cashier_id=?, updated_at=datetime('now'), synced=0
         WHERE date=? AND cashier_id=? AND deleted_at IS NULL`
      ).run(initial_change, usdAmt, fraAmt, kAmt,
             usdExp, fraExp, kExp,
             usdExpense, fraExpense, kExpense,
             expenses, pending, total,
             after_change, expected, difference, status, comment,
             cashierId, date, cashierId);
      row = db.prepare('SELECT * FROM cash_reports WHERE date = ? AND cashier_id = ?').get(date, cashierId);
    } else {
      const info = db.prepare(
        `INSERT INTO cash_reports (date, initial_change,
          usd_received, fra_received, k_received,
          usd_expected, fra_expected, k_expected,
          usd_expenses, fra_expenses, k_expenses,
          mobile_money, cash, bank,
          expenses, pending, total,
          after_change, expected, difference, status, comment, cashier_id, created_by,
          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?, ?,?,?, ?,?,?, ?,?,?, 0,0,0, ?,?,?,?,?,?,?,?,?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))`
      ).run(date, initial_change,
             usdAmt, fraAmt, kAmt,
             usdExp, fraExp, kExp,
             usdExpense, fraExpense, kExpense,
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
