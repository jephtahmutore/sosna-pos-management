/**
 * masterDb.js
 * Manages the master database that tracks all registered tenants.
 * Lives at MASTER_DB_PATH (default: /var/www/sosna-pos-tenant/master.db)
 */
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const masterDbPath = process.env.MASTER_DB_PATH
  || path.join(__dirname, '..', '..', 'master.db');

let masterDb = null;
try {
  const dir = path.dirname(masterDbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  masterDb = new Database(masterDbPath);
  masterDb.pragma('journal_mode = WAL');
  masterDb.pragma('foreign_keys = ON');

  // ── Schema ──────────────────────────────────────────────────────────────────
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT UNIQUE NOT NULL,
      business_name TEXT NOT NULL,
      email         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT UNIQUE NOT NULL,
      max_branches  INTEGER NOT NULL DEFAULT 1,
      expires_at    TEXT NOT NULL,
      notes         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      tenant_email  TEXT,
      tenant_id     TEXT,
      activated_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS branches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      branch_id   TEXT NOT NULL UNIQUE,
      branch_name TEXT NOT NULL,
      slug        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Phase C: cross-branch stock transfers ───────────────────────────
    -- Lives in master.db (not in per-branch DBs) so source and destination
    -- both read/write the same row without cross-DB queries. The items
    -- payload is a JSON array on the row itself:
    --   [{ product_sync_id, product_name, unit, quantity, cost_price }, ...]
    -- status state machine:
    --   PENDING   — source created + decremented its stock; in transit
    --   RECEIVED  — destination confirmed + incremented its stock
    --   CANCELLED — source aborted before destination received
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT NOT NULL UNIQUE,
      sync_id         TEXT NOT NULL UNIQUE,
      from_slug       TEXT NOT NULL,
      from_name       TEXT,
      to_slug         TEXT NOT NULL,
      to_name         TEXT,
      items_json      TEXT NOT NULL,
      total_items     INTEGER NOT NULL DEFAULT 0,
      total_value     REAL NOT NULL DEFAULT 0,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'PENDING',
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      received_by     INTEGER,
      received_by_name TEXT,
      received_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_to_status   ON stock_transfers (to_slug, status);
    CREATE INDEX IF NOT EXISTS idx_transfers_from_status ON stock_transfers (from_slug, status);

    -- ── v1.8.57 — Branch → HQ Cash Deposits ─────────────────────────────
    -- Branch records a physical cash deposit being sent to HQ. HQ
    -- inbox sees PENDING rows and confirms when the cash arrives.
    -- On HQ confirm: branch Cash Book gets a PV (cash out), HQ Cash
    -- Book gets a CR (cash in). On reject: no money moves.
    --
    -- Lives in master.db so branch (records it) and HQ (confirms it)
    -- read the same row — same pattern as stock_transfers.
    CREATE TABLE IF NOT EXISTS cash_deposits (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      deposit_number  TEXT NOT NULL UNIQUE,
      sync_id         TEXT NOT NULL UNIQUE,
      from_slug       TEXT NOT NULL,
      from_name       TEXT,
      currency        TEXT NOT NULL,                        -- 'USD' | 'FRA' | 'K'
      amount          REAL NOT NULL DEFAULT 0,              -- raw amount in the named currency
      amount_usd      REAL NOT NULL DEFAULT 0,              -- dollar value at sale-time / sent rate
      sell_rate       REAL,                                  -- snapshot of the rate used for amount_usd
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'PENDING',      -- PENDING | CONFIRMED | REJECTED
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_by    INTEGER,
      confirmed_by_name TEXT,
      confirmed_at    TEXT,
      reject_reason   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cash_deposits_status   ON cash_deposits (status);
    CREATE INDEX IF NOT EXISTS idx_cash_deposits_from     ON cash_deposits (from_slug, status);

    -- ── Phase C: HQ Purchase Receipts (no warehouse, drop-ship to branch) ──
    -- HQ has no physical stock — every supplier purchase is logged here
    -- with PER-LINE destination_slug. Branches see lines targeted at them
    -- in their "Incoming Stock" queue and confirm with actual_received_qty.
    -- On confirm, the branch's tenant DB gets a stock_movement (+) and a
    -- products.current_stock increment (auto-creating the product if it
    -- doesn't exist yet, matched by sync_id, fallback to name).
    --
    -- AP at HQ: total_amount accumulates supplier debt at the HQ level.
    -- Variance (dispatched_qty vs received_qty) is captured per line; HQ
    -- can chase the supplier or write off the gap later.
    --
    -- A header row stays OPEN until every line is RECEIVED (or CANCELLED);
    -- then it auto-promotes to COMPLETED so HQ can filter the list.
    CREATE TABLE IF NOT EXISTS hq_purchases (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_number TEXT NOT NULL UNIQUE,
      sync_id         TEXT NOT NULL UNIQUE,
      supplier_name   TEXT,
      invoice_number  TEXT,
      date            TEXT NOT NULL,
      total_amount    REAL NOT NULL DEFAULT 0,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'OPEN',
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hq_purchase_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id       INTEGER NOT NULL REFERENCES hq_purchases(id),
      purchase_sync_id  TEXT NOT NULL,
      sync_id           TEXT NOT NULL UNIQUE,
      product_sync_id   TEXT NOT NULL,
      product_name      TEXT NOT NULL,
      unit              TEXT,
      dispatched_qty    REAL NOT NULL,
      cost_price        REAL NOT NULL DEFAULT 0,
      line_total        REAL NOT NULL DEFAULT 0,
      destination_slug  TEXT NOT NULL,
      destination_name  TEXT,
      received_qty      REAL,
      status            TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | RECEIVED | CANCELLED
      variance_notes    TEXT,
      received_by       INTEGER,
      received_by_name  TEXT,
      received_at       TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hq_pi_dest_status ON hq_purchase_items (destination_slug, status);
    CREATE INDEX IF NOT EXISTS idx_hq_pi_purchase   ON hq_purchase_items (purchase_id);

    -- ── HQ Suppliers + AP ───────────────────────────────────────────────
    -- Master supplier list lives at HQ. Each hq_purchases.supplier_name is
    -- denormalised text (for human readability + so older rows don't break
    -- when a supplier is renamed). AP per supplier is computed from joins,
    -- not stored, so it can never drift out of sync with the underlying
    -- purchases + payments:
    --   AP = SUM(hq_purchases.total_amount  WHERE supplier matches)
    --      - SUM(hq_supplier_payments.amount WHERE supplier matches)
    --
    -- Matching: by supplier_id when set, else by case-insensitive
    -- supplier_name. New purchases pick from the master list (supplier_id
    -- filled in); legacy rows fall back to name match.
    CREATE TABLE IF NOT EXISTS hq_suppliers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      phone           TEXT,
      email           TEXT,
      address         TEXT,
      contact_person  TEXT,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'Active',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hq_suppliers_name ON hq_suppliers (name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS hq_supplier_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number  TEXT NOT NULL UNIQUE,
      supplier_id     INTEGER,
      supplier_name   TEXT NOT NULL,
      amount          REAL NOT NULL DEFAULT 0,
      payment_date    TEXT NOT NULL,
      payment_method  TEXT NOT NULL DEFAULT 'Cash',
      reference       TEXT,
      notes           TEXT,
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hq_pay_supplier ON hq_supplier_payments (supplier_id, supplier_name);
    CREATE INDEX IF NOT EXISTS idx_hq_pay_date     ON hq_supplier_payments (payment_date);
  `);

  // Add supplier_id to hq_purchases (nullable — older rows stay name-only).
  // Run as a separate ALTER so re-running the schema on existing master.dbs
  // doesn't trip CREATE TABLE.
  try {
    const cols = masterDb.prepare(`PRAGMA table_info(hq_purchases)`).all();
    if (!cols.find(c => c.name === 'supplier_id')) {
      masterDb.prepare(`ALTER TABLE hq_purchases ADD COLUMN supplier_id INTEGER`).run();
    }
  } catch (_) { /* fresh DB — table created above */ }

  // ── v1.3.3 — HQ Product Master ────────────────────────────────────────
  // HQ owns the canonical catalogue. When HQ creates a product we INSERT
  // a copy into every registered branch's `products` table using the
  // SAME sync_id so the linkage is automatic + survives renames. Per-
  // branch selling_price stays branch-owned (HQ default fills only on
  // first insert; subsequent HQ edits won't overwrite a branch's
  // override unless ?override_prices=1 is passed).
  try {
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_products (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id               TEXT UNIQUE NOT NULL,
        code                  TEXT,
        name                  TEXT NOT NULL,
        category_name         TEXT,
        main_category_name    TEXT,
        unit                  TEXT NOT NULL DEFAULT 'pcs',
        default_cost_price    REAL NOT NULL DEFAULT 0,
        default_selling_price REAL NOT NULL DEFAULT 0,
        min_stock             REAL NOT NULL DEFAULT 0,
        units_json            TEXT,
        status                TEXT NOT NULL DEFAULT 'Active',
        product_type          TEXT NOT NULL DEFAULT 'finished',
        image_url             TEXT,
        notes                 TEXT,
        created_by            INTEGER,
        created_by_name       TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_products_name ON hq_products(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_hq_products_status ON hq_products(status);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.3.3 hq_products migration:', e.message);
  }

  // ── v1.5.0 — HQ-owned vs branch-owned split ──────────────────────────
  // HQ now owns: code, name, category, base unit, packagings, default unit,
  // photo, returnable container, UB barcode. Each branch owns: prices,
  // min stock, status, opening stock, notes.
  // New hq_products columns mirror the per-product branch fields HQ
  // controls; pushToBranches copies them into each branch's products
  // table. Idempotent ALTERs so re-runs on existing master.dbs don't
  // break.
  try {
    const cols = masterDb.prepare(`PRAGMA table_info(hq_products)`).all().map(c => c.name);
    const addCol = (col, def) => {
      if (!cols.includes(col)) {
        masterDb.prepare(`ALTER TABLE hq_products ADD COLUMN ${col} ${def}`).run();
        cols.push(col);
      }
    };
    addCol('default_unit',              'TEXT');
    addCol('container_product_sync_id', 'TEXT');
    addCol('units_per_container',       'REAL');
    addCol('ub_number_start',           'INTEGER DEFAULT 1');
    addCol('ub_number_length',          'INTEGER DEFAULT 6');
    addCol('ub_quantity_start',         'INTEGER DEFAULT 7');
    addCol('ub_quantity_length',        'INTEGER DEFAULT 0');
    addCol('ub_decimal_start',          'INTEGER DEFAULT 2');
  } catch (e) {
    console.warn('[masterDb] v1.5.0 hq_products column migration:', e.message);
  }

  // ── v1.3.0 — New procurement state machine ────────────────────────────
  // Old model: PENDING (HQ-created) → RECEIVED (branch one-click, AP locked).
  // New model: AWAITING_GRN (HQ-created) → GRN_SUBMITTED (branch enters
  //            actual qty, no stock change yet) → CONFIRMED (HQ approves,
  //            now stock decrements at branch + supplier AP locks in).
  // Reasoning: HQ can't release a GRN because only the branch knows what
  // physically arrived; HQ then audits + confirms what branch reports.
  //
  // Add: confirmed_by / confirmed_by_name / confirmed_at / confirm_notes.
  // Backfill: any existing 'PENDING' rows → 'AWAITING_GRN'; 'RECEIVED' →
  // 'CONFIRMED' with confirmed_at stamped from received_at so AP reports
  // don't lose the date. Idempotent — guarded by column-existence check.
  try {
    const piCols = masterDb.prepare(`PRAGMA table_info(hq_purchase_items)`).all().map(c => c.name);
    const addCol = (col, def) => {
      if (!piCols.includes(col)) {
        masterDb.prepare(`ALTER TABLE hq_purchase_items ADD COLUMN ${col} ${def}`).run();
        piCols.push(col);
      }
    };
    addCol('confirmed_by',      'INTEGER');
    addCol('confirmed_by_name', 'TEXT');
    addCol('confirmed_at',      'TEXT');
    addCol('confirm_notes',     'TEXT');
    // Status rename — only on rows that still carry the legacy labels.
    masterDb.prepare(`
      UPDATE hq_purchase_items SET status = 'AWAITING_GRN'
       WHERE status = 'PENDING'
    `).run();
    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'CONFIRMED',
             confirmed_by      = COALESCE(confirmed_by, received_by),
             confirmed_by_name = COALESCE(confirmed_by_name, received_by_name),
             confirmed_at      = COALESCE(confirmed_at, received_at)
       WHERE status = 'RECEIVED'
    `).run();
  } catch (e) {
    console.warn('[masterDb] v1.3.0 hq_purchase_items migration:', e.message);
  }

  console.log('[master] Master DB ready:', masterDbPath);
} catch (e) {
  console.warn('[master] Could not open master DB (Electron mode — VPS-only features disabled):', e.message);
  masterDb = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRegistered(slug) {
  if (!masterDb) return false;
  const row = masterDb.prepare('SELECT id FROM tenants WHERE slug = ? AND is_active = 1').get(slug);
  return !!row;
}

function getTenant(slug) {
  if (!masterDb) return null;
  return masterDb.prepare('SELECT * FROM tenants WHERE slug = ? AND is_active = 1').get(slug);
}

function registerTenant(slug, businessName, email) {
  if (!masterDb) return;
  masterDb.prepare('INSERT INTO tenants (slug, business_name, email) VALUES (?, ?, ?)').run(slug, businessName, email || null);
}

function listTenants() {
  if (!masterDb) return [];
  return masterDb.prepare(`
    SELECT t.*, b.tenant_id
    FROM tenants t
    LEFT JOIN branches b ON b.slug = t.slug
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `).all();
}

function deactivateTenant(slug) {
  if (!masterDb) return;
  masterDb.prepare('UPDATE tenants SET is_active = 0 WHERE slug = ?').run(slug);
}

// ── License helpers ───────────────────────────────────────────────────────────

function getLicense(key) {
  if (!masterDb) return null;
  return masterDb.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
}

function createLicense(key, maxBranches, expiresAt, notes) {
  if (!masterDb) return;
  masterDb.prepare('INSERT INTO licenses (key, max_branches, expires_at, notes) VALUES (?, ?, ?, ?)').run(key, maxBranches, expiresAt, notes || null);
}

function activateLicense(key, email, tenantId) {
  if (!masterDb) return;
  masterDb.prepare("UPDATE licenses SET tenant_email = ?, tenant_id = ?, activated_at = datetime('now') WHERE key = ?").run(email, tenantId, key);
}

function updateLicense(key, fields) {
  if (!masterDb) return;
  const { expiresAt, isActive, maxBranches, notes } = fields;
  masterDb.prepare(`
    UPDATE licenses SET
      expires_at   = COALESCE(?, expires_at),
      is_active    = COALESCE(?, is_active),
      max_branches = COALESCE(?, max_branches),
      notes        = COALESCE(?, notes)
    WHERE key = ?
  `).run(expiresAt ?? null, isActive ?? null, maxBranches ?? null, notes ?? null, key);
}

function listLicenses() {
  if (!masterDb) return [];
  const licenses = masterDb.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
  return licenses.map(l => {
    const branches = l.tenant_id
      ? masterDb.prepare('SELECT * FROM branches WHERE tenant_id = ?').all(l.tenant_id)
      : [];
    const slug = branches.length ? branches[0].slug : null;
    return {
      ...l,
      branch_count: branches.length,
      branch_codes: branches.map(b => `${b.branch_name} [${b.branch_id.replace(/-/g,'').substring(0,8).toUpperCase()}]`).join(', ') || null,
      slug,
    };
  });
}

function getLicenseStats() {
  if (!masterDb) return { total: 0, active: 0, expired: 0, expiring: 0 };
  const now  = new Date().toISOString();
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  return {
    total:    masterDb.prepare('SELECT COUNT(*) AS n FROM licenses').get().n,
    active:   masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE is_active=1 AND expires_at > ?").get(now).n,
    expired:  masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE expires_at <= ?").get(now).n,
    expiring: masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE is_active=1 AND expires_at > ? AND expires_at <= ?").get(now, soon).n,
  };
}

// ── Branch helpers ────────────────────────────────────────────────────────────

function registerBranch(tenantId, branchId, branchName, slug) {
  if (!masterDb) return;
  try {
    masterDb.prepare('INSERT OR IGNORE INTO branches (tenant_id, branch_id, branch_name, slug) VALUES (?, ?, ?, ?)').run(tenantId, branchId, branchName, slug || null);
  } catch (_) {}
}

function getBranchesForTenant(tenantId) {
  if (!masterDb) return [];
  return masterDb.prepare('SELECT * FROM branches WHERE tenant_id = ?').all(tenantId);
}

module.exports = {
  isRegistered, getTenant, registerTenant, listTenants, deactivateTenant,
  getLicense, createLicense, activateLicense, updateLicense, listLicenses, getLicenseStats,
  registerBranch, getBranchesForTenant,
  masterDb,
  // Re-export the masterDb instance under a more obvious name for the
  // transfer routes, which need to read/write the stock_transfers table
  // directly without going through per-tenant routing.
  getMasterDb: () => masterDb,
};
