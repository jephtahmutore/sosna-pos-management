'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const logFile = path.join(os.tmpdir(), 'sosna-startup.log');
function slog(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [Sync] ${msg}\n`); } catch (e) {}
}

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
  // Supplier Credit Notes (Discount / Crate Return / Goods Return / Other) —
  // KEEP IN SYNC with sync.js SYNC_TABLES. Missing them here meant CNs
  // created on Electron never pushed to VPS, and CNs created on web never
  // pulled to Electron (the exact Sidan Hub failure mode).
  'supplier_credit_notes', 'supplier_credit_note_items',
  // Owner equity ledgers — same Sidan Hub gotcha applies, keep both lists in sync.
  'capital_account', 'dividend_account',
  // Shareholders + Loans liability ledger — sync these too or per-shareholder
  // reporting and Loan outstanding balances drift cross-device.
  'shareholders', 'loans', 'loan_transactions',
  // Cash Book transfers between methods — KEEP IN SYNC with sync.js list.
  'cash_transfers',
  // Stock count audit trail — KEEP IN SYNC with sync.js list.
  'stock_count_sessions', 'stock_count_items',
  // Discount approval requests — admin verdict needs to reach the cashier's
  // PC even if approver is on another device. KEEP IN SYNC with sync.js.
  'discount_requests',
  // Phase 1 multi-currency (Sosna's whole reason for forking from Liquor).
  // KEEP IN SYNC with sync.js list — adding to only one will cause one-way
  // sync gaps that are hard to spot later.
  'branches', 'product_branch_prices',
  // v1.8.33 — KEEP IN SYNC with sync.js list. currency_exchanges = drawer
  // FX swaps that feed Cash Report Expected; fx_rates = the rate table
  // every receipt + cashier pay modal reads from. Both MUST sync.
  'currency_exchanges', 'fx_rates',
];

const DEFAULT_VPS_URL = (process.env.VPS_URL || 'https://sosnazm.com').replace(/\/$/, '');
function getVpsUrl() {
  const stored = _syncConfig ? _syncConfig.get('vps_url') : null;
  return (stored || DEFAULT_VPS_URL).replace(/\/$/, '');
}
// Returns the URL this PC should sync TO.
// - Mother / unconfigured: VPS URL (legacy direct-to-VPS behavior)
// - Child:                 Mother PC URL on the LAN
// If lan_role is 'child' but mother_ip is empty, falls back to VPS (safe default — never breaks).
function getSyncTargetUrl() {
  if (!_syncConfig) return DEFAULT_VPS_URL;
  const lan = _syncConfig.getLanConfig();
  if (lan.role === 'child' && lan.motherIp) {
    const ip = lan.motherIp.trim();
    return ip.startsWith('http') ? ip.replace(/\/$/, '') : `http://${ip}:5000`;
  }
  return getVpsUrl();
}
function getSyncIntervalMs() {
  if (!_syncConfig) return 30_000;
  const lan = _syncConfig.getLanConfig();
  return lan.role === 'child' && lan.motherIp ? 3_000 : 30_000;
}
const HEALTH_TIMEOUT  = 5_000;
const REQUEST_TIMEOUT = 20_000;

let _db         = null;
let _syncConfig = null;
let _timer      = null;
let _status     = { state: 'idle', lastSynced: null, error: null };

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request(url, method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    // For child PCs syncing to Mother on the LAN, attach the shared sync key.
    // Mother validates this header; VPS ignores it (no harm).
    if (_syncConfig) {
      const lan = _syncConfig.getLanConfig();
      if (lan.role === 'child' && lan.lanSyncKey) {
        headers['X-Lan-Sync-Key'] = lan.lanSyncKey;
      }
    }
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers,
      timeout:  timeoutMs,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Internet / VPS check ─────────────────────────────────────────────────────
async function isOnline() {
  try {
    const r = await request(`${getSyncTargetUrl()}/api/health`, 'GET', null, HEALTH_TIMEOUT);
    return r.status === 200;
  } catch {
    return false;
  }
}

// ─── Push local unsynced records → VPS ───────────────────────────────────────
async function push() {
  const { tenantId, branchId, deviceId } = _syncConfig.getConfig();
  if (!tenantId || tenantId === 'local-only') return;

  const records = {};
  for (const table of SYNC_TABLES) {
    try {
      const cols = _db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes('sync_id') || !cols.includes('synced')) continue;
      const rows = _db.prepare(`SELECT * FROM ${table} WHERE synced = 0`).all();
      if (rows.length > 0) records[table] = rows;
    } catch { /* table might not exist */ }
  }

  if (Object.keys(records).length === 0) { slog('push: nothing to push'); return; }

  slog('push: sending ' + JSON.stringify(Object.entries(records).map(([t,r]) => `${t}:${r.length}`)));
  const result = await request(
    `${getSyncTargetUrl()}/api/sync/push`,
    'POST',
    { tenantId, branchId, deviceId, records }
  );
  slog('push: response ' + result.status + ' ' + JSON.stringify(result.body).substring(0, 200));

  if (result.status === 200) {
    _db.transaction(() => {
      for (const [table, rows] of Object.entries(records)) {
        for (const row of rows) {
          if (!row.sync_id) continue;
          try {
            _db.prepare(`UPDATE ${table} SET synced = 1 WHERE sync_id = ?`).run(row.sync_id);
          } catch { /* ignore */ }
        }
      }
    })();
  }
}

// ─── Pull VPS records → local DB (merge by sync_id) ──────────────────────────
// v1.8.90 — added `opts.force`. When true:
//   • since=0 (full history pull, not just incremental)
//   • PROTECT rule is BYPASSED — incoming rows overwrite local even if local
//     synced=0. Used by Force Resync to unstick a diverged client.
async function pull(opts = {}) {
  const { tenantId, lastPullTime, deviceId } = _syncConfig.getConfig();
  if (!tenantId || tenantId === 'local-only') return { ok: false, reason: 'local-only' };

  const since = opts.force ? '' : lastPullTime;

  // Send our own deviceId so the server excludes records we originated
  // (prevents "echo" loop where each push triggers a pull-back of the same record).
  const result = await request(
    `${getSyncTargetUrl()}/api/sync/pull?tenantId=${encodeURIComponent(tenantId)}&since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId || '')}`
  );

  slog('pull: since=' + lastPullTime + ' status=' + result.status);
  if (result.status !== 200 || !result.body || !result.body.records) {
    slog('pull: failed or empty response');
    return;
  }
  const pulled = Object.entries(result.body.records).map(([t,r]) => `${t}:${r.length}`);
  slog('pull: received ' + (pulled.length ? JSON.stringify(pulled) : 'nothing'));

  _db.pragma('foreign_keys = OFF');

  // BATCHED: process records in chunks so the event loop isn't blocked for long.
  // Each batch runs in its own short SQLite transaction; we yield between batches
  // so the backend can still respond to API calls from the frontend.
  const BATCH_SIZE = 200;

  const hasUpdatedAt = (cols) => cols.includes('updated_at');

  const processBatch = (table, cols, batch) => {
    const tableHasUpdatedAt = hasUpdatedAt(cols);
    _db.transaction(() => {
      for (const row of batch) {
        if (!row.sync_id) continue;
        try {
          // v1.9.1 — read updated_at too so we can timestamp-resolve conflicts.
          const selectCols = tableHasUpdatedAt ? 'id, synced, updated_at' : 'id, synced';
          const existing = _db.prepare(`SELECT ${selectCols} FROM ${table} WHERE sync_id = ?`).get(row.sync_id);

          if (!existing) {
            // New record — insert it (mark synced=1 so we don't push it back)
            const insertCols = cols.filter(c => c !== 'id' && row[c] !== undefined && row[c] !== null);
            if (insertCols.length === 0) { slog(`pull: SKIP [${table}] no cols for sync_id=${row.sync_id}`); continue; }
            const placeholders = insertCols.map(() => '?').join(', ');
            const ins = _db.prepare(
              `INSERT OR IGNORE INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders})`
            ).run(...insertCols.map(c => row[c]));
            if (ins.changes === 0) slog(`pull: IGNORED [${table}] sync_id=${row.sync_id} cols=${insertCols.join(',')}`);
            _db.prepare(`UPDATE ${table} SET synced = 1 WHERE sync_id = ?`).run(row.sync_id);
          } else if (existing.synced === 0 && !opts.force) {
            // v1.9.1 — TIMESTAMP-AWARE PROTECT.
            // The old rule blocked every pull whenever local.synced=0. That
            // was too aggressive: a trivial local write (e.g. last_login
            // bump on user row) would lock the row forever, so legitimate
            // server updates (admin edited permissions on the web) never
            // arrived. The real intent was: "don't overwrite a row the
            // user is mid-editing offline." Now we only block when LOCAL
            // is genuinely newer than the incoming version. If incoming is
            // newer (or equal), the server has the fresher state and we
            // accept it — including a refresh of synced=0 → 1 because the
            // local change was already superseded.
            const localTs    = tableHasUpdatedAt ? (existing.updated_at || '') : '';
            const incomingTs = tableHasUpdatedAt ? (row.updated_at || '')      : '';
            if (tableHasUpdatedAt && incomingTs && localTs && localTs > incomingTs) {
              slog(`pull: PROTECT [${table}] sync_id=${row.sync_id} — local(${localTs}) newer than incoming(${incomingTs}), skipping`);
              continue;
            }
            // Incoming wins (newer or equal, or no timestamp column to compare).
            const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
            if (updateCols.length === 0) continue;
            const setClause = [...updateCols.map(c => `${c} = ?`), 'synced = 1'].join(', ');
            _db.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(
              ...updateCols.map(c => row[c]), row.sync_id
            );
            slog(`pull: TIMESTAMP-WIN [${table}] sync_id=${row.sync_id} — incoming(${incomingTs}) overrode local(${localTs}, synced=0)`);
          } else {
            // Existing record is clean (or force=true) — overwrite with incoming version
            const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
            if (updateCols.length === 0) continue;
            const setClause = [...updateCols.map(c => `${c} = ?`), 'synced = 1'].join(', ');
            _db.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(
              ...updateCols.map(c => row[c]), row.sync_id
            );
            if (opts.force && existing.synced === 0) {
              slog(`pull: FORCE OVERWRITE [${table}] sync_id=${row.sync_id} — local synced=0 was discarded`);
            }
          }
        } catch (rowErr) { slog(`pull: row error [${table}] ${rowErr.message}`); }
      }
    })();
  };

  // Process each table in batches; yield event loop between batches so
  // frontend API calls aren't blocked during a large initial pull.
  for (const [table, rows] of Object.entries(result.body.records)) {
    if (!SYNC_TABLES.includes(table)) continue;
    let cols;
    try {
      cols = _db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    } catch { continue; }
    if (!cols.includes('sync_id')) continue;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      processBatch(table, cols, batch);
      // Yield: lets pending API requests and timers run before next batch
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  _db.pragma('foreign_keys = ON');

  if (result.body.serverTime) {
    _syncConfig.updateLastPullTime(result.body.serverTime);
  }
  // v1.8.90 — return a summary so the Force Resync endpoint can show counts.
  const totalRows = Object.values(result.body.records).reduce((s, r) => s + r.length, 0);
  return { ok: true, tables: pulled, total: totalRows };
}

// ─── One full sync cycle ──────────────────────────────────────────────────────
async function runCycle() {
  try {
    const { tenantId } = _syncConfig.getConfig();
    if (!tenantId || tenantId === 'local-only') {
      _status = { state: 'idle', lastSynced: null, error: null };
      return;
    }

    _status = { ..._status, state: 'checking' };

    const online = await isOnline();
    if (!online) {
      _status = { ..._status, state: 'offline', error: null };
      return;
    }

    _status = { ..._status, state: 'syncing', error: null };
    await push();
    await pull();

    const now = new Date().toISOString();
    _status = { state: 'synced', lastSynced: now, error: null };
    _syncConfig.set('last_synced', now);
    _syncConfig.set('sync_error', '');
    console.log('[SyncService] Cycle complete:', now);
  } catch (err) {
    console.error('[SyncService] Error:', err.message);
    _status = { ..._status, state: 'error', error: err.message };
    try { _syncConfig.set('sync_error', err.message); } catch { /* ignore */ }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
let _currentIntervalMs = 0;
let _running = false;

// Self-rescheduling loop — never starts a new cycle until the previous one
// finishes. Prevents pile-up of overlapping runCycle() calls when sync gets
// slow, which was causing accumulating freezes on long-running Mother PCs.
async function loopOnce() {
  if (_running) return;
  _running = true;
  try {
    await runCycle();
  } catch (e) {
    slog('loopOnce error: ' + e.message);
  } finally {
    _running = false;
    const next = getSyncIntervalMs();
    _currentIntervalMs = next;
    _timer = setTimeout(loopOnce, next);
  }
}

function start(db, syncConfig) {
  if (_timer) return;
  _db         = db;
  _syncConfig = syncConfig;

  _currentIntervalMs = getSyncIntervalMs();
  // First cycle after 8s (give server time to finish startup)
  _timer = setTimeout(loopOnce, 8_000);

  const cfg = syncConfig.getConfig();
  slog(`started — tenantId=${cfg.tenantId} branchId=${cfg.branchId} interval=${_currentIntervalMs/1000}s target=${getSyncTargetUrl()}`);
  console.log(`[SyncService] Started — interval: ${_currentIntervalMs / 1000}s, target: ${getSyncTargetUrl()}`);
}

// Called when LAN config changes — next cycle will pick up the new interval
function reload() {
  // loopOnce reads getSyncIntervalMs() at the end of every cycle, so the
  // new interval is automatically picked up on the next tick. Nothing to do.
  slog('reload called — new interval will apply on next cycle');
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _currentIntervalMs = 0;
}

function getStatus() {
  return { ..._status, target: getSyncTargetUrl(), intervalMs: _currentIntervalMs };
}

module.exports = { start, stop, reload, getStatus, pull };
