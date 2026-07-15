// LcvModal — v1.10.188
// Shared New / Edit Landed Cost Voucher modal. Extracted from
// CostOfDelivery.js so the Generate GRN modal can invoke it inline
// with the PO pre-locked (see HqConfirmGrn.js).
//
// Modes:
//   - editing   : row object → Edit mode, link + type immutable
//   - lockedRef : { type: 'PO' | 'Transfer', syncId } → New mode with
//                 the reference pre-selected and locked (no picker).
//                 Used from Generate GRN where the PO is implicit.
//   - neither   : New mode, picker visible.
import React, { useEffect, useState } from 'react';
import Portal from '../utils/Portal';
import {
  createPaymentVoucher, updatePaymentVoucher,
  getHqPurchases, getPendingTransfersAll,
} from '../services/api';

const todayStr = () => new Date().toISOString().split('T')[0];

export default function LcvModal({ editing, lockedRef, onClose, onSaved }) {
  const isEdit = !!editing;
  const isLocked = !isEdit && !!lockedRef;
  // Reference type: derived from editing row, or locked, or default 'PO'.
  const initialRefType = isEdit
    ? (editing.linked_transfer_sync_id ? 'Transfer' : 'PO')
    : (isLocked ? lockedRef.type : 'PO');
  const [refType, setRefType] = useState(initialRefType);
  const [openPOs, setOpenPOs] = useState([]);
  const [openTransfers, setOpenTransfers] = useState([]);
  const deriveMethod = (row) => {
    if (!row) return 'Cash';
    if (parseFloat(row.bank_amount) > 0) return 'Bank';
    if (parseFloat(row.momo_amount) > 0) return 'Mobile Money';
    return 'Cash';
  };
  const initialLinkedRef = isEdit
    ? (editing.linked_purchase_sync_id || editing.linked_transfer_sync_id || '')
    : (isLocked ? lockedRef.syncId : '');
  const [form, setForm] = useState({
    date:        isEdit ? (editing.date || todayStr()) : todayStr(),
    linked_ref:  initialLinkedRef,
    paid_to:     isEdit ? (editing.paid_to || '') : '',
    amount:      isEdit ? String(editing.amount || '') : '',
    paid_from:   'Cash Drawer',
    method:      deriveMethod(editing),
    description: isEdit ? (editing.description || '') : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    // Pickers only load in fully-open New mode.
    if (isEdit || isLocked) return;
    getHqPurchases({ status: 'OPEN' })
      .then(r => setOpenPOs(Array.isArray(r.data?.purchases) ? r.data.purchases : []))
      .catch(() => setOpenPOs([]));
    getPendingTransfersAll()
      .then(r => setOpenTransfers(Array.isArray(r.data?.transfers) ? r.data.transfers : []))
      .catch(() => setOpenTransfers([]));
  }, [isEdit, isLocked]);

  useEffect(() => {
    // Reset picker on type change — only meaningful in fully-open New.
    if (!isEdit && !isLocked) setForm(f => ({ ...f, linked_ref: '' }));
  }, [refType, isEdit, isLocked]);

  const handleSave = async () => {
    setError('');
    const amt = parseFloat(form.amount || 0) || 0;
    if (!form.paid_to.trim()) return setError('Paid To is required.');
    if (!(amt > 0))            return setError('Amount must be greater than zero.');
    if (!isEdit && !form.linked_ref) return setError(`Pick a ${refType} to attach the delivery cost to.`);
    setSaving(true);
    try {
      const kCash = form.method === 'Cash'         ? amt : 0;
      const kBank = form.method === 'Bank'         ? amt : 0;
      const kMomo = form.method === 'Mobile Money' ? amt : 0;
      const payload = {
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
      };
      if (isEdit) {
        await updatePaymentVoucher(editing.id, payload);
      } else {
        await createPaymentVoucher({
          ...payload,
          is_landed_cost:          true,
          linked_purchase_sync_id: refType === 'PO'       ? form.linked_ref : null,
          linked_transfer_sync_id: refType === 'Transfer' ? form.linked_ref : null,
        });
      }
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

  const headerText = isEdit
    ? 'Edit Delivery Cost'
    : (isLocked ? `New Delivery Cost — ${refType} pre-selected` : 'New Delivery Cost');
  const saveText = isEdit ? 'Update Delivery Cost' : 'Save Delivery Cost';
  const showChip = isEdit || isLocked;

  return (
    <Portal>
      <div className="modal-overlay">
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>{headerText}</h3>
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
              {!isEdit && !isLocked && (
                <div className="form-group">
                  <label>Attach to</label>
                  <select value={refType} onChange={e => setRefType(e.target.value)}>
                    <option value="PO">Purchase (PO)</option>
                    <option value="Transfer">Inter-branch Transfer</option>
                  </select>
                </div>
              )}
            </div>

            {showChip ? (
              <div className="form-group">
                <label>Attached to</label>
                <div style={{ padding: '8px 12px', background: '#f3f4f6', borderRadius: 6, fontSize: 13, color: '#374151' }}>
                  <span style={{ padding: '2px 8px', fontSize: 11, fontWeight: 700, borderRadius: 20,
                    background: refType === 'PO' ? '#dbeafe' : '#fef3c7',
                    color: refType === 'PO' ? '#1d4ed8' : '#92400e', marginRight: 8 }}>
                    {refType === 'PO' ? 'PO' : 'Transfer'}
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>
                    {(form.linked_ref || '').slice(0, 12)}…
                  </span>
                </div>
              </div>
            ) : (
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
            )}

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
              {saving ? 'Saving…' : saveText}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
