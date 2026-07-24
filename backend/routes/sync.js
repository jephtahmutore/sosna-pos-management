const router = require('express').Router();
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../config/database');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt');
const { auth } = require('../middleware/auth');
const { getLicense, activateLicense, registerBranch, getTenant } = require('../config/masterDb');
const masterDb = require('../config/masterDb').masterDb;

// v1.9.3 — slog matches the helper in services/syncService.js. The push
// timestamp-REJECT log on line ~437 was calling slog() since v1.8.91 but
// it was never defined in this file → every rejected-by-timestamp row
// crashed the whole push transaction with ReferenceError, returning 500
// to clients silently for a full week. Define it locally so the call
// works without coupling routes/sync.js to the service module.
const _slogFile = path.join(os.tmpdir(), 'sosna-startup.log');
function slog(msg) {
  try { fs.appendFileSync(_slogFile, `[${new Date().toISOString()}] [Sync.route] ${msg}\n`); } catch (e) {}
}

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
  // v1.10.247 — empty crate/bottle returns to supplier. Tables + full sync
  // columns exist since v1.1.2 but were missing from both lists. Adding
  // both sides so the round-trip closes.
  'empty_returns', 'empty_return_items',
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
            // v1.9.5 — DO NOT overwrite updated_at with datetime('now') after
            // INSERT. Previous code did so for incremental-pull bookkeeping,
            // but it broke the symmetric timestamp check used by push: after
            // server stamps the row with server-clock "now", any subsequent
            // push from the same client (whose clock is even slightly behind
            // the server) compares `incoming <= server` and gets REJECTED.
            // Real incident 2026-06-29 ORD-EFAE4A-0004/0005: reverse on
            // Electron correctly bumped updated_at to (creation + ~30s), but
            // server's stored updated_at was already (creation + processing
            // delay), so the reverse push was silently dropped and web kept
            // showing PENDING_PAYMENT. Letting the client's updated_at flow
            // through preserves the cross-client ordering the rest of the
            // sync engine assumes.
          } else {
            // v1.8.89 — TIMESTAMP CHECK (defense against stale pushes).
            // Before: server accepted any pushed row unconditionally → if a
            // client pushed a stale local copy (e.g. after PROTECT rule
            // blocked a pull), the server's correct state got OVERWRITTEN
            // with old data. Real incident: ORD-0055 reversed on web at T2,
            // Electron pushed stale PENDING_PAYMENT (updated_at=T1) at T3,
            // server accepted → Reversed status destroyed.
            // Now: reject incoming rows whose updated_at < server's. Last-
            // writer-wins by wall-clock, which is the correct policy when
            // both clients have synced clocks.
            if (hasUpdatedAt && existing.updated_at && row.updated_at) {
              const parse = (s) => new Date(typeof s === 'string' && !s.includes('T') ? s.replace(' ', 'T') + 'Z' : s).getTime();
              const incomingMs = parse(row.updated_at);
              const existingMs = parse(existing.updated_at);
              // v1.8.91 — strict <= rejection. v1.8.89 used < which missed the
              // EQUAL-timestamp clobbering case: both clients hold rows updated
              // in the same earlier batch, so when one pushes, incoming == server,
              // check didn't fire, server got overwritten with stale data. Equal
              // timestamps = same data, so rejecting is always safe (no real edit
              // to lose) and closes the hole completely.
              if (isFinite(incomingMs) && isFinite(existingMs) && incomingMs <= existingMs) {
                slog(`push: REJECT [${table}] sync_id=${row.sync_id} — incoming ${row.updated_at} <= server ${existing.updated_at}`);
                continue;
              }
            }
            const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
            const setClause = updateCols.map(c => `${c} = ?`).join(', ');
            const values = [...updateCols.map(c => row[c]), row.sync_id];
            db.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(...values);
            // v1.9.5 — same as the INSERT path above: no longer overwrite
            // updated_at with datetime('now'). Client's updated_at flows
            // through unchanged so the next push's timestamp check compares
            // apples to apples. See INSERT-branch comment for the incident.
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
    // v1.9.2 — log the full stack to pm2 logs so silent push failures are
    // diagnosable. Previously the catch only returned 500 with error.message,
    // which meant the actual row + SQL that crashed never reached the server
    // log. Real incident 2026-06-29: discount_requests pushes returned 500
    // for ~20 mins and we could only see status codes in nginx, not why.
    console.error('[/api/sync/push] CRASH:', error && error.stack ? error.stack : error);
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

// ─── POST /api/sync/run-now ──────────────────────────────────────────────────
// v1.9.4 — fire a sync cycle on demand. POS Change Price flow calls this
// twice: once after creating a discount_request (so the cashier doesn't wait
// up to 30s for the next scheduled push to reach the admin), and again every
// few seconds while the cashier is waiting on the verdict (so the admin's
// approval pulls back quickly). Returns 200 with {triggered: bool} —
// triggered=false means either the sync engine isn't running (VPS mode) or
// a cycle is already in flight. Either way the call is harmless.
router.post('/run-now', (req, res) => {
  try {
    const triggered = require('../services/syncService').runNow();
    res.json({ triggered });
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
// v1.8.90 — REWRITTEN. Was: marked all local rows synced=0 → pushed them up.
// That destroyed VPS state when local was stale (ORD-0055 incident: client
// pushed stale PENDING_PAYMENT, overwrote VPS 'Reversed').
//
// Now: PULL from VPS first with PROTECT bypassed (opts.force=true), then any
// genuinely-newer local edits will still get pushed on the next normal cycle.
// Semantically this is "I trust the VPS — overwrite my local copy where they
// differ." Use this when a client is stuck on stale data.
router.post('/force-resync', async (req, res) => {
  try {
    // Step 1: Clear pull cursors so both streams replay from epoch (full history).
    // v1.10.253 — also clears the master pull cursor so master.db mirror gets
    // a fresh full pull too. Missing before, so master rows stayed stale even
    // after Force Resync — one of the audit findings behind this bump.
    db.prepare("DELETE FROM sync_config WHERE key IN ('last_pull_time', 'last_master_pull_time')").run();

    // Step 2: Pull from VPS immediately with PROTECT bypassed.
    // Loaded lazily — syncService starts on app boot and the require() chain
    // here would create a circular dep if loaded at module top.
    const syncService = require('../services/syncService');
    let pullResult;
    try {
      pullResult = await syncService.pull({ force: true });
    } catch (pullErr) {
      return res.status(500).json({ error: 'pull failed: ' + pullErr.message });
    }

    // Step 3: same for master.db mirror. Wrapped so a master pull failure
    // (e.g. slug not registered, VPS master unavailable) doesn't undo the
    // tenant re-sync that already succeeded.
    let pullMasterResult;
    try {
      pullMasterResult = await syncService.pullMaster({ force: true });
    } catch (pmErr) {
      pullMasterResult = { ok: false, error: pmErr.message };
    }

    res.json({
      success: true,
      mode: 'pull-first',
      pull: pullResult || { ok: false, reason: 'no-result' },
      pullMaster: pullMasterResult || { ok: false, reason: 'no-result' },
      message: 'Local tenant + master DBs overwritten with VPS state. Stuck rows are now unstuck.',
    });
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
    // v1.10.253 — also clear pending in the master.db mirror. Missing before,
    // so master pending rows stayed stuck forever after clear-pending. On VPS
    // masterDb is the live authoritative store — clearing there is a no-op
    // for practical purposes but harmless (rows just flip synced 0→1 in place).
    if (masterDb) {
      for (const table of MASTER_SYNC_TABLES) {
        try {
          const cols = masterDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
          if (cols.includes('synced')) {
            // SET synced=1 explicitly — the touch trigger's WHEN guard sees
            // NEW.synced != OLD.synced and skips, so this clear doesn't
            // re-flag the row via trigger.
            const info = masterDb.prepare(`UPDATE ${table} SET synced = 1 WHERE synced = 0`).run();
            if (info.changes > 0) result[`master.${table}`] = info.changes;
            total += info.changes;
          }
        } catch { /* table missing on this mirror */ }
      }
    }
    db.prepare("DELETE FROM sync_config WHERE key IN ('last_pull_time', 'last_master_pull_time')").run();
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

    // v1.10.253 — also wipe master.db rows scoped to any of this tenant's
    // slugs. Master tables use slug-based scoping (from_slug, branch_slug,
    // destination_slug), not tenant_id — so we resolve tenantId → slugs via
    // master.branches first, then delete per scope column. Missing before,
    // so master rows survived a wipe-tenant and resurrected on next pull.
    //
    // FK-safe delete order: child rows first (items / extras), then headers.
    // Wrapped in pragma foreign_keys=OFF to be extra safe against schema
    // FK definitions we may have missed.
    const masterWipeReport = { deleted: {}, skipped: [] };
    if (masterDb) {
      try {
        const slugs = masterDb.prepare(`SELECT slug FROM branches WHERE tenant_id = ?`)
          .all(tenantId).map(r => r.slug).filter(Boolean);
        if (slugs.length > 0) {
          const inList = slugs.map(() => '?').join(',');
          masterDb.pragma('foreign_keys = OFF');
          const wipe = (sql, params, label) => {
            try {
              const info = masterDb.prepare(sql).run(...params);
              if (info.changes > 0) masterWipeReport.deleted[label] = info.changes;
            } catch (e) {
              masterWipeReport.skipped.push({ label, err: e.message });
            }
          };
          // Children first
          wipe(`DELETE FROM hq_purchase_receipt_extras WHERE purchase_sync_id IN (SELECT sync_id FROM hq_purchases WHERE sync_id IN (SELECT purchase_sync_id FROM hq_purchase_items WHERE destination_slug IN (${inList})))`, slugs, 'hq_purchase_receipt_extras');
          wipe(`DELETE FROM hq_grn_items WHERE grn_sync_id IN (SELECT sync_id FROM hq_grns WHERE branch_slug IN (${inList}))`, slugs, 'hq_grn_items');
          wipe(`DELETE FROM hq_supplier_credit_note_items WHERE credit_note_sync_id IN (SELECT sync_id FROM hq_supplier_credit_notes WHERE branch_slug IN (${inList}))`, slugs, 'hq_supplier_credit_note_items');
          wipe(`DELETE FROM hq_purchase_items WHERE destination_slug IN (${inList})`, slugs, 'hq_purchase_items');
          // Headers
          wipe(`DELETE FROM hq_purchases WHERE sync_id NOT IN (SELECT DISTINCT purchase_sync_id FROM hq_purchase_items)`, [], 'hq_purchases (orphaned)');
          wipe(`DELETE FROM hq_grns WHERE branch_slug IN (${inList})`, slugs, 'hq_grns');
          wipe(`DELETE FROM hq_supplier_credit_notes WHERE branch_slug IN (${inList})`, slugs, 'hq_supplier_credit_notes');
          wipe(`DELETE FROM cash_deposits WHERE from_slug IN (${inList})`, slugs, 'cash_deposits');
          wipe(`DELETE FROM transfer_variances WHERE from_slug IN (${inList}) OR to_slug IN (${inList}) OR absorbed_by_slug IN (${inList})`, [...slugs, ...slugs, ...slugs], 'transfer_variances');
          wipe(`DELETE FROM stock_transfers WHERE from_slug IN (${inList}) OR to_slug IN (${inList})`, [...slugs, ...slugs], 'stock_transfers');
          masterDb.pragma('foreign_keys = ON');
        }
      } catch (masterErr) {
        try { masterDb.pragma('foreign_keys = ON'); } catch (_) {}
        console.warn('[wipe-tenant] master.db cleanup error:', masterErr.message);
        masterWipeReport.skipped.push({ label: 'catch-all', err: masterErr.message });
      }
    }

    res.json({ success: true, masterWipe: masterWipeReport });
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

// ═══ v1.10.248 — master.db sync bridge ═══════════════════════════════════════
//
// Per-tenant sync (above) covers the branch's tenant.db. But 9 tables live in
// master.db instead (cross-branch cash deposits, transfers, HQ purchases,
// HQ GRNs, HQ CNs), and an Electron branch has no local master.db — those
// tables were invisible until now. These endpoints ferry rows between a
// branch's mirror-of-master.db and the VPS's real master.db.
//
// Design:
//   * Slug is authoritative — branch identifies itself as `?slug=lusaka1` etc.
//   * Filter per table is fixed (see MASTER_TABLE_FILTERS) so each branch
//     only sees rows in its scope: its own deposits, transfers touching it,
//     purchases dropped to it, GRNs generated against it, CNs it created.
//   * Row-level triggers on master.db (see masterDb.js MASTER_SYNC_TABLES
//     block) auto-stamp synced=0 + updated_at=now on every write, so no route
//     file has to remember the toggle.
//   * Push accepts INSERT OR UPDATE by sync_id AND validates the scope
//     column matches the caller's slug — prevents one branch from writing
//     into another branch's scope even if a client bug tries.
//   * Pull returns rows WHERE updated_at > :since (initial pull with no
//     `since` returns everything, same shape as per-tenant /pull).
//   * VPS wins conflict rule: incoming pushes overwrite VPS unconditionally
//     when scope matches — Electron branches don't do timestamp-based
//     resolution because master.db is the source of truth on VPS.

const MASTER_SYNC_TABLES = [
  'cash_deposits',
  'stock_transfers',
  'transfer_variances',
  'hq_purchases',
  'hq_purchase_items',
  // v1.10.249 — off-PO items branch received when supplier delivered extras.
  // Branch writes on receipt confirm → HQ reads when generating GRN. Missed
  // from v1.10.248 first pass; without this, Electron-branch extras never
  // reach VPS and disappear from the GRN.
  'hq_purchase_receipt_extras',
  'hq_grns',
  'hq_grn_items',
  'hq_supplier_credit_notes',
  'hq_supplier_credit_note_items',
];

// Per-table scope filter. `where` clause + params-from-slug factory.
// `scopeCheck(row, slug)` guards push — returns true iff the row's scope
// column matches the caller's slug (or is a child of a scoped parent).
// Parent-child tables (grn_items, cn_items, purchase items header→items)
// scope via their parent's sync_id; we validate by looking up the parent
// on the server, so a branch can't push a grn_item claiming a foreign
// grn_sync_id.
const MASTER_TABLE_FILTERS = {
  cash_deposits: {
    where:      'from_slug = ?',
    params:     (s) => [s],
    scopeCheck: (row, slug) => row.from_slug === slug,
  },
  stock_transfers: {
    where:      '(from_slug = ? OR to_slug = ?)',
    params:     (s) => [s, s],
    scopeCheck: (row, slug) => row.from_slug === slug || row.to_slug === slug,
  },
  transfer_variances: {
    where:      '(from_slug = ? OR to_slug = ? OR absorbed_by_slug = ?)',
    params:     (s) => [s, s, s],
    scopeCheck: (row, slug) => row.from_slug === slug || row.to_slug === slug || row.absorbed_by_slug === slug,
  },
  hq_purchases: {
    where:      'sync_id IN (SELECT purchase_sync_id FROM hq_purchase_items WHERE destination_slug = ?)',
    params:     (s) => [s],
    // Branches don't create hq_purchases (HQ-owned). Reject any push to this
    // table by requiring an existing row in scope — if the branch is only
    // ever updating (which it does via /receive path via hqPurchaseItems),
    // it's the items that get pushed, not the header.
    scopeCheck: (row, slug) => {
      if (!masterDb) return false;
      const has = masterDb.prepare(
        `SELECT 1 FROM hq_purchase_items WHERE purchase_sync_id = ? AND destination_slug = ? LIMIT 1`
      ).get(row.sync_id, slug);
      return !!has;
    },
  },
  hq_purchase_items: {
    where:      'destination_slug = ?',
    params:     (s) => [s],
    scopeCheck: (row, slug) => row.destination_slug === slug,
  },
  hq_purchase_receipt_extras: {
    where:      'purchase_sync_id IN (SELECT DISTINCT purchase_sync_id FROM hq_purchase_items WHERE destination_slug = ?)',
    params:     (s) => [s],
    scopeCheck: (row, slug) => {
      if (!masterDb) return false;
      const parent = masterDb.prepare(
        `SELECT 1 FROM hq_purchase_items WHERE purchase_sync_id = ? AND destination_slug = ? LIMIT 1`
      ).get(row.purchase_sync_id, slug);
      return !!parent;
    },
  },
  hq_grns: {
    where:      'branch_slug = ?',
    params:     (s) => [s],
    scopeCheck: (row, slug) => row.branch_slug === slug,
  },
  hq_grn_items: {
    where:      'grn_sync_id IN (SELECT sync_id FROM hq_grns WHERE branch_slug = ?)',
    params:     (s) => [s],
    scopeCheck: (row, slug) => {
      if (!masterDb) return false;
      const parent = masterDb.prepare(
        `SELECT branch_slug FROM hq_grns WHERE sync_id = ?`
      ).get(row.grn_sync_id);
      return parent && parent.branch_slug === slug;
    },
  },
  hq_supplier_credit_notes: {
    where:      'branch_slug = ?',
    params:     (s) => [s],
    scopeCheck: (row, slug) => row.branch_slug === slug,
  },
  hq_supplier_credit_note_items: {
    where:      'credit_note_sync_id IN (SELECT sync_id FROM hq_supplier_credit_notes WHERE branch_slug = ?)',
    params:     (s) => [s],
    scopeCheck: (row, slug) => {
      if (!masterDb) return false;
      const parent = masterDb.prepare(
        `SELECT branch_slug FROM hq_supplier_credit_notes WHERE sync_id = ?`
      ).get(row.credit_note_sync_id);
      return parent && parent.branch_slug === slug;
    },
  },
};

// GET /api/sync/master/slug?branchId=<uuid>
// Electron doesn't know its own slug (per-tenant sync stores tenantId +
// branchId only). This one-time lookup lets the client cache slug in
// sync_config, then every master push/pull sends it in the URL.
router.get('/master/slug', (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable on this server' });
    const { branchId } = req.query;
    if (!branchId) return res.status(400).json({ error: 'branchId is required' });
    const row = masterDb.prepare(
      `SELECT slug FROM branches WHERE branch_id = ? LIMIT 1`
    ).get(branchId);
    if (!row || !row.slug) return res.status(404).json({ error: 'No slug registered for this branchId' });
    res.json({ slug: row.slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sync/master/pull?slug=<slug>&since=<iso>
// Returns master.db rows in this slug's scope updated since `since`.
// Missing `since` = initial pull (full scope dump). NULL updated_at rows
// always come through on initial pull; on incremental they're filtered
// out (the sync trigger touches them on next write).
router.get('/master/pull', lanGate, async (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable on this server' });
    const { slug, since } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const sinceTs = since || '1970-01-01T00:00:00.000Z';
    const isInitialPull = sinceTs === '1970-01-01T00:00:00.000Z';
    const sinceSQLite = sinceTs.replace('T', ' ').replace('Z', '').substring(0, 19);

    const records = {};
    for (const table of MASTER_SYNC_TABLES) {
      const filter = MASTER_TABLE_FILTERS[table];
      if (!filter) continue;
      try {
        const cols = masterDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!cols.includes('sync_id')) continue;

        const scopeParams = filter.params(slug);
        let sql;
        let params;
        if (isInitialPull) {
          sql = `SELECT * FROM ${table} WHERE ${filter.where}`;
          params = scopeParams;
        } else {
          // Include NULL updated_at rows only on initial pull; otherwise the
          // trigger will flip them on next write and they'll flow through.
          sql = `SELECT * FROM ${table} WHERE ${filter.where} AND updated_at IS NOT NULL AND updated_at >= ?`;
          params = [...scopeParams, sinceSQLite];
        }
        const rows = masterDb.prepare(sql).all(...params);
        if (rows.length > 0) records[table] = rows;
      } catch (e) {
        slog(`master/pull: [${table}] ${e.message}`);
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    res.json({ records, serverTime: new Date().toISOString() });
  } catch (error) {
    console.error('[/api/sync/master/pull] CRASH:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sync/master/push { slug, deviceId, records: { table: [rows] } }
// Applies each row to VPS master.db by sync_id. Scope-guarded per table —
// a row whose scope column doesn't match the caller's slug is rejected
// silently (logged, not returned as an error, so one bad row doesn't
// block the whole batch).
router.post('/master/push', lanGate, async (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable on this server' });
    const { slug, records } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const rejected = [];
    const BATCH_SIZE = 200;

    const processBatch = (table, cols, batch) => {
      const filter = MASTER_TABLE_FILTERS[table];
      if (!filter) return;
      const hasSyncId = cols.includes('sync_id');
      if (!hasSyncId) return;

      masterDb.transaction(() => {
        for (const row of batch) {
          if (!row.sync_id) continue;
          if (!filter.scopeCheck(row, slug)) {
            rejected.push({ table, sync_id: row.sync_id, reason: 'scope-mismatch' });
            slog(`master/push: REJECT [${table}] sync_id=${row.sync_id} — scope-mismatch for slug=${slug}`);
            continue;
          }

          const existing = masterDb.prepare(
            `SELECT id, updated_at FROM ${table} WHERE sync_id = ?`
          ).get(row.sync_id);

          if (!existing) {
            const insertCols = cols.filter(c => c !== 'id' && row[c] !== undefined);
            const placeholders = insertCols.map(() => '?').join(', ');
            const values = insertCols.map(c => row[c]);
            try {
              masterDb.prepare(
                `INSERT OR IGNORE INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders})`
              ).run(...values);
              // Mark synced=1 so trigger's post-insert stamp (if it fired
              // because updated_at was NULL in incoming row) still leaves
              // the row in the correct state.
              masterDb.prepare(`UPDATE ${table} SET synced = 1 WHERE sync_id = ?`).run(row.sync_id);
            } catch (e) {
              rejected.push({ table, sync_id: row.sync_id, reason: e.message });
              slog(`master/push: INSERT ERR [${table}] sync_id=${row.sync_id}: ${e.message}`);
            }
          } else {
            // v1.10.253 — TIMESTAMP CHECK (mirrors per-tenant push at :464,
            // v1.8.91). Reject incoming rows whose updated_at <= server's,
            // so an offline / clock-behind device can't silently clobber a
            // more-recent VPS edit. Equal ts also rejected — same-data
            // pushes are safe to drop and it closes the sibling clobber
            // hole. When `existing.updated_at` is NULL (legacy pre-v1.10.248
            // row that was never touched by trigger yet), no check runs and
            // incoming wins — which is what we want.
            if (existing.updated_at && row.updated_at) {
              const parse = (s) => new Date(typeof s === 'string' && !s.includes('T') ? s.replace(' ', 'T') + 'Z' : s).getTime();
              const incomingMs = parse(row.updated_at);
              const existingMs = parse(existing.updated_at);
              if (isFinite(incomingMs) && isFinite(existingMs) && incomingMs <= existingMs) {
                rejected.push({ table, sync_id: row.sync_id, reason: 'stale-timestamp' });
                slog(`master/push: REJECT [${table}] sync_id=${row.sync_id} — incoming ${row.updated_at} <= server ${existing.updated_at}`);
                continue;
              }
            }
            const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
            if (updateCols.length === 0) continue;
            // Set synced=1 in the same UPDATE so the touch trigger's
            // WHEN guard (NEW.synced IS OLD.synced) short-circuits and
            // the row lands in server-authoritative state.
            const setClause = [...updateCols.map(c => `${c} = ?`), 'synced = 1'].join(', ');
            const values = [...updateCols.map(c => row[c]), row.sync_id];
            try {
              masterDb.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(...values);
            } catch (e) {
              rejected.push({ table, sync_id: row.sync_id, reason: e.message });
              slog(`master/push: UPDATE ERR [${table}] sync_id=${row.sync_id}: ${e.message}`);
            }
          }
        }
      })();
    };

    masterDb.pragma('foreign_keys = OFF');
    try {
      for (const [table, rows] of Object.entries(records || {})) {
        if (!MASTER_SYNC_TABLES.includes(table)) continue;
        let cols;
        try {
          cols = masterDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        } catch { continue; }

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          processBatch(table, cols, rows.slice(i, i + BATCH_SIZE));
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    } finally {
      masterDb.pragma('foreign_keys = ON');
    }

    res.json({ success: true, rejected });
  } catch (error) {
    try { masterDb && masterDb.pragma('foreign_keys = ON'); } catch (_) {}
    console.error('[/api/sync/master/push] CRASH:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
