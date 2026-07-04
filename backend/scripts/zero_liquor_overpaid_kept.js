/**
 * v1.10.81 — Zero out fabricated `*_overpaid_kept` values on Liquor
 * tenants' daily_profit_summary rows.
 *
 * Why:
 * Prior to v1.10.81, every overpayment recorded on a Liquor tenant was
 * treated as "kept in drawer" because the POS Pay modal has no Change
 * Given input (grep the ref Liquor project — same design). The backend's
 * fallback (`overpaidKeptUSD = change − totalGivenAsUSD = change − 0`)
 * therefore booked the entire change as drawer surplus and bumped
 * daily_profit_summary.usd_overpaid_kept. The Cash Report drawer-net
 * panel then presented these numbers as "shop gain" — a lie.
 *
 * Fix in v1.10.81 skips the classifier server-side, but historical rows
 * already carry non-zero values. This script zeros them.
 *
 * Safety:
 * - Only runs against a tenant DB whose business_settings match the
 *   Liquor recipe (currency_mode='K' AND payment_methods='cash_momo_bank').
 * - Kassumbalesa (USD+FRA+K, cash_only) bails out with a message and
 *   does nothing.
 * - Idempotent — re-runs are a no-op.
 * - Prints before/after totals so the operator can eyeball.
 *
 * HOW TO RUN (VPS):
 *   For each Liquor tenant DB (Lusaka, Mansa):
 *     node backend/scripts/zero_liquor_overpaid_kept.js tenants/lusaka1.db
 *     node backend/scripts/zero_liquor_overpaid_kept.js tenants/mansa1.db
 */

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node zero_liquor_overpaid_kept.js <path/to/tenant.db>');
  process.exit(1);
}

const db = new Database(dbPath);

function main() {
  const bs = db.prepare(
    'SELECT currency_mode, payment_methods FROM business_settings LIMIT 1'
  ).get() || {};
  const ccy = String(bs.currency_mode || '').toUpperCase();
  const pm  = String(bs.payment_methods || '').toLowerCase();
  const isLiquor = ccy === 'K' && pm === 'cash_momo_bank';

  console.log(`Target: ${dbPath}`);
  console.log(`business_settings: currency_mode=${ccy}  payment_methods=${pm}`);
  if (!isLiquor) {
    console.log('\nNot a Liquor tenant — aborting. (Kassumbalesa and HQ untouched.)');
    process.exit(0);
  }
  console.log('Confirmed Liquor tenant.\n');

  // BEFORE
  const before = db.prepare(`
    SELECT
      COUNT(*) AS rows,
      COALESCE(SUM(usd_overpaid_kept), 0) AS usd,
      COALESCE(SUM(fra_overpaid_kept), 0) AS fra,
      COALESCE(SUM(k_overpaid_kept),   0) AS k
    FROM daily_profit_summary
    WHERE (COALESCE(usd_overpaid_kept, 0)
         + COALESCE(fra_overpaid_kept, 0)
         + COALESCE(k_overpaid_kept,   0)) > 0
  `).get();
  console.log(`BEFORE: ${before.rows} rows with non-zero overpaid_kept`);
  console.log(`        USD ${before.usd}  ·  FRA ${before.fra}  ·  K ${before.k}`);

  const info = db.prepare(`
    UPDATE daily_profit_summary
       SET usd_overpaid_kept = 0,
           fra_overpaid_kept = 0,
           k_overpaid_kept   = 0
     WHERE (COALESCE(usd_overpaid_kept, 0)
          + COALESCE(fra_overpaid_kept, 0)
          + COALESCE(k_overpaid_kept,   0)) > 0
  `).run();
  console.log(`\nUpdated: ${info.changes} row(s)`);

  const after = db.prepare(`
    SELECT
      COUNT(*) AS rows,
      COALESCE(SUM(usd_overpaid_kept), 0) AS usd,
      COALESCE(SUM(fra_overpaid_kept), 0) AS fra,
      COALESCE(SUM(k_overpaid_kept),   0) AS k
    FROM daily_profit_summary
    WHERE (COALESCE(usd_overpaid_kept, 0)
         + COALESCE(fra_overpaid_kept, 0)
         + COALESCE(k_overpaid_kept,   0)) > 0
  `).get();
  console.log(`\nAFTER: ${after.rows} rows with non-zero overpaid_kept`);
  console.log(`       USD ${after.usd}  ·  FRA ${after.fra}  ·  K ${after.k}`);
  console.log('\nDone.');
}

main();
