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
// v1.8.12 — flipped to true for Sosna. Per-line reverse now refunds cash
// proportionally across USD/FRA/K (mirroring how the customer paid), so the
// Cash Report's per-currency buckets stay in sync after a partial reverse.
const PARTIAL_REVERSE_ENABLED = true;

const SalesReport = () => {
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym, currencyMode, isLiquorStyle } = useCurrency();
  // v1.9.26 — gate the USD/FRA/K rows + columns on the branch's
  // currency_mode. Mansa/Lusaka run K-only and should see one column.
  const showUSD = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const showFRA = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const showK   = currencyMode === 'USD+FRA+K' || currencyMode === 'K';
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
  const [businessAddress, setBusinessAddress] = useState(''); // v1.10.63 — needed so reprints show address like the till receipt does.
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
      if (biz.business_address) setBusinessAddress(biz.business_address);
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
  // v1.8.76 — only count actual credit sales (payment_method Credit / Partial-Credit).
  // Walk-in shortages within tolerance have total > received but are 'Cash' — those
  // are silent shop losses, NOT customer debt, so they shouldn't inflate Credit Sales.
  const totalCreditSales = activeOrders.reduce((sum, o) => {
    if (o.payment_method !== 'Credit' && o.payment_method !== 'Partial-Credit') return sum;
    return sum + Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0));
  }, 0);

  // v1.8.1 — triple-currency breakdown for Cash Sales card + By Payment tab.
  // Each in its own currency: USD net of USD change, FRA net of FRA change,
  // K net of K change. Sosna is cash-only across 3 currencies (no card / MoMo
  // / bank); these three buckets sum to the cash drawer in each currency.
  // v1.8.68 — switched USD subtraction from change_amount (USD-equivalent of
  // ALL change owed) to usd_change_given (physical USD returned only). Fixes
  // the phantom negative-USD when customer overpaid in FRA.
  const totalUsdReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.cash_received || 0) - parseFloat(o.usd_change_given ?? o.change_amount ?? 0), 0);
  const totalFraReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.fra_received || 0) - parseFloat(o.fra_change_given || 0), 0);
  const totalKReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.k_received || 0) - parseFloat(o.k_change_given || 0), 0);

  // v1.9.27 — method-axis totals for Liquor-style branches (Mansa/Lusaka).
  // v1.9.29 — corrected field names. POS writes the walk-in modal's per-
  // method amounts into cash_received / momo_received / bank_received
  // (not cash / momo / bank). On Sosna branches these same columns hold
  // the USD/FRA-equivalent breakdown, but isLiquorStyle gates the reads
  // so they only matter on K-only multi-method branches.
  // v1.10.101 — subtract change_amount from Cash total on Liquor so the
  // per-method Cash card matches the ≈ total footer (both settle to the
  // capped-at-total_amount value). Change on Liquor always comes out of
  // Cash drawer, never from MoMo/Bank. These variables are only rendered
  // on isLiquorStyle branches (line 878), so Kassumbalesa is untouched.
  const totalCashReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.cash_received || 0) - parseFloat(o.change_amount || 0), 0);
  const totalMomoReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.momo_received || 0), 0);
  const totalBankReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.bank_received || 0), 0);
  const totalCreditByMethod = activeOrders.reduce((s, o) =>
    s + Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0)), 0);

  // v1.8.68 — over-collections kept by cashier, summed per source currency.
  const totalOverpaidUSD = activeOrders.reduce((s, o) =>
    s + (o.overpaid_kept_ccy === 'USD' ? parseFloat(o.overpaid_kept_amt || 0) : 0), 0);
  const totalOverpaidFRA = activeOrders.reduce((s, o) =>
    s + (o.overpaid_kept_ccy === 'FRA' ? parseFloat(o.overpaid_kept_amt || 0) : 0), 0);
  const totalOverpaidK = activeOrders.reduce((s, o) =>
    s + (o.overpaid_kept_ccy === 'K' ? parseFloat(o.overpaid_kept_amt || 0) : 0), 0);
  const totalOverpaidAsUSD = activeOrders.reduce((s, o) => {
    const amt = parseFloat(o.overpaid_kept_amt || 0);
    if (amt <= 0) return s;
    if (o.overpaid_kept_ccy === 'USD') return s + amt;
    if (o.overpaid_kept_ccy === 'FRA' && parseFloat(o.selling_rate_used   || 0) > 0) return s + amt / parseFloat(o.selling_rate_used);
    if (o.overpaid_kept_ccy === 'K'   && parseFloat(o.selling_rate_k_used || 0) > 0) return s + amt / parseFloat(o.selling_rate_k_used);
    return s;
  }, 0);

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

    // Fetch the per-item breakdown on demand so the PDF works from any tab,
    // not just after the user has visited By Item. Fallback to cached state
    // if the network call fails.
    let items = [];
    try {
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const res = await getOrderProductSummary(fromUTC, toUTC, userFilter);
      items = res.data || [];
    } catch (e) {
      items = itemSummary || [];
    }
    items = items.slice().sort((a, b) => parseFloat(b.total_revenue || 0) - parseFloat(a.total_revenue || 0));
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
            {/* v1.10.101 — over-collected label hidden on Liquor. The
                concept only applies where the cashier can *choose* to keep
                surplus in a specific currency drawer (Kassumbalesa tri-
                currency). On Liquor branches change always goes back to
                the customer physically; there's no "kept" amount. Historical
                pre-v1.10.81 orders may still carry classifier values in
                overpaid_kept_amt but they no longer represent till reality. */}
            {!isLiquorStyle && totalOverpaidAsUSD > 0.005 && (
              <div style={{ fontSize: 11, opacity: 0.9, marginTop: 3, color: '#fef3c7' }}>
                + Over-collected ≈ {curSym}{totalOverpaidAsUSD.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                {' '}
                <span style={{ opacity: 0.8 }}>
                  ({totalOverpaidUSD > 0 ? `USD ${totalOverpaidUSD.toFixed(2)}` : ''}
                  {totalOverpaidFRA > 0 ? `${totalOverpaidUSD > 0 ? ' · ' : ''}FRA ${totalOverpaidFRA.toFixed(0)}` : ''}
                  {totalOverpaidK   > 0 ? `${(totalOverpaidUSD > 0 || totalOverpaidFRA > 0) ? ' · ' : ''}K ${totalOverpaidK.toFixed(0)}` : ''})
                </span>
              </div>
            )}
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{activeOrders.length} order(s){filtered.length > activeOrders.length ? ` · ${filtered.length - activeOrders.length} reversed` : ''}</div>
          </div>
        </div>

        {/* Cash Sales — v1.8.1 triple currency. Each row is net cash received
            in that currency (paid − change given), in the currency's own
            units. Sosna is cash-only; no card / MoMo / bank to break out. */}
        <div style={{
          borderRadius: 14, padding: '16px 18px',
          background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(22,163,74,0.3)',
          position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{t('cashSales')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* v1.9.27 — Liquor branches break Cash Sales by method
                (Cash / MoMo / Bank); Sosna multi-currency branches break
                by currency (USD/FRA/K). The bottom ≈ total line stays. */}
            {isLiquorStyle ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>Cash</span>
                  <span style={{ fontSize: 17, fontWeight: 800 }}>{curSym}{(parseFloat(totalCashReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>MoMo</span>
                  <span style={{ fontSize: 17, fontWeight: 800 }}>{curSym}{(parseFloat(totalMomoReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>Bank</span>
                  <span style={{ fontSize: 17, fontWeight: 800 }}>{curSym}{(parseFloat(totalBankReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                </div>
              </>
            ) : (
              <>
                {showUSD && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>USD</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>${(parseFloat(totalUsdReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                  </div>
                )}
                {showFRA && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>FRA</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{(parseFloat(totalFraReceived)||0).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
                  </div>
                )}
                {showK && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>K</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{(parseFloat(totalKReceived)||0).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
                  </div>
                )}
              </>
            )}
          </div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 4 }}>
            ≈ {curSym}{(parseFloat(totalCashSales)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} total
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

      {/* By Payment / Currency Tab — v1.8.1 */}
      {activeTab === 'byPayment' && isLiquorStyle && (() => {
        // v1.9.27 — Liquor-style branches: simple Cash / MoMo / Bank /
        // Credit breakdown. No currency split, no Given/Net/± because the
        // single-screen Pay modal collects whole amounts in each method.
        const fmtK = (n) => `${curSym}${(parseFloat(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
        const totalRevenue = activeOrders.reduce((s, o) => s + (parseFloat(o.total_amount)||0), 0);
        const pct = (n) => totalRevenue > 0 ? `${((n / totalRevenue) * 100).toFixed(1)}% of revenue` : '0% of revenue';
        return (
          <div className="card">
            <div className="card-header">
              <h3>Sales by Payment Method</h3>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{activeOrders.length} order(s) · {fmtK(totalRevenue)}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, padding: '16px 20px' }}>
              {[
                { label: 'Cash',         value: totalCashReceived,   color: '#16a34a' },
                { label: 'Mobile Money', value: totalMomoReceived,   color: '#ea580c' },
                { label: 'Bank',         value: totalBankReceived,   color: '#2563eb' },
                { label: 'Credit',       value: totalCreditByMethod, color: '#dc2626' },
              ].map(b => (
                <div key={b.label} style={{ padding: '14px 16px', borderRadius: 12, background: b.color + '15', border: `1.5px solid ${b.color}40` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: b.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{b.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: b.color, marginTop: 4 }}>{fmtK(b.value)}</div>
                  <div style={{ fontSize: 11, color: b.color, opacity: 0.75, marginTop: 2 }}>{pct(b.value)}</div>
                </div>
              ))}
            </div>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left' }}>Date</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left' }}>Receipt #</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left' }}>Customer</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>Cash</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right', color: '#ea580c' }}>MoMo</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right', color: '#2563eb' }}>Bank</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right', color: '#dc2626' }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {activeOrders.map(o => {
                  // v1.9.29 — read cash_received / momo_received / bank_received
                  // (the actual POS save columns), not cash/momo/bank.
                  const cash = parseFloat(o.cash_received || 0);
                  const momo = parseFloat(o.momo_received || 0);
                  const bank = parseFloat(o.bank_received || 0);
                  const credit = Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0));
                  return (
                    <tr key={o.id}>
                      <td style={{ padding: '8px 12px' }}>{(o.date || '').slice(0,10)}</td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{o.order_number}</td>
                      <td style={{ padding: '8px 12px' }}>{o.customer_name || 'Walk-in'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>{fmtK(o.total_amount)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: cash > 0 ? '#16a34a' : '#cbd5e1' }}>{cash > 0 ? fmtK(cash) : '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: momo > 0 ? '#ea580c' : '#cbd5e1' }}>{momo > 0 ? fmtK(momo) : '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: bank > 0 ? '#2563eb' : '#cbd5e1' }}>{bank > 0 ? fmtK(bank) : '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: credit > 0 ? '#dc2626' : '#cbd5e1' }}>{credit > 0 ? fmtK(credit) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
                  <td colSpan={3} style={{ padding: '10px 12px', textAlign: 'right' }}>TOTAL</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtK(totalRevenue)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{fmtK(totalCashReceived)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#ea580c' }}>{fmtK(totalMomoReceived)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#2563eb' }}>{fmtK(totalBankReceived)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#dc2626' }}>{fmtK(totalCreditByMethod)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        );
      })()}

      {activeTab === 'byPayment' && !isLiquorStyle && (() => {
        // Sosna is cash-only across 3 currencies. Per-order breakdown shows
        // what the customer paid IN each currency (net of change in that same
        // currency) plus any unpaid balance (Credit, always in USD).
        // v1.8.76 — full per-currency breakdown for each order: Paid, Change Given,
        // Net (= Paid − Given), and ± (over-collection in that source currency).
        // Uses usd_change_given (physical USD returned) instead of change_amount
        // so over-payments kept in FRA/K don't bleed into the USD column.
        const adjusted = (o) => {
          const usdPaid  = parseFloat(o.cash_received || 0) || 0;
          const usdGiven = parseFloat(o.usd_change_given ?? o.change_amount ?? 0) || 0;
          const fraPaid  = parseFloat(o.fra_received || 0) || 0;
          const fraGiven = parseFloat(o.fra_change_given || 0) || 0;
          const kPaid    = parseFloat(o.k_received || 0) || 0;
          const kGiven   = parseFloat(o.k_change_given || 0) || 0;
          const keptCcy  = (o.overpaid_kept_ccy || '').toUpperCase();
          const keptAmt  = parseFloat(o.overpaid_kept_amt || 0) || 0;
          // v1.8.88 — absorbed shortage: walk-in customer paid less than
          // total_amount and cashier let them go (payment_method='Cash', within
          // tolerance). Source-currency attribution mirrors the backend
          // /cash-reports/daily endpoint (K → FRA → USD priority).
          let absorbedUSD = 0, absorbedFRA = 0, absorbedK = 0;
          if (o.payment_method === 'Cash') {
            const shortUSD = (parseFloat(o.total_amount) || 0) - (parseFloat(o.amount_received) || 0);
            if (shortUSD > 0.005) {
              const sellR  = parseFloat(o.selling_rate_used)   || 0;
              const sellRK = parseFloat(o.selling_rate_k_used) || 0;
              if (kPaid > 0 && sellRK > 0)        absorbedK   = shortUSD * sellRK;
              else if (fraPaid > 0 && sellR > 0)  absorbedFRA = shortUSD * sellR;
              else                                 absorbedUSD = shortUSD;
            }
          }
          return {
            usdPaid, usdGiven, usdNet: usdPaid - usdGiven,
            fraPaid, fraGiven, fraNet: fraPaid - fraGiven,
            kPaid,   kGiven,   kNet:   kPaid   - kGiven,
            // ± Signed. Positive = kept in drawer (over). Negative = absorbed (short).
            // An order is either over or under, never both — so these are exclusive.
            usdDiff: (keptCcy === 'USD' ? keptAmt : 0) - absorbedUSD,
            fraDiff: (keptCcy === 'FRA' ? keptAmt : 0) - absorbedFRA,
            kDiff:   (keptCcy === 'K'   ? keptAmt : 0) - absorbedK,
            // v1.8.76 — only Credit / Partial-Credit rows contribute to credit.
            credit:  (o.payment_method === 'Credit' || o.payment_method === 'Partial-Credit')
              ? Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0))
              : 0,
          };
        };
        const totals = activeOrders.reduce((acc, o) => {
          const r = adjusted(o);
          return {
            usdPaid: acc.usdPaid + r.usdPaid, usdGiven: acc.usdGiven + r.usdGiven, usdNet: acc.usdNet + r.usdNet, usdDiff: acc.usdDiff + r.usdDiff,
            fraPaid: acc.fraPaid + r.fraPaid, fraGiven: acc.fraGiven + r.fraGiven, fraNet: acc.fraNet + r.fraNet, fraDiff: acc.fraDiff + r.fraDiff,
            kPaid:   acc.kPaid   + r.kPaid,   kGiven:   acc.kGiven   + r.kGiven,   kNet:   acc.kNet   + r.kNet,   kDiff:   acc.kDiff   + r.kDiff,
            credit:  acc.credit  + r.credit,
            // Legacy aliases for the summary cards that already exist below.
            usd: acc.usd + (r.usdNet), fra: acc.fra + r.fraNet, k: acc.k + r.kNet,
          };
        }, { usdPaid: 0, usdGiven: 0, usdNet: 0, usdDiff: 0, fraPaid: 0, fraGiven: 0, fraNet: 0, fraDiff: 0, kPaid: 0, kGiven: 0, kNet: 0, kDiff: 0, credit: 0, usd: 0, fra: 0, k: 0 });

        return (
          <div className="card">
            <div className="card-header">
              <h3>Sales by Currency</h3>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{activeOrders.length} order(s)</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, padding: '16px 20px' }}>
              {[
                { label: 'USD ($)', value: totals.usd,    color: '#16a34a', prefix: '$', dec: 2 },
                { label: 'FRA',     value: totals.fra,    color: '#7c3aed', prefix: '',  dec: 0, suffix: ' FRA' },
                { label: 'K',       value: totals.k,      color: '#ea580c', prefix: '',  dec: 0, suffix: ' K' },
                { label: 'Credit',  value: totals.credit, color: '#dc2626', prefix: '$', dec: 2 },
              ].map(b => (
                <div key={b.label} style={{ padding: '14px 16px', borderRadius: 12, background: b.color + '15', border: `1.5px solid ${b.color}40` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: b.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{b.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: b.color, marginTop: 4 }}>
                    {b.prefix}{(parseFloat(b.value)||0).toLocaleString(undefined,{minimumFractionDigits:b.dec,maximumFractionDigits:b.dec})}{b.suffix || ''}
                  </div>
                </div>
              ))}
            </div>

            {/* v1.8.76 — wide grouped table: per-currency Paid / Given / Net / ±.
                Two header rows: top has merged ccy groups; bottom has sub-labels. */}
            <div style={{ overflow: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, margin: '0 0 16px', minWidth: 1100 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Date</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Receipt #</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Customer</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Total ($)</th>
                  <th colSpan={4} style={{ padding: '8px 12px',  textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#16a34a', textTransform: 'uppercase', borderBottom: '1px solid #bbf7d0', background: '#f0fdf4' }}>USD ($)</th>
                  <th colSpan={4} style={{ padding: '8px 12px',  textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase', borderBottom: '1px solid #ddd6fe', background: '#faf5ff' }}>FRA</th>
                  <th colSpan={4} style={{ padding: '8px 12px',  textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#ea580c', textTransform: 'uppercase', borderBottom: '1px solid #fed7aa', background: '#fff7ed' }}>K</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Credit ($)</th>
                </tr>
                <tr style={{ background: '#f9fafb' }}>
                  {['Paid', 'Given', 'Net', '±'].map((h, i) => (
                    <th key={`u${i}`} style={{ padding: '6px 8px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#16a34a', borderBottom: '1px solid #e5e7eb', background: '#f0fdf4' }}>{h}</th>
                  ))}
                  {['Paid', 'Given', 'Net', '±'].map((h, i) => (
                    <th key={`f${i}`} style={{ padding: '6px 8px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#7c3aed', borderBottom: '1px solid #e5e7eb', background: '#faf5ff' }}>{h}</th>
                  ))}
                  {['Paid', 'Given', 'Net', '±'].map((h, i) => (
                    <th key={`k${i}`} style={{ padding: '6px 8px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#ea580c', borderBottom: '1px solid #e5e7eb', background: '#fff7ed' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeOrders.length === 0 ? (
                  <tr><td colSpan={17} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No sales for the selected period.</td></tr>
                ) : activeOrders.map(o => {
                  const r = adjusted(o);
                  const usdCol = '#16a34a', fraCol = '#7c3aed', kCol = '#ea580c';
                  const cell = (val, dec, sym, color) => {
                    const n = parseFloat(val) || 0;
                    if (Math.abs(n) < (dec === 0 ? 0.5 : 0.005)) return <span style={{ color: '#d1d5db' }}>—</span>;
                    return <span style={{ color }}>{sym}{n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}</span>;
                  };
                  // v1.8.88 — signed display. Positive (kept) keeps the passed
                  // amber color; negative (absorbed) overrides to red so loss
                  // is visually distinct from gain at a glance.
                  const diffCell = (val, dec, sym, color) => {
                    const n = parseFloat(val) || 0;
                    if (Math.abs(n) < (dec === 0 ? 0.5 : 0.005)) return <span style={{ color: '#d1d5db' }}>—</span>;
                    const isNeg = n < 0;
                    const c = isNeg ? '#dc2626' : color;
                    const sign = isNeg ? '−' : '+';
                    return <span style={{ color: c, fontWeight: 700 }}>{sign}{sym}{Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}</span>;
                  };
                  return (
                    <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 12px' }}>{new Date(o.created_at + 'Z').toLocaleDateString('en-GB')}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 11 }}>{o.order_number}</td>
                      <td style={{ padding: '8px 12px' }}>{o.customer_name || 'Walk-in'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>${(parseFloat(o.total_amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      {/* USD group */}
                      <td style={{ padding: '8px', textAlign: 'right', background: '#f0fdf41a' }}>{cell(r.usdPaid,  2, '$', usdCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#f0fdf41a' }}>{cell(r.usdGiven, 2, '$', usdCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#f0fdf41a', fontWeight: 600 }}>{cell(r.usdNet, 2, '$', usdCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fffbeb' }}>{diffCell(r.usdDiff, 2, '$', '#92400e')}</td>
                      {/* FRA group */}
                      <td style={{ padding: '8px', textAlign: 'right', background: '#faf5ff1a' }}>{cell(r.fraPaid,  0, '', fraCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#faf5ff1a' }}>{cell(r.fraGiven, 0, '', fraCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#faf5ff1a', fontWeight: 600 }}>{cell(r.fraNet, 0, '', fraCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fffbeb' }}>{diffCell(r.fraDiff, 0, '', '#92400e')}</td>
                      {/* K group */}
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fff7ed1a' }}>{cell(r.kPaid,  0, '', kCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fff7ed1a' }}>{cell(r.kGiven, 0, '', kCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fff7ed1a', fontWeight: 600 }}>{cell(r.kNet, 0, '', kCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fffbeb' }}>{diffCell(r.kDiff, 0, '', '#92400e')}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: r.credit > 0 ? '#dc2626' : '#9ca3af', fontWeight: r.credit > 0 ? 700 : 400 }}>{r.credit > 0 ? `$${(parseFloat(r.credit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              {activeOrders.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                    <td colSpan={3} style={{ padding: '11px 12px' }}>TOTAL</td>
                    <td style={{ padding: '11px 12px', textAlign: 'right' }}>${(parseFloat(totalRevenue)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#16a34a' }}>${totals.usdPaid.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#16a34a' }}>${totals.usdGiven.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#16a34a' }}>${totals.usdNet.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    {/* v1.8.88 — signed totals: positive (kept) amber, negative (absorbed) red.
                        sumCell renders the aggregate with the correct sign and colour
                        and folds to '—' when within rounding-dust tolerance. */}
                    {(() => null)()}
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: totals.usdDiff < -0.005 ? '#dc2626' : '#92400e', background: '#fffbeb' }}>
                      {Math.abs(totals.usdDiff) < 0.005
                        ? '—'
                        : `${totals.usdDiff < 0 ? '−' : '+'}$${Math.abs(totals.usdDiff).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`}
                    </td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#7c3aed' }}>{totals.fraPaid.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#7c3aed' }}>{totals.fraGiven.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#7c3aed' }}>{totals.fraNet.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: totals.fraDiff < -0.5 ? '#dc2626' : '#92400e', background: '#fffbeb' }}>
                      {Math.abs(totals.fraDiff) < 0.5
                        ? '—'
                        : `${totals.fraDiff < 0 ? '−' : '+'}${Math.abs(totals.fraDiff).toLocaleString(undefined,{maximumFractionDigits:0})}`}
                    </td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#ea580c' }}>{totals.kPaid.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#ea580c' }}>{totals.kGiven.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#ea580c' }}>{totals.kNet.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: totals.kDiff < -0.5 ? '#dc2626' : '#92400e', background: '#fffbeb' }}>
                      {Math.abs(totals.kDiff) < 0.5
                        ? '—'
                        : `${totals.kDiff < 0 ? '−' : '+'}${Math.abs(totals.kDiff).toLocaleString(undefined,{maximumFractionDigits:0})}`}
                    </td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', color: '#dc2626' }}>${(parseFloat(totals.credit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            </div>
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
                        <span style={{ textAlign: 'right', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none' }}>{curSym}{(parseFloat(unitPx)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        <span style={{ textAlign: 'right', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none', fontWeight: partial ? 700 : 400 }}>{curSym}{(parseFloat(netTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
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
                      {/* Per-line adjustment sub-row — shown when this line has a
                          discount OR surcharge applied. Same format as the thermal
                          print. v1.10.231 — Liquor branches now also render the
                          markup line (blue "surcharge") so the totals summary
                          always has per-line detail behind it. */}
                      {Math.abs(lineDisc) > 0.001 && (
                        <div key={`${idx}-disc`} style={{
                          display: 'flex', fontSize: 11,
                          color: lineDisc > 0 ? '#6b7280' : '#2563eb',
                          marginTop: -2, marginBottom: 6,
                          opacity: item.reversed ? 0.5 : 1,
                        }}>
                          <span style={{ flex: 2, paddingLeft: 16 }}>
                            {lineDisc > 0 ? 'discount' : 'surcharge'} {netQty}{item.unit ? ` ${item.unit}` : ''} × {lineDisc > 0 ? '-' : '+'}{curSym}{Math.abs(parseFloat(lineDisc)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </span>
                          <span style={{ flex: 1 }} />
                          <span style={{ flex: 1 }} />
                          <span style={{ flex: 1, textAlign: 'right' }}>
                            {lineDiscTotal > 0 ? '-' : '+'}{curSym}{Math.abs(parseFloat(lineDiscTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
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
                          <span>{curSym}{(parseFloat(originalSubtotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>
                        {/* v1.8.57 — discount can be negative (= markup). Show
                            "Total discount" in red for + values, "Total surcharge"
                            in blue for − values. */}
                        {Math.abs(originalDiscount) > 0.001 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: originalDiscount > 0 ? '#dc2626' : '#2563eb' }}>
                              {originalDiscount > 0 ? 'Total discount' : 'Total surcharge'}
                            </span>
                            <span style={{ color: originalDiscount > 0 ? '#dc2626' : '#2563eb' }}>
                              {originalDiscount > 0 ? '-' : '+'}{curSym}{Math.abs(originalDiscount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                            </span>
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingTop: 6, borderTop: '1px solid #e5e7eb', fontWeight: 700, fontSize: 14 }}>
                          <span>TOTAL</span>
                          <span>{curSym}{(parseFloat(originalTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
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
                                <span>{curSym}{(parseFloat(amountReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            );
                          }
                          return (
                            <>
                              {cashIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Cash</span>
                                  <span>{curSym}{(parseFloat(cashIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              {momoIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Mobile Money</span>
                                  <span>{curSym}{(parseFloat(momoIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              {bankIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Bank</span>
                                  <span>{curSym}{(parseFloat(bankIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontWeight: 700, borderTop: '1px dotted #e5e7eb', paddingTop: 3 }}>
                                <span>Total Received</span>
                                <span>{curSym}{(parseFloat(amountReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            </>
                          );
                        })()}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, color: '#16a34a' }}>
                          <span>Change at Till</span>
                          <span>{curSym}{(parseFloat(originalChange)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>

                        {/* v1.8.51 — Credit / Partial-Credit sales: print the unpaid balance
                            so the customer's receipt shows what they still owe. */}
                        {(() => {
                          const total = parseFloat(viewOrder.total_amount || 0);
                          const recd  = parseFloat(amountReceived || 0);
                          const owed  = Math.max(0, total - recd);
                          if (owed <= 0.10) return null;
                          return (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, color: '#b45309', borderTop: '1px solid #fde68a', marginTop: 6, paddingTop: 6, background: '#fef3c7', padding: '6px 10px', borderRadius: 4 }}>
                              <span>BALANCE ON CREDIT</span>
                              <span>{curSym}{owed.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                            </div>
                          );
                        })()}

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
                                <span style={{ color: '#b45309' }}>−{curSym}{(parseFloat(r.amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            ))}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, paddingTop: 6, borderTop: '1px solid #fde68a', fontWeight: 700, color: '#b45309' }}>
                              <span>Refund Owed</span>
                              <span>{curSym}{(parseFloat(totalRefund)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '2px solid #111827', fontWeight: 800, fontSize: 14 }}>
                              <span>NET TOTAL</span>
                              <span>{curSym}{(parseFloat(netTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
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
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{curSym}{(parseFloat(breakdown.items.reduce((s, r) => s + parseFloat(r.total_price), 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
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
