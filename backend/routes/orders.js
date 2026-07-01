const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard, requirePagePerm } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { conversionToBase, baseQtyExpr } = require('../config/unitsHelper');

// Get distinct users that have orders (for filter dropdown).
// v1.9.1 — JOIN by sync_id (with fallback to local id for legacy rows whose
// backfill couldn't run, e.g. user later deleted from this DB).
router.get('/users', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT o.created_by, u.first_name || ' ' || u.last_name AS full_name
       FROM orders o
       LEFT JOIN users u ON u.sync_id = o.created_by_sync_id
                         OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
       WHERE o.deleted_at IS NULL AND o.tenant_id = ? AND o.created_by IS NOT NULL`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all orders
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM orders WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY created_at DESC').all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.8.86 — Cashier Payment History: read-only list of orders the Cashier
// has already collected payment on. Newest first, limited to 50 by default
// (override with ?limit=N). Same column shape as cashier-inbox so the same
// list card UI can render it without changes.
router.get('/payment-history', auth, readOnlyGuard, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount, o.subtotal, o.discount,
              o.paid_at, o.sales_at, o.cashier_user_id, o.currency,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS sales_by_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_sync_id = o.sync_id AND oi.deleted_at IS NULL) AS item_count
       FROM orders o
       LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                          OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
       WHERE o.deleted_at IS NULL
         AND o.status IN ('PAID', 'DISPATCHED', 'COMPLETED', 'Partial')
         AND o.tenant_id = ?
       ORDER BY COALESCE(o.paid_at, o.created_at) DESC
       LIMIT ?`
    ).all(req.user.tenantId, limit);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.8.87 — Admin-only post-payment edit (typos, wrong currency, wrong rate).
// Mutates only the 12 payment/rate fields + recomputes amount_received from
// (cash + fra/sellRate + k/sellRateK). Stock, items, customer credit limit,
// order_number stay untouched. Writes an audit row to order_payment_edits.
// Rules: Administrator role · order has paid_at · paid_at within 7 days ·
// reason >= 3 chars. Response includes cr_exists flag so the frontend can
// nudge the user to re-Save the day's Cash Report (no auto-fix).
router.put('/:id/edit-payment', auth, (req, res) => {
  try {
    if (req.user.role !== 'Administrator') {
      return res.status(403).json({ error: 'Only administrators can edit payments.' });
    }
    const reason = (req.body.reason || '').trim();
    if (reason.length < 3) {
      return res.status(400).json({ error: 'Reason must be at least 3 characters.' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
      .get(req.params.id, req.user.tenantId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.paid_at) return res.status(400).json({ error: 'Order has no payment to edit.' });
    const paidAtMs = new Date(order.paid_at + (order.paid_at.includes('T') ? '' : 'Z')).getTime();
    const daysSince = (Date.now() - paidAtMs) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) {
      return res.status(400).json({ error: `Order paid ${Math.floor(daysSince)} days ago — outside the 7-day edit window.` });
    }

    const oldPayload = {
      cash_received:        order.cash_received,
      fra_received:         order.fra_received,
      k_received:           order.k_received,
      usd_change_given:     order.usd_change_given,
      fra_change_given:     order.fra_change_given,
      k_change_given:       order.k_change_given,
      overpaid_kept_ccy:    order.overpaid_kept_ccy,
      overpaid_kept_amt:    order.overpaid_kept_amt,
      selling_rate_used:    order.selling_rate_used,
      buying_rate_used:     order.buying_rate_used,
      selling_rate_k_used:  order.selling_rate_k_used,
      buying_rate_k_used:   order.buying_rate_k_used,
      amount_received:      order.amount_received,
    };

    const num = (v) => parseFloat(v) || 0;
    const newPayload = {
      cash_received:        num(req.body.cash_received),
      fra_received:         num(req.body.fra_received),
      k_received:           num(req.body.k_received),
      usd_change_given:     num(req.body.usd_change_given),
      fra_change_given:     num(req.body.fra_change_given),
      k_change_given:       num(req.body.k_change_given),
      overpaid_kept_ccy:    req.body.overpaid_kept_ccy || null,
      overpaid_kept_amt:    num(req.body.overpaid_kept_amt),
      selling_rate_used:    num(req.body.selling_rate_used),
      buying_rate_used:     num(req.body.buying_rate_used),
      selling_rate_k_used:  num(req.body.selling_rate_k_used),
      buying_rate_k_used:   num(req.body.buying_rate_k_used),
    };

    // amount_received = USD-equivalent of cash + fra/sellFRA + k/sellK
    const newAmountReceived =
      newPayload.cash_received
      + (newPayload.selling_rate_used   > 0 ? newPayload.fra_received / newPayload.selling_rate_used   : 0)
      + (newPayload.selling_rate_k_used > 0 ? newPayload.k_received   / newPayload.selling_rate_k_used : 0);
    newPayload.amount_received = newAmountReceived;

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const editorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email || 'unknown';

    db.transaction(() => {
      db.prepare(`
        UPDATE orders SET
          cash_received       = ?,
          fra_received        = ?,
          k_received          = ?,
          usd_change_given    = ?,
          fra_change_given    = ?,
          k_change_given      = ?,
          overpaid_kept_ccy   = ?,
          overpaid_kept_amt   = ?,
          selling_rate_used   = ?,
          buying_rate_used    = ?,
          selling_rate_k_used = ?,
          buying_rate_k_used  = ?,
          amount_received     = ?,
          synced              = 0,
          updated_at          = datetime('now')
        WHERE id = ?
      `).run(
        newPayload.cash_received, newPayload.fra_received, newPayload.k_received,
        newPayload.usd_change_given, newPayload.fra_change_given, newPayload.k_change_given,
        newPayload.overpaid_kept_ccy, newPayload.overpaid_kept_amt,
        newPayload.selling_rate_used, newPayload.buying_rate_used,
        newPayload.selling_rate_k_used, newPayload.buying_rate_k_used,
        newAmountReceived,
        req.params.id
      );

      db.prepare(`
        INSERT INTO order_payment_edits
          (order_id, order_sync_id, edited_by, edited_by_name, edited_at, reason,
           old_payload, new_payload, sync_id, tenant_id, branch_id, device_id, synced,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), ?,
                ?, ?, ?, ?, ?, ?, 0,
                datetime('now'), datetime('now'))
      `).run(
        order.id, order.sync_id, req.user.id, editorName, reason,
        JSON.stringify(oldPayload), JSON.stringify(newPayload),
        randomUUID(), tenantId, branchId, deviceId
      );
    })();

    // CR existence check — does a Sales CR row exist for this order's paid date + cashier?
    // If yes, frontend will warn the user to re-Save the Cash Report.
    const paidDate = (order.paid_at || '').slice(0, 10);
    let crExists = false;
    let crCashierName = null;
    if (paidDate && order.cashier_user_id) {
      // v1.9.1 — look up by sync_id first (stable across DBs); fall back to
      // the legacy local-integer id only when the new column is empty (e.g.
      // for pre-fix rows that haven't been backfilled yet).
      const cashier = db.prepare(
        `SELECT first_name, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS full_name
           FROM users
          WHERE sync_id = ?
             OR (? IS NULL AND id = ?)
          LIMIT 1`
      ).get(order.cashier_user_sync_id || null, order.cashier_user_sync_id || null, order.cashier_user_id);
      crCashierName = cashier?.full_name || `User ${order.cashier_user_id}`;
      const receivedFrom = cashier?.first_name ? `Sales / ${cashier.first_name}` : 'Sales';
      const crRow = db.prepare(
        `SELECT id FROM cash_receipts
          WHERE deleted_at IS NULL AND tenant_id = ? AND received_from = ? AND date = ?`
      ).get(tenantId, receivedFrom, paidDate);
      crExists = !!crRow;
    }

    const updated = db.prepare(
      `SELECT o.*,
              TRIM(COALESCE(u.first_name,  '') || ' ' || COALESCE(u.last_name,  '')) AS created_by_name,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name
         FROM orders o
         LEFT JOIN users u  ON u.sync_id  = o.created_by_sync_id
                            OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
         LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                            OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
        WHERE o.id = ?`
    ).get(req.params.id);
    res.json({ order: updated, cr_exists: crExists, cr_date: paidDate, cr_cashier_name: crCashierName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dispatch inbox — list orders that the Cashier has collected payment on
// and that are now waiting to be physically released by the Dispatch
// station. Same FIFO ordering as the Cashier inbox so the oldest order
// gets handed over first.
router.get('/dispatch-inbox', auth, requirePagePerm('Dispatch'), readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount, o.subtotal, o.discount,
              o.paid_at, o.sales_at, o.cashier_user_id, o.currency,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_sync_id = o.sync_id AND oi.deleted_at IS NULL) AS item_count
       FROM orders o
       LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                          OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
       WHERE o.deleted_at IS NULL
         AND o.status = 'PAID'
         AND o.tenant_id = ?
       ORDER BY COALESCE(o.paid_at, o.created_at) ASC`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dispatch confirms goods released — 3-station flow's final step.
// This is the point at which stock physically leaves and we mint the
// stock_movements rows that the rest of the system (Bin Card, profit, etc.)
// reads. Also stamps dispatch_user_id + dispatched_at and triggers profit
// recalc so the day's revenue lines up with the day's COGS.
router.put('/:id/confirm-dispatch', auth, requirePagePerm('Dispatch'), (req, res) => {
  try {
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
        .get(req.params.id, req.user.tenantId);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status !== 'PAID') {
        throw Object.assign(new Error('Order is not awaiting dispatch'), { status: 400 });
      }

      // Pull line items and decrement stock the same way POST /orders does
      // (see the single_pos checkout block above) — keeps Bin Card / profit
      // calculations identical regardless of which workflow created the row.
      const items = db.prepare(
        `SELECT oi.product_id, oi.product_sync_id, oi.quantity, oi.unit, oi.product_name
         FROM order_items oi
         WHERE oi.order_sync_id = ? AND oi.deleted_at IS NULL`
      ).all(order.sync_id);

      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const movSql = `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`;
      const movStmt = db.prepare(movSql);

      for (const it of items) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(it.product_id);
        const productSyncId = it.product_sync_id || prod?.sync_id || null;
        const lineUnit = (it.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, lineUnit);
        movStmt.run(
          it.product_id, productSyncId, 'sales', 'sale', -baseQty,
          order.id, 'order', req.user.id,
          randomUUID(), tenantId, branchId, deviceId,
          order.sync_id
        );
      }

      // v1.9.1 — also stamp sync_id so cross-device dispatch attribution stays right.
      const userSyncId = db.prepare('SELECT sync_id FROM users WHERE id = ?').get(req.user.id)?.sync_id || null;
      db.prepare(`
        UPDATE orders
           SET status                 = 'DISPATCHED',
               dispatch_user_id       = ?,
               dispatch_user_sync_id  = ?,
               dispatched_at          = datetime('now'),
               synced                 = 0,
               updated_at             = datetime('now')
         WHERE id = ?
      `).run(req.user.id, userSyncId, req.params.id);

      return db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    })();

    // Sale is now fully realised: revenue (collected at Cashier) + COGS
    // (just minted above). Recalc the daily profit row.
    const orderDate = (result.created_at || '').split(' ')[0] || new Date().toISOString().split('T')[0];
    recalculateDailyProfit(db, orderDate, req.user.tenantId);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cashier inbox — list orders awaiting payment in the 3-station flow.
// The Sales station POSTs orders with status='PENDING_PAYMENT'; this endpoint
// is what the Cashier page polls. Sorted by sales_at ASC so the oldest pending
// order is processed first (FIFO — fair to the customer who arrived earliest).
router.get('/cashier-inbox', auth, requirePagePerm('Cashier'), readOnlyGuard, (req, res) => {
  try {
    // customers.outstanding is NOT a column — it's computed as
    // SUM(orders.unpaid) − SUM(customer_payments.amount). Two
    // aggregation subqueries handle that here so the Cashier can show
    // the customer's running balance + available credit before taking
    // the partial payment.
    const rows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.customer_id, o.customer_sync_id,
              o.total_amount, o.subtotal, o.discount,
              o.sales_at, o.sales_user_id, o.currency,
              c.credit_limit AS customer_credit_limit,
              c.credit_status AS customer_credit_status,
              ( COALESCE(oa.sales_outstanding, 0) - COALESCE(pa.total_paid, 0) ) AS customer_outstanding,
              TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS sales_by_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_sync_id = o.sync_id AND oi.deleted_at IS NULL) AS item_count
       FROM orders o
       LEFT JOIN users u     ON u.sync_id = o.sales_user_sync_id
                              OR (o.sales_user_sync_id IS NULL AND u.id = o.sales_user_id)
       LEFT JOIN customers c ON c.id = o.customer_id AND c.deleted_at IS NULL
       LEFT JOIN (
         SELECT customer_sync_id,
                SUM(total_amount)
                - SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                           THEN total_amount
                           ELSE COALESCE(amount_received, 0) END) AS sales_outstanding
         FROM orders
         WHERE deleted_at IS NULL
           AND (status IS NULL OR status != 'Reversed')
           AND customer_sync_id IS NOT NULL
         GROUP BY customer_sync_id
       ) oa ON oa.customer_sync_id = c.sync_id
       LEFT JOIN (
         SELECT customer_sync_id, SUM(amount) AS total_paid
         FROM customer_payments
         WHERE deleted_at IS NULL AND customer_sync_id IS NOT NULL
         GROUP BY customer_sync_id
       ) pa ON pa.customer_sync_id = c.sync_id
       WHERE o.deleted_at IS NULL
         AND o.status = 'PENDING_PAYMENT'
         AND o.tenant_id = ?
       ORDER BY COALESCE(o.sales_at, o.created_at) ASC`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create order (POS checkout)
router.post('/', auth, (req, res) => {
  try {
    const {
      customer_name, customer_id, customer_sync_id, items, payment_method,
      subtotal, tax_amount, total_amount, discount, amount_received, change_amount,
      cash_received, momo_received, bank_received, sale_date,
      // Phase 4 dual-currency FX bucket (kassumbalesa1). K-only branches send
      // nothing here, so the COALESCEs below preserve historical row shape.
      currency, fra_received, fra_change_given, selling_rate_used, buying_rate_used,
      // Triple-currency K bucket (Sosna). POS Credit Sale modal now sends these.
      k_received, k_change_given, selling_rate_k_used, buying_rate_k_used,
      // v1.8.68 — per-currency change tracking. Optional from frontend; if
      // not sent, derived below from change_amount minus fra/k change-given.
      usd_change_given, overpaid_kept_ccy, overpaid_kept_amt,
      // 3-station workflow (kassumbalesa1): when the Sales station confirms an
      // order, status='PENDING_PAYMENT' is sent. We then skip credit checks,
      // skip stock movements (stock decrements at Dispatch), and skip profit
      // recalculation (no revenue realised until Cashier collects payment).
      status,
    } = req.body;
    const orderStatus = (typeof status === 'string' && status.trim().toUpperCase() === 'PENDING_PAYMENT')
      ? 'PENDING_PAYMENT' : null;
    const isPendingPayment = orderStatus === 'PENDING_PAYMENT';
    const orderCurrency  = (typeof currency === 'string' && currency.trim()) ? currency.trim() : 'K';
    const fraReceived    = parseFloat(fra_received     || 0) || 0;
    const fraChangeGiven = parseFloat(fra_change_given || 0) || 0;
    const sellingRateUsed = selling_rate_used !== undefined && selling_rate_used !== null
      ? parseFloat(selling_rate_used) || null : null;
    const buyingRateUsed  = buying_rate_used  !== undefined && buying_rate_used  !== null
      ? parseFloat(buying_rate_used)  || null : null;
    const kReceived       = parseFloat(k_received       || 0) || 0;
    const kChangeGiven    = parseFloat(k_change_given   || 0) || 0;
    const sellingRateKUsed = selling_rate_k_used !== undefined && selling_rate_k_used !== null
      ? parseFloat(selling_rate_k_used) || null : null;
    const buyingRateKUsed  = buying_rate_k_used  !== undefined && buying_rate_k_used  !== null
      ? parseFloat(buying_rate_k_used)  || null : null;

    // v1.8.68 — per-currency change tracking. Three fields are accepted
    // explicitly from the client; when missing we derive them so the bookkeeping
    // is correct even for older POS clients that haven't been updated yet.
    const _changeOwedUSD = parseFloat(change_amount || 0) || 0;
    // v1.8.78 — change handed back is a real currency exchange, BUY rate applies
    // (matches the frontend's totalChangeGiven formula in Cashier.js / POS.js).
    const _fraGivenAsUSD = (buyingRateUsed  || 0) > 0 ? fraChangeGiven / buyingRateUsed  : 0;
    const _kGivenAsUSD   = (buyingRateKUsed || 0) > 0 ? kChangeGiven   / buyingRateKUsed : 0;
    // v1.8.74 — compute per-currency over-payment using source-currency
    // priority (USD pays first, then FRA, then K). Mirrors the collect-payment
    // endpoint + frontend logic so the default keptCcy lands on the currency
    // that actually holds the surplus. NOTE: must compute physical USD here
    // inline because `cashIn` (with its multi-currency fallback) isn't declared
    // until a few lines below (TDZ on the original v1.8.74 attempt).
    const _cashInForOver = (() => {
      const _fraI = parseFloat(fra_received || 0) || 0;
      const _kI   = parseFloat(k_received   || 0) || 0;
      const _isMulti = _fraI > 0 || _kI > 0;
      const _legacy = (payment_method === 'Mobile Money' || payment_method === 'Transfer'
                       || payment_method === 'Bank' || payment_method === 'Bank Transfer') ? 0 : (amount_received || 0);
      return _isMulti
        ? (parseFloat(cash_received || 0) || 0)
        : (parseFloat(cash_received ?? _legacy) || 0);
    })();
    const _totalDuePost = parseFloat(total_amount || 0) || 0;
    let _remPost = _totalDuePost;
    const _usdUsedPost = Math.min(_cashInForOver, _remPost);
    const overUSDcomputedPost = _cashInForOver - _usdUsedPost;
    _remPost -= _usdUsedPost;
    let overFRAcomputedPost = 0;
    if (_remPost > 0 && fraReceived > 0 && (sellingRateUsed || 0) > 0) {
      const fraNeededP = _remPost * sellingRateUsed;
      if (fraReceived >= fraNeededP) { overFRAcomputedPost = fraReceived - fraNeededP; _remPost = 0; }
      else                           { _remPost -= fraReceived / sellingRateUsed; }
    } else if (fraReceived > 0) {
      overFRAcomputedPost = fraReceived;
    }
    let overKcomputedPost = 0;
    if (_remPost > 0 && kReceived > 0 && (sellingRateKUsed || 0) > 0) {
      const kNeededP = _remPost * sellingRateKUsed;
      if (kReceived >= kNeededP) { overKcomputedPost = kReceived - kNeededP; _remPost = 0; }
      else                       { _remPost -= kReceived / sellingRateKUsed; }
    } else if (kReceived > 0) {
      overKcomputedPost = kReceived;
    }

    let overpaidKeptCcy = (overpaid_kept_ccy || '').toUpperCase();
    if (!['USD', 'FRA', 'K'].includes(overpaidKeptCcy)) overpaidKeptCcy = null;
    let overpaidKeptAmt = parseFloat(overpaid_kept_amt || 0) || 0;
    // When the client tells us a kept-currency but no amount, derive from the
    // shortfall: change_amount MINUS what was physically given in any currency.
    // This is the common path for POS.js which only sends keptCcy.
    let usdChangeGiven;
    if (usd_change_given !== undefined && usd_change_given !== null) {
      usdChangeGiven = parseFloat(usd_change_given) || 0;
    } else if (overpaidKeptCcy) {
      // Cashier kept the over-payment → no USD was returned for that portion.
      usdChangeGiven = 0;
    } else {
      usdChangeGiven = Math.max(0, _changeOwedUSD - _fraGivenAsUSD - _kGivenAsUSD);
    }
    // v1.8.74 — when keptCcy missing, default to source-currency of the
    // over-payment (FRA → K → USD priority) instead of legacy USD default.
    if (!overpaidKeptCcy && _changeOwedUSD > 0.005) {
      if      (overFRAcomputedPost > 0.5)   overpaidKeptCcy = 'FRA';
      else if (overKcomputedPost   > 0.5)   overpaidKeptCcy = 'K';
      else if (overUSDcomputedPost > 0.001) overpaidKeptCcy = 'USD';
    }
    if (overpaidKeptCcy && overpaidKeptAmt < 0.005) {
      // v1.8.79 — fall back to USD-leftover × BUY rate (matches frontend
      // display) instead of sell rate, so kept = change owed − change given.
      const keptUSD = Math.max(0, _changeOwedUSD - _fraGivenAsUSD - _kGivenAsUSD - usdChangeGiven);
      if (overpaidKeptCcy === 'USD') {
        overpaidKeptAmt = overUSDcomputedPost > 0.001 ? overUSDcomputedPost : keptUSD;
      } else if (overpaidKeptCcy === 'FRA') {
        overpaidKeptAmt = overFRAcomputedPost > 0.5
          ? overFRAcomputedPost
          : ((buyingRateUsed  || 0) > 0 ? keptUSD * buyingRateUsed  : 0);
      } else if (overpaidKeptCcy === 'K') {
        overpaidKeptAmt = overKcomputedPost > 0.5
          ? overKcomputedPost
          : ((buyingRateKUsed || 0) > 0 ? keptUSD * buyingRateKUsed : 0);
      }
    }
    if (overpaidKeptAmt < 0.005) { overpaidKeptCcy = null; overpaidKeptAmt = 0; }
    // Administrator-only back-dating: when the POS Pay modal sends an explicit
    // sale_date (YYYY-MM-DD), an Administrator can override the server clock.
    // For any other role we silently ignore it.
    const isAdmin = req.user && (req.user.role === 'Administrator' || req.user.role === 'Admin');
    const looksLikeDate = typeof sale_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sale_date);
    const overrideDate = (isAdmin && looksLikeDate) ? sale_date : null;
    // Stamp the override at the same wall-clock time the server would have used,
    // so existing reports and sorts behave naturally.
    const overrideTs = overrideDate ? `${overrideDate} ${new Date().toTimeString().slice(0, 8)}` : null;
    const tsExpr = overrideTs ? '?' : "datetime('now')";
    const tsArgs = overrideTs ? [overrideTs] : [];
    // v1.8.53 — for multi-currency sales (Sosna), `cash_received` MUST be
    // the physical USD only — never the dollar-VALUE of all cash. Falling
    // back to `amount_received` double-counts foreign-currency payments
    // (they appear in both the K/FRA bucket AND the USD bucket).
    //
    // Rule:
    //   - If any FRA/K was paid → cash_received = whatever the client sent,
    //     defaulting to 0 (NOT amount_received).
    //   - Otherwise → keep legacy fallback so single-currency tenants
    //     (lusaka1, mansa1 K-only or USD-only) still work.
    const fraInForFallback = parseFloat(fra_received || 0) || 0;
    const kInForFallback   = parseFloat(k_received   || 0) || 0;
    const isMultiCurrency  = fraInForFallback > 0 || kInForFallback > 0;
    const legacyFallback   = (payment_method === 'Mobile Money' || payment_method === 'Transfer' || payment_method === 'Bank' || payment_method === 'Bank Transfer') ? 0 : (amount_received || 0);
    const cashIn = isMultiCurrency
      ? (parseFloat(cash_received || 0) || 0)
      : (parseFloat(cash_received ?? legacyFallback) || 0);
    const momoIn = parseFloat(momo_received ?? (payment_method === 'Mobile Money' ? amount_received || 0 : 0)) || 0;
    const bankIn = parseFloat(bank_received ?? (payment_method === 'Transfer' || payment_method === 'Bank' || payment_method === 'Bank Transfer' ? amount_received || 0 : 0)) || 0;
    const totalReceived = cashIn + momoIn + bankIn;
    const finalAmountReceived = amount_received !== undefined ? parseFloat(amount_received) || 0 : totalReceived;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const orderNum = syncConfig.generateNumber('ORD', 'orders');

    // ── Server-side credit-limit guard ───────────────────────────────────────
    // Mirrors the POS UI rule: if the buyer matches a known customer,
    // enforce credit_status and credit_limit. Walk-in sales must be paid in full.
    // PENDING_PAYMENT (3-station Sales hand-off) skips this — no payment is
    // being collected here, the Cashier station enforces it at the next stage.
    const unpaid = Math.max(0, parseFloat(total_amount || 0) - parseFloat(amount_received || 0));
    if (!isPendingPayment && unpaid > 0.001) {
      if (!customer_name || !customer_name.trim()) {
        return res.status(400).json({ error: 'Walk-in sales must be paid in full' });
      }
      // Prefer explicit customer_id; fall back to unique-name lookup.
      let cust = null;
      if (customer_id) {
        cust = db.prepare('SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(customer_id, tenantId);
      }
      if (!cust) {
        const matches = db.prepare(
          'SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL AND tenant_id = ?'
        ).all(customer_name.trim(), tenantId);
        if (matches.length === 1) cust = matches[0];
        else if (matches.length > 1) {
          return res.status(400).json({ error: 'Multiple customers match this name — please select the customer explicitly' });
        }
      }
      if (!cust) {
        return res.status(400).json({ error: 'Unknown customer — partial payment requires a registered customer' });
      }
      if (cust.credit_status === 'OnHold') {
        return res.status(400).json({ error: 'Customer is on hold — payment in full required' });
      }
      const limit = parseFloat(cust.credit_limit || 0);
      if (limit > 0) {
        // Existing AR = credit portion of past sales − payments collected later.
        // Then add the unpaid portion of THIS sale on top.
        const sold = db.prepare(`
          SELECT COALESCE(SUM(total_amount - COALESCE(amount_received, 0)), 0) AS s
          FROM orders
          WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
            AND customer_sync_id = ? AND tenant_id = ?
        `).get(cust.sync_id, tenantId).s;
        const paid = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS p
          FROM customer_payments
          WHERE deleted_at IS NULL AND customer_sync_id = ?
        `).get(cust.sync_id).p;
        const projected = (parseFloat(sold) - parseFloat(paid)) + unpaid;
        if (projected > limit + 0.001) {
          return res.status(400).json({
            error: `Sale exceeds credit limit (K${limit.toFixed(2)}). Projected outstanding: K${projected.toFixed(2)}`,
          });
        }
      }
    }

    // v1.9.1 — resolve sync_id for the authenticated user once per order, so
    // we can stamp it on created_by_sync_id (and sales_user_sync_id when
    // pending-payment). Storing the sync_id alongside the legacy integer id
    // means receipts JOIN to the correct user on any device, regardless of
    // local-id collisions when the order syncs cross-device.
    const userSyncId = db.prepare('SELECT sync_id FROM users WHERE id = ?').get(req.user.id)?.sync_id || null;

    const order = db.transaction(() => {
      const orderSyncId = randomUUID();
      // For PENDING_PAYMENT, also stamp sales_user_id + sales_at so the
      // Cashier inbox can show who created it and when.
      const ordSql = `INSERT INTO orders (order_number, customer_name, customer_id, customer_sync_id, subtotal, tax_amount, total_amount, discount,
          amount_received, cash_received, momo_received, bank_received,
          change_amount, usd_change_given, overpaid_kept_ccy, overpaid_kept_amt,
          payment_method, created_by, created_by_sync_id,
          currency, fra_received, fra_change_given, selling_rate_used, buying_rate_used,
          k_received, k_change_given, selling_rate_k_used, buying_rate_k_used,
          status, sales_user_id, sales_user_sync_id, sales_at,
          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${tsExpr},?,?,?,?,0,${tsExpr},${tsExpr})`;
      const ordArgs = [orderNum, customer_name, customer_id || null, customer_sync_id || null,
            subtotal, tax_amount, total_amount, discount || 0,
            finalAmountReceived, cashIn, momoIn, bankIn,
            change_amount || 0, usdChangeGiven, overpaidKeptCcy, overpaidKeptAmt,
            payment_method || 'Cash', req.user.id, userSyncId,
            orderCurrency, fraReceived, fraChangeGiven, sellingRateUsed, buyingRateUsed,
            kReceived, kChangeGiven, sellingRateKUsed, buyingRateKUsed,
            orderStatus,
            isPendingPayment ? req.user.id : null,
            isPendingPayment ? userSyncId   : null];
      if (overrideTs) ordArgs.push(overrideTs);                       // sales_at when override
      ordArgs.push(orderSyncId, tenantId, branchId, deviceId);
      if (overrideTs) ordArgs.push(overrideTs, overrideTs);
      const info = db.prepare(ordSql).run(...ordArgs);

      const orderId = info.lastInsertRowid;

      const itemSql = `INSERT INTO order_items (order_id, order_sync_id, product_id, product_sync_id, product_name, quantity, unit, unit_price, discount, total_price, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,${tsExpr},${tsExpr})`;
      const movSql = `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,${tsExpr},${tsExpr},?)`;
      const itemStmt = db.prepare(itemSql);
      const movStmt  = db.prepare(movSql);

      for (const item of items) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(item.product_id);
        // Prefer client-sent product_sync_id to avoid mis-attributing a sale to
        // the wrong product when local ids drift across PCs.
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(item.quantity) * conversionToBase(prod, lineUnit);
        const lineDiscount = parseFloat(item.discount || 0);
        const itemArgs = [orderId, orderSyncId, item.product_id, productSyncId, item.product_name, item.quantity, lineUnit, item.unit_price, lineDiscount, item.total_price,
              randomUUID(), tenantId, branchId, deviceId];
        if (overrideTs) itemArgs.push(overrideTs, overrideTs);
        itemStmt.run(...itemArgs);

        // PENDING_PAYMENT skips the stock decrement — stock only leaves at
        // Dispatch (see memory [[project-sosna-stock-deduction-timing]]).
        // The matching decrement movement is created when Dispatch confirms.
        if (!isPendingPayment) {
          const movArgs = [item.product_id, productSyncId, 'sales', 'sale', -baseQty, orderId, 'order', req.user.id,
                randomUUID(), tenantId, branchId, deviceId];
          if (overrideTs) movArgs.push(overrideTs, overrideTs);
          movArgs.push(orderSyncId);
          movStmt.run(...movArgs);
        }
      }

      return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    })();

    // PENDING_PAYMENT orders haven't realised revenue yet — Cashier collection
    // is what triggers the profit recalc, not Sales hand-off.
    if (!isPendingPayment) {
      const orderDate = overrideDate || new Date().toISOString().split('T')[0];
      recalculateDailyProfit(db, orderDate, req.user.tenantId);
    }
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/product-breakdown?productName=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns individual sale transactions for a specific product within a date range
router.get('/product-breakdown', auth, readOnlyGuard, (req, res) => {
  try {
    const { productName, from, to, userId } = req.query;
    if (!productName) return res.status(400).json({ error: 'productName is required' });
    let sql = `
      SELECT o.order_number, o.created_at, oi.quantity, oi.unit_price, oi.total_price
      FROM order_items oi
      INNER JOIN orders o ON o.sync_id = oi.order_sync_id
      WHERE o.deleted_at IS NULL
        AND (o.status IS NULL OR o.status != 'Reversed')
        AND oi.deleted_at IS NULL
        AND (oi.reversed IS NULL OR oi.reversed = 0)
        AND o.tenant_id = ?
        AND oi.product_name = ?
    `;
    const params = [req.user.tenantId, productName];
    // from / to are ISO datetimes (UTC) sent by the frontend so the comparison
    // works regardless of the user's timezone. Comparing strings is safe here
    // because SQLite stores datetimes as ISO 8601.
    if (from) { sql += ' AND o.created_at >= ?'; params.push(from); }
    if (to)   { sql += ' AND o.created_at <= ?'; params.push(to); }
    if (userId && userId !== 'all') { sql += ' AND o.created_by = ?'; params.push(userId); }
    sql += ' ORDER BY o.created_at ASC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/product-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns total qty sold and revenue per product for active (non-reversed) orders
router.get('/product-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, userId } = req.query;
    // total_qty is reported in BASE units (sum of oi.quantity × conversion_factor when line is in alt unit).
    // Frontend uses unit + alt_unit + conversion_factor to format dual-unit display.
    let sql = `
      SELECT
        oi.product_name,
        p.category_id,
        c.name AS category_name,
        c.main_category_id,
        p.unit,
        p.alt_unit,
        p.conversion_factor,
        p.units_json,
        p.default_unit,
        SUM(${baseQtyExpr('p', 'oi')}) AS total_qty,
        SUM(oi.total_price) / NULLIF(SUM(${baseQtyExpr('p', 'oi')}), 0) AS avg_price,
        SUM(oi.total_price) AS total_revenue
      FROM order_items oi
      INNER JOIN orders o ON o.sync_id = oi.order_sync_id
      LEFT JOIN products p ON p.sync_id = oi.product_sync_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.deleted_at IS NULL
        AND (o.status IS NULL OR o.status != 'Reversed')
        AND oi.deleted_at IS NULL
        AND (oi.reversed IS NULL OR oi.reversed = 0)
        AND o.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    // from / to are ISO datetimes (UTC) sent by the frontend so the comparison
    // works regardless of the user's timezone. Comparing strings is safe here
    // because SQLite stores datetimes as ISO 8601.
    if (from) { sql += ' AND o.created_at >= ?'; params.push(from); }
    if (to)   { sql += ' AND o.created_at <= ?'; params.push(to); }
    if (userId && userId !== 'all') { sql += ' AND o.created_by = ?'; params.push(userId); }
    sql += ' GROUP BY oi.product_name, p.category_id, c.name, c.main_category_id, p.unit, p.alt_unit, p.conversion_factor, p.units_json, p.default_unit ORDER BY total_revenue DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get order details
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const order = db.prepare(
      `SELECT o.*,
              TRIM(COALESCE(u.first_name,  '') || ' ' || COALESCE(u.last_name,  '')) AS created_by_name,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name
       FROM orders o
       LEFT JOIN users u  ON u.sync_id  = o.created_by_sync_id
                          OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
       LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                          OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
       WHERE o.id = ? AND o.deleted_at IS NULL AND o.tenant_id = ?`
    ).get(req.params.id, req.user.tenantId);
    const items = db.prepare(
      `SELECT oi.*, p.alt_unit, p.conversion_factor, p.unit AS product_base_unit,
              p.default_unit, p.units_json
       FROM order_items oi
       LEFT JOIN products p ON p.sync_id = oi.product_sync_id
       WHERE oi.order_sync_id = ? AND oi.deleted_at IS NULL`
    ).all(order?.sync_id);
    res.json({ ...order, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cashier collects payment on a PENDING_PAYMENT order.
// 3-station flow: marks PAID; stock deducts later at Dispatch.
// 2-station flow (v1.6.3): marks DISPATCHED + deducts stock here. No
// separate dispatch step — used by branches that don't have a dedicated
// dispatch role. See workflow_mode='two_station' on business_settings.
router.put('/:id/collect-payment', auth, requirePagePerm('Cashier'), (req, res) => {
  try {
    const {
      paid_usd, paid_fra, given_usd, given_fra,
      buy_rate, sell_rate,
      // v1.7.0 — third currency (K). Optional; cashier sends 0 / null when
      // not using K. Math: same Sirak pattern as FRA, just adds a 3rd term.
      paid_k, given_k, sell_rate_k, buy_rate_k,
      // v1.8.68 — over-payment kept by cashier (no change handed back).
      // Cashier picks which drawer holds the surplus so Cash Report doesn't
      // bleed it into the wrong currency.
      overpaid_kept_ccy,
      // v1.8.72 — frontend now sends the NATIVE source-currency amount
      // (e.g. FRA 250 instead of $0.108 → 246 FRA round-trip). When
      // present > 0, backend uses it verbatim instead of recomputing.
      overpaid_kept_amt,
    } = req.body;
    const paidUSD = parseFloat(paid_usd || 0) || 0;
    const paidFRA = parseFloat(paid_fra || 0) || 0;
    const paidK   = parseFloat(paid_k   || 0) || 0;
    const givenUSD = parseFloat(given_usd || 0) || 0;
    const givenFRA = parseFloat(given_fra || 0) || 0;
    const givenK   = parseFloat(given_k   || 0) || 0;
    const sellRate  = parseFloat(sell_rate    || 0) || 0;
    const buyRate   = parseFloat(buy_rate     || 0) || 0;
    const sellRateK = parseFloat(sell_rate_k  || 0) || 0;
    const buyRateK  = parseFloat(buy_rate_k   || 0) || 0;

    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
        .get(req.params.id, req.user.tenantId);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status !== 'PENDING_PAYMENT') {
        throw Object.assign(new Error('Order is not awaiting payment'), { status: 400 });
      }

      // Math (v1.7.0, extended):
      //   paidFRAasUSD     = paidFRA / sellRate
      //   paidKasUSD       = paidK   / sellRateK
      //   totalAmountPaid  = paidUSD + paidFRAasUSD + paidKasUSD
      const paidFRAasUSD = sellRate  > 0 ? paidFRA / sellRate  : 0;
      const paidKasUSD   = sellRateK > 0 ? paidK   / sellRateK : 0;
      const totalAmountPaid = paidUSD + paidFRAasUSD + paidKasUSD;
      const totalDue = parseFloat(order.total_amount || 0);
      const change   = Math.max(0, totalAmountPaid - totalDue);
      const unpaid   = Math.max(0, totalDue - totalAmountPaid);

      // v1.8.68 — figure out the over-payment kept in the drawer (USD-equivalent
      // returned-as-change MINUS what cashier physically returned). What's left
      // is "kept" — by default in the currency the over-payment came from.
      // v1.8.78 — change handed back to customer in foreign currency is a real
      // exchange (we're "buying" USD back with FRA/K). Use BUY rate, matching the
      // frontend's totalChangeGiven formula. Previous SELL-rate use caused
      // frontend ($0.09 short) and backend ($1.07 short) to disagree, leading to
      // wildly inflated overpaid_kept_amt (2,475 FRA instead of ~200 FRA).
      const givenUSDasUSD = givenUSD;
      const givenFRAasUSD = buyRate   > 0 ? givenFRA / buyRate   : 0;
      const givenKasUSD   = buyRateK  > 0 ? givenK   / buyRateK  : 0;
      const totalGivenAsUSD = givenUSDasUSD + givenFRAasUSD + givenKasUSD;
      const overpaidKeptUSD = Math.max(0, change - totalGivenAsUSD);
      // v1.8.74 — attribute the over-payment to its SOURCE currency using
      // the same priority chain as the frontend (USD pays first, then FRA,
      // then K). Whatever's left over in each currency is the native
      // over-payment in that currency. Backend default keptCcy then matches
      // the currency that actually holds the surplus — not the legacy
      // "FRA-only/K-only/else USD" heuristic which incorrectly picked USD
      // any time the customer also paid some USD.
      let _remBe = totalDue;
      const _usdUsedBe = Math.min(paidUSD, _remBe);
      const overUSDcomputed = paidUSD - _usdUsedBe;
      _remBe -= _usdUsedBe;
      let overFRAcomputed = 0;
      if (_remBe > 0 && paidFRA > 0 && sellRate > 0) {
        const fraNeeded = _remBe * sellRate;
        if (paidFRA >= fraNeeded) { overFRAcomputed = paidFRA - fraNeeded; _remBe = 0; }
        else                      { _remBe -= paidFRA / sellRate; }
      } else if (paidFRA > 0) {
        overFRAcomputed = paidFRA;
      }
      let overKcomputed = 0;
      if (_remBe > 0 && paidK > 0 && sellRateK > 0) {
        const kNeeded = _remBe * sellRateK;
        if (paidK >= kNeeded) { overKcomputed = paidK - kNeeded; _remBe = 0; }
        else                  { _remBe -= paidK / sellRateK; }
      } else if (paidK > 0) {
        overKcomputed = paidK;
      }
      // Pick currency: explicit param wins; else default to the currency
      // that actually holds the over-payment (FRA → K → USD priority).
      let keptCcy = (overpaid_kept_ccy || '').toUpperCase();
      if (overpaidKeptUSD < 0.005) {
        keptCcy = null;
      } else if (!['USD', 'FRA', 'K'].includes(keptCcy)) {
        if      (overFRAcomputed > 0.5)   keptCcy = 'FRA';
        else if (overKcomputed   > 0.5)   keptCcy = 'K';
        else if (overUSDcomputed > 0.001) keptCcy = 'USD';
        else                              keptCcy = 'USD';
      }
      // v1.8.72 — prefer the NATIVE amount sent by the frontend (it computed
      // it directly from `paidFRA − fraNeeded`, no FX round-trip). Fall back
      // to source-currency native value computed above.
      // v1.8.79 — when no native amount, convert USD-leftover at BUY rate
      // (consistent with the frontend display rate so 200 kept stays 200,
      // not 203 from sell rate).
      const explicitKeptAmt = parseFloat(overpaid_kept_amt || 0) || 0;
      let keptAmt = 0;
      if (keptCcy && explicitKeptAmt > 0.005) {
        keptAmt = explicitKeptAmt;
      } else if (keptCcy === 'FRA') {
        keptAmt = overFRAcomputed > 0.5
          ? overFRAcomputed
          : (buyRate  > 0 ? overpaidKeptUSD * buyRate  : 0);
      } else if (keptCcy === 'K') {
        keptAmt = overKcomputed > 0.5
          ? overKcomputed
          : (buyRateK > 0 ? overpaidKeptUSD * buyRateK : 0);
      } else if (keptCcy === 'USD') {
        keptAmt = overUSDcomputed > 0.001 ? overUSDcomputed : overpaidKeptUSD;
      }

      // v1.8.49 — credit-at-Cashier. When the order has a registered
      // customer attached (set on the Sales/Reception screen), the Cashier
      // is allowed to take partial payment; the unpaid portion becomes a
      // credit balance on the customer. Walk-ins still must pay in full
      // (with the same 10¢ FRA/K rounding tolerance).
      const hasRegisteredCustomer = !!order.customer_id;
      if (hasRegisteredCustomer && unpaid > 0.10) {
        // Optional credit-limit guard — mirrors POS rule. customers
        // has no `outstanding` column — compute it from orders minus
        // customer_payments (same formula as the AR/customers list).
        const cust = db.prepare(
          'SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?'
        ).get(order.customer_id, req.user.tenantId);
        if (cust) {
          if (cust.credit_status === 'OnHold') {
            throw Object.assign(new Error('Customer is on hold — payment in full required'), { status: 400 });
          }
          const limit = parseFloat(cust.credit_limit || 0);
          if (limit > 0 && cust.sync_id) {
            const owedRow = db.prepare(
              `SELECT SUM(total_amount)
                    - SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                               THEN total_amount
                               ELSE COALESCE(amount_received, 0) END) AS sales_owed
                 FROM orders
                WHERE deleted_at IS NULL
                  AND (status IS NULL OR status != 'Reversed')
                  AND customer_sync_id = ?`
            ).get(cust.sync_id);
            const paidRow = db.prepare(
              `SELECT COALESCE(SUM(amount), 0) AS total_paid
                 FROM customer_payments
                WHERE deleted_at IS NULL AND customer_sync_id = ?`
            ).get(cust.sync_id);
            const currentOutstanding = Math.max(0, parseFloat(owedRow?.sales_owed || 0) - parseFloat(paidRow?.total_paid || 0));
            const projected = currentOutstanding + unpaid;
            if (projected > limit + 0.001) {
              throw Object.assign(new Error(`Would exceed credit limit by ${(projected - limit).toFixed(2)}`), { status: 400 });
            }
          }
        }
      } else if (unpaid > 0.10) {
        throw Object.assign(new Error(`Payment is short by ${unpaid.toFixed(2)} ${order.currency || 'USD'}`), { status: 400 });
      }
      const isCreditCollection = hasRegisteredCustomer && unpaid > 0.10;
      const isFullCredit       = hasRegisteredCustomer && totalAmountPaid < 0.001;
      const paymentMethod      = isFullCredit ? 'Credit' : isCreditCollection ? 'Partial-Credit' : 'Cash';

      // v1.6.3 — detect workflow mode. two_station = stock deducts here.
      const wm = (db.prepare("SELECT workflow_mode FROM business_settings LIMIT 1").get()?.workflow_mode || 'three_station').toLowerCase();
      const isTwoStation = wm === 'two_station';

      // v1.9.1 — stamp the cashier's sync_id (and dispatch sync_id for the
      // two-station shortcut) so cross-device receipts show the right name.
      const userSyncId = db.prepare('SELECT sync_id FROM users WHERE id = ?').get(req.user.id)?.sync_id || null;

      db.prepare(`
        UPDATE orders
           SET status                = ?,
               cashier_user_id       = ?,
               cashier_user_sync_id  = ?,
               paid_at               = datetime('now'),
               amount_received       = ?,
               cash_received         = ?,
               momo_received         = 0,
               bank_received         = 0,
               change_amount         = ?,
               usd_change_given      = ?,
               overpaid_kept_ccy     = ?,
               overpaid_kept_amt     = ?,
               fra_received          = ?,
               fra_change_given      = ?,
               selling_rate_used     = ?,
               buying_rate_used      = ?,
               k_received            = ?,
               k_change_given        = ?,
               selling_rate_k_used   = ?,
               buying_rate_k_used    = ?,
               payment_method        = ?,
               ${isTwoStation ? "dispatch_user_id = ?, dispatch_user_sync_id = ?, dispatched_at = datetime('now')," : ''}
               synced                = 0,
               updated_at            = datetime('now')
         WHERE id = ?
      `).run(...[
        isTwoStation ? 'DISPATCHED' : 'PAID',
        req.user.id,
        userSyncId,
        totalAmountPaid,
        paidUSD,
        change,
        givenUSD,
        keptCcy,
        keptAmt,
        paidFRA, givenFRA, sellRate || null, buyRate || null,
        paidK,   givenK,   sellRateK || null, buyRateK || null,
        paymentMethod,
        ...(isTwoStation ? [req.user.id, userSyncId] : []),
        req.params.id,
      ]);

      // 2-station: also deduct stock from sales location, same as the
      // confirm-dispatch handler does in 3-station.
      if (isTwoStation) {
        const items = db.prepare(
          `SELECT product_id, product_sync_id, quantity, unit
           FROM order_items WHERE order_sync_id = ? AND deleted_at IS NULL`
        ).all(order.sync_id);
        const tenantId = syncConfig.getTenantId(req);
        const { branchId, deviceId } = syncConfig.getConfig();
        const movStmt = db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`
        );
        for (const it of items) {
          // v1.8.39 — look up by sync_id first (cross-device safe); fall
          // back to local integer id only if sync_id is missing. Same
          // localProductId logic as the reverse endpoint — prevents
          // FOREIGN KEY constraint failed on synced orders.
          const prodBySync = it.product_sync_id
            ? db.prepare('SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?').get(it.product_sync_id)
            : null;
          const prod = prodBySync || db.prepare('SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(it.product_id);
          const productSyncId = it.product_sync_id || prod?.sync_id || null;
          const localProductId = prod?.id || it.product_id;
          const lineUnit = (it.unit || '').trim() || prod?.unit || null;
          const baseQty = parseFloat(it.quantity) * conversionToBase(prod, lineUnit);
          movStmt.run(
            localProductId, productSyncId, 'sales', 'sale', -baseQty,
            order.id, 'order', req.user.id,
            randomUUID(), tenantId, branchId, deviceId,
            order.sync_id
          );
        }
      }

      return db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    })();

    // 2-station closes the loop here, so trigger the same daily profit
    // recalc that confirm-dispatch normally would.
    if (result.status === 'DISPATCHED') {
      const orderDate = (result.created_at || '').split(' ')[0] || new Date().toISOString().split('T')[0];
      try { recalculateDailyProfit(db, orderDate, req.user.tenantId); } catch (_) {}
    }
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reverse order - void the order and restore stock
router.put('/:id/reverse', auth, (req, res) => {
  try {
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status === 'Reversed') throw Object.assign(new Error('Order already reversed'), { status: 400 });

      // Soft-delete original sale movements AND any partial sale_reverse counter-movements.
      // Net effect: stock returns to exactly its pre-sale state regardless of any prior partial reversals.
      db.prepare(
        `UPDATE stock_movements SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
         WHERE reference_sync_id = ? AND location = 'sales'
           AND movement_type IN ('sale', 'sale_reverse') AND deleted_at IS NULL`
      ).run(order.sync_id);

      // Mark all line items fully reversed (cumulative reversed_quantity = original quantity).
      // v1.9.4 — bump updated_at on both rows. Without this, sync push to VPS
      // gets silently REJECTed by the timestamp check (incoming == server
      // because the row's local timestamp didn't move when status flipped),
      // and the web side keeps showing PENDING_PAYMENT forever. Reproduced
      // 2026-06-29 with ORD-0058–0061.
      db.prepare(
        `UPDATE order_items
         SET reversed = 1, reversed_quantity = quantity, reversed_at = datetime('now'),
             updated_at = datetime('now'), synced = 0
         WHERE order_sync_id = ? AND reversed = 0 AND deleted_at IS NULL`
      ).run(order.sync_id);
      db.prepare(
        `UPDATE orders SET status = 'Reversed', updated_at = datetime('now'), synced = 0 WHERE id = ?`
      ).run(req.params.id);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    })();

    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (no 'T'), so .split('T')[0] would return the whole string.
    // .slice(0, 10) safely extracts YYYY-MM-DD for both SQLite and ISO formats.
    const orderDate = result.created_at ? result.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
    recalculateDailyProfit(db, orderDate, req.user.tenantId);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reverse a single item — supports PARTIAL reversal via body.quantity and body.unit
// Body: { quantity?: number, unit?: string }
//   quantity defaults to remaining line qty
//   unit defaults to the line's original unit (typically what was sold)
//   When unit differs from line.unit, the system converts via product's conversion_factor.
router.put('/:id/items/:itemId/reverse', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const requestedQty = req.body?.quantity != null ? parseFloat(req.body.quantity) : null;
    const requestedUnit = (req.body?.unit || '').trim() || null;

    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status === 'Reversed') throw Object.assign(new Error('Order already fully reversed'), { status: 400 });

      const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_sync_id = ? AND deleted_at IS NULL').get(req.params.itemId, order.sync_id);
      if (!item) throw Object.assign(new Error('Item not found in this order'), { status: 404 });
      if (item.reversed) throw Object.assign(new Error('Item already fully reversed'), { status: 400 });

      // v1.8.39 — include local products.id so the stock_movements INSERT
      // below uses the THIS-DB integer ID, not item.product_id which is
      // the originating device's local ID (cross-device sync sends order
      // rows verbatim so the integer can point at a nonexistent row on
      // the receiving DB → FOREIGN KEY constraint failed).
      const prod = db.prepare('SELECT id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?').get(item.product_sync_id);
      const localProductId = prod?.id || item.product_id;

      // Resolve which unit user is reversing in
      const reverseUnit = requestedUnit || item.unit || prod?.unit;
      const reverseUnitConv = conversionToBase(prod, reverseUnit);
      const lineUnitConv = conversionToBase(prod, item.unit || prod?.unit);

      // Default to full remaining (in line's unit) if no qty given
      const alreadyReversedInLineUnit = parseFloat(item.reversed_quantity || 0);
      const remainingInLineUnit = parseFloat(item.quantity) - alreadyReversedInLineUnit;
      const reverseQty = requestedQty != null ? requestedQty : remainingInLineUnit;
      if (!(reverseQty > 0)) throw Object.assign(new Error('Reverse quantity must be greater than zero'), { status: 400 });

      // Convert reverseQty into BASE units (for stock_movement) and into LINE's unit (for tracking reversed_quantity)
      const reverseBaseQty = reverseQty * reverseUnitConv;
      const lineBaseQty    = parseFloat(item.quantity) * lineUnitConv;
      const reverseInLineUnit = reverseBaseQty / (lineUnitConv || 1);

      // Validate against remaining (compare in line's unit since that's how reversed_quantity is stored)
      if (reverseInLineUnit > remainingInLineUnit + 0.0001) {
        const remBase = remainingInLineUnit * lineUnitConv;
        throw Object.assign(new Error(`Cannot reverse more than ${remainingInLineUnit} ${item.unit || ''} (= ${remBase} ${prod?.unit || 'base units'})`), { status: 400 });
      }

      // Insert positive stock movement in BASE units to restore sales stock
      db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`
      ).run(localProductId, item.product_sync_id, 'sales', 'sale_reverse', reverseBaseQty, req.params.id, 'order_reverse',
            `Partial reverse of ${reverseQty} ${reverseUnit}`, req.user.id,
            randomUUID(), tenantId, branchId, deviceId, order.sync_id);

      // Track reversed_quantity in LINE's unit (so item.quantity vs item.reversed_quantity stays consistent)
      const newReversedQty = alreadyReversedInLineUnit + reverseInLineUnit;
      const fullyReversed = newReversedQty >= parseFloat(item.quantity) - 0.0001;
      db.prepare(
        // v1.9.4 — also bump updated_at; otherwise the row's local timestamp
        // doesn't move, server's timestamp REJECT silently drops the push.
        `UPDATE order_items SET reversed_quantity = ?, reversed = ?, reversed_at = CASE WHEN ? THEN datetime('now') ELSE reversed_at END, updated_at = datetime('now'), synced = 0 WHERE id = ?`
      ).run(newReversedQty, fullyReversed ? 1 : 0, fullyReversed ? 1 : 0, req.params.itemId);

      // Proportional refund based on reversed base qty relative to original base qty
      const refund = (reverseBaseQty / lineBaseQty) * parseFloat(item.total_price);
      const newSubtotal = Math.max(0, parseFloat(order.subtotal) - refund);
      const newTotal = Math.max(0, parseFloat(order.total_amount) - refund);

      // v1.8.12 — refund the customer in the same currency mix they paid with.
      // Otherwise the per-currency cash buckets stay overstated on the Cash
      // Report (status='Partial' leaves the order in the SUM, and cash_received
      // wouldn't drop). Distribution: each currency's USD-equivalent share of
      // the original amount_received determines its share of the refund.
      const oldCash = parseFloat(order.cash_received || 0);
      const oldFra  = parseFloat(order.fra_received  || 0);
      const oldK    = parseFloat(order.k_received    || 0);
      const sellRate  = parseFloat(order.selling_rate_used   || 0);
      const sellRateK = parseFloat(order.selling_rate_k_used || 0);
      const oldAmtRecv = parseFloat(order.amount_received || 0);
      let newCash = oldCash, newFra = oldFra, newK = oldK;
      let newAmtRecv = oldAmtRecv;
      if (oldAmtRecv > 0.0001 && refund > 0.0001) {
        // Each currency's USD-equivalent contribution
        const usdShare = oldCash;
        const fraShare = sellRate  > 0 ? (oldFra / sellRate)  : 0;
        const kShare   = sellRateK > 0 ? (oldK   / sellRateK) : 0;
        const totalShare = usdShare + fraShare + kShare;
        if (totalShare > 0.0001) {
          const refundUsd = refund * (usdShare / totalShare);
          const refundFra = refund * (fraShare / totalShare) * (sellRate  || 0);
          const refundK   = refund * (kShare   / totalShare) * (sellRateK || 0);
          newCash = Math.max(0, oldCash - refundUsd);
          newFra  = Math.max(0, oldFra  - refundFra);
          newK    = Math.max(0, oldK    - refundK);
          newAmtRecv = Math.max(0, oldAmtRecv - refund);
        }
      }

      // Order status: 'Reversed' if every item is fully reversed, else 'Partial' (or original status if nothing reversed)
      const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM order_items WHERE order_sync_id = ? AND reversed = 0 AND deleted_at IS NULL').get(order.sync_id);
      const allReversed = remaining.cnt === 0;

      db.prepare(`UPDATE orders
         SET subtotal = ?, total_amount = ?, status = ?,
             cash_received = ?, fra_received = ?, k_received = ?,
             amount_received = ?,
             updated_at = datetime('now'),
             synced = 0
         WHERE id = ?`).run(
        newSubtotal, newTotal, allReversed ? 'Reversed' : 'Partial',
        newCash, newFra, newK, newAmtRecv,
        req.params.id
      );

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      const allItems = db.prepare('SELECT * FROM order_items WHERE order_sync_id = ? AND deleted_at IS NULL').all(order.sync_id);
      return { ...updatedOrder, items: allItems };
    })();

    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (no 'T'), so .split('T')[0] would return the whole string.
    // .slice(0, 10) safely extracts YYYY-MM-DD for both SQLite and ISO formats.
    const orderDate = result.created_at ? result.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
    recalculateDailyProfit(db, orderDate, req.user.tenantId);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
