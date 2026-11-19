/**
 * branchCashPosition.js — cash-in-hand per currency at a given date.
 *
 * Reuses the SAME per-currency logic the Cash Book /stats endpoint uses
 * (getOpeningByCurrency + getOpeningByMethod + ccyReceiptsPayments from
 * routes/cashBook.js). Those helpers read from the request-scoped `db`
 * proxy in config/database.js, so callers MUST wrap in
 * runWithDb(branchDb, ...) before invoking.
 *
 * Two branch shapes on Sosna:
 *
 *   Multi-currency (HQ, Kassumbalesa): openings use OB-USD / OB-FRA /
 *     OB-K reference labels, split cleanly by getOpeningByCurrency.
 *
 *   K-only (Lusaka, Mansa): openings use OB-CASH / OB-BANK / OB-MOMO —
 *     which getOpeningByCurrency wrongly classifies as USD (legacy
 *     fallback for pre-Sosna single-currency USD tenants). Detect via
 *     business_settings.currency_mode = 'K' and use getOpeningByMethod
 *     instead (routes OB-CASH/OB-BANK/OB-MOMO to K).
 */

const { getOpeningByCurrency, ccyReceiptsPayments } = require('../routes/cashBook');

// Local copy of getOpeningByMethod — cashBook.js exports it too, but at
// module init time the router isn't fully wired yet; safest to duplicate
// the ~10-line helper here. Reads the same reference labels.
function getOpeningByMethodK(db, tenantId) {
  const rows = db.prepare(
    "SELECT reference, COALESCE(receipt_amount, 0) AS amount FROM cash_book WHERE type = 'opening' AND deleted_at IS NULL AND tenant_id = ?"
  ).all(tenantId);
  let k = 0;
  for (const r of rows) {
    const ref = String(r.reference || '').toUpperCase();
    // K-only branches: OB-CASH, OB-BANK, OB-MOMO, OB all seed K holdings
    if (ref === 'OB-CASH' || ref === 'OB-BANK' || ref === 'OB-MOMO' || ref === 'OB') {
      k += parseFloat(r.amount) || 0;
    }
  }
  return k;
}

function isKOnlyBranch(db) {
  try {
    const bs = db.prepare(`SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`).get();
    return String(bs?.currency_mode || '').toUpperCase() === 'K';
  } catch (_) { return false; }
}

// 2026-11-19 — Capital Account (Injection / Drawing) and Dividend Account
// rows move cash (the Cash Book ledger lists them as CAP-IN / CAP-OUT / DIV)
// but ccyReceiptsPayments does not read those tables, so the Balance Sheet
// cash line silently excluded them. Neither table has currency columns;
// `amount` is in the book's own currency, passed in as capitalCcy
// ('k' for K branches and HQ, 'usd' for the USD-native branch).
function capitalDividendCash(db, tenantId, asOf) {
  const one = (sql) => {
    try { return parseFloat(db.prepare(sql).get(tenantId, asOf)?.t || 0) || 0; }
    catch (_) { return 0; }
  };
  const injections = one(`SELECT COALESCE(SUM(amount),0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type = 'Injection' AND date <= ?`);
  const drawings   = one(`SELECT COALESCE(SUM(amount),0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type = 'Drawing'   AND date <= ?`);
  const dividends  = one(`SELECT COALESCE(SUM(amount),0) AS t FROM dividend_account WHERE deleted_at IS NULL AND tenant_id = ? AND date <= ?`);
  return { injections, drawings, dividends, net: injections - drawings - dividends };
}

function computeBranchCashPosition(db, tenantId, slug, asOf, opts = {}) {
  const kOnly = isKOnlyBranch(db);

  let opening;
  if (kOnly) {
    // Route OB-CASH/OB-BANK/OB-MOMO into K bucket, leave USD/FRA at 0
    opening = { usd: 0, fra: 0, k: getOpeningByMethodK(db, tenantId) };
  } else {
    opening = getOpeningByCurrency(tenantId);
  }

  // Deltas via the same source-table aggregation the /stats endpoint uses.
  // ccyReceiptsPayments already handles isLiquorK detection so USD stays
  // at 0 on K-only branches and K correctly sums cash+bank+momo.
  const dateClause = ' AND date <= ?';
  const dateParams = [asOf];
  const rp = ccyReceiptsPayments(tenantId, slug, dateClause, dateParams);

  const pos = {
    usd: (opening.usd || 0) + (rp.receipts.usd || 0) - (rp.payments.usd || 0),
    fra: (opening.fra || 0) + (rp.receipts.fra || 0) - (rp.payments.fra || 0),
    k:   (opening.k   || 0) + (rp.receipts.k   || 0) - (rp.payments.k   || 0),
  };

  // Capital / dividends — opt-in so any other caller keeps the old numbers.
  if (opts.includeCapital) {
    const cap = capitalDividendCash(db, tenantId, asOf);
    const key = opts.capitalCcy === 'usd' ? 'usd' : opts.capitalCcy === 'fra' ? 'fra' : 'k';
    pos[key] += cap.net;
  }
  return pos;
}

module.exports = { computeBranchCashPosition, capitalDividendCash };
