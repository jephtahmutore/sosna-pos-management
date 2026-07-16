// liveMarketFx — v1.10.207
//
// Fetches today's live market rate for a currency vs USD from a public
// FX API and caches it in-memory for 6 hours. Used when the admin
// hasn't manually entered a daily rate — so native K balances in
// Cash Book / PO / Transfer fall back to a real market rate instead
// of the pool's blended historical acquisition rate (which inflates
// the value of native K held long-term).
//
// Source: exchangerate-api.com free tier (no API key required for the
// public v4 endpoint). Includes ZMW (Zambia Kwacha) and CDF (Congolese
// Franc — Sosna's FRA). Fallback to cache if API is unreachable.
//
// TTL: 6 hours. Kwacha spot rate doesn't move fast enough to warrant
// hitting the API on every render. Server restart drops the cache
// (acceptable — next call refreshes).

const router = require('express').Router();
const https = require('https');
const { auth } = require('../middleware/auth');

// In-memory cache. Keyed by our internal ccy code ('K', 'FRA', 'USD').
let cache = {};
const TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

// Our internal names → ISO 4217 codes used by exchangerate-api.
const ISO_MAP = {
  K:   'ZMW', // Zambia Kwacha
  FRA: 'CDF', // Congolese Franc (Sosna's local FRA nickname)
};

function fetchRatesFromApi() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.exchangerate-api.com',
      path: '/v4/latest/USD',
      method: 'GET',
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json || !json.rates) {
            reject(new Error('API response missing rates'));
            return;
          }
          resolve(json.rates);
        } catch (e) {
          reject(new Error('API response not JSON: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('FX API timeout after ' + REQUEST_TIMEOUT_MS + 'ms'));
    });
    req.end();
  });
}

// GET /api/fx-rates/live-market/:currency
// Returns { currency, rate_per_usd, source, fetched_at }
// source: 'cache' (fresh) | 'live' (just fetched) | 'cache-fallback' (API failed, using stale cache)
router.get('/live-market/:currency', auth, async (req, res) => {
  const ccy = String(req.params.currency || '').toUpperCase();
  const iso = ISO_MAP[ccy] || ccy;
  const now = Date.now();

  // Serve from cache if fresh.
  const cached = cache[ccy];
  if (cached && (now - cached.fetched_at) < TTL_MS) {
    return res.json({
      currency:      ccy,
      iso_code:      iso,
      rate_per_usd:  cached.rate,
      source:        'cache',
      fetched_at:    new Date(cached.fetched_at).toISOString(),
      ttl_seconds:   Math.round((TTL_MS - (now - cached.fetched_at)) / 1000),
    });
  }

  // Fetch fresh.
  try {
    const rates = await fetchRatesFromApi();
    const rate = parseFloat(rates[iso] || 0) || 0;
    if (rate > 0) {
      cache[ccy] = { rate, fetched_at: now };
      return res.json({
        currency:      ccy,
        iso_code:      iso,
        rate_per_usd:  rate,
        source:        'live',
        fetched_at:    new Date(now).toISOString(),
        ttl_seconds:   Math.round(TTL_MS / 1000),
      });
    }
    return res.status(404).json({ error: `Rate for ${ccy} (${iso}) not in API response` });
  } catch (err) {
    // API failed. If we have any cached value (even stale) return it —
    // any rate is better than none for the "honest fair value" fallback.
    if (cached) {
      return res.json({
        currency:      ccy,
        iso_code:      iso,
        rate_per_usd:  cached.rate,
        source:        'cache-fallback',
        fetched_at:    new Date(cached.fetched_at).toISOString(),
        api_error:     err.message,
      });
    }
    return res.status(502).json({ error: err.message });
  }
});

module.exports = router;
