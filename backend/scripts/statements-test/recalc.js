// Runs the app's own daily profit recalculation for every day of the test
// period on every branch (what the app does as transactions are saved).
const B = process.env.BACKEND || require('path').join(__dirname, '..', '..');
require(B + '/config/database');
const { getTenantDb } = require(B + '/config/tenantDb');
const { recalculateDailyProfit } = require(B + '/config/profitHelper');
const [from, to] = process.argv.slice(2);
for (const [slug, tid] of [['branch1', 'T1'], ['branch2', 'T2'], ['branch3', 'T3']]) {
  const db = getTenantDb(slug);
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    recalculateDailyProfit(db, d.toISOString().slice(0, 10), tid);
  }
}
console.log('RECALC OK');
