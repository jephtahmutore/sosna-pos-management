/**
 * retrofit-lusaka1-wac-fixes.js — clean up two WAC data corruptions on
 * lusaka1 discovered after the BLACK LABEL 750 ML crate-unit retrofit.
 *
 * ── Issue 1: BLACK LABEL 375ML — cost typo on HQP-2026-C0AB98-0035
 *    Cost typed K3,200 per crate instead of K320 (extra zero). Aug 6 GRN
 *    alone dumped K320,000 into WAC. Two neighbouring purchases at K320
 *    were correct. Fix: correct the one bad line on master.db
 *    (hq_purchase_items + hq_grn_items), then rebuild WAC by walking
 *    stock_movements.
 *
 * ── Issue 2: CRONIER — WAC stored at K800/pcs (should be K133.33/pcs)
 *    Data on hq_purchase_items IS correct: 54 Box × K800/Box. Stock
 *    movement is correctly +324 pcs (54 × 6 conv). Yet
 *    products.avg_cost_price landed at K800 instead of K133.33. The
 *    current code (hqGrns.js /generate line 1619-1635) correctly divides
 *    by conversionToBase — so this looks like a residue from an older
 *    version (pre-v1.10.66 shipped the raw-qty bug). Fix: rebuild WAC.
 *
 * Both fixes done in one transaction per DB, with dry-run + assertions.
 *
 * Money totals (line_total, total_price for CRONIER) are left alone —
 * they already match the invoice.
 *
 * Usage on VPS (backup first):
 *   cp /var/www/sosna-pos-tenant/master.db /var/www/sosna-pos-tenant/master.db.bak-$(date +%Y%m%d-%H%M)
 *   cp /var/www/sosna-pos-tenant/tenants/lusaka1.db /var/www/sosna-pos-tenant/tenants/lusaka1.db.bak-$(date +%Y%m%d-%H%M)
 *   node /var/www/sosna-pos-tenant/backend/scripts/retrofit-lusaka1-wac-fixes.js --dry
 *   node /var/www/sosna-pos-tenant/backend/scripts/retrofit-lusaka1-wac-fixes.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const MASTER_DB   = process.env.SOSNA_MASTER_DB   || '/var/www/sosna-pos-tenant/master.db';
const LUSAKA1_DB  = process.env.SOSNA_LUSAKA1_DB  || '/var/www/sosna-pos-tenant/tenants/lusaka1.db';
const dryRun      = process.argv.includes('--dry');

const master = new Database(MASTER_DB);
const branch = new Database(LUSAKA1_DB);

console.log('='.repeat(70));
console.log(`Lusaka1 WAC fixes (BLACK LABEL 375ML + CRONIER)  |  ${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log('='.repeat(70));

// ─────────────────────────────────────────────────────────────────────
// Shared: rebuild WAC for one product by walking stock_movements
// chronologically. Only grn / hq_grn positive movements blend into WAC.
// Cost per base unit comes from grn_items (branch grn) or hq_grn_items
// (master.db).
// ─────────────────────────────────────────────────────────────────────
function rebuildWac(productSyncId) {
  const movements = branch.prepare(`
    SELECT sm.id, sm.movement_type, sm.reference_type, sm.reference_sync_id,
           sm.quantity, sm.created_at
    FROM stock_movements sm
    WHERE sm.product_sync_id = ?
      AND sm.deleted_at IS NULL
      AND sm.movement_type != 'opening'
    ORDER BY sm.created_at ASC, sm.id ASC
  `).all(productSyncId);

  let stock = 0;
  let avg = 0;
  for (const m of movements) {
    const q = parseFloat(m.quantity) || 0;
    if ((m.movement_type === 'grn' || m.movement_type === 'hq_grn') && q > 0) {
      let totalCost = 0;
      if (m.reference_type === 'hq_grn') {
        const row = master.prepare(`
          SELECT total_price FROM hq_grn_items
          WHERE grn_sync_id = ? AND product_sync_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(m.reference_sync_id, productSyncId);
        totalCost = row ? parseFloat(row.total_price) || 0 : 0;
      } else {
        const row = branch.prepare(`
          SELECT total_price FROM grn_items
          WHERE grn_sync_id = ? AND product_sync_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(m.reference_sync_id, productSyncId);
        totalCost = row ? parseFloat(row.total_price) || 0 : 0;
      }
      if (totalCost > 0 && q > 0) {
        const perBase = totalCost / q;
        if (stock <= 0 || avg <= 0) avg = perBase;
        else avg = (stock * avg + q * perBase) / (stock + q);
      }
    }
    stock += q;
  }
  return { finalStock: stock, finalAvg: avg };
}

function reStampDcs(productSyncId, avg, fromDate) {
  try {
    const r = branch.prepare(`
      UPDATE daily_cost_snapshot
         SET avg_cost_price = ?, updated_at = datetime('now'), synced = 0
       WHERE product_sync_id = ? AND date >= ?
    `).run(avg, productSyncId, fromDate);
    return r.changes;
  } catch (_) { return 0; }
}

// ─────────────────────────────────────────────────────────────────────
// Issue 1: BLACK LABEL 375ML cost typo
// ─────────────────────────────────────────────────────────────────────
const BAD_PO_NUM   = 'HQP-2026-C0AB98-0035';
const BL375_SYNC   = branch.prepare(`SELECT sync_id FROM products WHERE name = 'BLACK LABEL 375ML' LIMIT 1`).get()?.sync_id;
if (!BL375_SYNC) throw new Error('BLACK LABEL 375ML product not found on lusaka1');
const BL375_BAD_LINE = master.prepare(`
  SELECT i.id, i.cost_price, i.line_total, i.dispatched_qty, i.product_sync_id
  FROM hq_purchase_items i
  JOIN hq_purchases p ON p.id = i.purchase_id
  WHERE p.purchase_number = ?
    AND i.product_name LIKE 'BLACK LABEL 375%'
    AND i.status != 'CANCELLED'
`).get(BAD_PO_NUM);
if (!BL375_BAD_LINE) throw new Error(`Bad line on ${BAD_PO_NUM} not found`);
if (BL375_BAD_LINE.cost_price !== 3200) {
  console.log(`⚠ HQP-...0035 cost is ${BL375_BAD_LINE.cost_price}, expected 3200. Already fixed? Skipping BL375 pass.`);
}
const BL375_NEW_COST = 320;
const BL375_NEW_TOTAL = BL375_NEW_COST * BL375_BAD_LINE.dispatched_qty;
// Matching hq_grn_items row (linked GRN)
const BL375_GRN_ITEM = master.prepare(`
  SELECT gi.id, gi.grn_sync_id, gi.unit_price, gi.total_price
  FROM hq_grn_items gi
  JOIN hq_grns g ON g.sync_id = gi.grn_sync_id
  WHERE g.po_sync_id = (SELECT sync_id FROM hq_purchases WHERE purchase_number = ?)
    AND gi.product_sync_id = ?
    AND g.deleted_at IS NULL
  LIMIT 1
`).get(BAD_PO_NUM, BL375_BAD_LINE.product_sync_id);

// ─────────────────────────────────────────────────────────────────────
// Issue 2: CRONIER WAC rebuild
// ─────────────────────────────────────────────────────────────────────
const CRONIER_SYNC = branch.prepare(`SELECT sync_id, avg_cost_price FROM products WHERE name = 'CRONIER' LIMIT 1`).get();
if (!CRONIER_SYNC) throw new Error('CRONIER product not found on lusaka1');

// ── Plan + predicted values ──────────────────────────────────────────
console.log(`\n── PLAN ─────────────────────────────────────────────────────────`);

console.log(`\n[A] BLACK LABEL 375ML cost typo fix on ${BAD_PO_NUM}`);
console.log(`    hq_purchase_items(id=${BL375_BAD_LINE.id}):`);
console.log(`        cost_price   ${BL375_BAD_LINE.cost_price} → ${BL375_NEW_COST}`);
console.log(`        line_total   ${BL375_BAD_LINE.line_total} → ${BL375_NEW_TOTAL}`);
if (BL375_GRN_ITEM) {
  console.log(`    hq_grn_items(id=${BL375_GRN_ITEM.id}):`);
  console.log(`        unit_price   ${BL375_GRN_ITEM.unit_price} → ${BL375_NEW_COST}`);
  console.log(`        total_price  ${BL375_GRN_ITEM.total_price} → ${BL375_NEW_TOTAL}`);
} else {
  console.log(`    (no linked hq_grn_items row found — GRN maybe not generated yet or void)`);
}

// Simulate BL375 WAC AFTER the master.db fix by patching in-memory
// (peek: temporarily update, run, revert if dry-run)
function simulateBl375() {
  // Because the fix touches hq_grn_items on master.db, we do a temp
  // update inside a transaction that always rolls back, so simulation
  // is safe.
  const preserveTotal = BL375_GRN_ITEM?.total_price;
  const preserveUnit  = BL375_GRN_ITEM?.unit_price;
  if (BL375_GRN_ITEM) {
    master.exec('BEGIN');
    master.prepare(`UPDATE hq_grn_items SET total_price = ?, unit_price = ? WHERE id = ?`)
      .run(BL375_NEW_TOTAL, BL375_NEW_COST, BL375_GRN_ITEM.id);
  }
  const r = rebuildWac(BL375_SYNC);
  if (BL375_GRN_ITEM) master.exec('ROLLBACK');
  return r;
}
const bl375Sim = simulateBl375();
const bl375PrevWac = branch.prepare(`SELECT avg_cost_price FROM products WHERE sync_id = ?`).get(BL375_SYNC)?.avg_cost_price;
console.log(`    products.avg_cost_price (per Bottle): ${bl375PrevWac} → ${bl375Sim.finalAvg.toFixed(4)}`);
console.log(`    per crate (×24)                     : ${(bl375PrevWac*24).toFixed(2)} → ${(bl375Sim.finalAvg*24).toFixed(2)}`);

console.log(`\n[B] CRONIER WAC rebuild`);
const cronierSim = rebuildWac(CRONIER_SYNC.sync_id);
console.log(`    products.avg_cost_price (per pcs): ${CRONIER_SYNC.avg_cost_price} → ${cronierSim.finalAvg.toFixed(4)}`);
console.log(`    per Box (×6)                     : ${(CRONIER_SYNC.avg_cost_price*6).toFixed(2)} → ${(cronierSim.finalAvg*6).toFixed(2)}`);

if (dryRun) {
  console.log(`\n── DRY RUN — no changes written ─────────────────────────────────`);
  process.exit(0);
}

// ── LIVE ─────────────────────────────────────────────────────────────
console.log(`\n── EXECUTING ────────────────────────────────────────────────────`);

master.transaction(() => {
  if (BL375_BAD_LINE.cost_price === 3200) {
    master.prepare(`
      UPDATE hq_purchase_items SET cost_price = ?, line_total = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?
    `).run(BL375_NEW_COST, BL375_NEW_TOTAL, BL375_BAD_LINE.id);
    console.log(`  [A1] hq_purchase_items cost fixed on ${BAD_PO_NUM}`);
  } else {
    console.log(`  [A1] skipped (already fixed)`);
  }
  if (BL375_GRN_ITEM && BL375_GRN_ITEM.total_price === 320000) {
    master.prepare(`
      UPDATE hq_grn_items SET unit_price = ?, total_price = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?
    `).run(BL375_NEW_COST, BL375_NEW_TOTAL, BL375_GRN_ITEM.id);
    console.log(`  [A2] hq_grn_items cost fixed`);
  } else {
    console.log(`  [A2] skipped (already fixed or no linked GRN)`);
  }
})();

branch.transaction(() => {
  const bl375Final = rebuildWac(BL375_SYNC);
  branch.prepare(`
    UPDATE products SET avg_cost_price = ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?
  `).run(bl375Final.finalAvg, BL375_SYNC);
  console.log(`  [A3] BL375ML avg_cost_price → ${bl375Final.finalAvg.toFixed(4)}/Bottle`);
  const bl375Dcs = reStampDcs(BL375_SYNC, bl375Final.finalAvg, '2026-08-06');
  console.log(`  [A4] BL375ML daily_cost_snapshot re-stamped (${bl375Dcs} rows on/after 2026-08-06)`);

  const cronierFinal = rebuildWac(CRONIER_SYNC.sync_id);
  branch.prepare(`
    UPDATE products SET avg_cost_price = ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?
  `).run(cronierFinal.finalAvg, CRONIER_SYNC.sync_id);
  console.log(`  [B1] CRONIER avg_cost_price → ${cronierFinal.finalAvg.toFixed(4)}/pcs`);
  const cronierDcs = reStampDcs(CRONIER_SYNC.sync_id, cronierFinal.finalAvg, '2026-08-20');
  console.log(`  [B2] CRONIER daily_cost_snapshot re-stamped (${cronierDcs} rows on/after 2026-08-20)`);
})();

// ── Post-check ───────────────────────────────────────────────────────
console.log(`\n── POST-CHECK ───────────────────────────────────────────────────`);
const post375 = branch.prepare(`SELECT avg_cost_price FROM products WHERE sync_id = ?`).get(BL375_SYNC);
const postCr  = branch.prepare(`SELECT avg_cost_price FROM products WHERE sync_id = ?`).get(CRONIER_SYNC.sync_id);
console.log(`  BLACK LABEL 375ML avg_cost_price now: ${post375.avg_cost_price} (per Bottle) = ${(post375.avg_cost_price*24).toFixed(2)}/crate`);
console.log(`  CRONIER           avg_cost_price now: ${postCr.avg_cost_price}  (per pcs)    = ${(postCr.avg_cost_price*6).toFixed(2)}/Box`);
console.log(`\n✓ DONE — hard-refresh Sosna Lusaka1 → Item Details to verify.`);
