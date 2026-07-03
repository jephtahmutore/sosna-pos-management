/**
 * hqPurchases.js — HQ-managed supplier purchase receipts.
 *
 * HQ has NO physical warehouse (see project memory + the user's clarif).
 * Every supplier purchase is logged here ONCE at HQ with per-line
 * destination_slug; lines sit PENDING in the destination branch's
 * "Incoming Stock" queue until the branch counts what physically arrived
 * and confirms with received_qty (variance captured for damage/short).
 *
 * On confirm we:
 *   - find product at destination by sync_id (fallback: same name),
 *     auto-create if missing — using the snapshot from the line.
 *   - increment products.current_stock by received_qty (base units).
 *   - insert a stock_movement (location='sales', movement_type='hq_receipt')
 *     so Bin Card + per-branch stock card reflect the arrival.
 *   - flip line status to RECEIVED, stamp received_by + received_at.
 *   - auto-COMPLETE the header once every line is RECEIVED/CANCELLED.
 *
 * Auth: hqAuth (JWT only) — same model as the other HQ routes.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { conversionToBase } = require('../config/unitsHelper');

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

function nextPurchaseNumber() {
  const seq = (masterDb.prepare(`SELECT COUNT(*) AS n FROM hq_purchases`).get()?.n || 0) + 1;
  const yr  = new Date().getFullYear();
  return `HQP-${yr}-${String(seq).padStart(5, '0')}`;
}

function destinationName(slug) {
  try {
    const t = listTenants().find(t => t.slug === slug);
    if (!t) return slug;
    try {
      const db = getTenantDb(slug);
      const row = db.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
      if (row?.business_name) return row.business_name;
    } catch (_) {}
    return t.business_name || slug;
  } catch (_) { return slug; }
}

// POST /api/hq/purchases
// Body: { supplier_name, invoice_number, date, notes,
//         items: [{product_sync_id?, product_name, unit, dispatched_qty,
//                  cost_price, destination_slug}] }
//
// product_sync_id is optional — when blank we auto-generate one so the
// destination branch creates a matching product on receive. Pre-existing
// branch products can be linked by passing their sync_id.
router.post('/', hqAuth, (req, res) => {
  try {
    const { supplier_id, supplier_name, invoice_number, date, notes, items,
            cost_currency, fx_rate_used } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item required' });
    }

    // v1.10.54 — FX rate at PO Create (WAC redesign push 2).
    // Rate is captured HERE, one rate for the whole PO, per user's
    // 2026-07-03 design memo. Validation is soft: if the caller sends
    // cost_currency + fx_rate_used they must both be sane, but sending
    // neither is fine (frontend gates the requirement based on whether
    // any destination line targets a tri-currency branch — the backend
    // just trusts what it receives).
    const VALID_CCY = new Set(['USD', 'FRA', 'K']);
    const ccy  = cost_currency ? String(cost_currency).toUpperCase() : null;
    const rate = fx_rate_used  ? parseFloat(fx_rate_used) : null;
    if (ccy && !VALID_CCY.has(ccy)) {
      return res.status(400).json({ error: `cost_currency must be one of USD, FRA, K` });
    }
    if (ccy && ccy !== 'USD' && !(rate > 0)) {
      return res.status(400).json({ error: `fx_rate_used > 0 is required when cost_currency is ${ccy}` });
    }
    // Convert helper: local cost → USD equivalent, using the PO rate.
    // USD stays 1:1. FRA/K divide by the rate. NULL rate on non-USD
    // shouldn't happen (we validated above) but we guard with 0 → NULL.
    const toUsd = (localCost) => {
      const c = parseFloat(localCost || 0) || 0;
      if (c <= 0) return 0;
      if (!ccy || ccy === 'USD') return c;
      return rate > 0 ? c / rate : null;
    };

    // Validate items + compute total. Every line must have qty>0 and a
    // registered destination_slug — HQ can't dispatch to a non-tenant.
    const clean = [];
    let totalAmount = 0;
    for (const it of items) {
      const dest = String(it.destination_slug || '').toLowerCase();
      const name = String(it.product_name || '').trim();
      const qty  = parseFloat(it.dispatched_qty);
      const cost = parseFloat(it.cost_price || 0) || 0;
      if (!name || !(qty > 0)) {
        return res.status(400).json({ error: `Invalid item: needs product_name and dispatched_qty > 0` });
      }
      if (!dest || !isRegistered(dest)) {
        return res.status(400).json({ error: `Destination "${dest}" is not a registered branch` });
      }
      clean.push({
        product_sync_id:  String(it.product_sync_id || '').trim() || randomUUID(),
        product_name:     name,
        unit:             it.unit || null,
        dispatched_qty:   qty,
        cost_price:       cost,
        cost_price_usd:   toUsd(cost),
        line_total:       qty * cost,
        destination_slug: dest,
        destination_name: destinationName(dest),
      });
      totalAmount += qty * cost;
    }

    const syncId = randomUUID();
    const purchaseNumber = nextPurchaseNumber();
    const createdBy     = req.user.id || null;
    const createdByName = req.user.firstName || req.user.email || 'HQ';

    masterDb.transaction(() => {
      const insHdr = masterDb.prepare(`
        INSERT INTO hq_purchases (purchase_number, sync_id, supplier_id, supplier_name, invoice_number,
                                  date, total_amount, notes, status,
                                  cost_currency, fx_rate_used,
                                  created_by, created_by_name)
        VALUES (?,?,?,?,?,?,?,?,'OPEN',?,?,?,?)
      `).run(
        purchaseNumber, syncId,
        supplier_id || null,
        supplier_name || null, invoice_number || null,
        date, totalAmount, notes || null,
        ccy, rate,
        createdBy, createdByName
      );
      const purchaseId = insHdr.lastInsertRowid;

      const insItem = masterDb.prepare(`
        INSERT INTO hq_purchase_items (purchase_id, purchase_sync_id, sync_id,
                                       product_sync_id, product_name, unit,
                                       dispatched_qty, cost_price, cost_price_usd, line_total,
                                       destination_slug, destination_name, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'AWAITING_GRN')
      `);
      for (const it of clean) {
        insItem.run(
          purchaseId, syncId, randomUUID(),
          it.product_sync_id, it.product_name, it.unit,
          it.dispatched_qty, it.cost_price, it.cost_price_usd, it.line_total,
          it.destination_slug, it.destination_name
        );
      }
    })();

    res.status(201).json(getOne(syncId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function getOne(syncIdOrId) {
  const row = typeof syncIdOrId === 'number'
    ? masterDb.prepare(`SELECT * FROM hq_purchases WHERE id = ?`).get(syncIdOrId)
    : masterDb.prepare(`SELECT * FROM hq_purchases WHERE sync_id = ?`).get(syncIdOrId);
  if (!row) return null;
  const items = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE purchase_id = ? ORDER BY id ASC`).all(row.id);
  return { ...row, items };
}

// GET /api/hq/purchases — list (HQ side, all branches).
router.get('/', hqAuth, (req, res) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    let sql = `SELECT * FROM hq_purchases`;
    const params = [];
    if (status) { sql += ' WHERE status = ?'; params.push(status); }
    sql += ' ORDER BY date DESC, id DESC LIMIT 500';
    const headers = masterDb.prepare(sql).all(...params);
    // Per-header counts across the new state machine. AWAITING_GRN +
    // GRN_SUBMITTED together = "still open" so the list can show
    // "3 of 5 confirmed" without 500 separate queries.
    const counts = masterDb.prepare(`
      SELECT purchase_id,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'CONFIRMED'     THEN 1 ELSE 0 END) AS confirmed,
             SUM(CASE WHEN status = 'GRN_SUBMITTED' THEN 1 ELSE 0 END) AS awaiting_confirm,
             SUM(CASE WHEN status = 'AWAITING_GRN'  THEN 1 ELSE 0 END) AS awaiting_grn,
             SUM(CASE WHEN status = 'CANCELLED'     THEN 1 ELSE 0 END) AS cancelled
        FROM hq_purchase_items
       GROUP BY purchase_id
    `).all().reduce((acc, r) => { acc[r.purchase_id] = r; return acc; }, {});
    const enriched = headers.map(h => ({
      ...h,
      items_total:            counts[h.id]?.total            || 0,
      items_confirmed:        counts[h.id]?.confirmed        || 0,
      items_awaiting_confirm: counts[h.id]?.awaiting_confirm || 0,
      items_awaiting_grn:     counts[h.id]?.awaiting_grn     || 0,
      items_cancelled:        counts[h.id]?.cancelled        || 0,
      // Legacy field kept so older clients don't break — same as awaiting_grn.
      items_pending:          counts[h.id]?.awaiting_grn     || 0,
      items_received:         counts[h.id]?.confirmed        || 0,
    }));
    res.json({ purchases: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/purchases/incoming?slug=
// Branch-facing — every line whose destination_slug matches AND is
// still in flight (AWAITING_GRN = branch must enter actual qty;
// GRN_SUBMITTED = waiting for HQ confirmation, branch can see it but
// can't re-submit). Sort by submitted/created time so the freshest
// arrivals float to the top.
router.get('/incoming', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    const rows = masterDb.prepare(`
      SELECT i.*,
             p.purchase_number, p.supplier_name, p.supplier_id, p.invoice_number,
             p.date AS purchase_date, p.notes AS purchase_notes,
             p.created_by_name AS hq_user
        FROM hq_purchase_items i
        JOIN hq_purchases p ON p.id = i.purchase_id
       WHERE i.destination_slug = ? AND i.status IN ('AWAITING_GRN', 'GRN_SUBMITTED')
       ORDER BY p.date DESC, i.id DESC
       LIMIT 500
    `).all(slug);
    res.json({ items: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/purchases/awaiting-confirmation
// HQ-facing — every line that branches have submitted GRNs for and
// HQ hasn't confirmed yet. Drives the "Confirm GRN" page + the HQ
// notification badge. Includes the destination slug so HQ knows
// which branch counted what.
router.get('/awaiting-confirmation', hqAuth, (req, res) => {
  try {
    const rows = masterDb.prepare(`
      SELECT i.*,
             p.purchase_number, p.supplier_name, p.invoice_number,
             p.date AS purchase_date, p.created_by_name AS hq_user
        FROM hq_purchase_items i
        JOIN hq_purchases p ON p.id = i.purchase_id
       WHERE i.status = 'GRN_SUBMITTED'
       ORDER BY COALESCE(i.received_at, p.date) DESC, i.id DESC
       LIMIT 500
    `).all();
    res.json({ items: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/purchases/:id — detail (HQ side, with items).
router.get('/:id', hqAuth, (req, res) => {
  try {
    const out = getOne(parseInt(req.params.id, 10));
    if (!out) return res.status(404).json({ error: 'Purchase not found' });
    res.json(out);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-promote a header to COMPLETED once every line is CONFIRMED,
// CANCELLED, or BRANCH_REJECTED (v1.9.7). Called from confirm + cancel
// + branch-reject endpoints. Stays OPEN while anything is still
// AWAITING_GRN or GRN_SUBMITTED.
function maybeCompleteHeader(purchaseId) {
  const cnt = masterDb.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('AWAITING_GRN','GRN_SUBMITTED') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'CONFIRMED'       THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status = 'CANCELLED'       THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'BRANCH_REJECTED' THEN 1 ELSE 0 END) AS branch_rejected
      FROM hq_purchase_items WHERE purchase_id = ?
  `).get(purchaseId);
  if ((cnt.open || 0) === 0) {
    // Header is COMPLETED if at least one line ended up CONFIRMED, else
    // CANCELLED (all lines were cancelled / branch-rejected).
    const next = (cnt.confirmed || 0) > 0 ? 'COMPLETED' : 'CANCELLED';
    masterDb.prepare(`UPDATE hq_purchases SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(next, purchaseId);
  }
}

// PUT /api/hq/purchases/items/:itemId/submit-grn
// Branch action. Records the actual qty that physically arrived; line
// moves AWAITING_GRN → GRN_SUBMITTED. **No stock change at the branch
// yet** — that happens when HQ confirms the GRN, because HQ is the only
// place authorised to lock in supplier AP. If branch needs to re-submit
// (HQ rejected), the same endpoint accepts it again from AWAITING_GRN.
router.put('/items/:itemId/submit-grn', hqAuth, (req, res) => {
  try {
    // v1.8.65 — reason field aligned with transfer_variances vocabulary.
    // Accepts 'OK' | 'Short' | 'Damaged' | 'Lost'. Defaults to derived
    // value based on received vs dispatched if absent (back-compat).
    const { received_qty, variance_notes, reason } = req.body || {};
    const receivedQty = parseFloat(received_qty);
    if (!(receivedQty >= 0)) return res.status(400).json({ error: 'received_qty must be >= 0' });

    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'AWAITING_GRN') return res.status(400).json({ error: `Line is ${item.status} — only AWAITING_GRN lines can submit a GRN` });
    if (!isRegistered(item.destination_slug)) return res.status(400).json({ error: `Destination "${item.destination_slug}" no longer registered` });

    const receivedBy = req.user.id || null;
    const receivedByName = req.user.firstName || req.user.email || 'Branch';
    const dispatched = parseFloat(item.dispatched_qty || 0);
    const allowed = new Set(['OK', 'Short', 'Damaged', 'Lost']);
    const resolvedReason = allowed.has(reason)
      ? reason
      : (Math.abs(receivedQty - dispatched) < 0.0001 ? 'OK' : (receivedQty < dispatched ? 'Short' : 'OK'));

    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'GRN_SUBMITTED',
             received_qty = ?,
             variance_notes = ?,
             reason = ?,
             received_by = ?,
             received_by_name = ?,
             received_at = datetime('now')
       WHERE id = ?
    `).run(receivedQty, variance_notes || null, resolvedReason, receivedBy, receivedByName, req.params.itemId);

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/confirm
// HQ action — accepts the branch's GRN. This is the ONLY place that
// touches branch stock: products.current_stock bumps + a stock_movement
// row gets minted (movement_type='hq_receipt'). After this point the
// supplier AP is committed and can be paid via /hq/suppliers/:id/payments.
// Body: { confirm_notes? }  (HQ doesn't override the qty — if HQ disagrees
// with the branch count it rejects instead.)
router.put('/items/:itemId/confirm', hqAuth, (req, res) => {
  try {
    const { confirm_notes } = req.body || {};
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'GRN_SUBMITTED') return res.status(400).json({ error: `Line is ${item.status} — only GRN_SUBMITTED lines can be confirmed` });

    const toSlug = item.destination_slug;
    if (!isRegistered(toSlug)) return res.status(400).json({ error: `Destination "${toSlug}" no longer registered` });
    const toDb = getTenantDb(toSlug);

    const confirmedBy     = req.user.id || null;
    const confirmedByName = req.user.firstName || req.user.email || 'HQ';
    // v1.8.99 — stock_movements.created_by FK references users(id) ON THE
    // BRANCH DB. HQ users don't exist there → FOREIGN KEY constraint failed.
    // Same fix as v1.8.96 Confirm Damages: pass NULL for the branch-side
    // movement's created_by. HQ user identity is preserved on the master
    // hq_purchase_items row (confirmed_by + confirmed_by_name snapshot).
    const branchSideCreatedBy = null;
    const qty = parseFloat(item.received_qty) || 0;

    toDb.transaction(() => {
      // Find product at branch by sync_id (preferred) then name; auto-
      // create from the line snapshot if neither matches. Same logic as
      // the deprecated /receive endpoint — moved here so it only fires
      // at confirm time (the whole point of the v1.3.0 state machine).
      let prod = toDb.prepare(`
        SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
          FROM products WHERE sync_id = ? AND deleted_at IS NULL
      `).get(item.product_sync_id);
      if (!prod) {
        prod = toDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL
            ORDER BY id ASC LIMIT 1
        `).get(item.product_name);
      }
      if (!prod) {
        const baseUnit = item.unit || 'pcs';
        const cost     = parseFloat(item.cost_price || 0) || 0;
        const info = toDb.prepare(`
          INSERT INTO products (name, unit, cost_price, selling_price,
                                current_stock, min_stock, status,
                                sync_id, tenant_id, branch_id, device_id, synced,
                                created_at, updated_at)
          VALUES (?,?,?,?,0,0,'Active',?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(item.product_name, baseUnit, cost, cost,
                item.product_sync_id, null, null, null);
        prod = toDb.prepare(
          'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?'
        ).get(info.lastInsertRowid);
      }

      const baseQty = qty * conversionToBase(prod, item.unit);
      toDb.prepare(`
        UPDATE products SET current_stock = current_stock + ?,
                            updated_at = datetime('now'),
                            synced = 0
         WHERE sync_id = ?
      `).run(baseQty, prod.sync_id);
      toDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id,
                                     notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(
        prod.id, prod.sync_id, 'sales', 'hq_receipt',
        baseQty, 'hq_purchase', item.sync_id,
        `HQ Purchase confirmed${confirm_notes ? ' — ' + confirm_notes : ''}`,
        branchSideCreatedBy,
        randomUUID(), null, null, null
      );
    })();

    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'CONFIRMED',
             confirmed_by = ?,
             confirmed_by_name = ?,
             confirmed_at = datetime('now'),
             confirm_notes = ?
       WHERE id = ?
    `).run(confirmedBy, confirmedByName, confirm_notes || null, req.params.itemId);

    maybeCompleteHeader(item.purchase_id);

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/reject
// HQ action — pushes a GRN_SUBMITTED line back to the branch for a recount.
// confirm_notes captures the reason ("recount needed", "supplier delivery
// note says 8 not 10", etc); branch sees it on their Pending GRN screen.
router.put('/items/:itemId/reject', hqAuth, (req, res) => {
  try {
    const { confirm_notes } = req.body || {};
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'GRN_SUBMITTED') return res.status(400).json({ error: `Line is ${item.status} — only GRN_SUBMITTED lines can be rejected` });

    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'AWAITING_GRN',
             received_qty = NULL,
             received_by = NULL,
             received_by_name = NULL,
             received_at = NULL,
             confirm_notes = ?
       WHERE id = ?
    `).run(confirm_notes || 'Rejected — recount requested', req.params.itemId);

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/branch-reject
// v1.9.7 — branch action. Branch can decline an incoming PO line (wrong
// branch, wrong supplier, item doesn't match what they were expecting,
// etc.) instead of being forced to generate a GRN for it. Status
// becomes BRANCH_REJECTED (terminal) and the rejection appears on the
// HQ Purchases list with the reason so HQ can re-issue the line to a
// different branch or cancel it outright.
//
// Body: { reason }  — required, surfaced on HQ's incoming view.
router.put('/items/:itemId/branch-reject', hqAuth, (req, res) => {
  try {
    const reason = ((req.body && req.body.reason) || '').toString().trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    // Only AWAITING_GRN lines can be branch-rejected. Once a GRN exists
    // (GRN_SUBMITTED / CONFIRMED) the rejection has to come from HQ
    // via the GRN-level reject path.
    if (item.status !== 'AWAITING_GRN') {
      return res.status(400).json({ error: `Line is ${item.status} — branch can only reject AWAITING_GRN lines.` });
    }

    masterDb.transaction(() => {
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status                  = 'BRANCH_REJECTED',
               branch_rejected_by      = ?,
               branch_rejected_by_name = ?,
               branch_rejected_at      = datetime('now'),
               branch_reject_reason    = ?
         WHERE id = ?
      `).run(req.user.id || null, req.user.firstName || req.user.email || 'branch', reason, req.params.itemId);

      // Rejected lines don't count toward supplier AP — drop their value
      // from the header total so HQ AP stays accurate.
      masterDb.prepare(`
        UPDATE hq_purchases
           SET total_amount = MAX(0, total_amount - ?),
               updated_at   = datetime('now')
         WHERE id = ?
      `).run(item.line_total || 0, item.purchase_id);
    })();

    maybeCompleteHeader(item.purchase_id);

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/cancel — drop a single line that
// hasn't been CONFIRMED yet (AWAITING_GRN or GRN_SUBMITTED — both safe,
// no branch stock has moved). Confirmed lines can't be cancelled here
// because they already changed branch stock; you'd need a damages /
// adjustment flow for that.
router.put('/items/:itemId/cancel', hqAuth, (req, res) => {
  try {
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (!['AWAITING_GRN', 'GRN_SUBMITTED'].includes(item.status)) {
      return res.status(400).json({ error: `Line is ${item.status} — only un-confirmed lines can be cancelled` });
    }

    masterDb.transaction(() => {
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status = 'CANCELLED',
               variance_notes = COALESCE(NULLIF(variance_notes,''), 'Cancelled at HQ')
         WHERE id = ?
      `).run(req.params.itemId);

      // Header total drops by this line's value so AP stays accurate.
      masterDb.prepare(`
        UPDATE hq_purchases
           SET total_amount = MAX(0, total_amount - ?),
               updated_at   = datetime('now')
         WHERE id = ?
      `).run(item.line_total || 0, item.purchase_id);

      maybeCompleteHeader(item.purchase_id);
    })();

    res.json({
      item:            masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/:id/cancel — cancel an entire purchase. Rejected
// if any line has already been CONFIRMED (those lines moved real stock at
// a branch; cancellation would need a counter-movement which v1.3 doesn't
// support — use the damages workflow for that). AWAITING_GRN +
// GRN_SUBMITTED lines flip to CANCELLED in one go.
router.put('/:id/cancel', hqAuth, (req, res) => {
  try {
    const p = masterDb.prepare(`SELECT * FROM hq_purchases WHERE id = ?`).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Purchase not found' });
    if (p.status === 'CANCELLED' || p.status === 'COMPLETED') {
      return res.status(400).json({ error: `Purchase is already ${p.status}` });
    }
    const confirmed = masterDb.prepare(`
      SELECT COUNT(*) AS n FROM hq_purchase_items WHERE purchase_id = ? AND status = 'CONFIRMED'
    `).get(req.params.id).n;
    if (confirmed > 0) {
      return res.status(400).json({ error: `Cannot cancel — ${confirmed} line(s) already confirmed (stock at branch). Cancel them individually first if you need to.` });
    }
    masterDb.transaction(() => {
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status = 'CANCELLED',
               variance_notes = COALESCE(NULLIF(variance_notes,''), 'Cancelled at HQ')
         WHERE purchase_id = ? AND status IN ('AWAITING_GRN', 'GRN_SUBMITTED')
      `).run(req.params.id);
      masterDb.prepare(`
        UPDATE hq_purchases
           SET status = 'CANCELLED', total_amount = 0, updated_at = datetime('now')
         WHERE id = ?
      `).run(req.params.id);
    })();
    res.json(getOne(parseInt(req.params.id, 10)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
