// v1.8.34 — Quick Price Update.
// One-screen bulk editor for selling prices per packaging. Each row carries
// a single "price per base unit" — every cell on that row renders as
// basePrice × unit.conv. Editing any cell updates the row's basePrice, so
// the other cells re-derive automatically (Option B from the design memo).
import React, { useEffect, useMemo, useState } from 'react';
import { getProducts, bulkUpdatePrices } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiSave, FiRefreshCw } from 'react-icons/fi';

const fmt2 = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const QuickPrice = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState('');
  // Map<productId, basePricePerBaseUnit>. Initialised from existing units_json
  // base-unit price; updated as the user types. Comparing this with the
  // initial value tells us which rows are dirty.
  const [basePrices, setBasePrices] = useState({});
  const [initialBase, setInitialBase] = useState({});
  // v1.8.38 — track which cell is currently being edited + its raw text.
  // The focused cell shows what the user typed verbatim (so "3" stays "3"
  // instead of being instantly reformatted to "3.00", which made typing
  // additional digits impossible). Non-focused cells stay derived from
  // basePrices so editing one auto-updates the others.
  const [editingKey, setEditingKey] = useState(null);   // e.g. "12:Box"
  const [editingRaw, setEditingRaw] = useState('');
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await getProducts();
      const list = Array.isArray(data) ? data : [];
      // Parse units_json per product; keep only those with at least one unit.
      const enriched = list.map(p => {
        let units = [];
        try { units = JSON.parse(p.units_json || '[]'); } catch {}
        units = Array.isArray(units) ? units.filter(u => u && u.name) : [];
        // Sort: biggest conv first, base last.
        units.sort((a, b) => parseFloat(b.conv || 0) - parseFloat(a.conv || 0));
        return { ...p, _units: units };
      }).filter(p => p._units.length > 0);
      setProducts(enriched);
      // Derive basePrice per product = the price of the unit flagged is_base
      // (= price per smallest unit). Falls back to legacy selling_price.
      const base = {};
      for (const p of enriched) {
        const baseUnit = p._units.find(u => u.is_base) || p._units[p._units.length - 1];
        const v = parseFloat(baseUnit?.price);
        base[p.id] = isNaN(v) || v <= 0 ? parseFloat(p.selling_price || 0) || 0 : v;
      }
      setBasePrices(base);
      setInitialBase({ ...base });
    } catch (e) {
      showToast('Failed to load products: ' + (e?.response?.data?.error || e.message), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Edit handler — given a product and the unit the user typed into, plus the
  // new dollar value entered, set basePrices[id] = newValue / unitConv.
  // Also stores the raw text so the focused cell renders verbatim while
  // user is mid-typing (avoids the "type 3, can't add another 3" bug).
  const handleCellChange = (productId, unitName, conv, newDisplayValue) => {
    setEditingKey(`${productId}:${unitName}`);
    setEditingRaw(newDisplayValue);
    const v = parseFloat(newDisplayValue);
    const safe = isNaN(v) || v < 0 ? 0 : v;
    const c = parseFloat(conv) || 1;
    setBasePrices(prev => ({ ...prev, [productId]: safe / c }));
  };

  // Visible value for a cell = basePrice × unit.conv. We keep this purely
  // derived so editing any cell instantly updates the others without
  // separate per-cell state.
  const cellValue = (productId, conv) => {
    const base = basePrices[productId] || 0;
    const c = parseFloat(conv) || 1;
    return base * c;
  };

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p => (p.name || '').toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q));
  }, [products, search]);

  // A row is "dirty" when its current basePrice differs from the initial.
  const dirtyIds = useMemo(() => {
    const out = new Set();
    for (const id of Object.keys(basePrices)) {
      const a = parseFloat(basePrices[id] || 0);
      const b = parseFloat(initialBase[id] || 0);
      if (Math.abs(a - b) > 0.00001) out.add(parseInt(id, 10));
    }
    return out;
  }, [basePrices, initialBase]);

  const handleSaveAll = async () => {
    if (dirtyIds.size === 0) return;
    if (!window.confirm(`Save ${dirtyIds.size} price change${dirtyIds.size > 1 ? 's' : ''}?`)) return;
    setSaving(true);
    try {
      const updates = Array.from(dirtyIds).map(id => ({ id, base_price: basePrices[id] }));
      await bulkUpdatePrices(updates);
      showToast(`${updates.length} product${updates.length > 1 ? 's' : ''} updated.`);
      // Update initial snapshot so dirty set clears without a full reload.
      setInitialBase(prev => {
        const next = { ...prev };
        for (const u of updates) next[u.id] = u.base_price;
        return next;
      });
    } catch (e) {
      showToast('Save failed: ' + (e?.response?.data?.error || e.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (dirtyIds.size === 0) return;
    if (!window.confirm(`Discard ${dirtyIds.size} unsaved change${dirtyIds.size > 1 ? 's' : ''}?`)) return;
    setBasePrices({ ...initialBase });
  };

  if (!hasPermission('Items:Edit') && !hasPermission('Items:QuickPrice')) {
    return <div style={{ padding: 40 }}><h2>Access denied</h2><p>You don't have permission to edit prices.</p></div>;
  }

  return (
    // v1.8.38 — was "page-container" which has no overflow handling;
    // the standard scroll container is .page-content (line 386 of
    // index.css). Switching so all 68 products are reachable.
    <div className="page-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Quick Price Update</h1>
          <p>Edit any unit price — the rest auto-derive. {dirtyIds.size > 0 && <strong style={{ color: '#d97706' }}>{dirtyIds.size} unsaved change{dirtyIds.size > 1 ? 's' : ''}</strong>}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {dirtyIds.size > 0 && (
            <button onClick={handleDiscard} disabled={saving}
              style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <FiRefreshCw size={14} /> Discard
            </button>
          )}
          <button onClick={handleSaveAll} disabled={saving || dirtyIds.size === 0}
            style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: dirtyIds.size > 0 ? '#16a34a' : '#cbd5e1', color: '#fff', cursor: dirtyIds.size > 0 ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <FiSave size={15} /> {saving ? 'Saving…' : `Save All Changes${dirtyIds.size > 0 ? ` (${dirtyIds.size})` : ''}`}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0 18px' }}>
        <div style={{ position: 'relative', flex: '0 0 360px' }}>
          <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} size={15} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search product name or code…"
            style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 10, border: '1.5px solid #e5e7eb', fontSize: 13, background: '#fff', outline: 'none' }} />
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{filteredProducts.length} of {products.length} products</div>
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8' }}>Loading products…</div>
      ) : filteredProducts.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 12 }}>No products match.</div>
      ) : (
        // v1.8.41 — card layout. Each product is its own card; units are
        // stacked vertically inside with full-width inputs. Same on
        // desktop and mobile (no more table getting cut off on phones).
        // Edit any cell → others auto-derive (logic unchanged).
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filteredProducts.map(p => {
            const isDirty = dirtyIds.has(p.id);
            return (
              <div key={p.id} style={{
                background: '#fff',
                border: `1.5px solid ${isDirty ? '#f59e0b' : '#e5e7eb'}`,
                borderRadius: 12,
                padding: 14,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}>
                {/* Header: name + code + dirty marker */}
                <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px dashed #e5e7eb' }}>
                  <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14, lineHeight: 1.2 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                    {p.code}
                    {isDirty && <span style={{ marginLeft: 8, color: '#d97706', fontWeight: 700 }}>● unsaved</span>}
                  </div>
                </div>

                {/* Units stacked top → bottom (biggest first). */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {p._units.map((u, i) => {
                    const cellKey = `${p.id}:${u.name}`;
                    const isEditing = editingKey === cellKey;
                    const derived = cellValue(p.id, u.conv);
                    const displayValue = isEditing ? editingRaw : (derived === 0 ? '' : derived.toFixed(2));
                    const isLast = i === p._units.length - 1;
                    return (
                      <React.Fragment key={u.name}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>
                            {u.name}{u.is_base && parseFloat(u.conv) === 1 ? '' : ` (1 ${u.name} = ${u.conv} ${p._units[p._units.length - 1].name})`}
                          </label>
                          <div style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#94a3b8', pointerEvents: 'none', fontWeight: 600 }}>{curSym}</span>
                            <input
                              type="text" inputMode="decimal"
                              value={displayValue}
                              onChange={e => handleCellChange(p.id, u.name, u.conv, e.target.value)}
                              onBlur={() => { setEditingKey(null); setEditingRaw(''); }}
                              onFocus={() => { setEditingKey(cellKey); setEditingRaw(displayValue); }}
                              onWheel={e => e.target.blur()}
                              placeholder="0.00"
                              style={{
                                width: '100%', padding: '11px 12px 11px 28px',
                                borderRadius: 8, fontSize: 16, fontWeight: 700,
                                border: `2px solid ${isDirty ? '#f59e0b' : '#e5e7eb'}`,
                                background: isDirty ? '#fffbeb' : '#fff',
                                color: '#0f172a', outline: 'none',
                                boxSizing: 'border-box',
                                textAlign: 'right',
                              }} />
                          </div>
                        </div>
                        {!isLast && (
                          <div style={{ textAlign: 'center', color: '#cbd5e1', fontSize: 14, lineHeight: 1 }}>↓</div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 20px', borderRadius: 10, background: toast.type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontWeight: 600, fontSize: 13, boxShadow: '0 10px 24px rgba(0,0,0,0.15)', zIndex: 9999 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
};

export default QuickPrice;
