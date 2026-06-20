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
    const { supplier_id, supplier_name, invoice_number, date, notes, items } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item required' });
    }

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
                                  date, total_amount, notes, status, created_by, created_by_name)
        VALUES (?,?,?,?,?,?,?,?,'OPEN',?,?)
      `).run(
        purchaseNumber, syncId,
        supplier_id || null,
        supplier_name || null, invoice_number || null,
        date, totalAmount, notes || null,
        createdBy, createdByName
      );
      const purchaseId = insHdr.lastInsertRowid;

      const insItem = masterDb.prepare(`
        INSERT INTO hq_purchase_items (purchase_id, purchase_sync_id, sync_id,
                                       product_sync_id, product_name, unit,
                                       dispatched_qty, cost_price, line_total,
                                       destination_slug, destination_name, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING')
      `);
      for (const it of clean) {
        insItem.run(
          purchaseId, syncId, randomUUID(),
          it.product_sync_id, it.product_name, it.unit,
          it.dispatched_qty, it.cost_price, it.line_total,
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
    // Pull per-header reception counts in one round-trip so the list can
    // show "3 of 5 received" without 500 separate queries.
    const counts = masterDb.prepare(`
      SELECT purchase_id,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'RECEIVED'  THEN 1 ELSE 0 END) AS received,
             SUM(CASE WHEN status = 'PENDING'   THEN 1 ELSE 0 END) AS pending
        FROM hq_purchase_items
       GROUP BY purchase_id
    `).all().reduce((acc, r) => { acc[r.purchase_id] = r; return acc; }, {});
    const enriched = headers.map(h => ({
      ...h,
      items_total:    counts[h.id]?.total    || 0,
      items_received: counts[h.id]?.received || 0,
      items_pending:  counts[h.id]?.pending  || 0,
    }));
    res.json({ purchases: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/purchases/incoming?slug=
// Branch-facing — every PENDING line whose destination_slug matches.
router.get('/incoming', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    const rows = masterDb.prepare(`
      SELECT i.*,
             p.purchase_number, p.supplier_name, p.invoice_number,
             p.date AS purchase_date, p.notes AS purchase_notes,
             p.created_by_name AS hq_user
        FROM hq_purchase_items i
        JOIN hq_purchases p ON p.id = i.purchase_id
       WHERE i.destination_slug = ? AND i.status = 'PENDING'
       ORDER BY p.date DESC, i.id DESC
       LIMIT 500
    `).all(slug);
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

// PUT /api/hq/purchases/items/:itemId/receive
// Body: { received_qty, variance_notes? }
// Branch confirms the actual quantity that arrived. We auto-create the
// product at the destination if needed (matched by sync_id, fallback to
// name to absorb older catalogs), then increment stock + log movement.
router.put('/items/:itemId/receive', hqAuth, (req, res) => {
  try {
    const { received_qty, variance_notes } = req.body || {};
    const receivedQty = parseFloat(received_qty);
    if (!(receivedQty >= 0)) return res.status(400).json({ error: 'received_qty must be >= 0' });

    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'PENDING') return res.status(400).json({ error: `Line is already ${item.status}` });

    const toSlug = item.destination_slug;
    if (!isRegistered(toSlug)) return res.status(400).json({ error: `Destination "${toSlug}" no longer registered` });

    const toDb = getTenantDb(toSlug);
    const receivedBy = req.user.id || null;
    const receivedByName = req.user.firstName || req.user.email || 'Branch';

    toDb.transaction(() => {
      // Find product by sync_id first (preferred — survives renames),
      // then by name as a fallback. Auto-create with the snapshot if neither.
      let prod = toDb.prepare(`
        SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
          FROM products
         WHERE sync_id = ? AND deleted_at IS NULL
      `).get(item.product_sync_id);
      if (!prod) {
        prod = toDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products
           WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL
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

      // Increment stock (base units) + log movement. movement_type=
      // 'hq_receipt' makes it easy to filter on Bin Card / reports.
      const baseQty = receivedQty * conversionToBase(prod, item.unit);
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
        `HQ Purchase ${item.purchase_sync_id ? '' : ''}${variance_notes ? ' — ' + variance_notes : ''}`.trim() || null,
        receivedBy,
        randomUUID(), null, null, null
      );
    })();

    // Update the master line + auto-complete the header if no PENDING left.
    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'RECEIVED',
             received_qty = ?,
             variance_notes = ?,
             received_by = ?,
             received_by_name = ?,
             received_at = datetime('now')
       WHERE id = ?
    `).run(receivedQty, variance_notes || null, receivedBy, receivedByName, req.params.itemId);

    const remaining = masterDb.prepare(`
      SELECT COUNT(*) AS n FROM hq_purchase_items
       WHERE purchase_id = ? AND status = 'PENDING'
    `).get(item.purchase_id).n;
    if (remaining === 0) {
      masterDb.prepare(`UPDATE hq_purchases SET status='COMPLETED', updated_at=datetime('now') WHERE id=?`).run(item.purchase_id);
    }

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/cancel — drop a single PENDING line
// (operator entered the wrong item, supplier won't deliver this one, etc).
// Subtracts the line value from the parent's total_amount + auto-promotes
// the header:
//   0 PENDING + at least 1 RECEIVED → COMPLETED (everything that was
//                                                going to land has landed)
//   0 PENDING + 0 RECEIVED          → CANCELLED (whole thing is dead)
router.put('/items/:itemId/cancel', hqAuth, (req, res) => {
  try {
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'PENDING') return res.status(400).json({ error: `Line is already ${item.status}` });

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

      const cnt = masterDb.prepare(`
        SELECT
          SUM(CASE WHEN status = 'PENDING'   THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'RECEIVED'  THEN 1 ELSE 0 END) AS received,
          SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
          FROM hq_purchase_items WHERE purchase_id = ?
      `).get(item.purchase_id);
      if ((cnt.pending || 0) === 0) {
        const next = (cnt.received || 0) > 0 ? 'COMPLETED' : 'CANCELLED';
        masterDb.prepare(`UPDATE hq_purchases SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(next, item.purchase_id);
      }
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
// if any line has already been received (those lines moved real stock at
// a branch; the cancellation would need a counter-movement which v1
// doesn't support). Use the per-line cancel for partial scenarios.
router.put('/:id/cancel', hqAuth, (req, res) => {
  try {
    const p = masterDb.prepare(`SELECT * FROM hq_purchases WHERE id = ?`).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Purchase not found' });
    if (p.status === 'CANCELLED' || p.status === 'COMPLETED') {
      return res.status(400).json({ error: `Purchase is already ${p.status}` });
    }
    const received = masterDb.prepare(`
      SELECT COUNT(*) AS n FROM hq_purchase_items WHERE purchase_id = ? AND status = 'RECEIVED'
    `).get(req.params.id).n;
    if (received > 0) {
      return res.status(400).json({ error: `Cannot cancel — ${received} line(s) already received. Cancel them individually first if you need to.` });
    }
    masterDb.transaction(() => {
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status = 'CANCELLED',
               variance_notes = COALESCE(NULLIF(variance_notes,''), 'Cancelled at HQ')
         WHERE purchase_id = ? AND status = 'PENDING'
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
