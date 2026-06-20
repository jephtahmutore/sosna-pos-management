// IncomingStock — branch-side queue of PENDING HQ Purchase items where
// destination_slug = current branch. Operator counts what physically
// arrived and clicks Receive; we POST received_qty (with optional
// variance notes) and the backend mints the stock_movement + bumps
// products.current_stock on this branch's DB.
//
// "current branch" derivation matches StockTransfers: HQ X-Branch when
// on bare sosnazm.com, otherwise the host's first subdomain.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiCheckCircle, FiPackage, FiInbox } from 'react-icons/fi';
import {
  isHqHost, getHqBranch, getHqPurchaseIncoming, receiveHqPurchaseItem,
} from '../services/api';

function currentBranchSlug() {
  if (isHqHost()) return getHqBranch() || '';
  try { return window.location.hostname.split('.')[0]; }
  catch { return ''; }
}

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function IncomingStock() {
  const slug = currentBranchSlug();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [receiving, setReceiving] = useState(null); // { item, received_qty, notes }
  const [toast, setToast] = useState(null);

  const refresh = async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const r = await getHqPurchaseIncoming(slug);
      setItems(r.data?.items || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  useEffect(() => {
    if (!slug) return;
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  // eslint-disable-next-line
  }, [slug]);

  const openReceive = (it) => setReceiving({
    item: it,
    received_qty: String(it.dispatched_qty || ''),
    notes: '',
    submitting: false,
  });

  const submitReceive = async () => {
    if (!receiving) return;
    const qty = parseFloat(receiving.received_qty);
    if (!(qty >= 0)) { flash('Received qty must be 0 or more', 'error'); return; }
    setReceiving(r => ({ ...r, submitting: true }));
    try {
      await receiveHqPurchaseItem(receiving.item.id, {
        received_qty: qty,
        variance_notes: receiving.notes || null,
      });
      flash('Received — stock added to branch.', 'success');
      setReceiving(null);
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Receive failed', 'error');
      setReceiving(r => ({ ...r, submitting: false }));
    }
  };

  if (!slug) {
    return (
      <div className="page-content">
        <div className="page-header"><div><h1>Incoming Stock</h1></div></div>
        <p style={{ color: '#b91c1c' }}>No branch selected. Pick a branch in the HQ sidebar first.</p>
      </div>
    );
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Incoming Stock</h1>
          <p>HQ purchases waiting for confirmation · current branch: <strong>{slug}</strong></p>
        </div>
        <button onClick={refresh}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && items.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : items.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiInbox /> No pending incoming stock.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Purchase #</th>
                  <th style={th}>Date</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Product</th>
                  <th style={{ ...th, textAlign: 'right' }}>Dispatched</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={th}>Logged by</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{it.purchase_number}</td>
                    <td style={td}>{it.purchase_date}</td>
                    <td style={td}>{it.supplier_name || '—'}</td>
                    <td style={td}>{it.product_name} <span style={{ color: '#94a3b8', fontSize: 11 }}>{it.unit}</span></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtQty(it.dispatched_qty)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(it.cost_price)}</td>
                    <td style={{ ...td, color: '#64748b', fontSize: 11 }}>{it.hq_user || '—'}</td>
                    <td style={td}>
                      <button onClick={() => openReceive(it)}
                        style={{ padding: '5px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiCheckCircle size={12} /> Receive
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {receiving && (
        <ReceiveModal
          state={receiving}
          setState={setReceiving}
          onCancel={() => setReceiving(null)}
          onSubmit={submitReceive}
        />
      )}
    </div>
  );
}

function ReceiveModal({ state, setState, onCancel, onSubmit }) {
  const { item, received_qty, notes, submitting } = state;
  const dispatched = parseFloat(item.dispatched_qty || 0);
  const received   = parseFloat(received_qty) || 0;
  const variance   = received - dispatched;
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(520px, 92vw)', padding: 22 }}>
        <h3 style={{ margin: '0 0 6px 0' }}>Receive Stock</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
          <strong>{item.product_name}</strong> from <strong>{item.supplier_name || 'supplier'}</strong> · Purchase {item.purchase_number}
        </p>

        <div style={{ marginTop: 16 }}>
          <label style={lbl}>Dispatched by HQ</label>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
            {fmtQty(dispatched)} <span style={{ fontSize: 13, color: '#64748b', fontWeight: 500 }}>{item.unit}</span>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={lbl}>Actual received qty</label>
          <input type="number" min="0" step="any" value={received_qty}
            onChange={e => setState(s => ({ ...s, received_qty: e.target.value }))}
            style={{ ...inp, fontSize: 18, fontWeight: 700 }}
            autoFocus />
        </div>

        {Math.abs(variance) > 0.0001 && (
          <div style={{ marginTop: 8, padding: '8px 12px', background: variance < 0 ? '#fef2f2' : '#fef3c7', border: `1px solid ${variance < 0 ? '#fecaca' : '#fde68a'}`, borderRadius: 6, fontSize: 12 }}>
            <strong>{variance > 0 ? `+${fmtQty(variance)} over` : `${fmtQty(variance)} short`}</strong> vs dispatched — add a note below.
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <label style={lbl}>Notes (optional)</label>
          <input type="text" value={notes}
            onChange={e => setState(s => ({ ...s, notes: e.target.value }))}
            placeholder="Damage, short delivery, etc." style={inp} />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onCancel} disabled={submitting}
            style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={onSubmit} disabled={submitting}
            style={{ flex: 1, padding: '12px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Receiving…' : 'Confirm Receipt'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
