const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { conversionToBase, baseQtyExpr } = require('../config/unitsHelper');

// GET /api/sales-returns
// v1.8.35 — value now computed in JS so the unit-conversion logic (a
// declared qty of "1 Box" must read cost_price × conv, not cost_price
// directly) and the PENDING-vs-CONFIRMED distinction are explicit.
//
// Returned per row:
//   total_value           — actual moved value if CONFIRMED (from
//                           stock_movements), else estimated from items.
//   estimated_total_value — always the items-based estimate, so the
//                           UI can show "claimed worth" even pre-confirm.
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sr.*,
        (SELECT COUNT(*) FROM sales_return_items WHERE return_sync_id = sr.sync_id AND deleted_at IS NULL) AS item_count
      FROM sales_returns sr
      WHERE sr.deleted_at IS NULL AND sr.tenant_id = ?
      ORDER BY sr.date DESC, sr.id DESC
    `).all(req.user.tenantId);

    // Pre-fetch all items for these returns in one query.
    const ids = rows.map(r => r.sync_id);
    let itemsBySync = new Map();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const itemRows = db.prepare(`
        SELECT sri.return_sync_id, sri.quantity, sri.unit,
               p.cost_price, p.unit AS product_unit, p.alt_unit,
               p.conversion_factor, p.units_json
        FROM sales_return_items sri
        LEFT JOIN products p ON p.sync_id = sri.product_sync_id
        WHERE sri.deleted_at IS NULL AND sri.return_sync_id IN (${placeholders})
      `).all(...ids);
      for (const it of itemRows) {
        if (!itemsBySync.has(it.return_sync_id)) itemsBySync.set(it.return_sync_id, []);
        itemsBySync.get(it.return_sync_id).push(it);
      }
    }

    const enriched = rows.map(r => {
      const items = itemsBySync.get(r.sync_id) || [];
      const estimated = items.reduce((sum, it) => {
        const prod = { unit: it.product_unit, alt_unit: it.alt_unit, conversion_factor: it.conversion_factor, units_json: it.units_json };
        const convToBase = conversionToBase(prod, it.unit);
        const lineCost = (parseFloat(it.cost_price) || 0) * convToBase;
        return sum + (parseFloat(it.quantity) || 0) * lineCost;
      }, 0);
      return { ...r, total_value: estimated, estimated_total_value: estimated };
    });
    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sales-returns/notes — distinct notes history for autocomplete
router.get('/notes', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT notes FROM sales_returns
      WHERE deleted_at IS NULL AND tenant_id = ? AND notes IS NOT NULL AND notes != ''
      ORDER BY id DESC LIMIT 50
    `).all(req.user.tenantId);
    res.json(rows.map(r => r.notes));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sales-returns/stats
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM sales_returns WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const thisMonth = db.prepare("SELECT COUNT(*) AS cnt FROM sales_returns WHERE deleted_at IS NULL AND tenant_id = ? AND date >= date('now', 'start of month')").get(tenantId);
    res.json({ total: total.cnt, thisMonth: thisMonth.cnt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sales-returns
// v1.3.1: branch DECLARES the damage. No stock decrement yet — HQ must
// confirm via /api/hq/damages/:slug/:id/confirm before stock_movements
// + profit recalc happen. Until then status='PENDING' and the row sits
// in the HQ Confirm Damages queue. Items are still recorded so HQ can
// see exactly what's being claimed.
router.post('/', auth, (req, res) => {
  try {
    const { date, notes, items } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'At least one item is required.' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const returnDate = date || new Date().toISOString().split('T')[0];

    const result = db.transaction(() => {
      const returnNum = syncConfig.generateNumber('SRT', 'sales_returns');
      const returnSyncId = randomUUID();
      const info = db.prepare(`
        INSERT INTO sales_returns (return_number, date, notes, total_items, status,
                                   created_by, sync_id, tenant_id, branch_id, device_id, synced,
                                   created_at, updated_at)
        VALUES (?,?,?,?, 'PENDING', ?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(returnNum, returnDate, notes || null, items.length, req.user.id,
             returnSyncId, tenantId, branchId, deviceId);
      const returnId = info.lastInsertRowid;

      for (const item of items) {
        const qty = parseFloat(item.quantity);
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(item.product_id);
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        db.prepare(`
          INSERT INTO sales_return_items (return_id, return_sync_id, product_id, product_sync_id, quantity, unit, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(returnId, returnSyncId, item.product_id, productSyncId, qty, lineUnit, randomUUID(), tenantId, branchId, deviceId);
        // Note: no stock_movements row here — that's created at HQ confirm time.
      }

      return db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(returnId);
    })();

    // No profit recalc — damages don't hit the books until HQ confirms.
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/sales-returns/:id/confirm
// HQ-only — proxied through here for symmetry but the routes/hqDamages.js
// HQ-facing list endpoint is what HQ operators hit. Either path moves the
// damage from PENDING → CONFIRMED, creates the stock_movement rows, and
// triggers recalculateDailyProfit so the damages cost lands on the day's
// Profit Report. Reject path clears the row to REJECTED (kept for audit).
function confirmDamage(db, params, req, res, body) {
  try {
    const ret = db.prepare('SELECT * FROM sales_returns WHERE id = ? AND deleted_at IS NULL').get(params.id);
    if (!ret) return res.status(404).json({ error: 'Damage not found' });
    if (ret.status !== 'PENDING') return res.status(400).json({ error: `Damage is ${ret.status}, not PENDING` });

    const items = db.prepare(
      `SELECT sri.*, p.unit AS product_base_unit, p.alt_unit, p.conversion_factor, p.units_json
         FROM sales_return_items sri
         LEFT JOIN products p ON p.sync_id = sri.product_sync_id
         WHERE sri.return_sync_id = ? AND sri.deleted_at IS NULL`
    ).all(ret.sync_id);

    const tenantId = ret.tenant_id;
    const branchId = ret.branch_id;
    const deviceId = ret.device_id;
    const confirmedBy = req.user.id || null;
    const confirmedByName = req.user.firstName || req.user.email || 'HQ';

    db.transaction(() => {
      for (const it of items) {
        const prod = { unit: it.product_base_unit, alt_unit: it.alt_unit, conversion_factor: it.conversion_factor, units_json: it.units_json };
        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, it.unit);
        db.prepare(`
          INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                       quantity, reference_id, reference_type, notes,
                                       created_by, sync_id, tenant_id, branch_id, device_id, synced,
                                       created_at, updated_at, reference_sync_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
        `).run(
          it.product_id, it.product_sync_id, 'sales', 'sales_return', -baseQty,
          ret.id, 'sales_return', ret.notes || null,
          confirmedBy, randomUUID(), tenantId, branchId, deviceId,
          ret.date, ret.sync_id
        );
      }
      db.prepare(`
        UPDATE sales_returns
           SET status = 'CONFIRMED',
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now'),
               confirm_notes = ?, synced = 0
         WHERE id = ?
      `).run(confirmedBy, confirmedByName, body?.confirm_notes || null, params.id);
    })();

    recalculateDailyProfit(db, ret.date, tenantId);
    res.json(db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

router.put('/:id/confirm', auth, (req, res) => confirmDamage(db, req.params, req, res, req.body));

router.put('/:id/reject', auth, (req, res) => {
  try {
    const ret = db.prepare('SELECT * FROM sales_returns WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!ret) return res.status(404).json({ error: 'Damage not found' });
    if (ret.status !== 'PENDING') return res.status(400).json({ error: `Damage is ${ret.status}, not PENDING` });
    const confirmedBy = req.user.id || null;
    const confirmedByName = req.user.firstName || req.user.email || 'HQ';
    db.prepare(`
      UPDATE sales_returns
         SET status = 'REJECTED',
             confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now'),
             confirm_notes = ?, synced = 0
       WHERE id = ?
    `).run(confirmedBy, confirmedByName, req.body?.confirm_notes || 'Rejected at HQ', req.params.id);
    res.json(db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Expose for the HQ-side cross-branch router.
module.exports.confirmDamage = confirmDamage;

// GET /api/sales-returns/:id
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const entry = db.prepare('SELECT * FROM sales_returns WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(req.params.id, req.user.tenantId);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    // Alias p.unit → product_unit so it doesn't collide with sri.unit (the unit the
    // return line was recorded in). Without the alias, the product's base unit
    // overwrites the line unit in the JS object — same bug class as siv.js:171.
    const items = db.prepare(`
      SELECT sri.*, p.name AS product_name, p.unit AS product_unit
      FROM sales_return_items sri
      LEFT JOIN products p ON p.sync_id = sri.product_sync_id
      WHERE sri.return_sync_id = (SELECT sync_id FROM sales_returns WHERE id = ?)
        AND sri.deleted_at IS NULL
    `).all(req.params.id);
    res.json({ ...entry, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/sales-returns/:id
router.put('/:id', auth, (req, res) => {
  try {
    const { date, notes, items } = req.body;
    const id = parseInt(req.params.id);
    if (!items?.length) return res.status(400).json({ error: 'At least one item is required.' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const returnDate = date || new Date().toISOString().split('T')[0];
    const movementCreatedAt = returnDate + ' ' + new Date().toTimeString().slice(0, 8);

    db.transaction(() => {
      const ret = db.prepare('SELECT * FROM sales_returns WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!ret) throw Object.assign(new Error('Not found'), { status: 404 });

      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='sales_return' AND deleted_at IS NULL").run(ret.sync_id);
      db.prepare("UPDATE sales_return_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE return_sync_id=? AND deleted_at IS NULL").run(ret.sync_id);

      db.prepare("UPDATE sales_returns SET date=?, notes=?, total_items=?, updated_at=datetime('now'), synced=0 WHERE id=?")
        .run(returnDate, notes || null, items.length, id);

      for (const item of items) {
        const qty = parseFloat(item.quantity);
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(item.product_id);
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = qty * conversionToBase(prod, lineUnit);
        db.prepare(`INSERT INTO sales_return_items (return_id, return_sync_id, product_id, product_sync_id, quantity, unit, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`)
          .run(id, ret.sync_id, item.product_id, productSyncId, qty, lineUnit, randomUUID(), tenantId, branchId, deviceId);
        // Sales Damages — sales counter only, no +store add-back (items are gone).
        db.prepare(`INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)`)
          .run(item.product_id, productSyncId, 'sales', 'sales_return', -baseQty, id, 'sales_return', notes || null, req.user.id, randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, ret.sync_id);
      }
    })();

    recalculateDailyProfit(db, returnDate, req.user.tenantId);
    res.json(db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(id));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// DELETE /api/sales-returns/:id
router.delete('/:id', auth, (req, res) => {
  try {
    const ret = db.prepare('SELECT sync_id, date FROM sales_returns WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!ret) return res.status(404).json({ error: 'Sales return not found' });
    db.transaction(() => {
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='sales_return' AND deleted_at IS NULL").run(ret.sync_id);
      db.prepare("UPDATE sales_returns SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    })();
    recalculateDailyProfit(db, ret.date, req.user.tenantId);
    res.json({ message: 'Sales return deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
