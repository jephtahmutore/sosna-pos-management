// CreditNoteOverlay — v1.9.16
// Self-contained Credit Note creation modal used from inside the GRN
// form's CN tab. Mirrors the rich UX of /accounting/credit-notes
// (Reason segmented control, optional Goods picker, AP preview) but
// scoped to one CN at a time, with supplier + reference pre-filled
// from the parent GRN context.
//
// Why a separate component instead of extracting CreditNotes.js's
// modal: that modal is tightly coupled to the parent page state
// (list refresh, edit mode, filters, etc.). Re-implementing the
// minimum surface here is faster and risk-isolated.
//
// Props:
//   open                bool — controls visibility
//   onClose             () => void — close without saving
//   onSaved             (cnDraft) => void — fires after the user clicks Save.
//                       Caller decides what to do with the draft:
//                         • GRN form: push into local creditNotes[] array
//                           (real POST happens when GRN saves)
//                         • Standalone CN page: call createCreditNote API
//                       cnDraft shape:
//                         { reason, amount, notes, items?, total }
//   prefillSupplierId   number/string — locks supplier (from PO)
//   prefillSupplierName string — display label when locked
//   prefillReference    string — usually GRN number
//   prefillGrnSyncId    string — linked GRN UUID (info-only; persisted by
//                       the caller when it eventually POSTs)
//   defaultDeposit      number — for Crate Return seeding
//   products            array — already-loaded products list (saves a fetch)

import React, { useEffect, useMemo, useState } from 'react';
import { FiX, FiPlus, FiTrash2 } from 'react-icons/fi';
import Portal from '../utils/Portal';
import { unitsForProduct } from '../utils/productUnits';

const REASONS = ['Discount', 'Crate Return', 'Goods Return', 'Other'];
const reasonHasItems       = (r) => r === 'Crate Return' || r === 'Goods Return';
const reasonAffectsProfit  = (r) => r === 'Discount' || r === 'Other';

const reasonStyle = (r) => {
  switch (r) {
    case 'Discount':      return { bg: '#dcfce7', color: '#166534', border: '#86efac' };
    case 'Crate Return':  return { bg: '#dbeafe', color: '#1d4ed8', border: '#bfdbfe' };
    case 'Goods Return':  return { bg: '#ffedd5', color: '#9a3412', border: '#fed7aa' };
    default:              return { bg: '#f3f4f6', color: '#374151', border: '#d1d5db' };
  }
};

const reasonHelp = (r) => {
  switch (r) {
    case 'Discount':
      return 'Supplier is reducing what you owe (rebate, promotion, bulk discount). Reduces AP and shows as Supplier Rebate on the Profit Report.';
    case 'Crate Return':
      return 'You returned empty crates / bottles. Reduces AP by the deposit value; empty container stock leaves your store. Not income.';
    case 'Goods Return':
      return 'Goods Returns reverse a purchase — pick the actual product going back to the supplier (damaged, wrong, or excess). Stock leaves your store at the avg cost price; AP balance drops by the same amount. Does not appear on the Profit Report (it\'s a reversal, not income).';
    default:
      return 'Other supplier credit (e.g. price correction, promo allowance). Reduces AP and may show on the Profit Report.';
  }
};

const emptyItem = (dep = '') => ({
  product_id: '', product_text: '', quantity: '',
  unit_value: dep ? String(dep) : '', unit: '', unit_conv: 1,
});

const pickProductUnit = (p) => {
  if (!p) return { name: '', conv: 1 };
  const units = unitsForProduct(p);
  const wanted = p.default_unit || p.unit || '';
  const found = units.find(u => u.name === wanted) || units.find(u => u.is_base) || units[0] || { name: wanted, conv: 1 };
  return { name: found.name || wanted, conv: parseFloat(found.conv) || 1 };
};

const productUnitValue = (p, defaultDep, reason, conv = 1) => {
  if (!p) return '';
  const c = parseFloat(conv) > 0 ? parseFloat(conv) : 1;
  if (reason === 'Goods Return') {
    const avg = parseFloat(p.avg_cost_price || p.cost_price || 0);
    return avg > 0 ? (avg * c).toFixed(2) : '';
  }
  const isCrateLike = ((p.category_name || '').toLowerCase().match(/(crate|bottle|container|empty)/));
  if (isCrateLike) return defaultDep ? String(defaultDep) : '';
  const avg = parseFloat(p.avg_cost_price || p.cost_price || 0);
  return avg > 0 ? (avg * c).toFixed(2) : '';
};

export default function CreditNoteOverlay({
  open, onClose, onSaved,
  prefillSupplierId, prefillSupplierName,
  prefillReference, prefillGrnSyncId,
  defaultDeposit = 0,
  products = [],
}) {
  const [reason, setReason]     = useState('Discount');
  const [amount, setAmount]     = useState('');
  const [notes, setNotes]       = useState('');
  const [items, setItems]       = useState([emptyItem()]);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  // Reset form whenever modal opens.
  useEffect(() => {
    if (!open) return;
    setReason('Discount');
    setAmount('');
    setNotes('');
    setItems([emptyItem('')]);
    setError('');
    setSaving(false);
  }, [open]);

  // When switching to Crate Return, prefill the unit value from default deposit
  useEffect(() => {
    if (!open) return;
    if (reason !== 'Crate Return') return;
    setItems(prev => {
      if (prev[0]?.product_id || (prev[0]?.product_text || '').trim()) return prev;
      const next = [...prev];
      next[0] = { ...next[0], unit_value: defaultDeposit ? String(defaultDeposit) : next[0].unit_value };
      return next;
    });
  }, [open, reason, defaultDeposit]);

  const usesItems = reasonHasItems(reason);

  const formTotal = useMemo(() => {
    if (!usesItems) return parseFloat(amount) || 0;
    return items.reduce((s, r) => s + (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_value) || 0), 0);
  }, [usesItems, items, amount]);

  const addRow    = () => setItems(prev => [...prev, emptyItem(reason === 'Crate Return' ? defaultDeposit : '')]);
  const removeRow = (idx) => setItems(prev => prev.length === 1 ? [emptyItem(reason === 'Crate Return' ? defaultDeposit : '')] : prev.filter((_, i) => i !== idx));

  const onPickProduct = (idx, productId) => {
    const p = products.find(x => String(x.id) === String(productId));
    setItems(prev => prev.map((row, i) => {
      if (i !== idx) return row;
      if (!p) return { ...row, product_id: '', product_text: '' };
      const u = pickProductUnit(p);
      return {
        ...row,
        product_id:   String(p.id),
        product_text: p.name,
        unit:         u.name,
        unit_conv:    u.conv,
        unit_value:   productUnitValue(p, defaultDeposit, reason, u.conv) || row.unit_value,
      };
    }));
  };

  const save = () => {
    setError('');
    if (formTotal <= 0) return setError('Amount must be greater than 0.');
    if (usesItems) {
      const valid = items.filter(i => i.product_id && parseFloat(i.quantity) > 0 && parseFloat(i.unit_value) >= 0);
      if (valid.length === 0) return setError('Pick at least one product with quantity.');
    }
    // Hand the draft to the caller. The caller decides whether to push it
    // into a local array (deferred — GRN flow) or POST it immediately
    // (standalone CN flow). We don't touch the network here.
    const draft = {
      reason,
      amount: usesItems ? formTotal : (parseFloat(amount) || 0),
      notes:  notes || '',
      items:  usesItems ? items
                            .filter(i => i.product_id && parseFloat(i.quantity) > 0)
                            .map(i => ({
                              product_id: parseInt(i.product_id),
                              product_text: i.product_text,
                              quantity:   parseFloat(i.quantity),
                              unit_value: parseFloat(i.unit_value || 0),
                              unit:       i.unit || null,
                              unit_conv:  i.unit_conv || 1,
                            })) : [],
      total: formTotal,
    };
    if (onSaved) onSaved(draft);
    onClose();
  };

  if (!open) return null;

  return (
    <Portal>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
        <div onClick={e => e.stopPropagation()}
          style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '92vh', overflow: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
          <div style={{ padding: '16px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>New Credit Note</h2>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
                Linked to GRN <strong>{prefillReference || '—'}</strong> · Supplier <strong>{prefillSupplierName || `#${prefillSupplierId}`}</strong>
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
          </div>

          <div style={{ padding: 22 }}>
            {/* Reason segmented control */}
            <label style={lbl}>Reason</label>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${REASONS.length}, 1fr)`, gap: 6, marginBottom: 12 }}>
              {REASONS.map(r => {
                const active = reason === r;
                const rs = reasonStyle(r);
                return (
                  <button key={r} type="button"
                    onClick={() => {
                      if (r === reason) return;
                      setReason(r);
                      setItems([emptyItem(r === 'Crate Return' ? defaultDeposit : '')]);
                      setAmount('');
                    }}
                    style={{
                      padding: '8px 6px',
                      border: `1.5px solid ${active ? rs.border : '#e5e7eb'}`,
                      borderRadius: 8,
                      background: active ? rs.bg : '#fff',
                      color: active ? rs.color : '#374151',
                      cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 500,
                    }}>
                    {r}
                  </button>
                );
              })}
            </div>

            {/* Contextual note */}
            <div style={{ padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e', marginBottom: 16 }}>
              <strong>Note:</strong> {reasonHelp(reason)}
            </div>

            {/* Items grid (Crate Return / Goods Return) */}
            {usesItems ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={lbl}>Items returned ({reason === 'Crate Return' ? 'crates' : 'goods'})</label>
                  <span style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', padding: '2px 8px', borderRadius: 10 }}>
                    Unit value auto-fills from each product's avg cost
                  </span>
                </div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: '#f8fafc' }}>
                      <tr>
                        <th style={th}>Product</th>
                        <th style={{ ...th, textAlign: 'right', width: 80 }}>Qty</th>
                        <th style={{ ...th, textAlign: 'center', width: 90 }}>Unit</th>
                        <th style={{ ...th, textAlign: 'right', width: 110 }}>Value ($)</th>
                        <th style={{ ...th, textAlign: 'right', width: 110 }}>Total</th>
                        <th style={{ ...th, width: 30 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((row, idx) => {
                        const lineTotal = (parseFloat(row.quantity) || 0) * (parseFloat(row.unit_value) || 0);
                        return (
                          <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                            <td style={td}>
                              <select value={row.product_id} onChange={e => onPickProduct(idx, e.target.value)} style={inp}>
                                <option value="">— pick a product —</option>
                                {products.map(p => <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ''}</option>)}
                              </select>
                            </td>
                            <td style={td}><input type="number" min="0" step="any" value={row.quantity}
                              onChange={e => setItems(prev => prev.map((r, i) => i === idx ? { ...r, quantity: e.target.value } : r))}
                              onFocus={e => e.target.select()}
                              style={{ ...inp, textAlign: 'right' }} /></td>
                            <td style={{ ...td, textAlign: 'center', color: '#64748b', fontSize: 12 }}>{row.unit || '—'}</td>
                            <td style={td}><input type="number" min="0" step="any" value={row.unit_value}
                              onChange={e => setItems(prev => prev.map((r, i) => i === idx ? { ...r, unit_value: e.target.value } : r))}
                              onFocus={e => e.target.select()}
                              style={{ ...inp, textAlign: 'right' }} /></td>
                            <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>${lineTotal.toFixed(2)}</td>
                            <td style={{ ...td, textAlign: 'center' }}>
                              <button onClick={() => removeRow(idx)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}><FiTrash2 size={14} /></button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <button onClick={addRow}
                  style={{ padding: '8px 14px', background: '#fff', color: '#0ea5e9', border: '1px solid #bae6fd', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
                  <FiPlus size={14} /> Add Row
                </button>
              </>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <label style={lbl}>Amount *</label>
                <input type="number" min="0" step="0.01" value={amount}
                  onChange={e => setAmount(e.target.value)}
                  onFocus={e => e.target.select()}
                  style={{ ...inp, fontSize: 18, fontWeight: 700, textAlign: 'right', padding: '12px 14px' }}
                  placeholder="0.00" autoFocus />
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Optional details — driver name, supplier note, etc."
                rows={2}
                style={{ ...inp, resize: 'vertical', minHeight: 60 }} />
            </div>

            {/* AP preview */}
            <div style={{ padding: '12px 16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#1e3a8a', fontWeight: 600 }}>
                AP balance to {prefillSupplierName || 'supplier'} will go down by:
              </span>
              <span style={{ fontSize: 20, fontWeight: 800, color: '#1d4ed8' }}>
                ${formTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            {!reasonAffectsProfit(reason) && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>
                (Deposit refund — not income on the Profit Report.)
              </div>
            )}

            {error && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, fontWeight: 600 }}>
                {error}
              </div>
            )}
          </div>

          <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={onClose} disabled={saving}
              style={{ padding: '10px 22px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: saving ? 'wait' : 'pointer', fontSize: 13, fontWeight: 600 }}>
              Cancel
            </button>
            <button onClick={save} disabled={saving || formTotal <= 0}
              style={{ padding: '10px 22px', background: saving || formTotal <= 0 ? '#9ca3af' : '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, cursor: saving || formTotal <= 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
              {saving ? 'Saving…' : 'Save Credit Note'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 };
const inp = { width: '100%', padding: '9px 11px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4 };
const td  = { padding: '8px 10px', color: '#0f172a' };
