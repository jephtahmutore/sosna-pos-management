// Shared Payment Voucher form modal — used by both the PV page (general
// accounting) and the Cash Report page (cashier end-of-day). Same UI, same
// fields, same Types dropdown (from pv_types). Caller can lock paid_from
// to a fixed value (e.g. "Cash Drawer" for cash-report use).
import React, { useEffect, useState } from 'react';
import { getPvTypes, createPaymentVoucher, updatePaymentVoucher, isHqHost } from '../services/api';
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
  defaultCurrency,     // v1.8.18 — 'USD' | 'FRA' | 'K' — auto-focuses that
                       //   currency's amount input. Other inputs visible but blurred.
  defaultPaidTo,       // v1.8.24 — pre-fills the Paid To field on new vouchers
                       //   (e.g. the cashier's name when opened from Cash Report).
  extraPayload,        // optional object — merged into the API payload (e.g. { cashier_id })
}) => {
  const { symbol: curSym, isLiquorStyle } = useCurrency();
  // v1.10.41 — On HQ (sosnazm.com) the local business_settings default to
  // Liquor-style single-K (v1.10.19 memo), which is wrong for a modal that
  // needs to record USD / FRA / K movements the branches are depositing.
  // Same override the Cash Book page already uses: force per-currency treatment
  // on the HQ host so the modal renders USD / FRA / K instead of
  // Cash / MoMo / Bank.
  const onHq = isHqHost();
  const effectiveLiquorStyle = onHq ? false : isLiquorStyle;
  // v1.10.31 — On Liquor-style branches (Lusaka, Mansa, K-only Cash/MoMo/Bank
  // workflow) the three amount inputs are physical methods, not currencies.
  // Storage columns stay the same (usd_amount = Cash, fra_amount = MoMo,
  // k_amount = Bank) to match CashReport's per-method cards and avoid a DB
  // migration. Backend paymentVouchers.js already accepts both shapes.
  const fieldConfigs = effectiveLiquorStyle
    ? [
        { key: 'usd_amount', ccy: 'CASH', label: 'Cash',         color: '#16a34a', step: '0.01', placeholder: '0.00', prefix: curSym },
        { key: 'fra_amount', ccy: 'MOMO', label: 'Mobile Money', color: '#ea580c', step: '0.01', placeholder: '0.00', prefix: curSym },
        { key: 'k_amount',   ccy: 'BANK', label: 'Bank',         color: '#2563eb', step: '0.01', placeholder: '0.00', prefix: curSym },
      ]
    : [
        { key: 'usd_amount', ccy: 'USD',  label: 'USD ($)',      color: '#16a34a', step: '0.01', placeholder: '0.00', prefix: '$' },
        { key: 'fra_amount', ccy: 'FRA',  label: 'FRA',          color: '#7c3aed', step: '1',    placeholder: '0',    prefix: ''  },
        { key: 'k_amount',   ccy: 'K',    label: 'K',            color: '#ea580c', step: '1',    placeholder: '0',    prefix: ''  },
      ];

  const [pvTypes, setPvTypes] = useState([]);
  // v1.8.5 — triple-currency. USD ($), FRA, K each in own currency. Legacy
  // cash_amount/bank_amount/momo_amount columns still in DB, kept at 0.
  // v1.10.133 — form carries cash/bank/momo too. On HQ they hold the K
  // sub-method split (K·Cash / K·Bank / K·MoMo). k_amount is derived
  // (= cash + bank + momo).
  const [form, setForm] = useState({
    paid_to: '', description: '', category: '',
    usd_amount: '', fra_amount: '', k_amount: '',
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
      // v1.8.5 — prefer new usd/fra/k columns; fall back to legacy
      // cash/bank/momo (where the same amounts were stored before the rename).
      const usd = parseFloat(editVoucher.usd_amount || editVoucher.cash_amount || 0) || 0;
      const fra = parseFloat(editVoucher.fra_amount || editVoucher.bank_amount || 0) || 0;
      const k   = parseFloat(editVoucher.k_amount   || editVoucher.momo_amount || 0) || 0;
      const splitsSum = usd + fra + k;
      const legacyAmount = parseFloat(editVoucher.amount || 0) || 0;
      // v1.10.133 — seed K sub-method fields when editing an HQ K-flavour PV.
      const kCash = onHq && k > 0 ? (parseFloat(editVoucher.cash_amount) || 0) : 0;
      const kBank = onHq && k > 0 ? (parseFloat(editVoucher.bank_amount) || 0) : 0;
      const kMomo = onHq && k > 0 ? (parseFloat(editVoucher.momo_amount) || 0) : 0;
      setForm({
        paid_to:     editVoucher.paid_to     || '',
        description: editVoucher.description || '',
        category:    editVoucher.category    || '',
        usd_amount:  splitsSum > 0 ? (usd > 0 ? String(usd) : '') : (legacyAmount > 0 ? String(legacyAmount) : ''),
        fra_amount:  fra > 0 ? String(fra) : '',
        k_amount:    k   > 0 ? String(k)   : '',
        cash_amount: kCash > 0 ? String(kCash) : '',
        bank_amount: kBank > 0 ? String(kBank) : '',
        momo_amount: kMomo > 0 ? String(kMomo) : '',
        date:        editVoucher.date ? editVoucher.date.split('T')[0] : (defaultDate || todayStr()),
        paid_from:   editVoucher.paid_from   || defaultPaidFrom || 'Main cashier',
        invoice_attachment: editVoucher.invoice_attachment || null,
      });
    } else {
      setForm({
        paid_to: defaultPaidTo || '', // v1.8.24 — pre-fill with cashier name when provided
        description: '', category: 'Other',
        usd_amount: '', fra_amount: '', k_amount: '',
        cash_amount: '', bank_amount: '', momo_amount: '',
        date: defaultDate || todayStr(),
        paid_from: defaultPaidFrom || 'Main cashier',
        invoice_attachment: null,
      });
    }
    setError('');
  }, [open, editVoucher, defaultPaidFrom, defaultDate, defaultPaidTo]);

  if (!open) return null;

  const handleSave = async () => {
    setError('');
    if (!form.paid_to.trim()) return setError('Paid To is required.');
    // v1.8.25 — Type is required. Forces a conscious pick instead of
    // accidentally saving with the wrong default.
    if (!form.category) return setError('Type is required — pick one from the dropdown.');
    const usd = parseFloat(form.usd_amount || 0) || 0;
    const fra = parseFloat(form.fra_amount || 0) || 0;
    // v1.10.133 — on HQ, K is the SUM of Cash + Bank + MoMo sub-methods.
    // Off HQ, k_amount is edited directly and cash/bank/momo stay 0.
    const kCash = onHq ? (parseFloat(form.cash_amount || 0) || 0) : 0;
    const kBank = onHq ? (parseFloat(form.bank_amount || 0) || 0) : 0;
    const kMomo = onHq ? (parseFloat(form.momo_amount || 0) || 0) : 0;
    const k = onHq ? (kCash + kBank + kMomo) : (parseFloat(form.k_amount || 0) || 0);
    // Total for the header `amount` column (legacy reports + Cash Book read
    // this). On Sosna, only USD is canonical since FRA & K would need FX;
    // on Liquor the three slots are all the same currency (Cash/MoMo/Bank
    // in K), so `amount` = sum of whichever slot the user filled in.
    // v1.10.31 — was reading `usd` only, which zeroed the header amount when
    // a Liquor cashier paid via MoMo or Bank.
    const totalUsd = effectiveLiquorStyle ? (usd + fra + k) : usd;
    if (usd <= 0 && fra <= 0 && k <= 0) return setError(effectiveLiquorStyle ? 'Enter an amount in Cash, Mobile Money, or Bank.' : 'Enter an amount in at least one currency.');

    if (editVoucher) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    try {
      let resolvedPaidFrom = form.paid_from;
      if (!lockPaidFrom) {
        resolvedPaidFrom = 'Cash drawer';
      }
      const payload = {
        paid_to:     form.paid_to.trim(),
        description: (form.description || '').trim(),
        category:    form.category,
        amount:      totalUsd,
        usd_amount:  usd,
        fra_amount:  fra,
        k_amount:    k,
        // v1.10.133 — HQ K sub-method split. Backend paymentVouchers.js
        // stores cash_amount / bank_amount / momo_amount when present.
        ...(onHq ? { cash_amount: kCash, bank_amount: kBank, momo_amount: kMomo } : {}),
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
      {/* v1.8.24 — click-outside does NOT close. Backdrop is decorative.
          User must click Cancel or X to dismiss. Prevents losing typed
          amounts when accidentally clicking outside the modal. */}
      <div className="modal-overlay">
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
                <label>Type <span style={{ color: '#dc2626' }}>*</span></label>
                {/* v1.8.25 — start blank so the user can't save with the
                    wrong default ('Council' wasn't always right). Save
                    handler rejects empty category with an error.
                    v1.8.53 — Update button also disabled until Type is set. */}
                <select value={form.category} required
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  style={{ borderColor: form.category ? '' : '#dc2626', background: form.category ? '' : '#fef2f2' }}>
                  <option value="">— Select Type (required) —</option>
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

            {/* Amount split across methods — mirrors the AP Record Payment modal.
                v1.10.133 — HQ layout: USD + FRA on row 1, K sub-methods
                (K·Cash / K·Bank / K·MoMo) on row 2. Liquor / Kassumbalesa
                unchanged. */}
            <div className="form-group">
              <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                Amount Paid{effectiveLiquorStyle ? ' (split across methods)' : (onHq ? ' (by currency)' : '')}
              </label>
              {onHq ? (() => {
                const kTotal = ['cash_amount','bank_amount','momo_amount']
                  .reduce((s, key) => s + (parseFloat(form[key] || 0) || 0), 0);
                const usdVal = parseFloat(form.usd_amount || 0) || 0;
                const fraVal = parseFloat(form.fra_amount || 0) || 0;
                const lockOtherCcys = (self) => {
                  if (self === 'usd') return fraVal > 0 || kTotal > 0;
                  if (self === 'fra') return usdVal > 0 || kTotal > 0;
                  if (self === 'k')   return usdVal > 0 || fraVal > 0;
                  return false;
                };
                const renderInput = (key, label, color, step, placeholder, disabled) => (
                  <div key={key}>
                    <label style={{ fontSize: 11, color: disabled ? '#cbd5e1' : color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{label}{disabled && ' (locked)'}</label>
                    <input type="number" min="0" step={step}
                      disabled={disabled}
                      value={form[key]}
                      onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      title={disabled ? 'Clear the other currency to switch — one PV = one currency.' : ''}
                      style={{
                        width: '100%', padding: '8px 10px',
                        border: `2px solid ${disabled ? '#e5e7eb' : (parseFloat(form[key] || 0) > 0 ? color : '#d1d5db')}`,
                        borderRadius: 6, fontSize: 14, fontWeight: 600,
                        color: disabled ? '#cbd5e1' : (parseFloat(form[key] || 0) > 0 ? color : '#374151'),
                        background: disabled ? '#f9fafb' : '#fff',
                        cursor: disabled ? 'not-allowed' : 'text',
                        boxSizing: 'border-box',
                      }} />
                  </div>
                );
                return (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                      {renderInput('usd_amount', 'USD ($)', '#16a34a', '0.01', '0.00', lockOtherCcys('usd'))}
                      {renderInput('fra_amount', 'FRA',     '#7c3aed', '1',    '0',    lockOtherCcys('fra'))}
                    </div>
                    <div style={{ fontSize: 10, color: '#9a3412', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                      K (split by method) {kTotal > 0 && <span style={{ color: '#c2410c', fontWeight: 600 }}>· Total K{kTotal.toLocaleString()}</span>}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      {renderInput('cash_amount', 'K · Cash', '#ea580c', '1', '0', lockOtherCcys('k'))}
                      {renderInput('bank_amount', 'K · Bank', '#c2410c', '1', '0', lockOtherCcys('k'))}
                      {renderInput('momo_amount', 'K · MoMo', '#9a3412', '1', '0', lockOtherCcys('k'))}
                    </div>
                  </>
                );
              })() : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {fieldConfigs.map((f) => {
                  const isDefault = defaultCurrency && f.ccy === defaultCurrency;
                  // v1.8.24 — one PV = one method/currency. Disable an input
                  // when ANY OTHER already has a value > 0.
                  const otherKeys = fieldConfigs.map(x => x.key).filter(k => k !== f.key);
                  const someoneElseHasValue = otherKeys.some(k => parseFloat(form[k] || 0) > 0);
                  const locked = someoneElseHasValue;
                  return (
                    <div key={f.key}>
                      <label style={{ fontSize: 11, color: locked ? '#cbd5e1' : f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}{locked && ' (locked)'}</label>
                      <input type="number" min="0" step={f.step}
                        autoFocus={isDefault}
                        disabled={locked}
                        value={form[f.key]}
                        onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        title={locked ? (effectiveLiquorStyle ? 'Clear the other method to switch — one PV = one method.' : 'Clear the other currency to switch — one PV = one currency.') : ''}
                        style={{
                          width: '100%', padding: '8px 10px',
                          border: `2px solid ${locked ? '#e5e7eb' : (parseFloat(form[f.key] || 0) > 0 || isDefault ? f.color : '#d1d5db')}`,
                          borderRadius: 6, fontSize: 14, fontWeight: 600,
                          color: locked ? '#cbd5e1' : (parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151'),
                          background: locked ? '#f9fafb' : '#fff',
                          cursor: locked ? 'not-allowed' : 'text',
                          boxSizing: 'border-box',
                          boxShadow: isDefault && !locked ? `0 0 0 3px ${f.color}25` : 'none',
                        }} />
                    </div>
                  );
                })}
              </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
                {(() => {
                  // v1.10.31 — Liquor totals sum all three inputs in one currency
                  // (only one is non-zero due to the lock, so this reads the
                  // active method's value). Sosna keeps the USD-only header total
                  // that the DB `amount` column tracks.
                  if (effectiveLiquorStyle) {
                    const t = fieldConfigs.reduce((s, f) => s + (parseFloat(form[f.key] || 0) || 0), 0);
                    return (
                      <>
                        <span style={{ color: '#6b7280' }}>Total</span>
                        <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                          {curSym}{t.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </>
                    );
                  }
                  return (
                    <>
                      <span style={{ color: '#6b7280' }}>Header total (USD only)</span>
                      <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                        ${(parseFloat(form.usd_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </>
                  );
                })()}
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
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || !form.category}
              title={!form.category ? 'Pick a Type first' : ''}>
              {saving ? 'Saving...' : editVoucher ? 'Update Voucher' : 'Save Voucher'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default PaymentVoucherFormModal;
