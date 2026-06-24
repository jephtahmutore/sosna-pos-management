import React, { useState, useEffect, useCallback } from 'react';
import { getOrders, getOrder, reverseOrder, reverseOrderItem, getSettings, getOrderProductSummary, getProductBreakdown, printReport, printReceipt, getSalesCashiers, getCategories, getMainCategories } from '../services/api';
import CategoryFilter from '../components/CategoryFilter';
import { FiFileText, FiDollarSign, FiShoppingCart, FiCalendar, FiEye, FiRotateCcw, FiX, FiPrinter, FiDownload } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import { pickDisplayUnit, displayPriceInDefaultUnit, displayInDefaultUnit } from '../utils/productUnits';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import printHtml, { downloadPdf, shouldShowMobilePdfButton } from '../utils/printHtml';
const _d = new Date(); const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;

// Partial reverse (per-item void) is disabled — it can flip AR negative on
// part-paid sales because the line refund reduces total_amount without
// touching amount_received. For partial returns, use Sales Return / Credit
// Notes instead. The backend route still exists; flip this flag back to
// `true` to re-enable the UI without any other changes.
const PARTIAL_REVERSE_ENABLED = false;

const SalesReport = () => {
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [userFilter, setUserFilter] = useState('all');
  const [users, setUsers] = useState([]); // [{ created_by, full_name }]
  const [viewOrder, setViewOrder] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [reversingItemId, setReversingItemId] = useState(null);
  const [reverseModal, setReverseModal] = useState(null); // { item, qtyToReverse }
  const [businessName, setBusinessName] = useState('Sosna');
  const [businessPhone, setBusinessPhone] = useState('');
  const [activeTab, setActiveTab] = useState('transactions');
  const [itemSummary, setItemSummary] = useState([]);
  const [itemSummaryLoading, setItemSummaryLoading] = useState(false);
  const [breakdown, setBreakdown] = useState(null); // { productName, items }
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  // Category filter (applies mainly to "By Item" tab)
  const [allCats, setAllCats] = useState([]);
  const [allMains, setAllMains] = useState([]);
  const [selMainIds, setSelMainIds] = useState(null);
  const [selCatIds, setSelCatIds] = useState(null);
  const fetchOrders = useCallback(async () => {
    try {
      const res = await getOrders();
      setOrders(res.data || []);
    } catch (err) {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Format a Date as `YYYY-MM-DD HH:MM:SS` in UTC (matches SQLite's datetime('now') format).
  // ISO format (with `T`) lexicographically compares > space-separator, so we MUST use space.
  const toSqliteUTC = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };

  const fetchItemSummary = useCallback(async () => {
    setItemSummaryLoading(true);
    try {
      // Convert the local-date filter into a SQLite-format UTC datetime range
      // (YYYY-MM-DD HH:MM:SS) so the string comparison against orders.created_at works.
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const res = await getOrderProductSummary(fromUTC, toUTC, userFilter);
      setItemSummary(res.data || []);
    } catch (err) {
      setItemSummary([]);
    } finally {
      setItemSummaryLoading(false);
    }
  }, [dateFrom, dateTo, userFilter]);

  const handleProductBreakdown = async (productName) => {
    setBreakdownLoading(true);
    setBreakdown({ productName, items: [] });
    try {
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const res = await getProductBreakdown(productName, fromUTC, toUTC, userFilter);
      setBreakdown({ productName, items: res.data || [] });
    } catch (err) {
      setBreakdown({ productName, items: [] });
    } finally {
      setBreakdownLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
    getSettings().then(r => {
      const biz = r.data?.business || r.data || {};
      if (biz.business_name) setBusinessName(biz.business_name);
      if (biz.business_phone) setBusinessPhone(biz.business_phone);
    }).catch(() => {});
    getCategories().then(r => setAllCats(r.data || [])).catch(() => {});
    getMainCategories().then(r => setAllMains(r.data || [])).catch(() => {});
  }, [fetchOrders]);

  useEffect(() => {
    setUserFilter('all');
    getSalesCashiers(null, dateFrom, dateTo)
      .then(r => setUsers(r.data || []))
      .catch(() => setUsers([]));
  }, [dateFrom, dateTo]);

  useEffect(() => {
    if (activeTab === 'byItem') fetchItemSummary();
  }, [activeTab, fetchItemSummary]);

  const filtered = orders.filter(o => {
    const od = new Date(o.created_at + 'Z');
    const orderLocalDate = `${od.getFullYear()}-${String(od.getMonth()+1).padStart(2,'0')}-${String(od.getDate()).padStart(2,'0')}`;
    if (dateFrom && orderLocalDate < dateFrom) return false;
    if (dateTo && orderLocalDate > dateTo) return false;
    if (userFilter !== 'all' && String(o.created_by) !== String(userFilter)) return false;
    return true;
  });

  const activeOrders = filtered.filter(o => o.status !== 'Reversed');
  const totalRevenue = activeOrders.reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);
  const totalDiscount = activeOrders.reduce((sum, o) => sum + parseFloat(o.discount || 0), 0);
  const totalSubtotal = activeOrders.reduce((sum, o) => sum + parseFloat(o.subtotal || 0), 0);
  // Cash vs Credit split. Cash portion = the part of the sale paid at the till, capped at the
  // sale total — over-payments come back as change to the customer, so they're NOT revenue.
  // Credit portion = whatever wasn't paid at the till (becomes AR).
  const totalCashSales   = activeOrders.reduce((sum, o) => sum + Math.min(parseFloat(o.amount_received || 0), parseFloat(o.total_amount || 0)), 0);
  const totalCreditSales = activeOrders.reduce((sum, o) => sum + Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0)), 0);

  const handleView = async (orderId) => {
    setViewLoading(true);
    try {
      const res = await getOrder(orderId);
      setViewOrder(res.data);
    } catch (err) {
      alert('Failed to load order details.');
    } finally {
      setViewLoading(false);
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleReverse = (order) => {
    if (order.status === 'Reversed') return;
    setPendingDelete({
      subject: `Reverse order ${order.order_number} — voids sale, restores stock`,
      actionLabel: 'Confirm Reverse',
      perform: async () => {
        try {
          await reverseOrder(order.id);
          await fetchOrders();
          alert(`Order ${order.order_number} has been reversed successfully.`);
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to reverse order.');
        }
      },
    });
  };

  // Open the partial-reverse modal (lets user pick how much to reverse and in what unit)
  const handleReverseItem = (item) => {
    if (item.reversed) return;
    const alreadyReversed = parseFloat(item.reversed_quantity || 0);
    const remaining = parseFloat(item.quantity) - alreadyReversed;
    if (!(remaining > 0)) {
      alert('Nothing left to reverse on this line.');
      return;
    }
    // Default the reverse unit to whatever was sold (item.unit)
    setReverseModal({ item, qtyToReverse: String(remaining), unit: item.unit || item.product_base_unit || '' });
  };

  const confirmReverseItem = async () => {
    if (!reverseModal) return;
    const { item, qtyToReverse, unit } = reverseModal;
    const qty = parseFloat(qtyToReverse);
    if (!(qty > 0)) { alert('Enter a quantity greater than 0.'); return; }

    // Compute remaining in the chosen unit so we can validate client-side too
    const conv = parseFloat(item.conversion_factor || 1);
    const isLineAlt = !!(item.alt_unit && item.unit === item.alt_unit);
    const isReverseAlt = !!(item.alt_unit && unit === item.alt_unit);
    const alreadyReversed = parseFloat(item.reversed_quantity || 0);
    const remainingInLineUnit = parseFloat(item.quantity) - alreadyReversed;
    const remainingBase = isLineAlt ? remainingInLineUnit * conv : remainingInLineUnit;
    const remainingInReverseUnit = isReverseAlt ? remainingBase / conv : remainingBase;
    if (qty > remainingInReverseUnit + 0.0001) {
      alert(`Cannot reverse more than ${(parseFloat(remainingInReverseUnit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${unit}.`);
      return;
    }

    setReversingItemId(item.id);
    try {
      const res = await reverseOrderItem(viewOrder.id, item.id, qty, unit);
      setViewOrder(res.data);
      setReverseModal(null);
      await fetchOrders();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to reverse item.');
    } finally {
      setReversingItemId(null);
    }
  };

  const formatDate = (d) => new Date(d + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const printDirect = (html) => printHtml(html);

  const handlePrintReceipt = async (order) => {
    // First try silent print via the backend ESC/POS path (same as POS does).
    // Falls back to the browser dialog below if the backend has no printer
    // configured or returns an error (e.g. web tenants).
    try {
      const cashRcv = parseFloat(order.cash_received || 0);
      const momoRcv = parseFloat(order.momo_received || 0);
      const bankRcv = parseFloat(order.bank_received || 0);
      const splitSum = cashRcv + momoRcv + bankRcv;
      const paymentLabel = splitSum > 0
        ? [cashRcv > 0 && 'Cash', momoRcv > 0 && 'MoMo', bankRcv > 0 && 'Bank'].filter(Boolean).join(' + ')
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
        cashReceived: order.cash_received,
        momoReceived: order.momo_received,
        bankReceived: order.bank_received,
        change: order.change_amount,
      });
      return; // silent print succeeded
    } catch (_) { /* fall through to browser-print fallback */ }

    printDirect(buildReceiptHtml(order));
  };

  // Explicit "Download PDF" path — skips the backend ESC/POS attempt and
  // goes straight to PDF generation. Shown only when the user picked PDF
  // Download in System Settings AND is on a phone-sized screen.
  const handleDownloadPdfReceipt = (order) => {
    const html = buildReceiptHtml(order);
    downloadPdf(html);
  };

  // Build the 80mm thermal-receipt HTML used by both the print fallback
  // and the explicit Download PDF button. Single source of truth so the
  // two paths produce identical output.
  const buildReceiptHtml = (order) => {
    const div = '='.repeat(42);
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
      const marker = soldInNonDefault ? ' <span style="color:#dc2626;font-weight:700">**</span>' : '';
      const rowWeight = soldInNonDefault ? 'font-weight:700;' : '';
      const nameLabel = item.product_name + (item.reversed ? ' [VOID]' : '') + marker;
      const partialNote = partial ? `<tr><td colspan="4" style="font-size:9px;color:#b45309;padding-left:6px">was ${origQty} ${item.unit || ''} — reversed ${rq}</td></tr>` : '';
      return `
      <tr><td colspan="4" style="font-weight:700;padding-top:4px;${item.reversed ? 'text-decoration:line-through;color:#999;' : ''}">${nameLabel}</td></tr>
      <tr style="${rowWeight}${item.reversed ? 'color:#999;' : ''}">
        <td></td>
        <td style="text-align:center;${partial ? 'font-weight:700' : ''}">${netQty} ${item.unit || ''}</td>
        <td style="text-align:right">${(parseFloat(unitPx)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="text-align:right;${partial ? 'font-weight:700' : ''}">${(parseFloat(netTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      </tr>
      ${partialNote}`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      @page { size: 80mm auto; margin: 2mm 3mm; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { width: 74mm; font-family: 'Courier New', monospace; font-size: 11px; color: #000; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      td { padding: 1px 0; vertical-align: top; }
      .c { text-align: center; }
      .div { text-align: center; font-size: 10px; margin: 3px 0; overflow: hidden; white-space: nowrap; }
      .grand { font-size: 16px; font-weight: 800; }
      .amt { font-size: 13px; }
    </style></head><body>
    <div class="c" style="font-size:14px;letter-spacing:1px">${businessName}</div>
    <div class="div">${div}</div>
    <div class="c" style="font-size:12px">${order.status === 'Reversed' ? '*** REVERSED ***' : 'SALES RECEIPT'}</div>
    <div class="div">${div}</div>
    <table>
      <tr><td>Receipt #:</td><td></td><td style="text-align:right" colspan="2">${order.order_number}</td></tr>
      <tr><td>Date:</td><td></td><td style="text-align:right" colspan="2">${new Date(order.created_at + 'Z').toLocaleDateString('en-GB')}</td></tr>
      <tr><td>Time:</td><td></td><td style="text-align:right" colspan="2">${new Date(order.created_at + 'Z').toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true})}</td></tr>
      <tr><td>Customer:</td><td></td><td style="text-align:right" colspan="2">${order.customer_name || 'Walk-in'}</td></tr>
      <tr><td>Payment:</td><td></td><td style="text-align:right" colspan="2">${(() => {
        const c = parseFloat(order.cash_received || 0), m = parseFloat(order.momo_received || 0), b = parseFloat(order.bank_received || 0);
        const list = [c > 0 && 'Cash', m > 0 && 'MoMo', b > 0 && 'Bank'].filter(Boolean);
        return list.length > 0 ? list.join(' + ') : (order.payment_method || '');
      })()}</td></tr>
    </table>
    <div class="div">${div}</div>
    <table>
      <tr style="font-size:10px"><td style="width:42%">ITEM</td><td style="width:18%;text-align:center">QTY</td><td style="width:20%;text-align:right">PRICE</td><td style="width:20%;text-align:right">TOTAL</td></tr>
      ${itemRows}
    </table>
    <div class="div">${'-'.repeat(42)}</div>
    <table>
      <tr><td>Subtotal</td><td></td><td></td><td style="text-align:right">${(parseFloat(parseFloat(order.subtotal))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>
      ${parseFloat(order.discount) > 0 ? `<tr><td>Discount</td><td></td><td></td><td style="text-align:right">-${(parseFloat(parseFloat(order.discount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>` : ''}
    </table>
    <div class="div">${div}</div>
    <table>
      <tr class="grand"><td>TOTAL</td><td></td><td></td><td style="text-align:right">${(parseFloat(parseFloat(order.total_amount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>
    </table>
    <div class="div">${div}</div>
    <table>
      ${(() => {
        const c = parseFloat(order.cash_received || 0), m = parseFloat(order.momo_received || 0), b = parseFloat(order.bank_received || 0);
        const hasSplit = c + m + b > 0.001;
        if (!hasSplit) return `<tr class="amt"><td>Amt Received:</td><td></td><td></td><td style="text-align:right">${(parseFloat(parseFloat(order.amount_received || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>`;
        return `${c > 0 ? `<tr><td>Cash:</td><td></td><td></td><td style="text-align:right">${(parseFloat(c)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>` : ''}
                ${m > 0 ? `<tr><td>MoMo:</td><td></td><td></td><td style="text-align:right">${(parseFloat(m)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>` : ''}
                ${b > 0 ? `<tr><td>Bank:</td><td></td><td></td><td style="text-align:right">${(parseFloat(b)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>` : ''}
                <tr class="amt"><td>Total Received:</td><td></td><td></td><td style="text-align:right">${(parseFloat(parseFloat(order.amount_received || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>`;
      })()}
      <tr class="amt"><td>${parseFloat(order.change_amount || 0) >= 0 ? '*** CHANGE ***' : '*** BAL DUE ***'}</td><td></td><td></td><td style="text-align:right">${(parseFloat(Math.abs(parseFloat(order.change_amount || 0)))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>
    </table>
    <div class="div">${div}</div>
    <div class="c" style="margin-top:4px">Thank you for your purchase!</div>
    <div class="c">Please come again.</div>
    </body></html>`;

    return html;
  };

  const handlePrintReport = async () => {
    const dateLabel = dateFrom === dateTo
      ? new Date(dateFrom).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : `${new Date(dateFrom).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${new Date(dateTo).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    let products = [];
    try {
      const res = await getOrderProductSummary(dateFrom, dateTo);
      products = res.data || [];
    } catch (err) { /* skip */ }

    // Try silent print via backend (same as POS receipt)
    try {
      await printReport({
        businessName,
        dateLabel,
        totalOrders: activeOrders.length,
        filteredCount: filtered.length,
        totalRevenue,
        totalDiscount,
        products,
      });
      return;
    } catch (e) { /* fallback to browser print */ }

    const div = '='.repeat(42);
    const productRows = products.map(p =>
      `<tr>
        <td style="padding-bottom:3px;font-weight:700">${p.product_name}</td>
        <td style="text-align:right">${(parseFloat(parseFloat(p.total_qty))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="text-align:right">K${(parseFloat(parseFloat(p.avg_price))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="text-align:right;font-weight:700">K${(parseFloat(parseFloat(p.total_revenue))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      </tr>`
    ).join('');

    const grandTotal = products.reduce((s, p) => s + parseFloat(p.total_revenue), 0);

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>
      @page { size: 80mm auto; margin: 3mm; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: 'Courier New', monospace; font-size: 11px; width: 74mm; color: #000; font-weight: 700; }
      .c { text-align: center; }
      .div { text-align: center; font-size: 10px; margin: 3px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th { font-size: 9px; border-bottom: 1px solid #000; padding-bottom: 2px; }
      th:not(:first-child) { text-align: right; }
      td { padding: 1px 0; vertical-align: top; }
      .summary { margin: 4px 0; }
      .srow { display: flex; justify-content: space-between; margin-bottom: 2px; font-size: 11px; }
      .grand { font-size: 14px; font-weight: 800; border-top: 1px solid #000; padding-top: 3px; margin-top: 3px; display: flex; justify-content: space-between; }
      .footer { text-align: center; margin-top: 6px; font-size: 10px; }
    </style></head><body>
      <div class="c" style="font-size:14px;letter-spacing:1px">${businessName}</div>
      <div class="div">${div}</div>
      <div class="c" style="font-size:12px">SALES REPORT</div>
      <div class="c" style="font-size:11px">${dateLabel}</div>
      <div class="div">${div}</div>
      <div class="summary">
        <div class="srow"><span>Total Orders</span><span>${activeOrders.length} (${filtered.length} incl. void)</span></div>
        <div class="srow"><span>Total Revenue</span><span>K${(parseFloat(totalRevenue)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
        <div class="srow"><span>Total Discounts</span><span>K${(parseFloat(totalDiscount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      </div>
      <div class="div">${div}</div>
      <table>
        <thead><tr>
          <th style="text-align:left">PRODUCT</th>
          <th>QTY</th>
          <th>PRICE</th>
          <th>TOTAL</th>
        </tr></thead>
        <tbody>${productRows}</tbody>
      </table>
      <div class="div">${'-'.repeat(42)}</div>
      <div class="grand"><span>GRAND TOTAL</span><span>K${(parseFloat(grandTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      <div class="footer">Printed: ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
    </body></html>`;

    printDirect(html);
  };

  // ── Export the By-Item view as an A4 PDF (mirrors GRN/SIV design) ────────
  // Opens a print preview in a new tab — user clicks "Save as PDF" in the
  // browser dialog. Same look-and-feel as the GRN/SIV print pages so reports
  // across the system stay consistent.
  const handleExportPDF = async () => {
    const dateLabel = dateFrom === dateTo
      ? new Date(dateFrom).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : `${new Date(dateFrom).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — ${new Date(dateTo).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const items = (itemSummary || []).slice().sort((a, b) => parseFloat(b.total_revenue || 0) - parseFloat(a.total_revenue || 0));
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtQty = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';

    const rows = items.map((it, idx) => {
      const qInDisp = displayInDefaultUnit(it.total_qty, it);
      const avgInDisp = displayPriceInDefaultUnit(it.avg_price, it);
      return `<tr style="background:${idx % 2 === 1 ? '#f5f5f5' : '#fff'};border-bottom:1px solid #ddd">
        <td style="padding:7px 10px;color:#000;font-size:10.5px">${idx + 1}</td>
        <td style="padding:7px 10px;font-weight:600">${it.product_name || '—'}</td>
        <td style="padding:7px 10px;font-size:10.5px;color:#444">${it.category_name || '—'}</td>
        <td style="padding:7px 10px;font-size:10.5px">${avgInDisp.unit}</td>
        <td style="padding:7px 10px;text-align:right;font-family:monospace">${fmtQty(qInDisp.qty)} ${avgInDisp.unit}</td>
        <td style="padding:7px 10px;text-align:right;font-family:monospace">${curSym}${fmt(avgInDisp.price)} <span style="font-size:9px;color:#666">/ ${avgInDisp.unit}</span></td>
        <td style="padding:7px 10px;text-align:right;font-weight:700;font-family:monospace">${curSym}${fmt(it.total_revenue)}</td>
      </tr>`;
    }).join('');

    const grandRevenue = items.reduce((s, it) => s + parseFloat(it.total_revenue || 0), 0);

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales by Item — ${dateLabel}</title><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      td{font-size:11px}
      tfoot td{padding:10px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${businessName}</div>
          <div style="font-size:10px;color:#000;line-height:1.7">${businessPhone || ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:4px">Sales by Item</div>
          <div style="font-size:15px;font-weight:700">${dateLabel}</div>
          <div style="font-size:9px;color:#000;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[
          ['Total Revenue', `${curSym}${fmt(totalRevenue)}`],
          ['Cash Sales', `${curSym}${fmt(totalCashSales)}`],
          ['Credit Sales', `${curSym}${fmt(totalCreditSales)}`],
          ['Discounts', `${curSym}${fmt(totalDiscount)}`],
        ].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:14px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <table>
          <thead><tr>
            <th style="width:28px">#</th>
            <th>Product</th>
            <th>Category</th>
            <th>Unit</th>
            <th style="text-align:right">Total Qty Sold</th>
            <th style="text-align:right">Avg Unit Price</th>
            <th style="text-align:right">Total Revenue</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="padding:20px;text-align:center;color:#666">No sales in this period</td></tr>'}</tbody>
          <tfoot><tr>
            <td colspan="6">GRAND TOTAL — ${items.length} product${items.length !== 1 ? 's' : ''}</td>
            <td style="text-align:right;font-size:13px;font-family:monospace">${curSym}${fmt(grandRevenue)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px;color:#000">${businessName} — Confidential</span>
        <span style="font-size:9px;color:#000">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); }, 300); }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('salesReport')}</h1>
          <p>{t('salesReportSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleExportPDF}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiFileText size={15} /> Export PDF
          </button>
          <button
            onClick={handlePrintReport}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiPrinter size={15} /> {t('printReport')}
          </button>
        </div>
      </div>

      {/* Filters */}
      <style>{`
        .sr-date-box:focus-within {
          border-color: #2563eb !important;
          box-shadow: 0 0 0 3px rgba(37,99,235,0.12);
        }
        .sr-date-input::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.6; }
        .sr-clear-btn {
          display: inline-flex; align-items: center; gap: 7px;
          padding: 10px 20px;
          background: linear-gradient(135deg, #f87171, #dc2626);
          color: #fff; border: none; border-radius: 10px;
          cursor: pointer; font-size: 13px; font-weight: 700;
          box-shadow: 0 3px 10px rgba(220,38,38,0.25);
          transition: transform 0.15s, box-shadow 0.15s;
          white-space: nowrap; align-self: flex-end;
        }
        .sr-clear-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 16px rgba(220,38,38,0.4);
        }
        .sr-clear-btn:active { transform: scale(0.97); }
      `}</style>

      <div className="card" style={{ marginBottom: 24, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <FiCalendar style={{ color: '#2563eb', fontSize: 16 }} />
          <span style={{ fontWeight: 700, fontSize: 14, color: '#1e3a5f' }}>{t('filterByDate')}</span>
          {(dateFrom || dateTo) && (
            <span style={{
              marginLeft: 6, padding: '2px 10px', borderRadius: 20,
              background: '#eff6ff', color: '#2563eb',
              fontSize: 11, fontWeight: 600, border: '1px solid #bfdbfe'
            }}>
              {dateFrom === dateTo && dateFrom
                ? dateFrom === today ? t('today') : dateFrom
                : `${dateFrom || '...'} → ${dateTo || '...'}`}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {/* From Date */}
          <div style={{ flex: '0 0 auto' }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {t('from')}
            </label>
            <div className="sr-date-box" style={{
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1.5px solid #e5e7eb', borderRadius: 10,
              padding: '9px 14px', background: '#f8faff',
              transition: 'border-color 0.15s, box-shadow 0.15s'
            }}>
              <FiCalendar style={{ color: '#2563eb', flexShrink: 0 }} />
              <input
                type="date" value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="sr-date-input"
                style={{ border: 'none', outline: 'none', fontSize: 14, background: 'transparent', fontWeight: 500, color: '#1e293b', cursor: 'pointer' }}
              />
            </div>
          </div>

          {/* Arrow separator */}
          <div style={{ paddingBottom: 10, color: '#9ca3af', fontSize: 18, fontWeight: 300, flexShrink: 0 }}>→</div>

          {/* To Date */}
          <div style={{ flex: '0 0 auto' }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {t('to')}
            </label>
            <div className="sr-date-box" style={{
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1.5px solid #e5e7eb', borderRadius: 10,
              padding: '9px 14px', background: '#f8faff',
              transition: 'border-color 0.15s, box-shadow 0.15s'
            }}>
              <FiCalendar style={{ color: '#2563eb', flexShrink: 0 }} />
              <input
                type="date" value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="sr-date-input"
                style={{ border: 'none', outline: 'none', fontSize: 14, background: 'transparent', fontWeight: 500, color: '#1e293b', cursor: 'pointer' }}
              />
            </div>
          </div>

          {/* User Filter */}
          {users.length > 1 && (
            <div style={{ flex: '0 0 auto' }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t('cashier')}
              </label>
              <select
                value={userFilter}
                onChange={e => setUserFilter(e.target.value)}
                style={{ padding: '9px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: 14, background: '#f8faff', color: '#1e293b', fontWeight: 500 }}
              >
                <option value="all">{t('allCashiers')}</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Clear Filter button */}
          <button className="sr-clear-btn" onClick={() => { setDateFrom(today); setDateTo(today); setDeviceFilter('all'); }}>
            <FiX size={14} /> {t('resetToToday')}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 16,
        marginBottom: 24
      }}>
        {/* Total Revenue (accrual — all sales billed) */}
        <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(37,99,235,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiDollarSign size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('totalRevenue')}</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalRevenue)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{activeOrders.length} order(s){filtered.length > activeOrders.length ? ` · ${filtered.length - activeOrders.length} reversed` : ''}</div>
          </div>
        </div>

        {/* Cash Sales (amount actually received at time of sale) */}
        <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(22,163,74,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiDollarSign size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('cashSales')}</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalCashSales)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{t('collectedAtSale')}</div>
          </div>
        </div>

        {/* Credit Sales (unpaid portion that became receivable) */}
        <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(217,119,6,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiFileText size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('creditSales')}</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalCreditSales)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{t('chargedToAccount')}</div>
          </div>
        </div>

        {/* Total Discounts (kept as 4th — useful context) */}
        <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(220,38,38,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiDollarSign size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('totalDiscounts')}</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalDiscount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{t('givenToCustomers')}</div>
          </div>
        </div>

      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'transactions', label: t('transactions') },
          { key: 'byItem', label: t('byItem') },
          { key: 'byPayment', label: t('byPayment') },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 22px', border: 'none', background: 'none',
              cursor: 'pointer', fontSize: 14, fontWeight: 700,
              color: activeTab === tab.key ? '#2563eb' : '#6b7280',
              borderBottom: activeTab === tab.key ? '3px solid #2563eb' : '3px solid transparent',
              marginBottom: -2, transition: 'color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Transactions Tab */}
      {activeTab === 'transactions' && (
      <div className="card">
        <div className="card-header">
          <h3>Sales Transactions</h3>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{filtered.length} records ({activeOrders.length} active)</span>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>{t('loading')}</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No sales records found.</div>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('receiptNumber')}</th>
                  <th>{t('date')}</th>
                  <th>{t('subtotal')}</th>
                  <th>{t('discount')}</th>
                  <th>Total</th>
                  <th>Amount Received</th>
                  <th>Change</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(order => (
                  <tr key={order.id} style={{ opacity: order.status === 'Reversed' ? 0.6 : 1 }}>
                    <td><strong>{order.order_number}</strong></td>
                    <td>{formatDate(order.created_at)}</td>
                    <td>{curSym}{(parseFloat(parseFloat(order.subtotal))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ color: parseFloat(order.discount) > 0 ? '#dc2626' : '#374151' }}>
                      {parseFloat(order.discount) > 0 ? `-${curSym}${(parseFloat(parseFloat(order.discount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : `${curSym}0.00`}
                    </td>
                    <td><strong>{curSym}{(parseFloat(parseFloat(order.total_amount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></td>
                    <td>{curSym}{(parseFloat(parseFloat(order.amount_received || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ color: '#16a34a' }}>{curSym}{(parseFloat(parseFloat(order.change_amount || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td>
                      <span className={`badge ${order.status === 'Reversed' ? 'badge-danger' : order.status === 'Partial' ? 'badge-warning' : 'badge-success'}`}>
                        {order.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => handleView(order.id)}
                          title="View Details"
                          style={{ padding: '5px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                        >
                          <FiEye size={13} /> View
                        </button>
                        {hasPermission('SalesReport:Delete') && (
                          <button
                            onClick={() => handleReverse(order)}
                            disabled={order.status === 'Reversed'}
                            title="Reverse Order"
                            style={{ padding: '5px 10px', background: order.status === 'Reversed' ? '#e5e7eb' : '#dc2626', color: order.status === 'Reversed' ? '#9ca3af' : '#fff', border: 'none', borderRadius: 6, cursor: order.status === 'Reversed' ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                          >
                            <FiRotateCcw size={13} /> Reverse
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {/* By Item Tab */}
      {activeTab === 'byItem' && (() => {
        const activeCatIds = selCatIds === null ? null : new Set(selCatIds.map(String));
        const filteredItems = itemSummary.filter(it => {
          if (activeCatIds === null) return true;
          if (!it.category_id) return false;
          return activeCatIds.has(String(it.category_id));
        });
        // Subtotals by main category
        const subMap = new Map();
        for (const it of filteredItems) {
          const main = allMains.find(m => String(m.id) === String(it.main_category_id));
          const key = main ? main.id : '__unassigned__';
          const name = main ? main.name : 'Uncategorized';
          const color = main ? main.color : '#6b7280';
          if (!subMap.has(key)) subMap.set(key, { name, color, qty: 0, revenue: 0 });
          const e = subMap.get(key);
          e.qty += parseFloat(it.total_qty || 0);
          e.revenue += parseFloat(it.total_revenue || 0);
        }
        const subs = Array.from(subMap.values()).sort((a, b) => b.revenue - a.revenue);

        return (
          <div className="card">
            <CategoryFilter
              categories={allCats}
              mainCategories={allMains}
              selectedMainIds={selMainIds}
              selectedCatIds={selCatIds}
              onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
            />
            <div className="card-header">
              <h3>Sales by Item</h3>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{filteredItems.length} products</span>
            </div>
            {subs.length > 1 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 16px 16px' }}>
                {subs.map(s => (
                  <div key={s.name} style={{
                    padding: '6px 12px', borderRadius: 8,
                    background: (s.color || '#6b7280') + '15',
                    border: `1px solid ${(s.color || '#6b7280')}40`, fontSize: 12,
                  }}>
                    <span style={{ color: s.color, fontWeight: 700 }}>{s.name}:</span>
                    <span style={{ marginLeft: 6, color: '#374151', fontWeight: 600 }}>
                      qty {(parseFloat(s.qty)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} · ${(parseFloat(s.revenue)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {itemSummaryLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>{t('loading')}</div>
            ) : filteredItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No items sold for the selected categories.</div>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Product Name</th>
                      <th>Category</th>
                      <th>Unit</th>
                      <th>Total Qty Sold</th>
                      <th>Avg Unit Price</th>
                      <th>Total Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item, idx) => {
                      const disp = pickDisplayUnit(item);
                      const avgInDisp = displayPriceInDefaultUnit(item.avg_price, item);
                      return (
                      <tr key={idx} onClick={() => handleProductBreakdown(item.product_name)} style={{ cursor: 'pointer' }} title="Click to see individual sales">
                        <td style={{ color: '#9ca3af', fontSize: 12 }}>{idx + 1}</td>
                        <td><strong style={{ color: '#2563eb' }}>{item.product_name}</strong></td>
                        <td style={{ color: '#6b7280', fontSize: 12 }}>{item.category_name || '—'}</td>
                        <td style={{ color: '#6b7280' }}>
                          {disp.name || '—'}
                          {disp.conv > 1 && (
                            <div style={{ fontSize: 10, color: '#9ca3af' }}>1 {disp.name} = {disp.conv} {item.unit}</div>
                          )}
                        </td>
                        <td>{formatStockForProduct(item.total_qty, item)}</td>
                        <td>{curSym}{(parseFloat(avgInDisp.price)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} <span style={{ fontSize: 10, color: '#9ca3af' }}>/ {avgInDisp.unit}</span></td>
                        <td><strong style={{ color: '#16a34a' }}>{curSym}{(parseFloat(parseFloat(item.total_revenue))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f8faff', fontWeight: 700 }}>
                      <td colSpan={6} style={{ textAlign: 'right', paddingRight: 16, color: '#374151' }}>Grand Total</td>
                      <td style={{ color: '#16a34a' }}>K{(parseFloat(filteredItems.reduce((s, p) => s + parseFloat(p.total_revenue), 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* By Payment Method Tab */}
      {activeTab === 'byPayment' && (() => {
        // Cap each order's per-method amount so over-tendered cash (returned as change)
        // doesn't inflate revenue. When a customer pays K500 in cash for a K20 sale, only
        // K20 is revenue; the K480 went back as change. We scale the breakdown proportionally
        // so the per-method totals still equal the actual revenue per order.
        const adjustedRow = (o) => {
          const cash = parseFloat(o.cash_received || 0);
          const momo = parseFloat(o.momo_received || 0);
          const bank = parseFloat(o.bank_received || 0);
          const tendered = cash + momo + bank;
          const total = parseFloat(o.total_amount || 0);
          const revenue = Math.min(tendered, total);
          const factor = tendered > 0 ? revenue / tendered : 0;
          return {
            cash:   cash * factor,
            momo:   momo * factor,
            bank:   bank * factor,
            credit: Math.max(0, total - tendered),
          };
        };
        const totals = activeOrders.reduce((acc, o) => {
          const r = adjustedRow(o);
          return { cash: acc.cash + r.cash, momo: acc.momo + r.momo, bank: acc.bank + r.bank, credit: acc.credit + r.credit };
        }, { cash: 0, momo: 0, bank: 0, credit: 0 });
        const grand = totals.cash + totals.momo + totals.bank + totals.credit;
        const pct = (n) => grand > 0 ? ((n / grand) * 100).toFixed(1) : '0.0';

        return (
          <div className="card">
            <div className="card-header">
              <h3>Sales by Payment Method</h3>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{activeOrders.length} order(s) · ${(parseFloat(grand)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, padding: '16px 20px' }}>
              {[
                { label: 'Cash',         value: totals.cash,   color: '#16a34a' },
                { label: 'Mobile Money', value: totals.momo,   color: '#f59e0b' },
                { label: 'Bank',         value: totals.bank,   color: '#2563eb' },
                { label: 'Credit',       value: totals.credit, color: '#dc2626' },
              ].map(b => (
                <div key={b.label} style={{ padding: '14px 16px', borderRadius: 12, background: b.color + '15', border: `1.5px solid ${b.color}40` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: b.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{b.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: b.color, marginTop: 4 }}>{curSym}{(parseFloat(b.value)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{pct(b.value)}% of revenue</div>
                </div>
              ))}
            </div>

            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, margin: '0 0 16px' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Date', 'Receipt #', 'Customer', 'Total', 'Cash', 'MoMo', 'Bank', 'Credit'].map((h, i) => (
                    <th key={i} style={{ padding: '10px 12px', textAlign: i < 3 ? 'left' : 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeOrders.length === 0 ? (
                  <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No sales for the selected period.</td></tr>
                ) : activeOrders.map(o => {
                  const r = adjustedRow(o);
                  return (
                    <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 12px' }}>{new Date(o.created_at + 'Z').toLocaleDateString('en-GB')}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 12 }}>{o.order_number}</td>
                      <td style={{ padding: '8px 12px' }}>{o.customer_name || 'Walk-in'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{curSym}{(parseFloat(parseFloat(o.total_amount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: r.cash > 0 ? '#16a34a' : '#9ca3af' }}>{r.cash > 0 ? `${curSym}${(parseFloat(r.cash)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: r.momo > 0 ? '#f59e0b' : '#9ca3af' }}>{r.momo > 0 ? `${curSym}${(parseFloat(r.momo)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: r.bank > 0 ? '#2563eb' : '#9ca3af' }}>{r.bank > 0 ? `${curSym}${(parseFloat(r.bank)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: r.credit > 0 ? '#dc2626' : '#9ca3af', fontWeight: r.credit > 0 ? 700 : 400 }}>{r.credit > 0 ? `${curSym}${(parseFloat(r.credit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              {activeOrders.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                    <td colSpan={3} style={{ padding: '11px 12px' }}>TOTAL</td>
                    <td style={{ padding: '11px 12px', textAlign: 'right' }}>{curSym}{(parseFloat(grand)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', color: '#16a34a' }}>{curSym}{(parseFloat(totals.cash)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', color: '#f59e0b' }}>{curSym}{(parseFloat(totals.momo)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', color: '#2563eb' }}>{curSym}{(parseFloat(totals.bank)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', color: '#dc2626' }}>{curSym}{(parseFloat(totals.credit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        );
      })()}

      {/* View Order Receipt Modal */}
      <style>{`
        @media print {
          .sr-no-print { display: none !important; }
          .sr-receipt-print { display: block !important; }
          body * { visibility: hidden; }
          #sr-receipt-content, #sr-receipt-content * { visibility: visible; }
          #sr-receipt-content { position: fixed; top: 0; left: 0; width: 100%; }
        }
        .sr-btn-close {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 20px; border: 1.5px solid #e5e7eb;
          border-radius: 10px; background: #fff; cursor: pointer;
          font-size: 13px; font-weight: 600; color: #374151;
          transition: background 0.15s, border-color 0.15s;
        }
        .sr-btn-close:hover { background: #f9fafb; border-color: #d1d5db; }
        .sr-btn-print {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 20px; border: none; border-radius: 10px;
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          color: #fff; cursor: pointer; font-size: 13px; font-weight: 700;
          box-shadow: 0 3px 10px rgba(37,99,235,0.3);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .sr-btn-print:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(37,99,235,0.4); }
        .sr-btn-reverse {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 20px; border: none; border-radius: 10px;
          background: linear-gradient(135deg, #f87171, #dc2626);
          color: #fff; cursor: pointer; font-size: 13px; font-weight: 700;
          box-shadow: 0 3px 10px rgba(220,38,38,0.3);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .sr-btn-reverse:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(220,38,38,0.4); }
      `}</style>

      {(viewOrder || viewLoading) && (
        <div className="sr-no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: 420, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column' }}>
            {viewLoading ? (
              <div style={{ padding: 48, textAlign: 'center', color: '#6b7280' }}>Loading receipt...</div>
            ) : viewOrder && (
              <>
                {/* Receipt content */}
                <div id="sr-receipt-content" style={{ padding: '32px 28px', fontFamily: 'monospace', flex: 1 }}>

                  {/* Header */}
                  <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, fontFamily: 'sans-serif' }}>{businessName}</h2>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>Official Receipt</p>
                    {viewOrder.status === 'Reversed' && (
                      <div style={{ marginTop: 8, padding: '3px 12px', background: '#fee2e2', color: '#dc2626', borderRadius: 20, display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em' }}>
                        ✕ REVERSED
                      </div>
                    )}
                    {viewOrder.status === 'Partial' && (
                      <div style={{ marginTop: 8, padding: '3px 12px', background: '#fff7ed', color: '#d97706', borderRadius: 20, display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em' }}>
                        ~ PARTIAL REVERSAL
                      </div>
                    )}
                  </div>

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0' }} />

                  {/* Order Info */}
                  <div style={{ fontSize: 12, marginBottom: 12 }}>
                    {[
                      ['Receipt #', viewOrder.order_number],
                      ['Date',      new Date(viewOrder.created_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })],
                      ['Time',      new Date(viewOrder.created_at + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })],
                      ['Customer',  viewOrder.customer_name || 'Walk-in'],
                      ['Cashier',   viewOrder.created_by_name || (viewOrder.created_by ? (users.find(u => String(u.created_by) === String(viewOrder.created_by))?.full_name || `User #${viewOrder.created_by}`) : '—')],
                      ['Payment',   (() => {
                        const c = parseFloat(viewOrder.cash_received || 0);
                        const m = parseFloat(viewOrder.momo_received || 0);
                        const b = parseFloat(viewOrder.bank_received || 0);
                        const methods = [c > 0 && 'Cash', m > 0 && 'MoMo', b > 0 && 'Bank'].filter(Boolean);
                        return methods.length > 0 ? methods.join(' + ') : (viewOrder.payment_method || 'Cash');
                      })()],
                    ].map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: '#6b7280' }}>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0' }} />

                  {/* Items */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>
                      <span style={{ flex: 2 }}>ITEM</span>
                      <span style={{ textAlign: 'center', flex: 1 }}>QTY</span>
                      <span style={{ textAlign: 'right', flex: 1 }}>PRICE</span>
                      <span style={{ textAlign: 'right', flex: 1 }}>TOTAL</span>
                      <span className="sr-no-print" style={{ width: 28 }} />
                    </div>
                    {(viewOrder.items || []).map((item, idx) => {
                      // Show the NET line after any partial reversal:
                      //   netQty   = original quantity − reversed_quantity
                      //   netTotal = unit_price × netQty
                      // Fully-reversed lines (item.reversed = 1) keep the strike-through look.
                      const origQty = parseFloat(item.quantity || 0);
                      const rq      = parseFloat(item.reversed_quantity || 0);
                      const partial = !item.reversed && rq > 0;
                      const netQty  = partial ? Math.max(0, origQty - rq) : origQty;
                      const unitPx  = parseFloat(item.unit_price || 0);
                      // TOTAL column shows the PRE-line-discount value so the math
                      // (unit price × qty) is honest. The line discount, if any,
                      // is rendered as a separate sub-row immediately below.
                      const netTotal = unitPx * netQty;
                      const lineDisc = parseFloat(item.discount || 0);
                      const lineDiscTotal = lineDisc * netQty;
                      // Flag sales in a unit other than the product's default sell unit.
                      // Skip products that only have one unit configured (nothing to compare).
                      const dispUnit = pickDisplayUnit(item);
                      const hasMultiUnits = (() => {
                        try {
                          const arr = item.units_json ? JSON.parse(item.units_json) : null;
                          if (Array.isArray(arr) && arr.length > 1) return true;
                        } catch { /* ignore */ }
                        return !!(item.alt_unit && item.alt_unit !== item.product_base_unit);
                      })();
                      const soldInNonDefault = hasMultiUnits && item.unit && dispUnit.name && item.unit !== dispUnit.name;
                      return (
                      <React.Fragment key={idx}>
                      <div style={{
                        display: 'flex', fontSize: 12, marginBottom: 5,
                        alignItems: 'center',
                        fontWeight: soldInNonDefault ? 700 : 'normal',
                        opacity: item.reversed ? 0.5 : 1
                      }}>
                        <span style={{ flex: 2, textDecoration: item.reversed ? 'line-through' : 'none' }}>
                          {item.product_name}
                          {/* ** flag when the line was sold in a non-default unit
                              (e.g. default is Box but cashier rang it up in pcs). */}
                          {soldInNonDefault && (
                            <span style={{ marginLeft: 4, color: '#dc2626', fontWeight: 700 }} title={`Sold in ${item.unit} — default is ${dispUnit.name}`}>**</span>
                          )}
                          {/* item.reversed is a SQLite int (0/1). Use !! so React
                              doesn't render literal "0" when not reversed. */}
                          {!!item.reversed && (
                            <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: '#dc2626', background: '#fee2e2', borderRadius: 4, padding: '1px 4px', verticalAlign: 'middle' }}>
                              VOID
                            </span>
                          )}
                          {partial && (
                            <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '1px 4px', verticalAlign: 'middle' }}>
                              was {origQty} {item.unit || ''} — reversed {rq}
                            </span>
                          )}
                        </span>
                        <span style={{ textAlign: 'center', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none', fontWeight: partial ? 700 : 400 }}>
                          {netQty}{item.unit ? ` ${item.unit}` : ''}
                        </span>
                        <span style={{ textAlign: 'right', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none' }}>${(parseFloat(unitPx)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        <span style={{ textAlign: 'right', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none', fontWeight: partial ? 700 : 400 }}>${(parseFloat(netTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        {/* Per-item void button — hidden on print, and gated on PARTIAL_REVERSE_ENABLED. */}
                        <span className="sr-no-print" style={{ width: 28, display: 'flex', justifyContent: 'flex-end' }}>
                          {PARTIAL_REVERSE_ENABLED && !item.reversed && viewOrder.status !== 'Reversed' && (
                            <button
                              title="Void this item"
                              disabled={reversingItemId === item.id}
                              onClick={() => handleReverseItem(item)}
                              style={{
                                width: 22, height: 22, padding: 0, border: 'none',
                                borderRadius: 5, cursor: 'pointer',
                                background: reversingItemId === item.id ? '#e5e7eb' : 'linear-gradient(135deg,#f87171,#dc2626)',
                                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                flexShrink: 0
                              }}
                            >
                              <FiRotateCcw size={11} />
                            </button>
                          )}
                        </span>
                      </div>
                      {/* Per-line discount sub-row — shown only when this line had a
                          discount applied. Same format as the thermal print. */}
                      {lineDisc > 0 && (
                        <div key={`${idx}-disc`} style={{
                          display: 'flex', fontSize: 11, color: '#6b7280',
                          marginTop: -2, marginBottom: 6,
                          opacity: item.reversed ? 0.5 : 1,
                        }}>
                          <span style={{ flex: 2, paddingLeft: 16 }}>
                            discount {netQty}{item.unit ? ` ${item.unit}` : ''} × -${(parseFloat(lineDisc)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </span>
                          <span style={{ flex: 1 }} />
                          <span style={{ flex: 1 }} />
                          <span style={{ flex: 1, textAlign: 'right' }}>
                            -${(parseFloat(lineDiscTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </span>
                          <span className="sr-no-print" style={{ width: 28 }} />
                        </div>
                      )}
                      </React.Fragment>
                      );
                    })}
                  </div>

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0' }} />

                  {/* Totals — ORIGINAL transaction values + Partial Refunds section if any */}
                  {(() => {
                    const items = viewOrder.items || [];
                    // Pre-discount subtotal = sum of (unit_price × original quantity).
                    // Using `quantity` (not netQty) so the totals reflect the ORIGINAL
                    // transaction; partial reverses are shown below as Refunds.
                    const originalSubtotal = items.reduce((s, it) =>
                      s + parseFloat(it.unit_price || 0) * parseFloat(it.quantity || 0), 0);
                    const lineDiscountSum = items.reduce((s, it) =>
                      s + parseFloat(it.discount || 0) * parseFloat(it.quantity || 0), 0);
                    const cartDiscount = parseFloat(viewOrder.discount || 0);
                    const originalDiscount = lineDiscountSum + cartDiscount;
                    const originalTotal = originalSubtotal - originalDiscount;
                    // Refunds: per-line refund = (reversed_quantity / quantity) × total_price
                    const refundLines = items
                      .map(it => {
                        const rq = parseFloat(it.reversed_quantity || 0);
                        const q  = parseFloat(it.quantity || 0);
                        const lineTotal = parseFloat(it.total_price || 0);
                        if (!(rq > 0) || !(q > 0)) return null;
                        return { item: it, qty: rq, amount: (rq / q) * lineTotal };
                      })
                      .filter(Boolean);
                    const totalRefund = refundLines.reduce((s, r) => s + r.amount, 0);
                    const netTotal = originalTotal - totalRefund;
                    const amountReceived = parseFloat(viewOrder.amount_received || 0);
                    const originalChange = parseFloat(viewOrder.change_amount || 0);

                    return (
                      <div style={{ fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: '#6b7280' }}>Subtotal</span>
                          <span>${(parseFloat(originalSubtotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>
                        {originalDiscount > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: '#dc2626' }}>Total discount</span>
                            <span style={{ color: '#dc2626' }}>-${(parseFloat(originalDiscount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingTop: 6, borderTop: '1px solid #e5e7eb', fontWeight: 700, fontSize: 14 }}>
                          <span>TOTAL</span>
                          <span>${(parseFloat(originalTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>
                        {/* Split breakdown: show each method line that has a value */}
                        {(() => {
                          const cashIn = parseFloat(viewOrder.cash_received || 0);
                          const momoIn = parseFloat(viewOrder.momo_received || 0);
                          const bankIn = parseFloat(viewOrder.bank_received || 0);
                          const hasSplit = cashIn + momoIn + bankIn > 0.001;
                          if (!hasSplit) {
                            return (
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                <span style={{ color: '#6b7280' }}>Amount Received</span>
                                <span>${(parseFloat(amountReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            );
                          }
                          return (
                            <>
                              {cashIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Cash</span>
                                  <span>${(parseFloat(cashIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              {momoIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Mobile Money</span>
                                  <span>${(parseFloat(momoIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              {bankIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Bank</span>
                                  <span>${(parseFloat(bankIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontWeight: 700, borderTop: '1px dotted #e5e7eb', paddingTop: 3 }}>
                                <span>Total Received</span>
                                <span>${(parseFloat(amountReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            </>
                          );
                        })()}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, color: '#16a34a' }}>
                          <span>Change at Till</span>
                          <span>${(parseFloat(originalChange)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>

                        {/* Partial Refunds section — only shown if any reversal occurred */}
                        {refundLines.length > 0 && (
                          <>
                            <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0 8px' }} />
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                              Partial Refunds
                            </div>
                            {refundLines.map((r, idx) => (
                              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 11.5 }}>
                                <span style={{ color: '#374151' }}>
                                  {r.item.product_name} −{(parseFloat(Number(r.qty))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {r.item.unit || ''}
                                </span>
                                <span style={{ color: '#b45309' }}>−${(parseFloat(r.amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            ))}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, paddingTop: 6, borderTop: '1px solid #fde68a', fontWeight: 700, color: '#b45309' }}>
                              <span>Refund Owed</span>
                              <span>${(parseFloat(totalRefund)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '2px solid #111827', fontWeight: 800, fontSize: 14 }}>
                              <span>NET TOTAL</span>
                              <span>${(parseFloat(netTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '16px 0 12px' }} />

                  <div style={{ textAlign: 'center', fontSize: 11, color: '#6b7280' }}>
                    <p style={{ margin: 0 }}>Thank you for your purchase!</p>
                    <p style={{ margin: '2px 0 0' }}>Please come again.</p>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="sr-no-print" style={{
                  display: 'flex', gap: 8, padding: '14px 24px 20px',
                  borderTop: '1px solid #f3f4f6', justifyContent: 'flex-end',
                  flexWrap: 'wrap'
                }}>
                  <button className="sr-btn-close" onClick={() => setViewOrder(null)}>
                    <FiX size={14} /> Close
                  </button>
                  <button className="sr-btn-print" onClick={() => handlePrintReceipt(viewOrder)}>
                    <FiPrinter size={14} /> Print Receipt
                  </button>
                  {/* Explicit PDF button — visible only on phones AND only
                      when Mobile Print Mode is set to PDF Download.
                      Bypasses the backend ESC/POS chain entirely so the
                      flow is debuggable and predictable. */}
                  {shouldShowMobilePdfButton() && (
                    <button
                      className="sr-btn-print"
                      onClick={() => handleDownloadPdfReceipt(viewOrder)}
                      style={{ background: 'linear-gradient(135deg,#16a34a,#15803d)' }}
                    >
                      <FiDownload size={14} /> Download PDF
                    </button>
                  )}
                  {viewOrder.status !== 'Reversed' && hasPermission('SalesReport:Delete') && (
                    <button className="sr-btn-reverse" onClick={() => { setViewOrder(null); handleReverse(viewOrder); }}>
                      <FiRotateCcw size={14} /> Reverse Order
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Partial Reverse Modal */}
      {reverseModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 420, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Reverse line item</h3>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>{reverseModal.item.product_name}</p>
            </div>
            <div style={{ padding: '20px 24px' }}>
              {(() => {
                const it = reverseModal.item;
                const orig = parseFloat(it.quantity);
                const already = parseFloat(it.reversed_quantity || 0);
                const remainingInLineUnit = orig - already;
                const conv = parseFloat(it.conversion_factor || 1);
                const isLineAlt = !!(it.alt_unit && it.unit === it.alt_unit);
                const baseUnit = it.product_base_unit || (isLineAlt ? '' : it.unit);
                const remainingBase = isLineAlt ? remainingInLineUnit * conv : remainingInLineUnit;
                const isReverseAlt = !!(it.alt_unit && reverseModal.unit === it.alt_unit);
                const remainingInReverseUnit = isReverseAlt ? remainingBase / conv : remainingBase;

                return (
                  <>
                    <div style={{ fontSize: 13, color: '#374151', marginBottom: 12, lineHeight: 1.7, background: '#f9fafb', borderRadius: 8, padding: '10px 12px' }}>
                      <div>Original sold: <strong>{orig} {it.unit || ''}</strong>
                        {it.alt_unit && !isLineAlt && (<span style={{ color: '#9ca3af' }}> </span>)}
                      </div>
                      {already > 0 && <div>Already reversed: <strong style={{ color: '#dc2626' }}>{already} {it.unit || ''}</strong></div>}
                      <div>Remaining: <strong style={{ color: '#16a34a' }}>{remainingInLineUnit} {it.unit || ''}</strong>
                        {it.alt_unit && (
                          <span style={{ color: '#6b7280', fontSize: 12 }}> ({remainingBase} {baseUnit})</span>
                        )}
                      </div>
                    </div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>How much to reverse?</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="number"
                        autoFocus
                        min="0.01"
                        step="0.01"
                        max={remainingInReverseUnit}
                        value={reverseModal.qtyToReverse}
                        onChange={e => setReverseModal({ ...reverseModal, qtyToReverse: e.target.value })}
                        style={{ flex: 1, padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 16, outline: 'none', boxSizing: 'border-box' }}
                      />
                      {it.alt_unit ? (
                        <select
                          value={reverseModal.unit}
                          onChange={e => setReverseModal({ ...reverseModal, unit: e.target.value })}
                          style={{ padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', minWidth: 130 }}
                        >
                          <option value={it.product_base_unit || baseUnit}>{it.product_base_unit || baseUnit}</option>
                          <option value={it.alt_unit}>{it.alt_unit} (1={conv})</option>
                        </select>
                      ) : (
                        <div style={{ padding: '10px 14px', color: '#6b7280', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#f9fafb', minWidth: 90, textAlign: 'center' }}>{it.unit || ''}</div>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
                      Pre-filled to full remaining. You can change qty or switch unit (e.g. customer returns 2 pcs when they bought boxes).
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                      Max in {reverseModal.unit}: <strong>{(parseFloat(remainingInReverseUnit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
                    </div>
                  </>
                );
              })()}
            </div>
            <div style={{ padding: '14px 24px 20px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #f3f4f6' }}>
              <button onClick={() => setReverseModal(null)} className="sr-btn-close">Cancel</button>
              <button onClick={confirmReverseItem} className="sr-btn-reverse" disabled={reversingItemId === reverseModal.item.id}>
                <FiRotateCcw size={14} /> {reversingItemId === reverseModal.item.id ? 'Reversing…' : 'Reverse'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product Breakdown Modal */}
      {breakdown && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>{breakdown.productName}</h3>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>
                  Individual sales · {dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`}
                </p>
              </div>
              <button onClick={() => setBreakdown(null)} style={{ padding: '6px 14px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#374151' }}>Close</button>
            </div>
            {/* Body */}
            <div style={{ padding: '16px 24px' }}>
              {breakdownLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>{t('loading')}</div>
              ) : breakdown.items.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No sales found for this period.</div>
              ) : (
                <>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8faff' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>#</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Date & Time</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Order #</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Qty</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Unit Price</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.items.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 12px', color: '#9ca3af' }}>{i + 1}</td>
                          <td style={{ padding: '8px 12px', color: '#374151' }}>{new Date(row.created_at + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                          <td style={{ padding: '8px 12px', fontWeight: 600, color: '#2563eb' }}>{row.order_number}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right' }}>{(parseFloat(parseFloat(row.quantity))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right' }}>{curSym}{(parseFloat(parseFloat(row.unit_price))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#16a34a' }}>{curSym}{(parseFloat(parseFloat(row.total_price))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#f8faff', fontWeight: 700 }}>
                        <td colSpan={3} style={{ padding: '10px 12px', textAlign: 'right', color: '#374151' }}>Total</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{(parseFloat(breakdown.items.reduce((s, r) => s + parseFloat(r.quantity), 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        <td></td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>${(parseFloat(breakdown.items.reduce((s, r) => s + parseFloat(r.total_price), 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default SalesReport;
