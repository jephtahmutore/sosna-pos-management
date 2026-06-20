/**
 * transfers.js — cross-branch stock transfers.
 *
 * Universal — works whether the caller is on a per-branch subdomain
 * (kassumbalesa1.sosnazm.com) or the HQ host (sosnazm.com). The transfer
 * rows live in master.db so source AND destination read the same record
 * without cross-DB joins. Per-branch stock is updated by opening each
 * branch's tenant DB on demand via getTenantDb(slug).
 *
 * State machine on stock_transfers.status:
 *   PENDING   — source created + decremented its stock; in transit
 *   RECEIVED  — destination confirmed + incremented its stock
 *   CANCELLED — source aborted before destination received
 *
 * Auth: hqAuth (JWT only) — every Sosna admin can move stock between
 * branches they're an admin on. Per-role gates can be added later.
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

function branchName(slug) {
  try {
    const t = listTenants().find(t => t.slug === slug);
    if (!t) return slug;
    // Also try the branch's own business_settings.business_name for a
    // friendlier display label — falls back to the master tenant name.
    try {
      const db = getTenantDb(slug);
      const row = db.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
      if (row?.business_name) return row.business_name;
    } catch (_) { /* fall through */ }
    return t.business_name || slug;
  } catch (_) { return slug; }
}

function nextTransferNumber() {
  const seq = (masterDb.prepare(`SELECT COUNT(*) AS n FROM stock_transfers`).get()?.n || 0) + 1;
  const yr  = new Date().getFullYear();
  return `TRF-${yr}-${String(seq).padStart(5, '0')}`;
}

// GET /api/transfers/source-products?slug=
// Products at a given branch that have positive sales-floor stock — what
// the operator can pick from when creating a new transfer.
router.get('/source-products', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();
    if (!slug || !isRegistered(slug)) return res.status(400).json({ error: 'Unknown source branch' });
    const db = getTenantDb(slug);
    const products = db.prepare(`
      SELECT id, sync_id, name, unit, cost_price, selling_price,
             current_stock, min_stock
        FROM products
       WHERE deleted_at IS NULL AND status != 'Inactive'
       ORDER BY name COLLATE NOCASE ASC
    `).all();
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transfers/outgoing?slug=&status=
// Transfers SENT from the named branch. Both PENDING and RECEIVED so the
// operator can see their full send history; status filter narrows it.
router.get('/outgoing', hqAuth, (req, res) => {
  try {
    const slug   = String(req.query.slug || '').toLowerCase();
    const status = String(req.query.status || '').toUpperCase();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    let sql = `SELECT * FROM stock_transfers WHERE from_slug = ?`;
    const params = [slug];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = masterDb.prepare(sql).all(...params).map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transfers/incoming?slug=&status=
// Transfers headed TO the named branch. Default filter status=PENDING so
// the operator sees only what needs receiving; pass status= '' for all.
router.get('/incoming', hqAuth, (req, res) => {
  try {
    const slug   = String(req.query.slug || '').toLowerCase();
    const status = req.query.status === undefined ? 'PENDING' : String(req.query.status).toUpperCase();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    let sql = `SELECT * FROM stock_transfers WHERE to_slug = ?`;
    const params = [slug];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = masterDb.prepare(sql).all(...params).map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parseItems(row) {
  try { row.items = JSON.parse(row.items_json || '[]'); }
  catch { row.items = []; }
  delete row.items_json;
  return row;
}

// POST /api/transfers
// Body: { from_slug, to_slug, items: [{product_sync_id, product_name,
//         unit, quantity, cost_price?}], notes? }
// Source stock is decremented IMMEDIATELY — the transfer represents stock
// already on the truck. If receive never happens the source can cancel
// and we'll restore the stock (see /cancel below).
router.post('/', hqAuth, (req, res) => {
  try {
    const { from_slug, to_slug, items, notes } = req.body || {};
    const fromSlug = String(from_slug || '').toLowerCase();
    const toSlug   = String(to_slug   || '').toLowerCase();
    if (!fromSlug || !toSlug) return res.status(400).json({ error: 'from_slug and to_slug are required' });
    if (fromSlug === toSlug)  return res.status(400).json({ error: 'Source and destination must differ' });
    if (!isRegistered(fromSlug)) return res.status(400).json({ error: `Source branch "${fromSlug}" not registered` });
    if (!isRegistered(toSlug))   return res.status(400).json({ error: `Destination branch "${toSlug}" not registered` });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });

    // Validate + normalise items.
    const cleanItems = [];
    let totalValue = 0;
    for (const it of items) {
      const psid = String(it.product_sync_id || '').trim();
      const name = String(it.product_name    || '').trim();
      const qty  = parseFloat(it.quantity);
      if (!psid || !name || !(qty > 0)) {
        return res.status(400).json({ error: `Invalid item: needs product_sync_id, product_name, and quantity > 0` });
      }
      const cost = parseFloat(it.cost_price || 0) || 0;
      cleanItems.push({
        product_sync_id: psid,
        product_name:    name,
        unit:            it.unit || null,
        quantity:        qty,
        cost_price:      cost,
      });
      totalValue += qty * cost;
    }

    const fromDb = getTenantDb(fromSlug);
    const transferSyncId = randomUUID();
    const transferNumber = nextTransferNumber();
    const createdBy      = req.user.id || null;
    const createdByName  = req.user.firstName || req.user.email || 'HQ';

    // 1) Decrement source stock + log stock_movements in source DB.
    //    Same shape as the dispatch stock_movements in orders.js.
    fromDb.transaction(() => {
      const movStmt = fromDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id,
                                     notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `);
      const updStockStmt = fromDb.prepare(`
        UPDATE products SET current_stock = current_stock - ?,
                            updated_at = datetime('now'),
                            synced = 0
         WHERE sync_id = ?
      `);
      for (const it of cleanItems) {
        const prod = fromDb.prepare(
          'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json, current_stock FROM products WHERE sync_id = ?'
        ).get(it.product_sync_id);
        if (!prod) {
          throw Object.assign(new Error(`Product not found at source: ${it.product_name}`), { status: 400 });
        }
        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, it.unit);
        if (parseFloat(prod.current_stock || 0) < baseQty - 0.0001) {
          throw Object.assign(new Error(`Insufficient stock for ${it.product_name} (have ${prod.current_stock}, need ${baseQty})`), { status: 400 });
        }
        movStmt.run(
          prod.id, prod.sync_id, 'sales', 'transfer_out',
          -baseQty, 'transfer', transferSyncId,
          `Transfer ${transferNumber} → ${branchName(toSlug)}`,
          createdBy,
          randomUUID(), prod.tenant_id || null, prod.branch_id || null, prod.device_id || null
        );
        updStockStmt.run(baseQty, prod.sync_id);
      }
    })();

    // 2) Insert the master row last so a stock-decrement failure leaves
    //    no orphan transfer record.
    masterDb.prepare(`
      INSERT INTO stock_transfers (transfer_number, sync_id, from_slug, from_name, to_slug, to_name,
                                   items_json, total_items, total_value, notes,
                                   status, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)
    `).run(
      transferNumber, transferSyncId,
      fromSlug, branchName(fromSlug),
      toSlug,   branchName(toSlug),
      JSON.stringify(cleanItems),
      cleanItems.length,
      totalValue,
      notes || null,
      createdBy, createdByName
    );

    const row = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE sync_id = ?').get(transferSyncId));
    res.status(201).json(row);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// PUT /api/transfers/:id/receive
// Destination confirms arrival. For each item, find the product at the
// destination by sync_id (or auto-create using the snapshot from the
// transfer), increment current_stock, and log a transfer_in movement.
// Master row flips to RECEIVED + stamps received_by / received_at.
router.put('/:id/receive', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Transfer is ${row.status}, not PENDING` });

    const toSlug = row.to_slug;
    const fromSlug = row.from_slug;
    if (!isRegistered(toSlug)) return res.status(400).json({ error: 'Destination branch no longer registered' });

    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch { /* empty */ }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Transfer has no items' });
    }

    const toDb = getTenantDb(toSlug);
    const receivedBy = req.user.id || null;
    const receivedByName = req.user.firstName || req.user.email || 'Branch';

    toDb.transaction(() => {
      const movStmt = toDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id,
                                     notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `);
      const upd = toDb.prepare(`
        UPDATE products SET current_stock = current_stock + ?,
                            updated_at = datetime('now'),
                            synced = 0
         WHERE sync_id = ?
      `);

      for (const it of items) {
        let prod = toDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products
           WHERE sync_id = ? AND deleted_at IS NULL
        `).get(it.product_sync_id);

        // Auto-create the product at the destination if it doesn't exist
        // yet. Carries the source's sync_id so future transfers match.
        if (!prod) {
          const baseUnit = it.unit || 'pcs';
          const cost     = parseFloat(it.cost_price || 0) || 0;
          const info = toDb.prepare(`
            INSERT INTO products (name, unit, cost_price, selling_price,
                                  current_stock, min_stock, status,
                                  sync_id, tenant_id, branch_id, device_id, synced,
                                  created_at, updated_at)
            VALUES (?,?,?,?,0,0,'Active',?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(
            it.product_name, baseUnit, cost, cost,
            it.product_sync_id, null, null, null
          );
          prod = toDb.prepare(
            'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?'
          ).get(info.lastInsertRowid);
        }

        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, it.unit);
        movStmt.run(
          prod.id, prod.sync_id, 'sales', 'transfer_in',
          baseQty, 'transfer', row.sync_id,
          `Transfer ${row.transfer_number} ← ${row.from_name || fromSlug}`,
          receivedBy,
          randomUUID(), null, null, null
        );
        upd.run(baseQty, prod.sync_id);
      }
    })();

    masterDb.prepare(`
      UPDATE stock_transfers
         SET status = 'RECEIVED',
             received_by = ?,
             received_by_name = ?,
             received_at = datetime('now')
       WHERE id = ?
    `).run(receivedBy, receivedByName, req.params.id);

    const out = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id));
    res.json(out);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// PUT /api/transfers/:id/cancel — source aborts a PENDING transfer.
// Reverses the source-side decrement (positive transfer_cancel movement)
// and flips status to CANCELLED. Destination never received anything so
// no destination-side cleanup is needed.
router.put('/:id/cancel', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Transfer is ${row.status}, not PENDING` });

    const fromSlug = row.from_slug;
    if (!isRegistered(fromSlug)) return res.status(400).json({ error: 'Source branch no longer registered' });

    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch { /* empty */ }

    const fromDb = getTenantDb(fromSlug);
    fromDb.transaction(() => {
      const movStmt = fromDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id,
                                     notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `);
      const upd = fromDb.prepare(`
        UPDATE products SET current_stock = current_stock + ?,
                            updated_at = datetime('now'),
                            synced = 0
         WHERE sync_id = ?
      `);
      for (const it of items) {
        const prod = fromDb.prepare(
          'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
        ).get(it.product_sync_id);
        if (!prod) continue;
        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, it.unit);
        movStmt.run(
          prod.id, prod.sync_id, 'sales', 'transfer_cancel',
          baseQty, 'transfer', row.sync_id,
          `Cancelled ${row.transfer_number}`,
          req.user.id || null,
          randomUUID(), null, null, null
        );
        upd.run(baseQty, prod.sync_id);
      }
    })();

    masterDb.prepare(`UPDATE stock_transfers SET status='CANCELLED' WHERE id=?`).run(req.params.id);

    const out = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id));
    res.json(out);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
