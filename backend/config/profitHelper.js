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

/**
 * writeDailyCostSnapshot — v1.10.220
 * First-write-wins snapshot of avg_cost_price + selling_price per product
 * per date. Uses INSERT OR IGNORE so once a date/product row exists, later
 * calls (which see today's freshly-blended WAC) can never overwrite the
 * cost that was live at the moment of first activity that day.
 *
 * The GRN/production aggregates are DATE-BOUNDED (created_at <= date) so
 * backfills for historical dates don't get contaminated by future GRNs.
 * The three-step fallback: p.avg_cost_price (live WAC when it's set),
 * else the dated aggregate, else p.cost_price.
 *
 * Called at the top of recalculateDailyProfit so every business event
 * (sale, GRN, PV, damage, transit_writeoff, reconciliation, …) auto-locks
 * that day's cost before COGS/damages queries read from dcs.
 *
 * Ported from Redsea v1.13.48.
 */
function writeDailyCostSnapshot(db, date, tenantId) {
  try {
    const rows = db.prepare(`
      SELECT p.id, p.sync_id, p.avg_cost_price, p.cost_price, p.selling_price,
        COALESCE(grn_agg.total_qty, 0)  + COALESCE(prod_agg.total_qty, 0)  AS combined_qty,
        COALESCE(grn_agg.total_cost, 0) + COALESCE(prod_agg.total_cost, 0) AS combined_cost
      FROM products p
      LEFT JOIN (
        SELECT product_sync_id,
               SUM(quantity) AS total_qty, SUM(total_price) AS total_cost
        FROM grn_items
        WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
          AND date(created_at) <= ?
        GROUP BY product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id,
               SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost
        FROM production_outputs
        WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
          AND date(created_at) <= ?
        GROUP BY product_sync_id
      ) prod_agg ON prod_agg.product_sync_id = p.sync_id
      WHERE p.deleted_at IS NULL AND p.tenant_id = ?
    `).all(date, date, tenantId);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO daily_cost_snapshot
        (product_id, product_sync_id, date, avg_cost_price, selling_price,
         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `);

    db.transaction(() => {
      for (const p of rows) {
        const live = parseFloat(p.avg_cost_price) || 0;
        const dated = (p.combined_qty > 0)
          ? parseFloat(p.combined_cost) / parseFloat(p.combined_qty)
          : 0;
        const cost = live > 0 ? live : (dated > 0 ? dated : (parseFloat(p.cost_price) || 0));
        insert.run(
          p.id, p.sync_id, date, cost, parseFloat(p.selling_price) || 0,
          randomUUID(), tenantId, null, null
        );
      }
    })();
  } catch (e) {
    console.error('[dcs.write] failed:', e.message);
  }
}

function recalculateDailyProfit(db, date, tenantId) {
  try {
    // v1.10.220 — lock cost for this date BEFORE reading COGS/damages. Any
    // event that would trigger a recalc (sale, GRN, PV, damage, recon, …)
    // now auto-snapshots the date. INSERT OR IGNORE means the very first
    // event of the date wins; later events for the same date leave the
    // frozen cost alone. Result: historical dates become tamper-proof
    // to later cost changes without needing a per-sale cost_at_sale column.
    writeDailyCostSnapshot(db, date, tenantId);

    // Revenue: total sales billed today (accrual — includes credit sales whether paid or not).
    // Cash actually collected is tracked separately in the Cash Report.
    const revRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE DATE(created_at) = ? AND deleted_at IS NULL AND tenant_id = ?
        AND (status IS NULL OR status != 'Reversed')
    `).get(date, tenantId);

    // COGS: sale movements × snapshotted cost price
    // v1.10.181 — WAC redesign push 4 (profit-side): add p.avg_cost_price
    // to the fallback chain, right after the historical daily_cost_snapshot.
    // The v1.10.55 blend writes today's WAC to products.avg_cost_price;
    // before this fix, the read chain skipped it entirely and fell back
    // to either the frozen snapshot (for old dates), a live grn_items
    // aggregate, or the static cost_price — none of which reflect a
    // fresh WAC blend from a recent GRN.
    //
    // Ordering rationale:
    //   1. dcs.avg_cost_price — historical accuracy for OLD dates
    //   2. p.avg_cost_price   — live WAC for RECENT dates before dcs snapshot fires
    //   3. grn_items aggregate — approximation for products with no stored WAC yet
    //   4. p.cost_price       — static hint, last resort
    // NULLIF drops p.avg_cost_price=0 so we fall through when it was never
    // written (fresh product) instead of anchoring COGS at zero.
    // v1.10.215 — two fixes to same-day order reversals:
    //   (a) filter was IN ('sale', 'reverse'). The literal 'reverse' is a
    //       ghost — no code path writes it; the actual reverse movement
    //       type is 'sale_reverse' (orders.js:1235). So reversals were
    //       silently ignored, leaving the original sale's cost phantom
    //       in COGS with no offset. Filter now IN ('sale', 'sale_reverse').
    //   (b) formula was SUM(ABS(qty) * cost). Once sale_reverse is in the
    //       filter, ABS would ADD the reversal's cost instead of subtracting
    //       it. Replaced with SUM(-qty * cost): sale (qty<0) yields +cost,
    //       sale_reverse (qty>0) yields -cost — same-day sale + reverse
    //       nets to 0, matching the revenue side.
    // v1.10.221 — cost fallback now starts with sm.cost_at_sale (the WAC
    // frozen at the MOMENT of the sale by trigger trg_stamp_cost_at_sale).
    // Fully immune to later WAC changes — even mid-day GRN blends. Fallbacks
    // (in order): frozen sale cost → dcs snapshot → live avg_cost_price →
    // dated GRN aggregate → live p.cost_price. Ported from Redsea v1.13.49.
    const cogsRow = db.prepare(`
      SELECT COALESCE(SUM(-sm.quantity *
        COALESCE(sm.cost_at_sale, dcs.avg_cost_price, NULLIF(p.avg_cost_price, 0),
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
      WHERE sm.location = 'sales' AND sm.movement_type IN ('sale', 'sale_reverse')
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(date, date, tenantId);

    // Diff: mirrors exactly what the frontend computes per row:
    // difference = actual_balance - (opening_balance + input - total_sales - total_returns)
    // totalDiff  = SUM(difference × avg_cost_price)
    // Cash difference (drawer over / short for the day).
    // v1.10.222 — for K-only branches (Liquor-style: Lusaka1/Mansa1),
    // compute the difference live from the raw fields, matching the
    // Cash Report / Report History display formula exactly:
    //   total = cash + mobile_money + bank + pending + expenses
    //   diff  = total − expected
    // The stored `difference` column is legacy USD-bucket math left over
    // from an older save version; it drops MoMo + Bank entirely on K-only
    // branches, producing wildly negative diffs even when the drawer
    // balanced (e.g. Lusaka1 2026-07-17: stored −K60,433, real +K40).
    // Tri-currency branches (Kassumbalesa1) keep using the stored
    // `difference` — it's already correct in USD terms.
    //
    // Mirrors frontend/src/pages/CashReport.js:1795-1804.
    // v1.10.223 — SUM across all cash_reports rows for the date. Some
    // dates have multiple reports (one per cashier); prior version used
    // .get() which returned only the first row, silently dropping every
    // cashier after the first. Cash Report's own top-tile totals sum
    // across ALL reports (CashReport.js:1631-1641), so we now match.
    const cashRow = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN (SELECT currency_mode FROM business_settings LIMIT 1)
               NOT IN ('USD+FRA','USD+FRA+K')
            THEN (COALESCE(usd_received,0) + COALESCE(fra_received,0) + COALESCE(k_received,0)
                + COALESCE(pending,0)
                + COALESCE(usd_expenses,0) + COALESCE(fra_expenses,0) + COALESCE(k_expenses,0))
               - COALESCE(expected, 0)
          ELSE difference
        END
      ), 0) AS cash_difference
      FROM cash_reports WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(date, tenantId);

    // Expenses for the day (Payment Vouchers).
    // v1.10.182 — exclude Landed Cost Vouchers. LCVs are cash outflows
    // that get absorbed into inventory WAC at Generate GRN time; counting
    // them as expenses ALSO would double-count them (once in COGS via
    // WAC, once as period expense). Landed cost is the "asset transfer"
    // case: cash → inventory, no P&L impact until the item sells.
    const pvRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS pv_total
      FROM payment_vouchers
       WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
         AND (is_landed_cost IS NULL OR is_landed_cost = 0)
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
    // v1.10.181 — same fallback-chain fix as COGS above. p.avg_cost_price
    // sits between the historical snapshot and the grn_items aggregate so
    // the WAC blend that hqGrns.js /generate wrote actually reaches the
    // damage cost calculation.
    // v1.10.221 — damages: prefer sm.cost_at_sale (frozen on the movement
    // by trigger trg_stamp_cost_at_sale) before falling through to dcs and
    // the live/dated aggregates. Ensures a Sales Damages / transit_writeoff
    // recorded today can't retroactively re-cost when the product's live
    // WAC changes tomorrow.
    const damageRow = db.prepare(`
      SELECT COALESCE(SUM(ABS(sm.quantity) *
        COALESCE(sm.cost_at_sale, dcs.avg_cost_price, NULLIF(p.avg_cost_price, 0),
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
      -- v1.10.219 — include transit_writeoff (Option C: HQ resolves a Transit
      -- Variance as WRITE_OFF and the loss lands on the chosen branch's
      -- damages line). Written by hq.js with location='books_only' so it's
      -- invisible to inventory sums but visible here — drop the location
      -- filter for the writeoff type so it's picked up regardless.
      WHERE ((sm.location = 'sales' AND sm.movement_type = 'sales_return')
             OR sm.movement_type = 'transit_writeoff')
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

      // v1.10.24 — roll the old reconciliation off current_stock before deleting it.
      const oldRec = db.prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS net FROM stock_movements
          WHERE product_sync_id = ? AND location = 'sales'
            AND movement_type = 'reconciliation' AND deleted_at IS NULL`
      ).get(productSyncId).net;
      if (oldRec && Math.abs(oldRec) > 0.0001) {
        db.prepare(
          `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
        ).run(oldRec, productSyncId);
      }
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
        // v1.10.24 — apply new reconciliation delta to current_stock.
        db.prepare(
          `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
        ).run(diff, productSyncId);
      }
    }
  } catch (e) {
    console.error('[reconciliation] reapply error:', e.message);
  }
}

module.exports = { recalculateDailyProfit, reapplyReconciliation, writeDailyCostSnapshot };
