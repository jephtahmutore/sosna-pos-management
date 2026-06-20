// HqCashPosition — per-branch cash IN / OUT / Net per payment method
// (Cash / Bank / MoMo) for today and month-to-date. Aggregated across
// every registered tenant by /api/hq/cash-position.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiAlertTriangle, FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { getHqCashPosition, setHqBranch } from '../services/api';

const fmtMoney = (n) => {
  const v = parseFloat(n || 0);
  const s = `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `-${s}` : s;
};

export default function HqCashPosition() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('today'); // 'today' | 'mtd'

  const load = async () => {
    setError('');
    try {
      const res = await getHqCashPosition();
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load cash position');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Cash Position</h1>
          <p>Cash movements across all branches</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 8, padding: 3 }}>
            <PeriodButton active={period === 'today'} onClick={() => setPeriod('today')}>Today</PeriodButton>
            <PeriodButton active={period === 'mtd'}   onClick={() => setPeriod('mtd')}>Month-to-Date</PeriodButton>
          </div>
          <button onClick={load}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <p style={{ color: '#64748b' }}>Loading…</p>
      ) : data && (
        <>
          {/* Rollup card */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 18, marginBottom: 18 }}>
            <h3 style={{ margin: '0 0 14px 0', fontSize: 15, color: '#0f172a' }}>
              All Branches · {period === 'today' ? 'Today' : 'Month-to-Date'}
            </h3>
            <RollupRow rollup={data.rollup[period]} />
          </div>

          {/* Per-branch grid */}
          <h3 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#0f172a' }}>By Branch</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
            {(data.branches || []).map(b => (
              <div key={b.slug} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <h4 style={{ margin: '0 0 2px 0', fontSize: 15, color: '#0f172a' }}>{b.name}</h4>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>{b.slug}</span>
                  </div>
                  <button onClick={() => { setHqBranch(b.slug); window.location.href = '/accounting/cash-book'; }}
                    style={{ padding: '5px 12px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    Open Cash Book
                  </button>
                </div>
                {b.error ? (
                  <div style={{ padding: 10, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12 }}>
                    <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 4 }} /> {b.error}
                  </div>
                ) : (
                  <BranchTable data={b[period]} />
                )}
              </div>
            ))}
          </div>

          <p style={{ marginTop: 18, fontSize: 11, color: '#94a3b8' }}>
            Snapshot taken {new Date(data.as_of).toLocaleString()} · auto-refresh every 60s
          </p>
        </>
      )}
    </div>
  );
}

function PeriodButton({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: active ? '#fff' : 'transparent', color: active ? '#0f172a' : '#64748b',
        fontWeight: active ? 700 : 500, fontSize: 12,
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
      }}>{children}</button>
  );
}

function RollupRow({ rollup }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
      {['cash', 'bank', 'momo'].map(method => (
        <div key={method} style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>{method}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569', marginBottom: 3 }}>
            <span><FiTrendingUp style={{ verticalAlign: 'middle' }} /> In</span>
            <span style={{ fontWeight: 700, color: '#047857' }}>{fmtMoney(rollup.in[method])}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569', marginBottom: 3 }}>
            <span><FiTrendingDown style={{ verticalAlign: 'middle' }} /> Out</span>
            <span style={{ fontWeight: 700, color: '#b91c1c' }}>{fmtMoney(rollup.out[method])}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, borderTop: '1px solid #e2e8f0', marginTop: 6, paddingTop: 6 }}>
            <span style={{ fontWeight: 700, color: '#0f172a' }}>Net</span>
            <span style={{ fontWeight: 800, color: rollup.net[method] >= 0 ? '#0f172a' : '#b91c1c' }}>{fmtMoney(rollup.net[method])}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function BranchTable({ data }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: '#f8fafc' }}>
          <th style={th}>Method</th>
          <th style={{ ...th, textAlign: 'right' }}>In</th>
          <th style={{ ...th, textAlign: 'right' }}>Out</th>
          <th style={{ ...th, textAlign: 'right' }}>Net</th>
        </tr>
      </thead>
      <tbody>
        {['cash', 'bank', 'momo'].map(method => (
          <tr key={method} style={{ borderTop: '1px solid #f1f5f9' }}>
            <td style={{ ...td, fontWeight: 700, textTransform: 'uppercase' }}>{method}</td>
            <td style={{ ...td, textAlign: 'right', color: '#047857' }}>{fmtMoney(data.in[method])}</td>
            <td style={{ ...td, textAlign: 'right', color: '#b91c1c' }}>{fmtMoney(data.out[method])}</td>
            <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: data.net[method] >= 0 ? '#0f172a' : '#b91c1c' }}>{fmtMoney(data.net[method])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th = { padding: '7px 10px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td = { padding: '7px 10px', color: '#0f172a' };
