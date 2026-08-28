import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProducts, getSalesBinCard, getSettings, getHqGrnForBranch } from '../services/api';
import { FiSearch, FiPrinter, FiShoppingCart, FiArrowDown, FiArrowUp, FiActivity, FiX, FiFileText, FiUser, FiCalendar, FiTruck, FiHash } from 'react-icons/fi';
import { pickDisplayUnit } from '../utils/productUnits';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';

// Map a document reference number to the page that hosts its detail view.
// Returns { path, ref } for clickable references, or null for plain text
// (e.g. internal labels like 'credit_note', 'opening', 'adjustment').
function refTarget(refNumber) {
  if (!refNumber) return null;
  const s = String(refNumber).trim();
  if (/^SIV-/i.test(s)) return { path: '/stock/siv', ref: s };
  if (/^GRN-/i.test(s)) return { path: '/stock/grn', ref: s };
  return null;
}

const todayStr = new Date().toISOString().split('T')[0];
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

const formatDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

// v1.10.318 — labels cover every movement_type the sales bin card can
// surface (grn, transfer in/out, credit note, production, etc.) and
// direction is honoured via the qty sign on the caller side. Falls back
// to a title-cased version of the raw type when a new one shows up.
const movementLabel = (type, qty) => {
  if (type === 'siv')            return 'SIV In';
  if (type === 'sale')           return 'Sale';
  if (type === 'sale_reverse')   return 'Sale Reversal';
  if (type === 'reverse')        return 'Reversal';
  if (type === 'sales_return')   return 'Damage';
  if (type === 'reconciliation') return 'Reconciliation';
  if (type === 'adjustment')     return 'Adjustment';
  if (type === 'grn')            return 'GRN In';
  if (type === 'hq_grn')         return 'HQ GRN In';
  if (type === 'credit_note')    return 'Credit Note Out';
  if (type === 'transfer')       return parseFloat(qty) > 0 ? 'Transfer In' : 'Transfer Out';
  if (type === 'transfer_in')    return 'Transfer In';
  if (type === 'transfer_out')   return 'Transfer Out';
  if (type === 'production')     return 'Production';
  if (type === 'opening')        return 'Opening';
  // Title-case anything unknown so the pill reads cleanly.
  return String(type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

const typeStyle = (type) => {
  if (type === 'siv')            return { background: '#dcfce7', color: '#166534' };   // green — IN
  if (type === 'grn' || type === 'hq_grn') return { background: '#dcfce7', color: '#166534' }; // green — IN
  if (type === 'sale')           return { background: '#fee2e2', color: '#dc2626' };   // red — OUT
  if (type === 'credit_note')    return { background: '#fee2e2', color: '#dc2626' };   // red — OUT
  if (type === 'reverse' || type === 'sale_reverse') return { background: '#dbeafe', color: '#1d4ed8' };
  if (type === 'sales_return')   return { background: '#fef9c3', color: '#854d0e' };   // amber — damage
  if (type === 'transfer' || type === 'transfer_in' || type === 'transfer_out')
                                 return { background: '#e0e7ff', color: '#4338ca' };   // indigo — transfer
  if (type === 'production')     return { background: '#f3e8ff', color: '#7c3aed' };   // purple
  if (type === 'reconciliation') return { background: '#ede9fe', color: '#7c3aed' };
  if (type === 'opening')        return { background: '#dbeafe', color: '#1d4ed8' };
  return { background: '#f3f4f6', color: '#374151' };
};

const ACCENT = '#b91c1c';
const ACCENT_DARK = '#7f1d1d';
const ACCENT_LIGHT = '#fef2f2';

const SalesBinCard = () => {
  const navigate = useNavigate();
  const [products, setProducts]           = useState([]);
  const [productId, setProductId]         = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [from, setFrom]                   = useState(firstOfMonth);
  const [to, setTo]                       = useState(todayStr);
  const [rows, setRows]                   = useState([]);
  const [openingBal, setOpeningBal]       = useState(0);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');
  const [searched, setSearched]           = useState(false);
  const [businessInfo, setBusinessInfo]   = useState({});
  const [showPrint, setShowPrint]         = useState(false);
  // v1.10.315 — IN/OUT/ALL row filter. Client-side; totals bar stays
  // period-wide; balance column keeps true cumulative value so bank-
  // style filtering doesn't rewrite history.
  const [rowFilter, setRowFilter]         = useState('all');
  // v1.10.323 — HQ GRN read-only modal. Sosna procurement is HQ-owned,
  // so GRN references on the branch bin-card don't exist in the branch
  // grn table — clicking them used to land on an empty branch page.
  // Now they open this modal, populated from master.hq_grns via the
  // new /api/inventory/hq-grn/:syncId endpoint.
  const [hqGrn, setHqGrn]                 = useState(null); // { grn, items, purchase }
  const [hqGrnLoading, setHqGrnLoading]   = useState(false);
  const [hqGrnError, setHqGrnError]       = useState('');

  useModalScrollLock(showPrint);
  useModalScrollLock(!!hqGrn || hqGrnLoading);

  const openHqGrn = async (syncId) => {
    if (!syncId) return;
    setHqGrnError('');
    setHqGrn(null);
    setHqGrnLoading(true);
    try {
      const res = await getHqGrnForBranch(syncId);
      setHqGrn(res.data);
    } catch (err) {
      setHqGrnError(err.response?.data?.error || 'Failed to load HQ GRN.');
    } finally {
      setHqGrnLoading(false);
    }
  };
  const closeHqGrn = () => { setHqGrn(null); setHqGrnError(''); };

  useEffect(() => {
    // v1.6.3: hide inactive items from the product picker.
    getProducts().then(r => setProducts(
      (r.data || []).filter(p => (p.status || 'Active') !== 'Inactive').sort((a, b) => a.name.localeCompare(b.name))
    )).catch(() => {});
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  const selectedProduct = products.find(p => String(p.id) === String(productId));

  const handleProductInput = (val) => {
    setProductSearch(val);
    const match = products.find(p => `${p.name}${p.unit ? ` (${p.unit})` : ''}` === val);
    setProductId(match ? String(match.id) : '');
  };

  const handleSearch = async () => {
    if (!productId) { setError('Please select a product.'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await getSalesBinCard({ product_id: productId, from, to });
      setRows(res.data?.rows || []);
      setOpeningBal(parseFloat(res.data?.opening_balance ?? 0));
      setSearched(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load sales bin card.');
    } finally {
      setLoading(false);
    }
  };

  // Convert base-unit movements/balances into the product's display unit so
  // everything (cards, table, totals, print) renders in the same unit.
  const dispUnit = pickDisplayUnit(selectedProduct);
  const conv = dispUnit?.conv || 1;
  const toDisp = (baseQty) => parseFloat(baseQty || 0) / conv;
  const unitLabel = dispUnit?.name || selectedProduct?.unit || '';

  const totalIn  = toDisp(rows.filter(r => parseFloat(r.quantity) > 0).reduce((s, r) => s + parseFloat(r.quantity), 0));
  const totalOut = toDisp(rows.filter(r => parseFloat(r.quantity) < 0).reduce((s, r) => s + Math.abs(parseFloat(r.quantity)), 0));
  const openBal  = toDisp(openingBal);
  const closeBal = toDisp(rows.length > 0 ? parseFloat(rows[rows.length - 1].balance) : openingBal);

  return (
    <div style={{ padding: '24px', background: '#f8fafc', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg,${ACCENT_DARK},${ACCENT})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(185,28,28,0.25)' }}>
              <FiShoppingCart size={22} color="#fff" />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Sales Bin Card</h1>
              <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Sales counter stock movement history per product</p>
            </div>
          </div>
          {searched && (rows.length > 0 || openBal > 0) && (
            <button onClick={() => setShowPrint(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              <FiPrinter size={15} /> Print
            </button>
          )}
        </div>
      </div>

      {/* Filter Bar */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 20px', marginBottom: 24, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <div style={{ flex: '2 1 220px', minWidth: 180 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Product *</label>
          <input list="salesbincard-products" value={productSearch} onChange={e => handleProductInput(e.target.value)}
            placeholder="Type or select a product…"
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
          <datalist id="salesbincard-products">
            {products.map(p => <option key={p.id} value={`${p.name}${p.unit ? ` (${p.unit})` : ''}`} />)}
          </datalist>
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 130 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }} />
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 130 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }} />
        </div>
        <div>
          <button onClick={handleSearch} disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 22px', borderRadius: 8, border: 'none', background: loading ? '#9ca3af' : ACCENT, color: '#fff', cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiSearch size={14} /> {loading ? 'Loading…' : 'Show'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 16px', marginBottom: 20, fontSize: 13, color: '#dc2626' }}>{error}</div>
      )}

      {/* Summary Cards */}
      {searched && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 24 }}>
          {[
            { label: 'Opening Balance', value: openBal.toFixed(2),  unit: unitLabel, color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe', icon: <FiActivity size={18} /> },
            { label: 'Total In',        value: totalIn.toFixed(2),   unit: unitLabel, color: '#166534', bg: '#dcfce7', border: '#86efac', icon: <FiArrowDown size={18} /> },
            { label: 'Total Out',       value: totalOut.toFixed(2),  unit: unitLabel, color: '#b45309', bg: '#fef9c3', border: '#fcd34d', icon: <FiArrowUp size={18} /> },
            { label: 'Closing Balance', value: closeBal.toFixed(2),  unit: unitLabel, color: '#7c3aed', bg: '#f5f3ff', border: '#c4b5fd', icon: <FiShoppingCart size={18} /> },
          ].map((c, i) => (
            <div key={i} style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: c.color }}>{c.label}</span>
                <span style={{ color: c.color }}>{c.icon}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: c.color }}>{c.value}</div>
              {c.unit && <div style={{ fontSize: 11, color: c.color, opacity: 0.7, marginTop: 2 }}>{c.unit}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {searched && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>
              {selectedProduct ? selectedProduct.name : 'Product'} — Sales Bin Card
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {formatDate(from)} – {formatDate(to)} &nbsp;·&nbsp; {rows.length} movement{rows.length !== 1 ? 's' : ''}
            </div>
          </div>

          {/* v1.10.315 — IN / OUT / ALL filter pills with counts */}
          {rows.length > 0 && (() => {
            const inCount  = rows.filter(r => parseFloat(r.quantity) > 0).length;
            const outCount = rows.filter(r => parseFloat(r.quantity) < 0).length;
            const pill = (key, label, count, activeBg, activeFg) => {
              const active = rowFilter === key;
              return (
                <button
                  key={key}
                  onClick={() => setRowFilter(key)}
                  style={{
                    padding: '6px 14px', borderRadius: 20, border: `1px solid ${active ? activeBg : '#e5e7eb'}`,
                    background: active ? activeBg : '#fff',
                    color: active ? activeFg : '#374151',
                    fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}
                >
                  {label}
                  <span style={{ background: active ? activeFg : '#f3f4f6', color: active ? activeBg : '#6b7280', borderRadius: 10, padding: '1px 7px', fontSize: 11 }}>{count}</span>
                </button>
              );
            };
            return (
              <div style={{ padding: '10px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 8, alignItems: 'center', background: '#fff' }}>
                {pill('all', 'All',  rows.length, '#1d4ed8', '#fff')}
                {pill('in',  'IN',   inCount,     '#166534', '#fff')}
                {pill('out', 'OUT',  outCount,    '#b45309', '#fff')}
              </div>
            );
          })()}

          {rows.length === 0 && openBal === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
              No sales movements found for this product in the selected period.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 520px)', minHeight: 120 }}>
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                  <tr style={{ background: ACCENT, color: '#fff' }}>
                    {['#', 'Date', 'Reference', 'Type', 'Supplier', 'In', 'Out', 'Balance'].map((h, i) => (
                      <th key={i} style={{ padding: '11px 14px', textAlign: i >= 5 ? 'right' : 'left', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap', background: ACCENT }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ background: '#eff6ff', borderBottom: '1px solid #dbeafe' }}>
                    <td style={{ padding: '10px 14px', color: '#9ca3af', fontFamily: 'monospace' }}>—</td>
                    <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>{formatDate(from)}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>—</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8' }}>Opening Balance</span>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#9ca3af' }}>—</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#166534', fontWeight: 700, fontFamily: 'monospace' }}>{openBal > 0 ? openBal.toFixed(2) : '—'}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626', fontWeight: 700, fontFamily: 'monospace' }}>—</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#1d4ed8', fontWeight: 800, fontFamily: 'monospace' }}>{(parseFloat(openBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                  {rows.filter(row => {
                    // v1.10.315 — apply IN/OUT filter (keep original row index
                    // for #; balance stays truthful because it came from the
                    // backend's cumulative running_total).
                    if (rowFilter === 'in')  return parseFloat(row.quantity) > 0;
                    if (rowFilter === 'out') return parseFloat(row.quantity) < 0;
                    return true;
                  }).map((row, idx) => {
                    const qty   = parseFloat(row.quantity);
                    const isIn  = qty > 0;
                    const isOut = qty < 0;
                    const ts    = typeStyle(row.movement_type);
                    return (
                      <tr key={row.id} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa', borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '10px 14px', color: '#9ca3af', fontFamily: 'monospace' }}>{idx + 1}</td>
                        <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>{formatDate(row.date)}</td>
                        <td style={{ padding: '10px 14px', color: '#111827', fontWeight: 600 }}>
                          {(() => {
                            // v1.10.323 — GRN references open an HQ read-only
                            // modal (HQ owns all procurement, so the branch
                            // GRN page is empty). SIV refs still navigate to
                            // the tenant SIV page — those are branch-owned.
                            const t = refTarget(row.reference);
                            const isGrn = /^GRN-/i.test(String(row.reference || ''));
                            if (isGrn && row.reference_sync_id) {
                              return <button type="button"
                                onClick={() => openHqGrn(row.reference_sync_id)}
                                style={{ background: 'none', border: 'none', padding: 0, color: '#1d4ed8', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, fontSize: 'inherit', fontFamily: 'inherit' }}>
                                {row.reference}
                              </button>;
                            }
                            return t
                              ? <button type="button"
                                  onClick={() => navigate(`${t.path}?ref=${encodeURIComponent(t.ref)}`)}
                                  style={{ background: 'none', border: 'none', padding: 0, color: '#1d4ed8', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, fontSize: 'inherit', fontFamily: 'inherit' }}>
                                  {row.reference}
                                </button>
                              : (row.reference || '—');
                          })()}
                          {row.source_grn_number && (() => {
                            // Source GRN of an SIV is always the HQ GRN that
                            // originally delivered the goods → also HQ modal.
                            const g = refTarget(row.source_grn_number);
                            const isGrn = /^GRN-/i.test(String(row.source_grn_number));
                            if (isGrn) {
                              return <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#6b7280' }}>
                                (from <button type="button"
                                  onClick={() => openHqGrn(row.source_grn_sync_id || row.source_grn_number)}
                                  style={{ background: 'none', border: 'none', padding: 0, color: '#1d4ed8', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, fontSize: 'inherit', fontFamily: 'inherit', fontWeight: 500 }}>
                                  {row.source_grn_number}
                                </button>)
                              </span>;
                            }
                            return g
                              ? <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#6b7280' }}>
                                  (from <button type="button"
                                    onClick={() => navigate(`${g.path}?ref=${encodeURIComponent(g.ref)}`)}
                                    style={{ background: 'none', border: 'none', padding: 0, color: '#1d4ed8', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, fontSize: 'inherit', fontFamily: 'inherit', fontWeight: 500 }}>
                                    {row.source_grn_number}
                                  </button>)
                                </span>
                              : <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#6b7280' }}>(from {row.source_grn_number})</span>;
                          })()}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, ...ts }}>
                            {movementLabel(row.movement_type, row.quantity)}
                          </span>
                        </td>
                        {/* v1.10.315 — Supplier column: pulled from the linked
                            GRN's supplier_sync_id server-side. Only populated
                            for grn/siv rows; sales/damages/transfers show —. */}
                        <td style={{ padding: '10px 14px', color: row.supplier_name ? '#374151' : '#9ca3af', fontSize: 12 }}>
                          {row.supplier_name || '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#166534', fontWeight: 700, fontFamily: 'monospace' }}>{isIn ? toDisp(qty).toFixed(2) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626', fontWeight: 700, fontFamily: 'monospace' }}>{isOut ? toDisp(Math.abs(qty)).toFixed(2) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#111827', fontWeight: 800, fontFamily: 'monospace' }}>{(parseFloat(toDisp(parseFloat(row.balance)))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${ACCENT}`, background: ACCENT_LIGHT }}>
                    <td colSpan={5} style={{ padding: '11px 14px', fontWeight: 700, color: ACCENT, fontSize: 12, textTransform: 'uppercase' }}>Totals</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, color: '#166534', fontFamily: 'monospace' }}>{(parseFloat(totalIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, color: '#dc2626', fontFamily: 'monospace' }}>{(parseFloat(totalOut)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, color: '#111827', fontFamily: 'monospace' }}>{(parseFloat(closeBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Print Preview */}
      {showPrint && (
        <Portal>
        <div className="print-preview-overlay" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#0f172a', display: 'flex', flexDirection: 'column' }}>
          <div style={{ background: '#1e293b', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ color: '#94a3b8', fontSize: 13 }}>
              Sales Bin Card — <strong style={{ color: '#fff' }}>{selectedProduct?.name}</strong>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ padding: '8px 20px', borderRadius: 7, border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                <FiPrinter size={13} style={{ marginRight: 6 }} />Print
              </button>
              <button onClick={() => setShowPrint(false)} style={{ padding: '8px 18px', borderRadius: 7, border: '1px solid #475569', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
                Close
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '30px 20px' }}>
            <div id="print-document" style={{ width: 740, margin: '0 auto', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.4)' }}>
              <div style={{ background: `linear-gradient(135deg,${ACCENT_DARK},${ACCENT},#f87171)`, padding: '28px 32px', color: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, opacity: 0.75, marginBottom: 4 }}>Sales Document</div>
                    <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: -0.5 }}>SALES BIN CARD</div>
                    <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>{selectedProduct?.name} {unitLabel ? `· ${unitLabel}` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>{businessInfo.name || 'Business Name'}</div>
                    {businessInfo.address && <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>{businessInfo.address}</div>}
                    {businessInfo.phone  && <div style={{ fontSize: 11, opacity: 0.8 }}>Tel: {businessInfo.phone}</div>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 3, marginTop: 20 }}>
                  {['#fbbf24','#34d399','#60a5fa','#f472b6'].map((c, i) => (
                    <div key={i} style={{ height: 4, flex: 1, background: c, borderRadius: 2 }} />
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
                {[
                  { label: 'Period From',  value: formatDate(from) },
                  { label: 'Period To',    value: formatDate(to) },
                  { label: 'Opening Bal.', value: `${(parseFloat(openBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${unitLabel}` },
                  { label: 'Closing Bal.', value: `${(parseFloat(closeBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${unitLabel}` },
                ].map((item, i) => (
                  <div key={i} style={{ flex: 1, padding: '14px 16px', borderRight: i < 3 ? '1px solid #e5e7eb' : 'none' }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#9ca3af', marginBottom: 3 }}>{item.label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ padding: '20px 24px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: ACCENT, color: '#fff' }}>
                      {['#', 'Date', 'Reference', 'Type', 'Supplier', 'In', 'Out', 'Balance'].map((h, i) => (
                        <th key={i} style={{ padding: '9px 10px', textAlign: i >= 5 ? 'right' : 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ background: '#eff6ff', borderBottom: '1px solid #dbeafe' }}>
                      <td style={{ padding: '8px 10px', color: '#9ca3af' }}>—</td>
                      <td style={{ padding: '8px 10px', color: '#374151' }}>{formatDate(from)}</td>
                      <td style={{ padding: '8px 10px', color: '#6b7280' }}>—</td>
                      <td style={{ padding: '8px 10px', color: '#1d4ed8', fontWeight: 700 }}>Opening Balance</td>
                      <td style={{ padding: '8px 10px', color: '#9ca3af' }}>—</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: '#166534', fontWeight: 700 }}>{openBal > 0 ? openBal.toFixed(2) : ''}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>—</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800, color: '#1d4ed8' }}>{(parseFloat(openBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    </tr>
                    {rows.filter(row => {
                      if (rowFilter === 'in')  return parseFloat(row.quantity) > 0;
                      if (rowFilter === 'out') return parseFloat(row.quantity) < 0;
                      return true;
                    }).map((row, idx) => {
                      const qty = parseFloat(row.quantity);
                      const isIn  = qty > 0;
                      const isOut = qty < 0;
                      return (
                        <tr key={row.id} style={{ background: idx % 2 === 0 ? '#fff' : '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 10px', color: '#9ca3af' }}>{idx + 1}</td>
                          <td style={{ padding: '8px 10px', color: '#374151' }}>{formatDate(row.date)}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 600 }}>{row.reference || '—'}</td>
                          <td style={{ padding: '8px 10px', color: '#6b7280' }}>{movementLabel(row.movement_type, row.quantity)}</td>
                          <td style={{ padding: '8px 10px', color: row.supplier_name ? '#374151' : '#9ca3af' }}>{row.supplier_name || '—'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#166534', fontWeight: 700 }}>{isIn ? toDisp(qty).toFixed(2) : ''}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#dc2626', fontWeight: 700 }}>{isOut ? toDisp(Math.abs(qty)).toFixed(2) : ''}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800 }}>{(parseFloat(toDisp(parseFloat(row.balance)))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: ACCENT_LIGHT, borderTop: `2px solid ${ACCENT}` }}>
                      <td colSpan={5} style={{ padding: '9px 10px', fontWeight: 700, color: ACCENT, fontSize: 11, textTransform: 'uppercase' }}>Totals ({rowFilter === 'all' ? 'All' : rowFilter === 'in' ? 'IN only' : 'OUT only'})</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 800, color: '#166534' }}>{(parseFloat(totalIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 800, color: '#dc2626' }}>{(parseFloat(totalOut)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 800 }}>{(parseFloat(closeBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    </tr>
                  </tfoot>
                </table>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 40, paddingTop: 12 }}>
                  {['Prepared By', 'Checked By', 'Approved By'].map((label, i) => (
                    <div key={i} style={{ textAlign: 'center', width: 160 }}>
                      <div style={{ borderTop: '1px solid #374151', paddingTop: 8, fontSize: 11, color: '#6b7280' }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: ACCENT, padding: '10px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#fff', fontSize: 11, opacity: 0.8 }}>Printed: {new Date().toLocaleDateString('en-GB')}</span>
                <span style={{ color: '#fff', fontSize: 11, opacity: 0.8 }}>{businessInfo.name || ''}</span>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {(hqGrn || hqGrnLoading || hqGrnError) && (
        <Portal>
          <div onClick={closeHqGrn}
            style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 9999,
                     display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                     padding: '4vh 24px', overflowY: 'auto' }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ background: '#fff', borderRadius: 14, width: 'min(1080px, 96vw)',
                       boxShadow: '0 24px 60px rgba(0,0,0,0.28)', overflow: 'hidden',
                       fontFamily: 'inherit' }}>
              {/* Header — same red accent as the page */}
              <div style={{ background: `linear-gradient(135deg,${ACCENT_DARK},${ACCENT})`,
                            padding: '18px 26px', color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.15)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <FiFileText size={22} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', opacity: 0.85 }}>HQ Goods Received Note</div>
                    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2, fontFamily: 'monospace' }}>
                      {hqGrn?.grn?.grn_number || (hqGrnLoading ? 'Loading…' : '—')}
                    </div>
                  </div>
                </div>
                <button onClick={closeHqGrn}
                  style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
                           width: 36, height: 36, borderRadius: 10, cursor: 'pointer',
                           display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FiX size={18} />
                </button>
              </div>

              {/* Body */}
              <div style={{ padding: '22px 26px', background: '#f8fafc' }}>
                {hqGrnLoading && (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
                    Loading GRN…
                  </div>
                )}
                {hqGrnError && !hqGrnLoading && (
                  <div style={{ padding: 16, background: '#fee2e2', border: '1px solid #fecaca',
                                color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
                    {hqGrnError}
                  </div>
                )}
                {hqGrn?.grn && !hqGrnLoading && (
                  <>
                    {/* Meta grid: 4 cols on wide, 2 on narrow */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                                  gap: 12, marginBottom: 18 }}>
                      {[
                        { icon: <FiCalendar size={13} />, label: 'GRN Date',        value: formatDate(hqGrn.grn.date) },
                        { icon: <FiTruck size={13} />,    label: 'Branch',          value: hqGrn.grn.branch_name || hqGrn.grn.branch_slug || '—' },
                        { icon: <FiUser size={13} />,     label: 'Supplier',        value: hqGrn.grn.supplier_name || '—' },
                        { icon: <FiHash size={13} />,     label: 'Supplier Inv #',  value: hqGrn.grn.supplier_invoice_number || '—', mono: true },
                        { icon: <FiHash size={13} />,     label: 'PO Number',       value: hqGrn.purchase?.purchase_number || hqGrn.grn.po_number || '—', mono: true },
                        { icon: <FiCalendar size={13} />, label: 'PO Date',         value: hqGrn.purchase?.date ? formatDate(hqGrn.purchase.date) : '—' },
                        { icon: <FiUser size={13} />,     label: 'Initiated by (HQ)',    value: hqGrn.purchase?.created_by_name || '—', sub: hqGrn.purchase?.created_at ? new Date(hqGrn.purchase.created_at).toLocaleString('en-GB') : '' },
                        { icon: <FiUser size={13} />,     label: 'Generated by (HQ)',    value: hqGrn.grn.generated_by_hq_name || '—', sub: hqGrn.grn.generated_at ? new Date(hqGrn.grn.generated_at).toLocaleString('en-GB') : '' },
                        { icon: <FiUser size={13} />,     label: 'Confirmed by (Branch)', value: hqGrn.grn.confirmed_by_branch_name || '—', sub: hqGrn.grn.confirmed_at_branch ? new Date(hqGrn.grn.confirmed_at_branch).toLocaleString('en-GB') : '' },
                      ].map((f, i) => (
                        <div key={i} style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', padding: '10px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>
                            {f.icon}<span>{f.label}</span>
                          </div>
                          <div style={{ marginTop: 4, color: '#111827', fontSize: 14, fontWeight: 700,
                                        fontFamily: f.mono ? 'monospace' : 'inherit' }}>
                            {f.value}
                          </div>
                          {f.sub && (
                            <div style={{ marginTop: 2, color: '#9ca3af', fontSize: 11 }}>{f.sub}</div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Items table */}
                    <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                      <div style={{ padding: '10px 14px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
                                    fontSize: 11, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        Line Items ({hqGrn.items?.length || 0})
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: '#fef2f2', color: ACCENT }}>
                              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Product</th>
                              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Unit</th>
                              <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Qty</th>
                              <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Unit Price</th>
                              <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(hqGrn.items || []).map((it, i) => (
                              <tr key={it.id || i} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                                <td style={{ padding: '9px 14px', color: '#111827', fontWeight: 600 }}>
                                  {it.product_name}
                                  {it.is_extra ? <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 6, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>EXTRA</span> : null}
                                </td>
                                <td style={{ padding: '9px 14px', color: '#6b7280' }}>{it.unit || '—'}</td>
                                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#111827' }}>
                                  {(parseFloat(it.quantity) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>
                                  {(parseFloat(it.unit_price) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#111827', fontWeight: 700 }}>
                                  {(parseFloat(it.total_price) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr style={{ borderTop: `2px solid ${ACCENT}`, background: ACCENT_LIGHT }}>
                              <td colSpan={4} style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: ACCENT, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>Items Subtotal</td>
                              <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 800, color: ACCENT, fontFamily: 'monospace' }}>
                                {(parseFloat(hqGrn.grn.items_subtotal) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                            {(parseFloat(hqGrn.grn.cn_total) || 0) > 0 && (
                              <tr style={{ background: '#fefce8' }}>
                                <td colSpan={4} style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 700, color: '#92400e', fontSize: 12 }}>less: Credit Notes</td>
                                <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 700, color: '#92400e', fontFamily: 'monospace' }}>
                                  ({(parseFloat(hqGrn.grn.cn_total) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                                </td>
                              </tr>
                            )}
                            <tr style={{ background: '#111827', color: '#fff' }}>
                              <td colSpan={4} style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>Final Payable</td>
                              <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, fontFamily: 'monospace', fontSize: 14 }}>
                                {(parseFloat(hqGrn.grn.final_payable) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>

                    {hqGrn.grn.notes && (
                      <div style={{ marginTop: 14, padding: '12px 14px', background: '#fff',
                                    border: '1px solid #e5e7eb', borderRadius: 10 }}>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7280', fontWeight: 700, marginBottom: 4 }}>Notes</div>
                        <div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap' }}>{hqGrn.grn.notes}</div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Footer */}
              <div style={{ background: '#f9fafb', padding: '10px 26px', borderTop: '1px solid #e5e7eb',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>Read-only view · HQ archive</span>
                <button onClick={closeHqGrn}
                  style={{ background: ACCENT, color: '#fff', border: 'none', padding: '8px 18px',
                           borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      <style>{`
        @media print {
          body > * { display: none !important; }
          .print-preview-overlay { position: static !important; background: #fff !important; }
          .print-preview-overlay > div:first-child { display: none !important; }
          #print-document { box-shadow: none !important; border-radius: 0 !important; width: 100% !important; margin: 0 !important; }
        }
      `}</style>
    </div>
  );
};

export default SalesBinCard;
