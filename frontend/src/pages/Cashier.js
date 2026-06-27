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
  getCashierPaymentHistory,
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
  // v1.8.86 — Pending / History tabs. 'pending' shows the live queue + payment
  // form. 'history' shows past paid orders in the same 3-column layout but
  // with all inputs disabled and a Reconciliation box added.
  const [mode, setMode] = useState('pending'); // 'pending' | 'history'
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
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

  // v1.8.86 — fetch payment history when user switches to the History tab.
  // No polling here — past orders don't change, so one fetch per open is enough.
  const refreshHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await getCashierPaymentHistory(50);
      setHistory(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
    setLoadingHistory(false);
  };
  useEffect(() => {
    if (mode === 'history') {
      refreshHistory();
      setSelected(null); // drop the live-selected order when switching tabs
    } else {
      setSelected(null);
    }
  }, [mode]);

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
        // v1.8.74 — use EFFECTIVE ccy (clicked OR default-highlighted).
        // v1.8.78 — default always FRA (most common at Sosna) unless cashier
        // explicitly clicked USD or K. Native amount comes from per-currency
        // attribution so FRA over/under always lands native (no FX loss).
        overpaid_kept_ccy: confirm.netRemaining > 0.005
          ? (keptCcy || (hasFra ? 'FRA' : hasK ? 'K' : 'USD'))
          : '',
        overpaid_kept_amt: (() => {
          if (confirm.netRemaining <= 0.005) return 0;
          const ccy = keptCcy || (hasFra ? 'FRA' : hasK ? 'K' : 'USD');
          // v1.8.79 — when converting the USD-leftover to FRA/K storage, use
          // the BUY rate. Buy rate is what the frontend already used to display
          // "Change ≈ FRA 148,200" so this keeps the math consistent: 148,200
          // owed − 148,000 given = 200 stored (was 203 at sell rate).
          if (ccy === 'FRA') {
            return confirm.overFRA > 0.5 ? confirm.overFRA
                 : (BUY_RATE > 0 ? confirm.netRemaining * BUY_RATE : 0);
          }
          if (ccy === 'K') {
            return confirm.overK > 0.5 ? confirm.overK
                 : (BUY_RATE_K > 0 ? confirm.netRemaining * BUY_RATE_K : 0);
          }
          if (ccy === 'USD') {
            return confirm.overUSD > 0.001 ? confirm.overUSD : confirm.netRemaining;
          }
          return 0;
        })(),
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

      {/* v1.8.86 — Mode tabs (Pending / History). History is read-only. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, borderBottom: '1px solid #e5e7eb' }}>
        {[
          { key: 'pending', label: 'Pending Payments', count: inbox.length, color: '#0ea5e9' },
          { key: 'history', label: 'Payment History',  count: null,         color: '#7c3aed' },
        ].map(t => {
          const active = mode === t.key;
          return (
            <button key={t.key} onClick={() => setMode(t.key)}
              style={{
                padding: '10px 18px',
                background: 'transparent',
                border: 'none',
                borderBottom: active ? `3px solid ${t.color}` : '3px solid transparent',
                color: active ? t.color : '#64748b',
                fontWeight: active ? 700 : 500,
                fontSize: 13,
                cursor: 'pointer',
                marginBottom: -1,
                display: 'inline-flex', alignItems: 'center', gap: 8,
              }}>
              {t.label}
              {t.count !== null && (
                <span style={{ fontSize: 11, background: active ? t.color : '#e5e7eb', color: active ? '#fff' : '#64748b', padding: '1px 8px', borderRadius: 999, fontWeight: 700 }}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 240px)' }}>
        {/* ── LEFT: Inbox queue OR History list ──────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, overflowY: 'auto' }}>
          {mode === 'pending' ? (
            <>
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
            </>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a' }}>Past Payments</h3>
                <span style={{ fontSize: 12, color: '#64748b', background: '#f1f5f9', padding: '2px 8px', borderRadius: 12 }}>
                  {history.length}
                </span>
              </div>
              {loadingHistory && history.length === 0 ? (
                <p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p>
              ) : history.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No past payments</p>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {history.map(o => (
                    <div key={o.id}
                      onClick={() => openOrder(o.id)}
                      style={{
                        padding: '10px 12px',
                        border: `1.5px solid ${selected?.id === o.id ? '#7c3aed' : '#e5e7eb'}`,
                        background: selected?.id === o.id ? '#faf5ff' : '#fff',
                        borderRadius: 8, cursor: 'pointer',
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{o.order_number}</span>
                        <span style={{ fontWeight: 700, fontSize: 14, color: '#7c3aed' }}>{fmtUSD(o.total_amount)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                        <span><FiUser size={10} style={{ verticalAlign: 'middle' }} /> {o.customer_name || 'Walk-in'}</span>
                        <span>{o.item_count} item{o.item_count === 1 ? '' : 's'}</span>
                      </div>
                      {o.paid_at && (
                        <div style={{ marginTop: 4, fontSize: 10, color: '#94a3b8' }}>
                          <FiClock size={10} style={{ verticalAlign: 'middle' }} /> {new Date(o.paid_at).toLocaleString()}
                          {o.cashier_name ? ` · by ${o.cashier_name}` : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
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

              {/* Right half: payment — Pending mode (live, editable) OR History mode (read-only). */}
              {mode === 'pending' ? (
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
                      // v1.8.74 — practical-handback rule (Option B):
                      //   Source currency of the over-payment → NATIVE (1:1, no FX)
                      //   All OTHER currencies → BUY rate (real currency exchange)
                      // So when overpaid in FRA, the FRA row shows the exact FRA the
                      // customer overpaid (no spread loss), and the USD/K rows show
                      // what the cashier would actually count out if converting.
                      const usdNative = calc.overUSD || 0;
                      const fraNative = calc.overFRA || 0;
                      const kNative   = calc.overK   || 0;
                      // Headline (USD): source-currency native if all over-payment is
                      // in USD; otherwise sum of non-USD over at BUY rate.
                      const headlineUSD = usdNative
                                        + (BUY_RATE   > 0 ? fraNative / BUY_RATE   : 0)
                                        + (BUY_RATE_K > 0 ? kNative   / BUY_RATE_K : 0);
                      // Sub-line FRA: native if FRA overpaid, else headline × BUY_RATE.
                      const fraEquiv = fraNative > 0.5
                        ? fraNative
                        : (BUY_RATE > 0 ? headlineUSD * BUY_RATE : 0);
                      // Sub-line K: native if K overpaid, else headline × BUY_RATE_K.
                      const kEquiv = kNative > 0.5
                        ? kNative
                        : (BUY_RATE_K > 0 ? headlineUSD * BUY_RATE_K : 0);
                      // Rate label per sub-line: "native" if that currency is the
                      // source, else "buy" to make the conversion explicit.
                      const fraLabel = fraNative > 0.5 ? 'native' : `buy ${BUY_RATE.toLocaleString()}`;
                      const kLabel   = kNative   > 0.5 ? 'native' : `buy ${BUY_RATE_K.toLocaleString()}`;
                      return (
                        <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '10px 12px' }}>
                          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600 }}>Change</div>
                          <div style={{ fontSize: 20, fontWeight: 800, color: '#065f46' }}>{fmtUSD(headlineUSD)}</div>
                          {hasFra && (
                            <div style={{ fontSize: 12, color: '#047857', fontWeight: 600, marginTop: 4 }}>
                              ≈ FRA {fmtFRA(fraEquiv)} ({fraLabel})
                              {hasK && <> · ≈ K {fmtK(kEquiv)} ({kLabel})</>}
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
                        v1.8.78 — always default to FRA (most common at Sosna). User can
                        still click USD or K to override. Falls back if branch has no FRA. */}
                    {calc.netRemaining > 0.005 && (() => {
                      const defaultCcy = keptCcy
                        || (hasFra ? 'FRA' : hasK ? 'K' : 'USD');
                      // v1.8.80 — headline amount follows the picker selection
                      // so cashier sees the exact amount in the drawer's currency.
                      // USD stays as a secondary "≈" reference.
                      let headlineText;
                      if (defaultCcy === 'FRA') {
                        const fraAmt = calc.overFRA > 0.5
                          ? calc.overFRA
                          : (BUY_RATE > 0 ? calc.netRemaining * BUY_RATE : 0);
                        headlineText = `FRA ${fmtFRA(fraAmt)} (≈ ${fmtUSD(calc.netRemaining)})`;
                      } else if (defaultCcy === 'K') {
                        const kAmt = calc.overK > 0.5
                          ? calc.overK
                          : (BUY_RATE_K > 0 ? calc.netRemaining * BUY_RATE_K : 0);
                        headlineText = `K ${fmtK(kAmt)} (≈ ${fmtUSD(calc.netRemaining)})`;
                      } else {
                        const usdAmt = calc.overUSD > 0.001 ? calc.overUSD : calc.netRemaining;
                        headlineText = fmtUSD(usdAmt);
                      }
                      return (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8 }}>
                          <div style={{ fontSize: 11, color: '#92400e', fontWeight: 600, marginBottom: 6 }}>
                            Customer over-paid by {headlineText} — kept in drawer:
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
                      // v1.8.78 — the picker (above) already conveys "kept in [ccy] drawer"
                      // when netRemaining > 0. So skip this redundant "Still owed" red box
                      // for that case — only show for exact / overpaid-back outcomes.
                      if (!exact && !overpaid) return null;
                      const bg        = exact ? '#ecfdf5' : '#fef2f2';
                      const border    = exact ? '#a7f3d0' : '#fecaca';
                      const labelClr  = exact ? '#047857' : '#b91c1c';
                      const amtClr    = '#991b1b';
                      const label     = exact ? 'Exact change given' : 'Overpaid to customer';
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
              ) : (
              // ─────── HISTORY MODE: read-only payment panel ───────
              // Pulls stored values straight off the order row (no recompute);
              // adds a Reconciliation box that shows the change owed / returned
              // / ± kept in drawer math behind the Sales Report ± column.
              <div>
                <h3 style={{ margin: '0 0 10px 0', fontSize: 16, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
                  Payment
                  <span style={{ fontSize: 10, background: '#e5e7eb', color: '#64748b', padding: '2px 8px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.5 }}>READ-ONLY</span>
                </h3>

                {/* Total Due */}
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '12px 14px', marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: '#0369a1', fontWeight: 600 }}>Total Due</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#0c4a6e', lineHeight: 1.1 }}>{fmtUSD(selected.total_amount)}</div>
                </div>

                {/* FX Rate (stored) — only show if rates exist on order */}
                {(parseFloat(selected.selling_rate_used) > 0 || parseFloat(selected.buying_rate_used) > 0) && (
                  <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, marginBottom: 6 }}>FX Rate (locked — stored on this order)</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12, color: '#78350f' }}>
                      <div>Sell FRA: <strong>{(parseFloat(selected.selling_rate_used) || 0).toLocaleString()}</strong></div>
                      <div>Buy FRA: <strong>{(parseFloat(selected.buying_rate_used) || 0).toLocaleString()}</strong></div>
                      {parseFloat(selected.selling_rate_k_used) > 0 && <div>Sell K: <strong>{(parseFloat(selected.selling_rate_k_used) || 0).toLocaleString()}</strong></div>}
                      {parseFloat(selected.buying_rate_k_used)  > 0 && <div>Buy K: <strong>{(parseFloat(selected.buying_rate_k_used)  || 0).toLocaleString()}</strong></div>}
                    </div>
                  </div>
                )}

                {/* Amount Paid */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Amount Paid</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <div style={roBox}><span style={roLbl}>USD</span><strong>{fmtUSD(selected.cash_received)}</strong></div>
                    <div style={roBox}><span style={roLbl}>FRA</span><strong>{fmtFRA(selected.fra_received)}</strong></div>
                    <div style={roBox}><span style={roLbl}>K</span><strong>{fmtK(selected.k_received)}</strong></div>
                  </div>
                </div>

                {/* Change Returned */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Change Returned</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <div style={roBox}><span style={roLbl}>USD</span><strong>{fmtUSD(selected.usd_change_given)}</strong></div>
                    <div style={roBox}><span style={roLbl}>FRA</span><strong>{fmtFRA(selected.fra_change_given)}</strong></div>
                    <div style={roBox}><span style={roLbl}>K</span><strong>{fmtK(selected.k_change_given)}</strong></div>
                  </div>
                </div>

                {/* Reconciliation box — explains the ± column from Sales Report */}
                {(() => {
                  const totalDue = parseFloat(selected.total_amount) || 0;
                  const paidUSD  = parseFloat(selected.cash_received) || 0;
                  const paidFRA  = parseFloat(selected.fra_received)  || 0;
                  const paidK    = parseFloat(selected.k_received)    || 0;
                  const sellFRA  = parseFloat(selected.selling_rate_used)   || 0;
                  const sellK    = parseFloat(selected.selling_rate_k_used) || 0;
                  const buyFRA   = parseFloat(selected.buying_rate_used)    || 0;
                  const buyK     = parseFloat(selected.buying_rate_k_used)  || 0;
                  const totalPaidUSDeq = paidUSD + (sellFRA > 0 ? paidFRA / sellFRA : 0) + (sellK > 0 ? paidK / sellK : 0);
                  const changeOwed = Math.max(0, totalPaidUSDeq - totalDue);
                  const givenUSD = parseFloat(selected.usd_change_given) || 0;
                  const givenFRA = parseFloat(selected.fra_change_given) || 0;
                  const givenK   = parseFloat(selected.k_change_given)   || 0;
                  const totalGivenUSDeq = givenUSD + (buyFRA > 0 ? givenFRA / buyFRA : 0) + (buyK > 0 ? givenK / buyK : 0);
                  const keptCcy = (selected.overpaid_kept_ccy || '').toUpperCase();
                  const keptAmt = parseFloat(selected.overpaid_kept_amt) || 0;
                  const keptDisplay = keptCcy === 'USD' ? fmtUSD(keptAmt)
                                    : keptCcy === 'FRA' ? `${fmtFRA(keptAmt)} FRA`
                                    : keptCcy === 'K'   ? `${fmtK(keptAmt)} K`
                                    : '—';
                  return (
                    <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Reconciliation</div>
                      <div style={{ fontSize: 12, color: '#475569', display: 'grid', rowGap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Total paid (USD-equiv)</span><strong>{fmtUSD(totalPaidUSDeq)}</strong></div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Change owed</span><strong>{fmtUSD(changeOwed)}</strong></div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Change returned (USD-eq)</span><strong>{fmtUSD(totalGivenUSDeq)}</strong></div>
                        {keptAmt > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #e5e7eb', paddingTop: 4, marginTop: 2 }}>
                            <span style={{ fontWeight: 700, color: '#16a34a' }}>± Kept in drawer</span>
                            <strong style={{ color: '#16a34a' }}>+{keptDisplay}</strong>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* "Paid" badge replaces the Confirm Payment button */}
                <div style={{
                  marginTop: 18, width: '100%', padding: '14px',
                  background: '#dcfce7', border: '1px solid #86efac',
                  color: '#15803d', borderRadius: 8,
                  fontSize: 14, fontWeight: 700, textAlign: 'center',
                }}>
                  ✓ Paid · Confirmed
                  {selected.paid_at && (
                    <div style={{ fontSize: 11, fontWeight: 500, marginTop: 4 }}>
                      {new Date(selected.paid_at).toLocaleString()}
                      {selected.cashier_name ? ` · by ${selected.cashier_name}` : ''}
                    </div>
                  )}
                </div>
              </div>
              )}
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
                {/* v1.8.74 — Option B: source currency native, others at BUY rate.
                    Matches the Change card on the Pay panel. */}
                {(() => {
                  const usdNative = confirm.overUSD || 0;
                  const fraNative = confirm.overFRA || 0;
                  const kNative   = confirm.overK   || 0;
                  const headlineUSD = usdNative
                                    + (BUY_RATE   > 0 ? fraNative / BUY_RATE   : 0)
                                    + (BUY_RATE_K > 0 ? kNative   / BUY_RATE_K : 0);
                  const fraEquiv = fraNative > 0.5 ? fraNative : (BUY_RATE > 0 ? headlineUSD * BUY_RATE : 0);
                  return (
                    <div style={confirmRow}>
                      <span>Change</span>
                      <strong>{fmtUSD(headlineUSD)} <span style={{ color: '#64748b', fontWeight: 500 }}>(FRA {fmtFRA(fraEquiv)})</span></strong>
                    </div>
                  );
                })()}
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
                  // v1.8.74 — use the EFFECTIVE picker selection (clicked OR default-
                  // highlighted) so the label is correct even when cashier accepts the
                  // default without clicking the button.
                  // v1.8.78 — default to FRA (most common at Sosna) when no explicit pick.
                  const effectiveCcy = keptCcy
                    || (hasFra ? 'FRA' : hasK ? 'K' : 'USD');
                  const kept     = !exact && !overpaid && !!effectiveCcy;
                  const bg       = exact ? '#ecfdf5' : overpaid ? '#fef2f2' : kept ? '#fffbeb' : '#fef3c7';
                  const label    = exact ? 'Exact Change'
                                   : overpaid ? 'Overpaid customer'
                                   : kept ? `Kept in ${effectiveCcy} drawer`
                                   : 'Still owed';
                  const colour   = overpaid ? '#991b1b' : kept ? '#92400e' : undefined;
                  let amountText;
                  if (exact) amountText = fmtUSD(0);
                  else if (kept) {
                    // v1.8.79 — display matches the payload: native source-currency
                    // over-payment when present; otherwise convert USD-leftover at
                    // BUY rate (matches the "Change ≈ FRA X" headline rate so the
                    // subtraction is clean: 148,200 owed − 148,000 given = 200).
                    if (effectiveCcy === 'USD') {
                      amountText = fmtUSD(confirm.overUSD || confirm.netRemaining);
                    } else if (effectiveCcy === 'FRA') {
                      const fraAmt = confirm.overFRA > 0.5
                        ? confirm.overFRA
                        : (BUY_RATE > 0 ? confirm.netRemaining * BUY_RATE : 0);
                      amountText = `FRA ${fmtFRA(fraAmt)}`;
                    } else if (effectiveCcy === 'K') {
                      const kAmt = confirm.overK > 0.5
                        ? confirm.overK
                        : (BUY_RATE_K > 0 ? confirm.netRemaining * BUY_RATE_K : 0);
                      amountText = `K ${fmtK(kAmt)}`;
                    } else amountText = fmtUSD(confirm.netRemaining);
                  } else if (overpaid) {
                    // v1.8.81 — cashier over-changed (shop loss). Show the overshoot in
                    // its SOURCE currency: detect which currency was returned in excess
                    // (USD-first → FRA → K consumption). Native amount as headline,
                    // USD-equivalent as reference (matches the picker-header pattern).
                    const changeOwedUSD = parseFloat(confirm.changeUSD || 0);
                    const usdGiven = parseFloat(confirm.givenUSD || 0);
                    const fraGiven = parseFloat(confirm.givenFRA || 0);
                    const kGiven   = parseFloat(confirm.givenK   || 0);
                    const usdOverAbs = Math.abs(confirm.netRemaining);
                    let rem = changeOwedUSD;
                    const usdConsumed = Math.min(usdGiven, rem); rem -= usdConsumed;
                    let fraOver = 0;
                    if (BUY_RATE > 0 && fraGiven > 0) {
                      const fraOwedFRA = rem > 0 ? rem * BUY_RATE : 0;
                      fraOver = Math.max(0, fraGiven - fraOwedFRA);
                      rem -= Math.min(fraGiven / BUY_RATE, rem);
                    }
                    let kOver = 0;
                    if (BUY_RATE_K > 0 && kGiven > 0) {
                      const kOwedK = rem > 0 ? rem * BUY_RATE_K : 0;
                      kOver = Math.max(0, kGiven - kOwedK);
                    }
                    const usdOver = Math.max(0, usdGiven - usdConsumed);
                    const fraOverAsUSD = BUY_RATE   > 0 ? fraOver / BUY_RATE   : 0;
                    const kOverAsUSD   = BUY_RATE_K > 0 ? kOver   / BUY_RATE_K : 0;
                    if (fraOverAsUSD >= kOverAsUSD && fraOverAsUSD >= usdOver && fraOver > 0.5) {
                      amountText = `FRA ${fmtFRA(fraOver)} (≈ ${fmtUSD(usdOverAbs)})`;
                    } else if (kOverAsUSD >= usdOver && kOver > 0.5) {
                      amountText = `K ${fmtK(kOver)} (≈ ${fmtUSD(usdOverAbs)})`;
                    } else {
                      amountText = fmtUSD(usdOverAbs);
                    }
                  } else amountText = fmtUSD(Math.abs(confirm.netRemaining));
                  return (
                    <div style={{ ...confirmRow, marginTop: 8, padding: '10px 12px', background: bg, borderRadius: 8, flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 700, color: colour }}>{label}</span>
                        <strong style={{ color: colour }}>{amountText}</strong>
                      </div>
                      {overpaid && (
                        <div style={{ fontSize: 10, color: '#991b1b', marginTop: 4, opacity: 0.8 }}>
                          Shop loss — recorded in Under-Payments
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            ) : (() => {
              // v1.8.82 — distinguish three under-paid scenarios:
              //   • Within $0.10 tolerance walk-in → silently absorbed (shop loss)
              //   • Registered customer with shortfall > tolerance → becomes credit
              //   • Walk-in with shortfall > tolerance → blocked by backend anyway
              // For absorbed-tolerance case, label as a shop loss (matches the
              // Under-Payments line in Cash Report) instead of the confusing
              // "Unpaid Balance" red box that implied the customer still owes.
              const absorbed = !hasRegisteredCustomer && confirm.unpaidBalance <= 0.10;
              if (absorbed) {
                return (
                  <div style={{ ...confirmRow, padding: '10px 12px', background: '#fef2f2', borderRadius: 8, flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 700, color: '#b91c1c' }}>Shortage (within tolerance)</span>
                      <strong style={{ color: '#991b1b' }}>−{fmtUSD(confirm.unpaidBalance)}</strong>
                    </div>
                    <div style={{ fontSize: 10, color: '#991b1b', marginTop: 4, opacity: 0.8 }}>
                      Shop loss — recorded in Under-Payments
                    </div>
                  </div>
                );
              }
              return (
                <div style={{ ...confirmRow, padding: '10px 12px', background: '#fef2f2', borderRadius: 8 }}>
                  <span style={{ fontWeight: 700, color: '#b91c1c' }}>Unpaid Balance</span>
                  <strong style={{ color: '#991b1b' }}>−{fmtUSD(confirm.unpaidBalance)}</strong>
                </div>
              );
            })()}
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
// v1.8.86 — read-only payment cells in the History tab.
const roBox = { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0f172a', display: 'flex', flexDirection: 'column', gap: 2 };
const roLbl = { fontSize: 10, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 };
