// HqSalesReport — cross-branch order list. Only useful on the bare HQ
// host (sosnazm.com); on a per-branch subdomain the sidebar hides this
// entry (the per-branch SalesReport page already exists there).
//
// Filters: date-from, date-to, branch (all / specific).
// Display:  rollup totals + per-branch breakdown + flat order table.
// Backend: GET /api/hq/sales-report (loops over each tenant DB).
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiTrendingUp, FiAlertTriangle } from 'react-icons/fi';
import { getHqSalesReport, getHqBranches, setHqBranch } from '../services/api';

// v1.10.236 — money formatting is currency-aware. Every order carries its
// branch's currency ('USD' or 'K'); totals are split into per-currency
// buckets so mixed-currency ranges (Kassumbalesa USD + Lusaka/Mansa K)
// never sum as one meaningless number.
const fmtNum       = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoneyCcy  = (n, ccy) => `${ccy === 'K' ? 'K' : '$'}${fmtNum(n)}`;
const fmtInt       = (n) => parseFloat(n || 0).toLocaleString();
const todayISO     = () => new Date().toISOString().slice(0, 10);

export default function HqSalesReport() {
  const [from, setFrom]     = useState(todayISO());
  const [to, setTo]         = useState(todayISO());
  const [branch, setBranch] = useState('all');
  const [branches, setBranches] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await getHqSalesReport({ from, to, branch });
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load report');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const perBranch = useMemo(() => {
    if (!data?.totals?.by_branch) return [];
    return Object.entries(data.totals.by_branch)
      .map(([slug, v]) => ({ slug, ...v, currency: v.currency || 'K' }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [data]);

  // Rows to render in the currency-split totals block. Only includes
  // buckets that actually have movement in this range.
  const totalsByCcy = useMemo(() => {
    const rev = data?.totals?.revenue_by_ccy  || {};
    const rec = data?.totals?.received_by_ccy || {};
    return ['USD', 'K']
      .map(c => ({ ccy: c, revenue: parseFloat(rev[c] || 0), received: parseFloat(rec[c] || 0) }))
      .filter(r => r.revenue !== 0 || r.received !== 0);
  }, [data]);

  const openInBranch = (slug, orderId) => {
    setHqBranch(slug);
    // The per-branch SalesReport accepts the order via its URL hash
    // (already implemented in the branch UI) — for v1 we just navigate
    // to the branch's sales-report root and let the operator filter.
    window.location.href = '/pos/sales-report';
    void orderId;
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Sales Report</h1>
          <p>Drill into orders across every branch</p>
        </div>
      </div>

      {/* ── Filters bar ──────────────────────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <Field label="From">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </Field>
        <Field label="Branch">
          <select value={branch} onChange={e => setBranch(e.target.value)} style={inp}>
            <option value="all">All branches</option>
            {branches.map(b => <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>)}
          </select>
        </Field>
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
          {/* ── Rollup + per-branch ────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
              <h3 style={hd}>Totals ({data.from} → {data.to})</h3>
              <Stat label="Orders" value={fmtInt(data.totals.orders)} />
              {totalsByCcy.length === 0 ? (
                <Stat label="Total Sales" value="—" />
              ) : totalsByCcy.map(r => (
                <React.Fragment key={r.ccy}>
                  <Stat label={`Total Sales (${r.ccy})`}     value={fmtMoneyCcy(r.revenue, r.ccy)} big />
                  <Stat label={`Total Collected (${r.ccy})`} value={fmtMoneyCcy(r.received, r.ccy)} />
                </React.Fragment>
              ))}
              {data.truncated && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#92400e', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <FiAlertTriangle /> Showing first {fmtInt(data.returned_rows)} of {fmtInt(data.total_rows)} — narrow the date range to see more
                </div>
              )}
            </div>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
              <h3 style={hd}>By Branch</h3>
              {perBranch.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No orders in this range.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr><th style={thS}>Branch</th><th style={{ ...thS, textAlign: 'right' }}>Orders</th><th style={{ ...thS, textAlign: 'right' }}>Revenue</th></tr></thead>
                  <tbody>
                    {perBranch.map(b => (
                      <tr key={b.slug} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={tdS}>{b.name} <span style={{ color: '#94a3b8', fontSize: 11 }}>({b.slug})</span></td>
                        <td style={{ ...tdS, textAlign: 'right' }}>{fmtInt(b.orders)}</td>
                        <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmtMoneyCcy(b.revenue, b.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* ── Order list ─────────────────────────────────────────── */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
            <h3 style={hd}>Orders ({fmtInt(data.returned_rows)})</h3>
            {data.orders.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No orders match the filters.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ background: '#f8fafc' }}>
                    <tr>
                      <th style={th}>Date</th>
                      <th style={th}>Order #</th>
                      <th style={th}>Branch</th>
                      <th style={th}>Customer</th>
                      <th style={{ ...th, textAlign: 'right' }}>Total</th>
                      <th style={{ ...th, textAlign: 'right' }}>Received</th>
                      <th style={th}>Status</th>
                      <th style={th}>By</th>
                      <th style={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map(o => {
                      const when = o.paid_at || o.created_at || '';
                      return (
                        <tr key={`${o.branch_slug}-${o.id}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={td}>{when ? new Date(when).toLocaleString() : '—'}</td>
                          <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{o.order_number}</td>
                          <td style={td}>
                            <span style={tag('#e2e8f0', '#0f172a')}>{o.branch_slug}</span>
                          </td>
                          <td style={td}>{o.customer_name || 'Walk-in'}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoneyCcy(o.total_amount, o.branch_currency || o.currency)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{fmtMoneyCcy(o.amount_received, o.branch_currency || o.currency)}</td>
                          <td style={td}>{statusBadge(o.status)}</td>
                          <td style={td}>{o.created_by_name || '—'}</td>
                          <td style={td}>
                            <button onClick={() => openInBranch(o.branch_slug, o.id)}
                              style={{ padding: '4px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                              Open
                            </button>
                          </td>
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
function Stat({ label, value, big }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: big ? 22 : 15, fontWeight: 800, color: '#0f172a' }}>{value}</div>
    </div>
  );
}
function statusBadge(s) {
  const map = {
    'PENDING_PAYMENT': ['#fef3c7', '#92400e', 'Pending'],
    'PAID':            ['#dbeafe', '#1e40af', 'Paid'],
    'DISPATCHED':      ['#dcfce7', '#166534', 'Dispatched'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s || 'Completed'];
  return <span style={tag(bg, fg)}>{label}</span>;
}

const inp = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 160 };
const hd  = { margin: '0 0 10px 0', fontSize: 14, color: '#0f172a' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left' };
const tdS = { padding: '6px 8px', color: '#0f172a' };
const tag = (bg, fg) => ({ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 });
