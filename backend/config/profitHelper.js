/**
 * profitHelper.js
 * Reusable function to compute and store daily gross/net profit.
 *
 * Formula (after the Sales Inventory / Stock Adjustment retirement):
 *   Gross Profit = Revenue − COGS − Damages + Supplier Rebates + Stock Variance + Cash Variance
 *   Net Profit   = Gross Profit − Expenses (PV)
 *
 * "Supplier Rebates" = SUM(supplier_credit_notes.amount) for the day where
 * reason IN ('Discount','Other'). Crate/Bottle returns are excluded — those
 * are deposit refunds, not income (they affect AP balance + empty stock only).
 *
 * Stock Variance is the sum of stock_reconciliation_items.variance_base × cost_at_count
 * for that count_date — covers BOTH sales and store locations.
 *
 * Called from: stock reconciliation POST, cash-reports save, payment-vouchers save,
 * order create/reverse, GRN save.
 */
const { randomUUID } = require('crypto');
const { baseQtyExpr } = require('./unitsHelper');

function recalculateDailyProfit(db, date, tenantId) {
  try {

    // Revenue: total sales billed today (accrual — includes credit sales whether paid or not).
    // Cash actually collected is tracked separately in the Cash Report.
    const revRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE DATE(created_at) = ? AND deleted_at IS NULL AND tenant_id = ?
        AND (status IS NULL OR status != 'Reversed')
    `).get(date, tenantId);

    // COGS: sale movements × snapshotted cost price
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
      LEFT JOIN (
        -- Avg cost per BASE unit. baseQtyExpr handles N packagings via units_json.
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.deleted_at IS NULL AND gi.product_sync_id IS NOT NULL
        GROUP BY gi.product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type IN ('sale', 'reverse')
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(date, date, tenantId);

    // Diff: mirrors exactly what the frontend computes per row:
    // difference = actual_balance - (opening_balance + input - total_sales - total_returns)
    // totalDiff  = SUM(difference × avg_cost_price)
    // Cash difference (drawer over / short for the day)
    const cashRow = db.prepare(`
      SELECT COALESCE(difference, 0) AS cash_difference
      FROM cash_reports WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(date, tenantId);

    // Expenses for the day (Payment Vouchers)
    const pvRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS pv_total
      FROM payment_vouchers WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(date, tenantId);

    // Stock Variance — from Stock Reconciliation only (replaces the old daily_actual_balance + stock_adjustments)
    // Sums variance × cost_at_count across BOTH sales and store reconciliations for the date.
    // Positive = found extra stock (stock gain) · Negative = shrinkage.
    const reconRow = db.prepare(`
      SELECT COALESCE(SUM(sri.variance_base * sri.cost_at_count), 0) AS recon_value
      FROM stock_reconciliation_items sri
      JOIN stock_reconciliations sr ON sr.id = sri.reconciliation_id
      WHERE sr.count_date = ? AND sr.deleted_at IS NULL AND sri.deleted_at IS NULL AND sr.tenant_id = ?
    `).get(date, tenantId);

    // Damages — items destroyed/expired (recorded via Sales Damages page).
    // Cost = ABS(qty) × avg_cost_price for sales_return movements at 'sales' location.
    // Uses the same cost basis as COGS (snapshot-first, falling back to GRN+production avg, then cost_price).
    const damageRow = db.prepare(`
      SELECT COALESCE(SUM(ABS(sm.quantity) *
        COALESCE(dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS damages
      FROM stock_movements sm
      JOIN products p ON p.sync_id = sm.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sm.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.deleted_at IS NULL AND gi.product_sync_id IS NOT NULL
        GROUP BY gi.product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type = 'sales_return'
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(date, date, tenantId);

    // Supplier Rebates — confirmed credit notes for the day, excluding
    // crate/bottle returns (those are deposit refunds, not income).
    const rebateRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS supplier_rebates
      FROM supplier_credit_notes
      WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
        AND reason IN ('Discount', 'Other')
    `).get(date, tenantId);

    // Interest Expense — interest payments on loans for the day. The cost of
    // borrowing IS a real expense. Principal repayments and disbursements are
    // not — they only move cash + the loan balance, not the P&L.
    const intRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS interest_expense
      FROM loan_transactions
      WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
        AND type = 'Interest'
    `).get(date, tenantId);

    const revenue         = parseFloat(revRow.revenue);
    const cogs            = parseFloat(cogsRow.cogs);
    const cashDiff        = parseFloat(cashRow?.cash_difference ?? 0);
    const pvTotal         = parseFloat(pvRow.pv_total);
    const stockVariance   = parseFloat(reconRow?.recon_value ?? 0);
    const damages         = parseFloat(damageRow?.damages ?? 0);
    const supplierRebates = parseFloat(rebateRow?.supplier_rebates ?? 0);
    const interestExpense = parseFloat(intRow?.interest_expense ?? 0);
    // Gross = Revenue − COGS − Damages + Supplier Rebates + Stock Variance + Cash Variance
    const grossProfit     = revenue - cogs - damages + supplierRebates + stockVariance + cashDiff;
    // Net = Gross − PV expenses − Interest expense on loans
    const netProfit       = grossProfit - pvTotal - interestExpense;
    // Legacy columns kept for schema compatibility — diff_value now stores the stock variance, stock_adj retired (0).
    const diffValue     = stockVariance;
    const stockAdj      = 0;

    // Upsert into daily_profit_summary
    db.prepare(`
      INSERT INTO daily_profit_summary (date, tenant_id, revenue, cogs, damages, supplier_rebates, interest_expense, diff_value, cash_difference, pv_total, stock_adj, gross_profit, net_profit, sync_id, synced, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT (date, tenant_id)
      DO UPDATE SET
        revenue = excluded.revenue,
        cogs = excluded.cogs,
        damages = excluded.damages,
        supplier_rebates = excluded.supplier_rebates,
        interest_expense = excluded.interest_expense,
        diff_value = excluded.diff_value,
        cash_difference = excluded.cash_difference,
        pv_total = excluded.pv_total,
        stock_adj = excluded.stock_adj,
        gross_profit = excluded.gross_profit,
        net_profit = excluded.net_profit,
        synced = 0,
        updated_at = datetime('now')
    `).run(date, tenantId, revenue, cogs, damages, supplierRebates, interestExpense, diffValue, cashDiff, pvTotal, stockAdj, grossProfit, netProfit, randomUUID());

  } catch (e) {
    console.error('[profit] recalculate error:', e.message);
  }
}

/**
 * reapplyReconciliation
 * After a SIV is created/edited/deleted, re-run reconciliation for each affected product
 * on the SIV date — but ONLY if a daily_actual_balance already exists for that product+date.
 * This keeps POS "In Stock" correct after SIV changes.
 */
function reapplyReconciliation(db, date, productSyncIds, tenantId, branchId, deviceId, userId) {
  try {
    for (const productSyncId of productSyncIds) {
      // Check if actual balance was saved for this product+date
      const actual = db.prepare(
        `SELECT actual_balance, product_id FROM daily_actual_balance WHERE product_sync_id = ? AND date = ? AND deleted_at IS NULL`
      ).get(productSyncId, date);
      if (!actual) continue; // No actual balance saved — skip

      // Delete old reconciliation movement
      db.prepare(
        `UPDATE stock_movements SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
         WHERE product_sync_id = ? AND location = 'sales' AND movement_type = 'reconciliation' AND deleted_at IS NULL`
      ).run(productSyncId);

      // Recalculate natural balance (all non-reconciliation sales movements)
      const natural = db.prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS bal FROM stock_movements
         WHERE product_sync_id = ? AND location = 'sales' AND deleted_at IS NULL`
      ).get(productSyncId);

      const diff = parseFloat(actual.actual_balance) - parseFloat(natural.bal);
      if (Math.abs(diff) > 0.0001) {
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?, ?, 'sales', 'reconciliation', ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`
        ).run(actual.product_id, productSyncId, diff,
              `Reconciliation: actual balance set to ${actual.actual_balance}`,
              userId, randomUUID(), tenantId, branchId, deviceId, date);
      }
    }
  } catch (e) {
    console.error('[reconciliation] reapply error:', e.message);
  }
}

module.exports = { recalculateDailyProfit, reapplyReconciliation };
