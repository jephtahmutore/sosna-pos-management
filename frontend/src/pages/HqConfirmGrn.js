// HqConfirmGrn → v1.10.0 Generate GRN queue (file kept for route stability).
//
// HQ queue of branch-confirmed receipts that are waiting for HQ to generate
// the GRN. Replaces the v1.9.7 "Confirm GRN" review-and-approve flow.
//
// Lifecycle:
//   1. HQ creates PO. Branch sees in Incoming Stock.
//   2. Branch clicks "Confirm Received" → fills qty + invoice + photo →
//      submits via /api/branch/po-receipts/:syncId/confirm.
//   3. PO appears here. HQ clicks "Generate GRN" → reviews + saves →
//      stock posts to branch sales floor, hq_grns row created.

import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiInbox, FiFileText, FiPaperclip } from 'react-icons/fi';
import {
  getAwaitingGeneration, getHqReceipt, generateHqGrn,
} from '../services/api';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqConfirmGrn() {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [toast, setToast]         = useState(null);
  const [generating, setGenerating] = useState(null); // { purchase, items, extras }

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getAwaitingGeneration();
      setPurchases(r.data?.purchases || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);

  const openGenerate = async (p) => {
    try {
      const r = await getHqReceipt(p.sync_id);
      setGenerating({
        purchase: r.data?.purchase || p,
        items:    r.data?.items    || [],
        extras:   r.data?.extras   || [],
      });
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load receipt', 'error');
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Generate GRN</h1>
          <p>Branch-submitted receipts waiting for HQ to generate the GRN. Generate → stock posts to branch sales floor + supplier AP locks in.</p>
        </div>
        <button onClick={refresh}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      {loading && purchases.length === 0 ? (
        <p style={{ color: '#64748b' }}>Loading…</p>
      ) : purchases.length === 0 ? (
        <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiInbox /> Nothing waiting for generation.</p>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={th}>PO #</th>
                <th style={th}>Branch</th>
                <th style={th}>Supplier</th>
                <th style={th}>Invoice #</th>
                <th style={th}>Confirmed by Branch</th>
                <th style={{ ...th, textAlign: 'right' }}>Items</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {purchases.map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{p.purchase_number}</td>
                  <td style={td}>{p.confirmed_branch_slug || '—'}</td>
                  <td style={td}>{p.supplier_name || '—'}</td>
                  <td style={td}>
                    {p.supplier_invoice_number || '—'}
                    {p.invoice_attachment && (
                      <a href={p.invoice_attachment} target="_blank" rel="noopener noreferrer"
                        style={{ marginLeft: 8, color: '#1d4ed8', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <FiPaperclip size={11} /> view
                      </a>
                    )}
                  </td>
                  <td style={td}>
                    {p.confirmed_by_branch_name || '—'}
                    {p.confirmed_at_branch && (
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{new Date(p.confirmed_at_branch).toLocaleString()}</div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {p.reported_count}/{p.items_count}
                    {p.extras_count > 0 && <span style={{ color: '#d97706', marginLeft: 6 }}>+{p.extras_count} extra</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => openGenerate(p)}
                      style={{ padding: '6px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <FiFileText size={12} /> Generate GRN
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {generating && (
        <GenerateGrnModal
          purchase={generating.purchase}
          items={generating.items}
          extras={generating.extras}
          onClose={() => setGenerating(null)}
          onGenerated={() => {
            setGenerating(null);
            flash('GRN generated. Stock posted to branch sales floor.', 'success');
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ── GRN generation modal (HQ side, minimal v1.10.0) ─────────────────────────
function GenerateGrnModal({ purchase, items, extras, onClose, onGenerated }) {
  // Pre-fill GRN lines from branch-confirmed PO items + extras. HQ can
  // tweak qty / price; CN tabs are deferred to v1.10.1.
  const [grnLines, setGrnLines] = useState(() => [
    ...items.map(it => ({
      product_sync_id: it.product_sync_id,
      product_name:    it.product_name,
      unit:            it.unit,
      quantity:        String(it.received_qty != null ? it.received_qty : it.dispatched_qty || 0),
      unit_price:      String(it.cost_price || 0),
      expiry_date:     '',
      is_extra:        false,
      po_expected_qty: it.dispatched_qty,
    })),
    ...extras.map(e => ({
      product_sync_id: e.product_sync_id,
      product_name:    e.product_name,
      unit:            e.unit,
      quantity:        String(e.quantity || 0),
      unit_price:      String(e.cost_price || 0),
      expiry_date:     '',
      is_extra:        true,
      po_expected_qty: null,
    })),
  ]);
  const [notes, setNotes]   = useState('');
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  const updateLine = (i, field, val) => setGrnLines(prev =>
    prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const total = grnLines.reduce((s, r) =>
    s + (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0), 0);

  const handleSave = async () => {
    setError('');
    const valid = grnLines.filter(r => (parseFloat(r.quantity) || 0) > 0);
    if (valid.length === 0) return setError('At least one line must have a quantity.');
    setSaving(true);
    try {
      await generateHqGrn({
        purchase_sync_id: purchase.sync_id,
        date: new Date().toISOString().slice(0, 10),
        notes: notes || null,
        items: valid.map(r => ({
          product_sync_id: r.product_sync_id,
          product_name:    r.product_name,
          unit:            r.unit,
          quantity:        parseFloat(r.quantity) || 0,
          unit_price:      parseFloat(r.unit_price) || 0,
          expiry_date:     r.expiry_date || null,
          is_extra:        r.is_extra,
          po_expected_qty: r.po_expected_qty,
        })),
        credit_notes: [], // v1.10.1 will surface a tabbed CN UI here
      });
      onGenerated && onGenerated();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to generate.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 1000, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>Generate GRN from {purchase.purchase_number}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              Supplier: {purchase.supplier_name || '—'} · Invoice #: {purchase.supplier_invoice_number || '—'}
              {purchase.invoice_attachment && (
                <> · <a href={purchase.invoice_attachment} target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8' }}>view invoice</a></>
              )}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: '#94a3b8' }}>
              Confirmed by {purchase.confirmed_by_branch_name || '—'} · {purchase.confirmed_at_branch ? new Date(purchase.confirmed_at_branch).toLocaleString() : ''}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4, fontSize: 20 }}>×</button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={th}>Product</th>
                <th style={{ ...th, textAlign: 'right' }}>PO Expected</th>
                <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                <th style={th}>Unit</th>
                <th style={{ ...th, textAlign: 'right' }}>Unit Cost</th>
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {grnLines.map((r, idx) => {
                const line = (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0);
                return (
                  <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      {r.product_name}
                      {r.is_extra && <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontSize: 10, fontWeight: 700 }}>EXTRA</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: '#94a3b8' }}>{r.po_expected_qty != null ? fmtQty(r.po_expected_qty) : '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <input type="number" min="0" step="any" value={r.quantity}
                        onChange={e => updateLine(idx, 'quantity', e.target.value)}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 12, textAlign: 'right' }} />
                    </td>
                    <td style={{ ...td, color: '#475569' }}>{r.unit || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <input type="number" min="0" step="0.01" value={r.unit_price}
                        onChange={e => updateLine(idx, 'unit_price', e.target.value)}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 12, textAlign: 'right' }} />
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtMoney(line)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                <td colSpan={5} style={{ ...td, textAlign: 'right', fontWeight: 700 }}>Items subtotal</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: '#16a34a' }}>{fmtMoney(total)}</td>
              </tr>
            </tfoot>
          </table>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Truck #, driver, additional context…"
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
          </div>

          {error && (
            <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', padding: '8px 12px', borderRadius: 8, marginBottom: 12 }}>
            On Save: stock posts immediately to <strong>{purchase.confirmed_branch_slug}</strong>'s sales floor and supplier AP locks in. CN tabs (discount / crate return / goods return) coming in v1.10.1.
          </div>
        </div>

        <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose}
            style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '10px 28px', background: saving ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
            {saving ? 'Generating…' : 'Generate GRN'}
          </button>
        </div>
      </div>
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td = { padding: '8px 12px', color: '#0f172a' };
