/**
 * HqFinancialStatements.js — Financial Statements (HQ-only, K-only)
 *
 * One page, three tabs: Income Statement, Balance Sheet, Cash Flow.
 * Data comes from three sibling backend endpoints on /api/hq (see hq.js
 * bottom section). Every number is already in Kwacha — no per-currency
 * toggle. FX conversion is done server-side from Kassumbalesa's daily
 * K/USD rate (orders.selling_rate_k_used).
 *
 * "Export PDF" is browser print — the .fs-print-only wrapper flips the
 * layout to a clean A4 page (SOSNA header + statement + PREPARED BY /
 * CHECKED BY / APPROVED BY footer). Matches the one-off PDF delivered to
 * the customer 2026-09-07, now available on-demand from the app.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiPrinter, FiAlertTriangle } from 'react-icons/fi';
import { getHqIncomeStatement, getHqBalanceSheet, getHqCashFlow } from '../services/api';

const fmtK = (n) => {
  const v = parseFloat(n || 0);
  const sign = v < 0 ? '−' : '';
  return `${sign}K${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const firstOfMonthISO = () => new Date().toISOString().slice(0, 7);
const todayISO        = () => new Date().toISOString().slice(0, 10);

export default function HqFinancialStatements() {
  const [tab, setTab] = useState('income'); // 'income' | 'balance' | 'cashflow'

  return (
    <div className="page-content">
      <style>{PRINT_CSS}</style>
      <div className="fs-screen">
        <div className="page-header">
          <div>
            <h1>Financial Statements</h1>
            <p>Group-wide P&amp;L, Balance Sheet, and Cash Flow &mdash; always in Kwacha (K)</p>
          </div>
        </div>

        <div style={tabBar}>
          <TabBtn active={tab === 'income'}   onClick={() => setTab('income')}>Income Statement</TabBtn>
          <TabBtn active={tab === 'balance'}  onClick={() => setTab('balance')}>Balance Sheet</TabBtn>
          <TabBtn active={tab === 'cashflow'} onClick={() => setTab('cashflow')}>Cash Flow Statement</TabBtn>
        </div>

        <div style={{ marginTop: 16 }}>
          {tab === 'income'   && <IncomeStatementView />}
          {tab === 'balance'  && <BalanceSheetView />}
          {tab === 'cashflow' && <CashFlowView />}
        </div>
      </div>
    </div>
  );
}

// Filter card wrapper — matches HqConsolidatedProfit's filter card look
function FilterCard({ children }) {
  return (
    <div className="fs-screen" style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: 14, marginBottom: 14, display: 'flex', flexWrap: 'wrap',
      gap: 12, alignItems: 'flex-end',
    }}>
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</label>
      {children}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
//  Income Statement
// ═════════════════════════════════════════════════════════════════════
function IncomeStatementView() {
  const [month, setMonth] = useState(firstOfMonthISO());
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await getHqIncomeStatement({ month });
      setData(r.data);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <>
      <FilterCard>
        <Field label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} style={inp} /></Field>
        <div style={{ flex: 1 }} />
        <button onClick={load} disabled={loading} style={btnPrimary}>
          <FiRefreshCw /> {loading ? 'Loading…' : 'View'}
        </button>
        <button onClick={() => window.print()} disabled={!data || loading} style={btnGhost}>
          <FiPrinter /> Export PDF
        </button>
      </FilterCard>

      {error && <ErrorRow msg={error} />}
      {!data && !error && !loading && <div style={emptyState}>Pick a month and click <b>View</b>.</div>}

      {data && (
        <>
          <PrintHeader title="Income Statement" period={`For the month of ${niceMonth(data.period.month)}`} />
          <StatementCard>
            <StatementTable
              rows={[
                { label: 'Revenue',                             value: data.lines.revenue,           bold: true },
                { label: 'Cost of Goods Sold',                  value: -data.lines.cogs                        },
                { label: 'Gross Profit',                        value: data.lines.gross_profit,      total: true },
                { label: 'Damages',                             value: -data.lines.damages, indent: 1          },
                { label: 'Stock Variance',                      value: data.lines.stock_variance,    indent: 1 },
                { label: 'Cash Variance',                       value: data.lines.cash_variance,     indent: 1 },
                { label: 'Supplier Rebates',                    value: data.lines.supplier_rebates,  indent: 1 },
                { label: 'Operating Profit',                    value: data.lines.operating_profit,  total: true },
                { label: 'Branch Operating Expenses (PVs)',     value: -data.lines.branch_pv                    },
                { label: 'HQ Operating Expenses (PVs)',         value: -data.lines.hq_pv                        },
                { label: 'Total Operating Expenses',            value: -data.lines.total_opex,       subtotal: true },
                { label: 'Net Profit',                          value: data.lines.net_profit,        grand: true },
              ]}
            />
          </StatementCard>
          <FxFooter fx={data.fx} />
          <PrintFooter />
          <BranchBreakdown perBranch={data.per_branch} />
        </>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════
//  Balance Sheet
// ═════════════════════════════════════════════════════════════════════
function BalanceSheetView() {
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await getHqBalanceSheet({ asOf });
      setData(r.data);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <>
      <FilterCard>
        <Field label="As at"><input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} style={inp} /></Field>
        <div style={{ flex: 1 }} />
        <button onClick={load} disabled={loading} style={btnPrimary}>
          <FiRefreshCw /> {loading ? 'Loading…' : 'View'}
        </button>
        <button onClick={() => window.print()} disabled={!data || loading} style={btnGhost}>
          <FiPrinter /> Export PDF
        </button>
      </FilterCard>

      {error && <ErrorRow msg={error} />}
      {!data && !error && !loading && <div style={emptyState}>Pick a date and click <b>View</b>.</div>}

      {data && (
        <>
          <PrintHeader title="Balance Sheet" period={`As at ${niceDate(data.asOf)}`} />
          <StatementCard>
            <SectionHeading>ASSETS</SectionHeading>
            <StatementTable
              rows={[
                { label: 'Cash &amp; Bank Balances',          value: data.assets.cash },
                { label: 'Accounts Receivable',                value: data.assets.accounts_receivable || 0 },
                { label: 'Inventory (WAC valuation)',          value: data.assets.inventory },
                { label: 'Loans Receivable',                   value: data.assets.loans_receivable },
                { label: 'Total Assets',                       value: data.assets.total, grand: true },
              ]}
            />
            <SectionHeading style={{ marginTop: 24 }}>LIABILITIES</SectionHeading>
            <StatementTable
              rows={[
                { label: 'Customer Advances',                  value: data.liabilities.customer_advances || 0 },
                { label: 'Loans Payable',                      value: data.liabilities.loans_payable },
                { label: 'HQ Payables',                        value: data.liabilities.hq_payables },
                { label: 'Total Liabilities',                  value: data.liabilities.total, subtotal: true },
              ]}
            />
            <SectionHeading style={{ marginTop: 24 }}>EQUITY</SectionHeading>
            <StatementTable
              rows={[
                { label: 'Capital Account',                    value: data.equity.capital },
                { label: 'Retained Earnings (plug)',           value: data.equity.retained_earnings },
                { label: 'Total Equity',                       value: data.equity.total, subtotal: true },
                { label: 'Total Liabilities + Equity',         value: data.liabilities.total + data.equity.total, grand: true },
              ]}
            />
          </StatementCard>
          <div style={plugNote}>
            <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 6, color: '#d97706' }} />
            {data.plug_note}
          </div>
          <FxFooter fx={data.fx} />
          <PrintFooter />
        </>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════
//  Cash Flow Statement
// ═════════════════════════════════════════════════════════════════════
function CashFlowView() {
  const [month, setMonth] = useState(firstOfMonthISO());
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await getHqCashFlow({ month });
      setData(r.data);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <>
      <FilterCard>
        <Field label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} style={inp} /></Field>
        <div style={{ flex: 1 }} />
        <button onClick={load} disabled={loading} style={btnPrimary}>
          <FiRefreshCw /> {loading ? 'Loading…' : 'View'}
        </button>
        <button onClick={() => window.print()} disabled={!data || loading} style={btnGhost}>
          <FiPrinter /> Export PDF
        </button>
      </FilterCard>

      {error && <ErrorRow msg={error} />}
      {!data && !error && !loading && <div style={emptyState}>Pick a month and click <b>View</b>.</div>}

      {data && (
        <>
          <PrintHeader title="Cash Flow Statement" period={`For the month of ${niceMonth(data.period.month)} (Direct Method)`} />
          <StatementCard>
            <SectionHeading>OPERATING ACTIVITIES</SectionHeading>
            <StatementTable
              rows={[
                { label: 'Cash Inflows (Sales, Collections, …)',  value: data.operating.inflows },
                { label: 'Cash Outflows (Suppliers, Opex, …)',    value: -data.operating.outflows },
                { label: 'Net Cash from Operating Activities',    value: data.operating.net, subtotal: true },
              ]}
            />
            <SectionHeading style={{ marginTop: 24 }}>INVESTING ACTIVITIES</SectionHeading>
            <StatementTable
              rows={[
                { label: 'Cash Inflows',                          value: data.investing.inflows },
                { label: 'Cash Outflows (Loans Issued, Capex)',   value: -data.investing.outflows },
                { label: 'Net Cash from Investing Activities',    value: data.investing.net, subtotal: true },
              ]}
            />
            <SectionHeading style={{ marginTop: 24 }}>FINANCING ACTIVITIES</SectionHeading>
            <StatementTable
              rows={[
                { label: 'Cash Inflows (Loans Received, Capital)', value: data.financing.inflows },
                { label: 'Cash Outflows (Repayments, Dividends)',  value: -data.financing.outflows },
                { label: 'Net Cash from Financing Activities',     value: data.financing.net, subtotal: true },
              ]}
            />
            <StatementTable
              style={{ marginTop: 20 }}
              rows={[
                { label: 'Net Change in Cash', value: data.net_change_in_cash, grand: true },
              ]}
            />
          </StatementCard>
          <FxFooter fx={data.fx} />
          <PrintFooter />
        </>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════
//  Shared bits
// ═════════════════════════════════════════════════════════════════════
function PrintHeader({ title, period }) {
  return (
    <div className="fs-print-only" style={printHeader}>
      <div style={{ fontFamily: 'Georgia,serif', fontSize: 28, fontWeight: 700, letterSpacing: 2, color: '#0f172a' }}>SOSNA</div>
      <div style={{ fontSize: 12, color: '#64748b', letterSpacing: 3, textTransform: 'uppercase', marginTop: 4 }}>General Dealers</div>
      <div style={{ marginTop: 22, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{title}</div>
      <div style={{ fontSize: 13, color: '#475569', marginTop: 4 }}>{period}</div>
      <div style={{ marginTop: 14, height: 3, background: '#0f172a' }} />
    </div>
  );
}

function PrintFooter() {
  return (
    <div className="fs-print-only" style={printFooter}>
      <div style={sigRow}>
        <SigBox label="Prepared By" />
        <SigBox label="Checked By" />
        <SigBox label="Approved By" />
      </div>
      <div style={{ marginTop: 20, textAlign: 'center', fontSize: 10, color: '#94a3b8', letterSpacing: 2, textTransform: 'uppercase' }}>
        SOSNA &middot; Confidential &middot; Management Use Only
      </div>
    </div>
  );
}
function SigBox({ label }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ height: 40 }} />
      <div style={{ borderTop: '1px solid #0f172a', paddingTop: 6, textAlign: 'center', fontSize: 11, color: '#334155' }}>{label}</div>
    </div>
  );
}

function StatementCard({ children }) {
  return <div style={statementCard}>{children}</div>;
}
function SectionHeading({ children, style }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase',
                  color: '#0f172a', borderBottom: '2px solid #0f172a', paddingBottom: 6, marginBottom: 6, ...(style || {}) }}>
      {children}
    </div>
  );
}
function StatementTable({ rows, style }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, ...(style || {}) }}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{
            borderTop:    r.total || r.subtotal ? '1px solid #cbd5e1' : 'none',
            borderBottom: r.grand ? '2px solid #0f172a' : 'none',
            fontWeight:   r.bold || r.total || r.subtotal || r.grand ? 700 : 400,
            background:   r.grand ? '#f1f5f9' : 'transparent',
          }}>
            <td style={{ padding: '8px 10px', paddingLeft: 10 + (r.indent || 0) * 24, color: '#0f172a' }}>{r.label}</td>
            <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                         color: parseFloat(r.value || 0) < 0 ? '#b91c1c' : '#0f172a' }}>
              {fmtK(r.value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BranchBreakdown({ perBranch }) {
  if (!perBranch || !perBranch.length) return null;
  return (
    <div className="fs-screen" style={{ marginTop: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>Per-branch breakdown</div>

      {/* Desktop: proper table. Hidden on narrow screens via CSS below. */}
      <div className="fs-breakdown-table">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
          <thead style={{ background: '#f8fafc' }}>
            <tr>
              <th style={th}>Branch</th>
              <th style={th}>Curr.</th>
              <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
              <th style={{ ...th, textAlign: 'right' }}>COGS</th>
              <th style={{ ...th, textAlign: 'right' }}>Gross</th>
              <th style={{ ...th, textAlign: 'right' }}>PV</th>
              <th style={{ ...th, textAlign: 'right' }}>Net</th>
            </tr>
          </thead>
          <tbody>
            {perBranch.map(b => (
              <tr key={b.slug} style={{ borderTop: '1px solid #f1f5f9' }}>
                <td style={td}>{b.name}</td>
                <td style={td}>{b.currency}</td>
                <td style={tdNum}>{fmtK(b.revenue)}</td>
                <td style={tdNum}>{fmtK(b.cogs)}</td>
                <td style={tdNum}>{fmtK(b.gross_profit)}</td>
                <td style={tdNum}>{fmtK(b.branch_pv)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtK(b.net_local)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards — nothing gets clipped off the right edge. */}
      <div className="fs-breakdown-cards" style={{ display: 'none', flexDirection: 'column', gap: 10 }}>
        {perBranch.map(b => (
          <div key={b.slug} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', flex: 1, marginRight: 8 }}>{b.name}</div>
              <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 99, background: '#e0f2fe', color: '#0369a1', fontWeight: 600, letterSpacing: 0.5 }}>{b.currency}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px' }}>
              <MobileStat label="Revenue" value={fmtK(b.revenue)} />
              <MobileStat label="COGS"    value={fmtK(b.cogs)} />
              <MobileStat label="Gross"   value={fmtK(b.gross_profit)} />
              <MobileStat label="PV"      value={fmtK(b.branch_pv)} />
            </div>
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>Net</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: parseFloat(b.net_local || 0) < 0 ? '#b91c1c' : '#0f172a' }}>{fmtK(b.net_local)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileStat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function FxFooter() { return null; /* removed on 2026-09-20 — cluttered the view */ }
function ErrorRow({ msg }) {
  return (
    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 12, borderRadius: 6, marginTop: 10 }}>
      <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 6 }} />
      {msg}
    </div>
  );
}
function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '10px 18px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
      background: active ? '#0ea5e9' : 'transparent',
      color:      active ? '#fff'    : '#64748b',
      borderRadius: '6px 6px 0 0', marginRight: 2,
      borderBottom: active ? '3px solid #0ea5e9' : '3px solid transparent',
    }}>{children}</button>
  );
}

function niceMonth(m) {
  const [y, mo] = m.split('-');
  const d = new Date(Date.UTC(Number(y), Number(mo) - 1, 1));
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function niceDate(d) {
  return new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// ═════════════════════════════════════════════════════════════════════
//  Styles
// ═════════════════════════════════════════════════════════════════════
const tabBar     = { display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', paddingBottom: 0, marginBottom: 4 };
const inp        = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 180 };
const btnPrimary = { padding: '9px 16px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 };
const btnGhost   = { padding: '9px 16px', background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 };
const emptyState = { padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', border: '1px dashed #e5e7eb', borderRadius: 10 };
const statementCard = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '20px 24px', marginTop: 12 };
const plugNote   = { marginTop: 12, padding: 12, background: '#fffbeb', border: '1px solid #fef3c7', borderRadius: 6, fontSize: 12, color: '#78350f', lineHeight: 1.5 };
const printHeader = { textAlign: 'center', marginBottom: 20 };
const printFooter = { marginTop: 40 };
const sigRow     = { display: 'flex', gap: 40 };
const th         = { padding: '8px 10px', fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.6, textAlign: 'left', fontWeight: 600 };
const td         = { padding: '8px 10px', color: '#0f172a' };
const tdNum      = { padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#0f172a' };

// Print CSS + mobile-responsive rules
const PRINT_CSS = `
  .fs-print-only { display: none; }
  @media print {
    @page { size: A4 portrait; margin: 18mm 16mm; }
    body, html { background: #fff !important; }
    .fs-screen { display: none !important; }
    .fs-print-only { display: block; }
  }
  /* Per-branch breakdown: table on desktop, stacked cards on mobile */
  @media (max-width: 768px) {
    .fs-breakdown-table { display: none; }
    .fs-breakdown-cards { display: flex !important; }
  }
`;
