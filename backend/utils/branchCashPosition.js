/**
 * branchCashPosition.js — cash-in-hand per currency at a given date.
 *
 * Reuses the SAME per-currency logic the Cash Book /stats endpoint uses
 * (getOpeningByCurrency + ccyReceiptsPayments in routes/cashBook.js).
 * Those helpers aggregate from the SOURCE tables (cash_receipts,
 * payment_vouchers, ap_payments, currency_exchanges, cash_deposits) —
 * NOT from cash_book directly, because cash_book itself is only
 * receipt_amount / payment_amount (no per-currency columns).
 *
 * The exported helpers read from the request-scoped `db` proxy in
 * config/database.js, so callers MUST wrap in runWithDb(branchDb, ...)
 * to point it at the target branch's tenant DB before calling.
 */

const { getOpeningByCurrency, ccyReceiptsPayments } = require('../routes/cashBook');

function computeBranchCashPosition(tenantId, slug, asOf) {
  const opening = getOpeningByCurrency(tenantId);
  // ccyReceiptsPayments date filter: pass dateClause + dateParams
  const dateClause = ' AND date <= ?';
  const dateParams = [asOf];
  const rp = ccyReceiptsPayments(tenantId, slug, dateClause, dateParams);
  return {
    usd: (opening.usd || 0) + (rp.receipts.usd || 0) - (rp.payments.usd || 0),
    fra: (opening.fra || 0) + (rp.receipts.fra || 0) - (rp.payments.fra || 0),
    k:   (opening.k   || 0) + (rp.receipts.k   || 0) - (rp.payments.k   || 0),
  };
}

module.exports = { computeBranchCashPosition };
