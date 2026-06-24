import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { FiSave, FiCalendar, FiEdit2, FiPlus, FiPrinter, FiEye, FiX } from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import PaymentVoucherFormModal from '../components/PaymentVoucherFormModal';
import { getPaymentVouchers, getSettings, createCashReceipt, updateCashReceipt, checkSalesCashReceipt, getSalesCashiers, getCurrencyExchangesNet, getCurrentFxRate } from '../services/api';
import CurrencyExchangePanel from '../components/CurrencyExchangePanel';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5300/api';

const getStatus = (diff) => {
  if (diff === 0) return 'OK';
  if (diff > 0 && diff < 10) return 'Slight Surplus';
  if (diff >= 10) return 'Surplus';
  if (diff < 0 && diff > -10) return 'Slight Short';
  return 'Short';
};

const CashReport = () => {
  const { user: authUser } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [reports, setReports] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [editMode, setEditMode] = useState(false);

  // Cashier selector for the form (who this report is for)
  const [selectedCashier, setSelectedCashier] = useState('');
  const [allUsers, setAllUsers] = useState([]); // all system users for the form dropdown
  const [salesCashiers, setSalesCashiers] = useState([]); // users who made sales on selected date
  const [allSalesCashiers, setAllSalesCashiers] = useState([]); // all users who ever made sales (for history filter)

  // History filter
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1); // 1–12, 0 = all
  const [filterYear, setFilterYear]   = useState(new Date().getFullYear());   // 0 = all
  const [filterUser, setFilterUser] = useState('all');
  const [availableUsers, setAvailableUsers] = useState([]); // [{ cashier_id, full_name }]

  // v1.8.1 — triple-currency Cash Report. usd_received / fra_received /
  // k_received each hold NET cash in that currency (received minus change
  // given), in that currency's own units. Legacy keys cash/mobile_money/bank
  // are still echoed in saves for backwards compat (zeroed on the server).
  const [form, setForm] = useState({
    initial_change: '0',
    usd_received: '', fra_received: '', k_received: '',
    expenses: '',
    pending: '', total: '', after_change: '', expected: '',
    difference: '', status: 'OK', comment: ''
  });

  const [dailyRevenue, setDailyRevenue] = useState(0);
  const [daySummary, setDaySummary] = useState({ totalExpected: 0, totalCash: 0 });
  // v1.8.6 — net per-currency impact of drawer exchanges for this date+cashier.
  // Bump exchangeRefreshKey to force the CurrencyExchangePanel to re-load
  // (after every save) without remounting the whole report.
  const [exchangeNet, setExchangeNet] = useState({ usd_net: 0, fra_net: 0, k_net: 0 });
  const [exchangeRefreshKey, setExchangeRefreshKey] = useState(0);
  // v1.8.10 — current FX rates so Total can convert FRA/K into USD before
  // comparing against Expected (which is the order total_amount sum in USD).
  const [fxRate, setFxRate] = useState({ sell: 0, sellK: 0 });
  // v1.8.11 — per-currency Expected. Snapshot of what the POS says was
  // received per currency (net of change), independent of what the cashier
  // typed into the form. Difference per currency = counted − expected.
  const [expectedByCcy, setExpectedByCcy] = useState({ usd: 0, fra: 0, k: 0 });

  // Expenses list modal
  const [showExpenses, setShowExpenses] = useState(false);
  const [expensesList, setExpensesList] = useState([]);

  // Print preview
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [printExpenses, setPrintExpenses] = useState([]);
  const [businessInfo, setBusinessInfo] = useState({});

  // Voucher modal state — form lives inside the shared PaymentVoucherFormModal.
  const [showVoucher, setShowVoucher] = useState(false);

  // CR auto-creation confirmation
  const [showCRConfirm, setShowCRConfirm] = useState(false);

  useModalScrollLock(showVoucher || showExpenses || showCRConfirm);
  const [existingCR, setExistingCR] = useState(null);   // { id, receipt_number, amount }
  const [pendingCRData, setPendingCRData] = useState(null);
  const [crSaving, setCRSaving] = useState(false);

  const getToken = () => localStorage.getItem('token');

  const fetchReports = async () => {
    try {
      const res = await fetch(`${API_BASE}/cash-reports`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      setReports(Array.isArray(data) ? data : []);
    } catch (err) { setReports([]); }
  };

  const fetchUsers = async () => {
    try {
      // For filter dropdown — who has submitted cash reports
      const res = await fetch(`${API_BASE}/cash-reports/users`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      setAvailableUsers(Array.isArray(data) ? data : []);
      // For form dropdown — all system users
      const usersRes = await fetch(`${API_BASE}/users`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const usersData = await usersRes.json();
      setAllUsers(Array.isArray(usersData) ? usersData : []);
    } catch (err) { setAvailableUsers([]); }
  };

  const fetchDaily = async (d, cashierId) => {
    try {
      const cid = cashierId !== undefined ? cashierId : selectedCashier;
      // Convert the selected LOCAL date into a UTC datetime range so orders
      // (stored in UTC) get bucketed by the cashier's local "today", not the UTC date.
      const p = (n) => String(n).padStart(2, '0');
      const toSqliteUTC = (dt) => `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
      const startLocal = new Date(`${d}T00:00:00`);
      const endLocal   = new Date(`${d}T23:59:59`);
      const fromUtc = toSqliteUTC(startLocal);
      const toUtc   = toSqliteUTC(endLocal);
      const qs = `date=${d}&cashier_id=${cid}&from_utc=${encodeURIComponent(fromUtc)}&to_utc=${encodeURIComponent(toUtc)}`;
      const res = await fetch(`${API_BASE}/cash-reports/daily?${qs}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      return data;
    } catch (err) { return null; }
  };

  const fetchSalesCashiers = async (d) => {
    try {
      const res = await getSalesCashiers(d);
      const list = res.data || [];
      setSalesCashiers(list);
      if (list.length > 0) {
        const firstId = String(list[0].id);
        setSelectedCashier(firstId);
        return firstId;
      } else {
        setSelectedCashier('');
        return '';
      }
    } catch { setSalesCashiers([]); setSelectedCashier(''); return ''; }
  };

  const loadDate = async (d, cashierId) => {
    setDate(d);
    setMessage('');

    const cid = cashierId !== undefined ? cashierId : selectedCashier;
    const daily = await fetchDaily(d, cid);
    if (daily) {
      setDailyRevenue(parseFloat(daily.total_revenue || 0));
      // v1.8.11 — snapshot per-currency expected from POS (orders).
      setExpectedByCcy({
        usd: parseFloat(daily.usd_received || 0) || 0,
        fra: parseFloat(daily.fra_received || 0) || 0,
        k:   parseFloat(daily.k_received   || 0) || 0,
      });
    }

    const saved = reports.find(r => r.date && r.date.split('T')[0] === d && String(r.cashier_id ?? 0) === String(cid));
    if (saved) {
      setForm({
        initial_change: saved.initial_change || '0',
        // v1.8.1: prefer new triple-currency fields, fall back to legacy
        // cash/mobile_money/bank columns (where the same values were stored
        // before the rename).
        usd_received: saved.usd_received || saved.cash || '',
        fra_received: saved.fra_received || saved.mobile_money || '',
        k_received:   saved.k_received   || saved.bank || '',
        expenses: saved.expenses || '',
        pending: saved.pending || '',
        total: saved.total || '',
        after_change: '',
        expected: saved.expected || '',
        difference: saved.difference || '',
        status: saved.status || 'OK',
        comment: saved.comment || ''
      });
      setEditMode(false);
    } else {
      if (daily) {
        const issuedToday = parseFloat(daily.credit_sales || 0) + parseFloat(daily.pending || 0);
        setForm(prev => ({
          ...prev,
          usd_received: daily.usd_received ? parseFloat(daily.usd_received).toFixed(2) : '',
          fra_received: daily.fra_received ? parseFloat(daily.fra_received).toFixed(2) : '',
          k_received:   daily.k_received   ? parseFloat(daily.k_received).toFixed(2)   : '',
          expenses:     daily.expenses     ? parseFloat(daily.expenses).toFixed(2)     : '',
          pending:      issuedToday ? issuedToday.toFixed(2) : '',
          initial_change: '0',
          after_change: '',
          comment: '',
          status: 'OK'
        }));
      }
      setEditMode(true);
    }
  };

  useEffect(() => {
    fetchReports();
    fetchUsers();
    fetchSalesCashiers(today);
    getSalesCashiers().then(r => setAllSalesCashiers(r.data || [])).catch(() => {});
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    // v1.8.10 — load current FX so Total computes in USD-equivalent.
    getCurrentFxRate()
      .then(r => setFxRate({
        sell:  parseFloat(r.data?.sell_rate)   > 0 ? parseFloat(r.data.sell_rate)   : 0,
        sellK: parseFloat(r.data?.sell_rate_k) > 0 ? parseFloat(r.data.sell_rate_k) : 0,
      }))
      .catch(() => {});
  }, []);
  // v1.8.6 — refetch the net drawer-exchange impact for this date+cashier.
  // Bumped by the panel after every save; also re-runs on date/cashier change.
  useEffect(() => {
    if (!date) return;
    const cid = selectedCashier ? parseInt(selectedCashier) : 0;
    getCurrencyExchangesNet({ scope: 'drawer', date, cashier_id: cid })
      .then(r => setExchangeNet(r.data || { usd_net: 0, fra_net: 0, k_net: 0 }))
      .catch(() => setExchangeNet({ usd_net: 0, fra_net: 0, k_net: 0 }));
  }, [date, selectedCashier, exchangeRefreshKey]);
  useEffect(() => { if (reports.length >= 0) loadDate(date); }, [reports]); // eslint-disable-line
  useEffect(() => {
    fetchDaily(date, '0').then(all => {
      const totalExpected = parseFloat(all?.total_revenue || 0);
      // After Change was dropped from the UI (it's always identical to Total
      // since the initial-change float input is hidden). Read r.total directly
      // so this KPI is correct even for legacy reports whose saved
      // after_change was a stale 0.
      const totalCash = reports
        .filter(r => r.date && r.date.split('T')[0] === date)
        .reduce((s, r) => s + parseFloat(r.total || 0), 0);
      setDaySummary({ totalExpected, totalCash });
    }).catch(() => {});
  }, [date, reports]); // eslint-disable-line

  // v1.8.11 — no more USD-equivalent total. Each currency reconciles
  // independently: counted − expected, status per currency. The single
  // total/after_change/difference/status fields stay in form state for
  // backwards compatibility with the POST handler + history table.
  // total = sum of counted in their own units (purely informational).
  useEffect(() => {
    const ic   = parseFloat(form.initial_change) || 0;
    const usd  = parseFloat(form.usd_received)   || 0;
    const fra  = parseFloat(form.fra_received)   || 0;
    const k    = parseFloat(form.k_received)     || 0;
    const exp  = parseFloat(form.expenses)       || 0;
    const pend = parseFloat(form.pending)        || 0;
    const total = usd + pend + exp; // legacy single value, USD bucket only
    const after_change = total - ic;
    const expected = dailyRevenue;
    const diff     = after_change - expected;
    const status   = getStatus(diff);
    setForm(prev => ({ ...prev, total: total.toFixed(2), after_change: after_change.toFixed(2), expected: expected.toFixed(2), difference: diff.toFixed(2), status }));
  }, [form.initial_change, form.usd_received, form.fra_received, form.k_received, form.expenses, form.pending, dailyRevenue]); // eslint-disable-line

  const handleSave = async () => {
    if (!selectedCashier) { setMessage('Please select a cashier before saving.'); return; }
    setSaving(true);
    setMessage('');
    try {
      const ic   = parseFloat(form.initial_change) || 0;
      const usd  = parseFloat(form.usd_received)   || 0;
      const fra  = parseFloat(form.fra_received)   || 0;
      const kAmt = parseFloat(form.k_received)     || 0;
      const exp  = parseFloat(form.expenses)       || 0;
      const pend = parseFloat(form.pending)        || 0;
      // v1.8.10 — convert FRA/K to USD before summing (same as auto-calc).
      const fraAsUsd = fxRate.sell  > 0 ? fra / fxRate.sell  : 0;
      const kAsUsd   = fxRate.sellK > 0 ? kAmt / fxRate.sellK : 0;
      const total       = usd + fraAsUsd + kAsUsd + pend + exp;
      const afterChange = total - ic;
      const expected    = dailyRevenue;
      const difference  = afterChange - expected;

      const res = await fetch(`${API_BASE}/cash-reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({
          date,
          cashier_id: parseInt(selectedCashier) || 0,
          initial_change: ic,
          usd_received: usd,
          fra_received: fra,
          k_received:   kAmt,
          expenses: exp,
          pending: pend,
          total,
          after_change: afterChange,
          expected,
          difference,
          status: getStatus(difference),
          comment: form.comment
        })
      });
      if (res.ok) {
        setMessage('Report saved successfully!');
        setEditMode(false);
        await fetchReports();

        // v1.8.1 — Sosna is cash-only across 3 currencies. The CR records the
        // USD-equivalent total (cash drawer combined). FRA and K amounts are
        // tracked in the Cash Report itself; CR books the consolidated USD
        // figure so downstream ledgers (Cash Book) stay in one currency.
        const usdAmt = parseFloat(form.usd_received) || 0;
        const fraAmt = parseFloat(form.fra_received) || 0;
        const kAmt2  = parseFloat(form.k_received)   || 0;
        const totalReceipts = usdAmt + fraAmt + kAmt2;
        const paymentMethod = 'Cash';
        const status = form.status || computedStatus;
        const cashier = selectedCashier !== '0' ? allUsers.find(u => String(u.id) === String(selectedCashier)) : null;
        const receivedFrom = cashier ? `Sales / ${cashier.first_name}` : 'Sales';
        const crData = {
          date,
          payment_method: paymentMethod,
          received_from: receivedFrom,
          amount:       totalReceipts,
          cash_amount:  usdAmt,
          bank_amount:  0,
          momo_amount:  0,
          description:  form.comment ? `${status} — ${form.comment}` : status,
        };

        // Check if a Sales CR already exists for this date + cashier
        try {
          const checkRes = await checkSalesCashReceipt(date, receivedFrom);
          if (checkRes.data.exists) {
            setExistingCR(checkRes.data);
            setPendingCRData(crData);
            setShowCRConfirm(true);
          } else {
            await createCashReceipt(crData);
            setMessage('Report saved and Cash Receipt created successfully!');
          }
        } catch (crErr) {
          // CR check/create failed silently — report was already saved
        }
      } else {
        const err = await res.json();
        setMessage(err.error || 'Failed to save.');
      }
    } catch (err) {
      setMessage('Failed to save report.');
    }
    setSaving(false);
  };

  const handleConfirmUpdateCR = async () => {
    if (!existingCR || !pendingCRData) return;
    setCRSaving(true);
    try {
      await updateCashReceipt(existingCR.id, pendingCRData);
      setMessage('Report saved and Cash Receipt updated successfully!');
    } catch (err) {
      setMessage('Report saved. Failed to update Cash Receipt.');
    } finally {
      setCRSaving(false);
      setShowCRConfirm(false);
      setExistingCR(null);
      setPendingCRData(null);
    }
  };

  const handleAbortUpdateCR = () => {
    setShowCRConfirm(false);
    setExistingCR(null);
    setPendingCRData(null);
  };

  // ── Expenses list helper ───────────────────────────────────────────
  const openExpensesList = async () => {
    try {
      const res = await getPaymentVouchers({ date, paid_from: 'Cash Drawer', cashier_id: parseInt(selectedCashier) || 0 });
      setExpensesList(res.data || []);
    } catch { setExpensesList([]); }
    setShowExpenses(true);
  };

  // ── Print preview helper ───────────────────────────────────────────
  const openPrintPreview = async () => {
    let expenses = [];
    try {
      const res = await getPaymentVouchers({ date, paid_from: 'Cash Drawer', cashier_id: parseInt(selectedCashier) || 0 });
      expenses = res.data || [];
    } catch { expenses = []; }

    // Build print HTML
    const fmtV = (v) => parseFloat(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const biz = businessInfo;
    const bizName = biz.business_name || 'Business Name';
    const addr = [biz.business_address,biz.business_phone,biz.business_email].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const cashierName = salesCashiers.find(c => String(c.id) === String(selectedCashier));
    const preparedBy = cashierName ? `${cashierName.first_name} ${cashierName.last_name}` : '—';
    const diff = parseFloat(form.difference)||0;
    const status = computedStatus;
    const expenseRows = expenses.map((v,i)=>`<tr style="border-bottom:1px solid #ddd;background:${i%2===1?'#f9f9f9':'#fff'}">
      <td style="padding:7px 14px;font-family:monospace;font-size:11px">${v.voucher_number}</td>
      <td style="padding:7px 14px">${v.category}</td>
      <td style="padding:7px 14px;font-weight:500">${v.paid_to}</td>
      <td style="padding:7px 14px">${v.description||'—'}</td>
      <td style="padding:7px 14px;text-align:right;font-weight:700;font-family:monospace">$${fmtV(v.amount)}</td>
    </tr>`).join('');
    const expTotal = expenses.reduce((s,v)=>s+parseFloat(v.amount||0),0);
    const expenseSection = expenses.length>0 ? `
      <div style="border:1.5px solid #000;margin-bottom:20px">
        <div style="background:#000;padding:8px 14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Expenses — Cash Drawer</span>
          <span style="font-size:10px;color:#fff;font-weight:600">${expenses.length} voucher${expenses.length>1?'s':''}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11.5px">
          <thead><tr style="background:#f0f0f0;border-bottom:1.5px solid #000">
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Voucher No.</th>
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Category</th>
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Paid To</th>
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Description</th>
            <th style="padding:7px 14px;text-align:right;font-weight:700;font-size:10.5px">Amount</th>
          </tr></thead>
          <tbody>${expenseRows}</tbody>
          <tfoot><tr style="background:#f0f0f0;border-top:2px solid #000">
            <td colspan="4" style="padding:9px 14px;font-weight:700;text-align:right;font-size:12px">Total Expenses</td>
            <td style="padding:9px 14px;text-align:right;font-weight:800;font-size:13px;font-family:monospace">$${fmtV(expTotal)}</td>
          </tr></tfoot>
        </table>
      </div>` : '';
    const commentSection = form.comment
      ? `<div style="border:1.5px solid #000;padding:12px 14px;margin-bottom:20px">
          <div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;font-weight:700;margin-bottom:6px">Comments / Notes</div>
          <div style="font-size:12px;line-height:1.6">${form.comment}</div>
        </div>`
      : `<div style="margin-bottom:20px">
          <div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;font-weight:700;margin-bottom:8px">Comments / Notes</div>
          <div style="border-bottom:1px solid #000;height:24px"></div>
        </div>`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${bizName}</div>
          <div style="font-size:10px;line-height:1.7">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Daily Cash Report</div>
          <div style="font-size:15px;font-weight:700">${formatDateLong(date)}</div>
          ${preparedBy !== '—' ? `<div style="font-size:10px;margin-top:4px">Cashier: <strong>${preparedBy}</strong></div>` : ''}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
        <div style="border:1.5px solid #000">
          <div style="background:#000;padding:8px 14px">
            <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Cash Breakdown</span>
          </div>
          <table>
            <tbody>
              ${[['Initial Change (Float)',form.initial_change,false],
                 ['USD Cash ($)',form.usd_received,false],
                 ['FRA Cash',form.fra_received,false],
                 ['K Cash',form.k_received,false],
                 ['Credit Sales',form.pending,false],
                 ['Expenses (Cash Drawer)',form.expenses,true]
              ].map(([label,val,italic],i,arr)=>`<tr style="border-bottom:${i<arr.length-1?'1px solid #ddd':'2px solid #000'}">
                <td style="padding:9px 14px;font-size:12px;font-style:${italic?'italic':'normal'}">${label}</td>
                <td style="padding:9px 14px;text-align:right;font-weight:500;font-family:monospace;font-size:12px">${italic?'−':''}$${fmtV(val)}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot>
              <tr style="background:#f0f0f0;border-top:1px solid #000"><td style="padding:9px 14px;font-weight:700;font-size:12.5px">Total</td><td style="padding:9px 14px;text-align:right;font-weight:700;font-size:13px;font-family:monospace">$${fmtV(form.total)}</td></tr>
              <tr style="background:#e8e8e8;border-top:1px solid #000"><td style="padding:10px 14px;font-weight:700;font-size:12px">Cash on Hand (After Change)</td><td style="padding:10px 14px;text-align:right;font-weight:800;font-size:14px;font-family:monospace">$${fmtV(form.total)}</td></tr>
            </tfoot>
          </table>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="border:1.5px solid #000">
            <div style="background:#000;padding:8px 14px">
              <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Reconciliation</span>
            </div>
            <table>
              <tbody>
                <tr style="border-bottom:1px solid #ddd"><td style="padding:9px 14px;font-size:12px">Expected Revenue</td><td style="padding:9px 14px;text-align:right;font-weight:600;font-family:monospace;font-size:12px">$${fmtV(form.expected)}</td></tr>
                <tr style="border-bottom:2px solid #000"><td style="padding:9px 14px;font-size:12px">Cash on Hand</td><td style="padding:9px 14px;text-align:right;font-weight:600;font-family:monospace;font-size:12px">$${fmtV(form.total)}</td></tr>
              </tbody>
              <tfoot><tr style="background:#f0f0f0">
                <td style="padding:10px 14px;font-weight:700;font-size:13px">Difference</td>
                <td style="padding:10px 14px;text-align:right;font-weight:800;font-size:14px;font-family:monospace">${diff>=0?'+':'−'}$${fmtV(Math.abs(diff))}</td>
              </tr></tfoot>
            </table>
          </div>
          <div style="border:2px solid #000;padding:16px;text-align:center;flex:1;display:flex;flex-direction:column;justify-content:center">
            <div style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;font-weight:700">Report Status</div>
            <div style="font-size:26px;font-weight:900;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px">${status}</div>
            <div style="font-size:11.5px;font-weight:500">${diff!==0?(diff<0?'Cash short by':'Surplus of')+' <strong>$'+fmtV(Math.abs(diff))+'</strong>':'Fully balanced'}</div>
          </div>
        </div>
      </div>
      ${expenseSection}
      ${commentSection}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;padding-top:16px;border-top:2px solid #000">
        ${[['Prepared by (Cashier)',preparedBy],['Checked by',''],['Printed by',printedBy]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;margin-top:16px;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${bizName} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>{ w.print(); w.close(); },300); }
  };

  // ── Voucher modal helpers ──────────────────────────────────────────
  const openVoucherForm = () => setShowVoucher(true);

  // Called by PaymentVoucherFormModal after a successful save.
  // Refresh the daily report so the new expense total flows into the form.
  const handleVoucherSaved = async () => {
    const daily = await fetchDaily(date);
    if (daily) setForm(prev => ({ ...prev, expenses: daily.expenses || '' }));
    setEditMode(true);
  };
  // ──────────────────────────────────────────────────────────────────

  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const formatDateLong = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Always derive status from the live difference — never trust the saved status field
  const computedDiff = parseFloat(form.difference) || 0;
  const computedStatus = getStatus(computedDiff);

  const statusColor = (s) => {
    if (s === 'OK') return '#16a34a';
    if (s === 'Surplus') return '#2563eb';
    if (s === 'Slight Surplus') return '#0891b2';
    if (s === 'Slight Short') return '#d97706';
    return '#dc2626';
  };
  const statusBadge = (s) => {
    if (s === 'OK') return 'badge-green';
    if (s === 'Surplus' || s === 'Slight Surplus') return 'badge-blue';
    if (s === 'Slight Short') return 'badge-yellow';
    return 'badge-red';
  };
  const statusBg = (s) => {
    if (s === 'OK') return '#f0fdf4';
    if (s === 'Surplus') return '#eff6ff';
    if (s === 'Slight Surplus') return '#ecfeff';
    if (s === 'Slight Short') return '#fffbeb';
    return '#fef2f2';
  };
  const statusBorder = (s) => {
    if (s === 'OK') return '#86efac';
    if (s === 'Surplus') return '#93c5fd';
    if (s === 'Slight Surplus') return '#a5f3fc';
    if (s === 'Slight Short') return '#fde68a';
    return '#fca5a5';
  };

  const inputStyle = (editable) => ({
    background: editable ? '#fff' : '#f3f4f6',
    fontWeight: editable ? 400 : 600,
  });

  const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Derive unique years from saved reports for the year dropdown
  const availableYears = [...new Set(
    reports.map(r => r.date ? new Date(r.date + 'T12:00:00').getFullYear() : null).filter(Boolean)
  )].sort((a, b) => b - a);
  if (availableYears.length === 0) availableYears.push(new Date().getFullYear());

  // Apply month / year / device filter to history
  const filteredReports = reports.filter(r => {
    if (!r.date) return false;
    const d = new Date(r.date + 'T12:00:00');
    const okMonth  = filterMonth === 0 || (d.getMonth() + 1) === filterMonth;
    const okYear   = filterYear  === 0 || d.getFullYear()    === filterYear;
    const okUser = filterUser === 'all' || String(r.cashier_id ?? 0) === String(filterUser);
    return okMonth && okYear && okUser;
  });

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  return (
    <div className="page-content">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="page-header no-print">
        <div>
          <h1>{t('cashReport')}</h1>
          <p>{t('cashReportSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px' }}>
            <FiCalendar style={{ color: '#9ca3af' }} />
            <input type="date" value={date} onChange={async e => {
              const d = e.target.value;
              const firstId = await fetchSalesCashiers(d);
              loadDate(d, firstId);
            }} style={{ border: 'none', outline: 'none', fontSize: 14 }} />
          </div>
          <select
            value={selectedCashier}
            onChange={e => { setSelectedCashier(e.target.value); loadDate(date, e.target.value); }}
            style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', color: '#374151' }}
          >
            {salesCashiers.length === 0 && <option value="">{t('noSalesToday')}</option>}
            {salesCashiers.map(u => (
              <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
            ))}
          </select>
          <button
            onClick={openPrintPreview}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '9px 18px', borderRadius: 8, border: '1.5px solid #e5e7eb',
              background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#374151',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff'; }}
          >
            <FiPrinter size={16} /> {t('print')}
          </button>
        </div>
      </div>

      {/* v1.8.11 — Top USD-aggregated bar removed (Total Expected / Total
          Cash Received / Difference). Per-currency reconciliation lives in
          each currency card below. Kept the IIFE wrapping the (now empty)
          conditional in case anyone adds a per-currency summary later. */}
      {false && (() => {
        const diff = daySummary.totalCash - daySummary.totalExpected;
        const diffColor = diff === 0 ? '#6b7280' : diff > 0 ? '#16a34a' : '#dc2626';
        const fmtS = (v) => Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return (
          <div className="no-print" style={{
            display: 'flex', gap: 0, marginBottom: 16,
            border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden',
            background: '#f9fafb', fontSize: 13,
          }}>
            {[
              { label: t('totalExpectedAll'), value: `${curSym}${fmtS(daySummary.totalExpected)}`, color: '#374151', bg: '#f9fafb' },
              { label: t('totalCashReceived'), value: `${curSym}${fmtS(daySummary.totalCash)}`, color: '#374151', bg: '#f9fafb' },
              { label: t('difference'), value: `${diff >= 0 ? '+' : '−'}${curSym}${fmtS(diff)}`, color: diffColor, bg: diff === 0 ? '#f9fafb' : diff > 0 ? '#f0fdf4' : '#fef2f2' },
            ].map((item, i, arr) => (
              <div key={item.label} style={{
                flex: 1, padding: '8px 16px',
                borderRight: i < arr.length - 1 ? '1px solid #e5e7eb' : 'none',
                background: item.bg,
              }}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, marginBottom: 2 }}>{item.label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: item.color }}>{item.value}</div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* ── Cash Report Form ─────────────────────────────────────── */}
      <div className="card" id="cash-report-print" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>{t('reportFor')} {formatDate(date)}</h3>
          <div style={{ display: 'flex', gap: 8 }} className="no-print">
            {!editMode && (
              <button className="btn btn-secondary" onClick={() => setEditMode(true)}>
                <FiEdit2 /> {t('edit')}
              </button>
            )}
            {editMode && (
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                <FiSave /> {saving ? 'Saving...' : 'Save Report'}
              </button>
            )}
          </div>
        </div>

        {message && (
          <div style={{ color: message.includes('success') ? '#16a34a' : '#dc2626', marginBottom: 12, fontSize: 13 }}>
            {message}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          {/* v1.8.11 — per-currency cards. Each stays in its own currency
              end-to-end: counted (cashier input), expected (from POS),
              difference, status. No USD-equivalent conversion. */}
          {[
            { key: 'usd_received', label: 'USD Cash ($)',  ccy: 'USD', symbol: '$',  dec: 2, exp: expectedByCcy.usd, step: '0.01', color: '#16a34a' },
            { key: 'fra_received', label: 'FRA Cash',      ccy: 'FRA', symbol: '',   dec: 0, exp: expectedByCcy.fra, step: '1',    color: '#7c3aed' },
            { key: 'k_received',   label: 'K Cash',        ccy: 'K',   symbol: '',   dec: 0, exp: expectedByCcy.k,   step: '1',    color: '#ea580c' },
          ].map(c => {
            const counted = parseFloat(form[c.key] || 0) || 0;
            const diff    = counted - c.exp;
            const eps     = c.dec === 2 ? 0.01 : 1;
            const status  = Math.abs(diff) < eps ? 'OK'
                          : diff > 0 ? (diff < 10 ? 'Slight Surplus' : 'Surplus')
                          : (diff > -10 ? 'Slight Short' : 'Short');
            const isOk    = status === 'OK';
            const fmt     = (n) => `${c.symbol}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: c.dec, maximumFractionDigits: c.dec })}`;
            return (
              <div key={c.key} className="form-group" style={{ borderLeft: `4px solid ${c.color}`, paddingLeft: 10 }}>
                <label style={{ color: c.color, fontWeight: 700 }}>{c.label}</label>
                <input type="number" value={form[c.key]}
                  onChange={e => setForm({ ...form, [c.key]: e.target.value })}
                  disabled={!editMode} placeholder={c.dec === 2 ? '0.00' : '0'} step={c.step}
                  style={inputStyle(editMode)} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ color: '#6b7280' }}>Expected: <strong>{fmt(c.exp)}</strong></span>
                  <span style={{ color: isOk ? '#16a34a' : diff > 0 ? '#d97706' : '#dc2626', fontWeight: 700 }}>
                    {diff > 0 ? '+' : ''}{fmt(diff)} {status}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Expenses — read-only with + button */}
          <div className="form-group">
            <label>Expenses ({curSym})</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="number" value={form.expenses} disabled
                placeholder="0.00" step="0.01"
                style={{ background: '#f3f4f6', fontWeight: 600, flex: 1 }}
              />
              <button
                onClick={openExpensesList}
                title="View expenses"
                className="no-print"
                style={{
                  width: 34, height: 34, borderRadius: 8, border: '1.5px solid #e5e7eb', flexShrink: 0,
                  background: '#fff', color: '#6b7280', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.color = '#374151'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.color = '#6b7280'; }}
              >
                <FiEye size={15} />
              </button>
              <button
                onClick={openVoucherForm}
                disabled={!selectedCashier}
                title={!selectedCashier ? 'Select a cashier first' : 'Add expense voucher'}
                className="no-print"
                style={{
                  width: 34, height: 34, borderRadius: 8, border: 'none', flexShrink: 0,
                  background: selectedCashier ? '#2563eb' : '#d1d5db', color: '#fff',
                  cursor: selectedCashier ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: selectedCashier ? '0 2px 6px rgba(37,99,235,0.35)' : 'none',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { if (selectedCashier) e.currentTarget.style.background = '#1d4ed8'; }}
                onMouseLeave={e => { if (selectedCashier) e.currentTarget.style.background = '#2563eb'; }}
              >
                <FiPlus size={16} />
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>Credit Sales / On Account ({curSym})</label>
            <input type="number" value={form.pending}
              onChange={e => setForm({ ...form, pending: e.target.value })}
              disabled={!editMode} placeholder="0.00" step="0.01"
              style={inputStyle(editMode)} />
            <small style={{ color: '#6b7280', fontSize: 11 }}>Today's unpaid balance issued on credit (becomes receivable).</small>
          </div>
          {/* v1.8.11 — single Total/Expected/Difference/Status fields removed.
              Reconciliation lives under each currency card above. The form
              still saves total/expected/difference/status for backwards
              compat (USD-only bucket; FRA/K reconcile per-currency only). */}
          <div className="form-group" style={{ gridColumn: 'span 2' }}>
            <label>Comment</label>
            <input value={form.comment}
              onChange={e => setForm({ ...form, comment: e.target.value })}
              disabled={!editMode} placeholder="Optional notes..."
              style={inputStyle(editMode)} />
          </div>
        </div>
      </div>

      {/* v1.8.6 — Currency Exchanges for this date+cashier (drawer scope).
          Append-only ledger; reverse a mistake by recording the opposite.
          v1.8.8 — pass live drawer balance per currency so the modal can
          warn the manager before overdrawing. Balance = what's in the
          form's per-currency inputs (which already include the net effect
          of all SAVED exchanges via the auto-fill from /daily). The modal
          excludes the in-progress exchange itself, so the comparison stays
          valid. */}
      <CurrencyExchangePanel
        scope="drawer"
        date={date}
        cashierId={selectedCashier ? parseInt(selectedCashier) : 0}
        user={authUser}
        title="Currency Exchanges (Drawer)"
        drawerBalance={{
          USD: (parseFloat(form.usd_received || 0) || 0) + (parseFloat(exchangeNet.usd_net || 0) || 0),
          FRA: (parseFloat(form.fra_received || 0) || 0) + (parseFloat(exchangeNet.fra_net || 0) || 0),
          K:   (parseFloat(form.k_received   || 0) || 0) + (parseFloat(exchangeNet.k_net   || 0) || 0),
        }}
        onChanged={() => setExchangeRefreshKey(k => k + 1)}
      />
      {(exchangeNet.usd_net || exchangeNet.fra_net || exchangeNet.k_net) && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 10, fontSize: 12, color: '#5b21b6' }}>
          <strong>Net drawer impact:</strong>{' '}
          USD <span style={{ fontWeight: 700, color: exchangeNet.usd_net >= 0 ? '#16a34a' : '#dc2626' }}>
            {exchangeNet.usd_net >= 0 ? '+' : ''}${parseFloat(exchangeNet.usd_net).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          {' · '}
          FRA <span style={{ fontWeight: 700, color: exchangeNet.fra_net >= 0 ? '#16a34a' : '#dc2626' }}>
            {exchangeNet.fra_net >= 0 ? '+' : ''}{parseFloat(exchangeNet.fra_net).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          {' · '}
          K <span style={{ fontWeight: 700, color: exchangeNet.k_net >= 0 ? '#16a34a' : '#dc2626' }}>
            {exchangeNet.k_net >= 0 ? '+' : ''}{parseFloat(exchangeNet.k_net).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          <span style={{ color: '#7c3aed', marginLeft: 8 }}>
            (already factored into the auto-filled cash inputs above when applicable)
          </span>
        </div>
      )}

      {/* ── History Filter Bar ───────────────────────────────────── */}
      <div className="no-print" style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginRight: 4 }}>Filter History:</span>

        {/* Month */}
        <select
          value={filterMonth}
          onChange={e => setFilterMonth(Number(e.target.value))}
          style={{
            padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db',
            fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer',
          }}
        >
          <option value={0}>All Months</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>{m}</option>
          ))}
        </select>

        {/* Year */}
        <select
          value={filterYear}
          onChange={e => setFilterYear(Number(e.target.value))}
          style={{
            padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db',
            fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer',
          }}
        >
          <option value={0}>All Years</option>
          {availableYears.map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>

        {/* Cashier */}
        {allSalesCashiers.length > 1 && (
          <select
            value={filterUser}
            onChange={e => setFilterUser(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          >
            <option value="all">All</option>
            {allSalesCashiers.map(u => (
              <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
            ))}
          </select>
        )}

        {/* Clear */}
        {(filterMonth !== 0 || filterYear !== 0 || filterUser !== 'all') && (
          <button
            onClick={() => { setFilterMonth(0); setFilterYear(0); setFilterUser('all'); }}
            style={{
              padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb',
              fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {filteredReports.length} report{filteredReports.length !== 1 ? 's' : ''}
          {(filterMonth !== 0 || filterYear !== 0) && (
            <> — {filterMonth !== 0 ? MONTHS[filterMonth - 1] : ''}{filterMonth !== 0 && filterYear !== 0 ? ' ' : ''}{filterYear !== 0 ? filterYear : ''}</>
          )}
        </span>
      </div>

      {/* ── Report History ───────────────────────────────────────── */}
      {/* ── Summary Strip ────────────────────────────────────────── */}
      {filteredReports.length > 0 && (() => {
        const totalExpected   = filteredReports.reduce((s, r) => s + parseFloat(r.expected   || 0), 0);
        // Read r.total — see note in the day-summary effect for why.
        const totalAfterChange = filteredReports.reduce((s, r) => s + parseFloat(r.total || 0), 0);
        const totalDifference  = totalAfterChange - totalExpected;
        const diffStatus = getStatus(totalDifference);
        const summaryCards = [
          { label: 'Total Expected Cash', value: totalExpected,    color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
          { label: 'Total Cash on Hand',  value: totalAfterChange, color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
          { label: 'Total Difference',    value: totalDifference,
            color: totalDifference < 0 ? '#dc2626' : totalDifference > 0 ? '#16a34a' : '#6b7280',
            bg:    totalDifference < 0 ? '#fef2f2' : totalDifference > 0 ? '#f0fdf4' : '#f9fafb',
            border:totalDifference < 0 ? '#fecaca' : totalDifference > 0 ? '#bbf7d0' : '#e5e7eb',
            badge: diffStatus },
        ];
        return (
          <div className="no-print" style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
            {summaryCards.map(card => (
              <div key={card.label} style={{
                flex: 1, padding: '18px 22px', borderRadius: 12,
                background: card.bg, border: `1.5px solid ${card.border}`,
                boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
              }}>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
                  {card.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: card.color, letterSpacing: -0.5 }}>
                  {curSym}{Math.abs(card.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {card.badge && (
                    <span style={{
                      marginLeft: 10, fontSize: 11, fontWeight: 600,
                      padding: '2px 10px', borderRadius: 20,
                      background: card.color + '1a', color: card.color, verticalAlign: 'middle'
                    }}>{card.badge}</span>
                  )}
                </div>
                {card.label === 'Total Difference' && totalDifference !== 0 && (
                  <div style={{ fontSize: 11, color: card.color, marginTop: 4 }}>
                    {totalDifference < 0 ? '▼ Short' : '▲ Surplus'} by {curSym}{Math.abs(totalDifference).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })()}

      <div className="data-table-container no-print">
        <h3 style={{ padding: '12px 16px', fontSize: 15, fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>Report History</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th><th>Cashier</th>
              <th>USD ($)</th><th>FRA</th><th>K</th>
              <th>Expenses</th><th>Credit Sales</th><th>Total</th>
              <th>Expected</th><th>Difference</th>
              <th>Status</th><th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {filteredReports.length === 0 ? (
              <tr><td colSpan="12" style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No reports found for the selected period.</td></tr>
            ) : filteredReports.map(r => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => { const cid = r.cashier_id ? String(r.cashier_id) : ''; setSelectedCashier(cid); loadDate(r.date.split('T')[0], cid); }}>
                <td style={{ fontWeight: 500 }}>{formatDate(r.date)}</td>
                <td style={{ fontSize: 12, color: '#6b7280' }}>{r.cashier_name || '—'}</td>
                <td>${parseFloat(r.usd_received || r.cash || 0).toLocaleString()}</td>
                <td>{parseFloat(r.fra_received || r.mobile_money || 0).toLocaleString()} FRA</td>
                <td>{parseFloat(r.k_received   || r.bank || 0).toLocaleString()} K</td>
                <td style={{ color: '#dc2626' }}>{curSym}{parseFloat(r.expenses || 0).toLocaleString()}</td>
                <td>{curSym}{parseFloat(r.pending || 0).toLocaleString()}</td>
                <td style={{ fontWeight: 600 }}>{curSym}{parseFloat(r.total || 0).toLocaleString()}</td>
                <td style={{ fontWeight: 500 }}>{curSym}{parseFloat(r.expected || 0).toLocaleString()}</td>
                {(() => { const d = parseFloat(r.difference || 0); const s = getStatus(d); return (<>
                <td style={{ fontWeight: 600, color: statusColor(s) }}>{curSym}{d.toLocaleString()}</td>
                <td><span className={`badge ${statusBadge(s)}`}>{s}</span></td>
                </>); })()}
                <td style={{ color: '#6b7280', fontSize: 12, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.comment || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── New Payment Voucher Modal (shared component) ───────────────
           Paid From is locked to "Cash Drawer" since this modal is the
           cashier's end-of-day expense entry. Cashier ID is attached so
           the voucher is correctly tagged to this shift. */}
      <PaymentVoucherFormModal
        open={showVoucher}
        onClose={() => setShowVoucher(false)}
        onSaved={handleVoucherSaved}
        defaultPaidFrom="Cash Drawer"
        lockPaidFrom
        defaultDate={date}
        extraPayload={{ cashier_id: parseInt(selectedCashier) || 0 }}
      />


      {/* ── Expenses List Modal ──────────────────────────────────── */}
      {showExpenses && (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowExpenses(false)}>
          <div className="modal" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Cash Drawer Expenses — {formatDate(date)}</h3>
              <button className="modal-close" onClick={() => setShowExpenses(false)}>×</button>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              {expensesList.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#9ca3af', padding: '32px 0' }}>No expenses recorded for this date.</p>
              ) : (
                <table className="data-table" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Voucher No.</th><th>Category</th><th>Paid To</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expensesList.map(v => (
                      <tr key={v.id}>
                        <td style={{ fontWeight: 500 }}>{v.voucher_number}</td>
                        <td><span className="badge badge-gray">{v.category}</span></td>
                        <td>{v.paid_to}</td>
                        <td style={{ color: '#6b7280' }}>{v.description || '—'}</td>
                        <td style={{ textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>{curSym}{parseFloat(v.amount).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                      <td colSpan={4} style={{ textAlign: 'right' }}>Total</td>
                      <td style={{ textAlign: 'right', color: '#dc2626' }}>
                        ${expensesList.reduce((s, v) => s + parseFloat(v.amount || 0), 0).toLocaleString()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowExpenses(false)}>Close</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Print Preview ─────────────────────────────────────────── */}
      {false && showPrintPreview && (
        <div
          className="print-preview-overlay"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(15,23,42,0.85)',
            zIndex: 1000, display: 'flex', flexDirection: 'column',
            alignItems: 'center', overflowY: 'auto',
            paddingTop: 60, paddingBottom: 40,
          }}
        >
          {/* ── Preview Toolbar ── */}
          <div
            className="no-print"
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, height: 52,
              background: '#0f172a', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', padding: '0 24px', zIndex: 1001,
              borderBottom: '1px solid #1e293b',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview — Cash Report for {formatDateLong(date)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => window.print()}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '7px 20px', borderRadius: 8, border: 'none',
                  background: '#2563eb', color: '#fff', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                }}
              >
                <FiPrinter size={14} /> Print
              </button>
              <button
                onClick={() => setShowPrintPreview(false)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 16px', borderRadius: 8,
                  border: '1px solid #334155',
                  background: 'transparent', color: '#94a3b8',
                  cursor: 'pointer', fontSize: 13,
                }}
              >
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          {/* ── A4 Print Document ── */}
          <div
            id="print-document"
            style={{
              width: 794,
              background: '#ffffff',
              margin: '0 auto',
              boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
              fontFamily: '"Segoe UI", Arial, sans-serif',
              fontSize: 12,
              color: '#1a1a2e',
              flexShrink: 0,
            }}
          >
            {/* ── Document Header ── */}
            <div style={{
              background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)',
              padding: '30px 44px 24px',
              color: '#fff',
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email]
                    .filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: 10, letterSpacing: 2, textTransform: 'uppercase',
                  opacity: 0.65, marginBottom: 6,
                }}>
                  Daily Cash Report
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>
                  {formatDateLong(date)}
                </div>
              </div>
            </div>

            {/* ── Thin accent bar ── */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #ef4444, #8b5cf6)' }} />

            {/* ── Body ── */}
            <div style={{ padding: '30px 44px 36px' }}>

              {/* ── Two-column: Breakdown + Reconciliation ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>

                {/* Left — Cash Breakdown */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    background: '#f8fafc', padding: '10px 18px',
                    borderBottom: '1px solid #e2e8f0',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: '#2563eb', display: 'inline-block', flexShrink: 0,
                    }} />
                    <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>
                      Cash Breakdown
                    </span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {[
                        { label: 'Initial Change (Float)', value: form.initial_change, color: '#374151' },
                        { label: 'USD Cash ($)', value: form.usd_received, color: '#374151' },
                        { label: 'FRA Cash', value: form.fra_received, color: '#374151' },
                        { label: 'K Cash', value: form.k_received, color: '#374151' },
                        { label: 'Credit Sales (On Account)', value: form.pending, color: '#374151' },
                        { label: 'Expenses (Cash Drawer)', value: form.expenses, color: '#dc2626', italic: true },
                      ].map((row, i, arr) => (
                        <tr key={i} style={{ borderBottom: i < arr.length - 1 ? '1px solid #f1f5f9' : '2px solid #e2e8f0' }}>
                          <td style={{ padding: '9px 18px', color: row.color, fontSize: 12, fontStyle: row.italic ? 'italic' : 'normal' }}>
                            {row.label}
                          </td>
                          <td style={{ padding: '9px 18px', textAlign: 'right', fontWeight: 500, color: row.color, fontFamily: 'monospace', fontSize: 12 }}>
                            {row.color === '#dc2626' ? '−' : ''}${fmt(row.value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#f8fafc' }}>
                        <td style={{ padding: '10px 18px', fontWeight: 700, fontSize: 12.5 }}>Total</td>
                        <td style={{ padding: '10px 18px', textAlign: 'right', fontWeight: 700, fontSize: 13, fontFamily: 'monospace' }}>
                          ${fmt(form.total)}
                        </td>
                      </tr>
                      <tr style={{ background: '#eff6ff' }}>
                        <td style={{ padding: '11px 18px', fontWeight: 700, color: '#1d4ed8', fontSize: 12 }}>
                          Cash on Hand (After Change)
                        </td>
                        <td style={{ padding: '11px 18px', textAlign: 'right', fontWeight: 800, color: '#1d4ed8', fontSize: 14, fontFamily: 'monospace' }}>
                          ${fmt(form.total)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Right — Reconciliation + Status */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Reconciliation table */}
                  <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{
                      background: '#f8fafc', padding: '10px 18px',
                      borderBottom: '1px solid #e2e8f0',
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#10b981', display: 'inline-block', flexShrink: 0,
                      }} />
                      <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>
                        Reconciliation
                      </span>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '9px 18px', color: '#374151', fontSize: 12 }}>Expected Revenue</td>
                          <td style={{ padding: '9px 18px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>
                            ${fmt(form.expected)}
                          </td>
                        </tr>
                        <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                          <td style={{ padding: '9px 18px', color: '#374151', fontSize: 12 }}>Cash on Hand</td>
                          <td style={{ padding: '9px 18px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>
                            ${fmt(form.total)}
                          </td>
                        </tr>
                      </tbody>
                      <tfoot>
                        <tr style={{
                          background: statusBg(computedStatus),
                        }}>
                          <td style={{ padding: '11px 18px', fontWeight: 700, fontSize: 13 }}>Difference</td>
                          <td style={{
                            padding: '11px 18px', textAlign: 'right',
                            fontWeight: 800, fontSize: 14,
                            color: statusColor(computedStatus),
                            fontFamily: 'monospace',
                          }}>
                            {computedDiff >= 0 ? '+' : '−'}{curSym}{fmt(Math.abs(computedDiff))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Status card */}
                  <div style={{
                    padding: '18px 20px', borderRadius: 10, textAlign: 'center',
                    background: statusBg(computedStatus),
                    border: `2px solid ${statusBorder(computedStatus)}`,
                    flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
                  }}>
                    <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', color: '#64748b', marginBottom: 8, fontWeight: 600 }}>
                      Report Status
                    </div>
                    <div style={{
                      fontSize: 26, fontWeight: 900, letterSpacing: 3,
                      color: statusColor(computedStatus), textTransform: 'uppercase',
                      marginBottom: 6,
                    }}>
                      {computedStatus}
                    </div>
                    {computedDiff !== 0 ? (
                      <div style={{ fontSize: 11.5, color: statusColor(computedStatus), fontWeight: 500 }}>
                        {computedDiff < 0 ? 'Cash short by' : 'Surplus of'}&nbsp;
                        <strong>{curSym}{fmt(Math.abs(computedDiff))}</strong>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: '#16a34a', fontWeight: 500 }}>
                        Fully balanced
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Expenses Breakdown ── */}
              {printExpenses.length > 0 && (
                <div style={{ border: '1px solid #fed7aa', borderRadius: 10, overflow: 'hidden', marginBottom: 22 }}>
                  <div style={{
                    background: '#fff7ed', padding: '10px 18px',
                    borderBottom: '1px solid #fed7aa',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#f97316', display: 'inline-block',
                      }} />
                      <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#c2410c' }}>
                        Expenses Breakdown — Cash Drawer
                      </span>
                    </div>
                    <span style={{ fontSize: 10.5, color: '#c2410c', fontWeight: 600 }}>
                      {printExpenses.length} voucher{printExpenses.length > 1 ? 's' : ''}
                    </span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ background: '#fafaf9' }}>
                        {['Voucher No.', 'Category', 'Paid To', 'Description'].map(h => (
                          <th key={h} style={{ padding: '7px 18px', textAlign: 'left', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3 }}>{h}</th>
                        ))}
                        <th style={{ padding: '7px 18px', textAlign: 'right', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3 }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {printExpenses.map((v, i) => (
                        <tr key={v.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 1 ? '#fffbf7' : '#fff' }}>
                          <td style={{ padding: '8px 18px', fontWeight: 600, color: '#374151', fontFamily: 'monospace', fontSize: 11 }}>{v.voucher_number}</td>
                          <td style={{ padding: '8px 18px', color: '#374151' }}>{v.category}</td>
                          <td style={{ padding: '8px 18px', fontWeight: 500 }}>{v.paid_to}</td>
                          <td style={{ padding: '8px 18px', color: '#9ca3af' }}>{v.description || '—'}</td>
                          <td style={{ padding: '8px 18px', textAlign: 'right', color: '#dc2626', fontWeight: 700, fontFamily: 'monospace' }}>
                            ${fmt(v.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#fff7ed', borderTop: '2px solid #fed7aa' }}>
                        <td colSpan={4} style={{ padding: '10px 18px', fontWeight: 700, textAlign: 'right', color: '#9a3412', fontSize: 12 }}>
                          Total Expenses
                        </td>
                        <td style={{ padding: '10px 18px', textAlign: 'right', fontWeight: 800, color: '#dc2626', fontSize: 13, fontFamily: 'monospace' }}>
                          ${fmt(printExpenses.reduce((s, v) => s + parseFloat(v.amount || 0), 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* ── Comments ── */}
              {form.comment ? (
                <div style={{
                  border: '1px solid #e2e8f0', borderRadius: 10,
                  padding: '14px 18px', marginBottom: 26, background: '#f8fafc',
                }}>
                  <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>
                    Comments / Notes
                  </div>
                  <div style={{ fontSize: 12.5, color: '#374151', lineHeight: 1.6 }}>{form.comment}</div>
                </div>
              ) : (
                <div style={{ marginBottom: 26 }}>
                  <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>
                    Comments / Notes
                  </div>
                  <div style={{ borderBottom: '1px solid #cbd5e1', height: 24 }} />
                </div>
              )}

              {/* ── Signatures ── */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48,
                paddingTop: 20, borderTop: '1.5px solid #e2e8f0',
              }}>
                {['Prepared by (Cashier)', 'Approved by (Manager)'].map(label => (
                  <div key={label}>
                    <div style={{ fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 700, marginBottom: 22 }}>
                      {label}
                    </div>
                    {['Name', 'Signature', 'Date'].map(field => (
                      <div key={field} style={{ marginBottom: 20 }}>
                        <div style={{ borderBottom: '1px solid #94a3b8', paddingBottom: 2, marginBottom: 4, minHeight: 20 }}>&nbsp;</div>
                        <div style={{ fontSize: 9.5, color: '#94a3b8', letterSpacing: 0.3 }}>{field}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* ── Document Footer ── */}
              <div style={{
                borderTop: '1px solid #f1f5f9', marginTop: 20, paddingTop: 12,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  {businessInfo.business_name || 'Business'} — Confidential
                </span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CR Duplicate Confirmation Modal ─────────────────────── */}
      {showCRConfirm && existingCR && pendingCRData && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)', padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                ⚠
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Cash Receipt Already Exists</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{formatDate(date)}</div>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '22px 24px' }}>
              <p style={{ margin: '0 0 16px', fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
                A Cash Receipt from <strong>Sales</strong> already exists for <strong>{formatDate(date)}</strong>:
              </p>
              <div style={{ padding: '12px 16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 9, marginBottom: 16, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, color: '#1d4ed8', fontFamily: 'monospace' }}>{existingCR.receipt_number}</span>
                  <span style={{ color: '#6b7280' }}>Current amount:</span>
                  <span style={{ fontWeight: 700, color: '#1d4ed8' }}>${parseFloat(existingCR.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
              <p style={{ margin: '0 0 6px', fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
                Do you want to update it with the new amount?
              </p>
              <div style={{ padding: '10px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#15803d' }}>New amount:</span>
                  <span style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>${parseFloat(pendingCRData.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 4 }}>
                  Description: <em>{pendingCRData.description}</em>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                onClick={handleAbortUpdateCR}
                disabled={crSaving}
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
              >
                No, Keep Existing
              </button>
              <button
                onClick={handleConfirmUpdateCR}
                disabled={crSaving}
                style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: crSaving ? '#9ca3af' : '#1d4ed8', color: '#fff', cursor: crSaving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                {crSaving ? 'Updating…' : 'Yes, Update'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Print styles ─────────────────────────────────────────── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }

          /* When preview is open: print only the document */
          .print-preview-overlay {
            position: fixed !important;
            top: 0 !important; left: 0 !important;
            right: 0 !important; bottom: 0 !important;
            background: #fff !important;
            padding: 0 !important;
            overflow: visible !important;
            display: block !important;
          }
          #print-document {
            box-shadow: none !important;
            width: 100% !important;
            margin: 0 !important;
          }
        }
      `}</style>
    </div>
  );
};

export default CashReport;
