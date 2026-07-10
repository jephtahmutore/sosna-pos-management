// HQ Deposits — Branch → HQ cash deposit workflow.
//
// One screen, two behaviours by host:
//   - Branch (kassumbalesa1, ...): "Send Deposit" button + own outgoing
//     deposits history. Each row shows status (PENDING / CONFIRMED /
//     REJECTED).
//   - HQ (sosnazm bare):          incoming inbox from every branch with
//     Confirm / Reject actions on PENDING rows.
//
// Cash movement is NOT income/expense — the cash physically moves from
// one drawer to another. No payment_voucher / cash_receipt is written
// on confirm; the per-currency Cash Report aggregation reads cash_deposits
// directly so drawer Expected reflects today's outflow / inflow without
// hitting profit.
import React, { useEffect, useState, useRef } from 'react';
import {
  FiSend, FiCheck, FiX, FiRefreshCw, FiInbox, FiArrowUpRight, FiArrowDownLeft, FiTrash2, FiEdit2,
  FiPaperclip, FiCamera, FiUpload, FiEye, FiFileText, FiImage,
} from 'react-icons/fi';
import {
  getCashDeposits, createCashDeposit, confirmCashDeposit, rejectCashDeposit, deleteCashDeposit,
  editCashDepositDate, editCashDeposit,
  uploadInvoiceAttachment,
  isHqHost, getBranchSlug,
} from '../services/api';
import { useCurrency } from '../context/CurrencyContext';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const todayStr = () => new Date().toISOString().slice(0, 10);

// v1.8.61 — parse attachment column (string or JSON-array string) into
// an array of paths. Tolerates legacy single-string entries.
const parseAttachments = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch { /* fall through */ }
  }
  return [s]; // legacy single-path
};

const HQDeposits = () => {
  const { symbol: curSym, currencyMode, isLiquorStyle } = useCurrency();
  const onHq = isHqHost();
  const isDual = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const hasK   = currencyMode === 'USD+FRA+K';
  // v1.10.29 — currencies this branch can actually deposit. K-only
  // (Liquor-style) branches must NOT be able to select USD/FRA — those
  // drawers don't exist here. Order = display order in the dropdown.
  const depositCcyOptions = currencyMode === 'K'
    ? [{ value: 'K',   label: 'K (Kwacha)' }]
    : currencyMode === 'USD+FRA'
    ? [{ value: 'USD', label: 'USD ($)' }, { value: 'FRA', label: 'FRA' }]
    : currencyMode === 'USD+FRA+K'
    ? [{ value: 'USD', label: 'USD ($)' }, { value: 'FRA', label: 'FRA' }, { value: 'K', label: 'K (Kwacha)' }]
    : [{ value: 'USD', label: 'USD ($)' }];
  const defaultDepositCcy = depositCcyOptions[0].value;

  const [deposits, setDeposits] = useState([]);
  const [loading, setLoading]   = useState(false);

  // Send Deposit modal (branch only)
  const [showSend, setShowSend] = useState(false);
  const [sendForm, setSendForm] = useState({ currency: defaultDepositCcy, amount: '', from_method: 'Cash', notes: '', deposit_date: todayStr(), attachments: [] });
  const [sending, setSending]   = useState(false);
  const [sendError, setSendError] = useState('');
  // v1.8.61 — multi-file upload state for the deposit slips.
  const fileInputRef = useRef(null);
  const camInputRef  = useRef(null);
  const [uploadingAtt, setUploadingAtt] = useState(false);
  const [attError, setAttError] = useState('');

  // Reject reason modal (HQ only)
  const [rejectingId, setRejectingId]   = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  // v1.10.83 — admin-password gate when confirming with a changed date.
  // Non-null value = the AdminPasswordPrompt is open; { deposit, newDate }
  // are the details we'll POST once the password check passes.
  const [pendingDateChange, setPendingDateChange] = useState(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('ALL');

  useModalScrollLock(showSend || !!rejectingId);

  const fetchDeposits = async () => {
    setLoading(true);
    try {
      const params = {};
      if (!onHq) {
        const slug = getBranchSlug() || (window.location.hostname.split('.')[0] || '');
        if (slug) params.from_slug = slug;
      }
      if (statusFilter !== 'ALL') params.status = statusFilter;
      const r = await getCashDeposits(params);
      setDeposits(Array.isArray(r.data) ? r.data : []);
    } catch (_) { /* leave list as-is */ }
    setLoading(false);
  };

  useEffect(() => { fetchDeposits(); /* eslint-disable-next-line */ }, [statusFilter]);

  const openSendModal = () => {
    setSendError('');
    setAttError('');
    setSendForm({ currency: defaultDepositCcy, amount: '', from_method: 'Cash', notes: '', deposit_date: todayStr(), attachments: [] });
    setShowSend(true);
  };

  // v1.8.61 — upload one or more files (file picker is multi-select).
  const handleFilesPicked = async (filesList) => {
    if (!filesList || filesList.length === 0) return;
    setAttError('');
    setUploadingAtt(true);
    const newPaths = [];
    try {
      for (const f of Array.from(filesList)) {
        const res = await uploadInvoiceAttachment(f, 'deposit');
        if (res?.data?.path) newPaths.push(res.data.path);
      }
      setSendForm(f => ({ ...f, attachments: [...(f.attachments || []), ...newPaths] }));
    } catch (e) {
      const status = e.response?.status;
      const reason = e.response?.data?.error
        || (status === 413 ? 'File too large (max 10 MB)'
        :   status === 400 ? 'Invalid file type (PDF or image only)'
        :   `Upload failed${status ? ` (${status})` : ''}`);
      setAttError(reason);
    }
    setUploadingAtt(false);
  };

  const removeAttachment = (idx) => {
    setSendForm(f => ({ ...f, attachments: (f.attachments || []).filter((_, i) => i !== idx) }));
  };

  const handleSend = async () => {
    setSendError('');
    const amt = parseFloat(sendForm.amount || 0);
    if (!(amt > 0)) { setSendError('Amount must be > 0'); return; }
    const slug = getBranchSlug() || (window.location.hostname.split('.')[0] || '');
    if (!slug) { setSendError('Branch not detected — cannot send deposit'); return; }
    setSending(true);
    try {
      // Multi-attachment serialised as JSON array. Backend stores the
      // string verbatim in the legacy `attachment` column — parseAttachments()
      // on read tolerates both shapes (single string or JSON array).
      const atts = sendForm.attachments || [];
      const attachmentPayload = atts.length === 0 ? null
        : atts.length === 1 ? atts[0]
        : JSON.stringify(atts);
      await createCashDeposit({
        from_slug:    slug,
        currency:     sendForm.currency,
        amount:       amt,
        // v1.10.48 — send `from_method` only on Liquor branches so backend
        // tags the deposit to the physical drawer (Cash/MoMo/Bank). Sosna
        // omits it → stored as NULL → doesn't affect the per-currency
        // deposit split logic.
        ...(isLiquorStyle ? { from_method: sendForm.from_method } : {}),
        notes:        sendForm.notes || null,
        deposit_date: sendForm.deposit_date,
        attachment:   attachmentPayload,
      });
      setShowSend(false);
      await fetchDeposits();
    } catch (err) {
      setSendError(err?.response?.data?.error || 'Failed to send deposit');
    }
    setSending(false);
  };

  // v1.10.134 — normalize a free-text method entry into the canonical form
  // the backend accepts ('Cash', 'Bank', 'Mobile Money'). Returns null when
  // the input doesn't match any known method.
  const normalizeToMethod = (raw) => {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    if (s === 'cash' || s === 'c') return 'Cash';
    if (s === 'bank' || s === 'b') return 'Bank';
    if (s === 'momo' || s === 'mobile money' || s === 'mobile' || s === 'm') return 'Mobile Money';
    return null;
  };

  // v1.10.134 — prompt for the HQ drawer this K deposit lands in. Only
  // asked for K currency; USD/FRA deposits don't need it. Defaults to the
  // branch-side from_method (Bank branch → Bank HQ, etc.).
  const askToMethod = (d) => {
    if (String(d.currency || '').toUpperCase() !== 'K') return null;
    const defaultMethod = d.from_method && ['Cash','Bank','Mobile Money'].includes(d.from_method)
      ? d.from_method
      : 'Bank';
    const raw = window.prompt(
      `Which HQ drawer receives this K${d.amount ? ' ' + d.amount.toLocaleString() : ''} deposit?\n\n` +
      `Type: Cash · Bank · MoMo\n` +
      `(Default = ${defaultMethod})`,
      defaultMethod
    );
    if (raw === null) return 'CANCELLED';
    const normalized = normalizeToMethod(raw);
    if (!normalized) {
      alert('Method must be Cash, Bank, or MoMo.');
      return 'INVALID';
    }
    return normalized;
  };

  const handleConfirm = async (d) => {
    // v1.10.82 — HQ operator can override the deposit_date at confirm
    // time (e.g. cash arrived last week but they're only clicking
    // confirm now). Blank = keep the branch's original date.
    const currentDate = d.deposit_date || new Date().toISOString().slice(0, 10);
    const input = window.prompt(
      `Confirm deposit ${d.deposit_number}?\n\n` +
      `Effective date (YYYY-MM-DD). Cash Book will show it under this date.\n` +
      `Leave as-is to keep the branch's original date.`,
      currentDate
    );
    if (input === null) return; // user cancelled
    const trimmed = String(input).trim();
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    if (trimmed && !dateOk) { alert('Date must be YYYY-MM-DD.'); return; }

    // v1.10.134 — for K deposits, also ask which HQ drawer receives it.
    const toMethod = askToMethod(d);
    if (toMethod === 'CANCELLED' || toMethod === 'INVALID') return;

    // v1.10.83 — moving a deposit to a different accounting date shifts
    // where it lands in the Cash Book. That's a sensitive edit, so it
    // needs admin authorization. Unchanged date = fast-path, no prompt.
    if (dateOk && trimmed !== d.deposit_date) {
      setPendingDateChange({ deposit: d, newDate: trimmed, mode: 'confirm', toMethod });
      return;
    }

    try {
      await confirmCashDeposit(d.id, toMethod ? { to_method: toMethod } : undefined);
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to confirm deposit');
    }
  };

  // v1.10.84 — edit accounting date of an already-CONFIRMED deposit.
  // Same UX as handleConfirm's date-change path: prompt for a new date,
  // then require admin password before writing. Backend uses PUT /date
  // (not /confirm) because the row is already CONFIRMED.
  // v1.10.168 — replaced the date-only prompt with a full Edit modal
  // (see handleEditDeposit below).
  const handleEditDate = (d) => handleEditDeposit(d);

  // v1.10.168 — full CONFIRMED-only edit flow. Opens the Edit Deposit
  // modal → user changes date / amount / from_method / notes → Reason
  // (mandatory) → AdminPasswordPrompt → PUT /:id/edit. Both HQ Cash Book
  // and the branch Cash Book reflect the corrected values on next refresh.
  const [editRow, setEditRow]         = useState(null);
  const [editStep, setEditStep]       = useState(null); // null | 'form' | 'password'
  const [editForm, setEditForm]       = useState({ deposit_date: '', amount: '', from_method: '', notes: '' });
  const [editReason, setEditReason]   = useState('');
  const [editBusy, setEditBusy]       = useState(false);
  const [editError, setEditError]     = useState('');
  const handleEditDeposit = (d) => {
    if (d.status !== 'CONFIRMED') return;
    setEditRow(d);
    setEditForm({
      deposit_date: d.deposit_date || (d.created_at || '').slice(0, 10),
      amount:       String(parseFloat(d.amount) || 0),
      from_method:  d.from_method || '',
      notes:        d.notes || '',
    });
    setEditReason('');
    setEditError('');
    setEditStep('form');
  };

  // v1.10.83 — runs after admin authorises the date change. In 'confirm'
  // mode we flip PENDING → CONFIRMED with the new date; in 'edit' mode
  // the row is already CONFIRMED, we just move its date.
  const finishConfirmWithDate = async () => {
    if (!pendingDateChange) return;
    const { deposit, newDate, mode, toMethod } = pendingDateChange;
    setPendingDateChange(null);
    try {
      if (mode === 'edit') {
        await editCashDepositDate(deposit.id, newDate);
      } else {
        // v1.10.134 — include to_method in the delayed-confirm payload too.
        const payload = { deposit_date: newDate };
        if (toMethod) payload.to_method = toMethod;
        await confirmCashDeposit(deposit.id, payload);
      }
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || (mode === 'edit' ? 'Failed to edit deposit date' : 'Failed to confirm deposit'));
    }
  };

  const handleReject = async () => {
    if (!rejectingId) return;
    try {
      await rejectCashDeposit(rejectingId, rejectReason);
      setRejectingId(null);
      setRejectReason('');
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to reject deposit');
    }
  };

  // v1.10.143 — two-step soft-delete: reason → admin password → soft delete
  // + audit stamp. Mirrors the GRN void flow. Hard delete is gone: the
  // row stays in the DB with deleted_at/deleted_by/delete_reason so the
  // list can render a DELETED badge and Cash Book balances can be
  // audited without silently rewriting history.
  const [deleteRow, setDeleteRow]         = useState(null);
  const [deleteStep, setDeleteStep]       = useState(null); // null | 'reason' | 'password'
  const [deleteReason, setDeleteReason]   = useState('');
  const [deleteBusy, setDeleteBusy]       = useState(false);
  const [deleteError, setDeleteError]     = useState('');
  const handleDelete = (d) => {
    setDeleteRow(d);
    setDeleteReason('');
    setDeleteError('');
    setDeleteStep('reason');
  };

  const fmt = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtRaw = (n) => Math.round(parseFloat(n || 0)).toLocaleString();

  // Stats — pending count, totals per currency this month.
  const pendingCount   = deposits.filter(d => d.status === 'PENDING').length;
  const confirmedTotal = deposits.filter(d => d.status === 'CONFIRMED').reduce((acc, d) => {
    acc[d.currency] = (acc[d.currency] || 0) + parseFloat(d.amount || 0);
    return acc;
  }, {});

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Deposits</h1>
          <p>{onHq
            ? 'Confirm cash deposits sent in from branches'
            : 'Send cash to HQ and track confirmations'}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={fetchDeposits}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <FiRefreshCw size={15} /> Refresh
          </button>
          {!onHq && (
            <button onClick={openSendModal}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#d97706', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              <FiSend size={15} /> Send Deposit
            </button>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, textTransform: 'uppercase' }}>Pending</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#78350f' }}>{pendingCount}</div>
        </div>
        <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: '#166534', fontWeight: 700, textTransform: 'uppercase' }}>Confirmed (USD)</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#14532d' }}>{fmt(confirmedTotal.USD || 0)}</div>
        </div>
        {/* v1.10.19 — also show FRA / K cards when actual deposits exist,
            not only when the current branch's currency_mode says so. HQ view
            aggregates across every branch and might see K deposits from a
            Sosna branch even while HQ's own mode is USD-only. */}
        {(isDual || (confirmedTotal.FRA || 0) > 0) && (
          <div style={{ background: '#dbeafe', border: '1px solid #93c5fd', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 700, textTransform: 'uppercase' }}>Confirmed (FRA)</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#1e3a8a' }}>FRA {fmtRaw(confirmedTotal.FRA || 0)}</div>
          </div>
        )}
        {(hasK || (confirmedTotal.K || 0) > 0) && (
          <div style={{ background: '#ede9fe', border: '1px solid #c4b5fd', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#6d28d9', fontWeight: 700, textTransform: 'uppercase' }}>Confirmed (K)</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#4c1d95' }}>K {fmtRaw(confirmedTotal.K || 0)}</div>
          </div>
        )}
      </div>

      {/* Filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>Status:</label>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
          <option value="ALL">All</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>

      {/* Deposits table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        {deposits.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
            <FiInbox size={40} style={{ marginBottom: 12, opacity: 0.4 }} />
            <p style={{ fontStyle: 'italic' }}>{loading ? 'Loading...' : 'No deposits to show.'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}></th>
                  <th style={th}>Deposit #</th>
                  {onHq && <th style={th}>From</th>}
                  <th style={th}>Currency</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                  <th style={th}>Notes</th>
                  <th style={th}>Attachment</th>
                  <th style={th}>Status</th>
                  <th style={th}>Deposit Date</th>
                  <th style={th}>Created</th>
                  <th style={th}>Confirmed</th>
                  <th style={{ ...th, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {deposits.map(d => {
                  const statusColor = d.status === 'CONFIRMED' ? '#16a34a' : d.status === 'REJECTED' ? '#dc2626' : '#d97706';
                  const statusBg    = d.status === 'CONFIRMED' ? '#dcfce7' : d.status === 'REJECTED' ? '#fee2e2' : '#fef3c7';
                  return (
                    <tr key={d.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>
                        {onHq
                          ? <FiArrowDownLeft size={14} color="#16a34a" title="Incoming to HQ" />
                          : <FiArrowUpRight  size={14} color="#d97706" title="Outgoing to HQ" />}
                      </td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{d.deposit_number}</td>
                      {onHq && <td style={td}>{d.from_name || d.from_slug}</td>}
                      <td style={{ ...td, fontWeight: 700 }}>{d.currency}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                        {d.currency === 'USD' ? fmt(d.amount) : `${fmtRaw(d.amount)} ${d.currency}`}
                      </td>
                      <td style={{ ...td, color: '#6b7280', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.notes}>{d.notes || '—'}</td>
                      <td style={td}>
                        {(() => {
                          const atts = parseAttachments(d.attachment);
                          if (atts.length === 0) return <span style={{ color: '#cbd5e1', fontSize: 11 }}>—</span>;
                          const apiBase = (process.env.REACT_APP_API_URL || '/api').replace(/\/api\/?$/, '');
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {atts.map((p, i) => (
                                <a key={i} href={`${apiBase}/uploads/${p}`} target="_blank" rel="noopener noreferrer"
                                   style={{ color: '#2563eb', fontSize: 11, textDecoration: 'none', fontWeight: 600 }}>
                                  View {atts.length > 1 ? `#${i + 1}` : ''}
                                </a>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
                      <td style={td}>
                        {/* v1.10.143 — DELETED badge takes precedence over
                            the status badge. Same visual pattern as REJECTED
                            (red pill + italic reason underneath). */}
                        {d.deleted_at ? (
                          <>
                            <span style={{ padding: '2px 10px', background: '#fee2e2', color: '#991b1b', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                              DELETED
                            </span>
                            {d.delete_reason && (
                              <div style={{ fontSize: 10, color: '#b91c1c', fontStyle: 'italic', marginTop: 3 }} title={d.delete_reason}>
                                {d.delete_reason.length > 30 ? d.delete_reason.slice(0, 30) + '…' : d.delete_reason}
                              </div>
                            )}
                            {d.deleted_by_name && (
                              <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 2 }}>
                                by {d.deleted_by_name}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <span style={{ padding: '2px 10px', background: statusBg, color: statusColor, borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                              {d.status}
                            </span>
                            {d.status === 'REJECTED' && d.reject_reason && (
                              <div style={{ fontSize: 10, color: '#b91c1c', fontStyle: 'italic', marginTop: 3 }} title={d.reject_reason}>
                                {d.reject_reason.length > 30 ? d.reject_reason.slice(0, 30) + '…' : d.reject_reason}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td style={{ ...td, color: '#374151', fontSize: 11, fontWeight: 600 }}>
                        {d.deposit_date || (d.created_at ? new Date(d.created_at).toLocaleDateString() : '—')}
                      </td>
                      <td style={{ ...td, color: '#6b7280', fontSize: 11 }}>
                        <div>{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</div>
                        {d.created_by_name && <div style={{ fontSize: 10 }}>by {d.created_by_name}</div>}
                      </td>
                      <td style={{ ...td, color: '#6b7280', fontSize: 11 }}>
                        {d.confirmed_at ? (
                          <>
                            <div>{new Date(d.confirmed_at).toLocaleString()}</div>
                            {d.confirmed_by_name && <div style={{ fontSize: 10 }}>by {d.confirmed_by_name}</div>}
                          </>
                        ) : '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {/* v1.10.143 — no actions on deleted rows. */}
                        {d.deleted_at ? (
                          <span style={{ fontSize: 10, color: '#94a3b8' }}>—</span>
                        ) : (
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {onHq && d.status === 'PENDING' && (
                            <>
                              <button onClick={() => handleConfirm(d)}
                                style={{ padding: '5px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <FiCheck size={11} /> Confirm
                              </button>
                              <button onClick={() => { setRejectingId(d.id); setRejectReason(''); }}
                                style={{ padding: '5px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <FiX size={11} /> Reject
                              </button>
                            </>
                          )}
                          {/* v1.10.84 — HQ can edit accounting date on CONFIRMED
                              deposits. Admin-gated inside handleEditDate.
                              v1.10.168 — expanded to edit date + amount +
                              from_method + notes with reason + admin password. */}
                          {onHq && d.status === 'CONFIRMED' && (
                            <button onClick={() => handleEditDeposit(d)} title="Edit deposit (date / amount / method / notes)"
                              style={{ padding: '5px 10px', background: '#fff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <FiEdit2 size={11} />
                            </button>
                          )}
                          {/* Delete: branch can cancel its own PENDING rows;
                              HQ can soft-delete CONFIRMED / REJECTED rows.
                              v1.10.168 — HQ can NO LONGER delete PENDING; use
                              Confirm or Reject instead. Delete on PENDING is
                              destructive without an audit trail motivation
                              (Reject already covers "we don't accept this"). */}
                          {((onHq && d.status !== 'PENDING') || (!onHq && d.status === 'PENDING')) && (
                            <button onClick={() => handleDelete(d)} title="Delete deposit"
                              style={{ padding: '5px 10px', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <FiTrash2 size={11} />
                            </button>
                          )}
                        </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Send Deposit modal — branch side */}
      {showSend && (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowSend(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <FiSend size={18} /> Send Deposit to HQ
              </h2>
              <button className="modal-close" onClick={() => setShowSend(false)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 14 }}>
                Record cash physically leaving this branch and going to HQ. No exchange happens — just enter the raw currency and amount. HQ marks it confirmed when they receive it.
              </p>
              <div className="form-row">
                <div className="form-group">
                  <label>Currency</label>
                  <select value={sendForm.currency}
                    onChange={e => setSendForm({ ...sendForm, currency: e.target.value })}>
                    {depositCcyOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Amount ({sendForm.currency})</label>
                  <input type="number" min="0" step="0.01" value={sendForm.amount}
                    onChange={e => setSendForm({ ...sendForm, amount: e.target.value })}
                    placeholder="0.00" autoFocus />
                </div>
              </div>
              {/* v1.10.48 — From Drawer picker on Liquor branches so the
                  Cash Book tiles know which physical bucket shrank. Hidden
                  on Sosna tri-currency where deposits are currency-anchored
                  (USD/FRA/K), not method-anchored. */}
              {isLiquorStyle && (
                <div className="form-group">
                  <label>From Drawer</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {[
                      { value: 'Cash',         label: 'Cash on Hand',  color: '#16a34a' },
                      { value: 'Mobile Money', label: 'Mobile Money',  color: '#ea580c' },
                      { value: 'Bank',         label: 'Bank',          color: '#2563eb' },
                    ].map(opt => {
                      const active = sendForm.from_method === opt.value;
                      return (
                        <button key={opt.value} type="button"
                          onClick={() => setSendForm({ ...sendForm, from_method: opt.value })}
                          style={{
                            flex: '1 1 130px', padding: '10px 12px', borderRadius: 8,
                            border: `2px solid ${active ? opt.color : '#e5e7eb'}`,
                            background: active ? `${opt.color}15` : '#fff',
                            color: active ? opt.color : '#374151',
                            fontWeight: active ? 700 : 500, fontSize: 13, cursor: 'pointer',
                          }}>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="form-group">
                <label>Deposit Date</label>
                <input type="date" value={sendForm.deposit_date}
                  max={todayStr()}
                  onChange={e => setSendForm({ ...sendForm, deposit_date: e.target.value || todayStr() })} />
              </div>
              <div className="form-group">
                <label>Notes (optional)</label>
                <input value={sendForm.notes}
                  onChange={e => setSendForm({ ...sendForm, notes: e.target.value })}
                  placeholder="Courier / driver / reference" />
              </div>
              <div className="form-group">
                <label>Attach Deposit Slips (optional) — picture or PDF, multiple allowed</label>
                <div style={{ border: '1px dashed #d1d5db', borderRadius: 8, padding: 10, background: '#fafafa' }}>
                  {/* List of already-uploaded attachments with Remove */}
                  {(sendForm.attachments || []).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                      {sendForm.attachments.map((path, idx) => {
                        const isPdf = (path || '').toLowerCase().endsWith('.pdf');
                        const apiBase = (process.env.REACT_APP_API_URL || '/api').replace(/\/api\/?$/, '');
                        const url = `${apiBase}/uploads/${path}`;
                        const shortName = path.length > 36 ? `…${path.slice(-34)}` : path;
                        return (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                            {isPdf ? <FiFileText size={14} color="#dc2626" /> : <FiImage size={14} color="#16a34a" />}
                            <span style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName}</span>
                            <a href={url} target="_blank" rel="noopener noreferrer"
                               style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', background: '#dcfce7', color: '#166534', borderRadius: 4, fontSize: 11, fontWeight: 600, textDecoration: 'none' }}>
                              <FiEye size={11} /> View
                            </a>
                            <button type="button" onClick={() => removeAttachment(idx)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                              <FiX size={11} /> Remove
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Add buttons */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple
                      style={{ display: 'none' }}
                      onChange={e => { handleFilesPicked(e.target.files); e.target.value = ''; }} />
                    <input ref={camInputRef} type="file" accept="image/*" capture="environment"
                      style={{ display: 'none' }}
                      onChange={e => { handleFilesPicked(e.target.files); e.target.value = ''; }} />
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingAtt}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#fff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 6, cursor: uploadingAtt ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                      <FiPaperclip size={12} /> {uploadingAtt ? 'Uploading…' : 'Choose files'}
                    </button>
                    <button type="button" onClick={() => camInputRef.current?.click()} disabled={uploadingAtt}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#fff', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 6, cursor: uploadingAtt ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                      <FiCamera size={12} /> Camera
                    </button>
                    <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>
                      {(sendForm.attachments || []).length} attached
                    </span>
                  </div>
                  {attError && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>{attError}</div>
                  )}
                </div>
              </div>
              {sendError && (
                <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12, fontWeight: 600 }}>
                  {sendError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={() => setShowSend(false)}
                  style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  Cancel
                </button>
                <button onClick={handleSend} disabled={sending}
                  style={{ padding: '10px 28px', background: sending ? '#9ca3af' : '#d97706', color: '#fff', border: 'none', borderRadius: 8, cursor: sending ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FiSend size={14} />
                  {sending ? 'Sending...' : 'Send Deposit'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Reject modal — HQ side */}
      {rejectingId && (
        <Portal>
        <div className="modal-overlay" onClick={() => setRejectingId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2>Reject Deposit</h2>
              <button className="modal-close" onClick={() => setRejectingId(null)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>
                Tell the branch why you're rejecting (cash short, never arrived, wrong amount, etc.).
              </p>
              <div className="form-group">
                <label>Reason</label>
                <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                  placeholder="Cash count was short by $50" autoFocus />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={() => setRejectingId(null)}
                  style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  Cancel
                </button>
                <button onClick={handleReject}
                  style={{ padding: '10px 28px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FiX size={14} /> Reject
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* v1.10.83/84 — admin password gate for both:
           - PENDING confirm-with-date-change (mode='confirm')
           - CONFIRMED edit-date (mode='edit') */}
      <AdminPasswordPrompt
        open={!!pendingDateChange}
        actionLabel={pendingDateChange?.mode === 'edit' ? 'Approve Date Edit' : 'Approve Date Change'}
        onConfirm={finishConfirmWithDate}
        onCancel={() => setPendingDateChange(null)}
      />

      {/* v1.10.168 — Edit Deposit flow (CONFIRMED-only, HQ only):
           form → reason → admin password → PUT /:id/edit */}
      {editStep === 'form' && editRow && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}
             onClick={(e) => { if (e.target === e.currentTarget && !editBusy) setEditStep(null); }}>
          <div onClick={e => e.stopPropagation()}
               style={{ background: '#fff', borderRadius: 12, padding: 22, width: 520, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#1d4ed8' }}>Edit Deposit {editRow.deposit_number}</h3>
            <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 14px', lineHeight: 1.5 }}>
              {editRow.from_name || editRow.from_slug} · {editRow.currency}
              <strong style={{ color: '#b45309', display: 'block', marginTop: 6 }}>
                ⚠ HQ and the branch Cash Book will both reflect these changes.
              </strong>
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>Deposit date</label>
                <input type="date" value={editForm.deposit_date} disabled={editBusy}
                  onChange={e => setEditForm(f => ({ ...f, deposit_date: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>Amount ({editRow.currency})</label>
                <input type="number" min="0" step="0.01" value={editForm.amount} disabled={editBusy}
                  onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>From (drawer)</label>
                <select value={editForm.from_method} disabled={editBusy}
                  onChange={e => setEditForm(f => ({ ...f, from_method: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: '#fff' }}>
                  <option value="">—</option>
                  <option value="Cash">Cash</option>
                  <option value="Bank">Bank</option>
                  <option value="Mobile Money">Mobile Money</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>Notes</label>
                <input type="text" value={editForm.notes} disabled={editBusy}
                  onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
              </div>
            </div>

            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>Reason *</label>
            <textarea rows={3} value={editReason} disabled={editBusy}
              onChange={e => setEditReason(e.target.value)}
              placeholder="e.g. branch reported wrong amount at deposit time — actual K 336,000"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', resize: 'vertical', minHeight: 60, fontFamily: 'inherit' }} />

            {editError && <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 12 }}>{editError}</div>}

            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => { setEditStep(null); setEditRow(null); setEditReason(''); setEditError(''); }}
                disabled={editBusy}
                style={{ padding: '9px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: editBusy ? 'not-allowed' : 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  if (editReason.trim().length < 3) { setEditError('Reason must be at least 3 characters.'); return; }
                  const amt = parseFloat(editForm.amount);
                  if (!isFinite(amt) || amt <= 0) { setEditError('Amount must be > 0.'); return; }
                  setEditError('');
                  setEditStep('password');
                }}
                disabled={editBusy || editReason.trim().length < 3 || !editForm.amount}
                style={{ padding: '9px 18px', background: (editBusy || editReason.trim().length < 3 || !editForm.amount) ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: (editBusy || editReason.trim().length < 3 || !editForm.amount) ? 'not-allowed' : 'pointer' }}>
                Continue → Admin auth
              </button>
            </div>
          </div>
        </div>
      )}

      <AdminPasswordPrompt
        open={editStep === 'password'}
        subject={editRow ? `${editRow.deposit_number} — ${editRow.currency} ${parseFloat(editRow.amount || 0).toLocaleString()}` : ''}
        actionLabel="Save Edit"
        onCancel={() => { if (!editBusy) setEditStep('form'); }}
        onConfirm={async ({ adminId, adminName }) => {
          setEditBusy(true); setEditError('');
          try {
            await editCashDeposit(editRow.id, {
              deposit_date: editForm.deposit_date,
              amount:       parseFloat(editForm.amount),
              from_method:  editForm.from_method || null,
              notes:        editForm.notes || null,
              reason:       editReason.trim(),
              adminId,
              adminName,
            });
            setEditBusy(false);
            setEditStep(null);
            setEditRow(null);
            setEditReason('');
            await fetchDeposits();
          } catch (err) {
            setEditBusy(false);
            setEditStep('form');
            setEditError(err.response?.data?.error || 'Failed to save edit.');
          }
        }}
      />

      {/* v1.10.143 — Delete flow: reason → admin password → soft delete. */}
      {deleteStep === 'reason' && deleteRow && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}
             onClick={(e) => { if (e.target === e.currentTarget && !deleteBusy) setDeleteStep(null); }}>
          <div onClick={e => e.stopPropagation()}
               style={{ background: '#fff', borderRadius: 12, padding: 22, width: 460, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#b91c1c' }}>Delete Deposit {deleteRow.deposit_number}</h3>
            <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 14px', lineHeight: 1.5 }}>
              {deleteRow.currency} {parseFloat(deleteRow.amount || 0).toLocaleString()} from {deleteRow.from_name || deleteRow.from_slug}.
              {deleteRow.status === 'CONFIRMED' && (
                <strong style={{ color: '#b45309', display: 'block', marginTop: 6 }}>
                  ⚠ This deposit was already CONFIRMED. Deleting it removes it from both HQ's and the branch's Cash Book.
                </strong>
              )}
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>Reason *</label>
            <textarea rows={3} value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="e.g. duplicate entry — actual deposit is DEP-...-0031"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', resize: 'vertical', minHeight: 60, fontFamily: 'inherit' }} />
            {deleteError && <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 12 }}>{deleteError}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => { setDeleteStep(null); setDeleteRow(null); setDeleteReason(''); setDeleteError(''); }}
                disabled={deleteBusy}
                style={{ padding: '9px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: deleteBusy ? 'not-allowed' : 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  if (deleteReason.trim().length < 3) { setDeleteError('Reason must be at least 3 characters.'); return; }
                  setDeleteError('');
                  setDeleteStep('password');
                }}
                disabled={deleteBusy || deleteReason.trim().length < 3}
                style={{ padding: '9px 18px', background: deleteBusy || deleteReason.trim().length < 3 ? '#fca5a5' : '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: deleteBusy || deleteReason.trim().length < 3 ? 'not-allowed' : 'pointer' }}>
                Continue → Admin auth
              </button>
            </div>
          </div>
        </div>
      )}

      <AdminPasswordPrompt
        open={deleteStep === 'password'}
        subject={deleteRow ? `${deleteRow.deposit_number} — ${deleteRow.currency} ${parseFloat(deleteRow.amount || 0).toLocaleString()}` : ''}
        actionLabel="Delete Deposit"
        onCancel={() => { if (!deleteBusy) setDeleteStep('reason'); }}
        onConfirm={async ({ adminId, adminName }) => {
          setDeleteBusy(true); setDeleteError('');
          try {
            await deleteCashDeposit(deleteRow.id, { reason: deleteReason.trim(), adminId, adminName });
            setDeleteBusy(false);
            setDeleteStep(null);
            setDeleteRow(null);
            setDeleteReason('');
            await fetchDeposits();
          } catch (err) {
            setDeleteBusy(false);
            setDeleteStep('reason');
            setDeleteError(err.response?.data?.error || 'Failed to delete deposit.');
          }
        }}
      />
    </div>
  );
};

const th = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4 };
const td = { padding: '10px 12px' };

export default HQDeposits;
