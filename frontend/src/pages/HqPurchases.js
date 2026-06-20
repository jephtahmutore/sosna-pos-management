// HqPurchases — HQ-side procurement page. HQ has no physical warehouse;
// each line of a purchase has a destination_slug picking which branch
// will offload the goods. Lines sit PENDING until the destination branch
// confirms with actual received qty in their Incoming Stock queue.
import React, { useEffect, useMemo, useState } from 'react';
import {
  FiRefreshCw, FiPlus, FiPackage, FiTrash2, FiEye,
} from 'react-icons/fi';
import {
  getHqBranches, getHqPurchases, getHqPurchase, createHqPurchase,
} from '../services/api';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HqPurchases() {
  const [purchases, setPurchases] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [toast, setToast] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getHqPurchases(statusFilter ? { status: statusFilter } : undefined);
      setPurchases(r.data?.purchases || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
  }, []);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter]);

  const openDetail = async (id) => {
    try {
      const r = await getHqPurchase(id);
      setViewing(r.data);
    } catch (err) { flash(err?.response?.data?.error || 'Failed to load detail', 'error'); }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Purchases</h1>
          <p>Supplier purchases routed directly to branches · HQ holds no stock</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={inp}>
            <option value="">All status</option>
            <option value="OPEN">Open (pending lines)</option>
            <option value="COMPLETED">Completed</option>
          </select>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> New Purchase
          </button>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && purchases.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : purchases.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiPackage /> No purchases yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Purchase #</th>
                  <th style={th}>Date</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Invoice #</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  <th style={th}>Lines</th>
                  <th style={th}>Status</th>
                  <th style={th}>By</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {purchases.map(p => (
                  <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{p.purchase_number}</td>
                    <td style={td}>{p.date}</td>
                    <td style={td}>{p.supplier_name || '—'}</td>
                    <td style={td}>{p.invoice_number || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(p.total_amount)}</td>
                    <td style={td}>
                      <span style={{ color: '#0f172a', fontWeight: 600 }}>{p.items_received}/{p.items_total}</span>
                      {p.items_pending > 0 && <span style={{ color: '#92400e', fontSize: 11, marginLeft: 6 }}>({p.items_pending} pending)</span>}
                    </td>
                    <td style={td}>{statusBadge(p.status)}</td>
                    <td style={td}>{p.created_by_name || '—'}</td>
                    <td style={td}>
                      <button onClick={() => openDetail(p.id)}
                        style={{ padding: '4px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiEye size={12} /> View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <CreatePurchaseModal
          branches={branches}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); flash('Purchase saved.', 'success'); refresh(); }}
          onError={(m) => flash(m, 'error')}
        />
      )}

      {viewing && (
        <DetailModal data={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

function statusBadge(s) {
  const map = {
    OPEN:      ['#fef3c7', '#92400e', 'Open'],
    COMPLETED: ['#dcfce7', '#166534', 'Completed'],
    CANCELLED: ['#fee2e2', '#991b1b', 'Cancelled'],
    PENDING:   ['#fef3c7', '#92400e', 'Pending'],
    RECEIVED:  ['#dcfce7', '#166534', 'Received'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

function CreatePurchaseModal({ branches, onClose, onCreated, onError }) {
  const [supplier, setSupplier] = useState('');
  const [invoice, setInvoice]   = useState('');
  const [date, setDate]         = useState(todayISO());
  const [notes, setNotes]       = useState('');
  const [items, setItems]       = useState([newItem(branches[0]?.slug || '')]);
  const [submitting, setSubmitting] = useState(false);

  function newItem(defaultSlug = '') {
    return { product_name: '', unit: 'pcs', dispatched_qty: '', cost_price: '', destination_slug: defaultSlug };
  }

  const updateItem = (i, field, value) => {
    setItems(arr => arr.map((it, idx) => idx === i ? { ...it, [field]: value } : it));
  };
  const addItem = () => setItems(arr => [...arr, newItem(branches[0]?.slug || '')]);
  const removeItem = (i) => setItems(arr => arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr);

  const totalAmount = useMemo(() => items.reduce((s, it) => {
    const q = parseFloat(it.dispatched_qty) || 0;
    const c = parseFloat(it.cost_price) || 0;
    return s + q * c;
  }, 0), [items]);

  const submit = async () => {
    const clean = items
      .map(it => ({
        product_name:     (it.product_name || '').trim(),
        unit:             it.unit || null,
        dispatched_qty:   parseFloat(it.dispatched_qty) || 0,
        cost_price:       parseFloat(it.cost_price) || 0,
        destination_slug: it.destination_slug,
      }))
      .filter(it => it.product_name && it.dispatched_qty > 0 && it.destination_slug);
    if (clean.length === 0) return onError('Add at least one valid item');
    setSubmitting(true);
    try {
      await createHqPurchase({
        supplier_name: supplier || null,
        invoice_number: invoice || null,
        date,
        notes: notes || null,
        items: clean,
      });
      onCreated();
    } catch (err) {
      onError(err?.response?.data?.error || 'Failed to save');
    }
    setSubmitting(false);
  };

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(960px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>New HQ Purchase</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div><label style={lbl}>Supplier name</label><input type="text" value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="e.g. Sosna Distributors Ltd" style={inp} /></div>
            <div><label style={lbl}>Invoice #</label><input type="text" value={invoice} onChange={e => setInvoice(e.target.value)} placeholder="INV-2026-…" style={inp} /></div>
            <div><label style={lbl}>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={inp} /></div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Notes</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Truck #, driver, PO ref, etc." style={inp} />
          </div>

          <label style={{ ...lbl, fontSize: 13 }}>Items (each line goes to ONE branch)</label>
          <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={thS}>Product</th>
                  <th style={{ ...thS, width: 70 }}>Unit</th>
                  <th style={{ ...thS, textAlign: 'right', width: 90 }}>Qty</th>
                  <th style={{ ...thS, textAlign: 'right', width: 100 }}>Cost</th>
                  <th style={{ ...thS, textAlign: 'right', width: 110 }}>Line Total</th>
                  <th style={{ ...thS, width: 180 }}>Destination</th>
                  <th style={{ ...thS, width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const lineTotal = (parseFloat(it.dispatched_qty) || 0) * (parseFloat(it.cost_price) || 0);
                  return (
                    <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={tdS}><input type="text" value={it.product_name} onChange={e => updateItem(i, 'product_name', e.target.value)} placeholder="Product name" style={cellInp} /></td>
                      <td style={tdS}><input type="text" value={it.unit} onChange={e => updateItem(i, 'unit', e.target.value)} style={cellInp} /></td>
                      <td style={tdS}><input type="number" min="0" step="any" value={it.dispatched_qty} onChange={e => updateItem(i, 'dispatched_qty', e.target.value)} style={{ ...cellInp, textAlign: 'right' }} /></td>
                      <td style={tdS}><input type="number" min="0" step="any" value={it.cost_price} onChange={e => updateItem(i, 'cost_price', e.target.value)} style={{ ...cellInp, textAlign: 'right' }} /></td>
                      <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(lineTotal)}</td>
                      <td style={tdS}>
                        <select value={it.destination_slug} onChange={e => updateItem(i, 'destination_slug', e.target.value)} style={cellInp}>
                          <option value="">— branch —</option>
                          {branches.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
                        </select>
                      </td>
                      <td style={tdS}>
                        <button onClick={() => removeItem(i)} disabled={items.length === 1}
                          style={{ background: 'none', border: 'none', color: items.length === 1 ? '#cbd5e1' : '#dc2626', cursor: items.length === 1 ? 'not-allowed' : 'pointer', padding: 2 }}>
                          <FiTrash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button onClick={addItem}
            style={{ marginTop: 8, padding: '6px 12px', background: '#f1f5f9', color: '#0f172a', border: '1px dashed #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FiPlus size={12} /> Add line
          </button>

          <div style={{ marginTop: 14, padding: '10px 14px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, display: 'flex', justifyContent: 'space-between' }}>
            <strong style={{ color: '#0c4a6e' }}>Purchase total</strong>
            <strong style={{ color: '#0c4a6e', fontSize: 17 }}>{fmtMoney(totalAmount)}</strong>
          </div>
        </div>

        <div style={{ padding: 14, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={submitting}
            style={{ padding: '10px 22px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Saving…' : 'Save Purchase'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailModal({ data, onClose }) {
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(900px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>{data.purchase_number}</h3>
            <div style={{ fontSize: 12, color: '#64748b' }}>{data.supplier_name || 'Supplier —'} · Invoice {data.invoice_number || '—'} · {data.date}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <Pill label="Status" value={statusBadge(data.status)} />
            <Pill label="Total" value={<strong>{fmtMoney(data.total_amount)}</strong>} />
            <Pill label="Lines" value={`${fmtInt(data.items?.length || 0)}`} />
            <Pill label="By" value={data.created_by_name || '—'} />
          </div>
          {data.notes && <p style={{ background: '#f8fafc', padding: 10, borderRadius: 6, fontSize: 13, color: '#475569' }}>{data.notes}</p>}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={th}>Product</th>
                <th style={th}>Destination</th>
                <th style={{ ...th, textAlign: 'right' }}>Dispatched</th>
                <th style={{ ...th, textAlign: 'right' }}>Received</th>
                <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                <th style={th}>Status</th>
                <th style={th}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {(data.items || []).map(it => {
                const variance = it.status === 'RECEIVED' && it.received_qty !== it.dispatched_qty;
                return (
                  <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9', background: variance ? '#fffbeb' : '#fff' }}>
                    <td style={td}>{it.product_name} <span style={{ color: '#94a3b8', fontSize: 11 }}>{it.unit}</span></td>
                    <td style={td}>{it.destination_name || it.destination_slug}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{parseFloat(it.dispatched_qty).toFixed(2)}</td>
                    <td style={{ ...td, textAlign: 'right', color: variance ? '#b91c1c' : '#0f172a', fontWeight: variance ? 700 : 400 }}>
                      {it.received_qty == null ? '—' : parseFloat(it.received_qty).toFixed(2)}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(it.cost_price)}</td>
                    <td style={td}>{statusBadge(it.status)}</td>
                    <td style={{ ...td, color: '#64748b' }}>{it.variance_notes || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Pill({ label, value }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: '6px 12px' }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const cellInp = { width: '100%', padding: '5px 7px', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 12, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase' };
const tdS = { padding: '4px 6px', color: '#0f172a' };
