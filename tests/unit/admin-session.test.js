const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { requireCurrentAdminSession } = require('../../scripts/admin-session');

test('admin session gate uses server-side state and fails closed', async () => {
  const app = express();
  const records = new Map([
    ['1', { must_change_password: 0 }],
    ['2', { must_change_password: 1 }]
  ]);
  app.use((req, res, next) => {
    const id = req.get('x-test-session');
    req.session = id ? { user: { id } } : {};
    next();
  });
  app.use('/api/admin', requireCurrentAdminSession(async id => {
    if (id === '3') throw new Error('database unavailable');
    return records.get(String(id));
  }));
  app.get('/api/admin/example', (req, res) => res.sendStatus(204));
  app.use((error, req, res, next) => res.status(503).json({ error: 'Unavailable' }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/admin/example`;
  try {
    for (const [headers, expected] of [
      [{}, 401],
      [{ 'x-test-session': '0' }, 401],
      [{ 'x-test-session': '1 OR 1=1' }, 401],
      [{ 'x-test-session': '99', 'x-forwarded-for': '127.0.0.1' }, 401],
      [{ 'x-test-session': '2' }, 428],
      [{ 'x-test-session': '3' }, 503],
      [{ 'x-test-session': '1' }, 204]
    ]) {
      assert.equal((await fetch(url, { headers })).status, expected);
    }
    records.set('1', { must_change_password: 1 });
    assert.equal((await fetch(url, { headers: { 'x-test-session': '1' } })).status, 428);
    records.delete('1');
    assert.equal((await fetch(url, { headers: { 'x-test-session': '1' } })).status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
