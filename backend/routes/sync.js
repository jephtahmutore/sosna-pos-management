const router = require('express').Router();
const https = require('https');
const http = require('http');
const { URL } = require('url');
const db = require('../config/database');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt');
const { auth } = require('../middleware/auth');
const { getLicense, activateLicense, registerBranch, getTenant } = require('../config/masterDb');
const masterDb = require('../config/masterDb').masterDb;

// Central admin lives on Butchery's VPS — it owns the CB- prefix license
// pool for bespoke deployments. Overridable via env for local dev.
const CB_ACTIVATE_URL = process.env.CB_ACTIVATE_URL
  || 'https://sidanitsolutions.com/admin/clientbased/activate';

// Minimal POST helper using node's built-in https — no axios pull-in
// just for one call on the activation path. 15s ceiling so a hung
// central admin can't block the Cloud Sync Setup form forever.
function postJSON(urlString, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlString); }
    catch (e) { return reject(new Error('Invalid CB_ACTIVATE_URL')); }
    const data = JSON.stringify(body);
    const client = u.protocol === 'http:' ? http : https;
    const req = client.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// For CB- prefix keys (Client Based), validate against the central admin
// at sidanitsolutions.com and cache the result in our own master.db's
// licenses table. After the first successful activation, subsequent
// branches activate offline against the cache — phone-home happens once.
//
// Returns { ok, license? , error? } where `license` matches the shape of
// getLicense() so the rest of register-branch can treat it the same as a
// natively-issued key.
async function ensureCbLicenseCached(licenseKey, slug, businessName, email) {
  const key = licenseKey.trim().toUpperCase();

  // Cache hit — skip the network call entirely.
  const cached = getLicense(key);
  if (cached) return { ok: true, license: cached };

  // Cache miss — phone home.
  let resp;
  try {
    resp = await postJSON(CB_ACTIVATE_URL, {
      key, slug, businessName, email,
    });
  } catch (e) {
    return { ok: false, error: `Could not reach central admin (${e.message}). Check the VPS internet connection.` };
  }

  if (resp.status < 200 || resp.status >= 300) {
    const msg = (resp.body && resp.body.error) || `Central admin returned HTTP ${resp.status}`;
    return { ok: false, error: msg };
  }

  const { tenant_id, expires_at, max_branches } = resp.body || {};
  if (!tenant_id || !expires_at) {
    return { ok: false, error: 'Central admin response missing tenant_id or expires_at.' };
  }

  // Cache the license info in Sosna's own master.db so register-branch
  // can run its existing logic unchanged from this point on. tenant_email
  // doubles as a "claimed by" marker — set to the slug so the existing
  // line-67 check ("This license key is already registered to a different
  // account") works correctly for retries.
  try {
    masterDb.prepare(
      `INSERT INTO licenses (key, max_branches, expires_at, notes, tenant_email, tenant_id, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(key, max_branches || 1, expires_at, 'Client Based — issued by central admin', slug, tenant_id);
  } catch (e) {
    // Likely a UNIQUE constraint race; try to re-read.
    const again = getLicense(key);
    if (again) return { ok: true, license: again };
    return { ok: false, error: `Failed to cache license: ${e.message}` };
  }

  return { ok: true, license: getLicense(key) };
}

// All tables that participate in sync
const SYNC_TABLES = [
  'users', 'categories', 'main_categories', 'units', 'products', 'customers', 'suppliers',
  'orders', 'order_items', 'grn', 'grn_items', 'siv', 'siv_items',
  'production', 'production_inputs', 'production_outputs',
  'sales_returns', 'sales_return_items',
  'stock_movements', 'cash_receipts', 'payment_vouchers', 'cash_book',
  'business_settings', 'cash_reports', 'stock_adjustments', 'daily_actual_balance',
  'ap_payments', 'daily_profit_summary',
  // Sosna-specific tables added during the credit-sales / reconciliation rework
  'customer_payments', 'stock_reconciliations', 'stock_reconciliation_items',
  'daily_cost_snapshot', 'pv_types',
  // Supplier Credit Notes (Discount / Crate Return / Bottle Return / Other) —
  // reduce AP balance, and 'Discount'/'Other' rebates feed the Profit Report.
  'supplier_credit_notes', 'supplier_credit_note_items',
  // Owner equity ledgers — flow through Cash Book but excluded from Profit Report.
  'capital_account', 'dividend_account',
  // Shareholders + Loans liability ledger — sync IDs link entries cross-device.
  'shareholders', 'loans', 'loan_transactions',
  // Cash transfers between methods (Cash ↔ Bank ↔ MoMo) — must sync or the
  // per-method Cash Book cards diverge across PCs even though totals match.
  'cash_transfers',
  // Stock count audit trail — sessions + per-item counts. The resulting
  // stock_adjustments already sync; this adds the "who counted what" record.
  'stock_count_sessions', 'stock_count_items',
  // Discount approval requests — pending/approved/rejected rows so an admin
  // approving on one device propagates to the requesting cashier's device.
  'discount_requests',
  // Phase 1 multi-currency (Sosna only — Branch 1/2 K-only, Branch 3 USD/FRA).
  // Both tables must sync so per-branch prices + FX rates stay consistent
  // across devices. KEEP IN SYNC with syncService.js.
  'branches', 'product_branch_prices',
  // v1.8.33 — KEEP IN SYNC with syncService.js. Missing both of these
  // before release would have meant: drawer currency exchanges done on
  // one device never reach the others (cash report Expected drifts);
  // FX rate changes never propagate (cashier rings up at stale rate).
  'currency_exchanges', 'fx_rates',
];

// ─── POST /api/sync/register ─────────────────────────────────────────────────
// Called by a new device to get/create a tenant + branch
// Requires: branchName + licenseKey. Subdomain must be pre-registered by admin.
router.post('/register', async (req, res) => {
  try {
    const { branchName, licenseKey } = req.body;
    if (!branchName || !licenseKey) {
      return res.status(400).json({ error: 'branchName and licenseKey are required' });
    }

    // ── Check subdomain is pre-registered by admin ────────────────────────
    const slug = (req.headers['x-tenant'] || req.hostname || '').toLowerCase().split('.')[0];
    const tenant = getTenant(slug);
    if (!tenant) {
      return res.status(403).json({ error: 'Subdomain not registered. Please contact SIDAN IT & Business Solutions.' });
    }

    // ── Resolve license: CB- keys go through central admin first ──────────
    // Client Based keys (CB- prefix) are owned by the central admin at
    // sidanitsolutions.com. First time we see one, phone home to validate
    // and cache the result in our own master.db. Locally-issued keys
    // (SOSNA- etc.) skip this and go straight to the existing local
    // master.db lookup below.
    const key = licenseKey.trim().toUpperCase();
    if (key.startsWith('CB-')) {
      const cb = await ensureCbLicenseCached(key, slug, tenant.business_name, tenant.email);
      if (!cb.ok) return res.status(403).json({ error: cb.error });
    }

    // ── Validate license from master.db ───────────────────────────────────
    const license = getLicense(licenseKey.trim().toUpperCase());
    if (!license)           return res.status(403).json({ error: 'Invalid license key.' });
    if (!license.is_active) return res.status(403).json({ error: 'This license has been deactivated.' });
    if (license.expires_at < new Date().toISOString())
      return res.status(403).json({ error: 'This license has expired.' });
    if (license.tenant_email && license.tenant_email !== tenant.email && license.tenant_email !== slug)
      return res.status(403).json({ error: 'This license key is already registered to a different account.' });

    // ── Find or create tenant entry in sync_config (keyed by slug) ────────
    let tenantRow = db.prepare('SELECT * FROM sync_config WHERE key = ?').get(`tenant:${slug}`);
    let tenantId;
    if (tenantRow) {
      tenantId = tenantRow.value;
    } else {
      tenantId = randomUUID();
      db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(`tenant:${slug}`, tenantId);
    }

    // ── Check branch limit ────────────────────────────────────────────────
    const branchCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM sync_config WHERE key LIKE ?"
    ).get(`branch:${tenantId}:%`);
    if (branchCount.cnt >= license.max_branches) {
      return res.status(403).json({
        error: `Branch limit reached. Your license allows ${license.max_branches} branch(es). Contact SIDAN IT & Business Solutions to upgrade.`
      });
    }

    // ── Create branch ─────────────────────────────────────────────────────
    const branchId = randomUUID();
    db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(
      `branch:${tenantId}:${branchId}`, branchName
    );
    registerBranch(tenantId, branchId, branchName, slug);

    // ── Activate license in master.db (stamp email + tenantId on first use)
    if (!license.tenant_email) {
      activateLicense(licenseKey.trim().toUpperCase(), tenant.email || slug, tenantId);
    }

    res.json({ tenantId, branchId, expiresAt: license.expires_at });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/license-status ────────────────────────────────────────────
// Device checks if its license is still valid (called on startup + every 24h)
router.get('/license-status', (req, res) => {
  try {
    const { tenantId } = req.query;
    if (!tenantId || tenantId === 'local-only') {
      return res.json({ valid: true, localOnly: true });
    }

    // Find the license associated with this tenant (from master.db)
    const license = masterDb.prepare('SELECT * FROM licenses WHERE tenant_id = ?').get(tenantId);
    if (!license) return res.json({ valid: false, reason: 'License not found' });
    if (!license.is_active) return res.json({ valid: false, reason: 'License deactivated' });

    const now = new Date();
    const expiry = new Date(license.expires_at);
    const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

    res.json({
      valid:         daysRemaining > 0,
      isExpired:     daysRemaining <= 0,
      daysRemaining: Math.max(0, daysRemaining),
      expiresAt:     license.expires_at,
      reason:        daysRemaining <= 0 ? 'License expired' : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/identity ───────────────────────────────────────────────────
// Returns business email, branch name, license info for a registered device
// Query: ?tenantId=...&branchId=...
router.get('/identity', (req, res) => {
  try {
    const { tenantId, branchId } = req.query;
    if (!tenantId || !branchId) {
      return res.status(400).json({ error: 'tenantId and branchId are required' });
    }

    // Find slug by tenantId, then get email from master.db
    const tenantRow = db.prepare(
      "SELECT key FROM sync_config WHERE key LIKE 'tenant:%' AND value = ?"
    ).get(tenantId);
    const slug = tenantRow ? tenantRow.key.replace('tenant:', '') : null;
    const tenantInfo = slug ? masterDb.prepare('SELECT email FROM tenants WHERE slug = ?').get(slug) : null;
    const email = tenantInfo?.email ?? slug;

    // Find branch name
    const branchRow = db.prepare(
      'SELECT value FROM sync_config WHERE key = ?'
    ).get(`branch:${tenantId}:${branchId}`);
    const branchName = branchRow ? branchRow.value : null;

    // Find license info from master.db
    const license = masterDb.prepare(
      'SELECT expires_at, is_active, max_branches FROM licenses WHERE tenant_id = ?'
    ).get(tenantId);

    const now = new Date();
    const expiry = license ? new Date(license.expires_at) : null;
    const daysRemaining = expiry ? Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)) : null;

    res.json({
      email,
      branchName,
      expiresAt:     license ? license.expires_at : null,
      daysRemaining: daysRemaining !== null ? Math.max(0, daysRemaining) : null,
      isExpired:     daysRemaining !== null ? daysRemaining <= 0 : false,
      maxBranches:   license ? license.max_branches : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/sync/join-branch ──────────────────────────────────────────────
// Called by a new PC joining an EXISTING branch (no new branch created)
// Body: { branchCode, licenseKey }
router.post('/join-branch', (req, res) => {
  try {
    const { branchCode, licenseKey } = req.body;
    if (!branchCode || !licenseKey) {
      return res.status(400).json({ error: 'branchCode and licenseKey are required' });
    }

    // ── Find branch by code (first 8 chars of branchId, uppercase) ────────
    const branchRows = masterDb.prepare('SELECT * FROM branches').all();

    let foundTenantId = null;
    let foundBranchId = null;

    for (const row of branchRows) {
      const bid  = row.branch_id;
      const code = bid.replace(/-/g, '').substring(0, 8).toUpperCase();
      if (code === branchCode.trim().toUpperCase()) {
        foundTenantId = row.tenant_id;
        foundBranchId = bid;
        break;
      }
    }

    if (!foundTenantId) {
      return res.status(404).json({ error: 'Branch not found. Please check your Branch Code.' });
    }

    // ── Verify license belongs to this tenant ─────────────────────────────
    const license = masterDb.prepare('SELECT * FROM licenses WHERE key = ?').get(licenseKey.trim().toUpperCase());
    if (!license)           return res.status(403).json({ error: 'Invalid license key.' });
    if (!license.is_active) return res.status(403).json({ error: 'This license has been deactivated.' });
    if (license.expires_at < new Date().toISOString()) {
      return res.status(403).json({ error: 'This license has expired.' });
    }
    if (license.tenant_id !== foundTenantId) {
      return res.status(403).json({ error: 'This license key does not belong to that branch.' });
    }

    // ── Return existing IDs — no new branch created ───────────────────────
    res.json({ tenantId: foundTenantId, branchId: foundBranchId, expiresAt: license.expires_at });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// In-memory tracker of child PCs that have recently synced to this Mother.
// Key: deviceId  →  { ip, lastSeenAt, lastEndpoint }
// Cleared on backend restart (which is fine — children re-register on next sync tick).
const childActivity = new Map();

// LAN gate: when this PC is configured as Mother, any incoming /push or /pull
// from another PC on the LAN must include the matching X-Lan-Sync-Key header.
// VPS-deployed code: lan_role is empty/null → behaves as today (no header check).
function lanGate(req, res, next) {
  try {
    const lan = syncConfig.getLanConfig();
    if (lan.role !== 'mother' || !lan.lanSyncKey) return next(); // not a Mother PC → passthrough
    const provided = req.headers['x-lan-sync-key'];
    // If a child PC on the LAN is talking to us, require matching key.
    // We only enforce when the request is NOT from localhost (Mother itself or VPS).
    const remote = (req.ip || '').replace('::ffff:', '');
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === 'localhost';
    if (isLocal) return next();
    if (!provided || provided !== lan.lanSyncKey) {
      return res.status(401).json({ error: 'Invalid or missing LAN sync key.' });
    }
    // Track child activity (deviceId from body for push, from query for pull)
    const deviceId = (req.body && req.body.deviceId) || req.query.deviceId || null;
    if (deviceId) {
      childActivity.set(deviceId, {
        ip: remote,
        lastSeenAt: new Date().toISOString(),
        lastEndpoint: req.path,
      });
    }
    next();
  } catch { next(); }
}

// ─── POST /api/sync/push ──────────────────────────────────────────────────────
// Device pushes local unsynced records to server.
// Body: { tenantId, branchId, deviceId, records: { tableName: [...rows] } }
// BATCHED: writes happen in chunks of 200 with event-loop yields between them so
// the receiving server (Mother/VPS) stays responsive to other clients during
// large incoming pushes.
router.post('/push', lanGate, async (req, res) => {
  try {
    const { tenantId, branchId, deviceId, records } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const conflicts = [];
    const BATCH_SIZE = 200;

    const processBatch = (table, cols, batch) => {
      const hasSyncId = cols.includes('sync_id');
      const hasUpdatedAt = cols.includes('updated_at');
      if (!hasSyncId) return;
      db.transaction(() => {
        for (const row of batch) {
          if (!row.sync_id) continue;
          const existing = db.prepare(`SELECT * FROM ${table} WHERE sync_id = ?`).get(row.sync_id);
          if (!existing) {
            const insertCols = cols.filter(c => c !== 'id' && row[c] !== undefined);
            const placeholders = insertCols.map(() => '?').join(', ');
            const values = insertCols.map(c => row[c]);
            db.prepare(
              `INSERT OR IGNORE INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders})`
            ).run(...values);
            if (hasUpdatedAt) {
              db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE sync_id = ?`).run(row.sync_id);
            }
          } else {
            const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
            const setClause = updateCols.map(c => `${c} = ?`).join(', ');
            const values = [...updateCols.map(c => row[c]), row.sync_id];
            db.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(...values);
            if (hasUpdatedAt) {
              db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE sync_id = ?`).run(row.sync_id);
            }
          }
        }
      })();
    };

    db.pragma('foreign_keys = OFF');
    try {
      for (const [table, rows] of Object.entries(records || {})) {
        if (!SYNC_TABLES.includes(table)) continue;
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          processBatch(table, cols, rows.slice(i, i + BATCH_SIZE));
          // Yield event loop so other API requests can be served
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }

    res.json({ success: true, conflicts });
  } catch (error) {
    db.pragma('foreign_keys = ON');
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/pull ───────────────────────────────────────────────────────
// Device pulls records updated on VPS since last pull.
// If deviceId is provided, records that originated from this same device are
// excluded — this prevents the "echo" loop where a device pulls back its own
// pushed records (Mother re-stamps updated_at on push, which otherwise causes
// the record to match the next pull's time filter).
// Query: ?tenantId=T1&since=2024-01-01T00:00:00.000Z&deviceId=<requester-uuid>
router.get('/pull', lanGate, async (req, res) => {
  try {
    const { tenantId, since, deviceId } = req.query;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const sinceTs = since || '1970-01-01T00:00:00.000Z';
    const isInitialPull = sinceTs === '1970-01-01T00:00:00.000Z';
    // Normalize to SQLite space format: '2026-03-06T14:50:22.739Z' → '2026-03-06 14:50:22'
    const sinceSQLite = sinceTs.replace('T', ' ').replace('Z', '').substring(0, 19);
    const result = {};

    for (const table of SYNC_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      const hasTenantId = cols.includes('tenant_id');
      const hasUpdatedAt = cols.includes('updated_at');
      const hasCreatedAt = cols.includes('created_at');
      const hasDeviceId  = cols.includes('device_id');
      if (!hasTenantId) continue;

      // Build the optional "exclude my own records" clause.
      // Two carve-outs so third-party changes still propagate to the original
      // creator (otherwise ghost rows, stale totals, etc.):
      //   1. Soft-deleted rows always come through (delete by anyone must reach
      //      the creator).
      //   2. Rows whose updated_at > created_at have been touched after their
      //      original insert — let them through too so third-party edits land
      //      on the original creator's copy. The minor cost is an idempotent
      //      echo when the creator edits their own row (incoming values
      //      already match locally, so the UPDATE is a no-op).
      const hasDeletedAt = cols.includes('deleted_at');
      const hasCreatedAtCol = cols.includes('created_at');
      const carveOuts = [];
      if (hasDeletedAt) carveOuts.push('deleted_at IS NOT NULL');
      if (hasCreatedAtCol) carveOuts.push('(created_at IS NOT NULL AND updated_at > created_at)');
      const carveClause = carveOuts.length ? ' OR ' + carveOuts.join(' OR ') : '';
      const excludeMine = (deviceId && hasDeviceId)
        ? ` AND (device_id IS NULL OR device_id != ?${carveClause})`
        : '';
      const extraParams = (deviceId && hasDeviceId) ? [deviceId] : [];

      let rows;
      if (isInitialPull) {
        // First sync — return everything for this tenant regardless of timestamps
        rows = db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ?${excludeMine}`).all(tenantId, ...extraParams);
      } else if (hasUpdatedAt) {
        const timeCol = hasCreatedAt ? 'COALESCE(updated_at, created_at)' : 'updated_at';
        rows = db.prepare(
          `SELECT * FROM ${table} WHERE tenant_id = ? AND ${timeCol} >= ?${excludeMine}`
        ).all(tenantId, sinceSQLite, ...extraParams);
      } else if (hasCreatedAt) {
        rows = db.prepare(
          `SELECT * FROM ${table} WHERE tenant_id = ? AND created_at >= ?${excludeMine}`
        ).all(tenantId, sinceSQLite, ...extraParams);
      } else {
        rows = db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ?${excludeMine}`).all(tenantId, ...extraParams);
      }

      if (rows.length > 0) {
        result[table] = rows;
      }

      // Yield event loop between tables so other API requests stay responsive
      // during pulls — prevents Mother from freezing while a Child pulls.
      await new Promise(resolve => setImmediate(resolve));
    }

    res.json({ records: result, serverTime: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/current-status ────────────────────────────────────────────
// Returns live sync service state — polled by the SyncStatus UI component
router.get('/current-status', (req, res) => {
  try {
    const syncService = require('../services/syncService');
    res.json(syncService.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/status ────────────────────────────────────────────────────
// Returns current sync configuration (used by Setup screen to check registration)
router.get('/status', (req, res) => {
  try {
    const cfg = syncConfig.getConfig();
    res.json({
      isConfigured: cfg.isConfigured,
      tenantId: cfg.tenantId,
      branchId: cfg.branchId,
      deviceId: cfg.deviceId,

      lastPullTime: cfg.lastPullTime,
      vpsUrl: syncConfig.get('vps_url') || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/trial-status ──────────────────────────────────────────────
// Returns 14-day trial info for local-only (offline) users
router.get('/trial-status', (_req, res) => {
  try {
    const cfg = syncConfig.getConfig();
    // Cloud-registered tenants have a real license — trial doesn't apply
    if (cfg.tenantId && cfg.tenantId !== 'local-only') {
      return res.json({ trialApplicable: false });
    }
    const installDate = syncConfig.get('install_date');
    const TRIAL_DAYS = 14;
    if (!installDate) {
      return res.json({ trialApplicable: true, daysUsed: 0, daysRemaining: TRIAL_DAYS, isExpired: false });
    }
    const daysUsed = Math.floor((Date.now() - new Date(installDate).getTime()) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, TRIAL_DAYS - daysUsed);
    res.json({ trialApplicable: true, daysUsed, daysRemaining, isExpired: daysRemaining <= 0, installDate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/sync/reset ────────────────────────────────────────────────────
// Clears tenant_id + branch_id so the Setup screen appears on next reload
router.post('/reset', (req, res) => {
  try {
    db.prepare("DELETE FROM sync_config WHERE key IN ('tenant_id','branch_id','last_pull_time')").run();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/sync/configure ────────────────────────────────────────────────
// Save tenantId + branchId on local device after registration
router.post('/configure', (req, res) => {
  try {
    const { tenantId, branchId, vpsUrl } = req.body;
    if (!tenantId || !branchId) {
      return res.status(400).json({ error: 'tenantId and branchId are required' });
    }
    syncConfig.setRegistration(tenantId, branchId);
    if (vpsUrl) syncConfig.set('vps_url', vpsUrl);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/sync/force-resync ─────────────────────────────────────────────
// Marks all records as unsynced so they get pushed to VPS on next cycle
router.post('/force-resync', (req, res) => {
  try {
    const tables = SYNC_TABLES;
    let total = 0;
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (cols.includes('synced')) {
        const info = db.prepare(`UPDATE ${table} SET synced = 0`).run();
        total += info.changes;
      }
    }
    db.prepare("DELETE FROM sync_config WHERE key = 'last_pull_time'").run();
    res.json({ success: true, recordsMarked: total });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/sync/clear-pending ────────────────────────────────────────────
// v1.8.42 — OPPOSITE of force-resync. Flips synced=0 → synced=1 across all
// SYNC_TABLES, so the PROTECT-on-pull rule (services/syncService.js:214-216)
// stops blocking remote overwrites. Used to recover from "Electron stuck
// with stale local state because pushes failed silently" — declares the
// VPS as truth, drops any unpushed local edits.
//
// Also nukes last_pull_time so the next pull replays history from epoch
// and definitely overwrites the freshly-unblocked rows.
router.post('/clear-pending', (req, res) => {
  try {
    const result = {};
    let total = 0;
    for (const table of SYNC_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (cols.includes('synced')) {
        const info = db.prepare(`UPDATE ${table} SET synced = 1 WHERE synced = 0`).run();
        if (info.changes > 0) result[table] = info.changes;
        total += info.changes;
      }
    }
    db.prepare("DELETE FROM sync_config WHERE key = 'last_pull_time'").run();
    res.json({ success: true, recordsCleared: total, byTable: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/sync/wipe-tenant ──────────────────────────────────────────────
// Called by VPS: hard-deletes all data records for a given tenantId
router.post('/wipe-tenant', (req, res) => {
  try {
    const { tenantId } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const dataTables = [
      'order_items', 'orders',
      'grn_items', 'grn',
      'siv_items', 'siv',
      'stock_movements', 'stock_adjustments',
      'cash_receipts', 'payment_vouchers', 'cash_book', 'cash_reports',
      'daily_actual_balance', 'daily_profit_summary',
      'production_outputs', 'production_inputs', 'production',
      'sales_return_items', 'sales_returns',
      'products', 'categories',
      'customers', 'suppliers',
    ];

    for (const table of dataTables) {
      try { db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId); } catch (_) {}
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/sync/factory-reset ────────────────────────────────────────────
// Wipes all local data. includeSettings=true also clears business_settings.
router.post('/factory-reset', async (req, res) => {
  try {
    const { includeSettings } = req.body;

    // Get tenantId before clearing config, so we can wipe VPS too
    const tenantRow = db.prepare("SELECT value FROM sync_config WHERE key='tenant_id'").get();
    const tenantId = tenantRow?.value;

    const dataTables = [
      'order_items', 'orders',
      'grn_items', 'grn',
      'siv_items', 'siv',
      'stock_movements', 'stock_adjustments',
      'cash_receipts', 'payment_vouchers', 'cash_book', 'cash_reports',
      'daily_actual_balance', 'daily_profit_summary',
      'production_outputs', 'production_inputs', 'production',
      'sales_return_items', 'sales_returns',
      'products', 'categories',
      'customers', 'suppliers',
    ];

    for (const table of dataTables) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    if (includeSettings) {
      db.prepare('DELETE FROM business_settings').run();
    }

    // Always reset sync config so Setup screen appears
    db.prepare("DELETE FROM sync_config WHERE key IN ('tenant_id','branch_id','last_pull_time')").run();

    // Reset admin password back to default
    const defaultHash = await bcrypt.hash('admin123', 10);
    db.prepare("UPDATE users SET password=?, updated_at=datetime('now') WHERE email='admin'").run(defaultHash);

    // Wipe VPS data for this tenant before responding (so sync can't pull data back)
    if (tenantId && tenantId !== 'local-only') {
      try {
        await fetch('https://sosnazm.com/api/sync/wipe-tenant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantId }),
          signal: AbortSignal.timeout(8000),
        });
      } catch (_) {} // offline or VPS down — local reset still succeeds
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/lan-config ────────────────────────────────────────────────
// Returns current LAN sync configuration + this PC's LAN IPv4 address (for the
// Mother UI to show "give this IP to children").
//
// IP detection skips virtual adapters (VMware, VirtualBox, Hyper-V, WSL, VPN)
// and picks the first real LAN adapter (Ethernet/Wi-Fi).
router.get('/lan-config', (_req, res) => {
  try {
    const lan = syncConfig.getLanConfig();
    const os = require('os');
    const nets = os.networkInterfaces();

    // Pattern of interface names to ignore — these are virtual/loopback adapters
    // that won't be reachable from another physical PC on the LAN.
    const VIRTUAL_RE = /vmware|virtualbox|hyper-?v|vethernet|wsl|loopback|tunnel|vpn|tap|tailscale|zerotier|docker|npcap/i;

    const candidates = [];
    for (const [ifaceName, list] of Object.entries(nets)) {
      if (VIRTUAL_RE.test(ifaceName)) continue;
      for (const n of list || []) {
        if (n.family !== 'IPv4' || n.internal) continue;
        // Skip APIPA (link-local) addresses — means DHCP failed
        if (n.address.startsWith('169.254.')) continue;
        candidates.push({ iface: ifaceName, address: n.address });
      }
    }

    // Prefer typical home/office LAN ranges (192.168.x.x first, then 10.x.x.x, then 172.16-31.x.x)
    const score = (ip) => {
      if (ip.startsWith('192.168.')) return 0;
      if (ip.startsWith('10.'))      return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
      return 3;
    };
    candidates.sort((a, b) => score(a.address) - score(b.address));

    const localIp = candidates[0]?.address || '';
    const allLocalIps = candidates.map(c => `${c.address} (${c.iface})`);
    res.json({ ...lan, localIp, allLocalIps });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/sync/lan-status ────────────────────────────────────────────────
// Returns list of child PCs that have recently synced to this Mother.
// Children are considered "connected" if they synced in the last 5 minutes.
router.get('/lan-status', (_req, res) => {
  try {
    const lan = syncConfig.getLanConfig();
    const now = Date.now();
    const STALE_MS = 5 * 60 * 1000; // 5 minutes
    const children = [];
    for (const [deviceId, info] of childActivity.entries()) {
      const age = now - new Date(info.lastSeenAt).getTime();
      if (age > STALE_MS) continue; // skip stale
      children.push({
        deviceId,
        deviceShort: deviceId.replace(/-/g, '').substring(0, 6).toUpperCase(),
        ip: info.ip,
        lastSeenAt: info.lastSeenAt,
        secondsAgo: Math.round(age / 1000),
      });
    }
    children.sort((a, b) => a.secondsAgo - b.secondsAgo);
    res.json({ role: lan.role, isMother: lan.role === 'mother', children });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/sync/lan-config ────────────────────────────────────────────────
// Save new LAN config and tell the sync service to reload its interval.
router.put('/lan-config', (req, res) => {
  try {
    const { role, motherIp, lanSyncKey } = req.body || {};
    if (role && role !== 'mother' && role !== 'child') {
      return res.status(400).json({ error: "role must be 'mother' or 'child'" });
    }
    syncConfig.setLanConfig({ role, motherIp, lanSyncKey });
    try { require('../services/syncService').reload(); } catch (_) { /* not started yet */ }
    res.json({ success: true, ...syncConfig.getLanConfig() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
