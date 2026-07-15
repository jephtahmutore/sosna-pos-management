// Global currency provider. Loads the tenant's configured currencies from settings once,
// then exposes them via the useCurrency() hook so every page can render a price using the
// primary symbol without round-tripping to the server.
//
//   const { symbol, primary, currencies, money } = useCurrency();
//   money(12.5)  // → "$12.50"  (uses primary symbol + 2 decimals)
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { getSettings } from '../services/api';

const DEFAULTS = [{ code: 'USD', symbol: '$', is_primary: true }];
const K_DEFAULTS = [{ code: 'ZMW', symbol: 'K', is_primary: true }];

// v1.10.183 — remember the last-known settings per hostname so a returning
// user on a K-only Liquor branch (Mansa/Lusaka) opens straight into 'K'
// instead of the blank loading screen. Kassumbalesa (tri-currency) still
// gets the loading blocker because a wrong-tenant flash there is worse
// (USD/FRA/K columns → Cash/MoMo/Bank columns would visibly jump).
const CACHE_KEY = 'currencyCtx.cache';
const readCache = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.host === (typeof window !== 'undefined' ? window.location.hostname : '')) {
      return parsed;
    }
    return null;
  } catch { return null; }
};
const writeCache = (data) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, host: window.location.hostname }));
  } catch { /* ignore */ }
};

const CurrencyContext = createContext({
  currencies: DEFAULTS,
  primary: DEFAULTS[0],
  symbol: '$',
  money: (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  // Per-branch feature gates loaded from business_settings:
  //   workflowMode — 'single_pos' | 'three_station' (drives Cashier/Dispatch sidebar)
  //   currencyMode — 'K' | 'USD+FRA' (drives dual-currency UI)
  //   legacyProcurementEnabled — re-exposes GRN + Suppliers on branch sidebar
  //                              (off by default since v1.3.2 lockdown)
  workflowMode: 'single_pos',
  currencyMode: 'K',
  // v1.9.26 — third dial. 'cash_only' (Sosna multi-currency cash) vs
  // 'cash_momo_bank' (Liquor-style). Used to gate the Pay modal columns
  // and the Cash Report cashier panels.
  paymentMethods: 'cash_momo_bank',
  legacyProcurementEnabled: false,
  refresh: () => {},
});

function parseCurrencies(raw) {
  if (!raw) return DEFAULTS;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* fall through */ }
  return DEFAULTS;
}

export const CurrencyProvider = ({ children }) => {
  // v1.10.183 — read the cached settings once at mount. When cache says
  // isLiquorStyle we seed with 'K' and skip the loading blocker so the
  // page renders instantly. Kassumbalesa (tri-currency) has no cache OR
  // its cached isLiquorStyle is false — falls back to the v1.10.127
  // loading-blocker path so column layouts don't visibly jump.
  const cache = readCache();
  const cachedLiquor = !!(cache && cache.isLiquorStyle);

  const [currencies, setCurrencies] = useState(cachedLiquor ? K_DEFAULTS : DEFAULTS);
  const [workflowMode, setWorkflowMode] = useState(cache?.workflowMode || 'single_pos');
  const [currencyMode, setCurrencyMode] = useState(cachedLiquor ? 'K' : (cache?.currencyMode || 'K'));
  const [paymentMethods, setPaymentMethods] = useState(cachedLiquor ? 'cash_momo_bank' : (cache?.paymentMethods || 'cash_momo_bank'));
  const [legacyProcurementEnabled, setLegacyProcurementEnabled] = useState(!!cache?.legacyProcurementEnabled);
  // Skip the loading blocker for cached Liquor branches — page renders
  // straight into 'K' without a blank flash. Kassumbalesa keeps the
  // blocker because a USD/FRA/K → Cash/MoMo/Bank column jump reads badly.
  const [loading, setLoading] = useState(!cachedLiquor);

  const refresh = useCallback(async () => {
    // Skip the API call when the user isn't logged in — otherwise the 401 response
    // triggers the auto-logout interceptor and we land in a redirect loop on /login.
    if (!localStorage.getItem('token')) return;
    try {
      const res = await getSettings();
      const biz = res.data?.business || {};
      const parsedCurrencies = parseCurrencies(biz.currencies_json);
      setCurrencies(parsedCurrencies);
      const wm = String(biz.workflow_mode || 'single_pos').toLowerCase();
      const workflow = ['three_station', 'two_station'].includes(wm) ? wm : 'single_pos';
      setWorkflowMode(workflow);
      // v1.7.0: third value 'USD+FRA+K' enables triple-currency cash at till.
      const cmRaw = String(biz.currency_mode || 'K').toUpperCase();
      const cm = ['USD+FRA+K', 'USD+FRA'].includes(cmRaw) ? cmRaw : 'K';
      setCurrencyMode(cm);
      const pmRaw = String(biz.payment_methods || 'cash_momo_bank').toLowerCase();
      const pm = ['cash_only', 'cash_momo_bank'].includes(pmRaw) ? pmRaw : 'cash_momo_bank';
      setPaymentMethods(pm);
      const legacyProc = !!parseInt(biz.legacy_procurement_enabled || 0, 10);
      setLegacyProcurementEnabled(legacyProc);
      // v1.10.183 — persist settings for the next mount so Liquor
      // branches skip the loading blocker on subsequent page loads.
      writeCache({
        currencyMode: cm, paymentMethods: pm,
        workflowMode: workflow, legacyProcurementEnabled: legacyProc,
        isLiquorStyle: cm === 'K' && pm === 'cash_momo_bank',
      });
    } catch { /* keep defaults */ }
  }, []);

  useEffect(() => {
    (async () => {
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const primary = currencies.find(c => c.is_primary) || currencies[0] || DEFAULTS[0];
  const symbol = primary.symbol;
  const money = (n) => `${symbol}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <CurrencyContext.Provider value={{
      currencies, primary, symbol, money,
      workflowMode, currencyMode, paymentMethods,
      // v1.9.27 — one switch every Liquor-vs-Sosna page reads. True for
      // K-only branches that accept Cash + MoMo + Bank (Mansa, Lusaka);
      // false for Sosna multi-currency cash branches (Kassumbalesa).
      isLiquorStyle: currencyMode === 'K' && paymentMethods === 'cash_momo_bank',
      legacyProcurementEnabled,
      refresh,
    }}>
      {loading ? (
        // v1.10.127 — brief blank until settings arrive; prevents the
        // wrong-tenant flash. Kept intentionally minimal so on fast fetches
        // it's imperceptible; on slow (cold pm2) it just shows blank.
        <div style={{ position: 'fixed', inset: 0, background: '#f8fafc' }} />
      ) : children}
    </CurrencyContext.Provider>
  );
};

export const useCurrency = () => useContext(CurrencyContext);
