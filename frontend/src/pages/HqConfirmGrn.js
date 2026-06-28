// HqConfirmGrn — HQ-side queue of branch-submitted GRN lines awaiting
// confirmation. Per v1.3.0 state machine the branch enters actual qty
// (status → GRN_SUBMITTED) but NO stock moves until HQ confirms here.
// On confirm: branch's products.current_stock bumps + a stock_movement
// row is minted on the branch DB + supplier AP locks in. On reject:
// line returns to AWAITING_GRN so the branch can recount and resubmit.
import React, { useEffect, useState } from 'react';
import {
  FiRefreshCw, FiCheck, FiX, FiInbox, FiAlertTriangle, FiEye,
} from 'react-icons/fi';
import {
  getHqGrnAwaitingConfirmation, confirmHqPurchaseItem, rejectHqPurchaseItem,
  getHqPurchase,
} from '../services/api';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqConfirmGrn() {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing]   = useState(null); // { item, mode: 'confirm'|'reject', notes }
  const [toast, setToast]     = useState(null);
  // v1.8.99 — View modal showing the FULL purchase (header + all line items),
  // not just the single line being confirmed. Loads lazily from
  // GET /api/hq/purchases/:id when the user clicks View.
  const [viewing, setViewing] = useState(null); // { purchase, items, loading } | null

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getHqGrnAwaitingConfirmation();
      setItems(r.data?.items || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);

  // v1.8.99 — View handler. Fetches the full purchase by id.
  const openView = async (it) => {
    setViewing({ purchase: { id: it.purchase_id, purchase_number: it.purchase_number }, items: [], loading: true });
    try {
      const r = await getHqPurchase(it.purchase_id);
      const data = r.data || {};
      setViewing({ purchase: data.purchase || { id: it.purchase_id, purchase_number: it.purchase_number }, items: data.items || [], loading: false });
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load purchase', 'error');
      setViewing(null);
    }
  };

  const submit = async () => {
    if (!acting) return;
    setActing(a => ({ ...a, submitting: true }));
    try {
      const call = acting.mode === 'confirm' ? confirmHqPurchaseItem : rejectHqPurchaseItem;
      await call(acting.item.id, { confirm_notes: acting.notes || null });
      flash(acting.mode === 'confirm'
        ? 'Confirmed — branch stock updated + AP locked.'
        : 'Sent back to branch for recount.', 'success');
      setActing(null);
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || `${acting.mode} failed`, 'error');
      setActing(a => ({ ...a, submitting: false }));
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Confirm GRNs</h1>
          <p>Branch-submitted GRNs waiting for HQ confirmation</p>
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
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiInbox /> Nothing waiting for confirmation.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Purchase #</th>
                  <th style={th}>Branch</th>
                  <th style={th}>Product</th>
                  <th style={{ ...th, textAlign: 'right' }}>Expected</th>
                  <th style={{ ...th, textAlign: 'right' }}>Branch said</th>
                  <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                  <th style={th}>Notes</th>
                  <th style={th}>Submitted</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const dispatched = parseFloat(it.dispatched_qty || 0);
                  const received   = parseFloat(it.received_qty || 0);
                  const variance   = received - dispatched;
                  const off        = Math.abs(variance) > 0.0001;
                  return (
                    <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9', background: off ? '#fffbeb' : '#fff' }}>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{it.purchase_number}</td>
                      <td style={td}>{it.destination_name || it.destination_slug}</td>
                      <td style={td}>{it.product_name} <span style={{ color: '#94a3b8', fontSize: 11 }}>{it.unit}</span></td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtQty(dispatched)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtQty(received)}</td>
                      <td style={{ ...td, textAlign: 'right', color: off ? '#b91c1c' : '#0f172a', fontWeight: off ? 700 : 400 }}>
                        {off ? (variance > 0 ? '+' : '') + variance.toFixed(2) : '0'}
                      </td>
                      <td style={{ ...td, fontSize: 12, color: '#64748b', maxWidth: 200 }}>
                        {it.variance_notes || '—'}
                      </td>
                      <td style={{ ...td, fontSize: 11, color: '#94a3b8' }}>
                        {it.received_at ? new Date(it.received_at).toLocaleString() : '—'}
                        {it.received_by_name ? <div>{it.received_by_name}</div> : null}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <button onClick={() => openView(it)} style={btn('#0ea5e9', true)}>
                          <FiEye size={12} /> View
                        </button>{' '}
                        <button onClick={() => setActing({ item: it, mode: 'confirm', notes: '', submitting: false })}
                          style={btn('#16a34a')}>
                          <FiCheck size={12} /> Confirm
                        </button>{' '}
                        <button onClick={() => setActing({ item: it, mode: 'reject', notes: '', submitting: false })}
                          style={btn('#dc2626', true)}>
                          <FiX size={12} /> Reject
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {acting && (
        <ActModal state={acting} setState={setActing} onCancel={() => setActing(null)} onSubmit={submit} />
      )}

      {viewing && (
        <ViewModal state={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

// v1.8.99 — View modal: full purchase (header + all items), read-only.
function ViewModal({ state, onClose }) {
  const { purchase, items, loading } = state;
  const totalDispatched = items.reduce((s, it) => s + (parseFloat(it.dispatched_qty) || 0), 0);
  const totalReceived   = items.reduce((s, it) => s + (parseFloat(it.received_qty)   || 0), 0);
  const totalValue      = items.reduce((s, it) => s + (parseFloat(it.dispatched_qty) || 0) * (parseFloat(it.cost_price) || 0), 0);
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(900px, 95vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Purchase {purchase.purchase_number}</h3>
            {purchase.supplier_name && (
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
                Supplier: <strong>{purchase.supplier_name}</strong>
                {purchase.invoice_number && <> · Invoice: <strong>{purchase.invoice_number}</strong></>}
                {purchase.date && <> · {purchase.date}</>}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <p style={{ color: '#64748b' }}>Loading…</p>
          ) : items.length === 0 ? (
            <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>No items on this purchase.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Product</th>
                  <th style={th}>Destination</th>
                  <th style={{ ...th, textAlign: 'right' }}>Dispatched</th>
                  <th style={{ ...th, textAlign: 'right' }}>Received</th>
                  <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Line $</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const dispatched = parseFloat(it.dispatched_qty || 0);
                  const received   = parseFloat(it.received_qty   || 0);
                  const variance   = received - dispatched;
                  const off        = Math.abs(variance) > 0.0001;
                  const cost       = parseFloat(it.cost_price || 0);
                  const lineValue  = dispatched * cost;
                  return (
                    <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9', background: off ? '#fffbeb' : '#fff' }}>
                      <td style={td}><strong>{it.product_name}</strong> <span style={{ color: '#94a3b8', fontSize: 11 }}>{it.unit}</span></td>
                      <td style={{ ...td, fontSize: 12 }}>{it.destination_slug}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtQty(dispatched)} {it.unit}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{it.received_qty != null ? `${fmtQty(received)} ${it.unit}` : '—'}</td>
                      <td style={{ ...td, textAlign: 'right', color: off ? '#b91c1c' : '#64748b', fontWeight: off ? 700 : 400 }}>
                        {it.received_qty != null ? (off ? (variance > 0 ? '+' : '') + variance.toFixed(2) : '0') : '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtMoney(cost)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(lineValue)}</td>
                      <td style={{ ...td, fontSize: 11 }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, background: it.status === 'CONFIRMED' ? '#dcfce7' : it.status === 'REJECTED' ? '#fee2e2' : it.status === 'GRN_SUBMITTED' ? '#fef3c7' : '#e0e7ff', color: it.status === 'CONFIRMED' ? '#166534' : it.status === 'REJECTED' ? '#991b1b' : it.status === 'GRN_SUBMITTED' ? '#92400e' : '#3730a3', fontWeight: 700 }}>
                          {it.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700 }}>
                  <td style={td} colSpan={2}>Totals</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtQty(totalDispatched)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtQty(totalReceived)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{(totalReceived - totalDispatched > 0 ? '+' : '') + (totalReceived - totalDispatched).toFixed(2)}</td>
                  <td style={td}></td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(totalValue)}</td>
                  <td style={td}></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '8px 22px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ActModal({ state, setState, onCancel, onSubmit }) {
  const { item, mode, notes, submitting } = state;
  const isConfirm = mode === 'confirm';
  const dispatched = parseFloat(item.dispatched_qty || 0);
  const received   = parseFloat(item.received_qty || 0);
  const variance   = received - dispatched;
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(500px, 92vw)', padding: 22 }}>
        <h3 style={{ margin: '0 0 6px 0' }}>{isConfirm ? 'Confirm GRN' : 'Reject GRN'}</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
          <strong>{item.product_name}</strong> · {item.destination_name || item.destination_slug} · Purchase {item.purchase_number}
        </p>

        <div style={{ marginTop: 14, padding: '10px 12px', background: '#f8fafc', borderRadius: 8, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Expected by HQ</span><strong>{fmtQty(dispatched)} {item.unit}</strong></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Branch counted</span><strong>{fmtQty(received)} {item.unit}</strong></div>
          {Math.abs(variance) > 0.0001 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#b91c1c', fontWeight: 700, marginTop: 4 }}>
              <span><FiAlertTriangle size={11} style={{ verticalAlign: 'middle' }} /> Variance</span>
              <strong>{variance > 0 ? '+' : ''}{variance.toFixed(2)}</strong>
            </div>
          )}
          {item.variance_notes && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#475569', fontStyle: 'italic' }}>Branch note: "{item.variance_notes}"</div>
          )}
        </div>

        {isConfirm ? (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6, fontSize: 12, color: '#065f46' }}>
            On confirm: <strong>{fmtQty(received)} {item.unit}</strong> goes to <strong>{item.destination_name || item.destination_slug}</strong>'s sales floor + supplier AP locks in (<strong>{fmtMoney(received * (parseFloat(item.cost_price) || 0))}</strong>).
          </div>
        ) : (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#991b1b' }}>
            Rejecting will send this line back to the branch as <strong>Awaiting GRN</strong>. They'll recount and resubmit.
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <label style={lbl}>{isConfirm ? 'Confirmation note (optional)' : 'Reason for reject *'}</label>
          <input type="text" value={notes}
            onChange={e => setState(s => ({ ...s, notes: e.target.value }))}
            placeholder={isConfirm ? 'Looks good · driver verified' : 'Recount needed — driver note shows 8 not 10'}
            style={inp} autoFocus />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onCancel} disabled={submitting}
            style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={onSubmit} disabled={submitting || (!isConfirm && !notes.trim())}
            style={{ flex: 1, padding: '12px',
                     background: submitting ? '#94a3b8'
                                : isConfirm ? 'linear-gradient(135deg,#16a34a,#15803d)'
                                            : 'linear-gradient(135deg,#dc2626,#991b1b)',
                     color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Working…' : isConfirm ? 'Confirm GRN' : 'Reject + Recount'}
          </button>
        </div>
      </div>
    </div>
  );
}

const btn = (color, outline) => ({
  padding: '5px 12px',
  background: outline ? '#fff' : color,
  color: outline ? color : '#fff',
  border: outline ? `1px solid ${color}` : 'none',
  borderRadius: 4, cursor: 'pointer',
  fontSize: 12, fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', gap: 4,
});
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
