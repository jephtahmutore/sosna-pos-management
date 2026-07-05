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
import { createApPayment, isHqHost } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';

const todayStr = () => new Date().toISOString().split('T')[0];

// v1.10.78 — form state carries BOTH shapes. HQ uses usd/fra/k (like PV);
// Liquor branches use cash/bank/momo. Only the active set gets values
// filled in; the other set stays blank and is dropped from the payload.
const emptyForm = {
  cash_amount: '', bank_amount: '', momo_amount: '',
  usd_amount:  '', fra_amount:  '', k_amount:    '',
  date: todayStr(),
  description: '',
  invoice_attachment: null,
};

export default function ApPaymentFormModal({ open, supplier, onClose, onSaved, defaultDate, defaultDescription }) {
  const { symbol: curSym, isLiquorStyle: rawLiquorStyle } = useCurrency();
  // v1.10.78 — HQ (bare host) renders the PV-style USD / FRA / K fields
  // regardless of tenant settings. Matches CashReceipt.js v1.10.68 +
  // PaymentVoucherFormModal.js pattern.
  const onHq = isHqHost();
  const isLiquorStyle = rawLiquorStyle && !onHq;
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // v1.10.111 — supplier balances can be in USD, K, or FRA (each supplier
  // has its own native currency, returned per-row by the backend as
  // supplier.currency — see AccountPayables.js:496 for the same mapping).
  // Use it for BOTH the outstanding-balance display AND the total row,
  // instead of the tenant-wide curSym which gave FLAMINGO's K13,110
  // outstanding an incorrect "$" prefix.
  const supplierCcy = String(supplier?.currency || '').toUpperCase();
  const supplierSym = supplierCcy === 'K'   ? 'K'
                    : supplierCcy === 'FRA' ? ''
                    : supplierCcy === 'USD' ? '$'
                    : curSym;

  // Reset the form whenever the modal is (re)opened for a new supplier.
  useEffect(() => {
    if (!open || !supplier) return;
    const outstanding = parseFloat(supplier.balance) > 0 ? parseFloat(supplier.balance).toFixed(2) : '';
    // v1.10.111 — auto-fill the box matching the supplier's native currency.
    // v1.10.129 — on HQ, K supplier defaults into K → Cash sub-method
    // (most common on Sosna). User can redistribute across Cash/Bank/MoMo.
    const ccy = String(supplier?.currency || '').toUpperCase();
    setForm({
      // HQ K → cash_amount (K-Cash sub-method). Liquor → cash_amount (legacy).
      cash_amount: !onHq
        ? outstanding
        : (ccy === 'K' ? outstanding : ''),
      bank_amount: '',
      momo_amount: '',
      usd_amount:  onHq && (ccy === '' || ccy === 'USD') ? outstanding : '',
      fra_amount:  onHq && ccy === 'FRA'                 ? outstanding : '',
      // k_amount is DERIVED on HQ (= cash + bank + momo). Never stored in form.
      k_amount:    '',
      date: defaultDate || todayStr(),
      description: defaultDescription || `Payment to ${supplier.supplier_name || ''}`.trim(),
      invoice_attachment: null,
    });
    setError('');
    setSaving(false);
  }, [open, supplier, defaultDate, defaultDescription, onHq]);

  if (!open || !supplier) return null;

  // v1.10.129 — HQ K currency now has Cash/Bank/MoMo sub-methods. USD/FRA
  // stay as single inputs. Liquor branches unchanged (Cash/Bank/MoMo of K).
  const ccyFields = onHq
    ? [
        { key: 'usd_amount', label: 'USD ($)', color: '#16a34a', step: '0.01', placeholder: '0.00' },
        { key: 'fra_amount', label: 'FRA',     color: '#7c3aed', step: '1',    placeholder: '0'    },
      ]
    : [];
  const kSubFields = onHq
    ? [
        { key: 'cash_amount', label: 'K · Cash', color: '#ea580c', step: '1', placeholder: '0' },
        { key: 'bank_amount', label: 'K · Bank', color: '#c2410c', step: '1', placeholder: '0' },
        { key: 'momo_amount', label: 'K · MoMo', color: '#9a3412', step: '1', placeholder: '0' },
      ]
    : [
        { key: 'cash_amount', label: 'Cash', color: '#16a34a', step: '0.01', placeholder: '0.00' },
        { key: 'bank_amount', label: 'Bank', color: '#2563eb', step: '0.01', placeholder: '0.00' },
        { key: 'momo_amount', label: 'MoMo', color: '#f59e0b', step: '0.01', placeholder: '0.00' },
      ];

  // Derived K total for HQ display (sum of the 3 sub-methods).
  const kSubTotal = onHq
    ? kSubFields.reduce((s, f) => s + (parseFloat(form[f.key] || 0) || 0), 0)
    : 0;
  const total = onHq
    ? (parseFloat(form.usd_amount || 0) || 0)
      + (parseFloat(form.fra_amount || 0) || 0)
      + kSubTotal
    : kSubFields.reduce((s, f) => s + (parseFloat(form[f.key] || 0) || 0), 0);

  const handlePay = async () => {
    if (!(total > 0)) { setError('Enter at least one method > 0.'); return; }
    if (!form.date) { setError('Select a date.'); return; }
    setSaving(true);
    try {
      const payload = {
        supplier_id: supplier.id,
        supplier_sync_id: supplier.sync_id || null,
        supplier_name: supplier.supplier_name,
        date: form.date,
        description: form.description,
        invoice_attachment: form.invoice_attachment || null,
      };
      if (onHq) {
        // v1.10.129 — HQ now sends K as 3 sub-methods (Cash/Bank/MoMo).
        // Backend computes k_amount = cash + bank + momo. USD/FRA single.
        payload.usd_amount  = parseFloat(form.usd_amount  || 0) || 0;
        payload.fra_amount  = parseFloat(form.fra_amount  || 0) || 0;
        payload.cash_amount = parseFloat(form.cash_amount || 0) || 0;
        payload.bank_amount = parseFloat(form.bank_amount || 0) || 0;
        payload.momo_amount = parseFloat(form.momo_amount || 0) || 0;
      } else {
        payload.cash_amount = parseFloat(form.cash_amount || 0) || 0;
        payload.bank_amount = parseFloat(form.bank_amount || 0) || 0;
        payload.momo_amount = parseFloat(form.momo_amount || 0) || 0;
      }
      const res = await createApPayment(payload);
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
                : `Outstanding balance: ${supplierSym}${Math.abs(parseFloat(supplier.balance) || 0).toLocaleString()}`}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                {onHq ? 'Amount Paid (by currency)' : 'Amount Paid (split across methods)'}
              </label>
              {onHq && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  {ccyFields.map((f, i) => (
                    <div key={f.key}>
                      <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                      <input type="number" min="0" step={f.step} autoFocus={i === 0}
                        value={form[f.key]}
                        onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(form[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                    </div>
                  ))}
                </div>
              )}
              {/* v1.10.129 — K sub-method section. On HQ, K is split into
                  Cash / Bank / MoMo. On Liquor, this same row IS the primary
                  Cash / Bank / MoMo split (unchanged behaviour). */}
              {onHq && (
                <div style={{ fontSize: 10, color: '#9a3412', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                  K (split by method) {kSubTotal > 0 && <span style={{ color: '#c2410c', fontWeight: 600 }}>· Total K{kSubTotal.toLocaleString()}</span>}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {kSubFields.map((f, i) => (
                  <div key={f.key}>
                    <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                    <input type="number" min="0" step={f.step} autoFocus={!onHq && i === 0}
                      value={form[f.key]}
                      onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(form[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                  </div>
                ))}
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
