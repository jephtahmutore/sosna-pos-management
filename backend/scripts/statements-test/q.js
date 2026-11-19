// usage: node q.js <path?query> ...  — calls real routes/hq.js endpoints
const B = process.env.BACKEND || require('path').join(__dirname, '..', '..');
const express = require(B + '/node_modules/express');
const jwt = require(B + '/node_modules/jsonwebtoken');
const app = express(); app.use('/api/hq', require(B + '/routes/hq'));
const token = jwt.sign({ id: 1, role: 'Administrator' }, process.env.JWT_SECRET);
const srv = app.listen(5399, async () => {
  for (const p of process.argv.slice(2)) {
    const r = await fetch('http://127.0.0.1:5399/api/hq/' + p, { headers: { Authorization: 'Bearer ' + token } });
    const b = await r.json(); delete b.per_branch; delete b.plug_note;
    console.log('RESULT ' + p + ' ' + r.status + ' ' + JSON.stringify(b));
  }
  srv.close(); process.exit(0);
});
