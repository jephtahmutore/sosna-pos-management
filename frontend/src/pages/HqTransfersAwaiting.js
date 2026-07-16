// HqTransfersAwaiting — v1.10.201, v1.10.208
// HQ-only queue of inter-branch transfers waiting for HQ to review and
// release. New transfers start in PENDING_HQ (see transfers.js POST /);
// destination branches don't see them until HQ releases. HQ can either:
//   - Attach one or more LCVs via + Add Delivery Cost, then Release
//   - Release with no delivery cost (explicit waiver)
// Once released → status flips to PENDING and the destination's Incoming
// tab shows it as before.
//
// v1.10.208 — moved the actions from inline row buttons into a View
// modal. Row now has a single [View] button; the modal shows items,
// attached LCVs, + Add Delivery Cost inline, and mutually-exclusive
// Release buttons (Release with Cost enabled only when LCVs exist;
// Release (no cost) enabled only when there are ZERO LCVs).
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiTruck, FiCheckCircle, FiPlus, FiEye, FiX } from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import LcvModal from '../components/LcvModal';
import {
  getTransfersAwaitingHqRelease, releaseTransfer, getPaymentVouchers,
} from '../services/api';

const fmtK = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtN = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqTransfersAwaiting() {
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [lcvByTransfer, setLcvByTransfer] = useState({});
  // v1.10.208 — the row the operator is currently viewing.
  const [viewingSyncId, setViewingSyncId] = useState(null);
  const viewing = rows.find(r => r.sync_id === viewingSyncId) || null;

  const refresh = () => {
    setLoading(true);
    getTransfersAwaitingHqRelease()
      .then(r => {
        const list = Array.isArray(r.data?.transfers) ? r.data.transfers : [];
        setRows(list);
        // Bulk-fetch each transfer's LCVs so the list shows a total
        // without opening every row. Parallel is fine at N ≤ 500.
        Promise.all(list.map(t =>
          getPaymentVouchers({ is_landed_cost: 1, linked_transfer_sync_id: t.sync_id })
            .then(res => ({
              sync_id: t.sync_id,
              lcvs: (Array.isArray(res.data) ? res.data : []).filter(l => !l.applied_to_transfer_sync_id),
            }))
            .catch(() => ({ sync_id: t.sync_id, lcvs: [] }))
        )).then(all => {
          const map = {};
          for (const r of all) {
            map[r.sync_id] = {
              lcvs: r.lcvs,
              total: r.lcvs.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0),
              count: r.lcvs.length,
            };
          }
          setLcvByTransfer(map);
        });
      })
      .catch(err => setError(err.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1><FiTruck style={{ verticalAlign: 'middle', marginRight: 8 }} />Transfers Awaiting HQ</h1>
          <p>Inter-branch transfers waiting for HQ to attach delivery cost (or waive it) before the destination can receive.</p>
        </div>
        <button onClick={refresh}
          style={{ padding: '8px 14px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: 12, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>{error}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 14, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10 }}>
          <div style={{ fontSize: 10, color: '#9a3412', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>Awaiting Review</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#7c2d12', marginTop: 4 }}>{rows.length}</div>
        </div>
      </div>

      <div className="data-table-container">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            No transfers waiting for HQ review. New branch-to-branch transfers will show up here.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Transfer #</th>
                <th>Route</th>
                <th>Sent By</th>
                <th style={{ textAlign: 'right' }}>Items</th>
                <th style={{ textAlign: 'right' }}>Delivery Cost</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const lcv = lcvByTransfer[r.sync_id] || { total: 0, count: 0 };
                return (
                  <tr key={r.sync_id}>
                    <td style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.transfer_number || r.sync_id.slice(0, 8)}</td>
                    <td>
                      <span style={{ fontWeight: 500 }}>{r.from_name || r.from_slug}</span>
                      <span style={{ color: '#9ca3af', margin: '0 6px' }}>→</span>
                      <span style={{ fontWeight: 500 }}>{r.to_name || r.to_slug}</span>
                    </td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>{r.created_by_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.total_items || (r.items || []).length}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: lcv.total > 0 ? '#c2410c' : '#9ca3af' }}>
                      {lcv.count > 0 ? <>{fmtK(lcv.total)} <span style={{ fontSize: 10, color: '#9a3412' }}>({lcv.count} LCV{lcv.count !== 1 ? 's' : ''})</span></> : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => setViewingSyncId(r.sync_id)}
                        title="Open transfer detail"
                        style={{ padding: '5px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiEye size={12} /> View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {viewing && (
        <ViewModal
          transfer={viewing}
          lcvData={lcvByTransfer[viewing.sync_id] || { lcvs: [], total: 0, count: 0 }}
          onClose={() => setViewingSyncId(null)}
          onRefresh={refresh}
          onReleased={() => { setViewingSyncId(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── View Modal ─────────────────────────────────────────────────────────────
// v1.10.208. Shows the items being transferred, the LCVs already attached,
// + Add Delivery Cost, and mutually-exclusive Release buttons.
function ViewModal({ transfer, lcvData, onClose, onRefresh, onReleased }) {
  const [showAddLcv, setShowAddLcv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useModalScrollLock(true);

  // Parse items from the transfer row (items_json or items[]).
  const items = (() => {
    try {
      if (transfer.items_json) {
        const raw = JSON.parse(transfer.items_json);
        return Array.isArray(raw) ? raw : [];
      }
      return Array.isArray(transfer.items) ? transfer.items : [];
    } catch { return []; }
  })();

  const totalValue = items.reduce((s, it) => {
    const q = parseFloat(it.quantity) || 0;
    const c = parseFloat(it.cost_price) || 0;
    return s + q * c;
  }, 0);

  // Mutually-exclusive rule per user's v1.10.203 confirmation:
  //   ≥1 LCV → Release with Cost enabled · Release (no cost) DISABLED
  //   0 LCVs → Release (no cost) enabled · Release with Cost DISABLED
  const hasLcv = lcvData.count > 0;
  const canReleaseWithCost = hasLcv && !busy;
  const canReleaseNoCost   = !hasLcv && !busy;

  const release = async (noCost) => {
    if (noCost) {
      if (!window.confirm(`Release ${transfer.transfer_number} with NO delivery cost?\n\nThe destination will receive with no LCV attached.`)) return;
    } else {
      if (!window.confirm(`Release ${transfer.transfer_number} with delivery cost ${fmtK(lcvData.total)}?\n\nThe destination will see it as ready to receive.`)) return;
    }
    setBusy(true);
    setError('');
    try {
      await releaseTransfer(transfer.sync_id, { no_cost: !!noCost });
      onReleased();
    } catch (err) {
      setError(err.response?.data?.error || 'Release failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Portal>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}
           onClick={() => !busy && onClose()}>
        <div onClick={e => e.stopPropagation()}
             style={{ background: '#fff', borderRadius: 12, width: 'min(920px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ margin: 0 }}>Transfer {transfer.transfer_number}</h3>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                From <strong>{transfer.from_name || transfer.from_slug}</strong> →
                To <strong>{transfer.to_name || transfer.to_slug}</strong>
                {transfer.created_by_name && <> · Sent by {transfer.created_by_name}</>}
                {transfer.created_at && <> · {new Date(transfer.created_at).toLocaleString()}</>}
              </div>
              {transfer.notes && (
                <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>Notes: <em>{transfer.notes}</em></div>
              )}
            </div>
            <button onClick={onClose} disabled={busy}
              style={{ background: 'none', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', color: '#64748b', fontSize: 22 }}>
              <FiX />
            </button>
          </div>

          <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
            {/* Items table */}
            {items.length === 0 ? (
              <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>This transfer has no items.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
                <thead style={{ background: '#f8fafc' }}>
                  <tr>
                    <th style={th}>Product</th>
                    <th style={th}>Unit</th>
                    <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                    <th style={{ ...th, textAlign: 'right' }}>Cost / unit</th>
                    <th style={{ ...th, textAlign: 'right' }}>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => {
                    const qty  = parseFloat(it.quantity) || 0;
                    const cost = parseFloat(it.cost_price) || 0;
                    const dispUnit = it.display_unit || it.unit;
                    const dispConv = parseFloat(it.display_conv || 1) || 1;
                    // Show qty in display unit so it matches what operator sent.
                    const qtyDisplay = dispConv > 0 ? qty / dispConv : qty;
                    return (
                      <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={td}><strong>{it.product_name}</strong></td>
                        <td style={{ ...td, color: '#475569' }}>{dispUnit || it.unit || '—'}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtN(qtyDisplay)}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtN(cost * dispConv)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtN(qty * cost)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700, background: '#f9fafb' }}>
                    <td colSpan={4} style={{ ...td, textAlign: 'right' }}>Transfer value</td>
                    <td style={{ ...td, textAlign: 'right', color: '#0f172a' }}>{fmtN(totalValue)}</td>
                  </tr>
                </tfoot>
              </table>
            )}

            {/* Delivery Costs Attached panel */}
            <div style={{ marginBottom: 14, padding: 12, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#7c2d12' }}>
                  Delivery Costs Attached ({lcvData.count})
                </div>
                <button type="button" onClick={() => setShowAddLcv(true)} disabled={busy}
                  style={{ padding: '5px 10px', background: '#c2410c', color: '#fff', border: 'none', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
                  <FiPlus size={12} /> Add Delivery Cost
                </button>
              </div>
              {lcvData.count === 0 ? (
                <div style={{ fontSize: 12, color: '#a8a29e', padding: '6px 4px' }}>
                  No delivery costs attached yet. Add one, or release without a cost below.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {lcvData.lcvs.map(l => (
                    <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#78350f', padding: '4px 8px', background: '#fffbeb', borderRadius: 4 }}>
                      <div>
                        <span style={{ color: '#9a3412', fontWeight: 600 }}>{l.paid_to || '—'}</span>
                        {l.description && <span style={{ color: '#a8a29e', marginLeft: 8 }}>· {l.description}</span>}
                        <span style={{ color: '#a8a29e', marginLeft: 8 }}>· {l.date}</span>
                      </div>
                      <div style={{ fontWeight: 700 }}>{fmtK(l.amount)}</div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, fontSize: 13, fontWeight: 700, color: '#c2410c' }}>
                    Delivery total: {fmtK(lcvData.total)}
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div style={{ padding: '10px 14px', background: '#fef2f2', color: '#dc2626', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{error}</div>
            )}

            {/* Explainer for the mutually-exclusive rule */}
            <div style={{ fontSize: 11.5, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '8px 12px', borderRadius: 8 }}>
              {hasLcv
                ? <>Delivery cost is attached — use <strong>Release with Cost</strong>. To release without any cost, delete the attached LCV first via the Cost of Delivery page.</>
                : <>No delivery cost attached — use <strong>Release (no cost)</strong> to waive, or click Add Delivery Cost above.</>}
            </div>
          </div>

          <div style={{ padding: '14px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={onClose} disabled={busy}
              style={{ padding: '8px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              Cancel
            </button>
            <button
              onClick={() => release(true)}
              disabled={!canReleaseNoCost}
              title={hasLcv ? 'Disabled — a delivery cost is attached, use Release with Cost instead' : 'Release with no delivery cost (waive)'}
              style={{
                padding: '8px 18px',
                background: canReleaseNoCost ? '#fff' : '#f3f4f6',
                color: canReleaseNoCost ? '#065f46' : '#9ca3af',
                border: `1px solid ${canReleaseNoCost ? '#a7f3d0' : '#e5e7eb'}`,
                borderRadius: 6,
                cursor: canReleaseNoCost ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              <FiCheckCircle size={14} /> Release (no cost)
            </button>
            <button
              onClick={() => release(false)}
              disabled={!canReleaseWithCost}
              title={hasLcv ? `Release with delivery cost ${fmtK(lcvData.total)}` : 'Disabled — no delivery cost attached, add one first or use Release (no cost)'}
              style={{
                padding: '8px 22px',
                background: canReleaseWithCost ? '#16a34a' : '#e5e7eb',
                color: canReleaseWithCost ? '#fff' : '#9ca3af',
                border: 'none',
                borderRadius: 6,
                cursor: canReleaseWithCost ? 'pointer' : 'not-allowed',
                fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              <FiCheckCircle size={14} /> {busy ? 'Releasing…' : 'Release with Cost'}
            </button>
          </div>
        </div>
      </div>

      {showAddLcv && (
        <LcvModal
          lockedRef={{ type: 'Transfer', syncId: transfer.sync_id }}
          onClose={() => setShowAddLcv(false)}
          onSaved={() => { setShowAddLcv(false); onRefresh(); }}
        />
      )}
    </Portal>
  );
}

const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.4 };
const td = { padding: '8px 10px', verticalAlign: 'middle' };
