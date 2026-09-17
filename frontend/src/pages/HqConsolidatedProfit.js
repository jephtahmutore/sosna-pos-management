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
import { FiRefreshCw, FiAlertTriangle } from 'react-icons/fi';
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

          {/* Per-branch stat blocks — each branch gets the same KPI cards +
              Breakdown layout as the group section above, in its own local
              currency. Same visual language as the per-branch Profit Report
              page, so the customer sees one style everywhere. */}
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
            Per-Branch Detail
          </div>
          {data.branches.map(b => <BranchProfitBlock key={b.slug} branch={b} />)}

          {/* HQ Overhead + Group Net Profit summary — kept as a compact
              two-row summary at the bottom in the reporting currency. */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 10, borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Branch Net Total</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: branchNetUsdTotal >= 0 ? '#047857' : '#b91c1c', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
                {fmtSign(branchNetUsdTotal)}{fmtUsd(Math.abs(branchNetUsdTotal))}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10, borderBottom: '1px solid #f3f4f6' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c' }}>
                  HQ Overhead <span style={{ fontWeight: 400, fontSize: 11, color: '#6b7280' }}>(PVs − LCVs)</span>
                </div>
                <div style={{ fontSize: 11, color: '#b91c1c', lineHeight: 1.7, marginTop: 2, fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
                  {parseFloat(data.hq_overhead?.total_usd_amount || 0) > 0 && (<div>−{fmtUsd(data.hq_overhead.total_usd_amount)} <span style={{ fontSize: 9, color: '#9ca3af' }}>USD</span></div>)}
                  {parseFloat(data.hq_overhead?.total_fra_amount || 0) > 0 && (<div>−{parseFloat(data.hq_overhead.total_fra_amount).toLocaleString(undefined,{maximumFractionDigits:0})} <span style={{ fontSize: 9, color: '#9ca3af' }}>FRA</span></div>)}
                  {parseFloat(data.hq_overhead?.total_k_amount || 0) > 0 && (<div>−{fmtK(data.hq_overhead.total_k_amount)}</div>)}
                  {(!parseFloat(data.hq_overhead?.total_usd_amount || 0) && !parseFloat(data.hq_overhead?.total_fra_amount || 0) && !parseFloat(data.hq_overhead?.total_k_amount || 0)) && <div style={{ color: '#9ca3af' }}>—</div>}
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#b91c1c', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
                −{fmtUsd(data.hq_overhead?.total_usd)}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, background: '#ecfdf5', margin: '10px -16px -16px', padding: '14px 16px', borderRadius: '0 0 12px 12px' }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#065f46' }}>Group Net Profit</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: groupNet >= 0 ? '#065f46' : '#b91c1c', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
                {fmtSign(groupNet)}{fmtUsd(Math.abs(groupNet))}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', lineHeight: 1.55 }}>
            Each branch shows its own P&amp;L in its local currency; the group figures at the top and Group Net Profit at the bottom are consolidated in USD using Kassumbalesa's daily K/USD rate.
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
// inline so we don't have to import the branch component. Currency-aware:
// pass `symbol` ($ for USD, K for Kwacha, etc.). K uses 0 decimals to
// match the branch layout; other symbols keep 2.
function KpiCard({ label, value, color, bg, border, symbol = '$' }) {
  const v = parseFloat(value || 0);
  const decimals = symbol === 'K' ? 0 : 2;
  return (
    <div style={{
      flex: '1 1 180px', minWidth: 180,
      background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color, marginTop: 4, fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
        {v < 0 ? '−' : ''}{symbol}{Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      </div>
    </div>
  );
}

// BranchProfitBlock — one full "mini Profit Report" for a single branch:
// three rows of KPI cards + a Breakdown table, all in the branch's own
// local currency. Same visual language as the top group block and the
// per-branch Profit Report page.
function BranchProfitBlock({ branch }) {
  const t = branch.totals;
  const symbol = branch.currency === 'USD' ? '$' : 'K';
  const decimals = symbol === 'K' ? 0 : 2;
  const fmt = (v) => `${symbol}${parseFloat(Math.abs(v || 0)).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  const netUsd = parseFloat(t.net_usd || 0);
  const stockVar = parseFloat(t.stock_variance || 0);
  const cashVar  = parseFloat(t.cash_variance  || 0);
  const gross    = parseFloat(t.gross || 0);
  const netLocal = parseFloat(t.net_local || 0);
  const tint   = branch.currency === 'USD' ? '#ecfdf5' : '#fef3c7';
  const tintFg = branch.currency === 'USD' ? '#065f46' : '#92400e';
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>{branch.name}</div>
          <span style={{ background: tint, color: tintFg, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4, letterSpacing: 0.4 }}>{branch.currency}</span>
        </div>
        <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
          Net (USD): <span style={{ color: netUsd >= 0 ? '#047857' : '#b91c1c', fontWeight: 700 }}>
            {netUsd < 0 ? '−' : ''}${Math.abs(netUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <KpiCard symbol={symbol} label="Revenue"          value={t.revenue}          color="#0369a1" bg="#f0f9ff" border="#38bdf8" />
        <KpiCard symbol={symbol} label="COGS"             value={t.cogs}             color="#d97706" bg="#fffbeb" border="#fbbf24" />
        <KpiCard symbol={symbol} label="Damaged"          value={t.damages}          color="#dc2626" bg="#fef2f2" border="#fca5a5" />
        <KpiCard symbol={symbol} label="Supplier Rebates" value={t.supplier_rebates} color="#16a34a" bg="#f0fdf4" border="#86efac" />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <KpiCard symbol={symbol} label="Stock Variance" value={stockVar}
                 color={stockVar < 0 ? '#dc2626' : '#16a34a'}
                 bg={stockVar < 0 ? '#fef2f2' : '#f0fdf4'}
                 border={stockVar < 0 ? '#fca5a5' : '#86efac'} />
        <KpiCard symbol={symbol} label="Cash Variance" value={cashVar}
                 color={cashVar < 0 ? '#dc2626' : '#16a34a'}
                 bg={cashVar < 0 ? '#fef2f2' : '#f0fdf4'}
                 border={cashVar < 0 ? '#fca5a5' : '#86efac'} />
        <KpiCard symbol={symbol} label="Expenses (PV)" value={t.pv} color="#dc2626" bg="#fef2f2" border="#fca5a5" />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <KpiCard symbol={symbol} label="Gross Profit" value={gross}
                 color={gross >= 0 ? '#16a34a' : '#dc2626'}
                 bg={gross >= 0 ? '#f0fdf4' : '#fef2f2'}
                 border={gross >= 0 ? '#86efac' : '#fca5a5'} />
        <KpiCard symbol={symbol} label="Net Profit" value={netLocal}
                 color={netLocal >= 0 ? '#7c3aed' : '#dc2626'}
                 bg={netLocal >= 0 ? '#f5f3ff' : '#fef2f2'}
                 border={netLocal >= 0 ? '#c4b5fd' : '#fca5a5'} />
      </div>

      {/* Per-branch breakdown */}
      <div style={{ backgroundColor: '#fafafa', borderRadius: 10, padding: 14, marginTop: 12, border: '1px solid #f3f4f6' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Breakdown</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {[
              { label: 'Revenue',                       value: t.revenue,          color: '#0369a1' },
              { label: '− COGS',                        value: t.cogs,             color: '#d97706' },
              { label: '− Damaged',                     value: t.damages,          color: '#dc2626' },
              { label: '+ Supplier Rebates',            value: t.supplier_rebates, color: '#16a34a' },
              { label: `${stockVar < 0 ? '−' : '+'} Stock Variance`, value: stockVar, color: stockVar < 0 ? '#dc2626' : '#16a34a' },
              { label: `${cashVar  < 0 ? '−' : '+'} Cash Variance`,  value: cashVar,  color: cashVar  < 0 ? '#dc2626' : '#16a34a' },
              { label: '= Gross Profit',                value: gross,              color: gross >= 0 ? '#16a34a' : '#dc2626', bold: true },
              { label: '− Expenses (PV)',               value: t.pv,               color: '#dc2626' },
              { label: '= Net Profit',                  value: netLocal,           color: netLocal >= 0 ? '#7c3aed' : '#dc2626', bold: true },
            ].map((row, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '6px 4px', fontWeight: row.bold ? 700 : 400, color: '#374151' }}>{row.label}</td>
                <td style={{ padding: '6px 4px', textAlign: 'right', fontWeight: row.bold ? 700 : 500, color: row.color, fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
                  {fmt(row.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const inp   = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 160 };
