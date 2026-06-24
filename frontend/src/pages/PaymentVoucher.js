import React, { useState, useEffect } from 'react';
import { getPaymentVouchers, getPaymentVoucherStats, deletePaymentVoucher, getSettings, getPvTypes, createPvType, updatePvType, deletePvType } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { FiPlus, FiDollarSign, FiCalendar, FiFileText, FiEdit2, FiEye, FiPrinter, FiX, FiTrash2 } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import InvoiceAttachment from '../components/InvoiceAttachment';
import PaymentVoucherFormModal from '../components/PaymentVoucherFormModal';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const getCategoryColor = (cat) => {
  const map = { 'Supplier': 'badge-blue', 'Utilities': 'badge-orange', 'Salaries': 'badge-purple', 'Rent': 'badge-green', 'Other': 'badge-gray' };
  return map[cat] || 'badge-gray';
};

const todayStr = new Date().toISOString().split('T')[0];

const PaymentVoucher = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  // v1.8.25 — stats now include per-currency totals (today / month / all).
  const [stats, setStats]       = useState({
    todayPayments: 0, thisMonth: 0, totalVouchers: 0,
    today: { usd: 0, fra: 0, k: 0 },
    month: { usd: 0, fra: 0, k: 0 },
    total: { usd: 0, fra: 0, k: 0 },
  });
  const [vouchers, setVouchers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editVoucher, setEditVoucher] = useState(null); // null = new; voucher object = edit
  const [businessInfo, setBusinessInfo] = useState({ business_name: '', address: '', phone: '' });
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // View / Print
  const [viewVoucher, setViewVoucher] = useState(null);
  const [showPVPrint, setShowPVPrint] = useState(false);

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!viewVoucher || showForm);
  const [showListPrint, setShowListPrint] = useState(false);

  // Date filter — default to today
  const [filterFrom, setFilterFrom] = useState(todayStr);
  const [filterTo,   setFilterTo]   = useState(todayStr);
  // PV-type filter (All by default)
  const [filterType, setFilterType] = useState('All');

  // Tabs: vouchers (default) | types (manage PV types)
  const [tab, setTab] = useState('vouchers');
  const [pvTypes, setPvTypes] = useState([]);
  const [editingType, setEditingType] = useState(null); // { id, name, color } when editing
  const [newType, setNewType] = useState({ name: '', color: '#6B7280' });

  const fetchData = async () => {
    try {
      const [statsRes, vouchersRes, settingsRes, typesRes] = await Promise.all([
        getPaymentVoucherStats(),
        getPaymentVouchers({}),
        getSettings(),
        getPvTypes(),
      ]);
      if (statsRes.data) setStats(statsRes.data);
      setVouchers(vouchersRes.data || []);
      if (settingsRes.data) setBusinessInfo(settingsRes.data);
      setPvTypes(Array.isArray(typesRes.data) ? typesRes.data : []);
    } catch (err) { /* use defaults */ }
  };

  // ── PV Types CRUD ────────────────────────────────────────────────────────
  const handleAddType = async () => {
    if (!newType.name.trim()) { showToast('Name required', 'error'); return; }
    try {
      await createPvType(newType);
      setNewType({ name: '', color: '#6B7280' });
      await fetchData();
      showToast('Type added');
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };
  const handleSaveType = async () => {
    if (!editingType?.name.trim()) { showToast('Name required', 'error'); return; }
    try {
      await updatePvType(editingType.id, { name: editingType.name, color: editingType.color });
      setEditingType(null);
      await fetchData();
      showToast('Type updated');
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeleteType = (t) => {
    setPendingDelete({
      subject: `PV Type: ${t.name}`,
      perform: async () => {
        try { await deletePvType(t.id); await fetchData(); showToast('Type deleted'); }
        catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
      },
    });
  };

  useEffect(() => { fetchData(); }, []); // eslint-disable-line

  // Client-side filter
  const filteredVouchers = vouchers.filter(v => {
    const d = (v.date || '').split('T')[0];
    if (filterFrom && d < filterFrom) return false;
    if (filterTo   && d > filterTo)   return false;
    if (filterType !== 'All' && (v.category || 'Other') !== filterType) return false;
    return true;
  });

  const filteredTotal = filteredVouchers.reduce((s, v) => s + parseFloat(v.amount || 0), 0);
  const allTotal      = vouchers.reduce((s, v) => s + parseFloat(v.amount || 0), 0);
  const hasFilter     = filterFrom || filterTo;

  const fmt2 = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const openForm = () => { setEditVoucher(null); setShowForm(true); };
  const openEdit = (v) => { setEditVoucher(v); setShowForm(true); };

  const handleDelete = (v) => {
    setPendingDelete({
      subject: `Payment Voucher ${v.voucher_number}`,
      perform: async () => {
        try {
          await deletePaymentVoucher(v.id);
          setViewVoucher(null);
          await fetchData();
          showToast('Payment Voucher deleted.', 'error');
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to delete voucher.');
        }
      },
    });
  };

  const handleSaved = async () => {
    await fetchData();
    showToast(editVoucher ? 'Payment Voucher updated successfully.' : 'Payment Voucher saved successfully.');
  };

  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const handlePrint = () => {
    const fmt = (v) => parseFloat(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const biz = businessInfo.business_name || businessInfo.business?.business_name || 'Business Name';
    const addr = [businessInfo.address||businessInfo.business?.business_address, businessInfo.phone||businessInfo.business?.business_phone].filter(Boolean).join('  |  ');
    const dateRange = filterFrom||filterTo
      ? `${filterFrom?formatDate(filterFrom):'All'} — ${filterTo?formatDate(filterTo):'All'}` : 'All Dates';
    const chip = (label, value, bg, color, border) =>
      `<div style="padding:12px 16px;border-radius:10px;background:${bg};border:1.5px solid ${border};text-align:center">
        <div style="font-size:9.5px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${label}</div>
        <div style="font-size:16px;font-weight:800;color:${color}">${value}</div>
      </div>`;
    const chips = [
      chip('Period From', filterFrom?formatDate(filterFrom):'All', '#f8fafc','#374151','#e2e8f0'),
      chip('Period To',   filterTo?formatDate(filterTo):'All',     '#f8fafc','#374151','#e2e8f0'),
      chip('Vouchers',    filteredVouchers.length,                  '#fef2f2','#dc2626','#fecaca'),
      chip('Total Amount',curSym+fmt(filteredTotal),                '#fff7ed','#c2410c','#fed7aa'),
    ].join('');
    const rows = filteredVouchers.map((v,idx) =>
      `<tr style="border-bottom:1px solid #f1f5f9;background:${idx%2===1?'#fafafa':'#fff'}">
        <td style="padding:8px 12px;color:#9ca3af;font-size:10.5px">${idx+1}</td>
        <td style="padding:8px 12px;font-weight:700;font-family:monospace;font-size:11px;color:#dc2626">${v.voucher_number}</td>
        <td style="padding:8px 12px;color:#374151">${formatDate(v.date)}</td>
        <td style="padding:8px 12px;color:#374151">${v.paid_from||'Main cashier'}</td>
        <td style="padding:8px 12px;font-weight:500">${v.paid_to}</td>
        <td style="padding:8px 12px;color:#6b7280">${v.description||'—'}</td>
        <td style="padding:8px 12px">${v.category}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:700;font-family:monospace;color:#dc2626">${curSym}${fmt2(v.amount)}</td>
      </tr>`
    ).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:0}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}
    </style></head><body><div style="width:794px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#991b1b 0%,#dc2626 100%);padding:28px 44px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${biz}</div>
          <div style="font-size:11px;opacity:0.75;line-height:1.7">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:0.65;margin-bottom:6px">Payment Vouchers</div>
          <div style="font-size:15px;font-weight:700">${dateRange}</div>
          <div style="font-size:10px;opacity:0.6;margin-top:4px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#f59e0b,#dc2626,#a855f7)"></div>
      <div style="padding:26px 44px 36px">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">${chips}</div>
        <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
          <table style="width:100%;border-collapse:collapse;font-size:11.5px">
            <thead><tr style="background:#fef2f2">
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">#</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">Voucher No.</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">Date</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">Paid From</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">Paid To</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">Description</th>
              <th style="padding:8px 12px;text-align:left;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">Category</th>
              <th style="padding:8px 12px;text-align:right;font-weight:600;color:#dc2626;border-bottom:1px solid #fecaca;font-size:10.5px">Amount</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr style="background:#fef2f2;border-top:2px solid #fca5a5">
              <td colspan="6" style="padding:10px 12px;font-weight:700;font-size:11.5px;color:#dc2626">TOTAL — ${filteredVouchers.length} Voucher${filteredVouchers.length!==1?'s':''}</td>
              <td></td>
              <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px;font-family:monospace;color:#dc2626">${curSym}${fmt(filteredTotal)}</td>
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

  const printSingleVoucher = (v) => {
    const fmt = (val) => parseFloat(val||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const biz = businessInfo.business_name || businessInfo.business?.business_name || 'Business Name';
    const addr = businessInfo.address || businessInfo.business?.business_address || '';
    const phone = businessInfo.phone || businessInfo.business?.business_phone || '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:0}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:12px;color:#1f2937}
    </style></head><body>
    <div style="width:794px;min-height:1123px;margin:0 auto;padding:48px 56px;box-sizing:border-box">
      <div style="text-align:center;margin-bottom:32px;padding-bottom:24px;border-bottom:2px solid #dc2626">
        <div style="font-size:22px;font-weight:800;color:#1f2937;margin-bottom:4px">${biz}</div>
        ${addr?`<div style="font-size:13px;color:#6b7280;margin-bottom:2px">${addr}</div>`:''}
        ${phone?`<div style="font-size:13px;color:#6b7280">Tel: ${phone}</div>`:''}
      </div>
      <div style="background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);border-radius:10px;padding:16px 24px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="color:rgba(255,255,255,0.75);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Payment Voucher</div>
          <div style="color:#fff;font-size:20px;font-weight:800">${v.voucher_number}</div>
        </div>
        <div style="text-align:right">
          <div style="color:rgba(255,255,255,0.75);font-size:11px;margin-bottom:2px">Date</div>
          <div style="color:#fff;font-size:14px;font-weight:600">${formatDate(v.date)}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
        ${[['Paid From',v.paid_from||'Main cashier'],['Paid To',v.paid_to],['Category',v.category],['Date',formatDate(v.date)]].map(([label,val])=>
          `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;background:#f9fafb">
            <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${label}</div>
            <div style="font-size:14px;font-weight:600;color:#1f2937">${val}</div>
          </div>`
        ).join('')}
      </div>
      ${v.description?`<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;background:#f9fafb;margin-bottom:24px">
        <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Description</div>
        <div style="font-size:14px;color:#374151">${v.description}</div>
      </div>`:''}
      <div style="background:#fef2f2;border:2px solid #fca5a5;border-radius:12px;padding:20px 24px;margin-bottom:40px;text-align:center">
        <div style="font-size:11px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Total Amount Paid</div>
        <div style="font-size:36px;font-weight:800;color:#dc2626">${curSym}${fmt(v.amount)}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:32px">
        ${['Prepared By','Approved By','Received By'].map(label=>
          `<div style="text-align:center">
            <div style="height:1px;background:#9ca3af;margin-bottom:8px"></div>
            <div style="font-size:11px;color:#6b7280;font-weight:600">${label}</div>
          </div>`
        ).join('')}
      </div>
      <div style="margin-top:48px;text-align:center;font-size:11px;color:#d1d5db">This is a computer-generated document.</div>
    </div></body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  return (
    <div className="page-content">

      {/* ── Page Header ─────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1>{t('paymentVoucherTitle')} (PV)</h1>
          <p>{t('paymentVouchersSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handlePrint} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPrinter size={15} /> {t('print')}
          </button>
          {hasPermission('PaymentVoucher:Add') && (
            <button className="btn btn-primary" onClick={openForm}><FiPlus /> {t('newVoucher')}</button>
          )}
        </div>
      </div>

      {/* v1.8.25 — per-currency stat cards. Today / This Month / Total
          Amount each show 3 lines (USD/FRA/K) instead of a single $ figure.
          'Total Vouchers' stays as a count. */}
      {(() => {
        const allowed = hasPermission('PaymentVoucher:View');
        const fmtU = (n) => `$${fmt2(n)}`;
        const fmtN = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');
        const Line = ({ label, val, color }) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, lineHeight: 1.6 }}>
            <span style={{ opacity: 0.85 }}>{label}</span><strong style={{ color }}>{val}</strong>
          </div>
        );
        const Card = ({ label, ccyData, bg, icon }) => (
          <div style={{ borderRadius: 14, padding: '14px 18px', background: bg, color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              {icon} <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
            </div>
            {allowed ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Line label="USD" val={fmtU(ccyData?.usd || 0)} color="#fff" />
                <Line label="FRA" val={fmtN(ccyData?.fra || 0)} color="#fff" />
                <Line label="K"   val={fmtN(ccyData?.k   || 0)} color="#fff" />
              </div>
            ) : <div style={{ fontSize: 18, fontWeight: 800 }}>N/A</div>}
          </div>
        );
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
            <Card label={t('todaysPayments')} ccyData={stats.today} bg="linear-gradient(135deg,#ef4444,#dc2626)" icon={<FiDollarSign size={20} />} />
            <Card label={t('thisMonth')}      ccyData={stats.month} bg="linear-gradient(135deg,#3b82f6,#1d4ed8)" icon={<FiCalendar size={20} />} />
            <div style={{ borderRadius: 14, padding: '14px 18px', background: 'linear-gradient(135deg,#22c55e,#15803d)', color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
              <FiFileText size={28} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('totalVouchers')}</div>
                <div style={{ fontSize: 28, fontWeight: 800 }}>{allowed ? stats.totalVouchers : 'N/A'}</div>
              </div>
            </div>
            <Card label={t('totalAmount')} ccyData={stats.total} bg="linear-gradient(135deg,#f97316,#c2410c)" icon={<FiDollarSign size={20} />} />
          </div>
        );
      })()}

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'vouchers', label: 'Vouchers' },
          { key: 'types',    label: 'PV Types' },
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

      {/* ── PV Types tab ─────────────────────────────────────────────── */}
      {tab === 'types' && (
        <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, padding: 12, background: '#f9fafb', borderRadius: 8 }}>
            <input type="text" placeholder="New type name" value={newType.name}
              onChange={e => setNewType({ ...newType, name: e.target.value })}
              style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
            <input type="color" value={newType.color}
              onChange={e => setNewType({ ...newType, color: e.target.value })}
              style={{ width: 44, height: 36, border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
            <button onClick={handleAddType}
              style={{ padding: '8px 18px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}>
              + Add Type
            </button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Color</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Name</th>
              <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Action</th>
            </tr></thead>
            <tbody>
              {pvTypes.length === 0 ? (
                <tr><td colSpan={3} style={{ padding: 30, textAlign: 'center', color: '#9ca3af' }}>No types yet.</td></tr>
              ) : pvTypes.map(t => editingType?.id === t.id ? (
                <tr key={t.id} style={{ background: '#fffbeb', borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: 8 }}>
                    <input type="color" value={editingType.color}
                      onChange={e => setEditingType({ ...editingType, color: e.target.value })}
                      style={{ width: 44, height: 32, border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                  </td>
                  <td style={{ padding: 8 }}>
                    <input type="text" value={editingType.name}
                      onChange={e => setEditingType({ ...editingType, name: e.target.value })}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                  </td>
                  <td style={{ padding: 8, textAlign: 'right' }}>
                    <button onClick={handleSaveType} style={{ padding: '5px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', marginRight: 6 }}>Save</button>
                    <button onClick={() => setEditingType(null)} style={{ padding: '5px 12px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={t.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ display: 'inline-block', width: 20, height: 20, borderRadius: 4, background: t.color, border: '1px solid #e5e7eb' }} />
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{t.name}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    <button onClick={() => setEditingType({ id: t.id, name: t.name, color: t.color || '#6B7280' })}
                      style={{ width: 28, height: 28, background: '#fef3c7', color: '#b45309', border: 'none', borderRadius: 6, cursor: 'pointer', marginRight: 4 }}>
                      <FiEdit2 size={13} />
                    </button>
                    <button onClick={() => handleDeleteType(t)}
                      style={{ width: 28, height: 28, background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                      <FiTrash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab !== 'vouchers' ? null : (<>

      {/* ── Date + Type Filter Bar ────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{t('filterByDate')}:</span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('from')}</span>
          <input
            type="date" value={filterFrom} max={filterTo || todayStr}
            onChange={e => setFilterFrom(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
          <input
            type="date" value={filterTo} min={filterFrom || undefined} max={todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>Type</span>
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}>
            <option value="All">All</option>
            {pvTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </div>

        {(hasFilter || filterType !== 'All') && (
          <button
            onClick={() => { setFilterFrom(''); setFilterTo(''); setFilterType('All'); }}
            style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}
          >
            Clear
          </button>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {filteredVouchers.length} voucher{filteredVouchers.length !== 1 ? 's' : ''}
          {hasFilter && (
            <> &nbsp;·&nbsp; Total: <strong style={{ color: '#dc2626' }}>{curSym}{fmt2(filteredTotal)}</strong></>
          )}
        </span>
      </div>

      {/* ── Vouchers Table ──────────────────────────────────────────── */}
      <div className="data-table-container">
        {filteredVouchers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
            {hasFilter ? 'No vouchers found for the selected date range.' : 'No vouchers recorded yet.'}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('voucherNumber')}</th><th>{t('date')}</th><th>{t('paidFrom')}</th><th>{t('paidTo')}</th>
                <th>{t('description')}</th><th>{t('category')}</th>
                {/* v1.8.25 — split Amount into 3 per-currency columns. */}
                <th style={{ textAlign: 'right', color: '#16a34a' }}>USD ($)</th>
                <th style={{ textAlign: 'right', color: '#7c3aed' }}>FRA</th>
                <th style={{ textAlign: 'right', color: '#ea580c' }}>K</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredVouchers.map(v => {
                // Prefer new usd/fra/k columns, fall back to legacy cash/bank/momo.
                const vu = parseFloat(v.usd_amount) > 0 ? parseFloat(v.usd_amount) : parseFloat(v.cash_amount || 0);
                const vf = parseFloat(v.fra_amount) > 0 ? parseFloat(v.fra_amount) : parseFloat(v.bank_amount || 0);
                const vk = parseFloat(v.k_amount)   > 0 ? parseFloat(v.k_amount)   : parseFloat(v.momo_amount || 0);
                const dash = <span style={{ color: '#cbd5e1' }}>—</span>;
                return (
                <tr key={v.id}>
                  <td style={{ fontWeight: 500 }}>{v.voucher_number}</td>
                  <td>{formatDate(v.date)}</td>
                  <td>
                    <span style={{
                      fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 20,
                      background: v.paid_from === 'Cash Drawer' ? '#eff6ff' : '#f0fdf4',
                      color: v.paid_from === 'Cash Drawer' ? '#2563eb' : '#16a34a',
                      border: `1px solid ${v.paid_from === 'Cash Drawer' ? '#bfdbfe' : '#bbf7d0'}`,
                    }}>
                      {v.paid_from || 'Main cashier'}
                    </span>
                  </td>
                  <td>{v.paid_to}</td>
                  <td style={{ color: '#6b7280' }}>{v.description || '—'}</td>
                  <td><span className={`badge ${getCategoryColor(v.category)}`}>{v.category}</span></td>
                  <td style={{ textAlign: 'right', color: vu > 0 ? '#16a34a' : '', fontWeight: vu > 0 ? 700 : 400 }}>{vu > 0 ? `$${fmt2(vu)}` : dash}</td>
                  <td style={{ textAlign: 'right', color: vf > 0 ? '#7c3aed' : '', fontWeight: vf > 0 ? 700 : 400 }}>{vf > 0 ? Math.round(vf).toLocaleString('en-US') : dash}</td>
                  <td style={{ textAlign: 'right', color: vk > 0 ? '#ea580c' : '', fontWeight: vk > 0 ? 700 : 400 }}>{vk > 0 ? Math.round(vk).toLocaleString('en-US') : dash}</td>
                  <td style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <button
                      onClick={() => setViewVoucher(v)}
                      style={{
                        background: '#f0fdf4', border: '1px solid #bbf7d0', cursor: 'pointer',
                        color: '#16a34a', padding: '4px 10px', borderRadius: 6,
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontSize: 12, fontWeight: 600, transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = '#dcfce7'}
                      onMouseLeave={e => e.currentTarget.style.background = '#f0fdf4'}
                    >
                      <FiEye size={13} /> View
                    </button>
                    {hasPermission('PaymentVoucher:Edit') && (
                      <button
                        onClick={() => openEdit(v)}
                        title="Edit"
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#6b7280', padding: 6, borderRadius: 6,
                          display: 'inline-flex', alignItems: 'center', transition: 'color 0.15s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#2563eb'}
                        onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
                      >
                        <FiEdit2 size={15} />
                      </button>
                    )}
                    {hasPermission('PaymentVoucher:Delete') && (
                      <button
                        onClick={() => handleDelete(v)}
                        title="Delete"
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#6b7280', padding: 6, borderRadius: 6,
                          display: 'inline-flex', alignItems: 'center', transition: 'color 0.15s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#dc2626'}
                        onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
                      >
                        <FiTrash2 size={15} />
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
            <tfoot>
              {/* v1.8.25 — per-currency footer totals. */}
              <tr style={{ fontWeight: 700, borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                <td colSpan={6} style={{ padding: '10px 14px', textAlign: 'right', color: '#374151', fontSize: 13 }}>
                  Total ({filteredVouchers.length} voucher{filteredVouchers.length !== 1 ? 's' : ''})
                </td>
                {(() => {
                  const tu = filteredVouchers.reduce((s, v) => s + (parseFloat(v.usd_amount) > 0 ? parseFloat(v.usd_amount) : parseFloat(v.cash_amount || 0)), 0);
                  const tf = filteredVouchers.reduce((s, v) => s + (parseFloat(v.fra_amount) > 0 ? parseFloat(v.fra_amount) : parseFloat(v.bank_amount || 0)), 0);
                  const tk = filteredVouchers.reduce((s, v) => s + (parseFloat(v.k_amount)   > 0 ? parseFloat(v.k_amount)   : parseFloat(v.momo_amount || 0)), 0);
                  return (<>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#16a34a', fontWeight: 700, fontSize: 13 }}>${fmt2(tu)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#7c3aed', fontWeight: 700, fontSize: 13 }}>{Math.round(tf).toLocaleString('en-US')}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#ea580c', fontWeight: 700, fontSize: 13 }}>{Math.round(tk).toLocaleString('en-US')}</td>
                    <td></td>
                  </>);
                })()}
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      </>)}

      {/* ── View Voucher Modal ────────────────────────────────────────── */}
      {viewVoucher && !showPVPrint && (
        <Portal>
        <div className="modal-overlay" onClick={() => setViewVoucher(null)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{
              background: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)',
              borderRadius: '12px 12px 0 0', padding: '20px 24px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
                  Payment Voucher
                </div>
                <div style={{ color: '#fff', fontSize: 20, fontWeight: 700 }}>
                  {viewVoucher.voucher_number}
                </div>
              </div>
              <button
                onClick={() => setViewVoucher(null)}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', padding: 8, display: 'flex', alignItems: 'center' }}
              >
                <FiX size={18} />
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { label: 'Date',        value: formatDate(viewVoucher.date) },
                { label: 'Paid From',   value: viewVoucher.paid_from || 'Main cashier' },
                { label: 'Paid To',     value: viewVoucher.paid_to },
                { label: 'Category',    value: viewVoucher.category },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 14px', border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{value}</div>
                </div>
              ))}

              {viewVoucher.description && (
                <div style={{ gridColumn: '1 / -1', background: '#f8fafc', borderRadius: 8, padding: '10px 14px', border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Description</div>
                  <div style={{ fontSize: 14, color: '#374151' }}>{viewVoucher.description}</div>
                </div>
              )}

              {/* Amount highlight */}
              <div style={{ gridColumn: '1 / -1', background: '#fef2f2', borderRadius: 10, padding: '14px 18px', border: '1px solid #fecaca', textAlign: 'center' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Amount Paid</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#dc2626' }}>{curSym}{fmt2(viewVoucher.amount)}</div>
              </div>

              {/* Invoice attachment */}
              {viewVoucher.invoice_attachment && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Invoice Attachment</div>
                  <InvoiceAttachment value={viewVoucher.invoice_attachment} onChange={() => {}} kind="pv" disabled />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setViewVoucher(null)}>Close</button>
              {hasPermission('PaymentVoucher:Delete') && (
                <button
                  className="btn btn-danger"
                  onClick={() => handleDelete(viewVoucher)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#dc2626', color: '#fff', border: 'none' }}
                >
                  <FiTrash2 size={14} /> Delete
                </button>
              )}
              {hasPermission('PaymentVoucher:Edit') && (
                <button
                  className="btn btn-secondary"
                  onClick={() => { openEdit(viewVoucher); setViewVoucher(null); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <FiEdit2 size={14} /> Edit
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => printSingleVoucher(viewVoucher)}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <FiPrinter size={14} /> Print
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── List Print Preview ───────────────────────────────────────── */}
      {false && showListPrint && (
        <div
          className="pv-print-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}
        >
          {/* Toolbar */}
          <div
            className="no-print"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview — Payment Vouchers ({filteredVouchers.length} records)
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <FiPrinter size={14} /> Print
              </button>
              <button onClick={() => setShowListPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          {/* A4 Paper */}
          <div
            id="pv-print-document"
            style={{ width: 794, background: '#ffffff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}
          >
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #991b1b 0%, #dc2626 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || businessInfo.business?.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.address || businessInfo.business?.business_address, businessInfo.phone || businessInfo.business?.business_phone, businessInfo.business?.business_email].filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Payment Vouchers</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {filterFrom || filterTo
                    ? `${filterFrom ? formatDate(filterFrom) : 'All'} — ${filterTo ? formatDate(filterTo) : 'All'}`
                    : 'All Dates'}
                </div>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
            {/* Rainbow divider */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #dc2626, #a855f7)' }} />

            <div style={{ padding: '26px 44px 36px' }}>
              {/* Summary chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Period From',       value: filterFrom ? formatDate(filterFrom) : 'All',                                          bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  { label: 'Period To',         value: filterTo   ? formatDate(filterTo)   : 'All',                                          bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  { label: 'Vouchers',          value: filteredVouchers.length,                                                               bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
                  { label: 'Total Amount',      value: curSym + filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }),           bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
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
                      {['#', 'Voucher No.', 'Date', 'Paid From', 'Paid To', 'Description', 'Category', 'Amount'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i >= 7 ? 'right' : 'left', fontWeight: 600, color: '#dc2626', borderBottom: '1px solid #fecaca', fontSize: 10.5, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVouchers.map((v, idx) => (
                      <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: '#dc2626' }}>{v.voucher_number}</td>
                        <td style={{ padding: '8px 12px', color: '#374151' }}>{formatDate(v.date)}</td>
                        <td style={{ padding: '8px 12px', color: '#374151' }}>{v.paid_from || 'Main cashier'}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 500 }}>{v.paid_to}</td>
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>{v.description || '—'}</td>
                        <td style={{ padding: '8px 12px' }}>{v.category}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#dc2626' }}>{curSym}{fmt2(v.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#fef2f2', borderTop: '2px solid #fca5a5' }}>
                      <td colSpan={6} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#dc2626' }}>
                        TOTAL — {filteredVouchers.length} Voucher{filteredVouchers.length !== 1 ? 's' : ''}
                      </td>
                      <td />
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, fontFamily: 'monospace', color: '#dc2626' }}>
                        {curSym}{filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || businessInfo.business?.business_name || 'Business'} — Confidential</span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── A4 Print Preview ─────────────────────────────────────────── */}
      {false && showPVPrint && viewVoucher && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          zIndex: 9999, display: 'flex', flexDirection: 'column',
          alignItems: 'center', padding: '20px 0', overflowY: 'auto',
        }}>
          {/* Toolbar */}
          <div className="no-print" style={{
            display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center',
          }}>
            <button
              onClick={() => window.print()}
              style={{
                background: '#dc2626', color: '#fff', border: 'none',
                borderRadius: 8, padding: '10px 24px', fontWeight: 600,
                fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <FiPrinter size={16} /> Print
            </button>
            <button
              onClick={() => setShowPVPrint(false)}
              style={{
                background: '#fff', color: '#374151', border: '1px solid #d1d5db',
                borderRadius: 8, padding: '10px 20px', fontWeight: 600,
                fontSize: 14, cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>

          {/* A4 Document */}
          <div style={{
            width: 794, minHeight: 1123, background: '#fff',
            boxShadow: '0 4px 32px rgba(0,0,0,0.3)',
            padding: '48px 56px', boxSizing: 'border-box',
            fontFamily: 'Arial, sans-serif',
          }}>
            {/* Business Header */}
            <div style={{ textAlign: 'center', marginBottom: 32, paddingBottom: 24, borderBottom: '2px solid #dc2626' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1f2937', marginBottom: 4 }}>
                {businessInfo.business_name || 'Business Name'}
              </div>
              {businessInfo.address && (
                <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 2 }}>{businessInfo.address}</div>
              )}
              {businessInfo.phone && (
                <div style={{ fontSize: 13, color: '#6b7280' }}>Tel: {businessInfo.phone}</div>
              )}
            </div>

            {/* Document Title */}
            <div style={{
              background: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)',
              borderRadius: 10, padding: '16px 24px', marginBottom: 28,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
                  Payment Voucher
                </div>
                <div style={{ color: '#fff', fontSize: 20, fontWeight: 800 }}>{viewVoucher.voucher_number}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11, marginBottom: 2 }}>Date</div>
                <div style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>{formatDate(viewVoucher.date)}</div>
              </div>
            </div>

            {/* Detail Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
              {[
                { label: 'Paid From',  value: viewVoucher.paid_from || 'Main cashier' },
                { label: 'Paid To',    value: viewVoucher.paid_to },
                { label: 'Category',   value: viewVoucher.category },
                { label: 'Date',       value: formatDate(viewVoucher.date) },
              ].map(({ label, value }) => (
                <div key={label} style={{
                  border: '1px solid #e5e7eb', borderRadius: 8,
                  padding: '12px 16px', background: '#f9fafb',
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Description */}
            {viewVoucher.description && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', background: '#f9fafb', marginBottom: 24 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Description</div>
                <div style={{ fontSize: 14, color: '#374151' }}>{viewVoucher.description}</div>
              </div>
            )}

            {/* Amount Block */}
            <div style={{
              background: '#fef2f2', border: '2px solid #fca5a5',
              borderRadius: 12, padding: '20px 24px', marginBottom: 40,
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                Total Amount Paid
              </div>
              <div style={{ fontSize: 36, fontWeight: 800, color: '#dc2626' }}>
                {curSym}{fmt2(viewVoucher.amount)}
              </div>
            </div>

            {/* Signature Lines */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 32, marginTop: 32 }}>
              {['Prepared By', 'Approved By', 'Received By'].map(label => (
                <div key={label} style={{ textAlign: 'center' }}>
                  <div style={{ height: 1, background: '#9ca3af', marginBottom: 8 }} />
                  <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Footer note */}
            <div style={{ marginTop: 48, textAlign: 'center', fontSize: 11, color: '#d1d5db' }}>
              This is a computer-generated document.
            </div>
          </div>
        </div>
      )}

      {/* ── New / Edit Voucher Modal ─────────────────────────────────── */}
      <PaymentVoucherFormModal
        open={showForm}
        onClose={() => setShowForm(false)}
        onSaved={handleSaved}
        editVoucher={editVoucher}
      />


      <style>{`
        @media print {
          .no-print { display: none !important; }
          .pv-print-overlay {
            position: fixed !important;
            top: 0 !important; left: 0 !important;
            right: 0 !important; bottom: 0 !important;
            background: #fff !important; padding: 0 !important;
            overflow: visible !important; display: block !important;
          }
          #pv-print-document { box-shadow: none !important; width: 100% !important; margin: 0 !important; }
        }
      `}</style>
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

export default PaymentVoucher;
