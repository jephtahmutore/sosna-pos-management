/**
 * cashPoolHelper.js — v1.10.180 (Phase 2b of the HQ Cash Book rework)
 *
 * Keeps the three K-pool counters on business_settings in sync with every
 * K-affecting Cash Book transaction. Backfill (migrations.js v1.10.179)
 * seeded the counters from history; this helper takes over from there.
 *
 *   pool_native_k    — K that came in from customer sales (no USD basis)
 *   pool_exchange_k  — K that came in from USD→K exchanges (still in pool)
 *   pool_usd_basis   — USD spent to acquire pool_exchange_k
 *
 * Blended acquisition rate = pool_exchange_k / pool_usd_basis.
 *
 * Rules:
 *   - K inflow from a sale (CR, HQ Deposit) → poolInflowNative
 *   - K inflow from an exchange (USD→K)     → poolInflowExchange
 *   - K outflow (PV, AP, K→USD, delete)     → poolDrainK (pro-rata)
 *
 * Every call MUST run inside the same db.transaction() that writes the
 * ledger row, so a ledger rollback also rolls back the pool change.
 *
 * All updates are clamped with MAX(0, ...) — accumulated rounding can't
 * push a counter below zero.
 */

function getSettingsId(db) {
  const row = db.prepare(
    `SELECT id FROM business_settings ORDER BY id ASC LIMIT 1`
  ).get();
  return row ? row.id : null;
}

/**
 * Add native K to the pool (customer sale in K).
 */
function poolInflowNative(db, kIn) {
  const amt = parseFloat(kIn || 0) || 0;
  if (amt <= 0) return;
  const id = getSettingsId(db);
  if (!id) return;
  db.prepare(`
    UPDATE business_settings
       SET pool_native_k = MAX(0, pool_native_k + ?)
     WHERE id = ?
  `).run(amt, id);
}

/**
 * Add exchange K to the pool (USD→K conversion).
 * Records both the K received and the USD spent to acquire it.
 */
function poolInflowExchange(db, kIn, usdSpent) {
  const kAmt   = parseFloat(kIn      || 0) || 0;
  const usdAmt = parseFloat(usdSpent || 0) || 0;
  if (kAmt <= 0 || usdAmt <= 0) return;
  const id = getSettingsId(db);
  if (!id) return;
  db.prepare(`
    UPDATE business_settings
       SET pool_exchange_k = MAX(0, pool_exchange_k + ?),
           pool_usd_basis  = MAX(0, pool_usd_basis  + ?)
     WHERE id = ?
  `).run(kAmt, usdAmt, id);
}

/**
 * Drain K from the pool (PV, AP, K→USD exchange).
 * Reads the current pool state and reduces native + exchange + usd_basis
 * proportionally so the blended rate holds through the outflow.
 */
function poolDrainK(db, kOut) {
  const amt = parseFloat(kOut || 0) || 0;
  if (amt <= 0) return;
  const row = db.prepare(
    `SELECT id, pool_native_k, pool_exchange_k, pool_usd_basis
       FROM business_settings ORDER BY id ASC LIMIT 1`
  ).get();
  if (!row) return;
  const nativeK   = parseFloat(row.pool_native_k   || 0) || 0;
  const exchangeK = parseFloat(row.pool_exchange_k || 0) || 0;
  const usdBasis  = parseFloat(row.pool_usd_basis  || 0) || 0;
  const total = nativeK + exchangeK;
  if (total <= 0) return; // nothing to drain
  const nativeShare   = nativeK   / total;
  const exchangeShare = exchangeK / total;
  const nativeDrain   = amt * nativeShare;
  const exchangeDrain = amt * exchangeShare;
  // USD basis drains at the pool's blended rate — preserves rate invariant.
  const usdBasisDrain = exchangeK > 0 ? exchangeDrain * (usdBasis / exchangeK) : 0;
  db.prepare(`
    UPDATE business_settings
       SET pool_native_k    = MAX(0, pool_native_k    - ?),
           pool_exchange_k  = MAX(0, pool_exchange_k  - ?),
           pool_usd_basis   = MAX(0, pool_usd_basis   - ?)
     WHERE id = ?
  `).run(nativeDrain, exchangeDrain, usdBasisDrain, row.id);
}

module.exports = {
  poolInflowNative,
  poolInflowExchange,
  poolDrainK,
};
