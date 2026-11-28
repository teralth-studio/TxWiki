const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqlitePool } = require('../../scripts/database');
const { ensureProfileSchema } = require('../../scripts/profile-schema');
const { registerProfileRoutes } = require('../../scripts/profile-routes');
const { createSecretStore, validateConnection, providerIdentity } = require('../../scripts/oauth-providers');

test('OAuth configuration validates callback origin and encrypts secrets with authenticated encryption', async () => {
  const store = createSecretStore('test-secret'), encrypted = store.encrypt('client-secret');
  assert.equal(store.decrypt(encrypted), 'client-secret');
  assert.ok(!encrypted.includes('client-secret'));
  assert.throws(() => createSecretStore('wrong-key').decrypt(encrypted));
  for (const redirectUri of ['https://evil.test/auth/oauth/google/callback', 'https://wiki.test/auth/oauth/discord/callback', 'javascript:alert(1)'])
    assert.throws(() => validateConnection({ provider: 'google', clientId: 'id', clientSecret: 'secret', redirectUri }, 'https://wiki.test'));
  assert.equal(validateConnection({ provider: 'google', clientId: 'id', clientSecret: 'secret' }, 'https://wiki.test').redirectUri, 'https://wiki.test/auth/oauth/google/callback');
  const calls = [];
  const identity = await providerIdentity('github', { client_id: 'id', redirect_uri: 'https://wiki.test/auth/oauth/github/callback' }, 'code', 'verifier', 'secret', async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => calls.length === 1 ? { access_token: 'token' } : { id: 42, login: 'linked-user' } };
  });
  assert.deepEqual(identity, { subject: '42', displayName: 'linked-user' });
  assert.equal(calls[0][1].body.get('code_verifier'), 'verifier');
  assert.equal(calls[1][0], 'https://api.github.com/user');
  assert.ok(calls.every(([, options]) => options.redirect === 'error'));
});

test('profile routes isolate users, mask secrets, persist settings and reject unbound OAuth callbacks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'txwiki-profile-test-'));
  const pool = new SqlitePool(path.join(directory, 'test.sqlite')), secret = 'test-session-secret-test-session-secret';
  t.after(() => pool.end());
  await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE,email TEXT UNIQUE,password_hash TEXT,role TEXT,verified_at TEXT,must_change_password INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,two_factor_secret TEXT)');
  await pool.execute('INSERT INTO users (id,username,email,password_hash,role,verified_at) VALUES (1,?,?,?,?,CURRENT_TIMESTAMP)', ['alice', 'alice@example.test', 'hash', 'administrator']);
  await pool.execute('INSERT INTO users (id,username,email,password_hash,role,verified_at) VALUES (2,?,?,?,?,CURRENT_TIMESTAMP)', ['bob', 'bob@example.test', 'hash', 'user']);
  await ensureProfileSchema(pool); await ensureProfileSchema(pool);
  const query = async (sql, params = []) => (await pool.execute(sql, params))[0];
  const app = express(); app.use(express.json()); app.use(session({ secret, resave: false, saveUninitialized: false }));
  app.post('/test/session/:id', (req, res) => { req.session.user = { id: Number(req.params.id) }; res.json({ ok: true }); });
  const auth = (req, res, next) => req.session.user ? next() : res.sendStatus(401);
  let subject = 'google-alice', exchanges = 0, lastToken;
  app.get('/test/state', (req, res) => res.json({ user: req.session.user || null, pending: Boolean(req.session.pendingTwoFactor) }));
  app.post('/test/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  registerProfileRoutes(app, {
    pool, query, auth, limiter: (req, res, next) => next(), requirePermission: () => (req, res, next) => req.session.user.id === 1 ? next() : res.sendStatus(403), sessionSecret: secret,
    baseUrl: () => 'https://wiki.test', bcrypt: { compare: async value => value === 'correct' }, token: () => (lastToken = crypto.randomBytes(32).toString('hex')),
    userView: row => ({ id: row.id, username: row.username }), publicUserView: async row => ({ id: row.id, username: row.username, email: row.email }), invalidateUserSessions: async () => {}, notifySuccessfulLogin: () => {}, enqueueMail: async () => {},
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'txwiki-avatar-')), verifyCaptcha: async () => true, activeLanguages: async () => ['en', 'es'],
    resolveIdentity: async () => { exchanges++; return { subject, displayName: 'Alice at Google' }; },
  });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(origin + url, { method, redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  assert.equal((await request('/api/profile')).status, 401);
  await request('/test/session/1', 'POST');
  assert.equal((await request('/api/admin/connections/google', 'PUT', { clientId: 'google-id', clientSecret: 'private-secret', redirectUri: 'https://wiki.test/auth/oauth/google/callback' })).status, 200);
  const listed = await (await request('/api/admin/connections')).text();
  assert.ok(!listed.includes('private-secret') && !listed.includes('secret_ciphertext'));
  const rows = await query('SELECT secret_ciphertext FROM oauth_connections'); assert.ok(!rows[0].secret_ciphertext.includes('private-secret'));
  const profileResponse = await request('/api/profile', 'PUT', { username: 'alice-new', fullName: 'Alice Person', preferredLanguage: 'es' });
  assert.equal(profileResponse.status, 200, await profileResponse.text());
  assert.equal((await query('SELECT username FROM users WHERE id=1'))[0].username, 'alice-new');
  assert.equal((await query('SELECT username FROM users WHERE id=2'))[0].username, 'bob');
  assert.equal((await request('/api/profile/notifications', 'PUT', { loginNotifications: false })).status, 200);
  assert.equal((await query('SELECT login_notifications FROM user_profiles WHERE user_id=1'))[0].login_notifications, 0);
  const invalidAvatar = new FormData();
  invalidAvatar.append('avatar', new Blob(['<script>not-an-image</script>'], { type: 'image/png' }), 'avatar.png');
  assert.equal((await fetch(origin + '/api/profile/avatar', { method: 'POST', headers: { Cookie: cookie }, body: invalidAvatar })).status, 400);
  const png = await require('sharp')({ create: { width: 3, height: 3, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const validAvatar = new FormData();
  validAvatar.append('avatar', new Blob([png], { type: 'image/png' }), 'avatar.png');
  const avatar = await fetch(origin + '/api/profile/avatar', { method: 'POST', headers: { Cookie: cookie }, body: validAvatar });
  assert.equal(avatar.status, 200);
  assert.match((await avatar.json()).avatar, /^\/media\/[a-f0-9]{16}\.png$/);
  assert.equal((await request('/api/profile', 'PUT', { username: '<script>', fullName: 'Alice', preferredLanguage: 'es' })).status, 400);
  assert.equal((await request('/api/profile/email', 'POST', { email: 'new@example.test', password: 'wrong' })).status, 403);
  const start = await (await request('/api/profile/connections/google/start', 'POST', { password: 'correct' })).json();
  const authorization = new URL(start.url); assert.equal(authorization.hostname, 'accounts.google.com'); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const failed = await request('/auth/oauth/google/finish?state=wrong&code=attacker'); assert.equal(failed.status, 303); assert.match(failed.headers.get('location'), /oauth-failed/);
  assert.equal(exchanges, 0);
  const linkStart = new URL((await (await request('/api/profile/connections/google/start', 'POST', { password: 'correct' })).json()).url);
  const callback = `/auth/oauth/google/finish?state=${linkStart.searchParams.get('state')}&code=valid-code`;
  assert.equal((await request(callback)).headers.get('location'), '/profile/connections');
  assert.equal((await query('SELECT user_id FROM oauth_identities'))[0].user_id, 1);
  assert.match((await request(callback)).headers.get('location'), /oauth-failed/);
  assert.equal(exchanges, 1);
  await request('/test/logout', 'POST'); cookie = '';
  const loginStart = new URL((await (await request('/api/auth/oauth/google/start', 'POST', {})).json()).url);
  assert.equal((await request(`/auth/oauth/google/finish?state=${loginStart.searchParams.get('state')}&code=login-code`)).headers.get('location'), '/');
  assert.equal((await (await request('/test/state')).json()).user.id, 1);
  await query('UPDATE users SET two_factor_secret=? WHERE id=1', ['ciphertext']);
  await request('/test/logout', 'POST'); cookie = '';
  const secondFactorStart = new URL((await (await request('/api/auth/oauth/google/start', 'POST', {})).json()).url);
  assert.equal((await request(`/auth/oauth/google/finish?state=${secondFactorStart.searchParams.get('state')}&code=2fa-code`)).headers.get('location'), '/two-factor');
  assert.deepEqual(await (await request('/test/state')).json(), { user: null, pending: true });
  await request('/test/logout', 'POST'); cookie = ''; subject = 'never-linked';
  const unlinkedStart = new URL((await (await request('/api/auth/oauth/google/start', 'POST', {})).json()).url);
  assert.match((await request(`/auth/oauth/google/finish?state=${unlinkedStart.searchParams.get('state')}&code=unlinked-code`)).headers.get('location'), /oauth-unlinked/);
  await request('/test/session/2', 'POST');
  assert.equal((await request('/api/admin/connections')).status, 403);
  assert.equal((await request('/api/profile/connections/google', 'DELETE', { password: 'wrong' })).status, 403);
  assert.equal((await request('/api/profile/email', 'POST', { email: 'new-bob@example.test', password: 'correct' })).status, 200);
  const emailToken = lastToken;
  assert.equal((await query('SELECT email FROM users WHERE id=2'))[0].email, 'bob@example.test');
  assert.equal((await request('/api/profile/email/confirm', 'POST', { token: 'wrong-token' })).status, 400);
  assert.equal((await request('/api/profile/email/confirm', 'POST', { token: emailToken })).status, 200);
  assert.equal((await query('SELECT email FROM users WHERE id=2'))[0].email, 'new-bob@example.test');
  await request('/test/session/2', 'POST');
  assert.equal((await request('/api/profile/email/confirm', 'POST', { token: emailToken })).status, 400);
});
