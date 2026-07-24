/**
 * initTenantDb(db)
 * Runs on a fresh tenant SQLite database to create all tables and add sync columns.
 * Safe to run on existing DBs (all statements use IF NOT EXISTS / column checks).
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');

function initTenantDb(db) {
  // ── Core tables ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      email       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      phone       TEXT,
      address     TEXT,
      role        TEXT NOT NULL DEFAULT 'Cashier',
      permissions TEXT DEFAULT '[]',
      status      TEXT NOT NULL DEFAULT 'Active',
      last_login  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      color       TEXT DEFAULT '#6B7280',
      status      TEXT NOT NULL DEFAULT 'Active',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      code                TEXT,
      name                TEXT NOT NULL,
      category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      unit                TEXT NOT NULL DEFAULT 'pcs',
      cost_price          REAL NOT NULL DEFAULT 0,
      selling_price       REAL NOT NULL DEFAULT 0,
      current_stock       REAL NOT NULL DEFAULT 0,
      min_stock           REAL NOT NULL DEFAULT 10,
      status              TEXT NOT NULL DEFAULT 'Active',
      image_url           TEXT,
      ub_number_start     INTEGER DEFAULT 1,
      ub_number_length    INTEGER DEFAULT 6,
      ub_quantity_start   INTEGER DEFAULT 7,
      ub_quantity_length  INTEGER DEFAULT 0,
      ub_decimal_start    INTEGER DEFAULT 2,
      product_type        TEXT NOT NULL DEFAULT 'finished',
      alt_unit            TEXT,
      conversion_factor   REAL,
      alt_price           REAL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      type             TEXT NOT NULL DEFAULT 'Regular',
      phone            TEXT,
      email            TEXT,
      address          TEXT,
      total_purchases  REAL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'Active',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      type            TEXT,
      phone           TEXT,
      email           TEXT,
      address         TEXT,
      contact_person  TEXT,
      outstanding     REAL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'Active',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number    TEXT UNIQUE NOT NULL,
      customer_name   TEXT,
      payment_method  TEXT DEFAULT 'Cash',
      subtotal        REAL NOT NULL DEFAULT 0,
      tax_rate        REAL DEFAULT 0,
      tax_amount      REAL DEFAULT 0,
      discount        REAL DEFAULT 0,
      total_amount    REAL NOT NULL DEFAULT 0,
      amount_received REAL DEFAULT 0,
      change_amount   REAL DEFAULT 0,
      status          TEXT DEFAULT NULL,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id            INTEGER NOT NULL REFERENCES orders(id),
      product_id          INTEGER REFERENCES products(id),
      product_name        TEXT NOT NULL,
      quantity            REAL NOT NULL,
      unit_price          REAL NOT NULL,
      discount_percentage REAL DEFAULT 0,
      discount_amount     REAL DEFAULT 0,
      total_price         REAL NOT NULL,
      reversed            INTEGER NOT NULL DEFAULT 0,
      reversed_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS grn (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_number   TEXT UNIQUE NOT NULL,
      date         TEXT NOT NULL,
      supplier_id  INTEGER REFERENCES suppliers(id),
      total_items  INTEGER DEFAULT 0,
      total_amount REAL DEFAULT 0,
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id),
      status       TEXT DEFAULT 'Completed',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS grn_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id      INTEGER NOT NULL REFERENCES grn(id),
      product_id  INTEGER REFERENCES products(id),
      quantity    REAL NOT NULL,
      unit_price  REAL NOT NULL,
      total_price REAL NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS siv (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      siv_number  TEXT UNIQUE NOT NULL,
      date        TEXT NOT NULL,
      department  TEXT,
      total_items INTEGER DEFAULT 0,
      total_value REAL DEFAULT 0,
      notes       TEXT,
      created_by  INTEGER REFERENCES users(id),
      status      TEXT DEFAULT 'Issued',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS siv_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      siv_id      INTEGER NOT NULL REFERENCES siv(id),
      product_id  INTEGER REFERENCES products(id),
      quantity    REAL NOT NULL,
      unit_price  REAL DEFAULT 0,
      total_price REAL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER REFERENCES products(id),
      location       TEXT NOT NULL,
      movement_type  TEXT NOT NULL,
      quantity       REAL NOT NULL,
      reference_id   INTEGER,
      reference_type TEXT,
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cash_receipts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT UNIQUE NOT NULL,
      received_from  TEXT,
      description    TEXT,
      payment_method TEXT,
      amount         REAL NOT NULL DEFAULT 0,
      date           TEXT NOT NULL,
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_vouchers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_number TEXT UNIQUE NOT NULL,
      paid_to        TEXT,
      description    TEXT,
      category       TEXT,
      amount         REAL NOT NULL DEFAULT 0,
      date           TEXT NOT NULL,
      paid_from      TEXT DEFAULT 'Main cashier',
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ap_payments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT UNIQUE NOT NULL,
      supplier_id    INTEGER REFERENCES suppliers(id),
      supplier_name  TEXT,
      amount         REAL NOT NULL DEFAULT 0,
      description    TEXT,
      date           TEXT NOT NULL,
      paid_from      TEXT DEFAULT 'Main cashier',
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cash_book (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT NOT NULL,
      description    TEXT,
      reference      TEXT,
      receipt_amount REAL DEFAULT 0,
      payment_amount REAL DEFAULT 0,
      balance        REAL DEFAULT 0,
      type           TEXT DEFAULT 'entry',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS business_settings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name    TEXT,
      business_phone   TEXT,
      business_email   TEXT,
      business_address TEXT,
      tax_rate         REAL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- cash_reports is keyed on (date, cashier_id) so each cashier can save
    -- their own daily report for the same date. The composite uniqueness
    -- is enforced by an index further down (and back-migrated for tenant
    -- DBs that pre-date this change — see the cash_reports rewrite block
    -- after the CREATE TABLE pass).
    CREATE TABLE IF NOT EXISTS cash_reports (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT NOT NULL,
      initial_change REAL DEFAULT 0,
      mobile_money   REAL DEFAULT 0,
      cash           REAL DEFAULT 0,
      expenses       REAL DEFAULT 0,
      pending        REAL DEFAULT 0,
      total          REAL DEFAULT 0,
      after_change   REAL DEFAULT 0,
      expected       REAL DEFAULT 0,
      difference     REAL DEFAULT 0,
      status         TEXT,
      comment        TEXT,
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      adjustment_number TEXT UNIQUE NOT NULL,
      date              TEXT NOT NULL,
      product_id        INTEGER REFERENCES products(id),
      adjustment_type   TEXT NOT NULL,
      quantity          REAL NOT NULL,
      reason            TEXT,
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_actual_balance (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER NOT NULL REFERENCES products(id),
      product_sync_id  TEXT,
      date             TEXT NOT NULL,
      actual_balance   REAL NOT NULL,
      reason           TEXT,
      created_by       INTEGER,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, date)
    );

    CREATE TABLE IF NOT EXISTS sync_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_profit_summary (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      revenue         REAL NOT NULL DEFAULT 0,
      cogs            REAL NOT NULL DEFAULT 0,
      diff_value      REAL NOT NULL DEFAULT 0,
      cash_difference REAL NOT NULL DEFAULT 0,
      pv_total        REAL NOT NULL DEFAULT 0,
      stock_adj       REAL NOT NULL DEFAULT 0,
      gross_profit    REAL NOT NULL DEFAULT 0,
      net_profit      REAL NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, tenant_id)
    );

    CREATE TABLE IF NOT EXISTS production (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      production_number TEXT UNIQUE NOT NULL,
      date              TEXT NOT NULL,
      notes             TEXT,
      total_input_cost  REAL DEFAULT 0,
      cost_per_kg       REAL DEFAULT 0,
      total_output_qty  REAL DEFAULT 0,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS production_inputs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      production_id INTEGER NOT NULL REFERENCES production(id),
      product_id    INTEGER REFERENCES products(id),
      quantity      REAL NOT NULL,
      unit_cost     REAL NOT NULL DEFAULT 0,
      total_cost    REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS production_outputs (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      production_id            INTEGER NOT NULL REFERENCES production(id),
      product_id               INTEGER REFERENCES products(id),
      quantity                 REAL NOT NULL,
      allocated_cost_per_unit  REAL NOT NULL DEFAULT 0,
      total_allocated_cost     REAL NOT NULL DEFAULT 0,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sales_returns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT UNIQUE NOT NULL,
      date          TEXT NOT NULL,
      notes         TEXT,
      total_items   INTEGER DEFAULT 0,
      created_by    INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sales_return_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id  INTEGER REFERENCES sales_returns(id),
      product_id INTEGER REFERENCES products(id),
      quantity   REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_cost_snapshot (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER REFERENCES products(id),
      product_sync_id  TEXT,
      date             TEXT NOT NULL,
      avg_cost_price   REAL NOT NULL DEFAULT 0,
      selling_price    REAL NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      sync_id          TEXT,
      tenant_id        TEXT,
      branch_id        TEXT,
      device_id        TEXT,
      synced           INTEGER NOT NULL DEFAULT 0,
      deleted_at       TEXT
    );

    -- Stock Reconciliation (discrete physical count events; ≠ initial Stock Count sessions)
    CREATE TABLE IF NOT EXISTS stock_reconciliations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      count_date   TEXT NOT NULL,
      location     TEXT NOT NULL DEFAULT 'sales',
      notes        TEXT,
      created_by   INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Customer Payments (Accounts Receivable) — after-sale payments from credit customers
    CREATE TABLE IF NOT EXISTS customer_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id     INTEGER,
      customer_sync_id TEXT,
      amount          REAL NOT NULL DEFAULT 0,
      payment_date    TEXT NOT NULL,
      payment_method  TEXT DEFAULT 'Cash',
      reference       TEXT,
      notes           TEXT,
      created_by      INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_reconciliation_items (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id     INTEGER NOT NULL,
      reconciliation_sync_id TEXT,
      product_id            INTEGER NOT NULL,
      product_sync_id       TEXT,
      system_qty            REAL NOT NULL DEFAULT 0,
      physical_qty          REAL NOT NULL DEFAULT 0,
      unit                  TEXT,
      variance_base         REAL NOT NULL DEFAULT 0,
      cost_at_count         REAL NOT NULL DEFAULT 0,
      reason                TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Tables that may not exist in older tenant DBs — create them here so the
  // sync-column loop below doesn't crash on first run.
  db.exec(`
    -- ── Main categories + units ─────────────────────────────────────────────
    -- These were originally only created by server.js into the default DB.
    -- Per-tenant DBs need them too — products/items routes JOIN against these
    -- tables and crash with SQLITE_ERROR ("no such table") if missing.
    CREATE TABLE IF NOT EXISTS main_categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#6B7280',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS units (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      abbreviation TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pv_types (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#6B7280',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Empty Returns ───────────────────────────────────────────────────────
    -- Stand-alone document for sending empty crates / bottles back to the supplier
    -- and receiving a deposit credit. Distinct from GRN because there are no goods
    -- being received — only containers leaving the yard and an AP credit landing.
    CREATE TABLE IF NOT EXISTS empty_returns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT NOT NULL,
      date          TEXT NOT NULL,
      supplier_id   INTEGER REFERENCES suppliers(id),
      total_items   INTEGER DEFAULT 0,
      total_amount  REAL DEFAULT 0,
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id),
      status        TEXT DEFAULT 'Completed',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS empty_return_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      empty_return_id INTEGER NOT NULL REFERENCES empty_returns(id),
      product_id  INTEGER REFERENCES products(id),
      quantity    REAL NOT NULL,
      deposit     REAL NOT NULL DEFAULT 0,
      total_price REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Stock count + Quick items ───────────────────────────────────────────
    -- Same fix as main_categories/units: these were only defined in server.js
    -- (default DB), so per-tenant DBs lacked them and any feature using them 500-ed.
    CREATE TABLE IF NOT EXISTS stock_count_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'Active',
      created_by INTEGER REFERENCES users(id),
      tenant_id  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_count_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES stock_count_sessions(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quick_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       TEXT,
      product_sync_id TEXT NOT NULL,
      position        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, product_sync_id)
    );

    -- ── Cash transfers ──────────────────────────────────────────────────────
    -- Moves money between cash buckets (Cash <-> Bank <-> Mobile Money).
    -- Doesn't affect the company's TOTAL cash balance — only redistributes
    -- between methods. Lives in its own table so it doesn't pollute CR / PV.
    CREATE TABLE IF NOT EXISTS cash_transfers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT NOT NULL,
      date            TEXT NOT NULL,
      from_method     TEXT NOT NULL,  -- 'Cash' | 'Bank' | 'Mobile Money'
      to_method       TEXT NOT NULL,
      amount          REAL NOT NULL DEFAULT 0,
      description     TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Supplier Credit Notes ───────────────────────────────────────────────
    -- Documents a credit the supplier owes you. Two real-world sources:
    --   Discount / Other  -> real income event, counted in Profit Report as
    --                        "Supplier Rebates" (positive line under gross)
    --   Crate Return / Bottle Return -> deposit refund, NOT income; profit
    --                        report ignores these (they only move AP balance
    --                        + stock of the empty product)
    -- Replaces the old GRN "containers_returned" deduction and is the storage
    -- backing the Empty Returns page (Phase 4A).
    CREATE TABLE IF NOT EXISTS supplier_credit_notes (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_number TEXT NOT NULL,
      date               TEXT NOT NULL,
      supplier_id        INTEGER REFERENCES suppliers(id),
      reason             TEXT NOT NULL DEFAULT 'Discount',  -- 'Discount' | 'Crate Return' | 'Bottle Return' | 'Other'
      reference          TEXT,                              -- free text: GRN # / driver name / etc.
      amount             REAL NOT NULL DEFAULT 0,           -- always positive
      notes              TEXT,
      created_by         INTEGER REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS supplier_credit_note_items (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_id          INTEGER NOT NULL REFERENCES supplier_credit_notes(id),
      product_id              INTEGER REFERENCES products(id),
      quantity                REAL NOT NULL DEFAULT 0,
      unit_value              REAL NOT NULL DEFAULT 0,     -- deposit per unit
      total_price             REAL NOT NULL DEFAULT 0,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Capital Account ────────────────────────────────────────────────────
    -- Owner equity ledger. Two flows in one table:
    --   Injection : owner puts money INTO the business (cash inflow, +equity)
    --   Drawing   : owner takes money OUT of the business (cash outflow, -equity)
    -- These hit the Cash Book like any CR/PV, but are excluded from the Profit
    -- Report because they're equity, not P&L.
    CREATE TABLE IF NOT EXISTS capital_account (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number        TEXT NOT NULL,
      date                TEXT NOT NULL,
      type                TEXT NOT NULL DEFAULT 'Injection',  -- 'Injection' | 'Drawing'
      owner_name          TEXT,
      amount              REAL NOT NULL DEFAULT 0,            -- always positive
      cash_amount         REAL NOT NULL DEFAULT 0,
      bank_amount         REAL NOT NULL DEFAULT 0,
      momo_amount         REAL NOT NULL DEFAULT 0,
      description         TEXT,
      invoice_attachment  TEXT,
      created_by          INTEGER REFERENCES users(id),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Dividend Account ───────────────────────────────────────────────────
    -- Profit distribution to the owner(s). Always an outflow. Excluded from
    -- the Profit Report — dividends are paid out of retained earnings, not
    -- treated as an operating expense.
    CREATE TABLE IF NOT EXISTS dividend_account (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number        TEXT NOT NULL,
      date                TEXT NOT NULL,
      recipient           TEXT,
      amount              REAL NOT NULL DEFAULT 0,            -- always positive
      cash_amount         REAL NOT NULL DEFAULT 0,
      bank_amount         REAL NOT NULL DEFAULT 0,
      momo_amount         REAL NOT NULL DEFAULT 0,
      description         TEXT,
      invoice_attachment  TEXT,
      created_by          INTEGER REFERENCES users(id),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Shareholders ───────────────────────────────────────────────────────
    -- Master list of people/entities holding equity in the business. Used as
    -- the source for the dropdown on Capital and Dividend entries so the
    -- system can answer per-shareholder questions: "How much has Sirak
    -- invested?" / "How much dividend has Nahom received?"
    CREATE TABLE IF NOT EXISTS shareholders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      share_percentage  REAL NOT NULL DEFAULT 0,   -- optional, for reporting
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Loans ──────────────────────────────────────────────────────────────
    -- The loan AGREEMENT itself — one row per active or paid-off loan.
    -- Outstanding balance is derived from loan_transactions, not stored, so
    -- it can never drift out of sync with the underlying transactions.
    CREATE TABLE IF NOT EXISTS loans (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_number       TEXT NOT NULL,
      lender_name       TEXT,
      principal_amount  REAL NOT NULL DEFAULT 0,
      interest_rate     REAL NOT NULL DEFAULT 0,   -- annual % — informational
      start_date        TEXT,
      maturity_date     TEXT,
      status            TEXT NOT NULL DEFAULT 'Active', -- 'Active' | 'Paid Off' | 'Defaulted'
      notes             TEXT,
      invoice_attachment TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Discount Requests ──────────────────────────────────────────────────
    -- Async approval workflow for cashier discounts. When a non-admin enters
    -- a discount on the POS, a pending row is created here; an Administrator
    -- approves or rejects from the Approvals page; the cashier's POS polls
    -- this row by sync_id and applies the discount when status flips to
    -- 'approved'. Admins skip this flow entirely (handled client-side).
    --
    -- target='line' → product_*, unit, quantity, unit_price populated;
    --                  discount_amount is the per-unit Kwacha off.
    -- target='cart' → only subtotal populated; discount_amount is a flat
    --                  Kwacha off the whole sale.
    CREATE TABLE IF NOT EXISTS discount_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_by      INTEGER NOT NULL REFERENCES users(id),
      requester_name    TEXT NOT NULL,
      target            TEXT NOT NULL,                 -- 'line' | 'cart'
      product_name      TEXT,
      product_sync_id   TEXT,
      unit              TEXT,
      quantity          REAL NOT NULL DEFAULT 0,
      unit_price        REAL NOT NULL DEFAULT 0,
      subtotal          REAL NOT NULL DEFAULT 0,
      discount_amount   REAL NOT NULL DEFAULT 0,
      -- v1.8.98 — Change Price feature. When set, this is the new final
      -- unit price the cashier wants to apply (replaces unit_price on approval).
      -- discount_amount is auto-computed as (unit_price - new_price) * quantity
      -- for back-compat with reports — can be negative for surcharges.
      -- change_reason captures the cashier's text (required, min 3 chars).
      new_price         REAL,
      change_reason     TEXT,
      status            TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
      approver_id       INTEGER REFERENCES users(id),
      approver_name     TEXT,
      approved_at       TEXT,
      rejection_reason  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v1.8.87 — Order Payment Edits audit log.
    -- Admin-only post-payment corrections (typos, wrong currency, wrong rate)
    -- write a row here. old_payload / new_payload are JSON snapshots of the
    -- 12 mutable payment fields on the order so we can replay any sequence.
    -- 7-day window enforced at the route layer, not the schema.
    CREATE TABLE IF NOT EXISTS order_payment_edits (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id           INTEGER NOT NULL,
      order_sync_id      TEXT,
      edited_by          INTEGER REFERENCES users(id),
      edited_by_name     TEXT,
      edited_at          TEXT NOT NULL DEFAULT (datetime('now')),
      reason             TEXT NOT NULL,
      old_payload        TEXT NOT NULL,    -- JSON
      new_payload        TEXT NOT NULL,    -- JSON
      sync_id            TEXT UNIQUE,
      tenant_id          INTEGER,
      branch_id          TEXT,
      device_id          TEXT,
      synced             INTEGER DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Loan Transactions ──────────────────────────────────────────────────
    -- Every cash movement against a loan, of three kinds:
    --   'Disbursement' → lender pays us; cash IN; not income; +outstanding
    --   'Principal'    → we pay lender; cash OUT; not expense; -outstanding
    --   'Interest'     → we pay lender; cash OUT; IS expense; no balance effect
    CREATE TABLE IF NOT EXISTS loan_transactions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_number TEXT NOT NULL,
      loan_id            INTEGER NOT NULL REFERENCES loans(id),
      date               TEXT NOT NULL,
      type               TEXT NOT NULL,            -- 'Disbursement' | 'Principal' | 'Interest'
      amount             REAL NOT NULL DEFAULT 0,
      cash_amount        REAL NOT NULL DEFAULT 0,
      bank_amount        REAL NOT NULL DEFAULT 0,
      momo_amount        REAL NOT NULL DEFAULT 0,
      description        TEXT,
      invoice_attachment TEXT,
      created_by         INTEGER REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Add sync columns to all tables ────────────────────────────────────────
  function addCol(table, col, def) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === col)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    }
  }

  const allTables = [
    'users', 'categories', 'products', 'customers', 'suppliers',
    'orders', 'order_items', 'grn', 'grn_items', 'siv', 'siv_items',
    'stock_movements', 'cash_receipts', 'payment_vouchers', 'cash_book',
    'business_settings', 'cash_reports', 'stock_adjustments', 'daily_actual_balance',
    'production', 'production_inputs', 'production_outputs',
    'sales_returns', 'sales_return_items', 'ap_payments',
    'daily_cost_snapshot', 'daily_profit_summary',
    'stock_reconciliations', 'stock_reconciliation_items',
    'customer_payments', 'pv_types',
    'empty_returns', 'empty_return_items',
    // v1.1.2 added these tables but missed adding them here — routes querying
    // them with WHERE tenant_id = ? threw "no such column: tenant_id" → 500.
    'main_categories', 'units', 'stock_count_sessions', 'stock_count_items', 'quick_items',
    'cash_transfers',
    'supplier_credit_notes', 'supplier_credit_note_items',
    'capital_account', 'dividend_account',
    'shareholders', 'loans', 'loan_transactions',
    'discount_requests',
  ];

  const hasUpdatedAt = new Set([
    'users', 'products', 'customers', 'suppliers', 'business_settings', 'cash_reports',
    'daily_profit_summary',
  ]);

  for (const t of allTables) {
    addCol(t, 'sync_id',   'TEXT');
    addCol(t, 'tenant_id', 'TEXT');
    addCol(t, 'branch_id', 'TEXT');
    addCol(t, 'device_id', 'TEXT');
    addCol(t, 'deleted_at','TEXT');
    addCol(t, 'synced',    'INTEGER NOT NULL DEFAULT 0');
    addCol(t, 'created_at', 'TEXT');
    if (!hasUpdatedAt.has(t)) {
      addCol(t, 'updated_at', 'TEXT');
    }
  }

  // v1.8.98 — Change Price feature on existing DBs.
  addCol('discount_requests',  'new_price',         'REAL');
  addCol('discount_requests',  'change_reason',     'TEXT');

  addCol('stock_movements',    'reference_sync_id', 'TEXT');
  addCol('stock_movements',    'product_sync_id',   'TEXT');

  // v1.10.257 — cross-device ID mismatch fix for cash_reports cashier
  // filter. `cash_reports.cashier_id` stores the writing device's local
  // users.id, which sync copies verbatim → on other devices the same
  // integer resolves to a completely different user (or none). Add a
  // sync_id column so /cash-reports/users can JOIN portably.
  addCol('cash_reports', 'cashier_sync_id', 'TEXT');
  addCol('cash_reports', 'created_by_sync_id', 'TEXT');
  // Backfill: for rows where cashier_sync_id is NULL, look up the
  // user by the local cashier_id and copy their sync_id. This only
  // gives the CORRECT answer on the device that originally wrote
  // the row (where the integer id was valid). Wrong-mapped rows
  // pulled from other devices stay NULL and the LEFT JOIN drops
  // them from the dropdown — safer than showing a wrong name.
  try {
    db.exec(`
      UPDATE cash_reports
         SET cashier_sync_id = (SELECT sync_id FROM users WHERE users.id = cash_reports.cashier_id)
       WHERE cashier_sync_id IS NULL
         AND cashier_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM users WHERE users.id = cash_reports.cashier_id);
      UPDATE cash_reports
         SET created_by_sync_id = (SELECT sync_id FROM users WHERE users.id = cash_reports.created_by)
       WHERE created_by_sync_id IS NULL
         AND created_by IS NOT NULL
         AND EXISTS (SELECT 1 FROM users WHERE users.id = cash_reports.created_by);
    `);
  } catch (e) {
    console.warn('[migrations] cash_reports sync_id backfill:', e.message);
  }

  // v1.10.259 — same fix for the other 15 tables where an integer
  // created_by (and, on currency_exchanges, a cashier_id) was being
  // JOIN'd against users.id. Sweep pattern:
  //   1. addCol '${table}_created_by_sync_id' (TEXT, nullable)
  //   2. Backfill from local users where the integer id still resolves
  //      (correct on the writing device; NULL elsewhere — safer than
  //      wrong)
  //   3. Install an AFTER INSERT trigger so future writes auto-populate
  //      the sync_id from users at insert time — no route code changes
  //      needed for the ~30 INSERT sites across these 15 files.
  //   4. Sync-loop bypass: the pull-upsert sets created_by_sync_id
  //      explicitly from the incoming row → NEW.created_by_sync_id
  //      IS NOT NULL → trigger's WHEN guard skips it.
  const CREATED_BY_SYNC_TABLES = [
    'grn', 'siv', 'stock_adjustments', 'stock_reconciliations',
    'stock_count_sessions', 'empty_returns', 'supplier_credit_notes',
    'customer_payments', 'capital_account', 'dividend_account',
    'shareholders', 'loans', 'cash_transfers', 'currency_exchanges',
    'sales_returns',
    // v1.10.260 — payment_vouchers has integer cashier_id filtered in
    // cashReport.js:316; the created_by column is also used elsewhere.
    // Add both siblings so the filter works cross-device.
    'payment_vouchers',
  ];
  for (const t of CREATED_BY_SYNC_TABLES) {
    addCol(t, 'created_by_sync_id', 'TEXT');
  }
  addCol('currency_exchanges', 'cashier_sync_id', 'TEXT');
  // v1.10.260 — payment_vouchers also carries a cashier_id filter.
  addCol('payment_vouchers',   'cashier_sync_id', 'TEXT');

  // Backfill created_by_sync_id on legacy rows (writer-device rows).
  for (const t of CREATED_BY_SYNC_TABLES) {
    try {
      db.exec(`
        UPDATE ${t}
           SET created_by_sync_id = (SELECT sync_id FROM users WHERE users.id = ${t}.created_by)
         WHERE created_by_sync_id IS NULL
           AND created_by IS NOT NULL
           AND EXISTS (SELECT 1 FROM users WHERE users.id = ${t}.created_by);
      `);
    } catch (e) {
      console.warn(`[migrations] ${t} created_by_sync_id backfill:`, e.message);
    }
  }
  try {
    db.exec(`
      UPDATE currency_exchanges
         SET cashier_sync_id = (SELECT sync_id FROM users WHERE users.id = currency_exchanges.cashier_id)
       WHERE cashier_sync_id IS NULL AND cashier_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM users WHERE users.id = currency_exchanges.cashier_id);
    `);
  } catch (e) {
    console.warn('[migrations] currency_exchanges cashier_sync_id backfill:', e.message);
  }
  // v1.10.260 — payment_vouchers cashier_sync_id backfill.
  try {
    db.exec(`
      UPDATE payment_vouchers
         SET cashier_sync_id = (SELECT sync_id FROM users WHERE users.id = payment_vouchers.cashier_id)
       WHERE cashier_sync_id IS NULL AND cashier_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM users WHERE users.id = payment_vouchers.cashier_id);
    `);
  } catch (e) {
    console.warn('[migrations] payment_vouchers cashier_sync_id backfill:', e.message);
  }

  // Auto-populate on future INSERTs via trigger. Fires only when the
  // caller set created_by but left created_by_sync_id NULL — pull-upsert
  // sends both fields so the trigger skips (WHEN guard).
  for (const t of CREATED_BY_SYNC_TABLES) {
    try {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_${t}_stamp_created_by_sync_id
        AFTER INSERT ON ${t}
        FOR EACH ROW
        WHEN NEW.created_by IS NOT NULL AND NEW.created_by_sync_id IS NULL
        BEGIN
          UPDATE ${t}
             SET created_by_sync_id = (SELECT sync_id FROM users WHERE id = NEW.created_by)
           WHERE id = NEW.id;
        END;
      `);
    } catch (e) {
      console.warn(`[migrations] ${t} created_by_sync_id trigger:`, e.message);
    }
  }
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_currency_exchanges_stamp_cashier_sync_id
      AFTER INSERT ON currency_exchanges
      FOR EACH ROW
      WHEN NEW.cashier_id IS NOT NULL AND NEW.cashier_sync_id IS NULL
      BEGIN
        UPDATE currency_exchanges
           SET cashier_sync_id = (SELECT sync_id FROM users WHERE id = NEW.cashier_id)
         WHERE id = NEW.id;
      END;
    `);
  } catch (e) {
    console.warn('[migrations] currency_exchanges cashier_sync_id trigger:', e.message);
  }
  // v1.10.260 — payment_vouchers cashier_sync_id auto-stamp trigger.
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_payment_vouchers_stamp_cashier_sync_id
      AFTER INSERT ON payment_vouchers
      FOR EACH ROW
      WHEN NEW.cashier_id IS NOT NULL AND NEW.cashier_sync_id IS NULL
      BEGIN
        UPDATE payment_vouchers
           SET cashier_sync_id = (SELECT sync_id FROM users WHERE id = NEW.cashier_id)
         WHERE id = NEW.id;
      END;
    `);
  } catch (e) {
    console.warn('[migrations] payment_vouchers cashier_sync_id trigger:', e.message);
  }
  // v1.10.221 — event-level cost lock. Stamp the WAC live at the moment of
  // the movement (sale, sale_reverse, sales_return, transit_writeoff) so
  // profitHelper's COGS/damages queries can read the exact cost that was
  // true at the moment of the event, not whatever the current WAC happens
  // to be at recalc time. NULL for rows written before this column existed
  // (backfill script handles them). Ported from Redsea v1.13.49.
  addCol('stock_movements',    'cost_at_sale',      'REAL');
  // v1.10.221 — auto-stamp cost_at_sale on INSERT via SQL trigger so every
  // route that writes a cost-bearing movement (sale/sale_reverse/sales_return
  // /transit_writeoff) automatically freezes the live WAC without changing
  // any of the ~10 INSERT sites in orders.js / salesReturns.js / hqDamages.js
  // / hqGrns.js / hq.js. IF NEW.cost_at_sale IS NOT NULL the caller can still
  // override (backfill or explicit stamp). Fallback matches profitHelper:
  // p.avg_cost_price → p.cost_price → 0.
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_stamp_cost_at_sale
      AFTER INSERT ON stock_movements
      FOR EACH ROW
      WHEN NEW.cost_at_sale IS NULL
        AND NEW.product_sync_id IS NOT NULL
        AND NEW.movement_type IN ('sale', 'sale_reverse', 'sales_return', 'transit_writeoff')
      BEGIN
        UPDATE stock_movements
           SET cost_at_sale = (
             SELECT COALESCE(NULLIF(p.avg_cost_price, 0), NULLIF(p.cost_price, 0), 0)
             FROM products p
             WHERE p.sync_id = NEW.product_sync_id
             LIMIT 1
           )
         WHERE id = NEW.id;
      END;
    `);
  } catch (_) { /* trigger may already exist */ }
  addCol('grn_items',          'product_sync_id',   'TEXT');
  addCol('grn_items',          'grn_sync_id',       'TEXT');
  addCol('siv_items',          'product_sync_id',   'TEXT');
  addCol('siv_items',          'siv_sync_id',       'TEXT');
  addCol('order_items',        'product_sync_id',   'TEXT');
  addCol('order_items',        'order_sync_id',     'TEXT');
  addCol('production_inputs',  'product_sync_id',   'TEXT');
  addCol('production_inputs',  'production_sync_id','TEXT');
  addCol('production_outputs', 'product_sync_id',   'TEXT');
  addCol('production_outputs', 'production_sync_id','TEXT');
  addCol('sales_return_items', 'product_sync_id',   'TEXT');
  addCol('sales_return_items', 'return_sync_id',    'TEXT');
  addCol('stock_adjustments',  'product_sync_id',   'TEXT');
  addCol('grn_items',          'expiry_date',        'TEXT');
  // Multi-unit: track which unit the line was received/issued in (NULL = base unit, backward compat)
  addCol('grn_items',          'unit',               'TEXT');
  addCol('order_items',        'unit',               'TEXT');
  // Partial reversal: track how much of this line has been reversed cumulatively.
  // When reversed_quantity reaches the full line quantity, `reversed` is set to 1.
  addCol('order_items',        'reversed_quantity',  'REAL NOT NULL DEFAULT 0');
  // Per-unit discount (Kwacha off the unit selling price). Line total stored
  // as: quantity * (unit_price - discount). Default 0 = no discount.
  addCol('order_items',        'discount',           'REAL NOT NULL DEFAULT 0');
  addCol('siv_items',          'unit',               'TEXT');
  addCol('sales_return_items', 'unit',               'TEXT');
  addCol('products',           'category_sync_id',  'TEXT');
  // Multi-unit support — alt_unit + conversion + alt_price (Sosna feature)
  addCol('products',           'alt_unit',          'TEXT');
  addCol('products',           'conversion_factor', 'REAL');
  addCol('products',           'alt_price',         'REAL');
  // Customer credit (Sosna feature) — limit on outstanding, payment terms, hold flag
  addCol('customers',          'credit_limit',         'REAL NOT NULL DEFAULT 0');
  addCol('customers',          'payment_terms_days',   'INTEGER NOT NULL DEFAULT 0');
  addCol('customers',          'credit_status',        "TEXT NOT NULL DEFAULT 'Active'");
  // AR payments mint their own Cash Receipt voucher (standard accrual-to-cash entry).
  // The CR is linked back via this sync_id so edits/deletes cascade.
  addCol('customer_payments',  'cash_receipt_sync_id', 'TEXT');
  // Split payment-method amounts — a single AR/AP payment can be made with a
  // combination of Cash + Bank + Mobile Money. Total `amount` is the sum.
  // Legacy single-method rows get backfilled from the existing `payment_method` column.
  addCol('customer_payments',  'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.8.55 — triple-currency AR receipts (Sosna). cash_amount stays as
  // the dollar VALUE of the receipt (matches existing cash_receipts /
  // Cash Book aggregations). usd_amount is the physical USD portion;
  // fra_amount + k_amount are the foreign-currency portions; the
  // selling rates are snapshotted so historical receipts always reconcile.
  addCol('customer_payments',  'usd_amount',         'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'fra_amount',         'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'k_amount',           'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'selling_rate_used',  'REAL');
  addCol('customer_payments',  'selling_rate_k_used','REAL');
  addCol('ap_payments',        'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.10.78 — triple-currency columns on ap_payments so HQ can record
  // supplier payments in USD / FRA / K just like PV does. Legacy Liquor
  // branches keep using cash / bank / momo; the two sets coexist and
  // the Cash Book UNION reads whichever is populated.
  addCol('ap_payments',        'usd_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'fra_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'k_amount',   'REAL NOT NULL DEFAULT 0');
  // v1.10.79 — GRN cost currency. Every HQ-generated GRN mirrored into
  // sosna.db.grn carries the currency the invoice was denominated in
  // ('USD' | 'FRA' | 'K'). Nullable — legacy rows fall back to K in
  // display code. Same column on ap_payments' side (already covered by
  // usd_amount / fra_amount / k_amount split, no change needed).
  addCol('grn',                'cost_currency', 'TEXT');
  // Same split on cash_receipts + payment_vouchers — needed for the Cash Book
  // to show current balance per method (Cash / Bank / Mobile Money).
  addCol('cash_receipts',      'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.8.31 — triple-currency receipts. Same pattern as payment_vouchers
  // (see v1.8.5). One CR = one currency. Legacy cash/bank/momo kept for
  // back-compat; reads should prefer usd/fra/k via CASE WHEN.
  addCol('cash_receipts',      'usd_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'fra_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'k_amount',    'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.8.5 — triple-currency payment vouchers. Each in its own currency
  // (USD in $, FRA in FRA, K in K). Legacy cash/bank/momo kept at 0.
  addCol('payment_vouchers',   'usd_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'fra_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'k_amount',    'REAL NOT NULL DEFAULT 0');

  // v1.8.6 — currency_exchanges. Append-only ledger; mistakes corrected by
  // a reverse entry, never deleted (so deleted_at column omitted on purpose).
  //   scope='drawer' → cashier's till exchange (shown on Cash Report)
  //   scope='book'   → cash book / accounting ledger exchange (Cash Book tab)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS currency_exchanges (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id         TEXT UNIQUE,
      scope           TEXT NOT NULL CHECK (scope IN ('drawer','book')),
      date            TEXT NOT NULL,
      time            TEXT,
      from_currency   TEXT NOT NULL CHECK (from_currency IN ('USD','FRA','K')),
      from_amount     REAL NOT NULL,
      to_currency     TEXT NOT NULL CHECK (to_currency IN ('USD','FRA','K')),
      to_amount       REAL NOT NULL,
      rate            REAL,
      notes           TEXT,
      cashier_id      INTEGER REFERENCES users(id),
      created_by      INTEGER REFERENCES users(id),
      tenant_id       TEXT,
      branch_id       TEXT,
      device_id       TEXT,
      synced          INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_currency_exchanges_scope_date ON currency_exchanges(scope, date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_currency_exchanges_cashier ON currency_exchanges(scope, date, cashier_id)`).run();
  // v1.10.135 — K sub-method (Cash/Bank/MoMo) split on currency_exchanges.
  // Populated only when the corresponding side is K on HQ:
  //   from_method: 'Cash'|'Bank'|'Mobile Money' when from_currency='K', else NULL
  //   to_method  : same values when to_currency='K', else NULL
  // Used by the HQ Cash Book K-card sub-breakdown so exchanges (e.g. USD->K
  // to fund AP, or K->USD to bank surplus) attribute to the right K drawer.
  addCol('currency_exchanges', 'from_method', 'TEXT');
  addCol('currency_exchanges', 'to_method',   'TEXT');

  // v1.10.137 — cash_transfers gets a currency dimension so HQ can shift
  // K between its Cash/Bank/MoMo sub-drawers without polluting the USD
  // method-flow tracking. Legacy transfers default to 'USD' (Liquor/
  // Butchery behaviour); new HQ K-side transfers set currency='K' and
  // feed the kSubMethods block in cashBook.js.
  addCol('cash_transfers', 'currency', "TEXT NOT NULL DEFAULT 'USD'");
  // Invoice attachment — stored under uploads/invoices/. The column holds the
  // relative path (e.g. "invoices/grn_1700000000_abcd.pdf") so the same file
  // can be served from /uploads/<path> on any host.
  addCol('grn',                'invoice_attachment', 'TEXT');
  addCol('payment_vouchers',   'invoice_attachment', 'TEXT');
  addCol('ap_payments',        'invoice_attachment', 'TEXT');

  // ─────────────────────────────────────────────────────────────────────────
  // v1.9.7 — HQ-PO-linked GRN flow.
  // ─────────────────────────────────────────────────────────────────────────
  // Sosna's procurement model: HQ creates the PO (sosnazm.com/hq/purchases),
  // each line targets one branch. Branch sees the PO in their "Incoming"
  // queue and either rejects it OR clicks "Accept & Generate GRN" — which
  // opens a normal GRN form pre-filled with the PO number in notes. Branch
  // enters the invoice qty per line, attaches credit notes for any short/
  // damage/discount, and submits. The submitted GRN is NOT immediately
  // posted to stock — it waits for HQ to confirm. On HQ confirm, the
  // GRN's line items finally drive stock_movements at the branch (always
  // location='sales' for Sosna — no store layer) and HQ AP locks in.
  //
  // New columns on grn:
  //   linked_purchase_sync_id   — points at hq_purchases.sync_id when the
  //                               GRN was generated from a PO accept.
  //                               NULL for legacy / manual GRNs.
  //   linked_purchase_number    — denormalised PO# for display + receipt.
  //   hq_status                 — 'PENDING_HQ_CONFIRM' | 'CONFIRMED' |
  //                               'REJECTED' | NULL (legacy = no HQ gate)
  //   hq_confirmed_by/_name/_at — audit stamp for HQ confirmation.
  //   hq_reject_reason          — reason HQ sent the GRN back to branch.
  addCol('grn', 'linked_purchase_sync_id', 'TEXT');
  addCol('grn', 'linked_purchase_number',  'TEXT');
  addCol('grn', 'hq_status',               'TEXT');
  addCol('grn', 'hq_confirmed_by',         'INTEGER');
  addCol('grn', 'hq_confirmed_by_name',    'TEXT');
  addCol('grn', 'hq_confirmed_at',         'TEXT');
  addCol('grn', 'hq_reject_reason',        'TEXT');
  // v1.9.12 — supplier's printed invoice number captured at GRN time.
  // Mandatory on the branch-side GRN form so HQ sees what paper invoice
  // the purchase matched against when auditing AP.
  addCol('grn', 'supplier_invoice_number', 'TEXT');

  // v1.9.20 — supplier name copied from the HQ PO. Sosna branches no
  // longer maintain a supplier list (AP lives at HQ only), so the GRN
  // stores the supplier name as plain text rather than relying on a
  // local suppliers row. supplier_id may be NULL for HQ-linked GRNs.
  addCol('grn', 'supplier_name', 'TEXT');

  // v1.9.13 — GRN-scoped credit notes. supplier_credit_notes is the
  // existing master table; this new column ties each CN to the GRN it
  // belongs to so the GRN form can list / total CNs alongside line
  // items. NULL = standalone CN (legacy / not from a GRN).
  addCol('supplier_credit_notes', 'grn_sync_id', 'TEXT');

  // ── Single-location mode (Option 2: auto-SIV after each GRN) ────────────────
  // When ON, GRN saves trigger an auto-generated SIV that issues 100% of the receipt
  // to the sales counter, so a small one-room shop never has to do a manual SIV.
  // Default OFF — existing clients keep the dual-location flow.
  addCol('business_settings', 'single_location_mode', 'INTEGER NOT NULL DEFAULT 0');
  // Stock guard for POS: when 1, refuse to sell items with sales_balance<=0
  // and cap cart quantities at available stock. Default 0 — preserves the
  // long-standing behaviour of letting cashiers oversell when needed.
  addCol('business_settings', 'block_oversell',       'INTEGER NOT NULL DEFAULT 0');
  // Links each auto-SIV back to the GRN that triggered it. NULL for manually-created SIVs.
  // Bin Card uses it to render "from GRN-…" alongside the SIV reference.
  addCol('siv',               'source_grn_sync_id',   'TEXT');

  // ── Returnable container deposits (crates / bottles) ───────────────────────
  // Each beverage product can be linked to a separate "container" product (an empty crate)
  // that has its own stock and cost. When a GRN is saved, the cashier records how many
  // empties were returned to the supplier and how many new crates were received. The system
  // posts a stock movement for the container product and includes the net deposit cost in the
  // GRN total. Customers bring their own empties — POS is untouched.
  addCol('products',          'container_product_sync_id', 'TEXT');  // link to the matching empty-crate product
  addCol('products',          'units_per_container',       'REAL');  // e.g. 24 bottles per crate
  // Per-product preferred unit — auto-selected on GRN/SIV/POS lines instead of always defaulting to base unit.
  // Holds the unit name (must match one entry in units_json or the base `unit`). NULL = use base unit.
  addCol('products',          'default_unit',              'TEXT');
  addCol('business_settings', 'default_crate_deposit',     'REAL DEFAULT 57');
  // Per-line container settlement captured on each grn_items row.
  addCol('grn_items',         'containers_received',       'REAL NOT NULL DEFAULT 0');
  addCol('grn_items',         'containers_returned',       'REAL NOT NULL DEFAULT 0');
  addCol('grn_items',         'container_deposit',         'REAL NOT NULL DEFAULT 0');
  addCol('grn_items',         'container_product_sync_id', 'TEXT');

  // ── Empty Returns — supplier-side sync linking ────────────────────────────
  addCol('empty_returns',      'supplier_sync_id',        'TEXT');
  addCol('empty_return_items', 'empty_return_sync_id',    'TEXT');
  addCol('empty_return_items', 'product_sync_id',         'TEXT');
  // Legacy AP credit linking (pre-Phase-4A — kept so old rows still update/delete cleanly).
  addCol('empty_returns',      'ap_payment_sync_id',      'TEXT');
  // Phase 4A: new empty returns mint a Credit Note (reason='Crate Return') instead
  // of an ap_payment. The CN goes through the same supplier_credit_notes pipeline
  // as discounts, so AP balance + Profit Report stay consistent.
  addCol('empty_returns',      'credit_note_sync_id',     'TEXT');

  // ── Supplier Credit Notes — sync linking ──────────────────────────────────
  addCol('supplier_credit_notes',      'supplier_sync_id',     'TEXT');
  addCol('supplier_credit_note_items', 'credit_note_sync_id',  'TEXT');
  addCol('supplier_credit_note_items', 'product_sync_id',      'TEXT');
  // Multi-unit: track which unit the line was returned in (NULL = base unit).
  // unit_value is per chosen unit; quantity * unit_conv = base-unit quantity
  // that leaves stock via stock_movements.
  addCol('supplier_credit_note_items', 'unit',                 'TEXT');
  addCol('supplier_credit_note_items', 'unit_conv',            'REAL NOT NULL DEFAULT 1');

  // Profit Report: Supplier Rebates line. Only Discount + Other credit notes
  // count; Crate/Bottle returns are deposit refunds (not income).
  addCol('daily_profit_summary',       'supplier_rebates',     'REAL NOT NULL DEFAULT 0');
  // Profit Report: Interest Expense line — sum of loan_transactions
  // WHERE type='Interest'. Principal repayments and disbursements stay out.
  addCol('daily_profit_summary',       'interest_expense',     'REAL NOT NULL DEFAULT 0');

  // ── Equity / Liabilities — sync linking ───────────────────────────────────
  // Capital and Dividend entries get linked to a shareholder via sync_id, so
  // per-shareholder reporting works across devices regardless of integer ids.
  addCol('capital_account',  'shareholder_id',      'INTEGER');
  addCol('capital_account',  'shareholder_sync_id', 'TEXT');
  addCol('dividend_account', 'shareholder_id',      'INTEGER');
  addCol('dividend_account', 'shareholder_sync_id', 'TEXT');
  // Loan transactions point to their parent loan via sync_id (same pattern
  // as grn_items.grn_sync_id, siv_items.siv_sync_id, etc.).
  addCol('loan_transactions', 'loan_sync_id', 'TEXT');

  // ── Receipt printer configuration ───────────────────────────────────────────
  // USB mode: prints via the Windows Print Spooler queue named `receipt_printer_name`
  //           (the same queue you'd see in Windows → Devices and Printers).
  // LAN mode: opens a raw TCP socket to `receipt_printer_ip:receipt_printer_port` (default 9100).
  // Default `usb` keeps every existing tenant on the existing flow.
  addCol('business_settings', 'receipt_printer_type', "TEXT NOT NULL DEFAULT 'usb'");
  addCol('business_settings', 'receipt_printer_name', 'TEXT');
  addCol('business_settings', 'receipt_printer_ip',   'TEXT');
  addCol('business_settings', 'receipt_printer_port', 'INTEGER DEFAULT 9100');

  // ── Currencies (multi-currency display) ─────────────────────────────────────
  // JSON array of { code, symbol, is_primary }. The primary entry's symbol is used
  // everywhere prices show. Default backfill = one row, USD/$, marked primary —
  // identical to today's behavior for any tenant that hasn't configured anything.
  addCol('business_settings', 'currencies_json', 'TEXT');
  try {
    const defaultCurrencies = JSON.stringify([{ code: 'USD', symbol: '$', is_primary: true }]);
    db.prepare(`UPDATE business_settings SET currencies_json = ? WHERE currencies_json IS NULL OR currencies_json = ''`).run(defaultCurrencies);
  } catch { /* fresh DB — no row yet, defaults applied on first save */ }

  // ── Currency mode (per-branch UI gate) ─────────────────────────────────────
  // Switches dual-currency UI features on/off PER TENANT (which now maps to
  // PER BRANCH in the new subdomain-per-branch architecture):
  //   'K'       — Kwacha only. Standard flow. Used for lusaka1, mansa1.
  //   'USD+FRA' — Dual currency. Unlocks: sell/buy FX rates, dual-currency
  //               payment modal, USD+FRA receipt lines, FX columns on orders.
  //               Used for kasumbalesa1.
  // Default 'K' so every existing tenant keeps the same behaviour it has
  // today; only kasumbalesa1's tenant DB needs to flip the setting to
  // 'USD+FRA' (via Settings UI later, or one-off UPDATE for now).
  addCol('business_settings', 'currency_mode', "TEXT NOT NULL DEFAULT 'K'");

  // v1.10.179 — HQ Cash Book Phase 2 foundation: authoritative K-pool
  // counters. Instead of deriving the blended acquisition rate from
  // currency_exchanges history on every read (Phase 1.5), the pool state
  // lives on business_settings and gets maintained atomically by every
  // K-affecting endpoint (Phase 2b — write paths land in the next push).
  //
  //   pool_native_k    — K accumulated from customer sales (no USD cost)
  //   pool_exchange_k  — K acquired via USD→K exchanges, still in pool
  //   pool_usd_basis   — USD spent to acquire pool_exchange_k
  //   pool_backfilled_at — set once when the initial state is captured;
  //                        the migration checks this to guarantee the
  //                        backfill runs exactly once even if the app
  //                        restarts many times.
  //
  // Blended rate at any moment = pool_exchange_k / pool_usd_basis.
  // Total USD-equivalent of the K pool =
  //   pool_exchange_k / blended_rate  +  pool_native_k / today_market_rate.
  addCol('business_settings', 'pool_native_k',      'REAL NOT NULL DEFAULT 0');
  addCol('business_settings', 'pool_exchange_k',    'REAL NOT NULL DEFAULT 0');
  addCol('business_settings', 'pool_usd_basis',     'REAL NOT NULL DEFAULT 0');
  addCol('business_settings', 'pool_backfilled_at', 'TEXT');

  // v1.10.182 — Landed Cost Voucher (LCV) support.
  // An LCV is a Payment Voucher tagged as delivery / transport / customs
  // cost that attaches to a specific HQ purchase. Cash STILL leaves the
  // Cash Book (transporter is paid), but the amount is absorbed into the
  // destination branch's WAC via the linked PO instead of hitting P&L
  // as an expense. Prevents the double-counting trap where delivery
  // shows up both in COGS (via WAC) AND as a period expense.
  //
  //   is_landed_cost           — 1 if this PV is delivery/landed cost, 0 otherwise
  //   linked_purchase_sync_id  — HQ purchase.sync_id this landed cost attaches to
  //   applied_to_grn_sync_id   — set on Generate GRN; NULL means not yet consumed.
  //                              Prevents double-application if the GRN reruns.
  addCol('payment_vouchers', 'is_landed_cost',           'INTEGER NOT NULL DEFAULT 0');
  addCol('payment_vouchers', 'linked_purchase_sync_id',  'TEXT');
  addCol('payment_vouchers', 'applied_to_grn_sync_id',   'TEXT');
  // v1.10.185 — LCV can also attach to an inter-branch transfer.
  // Transfers between branches also carry delivery cost (truck from
  // Kassumbalesa to Lusaka). Same absorption model as PO-linked LCVs,
  // just applied at transfers.js /receive time instead of Generate GRN.
  addCol('payment_vouchers', 'linked_transfer_sync_id',   'TEXT');
  addCol('payment_vouchers', 'applied_to_transfer_sync_id','TEXT');

  // v1.10.179 — one-shot backfill for the K-pool counters.
  // Idempotent via pool_backfilled_at: once set, this whole block is a
  // no-op on subsequent app restarts. Safe to keep in migrations forever.
  //
  // The backfill captures a snapshot of what's derivable from history:
  //   pool_exchange_k = SUM(K received from USD→K exchanges) − SUM(K sold in K→USD)
  //   pool_usd_basis  = SUM(USD spent on USD→K exchanges) − pro-rata drain
  //                     for K→USD outflows
  //   pool_native_k   = 0
  //
  // The native counter starts at 0 because we can't cheaply reconstruct
  // how much of the historical native-K inflow is still sitting in the
  // pool vs. how much has been spent. Once Phase 2b write paths land, the
  // counter grows correctly from every new CR/PV/AP. In the meantime the
  // Cash Book read logic (v1.10.178) continues to derive the native
  // portion from the current K balance minus the pool_exchange_k, so the
  // tile stays correct even before the writes are hooked up.
  try {
    const settingsRow = db.prepare(
      `SELECT id, pool_backfilled_at, tenant_id FROM business_settings ORDER BY id ASC LIMIT 1`
    ).get();
    if (settingsRow && !settingsRow.pool_backfilled_at) {
      const tenantId = settingsRow.tenant_id;
      // USD→K side: cumulative inflow of exchange K and its USD cost.
      const usdToK = db.prepare(`
        SELECT COALESCE(SUM(to_amount), 0)   AS total_k,
               COALESCE(SUM(from_amount), 0) AS total_usd
        FROM currency_exchanges
        WHERE tenant_id = ? AND scope = 'book'
          AND from_currency = 'USD' AND to_currency = 'K'
      `).get(tenantId);
      // K→USD side: how much of the exchange K was later converted back.
      const kToUsd = db.prepare(`
        SELECT COALESCE(SUM(from_amount), 0) AS total_k
        FROM currency_exchanges
        WHERE tenant_id = ? AND scope = 'book'
          AND from_currency = 'K' AND to_currency = 'USD'
      `).get(tenantId);
      const totalInflowK  = parseFloat(usdToK.total_k)   || 0;
      const totalInflowUsd= parseFloat(usdToK.total_usd) || 0;
      const totalOutflowK = parseFloat(kToUsd.total_k)   || 0;
      const netExchangeK = Math.max(0, totalInflowK - totalOutflowK);
      // Pro-rata the USD basis to the remaining exchange K
      const netUsdBasis = totalInflowK > 0
        ? totalInflowUsd * (netExchangeK / totalInflowK)
        : 0;
      db.prepare(`
        UPDATE business_settings
           SET pool_native_k      = 0,
               pool_exchange_k    = ?,
               pool_usd_basis     = ?,
               pool_backfilled_at = datetime('now')
         WHERE id = ?
      `).run(netExchangeK, netUsdBasis, settingsRow.id);
      const blended = netUsdBasis > 0 ? (netExchangeK / netUsdBasis).toFixed(4) : 'n/a';
      console.log(`[cash-pool backfill] exchange_K=${netExchangeK}, usd_basis=$${netUsdBasis.toFixed(2)}, blended=${blended}`);
    }
  } catch (e) {
    console.warn('[cash-pool backfill] skipped:', e.message);
  }

  // v1.10.193 — REMOVED the v1.10.190 Liquor PV sub-drawer backfill.
  // Root cause fixed in v1.10.190 (PaymentVoucherFormModal + backend
  // paymentVouchers). Leaving the backfill in would silently mirror any
  // future regression on every restart, hiding it from Cash Book — same
  // failure pattern as the v1.8.68 usd_change_given backfill deleted in
  // v1.10.109. If a legacy row is still miscoloured, run the one-off
  // repair manually.

  // Multi-unit support — JSON array of { name, conv, price, is_base } stored on the product.
  // The base unit (conv=1) is always the smallest packaging (e.g. PCS for sosna).
  // Other rows are larger packagings: { name:"Box", conv:24, price:40 } means 1 box = 24 base units.
  // Legacy fields (unit, alt_unit, conversion_factor, alt_price) remain populated for backward
  // compatibility; units_json is the new source of truth for the unit picker everywhere.
  addCol('products',           'units_json',         'TEXT');
  try {
    const productsForUnits = db.prepare(
      `SELECT id, unit, alt_unit, conversion_factor, selling_price, alt_price
       FROM products WHERE deleted_at IS NULL AND (units_json IS NULL OR units_json = '')`
    ).all();
    const updUnits = db.prepare('UPDATE products SET units_json = ? WHERE id = ?');
    for (const p of productsForUnits) {
      const baseUnit = (p.unit || 'pcs').trim();
      const arr = [{ name: baseUnit, conv: 1, price: parseFloat(p.selling_price || 0), is_base: true }];
      const alt = (p.alt_unit || '').trim();
      if (alt && parseFloat(p.conversion_factor || 0) > 0) {
        arr.push({ name: alt, conv: parseFloat(p.conversion_factor), price: parseFloat(p.alt_price || 0), is_base: false });
      }
      updUnits.run(JSON.stringify(arr), p.id);
    }
  } catch (e) { /* fresh DB or no products — fine */ }
  // Backfill CR splits from payment_method
  try {
    db.prepare(`
      UPDATE cash_receipts
      SET cash_amount = CASE WHEN payment_method = 'Cash' THEN amount ELSE 0 END,
          bank_amount = CASE WHEN payment_method IN ('Bank Transfer','Bank','Cheque') THEN amount ELSE 0 END,
          momo_amount = CASE WHEN payment_method = 'Mobile Money' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
        AND payment_method != 'Mixed'
    `).run();
    // Mixed CRs (AR payments) — pull split from the linked customer_payments row
    db.prepare(`
      UPDATE cash_receipts
      SET cash_amount = (SELECT cp.cash_amount FROM customer_payments cp WHERE cp.id = cash_receipts.source_customer_payment_id),
          bank_amount = (SELECT cp.bank_amount FROM customer_payments cp WHERE cp.id = cash_receipts.source_customer_payment_id),
          momo_amount = (SELECT cp.momo_amount FROM customer_payments cp WHERE cp.id = cash_receipts.source_customer_payment_id)
      WHERE payment_method = 'Mixed' AND source_customer_payment_id IS NOT NULL
    `).run();
    // Backfill PV splits from paid_from (best-effort heuristic)
    db.prepare(`
      UPDATE payment_vouchers
      SET cash_amount = CASE WHEN paid_from LIKE '%Cash%' OR paid_from LIKE '%Drawer%' OR paid_from IS NULL THEN amount ELSE 0 END,
          bank_amount = CASE WHEN paid_from LIKE '%Bank%' OR paid_from LIKE '%Cheque%' THEN amount ELSE 0 END,
          momo_amount = CASE WHEN paid_from LIKE '%Mobile%' OR paid_from LIKE '%MoMo%' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
    `).run();
  } catch (e) { /* ignore */ }
  // Backfill: slot the legacy single amount into the right bucket based on payment_method/paid_from.
  try {
    db.prepare(`
      UPDATE customer_payments
      SET cash_amount = CASE WHEN payment_method IN ('Cash', '') OR payment_method IS NULL THEN amount ELSE 0 END,
          bank_amount = CASE WHEN payment_method IN ('Bank Transfer', 'Bank', 'Cheque') THEN amount ELSE 0 END,
          momo_amount = CASE WHEN payment_method = 'Mobile Money' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
    `).run();
    db.prepare(`
      UPDATE ap_payments
      SET cash_amount = CASE WHEN paid_from LIKE '%Cashier%' OR paid_from LIKE '%Cash%' OR paid_from IS NULL THEN amount ELSE 0 END,
          bank_amount = CASE WHEN paid_from LIKE '%Bank%' OR paid_from LIKE '%Cheque%' THEN amount ELSE 0 END,
          momo_amount = CASE WHEN paid_from LIKE '%Mobile%' OR paid_from LIKE '%MoMo%' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
    `).run();
  } catch (e) { /* ignore */ }
  // Mark CRs that originated from an AR payment so the Cash Receipt list can show
  // their source and we don't risk minting a duplicate on re-runs.
  addCol('cash_receipts',      'source_type',            'TEXT');
  addCol('cash_receipts',      'source_customer_payment_id', 'INTEGER');

  // Backfill: any existing customer_payment without a linked CR gets one minted.
  // This is the one-time migration when switching to the "CR per AR payment" model.
  // Uses a self-contained, collision-proof receipt number scheme so we don't depend
  // on syncConfig (which may not be initialised yet during DB bootstrap).
  try {
    const orphans = db.prepare(`
      SELECT cp.id, cp.amount, cp.payment_date, cp.payment_method, cp.reference, cp.notes,
             cp.created_by, cp.tenant_id, cp.branch_id, cp.device_id,
             c.name AS customer_name
      FROM customer_payments cp
      LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE cp.deleted_at IS NULL AND (cp.cash_receipt_sync_id IS NULL OR cp.cash_receipt_sync_id = '')
    `).all();
    if (orphans.length > 0) {
      const { randomUUID } = require('crypto');
      db.transaction(() => {
        for (const p of orphans) {
          // Use the customer_payment.id as a stable, unique suffix — guaranteed
          // collision-proof against itself and unlikely to clash with normal CRs
          // (which use the seq-based scheme).
          const receiptNum = `CR-BACKFILL-${String(p.id).padStart(6, '0')}`;
          const crSyncId = randomUUID();
          db.prepare(`
            INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount, date,
                                       created_by, sync_id, tenant_id, branch_id, device_id, synced,
                                       source_type, source_customer_payment_id,
                                       created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,datetime('now'),datetime('now'))
          `).run(
            receiptNum,
            p.customer_name || 'Customer',
            p.notes ? `AR Payment — ${p.notes}` : 'AR Payment',
            p.payment_method || 'Cash',
            parseFloat(p.amount),
            p.payment_date,
            p.created_by,
            crSyncId, p.tenant_id, p.branch_id, p.device_id,
            'ar_payment', p.id
          );
          db.prepare(`UPDATE customer_payments SET cash_receipt_sync_id = ?, synced = 0 WHERE id = ?`)
            .run(crSyncId, p.id);
        }
      })();
    }
  } catch (e) { console.error('[migrations] AR payment CR backfill failed:', e.message); }
  // Link orders to a specific customer record (prevents same-name customers sharing balances).
  // Legacy orders carry NULL — user has to claim them via the "Claim orphan orders" action.
  addCol('orders',             'customer_id',          'INTEGER');
  addCol('orders',             'customer_sync_id',     'TEXT');
  // Split payment methods on the order itself. amount_received remains the sum;
  // these break it down so the Cash Report can show Cash / MoMo / Bank separately.
  addCol('orders',             'cash_received',        'REAL NOT NULL DEFAULT 0');
  addCol('orders',             'momo_received',        'REAL NOT NULL DEFAULT 0');
  addCol('orders',             'bank_received',        'REAL NOT NULL DEFAULT 0');
  // v1.10.193 — REMOVED two backfills that ran on every restart:
  //   (a) legacy payment_method → cash_received/momo_received/bank_received
  //   (b) orders → customer_id auto-link by unambiguous name
  // Both would silently mutate NEW data if a future write path missed the
  // per-currency buckets or if a new customer was later added with the
  // same name as an old unlinked order. The initial run already applied
  // for every deployed DB; if a truly-legacy row still needs seeding, do
  // it via a one-off repair.
  addCol('grn',                'supplier_sync_id',  'TEXT');
  addCol('ap_payments',        'supplier_sync_id',  'TEXT');
  addCol('daily_actual_balance','product_sync_id',  'TEXT');
  addCol('daily_profit_summary','stock_adj',        'REAL NOT NULL DEFAULT 0');
  // Sales Damages — items destroyed/expired, cost subtracted from gross profit.
  addCol('daily_profit_summary','damages',          'REAL NOT NULL DEFAULT 0');

  // ── Parity with server.js addCol calls that were missing here ──────────────
  // These were added in server.js (Electron default DB) but never to initTenantDb.
  // The first one — categories.main_category_id — is what was crashing /api/products
  // on web tenants ("no such column: c.main_category_id"). Adding the rest as a
  // single audit so we stop chasing them one at a time.
  addCol('categories',     'main_category_id',      'INTEGER');
  addCol('categories',     'main_category_sync_id', 'TEXT');
  addCol('products',       'product_type',          "TEXT NOT NULL DEFAULT 'finished'");
  addCol('cash_reports',   'cashier_id',            'INTEGER DEFAULT 0');
  addCol('cash_reports',   'bank',                  'REAL NOT NULL DEFAULT 0');
  // v1.8.1 — triple-currency cash report. Each holds the NET cash in that
  // currency (received minus change given), in that currency's own units.
  addCol('cash_reports',   'usd_received',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'fra_received',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'k_received',            'REAL NOT NULL DEFAULT 0');
  // v1.8.13 — per-currency Expected snapshot at save time. The difference
  // per currency = received - expected, computed at read. Stored so the
  // history shows what the POS said vs what the cashier counted, even if
  // the order table changes later (reversals, edits, etc.).
  addCol('cash_reports',   'usd_expected',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'fra_expected',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'k_expected',            'REAL NOT NULL DEFAULT 0');
  // v1.8.26 — per-currency expenses snapshot at save time so the history
  // table can show what was paid out of each currency's drawer for that
  // shift without re-querying payment_vouchers per row.
  addCol('cash_reports',   'usd_expenses',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'fra_expenses',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'k_expenses',            'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers','cashier_id',           'INTEGER DEFAULT 0');
  addCol('siv',            'production_id',         'INTEGER');
  addCol('siv',            'production_sync_id',    'TEXT');

  try {
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dab_product_sync_date ON daily_actual_balance (product_sync_id, date)`).run();
  } catch (_) {}

  try {
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dcs_product_sync_date ON daily_cost_snapshot (product_sync_id, date)`).run();
  } catch (_) {}

  // ─── Indexes on sync_id for every sync table ───────────────────────────────
  // Sync push/pull does WHERE sync_id = ? on every row. Without these indexes,
  // every lookup is a full table scan — Mother freezes under load with big tables.
  const SYNC_TABLES = [
    'users', 'categories', 'main_categories', 'units', 'products', 'customers', 'suppliers',
    'orders', 'order_items', 'grn', 'grn_items', 'siv', 'siv_items',
    'production', 'production_inputs', 'production_outputs',
    'sales_returns', 'sales_return_items',
    'stock_movements', 'cash_receipts', 'payment_vouchers', 'cash_book',
    'business_settings', 'cash_reports', 'stock_adjustments', 'daily_actual_balance',
    'ap_payments', 'daily_profit_summary',
    // v1.8.33 — newer tables that participate in sync. Without these
    // index entries Mother does full-table scans on big sync push/pull.
    'customer_payments', 'stock_reconciliations', 'stock_reconciliation_items',
    'supplier_credit_notes', 'supplier_credit_note_items',
    'capital_account', 'dividend_account', 'shareholders', 'loans', 'loan_transactions',
    'cash_transfers', 'stock_count_sessions', 'stock_count_items',
    'discount_requests', 'pv_types',
    'branches', 'product_branch_prices',
    'currency_exchanges', 'fx_rates',
  ];
  for (const t of SYNC_TABLES) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (cols.includes('sync_id')) {
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_${t}_sync_id ON ${t} (sync_id)`).run();
      }
      if (cols.includes('tenant_id') && cols.includes('updated_at')) {
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_${t}_tenant_updated ON ${t} (tenant_id, updated_at)`).run();
      }
    } catch (_) {}
  }

  // No default admin — the Setup screen creates the real admin during registration

  // ─── One-time cleanup: remove daily_profit_summary rows with malformed date (timestamp instead of YYYY-MM-DD)
  // Caused by an old bug in order reverse where `created_at.split('T')[0]` returned the full SQLite timestamp.
  try {
    db.prepare(`DELETE FROM daily_profit_summary WHERE length(date) > 10`).run();
  } catch (_) {}

  // ─── One-time cleanup: recompute cost_at_count on existing stock_reconciliation_items.
  // Earlier rows used an un-converted avg from grn_items (mixed pcs/box totals) — yielding cost per box
  // when it should have been per base unit. This makes variance_value correct on rows posted before the fix.
  try {
    const { baseQtyExpr: _bq } = require('./unitsHelper');
    const fixedAvgCostSubquery = `
      SELECT CASE WHEN COALESCE(SUM(${_bq('gp', 'gi')}), 0) > 0
             THEN ROUND(SUM(gi.total_price) / SUM(${_bq('gp', 'gi')}), 4)
             ELSE 0 END AS avg_cost
      FROM grn_items gi
      LEFT JOIN products gp ON gp.sync_id = gi.product_sync_id
      WHERE gi.product_sync_id = ? AND gi.deleted_at IS NULL
    `;
    const items = db.prepare(`SELECT id, product_sync_id FROM stock_reconciliation_items WHERE deleted_at IS NULL`).all();
    const fixStmt = db.prepare(`UPDATE stock_reconciliation_items SET cost_at_count = ? WHERE id = ?`);
    for (const it of items) {
      const row = db.prepare(fixedAvgCostSubquery).get(it.product_sync_id);
      const newCost = parseFloat(row?.avg_cost || 0);
      if (newCost > 0) fixStmt.run(newCost, it.id);
    }
  } catch (_) {}

  // v1.10.193 — REMOVED (see also the deleted one earlier in this file).
  // Second, near-duplicate copy of the orders → customer_id auto-link
  // backfill. Same reason for removal: on every restart it would guess
  // and could wrongly link a newly-added same-named customer to an old
  // sale. Use the merge tool for legacy fix-ups.

  // ── Cash Reports per-cashier migration ────────────────────────────────────
  // The original schema had UNIQUE on the `date` column alone, which blocked
  // a second cashier from saving their own Cash Report for the same day
  // (only one row per date could exist across all cashiers). This block
  // detects a tenant DB carrying the old date-only UNIQUE index and
  // rewrites the table without it, then creates a composite
  // UNIQUE(date, cashier_id) index. Mirrors the same migration that's in
  // server.js for Electron default DBs. Idempotent — no-op after first run.
  try {
    const idxList = db.prepare("PRAGMA index_list('cash_reports')").all();
    const hasDateOnlyUnique = idxList.some(idx => {
      if (!idx.unique) return false;
      const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
      return cols.length === 1 && cols[0].name === 'date';
    });
    if (hasDateOnlyUnique) {
      db.exec(`
        CREATE TABLE cash_reports_migrated (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          date           TEXT NOT NULL,
          initial_change REAL DEFAULT 0,
          mobile_money   REAL DEFAULT 0,
          cash           REAL DEFAULT 0,
          bank           REAL DEFAULT 0,
          expenses       REAL DEFAULT 0,
          pending        REAL DEFAULT 0,
          total          REAL DEFAULT 0,
          after_change   REAL DEFAULT 0,
          expected       REAL DEFAULT 0,
          difference     REAL DEFAULT 0,
          status         TEXT,
          comment        TEXT,
          created_by     INTEGER REFERENCES users(id),
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
          sync_id        TEXT,
          tenant_id      TEXT,
          branch_id      TEXT,
          device_id      TEXT,
          deleted_at     TEXT,
          synced         INTEGER NOT NULL DEFAULT 0,
          cashier_id     INTEGER DEFAULT 0
        );
        INSERT INTO cash_reports_migrated
          SELECT id, date, initial_change, mobile_money, cash,
                 COALESCE(bank, 0), expenses, pending, total,
                 after_change, expected, difference, status, comment, created_by,
                 created_at, updated_at, sync_id, tenant_id, branch_id, device_id,
                 deleted_at, COALESCE(synced, 0), COALESCE(cashier_id, 0)
          FROM cash_reports;
        DROP TABLE cash_reports;
        ALTER TABLE cash_reports_migrated RENAME TO cash_reports;
      `);
    }
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_reports_date_cashier ON cash_reports(date, cashier_id)`).run();
  } catch (_) { /* migration is idempotent and best-effort */ }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1 — Multi-currency, per-branch
  // ─────────────────────────────────────────────────────────────────────────
  // Sosna runs three branches with different currency setups:
  //   • Branch 1 & 2 (K-only)         — single-currency, behaves like Liquor
  //   • Branch 3     (USD + FRA)      — Sirak-POS-style dual-currency at POS
  //
  // Naming uses the SHOP-side convention (matches Sirak-POS):
  //   • selling_rate — used when shop RECEIVES FRA from customer.
  //                    paidFRA_as_primary = paidFRA / selling_rate
  //   • buying_rate  — used when shop GIVES FRA back as change.
  //                    changeFRA = changePrimary × buying_rate
  //
  // Spread `selling_rate − buying_rate` per primary unit = FX margin for shop.
  // (Branch 3 default seed: selling 2,900  buying 2,600  →  300 FRA / USD margin)
  //
  // Orders snapshot the rates used at sale time so historical receipts always
  // reproduce, even when admin updates the rates later. K-only branches leave
  // the FRA fields at zero.
  try {
    // Branches — meta info about each physical location. The `id` here is
    // the same TEXT UUID the sync layer already stamps on rows as branch_id.
    db.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        primary_currency   TEXT NOT NULL DEFAULT 'K',
        secondary_currency TEXT,
        selling_rate       REAL,
        buying_rate        REAL,
        status             TEXT NOT NULL DEFAULT 'Active',
        sync_id            TEXT,
        tenant_id          TEXT,
        device_id          TEXT,
        synced             INTEGER NOT NULL DEFAULT 0,
        deleted_at         TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Per-branch product price overrides. When a row exists for a given
    // (product_id, branch_id) pair, POS / receipts at that branch use these
    // values instead of products.cost_price / products.selling_price. When
    // missing, the fallback is the legacy single-price columns — so Branches
    // 1 & 2 keep working without any data entry.
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_branch_prices (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        product_sync_id TEXT,
        branch_id       TEXT NOT NULL,
        cost_price      REAL NOT NULL DEFAULT 0,
        selling_price   REAL NOT NULL DEFAULT 0,
        currency        TEXT NOT NULL DEFAULT 'K',
        sync_id         TEXT,
        tenant_id       TEXT,
        device_id       TEXT,
        synced          INTEGER NOT NULL DEFAULT 0,
        deleted_at      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(product_id, branch_id)
      )
    `);
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pbp_product ON product_branch_prices(product_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pbp_branch  ON product_branch_prices(branch_id)`).run();

    // ── Orders: frozen FX snapshot + FRA payment buckets ──────────────────
    // currency           = the branch's primary at sale time ('K' or 'USD')
    // fra_received       = how much FRA the cashier physically took
    // fra_change_given   = how much FRA the cashier physically returned
    // selling_rate_used  = FRA→primary rate frozen at sale  (used for receive)
    // buying_rate_used   = primary→FRA rate frozen at sale  (used for change)
    addCol('orders', 'currency',          "TEXT DEFAULT 'K'");
    addCol('orders', 'fra_received',      'REAL DEFAULT 0');
    addCol('orders', 'fra_change_given',  'REAL DEFAULT 0');
    addCol('orders', 'selling_rate_used', 'REAL');
    addCol('orders', 'buying_rate_used',  'REAL');

    // ── Seed Sosna's three branches the first time the table is empty ──────
    // Idempotent: re-running this migration does nothing once rows exist.
    // The IDs are stable UUIDs derived from sync-friendly randomness; the
    // existing device's sync_config.branch_id may point at a different UUID
    // — that's fine, we leave that untouched and the device can be assigned
    // to a branch later through the Settings UI (Phase 2).
    const branchCount = db.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
    if (branchCount === 0) {
      const tenantRow = db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get();
      const tenantId  = tenantRow ? tenantRow.value : null;
      const ins = db.prepare(`
        INSERT INTO branches (id, name, primary_currency, secondary_currency,
                              selling_rate, buying_rate, sync_id, tenant_id, synced)
        VALUES (?,?,?,?,?,?,?,?,0)
      `);
      const u = () => crypto.randomUUID();
      ins.run(u(), 'Branch 1',  'K',   null,  null,  null,  u(), tenantId);
      ins.run(u(), 'Branch 2',  'K',   null,  null,  null,  u(), tenantId);
      ins.run(u(), 'Branch 3',  'USD', 'FRA', 2900,  2600,  u(), tenantId);
    }
  } catch (e) {
    console.error('[migrations] phase-1 multi-currency failed:', e.message);
    // best-effort; later phases can re-attempt
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3-Station workflow (Sales → Cashier → Dispatch)
  // ─────────────────────────────────────────────────────────────────────────
  // Per-branch UI gate that swaps the single-screen POS for a 3-station flow
  // used at kasumbalesa1:
  //   'single_pos'    — one cashier creates + pays + dispatches in one step
  //                     (lusaka1, mansa1 — existing behaviour).
  //   'three_station' — Sales creates the order → Cashier collects payment →
  //                     Dispatch releases goods. Each station is a separate
  //                     screen; orders move through a status state machine.
  //
  // orders.status values used in this flow:
  //   'PENDING_PAYMENT' — Sales confirmed; awaiting Cashier
  //   'PAID'            — Cashier collected; awaiting Dispatch
  //   'DISPATCHED'      — Goods released; stock decremented HERE (not at sale)
  //   'CANCELLED'       — Voided at any stage
  //   NULL              — Legacy single_pos completed sale (unchanged)
  addCol('business_settings', 'workflow_mode', "TEXT NOT NULL DEFAULT 'single_pos'");
  addCol('orders', 'sales_user_id',    'INTEGER');
  addCol('orders', 'cashier_user_id',  'INTEGER');
  addCol('orders', 'dispatch_user_id', 'INTEGER');
  addCol('orders', 'sales_at',         'TEXT');
  addCol('orders', 'paid_at',          'TEXT');
  addCol('orders', 'dispatched_at',    'TEXT');

  // ─────────────────────────────────────────────────────────────────────────
  // v1.9.1 — cross-device cashier-name fix.
  // ─────────────────────────────────────────────────────────────────────────
  // orders.created_by / cashier_user_id / sales_user_id / dispatch_user_id
  // all stored the LOCAL users.id (INTEGER AUTOINCREMENT per DB). When an
  // order pushed from Electron to VPS, the integer was copied as-is — but
  // users.id=4 on Electron rarely matches users.id=4 on VPS, so the receipt
  // JOIN on the OTHER side picked whoever happened to occupy that id. Real
  // incident: Electron showed cashier "milan milan" while web showed the
  // SAME order's cashier as "Yonas Yonas". Confirmed via SQL: Electron
  // milan=id4, VPS milan=id2; Electron yonas=id2, VPS yonas=id4.
  //
  // Fix: store users.sync_id (UUID) in parallel mirror columns. Backfill
  // existing rows from the local users table at boot — pre-fix rows that
  // arrived via cross-device push may resolve to the wrong sync_id on this
  // side (no way to recover original creator), but new rows going forward
  // get stamped by the source device, so the JOIN always finds the right
  // user no matter which DB is reading.
  addCol('orders', 'created_by_sync_id',   'TEXT');
  addCol('orders', 'cashier_user_sync_id', 'TEXT');
  addCol('orders', 'sales_user_sync_id',   'TEXT');
  addCol('orders', 'dispatch_user_sync_id','TEXT');
  // Backfill from local users table — runs once per row (skips already-filled).
  try {
    db.prepare(`UPDATE orders SET created_by_sync_id    = (SELECT sync_id FROM users WHERE id = orders.created_by)     WHERE created_by_sync_id    IS NULL AND created_by     IS NOT NULL`).run();
    db.prepare(`UPDATE orders SET cashier_user_sync_id  = (SELECT sync_id FROM users WHERE id = orders.cashier_user_id) WHERE cashier_user_sync_id  IS NULL AND cashier_user_id  IS NOT NULL`).run();
    db.prepare(`UPDATE orders SET sales_user_sync_id    = (SELECT sync_id FROM users WHERE id = orders.sales_user_id)   WHERE sales_user_sync_id    IS NULL AND sales_user_id    IS NOT NULL`).run();
    db.prepare(`UPDATE orders SET dispatch_user_sync_id = (SELECT sync_id FROM users WHERE id = orders.dispatch_user_id) WHERE dispatch_user_sync_id IS NULL AND dispatch_user_id IS NOT NULL`).run();
  } catch (e) { /* tolerate empty users table on a fresh DB */ }

  // ─────────────────────────────────────────────────────────────────────────
  // v1.3.1 — Sales Damages state machine
  // ─────────────────────────────────────────────────────────────────────────
  // Spec: branches can only declare damages; HQ must confirm before the
  // sales-floor stock is decremented + the damages cost flows into
  // daily_profit_summary.damages. This keeps fraud / data-entry mistakes
  // off the books until HQ has eyes on them.
  //
  // Status enum on sales_returns:
  //   PENDING   — branch declared, awaiting HQ confirmation, no stock yet
  //   CONFIRMED — HQ approved, stock decremented + profit recalculated
  //   REJECTED  — HQ rejected with confirm_notes explaining why
  //
  // Default is 'CONFIRMED' so EXISTING legacy rows stay marked
  // already-actioned (they already created their stock_movements). New
  // rows from v1.3.1+ are written as PENDING by the POST endpoint.
  addCol('sales_returns', 'status',            "TEXT NOT NULL DEFAULT 'CONFIRMED'");
  addCol('sales_returns', 'confirmed_by',      'INTEGER');
  addCol('sales_returns', 'confirmed_by_name', 'TEXT');
  addCol('sales_returns', 'confirmed_at',      'TEXT');
  addCol('sales_returns', 'confirm_notes',     'TEXT');

  // v1.3.9 — per-branch toggle that re-enables the legacy GRN + Suppliers
  // sidebar entries (otherwise hidden on branches by v1.3.2's lockdown).
  // Use case: seeding initial stock at a freshly-deployed branch before
  // the HQ Procurement loop is producing receipts, or one-off rescues.
  // OFF by default — only branches that flip this ON see the legacy
  // pages. HQ host always sees them regardless of this flag.
  addCol('business_settings', 'legacy_procurement_enabled', 'INTEGER NOT NULL DEFAULT 0');

  // v1.9.26 — payment_methods is the third independent dial alongside
  // currency_mode + workflow_mode. 'cash_only' = Sosna 3-currency cash
  // branches (no MoMo, no Bank). 'cash_momo_bank' = Liquor-style
  // branches that take Cash + MoMo + Bank. Default cash_momo_bank so
  // existing tenants keep their current Pay-modal behaviour.
  addCol('business_settings', 'payment_methods', "TEXT NOT NULL DEFAULT 'cash_momo_bank'");

  // ─────────────────────────────────────────────────────────────────────────
  // v1.4.0 — FX Rates (Accounting → Currency Rates)
  // ─────────────────────────────────────────────────────────────────────────
  // Per-branch history of USD ↔ FRA rates. Cashier reads the latest row
  // where effective_date <= today AND deleted_at IS NULL; receipts replay
  // with the rate snapshotted on the order (selling_rate_used /
  // buying_rate_used columns added back in Phase 1) so old prints stay
  // accurate even after the manager updates the rate.
  //
  // Only used by branches with currency_mode='USD+FRA' (Kassumbalesa).
  // Hardcoded SELL=2900 / BUY=2600 remains as the fallback when the
  // table is empty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fx_rates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      effective_date  TEXT NOT NULL,
      sell_rate       REAL NOT NULL,
      buy_rate        REAL NOT NULL,
      notes           TEXT,
      set_by          INTEGER,
      set_by_name     TEXT,
      sync_id         TEXT,
      tenant_id       TEXT,
      branch_id       TEXT,
      device_id       TEXT,
      synced          INTEGER NOT NULL DEFAULT 0,
      deleted_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fx_rates_effective ON fx_rates (effective_date);
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // v1.5.0 — HQ-owned products marker
  // ─────────────────────────────────────────────────────────────────────────
  // Marks a branch product as managed by HQ. Set to 1 by pushToBranches.
  // The branch UI uses this to lock HQ-owned fields (code, name, category,
  // unit, packagings, default_unit, photo, container, UB barcode) — branch
  // only edits price, status, min stock, notes, opening stock. The branch
  // PUT /api/products/:id ALSO enforces this server-side so a hostile
  // client can't bypass the UI lock.
  addCol('products', 'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');

  // v1.10.53 — Persisted Weighted Average Cost per product per branch.
  // Populated on:
  //   - GRN save (supplier receipt, branch-side)
  //   - HQ GRN generate (HQ pushes stock to branch)
  //   - Stock Transfer receive
  // Never overwritten by cost_price on product edit — cost_price is the
  // catalogue's "current buy price" (typing/reference), avg_cost_price is
  // the real weighted mean of on-hand stock. profitHelper.js COGS calc
  // reads this column directly instead of re-scanning grn_items every day.
  // NULL = never received any stock; profitHelper falls back to derived SUM
  // (backward-compat during backfill window).
  addCol('products', 'avg_cost_price', 'REAL');

  // v1.6.0 — Categories, main_categories and units are also HQ-owned now.
  // Same mechanism as products: HQ writes push to every branch with
  // is_hq_owned=1; branches can't edit/delete those rows.
  addCol('categories',      'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');
  addCol('main_categories', 'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');
  addCol('units',           'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');

  // v1.7.0 — Triple currency (USD + FRA + K). Adds a parallel set of K
  // columns to fx_rates + orders, mirroring the FRA columns from v1.4.0
  // / v1.0. K is a foreign-cash currency the cashier may accept; items
  // stay priced in USD (base). currency_mode='USD+FRA+K' enables it
  // (existing 'K' single-currency mode and 'USD+FRA' dual mode are
  // unchanged).
  addCol('fx_rates', 'sell_rate_k', 'REAL');
  addCol('fx_rates', 'buy_rate_k',  'REAL');
  // v1.8.2: rate intra-day timestamps. Rates can change multiple times in
  // one day (typical Sosna street-rate cadence). effective_at stores the
  // exact moment the rate becomes active so the Cashier picks the right
  // one based on the order's created_at, and the chart can plot intra-day.
  addCol('fx_rates', 'effective_at', 'TEXT'); // SQLite DATETIME (YYYY-MM-DD HH:MM:SS)

  // v1.8.82 — TZ FIX self-heal: previously effective_at was stored as the
  // user's LOCAL time string but compared against SQLite datetime('now')
  // (UTC) in /current. Any row whose effective_at is > current UTC NOW is
  // a misstored local-time value (no one legitimately back-sets future
  // effective times in practice).
  //
  // v1.8.81's heal tried to convert local→UTC using new Date() — but on a
  // UTC server that's a no-op (server tz == UTC means the conversion adds
  // nothing). So those rows stayed broken.
  //
  // v1.8.82's heal: snap any future row to datetime('now') so it's effective
  // immediately. Loses the original sub-minute precision but unblocks the
  // Cashier right away. New rates from v1.8.82+ frontend send UTC directly,
  // so this heal only ever runs on legacy rows.
  try {
    const result = db.prepare(`
      UPDATE fx_rates
         SET effective_at = datetime('now'),
             synced       = 0,
             updated_at   = datetime('now')
       WHERE deleted_at IS NULL
         AND effective_at IS NOT NULL
         AND effective_at > datetime('now')
    `).run();
    if (result.changes > 0) {
      console.log(`[self-heal fx_rates effective_at] snapped ${result.changes} future row(s) to NOW (legacy local-time storage)`);
    }
  } catch (e) { /* fresh DB or fx_rates table not yet present */ }
  addCol('orders',   'k_received',         'REAL DEFAULT 0');
  addCol('orders',   'k_change_given',     'REAL DEFAULT 0');
  addCol('orders',   'selling_rate_k_used','REAL');
  addCol('orders',   'buying_rate_k_used', 'REAL');

  // v1.8.68 — split phantom-debt change_amount into per-currency tracking.
  // BEFORE: change_amount stored USD-equivalent of every over-payment, even
  // when the over-payment was paid in FRA/K. Cash Report subtracted it from
  // the USD drawer → phantom surplus on USD when customer overpaid in FRA.
  // AFTER: usd_change_given holds ONLY physical USD returned. overpaid_kept_*
  // captures over-payments the cashier kept in the original currency.
  addCol('orders',   'usd_change_given',   'REAL NOT NULL DEFAULT 0');
  addCol('orders',   'overpaid_kept_ccy',  'TEXT');   // 'USD' | 'FRA' | 'K' | NULL
  addCol('orders',   'overpaid_kept_amt',  'REAL NOT NULL DEFAULT 0'); // in source ccy

  // v1.10.109 — REMOVED the v1.8.68 backfill block that copied
  // change_amount → usd_change_given on every startup. It was carried
  // over from Liquor's migrations.js when Sosna was forked, but Sosna's
  // DBs are all fresh (bootstrapped 2026-06-13, schema already includes
  // fra_change_given / k_change_given), so it had no legitimate legacy
  // rows to touch. Instead, it corrupted new orders where the cashier
  // gave change entirely in FRA (usd_change_given=0, fra_change_given>0,
  // change_amount>0 → block wrote usd_change_given = change_amount on
  // next restart, doubling the recorded change). Real incident: 12
  // Kassumbalesa orders inflated by $30 USD total.
  //
  // v1.10.109 also added a one-shot phantom-repair block that zeroed
  // usd_change_given on rows matching the corruption fingerprint
  // (usd_change_given ≈ change_amount AND fra_change_given > 0).
  //
  // v1.10.110 — repair block REMOVED. Verified 0 remaining phantoms
  // across all tenants (kassumbalesa1, mansa1, lusaka1, sosna HQ),
  // so the block was no-op on every future restart. See
  // [[project-sosna-phantom-change-backfill]] if the pattern returns.

  // v1.8.77 — SELF-HEALING fix for orders confirmed before v1.8.74 when the
  // backend defaulted overpaid_kept_ccy='USD' any time the customer paid some
  // USD, even though the actual over-payment was in FRA/K. Symptom: Cash
  // Report Over-Collections shows "USD +$0.11" but Sales Report USD column
  // is $199.89 instead of $200 because usd_change_given got backfilled with
  // the FRA-overpayment USD-equivalent.
  //
  // Heals only the orders that match the bug fingerprint:
  //   • overpaid_kept_ccy = 'USD'
  //   • cash_received > 0 (USD was paid)
  //   • fra_received > 0 OR k_received > 0 (foreign currency also paid)
  //   • usd_change_given > 0 (USD supposedly returned, but it shouldn't have been)
  //   • fra_change_given = 0 AND k_change_given = 0 (cashier kept the change)
  // Re-attributes overpaid_kept_ccy/amt using source-currency priority
  // (USD pays first → FRA → K, surplus lives in the LAST currency used),
  // and zeroes usd_change_given since no USD was actually returned.
  try {
    const sus = db.prepare(`
      SELECT id, total_amount, cash_received, fra_received, k_received,
             selling_rate_used, selling_rate_k_used, usd_change_given,
             overpaid_kept_amt
        FROM orders
       WHERE deleted_at IS NULL
         AND COALESCE(overpaid_kept_ccy, '') = 'USD'
         AND COALESCE(cash_received, 0) > 0
         AND (COALESCE(fra_received, 0) > 0 OR COALESCE(k_received, 0) > 0)
         AND COALESCE(usd_change_given, 0) > 0
         AND COALESCE(fra_change_given, 0) = 0
         AND COALESCE(k_change_given, 0)   = 0
    `).all();
    if (sus.length > 0) {
      const upd = db.prepare(`
        UPDATE orders
           SET overpaid_kept_ccy = ?,
               overpaid_kept_amt = ?,
               usd_change_given  = 0,
               synced            = 0,
               updated_at        = datetime('now')
         WHERE id = ?
      `);
      let healed = 0;
      for (const r of sus) {
        const totalDue = parseFloat(r.total_amount)  || 0;
        const paidUSD  = parseFloat(r.cash_received) || 0;
        const paidFRA  = parseFloat(r.fra_received   || 0) || 0;
        const paidK    = parseFloat(r.k_received     || 0) || 0;
        const sellR    = parseFloat(r.selling_rate_used   || 0) || 0;
        const sellRK   = parseFloat(r.selling_rate_k_used || 0) || 0;
        // Source-currency over-payment chain (USD → FRA → K)
        let rem = totalDue - Math.min(paidUSD, totalDue);
        let overUSD  = paidUSD - Math.min(paidUSD, totalDue);
        let overFRA = 0, overK = 0;
        if (rem > 0 && paidFRA > 0 && sellR > 0) {
          const fraNeeded = rem * sellR;
          if (paidFRA >= fraNeeded) { overFRA = paidFRA - fraNeeded; rem = 0; }
          else                      { rem -= paidFRA / sellR; }
        } else if (paidFRA > 0) {
          overFRA = paidFRA;
        }
        if (rem > 0 && paidK > 0 && sellRK > 0) {
          const kNeeded = rem * sellRK;
          if (paidK >= kNeeded) { overK = paidK - kNeeded; rem = 0; }
        } else if (paidK > 0) {
          overK = paidK;
        }
        let newCcy = 'USD', newAmt = overUSD;
        if      (overFRA > 0.5)   { newCcy = 'FRA'; newAmt = overFRA; }
        else if (overK   > 0.5)   { newCcy = 'K';   newAmt = overK; }
        else if (overUSD > 0.001) { newCcy = 'USD'; newAmt = overUSD; }
        else continue; // nothing to attribute
        upd.run(newCcy, newAmt, r.id);
        healed++;
      }
      if (healed > 0) console.log(`[self-heal overpaid_kept] re-attributed ${healed} order(s) from USD default → source currency`);
    }
  } catch (e) { /* table may not yet have all columns on a fresh DB */ }

  // v1.10.118 — REMOVED the v1.8.80 self-healing block that zeroed
  // usd_change_given whenever overpaid_kept_ccy IN ('FRA','K'). It was
  // written to clean up damage from the removed v1.8.68 backfill (see
  // [[project-sosna-phantom-change-backfill]]), assuming that "kept in
  // FRA/K → no USD was returned". That assumption is TOO STRICT for
  // Sosna's tri-currency Cashier flow: a customer can pay $50 + K20,
  // owe $20.64 change, get $20 USD + 500 FRA back, AND still leave a
  // small FRA surplus in the drawer — all three amounts legitimate.
  // Under the removed rule, admin fixes to usd_change_given would
  // silently revert to 0 on the next restart (real incident on ORD-0101,
  // 2026-07-05). Like the v1.8.68 backfill, this block had no run-once
  // guard so it perpetually re-zeroed legitimate values. Deleted outright;
  // any prior damage stays until the admin re-enters the correct number
  // going forward (this second Edit will stick now).

  // v1.10.191 — deleted the v1.8.83 self-heal cash_receipts FRA/K backfill.
  // Rationale: block was originally a one-shot heal for pre-v1.8.31 Sosna
  // CRs where FRA/K columns were left at 0. Kept as run-every-boot in case
  // stale rows leaked back via sync. But Sosna is web-only (no Electron
  // clients pushing rows back), and every historical row is already healed
  // — the WHERE never matches on Kassumbalesa now, wasted cycles.
  //
  // Worse: on Liquor branches (Mansa, Lusaka), cashReceipts.js:245-247
  // forces fra_amount=k_amount=0 by design (K sub-drawer split lives in
  // cash/bank/momo). The WHERE clause misread this as "unfilled" and
  // re-derived cash_amount from cash_reports.usd_received on every boot,
  // silently reverting Cash Report edits (Mansa Jul 7 CR-0009 flipped
  // K25,295 → K25,155 every restart until v1.10.191).
  //
  // Fix: delete entirely. Kassumbalesa loses nothing (already healed);
  // Liquor stops the revert. Any future case of legacy Sosna rows can
  // be one-shot via a scripts/*.sql, not a boot-time migration.

  // ── v1.8.58 — SELF-HEALING cash_received cleanup (was one-time in v1.8.53) ──
  // Foreign-currency-only payments stored the dollar-VALUE in cash_received,
  // double-counting against the FRA/K bucket. The original v1.8.53 backfill
  // ran once-only via a sync_config flag, but Electron PCs running older
  // code keep pushing stale bad rows back to VPS, undoing the fix.
  //
  // Solution: drop the one-shot flag and re-run on EVERY backend boot.
  // The WHERE clause matches only rows that STILL exhibit the bug
  // (cash_received ≈ amount_received AND foreign-currency > 0), so it's
  // a no-op once data is clean. ~50ms per boot worst-case.
  //
  // Net effect: each VPS / Electron restart re-cleans whatever stale rows
  // have leaked in since the last boot, until every device upgrades.
  try {
    const result = db.prepare(`
      UPDATE orders
         SET cash_received = MAX(0, amount_received
             - (CASE WHEN COALESCE(selling_rate_used, 0)   > 0 THEN fra_received / selling_rate_used   ELSE 0 END)
             - (CASE WHEN COALESCE(selling_rate_k_used, 0) > 0 THEN k_received   / selling_rate_k_used ELSE 0 END)),
             synced = 0,
             updated_at = datetime('now')
       WHERE deleted_at IS NULL
         AND (status IS NULL OR status != 'Reversed')
         AND (COALESCE(fra_received, 0) > 0 OR COALESCE(k_received, 0) > 0)
         AND ABS(COALESCE(cash_received, 0) - COALESCE(amount_received, 0)) < 0.01
    `).run();
    if (result.changes > 0) {
      console.log(`[self-heal cash_received] cleaned ${result.changes} order(s) on this boot`);
    }
  } catch (e) {
    console.warn('[self-heal cash_received] skipped:', e.message);
  }

  // ── v1.8.95 — SELF-HEALING products.current_stock ────────────────────────
  // current_stock is a cached/denormalized snapshot of total on-hand stock
  // per product. Truth lives in stock_movements (sum of in/out moves).
  // The cache gets out of sync because some legacy code paths bypass the
  // movements log when editing it. Real incident: SAVANNA 330ML showed
  // 300 Bottle on Inter-Branch Transfer page while Stock Reconciliation
  // (which computes live from stock_movements) showed 22,398 Bottle — a
  // 75x discrepancy that almost let a cashier under-transfer by 22,000.
  //
  // Strategy C heal: on every backend boot, rebuild current_stock for
  // every product by summing its non-deleted stock_movements. Brings the
  // cache back to truth so the 9 readers that still trust it (HQ
  // Inventory, Branch Dashboard low-stock widget, Stock Count baseline,
  // etc.) display correct numbers. Idempotent — running again gives
  // identical results. ~50ms for 1000 products.
  try {
    const result = db.prepare(`
      UPDATE products
         SET current_stock = COALESCE((
               SELECT SUM(sm.quantity)
                 FROM stock_movements sm
                WHERE sm.product_sync_id = products.sync_id
                  AND sm.deleted_at IS NULL
             ), 0),
             synced = 0,
             updated_at = datetime('now')
       WHERE deleted_at IS NULL
         AND sync_id IS NOT NULL
    `).run();
    if (result.changes > 0) {
      console.log(`[self-heal current_stock] rebuilt cache for ${result.changes} product(s) from stock_movements`);
    }
  } catch (e) {
    console.warn('[self-heal current_stock] skipped:', e.message);
  }

  // v1.10.53 — Seed products.avg_cost_price for rows that still have NULL.
  // Uses the same formula profitHelper.js was computing on the fly:
  //   avg = SUM(grn_items.total_price) / SUM(base_qty_from_units_json)
  // Only touches products where avg_cost_price IS NULL, so subsequent
  // shipment blends (which write back a fresh value) are preserved.
  // If no grn_items exist for a product yet, avg_cost_price stays NULL
  // and profitHelper's fallback chain (cost_price) kicks in.
  try {
    const baseQtyExpr = `(
      CASE
        WHEN gip.units_json IS NULL OR gip.units_json = '' THEN gi.quantity
        WHEN json_extract(gip.units_json, '$[0].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[0].conv'), 1)
        WHEN json_extract(gip.units_json, '$[1].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[1].conv'), 1)
        WHEN json_extract(gip.units_json, '$[2].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[2].conv'), 1)
        WHEN json_extract(gip.units_json, '$[3].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[3].conv'), 1)
        ELSE gi.quantity
      END
    )`;
    const result = db.prepare(`
      UPDATE products
         SET avg_cost_price = (
               SELECT CASE WHEN SUM(${baseQtyExpr}) > 0
                           THEN ROUND(SUM(gi.total_price) / SUM(${baseQtyExpr}), 4)
                           ELSE NULL END
                 FROM grn_items gi
                 LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
                WHERE gi.product_sync_id = products.sync_id
                  AND gi.deleted_at IS NULL
             ),
             updated_at = datetime('now'),
             synced     = 0
       WHERE deleted_at IS NULL
         AND sync_id IS NOT NULL
         AND avg_cost_price IS NULL
         AND EXISTS (
               SELECT 1 FROM grn_items gi2
                WHERE gi2.product_sync_id = products.sync_id
                  AND gi2.deleted_at IS NULL
             )
    `).run();
    if (result.changes > 0) {
      console.log(`[seed avg_cost_price] backfilled ${result.changes} product(s) from grn_items`);
    }
  } catch (e) {
    console.warn('[seed avg_cost_price] skipped:', e.message);
  }
}

module.exports = { initTenantDb };
