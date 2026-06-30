const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const user = db.prepare(
      'SELECT id, first_name, last_name, email, phone, address, role FROM users WHERE id = ? AND tenant_id = ?'
    ).get(req.user.id, req.user.tenantId);
    const business = db.prepare('SELECT * FROM business_settings WHERE tenant_id = ? LIMIT 1').get(req.user.tenantId) || {};
    res.json({ user, business });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/profile', auth, (req, res) => {
  try {
    const { firstName, lastName, email, phone, address } = req.body;
    db.prepare(
      "UPDATE users SET first_name=?, last_name=?, email=?, phone=?, address=?, updated_at=datetime('now'), synced=0 WHERE id=?"
    ).run(firstName, lastName, email, phone, address, req.user.id);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Normalise an incoming currencies array. Accepts [{ code, symbol, is_primary }] or null.
// Guarantees: at least one entry, exactly one primary, dedupes by code.
function normaliseCurrencies(input) {
  let arr = Array.isArray(input) ? input : null;
  if (!arr || arr.length === 0) {
    arr = [{ code: 'USD', symbol: '$', is_primary: true }];
  }
  const seen = new Set();
  const cleaned = [];
  for (const c of arr) {
    const code = (c.code || '').toString().trim().toUpperCase();
    const symbol = (c.symbol || '').toString().trim();
    if (!code || !symbol) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    cleaned.push({ code, symbol, is_primary: !!c.is_primary });
  }
  if (cleaned.length === 0) cleaned.push({ code: 'USD', symbol: '$', is_primary: true });
  // Force exactly one primary.
  let primaryIdx = cleaned.findIndex(c => c.is_primary);
  if (primaryIdx === -1) primaryIdx = 0;
  cleaned.forEach((c, i) => { c.is_primary = i === primaryIdx; });
  return cleaned;
}

router.put('/business', auth, (req, res) => {
  try {
    const { business_name, business_phone, business_email, business_address, tax_rate, single_location_mode, block_oversell, currencies,
            receipt_printer_type, receipt_printer_name, receipt_printer_ip, receipt_printer_port,
            default_crate_deposit, currency_mode, workflow_mode,
            legacy_procurement_enabled,
            // v1.9.26 — payment_methods is the third dial alongside
            // currency_mode + workflow_mode. 'cash_only' (Sosna-style:
            // Cash only at the till) | 'cash_momo_bank' (Liquor-style:
            // Cash + MoMo + Bank). Independent of currency / workflow.
            payment_methods } = req.body;
    // Only update currencies if the caller explicitly sent them; otherwise leave whatever's stored.
    const currenciesJson = currencies !== undefined ? JSON.stringify(normaliseCurrencies(currencies)) : null;
    const existing = db.prepare('SELECT * FROM business_settings LIMIT 1').get();
    let row;
    if (existing) {
      // Fully partial update — only fields the caller actually sent get included in SET.
      // Two pages share this endpoint (Profile saves company identity; System Settings
      // saves currencies/printer/etc). Without partial semantics, each page would clobber
      // the other's columns by sending undefined.
      const sets = [];
      const vals = [];
      if (business_name    !== undefined) { sets.push('business_name=?');         vals.push(business_name); }
      if (business_phone   !== undefined) { sets.push('business_phone=?');        vals.push(business_phone); }
      if (business_email   !== undefined) { sets.push('business_email=?');        vals.push(business_email); }
      if (business_address !== undefined) { sets.push('business_address=?');      vals.push(business_address); }
      if (tax_rate         !== undefined) { sets.push('tax_rate=?');              vals.push(tax_rate); }
      if (single_location_mode !== undefined) {
        const slm = (single_location_mode === true || single_location_mode === 1 || single_location_mode === '1') ? 1 : 0;
        sets.push('single_location_mode=?'); vals.push(slm);
      }
      if (block_oversell !== undefined) {
        const bo = (block_oversell === true || block_oversell === 1 || block_oversell === '1') ? 1 : 0;
        sets.push('block_oversell=?'); vals.push(bo);
      }
      if (currenciesJson !== null) { sets.push('currencies_json=?'); vals.push(currenciesJson); }
      if (receipt_printer_type !== undefined) {
        sets.push('receipt_printer_type=?');
        vals.push(String(receipt_printer_type).toLowerCase() === 'lan' ? 'lan' : 'usb');
      }
      if (receipt_printer_name !== undefined) { sets.push('receipt_printer_name=?'); vals.push(receipt_printer_name || null); }
      if (receipt_printer_ip   !== undefined) { sets.push('receipt_printer_ip=?');   vals.push(receipt_printer_ip   || null); }
      if (receipt_printer_port !== undefined) { sets.push('receipt_printer_port=?'); vals.push(parseInt(receipt_printer_port) || 9100); }
      if (default_crate_deposit !== undefined) { sets.push('default_crate_deposit=?'); vals.push(parseFloat(default_crate_deposit) || 0); }
      // currency_mode is a per-branch feature gate. 'K' = Kwacha only (lusaka1,
      // mansa1); 'USD+FRA' = dual currency, unlocks FX rate inputs, dual-
      // currency payment modal, USD+FRA receipt lines (kassumbalesa1).
      // Anything else is normalised to 'K' to avoid bad string slipping through.
      // v1.7.0: now accepts a third value 'USD+FRA+K' (triple-currency
      // cash acceptance — items still priced in USD).
      if (currency_mode !== undefined) {
        const raw = String(currency_mode || 'K').toUpperCase();
        const cm = ['USD+FRA+K', 'USD+FRA'].includes(raw) ? raw : 'K';
        sets.push('currency_mode=?'); vals.push(cm);
      }
      // workflow_mode is a per-branch UI gate.
      //   'single_pos'    = one cashier does everything (default)
      //   'two_station'   = Sales → Cashier (stock deducts on payment, no Dispatch) — v1.6.3
      //   'three_station' = Sales → Cashier → Dispatch with the full state machine
      // Anything else falls back to 'single_pos' so a bad value can't break the page.
      if (workflow_mode !== undefined) {
        const raw = String(workflow_mode || 'single_pos').toLowerCase();
        const wm = ['three_station', 'two_station'].includes(raw) ? raw : 'single_pos';
        sets.push('workflow_mode=?'); vals.push(wm);
      }
      // v1.9.26 — payment_methods controls which method columns appear on
      // the POS Pay modal. 'cash_only' = Sosna 3-currency cash branches
      // (no MoMo, no Bank). 'cash_momo_bank' = Liquor-style branches that
      // accept all three. Anything else falls back to cash_momo_bank.
      if (payment_methods !== undefined) {
        const raw = String(payment_methods || 'cash_momo_bank').toLowerCase();
        const pm = ['cash_only', 'cash_momo_bank'].includes(raw) ? raw : 'cash_momo_bank';
        sets.push('payment_methods=?'); vals.push(pm);
      }
      // legacy_procurement_enabled re-exposes the legacy GRN + Suppliers
      // sidebar entries on a branch (hidden by v1.3.2 lockdown). Useful
      // for branch launch / migration; HQ-side ignores it.
      if (legacy_procurement_enabled !== undefined) {
        const lp = (legacy_procurement_enabled === true || legacy_procurement_enabled === 1 || legacy_procurement_enabled === '1') ? 1 : 0;
        sets.push('legacy_procurement_enabled=?'); vals.push(lp);
      }
      if (sets.length === 0) return res.json(existing); // nothing to update
      sets.push("updated_at=datetime('now')", 'synced=0');
      vals.push(existing.id);
      db.prepare(`UPDATE business_settings SET ${sets.join(', ')} WHERE id=?`).run(...vals);
      row = db.prepare('SELECT * FROM business_settings WHERE id = ?').get(existing.id);
    } else {
      const slm = (single_location_mode === true || single_location_mode === 1 || single_location_mode === '1') ? 1 : 0;
      const printerType = String(receipt_printer_type || 'usb').toLowerCase() === 'lan' ? 'lan' : 'usb';
      const printerName = receipt_printer_name || null;
      const printerIp   = receipt_printer_ip   || null;
      const printerPort = parseInt(receipt_printer_port) || 9100;
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const info = db.prepare(
        `INSERT INTO business_settings (business_name, business_phone, business_email, business_address, tax_rate, single_location_mode, currencies_json,
                                        receipt_printer_type, receipt_printer_name, receipt_printer_ip, receipt_printer_port,
                                        sync_id, tenant_id, branch_id, device_id, synced)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
      ).run(business_name || null, business_phone || null, business_email || null, business_address || null, tax_rate || null, slm,
            currenciesJson || JSON.stringify(normaliseCurrencies(null)),
            printerType, printerName, printerIp, printerPort,
            randomUUID(), tenantId, branchId, deviceId);
      row = db.prepare('SELECT * FROM business_settings WHERE id = ?').get(info.lastInsertRowid);
    }
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/drawer-port — get configured cash drawer port
router.get('/drawer-port', (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM sync_config WHERE key = 'drawer_port'").get();
    res.json({ port: row?.value || 'POS-80' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings/drawer-port — save cash drawer port
router.put('/drawer-port', auth, (req, res) => {
  try {
    const { port } = req.body;
    if (!port || !port.trim()) return res.status(400).json({ error: 'Port is required.' });
    const existing = db.prepare("SELECT value FROM sync_config WHERE key = 'drawer_port'").get();
    if (existing) {
      db.prepare("UPDATE sync_config SET value = ? WHERE key = 'drawer_port'").run(port.trim());
    } else {
      db.prepare("INSERT INTO sync_config (key, value) VALUES ('drawer_port', ?)").run(port.trim());
    }
    res.json({ port: port.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/open-drawer — fires the ESC/POS drawer kick via the configured transport.
// Now routes through escpos.js: USB → Windows Print Spooler, LAN → TCP socket to printer:9100.
router.post('/open-drawer', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const result = await sendToPrinter(db, CMD.DRAWER_KICK);
    if (!result.ok) return res.status(500).json({ error: 'Failed to open drawer: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/print-receipt — build the receipt bytes and send via the configured transport.
//
// Canonical receipt design (must match the on-screen modal in POS.js so the two
// surfaces never drift):
//   - Business header: name, address (if set), phone (if set)
//   - Title "SALES RECEIPT"
//   - Receipt # / Date & Time (single row) / Customer / Served by
//   - Per item: name on its own line, then qty/price/gross-line-total. If the
//     line carries a discount, an indented sub-row "discount {qty} x -K{u}"
//     with the signed total on the right.
//   - Pre-discount Subtotal, signed Discount line, then TOTAL.
//   - Payment split shown when cash/momo/bank are provided separately.
//
// Business name/phone/address and the currency symbol are read from
// business_settings — the route is the source of truth, callers don't need
// to pass them.
router.post('/print-receipt', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const { orderNumber, dateTime, customerName, servedBy, items,
            total, amountReceived, cashReceived, momoReceived, bankReceived, change } = req.body;

    // ── Authoritative business + currency info from settings ──
    const biz = db.prepare(
      'SELECT business_name, business_phone, business_address, currencies_json FROM business_settings LIMIT 1'
    ).get() || {};
    const businessName    = biz.business_name    || 'SOSNA PRO';
    const businessPhone   = biz.business_phone   || '';
    const businessAddress = biz.business_address || '';
    let cur = 'K';
    try {
      const arr = JSON.parse(biz.currencies_json || '[]');
      const primary = arr.find(c => c.is_primary) || arr[0];
      if (primary?.symbol) cur = primary.symbol;
    } catch { /* default 'K' */ }

    const W = 42;
    const eq = '='.repeat(W);
    const da = '-'.repeat(W);
    const center = (str) => {
      const s = String(str).substring(0, W);
      const pad = Math.floor((W - s.length) / 2);
      return ' '.repeat(pad) + s;
    };
    const cols = (left, right) => {
      const l = String(left).substring(0, W - String(right).length - 1);
      return l + ' '.repeat(W - l.length - String(right).length) + String(right);
    };
    const fmt = (n) => parseFloat(n || 0).toFixed(2);

    const lines = [];
    lines.push(center(businessName));
    if (businessAddress) {
      // Long addresses get wrapped onto multiple centered lines.
      String(businessAddress).split(/\r?\n/).forEach(ln => {
        const t = ln.trim();
        if (!t) return;
        for (let i = 0; i < t.length; i += W) lines.push(center(t.substring(i, i + W)));
      });
    }
    if (businessPhone) lines.push(center('Tel: ' + businessPhone));
    lines.push(eq);
    lines.push(center('SALES RECEIPT'));
    lines.push(eq);
    lines.push(cols('Receipt #:',  orderNumber  || ''));
    lines.push(cols('Date & Time:', dateTime    || ''));
    lines.push(cols('Customer:',   customerName || 'Walk-in'));
    lines.push(cols('Served by:',  servedBy     || 'Staff'));
    lines.push(eq);

    // ── Items: gross line totals + per-line discount sub-row ──
    // Lines sold in a non-default unit are flagged with ` **` after the
    // product name and a single explanatory legend is appended at the
    // very bottom of the receipt (only if at least one line carries the
    // flag — receipts with all default-unit lines stay clean).
    let grossSubtotal = 0;
    let lineDiscSum   = 0;
    let hasAltUnit    = false;
    (items || []).forEach(item => {
      const qty       = parseFloat(item.quantity)    || 0;
      const unitPrice = parseFloat(item.unit_price)  || 0;
      const lineDisc  = parseFloat(item.discount)    || 0;       // per-unit discount
      const gross     = qty * unitPrice;
      const discTotal = qty * lineDisc;
      grossSubtotal += gross;
      lineDiscSum   += discTotal;
      const isAlt = !!item.is_alt_unit;
      if (isAlt) hasAltUnit = true;

      const nameLine = String(item.product_name) + (isAlt ? ' **' : '');
      lines.push(nameLine.substring(0, W));
      const qtyStr = `  ${qty.toFixed(2)} ${item.unit || ''}`;
      const right  = `${cur}${fmt(unitPrice)}  ${cur}${fmt(gross)}`;
      lines.push(qtyStr + ' '.repeat(Math.max(1, W - qtyStr.length - right.length)) + right);
      if (lineDisc > 0) {
        // Indented sub-row showing the discount math, signed total on the right.
        const left  = `    discount ${qty.toFixed(2)} x -${cur}${fmt(lineDisc)}`;
        const r     = `-${cur}${fmt(discTotal)}`;
        lines.push(left + ' '.repeat(Math.max(1, W - left.length - r.length)) + r);
      }
    });

    lines.push(da);

    // Cart-level discount (e.g. a manager applies a flat extra discount in addition to per-line ones).
    const cartDisc  = parseFloat(req.body.discount || 0);
    const totalDisc = lineDiscSum + cartDisc;

    lines.push(cols('Subtotal:', `${cur}${fmt(grossSubtotal)}`));
    if (totalDisc > 0) lines.push(cols('Discount:', `-${cur}${fmt(totalDisc)}`));
    lines.push(eq);
    lines.push(cols('TOTAL:', `${cur}${fmt(total)}`));
    lines.push(eq);

    // ── Payment / change ──
    const cash   = parseFloat(cashReceived || 0);
    const momo   = parseFloat(momoReceived || 0);
    const bank   = parseFloat(bankReceived || 0);
    const hasSplit = (cash + momo + bank) > 0.001;
    if (hasSplit) {
      if (cash > 0) lines.push(cols('Cash:', `${cur}${fmt(cash)}`));
      if (momo > 0) lines.push(cols('MoMo:', `${cur}${fmt(momo)}`));
      if (bank > 0) lines.push(cols('Bank:', `${cur}${fmt(bank)}`));
      lines.push(cols('Total Received:', `${cur}${fmt(amountReceived)}`));
    } else {
      lines.push(cols('Amt Received:', `${cur}${fmt(amountReceived)}`));
    }
    if (parseFloat(amountReceived || 0) >= parseFloat(total || 0)) {
      lines.push(cols('*** CHANGE ***:', `${cur}${fmt(change)}`));
    } else {
      const due = parseFloat(total || 0) - parseFloat(amountReceived || 0);
      lines.push(cols('*** BALANCE DUE ***:', `${cur}${fmt(due)}`));
    }
    lines.push(eq);
    lines.push(center('Thank you for your purchase!'));
    lines.push(center('Please come again.'));
    if (hasAltUnit) {
      // Legend for the ** flag on alt-unit lines, only when something used it.
      lines.push('');
      lines.push(center('** sold in alternate unit (not default)'));
    }

    const text = lines.join('\n') + '\n\n\n\n\n\n';
    const ticket = CMD.INIT + CMD.DRAWER_KICK + text + CMD.CUT;
    const result = await sendToPrinter(db, ticket);
    if (!result.ok) return res.status(500).json({ error: 'Failed to print: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/print-report — build the report bytes and send via the configured transport.
router.post('/print-report', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const { businessName, dateLabel, totalOrders, filteredCount, totalRevenue, totalDiscount, products } = req.body;

    const W = 42;
    const eq = '='.repeat(W);
    const da = '-'.repeat(W);
    const center = (str) => {
      const s = String(str).substring(0, W);
      const pad = Math.floor((W - s.length) / 2);
      return ' '.repeat(pad) + s;
    };
    const cols = (left, right) => {
      const l = String(left).substring(0, W - String(right).length - 1);
      return l + ' '.repeat(W - l.length - String(right).length) + String(right);
    };

    const lines = [];
    lines.push(center(businessName || 'BUTCHERY PRO'));
    lines.push(eq);
    lines.push(center('SALES REPORT'));
    lines.push(center(dateLabel || ''));
    lines.push(eq);
    lines.push(cols('Total Orders:', `${totalOrders} (${filteredCount} incl. void)`));
    lines.push(cols('Total Revenue:', `K${parseFloat(totalRevenue || 0).toFixed(2)}`));
    lines.push(cols('Total Discounts:', `K${parseFloat(totalDiscount || 0).toFixed(2)}`));
    lines.push(eq);

    // Column headers
    const col1W = 20, col2W = 6, col3W = 7, col4W = 9;
    lines.push('PRODUCT'.padEnd(col1W) + 'QTY'.padStart(col2W) + 'PRICE'.padStart(col3W) + 'TOTAL'.padStart(col4W));
    lines.push(da);

    let grandTotal = 0;
    (products || []).forEach(p => {
      const name = String(p.product_name).substring(0, col1W).padEnd(col1W);
      const qty = parseFloat(p.total_qty).toFixed(2).padStart(col2W);
      const price = `K${parseFloat(p.avg_price).toFixed(2)}`.padStart(col3W);
      const total = `K${parseFloat(p.total_revenue).toFixed(2)}`.padStart(col4W);
      lines.push(name + qty + price + total);
      grandTotal += parseFloat(p.total_revenue);
    });

    lines.push(da);
    lines.push(cols('GRAND TOTAL:', `K${grandTotal.toFixed(2)}`));
    lines.push(eq);

    const now = new Date();
    lines.push(center('Printed: ' + now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })));

    const text = lines.join('\n') + '\n\n\n\n\n\n';
    const ticket = CMD.INIT + text + CMD.CUT;
    const result = await sendToPrinter(db, ticket);
    if (!result.ok) return res.status(500).json({ error: 'Failed to print report: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/print-count-worksheet — thermal stock-count worksheet.
// Silent print via the existing receipt printer (same transport as
// /print-receipt and /open-drawer). Caller sends the products with their
// system qty + breakdown text; this route lays them out at 42-char width
// with blank "Counted" boxes for hand-writing during the physical count.
router.post('/print-count-worksheet', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const { location, countDate, cashier, products, notes } = req.body;

    // Authoritative business header — same source as /print-receipt.
    const biz = db.prepare(
      'SELECT business_name, business_phone, business_address FROM business_settings LIMIT 1'
    ).get() || {};
    const businessName    = biz.business_name    || 'SOSNA PRO';
    const businessPhone   = biz.business_phone   || '';
    const businessAddress = biz.business_address || '';

    const W = 42;
    const eq = '='.repeat(W);
    const da = '-'.repeat(W);
    const center = (str) => {
      const s = String(str).substring(0, W);
      const pad = Math.floor((W - s.length) / 2);
      return ' '.repeat(pad) + s;
    };
    const cols = (left, right) => {
      const l = String(left).substring(0, W - String(right).length - 1);
      return l + ' '.repeat(W - l.length - String(right).length) + String(right);
    };

    const lines = [];

    // Header
    lines.push(center(businessName));
    if (businessAddress) {
      String(businessAddress).split(/\r?\n/).forEach(ln => {
        const t = ln.trim();
        if (!t) return;
        for (let i = 0; i < t.length; i += W) lines.push(center(t.substring(i, i + W)));
      });
    }
    if (businessPhone) lines.push(center('Tel: ' + businessPhone));
    lines.push(eq);
    lines.push(center('STOCK RECONCILIATION'));
    lines.push(center('COUNT WORKSHEET'));
    lines.push(eq);
    lines.push(cols('Location:',  location || 'Sales Floor'));
    lines.push(cols('Date:',      countDate || ''));
    if (cashier) lines.push(cols('Cashier:', cashier));
    lines.push(cols('Items to count:', String((products || []).length)));
    lines.push(eq);
    lines.push('');

    // Items — each gets the name + SKU on one line, system qty (and base
    // breakdown when the display qty isn't already in base units), then a
    // blank counted box.
    (products || []).forEach((p, idx) => {
      const num = `#${idx + 1} `;
      const name = String(p.product_name || '');
      const sku  = String(p.sku || '');
      // Try to fit "#N  Name                      SKU" on one line.
      const nameWidth = W - num.length - sku.length - 1;
      const trimmedName = name.length > nameWidth ? name.substring(0, nameWidth) : name;
      const gap = ' '.repeat(Math.max(1, W - num.length - trimmedName.length - sku.length));
      lines.push(num + trimmedName + gap + sku);

      // System qty — display line first
      const sysDisplay = String(p.system_display || '').trim();
      const sysBase    = String(p.system_base    || '').trim();
      if (sysDisplay) {
        lines.push('    System:  ' + sysDisplay);
        if (sysBase && sysBase !== sysDisplay) {
          lines.push('           = ' + sysBase);
        }
      } else if (sysBase) {
        lines.push('    System:  ' + sysBase);
      }
      // Counted box — wide blank for hand-written entry
      lines.push('    Counted: _____________________ ______');
      lines.push('                  (physical qty)  (unit)');
      lines.push('');
    });

    // Notes section
    lines.push(eq);
    lines.push('NOTES (anomalies, damages, expiries):');
    if (notes) {
      // Existing notes from the on-screen field — wrap to width
      const wrapAt = W - 2;
      String(notes).split(/\r?\n/).forEach(ln => {
        const t = ln.trim();
        if (!t) return;
        for (let i = 0; i < t.length; i += wrapAt) lines.push('  ' + t.substring(i, i + wrapAt));
      });
      lines.push('');
    }
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push(eq);

    // Sign-off block
    lines.push('Counted by:');
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('Signature:');
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('Time finished:');
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push(eq);

    const now = new Date();
    lines.push(center('Printed: ' + now.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })));

    const text = lines.join('\n') + '\n\n\n\n\n\n';
    const ticket = CMD.INIT + text + CMD.CUT;
    const result = await sendToPrinter(db, ticket);
    if (!result.ok) return res.status(500).json({ error: 'Failed to print worksheet: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
