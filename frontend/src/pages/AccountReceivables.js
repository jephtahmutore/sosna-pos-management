import React, { useState, useEffect, useCallback } from 'react';
import {
  getCustomers, getArStats,
  getCustomerStatement, createCustomerPayment,
  getCustomerPayments, deleteCustomerPayment,
  getSettings, getOrder, getCurrentFxRate,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import {
  FiSearch, FiDollarSign, FiFileText, FiX, FiRefreshCw,
  FiUsers, FiAlertCircle, FiChevronRight, FiTrash2, FiPrinter,
} from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import CustomerStatementModal from '../components/CustomerStatementModal';
import { matchTokens } from '../utils/tokenSearch';
import { printOrderReceipt } from '../utils/orderReceipt';

const todayStr = () => new Date().toISOString().slice(0, 10);
// fmt() is defined inside the component now so it can read the tenant's primary currency symbol.

const statusBadge = (status) => {
  const map = {
    'Paid': { bg: '#dcfce7', fg: '#15803d' },
    'Partial': { bg: '#fef3c7', fg: '#b45309' },
    'Unpaid': { bg: '#fee2e2', fg: '#b91c1c' },
    'No Sales': { bg: '#f3f4f6', fg: '#6b7280' },
    'OnHold': { bg: '#fee2e2', fg: '#b91c1c' },
  };
  return map[status] || map['No Sales'];
};

const AccountReceivables = () => {
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym, currencyMode, isLiquorStyle } = useCurrency();
  const { t } = useLanguage();
  // v1.8.55 — Sosna triple-currency gating + live FX rates for AR receipts.
  const isDual = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const [fxRate, setFxRate] = useState({ sell: 0, buy: 0, sellK: 0, buyK: 0 });
  const SELL_RATE   = fxRate.sell;
  const SELL_RATE_K = fxRate.sellK;
  const hasK        = SELL_RATE_K > 0;
  // Local fmt — uses the tenant's primary currency symbol.
  const fmt = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const [businessInfo, setBusinessInfo] = useState({});
  const [stats, setStats] = useState({ totalSales: 0, totalReceived: 0, outstanding: 0, customers: 0, owingCount: 0 });
  const [rows, setRows] = useState([]);
  const [payments, setPayments] = useState([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('receivables'); // receivables | payments
  const [paymentModal, setPaymentModal] = useState(null);
  // v1.8.55 — triple-currency AR receipts (Sosna). usd/fra/k mirror the
  // Cashier Pay modal. Legacy bank/momo columns are no longer collected
  // from the UI but the backend still accepts them for backwards compat.
  // v1.8.56 — `sell_rate` / `sell_rate_k` are editable per-receipt
  // overrides (default to the current FX rate at open time).
  const [paymentForm, setPaymentForm] = useState({
    usd_amount: '', fra_amount: '', k_amount: '',
    sell_rate: '', sell_rate_k: '',
    payment_date: todayStr(), reference: '', notes: '',
  });
  const [statementModal, setStatementModal] = useState(null);
  // Lightweight modal for viewing a single order's items + payment breakdown from inside AR.
  const [orderDetail, setOrderDetail] = useState(null); // { loading, data?, error? }

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!paymentModal || !!statementModal || !!orderDetail);
  const openOrderDetail = async (orderId) => {
    if (!orderId) return;
    setOrderDetail({ loading: true });
    try {
      const res = await getOrder(orderId);
      setOrderDetail({ loading: false, data: res.data });
    } catch (err) {
      setOrderDetail({ loading: false, error: err.response?.data?.error || 'Failed to load order' });
    }
  };
  const [toast, setToast] = useState(null);
  // Date filter — default to first..last day of the current month (period view)
  const _today = new Date();
  const _firstOfMonth = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-01`;
  const _todayStr = _today.toISOString().split('T')[0];
  // Default to All Time so the outstanding + customer credit cards
  // reflect true cumulative totals (Balance Sheet uses cumulative as-at
  // asOf; This Month can hide old unpaid invoices under the This Month
  // window). Users can still narrow with the From/To pickers or the
  // "This Month" chip.
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const fetchAll = useCallback(async () => {
    try {
      const params = { from: filterFrom || undefined, to: filterTo || undefined };
      const [customersRes, statsRes, paymentsRes] = await Promise.all([
        getCustomers(params), getArStats(params), getCustomerPayments(params),
      ]);
      const list = (Array.isArray(customersRes.data) ? customersRes.data : []).map(c => {
        const sold        = parseFloat(c.total_sold    || 0);
        const cashAtSale  = parseFloat(c.cash_at_sale  || 0);    // POS-time cash on credit sales
        const arPaid      = parseFloat(c.total_paid    || 0);    // manual AR payments
        const paid        = cashAtSale + arPaid;
        // Display convention: positive = customer paid more than they bought (advance),
        // negative = customer still owes us. That's the flip of the backend's `outstanding`
        // (which is sold − paid). All conditions below reference this flipped value.
        const balance     = paid - sold;
        let status = 'No Sales';
        if (c.credit_status === 'OnHold')      status = 'OnHold';
        else if (sold === 0)                   status = 'No Sales';
        else if (balance >= -0.01)             status = 'Paid';     // fully paid or advance
        else if (paid > 0)                     status = 'Partial';
        else                                   status = 'Unpaid';
        // v1.8.57 — carry per-currency outstanding for FRA / K display.
        // Backend computes these using each unpaid order's captured sale rate.
        return {
          ...c, _sold: sold, _paid: paid, _balance: balance, _status: status,
          _outstandingFra: parseFloat(c.outstanding_fra || 0),
          _outstandingK:   parseFloat(c.outstanding_k   || 0),
        };
      });
      setRows(list);
      setStats(statsRes.data || { totalSales: 0, totalReceived: 0, outstanding: 0, customers: 0, owingCount: 0 });
      setPayments(Array.isArray(paymentsRes.data) ? paymentsRes.data : []);
    } catch (err) { /* ignore */ }
  }, [filterFrom, filterTo]);

  useEffect(() => {
    fetchAll();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    // v1.8.55 — pull current FX rates so the AR receipt can convert FRA/K
    // to USD at the same rates the Cashier uses.
    getCurrentFxRate().then(r => {
      const d = r.data;
      if (d && d.sell_rate > 0 && d.buy_rate > 0) {
        setFxRate({
          sell:  parseFloat(d.sell_rate)   || 0,
          buy:   parseFloat(d.buy_rate)    || 0,
          sellK: parseFloat(d.sell_rate_k || 0) || 0,
          buyK:  parseFloat(d.buy_rate_k  || 0) || 0,
        });
      }
    }).catch(() => {});
    window.addEventListener('sync-complete', fetchAll);
    return () => window.removeEventListener('sync-complete', fetchAll);
  }, [fetchAll]);

  // Print the receivables list — A4 portrait, matches AP's layout for consistency.
  const handlePrint = () => {
    const fmtPlain = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const period = (filterFrom || filterTo)
      ? `${filterFrom || '—'} to ${filterTo || '—'}`
      : 'All Time';
    const rowsHtml = receivablesRows.map((r, idx) => `
      <tr style="border-bottom:1px solid #ddd;background:${idx % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:8px 10px;font-size:10.5px">${idx + 1}</td>
        <td style="padding:8px 10px;font-weight:700">${r.name}</td>
        <td style="padding:8px 10px">${r.phone || '—'}</td>
        <td style="padding:8px 10px;text-align:right">${parseFloat(r.credit_limit) > 0 ? curSym + fmtPlain(r.credit_limit) : '—'}</td>
        <td style="padding:8px 10px;text-align:right">${curSym}${fmtPlain(r._sold)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${curSym}${fmtPlain(r._paid)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700">${curSym}${fmtPlain(Math.abs(r._balance))}${r._balance < -0.01 ? ' (owed)' : r._balance > 0.01 ? ' (advance)' : ''}</td>
        <td style="padding:8px 10px">${r._status === 'OnHold' ? 'On Hold' : r._status}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      tfoot td{padding:10px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${biz}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Account Receivables</div>
          <div style="font-size:15px;font-weight:700">Customer Ledger</div>
          <div style="font-size:9px;margin-top:3px">Period: ${period}</div>
          <div style="font-size:9px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[
          ['Total Sales', curSym + fmtPlain(stats.totalSales)],
          ['Total Received', curSym + fmtPlain(stats.totalReceived)],
          ['Outstanding', curSym + fmtPlain(stats.outstanding)],
          ['Customers', `${stats.customers} (${stats.owingCount} owing)`],
        ].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:15px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <table style="font-size:11.5px">
          <thead><tr>
            <th style="width:28px">#</th><th>Customer</th><th>Phone</th>
            <th style="text-align:right">Credit Limit</th>
            <th style="text-align:right">Total Sales</th><th style="text-align:right">Total Paid</th>
            <th style="text-align:right">Balance</th><th>Status</th>
          </tr></thead>
          <tbody>${rowsHtml || `<tr><td colspan="8" style="padding:24px;text-align:center;color:#666">No receivables for this period.</td></tr>`}</tbody>
          ${receivablesRows.length > 0 ? `<tfoot><tr>
            <td colspan="4">TOTAL — ${receivablesRows.length} Customer${receivablesRows.length !== 1 ? 's' : ''}</td>
            <td style="text-align:right">${curSym}${fmtPlain(receivablesRows.reduce((s, r) => s + r._sold, 0))}</td>
            <td style="text-align:right">${curSym}${fmtPlain(receivablesRows.reduce((s, r) => s + r._paid, 0))}</td>
            <td style="text-align:right;font-size:13px">${curSym}${fmtPlain(receivablesRows.reduce((s, r) => s + r._balance, 0))} (net)</td>
            <td></td>
          </tr></tfoot>` : ''}
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
        <span style="font-size:9px">${biz} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  // v1.10.300 — was filtering to only customers with sold > 0 OR paid > 0,
  // which hid every zero-activity customer even when the user searched for
  // them by name. Real report 2026-08-06 on lusaka1: "Rashida" (Regular /
  // Cash only / K0 outstanding) existed in Customers but never appeared in
  // AR search results because she'd never transacted. Now: show all
  // customers, sort by outstanding first (biggest debtor at top), zero-
  // activity rows fall to the bottom with a "No Sales" status badge.
  const receivablesRows = rows
    .filter(r => matchTokens(search, r.name, r.phone, r.email))
    // Most negative balance first — biggest debtor at top under the flipped convention.
    .sort((a, b) => a._balance - b._balance);

  const paymentsRows = payments.filter(p => matchTokens(search, p.customer_name, p.reference, p.payment_number));

  const openPayment = (c) => {
    // v1.8.55 — default to USD pre-filled with the customer's balance.
    // v1.8.56 — pre-fill sell rates from the current live FX rates;
    //          the accountant can override per-receipt if the customer
    //          negotiated a different rate.
    setPaymentForm({
      usd_amount: c._balance < 0 ? Math.abs(c._balance).toFixed(2) : '',
      fra_amount: '',
      k_amount: '',
      sell_rate:   SELL_RATE   > 0 ? String(SELL_RATE)   : '',
      sell_rate_k: SELL_RATE_K > 0 ? String(SELL_RATE_K) : '',
      payment_date: todayStr(),
      reference: '', notes: '',
    });
    setPaymentModal({ customer: c });
  };
  const savePayment = async () => {
    const usd = parseFloat(paymentForm.usd_amount || 0) || 0;
    const fra = parseFloat(paymentForm.fra_amount || 0) || 0;
    const kAmt= parseFloat(paymentForm.k_amount   || 0) || 0;
    // v1.8.56 — use the per-receipt rate from the form (defaults to
    // current live rate but the accountant may override).
    const sellRate  = parseFloat(paymentForm.sell_rate   || 0) || 0;
    const sellRateK = parseFloat(paymentForm.sell_rate_k || 0) || 0;
    const fraAsUsd = sellRate  > 0 ? fra  / sellRate  : 0;
    const kAsUsd   = sellRateK > 0 ? kAmt / sellRateK : 0;
    const totalUsd = usd + fraAsUsd + kAsUsd;
    if (!(totalUsd > 0)) { showToast('Enter at least one currency > 0', 'error'); return; }
    if (!isLiquorStyle && fra > 0 && !(sellRate > 0))  { showToast('FRA Sell rate is required', 'error'); return; }
    if (!isLiquorStyle && kAmt > 0 && !(sellRateK > 0)){ showToast('K Sell rate is required', 'error'); return; }
    try {
      // v1.10.74 — on Liquor branches, the three fields ARE the payment
      // methods (Cash / Mobile Money / Bank) in native K. Send them as
      // legacy cash_amount / bank_amount / momo_amount so the backend
      // labels the payment method correctly (Cash/Bank/Mobile Money
      // instead of the wrong 'USD'/'FRA'/'K') AND the minted cash_receipt
      // populates the columns Cash Book already reads. Sosna keeps the
      // triple-currency shape with FX rates.
      const payload = isLiquorStyle
        ? {
            customer_id: paymentModal.customer.id,
            // Under the Liquor convention Cash → cash_amount,
            // Mobile Money → momo_amount, Bank → bank_amount. The frontend
            // fields still carry those values under the usd_/fra_/k_ keys
            // (kept for schema symmetry with Sosna), but the payload maps
            // them to legacy method columns.
            cash_amount: usd,
            momo_amount: fra,
            bank_amount: kAmt,
            payment_date: paymentForm.payment_date,
            reference:    paymentForm.reference,
            notes:        paymentForm.notes,
          }
        : {
            customer_id: paymentModal.customer.id,
            usd_amount: usd,
            fra_amount: fra,
            k_amount:   kAmt,
            selling_rate_used:   isDual ? sellRate   : null,
            selling_rate_k_used: hasK   ? sellRateK  : null,
            payment_date: paymentForm.payment_date,
            reference:    paymentForm.reference,
            notes:        paymentForm.notes,
          };
      await createCustomerPayment(payload);
      setPaymentModal(null);
      await fetchAll();
      showToast('Payment recorded — Cash Receipt issued');
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const openStatement = async (c) => {
    try {
      const res = await getCustomerStatement(c.id);
      setStatementModal(res.data);
    } catch (err) { showToast('Failed to load statement', 'error'); }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeletePayment = (p) => {
    setPendingDelete({
      subject: `Payment ${fmt(p.amount)} from ${p.customer_name} — voids its Cash Receipt`,
      perform: async () => {
        try { await deleteCustomerPayment(p.id); await fetchAll(); showToast('Payment + Cash Receipt deleted'); }
        catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
      },
    });
  };

  const card = (label, value, sub, variant, Icon) => (
    <div className={`stat-card ${variant}`}>
      <div className="stat-icon"><Icon /></div>
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {sub && <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('accountReceivables')}</h1>
          <p>{t('accountReceivablesSubtitle', { count: stats.owingCount })}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={fetchAll}
            style={{ padding: '9px 16px', background: '#fff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw size={14} /> {t('refresh')}
          </button>
          <button onClick={handlePrint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPrinter size={15} /> {t('print')}
          </button>
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, padding: '10px 18px', borderRadius: 8, color: '#fff', fontWeight: 600, background: toast.type === 'error' ? '#dc2626' : '#16a34a', boxShadow: '0 4px 14px rgba(0,0,0,0.18)', zIndex: 1100 }}>
          {toast.msg}
        </div>
      )}

      {/* Stat cards — split Outstanding from Customer Credit so the dashboard never shows a
          confusing net like "−$30 Outstanding". rows already carry the flipped _balance
          (positive = advance, negative = still owed). */}
      {(() => {
        const outstandingOnly    = rows.reduce((s, r) => s + Math.max(0, -(parseFloat(r._balance) || 0)), 0);
        const customerCreditOnly = rows.reduce((s, r) => s + Math.max(0,  (parseFloat(r._balance) || 0)), 0);
        return (
          <div className="stat-cards">
            {card(t('totalSales'),    fmt(stats.totalSales),    t('allCustomers'),                          'blue',   FiDollarSign)}
            {card(t('totalReceived'), fmt(stats.totalReceived), t('paidIn'),                                'green',  FiDollarSign)}
            {card(t('outstanding'),   (outstandingOnly > 0.01 ? '−' : '') + fmt(outstandingOnly), t('stillOwed'), 'red', FiAlertCircle)}
            {customerCreditOnly > 0.01 && card(t('customerCredit'), fmt(customerCreditOnly), t('paidInAdvance'), 'green', FiDollarSign)}
            {card(t('customers'),     stats.customers,          `${stats.owingCount} ${t('owing')}`,        'purple', FiUsers)}
          </div>
        );
      })()}

      {/* ── Date Filter Bar ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{t('filterByDate')}:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('from')}</span>
          <input type="date" value={filterFrom} max={filterTo || _todayStr}
            onChange={e => setFilterFrom(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
          <input type="date" value={filterTo} min={filterFrom || undefined} max={_todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }} />
        </div>
        <button onClick={() => { setFilterFrom(_firstOfMonth); setFilterTo(_todayStr); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #bfdbfe', fontSize: 12, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>
          {t('thisMonth')}
        </button>
        <button onClick={() => { setFilterFrom(''); setFilterTo(''); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
          {t('allTime')}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
          {filterFrom || filterTo
            ? `${filterFrom || '—'} ${t('to')} ${filterTo || '—'}`
            : t('showingAllTime')}
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'receivables', label: t('receivables') },
          { key: 'payments',    label: t('payments') },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '10px 18px', background: 'none',
              border: 'none', borderBottom: tab === t.key ? '3px solid #1d4ed8' : '3px solid transparent',
              color: tab === t.key ? '#1d4ed8' : '#6b7280',
              fontWeight: tab === t.key ? 700 : 500, fontSize: 13.5,
              cursor: 'pointer', marginBottom: -2,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ marginBottom: 12, position: 'relative' }}>
        <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input type="text" placeholder={tab === 'receivables' ? t('searchCustomer') : t('searchByCustomerOrRef')}
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 12px 10px 36px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      {/* Receivables tab */}
      {tab === 'receivables' && (
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {[t('customer'),t('phone'),t('creditLimit'),t('totalSales'),t('totalPaid'),t('balance'),t('status'),t('action')].map((h, i) => (
                  <th key={i} style={{ padding: '11px 12px', textAlign: i < 2 ? 'left' : i === 7 ? 'right' : 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {receivablesRows.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>{t('noReceivables')}</td></tr>
              ) : receivablesRows.map(r => {
                const s = statusBadge(r._status);
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <button onClick={() => openStatement(r)}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, color: '#1d4ed8', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        {r.name} <FiChevronRight size={13} />
                      </button>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#6b7280' }}>{r.phone || '—'}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>{parseFloat(r.credit_limit) > 0 ? fmt(r.credit_limit) : <span style={{ color: '#9ca3af' }}>—</span>}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmt(r._sold)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{fmt(r._paid)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: r._balance > 0.01 ? '#b45309' : r._balance < -0.01 ? '#dc2626' : '#16a34a' }}>
                      {/* Signed value — minus sign goes BEFORE the currency symbol (standard accounting). */}
                      {r._balance < 0 ? '−' : ''}{fmt(Math.abs(r._balance))}
                      {/* v1.8.57 — FRA / K equivalents at captured sale rates. */}
                      {r._balance < -0.01 && (r._outstandingFra > 0.01 || r._outstandingK > 0.01) && (
                        <div style={{ fontSize: 10, fontWeight: 500, color: '#94a3b8', marginTop: 2 }}>
                          ≈ {r._outstandingFra > 0.01 && <>FRA {Math.round(r._outstandingFra).toLocaleString()}</>}
                          {r._outstandingFra > 0.01 && r._outstandingK > 0.01 && ' · '}
                          {r._outstandingK > 0.01 && <>K {Math.round(r._outstandingK).toLocaleString()}</>}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.fg }}>{r._status === 'OnHold' ? 'On Hold' : r._status}</span>
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      {/* v1.10.92 — Pay / Down Payment button now gates on
                          AccountReceivables:Add (recording a payment IS an AR
                          add operation) with a Customers:Edit fallback so
                          pre-v1.10.92 grants keep working. Previously only
                          Customers:Edit was checked, which meant granting
                          full AR perms did NOT reveal the Pay button. */}
                      {(hasPermission('AccountReceivables:Add') !== false || hasPermission('Customers:Edit') !== false) && (
                        <button onClick={() => openPayment(r)}
                          style={{
                            padding: '5px 14px',
                            // Green Pay button when customer is in debt (negative balance under flipped convention).
                            background: r._balance < -0.01 ? '#16a34a' : '#2563eb',
                            color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                          }}>
                          {r._balance < -0.01 ? 'Pay' : 'Down Payment'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Payments tab */}
      {tab === 'payments' && (
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Date','Customer','Method','Reference','Notes','Amount','By','Action'].map((h, i) => (
                  <th key={i} style={{ padding: '11px 12px', textAlign: i === 5 ? 'right' : i === 7 ? 'right' : 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paymentsRows.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No payments recorded.</td></tr>
              ) : paymentsRows.map(p => (
                <tr key={`${p.source || 'manual'}-${p.id}`} style={{ borderBottom: '1px solid #f3f4f6', background: p.source === 'pos' ? '#fafafa' : '#fff' }}>
                  <td style={{ padding: '10px 12px' }}>{(p.payment_date || '').slice(0, 10)}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{p.customer_name || '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>
                    {p.payment_method}
                    {p.source === 'pos' && (
                      <span style={{ marginLeft: 6, padding: '1px 6px', background: '#dbeafe', color: '#1d4ed8', borderRadius: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>POS</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{p.reference || '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{p.notes || '—'}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmt(p.amount)}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>{p.created_by_name || '—'}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    {p.source !== 'pos' && hasPermission('Customers:Edit') !== false && (
                      <button onClick={() => handleDeletePayment(p)} title="Delete payment"
                        style={{ width: 26, height: 26, background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        <FiTrash2 size={12} />
                      </button>
                    )}
                    {p.source === 'pos' && (
                      <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>via sale</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {paymentsRows.length > 0 && (
              <tfoot>
                <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                  <td colSpan={5} style={{ padding: '10px 12px' }}>TOTAL</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{fmt(paymentsRows.reduce((s, p) => s + parseFloat(p.amount || 0), 0))}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Payment modal */}
      {paymentModal && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>
                  {paymentModal.customer._balance < -0.01 ? 'Record Payment' : 'Receive Down Payment'}
                </h3>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
                  From <strong>{paymentModal.customer.name}</strong>
                  {paymentModal.customer._balance < -0.01 ? (
                    <>
                      {' · owes '}{fmt(Math.abs(paymentModal.customer._balance))}
                      {/* v1.8.57 — show FRA / K equivalents using captured sale rates. */}
                      {(paymentModal.customer._outstandingFra > 0.01 || paymentModal.customer._outstandingK > 0.01) && (
                        <span style={{ color: '#94a3b8', fontWeight: 500 }}>
                          {' ≈ '}
                          {paymentModal.customer._outstandingFra > 0.01 && <>FRA {Math.round(paymentModal.customer._outstandingFra).toLocaleString()}</>}
                          {paymentModal.customer._outstandingFra > 0.01 && paymentModal.customer._outstandingK > 0.01 && ' · '}
                          {paymentModal.customer._outstandingK > 0.01 && <>K {Math.round(paymentModal.customer._outstandingK).toLocaleString()}</>}
                          {' (at sale-time rate)'}
                        </span>
                      )}
                    </>
                  ) : <> · advance (credit applied to future credit sales)</>}
                </div>
              </div>
              <button onClick={() => setPaymentModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={18} /></button>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 12 }}>
              {/* v1.8.56 — per-receipt FX rate (defaults to live rate, editable).
                  Only shown when FRA or K is enabled for this tenant.
                  v1.10.73 — hidden on Liquor branches (K-only, native, no FX). */}
              {!isLiquorStyle && (isDual || hasK) && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: 0.4 }}>FX Rate for this receipt</div>
                    <button type="button"
                      onClick={() => setPaymentForm({
                        ...paymentForm,
                        sell_rate:   SELL_RATE   > 0 ? String(SELL_RATE)   : '',
                        sell_rate_k: SELL_RATE_K > 0 ? String(SELL_RATE_K) : '',
                      })}
                      style={{ padding: '3px 10px', fontSize: 11, background: '#fff', color: '#92400e', border: '1px solid #fde68a', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
                      Reset to default
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: isDual && hasK ? '1fr 1fr' : '1fr', gap: 10 }}>
                    {isDual && (
                      <div>
                        <label style={{ fontSize: 11, color: '#92400e', fontWeight: 600, display: 'block', marginBottom: 3 }}>Sell rate (paid in FRA)</label>
                        <input type="number" min="0" step="0.01" value={paymentForm.sell_rate}
                          onChange={e => setPaymentForm({ ...paymentForm, sell_rate: e.target.value })}
                          placeholder={SELL_RATE > 0 ? String(SELL_RATE) : '0'}
                          style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontWeight: 600, boxSizing: 'border-box' }} />
                      </div>
                    )}
                    {hasK && (
                      <div>
                        <label style={{ fontSize: 11, color: '#92400e', fontWeight: 600, display: 'block', marginBottom: 3 }}>Sell rate (paid in K)</label>
                        <input type="number" min="0" step="0.01" value={paymentForm.sell_rate_k}
                          onChange={e => setPaymentForm({ ...paymentForm, sell_rate_k: e.target.value })}
                          placeholder={SELL_RATE_K > 0 ? String(SELL_RATE_K) : '0'}
                          style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontWeight: 600, boxSizing: 'border-box' }} />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* v1.8.55 — Sosna triple-currency receipt: USD / FRA / K.
                  v1.10.73 — Liquor branches show Cash / Mobile Money / Bank
                  instead (all in native K, no FX). Same field-to-column
                  mapping as CashReceipt.js: Cash→usd_amount,
                  MoMo→fra_amount, Bank→k_amount — keeps the receipt row
                  compatible with the existing customer_payments schema and
                  Cash Book split logic. */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Amount Paid{isLiquorStyle ? ' (split across methods)' : ' (split across currencies)'}
              </div>
              {(() => {
                const fields = isLiquorStyle
                  ? [
                      { key: 'usd_amount', label: 'Cash',         color: '#16a34a', step: '0.01', placeholder: '0.00', show: true },
                      { key: 'fra_amount', label: 'Mobile Money', color: '#ea580c', step: '0.01', placeholder: '0.00', show: true },
                      { key: 'k_amount',   label: 'Bank',         color: '#2563eb', step: '0.01', placeholder: '0.00', show: true },
                    ]
                  : [
                      { key: 'usd_amount', label: 'USD', color: '#16a34a', step: '0.01', placeholder: '0.00', show: true },
                      { key: 'fra_amount', label: 'FRA', color: '#2563eb', step: '1',    placeholder: '0',    show: isDual },
                      { key: 'k_amount',   label: 'K',   color: '#7c3aed', step: '1',    placeholder: '0',    show: hasK   },
                    ].filter(f => f.show);
                const cols = `repeat(${fields.length}, 1fr)`;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 10 }}>
                    {fields.map((f, i) => (
                      <div key={f.key}>
                        <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                        <input type="number" min="0" step={f.step} autoFocus={i === 0}
                          value={paymentForm[f.key]}
                          onChange={e => setPaymentForm({ ...paymentForm, [f.key]: e.target.value })}
                          placeholder={f.placeholder}
                          style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(paymentForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(paymentForm[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                      </div>
                    ))}
                  </div>
                );
              })()}
              {(() => {
                const usd = parseFloat(paymentForm.usd_amount || 0) || 0;
                const fra = parseFloat(paymentForm.fra_amount || 0) || 0;
                const kAmt= parseFloat(paymentForm.k_amount   || 0) || 0;
                // v1.10.73 — Liquor: all three fields are native K, just sum
                // them and display with tenant symbol. Sosna: convert
                // FRA + K → USD via the receipt's FX rate.
                if (isLiquorStyle) {
                  const totalK = usd + fra + kAmt;
                  return (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13 }}>
                      <span style={{ color: '#6b7280' }}>Total</span>
                      <span style={{ fontWeight: 800, color: totalK > 0 ? '#1d4ed8' : '#9ca3af' }}>{fmt(totalK)}</span>
                    </div>
                  );
                }
                const sellRate  = parseFloat(paymentForm.sell_rate   || 0) || 0;
                const sellRateK = parseFloat(paymentForm.sell_rate_k || 0) || 0;
                const fraAsUsd = sellRate  > 0 ? fra  / sellRate  : 0;
                const kAsUsd   = sellRateK > 0 ? kAmt / sellRateK : 0;
                const totalUsd = usd + fraAsUsd + kAsUsd;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>Total (≈ USD)</span>
                    <span style={{ fontWeight: 800, color: totalUsd > 0 ? '#1d4ed8' : '#9ca3af' }}>{fmt(totalUsd)}</span>
                  </div>
                );
              })()}
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Reference (optional)</label>
                <input value={paymentForm.reference} onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })} placeholder="invoice / receipt number" />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <input value={paymentForm.notes} onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
              </div>
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setPaymentModal(null)} style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
              <button onClick={savePayment} style={{ padding: '8px 18px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>Record</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Statement modal — shared with HQ Account Receivables */}
      {statementModal && (
        <CustomerStatementModal
          statement={statementModal}
          fmt={fmt}
          businessInfo={businessInfo}
          authUser={authUser}
          onOpenOrder={openOrderDetail}
          onClose={() => setStatementModal(null)}
        />
      )}

      {/* Order detail modal — opened by clicking an order# anywhere in the AR statement. */}
      {orderDetail && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid #e5e7eb' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{orderDetail.data?.order_number || 'Order'}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Sale details</p>
              </div>
              <button onClick={() => setOrderDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
            </div>
            <div style={{ padding: '18px 22px' }}>
              {orderDetail.loading && <div style={{ color: '#6b7280', fontSize: 13 }}>Loading…</div>}
              {orderDetail.error && <div style={{ color: '#dc2626', fontSize: 13 }}>{orderDetail.error}</div>}
              {orderDetail.data && (() => {
                const o = orderDetail.data;
                const items = o.items || [];
                const c = parseFloat(o.cash_received || 0);
                const b = parseFloat(o.bank_received || 0);
                const m = parseFloat(o.momo_received || 0);
                const tendered = c + b + m;
                const sale = parseFloat(o.total_amount || 0);
                const change = Math.max(0, tendered - sale);
                const credit = Math.max(0, sale - tendered);
                // v1.10.232 — derive totals from items so netQty (post-reversal)
                // and per-line discount/surcharge always reconcile. Header row's
                // frozen o.subtotal/o.discount can drift from the item state
                // after a partial reversal.
                let derivedSubtotal = 0;
                let derivedDiscountTotal = 0;
                items.forEach(it => {
                  const oq = parseFloat(it.quantity || 0);
                  const rq = parseFloat(it.reversed_quantity || 0);
                  const nq = it.reversed ? 0 : Math.max(0, oq - rq);
                  derivedSubtotal      += parseFloat(it.unit_price || 0) * nq;
                  derivedDiscountTotal += parseFloat(it.discount   || 0) * nq;
                });
                const derivedTotal = derivedSubtotal - derivedDiscountTotal;
                return (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14, fontSize: 13 }}>
                      <div><span style={{ color: '#6b7280' }}>Date: </span><strong>{(o.created_at || '').slice(0, 10)}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Customer: </span><strong>{o.customer_name || 'Walk-in'}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Cashier: </span><strong>{o.created_by_name || '—'}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Status: </span><strong>{o.status || 'Active'}</strong></div>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 14 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb' }}>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>Item</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>Qty</th>
                          <th style={{ textAlign: 'left',  padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>Unit</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>Price</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it, i) => {
                          const origQty = parseFloat(it.quantity || 0);
                          const rq      = parseFloat(it.reversed_quantity || 0);
                          const partial = !it.reversed && rq > 0;
                          const netQty  = it.reversed ? 0 : Math.max(0, origQty - rq);
                          const unitPx  = parseFloat(it.unit_price || 0);
                          const netTotal = unitPx * netQty;
                          const lineDisc = parseFloat(it.discount || 0);
                          const lineDiscTotal = lineDisc * netQty;
                          return (
                            <React.Fragment key={i}>
                              <tr style={{ borderBottom: Math.abs(lineDisc) > 0.001 ? 'none' : '1px solid #f3f4f6', opacity: it.reversed ? 0.5 : 1 }}>
                                <td style={{ padding: '7px 10px', textDecoration: it.reversed ? 'line-through' : 'none' }}>
                                  {it.product_name}
                                  {!!it.reversed && (
                                    <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#dc2626', background: '#fee2e2', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle' }}>VOID</span>
                                  )}
                                  {partial && (
                                    <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle' }}>
                                      was {origQty} {it.unit || ''} — reversed {rq}
                                    </span>
                                  )}
                                </td>
                                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: partial ? 700 : 400 }}>{netQty.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                                <td style={{ padding: '7px 10px', color: '#6b7280' }}>{it.unit || '—'}</td>
                                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace' }}>{fmt(unitPx)}</td>
                                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{fmt(netTotal)}</td>
                              </tr>
                              {Math.abs(lineDisc) > 0.001 && (
                                <tr style={{ borderBottom: '1px solid #f3f4f6', color: lineDisc > 0 ? '#6b7280' : '#2563eb', fontSize: 11, opacity: it.reversed ? 0.5 : 1 }}>
                                  <td colSpan={4} style={{ padding: '2px 10px 6px 22px' }}>
                                    {lineDisc > 0 ? 'discount' : 'surcharge'} {netQty}{it.unit ? ` ${it.unit}` : ''} × {lineDisc > 0 ? '-' : '+'}{fmt(Math.abs(lineDisc))}
                                  </td>
                                  <td style={{ padding: '2px 10px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                                    {lineDiscTotal > 0 ? '-' : '+'}{fmt(Math.abs(lineDiscTotal))}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                    {/* Totals + payment breakdown — derived from items so post-reversal figures reconcile */}
                    <div style={{ background: '#f9fafb', borderRadius: 8, padding: '12px 14px', fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ color: '#6b7280' }}>Subtotal</span><span>{fmt(derivedSubtotal)}</span>
                      </div>
                      {Math.abs(derivedDiscountTotal) > 0.001 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ color: derivedDiscountTotal > 0 ? '#dc2626' : '#2563eb' }}>
                            {derivedDiscountTotal > 0 ? 'Total discount' : 'Total surcharge'}
                          </span>
                          <span style={{ color: derivedDiscountTotal > 0 ? '#dc2626' : '#2563eb' }}>
                            {derivedDiscountTotal > 0 ? '−' : '+'}{fmt(Math.abs(derivedDiscountTotal))}
                          </span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontWeight: 700, fontSize: 14 }}>
                        <span>Total</span><span>{fmt(derivedTotal)}</span>
                      </div>
                      <div style={{ borderTop: '1px dashed #d1d5db', paddingTop: 8, marginTop: 4 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Payment</div>
                        {c > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#16a34a' }}>Cash</span><span>{fmt(c)}</span></div>}
                        {m > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#f59e0b' }}>Mobile Money</span><span>{fmt(m)}</span></div>}
                        {b > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#2563eb' }}>Bank</span><span>{fmt(b)}</span></div>}
                        {tendered === 0 && <div style={{ color: '#9ca3af' }}>Full credit — nothing tendered at till</div>}
                        {change > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, color: '#1d4ed8' }}><span>Change given</span><span>{fmt(change)}</span></div>}
                        {credit > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, color: '#dc2626', fontWeight: 700 }}><span>On credit (AR)</span><span>{fmt(credit)}</span></div>}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
            <div style={{ padding: '12px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {/* Same receipt the Sales Report prints for this order. */}
              {orderDetail.data && (
                <button
                  onClick={() => printOrderReceipt(orderDetail.data, {
                    curSym, isLiquorStyle,
                    businessName: businessInfo.business_name || 'Sosna',
                    businessAddress: businessInfo.business_address || '',
                    businessPhone: businessInfo.business_phone || '',
                  })}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600 }}>
                  <FiPrinter size={14} /> Print Receipt
                </button>
              )}
              <button onClick={() => setOrderDetail(null)} style={{ padding: '8px 18px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 7, cursor: 'pointer', fontWeight: 600 }}>Close</button>
            </div>
          </div>
        </div>
        </Portal>
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

export default AccountReceivables;
