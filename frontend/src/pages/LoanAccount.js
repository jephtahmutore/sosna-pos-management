// Loan Account — liability sub-ledger.
//
// Two views in one page:
//   1. List of loans (top): each loan agreement with derived outstanding balance
//   2. Detail (modal): the loan's full transaction history + buttons to record
//      Disbursement / Principal / Interest entries.
//
// Outflow types DO different things:
//   Principal → reduces what we owe, NOT an expense
//   Interest  → real expense, shows up on Profit Report as Interest Expense
//   Disbursement → money received from the lender, NOT income
import React, { useEffect, useMemo, useState } from 'react';
import {
  getLoans, getLoanStats, getLoan,
  createLoan, updateLoan, deleteLoan,
  createLoanTransaction, deleteLoanTransaction,
  getSettings,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiEye, FiTrendingDown, FiDollarSign } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const todayStr = new Date().toISOString().split('T')[0];

const formatDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const STATUS_STYLE = {
  Active:     { bg: '#dbeafe', color: '#1e40af', border: '#bfdbfe' },
  'Paid Off': { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  Defaulted:  { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
};

const TX_TYPE_STYLE = {
  Disbursement: { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  Principal:    { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
  Interest:     { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
};

const LoanAccount = () => {
  const { hasPermission, user } = useAuth();
  const { symbol: curSym } = useCurrency();
  // v1.10.267 — display helper for tri-currency loan amounts. Reads
  // per-currency subtotals returned by GET /api/loans (v1.10.267
  // backend) and picks the right symbol per leg. Returns "—" if all
  // zeros, single-currency ("K60,000") when one leg is populated, and
  // a middle-dot separated composite ("$5,000 · K30,000") when mixed.
  const fmtNum = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money3 = (usd, fra, k) => {
    const u = parseFloat(usd || 0) || 0;
    const f = parseFloat(fra || 0) || 0;
    const kk = parseFloat(k   || 0) || 0;
    const parts = [];
    if (u  > 0) parts.push(`$${fmtNum(u)}`);
    if (f  > 0) parts.push(`FRA ${fmtNum(f)}`);
    if (kk > 0) parts.push(`K${fmtNum(kk)}`);
    return parts.length ? parts.join(' · ') : '—';
  };
  const [stats, setStats]   = useState({ activeLoans: 0, totalDisbursed: 0, totalPrincipalPaid: 0, outstanding: 0, interestYTD: 0 });
  const [loans, setLoans]   = useState([]);
  const [toast, setToast]   = useState(null);
  const [filterStatus, setFilterStatus] = useState('All');

  // v1.10.267 — roll the per-currency subtotals from every loan row
  // into page-level tiles so Outstanding / Disbursed / Principal Repaid
  // read "K60,000" not "$60,000" for K-only tenants. Must come AFTER
  // the `loans` useState above — TDZ error otherwise (v1.10.267 crash).
  const statsByCcy = useMemo(() => {
    const zero = () => ({ usd: 0, fra: 0, k: 0 });
    const acc = { outstanding: zero(), disbursed: zero(), principalPaid: zero() };
    (loans || []).forEach(l => {
      acc.outstanding.usd    += parseFloat(l.outstanding_usd || 0) || 0;
      acc.outstanding.fra    += parseFloat(l.outstanding_fra || 0) || 0;
      acc.outstanding.k      += parseFloat(l.outstanding_k   || 0) || 0;
      acc.disbursed.usd      += parseFloat(l.disbursed_usd   || 0) || 0;
      acc.disbursed.fra      += parseFloat(l.disbursed_fra   || 0) || 0;
      acc.disbursed.k        += parseFloat(l.disbursed_k     || 0) || 0;
      acc.principalPaid.usd  += parseFloat(l.principal_paid_usd || 0) || 0;
      acc.principalPaid.fra  += parseFloat(l.principal_paid_fra || 0) || 0;
      acc.principalPaid.k    += parseFloat(l.principal_paid_k   || 0) || 0;
    });
    return acc;
  }, [loans]);

  // Loan-create / edit modal
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [editLoanId, setEditLoanId] = useState(null);
  const [savingLoan, setSavingLoan] = useState(false);
  const [loanError, setLoanError]   = useState('');
  const [loanForm, setLoanForm] = useState({
    lender_name: '', principal_amount: '', interest_rate: '',
    start_date: todayStr, maturity_date: '', status: 'Active', notes: '',
    // v1.10.270 — 'Payable' (we borrowed) or 'Receivable' (we lent out).
    // Baked in at creation and never edited afterwards — flipping direction
    // on an existing loan would reverse every past transaction's Cash Book
    // sign, so the New Loan modal is the only place this is set.
    direction: 'Payable',
    // Initial disbursement fields — only used when creating a new loan.
    // On edit the user manages transactions through the detail modal.
    // v1.10.266 — tri-currency: USD + FRA rows for pure-currency legs,
    // Cash/Bank/MoMo for the K method split. Total = USD + FRA + (K subs sum).
    disb_usd: '', disb_fra: '',
    disb_cash: '', disb_bank: '', disb_momo: '',
  });
  // v1.10.270 — direction filter tabs above the list. 'All' shows both;
  // Payable/Receivable narrows the list. Independent of Active/Paid Off
  // status filter — the two filters compose.
  const [filterDirection, setFilterDirection] = useState('All');

  // Loan detail modal (with transactions)
  const [detailLoan, setDetailLoan] = useState(null);

  // Transaction modal
  const [showTxForm, setShowTxForm] = useState(false);
  const [txType, setTxType] = useState('Disbursement');
  const [savingTx, setSavingTx] = useState(false);
  const [txError, setTxError] = useState('');
  const [txForm, setTxForm] = useState({
    date: todayStr,
    // v1.10.266 — tri-currency: USD + FRA single-currency legs, K
    // (Cash/Bank/MoMo) for the K sub-drawer split.
    usd_amount: '', fra_amount: '',
    cash_amount: '', bank_amount: '', momo_amount: '',
    description: '',
  });

  useModalScrollLock(showLoanForm || !!detailLoan || showTxForm);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchAll = async () => {
    try {
      const [listRes, statsRes] = await Promise.all([
        getLoans({ status: filterStatus !== 'All' ? filterStatus : undefined }),
        getLoanStats(),
      ]);
      setLoans(listRes.data || []);
      setStats(statsRes.data || { activeLoans: 0, totalDisbursed: 0, totalPrincipalPaid: 0, outstanding: 0, interestYTD: 0 });
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load loans.', 'error'); }
  };

  useEffect(() => { fetchAll(); }, [filterStatus]); // eslint-disable-line

  const resetLoanForm = () => {
    setLoanForm({
      lender_name: '', principal_amount: '', interest_rate: '',
      start_date: todayStr, maturity_date: '', status: 'Active', notes: '',
      direction: 'Payable',
      disb_usd: '', disb_fra: '',
      disb_cash: '', disb_bank: '', disb_momo: '',
    });
    setEditLoanId(null);
    setLoanError('');
  };

  const openNewLoan = () => { resetLoanForm(); setShowLoanForm(true); };

  const openEditLoan = (l) => {
    setEditLoanId(l.id);
    setLoanForm({
      lender_name:      l.lender_name || '',
      principal_amount: l.principal_amount > 0 ? String(l.principal_amount) : '',
      interest_rate:    l.interest_rate > 0 ? String(l.interest_rate) : '',
      start_date:       l.start_date || todayStr,
      maturity_date:    l.maturity_date || '',
      status:           l.status || 'Active',
      notes:            l.notes || '',
      direction:        l.direction || 'Payable',
      disb_usd: '', disb_fra: '',
      disb_cash: '', disb_bank: '', disb_momo: '', // not used on edit
    });
    setLoanError('');
    setShowLoanForm(true);
  };

  const saveLoan = async () => {
    setLoanError('');
    // v1.10.266 — tri-currency disbursement. K total is Cash+Bank+MoMo;
    // USD and FRA are single-currency lines. Grand total = USD + FRA + K.
    const disbUsd  = parseFloat(loanForm.disb_usd)  || 0;
    const disbFra  = parseFloat(loanForm.disb_fra)  || 0;
    const disbCash = parseFloat(loanForm.disb_cash) || 0;
    const disbBank = parseFloat(loanForm.disb_bank) || 0;
    const disbMomo = parseFloat(loanForm.disb_momo) || 0;
    const disbK    = disbCash + disbBank + disbMomo;
    const disbTotal = disbUsd + disbFra + disbK;
    // New loans: principal is derived from the disbursement total (the
    // "Principal Amount" field was removed from the New Loan modal because
    // it's always the same as what was actually received). Edit mode keeps
    // the principal field visible so users can correct historical errors.
    if (!editLoanId) {
      if (disbTotal <= 0) return setLoanError('Money Received is required — enter what the lender actually transferred.');
    } else {
      if (!(parseFloat(loanForm.principal_amount) > 0)) return setLoanError('Principal amount is required.');
    }
    setSavingLoan(true);
    try {
      const principal = editLoanId
        ? (parseFloat(loanForm.principal_amount) || 0)
        : disbTotal;
      const payload = {
        lender_name:      loanForm.lender_name.trim() || null,
        principal_amount: principal,
        interest_rate:    parseFloat(loanForm.interest_rate) || 0,
        start_date:       loanForm.start_date,
        maturity_date:    loanForm.maturity_date || null,
        status:           loanForm.status,
        notes:            loanForm.notes.trim() || null,
        // v1.10.270 — 'Payable' | 'Receivable'; ignored on edit by backend
        // (routes/loans.js PUT never reads direction — baked at create).
        direction:        loanForm.direction || 'Payable',
      };
      if (editLoanId) {
        await updateLoan(editLoanId, payload);
      } else {
        // Create the loan first, then immediately the initial Disbursement
        // transaction. If the transaction fails (network, validation, etc.)
        // soft-delete the orphan loan so the user doesn't end up with a
        // $0-outstanding ghost entry to clean up.
        const loanRes = await createLoan(payload);
        const newLoanId = loanRes?.data?.id;
        try {
          await createLoanTransaction(newLoanId, {
            type: 'Disbursement',
            date: loanForm.start_date,
            // v1.10.266 — pass all six amount fields. Backend routes/loans.js
            // stores usd/fra/k on the tri-currency columns and cash/bank/momo
            // as the K sub-method split, letting Cash Book route each leg to
            // the right tile.
            usd_amount:  disbUsd,
            fra_amount:  disbFra,
            k_amount:    disbK,
            cash_amount: disbCash,
            bank_amount: disbBank,
            momo_amount: disbMomo,
            description: 'Initial disbursement',
          });
        } catch (txErr) {
          if (newLoanId) await deleteLoan(newLoanId).catch(() => {});
          throw txErr;
        }
      }
      setShowLoanForm(false);
      resetLoanForm();
      await fetchAll();
      showToast(editLoanId ? 'Loan updated.' : 'Loan created and disbursement recorded.');
    } catch (e) { setLoanError(e.response?.data?.error || 'Save failed.'); }
    finally { setSavingLoan(false); }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeleteLoan = (l) => {
    setPendingDelete({
      subject: `Loan ${l.loan_number} — all transactions will be soft-deleted too`,
      perform: async () => {
        try {
          await deleteLoan(l.id);
          setDetailLoan(null);
          await fetchAll();
          showToast('Loan deleted.', 'error');
        } catch (e) { showToast(e.response?.data?.error || 'Delete failed.', 'error'); }
      },
    });
  };

  const openDetail = async (l) => {
    try {
      const res = await getLoan(l.id);
      setDetailLoan(res.data);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load.', 'error'); }
  };

  const openTxForm = (type) => {
    setTxType(type);
    setTxForm({ date: todayStr, cash_amount: '', bank_amount: '', momo_amount: '', description: '' });
    setTxError('');
    setShowTxForm(true);
  };

  const saveTx = async () => {
    setTxError('');
    // v1.10.266 — tri-currency transaction. Total = USD + FRA + K subs sum.
    const usd  = parseFloat(txForm.usd_amount)  || 0;
    const fra  = parseFloat(txForm.fra_amount)  || 0;
    const cash = parseFloat(txForm.cash_amount) || 0;
    const bank = parseFloat(txForm.bank_amount) || 0;
    const momo = parseFloat(txForm.momo_amount) || 0;
    const kAmt = cash + bank + momo;
    if (usd + fra + kAmt <= 0) return setTxError('Total must be greater than 0.');
    setSavingTx(true);
    try {
      const payload = {
        type: txType,
        date: txForm.date,
        usd_amount:  usd,
        fra_amount:  fra,
        k_amount:    kAmt,
        cash_amount: cash, bank_amount: bank, momo_amount: momo,
        description: txForm.description.trim() || null,
      };
      await createLoanTransaction(detailLoan.id, payload);
      setShowTxForm(false);
      const refreshed = await getLoan(detailLoan.id);
      setDetailLoan(refreshed.data);
      await fetchAll();
      showToast(`${txType} recorded.`);
    } catch (e) { setTxError(e.response?.data?.error || 'Save failed.'); }
    finally { setSavingTx(false); }
  };

  const handleDeleteTx = (tx) => {
    setPendingDelete({
      subject: `Loan transaction ${tx.transaction_number} (${tx.type})`,
      perform: async () => {
        try {
          await deleteLoanTransaction(detailLoan.id, tx.id);
          const refreshed = await getLoan(detailLoan.id);
          setDetailLoan(refreshed.data);
          await fetchAll();
          showToast('Transaction deleted.', 'error');
        } catch (e) { showToast(e.response?.data?.error || 'Delete failed.', 'error'); }
      },
    });
  };

  // v1.10.281 — Administrator always passes the edit/delete gates.
  // Matches how most other pages treat Admin (implicit-all-perms), and
  // fixes the "delete button hidden" report where an Admin without the
  // explicit LoanAccount:Delete checkbox couldn't remove a loan or a
  // transaction. Non-Admins still need the explicit permissions.
  const isAdmin = user?.role === 'Administrator';
  const canEdit = isAdmin || hasPermission('LoanAccount:Add') || hasPermission('LoanAccount:Edit');
  const canDelete = isAdmin || hasPermission('LoanAccount:Delete');

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Loan Account</h1>
          <p>Liability ledger — loans received from third parties. Interest payments hit Profit Report; principal repayments don't.</p>
        </div>
        {hasPermission('LoanAccount:Add') && (
          <button className="btn btn-primary" onClick={openNewLoan}><FiPlus /> New Loan</button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#dc2626,#991b1b)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Outstanding</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, lineHeight: 1.25 }}>{money3(statsByCcy.outstanding.usd, statsByCcy.outstanding.fra, statsByCcy.outstanding.k)}</div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{stats.activeLoans} active loan{stats.activeLoans !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#16a34a,#15803d)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Total Disbursed</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, lineHeight: 1.25 }}>{money3(statsByCcy.disbursed.usd, statsByCcy.disbursed.fra, statsByCcy.disbursed.k)}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#1e40af,#1e3a8a)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Principal Repaid</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, lineHeight: 1.25 }}>{money3(statsByCcy.principalPaid.usd, statsByCcy.principalPaid.fra, statsByCcy.principalPaid.k)}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#f59e0b,#b45309)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Interest Paid YTD</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.interestYTD).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>real expense on Profit Report</div>
        </div>
      </div>

      {/* v1.10.270 — direction tabs: quick visual split between money we
          borrowed and money we lent out. Composes with the status filter. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, padding: 4, background: '#f3f4f6', borderRadius: 10 }}>
        {[
          { key: 'All',        label: 'All Loans',        color: '#6b7280' },
          { key: 'Payable',    label: 'Money We Borrowed', color: '#dc2626' },
          { key: 'Receivable', label: 'Money We Lent Out', color: '#16a34a' },
        ].map(t => {
          const active = filterDirection === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setFilterDirection(t.key)}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: active ? t.color : 'transparent',
                color: active ? '#fff' : '#374151',
                fontWeight: 700, fontSize: 13, transition: 'background 0.15s',
              }}
            >{t.label}</button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, padding: 12, background: '#f9fafb', borderRadius: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Status:</span>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' }}>
          <option value="All">All</option>
          <option value="Active">Active</option>
          <option value="Paid Off">Paid Off</option>
          <option value="Defaulted">Defaulted</option>
        </select>
      </div>

      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>LOAN #</th>
              <th>PARTY</th>
              <th>DIRECTION</th>
              <th>START</th>
              <th style={{ textAlign: 'right' }}>PRINCIPAL</th>
              <th style={{ textAlign: 'right' }}>OUTSTANDING</th>
              <th style={{ textAlign: 'right' }}>INTEREST RATE</th>
              <th>STATUS</th>
              <th style={{ textAlign: 'center' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const shown = (loans || []).filter(l => {
                if (filterDirection === 'All') return true;
                return (l.direction || 'Payable') === filterDirection;
              });
              if (shown.length === 0) return (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No loans recorded.</td></tr>
              );
              return shown.map(l => {
                const ss = STATUS_STYLE[l.status] || STATUS_STYLE.Active;
                const isRec = (l.direction || 'Payable') === 'Receivable';
                const dirChip = isRec
                  ? { bg: '#dcfce7', color: '#166534', border: '#86efac', label: 'THEY OWE US' }
                  : { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5', label: 'WE OWE' };
                // v1.10.270 — Outstanding color: red for Payable (bad, we owe),
                // blue for Receivable (asset, they owe us, positive).
                const outstColor = l.outstanding > 0
                  ? (isRec ? '#1e40af' : '#dc2626')
                  : '#16a34a';
                return (
                  <tr key={l.id}>
                    <td style={{ fontWeight: 600 }}>{l.loan_number}</td>
                    <td>{l.lender_name || '—'}</td>
                    <td><span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: dirChip.bg, color: dirChip.color, border: `1px solid ${dirChip.border}`, whiteSpace: 'nowrap' }}>{dirChip.label}</span></td>
                    <td>{formatDate(l.start_date)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12 }}>{money3(l.disbursed_usd, l.disbursed_fra, l.disbursed_k)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: outstColor, whiteSpace: 'nowrap', fontSize: 12 }}>{money3(l.outstanding_usd, l.outstanding_fra, l.outstanding_k)}</td>
                    <td style={{ textAlign: 'right' }}>{l.interest_rate > 0 ? `${l.interest_rate}%` : '—'}</td>
                    <td><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: ss.bg, color: ss.color, border: `1px solid ${ss.border}` }}>{l.status}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      <button onClick={() => openDetail(l)} title="View / Record transaction" style={{ background: 'none', border: 'none', color: '#0369a1', cursor: 'pointer', padding: 4 }}><FiEye /></button>
                      {canEdit && <button onClick={() => openEditLoan(l)} title="Edit loan" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4 }}><FiEdit2 /></button>}
                      {canDelete && <button onClick={() => handleDeleteLoan(l)} title="Delete" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}><FiTrash2 /></button>}
                    </td>
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>
      </div>

      {/* ── Loan create/edit modal ─────────────────────────────────────── */}
      {showLoanForm && (
        <Portal>
          <div className="modal-overlay" onClick={() => setShowLoanForm(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{editLoanId ? 'Edit Loan' : 'New Loan Agreement'}</h3>
                <button className="modal-close" onClick={() => setShowLoanForm(false)}>×</button>
              </div>
              <div className="modal-body">
                {loanError && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{loanError}</div>}
                {/* v1.10.270 — direction picker. Hidden on edit because
                    flipping direction after transactions exist would
                    reverse every past Cash Book entry. Baked at create. */}
                {!editLoanId && (
                  <div style={{ display: 'flex', gap: 10, marginBottom: 14, padding: 4, background: '#f3f4f6', borderRadius: 10 }}>
                    {[
                      { key: 'Payable',    label: 'Money We Borrowed',  hint: 'They gave us money — we owe them.', bg: '#fee2e2', activeBg: '#dc2626' },
                      { key: 'Receivable', label: 'Money We Lent Out',  hint: 'We gave them money — they owe us.', bg: '#dcfce7', activeBg: '#16a34a' },
                    ].map(d => {
                      const active = loanForm.direction === d.key;
                      return (
                        <button
                          key={d.key}
                          type="button"
                          onClick={() => setLoanForm({ ...loanForm, direction: d.key })}
                          style={{
                            flex: 1, padding: '12px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                            background: active ? d.activeBg : '#fff',
                            color: active ? '#fff' : '#374151',
                            fontWeight: 700, textAlign: 'left', transition: 'background 0.15s',
                          }}
                        >
                          <div style={{ fontSize: 13 }}>{d.label}</div>
                          <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.85, marginTop: 3 }}>{d.hint}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label>{loanForm.direction === 'Receivable' ? 'Borrower' : 'Lender'}</label>
                    <input value={loanForm.lender_name} onChange={e => setLoanForm({ ...loanForm, lender_name: e.target.value })} placeholder={loanForm.direction === 'Receivable' ? 'e.g. Ibrahim Ali / Staff advance' : "e.g. FNB Bank / Sirak's brother"} />
                  </div>
                  <div className="form-group">
                    <label>Status</label>
                    <select value={loanForm.status} onChange={e => setLoanForm({ ...loanForm, status: e.target.value })}>
                      <option value="Active">Active</option>
                      <option value="Paid Off">Paid Off</option>
                      <option value="Defaulted">Defaulted</option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  {/* Principal Amount shown only on edit. On new loans it's
                      derived from the Money Received total below — same value,
                      no need to type it twice. */}
                  {editLoanId ? (
                    <>
                      <div className="form-group">
                        <label>Principal Amount ({curSym}) *</label>
                        <input type="number" min="0" step="0.01" value={loanForm.principal_amount} onChange={e => setLoanForm({ ...loanForm, principal_amount: e.target.value })} placeholder="0.00" />
                      </div>
                      <div className="form-group">
                        <label>Interest Rate (% per year)</label>
                        <input type="number" min="0" step="0.01" value={loanForm.interest_rate} onChange={e => setLoanForm({ ...loanForm, interest_rate: e.target.value })} placeholder="0" />
                      </div>
                    </>
                  ) : (
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>Interest Rate (% per year)</label>
                      <input type="number" min="0" step="0.01" value={loanForm.interest_rate} onChange={e => setLoanForm({ ...loanForm, interest_rate: e.target.value })} placeholder="0" />
                    </div>
                  )}
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Start Date</label>
                    <input type="date" value={loanForm.start_date} onChange={e => setLoanForm({ ...loanForm, start_date: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Maturity Date</label>
                    <input type="date" value={loanForm.maturity_date} onChange={e => setLoanForm({ ...loanForm, maturity_date: e.target.value })} />
                  </div>
                </div>
                <div className="form-group">
                  <label>Notes</label>
                  <input value={loanForm.notes} onChange={e => setLoanForm({ ...loanForm, notes: e.target.value })} placeholder="optional" />
                </div>

                {!editLoanId && (
                  <>
                    {/* v1.10.266 — tri-currency Money Received. USD + FRA are
                        single-line entries; K has its own 3-method split
                        (Cash/Bank/MoMo). Total = USD + FRA + K subs sum. */}
                    <div className="form-group" style={{ marginTop: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                        Money Received *
                      </label>
                      {/* USD + FRA rows (single-currency legs) */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                        {[
                          { key: 'disb_usd', label: 'USD ($)', color: '#16a34a' },
                          { key: 'disb_fra', label: 'FRA',     color: '#7c3aed' },
                        ].map(f => (
                          <div key={f.key}>
                            <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                            <input type="number" min="0" step="0.01"
                              value={loanForm[f.key]}
                              onChange={e => setLoanForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                              placeholder="0.00"
                              style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(loanForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(loanForm[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                          </div>
                        ))}
                      </div>
                      {/* K row (Cash + Bank + MoMo split) */}
                      <label style={{ fontSize: 11, color: '#ea580c', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>K (split across sub-drawers)</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                        {[
                          { key: 'disb_cash', label: 'Cash', color: '#16a34a' },
                          { key: 'disb_bank', label: 'Bank', color: '#2563eb' },
                          { key: 'disb_momo', label: 'MoMo', color: '#f59e0b' },
                        ].map(f => (
                          <div key={f.key}>
                            <label style={{ fontSize: 10, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 2, display: 'block' }}>{f.label}</label>
                            <input type="number" min="0" step="0.01"
                              value={loanForm[f.key]}
                              onChange={e => setLoanForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                              placeholder="0.00"
                              style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(loanForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(loanForm[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                          </div>
                        ))}
                      </div>
                      {/* Per-currency subtotals + grand total */}
                      <div style={{ padding: '8px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {parseFloat(loanForm.disb_usd || 0) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>USD</span><span style={{ fontWeight: 700, color: '#16a34a' }}>${parseFloat(loanForm.disb_usd || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>}
                        {parseFloat(loanForm.disb_fra || 0) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>FRA</span><span style={{ fontWeight: 700, color: '#7c3aed' }}>{parseFloat(loanForm.disb_fra || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>}
                        {(parseFloat(loanForm.disb_cash || 0) + parseFloat(loanForm.disb_bank || 0) + parseFloat(loanForm.disb_momo || 0)) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>K (Cash+Bank+MoMo)</span><span style={{ fontWeight: 700, color: '#ea580c' }}>K{(parseFloat(loanForm.disb_cash || 0) + parseFloat(loanForm.disb_bank || 0) + parseFloat(loanForm.disb_momo || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>}
                      </div>
                    </div>
                    <div style={{ background: '#dcfce7', border: '1px solid #86efac', padding: 10, borderRadius: 8, fontSize: 12, color: '#166534' }}>
                      💡 Recorded as the initial Disbursement on the loan's start date. Each currency leg lands in its own Cash Book tile. Add more disbursements later via + Disbursement on the loan detail.
                    </div>
                  </>
                )}
                {editLoanId && (
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', padding: 10, borderRadius: 8, fontSize: 12, color: '#1e40af' }}>
                    ℹ️ You're editing the loan agreement. To change a specific disbursement, principal, or interest transaction, open the loan detail and edit/delete the transaction directly.
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowLoanForm(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveLoan} disabled={savingLoan}>{savingLoan ? 'Saving...' : editLoanId ? 'Update' : 'Save'}</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* ── Loan detail modal (transactions list + add buttons) ──────────── */}
      {detailLoan && (
        <Portal>
          <div className="modal-overlay" onClick={() => setDetailLoan(null)}>
            <div className="modal" style={{ maxWidth: 820 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span>{detailLoan.loan_number} — {detailLoan.lender_name || ((detailLoan.direction || 'Payable') === 'Receivable' ? 'Borrower' : 'Lender')}</span>
                  {(() => {
                    const isRec = (detailLoan.direction || 'Payable') === 'Receivable';
                    const chip = isRec
                      ? { bg: '#dcfce7', color: '#166534', border: '#86efac', label: 'THEY OWE US' }
                      : { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5', label: 'WE OWE' };
                    return <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: chip.bg, color: chip.color, border: `1px solid ${chip.border}` }}>{chip.label}</span>;
                  })()}
                </h3>
                <button className="modal-close" onClick={() => setDetailLoan(null)}>×</button>
              </div>
              <div className="modal-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
                  <div><div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Principal</div><div style={{ fontWeight: 700, marginTop: 3 }}>{money3(detailLoan.disbursed_usd, detailLoan.disbursed_fra, detailLoan.disbursed_k)}</div></div>
                  <div><div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Outstanding</div><div style={{ fontWeight: 700, marginTop: 3, color: detailLoan.outstanding > 0 ? '#dc2626' : '#16a34a' }}>{money3(detailLoan.outstanding_usd, detailLoan.outstanding_fra, detailLoan.outstanding_k)}</div></div>
                  <div><div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Interest Rate</div><div style={{ fontWeight: 700, marginTop: 3 }}>{detailLoan.interest_rate > 0 ? `${detailLoan.interest_rate}%` : '—'}</div></div>
                </div>

                {hasPermission('LoanAccount:Add') && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 14, padding: 10, background: '#f9fafb', borderRadius: 8 }}>
                    {/* v1.10.270 — button labels swap for Receivable so the
                        user sees plain-English direction, not accounting jargon. */}
                    {(detailLoan.direction || 'Payable') === 'Receivable' ? (
                      <>
                        <button className="btn btn-primary" style={{ background: '#dc2626' }} onClick={() => openTxForm('Disbursement')}>+ Money Given</button>
                        <button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={() => openTxForm('Principal')}>+ They Paid Back</button>
                        <button className="btn btn-primary" style={{ background: '#f59e0b' }} onClick={() => openTxForm('Interest')}>+ Interest Received</button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={() => openTxForm('Disbursement')}>+ Money Received</button>
                        <button className="btn btn-primary" style={{ background: '#dc2626' }} onClick={() => openTxForm('Principal')}>+ We Paid Back</button>
                        <button className="btn btn-primary" style={{ background: '#f59e0b' }} onClick={() => openTxForm('Interest')}>+ Interest Paid</button>
                      </>
                    )}
                  </div>
                )}

                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: '#f9fafb' }}>
                      <tr>
                        <th style={{ padding: '8px 10px', textAlign: 'left' }}>TXN #</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left' }}>DATE</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left' }}>TYPE</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>AMOUNT</th>
                        <th style={{ padding: '8px 10px' }}>NOTE</th>
                        {canDelete && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {(detailLoan.transactions || []).length === 0 ? (
                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>No transactions yet. Click + Disbursement to record the loan being received.</td></tr>
                      ) : detailLoan.transactions.map(tx => {
                        const ts = TX_TYPE_STYLE[tx.type] || TX_TYPE_STYLE.Disbursement;
                        // v1.10.270 — sign shows real drawer direction.
                        // Payable: Disbursement=+ (money in), Principal/Interest=− (paid out).
                        // Receivable: flipped — Disbursement=− (we gave), Principal/Interest=+ (they paid us).
                        const isRecTx = (detailLoan.direction || 'Payable') === 'Receivable';
                        const isInflow = isRecTx ? tx.type !== 'Disbursement' : tx.type === 'Disbursement';
                        const sign = isInflow ? '+' : '−';
                        const color = isInflow ? '#16a34a' : (tx.type === 'Interest' ? '#92400e' : '#dc2626');
                        return (
                          <tr key={tx.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '8px 10px', fontWeight: 600 }}>{tx.transaction_number}</td>
                            <td style={{ padding: '8px 10px' }}>{formatDate(tx.date)}</td>
                            <td style={{ padding: '8px 10px' }}><span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700, background: ts.bg, color: ts.color, border: `1px solid ${ts.border}` }}>{tx.type}</span></td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color, whiteSpace: 'nowrap' }}>{sign}{money3(tx.usd_amount, tx.fra_amount, tx.k_amount)}</td>
                            <td style={{ padding: '8px 10px', color: '#6b7280' }}>{tx.description || '—'}</td>
                            {canDelete && (
                              <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                                <button onClick={() => handleDeleteTx(tx)} title="Delete" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}><FiTrash2 size={14} /></button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setDetailLoan(null)}>Close</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* ── Transaction modal ─────────────────────────────────────────────── */}
      {showTxForm && detailLoan && (
        <Portal>
          <div className="modal-overlay" onClick={() => setShowTxForm(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Record {txType} — {detailLoan.loan_number}</h3>
                <button className="modal-close" onClick={() => setShowTxForm(false)}>×</button>
              </div>
              <div className="modal-body">
                {txError && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{txError}</div>}

                <div style={{ padding: '10px 12px', background: txType === 'Interest' ? '#fef3c7' : (txType === 'Disbursement' ? '#dcfce7' : '#fee2e2'), borderRadius: 8, marginBottom: 14, fontSize: 12 }}>
                  {/* v1.10.270 — explainer wording flips for Receivable. */}
                  {(detailLoan?.direction || 'Payable') === 'Receivable' ? (
                    <>
                      {txType === 'Disbursement' && <>💸 <strong>Money Given</strong> = we handed over the loan. Cash OUT of our drawer. Outstanding balance goes UP (they owe us more).</>}
                      {txType === 'Principal'    && <>💰 <strong>They Paid Back</strong> = borrower returning what they owed. Cash IN. Outstanding balance goes DOWN.</>}
                      {txType === 'Interest'     && <>📈 <strong>Interest Received</strong> = the borrower paying interest. Cash IN. Real income on the Profit Report. Outstanding balance unchanged.</>}
                    </>
                  ) : (
                    <>
                      {txType === 'Disbursement' && <>💰 <strong>Disbursement</strong> = money received from the lender. Cash IN. Loan balance goes UP. Not income.</>}
                      {txType === 'Principal'    && <>↩ <strong>Principal Payment</strong> = paying back what you borrowed. Cash OUT. Loan balance goes DOWN. Not an expense.</>}
                      {txType === 'Interest'     && <>💸 <strong>Interest Payment</strong> = the cost of borrowing. Cash OUT. Real expense on the Profit Report. Loan balance unchanged.</>}
                    </>
                  )}
                </div>

                <div className="form-group">
                  <label>Date</label>
                  <input type="date" value={txForm.date} onChange={e => setTxForm({ ...txForm, date: e.target.value })} />
                </div>

                {/* v1.10.266 — tri-currency Amount. USD + FRA single rows,
                    K with 3-method split. Grand total = USD + FRA + K subs. */}
                <div className="form-group">
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Amount</label>
                  {/* USD + FRA rows */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    {[
                      { key: 'usd_amount', label: 'USD ($)', color: '#16a34a' },
                      { key: 'fra_amount', label: 'FRA',     color: '#7c3aed' },
                    ].map(f => (
                      <div key={f.key}>
                        <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                        <input type="number" min="0" step="0.01" value={txForm[f.key]}
                          onChange={e => setTxForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder="0.00"
                          style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(txForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, boxSizing: 'border-box' }} />
                      </div>
                    ))}
                  </div>
                  {/* K row (Cash + Bank + MoMo split) */}
                  <label style={{ fontSize: 11, color: '#ea580c', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>K (split across sub-drawers)</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                    {[
                      { key: 'cash_amount', label: 'Cash', color: '#16a34a' },
                      { key: 'bank_amount', label: 'Bank', color: '#2563eb' },
                      { key: 'momo_amount', label: 'MoMo', color: '#f59e0b' },
                    ].map(f => (
                      <div key={f.key}>
                        <label style={{ fontSize: 10, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 2, display: 'block' }}>{f.label}</label>
                        <input type="number" min="0" step="0.01" value={txForm[f.key]}
                          onChange={e => setTxForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder="0.00"
                          style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(txForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, boxSizing: 'border-box' }} />
                      </div>
                    ))}
                  </div>
                  {/* Per-currency subtotals */}
                  <div style={{ padding: '8px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {parseFloat(txForm.usd_amount || 0) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>USD</span><span style={{ fontWeight: 700, color: '#16a34a' }}>${parseFloat(txForm.usd_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>}
                    {parseFloat(txForm.fra_amount || 0) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>FRA</span><span style={{ fontWeight: 700, color: '#7c3aed' }}>{parseFloat(txForm.fra_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>}
                    {(parseFloat(txForm.cash_amount || 0) + parseFloat(txForm.bank_amount || 0) + parseFloat(txForm.momo_amount || 0)) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>K (Cash+Bank+MoMo)</span><span style={{ fontWeight: 700, color: '#ea580c' }}>K{(parseFloat(txForm.cash_amount || 0) + parseFloat(txForm.bank_amount || 0) + parseFloat(txForm.momo_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>}
                  </div>
                </div>

                <div className="form-group">
                  <label>Note</label>
                  <input value={txForm.description} onChange={e => setTxForm({ ...txForm, description: e.target.value })} placeholder="optional" />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowTxForm(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveTx} disabled={savingTx}>{savingTx ? 'Saving...' : 'Record'}</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default LoanAccount;
