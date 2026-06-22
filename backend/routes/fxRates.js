// FX Rates — per-branch history of USD↔FRA conversion rates.
//
// Used only by dual-currency branches (currency_mode='USD+FRA'). The Cashier
// reads the latest effective row via GET /current; the manager adds new rows
// from Accounting → Currency Rates. Old rows are kept for audit and so old
// receipts replay with the rate that was in effect when the order was paid.
//
// Permission gate: 'FxRates' page perm (admin always; others granted via the
// Users page perm catalog, same pattern as Cashier / Dispatch).
const router = require('express').Router();
const https = require('https');
const db = require('../config/database');
const { auth, readOnlyGuard, requirePagePerm } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// In-memory cache for the BCC live rate. open.er-api.com refreshes daily,
// so a 30-minute server-side cache is more than enough and protects the
// upstream from rapid Refresh-button mashing.
const LIVE_TTL_MS = 30 * 60 * 1000;
let liveCache = null; // { fetchedAt, payload }

function fetchLiveUsdCdf() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://open.er-api.com/v6/latest/USD', {
      timeout: 6000,
      headers: { 'User-Agent': 'sosna-pos/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.result !== 'success' || !j.rates || !j.rates.CDF) {
            return reject(new Error('Unexpected response from open.er-api.com'));
          }
          resolve({
            source: 'open.er-api.com (BCC official)',
            base: 'USD',
            quote: 'CDF',
            rate: parseFloat(j.rates.CDF),
            time_last_update: j.time_last_update_utc || null,
            time_next_update: j.time_next_update_utc || null,
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Live rate request timed out')); });
    req.on('error', reject);
  });
}

// ─── List all rates (most recent first) ──────────────────────────────────────
router.get('/', auth, readOnlyGuard, requirePagePerm('FxRates'), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, sync_id, effective_date, sell_rate, buy_rate,
             notes, set_by, set_by_name, created_at, updated_at
      FROM fx_rates
      WHERE deleted_at IS NULL AND tenant_id = ?
      ORDER BY effective_date DESC, id DESC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Current effective rate (used by Cashier / POS) ──────────────────────────
// No perm gate — every authenticated user needs to read it to compute
// totals, and it leaks no sensitive data. Returns null when no row exists
// yet so the caller can fall back to its hardcoded default (2900/2600).
router.get('/current', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT id, sync_id, effective_date, sell_rate, buy_rate, notes, set_by_name
      FROM fx_rates
      WHERE deleted_at IS NULL AND tenant_id = ?
        AND effective_date <= DATE('now')
      ORDER BY effective_date DESC, id DESC
      LIMIT 1
    `).get(req.user.tenantId);
    res.json(row || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Add a new rate ──────────────────────────────────────────────────────────
router.post('/', auth, requirePagePerm('FxRates'), (req, res) => {
  try {
    const effective_date = (req.body.effective_date || '').slice(0, 10);
    const sell = parseFloat(req.body.sell_rate);
    const buy  = parseFloat(req.body.buy_rate);
    const notes = req.body.notes ? String(req.body.notes).trim() : null;
    if (!effective_date || !/^\d{4}-\d{2}-\d{2}$/.test(effective_date)) {
      return res.status(400).json({ error: 'effective_date (YYYY-MM-DD) is required' });
    }
    if (!isFinite(sell) || sell <= 0) return res.status(400).json({ error: 'sell_rate must be > 0' });
    if (!isFinite(buy)  || buy  <= 0) return res.status(400).json({ error: 'buy_rate must be > 0' });

    const cfg = syncConfig.read() || {};
    const result = db.prepare(`
      INSERT INTO fx_rates
        (sync_id, effective_date, sell_rate, buy_rate, notes,
         set_by, set_by_name, tenant_id, branch_id, device_id, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      randomUUID(), effective_date, sell, buy, notes,
      req.user.id, req.user.name || req.user.email || null,
      req.user.tenantId, cfg.branchId || null, cfg.deviceId || null,
    );
    const row = db.prepare('SELECT * FROM fx_rates WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Soft-delete a rate ──────────────────────────────────────────────────────
router.delete('/:id', auth, requirePagePerm('FxRates'), (req, res) => {
  try {
    const row = db.prepare('SELECT id FROM fx_rates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL')
      .get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Rate not found' });
    db.prepare("UPDATE fx_rates SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?")
      .run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Live BCC rate (reference only — POS/Cashier do NOT use this) ───────────
// Returns the upstream rate verbatim plus a fetchedAt stamp so the UI can
// show "updated 14:05". Cached in-memory for 30min to be polite to the
// free public API.
router.get('/live', auth, readOnlyGuard, async (req, res) => {
  try {
    const fresh = liveCache && (Date.now() - liveCache.fetchedAt) < LIVE_TTL_MS;
    if (!fresh) {
      const payload = await fetchLiveUsdCdf();
      liveCache = { fetchedAt: Date.now(), payload };
    }
    res.json({
      ...liveCache.payload,
      cached: !!liveCache && (Date.now() - liveCache.fetchedAt) > 100, // any cache hit
      fetchedAt: new Date(liveCache.fetchedAt).toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to fetch live rate' });
  }
});

module.exports = router;
