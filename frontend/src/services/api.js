import axios from 'axios';

const API_BASE_URL = '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' }
});

// HQ mode = the React app is being served from the bare sosnazm.com (or
// localhost in dev) where there's no per-tenant subdomain. The branch
// is chosen by the user via a sidebar dropdown / login picker and
// stored in localStorage as 'hq.branch'. Every API call adds an
// X-Branch header so the backend routes to the right tenant DB
// (see backend/middleware/tenant.js — HQ branch-switch).
export const HQ_HOSTS = new Set(['sosnazm.com', 'www.sosnazm.com', 'localhost', '127.0.0.1']);
// Electron always runs on localhost but its identity is fixed at
// install-time (Setup screen) — it IS a branch, not HQ. Without this
// guard the localhost entry above made the login screen ask "pick a
// branch" + the sidebar surfaced HQ-only entries (HQ Products etc.)
// inside the desktop app. Detect Electron via its UA so dev `npm start`
// in a normal browser still gets HQ treatment.
const isElectronUa = () => {
  try { return /electron/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || ''); }
  catch { return false; }
};
export const isHqHost = () => {
  try {
    if (isElectronUa()) return false;
    return HQ_HOSTS.has(window.location.hostname);
  } catch { return false; }
};
export const HQ_BRANCH_KEY = 'hq.branch';
export const getHqBranch = () => {
  try { return localStorage.getItem(HQ_BRANCH_KEY) || ''; }
  catch { return ''; }
};
export const setHqBranch = (slug) => {
  try {
    if (slug) localStorage.setItem(HQ_BRANCH_KEY, slug);
    else localStorage.removeItem(HQ_BRANCH_KEY);
  } catch { /* ignore */ }
};

// Electron-only: the branch slug this install belongs to. Cached at boot
// from /api/sync/status's vpsUrl. Used by pages that need to render or
// pass the slug client-side (e.g. Inter-Branch Transfers) since
// window.location.hostname is always "localhost" in Electron.
export const BRANCH_SLUG_KEY = 'branch.slug';
export const getBranchSlug = () => {
  try { return localStorage.getItem(BRANCH_SLUG_KEY) || ''; }
  catch { return ''; }
};
export const setBranchSlug = (slug) => {
  try {
    if (slug) localStorage.setItem(BRANCH_SLUG_KEY, slug);
    else localStorage.removeItem(BRANCH_SLUG_KEY);
  } catch { /* ignore */ }
};

// Add token + HQ branch header to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Only attach X-Branch when we're on the bare HQ host; sending it from
  // a real per-branch subdomain would be ignored by the backend, but
  // there's no reason to emit a header we don't need.
  if (isHqHost()) {
    const br = getHqBranch();
    if (br) config.headers['X-Branch'] = br;
  }
  return config;
});

// Auto-logout on 401 (expired/invalid token). Guard: if we're already on /login
// we mustn't hard-reload — that would loop indefinitely if a page-level effect keeps
// firing API calls on each mount.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// Auth
export const login = (data) => api.post('/auth/login', data);
export const register = (data) => api.post('/auth/register', data);
export const registerFirst = (data) => api.post('/auth/register-first', data);
export const verifyAdmin = (data) => api.post('/auth/verify-admin', data);

// Dashboard
export const getDashboard = () => api.get('/dashboard');

// Products
export const getProducts = (params) => api.get('/products', { params });
export const getProduct = (id) => api.get(`/products/${id}`);
export const getQuickItems = () => api.get('/products/quick-items');
// v1.8.34 — Quick Price Update bulk save.
export const bulkUpdatePrices = (updates) => api.post('/products/bulk-update-prices', { updates });
export const addQuickItem = (product_sync_id) => api.post('/products/quick-items', { product_sync_id });
export const removeQuickItem = (productSyncId) => api.delete(`/products/quick-items/${productSyncId}`);
export const createProduct = (data) => api.post('/products', data);
export const updateProduct = (id, data) => api.put(`/products/${id}`, data);
export const updateProductBarcode = (id, data) => api.patch(`/products/${id}/barcode`, data);
export const deleteProduct = (id) => api.delete(`/products/${id}`);
export const deleteAllProducts = () => api.delete('/products/all');
// v1.8.1 — Transfer all store stock to sales floor as a single SIV.
// Password-gated server-side (must equal '108120').
export const bulkSivStoreToSales = (password) => api.post('/products/bulk-siv-store-to-sales', { password });

// v1.8.6 — Currency Exchanges (append-only ledger, scope='drawer'|'book').
export const getCurrencyExchanges = (params = {}) => api.get('/currency-exchanges', { params });
export const getCurrencyExchangesNet = (params = {}) => api.get('/currency-exchanges/net', { params });
export const createCurrencyExchange = (data) => api.post('/currency-exchanges', data);
export const importProducts = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/products/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const uploadProductImage = (id, file) => {
  const form = new FormData();
  form.append('image', file);
  return api.post(`/products/${id}/image`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const deleteProductImage = (id) => api.delete(`/products/${id}/image`);

// Generic invoice attachment (GRN / PV).
// `kind` is appended BEFORE `file` so multer's filename callback can read req.body.kind.
// Setting Content-Type to 'multipart/form-data' (no boundary) is the documented axios pattern —
// axios detects the FormData payload and replaces it with the boundary-augmented header.
export const uploadInvoiceAttachment = (file, kind) => {
  const form = new FormData();
  if (kind) form.append('kind', kind);
  form.append('file', file);
  return api.post('/attachments', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
};
export const deleteInvoiceAttachment = (path) => api.delete('/attachments', { params: { path } });

// Categories
export const getCategories = () => api.get('/categories');
export const createCategory = (data) => api.post('/categories', data);
export const updateCategory = (id, data) => api.put(`/categories/${id}`, data);
export const deleteCategory = (id) => api.delete(`/categories/${id}`);
export const deleteAllCategories = () => api.delete('/categories/all');

// Main Categories (groups categories under e.g. Whisky, Wine, Beer)
export const getMainCategories = () => api.get('/main-categories');
export const createMainCategory = (data) => api.post('/main-categories', data);
export const updateMainCategory = (id, data) => api.put(`/main-categories/${id}`, data);
export const deleteMainCategory = (id) => api.delete(`/main-categories/${id}`);

// Units (kg, pcs, Pack, etc.) — auto-imports existing product units on first load
export const getUnits = () => api.get('/units');
export const createUnit = (data) => api.post('/units', data);
export const updateUnit = (id, data) => api.put(`/units/${id}`, data);
export const deleteUnit = (id) => api.delete(`/units/${id}`);
export const importCategories = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/categories/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
};

// Orders
export const getOrders = () => api.get('/orders');
export const createOrder = (data) => api.post('/orders', data);
export const getOrder = (id) => api.get(`/orders/${id}`);
export const reverseOrder = (id) => api.put(`/orders/${id}/reverse`);
export const getCashierInbox = () => api.get('/orders/cashier-inbox');
// v1.8.86 — read-only history of paid orders for the Cashier History tab.
export const getCashierPaymentHistory = (limit = 50) => api.get('/orders/payment-history', { params: { limit } });
export const collectOrderPayment = (id, data) => api.put(`/orders/${id}/collect-payment`, data);
// v1.8.87 — admin-only post-payment edit (typo/wrong-ccy/wrong-rate fix).
// 7-day window enforced server-side. Response includes cr_exists + cr_date +
// cr_cashier_name so the UI can nudge re-saving the day's Cash Report.
export const editOrderPayment = (id, data) => api.put(`/orders/${id}/edit-payment`, data);
export const getDispatchInbox = () => api.get('/orders/dispatch-inbox');
export const confirmDispatch = (id) => api.put(`/orders/${id}/confirm-dispatch`);

// HQ — public list of registered branches for the login + sidebar picker.
export const getHqBranches = () => api.get('/hq/branches');
// HQ — cross-branch summary (auth required). Backend loops over each
// tenant DB and aggregates today/MTD revenue, queue depths, stock value, AR.
export const getHqOverview = () => api.get('/hq/overview');
// HQ — cross-branch order list with date + branch filters. Defaults to
// today, all branches. Sorted newest first, capped at 1000 rows server-side.
export const getHqSalesReport = (params) => api.get('/hq/sales-report', { params });
// HQ — cross-branch stock list. Filters: branch, low_only, q (name search).
export const getHqInventoryReport = (params) => api.get('/hq/inventory-report', { params });
// HQ — per-branch cash IN/OUT/Net per method (Cash/Bank/MoMo), today + MTD.
export const getHqCashPosition = () => api.get('/hq/cash-position');

// HQ — v1.9.0 Layer 3: manual mirror of all HQ-owned entities (main_categories,
// categories, units, products) to every registered branch. Optional { slug }
// targets a single branch instead of all of them. Returns per-branch counts of
// inserted vs updated rows so the UI can show a results modal.
export const mirrorHqToAllBranches = (slug) =>
  api.post('/hq/mirror-all', slug ? { slug } : {});

// Sync — v1.9.4 trigger an immediate sync cycle on the local Electron backend.
// Used by the POS Change Price flow so the cashier doesn't wait up to 30s for
// the next scheduled push/pull. Harmless on web (returns triggered=false).
export const triggerSyncNow = () =>
  api.post('/sync/run-now').catch(() => null);

// v1.9.7 — Procurement Phase 2: branch can reject an incoming PO line.
// Reason is mandatory and shows on the HQ Purchases list so HQ can re-route
// the line to a different branch or cancel it.
export const branchRejectPoLine = (itemId, reason) =>
  api.put(`/hq/purchases/items/${itemId}/branch-reject`, { reason });

// v1.9.7 — HQ Confirm GRN flow. Lists every branch's GRNs sitting at
// hq_status='PENDING_HQ_CONFIRM'.
export const getAwaitingHqGrns = () => api.get('/hq/grns/awaiting');
// v1.9.14 — HQ-wide archive of CONFIRMED GRNs from master.db snapshot.
// params: { branch, supplier, from, to, limit }
export const getHqGrnArchive   = (params) => api.get('/hq/grns/archive', { params });
// Full GRN doc (header + items) by branch slug + GRN sync_id, for the
// review modal HQ opens before confirming.
export const getHqGrn      = (slug, syncId)         => api.get(`/hq/grns/${slug}/${syncId}`);
// v1.10.3 — Full doc for v1.10.0 HQ-generated GRNs (master.db only).
export const getHqGrnDetail = (syncId)              => api.get(`/hq/grns/hq/${syncId}`);
// Confirm: posts stock at branch location='sales', flips PO lines to
// CONFIRMED, marks GRN hq_status='CONFIRMED'. Optional notes string.
export const confirmHqGrn  = (slug, syncId, notes)  => api.post(`/hq/grns/${slug}/${syncId}/confirm`, { notes: notes || null });
// Reject: branch can re-generate the GRN. Reason is mandatory.
export const rejectHqGrn   = (slug, syncId, reason) => api.post(`/hq/grns/${slug}/${syncId}/reject`, { reason });
// v1.10.115 — Void a HQ-generated GRN. Reverses branch stock, soft-deletes
// the doc on master.db + hq.db, resets PO line to AWAITING_GRN so a new
// correct GRN can be generated. Admin password required (verified via
// verifyAdmin before this call; adminId + adminName passed as attestation).
// WAC intentionally NOT recomputed (user chose Option B on 2026-07-05).
export const voidHqGrn = (syncId, payload) => api.post(`/hq/grns/${syncId}/void`, payload);
// v1.10.118 — Light Edit for HQ GRN. Scope: unit_price per line,
// cost_currency, fx_rate_used. Doesn't touch stock movements (qty/damage
// unchanged) — for stock-affecting fixes, use Void + regenerate instead.
// Payload: { line_updates:{[item_sync_id]:{unit_price}}, cost_currency,
// fx_rate_used, reason, adminId, adminName }.
export const editHqGrn = (syncId, payload) => api.post(`/hq/grns/${syncId}/edit`, payload);

// v1.10.0 — new procurement flow: branch confirms received qty + invoice on
// the PO; HQ then generates the GRN. See backend/routes/branchReceipts.js
// + backend/routes/hqGrns.js (awaiting-generation / receipt / generate).
export const confirmBranchReceipt = (purchaseSyncId, payload) =>
  api.post(`/branch/po-receipts/${purchaseSyncId}/confirm`, payload);
export const getAwaitingGeneration = () => api.get('/hq/grns/awaiting-generation');
export const getHqReceipt          = (syncId) => api.get(`/hq/grns/receipt/${syncId}`);
export const generateHqGrn         = (payload) => api.post('/hq/grns/generate', payload);

// Stock Transfers (Phase C — HQ Warehouse). Stored in master.db so source
// + destination see the same row. Works the same on HQ and on per-branch
// subdomains; the "current branch" the page operates against is derived
// from either the HQ X-Branch header (if set) or the host's subdomain.
export const getTransferSourceProducts = (slug) => api.get('/transfers/source-products', { params: { slug } });
export const getOutgoingTransfers = (params) => api.get('/transfers/outgoing', { params });
export const getIncomingTransfers = (params) => api.get('/transfers/incoming', { params });
export const createTransfer = (data) => api.post('/transfers', data);
export const receiveTransfer = (id, data) => api.put(`/transfers/${id}/receive`, data || {});

// v1.8.65 — HQ Transit Variances (cross-source: Inter-Branch Transfers + HQ Purchases).
export const getHqVariances = (params) => api.get('/hq/variances', { params });
export const resolveTransferVariance = (syncId, data) => api.put(`/hq/variances/transfer/${syncId}/resolve`, data || {});
export const cancelTransfer = (id) => api.put(`/transfers/${id}/cancel`);

// v1.8.57 — Branch → HQ Cash Deposit workflow.
// Branch creates a PENDING deposit, HQ confirms (writes PV on branch + CR
// on HQ) or rejects (no ledger writes). Lives in master.db.
export const getCashDeposits   = (params) => api.get('/cash-deposits', { params });
export const createCashDeposit = (data)   => api.post('/cash-deposits', data);
export const confirmCashDeposit = (id, body) => api.put(`/cash-deposits/${id}/confirm`, body || {});
export const rejectCashDeposit  = (id, reason) => api.put(`/cash-deposits/${id}/reject`, { reason });
// v1.10.143 — soft delete requires reason + admin attestation.
export const deleteCashDeposit  = (id, data) => api.delete(`/cash-deposits/${id}`, { data });
export const editCashDepositDate = (id, deposit_date) => api.put(`/cash-deposits/${id}/date`, { deposit_date });
// v1.10.168 — full CONFIRMED-only edit (amount / from_method / notes / date).
// Requires reason + admin attestation (adminId/adminName from verify-admin).
export const editCashDeposit = (id, data) => api.put(`/cash-deposits/${id}/edit`, data);

// HQ Purchases — Phase C v2: supplier purchases logged at HQ with
// per-line destination branch. HQ has no warehouse / no source stock.
// Branch confirms with actual received qty; stock arrives in branch DB
// only on receive (auto-creates product if missing by sync_id or name).
export const getHqPurchases = (params) => api.get('/hq/purchases', { params });
export const getHqPurchase = (id) => api.get(`/hq/purchases/${id}`);
export const createHqPurchase = (data) => api.post('/hq/purchases', data);
export const getHqPurchaseIncoming = (slug) => api.get('/hq/purchases/incoming', { params: { slug } });
// v1.3.0 split: branch SUBMITS a GRN (status → GRN_SUBMITTED, no stock yet);
// HQ then CONFIRMS (stock + AP land) or REJECTS (back to AWAITING_GRN).
export const submitHqPurchaseGrn   = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/submit-grn`, data);
export const confirmHqPurchaseItem = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/confirm`, data);
export const rejectHqPurchaseItem  = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/reject`, data);
export const getHqGrnAwaitingConfirmation = () => api.get('/hq/purchases/awaiting-confirmation');
// Legacy alias — older builds still call this; routes to submit-grn now.
export const receiveHqPurchaseItem = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/submit-grn`, data);
export const cancelHqPurchaseItem  = (itemId) => api.put(`/hq/purchases/items/${itemId}/cancel`);
export const cancelHqPurchase      = (id) => api.put(`/hq/purchases/${id}/cancel`);

// Sidebar badge counts — one cheap call covers cashier / dispatch /
// incoming stock / incoming transfers for the current branch.
export const getNotificationBadges = (slug) => api.get('/notifications/badges', { params: { slug } });

// HQ Suppliers + AP — supplier master with live AP balance computed
// from purchases - payments (never stored).
export const getHqSuppliers = () => api.get('/hq/suppliers');
export const getHqSupplier  = (id) => api.get(`/hq/suppliers/${id}`);
export const createHqSupplier = (data) => api.post('/hq/suppliers', data);
export const updateHqSupplier = (id, data) => api.put(`/hq/suppliers/${id}`, data);
export const deleteHqSupplier = (id) => api.delete(`/hq/suppliers/${id}`);
export const recordHqSupplierPayment = (supplierId, data) => api.post(`/hq/suppliers/${supplierId}/payments`, data);
export const deleteHqSupplierPayment = (paymentId) => api.delete(`/hq/suppliers/payments/${paymentId}`);

// HQ Damages — v1.3.1 cross-branch queue of branch-declared damages
// waiting for HQ to confirm before sales-floor stock is decremented.
// v1.10.149 — status='pending'|'confirmed'|'rejected'|'all' so the HQ page
// can browse past decisions instead of only the pending queue.
export const getHqDamagesAwaiting = (status) => api.get('/hq/damages/awaiting', { params: status ? { status } : undefined });
export const confirmHqDamage = (slug, id, data) => api.put(`/hq/damages/${slug}/${id}/confirm`, data || {});
export const rejectHqDamage  = (slug, id, data) => api.put(`/hq/damages/${slug}/${id}/reject`,  data || {});

// HQ Products — central catalogue. HQ creates → auto-pushed to every
// branch (matched by sync_id). Branches keep their own selling price;
// pass override_prices=true on PUT to force-push HQ defaults onto
// branches that already had the product.
export const getHqProducts = (params) => api.get('/hq/products', { params });
export const getHqProduct  = (id) => api.get(`/hq/products/${id}`);
export const createHqProduct = (data) => api.post('/hq/products', data);
// v1.5.0: override_prices param dropped — HQ never touches branch prices.
// Every save pushes HQ-owned columns only.
export const updateHqProduct = (id, data) => api.put(`/hq/products/${id}`, data);
export const deleteHqProduct = (id) => api.delete(`/hq/products/${id}`);
export const pushHqProduct   = (id) => api.post(`/hq/products/${id}/push`);
export const reverseOrderItem = (orderId, itemId, quantity, unit) => {
  const body = {};
  if (quantity != null) body.quantity = quantity;
  if (unit) body.unit = unit;
  return api.put(`/orders/${orderId}/items/${itemId}/reverse`, body);
};

// ── Stock Reconciliation ────────────────────────────────────────────────────
export const getReconciliationProducts = (location, countDate) => {
  const params = new URLSearchParams({ location });
  if (countDate) params.set('count_date', countDate);
  return api.get(`/stock-reconciliation/products?${params.toString()}`);
};
export const getReconciliations = (location) => api.get(`/stock-reconciliation${location ? `?location=${location}` : ''}`);
export const getReconciliation = (id) => api.get(`/stock-reconciliation/${id}`);
export const createReconciliation = (data) => api.post('/stock-reconciliation', data);
export const deleteReconciliation = (id) => api.delete(`/stock-reconciliation/${id}`);
export const getOrderProductSummary = (from, to, userId) => api.get('/orders/product-summary', { params: { from, to, userId } });
export const getProductBreakdown = (productName, from, to, userId) => api.get('/orders/product-breakdown', { params: { productName, from, to, userId } });

// GRN
export const getGRNs = () => api.get('/grn');
export const getGRNStats = () => api.get('/grn/stats');
export const getGRNNotes = () => api.get('/grn/notes');
export const getGRNRecentProducts = () => api.get('/grn/recent-products');
export const createGRN = (data) => api.post('/grn', data);
export const getGRN = (id) => api.get(`/grn/${id}`);
export const getGRNProductReport = (params) => api.get('/grn/product-report', { params });
export const getGRNProductBreakdown = (params) => api.get('/grn/product-breakdown', { params });
export const updateGRN = (id, data) => api.put(`/grn/${id}`, data);
export const deleteGRN = (id) => api.delete(`/grn/${id}`);

// Empty Returns — sending crates/bottles back to supplier for a deposit credit.
export const getEmptyReturns      = () => api.get('/empty-returns');
export const getEmptyReturnStats  = () => api.get('/empty-returns/stats');
export const getEmptyReturn       = (id) => api.get(`/empty-returns/${id}`);
export const createEmptyReturn    = (data) => api.post('/empty-returns', data);
export const updateEmptyReturn    = (id, data) => api.put(`/empty-returns/${id}`, data);
export const deleteEmptyReturn    = (id) => api.delete(`/empty-returns/${id}`);

// Supplier Credit Notes — Discount / Crate Return / Bottle Return / Other.
// Reduce AP balance; Discount + Other feed Profit Report as Supplier Rebates.
export const getCreditNotes      = (params) => api.get('/credit-notes', { params });
export const getCreditNoteStats  = () => api.get('/credit-notes/stats');
export const getCreditNote       = (id) => api.get(`/credit-notes/${id}`);
export const createCreditNote    = (data) => api.post('/credit-notes', data);
export const updateCreditNote    = (id, data) => api.put(`/credit-notes/${id}`, data);
export const deleteCreditNote    = (id) => api.delete(`/credit-notes/${id}`);

// Capital Account — owner equity ledger (Injection/Drawing)
export const getCapitalEntries   = (params) => api.get('/capital-account', { params });
export const getCapitalStats     = () => api.get('/capital-account/stats');
export const getCapitalEntry     = (id) => api.get(`/capital-account/${id}`);
export const createCapitalEntry  = (data) => api.post('/capital-account', data);
export const updateCapitalEntry  = (id, data) => api.put(`/capital-account/${id}`, data);
export const deleteCapitalEntry  = (id) => api.delete(`/capital-account/${id}`);

// Dividend Account — profit distribution to owner(s)
export const getDividendEntries  = (params) => api.get('/dividend-account', { params });
export const getDividendStats    = () => api.get('/dividend-account/stats');
export const getDividendEntry    = (id) => api.get(`/dividend-account/${id}`);
export const createDividendEntry = (data) => api.post('/dividend-account', data);
export const updateDividendEntry = (id, data) => api.put(`/dividend-account/${id}`, data);
export const deleteDividendEntry = (id) => api.delete(`/dividend-account/${id}`);

// Discount approval requests — cashier creates pending row, admin approves/rejects.
export const createDiscountRequest          = (data) => api.post('/discount-requests', data);
export const getDiscountRequest             = (syncId) => api.get(`/discount-requests/${syncId}`);
export const cancelDiscountRequest          = (syncId) => api.delete(`/discount-requests/${syncId}`);
export const getDiscountRequests            = (params) => api.get('/discount-requests', { params });
export const getDiscountRequestsPendingCount = () => api.get('/discount-requests/pending-count');
export const approveDiscountRequest         = (syncId) => api.put(`/discount-requests/${syncId}/approve`);
export const rejectDiscountRequest          = (syncId, reason) => api.put(`/discount-requests/${syncId}/reject`, { reason });

// Shareholders — master list of equity holders
export const getShareholders        = () => api.get('/shareholders');
export const getShareholderStats    = () => api.get('/shareholders/stats');
export const getShareholder         = (id) => api.get(`/shareholders/${id}`);
export const createShareholder      = (data) => api.post('/shareholders', data);
export const updateShareholder      = (id, data) => api.put(`/shareholders/${id}`, data);
export const deleteShareholder      = (id) => api.delete(`/shareholders/${id}`);

// Loans — liability sub-ledger (loans + per-loan transactions)
export const getLoans               = (params) => api.get('/loans', { params });
export const getLoanStats           = () => api.get('/loans/stats');
export const getLoan                = (id) => api.get(`/loans/${id}`);
export const createLoan             = (data) => api.post('/loans', data);
export const updateLoan             = (id, data) => api.put(`/loans/${id}`, data);
export const deleteLoan             = (id) => api.delete(`/loans/${id}`);
export const createLoanTransaction  = (loanId, data) => api.post(`/loans/${loanId}/transactions`, data);
export const updateLoanTransaction  = (loanId, txId, data) => api.put(`/loans/${loanId}/transactions/${txId}`, data);
export const deleteLoanTransaction  = (loanId, txId) => api.delete(`/loans/${loanId}/transactions/${txId}`);

// Inventory (two-location)
export const getInventory = () => api.get('/inventory');
export const getStoreInventory = (params) => api.get('/inventory/store', { params });
// Same shape as getStoreInventory, just filtered on the sales-counter side
// of the stock ledger — powers the Sales Stock Card page.
export const getSalesStockCard = (params) => api.get('/inventory/store', { params: { ...(params || {}), location: 'sales' } });
export const getSalesInventory = (params) => api.get('/inventory/sales', { params });
export const getSalesMonthlySummary = (month) => api.get('/inventory/sales/monthly-summary', { params: { month } });
export const getSalesProfitSummary = (date) => api.get('/inventory/sales/profit-summary', { params: { date } });
export const getSalesRangeSummary = (from, to) => api.get('/inventory/sales/range-summary', { params: { from, to } });
export const getSalesDailySummary = (date) => api.get('/inventory/sales/daily-summary', { params: { date } });
export const getSIVBreakdown = (date, product_id) => api.get('/inventory/sales/siv-breakdown', { params: { date, product_id } });
export const saveSalesActualBalance = (data) => api.post('/inventory/sales/actual', data);
export const getInventoryStats = () => api.get('/inventory/stats');
export const getBinCard = (params) => api.get('/inventory/bin-card', { params });
export const getSalesBinCard = (params) => api.get('/inventory/sales-bin-card', { params });

// SIV
export const getSIVs = () => api.get('/siv');
export const getSIVStats = () => api.get('/siv/stats');
export const getSIVNotes = () => api.get('/siv/notes');
export const getSIVRecentProducts = () => api.get('/siv/recent-products');
export const getSIVItemsSummary = (from, to) => api.get('/siv/items-summary', { params: { from, to } });
export const createSIV = (data) => api.post('/siv', data);
export const getSIV = (id) => api.get(`/siv/${id}`);
export const updateSIV = (id, data) => api.put(`/siv/${id}`, data);
export const deleteSIV = (id) => api.delete(`/siv/${id}`);
export const getSIVItemBreakdown = (product_id, from, to) => api.get('/siv/item-breakdown', { params: { product_id, from, to } });

// Cash Receipts
export const getCashReceipts = () => api.get('/cash-receipts');
export const getCashReceiptStats = () => api.get('/cash-receipts/stats');
export const checkSalesCashReceipt = (date, received_from) => api.get('/cash-receipts/check-sales', { params: { date, received_from } });
export const createCashReceipt = (data) => api.post('/cash-receipts', data);
export const updateCashReceipt = (id, data) => api.put(`/cash-receipts/${id}`, data);
export const deleteCashReceipt = (id) => api.delete(`/cash-receipts/${id}`);

// v1.10.43 — fromUtc / toUtc: SQLite-format UTC datetime bounds
// corresponding to the LOCAL day. Same shape /cash-reports/daily accepts.
// When both are provided the backend uses them and ignores date/from/to.
export const getSalesCashiers = (date, from, to, fromUtc, toUtc) => {
  const params = {};
  if (date)    params.date     = date;
  if (from)    params.from     = from;
  if (to)      params.to       = to;
  if (fromUtc) params.from_utc = fromUtc;
  if (toUtc)   params.to_utc   = toUtc;
  return api.get('/cash-reports/sales-cashiers', { params });
};
// v1.10.9 — admin-gated delete of a saved cash report row.
export const deleteCashReport = (id) => api.delete(`/cash-reports/${id}`);

// Payment Vouchers
export const getPaymentVouchers = (params) => api.get('/payment-vouchers', { params });
export const getPaymentVoucherStats = () => api.get('/payment-vouchers/stats');
export const createPaymentVoucher = (data) => api.post('/payment-vouchers', data);
export const updatePaymentVoucher = (id, data) => api.put(`/payment-vouchers/${id}`, data);
export const deletePaymentVoucher = (id) => api.delete(`/payment-vouchers/${id}`);

// PV Types
export const getPvTypes = () => api.get('/pv-types');
export const createPvType = (data) => api.post('/pv-types', data);
export const updatePvType = (id, data) => api.put(`/pv-types/${id}`, data);
export const deletePvType = (id) => api.delete(`/pv-types/${id}`);

// Cash Book
export const getCashBook = (params) => api.get('/cash-book', { params });
export const getCashBookStats = (params) => api.get('/cash-book/stats', { params });
// Accepts either a single number (legacy: sets Cash opening) OR an object { cash, bank, momo }.
export const setOpeningBalance = (data) =>
  api.post('/cash-book/opening-balance', typeof data === 'object' ? data : { amount: data });
// Cash transfers — moves money between methods (Cash <-> Bank <-> Mobile Money)
export const getCashTransfers = () => api.get('/cash-book/transfers');
export const createCashTransfer = (data) => api.post('/cash-book/transfers', data);
export const deleteCashTransfer = (id) => api.delete(`/cash-book/transfers/${id}`);

// Account Payables
export const getAccountPayables = (params) => api.get('/account-payables', { params });
export const getSupplierBreakdown = (supplierId) => api.get(`/account-payables/breakdown/${supplierId}`);
export const createApPayment = (data) => api.post('/ap-payments', data);
export const getApPayments = (params) => api.get('/ap-payments', { params });
export const updateApPayment = (id, data) => api.put(`/ap-payments/${id}`, data);
export const deleteApPayment = (id) => api.delete(`/ap-payments/${id}`);
export const getAccountPayableStats = (params) => api.get('/account-payables/stats', { params });
export const createAccountPayable = (data) => api.post('/account-payables', data);
export const payInvoice = (id, data) => api.put(`/account-payables/${id}/pay`, data);

// Suppliers
export const getSuppliers = () => api.get('/suppliers');
export const getSupplierStats = () => api.get('/suppliers/stats');
export const createSupplier = (data) => api.post('/suppliers', data);
export const updateSupplier = (id, data) => api.put(`/suppliers/${id}`, data);
export const deleteSupplier = (id) => api.delete(`/suppliers/${id}`);

// Customers
export const getCustomers = (params) => api.get('/customers', { params });
export const getCustomerStats = () => api.get('/customers/stats');
export const createCustomer = (data) => api.post('/customers', data);
export const updateCustomer = (id, data) => api.put(`/customers/${id}`, data);
export const deleteCustomer = (id, { cascadePayments = false } = {}) =>
  api.delete(`/customers/${id}${cascadePayments ? '?cascade=payments' : ''}`);
export const getCustomerStatement = (id) => api.get(`/customers/${id}/statement`);
export const getCustomerAging = () => api.get('/customers/aging');
export const getArStats = (params) => api.get('/customers/ar-stats', { params });
export const getCustomerInsights = (id) => api.get(`/customers/${id}/insights`);
export const getOrphanOrders = (id) => api.get(`/customers/${id}/orphan-orders`);
export const claimOrphanOrders = (id) => api.post(`/customers/${id}/claim-orphan-orders`);

// Customer Payments
export const getCustomerPayments = (params) => api.get('/customer-payments', { params });
export const createCustomerPayment = (data) => api.post('/customer-payments', data);
export const updateCustomerPayment = (id, data) => api.put(`/customer-payments/${id}`, data);
export const deleteCustomerPayment = (id) => api.delete(`/customer-payments/${id}`);

// FX Rates (Accounting → Currency Rates) — dual-currency branches only
export const getFxRates = () => api.get('/fx-rates');
export const getCurrentFxRate = () => api.get('/fx-rates/current');
export const createFxRate = (data) => api.post('/fx-rates', data);
export const deleteFxRate = (id) => api.delete(`/fx-rates/${id}`);
export const getLiveFxRate = () => api.get('/fx-rates/live');
export const getLiveFxRateHistory = (days = 7) => api.get('/fx-rates/live-history', { params: { days } });

// Users
export const getUsers = () => api.get('/users');
export const getUserStats = () => api.get('/users/stats');
export const createUser = (data) => api.post('/users', data);
export const updateUser = (id, data) => api.put(`/users/${id}`, data);
export const deleteUser = (id) => api.delete(`/users/${id}`);

// Settings
export const getSettings = () => api.get('/settings');
export const updateProfile = (data) => api.put('/settings/profile', data);
export const updateBusiness = (data) => api.put('/settings/business', data);
export const getDrawerPort = () => api.get('/settings/drawer-port');
export const updateDrawerPort = (port) => api.put('/settings/drawer-port', { port });
export const openCashDrawer = () => api.post('/settings/open-drawer');
export const printReceipt = (data) => api.post('/settings/print-receipt', data);
export const printReport = (data) => api.post('/settings/print-report', data);
export const printCountWorksheet = (data) => api.post('/settings/print-count-worksheet', data);

// Production
export const getProductions = () => api.get('/production');
export const getProductionStats = () => api.get('/production/stats');
export const getProduction = (id) => api.get(`/production/${id}`);
export const createProduction = (data) => api.post('/production', data);
export const updateProduction = (id, data) => api.put(`/production/${id}`, data);
export const deleteProduction = (id) => api.delete(`/production/${id}`);
export const getProductionRecentInputs = () => api.get('/production/recent-inputs');
export const getProductionRecentOutputs = () => api.get('/production/recent-outputs');

// Sales Returns
export const getSalesReturns = () => api.get('/sales-returns');
export const getSalesReturnStats = () => api.get('/sales-returns/stats');
export const getSalesReturnNotes = () => api.get('/sales-returns/notes');
export const getSalesReturn = (id) => api.get(`/sales-returns/${id}`);
export const createSalesReturn = (data) => api.post('/sales-returns', data);
export const updateSalesReturn = (id, data) => api.put(`/sales-returns/${id}`, data);
export const deleteSalesReturn = (id) => api.delete(`/sales-returns/${id}`);

// LAN Sync (Mother / Child architecture)
export const getLanConfig = () => api.get('/sync/lan-config');
// v1.8.42 — recovery helper. Marks every synced=0 row as synced=1 so the
// PROTECT-on-pull rule stops blocking remote overwrites. Use when local
// has drifted from VPS and you want VPS as truth.
export const clearPendingSyncFlags = () => api.post('/sync/clear-pending');
export const updateLanConfig = (data) => api.put('/sync/lan-config', data);
export const getLanStatus = () => api.get('/sync/lan-status');

export default api;
