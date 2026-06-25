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
  FiRefreshCw, FiPlus, FiTruck, FiInbox, FiCheckCircle, FiXCircle, FiTrash2,
} from 'react-icons/fi';
import {
  isHqHost, getHqBranch, getHqBranches, getBranchSlug,
  getTransferSourceProducts, getOutgoingTransfers, getIncomingTransfers,
  createTransfer, receiveTransfer, cancelTransfer,
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

  const doReceive = async (id) => {
    if (!window.confirm('Receive this transfer? Stock will be added to this branch.')) return;
    try {
      await receiveTransfer(id);
      flash('Stock received.', 'success');
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
          <TransferTable rows={out} loading={loading} direction="out" onCancel={doCancel} />
        ) : (
          <TransferTable rows={inc} loading={loading} direction="in" onReceive={doReceive} />
        )}
      </div>

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

function TransferTable({ rows, loading, direction, onReceive, onCancel }) {
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
                {direction === 'in' && t.status === 'PENDING' && (
                  <button onClick={() => onReceive(t.id)}
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

  const setQty = (p, qty) => {
    const n = parseFloat(qty) || 0;
    setCart(c => {
      const next = { ...c };
      if (n <= 0) delete next[p.sync_id];
      else next[p.sync_id] = { product: p, qty: n };
      return next;
    });
  };

  const cartItems = Object.values(cart);
  const totalValue = cartItems.reduce((s, x) => s + x.qty * (x.product.cost_price || 0), 0);

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
          unit:            x.product.unit,
          quantity:        x.qty,
          cost_price:      x.product.cost_price || 0,
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
                      // v1.8.40 — display in default unit + base in parens.
                      // Send Qty input still expects base unit (Bottle)
                      // — keeping the input label visible so user isn't
                      // confused which unit to type in.
                      const displayQty = formatStockForProduct(p.current_stock, p, {
                        showBaseInParens: true, decimals: 0,
                        allowNegative: true, preferDefaultUnit: true,
                      });
                      return (
                      <tr key={p.sync_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={tdS}>{p.name} <span style={{ color: '#94a3b8', fontSize: 10 }}>{p.unit}</span></td>
                        <td style={{ ...tdS, textAlign: 'right' }}>{displayQty}</td>
                        <td style={{ ...tdS, textAlign: 'right' }}>
                          <input type="number" min="0" step="any" placeholder={`0 ${p.unit}`}
                            value={cart[p.sync_id]?.qty || ''}
                            onChange={e => setQty(p, e.target.value)}
                            title={`Enter quantity in ${p.unit} (base unit)`}
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
                    {cartItems.map(x => (
                      <div key={x.product.sync_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 4px', borderBottom: '1px dashed #e5e7eb' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{x.product.name}</div>
                          <div style={{ fontSize: 10, color: '#64748b' }}>{fmtQty(x.qty)} {x.product.unit} × {fmtMoney(x.product.cost_price)}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <strong style={{ fontSize: 13 }}>{fmtMoney(x.qty * (x.product.cost_price || 0))}</strong>
                          <button onClick={() => setQty(x.product, 0)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}>
                            <FiTrash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
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
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase' };
const tdS = { padding: '6px 8px', color: '#0f172a' };
