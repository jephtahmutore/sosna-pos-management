import React, { useState, useEffect, useRef } from 'react';
import pkg from '../../package.json';
const { version } = pkg;
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import { isHqHost, getHqBranch, setHqBranch, getHqBranches, getNotificationBadges } from '../services/api';
import SyncStatus from './SyncStatus';
import { getDiscountRequestsPendingCount } from '../services/api';
import { FiGrid, FiShoppingCart, FiPackage, FiFileText, FiDollarSign, FiUsers, FiSettings,
         FiChevronDown, FiLogOut, FiSearch, FiBell, FiMenu, FiDownload, FiUpload, FiList,
         FiBook, FiCreditCard, FiClipboard, FiUser, FiUserPlus, FiSliders, FiGlobe, FiCloud, FiTool,
         FiCornerDownLeft, FiCornerUpLeft, FiTrendingUp, FiTrendingDown, FiAlertTriangle, FiCheckCircle, FiTag, FiRefreshCw, FiTruck, FiInbox } from 'react-icons/fi';

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

  // POS-only: user has POS access but no broader management page access
  const isPOSOnly = user && !isAllAccess() &&
    hasPageAccess('POS') &&
    !hasPageAccess('Items', 'GRN', 'SIV', 'StockAdjustment', 'StockCount', 'Inventory',
      'CashReceipt', 'PaymentVoucher', 'CashBook', 'AccountPayables', 'AccountReceivables', 'ProfitReport',
      'Suppliers', 'Customers', 'Sales', 'Reports');
  const { language, changeLanguage, t } = useLanguage();
  // 3-station gate — only kassumbalesa1 sees the Cashier sidebar entry.
  const { workflowMode } = useCurrency();
  // HQ branch selector — only when the React app is served from the bare
  // sosnazm.com host. On real per-branch subdomains hq=false and the
  // dropdown stays hidden (the host already pins the tenant).
  const hq = isHqHost();
  const [hqBranches, setHqBranches] = useState([]);
  const [currentHqBranch, setCurrentHqBranch] = useState(() => getHqBranch());
  useEffect(() => {
    if (!hq) return;
    getHqBranches().then(r => setHqBranches(r.data?.branches || [])).catch(() => {});
  }, [hq]);
  // Sidebar badge counts for the current branch (Cashier / Dispatch
  // pending + Incoming Stock from HQ + Incoming Inter-Branch Transfers).
  // Derives slug the same way StockTransfers / IncomingStock do: HQ
  // X-Branch when on bare sosnazm.com, else host's first subdomain.
  const [badges, setBadges] = useState({ cashier_pending: 0, dispatch_pending: 0, incoming_stock: 0, incoming_transfers: 0, hq_pending_grn: 0 });
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

  const switchHqBranch = (slug) => {
    if (!slug || slug === currentHqBranch) return;
    const target = hqBranches.find(b => b.slug === slug);
    const label = target ? `${target.name} (${slug})` : slug;
    if (!window.confirm(`Switch HQ to ${label}? You'll be signed out and asked to sign in again to that branch.`)) return;
    setHqBranch(slug);
    setCurrentHqBranch(slug);
    // Clear auth so the login screen re-runs against the new branch's DB.
    try { localStorage.removeItem('token'); localStorage.removeItem('user'); } catch (_) {}
    window.location.href = '/login';
  };
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

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (langRef.current && !langRef.current.contains(e.target)) setShowLangMenu(false);
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

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setSearchOpen(false); return; }
    const q = searchQuery.toLowerCase();
    const token = localStorage.getItem('token');
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/products', { headers }).then(r => r.json()).catch(() => []),
      fetch('/api/customers', { headers }).then(r => r.json()).catch(() => []),
      fetch('/api/suppliers', { headers }).then(r => r.json()).catch(() => []),
    ]).then(([products, customers, suppliers]) => {
      const results = [];
      (Array.isArray(products) ? products : products.data || [])
        .filter(p => (p.name || '').toLowerCase().includes(q))
        .slice(0, 4)
        .forEach(p => results.push({ type: 'Product', label: p.name, sub: `K ${p.selling_price ?? ''}`, path: '/stock/items' }));
      (Array.isArray(customers) ? customers : customers.data || [])
        .filter(c => (c.name || '').toLowerCase().includes(q))
        .slice(0, 3)
        .forEach(c => results.push({ type: 'Customer', label: c.name, sub: c.phone || '', path: '/suppliers-customers/customers' }));
      (Array.isArray(suppliers) ? suppliers : suppliers.data || [])
        .filter(s => (s.name || '').toLowerCase().includes(q))
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
      '/hq/purchases': 'HQ Purchases',
      '/hq/confirm-grn': 'Confirm GRN',
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
          <div className="sidebar-logo">🚚</div>
          {!collapsed && (
            <div className="sidebar-brand">
              <h2>Sosna{hq ? ' HQ' : ''}</h2>
              <p>{hq ? 'Head Office' : 'Management System'}</p>
            </div>
          )}
        </div>

        {/* HQ branch selector — visible only when serving from bare sosnazm.com.
            Switching forces a re-login against the chosen branch (see
            switchHqBranch above). Hidden when sidebar is collapsed. */}
        {hq && !collapsed && (
          <div style={{ padding: '8px 12px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <label style={{ display: 'block', fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>
              Active Branch
            </label>
            <select value={currentHqBranch}
              onChange={e => switchHqBranch(e.target.value)}
              style={{
                width: '100%', padding: '7px 10px',
                background: 'rgba(255,255,255,0.08)', color: '#fff',
                border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
                fontSize: 13, fontWeight: 600, outline: 'none',
              }}>
              {!currentHqBranch && <option value="">— pick a branch —</option>}
              {hqBranches.map(b => (
                <option key={b.slug} value={b.slug} style={{ color: '#0f172a' }}>
                  {b.name} ({b.slug})
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="sidebar-nav">
          {/* HQ Overview — only when serving from bare sosnazm.com.
              Sits above Dashboard because it's the natural landing page
              for an HQ operator (cross-branch snapshot, jump-to-branch). */}
          {hq && (
            <div className={`nav-item ${isActive('/hq/overview') ? 'active' : ''}`} onClick={() => navigate('/hq/overview')}>
              <FiGlobe className="nav-icon" />
              {!collapsed && <span>HQ Overview</span>}
            </div>
          )}
          {hq && (
            <div className={`nav-item ${isActive('/hq/sales-report') ? 'active' : ''}`} onClick={() => navigate('/hq/sales-report')}>
              <FiFileText className="nav-icon" />
              {!collapsed && <span>HQ Sales Report</span>}
            </div>
          )}
          {hq && (
            <div className={`nav-item ${isActive('/hq/inventory-report') ? 'active' : ''}`} onClick={() => navigate('/hq/inventory-report')}>
              <FiPackage className="nav-icon" />
              {!collapsed && <span>HQ Inventory</span>}
            </div>
          )}
          {hq && (
            <div className={`nav-item ${isActive('/hq/cash-position') ? 'active' : ''}`} onClick={() => navigate('/hq/cash-position')}>
              <FiDollarSign className="nav-icon" />
              {!collapsed && <span>HQ Cash Position</span>}
            </div>
          )}
          {/* HQ Purchases — procurement entry point. HQ logs the supplier
              purchase per-line with a destination branch; branch enters the
              actual qty on their Incoming Stock page (Submit GRN); HQ then
              confirms here (Confirm GRN) — only then does branch stock
              update + supplier AP lock in. */}
          {hq && (
            <div className={`nav-item ${isActive('/hq/purchases') ? 'active' : ''}`} onClick={() => navigate('/hq/purchases')}>
              <FiClipboard className="nav-icon" />
              {!collapsed && <span>HQ Purchases</span>}
            </div>
          )}
          {hq && (
            <div className={`nav-item ${isActive('/hq/confirm-grn') ? 'active' : ''}`} onClick={() => navigate('/hq/confirm-grn')}>
              <FiCheckCircle className="nav-icon" />
              {!collapsed && <span>Confirm GRN</span>}
              {!collapsed && badges.hq_pending_grn > 0 && <SidebarBadge n={badges.hq_pending_grn} />}
            </div>
          )}
          {/* HQ Suppliers — master list + live AP balance per supplier. */}
          {hq && (
            <div className={`nav-item ${isActive('/hq/suppliers') ? 'active' : ''}`} onClick={() => navigate('/hq/suppliers')}>
              <FiUsers className="nav-icon" />
              {!collapsed && <span>HQ Suppliers</span>}
            </div>
          )}

          {/* Dashboard — only for All access users */}
          {isAllAccess() && (
            <div className={`nav-item ${isActive('/dashboard') ? 'active' : ''}`} onClick={() => navigate('/dashboard')}>
              <FiGrid className="nav-icon" />
              {!collapsed && <span>{t('dashboard')}</span>}
            </div>
          )}

          {/* Sales Group */}
          {hasPageAccess('POS', 'Cashier', 'Dispatch', 'SalesReport', 'SalesInventory', 'CashReport', 'SalesBinCard') && (collapsed ? (
            <div className={`nav-item ${isGroupActive(['/pos']) ? 'active' : ''}`} onClick={() => navigate('/pos')}>
              <FiShoppingCart className="nav-icon" />
            </div>
          ) : (
            <>
              <div className={`nav-group-header ${isGroupActive(['/pos']) ? 'active' : ''}`} onClick={() => toggleGroup('pos')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiShoppingCart className="nav-icon" />
                  <span>{t('sales')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.pos ? 'open' : ''}`} />
              </div>
              {openGroups.pos && (
                <div className="nav-children">
                  {hasPageAccess('POS') && (
                    <div className={`nav-item ${isActive('/pos') ? 'active' : ''}`} onClick={() => navigate('/pos')}>
                      <FiShoppingCart className="nav-icon" /> <span>{t('pos')}</span>
                    </div>
                  )}
                  {/* Cashier — only shown when this branch is on the 3-station
                      workflow AND the user has explicit Cashier permission
                      (separate from POS so non-cashier staff can't take money). */}
                  {workflowMode === 'three_station' && hasPageAccess('Cashier') && (
                    <div className={`nav-item ${isActive('/pos/cashier') ? 'active' : ''}`} onClick={() => navigate('/pos/cashier')}>
                      <FiCreditCard className="nav-icon" /> <span>Cashier</span>
                      {badges.cashier_pending > 0 && <SidebarBadge n={badges.cashier_pending} />}
                    </div>
                  )}
                  {/* Dispatch — same gate, separate perm. Releases goods on PAID orders. */}
                  {workflowMode === 'three_station' && hasPageAccess('Dispatch') && (
                    <div className={`nav-item ${isActive('/pos/dispatch') ? 'active' : ''}`} onClick={() => navigate('/pos/dispatch')}>
                      <FiPackage className="nav-icon" /> <span>Dispatch</span>
                      {badges.dispatch_pending > 0 && <SidebarBadge n={badges.dispatch_pending} />}
                    </div>
                  )}
                  {hasPageAccess('SalesReport') && (
                    <div className={`nav-item ${isActive('/pos/sales-report') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-report')}>
                      <FiFileText className="nav-icon" /> <span>{t('salesReport')}</span>
                    </div>
                  )}
                  {/* Sales Inventory — replaced by Stock Reconciliation (Sales floor). Hidden but route still works in case of legacy access. */}
                  {false && hasPageAccess('SalesInventory') && (
                    <div className={`nav-item ${isActive('/pos/sales-inventory') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-inventory')}>
                      <FiList className="nav-icon" /> <span>{t('salesInventory')}</span>
                    </div>
                  )}
                  {hasPageAccess('CashReport') && (
                    <div className={`nav-item ${isActive('/pos/cash-report') ? 'active' : ''}`} onClick={() => navigate('/pos/cash-report')}>
                      <FiDollarSign className="nav-icon" /> <span>{t('cashReport')}</span>
                    </div>
                  )}
                  {hasPageAccess('SalesBinCard') && (
                    <div className={`nav-item ${isActive('/pos/sales-bin-card') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-bin-card')}>
                      <FiBook className="nav-icon" /> <span>Sales Bin Card</span>
                    </div>
                  )}
                  {hasPageAccess('Inventory') && (
                    <div className={`nav-item ${isActive('/pos/sales-stock-card') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-stock-card')}>
                      <FiList className="nav-icon" /> <span>Sales Stock Card</span>
                    </div>
                  )}
                </div>
              )}
            </>
          ))}

          {/* Stock Group */}
          {!collapsed && hasPageAccess('Items', 'GRN', 'SIV', 'SalesReturns', 'Inventory', 'BinCard', 'StockAdjustment', 'Categories', 'ExpiryReport', 'StockCount') && (
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
                  {hasPageAccess('GRN') && (
                    <div className={`nav-item ${isActive('/stock/grn') ? 'active' : ''}`} onClick={() => navigate('/stock/grn')}>
                      <FiDownload className="nav-icon" /> <span>{t('grn')}</span>
                    </div>
                  )}
                  {/* Empty Returns hidden — superseded by Credit Notes →
                      Crate Return. Route still exists for deep-links. */}
                  {hasPageAccess('SIV') && (
                    <div className={`nav-item ${isActive('/stock/siv') ? 'active' : ''}`} onClick={() => navigate('/stock/siv')}>
                      <FiUpload className="nav-icon" /> <span>{t('siv')}</span>
                    </div>
                  )}
                  {hasPageAccess('SalesReturns') && (
                    <div className={`nav-item ${isActive('/stock/sales-damages') ? 'active' : ''}`} onClick={() => navigate('/stock/sales-damages')}>
                      <FiCornerDownLeft className="nav-icon" /> <span>Sales Damages</span>
                    </div>
                  )}
                  {hasPageAccess('Inventory') && (
                    <div className={`nav-item ${isActive('/stock/inventory') ? 'active' : ''}`} onClick={() => navigate('/stock/inventory')}>
                      <FiList className="nav-icon" /> <span>{t('inventory')}</span>
                    </div>
                  )}
                  {hasPageAccess('BinCard') && (
                    <div className={`nav-item ${isActive('/stock/bin-card') ? 'active' : ''}`} onClick={() => navigate('/stock/bin-card')}>
                      <FiList className="nav-icon" /> <span>{t('binCard')}</span>
                    </div>
                  )}
                  {/* Stock Adjustment — replaced by Stock Reconciliation (Store floor). Hidden but route still works in case of legacy access. */}
                  {false && hasPageAccess('StockAdjustment') && (
                    <div className={`nav-item ${isActive('/stock/adjustments') ? 'active' : ''}`} onClick={() => navigate('/stock/adjustments')}>
                      <FiSliders className="nav-icon" /> <span>{t('stockAdjustment')}</span>
                    </div>
                  )}
                  {hasPageAccess('StockReconciliation') && (
                    <div className={`nav-item ${isActive('/stock/reconciliation') ? 'active' : ''}`} onClick={() => navigate('/stock/reconciliation')}>
                      <FiCheckCircle className="nav-icon" /> <span>Stock Reconciliation</span>
                    </div>
                  )}
                  {hasPageAccess('Categories') && (
                    <div className={`nav-item ${isActive('/stock/categories') ? 'active' : ''}`} onClick={() => navigate('/stock/categories')}>
                      <FiList className="nav-icon" /> <span>Categories and Units</span>
                    </div>
                  )}
                  {hasPageAccess('ExpiryReport') && (
                    <div className={`nav-item ${isActive('/stock/expiry-report') ? 'active' : ''}`} onClick={() => navigate('/stock/expiry-report')}>
                      <FiAlertTriangle className="nav-icon" /> <span>Expiry Report</span>
                    </div>
                  )}
                  {hasPageAccess('StockCount') && (
                    <div className={`nav-item ${isActive('/stock/stock-count') ? 'active' : ''}`} onClick={() => navigate('/stock/stock-count')}>
                      <FiClipboard className="nav-icon" /> <span>Stock Count</span>
                    </div>
                  )}
                  {/* Incoming Stock — HQ Purchases waiting for branch confirmation.
                      Universal: every branch has its own queue (filtered server-side
                      by destination_slug). */}
                  {hasPageAccess('Inventory') && (
                    <div className={`nav-item ${isActive('/stock/incoming') ? 'active' : ''}`} onClick={() => navigate('/stock/incoming')}>
                      <FiInbox className="nav-icon" /> <span>Incoming Stock</span>
                      {badges.incoming_stock > 0 && <SidebarBadge n={badges.incoming_stock} />}
                    </div>
                  )}
                  {/* Stock Transfers — Inter-branch (Mansa surplus → Lusaka shortage).
                      Different from HQ Purchases: source stock IS decremented here. */}
                  {hasPageAccess('Inventory') && (
                    <div className={`nav-item ${isActive('/stock/transfers') ? 'active' : ''}`} onClick={() => navigate('/stock/transfers')}>
                      <FiTruck className="nav-icon" /> <span>Inter-Branch Transfers</span>
                      {badges.incoming_transfers > 0 && <SidebarBadge n={badges.incoming_transfers} />}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Accounting Group */}
          {!collapsed && hasPageAccess('CashReceipt', 'PaymentVoucher', 'CashBook', 'AccountPayables', 'AccountReceivables', 'ProfitReport') && (
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
                  {hasPageAccess('AccountPayables') && (
                    <div className={`nav-item ${isActive('/accounting/account-payables') ? 'active' : ''}`} onClick={() => navigate('/accounting/account-payables')}>
                      <FiFileText className="nav-icon" /> <span>{t('accountPayables')}</span>
                    </div>
                  )}
                  {hasPageAccess('AccountReceivables') && (
                    <div className={`nav-item ${isActive('/accounting/account-receivables') ? 'active' : ''}`} onClick={() => navigate('/accounting/account-receivables')}>
                      <FiFileText className="nav-icon" /> <span>Account Receivables</span>
                    </div>
                  )}
                  {isAllAccess() && user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/accounting/credit-notes') ? 'active' : ''}`} onClick={() => navigate('/accounting/credit-notes')}>
                      <FiCreditCard className="nav-icon" /> <span>Credit Notes</span>
                    </div>
                  )}
                  {hasPageAccess('CapitalAccount') && (
                    <div className={`nav-item ${isActive('/accounting/capital-account') ? 'active' : ''}`} onClick={() => navigate('/accounting/capital-account')}>
                      <FiTrendingUp className="nav-icon" /> <span>Capital Account</span>
                    </div>
                  )}
                  {hasPageAccess('DividendAccount') && (
                    <div className={`nav-item ${isActive('/accounting/dividend-account') ? 'active' : ''}`} onClick={() => navigate('/accounting/dividend-account')}>
                      <FiDollarSign className="nav-icon" /> <span>Dividend Account</span>
                    </div>
                  )}
                  {hasPageAccess('Shareholders') && (
                    <div className={`nav-item ${isActive('/accounting/shareholders') ? 'active' : ''}`} onClick={() => navigate('/accounting/shareholders')}>
                      <FiUsers className="nav-icon" /> <span>Shareholders</span>
                    </div>
                  )}
                  {hasPageAccess('LoanAccount') && (
                    <div className={`nav-item ${isActive('/accounting/loans') ? 'active' : ''}`} onClick={() => navigate('/accounting/loans')}>
                      <FiTrendingDown className="nav-icon" /> <span>Loan Account</span>
                    </div>
                  )}
                  {hasPageAccess('ProfitReport') && (
                    <div className={`nav-item ${isActive('/accounting/profit-report') ? 'active' : ''}`} onClick={() => navigate('/accounting/profit-report')}>
                      <FiTrendingUp className="nav-icon" /> <span>Profit Report</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Suppliers & Customers Group */}
          {!collapsed && hasPageAccess('Suppliers', 'Customers') && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/suppliers-customers']) ? 'active' : ''}`} onClick={() => toggleGroup('suppliersCustomers')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiUsers className="nav-icon" />
                  <span>{t('suppliersCustomers')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.suppliersCustomers ? 'open' : ''}`} />
              </div>
              {openGroups.suppliersCustomers && (
                <div className="nav-children">
                  {hasPageAccess('Suppliers') && (
                    <div className={`nav-item ${isActive('/suppliers-customers/suppliers') ? 'active' : ''}`} onClick={() => navigate('/suppliers-customers/suppliers')}>
                      <FiUserPlus className="nav-icon" /> <span>{t('suppliers')}</span>
                    </div>
                  )}
                  {hasPageAccess('Customers') && (
                    <div className={`nav-item ${isActive('/suppliers-customers/customers') ? 'active' : ''}`} onClick={() => navigate('/suppliers-customers/customers')}>
                      <FiUser className="nav-icon" /> <span>{t('customers')}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Approvals — admin-only top-level entry. Red badge shows the
              count of pending discount requests. Polled every 10s in the
              useEffect above. */}
          {!collapsed && user?.role === 'Administrator' && (
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
                  <div className={`nav-item ${isActive('/settings/system') ? 'active' : ''}`} onClick={() => navigate('/settings/system')}>
                    <FiSliders className="nav-icon" /> <span>System Settings</span>
                  </div>
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/settings/users') ? 'active' : ''}`} onClick={() => navigate('/settings/users')}>
                      <FiUsers className="nav-icon" /> <span>{t('users')}</span>
                    </div>
                  )}
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/setup') ? 'active' : ''}`} onClick={() => navigate('/setup')}>
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
              <FiLogOut /> {t('logout')}
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

            <button className="notification-btn hide-on-mobile">
              <FiBell />
              <span className="notification-badge">2</span>
            </button>
            <div className="date-display hide-on-mobile">
              <div style={{ fontWeight: 700 }}>{dateStr}</div>
              <div style={{ fontWeight: 700 }}>{timeStr}</div>
            </div>
          </div>
        </div>

        {/* Page Content - rendered by child routes */}
        <Outlet key={refreshKey} />
      </div>
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
