/**
 * branchCashPosition.js — compute a single branch's real cash position
 * (USD + FRA + K sub-drawers) as-at a given date, from its own cash_book.
 *
 * Shared by the Balance Sheet endpoint (/api/hq/balance-sheet) so it can
 * aggregate cash across every branch without duplicating the per-currency
 * math routes/cashBook.js already carries. Kept simple: opening seeds +
 * sum of receipts − sum of payments per currency column, up to asOf.
 *
 * Does NOT re-implement the /api/cash-book/stats endpoint's category
 * breakdowns (capital / dividend / loan / transfer). For a Balance Sheet
 * we only need TOTAL cash per currency — how it got there doesn't matter.
 *
 * Reference conventions in cash_book (type='opening' rows):
 *   OB-USD                          → USD sub-drawer opening
 *   OB-FRA                          → FRA sub-drawer opening
 *   OB-K / OB-K-CASH / OB-K-BANK /
 *     OB-K-MOMO / OB / OB-CASH /
 *     OB-BANK / OB-MOMO             → K sub-drawer opening (legacy incl.)
 *
 * Delta rows (type != 'opening'):
 *   USD delta = SUM(usd_amount on receipts) − SUM(usd_amount on payments)
 *   FRA delta = same with fra_amount
 *   K   delta = same with k_amount when populated,
 *               else cash_amount + bank_amount + momo_amount (K sub-methods)
 */

function computeBranchCashPosition(db, tenantId, asOf) {
  // Opening balances per currency drawer.
  // tenantId is optional — HQ (defaultDb) doesn't set it in sync_config,
  // and cash_book rows in a per-branch DB are already scoped to that
  // tenant by construction, so we only filter by tenant_id when we have one.
  const opWhere = tenantId ? 'AND tenant_id = ?' : '';
  const opArgs  = tenantId ? [tenantId] : [];
  const openings = db.prepare(`
    SELECT reference, COALESCE(receipt_amount, 0) AS amount
      FROM cash_book
     WHERE type = 'opening' ${opWhere}
  `).all(...opArgs);

  let openUsd = 0, openFra = 0, openK = 0;
  for (const r of openings) {
    const ref = String(r.reference || '').toUpperCase();
    const amt = parseFloat(r.amount) || 0;
    if      (ref === 'OB-USD') openUsd += amt;
    else if (ref === 'OB-FRA') openFra += amt;
    else                       openK   += amt;
  }

  // Per-currency net deltas up to asOf. Receipts add, payments subtract.
  const d = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN COALESCE(receipt_amount,0) > 0 THEN COALESCE(usd_amount,0) ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN COALESCE(payment_amount,0) > 0 THEN COALESCE(usd_amount,0) ELSE 0 END), 0)
      AS usd_net,

      COALESCE(SUM(CASE WHEN COALESCE(receipt_amount,0) > 0 THEN COALESCE(fra_amount,0) ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN COALESCE(payment_amount,0) > 0 THEN COALESCE(fra_amount,0) ELSE 0 END), 0)
      AS fra_net,

      COALESCE(SUM(CASE WHEN COALESCE(receipt_amount,0) > 0 THEN COALESCE(k_amount,0) ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN COALESCE(payment_amount,0) > 0 THEN COALESCE(k_amount,0) ELSE 0 END), 0)
      AS k_ccy_net,

      COALESCE(SUM(CASE WHEN COALESCE(receipt_amount,0) > 0
                        THEN COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0)
                        ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN COALESCE(payment_amount,0) > 0
                        THEN COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0)
                        ELSE 0 END), 0)
      AS k_method_net
    FROM cash_book
   WHERE date <= ?
     ${tenantId ? 'AND tenant_id = ?' : ''}
     AND (type IS NULL OR type != 'opening')
  `).get(...(tenantId ? [asOf, tenantId] : [asOf]));

  const usdDelta = parseFloat(d?.usd_net || 0);
  const fraDelta = parseFloat(d?.fra_net || 0);
  // Prefer the explicit K currency column if populated (multi-currency
  // branches like Kassumbalesa); fall back to K method columns for
  // single-currency K branches (Lusaka, Mansa).
  const kDelta = Math.abs(d?.k_ccy_net || 0) > 0.01
    ? parseFloat(d.k_ccy_net)
    : parseFloat(d?.k_method_net || 0);

  return {
    usd: openUsd + usdDelta,
    fra: openFra + fraDelta,
    k:   openK   + kDelta,
  };
}

module.exports = { computeBranchCashPosition };
