// v1.8.34 — Quick Price Update.
// Every unit price is edited on its own — changing one cell never
// recalculates the others. (Until v1.10.332 the default / base unit
// cascaded base × conv to every packaging; shops that price Box, Six
// Pack and Pcs independently kept having their other prices rewritten.)
// The backend still wants a base price plus per-unit prices, so on save
// the base unit goes up as base_price and every other unit as an
// explicit unit_prices entry.
import React, { useEffect, useMemo, useState } from 'react';
import { getProducts, bulkUpdatePrices } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiSave, FiRefreshCw } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';

const fmt2 = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Base unit = the one flagged is_base, else the smallest packaging
// (units are sorted biggest conv first, so that's the last one).
const baseUnitOf = (product) =>
  product._units.find(u => u.is_base) || product._units[product._units.length - 1];

// Which packaging gets the DEFAULT badge. Falls back to the base unit
// when the product has no default_unit set.
const defaultUnitName = (product) => {
  const dflt = (product.default_unit || '').trim();
  if (dflt) return dflt;
  return baseUnitOf(product)?.name || '';
};

const QuickPrice = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState('');
  // Map<productId, Map<unitName, price>> — one independent price per unit.
  const [prices, setPrices] = useState({});
  const [initialPrices, setInitialPrices] = useState({});
  // Track which cell is currently focused + its raw text. The focused cell
  // shows verbatim so "3" doesn't reformat to "3.00" mid-typing.
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
      const enriched = list.map(p => {
        let units = [];
        try { units = JSON.parse(p.units_json || '[]'); } catch {}
        units = Array.isArray(units) ? units.filter(u => u && u.name) : [];
        // Sort: biggest conv first, base last.
        units.sort((a, b) => parseFloat(b.conv || 0) - parseFloat(a.conv || 0));
        return { ...p, _units: units };
      }).filter(p => p._units.length > 0);
      setProducts(enriched);
      // Each cell starts at its stored price. Units that never had a
      // price saved fall back to base × conv so the cell isn't blank.
      const loaded = {};
      for (const p of enriched) {
        const baseUnit = baseUnitOf(p);
        const v = parseFloat(baseUnit?.price);
        const bp = isNaN(v) || v <= 0 ? parseFloat(p.selling_price || 0) || 0 : v;
        const forProduct = {};
        for (const u of p._units) {
          const stored = parseFloat(u.price);
          forProduct[u.name] = u === baseUnit ? bp
            : stored > 0 ? stored
            : bp * (parseFloat(u.conv) || 0);
        }
        loaded[p.id] = forProduct;
      }
      setPrices(loaded);
      setInitialPrices(JSON.parse(JSON.stringify(loaded)));
    } catch (e) {
      showToast('Failed to load products: ' + (e?.response?.data?.error || e.message), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Edit handler — only the edited cell changes.
  const handleCellChange = (product, unit, newDisplayValue) => {
    const cellKey = `${product.id}:${unit.name}`;
    setEditingKey(cellKey);
    setEditingRaw(newDisplayValue);
    const v = parseFloat(newDisplayValue);
    const safe = isNaN(v) || v < 0 ? 0 : v;
    setPrices(prev => ({
      ...prev,
      [product.id]: { ...(prev[product.id] || {}), [unit.name]: safe },
    }));
  };

  const cellValue = (productId, unit) => parseFloat(prices[productId]?.[unit.name]) || 0;

  const filteredProducts = useMemo(() => {
    return products.filter(p => matchTokens(search, p.name, p.code, p.barcode));
  }, [products, search]);

  // Dirty when any unit price differs from what was loaded / last saved.
  const dirtyIds = useMemo(() => {
    const out = new Set();
    for (const id of Object.keys(prices)) {
      const cur = prices[id] || {};
      const init = initialPrices[id] || {};
      const changed = Object.keys(cur).some(k =>
        Math.abs((parseFloat(cur[k]) || 0) - (parseFloat(init[k]) || 0)) > 0.005);
      if (changed) out.add(parseInt(id, 10));
    }
    return out;
  }, [prices, initialPrices]);

  const handleSaveAll = async () => {
    if (dirtyIds.size === 0) return;
    if (!window.confirm(`Save ${dirtyIds.size} price change${dirtyIds.size > 1 ? 's' : ''}?`)) return;
    setSaving(true);
    try {
      // Payload: base_price = the base unit's own price; every other unit
      // goes up as an explicit unit_prices entry so the backend stores it
      // as typed instead of deriving base × conv. A unit left blank has no
      // entry — the backend then falls back to base × conv for it, and we
      // mirror that value locally so the screen matches what was saved.
      const saved = {};
      const updates = Array.from(dirtyIds).map(id => {
        const product = products.find(p => p.id === id);
        const baseUnit = baseUnitOf(product);
        const cur = prices[id] || {};
        const basePrice = (parseFloat(cur[baseUnit.name]) || 0) / (parseFloat(baseUnit.conv) || 1);
        const unitPrices = {};
        const after = {};
        for (const u of product._units) {
          const val = parseFloat(cur[u.name]) || 0;
          if (u === baseUnit) { after[u.name] = val; continue; }
          if (val > 0) { unitPrices[u.name] = val; after[u.name] = val; }
          else after[u.name] = basePrice * (parseFloat(u.conv) || 1);
        }
        saved[id] = after;
        const payload = { id, base_price: basePrice };
        if (Object.keys(unitPrices).length > 0) payload.unit_prices = unitPrices;
        return payload;
      });
      await bulkUpdatePrices(updates);
      showToast(`${updates.length} product${updates.length > 1 ? 's' : ''} updated.`);
      setPrices(prev => ({ ...prev, ...saved }));
      setInitialPrices(prev => ({ ...prev, ...JSON.parse(JSON.stringify(saved)) }));
    } catch (e) {
      showToast('Save failed: ' + (e?.response?.data?.error || e.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (dirtyIds.size === 0) return;
    if (!window.confirm(`Discard ${dirtyIds.size} unsaved change${dirtyIds.size > 1 ? 's' : ''}?`)) return;
    setPrices(JSON.parse(JSON.stringify(initialPrices)));
  };

  if (!hasPermission('Items:Edit') && !hasPermission('Items:QuickPrice')) {
    return <div style={{ padding: 40 }}><h2>Access denied</h2><p>You don't have permission to edit prices.</p></div>;
  }

  return (
    <div className="page-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Quick Price Update</h1>
          <p>Each unit price is set on its own — changing one does not recalculate the others. {dirtyIds.size > 0 && <strong style={{ color: '#d97706' }}>{dirtyIds.size} unsaved change{dirtyIds.size > 1 ? 's' : ''}</strong>}</p>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filteredProducts.map(p => {
            const isDirty = dirtyIds.has(p.id);
            const dfltName = defaultUnitName(p);
            return (
              <div key={p.id} style={{
                background: '#fff',
                border: `1.5px solid ${isDirty ? '#f59e0b' : '#e5e7eb'}`,
                borderRadius: 12,
                padding: 14,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}>
                <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px dashed #e5e7eb' }}>
                  <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14, lineHeight: 1.2 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                    {p.code}
                    {isDirty && <span style={{ marginLeft: 8, color: '#d97706', fontWeight: 700 }}>● unsaved</span>}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {p._units.map((u) => {
                    const cellKey = `${p.id}:${u.name}`;
                    const isEditing = editingKey === cellKey;
                    const derived = cellValue(p.id, u);
                    const displayValue = isEditing ? editingRaw : (derived === 0 ? '' : derived.toFixed(2));
                    const isDefault = (u.name || '').trim() === dfltName;
                    return (
                      <React.Fragment key={u.name}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span>{u.name}{u.is_base && parseFloat(u.conv) === 1 ? '' : ` (1 ${u.name} = ${u.conv} ${p._units[p._units.length - 1].name})`}</span>
                            {isDefault && (
                              <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '1px 6px', borderRadius: 4, fontSize: 9, letterSpacing: 0.4 }}>DEFAULT</span>
                            )}
                          </label>
                          <div style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#94a3b8', pointerEvents: 'none', fontWeight: 600 }}>{curSym}</span>
                            <input
                              type="text" inputMode="decimal"
                              value={displayValue}
                              onChange={e => handleCellChange(p, u, e.target.value)}
                              onBlur={() => { setEditingKey(null); setEditingRaw(''); }}
                              onFocus={() => { setEditingKey(cellKey); setEditingRaw(displayValue); }}
                              onWheel={e => e.target.blur()}
                              placeholder="0.00"
                              style={{
                                width: '100%', padding: '11px 12px 11px 28px',
                                borderRadius: 8, fontSize: 16, fontWeight: 700,
                                border: `2px solid ${isDirty ? '#f59e0b' : (isDefault ? '#93c5fd' : '#e5e7eb')}`,
                                background: isDirty ? '#fffbeb' : (isDefault ? '#eff6ff' : '#fff'),
                                color: '#0f172a', outline: 'none',
                                boxSizing: 'border-box',
                                textAlign: 'right',
                              }} />
                          </div>
                        </div>
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
