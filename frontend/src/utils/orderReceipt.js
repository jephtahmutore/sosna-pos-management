// Sales receipt printing, shared by every screen that reprints an order
// (Sales Report, Account Receivables) so the paper is identical wherever
// it is printed from. ctx carries the per-tenant bits the receipt needs:
//   { curSym, isLiquorStyle, businessName, businessAddress, businessPhone }
import { printReceipt } from '../services/api';
import { pickDisplayUnit } from './productUnits';
import printHtml from './printHtml';

// Build the 80mm thermal-receipt HTML used by both the print fallback
// and the explicit Download PDF button. Single source of truth so the
// two paths produce identical output.
export const buildReceiptHtml = (order, { curSym, isLiquorStyle, businessName, businessAddress, businessPhone }) => {
  const div = '='.repeat(42);
  const fmt2 = (n) => (parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt0 = (n) => (parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  // v1.10.63 — track whether any line was sold in a non-default unit
  // so we can print the "** sold in alternate unit" legend at the
  // bottom, matching POS.js.
  let hasAltUnit = false;
  // v1.10.59/63 — Liquor keeps its 2-line format with PRICE and TOTAL
  // columns (matches ESC/POS backend and POS.js till receipt). Sosna
  // renders Name + Qty only per the dual-currency redesign.
  const itemRows = (order.items || []).map(item => {
    const origQty = parseFloat(item.quantity || 0);
    const rq      = parseFloat(item.reversed_quantity || 0);
    const partial = !item.reversed && rq > 0;
    const netQty  = partial ? Math.max(0, origQty - rq) : origQty;
    const unitPx  = parseFloat(item.unit_price || 0);
    const netTotal = partial ? unitPx * netQty : parseFloat(item.total_price || 0);
    // Same non-default-unit flag as the on-page receipt.
    const dispUnit = pickDisplayUnit(item);
    let hasMultiUnits = false;
    try {
      const arr = item.units_json ? JSON.parse(item.units_json) : null;
      if (Array.isArray(arr) && arr.length > 1) hasMultiUnits = true;
    } catch { /* ignore */ }
    if (!hasMultiUnits && item.alt_unit && item.alt_unit !== item.product_base_unit) hasMultiUnits = true;
    const soldInNonDefault = hasMultiUnits && item.unit && dispUnit.name && item.unit !== dispUnit.name;
    if (soldInNonDefault) hasAltUnit = true;
    const marker = soldInNonDefault ? ' **' : '';
    const rowWeight = soldInNonDefault ? 'font-weight:700;' : '';
    const nameLabel = item.product_name + (item.reversed ? ' [VOID]' : '') + marker;
    if (!isLiquorStyle) {
      // Sosna: Name + Qty only, single row per item.
      const partialNoteSosna = partial ? `<tr><td colspan="2" style="font-size:9px;color:#b45309;padding-left:6px">was ${origQty} ${item.unit || ''} — reversed ${rq}</td></tr>` : '';
      return `
      <tr style="${rowWeight}${item.reversed ? 'text-decoration:line-through;color:#999;' : ''}">
        <td style="font-weight:700;padding-top:4px;">${nameLabel}</td>
        <td style="text-align:right;white-space:nowrap;padding-top:4px;">${netQty} ${item.unit || ''}</td>
      </tr>
      ${partialNoteSosna}`;
    }
    // Liquor: 2-line format — name on line 1, indented qty + unit_price + gross on line 2.
    // v1.10.63 — unit_price and gross now prefixed with curSym so the
    // paper matches the POS till receipt.
    const partialNote = partial ? `<tr><td colspan="4" style="font-size:9px;color:#b45309;padding-left:6px">was ${origQty} ${item.unit || ''} — reversed ${rq}</td></tr>` : '';
    return `
    <tr><td colspan="4" style="font-weight:700;padding-top:4px;${item.reversed ? 'text-decoration:line-through;color:#999;' : ''}">${nameLabel}</td></tr>
    <tr style="${rowWeight}${item.reversed ? 'color:#999;' : ''}">
      <td></td>
      <td style="text-align:right;padding-left:8px;${partial ? 'font-weight:700' : ''}">${netQty} ${item.unit || ''}</td>
      <td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(unitPx)}</td>
      <td style="text-align:right;white-space:nowrap;${partial ? 'font-weight:700' : ''}">${curSym}${fmt2(netTotal)}</td>
    </tr>
    ${partialNote}`;
  }).join('');

  // v1.10.63 — Payment section labels now respect isLiquorStyle. Liquor
  // (Mansa/Lusaka) uses Cash / MoMo / Bank; Sosna (Kassumbalesa) keeps
  // USD ($) / FRA / K. Same field routing convention as CashBook:
  // cash_received=Cash, fra_received=MoMo, k_received=Bank on Liquor.
  const paymentSection = (() => {
    const u = parseFloat(order.cash_received || 0);
    const f = parseFloat(order.fra_received || 0);
    const k = parseFloat(order.k_received || 0);
    const hasSplit = u + f + k > 0.001;
    const amtRecv = parseFloat(order.amount_received || 0);
    if (!hasSplit) {
      return `<tr class="amt"><td>Amt Received:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(amtRecv)}</td></tr>`;
    }
    if (isLiquorStyle) {
      return `${u > 0 ? `<tr><td>Cash:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(u)}</td></tr>` : ''}
              ${f > 0 ? `<tr><td>MoMo:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(f)}</td></tr>` : ''}
              ${k > 0 ? `<tr><td>Bank:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(k)}</td></tr>` : ''}
              <tr class="amt"><td>Total Received:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(amtRecv)}</td></tr>`;
    }
    return `${u > 0 ? `<tr><td>USD ($):</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(u)}</td></tr>` : ''}
            ${f > 0 ? `<tr><td>FRA:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${fmt0(f)}</td></tr>` : ''}
            ${k > 0 ? `<tr><td>K:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${fmt0(k)}</td></tr>` : ''}
            <tr class="amt"><td>Total Received:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(amtRecv)}</td></tr>`;
  })();

  const dt = new Date(order.created_at + 'Z');
  const dateTimeStr = `${dt.toLocaleDateString('en-GB')} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  // Cashier name — orders may store it under a couple of legacy fields.
  // Whichever we get, fall back to "Staff" so we never print blank.
  const cashierName = order.served_by || order.cashier_name || order.created_by_name || 'Staff';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    /* v1.10.63 — @page margin cleared, padding moved to body to match
       POS.js render pattern. Same asymmetric left offset (extra 3mm)
       to survive the Epson TM-T88VII paper-feed offset. */
    @page { size: 80mm auto; margin: 0; }
    html, body { height: auto; margin: 0; padding: 0; overflow-x: hidden; }
    * { box-sizing: border-box; }
    body {
      width: 72mm;
      max-width: 72mm;
      padding: 2mm 2mm 2mm 5mm;
      /* v1.10.62 — Liquor uses Arial Black so sans-serif survives
         thermal rasterisation; regular Arial-bold prints thin grey.
         Sosna stays on Courier for the dual-currency reprint. */
      font-family: ${isLiquorStyle ? "'Arial Black', 'Impact', Arial, Helvetica, sans-serif" : "'Courier New', monospace"};
      font-size: 11px;
      color: #000;
      font-weight: 700;
    }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    td { padding: 1px 0; vertical-align: top; }
    .c { text-align: center; }
    .div { text-align: center; font-size: 10px; margin: 3px 0; overflow: hidden; white-space: nowrap; }
    .grand { font-size: 16px; font-weight: 800; }
    .amt { font-size: 13px; font-weight: 700; }
  </style></head><body>
  <div class="c" style="font-size:14px;font-weight:700;letter-spacing:1px;">${businessName}</div>
  ${businessAddress ? `<div class="c" style="font-size:11px;">${String(businessAddress).replace(/\n/g, '<br/>')}</div>` : ''}
  ${businessPhone ? `<div class="c" style="font-size:11px;">Tel: ${businessPhone}</div>` : ''}
  <div class="div">${div}</div>
  <div class="c" style="font-weight:700;font-size:12px;">${order.status === 'Reversed' ? '*** REVERSED ***' : 'SALES RECEIPT'}</div>
  <div class="div">${div}</div>
  <table>
    <tr><td>Receipt #:</td><td></td><td style="text-align:right">${order.order_number}</td></tr>
    <tr><td>Date &amp; Time:</td><td></td><td style="text-align:right">${dateTimeStr}</td></tr>
    <tr><td>Customer:</td><td></td><td style="text-align:right">${order.customer_name || 'Walk-in'}</td></tr>
    <tr><td>Served by:</td><td></td><td style="text-align:right">${cashierName}</td></tr>
  </table>
  <div class="div">${div}</div>
  <table>
    ${isLiquorStyle
      ? '' /* Liquor: no header row — matches ESC/POS. */
      : '<tr style="font-size:10px"><td style="font-weight:700;">ITEM</td><td style="text-align:right;font-weight:700;">QTY</td></tr>'}
    ${itemRows}
  </table>
  <div class="div">${'-'.repeat(42)}</div>
  <table>
    <tr><td>Subtotal</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(order.subtotal)}</td></tr>
    ${parseFloat(order.discount) > 0 ? `<tr><td>Discount</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">-${curSym}${fmt2(order.discount)}</td></tr>` : ''}
  </table>
  <div class="div">${div}</div>
  <table>
    <tr class="grand"><td>TOTAL</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(order.total_amount)}</td></tr>
  </table>
  <div class="div">${div}</div>
  <table>
    ${paymentSection}
    <tr class="amt"><td>${parseFloat(order.change_amount || 0) >= 0 ? '*** CHANGE ***' : '*** BAL DUE ***'}</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(Math.abs(parseFloat(order.change_amount || 0)))}</td></tr>
  </table>
  <div class="div">${div}</div>
  <div class="c" style="margin-top:4px">Thank you for your purchase!</div>
  <div class="c">Please come again.</div>
  ${hasAltUnit ? `<div class="c" style="margin-top:6px;font-size:10px;">** sold in alternate unit (not default)</div>` : ''}
  </body></html>`;

  return html;
};

export const printOrderReceipt = async (order, ctx) => {
  // First try silent print via the backend ESC/POS path (same as POS does).
  // Falls back to the browser dialog below if the backend has no printer
  // configured or returns an error (e.g. web tenants).
  try {
    const usdRcv = parseFloat(order.cash_received || 0);
    const fraRcv = parseFloat(order.fra_received || 0);
    const kRcv   = parseFloat(order.k_received || 0);
    const splitSum = usdRcv + fraRcv + kRcv;
    const paymentLabel = splitSum > 0
      ? [usdRcv > 0 && 'USD', fraRcv > 0 && 'FRA', kRcv > 0 && 'K'].filter(Boolean).join(' + ')
      : (order.payment_method || '');
    const dt = new Date(order.created_at + 'Z');
    await printReceipt({
      orderNumber: order.order_number,
      dateTime: `${dt.toLocaleDateString('en-GB')} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
      customerName: order.customer_name || 'Walk-in',
      servedBy: paymentLabel || 'Staff',
      items: (order.items || []).map(i => {
        const rq = parseFloat(i.reversed_quantity || 0);
        const netQty = !i.reversed && rq > 0 ? Math.max(0, parseFloat(i.quantity) - rq) : parseFloat(i.quantity);
        return {
          product_name: i.product_name + (i.reversed ? ' [VOID]' : ''),
          unit: i.unit || '',
          quantity: i.reversed ? 0 : netQty,
          unit_price: parseFloat(i.unit_price || 0),
          discount: parseFloat(i.discount || 0),
        };
      }),
      discount: order.discount,
      total: order.total_amount,
      amountReceived: order.amount_received,
      // v1.8.1 — pass triple-currency receipts as the new fields.
      // Legacy momo/bank fields zeroed at source so the ESC/POS printer
      // helper omits those lines. cashReceived stays for back-compat.
      cashReceived: order.cash_received,
      fraReceived: order.fra_received,
      kReceived: order.k_received,
      momoReceived: 0,
      bankReceived: 0,
      change: order.change_amount,
      fraChangeGiven: order.fra_change_given,
      kChangeGiven: order.k_change_given,
    });
    return; // silent print succeeded
  } catch (_) { /* fall through to browser-print fallback */ }

  printHtml(buildReceiptHtml(order, ctx));
};
