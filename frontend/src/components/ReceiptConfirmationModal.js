// ReceiptConfirmationModal — v1.10.0 branch-side receipt confirmation.
//
// Replaces the v1.9.x "Accept & Generate GRN" full GRN modal at the
// branch. Now branch only:
//   • Confirms received qty per PO line (autofilled with expected)
//   • Adds items not on the PO ("+ Add Item")
//   • Records the supplier invoice # and uploads the invoice photo
//   • Submits — HQ will generate the actual GRN downstream.
//
// No CN tabs here. No supplier dropdown. Branch never sees the GRN.

import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { FiPlus, FiTrash2, FiX } from 'react-icons/fi';
import InvoiceAttachment from './InvoiceAttachment';
import { confirmBranchReceipt } from '../services/api';

export default function ReceiptConfirmationModal({
  purchase,        // { purchase_number, sync_id, supplier_name, date }
  items,           // [{ sync_id, product_sync_id, product_name, unit, dispatched_qty, cost_price }]
  products,        // local branch products list for the "Add Item" picker
  onClose,
  onConfirmed,
}) {
  // Per-line received qty (default to expected).
  const [lines, setLines] = useState(() =>
    items.map(it => ({
      sync_id:        it.sync_id,
      product_name:   it.product_name,
      unit:           it.unit,
      expected:       parseFloat(it.dispatched_qty) || 0,
      received:       String(parseFloat(it.dispatched_qty) || 0),
      notes:          '',
    }))
  );

  // Extras = items branch received that weren't on the PO.
  const emptyExtra = () => ({
    product_sync_id: '',
    product_text:    '',
    unit:            'pcs',
    quantity:        '',
    cost_price:      '',
  });
  const [extras, setExtras] = useState([]);

  const [invoiceNumber,     setInvoiceNumber]     = useState('');
  const [invoiceAttachment, setInvoiceAttachment] = useState(null);
  const [error,  setError]  = useState('');
  const [saving, setSaving] = useState(false);

  const updateLine  = (i, field, val) => setLines(prev =>
    prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const addExtra    = () => setExtras(prev => [...prev, emptyExtra()]);
  const removeExtra = (i) => setExtras(prev => prev.filter((_, idx) => idx !== i));
  const updateExtra = (i, field, val) => setExtras(prev =>
    prev.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, [field]: val };
      if (field === 'product_text') {
        const m = products.find(p => p.name && p.name.toLowerCase() === val.trim().toLowerCase());
        next.product_sync_id = m ? m.sync_id : '';
        if (m) {
          next.unit = m.default_unit || m.unit || 'pcs';
          if (!next.cost_price) next.cost_price = String(m.cost_price || m.avg_cost_price || 0);
        }
      }
      return next;
    }));

  const handleSubmit = async () => {
    setError('');
    if (!invoiceNumber.trim()) return setError('Supplier invoice number is required.');
    if (!invoiceAttachment)    return setError('Please attach the supplier invoice photo or PDF.');

    setSaving(true);
    try {
      const payload = {
        lines: lines.map(l => ({
          purchase_item_sync_id: l.sync_id,
          received_qty: Math.max(0, parseFloat(l.received) || 0),
          reason: (parseFloat(l.received) || 0) === l.expected ? 'OK' : 'Short',
          notes:  l.notes || null,
        })),
        extras: extras
          .map(e => ({
            product_sync_id: e.product_sync_id || null,
            product_name:    e.product_text,
            unit:            e.unit || null,
            quantity:        Math.max(0, parseFloat(e.quantity) || 0),
            cost_price:      parseFloat(e.cost_price) || 0,
          }))
          .filter(e => e.product_name && e.quantity > 0),
        supplier_invoice_number: invoiceNumber.trim(),
        invoice_attachment:      invoiceAttachment,
      };
      await confirmBranchReceipt(purchase.sync_id, payload);
      onConfirmed && onConfirmed();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to submit.');
    } finally {
      setSaving(false);
    }
  };

  return ReactDOM.createPortal((
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 900, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>Confirm Received from {purchase.purchase_number}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              Supplier: {purchase.supplier_name || '—'} · PO date: {purchase.date}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}><FiX size={20} /></button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          {/* PO lines */}
          <h4 style={{ margin: '0 0 10px', fontSize: 14 }}>From the PO</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Product</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Expected</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Received</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={l.sync_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '8px 10px' }}>
                    {l.product_name} <span style={{ color: '#9ca3af', fontSize: 11 }}>{l.unit}</span>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: '#475569' }}>{l.expected}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <input type="number" min="0" step="any" value={l.received}
                      onChange={e => updateLine(idx, 'received', e.target.value)}
                      style={{ width: 100, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Extras */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h4 style={{ margin: 0, fontSize: 14 }}>Items added (not on the PO)</h4>
            <button type="button" onClick={addExtra}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px dashed #93c5fd', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              <FiPlus size={12} /> Add Item
            </button>
          </div>
          {extras.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Product</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Qty</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Unit</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Cost</th>
                  <th style={{ padding: '8px 10px' }} />
                </tr>
              </thead>
              <tbody>
                {extras.map((r, idx) => (
                  <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '6px 10px' }}>
                      <input list={`extra-prod-${idx}`} value={r.product_text}
                        onChange={e => updateExtra(idx, 'product_text', e.target.value)}
                        placeholder="Type to search HQ items"
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                      <datalist id={`extra-prod-${idx}`}>
                        {products.map(p => <option key={p.id} value={p.name} />)}
                      </datalist>
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                      <input type="number" min="0" step="any" value={r.quantity}
                        onChange={e => updateExtra(idx, 'quantity', e.target.value)}
                        style={{ width: 90, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <input value={r.unit}
                        onChange={e => updateExtra(idx, 'unit', e.target.value)}
                        style={{ width: 70, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                      <input type="number" min="0" step="0.01" value={r.cost_price}
                        onChange={e => updateExtra(idx, 'cost_price', e.target.value)}
                        style={{ width: 90, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <button onClick={() => removeExtra(idx)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}>
                        <FiTrash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Supplier invoice */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                Supplier Invoice # <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)}
                placeholder="e.g. INV-12345"
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                Invoice Attachment <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <InvoiceAttachment value={invoiceAttachment} onChange={setInvoiceAttachment} />
            </div>
          </div>

          {error && (
            <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose}
            style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving}
            style={{ padding: '10px 28px', background: saving ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
            {saving ? 'Submitting…' : 'Confirm Received'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
