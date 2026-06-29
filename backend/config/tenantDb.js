const path = require('path');
const fs = require('fs');
const { openDb } = require('./database');
const { initTenantDb } = require('./migrations');

// Tenant DB files live here: /var/www/sosna-pos-tenant/tenants/<slug>.db
const TENANTS_DIR = process.env.TENANTS_DIR
  || path.join(__dirname, '..', '..', 'tenants');

const cache = new Map(); // slug → Database instance

function getTenantDb(slug) {
  if (cache.has(slug)) return cache.get(slug);

  if (!fs.existsSync(TENANTS_DIR)) {
    fs.mkdirSync(TENANTS_DIR, { recursive: true });
  }

  const dbPath = path.join(TENANTS_DIR, `${slug}.db`);
  const isNew = !fs.existsSync(dbPath);
  const db = openDb(dbPath);

  if (isNew) {
    console.log(`[tenant] Initialising new DB for: ${slug}`);
  } else {
    console.log(`[tenant] Running migrations for existing DB: ${slug}`);
  }
  initTenantDb(db);

  cache.set(slug, db);

  // ─── v1.9.0 — Layer 2: on-register auto-mirror ─────────────────────────
  // The first time we open a brand-new branch DB, copy every HQ-owned row
  // (main_categories, categories, units, products) into it so the branch
  // launches with HQ's catalogue already populated. Without this, new
  // branches (e.g. mansa1 after activation) come up with 0 products —
  // pushProductToBranches only fires on EDIT at HQ, never on first sight.
  //
  // setImmediate so we don't block the caller (tenant middleware) — the
  // first /products request races a touch but the next refresh will be
  // fully populated. Requires deferred require() because hqPush imports
  // are loaded by server.js after this module, and database/masterDb are
  // both pre-existing here.
  if (isNew) {
    setImmediate(() => {
      try {
        const { defaultDb } = require('./database');
        const { listTenants } = require('./masterDb');
        const { mirrorAllHqToBranches } = require('../middleware/hqPush');
        const t0 = Date.now();
        const r = mirrorAllHqToBranches(defaultDb, {
          listTenants,
          getTenantDb,
          targetSlug: slug,
        });
        const b = (r.per_branch || {})[slug];
        if (b) {
          console.log(`[hq-mirror] On-register sweep for "${slug}" done in ${Date.now() - t0}ms — products: ${b.products.pushed} inserted, ${b.products.updated} updated; categories: ${b.categories.pushed}; units: ${b.units.pushed}`);
        }
      } catch (e) {
        console.error(`[hq-mirror] On-register sweep for "${slug}" failed:`, e.message);
      }
    });
  }

  return db;
}

module.exports = { getTenantDb, TENANTS_DIR };
