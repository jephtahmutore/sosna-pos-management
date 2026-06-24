// v1.8.6 — Reusable Currency Exchange ledger panel.
// Used in Cash Report (scope='drawer') and Cash Book (scope='book').
//
// Renders:
//   - Heading + "Add Exchange" button (admin/manager only)
//   - List of exchanges for the active filter
//   - Add Exchange modal (FROM → TO with auto-computed rate)
//
// Append-only: there's no delete UI. To undo a mistake the user records a
// reverse exchange (FRA → USD), keeping both rows visible for audit.
import React, { useEffect, useState } from 'react';
import { FiPlus, FiRepeat, FiX } from 'react-icons/fi';
import { getCurrencyExchanges, createCurrencyExchange } from '../services/api';

const CURRENCIES = ['USD', 'FRA', 'K'];
const fmt = (n, dec) => parseFloat(n || 0).toLocaleString(undefined, {
  minimumFractionDigits: dec, maximumFractionDigits: dec,
});
const symFor = (c) => c === 'USD' ? '$' : '';
const decFor = (c) => c === 'USD' ? 2 : 0;

export default function CurrencyExchangePanel({
  scope,             // 'drawer' or 'book'
  date,              // YYYY-MM-DD (drawer scope) — optional for book
  from, to,          // YYYY-MM-DD range (book scope) — optional
  cashierId,         // drawer scope — number, 0 = all
  user,              // current user from useAuth — used to check role
  onChanged,         // optional callback after a new exchange is saved
  title,             // display title (default 'Currency Exchanges')
  drawerBalance,     // v1.8.8: optional { USD, FRA, K } — when supplied,
                     //   modal shows live drawer balance + soft warns
                     //   if FROM amount exceeds available. Save still allowed.
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState('');

  const role = String(user?.role || '').toLowerCase();
  const canRecord = role === 'administrator' || role === 'admin' || role === 'manager';

  const refresh = async () => {
    setLoading(true);
    try {
      const params = { scope };
      if (date) params.date = date;
      if (from) params.from = from;
      if (to)   params.to   = to;
      if (scope === 'drawer' && cashierId !== undefined) params.cashier_id = cashierId;
      const r = await getCurrencyExchanges(params);
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load exchanges');
      setRows([]);
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [scope, date, from, to, cashierId]);

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiRepeat color="#7c3aed" />
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{title || 'Currency Exchanges'}</h3>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>· {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span>
        </div>
        {canRecord && (
          <button onClick={() => { setShowAdd(true); setError(''); }}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1.5px solid #7c3aed', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FiPlus size={13} /> Add Exchange
          </button>
        )}
      </div>

      {error && <div style={{ padding: '8px 16px', color: '#dc2626', fontSize: 12 }}>{error}</div>}

      <div style={{ padding: '0 8px 8px' }}>
        {loading ? (
          <div style={{ padding: 18, color: '#94a3b8', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 18, color: '#94a3b8', fontSize: 13 }}>No exchanges yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={th}>Time</th>
                <th style={{ ...th, textAlign: 'right' }}>From</th>
                <th style={{ ...th, textAlign: 'right' }}>To</th>
                <th style={{ ...th, textAlign: 'right' }}>Rate</th>
                {scope === 'drawer' && <th style={th}>Cashier</th>}
                <th style={th}>Notes</th>
                <th style={th}>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>{r.date}{r.time ? ' ' + String(r.time).slice(0, 5) : ''}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>
                    −{symFor(r.from_currency)}{fmt(r.from_amount, decFor(r.from_currency))} {r.from_currency}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>
                    +{symFor(r.to_currency)}{fmt(r.to_amount, decFor(r.to_currency))} {r.to_currency}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: '#64748b', fontFamily: 'monospace' }}>
                    {r.rate ? parseFloat(r.rate).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}
                  </td>
                  {scope === 'drawer' && <td style={{ ...td, color: '#475569' }}>{r.cashier_name || '—'}</td>}
                  <td style={{ ...td, color: '#475569' }}>{r.notes || '—'}</td>
                  <td style={{ ...td, color: '#94a3b8', fontSize: 11 }}>{r.created_by_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <AddExchangeModal
          scope={scope}
          defaultDate={date || new Date().toISOString().slice(0, 10)}
          cashierId={cashierId}
          drawerBalance={drawerBalance}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); refresh(); if (onChanged) onChanged(); }}
        />
      )}
    </div>
  );
}

function AddExchangeModal({ scope, defaultDate, cashierId, drawerBalance, onClose, onSaved }) {
  const [form, setForm] = useState({
    from_currency: 'USD', from_amount: '',
    to_currency:   'FRA', to_amount: '',
    notes: '',
    date: defaultDate,
    time: new Date().toTimeString().slice(0, 5),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fromAmt = parseFloat(form.from_amount || 0) || 0;
  const toAmt   = parseFloat(form.to_amount   || 0) || 0;
  const rate    = fromAmt > 0 ? toAmt / fromAmt : 0;

  const submit = async () => {
    setError('');
    if (form.from_currency === form.to_currency) return setError('From and To currencies must differ.');
    if (fromAmt <= 0) return setError('From amount must be > 0.');
    if (toAmt   <= 0) return setError('To amount must be > 0.');
    setSaving(true);
    try {
      await createCurrencyExchange({
        scope,
        date: form.date,
        time: form.time,
        from_currency: form.from_currency,
        from_amount:   fromAmt,
        to_currency:   form.to_currency,
        to_amount:     toAmt,
        cashier_id:    scope === 'drawer' ? (cashierId || 0) : null,
        notes:         form.notes || null,
      });
      onSaved();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to save');
    }
    setSaving(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 540, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New Currency Exchange — {scope === 'drawer' ? 'Drawer (till)' : 'Cash Book'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><FiX /></button>
        </div>
        <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px', fontSize: 11.5, color: '#78350f', marginBottom: 12 }}>
          Exchanges are append-only. To undo a mistake, record a reverse exchange — both rows stay visible for audit.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <label style={lbl}>Date</label>
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} style={inp} />
          </div>
          <div>
            <label style={lbl}>Time</label>
            <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} style={inp} />
          </div>
        </div>

        {/* v1.8.8 — live drawer balance badges (drawer scope only). */}
        {drawerBalance && (
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#1e40af', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
            <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }}>Drawer balance</span>
            <span>
              USD <strong>${fmt(drawerBalance.USD || 0, 2)}</strong>
              {'  ·  '}
              FRA <strong>{fmt(drawerBalance.FRA || 0, 0)}</strong>
              {'  ·  '}
              K <strong>{fmt(drawerBalance.K || 0, 0)}</strong>
            </span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#b91c1c', marginBottom: 6, textTransform: 'uppercase' }}>From (taken out)</div>
            <select value={form.from_currency} onChange={e => setForm({ ...form, from_currency: e.target.value })} style={inp}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" min="0" step="0.01" value={form.from_amount}
              onChange={e => setForm({ ...form, from_amount: e.target.value })}
              placeholder="0" style={{ ...inp, marginTop: 6 }} />
            {drawerBalance && (
              <div style={{ fontSize: 11, color: '#7c2d12', marginTop: 4 }}>
                Available: <strong>{fmt(drawerBalance[form.from_currency] || 0, form.from_currency === 'USD' ? 2 : 0)}</strong> {form.from_currency}
              </div>
            )}
          </div>
          <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#047857', marginBottom: 6, textTransform: 'uppercase' }}>To (received)</div>
            <select value={form.to_currency} onChange={e => setForm({ ...form, to_currency: e.target.value })} style={inp}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" min="0" step="0.01" value={form.to_amount}
              onChange={e => setForm({ ...form, to_amount: e.target.value })}
              placeholder="0" style={{ ...inp, marginTop: 6 }} />
          </div>
        </div>

        {/* v1.8.8 — soft warning when FROM amount exceeds drawer balance.
            Save stays enabled (Option B). Hidden when no drawerBalance prop. */}
        {drawerBalance && fromAmt > 0 && fromAmt > (parseFloat(drawerBalance[form.from_currency] || 0) + 0.001) && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#92400e', marginBottom: 10 }}>
            ⚠ {form.from_currency} amount exceeds drawer.
            {' '}Available: <strong>{fmt(drawerBalance[form.from_currency] || 0, form.from_currency === 'USD' ? 2 : 0)} {form.from_currency}</strong>
            {' · '}Short by: <strong>{fmt(fromAmt - parseFloat(drawerBalance[form.from_currency] || 0), form.from_currency === 'USD' ? 2 : 0)} {form.from_currency}</strong>.
            <br />Save anyway if the cashier brought outside cash; otherwise reduce the amount.
          </div>
        )}

        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#475569', marginBottom: 10 }}>
          Effective rate: <strong>{rate > 0 ? rate.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</strong>
          {' '}({form.to_currency} per 1 {form.from_currency})
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Notes (optional)</label>
          <input type="text" value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
            placeholder="e.g. customer requested FRA in change" style={inp} />
        </div>

        {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '8px 14px', borderRadius: 6, border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#7c3aed', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700 }}>
            {saving ? 'Saving…' : 'Save Exchange'}
          </button>
        </div>
      </div>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 11, color: '#475569', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
const th  = { textAlign: 'left', padding: '8px 12px', fontWeight: 700 };
const td  = { padding: '8px 12px', color: '#0f172a' };
