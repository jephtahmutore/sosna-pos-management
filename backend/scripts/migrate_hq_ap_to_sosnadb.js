/**
 * v1.10.76 — migrate historical HQ supplier data DIRECTLY into
 * backend/sosna.db (NOT tenants/hq.db).
 *
 * Background:
 *   This HQ deploy runs single-tenant on the bare host (sosnazm.com,
 *   no subdomain), so the tenant middleware never fires and every HQ
 *   request lands on backend/sosna.db (the defaultDb). tenants/hq.db
 *   was auto-created empty by earlier scripts but never actually read
 *   or written by the running app. v1.10.72–75 migrated master data
 *   into that empty file — invisible on Account Payables.
 *
 * This script:
 *   1. Migrates master.hq_suppliers   → sosna.db.suppliers
 *   2. Migrates master.hq_grns        → sosna.db.grn   (total_amount = final_payable)
 *   3. Migrates master.hq_grn_items   → sosna.db.grn_items
 *   4. Migrates master.hq_supplier_payments → sosna.db.ap_payments
 *   5. Migrates master.hq_supplier_credit_notes → sosna.db.supplier_credit_notes
 *   6. Migrates master.hq_supplier_credit_note_items → sosna.db.supplier_credit_note_items
 *
 *   Every row gets tenant_id='local-only' — the value auth.js falls back
 *   to when sync_config is empty (which it is on this deploy).
 *
 * Safety:
 *   * Idempotent — sync_id matched to skip duplicates.
 *   * FK checks off during import (created_by refs users that don't
 *     exist; product_sync_id may not have been mirrored yet).
 *   * Read-only on master.
 *
 * HOW TO RUN:
 *   cp backend/sosna.db backend/sosna.db.bak-before-v76
 *   node backend/scripts/migrate_hq_ap_to_sosnadb.js
 */

const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { masterDb } = require('../config/masterDb');

// Open sosna.db DIRECTLY (bypass the config/database proxy which uses ALS).
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'sosna.db');
const db = new Database(dbPath);

const TID = 'local-only';

function migrateSuppliers() {
  const rows = masterDb.prepare(`SELECT * FROM hq_suppliers`).all();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM suppliers`).get().n;
  const findByName = db.prepare(`SELECT id, sync_id FROM suppliers WHERE LOWER(name) = LOWER(?) LIMIT 1`);
  const ins = db.prepare(`
    INSERT INTO suppliers (id, name, phone, email, address, contact_person, status,
                            sync_id, tenant_id, branch_id, device_id, synced,
                            created_at, updated_at)
    VALUES (?,?,?,?,?,?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const nameToNewId = new Map();
  const nameToSyncId = new Map();
  let inserted = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      const nk = String(r.name || '').toLowerCase();
      const ex = findByName.get(r.name);
      if (ex) {
        nameToNewId.set(nk, ex.id);
        nameToSyncId.set(nk, ex.sync_id);
        skipped += 1;
        continue;
      }
      const syncId = randomUUID();
      ins.run(
        r.id, r.name, r.phone, r.email, r.address, r.contact_person,
        r.status || 'Active',
        syncId, TID, null, null,
        r.created_at || new Date().toISOString(),
        r.updated_at || new Date().toISOString()
      );
      nameToNewId.set(nk, r.id);
      nameToSyncId.set(nk, syncId);
      inserted += 1;
    }
  })();
  console.log(`  suppliers:                  before=${before}  inserted=${inserted}  skipped=${skipped}`);
  return { nameToNewId, nameToSyncId };
}

function migrateGrns(nameToNewId, nameToSyncId) {
  const rows = masterDb.prepare(`SELECT * FROM hq_grns WHERE deleted_at IS NULL`).all();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM grn`).get().n;
  const findBySync = db.prepare(`SELECT id FROM grn WHERE sync_id = ? LIMIT 1`);
  const cntItems = masterDb.prepare(`SELECT COUNT(*) AS n FROM hq_grn_items WHERE grn_sync_id = ?`);
  const ins = db.prepare(`
    INSERT INTO grn (id, grn_number, date, supplier_id, supplier_sync_id, supplier_name,
                      total_items, total_amount, notes, invoice_attachment, supplier_invoice_number,
                      created_by, status, linked_purchase_sync_id, linked_purchase_number,
                      hq_status, sync_id, tenant_id, branch_id, device_id,
                      synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
  `);
  let inserted = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (findBySync.get(r.sync_id)) { skipped += 1; continue; }
      const nk = String(r.supplier_name || '').toLowerCase();
      const supId  = nameToNewId.get(nk)  || null;
      const supSid = nameToSyncId.get(nk) || r.supplier_sync_id || null;
      const nItems = cntItems.get(r.sync_id).n;
      ins.run(
        r.id, r.grn_number, r.date,
        supId, supSid, r.supplier_name,
        nItems, r.final_payable, r.notes,
        r.invoice_attachment, r.supplier_invoice_number,
        r.generated_by_hq, 'Completed',
        r.po_sync_id, r.po_number, 'CONFIRMED',
        r.sync_id, TID, null, null,
        r.generated_at || r.date, r.generated_at || r.date
      );
      inserted += 1;
    }
  })();
  console.log(`  grn:                        before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function migrateGrnItems() {
  const rows = masterDb.prepare(`SELECT * FROM hq_grn_items`).all();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM grn_items`).get().n;
  const findBySync = db.prepare(`SELECT id FROM grn_items WHERE sync_id = ? LIMIT 1`);
  const findProd = db.prepare(`SELECT id FROM products WHERE sync_id = ? LIMIT 1`);
  const ins = db.prepare(`
    INSERT INTO grn_items (grn_id, grn_sync_id, product_id, product_sync_id,
                            quantity, unit, unit_price, total_price, expiry_date,
                            sync_id, tenant_id, branch_id, device_id,
                            synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `);
  let inserted = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (findBySync.get(r.sync_id)) { skipped += 1; continue; }
      const prod = r.product_sync_id ? findProd.get(r.product_sync_id) : null;
      ins.run(
        r.grn_id, r.grn_sync_id,
        prod?.id || null, r.product_sync_id,
        r.quantity, r.unit, r.unit_price, r.total_price, r.expiry_date,
        r.sync_id, TID, null, null
      );
      inserted += 1;
    }
  })();
  console.log(`  grn_items:                  before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function migratePayments() {
  const rows = masterDb.prepare(`SELECT * FROM hq_supplier_payments`).all();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ap_payments WHERE payment_number LIKE 'HSP-%'`).get().n;
  const findByNumber = db.prepare(`SELECT id FROM ap_payments WHERE payment_number = ? LIMIT 1`);
  const findSupplier = db.prepare(`SELECT id, sync_id FROM suppliers WHERE LOWER(name) = LOWER(?) LIMIT 1`);
  const ins = db.prepare(`
    INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name,
                              amount, cash_amount, bank_amount, momo_amount,
                              description, date, paid_from, created_by,
                              sync_id, tenant_id, branch_id, device_id,
                              synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `);
  let inserted = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (findByNumber.get(r.payment_number)) { skipped += 1; continue; }
      const method = ['Cash', 'Bank', 'Mobile Money'].includes(r.payment_method) ? r.payment_method : 'Cash';
      const cashAmt = method === 'Cash'         ? r.amount : 0;
      const bankAmt = method === 'Bank'         ? r.amount : 0;
      const momoAmt = method === 'Mobile Money' ? r.amount : 0;
      const sup = findSupplier.get(r.supplier_name || '');
      const description = r.notes
        ? r.notes
        : (r.reference ? `${r.supplier_name || 'Supplier'} · ${r.reference}` : (r.supplier_name || 'HQ Supplier Payment'));
      ins.run(
        r.payment_number, sup?.id || null, sup?.sync_id || null, r.supplier_name,
        r.amount, cashAmt, bankAmt, momoAmt,
        description, r.payment_date, method, r.created_by || null,
        randomUUID(), TID, null, null
      );
      inserted += 1;
    }
  })();
  console.log(`  ap_payments (HSP-*):        before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function migrateCreditNotes(nameToNewId, nameToSyncId) {
  const rows = masterDb.prepare(`SELECT * FROM hq_supplier_credit_notes WHERE deleted_at IS NULL`).all();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM supplier_credit_notes`).get().n;
  const findBySync = db.prepare(`SELECT id FROM supplier_credit_notes WHERE sync_id = ? LIMIT 1`);
  const ins = db.prepare(`
    INSERT INTO supplier_credit_notes (id, credit_note_number, date, supplier_id, supplier_sync_id,
                                        reason, reference, amount, notes,
                                        grn_sync_id, created_by, sync_id, tenant_id, branch_id, device_id,
                                        synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
  `);
  let inserted = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (findBySync.get(r.sync_id)) { skipped += 1; continue; }
      const nk = String(r.supplier_name || '').toLowerCase();
      const supId  = nameToNewId.get(nk)  || null;
      const supSid = nameToSyncId.get(nk) || r.supplier_sync_id || null;
      ins.run(
        r.id, r.credit_note_number, r.date,
        supId, supSid,
        r.reason, r.reference, r.amount, r.notes,
        r.grn_sync_id, r.created_by,
        r.sync_id, TID, null, null,
        r.created_at || r.date, r.created_at || r.date
      );
      inserted += 1;
    }
  })();
  console.log(`  supplier_credit_notes:      before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function migrateCreditNoteItems() {
  const rows = masterDb.prepare(`SELECT * FROM hq_supplier_credit_note_items`).all();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM supplier_credit_note_items`).get().n;
  const findBySync = db.prepare(`SELECT id FROM supplier_credit_note_items WHERE sync_id = ? LIMIT 1`);
  const findProd = db.prepare(`SELECT id FROM products WHERE sync_id = ? LIMIT 1`);
  const ins = db.prepare(`
    INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                             quantity, unit_value, total_price, unit, unit_conv,
                                             sync_id, tenant_id, branch_id, device_id,
                                             synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `);
  let inserted = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (findBySync.get(r.sync_id)) { skipped += 1; continue; }
      const prod = r.product_sync_id ? findProd.get(r.product_sync_id) : null;
      ins.run(
        r.credit_note_id, r.credit_note_sync_id,
        prod?.id || null, r.product_sync_id,
        r.quantity, r.unit_value, r.total_price, r.unit,
        r.unit_conv || 1,
        r.sync_id, TID, null, null
      );
      inserted += 1;
    }
  })();
  console.log(`  supplier_credit_note_items: before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function main() {
  if (!masterDb) { console.error('master.db not accessible — aborting.'); process.exit(1); }
  console.log(`Target: ${dbPath}`);
  console.log(`tenant_id will be set to: ${TID}\n`);

  db.pragma('foreign_keys = OFF');
  const { nameToNewId, nameToSyncId } = migrateSuppliers();
  migrateGrns(nameToNewId, nameToSyncId);
  migrateGrnItems();
  migratePayments();
  migrateCreditNotes(nameToNewId, nameToSyncId);
  migrateCreditNoteItems();
  db.pragma('foreign_keys = ON');
  console.log('\nDone.');
}

main();
