// StockTransfers — universal page (HQ + per-branch) for moving stock
// between branches. Stored in master.db so both sides see one row.
//
// The "current branch" is derived from the host:
//   - HQ (sosnazm.com): use the X-Branch the operator picked in the
//     sidebar dropdown (localStorage 'hq.branch').
//   - Per-branch (kassumbalesa1.sosnazm.com): the host's first subdomain.
//
// Tabs:
//   Outgoing — transfers SENT from current branch. PENDING ones can be
//              cancelled (restores source stock).
//   Incoming — transfers HEADED TO current branch. PENDING ones can be
//              received (increments destination stock).
import React, { useEffect, useState, useMemo } from 'react';
import {
  FiRefreshCw, FiPlus, FiTruck, FiInbox, FiCheckCircle, FiXCircle, FiTrash2, FiEye, FiAlertTriangle,
} from 'react-icons/fi';
import {
  isHqHost, getHqBranch, getHqBranches, getBranchSlug,
  getTransferSourceProducts, getOutgoingTransfers, getIncomingTransfers,
  createTransfer, receiveTransfer, cancelTransfer,
  getProducts,
} from '../services/api';
// v1.8.40 — show On Hand in the product's configured default unit
// (e.g. Box) instead of the raw base unit (Bottle).
import { formatStockForProduct } from '../utils/unitFormat';

function currentBranchSlug() {
  if (isHqHost()) return getHqBranch() || '';
  // Electron's hostname is always "localhost" — use the slug cached at
  // boot from /api/sync/status's vpsUrl (set in App.js).
  try {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return getBranchSlug() || '';
    }
    return host.split('.')[0];
  } catch { return getBranchSlug() || ''; }
}

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function StockTransfers() {
  const slug = currentBranchSlug();
  const [tab, setTab] = useState('outgoing');
  const [out, setOut] = useState([]);
  const [inc, setInc] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState(null);
  // v1.8.64 — View/Receive modal. `viewing` carries the transfer row to show.
  // `mode='view'` is read-only; `mode='receive'` exposes the per-line received
  // qty + reason inputs and a Confirm Receive button (only for PENDING incoming).
  const [viewing, setViewing] = useState(null); // { transfer, mode }

  const refresh = async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const [o, i] = await Promise.all([
        getOutgoingTransfers({ slug }),
        getIncomingTransfers({ slug }),
      ]);
      setOut(o.data?.transfers || []);
      setInc(i.data?.transfers || []);
    } catch (err) {
      // non-fatal — page still renders
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!slug) return;
    refresh();
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  // eslint-disable-next-line
  }, [slug]);

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  // v1.8.64 — Open the View/Receive modal instead of accepting blindly.
  // For incoming + PENDING, the modal exposes per-line received qty +
  // reason so the receiver can record shortages / damage / loss before
  // confirming. Anything else opens read-only.
  const doReceive = (transfer) => {
    setViewing({ transfer, mode: transfer.status === 'PENDING' ? 'receive' : 'view' });
  };
  const doView = (transfer) => {
    setViewing({ transfer, mode: 'view' });
  };
  const submitReceive = async (id, payload) => {
    try {
      const res = await receiveTransfer(id, payload);
      const hadVariance = res?.data?.status === 'RECEIVED_WITH_VARIANCE';
      flash(hadVariance ? 'Stock received with variance — HQ notified.' : 'Stock received.', 'success');
      setViewing(null);
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Receive failed', 'error');
    }
  };

  const doCancel = async (id) => {
    if (!window.confirm('Cancel this transfer? Stock will be returned to the source branch.')) return;
    try {
      await cancelTransfer(id);
      flash('Transfer cancelled.', 'success');
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Cancel failed', 'error');
    }
  };

  if (!slug) {
    return (
      <div className="page-content">
        <div className="page-header"><div><h1>Stock Transfers</h1></div></div>
        <p style={{ color: '#b91c1c' }}>No branch selected. Pick a branch in the HQ sidebar first.</p>
      </div>
    );
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Stock Transfers</h1>
          <p>Move stock between branches · current branch: <strong>{slug}</strong></p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> Send Transfer
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

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: '#f1f5f9', borderRadius: 8, padding: 3, width: 'fit-content' }}>
        <TabButton active={tab === 'outgoing'} onClick={() => setTab('outgoing')}>
          <FiTruck /> Outgoing ({out.filter(t => t.status === 'PENDING').length} pending)
        </TabButton>
        <TabButton active={tab === 'incoming'} onClick={() => setTab('incoming')}>
          <FiInbox /> Incoming ({inc.filter(t => t.status === 'PENDING').length} pending)
        </TabButton>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {tab === 'outgoing' ? (
          <TransferTable rows={out} loading={loading} direction="out" onCancel={doCancel} onView={doView} />
        ) : (
          <TransferTable rows={inc} loading={loading} direction="in" onReceive={doReceive} onView={doView} />
        )}
      </div>

      {viewing && (
        <TransferDetailModal
          transfer={viewing.transfer}
          mode={viewing.mode}
          onClose={() => setViewing(null)}
          onSubmit={(payload) => submitReceive(viewing.transfer.id, payload)}
        />
      )}

      {showCreate && (
        <CreateTransferModal
          sourceSlug={slug}
          branches={branches}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); flash('Transfer sent.', 'success'); refresh(); }}
          onError={(msg) => flash(msg, 'error')}
        />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: active ? '#fff' : 'transparent', color: active ? '#0f172a' : '#64748b',
        fontWeight: active ? 700 : 500, fontSize: 13,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
      }}>{children}</button>
  );
}

function TransferTable({ rows, loading, direction, onReceive, onCancel, onView }) {
  if (loading && rows.length === 0) return <p style={{ color: '#64748b' }}>Loading…</p>;
  if (rows.length === 0) return <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>No transfers.</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead style={{ background: '#f8fafc' }}>
          <tr>
            <th style={th}>Transfer #</th>
            <th style={th}>{direction === 'out' ? 'To' : 'From'}</th>
            <th style={{ ...th, textAlign: 'right' }}>Items</th>
            <th style={{ ...th, textAlign: 'right' }}>Value</th>
            <th style={th}>Status</th>
            <th style={th}>Created</th>
            <th style={th}>By</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(t => (
            <tr key={t.id} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{t.transfer_number}</td>
              <td style={td}>
                <strong>{direction === 'out' ? t.to_name : t.from_name}</strong>{' '}
                <span style={{ color: '#94a3b8', fontSize: 11 }}>({direction === 'out' ? t.to_slug : t.from_slug})</span>
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{t.total_items}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(t.total_value)}</td>
              <td style={td}>{statusBadge(t.status)}</td>
              <td style={td}>{t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</td>
              <td style={td}>{t.created_by_name || '—'}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'inline-flex', gap: 6 }}>
                  {/* v1.8.64 — View always visible. Receive routes through
                      the same modal so the user can verify items + record
                      shortages/damage before confirming. */}
                  <button onClick={() => onView(t)}
                    style={{ padding: '5px 12px', background: '#fff', color: '#0369a1', border: '1px solid #bae6fd', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <FiEye size={12} /> View
                  </button>
                  {direction === 'in' && t.status === 'PENDING' && (
                    <button onClick={() => onReceive(t)}
                      style={{ padding: '5px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <FiCheckCircle size={12} /> Receive
                    </button>
                  )}
                  {direction === 'out' && t.status === 'PENDING' && (
                    <button onClick={() => onCancel(t.id)}
                      style={{ padding: '5px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <FiXCircle size={12} /> Cancel
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateTransferModal({ sourceSlug, branches, onClose, onCreated, onError }) {
  const [toSlug, setToSlug] = useState('');
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState({}); // { product_sync_id: { product, qty } }
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getTransferSourceProducts(sourceSlug)
      .then(r => setProducts(r.data?.products || []))
      .catch(err => onError(err?.response?.data?.error || 'Failed to load products'));
  // eslint-disable-next-line
  }, [sourceSlug]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? products.filter(p => (p.name || '').toLowerCase().includes(q)) : products;
  }, [products, search]);

  // v1.8.47 — input + cart speak the product's configured default unit
  // (e.g. Box) instead of always the base unit (Bottle). cart.qty is the
  // value the user typed *in that unit*. We convert to base only at
  // submit time so the backend math (conversionToBase) stays identical.
  const getDisplayUnit = (p) => {
    const baseName = p?.unit || '';
    let units = null;
    if (p?.units_json) {
      try { units = JSON.parse(p.units_json); } catch { units = null; }
    }
    if (!Array.isArray(units) || units.length === 0) return { name: baseName, conv: 1 };
    const defaultName = (p?.default_unit || '').trim().toLowerCase();
    if (!defaultName) return { name: baseName, conv: 1 };
    const match = units.find(u => (u.name || '').toLowerCase() === defaultName && parseFloat(u.conv) > 0);
    return match ? { name: match.name, conv: parseFloat(match.conv) } : { name: baseName, conv: 1 };
  };

  const setQty = (p, qty) => {
    const n = parseFloat(qty) || 0;
    setCart(c => {
      const next = { ...c };
      if (n <= 0) delete next[p.sync_id];
      else {
        const u = getDisplayUnit(p);
        next[p.sync_id] = { product: p, qty: n, unitName: u.name, unitConv: u.conv };
      }
      return next;
    });
  };

  const cartItems = Object.values(cart);
  // qty is in display unit; cost_price is per base unit — multiply by conv.
  const totalValue = cartItems.reduce((s, x) => s + x.qty * (x.unitConv || 1) * (x.product.cost_price || 0), 0);

  const submit = async () => {
    if (!toSlug)          return onError('Pick a destination branch');
    if (cartItems.length === 0) return onError('Add at least one product');
    setSubmitting(true);
    try {
      await createTransfer({
        from_slug: sourceSlug,
        to_slug:   toSlug,
        notes,
        items: cartItems.map(x => ({
          product_sync_id: x.product.sync_id,
          product_name:    x.product.name,
          // Always send in base unit — backend conversionToBase(prod, unit)
          // expects (qty, unit) to be self-consistent. Easiest: convert here.
          unit:            x.product.unit,
          quantity:        x.qty * (x.unitConv || 1),
          cost_price:      x.product.cost_price || 0,
          // v1.8.66 — carry the product's default-unit metadata so the
          // View / Receive modal can render qty + cost in the configured
          // default unit (e.g. Box) instead of the raw base unit (Bottle).
          // Stored verbatim in items_json; backend math is unchanged.
          display_unit:    x.unitName || x.product.unit,
          display_conv:    x.unitConv || 1,
        })),
      });
      onCreated();
    } catch (err) {
      onError(err?.response?.data?.error || 'Failed to send');
    }
    setSubmitting(false);
  };

  const destChoices = branches.filter(b => b.slug !== sourceSlug);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(880px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Send Transfer · from <span style={{ color: '#0ea5e9' }}>{sourceSlug}</span></h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={lbl}>To Branch</label>
              <select value={toSlug} onChange={e => setToSlug(e.target.value)} style={inp}>
                <option value="">— pick a destination —</option>
                {destChoices.map(b => <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Notes (optional)</label>
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Truck #, driver, etc." style={inp} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
            {/* Product picker */}
            <div>
              <label style={lbl}>Products at {sourceSlug}</label>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                style={{ ...inp, marginBottom: 8 }} />
              <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: '#f8fafc', position: 'sticky', top: 0 }}>
                    <tr><th style={thS}>Product</th><th style={{ ...thS, textAlign: 'right' }}>On Hand</th><th style={{ ...thS, textAlign: 'right', width: 100 }}>Send Qty</th></tr>
                  </thead>
                  <tbody>
                    {filtered.map(p => {
                      // v1.8.47 — both On Hand display and Send Qty input now
                      // use the product's configured default unit (e.g. Box).
                      const displayQty = formatStockForProduct(p.current_stock, p, {
                        showBaseInParens: true, decimals: 0,
                        allowNegative: true, preferDefaultUnit: true,
                      });
                      const dispUnit = getDisplayUnit(p);
                      return (
                      <tr key={p.sync_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={tdS}>{p.name} <span style={{ color: '#94a3b8', fontSize: 10 }}>{p.unit}</span></td>
                        <td style={{ ...tdS, textAlign: 'right' }}>{displayQty}</td>
                        <td style={{ ...tdS, textAlign: 'right' }}>
                          <input type="number" min="0" step="any" placeholder={`0 ${dispUnit.name}`}
                            value={cart[p.sync_id]?.qty || ''}
                            onChange={e => setQty(p, e.target.value)}
                            title={`Enter quantity in ${dispUnit.name}`}
                            style={{ width: 80, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'right' }} />
                        </td>
                      </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr><td colSpan={3} style={{ ...tdS, color: '#94a3b8', fontStyle: 'italic', padding: 16 }}>No products match.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Cart preview */}
            <div>
              <label style={lbl}>Cart ({cartItems.length} line{cartItems.length === 1 ? '' : 's'})</label>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#f8fafc', minHeight: 250 }}>
                {cartItems.length === 0 ? (
                  <p style={{ color: '#94a3b8', fontSize: 12, fontStyle: 'italic', textAlign: 'center', margin: '40px 0' }}>Enter quantities in the table to build the transfer.</p>
                ) : (
                  <>
                    {cartItems.map(x => {
                      const unitName = x.unitName || x.product.unit;
                      const conv     = x.unitConv || 1;
                      const perUnit  = (x.product.cost_price || 0) * conv;
                      const lineTotal= x.qty * perUnit;
                      return (
                        <div key={x.product.sync_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 4px', borderBottom: '1px dashed #e5e7eb' }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{x.product.name}</div>
                            <div style={{ fontSize: 10, color: '#64748b' }}>{fmtQty(x.qty)} {unitName} × {fmtMoney(perUnit)}</div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <strong style={{ fontSize: 13 }}>{fmtMoney(lineTotal)}</strong>
                            <button onClick={() => setQty(x.product, 0)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}>
                              <FiTrash2 size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 8, borderTop: '1px solid #cbd5e1' }}>
                      <strong>Total value</strong>
                      <strong>{fmtMoney(totalValue)}</strong>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: 14, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={submitting || !toSlug || cartItems.length === 0}
            style={{ padding: '10px 22px',
                     background: !toSlug || cartItems.length === 0 || submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
                     display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiTruck /> {submitting ? 'Sending…' : 'Send Transfer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function statusBadge(s) {
  const map = {
    'PENDING':   ['#fef3c7', '#92400e', 'Pending'],
    'RECEIVED':  ['#dcfce7', '#166534', 'Received'],
    'CANCELLED': ['#fee2e2', '#991b1b', 'Cancelled'],
    'RECEIVED_WITH_VARIANCE': ['#fef3c7', '#92400e', 'Received · Variance'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

// v1.8.64 — Transfer detail modal. Two modes:
//   'view'    — read-only summary (any transfer, any status)
//   'receive' — receiver's confirmation flow. Per-line inputs for
//               received_qty + reason (OK/Short/Damaged/Lost) + notes,
//               with a live variance preview. Submits to /receive.
const REASON_OPTIONS = [
  { value: 'OK',      label: 'OK (qty matches)' },
  { value: 'Short',   label: 'Short (fewer arrived)' },
  { value: 'Damaged', label: 'Damaged' },
  { value: 'Lost',    label: 'Lost in transit' },
];

function TransferDetailModal({ transfer, mode, onClose, onSubmit }) {
  const items = useMemo(() => {
    try {
      const raw = transfer.items_json ? JSON.parse(transfer.items_json) : (Array.isArray(transfer.items) ? transfer.items : []);
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }, [transfer]);

  // v1.8.92 — pull the product list so we can resolve each line's CURRENT
  // default_unit (e.g. Box), instead of whatever unit was used at send time.
  // Old behaviour: if a transfer was sent in Bottle (1 conv), the detail
  // modal also showed Bottle — wrong for products whose preferred display
  // is Box. Now we always render in the product's configured default_unit.
  // Falls back to items_json's display_unit (then base unit) if the product
  // can't be found in the response (deleted, sync gap, etc).
  const [products, setProducts] = useState([]);
  useEffect(() => {
    getProducts()
      .then(r => setProducts(Array.isArray(r.data) ? r.data : (r.data?.products || [])))
      .catch(() => setProducts([]));
  }, []);
  const productBySync = useMemo(() => {
    const m = {};
    for (const p of products) if (p.sync_id) m[p.sync_id] = p;
    return m;
  }, [products]);
  const getDisplayFor = (it) => {
    const p = productBySync[it.product_sync_id];
    if (p) {
      const baseName = (p.unit || '').toLowerCase();
      const defaultName = (p.default_unit || '').trim();
      if (defaultName && defaultName.toLowerCase() !== baseName) {
        try {
          const units = JSON.parse(p.units_json || '[]');
          const match = (Array.isArray(units) ? units : []).find(u =>
            (u.name || '').toLowerCase() === defaultName.toLowerCase() && parseFloat(u.conv) > 0);
          if (match) return { unit: match.name, conv: parseFloat(match.conv) };
        } catch { /* fall through */ }
      }
      return { unit: p.unit, conv: 1 };
    }
    return { unit: it.display_unit || it.unit, conv: parseFloat(it.display_conv || 1) || 1 };
  };

  // Per-line edit state — receive mode only.
  // v1.8.66 — qty + cost displayed in the product's default unit (Box).
  // Initial state uses items_json's display info; useEffect below replaces
  // it with the product's current default_unit once products arrive.
  const [lines, setLines] = useState(() =>
    items.map(it => {
      const dispUnit = it.display_unit || it.unit;
      const dispConv = parseFloat(it.display_conv || 1) || 1;
      const sentBase = parseFloat(it.quantity || 0);
      const sentDisp = sentBase / dispConv;
      return {
        product_sync_id: it.product_sync_id,
        product_name:    it.product_name,
        unit:            it.unit,          // base unit (Bottle)
        display_unit:    dispUnit,         // friendly unit (Box)
        display_conv:    dispConv,         // 1 Box = N Bottle
        cost_price:      parseFloat(it.cost_price || 0),    // per BASE unit
        cost_display:    parseFloat(it.cost_price || 0) * dispConv, // per Box
        sent_qty:        sentDisp,         // shown in display unit
        received_qty:    String(sentDisp), // shown in display unit
        reason:          'OK',
        notes:           '',
      };
    })
  );

  // v1.8.92 — once products load, swap each line's display_unit/conv for the
  // product's CURRENT default_unit. Preserves any received_qty the user typed
  // by converting it to the new unit.
  useEffect(() => {
    if (products.length === 0) return;
    setLines(prev => prev.map((l, i) => {
      const it = items[i];
      if (!it) return l;
      const { unit: newUnit, conv: newConv } = getDisplayFor(it);
      if (l.display_unit === newUnit && Math.abs((l.display_conv || 1) - newConv) < 0.0001) return l;
      const sentBase = parseFloat(it.quantity || 0);
      const oldConv = parseFloat(l.display_conv) || 1;
      const wasUntouched = String(parseFloat(l.received_qty) || 0) === String(parseFloat(l.sent_qty) || 0);
      const recvBaseIfTouched = (parseFloat(l.received_qty) || 0) * oldConv;
      return {
        ...l,
        display_unit: newUnit,
        display_conv: newConv,
        cost_display: parseFloat(l.cost_price || 0) * newConv,
        sent_qty:     sentBase / newConv,
        received_qty: wasUntouched ? String(sentBase / newConv) : String(recvBaseIfTouched / newConv),
      };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productBySync]);
  const [submitting, setSubmitting] = useState(false);

  const setLine = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  // Auto-bump the reason when received_qty changes vs sent_qty.
  const onReceivedChange = (idx, value) => {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const recv = parseFloat(value || 0);
      const isOk = !isNaN(recv) && Math.abs(recv - l.sent_qty) < 0.0001;
      const next = { ...l, received_qty: value };
      // Only auto-flip the reason if the user hasn't manually set something
      // more specific (Damaged / Lost) — preserve their explicit choice.
      if (l.reason === 'OK' || l.reason === 'Short') {
        next.reason = isOk ? 'OK' : 'Short';
      }
      return next;
    }));
  };

  const totalSent = lines.reduce((s, l) => s + (parseFloat(l.sent_qty) || 0), 0);
  const totalRecv = lines.reduce((s, l) => s + (parseFloat(l.received_qty) || 0), 0);
  const totalVar  = totalSent - totalRecv;
  const anyVariance = lines.some(l => {
    const v = (parseFloat(l.sent_qty) || 0) - (parseFloat(l.received_qty) || 0);
    return v > 0.0001 || l.reason === 'Damaged' || l.reason === 'Lost';
  });

  const submit = async () => {
    setSubmitting(true);
    try {
      // v1.8.66 — received_qty is in display unit (Box); backend expects
      // base units (Bottle). Multiply by display_conv before sending.
      const payload = {
        received_lines: lines.map(l => ({
          product_sync_id: l.product_sync_id,
          received_qty:    Math.max(0, (parseFloat(l.received_qty) || 0) * (parseFloat(l.display_conv) || 1)),
          reason:          l.reason || 'OK',
          notes:           l.notes || null,
        })),
      };
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  };

  const isReceive = mode === 'receive';
  const fmtQ = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, width: 'min(900px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>{isReceive ? 'Receive Transfer' : 'Transfer Detail'} · {transfer.transfer_number}</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
              From <strong>{transfer.from_name || transfer.from_slug}</strong> → To <strong>{transfer.to_name || transfer.to_slug}</strong>
              {transfer.created_by_name && <> · Sent by {transfer.created_by_name}</>}
              {transfer.created_at && <> · {new Date(transfer.created_at).toLocaleString()}</>}
            </div>
            {transfer.notes && (
              <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>Notes: <em>{transfer.notes}</em></div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && (
            <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>This transfer has no items.</p>
          )}
          {items.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Item</th>
                  <th style={{ ...th, textAlign: 'right' }}>Sent</th>
                  <th style={{ ...th, textAlign: 'right' }}>{isReceive ? 'Received' : 'Received'}</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Notes</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost / unit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Line $</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  const recvNum = parseFloat(l.received_qty) || 0;
                  const variance = (parseFloat(l.sent_qty) || 0) - recvNum;
                  // v1.8.66 — cost shown is per-display-unit (per Box) so
                  // the line total = received_qty (in Box) × cost_per_Box.
                  // Numerically identical to received_base × cost_per_base
                  // — just easier to read.
                  const dispUnit = l.display_unit || l.unit;
                  const lineDollar = recvNum * (parseFloat(l.cost_display || l.cost_price) || 0);
                  const hasIssue = variance > 0.0001 || l.reason === 'Damaged' || l.reason === 'Lost';
                  return (
                    <tr key={idx} style={{ borderTop: '1px solid #f1f5f9', background: hasIssue ? '#fffbeb' : '#fff' }}>
                      <td style={td}><strong>{l.product_name}</strong> <span style={{ color: '#94a3b8', fontSize: 11 }}>{l.unit}</span></td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtQ(l.sent_qty)} {dispUnit}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {isReceive ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <input type="number" min="0" step="any" value={l.received_qty}
                              onChange={e => onReceivedChange(idx, e.target.value)}
                              style={{ width: 80, padding: '4px 6px', border: `1px solid ${hasIssue ? '#fbbf24' : '#d1d5db'}`, borderRadius: 4, fontSize: 13, textAlign: 'right' }} />
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>{dispUnit}</span>
                          </div>
                        ) : (
                          <span style={{ fontWeight: 600 }}>{fmtQ(l.received_qty)} {dispUnit}</span>
                        )}
                      </td>
                      <td style={td}>
                        {isReceive ? (
                          <select value={l.reason} onChange={e => setLine(idx, 'reason', e.target.value)}
                            style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, background: '#fff' }}>
                            {REASON_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        ) : (
                          <span style={{ fontSize: 12, color: hasIssue ? '#b45309' : '#16a34a' }}>{l.reason}</span>
                        )}
                      </td>
                      <td style={td}>
                        {isReceive ? (
                          <input value={l.notes} onChange={e => setLine(idx, 'notes', e.target.value)}
                            placeholder={hasIssue ? 'e.g. crate broken on arrival' : ''}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }} />
                        ) : (
                          <span style={{ fontSize: 12, color: '#475569' }}>{l.notes || '—'}</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>
                        {fmtMoney(l.cost_display || l.cost_price)}
                        <div style={{ fontSize: 10, color: '#cbd5e1' }}>/ {dispUnit}</div>
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(lineDollar)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700 }}>
                  <td style={td}>Totals</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtQ(totalSent)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtQ(totalRecv)}</td>
                  <td colSpan={2} style={{ ...td, color: totalVar > 0.001 ? '#b45309' : '#475569' }}>
                    {totalVar > 0.001 ? `Variance: ${fmtQ(totalVar)}` : ''}
                  </td>
                  <td colSpan={2} style={{ ...td, textAlign: 'right' }}>{fmtMoney(transfer.total_value)}</td>
                </tr>
              </tfoot>
            </table>
          )}

          {isReceive && anyVariance && (
            <div style={{ marginTop: 14, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <FiAlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>Variance detected.</strong> Confirming will book only the received qty into your stock. The shortfall will be recorded in Transit Variance for HQ to investigate. Make sure the reason + notes are accurate before you confirm.
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '8px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            {isReceive ? 'Cancel' : 'Close'}
          </button>
          {isReceive && (
            <button onClick={submit} disabled={submitting || items.length === 0}
              style={{ padding: '8px 22px', background: submitting ? '#94a3b8' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FiCheckCircle size={14} /> {submitting ? 'Receiving…' : (anyVariance ? 'Confirm Receive with Variance' : 'Confirm Receive')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase' };
const tdS = { padding: '6px 8px', color: '#0f172a' };
