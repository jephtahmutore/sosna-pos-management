/**
 * hqProducts.js — HQ-owned product master + auto-push to branches.
 *
 * Design (per user spec on 2026-06-21):
 *   - HQ declares the canonical product list (name / code / unit /
 *     default prices / categories).
 *   - Every registered branch gets a COPY in its own products table
 *     using the SAME sync_id, so the linkage survives renames and the
 *     existing POS / stock / sync code paths just work.
 *   - Each branch keeps its OWN selling_price (and cost_price). HQ
 *     defaults only fill on the FIRST insert; subsequent HQ edits push
 *     name / unit / units_json / min_stock / status / etc but do NOT
 *     overwrite branch-set prices — unless the caller passes
 *     override_prices=true explicitly.
 *
 * Auto-pushing is synchronous-best-effort: a branch DB that won't open
 * is logged + skipped; the master row is still saved so HQ can re-push
 * later via /api/hq/products/:id/push.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { masterDb, listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

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

// Push an HQ master product into every registered branch's products
// table. Idempotent: matches on sync_id. On INSERT we fill cost + price
// from HQ defaults; on UPDATE we only touch name / code / unit /
// units_json / min_stock / status / product_type (preserves branch
// pricing) unless overridePrices is true.
function pushToBranches(hqRow, { overridePrices = false } = {}) {
  const out = { pushed: 0, updated: 0, skipped: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      // CRITICAL — branch's GET /api/products filters
      //   WHERE p.tenant_id = req.user.tenantId
      // so a row inserted with tenant_id NULL is invisible to the branch's
      // Item Details page. Read the branch's own tenant_id from its
      // sync_config so the row is visible + scoped correctly. branch_id
      // similarly read so the device_filter on later reports doesn't drop
      // these rows. v1.3.4 hotfix for v1.3.3.
      // Discover the branch's tenant_id in order of reliability:
      //   1. sync_config['tenant_id']                    (preferred)
      //   2. Any existing products row's non-empty tenant_id
      //   3. business_settings.tenant_id
      // None of the three? Leave null and skip the INSERT below — the
      // row would be invisible to GET /products anyway (it filters by
      // p.tenant_id = req.user.tenantId).
      let branchTenantId = null;
      let branchBranchId = null;
      try {
        const tRow = db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get();
        if (tRow?.value) branchTenantId = tRow.value;
      } catch (_) { /* fresh DB without sync_config yet */ }
      if (!branchTenantId) {
        try {
          const r = db.prepare("SELECT tenant_id FROM products WHERE tenant_id IS NOT NULL AND tenant_id != '' LIMIT 1").get();
          if (r?.tenant_id) branchTenantId = r.tenant_id;
        } catch (_) {}
      }
      if (!branchTenantId) {
        try {
          const r = db.prepare("SELECT tenant_id FROM business_settings WHERE tenant_id IS NOT NULL AND tenant_id != '' LIMIT 1").get();
          if (r?.tenant_id) branchTenantId = r.tenant_id;
        } catch (_) {}
      }
      try {
        const bRow = db.prepare("SELECT value FROM sync_config WHERE key = 'branch_id'").get();
        if (bRow?.value) branchBranchId = bRow.value;
      } catch (_) { /* fine */ }
      if (!branchBranchId) {
        try {
          const r = db.prepare("SELECT branch_id FROM products WHERE branch_id IS NOT NULL AND branch_id != '' LIMIT 1").get();
          if (r?.branch_id) branchBranchId = r.branch_id;
        } catch (_) {}
      }

      // Backfill any orphan v1.3.3 row first (tenant_id NULL from the
      // bug) so it becomes visible to the branch's GET /api/products
      // immediately on the next push — no DB surgery needed.
      if (branchTenantId) {
        try {
          db.prepare(`UPDATE products SET tenant_id = ?, branch_id = COALESCE(branch_id, ?) WHERE sync_id = ? AND (tenant_id IS NULL OR tenant_id = '')`)
            .run(branchTenantId, branchBranchId, hqRow.sync_id);
        } catch (_) {}
      }

      const existing = db.prepare(
        'SELECT id, cost_price, selling_price FROM products WHERE sync_id = ?'
      ).get(hqRow.sync_id);
      if (existing) {
        if (overridePrices) {
          db.prepare(`
            UPDATE products
               SET code = ?, name = ?, unit = ?,
                   cost_price = ?, selling_price = ?,
                   min_stock = ?, units_json = ?,
                   status = ?, product_type = ?,
                   updated_at = datetime('now'), synced = 0
             WHERE id = ?
          `).run(
            hqRow.code || null, hqRow.name, hqRow.unit || 'pcs',
            hqRow.default_cost_price || 0, hqRow.default_selling_price || 0,
            hqRow.min_stock || 0, hqRow.units_json || null,
            hqRow.status || 'Active', hqRow.product_type || 'finished',
            existing.id
          );
        } else {
          db.prepare(`
            UPDATE products
               SET code = ?, name = ?, unit = ?,
                   min_stock = ?, units_json = ?,
                   status = ?, product_type = ?,
                   updated_at = datetime('now'), synced = 0
             WHERE id = ?
          `).run(
            hqRow.code || null, hqRow.name, hqRow.unit || 'pcs',
            hqRow.min_stock || 0, hqRow.units_json || null,
            hqRow.status || 'Active', hqRow.product_type || 'finished',
            existing.id
          );
        }
        out.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO products (code, name, unit, cost_price, selling_price,
                                current_stock, min_stock, units_json, status,
                                product_type, sync_id, tenant_id, branch_id, device_id,
                                synced, created_at, updated_at)
          VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          hqRow.code || null, hqRow.name, hqRow.unit || 'pcs',
          hqRow.default_cost_price || 0, hqRow.default_selling_price || 0,
          hqRow.min_stock || 0, hqRow.units_json || null,
          hqRow.status || 'Active', hqRow.product_type || 'finished',
          hqRow.sync_id, branchTenantId, branchBranchId, null
        );
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

// GET /api/hq/products?status=Active|Inactive|&q=
router.get('/', hqAuth, (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const q      = String(req.query.q || '').trim().toLowerCase();
    let sql = `SELECT * FROM hq_products WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (q)      { sql += ' AND LOWER(name) LIKE ?'; params.push(`%${q}%`); }
    sql += ' ORDER BY name COLLATE NOCASE ASC';
    res.json({ products: masterDb.prepare(sql).all(...params) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/products/:id — header + per-branch override snapshot so HQ
// can see which branches deviated from the default cost/selling.
router.get('/:id', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    const branches = [];
    for (const t of listTenants()) {
      try {
        const db = getTenantDb(t.slug);
        const p = db.prepare(
          'SELECT id, cost_price, selling_price, current_stock, min_stock FROM products WHERE sync_id = ?'
        ).get(row.sync_id);
        branches.push({ slug: t.slug, name: t.business_name || t.slug, found: !!p, ...p });
      } catch (e) {
        branches.push({ slug: t.slug, name: t.business_name || t.slug, error: e.message });
      }
    }
    res.json({ product: row, branches });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/products
router.post('/', hqAuth, (req, res) => {
  try {
    const { code, name, category_name, main_category_name, unit,
            default_cost_price, default_selling_price, min_stock,
            units_json, status, product_type, image_url, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    // Reject case-insensitive dup so the auto-push doesn't make two
    // products at branches that map to one master.
    const dup = masterDb.prepare(`SELECT id FROM hq_products WHERE LOWER(name) = LOWER(?) AND status != 'Deleted'`).get(name.trim());
    if (dup) return res.status(400).json({ error: 'A product with this name already exists in the HQ master' });

    const syncId = randomUUID();
    const createdBy     = req.user.id || null;
    const createdByName = req.user.firstName || req.user.email || 'HQ';
    const info = masterDb.prepare(`
      INSERT INTO hq_products (sync_id, code, name, category_name, main_category_name,
                               unit, default_cost_price, default_selling_price,
                               min_stock, units_json, status, product_type,
                               image_url, notes, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      syncId, code || null, name.trim(),
      category_name || null, main_category_name || null,
      unit || 'pcs',
      parseFloat(default_cost_price) || 0, parseFloat(default_selling_price) || 0,
      parseFloat(min_stock) || 0, units_json || null,
      (status === 'Inactive' ? 'Inactive' : 'Active'),
      product_type || 'finished',
      image_url || null, notes || null,
      createdBy, createdByName
    );
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(info.lastInsertRowid);
    const pushReport = pushToBranches(row, { overridePrices: true });
    res.status(201).json({ product: row, push: pushReport });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/products/:id?override_prices=1
// Default: branches keep their own cost / selling price. Pass
// override_prices=1 to force-push the new HQ defaults onto every branch.
router.put('/:id', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    const { code, name, category_name, main_category_name, unit,
            default_cost_price, default_selling_price, min_stock,
            units_json, status, product_type, image_url, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (name.trim().toLowerCase() !== row.name.toLowerCase()) {
      const dup = masterDb.prepare(`SELECT id FROM hq_products WHERE LOWER(name) = LOWER(?) AND id != ?`).get(name.trim(), req.params.id);
      if (dup) return res.status(400).json({ error: 'Another HQ product already uses this name' });
    }
    masterDb.prepare(`
      UPDATE hq_products
         SET code = ?, name = ?, category_name = ?, main_category_name = ?,
             unit = ?, default_cost_price = ?, default_selling_price = ?,
             min_stock = ?, units_json = ?, status = ?, product_type = ?,
             image_url = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(
      code || null, name.trim(),
      category_name || null, main_category_name || null,
      unit || 'pcs',
      parseFloat(default_cost_price) || 0, parseFloat(default_selling_price) || 0,
      parseFloat(min_stock) || 0, units_json || null,
      (status === 'Inactive' ? 'Inactive' : 'Active'),
      product_type || 'finished',
      image_url || null, notes || null,
      req.params.id
    );
    const updated = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    const overridePrices = req.query.override_prices === '1' || req.query.override_prices === 'true';
    const pushReport = pushToBranches(updated, { overridePrices });
    res.json({ product: updated, push: pushReport });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/products/:id — soft delete (status='Inactive'); branches
// mirror the deactivation. Hard delete is intentionally not exposed —
// it would orphan branch products with the same sync_id.
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    masterDb.prepare(`UPDATE hq_products SET status = 'Inactive', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    const updated = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    pushToBranches(updated);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/products/:id/push — manual re-push (handy for newly-added
// branches that joined after the product was created, or to recover
// after a transient branch DB failure).
router.post('/:id/push', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    const overridePrices = req.body?.override_prices === true || req.query.override_prices === '1';
    res.json(pushToBranches(row, { overridePrices }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
