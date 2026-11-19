# Financial statements test kit

Builds 3 months (Aug to Oct 2026) of synthetic Sosna activity across Branch 1, Branch 2, Branch 3 (USD) and HQ in a throwaway folder, runs the real `/api/hq/income-statement`, `/balance-sheet` and `/cash-flow` code against it, and compares every line with figures calculated independently.

It also checks that the statements agree with each other:
* Cash Flow opening and closing cash equal Balance Sheet cash
* opening + net change + FX effect = closing
* change in retained earnings = net profit less dividends (flat rate scenario)

## Run

```
cd backend
npm install
python scripts/statements-test/run_test.py C:\temp\fs-test-1 const
python scripts/statements-test/run_test.py C:\temp\fs-test-2 drift
```

Use a new empty folder each time. It refuses to run in a folder that already has a database. Last line shows `checks=... failures=0` when everything matches.

`const` keeps K/USD at 25 and FRA/USD at 2900. `drift` moves both every day. An optional third argument changes the random seed.

Not covered yet: cash report over/short, stock reconciliation variance, supplier credit notes.

## Inspect a run

Generated SQLite databases and workbooks are test-only and intentionally excluded from Git. To inspect a run, use a fresh folder outside the app's data directories, then export its records:

```
python scripts/statements-test/run_test.py C:\temp\fs-inspect const
python scripts/statements-test/export_xlsx.py C:\temp\fs-inspect C:\temp\fs-inspect.xlsx
```

Open the workbook or the SQLite files in that test folder. Never point the test runner at the app's database folders.
