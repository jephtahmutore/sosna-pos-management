// branchReceipts.js — v1.10.0 procurement rearchitecture.
//
// Branch-side endpoint for confirming what physically arrived from a HQ PO.
// Replaces the older "Accept & Generate GRN" branch flow: branch no longer
// generates the GRN itself — they just report received qty + invoice and
// HQ generates the GRN later.
//
// Per-line PO item statuses flow:
//   AWAITING_CONFIRMATION → RECEIPT_REPORTED → CONFIRMED (HQ-generated)
//
// Auth: branch tenant JWT (regular `auth` middleware). The receipt
// modifies master.db rows (hq_purchase_items, hq_purchases) so the user
// must be a branch user with PO visibility — this is enforced by checking
// destination_slug matches the caller's subdomain.

const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { randomUUID } = require('crypto');
const { masterDb, listTenants } = require('../config/masterDb');

function callerSlug(req) {
  // The tenant slug is derived from the subdomain by the upstream
  // middleware (req.tenant.slug) or, for HQ users hitting this endpoint
  // on behalf of a branch, from the body.
  return (req.tenant && req.tenant.slug)
    || String(req.body?.branch_slug || '').toLowerCase()
    || null;
}

// POST /api/branch/po-receipts/:syncId/confirm
// Body: {
//   lines: [{ purchase_item_sync_id, received_qty, reason?, notes? }],
//   extras: [{ product_sync_id?, product_name, unit, quantity, cost_price }],
//   supplier_invoice_number: string,
//   invoice_attachment: string|null  (relative path under /uploads)
// }
router.post('/:syncId/confirm', auth, (req, res) => {
  try {
    if (!masterDb) return res.status(500).json({ error: 'master.db unavailable' });
    const purchaseSyncId = String(req.params.syncId || '').trim();
    if (!purchaseSyncId) return res.status(400).json({ error: 'PO sync_id required' });

    const slug = callerSlug(req);
    if (!slug) return res.status(400).json({ error: 'Branch slug missing — cannot tie receipt to a branch.' });

    const {
      lines,
      extras,
      supplier_invoice_number,
      invoice_attachment,
    } = req.body || {};
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be an array' });
    if (!(supplier_invoice_number || '').toString().trim()) {
      return res.status(400).json({ error: 'Supplier invoice number is required.' });
    }

    const purchase = masterDb.prepare(`SELECT * FROM hq_purchases WHERE sync_id = ?`).get(purchaseSyncId);
    if (!purchase) return res.status(404).json({ error: 'PO not found.' });

    // Authorise: every line on this PO must be destined for the caller's
    // branch. If a PO mixes destinations (shouldn't, per v1.9.19) we still
    // only accept the lines targeting this branch.
    const items = masterDb.prepare(
      `SELECT * FROM hq_purchase_items WHERE purchase_sync_id = ?`
    ).all(purchaseSyncId);
    const branchItems = items.filter(i => i.destination_slug === slug);
    if (branchItems.length === 0) {
      return res.status(403).json({ error: 'No lines on this PO target your branch.' });
    }

    const branchName = (listTenants().find(t => t.slug === slug)?.business_name) || slug;
    const confirmerId   = req.user?.id || null;
    const confirmerName = req.user?.firstName || req.user?.email || 'Branch';

    masterDb.transaction(() => {
      // Update each PO line: received_qty + status = 'RECEIPT_REPORTED'.
      const upd = masterDb.prepare(`
        UPDATE hq_purchase_items
           SET received_qty = ?,
               reason       = ?,
               variance_notes = ?,
               received_by      = ?,
               received_by_name = ?,
               received_at      = datetime('now'),
               status           = 'RECEIPT_REPORTED'
         WHERE sync_id = ?
           AND destination_slug = ?
      `);
      const byPiSync = new Map(lines.map(l => [String(l.purchase_item_sync_id || ''), l]));
      for (const it of branchItems) {
        const line = byPiSync.get(it.sync_id);
        if (!line) continue;
        const recvQty = Math.max(0, parseFloat(line.received_qty || 0) || 0);
        upd.run(
          recvQty,
          line.reason || (recvQty === parseFloat(it.dispatched_qty) ? 'OK' : 'Short'),
          line.notes || null,
          confirmerId, confirmerName,
          it.sync_id, slug
        );
      }

      // Replace extras for this PO (idempotent if branch re-submits).
      masterDb.prepare(`DELETE FROM hq_purchase_receipt_extras WHERE purchase_sync_id = ?`).run(purchaseSyncId);
      if (Array.isArray(extras)) {
        const insExtra = masterDb.prepare(`
          INSERT INTO hq_purchase_receipt_extras
            (sync_id, purchase_sync_id, product_sync_id, product_name, unit,
             quantity, cost_price, added_by, added_by_name)
          VALUES (?,?,?,?,?,?,?,?,?)
        `);
        for (const e of extras) {
          if (!e || !e.product_name) continue;
          const qty = Math.max(0, parseFloat(e.quantity || 0) || 0);
          if (qty <= 0) continue;
          insExtra.run(
            randomUUID(), purchaseSyncId,
            e.product_sync_id || null, e.product_name,
            e.unit || null, qty,
            parseFloat(e.cost_price || 0) || 0,
            confirmerId, confirmerName
          );
        }
      }

      // Stamp the PO header with invoice + branch confirmation audit.
      masterDb.prepare(`
        UPDATE hq_purchases
           SET supplier_invoice_number   = ?,
               invoice_attachment        = ?,
               confirmed_by_branch       = ?,
               confirmed_by_branch_name  = ?,
               confirmed_at_branch       = datetime('now'),
               confirmed_branch_slug     = ?
         WHERE sync_id = ?
      `).run(
        String(supplier_invoice_number).trim(),
        invoice_attachment || null,
        confirmerId, confirmerName, slug,
        purchaseSyncId
      );
    })();

    res.json({
      success: true,
      purchase_sync_id: purchaseSyncId,
      branch_slug: slug,
      branch_name: branchName,
      supplier_invoice_number: String(supplier_invoice_number).trim(),
    });
  } catch (error) {
    console.error('[branchReceipts.confirm]', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
