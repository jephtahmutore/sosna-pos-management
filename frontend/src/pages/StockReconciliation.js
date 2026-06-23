import React, { useState, useEffect, useCallback } from 'react';
import { FiSave, FiClock, FiCheckCircle, FiChevronDown, FiChevronUp, FiTrash2, FiAlertTriangle, FiPrinter } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { getReconciliationProducts, getReconciliations, getReconciliation, createReconciliation, deleteReconciliation, printCountWorksheet } from '../services/api';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import { unitsForProduct as unitsForProductFE, pickDisplayUnit } from '../utils/productUnits';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const todayStr = () => new Date().toISOString().slice(0, 10);

const StockReconciliation = () => {
  const { user, hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const [tab, setTab] = useState('count');
  const [location, setLocation] = useState('sales');
  const [countDate, setCountDate] = useState(todayStr());

  // Count tab
  const [products, setProducts] = useState([]);
  const [counts, setCounts] = useState({});       // { productId: { physical_qty, unit, reason } }
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [toast, setToast] = useState(null);

  // History tab
  const [history, setHistory] = useState([]);
  const [historyFilter, setHistoryFilter] = useState('all'); // 'all' | 'sales' | 'store'
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState({});

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadProducts = useCallback(async () => {
    try {
      const res = await getReconciliationProducts(location, countDate);
      // v1.6.3: hide inactive items.
      setProducts((res.data || []).filter(p => (p.status || 'Active') !== 'Inactive'));
      // Reset counts when location or date changes — old values would compare
      // against the wrong system_qty.
      setCounts({});
    } catch (err) {
      setProducts([]);
    }
  }, [location, countDate]);

  // History uses its own filter (independent of count location) so user can view ALL or per-floor
  const loadHistory = useCallback(async () => {
    try {
      const res = await getReconciliations(historyFilter === 'all' ? null : historyFilter);
      setHistory(res.data || []);
    } catch (err) { setHistory([]); }
  }, [historyFilter]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const updateCount = (productId, field, value) => {
    setCounts(prev => ({ ...prev, [productId]: { ...(prev[productId] || {}), [field]: value } }));
  };

  // Compute live variance for a row (in BASE units)
  const lineVariance = (p, c) => {
    if (!c || c.physical_qty === '' || c.physical_qty == null || isNaN(parseFloat(c.physical_qty))) return null;
    const qty = parseFloat(c.physical_qty);
    const units = unitsForProductFE(p);
    const u = units.find(x => x.name === (c.unit || p.unit)) || units.find(x => x.is_base) || { conv: 1 };
    const physicalBase = qty * (u.conv || 1);
    return physicalBase - parseFloat(p.system_qty || 0);
  };

  // Silent thermal print of a count worksheet — same printer the receipts
  // use. Sends the currently-filtered products with their system qty so a
  // manager can carry the rolled sheet into the warehouse with a pen.
  // NOTE: button isn't rendered yet — handler is here ready to be wired.
  const [printingSheet, setPrintingSheet] = useState(false);
  const printWorksheet = async () => {
    if (filteredProducts.length === 0) return;
    setPrintingSheet(true);
    try {
      const formatDate = (s) => {
        const d = s ? new Date(s) : new Date();
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      };
      await printCountWorksheet({
        location: location === 'sales' ? 'Sales Floor' : 'Store Floor',
        countDate: formatDate(countDate),
        cashier: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || null,
        notes,
        products: filteredProducts.map(p => {
          // `system_display` = the multi-unit breakdown ("877 Crates + 12 pcs")
          // `system_base`    = the same value rounded to the base unit only
          //                    ("21,060.00 pcs") so the worksheet can show
          //                    both when they differ.
          const baseQty = parseFloat(p.system_qty) || 0;
          return {
            product_name: p.name,
            sku: p.code || '',
            system_display: formatStockForProduct(baseQty, p, { showBaseInParens: false }),
            system_base:    `${baseQty.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${p.unit}`,
          };
        }),
      });
      showToast('Worksheet sent to printer.', 'success');
    } catch (err) {
      showToast(err.response?.data?.error || 'Print failed.', 'error');
    } finally {
      setPrintingSheet(false);
    }
  };

  const postCount = async () => {
    const items = products
      .map(p => {
        const c = counts[p.id] || {};
        if (c.physical_qty === '' || c.physical_qty == null || c.physical_qty === undefined) return null;
        if (isNaN(parseFloat(c.physical_qty))) return null;
        return {
          product_id: p.id,
          physical_qty: parseFloat(c.physical_qty),
          unit: c.unit || p.unit,
          reason: c.reason || null,
        };
      })
      .filter(Boolean);

    if (items.length === 0) {
      showToast('Enter physical count for at least one item before posting.', 'error');
      return;
    }

    setPosting(true);
    try {
      await createReconciliation({ count_date: countDate, location, notes, items });
      setPosted(true);
      setCounts({});
      setNotes('');
      await Promise.all([loadProducts(), loadHistory()]);
      showToast('Stock reconciliation posted.', 'success');
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to post reconciliation.', 'error');
    } finally {
      setPosting(false);
    }
  };

  const expandRow = async (id) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!detail[id]) {
      try {
        const res = await getReconciliation(id);
        setDetail(prev => ({ ...prev, [id]: res.data }));
      } catch (_) {
        setDetail(prev => ({ ...prev, [id]: { items: [] } }));
      }
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const removeHistory = (id) => {
    setPendingDelete({
      subject: 'Reconciliation — stock adjustments will be reversed',
      perform: async () => {
        try {
          await deleteReconciliation(id);
          await Promise.all([loadProducts(), loadHistory()]);
          if (expandedId === id) setExpandedId(null);
          showToast('Reconciliation deleted.', 'success');
        } catch (err) {
          showToast(err.response?.data?.error || 'Failed to delete.', 'error');
        }
      },
    });
  };

  const filteredProducts = products.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.code || '').toLowerCase().includes(search.toLowerCase()));
  const countedCount = Object.values(counts).filter(c => c?.physical_qty !== '' && c?.physical_qty != null).length;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('stockReconciliation')}</h1>
          <p>{t('stockReconciliationSubtitle')}</p>
        </div>
        {tab === 'count' && hasPermission('StockReconciliation:Add') !== false && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={printWorksheet} disabled={printingSheet || filteredProducts.length === 0}
              title="Print a thermal worksheet for the warehouse"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: printingSheet || filteredProducts.length === 0 ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600, opacity: printingSheet || filteredProducts.length === 0 ? 0.55 : 1 }}>
              <FiPrinter size={14} /> {printingSheet ? 'Printing…' : 'Print Sheet'}
            </button>
            <button onClick={postCount} disabled={posting || countedCount === 0}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 8, cursor: posting || countedCount === 0 ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, opacity: posting || countedCount === 0 ? 0.55 : 1 }}>
              <FiSave size={14} /> {posting ? 'Posting…' : `Post Count (${countedCount})`}
            </button>
          </div>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, padding: '10px 18px', borderRadius: 8, color: '#fff', fontWeight: 600, background: toast.type === 'error' ? '#dc2626' : '#16a34a', boxShadow: '0 4px 14px rgba(0,0,0,0.18)', zIndex: 1100 }}>
          {toast.msg}
        </div>
      )}

      {/* Location + date selectors — only relevant for the Count tab */}
      {tab === 'count' && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>{t('location')}</label>
            <div style={{ display: 'inline-flex', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
              {['sales', 'store'].map(loc => (
                <button key={loc} onClick={() => setLocation(loc)}
                  style={{ padding: '8px 18px', border: 'none', background: location === loc ? '#1e40af' : '#fff', color: location === loc ? '#fff' : '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>
                  {loc} Floor
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>{t('countDate')}</label>
            <input type="date" value={countDate} onChange={e => setCountDate(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
        {[
          { key: 'count', label: 'Count', icon: <FiCheckCircle size={14} /> },
          { key: 'history', label: `History (${history.length})`, icon: <FiClock size={14} /> },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '10px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: tab === t.key ? '#1e40af' : '#64748b', borderBottom: tab === t.key ? '3px solid #1e40af' : '3px solid transparent', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Count tab */}
      {tab === 'count' && (
        <>
          <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiAlertTriangle size={16} />
            <span><strong>Leave the count blank</strong> for items you didn't count — they're skipped (no variance, no stock movement). Only enter values for items you physically counted.</span>
          </div>

          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('searchProducts')}
            style={{ width: '100%', padding: '9px 14px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, marginBottom: 10, boxSizing: 'border-box' }} />

          <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('notesOptional')}
            style={{ width: '100%', padding: '8px 14px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }} />

          <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Product</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 200 }}>System Qty</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 140 }}>Physical Qty</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 130 }}>Unit</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 110 }}>Variance</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 180 }}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No products.</td></tr>
                ) : filteredProducts.map(p => {
                  const c = counts[p.id] || {};
                  const variance = lineVariance(p, c);
                  const varianceClass = variance == null ? '' : variance > 0.0001 ? '#16a34a' : variance < -0.0001 ? '#dc2626' : '#6b7280';
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 14px' }}>
                        <div style={{ fontWeight: 500, color: '#111827' }}>{p.name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.code || '—'}</div>
                      </td>
                      <td style={{ padding: '8px 14px', textAlign: 'right', color: '#374151' }}>
                        {formatStockForProduct(p.system_qty, p)}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <input type="number" min="0" step="1" placeholder="—"
                          value={c.physical_qty ?? ''}
                          onChange={e => updateCount(p.id, 'physical_qty', e.target.value)}
                          style={{ width: '100%', padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, textAlign: 'right', boxSizing: 'border-box' }} />
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        {(() => {
                          const units = unitsForProductFE(p);
                          if (units.length <= 1) {
                            return <div style={{ padding: '7px 8px', color: '#6b7280', fontSize: 13 }}>{p.unit}</div>;
                          }
                          return (
                            <select value={c.unit || p.unit}
                              onChange={e => updateCount(p.id, 'unit', e.target.value)}
                              style={{ width: '100%', padding: '7px 6px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' }}>
                              {units.map(u => (
                                <option key={u.name} value={u.name}>
                                  {u.name}{u.is_base ? '' : ` (1=${u.conv})`}
                                </option>
                              ))}
                            </select>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '8px 14px', textAlign: 'right', color: varianceClass, fontWeight: 600 }}>
                        {variance == null ? '—' : (() => {
                          // Variance is computed in base units (pcs). Render
                          // it in the product's DEFAULT unit (e.g. Crates) so
                          // the manager reads "−596.50 Crates" instead of
                          // "−14,316 pcs". Show the base total as a small
                          // parenthetical underneath when the two differ.
                          const du = pickDisplayUnit(p);
                          const conv = parseFloat(du.conv) || 1;
                          const varDefault = variance / conv;
                          const sign = variance > 0 ? '+' : '';
                          const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                          const showBase = conv !== 1 && du.name !== p.unit;
                          return (
                            <>
                              <div>{sign}{fmt(varDefault)} {du.name}</div>
                              {showBase && (
                                <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.75 }}>
                                  ({sign}{fmt(variance)} {p.unit})
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <input type="text" placeholder="(optional)"
                          value={c.reason || ''}
                          onChange={e => updateCount(p.id, 'reason', e.target.value)}
                          style={{ width: '100%', padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* History tab */}
      {tab === 'history' && (
        <>
          {/* Filter pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Show:</span>
            {['all', 'sales', 'store'].map(opt => (
              <button key={opt} onClick={() => setHistoryFilter(opt)}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                  border: historyFilter === opt ? '1.5px solid #1e40af' : '1px solid #e5e7eb',
                  background: historyFilter === opt ? '#dbeafe' : '#fff',
                  color: historyFilter === opt ? '#1e40af' : '#6b7280',
                  cursor: 'pointer', textTransform: 'capitalize'
                }}>
                {opt === 'all' ? 'All Locations' : `${opt} Floor`}
              </button>
            ))}
          </div>

          {/* Stats — totals across filtered history */}
          {(() => {
            const totals = history.reduce((acc, h) => {
              const v = parseFloat(h.variance_value || 0);
              acc.count += 1;
              acc.total += v;
              acc.byLoc[h.location] = (acc.byLoc[h.location] || 0) + v;
              acc.itemsTotal += parseInt(h.item_count || 0);
              return acc;
            }, { count: 0, total: 0, byLoc: {}, itemsTotal: 0 });
            const positiveTotal = history.reduce((s, h) => parseFloat(h.variance_value || 0) > 0 ? s + parseFloat(h.variance_value) : s, 0);
            const negativeTotal = history.reduce((s, h) => parseFloat(h.variance_value || 0) < 0 ? s + parseFloat(h.variance_value) : s, 0);

            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reconciliations</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#111827', marginTop: 4 }}>{totals.count}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{totals.itemsTotal} items counted</div>
                </div>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Net Variance Value</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: totals.total > 0 ? '#16a34a' : totals.total < 0 ? '#dc2626' : '#111827', marginTop: 4 }}>
                    {totals.total > 0 ? '+' : ''}${(parseFloat(totals.total)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>positive = found extra · negative = shrinkage</div>
                </div>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Surplus</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#16a34a', marginTop: 4 }}>+{curSym}{(parseFloat(positiveTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Shrinkage</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626', marginTop: 4 }}>−{curSym}{(parseFloat(Math.abs(negativeTotal))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
                {historyFilter === 'all' && Object.keys(totals.byLoc).length > 1 && (
                  <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb', gridColumn: 'span 2' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>By Location</div>
                    {Object.entries(totals.byLoc).map(([loc, val]) => (
                      <div key={loc} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: '#374151', textTransform: 'capitalize' }}>{loc} Floor</span>
                        <span style={{ fontWeight: 600, color: val > 0 ? '#16a34a' : val < 0 ? '#dc2626' : '#6b7280' }}>
                          {val > 0 ? '+' : ''}{curSym}{(parseFloat(val)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
          {history.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No past reconciliations for this filter.</div>
          ) : (
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Date</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Location</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Counted By</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Items</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Variance Value</th>
                  <th style={{ padding: '11px 14px', width: 80, borderBottom: '1px solid #e5e7eb' }}></th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <React.Fragment key={h.id}>
                    <tr style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }} onClick={() => expandRow(h.id)}>
                      <td style={{ padding: '10px 14px', fontWeight: 500 }}>{h.count_date}</td>
                      <td style={{ padding: '10px 14px', textTransform: 'capitalize' }}>{h.location}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{h.created_by_name || '—'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>{h.item_count}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: parseFloat(h.variance_value || 0) > 0 ? '#16a34a' : parseFloat(h.variance_value || 0) < 0 ? '#dc2626' : '#6b7280' }}>
                        {(() => {
                          const v = parseFloat(h.variance_value || 0);
                          if (v < 0) return `−${curSym}${(parseFloat(Math.abs(v))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                          if (v > 0) return `+${curSym}${(parseFloat(v)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                          return `${curSym}0.00`;
                        })()}
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                        <button onClick={e => { e.stopPropagation(); removeHistory(h.id); }}
                          style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4, marginRight: 6 }} title="Delete">
                          <FiTrash2 size={14} />
                        </button>
                        {expandedId === h.id ? <FiChevronUp /> : <FiChevronDown />}
                      </td>
                    </tr>
                    {expandedId === h.id && (
                      <tr>
                        <td colSpan={6} style={{ padding: '0 14px 12px', background: '#f9fafb' }}>
                          {!detail[h.id] ? (
                            <div style={{ padding: 12, color: '#9ca3af', fontSize: 12 }}>Loading…</div>
                          ) : (
                            <div style={{ paddingTop: 8 }}>
                              {detail[h.id].notes && (
                                <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}>
                                  <strong>Notes:</strong> {detail[h.id].notes}
                                </div>
                              )}
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                  <tr style={{ background: '#fff' }}>
                                    <th style={{ padding: '7px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Product</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>System</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Physical</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Variance</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Cost</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Reason</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(detail[h.id].items || []).map(it => (
                                    <tr key={it.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                      <td style={{ padding: '6px 10px' }}>{it.product_name}</td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{formatStock(it.system_qty, it.product_unit, it.alt_unit, it.conversion_factor)}</td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{(parseFloat(parseFloat(it.physical_qty))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {it.unit}</td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: parseFloat(it.variance_base) > 0 ? '#16a34a' : parseFloat(it.variance_base) < 0 ? '#dc2626' : '#6b7280' }}>
                                        {parseFloat(it.variance_base) > 0 ? '+' : ''}{(parseFloat(parseFloat(it.variance_base))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {it.product_unit}
                                      </td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#6b7280' }}>{curSym}{(parseFloat(parseFloat(it.cost_at_count))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                                      <td style={{ padding: '6px 10px', color: '#6b7280' }}>{it.reason || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
        </>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default StockReconciliation;
