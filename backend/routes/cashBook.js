const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// Opening balances are stored as up to 3 rows in cash_book with type='opening':
//   reference='OB-CASH' / 'OB-BANK' / 'OB-MOMO'
// A pre-existing single 'OB' row (legacy) is treated as the Cash opening.
function getOpeningByMethod(tenantId) {
  const rows = db.prepare(
    "SELECT reference, COALESCE(receipt_amount, 0) AS amount FROM cash_book WHERE type = 'opening' AND deleted_at IS NULL AND tenant_id = ?"
  ).all(tenantId);
  const out = { cash: 0, bank: 0, momo: 0 };
  for (const r of rows) {
    const ref = (r.reference || '').toUpperCase();
    if (ref === 'OB-BANK') out.bank += parseFloat(r.amount);
    else if (ref === 'OB-MOMO') out.momo += parseFloat(r.amount);
    else out.cash += parseFloat(r.amount); // OB-CASH or legacy 'OB'
  }
  return out;
}

// Sum a money column across all inflow/outflow tables with optional date filter.
// Capital Injection + Loan Disbursement → inflow (like CR).
// Capital Drawing + Dividend + Loan Principal + Loan Interest → outflow (like PV).
// Also computes net transfer effect for this method (in - out).
function sumMethod(tenantId, methodCol, dateClause, dateParams) {
  const cr = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM cash_receipts    WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const pv = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const ap = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM ap_payments      WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const capIn  = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type='Injection'${dateClause}`).get(tenantId, ...dateParams).t;
  const capOut = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type='Drawing'${dateClause}`).get(tenantId, ...dateParams).t;
  const div    = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM dividend_account WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const loanIn   = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Disbursement'${dateClause}`).get(tenantId, ...dateParams).t;
  const loanPrin = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Principal'${dateClause}`).get(tenantId, ...dateParams).t;
  const loanInt  = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Interest'${dateClause}`).get(tenantId, ...dateParams).t;
  // Net cash transfer effect on this method = inflow (to_method) - outflow (from_method)
  const methodName = methodCol === 'cash_amount' ? 'Cash' : methodCol === 'bank_amount' ? 'Bank' : 'Mobile Money';
  const trIn  = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers WHERE deleted_at IS NULL AND tenant_id = ? AND to_method   = ?${dateClause}`).get(tenantId, methodName, ...dateParams).t;
  const trOut = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers WHERE deleted_at IS NULL AND tenant_id = ? AND from_method = ?${dateClause}`).get(tenantId, methodName, ...dateParams).t;
  return {
    cr: parseFloat(cr), pv: parseFloat(pv), ap: parseFloat(ap),
    capIn: parseFloat(capIn), capOut: parseFloat(capOut), div: parseFloat(div),
    loanIn: parseFloat(loanIn), loanPrin: parseFloat(loanPrin), loanInt: parseFloat(loanInt),
    transferNet: parseFloat(trIn) - parseFloat(trOut),
  };
}

// Get cash book — derived from CR + PV + AP with per-method opening balance
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const opening = getOpeningByMethod(tenantId);
    const { from, to } = req.query;

    // Period filter for the entries shown in the table
    const dateFilter = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const dParams = [...(from ? [from] : []), ...(to ? [to] : [])];

    // When a `from` is set, fold all prior activity into the displayed opening
    let openingBalance = opening.cash + opening.bank + opening.momo;
    let openingByMethod = { ...opening };
    if (from) {
      const beforeClause = ' AND date < ?';
      ['cash_amount', 'bank_amount', 'momo_amount'].forEach((col) => {
        const key = col.replace('_amount', '');
        const m = sumMethod(tenantId, col, beforeClause, [from]);
        openingByMethod[key] = openingByMethod[key]
          + m.cr + m.capIn + m.loanIn
          - m.pv - m.ap - m.capOut - m.div - m.loanPrin - m.loanInt
          + m.transferNet;
      });
      openingBalance = openingByMethod.cash + openingByMethod.bank + openingByMethod.momo;
    }

    const entries = db.prepare(`
      SELECT date, 'CR' AS type, receipt_number AS reference,
        COALESCE(received_from, '') || ' - ' || COALESCE(description, '') AS description,
        amount AS receipt_amount, 0 AS payment_amount
      FROM cash_receipts
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'PV' AS type, voucher_number AS reference,
        COALESCE(paid_to, '') || ' - ' || COALESCE(description, '') AS description,
        0 AS receipt_amount, amount AS payment_amount
      FROM payment_vouchers
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'AP' AS type, payment_number AS reference,
        COALESCE(supplier_name, '') || ' - ' || COALESCE(description, 'Supplier Payment') AS description,
        0 AS receipt_amount, amount AS payment_amount
      FROM ap_payments
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
        -- Empty return credits don't move cash — they live in AP only.
        -- Belt-and-braces match: either paid_from tag OR the description prefix.
        AND COALESCE(paid_from, '') != 'Empty Return'
        AND COALESCE(description, '') NOT LIKE 'Empty container deposit credit%'
      UNION ALL
      -- Cash transfers — shown with BOTH receipt and payment populated so running balance
      -- stays flat (money moved between methods, total unchanged). Per-method stats
      -- handle the actual redistribution.
      SELECT date, 'TRF' AS type, transfer_number AS reference,
        'Transfer: ' || from_method || ' -> ' || to_method ||
          CASE WHEN description IS NOT NULL AND description != '' THEN ' (' || description || ')' ELSE '' END AS description,
        amount AS receipt_amount, amount AS payment_amount
      FROM cash_transfers
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      -- Capital injections → inflows (like CR). Drawings → outflows (like PV).
      SELECT date,
        CASE WHEN type='Injection' THEN 'CAP-IN' ELSE 'CAP-OUT' END AS type,
        entry_number AS reference,
        COALESCE(owner_name, '') || ' - ' || COALESCE(description, type) AS description,
        CASE WHEN type='Injection' THEN amount ELSE 0 END AS receipt_amount,
        CASE WHEN type='Drawing'   THEN amount ELSE 0 END AS payment_amount
      FROM capital_account
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      -- Dividend payouts → outflows. Profit distribution to owner(s).
      SELECT date, 'DIV' AS type, entry_number AS reference,
        COALESCE(recipient, '') || ' - ' || COALESCE(description, 'Dividend') AS description,
        0 AS receipt_amount, amount AS payment_amount
      FROM dividend_account
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      -- Loan transactions: Disbursement is inflow, Principal + Interest are outflow.
      -- LOAN-IN tagged for inflow; LOAN-PRIN / LOAN-INT distinguish outflow types.
      SELECT lt.date,
        CASE lt.type
          WHEN 'Disbursement' THEN 'LOAN-IN'
          WHEN 'Principal'    THEN 'LOAN-PRIN'
          ELSE                     'LOAN-INT'
        END AS type,
        lt.transaction_number AS reference,
        COALESCE(l.lender_name, '') || ' - ' || lt.type || COALESCE(' (' || lt.description || ')', '') AS description,
        CASE WHEN lt.type='Disbursement' THEN lt.amount ELSE 0 END AS receipt_amount,
        CASE WHEN lt.type IN ('Principal','Interest') THEN lt.amount ELSE 0 END AS payment_amount
      FROM loan_transactions lt
      LEFT JOIN loans l ON l.sync_id = lt.loan_sync_id
      WHERE lt.deleted_at IS NULL AND lt.tenant_id = ?${dateFilter.replace(/date/g, 'lt.date')}
      ORDER BY date ASC, reference ASC
    `).all(tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams);

    let balance = openingBalance;
    const rows = entries.map((e, i) => {
      balance = balance + parseFloat(e.receipt_amount) - parseFloat(e.payment_amount);
      return { ...e, id: i + 1, balance };
    });

    res.json({ openingBalance, openingByMethod, entries: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats — per-method receipts, payments, and balances (the cards on the page)
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const opening = getOpeningByMethod(tenantId);
    const { from, to } = req.query;
    const df = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const dp = [...(from ? [from] : []), ...(to ? [to] : [])];

    // Period inflows/outflows for each method
    const cash = sumMethod(tenantId, 'cash_amount', df, dp);
    const bank = sumMethod(tenantId, 'bank_amount', df, dp);
    const momo = sumMethod(tenantId, 'momo_amount', df, dp);

    // Folded openings (carry pre-period activity into the opening when a `from` is set)
    let openingByMethod = { ...opening };
    if (from) {
      ['cash_amount', 'bank_amount', 'momo_amount'].forEach((col) => {
        const key = col.replace('_amount', '');
        const b = sumMethod(tenantId, col, ' AND date < ?', [from]);
        openingByMethod[key] = openingByMethod[key]
          + b.cr + b.capIn + b.loanIn
          - b.pv - b.ap - b.capOut - b.div - b.loanPrin - b.loanInt
          + b.transferNet;
      });
    }

    const currentByMethod = {
      cash: openingByMethod.cash + cash.cr + cash.capIn + cash.loanIn - cash.pv - cash.ap - cash.capOut - cash.div - cash.loanPrin - cash.loanInt + cash.transferNet,
      bank: openingByMethod.bank + bank.cr + bank.capIn + bank.loanIn - bank.pv - bank.ap - bank.capOut - bank.div - bank.loanPrin - bank.loanInt + bank.transferNet,
      momo: openingByMethod.momo + momo.cr + momo.capIn + momo.loanIn - momo.pv - momo.ap - momo.capOut - momo.div - momo.loanPrin - momo.loanInt + momo.transferNet,
    };
    const totalReceipts   = cash.cr + bank.cr + momo.cr;
    const totalPV         = cash.pv + bank.pv + momo.pv;
    const totalAP         = cash.ap + bank.ap + momo.ap;
    const totalCapIn      = cash.capIn  + bank.capIn  + momo.capIn;
    const totalCapOut     = cash.capOut + bank.capOut + momo.capOut;
    const totalDividend   = cash.div    + bank.div    + momo.div;
    const totalLoanIn     = cash.loanIn   + bank.loanIn   + momo.loanIn;
    const totalLoanPrin   = cash.loanPrin + bank.loanPrin + momo.loanPrin;
    const totalLoanInt    = cash.loanInt  + bank.loanInt  + momo.loanInt;
    const totalPayments   = totalPV + totalAP + totalCapOut + totalDividend + totalLoanPrin + totalLoanInt;
    const openingBalance = openingByMethod.cash + openingByMethod.bank + openingByMethod.momo;
    const currentBalance = currentByMethod.cash + currentByMethod.bank + currentByMethod.momo;

    res.json({
      openingBalance, openingByMethod,
      totalReceipts, totalPV, totalAP, totalPayments,
      totalCapIn, totalCapOut, totalDividend,
      totalLoanIn, totalLoanPrin, totalLoanInt,
      currentBalance, currentByMethod,
      // Per-method receipts/payments breakdown (for richer reporting later)
      methodFlows: { cash, bank, momo },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set opening balance(s).
// Accepts either { amount } (legacy single Cash opening) or
// { cash, bank, momo } (per-method). Stores up to 3 rows (one per non-zero method).
router.post('/opening-balance', auth, (req, res) => {
  try {
    const { amount, cash, bank, momo } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    // Use per-method if any are provided, otherwise fall back to legacy single amount → cash
    const usingSplit = cash !== undefined || bank !== undefined || momo !== undefined;
    const buckets = usingSplit
      ? [
          { ref: 'OB-CASH', amount: parseFloat(cash || 0) || 0 },
          { ref: 'OB-BANK', amount: parseFloat(bank || 0) || 0 },
          { ref: 'OB-MOMO', amount: parseFloat(momo || 0) || 0 },
        ]
      : [{ ref: 'OB-CASH', amount: parseFloat(amount || 0) || 0 }];

    db.transaction(() => {
      // Wipe any existing opening rows (legacy 'OB' included)
      db.prepare("DELETE FROM cash_book WHERE type = 'opening' AND tenant_id = ?").run(tenantId);
      const ins = db.prepare(`
        INSERT INTO cash_book (date, description, reference, receipt_amount, payment_amount, balance,
                               type, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (DATE('now'), ?, ?, ?, 0, ?, 'opening', ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      `);
      for (const b of buckets) {
        const label = b.ref === 'OB-BANK' ? 'Opening Bank Balance'
                    : b.ref === 'OB-MOMO' ? 'Opening MoMo Balance'
                    : 'Opening Cash Balance';
        ins.run(label, b.ref, b.amount, b.amount, randomUUID(), tenantId, branchId, deviceId);
      }
    })();

    res.json({ success: true, openingByMethod: getOpeningByMethod(tenantId) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Cash Transfers ──────────────────────────────────────────────────────────
// Money moved between methods (Cash <-> Bank <-> Mobile Money). Total cash on
// hand is unchanged; only the per-method breakdown shifts.

const VALID_METHODS = new Set(['Cash', 'Bank', 'Mobile Money']);

// List transfers
router.get('/transfers', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM cash_transfers t
      LEFT JOIN users u ON u.id = t.created_by
      WHERE t.deleted_at IS NULL AND t.tenant_id = ?
      ORDER BY t.date DESC, t.id DESC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create transfer
router.post('/transfers', auth, (req, res) => {
  try {
    const { date, from_method, to_method, amount, description } = req.body;
    if (!VALID_METHODS.has(from_method)) return res.status(400).json({ error: 'Invalid from_method.' });
    if (!VALID_METHODS.has(to_method))   return res.status(400).json({ error: 'Invalid to_method.' });
    if (from_method === to_method)       return res.status(400).json({ error: 'From and To must be different.' });
    const amt = parseFloat(amount || 0);
    if (!(amt > 0))                       return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const transferNum = syncConfig.generateNumber('TRF', 'cash_transfers');
    const transferDate = date || new Date().toISOString().split('T')[0];

    const info = db.prepare(`
      INSERT INTO cash_transfers (transfer_number, date, from_method, to_method, amount, description, created_by,
                                   sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(transferNum, transferDate, from_method, to_method, amt, description || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM cash_transfers WHERE id = ?').get(info.lastInsertRowid));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete transfer (soft delete)
router.delete('/transfers/:id', auth, (req, res) => {
  try {
    db.prepare("UPDATE cash_transfers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Transfer deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
