// Customer statement — single chronological table with Debit(+) /
// Credit(−) / signed running Balance. Mirrors the AP supplier statement
// (AccountPayables.js breakdown modal) so both ledgers read the same way:
// sales land in Debit, payments in Credit.
//
// Shared by the branch Account Receivables page and HQ's cross-branch
// one. Props:
//   statement    { customer, entries } from /customers/:id/statement
//   fmt          money formatter in the branch's own currency
//   businessInfo / authUser — print header + "Printed By"
//   branchName   optional; shown when HQ opens a branch's customer
//   onOpenOrder  optional; when given, Doc # links open the order
import React, { useState } from 'react';
import { FiPrinter, FiX } from 'react-icons/fi';
import Portal from '../utils/Portal';

const CustomerStatementModal = ({ statement, fmt, businessInfo = {}, authUser, branchName, onOpenOrder, onClose }) => {
  // Per-statement date window (independent of the page filter) — same
  // behaviour as the AP supplier statement. Starts wide on every open.
  const [stmtFrom, setStmtFrom] = useState('');
  const [stmtTo, setStmtTo] = useState('');

  const entries  = statement.entries || [];
  const customer = statement.customer || {};
  const fmtAbs = (v) => fmt(Math.abs(v));
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const day = (d) => (d || '').slice(0, 10);

  // Build merged event list (order + payment)
  const allEvs = [
    ...entries.filter(e => e.type === 'order').map(o => ({
      kind: 'INV', doc: o.order_number || '—', date: day(o.date), orderId: o.id,
      reference: '', debit: parseFloat(o.amount) || 0, credit: 0,
      sortKey: day(o.date) + ' 0',
    })),
    ...entries.filter(e => e.type === 'payment').map(p => {
      // Per-method breakdown for Mixed POS payments so it's visible inline.
      const c = parseFloat(p.cash_amount || 0);
      const b = parseFloat(p.bank_amount || 0);
      const m = parseFloat(p.momo_amount || 0);
      const split = p.payment_method === 'Mixed' && (c + b + m) > 0
        ? ` (${[c > 0 ? `Cash ${fmt(c)}` : '', m > 0 ? `MoMo ${fmt(m)}` : '', b > 0 ? `Bank ${fmt(b)}` : ''].filter(Boolean).join(' · ')})`
        : '';
      return {
        kind: 'PAY', doc: p.reference || '—', date: day(p.date), orderId: p.order_id || null,
        reference: [`${p.payment_method || ''}${split}`, p.notes].filter(Boolean).join(' · '),
        // payment amounts are stored negative (they offset orders)
        debit: 0, credit: -Math.abs(parseFloat(p.amount) || 0),
        sortKey: day(p.date) + ' 1',
      };
    }),
  ].sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

  // Per-modal date filter. Everything BEFORE stmtFrom becomes the
  // opening balance for the window; only rows within
  // [stmtFrom, stmtTo] appear in the table.
  const inRange = (d) => (!stmtFrom || d >= stmtFrom) && (!stmtTo || d <= stmtTo);
  const preWindow = allEvs.filter(e => stmtFrom && e.date < stmtFrom);
  const evs = allEvs.filter(e => inRange(e.date));
  const openingBalance = preWindow.reduce((s, e) => s + e.debit + e.credit, 0);

  // Walk with running balance starting from opening
  let running = openingBalance;
  const rows = evs.map(ev => {
    running += ev.debit + ev.credit;
    return { ...ev, balance: running };
  });

  const totalDebit  = evs.reduce((s, e) => s + e.debit, 0);
  const totalCredit = evs.reduce((s, e) => s + e.credit, 0);
  const finalBal    = openingBalance + totalDebit + totalCredit;

  // Age buckets on OUTSTANDING (customer still owes). Payments are
  // applied to the oldest sales first; whatever is left is aged by
  // sale date. Only events up to the window end count, so the
  // buckets add up to the final balance shown above.
  const today = new Date();
  const daysBetween = (d) => Math.floor((today - new Date(d)) / 86400000);
  const ageBuckets = { current: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0 };
  if (finalBal > 0.01) {
    const upTo = allEvs.filter(e => !stmtTo || e.date <= stmtTo);
    const invQ = upTo.filter(e => e.kind === 'INV').map(e => ({ date: e.date, remain: e.debit }));
    let pool = -upTo.reduce((s, e) => s + e.credit, 0); // positive pool of payments
    for (const inv of invQ) {
      if (pool <= 0) break;
      const take = Math.min(pool, inv.remain);
      inv.remain -= take; pool -= take;
    }
    for (const inv of invQ) {
      if (inv.remain < 0.01) continue;
      const d = daysBetween(inv.date);
      if (d <= 30)       ageBuckets.current += inv.remain;
      else if (d <= 60)  ageBuckets.b31_60 += inv.remain;
      else if (d <= 90)  ageBuckets.b61_90 += inv.remain;
      else if (d <= 120) ageBuckets.b91_120 += inv.remain;
      else               ageBuckets.b120plus += inv.remain;
    }
  }
  const ageList = [
    ['Current', ageBuckets.current],
    ['31-60',   ageBuckets.b31_60],
    ['61-90',   ageBuckets.b61_90],
    ['91-120',  ageBuckets.b91_120],
    ['120+',    ageBuckets.b120plus],
  ];

  // Quick-preset date range helpers
  const todayIso = new Date().toISOString().slice(0, 10);
  const som      = todayIso.slice(0, 8) + '01';   // first of current month
  const dOfPrev  = new Date(); dOfPrev.setMonth(dOfPrev.getMonth() - 1);
  const prevSom  = dOfPrev.toISOString().slice(0, 8) + '01';
  const prevEom  = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().slice(0, 10);

  const balColor = (v, zero) => v > 0.01 ? '#dc2626' : v < -0.01 ? '#16a34a' : zero;
  const finalLabel = finalBal > 0.01 ? 'Customer owes you:'
                   : finalBal < -0.01 ? 'Customer has credit (paid in advance):'
                   : 'Account is square';

  // Print mirrors the on-screen statement (same rows, same window).
  const handleStatementPrint = () => {
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const windowLabel = stmtFrom || stmtTo ? `${stmtFrom || '—'} to ${stmtTo || '—'}` : 'All time';

    const pillStyle = (kind) => {
      const bg = kind === 'INV' ? '#fee2e2' : '#dcfce7';
      const fg = kind === 'INV' ? '#991b1b' : '#166534';
      return `background:${bg};color:${fg};padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700`;
    };

    const openingRow = (stmtFrom || stmtTo) && Math.abs(openingBalance) > 0.001 ? `
      <tr style="background:#fefce8;border-bottom:1px solid #fde68a">
        <td colspan="4" style="padding:6px 10px;font-style:italic;color:#a16207">Opening balance (carried over from before ${stmtFrom || 'start'})</td>
        <td></td><td></td>
        <td style="padding:6px 10px;text-align:right;font-weight:700;color:${balColor(openingBalance, '#000')}">${openingBalance < 0 ? '−' : ''}${fmtAbs(openingBalance)}</td>
      </tr>` : '';

    const bodyRows = rows.length === 0
      ? `<tr><td colspan="7" style="padding:20px;text-align:center;color:#9ca3af">No transactions in this window.</td></tr>`
      : rows.map(r => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:5px 9px;color:#374151;white-space:nowrap">${formatDate(r.date)}</td>
          <td style="padding:5px 9px;color:#6b7280;font-family:monospace;font-size:9.5px">${r.doc}</td>
          <td style="padding:5px 9px"><span style="${pillStyle(r.kind)}">${r.kind}</span></td>
          <td style="padding:5px 9px;color:${r.kind === 'INV' ? '#000' : '#6b7280'};font-weight:${r.kind === 'INV' ? '700' : '400'}">${r.reference || '—'}</td>
          <td style="padding:5px 9px;text-align:right;font-family:monospace;color:${r.debit > 0 ? '#dc2626' : '#d1d5db'}">${r.debit > 0 ? `+${fmtAbs(r.debit)}` : ''}</td>
          <td style="padding:5px 9px;text-align:right;font-family:monospace;color:${r.credit === 0 ? '#d1d5db' : '#16a34a'}">${r.credit < 0 ? `−${fmtAbs(r.credit)}` : ''}</td>
          <td style="padding:5px 9px;text-align:right;font-family:monospace;font-weight:600;color:${balColor(r.balance, '#000')}">${r.balance < 0 ? '−' : ''}${fmtAbs(r.balance)}</td>
        </tr>`).join('');

    const ageHtml = finalBal > 0.01 ? `
      <div style="margin-top:16px;padding:10px 14px;border:1.5px solid #000">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Age analysis (as of today)</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;font-size:10px;text-align:center">
          ${ageList.map(([l, v]) => `
            <div style="border:1px solid #ddd;padding:6px;background:${v > 0.01 ? '#fef2f2' : '#fff'}">
              <div style="font-size:9px;color:#6b7280;font-weight:600">${l}</div>
              <div style="font-size:11px;font-weight:700;color:${v > 0.01 ? '#dc2626' : '#9ca3af'};font-family:monospace">${fmtAbs(v)}</div>
            </div>`).join('')}
        </div>
      </div>` : '';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Statement — ${customer.name || ''}</title>
      <style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:6px 10px;font-weight:700;color:#000;border-bottom:2px solid #000;font-size:10px;background:#f0f0f0;text-align:left}
      tfoot td{padding:7px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
      </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Statement</div>
          <div style="font-size:18px;font-weight:800;margin-bottom:3px">${biz}</div>
          <div style="font-size:9.5px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:8px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Customer</div>
          <div style="font-size:14px;font-weight:700">${customer.name || ''}</div>
          ${branchName ? `<div style="font-size:9px;margin-top:2px">Branch: ${branchName}</div>` : ''}
          ${customer.phone ? `<div style="font-size:9px;margin-top:2px">${customer.phone}</div>` : ''}
          <div style="font-size:9px;margin-top:2px">Statement Date: ${formatDate(todayIso)}</div>
          <div style="font-size:9px">Window: ${windowLabel}</div>
        </div>
      </div>

      <div style="font-size:9px;color:#6b7280;margin-bottom:10px">
        Convention: sales in Debit (+), payments in Credit (−). Balance is signed: positive = customer owes you, negative = customer has paid in advance.
      </div>

      <div style="border:1.5px solid #000;margin-bottom:14px">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Doc #</th><th>Type</th><th>Reference</th>
              <th style="text-align:right;color:#dc2626">Debit (+)</th>
              <th style="text-align:right;color:#0369a1">Credit (−)</th>
              <th style="text-align:right">Balance</th>
            </tr>
          </thead>
          <tbody>
            ${openingRow}
            ${bodyRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4" style="text-align:right">Totals</td>
              <td style="text-align:right;color:#dc2626">+${fmtAbs(totalDebit)}</td>
              <td style="text-align:right;color:#0369a1">−${fmtAbs(totalCredit)}</td>
              <td style="text-align:right;color:${balColor(finalBal, '#000')}">${finalBal < 0 ? '−' : ''}${fmtAbs(finalBal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style="border:2px solid #000;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-weight:700;font-size:13px">${finalLabel}</span>
        <span style="font-weight:800;font-size:17px;color:${balColor(finalBal, '#000')}">${fmtAbs(finalBal)}</span>
      </div>

      ${ageHtml}

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:26px;margin-bottom:14px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:5px">${label}</div>
            <div style="font-size:10px;font-weight:600;min-height:16px;margin-bottom:5px">${name}</div>
            <div style="height:28px;border-bottom:1.5px solid #000;margin-bottom:3px"></div>
            <div style="font-size:8px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:6px;display:flex;justify-content:space-between">
        <span style="font-size:8px">${biz} — Confidential</span>
        <span style="font-size:8px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  return (
    <Portal>
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 1200, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        {/* Sticky header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{customer.name}</h2>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Customer account breakdown</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={handleStatementPrint}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              <FiPrinter size={13} /> Print
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
          </div>
        </div>

        <div style={{ padding: '18px 24px' }}>
          {/* Statement header block */}
          <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px', marginBottom: 12, fontSize: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div><strong>Statement Date:</strong> {formatDate(todayIso)}</div>
                <div><strong>Customer:</strong> {customer.name}</div>
              {branchName && <div><strong>Branch:</strong> {branchName}</div>}
                {customer.phone && <div><strong>Phone:</strong> {customer.phone}</div>}
                {customer.email && <div><strong>Email:</strong> {customer.email}</div>}
              </div>
              <div>
                <div style={{ color: '#6b7280' }}>Convention: sales in Debit (+), payments in Credit (−).</div>
                <div style={{ color: '#6b7280' }}>Balance is signed: positive = customer owes you, negative = customer has paid in advance.</div>
              </div>
            </div>
          </div>

          {/* Per-modal date filter. Everything before 'From' folds into
              an Opening Balance row so the running balance stays
              truthful across window narrowing. Empty inputs = All Time. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>Statement window:</span>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>From</span>
            <input type="date" value={stmtFrom} max={stmtTo || todayIso}
              onChange={e => setStmtFrom(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }} />
            <span style={{ fontSize: 11, color: '#9ca3af' }}>To</span>
            <input type="date" value={stmtTo} min={stmtFrom || undefined} max={todayIso}
              onChange={e => setStmtTo(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }} />
            <button onClick={() => { setStmtFrom(som); setStmtTo(todayIso); }}
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>This Month</button>
            <button onClick={() => { setStmtFrom(prevSom); setStmtTo(prevEom); }}
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>Last Month</button>
            <button onClick={() => { setStmtFrom(''); setStmtTo(''); }}
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 11, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>All Time</button>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
              {stmtFrom || stmtTo ? `${stmtFrom || '—'} to ${stmtTo || '—'}` : 'Showing all time'}
            </span>
          </div>

          {/* Single chronological table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 14 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #cbd5e1' }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Date</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Doc #</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Type</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 700 }}>Reference</th>
                <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700, color: '#dc2626' }}>Debit (+)</th>
                <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700, color: '#0369a1' }}>Credit (−)</th>
                <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 700 }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {/* Opening Balance row shows the carried-over position
                  from BEFORE the window. Only rendered when the user
                  has narrowed the range. */}
              {(stmtFrom || stmtTo) && Math.abs(openingBalance) > 0.001 && (
                <tr style={{ background: '#fefce8', borderBottom: '1px solid #fde68a' }}>
                  <td colSpan={4} style={{ padding: '6px 10px', fontStyle: 'italic', color: '#a16207' }}>
                    Opening balance (carried over from before {stmtFrom || 'start'})
                  </td>
                  <td colSpan={2} style={{ padding: '6px 10px' }}></td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: balColor(openingBalance, '#374151') }}>
                    {openingBalance < 0 ? '−' : ''}{fmtAbs(openingBalance)}
                  </td>
                </tr>
              )}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#9ca3af' }}>No transactions in this window.</td></tr>
              )}
              {rows.map((r, i) => {
                const pillBg = r.kind === 'INV' ? '#fee2e2' : '#dcfce7';
                const pillFg = r.kind === 'INV' ? '#991b1b' : '#166534';
                return (
                  <tr key={r.kind + r.doc + i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '6px 10px', color: '#374151', whiteSpace: 'nowrap' }}>{formatDate(r.date)}</td>
                    {/* Doc # opens the order details whenever the row
                        is tied to a sale (INV rows, and PAY rows for
                        cash taken at the till). */}
                    <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11 }}>
                      {r.orderId && onOpenOrder ? (
                        <button
                          onClick={() => onOpenOrder(r.orderId)}
                          title="View order details"
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#2563eb', textDecoration: 'underline', fontFamily: 'monospace', fontSize: 11 }}
                        >{r.doc}</button>
                      ) : (
                        <span style={{ color: '#6b7280' }}>{r.doc}</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <span style={{ background: pillBg, color: pillFg, padding: '1px 7px', borderRadius: 3, fontSize: 10, fontWeight: 700 }}>{r.kind}</span>
                    </td>
                    <td style={{ padding: '6px 10px', color: r.kind === 'INV' ? '#111827' : '#6b7280', fontWeight: r.kind === 'INV' ? 700 : 400 }}>{r.reference || '—'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', color: r.debit > 0 ? '#dc2626' : '#d1d5db' }}>
                      {r.debit > 0 ? `+${fmtAbs(r.debit)}` : ''}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', color: r.credit === 0 ? '#d1d5db' : '#16a34a' }}>
                      {r.credit < 0 ? `−${fmtAbs(r.credit)}` : ''}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: balColor(r.balance, '#374151') }}>
                      {r.balance < 0 ? '−' : ''}{fmtAbs(r.balance)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f9fafb', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>
                <td colSpan={4} style={{ padding: '8px 10px', textAlign: 'right' }}>Totals</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: '#dc2626' }}>+{fmtAbs(totalDebit)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: '#0369a1' }}>−{fmtAbs(totalCredit)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: balColor(finalBal, '#374151') }}>
                  {finalBal < 0 ? '−' : ''}{fmtAbs(finalBal)}
                </td>
              </tr>
            </tfoot>
          </table>

          {/* Final balance banner */}
          <div style={{ background: finalBal > 0.01 ? '#fef2f2' : finalBal < -0.01 ? '#f0fdf4' : '#f9fafb',
                        border: `1px solid ${finalBal > 0.01 ? '#fecaca' : finalBal < -0.01 ? '#bbf7d0' : '#e5e7eb'}`,
                        borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{finalLabel}</span>
            <span style={{ fontWeight: 800, fontSize: 18, color: balColor(finalBal, '#374151') }}>
              {fmtAbs(finalBal)}
            </span>
          </div>

          {/* Age analysis — only when balance > 0 (customer owes) */}
          {finalBal > 0.01 && (
            <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Age analysis (as of today)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, fontSize: 12 }}>
                {ageList.map(([label, val]) => (
                  <div key={label} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 10px', textAlign: 'center', background: val > 0.01 ? '#fef2f2' : '#fff' }}>
                    <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: val > 0.01 ? '#dc2626' : '#9ca3af', fontFamily: 'monospace' }}>
                      {fmtAbs(val)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </Portal>
  );
};

export default CustomerStatementModal;
