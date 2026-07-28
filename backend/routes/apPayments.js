const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
// v1.10.180 — Phase 2b: AP paid in K drains K from the pool.
const { poolInflowNative, poolDrainK } = require('../config/cashPoolHelper');
// v1.10.241 — HQ overdraft guards (per-currency + K sub-drawer).
const { checkHqOverdraft, checkHqKSubDrawerOverdraft } = require('../config/perMethodBalanceHelper');
let _masterDb = null;
try { _masterDb = require('../config/masterDb').masterDb; } catch { /* offline */ }
const HQ_HOSTS_AP = new Set(['sosnazm.com', 'www.sosnazm.com']);

// GET /api/ap-payments
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, supplier_id } = req.query;
    let sql = `SELECT ap.*, s.name AS supplier_name_resolved
               FROM ap_payments ap
               LEFT JOIN suppliers s ON s.sync_id = ap.supplier_sync_id
               WHERE ap.deleted_at IS NULL AND ap.tenant_id = ?`;
    const params = [req.user.tenantId];
    if (from) { sql += ' AND ap.date >= ?'; params.push(from); }
    if (to)   { sql += ' AND ap.date <= ?'; params.push(to); }
    // Filter by sync_id derived from requested local id so cross-device
    // records still match.
    if (supplier_id) { sql += ' AND ap.supplier_sync_id = (SELECT sync_id FROM suppliers WHERE id = ?)'; params.push(parseInt(supplier_id)); }
    sql += ' ORDER BY ap.date DESC, ap.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ap-payments — accepts split amounts (cash_amount + bank_amount + momo_amount)
// AND the new triple-currency shape (usd_amount + fra_amount + k_amount)
// used by HQ's AP Record Payment modal (v1.10.78).
// Falls back to the legacy single `amount` + `paid_from` shape for older callers.
router.post('/', auth, (req, res) => {
  try {
    const { supplier_id, supplier_name, cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount,
            amount, description, date, paid_from, invoice_attachment } = req.body;
    const cash = parseFloat(cash_amount || 0) || 0;
    const bank = parseFloat(bank_amount || 0) || 0;
    const momo = parseFloat(momo_amount || 0) || 0;
    const usd  = parseFloat(usd_amount  || 0) || 0;
    const fra  = parseFloat(fra_amount  || 0) || 0;
    // v1.10.129 — HQ now sends K as 3 sub-methods (cash/bank/momo) instead of
    // a single k_amount. Detect HQ shape by presence of usd_amount or fra_amount
    // in the body (present even when 0). On HQ: k_amount = cash + bank + momo,
    // and cash/bank/momo are stored as K sub-method rows. On Liquor: legacy
    // path (cash/bank/momo = K sub-methods of a K-only branch), unchanged.
    const isHqTriCcy = (usd_amount !== undefined || fra_amount !== undefined);
    const kAmt = isHqTriCcy
      ? (cash + bank + momo)
      : (parseFloat(k_amount || 0) || 0);
    // v1.10.78 — total resolution priority: triple-currency sum > method sum > legacy `amount`.
    const ccySum   = usd + fra + kAmt;
    const splitSum = cash + bank + momo;
    const total    = ccySum > 0 ? ccySum : (splitSum > 0 ? splitSum : (parseFloat(amount || 0) || 0));
    if (!(total > 0)) return res.status(400).json({ error: 'Amount is required.' });

    // v1.10.241 — HQ overdraft guards. Same pattern as PV.
    const hostAP = String(req.hostname || req.headers?.host || '').toLowerCase();
    if (HQ_HOSTS_AP.has(hostAP)) {
      const tenantIdForGuard = syncConfig.getTenantId(req);
      const breach = checkHqOverdraft(
        db, tenantIdForGuard,
        { usd, fra, k: kAmt },
        { masterDb: _masterDb, slug: 'sosnazm' },
      );
      if (breach) {
        const symbol = breach.ccy === 'K' ? 'K' : breach.ccy === 'FRA' ? 'FRA ' : '$';
        return res.status(400).json({
          error: `AP payment exceeds HQ ${breach.ccy} balance (available ${symbol}${breach.available.toLocaleString(undefined, { maximumFractionDigits: 2 })}, attempting ${symbol}${breach.requested.toLocaleString(undefined, { maximumFractionDigits: 2 })}). Reduce the amount or pick a different currency.`,
          currency:  breach.ccy,
          available: breach.available,
          attempted: breach.requested,
        });
      }
      if (isHqTriCcy && kAmt > 0.0001) {
        const subBreach = checkHqKSubDrawerOverdraft(
          db, tenantIdForGuard,
          { cash, bank, momo },
          { masterDb: _masterDb, slug: 'sosnazm' },
        );
        if (subBreach) {
          return res.status(400).json({
            error: `AP payment exceeds ${subBreach.drawer} balance (available K${subBreach.available.toLocaleString(undefined, { maximumFractionDigits: 2 })}, attempting K${subBreach.requested.toLocaleString(undefined, { maximumFractionDigits: 2 })}). Move some or all of the K amount to a sub-drawer with more balance.`,
            drawer:    subBreach.drawer,
            available: subBreach.available,
            attempted: subBreach.requested,
          });
        }
      }
    }

    // Derive a paid_from label for display when none provided.
    // v1.10.78 — prefer triple-currency label on HQ; fall back to method label.
    // v1.10.129 — on HQ, K sub-methods now surface as 'K · Cash', 'K · Bank',
    // 'K · MoMo' so the label reflects the actual drawer that funded it.
    const derivedPaidFrom = paid_from || (() => {
      if (isHqTriCcy) {
        const used = [
          usd  > 0 && 'USD',
          fra  > 0 && 'FRA',
          cash > 0 && 'K · Cash',
          bank > 0 && 'K · Bank',
          momo > 0 && 'K · MoMo',
        ].filter(Boolean);
        if (used.length === 0) return 'Main cashier';
        if (used.length === 1) return used[0];
        return 'Mixed';
      }
      const used = [cash > 0 && 'Cash', bank > 0 && 'Bank', momo > 0 && 'Mobile Money'].filter(Boolean);
      if (used.length === 0) return 'Main cashier';
      if (used.length === 1) return used[0];
      return 'Mixed';
    })();

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const paymentNum = syncConfig.generateNumber('APR', 'ap_payments');
    const supplierSyncId = req.body.supplier_sync_id
      || (supplier_id ? db.prepare('SELECT sync_id FROM suppliers WHERE id = ?').get(supplier_id)?.sync_id : null)
      || null;
    // v1.10.264 — safety net for legacy client payloads that send k_amount +
    // paid_from='K · Cash/Bank/MoMo' WITHOUT the cash/bank/momo split. If the
    // K amount has no per-method split but the label says which sub-drawer
    // funded it, populate the corresponding method field from k_amount so
    // Cash Book's K sub-drawer breakdown stays consistent with the K tile.
    // Real incident 2026-07-27 APR-2026-C0AB98-0054: K117,600 with
    // paid_from='K · Cash', cash_amount=0 → Cash sub-drawer ran K117,600
    // higher than the K tile until this net was added.
    let cashOut = cash, bankOut = bank, momoOut = momo;
    if (kAmt > 0 && cash + bank + momo === 0) {
      const pf = String(derivedPaidFrom || '').toLowerCase().trim();
      if (pf === 'k · cash' || pf === 'cash')                                                     cashOut = kAmt;
      else if (pf === 'k · bank' || pf === 'bank')                                                bankOut = kAmt;
      else if (pf === 'k · momo' || pf === 'k · mobile money' || pf === 'mobile money')           momoOut = kAmt;
      if (cashOut + bankOut + momoOut === 0) {
        console.warn(`[ap_payments POST] K${kAmt} with paid_from='${derivedPaidFrom}' has no method split — Cash Book sub-drawer will drift. Investigate client.`);
      }
    }
    // v1.10.180 — atomic ledger INSERT + K-pool drain. K portion of the
    // AP payment pulls K out of the pool. USD/FRA portions don't touch
    // the K pool (they'd need FRA/USD equivalents, deferred beyond 2b).
    const info = db.transaction(() => {
      const insInfo = db.prepare(`
        INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name,
                                  amount, cash_amount, bank_amount, momo_amount,
                                  usd_amount, fra_amount, k_amount,
                                  description, date, paid_from, invoice_attachment, created_by,
                                  sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(paymentNum, supplier_id || null, supplierSyncId, supplier_name || null,
             total, cashOut, bankOut, momoOut,
             usd, fra, kAmt,
             description || null, date || new Date().toISOString().split('T')[0],
             derivedPaidFrom, invoice_attachment || null, req.user.id,
             randomUUID(), tenantId, branchId, deviceId);
      if (kAmt > 0) poolDrainK(db, kAmt);
      return insInfo;
    })();
    res.status(201).json(db.prepare('SELECT * FROM ap_payments WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ap-payments/:id — supports split amounts on edit too.
// v1.10.230 — Cash Book bug fix.
//   Prior versions only wrote cash/bank/momo/amount on edit — k_amount,
//   usd_amount and fra_amount were silently dropped. Cash Book reads
//   payments from k_amount/usd_amount/fra_amount, so edits appeared
//   in Account Payables but never in Cash Book. Now:
//     • Accepts the triple-currency fields (matches POST shape).
//     • Applies a K-pool delta so a K-payment edit refunds or drains
//       the pool by the difference — same accounting invariant as
//       POST (drain new) and DELETE (refund old).
router.put('/:id', auth, (req, res) => {
  try {
    const { cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount,
            amount, date, description, paid_from, invoice_attachment } = req.body;
    const cash = parseFloat(cash_amount || 0) || 0;
    const bank = parseFloat(bank_amount || 0) || 0;
    const momo = parseFloat(momo_amount || 0) || 0;
    const usd  = parseFloat(usd_amount  || 0) || 0;
    const fra  = parseFloat(fra_amount  || 0) || 0;
    // Same HQ-vs-Liquor shape detection used in POST: presence of usd_amount
    // OR fra_amount in the body (even zero) means the caller is HQ tri-ccy.
    // On HQ: k_amount = cash + bank + momo (K sub-methods). On Liquor:
    // legacy path where cash/bank/momo ARE the K sub-methods of a K-only branch.
    const isHqTriCcy = (usd_amount !== undefined || fra_amount !== undefined);
    const kAmt = isHqTriCcy
      ? (cash + bank + momo)
      : (parseFloat(k_amount || 0) || 0);
    const ccySum   = usd + fra + kAmt;
    const splitSum = cash + bank + momo;
    const total    = ccySum > 0 ? ccySum : (splitSum > 0 ? splitSum : (parseFloat(amount || 0) || 0));
    if (!(total > 0)) return res.status(400).json({ error: 'Amount is required.' });

    // Fetch the OLD k_amount before we clobber it — we need it for the
    // pool delta. Also verify the row exists / isn't deleted.
    const existing = db.prepare('SELECT k_amount FROM ap_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'AP payment not found.' });
    const oldK = parseFloat(existing.k_amount) || 0;

    const derivedPaidFrom = paid_from || (() => {
      if (isHqTriCcy) {
        const used = [
          usd  > 0 && 'USD',
          fra  > 0 && 'FRA',
          cash > 0 && 'K · Cash',
          bank > 0 && 'K · Bank',
          momo > 0 && 'K · MoMo',
        ].filter(Boolean);
        if (used.length === 0) return 'Main cashier';
        if (used.length === 1) return used[0];
        return 'Mixed';
      }
      const used = [cash > 0 && 'Cash', bank > 0 && 'Bank', momo > 0 && 'Mobile Money'].filter(Boolean);
      if (used.length === 1) return used[0];
      if (used.length > 1)   return 'Mixed';
      return null;
    })();

    // v1.10.264 — same safety net as POST. If paid_from labels a K sub-drawer
    // but the split fields are all zero, infer the method amount from k_amount.
    let cashOut = cash, bankOut = bank, momoOut = momo;
    if (kAmt > 0 && cash + bank + momo === 0) {
      const pf = String(derivedPaidFrom || '').toLowerCase().trim();
      if (pf === 'k · cash' || pf === 'cash')                                                     cashOut = kAmt;
      else if (pf === 'k · bank' || pf === 'bank')                                                bankOut = kAmt;
      else if (pf === 'k · momo' || pf === 'k · mobile money' || pf === 'mobile money')           momoOut = kAmt;
      if (cashOut + bankOut + momoOut === 0) {
        console.warn(`[ap_payments PUT] K${kAmt} with paid_from='${derivedPaidFrom}' has no method split — Cash Book sub-drawer will drift. Investigate client.`);
      }
    }

    // invoice_attachment: pass null to clear, omit to keep existing.
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE ap_payments SET amount=?, cash_amount=?, bank_amount=?, momo_amount=?,
                                usd_amount=?, fra_amount=?, k_amount=?,
                                date=?, description=?, paid_from=?, synced=0, updated_at=datetime('now')
          WHERE id=? AND deleted_at IS NULL`
      : `UPDATE ap_payments SET amount=?, cash_amount=?, bank_amount=?, momo_amount=?,
                                usd_amount=?, fra_amount=?, k_amount=?,
                                date=?, description=?, paid_from=?, invoice_attachment=?, synced=0, updated_at=datetime('now')
          WHERE id=? AND deleted_at IS NULL`;
    const args = keepAttachment
      ? [total, cashOut, bankOut, momoOut, usd, fra, kAmt, date, description || null, derivedPaidFrom, req.params.id]
      : [total, cashOut, bankOut, momoOut, usd, fra, kAmt, date, description || null, derivedPaidFrom, invoice_attachment || null, req.params.id];

    db.transaction(() => {
      db.prepare(sql).run(...args);
      // K-pool delta: new K − old K.
      //   positive delta (new > old) → drain more K from the pool
      //   negative delta (new < old) → refund the reduction back to the pool
      //   zero delta                → no pool touch
      const delta = kAmt - oldK;
      if (delta > 0)      poolDrainK(db, delta);
      else if (delta < 0) poolInflowNative(db, -delta);
    })();

    res.json(db.prepare('SELECT * FROM ap_payments WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ap-payments/:id
router.delete('/:id', auth, (req, res) => {
  try {
    // v1.10.180 — reversing a K AP payment refunds native K to the pool
    // (same asymmetry note as PV delete: we can't reconstruct the drain's
    // native/exchange split retrospectively, so treat the refund as
    // native. Bounded and rare enough not to accumulate meaningful drift).
    const row = db.prepare('SELECT k_amount FROM ap_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    const kAmt = parseFloat(row?.k_amount) || 0;
    db.transaction(() => {
      db.prepare("UPDATE ap_payments SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
      if (kAmt > 0) poolInflowNative(db, kAmt);
    })();
    res.json({ message: 'Payment deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
