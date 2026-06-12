import React, { useState, useEffect } from 'react';
import { getSalesRangeSummary, getSalesMonthlySummary } from '../services/api';
import { FiTrendingUp, FiTrendingDown, FiDollarSign, FiAlertTriangle } from 'react-icons/fi';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';

const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().split('T')[0];

const StatCard = ({ label, value, color, bg, border, icon, symbol }) => (
  <div style={{
    flex: 1, minWidth: 160, borderRadius: 12, padding: '14px 16px',
    backgroundColor: bg, borderLeft: `4px solid ${border}`,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ color, fontSize: 16 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
    </div>
    <div style={{ fontSize: 20, fontWeight: 800, color }}>{symbol}{value}</div>
  </div>
);

const ProfitReport = () => {
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const [from, setFrom] = useState(today());
  const [to, setTo]     = useState(today());
  const [range, setRange] = useState({});
  const [monthly, setMonthly] = useState({});
  const [loading, setLoading] = useState(true);

  const load = async (f, t) => {
    setLoading(true);
    try {
      const month = (t || f).slice(0, 7);
      const [rangeRes, monthRes] = await Promise.all([
        getSalesRangeSummary(f, t),
        getSalesMonthlySummary(month),
      ]);
      setRange(rangeRes.data || rangeRes || {});
      setMonthly(monthRes.data || monthRes || {});
    } catch (e) {
      console.log(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(from, to); }, [from, to]);

  const revenue       = parseFloat(range.revenue || 0);
  const cogs          = parseFloat(range.cogs || 0);
  // Damages (Sales Damages page) — recorded items destroyed/expired, valued at avg cost.
  const damages       = parseFloat(range.damages || 0);
  // Supplier Rebates — Credit Notes where reason is Discount or Other.
  // Crate/Bottle returns are deposit refunds, NOT income — excluded server-side.
  const supplierRebates = parseFloat(range.supplier_rebates || 0);
  // diff_value is now the Stock Variance from Stock Reconciliation (variance_base × cost_at_count).
  // The legacy `stock_adj` column is permanently 0 after the retirement, so we ignore it.
  const stockVariance = parseFloat(range.diff_value || 0);
  const cashVariance  = parseFloat(range.cash_difference || 0);
  const pvTotal       = parseFloat(range.pv_total || 0);
  const grossProfit   = parseFloat(range.gross_profit || 0);
  const netProfit     = parseFloat(range.net_profit || 0);

  // Label for the section header — single day if from == to, otherwise "from → to"
  const rangeLabel = from === to ? from : `${from}  →  ${to}`;

  const mRevenue    = parseFloat(monthly.total_revenue || 0);
  const mGross      = parseFloat(monthly.gross_profit || 0);
  const mNet        = parseFloat(monthly.net_profit || 0);
  const mDiff       = parseFloat(monthly.total_difference || 0);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('profitReport')}</h1>
          <p>{t('profitReportSubtitle')}</p>
        </div>
      </div>

      {/* Date range picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('from')}:</label>
        <input
          type="date"
          value={from}
          max={to || today()}
          onChange={e => setFrom(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        />
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('to')}:</label>
        <input
          type="date"
          value={to}
          min={from || undefined}
          max={today()}
          onChange={e => setTo(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        />
        {from !== to && (
          <button
            onClick={() => { const t = today(); setFrom(t); setTo(t); }}
            style={{ padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 12 }}
          >{t('todayOnly')}</button>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>{t('loading')}</div>
      ) : (
        <>
          {/* Range Section (Daily when from == to) */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
              {rangeLabel} — {from === to ? t('daily') : t('rangeTotal')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              <StatCard symbol={curSym} label={t('revenue')} value={fmt(revenue)} color="#0369a1" bg="#f0f9ff" border="#38bdf8" icon={<FiDollarSign />} />
              <StatCard symbol={curSym} label={t('cogs')} value={fmt(cogs)} color="#d97706" bg="#fffbeb" border="#fbbf24" icon={<FiTrendingDown />} />
              <StatCard symbol={curSym} label={t('damaged')} value={fmt(damages)} color="#dc2626" bg="#fef2f2" border="#fca5a5" icon={<FiTrendingDown />} />
              <StatCard symbol={curSym} label={t('supplierRebates')} value={fmt(supplierRebates)} color="#16a34a" bg="#f0fdf4" border="#86efac" icon={<FiTrendingUp />} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              <StatCard symbol={curSym} label={t('stockVariance')} value={fmt(stockVariance)} color={stockVariance < 0 ? '#dc2626' : '#16a34a'} bg={stockVariance < 0 ? '#fef2f2' : '#f0fdf4'} border={stockVariance < 0 ? '#fca5a5' : '#86efac'} icon={<FiAlertTriangle />} />
              <StatCard symbol={curSym} label={t('cashVariance')} value={fmt(cashVariance)} color={cashVariance < 0 ? '#dc2626' : '#16a34a'} bg={cashVariance < 0 ? '#fef2f2' : '#f0fdf4'} border={cashVariance < 0 ? '#fca5a5' : '#86efac'} icon={<FiDollarSign />} />
              <StatCard symbol={curSym} label={t('expensesPV')} value={fmt(pvTotal)} color="#dc2626" bg="#fef2f2" border="#fca5a5" icon={<FiTrendingDown />} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <StatCard symbol={curSym} label={t('grossProfit')} value={fmt(grossProfit)} color={grossProfit >= 0 ? '#16a34a' : '#dc2626'} bg={grossProfit >= 0 ? '#f0fdf4' : '#fef2f2'} border={grossProfit >= 0 ? '#86efac' : '#fca5a5'} icon={<FiTrendingUp />} />
              <StatCard symbol={curSym} label={t('netProfit')} value={fmt(netProfit)} color={netProfit >= 0 ? '#7c3aed' : '#dc2626'} bg={netProfit >= 0 ? '#f5f3ff' : '#fef2f2'} border={netProfit >= 0 ? '#c4b5fd' : '#fca5a5'} icon={<FiTrendingUp />} />
            </div>
          </div>

          {/* Breakdown Table */}
          <div style={{ backgroundColor: '#fff', borderRadius: 10, padding: 16, marginTop: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>{t('breakdown')}</div>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {[
                  { label: t('revenue'), value: revenue, color: '#0369a1' },
                  { label: `− ${t('cogs')}`, value: -cogs, color: '#d97706' },
                  { label: `− ${t('damaged')}`, value: -damages, color: '#dc2626' },
                  { label: `+ ${t('supplierRebates')}`, value: supplierRebates, color: '#16a34a' },
                  { label: `${stockVariance < 0 ? '−' : '+'} ${t('stockVariance')}`, value: Math.abs(stockVariance), color: stockVariance < 0 ? '#dc2626' : '#16a34a' },
                  { label: `${cashVariance  < 0 ? '−' : '+'} ${t('cashVariance')}`,  value: Math.abs(cashVariance),  color: cashVariance  < 0 ? '#dc2626' : '#16a34a' },
                  { label: `= ${t('grossProfit')}`, value: grossProfit, color: grossProfit >= 0 ? '#16a34a' : '#dc2626', bold: true },
                  { label: `− ${t('expensesPV')}`, value: pvTotal, color: '#dc2626' },
                  { label: `= ${t('netProfit')}`, value: netProfit, color: netProfit >= 0 ? '#7c3aed' : '#dc2626', bold: true },
                ].map((row, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 4px', fontWeight: row.bold ? 700 : 400, color: '#374151' }}>{row.label}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: row.bold ? 700 : 500, color: row.color }}>
                      {curSym}{fmt(Math.abs(row.value))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Monthly Section */}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
              {(to || from).slice(0, 7)} — {t('monthToDate')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <StatCard symbol={curSym} label={t('monthlyRevenue')} value={fmt(mRevenue)} color="#0369a1" bg="#f0f9ff" border="#38bdf8" icon={<FiDollarSign />} />
              <StatCard symbol={curSym} label={t('monthlyGrossProfit')} value={fmt(mGross)} color={mGross >= 0 ? '#16a34a' : '#dc2626'} bg={mGross >= 0 ? '#f0fdf4' : '#fef2f2'} border={mGross >= 0 ? '#86efac' : '#fca5a5'} icon={<FiTrendingUp />} />
              <StatCard symbol={curSym} label={t('monthlyNetProfit')} value={fmt(mNet)} color={mNet >= 0 ? '#7c3aed' : '#dc2626'} bg={mNet >= 0 ? '#f5f3ff' : '#fef2f2'} border={mNet >= 0 ? '#c4b5fd' : '#fca5a5'} icon={<FiTrendingUp />} />
              <StatCard symbol={curSym} label={t('monthlyDifference')} value={fmt(mDiff)} color={mDiff < 0 ? '#dc2626' : '#16a34a'} bg={mDiff < 0 ? '#fef2f2' : '#f0fdf4'} border={mDiff < 0 ? '#fca5a5' : '#86efac'} icon={<FiAlertTriangle />} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ProfitReport;
