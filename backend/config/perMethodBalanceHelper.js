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

// ─── v1.10.239 — HQ per-currency (USD / FRA / K) balance ──────────────────
//
// Mirrors the per-currency math in routes/cashBook.js:ccyReceiptsPayments,
// stripped to the non-Liquor (HQ / Sosna) branch and dropped to all-time
// totals (no date filter). Used by the HQ overdraft guard that lands on
// paymentVouchers.js + currencyExchanges.js — sums openings + inflows −
// outflows across every ledger table on the HQ mirror DB, plus branch
// deposits confirmed at HQ (inbound cash), so the guard sees the same
// running balance the Cash Book /stats page shows.
//
// Reference impl: routes/cashBook.js:130-227 (ccyReceiptsPayments).
// Keep the SQL structurally identical so future Cash Book tweaks
// propagate cleanly here by re-syncing this block.

function getOpeningByCcy(db, tenantId) {
  const params = tenantId ? [tenantId] : [];
  const where  = tenantId ? " AND tenant_id = ?" : '';
  const rows = db.prepare(
    `SELECT reference, COALESCE(receipt_amount, 0) AS amount
       FROM cash_book
      WHERE type = 'opening' AND deleted_at IS NULL${where}`
  ).all(...params);
  const out = { usd: 0, fra: 0, k: 0 };
  for (const r of rows) {
    const ref = (r.reference || '').toUpperCase();
    // v1.10.25 — OB-USD / OB-FRA / OB-K are the Sosna per-currency openings.
    // Legacy 'OB' / 'OB-CASH' rows folded into USD (matches cashBook.js:77).
    if      (ref === 'OB-USD' || ref === 'OB-CASH' || ref === 'OB') out.usd += parseFloat(r.amount);
    else if (ref === 'OB-FRA') out.fra += parseFloat(r.amount);
    else if (ref === 'OB-K')   out.k   += parseFloat(r.amount);
  }
  return out;
}

// Slugs that identify the HQ mirror DB. Same set as routes/cashBook.js.
const HQ_INBOX_SLUGS = new Set(['hq', 'sosna', 'sosnazm']);

function getCurrentByCcyForHq(db, tenantId, opts = {}) {
  const { masterDb = null, slug = null } = opts;
  const num = (v) => parseFloat(v || 0) || 0;
  const safeGet = (sql, ...args) => {
    try { return num(db.prepare(sql).get(...args)?.t); } catch { return 0; }
  };
  const p = tenantId ? [tenantId] : [];
  const w = tenantId ? ' AND tenant_id = ?' : '';

  const opening  = getOpeningByCcy(db, tenantId);
  const receipts = { usd: 0, fra: 0, k: 0 };
  const payments = { usd: 0, fra: 0, k: 0 };

  // CR — cash_receipts. Non-Liquor: prefer explicit ccy column, else fall
  // back to legacy cash/bank/momo mirror. Same CASE expression as
  // cashBook.js:151-158.
  const usdExprCR = `CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount WHEN COALESCE(k_amount,0) > 0 THEN 0 ELSE COALESCE(cash_amount,0) END`;
  const kExprCR   = `COALESCE(k_amount, 0)`;

  receipts.usd += safeGet(`SELECT COALESCE(SUM(${usdExprCR}), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL${w}`, ...p);
  receipts.fra += safeGet(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL${w}`, ...p);
  receipts.k   += safeGet(`SELECT COALESCE(SUM(${kExprCR}), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL${w}`, ...p);

  payments.usd += safeGet(`SELECT COALESCE(SUM(${usdExprCR}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL${w}`, ...p);
  payments.fra += safeGet(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL${w}`, ...p);
  payments.k   += safeGet(`SELECT COALESCE(SUM(${kExprCR}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL${w}`, ...p);

  // AP payments — legacy K fallback for pre-v1.10.78 rows (mirrors cashBook.js:173-183).
  payments.usd += safeGet(`SELECT COALESCE(SUM(usd_amount), 0) AS t FROM ap_payments WHERE deleted_at IS NULL${w}`, ...p);
  payments.fra += safeGet(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM ap_payments WHERE deleted_at IS NULL${w}`, ...p);
  payments.k   += safeGet(
    `SELECT COALESCE(SUM(
        CASE WHEN (COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)) > 0
          THEN COALESCE(k_amount, 0)
          ELSE amount END
      ), 0) AS t FROM ap_payments WHERE deleted_at IS NULL${w}`,
    ...p,
  );

  // Currency exchanges (book scope). Each row moves from_currency → payments
  // and to_currency → receipts. Append-only, no deleted_at filter.
  try {
    const exchRows = db.prepare(
      `SELECT from_currency, from_amount, to_currency, to_amount
         FROM currency_exchanges
        WHERE scope = 'book'${w}`
    ).all(...p);
    for (const r of exchRows) {
      const fromKey = r.from_currency === 'USD' ? 'usd' : r.from_currency === 'FRA' ? 'fra' : 'k';
      const toKey   = r.to_currency   === 'USD' ? 'usd' : r.to_currency   === 'FRA' ? 'fra' : 'k';
      payments[fromKey] += num(r.from_amount);
      receipts[toKey]   += num(r.to_amount);
    }
  } catch { /* pre-migration DB */ }

  // HQ deposits (master.db). HQ_INBOX_SLUGS → incoming deposits are receipts.
  if (masterDb && slug && HQ_INBOX_SLUGS.has(String(slug).toLowerCase())) {
    try {
      const inRows = masterDb.prepare(
        `SELECT currency, COALESCE(SUM(amount), 0) AS t
           FROM cash_deposits
          WHERE status = 'CONFIRMED' AND deleted_at IS NULL
          GROUP BY currency`
      ).all();
      for (const r of inRows) {
        const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
        receipts[key] += num(r.t);
      }
    } catch { /* non-fatal */ }
  }

  return {
    usd: opening.usd + receipts.usd - payments.usd,
    fra: opening.fra + receipts.fra - payments.fra,
    k:   opening.k   + receipts.k   - payments.k,
  };
}

// Guard: reject an HQ outflow if any requested currency would drive the
// running balance below zero. Returns null when the outflow is safe, or
// an object `{ ccy, requested, available }` describing the first breach.
// Callers pick the first non-null and return 400.
function checkHqOverdraft(db, tenantId, requested, opts = {}) {
  const bal = getCurrentByCcyForHq(db, tenantId, opts);
  const eps = 0.0001;
  for (const ccy of ['usd', 'fra', 'k']) {
    const req = parseFloat(requested?.[ccy] || 0) || 0;
    if (req > 0 && req > bal[ccy] + eps) {
      return { ccy: ccy.toUpperCase(), requested: req, available: bal[ccy] };
    }
  }
  return null;
}

module.exports = {
  getCurrentByMethod,
  getOpeningByMethod,
  sumMethod,
  getOpeningByCcy,
  getCurrentByCcyForHq,
  checkHqOverdraft,
};
