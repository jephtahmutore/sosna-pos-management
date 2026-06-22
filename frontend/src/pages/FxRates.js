// FxRates — Accounting → Currency Rates.
//
// Per-branch USD↔FRA rate management. Only useful when the branch is in
// dual-currency mode (USD+FRA); on a USD-only branch the page renders a
// "not applicable" notice rather than a form, so the sidebar entry isn't
// confusing if someone wires it up there too.
//
// Daily flow: manager opens the page, types today's Sell + Buy, hits Save.
// POS / Cashier auto-pick up the latest effective row on the next render.
// Old rows stay around (soft-deleted only) so backdated receipts replay
// with the rate that was in effect on the order's date.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiPlus, FiTrash2, FiDollarSign, FiGlobe } from 'react-icons/fi';
import { getFxRates, createFxRate, deleteFxRate, getLiveFxRate } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtRate = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Mirror of the Cashier / POS fallback. When no fx_rates row exists yet
// the page still shows these numbers (labelled "system default") so the
// manager sees what the till is actually using right now, not a blank.
const FALLBACK_SELL = 2900;
const FALLBACK_BUY  = 2600;

export default function FxRates() {
  const { currencyMode } = useCurrency();
  const isDual = currencyMode === 'USD+FRA';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  // Live BCC reference rate from open.er-api.com. Cashier does NOT use it
  // — it's just a sanity check for the manager when typing the manual rate.
  const [live, setLive] = useState(null);   // { rate, source, fetchedAt, error? }
  const [liveLoading, setLiveLoading] = useState(false);
  const [form, setForm] = useState({
    effective_date: todayISO(),
    sell_rate: '',
    buy_rate: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getFxRates();
      setRows(r.data || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  const refreshLive = async () => {
    setLiveLoading(true);
    try {
      const r = await getLiveFxRate();
      setLive({ ...r.data, error: null });
    } catch (err) {
      setLive({ error: err?.response?.data?.error || 'Failed to fetch live rate' });
    }
    setLiveLoading(false);
  };

  useEffect(() => { if (isDual) { refresh(); refreshLive(); } /* eslint-disable-next-line */ }, [isDual]);

  const save = async (e) => {
    e.preventDefault();
    const sell = parseFloat(form.sell_rate);
    const buy = parseFloat(form.buy_rate);
    if (!form.effective_date) return flash('Effective date is required', 'error');
    if (!isFinite(sell) || sell <= 0) return flash('Sell rate must be > 0', 'error');
    if (!isFinite(buy)  || buy  <= 0) return flash('Buy rate must be > 0', 'error');
    if (buy >= sell) {
      // Cashier change is given via Buy rate, so Buy < Sell is the normal
      // direction. Warn but allow — operator may have a real reason.
      if (!window.confirm('Buy rate is not lower than Sell rate. Continue?')) return;
    }
    setSaving(true);
    try {
      await createFxRate({
        effective_date: form.effective_date,
        sell_rate: sell,
        buy_rate: buy,
        notes: form.notes || null,
      });
      flash('Rate saved', 'success');
      setForm({ effective_date: todayISO(), sell_rate: '', buy_rate: '', notes: '' });
      await refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to save', 'error');
    }
    setSaving(false);
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this rate? Cashier will fall back to the next-most-recent rate.')) return;
    try {
      await deleteFxRate(id);
      flash('Deleted', 'success');
      await refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to delete', 'error');
    }
  };

  if (!isDual) {
    return (
      <div className="page-content">
        <div className="page-header"><div><h1>Currency Rates</h1></div></div>
        <div style={{ padding: 18, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, color: '#475569' }}>
          This branch operates in single currency ({currencyMode}). Currency rates are only used by branches running in <b>USD + FRA</b> mode.
        </div>
      </div>
    );
  }

  const savedCurrent = rows.find(r => r.effective_date <= todayISO()) || rows[0];
  const isFallback = !savedCurrent;
  const current = savedCurrent || { sell_rate: FALLBACK_SELL, buy_rate: FALLBACK_BUY };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Currency Rates</h1>
          <p>USD ↔ FRA — set here, read by POS &amp; Cashier</p>
        </div>
        <button onClick={refresh}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, padding: '10px 16px', background: toast.type === 'error' ? '#ef4444' : '#16a34a', color: '#fff', borderRadius: 6, zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
          {toast.text}
        </div>
      )}

      {/* Current effective rate banner */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
            Current Sell Rate
            {isFallback && <span style={badgeStyle}>System default</span>}
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {fmtRate(current.sell_rate)}
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>FRA / USD</span>
          </div>
        </div>
        <div>
          <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
            Current Buy Rate
            {isFallback && <span style={badgeStyle}>System default</span>}
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {fmtRate(current.buy_rate)}
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>FRA / USD</span>
          </div>
        </div>
        {!isFallback && (
          <div style={{ gridColumn: '1 / -1', fontSize: 11, color: '#94a3b8' }}>
            In effect since {current.effective_date}{current.set_by_name ? ` · set by ${current.set_by_name}` : ''}{current.notes ? ` · ${current.notes}` : ''}
          </div>
        )}
        {isFallback && (
          <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '8px 10px', borderRadius: 6 }}>
            No manual rate set yet. POS &amp; Cashier are using the system default shown above. Add a row below to override.
          </div>
        )}
      </div>

      {/* Live BCC reference rate (read-only, not used by POS/Cashier) */}
      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ color: '#1e40af', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
              <FiGlobe size={12} /> Live Market Rate (BCC official)
            </div>
            {live?.error ? (
              <div style={{ fontSize: 13, color: '#b91c1c', marginTop: 6 }}>{live.error}</div>
            ) : live?.rate ? (
              <>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', marginTop: 4, display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  {fmtRate(live.rate)}
                  <span style={{ fontSize: 12, color: '#475569', fontWeight: 500 }}>CDF / USD</span>
                </div>
                <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
                  Source: {live.source}{live.time_last_update ? ` · ${new Date(live.time_last_update).toLocaleString()}` : ''}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>{liveLoading ? 'Fetching…' : '—'}</div>
            )}
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, fontStyle: 'italic' }}>
              Reference only — this is the central-bank official rate. Street/parallel rate is typically higher. POS &amp; Cashier always use the manual rate above.
            </div>
          </div>
          <button onClick={refreshLive} disabled={liveLoading}
            style={{ padding: '6px 12px', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6, cursor: liveLoading ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
            <FiRefreshCw size={12} /> {liveLoading ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Add new rate */}
      <form onSubmit={save} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: 14, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6 }}>
          <FiDollarSign /> Add new rate
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div>
            <label style={lblStyle}>Effective date</label>
            <input type="date" value={form.effective_date}
              onChange={e => setForm({ ...form, effective_date: e.target.value })}
              style={inputStyle} required />
          </div>
          <div>
            <label style={lblStyle}>Sell rate (FRA / USD)</label>
            <input type="number" step="0.01" min="0" value={form.sell_rate}
              onChange={e => setForm({ ...form, sell_rate: e.target.value })}
              placeholder="e.g. 2900" style={inputStyle} required />
          </div>
          <div>
            <label style={lblStyle}>Buy rate (FRA / USD)</label>
            <input type="number" step="0.01" min="0" value={form.buy_rate}
              onChange={e => setForm({ ...form, buy_rate: e.target.value })}
              placeholder="e.g. 2600" style={inputStyle} required />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lblStyle}>Notes (optional)</label>
            <input type="text" value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              placeholder="e.g. CB rate of the day" style={inputStyle} />
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: '#64748b' }}>
          Sell rate is used when a customer pays in FRA. Buy rate is used when change is given in FRA.
        </div>
        <button type="submit" disabled={saving}
          style={{ marginTop: 12, padding: '8px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
          <FiPlus /> {saving ? 'Saving…' : 'Save Rate'}
        </button>
      </form>

      {/* History table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
          History
        </div>
        {loading ? (
          <div style={{ padding: 18, color: '#64748b' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 18, color: '#64748b' }}>No rates saved yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={thStyle}>Effective</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Sell</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Buy</th>
                <th style={thStyle}>Notes</th>
                <th style={thStyle}>Set by</th>
                <th style={thStyle}>Saved</th>
                <th style={{ ...thStyle, width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', fontSize: 13 }}>
                  <td style={tdStyle}>{r.effective_date}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtRate(r.sell_rate)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtRate(r.buy_rate)}</td>
                  <td style={tdStyle}>{r.notes || '—'}</td>
                  <td style={tdStyle}>{r.set_by_name || '—'}</td>
                  <td style={{ ...tdStyle, color: '#94a3b8', fontSize: 11 }}>
                    {r.created_at ? new Date(r.created_at + 'Z').toLocaleString() : '—'}
                  </td>
                  <td style={tdStyle}>
                    <button onClick={() => remove(r.id)} title="Delete"
                      style={{ background: 'transparent', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}>
                      <FiTrash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const lblStyle = { display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 };
const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
const thStyle = { textAlign: 'left', padding: '10px 14px', fontWeight: 700 };
const tdStyle = { padding: '10px 14px', color: '#0f172a' };
const badgeStyle = { background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 8, fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase' };
