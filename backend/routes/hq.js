/**
 * hq.js — HQ (head-office) endpoints served at the bare sosnazm.com domain.
 *
 * Phase B v1 surfaces:
 *   GET /api/hq/branches  — public list of registered tenant slugs so the
 *                           HQ login page can render a branch picker. No
 *                           auth required; the response is just slugs +
 *                           display names, no secrets.
 *
 * Future endpoints (Phase D — consolidated reports) will live here too and
 * use the same X-Branch header pattern to read across all tenant DBs.
 *
 * Why a dedicated router instead of extending tenantAdmin: tenantAdmin is
 * gated by the central ADMIN_PASSWORD (used by sidanitsolutions.com to
 * manage tenants), which would prevent the public HQ login screen from
 * fetching the branches list. HQ endpoints have their own auth model.
 */
const express = require('express');
const router  = express.Router();
const { listTenants } = require('../config/masterDb');

// GET /api/hq/branches — list registered tenants for the HQ login picker.
// Returns at most slug + business_name. Anything that would help an
// attacker target a specific branch (status counts, license expiry, etc.)
// stays out — that's tenantAdmin territory.
router.get('/branches', (req, res) => {
  try {
    const rows = listTenants();
    res.json({
      branches: rows.map(r => ({
        slug: r.slug,
        name: r.business_name || r.slug,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
