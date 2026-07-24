/**
 * transfers.js — cross-branch stock transfers.
 *
 * Universal — works whether the caller is on a per-branch subdomain
 * (kassumbalesa1.sosnazm.com) or the HQ host (sosnazm.com). The transfer
 * rows live in master.db so source AND destination read the same record
 * without cross-DB joins. Per-branch stock is updated by opening each
 * branch's tenant DB on demand via getTenantDb(slug).
 *
 * State machine on stock_transfers.status:
 *   PENDING   — source dispatched, NO stock movement yet (in transit).
 *               v1.9.22 — source no longer decrements at creation. The
 *               sent-qty leaves source's books only when the destination
 *               confirms (or partially confirms) receipt. This keeps the
 *               source's Sales Bin Card honest while goods are in flight.
 *               Trade-off: source can sell from this stock during transit;
 *               availability check at create time subtracts pending
 *               outgoing transfers to prevent over-promising.
 *   RECEIVED  — destination confirmed. Source posts transfer_out (-sentQty),
 *               destination posts transfer_in (+recvQty), variance for
 *               the difference (lost / damaged in transit).
 *   CANCELLED — source aborted before destination received. No stock
 *               movement at all (nothing was deducted to reverse).
 *
 * Auth: hqAuth (JWT only) — every Sosna admin can move stock between
 * branches they're an admin on. Per-role gates can be added later.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { conversionToBase } = require('../config/unitsHelper');
// v1.10.214 — per-device shortcode via syncConfig so Electron installs
// running local backends don't collide on transfer_number when they
// eventually sync back to VPS master.db. Same pattern PVs / CRs use.
const syncConfig = require('../config/syncConfig');

function hqAuth(req, res, next) {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Access denied' });
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'sosna-pro-secret-key-2026');
    next();
  } catch (_) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function branchName(slug) {
  try {
    const t = listTenants().find(t => t.slug === slug);
    if (!t) return slug;
    // Also try the branch's own business_settings.business_name for a
    // friendlier display label — falls back to the master tenant name.
    try {
      const db = getTenantDb(slug);
      const row = db.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
      if (row?.business_name) return row.business_name;
    } catch (_) { /* fall through */ }
    return t.business_name || slug;
  } catch (_) { return slug; }
}

function nextTransferNumber() {
  // v1.10.213 — MAX(numeric suffix) + 1 (survives delete).
  // v1.10.214 — added per-device shortcode. Prefix goes from
  //   TRF-YYYY-           → TRF-YYYY-C0AB98-
  // MAX lookup is now scoped to this device's own prefix, so counters
  // between VPS + N Electron installs are independent → no collision
  // on sync into master.db. deviceId is stable per install; falls back
  // to 'LOCAL1' pre-migration.
  const cfg = syncConfig.getConfig();
  const shortCode = cfg.deviceId
    ? cfg.deviceId.replace(/-/g, '').substring(0, 6).toUpperCase()
    : 'LOCAL1';
  const yr = new Date().getFullYear();
  const prefix = `TRF-${yr}-${shortCode}-`;
  const row = masterDb.prepare(
    `SELECT COALESCE(
       MAX(CAST(SUBSTR(transfer_number, ${prefix.length + 1}) AS INTEGER)),
       0
     ) AS m
     FROM stock_transfers
     WHERE transfer_number LIKE ?`
  ).get(prefix + '%');
  const seq = (row?.m || 0) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// GET /api/transfers/source-products?slug=
// Products at a given branch with their current total on-hand stock.
//
// v1.8.92 — was reading products.current_stock (cached column). That column
// drifts (manual edits, sync gaps, reversal bugs) and got out of sync with
// reality — Stock Reconciliation showed 22,398 Bottle of SAVANNA 330ML
// while this endpoint reported 300 (a 75x gap). Now we compute on-hand
// from stock_movements like Reconciliation does, summed across ALL
// locations (sales + store + anywhere) because for an inter-branch
// transfer the total physical stock at the branch is what's transferable.
// Returns the same `current_stock` field name so the frontend doesn't
// need to change.
router.get('/source-products', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();
    if (!slug || !isRegistered(slug)) return res.status(400).json({ error: 'Unknown source branch' });
    const db = getTenantDb(slug);
    const products = db.prepare(`
      SELECT p.id, p.sync_id, p.name, p.unit, p.alt_unit, p.conversion_factor,
             p.units_json, p.default_unit,
             p.cost_price, p.avg_cost_price, p.selling_price,
             COALESCE(bal.balance, 0) AS current_stock,
             p.min_stock
        FROM products p
        LEFT JOIN (
          SELECT product_sync_id, SUM(quantity) AS balance
            FROM stock_movements
           WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
           GROUP BY product_sync_id
        ) bal ON bal.product_sync_id = p.sync_id
       WHERE p.deleted_at IS NULL AND p.status != 'Inactive'
       ORDER BY p.name COLLATE NOCASE ASC
    `).all();
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transfers/outgoing?slug=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD
// Transfers SENT from the named branch. Both PENDING and RECEIVED so the
// operator can see their full send history; status filter narrows it.
// v1.9.22 — date range filter added so the History tabs can scope to a
// date window (and avoid hitting the LIMIT 500 ceiling on busy branches).
// GET /api/transfers/pending-all
// HQ-only. Lists every PENDING transfer across ALL branches. Powers the
// Cost-of-Delivery attach picker where HQ needs to pick any in-flight
// transfer regardless of from/to slug. v1.10.186.
router.get('/pending-all', hqAuth, (req, res) => {
  try {
    // v1.10.201 — include PENDING_HQ so the Cost of Delivery picker can
    // attach LCVs to transfers waiting on HQ review too (that's exactly
    // the point of the review step).
    const rows = masterDb.prepare(
      `SELECT * FROM stock_transfers
        WHERE status IN ('PENDING', 'PENDING_HQ')
        ORDER BY created_at DESC LIMIT 500`
    ).all().map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.10.201 — Transfers waiting for HQ to review + release. Powers the
// new "Transfers Awaiting HQ" sidebar entry under Store. HQ-only.
router.get('/awaiting-hq-release', hqAuth, (req, res) => {
  try {
    const rows = masterDb.prepare(
      `SELECT * FROM stock_transfers
        WHERE status = 'PENDING_HQ'
        ORDER BY created_at DESC LIMIT 500`
    ).all().map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.10.201 — HQ releases a PENDING_HQ transfer. Two paths:
//   no_cost=true → status = PENDING, no LCV expected
//   no_cost=false (default) → status = PENDING; caller has attached
//                             LCVs already via + Add Delivery Cost
// Idempotent-ish: releasing an already-PENDING row is a no-op.
router.put('/:syncId/release', hqAuth, (req, res) => {
  try {
    const syncId = req.params.syncId;
    const noCost = req.body?.no_cost === true || req.body?.no_cost === 'true' || req.body?.no_cost === 1;
    const row = masterDb.prepare('SELECT * FROM stock_transfers WHERE sync_id = ?').get(syncId);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    if (row.status === 'PENDING') return res.json({ ok: true, transfer: parseItems(row), already_released: true });
    if (row.status !== 'PENDING_HQ') return res.status(400).json({ error: `Transfer is ${row.status}, not PENDING_HQ` });
    const releasedByName = req.user?.firstName || req.user?.email || 'HQ';
    // v1.10.209 — snapshot LCV total onto the transfer row at release
    // time. LCVs live in HQ's own DB (backend/sosna.db), so the
    // destination branch's Receive modal can't see them via its own
    // payment_vouchers table. Copying the total onto the transfer
    // record lets the receive-side preview show honest delivery-cost
    // context without a cross-tenant query. The actual absorption at
    // /receive still reads from HQ directly (v1.10.185) — this is
    // display-only.
    let lcvTotalAtRelease = 0;
    try {
      const hqDb = require('../config/database').defaultDb;
      if (hqDb) {
        const sum = hqDb.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS t
            FROM payment_vouchers
           WHERE linked_transfer_sync_id = ?
             AND is_landed_cost = 1
             AND deleted_at IS NULL
             AND applied_to_transfer_sync_id IS NULL
        `).get(syncId);
        lcvTotalAtRelease = parseFloat(sum?.t || 0) || 0;
      }
    } catch (lcvErr) {
      console.warn('[transfers.release] LCV sum failed:', lcvErr.message);
    }
    masterDb.prepare(`
      UPDATE stock_transfers
         SET status              = 'PENDING',
             hq_released_by      = ?,
             hq_released_by_name = ?,
             hq_released_at      = datetime('now'),
             hq_release_no_cost  = ?,
             lcv_total_at_release = ?
       WHERE sync_id = ?
    `).run(req.user?.id || null, releasedByName, noCost ? 1 : 0, lcvTotalAtRelease, syncId);
    const updated = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE sync_id = ?').get(syncId));
    res.json({ ok: true, transfer: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/outgoing', hqAuth, (req, res) => {
  try {
    const slug   = String(req.query.slug || '').toLowerCase();
    const status = String(req.query.status || '').toUpperCase();
    const from   = String(req.query.from || '').trim();
    const to     = String(req.query.to   || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    let sql = `SELECT * FROM stock_transfers WHERE from_slug = ?`;
    const params = [slug];
    // v1.10.201 — accept comma-separated status list ("PENDING,PENDING_HQ")
    // so the source branch can see both waiting-HQ + released-to-dest.
    if (status.includes(',')) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) {
        sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    } else if (status) { sql += ' AND status = ?'; params.push(status); }
    if (from)   { sql += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)     { sql += ' AND DATE(created_at) <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = masterDb.prepare(sql).all(...params).map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transfers/incoming?slug=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD
// Transfers headed TO the named branch. Default filter status=PENDING so
// the operator sees only what needs receiving; pass status= '' for all.
router.get('/incoming', hqAuth, (req, res) => {
  try {
    const slug   = String(req.query.slug || '').toLowerCase();
    const status = req.query.status === undefined ? 'PENDING' : String(req.query.status).toUpperCase();
    const from   = String(req.query.from || '').trim();
    const to     = String(req.query.to   || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    let sql = `SELECT * FROM stock_transfers WHERE to_slug = ?`;
    const params = [slug];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (from)   { sql += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)     { sql += ' AND DATE(created_at) <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = masterDb.prepare(sql).all(...params).map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parseItems(row) {
  try { row.items = JSON.parse(row.items_json || '[]'); }
  catch { row.items = []; }
  delete row.items_json;
  return row;
}

// POST /api/transfers
// Body: { from_slug, to_slug, items: [{product_sync_id, product_name,
//         unit, quantity, cost_price?}], notes? }
// Source stock is decremented IMMEDIATELY — the transfer represents stock
// already on the truck. If receive never happens the source can cancel
// and we'll restore the stock (see /cancel below).
router.post('/', hqAuth, (req, res) => {
  try {
    const { from_slug, to_slug, items, notes,
            cost_currency, fx_rate_used } = req.body || {};
    const fromSlug = String(from_slug || '').toLowerCase();
    const toSlug   = String(to_slug   || '').toLowerCase();
    // v1.10.54 — WAC redesign push 2: FX rate at Send time.
    // One rate per whole transfer, per user's 2026-07-03 memo. Backend
    // just accepts + stores; the frontend gates the requirement based on
    // whether the destination is a tri-currency branch.
    const VALID_CCY = new Set(['USD', 'FRA', 'K']);
    const ccy  = cost_currency ? String(cost_currency).toUpperCase() : null;
    const rate = fx_rate_used  ? parseFloat(fx_rate_used) : null;
    if (ccy && !VALID_CCY.has(ccy)) {
      return res.status(400).json({ error: 'cost_currency must be one of USD, FRA, K' });
    }
    // v1.10.140 — mirror the hqPurchases relaxation: only require FX
    // when the DESTINATION branch's currency_mode doesn't natively
    // include cost_currency. K-only Lusaka/Mansa keep a K cost with
    // no rate (nothing to convert to); tri-currency Kassumbalesa still
    // needs a rate for non-USD costs.
    if (ccy && ccy !== 'USD' && !(rate > 0)) {
      let needsFx = true;
      try {
        const bdb = getTenantDb(String(to_slug || '').toLowerCase());
        const row = bdb.prepare('SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1').get();
        const mode = (row && row.currency_mode) || 'K';
        needsFx = !mode.split(/[+\-,]/).map(s => s.trim()).includes(ccy);
      } catch (_) { /* fall through to strict check */ }
      if (needsFx) {
        return res.status(400).json({ error: `fx_rate_used > 0 is required when cost_currency is ${ccy}` });
      }
    }
    // Convert helper: local cost → USD equivalent using this transfer's
    // rate. USD stays 1:1. Stored on each item inside items_json so read
    // paths can pull the pre-computed USD value without re-doing math.
    const toUsd = (localCost) => {
      const c = parseFloat(localCost || 0) || 0;
      if (c <= 0) return 0;
      if (!ccy || ccy === 'USD') return c;
      return rate > 0 ? c / rate : null;
    };
    if (!fromSlug || !toSlug) return res.status(400).json({ error: 'from_slug and to_slug are required' });
    if (fromSlug === toSlug)  return res.status(400).json({ error: 'Source and destination must differ' });
    if (!isRegistered(fromSlug)) return res.status(400).json({ error: `Source branch "${fromSlug}" not registered` });
    if (!isRegistered(toSlug))   return res.status(400).json({ error: `Destination branch "${toSlug}" not registered` });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });

    // Validate + normalise items.
    const cleanItems = [];
    let totalValue = 0;
    for (const it of items) {
      const psid = String(it.product_sync_id || '').trim();
      const name = String(it.product_name    || '').trim();
      const qty  = parseFloat(it.quantity);
      if (!psid || !name || !(qty > 0)) {
        return res.status(400).json({ error: `Invalid item: needs product_sync_id, product_name, and quantity > 0` });
      }
      const cost = parseFloat(it.cost_price || 0) || 0;
      cleanItems.push({
        product_sync_id: psid,
        product_name:    name,
        unit:            it.unit || null,
        quantity:        qty,
        cost_price:      cost,
        // v1.10.54 — USD equivalent baked in at Send time so /receive
        // can blend WAC without re-consulting rate math. Same value
        // regardless of whether destination is tri-currency; on K-only
        // destinations it's ignored during blend (cost stays in K).
        cost_price_usd:  toUsd(cost),
      });
      totalValue += qty * cost;
    }

    const fromDb = getTenantDb(fromSlug);
    const transferSyncId = randomUUID();
    const transferNumber = nextTransferNumber();
    const createdBy      = req.user.id || null;
    const createdByName  = req.user.firstName || req.user.email || 'HQ';

    // v1.9.22 — Availability check at create time. We no longer decrement
    // source stock here (the deduction is deferred to /receive), but we
    // still need to block sending qty the source can't actually ship.
    // Available = live bin balance − qty already locked in other PENDING
    // outgoing transfers for the same product. Otherwise a source could
    // create 5 PENDINGs for the same 100 units and over-promise 500.
    const liveStockStmt = fromDb.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS balance
         FROM stock_movements
        WHERE product_sync_id = ? AND deleted_at IS NULL`
    );
    const pendingOutgoingRows = masterDb.prepare(
      `SELECT items_json FROM stock_transfers
        WHERE from_slug = ? AND status = 'PENDING'`
    ).all(fromSlug);
    // Sum base-qty already promised per product across all PENDING outgoing.
    const pendingByPsid = new Map();
    for (const row of pendingOutgoingRows) {
      let parsed = [];
      try { parsed = JSON.parse(row.items_json || '[]'); } catch { /* skip */ }
      for (const it of parsed) {
        const psid = it.product_sync_id;
        if (!psid) continue;
        const prodRow = fromDb.prepare(
          'SELECT unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
        ).get(psid);
        const baseQty = parseFloat(it.quantity) * conversionToBase(prodRow || {}, it.unit);
        pendingByPsid.set(psid, (pendingByPsid.get(psid) || 0) + baseQty);
      }
    }
    for (const it of cleanItems) {
      const prod = fromDb.prepare(
        'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
      ).get(it.product_sync_id);
      if (!prod) {
        return res.status(400).json({ error: `Product not found at source: ${it.product_name}` });
      }
      const baseQty   = parseFloat(it.quantity) * conversionToBase(prod, it.unit);
      const liveStock = parseFloat(liveStockStmt.get(prod.sync_id).balance) || 0;
      const promised  = pendingByPsid.get(prod.sync_id) || 0;
      const available = liveStock - promised;
      if (available < baseQty - 0.0001) {
        return res.status(400).json({
          error: `Insufficient stock for ${it.product_name} (have ${liveStock}, ${promised > 0 ? `already in pending transfers: ${promised}, ` : ''}available: ${available}, need ${baseQty})`,
        });
      }
    }

    // Master row only — source stock_movements posted at /receive time.
    // v1.10.201 — new transfers start in PENDING_HQ (HQ delivery review).
    // v1.10.212 — reverted to PENDING. HQ gate removed because delivery
    // cost against transfers isn't a routine practice for this business.
    // HQ can still attach LCVs to pending transfers via the Cost of
    // Delivery page any time before destination receives; absorption on
    // /receive still reads HQ's LCVs live (v1.10.185). No forced pause,
    // no dead menu items. Historical PENDING_HQ rows get promoted by
    // a one-shot migration in masterDb.js boot.
    masterDb.prepare(`
      INSERT INTO stock_transfers (transfer_number, sync_id, from_slug, from_name, to_slug, to_name,
                                   items_json, total_items, total_value, notes,
                                   cost_currency, fx_rate_used,
                                   status, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)
    `).run(
      transferNumber, transferSyncId,
      fromSlug, branchName(fromSlug),
      toSlug,   branchName(toSlug),
      JSON.stringify(cleanItems),
      cleanItems.length,
      totalValue,
      notes || null,
      ccy, rate,
      createdBy, createdByName
    );

    const row = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE sync_id = ?').get(transferSyncId));
    res.status(201).json(row);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// PUT /api/transfers/:id/receive
// Destination confirms arrival. For each item, find the product at the
// destination by sync_id (or auto-create using the snapshot from the
// transfer), increment current_stock by RECEIVED qty (not sent qty),
// and log a transfer_in movement.
//
// v1.8.64 — Per-line receive: body.received_lines = [{
//   product_sync_id, received_qty, reason ('OK'|'Short'|'Damaged'|'Lost'), notes
// }]. When received_qty < sent_qty (or reason != 'OK'), a
// transfer_variance row is recorded in master.db.
//
// v1.9.22 — Source-side decrement moved here from /create. On receive:
//   - Source: post transfer_out (-sentQty) — the sent qty has left the
//     source's books; variance is tracked separately as "lost in transit".
//   - Destination: post transfer_in (+recvQty).
//   - Variance: sentQty − recvQty (lost / damaged in transit). Owned by no
//     branch's bin, surfaced in master.transfer_variances for HQ to chase.
//
// Backwards-compat: if received_lines is absent, fall back to receiving
// every item at the sent qty (the old behavior).
router.put('/:id/receive', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Transfer is ${row.status}, not PENDING` });

    const toSlug = row.to_slug;
    const fromSlug = row.from_slug;
    if (!isRegistered(toSlug)) return res.status(400).json({ error: 'Destination branch no longer registered' });

    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch { /* empty */ }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Transfer has no items' });
    }

    // Build a lookup of per-line receive overrides, keyed by product_sync_id.
    const recvLines = Array.isArray(req.body?.received_lines) ? req.body.received_lines : [];
    const recvByPsid = new Map();
    for (const r of recvLines) {
      if (r && r.product_sync_id) recvByPsid.set(r.product_sync_id, r);
    }

    const toDb = getTenantDb(toSlug);
    const receivedBy = req.user.id || null;
    const receivedByName = req.user.firstName || req.user.email || 'Branch';
    let anyVariance = false;
    const varianceInserts = []; // { sync_id, ...row } — pushed to master.db after the tenant tx

    // v1.9.22 — Source-side deduction (deferred from /create). Posts the
    // sentQty as transfer_out so the source's Sales Bin Card finally
    // reflects what physically left. Skipped silently if the source
    // branch isn't registered anymore (rare, but don't block receive).
    //
    // Legacy guard: pre-v1.9.22 PENDING transfers already posted the
    // transfer_out at create time. We detect that via reference_sync_id
    // = row.sync_id on stock_movements and skip the source deduction
    // here to avoid double-counting.
    if (isRegistered(fromSlug)) {
      const fromDb = getTenantDb(fromSlug);
      const alreadyPosted = fromDb.prepare(
        `SELECT 1 FROM stock_movements
          WHERE reference_sync_id = ? AND movement_type = 'transfer_out'
            AND deleted_at IS NULL LIMIT 1`
      ).get(row.sync_id);
      if (alreadyPosted) {
        // Pre-v1.9.22 transfer — source bin already reflects the deduction.
        // Skip re-posting at /receive to preserve the legacy total.
      } else {
      fromDb.transaction(() => {
        const movStmt = fromDb.prepare(`
          INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                       quantity, reference_type, reference_sync_id,
                                       notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                       synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `);
        const upd = fromDb.prepare(`
          UPDATE products SET current_stock = current_stock - ?,
                              updated_at    = datetime('now'),
                              synced        = 0
           WHERE sync_id = ?
        `);
        for (const it of items) {
          const prod = fromDb.prepare(
            'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
          ).get(it.product_sync_id);
          if (!prod) continue; // product no longer at source — skip, variance will catch the gap
          const sentBaseQty = (parseFloat(it.quantity) || 0) * conversionToBase(prod, it.unit);
          if (sentBaseQty <= 0) continue;
          movStmt.run(
            prod.id, prod.sync_id, 'sales', 'transfer_out',
            -sentBaseQty, 'transfer', row.sync_id,
            `Transfer ${row.transfer_number} → ${row.to_name || toSlug} (confirmed)`,
            receivedBy,
            randomUUID(), null, null, null
          );
          upd.run(sentBaseQty, prod.sync_id);
        }
      })();
      }
    }

    // v1.10.55 — WAC redesign push 3: blend delivery cost into destination
    // avg_cost_price. Delivery CP is derived from the transfer's declared
    // FX rate (captured at Send time in v1.10.54). Same formula as HQ GRN
    // generate — never overwrites, always blends.
    //
    // v1.10.181 — WAC redesign push 5 (transfer FX symmetry):
    // Previously the delivery cost was ALWAYS converted to USD, on the
    // assumption that every destination stored WAC in USD. That's true
    // for Kassumbalesa (tri-currency, USD-anchored) but WRONG for
    // Mansa / Lusaka (K-only). A Kassumbalesa→Lusaka transfer of stock
    // costing $10/bottle would land on Lusaka as "K 10/bottle" — deflated
    // by ~25× relative to reality (~K 250/bottle at rate 25). Symptom:
    // Lusaka WAC crashes, next K 300 sale reports huge fake profit.
    //
    // Fix: convert delivery cost to the DESTINATION's WAC currency, not
    // universally to USD. Same shape as hqPurchases.js v1.10.174 —
    // read destination's currency_mode and route accordingly.
    let destIsKOnly = false;
    try {
      const destSettings = toDb.prepare(
        `SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`
      ).get();
      destIsKOnly = String(destSettings?.currency_mode || 'K').toUpperCase() === 'K';
    } catch (_) { /* pre-migration branch DB — assume K-only Liquor default */
      destIsKOnly = true;
    }
    const trCcy  = String(row.cost_currency || '').toUpperCase();
    const trRate = parseFloat(row.fx_rate_used || 0) || 0;
    // Returns the delivery cost in the destination's WAC currency.
    // - K-only dest: convert to K (USD source × rate, or K source as-is)
    // - Multi-ccy dest: convert to USD (K source / rate, or USD source as-is)
    const toDestCcy = (it) => {
      // Prefer the pre-computed field on the item (stored by v1.10.54).
      // Note: cost_price_usd is USD-denominated regardless of transfer
      // currency, so only use it when the destination stores in USD.
      const preUsd = parseFloat(it.cost_price_usd || 0);
      const rawC   = parseFloat(it.cost_price     || 0) || 0;
      if (destIsKOnly) {
        // Destination stores WAC in K.
        if (!trCcy || trCcy === 'K') return rawC;               // K→K, no conversion
        if (trCcy === 'USD') {                                    // USD→K, multiply by rate
          return trRate > 0 ? rawC * trRate : rawC;
        }
        return rawC; // FRA→K or unknown — leave as-is, one-off case
      }
      // Multi-currency dest (Kassumbalesa) stores WAC in USD.
      if (preUsd > 0) return preUsd;
      if (rawC <= 0) return 0;
      if (!trCcy || trCcy === 'USD') return rawC;                // USD→USD, no conversion
      return trRate > 0 ? rawC / trRate : rawC;                  // K→USD, divide by rate
    };
    // v1.10.185 — Landed Cost Voucher absorption for inter-branch transfers.
    // LCVs live on HQ's own DB (backend/sosna.db). Sum unapplied LCVs
    // linked to this transfer, convert to destination currency, spread
    // across received base units. Same shape as hqGrns.js /generate.
    let landedCostPerBaseTotal = 0;
    let lcvSyncIdsToMark = [];
    const hqDb = require('../config/database').defaultDb;
    try {
      if (hqDb) {
        const lcvRows = hqDb.prepare(`
          SELECT sync_id, amount
            FROM payment_vouchers
           WHERE linked_transfer_sync_id = ?
             AND is_landed_cost = 1
             AND deleted_at IS NULL
             AND applied_to_transfer_sync_id IS NULL
        `).all(row.sync_id);
        const totalLandedRaw = lcvRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
        // LCV amount is in HQ's home currency (K). Convert to destination WAC currency.
        //   destIsKOnly=true  → LCV is K, dest is K → no conversion
        //   destIsKOnly=false → LCV is K, dest is USD → divide by transfer rate
        let totalLandedInWacCcy;
        if (destIsKOnly) {
          totalLandedInWacCcy = totalLandedRaw;
        } else {
          totalLandedInWacCcy = trRate > 0 ? totalLandedRaw / trRate : totalLandedRaw;
        }
        // Compute total received base units across all lines (denominator).
        const totalReceivedBase = items.reduce((s, it) => {
          const recvOv = recvByPsid.get(it.product_sync_id);
          const recvQ = recvOv && recvOv.received_qty !== undefined
            ? Math.max(0, parseFloat(recvOv.received_qty) || 0)
            : (parseFloat(it.quantity) || 0);
          if (recvQ <= 0) return s;
          const prodRow = toDb.prepare(
            `SELECT unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ? AND deleted_at IS NULL`
          ).get(it.product_sync_id);
          const cv = prodRow ? conversionToBase(prodRow, it.unit) : 1;
          return s + recvQ * cv;
        }, 0);
        if (totalReceivedBase > 0 && totalLandedInWacCcy > 0) {
          landedCostPerBaseTotal = totalLandedInWacCcy / totalReceivedBase;
        }
        lcvSyncIdsToMark = lcvRows.map(r => r.sync_id);
      }
    } catch (lcvErr) {
      console.warn('[transfers.receive] LCV read failed:', lcvErr.message);
    }

    // v1.10.218 — snapshot per-line received data so the View modal can show
    // reality instead of defaulting Received=Sent. Populated inside the loop,
    // written back onto stock_transfers.items_json after the tx.
    const enrichedItems = [];
    toDb.transaction(() => {
      const movStmt = toDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id,
                                     notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `);
      // v1.10.55 — atomic UPDATE bumps current_stock AND blends
      // avg_cost_price in one statement (same shape as hqGrns.js /generate).
      const upd = toDb.prepare(`
        UPDATE products
           SET current_stock  = current_stock + ?,
               avg_cost_price = CASE
                 WHEN avg_cost_price IS NULL OR current_stock <= 0
                   THEN ?
                 ELSE ROUND(
                   (current_stock * avg_cost_price + ? * ?)
                   / (current_stock + ?), 4)
               END,
               updated_at     = datetime('now'),
               synced         = 0
         WHERE sync_id = ?
      `);

      for (const it of items) {
        let prod = toDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products
           WHERE sync_id = ? AND deleted_at IS NULL
        `).get(it.product_sync_id);

        if (!prod) {
          // v1.10.255 — read destination tenant/branch/device from toDb's own
          // sync_config so the auto-created product row has real identity
          // columns. Before it was NULL, NULL, NULL → the row was invisible
          // to VPS pull (WHERE tenant_id=?) so other devices at the
          // destination branch never saw the new product.
          const cfg = Object.fromEntries(
            toDb.prepare("SELECT key, value FROM sync_config WHERE key IN ('tenant_id','branch_id','device_id')").all()
                .map(r => [r.key, r.value])
          );
          const baseUnit = it.unit || 'pcs';
          const cost     = parseFloat(it.cost_price || 0) || 0;
          const info = toDb.prepare(`
            INSERT INTO products (name, unit, cost_price, selling_price,
                                  current_stock, min_stock, status,
                                  sync_id, tenant_id, branch_id, device_id, synced,
                                  created_at, updated_at)
            VALUES (?,?,?,?,0,0,'Active',?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(
            it.product_name, baseUnit, cost, cost,
            it.product_sync_id, cfg.tenant_id || null, cfg.branch_id || null, cfg.device_id || null
          );
          prod = toDb.prepare(
            'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?'
          ).get(info.lastInsertRowid);
        }

        const sentQty = parseFloat(it.quantity) || 0;
        const recvOverride = recvByPsid.get(it.product_sync_id);
        // v1.10.218 — surface the silent fallback in server logs. Falling
        // back to sentQty silently ate real shortages before (e.g. product
        // resync mismatch → lookup fails → variance never recorded).
        if (!recvOverride) {
          console.warn(`[transfers.receive] no receive-line override for product ${it.product_sync_id} on ${row.transfer_number}; falling back to sent (${sentQty} ${it.unit || ''}). Product sync mismatch?`);
        }
        const recvQty = recvOverride && recvOverride.received_qty !== undefined
          ? Math.max(0, parseFloat(recvOverride.received_qty) || 0)
          : sentQty;  // fallback: receive full
        const reason  = recvOverride?.reason || (recvQty === sentQty ? 'OK' : 'Short');
        const notes   = recvOverride?.notes || null;
        const variance = sentQty - recvQty;
        // v1.10.218 — stash the real received values so we can persist them
        // onto items_json after the tx (see below).
        enrichedItems.push({
          ...it,
          received_qty:   recvQty,
          receive_reason: reason,
          receive_notes:  notes,
        });

        // Only stock-increment for the RECEIVED quantity (not the sent).
        if (recvQty > 0) {
          const baseQty = recvQty * conversionToBase(prod, it.unit);
          movStmt.run(
            prod.id, prod.sync_id, 'sales', 'transfer_in',
            baseQty, 'transfer', row.sync_id,
            `Transfer ${row.transfer_number} ← ${row.from_name || fromSlug}` +
              (variance > 0 ? ` · short ${variance} ${it.unit || ''} (${reason})` : ''),
            receivedBy,
            randomUUID(), null, null, null
          );
          // v1.10.55 → v1.10.181 — WAC blend at destination in the
          // destination's WAC currency. toDestCcy returns USD for
          // Kassumbalesa, K for Mansa/Lusaka (correct denomination for
          // each branch's avg_cost_price column).
          // Transfer items store cost_price per BASE unit (per v1.10.54)
          // so no division-by-conv needed here — unlike hqGrns which
          // stores per-line-unit.
          // v1.10.185 — add per-base landed cost from LCVs linked to this
          // transfer, so delivery cost gets absorbed into the destination's
          // WAC same way it does for PO deliveries at hqGrns.js /generate.
          const goodsCpPerBase = toDestCcy(it);
          const deliveryCp = goodsCpPerBase + landedCostPerBaseTotal;
          upd.run(
            baseQty,
            deliveryCp,
            baseQty, deliveryCp,
            baseQty,
            prod.sync_id
          );
        }

        // Record the variance for HQ to investigate.
        if (variance > 0.0001 || reason === 'Damaged' || reason === 'Lost') {
          anyVariance = true;
          varianceInserts.push({
            sync_id: randomUUID(),
            transfer_sync_id: row.sync_id,
            transfer_number:  row.transfer_number,
            from_slug:        row.from_slug,
            to_slug:          row.to_slug,
            product_sync_id:  it.product_sync_id,
            product_name:     it.product_name,
            unit:             it.unit,
            sent_qty:         sentQty,
            received_qty:     recvQty,
            variance_qty:     variance,
            reason,
            notes,
          });
        }
      }
    })();

    // v1.10.185 — mark LCVs applied so a rerun of the receive endpoint
    // (in the unlikely case) doesn't absorb the same delivery cost twice.
    if (hqDb && Array.isArray(lcvSyncIdsToMark) && lcvSyncIdsToMark.length > 0) {
      try {
        const markLcv = hqDb.prepare(`
          UPDATE payment_vouchers
             SET applied_to_transfer_sync_id = ?,
                 updated_at = datetime('now'),
                 synced = 0
           WHERE sync_id = ? AND applied_to_transfer_sync_id IS NULL
        `);
        for (const sId of lcvSyncIdsToMark) {
          markLcv.run(row.sync_id, sId);
        }
      } catch (lcvMarkErr) {
        console.warn('[transfers.receive] LCV mark-applied failed:', lcvMarkErr.message);
      }
    }

    // Persist variances in master.db (outside the tenant transaction).
    if (varianceInserts.length > 0) {
      const vStmt = masterDb.prepare(`
        INSERT INTO transfer_variances (sync_id, transfer_sync_id, transfer_number,
                                         from_slug, to_slug, product_sync_id, product_name, unit,
                                         sent_qty, received_qty, variance_qty,
                                         reason, notes, received_by, received_by_name)
        VALUES (?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?)
      `);
      const tx = masterDb.transaction(() => {
        for (const v of varianceInserts) {
          vStmt.run(v.sync_id, v.transfer_sync_id, v.transfer_number,
                    v.from_slug, v.to_slug, v.product_sync_id, v.product_name, v.unit,
                    v.sent_qty, v.received_qty, v.variance_qty,
                    v.reason, v.notes, receivedBy, receivedByName);
        }
      });
      tx();
    }

    // v1.10.218 — write received_qty/reason/notes back onto items_json so
    // the View modal shows what was actually received (was defaulting
    // received=sent because items_json only ever held send-time data).
    masterDb.prepare(`
      UPDATE stock_transfers
         SET status = ?,
             received_by = ?,
             received_by_name = ?,
             received_at = datetime('now'),
             items_json = ?
       WHERE id = ?
    `).run(anyVariance ? 'RECEIVED_WITH_VARIANCE' : 'RECEIVED',
           receivedBy, receivedByName, JSON.stringify(enrichedItems), req.params.id);

    const out = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id));
    res.json(out);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// GET /api/transfers/:id/variances — list variance lines for one transfer
router.get('/:id/variances', hqAuth, (req, res) => {
  try {
    const t = masterDb.prepare('SELECT sync_id FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Transfer not found' });
    const rows = masterDb.prepare(
      'SELECT * FROM transfer_variances WHERE transfer_sync_id = ? ORDER BY id ASC'
    ).all(t.sync_id);
    res.json({ variances: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/transfers/:id/cancel — source aborts a PENDING transfer.
// v1.9.22 — Pure status flip now. Source never decremented (deferred to
// /receive), so there's nothing to reverse. Destination never saw it.
router.put('/:id/cancel', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    // v1.10.201 — allow cancel from PENDING or PENDING_HQ (source can
    // pull back before OR during HQ review, since no stock has moved).
    if (!['PENDING', 'PENDING_HQ'].includes(row.status)) return res.status(400).json({ error: `Transfer is ${row.status}, cannot cancel` });

    masterDb.prepare(`UPDATE stock_transfers SET status='CANCELLED' WHERE id=?`).run(req.params.id);

    const out = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id));
    res.json(out);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
