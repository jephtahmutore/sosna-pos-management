// Quotations — customer price offers, draft before real order.
// v1.10.326 — new feature. Zero stock impact until Convert-to-Order.
// State machine: Draft → Sent → Accepted/Declined; Accepted → Ordered.
// Auto-expire flips Sent+ to Expired when valid_until < today (handled by
// the list endpoint on-read so no cron is required — cheap enough).
const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

const todayISO = () => new Date().toISOString().slice(0, 10);

// Auto-expire pass: run cheaply on every list-fetch. Any Sent quote whose
// valid_until is in the past becomes Expired. Accepted and Ordered are
// terminal for expiry purposes — a customer already said yes, don't
// undo that.
function autoExpire(tenantId) {
  try {
    db.prepare(`
      UPDATE quotations
         SET status = 'Expired', updated_at = datetime('now'), synced = 0
       WHERE deleted_at IS NULL
         AND tenant_id = ?
         AND status = 'Sent'
         AND date(valid_until) < date('now')
    `).run(tenantId);
  } catch (_) {}
}

// GET /api/quotations — list with optional ?status=&q=
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    autoExpire(req.user.tenantId);
    const { status, q } = req.query || {};
    const where = ['q.deleted_at IS NULL', 'q.tenant_id = ?'];
    const params = [req.user.tenantId];
    if (status && status !== 'All') { where.push('q.status = ?'); params.push(status); }
    if (q) { where.push('(q.quote_number LIKE ? OR q.customer_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const rows = db.prepare(`
      SELECT q.*,
             (SELECT COUNT(*) FROM quotation_items WHERE quote_id = q.id AND deleted_at IS NULL) AS item_count
        FROM quotations q
       WHERE ${where.join(' AND ')}
       ORDER BY q.date DESC, q.id DESC
    `).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/quotations/stats
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    autoExpire(req.user.tenantId);
    const tenantId = req.user.tenantId;
    const active   = db.prepare(`SELECT COUNT(*) AS n FROM quotations WHERE deleted_at IS NULL AND tenant_id=? AND status IN ('Draft','Sent','Accepted')`).get(tenantId).n;
    const waiting  = db.prepare(`SELECT COUNT(*) AS n FROM quotations WHERE deleted_at IS NULL AND tenant_id=? AND status = 'Sent'`).get(tenantId).n;
    const accepted = db.prepare(`SELECT COUNT(*) AS n FROM quotations WHERE deleted_at IS NULL AND tenant_id=? AND status IN ('Accepted','Ordered') AND date(accepted_at) >= date('now','-30 day')`).get(tenantId).n;
    const expired  = db.prepare(`SELECT COUNT(*) AS n FROM quotations WHERE deleted_at IS NULL AND tenant_id=? AND status = 'Expired'`).get(tenantId).n;
    res.json({ active, waiting, accepted, expired });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/quotations/:id
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`SELECT * FROM quotations WHERE id=? AND deleted_at IS NULL AND tenant_id=?`).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const items = db.prepare(`SELECT * FROM quotation_items WHERE quote_id=? AND deleted_at IS NULL ORDER BY id ASC`).all(row.id);
    res.json({ ...row, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/quotations
router.post('/', auth, (req, res) => {
  try {
    const {
      date, valid_until, customer_id, customer_name,
      currency, fx_rate_used, discount, tax, notes, items,
    } = req.body || {};
    if (!Array.isArray(items) || !items.filter(i => i && i.product_name && parseFloat(i.quantity) > 0).length) {
      return res.status(400).json({ error: 'Add at least one line item.' });
    }
    if (!valid_until) return res.status(400).json({ error: 'Valid Until date is required.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const num  = syncConfig.generateNumber('QT', 'quotations');
    const dt   = date || todayISO();
    const disc = parseFloat(discount) || 0;
    const txv  = parseFloat(tax) || 0;

    const result = db.transaction(() => {
      const clean = items.filter(i => i && i.product_name && parseFloat(i.quantity) > 0)
        .map(i => {
          const q = parseFloat(i.quantity) || 0;
          const p = parseFloat(i.unit_price) || 0;
          const d = parseFloat(i.discount_amount) || 0;
          return { ...i, quantity: q, unit_price: p, discount_amount: d, line_total: q * p - d };
        });
      const subtotal = clean.reduce((s, i) => s + i.line_total, 0);
      const total    = Math.max(0, subtotal - disc + txv);
      const info = db.prepare(`
        INSERT INTO quotations
          (quote_number, date, valid_until, customer_id, customer_name,
           currency, fx_rate_used, subtotal, discount, tax, total, notes,
           status, created_by, created_by_name, sync_id, tenant_id, branch_id, device_id, synced,
           created_at, updated_at)
        VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, 'Draft',?,?,?,?,?,?,0, datetime('now'), datetime('now'))
      `).run(
        num, dt, valid_until, customer_id || null, customer_name || null,
        (currency || 'K'), parseFloat(fx_rate_used) || 1,
        subtotal, disc, txv, total, notes || null,
        req.user.id, (req.user.firstName || req.user.email || null),
        randomUUID(), tenantId, branchId, deviceId
      );
      const qid = info.lastInsertRowid;
      const ins = db.prepare(`
        INSERT INTO quotation_items
          (quote_id, product_id, product_name, unit, quantity, unit_price,
           discount_amount, line_total, sync_id, tenant_id, branch_id, device_id, synced,
           created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0, datetime('now'), datetime('now'))
      `);
      for (const it of clean) {
        ins.run(qid, it.product_id || null, it.product_name, it.unit || null,
          it.quantity, it.unit_price, it.discount_amount, it.line_total,
          randomUUID(), tenantId, branchId, deviceId);
      }
      return db.prepare(`SELECT * FROM quotations WHERE id=?`).get(qid);
    })();

    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/quotations/:id — only allowed on Draft
router.put('/:id', auth, (req, res) => {
  try {
    const row = db.prepare(`SELECT * FROM quotations WHERE id=? AND deleted_at IS NULL AND tenant_id=?`).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'Draft') return res.status(409).json({ error: `Cannot edit a quote in status "${row.status}". Revise or void it instead.` });

    const {
      date, valid_until, customer_id, customer_name,
      currency, fx_rate_used, discount, tax, notes, items,
    } = req.body || {};
    if (!Array.isArray(items) || !items.filter(i => i && i.product_name && parseFloat(i.quantity) > 0).length) {
      return res.status(400).json({ error: 'Add at least one line item.' });
    }

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    db.transaction(() => {
      db.prepare(`UPDATE quotation_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE quote_id=? AND deleted_at IS NULL`).run(row.id);
      const clean = items.filter(i => i && i.product_name && parseFloat(i.quantity) > 0).map(i => {
        const q = parseFloat(i.quantity) || 0;
        const p = parseFloat(i.unit_price) || 0;
        const d = parseFloat(i.discount_amount) || 0;
        return { ...i, quantity: q, unit_price: p, discount_amount: d, line_total: q * p - d };
      });
      const subtotal = clean.reduce((s, i) => s + i.line_total, 0);
      const disc = parseFloat(discount) || 0;
      const txv  = parseFloat(tax) || 0;
      const total = Math.max(0, subtotal - disc + txv);
      db.prepare(`
        UPDATE quotations
           SET date=?, valid_until=?, customer_id=?, customer_name=?, currency=?,
               fx_rate_used=?, subtotal=?, discount=?, tax=?, total=?, notes=?,
               updated_at=datetime('now'), synced=0
         WHERE id=?
      `).run(
        date || row.date, valid_until || row.valid_until, customer_id || null, customer_name || null,
        currency || row.currency || 'K', parseFloat(fx_rate_used) || 1,
        subtotal, disc, txv, total, notes || null, row.id
      );
      const ins = db.prepare(`
        INSERT INTO quotation_items
          (quote_id, product_id, product_name, unit, quantity, unit_price,
           discount_amount, line_total, sync_id, tenant_id, branch_id, device_id, synced,
           created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0, datetime('now'), datetime('now'))
      `);
      for (const it of clean) {
        ins.run(row.id, it.product_id || null, it.product_name, it.unit || null,
          it.quantity, it.unit_price, it.discount_amount, it.line_total,
          randomUUID(), tenantId, branchId, deviceId);
      }
    })();

    res.json(db.prepare(`SELECT * FROM quotations WHERE id=?`).get(row.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Status transitions ---------------------------------------------------------
function setStatus(id, tenantId, target, extraSql = '', extraParams = []) {
  const row = db.prepare(`SELECT * FROM quotations WHERE id=? AND deleted_at IS NULL AND tenant_id=?`).get(id, tenantId);
  if (!row) return { err: 'Not found', code: 404 };
  const legal = {
    Sent:     ['Draft'],
    Accepted: ['Sent'],
    Declined: ['Sent'],
    Voided:   ['Draft', 'Sent', 'Accepted', 'Expired'],
  };
  if (!legal[target].includes(row.status)) {
    return { err: `Cannot move "${row.status}" → "${target}".`, code: 409 };
  }
  db.prepare(`UPDATE quotations SET status=?, updated_at=datetime('now'), synced=0 ${extraSql} WHERE id=?`).run(target, ...extraParams, id);
  return { ok: true };
}

router.post('/:id/send',   auth, (req, res) => {
  const r = setStatus(req.params.id, req.user.tenantId, 'Sent', ', sent_at=datetime(\'now\')');
  if (r.err) return res.status(r.code).json({ error: r.err });
  res.json(db.prepare(`SELECT * FROM quotations WHERE id=?`).get(req.params.id));
});
router.post('/:id/accept', auth, (req, res) => {
  const r = setStatus(req.params.id, req.user.tenantId, 'Accepted', ', accepted_at=datetime(\'now\')');
  if (r.err) return res.status(r.code).json({ error: r.err });
  res.json(db.prepare(`SELECT * FROM quotations WHERE id=?`).get(req.params.id));
});
router.post('/:id/decline', auth, (req, res) => {
  const r = setStatus(req.params.id, req.user.tenantId, 'Declined', ', declined_at=datetime(\'now\')');
  if (r.err) return res.status(r.code).json({ error: r.err });
  res.json(db.prepare(`SELECT * FROM quotations WHERE id=?`).get(req.params.id));
});
router.post('/:id/void', auth, (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Void reason is required.' });
  const r = setStatus(req.params.id, req.user.tenantId, 'Voided', ', void_reason=?', [reason]);
  if (r.err) return res.status(r.code).json({ error: r.err });
  res.json(db.prepare(`SELECT * FROM quotations WHERE id=?`).get(req.params.id));
});

// POST /api/quotations/:id/convert — becomes a real Order (POS uses that path)
// The quote is locked (status=Ordered) so it cannot be edited/re-converted.
// NOTE: This creates the sales `orders` header + `order_items`. Stock is
// only moved by the normal order/POS flow (dispatch/confirmation), NOT here.
router.post('/:id/convert', auth, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { branchId, deviceId } = syncConfig.getConfig();
    const row = db.prepare(`SELECT * FROM quotations WHERE id=? AND deleted_at IS NULL AND tenant_id=?`).get(req.params.id, tenantId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!['Accepted', 'Sent'].includes(row.status)) {
      return res.status(409).json({ error: `Only Sent or Accepted quotes can convert. Current: "${row.status}".` });
    }
    if (row.converted_order_sync_id) {
      return res.status(409).json({ error: 'Quote already converted to an order.' });
    }
    const items = db.prepare(`SELECT * FROM quotation_items WHERE quote_id=? AND deleted_at IS NULL`).all(row.id);
    if (!items.length) return res.status(400).json({ error: 'Quote has no items.' });

    const result = db.transaction(() => {
      const orderNum      = syncConfig.generateNumber('ORD', 'orders');
      const orderSyncId   = randomUUID();
      const info = db.prepare(`
        INSERT INTO orders
          (order_number, customer_name, payment_method, subtotal, tax_amount,
           discount, total_amount, status, created_by, created_at,
           sync_id, tenant_id, branch_id, device_id, synced, updated_at)
        VALUES (?,?, 'Credit', ?, ?, ?, ?, NULL, ?, datetime('now'),
                ?, ?, ?, ?, 0, datetime('now'))
      `).run(
        orderNum, row.customer_name || null,
        row.subtotal, row.tax, row.discount, row.total,
        req.user.id,
        orderSyncId, tenantId, branchId, deviceId
      );
      const oid = info.lastInsertRowid;
      const ins = db.prepare(`
        INSERT INTO order_items
          (order_id, product_id, product_name, quantity, unit_price,
           discount_amount, total_price, sync_id, tenant_id, branch_id, device_id, synced,
           created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0, datetime('now'), datetime('now'))
      `);
      for (const it of items) {
        ins.run(oid, it.product_id || null, it.product_name, it.quantity, it.unit_price,
          it.discount_amount || 0, it.line_total,
          randomUUID(), tenantId, branchId, deviceId);
      }
      db.prepare(`
        UPDATE quotations
           SET status='Ordered',
               converted_order_id=?, converted_order_sync_id=?,
               converted_at=datetime('now'),
               updated_at=datetime('now'), synced=0
         WHERE id=?
      `).run(oid, orderSyncId, row.id);
      return { order_id: oid, order_sync_id: orderSyncId, order_number: orderNum, quote_id: row.id };
    })();

    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/quotations/:id — soft-delete, only on Draft or Voided.
router.delete('/:id', auth, (req, res) => {
  try {
    const row = db.prepare(`SELECT * FROM quotations WHERE id=? AND deleted_at IS NULL AND tenant_id=?`).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!['Draft', 'Voided'].includes(row.status)) {
      return res.status(409).json({ error: `Cannot delete a "${row.status}" quote. Void it first.` });
    }
    db.prepare(`UPDATE quotations SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?`).run(row.id);
    db.prepare(`UPDATE quotation_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE quote_id=?`).run(row.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
