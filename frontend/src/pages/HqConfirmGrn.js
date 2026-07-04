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

// v1.10.105 — currency-aware money formatter. HQ POs can be billed in
// USD, K, or FRA; the modal was hardcoding `$` and lying on K/FRA POs.
// Prefix by the currency argument.
const fmtMoneyCcy = (n, ccy) => {
  const num = parseFloat(n || 0);
  const c = String(ccy || 'USD').toUpperCase();
  if (c === 'K')   return `K${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (c === 'FRA') return `F ${num.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
// Kept for any legacy caller. New code should use fmtMoneyCcy or the
// modal-scoped fmtMoney which closes over purchase.cost_currency.
const fmtMoney = (n) => fmtMoneyCcy(n, 'USD');
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// v1.10.2 — invoices are uploaded at the branch subdomain (mansa1.sosnazm.com)
// and served from that tenant's uploads dir. HQ (sosnazm.com) can't just link
// to the raw path — it has to point back at the branch host. Build the full
// URL from the current hostname + the branch slug so this works in dev too.
function branchUploadUrl(branchSlug, path) {
  if (!path || !branchSlug) return null;
  const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  // If we're already on the branch host (dev), just link locally.
  if (currentHost.startsWith(`${branchSlug}.`)) return `/uploads/${path}`;
  // Strip a leading subdomain off the current host to find the apex, then
  // prepend the branch slug. sosnazm.com → mansa1.sosnazm.com.
  const parts = currentHost.split('.');
  const apex = parts.length > 2 ? parts.slice(1).join('.') : currentHost;
  const proto = (typeof window !== 'undefined' && window.location.protocol) || 'https:';
  return `${proto}//${branchSlug}.${apex}/uploads/${path}`;
}

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
                      <a href={branchUploadUrl(p.confirmed_branch_slug, p.invoice_attachment)} target="_blank" rel="noopener noreferrer"
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
  // v1.10.105 — shadow the module-level fmtMoney with a currency-aware
  // version that uses this PO's cost_currency. The whole modal is scoped
  // to one purchase, so closing over its currency once means every
  // downstream call site (subtotals, line totals, damage values, CN
  // totals, final payable) renders in K / FRA / $ correctly with no
  // per-call-site changes.
  // eslint-disable-next-line no-shadow
  const fmtMoney = (n) => fmtMoneyCcy(n, purchase?.cost_currency);
  // Pre-fill GRN lines from branch-confirmed PO items + extras. HQ can
  // tweak qty / price; CN tabs are deferred to v1.10.1.
  // v1.10.103 — `damaged_quantity` per line. On save, backend posts the
  // FULL quantity to WAC (option A: supplier billed for full, WAC blends
  // full), then immediately books damaged_quantity as a damage stock-out
  // so net saleable stock = quantity − damaged_quantity. Damage cost
  // hits P&L as a separate expense, doesn't drag WAC.
  //
  // v1.10.104 — auto-fill both fields on modal open:
  //   Qty      = po_expected_qty (full invoice qty, 700 in the SAVANNA
  //              example) — supplier billed for this
  //   Damaged  = po_expected − received_qty (2 — the shortfall the branch
  //              flagged when they confirmed the PO items)
  // Operator overrides either if they disagree (e.g. shortfall was a
  // supplier short-shipment, not damage → set Damaged back to 0 and drop
  // Qty to received_qty).
  const [grnLines, setGrnLines] = useState(() => [
    ...items.map(it => {
      const poExpected = parseFloat(it.dispatched_qty) || 0;
      const received   = it.received_qty != null ? (parseFloat(it.received_qty) || 0) : poExpected;
      const shortfall  = Math.max(0, poExpected - received);
      return {
        product_sync_id: it.product_sync_id,
        product_name:    it.product_name,
        unit:            it.unit,
        quantity:        String(poExpected),
        damaged_quantity:String(shortfall),
        unit_price:      String(it.cost_price || 0),
        expiry_date:     '',
        is_extra:        false,
        po_expected_qty: it.dispatched_qty,
      };
    }),
    ...extras.map(e => ({
      product_sync_id: e.product_sync_id,
      product_name:    e.product_name,
      unit:            e.unit,
      quantity:        String(e.quantity || 0),
      damaged_quantity:'0',
      unit_price:      String(e.cost_price || 0),
      expiry_date:     '',
      is_extra:        true,
      po_expected_qty: null,
    })),
  ]);
  const [notes, setNotes]   = useState('');
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  // v1.10.67 — inline Credit Notes. Each entry:
  //   { reason, amount, notes, items: [ {product_sync_id, product_name, unit, quantity, unit_value} ] }
  // items[] is populated only for stock-affecting reasons (Crate Return,
  // Bottle Return, Goods Return); amount is server-authoritative for
  // those (Σ qty × unit_value) but tracked in UI state for live totals.
  const CN_REASONS = ['Discount', 'Damaged', 'Short', 'Crate Return', 'Bottle Return', 'Goods Return', 'Other'];
  const isStockCn = (reason) => reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
  const [creditNotes, setCreditNotes] = useState([]);
  const addCn = () => setCreditNotes(prev => [...prev, { reason: 'Discount', amount: '', notes: '', items: [] }]);
  const removeCn = (i) => setCreditNotes(prev => prev.filter((_, idx) => idx !== i));
  const updateCn = (i, field, val) => setCreditNotes(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: val } : c));
  const addCnItem = (i) => setCreditNotes(prev => prev.map((c, idx) => idx === i
    ? { ...c, items: [...c.items, { product_sync_id: '', product_name: '', unit: '', quantity: '', unit_value: '' }] }
    : c));
  const removeCnItem = (i, ii) => setCreditNotes(prev => prev.map((c, idx) => idx === i
    ? { ...c, items: c.items.filter((_, x) => x !== ii) }
    : c));
  const updateCnItem = (i, ii, field, val) => setCreditNotes(prev => prev.map((c, idx) => {
    if (idx !== i) return c;
    return { ...c, items: c.items.map((it, x) => x === ii ? { ...it, [field]: val } : it) };
  }));
  // Preload the product picker options from the GRN lines (the products
  // this PO actually delivered). Returning something NOT on this GRN
  // isn't supported yet — do it via a standalone CN once that exists.
  const cnProductOptions = grnLines
    .filter(r => r.product_sync_id)
    .map(r => ({ sync_id: r.product_sync_id, name: r.product_name, unit: r.unit || '' }));

  const cnAmount = (c) => isStockCn(c.reason)
    ? c.items.reduce((s, it) => s + (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_value) || 0), 0)
    : (Math.abs(parseFloat(c.amount || 0)) || 0);
  const cnTotal = creditNotes.reduce((s, c) => s + cnAmount(c), 0);

  const updateLine = (i, field, val) => setGrnLines(prev =>
    prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const total = grnLines.reduce((s, r) =>
    s + (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0), 0);
  // v1.10.103 — damages summary. Value = damaged × unit_price (per line).
  // Total booked as a P&L expense, WAC untouched.
  const damageTotal = grnLines.reduce((s, r) =>
    s + (parseFloat(r.damaged_quantity) || 0) * (parseFloat(r.unit_price) || 0), 0);
  const damageUnits = grnLines.reduce((s, r) => s + (parseFloat(r.damaged_quantity) || 0), 0);
  const netStockValue = Math.max(0, total - damageTotal);
  const finalPayable = Math.max(0, total - cnTotal);

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
          damaged_quantity:Math.max(0, parseFloat(r.damaged_quantity) || 0),
          unit_price:      parseFloat(r.unit_price) || 0,
          expiry_date:     r.expiry_date || null,
          is_extra:        r.is_extra,
          po_expected_qty: r.po_expected_qty,
        })),
        // v1.10.67 — CN payload. Client-side validation below drops empties.
        credit_notes: creditNotes
          .map(c => {
            const stock = isStockCn(c.reason);
            const items = stock
              ? c.items
                .filter(it => it.product_sync_id && (parseFloat(it.quantity) || 0) > 0)
                .map(it => ({
                  product_sync_id: it.product_sync_id,
                  product_name:    it.product_name,
                  unit:            it.unit || null,
                  unit_conv:       parseFloat(it.unit_conv) > 0 ? parseFloat(it.unit_conv) : 1,
                  quantity:        parseFloat(it.quantity) || 0,
                  unit_value:      parseFloat(it.unit_value) || 0,
                }))
              : [];
            return {
              reason: c.reason,
              amount: stock
                ? items.reduce((s, it) => s + it.quantity * it.unit_value, 0)
                : (Math.abs(parseFloat(c.amount || 0)) || 0),
              notes:  c.notes || null,
              items,
            };
          })
          .filter(c => (c.amount > 0.001) && (!isStockCn(c.reason) || c.items.length > 0)),
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
                <> · <a href={branchUploadUrl(purchase.confirmed_branch_slug, purchase.invoice_attachment)} target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8' }}>view invoice</a></>
              )}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: '#94a3b8' }}>
              Confirmed by {purchase.confirmed_by_branch_name || '—'} · {purchase.confirmed_at_branch ? new Date(purchase.confirmed_at_branch).toLocaleString() : ''}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4, fontSize: 20 }}>×</button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          {/* v1.10.103 — damages summary strip. Only appears when any
              damaged qty > 0. Green = received to WAC, red = damage loss,
              slate = net saleable that lands on the branch shelf. */}
          {damageUnits > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16, padding: '12px 14px', borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: 0.4 }}>Received (invoice total)</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#16a34a', marginTop: 2 }}>{fmtMoney(total)}</div>
                <div style={{ fontSize: 11, color: '#78716c', marginTop: 2 }}>WAC blends full received × cost</div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: 0.4 }}>Damaged in transit</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#dc2626', marginTop: 2 }}>−{fmtMoney(damageTotal)}</div>
                <div style={{ fontSize: 11, color: '#78716c', marginTop: 2 }}>{fmtQty(damageUnits)} unit(s) · books as Damage Loss</div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: 0.4 }}>Net saleable stock</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', marginTop: 2 }}>{fmtMoney(netStockValue)}</div>
                <div style={{ fontSize: 11, color: '#78716c', marginTop: 2 }}>Lands on the branch shelf</div>
              </div>
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={th}>Product</th>
                <th style={{ ...th, textAlign: 'right' }}>PO Expected</th>
                <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                <th style={{ ...th, textAlign: 'right', color: '#dc2626' }}>Damaged</th>
                <th style={th}>Unit</th>
                <th style={{ ...th, textAlign: 'right' }}>Unit Cost</th>
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {grnLines.map((r, idx) => {
                const line = (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0);
                const dmgQty = parseFloat(r.damaged_quantity) || 0;
                const dmgValue = dmgQty * (parseFloat(r.unit_price) || 0);
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
                    <td style={{ ...td, textAlign: 'right' }}>
                      <input type="number" min="0" step="any" value={r.damaged_quantity}
                        onChange={e => updateLine(idx, 'damaged_quantity', e.target.value)}
                        style={{ width: 70, padding: '5px 8px', border: `1px solid ${dmgQty > 0 ? '#fca5a5' : '#e5e7eb'}`, borderRadius: 5, fontSize: 12, textAlign: 'right', color: dmgQty > 0 ? '#dc2626' : '#0f172a', fontWeight: dmgQty > 0 ? 700 : 400, background: dmgQty > 0 ? '#fef2f2' : '#fff' }} />
                      {dmgValue > 0 && (
                        <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }}>−{fmtMoney(dmgValue)}</div>
                      )}
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
                <td colSpan={6} style={{ ...td, textAlign: 'right', fontWeight: 700 }}>Items subtotal</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: '#16a34a' }}>{fmtMoney(total)}</td>
              </tr>
              {damageTotal > 0 && (
                <>
                  <tr style={{ background: '#fef2f2' }}>
                    <td colSpan={6} style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#991b1b' }}>Damages (booked as loss)</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: '#dc2626' }}>−{fmtMoney(damageTotal)}</td>
                  </tr>
                  <tr style={{ background: '#f1f5f9' }}>
                    <td colSpan={6} style={{ ...td, textAlign: 'right', fontWeight: 700 }}>Net stock value</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: '#0f172a' }}>{fmtMoney(netStockValue)}</td>
                  </tr>
                </>
              )}
            </tfoot>
          </table>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Truck #, driver, additional context…"
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
          </div>

          {/* v1.10.67 — Credit Notes section. Mirrors routes/grn.js Liquor
              flow: money-only reasons (Discount/Damaged/Short/Other) just
              subtract from Final Payable; stock-affecting ones (Crate/Bottle/
              Goods Return) also deduct branch stock. */}
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px', marginBottom: 16, background: '#fafbfc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Credit Notes</div>
              <button type="button" onClick={addCn}
                style={{ padding: '6px 12px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                + Add Credit Note
              </button>
            </div>
            {creditNotes.length === 0 && (
              <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: '6px 0' }}>
                No credit notes. Add one for discounts, damages, shorts, or returns.
              </div>
            )}
            {creditNotes.map((c, ci) => {
              const stock = isStockCn(c.reason);
              const derivedAmt = cnAmount(c);
              return (
                <div key={ci} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 130px 30px', gap: 10, alignItems: 'center', marginBottom: stock || c.notes !== '' ? 8 : 0 }}>
                    <select value={c.reason} onChange={e => updateCn(ci, 'reason', e.target.value)}
                      style={{ padding: '7px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' }}>
                      {CN_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <input value={c.notes} onChange={e => updateCn(ci, 'notes', e.target.value)}
                      placeholder="Notes (optional)"
                      style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                    <input type="number" min="0" step="0.01"
                      value={stock ? derivedAmt.toFixed(2) : c.amount}
                      onChange={e => updateCn(ci, 'amount', e.target.value)}
                      disabled={stock}
                      placeholder="Amount"
                      style={{ padding: '7px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, textAlign: 'right', background: stock ? '#f3f4f6' : '#fff', color: stock ? '#6b7280' : '#0f172a' }} />
                    <button type="button" onClick={() => removeCn(ci)} title="Remove CN"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 18 }}>×</button>
                  </div>
                  {stock && (
                    <div style={{ marginTop: 4, padding: '8px 10px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.4 }}>Items to return</span>
                        <button type="button" onClick={() => addCnItem(ci)}
                          style={{ padding: '3px 8px', background: '#e0e7ff', color: '#3730a3', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                          + Add item
                        </button>
                      </div>
                      {c.items.length === 0 && (
                        <div style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>No items yet. Add at least one for the CN to save.</div>
                      )}
                      {c.items.map((it, ii) => (
                        <div key={ii} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px 100px 30px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                          <select value={it.product_sync_id}
                            onChange={e => {
                              const opt = cnProductOptions.find(o => o.sync_id === e.target.value);
                              updateCnItem(ci, ii, 'product_sync_id', e.target.value);
                              if (opt) {
                                updateCnItem(ci, ii, 'product_name', opt.name);
                                updateCnItem(ci, ii, 'unit', opt.unit);
                              }
                            }}
                            style={{ padding: '5px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}>
                            <option value="">— pick product —</option>
                            {cnProductOptions.map(o => <option key={o.sync_id} value={o.sync_id}>{o.name}</option>)}
                          </select>
                          <input type="number" min="0" step="any" value={it.quantity} onChange={e => updateCnItem(ci, ii, 'quantity', e.target.value)}
                            placeholder="Qty"
                            style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'right' }} />
                          <input value={it.unit} onChange={e => updateCnItem(ci, ii, 'unit', e.target.value)}
                            placeholder="Unit"
                            style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }} />
                          <input type="number" min="0" step="0.01" value={it.unit_value} onChange={e => updateCnItem(ci, ii, 'unit_value', e.target.value)}
                            placeholder="Unit value"
                            style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'right' }} />
                          <div style={{ padding: '5px 8px', fontSize: 12, textAlign: 'right', color: '#16a34a', fontWeight: 700 }}>
                            {fmtMoney((parseFloat(it.quantity) || 0) * (parseFloat(it.unit_value) || 0))}
                          </div>
                          <button type="button" onClick={() => removeCnItem(ci, ii)} title="Remove item"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 14 }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {creditNotes.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <div style={{ fontSize: 13, color: '#b45309', fontWeight: 700 }}>
                  CN Total: −{fmtMoney(cnTotal)}
                </div>
              </div>
            )}
          </div>

          {/* Final payable summary — highlighted so HQ sees the true net. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 32, alignItems: 'baseline', marginBottom: 12, padding: '10px 14px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: '#065f46' }}>
              Items subtotal <strong>{fmtMoney(total)}</strong>
              {cnTotal > 0.001 && <> · CNs <strong>−{fmtMoney(cnTotal)}</strong></>}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#065f46' }}>
              Final Payable: {fmtMoney(finalPayable)}
            </div>
          </div>

          {error && (
            <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 11, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '8px 12px', borderRadius: 8, marginBottom: 12 }}>
            On Save: stock posts immediately to <strong>{purchase.confirmed_branch_slug}</strong>'s sales floor. Stock-affecting CNs (Crate/Bottle/Goods Return) also deduct from stock. Supplier AP locks in at the Final Payable amount.
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
