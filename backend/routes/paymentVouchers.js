const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
// v1.10.180 — Phase 2b: PV with k_amount > 0 drains K from the pool.
const { poolInflowNative, poolDrainK } = require('../config/cashPoolHelper');
// v1.10.239 — HQ overdraft guard.
const { checkHqOverdraft } = require('../config/perMethodBalanceHelper');
let _masterDb = null;
try { _masterDb = require('../config/masterDb').masterDb; } catch { /* offline */ }

// Derive per-method splits from the voucher's paid_from string. Substring match
// (paid_from is free text like "Main cashier", "Bank — FNB", "MTN MoMo") so
// we lower-case and look for any of the recognised keywords. Same rules the
// migration backfill uses. Unknown / empty → Cash bucket (most common case).
function derivePVSplits(paid_from, amount) {
  const amt = parseFloat(amount) || 0;
  const pf  = (paid_from || '').toLowerCase();
  if (pf.includes('bank') || pf.includes('cheque'))  return { cash: 0, bank: amt, momo: 0 };
  if (pf.includes('mobile') || pf.includes('momo'))  return { cash: 0, bank: 0,   momo: amt };
  return { cash: amt, bank: 0, momo: 0 }; // matches 'Main cashier', 'Cash', 'Drawer', empty, etc.
}

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, paid_from, cashier_id, is_landed_cost, exclude_landed_cost,
            linked_purchase_sync_id, linked_transfer_sync_id } = req.query;
    let q = 'SELECT * FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?';
    const params = [req.user.tenantId];
    if (date)      { params.push(date);      q += ' AND date = ?'; }
    if (paid_from) { params.push(paid_from); q += ' AND paid_from = ?'; }
    if (cashier_id !== undefined) { params.push(parseInt(cashier_id)); q += ' AND cashier_id = ?'; }
    // v1.10.185 — LCV filters for the Cost of Delivery page and to
    // keep the regular PV list free of LCVs. Both switches accept '1'.
    if (is_landed_cost === '1' || is_landed_cost === 1 || is_landed_cost === 'true') {
      q += ' AND is_landed_cost = 1';
    }
    if (exclude_landed_cost === '1' || exclude_landed_cost === 1 || exclude_landed_cost === 'true') {
      q += ' AND (is_landed_cost IS NULL OR is_landed_cost = 0)';
    }
    // v1.10.187 — narrow to a single PO / transfer's LCVs. Powers the
    // Generate GRN modal's "delivery costs attached" section and the
    // future Transfer Receive modal.
    if (linked_purchase_sync_id) { params.push(linked_purchase_sync_id); q += ' AND linked_purchase_sync_id = ?'; }
    if (linked_transfer_sync_id) { params.push(linked_transfer_sync_id); q += ' AND linked_transfer_sync_id = ?'; }
    q += ' ORDER BY date DESC';
    const rows = db.prepare(q).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // v1.10.159 — the v1.10.158 gate was wrong: HQ's business_settings
    // has currency_mode='K' (only Kassumbalesa carries 'USD+FRA+K'),
    // so isKOnly was true on HQ and the fallback stayed on. USD KPI
    // still mirrored K.
    //
    // Adopt the same per-row check CashReceipt /stats uses at v1.10.141:
    // when a row's k_amount > 0 it's an HQ K PV where cash/bank/momo are
    // K sub-drawers — skip the cash/bank fallback for USD/FRA. Rows
    // where k_amount = 0 keep the legacy fallback (needed for Liquor
    // AR-mint receipts and pre-v1.8.5 rows).
    const usdExpr = `COALESCE(SUM(CASE
      WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount
      WHEN COALESCE(k_amount,0)   > 0 THEN 0
      ELSE COALESCE(cash_amount,0)
    END), 0)`;
    const fraExpr = `COALESCE(SUM(CASE
      WHEN COALESCE(fra_amount,0) > 0 THEN fra_amount
      WHEN COALESCE(k_amount,0)   > 0 THEN 0
      ELSE COALESCE(bank_amount,0)
    END), 0)`;
    const kExpr   = `COALESCE(SUM(CASE WHEN COALESCE(k_amount,0) > 0 THEN k_amount ELSE COALESCE(momo_amount,0) END), 0)`;
    const totalsRow = (whereExtra, params) => db.prepare(
      `SELECT ${usdExpr} AS usd, ${fraExpr} AS fra, ${kExpr} AS k
       FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${whereExtra}`
    ).get(...params);
    const today = totalsRow(" AND date = DATE('now')", [tenantId]);
    const month = totalsRow(" AND date >= date('now', 'start of month')", [tenantId]);
    const all   = totalsRow('', [tenantId]);
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    res.json({
      // Legacy USD-only fields kept for back-compat with anything still reading them.
      todayPayments: parseFloat(today.usd) || 0,
      thisMonth:     parseFloat(month.usd) || 0,
      totalVouchers: count.cnt,
      avgPayment:    count.cnt > 0 ? Math.round((parseFloat(all.usd) || 0) / count.cnt) : 0,
      // v1.8.25 — per-currency breakdowns.
      today: { usd: parseFloat(today.usd) || 0, fra: parseFloat(today.fra) || 0, k: parseFloat(today.k) || 0 },
      month: { usd: parseFloat(month.usd) || 0, fra: parseFloat(month.fra) || 0, k: parseFloat(month.k) || 0 },
      total: { usd: parseFloat(all.usd)   || 0, fra: parseFloat(all.fra)   || 0, k: parseFloat(all.k)   || 0 },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { paid_to, description, category, amount, date, paid_from, cashier_id, invoice_attachment,
            cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount,
            // v1.10.182 — Landed Cost Voucher fields. When is_landed_cost=1
            // the amount is absorbed into the linked reference's WAC and
            // excluded from profit-report expenses.
            // v1.10.185 — LCV can now attach to either a PO OR a transfer
            // (exactly one). Uniform delivery-cost model across both flows.
            is_landed_cost, linked_purchase_sync_id, linked_transfer_sync_id } = req.body;
    const isLandedCost = is_landed_cost ? 1 : 0;
    const linkedPurchaseSyncId = linked_purchase_sync_id || null;
    const linkedTransferSyncId = linked_transfer_sync_id || null;
    if (isLandedCost) {
      const linkCount = (linkedPurchaseSyncId ? 1 : 0) + (linkedTransferSyncId ? 1 : 0);
      if (linkCount === 0) {
        return res.status(400).json({ error: 'Landed cost vouchers must attach to either a purchase or a transfer.' });
      }
      if (linkCount > 1) {
        return res.status(400).json({ error: 'Landed cost vouchers can attach to only ONE reference — either a purchase or a transfer, not both.' });
      }
    }
    const voucherNum = syncConfig.generateNumber('PV', 'payment_vouchers');
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const cashierId = cashier_id !== undefined ? parseInt(cashier_id) : 0;
    const resolvedPaidFrom = paid_from || 'Main cashier';
    // v1.10.183 — hard-block PV creation into a Cash Drawer for a day/cashier
    // that already has a saved Cash Report. Otherwise the CR was minted
    // with expensesByCcy=0 (no PVs existed at save time), and the new PV
    // would silently drift the Cash Book below reconciled state. The user
    // must delete the saved Cash Report (admin action) or re-save it via
    // the Edit flow — either path re-mints the CR with the up-to-date
    // Total cash in. Landed cost vouchers are excluded (they're separate
    // from drawer expenses — v1.10.182).
    if (!isLandedCost && resolvedPaidFrom === 'Cash Drawer' && cashierId > 0) {
      const pvDate = date || new Date().toISOString().split('T')[0];
      const savedReport = db.prepare(
        `SELECT id FROM cash_reports
          WHERE date = ? AND cashier_id = ? AND deleted_at IS NULL AND tenant_id = ?`
      ).get(pvDate, cashierId, tenantId);
      if (savedReport) {
        return res.status(400).json({
          error: `Cash Report for this cashier on ${pvDate} is already saved. To add this expense, first Edit the saved Cash Report (or Delete it) so the new expense is picked up in the reconciliation.`,
        });
      }
    }
    // v1.8.5 — triple-currency. Each in its own currency. Legacy
    // cash/bank/momo still accepted but zeroed when usd/fra/k are sent.
    // v1.10.133 — on HQ, cash/bank/momo now hold the K sub-method split
    // (K·Cash / K·Bank / K·MoMo). Detect the HQ shape by presence of BOTH
    // tri-currency AND sub-method fields in the payload. Legacy Liquor
    // clients (send usd/fra/k only) still zero the sub-method columns.
    const hasTriCcy   = (usd_amount !== undefined || fra_amount !== undefined || k_amount !== undefined);
    const hasSubMeth  = (cash_amount !== undefined || bank_amount !== undefined || momo_amount !== undefined);
    // v1.10.166 — isHqTriCcy must be gated on branch currency_mode too.
    // A Liquor client that sends BOTH sets in one body (mirror + legacy)
    // used to be misread as HQ, and the backend would write both — which
    // is how PV-0031 (Simon Fuel, Lusaka) ended up with cash_amount = 2420
    // AND fra_amount = 2420 for a single K2,420 Cash payment. On K-only
    // branches (Liquor), always take the legacy path so only ONE column
    // per bucket gets written.
    // v1.10.171 — HQ safety net (see cashReceipts.js comment).
    const HQ_HOSTS_PV = new Set(['sosnazm.com', 'www.sosnazm.com']);
    const hostPV = String(req.hostname || req.headers?.host || '').toLowerCase();
    let isLiquorK = false;
    if (HQ_HOSTS_PV.has(hostPV)) {
      isLiquorK = false;
    } else {
      try {
        const bs = db.prepare(`SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`).get();
        isLiquorK = (bs?.currency_mode || '').toUpperCase() === 'K';
      } catch (_) { /* pre-migration DB — treat as tri-currency */ }
    }
    const isHqTriCcy  = hasTriCcy && hasSubMeth && !isLiquorK;
    const usdAmt = isHqTriCcy
      ? (parseFloat(usd_amount) || 0)
      : (parseFloat(usd_amount ?? cash_amount ?? 0) || 0);
    const fraAmt = isHqTriCcy
      ? (parseFloat(fra_amount) || 0)
      : (parseFloat(fra_amount ?? bank_amount ?? 0) || 0);
    const kAmt   = isHqTriCcy
      ? (parseFloat(k_amount) || 0)
      : (parseFloat(k_amount   ?? momo_amount ?? 0) || 0);
    // v1.10.190 — Liquor branches also populate cash/bank/momo so that
    // Cash Book's Liquor sum (cash+bank+momo) sees the outflow. Prior
    // logic force-zeroed them on non-HQ writes; Liquor PVs then landed
    // invisibly in Cash Book (see PV-2026-EBD2A7-0036, K130 phantom on
    // Mansa; K8,420 on Lusaka across 4 rows). Client already mirrors
    // (frontend v1.10.190) but derive here too so any other path stays
    // honest. Liquor slot mapping: Cash→usd, MoMo→fra, Bank→k.
    let cashAmt, bankAmt, momoAmt;
    if (isHqTriCcy) {
      cashAmt = parseFloat(cash_amount) || 0;
      bankAmt = parseFloat(bank_amount) || 0;
      momoAmt = parseFloat(momo_amount) || 0;
    } else if (isLiquorK) {
      cashAmt = cash_amount !== undefined ? (parseFloat(cash_amount) || 0) : usdAmt;
      bankAmt = bank_amount !== undefined ? (parseFloat(bank_amount) || 0) : kAmt;
      momoAmt = momo_amount !== undefined ? (parseFloat(momo_amount) || 0) : fraAmt;
    } else {
      cashAmt = 0; bankAmt = 0; momoAmt = 0;
    }
    // v1.10.172 — HQ save guards.
    // (1) USD/FRA no-mirror: cash/bank/momo are K sub-drawers on HQ, NOT
    //     currency mirrors. If the payload set usd_amount or fra_amount,
    //     force the sub-drawer cells to 0 so no mirror-style row gets
    //     written (which is how legacy PV-0001, 0003, 0018-0020 ended up
    //     with usd_amount = cash_amount).
    // (2) K invariant: if k_amount > 0, at least one sub-drawer must carry
    //     it, and the three must sum to k_amount. Reject 400 on either
    //     orphaned K (all sub-drawers 0) or unbalanced split. Prevents the
    //     NHIMA-style row (k_amount = 3044.76, no drawer picked).
    // v1.10.172a — gate on HQ host explicitly. Kassumbalesa is tri-currency
    // but does NOT use K sub-drawers (cash-only branch, k_amount alone is
    // correct there). Applying the invariant to Kassumbalesa would false-
    // reject legitimate K PVs.
    if (isHqTriCcy && HQ_HOSTS_PV.has(hostPV)) {
      if (usdAmt > 0 || fraAmt > 0) {
        cashAmt = 0; bankAmt = 0; momoAmt = 0;
      }
      if (kAmt > 0) {
        const subSum = cashAmt + bankAmt + momoAmt;
        if (subSum <= 0) {
          return res.status(400).json({ error: 'K amount must be assigned to a sub-drawer (K·Cash / K·Bank / K·MoMo). Pick a drawer and try again.' });
        }
        if (Math.abs(kAmt - subSum) > 0.01) {
          return res.status(400).json({ error: `K sub-drawer split (${subSum}) must equal K total (${kAmt}).` });
        }
      }
    }
    // v1.10.239 — HQ overdraft guard on payment vouchers.
    // Only fires on HQ host (Kassumbalesa's tri-currency drawer has its own
    // per-currency reconciliation model and is left alone in this phase).
    // Landed Cost Vouchers still drain cash even though they're absorbed
    // into inventory WAC — guard them too so an LCV can't overdraft either.
    if (HQ_HOSTS_PV.has(hostPV)) {
      const breach = checkHqOverdraft(
        db, tenantId,
        { usd: usdAmt, fra: fraAmt, k: kAmt },
        { masterDb: _masterDb, slug: 'sosnazm' },
      );
      if (breach) {
        const symbol = breach.ccy === 'K' ? 'K' : breach.ccy === 'FRA' ? 'FRA ' : '$';
        return res.status(400).json({
          error: `Voucher exceeds HQ ${breach.ccy} balance (available ${symbol}${breach.available.toLocaleString(undefined, { maximumFractionDigits: 2 })}, attempting ${symbol}${breach.requested.toLocaleString(undefined, { maximumFractionDigits: 2 })}). Reduce the amount or pick a different currency.`,
          currency:  breach.ccy,
          available: breach.available,
          attempted: breach.requested,
        });
      }
    }
    const sumSplits = usdAmt + fraAmt + kAmt;
    // For the legacy total `amount` column we use whatever the caller sent
    // (the USD-equivalent header), falling back to USD-only if missing.
    const totalAmount = parseFloat(amount) > 0 ? parseFloat(amount) : (sumSplits > 0 ? usdAmt : 0);
    // v1.10.180 — atomic ledger INSERT + K-pool drain. K portion of the
    // voucher pulls K out of the pool (pro-rata across native + exchange
    // so the rate stays put). USD/FRA portions don't touch the K pool.
    const info = db.transaction(() => {
      const insInfo = db.prepare(
        `INSERT INTO payment_vouchers (voucher_number, paid_to, description, category, amount,
                                       cash_amount, bank_amount, momo_amount,
                                       usd_amount, fra_amount, k_amount,
                                       date, paid_from, cashier_id, invoice_attachment, created_by,
                                       is_landed_cost, linked_purchase_sync_id, linked_transfer_sync_id,
                                       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))`
      ).run(voucherNum, paid_to, description, category, totalAmount,
            cashAmt, bankAmt, momoAmt,
            usdAmt, fraAmt, kAmt,
            date || new Date().toISOString().split('T')[0],
            resolvedPaidFrom,
            cashierId,
            invoice_attachment || null,
            req.user.id,
            isLandedCost, linkedPurchaseSyncId, linkedTransferSyncId,
            randomUUID(), tenantId, branchId, deviceId);
      if (kAmt > 0) poolDrainK(db, kAmt);
      return insInfo;
    })();
    const row = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(info.lastInsertRowid);
    recalculateDailyProfit(db, row.date, req.user.tenantId);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    // v1.10.187 — block edits on an Applied LCV. Its amount was baked
    // into the destination branch's WAC at Generate GRN / Transfer
    // Receive time; changing it now would silently drift the inventory
    // cost basis away from books. To adjust after the fact, the user
    // creates a fresh LCV against the same reference before the next
    // GRN, or reverses via a manual WAC adjustment.
    const currentPv = db.prepare(
      'SELECT is_landed_cost, applied_to_grn_sync_id, applied_to_transfer_sync_id FROM payment_vouchers WHERE id = ? AND deleted_at IS NULL'
    ).get(req.params.id);
    if (currentPv?.is_landed_cost && (currentPv.applied_to_grn_sync_id || currentPv.applied_to_transfer_sync_id)) {
      return res.status(400).json({ error: 'This delivery cost has already been absorbed into inventory WAC and cannot be edited. Create a new delivery cost for any adjustment.' });
    }
    const { paid_to, description, category, amount, date, paid_from, invoice_attachment,
            cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount } = req.body;
    const pvDate = date || new Date().toISOString().split('T')[0];
    const resolvedPaidFrom = paid_from || 'Main cashier';
    // v1.10.133 — HQ K sub-method write (same detection as POST).
    const hasTriCcy   = (usd_amount !== undefined || fra_amount !== undefined || k_amount !== undefined);
    const hasSubMeth  = (cash_amount !== undefined || bank_amount !== undefined || momo_amount !== undefined);
    // v1.10.166 — isHqTriCcy must be gated on branch currency_mode too.
    // A Liquor client that sends BOTH sets in one body (mirror + legacy)
    // used to be misread as HQ, and the backend would write both — which
    // is how PV-0031 (Simon Fuel, Lusaka) ended up with cash_amount = 2420
    // AND fra_amount = 2420 for a single K2,420 Cash payment. On K-only
    // branches (Liquor), always take the legacy path so only ONE column
    // per bucket gets written.
    // v1.10.171 — HQ safety net (see cashReceipts.js comment).
    const HQ_HOSTS_PV = new Set(['sosnazm.com', 'www.sosnazm.com']);
    const hostPV = String(req.hostname || req.headers?.host || '').toLowerCase();
    let isLiquorK = false;
    if (HQ_HOSTS_PV.has(hostPV)) {
      isLiquorK = false;
    } else {
      try {
        const bs = db.prepare(`SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`).get();
        isLiquorK = (bs?.currency_mode || '').toUpperCase() === 'K';
      } catch (_) { /* pre-migration DB — treat as tri-currency */ }
    }
    const isHqTriCcy  = hasTriCcy && hasSubMeth && !isLiquorK;
    const usdAmt = isHqTriCcy ? (parseFloat(usd_amount) || 0) : (parseFloat(usd_amount ?? cash_amount ?? 0) || 0);
    const fraAmt = isHqTriCcy ? (parseFloat(fra_amount) || 0) : (parseFloat(fra_amount ?? bank_amount ?? 0) || 0);
    const kAmt   = isHqTriCcy ? (parseFloat(k_amount)   || 0) : (parseFloat(k_amount   ?? momo_amount ?? 0) || 0);
    // v1.10.190 — Liquor sub-drawer mirror (see POST comment).
    let cashAmt, bankAmt, momoAmt;
    if (isHqTriCcy) {
      cashAmt = parseFloat(cash_amount) || 0;
      bankAmt = parseFloat(bank_amount) || 0;
      momoAmt = parseFloat(momo_amount) || 0;
    } else if (isLiquorK) {
      cashAmt = cash_amount !== undefined ? (parseFloat(cash_amount) || 0) : usdAmt;
      bankAmt = bank_amount !== undefined ? (parseFloat(bank_amount) || 0) : kAmt;
      momoAmt = momo_amount !== undefined ? (parseFloat(momo_amount) || 0) : fraAmt;
    } else {
      cashAmt = 0; bankAmt = 0; momoAmt = 0;
    }
    // v1.10.172 — HQ save guards.
    // (1) USD/FRA no-mirror: cash/bank/momo are K sub-drawers on HQ, NOT
    //     currency mirrors. If the payload set usd_amount or fra_amount,
    //     force the sub-drawer cells to 0 so no mirror-style row gets
    //     written (which is how legacy PV-0001, 0003, 0018-0020 ended up
    //     with usd_amount = cash_amount).
    // (2) K invariant: if k_amount > 0, at least one sub-drawer must carry
    //     it, and the three must sum to k_amount. Reject 400 on either
    //     orphaned K (all sub-drawers 0) or unbalanced split. Prevents the
    //     NHIMA-style row (k_amount = 3044.76, no drawer picked).
    // v1.10.172a — gate on HQ host explicitly. Kassumbalesa is tri-currency
    // but does NOT use K sub-drawers (cash-only branch, k_amount alone is
    // correct there). Applying the invariant to Kassumbalesa would false-
    // reject legitimate K PVs.
    if (isHqTriCcy && HQ_HOSTS_PV.has(hostPV)) {
      if (usdAmt > 0 || fraAmt > 0) {
        cashAmt = 0; bankAmt = 0; momoAmt = 0;
      }
      if (kAmt > 0) {
        const subSum = cashAmt + bankAmt + momoAmt;
        if (subSum <= 0) {
          return res.status(400).json({ error: 'K amount must be assigned to a sub-drawer (K·Cash / K·Bank / K·MoMo). Pick a drawer and try again.' });
        }
        if (Math.abs(kAmt - subSum) > 0.01) {
          return res.status(400).json({ error: `K sub-drawer split (${subSum}) must equal K total (${kAmt}).` });
        }
      }
    }
    const sumSplits = usdAmt + fraAmt + kAmt;
    const totalAmount = parseFloat(amount) > 0 ? parseFloat(amount) : (sumSplits > 0 ? usdAmt : 0);
    // invoice_attachment: pass null to clear, omit to keep existing
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE payment_vouchers
            SET paid_to=?, description=?, category=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                usd_amount=?, fra_amount=?, k_amount=?,
                date=?, paid_from=?, updated_at=datetime('now'), synced=0
          WHERE id=?`
      : `UPDATE payment_vouchers
            SET paid_to=?, description=?, category=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                usd_amount=?, fra_amount=?, k_amount=?,
                date=?, paid_from=?, invoice_attachment=?, updated_at=datetime('now'), synced=0
          WHERE id=?`;
    const args = keepAttachment
      ? [paid_to, description, category, totalAmount,
         cashAmt, bankAmt, momoAmt,
         usdAmt, fraAmt, kAmt,
         pvDate, resolvedPaidFrom, req.params.id]
      : [paid_to, description, category, totalAmount,
         cashAmt, bankAmt, momoAmt,
         usdAmt, fraAmt, kAmt,
         pvDate, resolvedPaidFrom, invoice_attachment || null, req.params.id];
    // v1.10.180 — atomic UPDATE + pool delta. If the K amount changed
    // during the edit, apply the difference to the pool: an increase
    // drains more K, a decrease refunds native K. Zero delta is a no-op.
    const oldRow = db.prepare('SELECT k_amount FROM payment_vouchers WHERE id = ?').get(req.params.id);
    const oldKAmt = parseFloat(oldRow?.k_amount) || 0;
    const kDelta = kAmt - oldKAmt;
    const info = db.transaction(() => {
      const r = db.prepare(sql).run(...args);
      if (kDelta > 0)      poolDrainK(db, kDelta);
      else if (kDelta < 0) poolInflowNative(db, -kDelta);
      return r;
    })();
    if (info.changes === 0) return res.status(404).json({ error: 'Voucher not found' });
    const row = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(req.params.id);
    recalculateDailyProfit(db, pvDate, req.user.tenantId);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    // v1.10.180 — deleting a K PV reverses the pool drain. We add the K
    // amount back as native (the reverse of the pro-rata drain — we can't
    // reconstruct which portion was native vs exchange at drain time, so
    // treat the reversal as native inflow. Any slight rate drift from
    // this asymmetry is bounded by the clamp in poolDrainK and won't
    // accumulate on typical operations).
    const pv = db.prepare('SELECT date, k_amount, is_landed_cost, applied_to_grn_sync_id, applied_to_transfer_sync_id FROM payment_vouchers WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!pv) return res.status(404).json({ error: 'Voucher not found' });
    // v1.10.187 — same rule as edit: an Applied LCV is baked into WAC
    // and cannot be soft-deleted from the ledger without a compensating
    // WAC reversal (out of scope here).
    if (pv.is_landed_cost && (pv.applied_to_grn_sync_id || pv.applied_to_transfer_sync_id)) {
      return res.status(400).json({ error: 'This delivery cost has already been absorbed into inventory WAC and cannot be deleted.' });
    }
    const kAmt = parseFloat(pv.k_amount) || 0;
    const done = db.transaction(() => {
      const info = db.prepare("UPDATE payment_vouchers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=? AND deleted_at IS NULL").run(req.params.id);
      if (kAmt > 0) poolInflowNative(db, kAmt);
      return info;
    })();
    if (done.changes === 0) return res.status(404).json({ error: 'Voucher not found' });
    if (pv) recalculateDailyProfit(db, pv.date, req.user.tenantId);
    res.json({ message: 'Payment voucher deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
