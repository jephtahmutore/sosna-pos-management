// HqConsolidatedProfit — group net profit rolled up across every branch,
// converted to a single USD figure per-day using Kassumbalesa's daily
// selling_rate_k_used. HQ overhead (payment_vouchers minus LCVs) is
// subtracted to arrive at Group Net.
//
// Only useful on the bare HQ host (sosnazm.com). The sidebar entry lives
// under the Accounting group next to the per-branch Profit Report.
//
// v1.10.233 — new page.
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiChevronRight, FiChevronDown, FiAlertTriangle } from 'react-icons/fi';
import { getHqConsolidatedProfit } from '../services/api';

const fmtUsd  = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtK    = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fmtSign = (n) => (parseFloat(n || 0) < 0 ? '−' : '');
const firstOfMonthISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HqConsolidatedProfit() {
  const [from, setFrom] = useState(firstOfMonthISO());
  const [to,   setTo]   = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [expanded, setExpanded] = useState({}); // slug → bool

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await getHqConsolidatedProfit({ from, to });
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load consolidated profit');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const branchNetUsdTotal = useMemo(() => {
    if (!data?.branches) return 0;
    return data.branches.reduce((s, b) => s + parseFloat(b.totals.net_usd || 0), 0);
  }, [data]);

  const toggle = (slug) => setExpanded(e => ({ ...e, [slug]: !e[slug] }));

  const localFmt = (n, ccy) => ccy === 'USD' ? fmtUsd(n) : fmtK(n);
  const groupNet = parseFloat(data?.group_net_usd || 0);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Consolidated Profit</h1>
          <p>Group net profit across every branch, in USD · HQ overhead = PVs excluding LCVs</p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <Field label="From">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </Field>
        <div style={{ flex: 1 }} />
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: '9px 16px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <FiRefreshCw /> {loading ? 'Loading…' : 'Run'}
        </button>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {data?.warnings?.length > 0 && (
        <div style={{ padding: 12, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <FiAlertTriangle style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontSize: 13 }}>
            {data.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Headline tile — sky-blue to match HQ chrome */}
          <div style={{ background: 'linear-gradient(135deg,#075985,#0369a1)', color: '#fff', borderRadius: 12, padding: '22px 24px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.8, fontWeight: 700 }}>Group Net Profit</div>
              <div style={{ fontSize: 30, fontWeight: 800, marginTop: 2 }}>{fmtSign(groupNet)}{fmtUsd(Math.abs(groupNet))}</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                Branch Net {fmtUsd(branchNetUsdTotal)} − HQ Overhead {fmtUsd(data.hq_overhead?.total_usd)}
              </div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 11, opacity: 0.85 }}>
              <div>{data.from} → {data.to}</div>
              <div style={{ marginTop: 4 }}>Reporting currency: {data.reporting_currency}</div>
              {data.fx_source && <div style={{ marginTop: 2, maxWidth: 320 }}>FX: {data.fx_source}</div>}
            </div>
          </div>

          {/* Group KPI cards + Breakdown — mirrors the per-branch Profit
              Report layout so the consolidated page speaks the same visual
              language. All figures in USD (reporting currency). */}
          {data.group_totals_usd && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
                {data.from} → {data.to} — Group Total (USD)
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
                <KpiCard label="Revenue"          value={data.group_totals_usd.revenue}          color="#0369a1" bg="#f0f9ff" border="#38bdf8" />
                <KpiCard label="COGS"             value={data.group_totals_usd.cogs}             color="#d97706" bg="#fffbeb" border="#fbbf24" />
                <KpiCard label="Damaged"          value={data.group_totals_usd.damages}          color="#dc2626" bg="#fef2f2" border="#fca5a5" />
                <KpiCard label="Supplier Rebates" value={data.group_totals_usd.supplier_rebates} color="#16a34a" bg="#f0fdf4" border="#86efac" />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
                <KpiCard label="Stock Variance" value={data.group_totals_usd.stock_variance}
                         color={data.group_totals_usd.stock_variance < 0 ? '#dc2626' : '#16a34a'}
                         bg={data.group_totals_usd.stock_variance < 0 ? '#fef2f2' : '#f0fdf4'}
                         border={data.group_totals_usd.stock_variance < 0 ? '#fca5a5' : '#86efac'} />
                <KpiCard label="Cash Variance" value={data.group_totals_usd.cash_variance}
                         color={data.group_totals_usd.cash_variance < 0 ? '#dc2626' : '#16a34a'}
                         bg={data.group_totals_usd.cash_variance < 0 ? '#fef2f2' : '#f0fdf4'}
                         border={data.group_totals_usd.cash_variance < 0 ? '#fca5a5' : '#86efac'} />
                <KpiCard label="Expenses (PV + HQ)" value={data.group_totals_usd.pv} color="#dc2626" bg="#fef2f2" border="#fca5a5" />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <KpiCard label="Gross Profit" value={data.group_totals_usd.gross}
                         color={data.group_totals_usd.gross >= 0 ? '#16a34a' : '#dc2626'}
                         bg={data.group_totals_usd.gross >= 0 ? '#f0fdf4' : '#fef2f2'}
                         border={data.group_totals_usd.gross >= 0 ? '#86efac' : '#fca5a5'} />
                <KpiCard label="Net Profit" value={data.group_totals_usd.net}
                         color={data.group_totals_usd.net >= 0 ? '#7c3aed' : '#dc2626'}
                         bg={data.group_totals_usd.net >= 0 ? '#f5f3ff' : '#fef2f2'}
                         border={data.group_totals_usd.net >= 0 ? '#c4b5fd' : '#fca5a5'} />
              </div>

              {/* Breakdown — line-by-line arithmetic like the branch page */}
              <div style={{ backgroundColor: '#fff', borderRadius: 10, padding: 16, marginTop: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Breakdown</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {(() => {
                      const g = data.group_totals_usd;
                      const rows = [
                        { label: 'Revenue',                           value: g.revenue,          color: '#0369a1' },
                        { label: '− COGS',                            value: g.cogs,             color: '#d97706' },
                        { label: '− Damaged',                         value: g.damages,          color: '#dc2626' },
                        { label: '+ Supplier Rebates',                value: g.supplier_rebates, color: '#16a34a' },
                        { label: `${g.stock_variance < 0 ? '−' : '+'} Stock Variance`, value: Math.abs(g.stock_variance), color: g.stock_variance < 0 ? '#dc2626' : '#16a34a' },
                        { label: `${g.cash_variance  < 0 ? '−' : '+'} Cash Variance`,  value: Math.abs(g.cash_variance),  color: g.cash_variance  < 0 ? '#dc2626' : '#16a34a' },
                        { label: '= Gross Profit',                    value: g.gross,            color: g.gross >= 0 ? '#16a34a' : '#dc2626', bold: true },
                        { label: '− Expenses (PV + HQ Overhead)',     value: g.pv,               color: '#dc2626' },
                        { label: '= Net Profit',                      value: g.net,              color: g.net >= 0 ? '#7c3aed' : '#dc2626', bold: true },
                      ];
                      return rows.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 4px', fontWeight: row.bold ? 700 : 400, color: '#374151' }}>{row.label}</td>
                          <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: row.bold ? 700 : 500, color: row.color }}>
                            ${parseFloat(Math.abs(row.value || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Main table */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f9fafb' }}>
                <tr>
                  <th style={{ ...th, width: 32 }} />
                  <th style={th}>Branch</th>
                  <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
                  <th style={{ ...th, textAlign: 'right' }}>COGS</th>
                  <th style={{ ...th, textAlign: 'right' }}>Gross Profit</th>
                  <th style={{ ...th, textAlign: 'right' }} title="− Damaged + Stock Variance + Cash Variance">Variance</th>
                  <th style={{ ...th, textAlign: 'right' }}>Expenses (PV)</th>
                  <th style={{ ...th, textAlign: 'right' }}>Net (local)</th>
                  <th style={{ ...th, textAlign: 'right' }}>Net (USD)</th>
                </tr>
              </thead>
              <tbody>
                {data.branches.map(b => {
                  const isOpen = !!expanded[b.slug];
                  const tint = b.currency === 'USD' ? '#ecfdf5' : '#fef3c7';
                  const tintFg = b.currency === 'USD' ? '#065f46' : '#92400e';
                  return (
                    <React.Fragment key={b.slug}>
                      <tr
                        style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                        onClick={() => toggle(b.slug)}
                      >
                        <td style={{ ...td, textAlign: 'center', color: '#0ea5e9' }}>
                          {isOpen ? <FiChevronDown /> : <FiChevronRight />}
                        </td>
                        <td style={{ ...td, fontWeight: 700 }}>
                          {b.name}
                          <span style={{ marginLeft: 8, background: tint, color: tintFg, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, letterSpacing: 0.4 }}>{b.currency}</span>
                        </td>
                        <td style={numTd}>{localFmt(b.totals.revenue, b.currency)}</td>
                        <td style={numTd}>{localFmt(b.totals.cogs, b.currency)}</td>
                        <td style={{ ...numTd, color: parseFloat(b.totals.gross) >= 0 ? '#047857' : '#b91c1c' }}>{localFmt(b.totals.gross, b.currency)}</td>
                        <td style={{ ...numTd, color: parseFloat(b.totals.variance) >= 0 ? '#047857' : '#b91c1c' }}>{localFmt(b.totals.variance, b.currency)}</td>
                        <td style={{ ...numTd, color: '#b45309' }}>{localFmt(b.totals.pv, b.currency)}</td>
                        <td style={{ ...numTd, fontWeight: 700 }}>{localFmt(b.totals.net_local, b.currency)}</td>
                        <td style={{ ...numTd, fontWeight: 700, color: b.totals.net_usd >= 0 ? '#047857' : '#b91c1c' }}>{fmtSign(b.totals.net_usd)}{fmtUsd(Math.abs(b.totals.net_usd))}</td>
                      </tr>
                      {isOpen && b.daily
                        .filter(d => (d.revenue || d.cogs || d.gross || d.variance || d.pv || d.net_local))
                        .map(d => (
                        <tr key={`${b.slug}-${d.date}`} style={{ background: '#fafafa', borderBottom: '1px solid #f3f4f6' }}>
                          <td />
                          <td style={{ ...td, paddingLeft: 32, color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>{d.date}</td>
                          <td style={{ ...numTd, color: '#6b7280' }}>{localFmt(d.revenue, b.currency)}</td>
                          <td style={{ ...numTd, color: '#6b7280' }}>{localFmt(d.cogs, b.currency)}</td>
                          <td style={{ ...numTd, color: parseFloat(d.gross) >= 0 ? '#047857' : '#b91c1c' }}>{localFmt(d.gross, b.currency)}</td>
                          <td style={{ ...numTd, color: parseFloat(d.variance) >= 0 ? '#047857' : '#b91c1c' }}>{localFmt(d.variance, b.currency)}</td>
                          <td style={{ ...numTd, color: '#b45309' }}>{localFmt(d.pv, b.currency)}</td>
                          <td style={{ ...numTd, color: '#374151' }}>{localFmt(d.net_local, b.currency)}</td>
                          <td style={{ ...numTd, color: '#374151' }}>
                            {fmtSign(d.net_usd)}{fmtUsd(Math.abs(d.net_usd))}
                            {b.currency !== 'USD' && d.fx_rate && (
                              <span style={{ marginLeft: 6, fontSize: 10, color: '#9ca3af', fontFamily: 'monospace' }}>
                                @ K{parseFloat(d.fx_rate).toFixed(2)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
                {/* Sub-totals row */}
                <tr style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                  <td />
                  <td style={{ ...td, fontWeight: 700, color: '#0f172a' }}>Branch Net Total</td>
                  <td colSpan={6} />
                  <td style={{ ...numTd, fontWeight: 800, color: '#047857' }}>{fmtSign(branchNetUsdTotal)}{fmtUsd(Math.abs(branchNetUsdTotal))}</td>
                </tr>
                {/* HQ overhead row — mixed currency, expand to see split */}
                <tr style={{ borderTop: '1px solid #e5e7eb' }}>
                  <td />
                  <td style={{ ...td, color: '#b91c1c', fontWeight: 700 }}>
                    HQ Overhead <span style={{ fontWeight: 400, fontSize: 11, color: '#6b7280' }}>(PVs − LCVs)</span>
                  </td>
                  <td colSpan={5} />
                  <td style={{ ...numTd, color: '#b91c1c', fontSize: 11.5, lineHeight: 1.7 }}>
                    {parseFloat(data.hq_overhead?.total_usd_amount || 0) > 0 && (<div>−{fmtUsd(data.hq_overhead.total_usd_amount)} <span style={{ fontSize: 9, color: '#9ca3af' }}>USD</span></div>)}
                    {parseFloat(data.hq_overhead?.total_fra_amount || 0) > 0 && (<div>−{parseFloat(data.hq_overhead.total_fra_amount).toLocaleString(undefined,{maximumFractionDigits:0})} <span style={{ fontSize: 9, color: '#9ca3af' }}>FRA</span></div>)}
                    {parseFloat(data.hq_overhead?.total_k_amount || 0) > 0 && (<div>−{fmtK(data.hq_overhead.total_k_amount)}</div>)}
                    {(!parseFloat(data.hq_overhead?.total_usd_amount || 0) && !parseFloat(data.hq_overhead?.total_fra_amount || 0) && !parseFloat(data.hq_overhead?.total_k_amount || 0)) && <div style={{ color: '#9ca3af' }}>—</div>}
                  </td>
                  <td style={{ ...numTd, color: '#b91c1c', fontWeight: 700 }}>−{fmtUsd(data.hq_overhead?.total_usd)}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr style={{ background: '#ecfdf5', borderTop: '2px solid #059669' }}>
                  <td />
                  <td style={{ ...td, fontWeight: 800, fontSize: 15, color: '#065f46' }}>Group Net Profit</td>
                  <td colSpan={6} />
                  <td style={{ ...numTd, fontWeight: 800, fontSize: 16, color: groupNet >= 0 ? '#065f46' : '#b91c1c' }}>
                    {fmtSign(groupNet)}{fmtUsd(Math.abs(groupNet))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', lineHeight: 1.55 }}>
            Click a branch row to expand daily rows. Daily net (USD) shows the FX rate applied for that day next to the figure. Days with no activity are hidden inside the drilldown.
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

// KpiCard — visual twin of the branch Profit Report's StatCard, styled
// inline so we don't have to import the branch component. Always $USD.
function KpiCard({ label, value, color, bg, border }) {
  const v = parseFloat(value || 0);
  return (
    <div style={{
      flex: '1 1 180px', minWidth: 180,
      background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color, marginTop: 4, fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
        {v < 0 ? '−' : ''}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
    </div>
  );
}

const inp   = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 160 };
const th    = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td    = { padding: '10px 12px', color: '#0f172a' };
const numTd = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace', fontSize: 12.5 };
