import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccountPayables, getAccountPayableStats, getSupplierBreakdown, updateApPayment, deleteApPayment, getSettings, getApPayments } from '../services/api';
import ApPaymentFormModal from '../components/ApPaymentFormModal';
import { FiDollarSign, FiAlertCircle, FiUsers, FiTrendingDown, FiX, FiChevronRight, FiPrinter, FiEdit2, FiSave, FiTrash2 } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { matchTokens } from '../utils/tokenSearch';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';

const getStatusBadge = (status) => {
  const map = { 'Paid': 'badge-green', 'Partial': 'badge-orange', 'Unpaid': 'badge-red', 'No Purchases': 'badge-gray' };
  return map[status] || 'badge-gray';
};

const AccountPayables = () => {
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [stats, setStats] = useState({ totalPurchases: 0, totalPaid: 0, outstanding: 0, suppliers: 0, unpaidCount: 0 });
  const [payables, setPayables] = useState([]);
  const [businessInfo, setBusinessInfo] = useState({});
  const [showListPrint, setShowListPrint] = useState(false);
  const [payModal, setPayModal] = useState(null);
  // form/saving/error are owned by the shared ApPaymentFormModal component.
  const [breakdown, setBreakdown] = useState(null);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);
  const [editingPayment, setEditingPayment] = useState(null); // { id, amount, date, description, paid_from }
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!breakdown || !!payModal);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('payables');     // payables | payments
  const [apPayments, setApPayments] = useState([]);
  const [paymentSearch, setPaymentSearch] = useState('');
  // Date filter — default to first..last day of the current month (period view)
  const _today = new Date();
  const _firstOfMonth = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-01`;
  const _todayStr = _today.toISOString().split('T')[0];
  // Default to All Time so suppliers with older-than-current-month GRNs don't
  // silently disappear from the list and the Outstanding total reflects what
  // they actually owe (not just this-month activity). User can still narrow
  // via the date pickers or the "This Month" button.
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  // v1.10.310 — supplier-name search (client-side, case-insensitive contains).
  // Applies to both Payables + Payments lists. Empty string = show all.
  const [supplierSearch, setSupplierSearch] = useState('');
  // v1.10.310 — per-modal date filter (independent from the page-level filter
  // that scopes which suppliers appear). Empty = show all transactions.
  // Opening balance is derived from all activity BEFORE modalFrom so the
  // running balance stays truthful when the window is narrowed.
  const [modalFrom, setModalFrom] = useState('');
  const [modalTo,   setModalTo]   = useState('');

  const { hasPermission, user: authUser } = useAuth();

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = async () => {
    try {
      const params = { from: filterFrom || undefined, to: filterTo || undefined };
      const [statsRes, payablesRes, paymentsRes] = await Promise.all([
        getAccountPayableStats(params), getAccountPayables(params), getApPayments(params),
      ]);
      if (statsRes.data) setStats(statsRes.data);
      setPayables(payablesRes.data || []);
      setApPayments(Array.isArray(paymentsRes.data) ? paymentsRes.data : []);
    } catch (err) { /* use defaults */ }
  };

  useEffect(() => {
    fetchData();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, [filterFrom, filterTo]); // eslint-disable-line

  // Opening the Record Payment modal — the modal component owns its own
  // form state. We just pass the supplier context in.
  const openPayModal = (supplier) => setPayModal(supplier);
  const handlePaymentSaved = () => {
    fetchData();
    showToast('Payment recorded successfully.');
  };

  const openBreakdown = async (supplier) => {
    setLoadingBreakdown(true);
    setBreakdown({ supplier, grns: [], payments: [] });
    // v1.10.310 — clear the per-modal date filter on open so we start
    // wide. User can narrow via the modal's date inputs.
    setModalFrom('');
    setModalTo('');
    try {
      const res = await getSupplierBreakdown(supplier.id);
      // v1.10.313 — backend /breakdown returns raw suppliers row which
      // has no `currency` column on Sosna. Inherit the list row's
      // aggregated `p.currency` (K/USD/FRA), so the statement modal
      // formats amounts in the supplier's currency instead of falling
      // back to the tenant's default '$' on HQ. Same fix reason as
      // v1.10.311, but the derivation is on the client because the
      // /breakdown endpoint doesn't compute it.
      const data = res.data || {};
      if (data.supplier && supplier.currency && !data.supplier.currency) {
        data.supplier = { ...data.supplier, currency: supplier.currency };
      }
      setBreakdown(data);
    } catch (e) { /* keep empty */ }
    setLoadingBreakdown(false);
  };

  const handleSaveEdit = async () => {
    if (!editingPayment.amount || parseFloat(editingPayment.amount) <= 0) { setEditError('Enter a valid amount.'); return; }
    if (!window.confirm('Are you sure you want to update this record?')) return;
    setEditSaving(true);
    setEditError('');
    try {
      // v1.10.230 — send k_amount alongside amount so the Cash Book (which
      // reads AP payments from k_amount, not amount) reflects the edit.
      // Inline edit only changes the total number; we treat the whole
      // payment as K here — matches the current inline-edit surface which
      // doesn't expose the tri-currency mix. If a full mix edit is needed,
      // it should use the ApPaymentFormModal (POST) flow, not this inline row.
      const newAmt = parseFloat(editingPayment.amount);
      await updateApPayment(editingPayment.id, {
        amount: newAmt,
        k_amount: newAmt,
        date: editingPayment.date,
        description: editingPayment.description,
        paid_from: editingPayment.paid_from,
      });
      setEditingPayment(null);
      // Refresh breakdown
      const res = await getSupplierBreakdown(breakdown.supplier.id || breakdown.supplier.supplier_id);
      setBreakdown(res.data);
      fetchData();
      showToast('Payment updated successfully.');
    } catch (err) {
      setEditError(err.response?.data?.error || 'Failed to update payment.');
    } finally {
      setEditSaving(false);
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeletePayment = (paymentId) => {
    setPendingDelete({
      subject: 'AP payment',
      perform: async () => {
        try {
          await deleteApPayment(paymentId);
          const res = await getSupplierBreakdown(breakdown.supplier.id || breakdown.supplier.supplier_id);
          setBreakdown(res.data);
          fetchData();
          showToast('Payment deleted.', 'error');
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to delete payment.');
        }
      },
    });
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

  const handleBreakdownPrint = () => {
    if (!breakdown) return;
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const supplierName = breakdown.supplier?.supplier_name || breakdown.supplier?.name || '';
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';

    // v1.10.312 — print mirrors the on-screen STATEMENT view (single
    // chronological table with Debit / Credit / signed Balance).
    // Uses supplier's own currency (matches on-screen fmtSup helper).
    const supCcy    = String(breakdown.supplier?.currency || '').toUpperCase();
    const supSym    = supCcy === 'K' ? 'K' : supCcy === 'FRA' ? '' : supCcy === 'USD' ? '$' : (curSym || 'K');
    const supSuffix = supCcy === 'FRA' ? ' FRA' : '';
    const supDigits = supCcy === 'K' || supCcy === 'FRA' ? 0 : 2;
    const fmtSup    = (v) => `${supSym}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: supDigits, maximumFractionDigits: supDigits })}${supSuffix}`;

    // Build merged event list, apply the same modal window filter if set
    const allEvs = [
      ...(breakdown.grns || []).map(g => ({
        kind: 'INV', doc: g.grn_number, date: g.date,
        reference: (g.supplier_invoice_number || g.invoice_number || g.notes) ? `INV# ${g.supplier_invoice_number || g.invoice_number || g.notes}` : '', debit: parseFloat(g.total_amount) || 0, credit: 0,
        sortKey: g.date + ' 0',
      })),
      ...(breakdown.payments || []).map(p => ({
        kind: 'PAY', doc: p.payment_number, date: p.date,
        reference: p.description || '', debit: 0, credit: -(parseFloat(p.amount) || 0),
        sortKey: p.date + ' 1',
      })),
      ...(breakdown.credits || []).map(cn => ({
        kind: 'CN', doc: cn.credit_note_number, date: cn.date,
        reference: `${cn.reason}${cn.reference ? ' · ' + cn.reference : ''}`,
        debit: 0, credit: -(parseFloat(cn.amount) || 0),
        sortKey: cn.date + ' 2',
      })),
    ].sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

    const inRange = (d) => (!modalFrom || d >= modalFrom) && (!modalTo || d <= modalTo);
    const preWindow = allEvs.filter(e => modalFrom && e.date < modalFrom);
    const evs = allEvs.filter(e => inRange(e.date));
    const openingBalance = preWindow.reduce((s, e) => s + e.debit + e.credit, 0);
    let running = openingBalance;
    const rows = evs.map(ev => { running += ev.debit + ev.credit; return { ...ev, balance: running }; });
    const totalDebit  = evs.reduce((s, e) => s + e.debit, 0);
    const totalCredit = evs.reduce((s, e) => s + e.credit, 0);
    const finalBal    = openingBalance + totalDebit + totalCredit;

    // Age analysis on outstanding (positive-balance invoices only)
    const today = new Date();
    const daysBetween = (d) => Math.floor((today - new Date(d)) / 86400000);
    let ageBuckets = { current: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0 };
    if (finalBal > 0.01) {
      const invQ = (breakdown.grns || []).map(g => ({ date: g.date, remain: parseFloat(g.total_amount) || 0 }));
      let pool = -totalCredit + Math.max(0, -openingBalance);
      invQ.sort((a, b) => a.date.localeCompare(b.date));
      for (const inv of invQ) {
        if (pool <= 0) break;
        const take = Math.min(pool, inv.remain);
        inv.remain -= take; pool -= take;
      }
      for (const inv of invQ) {
        if (inv.remain < 0.01) continue;
        const d = daysBetween(inv.date);
        if (d <= 30)       ageBuckets.current += inv.remain;
        else if (d <= 60)  ageBuckets.b31_60 += inv.remain;
        else if (d <= 90)  ageBuckets.b61_90 += inv.remain;
        else if (d <= 120) ageBuckets.b91_120 += inv.remain;
        else               ageBuckets.b120plus += inv.remain;
      }
    }

    const windowLabel = modalFrom || modalTo ? `${modalFrom || '—'} to ${modalTo || '—'}` : 'All time';

    const pillStyle = (kind) => {
      const bg = kind === 'INV' ? '#fee2e2' : kind === 'PAY' ? '#dcfce7' : '#dbeafe';
      const fg = kind === 'INV' ? '#991b1b' : kind === 'PAY' ? '#166534' : '#1d4ed8';
      return `background:${bg};color:${fg};padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700`;
    };

    const openingRow = (modalFrom || modalTo) && Math.abs(openingBalance) > 0.001 ? `
      <tr style="background:#fefce8;border-bottom:1px solid #fde68a">
        <td colspan="4" style="padding:6px 10px;font-style:italic;color:#a16207">Opening balance (carried over from before ${modalFrom || 'start'})</td>
        <td></td><td></td>
        <td style="padding:6px 10px;text-align:right;font-weight:700;color:${openingBalance > 0.01 ? '#dc2626' : openingBalance < -0.01 ? '#16a34a' : '#000'}">${openingBalance < 0 ? '−' : ''}${fmtSup(openingBalance)}</td>
      </tr>` : '';

    const bodyRows = rows.length === 0
      ? `<tr><td colspan="7" style="padding:20px;text-align:center;color:#9ca3af">No transactions in this window.</td></tr>`
      : rows.map(r => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:5px 9px;color:#374151;white-space:nowrap">${formatDate(r.date)}</td>
          <td style="padding:5px 9px;color:#6b7280;font-family:monospace;font-size:9.5px">${r.doc}</td>
          <td style="padding:5px 9px"><span style="${pillStyle(r.kind)}">${r.kind}</span></td>
          <td style="padding:5px 9px;color:#6b7280">${r.reference || '—'}</td>
          <td style="padding:5px 9px;text-align:right;font-family:monospace;color:${r.debit > 0 ? '#dc2626' : '#d1d5db'}">${r.debit > 0 ? `+${fmtSup(r.debit)}` : ''}</td>
          <td style="padding:5px 9px;text-align:right;font-family:monospace;color:${r.credit === 0 ? '#d1d5db' : r.kind === 'PAY' ? '#16a34a' : '#0369a1'}">${r.credit < 0 ? `−${fmtSup(r.credit)}` : ''}</td>
          <td style="padding:5px 9px;text-align:right;font-family:monospace;font-weight:600;color:${r.balance > 0.01 ? '#dc2626' : r.balance < -0.01 ? '#16a34a' : '#000'}">${r.balance < 0 ? '−' : ''}${fmtSup(r.balance)}</td>
        </tr>`).join('');

    const ageHtml = finalBal > 0.01 ? `
      <div style="margin-top:16px;padding:10px 14px;border:1.5px solid #000">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Age analysis (as of today)</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;font-size:10px;text-align:center">
          ${[['Current',ageBuckets.current],['31-60',ageBuckets.b31_60],['61-90',ageBuckets.b61_90],['91-120',ageBuckets.b91_120],['120+',ageBuckets.b120plus]].map(([l,v]) => `
            <div style="border:1px solid #ddd;padding:6px;background:${v > 0.01 ? '#fef2f2' : '#fff'}">
              <div style="font-size:9px;color:#6b7280;font-weight:600">${l}</div>
              <div style="font-size:11px;font-weight:700;color:${v > 0.01 ? '#dc2626' : '#9ca3af'};font-family:monospace">${fmtSup(v)}</div>
            </div>`).join('')}
        </div>
      </div>` : '';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Statement — ${supplierName}</title>
      <style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:6px 10px;font-weight:700;color:#000;border-bottom:2px solid #000;font-size:10px;background:#f0f0f0;text-align:left}
      tfoot td{padding:7px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
      </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Statement</div>
          <div style="font-size:18px;font-weight:800;margin-bottom:3px">${biz}</div>
          <div style="font-size:9.5px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:8px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Supplier</div>
          <div style="font-size:14px;font-weight:700">${supplierName}</div>
          ${breakdown.supplier?.phone ? `<div style="font-size:9px;margin-top:2px">${breakdown.supplier.phone}</div>` : ''}
          <div style="font-size:9px;margin-top:2px">Statement Date: ${formatDate(new Date().toISOString().slice(0,10))}</div>
          <div style="font-size:9px">Window: ${windowLabel}</div>
        </div>
      </div>

      <div style="font-size:9px;color:#6b7280;margin-bottom:10px">
        Convention: invoices in Debit (+), payments + CNs in Credit (−). Balance is signed: positive = you owe supplier, negative = supplier owes you.
      </div>

      <div style="border:1.5px solid #000;margin-bottom:14px">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Doc #</th><th>Type</th><th>Reference</th>
              <th style="text-align:right;color:#dc2626">Debit (+)</th>
              <th style="text-align:right;color:#0369a1">Credit (−)</th>
              <th style="text-align:right">Balance</th>
            </tr>
          </thead>
          <tbody>
            ${openingRow}
            ${bodyRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4" style="text-align:right">Totals</td>
              <td style="text-align:right;color:#dc2626">+${fmtSup(totalDebit)}</td>
              <td style="text-align:right;color:#0369a1">−${fmtSup(totalCredit)}</td>
              <td style="text-align:right;color:${finalBal > 0.01 ? '#dc2626' : finalBal < -0.01 ? '#16a34a' : '#000'}">${finalBal < 0 ? '−' : ''}${fmtSup(finalBal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style="border:2px solid #000;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-weight:700;font-size:13px">${finalBal > 0.01 ? 'You owe supplier:' : finalBal < -0.01 ? 'Supplier owes you (credit balance):' : 'Account is square:'}</span>
        <span style="font-weight:800;font-size:17px;color:${finalBal > 0.01 ? '#dc2626' : finalBal < -0.01 ? '#16a34a' : '#000'}">${fmtSup(finalBal)}</span>
      </div>

      ${ageHtml}

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:26px;margin-bottom:14px">
        ${[['Prepared By',''],['Checked By',''],['Printed By',printedBy]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:5px">${label}</div>
            <div style="font-size:10px;font-weight:600;min-height:16px;margin-bottom:5px">${name}</div>
            <div style="height:28px;border-bottom:1.5px solid #000;margin-bottom:3px"></div>
            <div style="font-size:8px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:6px;display:flex;justify-content:space-between">
        <span style="font-size:8px">${biz} — Confidential</span>
        <span style="font-size:8px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const handlePrint = () => {
    const fmt = (v) => parseFloat(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const rows = payables.map((p,idx) => `
      <tr style="border-bottom:1px solid #ddd;background:${idx%2===1?'#f9f9f9':'#fff'}">
        <td style="padding:8px 10px;font-size:10.5px">${idx+1}</td>
        <td style="padding:8px 10px;font-weight:700">${p.supplier_name}</td>
        <td style="padding:8px 10px">${p.phone||'—'}</td>
        <td style="padding:8px 10px;text-align:center">${p.grn_count}</td>
        <td style="padding:8px 10px;text-align:right">${curSym}${fmt(p.total_purchases)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${curSym}${fmt(p.total_paid)}</td>
        <td style="padding:8px 10px;text-align:right;color:${parseFloat(p.total_credits||0)>0?'#0369a1':'#9ca3af'}">${parseFloat(p.total_credits||0)>0?(curSym+fmt(p.total_credits)):'—'}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700">${curSym}${fmt(Math.abs(parseFloat(p.balance) || 0))}${parseFloat(p.balance) > 0.01 ? ' (owed)' : parseFloat(p.balance) < -0.01 ? ' (advance)' : ''}</td>
        <td style="padding:8px 10px">${p.status}</td>
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
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Account Payables</div>
          <div style="font-size:15px;font-weight:700">Supplier Ledger</div>
          <div style="font-size:9px;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[
          ['Total Purchases','K'+fmt(stats.totalPurchases)],
          ['Total Paid','K'+fmt(stats.totalPaid)],
          ...(parseFloat(stats.totalCredits||0) > 0 ? [['Credits','K'+fmt(stats.totalCredits)]] : []),
          ['Outstanding','K'+fmt(stats.outstanding)],
          ['Suppliers',stats.suppliers]
        ].map(([lbl,val])=>`
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:15px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <table style="font-size:11.5px">
          <thead><tr>
            <th style="width:28px">#</th><th>Supplier</th><th>Phone</th><th>GRNs</th>
            <th style="text-align:right">Purchases</th><th style="text-align:right">Paid</th>
            <th style="text-align:right">Credits</th>
            <th style="text-align:right">Balance</th><th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td colspan="4">TOTAL — ${payables.length} Supplier${payables.length!==1?'s':''}</td>
            <td style="text-align:right">K${fmt(stats.totalPurchases)}</td>
            <td style="text-align:right">K${fmt(stats.totalPaid)}</td>
            <td style="text-align:right">K${fmt(stats.totalCredits||0)}</td>
            <td style="text-align:right;font-size:13px">K${fmt(stats.outstanding)}</td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By',''],['Checked By',''],['Printed By',printedBy]].map(([label,name])=>`
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

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('accountPayablesTitle')}</h1>
          <p>{t('accountPayablesSubtitle')}</p>
        </div>
        <button onClick={handlePrint} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
          <FiPrinter size={15} /> {t('print')}
        </button>
      </div>

      {/* Top stat cards. Outstanding is split into TWO cards (what we still owe vs what we've overpaid)
          so a tenant with both situations doesn't see a confusing net number like "−5,000 Outstanding". */}
      {(() => {
        // backend `p.balance` convention: positive = we still owe; negative = we overpaid.
        const outstandingOnly = payables.reduce((s, p) => s + Math.max(0,  parseFloat(p.balance) || 0), 0);
        const overPaidOnly    = payables.reduce((s, p) => s + Math.max(0, -(parseFloat(p.balance) || 0)), 0);
        return (
          <div className="stat-cards">
            <div className="stat-card red">
              <div className="stat-icon"><FiDollarSign /></div>
              <div><div className="stat-label">{t('totalPurchases')}</div><div className="stat-value">{hasPermission('AccountPayables:View') ? `${curSym}${stats.totalPurchases.toLocaleString()}` : 'N/A'}</div></div>
            </div>
            <div className="stat-card green">
              <div className="stat-icon"><FiTrendingDown /></div>
              <div><div className="stat-label">{t('totalPaid')}</div><div className="stat-value">{hasPermission('AccountPayables:View') ? `${curSym}${stats.totalPaid.toLocaleString()}` : 'N/A'}</div></div>
            </div>
            <div className="stat-card orange">
              <div className="stat-icon"><FiAlertCircle /></div>
              <div><div className="stat-label">{t('outstanding')}</div><div className="stat-value">{hasPermission('AccountPayables:View') ? `${outstandingOnly > 0.01 ? '−' : ''}${curSym}${outstandingOnly.toLocaleString()}` : 'N/A'}</div></div>
            </div>
            {overPaidOnly > 0.01 && (
              <div className="stat-card green" style={{ background: 'linear-gradient(135deg,#16a34a,#15803d)' }}>
                <div className="stat-icon"><FiTrendingDown /></div>
                <div><div className="stat-label">{t('overPaid')}</div><div className="stat-value">{hasPermission('AccountPayables:View') ? `${curSym}${overPaidOnly.toLocaleString()}` : 'N/A'}</div></div>
              </div>
            )}
            {parseFloat(stats.totalCredits || 0) > 0.01 && (
              <div className="stat-card" style={{ background: 'linear-gradient(135deg,#0ea5e9,#0369a1)', color: '#fff' }}>
                <div className="stat-icon"><FiTrendingDown /></div>
                <div>
                  <div className="stat-label">Credit Notes</div>
                  <div className="stat-value">{hasPermission('AccountPayables:View') ? `${curSym}${parseFloat(stats.totalCredits).toLocaleString()}` : 'N/A'}</div>
                </div>
              </div>
            )}
            <div className="stat-card purple">
              <div className="stat-icon"><FiUsers /></div>
              <div><div className="stat-label">{t('suppliers')}</div><div className="stat-value">{hasPermission('AccountPayables:View') ? stats.suppliers : 'N/A'}</div></div>
            </div>
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
        {/* Quick presets */}
        <button onClick={() => { setFilterFrom(_firstOfMonth); setFilterTo(_todayStr); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #bfdbfe', fontSize: 12, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>
          {t('thisMonth')}
        </button>
        <button onClick={() => { setFilterFrom(''); setFilterTo(''); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
          {t('allTime')}
        </button>
        {/* v1.10.310 — supplier search. Filters the Payables + Payments
            lists client-side; doesn't refetch. Clears the box shows all. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>🔍</span>
          <input
            type="text"
            value={supplierSearch}
            onChange={e => setSupplierSearch(e.target.value)}
            placeholder="Search supplier..."
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', minWidth: 200 }}
          />
          {supplierSearch && (
            <button onClick={() => setSupplierSearch('')}
              title="Clear search"
              style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#f9fafb', color: '#6b7280', cursor: 'pointer', fontSize: 11 }}>
              ×
            </button>
          )}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
          {filterFrom || filterTo
            ? `${filterFrom || '—'} ${t('to')} ${filterTo || '—'}`
            : t('showingAllTime')}
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'payables', label: t('payables') },
          { key: 'payments', label: t('payments') },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '10px 18px', background: 'none', border: 'none',
              borderBottom: tab === t.key ? '3px solid #1d4ed8' : '3px solid transparent',
              color: tab === t.key ? '#1d4ed8' : '#6b7280',
              fontWeight: tab === t.key ? 700 : 500, fontSize: 13.5,
              cursor: 'pointer', marginBottom: -2,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'payables' && (
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('supplier')}</th><th>{t('phone')}</th><th>GRNs</th><th>{t('totalPurchases')}</th>
              <th>{t('totalPaid')}</th><th>Credits</th><th>{t('balance')}</th><th>{t('lastGRN')}</th><th>{t('status')}</th><th>{t('action')}</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // v1.10.310 — client-side search filter (case-insensitive contains on supplier_name).
              const q = supplierSearch.trim().toLowerCase();
              const filtered = q
                ? payables.filter(p => String(p.supplier_name || '').toLowerCase().includes(q))
                : payables;
              if (payables.length === 0) {
                return <tr><td colSpan="10" style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>{t('noSuppliersInLedger')}</td></tr>;
              }
              if (filtered.length === 0) {
                return <tr><td colSpan="10" style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No supplier matches "{supplierSearch}".</td></tr>;
              }
              return filtered.map(p => (
              <tr key={p.id}>
                <td>
                  <button onClick={() => openBreakdown(p)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, color: '#2563eb', fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {p.supplier_name} <FiChevronRight size={13} />
                  </button>
                </td>
                <td style={{ color: '#6b7280' }}>{p.phone || '—'}</td>
                <td style={{ textAlign: 'center' }}>{p.grn_count}</td>
                {(() => {
                  // v1.10.79 — display each supplier's totals in THEIR
                  // currency (returned per-row by the backend). Falls
                  // back to the tenant's primary symbol if the currency
                  // field isn't present (older clients / edge case).
                  const ccy = String(p.currency || '').toUpperCase();
                  const sym = ccy === 'K' ? 'K' : ccy === 'FRA' ? '' : ccy === 'USD' ? '$' : curSym;
                  const suffix = ccy === 'FRA' ? ' FRA' : '';
                  const digits = ccy === 'K' || ccy === 'FRA' ? 0 : 2;
                  const fmtCcy = (v) => `${sym}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
                  const bal = -parseFloat(p.balance || 0);
                  return (
                    <>
                      <td>{fmtCcy(parseFloat(p.total_purchases))}</td>
                      <td style={{ color: '#16a34a' }}>{fmtCcy(parseFloat(p.total_paid))}</td>
                      <td style={{ color: parseFloat(p.total_credits || 0) > 0 ? '#0369a1' : '#9ca3af' }}>
                        {parseFloat(p.total_credits || 0) > 0 ? fmtCcy(parseFloat(p.total_credits)) : '—'}
                      </td>
                      <td style={{ color: bal > 0.01 ? '#16a34a' : bal < -0.01 ? '#dc2626' : '#374151', fontWeight: 600 }}>
                        {bal < 0 ? '−' : ''}{fmtCcy(bal)}
                      </td>
                    </>
                  );
                })()}
                <td>{formatDate(p.last_grn_date)}</td>
                <td><span className={`badge ${getStatusBadge(p.status)}`}>{p.status}</span></td>
                <td>
                  <button
                    onClick={() => openPayModal(p)}
                    style={{ padding: '5px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                  >
                    {t('pay')}
                  </button>
                </td>
              </tr>
              ));
            })()}
          </tbody>
        </table>
      </div>
      )}

      {tab === 'payments' && (
        <>
          <div style={{ marginBottom: 12 }}>
            <input type="text" placeholder={t('searchBySupplierOrRef')} value={paymentSearch}
              onChange={e => setPaymentSearch(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
          </div>
          <div className="data-table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('date')}</th><th>{t('reference')}</th><th>{t('supplier')}</th>
                  <th>{t('paidFrom')}</th><th>{t('description')}</th>
                  <th style={{ textAlign: 'right' }}>{t('amount')}</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = apPayments.filter(p => matchTokens(
                    paymentSearch,
                    p.supplier_name_resolved, p.supplier_name,
                    p.payment_number, p.description
                  ));
                  if (rows.length === 0) {
                    return <tr><td colSpan="6" style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No payments recorded.</td></tr>;
                  }
                  const total = rows.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
                  return <>
                    {rows.map(p => (
                      <tr key={p.id}>
                        <td>{formatDate(p.date)}</td>
                        <td style={{ color: '#6b7280', fontSize: 12 }}>{p.payment_number || '—'}</td>
                        <td style={{ fontWeight: 600 }}>{p.supplier_name_resolved || p.supplier_name || '—'}</td>
                        <td style={{ color: '#6b7280' }}>{p.paid_from || '—'}</td>
                        <td style={{ color: '#6b7280' }}>{p.description || '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>K{parseFloat(p.amount).toLocaleString()}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                      <td colSpan="5">TOTAL — {rows.length} payment(s)</td>
                      <td style={{ textAlign: 'right', color: '#16a34a' }}>K{total.toLocaleString()}</td>
                    </tr>
                  </>;
                })()}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Breakdown Modal */}
      {breakdown && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 1200, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{breakdown.supplier?.supplier_name || breakdown.supplier?.name}</h2>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Supplier account breakdown</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={handleBreakdownPrint} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  <FiPrinter size={13} /> Print
                </button>
                <button onClick={() => setBreakdown(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
              </div>
            </div>

            <div style={{ padding: '18px 24px' }}>
              {loadingBreakdown ? (
                <div style={{ textAlign: 'center', color: '#6b7280', padding: 32 }}>Loading...</div>
              ) : (
                <>
                  {/* v1.10.310 — Statement view: single chronological table
                      with Debit(+) / Credit(−) / signed running Balance.
                      Matches the supplier's paper statement (SVSPRO / Sage /
                      etc.): invoices land in Debit column as positive,
                      payments + CNs land in Credit column as negative,
                      Balance is a running cumulative that shows who owes who
                      at every row. */}
                  {(() => {
                    // v1.10.311 — read the supplier's currency (K/USD/FRA)
                    // from breakdown.supplier so the statement renders in
                    // THEIR currency, matching the AP list column and the
                    // paper statement they'd expect. HQ's `curSym` defaults
                    // to '$' when the tenant's currency context isn't set,
                    // which is why the modal was showing '$' for Kwacha
                    // suppliers.
                    const supCcy    = String(breakdown.supplier?.currency || '').toUpperCase();
                    const supSym    = supCcy === 'K' ? 'K' : supCcy === 'FRA' ? '' : supCcy === 'USD' ? '$' : (curSym || 'K');
                    const supSuffix = supCcy === 'FRA' ? ' FRA' : '';
                    const supDigits = supCcy === 'K' || supCcy === 'FRA' ? 0 : 2;
                    const fmtSup    = (v) => `${supSym}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: supDigits, maximumFractionDigits: supDigits })}${supSuffix}`;

                    // Build merged event list (grn + payment + credit_note)
                    const allEvs = [
                      ...(breakdown.grns || []).map(g => ({
                        kind: 'INV', doc: g.grn_number, date: g.date,
                        reference: (g.supplier_invoice_number || g.invoice_number || g.notes) ? `INV# ${g.supplier_invoice_number || g.invoice_number || g.notes}` : '', debit: parseFloat(g.total_amount) || 0, credit: 0,
                        sortKey: g.date + ' 0',
                      })),
                      ...(breakdown.payments || []).map(p => ({
                        kind: 'PAY', doc: p.payment_number, date: p.date,
                        reference: p.description || '', debit: 0,
                        credit: -(parseFloat(p.amount) || 0),
                        sortKey: p.date + ' 1', raw: p,
                      })),
                      ...(breakdown.credits || []).map(cn => ({
                        kind: 'CN', doc: cn.credit_note_number, date: cn.date,
                        reference: `${cn.reason}${cn.reference ? ' · ' + cn.reference : ''}`,
                        debit: 0, credit: -(parseFloat(cn.amount) || 0),
                        sortKey: cn.date + ' 2',
                      })),
                    ].sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

                    // v1.10.310 — apply per-modal date filter. Everything BEFORE
                    // modalFrom becomes the opening balance for the window; only
                    // rows within [modalFrom, modalTo] appear in the table.
                    const inRange = (d) => (!modalFrom || d >= modalFrom) && (!modalTo || d <= modalTo);
                    const preWindow = allEvs.filter(e => modalFrom && e.date < modalFrom);
                    const evs = allEvs.filter(e => inRange(e.date));
                    const openingBalance = preWindow.reduce((s, e) => s + e.debit + e.credit, 0);

                    // Walk with running balance starting from opening
                    let running = openingBalance;
                    const rows = evs.map(ev => {
                      running += ev.debit + ev.credit;
                      return { ...ev, balance: running };
                    });

                    const totalDebit  = evs.reduce((s, e) => s + e.debit, 0);
                    const totalCredit = evs.reduce((s, e) => s + e.credit, 0);
                    const finalBal    = openingBalance + totalDebit + totalCredit;

                    // Age buckets on OUTSTANDING (positive-balance invoices only)
                    // Simple: sum invoice remainders using FIFO against credits.
                    // For statement view, show buckets from final balance if > 0.
                    const today = new Date();
                    const daysBetween = (d) => Math.floor((today - new Date(d)) / 86400000);
                    let ageBuckets = { current: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0 };
                    if (finalBal > 0.01) {
                      // Age the outstanding by walking invoices FIFO-net-of-credits
                      const invQ = (breakdown.grns || []).map(g => ({ date: g.date, remain: parseFloat(g.total_amount) || 0 }));
                      let pool = -totalCredit; // positive pool of unallocated credits
                      // Apply pool to oldest invoices first
                      invQ.sort((a, b) => a.date.localeCompare(b.date));
                      for (const inv of invQ) {
                        if (pool <= 0) break;
                        const take = Math.min(pool, inv.remain);
                        inv.remain -= take; pool -= take;
                      }
                      for (const inv of invQ) {
                        if (inv.remain < 0.01) continue;
                        const d = daysBetween(inv.date);
                        if (d <= 30)       ageBuckets.current += inv.remain;
                        else if (d <= 60)  ageBuckets.b31_60 += inv.remain;
                        else if (d <= 90)  ageBuckets.b61_90 += inv.remain;
                        else if (d <= 120) ageBuckets.b91_120 += inv.remain;
                        else               ageBuckets.b120plus += inv.remain;
                      }
                    }

                    // Quick-preset date range helpers (renamed to todayIso to
                    // avoid shadowing the age-analysis `today` above).
                    const todayIso = new Date().toISOString().slice(0, 10);
                    const som      = todayIso.slice(0, 8) + '01';   // first of current month
                    const dOfPrev  = new Date(); dOfPrev.setMonth(dOfPrev.getMonth() - 1);
                    const prevSom  = dOfPrev.toISOString().slice(0, 8) + '01';
                    const prevEom  = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().slice(0, 10);

                    return (
                      <>
                        {/* Statement header block */}
                        <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px', marginBottom: 12, fontSize: 12 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                            <div>
                              <div><strong>Statement Date:</strong> {formatDate(new Date().toISOString().slice(0,10))}</div>
                              <div><strong>Supplier:</strong> {breakdown.supplier?.supplier_name || breakdown.supplier?.name}</div>
                              {breakdown.supplier?.phone && <div><strong>Phone:</strong> {breakdown.supplier.phone}</div>}
                              {breakdown.supplier?.email && <div><strong>Email:</strong> {breakdown.supplier.email}</div>}
                            </div>
                            <div>
                              <div style={{ color: '#6b7280' }}>Convention: invoices in Debit (+), payments + CNs in Credit (−).</div>
                              <div style={{ color: '#6b7280' }}>Balance is signed: positive = you owe supplier, negative = supplier owes you.</div>
                            </div>
                          </div>
                        </div>

                        {/* v1.10.310 — per-modal date filter. Everything before
                            'From' folds into an Opening Balance row so the
                            running balance stays truthful across window
                            narrowing. Empty inputs = All Time. */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>Statement window:</span>
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>From</span>
                          <input type="date" value={modalFrom} max={modalTo || todayIso}
                            onChange={e => setModalFrom(e.target.value)}
                            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }} />
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>To</span>
                          <input type="date" value={modalTo} min={modalFrom || undefined} max={todayIso}
                            onChange={e => setModalTo(e.target.value)}
                            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }} />
                          <button onClick={() => { setModalFrom(som); setModalTo(todayIso); }}
                            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>This Month</button>
                          <button onClick={() => { setModalFrom(prevSom); setModalTo(prevEom); }}
                            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>Last Month</button>
                          <button onClick={() => { setModalFrom(''); setModalTo(''); }}
                            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 11, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>All Time</button>
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
                            {modalFrom || modalTo ? `${modalFrom || '—'} to ${modalTo || '—'}` : 'Showing all time'}
                          </span>
                        </div>

                        {/* Single chronological table */}
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 14 }}>
                          <thead>
                            <tr style={{ background: '#f9fafb', borderBottom: '2px solid #cbd5e1' }}>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Date</th>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Doc #</th>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Type</th>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Reference</th>
                              <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700, color: '#dc2626' }}>Debit (+)</th>
                              <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700, color: '#0369a1' }}>Credit (−)</th>
                              <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700 }}>Balance</th>
                            </tr>
                          </thead>
                          <tbody>
                            {/* v1.10.310 — Opening Balance row shows carried-over
                                position from BEFORE the window. Only rendered when
                                the user has narrowed the range. */}
                            {(modalFrom || modalTo) && Math.abs(openingBalance) > 0.001 && (
                              <tr style={{ background: '#fefce8', borderBottom: '1px solid #fde68a' }}>
                                <td colSpan={4} style={{ padding: '6px 10px', fontStyle: 'italic', color: '#a16207' }}>
                                  Opening balance (carried over from before {modalFrom || 'start'})
                                </td>
                                <td colSpan={2} style={{ padding: '6px 10px' }}></td>
                                <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: openingBalance > 0.01 ? '#dc2626' : openingBalance < -0.01 ? '#16a34a' : '#374151' }}>
                                  {openingBalance < 0 ? '−' : ''}{fmtSup(openingBalance)}
                                </td>
                              </tr>
                            )}
                            {rows.length === 0 && (
                              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#9ca3af' }}>No transactions in this window.</td></tr>
                            )}
                            {rows.map((r, i) => {
                              const pillBg = r.kind === 'INV' ? '#fee2e2' : r.kind === 'PAY' ? '#dcfce7' : '#dbeafe';
                              const pillFg = r.kind === 'INV' ? '#991b1b' : r.kind === 'PAY' ? '#166534' : '#1d4ed8';
                              return (
                                <tr key={r.kind + r.doc + i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                  <td style={{ padding: '6px 10px', color: '#374151', whiteSpace: 'nowrap' }}>{formatDate(r.date)}</td>
                                  {/* v1.10.313 — Doc # is clickable for INV
                                      rows (deep-links to GRN.js which
                                      handles ?ref=GRN-... by auto-opening
                                      the View modal, same pattern the Sales
                                      Bin Card uses). PAY + CN stay plain
                                      text until we wire similar deep-links
                                      on those pages. */}
                                  <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11 }}>
                                    {r.kind === 'INV' ? (
                                      <button
                                        onClick={() => {
                                          setBreakdown(null);
                                          navigate(`/store/grn?ref=${encodeURIComponent(r.doc)}`);
                                        }}
                                        title="Open GRN details"
                                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#2563eb', textDecoration: 'underline', fontFamily: 'monospace', fontSize: 11 }}
                                      >{r.doc}</button>
                                    ) : (
                                      <span style={{ color: '#6b7280' }}>{r.doc}</span>
                                    )}
                                  </td>
                                  <td style={{ padding: '6px 10px' }}>
                                    <span style={{ background: pillBg, color: pillFg, padding: '1px 7px', borderRadius: 3, fontSize: 10, fontWeight: 700 }}>{r.kind}</span>
                                  </td>
                                  <td style={{ padding: '6px 10px', color: '#6b7280' }}>{r.reference || '—'}</td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', color: r.debit > 0 ? '#dc2626' : '#d1d5db' }}>
                                    {r.debit > 0 ? `+${fmtSup(r.debit)}` : ''}
                                  </td>
                                  {/* v1.10.312 — colour Credit amount by kind:
                                      PAY = green (money out to supplier),
                                      CN  = blue  (supplier credit note).
                                      Matches the pill colours so the two
                                      are visually distinct in one column. */}
                                  <td style={{
                                    padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace',
                                    color: r.credit === 0 ? '#d1d5db'
                                         : r.kind === 'PAY' ? '#16a34a'
                                         : r.kind === 'CN'  ? '#0369a1'
                                         : '#0369a1'
                                  }}>
                                    {r.credit < 0 ? `−${fmtSup(r.credit)}` : ''}
                                  </td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: r.balance > 0.01 ? '#dc2626' : r.balance < -0.01 ? '#16a34a' : '#374151' }}>
                                    {r.balance < 0 ? '−' : ''}{fmtSup(r.balance)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr style={{ background: '#f9fafb', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>
                              <td colSpan={4} style={{ padding: '8px 10px', textAlign: 'right' }}>Totals</td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: '#dc2626' }}>+{fmtSup(totalDebit)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: '#0369a1' }}>−{fmtSup(totalCredit)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: finalBal > 0.01 ? '#dc2626' : finalBal < -0.01 ? '#16a34a' : '#374151' }}>
                                {finalBal < 0 ? '−' : ''}{fmtSup(finalBal)}
                              </td>
                            </tr>
                          </tfoot>
                        </table>

                        {/* Final balance banner */}
                        <div style={{ background: finalBal > 0.01 ? '#fef2f2' : finalBal < -0.01 ? '#f0fdf4' : '#f9fafb',
                                      border: `1px solid ${finalBal > 0.01 ? '#fecaca' : finalBal < -0.01 ? '#bbf7d0' : '#e5e7eb'}`,
                                      borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>
                            {finalBal > 0.01 ? 'You owe supplier:' : finalBal < -0.01 ? 'Supplier owes you (credit balance):' : 'Account is square'}
                          </span>
                          <span style={{ fontWeight: 800, fontSize: 18, color: finalBal > 0.01 ? '#dc2626' : finalBal < -0.01 ? '#16a34a' : '#374151' }}>
                            {fmtSup(finalBal)}
                          </span>
                        </div>

                        {/* Age analysis — only when balance > 0 (you owe them) */}
                        {finalBal > 0.01 && (
                          <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Age analysis (as of today)</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, fontSize: 12 }}>
                              {[
                                ['Current',  ageBuckets.current],
                                ['31-60',    ageBuckets.b31_60],
                                ['61-90',    ageBuckets.b61_90],
                                ['91-120',   ageBuckets.b91_120],
                                ['120+',     ageBuckets.b120plus],
                              ].map(([label, val]) => (
                                <div key={label} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 10px', textAlign: 'center', background: val > 0.01 ? '#fef2f2' : '#fff' }}>
                                  <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>{label}</div>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: val > 0.01 ? '#dc2626' : '#9ca3af', fontFamily: 'monospace' }}>
                                    {fmtSup(val)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* v1.10.310 — Legacy 3-table sections below are hidden by
                      default. Left in the tree for now in case someone needs
                      them back; can delete after a stable run. */}
                  <div style={{ display: 'none' }}>
                  <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 10 }}>Purchases (GRN)</h3>
                  {breakdown.grns?.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 18 }}>No purchases yet.</p>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>GRN #</th>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Date</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600 }}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdown.grns.map(g => (
                          <tr key={g.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '7px 10px', color: '#6b7280' }}>{g.grn_number}</td>
                            <td style={{ padding: '7px 10px' }}>{formatDate(g.date)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600 }}>K{parseFloat(g.total_amount).toLocaleString()}</td>
                          </tr>
                        ))}
                        <tr style={{ background: '#f0fdf4', fontWeight: 700 }}>
                          <td colSpan="2" style={{ padding: '7px 10px', textAlign: 'right' }}>Total Purchases:</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: '#dc2626' }}>K{breakdown.grns.reduce((s, g) => s + parseFloat(g.total_amount), 0).toLocaleString()}</td>
                        </tr>
                      </tbody>
                    </table>
                  )}

                  {/* Payments */}
                  <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 10 }}>Payments Made (AP)</h3>
                  {breakdown.payments?.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 18 }}>No payments yet.</p>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Ref #</th>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Date</th>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Description</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600 }}>Amount</th>
                          <th style={{ padding: '7px 10px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdown.payments.map(p => (
                          editingPayment?.id === p.id ? (
                            <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: '#fffbeb' }}>
                              <td style={{ padding: '7px 10px', color: '#6b7280', fontSize: 12 }}>{p.payment_number}</td>
                              <td style={{ padding: '4px 6px' }}>
                                <input type="date" value={editingPayment.date} onChange={e => setEditingPayment(ep => ({ ...ep, date: e.target.value }))}
                                  style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, width: '100%' }} />
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <input type="text" value={editingPayment.description} onChange={e => setEditingPayment(ep => ({ ...ep, description: e.target.value }))}
                                  style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, width: '100%' }} />
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <input type="number" value={editingPayment.amount} onChange={e => setEditingPayment(ep => ({ ...ep, amount: e.target.value }))}
                                  style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, width: 80, textAlign: 'right' }} />
                              </td>
                              <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                <button onClick={handleSaveEdit} disabled={editSaving} style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12, marginRight: 4 }}>
                                  {editSaving ? '...' : <FiSave size={12} />}
                                </button>
                                <button onClick={() => { setEditingPayment(null); setEditError(''); }} style={{ background: '#f3f4f6', border: 'none', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }}>
                                  <FiX size={12} />
                                </button>
                              </td>
                            </tr>
                          ) : (
                          <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '7px 10px', color: '#6b7280' }}>{p.payment_number}</td>
                            <td style={{ padding: '7px 10px' }}>{formatDate(p.date)}</td>
                            <td style={{ padding: '7px 10px', color: '#6b7280' }}>{p.description || '—'}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>K{parseFloat(p.amount).toLocaleString()}</td>
                            <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                              {hasPermission('AccountPayables:Edit') && (
                              <button onClick={() => { setEditingPayment({ id: p.id, amount: p.amount, date: p.date, description: p.description || '', paid_from: p.paid_from || '' }); setEditError(''); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', marginRight: 6 }}>
                                <FiEdit2 size={13} />
                              </button>
                              )}
                              {hasPermission('AccountPayables:Delete') && (
                              <button onClick={() => handleDeletePayment(p.id)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626' }}>
                                <FiTrash2 size={13} />
                              </button>
                              )}
                            </td>
                          </tr>
                          )
                        ))}
                        <tr style={{ background: '#f0fdf4', fontWeight: 700 }}>
                          <td colSpan="3" style={{ padding: '7px 10px', textAlign: 'right' }}>Total Paid:</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: '#16a34a' }}>K{breakdown.payments.reduce((s, p) => s + parseFloat(p.amount), 0).toLocaleString()}</td>
                        </tr>
                      </tbody>
                    </table>
                  )}

                  {editError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{editError}</div>}

                  {/* Credit Notes section — supplier discounts + crate/bottle returns.
                      Same effect on the balance as payments. Shown as a third section
                      so the user can see exactly how the supplier credited them. */}
                  {breakdown.credits && breakdown.credits.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: '#0369a1' }}>Credit Notes</h3>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#f0f9ff' }}>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>CN #</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>Date</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>Reason</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>Reference</th>
                            <th style={{ padding: '7px 10px', textAlign: 'right', color: '#0369a1' }}>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {breakdown.credits.map(cn => (
                            <tr key={cn.id} style={{ borderBottom: '1px solid #e0f2fe' }}>
                              <td style={{ padding: '7px 10px', fontWeight: 500 }}>{cn.credit_note_number}</td>
                              <td style={{ padding: '7px 10px' }}>{formatDate(cn.date)}</td>
                              <td style={{ padding: '7px 10px' }}>
                                <span style={{ padding: '1px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                                  background: cn.reason === 'Discount' ? '#dcfce7' : '#dbeafe',
                                  color: cn.reason === 'Discount' ? '#166534' : '#1d4ed8' }}>{cn.reason}</span>
                              </td>
                              <td style={{ padding: '7px 10px', color: '#6b7280' }}>{cn.reference || '—'}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: '#0369a1', fontWeight: 600 }}>
                                {curSym}{parseFloat(cn.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                          <tr style={{ background: '#f0f9ff', fontWeight: 700 }}>
                            <td colSpan="4" style={{ padding: '7px 10px', textAlign: 'right' }}>Total Credits:</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: '#0369a1' }}>
                              {curSym}{breakdown.credits.reduce((s, c) => s + parseFloat(c.amount), 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Balance — reconciles Purchases − Paid − Credits.
                      Same arithmetic the AP supplier-list row uses, so the two
                      always match. The "(includes K… in credits)" hint makes it
                      obvious why Outstanding moved when the user adds a CN. */}
                  {(() => {
                    const totalPurchases = breakdown.grns?.reduce((s, g) => s + parseFloat(g.total_amount), 0) || 0;
                    const totalPaid = breakdown.payments?.reduce((s, p) => s + parseFloat(p.amount), 0) || 0;
                    const totalCredits = breakdown.credits?.reduce((s, c) => s + parseFloat(c.amount), 0) || 0;
                    // Convention: balance > 0 = supplier paid in advance (we owe negative);
                    // balance < 0 = we still owe.
                    const balance = totalPaid + totalCredits - totalPurchases;
                    return (
                      <div style={{ background: balance > 0.01 ? '#f0fdf4' : balance < -0.01 ? '#fef2f2' : '#f9fafb', border: `1px solid ${balance > 0.01 ? '#bbf7d0' : balance < -0.01 ? '#fecaca' : '#e5e7eb'}`, borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>
                            {balance > 0.01 ? 'Over Paid:' : balance < -0.01 ? 'Outstanding:' : 'Outstanding Balance:'}
                          </span>
                          {totalCredits > 0.01 && (
                            <div style={{ fontSize: 11, color: '#0369a1', marginTop: 3 }}>
                              Purchases {curSym}{totalPurchases.toLocaleString(undefined, { minimumFractionDigits: 2 })} − Paid {curSym}{totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2 })} − Credits {curSym}{totalCredits.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </div>
                          )}
                        </div>
                        <span style={{ fontWeight: 700, fontSize: 16, color: balance > 0.01 ? '#16a34a' : balance < -0.01 ? '#dc2626' : '#374151' }}>{balance < 0 ? '−' : ''}{curSym}{Math.abs(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    );
                  })()}
                  </div>{/* /v1.10.310 hidden legacy 3-table block */}
                </>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Payment Modal — shared component, also used by GRN.js */}
      <ApPaymentFormModal
        open={!!payModal}
        supplier={payModal}
        onClose={() => setPayModal(null)}
        onSaved={handlePaymentSaved}
      />
      {/* ── AP List Print Overlay ───────────────────────────────────── */}
      {false && showListPrint && (
        <div className="pv-print-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}>
          <div className="no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Print Preview — Account Payables ({payables.length} suppliers)</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}><FiPrinter size={14} /> Print</button>
              <button onClick={() => setShowListPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}><FiX size={14} /> Close</button>
            </div>
          </div>

          <div id="ap-list-document" style={{ width: 794, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}>
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #991b1b 0%, #dc2626 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>{businessInfo.business_name || 'Business Name'}</div>
                <div style={{ fontSize: 11, opacity: 0.75 }}>{[businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ')}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Account Payables</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Supplier Ledger</div>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
            {/* Rainbow divider */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #dc2626, #a855f7)' }} />

            <div style={{ padding: '26px 44px 36px' }}>
              {/* Stat chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total Purchases', value: curSym + parseFloat(stats.totalPurchases).toLocaleString(undefined, { minimumFractionDigits: 2 }), bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  { label: 'Total Paid',       value: curSym + parseFloat(stats.totalPaid).toLocaleString(undefined, { minimumFractionDigits: 2 }),      bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
                  { label: 'Outstanding',      value: curSym + parseFloat(stats.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2 }),    bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
                  { label: 'Suppliers',        value: stats.suppliers,                                                                                  bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
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
                    <tr style={{ background: '#fef2f2' }}>
                      {['#', 'Supplier', 'Phone', 'GRNs', 'Purchases', 'Paid', 'Balance', 'Status'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i >= 4 && i <= 6 ? 'right' : 'left', fontWeight: 600, color: '#dc2626', borderBottom: '1px solid #fecaca', fontSize: 10.5, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payables.map((p, idx) => (
                      <tr key={p.id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>{p.supplier_name}</td>
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>{p.phone || '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'center' }}>{p.grn_count}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{curSym}{parseFloat(p.total_purchases).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>{curSym}{parseFloat(p.total_paid).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        {/* Flip the sign for display: positive (paid more than owed) → green; negative (we still owe) → red. */}
                        {(() => {
                          const bal = -parseFloat(p.balance || 0);
                          return (
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: bal > 0.01 ? '#16a34a' : bal < -0.01 ? '#dc2626' : '#374151' }}>
                              {bal < 0 ? '−' : ''}{curSym}{Math.abs(bal).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                          );
                        })()}
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>{p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#fef2f2', borderTop: '2px solid #fca5a5' }}>
                      <td colSpan={4} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#dc2626' }}>TOTAL — {payables.length} Supplier{payables.length !== 1 ? 's' : ''}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>{curSym}{parseFloat(stats.totalPurchases).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>K{parseFloat(stats.totalPaid).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, color: '#dc2626' }}>K{parseFloat(stats.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} — Confidential</span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      <Toast message={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />

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

export default AccountPayables;
