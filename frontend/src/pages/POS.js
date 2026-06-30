import React, { useState, useEffect, useRef } from 'react';
import { getInventory, createOrder, getSettings, openCashDrawer, printReceipt, getQuickItems, addQuickItem, removeQuickItem, getCustomers, createDiscountRequest, getDiscountRequest, cancelDiscountRequest, getCurrentFxRate, triggerSyncNow } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiShoppingCart, FiX, FiDollarSign, FiUnlock, FiStar, FiFileText, FiTag } from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import { unitsForProduct, pickDisplayUnit, displayInDefaultUnit } from '../utils/productUnits';
import printHtml from '../utils/printHtml';
const API_BASE = process.env.REACT_APP_API_URL?.replace('/api', '') || 'http://localhost:5300';

const getCategoryClass = () => 'badge-gray';

// Phone-only layout switch (single-column catalog + cart bottom sheet).
// Desktop / tablet keep the existing side-by-side layout.
const useIsMobile = (breakpoint = 768) => {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
};

// Single source of truth for "is this cart line sold in a non-default unit?".
// Used in four places (cart card, on-screen receipt modal, thermal print
// payload, window.open HTML fallback) — having one helper keeps the four
// surfaces from drifting (which is exactly how we shipped the `**` bug
// where pcs was flagged but `6 Pack` wasn't).
//
// True when the product has >1 available unit AND the chosen unit differs
// from the product's `default_unit_name` (the unit displayed on the card
// price line, e.g. "$600 / box"). NOT `base_unit` — that's the smallest
// tracked storage unit and is usually different from the default sale unit.
const isNonDefaultUnit = (it) =>
  !!(it
    && it.default_unit_name
    && it.unit
    && it.unit !== it.default_unit_name
    && (it.available_units?.length || 1) > 1);

const POS = () => {
  const { user } = useAuth();
  const { symbol: curSym, money } = useCurrency();
  const isMobile = useIsMobile();
  // Whether the cart bottom-sheet is expanded on mobile. Desktop ignores this.
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  // Format a number with thousands separator + 2 decimals (no currency symbol).
  // Use this anywhere we need just the number (e.g. inside template literals
  // for printed HTML where money() can't be called cleanly).
  const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [cart, setCart] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [discount, setDiscount] = useState(0);
  const [discountModal, setDiscountModal] = useState(null); // { target:'line'|'cart', cartIdx, draft, submitting, pendingSyncId, verdict:'rejected'|null, rejectionReason, error } or null
  // Split payment methods. amountReceived = cashIn + momoIn + bankIn (derived).
  const [cashIn, setCashIn] = useState('');
  const [momoIn, setMomoIn] = useState('');
  const [bankIn, setBankIn] = useState('');
  const [numpadField, setNumpadField] = useState('cash'); // which input the numpad edits
  const amountReceived = (parseFloat(cashIn || 0) + parseFloat(momoIn || 0) + parseFloat(bankIn || 0)).toFixed(2);
  const setAmountReceived = (v) => { setCashIn(v || ''); setMomoIn(''); setBankIn(''); };
  const [businessName, setBusinessName] = useState('Sosna');
  // System Settings → "Block selling beyond available stock". When true,
  // tapping out-of-stock products and overcharging the cart qty edit modal
  // are both blocked. Default false preserves the legacy oversell flow.
  const [blockOversell, setBlockOversell] = useState(false);
  // Currency mode (Phase 2 gate). 'K' = single Kwacha flow (lusaka1, mansa1).
  // 'USD+FRA' = dual-currency flow (kassumbalesa1) — unlocks the Cash FRA
  // receive field and the Change USD / Change FRA split on the Pay modal.
  // v1.9.26 — payment_methods is the third dial. 'cash_only' hides the
  // MoMo + Bank columns on the Pay modal; 'cash_momo_bank' shows all
  // three. Independent of currency_mode + workflow_mode.
  const [paymentMethods, setPaymentMethods] = useState('cash_momo_bank');
  const hasMoMoBank = paymentMethods === 'cash_momo_bank';
  // Loaded from business_settings.currency_mode on mount; defaults to 'K'
  // so a fresh tenant or older API stays single-currency.
  const [currencyMode, setCurrencyMode] = useState('K');
  // isDual = any mode that accepts USD/FRA at the till (USD+FRA dual or
  // USD+FRA+K triple). K-only branches keep it false.
  const isDual = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  // Workflow mode (Phase A gate). 'single_pos' = one cashier creates + pays
  // + dispatches in one step (lusaka1, mansa1 — default). 'three_station' =
  // Sales creates the order → Cashier collects payment → Dispatch releases
  // goods (kassumbalesa1). When three_station, this POS screen IS the Sales
  // station: the Pay button becomes "Confirm & Send to Cashier" and no
  // payment modal opens — the order is saved with status='PENDING_PAYMENT'
  // and lands in the Cashier inbox.
  const [workflowMode, setWorkflowMode] = useState('single_pos');
  // v1.6.6: 2-station + 3-station both use the Sales → Cashier handoff.
  // POS button becomes "Confirm & Send to Cashier" for both modes; the
  // ONLY difference between them is whether stock deducts at Cashier
  // (2-station) or at a separate Dispatch step (3-station). single_pos
  // keeps the inline Pay modal — one cashier does everything.
  const isThreeStation = workflowMode === 'three_station';
  const sendsToCashier = workflowMode === 'three_station' || workflowMode === 'two_station';
  // FX rates: read from Accounting → Currency Rates (table fx_rates).
  // Falls back to 2900 / 2600 when no row exists yet, so a fresh dual-
  // currency branch still functions out-of-the-box.
  //   SELL_RATE = FRA shop RECEIVES from customer (paidFRA / SELL_RATE)
  //   BUY_RATE  = FRA shop GIVES BACK as change   (changeFRA / BUY_RATE)
  const [fxRate, setFxRate] = useState({ sell: 2900, buy: 2600, sellK: 0, buyK: 0 });
  const SELL_RATE   = fxRate.sell;
  const BUY_RATE    = fxRate.buy;
  const SELL_RATE_K = fxRate.sellK;
  const BUY_RATE_K  = fxRate.buyK;
  const hasK        = SELL_RATE_K > 0;
  const [businessPhone, setBusinessPhone] = useState('');
  const [businessAddress, setBusinessAddress] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);
  const [receiptData, setReceiptData] = useState(null);
  const [showChangeBanner, setShowChangeBanner] = useState(false);
  const [barcodeMsg, setBarcodeMsg] = useState(null); // { text, type: 'error'|'success' }
  const [scannerActive, setScannerActive] = useState(true);
  const [drawerMsg, setDrawerMsg] = useState(null);
  const [showNumpad, setShowNumpad] = useState(false);
  const [numpadValue, setNumpadValue] = useState('');
  const [contextMenu, setContextMenu] = useState(null); // { x, y, item }
  const [qtyEdit, setQtyEdit] = useState(null);         // { item, value }
  // v1.8.38 — Qty-on-add modal. Replaces the old "tap a product → 1 added
  // to cart instantly" with "tap a product → small modal asks for qty
  // first". Less mis-clicks, less corrective +/- in the cart.
  // Shape: { product, unit, value } where unit is the unit name to add.
  const [qtyOnAdd, setQtyOnAdd] = useState(null);
  const [quickItems, setQuickItems] = useState([]);
  const [quickSyncIds, setQuickSyncIds] = useState(new Set());
  const [customers, setCustomers] = useState([]);
  const [creditModal, setCreditModal] = useState(null); // { usd, fra, k } — triple-currency Sosna
  // Account-summary collapsible inside Credit Sale modal. Auto-expands when
  // the projected outstanding would exceed the customer's credit limit, so the
  // cashier always sees the reason if Confirm is disabled.
  const [showCreditSummary, setShowCreditSummary] = useState(false);
  // Walk-in customer payment modal — same split-payment UX as credit sale but without the credit projection.
  const [payModal, setPayModal] = useState(null); // { cash, momo, bank }

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(
    showNumpad || !!payModal || !!creditModal || showReceipt ||
    !!contextMenu || !!qtyEdit || !!qtyOnAdd || !!discountModal
  );

  // Auto-close the mobile cart sheet when the cart goes empty (sale just
  // completed, or user tapped Clear). Also close it when any payment modal
  // opens — those modals render on top of the catalog, not over the sheet.
  useEffect(() => {
    if (!isMobile) return;
    if (cart.length === 0) setMobileCartOpen(false);
  }, [cart.length, isMobile]);
  useEffect(() => {
    if (!isMobile) return;
    if (payModal || creditModal) setMobileCartOpen(false);
  }, [payModal, creditModal, isMobile]);
  // Administrator-only back-dated sale support. Defaults to today (laptop date,
  // shown for visual feedback) but the backend re-validates the role.
  const isAdmin = user?.role === 'Administrator';
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const [saleDate, setSaleDate] = useState(todayStr());
  const barcodeBuffer = useRef('');
  const customerChannel = useRef(null);
  // Cart list scroll target — used to auto-scroll the cart so the most-recent
  // item is always visible when the cashier adds another one.
  const cartListRef = useRef(null);
  const prevCartLenRef = useRef(0);
  const suppressCartBroadcast = useRef(false);

  // BroadcastChannel to customer display
  useEffect(() => {
    customerChannel.current = new BroadcastChannel('customer_display');
    return () => customerChannel.current?.close();
  }, []);

  // Send business name to customer display whenever it loads
  useEffect(() => {
    if (!customerChannel.current || !businessName) return;
    customerChannel.current.postMessage({ type: 'business_info', businessName });
  }, [businessName]); // eslint-disable-line

  // Send cart to customer display whenever cart changes
  useEffect(() => {
    if (!customerChannel.current) return;
    if (cart.length === 0) {
      if (suppressCartBroadcast.current) { suppressCartBroadcast.current = false; return; }
      customerChannel.current.postMessage({ type: 'cart_clear' });
    } else {
      customerChannel.current.postMessage({ type: 'cart_update', items: cart, total });
    }
  }, [cart]); // eslint-disable-line

  // Send payment received to customer display when amount changes
  useEffect(() => {
    if (!customerChannel.current) return;
    const amt = parseFloat(amountReceived || 0);
    if (amt > 0) {
      customerChannel.current.postMessage({ type: 'payment_received', amount: amt, total });
    }
  }, [amountReceived]); // eslint-disable-line

  // Keyboard input for numpad modal
  useEffect(() => {
    if (!showNumpad) return;
    const handler = (e) => {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        setNumpadValue(prev => prev === '0' ? e.key : prev + e.key);
      } else if (e.key === '.' || e.key === ',') {
        e.preventDefault();
        setNumpadValue(prev => prev.includes('.') ? prev : prev + '.');
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setNumpadValue(prev => prev.slice(0, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const setter = numpadField === 'momo' ? setMomoIn : numpadField === 'bank' ? setBankIn : setCashIn;
        setter(numpadValue || '0');
        setShowNumpad(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowNumpad(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showNumpad, numpadValue]);

  // Close context menu on any click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => { window.removeEventListener('click', close); };
  }, [contextMenu]);

  const barcodeTimer = useRef(null);

  // Track whether an input is focused — update scannerActive accordingly
  useEffect(() => {
    const onFocusIn = (e) => {
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        setScannerActive(false);
        barcodeBuffer.current = '';
        if (barcodeTimer.current) clearTimeout(barcodeTimer.current);
      }
    };
    const onFocusOut = (e) => {
      setTimeout(() => {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
          setScannerActive(true);
        }
      }, 0);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const handleOpenDrawer = async () => {
    try {
      await openCashDrawer();
      setDrawerMsg({ type: 'success', text: 'Drawer opened' });
    } catch {
      setDrawerMsg({ type: 'error', text: 'Failed to open drawer' });
    }
    setTimeout(() => setDrawerMsg(null), 2500);
  };

  const focusScanner = () => {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    setScannerActive(true);
    barcodeBuffer.current = '';
  };

  // Barcode scanner: accumulate keystrokes, match on Enter
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Block scanner when an input/textarea/select is focused
      const tag = document.activeElement?.tagName?.toLowerCase();
      const isTypingField = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (isTypingField) return;

      if (e.key === 'Enter') {
        const rawCode = barcodeBuffer.current.trim();
        barcodeBuffer.current = '';
        if (barcodeTimer.current) clearTimeout(barcodeTimer.current);
        if (!rawCode) return;

        let found = null;
        let weight = null;

        // 1) Try each product's configured UB barcode settings (weight-embedded barcodes)
        for (const p of products) {
          const qLen = parseInt(p.ub_quantity_length || 0);
          if (qLen === 0) continue; // no weight barcode configured for this product

          const numStart = parseInt(p.ub_number_start  ?? 1);
          const numLen   = parseInt(p.ub_number_length  ?? 6);
          if (rawCode.length < numStart + numLen) continue;

          const extractedCode = rawCode.substring(numStart, numStart + numLen);
          if (p.code && extractedCode.toLowerCase() === p.code.trim().toLowerCase()) {
            // Code matched — extract weight using this product's settings
            const qStart   = parseInt(p.ub_quantity_start ?? 7);
            const decStart = parseInt(p.ub_decimal_start   ?? 2);
            const weightStr = rawCode.substring(qStart, qStart + qLen);
            if (weightStr.length === qLen) {
              const formatted = weightStr.substring(0, decStart) + '.' + weightStr.substring(decStart);
              weight = parseFloat(formatted);
              found = p;
              break;
            }
          }
        }

        // 2) If no weight-barcode match, fall back to direct product code match
        if (!found) {
          found = products.find(p => p.code && p.code.trim().toLowerCase() === rawCode.toLowerCase());
        }

        if (found) {
          addToCart(found, weight !== null ? weight : 1);
          const label = weight !== null ? `${found.name} — ${weight.toFixed(3)} ${found.unit}` : found.name;
          showBarcodeMsg(`Added: ${label}`, 'success');
        } else {
          showBarcodeMsg('No Item found', 'error');
        }
        return;
      }

      // Accumulate characters — only if not a modifier key
      if (e.key.length === 1) {
        barcodeBuffer.current += e.key;
        // Reset buffer after 100ms of inactivity (scanner sends chars very fast)
        if (barcodeTimer.current) clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => {
          barcodeBuffer.current = '';
        }, 100);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (barcodeTimer.current) clearTimeout(barcodeTimer.current);
    };
  }, [products]);

  const showBarcodeMsg = (text, type) => {
    setBarcodeMsg({ text, type });
    setTimeout(() => setBarcodeMsg(null), 3000);
  };

  // Reset the Credit Sale account-summary collapse whenever the modal opens
  // fresh, so each new sale starts collapsed (the over-limit auto-expand still
  // overrides this — see `summaryOpen` derivation inside the modal).
  useEffect(() => {
    if (creditModal) setShowCreditSummary(false);
  }, [creditModal]);

  // Keep the cart list scrolled so the newest item is visible. Only triggers
  // when an item was just ADDED — qty edits or removals don't scroll, so the
  // cashier doesn't lose their place when they're editing an existing row.
  useEffect(() => {
    if (cart.length > prevCartLenRef.current && cartListRef.current) {
      cartListRef.current.scrollTop = cartListRef.current.scrollHeight;
    }
    prevCartLenRef.current = cart.length;
  }, [cart.length]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await getInventory();
        if (res.data?.length > 0) {
          // v1.5.0: hide HQ-pushed items that the branch hasn't set a
          // selling price on yet, and hide anything explicitly Inactive.
          // Without a price, POS would compute $0 totals — better to keep
          // the item out of the catalogue until the branch sets a price.
          const sellable = res.data.filter(p =>
            p.product_type !== 'raw_material' &&
            (p.status || 'Active') === 'Active' &&
            parseFloat(p.selling_price || 0) > 0
          );
          setProducts(sellable);
          const unique = [...new Set(sellable.map(p => p.category_name).filter(Boolean))].sort();
          setCategories(unique);
        }
      } catch (err) { /* use defaults */ }
      try {
        const res = await getSettings();
        if (res.data?.business?.business_name)    setBusinessName(res.data.business.business_name);
        if (res.data?.business?.business_phone)   setBusinessPhone(res.data.business.business_phone);
        if (res.data?.business?.business_address) setBusinessAddress(res.data.business.business_address);
        setBlockOversell(!!res.data?.business?.block_oversell);
        const cm = String(res.data?.business?.currency_mode || 'K').toUpperCase();
        setCurrencyMode(['USD+FRA', 'USD+FRA+K'].includes(cm) ? cm : 'K');
        const wm = String(res.data?.business?.workflow_mode || 'single_pos').toLowerCase();
        setWorkflowMode(['three_station', 'two_station'].includes(wm) ? wm : 'single_pos');
        const pm = String(res.data?.business?.payment_methods || 'cash_momo_bank').toLowerCase();
        setPaymentMethods(['cash_only', 'cash_momo_bank'].includes(pm) ? pm : 'cash_momo_bank');
      } catch (err) { /* use default */ }
      try {
        const res = await getQuickItems();
        const qi = res.data || [];
        setQuickItems(qi);
        setQuickSyncIds(new Set(qi.map(q => q.product_sync_id)));
      } catch (err) { /* ignore */ }
      try {
        const res = await getCustomers();
        setCustomers(res.data || []);
      } catch (err) { /* ignore */ }
      try {
        const res = await getCurrentFxRate();
        if (res.data && res.data.sell_rate > 0 && res.data.buy_rate > 0) {
          setFxRate({
            sell:  parseFloat(res.data.sell_rate),
            buy:   parseFloat(res.data.buy_rate),
            sellK: parseFloat(res.data.sell_rate_k || 0) || 0,
            buyK:  parseFloat(res.data.buy_rate_k  || 0) || 0,
          });
        }
      } catch (err) { /* keep fallback */ }
    };
    fetchData();
  }, []);

  const refreshCustomers = async () => {
    try { const res = await getCustomers(); setCustomers(res.data || []); } catch { /* ignore */ }
  };

  const toggleQuickItem = async (product) => {
    const syncId = product.sync_id;
    if (!syncId) return;
    if (quickSyncIds.has(syncId)) {
      await removeQuickItem(syncId).catch(() => {});
      setQuickItems(prev => prev.filter(q => q.product_sync_id !== syncId));
      setQuickSyncIds(prev => { const s = new Set(prev); s.delete(syncId); return s; });
    } else {
      await addQuickItem(syncId).catch(() => {});
      const res = await getQuickItems().catch(() => ({ data: [] }));
      const qi = res.data || [];
      setQuickItems(qi);
      setQuickSyncIds(new Set(qi.map(q => q.product_sync_id)));
    }
  };

  // v1.6.7: hide items with no sales-floor stock (sales_balance <= 0) and
  // tag low-stock items so the tile renders in red. Threshold = product's
  // min_stock if set, else 10.
  const filteredProducts = products.filter(p => {
    const hasSalesStock = parseFloat(p.sales_balance || 0) > 0;
    const matchCategory = selectedCategory === 'All' || p.category_name === selectedCategory;
    const words = search.toLowerCase().split(' ').filter(Boolean);
    const matchSearch = words.length === 0 || words.every(w => p.name.toLowerCase().includes(w) || (p.code || '').toLowerCase().includes(w));
    return matchCategory && matchSearch && hasSalesStock;
  });

  // How many base units of `product` are currently committed across ALL cart
  // lines (same product, any unit). Used by the stock guard to know what's
  // still available before adding more.
  const cartBaseConsumed = (productId, cartArr = cart) => cartArr
    .filter(item => item.product_id === productId)
    .reduce((sum, item) => {
      const conv = parseFloat(item.conversion_factor || 0);
      const isAlt = !!(item.alt_unit && item.unit === item.alt_unit);
      // Base unit line → qty is already in base. Alt unit → multiply.
      const inBase = isAlt && conv > 0 ? parseFloat(item.quantity) * conv : parseFloat(item.quantity);
      return sum + (isNaN(inBase) ? 0 : inBase);
    }, 0);

  // Remaining base units available for `product` after accounting for other
  // cart lines. Returns Infinity when the toggle is OFF so callers can
  // treat the cap as "no limit".
  const remainingBaseForProduct = (product, excludeCartIdx = -1) => {
    if (!blockOversell) return Infinity;
    if (!product) return Infinity;
    const balance = parseFloat(product.sales_balance || 0);
    const used = cart.reduce((sum, item, idx) => {
      if (idx === excludeCartIdx) return sum;
      if (item.product_id !== product.id) return sum;
      const conv = parseFloat(item.conversion_factor || 0);
      const isAlt = !!(item.alt_unit && item.unit === item.alt_unit);
      const inBase = isAlt && conv > 0 ? parseFloat(item.quantity) * conv : parseFloat(item.quantity);
      return sum + (isNaN(inBase) ? 0 : inBase);
    }, 0);
    return Math.max(0, balance - used);
  };

  const addToCart = (product, qty = 1, forceUnit = null) => {
    // v1.8.38 — search is no longer auto-cleared on add. User now
    // controls clearing via the new Clear button beside the input,
    // so multiple tap-to-add operations on the same search result
    // don't keep refiltering between every add.
    // ── Stock guard (job 1) ─────────────────────────────────────────────
    // Two checks gated on the System Settings toggle:
    //  (a) refuse entirely when sales_balance <= 0;
    //  (b) refuse when adding `qty` would push the cart past available.
    if (blockOversell) {
      const balance = parseFloat(product.sales_balance || 0);
      if (balance <= 0) {
        setBarcodeMsg({ text: `${product.name} is out of stock`, type: 'error' });
        setTimeout(() => setBarcodeMsg(null), 2500);
        return;
      }
      // Figure out how much base this add will consume.
      const units = unitsForProduct(product);
      const picked = (forceUnit && units.find(u => u.name === forceUnit)) || pickDisplayUnit(product);
      const conv = parseFloat(picked.conv || 1) || 1;
      const isBase = !!picked.is_base || conv === 1;
      const addingBase = isBase ? qty : qty * conv;
      const used = cartBaseConsumed(product.id);
      if (used + addingBase > balance + 0.0001) {
        const remainingBase = Math.max(0, balance - used);
        const remainingInPicked = isBase ? remainingBase : remainingBase / conv;
        setBarcodeMsg({
          text: `Only ${parseFloat(remainingInPicked.toFixed(3))} ${picked.name} left for ${product.name}`,
          type: 'error',
        });
        setTimeout(() => setBarcodeMsg(null), 2500);
        return;
      }
    }
    setCart(prev => {
      const units = unitsForProduct(product);
      const base = units.find(u => u.is_base) || units[0];
      // Explicit unit (chip click) wins; otherwise use the smart display unit
      // (default_unit if set, else the largest non-base unit, else base).
      const picked = (forceUnit && units.find(u => u.name === forceUnit))
        || pickDisplayUnit(product);
      // Only merge if same product AND same unit; allow same product in cart twice with different units
      const existing = prev.find(item => item.product_id === product.id && item.unit === picked.name);
      if (existing) {
        const newQty = parseFloat((existing.quantity + qty).toFixed(3));
        return prev.map(item => (item.product_id === product.id && item.unit === picked.name)
          ? { ...item, quantity: newQty, total_price: parseFloat((newQty * (item.unit_price - (item.discount || 0))).toFixed(2)) }
          : item);
      }
      // Capture the product's display ("default") unit so the cart can flag
      // lines sold in a non-default unit (e.g. default Box but sold in pcs).
      const defaultDisp = pickDisplayUnit(product);
      return [...prev, {
        product_id:        product.id,
        product_name:      product.name,
        unit_price:        picked.price,
        quantity:          parseFloat(qty.toFixed(3)),
        discount:          0,           // per-unit Kwacha discount (off unit_price)
        total_price:       parseFloat((qty * picked.price).toFixed(2)),
        unit:              picked.name,
        // Multi-unit support — every available packaging the product was configured with.
        available_units:   units,
        base_unit:         base.name,
        base_price:        base.price,
        default_unit_name: defaultDisp.name,
        // Legacy fields kept so older code paths (receipt rendering) still work.
        alt_unit:          (units.find(u => !u.is_base)?.name) || null,
        alt_price:         (units.find(u => !u.is_base)?.price) ?? null,
        conversion_factor: (units.find(u => !u.is_base)?.conv) ?? null,
      }];
    });
  };

  // Switch a cart line to a different unit. Looks up the new unit in the cart item's
  // available_units (set when the product was added to cart).
  // Set the per-unit discount on a specific cart line. Triggers total recalc.
  const setLineDiscount = (cartIdx, value) => {
    setCart(prev => prev.map((item, i) => {
      if (i !== cartIdx) return item;
      // v1.8.57 — allow negative "discount" = markup. Effective unit
      // price = unit_price − d (so d>0 reduces, d<0 increases). Still
      // floor the effective price at 0 to prevent a negative line total.
      const d = parseFloat(value) || 0;
      const effective = Math.max(0, item.unit_price - d);
      return { ...item, discount: d, total_price: parseFloat((item.quantity * effective).toFixed(2)) };
    }));
  };

  // Poll a pending discount request every 3 s. Applies the discount + closes
  // the modal on 'approved'; switches to the rejected panel on 'rejected'.
  // Stops when the modal is closed or the verdict has landed.
  useEffect(() => {
    const syncId = discountModal?.pendingSyncId;
    if (!syncId || discountModal?.verdict) return;
    let cancelled = false;
    let ticks = 0;
    const tick = async () => {
      try {
        // v1.9.4 — on every other tick (~6s cadence) ask the sync engine to
        // run a cycle. Cheap call (200 OK + maybe queues a push+pull) and
        // means the admin's approval lands on this Electron in seconds
        // instead of waiting up to 30s for the next scheduled pull.
        ticks += 1;
        if (ticks > 1 && ticks % 2 === 0) triggerSyncNow();

        const res = await getDiscountRequest(syncId);
        if (cancelled) return;
        const st = res.data?.status;
        if (st === 'approved') {
          if (discountModal.target === 'cart') {
            setDiscount(parseFloat(discountModal.draft) || 0);
          } else {
            // v1.8.98 — draft is the NEW PRICE for line target. Convert to
            // discount delta = original unit_price − new_price so the cart's
            // existing total math (unit_price − discount) produces the right
            // figure. Read the original from the cart at apply-time (not from
            // res.data) so we don't apply against stale state.
            const line = cart[discountModal.cartIdx];
            if (line) {
              const newPrice = parseFloat(discountModal.draft) || 0;
              setLineDiscount(discountModal.cartIdx, line.unit_price - newPrice);
            }
          }
          setDiscountModal(null);
        } else if (st === 'rejected') {
          setDiscountModal(d => d ? { ...d, verdict: 'rejected', rejectionReason: res.data?.rejection_reason || '' } : d);
        }
      } catch (e) { /* keep polling — transient errors shouldn't kill the wait */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [discountModal?.pendingSyncId, discountModal?.verdict]); // intentionally narrow deps — modal target/draft are stable for a given pending request

  const switchCartUnit = (cartIdx, newUnit) => {
    setCart(prev => prev.map((item, i) => {
      if (i !== cartIdx) return item;
      const u = (item.available_units || []).find(x => x.name === newUnit);
      const newPrice = u ? u.price : item.base_price;
      return {
        ...item,
        unit: newUnit,
        unit_price: parseFloat(newPrice),
        total_price: parseFloat((item.quantity * (parseFloat(newPrice) - (item.discount || 0))).toFixed(2)),
      };
    }));
  };

  // The cart can hold the same product twice in different units, so all line-level
  // mutators key off the cart key (product_id + unit), not just product_id.
  const updateQty = (productId, unit, delta) => {
    setCart(prev => prev.map(item => {
      if (item.product_id === productId && item.unit === unit) {
        const newQty = parseFloat((Math.max(0, item.quantity + delta)).toFixed(3));
        if (newQty === 0) return null;
        return { ...item, quantity: newQty, total_price: parseFloat((newQty * (item.unit_price - (item.discount || 0))).toFixed(2)) };
      }
      return item;
    }).filter(Boolean));
  };

  const setItemQty = (productId, unit, value) => {
    const qty = parseFloat(value);
    if (isNaN(qty) || qty <= 0) {
      setCart(prev => prev.filter(item => !(item.product_id === productId && item.unit === unit)));
      return;
    }
    const q = parseFloat(qty.toFixed(3));
    setCart(prev => prev.map(item =>
      (item.product_id === productId && item.unit === unit)
        ? { ...item, quantity: q, total_price: parseFloat((q * (item.unit_price - (item.discount || 0))).toFixed(2)) }
        : item
    ));
  };

  const removeItem = (productId, unit) => {
    setCart(prev => prev.filter(item => !(item.product_id === productId && item.unit === unit)));
  };

  const subtotal = cart.reduce((sum, item) => sum + item.total_price, 0);
  // v1.8.57 — `discount` can be negative (markup). subtotal − discount:
  //   positive discount → reduces total (sale)
  //   negative discount → increases total (markup)
  // Floor at 0 so a runaway discount can't produce a negative total.
  const total = Math.max(0, subtotal - parseFloat(discount || 0));
  const change = Math.max(0, parseFloat(amountReceived || 0) - total);

  // Mirror the Pay / Credit Sale modal's running total (Cash + MoMo + Bank)
  // to the customer display as they type. Without this, the customer display
  // sits on the cart screen and never shows what they're paying or what
  // their change will be once payment is complete.
  // NOTE: this useEffect must live AFTER `total` is declared — it appears in
  // the dependency array, which is evaluated at call site; declaring useEffect
  // before `total` hits a temporal-dead-zone ReferenceError on first render
  // (minified to "Cannot access 'pt' before initialization").
  useEffect(() => {
    if (!customerChannel.current) return;
    const m = payModal || creditModal;
    if (!m) return;
    // Pay modal still uses legacy {cash, momo, bank}; Credit Sale uses {usd, fra, k}.
    let payNow;
    if (creditModal) {
      if (hasMoMoBank) {
        // v1.9.30 — Liquor branches use Cash/MoMo/Bank inputs.
        payNow = Math.max(0, (parseFloat(creditModal.cash || 0) + parseFloat(creditModal.momo || 0) + parseFloat(creditModal.bank || 0)));
      } else {
        const usd  = parseFloat(creditModal.usd || 0) || 0;
        const fra  = parseFloat(creditModal.fra || 0) || 0;
        const kAmt = parseFloat(creditModal.k   || 0) || 0;
        const fraUSD = SELL_RATE   > 0 ? fra  / SELL_RATE   : 0;
        const kUSD   = SELL_RATE_K > 0 ? kAmt / SELL_RATE_K : 0;
        payNow = Math.max(0, usd + fraUSD + kUSD);
      }
    } else {
      payNow = Math.max(0, (parseFloat(m.cash || 0) + parseFloat(m.momo || 0) + parseFloat(m.bank || 0)));
    }
    customerChannel.current.postMessage({ type: 'payment_received', amount: payNow, total });
  }, [payModal?.cash, payModal?.momo, payModal?.bank, creditModal?.usd, creditModal?.fra, creditModal?.k, total]); // eslint-disable-line

  // ── Credit-limit check ────────────────────────────────────────────────────
  // Match the typed name against the customer list (exact, case-insensitive).
  const selectedCustomer = customerName
    ? customers.find(c => c.name && c.name.toLowerCase() === customerName.trim().toLowerCase())
    : null;
  const creditLimit       = selectedCustomer ? parseFloat(selectedCustomer.credit_limit || 0) : 0;
  const currentOutstanding= selectedCustomer ? parseFloat(selectedCustomer.outstanding   || 0) : 0;
  const unpaidThisSale    = Math.max(0, total - parseFloat(amountReceived || 0));
  const projectedOutstanding = currentOutstanding + unpaidThisSale;
  const availableCredit   = Math.max(0, creditLimit - currentOutstanding);
  const onHold            = selectedCustomer?.credit_status === 'OnHold';
  const overLimit         = selectedCustomer && creditLimit > 0 && projectedOutstanding > creditLimit + 0.001;
  const creditBlocked     = !!(selectedCustomer && (onHold || overLimit));

  // Keyboard shortcuts — same shape as Butchery POS so cashiers moving
  // between products keep muscle memory.
  //   F11 = open the Pay (walk-in) or Credit Sale (registered customer)
  //         modal with the Cash field pre-filled to the full total.
  //   F12 = if a payment modal is already open → Confirm (mirrors the
  //         button's own disabled rule — never bypasses it). Otherwise →
  //         opens the modal, same as F11.
  //   Enter (modal open)  = Confirm
  //   Escape (modal open) = Cancel + revert customer display to cart
  // preventDefault on F11/F12 so they don't trigger the browser's native
  // fullscreen / devtools shortcuts.
  // NOTE: must live AFTER currentOutstanding/creditLimit/onHold/etc. are
  // declared above — referencing them earlier hit the temporal-dead-zone
  // and crashed POS to a blank screen on first render.
  useEffect(() => {
    const openPaymentModal = () => {
      if (cart.length === 0) return;
      const initialCash = total.toFixed(2);
      if (selectedCustomer) {
        // v1.9.30 — Liquor branches initialise Credit Sale with Cash/MoMo/Bank
        // fields (same shape as the walk-in modal). Sosna keeps USD/FRA/K.
        setCreditModal(hasMoMoBank
          ? { cash: initialCash, momo: '0', bank: '0', usd: '0', fra: '0', k: '0' }
          : { usd: initialCash, fra: '0', k: '0' });
      } else {
        // cashFRA, changeUSDgiven, changeFRAgiven default to '0' so the Pay
        // modal's dual-currency section starts clean even on K-only branches
        // (where those keys are simply unused/hidden).
        setPayModal({ cash: initialCash, momo: '0', bank: '0', cashFRA: '0', changeUSDgiven: '0', changeFRAgiven: '0' });
      }
    };
    const cancelOpenModal = () => {
      if (payModal)    setPayModal(null);
      if (creditModal) setCreditModal(null);
      customerChannel.current?.postMessage({ type: 'cart_update', items: cart, total });
    };
    const confirmOpenModal = () => {
      const m = payModal || creditModal;
      if (!m) return;
      if (payModal) {
        const cashNow = Math.max(0, parseFloat(m.cash || 0));
        const momoNow = Math.max(0, parseFloat(m.momo || 0));
        const bankNow = Math.max(0, parseFloat(m.bank || 0));
        const payNow  = cashNow + momoNow + bankNow;
        // Walk-in: cash sale requires full payment.
        if (payNow < total - 0.001) return;
        setPayModal(null);
        handleCheckout({ cash: cashNow, momo: momoNow, bank: bankNow });
      } else if (creditModal) {
        // v1.9.30 — Liquor branches: collect via Cash/MoMo/Bank and pass the
        // walk-in-shaped override straight through to handleCheckout (it
        // already routes cash/momo/bank into cash_received / momo_received /
        // bank_received columns).
        let payNow;
        let override;
        if (hasMoMoBank) {
          const cashNow = Math.max(0, parseFloat(creditModal.cash || 0));
          const momoNow = Math.max(0, parseFloat(creditModal.momo || 0));
          const bankNow = Math.max(0, parseFloat(creditModal.bank || 0));
          payNow = cashNow + momoNow + bankNow;
          override = { cash: cashNow, momo: momoNow, bank: bankNow };
        } else {
          const usdNow = Math.max(0, parseFloat(creditModal.usd || 0));
          const fraNow = Math.max(0, parseFloat(creditModal.fra || 0));
          const kNow   = Math.max(0, parseFloat(creditModal.k   || 0));
          const fraUSD = SELL_RATE   > 0 ? fraNow / SELL_RATE   : 0;
          const kUSD   = SELL_RATE_K > 0 ? kNow   / SELL_RATE_K : 0;
          payNow = usdNow + fraUSD + kUSD;
          override = { usd: usdNow, fra: fraNow, k: kNow };
        }
        const newCredit = Math.max(0, total - payNow);
        const projected = currentOutstanding + newCredit;
        const over     = creditLimit > 0 && projected > creditLimit + 0.001;
        if (over || onHold) return;
        setCreditModal(null);
        handleCheckout(override);
      }
    };
    const onKey = (e) => {
      // Don't fight with other overlays that have their own keyboard semantics.
      if (showNumpad || showReceipt) return;
      if (e.key === 'F11') {
        e.preventDefault();
        openPaymentModal();
      } else if (e.key === 'F12') {
        e.preventDefault();
        if (payModal || creditModal) confirmOpenModal();
        else openPaymentModal();
      } else if (e.key === 'Enter' && (payModal || creditModal)) {
        e.preventDefault();
        confirmOpenModal();
      } else if (e.key === 'Escape' && (payModal || creditModal)) {
        e.preventDefault();
        cancelOpenModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cart, total, payModal, creditModal, selectedCustomer, currentOutstanding, creditLimit, onHold, showNumpad, showReceipt]); // eslint-disable-line

  // Print via hidden iframe — works on mobile / Capacitor APK / desktop.
  // See utils/printHtml.js for why this beats window.open + w.print().
  const printDirect = (html) => printHtml(html);

  // 3-station Sales station: save the order with status='PENDING_PAYMENT'
  // so it lands in the Cashier inbox. No payment math, no FX, no stock
  // decrement here — stock decrement happens at Dispatch (see project memory
  // [[project-sosna-stock-deduction-timing]]).
  const handleSendToCashier = async () => {
    if (cart.length === 0) return;
    try {
      const res = await createOrder({
        customer_name: customerName,
        customer_id: selectedCustomer ? selectedCustomer.id : null,
        customer_sync_id: selectedCustomer ? selectedCustomer.sync_id : null,
        items: cart,
        subtotal,
        tax_amount: 0,
        total_amount: total,
        discount: parseFloat(discount || 0),
        amount_received: 0,
        cash_received: 0,
        momo_received: 0,
        bank_received: 0,
        change_amount: 0,
        payment_method: 'Pending',
        status: 'PENDING_PAYMENT',
        currency: isDual ? 'USD' : 'K',
        sale_date: (isAdmin && saleDate && saleDate !== todayStr()) ? saleDate : null,
      });

      // Snapshot what we need to print BEFORE clearing the cart.
      const printSnap = {
        orderNumber: res.data?.order_number || '',
        customerName: customerName || 'Walk-in',
        items: [...cart],
        subtotal,
        discount: parseFloat(discount || 0),
        total,
        date: new Date(),
        servedBy: user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'Sales',
      };

      suppressCartBroadcast.current = true;
      setCart([]);
      setCustomerName('');
      setDiscount(0);
      setCashIn(''); setMomoIn(''); setBankIn('');
      setSaleDate(todayStr());
      setBarcodeMsg({ text: 'Order sent to cashier — printing 2 copies.', type: 'success' });
      setTimeout(() => setBarcodeMsg(null), 2500);

      try { customerChannel.current?.postMessage({ type: 'cart_clear' }); } catch {}

      // A4: auto-print 2 copies. We build one HTML doc with the receipt
      // content rendered twice, separated by a page break so the printer
      // outputs both copies in one pass — cashier keeps one, customer
      // walks the other one to Dispatch.
      try { printPendingOrderTwoCopies(printSnap); } catch (_) { /* non-fatal */ }
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to send order to cashier';
      setBarcodeMsg({ text: msg, type: 'error' });
      setTimeout(() => setBarcodeMsg(null), 4000);
    }
  };

  // Render one copy of the Sales-station notification slip (the "Sales Order /
  // Awaiting Payment" receipt). Used by printPendingOrderTwoCopies below to
  // emit two copies in a single print job.
  const renderPendingOrderCopy = (snap, label) => {
    const curSym = '$';
    const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const div = '='.repeat(42);
    // Name + qty only. Per-line PRICE/TOTAL columns removed per redesign.
    const itemsRows = (snap.items || []).map(it => {
      const qty = parseFloat(it.quantity || 0);
      const safeName = String(it.product_name).replace(/</g, '&lt;');
      return `<tr>
                <td>${safeName}</td>
                <td style="text-align:right; white-space:nowrap;">${qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)} ${it.unit || ''}</td>
              </tr>`;
    }).join('');
    const disc = snap.discount > 0
      ? `<tr><td>Discount</td><td></td><td></td><td style="text-align:right;">-${curSym}${fmt(snap.discount)}</td></tr>` : '';
    return `
      <div class="c" style="font-size:14px;font-weight:700;letter-spacing:1px;">${businessName || 'SOSNA'}</div>
      ${businessAddress ? `<div class="c" style="font-size:11px;">${String(businessAddress).replace(/\n/g, '<br/>')}</div>` : ''}
      ${businessPhone ? `<div class="c" style="font-size:11px;">Tel: ${businessPhone}</div>` : ''}
      <div class="divider">${div}</div>
      <div class="c" style="font-weight:700;font-size:12px;">SALES ORDER</div>
      <div class="c" style="font-size:11px;">(Awaiting Payment)</div>
      <div class="c" style="font-size:10px;margin-top:2px;">[${label}]</div>
      <div class="divider">${div}</div>
      <table>
        <tr><td>Order #:</td><td></td><td style="text-align:right;">${snap.orderNumber}</td></tr>
        <tr><td>Date &amp; Time:</td><td></td><td style="text-align:right;">${snap.date.toLocaleDateString('en-GB')} ${snap.date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}</td></tr>
        <tr><td>Customer:</td><td></td><td style="text-align:right;">${snap.customerName}</td></tr>
        <tr><td>Sales by:</td><td></td><td style="text-align:right;">${snap.servedBy}</td></tr>
      </table>
      <div class="divider">${div}</div>
      <table>
        <tr style="font-size:10px;">
          <td style="font-weight:700;">ITEM</td>
          <td style="text-align:right;font-weight:700;">QTY</td>
        </tr>
        ${itemsRows}
      </table>
      <div class="divider">${'-'.repeat(42)}</div>
      <table>
        <tr><td>Subtotal</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(snap.subtotal)}</td></tr>
        ${disc}
      </table>
      <div class="divider">${div}</div>
      <table>
        <tr class="grand"><td>TOTAL DUE</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(snap.total)}</td></tr>
      </table>
      <div class="divider">${div}</div>
      <div class="c" style="margin-top:4px;font-size:11px;">Please present this slip</div>
      <div class="c" style="font-size:11px;">to the cashier for payment.</div>`;
  };

  const printPendingOrderTwoCopies = (snap) => {
    const html = `<!DOCTYPE html>
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
  .gap   { height: 12mm; }
  .copy2 { page-break-before: always; }
</style>
</head>
<body>
  ${renderPendingOrderCopy(snap, 'Copy 1 of 2 — Cashier')}
  <div class="gap"></div>
  <div class="copy2">${renderPendingOrderCopy(snap, 'Copy 2 of 2 — Customer')}</div>
</body></html>`;
    printHtml(html);
  };

  const handleCheckout = async (override) => {
    if (cart.length === 0) return;
    try {
      // The credit-sale modal now passes { usd, fra, k } (triple-currency).
      // The walk-in Pay modal still passes legacy { cash, momo, bank }.
      // Guard against accidentally receiving the click event.
      const hasOverride = override && typeof override === 'object' && !override.nativeEvent
        && ('cash' in override || 'momo' in override || 'bank' in override || 'usd' in override || 'fra' in override || 'k' in override);
      const isCreditOverride = hasOverride && ('usd' in override || 'fra' in override || 'k' in override);
      const cashAmt = isCreditOverride
        ? parseFloat(override.usd || 0)
        : (hasOverride ? parseFloat(override.cash || 0) : parseFloat(cashIn || 0));
      const momoAmt = isCreditOverride ? 0 : (hasOverride ? parseFloat(override.momo || 0) : parseFloat(momoIn || 0));
      const bankAmt = isCreditOverride ? 0 : (hasOverride ? parseFloat(override.bank || 0) : parseFloat(bankIn || 0));
      // FRA / K come from the credit override or, for walk-ins, from the Pay modal.
      const fraReceived = isCreditOverride
        ? Math.max(0, parseFloat(override.fra || 0))
        : (isDual && payModal ? Math.max(0, parseFloat(payModal.cashFRA || 0)) : 0);
      const kReceived   = isCreditOverride ? Math.max(0, parseFloat(override.k || 0)) : 0;
      const fraChangeGiven= isDual && payModal ? Math.max(0, parseFloat(payModal.changeFRAgiven || 0)) : 0;
      const fraReceivedAsUSD = SELL_RATE   > 0 ? fraReceived / SELL_RATE   : 0;
      const kReceivedAsUSD   = SELL_RATE_K > 0 ? kReceived   / SELL_RATE_K : 0;
      const effectiveAmountReceived = cashAmt + momoAmt + bankAmt + fraReceivedAsUSD + kReceivedAsUSD;
      const effectiveUnpaid = Math.max(0, total - effectiveAmountReceived);
      const effectiveChange = Math.max(0, effectiveAmountReceived - total);
      // Credit-sale detection: if a registered customer is selected and amount paid < total,
      // mark the order so it's findable and excluded from Cash totals.
      const isCreditSale = !!selectedCustomer && effectiveUnpaid > 0.001;
      const isFullCredit = isCreditSale && effectiveAmountReceived < 0.001;
      const paymentMethod = isFullCredit ? 'Credit' : isCreditSale ? 'Partial-Credit' : 'Cash';

      const orderRes = await createOrder({
        customer_name: customerName,
        customer_id: selectedCustomer ? selectedCustomer.id : null,
        customer_sync_id: selectedCustomer ? selectedCustomer.sync_id : null,
        items: cart,
        subtotal,
        tax_amount: 0,
        total_amount: total,
        discount: parseFloat(discount || 0),
        amount_received: effectiveAmountReceived,
        cash_received: cashAmt,
        momo_received: momoAmt,
        bank_received: bankAmt,
        change_amount: effectiveChange,
        payment_method: paymentMethod,
        // Dual-currency FX bucket — orders.fra_received / fra_change_given /
        // selling_rate_used / buying_rate_used. Rates are snapshotted at sale
        // time so historical receipts always reproduce even if admin updates
        // them later. K-only sales send zeros, leaving columns untouched.
        currency: isDual ? 'USD' : 'K',
        fra_received: fraReceived,
        fra_change_given: fraChangeGiven,
        selling_rate_used: isDual ? SELL_RATE : null,
        buying_rate_used:  isDual ? BUY_RATE  : null,
        k_received: kReceived,
        selling_rate_k_used: hasK ? SELL_RATE_K : null,
        buying_rate_k_used:  hasK ? BUY_RATE_K  : null,
        // v1.8.68 — which drawer holds the over-payment (when cashier didn't
        // physically hand back the full change). Backend defaults to the
        // currency the customer paid in when this is blank. Credit-sale
        // overrides never carry a keptCcy, so the OR fallback is harmless.
        // v1.8.72 — also send NATIVE amount so backend stores exact source
        // value (no FX spread loss on the round-trip).
        overpaid_kept_ccy: (override && override.keptCcy) || null,
        overpaid_kept_amt: (override && override.keptAmt) || 0,
        // Only sent when an Administrator picked a non-today date in the Pay modal.
        // Backend re-validates the role before honouring it.
        sale_date: (isAdmin && saleDate && saleDate !== todayStr()) ? saleDate : null,
      });

      const rData = {
        orderNumber: orderRes.data.order_number,
        date: new Date(),
        customerName,
        items: [...cart],
        subtotal,
        discount: parseFloat(discount || 0),
        total,
        amountReceived: effectiveAmountReceived,
        cashReceived: cashAmt,
        momoReceived: momoAmt,
        bankReceived: bankAmt,
        change: effectiveChange,
        paymentMethod,
        balanceDue: isCreditSale ? effectiveUnpaid : 0,
      };

      suppressCartBroadcast.current = true;
      setCart([]);
      setCustomerName('');
      setDiscount(0);
      setCashIn(''); setMomoIn(''); setBankIn('');
      setSaleDate(todayStr());
      setReceiptData(rData);
      setShowChangeBanner(false);
      setShowReceipt(true);

      // Refresh stock balances
      try {
        const updated = await getInventory();
        if (updated.data?.length > 0) {
          // Same v1.5.0 filter as initial load — hide items with no price
          // or Inactive status.
          const sellable = updated.data.filter(p =>
            p.product_type !== 'raw_material' &&
            (p.status || 'Active') === 'Active' &&
            parseFloat(p.selling_price || 0) > 0
          );
          setProducts(sellable);
        }
      } catch (err) { /* keep current */ }
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Unknown error';
      alert(`Checkout failed: ${msg}`);
    }
  };

  const printThermalReceipt = async (data, bName, bPhone, servedBy, bAddress = '') => {
    // On phones, skip the backend ESC/POS attempt — the VPS backend has no
    // local printer, but the request can still confuse the flow. Go straight
    // to the HTML fallback (which becomes a PDF download on mobile via
    // printHtml — see utils/printHtml.js and System Settings → Mobile Print).
    if (!isMobile) {
      // Try ESC/POS via backend first (no dialog, same as Open Drawer).
      // The backend reads businessName / phone / address / currency from
      // business_settings — we only send the order itself.
      try {
        const now = data.date instanceof Date ? data.date : new Date(data.date);
        const dateTime = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
        await printReceipt({
          orderNumber: data.orderNumber,
          dateTime,
          customerName: data.customerName,
          servedBy,
          // Tag each line with `is_alt_unit` so the backend can append `**`
          // on the printed receipt — same hint the on-screen modal shows when
          // the sale used a non-default unit.
          items: (data.items || []).map(it => ({
            ...it,
            is_alt_unit: isNonDefaultUnit(it),
          })),
          discount: data.discount,           // cart-level extra discount, in addition to per-line item.discount
          total: data.total,
          amountReceived: data.amountReceived,
          cashReceived: data.cashReceived,
          momoReceived: data.momoReceived,
          bankReceived: data.bankReceived,
          change: data.change,
        });
        return;
      } catch (e) {
        // fallback to printDirect below
      }
    }

    const printThermalReceiptFallback = (data, bName, bPhone, servedBy, bAddress = '') => {
    const div42eq = '='.repeat(42);
    const div42da = '-'.repeat(42);

    // Name + qty only. Per-line PRICE/TOTAL removed per redesign — the
    // customer sees what they're paying via Subtotal / TOTAL.
    let fallbackHasAltUnit = false;
    const itemsRows = data.items.map(item => {
      const isAltUnit = isNonDefaultUnit(item);
      if (isAltUnit) fallbackHasAltUnit = true;
      const nameLabel = item.product_name + (isAltUnit ? ' **' : '');
      const qty = parseFloat(item.quantity || 0);
      const qtyStr = qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2);
      return `<tr>
        <td>${nameLabel}</td>
        <td style="text-align:right; white-space:nowrap;">${qtyStr} ${item.unit || ''}</td>
      </tr>`;
    }).join('');

    // Total discount on the receipt = line discounts + cart-level discount
    const lineDiscSum = data.items.reduce((s, it) => s + parseFloat(it.quantity) * parseFloat(it.discount || 0), 0);
    const cartDisc = parseFloat(data.discount || 0);
    const totalDisc = lineDiscSum + cartDisc;
    const grossSubtotal = data.items.reduce((s, it) => s + parseFloat(it.quantity) * parseFloat(it.unit_price), 0);
    const discountRow = totalDisc > 0
      ? `<tr><td>Discount</td><td></td><td></td><td style="text-align:right;">-${curSym}${fmt(totalDisc)}</td></tr>`
      : '';

    // Redesign: BALANCE DUE removed from print. CHANGE stays so the
    // customer sees what they get back. If underpaid, nothing prints
    // below the payment block.
    const changeRow = data.amountReceived >= data.total
      ? `<tr class="amt"><td>*** CHANGE ***</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(data.change)}</td></tr>`
      : '';

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: 80mm auto; margin: 0; }
  html, body { height: auto; margin: 0; padding: 0; overflow-x: hidden; }
  * { box-sizing: border-box; }
  body {
    width: 80mm;
    max-width: 80mm;
    padding: 2mm 3mm;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    color: #000;
    font-weight: 700;
  }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  td { padding: 1px 0; vertical-align: top; }
  .c { text-align: center; }
  .divider { text-align: center; font-size: 10px; overflow: hidden; white-space: nowrap; margin: 3px 0; }
  .grand { font-size: 16px; font-weight: 800; }
  .amt { font-size: 13px; font-weight: 700; }
</style>
</head>
<body>
  <div class="c" style="font-size:14px;font-weight:700;letter-spacing:1px;">${bName}</div>
  ${bAddress ? `<div class="c" style="font-size:11px;">${String(bAddress).replace(/\n/g, '<br/>')}</div>` : ''}
  ${bPhone ? `<div class="c" style="font-size:11px;">Tel: ${bPhone}</div>` : ''}
  <div class="divider">${div42eq}</div>
  <div class="c" style="font-weight:700;font-size:12px;">SALES RECEIPT</div>
  <div class="divider">${div42eq}</div>

  <table>
    <tr><td>Receipt #:</td><td></td><td style="text-align:right;">${data.orderNumber}</td></tr>
    <tr><td>Date &amp; Time:</td><td></td><td style="text-align:right;">${data.date.toLocaleDateString('en-GB')} ${data.date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}</td></tr>
    <tr><td>Customer:</td><td></td><td style="text-align:right;">${data.customerName || 'Walk-in'}</td></tr>
    <tr><td>Served by:</td><td></td><td style="text-align:right;">${servedBy}</td></tr>
  </table>
  <div class="divider">${div42eq}</div>

  <table>
    <tr style="font-size:10px;">
      <td style="font-weight:700;">ITEM</td>
      <td style="text-align:right;font-weight:700;">QTY</td>
    </tr>
    ${itemsRows}
  </table>
  <div class="divider">${div42da}</div>

  <table>
    <tr><td>Subtotal</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(grossSubtotal)}</td></tr>
    ${discountRow}
  </table>
  <div class="divider">${div42eq}</div>

  <table>
    <tr class="grand"><td>TOTAL</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(data.total)}</td></tr>
  </table>
  <div class="divider">${div42eq}</div>

  <table>
    ${(() => {
      const c = parseFloat(data.cashReceived || 0), m = parseFloat(data.momoReceived || 0), b = parseFloat(data.bankReceived || 0);
      const hasSplit = c + m + b > 0.001;
      if (!hasSplit) return `<tr class="amt"><td>Amt Received:</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(data.amountReceived)}</td></tr>`;
      return `${c > 0 ? `<tr><td>Cash:</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(c)}</td></tr>` : ''}
              ${m > 0 ? `<tr><td>MoMo:</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(m)}</td></tr>` : ''}
              ${b > 0 ? `<tr><td>Bank:</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(b)}</td></tr>` : ''}
              <tr class="amt"><td>Total Received:</td><td></td><td></td><td style="text-align:right;">${curSym}${fmt(data.amountReceived)}</td></tr>`;
    })()}
    ${changeRow}
  </table>
  <div class="divider">${div42eq}</div>

  <div class="c" style="margin-top:4px;">Thank you for your purchase!</div>
  <div class="c">Please come again.</div>
  ${fallbackHasAltUnit ? `<div class="c" style="margin-top:6px;font-size:10px;">** sold in alternate unit (not default)</div>` : ''}
</body>
</html>`;

      printDirect(html);
    };
    printThermalReceiptFallback(data, bName, bPhone, servedBy, bAddress);
  };

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  return (
    <>
      <div className="pos-layout no-print">
        {/* Products Section */}
        <div className="pos-products">
          <div className="page-header">
            <div>
              <h1>Point of Sale</h1>
              <p>Select products to add to cart</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                onClick={focusScanner}
                title={scannerActive ? 'Scanner is active' : 'Click to re-enable barcode scanner'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
                  fontWeight: 600, fontSize: 13,
                  background: scannerActive ? '#dcfce7' : '#fee2e2',
                  border: `2px solid ${scannerActive ? '#16a34a' : '#dc2626'}`,
                  color: scannerActive ? '#16a34a' : '#dc2626',
                  transition: 'all 0.2s'
                }}
              >
                <span style={{
                  width: 9, height: 9, borderRadius: '50%',
                  background: scannerActive ? '#16a34a' : '#dc2626',
                  display: 'inline-block', flexShrink: 0
                }} />
                {scannerActive ? 'Scanner Active' : 'Focus Scanner'}
              </button>
              <button
                onClick={handleOpenDrawer}
                title="Open Cash Drawer"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
                  fontWeight: 600, fontSize: 13,
                  background: drawerMsg?.type === 'success' ? '#dcfce7' : drawerMsg?.type === 'error' ? '#fee2e2' : '#f3f4f6',
                  border: `2px solid ${drawerMsg?.type === 'success' ? '#16a34a' : drawerMsg?.type === 'error' ? '#dc2626' : '#d1d5db'}`,
                  color: drawerMsg?.type === 'success' ? '#16a34a' : drawerMsg?.type === 'error' ? '#dc2626' : '#374151',
                  transition: 'all 0.2s'
                }}
              >
                <FiUnlock size={14} />
                {drawerMsg ? drawerMsg.text : 'Open Drawer'}
              </button>
              <div className="page-time">🕐 {timeStr}</div>
            </div>
          </div>

          {/* v1.8.38 — Clear button. Sits inside the search container
              so it shares the same border/background. Hidden when the
              search is empty. */}
          <div className="search-input-container" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FiSearch style={{ color: '#9ca3af' }} />
            <input type="text" placeholder="Search products by name..." value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1 }} />
            {search && (
              <button onClick={() => setSearch('')} title="Clear search"
                style={{ padding: '4px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <FiX size={12} /> Clear
              </button>
            )}
          </div>

          {barcodeMsg && (
            <div style={{
              margin: '8px 0',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              background: barcodeMsg.type === 'error' ? '#fee2e2' : '#dcfce7',
              color: barcodeMsg.type === 'error' ? '#dc2626' : '#16a34a',
              border: `1px solid ${barcodeMsg.type === 'error' ? '#fca5a5' : '#86efac'}`,
            }}>
              {barcodeMsg.type === 'error' ? '⚠ ' : '✓ '}{barcodeMsg.text}
            </div>
          )}

          {/* Quick Items */}
          {quickItems.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>⭐ Quick Items</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {quickItems.map(qi => {
                  const product = products.find(p => p.sync_id === qi.product_sync_id);
                  if (!product) return null;
                  const salesBalance = parseFloat(product.sales_balance || 0);
                  const qDisplay = pickDisplayUnit(product);
                  return (
                    <button
                      key={qi.product_sync_id}
                      onClick={() => addToCart(product)}
                      style={{
                        padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                        background: salesBalance <= 0 ? '#fff5f5' : '#fef3c7',
                        border: `1.5px solid ${salesBalance <= 0 ? '#fca5a5' : '#fcd34d'}`,
                        color: salesBalance <= 0 ? '#dc2626' : '#92400e',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      {product.name}
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{curSym}{qDisplay.price}/{qDisplay.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="category-filters">
            {['All', ...categories].map(cat => (
              <button key={cat} className={`category-btn ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}>{cat}</button>
            ))}
          </div>

          <div className="product-grid">
            {filteredProducts.map(product => {
              const salesBalance = parseFloat(product.sales_balance || 0);
              const isQuick = quickSyncIds.has(product.sync_id);
              const units = unitsForProduct(product);
              const displayUnit = pickDisplayUnit(product);
              const stockBlocked = blockOversell && salesBalance <= 0;
              // v1.6.7: low-stock highlight. Threshold = the product's own
              // min_stock if set (> 0), else 10. Items already ran the
              // <= 0 hide filter above so salesBalance is always > 0 here.
              const lowThreshold = parseFloat(product.min_stock || 0) > 0 ? parseFloat(product.min_stock) : 10;
              const isLowStock = salesBalance > 0 && salesBalance < lowThreshold;
              return (
                <div key={product.id} className="product-card"
                  onClick={() => { if (!stockBlocked) setQtyOnAdd({ product, unit: displayUnit.name, value: '1' }); }}
                  title={stockBlocked ? `${product.name} is out of stock` : (isLowStock ? `Low stock — only ${salesBalance} left (threshold ${lowThreshold})` : '')}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, border: isLowStock ? '2px solid #dc2626' : (salesBalance <= 0 ? '2px solid #fca5a5' : undefined), background: isLowStock ? '#fef2f2' : (salesBalance <= 0 ? '#fff5f5' : undefined), position: 'relative', cursor: stockBlocked ? 'not-allowed' : 'pointer' }}>
                  {/* Star pin button */}
                  <button
                    onClick={e => { e.stopPropagation(); toggleQuickItem(product); }}
                    title={isQuick ? 'Remove from Quick Items' : 'Add to Quick Items'}
                    style={{
                      position: 'absolute', top: 4, right: 4,
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: isQuick ? '#f59e0b' : '#d1d5db', padding: 2, fontSize: 14,
                    }}
                  >
                    <FiStar size={13} fill={isQuick ? '#f59e0b' : 'none'} />
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className={`badge ${getCategoryClass(product.category_name)}`} style={{ fontSize: 10 }}>
                      {product.category_name}
                    </span>
                    <h3>{product.name}</h3>
                    <p className="stock-info" style={isLowStock ? { color: '#dc2626', fontWeight: 700 } : undefined}>
                      In Stock: {formatStockForProduct(salesBalance, product, { showBaseInParens: false })}
                      {isLowStock && <span style={{ marginLeft: 6, fontSize: 10, background: '#dc2626', color: '#fff', padding: '1px 6px', borderRadius: 8, fontWeight: 700 }}>LOW</span>}
                    </p>
                    <div className="product-price">
                      {/* v1.8.4: format with 2dp so derived per-packaging
                          prices (basePrice × conv with non-terminating base)
                          don't print as '28.000080000000004'. */}
                      <div className="price">{curSym}{(parseFloat(displayUnit.price) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span>/ {displayUnit.name}</span></div>
                    </div>
                    {/* Alt-unit buttons only — the default unit is added by
                        tapping the card body, so its button would be redundant. */}
                    {(() => {
                      const altUnits = units.filter(u => u.name !== displayUnit.name);
                      if (altUnits.length === 0) return null;
                      return (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                          {altUnits.map(u => (
                            <button
                              key={u.name}
                              onClick={e => { e.stopPropagation(); setQtyOnAdd({ product, unit: u.name, value: '1' }); }}
                              title={`Add 1 ${u.name} (${curSym}${(parseFloat(u.price) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`}
                              style={{
                                padding: '6px 12px', borderRadius: 14, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                                minHeight: 30,
                                background: '#f3f4f6',
                                border: '1px solid #d1d5db',
                                color: '#374151',
                              }}
                            >
                              + {u.name}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  {product.image_url ? (
                    <img
                      src={`${API_BASE}${product.image_url}`}
                      alt={product.name}
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* Cart Section */}
        <div className={`pos-cart ${isMobile && mobileCartOpen ? 'mobile-open' : ''}`}>
          <div className="cart-header">
            <h3>Current Order</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="cart-items-badge">{cart.length} items</span>
              {isMobile && (
                <button
                  onClick={() => setMobileCartOpen(false)}
                  aria-label="Close cart"
                  style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <FiX size={18} />
                </button>
              )}
            </div>
          </div>

          <div className="cart-customer">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#9ca3af' }}>👤</span>
              <input
                type="text"
                placeholder="Customer name (optional)"
                value={customerName}
                onChange={e => setCustomerName(e.target.value)}
                onFocus={refreshCustomers}
                list="pos-customer-list"
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <datalist id="pos-customer-list">
                {customers.map(c => (
                  <option key={c.id} value={c.name}>
                    {c.type || ''}{c.phone ? ` · ${c.phone}` : ''}
                  </option>
                ))}
              </datalist>
            </div>
            {selectedCustomer && (
              <div style={{
                marginTop: 6, padding: '6px 10px', borderRadius: 8, fontSize: 12,
                border: `1px solid ${onHold ? '#f87171' : overLimit ? '#f59e0b' : '#bfdbfe'}`,
                background: onHold ? '#fef2f2' : overLimit ? '#fff7ed' : '#eff6ff',
                color: onHold ? '#991b1b' : overLimit ? '#92400e' : '#1d4ed8',
                display: 'flex', flexDirection: 'column', gap: 2,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                  <span>{onHold ? '⛔ ON HOLD' : overLimit ? '⚠ Over credit limit' : '✓ Credit OK'}</span>
                  <span>
                    {creditLimit > 0
                      ? `Available K${fmt(availableCredit)} / K${fmt(creditLimit)}`
                      : 'No credit limit set'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.85 }}>
                  <span>Outstanding: {money(currentOutstanding)}</span>
                  {unpaidThisSale > 0 && (
                    <span>+ Unpaid this sale: {money(unpaidThisSale)} → {money(projectedOutstanding)}</span>
                  )}
                </div>
                {onHold && <div style={{ marginTop: 2 }}>Cannot sell on credit — customer account is on hold.</div>}
                {overLimit && !onHold && (
                  <div style={{ marginTop: 2 }}>
                    This sale would exceed the credit limit by {money(projectedOutstanding - creditLimit)}.
                    Collect at least {money(Math.max(0, unpaidThisSale - availableCredit))} now to proceed.
                  </div>
                )}
              </div>
            )}
          </div>

          {cart.length === 0 ? (
            <div className="cart-empty">
              <div className="cart-empty-icon"><FiDollarSign /></div>
              <h4>Cart is empty</h4>
              <p>Add products from the catalog<br/>to start a new sale</p>
            </div>
          ) : (
            <div className="cart-items" ref={cartListRef}>
              {cart.map((item, cartIdx) => {
                // Flag lines sold in a unit other than the product's default.
                // Uses the shared `isNonDefaultUnit` helper so the cart card,
                // on-screen receipt, thermal receipt and HTML fallback all
                // agree on what "alt unit" means.
                const isNonDefault = isNonDefaultUnit(item);
                return (
                <div
                  key={`${item.product_id}-${item.unit}`}
                  className="cart-item"
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, item }); }}
                  onDoubleClick={() => setQtyEdit({ item, value: '' })}
                  style={isNonDefault ? { border: '2px solid #dc2626', borderRadius: 8, background: '#fef2f2', padding: 8 } : undefined}
                >
                  <div className="cart-item-info">
                    <h4>
                      {item.product_name}
                      {isNonDefault && (
                        <span title={`Sold in ${item.unit} — default is ${item.default_unit_name}`} style={{ marginLeft: 6, color: '#dc2626', fontWeight: 700, fontSize: 13 }}>⚠</span>
                      )}
                    </h4>
                    {/* Unit is fixed once the line is in the cart — to add the
                        same product in a different unit, use the unit chip on
                        the product card instead (adds a new line). */}
                    <p style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {curSym}{item.unit_price} / <span style={{ color: isNonDefault ? '#dc2626' : 'inherit', fontWeight: isNonDefault ? 700 : 'normal' }}>{item.unit}</span>
                      {isNonDefault && (
                        <span style={{ marginLeft: 4, fontSize: 10, color: '#dc2626', fontWeight: 600 }}>(not default — usually {item.default_unit_name})</span>
                      )}
                    </p>
                    {/* v1.8.98 — Change Price flow. Seeds draft with the current
                        effective unit price (unit_price - discount) so the modal
                        shows what the line currently sells at; user types a NEW
                        price (not a discount amount). */}
                    <div style={{ marginTop: 4 }}>
                      {parseFloat(item.discount || 0) !== 0 ? (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setDiscountModal({ cartIdx, draft: String((item.unit_price - (item.discount || 0)).toFixed(2)), reason: '' }); }}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '3px 9px', borderRadius: 14,
                            background: item.discount > 0 ? '#fef2f2' : '#eff6ff',
                            border: `1px solid ${item.discount > 0 ? '#fecaca' : '#bfdbfe'}`,
                            color: item.discount > 0 ? '#dc2626' : '#1d4ed8',
                            fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          }}
                        >
                          <FiTag size={11} /> {curSym}{(item.unit_price - item.discount).toFixed(2)} / {item.unit}
                          <span style={{ color: item.discount > 0 ? '#9b1c1c' : '#1e40af', fontWeight: 600 }}>
                            ({item.discount > 0 ? '−' : '+'}{money(item.quantity * Math.abs(item.discount))})
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setDiscountModal({ cartIdx, draft: String(item.unit_price.toFixed(2)), reason: '' }); }}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '3px 9px', borderRadius: 14,
                            background: '#f9fafb', border: '1px dashed #d1d5db',
                            color: '#6b7280', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                          }}
                        >
                          <FiTag size={11} /> Change price
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="cart-item-qty">
                    <span style={{
                      minWidth: 64, textAlign: 'center', display: 'inline-block',
                      border: '1px solid #e5e7eb', borderRadius: 6,
                      padding: '3px 8px', fontSize: 13, fontWeight: 600,
                      background: '#f9fafb', userSelect: 'none', cursor: 'default'
                    }}>
                      {item.quantity}
                    </span>
                  </div>
                  <div className="cart-item-total">{money(item.total_price)}</div>
                  <button className="cart-item-remove" onClick={() => removeItem(item.product_id, item.unit)}><FiX /></button>
                </div>
                );
              })}
            </div>
          )}

          <div className="cart-footer">
            <div className="cart-totals">
              <div className="cart-total-line total">
                <span>Total</span>
                <span>{money(total)}</span>
              </div>
              {/* Payment-method amounts live in the Pay / Credit Sale modal — not in the cart footer. */}
            </div>
            <div className="cart-actions">
              <button className="btn-clear" onClick={() => setCart([])}>
                <FiX /> Clear
              </button>
              {sendsToCashier ? (
                // v1.8.49 — in 2/3-station mode the Cashier is the only one
                // who handles money, so credit decisions belong there too.
                // Reception just attaches the customer (if any) + sends the
                // order. The Cashier sees the registered customer on the
                // order and the Pay modal exposes the credit option there.
                <button
                  className="btn-checkout"
                  onClick={handleSendToCashier}
                  disabled={cart.length === 0 || creditBlocked}
                  title={
                    cart.length === 0 ? 'Cart is empty'
                      : onHold ? 'Customer on hold — payment in full required at Cashier'
                      : overLimit ? 'Sale would exceed credit limit'
                      : selectedCustomer ? 'Sends to Cashier — partial payment / credit handled there'
                      : 'Sends the order to the Cashier inbox for payment'
                  }
                  style={{ background: selectedCustomer ? 'linear-gradient(135deg,#d97706,#b45309)' : 'linear-gradient(135deg,#0ea5e9,#0369a1)' }}
                >
                  {selectedCustomer ? <><FiFileText /> Send to Cashier (Credit) →</> : <><FiShoppingCart /> Confirm & Send to Cashier →</>}
                </button>
              ) : selectedCustomer ? (
                <button
                  className="btn-checkout"
                  onClick={() => setCreditModal(hasMoMoBank
                    ? { cash: '', momo: '', bank: '', usd: '', fra: '', k: '' }
                    : { usd: '', fra: '', k: '' })}
                  disabled={cart.length === 0 || creditBlocked}
                  title={
                    cart.length === 0 ? 'Cart is empty'
                      : onHold ? 'Customer on hold — payment in full required'
                      : overLimit ? 'Sale would exceed credit limit'
                      : ''
                  }
                  style={{ background: 'linear-gradient(135deg,#d97706,#b45309)' }}
                >
                  <FiFileText /> Credit Sale →
                </button>
              ) : (
                <button
                  className="btn-checkout"
                  onClick={() => setPayModal({ cash: '', momo: '', bank: '', cashFRA: '0', changeUSDgiven: '0', changeFRAgiven: '0' })}
                  disabled={cart.length === 0}
                  title={cart.length === 0 ? 'Cart is empty' : ''}
                >
                  <FiShoppingCart /> Pay →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile-only: sticky "View Cart" bar shown when the cart has items
          and the sheet is closed. Tap → opens the cart bottom-sheet. */}
      {isMobile && cart.length > 0 && !mobileCartOpen && (
        <button
          onClick={() => setMobileCartOpen(true)}
          className="pos-mobile-cart-bar"
          aria-label={`View cart, ${cart.length} items, total ${money(total)}`}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FiShoppingCart size={18} />
            <strong>{cart.length}</strong>
            <span style={{ opacity: 0.85 }}>{cart.length === 1 ? 'item' : 'items'}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <strong>{money(total)}</strong>
            <span style={{ opacity: 0.85, fontSize: 13 }}>View Cart ▲</span>
          </span>
        </button>
      )}

      {/* Mobile-only: backdrop behind the cart sheet. Tap-anywhere closes. */}
      {isMobile && mobileCartOpen && (
        <div
          className="pos-mobile-cart-backdrop"
          onClick={() => setMobileCartOpen(false)}
        />
      )}


      {/* Numpad Modal */}
      {showNumpad && (
        <Portal>
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
          onClick={() => setShowNumpad(false)}
        >
          <div style={{
            background: '#fff', borderRadius: 20, padding: 24, width: 320,
            boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
          }}
            onClick={e => e.stopPropagation()}
          >
            {/* Title */}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', marginBottom: 10, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Amount Received
            </div>

            {/* Display */}
            <div style={{
              background: '#f8faff', border: '2px solid #2563eb', borderRadius: 12,
              padding: '14px 18px', marginBottom: 16, textAlign: 'right',
              fontSize: 32, fontWeight: 800, color: '#1d4ed8', letterSpacing: 1,
              minHeight: 62, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              fontFamily: 'monospace',
            }}>
              {curSym}{numpadValue || '0'}
            </div>

            {/* Quick amounts */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
              {[total, Math.ceil(total / 5) * 5, Math.ceil(total / 10) * 10].filter((v, i, a) => a.indexOf(v) === i).map(amt => (
                <button key={amt} onClick={() => setNumpadValue(amt.toFixed(2))}
                  style={{
                    padding: '8px 4px', borderRadius: 8, border: '1.5px solid #bfdbfe',
                    background: '#eff6ff', color: '#1d4ed8', fontSize: 12, fontWeight: 700,
                    cursor: 'pointer',
                  }}>
                  {money(amt)}
                </button>
              ))}
            </div>

            {/* Number Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {['7','8','9','4','5','6','1','2','3','.','0','⌫'].map(key => (
                <button key={key} onClick={() => {
                  if (key === '⌫') {
                    setNumpadValue(prev => prev.slice(0, -1));
                  } else if (key === '.' && numpadValue.includes('.')) {
                    // ignore second dot
                  } else {
                    setNumpadValue(prev => (prev === '0' ? key : prev + key));
                  }
                }}
                  style={{
                    padding: '18px 0', borderRadius: 12, fontSize: 22, fontWeight: 700,
                    border: key === '⌫' ? '1.5px solid #fecaca' : '1.5px solid #e5e7eb',
                    background: key === '⌫' ? '#fee2e2' : '#f9fafb',
                    color: key === '⌫' ? '#dc2626' : '#111827',
                    cursor: 'pointer', transition: 'background 0.1s',
                  }}
                  onMouseDown={e => e.currentTarget.style.background = key === '⌫' ? '#fecaca' : '#e5e7eb'}
                  onMouseUp={e => e.currentTarget.style.background = key === '⌫' ? '#fee2e2' : '#f9fafb'}
                >
                  {key}
                </button>
              ))}
            </div>

            {/* Clear + Confirm */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10, marginTop: 12 }}>
              <button onClick={() => setNumpadValue('')}
                style={{
                  padding: '14px 0', borderRadius: 12, border: '1.5px solid #e5e7eb',
                  background: '#f3f4f6', color: '#374151', fontSize: 14, fontWeight: 700, cursor: 'pointer'
                }}>
                Clear
              </button>
              <button onClick={() => {
                  setAmountReceived(numpadValue || '0');
                  setShowNumpad(false);
                }}
                style={{
                  padding: '14px 0', borderRadius: 12, border: 'none',
                  background: 'linear-gradient(135deg, #16a34a, #15803d)',
                  color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer',
                  boxShadow: '0 4px 14px rgba(22,163,74,0.4)',
                }}>
                Confirm ✓
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Credit Sale Confirmation Modal */}
      {payModal && !selectedCustomer && (() => {
        const cashNow = Math.max(0, parseFloat(payModal.cash || 0));
        const momoNow = Math.max(0, parseFloat(payModal.momo || 0));
        const bankNow = Math.max(0, parseFloat(payModal.bank || 0));
        // Dual-currency math (kassumbalesa1) — matches the Sirak-POS formulas
        // saved in memory. The K-only branches set cashFRA=0 / change=0 so
        // these collapse back to the legacy single-currency arithmetic.
        const cashFRANow      = isDual ? Math.max(0, parseFloat(payModal.cashFRA || 0))       : 0;
        const cashFRAasUSD    = isDual && SELL_RATE > 0 ? cashFRANow / SELL_RATE              : 0;
        const payNow          = cashNow + momoNow + bankNow + cashFRAasUSD;
        const changeNow       = Math.max(0, payNow - total);
        const balanceDue      = Math.max(0, total - payNow);
        // Change actually handed back: cashier may split between USD and FRA.
        const changeUSDgiven  = isDual ? Math.max(0, parseFloat(payModal.changeUSDgiven  || 0)) : 0;
        const changeFRAgiven  = isDual ? Math.max(0, parseFloat(payModal.changeFRAgiven  || 0)) : 0;
        const changeFRAasUSD  = isDual && BUY_RATE > 0 ? changeFRAgiven / BUY_RATE              : 0;
        const totalChangeGiven= changeUSDgiven + changeFRAasUSD;
        const netRemaining    = Math.max(0, changeNow - totalChangeGiven);
        // v1.8.72 — attribute over-payment to source currency (USD first, FRA next).
        // No K in POS modal yet. Native amounts = 1:1 with what customer handed over.
        let _remPos = total;
        const _usdUsedPos = Math.min(cashNow + momoNow + bankNow, _remPos);
        const overUSDpos  = (cashNow + momoNow + bankNow) - _usdUsedPos;
        _remPos -= _usdUsedPos;
        let overFRApos = 0;
        if (_remPos > 0 && cashFRANow > 0 && SELL_RATE > 0) {
          const fraNeededPos = _remPos * SELL_RATE;
          if (cashFRANow >= fraNeededPos) overFRApos = cashFRANow - fraNeededPos;
        } else if (cashFRANow > 0) {
          overFRApos = cashFRANow;
        }
        const enoughPaid = payNow >= total - 0.001;
        return (
          <Portal>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }} onClick={e => e.stopPropagation()}>
              <div style={{ padding: '18px 22px', background: 'linear-gradient(135deg,#1d4ed8,#1e40af)', color: '#fff', borderRadius: '14px 14px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 style={{ margin: 0 }}>Payment</h3>
                  <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>Walk-in sale — collect payment in any combination of methods</div>
                </div>
                <button onClick={() => { setPayModal(null); customerChannel.current?.postMessage({ type: 'cart_update', items: cart, total }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff' }}><FiX size={20} /></button>
              </div>

              <div style={{ padding: 22 }}>
                {/* This sale */}
                <div style={{ background: '#eff6ff', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 13 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', marginBottom: 8 }}>This Sale</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ color: '#374151' }}>Subtotal</span>
                    <span>{money(subtotal)}</span>
                  </div>
                  {/* Cart-level discount — flat K off the whole sale. */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                    <span style={{ color: '#374151' }}>Change price (+/−)</span>
                    {isAdmin ? (
                      <input
                        type="number" step="0.01" value={discount || ''}
                        onChange={e => setDiscount(parseFloat(e.target.value) || 0)}
                        placeholder="0.00"
                        title="Positive = discount (off total). Negative = markup (added to total)."
                        style={{ width: 100, padding: '4px 8px', border: '1.5px solid #d1d5db', borderRadius: 6, fontSize: 13, fontWeight: 600, color: parseFloat(discount || 0) > 0 ? '#dc2626' : parseFloat(discount || 0) < 0 ? '#2563eb' : '#111827', textAlign: 'right' }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDiscountModal({ target: 'cart', draft: discount ? String(discount) : '' })}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                          padding: '4px 10px', borderRadius: 14,
                          background: parseFloat(discount || 0) > 0 ? '#fef2f2' : parseFloat(discount || 0) < 0 ? '#eff6ff' : '#f9fafb',
                          border: `1px ${parseFloat(discount || 0) > 0 ? 'solid #fecaca' : parseFloat(discount || 0) < 0 ? 'solid #bfdbfe' : 'dashed #d1d5db'}`,
                          color: parseFloat(discount || 0) > 0 ? '#dc2626' : parseFloat(discount || 0) < 0 ? '#2563eb' : '#6b7280',
                          fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        <FiTag size={11} />
                        {parseFloat(discount || 0) > 0 ? `−${curSym}${parseFloat(discount).toFixed(2)}` : parseFloat(discount || 0) < 0 ? `+${curSym}${Math.abs(parseFloat(discount)).toFixed(2)}` : 'Change price'}
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px dashed #c7d2fe', marginTop: 4, paddingTop: 8, fontWeight: 700 }}>
                    <span style={{ color: '#1e3a8a' }}>Sale Total</span>
                    <span style={{ fontWeight: 800, color: '#1e3a8a' }}>{money(total)}</span>
                  </div>
                  {isAdmin && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', marginTop: 4, borderTop: '1px dashed #c7d2fe' }}>
                      <span style={{ color: '#374151', fontWeight: 600 }}>Sale Date</span>
                      <input
                        type="date"
                        value={saleDate}
                        max={todayStr()}
                        onChange={e => setSaleDate(e.target.value || todayStr())}
                        style={{ padding: '4px 8px', border: `1.5px solid ${saleDate !== todayStr() ? '#dc2626' : '#d1d5db'}`, borderRadius: 6, fontSize: 13, fontWeight: 600, color: saleDate !== todayStr() ? '#dc2626' : '#111827', background: '#fff' }}
                      />
                    </div>
                  )}
                  <div style={{ marginTop: 12 }}>
                    {/* v1.9.26 — Cash-only branches (payment_methods='cash_only')
                        hide the MoMo + Bank columns and the matching "Pay
                        full in MoMo / Bank" buttons. The Cash column expands
                        to the full row width. */}
                    <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
                      {hasMoMoBank ? 'Paying Now (split across methods — any can be 0)' : 'Paying Now'}
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: hasMoMoBank ? '1fr 1fr 1fr' : '1fr', gap: 8, marginTop: 6 }}>
                      {[
                        { key: 'cash', label: 'Cash', color: '#16a34a', show: true },
                        { key: 'momo', label: 'MoMo', color: '#f59e0b', show: hasMoMoBank },
                        { key: 'bank', label: 'Bank', color: '#2563eb', show: hasMoMoBank },
                      ].filter(f => f.show).map((f, i) => (
                        <div key={f.key}>
                          <div style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>{f.label}</div>
                          <input
                            type="number" min="0" step="0.01" autoFocus={i === 0}
                            value={payModal[f.key]}
                            onChange={e => setPayModal({ ...payModal, [f.key]: e.target.value })}
                            placeholder="0.00"
                            style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(payModal[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(payModal[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button onClick={() => setPayModal({ ...payModal, cash: total.toFixed(2), momo: '0', bank: '0' })}
                        style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in Cash</button>
                      {hasMoMoBank && (
                        <button onClick={() => setPayModal({ ...payModal, cash: '0', momo: total.toFixed(2), bank: '0' })}
                          style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in MoMo</button>
                      )}
                      {hasMoMoBank && (
                        <button onClick={() => setPayModal({ ...payModal, cash: '0', momo: '0', bank: total.toFixed(2) })}
                          style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in Bank</button>
                      )}
                    </div>
                    {/* Cash FRA — only on dual-currency branches (kassumbalesa1).
                        Customer pays in FRA, we convert to the primary currency
                        at the SELL_RATE so it adds to "Paying Now Total" cleanly. */}
                    {isDual && (
                      <div style={{ marginTop: 12, padding: 10, background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 11, color: '#a16207', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>Cash FRA</div>
                            <input
                              type="number" min="0" step="1"
                              value={payModal.cashFRA}
                              onChange={e => setPayModal({ ...payModal, cashFRA: e.target.value })}
                              placeholder="0"
                              style={{ width: '100%', padding: '8px 10px', border: `2px solid ${cashFRANow > 0 ? '#a16207' : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: cashFRANow > 0 ? '#a16207' : '#374151', boxSizing: 'border-box' }} />
                          </div>
                          <div style={{ minWidth: 130, textAlign: 'right', fontSize: 12, color: '#92400e' }}>
                            <div>≈ {money(cashFRAasUSD)}</div>
                            <div style={{ fontSize: 10, color: '#a16207', marginTop: 2 }}>at sell rate {SELL_RATE.toLocaleString()}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, padding: '6px 10px', background: '#fff', borderRadius: 6, fontSize: 13 }}>
                      <span style={{ color: '#6b7280' }}>Paying Now Total</span>
                      <span style={{ fontWeight: 800, color: payNow > 0 ? '#1d4ed8' : '#9ca3af' }}>{money(payNow)}</span>
                    </div>
                  </div>
                </div>

                {/* Change or balance due. K-only: single line. USD+FRA: split into
                    Change USD and Change FRA inputs so the cashier records what
                    was physically handed back. Net Remaining surfaces under-given
                    change (e.g. customer wants it kept on account). */}
                <div style={{ background: enoughPaid ? '#f0fdf4' : '#fef2f2', borderRadius: 10, padding: 14, fontSize: 13, border: `1px solid ${enoughPaid ? '#bbf7d0' : '#fecaca'}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ fontWeight: 700, color: enoughPaid ? '#166534' : '#991b1b' }}>{enoughPaid ? 'Change Due' : 'Balance Due'}</span>
                    <span style={{ fontWeight: 800, fontSize: 16, color: enoughPaid ? '#16a34a' : '#dc2626' }}>
                      {money(enoughPaid ? changeNow : balanceDue)}
                    </span>
                  </div>
                  {/* v1.8.74 — Option B: source currency native, others at BUY rate.
                      If over-payment is in FRA, show exact FRA (no spread loss).
                      Otherwise, show what cashier would count out if converting via buy rate. */}
                  {isDual && enoughPaid && changeNow > 0.001 && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 0', fontSize: 11, color: '#166534', fontWeight: 600 }}>
                      ≈ FRA {(overFRApos > 0.5 ? overFRApos : (BUY_RATE > 0 ? changeNow * BUY_RATE : 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      {' '}({overFRApos > 0.5 ? 'native' : `buy ${BUY_RATE.toLocaleString()}`})
                    </div>
                  )}

                  {isDual && enoughPaid && changeNow > 0.001 && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #bbf7d0' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#166534', textTransform: 'uppercase', marginBottom: 6 }}>Give back as</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div>
                          <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 700, marginBottom: 3 }}>Change USD</div>
                          <input
                            type="number" min="0" step="0.01"
                            value={payModal.changeUSDgiven}
                            onChange={e => setPayModal({ ...payModal, changeUSDgiven: e.target.value })}
                            placeholder="0.00"
                            style={{ width: '100%', padding: '8px 10px', border: `2px solid ${changeUSDgiven > 0 ? '#16a34a' : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: changeUSDgiven > 0 ? '#16a34a' : '#374151', boxSizing: 'border-box' }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 11, color: '#a16207', fontWeight: 700, marginBottom: 3 }}>Change FRA</div>
                          <input
                            type="number" min="0" step="1"
                            value={payModal.changeFRAgiven}
                            onChange={e => setPayModal({ ...payModal, changeFRAgiven: e.target.value })}
                            placeholder="0"
                            style={{ width: '100%', padding: '8px 10px', border: `2px solid ${changeFRAgiven > 0 ? '#a16207' : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: changeFRAgiven > 0 ? '#a16207' : '#374151', boxSizing: 'border-box' }} />
                          <div style={{ fontSize: 10, color: '#a16207', marginTop: 3, textAlign: 'right' }}>≈ {money(changeFRAasUSD)} at buy {BUY_RATE.toLocaleString()}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, padding: '6px 10px', background: '#fff', borderRadius: 6, fontSize: 12 }}>
                        <span style={{ color: '#6b7280' }}>Total given</span>
                        <span style={{ fontWeight: 700, color: '#16a34a' }}>{money(totalChangeGiven)}</span>
                      </div>
                      {netRemaining > 0.001 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, padding: '6px 10px', background: '#fef2f2', borderRadius: 6, fontSize: 12, border: '1px solid #fecaca' }}>
                          <span style={{ color: '#991b1b', fontWeight: 700 }}>Net remaining (not handed back)</span>
                          <span style={{ fontWeight: 700, color: '#dc2626' }}>{money(netRemaining)}</span>
                        </div>
                      )}
                      {/* v1.8.68 — when cashier keeps over-payment, ask which drawer holds it.
                          v1.8.69 — show buttons for the currencies the branch actually uses.
                          v1.8.78 — always default FRA (most common at Sosna); cashier can
                          click USD or K to override. Fallback if branch has no FRA. */}
                      {netRemaining > 0.001 && (() => {
                        const currencies = ['USD', ...(isDual ? ['FRA'] : []), ...(hasK ? ['K'] : [])];
                        const defaultCcy = payModal.keptCcy
                          || (isDual ? 'FRA' : hasK ? 'K' : 'USD');
                        return (
                          <div style={{ marginTop: 8, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6 }}>
                            <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, marginBottom: 6 }}>
                              Over-payment kept in drawer:
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              {currencies.map(c => {
                                const active = defaultCcy === c;
                                return (
                                  <button key={c} type="button"
                                    onClick={() => setPayModal({ ...payModal, keptCcy: c })}
                                    style={{
                                      flex: 1, padding: '6px 8px', borderRadius: 5,
                                      border: active ? '2px solid #d97706' : '1px solid #fcd34d',
                                      background: active ? '#fef3c7' : '#fff',
                                      color: '#78350f', fontWeight: 700, fontSize: 11, cursor: 'pointer',
                                    }}>
                                    {c}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => { setPayModal(null); customerChannel.current?.postMessage({ type: 'cart_update', items: cart, total }); }}
                  style={{ padding: '10px 18px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                  Cancel
                </button>
                <button
                  onClick={() => {
                    // v1.8.68 — propagate keptCcy default (if no explicit pick) so
                    // backend can fall back correctly even when the picker wasn't touched.
                    // v1.8.72 — also pass native keptAmt so backend doesn't round-trip via USD.
                    // v1.8.78 — default to FRA (most common at Sosna) regardless of source.
                    // v1.8.79 — convert USD-leftover at BUY rate so kept = change owed − change given.
                    const inferredKeptCcy = payModal.keptCcy
                      || (isDual ? 'FRA' : 'USD');
                    const keptAmtNative = inferredKeptCcy === 'FRA'
                      ? (overFRApos > 0.5 ? overFRApos : (BUY_RATE > 0 ? changeNow * BUY_RATE : 0))
                      : inferredKeptCcy === 'USD' ? (overUSDpos > 0.001 ? overUSDpos : changeNow)
                      : 0;
                    const breakdown = {
                      cash: cashNow, momo: momoNow, bank: bankNow,
                      keptCcy: netRemaining > 0.001 ? inferredKeptCcy : null,
                      keptAmt: netRemaining > 0.001 ? keptAmtNative : 0,
                    };
                    setPayModal(null);
                    handleCheckout(breakdown);
                  }}
                  disabled={!enoughPaid}
                  title={!enoughPaid ? `Walk-in sales must be paid in full — short by K${fmt(balanceDue)}` : ''}
                  style={{ padding: '10px 22px', background: enoughPaid ? 'linear-gradient(135deg,#16a34a,#15803d)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 8, cursor: enoughPaid ? 'pointer' : 'not-allowed', fontWeight: 800 }}>
                  Complete Sale →
                </button>
              </div>
            </div>
          </div>
          </Portal>
        );
      })()}

      {creditModal && selectedCustomer && (() => {
        const usdNow = Math.max(0, parseFloat(creditModal.usd || 0));
        const fraNow = Math.max(0, parseFloat(creditModal.fra || 0));
        const kNow   = Math.max(0, parseFloat(creditModal.k   || 0));
        const fraAsUSD = SELL_RATE   > 0 ? fraNow / SELL_RATE   : 0;
        const kAsUSD   = SELL_RATE_K > 0 ? kNow   / SELL_RATE_K : 0;
        const payNow = usdNow + fraAsUSD + kAsUSD;
        const newCredit = Math.max(0, total - payNow);
        const projectedOutstanding = currentOutstanding + newCredit;
        const overLimit = creditLimit > 0 && projectedOutstanding > creditLimit + 0.001;
        // Force-expand the account summary when the projected balance would
        // breach the credit limit — the cashier needs to see why "Confirm" is
        // disabled. Once they're back within limit they can collapse again.
        const summaryOpen = showCreditSummary || overLimit;
        return (
          <Portal>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }} onClick={e => e.stopPropagation()}>
              {/* Pinned header */}
              <div style={{ padding: '18px 22px', background: 'linear-gradient(135deg,#d97706,#b45309)', color: '#fff', borderRadius: '14px 14px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <div>
                  <h3 style={{ margin: 0 }}>Credit Sale</h3>
                  <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>To: <strong>{selectedCustomer.name}</strong></div>
                </div>
                <button onClick={() => { setCreditModal(null); customerChannel.current?.postMessage({ type: 'cart_update', items: cart, total }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff' }}><FiX size={20} /></button>
              </div>

              {/* Scrollable body — header/footer stay pinned even on tall content / small screens */}
              <div style={{ padding: 22, overflowY: 'auto', flex: 1 }}>
                {/* This sale */}
                <div style={{ background: '#eff6ff', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 13 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', marginBottom: 8 }}>This Sale</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ color: '#374151' }}>Subtotal</span>
                    <span>{money(subtotal)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                    <span style={{ color: '#374151' }}>Change price (+/−)</span>
                    {isAdmin ? (
                      <input
                        type="number" step="0.01" value={discount || ''}
                        onChange={e => setDiscount(parseFloat(e.target.value) || 0)}
                        placeholder="0.00"
                        title="Positive = discount (off total). Negative = markup (added to total)."
                        style={{ width: 100, padding: '4px 8px', border: '1.5px solid #d1d5db', borderRadius: 6, fontSize: 13, fontWeight: 600, color: parseFloat(discount || 0) > 0 ? '#dc2626' : parseFloat(discount || 0) < 0 ? '#2563eb' : '#111827', textAlign: 'right' }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDiscountModal({ target: 'cart', draft: discount ? String(discount) : '' })}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                          padding: '4px 10px', borderRadius: 14,
                          background: parseFloat(discount || 0) > 0 ? '#fef2f2' : parseFloat(discount || 0) < 0 ? '#eff6ff' : '#f9fafb',
                          border: `1px ${parseFloat(discount || 0) > 0 ? 'solid #fecaca' : parseFloat(discount || 0) < 0 ? 'solid #bfdbfe' : 'dashed #d1d5db'}`,
                          color: parseFloat(discount || 0) > 0 ? '#dc2626' : parseFloat(discount || 0) < 0 ? '#2563eb' : '#6b7280',
                          fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        <FiTag size={11} />
                        {parseFloat(discount || 0) > 0 ? `−${curSym}${parseFloat(discount).toFixed(2)}` : parseFloat(discount || 0) < 0 ? `+${curSym}${Math.abs(parseFloat(discount)).toFixed(2)}` : 'Change price'}
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px dashed #c7d2fe', marginTop: 4, paddingTop: 8, fontWeight: 700 }}>
                    <span style={{ color: '#1e3a8a' }}>Sale Total</span>
                    <span style={{ fontWeight: 800, color: '#1e3a8a' }}>{money(total)}</span>
                  </div>
                  {isAdmin && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', marginTop: 4, borderTop: '1px dashed #c7d2fe' }}>
                      <span style={{ color: '#374151', fontWeight: 600 }}>Sale Date</span>
                      <input
                        type="date"
                        value={saleDate}
                        max={todayStr()}
                        onChange={e => setSaleDate(e.target.value || todayStr())}
                        style={{ padding: '4px 8px', border: `1.5px solid ${saleDate !== todayStr() ? '#dc2626' : '#d1d5db'}`, borderRadius: 6, fontSize: 13, fontWeight: 600, color: saleDate !== todayStr() ? '#dc2626' : '#111827', background: '#fff' }}
                      />
                    </div>
                  )}
                  <div style={{ marginTop: 12 }}>
                    {/* v1.9.30 — Liquor branches: Cash / MoMo / Bank inputs
                        mirroring the walk-in Pay modal. Sosna branches keep
                        the USD / FRA / K currency-axis inputs. */}
                    <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
                      Paying Now (split across {hasMoMoBank ? 'methods' : 'currencies'} — any can be 0)
                    </label>
                    {(() => {
                      const fields = hasMoMoBank ? [
                        { key: 'cash', label: 'Cash', color: '#16a34a', step: '0.01', placeholder: '0.00', show: true },
                        { key: 'momo', label: 'MoMo', color: '#f59e0b', step: '0.01', placeholder: '0.00', show: true },
                        { key: 'bank', label: 'Bank', color: '#2563eb', step: '0.01', placeholder: '0.00', show: true },
                      ] : [
                        { key: 'usd', label: 'USD', color: '#16a34a', step: '0.01', placeholder: '0.00', show: true },
                        { key: 'fra', label: 'FRA', color: '#2563eb', step: '1',    placeholder: '0',    show: isDual },
                        { key: 'k',   label: 'K',   color: '#7c3aed', step: '1',    placeholder: '0',    show: hasK   },
                      ].filter(f => f.show);
                      const cols = `repeat(${fields.length}, 1fr)`;
                      return (
                        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, marginTop: 6 }}>
                          {fields.map((f, i) => (
                            <div key={f.key}>
                              <div style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>{f.label}</div>
                              <input
                                type="number" min="0" step={f.step} autoFocus={i === 0}
                                value={creditModal[f.key]}
                                onChange={e => setCreditModal({ ...creditModal, [f.key]: e.target.value })}
                                placeholder={f.placeholder}
                                style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(creditModal[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(creditModal[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {hasMoMoBank ? (
                        <>
                          <button onClick={() => setCreditModal({ ...creditModal, cash: '0', momo: '0', bank: '0' })}
                            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay {curSym}0 (full credit)</button>
                          <button onClick={() => setCreditModal({ ...creditModal, cash: total.toFixed(2), momo: '0', bank: '0' })}
                            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in Cash</button>
                          <button onClick={() => setCreditModal({ ...creditModal, cash: '0', momo: total.toFixed(2), bank: '0' })}
                            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in MoMo</button>
                          <button onClick={() => setCreditModal({ ...creditModal, cash: '0', momo: '0', bank: total.toFixed(2) })}
                            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in Bank</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setCreditModal({ usd: '0', fra: '0', k: '0' })}
                            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay $0 (full credit)</button>
                          <button onClick={() => setCreditModal({ usd: total.toFixed(2), fra: '0', k: '0' })}
                            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in USD</button>
                          {isDual && SELL_RATE > 0 && (
                            <button onClick={() => setCreditModal({ usd: '0', fra: (total * SELL_RATE).toFixed(0), k: '0' })}
                              style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in FRA</button>
                          )}
                          {hasK && (
                            <button onClick={() => setCreditModal({ usd: '0', fra: '0', k: (total * SELL_RATE_K).toFixed(0) })}
                              style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>Pay full in K</button>
                          )}
                        </>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, padding: '6px 10px', background: '#fff', borderRadius: 6, fontSize: 13 }}>
                      <span style={{ color: '#6b7280' }}>Paying Now Total</span>
                      <span style={{ fontWeight: 800, color: payNow > 0 ? '#1d4ed8' : '#9ca3af' }}>{money(payNow)}</span>
                    </div>
                  </div>
                </div>

                {/* New Credit — the one essential KPI, always visible */}
                <div style={{ background: '#fef3c7', borderRadius: 10, padding: 14, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#92400e', fontWeight: 700 }}>New Credit from This Sale</span>
                  <span style={{ fontWeight: 800, fontSize: 16, color: '#92400e' }}>{money(newCredit)}</span>
                </div>

                {/* Collapsible — Account Summary + Total Outstanding After.
                    Hidden by default to match the Cash Sale modal's simplicity.
                    Auto-expanded (forced open) when the projected balance
                    would exceed the credit limit. */}
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    onClick={() => setShowCreditSummary(s => !s)}
                    disabled={overLimit}
                    title={overLimit ? 'Auto-expanded because this sale would exceed the credit limit' : ''}
                    style={{
                      width: '100%', padding: '8px 12px',
                      background: summaryOpen ? '#f3f4f6' : '#fff',
                      color: '#374151', border: '1px dashed #d1d5db', borderRadius: 8,
                      cursor: overLimit ? 'default' : 'pointer',
                      fontSize: 12, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}
                  >
                    <span>{summaryOpen ? '▼' : '▶'} {summaryOpen ? 'Hide' : 'Show'} account summary & total outstanding</span>
                    {overLimit && (
                      <span style={{ fontSize: 10, padding: '2px 8px', background: '#fee2e2', color: '#b91c1c', borderRadius: 999, fontWeight: 800 }}>
                        ⚠ OVER LIMIT
                      </span>
                    )}
                  </button>

                  {summaryOpen && (
                    <div style={{ background: '#f9fafb', borderRadius: 10, padding: 14, marginTop: 8, fontSize: 13 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 8 }}>Account Summary</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                        <span style={{ color: '#6b7280' }}>Credit Limit</span>
                        <span style={{ fontWeight: 600 }}>{creditLimit > 0 ? money(creditLimit) : 'No limit set'}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                        <span style={{ color: '#6b7280' }}>Current Outstanding</span>
                        <span style={{ fontWeight: 600, color: currentOutstanding > 0 ? '#dc2626' : '#16a34a' }}>{money(currentOutstanding)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px dashed #e5e7eb', marginTop: 4, paddingTop: 8 }}>
                        <span style={{ fontWeight: 700, color: '#78350f' }}>Total Outstanding After</span>
                        <span style={{ fontWeight: 800, fontSize: 16, color: '#dc2626' }}>{money(projectedOutstanding)}</span>
                      </div>
                      {overLimit && (
                        <div style={{ marginTop: 8, padding: 6, background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>
                          ⚠ Exceeds credit limit by {money(projectedOutstanding - creditLimit)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Pinned footer */}
              <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0, background: '#fff', borderRadius: '0 0 14px 14px' }}>
                <button onClick={() => { setCreditModal(null); customerChannel.current?.postMessage({ type: 'cart_update', items: cart, total }); }}
                  style={{ padding: '10px 18px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const breakdown = { usd: usdNow, fra: fraNow, k: kNow };
                    setCreditModal(null);
                    handleCheckout(breakdown);
                  }}
                  disabled={onHold || overLimit}
                  style={{ padding: '10px 22px', background: (onHold || overLimit) ? '#9ca3af' : 'linear-gradient(135deg,#d97706,#b45309)', color: '#fff', border: 'none', borderRadius: 8, cursor: (onHold || overLimit) ? 'not-allowed' : 'pointer', fontWeight: 800 }}>
                  Confirm Credit Sale →
                </button>
              </div>
            </div>
          </div>
          </Portal>
        );
      })()}

      {/* Receipt Modal */}
      {showReceipt && receiptData && (
        <Portal>
        <div
          onKeyDown={e => {
            if (e.key === 'Enter') {
              if (showChangeBanner) { setShowChangeBanner(false); setShowReceipt(false); }
              else { printThermalReceipt(receiptData, businessName, businessPhone, `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Staff', businessAddress); setShowChangeBanner(true); }
            }
          }}
          tabIndex={0}
          ref={el => el && el.focus()}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            outline: 'none',
          }}>
          <div style={{
            background: '#fff', borderRadius: 12, width: 420,
            maxHeight: '90vh', display: 'flex', flexDirection: 'column',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden',
            position: 'relative',
          }}>
            {/* ── FIXED HEADER ── */}
            <div style={{ padding: '28px 28px 0', fontFamily: 'monospace', flexShrink: 0 }}>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, fontFamily: 'sans-serif' }}>{businessName}</h2>
                {businessAddress && (
                  <p style={{ margin: '3px 0 0', fontSize: 11, color: '#4b5563', whiteSpace: 'pre-line' }}>{businessAddress}</p>
                )}
                {businessPhone && (
                  <p style={{ margin: '2px 0 0', fontSize: 11, color: '#4b5563' }}>Tel: {businessPhone}</p>
                )}
                <p style={{ margin: '6px 0 0', fontSize: 11, fontWeight: 700, color: '#111827', letterSpacing: 1 }}>
                  {receiptData.paymentMethod === 'Credit' ? 'CREDIT SALE — Charged to Account'
                    : receiptData.paymentMethod === 'Partial-Credit' ? 'PARTIAL CREDIT SALE'
                    : 'SALES RECEIPT'}
                </p>
              </div>

              <div style={{ borderTop: '1px dashed #d1d5db', margin: '10px 0' }} />

              <div style={{ fontSize: 12, marginBottom: 10 }}>
                {[
                  ['Receipt #', receiptData.orderNumber],
                  ['Date & Time', `${receiptData.date.toLocaleDateString('en-GB')} ${receiptData.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`],
                  ['Customer', receiptData.customerName || 'Walk-in'],
                  ['Served by', `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Staff'],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ color: '#6b7280' }}>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>

              <div style={{ borderTop: '1px dashed #d1d5db', margin: '10px 0' }} />

              {/* Column headings */}
              <div style={{ display: 'flex', fontSize: 10, color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>
                <span style={{ flex: 3 }}>ITEM</span>
                <span style={{ textAlign: 'center', flex: 1 }}>QTY</span>
                <span style={{ textAlign: 'right', flex: 1 }}>PRICE</span>
                <span style={{ textAlign: 'right', flex: 1 }}>TOTAL</span>
              </div>
            </div>

            {/* ── SCROLLABLE ITEMS ── */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 28px', fontFamily: 'monospace' }}>
              {receiptData.items.map((item, idx) => {
                const isAltUnit = isNonDefaultUnit(item);
                // Show GROSS line (qty × original unit_price) and the line discount
                // separately so the math on the receipt adds up to the customer.
                const lineDisc = parseFloat(item.discount || 0);
                const grossLineTotal = parseFloat(item.quantity) * parseFloat(item.unit_price);
                const lineDiscTotal = parseFloat(item.quantity) * lineDisc;
                return (
                <div key={idx} style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{item.product_name}{isAltUnit ? ' **' : ''}</div>
                  <div style={{ display: 'flex', fontSize: 11 }}>
                    <span style={{ flex: 3 }} />
                    <span style={{ textAlign: 'center', flex: 1 }}>{item.quantity} {item.unit || ''}</span>
                    <span style={{ textAlign: 'right', flex: 1 }}>{money(item.unit_price)}</span>
                    <span style={{ textAlign: 'right', flex: 1 }}>{money(grossLineTotal)}</span>
                  </div>
                  {lineDisc > 0 && (
                    <div style={{ display: 'flex', fontSize: 10, color: '#dc2626' }}>
                      <span style={{ flex: 3 }} />
                      <span style={{ textAlign: 'right', flex: 2 }}>discount {item.quantity} × −{money(lineDisc)}</span>
                      <span style={{ textAlign: 'right', flex: 1 }}>−{money(lineDiscTotal)}</span>
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            {/* ── FIXED FOOTER ── */}
            <div style={{ padding: '0 28px 24px', fontFamily: 'monospace', flexShrink: 0 }}>
              <div style={{ borderTop: '1px dashed #d1d5db', margin: '10px 0' }} />

              <div style={{ fontSize: 12 }}>
                {(() => {
                  // Re-derive gross totals so the receipt math reads cleanly:
                  //   Gross Subtotal = Σ qty × unit_price
                  //   Line discounts = Σ qty × line.discount
                  //   Cart discount  = receiptData.discount
                  //   TOTAL = Gross Subtotal − Line discounts − Cart discount
                  const grossSubtotal = (receiptData.items || []).reduce(
                    (s, it) => s + parseFloat(it.quantity) * parseFloat(it.unit_price), 0);
                  const lineDiscSum = (receiptData.items || []).reduce(
                    (s, it) => s + parseFloat(it.quantity) * parseFloat(it.discount || 0), 0);
                  const cartDisc = parseFloat(receiptData.discount || 0);
                  const totalDisc = lineDiscSum + cartDisc;
                  return (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: '#6b7280' }}>Subtotal</span>
                        <span>{money(grossSubtotal)}</span>
                      </div>
                      {totalDisc > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ color: '#dc2626' }}>Discount{lineDiscSum > 0 && cartDisc > 0 ? ` (line ${money(lineDiscSum)} + cart ${money(cartDisc)})` : ''}</span>
                          <span style={{ color: '#dc2626' }}>−{money(totalDisc)}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, paddingTop: 5, borderTop: '1px solid #e5e7eb', fontWeight: 800, fontSize: 18 }}>
                  <span>TOTAL</span>
                  <span>{money(receiptData.total)}</span>
                </div>
                {(() => {
                  const c = parseFloat(receiptData.cashReceived || 0);
                  const m = parseFloat(receiptData.momoReceived || 0);
                  const b = parseFloat(receiptData.bankReceived || 0);
                  const hasSplit = c + m + b > 0.001;
                  if (!hasSplit) {
                    return (
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontWeight: 600, fontSize: 14 }}>
                        <span style={{ color: '#6b7280' }}>Amount Received</span>
                        <span>{money(receiptData.amountReceived)}</span>
                      </div>
                    );
                  }
                  return (
                    <>
                      {c > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, fontSize: 13 }}>
                          <span style={{ color: '#6b7280' }}>Cash</span>
                          <span>{money(c)}</span>
                        </div>
                      )}
                      {m > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, fontSize: 13 }}>
                          <span style={{ color: '#6b7280' }}>Mobile Money</span>
                          <span>{money(m)}</span>
                        </div>
                      )}
                      {b > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, fontSize: 13 }}>
                          <span style={{ color: '#6b7280' }}>Bank</span>
                          <span>{money(b)}</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontWeight: 700, fontSize: 14, borderTop: '1px dotted #d1d5db', paddingTop: 3 }}>
                        <span style={{ color: '#374151' }}>Total Received</span>
                        <span>{money(receiptData.amountReceived)}</span>
                      </div>
                    </>
                  );
                })()}
                {receiptData.amountReceived >= receiptData.total ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15, color: '#16a34a' }}>
                    <span>Change</span>
                    <span>{money(receiptData.change)}</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15, color: '#dc2626' }}>
                    <span>Balance Due</span>
                    <span>{money(receiptData.total - receiptData.amountReceived)}</span>
                  </div>
                )}
              </div>

              <div style={{ borderTop: '1px dashed #d1d5db', margin: '14px 0 10px' }} />

              <div style={{ textAlign: 'center', fontSize: 11, color: '#6b7280', marginBottom: 16 }}>
                <p style={{ margin: 0 }}>Thank you for your purchase!</p>
                <p style={{ margin: '2px 0 0' }}>Please come again.</p>
                {(receiptData.items || []).some(isNonDefaultUnit) && (
                  <p style={{ margin: '6px 0 0', fontSize: 10 }}>** sold in alternate unit (not default)</p>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowReceipt(false)}
                  style={{ padding: '10px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  Close
                </button>
                <button onClick={() => { printThermalReceipt(receiptData, businessName, businessPhone, `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Staff', businessAddress); setShowChangeBanner(true); }}
                  style={{ padding: '10px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                  🖨 Print Receipt
                </button>
              </div>
            </div>
          </div>

          {/* ── CHANGE BANNER ── shown after print */}
          {showChangeBanner && receiptData && (
            <div style={{
              position: 'absolute', inset: 0, borderRadius: 12,
              background: 'rgba(0,0,0,0.75)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', zIndex: 10,
            }}>
              <div style={{
                background: '#fff', borderRadius: 16, padding: '36px 40px',
                textAlign: 'center', boxShadow: '0 8px 32px rgba(0,0,0,0.3)', minWidth: 280,
              }}>
                <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 4, letterSpacing: 1, textTransform: 'uppercase' }}>Transaction Complete</div>
                {receiptData.amountReceived >= receiptData.total ? (
                  <>
                    <div style={{ fontSize: 14, color: '#374151', marginBottom: 6 }}>Change to give customer</div>
                    <div style={{ fontSize: 52, fontWeight: 900, color: '#16a34a', lineHeight: 1, marginBottom: 24 }}>
                      {money(receiptData.change)}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 14, color: '#374151', marginBottom: 6 }}>Balance still owed</div>
                    <div style={{ fontSize: 52, fontWeight: 900, color: '#dc2626', lineHeight: 1, marginBottom: 24 }}>
                      {money(receiptData.total - receiptData.amountReceived)}
                    </div>
                  </>
                )}
                <button
                  onClick={() => { setShowChangeBanner(false); setShowReceipt(false); customerChannel.current?.postMessage({ type: 'cart_clear' }); }}
                  style={{
                    padding: '12px 48px', background: '#dc2626', color: '#fff',
                    border: 'none', borderRadius: 10, fontSize: 16, fontWeight: 700,
                    cursor: 'pointer', letterSpacing: 0.5,
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          )}
        </div>
        </Portal>
      )}

      {/* ── Right-click context menu ── */}
      {contextMenu && (
        <Portal>
        <div
          style={{
            position: 'fixed', top: contextMenu.y, left: contextMenu.x,
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 9999,
            minWidth: 180, overflow: 'hidden',
          }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ padding: '4px 14px', fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {contextMenu.item.product_name}
            </div>
          </div>
          <button
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 500 }}
            onMouseEnter={e => e.currentTarget.style.background = '#eff6ff'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
            onClick={() => { setQtyEdit({ item: contextMenu.item, value: '' }); setContextMenu(null); }}
          >
            ✏️ Change Quantity
          </button>
          <button
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: '#dc2626', fontWeight: 500 }}
            onMouseEnter={e => e.currentTarget.style.background = '#fee2e2'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
            onClick={() => { removeItem(contextMenu.item.product_id, contextMenu.item.unit); setContextMenu(null); }}
          >
            🗑 Remove Item
          </button>
        </div>
        </Portal>
      )}

      {/* v1.8.38 — Qty-on-add modal. Pops when user taps a product card
          or alt-unit chip; asks for qty before going to cart. Default 1,
          auto-focus, Enter submits, Esc cancels. */}
      {qtyOnAdd && (() => {
        const typed = parseFloat(qtyOnAdd.value || 0);
        const invalid = !qtyOnAdd.value || typed <= 0;
        const submit = () => {
          if (invalid) return;
          const p = qtyOnAdd.product;
          const u = qtyOnAdd.unit;
          setQtyOnAdd(null);
          addToCart(p, typed, u);
        };
        // Unit price for the chosen unit (look it up on the product).
        let unitPrice = 0;
        try {
          const arr = JSON.parse(qtyOnAdd.product.units_json || '[]');
          const found = Array.isArray(arr) ? arr.find(x => x.name === qtyOnAdd.unit) : null;
          unitPrice = parseFloat(found?.price || qtyOnAdd.product.selling_price || 0) || 0;
        } catch { unitPrice = parseFloat(qtyOnAdd.product.selling_price || 0) || 0; }
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setQtyOnAdd(null)}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 320, maxWidth: '90vw', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
            <h4 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#111827' }}>{qtyOnAdd.product.name}</h4>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>{curSym}{unitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / {qtyOnAdd.unit}</p>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Quantity ({qtyOnAdd.unit})</label>
            <input
              type="number" min="0" step="any" autoFocus
              value={qtyOnAdd.value}
              onChange={e => setQtyOnAdd(prev => ({ ...prev, value: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setQtyOnAdd(null); }}
              onFocus={e => e.target.select()}
              style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: invalid ? '2px solid #fca5a5' : '2px solid #16a34a', fontSize: 22, fontWeight: 700, textAlign: 'center', outline: 'none', boxSizing: 'border-box' }}
            />
            <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280', textAlign: 'center' }}>
              Total: <strong style={{ color: '#0f172a' }}>{curSym}{(typed * unitPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => setQtyOnAdd(null)}
                style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={submit} disabled={invalid}
                style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: invalid ? '#cbd5e1' : '#16a34a', color: '#fff', fontSize: 13, fontWeight: 700, cursor: invalid ? 'not-allowed' : 'pointer' }}>Add to Cart</button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* ── Change Quantity modal ── */}
      {qtyEdit && (() => {
        // Compute the cap from current stock + other cart lines of the
        // same product. Excludes the line being edited from the cart-side
        // sum so the user can leave the qty unchanged or set it lower.
        const product = products.find(p => p.id === qtyEdit.item.product_id);
        const editedIdx = cart.findIndex(i => i.product_id === qtyEdit.item.product_id && i.unit === qtyEdit.item.unit);
        const remainingBase = remainingBaseForProduct(product, editedIdx);
        const conv = parseFloat(qtyEdit.item.conversion_factor || 0);
        const isAlt = !!(qtyEdit.item.alt_unit && qtyEdit.item.unit === qtyEdit.item.alt_unit);
        const maxQtyInUnit = !blockOversell
          ? Infinity
          : (isAlt && conv > 0 ? remainingBase / conv : remainingBase);
        const maxQtyDisplay = Number.isFinite(maxQtyInUnit) ? parseFloat(maxQtyInUnit.toFixed(3)) : null;
        const typed = parseFloat(qtyEdit.value || 0);
        const overCap = blockOversell && typed > maxQtyInUnit + 0.0001;
        const invalid = !qtyEdit.value || typed <= 0;
        const saveDisabled = invalid || overCap;
        return (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setQtyEdit(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 280, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e => e.stopPropagation()}>
            <h4 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: '#111827' }}>{qtyEdit.item.product_name}</h4>
            <p style={{ margin: '0 0 6px', fontSize: 12, color: '#6b7280' }}>{curSym}{qtyEdit.item.unit_price} / {qtyEdit.item.unit}</p>
            {blockOversell && maxQtyDisplay !== null && (
              <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>
                Max: <strong style={{ color: '#374151' }}>{maxQtyDisplay} {qtyEdit.item.unit}</strong>
              </p>
            )}
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>New Quantity</label>
            <input
              autoFocus
              type="number"
              min="0"
              step="1"
              value={qtyEdit.value}
              onChange={e => setQtyEdit(prev => ({ ...prev, value: e.target.value }))}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  if (saveDisabled) return;
                  setItemQty(qtyEdit.item.product_id, qtyEdit.item.unit, qtyEdit.value);
                  setQtyEdit(null);
                } else if (e.key === 'Escape') {
                  setQtyEdit(null);
                }
              }}
              style={{ width: '100%', padding: '8px 12px', border: `1.5px solid ${overCap ? '#dc2626' : '#2563eb'}`, borderRadius: 8, fontSize: 16, fontWeight: 600, textAlign: 'center', outline: 'none', boxSizing: 'border-box' }}
            />
            {overCap && (
              <div style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>
                Only {maxQtyDisplay} {qtyEdit.item.unit} available — can't save {typed}.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13 }}
                onClick={() => setQtyEdit(null)}
              >Cancel</button>
              <button
                disabled={saveDisabled}
                style={{ flex: 2, padding: '8px', borderRadius: 8, border: 'none', background: saveDisabled ? '#93c5fd' : '#2563eb', color: '#fff', cursor: saveDisabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}
                onClick={() => { if (!saveDisabled) { setItemQty(qtyEdit.item.product_id, qtyEdit.item.unit, qtyEdit.value); setQtyEdit(null); } }}
              >Update</button>
            </div>
          </div>
        </div>
        </Portal>
        );
      })()}

      {/* ── Line Discount Modal ────────────────────────────────────────
          Replaces the inline "Disc:" input on each cart line so the cart
          stays compact. Per-unit discount in the local currency, applied
          off unit_price. Saving an empty/0 value clears the line discount.
          Non-Administrators must get an admin to enter their credentials
          before the discount is applied (every discount, every time). */}
      {discountModal && (() => {
        const isCart = discountModal.target === 'cart';
        const item = isCart ? null : cart[discountModal.cartIdx];
        if (!isCart && !item) return null;
        // v1.8.98 — Line target: draft is the NEW PRICE (not discount).
        //           Cart target: draft is the discount amount (legacy).
        const draftNum = parseFloat(discountModal.draft || 0) || 0;
        const origUnitPrice = !isCart ? parseFloat(item.unit_price || 0) : 0;
        const lineDelta = !isCart ? (origUnitPrice - draftNum) : 0; // + = discount, − = markup
        // Validation
        const lineZero       = !isCart && draftNum <= 0;
        const lineUnchanged  = !isCart && Math.abs(draftNum - origUnitPrice) < 0.0001;
        const overSubtotal   = isCart && draftNum > subtotal;
        // v1.9.4 — reason is now optional. Kept the variable name so the
        // legacy disable-button check (further below) keeps compiling; it
        // simply always evaluates false and the button is never blocked
        // on reason alone.
        const reasonInvalid  = false;
        const totalOff = isCart ? draftNum : parseFloat(item.quantity || 0) * lineDelta;

        const applyNow = () => {
          if (isCart) setDiscount(parseFloat(discountModal.draft) || 0);
          else        setLineDiscount(discountModal.cartIdx, lineDelta); // convert new price → discount delta
          setDiscountModal(null);
        };
        // Non-admin → create a pending discount_request; the polling useEffect
        // above watches its sync_id and applies once an admin approves.
        // v1.8.98: line target sends new_price + change_reason; cart unchanged.
        const requestApply = async () => {
          if (isCart) {
            if (draftNum === 0) { applyNow(); return; }
            if (isAdmin)        { applyNow(); return; }
          } else {
            if (lineUnchanged)  { setDiscountModal(null); return; } // no real change
            if (lineZero)       return; // blocked, button disabled anyway
            if (isAdmin)        { applyNow(); return; }
            if (reasonInvalid)  return; // blocked
          }
          setDiscountModal({ ...discountModal, submitting: true, error: '' });
          try {
            const payload = isCart
              ? {
                  target: 'cart',
                  product_name: null, product_sync_id: null, unit: null,
                  quantity: 0, unit_price: 0,
                  subtotal,
                  discount_amount: draftNum,
                }
              : {
                  target: 'line',
                  product_name:    item.product_name,
                  product_sync_id: item.product_sync_id,
                  unit:            item.unit || '',
                  quantity:        parseFloat(item.quantity) || 0,
                  unit_price:      origUnitPrice,
                  subtotal:        0,
                  new_price:       draftNum,
                  change_reason:   (discountModal.reason || '').trim(),
                };
            const res = await createDiscountRequest(payload);
            setDiscountModal(d => d ? { ...d, submitting: false, pendingSyncId: res.data?.sync_id, verdict: null, rejectionReason: '' } : d);
            // v1.9.4 — kick a sync cycle right after the row is inserted so
            // the admin sees the request within a couple of seconds instead
            // of waiting for the next scheduled 30s push tick.
            triggerSyncNow();
          } catch (err) {
            setDiscountModal(d => d ? { ...d, submitting: false, error: err.response?.data?.error || 'Could not send request.' } : d);
          }
        };
        // Cashier withdraws a still-pending request and closes the modal.
        const cancelWaiting = async () => {
          const sid = discountModal?.pendingSyncId;
          if (!sid) { setDiscountModal(null); return; }
          try { await cancelDiscountRequest(sid); } catch (_) {}
          setDiscountModal(null);
        };
        // Cashier wants to try a different amount after a rejection.
        const tryAgain = () => {
          setDiscountModal(d => d ? { ...d, pendingSyncId: null, verdict: null, rejectionReason: '', error: '' } : d);
        };

        return (
          <Portal>
          {/* v1.9.4 — backdrop is no longer click-to-close. Half-finished
              price changes were being lost when the cashier accidentally
              tapped outside the modal. Close is now Cancel / X only. */}
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div onClick={e => e.stopPropagation()}
                 style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 420, boxShadow: '0 24px 64px rgba(0,0,0,0.35)', overflow: 'hidden' }}>
              <div style={{ padding: '16px 22px', background: 'linear-gradient(135deg,#dc2626,#b91c1c)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <FiTag size={18} />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{
                    discountModal.pendingSyncId && !discountModal.verdict ? 'Waiting for Approval'
                    : discountModal.verdict === 'rejected' ? 'Request Rejected'
                    : (isCart ? 'Change Cart Price' : 'Change Line Price')
                  }</h3>
                </div>
                <button onClick={() => setDiscountModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff' }}><FiX size={20} /></button>
              </div>

              {!discountModal.pendingSyncId && discountModal.verdict !== 'rejected' && (
                <>
                  <div style={{ padding: 22 }}>
                    <div style={{ marginBottom: 14, padding: '10px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                      {isCart ? (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Cart Subtotal</div>
                          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{money(subtotal)} &nbsp;·&nbsp; {cart.length} item{cart.length !== 1 ? 's' : ''}</div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{item.product_name}</div>
                          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                            {curSym}{item.unit_price} / {item.unit} &nbsp;·&nbsp; Qty: {item.quantity}
                          </div>
                        </>
                      )}
                    </div>

                    <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 6 }}>
                      {isCart
                        ? `Change off total (${curSym}) — + discount / − markup`
                        : `New price per ${item.unit} (${curSym})`}
                    </label>
                    <input
                      type="number" step="0.01" min={isCart ? undefined : 0.01}
                      autoFocus
                      value={discountModal.draft}
                      onChange={e => setDiscountModal({ ...discountModal, draft: e.target.value })}
                      onFocus={e => e.target.select()}
                      onKeyDown={e => {
                        if (e.key === 'Enter') requestApply();
                        else if (e.key === 'Escape') setDiscountModal(null);
                      }}
                      placeholder={isCart ? '0.00' : `was ${curSym}${origUnitPrice.toFixed(2)}`}
                      title={isCart
                        ? 'Positive = discount. Negative = markup.'
                        : 'Type the new final price. Zero blocked. Above original = green (markup), below = red (discount).'}
                      style={{
                        width: '100%', padding: '12px 14px',
                        border: `2px solid ${(overSubtotal || lineZero) ? '#dc2626' : '#d1d5db'}`,
                        borderRadius: 10, fontSize: 18, fontWeight: 700, textAlign: 'right',
                        boxSizing: 'border-box', outline: 'none',
                        color: isCart
                          ? (draftNum > 0 ? '#dc2626' : draftNum < 0 ? '#2563eb' : '#111827')
                          : (lineZero ? '#dc2626'
                              : lineUnchanged ? '#111827'
                              : lineDelta > 0 ? '#dc2626'  // new < original (discount)
                              : '#16a34a'),               // new > original (markup)
                      }}
                    />
                    {/* Line: zero / unchanged / over-cart warnings */}
                    {!isCart && lineZero && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                        New price must be greater than 0.
                      </div>
                    )}
                    {!isCart && !lineZero && (
                      <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
                        Original: {curSym}{origUnitPrice.toFixed(2)} / {item.unit}
                      </div>
                    )}
                    {overSubtotal && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                        Discount is greater than the cart subtotal ({money(subtotal)}). The sale would go negative.
                      </div>
                    )}
                    {/* Cart: delta strip (existing) */}
                    {isCart && draftNum !== 0 && !overSubtotal && (
                      <div style={{ marginTop: 10, padding: '8px 12px', background: draftNum > 0 ? '#fef2f2' : '#eff6ff', border: `1px solid ${draftNum > 0 ? '#fecaca' : '#bfdbfe'}`, borderRadius: 8, fontSize: 12, color: draftNum > 0 ? '#991b1b' : '#1d4ed8', display: 'flex', justifyContent: 'space-between' }}>
                        <span>{draftNum > 0 ? 'Discount off this sale:' : 'Markup on this sale:'}</span>
                        <strong>{draftNum > 0 ? '−' : '+'}{money(Math.abs(totalOff))}</strong>
                      </div>
                    )}
                    {/* Line: change-vs-original strip */}
                    {!isCart && !lineZero && !lineUnchanged && (
                      <div style={{ marginTop: 10, padding: '8px 12px', background: lineDelta > 0 ? '#fef2f2' : '#dcfce7', border: `1px solid ${lineDelta > 0 ? '#fecaca' : '#86efac'}`, borderRadius: 8, fontSize: 12, color: lineDelta > 0 ? '#991b1b' : '#15803d', display: 'flex', justifyContent: 'space-between' }}>
                        <span>{lineDelta > 0 ? 'Discount on this line:' : 'Surcharge on this line:'}</span>
                        <strong>{lineDelta > 0 ? '−' : '+'}{money(Math.abs(totalOff))}</strong>
                      </div>
                    )}
                    {/* Line: Reason field — v1.9.4 OPTIONAL (was required). */}
                    {!isCart && !isAdmin && !lineZero && !lineUnchanged && (
                      <div style={{ marginTop: 12 }}>
                        <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 6 }}>
                          Reason <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span>
                        </label>
                        <input
                          type="text" maxLength={200}
                          value={discountModal.reason || ''}
                          onChange={e => setDiscountModal({ ...discountModal, reason: e.target.value })}
                          placeholder="e.g. VIP customer, damaged label, bulk discount"
                          style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
                        />
                      </div>
                    )}
                    {!isAdmin && (
                      (isCart ? draftNum !== 0 : (!lineZero && !lineUnchanged)) && (
                        <div style={{ marginTop: 10, fontSize: 11, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px' }}>
                          An administrator must approve any price change. Tap Send Request and wait for the verdict.
                        </div>
                      )
                    )}
                    {discountModal.error && (
                      <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#991b1b', fontWeight: 600 }}>
                        {discountModal.error}
                      </div>
                    )}
                  </div>

                  <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <button
                      onClick={() => {
                        if (isCart) setDiscount(0);
                        else setLineDiscount(discountModal.cartIdx, 0);
                        setDiscountModal(null);
                      }}
                      style={{ padding: '10px 16px', background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                    >Clear</button>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => setDiscountModal(null)}
                        style={{ padding: '10px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                      >Cancel</button>
                      {(() => {
                        // v1.8.98 — disable logic: line target blocks zero, unchanged,
                        // or (for non-admin) missing reason.
                        const disabled = discountModal.submitting
                          || overSubtotal
                          || (!isCart && (lineZero || lineUnchanged))
                          || (!isCart && !isAdmin && reasonInvalid);
                        const isInstantApply = isAdmin || (isCart && draftNum === 0);
                        return (
                          <button
                            onClick={requestApply}
                            disabled={disabled}
                            style={{ padding: '10px 22px', background: disabled ? '#9ca3af' : '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}
                          >{discountModal.submitting ? 'Sending…' : (isInstantApply ? 'Apply' : 'Send Request')}</button>
                        );
                      })()}
                    </div>
                  </div>
                </>
              )}

              {/* WAITING — request sent, polling for admin verdict */}
              {discountModal.pendingSyncId && !discountModal.verdict && (
                <>
                  <div style={{ padding: 22 }}>
                    <div style={{ marginBottom: 14, padding: '12px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10 }}>
                      <div style={{ fontSize: 12, color: '#991b1b' }}>
                        {isCart ? (
                          <><strong>Cart discount</strong> of {curSym}{draftNum.toFixed(2)} &nbsp;(<strong>−{money(totalOff)}</strong> off this sale)</>
                        ) : (
                          <><strong>{item.product_name}</strong> — discount of {curSym}{draftNum.toFixed(2)} per {item.unit} &nbsp;(<strong>−{money(totalOff)}</strong> off this line)</>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'center', padding: '18px 8px' }}>
                      <style>{`@keyframes posDiscWaitSpin { to { transform: rotate(360deg); } }`}</style>
                      <div style={{ width: 44, height: 44, margin: '0 auto 14px', border: '4px solid #fde68a', borderTopColor: '#dc2626', borderRadius: '50%', animation: 'posDiscWaitSpin 0.9s linear infinite' }} />
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 }}>Waiting for an administrator to approve…</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>The discount will apply automatically once approved. You can keep the cashier here open — checking out at full price will discard this request.</div>
                    </div>
                  </div>
                  <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      onClick={cancelWaiting}
                      style={{ padding: '10px 22px', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                    >Cancel Request</button>
                  </div>
                </>
              )}

              {/* REJECTED — admin said no */}
              {discountModal.verdict === 'rejected' && (
                <>
                  <div style={{ padding: 22 }}>
                    <div style={{ padding: '14px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#991b1b', marginBottom: 4 }}>The administrator rejected this discount.</div>
                      {discountModal.rejectionReason ? (
                        <div style={{ fontSize: 12, color: '#7f1d1d', marginTop: 6 }}>
                          <strong>Reason:</strong> {discountModal.rejectionReason}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: '#7f1d1d', marginTop: 6 }}>No reason provided.</div>
                      )}
                    </div>
                  </div>
                  <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <button
                      onClick={tryAgain}
                      style={{ padding: '10px 18px', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                    >Try Again</button>
                    <button
                      onClick={() => setDiscountModal(null)}
                      style={{ padding: '10px 22px', background: '#374151', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                    >Close</button>
                  </div>
                </>
              )}
            </div>
          </div>
          </Portal>
        );
      })()}
    </>
  );
};

export default POS;
