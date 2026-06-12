const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { conversionToBase, baseQtyExpr } = require('../config/unitsHelper');

// Get distinct users that have orders (for filter dropdown)
router.get('/users', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT o.created_by, u.first_name || ' ' || u.last_name AS full_name
       FROM orders o
       LEFT JOIN users u ON o.created_by = u.id
       WHERE o.deleted_at IS NULL AND o.tenant_id = ? AND o.created_by IS NOT NULL`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all orders
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM orders WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY created_at DESC').all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create order (POS checkout)
router.post('/', auth, (req, res) => {
  try {
    const {
      customer_name, customer_id, customer_sync_id, items, payment_method,
      subtotal, tax_amount, total_amount, discount, amount_received, change_amount,
      cash_received, momo_received, bank_received, sale_date,
    } = req.body;
    // Administrator-only back-dating: when the POS Pay modal sends an explicit
    // sale_date (YYYY-MM-DD), an Administrator can override the server clock.
    // For any other role we silently ignore it.
    const isAdmin = req.user && (req.user.role === 'Administrator' || req.user.role === 'Admin');
    const looksLikeDate = typeof sale_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sale_date);
    const overrideDate = (isAdmin && looksLikeDate) ? sale_date : null;
    // Stamp the override at the same wall-clock time the server would have used,
    // so existing reports and sorts behave naturally.
    const overrideTs = overrideDate ? `${overrideDate} ${new Date().toTimeString().slice(0, 8)}` : null;
    const tsExpr = overrideTs ? '?' : "datetime('now')";
    const tsArgs = overrideTs ? [overrideTs] : [];
    // Derive a sane split if the client only sent the legacy amount_received.
    const cashIn = parseFloat(cash_received ?? (payment_method === 'Mobile Money' || payment_method === 'Transfer' || payment_method === 'Bank' || payment_method === 'Bank Transfer' ? 0 : amount_received || 0)) || 0;
    const momoIn = parseFloat(momo_received ?? (payment_method === 'Mobile Money' ? amount_received || 0 : 0)) || 0;
    const bankIn = parseFloat(bank_received ?? (payment_method === 'Transfer' || payment_method === 'Bank' || payment_method === 'Bank Transfer' ? amount_received || 0 : 0)) || 0;
    const totalReceived = cashIn + momoIn + bankIn;
    const finalAmountReceived = amount_received !== undefined ? parseFloat(amount_received) || 0 : totalReceived;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const orderNum = syncConfig.generateNumber('ORD', 'orders');

    // ── Server-side credit-limit guard ───────────────────────────────────────
    // Mirrors the POS UI rule: if the buyer matches a known customer,
    // enforce credit_status and credit_limit. Walk-in sales must be paid in full.
    const unpaid = Math.max(0, parseFloat(total_amount || 0) - parseFloat(amount_received || 0));
    if (unpaid > 0.001) {
      if (!customer_name || !customer_name.trim()) {
        return res.status(400).json({ error: 'Walk-in sales must be paid in full' });
      }
      // Prefer explicit customer_id; fall back to unique-name lookup.
      let cust = null;
      if (customer_id) {
        cust = db.prepare('SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(customer_id, tenantId);
      }
      if (!cust) {
        const matches = db.prepare(
          'SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL AND tenant_id = ?'
        ).all(customer_name.trim(), tenantId);
        if (matches.length === 1) cust = matches[0];
        else if (matches.length > 1) {
          return res.status(400).json({ error: 'Multiple customers match this name — please select the customer explicitly' });
        }
      }
      if (!cust) {
        return res.status(400).json({ error: 'Unknown customer — partial payment requires a registered customer' });
      }
      if (cust.credit_status === 'OnHold') {
        return res.status(400).json({ error: 'Customer is on hold — payment in full required' });
      }
      const limit = parseFloat(cust.credit_limit || 0);
      if (limit > 0) {
        // Existing AR = credit portion of past sales − payments collected later.
        // Then add the unpaid portion of THIS sale on top.
        const sold = db.prepare(`
          SELECT COALESCE(SUM(total_amount - COALESCE(amount_received, 0)), 0) AS s
          FROM orders
          WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
            AND customer_sync_id = ? AND tenant_id = ?
        `).get(cust.sync_id, tenantId).s;
        const paid = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS p
          FROM customer_payments
          WHERE deleted_at IS NULL AND customer_sync_id = ?
        `).get(cust.sync_id).p;
        const projected = (parseFloat(sold) - parseFloat(paid)) + unpaid;
        if (projected > limit + 0.001) {
          return res.status(400).json({
            error: `Sale exceeds credit limit (K${limit.toFixed(2)}). Projected outstanding: K${projected.toFixed(2)}`,
          });
        }
      }
    }

    const order = db.transaction(() => {
      const orderSyncId = randomUUID();
      const ordSql = `INSERT INTO orders (order_number, customer_name, customer_id, customer_sync_id, subtotal, tax_amount, total_amount, discount,
          amount_received, cash_received, momo_received, bank_received,
          change_amount, payment_method, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,${tsExpr},${tsExpr})`;
      const ordArgs = [orderNum, customer_name, customer_id || null, customer_sync_id || null,
            subtotal, tax_amount, total_amount, discount || 0,
            finalAmountReceived, cashIn, momoIn, bankIn,
            change_amount || 0, payment_method || 'Cash', req.user.id,
            orderSyncId, tenantId, branchId, deviceId];
      if (overrideTs) ordArgs.push(overrideTs, overrideTs);
      const info = db.prepare(ordSql).run(...ordArgs);

      const orderId = info.lastInsertRowid;

      const itemSql = `INSERT INTO order_items (order_id, order_sync_id, product_id, product_sync_id, product_name, quantity, unit, unit_price, discount, total_price, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,${tsExpr},${tsExpr})`;
      const movSql = `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,${tsExpr},${tsExpr},?)`;
      const itemStmt = db.prepare(itemSql);
      const movStmt  = db.prepare(movSql);

      for (const item of items) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(item.product_id);
        // Prefer client-sent product_sync_id to avoid mis-attributing a sale to
        // the wrong product when local ids drift across PCs.
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(item.quantity) * conversionToBase(prod, lineUnit);
        const lineDiscount = parseFloat(item.discount || 0);
        const itemArgs = [orderId, orderSyncId, item.product_id, productSyncId, item.product_name, item.quantity, lineUnit, item.unit_price, lineDiscount, item.total_price,
              randomUUID(), tenantId, branchId, deviceId];
        if (overrideTs) itemArgs.push(overrideTs, overrideTs);
        itemStmt.run(...itemArgs);

        const movArgs = [item.product_id, productSyncId, 'sales', 'sale', -baseQty, orderId, 'order', req.user.id,
              randomUUID(), tenantId, branchId, deviceId];
        if (overrideTs) movArgs.push(overrideTs, overrideTs);
        movArgs.push(orderSyncId);
        movStmt.run(...movArgs);
      }

      return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    })();

    const orderDate = overrideDate || new Date().toISOString().split('T')[0];
    recalculateDailyProfit(db, orderDate, req.user.tenantId);
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/product-breakdown?productName=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns individual sale transactions for a specific product within a date range
router.get('/product-breakdown', auth, readOnlyGuard, (req, res) => {
  try {
    const { productName, from, to, userId } = req.query;
    if (!productName) return res.status(400).json({ error: 'productName is required' });
    let sql = `
      SELECT o.order_number, o.created_at, oi.quantity, oi.unit_price, oi.total_price
      FROM order_items oi
      INNER JOIN orders o ON o.sync_id = oi.order_sync_id
      WHERE o.deleted_at IS NULL
        AND (o.status IS NULL OR o.status != 'Reversed')
        AND oi.deleted_at IS NULL
        AND (oi.reversed IS NULL OR oi.reversed = 0)
        AND o.tenant_id = ?
        AND oi.product_name = ?
    `;
    const params = [req.user.tenantId, productName];
    // from / to are ISO datetimes (UTC) sent by the frontend so the comparison
    // works regardless of the user's timezone. Comparing strings is safe here
    // because SQLite stores datetimes as ISO 8601.
    if (from) { sql += ' AND o.created_at >= ?'; params.push(from); }
    if (to)   { sql += ' AND o.created_at <= ?'; params.push(to); }
    if (userId && userId !== 'all') { sql += ' AND o.created_by = ?'; params.push(userId); }
    sql += ' ORDER BY o.created_at ASC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/product-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns total qty sold and revenue per product for active (non-reversed) orders
router.get('/product-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, userId } = req.query;
    // total_qty is reported in BASE units (sum of oi.quantity × conversion_factor when line is in alt unit).
    // Frontend uses unit + alt_unit + conversion_factor to format dual-unit display.
    let sql = `
      SELECT
        oi.product_name,
        p.category_id,
        c.name AS category_name,
        c.main_category_id,
        p.unit,
        p.alt_unit,
        p.conversion_factor,
        p.units_json,
        p.default_unit,
        SUM(${baseQtyExpr('p', 'oi')}) AS total_qty,
        ROUND(SUM(oi.total_price) / NULLIF(SUM(oi.quantity), 0), 2) AS avg_price,
        SUM(oi.total_price) AS total_revenue
      FROM order_items oi
      INNER JOIN orders o ON o.sync_id = oi.order_sync_id
      LEFT JOIN products p ON p.sync_id = oi.product_sync_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.deleted_at IS NULL
        AND (o.status IS NULL OR o.status != 'Reversed')
        AND oi.deleted_at IS NULL
        AND (oi.reversed IS NULL OR oi.reversed = 0)
        AND o.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    // from / to are ISO datetimes (UTC) sent by the frontend so the comparison
    // works regardless of the user's timezone. Comparing strings is safe here
    // because SQLite stores datetimes as ISO 8601.
    if (from) { sql += ' AND o.created_at >= ?'; params.push(from); }
    if (to)   { sql += ' AND o.created_at <= ?'; params.push(to); }
    if (userId && userId !== 'all') { sql += ' AND o.created_by = ?'; params.push(userId); }
    sql += ' GROUP BY oi.product_name, p.category_id, c.name, c.main_category_id, p.unit, p.alt_unit, p.conversion_factor, p.units_json, p.default_unit ORDER BY total_revenue DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get order details
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const order = db.prepare(
      `SELECT o.*, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS created_by_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.created_by
       WHERE o.id = ? AND o.deleted_at IS NULL AND o.tenant_id = ?`
    ).get(req.params.id, req.user.tenantId);
    const items = db.prepare(
      `SELECT oi.*, p.alt_unit, p.conversion_factor, p.unit AS product_base_unit,
              p.default_unit, p.units_json
       FROM order_items oi
       LEFT JOIN products p ON p.sync_id = oi.product_sync_id
       WHERE oi.order_sync_id = ? AND oi.deleted_at IS NULL`
    ).all(order?.sync_id);
    res.json({ ...order, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reverse order - void the order and restore stock
router.put('/:id/reverse', auth, (req, res) => {
  try {
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status === 'Reversed') throw Object.assign(new Error('Order already reversed'), { status: 400 });

      // Soft-delete original sale movements AND any partial sale_reverse counter-movements.
      // Net effect: stock returns to exactly its pre-sale state regardless of any prior partial reversals.
      db.prepare(
        `UPDATE stock_movements SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
         WHERE reference_sync_id = ? AND location = 'sales'
           AND movement_type IN ('sale', 'sale_reverse') AND deleted_at IS NULL`
      ).run(order.sync_id);

      // Mark all line items fully reversed (cumulative reversed_quantity = original quantity)
      db.prepare(
        `UPDATE order_items
         SET reversed = 1, reversed_quantity = quantity, reversed_at = datetime('now'), synced=0
         WHERE order_sync_id = ? AND reversed = 0 AND deleted_at IS NULL`
      ).run(order.sync_id);
      db.prepare("UPDATE orders SET status = 'Reversed', synced=0 WHERE id = ?").run(req.params.id);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    })();

    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (no 'T'), so .split('T')[0] would return the whole string.
    // .slice(0, 10) safely extracts YYYY-MM-DD for both SQLite and ISO formats.
    const orderDate = result.created_at ? result.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
    recalculateDailyProfit(db, orderDate, req.user.tenantId);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reverse a single item — supports PARTIAL reversal via body.quantity and body.unit
// Body: { quantity?: number, unit?: string }
//   quantity defaults to remaining line qty
//   unit defaults to the line's original unit (typically what was sold)
//   When unit differs from line.unit, the system converts via product's conversion_factor.
router.put('/:id/items/:itemId/reverse', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const requestedQty = req.body?.quantity != null ? parseFloat(req.body.quantity) : null;
    const requestedUnit = (req.body?.unit || '').trim() || null;

    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status === 'Reversed') throw Object.assign(new Error('Order already fully reversed'), { status: 400 });

      const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_sync_id = ? AND deleted_at IS NULL').get(req.params.itemId, order.sync_id);
      if (!item) throw Object.assign(new Error('Item not found in this order'), { status: 404 });
      if (item.reversed) throw Object.assign(new Error('Item already fully reversed'), { status: 400 });

      const prod = db.prepare('SELECT unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?').get(item.product_sync_id);

      // Resolve which unit user is reversing in
      const reverseUnit = requestedUnit || item.unit || prod?.unit;
      const reverseUnitConv = conversionToBase(prod, reverseUnit);
      const lineUnitConv = conversionToBase(prod, item.unit || prod?.unit);

      // Default to full remaining (in line's unit) if no qty given
      const alreadyReversedInLineUnit = parseFloat(item.reversed_quantity || 0);
      const remainingInLineUnit = parseFloat(item.quantity) - alreadyReversedInLineUnit;
      const reverseQty = requestedQty != null ? requestedQty : remainingInLineUnit;
      if (!(reverseQty > 0)) throw Object.assign(new Error('Reverse quantity must be greater than zero'), { status: 400 });

      // Convert reverseQty into BASE units (for stock_movement) and into LINE's unit (for tracking reversed_quantity)
      const reverseBaseQty = reverseQty * reverseUnitConv;
      const lineBaseQty    = parseFloat(item.quantity) * lineUnitConv;
      const reverseInLineUnit = reverseBaseQty / (lineUnitConv || 1);

      // Validate against remaining (compare in line's unit since that's how reversed_quantity is stored)
      if (reverseInLineUnit > remainingInLineUnit + 0.0001) {
        const remBase = remainingInLineUnit * lineUnitConv;
        throw Object.assign(new Error(`Cannot reverse more than ${remainingInLineUnit} ${item.unit || ''} (= ${remBase} ${prod?.unit || 'base units'})`), { status: 400 });
      }

      // Insert positive stock movement in BASE units to restore sales stock
      db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`
      ).run(item.product_id, item.product_sync_id, 'sales', 'sale_reverse', reverseBaseQty, req.params.id, 'order_reverse',
            `Partial reverse of ${reverseQty} ${reverseUnit}`, req.user.id,
            randomUUID(), tenantId, branchId, deviceId, order.sync_id);

      // Track reversed_quantity in LINE's unit (so item.quantity vs item.reversed_quantity stays consistent)
      const newReversedQty = alreadyReversedInLineUnit + reverseInLineUnit;
      const fullyReversed = newReversedQty >= parseFloat(item.quantity) - 0.0001;
      db.prepare(
        `UPDATE order_items SET reversed_quantity = ?, reversed = ?, reversed_at = CASE WHEN ? THEN datetime('now') ELSE reversed_at END, synced=0 WHERE id = ?`
      ).run(newReversedQty, fullyReversed ? 1 : 0, fullyReversed ? 1 : 0, req.params.itemId);

      // Proportional refund based on reversed base qty relative to original base qty
      const refund = (reverseBaseQty / lineBaseQty) * parseFloat(item.total_price);
      const newSubtotal = Math.max(0, parseFloat(order.subtotal) - refund);
      const newTotal = Math.max(0, parseFloat(order.total_amount) - refund);

      // Order status: 'Reversed' if every item is fully reversed, else 'Partial' (or original status if nothing reversed)
      const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM order_items WHERE order_sync_id = ? AND reversed = 0 AND deleted_at IS NULL').get(order.sync_id);
      const allReversed = remaining.cnt === 0;

      db.prepare('UPDATE orders SET subtotal = ?, total_amount = ?, status = ?, synced=0 WHERE id = ?').run(
        newSubtotal, newTotal, allReversed ? 'Reversed' : 'Partial', req.params.id
      );

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      const allItems = db.prepare('SELECT * FROM order_items WHERE order_sync_id = ? AND deleted_at IS NULL').all(order.sync_id);
      return { ...updatedOrder, items: allItems };
    })();

    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (no 'T'), so .split('T')[0] would return the whole string.
    // .slice(0, 10) safely extracts YYYY-MM-DD for both SQLite and ISO formats.
    const orderDate = result.created_at ? result.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
    recalculateDailyProfit(db, orderDate, req.user.tenantId);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
