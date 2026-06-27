// Cashier — 3-station workflow station (kassumbalesa1, workflow_mode='three_station').
//
// Left pane:   Pending Payments queue (orders status='PENDING_PAYMENT').
// Right pane:  Selected order details + Sirak-POS-style payment panel.
//
// Payment math mirrors Sirak-POS Cashier.js exactly — the reference build the
// user explicitly told us to copy:
//   paidFRAasUSD     = paidFRA / sellRate
//   totalAmountPaid  = paidUSD + paidFRAasUSD
//   unpaidBalance    = max(0, totalDue - totalAmountPaid)
//   changeUSD        = max(0, totalAmountPaid - totalDue)
//   changeFRA        = changeUSD * buyRate
//   totalChangeGiven = givenUSD + givenFRA / buyRate
//   netRemaining     = changeUSD - totalChangeGiven
//
// FX rates: read from Accounting → Currency Rates (table fx_rates). Falls
// back to SELL=2900, BUY=2600 when no rate has been saved yet so existing
// terminals don't break the moment they upgrade. Snapshot stored on the
// order at collect-payment time so old receipts always replay correctly.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiClock, FiUser, FiShoppingCart } from 'react-icons/fi';
import {
  getCashierInbox,
  getOrder,
  collectOrderPayment,
  getSettings,
  getCurrentFxRate,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import printHtml from '../utils/printHtml';

const FALLBACK_SELL   = 2900;
const FALLBACK_BUY    = 2600;
const FALLBACK_SELL_K = 25;   // placeholder until set in Currency Rates
const FALLBACK_BUY_K  = 23;

const fmtUSD = (n) => `$${parseFloat(n || 0).toFixed(2)}`;
const fmtFRA = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');
const fmtK   = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');

export default function Cashier() {
  const { user } = useAuth();
  // v1.7.0: currency_mode='USD+FRA+K' enables a third K (Kwacha) input row.
  // 'USD+FRA' = FRA only (legacy). 'K' = USD-only at Cashier.
  const { currencyMode } = useCurrency();
  const hasFra = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const hasK   = currencyMode === 'USD+FRA+K';
  const [inbox, setInbox] = useState([]);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [amountPaidUSD, setAmountPaidUSD] = useState('');
  const [amountPaidFRA, setAmountPaidFRA] = useState('');
  const [amountPaidK,   setAmountPaidK]   = useState('');
  const [changeGivenUSD, setChangeGivenUSD] = useState('');
  const [changeGivenFRA, setChangeGivenFRA] = useState('');
  const [changeGivenK,   setChangeGivenK]   = useState('');
  // v1.8.68 — which drawer holds the over-payment the cashier KEPT (no change
  // physically returned). Defaulted from the currency the customer paid most in.
  const [keptCcy, setKeptCcy] = useState('');
  const [confirm, setConfirm] = useState(null);   // { ...calc }
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [biz, setBiz] = useState({ name: 'SOSNA', phone: '', address: '' });
  // Live FX rates — refreshed on mount + when opening a new order so a
  // mid-shift rate change is picked up without a hard reload. K rates
  // default to the FALLBACK_*_K constants until the admin sets them in
  // Accounting → Currency Rates.
  const [fxRate, setFxRate] = useState({ sell: FALLBACK_SELL, buy: FALLBACK_BUY, sellK: FALLBACK_SELL_K, buyK: FALLBACK_BUY_K });
  const SELL_RATE   = fxRate.sell;
  const BUY_RATE    = fxRate.buy;
  const SELL_RATE_K = fxRate.sellK;
  const BUY_RATE_K  = fxRate.buyK;

  const refreshFxRate = async () => {
    try {
      const r = await getCurrentFxRate();
      if (r.data) {
        setFxRate(prev => ({
          sell:  parseFloat(r.data.sell_rate)  > 0 ? parseFloat(r.data.sell_rate)  : prev.sell,
          buy:   parseFloat(r.data.buy_rate)   > 0 ? parseFloat(r.data.buy_rate)   : prev.buy,
          sellK: parseFloat(r.data.sell_rate_k)> 0 ? parseFloat(r.data.sell_rate_k): prev.sellK,
          buyK:  parseFloat(r.data.buy_rate_k) > 0 ? parseFloat(r.data.buy_rate_k) : prev.buyK,
        }));
      }
    } catch { /* keep fallback */ }
  };
  useEffect(() => { refreshFxRate(); }, []);

  useEffect(() => {
    getSettings().then(r => {
      const b = r.data?.business || {};
      setBiz({
        name:    b.business_name    || 'SOSNA',
        phone:   b.business_phone   || '',
        address: b.business_address || '',
      });
    }).catch(() => {});
  }, []);

  const refreshInbox = async () => {
    setLoadingInbox(true);
    try {
      const res = await getCashierInbox();
      setInbox(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
    setLoadingInbox(false);
  };

  useEffect(() => {
    refreshInbox();
    // Poll every 5s so newly-confirmed orders from the Sales station appear
    // automatically. Light enough on a small queue.
    const id = setInterval(refreshInbox, 5000);
    return () => clearInterval(id);
  }, []);

  const openOrder = async (id) => {
    setLoadingDetail(true);
    setAmountPaidUSD(''); setAmountPaidFRA(''); setAmountPaidK('');
    setChangeGivenUSD(''); setChangeGivenFRA(''); setChangeGivenK(''); setKeptCcy('');
    refreshFxRate();
    try {
      const res = await getOrder(id);
      setSelected(res.data);
    } catch { setSelected(null); }
    setLoadingDetail(false);
  };

  // Sirak math, extended with K (v1.7.0). Three foreign-cash buckets:
  //   paidFRAasUSD = paidFRA / sellRate
  //   paidKasUSD   = paidK   / sellRateK
  //   totalAmountPaid = paidUSD + paidFRAasUSD + paidKasUSD
  // Change displays in all currencies (read-only); cashier picks which
  // currency to physically hand back.
  const computePayment = () => {
    if (!selected) return null;
    const totalDue = parseFloat(selected.total_amount || 0);
    const paidUSD  = parseFloat(amountPaidUSD || 0) || 0;
    const paidFRA  = parseFloat(amountPaidFRA || 0) || 0;
    const paidK    = parseFloat(amountPaidK   || 0) || 0;
    const paidFRAasUSD    = SELL_RATE   > 0 ? paidFRA / SELL_RATE   : 0;
    const paidKasUSD      = SELL_RATE_K > 0 ? paidK   / SELL_RATE_K : 0;
    const totalAmountPaid = paidUSD + paidFRAasUSD + paidKasUSD;
    const unpaidBalance   = Math.max(0, totalDue - totalAmountPaid);
    const unpaidBalanceFRA= SELL_RATE   > 0 ? unpaidBalance * SELL_RATE   : 0;
    const unpaidBalanceK  = SELL_RATE_K > 0 ? unpaidBalance * SELL_RATE_K : 0;
    // v1.8.72 — attribute over-payment to the SOURCE currency. Priority order:
    // USD pays first, then FRA fills the gap, then K. Whatever's left over in
    // each currency is the over-payment in THAT currency (no FX round-trip,
    // so the 1:1 "give me back what I gave you" rule holds).
    let _rem = totalDue;
    const _usdUsed = Math.min(paidUSD, _rem);
    const overUSD  = paidUSD - _usdUsed;
    _rem -= _usdUsed;
    let overFRA = 0;
    if (_rem > 0 && paidFRA > 0 && SELL_RATE > 0) {
      const fraNeeded = _rem * SELL_RATE;
      if (paidFRA >= fraNeeded) { overFRA = paidFRA - fraNeeded; _rem = 0; }
      else                      { _rem -= paidFRA / SELL_RATE; }
    } else if (paidFRA > 0) {
      overFRA = paidFRA;
    }
    let overK = 0;
    if (_rem > 0 && paidK > 0 && SELL_RATE_K > 0) {
      const kNeeded = _rem * SELL_RATE_K;
      if (paidK >= kNeeded) { overK = paidK - kNeeded; _rem = 0; }
      else                  { _rem -= paidK / SELL_RATE_K; }
    } else if (paidK > 0) {
      overK = paidK;
    }
    // Legacy USD-equivalent change (kept for places that still use it: receipt
    // headline, isOverpaid flag, given-vs-owed comparison).
    const changeUSD       = Math.max(0, totalAmountPaid - totalDue);
    const changeFRA       = BUY_RATE   > 0 ? changeUSD * BUY_RATE   : 0;
    const changeK         = BUY_RATE_K > 0 ? changeUSD * BUY_RATE_K : 0;
    const isOverpaid      = changeUSD > 0.001;
    const givenUSD        = parseFloat(changeGivenUSD || 0) || 0;
    const givenFRA        = parseFloat(changeGivenFRA || 0) || 0;
    const givenK          = parseFloat(changeGivenK   || 0) || 0;
    const totalChangeGiven = givenUSD
                           + (BUY_RATE   > 0 ? givenFRA / BUY_RATE   : 0)
                           + (BUY_RATE_K > 0 ? givenK   / BUY_RATE_K : 0);
    const netRemaining    = changeUSD - totalChangeGiven;
    const netRemainingFRA = BUY_RATE   > 0 ? netRemaining * BUY_RATE   : 0;
    const netRemainingK   = BUY_RATE_K > 0 ? netRemaining * BUY_RATE_K : 0;
    return {
      totalDue, paidUSD, paidFRA, paidK, paidFRAasUSD, paidKasUSD, totalAmountPaid,
      unpaidBalance, unpaidBalanceFRA, unpaidBalanceK,
      changeUSD, changeFRA, changeK, isOverpaid,
      // v1.8.72 — per-source-currency over-payment (no FX round-trip).
      overUSD, overFRA, overK,
      givenUSD, givenFRA, givenK, totalChangeGiven,
      netRemaining, netRemainingFRA, netRemainingK,
    };
  };

  const handleConfirm = () => {
    const data = computePayment();
    if (!data) return;
    setConfirm(data);
  };

  const processPayment = async () => {
    if (!selected || !confirm) return;
    setSubmitting(true);
    try {
      await collectOrderPayment(selected.id, {
        paid_usd:     confirm.paidUSD,
        paid_fra:     confirm.paidFRA,
        paid_k:       confirm.paidK,
        given_usd:    confirm.givenUSD,
        given_fra:    confirm.givenFRA,
        given_k:      confirm.givenK,
        buy_rate:     BUY_RATE,
        sell_rate:    SELL_RATE,
        buy_rate_k:   BUY_RATE_K,
        sell_rate_k:  SELL_RATE_K,
        // v1.8.68 — which drawer the over-payment was kept in (when cashier
        // didn't physically return the change). Backend defaults to the
        // currency the customer paid in if this is blank.
        // v1.8.72 — send the NATIVE amount so backend doesn't round-trip
        // through USD (which loses 4 FRA per $0.11 to the sell/buy spread).
        overpaid_kept_ccy: confirm.netRemaining > 0.005 ? (keptCcy || '') : '',
        overpaid_kept_amt: confirm.netRemaining > 0.005
          ? ((keptCcy === 'FRA') ? confirm.overFRA
             : (keptCcy === 'K') ? confirm.overK
             : (keptCcy === 'USD') ? confirm.overUSD
             : 0)
          : 0,
      });

      // Snapshot for the printed receipt BEFORE we clear state.
      const cashierName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'Cashier';
      try {
        printHtml(renderCashierReceipt({
          biz,
          order: selected,
          calc: confirm,
          cashierName,
          when: new Date(),
          sellRate:  SELL_RATE,
          buyRate:   BUY_RATE,
          sellRateK: SELL_RATE_K,
          buyRateK:  BUY_RATE_K,
        }));
      } catch (_) { /* non-fatal — payment is already recorded */ }

      setSelected(null);
      setConfirm(null);
      setAmountPaidUSD(''); setAmountPaidFRA('');
      setChangeGivenUSD(''); setChangeGivenFRA('');
      setToast({ text: 'Payment recorded — order moved to Dispatch.', type: 'success' });
      setTimeout(() => setToast(null), 3000);
      refreshInbox();
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Payment failed';
      setToast({ text: msg, type: 'error' });
      setTimeout(() => setToast(null), 4500);
    }
    setSubmitting(false);
  };

  const calc = computePayment();
  // v1.8.49 — credit-at-Cashier. If the order has a registered customer
  // (set on the Sales/Reception screen), the cashier can take partial /
  // zero payment — the unpaid portion lives on the customer's outstanding.
  // Walk-ins still need to pay in full (10¢ rounding tolerance).
  const hasRegisteredCustomer = !!(selected && selected.customer_id);
  const creditAvailable = hasRegisteredCustomer
    ? Math.max(0, parseFloat(selected.customer_credit_limit || 0) - parseFloat(selected.customer_outstanding || 0))
    : 0;
  const wouldExceedLimit = hasRegisteredCustomer && !!calc
    && parseFloat(selected.customer_credit_limit || 0) > 0
    && (parseFloat(selected.customer_outstanding || 0) + calc.unpaidBalance) > parseFloat(selected.customer_credit_limit || 0) + 0.001;
  const onHold = hasRegisteredCustomer && selected.customer_credit_status === 'OnHold';
  // Walk-in: require any payment + must cover the full total (within 10¢).
  // Registered customer: any payment OR full credit (0) is allowed,
  // provided the customer isn't on hold and isn't over-limit.
  const canConfirm = !!selected && !!calc && !onHold && !wouldExceedLimit && (
    hasRegisteredCustomer
      ? true                                                     // partial / full / 0 all OK
      : (calc.paidUSD > 0 || calc.paidFRA > 0 || calc.paidK > 0) // walk-in: must enter something
  );

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Cashier</h1>
          <p>Collect payment on orders sent from Sales</p>
        </div>
        <button onClick={refreshInbox}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 200px)' }}>
        {/* ── LEFT: Inbox queue ───────────────────────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a' }}>Pending Payments</h3>
            <span style={{ fontSize: 12, color: '#64748b', background: '#f1f5f9', padding: '2px 8px', borderRadius: 12 }}>
              {inbox.length}
            </span>
          </div>
          {loadingInbox && inbox.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p>
          ) : inbox.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No pending payments</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {inbox.map(o => (
                <div key={o.id}
                  onClick={() => openOrder(o.id)}
                  style={{
                    padding: '10px 12px',
                    border: `1.5px solid ${selected?.id === o.id ? '#2563eb' : '#e5e7eb'}`,
                    background: selected?.id === o.id ? '#eff6ff' : '#fff',
                    borderRadius: 8, cursor: 'pointer',
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{o.order_number}</span>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#0ea5e9' }}>{fmtUSD(o.total_amount)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                    <span><FiUser size={10} style={{ verticalAlign: 'middle' }} /> {o.customer_name || 'Walk-in'}</span>
                    <span>{o.item_count} item{o.item_count === 1 ? '' : 's'}</span>
                  </div>
                  {o.sales_at && (
                    <div style={{ marginTop: 4, fontSize: 10, color: '#94a3b8' }}>
                      <FiClock size={10} style={{ verticalAlign: 'middle' }} /> {new Date(o.sales_at).toLocaleString()}
                      {o.sales_by_name ? ` · by ${o.sales_by_name}` : ''}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── RIGHT: Order detail + payment ──────────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, overflowY: 'auto' }}>
          {!selected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', flexDirection: 'column' }}>
              <FiShoppingCart size={48} style={{ marginBottom: 12, opacity: 0.4 }} />
              <p style={{ fontStyle: 'italic' }}>Select an order from the queue to collect payment</p>
            </div>
          ) : loadingDetail ? (
            <p style={{ color: '#64748b' }}>Loading order…</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
              {/* Left half: order + items */}
              <div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: 16, color: '#0f172a' }}>
                  Order {selected.order_number}
                  {hasRegisteredCustomer && (
                    <span style={{ marginLeft: 8, padding: '2px 8px', background: '#fef3c7', color: '#92400e', borderRadius: 999, fontSize: 10, fontWeight: 700, verticalAlign: 'middle' }}>
                      CREDIT-ELIGIBLE
                    </span>
                  )}
                  {onHold && (
                    <span style={{ marginLeft: 6, padding: '2px 8px', background: '#fee2e2', color: '#b91c1c', borderRadius: 999, fontSize: 10, fontWeight: 700, verticalAlign: 'middle' }}>
                      ON HOLD
                    </span>
                  )}
                </h3>
                <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                  Customer: <strong>{selected.customer_name || 'Walk-in'}</strong>
                  {hasRegisteredCustomer && parseFloat(selected.customer_credit_limit || 0) > 0 && (
                    <> · Limit {fmtUSD(selected.customer_credit_limit)} · Outstanding {fmtUSD(selected.customer_outstanding || 0)} · Available {fmtUSD(creditAvailable)}</>
                  )}
                </p>
                {hasRegisteredCustomer && calc && calc.unpaidBalance > 0.10 && (
                  <div style={{ marginTop: 8, padding: '8px 10px', background: wouldExceedLimit ? '#fee2e2' : '#fef3c7', border: `1px solid ${wouldExceedLimit ? '#fecaca' : '#fde68a'}`, borderRadius: 6, fontSize: 12, color: wouldExceedLimit ? '#991b1b' : '#92400e', fontWeight: 600 }}>
                    {wouldExceedLimit
                      ? `⚠ Would exceed credit limit. Available is only ${fmtUSD(creditAvailable)}.`
                      : `Will create credit of ${fmtUSD(calc.unpaidBalance)} on this customer's account.`}
                  </div>
                )}
                <div style={{ marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: '#f8fafc' }}>
                      <tr>
                        <th style={thStyle}>Item</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Price</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selected.items || []).map((it, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={tdStyle}>{it.product_name}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{parseFloat(it.quantity).toFixed(2)} {it.unit || ''}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtUSD(it.unit_price)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtUSD(it.total_price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 12, fontSize: 13 }}>
                  <div style={totalsRow}><span>Subtotal</span><span>{fmtUSD(selected.subtotal)}</span></div>
                  {parseFloat(selected.discount || 0) > 0 && (
                    <div style={totalsRow}><span>Discount</span><span>−{fmtUSD(selected.discount)}</span></div>
                  )}
                  <div style={{ ...totalsRow, fontWeight: 700, color: '#0f172a', borderTop: '1px solid #e5e7eb', marginTop: 6, paddingTop: 6 }}>
                    <span>Total Due</span><span>{fmtUSD(selected.total_amount)}</span>
                  </div>
                </div>
              </div>

              {/* Right half: payment */}
              <div>
                <h3 style={{ margin: '0 0 10px 0', fontSize: 16, color: '#0f172a' }}>Payment</h3>
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '12px 14px', marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: '#0369a1', fontWeight: 600 }}>Total Due</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#0c4a6e', lineHeight: 1.1 }}>{fmtUSD(selected.total_amount)}</div>
                  {hasFra && (
                    <div style={{ fontSize: 11, color: '#0369a1', marginTop: 2 }}>
                      or {fmtFRA(parseFloat(selected.total_amount) * SELL_RATE)} FRA (sell {SELL_RATE.toLocaleString()})
                      {hasK && <> · or {fmtK(parseFloat(selected.total_amount) * SELL_RATE_K)} K (sell {SELL_RATE_K.toLocaleString()})</>}
                    </div>
                  )}
                </div>

                {/* v1.6.3 + v1.7.0: per-invoice FX rate override. K row only
                    appears when currency_mode='USD+FRA+K'. */}
                {hasFra && (
                <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>FX Rate for this invoice</span>
                    <button type="button" onClick={refreshFxRate}
                      style={{ background: 'transparent', border: '1px solid #fde68a', color: '#92400e', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
                      Reset to default
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <label style={{ ...lblStyle, color: '#92400e' }}>Sell rate (paid in FRA)</label>
                      <input type="number" min="0" step="0.01" value={fxRate.sell}
                        onChange={e => setFxRate(r => ({ ...r, sell: parseFloat(e.target.value) || 0 }))}
                        style={inputStyle} />
                    </div>
                    <div>
                      <label style={{ ...lblStyle, color: '#92400e' }}>Buy rate (change in FRA)</label>
                      <input type="number" min="0" step="0.01" value={fxRate.buy}
                        onChange={e => setFxRate(r => ({ ...r, buy: parseFloat(e.target.value) || 0 }))}
                        style={inputStyle} />
                    </div>
                  </div>
                  {hasK && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8, borderTop: '1px dashed #fde68a', paddingTop: 8 }}>
                      <div>
                        <label style={{ ...lblStyle, color: '#92400e' }}>Sell rate (paid in K)</label>
                        <input type="number" min="0" step="0.01" value={fxRate.sellK}
                          onChange={e => setFxRate(r => ({ ...r, sellK: parseFloat(e.target.value) || 0 }))}
                          style={inputStyle} />
                      </div>
                      <div>
                        <label style={{ ...lblStyle, color: '#92400e' }}>Buy rate (change in K)</label>
                        <input type="number" min="0" step="0.01" value={fxRate.buyK}
                          onChange={e => setFxRate(r => ({ ...r, buyK: parseFloat(e.target.value) || 0 }))}
                          style={inputStyle} />
                      </div>
                    </div>
                  )}
                </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: hasK ? '1fr 1fr 1fr' : (hasFra ? '1fr 1fr' : '1fr'), gap: 10 }}>
                  <div>
                    <label style={lblStyle}>Amount Paid ($)</label>
                    <input type="number" min="0" step="0.01" value={amountPaidUSD}
                      onChange={e => setAmountPaidUSD(e.target.value)} placeholder="0.00" style={inputStyle} />
                  </div>
                  {hasFra && (
                    <div>
                      <label style={lblStyle}>Amount Paid (FRA)</label>
                      <input type="number" min="0" step="1" value={amountPaidFRA}
                        onChange={e => setAmountPaidFRA(e.target.value)} placeholder="0" style={inputStyle} />
                    </div>
                  )}
                  {hasK && (
                    <div>
                      <label style={lblStyle}>Amount Paid (K)</label>
                      <input type="number" min="0" step="1" value={amountPaidK}
                        onChange={e => setAmountPaidK(e.target.value)} placeholder="0" style={inputStyle} />
                    </div>
                  )}
                </div>

                {calc && (calc.paidUSD > 0 || calc.paidFRA > 0 || calc.paidK > 0) && (
                  <div style={{ marginTop: 12 }}>
                    {calc.isOverpaid ? (() => {
                      // v1.8.73 — restore original Change card layout (headline USD,
                      // sub-line FRA/K equivalents), but at SELL rate. Native over-
                      // payment per currency takes precedence when present so the
                      // customer always gets back the EXACT amount they overpaid
                      // (no FX spread loss on same-currency refund).
                      const headlineUSD = (calc.overUSD || 0)
                                        + (SELL_RATE   > 0 ? (calc.overFRA || 0) / SELL_RATE   : 0)
                                        + (SELL_RATE_K > 0 ? (calc.overK   || 0) / SELL_RATE_K : 0);
                      const fraEquiv = calc.overFRA > 0.5 ? calc.overFRA : (SELL_RATE   > 0 ? headlineUSD * SELL_RATE   : 0);
                      const kEquiv   = calc.overK   > 0.5 ? calc.overK   : (SELL_RATE_K > 0 ? headlineUSD * SELL_RATE_K : 0);
                      return (
                        <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '10px 12px' }}>
                          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600 }}>Change</div>
                          <div style={{ fontSize: 20, fontWeight: 800, color: '#065f46' }}>{fmtUSD(headlineUSD)}</div>
                          {hasFra && (
                            <div style={{ fontSize: 12, color: '#047857', fontWeight: 600, marginTop: 4 }}>
                              ≈ FRA {fmtFRA(fraEquiv)} (sell {SELL_RATE.toLocaleString()})
                              {hasK && <> · ≈ K {fmtK(kEquiv)} (sell {SELL_RATE_K.toLocaleString()})</>}
                            </div>
                          )}
                        </div>
                      );
                    })() : (
                      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px' }}>
                        <div style={{ fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>Unpaid Balance</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#991b1b' }}>{fmtUSD(calc.unpaidBalance)}</div>
                        {hasFra && (
                          <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600, marginTop: 4 }}>
                            ≈ FRA {fmtFRA(calc.unpaidBalanceFRA)} (sell {SELL_RATE.toLocaleString()})
                            {hasK && <> · ≈ K {fmtK(calc.unpaidBalanceK)} (sell {SELL_RATE_K.toLocaleString()})</>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {calc?.isOverpaid && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>Change Given</div>
                    <div style={{ display: 'grid', gridTemplateColumns: hasK ? '1fr 1fr 1fr' : (hasFra ? '1fr 1fr' : '1fr'), gap: 10 }}>
                      <div>
                        <label style={lblStyle}>Given ($)</label>
                        <input type="number" min="0" step="0.01" value={changeGivenUSD}
                          onChange={e => setChangeGivenUSD(e.target.value)}
                          placeholder="0.00" style={inputStyle} />
                      </div>
                      {hasFra && (
                      <div>
                        <label style={lblStyle}>Given (FRA)</label>
                        <input type="number" min="0" step="1" value={changeGivenFRA}
                          onChange={e => setChangeGivenFRA(e.target.value)}
                          placeholder="0" style={inputStyle} />
                      </div>
                      )}
                      {hasK && (
                      <div>
                        <label style={lblStyle}>Given (K)</label>
                        <input type="number" min="0" step="1" value={changeGivenK}
                          onChange={e => setChangeGivenK(e.target.value)}
                          placeholder="0" style={inputStyle} />
                      </div>
                      )}
                    </div>
                    {/* v1.8.68 — when cashier overpaid and is keeping some change, ask which drawer.
                        v1.8.72 — default to the currency that holds the actual over-payment
                        (so customer's over-paid FRA shows FRA selected, not USD). */}
                    {calc.netRemaining > 0.005 && (() => {
                      const defaultCcy = keptCcy
                        || (calc.overFRA > 0.5 ? 'FRA'
                           : calc.overK   > 0.5 ? 'K'
                           : 'USD');
                      return (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8 }}>
                          <div style={{ fontSize: 11, color: '#92400e', fontWeight: 600, marginBottom: 6 }}>
                            Customer over-paid by {fmtUSD(calc.netRemaining)} — kept in drawer:
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {['USD', 'FRA', 'K'].map(c => {
                              const active = defaultCcy === c;
                              return (
                                <button key={c} type="button" onClick={() => setKeptCcy(c)}
                                  style={{
                                    flex: 1, padding: '8px 10px', borderRadius: 6,
                                    border: active ? '2px solid #d97706' : '1px solid #fcd34d',
                                    background: active ? '#fef3c7' : '#fff',
                                    color: '#78350f', fontWeight: 700, fontSize: 12, cursor: 'pointer',
                                  }}>
                                  {c}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                    {(calc.givenUSD > 0 || calc.givenFRA > 0 || calc.givenK > 0) && (() => {
                      const exact     = Math.abs(calc.netRemaining) < 0.01;
                      const overpaid  = calc.netRemaining < -0.01;
                      const bg        = exact ? '#ecfdf5' : overpaid ? '#fef2f2' : '#fef3c7';
                      const border    = exact ? '#a7f3d0' : overpaid ? '#fecaca' : '#fde68a';
                      const labelClr  = exact ? '#047857' : overpaid ? '#b91c1c' : '#92400e';
                      const amtClr    = overpaid ? '#991b1b' : '#78350f';
                      const label     = exact ? 'Exact change given' : overpaid ? 'Overpaid to customer' : 'Still owed to customer';
                      const absAmt    = Math.abs(calc.netRemaining);
                      const absAmtFra = Math.abs(calc.netRemainingFRA);
                      const absAmtK   = Math.abs(calc.netRemainingK);
                      return (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: bg, border: `1px solid ${border}`, borderRadius: 8 }}>
                          <div style={{ fontSize: 11, color: labelClr, fontWeight: 600 }}>{label}</div>
                          {!exact && (
                            <div style={{ fontSize: 16, fontWeight: 800, color: amtClr }}>
                              {fmtUSD(absAmt)}{' '}
                              {hasFra && <span style={{ fontSize: 11, fontWeight: 600 }}>(FRA {fmtFRA(absAmtFra)}{hasK && <> · K {fmtK(absAmtK)}</>})</span>}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                <button onClick={handleConfirm}
                  disabled={!canConfirm || submitting}
                  style={{
                    marginTop: 18, width: '100%', padding: '14px',
                    background: canConfirm ? 'linear-gradient(135deg,#16a34a,#15803d)' : '#cbd5e1',
                    color: '#fff', border: 'none', borderRadius: 8,
                    fontSize: 15, fontWeight: 700, cursor: canConfirm ? 'pointer' : 'not-allowed',
                  }}>
                  Confirm Payment →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirm modal */}
      {confirm && selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: 'min(440px, 92vw)', padding: 22 }}>
            <h3 style={{ margin: '0 0 14px 0' }}>Confirm Payment</h3>
            <div style={confirmRow}><span>Order</span><strong>{selected.order_number}</strong></div>
            <div style={confirmRow}><span>Customer</span><strong>{selected.customer_name || 'Walk-in'}</strong></div>
            <hr style={hrStyle} />
            <div style={confirmRow}><span>Total Due</span><strong>{fmtUSD(confirm.totalDue)}</strong></div>
            <div style={confirmRow}><span>Paid ($)</span><strong>{fmtUSD(confirm.paidUSD)}</strong></div>
            {confirm.paidFRA > 0 && (
              <div style={confirmRow}><span>Paid (FRA)</span><strong>FRA {fmtFRA(confirm.paidFRA)} <span style={{ color: '#64748b', fontWeight: 500 }}>(={fmtUSD(confirm.paidFRAasUSD)})</span></strong></div>
            )}
            <div style={{ ...confirmRow, fontWeight: 700 }}><span>Total Paid</span><strong>{fmtUSD(confirm.totalAmountPaid)}</strong></div>
            <hr style={hrStyle} />
            {confirm.isOverpaid ? (
              <>
                <div style={confirmRow}><span>Change</span><strong>{fmtUSD(confirm.changeUSD)} <span style={{ color: '#64748b', fontWeight: 500 }}>(FRA {fmtFRA(confirm.changeFRA)})</span></strong></div>
                {(confirm.givenUSD > 0 || confirm.givenFRA > 0) && (
                  <>
                    {confirm.givenUSD > 0 && <div style={confirmRow}><span>Change Given ($)</span><strong>{fmtUSD(confirm.givenUSD)}</strong></div>}
                    {confirm.givenFRA > 0 && <div style={confirmRow}><span>Change Given (FRA)</span><strong>FRA {fmtFRA(confirm.givenFRA)}</strong></div>}
                  </>
                )}
                {(() => {
                  const exact    = Math.abs(confirm.netRemaining) < 0.01;
                  const overpaid = confirm.netRemaining < -0.01;
                  // v1.8.72 — when picker is set, netRemaining > 0 means the over-payment
                  // is being KEPT in the chosen drawer, not "still owed". Show the chosen
                  // currency + the amount in that currency.
                  const kept     = !exact && !overpaid && !!keptCcy;
                  const bg       = exact ? '#ecfdf5' : overpaid ? '#fef2f2' : kept ? '#fffbeb' : '#fef3c7';
                  const label    = exact ? 'Exact Change'
                                   : overpaid ? 'Overpaid'
                                   : kept ? `Kept in ${keptCcy} drawer`
                                   : 'Still owed';
                  const colour   = overpaid ? '#991b1b' : kept ? '#92400e' : undefined;
                  let amountText;
                  if (exact) amountText = fmtUSD(0);
                  else if (kept) {
                    // v1.8.72 — use native per-currency over-payment (no FX round-trip).
                    if (keptCcy === 'USD')      amountText = fmtUSD(confirm.overUSD || confirm.netRemaining);
                    else if (keptCcy === 'FRA') amountText = `FRA ${fmtFRA(confirm.overFRA || confirm.netRemainingFRA)}`;
                    else if (keptCcy === 'K')   amountText = `K ${fmtK(confirm.overK || confirm.netRemainingK)}`;
                    else amountText = fmtUSD(confirm.netRemaining);
                  } else amountText = fmtUSD(Math.abs(confirm.netRemaining));
                  return (
                    <div style={{ ...confirmRow, marginTop: 8, padding: '10px 12px', background: bg, borderRadius: 8 }}>
                      <span style={{ fontWeight: 700, color: colour }}>{label}</span>
                      <strong style={{ color: colour }}>{amountText}</strong>
                    </div>
                  );
                })()}
              </>
            ) : (
              <div style={{ ...confirmRow, padding: '10px 12px', background: '#fef2f2', borderRadius: 8 }}>
                <span style={{ fontWeight: 700, color: '#b91c1c' }}>Unpaid Balance</span>
                <strong style={{ color: '#991b1b' }}>−{fmtUSD(confirm.unpaidBalance)}</strong>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => setConfirm(null)}
                style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={processPayment}
                disabled={submitting || (!hasRegisteredCustomer && !confirm.isOverpaid && confirm.unpaidBalance > 0.10)}
                style={{ flex: 1, padding: '12px',
                         background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                         color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                {submitting ? 'Processing…' : 'Yes, Process Payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Dual-currency 80mm thermal receipt — built once on confirm + sent via
// printHtml (iframe + print dialog on Electron / desktop, PDF download on
// mobile, share-sheet on Capacitor APK). FRA rows only appear when the
// payment actually involved FRA cash or FRA change — keeps USD-only sales
// from showing useless "FRA: 0" lines.
function renderCashierReceipt({ biz, order, calc, cashierName, when, sellRate: _sell, buyRate: _buy, sellRateK: _sellK, buyRateK: _buyK }) {
  const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtFra = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');
  const div = '='.repeat(42);
  const da  = '-'.repeat(42);
  // Item row: NAME on the left, QTY + unit on the right. Per-line PRICE
  // and TOTAL columns removed per Sosna's redesign — the customer only
  // sees what they're paying via Subtotal / TOTAL DUE.
  const itemsRows = (order.items || []).map(it => {
    const qty = parseFloat(it.quantity || 0);
    const safeName = String(it.product_name).replace(/</g, '&lt;');
    return `<tr>
              <td>${safeName}</td>
              <td style="text-align:right; white-space:nowrap;">${qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)} ${it.unit || ''}</td>
            </tr>`;
  }).join('');
  const usedFra = (calc.paidFRA > 0.0001) || (calc.givenFRA > 0.0001);
  const usedK   = (calc.paidK   > 0.0001) || (calc.givenK   > 0.0001);
  const sellRate  = _sell;
  const buyRate   = _buy;
  const sellRateK = _sellK || 0;
  const buyRateK  = _buyK  || 0;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @page { size: 80mm auto; margin: 0; }
  html, body { height: auto; margin: 0; padding: 0; overflow-x: hidden; }
  * { box-sizing: border-box; }
  body { width: 80mm; max-width: 80mm; padding: 2mm 3mm; font-family: 'Courier New', Courier, monospace; font-size: 11px; color: #000; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  td { padding: 1px 0; vertical-align: top; }
  .c { text-align: center; }
  .divider { text-align: center; font-size: 10px; overflow: hidden; white-space: nowrap; margin: 3px 0; }
  .grand { font-size: 16px; font-weight: 800; }
  .amt { font-size: 13px; font-weight: 700; }
  .sub { color: #444; font-weight: 500; font-size: 10px; }
</style>
</head>
<body>
  <div class="c" style="font-size:14px;font-weight:700;letter-spacing:1px;">${biz.name || 'SOSNA'}</div>
  ${biz.address ? `<div class="c" style="font-size:11px;">${String(biz.address).replace(/\n/g, '<br/>')}</div>` : ''}
  ${biz.phone ? `<div class="c" style="font-size:11px;">Tel: ${biz.phone}</div>` : ''}
  <div class="divider">${div}</div>
  <div class="c" style="font-weight:700;font-size:12px;">SALES RECEIPT</div>
  ${usedK ? `<div class="c" style="font-size:10px;">(USD + FRA + K payment)</div>` : usedFra ? `<div class="c" style="font-size:10px;">(USD + FRA payment)</div>` : ''}
  <div class="divider">${div}</div>
  <table>
    <tr><td>Receipt #:</td><td></td><td style="text-align:right;">${order.order_number || ''}</td></tr>
    <tr><td>Date &amp; Time:</td><td></td><td style="text-align:right;">${when.toLocaleDateString('en-GB')} ${when.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}</td></tr>
    <tr><td>Customer:</td><td></td><td style="text-align:right;">${order.customer_name || 'Walk-in'}</td></tr>
    <tr><td>Cashier:</td><td></td><td style="text-align:right;">${cashierName}</td></tr>
  </table>
  <div class="divider">${div}</div>
  <table>
    <tr style="font-size:10px;">
      <td style="font-weight:700;">ITEM</td>
      <td style="text-align:right;font-weight:700;">QTY</td>
    </tr>
    ${itemsRows}
  </table>
  <div class="divider">${da}</div>
  <table>
    <tr><td>Subtotal</td><td></td><td></td><td style="text-align:right;">$${fmt(order.subtotal)}</td></tr>
    ${parseFloat(order.discount || 0) > 0 ? `<tr><td>Discount</td><td></td><td></td><td style="text-align:right;">-$${fmt(order.discount)}</td></tr>` : ''}
  </table>
  <div class="divider">${div}</div>
  <table>
    <tr class="grand"><td>TOTAL DUE</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.totalDue)}</td></tr>
  </table>
  <div class="divider">${div}</div>
  <table>
    <tr class="amt"><td>Cash Paid ($)</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.paidUSD)}</td></tr>
    ${calc.paidFRA > 0.0001 ? `
      <tr><td>Cash Paid (FRA)</td><td></td><td></td><td style="text-align:right;">FRA ${fmtFra(calc.paidFRA)}</td></tr>
      <tr><td class="sub">  at sell rate ${sellRate.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">≈ $${fmt(calc.paidFRAasUSD)}</td></tr>
    ` : ''}
    ${calc.paidK > 0.0001 ? `
      <tr><td>Cash Paid (K)</td><td></td><td></td><td style="text-align:right;">K ${fmtFra(calc.paidK)}</td></tr>
      <tr><td class="sub">  at sell rate ${sellRateK.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">≈ $${fmt(calc.paidKasUSD)}</td></tr>
    ` : ''}
    <tr class="amt"><td>Total Paid ($)</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.totalAmountPaid)}</td></tr>
  </table>
  ${calc.unpaidBalance > 0.10 ? `
    <div class="divider">${da}</div>
    <table>
      <tr class="grand" style="color:#000;"><td>BALANCE ON CREDIT</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.unpaidBalance)}</td></tr>
      ${usedFra ? `<tr><td class="sub">  ≈ at sell rate ${sellRate.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">FRA ${fmtFra(calc.unpaidBalanceFRA)}</td></tr>` : ''}
      ${usedK   ? `<tr><td class="sub">  ≈ at K sell rate ${sellRateK.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">K ${fmtFra(calc.unpaidBalanceK)}</td></tr>` : ''}
    </table>
  ` : ''}
  <div class="divider">${da}</div>
  ${calc.isOverpaid ? `
    <table>
      <tr class="amt"><td>*** CHANGE ***</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.changeUSD)}</td></tr>
      ${usedFra ? `<tr><td class="sub">  ≈ at buy rate ${buyRate.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">FRA ${fmtFra(calc.changeFRA)}</td></tr>` : ''}
      ${usedK   ? `<tr><td class="sub">  ≈ at K buy rate ${sellRateK ? buyRateK.toLocaleString() : '—'}</td><td></td><td></td><td style="text-align:right;" class="sub">K ${fmtFra(calc.changeK)}</td></tr>` : ''}
    </table>
    ${(calc.givenUSD > 0.0001 || calc.givenFRA > 0.0001 || calc.givenK > 0.0001) ? `
      <div class="divider">${da}</div>
      <table>
        ${calc.givenUSD > 0.0001 ? `<tr><td>Change Given ($)</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.givenUSD)}</td></tr>` : ''}
        ${calc.givenFRA > 0.0001 ? `<tr><td>Change Given (FRA)</td><td></td><td></td><td style="text-align:right;">FRA ${fmtFra(calc.givenFRA)}</td></tr>` : ''}
        ${calc.givenK   > 0.0001 ? `<tr><td>Change Given (K)</td><td></td><td></td><td style="text-align:right;">K ${fmtFra(calc.givenK)}</td></tr>` : ''}
      </table>
    ` : ''}
  ` : ''}
  <div class="divider">${div}</div>
  <div class="c" style="margin-top:4px;">Thank you for your purchase!</div>
  <div class="c">Please come again.</div>
</body></html>`;
}

const thStyle = { padding: '8px 10px', fontSize: 11, color: '#64748b', fontWeight: 600, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const tdStyle = { padding: '8px 10px', color: '#0f172a' };
const totalsRow = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: '#475569' };
const lblStyle = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
const confirmRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', color: '#0f172a', fontSize: 13 };
const hrStyle = { border: 'none', borderTop: '1px solid #e2e8f0', margin: '10px 0' };
