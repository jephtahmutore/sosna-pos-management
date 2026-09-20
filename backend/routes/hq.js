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
const { randomUUID } = require('crypto');
const { listTenants, masterDb } = require('../config/masterDb');
// v1.10.245 — HQ page permission gates. Same middleware branches use,
// checked against permissions on the HQ user row (defaultDb.users) after
// hqAuth verifies the JWT. Non-admin HQ users need explicit HqXxx perms
// from Users → Permissions; admin bypasses (isAllAccess pattern).
const { requirePagePerm } = require('../middleware/auth');
const { getTenantDb, getTenantSyncIds } = require('../config/tenantDb');
const { computeBranchCashPosition } = require('../utils/branchCashPosition');
const { defaultDb, runWithDb } = require('../config/database');
const { mirrorAllHqToBranches } = require('../middleware/hqPush');
const { recalculateDailyProfit } = require('../config/profitHelper');

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
router.get('/overview', hqAuth, requirePagePerm('HqOverview'), (req, res) => {
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
router.get('/sales-report', hqAuth, requirePagePerm('HqSalesReport'), (req, res) => {
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
    // v1.10.295 — collect per-tenant item aggregates alongside orders so
    // the frontend's new "By Item" sub-tab has a product roll-up without
    // a second network round-trip. One row per (product × branch); the
    // final merge across branches happens after the tenant loop, keyed by
    // product_id + currency so mixed-currency ranges never sum K + USD.
    const tenantItems = [];

    // Per-branch currency map so we can tag every order + bucket with the
    // right symbol on the client. Branch's business_settings.currency_mode
    // is the source of truth: USD+FRA / USD+FRA+K → USD-base; anything else
    // → K-base.
    const branchCurrency = {};
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name, currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const branchName = settings.business_name || t.business_name || t.slug;
        const isUsdBase = typeof settings.currency_mode === 'string' && settings.currency_mode.includes('USD');
        const ccy = isUsdBase ? 'USD' : 'K';
        branchCurrency[t.slug] = ccy;

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
            branch_currency: ccy,
          });
        }

        // v1.10.295 — pull item-level aggregates in the same date window.
        // Excludes reversed items so partial returns don't inflate the
        // qty/revenue. Line-level filter, not order-level, since a paid
        // order can have some lines reversed via Sales Return.
        const items = db.prepare(`
          SELECT oi.product_id,
                 oi.product_name,
                 SUM(oi.quantity)    AS qty_sold,
                 SUM(oi.total_price) AS revenue,
                 COUNT(DISTINCT oi.order_id) AS orders_count
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
           WHERE o.deleted_at IS NULL
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) >= ?
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) <= ?
             AND (o.status IS NULL OR o.status != 'Reversed')
             AND (oi.reversed IS NULL OR oi.reversed = 0)
           GROUP BY oi.product_id, oi.product_name
        `).all(from, to);

        for (const it of items) {
          tenantItems.push({
            product_id:   it.product_id,
            product_name: it.product_name,
            qty:          parseFloat(it.qty_sold)     || 0,
            revenue:      parseFloat(it.revenue)      || 0,
            orders_count: parseInt(it.orders_count, 10) || 0,
            branch_slug:  t.slug,
            branch_name:  branchName,
            currency:     ccy,
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

    // Totals across whatever survived the filters. Split money by currency
    // so mixed-currency ranges (Kassumbalesa USD + Lusaka/Mansa K) render
    // as separate USD and K totals instead of one meaningless sum.
    const totals = capped.reduce((acc, r) => {
      const ccy = r.branch_currency || 'K';
      const amt  = parseFloat(r.total_amount    || 0);
      const rec  = parseFloat(r.amount_received || 0);
      acc.orders += 1;
      acc.revenue_by_ccy[ccy]  = (acc.revenue_by_ccy[ccy]  || 0) + amt;
      acc.received_by_ccy[ccy] = (acc.received_by_ccy[ccy] || 0) + rec;
      acc.by_branch[r.branch_slug] = acc.by_branch[r.branch_slug] || {
        name: r.branch_name, currency: ccy, orders: 0, revenue: 0,
      };
      acc.by_branch[r.branch_slug].orders  += 1;
      acc.by_branch[r.branch_slug].revenue += amt;
      return acc;
    }, { orders: 0, revenue_by_ccy: {}, received_by_ccy: {}, by_branch: {} });

    // v1.10.295 — merge per-tenant item rows across branches, keyed by
    // (product_id or product_name) + currency so a product sold in both
    // K and USD branches appears twice (once per bucket), never summed.
    // Sorted by revenue desc within each currency so the top sellers land
    // at the top of the By Item sub-tab.
    const itemsByCcyMap = {};
    for (const it of tenantItems) {
      const ccy = it.currency;
      if (!itemsByCcyMap[ccy]) itemsByCcyMap[ccy] = new Map();
      const key = `${it.product_id || 'null'}::${it.product_name}`;
      const existing = itemsByCcyMap[ccy].get(key) || {
        product_id: it.product_id,
        product_name: it.product_name,
        currency: ccy,
        qty: 0,
        revenue: 0,
        orders_count: 0,
        branches: {},
      };
      existing.qty          += it.qty;
      existing.revenue      += it.revenue;
      existing.orders_count += it.orders_count;
      existing.branches[it.branch_slug] = existing.branches[it.branch_slug] || {
        name: it.branch_name, qty: 0, revenue: 0,
      };
      existing.branches[it.branch_slug].qty     += it.qty;
      existing.branches[it.branch_slug].revenue += it.revenue;
      itemsByCcyMap[ccy].set(key, existing);
    }
    const items_by_ccy = {};
    for (const [ccy, map] of Object.entries(itemsByCcyMap)) {
      items_by_ccy[ccy] = Array.from(map.values())
        .sort((a, b) => b.revenue - a.revenue);
    }

    res.json({
      from, to, branch,
      total_rows: rows.length,
      returned_rows: capped.length,
      truncated: rows.length > capped.length,
      totals,
      orders: capped,
      items_by_ccy,
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
router.get('/inventory-report', hqAuth, requirePagePerm('HqInventoryReport'), (req, res) => {
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
        // v1.10.316 — use WAC valuation (avg_cost_price with fallback to
        // cost_price) so this report agrees with the Sales Stock Card and
        // the Balance Sheet. Previously used raw cost_price only, which
        // understated group inventory by ~K2.2M vs the WAC value the
        // Sales Stock Card page shows on each depot.
        let sql = `
          SELECT p.id, p.name, p.unit, p.current_stock, p.min_stock,
                 p.cost_price, p.avg_cost_price, p.selling_price, p.status, p.units_json,
                 c.name AS category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.deleted_at IS NULL`;
        const params = [];
        if (lowOnly) sql += ' AND p.current_stock <= p.min_stock';
        if (q)       { sql += ' AND LOWER(p.name) LIKE ?'; params.push(`%${q}%`); }
        sql += ' ORDER BY (p.current_stock * COALESCE(p.avg_cost_price, p.cost_price, 0)) DESC';
        const products = db.prepare(sql).all(...params);

        for (const p of products) {
          const stock = parseFloat(p.current_stock || 0);
          const min   = parseFloat(p.min_stock || 0);
          // WAC (weighted average) with fallback to cost_price when no GRN
          // activity has computed avg_cost_price yet.
          const avgCost  = parseFloat(p.avg_cost_price || 0);
          const cost     = avgCost > 0 ? avgCost : parseFloat(p.cost_price || 0);
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
router.get('/cash-position', hqAuth, requirePagePerm('HqCashPosition'), (req, res) => {
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
router.get('/variances', hqAuth, requirePagePerm('HqVariances'), (req, res) => {
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
        "pi.status IN ('GRN_SUBMITTED','CONFIRMED')",
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
// v1.10.219 — Option C: on WRITE_OFF, actually book the loss as a damage
// on the chosen branch's daily profit (source or destination — HQ picks).
// RECOVERED remains no-op on P&L (stock re-entry is done manually via
// Stock Reconciliation at whichever branch got the physical goods back).
//
// Request body:
//   resolution:    'WRITE_OFF' | 'RECOVERED'  (required)
//   absorbed_by:   'source' | 'destination'   (required when WRITE_OFF)
//   notes:         optional free text
router.put('/variances/transfer/:syncId/resolve', hqAuth, requirePagePerm('HqVariances'), (req, res) => {
  try {
    const { resolution, notes, absorbed_by } = req.body || {};
    const allowed = new Set(['WRITE_OFF', 'RECOVERED']);
    if (!allowed.has(resolution)) {
      return res.status(400).json({ error: 'resolution must be WRITE_OFF or RECOVERED' });
    }
    if (resolution === 'WRITE_OFF' && !['source', 'destination'].includes(absorbed_by)) {
      return res.status(400).json({ error: 'WRITE_OFF requires absorbed_by = "source" or "destination"' });
    }
    const row = masterDb.prepare('SELECT * FROM transfer_variances WHERE sync_id = ?').get(req.params.syncId);
    if (!row) return res.status(404).json({ error: 'Variance not found' });
    if (row.resolved_at) return res.status(400).json({ error: 'Already resolved' });

    let absorbedSlug = null;
    if (resolution === 'WRITE_OFF') {
      absorbedSlug = absorbed_by === 'source' ? row.from_slug : row.to_slug;
      const branchDb = getTenantDb(absorbedSlug);
      if (!branchDb) {
        return res.status(400).json({ error: `Absorbing branch "${absorbedSlug}" not registered` });
      }

      // Look up the branch's local product_id (FK on stock_movements).
      const prod = branchDb.prepare(
        'SELECT id, tenant_id FROM products WHERE sync_id = ? AND deleted_at IS NULL'
      ).get(row.product_sync_id);
      if (!prod) {
        return res.status(400).json({
          error: `Product ${row.product_name} (sync_id ${row.product_sync_id}) not found at branch ${absorbedSlug}. Cannot book write-off.`,
        });
      }

      // Movement is P&L-only. location='books_only' keeps it out of every
      // inventory sum (they all filter location='sales' or 'store'), so
      // current_stock stays truthful. profitHelper's damages query is
      // widened below to pick up movement_type='transit_writeoff' regardless
      // of location, so this row still hits daily_profit_summary.damages.
      const today = new Date().toISOString().split('T')[0];
      const varianceBaseQty = parseFloat(row.variance_qty) || 0;
      const movementNotes = `Transit variance write-off · ${row.transfer_number} · ${row.reason}${row.notes ? ' · ' + row.notes : ''}${notes ? ' · HQ: ' + notes : ''}`;
      branchDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id, notes,
                                     created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(
        // v1.10.226 — created_by must reference a user on THIS branch's users
        // table. HQ users only exist in HQ auth, so req.user.id would blow
        // the FK constraint (FOREIGN KEY failed alert on the Resolve modal).
        // Safest: NULL. Audit trail is preserved in transfer_variances
        // (received_by + received_by_name + resolved_at + absorbed_by_slug).
        // Same fix as Redsea v1.13.56.
        prod.id, row.product_sync_id, 'books_only', 'transit_writeoff',
        -varianceBaseQty, 'transfer_variance', row.sync_id, movementNotes,
        null, randomUUID(), prod.tenant_id, null, null
      );

      // Refresh the branch's daily profit for today so the loss shows up
      // immediately on the Cash Report / profit summary.
      recalculateDailyProfit(branchDb, today, prod.tenant_id);
    }

    masterDb.prepare(`
      UPDATE transfer_variances
         SET resolved_at      = datetime('now'),
             resolution       = ?,
             absorbed_by_slug = ?,
             notes            = COALESCE(?, notes)
       WHERE sync_id = ?
    `).run(resolution, absorbedSlug, notes || null, req.params.syncId);
    res.json({ ok: true, absorbed_by_slug: absorbedSlug });
  } catch (e) {
    console.error('[hq.variances.resolve] failed:', e.message);
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

// ─── v1.10.233 — HQ Consolidated Profit ────────────────────────────────────
// Group Net = SUM(branch net_profit converted USD daily) − HQ overhead (USD).
// HQ overhead = HQ payment_vouchers with is_landed_cost=0 (LCVs already
// live in inventory WAC via hqGrns absorption, so counting them here
// would double-count).
//
// Currency conversion: each Zambia branch's daily net (K) → USD using
// that day's Kassumbalesa USD/K rate. Rate source is the branch orders'
// selling_rate_k_used column (per-day AVG of non-zero rows). Missing days
// forward-fill from the most recent prior rate; if none exists inside
// or before the range, the Zambia contribution stays at 0 USD and a
// warning surfaces to the UI.
router.get('/consolidated-profit', hqAuth, requirePagePerm('HqConsolidatedProfit'), (req, res) => {
  try {
    const from = (req.query.from || new Date().toISOString().slice(0, 10)).toString();
    const to   = (req.query.to   || from).toString();

    const tenants = listTenants();

    // Enumerate every date in the range (inclusive).
    const dates = [];
    {
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z');
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        dates.push(d.toISOString().slice(0, 10));
      }
    }

    // Locate the multi-currency branch (Kassumbalesa) — that's where the
    // USD/K rate lives (per-order selling_rate_k_used).
    let kassSlug = null;
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const cm = tryGet(db, `SELECT currency_mode FROM business_settings LIMIT 1`);
        if (cm && typeof cm.currency_mode === 'string' && cm.currency_mode.includes('USD')) {
          kassSlug = t.slug;
          break;
        }
      } catch { /* skip */ }
    }

    // Build daily K→USD rate map with forward-fill.
    const fxByDate = {};
    let priorRate = null;
    if (kassSlug) {
      try {
        const kdb = getTenantDb(kassSlug);
        const rows = kdb.prepare(`
          SELECT substr(created_at, 1, 10) AS d,
                 AVG(selling_rate_k_used)  AS rate
            FROM orders
           WHERE deleted_at IS NULL
             AND selling_rate_k_used IS NOT NULL
             AND selling_rate_k_used > 0
             AND substr(created_at, 1, 10) BETWEEN ? AND ?
        GROUP BY substr(created_at, 1, 10)
        `).all(from, to);
        for (const r of rows) fxByDate[r.d] = parseFloat(r.rate) || null;
        // Prime forward-fill with most recent rate BEFORE the range.
        const prior = tryGet(kdb, `
          SELECT AVG(selling_rate_k_used) AS rate FROM (
            SELECT selling_rate_k_used
              FROM orders
             WHERE deleted_at IS NULL
               AND selling_rate_k_used > 0
               AND substr(created_at, 1, 10) < ?
          ORDER BY created_at DESC LIMIT 30
          )
        `, from);
        if (prior?.rate) priorRate = parseFloat(prior.rate) || null;
      } catch (e) {
        console.error(`[hq.consolidated-profit] fx from ${kassSlug}:`, e.message);
      }
    }
    const effectiveRate = {};
    {
      let last = priorRate;
      for (const d of dates) {
        if (fxByDate[d] != null) last = fxByDate[d];
        effectiveRate[d] = last;
      }
    }

    const warnings = [];
    const hasAnyRate = Object.values(effectiveRate).some(r => r != null);
    if (!hasAnyRate) {
      warnings.push('No K/USD rate found on Kassumbalesa for this range — Zambia branches contribute 0 to USD group total.');
    }

    // Per branch: daily rows + range totals.
    const branches = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name, currency_mode FROM business_settings LIMIT 1`) || {};
        const name = settings.business_name || t.business_name || t.slug;
        const isUsdBase = typeof settings.currency_mode === 'string' && settings.currency_mode.includes('USD');
        const currency = isUsdBase ? 'USD' : 'K';

        const dailyRows = db.prepare(`
          SELECT date, revenue, cogs, damages, supplier_rebates,
                 diff_value, cash_difference,
                 gross_profit, pv_total, net_profit
            FROM daily_profit_summary
           WHERE date BETWEEN ? AND ?
        ORDER BY date
        `).all(from, to);
        const byDate = new Map(dailyRows.map(r => [r.date, r]));

        const daily = [];
        // Local-currency sums for the per-branch table
        let sumRev = 0, sumCogs = 0, sumGross = 0, sumPv = 0, sumNetL = 0, sumNetU = 0;
        let sumVar = 0;
        let sumDamages = 0, sumRebates = 0, sumStockVar = 0, sumCashVar = 0;
        // USD-converted sums so the group KPIs + Breakdown can render in one currency
        let uRev = 0, uCogs = 0, uDamages = 0, uRebates = 0, uStockVar = 0, uCashVar = 0, uPv = 0, uGross = 0;
        for (const d of dates) {
          const r = byDate.get(d);
          const revenue  = parseFloat(r?.revenue      || 0);
          const cogs     = parseFloat(r?.cogs         || 0);
          const gross    = parseFloat(r?.gross_profit || 0);
          const pv       = parseFloat(r?.pv_total     || 0);
          const netLocal = parseFloat(r?.net_profit   || 0);
          // Variance = −Damaged + Stock Variance + Cash Variance
          // (same components profitHelper adds between Revenue−COGS and Gross Profit,
          // supplier rebates intentionally excluded — those are other-income, not variance)
          const damages   = parseFloat(r?.damages          || 0);
          const rebates   = parseFloat(r?.supplier_rebates || 0);
          const stockVar  = parseFloat(r?.diff_value       || 0);
          const cashVar   = parseFloat(r?.cash_difference  || 0);
          const variance  = -damages + stockVar + cashVar;
          const fx = isUsdBase ? null : effectiveRate[d];
          const toUsd = v => isUsdBase ? v : (fx ? v / fx : 0);
          const netUsd = toUsd(netLocal);
          daily.push({ date: d, revenue, cogs, gross, variance, pv, net_local: netLocal, net_usd: netUsd, fx_rate: fx });
          sumRev += revenue; sumCogs += cogs; sumGross += gross; sumVar += variance; sumPv += pv;
          sumNetL += netLocal; sumNetU += netUsd;
          sumDamages += damages; sumRebates += rebates; sumStockVar += stockVar; sumCashVar += cashVar;
          uRev += toUsd(revenue); uCogs += toUsd(cogs); uGross += toUsd(gross); uPv += toUsd(pv);
          uDamages += toUsd(damages); uRebates += toUsd(rebates);
          uStockVar += toUsd(stockVar); uCashVar += toUsd(cashVar);
        }

        branches.push({
          slug: t.slug, name, currency,
          totals: {
            revenue: sumRev, cogs: sumCogs, gross: sumGross,
            damages: sumDamages, supplier_rebates: sumRebates,
            stock_variance: sumStockVar, cash_variance: sumCashVar,
            variance: sumVar, pv: sumPv,
            net_local: sumNetL, net_usd: sumNetU,
          },
          totals_usd: {
            revenue: uRev, cogs: uCogs, damages: uDamages,
            supplier_rebates: uRebates, stock_variance: uStockVar,
            cash_variance: uCashVar, pv: uPv, gross: uGross,
          },
          daily,
        });
      } catch (e) {
        console.error(`[hq.consolidated-profit] ${t.slug}:`, e.message);
      }
    }

    // HQ Overhead — payment_vouchers on defaultDb, excluding LCVs. PVs are
    // stored per-currency (usd_amount / fra_amount / k_amount) since HQ is
    // effectively tri-currency (deposits arrive from every branch). We sum
    // each column, then convert to USD:
    //   - usd_amount stays as-is
    //   - k_amount   ÷ effectiveRate (K/USD, day-specific)
    //   - fra_amount ÷ effectiveFraRate (FRA/USD, day-specific — from
    //                                     Kassumbalesa fx_rates.sell_rate)
    // Legacy fallback: if a PV has all three currency columns at 0 but the
    // legacy `amount` column populated, treat it as K.
    // Fetch a FRA per-day rate map from Kassumbalesa's fx_rates.
    const fraByDate = {};
    let priorFra = null;
    if (kassSlug) {
      try {
        const kdb = getTenantDb(kassSlug);
        const rows = kdb.prepare(`
          SELECT effective_date AS d,
                 sell_rate      AS rate
            FROM fx_rates
           WHERE effective_date BETWEEN ? AND ?
             AND sell_rate > 0
        ORDER BY effective_date, id
        `).all(from, to);
        for (const r of rows) fraByDate[r.d] = parseFloat(r.rate) || null;
        const prior = tryGet(kdb, `
          SELECT sell_rate AS rate
            FROM fx_rates
           WHERE effective_date < ?
             AND sell_rate > 0
        ORDER BY effective_date DESC, id DESC
           LIMIT 1
        `, from);
        if (prior?.rate) priorFra = parseFloat(prior.rate) || null;
      } catch (e) {
        console.error(`[hq.consolidated-profit] FRA fx from ${kassSlug}:`, e.message);
      }
    }
    const effectiveFraRate = {};
    {
      let last = priorFra;
      for (const d of dates) {
        if (fraByDate[d] != null) last = fraByDate[d];
        effectiveFraRate[d] = last;
      }
    }

    let hqDailyRows = [];
    const hqSelect = (extraWhere) => `
      SELECT date,
             COALESCE(SUM(usd_amount), 0) AS usd_total,
             COALESCE(SUM(fra_amount), 0) AS fra_total,
             COALESCE(SUM(k_amount),   0) AS k_total,
             COALESCE(SUM(amount),     0) AS legacy_total,
             COALESCE(SUM(COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)), 0) AS split_total
        FROM payment_vouchers
       WHERE ${extraWhere}
         AND (is_landed_cost IS NULL OR is_landed_cost = 0)
         AND date BETWEEN ? AND ?
    GROUP BY date
    `;
    try {
      hqDailyRows = defaultDb.prepare(hqSelect('deleted_at IS NULL')).all(from, to);
    } catch (e) {
      try {
        hqDailyRows = defaultDb.prepare(hqSelect('1=1')).all(from, to);
      } catch (e2) {
        console.error('[hq.consolidated-profit] HQ PVs read failed:', e2.message);
      }
    }
    const hqByDate = new Map(hqDailyRows.map(r => [r.date, r]));
    const hqDaily = [];
    let hqSumUsdAmt = 0, hqSumFraAmt = 0, hqSumKAmt = 0, hqSumUsd = 0;
    for (const d of dates) {
      const r = hqByDate.get(d);
      const usdAmt   = parseFloat(r?.usd_total   || 0);
      const fraAmt   = parseFloat(r?.fra_total   || 0);
      let   kAmt     = parseFloat(r?.k_total     || 0);
      const splitAmt = parseFloat(r?.split_total || 0);
      const legacy   = parseFloat(r?.legacy_total || 0);
      // Legacy fallback: if per-currency splits are all 0 but `amount` is
      // populated, treat it as K.
      if (splitAmt < 0.001 && legacy > 0) kAmt = legacy;
      const fxK   = effectiveRate[d];
      const fxFra = effectiveFraRate[d];
      const usdFromK   = fxK   ? kAmt   / fxK   : 0;
      const usdFromFra = fxFra ? fraAmt / fxFra : 0;
      const usdDay = usdAmt + usdFromK + usdFromFra;
      hqDaily.push({
        date: d,
        usd_amount: usdAmt,
        fra_amount: fraAmt,
        k_amount:   kAmt,
        usd:        usdDay,
        fx_k_rate:  fxK,
        fx_fra_rate: fxFra,
      });
      hqSumUsdAmt += usdAmt;
      hqSumFraAmt += fraAmt;
      hqSumKAmt   += kAmt;
      hqSumUsd    += usdDay;
    }

    const branchNetUsd = branches.reduce((s, b) => s + b.totals.net_usd, 0);
    const groupNetUsd  = branchNetUsd - hqSumUsd;

    // Group-level KPIs in USD — sums across all branches (plus HQ overhead
    // in Expenses (PV)), for the top card row + Breakdown section on the
    // consolidated page. Mirrors the branch Profit Report layout.
    const g = branches.reduce((acc, b) => {
      acc.revenue          += b.totals_usd.revenue          || 0;
      acc.cogs             += b.totals_usd.cogs             || 0;
      acc.damages          += b.totals_usd.damages          || 0;
      acc.supplier_rebates += b.totals_usd.supplier_rebates || 0;
      acc.stock_variance   += b.totals_usd.stock_variance   || 0;
      acc.cash_variance    += b.totals_usd.cash_variance    || 0;
      acc.pv               += b.totals_usd.pv               || 0;
      acc.gross            += b.totals_usd.gross            || 0;
      return acc;
    }, {
      revenue: 0, cogs: 0, damages: 0, supplier_rebates: 0,
      stock_variance: 0, cash_variance: 0, pv: 0, gross: 0,
    });
    // Expenses (PV) on the group P&L includes HQ overhead.
    g.pv        += hqSumUsd;
    g.net       = g.gross - g.pv;

    res.json({
      from, to,
      reporting_currency: 'USD',
      fx_source: kassSlug ? `${kassSlug}.orders.selling_rate_k_used (per-day AVG, forward-filled)` : null,
      warnings,
      branches,
      hq_overhead: {
        total_usd_amount: hqSumUsdAmt,
        total_fra_amount: hqSumFraAmt,
        total_k_amount:   hqSumKAmt,
        total_usd:        hqSumUsd,
        daily:            hqDaily,
      },
      group_totals_usd: g,
      group_net_usd:    groupNetUsd,
    });
  } catch (error) {
    console.error('[hq.consolidated-profit] failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/hq/income-statement?month=YYYY-MM ────────────────────────────
// Financial Statements → Income Statement, HQ-only, always in Kwacha.
//
// Aggregates group-wide P&L for a calendar month by:
//   1. Enumerating every branch's daily_profit_summary rows for the range
//   2. Converting USD-native branch rows (Kassumbalesa) to K using that
//      day's Kassumbalesa selling_rate_k_used (K/USD, forward-filled)
//   3. Summing HQ payment_vouchers (tri-currency: usd/fra/k), converted
//      each to K using their own day-of rates; excludes LCVs (already in
//      inventory WAC via hqGrns absorption)
//   4. Building the classic P&L structure:
//        Revenue
//        − COGS
//        = Gross Profit
//        ± Variance (−Damages + Stock Var + Cash Var)
//        + Supplier Rebates
//        = Operating Profit
//        − Operating Expenses (HQ + branch PVs)
//        = Net Profit Before Tax
//
// Delivered to the frontend Financial Statements page and the printed
// PDF export. Same data spine as /consolidated-profit but reshaped for
// external accounting use.
router.get('/income-statement', hqAuth, requirePagePerm('HqFinancialStatements'), (req, res) => {
  try {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to   = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day

    const tenants = listTenants();
    const dates = [];
    {
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z');
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        dates.push(d.toISOString().slice(0, 10));
      }
    }

    // Locate the USD-native branch (Kassumbalesa) — source of both K/USD and FRA/USD rates
    let kassSlug = null;
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const cm = tryGet(db, `SELECT currency_mode FROM business_settings LIMIT 1`);
        if (cm && typeof cm.currency_mode === 'string' && cm.currency_mode.includes('USD')) {
          kassSlug = t.slug;
          break;
        }
      } catch { /* skip */ }
    }

    // K/USD rate map (forward-filled) — used to convert Kassumbalesa's USD rows to K
    const kUsdByDate = {};
    let priorKUsd = null;
    if (kassSlug) {
      try {
        const kdb = getTenantDb(kassSlug);
        const rows = kdb.prepare(`
          SELECT substr(created_at, 1, 10) AS d, AVG(selling_rate_k_used) AS rate
            FROM orders
           WHERE deleted_at IS NULL AND selling_rate_k_used > 0
             AND substr(created_at, 1, 10) BETWEEN ? AND ?
        GROUP BY substr(created_at, 1, 10)
        `).all(from, to);
        for (const r of rows) kUsdByDate[r.d] = parseFloat(r.rate) || null;
        const prior = tryGet(kdb, `
          SELECT AVG(selling_rate_k_used) AS rate FROM (
            SELECT selling_rate_k_used FROM orders
             WHERE deleted_at IS NULL AND selling_rate_k_used > 0
               AND substr(created_at, 1, 10) < ?
          ORDER BY created_at DESC LIMIT 30)
        `, from);
        if (prior?.rate) priorKUsd = parseFloat(prior.rate) || null;
      } catch (e) { console.error('[hq.income-statement] K/USD fx:', e.message); }
    }
    const kUsdRate = {};
    { let last = priorKUsd; for (const d of dates) { if (kUsdByDate[d] != null) last = kUsdByDate[d]; kUsdRate[d] = last; } }

    // FRA/USD from Kassumbalesa fx_rates — for HQ PVs tri-currency conversion
    const fraUsdByDate = {};
    let priorFraUsd = null;
    if (kassSlug) {
      try {
        const kdb = getTenantDb(kassSlug);
        const rows = kdb.prepare(`
          SELECT effective_date AS d, sell_rate AS rate
            FROM fx_rates
           WHERE effective_date BETWEEN ? AND ? AND sell_rate > 0
        ORDER BY effective_date, id
        `).all(from, to);
        for (const r of rows) fraUsdByDate[r.d] = parseFloat(r.rate) || null;
        const prior = tryGet(kdb, `
          SELECT sell_rate AS rate FROM fx_rates
           WHERE effective_date < ? AND sell_rate > 0
        ORDER BY effective_date DESC, id DESC LIMIT 1
        `, from);
        if (prior?.rate) priorFraUsd = parseFloat(prior.rate) || null;
      } catch (e) { console.error('[hq.income-statement] FRA/USD fx:', e.message); }
    }
    const fraUsdRate = {};
    { let last = priorFraUsd; for (const d of dates) { if (fraUsdByDate[d] != null) last = fraUsdByDate[d]; fraUsdRate[d] = last; } }

    // FRA→K helper: FRA/USD × USD/K = FRA/K, so K = FRA ÷ (FRA/USD) × (K/USD)
    const fraToK = (fra, d) => {
      const kusd = kUsdRate[d], fraUsd = fraUsdRate[d];
      if (!fra || !kusd || !fraUsd) return 0;
      return (fra / fraUsd) * kusd;
    };
    const usdToK = (usd, d) => {
      const kusd = kUsdRate[d];
      return (!usd || !kusd) ? 0 : usd * kusd;
    };

    // ── Per-branch aggregation in K ─────────────────────────────────
    const perBranch = [];
    let revenue = 0, cogs = 0, gross = 0, damages = 0, rebates = 0,
        stockVar = 0, cashVar = 0, branchPv = 0;

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name, currency_mode FROM business_settings LIMIT 1`) || {};
        const name = settings.business_name || t.business_name || t.slug;
        const isUsd = typeof settings.currency_mode === 'string' && settings.currency_mode.includes('USD');

        const rows = db.prepare(`
          SELECT date, revenue, cogs, damages, supplier_rebates,
                 diff_value, cash_difference, pv_total
            FROM daily_profit_summary
           WHERE date BETWEEN ? AND ?
        `).all(from, to);

        // v1.10.312 — DO NOT read gross_profit from daily_profit_summary:
        // that column is already the ADJUSTED value (Revenue − COGS − Damages
        // + Rebates + StockVar + CashVar per profitHelper), so summing it
        // AND then adding Damages/Rebates/StockVar/CashVar downstream would
        // double-count variance. Compute raw Gross = Revenue − COGS here
        // and let the caller apply variance exactly once.
        let bRev = 0, bCogs = 0, bDam = 0, bReb = 0,
            bStk = 0, bCash = 0, bPv = 0;
        for (const r of rows) {
          const toK = v => isUsd ? usdToK(parseFloat(v || 0), r.date) : parseFloat(v || 0);
          bRev  += toK(r.revenue);
          bCogs += toK(r.cogs);
          bDam  += toK(r.damages);
          bReb  += toK(r.supplier_rebates);
          bStk  += toK(r.diff_value);
          bCash += toK(r.cash_difference);
          bPv   += toK(r.pv_total);
        }
        const bGrossRaw = bRev - bCogs;
        const bOperating = bGrossRaw - bDam + bReb + bStk + bCash;
        const bNet = bOperating - bPv;

        perBranch.push({
          slug: t.slug, name, currency: isUsd ? 'USD' : 'K',
          revenue: bRev, cogs: bCogs, gross_profit: bGrossRaw,
          damages: bDam, supplier_rebates: bReb,
          stock_variance: bStk, cash_variance: bCash,
          branch_pv: bPv,
          net_local: bNet,
        });
        revenue += bRev; cogs += bCogs; gross += bGrossRaw;
        damages += bDam; rebates += bReb;
        stockVar += bStk; cashVar += bCash;
        branchPv += bPv;
      } catch (e) {
        console.error(`[hq.income-statement] ${t.slug}:`, e.message);
      }
    }

    // ── HQ overhead (payment_vouchers, tri-currency, excl. LCVs) ─────
    let hqPv = 0;
    try {
      const hqDaily = defaultDb.prepare(`
        SELECT date,
               COALESCE(SUM(usd_amount), 0) AS u,
               COALESCE(SUM(fra_amount), 0) AS f,
               COALESCE(SUM(k_amount),   0) AS k,
               COALESCE(SUM(amount),     0) AS legacy,
               COALESCE(SUM(COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)), 0) AS split
          FROM payment_vouchers
         WHERE deleted_at IS NULL
           AND (is_landed_cost IS NULL OR is_landed_cost = 0)
           AND date BETWEEN ? AND ?
      GROUP BY date
      `).all(from, to);
      for (const r of hqDaily) {
        // If tri-currency columns populated → use them; else fall back to legacy amount as K.
        const inK = (r.split > 0)
          ? (parseFloat(r.k) + usdToK(parseFloat(r.u), r.date) + fraToK(parseFloat(r.f), r.date))
          : parseFloat(r.legacy);
        hqPv += inK;
      }
    } catch (e) {
      console.error('[hq.income-statement] HQ PVs:', e.message);
    }

    // ── P&L structure ────────────────────────────────────────────────
    const variance = -damages + stockVar + cashVar;
    const operatingProfit = gross + variance + rebates;
    const totalOpex = branchPv + hqPv;
    const netProfit = operatingProfit - totalOpex;

    // K/USD rate the report displays as the effective FX for the period
    const rateVals = Object.values(kUsdRate).filter(v => v && v > 0);
    const avgKUsd = rateVals.length ? (rateVals.reduce((a, b) => a + b, 0) / rateVals.length) : null;

    res.json({
      period: { month, from, to },
      currency: 'K',
      fx: {
        source: kassSlug ? `${kassSlug} orders.selling_rate_k_used (K/USD, per-day AVG, forward-filled)` : 'no USD-native branch found',
        avg_k_per_usd: avgKUsd,
      },
      lines: {
        revenue,
        cogs,
        gross_profit: gross,
        damages,
        stock_variance: stockVar,
        cash_variance: cashVar,
        supplier_rebates: rebates,
        variance,
        operating_profit: operatingProfit,
        branch_pv: branchPv,
        hq_pv: hqPv,
        total_opex: totalOpex,
        net_profit: netProfit,
      },
      per_branch: perBranch,
    });
  } catch (error) {
    console.error('[hq.income-statement] failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/hq/balance-sheet?asOf=YYYY-MM-DD ─────────────────────────────
// Financial Statements → Balance Sheet, HQ-only, always in Kwacha.
//
// "Management snapshot" style — everything is computed as-at the date
// with what's currently in the books. Retained Earnings falls out as a
// PLUG so the sheet always balances (Assets = Liabilities + Equity).
// Documented in the response as `plug_note` so the customer sees where
// the number came from.
//
// Assets:
//   Cash & bank   — daily_actual_balance per branch (last row ≤ asOf)
//   Inventory     — SUM(products.current_stock × avg_cost_price) per branch
//                   (as-at NOW; no historical stock reconstruction — noted)
//   Loans receivable — SUM(loans direction=Receivable status=Active principal)
// Liabilities:
//   Loans payable — SUM(loans direction=Payable    status=Active principal)
//   HQ payables   — SUM(hq_purchases balances still owed)
// Equity:
//   Capital       — SUM(capital_account injections − drawings up to asOf)
//   Retained earnings — PLUG = Assets − Liabilities − Capital
router.get('/balance-sheet', hqAuth, requirePagePerm('HqFinancialStatements'), (req, res) => {
  try {
    const asOf = String(req.query.asOf || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return res.status(400).json({ error: 'asOf must be YYYY-MM-DD' });
    }
    const tenants = listTenants();

    // FX map (K/USD) forward-filled up to asOf, for USD-native branches
    let kassSlug = null;
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const cm = tryGet(db, `SELECT currency_mode FROM business_settings LIMIT 1`);
        if (cm && typeof cm.currency_mode === 'string' && cm.currency_mode.includes('USD')) {
          kassSlug = t.slug; break;
        }
      } catch {}
    }
    let effKUsd = null, effFraUsd = null;
    if (kassSlug) {
      try {
        const kdb = getTenantDb(kassSlug);
        const r = tryGet(kdb, `
          SELECT AVG(selling_rate_k_used) AS rate FROM (
            SELECT selling_rate_k_used FROM orders
             WHERE deleted_at IS NULL AND selling_rate_k_used > 0
               AND substr(created_at, 1, 10) <= ?
          ORDER BY created_at DESC LIMIT 30)
        `, asOf);
        if (r?.rate) effKUsd = parseFloat(r.rate);
      } catch (e) { console.error('[hq.balance-sheet] K/USD fx:', e.message); }
      try {
        const kdb = getTenantDb(kassSlug);
        const r = tryGet(kdb, `
          SELECT sell_rate AS rate FROM fx_rates
           WHERE effective_date <= ? AND sell_rate > 0
        ORDER BY effective_date DESC, id DESC LIMIT 1
        `, asOf);
        if (r?.rate) effFraUsd = parseFloat(r.rate);
      } catch (e) { console.error('[hq.balance-sheet] FRA/USD fx:', e.message); }
    }
    const usdToK = v => effKUsd ? (v * effKUsd) : 0;
    // FRA → K: (fra / FRA/USD) × K/USD
    const fraToK = v => (effFraUsd && effKUsd)
      ? (parseFloat(v || 0) / effFraUsd) * effKUsd
      : 0;

    // ── Assets per branch ────────────────────────────────────────────
    let cash = 0, inventory = 0, accountsReceivable = 0, customerAdvances = 0;
    const perBranch = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name, currency_mode FROM business_settings LIMIT 1`) || {};
        const isUsd = typeof settings.currency_mode === 'string' && settings.currency_mode.includes('USD');
        const toK = v => isUsd ? usdToK(parseFloat(v || 0)) : parseFloat(v || 0);

        // Cash & Bank — reuse the exact per-currency logic the Cash Book
        // /stats endpoint uses. computeBranchCashPosition wraps the
        // exported getOpeningByCurrency + ccyReceiptsPayments from
        // routes/cashBook.js. Those helpers read from the request-scoped
        // db proxy, so we must runWithDb(branchDb, ...) before calling.
        let bCash = 0, bCashBreakdown = null;
        try {
          const syncIds = getTenantSyncIds(db);
          const tenantId = syncIds.tenant_id;
          if (tenantId) {
            const pos = runWithDb(db, () => computeBranchCashPosition(db, tenantId, t.slug, asOf));
            bCashBreakdown = pos;
            bCash = pos.k + usdToK(pos.usd) + fraToK(pos.fra);
            console.log(`[hq.balance-sheet] ${t.slug} tid=${tenantId} usd=${pos.usd} fra=${pos.fra} k=${pos.k} → K${bCash.toFixed(2)}`);
          } else {
            console.log(`[hq.balance-sheet] ${t.slug} — no tenant_id in sync_config, skipping cash`);
          }
        } catch (e) {
          console.error(`[hq.balance-sheet] cash ${t.slug}:`, e.message);
        }

        // Inventory — sum stock_movements (authoritative ledger) across
        // BOTH store and sales locations, valued at WAC (avg_cost_price
        // with fallback). Not products.current_stock — that cache drifts
        // from the movement ledger (~1-2% typical) and misses one of the
        // two locations depending on how it's maintained. Store + sales
        // together = total inventory the business owns at this depot.
        let bInv = 0;
        try {
          const row = tryGet(db, `
            SELECT COALESCE(SUM(bal * COALESCE(p.avg_cost_price, p.cost_price, 0)), 0) AS total
              FROM products p
              JOIN (
                SELECT product_sync_id, SUM(quantity) AS bal
                  FROM stock_movements
                 WHERE deleted_at IS NULL
                   AND location IN ('store', 'sales')
                   AND product_sync_id IS NOT NULL
              GROUP BY product_sync_id
              ) bal_agg ON bal_agg.product_sync_id = p.sync_id
             WHERE p.deleted_at IS NULL
          `);
          bInv = toK(row?.total || 0);
        } catch (e) {
          console.error(`[hq.balance-sheet] inventory ${t.slug}:`, e.message);
        }

        // v1.10.313 — Accounts Receivable + Customer Advances (standard
        // balance sheet items — missing from the initial cut on 2026-09-06).
        // AR per customer = total_sold − cash_at_sale − manual AR payments.
        // Positive = customer owes us (asset), negative = we owe customer
        // (liability shown as Customer Advances). Same formula the
        // AccountReceivables screen uses; here we split by sign.
        let bAr = 0, bAdv = 0;
        try {
          const rows = db.prepare(`
            SELECT
              c.sync_id,
              COALESCE(orders_agg.total_sold, 0)
                - COALESCE(orders_agg.cash_at_sale, 0)
                - COALESCE(payments_agg.total_paid, 0) AS outstanding
            FROM customers c
            LEFT JOIN (
              SELECT customer_sync_id,
                SUM(total_amount)                                            AS total_sold,
                SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                         THEN total_amount
                         ELSE COALESCE(amount_received, 0) END)              AS cash_at_sale
              FROM orders
              WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
                AND customer_sync_id IS NOT NULL
                AND substr(created_at, 1, 10) <= ?
              GROUP BY customer_sync_id
            ) orders_agg ON orders_agg.customer_sync_id = c.sync_id
            LEFT JOIN (
              SELECT customer_sync_id, SUM(amount) AS total_paid
              FROM customer_payments
              WHERE deleted_at IS NULL AND customer_sync_id IS NOT NULL
                AND payment_date <= ?
              GROUP BY customer_sync_id
            ) payments_agg ON payments_agg.customer_sync_id = c.sync_id
            WHERE c.deleted_at IS NULL
          `).all(asOf, asOf);
          for (const r of rows) {
            const out = parseFloat(r.outstanding || 0);
            if (out > 0.01)      bAr  += toK(out);          // customer owes us
            else if (out < -0.01) bAdv += toK(-out);         // we owe customer
          }
        } catch (e) { console.error(`[hq.balance-sheet] AR ${t.slug}:`, e.message); }

        perBranch.push({
          slug: t.slug,
          name: settings.business_name || t.business_name || t.slug,
          currency: isUsd ? 'USD' : 'K',
          cash: bCash,
          cash_breakdown: bCashBreakdown,  // { usd, fra, k } in native
          inventory: bInv,
          accounts_receivable: bAr,
          customer_advances: bAdv,
        });
        cash += bCash; inventory += bInv;
        accountsReceivable += bAr; customerAdvances += bAdv;
      } catch (e) {
        console.error(`[hq.balance-sheet] ${t.slug}:`, e.message);
      }
    }

    // ── HQ-side items (defaultDb) ────────────────────────────────────
    let loansReceivable = 0, loansPayable = 0, capital = 0, hqPayables = 0;
    try {
      const r = tryGet(defaultDb, `
        SELECT COALESCE(SUM(principal_amount), 0) AS total
          FROM loans
         WHERE status = 'Active' AND direction = 'Receivable'
           AND (start_date IS NULL OR start_date <= ?)
      `, asOf);
      loansReceivable = parseFloat(r?.total || 0);
    } catch (e) { console.error('[hq.balance-sheet] loans_rcv:', e.message); }
    try {
      const r = tryGet(defaultDb, `
        SELECT COALESCE(SUM(principal_amount), 0) AS total
          FROM loans
         WHERE status = 'Active' AND direction = 'Payable'
           AND (start_date IS NULL OR start_date <= ?)
      `, asOf);
      loansPayable = parseFloat(r?.total || 0);
    } catch (e) { console.error('[hq.balance-sheet] loans_pay:', e.message); }
    try {
      const r = tryGet(defaultDb, `
        SELECT
          COALESCE(SUM(CASE WHEN type='Injection' THEN amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type='Drawing'   THEN amount ELSE 0 END), 0) AS total
          FROM capital_account
         WHERE date <= ?
      `, asOf);
      capital = parseFloat(r?.total || 0);
    } catch (e) { console.error('[hq.balance-sheet] capital:', e.message); }

    // HQ cash lives in defaultDb (backend/sosna.db). HQ's sync_config
    // has no tenant_id; ccyReceiptsPayments' source-table queries need
    // a tenant_id though. On Sosna, HQ rows use a well-known tenant_id
    // — read it from any row on the tables. Fallback: try 'hq' as the
    // slug for HQ deposit direction detection.
    try {
      // HQ tenant_id is stored on cash_receipts / payment_vouchers rows
      // (typically the literal string 'local-only' on Sosna HQ, per the
      // diagnostic on 2026-09-20). Try each table in turn.
      let hqTid = tryGet(defaultDb,
        "SELECT tenant_id FROM cash_receipts WHERE tenant_id IS NOT NULL LIMIT 1"
      )?.tenant_id;
      if (!hqTid) {
        hqTid = tryGet(defaultDb,
          "SELECT tenant_id FROM payment_vouchers WHERE tenant_id IS NOT NULL LIMIT 1"
        )?.tenant_id;
      }
      if (hqTid) {
        const hqPos = runWithDb(defaultDb, () => computeBranchCashPosition(defaultDb, hqTid, 'hq', asOf));
        const hqCashK = hqPos.k + usdToK(hqPos.usd) + fraToK(hqPos.fra);
        cash += hqCashK;
        console.log(`[hq.balance-sheet] HQ tid=${hqTid} usd=${hqPos.usd} fra=${hqPos.fra} k=${hqPos.k} → K${hqCashK.toFixed(2)}`);
        perBranch.push({
          slug: 'hq',
          name: 'Head Office',
          currency: 'K',
          cash: hqCashK,
          cash_breakdown: hqPos,
          inventory: 0,
          accounts_receivable: 0,
          customer_advances: 0,
        });
      } else {
        console.log('[hq.balance-sheet] HQ — no tenant_id found in defaultDb source tables, skipping');
      }
    } catch (e) {
      console.error('[hq.balance-sheet] HQ cash:', e.message);
    }

    const totalAssets = cash + accountsReceivable + inventory + loansReceivable;
    const totalLiabilities = customerAdvances + loansPayable + hqPayables;
    // Retained earnings falls out so Assets = Liabilities + Equity
    const retainedEarnings = totalAssets - totalLiabilities - capital;
    const totalEquity = capital + retainedEarnings;

    res.json({
      asOf,
      currency: 'K',
      fx: {
        source: kassSlug ? `${kassSlug} orders.selling_rate_k_used (K/USD, last 30 orders ≤ asOf)` : 'no USD-native branch found',
        k_per_usd: effKUsd,
      },
      assets: {
        cash,
        accounts_receivable: accountsReceivable,
        inventory,
        loans_receivable: loansReceivable,
        total: totalAssets,
      },
      liabilities: {
        customer_advances: customerAdvances,
        loans_payable: loansPayable,
        hq_payables: hqPayables,
        total: totalLiabilities,
      },
      equity: {
        capital,
        retained_earnings: retainedEarnings,
        total: totalEquity,
      },
      plug_note: 'Retained earnings computed as PLUG (Assets − Liabilities − Capital) so the sheet balances. Absent a formal 31 Jul opening position, this figure absorbs all unrecorded equity + payables from prior periods.',
      per_branch: perBranch,
    });
  } catch (error) {
    console.error('[hq.balance-sheet] failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/hq/cash-flow?month=YYYY-MM ───────────────────────────────────
// Financial Statements → Cash Flow Statement (direct method), HQ-only, K.
//
// Aggregates cash movements from the group's cash_book for the month,
// categorised into Operating / Investing / Financing per standard CFS
// layout. Direct method chosen (over indirect) because Sosna's cash_book
// already tags each row by category — no need to reverse-engineer working
// capital deltas.
//
// Categories (per cash_book.transaction_type + linked source):
//   Operating: sale collections, supplier payments, opex PVs, salaries
//   Investing: loans issued (Receivable disbursement), capex
//   Financing: loan received (Payable disbursement), loan repayment,
//              capital injection/drawing, dividends
router.get('/cash-flow', hqAuth, requirePagePerm('HqFinancialStatements'), (req, res) => {
  try {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to   = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

    const tenants = listTenants();

    // FX rate — same K/USD forward-filled average across the month
    let kassSlug = null;
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const cm = tryGet(db, `SELECT currency_mode FROM business_settings LIMIT 1`);
        if (cm && typeof cm.currency_mode === 'string' && cm.currency_mode.includes('USD')) {
          kassSlug = t.slug; break;
        }
      } catch {}
    }
    let effKUsd = null;
    if (kassSlug) {
      try {
        const kdb = getTenantDb(kassSlug);
        const r = tryGet(kdb, `
          SELECT AVG(selling_rate_k_used) AS rate FROM orders
           WHERE deleted_at IS NULL AND selling_rate_k_used > 0
             AND substr(created_at, 1, 10) BETWEEN ? AND ?
        `, [from, to]);
        if (r?.rate) effKUsd = parseFloat(r.rate);
      } catch (e) { console.error('[hq.cash-flow] fx:', e.message); }
    }
    const usdToK = v => effKUsd ? (v * effKUsd) : 0;

    // Per-branch cash_book aggregation
    // amount_in - amount_out per transaction_type
    let opInflow = 0, opOutflow = 0;
    let invInflow = 0, invOutflow = 0;
    let finInflow = 0, finOutflow = 0;

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT currency_mode FROM business_settings LIMIT 1`) || {};
        const isUsd = typeof settings.currency_mode === 'string' && settings.currency_mode.includes('USD');
        const toK = v => isUsd ? usdToK(parseFloat(v || 0)) : parseFloat(v || 0);

        let rows = [];
        try {
          rows = db.prepare(`
            SELECT transaction_type,
                   COALESCE(SUM(amount_in),  0) AS inflow,
                   COALESCE(SUM(amount_out), 0) AS outflow
              FROM cash_book
             WHERE date BETWEEN ? AND ?
               AND (deleted_at IS NULL)
          GROUP BY transaction_type
          `).all(from, to);
        } catch { /* schema variance */ }

        for (const r of rows) {
          const tt = String(r.transaction_type || '').toLowerCase();
          const inK  = toK(r.inflow);
          const outK = toK(r.outflow);

          // Financing types
          if (tt.includes('capital') || tt.includes('dividend') ||
              tt.includes('loan') && !tt.includes('receivable')) {
            finInflow  += inK;
            finOutflow += outK;
          } else if (tt.includes('receivable') || tt.includes('capex') || tt.includes('investment')) {
            invInflow  += inK;
            invOutflow += outK;
          } else {
            // Everything else = operating (sales, supplier, opex, salaries, GRN payment, etc.)
            opInflow  += inK;
            opOutflow += outK;
          }
        }
      } catch (e) {
        console.error(`[hq.cash-flow] ${t.slug}:`, e.message);
      }
    }

    const opNet  = opInflow  - opOutflow;
    const invNet = invInflow - invOutflow;
    const finNet = finInflow - finOutflow;
    const netChangeInCash = opNet + invNet + finNet;

    res.json({
      period: { month, from, to },
      currency: 'K',
      fx: {
        source: kassSlug ? `${kassSlug} orders.selling_rate_k_used (avg for period)` : 'no USD-native branch found',
        k_per_usd: effKUsd,
      },
      method: 'direct',
      operating: {
        inflows: opInflow,
        outflows: opOutflow,
        net: opNet,
      },
      investing: {
        inflows: invInflow,
        outflows: invOutflow,
        net: invNet,
      },
      financing: {
        inflows: finInflow,
        outflows: finOutflow,
        net: finNet,
      },
      net_change_in_cash: netChangeInCash,
    });
  } catch (error) {
    console.error('[hq.cash-flow] failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
