// perMethodBalanceHelper — v1.10.204
//
// Shared per-drawer (Cash / Bank / MoMo) balance math extracted from
// cashBook.js so cashDeposits.js's overdraft guard can compute the
// same value the Cash Book /stats endpoint shows. Prior guard used a
// simplified sum (opening + CR - PV - AP - deposits) that skipped
// capital, dividend, loan and drawer-to-drawer transfer flows — so
// on branches with any of those, the guard was quietly wrong (e.g.
// Lusaka rejected a legitimate K149,220 deposit claiming the drawer
// balance was -K1,337,586 because ~K1.5M of transferNet + capital
// inflows weren't counted).
//
// Reference implementation: routes/cashBook.js:46-63 (opening) and
// :234-300 (sumMethod). Kept structurally identical so future tweaks
// to Cash Book math propagate cleanly to the guard by re-syncing
// this file.
//
// The functions accept an explicit better-sqlite3 db handle so the
// deposit route can open the SOURCE branch's tenant DB via
// getTenantDb(slug) and get that branch's balance — not the caller's
// (which is HQ when a deposit is booked centrally).

// Legacy 'OB' rows fall into the Cash bucket for backward compat.
function getOpeningByMethod(db, tenantId) {
  const params = tenantId ? [tenantId] : [];
  const where = tenantId ? " AND tenant_id = ?" : '';
  const rows = db.prepare(
    `SELECT reference, COALESCE(receipt_amount, 0) AS amount
       FROM cash_book
      WHERE type = 'opening' AND deleted_at IS NULL${where}`
  ).all(...params);
  const out = { cash: 0, bank: 0, momo: 0 };
  for (const r of rows) {
    const ref = (r.reference || '').toUpperCase();
    if      (ref === 'OB-BANK') out.bank += parseFloat(r.amount);
    else if (ref === 'OB-MOMO') out.momo += parseFloat(r.amount);
    else if (ref === 'OB-CASH' || ref === 'OB') out.cash += parseFloat(r.amount);
    // OB-USD / OB-FRA / OB-K stay in a separate per-currency scope
    // (routes/cashBook.js:70-82), so we ignore them here — same as
    // the reference impl.
  }
  return out;
}

// Per-method flow totals across the tenant's whole history (no date
// filter). All-time totals + opening give the current drawer balance
// which is what the deposit guard needs to compare against.
function sumMethod(db, tenantId, methodCol, isLiquorK) {
  const params = tenantId ? [tenantId] : [];
  const tenantWhere = tenantId ? ' AND tenant_id = ?' : '';

  // Same CASE fallback the Cash Book stats uses at cashBook.js:268-276.
  // On Liquor branches the modal-writes drawer amount directly into
  // the method column so we trust it as-is (avoids double-counting
  // half-populated legacy rows). On non-Liquor, prefer currency
  // columns (usd/fra/k) with method-column fallback.
  const cxMap = isLiquorK ? {
    cash_amount: 'COALESCE(cash_amount, 0)',
    bank_amount: 'COALESCE(bank_amount, 0)',
    momo_amount: 'COALESCE(momo_amount, 0)',
  } : {
    cash_amount: 'CASE WHEN COALESCE(usd_amount, 0) > 0 THEN usd_amount ELSE COALESCE(cash_amount, 0) END',
    bank_amount: 'CASE WHEN COALESCE(k_amount,   0) > 0 THEN k_amount   ELSE COALESCE(bank_amount, 0) END',
    momo_amount: 'CASE WHEN COALESCE(fra_amount, 0) > 0 THEN fra_amount ELSE COALESCE(momo_amount, 0) END',
  };
  const exprCcy = cxMap[methodCol] || methodCol;

  const safeSum = (sql) => {
    try { return parseFloat(db.prepare(sql).get(...params).t) || 0; }
    catch (_) { return 0; }
  };

  const cr = safeSum(
    `SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM cash_receipts    WHERE deleted_at IS NULL${tenantWhere}`
  );
  const pv = safeSum(
    `SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL${tenantWhere}`
  );
  const ap = safeSum(
    `SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM ap_payments      WHERE deleted_at IS NULL${tenantWhere}`
  );
  const capIn = safeSum(
    `SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND type='Injection'${tenantWhere}`
  );
  const capOut = safeSum(
    `SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND type='Drawing'${tenantWhere}`
  );
  const div = safeSum(
    `SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM dividend_account WHERE deleted_at IS NULL${tenantWhere}`
  );
  const loanIn = safeSum(
    `SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND type='Disbursement'${tenantWhere}`
  );
  const loanPrin = safeSum(
    `SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND type='Principal'${tenantWhere}`
  );
  const loanInt = safeSum(
    `SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND type='Interest'${tenantWhere}`
  );

  // Drawer-to-drawer transfer net effect on this method.
  const methodName = methodCol === 'cash_amount' ? 'Cash'
                    : methodCol === 'bank_amount' ? 'Bank'
                    : 'Mobile Money';
  let trIn = 0, trOut = 0;
  try {
    const trParams = tenantId ? [tenantId, methodName] : [methodName];
    const trTenant = tenantId ? ' AND tenant_id = ?' : '';
    trIn = parseFloat(db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers
        WHERE deleted_at IS NULL${trTenant} AND COALESCE(currency,'USD')='USD' AND to_method = ?`
    ).get(...trParams).t) || 0;
    trOut = parseFloat(db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers
        WHERE deleted_at IS NULL${trTenant} AND COALESCE(currency,'USD')='USD' AND from_method = ?`
    ).get(...trParams).t) || 0;
  } catch (_) { /* cash_transfers table missing on old branch DBs */ }

  return {
    cr, pv, ap,
    capIn, capOut, div,
    loanIn, loanPrin, loanInt,
    transferNet: trIn - trOut,
  };
}

// Assembles all three drawers' current balance in one call.
// isLiquorK: true → Liquor-K legacy modal-write mode (see cxMap above).
// tenantId can be null / undefined — the query then skips the tenant
// filter, which is safe because per-tenant SQLite files contain only
// one tenant's rows anyway. Providing it is more defensive.
function getCurrentByMethod(db, tenantId, isLiquorK) {
  const opening = getOpeningByMethod(db, tenantId);
  const cash = sumMethod(db, tenantId, 'cash_amount', isLiquorK);
  const bank = sumMethod(db, tenantId, 'bank_amount', isLiquorK);
  const momo = sumMethod(db, tenantId, 'momo_amount', isLiquorK);
  const compute = (o, m) => o
    + m.cr + m.capIn + m.loanIn
    - m.pv - m.ap - m.capOut - m.div - m.loanPrin - m.loanInt
    + m.transferNet;
  return {
    cash: compute(opening.cash, cash),
    bank: compute(opening.bank, bank),
    momo: compute(opening.momo, momo),
  };
}

module.exports = { getCurrentByMethod, getOpeningByMethod, sumMethod };
