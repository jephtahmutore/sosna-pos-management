const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
// v1.10.320 — HQ-generated GRNs on Sosna write to master.hq_grns; the
// branch mirror often stores the movement without a matching branch.grn
// row, so the bin-card join misses and 'grn' falls through as the raw
// movement_type. Post-process any row still showing the movement_type
// verbatim by looking up its reference_sync_id in master.hq_grns.
let masterDb;
try { masterDb = require('../config/masterDb').masterDb; } catch (_) { masterDb = null; }
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { baseQtyExpr } = require('../config/unitsHelper');

// v1.10.319 — check whether an optional table exists on the CURRENT
// tenant DB so we can conditionally splice its LEFT JOIN into the
// bin-card queries. Sosna keeps stock_transfers on master.db only, so
// the join was fatal on branch DBs (v1.10.318 shipped that regression).
// Not cached because the `db` proxy routes to the current tenant at
// call time; a cache keyed by DB path would work, but a fresh check
// per request is cheap enough (one indexed sqlite_master lookup).
function tableExists(name) {
  try {
    const r = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return !!r;
  } catch (_) {
    return false;
  }
}

// Shared balance query — accepts tenantId for filtering
const balanceSQL = (tenantId) => ({
  text: `
  SELECT
    p.id, p.sync_id, p.code, p.name, p.unit, p.alt_unit, p.conversion_factor, p.alt_price, p.units_json,
    p.default_unit,
    p.cost_price, p.selling_price, p.min_stock, p.status, p.image_url,
    p.product_type,
    p.ub_number_start, p.ub_number_length, p.ub_quantity_start, p.ub_quantity_length, p.ub_decimal_start,
    c.name AS category_name, c.color AS category_color,
    COALESCE(store_agg.store_balance, 0) AS store_balance,
    COALESCE(sales_agg.sales_balance, 0) AS sales_balance,
    COALESCE(opening_agg.opening_balance, 0) AS opening_balance,
    COALESCE(grn_agg.total_in, 0) AS total_in,
    COALESCE(prod_out_agg.total_prod_out, 0) AS total_prod_out,
    COALESCE(prod_in_agg.total_prod_in, 0) AS total_prod_in,
    COALESCE(siv_agg.total_out, 0) AS total_out
  FROM products p
  LEFT JOIN categories c ON p.category_sync_id = c.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS store_balance
    FROM stock_movements WHERE location = 'store' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) store_agg ON store_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS sales_balance
    FROM stock_movements WHERE location = 'sales' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) sales_agg ON sales_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS opening_balance
    FROM stock_movements WHERE location = 'store' AND movement_type = 'opening' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) opening_agg ON opening_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS total_in
    FROM stock_movements WHERE location = 'store' AND movement_type = 'grn' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) grn_agg ON grn_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS total_prod_out
    FROM stock_movements WHERE location = 'store' AND movement_type = 'production_output' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) prod_out_agg ON prod_out_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, ABS(SUM(quantity)) AS total_prod_in
    FROM stock_movements WHERE location = 'store' AND movement_type = 'production_input' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) prod_in_agg ON prod_in_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, ABS(SUM(quantity)) AS total_out
    FROM stock_movements WHERE location = 'store' AND movement_type = 'siv' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) siv_agg ON siv_agg.product_sync_id = p.sync_id
  WHERE p.deleted_at IS NULL AND p.tenant_id = ?
  ORDER BY p.name
`,
  params: [tenantId],
});

// GET /api/inventory
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const q = balanceSQL(req.user.tenantId);
    const rows = db.prepare(q.text).all(...q.params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/store
// Optional ?location=store|sales — defaults to 'store'. The 'sales' variant
// powers the Sales Stock Card (same shape, same fields, same units rules,
// just filtered on the sales-counter side of the stock_movements ledger).
router.get('/store', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    const tenantId = req.user.tenantId;
    const loc = req.query.location === 'sales' ? 'sales' : 'store';

    // Opening balance = all movements BEFORE `from` (if from set), else opening_type only
    const openingWhere = from
      ? `location = '${loc}' AND deleted_at IS NULL AND product_sync_id IS NOT NULL AND DATE(created_at) < '${from}'`
      : `location = '${loc}' AND movement_type = 'opening' AND deleted_at IS NULL AND product_sync_id IS NOT NULL`;

    // In/out movements within the date range
    const rangeWhere = [
      `location = '${loc}'`, `deleted_at IS NULL`, `product_sync_id IS NOT NULL`,
      ...(from ? [`DATE(created_at) >= '${from}'`] : []),
      ...(to   ? [`DATE(created_at) <= '${to}'`]   : []),
    ].join(' AND ');

    // Closing balance = all movements up to `to` (closing), or all-time if no `to`
    const balanceWhere = [
      `location = '${loc}'`, `deleted_at IS NULL`, `product_sync_id IS NOT NULL`,
      ...(to ? [`DATE(created_at) <= '${to}'`] : []),
    ].join(' AND ');

    const rows = db.prepare(`
      SELECT
        p.id, p.code, p.name, p.unit, p.alt_unit, p.conversion_factor, p.alt_price, p.units_json, p.default_unit,
        p.cost_price, p.selling_price, p.min_stock, p.status, p.product_type,
        c.id AS category_id, c.name AS category_name, c.color AS category_color, c.main_category_id,
        COALESCE(store_agg.store_balance, 0) AS store_balance,
        COALESCE(opening_agg.opening_balance, 0) AS opening_balance,
        COALESCE(mvt_agg.total_in, 0) AS total_in,
        COALESCE(mvt_agg.total_out, 0) AS total_out,
        CASE WHEN COALESCE(grn_cost.total_qty, 0) > 0
          THEN ROUND(COALESCE(grn_cost.total_cost, 0) / grn_cost.total_qty, 2)
          ELSE p.cost_price
        END AS avg_cost_price,
        CASE WHEN COALESCE(reprocess_agg.available_for_reprocessing, 0) < 0
          THEN 0
          ELSE COALESCE(reprocess_agg.available_for_reprocessing, 0)
        END AS available_for_reprocessing
      FROM products p
      LEFT JOIN categories c ON p.category_sync_id = c.sync_id
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS store_balance
        FROM stock_movements WHERE ${balanceWhere} GROUP BY product_sync_id
      ) store_agg ON store_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS opening_balance
        FROM stock_movements WHERE ${openingWhere} GROUP BY product_sync_id
      ) opening_agg ON opening_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id,
          SUM(CASE WHEN quantity > 0 AND movement_type != 'opening' THEN quantity ELSE 0 END) AS total_in,
          ABS(SUM(CASE WHEN quantity < 0 THEN quantity ELSE 0 END)) AS total_out
        FROM stock_movements WHERE ${rangeWhere} GROUP BY product_sync_id
      ) mvt_agg ON mvt_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        -- Avg cost per BASE unit. Uses units_json so it works for N packagings (PCS + Pack + Box + …).
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.product_sync_id IS NOT NULL AND gi.deleted_at IS NULL
        GROUP BY gi.product_sync_id
      ) grn_cost ON grn_cost.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id,
          SUM(CASE WHEN movement_type = 'sales_return' THEN quantity ELSE 0 END) +
          SUM(CASE WHEN movement_type = 'production_input' THEN quantity ELSE 0 END)
          AS available_for_reprocessing
        FROM stock_movements WHERE location = '${loc}' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
      ) reprocess_agg ON reprocess_agg.product_sync_id = p.sync_id
      WHERE p.deleted_at IS NULL AND p.tenant_id = ?
      ORDER BY p.name
    `).all(tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales
router.get('/sales', auth, readOnlyGuard, (req, res) => {
  try {
    const { date } = req.query;
    const selectedDate = date || new Date().toISOString().split('T')[0];

    const rows = db.prepare(`
      SELECT
        p.id, p.code, p.name, p.unit, p.alt_unit, p.conversion_factor, p.units_json, p.default_unit,
        p.cost_price, p.selling_price, p.min_stock, p.status,
        c.id AS category_id, c.name AS category_name, c.color AS category_color, c.main_category_id,

        COALESCE(prev_actual.actual_balance,
          COALESCE(opening_agg.opening_balance, 0)
        ) AS opening_balance,

        COALESCE(input_agg.input, 0) AS input,
        COALESCE(sales_day_agg.total_sales, 0) AS total_sales,
        COALESCE(returns_day_agg.total_returns, 0) AS total_returns,
        COALESCE(all_sales_agg.sales_balance, 0) AS sales_balance,

        CASE WHEN dcs.avg_cost_price IS NOT NULL THEN dcs.avg_cost_price
          WHEN COALESCE(grn_cost.total_qty, 0) + COALESCE(prod_cost.total_qty, 0) > 0
            THEN ROUND((COALESCE(grn_cost.total_cost, 0) + COALESCE(prod_cost.total_cost, 0)) /
                       (COALESCE(grn_cost.total_qty, 0) + COALESCE(prod_cost.total_qty, 0)), 2)
          ELSE p.cost_price
        END AS avg_cost_price,

        CASE WHEN dcs.selling_price IS NOT NULL THEN dcs.selling_price
          ELSE p.selling_price
        END AS selling_price,

        COALESCE(today_actual.actual_balance, NULL) AS saved_actual_balance,
        today_actual.reason AS saved_reason

      FROM products p
      LEFT JOIN categories c ON p.category_sync_id = c.sync_id

      LEFT JOIN daily_actual_balance prev_actual
        ON prev_actual.product_sync_id = p.sync_id AND prev_actual.date = date(@date, '-1 day')

      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS opening_balance
        FROM stock_movements WHERE location = 'sales' AND deleted_at IS NULL AND created_at < @date AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) opening_agg ON opening_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        -- v1.9.24 — Sosna posts GRN directly at location='sales' (no store
        -- layer, no SIV), so the Input column has to include 'grn' (and
        -- 'transfer_in') alongside 'siv'. Date filter is on the stock_movement
        -- created_at (which carries the GRN/SIV business date, set explicitly
        -- in the writer), so the old JOIN to siv just to read siv.date is
        -- unnecessary.
        SELECT product_sync_id, SUM(quantity) AS input
        FROM stock_movements
        WHERE location = 'sales'
          AND movement_type IN ('siv', 'grn', 'transfer_in')
          AND date(created_at) = @date
          AND deleted_at IS NULL
          AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) input_agg ON input_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        -- v1.8.15: include 'sale_reverse' (partial-reverse movement type
        -- introduced in v1.8.12). Without this, reversing 1 of 12 PUSHKIN
        -- sales still shows Total Sales=12 because the +1 sale_reverse
        -- movement was ignored. ABS(SUM(...)) gives NET sales after
        -- reverses (sale=-qty, sale_reverse=+qty).
        SELECT product_sync_id, ABS(SUM(quantity)) AS total_sales
        FROM stock_movements WHERE location = 'sales' AND movement_type IN ('sale', 'reverse', 'sale_reverse')
          AND created_at >= @date AND created_at < date(@date, '+1 day') AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) sales_day_agg ON sales_day_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        SELECT sm.product_sync_id, ABS(SUM(sm.quantity)) AS total_returns
        FROM stock_movements sm
        JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id
        WHERE sm.location = 'sales' AND sm.movement_type = 'sales_return'
          AND sr.date = @date AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        GROUP BY sm.product_sync_id
      ) returns_day_agg ON returns_day_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS sales_balance
        FROM stock_movements WHERE location = 'sales'
          AND deleted_at IS NULL AND created_at < date(@date, '+1 day') AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) all_sales_agg ON all_sales_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        -- Avg cost per BASE unit. baseQtyExpr handles N packagings via units_json.
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.product_sync_id IS NOT NULL AND gi.deleted_at IS NULL
        GROUP BY gi.product_sync_id
      ) grn_cost ON grn_cost.product_sync_id = p.sync_id

      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost
        FROM production_outputs WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL GROUP BY product_sync_id
      ) prod_cost ON prod_cost.product_sync_id = p.sync_id

      LEFT JOIN daily_cost_snapshot dcs
        ON dcs.product_sync_id = p.sync_id AND dcs.date = @date AND dcs.deleted_at IS NULL

      LEFT JOIN daily_actual_balance today_actual
        ON today_actual.product_sync_id = p.sync_id AND today_actual.date = @date

      WHERE p.deleted_at IS NULL AND p.tenant_id = @tenantId AND (
        COALESCE(all_sales_agg.sales_balance, 0) != 0
        OR COALESCE(input_agg.input, 0) != 0
        OR COALESCE(sales_day_agg.total_sales, 0) != 0
        OR COALESCE(prev_actual.actual_balance, 0) != 0
        OR today_actual.actual_balance IS NOT NULL
      )

      ORDER BY p.name
    `).all({ date: selectedDate, tenantId: req.user.tenantId });
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/profit-summary?date=YYYY-MM-DD
router.get('/sales/profit-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { date } = req.query;
    const selectedDate = date || new Date().toISOString().split('T')[0];
    const tenantId = req.user.tenantId;

    // Revenue: actual cash from POS orders
    const revRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE DATE(created_at) = ? AND deleted_at IS NULL AND tenant_id = ?
        AND (status IS NULL OR status != 'Reversed')
    `).get(selectedDate, tenantId);

    // COGS: sale movements × snapshot cost (fallback to GRN+production avg, then p.cost_price)
    const cogsRow = db.prepare(`
      SELECT COALESCE(SUM(ABS(sm.quantity) *
        COALESCE(dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS cogs
      FROM stock_movements sm
      JOIN products p ON p.sync_id = sm.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sm.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type IN ('sale', 'reverse', 'sale_reverse')
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(selectedDate, selectedDate, tenantId);

    // Difference value: reconciliation movements × snapshot cost
    const diffRow = db.prepare(`
      SELECT COALESCE(SUM(sm.quantity *
        COALESCE(dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS diff_value
      FROM stock_movements sm
      JOIN products p ON p.sync_id = sm.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sm.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type = 'reconciliation'
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(selectedDate, selectedDate, tenantId);

    // Cash difference from saved cash report
    const cashRow = db.prepare(`
      SELECT COALESCE(difference, 0) AS cash_difference
      FROM cash_reports WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(selectedDate, tenantId);

    // PV total for the date
    const pvRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS pv_total
      FROM payment_vouchers WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(selectedDate, tenantId);

    // Stock adjustment value × snapshot cost
    const adjRow = db.prepare(`
      SELECT COALESCE(SUM(sa.quantity *
        COALESCE(dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS stock_adj
      FROM stock_adjustments sa
      JOIN products p ON p.sync_id = sa.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sa.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) grn_agg ON grn_agg.product_sync_id = sa.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sa.product_sync_id
      WHERE sa.date = ? AND sa.deleted_at IS NULL AND p.tenant_id = ?
    `).get(selectedDate, selectedDate, tenantId);

    const revenue       = parseFloat(revRow.revenue);
    const cogs          = parseFloat(cogsRow.cogs);
    const diffValue     = parseFloat(diffRow.diff_value);
    const cashDiff      = parseFloat(cashRow?.cash_difference ?? 0);
    const pvTotal       = parseFloat(pvRow.pv_total);
    const stockAdj      = parseFloat(adjRow.stock_adj);
    const grossProfit   = revenue - cogs + diffValue + cashDiff;
    const netProfit     = grossProfit - pvTotal + stockAdj;

    res.json({ revenue, cogs, diff_value: diffValue, cash_difference: cashDiff, gross_profit: grossProfit, pv_total: pvTotal, stock_adj: stockAdj, net_profit: netProfit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/daily-summary?date=YYYY-MM-DD
router.get('/sales/daily-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const tenantId = req.user.tenantId;
    const row = db.prepare(`
      SELECT date, revenue, cogs, damages, supplier_rebates, diff_value, cash_difference, pv_total, stock_adj, gross_profit, net_profit
      FROM daily_profit_summary
      WHERE date = ? AND tenant_id = ?
    `).get(date, tenantId);
    if (!row) return res.json({ date, revenue: 0, cogs: 0, damages: 0, supplier_rebates: 0, diff_value: 0, cash_difference: 0, pv_total: 0, stock_adj: 0, gross_profit: 0, net_profit: 0 });
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/range-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns the full profit breakdown aggregated over the range so the Profit
// Report can render the same set of cards/rows in either single-day or range mode.
router.get('/sales/range-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    const tenantId = req.user.tenantId;
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(revenue),         0) AS revenue,
        COALESCE(SUM(cogs),            0) AS cogs,
        COALESCE(SUM(damages),         0) AS damages,
        COALESCE(SUM(supplier_rebates),0) AS supplier_rebates,
        COALESCE(SUM(diff_value),      0) AS diff_value,
        COALESCE(SUM(cash_difference), 0) AS cash_difference,
        COALESCE(SUM(pv_total),        0) AS pv_total,
        COALESCE(SUM(stock_adj),       0) AS stock_adj,
        COALESCE(SUM(gross_profit),    0) AS gross_profit,
        COALESCE(SUM(net_profit),      0) AS net_profit,
        -- Legacy aliases (used by Dashboard widget — keep so we don't break anything)
        COALESCE(SUM(revenue),      0) AS total_revenue
      FROM daily_profit_summary
      WHERE tenant_id = ?
        AND (? IS NULL OR date >= ?)
        AND (? IS NULL OR date <= ?)
    `).get(tenantId, from || null, from || null, to || null, to || null);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/monthly-summary?month=YYYY-MM
router.get('/sales/monthly-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const tenantId = req.user.tenantId;

    // Sum stored daily profit rows (only days where actual balances were saved)
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(revenue), 0)         AS total_revenue,
        COALESCE(SUM(cogs), 0)            AS total_cogs,
        COALESCE(SUM(diff_value), 0)      AS total_difference,
        COALESCE(SUM(cash_difference), 0) AS total_cash_difference,
        COALESCE(SUM(pv_total), 0)        AS total_pv,
        COALESCE(SUM(gross_profit), 0)    AS gross_profit,
        COALESCE(SUM(net_profit), 0)      AS net_profit
      FROM daily_profit_summary
      WHERE strftime('%Y-%m', date) = ? AND tenant_id = ?
    `).get(month, tenantId);

    res.json({
      total_revenue:         parseFloat(row.total_revenue),
      total_cogs:            parseFloat(row.total_cogs),
      total_difference:      parseFloat(row.total_difference),
      total_cash_difference: parseFloat(row.total_cash_difference),
      total_pv:              parseFloat(row.total_pv),
      gross_profit:          parseFloat(row.gross_profit),
      net_profit:            parseFloat(row.net_profit),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/siv-breakdown?date=&product_id=
router.get('/sales/siv-breakdown', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, product_id } = req.query;
    const rows = db.prepare(`
      SELECT s.siv_number, s.department, sm.quantity, sm.created_at
      FROM stock_movements sm
      JOIN siv s ON s.sync_id = sm.reference_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type = 'siv'
        AND sm.product_sync_id = (SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?) AND s.date = ? AND sm.deleted_at IS NULL
      ORDER BY sm.created_at ASC
    `).all(product_id, req.user.tenantId, date);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/inventory/sales/actual — save actual balances for a date
router.post('/sales/actual', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, entries, created_by, diff_value } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    db.transaction(() => {
      for (const entry of entries) {
        // Prefer client-sent product_sync_id to avoid writing the actual
        // balance against the wrong product on cross-device data.
        const entryProductSyncId = entry.product_sync_id
          || db.prepare('SELECT sync_id FROM products WHERE id = ?').get(entry.product_id)?.sync_id
          || null;

        // Save actual balance record
        db.prepare(`
          INSERT INTO daily_actual_balance (product_id, product_sync_id, date, actual_balance, reason, created_by, sync_id, tenant_id, branch_id, device_id, synced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT (product_sync_id, date)
          DO UPDATE SET actual_balance = excluded.actual_balance,
                        reason = excluded.reason,
                        created_by = excluded.created_by,
                        created_at = datetime('now'),
                        synced = 0
        `).run(entry.product_id, entryProductSyncId, date, entry.actual_balance, entry.reason || null, created_by,
               randomUUID(), tenantId, branchId, deviceId);

        // Create reconciliation movement so POS "In Stock" reflects the actual balance
        // Step 1: delete ALL old reconciliations first (avoids stacking)
        // v1.10.23 — roll the old reconciliations' net effect off current_stock
        // before soft-deleting them. Otherwise a re-reconciliation double-counts.
        const oldRec = db.prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS net FROM stock_movements
            WHERE product_sync_id = ? AND location = 'sales'
              AND movement_type = 'reconciliation' AND deleted_at IS NULL`
        ).get(entryProductSyncId).net;
        if (oldRec && Math.abs(oldRec) > 0.0001) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(oldRec, entryProductSyncId);
        }
        db.prepare(
          `UPDATE stock_movements SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE product_sync_id = ? AND location = 'sales' AND movement_type = 'reconciliation' AND deleted_at IS NULL`
        ).run(entryProductSyncId);
        // Step 2: calculate diff against natural movements only (no reconciliations left)
        const currentSales = db.prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS bal FROM stock_movements WHERE product_sync_id = ? AND location = 'sales' AND deleted_at IS NULL`
        ).get(entryProductSyncId);
        const diff = parseFloat(entry.actual_balance) - parseFloat(currentSales.bal);
        if (Math.abs(diff) > 0.0001) {
          db.prepare(`
            INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
            VALUES (?, ?, 'sales', 'reconciliation', ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
          `).run(entry.product_id, entryProductSyncId, diff, `Reconciliation: actual balance set to ${entry.actual_balance}`, created_by,
                 randomUUID(), tenantId, branchId, deviceId, date);
          // v1.10.23 — apply the new reconciliation delta to current_stock.
          db.prepare(
            `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(diff, entryProductSyncId);
        }
      }
    })();

    // Snapshot avg_cost_price + selling_price for ALL active products for this date
    const allProducts = db.prepare(`
      SELECT p.id, p.sync_id, p.cost_price, p.selling_price,
        COALESCE(grn_agg.total_qty, 0) + COALESCE(prod_agg.total_qty, 0) AS combined_qty,
        COALESCE(grn_agg.total_cost, 0) + COALESCE(prod_agg.total_cost, 0) AS combined_cost
      FROM products p
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost
        FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost
        FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) prod_agg ON prod_agg.product_sync_id = p.sync_id
      WHERE p.deleted_at IS NULL AND p.tenant_id = ?
    `).all(tenantId);

    const upsertSnapshot = db.prepare(`
      INSERT INTO daily_cost_snapshot (product_id, product_sync_id, date, avg_cost_price, selling_price, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      ON CONFLICT (product_sync_id, date)
      DO UPDATE SET avg_cost_price = excluded.avg_cost_price,
                    selling_price  = excluded.selling_price,
                    updated_at     = datetime('now'),
                    synced         = 0
    `);

    db.transaction(() => {
      for (const p of allProducts) {
        const avgCost = (p.combined_qty > 0)
          ? parseFloat(p.combined_cost) / parseFloat(p.combined_qty)
          : parseFloat(p.cost_price);
        upsertSnapshot.run(p.id, p.sync_id, date, avgCost, parseFloat(p.selling_price),
          randomUUID(), tenantId, branchId, deviceId);
      }
    })();

    // Compute and store daily profit summary (use frontend-computed diff_value if provided)
    recalculateDailyProfit(db, date, tenantId);

    res.json({ message: 'Actual balances saved successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/stats
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const q = balanceSQL(req.user.tenantId);
    const products = db.prepare(q.text).all(...q.params);
    const totalProducts = products.length;
    const storeValue = products.reduce((sum, p) => sum + parseFloat(p.store_balance) * parseFloat(p.selling_price || 0), 0);
    const salesValue = products.reduce((sum, p) => sum + parseFloat(p.sales_balance) * parseFloat(p.selling_price || 0), 0);
    const lowStockSales = products.filter(p => parseFloat(p.sales_balance) <= parseFloat(p.min_stock || 0)).length;
    const lowStockStore = products.filter(p => parseFloat(p.store_balance) <= parseFloat(p.min_stock || 0)).length;
    res.json({ totalProducts, storeValue, salesValue, lowStockSales, lowStockStore });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/bin-card
router.get('/bin-card', auth, readOnlyGuard, (req, res) => {
  try {
    const { product_id, from, to } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required.' });
    const pid = parseInt(product_id);

    const pidSyncRow = db.prepare('SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?').get(pid, req.user.tenantId);
    const pidSync = pidSyncRow?.sync_id;

    // Opening balance: ALL opening movements (any date) + non-opening movements before 'from'
    let obSql, obParams;
    if (from) {
      obSql = `SELECT COALESCE(SUM(quantity), 0) AS opening_balance FROM stock_movements
        WHERE product_sync_id = ? AND location = 'store' AND deleted_at IS NULL
        AND (movement_type = 'opening' OR created_at < ?)`;
      obParams = [pidSync, from];
    } else {
      obSql = `SELECT COALESCE(SUM(quantity), 0) AS opening_balance FROM stock_movements
        WHERE product_sync_id = ? AND location = 'store' AND deleted_at IS NULL`;
      obParams = [pidSync];
    }
    const obRow = db.prepare(obSql).get(...obParams);
    const openingBalance = parseFloat(obRow.opening_balance);

    // Main bin-card query: exclude opening movements (already in opening balance)
    const namedParams = { product_sync_id: pidSync };
    // v1.10.318/319 — reference-resolution joins. Optional tables
    // (stock_transfers, supplier_credit_notes, sales_returns) are
    // spliced in only when they exist on this branch DB; a missing
    // one no longer breaks the whole endpoint (v1.10.318 shipped a
    // "no such table: stock_transfers" regression on Kassumbalesa).
    const hasStockTransfers = tableExists('stock_transfers');
    const hasSupplierCns    = tableExists('supplier_credit_notes');
    const hasSalesReturns   = tableExists('sales_returns');
    let sql = `
      SELECT
        sm.id,
        date(sm.created_at)   AS date,
        sm.movement_type,
        sm.reference_type,
        COALESCE(
          g.grn_number,
          sv.siv_number,
          pr.production_number,
          ${hasSalesReturns ? 'sr.return_number,' : ''}
          ${hasSupplierCns ? 'scn.credit_note_number,' : ''}
          ${hasStockTransfers ? 'st.transfer_number,' : ''}
          sm.movement_type
        ) AS reference,
        sm.quantity,
        SUM(sm.quantity) OVER (
          ORDER BY sm.created_at ASC, sm.id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_total
      FROM stock_movements sm
      LEFT JOIN grn g        ON g.sync_id  = sm.reference_sync_id
      LEFT JOIN siv sv       ON sv.sync_id = sm.reference_sync_id AND sm.reference_type = 'siv'
      LEFT JOIN production pr ON pr.sync_id = sm.reference_sync_id AND sm.reference_type = 'production'
      ${hasSalesReturns ? "LEFT JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id AND sm.reference_type = 'sales_return'" : ''}
      ${hasSupplierCns ? "LEFT JOIN supplier_credit_notes scn ON scn.sync_id = sm.reference_sync_id AND sm.reference_type = 'credit_note'" : ''}
      ${hasStockTransfers ? "LEFT JOIN stock_transfers st ON st.sync_id = sm.reference_sync_id AND (sm.reference_type = 'transfer' OR sm.reference_type = 'stock_transfer')" : ''}
      WHERE sm.product_sync_id = @product_sync_id AND sm.location = 'store'
        AND sm.deleted_at IS NULL AND sm.movement_type != 'opening'
    `;
    if (from) { sql += ' AND sm.created_at >= @from'; namedParams.from = from; }
    if (to)   { sql += " AND sm.created_at < date(@to, '+1 day')"; namedParams.to = to; }
    sql += ' ORDER BY sm.created_at ASC, sm.id ASC';

    // Add opening balance offset to each row's balance in JS (not SQL) to avoid window function param binding issues
    const rawRows = db.prepare(sql).all(namedParams);

    // v1.10.320 — Cross-DB reference resolution (same rationale as
    // /sales-bin-card): resolve hq_grn and transfer refs from master.db
    // when the branch join misses.
    if (masterDb) {
      const missing = rawRows.filter(r => r.reference === r.movement_type);
      if (missing.length > 0) {
        const ids = missing.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        let smRows = [];
        try {
          smRows = db.prepare(
            `SELECT id, reference_type, reference_sync_id FROM stock_movements WHERE id IN (${placeholders})`
          ).all(...ids);
        } catch (_) { smRows = []; }
        const smBy = Object.fromEntries(smRows.map(r => [r.id, r]));

        // v1.10.321 — HQ generation inserts branch stock_movements with
        // reference_type='grn' (not 'hq_grn'). The reference_sync_id
        // still equals master.hq_grns.sync_id, so look up ANY 'grn' or
        // 'hq_grn' row whose branch.grn join missed.
        const hqSyncIds = [...new Set(smRows
          .filter(r => r.reference_type === 'grn' || r.reference_type === 'hq_grn')
          .map(r => r.reference_sync_id).filter(Boolean))];
        const trSyncIds = [...new Set(smRows
          .filter(r => r.reference_type === 'transfer' || r.reference_type === 'stock_transfer')
          .map(r => r.reference_sync_id).filter(Boolean))];

        const hqNumBy = {};
        if (hqSyncIds.length > 0) {
          try {
            const ph = hqSyncIds.map(() => '?').join(',');
            const hg = masterDb.prepare(
              `SELECT sync_id, grn_number FROM hq_grns WHERE sync_id IN (${ph})`
            ).all(...hqSyncIds);
            for (const h of hg) hqNumBy[h.sync_id] = h.grn_number;
          } catch (_) { /* optional */ }
        }
        const trNumBy = {};
        if (trSyncIds.length > 0) {
          try {
            const ph = trSyncIds.map(() => '?').join(',');
            const tr = masterDb.prepare(
              `SELECT sync_id, transfer_number FROM stock_transfers WHERE sync_id IN (${ph})`
            ).all(...trSyncIds);
            for (const t of tr) trNumBy[t.sync_id] = t.transfer_number;
          } catch (_) { /* optional */ }
        }

        for (const r of missing) {
          const sm = smBy[r.id];
          if (!sm) continue;
          if ((sm.reference_type === 'grn' || sm.reference_type === 'hq_grn') && hqNumBy[sm.reference_sync_id]) {
            r.reference = hqNumBy[sm.reference_sync_id];
          } else if ((sm.reference_type === 'transfer' || sm.reference_type === 'stock_transfer') && trNumBy[sm.reference_sync_id]) {
            r.reference = trNumBy[sm.reference_sync_id];
          }
        }
      }
    }

    const rows = rawRows.map(row => ({ ...row, balance: openingBalance + row.running_total }));
    res.json({ rows, opening_balance: openingBalance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales-bin-card
router.get('/sales-bin-card', auth, readOnlyGuard, (req, res) => {
  try {
    const { product_id, from, to } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required.' });
    const pid = parseInt(product_id);

    const pidSyncRow = db.prepare('SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?').get(pid, req.user.tenantId);
    const pidSync = pidSyncRow?.sync_id;

    // For sales_return movements, use the user-selected date (sr.date) not created_at
    const effectiveDate = `CASE WHEN sm.movement_type = 'sales_return' AND sr.date IS NOT NULL THEN sr.date ELSE date(sm.created_at) END`;

    // Opening balance: sum of all sales movements before 'from'
    let obSql, obParams;
    if (from) {
      obSql = `SELECT COALESCE(SUM(sm.quantity), 0) AS opening_balance
        FROM stock_movements sm
        LEFT JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id AND sm.reference_type = 'sales_return'
        WHERE sm.product_sync_id = ? AND sm.location = 'sales' AND sm.deleted_at IS NULL
          AND (CASE WHEN sm.movement_type = 'sales_return' AND sr.date IS NOT NULL THEN sr.date ELSE date(sm.created_at) END) < ?`;
      obParams = [pidSync, from];
    } else {
      obSql = `SELECT COALESCE(SUM(sm.quantity), 0) AS opening_balance
        FROM stock_movements sm
        LEFT JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id AND sm.reference_type = 'sales_return'
        WHERE sm.product_sync_id = ? AND sm.location = 'sales' AND sm.deleted_at IS NULL AND 1=0`;
      obParams = [pidSync];
    }
    const obRow = db.prepare(obSql).get(...obParams);
    const openingBalance = parseFloat(obRow.opening_balance);

    const namedParams = { product_sync_id: pidSync };
    // v1.10.318/319 — resolve reference for EVERY movement_type by
    // joining the appropriate source table; splice optional joins only
    // when the table exists on this branch DB (v1.10.318 broke
    // Kassumbalesa which has no stock_transfers table locally).
    const hasStockTransfers2 = tableExists('stock_transfers');
    const hasSupplierCns2    = tableExists('supplier_credit_notes');
    const hasSalesReturns2   = tableExists('sales_returns');
    let sql = `
      SELECT
        sm.id,
        (${effectiveDate}) AS date,
        sm.movement_type,
        sm.reference_type,
        COALESCE(
          o.order_number,
          sv.siv_number,
          ${hasSalesReturns2 ? 'sr.return_number,' : ''}
          g.grn_number,
          sv_grn.grn_number,
          ${hasSupplierCns2 ? 'scn.credit_note_number,' : ''}
          ${hasStockTransfers2 ? 'st.transfer_number,' : ''}
          sm.movement_type
        ) AS reference,
        sv_grn.grn_number AS source_grn_number,
        COALESCE(s_direct.name, s_siv.name) AS supplier_name,
        sm.quantity,
        SUM(sm.quantity) OVER (
          ORDER BY (${effectiveDate}) ASC, sm.id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_total
      FROM stock_movements sm
      LEFT JOIN orders o         ON o.sync_id  = sm.reference_sync_id AND sm.reference_type = 'order'
      LEFT JOIN siv sv           ON sv.sync_id = sm.reference_sync_id AND sm.reference_type = 'siv'
      LEFT JOIN grn sv_grn       ON sv_grn.sync_id = sv.source_grn_sync_id
      LEFT JOIN grn g            ON g.sync_id  = sm.reference_sync_id
      ${hasSalesReturns2 ? "LEFT JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id AND sm.reference_type = 'sales_return'" : ''}
      ${hasSupplierCns2 ? "LEFT JOIN supplier_credit_notes scn ON scn.sync_id = sm.reference_sync_id AND sm.reference_type = 'credit_note'" : ''}
      ${hasStockTransfers2 ? "LEFT JOIN stock_transfers st ON st.sync_id = sm.reference_sync_id AND (sm.reference_type = 'transfer' OR sm.reference_type = 'stock_transfer')" : ''}
      LEFT JOIN suppliers s_direct ON s_direct.sync_id = g.supplier_sync_id
      LEFT JOIN suppliers s_siv    ON s_siv.sync_id    = sv_grn.supplier_sync_id
      WHERE sm.product_sync_id = @product_sync_id AND sm.location = 'sales'
        AND sm.deleted_at IS NULL
    `;
    if (from) { sql += ` AND (${effectiveDate}) >= @from`; namedParams.from = from; }
    if (to)   { sql += ` AND (${effectiveDate}) <= @to`; namedParams.to = to; }
    sql += ` ORDER BY (${effectiveDate}) ASC, sm.id ASC`;

    const rawRows = db.prepare(sql).all(namedParams);

    // v1.10.320 — Cross-DB reference resolution for HQ-generated GRNs and
    // for stock transfers on branches that don't carry stock_transfers
    // locally (e.g. Kassumbalesa). When the branch join misses, the SQL
    // COALESCE falls back to sm.movement_type verbatim ("grn",
    // "transfer_in", ...). Look those up in master.hq_grns and
    // master.stock_transfers so the UI shows real document numbers.
    if (masterDb) {
      const missing = rawRows.filter(r => r.reference === r.movement_type);
      if (missing.length > 0) {
        // Need the raw reference_sync_id per row (not selected above), so
        // re-select once for the missing set.
        const ids = missing.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        let smRows = [];
        try {
          smRows = db.prepare(
            `SELECT id, reference_type, reference_sync_id FROM stock_movements WHERE id IN (${placeholders})`
          ).all(...ids);
        } catch (_) { smRows = []; }
        const smBy = Object.fromEntries(smRows.map(r => [r.id, r]));

        const hqSyncIds = [...new Set(smRows
          .filter(r => r.reference_type === 'hq_grn')
          .map(r => r.reference_sync_id)
          .filter(Boolean))];
        const trSyncIds = [...new Set(smRows
          .filter(r => r.reference_type === 'transfer' || r.reference_type === 'stock_transfer')
          .map(r => r.reference_sync_id)
          .filter(Boolean))];

        const hqNumBy = {};
        const hqSupSyncBy = {};
        if (hqSyncIds.length > 0) {
          try {
            const ph = hqSyncIds.map(() => '?').join(',');
            // v1.10.322 — masterDb has no `suppliers` table (that lives
            // on the tenant DB), so the earlier JOIN silently threw and
            // hqNumBy came back empty on every branch. Read the raw
            // supplier_sync_id from master and resolve to a name via
            // the tenant `suppliers` table below.
            const hg = masterDb.prepare(
              `SELECT sync_id, grn_number, supplier_sync_id
                 FROM hq_grns WHERE sync_id IN (${ph})`
            ).all(...hqSyncIds);
            for (const h of hg) { hqNumBy[h.sync_id] = h.grn_number; if (h.supplier_sync_id) hqSupSyncBy[h.sync_id] = h.supplier_sync_id; }
          } catch (e) { console.warn('[sales-bin-card] master hq_grns lookup failed:', e.message); }
        }
        // Second hop: resolve supplier_sync_id → name via tenant suppliers.
        const hqSupBy = {};
        const supIds = [...new Set(Object.values(hqSupSyncBy))];
        if (supIds.length > 0) {
          try {
            const ph = supIds.map(() => '?').join(',');
            const sup = db.prepare(
              `SELECT sync_id, name FROM suppliers WHERE sync_id IN (${ph})`
            ).all(...supIds);
            const nameBy = Object.fromEntries(sup.map(s => [s.sync_id, s.name]));
            for (const [gSync, supSync] of Object.entries(hqSupSyncBy)) {
              if (nameBy[supSync]) hqSupBy[gSync] = nameBy[supSync];
            }
          } catch (_) { /* suppliers table missing on branch — non-fatal */ }
        }
        const trNumBy = {};
        if (trSyncIds.length > 0) {
          try {
            const ph = trSyncIds.map(() => '?').join(',');
            const tr = masterDb.prepare(
              `SELECT sync_id, transfer_number FROM stock_transfers WHERE sync_id IN (${ph})`
            ).all(...trSyncIds);
            for (const t of tr) trNumBy[t.sync_id] = t.transfer_number;
          } catch (_) { /* master stock_transfers lookup optional */ }
        }

        for (const r of missing) {
          const sm = smBy[r.id];
          if (!sm) continue;
          if ((sm.reference_type === 'grn' || sm.reference_type === 'hq_grn') && hqNumBy[sm.reference_sync_id]) {
            r.reference = hqNumBy[sm.reference_sync_id];
            if (!r.supplier_name && hqSupBy[sm.reference_sync_id]) r.supplier_name = hqSupBy[sm.reference_sync_id];
          } else if ((sm.reference_type === 'transfer' || sm.reference_type === 'stock_transfer') && trNumBy[sm.reference_sync_id]) {
            r.reference = trNumBy[sm.reference_sync_id];
          }
        }
      }
    }

    const rows = rawRows.map(row => ({ ...row, balance: openingBalance + row.running_total }));
    res.json({ rows, opening_balance: openingBalance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
