// HqProducts — HQ-owned product catalogue.
//
// HQ creates the canonical product list here; every registered branch
// gets a synced copy in its own products table (same sync_id linker).
// Each branch keeps its OWN selling price after the initial push; HQ
// can force-push new defaults to all branches by ticking the "override
// branch prices" box on edit / save.
//
// View modal shows per-branch override snapshot so HQ can spot
// branches that have drifted from the default pricing.
import React, { useEffect, useState } from 'react';
import {
  FiRefreshCw, FiPlus, FiEdit2, FiTrash2, FiEye, FiSearch,
  FiPackage, FiAlertTriangle, FiUpload,
} from 'react-icons/fi';
import {
  getHqProducts, getHqProduct, createHqProduct, updateHqProduct,
  deleteHqProduct, pushHqProduct,
} from '../services/api';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqProducts() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ]             = useState('');
  const [statusFilter, setStatusFilter] = useState('Active');
  const [showForm, setShowForm] = useState(null); // null | 'new' | row
  const [viewing, setViewing] = useState(null);
  const [toast, setToast]     = useState(null);

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getHqProducts({
        status: statusFilter || undefined,
        q: q || undefined,
      });
      setRows(r.data?.products || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter]);

  const openView = async (id) => {
    try {
      const r = await getHqProduct(id);
      setViewing(r.data);
    } catch (err) { flash('Failed to load detail', 'error'); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Deactivate "${row.name}"? Branches will mirror as Inactive but historical data stays.`)) return;
    try {
      await deleteHqProduct(row.id);
      flash('Product deactivated.', 'success');
      refresh();
    } catch (err) { flash(err?.response?.data?.error || 'Delete failed', 'error'); }
  };

  const repush = async (row) => {
    try {
      const r = await pushHqProduct(row.id, false);
      flash(`Pushed: +${r.data?.pushed || 0} created, ${r.data?.updated || 0} updated, ${r.data?.errors?.length || 0} errored.`, 'success');
    } catch (err) { flash(err?.response?.data?.error || 'Push failed', 'error'); }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Products</h1>
          <p>Master catalogue — pushed to every branch on save</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowForm('new')}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> New Product
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px' }}>
          <FiSearch size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input type="text" value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') refresh(); }}
            onBlur={refresh}
            placeholder="Search by name…"
            style={{ width: '100%', padding: '8px 10px 8px 30px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' }}>
          <option value="">All status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && rows.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiPackage /> No products yet. Click <strong>New Product</strong> to seed the catalogue.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Code</th>
                  <th style={th}>Name</th>
                  <th style={th}>Category</th>
                  <th style={th}>Unit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Default Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Default Selling</th>
                  <th style={{ ...th, textAlign: 'right' }}>Min Stock</th>
                  <th style={th}>Status</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', opacity: r.status === 'Inactive' ? 0.55 : 1 }}>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{r.code || '—'}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
                    <td style={td}>{r.category_name || '—'}</td>
                    <td style={td}>{r.unit}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(r.default_cost_price)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(r.default_selling_price)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtQty(r.min_stock)}</td>
                    <td style={td}>{statusBadge(r.status)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button onClick={() => openView(r.id)} style={btnIcon('#0ea5e9')}><FiEye size={12} /> View</button>
                      <button onClick={() => setShowForm(r)} style={btnIcon('#64748b')}><FiEdit2 size={12} /> Edit</button>
                      <button onClick={() => repush(r)} style={btnIcon('#16a34a')} title="Re-push to all branches"><FiUpload size={12} /></button>
                      <button onClick={() => remove(r)} style={btnIcon('#dc2626')}><FiTrash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <ProductForm
          existing={showForm === 'new' ? null : showForm}
          onClose={() => setShowForm(null)}
          onSaved={(report) => {
            setShowForm(null);
            const summary = report
              ? `+${report.pushed || 0} created, ${report.updated || 0} updated${report.errors?.length ? `, ${report.errors.length} errored` : ''}`
              : '';
            flash(`Saved. ${summary}`, 'success');
            refresh();
          }}
          onError={(m) => flash(m, 'error')}
        />
      )}

      {viewing && <DetailModal data={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function statusBadge(s) {
  const map = {
    Active:   ['#dcfce7', '#166534', 'Active'],
    Inactive: ['#fee2e2', '#991b1b', 'Inactive'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

function ProductForm({ existing, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    code:                 existing?.code                 || '',
    name:                 existing?.name                 || '',
    category_name:        existing?.category_name        || '',
    main_category_name:   existing?.main_category_name   || '',
    unit:                 existing?.unit                 || 'pcs',
    default_cost_price:   existing?.default_cost_price   ?? '',
    default_selling_price:existing?.default_selling_price?? '',
    min_stock:            existing?.min_stock            ?? '',
    status:               existing?.status               || 'Active',
    notes:                existing?.notes                || '',
  });
  const [overridePrices, setOverridePrices] = useState(false);
  const [submitting, setSubmitting]         = useState(false);
  const update = (field, v) => setForm(f => ({ ...f, [field]: v }));

  const submit = async () => {
    if (!form.name.trim()) return onError('Name is required');
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        default_cost_price:    parseFloat(form.default_cost_price)    || 0,
        default_selling_price: parseFloat(form.default_selling_price) || 0,
        min_stock:             parseFloat(form.min_stock)             || 0,
      };
      const res = existing
        ? await updateHqProduct(existing.id, payload, overridePrices)
        : await createHqProduct(payload);
      onSaved(res.data?.push);
    } catch (err) {
      onError(err?.response?.data?.error || 'Save failed');
    }
    setSubmitting(false);
  };

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(640px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{existing ? 'Edit Product' : 'New Product'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1, display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <Field label="Code"><input type="text" value={form.code} onChange={e => update('code', e.target.value)} placeholder="SKU" style={inp} /></Field>
            <Field label="Name *"><input type="text" value={form.name} onChange={e => update('name', e.target.value)} style={inp} autoFocus /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Category"><input type="text" value={form.category_name} onChange={e => update('category_name', e.target.value)} placeholder="e.g. Beer" style={inp} /></Field>
            <Field label="Main category"><input type="text" value={form.main_category_name} onChange={e => update('main_category_name', e.target.value)} placeholder="e.g. Beverage" style={inp} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <Field label="Unit"><input type="text" value={form.unit} onChange={e => update('unit', e.target.value)} style={inp} /></Field>
            <Field label="Default cost"><input type="number" step="any" min="0" value={form.default_cost_price} onChange={e => update('default_cost_price', e.target.value)} style={inp} /></Field>
            <Field label="Default selling"><input type="number" step="any" min="0" value={form.default_selling_price} onChange={e => update('default_selling_price', e.target.value)} style={inp} /></Field>
            <Field label="Min stock"><input type="number" step="any" min="0" value={form.min_stock} onChange={e => update('min_stock', e.target.value)} style={inp} /></Field>
          </div>
          <Field label="Notes"><input type="text" value={form.notes} onChange={e => update('notes', e.target.value)} style={inp} /></Field>
          {existing && (
            <Field label="Status">
              <select value={form.status} onChange={e => update('status', e.target.value)} style={inp}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </Field>
          )}

          <div style={{ padding: '10px 12px', background: existing ? '#fef3c7' : '#eff6ff', border: `1px solid ${existing ? '#fde68a' : '#bfdbfe'}`, borderRadius: 6, fontSize: 12 }}>
            <strong>What happens on save:</strong>{' '}
            {existing
              ? <>The product is updated, then pushed to every branch (name / unit / min stock / status / units_json). Branches keep their own cost + selling price unless you tick the box below.</>
              : <>The product is created and immediately pushed to every registered branch with HQ defaults. Branches can later override their own selling price.</>}
          </div>

          {existing && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569', cursor: 'pointer' }}>
              <input type="checkbox" checked={overridePrices} onChange={e => setOverridePrices(e.target.checked)} />
              <span><strong>Also force-push prices</strong> — overrides each branch's current cost + selling with HQ defaults.</span>
            </label>
          )}
        </div>
        <div style={{ padding: 14, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
          <button onClick={submit} disabled={submitting}
            style={{ padding: '10px 22px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Saving…' : 'Save + Push'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailModal({ data, onClose }) {
  const p = data.product;
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(720px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0 }}>{p.name}</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {p.code ? <span style={{ fontFamily: 'monospace' }}>{p.code} · </span> : null}
              {p.category_name || 'no category'} · {p.unit}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <Stat label="Default cost"    value={fmtMoney(p.default_cost_price)} />
            <Stat label="Default selling" value={fmtMoney(p.default_selling_price)} />
            <Stat label="Min stock"       value={fmtQty(p.min_stock)} />
            <Stat label="Status"          value={statusBadge(p.status)} />
          </div>
          <h4 style={{ margin: '14px 0 8px 0', fontSize: 13, color: '#0f172a' }}>Per-branch snapshot</h4>
          {data.branches?.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: 12 }}>No branches registered.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Branch</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Selling</th>
                  <th style={{ ...th, textAlign: 'right' }}>On hand</th>
                </tr>
              </thead>
              <tbody>
                {data.branches?.map(b => {
                  const costDrift   = b.found && Math.abs((b.cost_price    || 0) - (p.default_cost_price    || 0)) > 0.001;
                  const sellingDrift= b.found && Math.abs((b.selling_price || 0) - (p.default_selling_price || 0)) > 0.001;
                  return (
                    <tr key={b.slug} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>{b.name} <span style={{ color: '#94a3b8', fontSize: 11 }}>({b.slug})</span></td>
                      <td style={td}>
                        {b.error ? <span style={{ color: '#dc2626', fontSize: 11 }}><FiAlertTriangle size={11} /> {b.error}</span>
                                 : b.found ? <span style={{ color: '#166534' }}>Linked</span>
                                            : <span style={{ color: '#94a3b8' }}>Missing</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: costDrift ? '#b45309' : '#0f172a', fontWeight: costDrift ? 700 : 400 }}>{b.found ? fmtMoney(b.cost_price) : '—'}</td>
                      <td style={{ ...td, textAlign: 'right', color: sellingDrift ? '#b45309' : '#0f172a', fontWeight: sellingDrift ? 700 : 400 }}>{b.found ? fmtMoney(b.selling_price) : '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{b.found ? fmtQty(b.current_stock) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '8px 10px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '6px 10px', color: '#0f172a' };
const btnIcon = (color) => ({
  padding: '4px 8px', background: 'transparent', color, border: `1px solid ${color}33`, borderRadius: 4,
  cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3,
  marginRight: 4,
});
