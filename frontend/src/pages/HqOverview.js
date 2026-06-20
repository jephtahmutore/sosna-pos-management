// HqOverview — head-office single-page summary across every registered
// branch. Only useful when served from the bare HQ host (sosnazm.com);
// on a per-branch subdomain the sidebar hides this entry. The page reads
// from /api/hq/overview, which loops over each tenant DB and aggregates.
//
// Each card jumps the user into the matching branch — clicking "Open"
// sets the HQ branch + reloads so the rest of the app operates on that
// branch's DB. No re-auth here (that's only enforced when the user
// actively switches via the sidebar's Active Branch dropdown).
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FiRefreshCw, FiTrendingUp, FiClock, FiTruck, FiDollarSign, FiPackage,
  FiAlertTriangle, FiArrowRight,
} from 'react-icons/fi';
import { getHqOverview, setHqBranch } from '../services/api';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();

export default function HqOverview() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const res = await getHqOverview();
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load overview');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const openBranch = (slug) => {
    setHqBranch(slug);
    // Hard reload so every page re-fetches its data via the new X-Branch.
    window.location.href = '/dashboard';
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Overview</h1>
          <p>Live snapshot across all branches</p>
        </div>
        <button onClick={load}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <p style={{ color: '#64748b' }}>Loading overview…</p>
      ) : data && (
        <>
          {/* Roll-up row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 22 }}>
            <RollupCard icon={<FiTrendingUp />} label="Today's Revenue" value={fmtMoney(data.rollup.today_revenue)} sub={`${fmtInt(data.rollup.today_orders)} orders`} color="#0ea5e9" />
            <RollupCard icon={<FiTrendingUp />} label="Month-to-Date"     value={fmtMoney(data.rollup.mtd_revenue)}   sub={`${fmtInt(data.rollup.mtd_orders)} orders`}   color="#6366f1" />
            <RollupCard icon={<FiClock />}      label="Awaiting Payment"  value={fmtInt(data.rollup.pending_payment)} sub="3-station Sales → Cashier" color="#f59e0b" />
            <RollupCard icon={<FiTruck />}      label="Awaiting Dispatch" value={fmtInt(data.rollup.awaiting_dispatch)} sub="Cashier → Dispatch"     color="#16a34a" />
            <RollupCard icon={<FiPackage />}    label="Stock Value"       value={fmtMoney(data.rollup.stock_value)}   sub="At cost, all branches"  color="#0f766e" />
            <RollupCard icon={<FiDollarSign />} label="AR Outstanding"    value={fmtMoney(data.rollup.ar_outstanding)} sub="Unpaid by customers"   color="#dc2626" />
          </div>

          {/* Per-branch cards */}
          <h3 style={{ margin: '0 0 10px 0', fontSize: 15, color: '#0f172a' }}>Branches</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            {(data.branches || []).map(b => (
              <div key={b.slug} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <h4 style={{ margin: '0 0 2px 0', fontSize: 16, color: '#0f172a' }}>{b.name}</h4>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span style={tagStyle('#e2e8f0', '#0f172a')}>{b.slug}</span>
                      {b.currency_mode === 'USD+FRA' && <span style={tagStyle('#fef3c7', '#92400e')}>Dual currency</span>}
                      {b.workflow_mode === 'three_station' && <span style={tagStyle('#dbeafe', '#1e40af')}>3-station</span>}
                    </div>
                  </div>
                  <button onClick={() => openBranch(b.slug)}
                    style={{ padding: '6px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
                    Open <FiArrowRight size={12} />
                  </button>
                </div>

                {b.error ? (
                  <div style={{ padding: 10, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12 }}>
                    <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 4 }} /> {b.error}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <Metric label="Today" value={fmtMoney(b.today.revenue)} sub={`${b.today.orders} orders`} />
                    <Metric label="MTD"   value={fmtMoney(b.mtd.revenue)}   sub={`${b.mtd.orders} orders`} />
                    {b.workflow_mode === 'three_station' && (
                      <>
                        <Metric label="Awaiting Payment"  value={fmtInt(b.pending_payment)}   warn={b.pending_payment > 0} />
                        <Metric label="Awaiting Dispatch" value={fmtInt(b.awaiting_dispatch)} warn={b.awaiting_dispatch > 0} />
                      </>
                    )}
                    <Metric label="Stock Value" value={fmtMoney(b.stock_value)} />
                    <Metric label="Low Stock"   value={fmtInt(b.stock_low_count)} warn={b.stock_low_count > 0} />
                    <Metric label="AR Open"     value={fmtMoney(b.ar_outstanding)} warn={b.ar_outstanding > 0.001} fullRow />
                  </div>
                )}
              </div>
            ))}
          </div>

          <p style={{ marginTop: 18, fontSize: 11, color: '#94a3b8' }}>
            Snapshot taken {new Date(data.as_of).toLocaleString()} · auto-refresh every 30s
          </p>
        </>
      )}
    </div>
  );
}

function RollupCard({ icon, label, value, sub, color }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color, fontSize: 12, fontWeight: 600 }}>
        {icon} <span>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Metric({ label, value, sub, warn, fullRow }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: '8px 10px', gridColumn: fullRow ? '1 / -1' : 'auto' }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: warn ? '#b91c1c' : '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

const tagStyle = (bg, fg) => ({
  background: bg, color: fg, fontSize: 10, fontWeight: 700,
  padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4,
});
