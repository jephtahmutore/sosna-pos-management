const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard, withTenantDb } = require('../middleware/auth');
const { isHqRequest, pushProductToBranches, pushCategoryToBranches, pushMainCategoryToBranches, mergeUnitsJsonPreservingBranchPrices } = require('../middleware/hqPush');
const { listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
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

// v1.5.0: product_type removed from the public API surface. Always inserted
// as 'finished' on the DB so legacy queries that filter on it keep working.
// Branches no longer create products via this endpoint in the new HQ-owned
// workflow, but the route stays for the legacy/local-only path so older
// installs (Electron, single-tenant) continue to work.
router.post('/', auth, (req, res) => {
  try {
    const { code, name, category_id, cost_price, current_stock, min_stock,
            container_product_sync_id, units_per_container, default_unit,
            image_url, ub_number_start, ub_number_length, ub_quantity_start,
            ub_quantity_length, ub_decimal_start } = req.body;
    const { units, legacy } = normaliseUnits(req.body);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const cat = category_id ? db.prepare('SELECT sync_id FROM categories WHERE id = ?').get(category_id) : null;
    const categorySyncId = cat?.sync_id || null;
    const productSyncId = randomUUID();
    const fromHq = isHqRequest(req);
    const info = db.prepare(
      `INSERT INTO products (code, name, category_id, category_sync_id, unit, cost_price, selling_price, current_stock, min_stock, product_type,
       alt_unit, conversion_factor, alt_price, units_json,
       container_product_sync_id, units_per_container, default_unit, image_url,
       ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
       is_hq_owned,
       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'finished',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    ).run(code, name, category_id, categorySyncId, legacy.unit, cost_price, legacy.selling_price, current_stock || 0, min_stock || 10,
          legacy.alt_unit, legacy.conversion_factor, legacy.alt_price,
          JSON.stringify(units),
          container_product_sync_id || null,
          units_per_container ? parseFloat(units_per_container) : null,
          default_unit || null,
          image_url || null,
          parseInt(ub_number_start) || 1,
          parseInt(ub_number_length) || 6,
          parseInt(ub_quantity_start) || 7,
          parseInt(ub_quantity_length) || 0,
          parseInt(ub_decimal_start) || 2,
          fromHq ? 1 : 0,
          productSyncId, tenantId, branchId, deviceId);
    const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    if (parseFloat(current_stock) > 0) {
      db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
      ).run(newProduct.id, productSyncId, 'store', 'opening', current_stock, 'Opening balance',
            randomUUID(), tenantId, branchId, deviceId);
    }
    if (fromHq) {
      try { pushProductToBranches(newProduct, { listTenants, getTenantDb }); } catch (_) { /* best-effort */ }
    }
    res.status(201).json(newProduct);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Update product
// v1.5.0: when products.is_hq_owned=1, the request body's HQ-owned fields
// are ignored — branch can only change cost_price, selling_price,
// alt_price (within units_json), min_stock, status, current_stock, notes.
// HQ fields stay locked to whatever HQ pushed.
router.put('/:id', auth, (req, res) => {
  try {
    const { code, name, category_id, cost_price, current_stock, min_stock,
            ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start, status,
            container_product_sync_id, units_per_container, default_unit } = req.body;
    const existingProduct = db.prepare('SELECT sync_id, unit, is_hq_owned, code, name, category_id, category_sync_id, units_json, default_unit, image_url, container_product_sync_id, units_per_container, ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start FROM products WHERE id = ?').get(req.params.id);
    if (!existingProduct) return res.status(404).json({ error: 'Product not found' });
    const isHq = !!existingProduct.is_hq_owned;
    let normalised;
    try { normalised = normaliseUnits(req.body); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const { units, legacy } = normalised;
    // Lock: base unit (legacy.unit) cannot change once stock movements exist for the product.
    if (!isHq && legacy.unit !== existingProduct.unit) {
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
      // For HQ-owned products edited FROM A BRANCH, the HQ-owned columns are
      // forced back to whatever HQ pushed. Branch-owned columns (price/min/
      // status/stock) come from the request.
      // v1.7.3 — when the request comes from HQ itself, HQ must be able to
      // edit those columns (packagings, default unit, category, etc.) or
      // changes silently disappear on save. So lock only for non-HQ requests.
      const useHqFields = isHq && !isHqRequest(req);
      const finalCode      = useHqFields ? existingProduct.code      : code;
      const finalName      = useHqFields ? existingProduct.name      : name;
      const finalCategoryId       = useHqFields ? existingProduct.category_id      : category_id;
      const finalCategorySyncId   = useHqFields ? existingProduct.category_sync_id : categorySyncId;
      const finalUnit             = useHqFields ? existingProduct.unit             : legacy.unit;
      // v1.7.8: per-packaging selling `price` inside units_json is branch-owned
      // (same as legacy alt_price + top-level selling_price). When a branch
      // edits an HQ-owned product, keep HQ's structure (name/conv/is_base/
      // barcode) but accept the branch's typed prices. mergeUnitsJsonPreserving
      // BranchPrices treats the request's `units` as the branch's price source
      // and existingProduct.units_json as HQ's structure.
      const finalUnitsJson        = useHqFields
        ? mergeUnitsJsonPreservingBranchPrices(existingProduct.units_json, JSON.stringify(units))
        : JSON.stringify(units);
      const finalDefaultUnit      = useHqFields ? existingProduct.default_unit
                                                : (default_unit !== undefined ? (default_unit || null) : undefined);
      const finalContainerSync    = useHqFields ? existingProduct.container_product_sync_id
                                                : (container_product_sync_id !== undefined ? (container_product_sync_id || null) : undefined);
      const finalContainerUnits   = useHqFields ? existingProduct.units_per_container
                                                : (units_per_container !== undefined ? (units_per_container ? parseFloat(units_per_container) : null) : undefined);
      const finalUbNumStart   = useHqFields ? existingProduct.ub_number_start    : (ub_number_start    ?? existingProduct.ub_number_start    ?? 1);
      const finalUbNumLen     = useHqFields ? existingProduct.ub_number_length   : (ub_number_length   ?? existingProduct.ub_number_length   ?? 6);
      const finalUbQtyStart   = useHqFields ? existingProduct.ub_quantity_start  : (ub_quantity_start  ?? existingProduct.ub_quantity_start  ?? 7);
      const finalUbQtyLen     = useHqFields ? existingProduct.ub_quantity_length : (ub_quantity_length ?? existingProduct.ub_quantity_length ?? 0);
      const finalUbDecStart   = useHqFields ? existingProduct.ub_decimal_start   : (ub_decimal_start   ?? existingProduct.ub_decimal_start   ?? 2);
      const finalAltUnit      = useHqFields ? null : legacy.alt_unit;
      const finalConvFactor   = useHqFields ? null : legacy.conversion_factor;
      const finalAltPrice     = useHqFields ? null : legacy.alt_price;

      // Container / default_unit only update when explicitly provided OR
      // when HQ-locked (forced).
      const updateContainer   = useHqFields || container_product_sync_id !== undefined || units_per_container !== undefined;
      const containerSql      = updateContainer ? ', container_product_sync_id=?, units_per_container=?' : '';
      const containerArgs     = updateContainer ? [finalContainerSync ?? null, finalContainerUnits ?? null] : [];
      const updateDefaultUnit = useHqFields || default_unit !== undefined;
      const defaultUnitSql    = updateDefaultUnit ? ', default_unit=?' : '';
      const defaultUnitArgs   = updateDefaultUnit ? [finalDefaultUnit ?? null] : [];

      db.prepare(
        `UPDATE products SET code=?, name=?, category_id=?, category_sync_id=?, unit=?, cost_price=?, selling_price=?,
         current_stock=?, min_stock=?,
         ub_number_start=?, ub_number_length=?, ub_quantity_start=?, ub_quantity_length=?, ub_decimal_start=?,
         alt_unit=?, conversion_factor=?, alt_price=?, units_json=?${containerSql}${defaultUnitSql},
         status=?,
         updated_at=datetime('now'), synced=0 WHERE id=?`
      ).run(finalCode, finalName, finalCategoryId, finalCategorySyncId, finalUnit,
            cost_price, legacy.selling_price, current_stock, min_stock,
            finalUbNumStart, finalUbNumLen, finalUbQtyStart, finalUbQtyLen, finalUbDecStart,
            finalAltUnit, finalConvFactor, finalAltPrice, finalUnitsJson,
            ...containerArgs,
            ...defaultUnitArgs,
            (status === 'Inactive' ? 'Inactive' : 'Active'),
            req.params.id);
      // v1.10.7 — Sosna is no-store: opening balance writes to 'sales' as an
      // adjustment (reference_type='opening_balance' so re-saves can find and
      // void it). Voids ALL prior opening rows for this product regardless of
      // location/movement_type so legacy 'store'/'opening' rows get cleaned up
      // on the first edit.
      const product = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(req.params.id);
      db.prepare(`
        UPDATE stock_movements
           SET deleted_at=datetime('now'),
               updated_at=datetime('now'),
               synced=0
         WHERE product_sync_id = ?
           AND deleted_at IS NULL
           AND (
             (movement_type = 'opening' AND location = 'store')
             OR reference_type = 'opening_balance'
           )
      `).run(product?.sync_id);
      if (parseFloat(current_stock) > 0) {
        const tenantId = syncConfig.getTenantId(req);
        const { branchId, deviceId } = syncConfig.getConfig();
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_type, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
        ).run(req.params.id, product?.sync_id, 'sales', 'adjustment', parseFloat(current_stock), 'opening_balance', 'Opening balance',
              randomUUID(), tenantId, branchId, deviceId);
      }
    })();
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    // v1.6.1: when HQ edits a product, the HQ-owned columns are
    // re-pushed to every branch so each branch sees the latest name /
    // unit / packagings etc. Branch-owned columns at each branch are
    // untouched by the push helper.
    if (isHqRequest(req)) {
      try { pushProductToBranches(row, { listTenants, getTenantDb }); } catch (_) {}
    }
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
router.post('/:id/image', auth, upload.single('image'), withTenantDb, (req, res) => {
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

router.post('/import', auth, csvUploadMem.single('file'), withTenantDb, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const text = req.file.buffer.toString('utf8');
    const rows = parseCSV(text);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const fromHq = isHqRequest(req);
    const importedRows = [];
    const skippedRows  = [];
    // Newly inserted rows we'll push to branches at the end (HQ only).
    const pushQueue    = [];
    // v1.6.8: also track auto-created reference data so we can push it
    // alongside products. Without these pushes, branches receive products
    // whose category_sync_id / main_category_sync_id point to rows that
    // don't exist on the branch — yields "no category" display + units
    // dropdown gaps.
    const pushCatIds       = new Set();
    const pushMainCatIds   = new Set();

    // Auto-generate codes for rows that have a name but no code.
    const existingCodes = new Set(
      db.prepare("SELECT code FROM products WHERE deleted_at IS NULL").all().map(r => r.code)
    );
    let autoCounter = 1;
    const nextAutoCode = () => {
      let code;
      do { code = `IT${String(autoCounter).padStart(3, '0')}`; autoCounter++; }
      while (existingCodes.has(code));
      existingCodes.add(code);
      return code;
    };

    // v1.6.2 — INSERT now stores HQ-owned + branch-owned columns in one
    // shot. On HQ import we force branch-owned to 0 / null (set
    // is_hq_owned=1) so branches receive a clean record they can price
    // themselves. On branch import (legacy) branch fields come from the
    // CSV as before.
    // 28 columns total = 25 bound (?) + 3 literals.
    const insertStmt = db.prepare(
      `INSERT INTO products (code, name, category_id, category_sync_id, unit,
       cost_price, selling_price, current_stock, min_stock,
       ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
       alt_unit, conversion_factor, alt_price,
       default_unit, units_per_container, is_hq_owned,
       sync_id, tenant_id, branch_id, device_id, status,
       synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    );
    const checkCodeStmt = db.prepare("SELECT id FROM products WHERE code = ? AND deleted_at IS NULL");
    const getCatStmt = db.prepare("SELECT id, sync_id, main_category_id FROM categories WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL");
    const getMainCatStmt = db.prepare("SELECT id, sync_id FROM main_categories WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL");
    const insertCatStmt = db.prepare(
      "INSERT INTO categories (name, color, main_category_id, main_category_sync_id, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    );
    const insertMainCatStmt = db.prepare(
      "INSERT INTO main_categories (name, color, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    );
    const stockStmt = db.prepare(
      `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    );

    db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        let code = row.code?.trim();
        const name = row.name?.trim();
        if (!name) {
          skippedRows.push({ row: rowNum, code: code || '', name: '', reason: 'Missing name' });
          continue;
        }
        if (!code) code = nextAutoCode();
        if (checkCodeStmt.get(code)) {
          skippedRows.push({ row: rowNum, code, name, reason: `Duplicate code "${code}" — already exists` });
          continue;
        }

        // Auto-create main_category / category on HQ if the CSV references
        // a name that doesn't exist yet. Track ids so we push them after
        // the transaction commits (v1.6.8).
        let mainCatId = null, mainCatSyncId = null;
        const mainName = row.main_category?.trim();
        if (mainName) {
          let mc = getMainCatStmt.get(mainName);
          if (!mc && fromHq) {
            const mcSync = randomUUID();
            const r = insertMainCatStmt.run(mainName, '#6B7280', 1, mcSync, tenantId, branchId, deviceId);
            mc = getMainCatStmt.get(mainName);
            if (mc?.id) pushMainCatIds.add(mc.id);
          }
          mainCatId = mc?.id || null;
          mainCatSyncId = mc?.sync_id || null;
        }
        let category_id = null, categorySyncId = null;
        const catName = row.category?.trim();
        if (catName) {
          let c = getCatStmt.get(catName);
          if (!c && fromHq) {
            const cSync = randomUUID();
            insertCatStmt.run(catName, '#6b7280', mainCatId, mainCatSyncId, 1, cSync, tenantId, branchId, deviceId);
            c = getCatStmt.get(catName);
            if (c?.id) pushCatIds.add(c.id);
          }
          category_id = c?.id || null;
          categorySyncId = c?.sync_id || null;
        }

        const unit         = row.unit?.trim() || 'pcs';
        const defaultUnit  = row.default_unit?.trim() || null;
        const altUnit      = row.alt_unit?.trim() || null;
        const convFactor   = altUnit && row.conversion_factor ? parseFloat(row.conversion_factor) : null;
        const upc          = row.units_per_container ? parseFloat(row.units_per_container) : null;
        // Branch-owned fields — IGNORED when importing on HQ.
        const cost_price    = fromHq ? 0 : (parseFloat(row.cost_price) || 0);
        const selling_price = fromHq ? 0 : (parseFloat(row.selling_price) || 0);
        const altPrice      = fromHq ? null : (altUnit && row.alt_price ? parseFloat(row.alt_price) : null);
        const current_stock = fromHq ? 0 : (parseFloat(row.current_stock) || 0);
        const min_stock     = fromHq ? 0 : (parseFloat(row.min_stock) || 10);
        const ub_number_start    = parseInt(row.ub_number_start)    || 1;
        const ub_number_length   = parseInt(row.ub_number_length)   || 6;
        const ub_quantity_start  = parseInt(row.ub_quantity_start)  || 7;
        const ub_quantity_length = parseInt(row.ub_quantity_length) || 0;
        const ub_decimal_start   = parseInt(row.ub_decimal_start)   || 2;
        const productSyncId = randomUUID();

        const info = insertStmt.run(
          code, name, category_id, categorySyncId, unit,
          cost_price, selling_price, current_stock, min_stock,
          ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
          altUnit, convFactor, altPrice,
          defaultUnit, upc, fromHq ? 1 : 0,
          productSyncId, tenantId, branchId, deviceId, 'Active'
        );
        if (current_stock > 0) {
          stockStmt.run(info.lastInsertRowid, productSyncId, 'store', 'opening', current_stock, 'Opening balance (import)',
            randomUUID(), tenantId, branchId, deviceId);
        }
        importedRows.push({ row: rowNum, code, name });
        if (fromHq) pushQueue.push(info.lastInsertRowid);
      }
    })();

    // On HQ: push each newly-inserted product to every branch. Best-effort
    // (errors per branch surface in the response but don't roll back the
    // HQ-side insert).
    const pushErrors = [];
    if (fromHq) {
      // v1.6.8: order matters. Push main_categories first (categories
      // FK reference them), then categories (products reference them by
      // sync_id), then products. Without this order, the branch product
      // INSERT can't find its category_sync_id at the branch.
      for (const mcId of pushMainCatIds) {
        const row = db.prepare('SELECT * FROM main_categories WHERE id = ?').get(mcId);
        if (!row) continue;
        try { pushMainCategoryToBranches(row, { listTenants, getTenantDb }); }
        catch (e) { pushErrors.push({ main_category: row.name, error: e.message }); }
      }
      for (const cId of pushCatIds) {
        const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(cId);
        if (!row) continue;
        try { pushCategoryToBranches(row, { listTenants, getTenantDb }); }
        catch (e) { pushErrors.push({ category: row.name, error: e.message }); }
      }
      for (const newId of pushQueue) {
        const row = db.prepare('SELECT * FROM products WHERE id = ?').get(newId);
        try {
          const r = pushProductToBranches(row, { listTenants, getTenantDb });
          if (r.errors?.length) pushErrors.push(...r.errors.map(e => ({ ...e, product: row.name })));
        } catch (e) { pushErrors.push({ product: row.name, error: e.message }); }
      }
    }

    const imported = importedRows.length;
    const skipped  = skippedRows.length;
    res.json({
      imported, skipped,
      imported_rows: importedRows,
      skipped_rows:  skippedRows,
      push_errors:   pushErrors,
      message: `Imported ${imported} products. Skipped ${skipped} (duplicates or missing name).${fromHq ? ` Pushed to all branches.` : ''}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product — blocked if referenced by GRN or SIV. v1.6.1: branches
// can't delete HQ-owned items; HQ deletes propagate the soft-delete to
// every branch.
router.delete('/:id', auth, (req, res) => {
  try {
    const prod = db.prepare('SELECT sync_id, name, is_hq_owned FROM products WHERE id = ?').get(req.params.id);
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    const fromHq = isHqRequest(req);
    if (prod.is_hq_owned && !fromHq) {
      return res.status(403).json({ error: 'This item is managed by HQ and cannot be deleted at the branch.' });
    }

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
    if (fromHq) {
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      try { pushProductToBranches(row, { listTenants, getTenantDb }); } catch (_) {}
    }
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.8.1 — Transfer all store stock to sales floor as one SIV.
// Password-gated (passed in body). Returns siv number + line count.
router.post('/bulk-siv-store-to-sales', auth, (req, res) => {
  const PASSWORD = '108120';
  if (String(req.body?.password || '') !== PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  try {
    const items = db.prepare(`
      SELECT * FROM (
        SELECT p.id, p.sync_id, p.name, p.unit AS base_unit, p.default_unit, p.selling_price, p.units_json,
               (SELECT COALESCE(SUM(quantity),0) FROM stock_movements
                  WHERE product_sync_id = p.sync_id AND location = 'store' AND deleted_at IS NULL) AS store_qty
        FROM products p
        WHERE p.deleted_at IS NULL
      ) WHERE store_qty > 0
      ORDER BY name
    `).all();

    if (items.length === 0) {
      return res.status(400).json({ error: 'No items have store stock to transfer.' });
    }

    const tenantId = syncConfig.getTenantId(req);
    const cfg = syncConfig.getConfig() || {};
    const sivNumber = syncConfig.generateNumber('SIV', 'siv');
    const sivSyncId = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const stamp = today + ' ' + new Date().toTimeString().slice(0, 8);

    // Compute per-line qty in the product's default unit + per-default-unit price.
    const lines = items.map(p => {
      let units = [];
      try { units = JSON.parse(p.units_json || '[]'); } catch {}
      const dfltName = (p.default_unit || '').trim() || p.base_unit;
      const dfltU = units.find(u => (u.name || '').trim() === dfltName);
      const conv = dfltU ? (parseFloat(dfltU.conv) || 1) : 1;
      const baseQty = p.store_qty;
      const lineQty = baseQty / conv;
      const dfltUnitPrice = dfltU && parseFloat(dfltU.price) > 0
        ? parseFloat(dfltU.price)
        : (parseFloat(p.selling_price) || 0) * conv;
      return { p, lineUnit: dfltName, baseQty, lineQty, unitPrice: dfltUnitPrice, total: lineQty * dfltUnitPrice };
    });
    const totalValue = lines.reduce((s, l) => s + l.total, 0);

    db.transaction(() => {
      db.prepare(`INSERT INTO siv (siv_number, date, department, total_items, total_value, notes,
                                   created_by, status, sync_id, tenant_id, branch_id, device_id,
                                   synced, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,'Issued',?,?,?,?,0,datetime('now'),datetime('now'))`)
        .run(sivNumber, today, 'Bulk transfer', lines.length, totalValue,
             'Transfer all store stock to sales floor',
             req.user.id, sivSyncId, tenantId, cfg.branchId || null, cfg.deviceId || null);

      const sId = db.prepare('SELECT id FROM siv WHERE sync_id = ?').get(sivSyncId).id;

      const insItem = db.prepare(`INSERT INTO siv_items
        (siv_id, siv_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price,
         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`);
      const insMv = db.prepare(`INSERT INTO stock_movements
        (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type,
         created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`);

      for (const l of lines) {
        insItem.run(sId, sivSyncId, l.p.id, l.p.sync_id, l.lineQty, l.lineUnit, l.unitPrice, l.total,
                    randomUUID(), tenantId, cfg.branchId || null, cfg.deviceId || null);
        insMv.run(l.p.id, l.p.sync_id, 'store', 'siv', -l.baseQty, sId, 'siv', req.user.id,
                  randomUUID(), tenantId, cfg.branchId || null, cfg.deviceId || null, stamp, stamp, sivSyncId);
        insMv.run(l.p.id, l.p.sync_id, 'sales', 'siv',  l.baseQty, sId, 'siv', req.user.id,
                  randomUUID(), tenantId, cfg.branchId || null, cfg.deviceId || null, stamp, stamp, sivSyncId);
      }
    })();

    res.json({ success: true, siv_number: sivNumber, lines: lines.length, total_value: totalValue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/products/bulk-update-prices ──────────────────────────────────
// v1.8.34 — Quick Price Update page. Accepts a list of products with a single
// "base price" (price for the base unit, e.g. price per Bottle). For each
// product, updates units_json so every packaging's price = base_price × conv,
// and updates the legacy selling_price column = base_price. Single transaction.
//
// v1.10.26 — Optional per-unit overrides. Non-default units may carry a
// distinct price without disturbing base or siblings, mirroring Item
// Details behaviour. After deriving base × conv for every unit, any
// packaging listed in unit_prices is overwritten with that value.
//
// Body: { updates: [
//   { id: 123, base_price: 1.10 },                                    // simple cascade
//   { id: 456, base_price: 1.10, unit_prices: { "Six Pack": 8.50 } }, // + override
// ] }
router.post('/bulk-update-prices', auth, (req, res) => {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided.' });

    const select = db.prepare('SELECT id, units_json, is_hq_owned FROM products WHERE id = ? AND tenant_id = ?');
    const update = db.prepare(`UPDATE products SET units_json = ?, selling_price = ?, alt_price = ?,
                                 updated_at = datetime('now'), synced = 0 WHERE id = ?`);

    const tx = db.transaction(() => {
      let count = 0;
      for (const u of updates) {
        const id = parseInt(u.id, 10);
        const basePrice = parseFloat(u.base_price);
        if (!id || !(basePrice >= 0)) continue;
        const row = select.get(id, req.user.tenantId);
        if (!row) continue;
        let units = [];
        try { units = JSON.parse(row.units_json || '[]'); } catch {}
        if (!Array.isArray(units) || units.length === 0) continue;
        const overrides = (u.unit_prices && typeof u.unit_prices === 'object') ? u.unit_prices : {};
        const updatedUnits = units.map(unit => {
          const derived = parseFloat((basePrice * (parseFloat(unit.conv) || 1)).toFixed(4));
          const key = (unit.name || '').trim();
          const override = overrides[key];
          const finalPrice = (!unit.is_base && override !== undefined && override !== null && parseFloat(override) > 0)
            ? parseFloat(parseFloat(override).toFixed(4))
            : derived;
          return { ...unit, price: finalPrice };
        });
        const nonBase = updatedUnits.filter(x => !x.is_base);
        const altPrice = nonBase.length > 0
          ? nonBase.sort((a, b) => parseFloat(b.conv) - parseFloat(a.conv))[0].price
          : basePrice;
        update.run(JSON.stringify(updatedUnits), basePrice, altPrice, id);
        count++;
      }
      return count;
    });

    const updated = tx();
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
