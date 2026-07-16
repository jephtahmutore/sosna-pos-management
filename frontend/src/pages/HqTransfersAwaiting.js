// HqTransfersAwaiting — v1.10.201
// HQ-only queue of inter-branch transfers waiting for HQ to review and
// release. New transfers start in PENDING_HQ (see transfers.js POST /);
// destination branches don't see them until HQ releases. HQ can either:
//   - Attach one or more LCVs via + Add Delivery Cost, then Release
//   - Release with no delivery cost (explicit waiver)
// Once released → status flips to PENDING and the destination's Incoming
// tab shows it as before.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiTruck, FiCheckCircle, FiPlus } from 'react-icons/fi';
import LcvModal from '../components/LcvModal';
import {
  getTransfersAwaitingHqRelease, releaseTransfer, getPaymentVouchers,
} from '../services/api';

const fmtK = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function HqTransfersAwaiting() {
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  // Per-row LCV totals + attach modal target
  const [lcvByTransfer, setLcvByTransfer] = useState({});
  const [attachTarget, setAttachTarget]   = useState(null); // transfer row
  const [busySync, setBusySync]           = useState(null);

  const refresh = () => {
    setLoading(true);
    getTransfersAwaitingHqRelease()
      .then(r => {
        const list = Array.isArray(r.data?.transfers) ? r.data.transfers : [];
        setRows(list);
        // Bulk-fetch each transfer's LCVs so the list can show a total
        // without opening each row. Parallel is fine at N ≤ 500.
        Promise.all(list.map(t =>
          getPaymentVouchers({ is_landed_cost: 1, linked_transfer_sync_id: t.sync_id })
            .then(res => ({
              sync_id: t.sync_id,
              total: (Array.isArray(res.data) ? res.data : [])
                .filter(l => !l.applied_to_transfer_sync_id)
                .reduce((s, l) => s + (parseFloat(l.amount) || 0), 0),
              count: (Array.isArray(res.data) ? res.data : [])
                .filter(l => !l.applied_to_transfer_sync_id).length,
            }))
            .catch(() => ({ sync_id: t.sync_id, total: 0, count: 0 }))
        )).then(all => {
          const map = {};
          for (const r of all) map[r.sync_id] = r;
          setLcvByTransfer(map);
        });
      })
      .catch(err => setError(err.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  const handleRelease = async (row, noCost) => {
    if (noCost) {
      if (!window.confirm(`Release ${row.transfer_number} with NO delivery cost?\n\nThe destination will receive with no LCV attached.`)) return;
    } else {
      const total = lcvByTransfer[row.sync_id]?.total || 0;
      if (total <= 0) {
        setError('No delivery cost attached. Add one first, or click "Release (no cost)" if there truly is none.');
        return;
      }
      if (!window.confirm(`Release ${row.transfer_number} with delivery cost K${total.toLocaleString(undefined, {minimumFractionDigits: 2})}?\n\nThe destination will see it as ready to receive.`)) return;
    }
    setBusySync(row.sync_id);
    setError('');
    try {
      await releaseTransfer(row.sync_id, { no_cost: !!noCost });
      refresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Release failed.');
    } finally {
      setBusySync(null);
    }
  };

  const total  = rows.length;

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
          <div style={{ fontSize: 20, fontWeight: 800, color: '#7c2d12', marginTop: 4 }}>{total}</div>
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
                const busy = busySync === r.sync_id;
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
                      <button onClick={() => setAttachTarget(r)} disabled={busy}
                        title="Attach a delivery cost to this transfer"
                        style={{ padding: '5px 10px', background: '#c2410c', color: '#fff', border: 'none', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, marginRight: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiPlus size={12} /> Add Cost
                      </button>
                      {lcv.total > 0 ? (
                        <button onClick={() => handleRelease(r, false)} disabled={busy}
                          title="Release with the attached delivery cost"
                          style={{ padding: '5px 10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <FiCheckCircle size={12} /> Release
                        </button>
                      ) : (
                        <button onClick={() => handleRelease(r, true)} disabled={busy}
                          title="Release without any delivery cost (waive)"
                          style={{ padding: '5px 10px', background: '#fff', color: '#065f46', border: '1px solid #a7f3d0', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <FiCheckCircle size={12} /> Release (no cost)
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {attachTarget && (
        <LcvModal
          lockedRef={{ type: 'Transfer', syncId: attachTarget.sync_id }}
          onClose={() => setAttachTarget(null)}
          onSaved={() => { setAttachTarget(null); refresh(); }}
        />
      )}
    </div>
  );
}
