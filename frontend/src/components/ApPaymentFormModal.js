// ApPaymentFormModal — shared "Record Payment" modal for supplier
// (Account Payable) payments. Used by Account Payables and the GRN page
// so both produce identical ap_payment rows (split + attachment).
//
// Same pattern as PaymentVoucherFormModal — encapsulates its own form
// state, error handling, and API call; parents pass a supplier context
// and an onSaved callback.
import React, { useEffect, useState } from 'react';
import Portal from '../utils/Portal';
import { FiX } from 'react-icons/fi';
import InvoiceAttachment from './InvoiceAttachment';
import { createApPayment } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';

const todayStr = () => new Date().toISOString().split('T')[0];

const emptyForm = {
  cash_amount: '',
  bank_amount: '',
  momo_amount: '',
  date: todayStr(),
  description: '',
  invoice_attachment: null,
};

export default function ApPaymentFormModal({ open, supplier, onClose, onSaved, defaultDate, defaultDescription }) {
  const { symbol: curSym } = useCurrency();
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset the form whenever the modal is (re)opened for a new supplier.
  useEffect(() => {
    if (!open || !supplier) return;
    setForm({
      cash_amount: parseFloat(supplier.balance) > 0 ? parseFloat(supplier.balance).toFixed(2) : '',
      bank_amount: '',
      momo_amount: '',
      date: defaultDate || todayStr(),
      description: defaultDescription || `Payment to ${supplier.supplier_name || ''}`.trim(),
      invoice_attachment: null,
    });
    setError('');
    setSaving(false);
  }, [open, supplier, defaultDate, defaultDescription]);

  if (!open || !supplier) return null;

  const handlePay = async () => {
    const cash = parseFloat(form.cash_amount || 0) || 0;
    const bank = parseFloat(form.bank_amount || 0) || 0;
    const momo = parseFloat(form.momo_amount || 0) || 0;
    const total = cash + bank + momo;
    if (!(total > 0)) { setError('Enter at least one method > 0.'); return; }
    if (!form.date) { setError('Select a date.'); return; }
    setSaving(true);
    try {
      const res = await createApPayment({
        supplier_id: supplier.id,
        supplier_sync_id: supplier.sync_id || null,
        supplier_name: supplier.supplier_name,
        cash_amount: cash,
        bank_amount: bank,
        momo_amount: momo,
        date: form.date,
        description: form.description,
        invoice_attachment: form.invoice_attachment || null,
      });
      onSaved && onSaved(res?.data);
      onClose && onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record payment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 420, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Record Payment</h2>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
          </div>

          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginBottom: 18 }}>
            <div style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>{supplier.supplier_name}</div>
            <div style={{ fontSize: 12, color: '#15803d', marginTop: 2 }}>
              {supplier.context_label
                ? supplier.context_label
                : `Outstanding balance: ${curSym}${Math.abs(parseFloat(supplier.balance) || 0).toLocaleString()}`}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>Amount Paid (split across methods)</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {[
                  { key: 'cash_amount', label: 'Cash', color: '#16a34a' },
                  { key: 'bank_amount', label: 'Bank', color: '#2563eb' },
                  { key: 'momo_amount', label: 'MoMo', color: '#f59e0b' },
                ].map((f, i) => (
                  <div key={f.key}>
                    <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                    <input type="number" min="0" step="0.01" autoFocus={i === 0}
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
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Date *</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Description</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Receipt / Proof of Payment</label>
              <InvoiceAttachment
                value={form.invoice_attachment}
                onChange={path => setForm(f => ({ ...f, invoice_attachment: path }))}
                kind="ap"
              />
            </div>
          </div>

          {error && <div style={{ marginTop: 12, color: '#dc2626', fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
              Cancel
            </button>
            <button onClick={handlePay} disabled={saving} style={{ flex: 1, padding: '10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Saving...' : 'Record Payment'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
