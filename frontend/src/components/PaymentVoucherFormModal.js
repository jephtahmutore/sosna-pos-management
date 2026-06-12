// Shared Payment Voucher form modal — used by both the PV page (general
// accounting) and the Cash Report page (cashier end-of-day). Same UI, same
// fields, same Types dropdown (from pv_types). Caller can lock paid_from
// to a fixed value (e.g. "Cash Drawer" for cash-report use).
import React, { useEffect, useState } from 'react';
import { getPvTypes, createPaymentVoucher, updatePaymentVoucher } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';
import Portal from '../utils/Portal';
import InvoiceAttachment from './InvoiceAttachment';

const todayStr = () => new Date().toISOString().split('T')[0];

const PaymentVoucherFormModal = ({
  open,
  onClose,
  onSaved,             // (savedVoucher) => void — called after a successful save
  editVoucher,         // optional — pre-fills for edit; null/undefined = new
  defaultPaidFrom,     // optional — overrides 'Main cashier' default for new
  lockPaidFrom,        // boolean — if true, paid_from select is disabled
  defaultDate,         // optional — overrides today's date for new
  extraPayload,        // optional object — merged into the API payload (e.g. { cashier_id })
}) => {
  const { symbol: curSym } = useCurrency();

  const [pvTypes, setPvTypes] = useState([]);
  const [form, setForm] = useState({
    paid_to: '', description: '', category: 'Other',
    cash_amount: '', bank_amount: '', momo_amount: '',
    date: todayStr(), paid_from: defaultPaidFrom || 'Main cashier',
    invoice_attachment: null,
  });
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    getPvTypes().then(r => setPvTypes(Array.isArray(r.data) ? r.data : [])).catch(() => setPvTypes([]));
  }, [open]);

  // Reset form whenever the modal is opened / editVoucher changes.
  useEffect(() => {
    if (!open) return;
    if (editVoucher) {
      // Prefer split columns when populated; else drop legacy `amount` into
      // the bucket implied by `paid_from` so the form is editable.
      const ca = parseFloat(editVoucher.cash_amount || 0) || 0;
      const ba = parseFloat(editVoucher.bank_amount || 0) || 0;
      const ma = parseFloat(editVoucher.momo_amount || 0) || 0;
      const splitsSum = ca + ba + ma;
      const legacy = parseFloat(editVoucher.amount || 0) || 0;
      const pf  = (editVoucher.paid_from || '').toLowerCase();
      const legacyBucket = (pf.includes('bank') || pf.includes('cheque')) ? 'bank_amount'
                         : (pf.includes('mobile') || pf.includes('momo'))  ? 'momo_amount'
                         : 'cash_amount';
      setForm({
        paid_to:     editVoucher.paid_to     || '',
        description: editVoucher.description || '',
        category:    editVoucher.category    || 'Other',
        cash_amount: splitsSum > 0 ? (ca > 0 ? String(ca) : '') : (legacyBucket === 'cash_amount' && legacy > 0 ? String(legacy) : ''),
        bank_amount: splitsSum > 0 ? (ba > 0 ? String(ba) : '') : (legacyBucket === 'bank_amount' && legacy > 0 ? String(legacy) : ''),
        momo_amount: splitsSum > 0 ? (ma > 0 ? String(ma) : '') : (legacyBucket === 'momo_amount' && legacy > 0 ? String(legacy) : ''),
        date:        editVoucher.date ? editVoucher.date.split('T')[0] : (defaultDate || todayStr()),
        paid_from:   editVoucher.paid_from   || defaultPaidFrom || 'Main cashier',
        invoice_attachment: editVoucher.invoice_attachment || null,
      });
    } else {
      setForm({
        paid_to: '', description: '', category: 'Other',
        cash_amount: '', bank_amount: '', momo_amount: '',
        date: defaultDate || todayStr(),
        paid_from: defaultPaidFrom || 'Main cashier',
        invoice_attachment: null,
      });
    }
    setError('');
  }, [open, editVoucher, defaultPaidFrom, defaultDate]);

  if (!open) return null;

  const handleSave = async () => {
    setError('');
    if (!form.paid_to.trim()) return setError('Paid To is required.');
    const cash = parseFloat(form.cash_amount || 0) || 0;
    const bank = parseFloat(form.bank_amount || 0) || 0;
    const momo = parseFloat(form.momo_amount || 0) || 0;
    const total = cash + bank + momo;
    if (total <= 0) return setError('Total amount must be greater than 0.');

    if (editVoucher) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    try {
      // Derive paid_from label: if Cash Drawer is locked (e.g. Cash Report),
      // keep that exact value; otherwise produce a clean label from the splits.
      const nonZero = [cash > 0, bank > 0, momo > 0].filter(Boolean).length;
      let resolvedPaidFrom = form.paid_from;
      if (!lockPaidFrom) {
        if (nonZero > 1)        resolvedPaidFrom = 'Mixed';
        else if (cash > 0)      resolvedPaidFrom = 'Cash drawer';
        else if (bank > 0)      resolvedPaidFrom = 'Bank';
        else if (momo > 0)      resolvedPaidFrom = 'Mobile Money';
      }
      const payload = {
        paid_to:     form.paid_to.trim(),
        description: (form.description || '').trim(),
        category:    form.category,
        amount:      total,
        cash_amount: cash,
        bank_amount: bank,
        momo_amount: momo,
        date:        form.date,
        paid_from:   resolvedPaidFrom,
        invoice_attachment: form.invoice_attachment,
        ...(extraPayload || {}),
      };
      const res = editVoucher
        ? await updatePaymentVoucher(editVoucher.id, payload)
        : await createPaymentVoucher(payload);
      onSaved && onSaved(res?.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save voucher.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>{editVoucher ? 'Edit Payment Voucher' : 'New Payment Voucher'}</h3>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
          <div className="modal-body">
            {error && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{error}</div>}

            <div className="form-row">
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Type</label>
                <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                  {pvTypes.length === 0
                    ? <option value="Other">Other</option>
                    : pvTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Paid To</label>
              <input value={form.paid_to} onChange={e => setForm({ ...form, paid_to: e.target.value })} placeholder="Name of payee" />
            </div>

            {lockPaidFrom && (
              <div className="form-group">
                <label>Paid From</label>
                <input value={form.paid_from} disabled
                  style={{ background: '#f3f4f6', fontWeight: 600, cursor: 'not-allowed' }} />
              </div>
            )}

            {/* Amount split across methods — mirrors the AP Record Payment modal. */}
            <div className="form-group">
              <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                Amount Paid (split across methods)
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {[
                  { key: 'cash_amount', label: 'Cash', color: '#16a34a' },
                  { key: 'bank_amount', label: 'Bank', color: '#2563eb' },
                  { key: 'momo_amount', label: 'MoMo', color: '#f59e0b' },
                ].map((f) => (
                  <div key={f.key}>
                    <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                    <input type="number" min="0" step="0.01"
                      value={form[f.key]}
                      onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder="0.00"
                      style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(form[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
                <span style={{ color: '#6b7280' }}>Total</span>
                <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                  {curSym}{(parseFloat(form.cash_amount || 0) + parseFloat(form.bank_amount || 0) + parseFloat(form.momo_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            <div className="form-group">
              <label>Description</label>
              <input value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Payment details" />
            </div>

            <div className="form-group">
              <label>Invoice Attachment</label>
              <InvoiceAttachment
                value={form.invoice_attachment}
                onChange={(p) => setForm({ ...form, invoice_attachment: p })}
                kind="pv"
              />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : editVoucher ? 'Update Voucher' : 'Save Voucher'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default PaymentVoucherFormModal;
