// HqInventoryReport — cross-branch stock list. One row per product per
// branch, sorted by stock value. Filters: branch, low-stock only, search.
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiAlertTriangle, FiSearch, FiPackage } from 'react-icons/fi';
import { getHqInventoryReport, getHqBranches, setHqBranch } from '../services/api';

// v1.10.149 — currency is per-branch. Prefix with $ only when USD, otherwise
// suffix with the currency code (e.g. "K 1,430.95"). Cost/Value/Stock Value
// columns render the branch's own currency instead of a hard-coded $.
const fmtMoney = (n, ccy = 'USD') => {
  const amt = parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ccy === 'USD' ? `$${amt}` : `${ccy} ${amt}`;
};
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// v1.10.149 — convert a raw base-unit stock count into the largest unit
// present in units_json + remainder. Returns null when units_json is
// missing/single-unit so the caller falls back to the plain "N unit" render.
//   units_json = [{"unit":"Bottle","conversion":1},{"unit":"Box","conversion":24}]
//   stock = 14046  → { primary: {qty:585, unit:'Box'}, remainder: {qty:6, unit:'Bottle'} }
function convertToLargestUnit(stock, unitsJson, baseUnit) {
  if (!unitsJson) return null;
  let units;
  try { units = typeof unitsJson === 'string' ? JSON.parse(unitsJson) : unitsJson; }
  catch (_) { return null; }
  if (!Array.isArray(units) || units.length < 2) return null;
  // Largest = highest conversion factor > 1.
  const largest = units
    .filter(u => parseFloat(u.conversion) > 1)
    .sort((a, b) => parseFloat(b.conversion) - parseFloat(a.conversion))[0];
  if (!largest) return null;
  const conv = parseFloat(largest.conversion) || 1;
  const primaryQty  = Math.floor(stock / conv);
  const remainderQty = stock - (primaryQty * conv);
  if (primaryQty === 0) return null; // less than one Box — plain base render
  return {
    primary:    { qty: primaryQty,   unit: largest.unit },
    remainder:  { qty: remainderQty, unit: baseUnit || 'Bottle' },
  };
}

export default function HqInventoryReport() {
  const [branch, setBranch]     = useState('all');
  const [branches, setBranches] = useState([]);
  const [lowOnly, setLowOnly]   = useState(false);
  const [qInput, setQInput]     = useState('');
  const [q, setQ]               = useState('');
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await getHqInventoryReport({
        branch,
        low_only: lowOnly ? '1' : '',
        q: q || undefined,
      });
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load report');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const perBranch = useMemo(() => {
    if (!data?.by_branch) return [];
    return Object.entries(data.by_branch)
      .map(([slug, v]) => ({ slug, ...v }))
      .sort((a, b) => b.stock_value - a.stock_value);
  }, [data]);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Inventory Report</h1>
          <p>Live stock across every branch</p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <Field label="Branch">
          <select value={branch} onChange={e => setBranch(e.target.value)} style={inp}>
            <option value="all">All branches</option>
            {branches.map(b => <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>)}
          </select>
        </Field>
        <Field label="Search product">
          <div style={{ position: 'relative' }}>
            <FiSearch size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input type="text" value={qInput}
              onChange={e => setQInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setQ(qInput.trim()); }}}
              onBlur={() => setQ(qInput.trim())}
              placeholder="Name contains…" style={{ ...inp, paddingLeft: 28, minWidth: 220 }} />
          </div>
        </Field>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#475569', cursor: 'pointer', paddingBottom: 8 }}>
          <input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} />
          Low stock only
        </label>
        <div style={{ flex: 1 }} />
        <button onClick={load} disabled={loading}
          style={{ padding: '9px 16px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> {loading ? 'Loading…' : 'Run'}
        </button>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Rollup + per-branch */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14, marginBottom: 16 }}>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
              <h3 style={hd}>Totals</h3>
              <Stat label="Product rows"     value={fmtInt(data.rollup.products)} />
              {/* v1.10.149 — per-currency stock value cards. Never sum K + USD
                  into a single number. Legacy `stock_value` (mixed sum) is
                  ignored in favour of the per-currency breakdown. */}
              {(() => {
                const byCcy = data.rollup.stock_value_by_currency || {};
                const entries = Object.entries(byCcy).filter(([, v]) => v > 0);
                if (entries.length === 0) {
                  return <Stat label="Total Stock Value" value="—" big />;
                }
                return entries.map(([ccy, val]) => (
                  <Stat key={ccy} label={`Total Stock Value (${ccy})`} value={fmtMoney(val, ccy)} big />
                ));
              })()}
              <Stat label="Low Stock Lines"   value={fmtInt(data.rollup.low)} warn={data.rollup.low > 0} />
              {data.truncated && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#92400e', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <FiAlertTriangle /> Showing first {fmtInt(data.returned_rows)} of {fmtInt(data.total_rows)} rows — narrow with search or branch filter
                </div>
              )}
            </div>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
              <h3 style={hd}>By Branch</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr>
                  <th style={thS}>Branch</th>
                  <th style={{ ...thS, textAlign: 'right' }}>Products</th>
                  <th style={{ ...thS, textAlign: 'right' }}>Low</th>
                  <th style={{ ...thS, textAlign: 'right' }}>Stock Value</th>
                  <th style={thS}></th>
                </tr></thead>
                <tbody>
                  {perBranch.map(b => (
                    <tr key={b.slug} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={tdS}>{b.name} <span style={{ color: '#94a3b8', fontSize: 11 }}>({b.slug})</span></td>
                      <td style={{ ...tdS, textAlign: 'right' }}>{fmtInt(b.products)}</td>
                      <td style={{ ...tdS, textAlign: 'right', color: b.low > 0 ? '#b91c1c' : '#475569', fontWeight: b.low > 0 ? 700 : 400 }}>{fmtInt(b.low)}</td>
                      <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(b.stock_value, b.currency || 'USD')}</td>
                      <td style={tdS}>
                        <button onClick={() => { setHqBranch(b.slug); window.location.href = '/stock/items'; }}
                          style={{ padding: '4px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Flat row list */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
            <h3 style={hd}>Stock Lines ({fmtInt(data.returned_rows)})</h3>
            {data.rows.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}><FiPackage /> No products match the filters.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ background: '#f8fafc' }}>
                    <tr>
                      <th style={th}>Product</th>
                      <th style={th}>Branch</th>
                      <th style={th}>Category</th>
                      <th style={{ ...th, textAlign: 'right' }}>On Hand</th>
                      <th style={{ ...th, textAlign: 'right' }}>Min</th>
                      <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                      <th style={{ ...th, textAlign: 'right' }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => {
                      // v1.10.149 — convert base-unit stock to Box + remainder
                      // when the product has a multi-unit definition. Falls
                      // back to plain "N Bottle" when there's no larger unit.
                      const conv = convertToLargestUnit(r.current_stock, r.units_json, r.unit);
                      const ccy = r.currency || 'USD';
                      return (
                      <tr key={`${r.branch_slug}-${r.product_id}-${i}`}
                        style={{ borderTop: '1px solid #f1f5f9', background: r.low ? '#fffbeb' : '#fff' }}>
                        <td style={td}>
                          {r.name}
                          {r.low && <span style={{ ...tag('#fef3c7', '#92400e'), marginLeft: 6 }}>LOW</span>}
                        </td>
                        <td style={td}><span style={tag('#e2e8f0', '#0f172a')}>{r.branch_slug}</span></td>
                        <td style={{ ...td, color: '#64748b' }}>{r.category}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}
                            title={`${fmtQty(r.current_stock)} ${r.unit}`}>
                          {conv ? (
                            <>
                              {fmtInt(conv.primary.qty)} <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>{conv.primary.unit}</span>
                              {conv.remainder.qty > 0 && (
                                <>
                                  {' + '}
                                  {fmtInt(conv.remainder.qty)} <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>{conv.remainder.unit}</span>
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              {fmtQty(r.current_stock)} <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>{r.unit}</span>
                            </>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>{fmtQty(r.min_stock)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(r.cost_price, ccy)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(r.value, ccy)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
function Stat({ label, value, big, warn }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: big ? 22 : 15, fontWeight: 800, color: warn ? '#b91c1c' : '#0f172a' }}>{value}</div>
    </div>
  );
}

const inp = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 160 };
const hd  = { margin: '0 0 10px 0', fontSize: 14, color: '#0f172a' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left' };
const tdS = { padding: '6px 8px', color: '#0f172a' };
const tag = (bg, fg) => ({ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 });
