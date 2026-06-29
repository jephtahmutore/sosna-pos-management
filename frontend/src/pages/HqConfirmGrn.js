// HqConfirmGrn — HQ queue of branch-submitted GRNs awaiting confirmation
// (v1.9.7 procurement flow). Branch creates a GRN linked to a HQ PO;
// stock is held until HQ approves here. On confirm: stock posts to the
// branch's sales floor + supplier AP locks in. On reject: GRN flips to
// REJECTED and the parent PO line returns to AWAITING_GRN so the branch
// can re-generate a fresh GRN.
import React, { useEffect, useState } from 'react';
import {
  FiRefreshCw, FiCheck, FiX, FiInbox, FiEye,
} from 'react-icons/fi';
import {
  getAwaitingHqGrns, getHqGrn, confirmHqGrn, rejectHqGrn,
} from '../services/api';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqConfirmGrn() {
  const [grns, setGrns]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing]   = useState(null); // { grn, mode: 'confirm'|'reject', notes }
  const [toast, setToast]     = useState(null);
  const [viewing, setViewing] = useState(null); // { grn, items, loading }

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getAwaitingHqGrns();
      setGrns(r.data?.grns || []);
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

  const openView = async (g) => {
    setViewing({ grn: g, items: [], loading: true });
    try {
      const r = await getHqGrn(g.branch_slug, g.sync_id);
      setViewing({ grn: r.data?.grn || g, items: r.data?.items || [], loading: false });
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load GRN', 'error');
      setViewing(null);
    }
  };

  const submit = async () => {
    if (!acting) return;
    const { grn, mode, notes } = acting;
    if (mode === 'reject' && !(notes || '').trim()) {
      flash('A rejection reason is required.', 'error');
      return;
    }
    setActing(a => ({ ...a, submitting: true }));
    try {
      if (mode === 'confirm') {
        await confirmHqGrn(grn.branch_slug, grn.sync_id, notes || null);
        flash('GRN confirmed — branch stock posted to sales floor + AP locked.', 'success');
      } else {
        await rejectHqGrn(grn.branch_slug, grn.sync_id, notes);
        flash('GRN rejected — branch can re-generate it.', 'success');
      }
      setActing(null);
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || `${mode} failed`, 'error');
      setActing(a => ({ ...a, submitting: false }));
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Confirm GRNs</h1>
          <p>Branch-submitted GRNs waiting for HQ confirmation. Confirm → stock posts to branch sales floor + supplier AP locks in.</p>
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
        {loading && grns.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : grns.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiInbox /> Nothing waiting for confirmation.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>GRN #</th>
                  <th style={th}>From PO</th>
                  <th style={th}>Branch</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Date</th>
                  <th style={{ ...th, textAlign: 'right' }}>Items</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  <th style={th}>Submitted</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {grns.map(g => (
                  <tr key={`${g.branch_slug}-${g.sync_id}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>{g.grn_number}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, color: '#64748b' }}>{g.linked_purchase_number || '—'}</td>
                    <td style={td}>{g.branch_name || g.branch_slug}</td>
                    <td style={td}>{g.supplier_name || '—'}</td>
                    <td style={td}>{g.date}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{g.total_items || 0}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(g.total_amount)}</td>
                    <td style={{ ...td, fontSize: 11, color: '#94a3b8' }}>
                      {g.created_at ? new Date(g.created_at).toLocaleString() : '—'}
                      {g.created_by_name ? <div>{g.created_by_name}</div> : null}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button onClick={() => openView(g)} style={btn('#0ea5e9', true)}>
                        <FiEye size={12} /> View
                      </button>{' '}
                      <button onClick={() => setActing({ grn: g, mode: 'confirm', notes: '', submitting: false })}
                        style={btn('#16a34a')}>
                        <FiCheck size={12} /> Confirm
                      </button>{' '}
                      <button onClick={() => setActing({ grn: g, mode: 'reject', notes: '', submitting: false })}
                        style={btn('#dc2626', true)}>
                        <FiX size={12} /> Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewing && (
        <ViewModal state={viewing} onClose={() => setViewing(null)} />
      )}

      {acting && (
        <ActModal state={acting} setState={setActing} onCancel={() => setActing(null)} onSubmit={submit} />
      )}
    </div>
  );
}

function ViewModal({ state, onClose }) {
  const { grn, items, loading } = state;
  const total = items.reduce((s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(880px, 95vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>GRN {grn.grn_number}</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
              {grn.linked_purchase_number && <>From PO: <strong>{grn.linked_purchase_number}</strong> · </>}
              Branch: <strong>{grn.branch_name || grn.branch_slug}</strong>
              {grn.supplier_name && <> · Supplier: <strong>{grn.supplier_name}</strong></>}
              {grn.date && <> · {grn.date}</>}
            </div>
            {grn.notes && (
              <div style={{ fontSize: 12, color: '#475569', marginTop: 4, fontStyle: 'italic' }}>Notes: {grn.notes}</div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <p style={{ color: '#64748b' }}>Loading…</p>
          ) : items.length === 0 ? (
            <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>No line items on this GRN.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Product</th>
                  <th style={th}>Unit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Line $</th>
                  <th style={{ ...th, textAlign: 'right' }}>Crates</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const qty = parseFloat(it.quantity || 0);
                  const cost = parseFloat(it.unit_price || 0);
                  const recv = parseFloat(it.containers_received || 0);
                  const ret  = parseFloat(it.containers_returned || 0);
                  return (
                    <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}><strong>{it.product_name || `#${it.product_id}`}</strong>{it.product_code && <span style={{ color: '#94a3b8', fontSize: 11 }}> ({it.product_code})</span>}</td>
                      <td style={td}>{it.unit || it.product_base_unit}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtQty(qty)}</td>
                      <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtMoney(cost)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(qty * cost)}</td>
                      <td style={{ ...td, textAlign: 'right', color: '#64748b', fontSize: 11 }}>
                        {recv > 0 ? `+${fmtQty(recv)}` : ''}{ret > 0 ? ` -${fmtQty(ret)}` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700 }}>
                  <td style={td} colSpan={4}>Total</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(grn.total_amount || total)}</td>
                  <td style={td}></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', textAlign: 'right' }}>
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
  const { grn, mode, notes, submitting } = state;
  const isConfirm = mode === 'confirm';
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(500px, 92vw)', padding: 22 }}>
        <h3 style={{ margin: '0 0 6px 0' }}>{isConfirm ? 'Confirm GRN' : 'Reject GRN'}</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
          GRN <strong>{grn.grn_number}</strong> · Branch <strong>{grn.branch_name || grn.branch_slug}</strong>
        </p>

        {isConfirm ? (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6, fontSize: 12, color: '#065f46' }}>
            On confirm: every line item posts to the branch's sales floor + supplier AP locks in (<strong>{fmtMoney(grn.total_amount)}</strong>). Stock becomes sellable immediately.
          </div>
        ) : (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#991b1b' }}>
            Rejecting sends the GRN back to the branch. The parent PO line returns to <strong>Awaiting GRN</strong> so they can re-generate a fresh GRN.
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <label style={lbl}>{isConfirm ? 'Confirmation note (optional)' : 'Reason for reject *'}</label>
          <input type="text" value={notes}
            onChange={e => setState(s => ({ ...s, notes: e.target.value }))}
            placeholder={isConfirm ? 'Looks good · driver verified' : 'e.g. credit notes missing, qty mismatch with invoice'}
            style={inp} autoFocus />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onCancel} disabled={submitting}
            style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={onSubmit} disabled={submitting || (!isConfirm && !(notes || '').trim())}
            style={{ flex: 1, padding: '12px',
                     background: submitting ? '#94a3b8'
                                : isConfirm ? 'linear-gradient(135deg,#16a34a,#15803d)'
                                            : 'linear-gradient(135deg,#dc2626,#991b1b)',
                     color: '#fff', border: 'none', borderRadius: 8, cursor: submitting ? 'wait' : 'pointer', fontWeight: 700 }}>
            {submitting ? 'Working…' : isConfirm ? 'Confirm GRN' : 'Reject GRN'}
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
