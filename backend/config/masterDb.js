/**
 * masterDb.js
 * Manages the master database that tracks all registered tenants.
 * Lives at MASTER_DB_PATH (default: /var/www/sosna-pos-tenant/master.db)
 */
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const masterDbPath = process.env.MASTER_DB_PATH
  || path.join(__dirname, '..', '..', 'master.db');

let masterDb = null;
try {
  const dir = path.dirname(masterDbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  masterDb = new Database(masterDbPath);
  masterDb.pragma('journal_mode = WAL');
  masterDb.pragma('foreign_keys = ON');

  // ── Schema ──────────────────────────────────────────────────────────────────
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT UNIQUE NOT NULL,
      business_name TEXT NOT NULL,
      email         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT UNIQUE NOT NULL,
      max_branches  INTEGER NOT NULL DEFAULT 1,
      expires_at    TEXT NOT NULL,
      notes         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      tenant_email  TEXT,
      tenant_id     TEXT,
      activated_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS branches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      branch_id   TEXT NOT NULL UNIQUE,
      branch_name TEXT NOT NULL,
      slug        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Phase C: cross-branch stock transfers ───────────────────────────
    -- Lives in master.db (not in per-branch DBs) so source and destination
    -- both read/write the same row without cross-DB queries. The items
    -- payload is a JSON array on the row itself:
    --   [{ product_sync_id, product_name, unit, quantity, cost_price }, ...]
    -- status state machine:
    --   PENDING   — source created + decremented its stock; in transit
    --   RECEIVED  — destination confirmed + incremented its stock
    --   CANCELLED — source aborted before destination received
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT NOT NULL UNIQUE,
      sync_id         TEXT NOT NULL UNIQUE,
      from_slug       TEXT NOT NULL,
      from_name       TEXT,
      to_slug         TEXT NOT NULL,
      to_name         TEXT,
      items_json      TEXT NOT NULL,
      total_items     INTEGER NOT NULL DEFAULT 0,
      total_value     REAL NOT NULL DEFAULT 0,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'PENDING',
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      received_by     INTEGER,
      received_by_name TEXT,
      received_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_to_status   ON stock_transfers (to_slug, status);
    CREATE INDEX IF NOT EXISTS idx_transfers_from_status ON stock_transfers (from_slug, status);
  `);

  console.log('[master] Master DB ready:', masterDbPath);
} catch (e) {
  console.warn('[master] Could not open master DB (Electron mode — VPS-only features disabled):', e.message);
  masterDb = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRegistered(slug) {
  if (!masterDb) return false;
  const row = masterDb.prepare('SELECT id FROM tenants WHERE slug = ? AND is_active = 1').get(slug);
  return !!row;
}

function getTenant(slug) {
  if (!masterDb) return null;
  return masterDb.prepare('SELECT * FROM tenants WHERE slug = ? AND is_active = 1').get(slug);
}

function registerTenant(slug, businessName, email) {
  if (!masterDb) return;
  masterDb.prepare('INSERT INTO tenants (slug, business_name, email) VALUES (?, ?, ?)').run(slug, businessName, email || null);
}

function listTenants() {
  if (!masterDb) return [];
  return masterDb.prepare(`
    SELECT t.*, b.tenant_id
    FROM tenants t
    LEFT JOIN branches b ON b.slug = t.slug
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `).all();
}

function deactivateTenant(slug) {
  if (!masterDb) return;
  masterDb.prepare('UPDATE tenants SET is_active = 0 WHERE slug = ?').run(slug);
}

// ── License helpers ───────────────────────────────────────────────────────────

function getLicense(key) {
  if (!masterDb) return null;
  return masterDb.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
}

function createLicense(key, maxBranches, expiresAt, notes) {
  if (!masterDb) return;
  masterDb.prepare('INSERT INTO licenses (key, max_branches, expires_at, notes) VALUES (?, ?, ?, ?)').run(key, maxBranches, expiresAt, notes || null);
}

function activateLicense(key, email, tenantId) {
  if (!masterDb) return;
  masterDb.prepare("UPDATE licenses SET tenant_email = ?, tenant_id = ?, activated_at = datetime('now') WHERE key = ?").run(email, tenantId, key);
}

function updateLicense(key, fields) {
  if (!masterDb) return;
  const { expiresAt, isActive, maxBranches, notes } = fields;
  masterDb.prepare(`
    UPDATE licenses SET
      expires_at   = COALESCE(?, expires_at),
      is_active    = COALESCE(?, is_active),
      max_branches = COALESCE(?, max_branches),
      notes        = COALESCE(?, notes)
    WHERE key = ?
  `).run(expiresAt ?? null, isActive ?? null, maxBranches ?? null, notes ?? null, key);
}

function listLicenses() {
  if (!masterDb) return [];
  const licenses = masterDb.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
  return licenses.map(l => {
    const branches = l.tenant_id
      ? masterDb.prepare('SELECT * FROM branches WHERE tenant_id = ?').all(l.tenant_id)
      : [];
    const slug = branches.length ? branches[0].slug : null;
    return {
      ...l,
      branch_count: branches.length,
      branch_codes: branches.map(b => `${b.branch_name} [${b.branch_id.replace(/-/g,'').substring(0,8).toUpperCase()}]`).join(', ') || null,
      slug,
    };
  });
}

function getLicenseStats() {
  if (!masterDb) return { total: 0, active: 0, expired: 0, expiring: 0 };
  const now  = new Date().toISOString();
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  return {
    total:    masterDb.prepare('SELECT COUNT(*) AS n FROM licenses').get().n,
    active:   masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE is_active=1 AND expires_at > ?").get(now).n,
    expired:  masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE expires_at <= ?").get(now).n,
    expiring: masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE is_active=1 AND expires_at > ? AND expires_at <= ?").get(now, soon).n,
  };
}

// ── Branch helpers ────────────────────────────────────────────────────────────

function registerBranch(tenantId, branchId, branchName, slug) {
  if (!masterDb) return;
  try {
    masterDb.prepare('INSERT OR IGNORE INTO branches (tenant_id, branch_id, branch_name, slug) VALUES (?, ?, ?, ?)').run(tenantId, branchId, branchName, slug || null);
  } catch (_) {}
}

function getBranchesForTenant(tenantId) {
  if (!masterDb) return [];
  return masterDb.prepare('SELECT * FROM branches WHERE tenant_id = ?').all(tenantId);
}

module.exports = {
  isRegistered, getTenant, registerTenant, listTenants, deactivateTenant,
  getLicense, createLicense, activateLicense, updateLicense, listLicenses, getLicenseStats,
  registerBranch, getBranchesForTenant,
  masterDb,
  // Re-export the masterDb instance under a more obvious name for the
  // transfer routes, which need to read/write the stock_transfers table
  // directly without going through per-tenant routing.
  getMasterDb: () => masterDb,
};
