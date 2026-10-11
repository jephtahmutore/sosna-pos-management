// HqAccountReceivables — every branch's customer ledger on one screen.
// Read-only: payments are still recorded at the branch, where they mint a
// cash receipt in that branch's cash book.
//
// Backed by /api/hq/account-receivables, which runs the branch's own
// Account Receivables query against each branch DB — so a figure here
// always matches what the branch sees.
//
// Amounts stay in each branch's own currency. USD-base branches
// (Kassumbalesa) and K-base branches (Mansa, Lusaka) are never added
// together: totals are shown per branch and per currency only. The same
// customer name at two branches is two rows — nothing links them.
import React, { useState, useEffect, useCallback } from 'react';
import { getHqAccountReceivables, getHqCustomerStatement, getSettings } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { FiSearch, FiRefreshCw, FiPrinter, FiChevronRight, FiAlertTriangle } from 'react-icons/fi';
import useModalScrollLock from '../utils/useModalScrollLock';
import CustomerStatementModal from '../components/CustomerStatementModal';
import { matchTokens } from '../utils/tokenSearch';

const symFor = (ccy) => (ccy === 'USD' ? '$' : 'K');
const fmtIn = (ccy) => (n) =>
  `${symFor(ccy)}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusBadge = (status) => {
  const map = {
    'Paid': { bg: '#dcfce7', fg: '#15803d' },
    'Partial': { bg: '#fef3c7', fg: '#b45309' },
    'Unpaid': { bg: '#fee2e2', fg: '#b91c1c' },
    'No Sales': { bg: '#f3f4f6', fg: '#6b7280' },
    'OnHold': { bg: '#fee2e2', fg: '#b91c1c' },
  };
  return map[status] || map['No Sales'];
};

// Same derivation as the branch Account Receivables page. Display
// convention: positive balance = customer paid in advance, negative =
// customer still owes.
const enrich = (c) => {
  const sold = parseFloat(c.total_sold || 0);
  const paid = parseFloat(c.cash_at_sale || 0) + parseFloat(c.total_paid || 0);
  const balance = paid - sold;
  let status = 'No Sales';
  if (c.credit_status === 'OnHold') status = 'OnHold';
  else if (sold === 0)              status = 'No Sales';
  else if (balance >= -0.01)        status = 'Paid';
  else if (paid > 0)                status = 'Partial';
  else                              status = 'Unpaid';
  return {
    ...c, _sold: sold, _paid: paid, _balance: balance, _status: status,
    _outstandingFra: parseFloat(c.outstanding_fra || 0),
    _outstandingK:   parseFloat(c.outstanding_k   || 0),
  };
};

const totalsOf = (rows) => ({
  sold:        rows.reduce((s, r) => s + r._sold, 0),
  paid:        rows.reduce((s, r) => s + r._paid, 0),
  outstanding: rows.reduce((s, r) => s + Math.max(0, -r._balance), 0),
  credit:      rows.reduce((s, r) => s + Math.max(0,  r._balance), 0),
  owing:       rows.filter(r => r._balance < -0.01).length,
  count:       rows.length,
});

export default function HqAccountReceivables() {
  const { user: authUser } = useAuth();
  const [branches, setBranches] = useState([]);
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [businessInfo, setBusinessInfo] = useState({});
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [owingOnly, setOwingOnly] = useState(false);
  // Default to All Time so balances are the true cumulative position.
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [statement, setStatement] = useState(null); // statement payload + branch
  const [toast, setToast] = useState('');

  useModalScrollLock(!!statement);

  const _today = new Date();
  const _todayStr = _today.toISOString().split('T')[0];
  const _firstOfMonth = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-01`;

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await getHqAccountReceivables({ from: filterFrom || undefined, to: filterTo || undefined });
      setBranches((res.data?.branches || []).map(b => ({ ...b, rows: (b.customers || []).map(enrich) })));
      setErrors(res.data?.errors || []);
    } catch (err) {
      setLoadError(err?.response?.data?.error || err?.message || 'Failed to load receivables');
    }
    setLoading(false);
  }, [filterFrom, filterTo]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  const openStatement = async (branch, customer) => {
    try {
      const res = await getHqCustomerStatement(branch.slug, customer.id);
      setStatement(res.data);
    } catch (err) {
      setToast(err?.response?.data?.error || 'Failed to load statement');
      setTimeout(() => setToast(''), 3500);
    }
  };

  // Visible branches + rows after the branch / search / owing filters.
  // Biggest debtor first within each branch (most negative balance on top).
  const visible = branches
    .filter(b => branchFilter === 'all' || b.slug === branchFilter)
    .map(b => ({
      ...b,
      shown: b.rows
        .filter(r => matchTokens(search, r.name, r.phone, r.email))
        .filter(r => !owingOnly || r._balance < -0.01)
        .sort((x, y) => x._balance - y._balance),
    }));

  // Per-currency roll-up of the visible branches — never mixes USD and K.
  const byCurrency = [];
  for (const b of visible) {
    let g = byCurrency.find(x => x.currency === b.currency);
    if (!g) { g = { currency: b.currency, names: [], rows: [] }; byCurrency.push(g); }
    g.names.push(b.name);
    g.rows.push(...b.shown);
  }

  const period = (filterFrom || filterTo) ? `${filterFrom || '—'} to ${filterTo || '—'}` : 'All Time';

  const handlePrint = () => {
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const sections = visible.map(b => {
      const fmt = fmtIn(b.currency);
      const t = totalsOf(b.shown);
      const rowsHtml = b.shown.map((r, idx) => `
        <tr style="border-bottom:1px solid #ddd;background:${idx % 2 === 1 ? '#f9f9f9' : '#fff'}">
          <td style="padding:6px 10px;font-size:10.5px">${idx + 1}</td>
          <td style="padding:6px 10px;font-weight:700">${r.name}</td>
          <td style="padding:6px 10px">${r.phone || '—'}</td>
          <td style="padding:6px 10px;text-align:right">${parseFloat(r.credit_limit) > 0 ? fmt(r.credit_limit) : '—'}</td>
          <td style="padding:6px 10px;text-align:right">${fmt(r._sold)}</td>
          <td style="padding:6px 10px;text-align:right;font-weight:600">${fmt(r._paid)}</td>
          <td style="padding:6px 10px;text-align:right;font-weight:700">${fmt(Math.abs(r._balance))}${r._balance < -0.01 ? ' (owed)' : r._balance > 0.01 ? ' (advance)' : ''}</td>
          <td style="padding:6px 10px">${r._status === 'OnHold' ? 'On Hold' : r._status}</td>
        </tr>`).join('');
      return `
        <div style="margin-bottom:16px;page-break-inside:auto">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
            <div style="font-size:13px;font-weight:800">${b.name}</div>
            <div style="font-size:9.5px">Currency: ${b.currency} · ${t.count} customer${t.count !== 1 ? 's' : ''} (${t.owing} owing)</div>
          </div>
          <div style="border:1.5px solid #000">
            <table style="font-size:11px">
              <thead><tr>
                <th style="width:28px">#</th><th>Customer</th><th>Phone</th>
                <th style="text-align:right">Credit Limit</th>
                <th style="text-align:right">Total Sales</th><th style="text-align:right">Total Paid</th>
                <th style="text-align:right">Balance</th><th>Status</th>
              </tr></thead>
              <tbody>${rowsHtml || `<tr><td colspan="8" style="padding:18px;text-align:center;color:#666">No customers.</td></tr>`}</tbody>
              ${b.shown.length > 0 ? `<tfoot><tr>
                <td colspan="4">TOTAL — ${b.name}</td>
                <td style="text-align:right">${fmt(t.sold)}</td>
                <td style="text-align:right">${fmt(t.paid)}</td>
                <td style="text-align:right">${fmt(t.outstanding)} (owed)</td>
                <td></td>
              </tr></tfoot>` : ''}
            </table>
          </div>
        </div>`;
    }).join('');
    const summary = byCurrency.map(g => {
      const fmt = fmtIn(g.currency);
      const t = totalsOf(g.rows);
      return `
        <div style="flex:1;padding:10px 12px;border:1.5px solid #000">
          <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:4px">${g.currency} branches — ${g.names.join(', ')}</div>
          <div style="font-size:10.5px">Total Sales: <strong>${fmt(t.sold)}</strong></div>
          <div style="font-size:10.5px">Total Received: <strong>${fmt(t.paid)}</strong></div>
          <div style="font-size:12px;margin-top:2px">Outstanding: <strong>${fmt(t.outstanding)}</strong></div>
        </div>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Account Receivables — All Branches</title><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:7px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      tfoot td{padding:8px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${biz}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Account Receivables</div>
          <div style="font-size:15px;font-weight:700">All Branches</div>
          <div style="font-size:9px;margin-top:3px">Period: ${period}</div>
          <div style="font-size:9px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:8px">${summary}</div>
      <div style="font-size:9px;color:#444;margin-bottom:14px">Amounts are in each branch's own currency. USD and K totals are not added together.</div>
      ${sections}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:28px;margin-bottom:16px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${biz} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const chip = (active) => ({
    padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${active ? '#1d4ed8' : '#e5e7eb'}`,
    background: active ? '#1d4ed8' : '#fff', color: active ? '#fff' : '#374151',
  });
  const th = (align = 'left') => ({ padding: '11px 12px', textAlign: align, fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: '1px solid #e5e7eb' });

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Account Receivables</h1>
          <p>Customer balances across all branches — each branch in its own currency</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load}
            style={{ padding: '9px 16px', background: '#fff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw size={14} /> Refresh
          </button>
          <button onClick={handlePrint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPrinter size={15} /> Print
          </button>
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, padding: '10px 18px', borderRadius: 8, color: '#fff', fontWeight: 600, background: '#dc2626', boxShadow: '0 4px 14px rgba(0,0,0,0.18)', zIndex: 1100 }}>
          {toast}
        </div>
      )}

      {loadError && (
        <div style={{ marginBottom: 14, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiAlertTriangle size={15} /> {loadError}
        </div>
      )}
      {errors.length > 0 && (
        <div style={{ marginBottom: 14, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, color: '#92400e', fontSize: 13 }}>
          <strong>Some branches could not be read</strong> and are missing below: {errors.map(e => `${e.slug} (${e.error})`).join('; ')}
        </div>
      )}

      {/* Per-currency totals — one block per currency, never mixed */}
      {byCurrency.map(g => {
        const fmt = fmtIn(g.currency);
        const t = totalsOf(g.rows);
        const cell = (label, value, color) => (
          <div style={{ flex: '1 1 150px', minWidth: 150 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color, marginTop: 2 }}>{value}</div>
          </div>
        );
        return (
          <div key={g.currency} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 18px', marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 10 }}>
              <span style={{ padding: '2px 9px', borderRadius: 6, background: g.currency === 'USD' ? '#dcfce7' : '#ffedd5', color: g.currency === 'USD' ? '#15803d' : '#c2410c', marginRight: 8 }}>{g.currency}</span>
              {g.names.join(' · ')}
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              {cell('Total Sales',    fmt(t.sold),  '#1d4ed8')}
              {cell('Total Received', fmt(t.paid),  '#16a34a')}
              {cell('Outstanding',    (t.outstanding > 0.01 ? '−' : '') + fmt(t.outstanding), '#dc2626')}
              {t.credit > 0.01 && cell('Customer Credit', fmt(t.credit), '#b45309')}
              {cell('Customers', `${t.count} (${t.owing} owing)`, '#7c3aed')}
            </div>
          </div>
        );
      })}

      {/* Date filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, padding: '12px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Filter by date:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>From</span>
          <input type="date" value={filterFrom} max={filterTo || _todayStr}
            onChange={e => setFilterFrom(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>To</span>
          <input type="date" value={filterTo} min={filterFrom || undefined} max={_todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }} />
        </div>
        <button onClick={() => { setFilterFrom(_firstOfMonth); setFilterTo(_todayStr); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #bfdbfe', fontSize: 12, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>
          This Month
        </button>
        <button onClick={() => { setFilterFrom(''); setFilterTo(''); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
          All Time
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
          {filterFrom || filterTo ? period : 'Showing all time'}
        </span>
      </div>

      {/* Branch filter + owing toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setBranchFilter('all')} style={chip(branchFilter === 'all')}>All branches</button>
        {branches.map(b => (
          <button key={b.slug} onClick={() => setBranchFilter(b.slug)} style={chip(branchFilter === b.slug)}>
            {b.name} <span style={{ opacity: 0.75, fontWeight: 600 }}>· {b.currency}</span>
          </button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={owingOnly} onChange={e => setOwingOnly(e.target.checked)} />
          Only customers who owe
        </label>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 12, position: 'relative' }}>
        <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input type="text" placeholder="Search customer name or phone…"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 12px 10px 36px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8' }}>Loading receivables…</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', background: '#fff', borderRadius: 10 }}>No branches to show.</div>
      ) : visible.map(b => {
        const fmt = fmtIn(b.currency);
        const t = totalsOf(b.shown);
        return (
          <div key={b.slug} style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#111827' }}>
                {b.name}
                <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: b.currency === 'USD' ? '#dcfce7' : '#ffedd5', color: b.currency === 'USD' ? '#15803d' : '#c2410c' }}>{b.currency}</span>
              </div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {t.count} customer{t.count !== 1 ? 's' : ''} · {t.owing} owing · Outstanding <strong style={{ color: '#dc2626' }}>{fmt(t.outstanding)}</strong>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th style={th()}>Customer</th>
                    <th style={th()}>Phone</th>
                    <th style={th('right')}>Credit Limit</th>
                    <th style={th('right')}>Total Sales</th>
                    <th style={th('right')}>Total Paid</th>
                    <th style={th('right')}>Balance</th>
                    <th style={th('right')}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {b.shown.length === 0 ? (
                    <tr><td colSpan={7} style={{ padding: 28, textAlign: 'center', color: '#9ca3af' }}>No customers match.</td></tr>
                  ) : b.shown.map(r => {
                    const s = statusBadge(r._status);
                    return (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '10px 12px' }}>
                          <button onClick={() => openStatement(b, r)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, color: '#1d4ed8', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            {r.name} <FiChevronRight size={13} />
                          </button>
                        </td>
                        <td style={{ padding: '10px 12px', color: '#6b7280' }}>{r.phone || '—'}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{parseFloat(r.credit_limit) > 0 ? fmt(r.credit_limit) : <span style={{ color: '#9ca3af' }}>—</span>}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmt(r._sold)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{fmt(r._paid)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: r._balance > 0.01 ? '#b45309' : r._balance < -0.01 ? '#dc2626' : '#16a34a' }}>
                          {/* Signed value — minus sign goes BEFORE the currency symbol. */}
                          {r._balance < 0 ? '−' : ''}{fmt(Math.abs(r._balance))}
                          {/* FRA / K equivalents at the captured sale rates (USD-base branches). */}
                          {b.currency === 'USD' && r._balance < -0.01 && (r._outstandingFra > 0.01 || r._outstandingK > 0.01) && (
                            <div style={{ fontSize: 10, fontWeight: 500, color: '#94a3b8', marginTop: 2 }}>
                              ≈ {r._outstandingFra > 0.01 && <>FRA {Math.round(r._outstandingFra).toLocaleString()}</>}
                              {r._outstandingFra > 0.01 && r._outstandingK > 0.01 && ' · '}
                              {r._outstandingK > 0.01 && <>K {Math.round(r._outstandingK).toLocaleString()}</>}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                          <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.fg }}>{r._status === 'OnHold' ? 'On Hold' : r._status}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {b.shown.length > 0 && (
                  <tfoot>
                    <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                      <td colSpan={3} style={{ padding: '10px 12px' }}>TOTAL — {b.name}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmt(t.sold)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{fmt(t.paid)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#dc2626' }}>{t.outstanding > 0.01 ? '−' : ''}{fmt(t.outstanding)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        );
      })}

      {statement && (
        <CustomerStatementModal
          statement={statement}
          fmt={fmtIn(statement.branch?.currency)}
          businessInfo={businessInfo}
          authUser={authUser}
          branchName={statement.branch?.name}
          onClose={() => setStatement(null)}
        />
      )}
    </div>
  );
}
