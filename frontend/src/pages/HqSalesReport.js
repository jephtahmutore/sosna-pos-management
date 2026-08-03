// HqSalesReport — cross-branch order list. Only useful on the bare HQ
// host (sosnazm.com); on a per-branch subdomain the sidebar hides this
// entry (the per-branch SalesReport page already exists there).
//
// Filters: date-from, date-to, branch (all / specific).
// Display:  rollup totals + per-branch breakdown + flat order table.
// Backend: GET /api/hq/sales-report (loops over each tenant DB).
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiTrendingUp, FiAlertTriangle } from 'react-icons/fi';
import { getHqSalesReport, getHqBranches } from '../services/api';

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

  // v1.10.295 — Orders block sub-tabs: 'orders' (default) shows the flat
  // order card list; 'items' shows product-aggregated cards from the new
  // items_by_ccy backend field. Top branch filter drives both. Mixed
  // currencies render as separate K + $ rows (same axis as HQ Inventory's
  // stock_value_by_currency — never sum K + USD).
  const [ordersSubTab, setOrdersSubTab] = useState('orders');
  const [expandedItems, setExpandedItems] = useState(() => new Set());
  const toggleItem = (key) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

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

  // v1.10.295 — By Item sub-tab: currency-bucketed list of product rows
  // for the visible date range. Server pre-sorts by revenue desc within
  // each currency. USD first (top of the file), then K. Only non-empty
  // buckets render.
  const itemsByCcyList = useMemo(() => {
    const map = data?.items_by_ccy || {};
    return ['USD', 'K']
      .map(c => ({ ccy: c, items: map[c] || [] }))
      .filter(r => r.items.length > 0);
  }, [data]);

  // v1.10.279 — openInBranch removed with the per-row "Open" buttons.
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

          {/* ── Orders block: [Orders | By Item] sub-tabs ────────────
               v1.10.295 — By Branch (the panel above) stays as a list —
               that block reads fine as rows. The change is here: the
               order list becomes cards + gains a sibling "By Item" tab
               that aggregates the same date range by product. Both tabs
               are cards so nothing scrolls sideways on a phone. */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <h3 style={{ ...hd, margin: 0 }}>
                {ordersSubTab === 'orders'
                  ? `Orders (${fmtInt(data.returned_rows)})`
                  : `By Item (${itemsByCcyList.reduce((a, r) => a + r.items.length, 0)})`}
              </h3>
              <div style={subTabStrip}>
                <button
                  type="button"
                  onClick={() => setOrdersSubTab('orders')}
                  style={subTab(ordersSubTab === 'orders')}
                >Orders</button>
                <button
                  type="button"
                  onClick={() => setOrdersSubTab('items')}
                  style={subTab(ordersSubTab === 'items')}
                >By Item</button>
              </div>
            </div>

            {ordersSubTab === 'orders' && (
              data.orders.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No orders match the filters.</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                  {data.orders.map(o => (
                    <OrderCard key={`${o.branch_slug}-${o.id}`} o={o} />
                  ))}
                </div>
              )
            )}

            {ordersSubTab === 'items' && (
              itemsByCcyList.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No line items in this range.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {itemsByCcyList.map(bucket => (
                    <div key={bucket.ccy}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
                        {bucket.ccy === 'USD' ? 'USD sales' : 'K sales'} · {bucket.items.length} product{bucket.items.length === 1 ? '' : 's'}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                        {bucket.items.map(it => {
                          const key = `${bucket.ccy}-${it.product_id || 'x'}-${it.product_name}`;
                          return (
                            <ItemCard
                              key={key}
                              item={it}
                              ccy={bucket.ccy}
                              expanded={expandedItems.has(key)}
                              onToggle={() => toggleItem(key)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

// v1.10.295 — Order card. Replaces the wide table row; carries the same
// data (date, order#, branch, customer, total, received, status, by) but
// stacks vertically so it reads on a phone without sideways scroll.
function OrderCard({ o }) {
  const when = o.paid_at || o.created_at || '';
  const ccy  = o.branch_currency || o.currency;
  return (
    <div style={cardShell}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#0f172a', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.order_number}</div>
        <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', whiteSpace: 'nowrap' }}>{fmtMoneyCcy(o.total_amount, ccy)}</div>
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
        {when ? new Date(when).toLocaleString() : '—'}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={tag('#e2e8f0', '#0f172a')}>{o.branch_slug}</span>
        <span style={{ fontSize: 12, color: '#0f172a' }}>{o.customer_name || 'Walk-in'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#475569', borderTop: '1px solid #f1f5f9', paddingTop: 6 }}>
        <div>Received <strong style={{ color: '#0f172a' }}>{fmtMoneyCcy(o.amount_received, ccy)}</strong></div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {statusBadge(o.status)}
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
        by {o.created_by_name || '—'}
      </div>
    </div>
  );
}

// v1.10.295 — By Item card. Compact header with product name + qty +
// revenue; chevron expands to show the per-branch breakdown fed by the
// backend's items_by_ccy[ccy][n].branches map. Never mixes currencies —
// USD products live in one bucket, K products in another.
function ItemCard({ item, ccy, expanded, onToggle }) {
  const branchEntries = Object.entries(item.branches || {});
  return (
    <div style={{ ...cardShell, borderColor: expanded ? '#0ea5e9' : '#e2e8f0' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', lineHeight: 1.25 }}>{item.product_name}</div>
          <div style={{ fontSize: 16, color: '#94a3b8', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <div style={{ fontSize: 11, color: '#64748b' }}>Sold <strong style={{ color: '#0f172a' }}>{fmtNum(item.qty)}</strong></div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', whiteSpace: 'nowrap' }}>{fmtMoneyCcy(item.revenue, ccy)}</div>
        </div>
        {branchEntries.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
            {branchEntries.map(([slug]) => (
              <span key={slug} style={tag('#e2e8f0', '#0f172a')}>{slug}</span>
            ))}
          </div>
        )}
      </button>
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {branchEntries.map(([slug, b]) => (
            <div key={slug} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <div style={{ color: '#64748b' }}>{b.name || slug}</div>
              <div style={{ color: '#0f172a', fontWeight: 600 }}>{fmtNum(b.qty)} · {fmtMoneyCcy(b.revenue, ccy)}</div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 4, borderTop: '1px dashed #e2e8f0', paddingTop: 4 }}>
            <div style={{ color: '#64748b' }}>Orders</div>
            <div style={{ color: '#0f172a', fontWeight: 600 }}>{fmtInt(item.orders_count)}</div>
          </div>
        </div>
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

// v1.10.295 — sub-tab strip + card shells for the new Orders block.
const subTabStrip = { display: 'inline-flex', gap: 4, padding: 3, background: '#f1f5f9', borderRadius: 8 };
const subTab = (active) => ({
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  color: active ? '#0f172a' : '#64748b',
  background: active ? '#fff' : 'transparent',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  boxShadow: active ? '0 1px 2px rgba(15,23,42,0.06)' : 'none',
});
const cardShell = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
};
