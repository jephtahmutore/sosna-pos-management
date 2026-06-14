// Phone-home activation against the central admin at
// https://sidanitsolutions.com (Butchery's VPS, which hosts the
// /admin/clientbased/* endpoints for bespoke clients like Sosna).
//
// The flow, on first boot of Sosna's tenant server:
//   1. Check local cache for a tenant_id. If present, skip everything
//      and let the server start normally — activation already happened.
//   2. If no cache, read .env for {CB_LICENSE_KEY, CB_SLUG, CB_DOMAIN,
//      CB_BUSINESS_NAME, CB_EMAIL}.
//   3. POST those to /admin/clientbased/activate. Central admin
//      validates the key + checks the slug is pre-registered + mints a
//      UUID + returns it.
//   4. Cache the UUID locally so future restarts skip the network round
//      trip. Sosna runs offline against the cached license from then on;
//      expiry is enforced by Sosna's own backend against expires_at.
//
// Behaviour when CB_LICENSE_KEY is not set: log a warning and continue.
// This keeps local dev / pre-release VPS bring-up from being blocked
// before a real license has been generated in the central admin. Once
// the key is added to .env, the next restart will activate.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CACHE_PATH = process.env.ACTIVATION_CACHE_PATH
  || path.join(__dirname, '..', '.activation-cache.json');

const DEFAULT_ACTIVATE_URL = 'https://sidanitsolutions.com/admin/clientbased/activate';

function readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[activation] Cache read failed (${e.message}) — will re-activate.`);
    return null;
  }
}

function writeCache(payload) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    // Cache failure is non-fatal — we'll just phone home again next boot.
    console.warn(`[activation] Cache write failed: ${e.message}`);
  }
}

// Minimal POST helper. Avoids pulling in axios/fetch just for one call;
// node's built-in https module is enough.
function postJSON(urlString, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlString); }
    catch (e) { return reject(new Error(`Invalid CB_ACTIVATE_URL: ${urlString}`)); }
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
        resolve({ status: res.statusCode, body: parsed, raw: chunks });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Public: call this once during boot, before app.listen, so a fatal
// activation problem stops the server cleanly with a useful error rather
// than running on with no tenant identity.
async function activateOnStartup() {
  const cached = readCache();
  if (cached && cached.tenant_id) {
    console.log(`[activation] Already activated — tenant_id=${cached.tenant_id} (slug=${cached.slug || '?'}).`);
    return cached;
  }

  const key   = (process.env.CB_LICENSE_KEY   || '').trim();
  const slug  = (process.env.CB_LICENSE_SLUG  || process.env.CB_SLUG || '').trim().toLowerCase();
  const domain= (process.env.CB_LICENSE_DOMAIN|| process.env.CB_DOMAIN || '').trim();
  const name  = (process.env.CB_LICENSE_BUSINESS_NAME || process.env.CB_BUSINESS_NAME || '').trim();
  const email = (process.env.CB_LICENSE_EMAIL || process.env.CB_EMAIL || '').trim();
  const url   = process.env.CB_ACTIVATE_URL || DEFAULT_ACTIVATE_URL;

  if (!key) {
    console.warn('[activation] CB_LICENSE_KEY not set — skipping activation. Set it in .env then restart to activate.');
    return null;
  }
  if (!slug || !domain) {
    throw new Error('[activation] CB_LICENSE_KEY is set but CB_SLUG and CB_DOMAIN are required. Aborting.');
  }

  console.log(`[activation] Phoning home to ${url} (slug=${slug}, domain=${domain})…`);
  let resp;
  try {
    resp = await postJSON(url, { key, slug, domain, businessName: name, email });
  } catch (e) {
    throw new Error(`[activation] Phone-home failed: ${e.message}`);
  }

  if (resp.status < 200 || resp.status >= 300) {
    const errMsg = (resp.body && resp.body.error) || `HTTP ${resp.status}`;
    throw new Error(`[activation] Central admin rejected activation: ${errMsg}`);
  }

  const tenantId = resp.body && resp.body.tenant_id;
  if (!tenantId) {
    throw new Error('[activation] Central admin responded with no tenant_id.');
  }

  const payload = {
    tenant_id: tenantId,
    slug, domain, business_name: name, email,
    activated_at: new Date().toISOString(),
    reactivated: !!(resp.body && resp.body.reactivated),
  };
  writeCache(payload);
  console.log(`[activation] Activated — tenant_id=${tenantId}${payload.reactivated ? ' (reactivated)' : ''}.`);
  return payload;
}

module.exports = { activateOnStartup, readCache, CACHE_PATH };
