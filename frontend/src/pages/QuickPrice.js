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
  const handleCellChange = (productId, conv, newDisplayValue) => {
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
    <div className="page-container">
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
      ) : (
        {/* v1.8.36 — plain wrapper (no data-table-container) so the
            outer page scroll works for all 68 products. The shared
            data-table-container class uses overflow:hidden which
            clipped everything below the visible viewport. */}
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', overflow: 'visible' }}>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Product</th>
                <th style={{ textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>Units (biggest → smallest) — type in any cell, others auto-derive</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.length === 0 ? (
                <tr><td colSpan={2} style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>No products match.</td></tr>
              ) : filteredProducts.map(p => {
                const isDirty = dirtyIds.has(p.id);
                return (
                  <tr key={p.id} style={{ background: isDirty ? '#fffbeb' : undefined }}>
                    <td>
                      <div style={{ fontWeight: 600, color: '#0f172a' }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{p.code}{isDirty && <span style={{ marginLeft: 8, color: '#d97706', fontWeight: 700 }}>● unsaved</span>}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
                        {p._units.map((u, i) => {
                          const val = cellValue(p.id, u.conv);
                          const isLast = i === p._units.length - 1;
                          return (
                            <React.Fragment key={u.name}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <label style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                                  {u.name}{u.is_base && parseFloat(u.conv) === 1 ? '' : ` (${u.conv})`}
                                </label>
                                <div style={{ position: 'relative' }}>
                                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: '#94a3b8', pointerEvents: 'none' }}>{curSym}</span>
                                  <input
                                    type="number" min="0" step="0.01"
                                    value={val === 0 ? '' : val.toFixed(2)}
                                    onChange={e => handleCellChange(p.id, u.conv, e.target.value)}
                                    onWheel={e => e.target.blur()}
                                    placeholder="0.00"
                                    style={{
                                      width: 110, padding: '8px 10px 8px 24px',
                                      borderRadius: 8, fontSize: 13, fontWeight: 600,
                                      border: `2px solid ${isDirty ? '#f59e0b' : '#e5e7eb'}`,
                                      background: isDirty ? '#fffbeb' : '#fff',
                                      color: '#0f172a', outline: 'none',
                                      boxSizing: 'border-box',
                                    }} />
                                </div>
                              </div>
                              {!isLast && <span style={{ color: '#cbd5e1', fontSize: 18 }}>→</span>}
                            </React.Fragment>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
