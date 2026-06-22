const { getTenantDb } = require('../config/tenantDb');
const { runWithDb } = require('../config/database');
const { isRegistered } = require('../config/masterDb');

// Subdomains that bypass per-tenant DB routing. The bare domain hits here as
// 'sosnazm' (the first dot-split of 'sosnazm.com'); this is the HQ /
// management layer — admin panel + tenant-admin routes live here, not a
// real per-branch tenant DB. Same role as 'liquor' in Liquor's middleware.
// Without this entry, /api/tenant-admin/* returns 404 to any caller hitting
// the bare domain (which is how central admin reaches Sosna).
//
// HQ branch-switch override: when host is bare 'sosnazm' AND the caller
// sends an 'X-Branch' header naming a registered tenant, we open THAT
// branch's DB instead. Bypass-list entries like 'www' / 'localhost' /
// 'api' do NOT honour X-Branch — only the bare brand domain does, so a
// child subdomain (lusaka1.sosnazm.com) can never spoof its way into
// another branch's data.
const SKIP_SLUGS = new Set(['www', 'sosna', 'sosnazm', 'localhost', 'api', '127', 'sidanitsolutions']);
const HQ_SLUGS   = new Set(['sosnazm']);

module.exports = function tenantMiddleware(req, res, next) {
  // Nginx sets X-Tenant to the full hostname e.g. "wiskings.sidanitsolutions.com"
  const host = (req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  const slug = host.split('.')[0];

  // HQ branch-switch path: bare sosnazm.com + X-Branch header → use that
  // branch's DB and stash the branch's tenant_id on req so the auth
  // middleware can override req.user.tenantId. Without an X-Branch header
  // we fall through to the default DB (so /api/tenant-admin/* + the public
  // HQ branches-list endpoint keep working).
  if (HQ_SLUGS.has(slug)) {
    const xBranch = (req.headers['x-branch'] || '').toString().trim().toLowerCase();
    if (xBranch) {
      if (!isRegistered(xBranch)) {
        return res.status(404).json({ error: `HQ branch "${xBranch}" not found` });
      }
      try {
        const branchDb = getTenantDb(xBranch);
        // Look up the tenant_id stored in this branch's sync_config so the
        // auth middleware can override req.user.tenantId (the JWT was issued
        // from one branch but the user is now operating on another).
        try {
          const row = branchDb.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get();
          if (row?.value) req.hqBranchTenantId = row.value;
        } catch (_) { /* fresh DB — no row yet */ }
        req.hqBranchSlug = xBranch;
        // Stash on req so handlers can re-enter the runWithDb context after
        // async middleware (multer, etc.) that drops the AsyncLocalStorage.
        req.tenantDb = branchDb;
        return runWithDb(branchDb, () => next());
      } catch (err) {
        console.error(`[tenant] HQ branch-switch open failed for "${xBranch}":`, err.message);
        return res.status(503).json({ error: 'Branch database unavailable' });
      }
    }
    return next(); // bare HQ with no X-Branch → default DB
  }

  if (!slug || SKIP_SLUGS.has(slug)) {
    return next(); // use default DB
  }

  // Block unregistered tenants
  if (!isRegistered(slug)) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  try {
    const tenantDb = getTenantDb(slug);
    // Stash on req so handlers can re-enter the runWithDb context after
    // async middleware (multer file uploads, etc.) that drops the
    // AsyncLocalStorage. Without this stash, multer-using POST routes
    // (CSV import, image upload, attachments) silently wrote to the
    // default DB instead of the tenant's — confirmed via diagnostic on
    // 2026-06-22: 242 products had landed in backend/sosna.db while
    // tenants/kassumbalesa1.db had 0.
    req.tenantDb = tenantDb;
    runWithDb(tenantDb, () => next());
  } catch (err) {
    console.error(`[tenant] Failed to open DB for "${slug}":`, err.message);
    res.status(503).json({ error: 'Tenant database unavailable' });
  }
};
