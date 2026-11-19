// Creates branch DBs (running the app's own migrations) and registers them.
const B = process.env.BACKEND || require('path').join(__dirname, '..', '..');
require(B + '/config/database');
const { getTenantDb } = require(B + '/config/tenantDb');
const { masterDb } = require(B + '/config/masterDb');
const BR = [['branch1', 'T1', 'Branch 1', 'K'], ['branch2', 'T2', 'Branch 2', 'K'], ['branch3', 'T3', 'Branch 3', 'USD+FRA+K']];
for (const [slug, tid, name, cm] of BR) {
  masterDb.prepare('INSERT INTO tenants (slug, business_name, is_active) VALUES (?,?,1)').run(slug, name);
  masterDb.prepare('INSERT INTO branches (tenant_id, branch_id, branch_name, slug) VALUES (?,?,?,?)').run(tid, 'B-' + tid, name, slug);
  const db = getTenantDb(slug);
  db.prepare('INSERT INTO business_settings (business_name, currency_mode) VALUES (?,?)').run(name, cm);
  db.prepare("INSERT OR REPLACE INTO sync_config (key,value) VALUES ('tenant_id',?)").run(tid);
}
console.log('INIT OK');
