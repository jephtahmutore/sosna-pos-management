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
      const branchTenantId = t.tenant_id || readSyncTenantId(db);
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
      const branchTenantId = t.tenant_id || readSyncTenantId(db);
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
      const branchTenantId = t.tenant_id || readSyncTenantId(db);
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

function readSyncTenantId(db) {
  try {
    const row = db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get();
    return row?.value || null;
  } catch { return null; }
}

module.exports = {
  isHqRequest, isHqOrSkip, getHostSlug,
  pushCategoryToBranches, pushMainCategoryToBranches, pushUnitToBranches,
};
