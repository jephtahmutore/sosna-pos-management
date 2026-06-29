/**
 * server-tenant.js — Multi-tenant web server (port 5300)
 *
 * Handles requests for *.sosnazm.com.
 * Reads the subdomain from the X-Tenant header (set by Nginx),
 * opens the correct tenant DB, and routes all API calls into it.
 *
 * No sync service — desktop devices sync via the main server (port 5300).
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ─── Uploads dir (tenant uploads live inside TENANTS_DIR/<slug>/uploads) ─────
// Resolved per-request in routes via req.uploadsDir (set by tenant middleware).
// For the tenant server, a shared base dir is used; subfolders are per-tenant.
const uploadsBase = process.env.TENANTS_DIR
  || path.join(__dirname, '..', 'tenants');

const fs = require('fs');
if (!fs.existsSync(uploadsBase)) fs.mkdirSync(uploadsBase, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ─── Tenant middleware — MUST come before all routes ─────────────────────────
app.use(require('./middleware/tenant'));

// ─── Static file serving for uploaded images ─────────────────────────────────
// Each tenant's uploads live at TENANTS_DIR/<slug>/uploads/
// The URL pattern is /uploads/<filename> — served from the correct tenant folder
app.use('/uploads', (req, res, next) => {
  const host = (req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  const slug = host.split('.')[0];
  const tenantUploads = path.join(uploadsBase, slug, 'uploads');
  express.static(tenantUploads)(req, res, next);
});

// ─── API Routes (identical to main server) ───────────────────────────────────
app.use('/api/auth',             require('./routes/auth'));
app.use('/api/products',         require('./routes/products'));
app.use('/api/categories',       require('./routes/categories'));
app.use('/api/main-categories',  require('./routes/mainCategories'));
app.use('/api/units',            require('./routes/units'));
app.use('/api/orders',           require('./routes/orders'));
app.use('/api/grn',              require('./routes/grn'));
app.use('/api/empty-returns',    require('./routes/emptyReturns'));
app.use('/api/credit-notes',     require('./routes/supplierCreditNotes'));
app.use('/api/capital-account',  require('./routes/capitalAccount'));
app.use('/api/dividend-account', require('./routes/dividendAccount'));
app.use('/api/shareholders',     require('./routes/shareholders'));
app.use('/api/loans',            require('./routes/loans'));
app.use('/api/siv',              require('./routes/siv'));
app.use('/api/cash-receipts',    require('./routes/cashReceipts'));
app.use('/api/payment-vouchers', require('./routes/paymentVouchers'));
app.use('/api/pv-types',         require('./routes/pvTypes'));
app.use('/api/cash-book',        require('./routes/cashBook'));
app.use('/api/account-payables', require('./routes/accountPayables'));
app.use('/api/suppliers',        require('./routes/suppliers'));
app.use('/api/customers',        require('./routes/customers'));
app.use('/api/users',            require('./routes/users'));
app.use('/api/dashboard',        require('./routes/dashboard'));
app.use('/api/settings',         require('./routes/settings'));
app.use('/api/inventory',        require('./routes/inventory'));
app.use('/api/cash-reports',     require('./routes/cashReport'));
app.use('/api/currency-exchanges', require('./routes/currencyExchanges'));
app.use('/api/stock-adjustments',require('./routes/stockAdjustments'));
app.use('/api/stock-count',      require('./routes/stockCount'));
app.use('/api/stock-reconciliation', require('./routes/stockReconciliation'));
app.use('/api/customer-payments', require('./routes/customerPayments'));
// Production module removed for Sosna system.
// app.use('/api/production',       require('./routes/production'));
app.use('/api/sales-returns',    require('./routes/salesReturns'));
app.use('/api/ap-payments',      require('./routes/apPayments'));
app.use('/api/attachments',      require('./routes/attachments'));
app.use('/api/discount-requests',require('./routes/discountRequests'));
app.use('/api/sync',             require('./routes/sync'));
app.use('/api/updates',          require('./routes/updates'));
app.use('/api/fx-rates',         require('./routes/fxRates'));
app.use('/api/tenant-admin',     require('./routes/tenantAdmin'));
app.use('/api/hq',               require('./routes/hq'));
app.use('/api/hq/purchases',     require('./routes/hqPurchases'));
app.use('/api/hq/suppliers',     require('./routes/hqSuppliers'));
app.use('/api/hq/damages',       require('./routes/hqDamages'));
app.use('/api/hq/products',      require('./routes/hqProducts'));
app.use('/api/hq/grns',          require('./routes/hqGrns'));
app.use('/api/transfers',        require('./routes/transfers'));
app.use('/api/cash-deposits',    require('./routes/cashDeposits'));
app.use('/api/notifications',    require('./routes/notifications'));
app.use('/admin',                require('./routes/admin'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', mode: 'tenant', timestamp: new Date().toISOString() });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.TENANT_PORT || 5300;
app.listen(PORT, () => {
  console.log(`Sosna tenant server running on port ${PORT}`);

  // ─── v1.9.0 — Layer 1: boot-time HQ→Branch mirror sweep ───────────────
  // Fires once on server start so any drift accumulated while the server
  // was down (HQ added products, a branch DB got reset, etc.) heals
  // before the first request lands. Async — we don't block listen() on
  // it; if the sweep crashes the rest of the server keeps running.
  setImmediate(() => {
    try {
      const { defaultDb } = require('./config/database');
      const { listTenants } = require('./config/masterDb');
      const { getTenantDb } = require('./config/tenantDb');
      const { mirrorAllHqToBranches } = require('./middleware/hqPush');
      const t0 = Date.now();
      const r = mirrorAllHqToBranches(defaultDb, { listTenants, getTenantDb });
      const totals = Object.values(r.per_branch || {}).reduce((a, b) => {
        a.pushed  += (b.products.pushed  + b.categories.pushed  + b.units.pushed  + b.main_categories.pushed);
        a.updated += (b.products.updated + b.categories.updated + b.units.updated + b.main_categories.updated);
        return a;
      }, { pushed: 0, updated: 0 });
      console.log(`[hq-mirror] Boot sweep done in ${Date.now() - t0}ms — ${r.branch_count} branch(es), ${totals.pushed} inserted, ${totals.updated} updated`);
    } catch (e) {
      console.error('[hq-mirror] Boot sweep failed:', e.message);
    }
  });
});
