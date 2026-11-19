"""Export the synthetic Sosna test databases to one readable workbook."""
import sqlite3, json, subprocess, os, sys
import pandas as pd
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

TD = sys.argv[1]; OUT = sys.argv[2]
DBS = {'Branch 1': f'{TD}/tenants/branch1.db', 'Branch 2': f'{TD}/tenants/branch2.db',
       'Branch 3 (USD)': f'{TD}/tenants/branch3.db', 'HQ': f'{TD}/sosna.db'}
for p in [*DBS.values(), f'{TD}/master.db']:
    c = sqlite3.connect(p); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()

def q(book, sql):
    c = sqlite3.connect(DBS[book]); df = pd.read_sql_query(sql, c); c.close()
    df.insert(0, 'Book', book); return df
def allbooks(sql, books=None):
    return pd.concat([q(b, sql) for b in (books or DBS)], ignore_index=True)

BR = ['Branch 1', 'Branch 2', 'Branch 3 (USD)']
tabs = {}
tabs['Opening Balances'] = allbooks("SELECT date, reference, receipt_amount AS amount FROM cash_book WHERE type='opening'")
tabs['Products'] = allbooks("SELECT code, name, cost_price, selling_price FROM products", BR)
tabs['Customers'] = allbooks("SELECT name, sync_id FROM customers", BR)
tabs['Orders'] = allbooks("""SELECT o.order_number, o.created_at, c.name AS customer, o.total_amount, o.amount_received,
       o.status, o.selling_rate_k_used AS k_per_usd FROM orders o LEFT JOIN customers c ON c.sync_id = o.customer_sync_id
       ORDER BY o.created_at""", BR)
tabs['Stock Movements'] = allbooks("""SELECT sm.created_at, p.code AS product, sm.movement_type, sm.location, sm.quantity, sm.cost_at_sale
       FROM stock_movements sm JOIN products p ON p.sync_id = sm.product_sync_id ORDER BY sm.created_at""", BR)
tabs['Cash Receipts'] = allbooks("""SELECT receipt_number, date, amount, cash_amount, bank_amount, momo_amount,
       usd_amount, fra_amount, k_amount, source_type FROM cash_receipts ORDER BY date""", BR)
tabs['Customer Payments'] = allbooks("""SELECT cp.payment_date, c.name AS customer, cp.amount FROM customer_payments cp
       LEFT JOIN customers c ON c.sync_id = cp.customer_sync_id ORDER BY cp.payment_date""", BR)
tabs['Payment Vouchers'] = allbooks("""SELECT voucher_number, date, amount, cash_amount, bank_amount, momo_amount,
       usd_amount, fra_amount, k_amount, COALESCE(is_landed_cost,0) AS is_landed_cost FROM payment_vouchers ORDER BY date""")
tabs['HQ Suppliers'] = q('HQ', "SELECT name, sync_id FROM suppliers")
tabs['HQ Supplier GRNs'] = q('HQ', """SELECT g.grn_number, g.date, s.name AS supplier, g.total_amount FROM grn g
       JOIN suppliers s ON s.sync_id = g.supplier_sync_id ORDER BY g.date""")
tabs['HQ AP Payments'] = q('HQ', """SELECT a.payment_number, a.date, s.name AS supplier, a.amount, a.k_amount FROM ap_payments a
       JOIN suppliers s ON s.sync_id = a.supplier_sync_id ORDER BY a.date""")
tabs['Loans'] = allbooks("SELECT loan_number, lender_name, direction, principal_amount, start_date, status FROM loans")
tabs['Loan Transactions'] = allbooks("""SELECT lt.transaction_number, lt.date, l.loan_number, l.direction, lt.type, lt.amount,
       lt.usd_amount, lt.k_amount FROM loan_transactions lt JOIN loans l ON l.sync_id = lt.loan_sync_id ORDER BY lt.date""")
tabs['HQ Capital'] = q('HQ', "SELECT entry_number, date, type, amount FROM capital_account")
tabs['HQ Dividends'] = q('HQ', "SELECT entry_number, date, recipient, amount FROM dividend_account")
m = sqlite3.connect(f'{TD}/master.db')
tabs['Deposits to HQ'] = pd.read_sql_query("""SELECT deposit_number, deposit_date, from_slug AS from_branch, currency, amount, status
       FROM cash_deposits ORDER BY deposit_date""", m)
m.close()
tabs['Currency Exchanges'] = q('Branch 3 (USD)', "SELECT date, from_currency, from_amount, to_currency, to_amount, rate FROM currency_exchanges")
tabs['FX Rates'] = q('Branch 3 (USD)', "SELECT effective_date, sell_rate AS fra_per_usd, sell_rate_k AS k_per_usd FROM fx_rates ORDER BY effective_date")
tabs['Daily Profit Summary'] = allbooks("""SELECT date, revenue, cogs, damages, pv_total, interest_expense, gross_profit, net_profit
       FROM daily_profit_summary ORDER BY date""", BR)

# Statement results returned by the app's endpoints on this data
env = dict(os.environ, TENANTS_DIR=f'{TD}/tenants', MASTER_DB_PATH=f'{TD}/master.db', DB_PATH=f'{TD}/sosna.db', JWT_SECRET='testsecret')
QS = [f'income-statement?month=2026-{x:02d}' for x in (8, 9, 10)] + [f'cash-flow?month=2026-{x:02d}' for x in (8, 9, 10)] \
   + [f'balance-sheet?asOf={a}' for a in ('2026-08-31', '2026-09-30', '2026-10-31')]
out = subprocess.run(['node', 'q.js', *QS], cwd=os.path.dirname(os.path.abspath(__file__)), env=env, capture_output=True, text=True).stdout
got = {l.split(' ', 3)[1]: json.loads(l.split(' ', 3)[3]) for l in out.splitlines() if l.startswith('RESULT ')}
def flat(o, pre=''):
    for k, v in o.items():
        if isinstance(v, dict): yield from flat(v, pre + k + '.')
        elif isinstance(v, (int, float)) and not isinstance(v, bool): yield pre + k, v
rows = []
for name, cols in [('Income Statement', [f'income-statement?month=2026-{x:02d}' for x in (8, 9, 10)]),
                   ('Cash Flow Statement', [f'cash-flow?month=2026-{x:02d}' for x in (8, 9, 10)]),
                   ('Balance Sheet', [f'balance-sheet?asOf={a}' for a in ('2026-08-31', '2026-09-30', '2026-10-31')])]:
    keys = [k for k, _ in flat(got[cols[0]]) if not k.startswith(('fx.', 'period.'))]
    for k in keys:
        rows.append([name, k] + [dict(flat(got[c]))[k] for c in cols])
stmt = pd.DataFrame(rows, columns=['Statement', 'Line', 'Aug 2026 / 31 Aug', 'Sep 2026 / 30 Sep', 'Oct 2026 / 31 Oct'])

with pd.ExcelWriter(OUT, engine='openpyxl') as xw:
    pd.DataFrame().to_excel(xw, sheet_name='Summary')
    stmt.to_excel(xw, sheet_name='Statement Results', index=False)
    for n, df in tabs.items(): df.to_excel(xw, sheet_name=n, index=False)

wb = load_workbook(OUT)
F = 'Arial'; hdr_fill = PatternFill('solid', start_color='1F3864'); hdr_font = Font(name=F, bold=True, color='FFFFFF')
for ws in wb.worksheets:
    if ws.title == 'Summary': continue
    for cell in ws[1]: cell.font = hdr_font; cell.fill = hdr_fill; cell.alignment = Alignment(horizontal='center', wrap_text=True)
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.font = Font(name=F)
            if isinstance(cell.value, float): cell.number_format = '#,##0.00;(#,##0.00);-'
    for i, col in enumerate(ws.columns, 1):
        w = max(len(str(c.value)) if c.value is not None else 0 for c in list(col)[:300])
        ws.column_dimensions[get_column_letter(i)].width = min(max(10, w + 2), 45)
    ws.freeze_panes = 'A2'

s = wb['Summary']
s['A1'] = 'Sosna synthetic test data (Aug to Oct 2026)'; s['A1'].font = Font(name=F, bold=True, size=14)
notes = [
    'Made up data, not real Sosna figures. Generated by backend/scripts/statements-test/run_test.py (scenario const, seed 7).',
    'Books: Branch 1 and Branch 2 keep K, Branch 3 keeps USD (also takes FRA), HQ keeps K. K/USD 25 and FRA/USD 2900 all period.',
    'Branch amounts are in that branch\'s own currency. The Statement Results tab is in K, as returned by the app.',
    'All 131 checks passed on this data: every statement line matched an independent calculation.',
]
for i, t in enumerate(notes, 3): s.cell(row=i, column=1, value=t).font = Font(name=F)
s.cell(row=8, column=1, value='Tab').font = hdr_font; s.cell(row=8, column=1).fill = hdr_fill
s.cell(row=8, column=2, value='Rows').font = hdr_font; s.cell(row=8, column=2).fill = hdr_fill
r = 9
for ws in wb.worksheets:
    if ws.title in ('Summary',): continue
    s.cell(row=r, column=1, value=ws.title).font = Font(name=F)
    c = s.cell(row=r, column=2, value=f"=COUNTA('{ws.title}'!A:A)-1"); c.font = Font(name=F); c.number_format = '#,##0'
    r += 1
s.cell(row=r, column=1, value='Total rows').font = Font(name=F, bold=True)
c = s.cell(row=r, column=2, value=f'=SUM(B9:B{r-1})'); c.font = Font(name=F, bold=True); c.number_format = '#,##0'
s.column_dimensions['A'].width = 30; s.column_dimensions['B'].width = 12
wb.save(OUT)
print('WROTE', OUT, {n: len(d) for n, d in tabs.items()})
