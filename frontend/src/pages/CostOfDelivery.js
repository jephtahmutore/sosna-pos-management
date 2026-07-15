// CostOfDelivery — v1.10.185
// HQ-only page for booking delivery / transport / customs cost against a
// PO or an inter-branch transfer. Cash leaves the Cash Book on Save, but
// the amount is absorbed into the destination branch's WAC (via
// hqGrns.js /generate for POs, or transfers.js /receive for transfers).
// Excluded from profit-report Expenses to avoid double-counting.
//
// Backed by payment_vouchers rows with is_landed_cost=1 and either
// linked_purchase_sync_id OR linked_transfer_sync_id set. Uses the
// existing PV endpoints — no new backend routes needed.
import React, { useEffect, useState } from 'react';
import { FiPlus, FiRefreshCw, FiTruck, FiEdit2, FiTrash2 } from 'react-icons/fi';
import useModalScrollLock from '../utils/useModalScrollLock';
import LcvModal from '../components/LcvModal';
import {
  getPaymentVouchers, deletePaymentVoucher,
} from '../services/api';

const fmtK = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CostOfDelivery() {
  const [lcvs, setLcvs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  // v1.10.187 — edit target. Null = New; row = Edit that row's LCV.
  // Modal is reused for both flows; behaviour switches on the presence
  // of `editing`.
  const [editing, setEditing]   = useState(null);
  const [error, setError]       = useState('');
  useModalScrollLock(showModal);

  const refresh = () => {
    setLoading(true);
    getPaymentVouchers({ is_landed_cost: 1 })
      .then(r => setLcvs(Array.isArray(r.data) ? r.data : []))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const totalAmount = lcvs.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const pendingCount = lcvs.filter(l => !l.applied_to_grn_sync_id && !l.applied_to_transfer_sync_id).length;

  const handleDelete = async (l) => {
    if (!window.confirm(`Delete this delivery cost of K${parseFloat(l.amount || 0).toFixed(2)} to ${l.paid_to}?`)) return;
    try {
      await deletePaymentVoucher(l.id);
      refresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete.');
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1><FiTruck style={{ verticalAlign: 'middle', marginRight: 8 }} />Cost of Delivery</h1>
          <p>Transport, customs, and delivery fees absorbed into inventory WAC — not expenses.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => { setEditing(null); setShowModal(true); }}
            style={{ padding: '8px 14px', background: '#c2410c', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus size={14} /> New Delivery Cost
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>{error}</div>
      )}

      {/* Rollup cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 14, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10 }}>
          <div style={{ fontSize: 10, color: '#9a3412', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>Total Recorded</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#7c2d12', marginTop: 4 }}>{fmtK(totalAmount)}</div>
        </div>
        <div style={{ padding: 14, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10 }}>
          <div style={{ fontSize: 10, color: '#15803d', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>Applied</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#166534', marginTop: 4 }}>{lcvs.length - pendingCount}</div>
        </div>
        <div style={{ padding: 14, background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10 }}>
          <div style={{ fontSize: 10, color: '#92400e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>Pending (awaits GRN/receive)</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#78350f', marginTop: 4 }}>{pendingCount}</div>
        </div>
      </div>

      {/* Table */}
      <div className="data-table-container">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : lcvs.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            No delivery costs recorded yet. Click "New Delivery Cost" to add one.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th>Paid To</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Paid From</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {lcvs.map(l => {
                const isPO = !!l.linked_purchase_sync_id;
                const applied = isPO ? !!l.applied_to_grn_sync_id : !!l.applied_to_transfer_sync_id;
                return (
                  <tr key={l.id}>
                    <td>{l.date}</td>
                    <td>
                      <span style={{ padding: '2px 8px', fontSize: 11, fontWeight: 700, borderRadius: 20,
                        background: isPO ? '#dbeafe' : '#fef3c7',
                        color: isPO ? '#1d4ed8' : '#92400e' }}>
                        {isPO ? 'PO' : 'Transfer'}
                      </span>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#6b7280', marginLeft: 8 }}>
                        {(l.linked_purchase_sync_id || l.linked_transfer_sync_id || '').slice(0, 8)}…
                      </span>
                    </td>
                    <td>{l.paid_to}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#c2410c' }}>{fmtK(l.amount)}</td>
                    <td>{l.paid_from}</td>
                    <td>
                      <span style={{ padding: '2px 8px', fontSize: 11, fontWeight: 700, borderRadius: 20,
                        background: applied ? '#dcfce7' : '#fef3c7',
                        color: applied ? '#166534' : '#92400e' }}>
                        {applied ? 'Applied' : 'Pending'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {/* v1.10.187 — Edit/Delete only on Pending. Applied
                          LCVs are baked into WAC (server also rejects). */}
                      {applied ? (
                        <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>Locked</span>
                      ) : (
                        <>
                          <button onClick={() => { setEditing(l); setShowModal(true); }}
                            title="Edit"
                            style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#374151', marginRight: 6 }}>
                            <FiEdit2 size={12} />
                          </button>
                          <button onClick={() => handleDelete(l)}
                            title="Delete"
                            style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#dc2626' }}>
                            <FiTrash2 size={12} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <LcvModal
          editing={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

