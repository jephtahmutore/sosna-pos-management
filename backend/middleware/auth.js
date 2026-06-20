const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'sosna-pro-secret-key-2026');
    req.user = decoded;
    // HQ branch-switch override: the JWT was issued from whichever branch
    // the user originally logged into, but the request may target a
    // DIFFERENT branch via X-Branch. tenant middleware already opened
    // the right DB; here we swap the tenantId on req.user so every WHERE
    // clause downstream (WHERE tenant_id = ?) filters by the operating
    // branch, not the original one. Roles/permissions still come from
    // the JWT — caller is responsible for keeping the same admin user
    // configured across branches if cross-branch operation is desired.
    if (req.hqBranchTenantId) {
      req.user = { ...decoded, tenantId: req.hqBranchTenantId };
    }
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'Administrator') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

const readOnlyGuard = (req, res, next) => {
  if (req.user?.webAccess && req.method !== 'GET') {
    return res.status(403).json({ error: 'Web access is read-only.' });
  }
  next();
};

module.exports = { auth, adminOnly, readOnlyGuard };
