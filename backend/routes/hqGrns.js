/**
 * hqGrns.js — HQ-side review of branch GRNs that were generated from a
 * HQ PO (v1.9.7 procurement flow).
 *
 * Lifecycle recap:
 *   1. HQ creates PO at /api/hq/purchases (lines target branches).
 *   2. Branch sees PO in "Incoming Stock" queue → clicks "Accept &
 *      Generate GRN" → opens a normal GRN form with PO# pre-filled.
 *   3. Branch fills the GRN with invoice qty + credit notes, saves.
 *      The GRN is stored at the branch DB with hq_status='PENDING_HQ_CONFIRM';
 *      the parent PO line flips from AWAITING_GRN → GRN_SUBMITTED in
 *      master.db. NO stock has moved yet — that's HQ's job.
 *   4. HQ opens /api/hq/grns/awaiting (this file's GET endpoint), sees
 *      every branch's pending GRN, opens the full doc, and either:
 *         /confirm  → posts stock at branch location='sales', updates
 *                     the linked PO lines to CONFIRMED, locks supplier AP.
 *         /reject   → resets hq_status, sends the GRN back to the branch
 *                     for re-entry (PO line flips back to AWAITING_GRN
 *                     so branch can create a fresh GRN).
 *
 * Auth: hqAuth (JWT), same model as routes/hq.js + routes/hqPurchases.js.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { conversionToBase } = require('../config/unitsHelper');

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

// GET /api/hq/grns/awaiting
// Lists every branch's GRNs that are sitting at hq_status='PENDING_HQ_CONFIRM',
// grouped/sorted newest first. One row per GRN with summary totals + the
// originating PO# so HQ can quickly fan through the queue.
router.get('/awaiting', hqAuth, (req, res) => {
  try {
    const tenants = listTenants();
    const rows = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const grns = db.prepare(`
          SELECT g.id, g.grn_number, g.sync_id, g.date, g.total_items, g.total_amount,
                 g.notes, g.linked_purchase_sync_id, g.linked_purchase_number,
                 g.created_at, g.created_by,
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS created_by_name,
                 s.name AS supplier_name
            FROM grn g
            LEFT JOIN users u     ON u.id = g.created_by
            LEFT JOIN suppliers s ON s.id = g.supplier_id
           WHERE g.deleted_at IS NULL
             AND g.hq_status = 'PENDING_HQ_CONFIRM'
           ORDER BY g.created_at DESC
        `).all();
        for (const g of grns) rows.push({ ...g, branch_slug: t.slug, branch_name: t.business_name || t.slug });
      } catch (e) {
        console.error(`[hq.grns.awaiting] ${t.slug}:`, e.message);
      }
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ grns: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.10.0 — /receipt/:syncId + /awaiting-generation are declared here so
// they win over the wildcard /:slug/:syncId below (Express matches in
// order — a 2-segment specific must precede a 2-segment wildcard, else
// the wildcard swallows "receipt" as if it were a branch slug).
router.get('/awaiting-generation', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ purchases: [] });
    const rows = masterDb.prepare(`
      SELECT p.*,
             (SELECT COUNT(*) FROM hq_purchase_items i
               WHERE i.purchase_sync_id = p.sync_id
                 AND i.status = 'RECEIPT_REPORTED') AS reported_count,
             (SELECT COUNT(*) FROM hq_purchase_items i
               WHERE i.purchase_sync_id = p.sync_id) AS items_count,
             (SELECT COUNT(*) FROM hq_purchase_receipt_extras e
               WHERE e.purchase_sync_id = p.sync_id) AS extras_count
        FROM hq_purchases p
       WHERE p.confirmed_at_branch IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM hq_purchase_items i
            WHERE i.purchase_sync_id = p.sync_id
              AND i.status = 'RECEIPT_REPORTED'
         )
       ORDER BY p.confirmed_at_branch DESC
    `).all();
    res.json({ purchases: rows });
  } catch (error) {
    console.error('[hq.grns.awaiting-generation]', error);
    res.status(500).json({ error: error.message });
  }
});

// v1.10.3 — Full doc for a v1.10.0 HQ-generated GRN. Reads master.db only
// (no branch DB round-trip). Declared above the /:slug/:syncId wildcard so
// Express matches "/hq/<uuid>" here instead of treating "hq" as a slug.
router.get('/hq/:syncId', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(404).json({ error: 'master.db unavailable' });
    const syncId = req.params.syncId;
    const grn = masterDb.prepare(`SELECT * FROM hq_grns WHERE sync_id = ? AND deleted_at IS NULL`).get(syncId);
    if (!grn) return res.status(404).json({ error: 'HQ GRN not found.' });
    const items = masterDb.prepare(
      `SELECT * FROM hq_grn_items WHERE grn_sync_id = ? ORDER BY id ASC`
    ).all(syncId);
    let credit_notes = [];
    try {
      credit_notes = masterDb.prepare(`
        SELECT id, credit_note_number, reason, amount, notes, date, reference
          FROM hq_supplier_credit_notes
         WHERE grn_sync_id = ? AND deleted_at IS NULL
         ORDER BY id ASC
      `).all(syncId);
    } catch { /* table may not exist on old DBs */ }
    res.json({ grn: { ...grn, grn_sync_id: grn.sync_id }, items, credit_notes });
  } catch (error) {
    console.error('[hq.grns.hq-detail]', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipt/:syncId', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(404).json({ error: 'master.db unavailable' });
    const syncId = req.params.syncId;
    const purchase = masterDb.prepare(`SELECT * FROM hq_purchases WHERE sync_id = ?`).get(syncId);
    if (!purchase) return res.status(404).json({ error: 'PO not found.' });
    const items = masterDb.prepare(
      `SELECT * FROM hq_purchase_items WHERE purchase_sync_id = ? ORDER BY id ASC`
    ).all(syncId);
    const extras = masterDb.prepare(
      `SELECT * FROM hq_purchase_receipt_extras WHERE purchase_sync_id = ? ORDER BY id ASC`
    ).all(syncId);
    res.json({ purchase, items, extras });
  } catch (error) {
    console.error('[hq.grns.receipt]', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/grns/:slug/:syncId
// Full GRN doc (header + line items) for the HQ review modal. The branch
// slug is in the path so we know which tenant DB to open without scanning
// every branch.
router.get('/:slug/:syncId', hqAuth, (req, res) => {
  try {
    const { slug, syncId } = req.params;
    if (!isRegistered(slug)) return res.status(404).json({ error: `Branch "${slug}" not registered.` });
    const db = getTenantDb(slug);
    const grn = db.prepare(`
      SELECT g.*,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS created_by_name,
             s.name AS supplier_name
        FROM grn g
        LEFT JOIN users u     ON u.id = g.created_by
        LEFT JOIN suppliers s ON s.id = g.supplier_id
       WHERE g.sync_id = ? AND g.deleted_at IS NULL
    `).get(syncId);
    if (!grn) return res.status(404).json({ error: 'GRN not found.' });
    const items = db.prepare(`
      SELECT gi.*, p.name AS product_name, p.code AS product_code, p.unit AS product_base_unit
        FROM grn_items gi
        LEFT JOIN products p ON p.id = gi.product_id
       WHERE gi.grn_sync_id = ? AND gi.deleted_at IS NULL
       ORDER BY gi.id ASC
    `).all(syncId);
    // v1.9.14 — also return credit notes attached to this GRN so the
    // HQ See Details modal can show them. supplier_credit_notes was
    // linked via grn_sync_id in v1.9.13.
    let credit_notes = [];
    try {
      credit_notes = db.prepare(`
        SELECT id, credit_note_number, reason, amount, notes, date, reference
          FROM supplier_credit_notes
         WHERE grn_sync_id = ? AND deleted_at IS NULL
         ORDER BY id ASC
      `).all(syncId);
    } catch { /* table may not have the column yet on very old DBs */ }
    res.json({ grn: { ...grn, branch_slug: slug }, items, credit_notes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/grns/:slug/:syncId/confirm
// HQ approves the branch GRN. Two side-effects, both in the BRANCH tenant DB:
//   (a) Post a stock_movement per GRN line at location='sales' (Sosna has
//       no store layer; product current_stock is incremented in the same
//       transaction so the sales floor shows the new stock immediately).
//   (b) Flip the parent PO line(s) at master.db from GRN_SUBMITTED →
//       CONFIRMED, stamping the HQ confirmer.
// Marking grn.hq_status='CONFIRMED' is the third step (in branch DB).
// All three are wrapped so a failure at any step rolls back cleanly.
router.post('/:slug/:syncId/confirm', hqAuth, (req, res) => {
  try {
    const { slug, syncId } = req.params;
    const { notes } = req.body || {};
    if (!isRegistered(slug)) return res.status(404).json({ error: `Branch "${slug}" not registered.` });
    const db = getTenantDb(slug);

    const grn = db.prepare(`SELECT * FROM grn WHERE sync_id = ? AND deleted_at IS NULL`).get(syncId);
    if (!grn) return res.status(404).json({ error: 'GRN not found.' });
    if (grn.hq_status !== 'PENDING_HQ_CONFIRM') {
      return res.status(400).json({ error: `GRN hq_status is ${grn.hq_status} — only PENDING_HQ_CONFIRM GRNs can be confirmed.` });
    }

    const items = db.prepare(`SELECT * FROM grn_items WHERE grn_sync_id = ? AND deleted_at IS NULL`).all(syncId);
    if (items.length === 0) return res.status(400).json({ error: 'GRN has no line items.' });

    const confirmerName = req.user.firstName || req.user.email || 'HQ';

    db.transaction(() => {
      // Per-line stock movements at sales floor + current_stock bump.
      // Same pattern as legacy GRN POST but always location='sales',
      // and created_by=NULL because HQ users don't exist in branch users.
      const movementCreatedAt = (grn.date || new Date().toISOString().slice(0,10)) + ' ' + new Date().toTimeString().slice(0,8);
      for (const it of items) {
        const prod = db.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json, container_product_sync_id
            FROM products WHERE sync_id = ? AND deleted_at IS NULL
        `).get(it.product_sync_id);
        if (!prod) continue; // line points at a deleted product — skip rather than crash

        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, it.unit || prod.unit);
        db.prepare(`
          UPDATE products SET current_stock = current_stock + ?,
                              updated_at    = datetime('now'),
                              synced        = 0
           WHERE sync_id = ?
        `).run(baseQty, prod.sync_id);

        db.prepare(`
          INSERT INTO stock_movements
            (product_id, product_sync_id, location, movement_type, quantity,
             reference_id, reference_type, reference_sync_id, notes,
             created_by, sync_id, tenant_id, branch_id, device_id,
             synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'))
        `).run(
          prod.id, prod.sync_id, 'sales', 'grn', baseQty,
          grn.id, 'grn', grn.sync_id,
          `HQ-confirmed GRN ${grn.grn_number}${notes ? ' — ' + notes : ''}`,
          null,
          randomUUID(), grn.tenant_id, grn.branch_id, grn.device_id,
          movementCreatedAt
        );

        // Container settlement (returnables) — same as legacy GRN POST.
        const recv = parseFloat(it.containers_received || 0);
        const ret  = parseFloat(it.containers_returned || 0);
        const delta = recv - ret;
        if (it.container_product_sync_id && Math.abs(delta) > 0.001) {
          const cprod = db.prepare(`SELECT id FROM products WHERE sync_id = ?`).get(it.container_product_sync_id);
          db.prepare(`
            INSERT INTO stock_movements
              (product_id, product_sync_id, location, movement_type, quantity,
               reference_id, reference_type, reference_sync_id, notes,
               created_by, sync_id, tenant_id, branch_id, device_id,
               synced, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'))
          `).run(
            cprod?.id || null, it.container_product_sync_id, 'sales', 'grn', delta,
            grn.id, 'grn', grn.sync_id,
            `Container settlement via ${grn.grn_number}`,
            null,
            randomUUID(), grn.tenant_id, grn.branch_id, grn.device_id,
            movementCreatedAt
          );
        }
      }

      // Mark the GRN as confirmed at the branch.
      db.prepare(`
        UPDATE grn
           SET hq_status            = 'CONFIRMED',
               hq_confirmed_by      = ?,
               hq_confirmed_by_name = ?,
               hq_confirmed_at      = datetime('now'),
               updated_at           = datetime('now'),
               synced               = 0
         WHERE sync_id = ?
      `).run(req.user.id || null, confirmerName, syncId);
    })();

    // v1.9.14 — write the HQ snapshot row so HQ reports + AP run on
    // master.db alone. Full GRN doc stays at the branch; HQ pulls via
    // the existing GET /api/hq/grns/:slug/:syncId when a user clicks
    // "See Details". Pull CN total from supplier_credit_notes by GRN
    // link so the snapshot's payable matches what HQ owes the supplier.
    if (masterDb) {
      try {
        const cnTotal = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS t
            FROM supplier_credit_notes
           WHERE grn_sync_id = ? AND deleted_at IS NULL
        `).get(grn.sync_id)?.t || 0;
        const itemsSubtotal = parseFloat(grn.total_amount) || 0;
        const finalPayable  = Math.max(0, itemsSubtotal - (parseFloat(cnTotal) || 0));
        // Branch + supplier display names (denormalised so HQ pages don't
        // have to re-join).
        const branchName    = (listTenants().find(t => t.slug === slug)?.business_name) || slug;
        const supplierName  = grn.supplier_name || (db.prepare('SELECT name FROM suppliers WHERE id = ?').get(grn.supplier_id)?.name) || null;
        const poNumber      = grn.linked_purchase_number || null;
        masterDb.prepare(`
          INSERT OR REPLACE INTO hq_confirmed_grn_totals (
            grn_sync_id, grn_number, branch_slug, branch_name,
            supplier_id, supplier_sync_id, supplier_name,
            po_sync_id, po_number, date, items_count,
            items_subtotal, cn_total, final_payable,
            invoice_number, confirmed_by, confirmed_by_name, confirmed_at, notes
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
        `).run(
          grn.sync_id, grn.grn_number, slug, branchName,
          grn.supplier_id || null, grn.supplier_sync_id || null, supplierName,
          grn.linked_purchase_sync_id || null, poNumber, grn.date || null,
          parseInt(grn.total_items) || items.length,
          itemsSubtotal, cnTotal, finalPayable,
          grn.supplier_invoice_number || null,
          req.user.id || null, confirmerName, notes || null
        );
      } catch (err) {
        // Snapshot is best-effort: branch stock + master.db PO status are
        // already committed above. Drift can be fixed manually with a
        // re-run. Don't fail the confirm response over a snapshot hiccup.
        console.error('[hq.grns.confirm] snapshot insert failed:', err.message);
      }
    }

    // Flip the parent PO line(s) at master.db. Done outside the branch
    // transaction because masterDb is a separate connection.
    if (masterDb && grn.linked_purchase_sync_id) {
      try {
        masterDb.prepare(`
          UPDATE hq_purchase_items
             SET status              = 'CONFIRMED',
                 confirmed_by        = ?,
                 confirmed_by_name   = ?,
                 confirmed_at        = datetime('now'),
                 confirm_notes       = ?
           WHERE purchase_sync_id = ?
             AND status = 'GRN_SUBMITTED'
             AND linked_grn_sync_id = ?
        `).run(req.user.id || null, confirmerName, notes || null, grn.linked_purchase_sync_id, grn.sync_id);

        // Auto-promote header.
        const headerRow = masterDb.prepare(`SELECT id, purchase_id FROM hq_purchase_items WHERE linked_grn_sync_id = ? LIMIT 1`).get(grn.sync_id);
        if (headerRow?.purchase_id) {
          const cnt = masterDb.prepare(`
            SELECT SUM(CASE WHEN status IN ('AWAITING_GRN','GRN_SUBMITTED') THEN 1 ELSE 0 END) AS open,
                   SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) AS confirmed
              FROM hq_purchase_items WHERE purchase_id = ?
          `).get(headerRow.purchase_id);
          if ((cnt.open || 0) === 0) {
            masterDb.prepare(`UPDATE hq_purchases SET status = ?, updated_at = datetime('now') WHERE id = ?`)
              .run((cnt.confirmed || 0) > 0 ? 'COMPLETED' : 'CANCELLED', headerRow.purchase_id);
          }
        }
      } catch (err) {
        // Branch-side stock is already committed at this point. Log and
        // continue — HQ Purchases status drift is recoverable manually.
        console.error('[hq.grns.confirm] master.db update failed (branch stock already posted):', err.message);
      }
    }

    res.json({ ok: true, grn: db.prepare(`SELECT * FROM grn WHERE sync_id = ?`).get(syncId) });
  } catch (error) {
    console.error('[hq.grns.confirm] CRASH:', error.stack || error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/grns/:slug/:syncId/reject
// HQ sends the GRN back to the branch for re-entry. Branch's GRN gets
// hq_status='REJECTED' (visible on their GRN list with the reason).
// Parent PO line(s) at master.db flip back from GRN_SUBMITTED →
// AWAITING_GRN so the branch can create a fresh GRN from the PO again.
// The rejected GRN itself is NOT deleted — it stays as an audit record.
//
// Body: { reason } — required, surfaced on the branch GRN list.
router.post('/:slug/:syncId/reject', hqAuth, (req, res) => {
  try {
    const { slug, syncId } = req.params;
    const reason = ((req.body && req.body.reason) || '').toString().trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });
    if (!isRegistered(slug)) return res.status(404).json({ error: `Branch "${slug}" not registered.` });
    const db = getTenantDb(slug);

    const grn = db.prepare(`SELECT * FROM grn WHERE sync_id = ? AND deleted_at IS NULL`).get(syncId);
    if (!grn) return res.status(404).json({ error: 'GRN not found.' });
    if (grn.hq_status !== 'PENDING_HQ_CONFIRM') {
      return res.status(400).json({ error: `GRN hq_status is ${grn.hq_status} — only PENDING_HQ_CONFIRM GRNs can be rejected.` });
    }

    db.prepare(`
      UPDATE grn
         SET hq_status        = 'REJECTED',
             hq_reject_reason = ?,
             updated_at       = datetime('now'),
             synced           = 0
       WHERE sync_id = ?
    `).run(reason, syncId);

    if (masterDb && grn.linked_purchase_sync_id) {
      try {
        masterDb.prepare(`
          UPDATE hq_purchase_items
             SET status              = 'AWAITING_GRN',
                 linked_grn_sync_id  = NULL,
                 received_by         = NULL,
                 received_by_name    = NULL,
                 received_at         = NULL,
                 confirm_notes       = ?
           WHERE purchase_sync_id = ?
             AND status = 'GRN_SUBMITTED'
             AND linked_grn_sync_id = ?
        `).run(`HQ rejected GRN ${grn.grn_number}: ${reason}`, grn.linked_purchase_sync_id, grn.sync_id);
      } catch (err) {
        console.error('[hq.grns.reject] master.db reset failed:', err.message);
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[hq.grns.reject] CRASH:', error.stack || error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/grns/archive
// v1.9.14 — HQ-wide list of CONFIRMED GRNs, served entirely from the
// master.db snapshot table. Supports filters via query string:
//   ?branch=slug      one branch only (default: all)
//   ?supplier=syncId  one supplier only (default: all)
//   ?from=YYYY-MM-DD  inclusive lower bound on date
//   ?to=YYYY-MM-DD    inclusive upper bound on date
//   ?limit=N          row cap (default 500, max 2000)
// Returns rows + roll-up totals so the page header can show
// "X GRNs / $Y payable" without a second query.
router.get('/archive', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ grns: [], totals: { count: 0, subtotal: 0, cn: 0, payable: 0 } });
    const { branch, supplier, from, to } = req.query || {};
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

    // v1.10.3 — UNION legacy + new-flow GRNs. Legacy live in
    // hq_confirmed_grn_totals (branch-generated, HQ-confirmed); new-flow
    // live in hq_grns (HQ-generated end-to-end). Both feed the same page.
    const legacyWhere = ['1=1'];
    const legacyParams = [];
    if (branch && branch !== 'all')     { legacyWhere.push('branch_slug = ?');      legacyParams.push(branch); }
    if (supplier && supplier !== 'all') { legacyWhere.push('supplier_sync_id = ?'); legacyParams.push(supplier); }
    if (from) { legacyWhere.push('date >= ?'); legacyParams.push(from); }
    if (to)   { legacyWhere.push('date <= ?'); legacyParams.push(to); }
    const legacyRows = masterDb.prepare(`
      SELECT
        grn_sync_id, grn_number, branch_slug, branch_name,
        supplier_id, supplier_sync_id, supplier_name,
        po_sync_id, po_number, date, items_count,
        items_subtotal, cn_total, final_payable,
        invoice_number, NULL AS invoice_attachment,
        confirmed_by, confirmed_by_name, confirmed_at, notes,
        'legacy' AS source
      FROM hq_confirmed_grn_totals
      WHERE ${legacyWhere.join(' AND ')}
      ORDER BY confirmed_at DESC
      LIMIT ?
    `).all(...legacyParams, limit);

    const newWhere = ['deleted_at IS NULL'];
    const newParams = [];
    if (branch && branch !== 'all')     { newWhere.push('branch_slug = ?');  newParams.push(branch); }
    // hq_grns has no supplier_sync_id column — filter by supplier_id if the
    // caller sent an integer, else fall back to a name-match against
    // hq_confirmed_grn_totals's supplier_name for the same sync_id.
    if (supplier && supplier !== 'all') {
      const supName = masterDb.prepare(`SELECT supplier_name FROM hq_confirmed_grn_totals WHERE supplier_sync_id = ? LIMIT 1`).get(supplier)?.supplier_name;
      if (supName) { newWhere.push('supplier_name = ?'); newParams.push(supName); }
      else         { newWhere.push('1 = 0'); }
    }
    if (from) { newWhere.push('date >= ?'); newParams.push(from); }
    if (to)   { newWhere.push('date <= ?'); newParams.push(to); }
    const newRows = masterDb.prepare(`
      SELECT
        g.sync_id AS grn_sync_id, g.grn_number, g.branch_slug, g.branch_name,
        g.supplier_id, NULL AS supplier_sync_id, g.supplier_name,
        g.po_sync_id, g.po_number, g.date,
        (SELECT COUNT(*) FROM hq_grn_items WHERE grn_sync_id = g.sync_id) AS items_count,
        g.items_subtotal, g.cn_total, g.final_payable,
        g.supplier_invoice_number AS invoice_number, g.invoice_attachment,
        g.generated_by_hq AS confirmed_by,
        g.generated_by_hq_name AS confirmed_by_name,
        g.generated_at AS confirmed_at,
        g.notes,
        'hq' AS source
      FROM hq_grns g
      WHERE ${newWhere.join(' AND ')}
      ORDER BY g.generated_at DESC
      LIMIT ?
    `).all(...newParams, limit);

    // Merge, dedupe by grn_sync_id (new-flow wins), sort by confirmed_at DESC.
    const bySyncId = new Map();
    for (const r of legacyRows) bySyncId.set(r.grn_sync_id, r);
    for (const r of newRows)    bySyncId.set(r.grn_sync_id, r);
    const grns = Array.from(bySyncId.values())
      .sort((a, b) => String(b.confirmed_at || '').localeCompare(String(a.confirmed_at || '')))
      .slice(0, limit);

    const totals = grns.reduce((acc, g) => {
      acc.count    += 1;
      acc.subtotal += parseFloat(g.items_subtotal) || 0;
      acc.cn       += parseFloat(g.cn_total)       || 0;
      acc.payable  += parseFloat(g.final_payable)  || 0;
      return acc;
    }, { count: 0, subtotal: 0, cn: 0, payable: 0 });
    res.json({ grns, totals });
  } catch (error) {
    console.error('[hq.grns.archive] failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── v1.10.0 — HQ generates the GRN from a branch's confirmed receipt ────────
// (GET /awaiting-generation and /receipt/:syncId are declared near the top
// of this file so they win over the /:slug/:syncId wildcard.)

// POST /api/hq/grns/generate
// Body: {
//   purchase_sync_id,
//   date,
//   notes?,
//   items: [{ product_sync_id, product_name, unit, quantity, unit_price,
//             expiry_date?, is_extra, po_expected_qty? }],
//   credit_notes: [{ reason, amount, notes? }]   // optional in v1.10.0
// }
// Side-effects:
//   1. Inserts hq_grns + hq_grn_items at master.db
//   2. Posts +qty stock_movements + current_stock at the branch tenant DB
//      (location='sales' — Sosna's no-store model)
//   3. Updates linked hq_purchase_items.status = 'CONFIRMED', stamps audit
//   4. Persists CNs at hq_supplier_credit_notes if provided
router.post('/generate', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(500).json({ error: 'master.db unavailable' });
    const {
      purchase_sync_id,
      date,
      notes,
      items,
      credit_notes,
    } = req.body || {};
    if (!purchase_sync_id) return res.status(400).json({ error: 'purchase_sync_id required' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required.' });
    }

    const purchase = masterDb.prepare(`SELECT * FROM hq_purchases WHERE sync_id = ?`).get(purchase_sync_id);
    if (!purchase) return res.status(404).json({ error: 'PO not found.' });
    if (!purchase.confirmed_at_branch) {
      return res.status(400).json({ error: 'Branch has not confirmed receipt for this PO yet.' });
    }
    if (!purchase.supplier_invoice_number) {
      return res.status(400).json({ error: 'Branch did not record a supplier invoice number.' });
    }

    const branchSlug = purchase.confirmed_branch_slug || '';
    if (!branchSlug || !isRegistered(branchSlug)) {
      return res.status(400).json({ error: 'Branch tenant not registered or missing.' });
    }
    const branchName = (listTenants().find(t => t.slug === branchSlug)?.business_name) || branchSlug;

    const grnSyncId = randomUUID();
    const grnNumber = `GRN-${new Date().getFullYear()}-${String(Date.now()).slice(-8)}`;
    const grnDate = date || new Date().toISOString().slice(0, 10);
    const validItems = items.filter(i => parseFloat(i.quantity) > 0);
    const itemsSubtotal = validItems.reduce((s, i) =>
      s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
    // v1.10.67 — cnTotal recomputed server-side per CN. Stock-affecting
    // reasons ignore c.amount and use Σ qty × unit_value from items[]
    // instead; money-only reasons take c.amount. Prevents a malformed
    // client payload from booking a mismatched final_payable.
    const cnTotal = Array.isArray(credit_notes)
      ? credit_notes.reduce((s, c) => {
          const reason = String(c?.reason || 'Other');
          const stockR = reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
          if (stockR) {
            const items = Array.isArray(c.items) ? c.items : [];
            return s + items.reduce((a, i) => a + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_value) || 0), 0);
          }
          return s + (Math.abs(parseFloat(c.amount || 0)) || 0);
        }, 0)
      : 0;
    const finalPayable = Math.max(0, itemsSubtotal - cnTotal);

    const generatorId   = req.user?.id || null;
    const generatorName = req.user?.firstName || req.user?.email || 'HQ';

    // v1.10.67 — filled inside the master tx below with per-CN metadata
    // for stock-affecting reasons; walked over outside the tx to post
    // negative stock_movements on the branch tenant DB.
    const returnCnBundle = [];

    masterDb.transaction(() => {
      // 1. Insert hq_grns + hq_grn_items
      const info = masterDb.prepare(`
        INSERT INTO hq_grns
          (grn_number, sync_id, date, branch_slug, branch_name,
           supplier_id, supplier_name, po_sync_id, po_number,
           supplier_invoice_number, invoice_attachment,
           items_subtotal, cn_total, final_payable, notes,
           confirmed_by_branch, confirmed_by_branch_name, confirmed_at_branch,
           generated_by_hq, generated_by_hq_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        grnNumber, grnSyncId, grnDate, branchSlug, branchName,
        purchase.supplier_id || null, purchase.supplier_name || null,
        purchase_sync_id, purchase.purchase_number,
        purchase.supplier_invoice_number, purchase.invoice_attachment || null,
        itemsSubtotal, cnTotal, finalPayable, notes || null,
        purchase.confirmed_by_branch, purchase.confirmed_by_branch_name, purchase.confirmed_at_branch,
        generatorId, generatorName
      );
      const grnId = info.lastInsertRowid;

      const insItem = masterDb.prepare(`
        INSERT INTO hq_grn_items
          (sync_id, grn_id, grn_sync_id, product_sync_id, product_name, unit,
           quantity, unit_price, total_price, expiry_date, is_extra, po_expected_qty)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const it of validItems) {
        const qty   = parseFloat(it.quantity) || 0;
        const price = parseFloat(it.unit_price) || 0;
        insItem.run(
          randomUUID(), grnId, grnSyncId,
          it.product_sync_id || null,
          it.product_name || '',
          it.unit || null,
          qty, price, qty * price,
          it.expiry_date || null,
          it.is_extra ? 1 : 0,
          it.po_expected_qty != null ? parseFloat(it.po_expected_qty) : null
        );
      }

      // 2. Update PO lines → CONFIRMED, copy the GRN link onto them
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status              = 'CONFIRMED',
               linked_grn_sync_id  = ?,
               linked_grn_number   = ?,
               confirmed_by        = ?,
               confirmed_by_name   = ?,
               confirmed_at        = datetime('now')
         WHERE purchase_sync_id = ?
           AND status = 'RECEIPT_REPORTED'
      `).run(grnSyncId, grnNumber, generatorId, generatorName, purchase_sync_id);

      // 3. CNs (if any)
      // v1.10.67 — Stock-affecting reasons (Crate Return, Bottle Return,
      // Goods Return) now carry an items[] array; each item row goes into
      // hq_supplier_credit_note_items and the branch tenant DB gets a
      // negative stock_movement (posted outside the master tx below, same
      // pattern as the main GRN item post). Money-only reasons (Discount,
      // Damaged, Short, Other) skip item persistence and just carry
      // cn.amount. Mirrors routes/grn.js:259-320 on the branch side.
      // returnCnBundle (declared above the tx) collects per-CN metadata
      // that the branch stock post walks over further down, outside the
      // master tx.
      if (Array.isArray(credit_notes)) {
        const insCn = masterDb.prepare(`
          INSERT INTO hq_supplier_credit_notes
            (credit_note_number, sync_id, date, supplier_id, supplier_sync_id, supplier_name,
             reason, reference, amount, notes, grn_sync_id, branch_slug,
             created_by, created_by_name)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        const insCnItem = masterDb.prepare(`
          INSERT INTO hq_supplier_credit_note_items
            (sync_id, credit_note_id, credit_note_sync_id, product_sync_id, product_name,
             quantity, unit, unit_conv, unit_value, total_price)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `);
        for (const cn of credit_notes) {
          const reason = String(cn?.reason || 'Other');
          const reasonHasStock = reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
          const validCnItems = reasonHasStock && Array.isArray(cn.items)
            ? cn.items.filter(i => i.product_sync_id && parseFloat(i.quantity) > 0)
            : [];
          // Server-authoritative amount: for stock-affecting CNs we recompute
          // from the items so the client can't send a mismatched total.
          const amt = reasonHasStock
            ? validCnItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.unit_value || 0), 0)
            : Math.abs(parseFloat(cn?.amount || 0)) || 0;
          if (amt < 0.001) continue;
          if (reasonHasStock && validCnItems.length === 0) continue;
          const cnNumber = `SCN-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
          const cnSyncId = randomUUID();
          const cnInfo = insCn.run(
            cnNumber, cnSyncId, grnDate,
            purchase.supplier_id || null, null, purchase.supplier_name || null,
            reason,
            grnNumber, amt, cn.notes || null,
            grnSyncId, branchSlug,
            generatorId, generatorName
          );
          const cnId = cnInfo.lastInsertRowid;
          if (reasonHasStock) {
            for (const i of validCnItems) {
              const qty = parseFloat(i.quantity) || 0;
              const unitVal = parseFloat(i.unit_value || 0) || 0;
              const linePrice = qty * unitVal;
              insCnItem.run(
                randomUUID(), cnId, cnSyncId,
                i.product_sync_id, i.product_name || '',
                qty, i.unit || null,
                parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1,
                unitVal, linePrice
              );
            }
            returnCnBundle.push({
              cnNumber,
              cnSyncId,
              reason,
              items: validCnItems.map(i => ({
                product_sync_id: i.product_sync_id,
                product_name: i.product_name,
                quantity: parseFloat(i.quantity) || 0,
                unit: i.unit || null,
              })),
            });
          }
        }
      }
    })();

    // 4. Post stock to branch tenant DB (outside master tx — different connection)
    // v1.10.55 — WAC redesign push 3: blend delivery cost into the branch's
    // avg_cost_price. Delivery CP is derived from the PO's declared FX rate
    // (captured at PO Create time in v1.10.54). Formula per user's
    // 2026-07-03 memo:
    //   new_wac = (existing_qty × existing_avg + received_qty × delivery_cp)
    //             / (existing_qty + received_qty)
    // Never overwrites — always blends. Old stock keeps its historical avg
    // in the numerator. If existing avg is NULL (product never received
    // any stock), we seed it with the delivery CP.
    const poCurrency = String(purchase.cost_currency || '').toUpperCase();
    const poRate     = parseFloat(purchase.fx_rate_used || 0) || 0;
    const toUsd = (unitPrice) => {
      const c = parseFloat(unitPrice || 0) || 0;
      if (c <= 0) return 0;
      if (!poCurrency || poCurrency === 'USD') return c;
      return poRate > 0 ? c / poRate : c;
    };
    try {
      const branchDb = getTenantDb(branchSlug);
      const branchMovementAt = grnDate + ' ' + new Date().toTimeString().slice(0, 8);
      // v1.10.55 — atomic UPDATE that bumps current_stock AND blends
      // avg_cost_price in one statement. Uses the pre-update snapshot of
      // both fields (SQLite evaluates the row RHS before applying the SET).
      const updWithWac = branchDb.prepare(`
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
      const insMov = branchDb.prepare(`
        INSERT INTO stock_movements
          (product_id, product_sync_id, location, movement_type, quantity,
           reference_id, reference_type, reference_sync_id, notes,
           created_by, sync_id, tenant_id, branch_id, device_id,
           synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'))
      `);
      for (const it of validItems) {
        if (!it.product_sync_id) continue; // extra items without a known product — skip stock posting
        const qty = parseFloat(it.quantity) || 0;
        if (qty <= 0) continue;
        const prod = branchDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products WHERE sync_id = ? AND deleted_at IS NULL
        `).get(it.product_sync_id);
        if (!prod) continue;
        // v1.10.66 — convert line qty (e.g. 100 crates) into base units
        // (bottles) using the product's units_json conversion. Prior
        // versions posted the raw qty as if it were already in base
        // units, which meant a "100 crates" GRN only added 100 bottles
        // to stock and blended the WAC as $320/bottle instead of $13.33.
        // Same helper as transfers.js /receive and routes/grn.js.
        const conv = conversionToBase(prod, it.unit || prod.unit);
        const baseQty = qty * conv;
        // delivery cost is per-LINE-unit ($320/crate). Convert to per
        // BASE unit for the WAC blend since current_stock + avg_cost_price
        // are both denominated in base units.
        const deliveryCpUsdPerLineUnit = toUsd(it.unit_price);
        const deliveryCpUsdPerBase = conv > 0 ? deliveryCpUsdPerLineUnit / conv : deliveryCpUsdPerLineUnit;
        updWithWac.run(
          baseQty,                     // current_stock += baseQty
          deliveryCpUsdPerBase,        // seed value when avg was NULL or stock was 0
          baseQty, deliveryCpUsdPerBase, // numerator: received_base × cp_per_base
          baseQty,                     // denominator adjust: + baseQty
          prod.sync_id
        );
        insMov.run(
          prod.id, prod.sync_id, 'sales', 'grn', baseQty,
          null, 'hq_grn', grnSyncId,
          `HQ-generated GRN ${grnNumber}`,
          null,
          randomUUID(), null, null, null,
          branchMovementAt
        );
      }
      // v1.10.67 — negative stock movements for Crate Return / Bottle Return
      // / Goods Return CNs. Mirrors routes/grn.js:290-317 on the branch side.
      // WAC intentionally left alone (Option B, user 2026-07-03) — Liquor
      // branches don't touch avg_cost_price on returns either. Consequence:
      // if you return goods above current WAC (e.g. supplier price rose
      // since last delivery), the residual stock keeps the pre-return WAC.
      // Fine for typical crate/bottle returns; if this becomes a real
      // issue we can switch to Option A later without breaking the schema.
      for (const bundle of returnCnBundle) {
        for (const bi of bundle.items) {
          if (!bi.product_sync_id) continue;
          const bqty = parseFloat(bi.quantity) || 0;
          if (bqty <= 0) continue;
          const bprod = branchDb.prepare(`
            SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
              FROM products WHERE sync_id = ? AND deleted_at IS NULL
          `).get(bi.product_sync_id);
          if (!bprod) continue;
          const bconv = conversionToBase(bprod, bi.unit || bprod.unit);
          const bBaseQty = bqty * bconv;
          // Only decrement current_stock — WAC untouched.
          branchDb.prepare(`
            UPDATE products
               SET current_stock = current_stock - ?,
                   updated_at    = datetime('now'),
                   synced        = 0
             WHERE sync_id = ?
          `).run(bBaseQty, bprod.sync_id);
          insMov.run(
            bprod.id, bprod.sync_id, 'sales', 'credit_note', -bBaseQty,
            null, 'credit_note', bundle.cnSyncId,
            `${bundle.reason} via ${bundle.cnNumber}`,
            null,
            randomUUID(), null, null, null,
            branchMovementAt
          );
        }
      }
    } catch (err) {
      console.error('[hq.grns.generate] stock post failed:', err.message);
      // Don't roll back the master tx — the GRN is recorded; stock can be
      // backfilled if needed. Surface a warning to the caller.
    }

    res.status(201).json({
      success: true,
      grn_sync_id: grnSyncId,
      grn_number: grnNumber,
      branch_slug: branchSlug,
    });
  } catch (error) {
    console.error('[hq.grns.generate] CRASH:', error.stack || error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
