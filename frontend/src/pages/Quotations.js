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
import { unitsForProduct, pickDisplayUnit } from '../utils/productUnits';

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

  // Print a single quotation — Cash Book report template (CashBook.js:634).
  // Same navy-underline header, bordered stat chips, bordered table, thin
  // grey footer — no rainbow bar, no coloured hero. Reads as a sibling of
  // the Cash Book Report rather than a stand-alone receipt.
  const printQuotation = async (row) => {
    let q = row;
    if (!q.items) {
      try { const res = await getQuotation(row.id); q = res.data; }
      catch (e) { showToast(e.response?.data?.error || 'Failed to load quote', 'error'); return; }
    }
    const biz = businessInfo;
    const bizName = biz.business_name || 'Business Name';
    const bizSub  = [biz.business_address, biz.business_phone, biz.business_email].filter(Boolean).join(' · ');
    const printedAt = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const fmt = (n) => fmtCcy(n, q.currency);
    const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
    const items = q.items || [];
    const itemsCount = items.length;
    const itemRows = items.length ? items.map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(it.product_name)}</td>
        <td style="text-align:center">${esc(it.unit || '—')}</td>
        <td style="text-align:right">${parseFloat(it.quantity).toLocaleString()}</td>
        <td style="text-align:right">${fmt(it.unit_price)}</td>
        <td style="text-align:right;font-weight:600">${fmt(it.line_total)}</td>
      </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:#9ca3af">No items</td></tr>`;
    const notesHtml = q.notes
      ? `<div class="notes"><div class="notes-lbl">Notes / Terms</div><div>${esc(q.notes)}</div></div>`
      : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quotation ${esc(q.quote_number)}</title><style>
      @page{size:A4 portrait;margin:15mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:11px;color:#1f2937}
      .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:3px solid #1e3a5f;margin-bottom:16px}
      .hdr-left .biz{font-size:20px;font-weight:900;color:#1e3a5f;letter-spacing:0.3px}
      .hdr-left .sub{font-size:10px;color:#6b7280;margin-top:4px}
      .hdr-right{text-align:right}
      .hdr-right .title{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b7280;margin-bottom:4px}
      .hdr-right .qno{font-size:15px;font-weight:800;color:#1e3a5f;font-family:monospace;letter-spacing:0.5px}
      .hdr-right .dates{font-size:11px;color:#374151;margin-top:3px;font-weight:600}
      .hdr-right .printed{font-size:9px;color:#9ca3af;margin-top:3px}
      .stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px}
      .stat{border:1.5px solid #d1d5db;border-radius:6px;padding:8px 12px}
      .stat-lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:3px}
      .stat-val{font-size:13px;font-weight:800}
      table{width:100%;border-collapse:collapse;font-size:10.5px}
      th{border:1px solid #d1d5db;padding:7px 9px;text-align:left;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;background:#f3f4f6;color:#1e3a5f}
      td{border:1px solid #e5e7eb;padding:6px 9px}
      .tot-row td{font-weight:700;border-top:2px solid #1e3a5f}
      .grand-row td{font-size:13px;font-weight:900;color:#1e3a5f;background:#eff6ff}
      .notes{margin-top:14px;padding:10px 14px;border:1px solid #fde68a;background:#fffbeb;border-radius:6px;font-size:10.5px;color:#78350f}
      .notes-lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#92400e;font-weight:700;margin-bottom:4px}
      .sigs{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:36px}
      .sig{text-align:center}
      .sig-line{height:32px;border-bottom:1.5px solid #cbd5e1;margin-bottom:6px}
      .sig-lbl{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280}
      .sig-hint{font-size:8.5px;color:#9ca3af;margin-top:2px}
      .ft{margin-top:16px;display:flex;justify-content:space-between;font-size:9px;color:#9ca3af;padding-top:8px;border-top:1px solid #e5e7eb}
    </style></head><body>
      <div class="hdr">
        <div class="hdr-left">
          <div class="biz">${esc(bizName)}</div>
          <div class="sub">${esc(bizSub)}</div>
          <div class="sub" style="margin-top:6px;color:#1e3a5f;font-weight:700">Quotation — Not a Tax Invoice</div>
        </div>
        <div class="hdr-right">
          <div class="title">Quote No.</div>
          <div class="qno">${esc(q.quote_number)}</div>
          <div class="dates">${esc(q.date)}</div>
          <div class="printed">Printed: ${printedAt}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-lbl">Customer</div><div class="stat-val" style="color:#1e3a5f">${esc(q.customer_name || 'Walk-in')}</div></div>
        <div class="stat"><div class="stat-lbl">Currency</div><div class="stat-val" style="color:#1e3a5f">${esc(q.currency)}</div></div>
        <div class="stat"><div class="stat-lbl">Quote Date</div><div class="stat-val" style="color:#1e3a5f">${esc(q.date)}</div></div>
        <div class="stat"><div class="stat-lbl">Valid Until</div><div class="stat-val" style="color:${q.valid_until < todayISO() ? '#dc2626' : '#1e3a5f'}">${esc(q.valid_until)}</div></div>
        <div class="stat"><div class="stat-lbl">Line Items</div><div class="stat-val">${itemsCount}</div></div>
        <div class="stat"><div class="stat-lbl">Grand Total</div><div class="stat-val" style="color:#16a34a">${fmt(q.total)}</div></div>
      </div>
      <table>
        <thead>
          <tr>
            <th style="width:32px">#</th>
            <th>Product</th>
            <th style="text-align:center;width:60px">Unit</th>
            <th style="text-align:right;width:70px">Qty</th>
            <th style="text-align:right;width:110px">Unit Price</th>
            <th style="text-align:right;width:120px">Line Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr class="tot-row"><td colspan="5" style="text-align:right">Subtotal</td><td style="text-align:right">${fmt(q.subtotal)}</td></tr>
          <tr class="tot-row"><td colspan="5" style="text-align:right">Discount</td><td style="text-align:right;color:#dc2626">${parseFloat(q.discount) > 0 ? '−' : ''}${fmt(q.discount)}</td></tr>
          <tr class="tot-row"><td colspan="5" style="text-align:right">Tax</td><td style="text-align:right">${fmt(q.tax)}</td></tr>
          <tr class="tot-row grand-row"><td colspan="5" style="text-align:right">GRAND TOTAL</td><td style="text-align:right">${fmt(q.total)}</td></tr>
        </tfoot>
      </table>
      ${notesHtml}
      <div class="sigs">
        <div class="sig"><div class="sig-line"></div><div class="sig-lbl">Prepared By</div><div class="sig-hint">Name / Signature / Date</div></div>
        <div class="sig"><div class="sig-line"></div><div class="sig-lbl">Customer Signature</div><div class="sig-hint">Name / Signature / Date</div></div>
      </div>
      <div class="ft"><span>${esc(bizName)} — Confidential</span><span>Printed: ${printedAt}</span></div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { showToast('Popup blocked — allow popups for this site to print.', 'error'); return; }
    w.document.write(html); w.document.close(); w.focus();
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
    // Default to the product's "display unit" (default_unit if set, else the
    // largest packaging — same rule used across POS / GRN / SIV). Unit price
    // auto-fills to that specific unit's price so quoting per Box vs per pcs
    // works out of the box.
    const chosen = pickDisplayUnit(product);
    setCurrent(prev => ({
      ...prev, items: prev.items.map((row, idx) => idx === i ? {
        ...row, product_id: product.id, product_name: product.name,
        unit: chosen.name || product.unit || 'pcs',
        unit_price: String(chosen.price || product.selling_price || 0),
      } : row),
    }));
  };
  // When the user swaps the unit dropdown, refresh unit_price to that unit's price.
  const pickUnit = (i, unitName) => {
    setCurrent(prev => ({
      ...prev, items: prev.items.map((row, idx) => {
        if (idx !== i) return row;
        const prod = products.find(p => p.id === row.product_id);
        const units = prod ? unitsForProduct(prod) : [];
        const chosen = units.find(u => u.name === unitName);
        return {
          ...row,
          unit: unitName,
          unit_price: chosen ? String(chosen.price || 0) : row.unit_price,
        };
      }),
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
                              <td style={mtd}>{(() => {
                                const prod = products.find(p => p.id === it.product_id);
                                const units = prod ? unitsForProduct(prod) : [];
                                if (units.length > 1) {
                                  return (
                                    <select value={it.unit || ''} onChange={e => pickUnit(i, e.target.value)}
                                      style={{ ...inp, padding: '5px 8px', width: 90 }}>
                                      {units.map(u => <option key={u.name} value={u.name}>{u.name}{u.is_base ? '' : ` (×${u.conv})`}</option>)}
                                    </select>
                                  );
                                }
                                return <input value={it.unit || ''} onChange={e => setItem(i, 'unit', e.target.value)} placeholder={prod?.unit || 'pcs'} style={{ ...inp, padding: '5px 8px', width: 70 }}/>;
                              })()}</td>
                              <td style={mtd}><input type="number" step="0.01" value={it.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)} style={{ ...inp, padding: '5px 8px', width: 90 }} title="Price per selected unit"/></td>
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
