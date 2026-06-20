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

module.exports = router;
