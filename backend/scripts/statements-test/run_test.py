"""
Synthetic 3-month dataset (Aug–Oct 2026) for the HQ financial statements,
plus an INDEPENDENT calculation of what each statement should show.

usage: python3 run_test.py <empty_test_dir> <const|drift> [seed]
       (needs `npm install` done in backend/; never point it at a real data folder)

  const — K/USD 25 and FRA/USD 2900 all period, so accounting identities
          must hold to the cent.
  drift — rates move every day, testing currency conversion.

Steps: node init.js (app migrations) → insert data here → node recalc.js
(app's own daily profit job) → call the real endpoints (q.js) → compare.
"""
import sqlite3, random, subprocess, json, os, sys, uuid, datetime as dt
from collections import defaultdict

TD, SCEN = sys.argv[1], sys.argv[2]
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 7
rnd = random.Random(SEED)
S = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(TD, 'tenants'), exist_ok=True)
if os.listdir(os.path.join(TD, 'tenants')) or any(os.path.exists(os.path.join(TD, f)) for f in ('sosna.db', 'master.db')):
    sys.exit('test dir must be empty (no sosna.db / master.db / tenants) — use a new folder each run')
TD = os.path.abspath(TD)
ENV = dict(os.environ, TENANTS_DIR=os.path.join(TD, 'tenants'), MASTER_DB_PATH=os.path.join(TD, 'master.db'),
           DB_PATH=os.path.join(TD, 'sosna.db'), JWT_SECRET='testsecret')
def node(*a):
    r = subprocess.run(['node', *a], cwd=S, env=ENV, capture_output=True, text=True)
    if r.returncode: print(r.stdout[-2000:], r.stderr[-2000:]); sys.exit(1)
    return r.stdout
node('init.js')

START, END = dt.date(2026, 8, 1), dt.date(2026, 10, 31)
DAYS = [START + dt.timedelta(i) for i in range((END - START).days + 1)]
ds = lambda d: d.isoformat()
def k_rate(d):  # K per USD
    i = (d - START).days
    return 25.0 if SCEN == 'const' else round(25 + 0.04 * i + 0.3 * ((i * 7) % 5 - 2) / 2, 4)
def f_rate(d):  # FRA per USD
    i = (d - START).days
    return 2900.0 if SCEN == 'const' else round(2900 + 3 * i, 4)

con = {b: sqlite3.connect(f'{TD}/tenants/{b}.db') for b in ['branch1', 'branch2', 'branch3']}
con['hq'] = sqlite3.connect(f'{TD}/sosna.db')
master = sqlite3.connect(f'{TD}/master.db')
TID = {'branch1': 'T1', 'branch2': 'T2', 'branch3': 'T3', 'hq': 'local-only'}
NATIVE = {'branch1': 'k', 'branch2': 'k', 'branch3': 'usd', 'hq': 'k'}
u = lambda: str(uuid.uuid4())
def ins(db, table, **row):
    db.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))
seq = defaultdict(int)
def num(prefix):
    seq[prefix] += 1; return f'{prefix}-{seq[prefix]:05d}'
clock = defaultdict(int)
def ts(d):
    clock[ds(d)] += 1; s = clock[ds(d)]
    return f'{ds(d)} {8 + s // 3600:02d}:{(s // 60) % 60:02d}:{s % 60:02d}'

# ── Independent ledger kept by this script ───────────────────────────
flows = []                      # (book, date, line, usd, fra, k)  signed
cash = {b: defaultdict(float) for b in con}
def flow(b, d, line, usd=0.0, fra=0.0, k=0.0):
    flows.append((b, ds(d), line, usd, fra, k))
    cash[b]['usd'] += usd; cash[b]['fra'] += fra; cash[b]['k'] += k
pl = []                         # (book, date, item, native_amount)   item: rev cogs dmg pv hqpv intexp intinc
moves = []                      # (book, date, product, qty)
custtx = []                     # (book, date, cust, sold, cash_at_sale, paid)
loantx = []                     # (book, date, loan, signed_outstanding_change_native)
aptx = []                       # (date, supplier, signed)
capital = []                    # (date, signed K)
dividends = []                  # (date, K)
b3_order_rates = []             # (created_at, rate)
stock = {b: {} for b in ['branch1', 'branch2', 'branch3']}

# ── Opening position (31 Jul) ─────────────────────────────────────────
OPEN = {'branch1': [('OB-CASH', 20000), ('OB-BANK', 5000)], 'branch2': [('OB-CASH', 15000)],
        'branch3': [('OB-USD', 3000), ('OB-FRA', 2000000)], 'hq': [('OB-K', 100000), ('OB-USD', 1000)]}
for b, rows in OPEN.items():
    for ref, amt in rows:
        ins(con[b], 'cash_book', date='2026-07-31', reference=ref, receipt_amount=amt, type='opening', tenant_id=TID[b], sync_id=u())
        key = 'usd' if ref == 'OB-USD' else 'fra' if ref == 'OB-FRA' else 'k'
        cash[b][key] += amt

PRODUCTS = {}
for b, costs in [('branch1', [10, 25, 40, 80]), ('branch2', [12, 30, 45, 90]), ('branch3', [2, 5, 8, 15])]:
    PRODUCTS[b] = []
    mark = 1.35 if b == 'branch3' else 1.4
    for i, c in enumerate(costs):
        sid = u()
        ins(con[b], 'products', code=f'{b[-1]}P{i}', name=f'{b} product {i}', cost_price=c, avg_cost_price=c,
            selling_price=round(c * mark, 2), sync_id=sid, tenant_id=TID[b])
        PRODUCTS[b].append({'sid': sid, 'cost': c, 'price': round(c * mark, 2)})
        ins(con[b], 'stock_movements', location='sales', movement_type='opening', quantity=200,
            created_at='2026-07-31 08:00:00', product_sync_id=sid, tenant_id=TID[b], sync_id=u())
        stock[b][sid] = 200; moves.append((b, '2026-07-31', sid, 200))

CUST = {}
for b in ['branch1', 'branch2', 'branch3']:
    CUST[b] = []
    for nm in ['Acme Ltd', 'Bwalya Stores', 'Advance Co']:
        sid = u(); ins(con[b], 'customers', name=nm, sync_id=sid, tenant_id=TID[b]); CUST[b].append(sid)
cust_bal = defaultdict(float)

SUPP = []
for nm in ['Zambezi Breweries', 'Copperbelt Foods']:
    sid = u(); ins(con['hq'], 'suppliers', name=nm, sync_id=sid, tenant_id='local-only'); SUPP.append(sid)
supp_bal = defaultdict(float)

def k_split(v):
    """Split a K amount across cash/bank/momo like a K-only branch drawer."""
    a = round(v * rnd.choice([1, 1, 0.6, 0.5]), 2); b_ = round((v - a) * rnd.choice([1, 0.5]), 2)
    return {'cash_amount': a, 'bank_amount': b_, 'momo_amount': round(v - a - b_, 2)}

LOANS = {}
def loan(b, key, lender, principal, d, direction):
    sid = u()
    ins(con[b], 'loans', loan_number=num('LN'), lender_name=lender, principal_amount=principal, start_date=ds(d),
        status='Active', direction=direction, tenant_id=TID[b], sync_id=sid)
    lid = con[b].execute('SELECT id FROM loans WHERE sync_id=?', (sid,)).fetchone()[0]
    LOANS[key] = (b, sid, lid, direction)
def loan_tx(key, d, typ, amt):
    b, sid, lid, direction = LOANS[key]
    cur = 'usd' if NATIVE[b] == 'usd' else 'k'
    ins(con[b], 'loan_transactions', transaction_number=num('LT'), loan_id=lid, loan_sync_id=sid, date=ds(d), type=typ,
        amount=amt, **{f'{cur}_amount': amt}, tenant_id=TID[b], sync_id=u())
    rcv = direction == 'Receivable'
    sign_cash = {'Disbursement': -1 if rcv else 1, 'Principal': 1 if rcv else -1, 'Interest': 1 if rcv else -1}[typ]
    line = {('Disbursement', True): 'inv_loans_given', ('Disbursement', False): 'fin_loans_received',
            ('Principal', True): 'inv_loans_repaid', ('Principal', False): 'fin_loans_repaid',
            ('Interest', True): 'op_interest_received', ('Interest', False): 'op_interest_paid'}[(typ, rcv)]
    flow(b, d, line, **{cur: sign_cash * amt})
    if typ == 'Disbursement': loantx.append((b, ds(d), key, amt))
    elif typ == 'Principal':  loantx.append((b, ds(d), key, -amt))
    else: pl.append((b, ds(d), 'intinc' if rcv else 'intexp', amt))

# ── Day-by-day activity ───────────────────────────────────────────────
for d in DAYS:
    K, F = k_rate(d), f_rate(d)
    ins(con['branch3'], 'fx_rates', effective_date=ds(d), sell_rate=F, buy_rate=F - 50, sell_rate_k=K, buy_rate_k=K - 0.5,
        tenant_id='T3', sync_id=u())
    for b in ['branch1', 'branch2', 'branch3']:
        db, tid, usd_book = con[b], TID[b], NATIVE[b] == 'usd'
        # Sales
        for _ in range(rnd.randint(2, 5)):
            p = rnd.choice(PRODUCTS[b]); q = rnd.randint(1, 8)
            if stock[b][p['sid']] < q: continue
            total = round(q * p['price'], 2); cat = ts(d); osid = u()
            reversed_ = rnd.random() < 0.03
            credit = (not reversed_) and rnd.random() < 0.18
            cust = rnd.choice(CUST[b]) if credit else None
            received = 0.0 if not credit else rnd.choice([0.0, round(total / 2, 2)])
            if not credit: received = total
            extra = {'selling_rate_k_used': K, 'currency': 'USD'} if usd_book else {}
            if usd_book: b3_order_rates.append((cat, K))
            ins(db, 'orders', order_number=num(b + 'O'), total_amount=total, amount_received=received,
                status='Reversed' if reversed_ else 'Completed', created_at=cat, tenant_id=tid, sync_id=osid,
                customer_sync_id=cust, **extra)
            ins(db, 'stock_movements', location='sales', movement_type='sale', quantity=-q, created_at=cat,
                product_sync_id=p['sid'], tenant_id=tid, sync_id=u(), cost_at_sale=p['cost'])
            if reversed_:
                ins(db, 'stock_movements', location='sales', movement_type='sale_reverse', quantity=q, created_at=cat,
                    product_sync_id=p['sid'], tenant_id=tid, sync_id=u(), cost_at_sale=p['cost'])
                continue
            stock[b][p['sid']] -= q; moves.append((b, ds(d), p['sid'], -q))
            pl += [(b, ds(d), 'rev', total), (b, ds(d), 'cogs', q * p['cost'])]
            if cust: custtx.append((b, ds(d), cust, total, received, 0.0))
            if received > 0:
                if usd_book and rnd.random() < 0.3:
                    fra = round(received * F, 2)
                    ins(db, 'cash_receipts', receipt_number=num(b + 'CR'), amount=received, fra_amount=fra, date=ds(d), tenant_id=tid, sync_id=u())
                    flow(b, d, 'op_receipts', fra=fra)
                elif usd_book:
                    ins(db, 'cash_receipts', receipt_number=num(b + 'CR'), amount=received, usd_amount=received, date=ds(d), tenant_id=tid, sync_id=u())
                    flow(b, d, 'op_receipts', usd=received)
                else:
                    ins(db, 'cash_receipts', receipt_number=num(b + 'CR'), amount=received, **k_split(received), date=ds(d), tenant_id=tid, sync_id=u())
                    flow(b, d, 'op_receipts', k=received)
        # Customer payments (Advance Co sometimes overpays → customer advance)
        if rnd.random() < 0.15:
            cust = rnd.choice(CUST[b])
            owed = sum(s - c - pd for bb, _, cc, s, c, pd in custtx if bb == b and cc == cust)
            amt = round(owed * rnd.choice([0.5, 1]), 2) if owed > 1 else 0
            if cust == CUST[b][2] and rnd.random() < 0.5: amt = round(amt + (40 if usd_book else 900), 2)
            if amt > 0:
                ins(db, 'customer_payments', customer_sync_id=cust, amount=amt, payment_date=ds(d), tenant_id=tid, sync_id=u())
                custtx.append((b, ds(d), cust, 0.0, 0.0, amt))
                if usd_book:
                    ins(db, 'cash_receipts', receipt_number=num(b + 'CR'), amount=amt, usd_amount=amt, date=ds(d), tenant_id=tid, sync_id=u(), source_type='customer_payment')
                    flow(b, d, 'op_receipts', usd=amt)
                else:
                    ins(db, 'cash_receipts', receipt_number=num(b + 'CR'), amount=amt, **k_split(amt), date=ds(d), tenant_id=tid, sync_id=u(), source_type='customer_payment')
                    flow(b, d, 'op_receipts', k=amt)
        # Expenses
        if rnd.random() < 0.35:
            amt = round(rnd.uniform(5, 80), 2) if usd_book else round(rnd.uniform(100, 2000), 2)
            if usd_book:
                ins(db, 'payment_vouchers', voucher_number=num(b + 'PV'), amount=amt, usd_amount=amt, date=ds(d), tenant_id=tid, sync_id=u())
                flow(b, d, 'op_expenses', usd=-amt)
            else:
                ins(db, 'payment_vouchers', voucher_number=num(b + 'PV'), amount=amt, **k_split(amt), date=ds(d), tenant_id=tid, sync_id=u())
                flow(b, d, 'op_expenses', k=-amt)
            pl.append((b, ds(d), 'pv', amt))
        # Damages
        if rnd.random() < 0.05:
            p = rnd.choice(PRODUCTS[b]); q = rnd.randint(1, 3)
            if stock[b][p['sid']] >= q:
                ins(db, 'stock_movements', location='sales', movement_type='sales_return', quantity=-q, created_at=ts(d),
                    product_sync_id=p['sid'], tenant_id=tid, sync_id=u(), cost_at_sale=p['cost'])
                stock[b][p['sid']] -= q; moves.append((b, ds(d), p['sid'], -q)); pl.append((b, ds(d), 'dmg', q * p['cost']))
        # Restock: K branches via HQ supplier GRN (payable), Branch 3 via landed-cost PV (cash)
        for p in PRODUCTS[b]:
            if stock[b][p['sid']] < 60:
                q = 150; val = q * p['cost']
                ins(db, 'stock_movements', location='sales', movement_type='grn', quantity=q, created_at=ts(d),
                    product_sync_id=p['sid'], tenant_id=tid, sync_id=u())
                stock[b][p['sid']] += q; moves.append((b, ds(d), p['sid'], q))
                if usd_book:
                    ins(db, 'payment_vouchers', voucher_number=num(b + 'PV'), amount=val, usd_amount=val, is_landed_cost=1, date=ds(d), tenant_id=tid, sync_id=u())
                    flow(b, d, 'op_suppliers', usd=-val)
                else:
                    s = rnd.choice(SUPP)
                    ins(con['hq'], 'grn', grn_number=num('GRN'), date=ds(d), total_amount=val, supplier_sync_id=s, tenant_id='local-only', sync_id=u())
                    aptx.append((ds(d), s, val)); supp_bal[s] += val
        # Friday deposits to HQ
        if d.weekday() == 4:
            ccy = 'USD' if usd_book else 'K'
            key = ccy.lower()
            amt = round(cash[b][key] * 0.5, 2)
            if amt > (100 if usd_book else 1000):
                ins(master, 'cash_deposits', deposit_number=num('DEP'), sync_id=u(), from_slug=b, currency=ccy, amount=amt,
                    status='CONFIRMED', deposit_date=ds(d))
                flow(b, d, 'int_deposits', **{key: -amt}); flow('hq', d, 'int_deposits', **{key: amt})
        # Monday USD → FRA exchange at Branch 3
        if usd_book and d.weekday() == 0 and cash[b]['usd'] > 500:
            ins(db, 'currency_exchanges', sync_id=u(), scope='book', date=ds(d), from_currency='USD', from_amount=200,
                to_currency='FRA', to_amount=round(200 * F, 2), rate=F, tenant_id=tid)
            flow(b, d, 'int_exchanges', usd=-200, fra=round(200 * F, 2))

    # ── HQ ──
    hq = con['hq']
    if ds(d) == '2026-08-01':
        ins(hq, 'capital_account', entry_number=num('CAP'), date=ds(d), type='Injection', amount=50000, cash_amount=50000, tenant_id='local-only', sync_id=u())
        capital.append((ds(d), 50000)); flow('hq', d, 'fin_capital_in', k=50000)
    if ds(d) == '2026-09-15':
        ins(hq, 'capital_account', entry_number=num('CAP'), date=ds(d), type='Drawing', amount=5000, cash_amount=5000, tenant_id='local-only', sync_id=u())
        capital.append((ds(d), -5000)); flow('hq', d, 'fin_drawings', k=-5000)
    if ds(d) == '2026-10-20':
        ins(hq, 'dividend_account', entry_number=num('DIV'), date=ds(d), recipient='Shareholders', amount=3000, cash_amount=3000, tenant_id='local-only', sync_id=u())
        dividends.append((ds(d), 3000)); flow('hq', d, 'fin_dividends', k=-3000)
    hq_pvs = ([8000] if d.day in (1, 15) else []) + ([round(rnd.uniform(200, 1500), 2)] if rnd.random() < 0.2 else [])
    for amt in hq_pvs:
        ins(hq, 'payment_vouchers', voucher_number=num('HQPV'), amount=amt, k_amount=amt, date=ds(d), tenant_id='local-only', sync_id=u())
        flow('hq', d, 'op_expenses', k=-amt); pl.append(('hq', ds(d), 'hqpv', amt))
    if d.day % 10 == 0:
        for s in SUPP:
            amt = round(supp_bal[s] * 0.7, 2)
            if amt > 0:
                ins(hq, 'ap_payments', payment_number=num('AP'), amount=amt, k_amount=amt, date=ds(d), supplier_sync_id=s, tenant_id='local-only', sync_id=u())
                aptx.append((ds(d), s, -amt)); supp_bal[s] -= amt; flow('hq', d, 'op_suppliers', k=-amt)
    # Loans
    if ds(d) == '2026-08-03': loan('hq', 'R1', 'Staff loan A', 12000, d, 'Receivable'); loan_tx('R1', d, 'Disbursement', 12000)
    if ds(d) == '2026-09-10': loan('hq', 'R2', 'Staff loan B', 6000, d, 'Receivable'); loan_tx('R2', d, 'Disbursement', 6000)
    if ds(d) == '2026-08-05': loan('branch2', 'P1', 'Zanaco', 20000, d, 'Payable'); loan_tx('P1', d, 'Disbursement', 20000)
    if ds(d) == '2026-09-01': loan('branch3', 'P2', 'Ecobank USD', 1000, d, 'Payable'); loan_tx('P2', d, 'Disbursement', 1000)
    if d.day == 28:
        loan_tx('R1', d, 'Principal', 1000); loan_tx('R1', d, 'Interest', 120)
        if d.month == 10: loan_tx('R2', d, 'Principal', 500); loan_tx('R2', d, 'Interest', 60)
    if d.day == 25: loan_tx('P1', d, 'Principal', 2000); loan_tx('P1', d, 'Interest', 300)
    if d.day == 30 and d.month in (9, 10): loan_tx('P2', d, 'Principal', 100); loan_tx('P2', d, 'Interest', 15)

for c in [*con.values(), master]: c.commit(); c.close()
node('recalc.js', ds(START), ds(END))

# ── Expected figures (independent of the app) ─────────────────────────
def rates_as_of(asof):
    prior = sorted([r for r in b3_order_rates if r[0][:10] <= asof], reverse=True)[:30]
    if prior: kr = sum(r for _, r in prior) / len(prior)
    else: kr = sorted(b3_order_rates)[0][1]                    # earliest later rate
    fd = [d for d in DAYS if ds(d) <= asof]
    fr = f_rate(fd[-1]) if fd else f_rate(DAYS[0])
    return kr, fr
def day_k(dstr): return k_rate(dt.date.fromisoformat(dstr))
def day_f(dstr): return f_rate(dt.date.fromisoformat(dstr))
def conv_day(dstr, usd, fra, k): return k + usd * day_k(dstr) + fra / day_f(dstr) * day_k(dstr)

def exp_balance(asof):
    kr, fr = rates_as_of(asof)
    tok = lambda b, v: v * kr if NATIVE[b] == 'usd' else v
    c = {b: dict(cash[b]) for b in con}  # rebuild from openings + flows ≤ asof
    tot_cash = 0
    for b in con:
        pos = defaultdict(float)
        for ref, amt in OPEN[b]:
            pos['usd' if ref == 'OB-USD' else 'fra' if ref == 'OB-FRA' else 'k'] += amt
        for bb, dd, _, us, fa, kk in flows:
            if bb == b and dd <= asof: pos['usd'] += us; pos['fra'] += fa; pos['k'] += kk
        tot_cash += pos['k'] + pos['usd'] * kr + pos['fra'] / fr * kr
    inv = 0
    for b in PRODUCTS:
        cost = {p['sid']: p['cost'] for p in PRODUCTS[b]}
        inv += tok(b, sum(q * cost[s] for bb, dd, s, q in moves if bb == b and dd <= asof))
    ar = adv = 0
    for b in CUST:
        for cu in CUST[b]:
            o = sum(s - cs - pd for bb, dd, cc, s, cs, pd in custtx if bb == b and cc == cu and dd <= asof)
            if o > 0.01: ar += tok(b, o)
            elif o < -0.01: adv += tok(b, -o)
    lr = lp = 0
    for key, (b, *_r, direction) in LOANS.items():
        bal = sum(v for bb, dd, kk, v in loantx if kk == key and dd <= asof)
        if bal > 0.005:
            if direction == 'Receivable': lr += tok(b, bal)
            else: lp += tok(b, bal)
    ap = sum(max(0, sum(v for dd, ss, v in aptx if ss == s and dd <= asof)) for s in SUPP)
    capk = sum(v for dd, v in capital if dd <= asof)
    assets = tot_cash + ar + inv + lr; liab = adv + lp + ap
    return {'assets.cash': tot_cash, 'assets.accounts_receivable': ar, 'assets.inventory': inv,
            'assets.loans_receivable': lr, 'assets.total': assets, 'liabilities.customer_advances': adv,
            'liabilities.loans_payable': lp, 'liabilities.hq_payables': ap, 'liabilities.total': liab,
            'equity.capital': capk, 'equity.retained_earnings': assets - liab - capk}

def month_range(m):
    f = dt.date(2026, m, 1); t = (dt.date(2026, m + 1, 1) if m < 12 else dt.date(2027, 1, 1)) - dt.timedelta(1)
    return ds(f), ds(t), ds(f - dt.timedelta(1))

def exp_income(m):
    f, t, _ = month_range(m)
    tot = defaultdict(float)
    for b, dd, item, v in pl:
        if f <= dd <= t: tot[item] += v * day_k(dd) if NATIVE[b] == 'usd' else v
    net = tot['rev'] - tot['cogs'] - tot['dmg'] - tot['pv'] - tot['hqpv'] - tot['intexp'] + tot['intinc']
    return {'lines.revenue': tot['rev'], 'lines.cogs': tot['cogs'], 'lines.damages': tot['dmg'],
            'lines.branch_pv': tot['pv'], 'lines.hq_pv': tot['hqpv'], 'lines.interest_expense': tot['intexp'],
            'lines.interest_income': tot['intinc'], 'lines.net_profit': net}

def exp_cashflow(m):
    f, t, before = month_range(m)
    L = defaultdict(float)
    for b, dd, line, us, fa, kk in flows:
        if f <= dd <= t: L[line] += conv_day(dd, us, fa, kk)
    op = sum(L[x] for x in ['op_receipts', 'op_suppliers', 'op_expenses', 'op_interest_paid', 'op_interest_received'])
    inv = L['inv_loans_given'] + L['inv_loans_repaid']
    fin = sum(L[x] for x in ['fin_loans_received', 'fin_loans_repaid', 'fin_capital_in', 'fin_drawings', 'fin_dividends'])
    intl = L['int_deposits'] + L['int_exchanges']
    o, c = exp_balance(before)['assets.cash'], exp_balance(t)['assets.cash']
    return {'operating.receipts_from_customers': L['op_receipts'], 'operating.paid_to_suppliers': L['op_suppliers'],
            'operating.operating_expenses': L['op_expenses'], 'operating.interest_paid': L['op_interest_paid'],
            'operating.interest_received': L['op_interest_received'], 'operating.net': op,
            'investing.net': inv, 'financing.capital_injections': L['fin_capital_in'],
            'financing.dividends_paid': L['fin_dividends'], 'financing.net': fin,
            'internal.deposits_in_transit': L['int_deposits'], 'net_change_in_cash': op + inv + fin + intl,
            'opening_cash': o, 'closing_cash': c, 'fx_effect_on_cash': c - o - (op + inv + fin + intl)}

# ── Call the real endpoints ───────────────────────────────────────────
queries = []
for m in (8, 9, 10):
    queries += [f'income-statement?month=2026-{m:02d}', f'cash-flow?month=2026-{m:02d}']
for a in ['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31']:
    queries.append(f'balance-sheet?asOf={a}')
got = {}
for line in node('q.js', *queries).splitlines():
    if line.startswith('RESULT '):
        _, q, status, body = line.split(' ', 3); got[q] = json.loads(body)

def dig(o, path):
    for p in path.split('.'): o = o[p]
    return o
TOL = 0.05
fails = checks = 0
def compare(q, exp):
    global fails, checks
    for k, v in exp.items():
        checks += 1
        try: g = dig(got[q], k)
        except (KeyError, TypeError): fails += 1; print(f'  MISMATCH {q} {k}: app=MISSING expected={v:,.2f}'); continue
        if abs(g - v) > TOL:
            fails += 1; print(f'  MISMATCH {q} {k}: app={g:,.2f} expected={v:,.2f}')

for m in (8, 9, 10):
    compare(f'income-statement?month=2026-{m:02d}', exp_income(m))
    compare(f'cash-flow?month=2026-{m:02d}', exp_cashflow(m))
for a in ['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31']:
    compare(f'balance-sheet?asOf={a}', exp_balance(a))

# Cross-statement identities, using the APP's own numbers
ident = []
ends = {8: ('2026-07-31', '2026-08-31'), 9: ('2026-08-31', '2026-09-30'), 10: ('2026-09-30', '2026-10-31')}
for m, (a, b_) in ends.items():
    cf = {'opening_cash': 0, 'closing_cash': 0, 'fx_effect_on_cash': 0, **got[f'cash-flow?month=2026-{m:02d}']}; bs0 = got[f'balance-sheet?asOf={a}']; bs1 = got[f'balance-sheet?asOf={b_}']
    inc = got[f'income-statement?month=2026-{m:02d}']
    ident.append((f'{m:02d} CF opening = BS cash {a}', cf['opening_cash'], bs0['assets']['cash']))
    ident.append((f'{m:02d} CF closing = BS cash {b_}', cf['closing_cash'], bs1['assets']['cash']))
    ident.append((f'{m:02d} opening + flows + FX = closing', cf['opening_cash'] + cf['net_change_in_cash'] + cf['fx_effect_on_cash'], cf['closing_cash']))
    ident.append((f'{m:02d} BS balances', bs1['assets']['total'], bs1['liabilities']['total'] + bs1['equity']['total']))
    if SCEN == 'const':
        divs = sum(v for dd, v in dividends if a < dd <= b_)
        ident.append((f'{m:02d} ΔRetained earnings = net profit − dividends',
                      bs1['equity']['retained_earnings'] - bs0['equity']['retained_earnings'], inc['lines']['net_profit'] - divs))
        ident.append((f'{m:02d} FX effect on cash = 0 (flat rates)', cf['fx_effect_on_cash'], 0))
for name, x, y in ident:
    checks += 1
    ok = abs(x - y) <= TOL
    if not ok: fails += 1
    print(f'  {"PASS" if ok else "FAIL"}  {name}: {x:,.2f} vs {y:,.2f}')

n_orders = sum(1 for _ in b3_order_rates)
print(f'DATA  flows={len(flows)} stock_moves={len(moves)} pl_items={len(pl)} customer_tx={len(custtx)} '
      f'loan_tx={len(loantx)+sum(1 for x in pl if x[2] in ("intexp","intinc"))} ap_tx={len(aptx)}')
print('HEADLINE', json.dumps({
    m: {'revenue': round(got[f'income-statement?month=2026-{m:02d}']['lines']['revenue'], 2),
        'net_profit': round(got[f'income-statement?month=2026-{m:02d}']['lines']['net_profit'], 2),
        'cash_change': round(got[f'cash-flow?month=2026-{m:02d}']['net_change_in_cash'], 2),
        'fx_effect': round(got[f'cash-flow?month=2026-{m:02d}']['fx_effect_on_cash'], 2)} for m in (8, 9, 10)}))
print(f'SUMMARY scenario={SCEN} seed={SEED} checks={checks} failures={fails}')
