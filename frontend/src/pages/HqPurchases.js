// HqPurchases — HQ-side procurement page. HQ has no physical warehouse;
// each line of a purchase has a destination_slug picking which branch
// will offload the goods. Lines sit PENDING until the destination branch
// confirms with actual received qty in their Incoming Stock queue.
import React, { useEffect, useMemo, useState } from 'react';
import {
  FiRefreshCw, FiPlus, FiPackage, FiTrash2, FiEye, FiXCircle, FiPrinter,
} from 'react-icons/fi';
import {
  getHqBranches, getHqPurchases, getHqPurchase, createHqPurchase, getHqSuppliers, createHqSupplier,
  cancelHqPurchaseItem, cancelHqPurchase, getProducts,
} from '../services/api';
import printHtml from '../utils/printHtml';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HqPurchases() {
  const [purchases, setPurchases] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [toast, setToast] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getHqPurchases(statusFilter ? { status: statusFilter } : undefined);
      setPurchases(r.data?.purchases || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
  }, []);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter]);

  const openDetail = async (id) => {
    try {
      const r = await getHqPurchase(id);
      setViewing(r.data);
    } catch (err) { flash(err?.response?.data?.error || 'Failed to load detail', 'error'); }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Purchases</h1>
          <p>Supplier purchases routed directly to branches · HQ holds no stock</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={inp}>
            <option value="">All status</option>
            <option value="OPEN">Open (pending lines)</option>
            <option value="COMPLETED">Completed</option>
          </select>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> New Purchase
          </button>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && purchases.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : purchases.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiPackage /> No purchases yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Purchase #</th>
                  <th style={th}>Date</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Invoice #</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  <th style={th}>Lines</th>
                  <th style={th}>Status</th>
                  <th style={th}>By</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {purchases.map(p => (
                  <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{p.purchase_number}</td>
                    <td style={td}>{p.date}</td>
                    <td style={td}>{p.supplier_name || '—'}</td>
                    <td style={td}>{p.invoice_number || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(p.total_amount)}</td>
                    <td style={td}>
                      <span style={{ color: '#0f172a', fontWeight: 600 }}>{p.items_received}/{p.items_total}</span>
                      {p.items_pending > 0 && <span style={{ color: '#92400e', fontSize: 11, marginLeft: 6 }}>({p.items_pending} pending)</span>}
                    </td>
                    <td style={td}>{statusBadge(p.status)}</td>
                    <td style={td}>{p.created_by_name || '—'}</td>
                    <td style={td}>
                      <button onClick={() => openDetail(p.id)}
                        style={{ padding: '4px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiEye size={12} /> View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <CreatePurchaseModal
          branches={branches}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); flash('Purchase saved.', 'success'); refresh(); }}
          onError={(m) => flash(m, 'error')}
        />
      )}

      {viewing && (
        <DetailModal
          data={viewing}
          onClose={() => setViewing(null)}
          onChanged={async () => {
            // Re-fetch detail to reflect the cancel + refresh the list
            // so per-row counts + status tags update too.
            try {
              const r = await getHqPurchase(viewing.id);
              setViewing(r.data);
            } catch (_) { setViewing(null); }
            refresh();
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

function statusBadge(s) {
  const map = {
    OPEN:      ['#fef3c7', '#92400e', 'Open'],
    COMPLETED: ['#dcfce7', '#166534', 'Completed'],
    CANCELLED: ['#fee2e2', '#991b1b', 'Cancelled'],
    PENDING:   ['#fef3c7', '#92400e', 'Pending'],
    RECEIVED:  ['#dcfce7', '#166534', 'Received'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

function CreatePurchaseModal({ branches, onClose, onCreated, onError }) {
  const [supplierId, setSupplierId] = useState('');
  const [suppliers, setSuppliers]   = useState([]);
  const [invoice, setInvoice]   = useState('');
  const [date, setDate]         = useState(todayISO());
  const [notes, setNotes]       = useState('');
  const [items, setItems]       = useState([newItem(branches[0]?.slug || '')]);
  const [submitting, setSubmitting] = useState(false);

  // v1.9.0 — quick-add HQ supplier (same pattern as GRN page).
  // Strict: free-text supplier entry removed; only HQ master suppliers
  // can be referenced. If the user needs a new supplier they add it
  // inline, which writes to HQ master and auto-selects.
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [newSupName,  setNewSupName]  = useState('');
  const [newSupPhone, setNewSupPhone] = useState('');
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [addSupplierError, setAddSupplierError] = useState('');

  const [hqProducts, setHqProducts] = useState([]);
  useEffect(() => {
    getHqSuppliers()
      .then(r => setSuppliers(r.data?.suppliers || []))
      .catch(() => {});
    // v1.9.6 — pull from the regular HQ Item Details catalogue (default DB
    // `products` on sosnazm.com), not the legacy master.db `hq_products`
    // table. HQ admin already manages the master list there; having two
    // sources caused the picker to show "No HQ Products yet" even though
    // the Items page was full. Filter to Active + non-deleted.
    getProducts()
      .then(r => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.products || []);
        setHqProducts(list.filter(p => !p.deleted_at && (p.status || 'Active') === 'Active'));
      })
      .catch(() => {});
  }, []);

  function newItem(defaultSlug = '') {
    return { product_sync_id: '', product_name: '', unit: 'pcs', dispatched_qty: '', cost_price: '', destination_slug: defaultSlug };
  }

  const updateItem = (i, field, value) => {
    setItems(arr => arr.map((it, idx) => idx === i ? { ...it, [field]: value } : it));
  };
  const addItem = () => setItems(arr => [...arr, newItem(branches[0]?.slug || '')]);
  const removeItem = (i) => setItems(arr => arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr);

  const totalAmount = useMemo(() => items.reduce((s, it) => {
    const q = parseFloat(it.dispatched_qty) || 0;
    const c = parseFloat(it.cost_price) || 0;
    return s + q * c;
  }, 0), [items]);

  // v1.9.0 — inline create HQ supplier; refreshes list + auto-selects.
  const handleAddSupplier = async () => {
    const name = newSupName.trim();
    if (!name) { setAddSupplierError('Name is required.'); return; }
    setAddingSupplier(true);
    setAddSupplierError('');
    try {
      const res = await createHqSupplier({ name, phone: newSupPhone.trim() || null });
      const created = res.data?.supplier || res.data || null;
      // Refetch full list so the new supplier shows in dropdown ordering
      const list = await getHqSuppliers();
      setSuppliers(list.data?.suppliers || []);
      if (created?.id) setSupplierId(String(created.id));
      setShowAddSupplier(false);
      setNewSupName(''); setNewSupPhone('');
    } catch (err) {
      setAddSupplierError(err?.response?.data?.error || 'Failed to create supplier');
    }
    setAddingSupplier(false);
  };

  const submit = async () => {
    // v1.9.0 — strict: every line MUST have a product_sync_id (i.e. picked
    // from HQ master). The old code allowed a free-text product_name to
    // pass through, which let garbage like "fdfdfdf" become a real
    // purchase + auto-create a branch product. Now: any line whose
    // product wasn't picked from the dropdown is rejected with a clear
    // error pointing the user to HQ Products.
    const cleaned = items.map(it => ({
      product_sync_id:  (it.product_sync_id || '').trim(),
      product_name:     (it.product_name || '').trim(),
      unit:             it.unit || null,
      dispatched_qty:   parseFloat(it.dispatched_qty) || 0,
      cost_price:       parseFloat(it.cost_price) || 0,
      destination_slug: it.destination_slug,
    }));
    const orphans = cleaned.filter(it => it.product_name && !it.product_sync_id);
    if (orphans.length > 0) {
      return onError(`"${orphans[0].product_name}" isn't in HQ Products. Pick from the dropdown, or add it via HQ Products first.`);
    }
    const clean = cleaned.filter(it => it.product_sync_id && it.dispatched_qty > 0 && it.destination_slug);
    if (clean.length === 0) return onError('Add at least one valid item');
    // v1.9.0 — supplier_id is now required (free-text supplier_name removed).
    const picked = suppliers.find(s => String(s.id) === String(supplierId));
    if (!picked) return onError('Pick a supplier from the dropdown, or add a new one with the + New button.');
    setSubmitting(true);
    try {
      await createHqPurchase({
        supplier_id:    picked.id,
        supplier_name:  picked.name,
        invoice_number: invoice || null,
        date,
        notes: notes || null,
        items: clean,
      });
      onCreated();
    } catch (err) {
      onError(err?.response?.data?.error || 'Failed to save');
    }
    setSubmitting(false);
  };

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(960px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>New HQ Purchase</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={lbl}>Supplier <span style={{ color: '#dc2626' }}>*</span></label>
              {/* v1.9.0 — strict supplier picker. Same pattern as GRN page:
                  select from HQ master, or hit "+ New" to add inline. Free-text
                  fallback removed so every purchase has a real AP linkage. */}
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={supplierId}
                  onChange={e => setSupplierId(e.target.value)}
                  style={{ ...inp, flex: 1 }}>
                  <option value="">— select supplier —</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.balance > 0.001 ? `  (owes $${s.balance.toFixed(2)})` : ''}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => { setShowAddSupplier(v => !v); setAddSupplierError(''); }}
                  title="Add new HQ supplier"
                  style={{ padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: showAddSupplier ? '#dcfce7' : '#f9fafb', color: showAddSupplier ? '#16a34a' : '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  + New
                </button>
              </div>

              {showAddSupplier && (
                <div style={{ marginTop: 8, padding: '12px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#15803d', marginBottom: 8 }}>Quick-add HQ Supplier</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      value={newSupName} onChange={e => setNewSupName(e.target.value)}
                      placeholder="Supplier name *"
                      style={{ flex: 2, minWidth: 120, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <input
                      value={newSupPhone} onChange={e => setNewSupPhone(e.target.value)}
                      placeholder="Phone (optional)"
                      style={{ flex: 1, minWidth: 100, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <button
                      type="button" onClick={handleAddSupplier} disabled={addingSupplier}
                      style={{ padding: '7px 14px', background: addingSupplier ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: addingSupplier ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                      {addingSupplier ? '…' : 'Create'}
                    </button>
                    <button
                      type="button" onClick={() => { setShowAddSupplier(false); setNewSupName(''); setNewSupPhone(''); setAddSupplierError(''); }}
                      style={{ padding: '7px 10px', background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                      Cancel
                    </button>
                  </div>
                  {addSupplierError && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{addSupplierError}</div>}
                </div>
              )}
            </div>
            <div><label style={lbl}>Invoice #</label><input type="text" value={invoice} onChange={e => setInvoice(e.target.value)} placeholder="INV-2026-…" style={inp} /></div>
            <div><label style={lbl}>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={inp} /></div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Notes</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Truck #, driver, PO ref, etc." style={inp} />
          </div>

          <label style={{ ...lbl, fontSize: 13 }}>Items (each line goes to ONE branch)</label>
          <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={thS}>Product</th>
                  <th style={{ ...thS, width: 70 }}>Unit</th>
                  <th style={{ ...thS, textAlign: 'right', width: 90 }}>Qty</th>
                  <th style={{ ...thS, textAlign: 'right', width: 100 }}>Cost</th>
                  <th style={{ ...thS, textAlign: 'right', width: 110 }}>Line Total</th>
                  <th style={{ ...thS, width: 180 }}>Destination</th>
                  <th style={{ ...thS, width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const lineTotal = (parseFloat(it.dispatched_qty) || 0) * (parseFloat(it.cost_price) || 0);
                  return (
                    <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={tdS}>
                        {/* v1.9.0 — strict picker only. Free-text input removed:
                            it let arbitrary strings like "fdfdfdf" become a
                            purchase, auto-creating ghost branch products. If the
                            HQ master is empty, show a clear empty-state instead
                            of a typeable input. */}
                        {hqProducts.length > 0 ? (
                          <select
                            value={it.product_sync_id || ''}
                            onChange={e => {
                              const picked = hqProducts.find(p => p.sync_id === e.target.value);
                              if (picked) {
                                // Atomic update so HQ master sync_id rides
                                // through to the line — that's what makes the
                                // branch line auto-match its existing
                                // products.sync_id at GRN-confirm time
                                // (no duplicate product gets auto-created).
                                setItems(arr => arr.map((row, idx) => idx === i ? {
                                  ...row,
                                  product_sync_id: picked.sync_id,
                                  product_name:    picked.name,
                                  // v1.9.10 — default to the product's preferred
                                  // trade unit (default_unit), not the base unit.
                                  // Falls back to base unit when no default set
                                  // and finally 'pcs' for fresh items.
                                  unit:            picked.default_unit || picked.unit || 'pcs',
                                  // v1.9.6 — products endpoint exposes cost_price (not
                                  // legacy default_cost_price). Both fall back to 0.
                                  cost_price:      String(picked.cost_price ?? picked.default_cost_price ?? 0),
                                } : row));
                              } else {
                                setItems(arr => arr.map((row, idx) => idx === i ? {
                                  ...row,
                                  product_sync_id: '',
                                  product_name:    '',
                                } : row));
                              }
                            }}
                            style={cellInp}>
                            <option value="">— pick item —</option>
                            {hqProducts.map(p => (
                              <option key={p.id} value={p.sync_id}>
                                {p.name}{p.code ? ` (${p.code})` : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div style={{ ...cellInp, color: '#dc2626', fontSize: 11, padding: '6px 8px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4 }}>
                            No items yet — add them under <strong>Store &rarr; Item Details</strong> first.
                          </div>
                        )}
                      </td>
                      <td style={tdS}><input type="text" value={it.unit} onChange={e => updateItem(i, 'unit', e.target.value)} style={cellInp} /></td>
                      <td style={tdS}><input type="number" min="0" step="any" value={it.dispatched_qty} onChange={e => updateItem(i, 'dispatched_qty', e.target.value)} style={{ ...cellInp, textAlign: 'right' }} /></td>
                      <td style={tdS}><input type="number" min="0" step="any" value={it.cost_price} onChange={e => updateItem(i, 'cost_price', e.target.value)} style={{ ...cellInp, textAlign: 'right' }} /></td>
                      <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(lineTotal)}</td>
                      <td style={tdS}>
                        <select value={it.destination_slug} onChange={e => updateItem(i, 'destination_slug', e.target.value)} style={cellInp}>
                          <option value="">— branch —</option>
                          {branches.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
                        </select>
                      </td>
                      <td style={tdS}>
                        <button onClick={() => removeItem(i)} disabled={items.length === 1}
                          style={{ background: 'none', border: 'none', color: items.length === 1 ? '#cbd5e1' : '#dc2626', cursor: items.length === 1 ? 'not-allowed' : 'pointer', padding: 2 }}>
                          <FiTrash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button onClick={addItem}
            style={{ marginTop: 8, padding: '6px 12px', background: '#f1f5f9', color: '#0f172a', border: '1px dashed #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FiPlus size={12} /> Add line
          </button>

          <div style={{ marginTop: 14, padding: '10px 14px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, display: 'flex', justifyContent: 'space-between' }}>
            <strong style={{ color: '#0c4a6e' }}>Purchase total</strong>
            <strong style={{ color: '#0c4a6e', fontSize: 17 }}>{fmtMoney(totalAmount)}</strong>
          </div>
        </div>

        <div style={{ padding: 14, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={submitting}
            style={{ padding: '10px 22px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Saving…' : 'Save Purchase'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailModal({ data, onClose, onChanged, flash }) {
  const items = data.items || [];
  // Whole-purchase cancel is only safe while NO line has been received
  // (a received line moved real stock — v1 doesn't reverse those).
  const anyReceived = items.some(it => it.status === 'RECEIVED');
  const anyPending  = items.some(it => it.status === 'PENDING');
  const headerCancellable = !anyReceived && data.status !== 'CANCELLED' && data.status !== 'COMPLETED';

  const doLineCancel = async (it) => {
    if (!window.confirm(`Cancel line "${it.product_name}" (${parseFloat(it.dispatched_qty).toFixed(2)} ${it.unit || ''} → ${it.destination_name || it.destination_slug})?`)) return;
    try {
      await cancelHqPurchaseItem(it.id);
      flash?.('Line cancelled.', 'success');
      onChanged?.();
    } catch (err) {
      flash?.(err?.response?.data?.error || 'Cancel failed', 'error');
    }
  };

  const doWholeCancel = async () => {
    if (!window.confirm(`Cancel entire purchase ${data.purchase_number}? All pending lines will be cancelled.`)) return;
    try {
      await cancelHqPurchase(data.id);
      flash?.('Purchase cancelled.', 'success');
      onChanged?.();
    } catch (err) {
      flash?.(err?.response?.data?.error || 'Cancel failed', 'error');
    }
  };

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(900px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>{data.purchase_number}</h3>
            <div style={{ fontSize: 12, color: '#64748b' }}>{data.supplier_name || 'Supplier —'} · Invoice {data.invoice_number || '—'} · {data.date}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => printHtml(renderPurchaseDocket(data))}
              style={{ padding: '6px 12px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FiPrinter size={12} /> Print Docket
            </button>
            {headerCancellable && (
              <button onClick={doWholeCancel}
                style={{ padding: '6px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <FiXCircle size={12} /> Cancel Purchase
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
          </div>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <Pill label="Status" value={statusBadge(data.status)} />
            <Pill label="Total" value={<strong>{fmtMoney(data.total_amount)}</strong>} />
            <Pill label="Lines" value={`${fmtInt(items.length)}`} />
            <Pill label="By" value={data.created_by_name || '—'} />
          </div>
          {data.notes && <p style={{ background: '#f8fafc', padding: 10, borderRadius: 6, fontSize: 13, color: '#475569' }}>{data.notes}</p>}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={th}>Product</th>
                <th style={th}>Destination</th>
                <th style={{ ...th, textAlign: 'right' }}>Dispatched</th>
                <th style={{ ...th, textAlign: 'right' }}>Received</th>
                <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                <th style={th}>Status</th>
                <th style={th}>Notes</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => {
                const variance = it.status === 'RECEIVED' && it.received_qty !== it.dispatched_qty;
                return (
                  <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9', background: variance ? '#fffbeb' : it.status === 'CANCELLED' ? '#fafafa' : '#fff', opacity: it.status === 'CANCELLED' ? 0.6 : 1 }}>
                    <td style={td}>{it.product_name} <span style={{ color: '#94a3b8', fontSize: 11 }}>{it.unit}</span></td>
                    <td style={td}>{it.destination_name || it.destination_slug}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{parseFloat(it.dispatched_qty).toFixed(2)}</td>
                    <td style={{ ...td, textAlign: 'right', color: variance ? '#b91c1c' : '#0f172a', fontWeight: variance ? 700 : 400 }}>
                      {it.received_qty == null ? '—' : parseFloat(it.received_qty).toFixed(2)}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(it.cost_price)}</td>
                    <td style={td}>{statusBadge(it.status)}</td>
                    <td style={{ ...td, color: '#64748b' }}>{it.variance_notes || ''}</td>
                    <td style={td}>
                      {it.status === 'PENDING' && (
                        <button onClick={() => doLineCancel(it)} title="Cancel this line"
                          style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}>
                          <FiTrash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {anyPending && (
            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 10 }}>
              <FiTrash2 size={10} style={{ verticalAlign: 'middle' }} /> Cancel only removes pending lines; received lines stay in branch stock.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Pill({ label, value }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: '6px 12px' }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

// A4-style dispatch docket — handed to the supplier driver so they know
// which branch each line drops at. Items grouped by destination_slug
// with per-destination subtotals. Routed through the same printHtml
// util (iframe + print dialog on desktop, PDF on mobile).
function renderPurchaseDocket(p) {
  const fmt = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Bucket lines by destination so the driver can hand-off cleanly.
  const groups = {};
  for (const it of (p.items || [])) {
    const key = it.destination_slug;
    if (!groups[key]) groups[key] = { name: it.destination_name || key, items: [], subtotal: 0 };
    groups[key].items.push(it);
    groups[key].subtotal += (parseFloat(it.line_total) || 0);
  }
  const groupHtml = Object.entries(groups).map(([slug, g]) => `
    <div style="margin-top:14px;">
      <div style="background:#f1f5f9;padding:6px 10px;border-radius:4px;font-size:13px;font-weight:700;">
        → ${escapeHtml(g.name)} <span style="color:#64748b;font-weight:500;">(${escapeHtml(slug)})</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;">
        <thead><tr style="background:#fff;border-bottom:1px solid #e2e8f0;">
          <th style="text-align:left;padding:6px;">Product</th>
          <th style="text-align:left;padding:6px;width:60px;">Unit</th>
          <th style="text-align:right;padding:6px;width:80px;">Qty</th>
          <th style="text-align:right;padding:6px;width:90px;">Cost</th>
          <th style="text-align:right;padding:6px;width:100px;">Line Total</th>
        </tr></thead>
        <tbody>
          ${g.items.map(it => `<tr style="border-bottom:1px dashed #e2e8f0;">
            <td style="padding:6px;">${escapeHtml(it.product_name)}</td>
            <td style="padding:6px;">${escapeHtml(it.unit || '')}</td>
            <td style="text-align:right;padding:6px;">${parseFloat(it.dispatched_qty).toFixed(2)}</td>
            <td style="text-align:right;padding:6px;">${fmt(it.cost_price)}</td>
            <td style="text-align:right;padding:6px;font-weight:700;">${fmt(it.line_total)}</td>
          </tr>`).join('')}
          <tr style="background:#f8fafc;">
            <td colspan="4" style="padding:6px;text-align:right;font-weight:700;">Subtotal — ${escapeHtml(g.name)}</td>
            <td style="padding:6px;text-align:right;font-weight:800;">${fmt(g.subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeHtml(p.purchase_number || 'purchase')}-docket</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a; }
  h1 { margin: 0 0 4px 0; font-size: 20px; }
  .muted { color: #64748b; font-size: 12px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; margin: 14px 0 6px 0; font-size: 13px; }
  .meta-grid div span:first-child { color: #64748b; display: inline-block; min-width: 100px; }
  .total-box { margin-top: 18px; padding: 12px 14px; background: #0f172a; color: #fff; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; font-size: 16px; }
  .signoff { margin-top: 28px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; font-size: 11px; color: #64748b; }
  .signoff > div { border-top: 1px solid #94a3b8; padding-top: 4px; }
</style>
</head>
<body>
  <h1>HQ Purchase Docket</h1>
  <div class="muted">Sosna · ${escapeHtml(p.purchase_number || '')}</div>
  <div class="meta-grid">
    <div><span>Supplier:</span><strong>${escapeHtml(p.supplier_name || '—')}</strong></div>
    <div><span>Invoice #:</span><strong>${escapeHtml(p.invoice_number || '—')}</strong></div>
    <div><span>Date:</span><strong>${escapeHtml(p.date || '')}</strong></div>
    <div><span>Logged by:</span><strong>${escapeHtml(p.created_by_name || '—')}</strong></div>
  </div>
  ${p.notes ? `<div style="margin-top:8px;padding:8px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;font-size:12px;">${escapeHtml(p.notes)}</div>` : ''}
  ${groupHtml || '<p class="muted">No items.</p>'}
  <div class="total-box">
    <span>PURCHASE TOTAL</span>
    <span>${fmt(p.total_amount)}</span>
  </div>
  <div class="signoff">
    <div>Loaded by (HQ)</div>
    <div>Driver / collector</div>
    <div>Received by (branch)</div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const cellInp = { width: '100%', padding: '5px 7px', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 12, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase' };
const tdS = { padding: '4px 6px', color: '#0f172a' };
