import React, { useState, useEffect, useRef } from 'react';
import pkg from '../../package.json';
const { version } = pkg;
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import { isHqHost, getNotificationBadges } from '../services/api';
import SyncStatus from './SyncStatus';
import { getDiscountRequestsPendingCount } from '../services/api';
import { matchTokens } from '../utils/tokenSearch';
import { FiGrid, FiShoppingCart, FiPackage, FiFileText, FiDollarSign, FiUsers, FiSettings,
         FiChevronDown, FiSearch, FiBell, FiMenu, FiDownload, FiUpload, FiList,
         FiBook, FiCreditCard, FiClipboard, FiUser, FiUserPlus, FiSliders, FiGlobe, FiCloud, FiTool,
         FiCornerDownLeft, FiCornerUpLeft, FiTrendingUp, FiTrendingDown, FiAlertTriangle, FiCheckCircle, FiTag, FiRefreshCw, FiTruck, FiInbox, FiSend } from 'react-icons/fi';
import { RiLogoutBoxRLine } from 'react-icons/ri';

const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'am', label: 'Amharic', flag: '🇪🇹' },
  { code: 'ti', label: 'Tigrinya', flag: '🇪🇷' },
  { code: 'fr', label: 'French',  flag: '🇫🇷' },
  { code: 'ar', label: 'Arabic',  flag: '🇸🇦' },
  { code: 'sw', label: 'Swahili', flag: '🇰🇪' },
];

const Layout = () => {
  const { user, logout, hasPageAccess, isAllAccess } = useAuth();
  const isAdmin = user?.role === 'Administrator';

  // POS-only: user has POS access but no broader management page access
  const isPOSOnly = user && !isAllAccess() &&
    hasPageAccess('POS') &&
    !hasPageAccess('Items', 'GRN', 'SIV', 'StockAdjustment', 'StockCount', 'Inventory',
      'CashReceipt', 'PaymentVoucher', 'CashBook', 'FxRates', 'AccountPayables', 'AccountReceivables', 'ProfitReport',
      'Suppliers', 'Customers', 'Sales', 'Reports');
  const { language, changeLanguage, t } = useLanguage();
  // 3-station gate — only kassumbalesa1 sees the Cashier sidebar entry.
  const { workflowMode, legacyProcurementEnabled, currencyMode } = useCurrency();
  // v1.7.0: triple-currency mode 'USD+FRA+K' also counts as "dual/multi
  // currency" for sidebar gating — same Currency Rates page handles both.
  const isDualCurrency = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  // HQ branch selector — only when the React app is served from the bare
  // sosnazm.com host. On real per-branch subdomains hq=false and the
  // dropdown stays hidden (the host already pins the tenant).
  const hq = isHqHost();
  const canSeeHqPages = hq || isAdmin;
  // v1.3.2 — branches are pure POS / receive points. Several sidebar
  // entries (procurement, supplier mgmt, supplier AP, equity / loans /
  // shareholders, etc.) are HQ-only. When `branchOnly` is true we hide
  // them from the sidebar regardless of permission so branch staff can't
  // stumble into the legacy single-tenant flows. HQ and branch admins see
  // both sets to support full application work. Direct URL access
  // is not blocked here — perms already gate routes; this just keeps the
  // nav focused on what branches actually do.
  const branchOnly = !hq && !isAdmin;
  // v1.3.9 — legacy GRN + Suppliers + AP entries are shown at HQ always,
  // or on a branch only when the operator flipped the per-branch toggle
  // in System Settings (used to seed openings at launch). Must be declared
  // AFTER branchOnly — referencing it earlier was the v1.3.9 TDZ crash
  // that blanked Layout.js for every branch.
  const showLegacyProcurement = !branchOnly || legacyProcurementEnabled;
  // v1.10.279 — HQ branch dropdown deleted; HQ context is fixed. On
  // first mount, wipe any stale localStorage `hq.branch` written by
  // earlier versions so requests stop sending X-Branch (they'd route
  // to a branch DB → the AP/GRN "empty page" issue #4/#9 all over).
  useEffect(() => {
    if (!hq) return;
    try {
      if (localStorage.getItem('hq.branch')) {
        localStorage.removeItem('hq.branch');
      }
    } catch (_) { /* ignore */ }
  }, [hq]);
  const currentHqBranch = '';
  // Sidebar badge counts for the current branch (Cashier / Dispatch
  // pending + Incoming Stock from HQ + Incoming Inter-Branch Transfers).
  // Derives slug the same way StockTransfers / IncomingStock do: HQ
  // X-Branch when on bare sosnazm.com, else host's first subdomain.
  const [badges, setBadges] = useState({ cashier_pending: 0, dispatch_pending: 0, incoming_stock: 0, incoming_transfers: 0, hq_pending_grn: 0, hq_pending_damages: 0 });
  useEffect(() => {
    let cancelled = false;
    const slug = hq ? (currentHqBranch || '') : (typeof window !== 'undefined' ? window.location.hostname.split('.')[0] : '');
    if (!slug || !user) return undefined;
    const tick = async () => {
      try {
        const r = await getNotificationBadges(slug);
        if (!cancelled) setBadges(r.data || badges);
      } catch (_) { /* keep last value on transient errors */ }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line
  }, [hq, currentHqBranch, user?.id]);

  // v1.10.279 — switchHqBranch removed with the dropdown.
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  // Bumped by the header Refresh button to remount the current route (via
  // <Outlet key={refreshKey} />) so its useEffects re-run and the page
  // re-fetches data. Same pattern as Butchery POS — avoids window.location
  // .reload() which would log the user out and break deep paths on Electron.
  const [refreshKey, setRefreshKey] = useState(0);
  // Pending discount-request count drives the red badge on the Approvals
  // sidebar entry. Admin-only — non-admins never poll this endpoint.
  const [pendingDiscountCount, setPendingDiscountCount] = useState(0);
  // v1.8.37 — in-app passcode modal to gate System Settings + Cloud Sync.
  // Replaces window.prompt() which Electron silently blocks (no dialog
  // shown, click did nothing). State carries the navigation target +
  // entered value + last error.
  const [passcodeGate, setPasscodeGate] = useState(null); // { path, label, value, error }
  const PASSCODE = '108120';
  const openPasscodeGate = (path, label) => setPasscodeGate({ path, label, value: '', error: '' });
  const submitPasscode = () => {
    if (!passcodeGate) return;
    if (passcodeGate.value !== PASSCODE) {
      setPasscodeGate(prev => ({ ...prev, error: 'Incorrect passcode.', value: '' }));
      return;
    }
    const path = passcodeGate.path;
    setPasscodeGate(null);
    navigate(path);
  };
  useEffect(() => {
    if (user?.role !== 'Administrator') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await getDiscountRequestsPendingCount();
        if (!cancelled) setPendingDiscountCount(res.data?.count || 0);
      } catch (_) { /* keep last value on transient failure */ }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user?.role]);

  const isPhoneViewport = () => typeof window !== 'undefined' && window.innerWidth <= 768;

  // Auto-close mobile sidebar on route change.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Auto-label <td> cells so the mobile card layout can show
  // "Date: May 20, 2026" etc. without every page hand-annotating each cell.
  // A MutationObserver watches for new tables (page navigations, filter changes)
  // and labels each cell from its column header. Manual data-label attrs win.
  useEffect(() => {
    const labelTables = () => {
      document.querySelectorAll('table.data-table, .modal table').forEach(table => {
        const headers = Array.from(table.querySelectorAll('thead > tr > th'))
          .map(th => th.textContent.trim());
        if (headers.length === 0) return;
        table.querySelectorAll('tbody > tr').forEach(tr => {
          let i = 0;
          for (const td of tr.children) {
            if (td.tagName === 'TD' && !td.hasAttribute('data-label') && headers[i]) {
              td.setAttribute('data-label', headers[i]);
            }
            i++;
          }
        });
      });
    };
    labelTables();
    const obs = new MutationObserver(() => labelTables());
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  const handleLangSelect = (code) => {
    changeLanguage(code);
    setShowLangMenu(false);
  };

  const currentLang = LANGUAGES.find(l => l.code === language) || LANGUAGES[0];
  const langRef = useRef(null);

  // v1.10.243 — bell dropdown state. Same pattern as the language picker
  // above: outside-click closes, ref lets us test the target. Contents are
  // scoped by context (HQ vs branch) so Lusaka1 never sees "3 GRNs to
  // generate at HQ" and HQ never sees a branch's cashier queue.
  const [showBellMenu, setShowBellMenu] = useState(false);
  const bellRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (langRef.current && !langRef.current.contains(e.target)) setShowLangMenu(false);
      if (bellRef.current && !bellRef.current.contains(e.target)) setShowBellMenu(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getActiveGroup = (pathname) => {
    if (pathname.startsWith('/pos')) return 'pos';
    if (pathname.startsWith('/stock')) return 'stock';
    if (pathname.startsWith('/accounting')) return 'accounting';
    if (pathname.startsWith('/suppliers-customers')) return 'suppliersCustomers';
    if (pathname.startsWith('/settings')) return 'settings';
    return null;
  };

  const [openGroups, setOpenGroups] = useState(() => {
    const active = getActiveGroup(window.location.pathname);
    return { pos: active === 'pos', stock: active === 'stock', accounting: active === 'accounting', suppliersCustomers: active === 'suppliersCustomers', settings: active === 'settings' };
  });

  const toggleGroup = (group) => {
    setOpenGroups(prev => {
      const isOpen = prev[group];
      const allClosed = Object.keys(prev).reduce((acc, key) => ({ ...acc, [key]: false }), {});
      return { ...allClosed, [group]: !isOpen };
    });
  };

  const isActive = (path) => location.pathname === path;
  const isGroupActive = (paths) => paths.some(p => location.pathname.startsWith(p));

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Global search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // v1.10.8 — kill accidental value nudges on every <input type="number">.
  // Wheel: blur the input so scrolling scrolls the page instead of changing
  // the value. Arrow ↑/↓: swallow the keypress. Typing/paste/tab untouched.
  useEffect(() => {
    const stopWheel = (e) => {
      if (e.target && e.target.type === 'number' && document.activeElement === e.target) {
        e.target.blur();
      }
    };
    const stopArrows = (e) => {
      if (e.target && e.target.type === 'number' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
      }
    };
    document.addEventListener('wheel', stopWheel, { passive: true });
    document.addEventListener('keydown', stopArrows);
    return () => {
      document.removeEventListener('wheel', stopWheel);
      document.removeEventListener('keydown', stopArrows);
    };
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setSearchOpen(false); return; }
    const token = localStorage.getItem('token');
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/products', { headers }).then(r => r.json()).catch(() => []),
      fetch('/api/customers', { headers }).then(r => r.json()).catch(() => []),
      fetch('/api/suppliers', { headers }).then(r => r.json()).catch(() => []),
    ]).then(([products, customers, suppliers]) => {
      const results = [];
      (Array.isArray(products) ? products : products.data || [])
        .filter(p => matchTokens(searchQuery, p.name, p.code, p.barcode))
        .slice(0, 4)
        .forEach(p => results.push({ type: 'Product', label: p.name, sub: `K ${p.selling_price ?? ''}`, path: '/stock/items' }));
      (Array.isArray(customers) ? customers : customers.data || [])
        .filter(c => matchTokens(searchQuery, c.name, c.phone, c.email))
        .slice(0, 3)
        .forEach(c => results.push({ type: 'Customer', label: c.name, sub: c.phone || '', path: '/suppliers-customers/customers' }));
      (Array.isArray(suppliers) ? suppliers : suppliers.data || [])
        .filter(s => matchTokens(searchQuery, s.name, s.phone, s.email))
        .slice(0, 3)
        .forEach(s => results.push({ type: 'Supplier', label: s.name, sub: s.phone || '', path: '/suppliers-customers/suppliers' }));
      setSearchResults(results);
      setSearchOpen(results.length > 0);
    });
  }, [searchQuery]);

  const handleSearchSelect = (path) => {
    navigate(path);
    setSearchQuery('');
    setSearchOpen(false);
  };

  const typeColors = { Product: '#2563eb', Customer: '#16a34a', Supplier: '#f59e0b' };

  const pageTitle = () => {
    const path = location.pathname;
    const titles = {
      '/dashboard': t('dashboard'), '/pos': t('pos'), '/pos/sales-report': t('salesReport'),
      '/pos/sales-inventory': t('salesInventory'), '/pos/cash-report': t('cashReport'),
      '/pos/sales-bin-card': 'Sales Bin Card',
      '/pos/sales-stock-card': 'Sales Stock Card',
      '/pos/cashier': 'Cashier',
      '/pos/dispatch': 'Dispatch',
      '/hq/overview': 'HQ Overview',
      '/hq/sales-report': 'HQ Sales Report',
      '/hq/inventory-report': 'HQ Inventory Report',
      '/hq/cash-position': 'HQ Cash Position',
      '/hq/account-receivables': 'Account Receivables',
      '/hq/consolidated-profit': 'HQ Consolidated Profit',
      '/hq/products': 'HQ Products',
      '/hq/purchases': 'HQ Purchases',
      '/hq/cost-of-delivery': 'Cost of Delivery',
      '/hq/transfers-awaiting': 'Transfers Awaiting HQ',
      '/hq/confirm-grn': 'Generate GRN',
      '/hq/grn-archive': 'GRN Archive',
      '/hq/variances':   'Transit Variances',
      '/hq/confirm-damages': 'Confirm Damages',
      '/hq/suppliers': 'HQ Suppliers',
      '/stock/incoming': 'Incoming Stock',
      '/stock/items': t('itemDetails'), '/stock/grn': t('grn'), '/stock/siv': t('siv'),
      '/stock/sales-damages': 'Sales Damages',
      '/stock/inventory': t('inventory'), '/stock/adjustments': t('stockAdjustment'),
      '/stock/categories': 'Categories and Units', '/stock/expiry-report': 'Expiry Report', '/stock/stock-count': 'Stock Count',
      '/stock/transfers': 'Inter-Branch Transfers',
      '/accounting/cash-receipts': t('cashReceipt'), '/accounting/payment-vouchers': t('paymentVoucher'),
      '/accounting/cash-book': t('cashBook'), '/accounting/account-payables': t('accountPayables'),
      '/accounting/account-receivables': 'Account Receivables',
      '/accounting/credit-notes': 'Credit Notes',
      '/accounting/capital-account': 'Capital Account',
      '/accounting/dividend-account': 'Dividend Account',
      '/accounting/shareholders': 'Shareholders',
      '/accounting/loans': 'Loan Account',
      '/suppliers-customers/suppliers': t('suppliers'), '/suppliers-customers/customers': t('customers'),
      '/settings/profile': t('profile'), '/settings/system': 'System Settings', '/settings/users': t('users'),
    };
    return titles[path] || t('dashboard');
  };

  const initials = user ? `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}` : 'JD';

  return (
    <div className="app-layout">
      {/* Backdrop: tap outside to close the mobile sidebar. */}
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      {/* Sidebar */}
      <div className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo"><img src="/sosna-logo.png" alt="Sosna" /></div>
          {!collapsed && (
            <div className="sidebar-brand">
              <h2>Sosna{hq ? ' HQ' : ''}</h2>
              <p>{hq ? 'Head Office' : 'Management System'}</p>
            </div>
          )}
        </div>

        {/* v1.10.279 — HQ branch dropdown removed entirely. HQ operators
            work exclusively against the HQ mirror (backend/sosna.db); to
            act as a branch, they open that branch's subdomain in another
            tab. Removing the dropdown here also stops the double sign-out
            trap the old switch flow could cause. currentHqBranch is
            forced empty below so every request omits X-Branch. */}
        <nav className="sidebar-nav">
          {/* HQ Overview — only when serving from bare sosnazm.com.
              Sits above Dashboard because it's the natural landing page
              for an HQ operator (cross-branch snapshot, jump-to-branch). */}
          {canSeeHqPages && hasPageAccess('HqOverview') && (
            <div className={`nav-item ${isActive('/hq/overview') ? 'active' : ''}`} onClick={() => navigate('/hq/overview')}>
              <FiGlobe className="nav-icon" />
              {!collapsed && <span>HQ Overview</span>}
            </div>
          )}
          {/* v1.9.25 — flat HQ items relocated into the existing groups
              (Sales / Store / Accounting / Suppliers & Customers) so the
              sidebar reads the same on HQ and branch. HQ Overview stays
              flat above because it's the landing dashboard, not a group
              child. HQ Products kept hidden (replaced by Store → Item
              Details that pushes to branches automatically). */}

          {/* Dashboard — only for All access users, and hidden on HQ
              because HQ has no POS orders (Dashboard tiles would all
              read zero). v1.10.144 — HQ Overview is the real landing
              for HQ users. */}
          {isAllAccess() && !hq && (
            <div className={`nav-item ${isActive('/dashboard') ? 'active' : ''}`} onClick={() => navigate('/dashboard')}>
              <FiGrid className="nav-icon" />
              {!collapsed && <span>{t('dashboard')}</span>}
            </div>
          )}

          {/* Sales Group.
              v1.9.25 — Group now renders on HQ too so HQ Sales Report can
              live inside it instead of as a flat top-level entry. The
              existing branch-only children stay gated with !hq; the HQ
              Sales Report child is gated with hq. */}
          {/* v1.10.298 — Sales gate widened to include SalesStockCard
              (added to Users.js PAGE_GROUPS in v1.10.245 but never
              propagated to this parent gate). A user with only
              SalesStockCard:View saw no Sales section at all. */}
          {(hq || hasPageAccess('POS', 'Cashier', 'Dispatch', 'SalesReport', 'SalesInventory', 'CashReport', 'SalesBinCard', 'SalesStockCard')) && (collapsed ? (
            <div className={`nav-item ${isGroupActive(['/pos', '/hq/sales-report']) ? 'active' : ''}`} onClick={() => navigate(hq ? '/hq/sales-report' : '/pos')}>
              <FiShoppingCart className="nav-icon" />
            </div>
          ) : (
            <>
              <div className={`nav-group-header ${isGroupActive(['/pos', '/hq/sales-report']) ? 'active' : ''}`} onClick={() => toggleGroup('pos')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiShoppingCart className="nav-icon" />
                  <span>{t('sales')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.pos ? 'open' : ''}`} />
              </div>
              {openGroups.pos && (
                <div className="nav-children">
                  {/* v1.9.25 — HQ Sales Report sits inside the Sales group
                      (HQ-only). Branch never sees this; HQ never sees the
                      branch /pos/sales-report below. */}
                  {canSeeHqPages && hasPageAccess('HqSalesReport') && (
                    <div className={`nav-item ${isActive('/hq/sales-report') ? 'active' : ''}`} onClick={() => navigate('/hq/sales-report')}>
                      <FiFileText className="nav-icon" /> <span>HQ Sales Report</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('POS') && (
                    <div className={`nav-item ${isActive('/pos') ? 'active' : ''}`} onClick={() => navigate('/pos')}>
                      <FiShoppingCart className="nav-icon" /> <span>{t('pos')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('POS', 'Quotations') && (
                    <div className={`nav-item ${isActive('/pos/quotations') ? 'active' : ''}`} onClick={() => navigate('/pos/quotations')}>
                      <FiFileText className="nav-icon" /> <span>Quotations</span>
                    </div>
                  )}
                  {/* v1.9.25 — all the branch-side Sales children gate on
                      !hq so HQ only sees HQ Sales Report above. */}
                  {!hq && (workflowMode === 'three_station' || workflowMode === 'two_station') && hasPageAccess('Cashier') && (
                    <div className={`nav-item ${isActive('/pos/cashier') ? 'active' : ''}`} onClick={() => navigate('/pos/cashier')}>
                      <FiCreditCard className="nav-icon" /> <span>Cashier</span>
                      {badges.cashier_pending > 0 && <SidebarBadge n={badges.cashier_pending} />}
                    </div>
                  )}
                  {!hq && workflowMode === 'three_station' && hasPageAccess('Dispatch') && (
                    <div className={`nav-item ${isActive('/pos/dispatch') ? 'active' : ''}`} onClick={() => navigate('/pos/dispatch')}>
                      <FiPackage className="nav-icon" /> <span>Dispatch</span>
                      {badges.dispatch_pending > 0 && <SidebarBadge n={badges.dispatch_pending} />}
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesReport') && (
                    <div className={`nav-item ${isActive('/pos/sales-report') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-report')}>
                      <FiFileText className="nav-icon" /> <span>{t('salesReport')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesInventory') && (
                    <div className={`nav-item ${isActive('/pos/sales-inventory') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-inventory')}>
                      <FiList className="nav-icon" /> <span>{t('salesInventory')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('CashReport') && (
                    <div className={`nav-item ${isActive('/pos/cash-report') ? 'active' : ''}`} onClick={() => navigate('/pos/cash-report')}>
                      <FiDollarSign className="nav-icon" /> <span>{t('cashReport')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesBinCard') && (
                    <div className={`nav-item ${isActive('/pos/sales-bin-card') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-bin-card')}>
                      <FiBook className="nav-icon" /> <span>Sales Bin Card</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesStockCard') && (
                    <div className={`nav-item ${isActive('/pos/sales-stock-card') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-stock-card')}>
                      <FiList className="nav-icon" /> <span>Sales Stock Card</span>
                    </div>
                  )}
                </div>
              )}
            </>
          ))}

          {/* Stock Group */}
          {/* v1.10.298 — Store gate widened to include the branch keys added
              in v1.10.245 (QuickPrice, StockReconciliation, IncomingStock,
              StockTransfers) plus every HQ page rendered as a child below.
              Real report 2026-08-06: user edron sianongo on mansa1 had
              IncomingStock + StockTransfers ticked but the whole Store
              dropdown was hidden — no key in his perms matched this list.
              Every child still has its own hasPageAccess() guard so widening
              the parent can't leak anything. */}
          {!collapsed && hasPageAccess(
            'Items', 'GRN', 'SIV', 'SalesReturns', 'Inventory', 'BinCard',
            'StockAdjustment', 'Categories', 'ExpiryReport', 'StockCount',
            'QuickPrice', 'StockReconciliation', 'IncomingStock', 'StockTransfers',
            'HqInventoryReport', 'HqPurchases', 'HqCostOfDelivery',
            'HqConfirmGrn', 'HqGrnArchive', 'HqVariances', 'HqConfirmDamages'
          ) && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/stock']) ? 'active' : ''}`} onClick={() => toggleGroup('stock')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiPackage className="nav-icon" />
                  <span>{t('store')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.stock ? 'open' : ''}`} />
              </div>
              {openGroups.stock && (
                <div className="nav-children">
                  {hasPageAccess('Items') && (
                    <div className={`nav-item ${isActive('/stock/items') ? 'active' : ''}`} onClick={() => navigate('/stock/items')}>
                      <FiFileText className="nav-icon" /> <span>{t('itemDetails')}</span>
                    </div>
                  )}
                  {/* v1.9.25 — HQ procurement + stock supervision children
                      relocated from the flat top-level into the Store group.
                      All gated with `hq`; branches never see them. */}
                  {canSeeHqPages && hasPageAccess('HqInventoryReport') && (
                    <div className={`nav-item ${isActive('/hq/inventory-report') ? 'active' : ''}`} onClick={() => navigate('/hq/inventory-report')}>
                      <FiPackage className="nav-icon" /> <span>HQ Inventory</span>
                    </div>
                  )}
                  {canSeeHqPages && hasPageAccess('HqPurchases') && (
                    <div className={`nav-item ${isActive('/hq/purchases') ? 'active' : ''}`} onClick={() => navigate('/hq/purchases')}>
                      <FiClipboard className="nav-icon" /> <span>HQ Purchases</span>
                    </div>
                  )}
                  {/* v1.10.185 — Cost of Delivery lives next to HQ Purchases
                      because it's the same conceptual family (procurement
                      side). Landed cost attached to a PO or a transfer,
                      absorbed into WAC on GRN / transfer receive. */}
                  {canSeeHqPages && hasPageAccess('HqCostOfDelivery') && (
                    <div className={`nav-item ${isActive('/hq/cost-of-delivery') ? 'active' : ''}`} onClick={() => navigate('/hq/cost-of-delivery')}>
                      <FiTruck className="nav-icon" /> <span>Cost of Delivery</span>
                    </div>
                  )}
                  {/* v1.10.201 → v1.10.212 — HQ release gate removed;
                      transfers now go straight to PENDING and the
                      destination sees them immediately. HQ still
                      attaches optional LCVs via the Cost of Delivery
                      page. Sidebar entry hidden; the page + endpoint
                      remain reachable by URL as a safety net. Remove
                      entirely in a follow-up if this stays off. */}
                  {canSeeHqPages && hasPageAccess('HqConfirmGrn') && (
                    <div className={`nav-item ${isActive('/hq/confirm-grn') ? 'active' : ''}`} onClick={() => navigate('/hq/confirm-grn')}>
                      <FiCheckCircle className="nav-icon" /> <span>Generate GRN</span>
                      {badges.hq_pending_grn > 0 && <SidebarBadge n={badges.hq_pending_grn} />}
                    </div>
                  )}
                  {canSeeHqPages && hasPageAccess('HqGrnArchive') && (
                    <div className={`nav-item ${isActive('/hq/grn-archive') ? 'active' : ''}`} onClick={() => navigate('/hq/grn-archive')}>
                      <FiInbox className="nav-icon" /> <span>GRN Archive</span>
                    </div>
                  )}
                  {isAdmin && canSeeHqPages && (
                    <div className={`nav-item ${isActive('/hq/transfers-awaiting') ? 'active' : ''}`} onClick={() => navigate('/hq/transfers-awaiting')}>
                      <FiTruck className="nav-icon" /> <span>Transfers Awaiting</span>
                    </div>
                  )}
                  {isAdmin && canSeeHqPages && (
                    <div className={`nav-item ${isActive('/hq/products') ? 'active' : ''}`} onClick={() => navigate('/hq/products')}>
                      <FiList className="nav-icon" /> <span>HQ Products</span>
                    </div>
                  )}
                  {/* v1.10.112 — wire the Liquor-style GRN page (/stock/grn)
                      into the HQ Store menu. The page code already exists and
                      returns correct data on HQ context; only the menu link
                      was missing. Keeps HQ Purchases + Generate GRN + GRN
                      Archive alongside as separate flows — user asked. */}
                  {hq && hasPageAccess('GRN') && (
                    <div className={`nav-item ${isActive('/stock/grn') ? 'active' : ''}`} onClick={() => navigate('/stock/grn')}>
                      <FiDownload className="nav-icon" /> <span>GRN</span>
                    </div>
                  )}
                  {canSeeHqPages && hasPageAccess('HqVariances') && (
                    <div className={`nav-item ${isActive('/hq/variances') ? 'active' : ''}`} onClick={() => navigate('/hq/variances')}>
                      <FiAlertTriangle className="nav-icon" /> <span>Transit Variances</span>
                    </div>
                  )}
                  {canSeeHqPages && hasPageAccess('HqConfirmDamages') && (
                    <div className={`nav-item ${isActive('/hq/confirm-damages') ? 'active' : ''}`} onClick={() => navigate('/hq/confirm-damages')}>
                      <FiAlertTriangle className="nav-icon" /> <span>Confirm Damages</span>
                      {badges.hq_pending_damages > 0 && <SidebarBadge n={badges.hq_pending_damages} />}
                    </div>
                  )}
                  {/* v1.8.34 — Quick Price Update. Bulk selling-price editor.
                      Branch-only (HQ doesn't manage prices) and gated by
                      Items:Edit so cashier-supervisors can adjust prices
                      without full item-edit rights. */}
                  {!hq && hasPageAccess('QuickPrice') && (
                    <div className={`nav-item ${isActive('/stock/quick-price') ? 'active' : ''}`} onClick={() => navigate('/stock/quick-price')}>
                      <FiDollarSign className="nav-icon" /> <span>Quick Price</span>
                    </div>
                  )}
                  {/* v1.8.9 — at HQ, the Store group keeps only Item Details
                      + Categories and Units (HQ-owned data pushed to branches).
                      Everything else here (GRN, SIV, Sales Damages, Bin Card,
                      Stock Count, Incoming Stock, Inter-Branch Transfers …)
                      is branch-side operational. Hidden when !hq is false. */}
                  {/* v1.8.29 — GRN hidden on branches TEMPORARILY until
                      HQ purchase-order flow is wired up. Branch will only
                      receive stock via Inter-Branch Transfer or HQ PO. */}
                  {isAdmin && !hq && showLegacyProcurement && hasPageAccess('GRN') && (
                    <div className={`nav-item ${isActive('/stock/grn') ? 'active' : ''}`} onClick={() => navigate('/stock/grn')}>
                      <FiDownload className="nav-icon" /> <span>{t('grn')}</span>
                    </div>
                  )}
                  {!hq && !branchOnly && hasPageAccess('SIV') && (
                    <div className={`nav-item ${isActive('/stock/siv') ? 'active' : ''}`} onClick={() => navigate('/stock/siv')}>
                      <FiUpload className="nav-icon" /> <span>{t('siv')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesReturns') && (
                    <div className={`nav-item ${isActive('/stock/sales-damages') ? 'active' : ''}`} onClick={() => navigate('/stock/sales-damages')}>
                      <FiCornerDownLeft className="nav-icon" /> <span>Sales Damages</span>
                    </div>
                  )}
                  {/* v1.8.29 — Store > Inventory ('Store Stock card')
                      hidden on branches TEMPORARILY until HQ flow stabilises.
                      Re-enable when stock-receipt-via-HQ is fully working. */}
                  {isAdmin && !hq && hasPageAccess('Inventory') && (
                    <div className={`nav-item ${isActive('/stock/inventory') ? 'active' : ''}`} onClick={() => navigate('/stock/inventory')}>
                      <FiList className="nav-icon" /> <span>{t('inventory')}</span>
                    </div>
                  )}
                  {/* v1.8.29 — Store > Bin Card hidden on branches per
                      user request. Route still works for direct URL access. */}
                  {isAdmin && !hq && hasPageAccess('BinCard') && (
                    <div className={`nav-item ${isActive('/stock/bin-card') ? 'active' : ''}`} onClick={() => navigate('/stock/bin-card')}>
                      <FiList className="nav-icon" /> <span>{t('binCard')}</span>
                    </div>
                  )}
                  {/* Stock Adjustment — replaced by Stock Reconciliation (Store floor). Hidden but route still works in case of legacy access. */}
                  {isAdmin && !hq && hasPageAccess('StockAdjustment') && (
                    <div className={`nav-item ${isActive('/stock/adjustments') ? 'active' : ''}`} onClick={() => navigate('/stock/adjustments')}>
                      <FiSliders className="nav-icon" /> <span>{t('stockAdjustment')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('StockReconciliation') && (
                    <div className={`nav-item ${isActive('/stock/reconciliation') ? 'active' : ''}`} onClick={() => navigate('/stock/reconciliation')}>
                      <FiCheckCircle className="nav-icon" /> <span>Stock Reconciliation</span>
                    </div>
                  )}
                  {/* v1.8.29 — Categories and Units hidden on branches
                      (HQ-owned data; branch never edits it). Visible at HQ. */}
                  {canSeeHqPages && hasPageAccess('Categories') && (
                    <div className={`nav-item ${isActive('/stock/categories') ? 'active' : ''}`} onClick={() => navigate('/stock/categories')}>
                      <FiList className="nav-icon" /> <span>Categories and Units</span>
                    </div>
                  )}
                  {/* v1.8.29 — Expiry Report + Stock Count hidden on
                      branches per user request. Permanent (to be removed). */}
                  {isAdmin && !hq && hasPageAccess('ExpiryReport') && (
                    <div className={`nav-item ${isActive('/stock/expiry-report') ? 'active' : ''}`} onClick={() => navigate('/stock/expiry-report')}>
                      <FiAlertTriangle className="nav-icon" /> <span>Expiry Report</span>
                    </div>
                  )}
                  {isAdmin && !hq && hasPageAccess('StockCount') && (
                    <div className={`nav-item ${isActive('/stock/stock-count') ? 'active' : ''}`} onClick={() => navigate('/stock/stock-count')}>
                      <FiClipboard className="nav-icon" /> <span>Stock Count</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('IncomingStock') && (
                    <div className={`nav-item ${isActive('/stock/incoming') ? 'active' : ''}`} onClick={() => navigate('/stock/incoming')}>
                      <FiInbox className="nav-icon" /> <span>Incoming Stock</span>
                      {badges.incoming_stock > 0 && <SidebarBadge n={badges.incoming_stock} />}
                    </div>
                  )}
                  {!hq && hasPageAccess('StockTransfers') && (
                    <div className={`nav-item ${isActive('/stock/transfers') ? 'active' : ''}`} onClick={() => navigate('/stock/transfers')}>
                      <FiTruck className="nav-icon" /> <span>Inter-Branch Transfers</span>
                      {badges.incoming_transfers > 0 && <SidebarBadge n={badges.incoming_transfers} />}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Accounting Group.
              v1.8.9 — Originally hidden on HQ (no per-tenant till).
              v1.8.61 — HQ now needs Cash Book + HQ Deposits inbox, so the
              group renders on HQ too. Per-item visibility flags below keep
              HQ from seeing branch-only entries (Cash Receipt / PV /
              Receivables / Profit Report). */}
          {/* v1.10.298 — Accounting gate widened to include the 8 HQ-side keys
              (PvTypes, HQDeposits, CapitalAccount, DividendAccount,
              Shareholders, LoanAccount, HqCashPosition, HqConsolidatedProfit)
              that render as children below. Was gated on only 7 keys → a
              user with just LoanAccount:View (or Shareholders, or HQ Deposits)
              saw no Accounting section at all. Same pattern as the Store
              gate fix in this bump. */}
          {!collapsed && hasPageAccess(
            'CashReceipt', 'PaymentVoucher', 'PvTypes', 'CashBook', 'HQDeposits',
            'FxRates', 'AccountPayables', 'AccountReceivables', 'ProfitReport',
            'CapitalAccount', 'DividendAccount', 'Shareholders', 'LoanAccount',
            'HqCashPosition', 'HqConsolidatedProfit', 'HqFinancialStatements',
            'HqAccountReceivables'
          ) && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/accounting']) ? 'active' : ''}`} onClick={() => toggleGroup('accounting')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiDollarSign className="nav-icon" />
                  <span>{t('accounting')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.accounting ? 'open' : ''}`} />
              </div>
              {openGroups.accounting && (
                <div className="nav-children">
                  {/* v1.9.25 — HQ Cash Position relocated from the flat
                      top-level into the Accounting group. */}
                  {canSeeHqPages && hasPageAccess('HqCashPosition') && (
                    <div className={`nav-item ${isActive('/hq/cash-position') ? 'active' : ''}`} onClick={() => navigate('/hq/cash-position')}>
                      <FiDollarSign className="nav-icon" /> <span>HQ Cash Position</span>
                    </div>
                  )}
                  {/* Cash Receipt / Payment Voucher.
                      v1.8.9 hid these on HQ under the assumption that HQ
                      had no till of its own — only Branch → HQ deposits.
                      v1.10.40 — HQ does run a real till (its own opening
                      balance, its own Cash Book with USD/FRA/K columns).
                      CR + PV are the two entry points that FEED that
                      Cash Book, so hiding them on HQ made it impossible
                      to record HQ-side inflows (rent, refunds) or
                      outflows (utilities, staff advances). Now shown on
                      HQ too. AR + Profit Report stay branch-only for now
                      (separate scopes; ask when needed). */}
                  {hasPageAccess('CashReceipt') && (
                    <div className={`nav-item ${isActive('/accounting/cash-receipts') ? 'active' : ''}`} onClick={() => navigate('/accounting/cash-receipts')}>
                      <FiBook className="nav-icon" /> <span>{t('cashReceipt')}</span>
                    </div>
                  )}
                  {hasPageAccess('PaymentVoucher') && (
                    <div className={`nav-item ${isActive('/accounting/payment-vouchers') ? 'active' : ''}`} onClick={() => navigate('/accounting/payment-vouchers')}>
                      <FiCreditCard className="nav-icon" /> <span>{t('paymentVoucher')}</span>
                    </div>
                  )}
                  {hasPageAccess('CashBook') && (
                    <div className={`nav-item ${isActive('/accounting/cash-book') ? 'active' : ''}`} onClick={() => navigate('/accounting/cash-book')}>
                      <FiClipboard className="nav-icon" /> <span>{t('cashBook')}</span>
                    </div>
                  )}
                  {/* v1.8.59 — Branch → HQ Cash Deposit workflow.
                      Same page used by branch (Send) and HQ (Confirm/Reject).
                      v1.10.90 — HQDeposits now has its own permission entry so
                      admins can grant/revoke it independently of Cash Book.
                      Fall back to CashBook access to keep pre-v1.10.90 grants
                      working (existing users don't lose access on upgrade). */}
                  {(hasPageAccess('HQDeposits') || hasPageAccess('CashBook')) && (
                    <div className={`nav-item ${isActive('/accounting/hq-deposits') ? 'active' : ''}`} onClick={() => navigate('/accounting/hq-deposits')}>
                      <FiSend className="nav-icon" /> <span>HQ Deposits</span>
                    </div>
                  )}
                  {/* v1.10.89 — was `!hq && isDualCurrency`, which hid FX Rates on
                      HQ. But HQ's Cash Book "K & K Equivalent" tile needs a
                      rate to convert USD + FRA into K; without one it silently
                      collapses to raw K. HQ is effectively tri-currency (it
                      receives deposits in USD / FRA / K from branches) so it
                      needs its own rate. Show on HQ unconditionally + on
                      dual-currency branches. */}
                  {(hq || isDualCurrency || isAdmin) && hasPageAccess('FxRates') && (
                    <div className={`nav-item ${isActive('/accounting/fx-rates') ? 'active' : ''}`} onClick={() => navigate('/accounting/fx-rates')}>
                      <FiDollarSign className="nav-icon" /> <span>Currency Rates</span>
                    </div>
                  )}
                  {/* v1.8.29 — Account Payables hidden on branches per
                      user request (branch doesn't manage supplier AP). */}
                  {canSeeHqPages && showLegacyProcurement && hasPageAccess('AccountPayables') && (
                    <div className={`nav-item ${isActive('/accounting/account-payables') ? 'active' : ''}`} onClick={() => navigate('/accounting/account-payables')}>
                      <FiFileText className="nav-icon" /> <span>{t('accountPayables')}</span>
                    </div>
                  )}
                  {/* HQ sees every branch's receivables on one read-only page. */}
                  {canSeeHqPages && hasPageAccess('HqAccountReceivables') && (
                    <div className={`nav-item ${isActive('/hq/account-receivables') ? 'active' : ''}`} onClick={() => navigate('/hq/account-receivables')}>
                      <FiFileText className="nav-icon" /> <span>{hq ? 'Account Receivables' : 'HQ Account Receivables'}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('AccountReceivables') && (
                    <div className={`nav-item ${isActive('/accounting/account-receivables') ? 'active' : ''}`} onClick={() => navigate('/accounting/account-receivables')}>
                      <FiFileText className="nav-icon" /> <span>Account Receivables</span>
                    </div>
                  )}
                  {!branchOnly && isAllAccess() && user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/accounting/credit-notes') ? 'active' : ''}`} onClick={() => navigate('/accounting/credit-notes')}>
                      <FiCreditCard className="nav-icon" /> <span>Credit Notes</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('CapitalAccount') && (
                    <div className={`nav-item ${isActive('/accounting/capital-account') ? 'active' : ''}`} onClick={() => navigate('/accounting/capital-account')}>
                      <FiTrendingUp className="nav-icon" /> <span>Capital Account</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('DividendAccount') && (
                    <div className={`nav-item ${isActive('/accounting/dividend-account') ? 'active' : ''}`} onClick={() => navigate('/accounting/dividend-account')}>
                      <FiDollarSign className="nav-icon" /> <span>Dividend Account</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('Shareholders') && (
                    <div className={`nav-item ${isActive('/accounting/shareholders') ? 'active' : ''}`} onClick={() => navigate('/accounting/shareholders')}>
                      <FiUsers className="nav-icon" /> <span>Shareholders</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('LoanAccount') && (
                    <div className={`nav-item ${isActive('/accounting/loans') ? 'active' : ''}`} onClick={() => navigate('/accounting/loans')}>
                      <FiTrendingDown className="nav-icon" /> <span>Loan Account</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('ProfitReport') && (
                    <div className={`nav-item ${isActive('/accounting/profit-report') ? 'active' : ''}`} onClick={() => navigate('/accounting/profit-report')}>
                      <FiTrendingUp className="nav-icon" /> <span>Profit Report</span>
                    </div>
                  )}
                  {/* v1.10.233 — HQ Consolidated Profit. v1.10.245 gated by
                      HqConsolidatedProfit perm (see Users page catalog). */}
                  {canSeeHqPages && hasPageAccess('HqConsolidatedProfit') && (
                    <div className={`nav-item ${isActive('/hq/consolidated-profit') ? 'active' : ''}`} onClick={() => navigate('/hq/consolidated-profit')}>
                      <FiTrendingUp className="nav-icon" /> <span>HQ Consolidated Profit</span>
                    </div>
                  )}
                  {/* Financial Statements combines all branches; access is
                      controlled by the dedicated HqFinancialStatements permission. */}
                  {hasPageAccess('HqFinancialStatements') && (
                    <div className={`nav-item ${isActive('/hq/financial-statements') ? 'active' : ''}`} onClick={() => navigate('/hq/financial-statements')}>
                      <FiTrendingUp className="nav-icon" /> <span>{hq ? 'Financial Statements' : 'Financial Statements (All Branches)'}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Suppliers & Customers Group.
              v1.9.25 — Group now renders on HQ too so HQ Suppliers can live
              inside it instead of as a flat top-level entry. Branch shows
              Customers (and legacy Suppliers when enabled); HQ shows HQ
              Suppliers. */}
          {!collapsed && (hq || hasPageAccess('Suppliers', 'Customers')) && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/suppliers-customers', '/hq/suppliers']) ? 'active' : ''}`} onClick={() => toggleGroup('suppliersCustomers')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiUsers className="nav-icon" />
                  <span>{t('suppliersCustomers')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.suppliersCustomers ? 'open' : ''}`} />
              </div>
              {openGroups.suppliersCustomers && (
                <div className="nav-children">
                  {canSeeHqPages && hasPageAccess('HqSuppliers') && (
                    <div className={`nav-item ${isActive('/hq/suppliers') ? 'active' : ''}`} onClick={() => navigate('/hq/suppliers')}>
                      <FiUsers className="nav-icon" /> <span>HQ Suppliers</span>
                    </div>
                  )}
                  {/* v1.8.29 — branch Suppliers hidden per user request
                      (HQ owns the supplier master + AP). */}
                  {isAdmin && !hq && showLegacyProcurement && hasPageAccess('Suppliers') && (
                    <div className={`nav-item ${isActive('/suppliers-customers/suppliers') ? 'active' : ''}`} onClick={() => navigate('/suppliers-customers/suppliers')}>
                      <FiUserPlus className="nav-icon" /> <span>{t('suppliers')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('Customers') && (
                    <div className={`nav-item ${isActive('/suppliers-customers/customers') ? 'active' : ''}`} onClick={() => navigate('/suppliers-customers/customers')}>
                      <FiUser className="nav-icon" /> <span>{t('customers')}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Approvals — top-level entry, gated by the 'Approvals'
              permission. v1.10.262 — released from admin-only (was
              user?.role === 'Administrator') so an admin can delegate
              discount approvals to a manager without granting full
              admin. Administrator role auto-passes via hasPageAccess.
              v1.8.9 — hidden at HQ (discount requests originate at
              branches, never at HQ). */}
          {!hq && !collapsed && hasPageAccess('Approvals') && (
            <div
              className={`nav-item ${isActive('/approvals/discounts') ? 'active' : ''}`}
              onClick={() => navigate('/approvals/discounts')}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <FiTag className="nav-icon" /> <span>Approvals</span>
              </div>
              {pendingDiscountCount > 0 && (
                <span style={{ minWidth: 22, height: 22, padding: '0 6px', borderRadius: 11, background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 4 }}>
                  {pendingDiscountCount > 99 ? '99+' : pendingDiscountCount}
                </span>
              )}
            </div>
          )}

          {/* Settings Group — All Access users only */}
          {!collapsed && isAllAccess() && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/settings']) ? 'active' : ''}`} onClick={() => toggleGroup('settings')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiSettings className="nav-icon" />
                  <span>{t('settings')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.settings ? 'open' : ''}`} />
              </div>
              {openGroups.settings && (
                <div className="nav-children">
                  <div className={`nav-item ${isActive('/settings/profile') ? 'active' : ''}`} onClick={() => navigate('/settings/profile')}>
                    <FiUser className="nav-icon" /> <span>{t('profile')}</span>
                  </div>
                  {/* v1.8.29 + v1.8.37 — passcode gate via in-app modal
                      (window.prompt is silently blocked by Electron, so
                      the click used to do nothing). */}
                  <div className={`nav-item ${isActive('/settings/system') ? 'active' : ''}`} onClick={() => openPasscodeGate('/settings/system', 'System Settings')}>
                    <FiSliders className="nav-icon" /> <span>System Settings</span>
                  </div>
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/settings/users') ? 'active' : ''}`} onClick={() => navigate('/settings/users')}>
                      <FiUsers className="nav-icon" /> <span>{t('users')}</span>
                    </div>
                  )}
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/setup') ? 'active' : ''}`} onClick={() => openPasscodeGate('/setup', 'Cloud Sync')}>
                      <FiCloud className="nav-icon" /> <span>Cloud Sync</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </nav>

        {/* Sidebar Footer */}
        {!collapsed && (
          <div className="sidebar-footer">
            <div className="user-info">
              <div className="user-avatar">{initials}</div>
              <div className="user-details">
                <h4>{user?.firstName} {user?.lastName}</h4>
                <p>{user?.role}</p>
              </div>
            </div>
            <button className="logout-btn" onClick={() => { logout(); navigate('/login'); }}>
              <span className="logout-icon-wrap"><RiLogoutBoxRLine aria-hidden="true" /></span>
              <span>{t('logout')}</span>
            </button>
            <p style={{ fontSize: 10, color: '#475569', textAlign: 'center', marginTop: 4 }}>v{version}</p>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="main-content">
        {/* HQ amber stripe — unmistakable "you are in HQ mode" cue. Only
            rendered on the bare sosnazm.com host; branch subdomains never
            show it. Thin 3px bar so it doesn't steal real estate. */}
        {hq && (
          <div style={{
            height: 3,
            background: 'linear-gradient(90deg, #D97706 0%, #F59E0B 50%, #D97706 100%)',
            boxShadow: '0 1px 4px rgba(217,119,6,0.4)',
          }} />
        )}
        {/* Top Header */}
        <div className="top-header">
          <div className="top-header-left">
            <button className="sidebar-toggle" onClick={() => isPhoneViewport() ? setMobileOpen(o => !o) : setCollapsed(!collapsed)} style={{ marginRight: 8, color: '#374151' }}>
              <FiMenu />
            </button>
            <h2>{pageTitle()}</h2>
          </div>
          <div className="top-header-right">
            <div ref={searchRef} style={{ position: 'relative' }}>
              <div className="search-bar">
                <FiSearch style={{ color: '#9ca3af' }} />
                <input
                  type="text"
                  placeholder={t('search')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                />
              </div>
              {searchOpen && (
                <div style={{ position: 'absolute', top: '110%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 1000, overflow: 'hidden', minWidth: 280 }}>
                  {searchResults.map((r, i) => (
                    <div
                      key={i}
                      onClick={() => handleSearchSelect(r.path)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', borderBottom: i < searchResults.length - 1 ? '1px solid #f1f5f9' : 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                      onMouseLeave={e => e.currentTarget.style.background = '#fff'}
                    >
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: `${typeColors[r.type]}18`, color: typeColors[r.type], minWidth: 56, textAlign: 'center' }}>{r.type}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 500, color: '#111827' }}>{r.label}</div>
                        {r.sub && <div style={{ fontSize: 12, color: '#9ca3af' }}>{r.sub}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Refresh Page — remounts the current route (via Outlet key bump)
                so its useEffects re-run and the page re-fetches the latest
                data. Lighter than window.location.reload(): no full app reboot,
                no token loss, no deep-path 404 on Electron. */}
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              title="Refresh page (show latest data)"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 36, height: 36, padding: 0,
                border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
                cursor: 'pointer', color: '#374151',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#1f2937'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = '#374151'; }}
            >
              <FiRefreshCw size={16} />
            </button>

            {/* Language Selector */}
            <div ref={langRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setShowLangMenu(p => !p)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
              >
                <FiGlobe size={15} style={{ color: '#6b7280' }} />
                <span>{currentLang.flag}</span>
                <span>{currentLang.label}</span>
                <FiChevronDown size={13} style={{ color: '#9ca3af' }} />
              </button>
              {showLangMenu && (
                <div style={{ position: 'absolute', top: '110%', right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 999, minWidth: 160, overflow: 'hidden' }}>
                  {LANGUAGES.map(lang => (
                    <div
                      key={lang.code}
                      onClick={() => handleLangSelect(lang.code)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                        cursor: 'pointer', fontSize: 13, fontWeight: language === lang.code ? 600 : 400,
                        background: language === lang.code ? '#f0f9ff' : '#fff',
                        color: language === lang.code ? '#2563eb' : '#374151',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = language === lang.code ? '#f0f9ff' : '#f9fafb'}
                      onMouseLeave={e => e.currentTarget.style.background = language === lang.code ? '#f0f9ff' : '#fff'}
                    >
                      <span style={{ fontSize: 18 }}>{lang.flag}</span>
                      <span>{lang.label}</span>
                      {language === lang.code && <span style={{ marginLeft: 'auto', color: '#2563eb' }}>✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="hide-on-mobile"><SyncStatus /></div>

            {/* v1.10.243 — real bell dropdown. Was a static "2" placeholder.
                Contents scoped by context: HQ shows HQ-only queues (Generate
                GRN, Confirm Damages); branches show branch queues (Cashier,
                Dispatch, Incoming Stock/Transfers). Same badges state the
                sidebar reads, second surface. */}
            {(() => {
              const bellRows = hq
                ? [
                    { key: 'gen',      n: badges.hq_pending_grn,     label: 'GRNs to generate',      path: '/hq/confirm-grn'    },
                    { key: 'dmg',      n: badges.hq_pending_damages, label: 'Damages to confirm',    path: '/hq/confirm-damages' },
                  ]
                : [
                    { key: 'cashier',  n: badges.cashier_pending,    label: 'Orders awaiting cashier',  path: '/cashier'          },
                    { key: 'dispatch', n: badges.dispatch_pending,   label: 'Orders awaiting dispatch', path: '/dispatch'         },
                    { key: 'incStock', n: badges.incoming_stock,     label: 'Incoming stock',           path: '/stock/incoming'   },
                    { key: 'incXfer',  n: badges.incoming_transfers, label: 'Incoming transfers',       path: '/stock/transfers'  },
                  ];
              const active = bellRows.filter(r => (r.n || 0) > 0);
              const total  = active.reduce((s, r) => s + r.n, 0);
              return (
                <div ref={bellRef} className="hide-on-mobile" style={{ position: 'relative' }}>
                  <button className="notification-btn" onClick={() => setShowBellMenu(v => !v)}>
                    <FiBell />
                    {total > 0 && <span className="notification-badge">{total > 99 ? '99+' : total}</span>}
                  </button>
                  {showBellMenu && (
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
                      boxShadow: '0 12px 32px rgba(15,23,42,0.15)', minWidth: 280, zIndex: 200,
                      overflow: 'hidden',
                    }}>
                      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                          Notifications
                        </span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>{hq ? 'HQ' : (getHqBranch() || 'Branch')}</span>
                      </div>
                      {active.length === 0 ? (
                        <div style={{ padding: '20px 14px', textAlign: 'center', color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>
                          No pending items — you're all caught up.
                        </div>
                      ) : (
                        active.map(row => (
                          <div
                            key={row.key}
                            onClick={() => { setShowBellMenu(false); navigate(row.path); }}
                            style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '11px 14px', cursor: 'pointer',
                              borderTop: '1px solid #f8fafc',
                              transition: 'background 0.15s',
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                            onMouseLeave={e => e.currentTarget.style.background = '#fff'}
                          >
                            <span style={{ fontSize: 13, color: '#0f172a' }}>{row.label}</span>
                            <span style={{
                              background: '#0ea5e9', color: '#fff',
                              fontSize: 11, fontWeight: 700,
                              minWidth: 22, height: 22, borderRadius: 11,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              padding: '0 7px',
                            }}>{row.n > 99 ? '99+' : row.n}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="date-display hide-on-mobile">
              <div style={{ fontWeight: 700 }}>{dateStr}</div>
              <div style={{ fontWeight: 700 }}>{timeStr}</div>
            </div>
          </div>
        </div>

        {/* Page Content - rendered by child routes */}
        <Outlet key={refreshKey} />
      </div>

      {/* v1.8.37 — in-app passcode modal. Replaces window.prompt which
          Electron silently blocks. Renders only when passcodeGate state
          is non-null (set by openPasscodeGate on a gated nav click). */}
      {passcodeGate && (
        <div onClick={() => setPasscodeGate(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 360, maxWidth: '92vw', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>{passcodeGate.label}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Enter the admin passcode to continue.</div>
            <input
              type="password" autoFocus
              value={passcodeGate.value}
              onChange={e => setPasscodeGate(prev => ({ ...prev, value: e.target.value, error: '' }))}
              onKeyDown={e => { if (e.key === 'Enter') submitPasscode(); if (e.key === 'Escape') setPasscodeGate(null); }}
              placeholder="Passcode"
              style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: passcodeGate.error ? '2px solid #ef4444' : '1.5px solid #d1d5db', fontSize: 16, letterSpacing: 4, textAlign: 'center', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }}
            />
            {passcodeGate.error && (
              <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6, fontWeight: 600 }}>{passcodeGate.error}</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setPasscodeGate(null)}
                style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={submitPasscode}
                style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: '#1d4ed8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Continue</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Tiny red pill rendered to the right of a sidebar entry when there's
// pending work. Numbers >99 collapse to "99+" so the pill stays compact.
function SidebarBadge({ n }) {
  const label = n > 99 ? '99+' : String(n);
  return (
    <span style={{
      marginLeft: 'auto',
      background: '#dc2626', color: '#fff',
      fontSize: 10, fontWeight: 800,
      minWidth: 18, height: 18, padding: '0 5px',
      borderRadius: 9, display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center',
      lineHeight: 1,
    }}>{label}</span>
  );
}

export default Layout;
