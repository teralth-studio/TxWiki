'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { SqlitePool } = require('../../scripts/database');
const SqliteSessionStore = require('../../scripts/sqlite-session-store');
const { credentialBinding } = require('../../scripts/session-security');
const { sessionBinding } = require('../../scripts/two-factor');
const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8').replace(/\r\n/g, '\n');

function revoker(query, activeDatabaseType) {
  const start = source.indexOf('async function invalidateUserSessions(');
  const end = source.indexOf('\nasync function restoreExpiredTemporaryPassword', start);
  assert.ok(start >= 0 && end > start);
  const context = { query, activeDatabaseType, console };
  vm.runInNewContext(source.slice(start, end), context);
  return context.invalidateUserSessions;
}

test('SQLite revokes authenticated and pending sessions without revoking another user or the exception', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'txwiki-revoke-'));
  const pool = new SqlitePool(path.join(root, 'sessions.sqlite'));
  const store = new SqliteSessionStore(pool);
  const call = (method, ...args) => new Promise((resolve, reject) => store[method](...args, (err, result) => err ? reject(err) : resolve(result)));
  try {
    await store.onReady();
    for (const [sid, data] of Object.entries({ signed: { user: { id: 1 } }, pending: { pendingTwoFactor: { id: 1 } }, keep: { user: { id: 1 } }, other: { user: { id: 10 } } }))
      await call('set', sid, { cookie: {}, ...data });
    await revoker(async (sql, args) => (await pool.execute(sql, args))[0], 'sqlite')(1, 'keep');
    assert.equal(await call('get', 'signed'), null);
    assert.equal(await call('get', 'pending'), null);
    assert.equal((await call('get', 'keep')).user.id, 1);
    assert.equal((await call('get', 'other')).user.id, 10);
  } finally {
    clearInterval(store.pruneTimer);
    await pool.end();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MySQL revocation retains its store schema and exact user filtering', async () => {
  const removed = [];
  const query = async (sql, params) => {
    if (sql === 'SELECT session_id,data FROM sessions WHERE data LIKE ?') return [
      { session_id: 'a', data: '{"user":{"id":1}}' },
      { session_id: 'b', data: '{"pendingTwoFactor":{"id":1}}' },
      { session_id: 'keep', data: '{"user":{"id":1}}' },
      { session_id: 'other', data: '{"user":{"id":10}}' },
    ];
    assert.equal(sql, 'DELETE FROM sessions WHERE session_id=?');
    removed.push(params[0]);
    return [];
  };
  await revoker(query, 'mysql')(1, 'keep');
  assert.deepEqual(removed, ['a', 'b']);
});

test('a late save cannot restore authentication after password reset; legacy sessions fail closed', async () => {
  const start = source.indexOf("app.use('/api', async (req, res, next) => {\n  if (!req.session.user) return next();");
  const end = source.indexOf('\nconst mustRotate', start);
  assert.ok(start >= 0 && end > start);
  let guard;
  vm.runInNewContext(source.slice(start, end), {
    app: { use: (_base, handler) => { guard = handler; } },
    query: async () => [{ password_hash: 'reset-password-hash', two_factor_secret: null }],
    credentialBinding, twoFactorSessionBinding: sessionBinding,
  });
  for (const stamp of [credentialBinding(1, 'old-password-hash'), undefined, credentialBinding(2, 'reset-password-hash')]) {
    // Model an in-flight request saving its old authentication after revocation.
    const req = { originalUrl: '/api/profile', session: { user: { id: 1 }, credentialBinding: stamp } };
    req.session.regenerate = done => { req.session = {}; done(); };
    let status, passed = false;
    await guard(req, { status(value) { status = value; return this; }, json() {} }, error => { if (error) throw error; passed = true; });
    assert.equal(passed, false);
    assert.equal(status, 401);
  }
  const req = { session: { user: { id: 1 }, credentialBinding: credentialBinding(1, 'reset-password-hash') } };
  let passed = false;
  await guard(req, {}, error => { if (error) throw error; passed = true; });
  assert.equal(passed, true);
});

test('startup preserves custom admin-role authority but migrates the legacy system alias', async () => {
  const statement = source.match(/await query\("(UPDATE users SET role='administrator' WHERE role='admin'[^"\n]*)"\);/);
  assert.ok(statement, 'startup migration must exist');
  const pool = new SqlitePool(':memory:');
  try {
    await pool.execute('CREATE TABLE users (id INTEGER PRIMARY KEY,role TEXT)');
    await pool.execute('CREATE TABLE roles (role_key TEXT PRIMARY KEY,is_system INTEGER)');
    await pool.execute("INSERT INTO users VALUES (1,'admin')");
    await pool.execute("INSERT INTO roles VALUES ('admin',FALSE)");
    await pool.execute(statement[1]);
    assert.equal((await pool.execute('SELECT role FROM users WHERE id=1'))[0][0].role, 'admin');
    await pool.execute("UPDATE roles SET is_system=TRUE WHERE role_key='admin'");
    await pool.execute(statement[1]);
    assert.equal((await pool.execute('SELECT role FROM users WHERE id=1'))[0][0].role, 'administrator');
    await pool.execute("DELETE FROM roles WHERE role_key='admin'");
    await pool.execute("UPDATE users SET role='admin' WHERE id=1");
    await pool.execute(statement[1]);
    assert.equal((await pool.execute('SELECT role FROM users WHERE id=1'))[0][0].role, 'administrator');
  } finally { await pool.end(); }
});
