/**
 * hq.js — HQ (head-office) endpoints served at the bare sosnazm.com domain.
 *
 * Phase B v1 surfaces:
 *   GET /api/hq/branches  — public list of registered tenant slugs so the
 *                           HQ login page can render a branch picker. No
 *                           auth required; the response is just slugs +
 *                           display names, no secrets.
 *
 * Future endpoints (Phase D — consolidated reports) will live here too and
 * use the same X-Branch header pattern to read across all tenant DBs.
 *
 * Why a dedicated router instead of extending tenantAdmin: tenantAdmin is
 * gated by the central ADMIN_PASSWORD (used by sidanitsolutions.com to
 * manage tenants), which would prevent the public HQ login screen from
 * fetching the branches list. HQ endpoints have their own auth model.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { listTenants, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { defaultDb }   = require('../config/database');
const { mirrorAllHqToBranches } = require('../middleware/hqPush');

// HQ admin auth — same JWT model the per-branch app uses. The token comes
// from whichever branch the user picked at login; we trust it as proof of
// identity and don't enforce any per-branch role check here (the user
// already has admin powers on the branch they're signed into, and HQ
// overview is read-only aggregation).
function hqAuth(req, res, next) {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Access denied' });
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'sosna-pro-secret-key-2026');
    next();
  } catch (_) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Safe-int helper — bails to 0 if the column is missing on an older DB.
function tryGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...(Array.isArray(params) ? params : [params])); }
  catch { return null; }
}

// GET /api/hq/branches — list registered tenants for the HQ login picker.
// Returns at most slug + business_name + currency_mode. Anything that
// would help an attacker target a specific branch (status counts,
// license expiry, etc.) stays out — that's tenantAdmin territory.
// v1.10.54 — currency_mode added so the HQ Purchase / Send Transfer
// modals can decide whether to prompt for an FX rate. K-only branches
// (Mansa, Lusaka) get no prompt; tri-currency (Kassumbalesa) requires
// one rate per whole PO / transfer. Read once per branch DB, cheap.
router.get('/branches', (req, res) => {
  try {
    const rows = listTenants();
    const enriched = rows.map(r => {
      let currencyMode = 'K';
      try {
        const db = getTenantDb(r.slug);
        const s = db.prepare(`SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`).get();
        if (s?.currency_mode) currencyMode = String(s.currency_mode).toUpperCase();
      } catch { /* branch DB unavailable — default K */ }
      return {
        slug: r.slug,
        name: r.business_name || r.slug,
        currency_mode: currencyMode,
      };
    });
    res.json({ branches: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/overview — per-branch summary card data + roll-up totals.
// Iterates each registered tenant, opens its DB (cached via getTenantDb),
// and runs a handful of cheap aggregations. Designed to be the "front
// page" of HQ so the operator gets a one-screen view of every branch's
// day at a glance. Today = midnight to now in the server's local TZ.
router.get('/overview', hqAuth, (req, res) => {
  try {
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const tenants = listTenants();
    const branches = [];

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);

        // Today's sales — completed orders only (status NULL = single_pos
        // sale, status='DISPATCHED' = 3-station completed). PAID-but-not-
        // dispatched orders are revenue-realised at Cashier but not yet
        // fully closed; we count them too because Cashier collected cash.
        const salesToday = tryGet(db, `
          SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                 COUNT(*)                       AS orders
            FROM orders
           WHERE deleted_at IS NULL
             AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
             AND substr(COALESCE(paid_at, created_at), 1, 10) = ?
        `, [todayPrefix]) || { revenue: 0, orders: 0 };

        // Sales month-to-date for trend context.
        const salesMTD = tryGet(db, `
          SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                 COUNT(*)                       AS orders
            FROM orders
           WHERE deleted_at IS NULL
             AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
             AND substr(COALESCE(paid_at, created_at), 1, 7) = ?
        `, [todayPrefix.slice(0, 7)]) || { revenue: 0, orders: 0 };

        // 3-station queue depths (NULL on single_pos branches).
        const pendingPayment  = tryGet(db, `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PENDING_PAYMENT'`)?.n || 0;
        const awaitingDispatch= tryGet(db, `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PAID'`)?.n || 0;

        // Stock value at sales floor — sum(current_stock * cost_price) on
        // products that aren't soft-deleted.
        const stockValue = tryGet(db, `
          SELECT COALESCE(SUM(current_stock * cost_price), 0) AS v
            FROM products
           WHERE deleted_at IS NULL
        `)?.v || 0;
        const stockLowCount = tryGet(db, `
          SELECT COUNT(*) AS n
            FROM products
           WHERE deleted_at IS NULL AND current_stock <= min_stock
        `)?.n || 0;

        // Outstanding AR — credit sales that haven't been collected.
        const arOutstanding = tryGet(db, `
          SELECT COALESCE(
            (SELECT SUM(total_amount - COALESCE(amount_received,0)) FROM orders
              WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
                AND total_amount > COALESCE(amount_received,0)) -
            (SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE deleted_at IS NULL),
            0
          ) AS ar
        `)?.ar || 0;

        // Branch business settings — currency_mode / workflow_mode so the
        // dashboard can flag dual-currency / 3-station branches at a glance.
        // v1.10.147: also pull business_address so the HQ card shows the
        // branch's actual location under the business name.
        const settings = tryGet(db, `
          SELECT business_name, business_address, currency_mode, workflow_mode
            FROM business_settings
           ORDER BY id ASC LIMIT 1
        `) || {};

        branches.push({
          slug: t.slug,
          name: settings.business_name || t.business_name || t.slug,
          address: settings.business_address || '',
          currency_mode: settings.currency_mode || 'K',
          workflow_mode: settings.workflow_mode || 'single_pos',
          today: { revenue: salesToday.revenue, orders: salesToday.orders },
          mtd:   { revenue: salesMTD.revenue,   orders: salesMTD.orders },
          pending_payment:   pendingPayment,
          awaiting_dispatch: awaitingDispatch,
          stock_value:       stockValue,
          stock_low_count:   stockLowCount,
          ar_outstanding:    Math.max(0, arOutstanding),
        });
      } catch (e) {
        branches.push({ slug: t.slug, name: t.business_name || t.slug, error: e.message });
      }
    }

    // v1.10.146 — Roll-up money KPIs per-currency instead of one mixed sum.
    // Kwacha branches (Mansa/Lusaka) go into K bucket; dual-currency branches
    // (Kassumbalesa) go into USD (their primary). Counts (pending_payment,
    // awaiting_dispatch) stay global — they're not money.
    // primaryCurrency: 'K' | 'USD' (FRA is transactional-only, never primary).
    const primaryFor = (b) => (b.currency_mode === 'K' ? 'K' : 'USD');
    const emptyBucket = () => ({
      today_revenue: 0, today_orders: 0,
      mtd_revenue: 0,   mtd_orders: 0,
      stock_value: 0,   ar_outstanding: 0,
    });
    const by_currency = { USD: emptyBucket(), K: emptyBucket() };
    let pending_payment = 0, awaiting_dispatch = 0;
    for (const b of branches) {
      if (b.error) continue;
      const cur = primaryFor(b);
      const bucket = by_currency[cur] || (by_currency[cur] = emptyBucket());
      bucket.today_revenue   += b.today.revenue;
      bucket.today_orders    += b.today.orders;
      bucket.mtd_revenue     += b.mtd.revenue;
      bucket.mtd_orders      += b.mtd.orders;
      bucket.stock_value     += b.stock_value;
      bucket.ar_outstanding  += b.ar_outstanding;
      pending_payment   += b.pending_payment;
      awaiting_dispatch += b.awaiting_dispatch;
    }
    const rollup = { by_currency, pending_payment, awaiting_dispatch };

    res.json({ as_of: new Date().toISOString(), branches, rollup });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD&branch=slug
// Cross-branch order list with date + branch filters. Default range is
// today only; pass `branch=all` (or omit) to span every registered tenant.
// Sorted newest first; capped at 1000 rows so a busy multi-month query
// can't blow up the response. Each row carries its branch slug + name so
// the table can render origin without a second lookup.
router.get('/sales-report', hqAuth, (req, res) => {
  try {
    const from   = (req.query.from   || new Date().toISOString().slice(0, 10)).toString();
    const to     = (req.query.to     || from).toString();
    const branch = (req.query.branch || 'all').toString().toLowerCase();
    const LIMIT  = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);

    // We compare ISO date prefixes (YYYY-MM-DD) so timestamps with a time
    // component still bucket correctly. `to` is inclusive: a created_at of
    // '2026-06-19 23:59:30' falls under to='2026-06-19'.
    const tenants = listTenants().filter(t => branch === 'all' || t.slug === branch);
    const rows = [];

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const branchName = settings.business_name || t.business_name || t.slug;

        // Every column from `orders` must be prefixed with `o.` — id, status,
        // and created_at all collide with users columns, and better-sqlite3
        // throws "ambiguous column name" on the unprefixed form (vanilla
        // sqlite CLI silently picks one, which is what hid this in dev).
        const orders = db.prepare(`
          SELECT o.id, o.order_number, o.customer_name, o.total_amount, o.amount_received,
                 o.change_amount, o.payment_method, o.status, o.currency,
                 o.created_at, o.paid_at, o.dispatched_at,
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS created_by_name
            FROM orders o
            LEFT JOIN users u ON u.sync_id = o.created_by_sync_id
                              OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
           WHERE o.deleted_at IS NULL
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) >= ?
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) <= ?
             AND (o.status IS NULL OR o.status != 'Reversed')
           ORDER BY COALESCE(o.paid_at, o.created_at) DESC
           LIMIT ?
        `).all(from, to, LIMIT);

        for (const o of orders) {
          rows.push({
            ...o,
            branch_slug: t.slug,
            branch_name: branchName,
          });
        }
      } catch (e) {
        // Skip branches that error out — they'll show up missing rather
        // than failing the whole report.
        console.error(`[hq.sales-report] ${t.slug}:`, e.message);
      }
    }

    // Sort the combined list by paid_at|created_at desc and trim to LIMIT.
    rows.sort((a, b) => {
      const av = a.paid_at || a.created_at || '';
      const bv = b.paid_at || b.created_at || '';
      return bv.localeCompare(av);
    });
    const capped = rows.slice(0, LIMIT);

    // Totals across whatever survived the filters.
    const totals = capped.reduce((acc, r) => {
      acc.orders += 1;
      acc.revenue += parseFloat(r.total_amount || 0);
      acc.received += parseFloat(r.amount_received || 0);
      acc.by_branch[r.branch_slug] = acc.by_branch[r.branch_slug] || { name: r.branch_name, orders: 0, revenue: 0 };
      acc.by_branch[r.branch_slug].orders  += 1;
      acc.by_branch[r.branch_slug].revenue += parseFloat(r.total_amount || 0);
      return acc;
    }, { orders: 0, revenue: 0, received: 0, by_branch: {} });

    res.json({
      from, to, branch,
      total_rows: rows.length,
      returned_rows: capped.length,
      truncated: rows.length > capped.length,
      totals,
      orders: capped,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/inventory-report?branch=&low_only=&q=
// Cross-branch stock list — one row per product per branch. Capped at
// 2000 rows so a catalog explosion can't blow up the JSON.
//   branch    — slug or 'all' (default)
//   low_only  — '1' = only rows where current_stock <= min_stock
//   q         — substring match on product name (case-insensitive)
// Returns: per-branch summary (count, value, low-count) + flat rows.
router.get('/inventory-report', hqAuth, (req, res) => {
  try {
    const branch  = (req.query.branch || 'all').toString().toLowerCase();
    const lowOnly = req.query.low_only === '1' || req.query.low_only === 'true';
    const q       = (req.query.q || '').toString().trim().toLowerCase();
    const LIMIT   = Math.min(parseInt(req.query.limit, 10) || 2000, 5000);

    const tenants = listTenants().filter(t => branch === 'all' || t.slug === branch);
    const rows = [];
    const byBranch = {};

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        // v1.10.149 — pull currency_mode so the frontend can show K vs $ per
        // branch instead of hard-coding a $ prefix. K-only Liquor branches
        // (Lusaka/Mansa) return 'K'; tri-currency Kassumbalesa returns the
        // USD-base symbol.
        const settings = tryGet(db, `SELECT business_name, currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const branchName = settings.business_name || t.business_name || t.slug;
        const currencyMode = settings.currency_mode || 'K';
        // Money on the branch DB is stored in its primary drawer currency:
        //   'K'          → K (Liquor)
        //   'USD+FRA'    → USD (Kassumbalesa)
        //   'USD+FRA+K'  → USD (tri-currency also stores base as USD)
        const currency = currencyMode === 'K' ? 'K' : 'USD';
        byBranch[t.slug] = { name: branchName, products: 0, low: 0, stock_value: 0, currency, currency_mode: currencyMode };

        // Pull active products + category for context.
        // v1.10.149 — also read units_json so the frontend can convert the
        // raw base-unit current_stock into the largest unit + remainder
        // (e.g. 14,046 Bottle → 585 Box + 6 Bottle when 1 Box = 24 Bottles).
        let sql = `
          SELECT p.id, p.name, p.unit, p.current_stock, p.min_stock,
                 p.cost_price, p.selling_price, p.status, p.units_json,
                 c.name AS category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.deleted_at IS NULL`;
        const params = [];
        if (lowOnly) sql += ' AND p.current_stock <= p.min_stock';
        if (q)       { sql += ' AND LOWER(p.name) LIKE ?'; params.push(`%${q}%`); }
        sql += ' ORDER BY (p.current_stock * p.cost_price) DESC';
        const products = db.prepare(sql).all(...params);

        for (const p of products) {
          const stock = parseFloat(p.current_stock || 0);
          const min   = parseFloat(p.min_stock || 0);
          const cost  = parseFloat(p.cost_price || 0);
          const value = stock * cost;
          const isLow = stock <= min;
          byBranch[t.slug].products    += 1;
          byBranch[t.slug].stock_value += value;
          if (isLow) byBranch[t.slug].low += 1;
          rows.push({
            branch_slug: t.slug,
            branch_name: branchName,
            product_id:  p.id,
            name:        p.name,
            category:    p.category_name || '—',
            unit:        p.unit || '',
            units_json:  p.units_json || null,
            current_stock: stock,
            min_stock:   min,
            cost_price:  cost,
            selling_price: parseFloat(p.selling_price || 0),
            value,
            low: isLow,
            status: p.status || 'Active',
            currency,
          });
        }
      } catch (e) {
        console.error(`[hq.inventory-report] ${t.slug}:`, e.message);
      }
    }

    // Sort combined list by value desc and cap.
    rows.sort((a, b) => b.value - a.value);
    const capped = rows.slice(0, LIMIT);

    // v1.10.149 — split stock_value by currency so USD (Kassumbalesa) and K
    // (Lusaka/Mansa) never get summed into a fake single number. Legacy
    // `stock_value` field kept for backwards compat but callers should
    // prefer `stock_value_by_currency`.
    const rollup = Object.values(byBranch).reduce((acc, b) => {
      acc.products    += b.products;
      acc.stock_value += b.stock_value;
      acc.low         += b.low;
      const c = b.currency || 'USD';
      acc.stock_value_by_currency[c] = (acc.stock_value_by_currency[c] || 0) + b.stock_value;
      return acc;
    }, { products: 0, stock_value: 0, low: 0, stock_value_by_currency: {} });

    res.json({
      branch, low_only: lowOnly, q,
      total_rows: rows.length,
      returned_rows: capped.length,
      truncated: rows.length > capped.length,
      rollup,
      by_branch: byBranch,
      rows: capped,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/cash-position
// Per-branch + rollup cash movement per method (Cash / Bank / MoMo) for
// today and month-to-date. Built from the same primary sources the
// per-branch Cash Report reads: orders (POS receipts), customer_payments
// (AR collected), cash_receipts (manual CR), payment_vouchers (manual
// PV), ap_payments (supplier paid).
//
//   Cash IN  = orders.cash_received + cash_receipts.cash_amount
//              + customer_payments.cash_amount
//   Cash OUT = payment_vouchers.cash_amount + ap_payments.cash_amount
//   Net      = IN - OUT      (same shape for bank_amount + momo_amount)
//
// All sums use COALESCE so old rows without the split columns drop to 0
// instead of NULLing the whole reduce.
router.get('/cash-position', hqAuth, (req, res) => {
  try {
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const monthPrefix = todayPrefix.slice(0, 7);
    const tenants = listTenants();

    // v1.8.61 — Sosna is cash-only across 3 currencies (USD / FRA / K).
    // Switch the buckets from Cash / Bank / MoMo to USD / FRA / K and
    // read the per-currency columns. usd_amount / fra_amount / k_amount
    // on cash_receipts / payment_vouchers / customer_payments are the
    // post-v1.7.0 columns; cash_amount / bank_amount / momo_amount stay
    // populated on legacy rows. Use a COALESCE fallback so single-currency
    // tenants (lusaka1, mansa1 — bank/momo never enter the picture) still
    // total correctly via the legacy column.
    // v1.10.153 — two fixes:
    //   (a) COALESCE(paid_at, created_at) on the date bucket. single_pos
    //       orders (Mansa, Lusaka) never set paid_at, so the previous
    //       filter excluded 100% of their sales from Today AND MTD.
    //   (b) Route amounts by branch currency_mode:
    //       - K-only (Mansa, Lusaka): cash_received holds K, not USD. All
    //         cash / momo / bank / cr / cp / pv amounts land in K bucket.
    //       - USD+FRA or USD+FRA+K (Kassumbalesa): the existing split
    //         (cash_received → USD, fra_received → FRA, k_received → K) is
    //         correct because the POS records each currency separately.
    const sumIn = (db, datePrefix, span, isKOnly) => {
      const wherePref = span === 'today' ? `= ?` : `LIKE ? || '%'`;
      const dateArg   = datePrefix;
      const len       = span === 'today' ? 10 : 7;
      const paramPaid = `substr(COALESCE(paid_at, created_at, ''), 1, ${len}) ${wherePref}`;
      const paramDate = (col) => `substr(COALESCE(${col}, ''), 1, ${len}) ${wherePref}`;
      if (isKOnly) {
        // Everything the POS + AR channels take in — cash, momo, bank on
        // orders (Liquor-style), plus manual CR + customer_payments —
        // aggregates into K. No USD or FRA rows on this branch.
        const row = tryGet(db, `
          SELECT
            (SELECT COALESCE(SUM(COALESCE(cash_received,0) + COALESCE(momo_received,0) + COALESCE(bank_received,0)), 0)
               FROM orders WHERE deleted_at IS NULL
                 AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
                 AND ${paramPaid}) AS sales_k,
            (SELECT COALESCE(SUM(COALESCE(cash_amount,0) + COALESCE(momo_amount,0) + COALESCE(bank_amount,0)), 0)
               FROM cash_receipts WHERE deleted_at IS NULL AND ${paramDate('date')}) AS cr_k,
            (SELECT COALESCE(SUM(COALESCE(cash_amount,0) + COALESCE(momo_amount,0) + COALESCE(bank_amount,0)), 0)
               FROM customer_payments WHERE deleted_at IS NULL AND ${paramDate('payment_date')}) AS cp_k
        `, [dateArg, dateArg, dateArg]);
        const r = row || {};
        return { usd: 0, fra: 0, k: (r.sales_k || 0) + (r.cr_k || 0) + (r.cp_k || 0) };
      }
      // Multi-currency branch (USD+FRA or USD+FRA+K): read per-currency splits.
      const row = tryGet(db, `
        SELECT
          (SELECT COALESCE(SUM(cash_received), 0)
             FROM orders WHERE deleted_at IS NULL
               AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
               AND ${paramPaid}) AS sales_usd,
          (SELECT COALESCE(SUM(fra_received), 0)
             FROM orders WHERE deleted_at IS NULL
               AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
               AND ${paramPaid}) AS sales_fra,
          (SELECT COALESCE(SUM(k_received), 0)
             FROM orders WHERE deleted_at IS NULL
               AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
               AND ${paramPaid}) AS sales_k,
          (SELECT COALESCE(SUM(CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount ELSE COALESCE(cash_amount,0) END), 0)
             FROM cash_receipts WHERE deleted_at IS NULL AND ${paramDate('date')}) AS cr_usd,
          (SELECT COALESCE(SUM(fra_amount), 0)
             FROM cash_receipts WHERE deleted_at IS NULL AND ${paramDate('date')}) AS cr_fra,
          (SELECT COALESCE(SUM(k_amount), 0)
             FROM cash_receipts WHERE deleted_at IS NULL AND ${paramDate('date')}) AS cr_k,
          (SELECT COALESCE(SUM(CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount ELSE COALESCE(cash_amount,0) END), 0)
             FROM customer_payments WHERE deleted_at IS NULL AND ${paramDate('payment_date')}) AS cp_usd,
          (SELECT COALESCE(SUM(fra_amount), 0)
             FROM customer_payments WHERE deleted_at IS NULL AND ${paramDate('payment_date')}) AS cp_fra,
          (SELECT COALESCE(SUM(k_amount), 0)
             FROM customer_payments WHERE deleted_at IS NULL AND ${paramDate('payment_date')}) AS cp_k
      `, [dateArg, dateArg, dateArg, dateArg, dateArg, dateArg, dateArg, dateArg, dateArg]);
      const r = row || {};
      return {
        usd: (r.sales_usd || 0) + (r.cr_usd || 0) + (r.cp_usd || 0),
        fra: (r.sales_fra || 0) + (r.cr_fra || 0) + (r.cp_fra || 0),
        k:   (r.sales_k   || 0) + (r.cr_k   || 0) + (r.cp_k   || 0),
      };
    };

    const sumOut = (db, datePrefix, span, isKOnly) => {
      const len   = span === 'today' ? 10 : 7;
      const wherePref = span === 'today' ? `= ?` : `LIKE ? || '%'`;
      const param = (col) => `substr(COALESCE(${col}, ''), 1, ${len}) ${wherePref}`;
      if (isKOnly) {
        const row = tryGet(db, `
          SELECT
            (SELECT COALESCE(SUM(COALESCE(cash_amount,0) + COALESCE(momo_amount,0) + COALESCE(bank_amount,0)), 0)
               FROM payment_vouchers WHERE deleted_at IS NULL AND ${param('date')}) AS pv_k,
            (SELECT COALESCE(SUM(COALESCE(cash_amount,0) + COALESCE(momo_amount,0) + COALESCE(bank_amount,0)), 0)
               FROM ap_payments WHERE deleted_at IS NULL AND ${param('date')}) AS ap_k
        `, [datePrefix, datePrefix]);
        const r = row || {};
        return { usd: 0, fra: 0, k: (r.pv_k || 0) + (r.ap_k || 0) };
      }
      const row = tryGet(db, `
        SELECT
          (SELECT COALESCE(SUM(CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount ELSE COALESCE(cash_amount,0) END), 0)
             FROM payment_vouchers WHERE deleted_at IS NULL AND ${param('date')}) AS pv_usd,
          (SELECT COALESCE(SUM(fra_amount), 0)
             FROM payment_vouchers WHERE deleted_at IS NULL AND ${param('date')}) AS pv_fra,
          (SELECT COALESCE(SUM(k_amount), 0)
             FROM payment_vouchers WHERE deleted_at IS NULL AND ${param('date')}) AS pv_k,
          (SELECT COALESCE(SUM(cash_amount), 0) FROM ap_payments WHERE deleted_at IS NULL AND ${param('date')}) AS ap_usd
      `, [datePrefix, datePrefix, datePrefix, datePrefix]);
      const r = row || {};
      return {
        usd: (r.pv_usd || 0) + (r.ap_usd || 0),
        fra: (r.pv_fra || 0),
        k:   (r.pv_k   || 0),
      };
    };

    const branches = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name, currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const isKOnly = String(settings.currency_mode || 'K').toUpperCase() === 'K';
        const todayIn  = sumIn(db,  todayPrefix, 'today', isKOnly);
        const todayOut = sumOut(db, todayPrefix, 'today', isKOnly);
        const mtdIn    = sumIn(db,  monthPrefix, 'mtd',   isKOnly);
        const mtdOut   = sumOut(db, monthPrefix, 'mtd',   isKOnly);
        branches.push({
          slug: t.slug,
          name: settings.business_name || t.business_name || t.slug,
          currency_mode: settings.currency_mode || 'K',
          today: {
            in:  todayIn,
            out: todayOut,
            net: { usd: todayIn.usd - todayOut.usd, fra: todayIn.fra - todayOut.fra, k: todayIn.k - todayOut.k },
          },
          mtd: {
            in:  mtdIn,
            out: mtdOut,
            net: { usd: mtdIn.usd - mtdOut.usd, fra: mtdIn.fra - mtdOut.fra, k: mtdIn.k - mtdOut.k },
          },
        });
      } catch (e) {
        branches.push({ slug: t.slug, name: t.business_name || t.slug, error: e.message });
      }
    }

    // Rollup — sums across all branches per period per direction per method.
    const rollup = branches.reduce((acc, b) => {
      if (b.error) return acc;
      for (const period of ['today', 'mtd']) {
        for (const dir of ['in', 'out', 'net']) {
          for (const ccy of ['usd', 'fra', 'k']) {
            acc[period][dir][ccy] += b[period][dir][ccy];
          }
        }
      }
      return acc;
    }, {
      today: { in: { usd:0, fra:0, k:0 }, out: { usd:0, fra:0, k:0 }, net: { usd:0, fra:0, k:0 } },
      mtd:   { in: { usd:0, fra:0, k:0 }, out: { usd:0, fra:0, k:0 }, net: { usd:0, fra:0, k:0 } },
    });

    res.json({ as_of: new Date().toISOString(), branches, rollup });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── v1.8.65 — HQ Transit Variances ─────────────────────────────────────────
// Unified list of variance rows from BOTH:
//   - master.db.transfer_variances (Inter-Branch Transfers)
//   - master.db.hq_purchase_items WHERE received_qty < dispatched_qty OR
//     reason IN ('Damaged','Lost') (HQ Purchases dropshipped to branches)
// Each row carries: source ('TRANSFER' | 'HQ_PURCHASE'), branch slugs,
// product, sent/received/variance qty, reason, notes, status (OPEN | RESOLVED).
// Filters: ?source=, ?reason=, ?status=, ?slug= (matches either from/to).
router.get('/variances', hqAuth, (req, res) => {
  try {
    const { source, reason, status, slug } = req.query || {};
    // Transfer variances
    let transferRows = [];
    if (!source || source === 'TRANSFER') {
      const where = ['1=1'];
      const params = [];
      if (reason) { where.push('reason = ?'); params.push(reason); }
      if (slug)   { where.push('(from_slug = ? OR to_slug = ?)'); params.push(slug, slug); }
      if (status === 'OPEN')     where.push('resolved_at IS NULL');
      if (status === 'RESOLVED') where.push('resolved_at IS NOT NULL');
      transferRows = masterDb.prepare(`
        SELECT
          'TRANSFER'        AS source,
          id, sync_id, transfer_sync_id, transfer_number,
          from_slug, to_slug,
          product_sync_id, product_name, unit,
          sent_qty, received_qty, variance_qty,
          reason, notes,
          received_by, received_by_name,
          created_at,
          resolved_at, resolution
        FROM transfer_variances
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
      `).all(...params);
    }

    // HQ purchase variances — items where the count doesn't match.
    let purchaseRows = [];
    if (!source || source === 'HQ_PURCHASE') {
      const where = [
        "(COALESCE(received_qty, dispatched_qty) < dispatched_qty OR reason IN ('Damaged','Lost'))",
        "status IN ('GRN_SUBMITTED','CONFIRMED')",
      ];
      const params = [];
      if (reason) { where.push('reason = ?'); params.push(reason); }
      if (slug)   { where.push('destination_slug = ?'); params.push(slug); }
      // No resolved-tracking on purchase items yet — treat all as OPEN.
      if (status === 'RESOLVED') where.push('1=0');
      purchaseRows = masterDb.prepare(`
        SELECT
          'HQ_PURCHASE'        AS source,
          pi.id,
          NULL                 AS sync_id,
          NULL                 AS transfer_sync_id,
          p.purchase_number    AS transfer_number,
          'hq'                 AS from_slug,
          pi.destination_slug  AS to_slug,
          pi.product_sync_id, pi.product_name, pi.unit,
          pi.dispatched_qty    AS sent_qty,
          COALESCE(pi.received_qty, pi.dispatched_qty) AS received_qty,
          (pi.dispatched_qty - COALESCE(pi.received_qty, pi.dispatched_qty)) AS variance_qty,
          COALESCE(pi.reason,
            CASE WHEN COALESCE(pi.received_qty, pi.dispatched_qty) < pi.dispatched_qty THEN 'Short' ELSE 'OK' END
          ) AS reason,
          pi.variance_notes    AS notes,
          pi.received_by, pi.received_by_name,
          pi.received_at       AS created_at,
          NULL                 AS resolved_at,
          NULL                 AS resolution
        FROM hq_purchase_items pi
        LEFT JOIN hq_purchases p ON p.id = pi.purchase_id
        WHERE ${where.join(' AND ')}
        ORDER BY pi.received_at DESC
      `).all(...params);
    }

    const all = [...transferRows, ...purchaseRows]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    res.json({
      variances: all,
      stats: {
        total: all.length,
        open:  all.filter(v => !v.resolved_at).length,
        short:    all.filter(v => v.reason === 'Short').length,
        damaged:  all.filter(v => v.reason === 'Damaged').length,
        lost:     all.filter(v => v.reason === 'Lost').length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/hq/variances/transfer/:syncId/resolve
// Marks a transfer_variance row as resolved with a resolution code.
router.put('/variances/transfer/:syncId/resolve', hqAuth, (req, res) => {
  try {
    const { resolution, notes } = req.body || {};
    const allowed = new Set(['WRITE_OFF', 'RECOVERED']);
    if (!allowed.has(resolution)) {
      return res.status(400).json({ error: 'resolution must be WRITE_OFF or RECOVERED' });
    }
    const row = masterDb.prepare('SELECT * FROM transfer_variances WHERE sync_id = ?').get(req.params.syncId);
    if (!row) return res.status(404).json({ error: 'Variance not found' });
    if (row.resolved_at) return res.status(400).json({ error: 'Already resolved' });
    masterDb.prepare(`
      UPDATE transfer_variances
         SET resolved_at = datetime('now'),
             resolution = ?,
             notes = COALESCE(?, notes)
       WHERE sync_id = ?
    `).run(resolution, notes || null, req.params.syncId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── v1.9.0 — Layer 3: HQ admin Refresh button ──────────────────────────────
// Manual on-demand mirror of every HQ-owned entity (main_categories,
// categories, units, products) to every registered branch. Idempotent —
// safe to run any time, never overwrites branch-owned columns (prices /
// stock / status / notes). Same helper feeds the boot heal (Layer 1) and
// the on-register auto-mirror (Layer 2); the difference is just who
// triggers it.
//
// Optional ?slug=<branch> targets a single branch instead of all of them
// (e.g. for a "Resync mansa1 only" action from a future UI). When the
// query is omitted, every active tenant gets the sweep.
router.post('/mirror-all', hqAuth, (req, res) => {
  try {
    const slug = (req.query.slug || req.body?.slug || '').toString().trim().toLowerCase();
    const t0 = Date.now();
    const result = mirrorAllHqToBranches(defaultDb, {
      listTenants,
      getTenantDb,
      targetSlug: slug || null,
    });
    res.json({
      ok: true,
      elapsed_ms: Date.now() - t0,
      ...result,
    });
  } catch (e) {
    console.error('[hq.mirror-all] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
