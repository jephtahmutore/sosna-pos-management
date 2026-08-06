// v1.8.6 — Currency Exchange ledger.
// Two scopes share one table:
//   scope='drawer' : a cashier's till exchange (linked to their daily Cash
//                    Report by (date, cashier_id)). Affects per-currency
//                    drawer balance only — never bubbles into the Cash Book.
//   scope='book'   : a Cash Book exchange (manager-recorded). Affects the
//                    Cash Book running balance per currency directly.
//
// Append-only: mistakes are corrected by a reverse entry, never deleted.
// So there's no DELETE route and no deleted_at filter — every row is live.
// Permission gate: 'CashReport' page perm for drawer scope; 'CashBook' page
// perm for book scope. Either way the user must be Admin or Manager (POST).
const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
// v1.10.180 — Phase 2b: pool counters update atomically with the ledger row.
const { poolInflowExchange, poolDrainK } = require('../config/cashPoolHelper');
// v1.10.239 / v1.10.240 — HQ overdraft guards (book-scope only).
const { checkHqOverdraft, checkHqKSubDrawerOverdraft } = require('../config/perMethodBalanceHelper');
let _masterDb = null;
try { _masterDb = require('../config/masterDb').masterDb; } catch { /* offline */ }
const HQ_HOSTS_CX = new Set(['sosnazm.com', 'www.sosnazm.com']);

const VALID_CURRENCIES = new Set(['USD', 'FRA', 'K']);

function isManagerOrAdmin(req) {
  const role = String(req.user?.role || '').toLowerCase();
  return role === 'administrator' || role === 'admin' || role === 'manager';
}

// ─── List ────────────────────────────────────────────────────────────────────
// Required: ?scope=drawer|book
// Optional: ?date=YYYY-MM-DD (single day) OR ?from=YYYY-MM-DD&to=YYYY-MM-DD
//           ?cashier_id=N (drawer scope only)
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const scope = req.query.scope;
    if (!['drawer', 'book'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be drawer or book' });
    }
    const params = [req.user.tenantId, scope];
    // v1.8.10: every column in the WHERE has to be qualified with `ce.`
    // because the JOIN with users also has tenant_id (ambiguous otherwise).
    let where = 'ce.tenant_id = ? AND ce.scope = ?';
    if (req.query.date) {
      where += ' AND ce.date = ?';
      params.push(String(req.query.date).slice(0, 10));
    } else {
      if (req.query.from) { where += ' AND ce.date >= ?'; params.push(String(req.query.from).slice(0, 10)); }
      if (req.query.to)   { where += ' AND ce.date <= ?'; params.push(String(req.query.to).slice(0, 10)); }
    }
    if (scope === 'drawer' && req.query.cashier_id !== undefined) {
      // v1.10.259 — translate local cashier_id → sync_id at query time so
      // rows written on other devices with different local ids still match.
      const cid = parseInt(req.query.cashier_id) || 0;
      if (cid === 0) {
        where += ' AND (ce.cashier_id = 0 OR ce.cashier_id IS NULL)';
      } else {
        where += ' AND ce.cashier_sync_id = (SELECT sync_id FROM users WHERE id = ?)';
        params.push(cid);
      }
    }
    // v1.10.259 — JOIN users on sync_id (created_by_sync_id + cashier_sync_id
    // added in migrations for cross-device correctness).
    const rows = db.prepare(`
      SELECT ce.*, u.first_name || ' ' || u.last_name AS created_by_name,
             cu.first_name || ' ' || cu.last_name AS cashier_name
      FROM currency_exchanges ce
      LEFT JOIN users u  ON ce.created_by_sync_id = u.sync_id
      LEFT JOIN users cu ON ce.cashier_sync_id    = cu.sync_id
      WHERE ${where}
      ORDER BY ce.date DESC, ce.time DESC, ce.id DESC
    `).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Per-currency net impact (used by Cash Report drawer reconciliation) ────
// Returns { usd_in, usd_out, fra_in, fra_out, k_in, k_out } for the given
// scope + date (+ optional cashier). Caller computes net = in − out and
// adjusts drawer / cash book balances per currency.
router.get('/net', auth, readOnlyGuard, (req, res) => {
  try {
    const scope = req.query.scope;
    if (!['drawer', 'book'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be drawer or book' });
    }
    // v1.8.10: this query doesn't JOIN so no ambiguity, but keep consistent.
    const params = [req.user.tenantId, scope];
    let where = 'tenant_id = ? AND scope = ?';
    if (req.query.date) { where += ' AND date = ?'; params.push(String(req.query.date).slice(0, 10)); }
    if (req.query.from) { where += ' AND date >= ?'; params.push(String(req.query.from).slice(0, 10)); }
    if (req.query.to)   { where += ' AND date <= ?'; params.push(String(req.query.to).slice(0, 10)); }
    if (scope === 'drawer' && req.query.cashier_id !== undefined) {
      // v1.10.259 — sync_id filter (see /list handler comment).
      const cid = parseInt(req.query.cashier_id) || 0;
      if (cid === 0) {
        where += ' AND (cashier_id = 0 OR cashier_id IS NULL)';
      } else {
        where += ' AND cashier_sync_id = (SELECT sync_id FROM users WHERE id = ?)';
        params.push(cid);
      }
    }
    const rows = db.prepare(`
      SELECT from_currency, to_currency, from_amount, to_amount
      FROM currency_exchanges WHERE ${where}
    `).all(...params);
    const net = { USD: 0, FRA: 0, K: 0 };
    for (const r of rows) {
      net[r.from_currency] -= parseFloat(r.from_amount || 0);
      net[r.to_currency]   += parseFloat(r.to_amount   || 0);
    }
    res.json({
      usd_net: net.USD, fra_net: net.FRA, k_net: net.K,
      count: rows.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v1.10.177 — Phase 1 of the "USD & USD Equivalent on HQ" rework.
// GET /api/currency-exchanges/blended-rate
// Aggregates every book-scope USD→K exchange the tenant has ever recorded
// (append-only ledger — corrections are reverse entries, never deletes)
// to compute the pool's weighted-average acquisition rate for K:
//
//   blended_k_per_usd = SUM(to_amount [K])  ÷  SUM(from_amount [USD])
//
// This is what the HQ Cash Book will convert K balances to USD with,
// instead of today's live market rate. Phase 2 will make this pool-level
// atomic (native K + exchange K counters that update on every CR/PV/AP).
// For Phase 1 the rate is derived read-only from the exchange history —
// no schema changes, no writes elsewhere.
router.get('/blended-rate', auth, readOnlyGuard, (req, res) => {
  try {
    // USD→K side (how much USD you spent to get K in the pool)
    const usdToK = db.prepare(`
      SELECT
        COALESCE(SUM(from_amount), 0) AS total_from_usd,
        COALESCE(SUM(to_amount),   0) AS total_to_k,
        COUNT(*) AS n
      FROM currency_exchanges
      WHERE tenant_id = ? AND scope = 'book'
        AND from_currency = 'USD' AND to_currency = 'K'
    `).get(req.user.tenantId);
    const totalUsd = parseFloat(usdToK.total_from_usd) || 0;
    const totalK   = parseFloat(usdToK.total_to_k)     || 0;
    const blendedKPerUsd = totalUsd > 0 ? totalK / totalUsd : 0;
    // FRA blended (kept alongside for symmetry — same idea but for FRA→K).
    // If no FRA exchange history, returns 0 and the frontend falls back to
    // today's live FRA rate.
    const usdToFra = db.prepare(`
      SELECT
        COALESCE(SUM(from_amount), 0) AS total_from_usd,
        COALESCE(SUM(to_amount),   0) AS total_to_fra,
        COUNT(*) AS n
      FROM currency_exchanges
      WHERE tenant_id = ? AND scope = 'book'
        AND from_currency = 'USD' AND to_currency = 'FRA'
    `).get(req.user.tenantId);
    const totalUsdFra = parseFloat(usdToFra.total_from_usd) || 0;
    const totalFra    = parseFloat(usdToFra.total_to_fra)   || 0;
    const blendedFraPerUsd = totalUsdFra > 0 ? totalFra / totalUsdFra : 0;
    res.json({
      k: {
        total_from_usd: totalUsd,
        total_to_k:     totalK,
        blended_k_per_usd: blendedKPerUsd,
        exchange_count: usdToK.n,
      },
      fra: {
        total_from_usd:   totalUsdFra,
        total_to_fra:     totalFra,
        blended_fra_per_usd: blendedFraPerUsd,
        exchange_count: usdToFra.n,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Create (admin/manager only) ─────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    if (!isManagerOrAdmin(req)) {
      return res.status(403).json({ error: 'Only Admin or Manager can record currency exchanges' });
    }
    const {
      scope, date, time,
      from_currency, from_amount,
      to_currency, to_amount,
      cashier_id, notes,
      from_method, to_method, // v1.10.135 — K sub-drawer picker on HQ
    } = req.body;
    if (!['drawer', 'book'].includes(scope)) return res.status(400).json({ error: 'scope must be drawer or book' });
    if (!VALID_CURRENCIES.has(from_currency)) return res.status(400).json({ error: 'from_currency must be USD, FRA or K' });
    if (!VALID_CURRENCIES.has(to_currency))   return res.status(400).json({ error: 'to_currency must be USD, FRA or K' });
    if (from_currency === to_currency)         return res.status(400).json({ error: 'from and to currencies must differ' });
    const fromAmt = parseFloat(from_amount);
    const toAmt   = parseFloat(to_amount);
    if (!isFinite(fromAmt) || fromAmt <= 0) return res.status(400).json({ error: 'from_amount must be > 0' });
    if (!isFinite(toAmt)   || toAmt   <= 0) return res.status(400).json({ error: 'to_amount must be > 0' });
    const day = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const tm = (time && /^\d{2}:\d{2}/.test(time))
      ? String(time).slice(0, 5) + ':00'
      : new Date().toTimeString().slice(0, 8);

    const rate = toAmt / fromAmt;
    const cfg = syncConfig.getConfig() || {};
    const sId = randomUUID();
    // v1.10.239 — HQ overdraft guard on book-scope exchanges.
    // A book-scope exchange drains the from_currency drawer, so reject if
    // the current HQ balance in that currency is less than from_amount.
    // Drawer scope (per-cashier till) is unaffected — it has its own daily
    // Cash Report reconciliation and shouldn't false-reject legitimate mid-
    // day exchanges made from a positive till that hasn't been booked yet.
    // v1.10.135 — only accept from_method/to_method for the corresponding K
    // side. Any value passed for a non-K side is discarded so a stray client
    // never poisons the sub-drawer attribution.
    // v1.10.297 — moved ABOVE the HQ overdraft block. The v1.10.240 K
    // sub-drawer check inside that block reads fromMethodClean, so leaving
    // the const declaration below the check triggered a Temporal Dead Zone
    // ("Cannot access 'fromMethodClean' before initialization") on every
    // HQ Cash Book exchange where K was the FROM side (real report
    // 2026-08-06 on sosnazm.com/accounting/cash-book, K → USD save).
    // Pure reorder — no logic change.
    const VALID_METHODS = new Set(['Cash', 'Bank', 'Mobile Money']);
    const fromMethodClean = (from_currency === 'K' && VALID_METHODS.has(String(from_method)))
      ? String(from_method) : null;
    const toMethodClean = (to_currency === 'K' && VALID_METHODS.has(String(to_method)))
      ? String(to_method) : null;

    if (scope === 'book') {
      const host = String(req.hostname || req.headers?.host || '').toLowerCase();
      if (HQ_HOSTS_CX.has(host)) {
        const requested = { usd: 0, fra: 0, k: 0 };
        const key = from_currency === 'USD' ? 'usd' : from_currency === 'FRA' ? 'fra' : 'k';
        requested[key] = fromAmt;
        const breach = checkHqOverdraft(
          db, req.user.tenantId,
          requested,
          { masterDb: _masterDb, slug: 'sosnazm' },
        );
        if (breach) {
          const symbol = breach.ccy === 'K' ? 'K' : breach.ccy === 'FRA' ? 'FRA ' : '$';
          return res.status(400).json({
            error: `Exchange exceeds HQ ${breach.ccy} balance (available ${symbol}${breach.available.toLocaleString(undefined, { maximumFractionDigits: 2 })}, attempting ${symbol}${breach.requested.toLocaleString(undefined, { maximumFractionDigits: 2 })}). Reduce the amount or exchange from a different currency.`,
            currency:  breach.ccy,
            available: breach.available,
            attempted: breach.requested,
          });
        }
        // v1.10.240 — K sub-drawer check. Only fires when K is being
        // exchanged OUT and the caller picked a sub-drawer (K·Cash /
        // K·Bank / K·MoMo). fromMethodClean captures that pick.
        if (from_currency === 'K' && fromMethodClean) {
          const subReq = { cash: 0, bank: 0, momo: 0 };
          const subKey = fromMethodClean === 'Cash' ? 'cash'
                       : fromMethodClean === 'Bank' ? 'bank'
                       : 'momo';
          subReq[subKey] = fromAmt;
          const subBreach = checkHqKSubDrawerOverdraft(
            db, req.user.tenantId,
            subReq,
            { masterDb: _masterDb, slug: 'sosnazm' },
          );
          if (subBreach) {
            return res.status(400).json({
              error: `Exchange exceeds ${subBreach.drawer} balance (available K${subBreach.available.toLocaleString(undefined, { maximumFractionDigits: 2 })}, attempting K${subBreach.requested.toLocaleString(undefined, { maximumFractionDigits: 2 })}). Pick a different K sub-drawer or reduce the amount.`,
              drawer:    subBreach.drawer,
              available: subBreach.available,
              attempted: subBreach.requested,
            });
          }
        }
      }
    }
    // v1.10.180 — wrap the ledger INSERT and pool-counter update in one
    // transaction. If either fails, both roll back so the pool never
    // drifts from the exchange ledger. Only 'book' scope touches the HQ
    // K-pool ('drawer' scope is per-cashier till, unrelated).
    const info = db.transaction(() => {
      const insInfo = db.prepare(`
        INSERT INTO currency_exchanges
          (sync_id, scope, date, time,
           from_currency, from_amount, to_currency, to_amount, rate,
           notes, cashier_id, created_by, tenant_id, branch_id, device_id, synced,
           from_method, to_method)
        VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, 0, ?,?)
      `).run(
        sId, scope, day, tm,
        from_currency, fromAmt, to_currency, toAmt, rate,
        (notes ? String(notes).trim() : null),
        scope === 'drawer' ? (parseInt(cashier_id) || 0) : null,
        req.user.id, req.user.tenantId, cfg.branchId || null, cfg.deviceId || null,
        fromMethodClean, toMethodClean,
      );
      if (scope === 'book') {
        if (from_currency === 'USD' && to_currency === 'K') {
          // Bought K with USD → new exchange K + USD basis.
          poolInflowExchange(db, toAmt, fromAmt);
        } else if (from_currency === 'K' && to_currency === 'USD') {
          // Sold K for USD → drain both counters pro-rata (rate holds).
          poolDrainK(db, fromAmt);
        }
        // USD→FRA, FRA→K, etc. don't touch the K pool (Phase 2b is K-only).
      }
      return insInfo;
    })();
    const row = db.prepare(`SELECT * FROM currency_exchanges WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
