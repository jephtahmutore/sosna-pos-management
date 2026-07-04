const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
// v1.8.61 — Cash Book also surfaces HQ Deposits (master.db) so the
// branch's ledger reflects cash leaving its drawer, and HQ's ledger
// reflects cash arriving. Neutral entries — no P&L impact.
let masterDb = null;
try { masterDb = require('../config/masterDb').masterDb; } catch (_) { /* offline mode */ }

const HQ_INBOX_SLUGS = new Set(['hq', 'sosna', 'sosnazm']);

// Opening balances are stored as up to 3 rows in cash_book with type='opening':
//   reference='OB-CASH' / 'OB-BANK' / 'OB-MOMO'
// A pre-existing single 'OB' row (legacy) is treated as the Cash opening.
function getOpeningByMethod(tenantId) {
  const rows = db.prepare(
    "SELECT reference, COALESCE(receipt_amount, 0) AS amount FROM cash_book WHERE type = 'opening' AND deleted_at IS NULL AND tenant_id = ?"
  ).all(tenantId);
  const out = { cash: 0, bank: 0, momo: 0 };
  for (const r of rows) {
    const ref = (r.reference || '').toUpperCase();
    if (ref === 'OB-BANK') out.bank += parseFloat(r.amount);
    else if (ref === 'OB-MOMO') out.momo += parseFloat(r.amount);
    else if (ref === 'OB-CASH' || ref === 'OB') out.cash += parseFloat(r.amount);
    // v1.10.25 — OB-USD / OB-FRA / OB-K are Sosna per-currency openings.
    // They belong to openingByCcy only. The previous fallback lumped them
    // all into `cash`, so on Sosna the "opening balance" became a raw
    // USD+FRA+K sum (e.g. 23,775 + 196,000 + 3,980 = 223,755) which the
    // ledger's Balance column then showed as a $-amount — nonsense.
  }
  return out;
}

// v1.8.62 — per-currency opening balance for Sosna (USD / FRA / K).
// New references: 'OB-USD', 'OB-FRA', 'OB-K'. Legacy 'OB' / 'OB-CASH' rows
// fall through as USD so existing tenants don't lose their opening cash.
// 'OB-BANK' and 'OB-MOMO' (Liquor/Butchery) are ignored here — Sosna's
// drawers are physical USD/FRA/K, not method buckets.
function getOpeningByCurrency(tenantId) {
  const rows = db.prepare(
    "SELECT reference, COALESCE(receipt_amount, 0) AS amount FROM cash_book WHERE type = 'opening' AND deleted_at IS NULL AND tenant_id = ?"
  ).all(tenantId);
  const out = { usd: 0, fra: 0, k: 0 };
  for (const r of rows) {
    const ref = (r.reference || '').toUpperCase();
    if      (ref === 'OB-USD' || ref === 'OB-CASH' || ref === 'OB') out.usd += parseFloat(r.amount);
    else if (ref === 'OB-FRA') out.fra += parseFloat(r.amount);
    else if (ref === 'OB-K')   out.k   += parseFloat(r.amount);
  }
  return out;
}

// v1.10.25 — Per-currency receipts + payments for an arbitrary date clause.
// Used to fold pre-period activity into openingByCcy so opening on day N
// equals closing on day N-1.
//
// SOURCES MUST MATCH THE LEDGER UNION in GET / — the ledger only shows
// cash_receipts (CR), payment_vouchers (PV), ap_payments (AP) and HQ
// deposits. It does NOT show orders.cash_received. So opening = ledger
// closing requires this helper to skip orders too.
//
// v1.10.27 — Removed orders. On Sosna every POS sale creates BOTH an
// orders row (with cash_received/fra_received/k_received) and a cash_receipt
// row that appears in the ledger. /stats accidentally avoids double-counting
// because its `date <= to` clause on orders' paid_at (a datetime, not date)
// fails to match same-day rows with a time component. My earlier
// `date < from` clause matched both → every fold double-counted every POS
// sale, so Jul 2 opening = Jul 1 opening + Jul 1 receipts (twice) instead of
// Jul 1 closing.
// v1.10.91 — check whether the current tenant is Liquor-style (K-only,
// cash/momo/bank drawers) so we can route cash/momo/bank amounts into the
// K bucket instead of leaking them into USD (cash) or dropping them
// entirely (momo/bank). Sosna-style tenants keep the previous behaviour
// where cash_amount is a legacy fallback for usd_amount.
function isLiquorTenant() {
  try {
    const bs = db.prepare("SELECT currency_mode, payment_methods FROM business_settings LIMIT 1").get() || {};
    return String(bs.currency_mode || '').toUpperCase() === 'K'
        && String(bs.payment_methods || '').toLowerCase() === 'cash_momo_bank';
  } catch (_) { return false; }
}

function ccyReceiptsPayments(tenantId, slug, dateClause, dateParams) {
  const receipts = { usd: 0, fra: 0, k: 0 };
  const payments = { usd: 0, fra: 0, k: 0 };
  const num = (v) => parseFloat(v || 0) || 0;
  const liq = isLiquorTenant();

  // v1.10.91 / v1.10.93 — column expressions.
  //
  // Sosna path: usd = usd_amount OR legacy cash_amount, k = k_amount.
  //
  // Liquor path: per PaymentVoucherFormModal.js comment "Storage columns
  // stay the same (usd_amount = Cash, fra_amount = MoMo, k_amount = Bank)
  // to avoid a DB migration", Liquor writes drawer amounts into the
  // currency columns. So every column potentially holds K-denominated
  // money on Liquor (usd/fra/k for post-v1.8.5 rows, cash/bank/momo for
  // pre-v1.8.5 legacy rows). Sum all six into K, and USD = 0 (no USD leg).
  //
  // v1.10.91 mistakenly summed only cash+momo+bank on Liquor, missing
  // the actual usd_amount + fra_amount + k_amount where the drawer
  // amounts are stored — hence "K & K Equivalent" and per-currency
  // views ignored every MoMo/Bank PV.
  const CR_USD = liq
    ? '0'
    : 'CASE WHEN COALESCE(usd_amount,0)>0 THEN usd_amount ELSE COALESCE(cash_amount,0) END';
  const CR_K = liq
    ? 'COALESCE(usd_amount, 0) + COALESCE(fra_amount, 0) + COALESCE(k_amount, 0) + COALESCE(cash_amount, 0) + COALESCE(momo_amount, 0) + COALESCE(bank_amount, 0)'
    : 'COALESCE(k_amount, 0)';
  const PV_USD = CR_USD;
  const PV_K   = CR_K;

  // CR — cash_receipts.
  receipts.usd += num(db.prepare(`SELECT COALESCE(SUM(${CR_USD}), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  receipts.fra += num(db.prepare(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  receipts.k   += num(db.prepare(`SELECT COALESCE(SUM(${CR_K}), 0)   AS t FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  // PV — payment_vouchers.
  payments.usd += num(db.prepare(`SELECT COALESCE(SUM(${PV_USD}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.fra += num(db.prepare(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.k   += num(db.prepare(`SELECT COALESCE(SUM(${PV_K}), 0)   AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  // v1.10.78 — AP payments now support triple-currency (usd/fra/k) on HQ
  // via the ap_payments columns added in the same version. Route each
  // currency to its own bucket; rows that pre-date v1.10.78 (only
  // amount populated, usd/fra/k = 0) fall back to k_out (legacy K-only
  // behaviour matching v1.10.77).
  payments.usd += num(db.prepare(`SELECT COALESCE(SUM(usd_amount), 0) AS t FROM ap_payments WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.fra += num(db.prepare(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM ap_payments WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.k   += num(db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN (COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)) > 0
        THEN COALESCE(k_amount, 0)
        ELSE amount END
    ), 0) AS t
      FROM ap_payments
     WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}
  `).get(tenantId, ...dateParams).t);
  // v1.10.42 — book-scope currency exchanges. Same shape as the ledger
  // UNION addition: from_currency → payments, to_currency → receipts.
  // Append-only, no deleted_at filter.
  const exchRows = db.prepare(`
    SELECT from_currency, from_amount, to_currency, to_amount
      FROM currency_exchanges
     WHERE scope = 'book' AND tenant_id = ?${dateClause}
  `).all(tenantId, ...dateParams);
  for (const r of exchRows) {
    const fromKey = r.from_currency === 'USD' ? 'usd' : r.from_currency === 'FRA' ? 'fra' : 'k';
    const toKey   = r.to_currency   === 'USD' ? 'usd' : r.to_currency   === 'FRA' ? 'fra' : 'k';
    payments[fromKey] += num(r.from_amount);
    receipts[toKey]   += num(r.to_amount);
  }
  // HQ deposits (master.db). Branches: outgoing → payment. HQ: incoming → receipt.
  if (masterDb && slug) {
    try {
      const datePred = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
      const depClause = dateClause.replace(/\bdate\b/g, datePred);
      const outRows = masterDb.prepare(`
        SELECT currency, COALESCE(SUM(amount), 0) AS t
          FROM cash_deposits
         WHERE status = 'CONFIRMED' AND from_slug = ?${depClause}
         GROUP BY currency
      `).all(slug, ...dateParams);
      for (const r of outRows) {
        const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
        payments[key] += num(r.t);
      }
      if (HQ_INBOX_SLUGS.has(slug)) {
        const inRows = masterDb.prepare(`
          SELECT currency, COALESCE(SUM(amount), 0) AS t
            FROM cash_deposits
           WHERE status = 'CONFIRMED'${depClause}
           GROUP BY currency
        `).all(...dateParams);
        for (const r of inRows) {
          const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
          receipts[key] += num(r.t);
        }
      }
    } catch (_) { /* non-fatal */ }
  }
  return { receipts, payments };
}

// Sum a money column across all inflow/outflow tables with optional date filter.
// Capital Injection + Loan Disbursement → inflow (like CR).
// Capital Drawing + Dividend + Loan Principal + Loan Interest → outflow (like PV).
// Also computes net transfer effect for this method (in - out).
function sumMethod(tenantId, methodCol, dateClause, dateParams) {
  // v1.10.93 — on Liquor tenants, PVs / CRs / AP store drawer amounts
  // in the currency columns (usd_amount = Cash, fra_amount = MoMo,
  // k_amount = Bank) per PaymentVoucherFormModal's "avoid DB migration"
  // note. Legacy pre-v1.8.5 rows still use cash_amount / momo_amount /
  // bank_amount. Sum both so both eras count.
  //
  // v1.10.95 hotfix — the currency columns only exist on tables that
  // went through the tri-currency migration: cash_receipts,
  // payment_vouchers, ap_payments. capital_account / dividend_account /
  // loan_transactions were never migrated (they're single-currency by
  // design), so referencing usd_amount there throws "no such column"
  // and the endpoint returns empty. Use exprCcy only for the three
  // migrated tables; fall back to methodCol for the rest.
  const liq = isLiquorTenant();
  const exprCcy = !liq ? methodCol
                : methodCol === 'cash_amount' ? 'COALESCE(cash_amount, 0) + COALESCE(usd_amount, 0)'
                : methodCol === 'bank_amount' ? 'COALESCE(bank_amount, 0) + COALESCE(k_amount,   0)'
                : methodCol === 'momo_amount' ? 'COALESCE(momo_amount, 0) + COALESCE(fra_amount, 0)'
                : methodCol;
  const expr = methodCol; // single-currency tables — the untouched one
  const cr = db.prepare(`SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM cash_receipts    WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const pv = db.prepare(`SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const ap = db.prepare(`SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM ap_payments      WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const capIn  = db.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type='Injection'${dateClause}`).get(tenantId, ...dateParams).t;
  const capOut = db.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type='Drawing'${dateClause}`).get(tenantId, ...dateParams).t;
  const div    = db.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS t FROM dividend_account WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const loanIn   = db.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Disbursement'${dateClause}`).get(tenantId, ...dateParams).t;
  const loanPrin = db.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Principal'${dateClause}`).get(tenantId, ...dateParams).t;
  const loanInt  = db.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Interest'${dateClause}`).get(tenantId, ...dateParams).t;
  // Net cash transfer effect on this method = inflow (to_method) - outflow (from_method)
  const methodName = methodCol === 'cash_amount' ? 'Cash' : methodCol === 'bank_amount' ? 'Bank' : 'Mobile Money';
  const trIn  = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers WHERE deleted_at IS NULL AND tenant_id = ? AND to_method   = ?${dateClause}`).get(tenantId, methodName, ...dateParams).t;
  const trOut = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers WHERE deleted_at IS NULL AND tenant_id = ? AND from_method = ?${dateClause}`).get(tenantId, methodName, ...dateParams).t;
  return {
    cr: parseFloat(cr), pv: parseFloat(pv), ap: parseFloat(ap),
    capIn: parseFloat(capIn), capOut: parseFloat(capOut), div: parseFloat(div),
    loanIn: parseFloat(loanIn), loanPrin: parseFloat(loanPrin), loanInt: parseFloat(loanInt),
    transferNet: parseFloat(trIn) - parseFloat(trOut),
  };
}

// Get cash book — derived from CR + PV + AP with per-method opening balance
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const opening = getOpeningByMethod(tenantId);
    const { from, to } = req.query;

    // Period filter for the entries shown in the table
    const dateFilter = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const dParams = [...(from ? [from] : []), ...(to ? [to] : [])];

    // When a `from` is set, fold all prior activity into the displayed opening
    let openingBalance = opening.cash + opening.bank + opening.momo;
    let openingByMethod = { ...opening };
    if (from) {
      const beforeClause = ' AND date < ?';
      ['cash_amount', 'bank_amount', 'momo_amount'].forEach((col) => {
        const key = col.replace('_amount', '');
        const m = sumMethod(tenantId, col, beforeClause, [from]);
        openingByMethod[key] = openingByMethod[key]
          + m.cr + m.capIn + m.loanIn
          - m.pv - m.ap - m.capOut - m.div - m.loanPrin - m.loanInt
          + m.transferNet;
      });
      openingBalance = openingByMethod.cash + openingByMethod.bank + openingByMethod.momo;
    }

    // v1.8.61 — per-currency in/out columns alongside the legacy
    // receipt_amount/payment_amount (USD-equivalent for running balance).
    // CR / PV / customer_payments tables have usd_amount/fra_amount/k_amount;
    // legacy cash_amount falls back to USD. Sources without per-currency
    // columns (AP / capital / dividend / loan) bucket their amount into USD.
    //
    // v1.10.93 — Liquor stores drawer amounts in usd/fra/k columns
    // (see PaymentVoucherFormModal comment). Legacy pre-v1.8.5 rows may
    // still have cash/momo/bank. Both are K-denominated on Liquor, so
    // fold ALL six into k_in / k_out, and set usd = 0 (Liquor has no
    // USD leg). Sosna keeps the previous logic.
    const liq = isLiquorTenant();
    const CR_USD_IN  = liq ? '0' : 'CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount ELSE COALESCE(cash_amount,0) END';
    const CR_K_IN    = liq ? 'COALESCE(usd_amount, 0) + COALESCE(fra_amount, 0) + COALESCE(k_amount, 0) + COALESCE(cash_amount, 0) + COALESCE(momo_amount, 0) + COALESCE(bank_amount, 0)' : 'COALESCE(k_amount, 0)';
    const PV_USD_OUT = CR_USD_IN;
    const PV_K_OUT   = CR_K_IN;
    const entries = db.prepare(`
      SELECT date, 'CR' AS type, receipt_number AS reference,
        -- v1.10.49 — no trailing " - " when description is empty.
        CASE
          WHEN COALESCE(description, '') != ''
            THEN COALESCE(received_from, '') || ' — ' || description
          ELSE COALESCE(received_from, '')
        END AS description,
        amount AS receipt_amount, 0 AS payment_amount,
        ${CR_USD_IN} AS usd_in,
        COALESCE(fra_amount, 0) AS fra_in,
        ${CR_K_IN}   AS k_in,
        0 AS usd_out, 0 AS fra_out, 0 AS k_out
      FROM cash_receipts
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'PV' AS type, voucher_number AS reference,
        -- v1.10.49 — PV description now folds in the Type (category)
        -- from the PV modal. Priority: description > category > (empty).
        -- Bare " - " suffix removed. Example results:
        --   paid_to='Edron', category='Salaries', desc='' → 'Edron · Salaries'
        --   paid_to='Edron', desc='for July'              → 'Edron — for July'
        --   paid_to='Edron', category='Salaries', desc='for July'
        --     → 'Edron · Salaries — for July'
        CASE
          WHEN COALESCE(description, '') != '' AND COALESCE(category, '') != ''
            THEN COALESCE(paid_to, '') || ' · ' || category || ' — ' || description
          WHEN COALESCE(description, '') != ''
            THEN COALESCE(paid_to, '') || ' — ' || description
          WHEN COALESCE(category, '') != ''
            THEN COALESCE(paid_to, '') || ' · ' || category
          ELSE COALESCE(paid_to, '')
        END AS description,
        0 AS receipt_amount, amount AS payment_amount,
        0 AS usd_in, 0 AS fra_in, 0 AS k_in,
        ${PV_USD_OUT} AS usd_out,
        COALESCE(fra_amount, 0) AS fra_out,
        ${PV_K_OUT}   AS k_out
      FROM payment_vouchers
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'AP' AS type, payment_number AS reference,
        -- v1.10.49 — same tidy-up for AP. "Supplier Payment" only kicks
        -- in when description is genuinely blank.
        CASE
          WHEN COALESCE(description, '') != ''
            THEN COALESCE(supplier_name, '') || ' — ' || description
          ELSE COALESCE(supplier_name, 'Supplier Payment')
        END AS description,
        0 AS receipt_amount,
        -- v1.10.79 — payment_amount is the LEGACY USD-equivalent running-
        -- balance driver. When the triple-currency split is present, use
        -- usd_amount only. Prior to this the whole amount column
        -- (K32,000 for a K-only supplier payment) got subtracted from
        -- the USD running balance, driving it artificially negative.
        -- Legacy rows fall back to amount for backward compat.
        CASE WHEN (COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)) > 0
          THEN COALESCE(usd_amount, 0)
          ELSE amount END AS payment_amount,
        0 AS usd_in, 0 AS fra_in, 0 AS k_in,
        -- v1.10.78 — split by currency when the triple-ccy columns are
        -- populated (HQ from v1.10.78). Legacy rows fall back to k_out
        -- per the v1.10.77 K-primary default for supplier payments.
        COALESCE(usd_amount, 0) AS usd_out,
        COALESCE(fra_amount, 0) AS fra_out,
        CASE WHEN (COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)) > 0
          THEN COALESCE(k_amount, 0)
          ELSE amount END AS k_out
      FROM ap_payments
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
        AND COALESCE(paid_from, '') != 'Empty Return'
        AND COALESCE(description, '') NOT LIKE 'Empty container deposit credit%'
      UNION ALL
      SELECT date, 'TRF' AS type, transfer_number AS reference,
        'Transfer: ' || from_method || ' -> ' || to_method ||
          CASE WHEN description IS NOT NULL AND description != '' THEN ' (' || description || ')' ELSE '' END AS description,
        amount AS receipt_amount, amount AS payment_amount,
        amount AS usd_in, 0 AS fra_in, 0 AS k_in,
        amount AS usd_out, 0 AS fra_out, 0 AS k_out
      FROM cash_transfers
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date,
        CASE WHEN type='Injection' THEN 'CAP-IN' ELSE 'CAP-OUT' END AS type,
        entry_number AS reference,
        COALESCE(owner_name, '') || ' - ' || COALESCE(description, type) AS description,
        CASE WHEN type='Injection' THEN amount ELSE 0 END AS receipt_amount,
        CASE WHEN type='Drawing'   THEN amount ELSE 0 END AS payment_amount,
        CASE WHEN type='Injection' THEN amount ELSE 0 END AS usd_in,
        0 AS fra_in, 0 AS k_in,
        CASE WHEN type='Drawing' THEN amount ELSE 0 END AS usd_out,
        0 AS fra_out, 0 AS k_out
      FROM capital_account
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'DIV' AS type, entry_number AS reference,
        COALESCE(recipient, '') || ' - ' || COALESCE(description, 'Dividend') AS description,
        0 AS receipt_amount, amount AS payment_amount,
        0 AS usd_in, 0 AS fra_in, 0 AS k_in,
        amount AS usd_out, 0 AS fra_out, 0 AS k_out
      FROM dividend_account
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT lt.date,
        CASE lt.type
          WHEN 'Disbursement' THEN 'LOAN-IN'
          WHEN 'Principal'    THEN 'LOAN-PRIN'
          ELSE                     'LOAN-INT'
        END AS type,
        lt.transaction_number AS reference,
        COALESCE(l.lender_name, '') || ' - ' || lt.type || COALESCE(' (' || lt.description || ')', '') AS description,
        CASE WHEN lt.type='Disbursement' THEN lt.amount ELSE 0 END AS receipt_amount,
        CASE WHEN lt.type IN ('Principal','Interest') THEN lt.amount ELSE 0 END AS payment_amount,
        CASE WHEN lt.type='Disbursement' THEN lt.amount ELSE 0 END AS usd_in,
        0 AS fra_in, 0 AS k_in,
        CASE WHEN lt.type IN ('Principal','Interest') THEN lt.amount ELSE 0 END AS usd_out,
        0 AS fra_out, 0 AS k_out
      FROM loan_transactions lt
      LEFT JOIN loans l ON l.sync_id = lt.loan_sync_id
      WHERE lt.deleted_at IS NULL AND lt.tenant_id = ?${dateFilter.replace(/date/g, 'lt.date')}
      UNION ALL
      -- v1.10.42 — book-scope currency exchanges. Design memo in
      -- currencyExchanges.js:6-7 says they "affect the Cash Book running
      -- balance per currency directly", but this UNION never queried
      -- them. Each exchange decrements the from_currency and increments
      -- the to_currency. Legacy USD-equivalent balance is left at 0 since
      -- an exchange is a swap (net zero in USD-equiv terms).
      -- Append-only table so no deleted_at filter.
      SELECT date,
        'EXCH' AS type,
        'EXCH-' || id AS reference,
        'Exchange ' || from_currency || ' ' || CAST(from_amount AS INTEGER) ||
          ' → ' || to_currency || ' ' || CAST(to_amount AS INTEGER) ||
          COALESCE(' (' || NULLIF(notes,'') || ')', '') AS description,
        0 AS receipt_amount,
        0 AS payment_amount,
        CASE WHEN to_currency   = 'USD' THEN to_amount   ELSE 0 END AS usd_in,
        CASE WHEN to_currency   = 'FRA' THEN to_amount   ELSE 0 END AS fra_in,
        CASE WHEN to_currency   = 'K'   THEN to_amount   ELSE 0 END AS k_in,
        CASE WHEN from_currency = 'USD' THEN from_amount ELSE 0 END AS usd_out,
        CASE WHEN from_currency = 'FRA' THEN from_amount ELSE 0 END AS fra_out,
        CASE WHEN from_currency = 'K'   THEN from_amount ELSE 0 END AS k_out
      FROM currency_exchanges
      WHERE scope = 'book' AND tenant_id = ?${dateFilter}
      ORDER BY date ASC, reference ASC
    `).all(tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams);

    // v1.8.61 — HQ Deposit entries from master.db (cross-tenant).
    //   Branch ledger (from_slug = caller's slug)  → cash OUT  (payment_amount = amount)
    //   HQ ledger     (caller is HQ_INBOX_SLUGS)   → cash IN   (receipt_amount = amount)
    // Date uses COALESCE(deposit_date, confirmed_at, created_at) so
    // backdated entries land on the right line in the ledger.
    let depEntries = [];
    const slug = String(req.query.slug || '').toLowerCase();
    if (masterDb && slug) {
      try {
        const datePred = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
        const depDateFilter = (from && to) ? ` AND ${datePred} BETWEEN ? AND ?`
                            : from         ? ` AND ${datePred} >= ?`
                            : to           ? ` AND ${datePred} <= ?` : '';
        const depParams = (from && to) ? [from, to]
                        : from         ? [from]
                        : to           ? [to] : [];
        // Outgoing — this branch's own deposits.
        // v1.10.48 — also pull from_method so the ledger row description
        // labels which physical drawer the cash left (Liquor-only; NULL on
        // Sosna is harmless).
        const out = masterDb.prepare(`
          SELECT deposit_number, currency, amount, from_method,
                 COALESCE(deposit_date, date(COALESCE(confirmed_at, created_at))) AS date,
                 from_name, notes
            FROM cash_deposits
           WHERE status = 'CONFIRMED' AND from_slug = ?${depDateFilter}
        `).all(slug, ...depParams);
        for (const r of out) {
          const amt = parseFloat(r.amount);
          depEntries.push({
            date: r.date,
            type: 'DEP-OUT',
            reference: r.deposit_number,
            description: `Deposit to HQ — ${r.currency} ${Math.round(amt).toLocaleString()}${r.from_method ? ` from ${r.from_method}` : ''}${r.notes ? ` (${r.notes})` : ''}`,
            // Legacy fields kept for backwards-compat (USD-equivalent
            // not computed — only the native currency moves).
            receipt_amount: 0,
            payment_amount: r.currency === 'USD' ? amt : 0,
            currency: r.currency,
            // Per-currency split — populates the right column on the
            // new Cash Book table.
            usd_in: 0, fra_in: 0, k_in: 0,
            usd_out: r.currency === 'USD' ? amt : 0,
            fra_out: r.currency === 'FRA' ? amt : 0,
            k_out:   r.currency === 'K'   ? amt : 0,
          });
        }
        // Incoming — HQ only.
        if (HQ_INBOX_SLUGS.has(slug)) {
          const incoming = masterDb.prepare(`
            SELECT deposit_number, currency, amount,
                   COALESCE(deposit_date, date(COALESCE(confirmed_at, created_at))) AS date,
                   from_slug, from_name, notes
              FROM cash_deposits
             WHERE status = 'CONFIRMED'${depDateFilter}
          `).all(...depParams);
          for (const r of incoming) {
            const amt = parseFloat(r.amount);
            // v1.10.80 — Option A: slug in parens after the trading name.
            // Skip the paren when name is missing or already equals the
            // slug (avoids "lusaka1 (lusaka1)" noise).
            const nameLbl = r.from_name && r.from_name.toLowerCase() !== String(r.from_slug || '').toLowerCase()
              ? `${r.from_name} (${r.from_slug})`
              : (r.from_slug || r.from_name || 'branch');
            depEntries.push({
              date: r.date,
              type: 'DEP-IN',
              reference: r.deposit_number,
              description: `Deposit from ${nameLbl} — ${r.currency} ${Math.round(amt).toLocaleString()}${r.notes ? ` (${r.notes})` : ''}`,
              receipt_amount: r.currency === 'USD' ? amt : 0,
              payment_amount: 0,
              currency: r.currency,
              usd_in: r.currency === 'USD' ? amt : 0,
              fra_in: r.currency === 'FRA' ? amt : 0,
              k_in:   r.currency === 'K'   ? amt : 0,
              usd_out: 0, fra_out: 0, k_out: 0,
            });
          }
        }
      } catch (e) { /* non-fatal */ }
    }

    // Merge + chronological sort.
    const merged = [...entries, ...depEntries].sort((a, b) => {
      const aDate = String(a.date || '');
      const bDate = String(b.date || '');
      if (aDate !== bDate) return aDate < bDate ? -1 : 1;
      return String(a.reference || '').localeCompare(String(b.reference || ''));
    });

    // v1.8.62 — per-currency running balance. Each row carries its
    // closing USD / FRA / K balance after the row applied. The legacy
    // single-$ `balance` field stays for backwards compat (sums the
    // USD-equivalent legacy receipt/payment columns).
    // v1.10.25 — fold pre-period activity into openingByCcy so opening on
    // day N = closing on day N-1. Previously we only folded openingByMethod,
    // so per-currency opening stayed at the install-time seed regardless of
    // date filter → Jul 2 showed Jul 1's opening instead of Jul 1's closing.
    let openingByCcy = getOpeningByCurrency(tenantId);
    if (from) {
      const before = ccyReceiptsPayments(tenantId, slug, ' AND date < ?', [from]);
      openingByCcy = {
        usd: openingByCcy.usd + before.receipts.usd - before.payments.usd,
        fra: openingByCcy.fra + before.receipts.fra - before.payments.fra,
        k:   openingByCcy.k   + before.receipts.k   - before.payments.k,
      };
    }
    let balance = openingBalance;
    let bUsd = openingByCcy.usd;
    let bFra = openingByCcy.fra;
    let bK   = openingByCcy.k;
    const rows = merged.map((e, i) => {
      balance = balance + parseFloat(e.receipt_amount) - parseFloat(e.payment_amount);
      bUsd = bUsd + parseFloat(e.usd_in || 0) - parseFloat(e.usd_out || 0);
      bFra = bFra + parseFloat(e.fra_in || 0) - parseFloat(e.fra_out || 0);
      bK   = bK   + parseFloat(e.k_in   || 0) - parseFloat(e.k_out   || 0);
      return { ...e, id: i + 1, balance, balance_usd: bUsd, balance_fra: bFra, balance_k: bK };
    });

    res.json({
      openingBalance, openingByMethod, openingByCcy,
      closingByCcy: { usd: bUsd, fra: bFra, k: bK },
      entries: rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats — per-method receipts, payments, and balances (the cards on the page)
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const opening = getOpeningByMethod(tenantId);
    const { from, to } = req.query;
    const df = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const dp = [...(from ? [from] : []), ...(to ? [to] : [])];

    // Period inflows/outflows for each method
    const cash = sumMethod(tenantId, 'cash_amount', df, dp);
    const bank = sumMethod(tenantId, 'bank_amount', df, dp);
    const momo = sumMethod(tenantId, 'momo_amount', df, dp);

    // Folded openings (carry pre-period activity into the opening when a `from` is set)
    let openingByMethod = { ...opening };
    if (from) {
      ['cash_amount', 'bank_amount', 'momo_amount'].forEach((col) => {
        const key = col.replace('_amount', '');
        const b = sumMethod(tenantId, col, ' AND date < ?', [from]);
        openingByMethod[key] = openingByMethod[key]
          + b.cr + b.capIn + b.loanIn
          - b.pv - b.ap - b.capOut - b.div - b.loanPrin - b.loanInt
          + b.transferNet;
      });
      // v1.10.49 — subtract pre-period deposits per drawer so Jul-2's
      // opening tiles reflect Jul-1's closing. Same shape as v1.10.48's
      // current-day adjustment, applied to the fold instead. Needs
      // masterDb + slug — read them out of the enclosing /stats scope.
      const slugForFold = String(req.query.slug || '').toLowerCase();
      if (masterDb && slugForFold) {
        try {
          const datePredFold = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
          const preDepRows = masterDb.prepare(`
            SELECT COALESCE(from_method, 'Cash') AS m, COALESCE(SUM(amount), 0) AS t
              FROM cash_deposits
             WHERE status = 'CONFIRMED' AND from_slug = ?
               AND ${datePredFold} < ?
             GROUP BY COALESCE(from_method, 'Cash')
          `).all(slugForFold, from);
          for (const r of preDepRows) {
            const key = r.m === 'Mobile Money' ? 'momo' : r.m === 'Bank' ? 'bank' : 'cash';
            openingByMethod[key] -= parseFloat(r.t);
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    const currentByMethod = {
      cash: openingByMethod.cash + cash.cr + cash.capIn + cash.loanIn - cash.pv - cash.ap - cash.capOut - cash.div - cash.loanPrin - cash.loanInt + cash.transferNet,
      bank: openingByMethod.bank + bank.cr + bank.capIn + bank.loanIn - bank.pv - bank.ap - bank.capOut - bank.div - bank.loanPrin - bank.loanInt + bank.transferNet,
      momo: openingByMethod.momo + momo.cr + momo.capIn + momo.loanIn - momo.pv - momo.ap - momo.capOut - momo.div - momo.loanPrin - momo.loanInt + momo.transferNet,
    };
    const totalReceipts   = cash.cr + bank.cr + momo.cr;
    const totalPV         = cash.pv + bank.pv + momo.pv;
    const totalAP         = cash.ap + bank.ap + momo.ap;
    const totalCapIn      = cash.capIn  + bank.capIn  + momo.capIn;
    const totalCapOut     = cash.capOut + bank.capOut + momo.capOut;
    const totalDividend   = cash.div    + bank.div    + momo.div;
    const totalLoanIn     = cash.loanIn   + bank.loanIn   + momo.loanIn;
    const totalLoanPrin   = cash.loanPrin + bank.loanPrin + momo.loanPrin;
    const totalLoanInt    = cash.loanInt  + bank.loanInt  + momo.loanInt;
    const totalPayments   = totalPV + totalAP + totalCapOut + totalDividend + totalLoanPrin + totalLoanInt;
    const openingBalance = openingByMethod.cash + openingByMethod.bank + openingByMethod.momo;
    const currentBalance = currentByMethod.cash + currentByMethod.bank + currentByMethod.momo;

    // v1.8.62 — per-currency stats (USD/FRA/K) for the dashboard cards.
    // Reads usd_amount / fra_amount / k_amount with fallback to legacy
    // cash_amount (= USD) so single-currency tenants still total correctly.
    // Also pulls today's confirmed HQ Deposits from master.db (subtract
    // outgoing from branch / add incoming for HQ) so the cards stay in
    // sync with the ledger entries endpoint.
    const slug = String(req.query.slug || '').toLowerCase();
    const sumCcy = (table, dateCol, col) => {
      const usdExpr = `CASE WHEN COALESCE(${col === 'cash_amount' ? 'usd_amount' : col + '_TODO'},0) > 0 THEN ${col === 'cash_amount' ? 'usd_amount' : col} ELSE COALESCE(${col === 'cash_amount' ? 'cash_amount' : col},0) END`;
      // Simpler: always pick the USD value via COALESCE.
      const usd = db.prepare(`SELECT COALESCE(SUM(CASE WHEN COALESCE(usd_amount,0)>0 THEN usd_amount ELSE COALESCE(cash_amount,0) END), 0) AS t FROM ${table} WHERE deleted_at IS NULL AND tenant_id = ?${df.replace(/date/g, dateCol)}`).get(tenantId, ...dp).t;
      const fra = db.prepare(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM ${table} WHERE deleted_at IS NULL AND tenant_id = ?${df.replace(/date/g, dateCol)}`).get(tenantId, ...dp).t;
      const kAmt= db.prepare(`SELECT COALESCE(SUM(k_amount), 0) AS t FROM ${table} WHERE deleted_at IS NULL AND tenant_id = ?${df.replace(/date/g, dateCol)}`).get(tenantId, ...dp).t;
      return { usd: parseFloat(usd), fra: parseFloat(fra), k: parseFloat(kAmt) };
    };
    const crByCcy = sumCcy('cash_receipts',    'date');
    const pvByCcy = sumCcy('payment_vouchers', 'date');
    // v1.10.79 — AP now splits by currency, matching CR/PV. Previous code
    // lumped every ap_payments.amount into apUsd (subtracting from the USD
    // balance card) AND never touched the K balance card. Now:
    //   apByCcy.usd += usd_amount (or amount for legacy rows w/ no split)
    //   apByCcy.fra += fra_amount
    //   apByCcy.k   += k_amount   (or amount for legacy)
    const apByCcy = (() => {
      const row = db.prepare(`
        SELECT
          COALESCE(SUM(usd_amount), 0) AS usd_ccy,
          COALESCE(SUM(fra_amount), 0) AS fra_ccy,
          COALESCE(SUM(k_amount),   0) AS k_ccy,
          COALESCE(SUM(CASE WHEN (COALESCE(usd_amount,0)+COALESCE(fra_amount,0)+COALESCE(k_amount,0)) = 0
                             THEN amount ELSE 0 END), 0) AS legacy_amount
        FROM ap_payments
        WHERE deleted_at IS NULL AND tenant_id = ?${df}
      `).get(tenantId, ...dp);
      // Route legacy rows to K (matches v1.10.77 default: HQ + Liquor are K-primary).
      return {
        usd: parseFloat(row.usd_ccy),
        fra: parseFloat(row.fra_ccy),
        k:   parseFloat(row.k_ccy) + parseFloat(row.legacy_amount),
      };
    })();
    // POS sales — orders.cash_received / fra_received / k_received.
    const ordersUsd = db.prepare(`SELECT COALESCE(SUM(cash_received), 0) AS t FROM orders WHERE deleted_at IS NULL AND tenant_id = ? AND (status IS NULL OR status IN ('PAID','DISPATCHED'))${df.replace(/date/g, 'paid_at')}`).get(tenantId, ...dp).t;
    const ordersFra = db.prepare(`SELECT COALESCE(SUM(fra_received), 0) AS t FROM orders WHERE deleted_at IS NULL AND tenant_id = ? AND (status IS NULL OR status IN ('PAID','DISPATCHED'))${df.replace(/date/g, 'paid_at')}`).get(tenantId, ...dp).t;
    const ordersK   = db.prepare(`SELECT COALESCE(SUM(k_received), 0)   AS t FROM orders WHERE deleted_at IS NULL AND tenant_id = ? AND (status IS NULL OR status IN ('PAID','DISPATCHED'))${df.replace(/date/g, 'paid_at')}`).get(tenantId, ...dp).t;

    // HQ Deposits from master.db.
    let depInByCcy  = { usd: 0, fra: 0, k: 0 };
    let depOutByCcy = { usd: 0, fra: 0, k: 0 };
    // v1.10.48 — per-method Liquor rollup: which physical drawer the
    // deposit came out of on a Liquor branch. Populated only for outgoing
    // (branch → HQ); incoming HQ deposits stay method-less.
    let depOutByMethod = { cash: 0, momo: 0, bank: 0 };
    if (masterDb && slug) {
      try {
        const datePred = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
        const depDf = (from && to) ? ` AND ${datePred} BETWEEN ? AND ?`
                    : from         ? ` AND ${datePred} >= ?`
                    : to           ? ` AND ${datePred} <= ?` : '';
        const depParams = (from && to) ? [from, to] : from ? [from] : to ? [to] : [];
        const outRows = masterDb.prepare(`
          SELECT currency, COALESCE(SUM(amount), 0) AS t
            FROM cash_deposits
           WHERE status = 'CONFIRMED' AND from_slug = ?${depDf}
           GROUP BY currency
        `).all(slug, ...depParams);
        for (const r of outRows) {
          const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
          depOutByCcy[key] += parseFloat(r.t);
        }
        // v1.10.48 — also aggregate per-method for Liquor tile decrement.
        // NULL from_method (legacy rows or Sosna deposits) falls back to
        // 'Cash' so nothing goes unaccounted for.
        const outByMethodRows = masterDb.prepare(`
          SELECT COALESCE(from_method, 'Cash') AS m, COALESCE(SUM(amount), 0) AS t
            FROM cash_deposits
           WHERE status = 'CONFIRMED' AND from_slug = ?${depDf}
           GROUP BY COALESCE(from_method, 'Cash')
        `).all(slug, ...depParams);
        for (const r of outByMethodRows) {
          const key = r.m === 'Mobile Money' ? 'momo' : r.m === 'Bank' ? 'bank' : 'cash';
          depOutByMethod[key] += parseFloat(r.t);
        }
        if (HQ_INBOX_SLUGS.has(slug)) {
          const inRows = masterDb.prepare(`
            SELECT currency, COALESCE(SUM(amount), 0) AS t
              FROM cash_deposits
             WHERE status = 'CONFIRMED'${depDf}
             GROUP BY currency
          `).all(...depParams);
          for (const r of inRows) {
            const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
            depInByCcy[key] += parseFloat(r.t);
          }
        }
      } catch (_) { /* non-fatal */ }
    }

    // v1.10.42 — book-scope currency exchanges (in-range). Same convention
    // as the ledger UNION and the fold helper: from_currency → payments,
    // to_currency → receipts. Append-only table so no deleted_at filter.
    const exchInRange = db.prepare(`
      SELECT from_currency, from_amount, to_currency, to_amount
        FROM currency_exchanges
       WHERE scope = 'book' AND tenant_id = ?${df}
    `).all(tenantId, ...dp);
    const exchIn  = { usd: 0, fra: 0, k: 0 };
    const exchOut = { usd: 0, fra: 0, k: 0 };
    for (const r of exchInRange) {
      const fromKey = r.from_currency === 'USD' ? 'usd' : r.from_currency === 'FRA' ? 'fra' : 'k';
      const toKey   = r.to_currency   === 'USD' ? 'usd' : r.to_currency   === 'FRA' ? 'fra' : 'k';
      exchOut[fromKey] += parseFloat(r.from_amount || 0);
      exchIn[toKey]    += parseFloat(r.to_amount   || 0);
    }
    // v1.10.48 — subtract Liquor-method deposits from the per-method tiles.
    // currentByMethod was computed above from cash_receipts / PV / etc.
    // without any awareness of cash_deposits; now that we've fetched
    // depOutByMethod, apply it so the Cash on Hand / Mobile Money / Bank
    // tiles reflect real drawer state on Liquor branches. Sosna deposits
    // land in 'cash' by our COALESCE default — harmless because Sosna's
    // Cash Book doesn't render per-method tiles.
    currentByMethod.cash -= depOutByMethod.cash;
    currentByMethod.momo -= depOutByMethod.momo;
    currentByMethod.bank -= depOutByMethod.bank;
    // Per-currency receipts / payments roll-up.
    const receiptsByCcy = {
      usd: ordersUsd + crByCcy.usd + depInByCcy.usd + exchIn.usd,
      fra: ordersFra + crByCcy.fra + depInByCcy.fra + exchIn.fra,
      k:   ordersK   + crByCcy.k   + depInByCcy.k   + exchIn.k,
    };
    const paymentsByCcy = {
      // v1.10.79 — AP now contributes per-currency (was apUsd — a single
      // sum dumped into USD). apByCcy.k picks up the ALASKAL K32,000 so
      // the K balance card actually drops when a supplier is paid in K.
      usd: pvByCcy.usd + apByCcy.usd + depOutByCcy.usd + exchOut.usd,
      fra: pvByCcy.fra + apByCcy.fra + depOutByCcy.fra + exchOut.fra,
      k:   pvByCcy.k   + apByCcy.k   + depOutByCcy.k   + exchOut.k,
    };
    // Per-currency closing balance = opening + receipts − payments.
    // v1.10.25 — fold pre-period activity into openingByCcy when `from`
    // is set (mirrors what /stats already does for openingByMethod). Without
    // this, Jul 2's opening tile still reads Jul 1's opening seed, so
    // "Opening" and "Current" on day 2 don't reflect day 1's real close.
    let openingByCcy = getOpeningByCurrency(tenantId);
    if (from) {
      const before = ccyReceiptsPayments(tenantId, slug, ' AND date < ?', [from]);
      openingByCcy = {
        usd: openingByCcy.usd + before.receipts.usd - before.payments.usd,
        fra: openingByCcy.fra + before.receipts.fra - before.payments.fra,
        k:   openingByCcy.k   + before.receipts.k   - before.payments.k,
      };
    }
    const currentByCcy = {
      usd: openingByCcy.usd + receiptsByCcy.usd - paymentsByCcy.usd,
      fra: openingByCcy.fra + receiptsByCcy.fra - paymentsByCcy.fra,
      k:   openingByCcy.k   + receiptsByCcy.k   - paymentsByCcy.k,
    };

    res.json({
      openingBalance, openingByMethod,
      totalReceipts, totalPV, totalAP, totalPayments,
      totalCapIn, totalCapOut, totalDividend,
      totalLoanIn, totalLoanPrin, totalLoanInt,
      currentBalance, currentByMethod,
      methodFlows: { cash, bank, momo },
      // v1.8.62 — per-currency cards for the Sosna Cash Book dashboard.
      openingByCcy, receiptsByCcy, paymentsByCcy, currentByCcy,
      depositsByCcy: { in: depInByCcy, out: depOutByCcy },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set opening balance(s).
// Accepts:
//   { usd, fra, k }                — v1.8.62 per-currency (Sosna)
//   { cash, bank, momo }           — legacy per-method
//   { amount }                     — legacy single Cash opening
router.post('/opening-balance', auth, (req, res) => {
  try {
    const { amount, cash, bank, momo, usd, fra, k } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    const usingCcy   = usd  !== undefined || fra  !== undefined || k    !== undefined;
    const usingSplit = cash !== undefined || bank !== undefined || momo !== undefined;
    let buckets;
    if (usingCcy) {
      buckets = [
        { ref: 'OB-USD', amount: parseFloat(usd || 0) || 0 },
        { ref: 'OB-FRA', amount: parseFloat(fra || 0) || 0 },
        { ref: 'OB-K',   amount: parseFloat(k   || 0) || 0 },
      ];
    } else if (usingSplit) {
      buckets = [
        { ref: 'OB-CASH', amount: parseFloat(cash || 0) || 0 },
        { ref: 'OB-BANK', amount: parseFloat(bank || 0) || 0 },
        { ref: 'OB-MOMO', amount: parseFloat(momo || 0) || 0 },
      ];
    } else {
      buckets = [{ ref: 'OB-CASH', amount: parseFloat(amount || 0) || 0 }];
    }

    db.transaction(() => {
      db.prepare("DELETE FROM cash_book WHERE type = 'opening' AND tenant_id = ?").run(tenantId);
      const ins = db.prepare(`
        INSERT INTO cash_book (date, description, reference, receipt_amount, payment_amount, balance,
                               type, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (DATE('now'), ?, ?, ?, 0, ?, 'opening', ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      `);
      for (const b of buckets) {
        const label = b.ref === 'OB-BANK' ? 'Opening Bank Balance'
                    : b.ref === 'OB-MOMO' ? 'Opening MoMo Balance'
                    : b.ref === 'OB-USD'  ? 'Opening USD Balance'
                    : b.ref === 'OB-FRA'  ? 'Opening FRA Balance'
                    : b.ref === 'OB-K'    ? 'Opening K Balance'
                    : 'Opening Cash Balance';
        ins.run(label, b.ref, b.amount, b.amount, randomUUID(), tenantId, branchId, deviceId);
      }
    })();

    res.json({
      success: true,
      openingByMethod: getOpeningByMethod(tenantId),
      openingByCcy:    getOpeningByCurrency(tenantId),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Cash Transfers ──────────────────────────────────────────────────────────
// Money moved between methods (Cash <-> Bank <-> Mobile Money). Total cash on
// hand is unchanged; only the per-method breakdown shifts.

const VALID_METHODS = new Set(['Cash', 'Bank', 'Mobile Money']);

// List transfers
router.get('/transfers', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM cash_transfers t
      LEFT JOIN users u ON u.id = t.created_by
      WHERE t.deleted_at IS NULL AND t.tenant_id = ?
      ORDER BY t.date DESC, t.id DESC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create transfer
router.post('/transfers', auth, (req, res) => {
  try {
    const { date, from_method, to_method, amount, description } = req.body;
    if (!VALID_METHODS.has(from_method)) return res.status(400).json({ error: 'Invalid from_method.' });
    if (!VALID_METHODS.has(to_method))   return res.status(400).json({ error: 'Invalid to_method.' });
    if (from_method === to_method)       return res.status(400).json({ error: 'From and To must be different.' });
    const amt = parseFloat(amount || 0);
    if (!(amt > 0))                       return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const transferNum = syncConfig.generateNumber('TRF', 'cash_transfers');
    const transferDate = date || new Date().toISOString().split('T')[0];

    const info = db.prepare(`
      INSERT INTO cash_transfers (transfer_number, date, from_method, to_method, amount, description, created_by,
                                   sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(transferNum, transferDate, from_method, to_method, amt, description || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM cash_transfers WHERE id = ?').get(info.lastInsertRowid));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete transfer (soft delete)
router.delete('/transfers/:id', auth, (req, res) => {
  try {
    db.prepare("UPDATE cash_transfers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Transfer deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
