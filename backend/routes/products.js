const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { baseQtyExpr } = require('../config/unitsHelper');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/products');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `product_${req.params.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Get all products
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { category, search } = req.query;
    let query = `SELECT p.*, c.name as category_name, c.color as category_color, c.main_category_id,
                   COALESCE(store_agg.store_balance, 0) as store_balance,
                   CASE
                     WHEN actual_agg.actual_balance IS NOT NULL THEN
                       actual_agg.actual_balance + COALESCE((
                         SELECT SUM(sm2.quantity) FROM stock_movements sm2
                         WHERE sm2.product_sync_id = p.sync_id AND sm2.location = 'sales'
                           AND sm2.movement_type != 'reconciliation'
                           AND sm2.deleted_at IS NULL
                           AND sm2.created_at > actual_agg.date || ' 23:59:59'
                       ), 0)
                     ELSE COALESCE(sales_agg.sales_balance, 0)
                   END as sales_balance,
                   CASE WHEN COALESCE(grn_qty.total_qty, 0) > 0
                     THEN ROUND(COALESCE(grn_qty.total_cost, 0) / grn_qty.total_qty, 2)
                     ELSE p.cost_price
                   END as avg_cost_price
                 FROM products p
                 LEFT JOIN categories c ON p.category_sync_id = c.sync_id
                 LEFT JOIN (
                   SELECT product_sync_id, SUM(quantity) as store_balance
                   FROM stock_movements WHERE location = 'store' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
                 ) store_agg ON store_agg.product_sync_id = p.sync_id
                 LEFT JOIN (
                   SELECT product_sync_id, SUM(quantity) as sales_balance
                   FROM stock_movements WHERE location = 'sales' AND movement_type != 'reconciliation' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
                 ) sales_agg ON sales_agg.product_sync_id = p.sync_id
                 LEFT JOIN (
                   SELECT dab.product_sync_id, dab.actual_balance, dab.date
                   FROM daily_actual_balance dab
                   INNER JOIN (
                     SELECT product_sync_id, MAX(date) as max_date
                     FROM daily_actual_balance WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
                   ) latest ON latest.product_sync_id = dab.product_sync_id AND latest.max_date = dab.date
                   WHERE dab.deleted_at IS NULL
                 ) actual_agg ON actual_agg.product_sync_id = p.sync_id
                 LEFT JOIN (
                   -- Convert each GRN line's quantity to BASE units before summing so avg_cost
                   -- is always per base unit (regardless of whether the GRN was entered in pcs or box).
                   -- Uses baseQtyExpr → looks up conversion in units_json, so it works for N packagings.
                   SELECT gi.product_sync_id,
                          SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
                          SUM(gi.total_price) AS total_cost
                   FROM grn_items gi
                   LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
                   WHERE gi.product_sync_id IS NOT NULL AND gi.deleted_at IS NULL
                   GROUP BY gi.product_sync_id
                 ) grn_qty ON grn_qty.product_sync_id = p.sync_id
                 WHERE p.deleted_at IS NULL AND p.tenant_id = ?`;
    const params = [req.user.tenantId];

    if (category && category !== 'All') {
      params.push(category);
      query += ` AND c.name = ?`;
    }
    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      query += ` AND (p.name LIKE ? OR p.code LIKE ?)`;
    }
    query += ' ORDER BY p.created_at DESC';

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Quick Items ──────────────────────────────────────────────────────────────

// GET /api/products/quick-items — list quick items with product details
router.get('/quick-items', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT qi.id, qi.product_sync_id, qi.position,
             p.id as product_id, p.name, p.code, p.unit, p.selling_price, p.image_url,
             c.name as category_name
      FROM quick_items qi
      JOIN products p ON p.sync_id = qi.product_sync_id AND p.deleted_at IS NULL
      LEFT JOIN categories c ON c.sync_id = p.category_sync_id
      WHERE qi.tenant_id = ?
      ORDER BY qi.position ASC, qi.created_at ASC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products/quick-items — add a product to quick items
router.post('/quick-items', auth, (req, res) => {
  try {
    const { product_sync_id } = req.body;
    if (!product_sync_id) return res.status(400).json({ error: 'product_sync_id required' });
    const maxPos = db.prepare('SELECT MAX(position) as m FROM quick_items WHERE tenant_id = ?').get(req.user.tenantId);
    const position = (maxPos?.m ?? -1) + 1;
    db.prepare('INSERT OR IGNORE INTO quick_items (tenant_id, product_sync_id, position) VALUES (?, ?, ?)').run(req.user.tenantId, product_sync_id, position);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/products/quick-items/:productSyncId — remove from quick items
router.delete('/quick-items/:productSyncId', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM quick_items WHERE tenant_id = ? AND product_sync_id = ?').run(req.user.tenantId, req.params.productSyncId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get product by ID
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(
      `SELECT p.*, c.name as category_name FROM products p
       LEFT JOIN categories c ON p.category_sync_id = c.sync_id WHERE p.id = ? AND p.deleted_at IS NULL AND p.tenant_id = ?`
    ).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create product
// Normalise multi-unit input into a clean array. Accepts either:
//  - `units`: [{ name, conv, price, is_base }]   (new shape — multi-unit)
//  - legacy `unit` + `alt_unit` + `conversion_factor` + `alt_price`
// Returns { units, legacy } where legacy mirrors the first base + first non-base for the
// existing alt_unit columns so older code paths keep working.
function normaliseUnits(body) {
  let arr = Array.isArray(body.units) ? body.units : null;
  if (!arr || arr.length === 0) {
    const baseName = (body.unit || 'pcs').trim() || 'pcs';
    arr = [{ name: baseName, conv: 1, price: parseFloat(body.selling_price || 0), is_base: true }];
    const alt = (body.alt_unit || '').trim();
    if (alt && parseFloat(body.conversion_factor || 0) > 0) {
      arr.push({ name: alt, conv: parseFloat(body.conversion_factor), price: parseFloat(body.alt_price || 0), is_base: false });
    }
  }
  // Coerce, dedupe by name, ensure exactly one base row (conv=1, is_base=true).
  const seen = new Set();
  const cleaned = [];
  for (const u of arr) {
    const name = (u.name || '').toString().trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      name,
      conv: Math.max(0, parseFloat(u.conv) || 0),
      price: Math.max(0, parseFloat(u.price) || 0),
      is_base: !!u.is_base,
    });
  }
  if (cleaned.length === 0) cleaned.push({ name: 'pcs', conv: 1, price: 0, is_base: true });
  // Force a single base. Prefer flagged is_base; otherwise the row with conv=1; otherwise the first.
  let baseIdx = cleaned.findIndex(u => u.is_base);
  if (baseIdx === -1) baseIdx = cleaned.findIndex(u => u.conv === 1);
  if (baseIdx === -1) baseIdx = 0;
  cleaned.forEach((u, i) => { u.is_base = i === baseIdx; if (u.is_base) u.conv = 1; });
  // Non-base rows must have conv > 0.
  for (const u of cleaned) if (!u.is_base && !(u.conv > 0)) {
    throw Object.assign(new Error(`Conversion factor for "${u.name}" must be a positive number`), { status: 400 });
  }
  const base = cleaned[baseIdx];
  const firstAlt = cleaned.find(u => !u.is_base) || null;
  return {
    units: cleaned,
    legacy: {
      unit: base.name,
      selling_price: base.price,
      alt_unit: firstAlt?.name || null,
      conversion_factor: firstAlt?.conv || null,
      alt_price: firstAlt?.price ?? null,
    },
  };
}

router.post('/', auth, (req, res) => {
  try {
    const { code, name, category_id, cost_price, current_stock, min_stock, product_type,
            container_product_sync_id, units_per_container, default_unit } = req.body;
    const { units, legacy } = normaliseUnits(req.body);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const cat = category_id ? db.prepare('SELECT sync_id FROM categories WHERE id = ?').get(category_id) : null;
    const categorySyncId = cat?.sync_id || null;
    const productSyncId = randomUUID();
    const info = db.prepare(
      `INSERT INTO products (code, name, category_id, category_sync_id, unit, cost_price, selling_price, current_stock, min_stock, product_type,
       alt_unit, conversion_factor, alt_price, units_json,
       container_product_sync_id, units_per_container, default_unit,
       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    ).run(code, name, category_id, categorySyncId, legacy.unit, cost_price, legacy.selling_price, current_stock || 0, min_stock || 10,
          product_type || 'sellable',
          legacy.alt_unit, legacy.conversion_factor, legacy.alt_price,
          JSON.stringify(units),
          container_product_sync_id || null,
          units_per_container ? parseFloat(units_per_container) : null,
          default_unit || null,
          productSyncId, tenantId, branchId, deviceId);
    const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    if (parseFloat(current_stock) > 0) {
      db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
      ).run(newProduct.id, productSyncId, 'store', 'opening', current_stock, 'Opening balance',
            randomUUID(), tenantId, branchId, deviceId);
    }
    res.status(201).json(newProduct);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Update product
router.put('/:id', auth, (req, res) => {
  try {
    const { code, name, category_id, cost_price, current_stock, min_stock,
            product_type, ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start, status,
            container_product_sync_id, units_per_container, default_unit } = req.body;
    const existingProduct = db.prepare('SELECT sync_id, unit FROM products WHERE id = ?').get(req.params.id);
    if (!existingProduct) return res.status(404).json({ error: 'Product not found' });
    let normalised;
    try { normalised = normaliseUnits(req.body); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const { units, legacy } = normalised;
    // Lock: base unit (legacy.unit) cannot change once stock movements exist for the product.
    if (legacy.unit !== existingProduct.unit) {
      const hasMovements = db.prepare(
        `SELECT 1 FROM stock_movements sm
         WHERE sm.product_sync_id = ? AND sm.deleted_at IS NULL
           AND sm.movement_type != 'opening' LIMIT 1`
      ).get(existingProduct.sync_id);
      if (hasMovements) return res.status(400).json({ error: 'Base unit cannot change once stock movements exist. Edit prices/conversions only.' });
    }
    db.transaction(() => {
      const cat = category_id ? db.prepare('SELECT sync_id FROM categories WHERE id = ?').get(category_id) : null;
      const categorySyncId = cat?.sync_id || null;
      // Preserve existing UB values if not provided in the request
      const existing = db.prepare('SELECT ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start FROM products WHERE id = ?').get(req.params.id) || {};
      // Container link is optional — if the caller didn't send the fields, leave whatever's stored.
      const updateContainer = container_product_sync_id !== undefined || units_per_container !== undefined;
      const containerSql = updateContainer
        ? ', container_product_sync_id=?, units_per_container=?'
        : '';
      const containerArgs = updateContainer
        ? [container_product_sync_id || null, units_per_container ? parseFloat(units_per_container) : null]
        : [];
      // default_unit: same pattern — only update if caller explicitly sent it.
      const updateDefaultUnit = default_unit !== undefined;
      const defaultUnitSql  = updateDefaultUnit ? ', default_unit=?' : '';
      const defaultUnitArgs = updateDefaultUnit ? [default_unit || null] : [];
      db.prepare(
        `UPDATE products SET code=?, name=?, category_id=?, category_sync_id=?, unit=?, cost_price=?, selling_price=?,
         current_stock=?, min_stock=?, product_type=?,
         ub_number_start=?, ub_number_length=?, ub_quantity_start=?, ub_quantity_length=?, ub_decimal_start=?,
         alt_unit=?, conversion_factor=?, alt_price=?, units_json=?${containerSql}${defaultUnitSql},
         status=?,
         updated_at=datetime('now'), synced=0 WHERE id=?`
      ).run(code, name, category_id, categorySyncId, legacy.unit, cost_price, legacy.selling_price, current_stock, min_stock,
            product_type || 'sellable',
            ub_number_start ?? existing.ub_number_start ?? 1,
            ub_number_length ?? existing.ub_number_length ?? 6,
            ub_quantity_start ?? existing.ub_quantity_start ?? 7,
            ub_quantity_length ?? existing.ub_quantity_length ?? 0,
            ub_decimal_start ?? existing.ub_decimal_start ?? 2,
            legacy.alt_unit, legacy.conversion_factor, legacy.alt_price, JSON.stringify(units),
            ...containerArgs,
            ...defaultUnitArgs,
            (status === 'Inactive' ? 'Inactive' : 'Active'),
            req.params.id);
      // Sync the opening stock movement with the new current_stock value
      const product = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(req.params.id);
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE product_sync_id=? AND movement_type='opening' AND location='store' AND deleted_at IS NULL")
        .run(product?.sync_id);
      if (parseFloat(current_stock) > 0) {
        const tenantId = syncConfig.getTenantId(req);
        const { branchId, deviceId } = syncConfig.getConfig();
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
        ).run(req.params.id, product?.sync_id, 'store', 'opening', parseFloat(current_stock), 'Opening balance',
              randomUUID(), tenantId, branchId, deviceId);
      }
    })();
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update barcode settings only
router.patch('/:id/barcode', auth, (req, res) => {
  try {
    const { ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start } = req.body;
    const pInt = (val, def) => { const n = parseInt(val); return isNaN(n) ? def : n; };
    const info = db.prepare(
      `UPDATE products SET
         ub_number_start=?, ub_number_length=?, ub_quantity_start=?,
         ub_quantity_length=?, ub_decimal_start=?,
         updated_at=datetime('now'), synced=0
       WHERE id=?`
    ).run(
      pInt(ub_number_start, 1), pInt(ub_number_length, 6), pInt(ub_quantity_start, 7),
      pInt(ub_quantity_length, 0), pInt(ub_decimal_start, 2), req.params.id
    );
    if (info.changes === 0) return res.status(404).json({ error: 'Product not found' });
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload product image
router.post('/:id/image', auth, upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const imageUrl = `/uploads/products/${req.file.filename}`;

    const old = db.prepare('SELECT image_url FROM products WHERE id = ?').get(req.params.id);
    if (old?.image_url) {
      const oldPath = path.join(__dirname, '..', old.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    db.prepare("UPDATE products SET image_url = ?, updated_at = datetime('now'), synced=0 WHERE id = ?").run(imageUrl, req.params.id);
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product image
router.delete('/:id/image', auth, (req, res) => {
  try {
    const old = db.prepare('SELECT image_url FROM products WHERE id = ?').get(req.params.id);
    if (old?.image_url) {
      const oldPath = path.join(__dirname, '..', old.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare("UPDATE products SET image_url = NULL, updated_at = datetime('now'), synced=0 WHERE id = ?").run(req.params.id);
    res.json({ message: 'Image removed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete all products — only deletes those NOT referenced by GRN/SIV/orders
router.delete('/all', auth, (req, res) => {
  try {
    const info = db.prepare(`
      UPDATE products
      SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
      WHERE deleted_at IS NULL
        AND sync_id NOT IN (
          SELECT product_sync_id FROM grn_items   WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL
          UNION SELECT product_sync_id FROM siv_items   WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL
          UNION SELECT product_sync_id FROM order_items WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL
        )
    `).run();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM products WHERE deleted_at IS NULL").get();
    res.json({
      message: `Deleted ${info.changes} product(s). ${remaining.c > 0 ? `${remaining.c} kept because they are referenced by GRN, SIV, or sales orders.` : ''}`.trim(),
      deleted: info.changes,
      kept: remaining.c
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import products from CSV
const csvUploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function parseCSV(text) {
  const lines = text.trim().split('\n').map(l => l.replace(/\r$/, ''));
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] !== undefined ? vals[j] : ''; });
    rows.push(row);
  }
  return rows;
}

router.post('/import', auth, csvUploadMem.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const text = req.file.buffer.toString('utf8');
    const rows = parseCSV(text);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    let imported = 0, skipped = 0;
    const insertStmt = db.prepare(
      `INSERT INTO products (code, name, category_id, category_sync_id, unit, cost_price, selling_price, current_stock, min_stock,
       ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
       alt_unit, conversion_factor, alt_price,
       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    );
    const checkCodeStmt = db.prepare("SELECT id FROM products WHERE code = ? AND deleted_at IS NULL");
    const getCatStmt = db.prepare("SELECT id, sync_id FROM categories WHERE name = ? AND deleted_at IS NULL");
    const stockStmt = db.prepare(
      `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    );
    db.transaction(() => {
      for (const row of rows) {
        const code = row.code?.trim();
        const name = row.name?.trim();
        if (!code || !name) { skipped++; continue; }
        if (checkCodeStmt.get(code)) { skipped++; continue; }
        let category_id = null;
        let categorySyncId = null;
        if (row.category?.trim()) {
          const cat = getCatStmt.get(row.category.trim());
          category_id = cat ? cat.id : null;
          categorySyncId = cat ? cat.sync_id : null;
        }
        const unit = row.unit?.trim() || 'pcs';
        const altUnit = row.alt_unit?.trim() || null;
        const convFactor = altUnit && row.conversion_factor ? parseFloat(row.conversion_factor) : null;
        const altPrice = altUnit && row.alt_price ? parseFloat(row.alt_price) : null;
        const cost_price = parseFloat(row.cost_price) || 0;
        const selling_price = parseFloat(row.selling_price) || 0;
        const current_stock = parseFloat(row.current_stock) || 0;
        const min_stock = parseFloat(row.min_stock) || 10;
        const ub_number_start = parseInt(row.ub_number_start) || 1;
        const ub_number_length = parseInt(row.ub_number_length) || 6;
        const ub_quantity_start = parseInt(row.ub_quantity_start) || 7;
        const ub_quantity_length = parseInt(row.ub_quantity_length) || 0;
        const ub_decimal_start = parseInt(row.ub_decimal_start) || 2;
        const productSyncId = randomUUID();
        const info = insertStmt.run(
          code, name, category_id, categorySyncId, unit, cost_price, selling_price, current_stock, min_stock,
          ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
          altUnit, convFactor, altPrice,
          productSyncId, tenantId, branchId, deviceId
        );
        if (current_stock > 0) {
          stockStmt.run(info.lastInsertRowid, productSyncId, 'store', 'opening', current_stock, 'Opening balance (import)',
            randomUUID(), tenantId, branchId, deviceId);
        }
        imported++;
      }
    })();
    res.json({ imported, skipped, message: `Imported ${imported} products. Skipped ${skipped} (duplicates or missing code/name).` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product — blocked if referenced by GRN or SIV
router.delete('/:id', auth, (req, res) => {
  try {
    const prod = db.prepare('SELECT sync_id, name FROM products WHERE id = ?').get(req.params.id);
    if (!prod) return res.status(404).json({ error: 'Product not found' });

    const grnCount = db.prepare('SELECT COUNT(*) AS c FROM grn_items WHERE product_sync_id = ? AND deleted_at IS NULL').get(prod.sync_id);
    const sivCount = db.prepare('SELECT COUNT(*) AS c FROM siv_items WHERE product_sync_id = ? AND deleted_at IS NULL').get(prod.sync_id);
    const orderCount = db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE product_sync_id = ? AND deleted_at IS NULL').get(prod.sync_id);

    if (grnCount.c > 0 || sivCount.c > 0 || orderCount.c > 0) {
      const parts = [];
      if (grnCount.c   > 0) parts.push(`${grnCount.c} GRN line(s)`);
      if (sivCount.c   > 0) parts.push(`${sivCount.c} SIV line(s)`);
      if (orderCount.c > 0) parts.push(`${orderCount.c} sales order line(s)`);
      return res.status(400).json({ error: `Cannot delete "${prod.name}" — it is used in ${parts.join(', ')}. Remove those records first or mark the product inactive.` });
    }

    db.prepare("UPDATE products SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
