/**
 * hqPush.js — helpers for pushing HQ-owned rows to every registered branch.
 *
 * v1.6.0 extends the HQ-owned set beyond Products: Categories, Main
 * Categories and Units are now also HQ-managed. When a write hits one of
 * these routes ON the HQ host (sosnazm.com), the row is INSERT/UPDATE/
 * soft-deleted at every branch with is_hq_owned=1 so branches can read
 * but can't edit.
 *
 * Detection: SKIP_SLUGS / HQ_SLUGS mirror what middleware/tenant.js
 * uses. Default DB (backend/sosna.db) is HQ's source of truth, so any
 * insert on it triggers a push.
 */
const HQ_SLUGS  = new Set(['sosnazm']);
const SKIP_SLUGS = new Set(['www', 'sosna', 'sosnazm', 'localhost', 'api', '127', 'sidanitsolutions']);

function getHostSlug(req) {
  const host = (req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  return host.split('.')[0];
}

function isHqRequest(req) {
  const slug = getHostSlug(req);
  return HQ_SLUGS.has(slug);
}

// SKIP_SLUGS only routes — true HQ, not a per-branch tenant. We push on
// these because middleware/tenant.js routes them to the default DB.
function isHqOrSkip(req) {
  const slug = getHostSlug(req);
  return !slug || HQ_SLUGS.has(slug) || SKIP_SLUGS.has(slug);
}

// Push a category row to every registered branch. Matches on sync_id;
// updates the name / color / main_category_sync_id / is_hq_owned on
// existing rows, inserts new ones. Soft-deleted on HQ → soft-deleted at
// every branch.
function pushCategoryToBranches(catRow, { listTenants, getTenantDb }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (catRow.deleted_at) {
        const info = db.prepare(`
          UPDATE categories
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(catRow.sync_id);
        if (info.changes > 0) out.updated += 1;
        continue;
      }

      const existing = db.prepare('SELECT id FROM categories WHERE sync_id = ? AND deleted_at IS NULL').get(catRow.sync_id);
      if (existing) {
        db.prepare(`
          UPDATE categories
             SET name = ?, color = ?, main_category_sync_id = ?,
                 is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(catRow.name, catRow.color || null, catRow.main_category_sync_id || null, existing.id);
        out.updated += 1;
      } else {
        // main_category_id is a local FK so we resolve via sync_id if present.
        let mainCatId = null;
        if (catRow.main_category_sync_id) {
          const mc = db.prepare('SELECT id FROM main_categories WHERE sync_id = ? AND deleted_at IS NULL').get(catRow.main_category_sync_id);
          mainCatId = mc?.id || null;
        }
        db.prepare(`
          INSERT INTO categories
            (name, color, main_category_id, main_category_sync_id, is_hq_owned,
             sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,1,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          catRow.name, catRow.color || null, mainCatId, catRow.main_category_sync_id || null,
          catRow.sync_id, branchTenantId, null, null
        );
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

function pushMainCategoryToBranches(mcRow, { listTenants, getTenantDb }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (mcRow.deleted_at) {
        const info = db.prepare(`
          UPDATE main_categories
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(mcRow.sync_id);
        if (info.changes > 0) out.updated += 1;
        continue;
      }

      const existing = db.prepare('SELECT id FROM main_categories WHERE sync_id = ? AND deleted_at IS NULL').get(mcRow.sync_id);
      if (existing) {
        db.prepare(`
          UPDATE main_categories
             SET name = ?, color = ?, is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(mcRow.name, mcRow.color || null, existing.id);
        out.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO main_categories (name, color, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,1,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(mcRow.name, mcRow.color || null, mcRow.sync_id, branchTenantId, null, null);
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

function pushUnitToBranches(unitRow, { listTenants, getTenantDb }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (unitRow.deleted_at) {
        const info = db.prepare(`
          UPDATE units
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(unitRow.sync_id);
        if (info.changes > 0) out.updated += 1;
        continue;
      }

      const existing = db.prepare('SELECT id FROM units WHERE sync_id = ? AND deleted_at IS NULL').get(unitRow.sync_id);
      if (existing) {
        db.prepare(`
          UPDATE units
             SET name = ?, abbreviation = ?, is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(unitRow.name, unitRow.abbreviation || null, existing.id);
        out.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO units (name, abbreviation, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,1,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(unitRow.name, unitRow.abbreviation || null, unitRow.sync_id, branchTenantId, null, null);
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

// v1.6.5: also checks the slug-prefixed key (`tenant:<slug>`) that HQ-
// activated branches use, and falls back to any existing products row's
// tenant_id. listTenants() in masterDb already JOINs branches.tenant_id
// so callers pass t.tenant_id first; this helper is the fallback when
// that's null (fresh branch never logged into).
function readSyncTenantId(db, slug = null) {
  try {
    const sql = slug
      ? "SELECT value FROM sync_config WHERE key = 'tenant_id' OR key = ? ORDER BY (key = 'tenant_id') DESC LIMIT 1"
      : "SELECT value FROM sync_config WHERE key = 'tenant_id' LIMIT 1";
    const row = slug ? db.prepare(sql).get(`tenant:${slug}`) : db.prepare(sql).get();
    if (row?.value) return row.value;
  } catch (_) {}
  try {
    const r = db.prepare("SELECT tenant_id FROM products WHERE tenant_id IS NOT NULL AND tenant_id != '' LIMIT 1").get();
    return r?.tenant_id || null;
  } catch { return null; }
}

// v1.6.1: Products now follow the same flow as Categories/Units. HQ uses
// the standard Item Details page; saves auto-push to every branch with
// is_hq_owned=1. Branches lock the HQ-owned columns via the tab UI.
//
// HQ-owned columns (pushed/overwritten on UPDATE):
//   code, name, unit, units_json, default_unit, image_url,
//   container_product_sync_id, units_per_container,
//   ub_number_start/length, ub_quantity_start/length, ub_decimal_start,
//   category (resolved by sync_id, same lookup as branches receive).
// Branch-owned columns (never touched after first INSERT):
//   cost_price, selling_price, alt_price, min_stock, status,
//   current_stock, notes.
function pushProductToBranches(prodRow, { listTenants, getTenantDb }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (prodRow.deleted_at) {
        const info = db.prepare(`
          UPDATE products
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(prodRow.sync_id);
        if (info.changes > 0) out.updated += 1;
        continue;
      }

      // Resolve category_id at the branch by sync_id (HQ category was
      // pushed earlier via pushCategoryToBranches so the row exists).
      let branchCategoryId = null;
      if (prodRow.category_sync_id) {
        const c = db.prepare('SELECT id FROM categories WHERE sync_id = ? AND deleted_at IS NULL').get(prodRow.category_sync_id);
        branchCategoryId = c?.id || null;
      }

      // v1.6.8: alt_unit / conversion_factor are HQ-owned (they describe
      // the packaging structure HQ defines). alt_price is NOT — that's
      // the branch's per-packaging selling price. So we push the structural
      // alt_unit + conversion_factor but leave alt_price alone (only set
      // it on the initial INSERT when the row doesn't exist yet).
      const existing = db.prepare('SELECT id FROM products WHERE sync_id = ? AND deleted_at IS NULL').get(prodRow.sync_id);
      if (existing) {
        db.prepare(`
          UPDATE products
             SET code = ?, name = ?, category_id = ?, category_sync_id = ?,
                 unit = ?, units_json = ?, default_unit = ?, image_url = ?,
                 container_product_sync_id = ?, units_per_container = ?,
                 ub_number_start = ?, ub_number_length = ?,
                 ub_quantity_start = ?, ub_quantity_length = ?,
                 ub_decimal_start = ?,
                 alt_unit = ?, conversion_factor = ?,
                 is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(
          prodRow.code || null, prodRow.name,
          branchCategoryId, prodRow.category_sync_id || null,
          prodRow.unit || 'pcs', prodRow.units_json || null,
          prodRow.default_unit || null, prodRow.image_url || null,
          prodRow.container_product_sync_id || null,
          prodRow.units_per_container || null,
          prodRow.ub_number_start ?? 1, prodRow.ub_number_length ?? 6,
          prodRow.ub_quantity_start ?? 7, prodRow.ub_quantity_length ?? 0,
          prodRow.ub_decimal_start ?? 2,
          prodRow.alt_unit || null, prodRow.conversion_factor || null,
          existing.id
        );
        out.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO products
            (code, name, category_id, category_sync_id, unit, cost_price, selling_price,
             current_stock, min_stock, units_json, default_unit, image_url,
             container_product_sync_id, units_per_container,
             ub_number_start, ub_number_length, ub_quantity_start,
             ub_quantity_length, ub_decimal_start,
             alt_unit, conversion_factor, alt_price,
             status, is_hq_owned, product_type,
             sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,?,0,0,0,0,?,?,?,?,?,?,?,?,?,?,?,?,?,'Active',1,'finished',?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          prodRow.code || null, prodRow.name,
          branchCategoryId, prodRow.category_sync_id || null,
          prodRow.unit || 'pcs',
          prodRow.units_json || null, prodRow.default_unit || null, prodRow.image_url || null,
          prodRow.container_product_sync_id || null,
          prodRow.units_per_container || null,
          prodRow.ub_number_start ?? 1, prodRow.ub_number_length ?? 6,
          prodRow.ub_quantity_start ?? 7, prodRow.ub_quantity_length ?? 0,
          prodRow.ub_decimal_start ?? 2,
          prodRow.alt_unit || null, prodRow.conversion_factor || null, null /* alt_price branch-owned */,
          prodRow.sync_id, branchTenantId, null, null
        );
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

module.exports = {
  isHqRequest, isHqOrSkip, getHostSlug,
  pushCategoryToBranches, pushMainCategoryToBranches, pushUnitToBranches,
  pushProductToBranches,
};
