/**
 * notifications.js — sidebar badge counts for the currently-selected
 * branch. One round-trip returns:
 *   - cashier_pending      (orders status='PENDING_PAYMENT' in that branch)
 *   - dispatch_pending     (orders status='PAID' in that branch)
 *   - incoming_stock       (hq_purchase_items pending for that branch
 *                           — lives in master.db, joined on destination_slug)
 *   - incoming_transfers   (stock_transfers PENDING with to_slug=this branch
 *                           — also in master.db, for the inter-branch flow)
 *
 * Designed to be cheap + polled every 30s from the sidebar. Each count is
 * a single COUNT(*) with an index already in place. Errors per source are
 * swallowed individually so one broken branch can't blank the others.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { masterDb, isRegistered } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

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

function safeCount(fn) { try { return fn() || 0; } catch { return 0; } }

router.get('/badges', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();

    // hq_pending_grn is HQ-scope (not branch) — returned regardless of
    // slug so the HQ "Confirm GRN" sidebar entry has its count whether
    // or not a branch is currently picked.
    const hqPendingGrn = safeCount(() => masterDb.prepare(
      `SELECT COUNT(*) AS n FROM hq_purchase_items WHERE status = 'GRN_SUBMITTED'`
    ).get()?.n);

    if (!slug || !isRegistered(slug)) {
      return res.json({
        cashier_pending: 0, dispatch_pending: 0,
        incoming_stock: 0, incoming_transfers: 0,
        hq_pending_grn: hqPendingGrn,
      });
    }

    const db = getTenantDb(slug);
    const cashier  = safeCount(() => db.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PENDING_PAYMENT'`
    ).get()?.n);
    const dispatch = safeCount(() => db.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PAID'`
    ).get()?.n);

    // Branch's "Incoming Stock" badge counts only the AWAITING_GRN rows
    // (action items for the branch). GRN_SUBMITTED lines are read-only
    // for the branch until HQ confirms / rejects.
    const incomingStock = safeCount(() => masterDb.prepare(
      `SELECT COUNT(*) AS n FROM hq_purchase_items WHERE destination_slug = ? AND status = 'AWAITING_GRN'`
    ).get(slug)?.n);

    const incomingTransfers = safeCount(() => masterDb.prepare(
      `SELECT COUNT(*) AS n FROM stock_transfers WHERE to_slug = ? AND status = 'PENDING'`
    ).get(slug)?.n);

    res.json({
      cashier_pending:     cashier,
      dispatch_pending:    dispatch,
      incoming_stock:      incomingStock,
      incoming_transfers:  incomingTransfers,
      hq_pending_grn:      hqPendingGrn,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
