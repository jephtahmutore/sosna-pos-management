/**
 * hqDamages.js — HQ-side view + confirm flow for branch-declared damages.
 *
 * Each branch's sales_returns rows live in that branch's tenant DB. To
 * give HQ a single "Confirm Damages" queue we iterate every registered
 * tenant, pull PENDING rows, and present them as one list. Confirm /
 * reject endpoints take a slug + id and open that branch's DB to act.
 *
 * Stock decrement + profit recalc only happen on CONFIRM, mirroring the
 * v1.3.0 HQ purchase flow. Branches can't take damages off their own
 * stock without HQ approval — that's the whole point of the v1.3.1 spec.
 *
 * Auth: hqAuth (JWT) — same model as the rest of /api/hq/*.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { listTenants, isRegistered } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { conversionToBase } = require('../config/unitsHelper');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { randomUUID } = require('crypto');

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

function safeAll(fn) { try { return fn() || []; } catch { return []; } }

// GET /api/hq/damages/awaiting — every PENDING declaration across branches.
// Returns header + item list + estimated value (qty × cost_price snapshot)
// so the operator can size up the variance before clicking Confirm.
router.get('/awaiting', hqAuth, (req, res) => {
  try {
    const tenants = listTenants();
    const rows = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = (() => { try { return db.prepare(`SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1`).get(); } catch { return {}; } })();
        const branchName = settings?.business_name || t.business_name || t.slug;
        const headers = safeAll(() => db.prepare(`
          SELECT id, return_number, date, notes, total_items, created_by, sync_id, created_at,
                 (SELECT TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,''))
                    FROM users u WHERE u.id = sales_returns.created_by) AS created_by_name
            FROM sales_returns
           WHERE deleted_at IS NULL AND status = 'PENDING'
           ORDER BY date DESC, id DESC
           LIMIT 200
        `).all());
        for (const h of headers) {
          const items = safeAll(() => db.prepare(`
            SELECT sri.id, sri.quantity, sri.unit, sri.product_sync_id,
                   p.name AS product_name, p.unit AS product_unit,
                   p.cost_price, p.alt_unit, p.conversion_factor, p.units_json
              FROM sales_return_items sri
              LEFT JOIN products p ON p.sync_id = sri.product_sync_id
              WHERE sri.return_sync_id = ? AND sri.deleted_at IS NULL
          `).all(h.sync_id));
          const estValue = items.reduce((sum, it) => sum + (parseFloat(it.quantity) || 0) * (parseFloat(it.cost_price) || 0), 0);
          rows.push({
            ...h,
            branch_slug: t.slug,
            branch_name: branchName,
            items,
            est_value: estValue,
          });
        }
      } catch (e) {
        // Skip broken branches silently — they just won't appear in the list.
        console.error(`[hq.damages] ${t.slug}:`, e.message);
      }
    }
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ damages: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/damages/:slug/:id/confirm — HQ approves a branch declaration.
// Opens the named branch DB, mirrors the per-branch /confirm logic
// (stock decrement + profit recalc), and stamps the master line as
// CONFIRMED with the HQ user's audit trail.
router.put('/:slug/:id/confirm', hqAuth, (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!isRegistered(slug)) return res.status(404).json({ error: 'Branch not found' });
    const db = getTenantDb(slug);

    const ret = db.prepare('SELECT * FROM sales_returns WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!ret) return res.status(404).json({ error: 'Damage not found' });
    if (ret.status !== 'PENDING') return res.status(400).json({ error: `Damage is ${ret.status}, not PENDING` });

    const items = db.prepare(`
      SELECT sri.*, p.unit AS product_base_unit, p.alt_unit, p.conversion_factor, p.units_json
        FROM sales_return_items sri
        LEFT JOIN products p ON p.sync_id = sri.product_sync_id
       WHERE sri.return_sync_id = ? AND sri.deleted_at IS NULL
    `).all(ret.sync_id);

    const confirmedBy = req.user.id || null;
    const confirmedByName = req.user.firstName || req.user.email || 'HQ';

    db.transaction(() => {
      for (const it of items) {
        const prod = { unit: it.product_base_unit, alt_unit: it.alt_unit, conversion_factor: it.conversion_factor, units_json: it.units_json };
        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, it.unit);
        db.prepare(`
          INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                       quantity, reference_id, reference_type, notes,
                                       created_by, sync_id, tenant_id, branch_id, device_id, synced,
                                       created_at, updated_at, reference_sync_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
        `).run(
          it.product_id, it.product_sync_id, 'sales', 'sales_return', -baseQty,
          ret.id, 'sales_return', ret.notes || null,
          confirmedBy, randomUUID(), ret.tenant_id, ret.branch_id, ret.device_id,
          ret.date, ret.sync_id
        );
      }
      db.prepare(`
        UPDATE sales_returns
           SET status = 'CONFIRMED',
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now'),
               confirm_notes = ?, synced = 0
         WHERE id = ?
      `).run(confirmedBy, confirmedByName, req.body?.confirm_notes || null, req.params.id);
    })();

    recalculateDailyProfit(db, ret.date, ret.tenant_id);
    res.json(db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/damages/:slug/:id/reject — HQ rejects; status REJECTED,
// confirm_notes captures the reason so the branch knows why. Stock is
// never touched. Branch can recreate a fresh declaration if needed.
router.put('/:slug/:id/reject', hqAuth, (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!isRegistered(slug)) return res.status(404).json({ error: 'Branch not found' });
    const db = getTenantDb(slug);

    const ret = db.prepare('SELECT * FROM sales_returns WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!ret) return res.status(404).json({ error: 'Damage not found' });
    if (ret.status !== 'PENDING') return res.status(400).json({ error: `Damage is ${ret.status}, not PENDING` });

    const confirmedBy = req.user.id || null;
    const confirmedByName = req.user.firstName || req.user.email || 'HQ';
    db.prepare(`
      UPDATE sales_returns
         SET status = 'REJECTED',
             confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now'),
             confirm_notes = ?, synced = 0
       WHERE id = ?
    `).run(confirmedBy, confirmedByName, req.body?.confirm_notes || 'Rejected at HQ', req.params.id);
    res.json(db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
