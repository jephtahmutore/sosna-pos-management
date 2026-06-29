// IncomingStock — branch-side queue of HQ Purchase items for this branch.
// v1.3.0 splits the old one-click receive into a two-step workflow:
//   AWAITING_GRN  → branch enters actual qty + clicks "Submit GRN"
//   GRN_SUBMITTED → waiting for HQ to confirm; row shown read-only with
//                   the submitted qty + a "Waiting for HQ" badge.
// Stock only becomes sellable AFTER HQ confirms (separate page).
//
// "current branch" derivation matches StockTransfers: HQ X-Branch when
// on bare sosnazm.com, otherwise the host's first subdomain.
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiRefreshCw, FiCheckCircle, FiPackage, FiInbox, FiClock, FiXCircle } from 'react-icons/fi';
import {
  isHqHost, getHqBranch, getHqPurchaseIncoming, branchRejectPoLine,
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
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  // v1.9.7 — new flow: branch either Accepts (navigates to GRN form with
  // PO# pre-filled) or Rejects (opens a reason modal). The inline
  // "Submit GRN" receive modal is deprecated for HQ-PO lines.
  const [rejecting, setRejecting] = useState(null); // { item, reason, submitting }
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

  // v1.9.7 — Accept: navigate to GRN form pre-filled with PO context.
  // The GRN page reads ?from_purchase + ?purchase_number from the query
  // string, drops the PO# into Notes, and (on save) attaches
  // linked_purchase_sync_id so the GRN lands as PENDING_HQ_CONFIRM.
  const acceptAndGenerate = (it) => {
    const params = new URLSearchParams({
      from_purchase:   it.purchase_sync_id || '',
      purchase_number: it.purchase_number || '',
      supplier_id:     String(it.supplier_id || ''),
    });
    navigate(`/stock/grn?${params.toString()}`);
  };

  const submitReject = async () => {
    if (!rejecting) return;
    const reason = (rejecting.reason || '').trim();
    if (!reason) { flash('A rejection reason is required', 'error'); return; }
    setRejecting(r => ({ ...r, submitting: true }));
    try {
      await branchRejectPoLine(rejecting.item.id, reason);
      flash('PO line rejected. HQ has been notified.', 'success');
      setRejecting(null);
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Reject failed', 'error');
      setRejecting(r => ({ ...r, submitting: false }));
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
          <p>Submit GRN for what physically arrived. Stock becomes sellable only after HQ confirms · branch: <strong>{slug}</strong></p>
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
                  <th style={{ ...th, textAlign: 'right' }}>Expected</th>
                  <th style={{ ...th, textAlign: 'right' }}>Submitted</th>
                  <th style={th}>Status</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const isAwaiting  = it.status === 'AWAITING_GRN';
                  const isSubmitted = it.status === 'GRN_SUBMITTED';
                  return (
                    <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9', background: isSubmitted ? '#fffbeb' : '#fff' }}>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{it.purchase_number}</td>
                      <td style={td}>{it.purchase_date}</td>
                      <td style={td}>{it.supplier_name || '—'}</td>
                      <td style={td}>{it.product_name} <span style={{ color: '#94a3b8', fontSize: 11 }}>{it.unit}</span></td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtQty(it.dispatched_qty)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                        {it.received_qty == null ? '—' : fmtQty(it.received_qty)}
                      </td>
                      <td style={td}>
                        {isAwaiting && <span style={tag('#dbeafe', '#1e40af')}>Awaiting GRN</span>}
                        {isSubmitted && <span style={tag('#fef3c7', '#92400e')}><FiClock size={10} style={{ verticalAlign: 'middle' }} /> Waiting HQ</span>}
                      </td>
                      <td style={td}>
                        {isAwaiting && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => acceptAndGenerate(it)}
                              style={{ padding: '5px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <FiCheckCircle size={12} /> Accept &amp; Generate GRN
                            </button>
                            <button onClick={() => setRejecting({ item: it, reason: '', submitting: false })}
                              style={{ padding: '5px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <FiXCircle size={12} /> Reject
                            </button>
                          </div>
                        )}
                        {isSubmitted && it.variance_notes && (
                          <span style={{ fontSize: 11, color: '#92400e', fontStyle: 'italic' }}>
                            {it.variance_notes}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rejecting && (
        <RejectModal
          state={rejecting}
          setState={setRejecting}
          onCancel={() => setRejecting(null)}
          onSubmit={submitReject}
        />
      )}
    </div>
  );
}

// v1.9.7 — reason capture for branch-reject. Reason is mandatory; HQ
// sees it on the HQ Purchases list so they can re-route or cancel.
function RejectModal({ state, setState, onCancel, onSubmit }) {
  const { item, reason, submitting } = state;
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(440px, 92vw)', padding: 22 }}>
        <h3 style={{ margin: '0 0 6px 0', color: '#b91c1c' }}>Reject PO Line</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
          <strong>{item.product_name}</strong> on Purchase {item.purchase_number}.
        </p>
        <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#991b1b' }}>
          Rejecting removes this line from your incoming queue and notifies HQ. No stock change.
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={lbl}>Reason (required)</label>
          <input type="text" autoFocus value={reason}
            onChange={e => setState(s => ({ ...s, reason: e.target.value }))}
            placeholder="e.g. wrong branch / wrong product / supplier dispute" style={inp} />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onCancel} disabled={submitting}
            style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={onSubmit} disabled={submitting || !(reason || '').trim()}
            style={{ flex: 1, padding: '12px',
                     background: submitting ? '#94a3b8' : '#dc2626',
                     color: '#fff', border: 'none', borderRadius: 8,
                     cursor: submitting ? 'wait' : 'pointer', fontWeight: 700 }}>
            {submitting ? 'Rejecting…' : 'Reject Line'}
          </button>
        </div>
      </div>
    </div>
  );
}

// v1.9.7 — old ReceiveModal removed. Branches now Accept (which navigates
// to the GRN form pre-filled with PO#) or Reject (RejectModal above).
// The inline qty/reason submit path is gone.

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const tag = (bg, fg) => ({ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4, display: 'inline-flex', alignItems: 'center', gap: 4 });
