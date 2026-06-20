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
const { listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

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
// Returns at most slug + business_name. Anything that would help an
// attacker target a specific branch (status counts, license expiry, etc.)
// stays out — that's tenantAdmin territory.
router.get('/branches', (req, res) => {
  try {
    const rows = listTenants();
    res.json({
      branches: rows.map(r => ({
        slug: r.slug,
        name: r.business_name || r.slug,
      })),
    });
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
        const settings = tryGet(db, `
          SELECT business_name, currency_mode, workflow_mode
            FROM business_settings
           ORDER BY id ASC LIMIT 1
        `) || {};

        branches.push({
          slug: t.slug,
          name: settings.business_name || t.business_name || t.slug,
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

    // Roll-up — sum across all branches (ignores ones that errored).
    const rollup = branches.reduce((acc, b) => {
      if (b.error) return acc;
      acc.today_revenue   += b.today.revenue;
      acc.today_orders    += b.today.orders;
      acc.mtd_revenue     += b.mtd.revenue;
      acc.mtd_orders      += b.mtd.orders;
      acc.pending_payment += b.pending_payment;
      acc.awaiting_dispatch += b.awaiting_dispatch;
      acc.stock_value     += b.stock_value;
      acc.ar_outstanding  += b.ar_outstanding;
      return acc;
    }, { today_revenue:0, today_orders:0, mtd_revenue:0, mtd_orders:0,
         pending_payment:0, awaiting_dispatch:0, stock_value:0, ar_outstanding:0 });

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
            LEFT JOIN users u ON u.id = o.created_by
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
        const settings = tryGet(db, `SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const branchName = settings.business_name || t.business_name || t.slug;
        byBranch[t.slug] = { name: branchName, products: 0, low: 0, stock_value: 0 };

        // Pull active products + category for context.
        let sql = `
          SELECT p.id, p.name, p.unit, p.current_stock, p.min_stock,
                 p.cost_price, p.selling_price, p.status,
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
            current_stock: stock,
            min_stock:   min,
            cost_price:  cost,
            selling_price: parseFloat(p.selling_price || 0),
            value,
            low: isLow,
            status: p.status || 'Active',
          });
        }
      } catch (e) {
        console.error(`[hq.inventory-report] ${t.slug}:`, e.message);
      }
    }

    // Sort combined list by value desc and cap.
    rows.sort((a, b) => b.value - a.value);
    const capped = rows.slice(0, LIMIT);

    const rollup = Object.values(byBranch).reduce((acc, b) => {
      acc.products    += b.products;
      acc.stock_value += b.stock_value;
      acc.low         += b.low;
      return acc;
    }, { products: 0, stock_value: 0, low: 0 });

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

    const sumIn = (db, datePrefix, span) => {
      const wherePref = span === 'today' ? `= ?` : `LIKE ? || '%'`;
      const dateArg   = span === 'today' ? datePrefix : datePrefix;
      const param     = (col) => `substr(COALESCE(${col}, ''), 1, ${span === 'today' ? 10 : 7}) ${wherePref}`;
      // Each subquery filters by its own date column then sums the per-method splits.
      const row = tryGet(db, `
        SELECT
          (SELECT COALESCE(SUM(cash_received), 0)
             FROM orders
            WHERE deleted_at IS NULL
              AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
              AND ${param('paid_at')}) AS sales_cash,
          (SELECT COALESCE(SUM(momo_received), 0)
             FROM orders
            WHERE deleted_at IS NULL
              AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
              AND ${param('paid_at')}) AS sales_momo,
          (SELECT COALESCE(SUM(bank_received), 0)
             FROM orders
            WHERE deleted_at IS NULL
              AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
              AND ${param('paid_at')}) AS sales_bank,
          (SELECT COALESCE(SUM(cash_amount), 0)
             FROM cash_receipts
            WHERE deleted_at IS NULL AND ${param('date')}) AS cr_cash,
          (SELECT COALESCE(SUM(bank_amount), 0)
             FROM cash_receipts
            WHERE deleted_at IS NULL AND ${param('date')}) AS cr_bank,
          (SELECT COALESCE(SUM(momo_amount), 0)
             FROM cash_receipts
            WHERE deleted_at IS NULL AND ${param('date')}) AS cr_momo,
          (SELECT COALESCE(SUM(cash_amount), 0)
             FROM customer_payments
            WHERE deleted_at IS NULL AND ${param('payment_date')}) AS cp_cash,
          (SELECT COALESCE(SUM(bank_amount), 0)
             FROM customer_payments
            WHERE deleted_at IS NULL AND ${param('payment_date')}) AS cp_bank,
          (SELECT COALESCE(SUM(momo_amount), 0)
             FROM customer_payments
            WHERE deleted_at IS NULL AND ${param('payment_date')}) AS cp_momo
      `, [dateArg, dateArg, dateArg, dateArg, dateArg, dateArg, dateArg, dateArg, dateArg]);
      const r = row || {};
      return {
        cash: (r.sales_cash || 0) + (r.cr_cash || 0) + (r.cp_cash || 0),
        bank: (r.sales_bank || 0) + (r.cr_bank || 0) + (r.cp_bank || 0),
        momo: (r.sales_momo || 0) + (r.cr_momo || 0) + (r.cp_momo || 0),
      };
    };

    const sumOut = (db, datePrefix, span) => {
      const param = (col) => `substr(COALESCE(${col}, ''), 1, ${span === 'today' ? 10 : 7}) = ?`;
      const row = tryGet(db, `
        SELECT
          (SELECT COALESCE(SUM(cash_amount), 0) FROM payment_vouchers WHERE deleted_at IS NULL AND ${param('date')}) AS pv_cash,
          (SELECT COALESCE(SUM(bank_amount), 0) FROM payment_vouchers WHERE deleted_at IS NULL AND ${param('date')}) AS pv_bank,
          (SELECT COALESCE(SUM(momo_amount), 0) FROM payment_vouchers WHERE deleted_at IS NULL AND ${param('date')}) AS pv_momo,
          (SELECT COALESCE(SUM(cash_amount), 0) FROM ap_payments WHERE deleted_at IS NULL AND ${param('date')}) AS ap_cash,
          (SELECT COALESCE(SUM(bank_amount), 0) FROM ap_payments WHERE deleted_at IS NULL AND ${param('date')}) AS ap_bank,
          (SELECT COALESCE(SUM(momo_amount), 0) FROM ap_payments WHERE deleted_at IS NULL AND ${param('date')}) AS ap_momo
      `, [datePrefix, datePrefix, datePrefix, datePrefix, datePrefix, datePrefix]);
      const r = row || {};
      return {
        cash: (r.pv_cash || 0) + (r.ap_cash || 0),
        bank: (r.pv_bank || 0) + (r.ap_bank || 0),
        momo: (r.pv_momo || 0) + (r.ap_momo || 0),
      };
    };

    const branches = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const todayIn  = sumIn(db,  todayPrefix, 'today');
        const todayOut = sumOut(db, todayPrefix, 'today');
        const mtdIn    = sumIn(db,  monthPrefix, 'mtd');
        const mtdOut   = sumOut(db, monthPrefix, 'mtd');
        branches.push({
          slug: t.slug,
          name: settings.business_name || t.business_name || t.slug,
          today: {
            in:  todayIn,
            out: todayOut,
            net: { cash: todayIn.cash - todayOut.cash, bank: todayIn.bank - todayOut.bank, momo: todayIn.momo - todayOut.momo },
          },
          mtd: {
            in:  mtdIn,
            out: mtdOut,
            net: { cash: mtdIn.cash - mtdOut.cash, bank: mtdIn.bank - mtdOut.bank, momo: mtdIn.momo - mtdOut.momo },
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
          for (const method of ['cash', 'bank', 'momo']) {
            acc[period][dir][method] += b[period][dir][method];
          }
        }
      }
      return acc;
    }, {
      today: { in: { cash:0, bank:0, momo:0 }, out: { cash:0, bank:0, momo:0 }, net: { cash:0, bank:0, momo:0 } },
      mtd:   { in: { cash:0, bank:0, momo:0 }, out: { cash:0, bank:0, momo:0 }, net: { cash:0, bank:0, momo:0 } },
    });

    res.json({ as_of: new Date().toISOString(), branches, rollup });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
