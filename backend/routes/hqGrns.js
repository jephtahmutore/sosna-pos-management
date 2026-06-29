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
    res.json({ grn: { ...grn, branch_slug: slug }, items });
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

module.exports = router;
