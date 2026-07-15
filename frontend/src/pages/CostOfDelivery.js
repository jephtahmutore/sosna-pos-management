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
import { FiPlus, FiRefreshCw, FiTruck } from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import {
  getPaymentVouchers, createPaymentVoucher,
  getHqPurchases, getPendingTransfersAll,
} from '../services/api';

const fmtK = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayStr = () => new Date().toISOString().split('T')[0];

export default function CostOfDelivery() {
  const [lcvs, setLcvs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
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
          <button onClick={() => setShowModal(true)}
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && <NewLcvModal onClose={() => setShowModal(false)} onSaved={() => { setShowModal(false); refresh(); }} />}
    </div>
  );
}

// ─── New Delivery Cost modal ────────────────────────────────────────────────
function NewLcvModal({ onClose, onSaved }) {
  const [refType, setRefType] = useState('PO'); // 'PO' | 'Transfer'
  const [openPOs, setOpenPOs] = useState([]);
  const [openTransfers, setOpenTransfers] = useState([]);
  const [form, setForm] = useState({
    date: todayStr(),
    linked_ref: '',
    paid_to: '',
    amount: '',
    paid_from: 'Cash Drawer',
    method: 'Cash', // Cash | Bank | Mobile Money — for K sub-drawer
    description: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    // v1.10.186 — both list endpoints return { purchases: [...] } /
    // { transfers: [...] }, not bare arrays. And /transfers/outgoing
    // requires a slug, so we use the HQ-wide /pending-all endpoint.
    getHqPurchases({ status: 'OPEN' })
      .then(r => setOpenPOs(Array.isArray(r.data?.purchases) ? r.data.purchases : []))
      .catch(() => setOpenPOs([]));
    getPendingTransfersAll()
      .then(r => setOpenTransfers(Array.isArray(r.data?.transfers) ? r.data.transfers : []))
      .catch(() => setOpenTransfers([]));
  }, []);

  // Reset the picker when switching type.
  useEffect(() => { setForm(f => ({ ...f, linked_ref: '' })); }, [refType]);

  const handleSave = async () => {
    setError('');
    const amt = parseFloat(form.amount || 0) || 0;
    if (!form.paid_to.trim()) return setError('Paid To is required.');
    if (!(amt > 0))            return setError('Amount must be greater than zero.');
    if (!form.linked_ref)      return setError(`Pick a ${refType} to attach the delivery cost to.`);
    setSaving(true);
    try {
      const kCash = form.method === 'Cash'         ? amt : 0;
      const kBank = form.method === 'Bank'         ? amt : 0;
      const kMomo = form.method === 'Mobile Money' ? amt : 0;
      await createPaymentVoucher({
        paid_to:      form.paid_to.trim(),
        description:  form.description.trim() || `Delivery cost for ${refType}`,
        category:     'Other',
        amount:       amt,
        k_amount:     amt,
        cash_amount:  kCash,
        bank_amount:  kBank,
        momo_amount:  kMomo,
        date:         form.date,
        paid_from:    'Cash Drawer',
        is_landed_cost:            true,
        linked_purchase_sync_id:   refType === 'PO'       ? form.linked_ref : null,
        linked_transfer_sync_id:   refType === 'Transfer' ? form.linked_ref : null,
      });
      onSaved && onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const refOptions = refType === 'PO' ? openPOs : openTransfers;
  const refLabel   = (r) => refType === 'PO'
    ? `${r.purchase_number} · ${r.supplier_name || 'no supplier'} · ${r.date}`
    : `${r.transfer_number || r.sync_id?.slice(0,8)} · ${r.from_name || r.from_slug} → ${r.to_name || r.to_slug} · ${r.created_at?.slice(0,10) || ''}`;

  return (
    <Portal>
      <div className="modal-overlay">
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>New Delivery Cost</h3>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
          <div className="modal-body">
            {error && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{error}</div>}

            <div style={{ padding: 10, background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 14, fontSize: 12, color: '#78350f' }}>
              Amount will be absorbed into the destination branch's inventory WAC.
              Cash leaves the Cash Book on save. Not booked as an expense.
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Attach to</label>
                <select value={refType} onChange={e => setRefType(e.target.value)}>
                  <option value="PO">Purchase (PO)</option>
                  <option value="Transfer">Inter-branch Transfer</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>{refType === 'PO' ? 'Purchase' : 'Transfer'} <span style={{ color: '#dc2626' }}>*</span></label>
              <select value={form.linked_ref} onChange={e => setForm({ ...form, linked_ref: e.target.value })}>
                <option value="">— pick a {refType} —</option>
                {refOptions.map(r => (
                  <option key={r.sync_id} value={r.sync_id}>{refLabel(r)}</option>
                ))}
              </select>
              {refOptions.length === 0 && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                  No open {refType === 'PO' ? 'purchases' : 'transfers'} available.
                </div>
              )}
            </div>

            <div className="form-group">
              <label>Paid To <span style={{ color: '#dc2626' }}>*</span></label>
              <input value={form.paid_to} onChange={e => setForm({ ...form, paid_to: e.target.value })} placeholder="Transporter name" />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Amount (K) <span style={{ color: '#dc2626' }}>*</span></label>
                <input type="number" min="0" step="0.01" value={form.amount}
                  onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
              </div>
              <div className="form-group">
                <label>Paid Via</label>
                <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>
                  <option value="Cash">Cash</option>
                  <option value="Bank">Bank</option>
                  <option value="Mobile Money">Mobile Money</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Description</label>
              <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Truck #, driver, invoice ref, etc." />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Delivery Cost'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
