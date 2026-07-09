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
  FiAlertTriangle, FiArrowRight, FiUploadCloud, FiX, FiCheckCircle,
} from 'react-icons/fi';
import { getHqOverview, setHqBranch, mirrorHqToAllBranches } from '../services/api';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();

export default function HqOverview() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Layer 3 — Sync Products to All Branches
  const [mirroring, setMirroring]   = useState(false);
  const [mirrorRes, setMirrorRes]   = useState(null); // { entities, per_branch, elapsed_ms }
  const [mirrorErr, setMirrorErr]   = useState('');

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

  const runMirror = async () => {
    if (mirroring) return;
    if (!window.confirm('Push every HQ product/category/unit to all branches now? Branch-owned fields (prices, stock, status) will NOT be touched.')) return;
    setMirroring(true);
    setMirrorErr('');
    setMirrorRes(null);
    try {
      const res = await mirrorHqToAllBranches();
      setMirrorRes(res.data);
    } catch (err) {
      setMirrorErr(err?.response?.data?.error || err?.message || 'Mirror failed');
    }
    setMirroring(false);
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={runMirror} disabled={mirroring}
            title="Push every HQ product / category / unit to all branches. Branch prices, stock, and status are preserved."
            style={{ padding: '8px 14px', background: mirroring ? '#94a3b8' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: mirroring ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiUploadCloud /> {mirroring ? 'Syncing…' : 'Sync Products to All'}
          </button>
          <button onClick={load}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
        </div>
      </div>

      {mirrorErr && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          Mirror failed: {mirrorErr}
        </div>
      )}

      {mirrorRes && (
        <MirrorResultModal result={mirrorRes} onClose={() => setMirrorRes(null)} />
      )}

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <p style={{ color: '#64748b' }}>Loading overview…</p>
      ) : data && (() => {
        // Defensive: backend may return without rollup (transient API
        // error, mid-render race, or older endpoint version). Use a
        // zeroed default rather than crashing the whole page. v1.3.13.
        const rollup = data.rollup || {};
        return (
        <>
          {/* Roll-up row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 22 }}>
            <RollupCard icon={<FiTrendingUp />} label="Today's Revenue" value={fmtMoney(rollup.today_revenue)} sub={`${fmtInt(rollup.today_orders)} orders`} color="#0ea5e9" />
            <RollupCard icon={<FiTrendingUp />} label="Month-to-Date"     value={fmtMoney(rollup.mtd_revenue)}   sub={`${fmtInt(rollup.mtd_orders)} orders`}   color="#6366f1" />
            <RollupCard icon={<FiClock />}      label="Awaiting Payment"  value={fmtInt(rollup.pending_payment)} sub="3-station Sales → Cashier" color="#f59e0b" />
            <RollupCard icon={<FiTruck />}      label="Awaiting Dispatch" value={fmtInt(rollup.awaiting_dispatch)} sub="Cashier → Dispatch"     color="#16a34a" />
            <RollupCard icon={<FiPackage />}    label="Stock Value"       value={fmtMoney(rollup.stock_value)}   sub="At cost, all branches"  color="#0f766e" />
            <RollupCard icon={<FiDollarSign />} label="AR Outstanding"    value={fmtMoney(rollup.ar_outstanding)} sub="Unpaid by customers"   color="#dc2626" />
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
                      {/* v1.10.145 — the slug chip was leaking the internal
                          device slug (KASSUMBALESA1 etc.) into the HQ Overview
                          UI and competing with the actual business_name in the
                          heading above. Removed. Workflow-mode pill now shown
                          for every branch (was 3-station only) so managers can
                          tell at a glance which POS pattern each branch uses. */}
                      {b.currency_mode === 'USD+FRA' && <span style={tagStyle('#fef3c7', '#92400e')}>Dual currency</span>}
                      {b.workflow_mode === 'three_station'
                        ? <span style={tagStyle('#dbeafe', '#1e40af')}>3-station</span>
                        : <span style={tagStyle('#f1f5f9', '#475569')}>Single POS</span>}
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

          {data.as_of && (
            <p style={{ marginTop: 18, fontSize: 11, color: '#94a3b8' }}>
              Snapshot taken {new Date(data.as_of).toLocaleString()} · auto-refresh every 30s
            </p>
          )}
        </>
        );
      })()}
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

function MirrorResultModal({ result, onClose }) {
  const { entities = {}, per_branch = {}, elapsed_ms = 0 } = result || {};
  const slugs = Object.keys(per_branch);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(720px, 92vw)', maxHeight: '85vh', overflow: 'auto' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FiCheckCircle color="#16a34a" />
            <h3 style={{ margin: 0, fontSize: 16, color: '#0f172a' }}>Sync complete</h3>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}><FiX size={20} /></button>
        </div>

        <div style={{ padding: 18 }}>
          <p style={{ margin: '0 0 12px 0', fontSize: 13, color: '#475569' }}>
            Pushed <strong>{entities.products || 0}</strong> products, <strong>{entities.categories || 0}</strong> categories, <strong>{entities.main_categories || 0}</strong> main categories, <strong>{entities.units || 0}</strong> units to <strong>{slugs.length}</strong> branch(es) in {elapsed_ms} ms.
          </p>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                  <th style={th}>Branch</th>
                  <th style={th}>Products</th>
                  <th style={th}>Categories</th>
                  <th style={th}>Units</th>
                  <th style={th}>Errors</th>
                </tr>
              </thead>
              <tbody>
                {slugs.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 14, textAlign: 'center', color: '#94a3b8' }}>No registered branches.</td></tr>
                )}
                {slugs.map(slug => {
                  const b = per_branch[slug] || {};
                  const errCount = ['products','categories','units','main_categories']
                    .reduce((a, k) => a + ((b[k]?.errors?.length) || 0), 0);
                  return (
                    <tr key={slug} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={td}><strong>{slug}</strong></td>
                      <td style={td}>{cellCount(b.products)}</td>
                      <td style={td}>{cellCount(b.categories)}</td>
                      <td style={td}>{cellCount(b.units)}</td>
                      <td style={{ ...td, color: errCount > 0 ? '#b91c1c' : '#16a34a', fontWeight: 600 }}>{errCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ marginTop: 14, fontSize: 11, color: '#94a3b8' }}>
            Inserted = new rows added at the branch. Updated = HQ-owned fields (name, code, category, units, image, barcode) refreshed; branch prices, stock, status are untouched.
          </p>
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid #e5e7eb', textAlign: 'right' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 };
const td = { padding: '8px 10px', color: '#0f172a' };
const cellCount = (b) => b
  ? `${b.pushed} new · ${b.updated} updated`
  : '—';
