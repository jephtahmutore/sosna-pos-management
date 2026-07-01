// Supplier Credit Notes — money the supplier owes you.
//
// Two sources, surfaced via the `reason` field:
//   - 'Discount' / 'Other'        → real income event. Profit Report counts
//                                   these as "Supplier Rebates" (positive
//                                   line under Gross Profit).
//   - 'Crate Return' / 'Bottle    → deposit refund. NOT income. Reduces AP
//      Return'                      balance + posts negative stock movements
//                                   for the returned empties. Profit Report
//                                   IGNORES these.
//
// All credit notes reduce the supplier's outstanding balance (the AP page's
// `balance` aggregate subtracts SUM(supplier_credit_notes.amount)).

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { isSingleLocationMode } = require('../config/autoSivHelper');
const { randomUUID } = require('crypto');

// In single-location mode, all stock effectively lives at the 'sales' counter
// (every GRN is auto-SIV'd to sales). Credit-note returns must therefore
// deduct from 'sales', not 'store' — deducting from store leaves it negative
// and leaves the sales counter over-counting. In dual-location mode the
// goods physically come out of the store warehouse before leaving, so 'store'
// is correct there.
function stockLocation(db, tenantId) {
  return isSingleLocationMode(db, tenantId) ? 'sales' : 'store';
}

// 'Crate Return'  -> empties going back to supplier (deposit refund). Items
//                    are crate/bottle products. Profit Report ignores it.
// 'Goods Return'  -> the actual purchased goods going back (damaged, wrong,
//                    excess). Items are beverage / regular products at their
//                    avg cost price. Profit Report also ignores it (cost &
//                    cash net to zero; it's a reversal, not income).
// 'Discount' / 'Other' -> pure cash-side credit. No stock movement. Counts
//                         as Supplier Rebate in the Profit Report.
// 'Bottle Return' kept for backward-compat with rows created before the
// crate+bottle merge; treated like a Crate Return everywhere.
const VALID_REASONS = ['Discount', 'Crate Return', 'Goods Return', 'Bottle Return', 'Other'];
const reasonHasStock = (reason) =>
  reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, supplier_id, reason } = req.query;
    let sql = `
      SELECT cn.*, s.name AS supplier_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM supplier_credit_notes cn
      LEFT JOIN suppliers s ON s.sync_id = cn.supplier_sync_id
      LEFT JOIN users u ON u.id = cn.created_by
      WHERE cn.deleted_at IS NULL AND cn.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    if (from)         { sql += ' AND cn.date >= ?'; params.push(from); }
    if (to)           { sql += ' AND cn.date <= ?'; params.push(to); }
    if (supplier_id)  { sql += ' AND cn.supplier_id = ?'; params.push(parseInt(supplier_id)); }
    if (reason)       { sql += ' AND cn.reason = ?'; params.push(reason); }
    sql += ' ORDER BY cn.date DESC, cn.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ────────────────────────────────────────────────────────────────────
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total      = db.prepare("SELECT COUNT(*) AS cnt FROM supplier_credit_notes WHERE deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const thisMonth  = db.prepare("SELECT COUNT(*) AS cnt FROM supplier_credit_notes WHERE deleted_at IS NULL AND tenant_id = ? AND strftime('%Y-%m', date) = strftime('%Y-%m','now')").get(tenantId);
    const totalValue = db.prepare("SELECT COALESCE(SUM(amount),0) AS sum FROM supplier_credit_notes WHERE deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const byReason   = db.prepare(`
      SELECT reason, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS sum
      FROM supplier_credit_notes
      WHERE deleted_at IS NULL AND tenant_id = ?
      GROUP BY reason
    `).all(tenantId);
    res.json({
      totalCreditNotes: total.cnt,
      thisMonth:        thisMonth.cnt,
      totalValue:       totalValue.sum,
      byReason,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single (with items if applicable) ────────────────────────────────────────
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT cn.*, s.name AS supplier_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM supplier_credit_notes cn
      LEFT JOIN suppliers s ON s.sync_id = cn.supplier_sync_id
      LEFT JOIN users u ON u.id = cn.created_by
      WHERE cn.id = ? AND cn.tenant_id = ?
    `).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Credit note not found.' });
    const items = db.prepare(`
      SELECT cni.*, p.name AS product_name, p.unit AS product_unit
      FROM supplier_credit_note_items cni
      LEFT JOIN products p ON p.sync_id = cni.product_sync_id
      WHERE cni.credit_note_sync_id = ? AND cni.deleted_at IS NULL
    `).all(row.sync_id);
    res.json({ ...row, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    // v1.9.16 — accept grn_sync_id so credit notes raised from inside the
    // GRN form get linked back to the parent GRN. HQ Confirm GRN sums by
    // grn_sync_id to compute final payable. Standalone CN page sends null.
    const { supplier_id, reason, reference, amount, notes, items, date, grn_sync_id } = req.body || {};
    if (!supplier_id) return res.status(400).json({ error: 'Supplier is required.' });
    if (!VALID_REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason.' });

    const usesStock = reasonHasStock(reason);
    const validItems = usesStock ? (items || []).filter(i => i.product_id && parseFloat(i.quantity) > 0) : [];
    if (usesStock && validItems.length === 0) {
      return res.status(400).json({ error: 'At least one product line is required for crate / bottle returns.' });
    }
    // For Discount / Other the amount comes directly from the form.
    // For Crate / Bottle Return the amount is the sum of (qty * unit_value).
    const finalAmount = usesStock
      ? validItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.unit_value || 0), 0)
      : parseFloat(amount || 0);
    if (!(finalAmount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const result = db.transaction(() => {
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const cnNumber = syncConfig.generateNumber('CN', 'supplier_credit_notes');
      const cnSyncId = randomUUID();
      const cnDate   = date || new Date().toISOString().split('T')[0];
      const movementCreatedAt = cnDate + ' ' + new Date().toTimeString().slice(0, 8);

      const supplier = db.prepare('SELECT sync_id, name FROM suppliers WHERE id = ?').get(supplier_id);
      const supplierSyncId = req.body.supplier_sync_id || supplier?.sync_id || null;

      const info = db.prepare(`
        INSERT INTO supplier_credit_notes (credit_note_number, date, supplier_id, supplier_sync_id,
                                            reason, reference, amount, notes, grn_sync_id, created_by,
                                            sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(cnNumber, cnDate, supplier_id, supplierSyncId,
             reason, reference || null, finalAmount, notes || null, grn_sync_id || null, req.user.id,
             cnSyncId, tenantId, branchId, deviceId);
      const cnId = info.lastInsertRowid;

      // Items + stock movements only for crate/bottle/goods returns.
      if (usesStock) {
        for (const i of validItems) {
          const prod = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id);
          const productSyncId = i.product_sync_id || prod?.sync_id || null;
          const qty = parseFloat(i.quantity);
          const unitVal = parseFloat(i.unit_value || 0);
          const linePrice = qty * unitVal;
          const unitName = i.unit || null;
          const unitConv = parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1;
          // Stock leaves in BASE units (qty * conv), so a "1 Crate" return of a
          // 12-pack drops 12 base units. unit_value already reflects per-picked-unit.
          const baseQty = qty * unitConv;

          db.prepare(`
            INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                                     quantity, unit_value, total_price, unit, unit_conv,
                                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(cnId, cnSyncId, i.product_id, productSyncId, qty, unitVal, linePrice, unitName, unitConv,
                 randomUUID(), tenantId, branchId, deviceId);

          db.prepare(`
            INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity,
                                         reference_id, reference_type, notes, created_by,
                                         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
          `).run(i.product_id, productSyncId, stockLocation(db, tenantId), 'credit_note', -baseQty,
                 cnId, 'credit_note', `${reason} via ${cnNumber}`, req.user.id,
                 randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, cnSyncId);
          // v1.10.24 — decrement products.current_stock alongside the movement.
          if (productSyncId) {
            db.prepare(
              `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(baseQty, productSyncId);
          }
        }
      }

      const saved = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(cnId);
      // Only Discount + Other affect Gross Profit; recalc anyway — it's cheap
      // and keeps the daily_profit_summary accurate for the saved date.
      recalculateDailyProfit(db, cnDate, tenantId);
      return saved;
    })();
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ───────────────────────────────────────────────────────────────────
// Strategy: soft-delete the existing items + stock movements, then re-insert
// from the new payload. Parent row keeps its number/sync_id.
router.put('/:id', auth, (req, res) => {
  try {
    const { supplier_id, reason, reference, amount, notes, items, date } = req.body || {};
    const id = parseInt(req.params.id);
    if (!VALID_REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason.' });

    const usesStock = reasonHasStock(reason);
    const validItems = usesStock ? (items || []).filter(i => i.product_id && parseFloat(i.quantity) > 0) : [];
    if (usesStock && validItems.length === 0) {
      return res.status(400).json({ error: 'At least one product line is required for crate / bottle returns.' });
    }
    const finalAmount = usesStock
      ? validItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.unit_value || 0), 0)
      : parseFloat(amount || 0);
    if (!(finalAmount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const result = db.transaction(() => {
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const cn = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(id, tenantId);
      if (!cn) throw Object.assign(new Error('Credit note not found.'), { status: 404 });

      const supplier = db.prepare('SELECT sync_id FROM suppliers WHERE id = ?').get(supplier_id);
      const supplierSyncId = req.body.supplier_sync_id || supplier?.sync_id || null;
      const editDate = date || cn.date;
      const movementCreatedAt = editDate + ' ' + new Date().toTimeString().slice(0, 8);

      // v1.10.24 — roll old credit_note movements off current_stock before soft-deleting.
      const oldCnMoves = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'credit_note' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(cn.sync_id);
      for (const r of oldCnMoves) {
        if (r.product_sync_id) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(r.net, r.product_sync_id);
        }
      }
      // Soft-delete previous items + movements (so sync carries the deletion).
      db.prepare("UPDATE supplier_credit_note_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE credit_note_sync_id=? AND deleted_at IS NULL").run(cn.sync_id);
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='credit_note' AND deleted_at IS NULL").run(cn.sync_id);

      db.prepare(`
        UPDATE supplier_credit_notes
        SET supplier_id=?, supplier_sync_id=?, reason=?, reference=?, amount=?, notes=?, date=?,
            synced=0, updated_at=datetime('now')
        WHERE id=?
      `).run(supplier_id, supplierSyncId, reason, reference || null, finalAmount, notes || null, editDate, id);

      if (usesStock) {
        for (const i of validItems) {
          const prod = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id);
          const productSyncId = i.product_sync_id || prod?.sync_id || null;
          const qty = parseFloat(i.quantity);
          const unitVal = parseFloat(i.unit_value || 0);
          const linePrice = qty * unitVal;
          const unitName = i.unit || null;
          const unitConv = parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1;
          const baseQty = qty * unitConv;

          db.prepare(`
            INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                                     quantity, unit_value, total_price, unit, unit_conv,
                                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(id, cn.sync_id, i.product_id, productSyncId, qty, unitVal, linePrice, unitName, unitConv,
                 randomUUID(), tenantId, branchId, deviceId);

          db.prepare(`
            INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity,
                                         reference_id, reference_type, notes, created_by,
                                         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
          `).run(i.product_id, productSyncId, stockLocation(db, tenantId), 'credit_note', -baseQty,
                 id, 'credit_note', `${reason} via ${cn.credit_note_number}`, req.user.id,
                 randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, cn.sync_id);
          // v1.10.24 — decrement products.current_stock alongside the movement.
          if (productSyncId) {
            db.prepare(
              `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(baseQty, productSyncId);
          }
        }
      }

      const updated = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(id);
      // Edits can move the date or amount → recalc both the old and new dates.
      recalculateDailyProfit(db, cn.date,  tenantId);
      if (editDate !== cn.date) recalculateDailyProfit(db, editDate, tenantId);
      return updated;
    })();
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Delete (soft-delete + cascade) ───────────────────────────────────────────
router.delete('/:id', auth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.transaction(() => {
      const cn = db.prepare('SELECT sync_id, date, tenant_id FROM supplier_credit_notes WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!cn) throw Object.assign(new Error('Credit note not found.'), { status: 404 });

      // v1.10.24 — roll deleted credit_note movements off current_stock.
      const oldCnDelMoves = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'credit_note' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(cn.sync_id);
      for (const r of oldCnDelMoves) {
        if (r.product_sync_id) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(r.net, r.product_sync_id);
        }
      }
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='credit_note' AND deleted_at IS NULL").run(cn.sync_id);
      db.prepare("UPDATE supplier_credit_note_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE credit_note_sync_id=? AND deleted_at IS NULL").run(cn.sync_id);
      db.prepare("UPDATE supplier_credit_notes SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(id);
      recalculateDailyProfit(db, cn.date, cn.tenant_id);
    })();
    res.json({ message: 'Credit note deleted.' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
