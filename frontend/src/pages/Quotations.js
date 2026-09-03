// Quotations — v1.10.327
// Draft price offers before they become real orders. Zero stock impact.
import React, { useEffect, useMemo, useState } from 'react';
import {
  FiPlus, FiX, FiTrash2, FiSend, FiCheck, FiSlash, FiRefreshCw, FiEdit2,
  FiFileText, FiChevronRight, FiRotateCw, FiClock, FiCheckCircle, FiFile,
  FiPrinter,
} from 'react-icons/fi';
import {
  getQuotations, getQuotationStats, getQuotation, createQuotation,
  updateQuotation, sendQuotation, acceptQuotation, declineQuotation,
  voidQuotation, convertQuotation, deleteQuotation, getProducts, getCustomers,
  getSettings,
} from '../services/api';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import Toast from '../components/Toast';

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays  = (iso, n) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtCcy = (n, ccy) => {
  const v = parseFloat(n || 0);
  const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? '-' : '';
  if (ccy === 'USD') return `${sign}$${s}`;
  if (ccy === 'FRA') return `${sign}FRA ${s}`;
  return `${sign}K ${s}`;
};
const STATUS_STYLE = {
  Draft:    { bg: '#f1f5f9', fg: '#475569' },
  Sent:     { bg: '#dbeafe', fg: '#1d4ed8' },
  Accepted: { bg: '#dcfce7', fg: '#15803d' },
  Declined: { bg: '#fee2e2', fg: '#b91c1c' },
  Expired:  { bg: '#f3f4f6', fg: '#94a3b8' },
  Ordered:  { bg: '#fef3c7', fg: '#b45309' },
  Voided:   { bg: '#f3f4f6', fg: '#6b7280' },
};

const EMPTY_ITEM = { product_id: '', product_name: '', unit: '', quantity: '', unit_price: '' };

export default function Quotations() {
  const [rows, setRows]           = useState([]);
  const [stats, setStats]         = useState({ active: 0, waiting: 0, accepted: 0, expired: 0 });
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState('All');
  const [search, setSearch]       = useState('');
  const [products, setProducts]   = useState([]);
  const [customers, setCustomers] = useState([]);
  const [modal, setModal]         = useState(null); // 'create' | 'edit' | 'view'
  const [current, setCurrent]     = useState(null);
  const [toast, setToast]         = useState(null);
  const [saving, setSaving]       = useState(false);
  const [businessInfo, setBusinessInfo] = useState({});
  useModalScrollLock(!!modal);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    try {
      const [q, s] = await Promise.all([
        getQuotations({ status: tab === 'All' ? undefined : tab, q: search || undefined }),
        getQuotationStats(),
      ]);
      setRows(q.data || []);
      setStats(s.data || {});
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to load quotations', 'error');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tab]);
  useEffect(() => {
    (async () => {
      try {
        const [p, c] = await Promise.all([getProducts(), getCustomers()]);
        setProducts(p.data || []);
        setCustomers(c.data || []);
      } catch (_) {}
    })();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  // Print a single quotation — mirrors CashReceipt.printSingleCR template
  // (v1.10.327 alignment). Blue palette since Quotations page runs blue.
  const printQuotation = async (row) => {
    let q = row;
    if (!q.items) {
      try { const res = await getQuotation(row.id); q = res.data; }
      catch (e) { showToast(e.response?.data?.error || 'Failed to load quote', 'error'); return; }
    }
    const biz = businessInfo;
    const printed = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const fmt = (n) => fmtCcy(n, q.currency);
    const cards = [
      { label: 'Customer',    value: q.customer_name || 'Walk-in',    bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8' },
      { label: 'Currency',    value: q.currency,                       bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
      { label: 'Quote Date',  value: q.date,                           bg: '#fff7ed', border: '#fed7aa', color: '#c2410c' },
      { label: 'Valid Until', value: q.valid_until,                    bg: '#fef2f2', border: '#fecaca', color: '#b91c1c' },
    ].map(c => `<div style="padding:14px 18px;border-radius:10px;background:${c.bg};border:1.5px solid ${c.border}"><div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${c.label}</div><div style="font-size:15px;font-weight:700;color:${c.color}">${(c.value || '').toString().replace(/</g,'&lt;')}</div></div>`).join('');
    const itemRows = (q.items || []).map((it, i) => `<tr style="border-top:1px solid #e5e7eb;background:${i % 2 === 1 ? '#f8fafc' : '#fff'}"><td style="padding:8px 12px;color:#111827">${(it.product_name || '').toString().replace(/</g,'&lt;')}${it.unit ? ` <span style="color:#9ca3af;font-size:10.5px">(${it.unit})</span>` : ''}</td><td style="padding:8px 12px;text-align:right;font-family:monospace">${parseFloat(it.quantity).toLocaleString()}</td><td style="padding:8px 12px;text-align:right;font-family:monospace">${fmt(it.unit_price)}</td><td style="padding:8px 12px;text-align:right;font-family:monospace;font-weight:700;color:#1d4ed8">${fmt(it.line_total)}</td></tr>`).join('');
    const notesHtml = q.notes ? `<div style="padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:11.5px;color:#78350f;margin-bottom:24px"><span style="font-weight:700;text-transform:uppercase;font-size:9.5px;letter-spacing:0.8px;margin-right:8px;color:#92400e">Notes / Terms</span>${q.notes.toString().replace(/</g,'&lt;')}</div>` : '';
    const sigs = ['Prepared By', 'Customer Signature'].map(label => `<div style="text-align:center"><div style="height:36px;border-bottom:1.5px solid #cbd5e1;margin-bottom:6px"></div><div style="font-size:9.5px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6b7280">${label}</div><div style="font-size:9px;color:#9ca3af;margin-top:2px">Name / Signature / Date</div></div>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quotation ${q.quote_number}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><div style="width:794px;margin:0 auto;background:#fff"><div style="background:linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 50%,#3b82f6 100%);padding:28px 40px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start"><div><div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;opacity:0.6;margin-bottom:8px">Quotation — Not a Tax Invoice</div><div style="font-size:20px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${biz.business_name || 'Business Name'}</div><div style="font-size:10px;opacity:0.7;line-height:1.8">${[biz.business_address, biz.business_phone, biz.business_email].filter(Boolean).join('  ·  ')}</div></div><div style="text-align:right"><div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.55;margin-bottom:8px">Quote No.</div><div style="font-size:20px;font-weight:900;letter-spacing:1px;font-family:monospace">${q.quote_number}</div><div style="margin-top:8px;font-size:11px;opacity:0.8">${q.date}</div></div></div><div style="height:4px;background:linear-gradient(90deg,#f59e0b,#22c55e,#2563eb,#a855f7)"></div><div style="padding:28px 40px 36px"><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:26px">${cards}</div><div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px"><table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr style="background:#eff6ff"><th style="padding:10px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Product</th><th style="padding:10px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Qty</th><th style="padding:10px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Unit Price</th><th style="padding:10px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Line</th></tr></thead><tbody>${itemRows || '<tr><td colspan="4" style="padding:12px;text-align:center;color:#9ca3af">No items</td></tr>'}</tbody></table></div><div style="border:2px solid #bfdbfe;border-radius:12px;padding:18px 24px;background:#eff6ff;margin-bottom:22px"><table style="width:100%;border-collapse:collapse;font-size:12px"><tr><td style="padding:4px 0;color:#6b7280">Subtotal</td><td style="padding:4px 0;text-align:right;font-family:monospace">${fmt(q.subtotal)}</td></tr><tr><td style="padding:4px 0;color:#6b7280">Discount</td><td style="padding:4px 0;text-align:right;font-family:monospace">${fmt(q.discount)}</td></tr><tr><td style="padding:4px 0;color:#6b7280">Tax</td><td style="padding:4px 0;text-align:right;font-family:monospace">${fmt(q.tax)}</td></tr><tr style="border-top:1.5px solid #bfdbfe"><td style="padding:8px 0 0;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#1d4ed8;font-size:11px">Grand Total</td><td style="padding:8px 0 0;text-align:right;font-family:monospace;font-weight:900;color:#1d4ed8;font-size:18px">${fmt(q.total)}</td></tr></table></div>${notesHtml}<div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:40px">${sigs}</div></div><div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:10px 40px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:9px;color:#94a3b8">${biz.business_name || 'Business'} — Quotation, not a Tax Invoice</span><span style="font-size:9px;color:#94a3b8">Printed: ${printed}</span></div></div></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { showToast('Popup blocked — allow popups for this site to print.', 'error'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const openCreate = () => {
    setCurrent({
      date: todayISO(),
      valid_until: addDays(todayISO(), 14),
      customer_id: '', customer_name: '',
      currency: 'K', fx_rate_used: 1,
      discount: 0, tax: 0, notes: '',
      items: [{ ...EMPTY_ITEM }],
    });
    setModal('create');
  };

  const openEdit = async (row) => {
    try {
      const res = await getQuotation(row.id);
      const d = res.data;
      setCurrent({
        id: d.id,
        date: (d.date || '').slice(0, 10),
        valid_until: (d.valid_until || '').slice(0, 10),
        customer_id: d.customer_id || '', customer_name: d.customer_name || '',
        currency: d.currency || 'K', fx_rate_used: d.fx_rate_used || 1,
        discount: d.discount || 0, tax: d.tax || 0, notes: d.notes || '',
        items: (d.items || []).map(i => ({
          product_id: i.product_id || '', product_name: i.product_name,
          unit: i.unit || '', quantity: String(i.quantity),
          unit_price: String(i.unit_price), discount_amount: String(i.discount_amount || 0),
        })),
      });
      setModal('edit');
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load', 'error'); }
  };

  const openView = async (row) => {
    try {
      const res = await getQuotation(row.id);
      setCurrent(res.data);
      setModal('view');
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load', 'error'); }
  };

  const closeModal = () => { setModal(null); setCurrent(null); };

  const setField = (k, v) => setCurrent(prev => ({ ...prev, [k]: v }));
  const setItem = (i, k, v) => setCurrent(prev => ({
    ...prev, items: prev.items.map((row, idx) => idx === i ? { ...row, [k]: v } : row),
  }));
  const addItem = () => setCurrent(prev => ({ ...prev, items: [...prev.items, { ...EMPTY_ITEM }] }));
  const removeItem = (i) => setCurrent(prev => ({
    ...prev, items: prev.items.filter((_, idx) => idx !== i),
  }));
  const pickProduct = (i, product) => {
    setCurrent(prev => ({
      ...prev, items: prev.items.map((row, idx) => idx === i ? {
        ...row, product_id: product.id, product_name: product.name,
        unit: product.unit || '',
        unit_price: String(product.selling_price || product.price || 0),
      } : row),
    }));
  };

  const subtotal = useMemo(() => (current?.items || []).reduce((s, it) => {
    const q = parseFloat(it.quantity) || 0;
    const p = parseFloat(it.unit_price) || 0;
    const d = parseFloat(it.discount_amount) || 0;
    return s + Math.max(0, q * p - d);
  }, 0), [current]);
  const total = useMemo(() => Math.max(0, subtotal - (parseFloat(current?.discount) || 0) + (parseFloat(current?.tax) || 0)), [subtotal, current]);

  const save = async () => {
    const items = (current.items || []).filter(i => i.product_name && parseFloat(i.quantity) > 0);
    if (!items.length) { showToast('Add at least one line item', 'error'); return; }
    if (!current.valid_until) { showToast('Valid Until date is required', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        date: current.date, valid_until: current.valid_until,
        customer_id: current.customer_id || null,
        customer_name: current.customer_name || null,
        currency: current.currency, fx_rate_used: parseFloat(current.fx_rate_used) || 1,
        discount: parseFloat(current.discount) || 0,
        tax:      parseFloat(current.tax) || 0,
        notes: current.notes, items,
      };
      if (modal === 'edit') { await updateQuotation(current.id, payload); showToast('Quotation updated'); }
      else                  { await createQuotation(payload);              showToast('Quotation created'); }
      await load();
      closeModal();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save', 'error');
    }
    setSaving(false);
  };

  const doAction = async (id, fn, okMsg) => {
    try { await fn(id); showToast(okMsg); await load(); }
    catch (e) { showToast(e.response?.data?.error || 'Action failed', 'error'); }
  };

  const filteredRows = useMemo(() => {
    if (!search) return rows;
    const s = search.toLowerCase();
    return rows.filter(r =>
      String(r.quote_number || '').toLowerCase().includes(s) ||
      String(r.customer_name || '').toLowerCase().includes(s));
  }, [rows, search]);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Quotations</h1>
          <p>Draft prices for customers before turning them into orders</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={load} className="btn" style={btnGhost}><FiRefreshCw size={14} /> Refresh</button>
          <button onClick={openCreate} className="btn btn-primary"><FiPlus /> New Quotation</button>
        </div>
      </div>

      {/* Stat tiles — Sosna gradient style */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
        <StatTile label="Active"          value={stats.active   ?? 0} icon={<FiFileText size={22} />}    bg="linear-gradient(135deg,#3b82f6,#1d4ed8)" />
        <StatTile label="Awaiting Reply"  value={stats.waiting  ?? 0} icon={<FiClock size={22} />}       bg="linear-gradient(135deg,#f59e0b,#b45309)" />
        <StatTile label="Accepted (30d)"  value={stats.accepted ?? 0} icon={<FiCheckCircle size={22} />} bg="linear-gradient(135deg,#22c55e,#15803d)" />
        <StatTile label="Expired"         value={stats.expired  ?? 0} icon={<FiFile size={22} />}        bg="linear-gradient(135deg,#94a3b8,#475569)" />
      </div>

      {/* Filter bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Filter:</span>
        <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          {['All', 'Draft', 'Sent', 'Accepted', 'Declined', 'Expired', 'Ordered'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '6px 12px', background: tab === t ? '#1d4ed8' : 'transparent',
              color: tab === t ? '#fff' : '#475569', border: 0, borderRadius: 6,
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}>{t}</button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search #, customer…"
          style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, minWidth: 200, background: '#fff' }} />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{filteredRows.length} quote{filteredRows.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Table */}
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Quote #</th><th>Date</th><th>Customer</th><th>Valid Until</th>
              <th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>Loading…</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>No quotations yet.</td></tr>
            ) : filteredRows.map(r => {
              const st = STATUS_STYLE[r.status] || STATUS_STYLE.Draft;
              const expired = r.status === 'Sent' && r.valid_until && r.valid_until.slice(0,10) < todayISO();
              return (
                <tr key={r.id}>
                  <td style={{ fontFamily: 'monospace', color: '#1d4ed8', fontWeight: 700 }}>{r.quote_number}</td>
                  <td>{r.date}</td>
                  <td>{r.customer_name || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                  <td style={{ color: expired ? '#dc2626' : '#111827' }}>{r.valid_until}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtCcy(r.total, r.currency)}</td>
                  <td><span style={{ background: st.bg, color: st.fg, fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999 }}>{r.status}</span></td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button onClick={() => openView(r)} style={btnRow}><FiFileText size={12} /> View</button>
                      <button onClick={() => printQuotation(r)} style={btnRow}><FiPrinter size={12} /> Print</button>
                      {r.status === 'Draft' && (
                        <>
                          <button onClick={() => openEdit(r)} style={btnRow}><FiEdit2 size={12} /> Edit</button>
                          <button onClick={() => doAction(r.id, sendQuotation, 'Marked as Sent')} style={btnRow}><FiSend size={12} /> Send</button>
                          <button onClick={() => doAction(r.id, deleteQuotation, 'Deleted')} style={{ ...btnRow, color: '#b91c1c' }}><FiTrash2 size={12} /></button>
                        </>
                      )}
                      {r.status === 'Sent' && (
                        <>
                          <button onClick={() => doAction(r.id, acceptQuotation, 'Marked Accepted')} style={btnRow}><FiCheck size={12} /> Accept</button>
                          <button onClick={() => doAction(r.id, declineQuotation, 'Marked Declined')} style={btnRow}><FiSlash size={12} /> Decline</button>
                        </>
                      )}
                      {['Accepted','Sent'].includes(r.status) && (
                        <button onClick={() => doAction(r.id, convertQuotation, 'Order created')} style={{ ...btnRow, color: '#15803d', borderColor: '#bbf7d0', background: '#f0fdf4' }}>
                          <FiChevronRight size={12} /> Convert
                        </button>
                      )}
                      {r.status === 'Expired' && (
                        <button onClick={() => openEdit({ ...r })} style={btnRow}><FiRotateCw size={12} /> Renew</button>
                      )}
                      {['Draft','Sent','Accepted','Expired'].includes(r.status) && (
                        <button onClick={async () => {
                          const reason = window.prompt('Void reason:');
                          if (!reason) return;
                          try { await voidQuotation(r.id, reason); showToast('Voided'); await load(); }
                          catch (e) { showToast(e.response?.data?.error || 'Failed', 'error'); }
                        }} style={btnRow}>Void</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Create / Edit Modal ── */}
      {modal && current && (modal === 'create' || modal === 'edit') && (
        <Portal>
          <div style={overlay}>
            <div style={{ ...modalBox, maxWidth: 780 }}>
              <div style={{ ...modalHead, background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)' }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', fontWeight: 700, marginBottom: 3 }}>
                    {modal === 'edit' ? 'Edit' : 'New'} Quotation
                  </div>
                  <h3 style={{ margin: 0, fontSize: 17, color: '#fff' }}>Draft a price offer</h3>
                  <p style={{ margin: '2px 0 0', fontSize: 11, color: 'rgba(255,255,255,0.75)' }}>Not counted as a sale until Converted</p>
                </div>
                <button onClick={closeModal} style={closeBtn}><FiX size={16} /></button>
              </div>
              <div style={{ padding: 20, maxHeight: '75vh', overflowY: 'auto' }}>
                <div style={grid2}>
                  <Field label="Date"><input type="date" value={current.date} onChange={e => setField('date', e.target.value)} style={inp}/></Field>
                  <Field label="Valid Until *"><input type="date" value={current.valid_until} onChange={e => setField('valid_until', e.target.value)} style={inp}/></Field>
                </div>
                <div style={{ ...grid2, marginTop: 12 }}>
                  <Field label="Customer">
                    <input list="q-cust" value={current.customer_name} onChange={e => {
                      const val = e.target.value;
                      const match = customers.find(c => c.name === val);
                      setField('customer_name', val);
                      setField('customer_id', match?.id || '');
                    }} placeholder="Search or type walk-in name" style={inp}/>
                    <datalist id="q-cust">
                      {customers.map(c => <option key={c.id} value={c.name} />)}
                    </datalist>
                  </Field>
                  <Field label="Currency">
                    <select value={current.currency} onChange={e => setField('currency', e.target.value)} style={inp}>
                      <option>K</option><option>USD</option><option>FRA</option>
                    </select>
                  </Field>
                </div>

                <div style={{ marginTop: 18 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1d4ed8' }}>Line Items</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Products the customer is quoting for</div>
                    </div>
                    <button onClick={addItem} style={{ ...btnRow, background: '#eff6ff', color: '#1d4ed8', borderColor: '#bfdbfe' }}><FiPlus size={12} /> Add Item</button>
                  </div>
                  <div style={{ background: '#f0f9ff', borderRadius: 10, border: '1px solid #bae6fd', overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#e0f2fe' }}>
                          <th style={mth}>Product</th><th style={mth}>Qty</th><th style={mth}>Unit</th>
                          <th style={mth}>Unit Price</th><th style={{ ...mth, textAlign: 'right' }}>Line</th><th style={{ ...mth, width: 30 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {current.items.map((it, i) => {
                          const q = parseFloat(it.quantity) || 0;
                          const p = parseFloat(it.unit_price) || 0;
                          const line = q * p;
                          return (
                            <tr key={i} style={{ borderTop: '1px solid #bae6fd' }}>
                              <td style={mtd}>
                                <input list={`q-prod-${i}`} value={it.product_name} onChange={e => {
                                  const v = e.target.value;
                                  const prod = products.find(x => x.name === v);
                                  if (prod) pickProduct(i, prod);
                                  else       setItem(i, 'product_name', v);
                                }} placeholder="Search…" style={{ ...inp, padding: '5px 8px', minWidth: 180 }}/>
                                <datalist id={`q-prod-${i}`}>
                                  {products.map(pr => <option key={pr.id} value={pr.name} />)}
                                </datalist>
                              </td>
                              <td style={mtd}><input type="number" step="0.01" value={it.quantity} onChange={e => setItem(i, 'quantity', e.target.value)} style={{ ...inp, padding: '5px 8px', width: 70 }}/></td>
                              <td style={mtd}><input value={it.unit} onChange={e => setItem(i, 'unit', e.target.value)} style={{ ...inp, padding: '5px 8px', width: 70 }}/></td>
                              <td style={mtd}><input type="number" step="0.01" value={it.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)} style={{ ...inp, padding: '5px 8px', width: 90 }}/></td>
                              <td style={{ ...mtd, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: '#0284c7' }}>{fmtCcy(line, current.currency)}</td>
                              <td style={mtd}>{current.items.length > 1 && <button onClick={() => removeItem(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 4 }}><FiX size={12}/></button>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginTop: 14, fontSize: 13, alignItems: 'center' }}>
                  <div style={{ textAlign: 'right', color: '#6b7280' }}>Subtotal</div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtCcy(subtotal, current.currency)}</div>
                  <div style={{ textAlign: 'right', color: '#6b7280' }}>Discount</div>
                  <div style={{ textAlign: 'right' }}><input type="number" step="0.01" value={current.discount} onChange={e => setField('discount', e.target.value)} style={{ ...inp, padding: '4px 8px', width: 110, textAlign: 'right' }}/></div>
                  <div style={{ textAlign: 'right', color: '#6b7280' }}>Tax</div>
                  <div style={{ textAlign: 'right' }}><input type="number" step="0.01" value={current.tax} onChange={e => setField('tax', e.target.value)} style={{ ...inp, padding: '4px 8px', width: 110, textAlign: 'right' }}/></div>
                  <div style={{ textAlign: 'right', fontWeight: 800, fontSize: 15, color: '#1d4ed8', borderTop: '1px dashed #e5e7eb', paddingTop: 6 }}>Grand Total</div>
                  <div style={{ textAlign: 'right', fontWeight: 800, fontSize: 15, color: '#1d4ed8', borderTop: '1px dashed #e5e7eb', paddingTop: 6, fontVariantNumeric: 'tabular-nums' }}>{fmtCcy(total, current.currency)}</div>
                </div>

                <div style={{ marginTop: 14 }}>
                  <Field label="Notes / Terms">
                    <textarea value={current.notes || ''} onChange={e => setField('notes', e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }}
                      placeholder="e.g. Valid 14 days · Prices exclude delivery"/>
                  </Field>
                </div>
              </div>
              <div style={{ padding: 14, borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={closeModal} style={btnGhost}>Cancel</button>
                <button onClick={save} disabled={saving} className="btn btn-primary" style={{ opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Saving…' : (modal === 'edit' ? 'Update Quotation' : 'Save Quotation')}
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* ── View Modal ── */}
      {modal === 'view' && current && (
        <Portal>
          <div style={overlay}>
            <div style={{ ...modalBox, maxWidth: 640 }}>
              <div style={{ ...modalHead, background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)' }}>
                <div>
                  <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', fontWeight: 700, marginBottom: 3 }}>Quotation</div>
                  <h3 style={{ margin: 0, fontSize: 17, color: '#fff', fontFamily: 'monospace' }}>{current.quote_number}</h3>
                  <p style={{ margin: '2px 0 0', fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>{current.customer_name || 'Walk-in'} · Valid until {current.valid_until}</p>
                </div>
                <button onClick={closeModal} style={closeBtn}><FiX size={16} /></button>
              </div>
              <div style={{ padding: 18, maxHeight: '75vh', overflowY: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      <th style={{ ...mth, background: 'transparent' }}>Product</th>
                      <th style={{ ...mth, background: 'transparent', textAlign: 'right' }}>Qty</th>
                      <th style={{ ...mth, background: 'transparent', textAlign: 'right' }}>Unit Price</th>
                      <th style={{ ...mth, background: 'transparent', textAlign: 'right' }}>Line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(current.items || []).map(it => (
                      <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={mtd}>{it.product_name}{it.unit ? ` (${it.unit})` : ''}</td>
                        <td style={{ ...mtd, textAlign: 'right' }}>{parseFloat(it.quantity).toLocaleString()}</td>
                        <td style={{ ...mtd, textAlign: 'right' }}>{fmtCcy(it.unit_price, current.currency)}</td>
                        <td style={{ ...mtd, textAlign: 'right', fontWeight: 700 }}>{fmtCcy(it.line_total, current.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, marginTop: 12, fontSize: 13, borderTop: '1px dashed #e5e7eb', paddingTop: 8 }}>
                  <div style={{ textAlign: 'right', color: '#6b7280' }}>Subtotal</div>
                  <div style={{ textAlign: 'right' }}>{fmtCcy(current.subtotal, current.currency)}</div>
                  <div style={{ textAlign: 'right', color: '#6b7280' }}>Discount</div>
                  <div style={{ textAlign: 'right' }}>{fmtCcy(current.discount, current.currency)}</div>
                  <div style={{ textAlign: 'right', color: '#6b7280' }}>Tax</div>
                  <div style={{ textAlign: 'right' }}>{fmtCcy(current.tax, current.currency)}</div>
                  <div style={{ textAlign: 'right', fontWeight: 800, color: '#1d4ed8', fontSize: 15 }}>Grand Total</div>
                  <div style={{ textAlign: 'right', fontWeight: 800, color: '#1d4ed8', fontSize: 15 }}>{fmtCcy(current.total, current.currency)}</div>
                </div>
                {current.notes && (
                  <div style={{ marginTop: 12, padding: 10, background: '#f8fafc', borderRadius: 6, fontSize: 12, color: '#374151' }}>
                    <strong>Notes:</strong> {current.notes}
                  </div>
                )}
              </div>
              <div style={{ padding: 14, borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={closeModal} style={btnGhost}>Close</button>
                <button onClick={() => printQuotation(current)} className="btn btn-primary"><FiPrinter size={14} /> Print</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      <Toast message={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />
    </div>
  );
}

function StatTile({ label, value, icon, bg }) {
  return (
    <div style={{
      borderRadius: 14, padding: '14px 18px', background: bg, color: '#fff',
      boxShadow: '0 4px 16px rgba(0,0,0,0.1)', position: 'relative', overflow: 'hidden',
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
      {icon}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
        <div style={{ fontSize: 28, fontWeight: 800 }}>{value}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</label>
      {children}
    </div>
  );
}

const inp        = { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const btnGhost   = { padding: '8px 14px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 };
const btnRow     = { padding: '5px 10px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 };
const grid2      = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const overlay    = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '20px 16px', overflowY: 'auto' };
const modalBox   = { background: '#fff', borderRadius: 14, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' };
const modalHead  = { padding: '18px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderRadius: '14px 14px 0 0' };
const closeBtn   = { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, cursor: 'pointer', color: '#fff', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const mth        = { padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#0369a1', fontWeight: 700, textAlign: 'left' };
const mtd        = { padding: '6px 10px', fontSize: 12, color: '#111827' };
