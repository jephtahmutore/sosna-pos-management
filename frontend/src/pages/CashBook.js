import React, { useState, useEffect } from 'react';
import { getCashBook, getCashBookStats, setOpeningBalance, getSettings, getSalesRangeSummary, createCashTransfer, getCashDeposits, createCashDeposit, confirmCashDeposit, rejectCashDeposit, isHqHost, getCurrentFxRate } from '../services/api';
import { useAuth } from '../context/AuthContext';
import CurrencyExchangePanel from '../components/CurrencyExchangePanel';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { FiTrendingUp, FiTrendingDown, FiDollarSign, FiEdit2, FiSave, FiX, FiPrinter, FiFilter, FiRefreshCw, FiSend, FiCheck, FiInbox } from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
const CashBook = () => {
  const { hasPermission, user: authUser } = useAuth();
  // v1.8.6 — tab toggle between the ledger view and the Exchanges ledger.
  const [activeTab, setActiveTab] = useState('ledger');
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const [stats, setStats] = useState({
    openingBalance: 0, openingByMethod: { cash: 0, bank: 0, momo: 0 },
    totalReceipts: 0, totalPV: 0, totalAP: 0, totalPayments: 0,
    currentBalance: 0, currentByMethod: { cash: 0, bank: 0, momo: 0 },
  });
  const [entries, setEntries] = useState([]);
  const [businessInfo, setBusinessInfo] = useState({});
  const [showListPrint, setShowListPrint] = useState(false);
  const [openingBal, setOpeningBal] = useState(0);
  // Per-method opening balance editor — modal with three inputs
  const [editingOB, setEditingOB] = useState(false);
  const [obInput, setObInput] = useState({ cash: '', bank: '', momo: '' });
  const [savingOB, setSavingOB] = useState(false);
  const todayStr = new Date().toISOString().split('T')[0];
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [rangeSummary, setRangeSummary] = useState({ net_profit: 0, gross_profit: 0, total_revenue: 0 });

  // Cash transfer modal
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferForm, setTransferForm] = useState({ from_method: 'Cash', to_method: 'Bank', amount: '', date: todayStr, description: '' });
  const [savingTransfer, setSavingTransfer] = useState(false);
  const [transferError, setTransferError] = useState('');

  // v1.8.57 — Branch → HQ Cash Deposit
  const isOnHq = isHqHost();
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositForm, setDepositForm] = useState({ currency: 'USD', amount: '', sell_rate: '', notes: '' });
  const [savingDeposit, setSavingDeposit] = useState(false);
  const [depositError, setDepositError] = useState('');
  const [deposits, setDeposits] = useState([]);
  const [depositFxRate, setDepositFxRate] = useState({ sell: 0, buy: 0, sellK: 0, buyK: 0 });
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(editingOB || showTransfer || showDeposit || !!rejectingId);

  const fetchData = async (f, t) => {
    try {
      const params = {};
      if (f) params.from = f;
      if (t) params.to = t;
      const [statsRes, entriesRes, rangeRes] = await Promise.all([
        getCashBookStats(params),
        getCashBook(params),
        getSalesRangeSummary(f || null, t || null),
      ]);
      if (statsRes.data) {
        setStats(statsRes.data);
        setOpeningBal(statsRes.data.openingBalance);
      }
      if (entriesRes.data) {
        setEntries(entriesRes.data.entries || []);
      }
      if (rangeRes.data) {
        setRangeSummary(rangeRes.data);
      }
    } catch (err) { /* use defaults */ }
  };

  useEffect(() => {
    fetchData(todayStr, todayStr);
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    fetchDeposits();
    // v1.8.57 — pull current FX rates so the deposit modal can default
    // the sell rate (and so amount_usd is computed correctly).
    getCurrentFxRate().then(r => {
      const d = r.data;
      if (d && d.sell_rate > 0 && d.buy_rate > 0) {
        setDepositFxRate({
          sell:  parseFloat(d.sell_rate)   || 0,
          buy:   parseFloat(d.buy_rate)    || 0,
          sellK: parseFloat(d.sell_rate_k || 0) || 0,
          buyK:  parseFloat(d.buy_rate_k  || 0) || 0,
        });
      }
    }).catch(() => {});
  }, []); // eslint-disable-line

  // v1.8.57 — Cash deposits fetch:
  //   - on a branch: only that branch's outgoing list (its own deposits)
  //   - on HQ: ALL deposits (HQ inbox sees every branch's pending)
  const fetchDeposits = async () => {
    try {
      const params = {};
      if (!isOnHq) {
        try { params.from_slug = window.location.hostname.split('.')[0]; } catch (_) { /* skip */ }
      }
      const r = await getCashDeposits(params);
      setDeposits(Array.isArray(r.data) ? r.data : []);
    } catch (_) { /* leave list as-is on transient errors */ }
  };

  const openDepositModal = () => {
    setDepositError('');
    // Default sell_rate to current rate for the chosen currency.
    const rateForUsd = ''; // USD doesn't need a rate (raw amount = USD)
    const rateForFra = depositFxRate.sell  > 0 ? String(depositFxRate.sell)  : '';
    const rateForK   = depositFxRate.sellK > 0 ? String(depositFxRate.sellK) : '';
    setDepositForm({ currency: 'USD', amount: '', sell_rate: rateForUsd, notes: '' });
    // Persist the per-currency defaults inside the modal handler:
    setDepositForm(f => ({ ...f, _ratePresets: { USD: rateForUsd, FRA: rateForFra, K: rateForK } }));
    setShowDeposit(true);
  };

  const handleSaveDeposit = async () => {
    setDepositError('');
    const amt = parseFloat(depositForm.amount || 0);
    if (!(amt > 0)) { setDepositError('Amount must be > 0'); return; }
    const sellRate = parseFloat(depositForm.sell_rate || 0) || 0;
    let amountUsd = amt;
    if (depositForm.currency !== 'USD') {
      if (!(sellRate > 0)) { setDepositError(`Sell rate for ${depositForm.currency} is required`); return; }
      amountUsd = amt / sellRate;
    }
    setSavingDeposit(true);
    try {
      const fromSlug = isOnHq ? null : (window.location.hostname.split('.')[0] || null);
      if (!fromSlug) { setDepositError('Branch not detected — cannot send deposit'); setSavingDeposit(false); return; }
      await createCashDeposit({
        from_slug: fromSlug,
        currency:  depositForm.currency,
        amount:    amt,
        amount_usd: amountUsd,
        sell_rate: depositForm.currency === 'USD' ? null : sellRate,
        notes:     depositForm.notes || null,
      });
      setShowDeposit(false);
      await fetchDeposits();
    } catch (err) {
      setDepositError(err?.response?.data?.error || 'Failed to send deposit');
    }
    setSavingDeposit(false);
  };

  const handleConfirmDeposit = async (id) => {
    if (!window.confirm('Confirm this deposit? This writes a PV on the branch and a CR on HQ.')) return;
    try {
      await confirmCashDeposit(id);
      await fetchDeposits();
      await fetchData(from || todayStr, to || todayStr); // refresh ledger
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to confirm deposit');
    }
  };

  const handleRejectDeposit = async () => {
    if (!rejectingId) return;
    try {
      await rejectCashDeposit(rejectingId, rejectReason);
      setRejectingId(null);
      setRejectReason('');
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to reject deposit');
    }
  };

  const handleFilter = () => fetchData(from, to);
  const handleClearFilter = () => { setFrom(''); setTo(''); fetchData('', ''); };

  const handleSaveTransfer = async () => {
    setTransferError('');
    const amt = parseFloat(transferForm.amount || 0);
    if (!(amt > 0)) { setTransferError('Enter an amount greater than zero.'); return; }
    if (transferForm.from_method === transferForm.to_method) { setTransferError('From and To must be different.'); return; }
    setSavingTransfer(true);
    try {
      await createCashTransfer({
        date:         transferForm.date,
        from_method:  transferForm.from_method,
        to_method:    transferForm.to_method,
        amount:       amt,
        description:  transferForm.description || null,
      });
      setShowTransfer(false);
      await fetchData(from, to);
    } catch (err) {
      setTransferError(err.response?.data?.error || 'Failed to save transfer.');
    } finally {
      setSavingTransfer(false);
    }
  };

  const handleSaveOB = async () => {
    setSavingOB(true);
    try {
      await setOpeningBalance({
        cash: parseFloat(obInput.cash || 0) || 0,
        bank: parseFloat(obInput.bank || 0) || 0,
        momo: parseFloat(obInput.momo || 0) || 0,
      });
      setEditingOB(false);
      await fetchData(from, to);
    } catch (err) { /* ignore */ }
    setSavingOB(false);
  };

  const openEditOB = () => {
    if (!window.confirm('Editing opening balances will affect all running balances in the Cash Book. Do you want to continue?')) return;
    setObInput({
      cash: String(stats.openingByMethod?.cash || 0),
      bank: String(stats.openingByMethod?.bank || 0),
      momo: String(stats.openingByMethod?.momo || 0),
    });
    setEditingOB(true);
  };

  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const totals = entries.reduce((acc, e) => ({
    receipts: acc.receipts + parseFloat(e.receipt_amount || 0),
    payments: acc.payments + parseFloat(e.payment_amount || 0)
  }), { receipts: 0, payments: 0 });

  const handlePrint = () => {
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const profit = (stats.totalReceipts || 0) - (stats.totalPV || 0) - (stats.totalAP || 0);
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dateLabel = from && to && from !== to ? `${formatDate(from)} — ${formatDate(to)}` : from ? formatDate(from) : 'All Dates';
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const chip = (label, value, bg, color, border) =>
      `<div style="padding:12px 16px;border-radius:10px;background:${bg};border:1.5px solid ${border};text-align:center">
        <div style="font-size:9.5px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${label}</div>
        <div style="font-size:16px;font-weight:800;color:${color}">${value}</div>
      </div>`;
    const chips = [
      chip('Opening Balance',    curSym+fmt(openingBal),          '#eff6ff','#1d4ed8','#bfdbfe'),
      chip('Total Receipts (CR)',curSym+fmt(stats.totalReceipts), '#f0fdf4','#16a34a','#bbf7d0'),
      chip('Total Payments (PV)',curSym+fmt(stats.totalPV),       '#fef2f2','#dc2626','#fecaca'),
      chip('Total AP (COGS)',    curSym+fmt(stats.totalAP),       '#faf5ff','#7c3aed','#e9d5ff'),
      chip('Profit',             curSym+fmt(profit),              profit>=0?'#f0fdf4':'#fef2f2', profit>=0?'#16a34a':'#dc2626', profit>=0?'#bbf7d0':'#fecaca'),
      chip('Current Balance',    curSym+fmt(stats.currentBalance),'#f8fafc','#374151','#e2e8f0'),
    ].join('');
    const obRow = `<tr style="border-bottom:1px solid #f1f5f9;background:#eff6ff">
      <td style="padding:8px 12px;color:#6b7280">—</td>
      <td style="padding:8px 12px;font-weight:700">Opening Balance</td>
      <td style="padding:8px 12px;color:#9ca3af;font-size:10px">OB</td>
      <td style="padding:8px 12px;font-weight:700;color:#1d4ed8">OB</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;color:#1d4ed8">${curSym}${fmt(openingBal)}</td>
      <td style="padding:8px 12px"></td>
      <td style="padding:8px 12px;text-align:right;font-weight:700">${curSym}${fmt(openingBal)}</td>
    </tr>`;
    const rows = entries.map((e, idx) => {
      const isAP = e.type==='AP', isPV = e.type==='PV';
      const tc = isAP?'#7c3aed':isPV?'#dc2626':'#16a34a';
      return `<tr style="border-bottom:1px solid #f1f5f9;background:${idx%2===1?'#fafafa':'#fff'}">
        <td style="padding:8px 12px;color:#374151">${formatDate(e.date)}</td>
        <td style="padding:8px 12px">${e.description||''}</td>
        <td style="padding:8px 12px;color:#9ca3af;font-size:10px">${e.reference||''}</td>
        <td style="padding:8px 12px;font-weight:700;color:${tc}">${e.type}</td>
        <td style="padding:8px 12px;text-align:right;color:#16a34a;font-weight:500">${parseFloat(e.receipt_amount)>0?curSym+fmt(e.receipt_amount):''}</td>
        <td style="padding:8px 12px;text-align:right;color:#dc2626;font-weight:500">${parseFloat(e.payment_amount)>0?curSym+fmt(e.payment_amount):''}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600">${curSym}${fmt(e.balance)}</td>
      </tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:0}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}
    </style></head><body><div style="width:794px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 100%);padding:28px 44px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${biz}</div>
          <div style="font-size:11px;opacity:0.75">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:0.65;margin-bottom:6px">Cash Book</div>
          <div style="font-size:15px;font-weight:700">${dateLabel}</div>
          <div style="font-size:10px;opacity:0.6;margin-top:4px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#f59e0b,#1d4ed8,#a855f7)"></div>
      <div style="padding:26px 44px 36px">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">${chips}</div>
        <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
          <table style="width:100%;border-collapse:collapse;font-size:11.5px">
            <thead><tr style="background:#eff6ff">
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Date</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Description</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Reference</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Type</th>
              <th style="padding:8px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Receipts</th>
              <th style="padding:8px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Payments</th>
              <th style="padding:8px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Balance</th>
            </tr></thead>
            <tbody>${obRow}${rows}</tbody>
            <tfoot><tr style="background:#eff6ff;border-top:2px solid #bfdbfe">
              <td colspan="4" style="padding:10px 12px;font-weight:700;font-size:11.5px;color:#1d4ed8">TOTALS</td>
              <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px;color:#16a34a">${curSym}${fmt(totals.receipts)}</td>
              <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px;color:#dc2626">${curSym}${fmt(totals.payments)}</td>
              <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px">${curSym}${fmt(stats.currentBalance)}</td>
            </tr></tfoot>
          </table>
        </div>
        <div style="border-top:1px solid #f1f5f9;padding-top:12px;display:flex;justify-content:space-between">
          <span style="font-size:9.5px;color:#cbd5e1">${biz} — Confidential</span>
          <span style="font-size:9.5px;color:#cbd5e1">Printed: ${printedAt}</span>
        </div>
      </div>
    </div></body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };
  const _handlePrint = () => {
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bizName = businessInfo.business_name || 'Business Name';
    const printedAt = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dateLabel = from && to && from !== to ? `${formatDate(from)} — ${formatDate(to)}` : from ? formatDate(from) : 'All Dates';
    const profit = (stats.totalReceipts || 0) - (stats.totalPV || 0) - (stats.totalAP || 0);
    const obRow = `<tr><td>—</td><td><b>Opening Balance</b></td><td></td><td style="text-align:center">OB</td><td style="text-align:right;font-weight:600;color:#2563eb">${curSym}${fmt(openingBal)}</td><td></td><td style="text-align:right;font-weight:600">${curSym}${fmt(openingBal)}</td></tr>`;
    const rows = entries.map(e => {
      const isAP = e.type === 'AP';
      const isPV = e.type === 'PV';
      const typeColor = isAP ? '#7c3aed' : isPV ? '#dc2626' : '#16a34a';
      return `<tr>
        <td>${formatDate(e.date)}</td>
        <td>${e.description || ''}</td>
        <td style="font-size:10px;color:#6b7280">${e.reference || ''}</td>
        <td style="text-align:center;font-weight:700;color:${typeColor}">${e.type}</td>
        <td style="text-align:right;color:#16a34a;font-weight:500">${parseFloat(e.receipt_amount) > 0 ? curSym + fmt(e.receipt_amount) : ''}</td>
        <td style="text-align:right;color:#dc2626;font-weight:500">${parseFloat(e.payment_amount) > 0 ? curSym + fmt(e.payment_amount) : ''}</td>
        <td style="text-align:right;font-weight:600">${curSym}${fmt(e.balance)}</td>
      </tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:15mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:11px;color:#1f2937}
      .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:3px solid #1e3a5f;margin-bottom:16px}
      .hdr-left .biz{font-size:20px;font-weight:900;color:#1e3a5f;letter-spacing:0.3px}
      .hdr-left .sub{font-size:10px;color:#6b7280;margin-top:4px}
      .hdr-right{text-align:right}
      .hdr-right .title{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b7280;margin-bottom:4px}
      .hdr-right .dates{font-size:13px;font-weight:700;color:#1e3a5f}
      .hdr-right .printed{font-size:9px;color:#9ca3af;margin-top:3px}
      .stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px}
      .stat{border:1.5px solid #d1d5db;border-radius:6px;padding:8px 12px}
      .stat-lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:3px}
      .stat-val{font-size:13px;font-weight:800}
      table{width:100%;border-collapse:collapse;font-size:10.5px}
      th{border:1px solid #d1d5db;padding:7px 9px;text-align:left;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
      td{border:1px solid #e5e7eb;padding:6px 9px}
      .tot-row td{font-weight:700;border-top:2px solid #1e3a5f}
      .ft{margin-top:16px;display:flex;justify-content:space-between;font-size:9px;color:#9ca3af}
    </style></head><body>
      <div class="hdr">
        <div class="hdr-left">
          <div class="biz">${bizName}</div>
          <div class="sub">Cash Book Report</div>
        </div>
        <div class="hdr-right">
          <div class="title">Cash Book</div>
          <div class="dates">${dateLabel}</div>
          <div class="printed">Printed: ${printedAt}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-lbl">Opening Balance</div><div class="stat-val" style="color:#2563eb">${curSym}${fmt(openingBal)}</div></div>
        <div class="stat"><div class="stat-lbl">Total Receipts (CR)</div><div class="stat-val" style="color:#16a34a">${curSym}${fmt(stats.totalReceipts)}</div></div>
        <div class="stat"><div class="stat-lbl">Total Payments (PV)</div><div class="stat-val" style="color:#dc2626">${curSym}${fmt(stats.totalPV)}</div></div>
        <div class="stat"><div class="stat-lbl">Total AP (COGS)</div><div class="stat-val" style="color:#7c3aed">${curSym}${fmt(stats.totalAP)}</div></div>
        <div class="stat"><div class="stat-lbl">Profit</div><div class="stat-val" style="color:${profit >= 0 ? '#16a34a' : '#dc2626'}">${curSym}${fmt(profit)}</div></div>
        <div class="stat"><div class="stat-lbl">Current Balance</div><div class="stat-val">${curSym}${fmt(stats.currentBalance)}</div></div>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th style="text-align:center">Type</th><th style="text-align:right">Receipts</th><th style="text-align:right">Payments</th><th style="text-align:right">Balance</th></tr></thead>
        <tbody>${obRow}${rows}</tbody>
        <tfoot><tr class="tot-row"><td colspan="4" style="text-align:right">TOTALS</td><td style="text-align:right;color:#16a34a">${curSym}${fmt(totals.receipts)}</td><td style="text-align:right;color:#dc2626">${curSym}${fmt(totals.payments)}</td><td style="text-align:right">${curSym}${fmt(stats.currentBalance)}</td></tr></tfoot>
      </table>
      <div class="ft"><span>${bizName} — Confidential</span><span>Printed: ${printedAt}</span></div>
    </body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('cashBookTitle')}</h1>
          <p>{t('cashBookSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => { setTransferError(''); setTransferForm(f => ({ ...f, amount: '', description: '', date: todayStr })); setShowTransfer(true); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiRefreshCw size={15} /> {t('transfer')}
          </button>
          {/* v1.8.57 — Branch: button to send a deposit. HQ doesn't need this
              (HQ doesn't deposit to itself — it receives). */}
          {!isOnHq && (
            <button
              onClick={openDepositModal}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#d97706', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
            >
              <FiSend size={15} /> Deposit to HQ
            </button>
          )}
          <button
            onClick={handlePrint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiPrinter size={15} /> {t('print')}
          </button>
        </div>
      </div>

      {/* v1.8.6 — Tab strip: Ledger (existing entries view) vs Exchanges. */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'ledger',    label: 'Ledger' },
          { key: 'exchanges', label: 'Exchanges' },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 22px', border: 'none', background: 'none',
              cursor: 'pointer', fontSize: 14, fontWeight: 700,
              color: activeTab === tab.key ? '#2563eb' : '#6b7280',
              borderBottom: activeTab === tab.key ? '3px solid #2563eb' : '3px solid transparent',
              marginBottom: -2, transition: 'color 0.15s',
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'exchanges' && (
        <CurrencyExchangePanel
          scope="book"
          from={from}
          to={to}
          user={authUser}
          title="Currency Exchanges (Cash Book)"
        />
      )}

      {activeTab === 'ledger' && (<>

      {/* v1.8.57 — Cash Deposits panel.
          On branch: shows own outgoing deposits with status.
          On HQ: inbox with Confirm / Reject actions on PENDING rows. */}
      {deposits.length > 0 && (() => {
        const fmt = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const pendingCount = deposits.filter(d => d.status === 'PENDING').length;
        return (
          <div style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <FiInbox size={16} color="#92400e" />
              <strong style={{ fontSize: 13, color: '#92400e' }}>
                {isOnHq ? `Pending Deposits from Branches${pendingCount > 0 ? ` (${pendingCount})` : ''}` : `Your Deposits to HQ${pendingCount > 0 ? ` — ${pendingCount} pending` : ''}`}
              </strong>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: '#fffbeb' }}>
                  <tr>
                    <th style={{ padding: '6px 10px', textAlign: 'left',  fontWeight: 700, color: '#92400e' }}>Deposit #</th>
                    {isOnHq && <th style={{ padding: '6px 10px', textAlign: 'left',  fontWeight: 700, color: '#92400e' }}>From</th>}
                    <th style={{ padding: '6px 10px', textAlign: 'left',  fontWeight: 700, color: '#92400e' }}>Currency</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, color: '#92400e' }}>Amount</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, color: '#92400e' }}>≈ USD</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left',  fontWeight: 700, color: '#92400e' }}>Notes</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left',  fontWeight: 700, color: '#92400e' }}>Status</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left',  fontWeight: 700, color: '#92400e' }}>Date</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, color: '#92400e' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.map(d => {
                    const statusColor = d.status === 'CONFIRMED' ? '#16a34a' : d.status === 'REJECTED' ? '#dc2626' : '#d97706';
                    const statusBg    = d.status === 'CONFIRMED' ? '#dcfce7' : d.status === 'REJECTED' ? '#fee2e2' : '#fef3c7';
                    return (
                      <tr key={d.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11 }}>{d.deposit_number}</td>
                        {isOnHq && <td style={{ padding: '6px 10px' }}>{d.from_name || d.from_slug}</td>}
                        <td style={{ padding: '6px 10px', fontWeight: 700 }}>{d.currency}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>
                          {d.currency === 'USD' ? fmt(d.amount) : `${Math.round(parseFloat(d.amount || 0)).toLocaleString()} ${d.currency}`}
                        </td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: '#6b7280' }}>{fmt(d.amount_usd)}</td>
                        <td style={{ padding: '6px 10px', color: '#6b7280' }}>{d.notes || '—'}</td>
                        <td style={{ padding: '6px 10px' }}>
                          <span style={{ padding: '2px 8px', background: statusBg, color: statusColor, borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                            {d.status}
                          </span>
                        </td>
                        <td style={{ padding: '6px 10px', color: '#6b7280' }}>{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                          {isOnHq && d.status === 'PENDING' && (
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button onClick={() => handleConfirmDeposit(d.id)}
                                style={{ padding: '4px 10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <FiCheck size={11} /> Confirm
                              </button>
                              <button onClick={() => { setRejectingId(d.id); setRejectReason(''); }}
                                style={{ padding: '4px 10px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <FiX size={11} /> Reject
                              </button>
                            </div>
                          )}
                          {d.status === 'REJECTED' && d.reject_reason && (
                            <span style={{ fontSize: 11, color: '#b91c1c', fontStyle: 'italic' }}>{d.reject_reason}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Date Filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('from')}:</label>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('to')}:</label>
        <input type="date" value={to} onChange={e => setTo(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        <button onClick={handleFilter}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: 'none', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <FiFilter size={13} /> {t('filter')}
        </button>
        {(from || to) && (
          <button onClick={handleClearFilter}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', backgroundColor: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13 }}>
            <FiX size={13} /> {t('clear')}
          </button>
        )}
      </div>

      {/* Four cards: Cash & Cash Equivalents (umbrella, read-only) + Cash on Hand, Mobile Money, Cash at Bank.
          Per-method cards expose the opening-balance editor when no date filter is active. */}
      <div className="stat-cards">
        <div className="stat-card purple">
          <div className="stat-icon"><FiDollarSign /></div>
          <div>
            <div className="stat-label">{t('cashAndEquivalents')}</div>
            <div className="stat-value">{hasPermission('CashBook:View') ? `${curSym}${(stats.currentBalance || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'}</div>
            <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{t('opening')} {curSym}{(stats.openingBalance || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
        </div>

        {/* v1.8.8 — per-currency balances (USD / FRA / K) for Sosna.
            Backend still keys data on cash/bank/momo bucket names — we just
            remap them to currencies: cash→USD, bank→FRA, momo→K. The
            underlying balance math will be reworked to be truly per-currency
            once PVs/CRs/APs all consistently write to the new usd/fra/k
            columns added in v1.8.5. */}
        {[
          { key: 'cash', label: 'USD ($)', defaultClass: 'green' },
          { key: 'bank', label: 'FRA',     defaultClass: 'purple' },
          { key: 'momo', label: 'K',       defaultClass: 'orange' },
        ].map(m => {
          const bal  = stats.currentByMethod?.[m.key] || 0;
          const open = stats.openingByMethod?.[m.key] || 0;
          const isNegative = bal < -0.001;
          return (
            <div key={m.key} className={`stat-card ${isNegative ? 'red' : m.defaultClass}`}>
              <div className="stat-icon"><FiDollarSign /></div>
              <div>
                <div className="stat-label">{m.label}</div>
                <div className="stat-value">{hasPermission('CashBook:View') ? `${curSym}${bal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'}</div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{t('opening')} {curSym}{open.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Activity strip — compact secondary cards. Opening Balance + period totals.
          Opening Balance is editable only when no date filter is active (i.e. after Clear) — matches Butchery behavior
          for adjusting the install-time opening. Day-to-day, opening keeps reflecting yesterday's running balance. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
        {[
          { key: 'opening',  label: t('openingBalance'),  value: stats.openingBalance, color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
          { key: 'receipts', label: t('receiptsCR'),      value: stats.totalReceipts,  color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
          { key: 'payments', label: t('paymentsPV'),      value: stats.totalPV,        color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
          { key: 'ap',       label: t('supplierPaidAP'),  value: stats.totalAP,        color: '#7c3aed', bg: '#faf5ff', border: '#e9d5ff' },
        ].map(c => {
          const canEditOpening = c.key === 'opening' && !from && !to && hasPermission('CashBook:Edit');
          return (
            <div key={c.key} style={{ background: c.bg, border: `1.5px solid ${c.border}`, borderRadius: 10, padding: '10px 14px', position: 'relative' }}>
              <div style={{ fontSize: 10.5, letterSpacing: 0.5, textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>{c.label}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: c.color, marginTop: 3 }}>
                {hasPermission('CashBook:View')
                  ? `${curSym}${parseFloat(c.value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'N/A'}
              </div>
              {canEditOpening && (
                <button onClick={openEditOB}
                  title="Edit opening balances (USD / FRA / K)"
                  style={{ position: 'absolute', top: 8, right: 8, background: '#fff', border: `1px solid ${c.border}`, borderRadius: 6, padding: '4px 6px', cursor: 'pointer', color: c.color }}>
                  <FiEdit2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Opening Balance editor modal — three inputs */}
      {editingOB && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0 }}>Opening Balances</h3>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Starting balance per currency (USD / FRA / K) — used as the base for the Cash Book.</div>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 12 }}>
              {[
                { key: 'cash', label: 'USD ($)', color: '#16a34a' },
                { key: 'bank', label: 'FRA',     color: '#7c3aed' },
                { key: 'momo', label: 'K',       color: '#ea580c' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 12, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4, display: 'block' }}>{f.label}</label>
                  <input type="number" min="0" step="0.01"
                    value={obInput[f.key]}
                    onChange={e => setObInput(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder="0.00"
                    style={{ width: '100%', padding: '9px 12px', border: `2px solid ${parseFloat(obInput[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, boxSizing: 'border-box' }} />
                </div>
              ))}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setEditingOB(false)} style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSaveOB} disabled={savingOB}
                style={{ padding: '8px 18px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                {savingOB ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('date')}</th><th>{t('description')}</th><th>{t('reference')}</th><th>{t('type')}</th>
              <th style={{ color: '#16a34a' }}>{t('receipts')}</th>
              <th style={{ color: '#dc2626' }}>{t('payments')}</th><th>{t('balance')}</th>
            </tr>
          </thead>
          <tbody>
            {/* Opening Balance row */}
            <tr style={{ background: '#f0f9ff' }}>
              <td style={{ fontWeight: 500 }}>—</td>
              <td style={{ fontWeight: 600 }}>{t('openingBalance')}</td>
              <td style={{ color: '#9ca3af', fontSize: 12 }}>OB</td>
              <td></td>
              <td style={{ color: '#2563eb', fontWeight: 600 }}>{curSym}{openingBal.toLocaleString()}</td>
              <td></td>
              <td style={{ fontWeight: 600 }}>{curSym}{openingBal.toLocaleString()}</td>
            </tr>
            {entries.map(e => {
              const isAP = e.type === 'AP';
              const isCR = e.type === 'CR';
              return (
                <tr key={e.id} style={isAP ? { background: '#faf5ff' } : isCR ? { background: '#f0fdf4' } : {}}>
                  <td>{formatDate(e.date)}</td>
                  <td style={{ fontWeight: 500 }}>{e.description}</td>
                  <td style={{ color: '#9ca3af', fontSize: 12 }}>{e.reference}</td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                      background: isAP ? '#ede9fe' : isCR ? '#dcfce7' : '#fee2e2',
                      color: isAP ? '#7c3aed' : isCR ? '#16a34a' : '#dc2626'
                    }}>
                      {e.type}
                    </span>
                  </td>
                  <td style={{ color: '#16a34a', fontWeight: e.receipt_amount > 0 ? 500 : 400 }}>
                    {e.receipt_amount > 0 ? `${curSym}${parseFloat(e.receipt_amount).toLocaleString()}` : ''}
                  </td>
                  <td style={{ color: isAP ? '#7c3aed' : '#dc2626', fontWeight: e.payment_amount > 0 ? 500 : 400 }}>
                    {e.payment_amount > 0 ? `${curSym}${parseFloat(e.payment_amount).toLocaleString()}` : ''}
                  </td>
                  <td style={{ fontWeight: 600 }}>{curSym}{(parseFloat(parseFloat(e.balance))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr><td colSpan="7" style={{ textAlign: 'center', color: '#9ca3af', padding: 24 }}>No transactions yet. Create Cash Receipts, Payment Vouchers, or AP Payments.</td></tr>
            )}
            <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
              <td colSpan="4" style={{ textAlign: 'right' }}>TOTALS:</td>
              <td style={{ color: '#16a34a' }}>{curSym}{totals.receipts.toLocaleString()}</td>
              <td style={{ color: '#dc2626' }}>{curSym}{totals.payments.toLocaleString()}</td>
              <td style={{ color: stats.currentBalance >= 0 ? '#16a34a' : '#dc2626' }}>{curSym}{stats.currentBalance.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* ── CashBook List Print Overlay ─────────────────────────────── */}
      {false && showListPrint && (() => {
        const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const profit = (stats.totalReceipts || 0) - (stats.totalPV || 0) - (stats.totalAP || 0);
        const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const dateLabel = from && to && from !== to ? `${formatDate(from)} — ${formatDate(to)}` : from ? formatDate(from) : 'All Dates';
        return (
          <div className="pv-print-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}>
            <div className="no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <FiPrinter size={16} style={{ color: '#64748b' }} />
                <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Print Preview — Cash Book ({entries.length} entries)</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#1d4ed8', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}><FiPrinter size={14} /> Print</button>
                <button onClick={() => setShowListPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}><FiX size={14} /> Close</button>
              </div>
            </div>

            <div id="cb-list-document" style={{ width: 794, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}>
              {/* Header */}
              <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>{businessInfo.business_name || 'Business Name'}</div>
                  <div style={{ fontSize: 11, opacity: 0.75 }}>{[businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ')}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Cash Book</div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{dateLabel}</div>
                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {printedAt}</div>
                </div>
              </div>
              {/* Rainbow divider */}
              <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #1d4ed8, #a855f7)' }} />

              <div style={{ padding: '26px 44px 36px' }}>
                {/* Stat chips — 3 cols x 2 rows */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
                  {[
                    { label: 'Opening Balance',   value: curSym + fmt(openingBal),          bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
                    { label: 'Total Receipts (CR)',value: curSym + fmt(stats.totalReceipts), bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
                    { label: 'Total Payments (PV)',value: curSym + fmt(stats.totalPV),       bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
                    { label: 'Total AP (COGS)',    value: curSym + fmt(stats.totalAP),       bg: '#faf5ff', color: '#7c3aed', border: '#e9d5ff' },
                    { label: 'Profit',             value: curSym + fmt(profit),              bg: profit >= 0 ? '#f0fdf4' : '#fef2f2', color: profit >= 0 ? '#16a34a' : '#dc2626', border: profit >= 0 ? '#bbf7d0' : '#fecaca' },
                    { label: 'Current Balance',    value: curSym + fmt(stats.currentBalance),bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  ].map(chip => (
                    <div key={chip.label} style={{ padding: '12px 16px', borderRadius: 10, background: chip.bg, border: `1.5px solid ${chip.border}`, textAlign: 'center' }}>
                      <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{chip.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: chip.color }}>{chip.value}</div>
                    </div>
                  ))}
                </div>

                {/* Table */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ background: '#eff6ff' }}>
                        {['Date', 'Description', 'Reference', 'Type', 'Receipts', 'Payments', 'Balance'].map((h, i) => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: i >= 4 ? 'right' : 'left', fontWeight: 600, color: '#1d4ed8', borderBottom: '1px solid #bfdbfe', fontSize: 10.5, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ borderBottom: '1px solid #f1f5f9', background: '#eff6ff' }}>
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>—</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>Opening Balance</td>
                        <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10 }}>OB</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700, color: '#1d4ed8' }}>OB</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: '#1d4ed8' }}>{curSym}{fmt(openingBal)}</td>
                        <td style={{ padding: '8px 12px' }} />
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{curSym}{fmt(openingBal)}</td>
                      </tr>
                      {entries.map((e, idx) => {
                        const isAP = e.type === 'AP'; const isPV = e.type === 'PV';
                        const typeColor = isAP ? '#7c3aed' : isPV ? '#dc2626' : '#16a34a';
                        return (
                          <tr key={e.id || idx} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                            <td style={{ padding: '8px 12px', color: '#374151' }}>{formatDate(e.date)}</td>
                            <td style={{ padding: '8px 12px' }}>{e.description || ''}</td>
                            <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10 }}>{e.reference || ''}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, color: typeColor }}>{e.type}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#16a34a', fontWeight: 500 }}>{parseFloat(e.receipt_amount) > 0 ? curSym + fmt(e.receipt_amount) : ''}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#dc2626', fontWeight: 500 }}>{parseFloat(e.payment_amount) > 0 ? curSym + fmt(e.payment_amount) : ''}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>{curSym}{fmt(e.balance)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#eff6ff', borderTop: '2px solid #bfdbfe' }}>
                        <td colSpan={4} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#1d4ed8' }}>TOTALS</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, color: '#16a34a' }}>{curSym}{fmt(totals.receipts)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, color: '#dc2626' }}>{curSym}{fmt(totals.payments)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13 }}>{curSym}{fmt(stats.currentBalance)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} — Confidential</span>
                  <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {printedAt}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      </>)}{/* end activeTab === 'ledger' wrapper (v1.8.6) */}

      {/* Cash Transfer Modal — moves money between Cash / Bank / Mobile Money buckets */}
      {showTransfer && (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowTransfer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h2>Cash Transfer</h2>
              <button className="modal-close" onClick={() => setShowTransfer(false)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 14 }}>
                Move money between cash buckets. Your total cash on hand stays the same — only the breakdown shifts.
              </p>

              {(() => {
                const methodKey = (m) => m === 'Cash' ? 'cash' : m === 'Bank' ? 'bank' : 'momo';
                const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const fromCur  = parseFloat(stats.currentByMethod?.[methodKey(transferForm.from_method)] || 0);
                const toCur    = parseFloat(stats.currentByMethod?.[methodKey(transferForm.to_method)]   || 0);
                const amt      = parseFloat(transferForm.amount || 0) || 0;
                const fromAfter = fromCur - amt;
                const toAfter   = toCur   + amt;
                const showAfter = amt > 0;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>From *</label>
                      <select value={transferForm.from_method} onChange={e => setTransferForm({ ...transferForm, from_method: e.target.value })}>
                        <option value="Cash">Cash</option>
                        <option value="Bank">Bank</option>
                        <option value="Mobile Money">Mobile Money</option>
                      </select>
                      <small style={{ color: '#6b7280', fontSize: 11, display: 'block', marginTop: 4 }}>
                        Current: <strong>{curSym}{fmt(fromCur)}</strong>
                      </small>
                      {showAfter && (
                        <small style={{ color: fromAfter < 0 ? '#dc2626' : '#0f766e', fontSize: 11, fontWeight: 600, display: 'block', marginTop: 2 }}>
                          After: {curSym}{fmt(fromAfter)} {fromAfter < 0 ? '⚠ overdraft' : ''}
                        </small>
                      )}
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>To *</label>
                      <select value={transferForm.to_method} onChange={e => setTransferForm({ ...transferForm, to_method: e.target.value })}>
                        <option value="Cash">Cash</option>
                        <option value="Bank">Bank</option>
                        <option value="Mobile Money">Mobile Money</option>
                      </select>
                      <small style={{ color: '#6b7280', fontSize: 11, display: 'block', marginTop: 4 }}>
                        Current: <strong>{curSym}{fmt(toCur)}</strong>
                      </small>
                      {showAfter && (
                        <small style={{ color: '#0f766e', fontSize: 11, fontWeight: 600, display: 'block', marginTop: 2 }}>
                          After: {curSym}{fmt(toAfter)}
                        </small>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div className="form-group">
                <label>Amount ({curSym}) *</label>
                <input type="number" min="0" step="0.01" placeholder="0.00"
                  value={transferForm.amount}
                  onChange={e => setTransferForm({ ...transferForm, amount: e.target.value })} />
              </div>

              <div className="form-group">
                <label>Date</label>
                <input type="date" max={todayStr}
                  value={transferForm.date}
                  onChange={e => setTransferForm({ ...transferForm, date: e.target.value })} />
              </div>

              <div className="form-group">
                <label>Description (optional)</label>
                <input type="text" placeholder="e.g. ATM withdrawal, MoMo cash-in"
                  value={transferForm.description}
                  onChange={e => setTransferForm({ ...transferForm, description: e.target.value })} />
              </div>

              {transferError && (
                <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{transferError}</div>
              )}

              <div style={{ padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12, color: '#1e40af', lineHeight: 1.5, marginBottom: 14 }}>
                <strong>Effect:</strong> {transferForm.from_method} {curSym}{(parseFloat(parseFloat(transferForm.amount || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} → {transferForm.to_method}.
                Cash Book total unchanged; per-method cards on top will reflect the move.
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setShowTransfer(false)} style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
                <button onClick={handleSaveTransfer} disabled={savingTransfer}
                  style={{ padding: '10px 28px', background: savingTransfer ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: savingTransfer ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
                  <FiSave style={{ marginRight: 4, verticalAlign: 'middle' }} />
                  {savingTransfer ? 'Saving...' : 'Save Transfer'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* v1.8.57 — Deposit to HQ modal (branch side) */}
      {showDeposit && (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowDeposit(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <FiSend size={18} /> Deposit to HQ
              </h2>
              <button className="modal-close" onClick={() => setShowDeposit(false)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 14 }}>
                Record cash being sent to HQ. Stays PENDING until HQ confirms receipt — on confirm, a PV is posted here and a CR at HQ.
              </p>
              <div className="form-row">
                <div className="form-group">
                  <label>Currency</label>
                  <select value={depositForm.currency}
                    onChange={e => {
                      const ccy = e.target.value;
                      const preset = depositForm._ratePresets || {};
                      setDepositForm({ ...depositForm, currency: ccy, sell_rate: preset[ccy] || '' });
                    }}>
                    <option value="USD">USD ($)</option>
                    <option value="FRA">FRA</option>
                    <option value="K">K (Kwacha)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Amount ({depositForm.currency})</label>
                  <input type="number" min="0" step="0.01" value={depositForm.amount}
                    onChange={e => setDepositForm({ ...depositForm, amount: e.target.value })}
                    placeholder="0.00" autoFocus />
                </div>
              </div>
              {depositForm.currency !== 'USD' && (
                <div className="form-group">
                  <label>Sell rate ({depositForm.currency} per $1)</label>
                  <input type="number" min="0" step="0.01" value={depositForm.sell_rate}
                    onChange={e => setDepositForm({ ...depositForm, sell_rate: e.target.value })}
                    placeholder="0.00" />
                  {parseFloat(depositForm.amount || 0) > 0 && parseFloat(depositForm.sell_rate || 0) > 0 && (
                    <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
                      ≈ {curSym}{(parseFloat(depositForm.amount) / parseFloat(depositForm.sell_rate)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  )}
                </div>
              )}
              <div className="form-group">
                <label>Notes (optional)</label>
                <input value={depositForm.notes}
                  onChange={e => setDepositForm({ ...depositForm, notes: e.target.value })}
                  placeholder="Courier / driver / reference" />
              </div>
              {depositError && (
                <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12, fontWeight: 600 }}>
                  {depositError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={() => setShowDeposit(false)}
                  style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  Cancel
                </button>
                <button onClick={handleSaveDeposit} disabled={savingDeposit}
                  style={{ padding: '10px 28px', background: savingDeposit ? '#9ca3af' : '#d97706', color: '#fff', border: 'none', borderRadius: 8, cursor: savingDeposit ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FiSend size={14} />
                  {savingDeposit ? 'Sending...' : 'Send Deposit'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* v1.8.57 — Reject reason modal (HQ side) */}
      {rejectingId && (
        <Portal>
        <div className="modal-overlay" onClick={() => setRejectingId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2>Reject Deposit</h2>
              <button className="modal-close" onClick={() => setRejectingId(null)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>
                Tell the branch why you're rejecting (cash short, never arrived, wrong amount, etc.).
              </p>
              <div className="form-group">
                <label>Reason</label>
                <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                  placeholder="Cash count was short by $50" autoFocus />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={() => setRejectingId(null)}
                  style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  Cancel
                </button>
                <button onClick={handleRejectDeposit}
                  style={{ padding: '10px 28px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FiX size={14} /> Reject
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  );
};

export default CashBook;
