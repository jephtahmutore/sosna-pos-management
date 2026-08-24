/**
 * retrofit-black-label-750-unit.js — one-shot fix for HQP-2026-C0AB98-0064
 *
 * Root cause: BLACK LABEL 750 ML was dispatched with unit='crates' (typo)
 * but the product's real units are Bottle (base) + Box (conv 12). The
 * system had no packaging match, treated qty=50 as BASE units → stored
 * 50 Bottles instead of the intended 50 Box × 12 = 600 Bottles.
 *
 * Impact:
 *   - lusaka1 stock understated by 550 Bottles
 *   - lusaka1 avg_cost_price inflated 12x ($270.60/Bottle vs correct ~$22.55)
 *   - COGS on every Bottle sold since 2026-08-20 recorded at 12x reality
 *     → profit under-reported. Sosna uses LIVE WAC (no cost_at_sale
 *     column on order_items) so once WAC is corrected the current
 *     Sales/Profit reports read the right number retroactively. Historical
 *     daily_cost_snapshot rows for Aug 20-24 are stamped with the wrong
 *     WAC — script recomputes them at the end.
 *
 * Fixes (all in one transaction per DB):
 *   1. master.hq_purchase_items.unit  'crates' → 'Box'
 *   2. master.hq_grn_items.unit       'crates' → 'Box'
 *   3. lusaka1.stock_movements(5806).quantity  50 → 600
 *   4. lusaka1.products.avg_cost_price recomputed by walking movements
 *   5. lusaka1.daily_cost_snapshot rows for the product on 2026-08-20+
 *      re-stamped from the corrected running WAC
 *
 * Money totals (hq_purchase_items.line_total, hq_grn_items.total_price,
 * hq_grns.items_subtotal / final_payable) are ALREADY correct — the
 * user typed cost 270.60 per Box and 50 × 270.60 = 13,530. No money
 * fields need touching.
 *
 * Usage on VPS (BACK UP FIRST):
 *   cp /var/www/sosna-pos-tenant/master.db /var/www/sosna-pos-tenant/master.db.bak-$(date +%Y%m%d-%H%M)
 *   cp /var/www/sosna-pos-tenant/tenants/lusaka1.db /var/www/sosna-pos-tenant/tenants/lusaka1.db.bak-$(date +%Y%m%d-%H%M)
 *   node /var/www/sosna-pos-tenant/backend/scripts/retrofit-black-label-750-unit.js --dry
 *   node /var/www/sosna-pos-tenant/backend/scripts/retrofit-black-label-750-unit.js
 *
 * Paths are hardcoded to the VPS layout; run from anywhere.
 */
const path = require('path');
const Database = require('better-sqlite3');

const MASTER_DB   = process.env.SOSNA_MASTER_DB   || '/var/www/sosna-pos-tenant/master.db';
const LUSAKA1_DB  = process.env.SOSNA_LUSAKA1_DB  || '/var/www/sosna-pos-tenant/tenants/lusaka1.db';

const dryRun = process.argv.includes('--dry');

const PURCHASE_NUM = 'HQP-2026-C0AB98-0064';
const GRN_SYNC_ID  = '4815084c-94cf-422e-9773-66fcf7b11376';
const PRODUCT_SYNC = '9c31c1eb-a220-45ea-8448-15c82b226e3c';
const MOVEMENT_ID  = 5806;
const BAD_QTY      = 50;
const BOX_CONV     = 12;   // 1 Box = 12 Bottles (from products.units_json)
const NEW_QTY      = BAD_QTY * BOX_CONV;   // 600 Bottles
const BAD_UNIT     = 'crates';
const NEW_UNIT     = 'Box';

console.log('='.repeat(70));
console.log(`BLACK LABEL 750 ML unit retrofit  |  ${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log('='.repeat(70));

const master = new Database(MASTER_DB);
const branch = new Database(LUSAKA1_DB);

// ── Preflight ────────────────────────────────────────────────────────
const hqItem = master.prepare(`
  SELECT i.id, i.unit, i.dispatched_qty, i.cost_price, i.line_total
  FROM hq_purchase_items i
  JOIN hq_purchases p ON p.id = i.purchase_id
  WHERE p.purchase_number = ? AND i.product_name LIKE '%BLACK LABEL 750%'
`).get(PURCHASE_NUM);
if (!hqItem) throw new Error(`hq_purchase_items row not found for ${PURCHASE_NUM}/BLACK LABEL 750`);
if (hqItem.unit !== BAD_UNIT) {
  console.log(`⚠ hq_purchase_items.unit is "${hqItem.unit}" (expected "${BAD_UNIT}"). Already fixed? Aborting to avoid double-fix.`);
  process.exit(hqItem.unit === NEW_UNIT ? 0 : 2);
}

const hqGrnItem = master.prepare(`
  SELECT id, unit, quantity, unit_price, total_price
  FROM hq_grn_items WHERE grn_sync_id = ? AND product_sync_id = ?
`).get(GRN_SYNC_ID, PRODUCT_SYNC);
if (!hqGrnItem) throw new Error('hq_grn_items row not found');
if (hqGrnItem.unit !== BAD_UNIT) {
  console.log(`⚠ hq_grn_items.unit is "${hqGrnItem.unit}" (expected "${BAD_UNIT}"). Aborting.`);
  process.exit(2);
}

const sm = branch.prepare('SELECT id, quantity, location, movement_type FROM stock_movements WHERE id = ?').get(MOVEMENT_ID);
if (!sm) throw new Error(`stock_movements id=${MOVEMENT_ID} not found`);
if (sm.quantity !== BAD_QTY) {
  console.log(`⚠ stock_movements(${MOVEMENT_ID}).quantity is ${sm.quantity} (expected ${BAD_QTY}). Already fixed? Aborting.`);
  process.exit(sm.quantity === NEW_QTY ? 0 : 2);
}

const prod = branch.prepare('SELECT id, name, unit, avg_cost_price FROM products WHERE sync_id = ? AND deleted_at IS NULL').get(PRODUCT_SYNC);
if (!prod) throw new Error('Product not found on lusaka1');

console.log(`\nBefore:`);
console.log(`  hq_purchase_items.unit       = "${hqItem.unit}"   dispatched_qty=${hqItem.dispatched_qty}  line_total=${hqItem.line_total}`);
console.log(`  hq_grn_items.unit            = "${hqGrnItem.unit}"   quantity=${hqGrnItem.quantity}  total_price=${hqGrnItem.total_price}`);
console.log(`  stock_movements(${MOVEMENT_ID}).quantity  = ${sm.quantity} (base=${prod.unit})   location=${sm.location}`);
console.log(`  products.avg_cost_price      = ${prod.avg_cost_price}  (per ${prod.unit})`);

console.log(`\nPlan:`);
console.log(`  1. hq_purchase_items.unit  "${BAD_UNIT}" → "${NEW_UNIT}"`);
console.log(`  2. hq_grn_items.unit       "${BAD_UNIT}" → "${NEW_UNIT}"`);
console.log(`  3. stock_movements(${MOVEMENT_ID}).quantity  ${BAD_QTY} → ${NEW_QTY}  (50 Box × 12 = 600 Bottles)`);
console.log(`  4. products.avg_cost_price → recomputed from full movement history`);
console.log(`  5. daily_cost_snapshot rows for product on 2026-08-20+ → re-stamped`);

// ── Compute what WAC WILL be after the fix ───────────────────────────
// Walk stock_movements chronologically. Only movement_type='grn' with
// qty>0 blends into WAC. All others just change stock. Cost per base
// unit comes from hq_grn_items.total_price for hq_grn movements (via
// join on reference_sync_id → hq_grn_items) OR from grn_items for
// branch-side 'grn' movements.
function simulateWac() {
  const movements = branch.prepare(`
    SELECT sm.id, sm.movement_type, sm.reference_type, sm.reference_sync_id,
           sm.quantity, sm.created_at
    FROM stock_movements sm
    WHERE sm.product_sync_id = ?
      AND sm.deleted_at IS NULL
      AND sm.movement_type != 'opening'
    ORDER BY sm.created_at ASC, sm.id ASC
  `).all(PRODUCT_SYNC);

  let stock = 0;
  let avg = 0;
  for (const m of movements) {
    // Simulate the corrected qty for movement 5806
    const q = (m.id === MOVEMENT_ID) ? NEW_QTY : parseFloat(m.quantity) || 0;
    // For grn moves, look up cost from hq_grn_items or grn_items
    if ((m.movement_type === 'grn' || m.movement_type === 'hq_grn') && q > 0) {
      // hq_grn_items is on master.db, branch's grn_items on branch DB
      let totalCost = 0;
      if (m.reference_type === 'hq_grn') {
        const row = master.prepare(`
          SELECT total_price, quantity FROM hq_grn_items
          WHERE grn_sync_id = ? AND product_sync_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(m.reference_sync_id, PRODUCT_SYNC);
        totalCost = row ? parseFloat(row.total_price) || 0 : 0;
      } else {
        const row = branch.prepare(`
          SELECT total_price, quantity FROM grn_items
          WHERE grn_sync_id = ? AND product_sync_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(m.reference_sync_id, PRODUCT_SYNC);
        totalCost = row ? parseFloat(row.total_price) || 0 : 0;
      }
      if (totalCost > 0 && q > 0) {
        const newCostPerBase = totalCost / q;
        if (stock <= 0 || avg <= 0) {
          avg = newCostPerBase;
        } else {
          avg = (stock * avg + q * newCostPerBase) / (stock + q);
        }
      }
    }
    stock += q;
  }
  return { finalStock: stock, finalAvg: avg };
}

const sim = simulateWac();
console.log(`\nPredicted after fix:`);
console.log(`  Final stock  = ${sim.finalStock.toFixed(2)} ${prod.unit}`);
console.log(`  Final WAC    = ${sim.finalAvg.toFixed(4)} per ${prod.unit}  (was ${prod.avg_cost_price})`);
console.log(`  Per Box      ≈ ${(sim.finalAvg * BOX_CONV).toFixed(2)} (× ${BOX_CONV} conv)`);

if (dryRun) {
  console.log(`\n── DRY RUN — no changes written ─────────────────────────────────`);
  process.exit(0);
}

// ── LIVE ─────────────────────────────────────────────────────────────
console.log(`\n── EXECUTING ────────────────────────────────────────────────────`);

master.transaction(() => {
  const r1 = master.prepare(`
    UPDATE hq_purchase_items SET unit = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?
  `).run(NEW_UNIT, hqItem.id);
  console.log(`  [1] hq_purchase_items unit → "${NEW_UNIT}"  (${r1.changes} row)`);
  const r2 = master.prepare(`
    UPDATE hq_grn_items SET unit = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?
  `).run(NEW_UNIT, hqGrnItem.id);
  console.log(`  [2] hq_grn_items unit → "${NEW_UNIT}"  (${r2.changes} row)`);
})();

branch.transaction(() => {
  const r3 = branch.prepare(`
    UPDATE stock_movements SET quantity = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?
  `).run(NEW_QTY, MOVEMENT_ID);
  console.log(`  [3] stock_movements(${MOVEMENT_ID}).quantity → ${NEW_QTY}  (${r3.changes} row)`);

  // Re-simulate & write the corrected WAC
  const finalSim = simulateWac();
  const r4 = branch.prepare(`
    UPDATE products SET avg_cost_price = ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?
  `).run(finalSim.finalAvg, PRODUCT_SYNC);
  console.log(`  [4] products.avg_cost_price → ${finalSim.finalAvg.toFixed(4)}  (${r4.changes} row)`);

  // Re-stamp daily_cost_snapshot rows on 2026-08-20+
  try {
    const dcs = branch.prepare(`
      UPDATE daily_cost_snapshot
         SET avg_cost_price = ?, updated_at = datetime('now'), synced = 0
       WHERE product_sync_id = ? AND date >= '2026-08-20'
    `).run(finalSim.finalAvg, PRODUCT_SYNC);
    console.log(`  [5] daily_cost_snapshot rows re-stamped  (${dcs.changes} rows on/after 2026-08-20)`);
  } catch (e) {
    console.log(`  [5] daily_cost_snapshot table missing/incompatible — skipped (${e.message})`);
  }
})();

// ── Post-check ───────────────────────────────────────────────────────
console.log(`\n── POST-CHECK ───────────────────────────────────────────────────`);
const post = branch.prepare('SELECT avg_cost_price FROM products WHERE sync_id = ?').get(PRODUCT_SYNC);
console.log(`  products.avg_cost_price now: ${post.avg_cost_price}`);
console.log(`  Predicted per-Box:           ~${(post.avg_cost_price * BOX_CONV).toFixed(2)}`);
const postSm = branch.prepare('SELECT quantity FROM stock_movements WHERE id = ?').get(MOVEMENT_ID);
console.log(`  stock_movements(${MOVEMENT_ID}).quantity now: ${postSm.quantity}`);
console.log(`\n✓ DONE — hard-refresh Sosna in the browser to see the corrected WAC + stock`);
