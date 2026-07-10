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

    -- v1.8.64 — per-line variance on inter-branch transfer RECEIVE.
    -- When the receiving branch counts a shortage / damage / loss vs what
    -- the sender shipped, we record one variance row per affected line so
    -- HQ can investigate. The receiver's stock movement only counts the
    -- good qty; the gap lives here (a "Transit Variance" bucket).
    CREATE TABLE IF NOT EXISTS transfer_variances (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id           TEXT NOT NULL UNIQUE,
      transfer_sync_id  TEXT NOT NULL,
      transfer_number   TEXT,
      from_slug         TEXT,
      to_slug           TEXT,
      product_sync_id   TEXT,
      product_name      TEXT,
      unit              TEXT,
      sent_qty          REAL NOT NULL DEFAULT 0,
      received_qty      REAL NOT NULL DEFAULT 0,
      variance_qty      REAL NOT NULL DEFAULT 0,
      reason            TEXT NOT NULL DEFAULT 'Short',  -- 'Short' | 'Damaged' | 'Lost'
      notes             TEXT,
      received_by       INTEGER,
      received_by_name  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at       TEXT,
      resolution        TEXT   -- 'WRITE_OFF' | 'RECOVERED' | NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_variances_xfer ON transfer_variances (transfer_sync_id);

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
  `);

  // v1.8.60 — additional fields on cash_deposits: user-pickable deposit
  // date (so we can record cash that left earlier but arrived later)
  // and an attachment (deposit slip photo / bank receipt PDF).
  // Added via ALTER so existing master.db's don't error on re-create.
  const addMasterCol = (table, col, def) => {
    try {
      const cols = masterDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes(col)) {
        masterDb.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
      }
    } catch (_) { /* table doesn't exist yet — schema CREATE above will include it next boot */ }
  };
  addMasterCol('cash_deposits', 'deposit_date', 'TEXT');
  addMasterCol('cash_deposits', 'attachment',   'TEXT');
  // v1.10.48 — from_method: which physical drawer the cash left on a Liquor
  // branch (Cash / Mobile Money / Bank). NULL for Sosna tri-currency
  // deposits (they're currency-anchored, not method-anchored) and for
  // legacy Liquor rows written before this column existed.
  addMasterCol('cash_deposits', 'from_method', 'TEXT');
  // v1.10.134 — to_method: which HQ drawer the deposit lands in on Confirm.
  // Cash / Bank / Mobile Money. NULL until HQ confirms. Only meaningful
  // for K deposits — Cash Book's K sub-breakdown uses it to route
  // deposit inflows to the right K sub-drawer (Cash / Bank / MoMo).
  addMasterCol('cash_deposits', 'to_method', 'TEXT');
  // v1.10.143 — soft-delete audit trail for HQ Deposits. Hard delete lost
  // the row from both sides (HQ Cash Book + branch Cash Book DEP-OUT),
  // effectively "un-depositing" the money on the branch's books while the
  // physical cash was already handed over. Soft-delete keeps the row +
  // stamps who deleted / when / why + which admin approved it, so the
  // UI can show a DELETED badge (same pattern as REJECTED) and read paths
  // exclude the row from balance math.
  addMasterCol('cash_deposits', 'deleted_at',      'TEXT');
  addMasterCol('cash_deposits', 'deleted_by',      'INTEGER');
  addMasterCol('cash_deposits', 'deleted_by_name', 'TEXT');
  addMasterCol('cash_deposits', 'delete_reason',   'TEXT');
  // v1.10.168 — post-confirm edit audit trail. HQ can now correct
  // amount / from_method / notes / date on a CONFIRMED deposit with
  // reason + admin password. Original row keeps its create audit;
  // these columns stamp the LATEST edit (last-write-wins on repeat
  // edits — the reject/delete route is what preserves reversal audit).
  addMasterCol('cash_deposits', 'edited_at',      'TEXT');
  addMasterCol('cash_deposits', 'edited_by',      'INTEGER');
  addMasterCol('cash_deposits', 'edited_by_name', 'TEXT');
  addMasterCol('cash_deposits', 'edit_reason',    'TEXT');

  masterDb.exec(`

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
    // v1.8.65 — reason vocabulary aligned with transfer_variances:
    // OK / Short / Damaged / Lost. Existing rows default to OK on read.
    addCol('reason',            'TEXT');
    // v1.9.7 — branch-side rejection. Branch can decline an incoming PO
    // line (wrong branch, wrong supplier, qty looks off, etc.) instead
    // of being forced to generate a GRN for it. status becomes
    // BRANCH_REJECTED (terminal); reason + actor stamp captured for
    // HQ visibility on the Purchases list.
    addCol('branch_rejected_by',      'INTEGER');
    addCol('branch_rejected_by_name', 'TEXT');
    addCol('branch_rejected_at',      'TEXT');
    addCol('branch_reject_reason',    'TEXT');
    // v1.9.7 — link the PO line to the branch GRN that fulfilled it.
    // When branch creates a GRN with linked_purchase_sync_id pointing
    // at this PO, the GRN's sync_id is written here so HQ Confirm GRN
    // can pull the full GRN doc + credit notes by sync_id (no need to
    // join across tenant DBs).
    addCol('linked_grn_sync_id',  'TEXT');
    // v1.9.21 — denormalised GRN# for display on the branch's Incoming
    // Stock page (the "WAITING HQ" rows). Avoids a cross-tenant lookup
    // just to render a human-readable reference.
    addCol('linked_grn_number',   'TEXT');
  } catch (e) {
    console.warn('[masterDb] v1.3.0 hq_purchase_items migration:', e.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v1.9.14 — HQ snapshot of every confirmed branch GRN.
  // ─────────────────────────────────────────────────────────────────────────
  // Each confirmed GRN writes one row here. Lets HQ aggregate AP / per-
  // supplier statements / PO reconciliation in a single SQL query without
  // scanning every branch tenant DB. Full GRN line items + credit notes
  // stay at the branch — HQ pulls them on-demand via the existing
  // GET /api/hq/grns/:slug/:syncId endpoint when the user clicks
  // "See Details". Small (~200 bytes per GRN) so the duplication cost is
  // negligible vs the speed + offline-resilience win.
  try {
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_confirmed_grn_totals (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        grn_sync_id         TEXT NOT NULL UNIQUE,
        grn_number          TEXT NOT NULL,
        branch_slug         TEXT NOT NULL,
        branch_name         TEXT,
        supplier_id         INTEGER,
        supplier_sync_id    TEXT,
        supplier_name       TEXT,
        po_sync_id          TEXT,
        po_number           TEXT,
        date                TEXT,
        items_count         INTEGER NOT NULL DEFAULT 0,
        items_subtotal      REAL NOT NULL DEFAULT 0,
        cn_total            REAL NOT NULL DEFAULT 0,
        final_payable       REAL NOT NULL DEFAULT 0,
        invoice_number      TEXT,
        confirmed_by        INTEGER,
        confirmed_by_name   TEXT,
        confirmed_at        TEXT NOT NULL DEFAULT (datetime('now')),
        notes               TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_branch   ON hq_confirmed_grn_totals (branch_slug);
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_supplier ON hq_confirmed_grn_totals (supplier_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_date     ON hq_confirmed_grn_totals (date);
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_po       ON hq_confirmed_grn_totals (po_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.9.14 hq_confirmed_grn_totals:', e.message);
  }

  try {
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

  // ─────────────────────────────────────────────────────────────────────────
  // v1.10.0 — procurement rearchitecture.
  // ─────────────────────────────────────────────────────────────────────────
  // The GRN-paperwork ownership shifts from branch to HQ. Branch's role
  // collapses to "confirm what physically arrived"; HQ does invoice + CN
  // paperwork and generates the GRN. New state machine on hq_purchase_items:
  //   AWAITING_CONFIRMATION → RECEIPT_REPORTED → CONFIRMED
  // (BRANCH_REJECTED unchanged; legacy AWAITING_GRN/GRN_SUBMITTED rows
  // continue to work through the old endpoints for back-compat.)
  try {
    // Branch confirmation captures invoice # + photo on the PO header.
    const hpCols = masterDb.prepare(`PRAGMA table_info(hq_purchases)`).all().map(c => c.name);
    const addHpCol = (col, def) => {
      if (!hpCols.includes(col)) {
        masterDb.prepare(`ALTER TABLE hq_purchases ADD COLUMN ${col} ${def}`).run();
        hpCols.push(col);
      }
    };
    addHpCol('supplier_invoice_number',  'TEXT');
    addHpCol('invoice_attachment',       'TEXT');
    addHpCol('confirmed_by_branch',      'INTEGER');
    addHpCol('confirmed_by_branch_name', 'TEXT');
    addHpCol('confirmed_at_branch',      'TEXT');
    addHpCol('confirmed_branch_slug',    'TEXT');
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_purchases migration:', e.message);
  }

  try {
    // Off-PO items branch received (e.g. supplier sent SAVANNA 20 when the
    // PO only listed CASTLE LITE). Each gets reviewed by HQ when they
    // generate the GRN; rolls into the GRN as an extra line.
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_purchase_receipt_extras (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id             TEXT NOT NULL UNIQUE,
        purchase_sync_id    TEXT NOT NULL,
        product_sync_id     TEXT,
        product_name        TEXT NOT NULL,
        unit                TEXT,
        quantity            REAL NOT NULL DEFAULT 0,
        cost_price          REAL NOT NULL DEFAULT 0,
        added_by            INTEGER,
        added_by_name       TEXT,
        added_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_extras_purchase ON hq_purchase_receipt_extras (purchase_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_purchase_receipt_extras:', e.message);
  }

  try {
    // HQ-owned GRN. Replaces the per-branch grn table for v1.10.0+ flow.
    // Branch's grn table stays untouched for legacy reads.
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_grns (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        grn_number                TEXT NOT NULL UNIQUE,
        sync_id                   TEXT NOT NULL UNIQUE,
        date                      TEXT NOT NULL,
        branch_slug               TEXT NOT NULL,
        branch_name               TEXT,
        supplier_id               INTEGER,
        supplier_sync_id          TEXT,
        supplier_name             TEXT,
        po_sync_id                TEXT,
        po_number                 TEXT,
        supplier_invoice_number   TEXT,
        invoice_attachment        TEXT,
        items_subtotal            REAL NOT NULL DEFAULT 0,
        cn_total                  REAL NOT NULL DEFAULT 0,
        final_payable             REAL NOT NULL DEFAULT 0,
        notes                     TEXT,
        confirmed_by_branch       INTEGER,
        confirmed_by_branch_name  TEXT,
        confirmed_at_branch       TEXT,
        generated_by_hq           INTEGER,
        generated_by_hq_name      TEXT,
        generated_at              TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at                TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hq_grns_branch   ON hq_grns (branch_slug);
      CREATE INDEX IF NOT EXISTS idx_hq_grns_supplier ON hq_grns (supplier_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_grns_po       ON hq_grns (po_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_grns_date     ON hq_grns (date);

      CREATE TABLE IF NOT EXISTS hq_grn_items (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id             TEXT NOT NULL UNIQUE,
        grn_id              INTEGER NOT NULL REFERENCES hq_grns(id),
        grn_sync_id         TEXT NOT NULL,
        product_sync_id     TEXT,
        product_name        TEXT NOT NULL,
        unit                TEXT,
        quantity            REAL NOT NULL DEFAULT 0,
        unit_price          REAL NOT NULL DEFAULT 0,
        total_price         REAL NOT NULL DEFAULT 0,
        expiry_date         TEXT,
        is_extra            INTEGER NOT NULL DEFAULT 0,
        po_expected_qty     REAL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_grn_items_grn ON hq_grn_items (grn_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_grns:', e.message);
  }

  try {
    // HQ-owned supplier credit notes (linked to hq_grns). Mirrors the
    // branch supplier_credit_notes shape so the existing CN UI maps cleanly.
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_supplier_credit_notes (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        credit_note_number    TEXT NOT NULL UNIQUE,
        sync_id               TEXT NOT NULL UNIQUE,
        date                  TEXT NOT NULL,
        supplier_id           INTEGER,
        supplier_sync_id      TEXT,
        supplier_name         TEXT,
        reason                TEXT NOT NULL,
        reference             TEXT,
        amount                REAL NOT NULL DEFAULT 0,
        notes                 TEXT,
        grn_sync_id           TEXT,
        branch_slug           TEXT,
        created_by            INTEGER,
        created_by_name       TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hq_scn_grn      ON hq_supplier_credit_notes (grn_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_scn_supplier ON hq_supplier_credit_notes (supplier_sync_id);

      CREATE TABLE IF NOT EXISTS hq_supplier_credit_note_items (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id               TEXT NOT NULL UNIQUE,
        credit_note_id        INTEGER NOT NULL REFERENCES hq_supplier_credit_notes(id),
        credit_note_sync_id   TEXT NOT NULL,
        product_sync_id       TEXT,
        product_name          TEXT,
        quantity              REAL NOT NULL DEFAULT 0,
        unit                  TEXT,
        unit_conv             REAL NOT NULL DEFAULT 1,
        unit_value            REAL NOT NULL DEFAULT 0,
        total_price           REAL NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_scn_items_cn ON hq_supplier_credit_note_items (credit_note_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_supplier_credit_notes:', e.message);
  }

  // v1.10.53 — WAC redesign schema additions.
  //
  // Every HQ PO carries ONE FX rate for its whole batch (per user's
  // 2026-07-03 decision — one rate per PO, not per line). Rate is
  // captured at PO Create time (HQ side), not at Confirm Receipt.
  // Currency label lets tri-currency branches (Kassumbalesa) declare
  // the supplier billed in K vs USD; K-only branches leave it NULL and
  // the code path skips the FX prompt entirely.
  addMasterCol('hq_purchases', 'cost_currency', 'TEXT');   // 'USD' | 'FRA' | 'K' — nullable, only set when the destination is a tri-currency branch
  addMasterCol('hq_purchases', 'fx_rate_used', 'REAL');    // e.g. 25 when 1 USD = 25 K on this PO — nullable for K-only destinations
  addMasterCol('hq_purchase_items', 'cost_price_usd', 'REAL'); // derived at insert time = cost_price / fx_rate_used (or cost_price itself when currency=USD or rate=NULL)

  // Same three fields on stock_transfers header — one rate per transfer.
  // Transfer items live inside stock_transfers.items_json so per-line
  // storage happens there, not in a separate table. Header rate applies
  // to every line uniformly.
  addMasterCol('stock_transfers', 'cost_currency', 'TEXT');
  addMasterCol('stock_transfers', 'fx_rate_used', 'REAL');

  // v1.10.115 — Void audit trail on HQ GRNs. Set by /api/hq/grns/:syncId/void
  // when an admin voids a wrong GRN. deleted_at column already exists on
  // hq_grns; these fields answer "who / when / why" for the audit log.
  addMasterCol('hq_grns', 'voided_by',      'INTEGER');
  addMasterCol('hq_grns', 'voided_by_name', 'TEXT');
  addMasterCol('hq_grns', 'voided_at',      'TEXT');
  addMasterCol('hq_grns', 'void_reason',    'TEXT');

  // v1.10.118 — Edit endpoint columns. cost_currency + fx_rate_used mirror
  // hq_purchases (see v1.10.53 WAC redesign); we store them on hq_grns
  // too so the Archive can display the right symbol without JOINing back
  // to the PO. edited_* columns are the audit trail for /edit.
  addMasterCol('hq_grns', 'cost_currency',  'TEXT');
  addMasterCol('hq_grns', 'fx_rate_used',   'REAL');
  addMasterCol('hq_grns', 'edited_by',      'INTEGER');
  addMasterCol('hq_grns', 'edited_by_name', 'TEXT');
  addMasterCol('hq_grns', 'edited_at',      'TEXT');
  addMasterCol('hq_grns', 'edit_reason',    'TEXT');

  // v1.10.119 — hq_grn_items was created (v1.10.0) without soft-delete
  // columns. The v1.10.115 Void endpoint and v1.10.118 Edit endpoint both
  // reference `deleted_at IS NULL` when reading/updating item rows, so
  // Edit fails with "no such column: deleted_at" (real incident on
  // GRN-2026-85215664, 2026-07-05) and Void would too if it ever got past
  // the stock-consumed safety check. Adding the columns retroactively —
  // existing rows get NULL, which passes the IS NULL check.
  addMasterCol('hq_grn_items', 'deleted_at', 'TEXT');
  addMasterCol('hq_grn_items', 'updated_at', 'TEXT');

  // v1.10.120 — hq_grns CREATE (v1.10.0) also missed `updated_at`. Void +
  // Edit endpoints both stamp updated_at=datetime('now') on write, so the
  // header UPDATE was throwing "no such column: updated_at" (second
  // incident on GRN-2026-85215664 after the deleted_at fix). Same for
  // hq_supplier_credit_notes on Void's CN soft-delete path — defensively
  // add there too.
  addMasterCol('hq_grns',                  'updated_at', 'TEXT');
  addMasterCol('hq_supplier_credit_notes', 'updated_at', 'TEXT');
  addMasterCol('hq_supplier_credit_notes', 'deleted_at', 'TEXT');

  // v1.10.122 — hq_purchase_items + hq_purchases CREATE also missed
  // `updated_at`. Void's PO reset + Edit's PO consistency step both
  // stamp it. Adding retroactively.
  addMasterCol('hq_purchase_items', 'updated_at', 'TEXT');
  addMasterCol('hq_purchases',       'updated_at', 'TEXT');

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
