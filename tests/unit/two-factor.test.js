const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');
const { createTwoFactor, registerTwoFactorRoutes, binding, sessionBinding } = require('../../scripts/two-factor');

test('TOTP secrets are authenticated encrypted and tokens cannot be replayed', () => {
  const crypto = createTwoFactor('a secret used exclusively for this test');
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const encrypted = crypto.encrypt(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(crypto.decrypt(encrypted), secret);
  assert.throws(() => createTwoFactor('another secret').decrypt(encrypted));
  const time = 1700000000000;
  const code = crypto.totp(secret).generate({ timestamp: time });
  const step = crypto.verify(secret, code, null, time);
  assert.equal(step, Math.floor(time / 30000));
  assert.equal(crypto.verify(secret, code, step, time), null);
  assert.equal(crypto.verify(secret, '123', null, time), null);
  assert.equal(crypto.verify(secret, code, null, time + 90000), null);
});

test('setup, recovery codes, challenge binding and disable are enforced server-side', async t => {
  const user = { id: 8, email: 'person@example.test', username: 'person', verified_at: new Date(), password_hash: 'stored', role: 'user', is_primary_admin: 0, must_change_password: 0, two_factor_secret: null, two_factor_recovery_codes: null, two_factor_last_step: null };
  let locked = false;
  const waiters = [];
  function unlock() {
    locked = false;
    if (waiters.length) waiters.shift()();
  }
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {
          while (locked) await new Promise(resolve => waiters.push(resolve));
          locked = true;
        },
        async execute(sql, params) {
          if (sql.startsWith('SELECT')) return [[{ ...user }]];
          if (sql.includes('SET two_factor_secret=?')) {
            [user.two_factor_secret, user.two_factor_recovery_codes, user.two_factor_last_step] = params;
          } else if (sql.includes('SET two_factor_recovery_codes=?')) {
            user.two_factor_recovery_codes = params[0];
          } else if (sql.includes('SET two_factor_last_step=?')) {
            user.two_factor_last_step = params[0];
          } else if (sql.includes('SET two_factor_secret=NULL')) {
            user.two_factor_secret = null; user.two_factor_recovery_codes = null; user.two_factor_last_step = null;
          } else throw new Error('Unexpected SQL: ' + sql);
          return [{ affectedRows: 1 }];
        },
        async commit() { unlock(); },
        async rollback() { unlock(); },
        release() {},
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test session secret is sufficiently long', resave: false, saveUninitialized: false }));
  app.post('/test/sign-in', (req, res) => {
    req.session.user = { id: user.id };
    res.json({ ok: true });
  });
  app.post('/test/pending', (req, res) => {
    req.session.pendingTwoFactor = { id: user.id, binding: binding(user), expires: Date.now() + (req.body.expired ? -1 : 60000) };
    res.json({ ok: true });
  });
  app.get('/test/session', (req, res) => res.json({ user: req.session.user || null, pending: !!req.session.pendingTwoFactor, stamp: req.session.twoFactorBinding || null }));
  const invalidations = [], notifications = [], logins = [];
  registerTwoFactorRoutes(app, {
    pool, query: async () => [{ ...user }],
    auth: (req, res, next) => req.session.user ? next() : res.sendStatus(401),
    limiter: rateLimit({ windowMs: 60000, limit: 12, keyGenerator: req => String(req.session.user?.id || req.session.pendingTwoFactor?.id), handler: (req, res) => res.status(429).json({ error: 'rate limited' }) }),
    bcrypt: { compare: async password => password === 'correct' },
    sessionSecret: 'test server encryption secret',
    token: () => 'csrf',
    userView: value => ({ id: value.id, twoFactorEnabled: !!value.two_factor_secret }),
    invalidateUserSessions: async (id, except) => invalidations.push({ id, except }),
    notifySuccessfulLogin: (user, req) => logins.push({ id: user.id, agent: req.get('user-agent'), ip: req.ip }),
    notifySecurityChange: async (recipient, template, subject, req) => {
      notifications.push({ recipient, template, subject, agent: req.get('user-agent'), ip: req.ip });
      return true;
    },
  });
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(url, body, cookie = '', agent = 'Test-2FA-Client') {
    const response = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': agent, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, body: await response.json(), cookie: setCookie ? setCookie.split(';')[0] : cookie };
  }
  let sessionA = await call('/test/sign-in', {});
  const setup = await call('/api/auth/two-factor/setup', {}, sessionA.cookie);
  assert.equal(setup.status, 200);
  assert.match(setup.body.qr, /^data:image\/png;base64,/);
  const crypto = createTwoFactor('test server encryption secret');
  const invalid = await call('/api/auth/two-factor/activate', { code: '000' }, sessionA.cookie);
  assert.equal(invalid.status, 400);
  assert.equal(user.two_factor_secret, null);
  assert.equal(notifications.length, 0);
  const code = crypto.totp(setup.body.secret).generate();
  const activation = await call('/api/auth/two-factor/activate', { code }, sessionA.cookie);
  assert.equal(activation.status, 200);
  assert.equal(activation.body.codes.length, 10);
  assert.equal(new Set(activation.body.codes).size, 10);
  assert.notEqual(user.two_factor_secret, setup.body.secret);
  assert.ok(!user.two_factor_recovery_codes.includes(activation.body.codes[0]));
  assert.equal(invalidations.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].template, 'two_factor_enabled.html');
  assert.equal(notifications[0].subject, '2FA enabled');
  assert.equal(notifications[0].recipient.email, user.email);
  assert.equal(notifications[0].recipient.username, user.username);
  assert.equal(notifications[0].agent, 'Test-2FA-Client');
  assert.equal(notifications[0].ip, '127.0.0.1');
  const current = await call('/test/session', undefined, sessionA.cookie);
  assert.equal(current.body.stamp, sessionBinding(user.id, user.two_factor_secret));

  user.two_factor_last_step = null;
  const otpCode = crypto.totp(setup.body.secret).generate();
  const otpSession1 = await call('/test/pending', {});
  const otpSession2 = await call('/test/pending', {});
  assert.equal((await call('/api/auth/two-factor/verify', { code: otpCode }, otpSession1.cookie)).status, 200);
  assert.equal((await call('/api/auth/two-factor/verify', { code: otpCode }, otpSession2.cookie)).status, 400);
  assert.deepEqual(logins, [{ id: user.id, agent: 'Test-2FA-Client', ip: '127.0.0.1' }]);
  const pending1 = await call('/test/pending', {});
  const pending2 = await call('/test/pending', {});
  const before = await call('/test/session', undefined, pending1.cookie);
  assert.equal(before.body.user, null);
  const results = await Promise.all([
    call('/api/auth/two-factor/verify', { code: activation.body.codes[0], recovery: true }, pending1.cookie),
    call('/api/auth/two-factor/verify', { code: activation.body.codes[0], recovery: true }, pending2.cookie),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.deepEqual(logins, [
    { id: user.id, agent: 'Test-2FA-Client', ip: '127.0.0.1' },
    { id: user.id, agent: 'Test-2FA-Client', ip: '127.0.0.1' },
  ]);
  const authenticated = results.find(result => result.status === 200);
  const after = await call('/test/session', undefined, authenticated.cookie);
  assert.equal(after.body.user.id, user.id);
  assert.equal(after.body.pending, false);
  assert.equal(after.body.stamp, sessionBinding(user.id, user.two_factor_secret));
  const expired = await call('/test/pending', { expired: true });
  assert.equal((await call('/api/auth/two-factor/verify', { code: activation.body.codes[1], recovery: true }, expired.cookie)).status, 401);
  const stale = await call('/test/pending', {});
  user.password_hash = 'changed';
  assert.equal((await call('/api/auth/two-factor/verify', { code: activation.body.codes[1], recovery: true }, stale.cookie)).status, 401);
  assert.equal((await call('/api/auth/two-factor/disable', { password: 'wrong' }, sessionA.cookie)).status, 400);
  assert.ok(user.two_factor_secret);
  assert.equal(notifications.length, 1);
  assert.equal((await call('/api/auth/two-factor/disable', { password: 'correct' }, sessionA.cookie, 'Disable-2FA-Client')).status, 200);
  assert.equal(user.two_factor_secret, null);
  assert.equal(user.two_factor_recovery_codes, null);
  assert.equal(invalidations.length, 2);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].template, 'two_factor_disabled.html');
  assert.equal(notifications[1].subject, '2FA disabled');
  assert.equal(notifications[1].recipient.email, user.email);
  assert.equal(notifications[1].recipient.username, user.username);
  assert.equal(notifications[1].agent, 'Disable-2FA-Client');
  assert.equal(notifications[1].ip, '127.0.0.1');
  assert.equal((await call('/api/auth/two-factor/disable', { password: 'correct' }, sessionA.cookie)).status, 400);
  assert.equal((await call('/api/auth/two-factor/disable', { password: 'correct' }, sessionA.cookie)).status, 429);
});

test('pending sessions are guarded and translations cover the 2FA messages', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(source, /if \(!req\.session\.pendingTwoFactor\) return next\(\)/);
  assert.match(source, /twoFactorSessionBinding\(req\.session\.user\.id, current\.two_factor_secret\)/);
  assert.match(source, /twoFactorLimiter[\s\S]*new MySqlRateLimitStore\('two-factor'\)/);
  assert.equal((source.match(/if \(previousTwoFactorBinding\) req\.session\.twoFactorBinding = previousTwoFactorBinding/g) || []).length, 2);
  for (const locale of ['en', 'es', 'de', 'fr', 'pt-BR']) {
    const strings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'languages', `language_${locale}.json`), 'utf8'));
    for (const key of ['Enable 2FA', 'Disable 2FA', 'Recovery codes', 'The code is invalid or has already been used.', 'The 2FA session expired. Sign in again.']) {
      assert.ok(strings[key], `${locale}: ${key}`);
    }
  }
});

test('password login creates only a restricted second-factor session', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/auth/login'");
  const end = source.indexOf("app.post('/api/auth/logout'", start);
  let handler;
  const user = { id: 8, password_hash: 'hash', verified_at: new Date(), two_factor_secret: 'encrypted' };
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (...args) => { handler = args.at(-1); } },
    loginLimiter() {}, loginAccountLimiter() {}, verifyCaptcha: async () => true, query: async () => [user],
    bcrypt: { compare: async () => true }, Buffer, Date, DUMMY_HASH: 'dummy',
    twoFactorBinding: binding, TWO_FACTOR_LIFETIME: 600000, token: () => 'csrf',
  });
  const req = { body: { email: 'person', password: 'correct' }, session: {} };
  req.session.regenerate = callback => {
    req.session = { save: done => done() };
    callback();
  };
  let result, failure;
  await handler(req, { json: value => { result = value; } }, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(result.pendingTwoFactor, true);
  assert.equal(req.session.user, undefined);
  assert.equal(req.session.pendingTwoFactor.id, user.id);
  assert.equal(req.session.pendingTwoFactor.binding, binding(user));
});

test('pending-session API guard permits only challenge, logout and bootstrap', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const marker = "app.use('/api', (req, res, next) => {\n  if (!req.session.pendingTwoFactor)";
  const start = source.indexOf(marker);
  const end = source.indexOf('\napp.use(', start + 1);
  let guard;
  vm.runInNewContext(source.slice(start, end), { app: { use: (base, handler) => { guard = handler; } } });
  for (const [url, allowed] of [
    ['/api/auth/me', true], ['/api/config', true], ['/api/auth/two-factor/verify', true],
    ['/api/auth/logout', true], ['/api/pages', false], ['/api/admin/users', false],
    ['/api/auth/password', false], ['/api/auth/two-factor/disable', false],
  ]) {
    let passed = false, status;
    const res = { status(value) { status = value; return this; }, json() {} };
    guard({ session: { pendingTwoFactor: { id: 8 } }, originalUrl: url }, res, () => { passed = true; });
    assert.equal(passed, allowed, url);
    if (!allowed) assert.equal(status, 403, url);
  }
});

test('existing sessions cannot bypass newly enabled or replaced 2FA', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const marker = "app.use('/api', async (req, res, next) => {\n  if (!req.session.user) return next();";
  const start = source.indexOf(marker);
  const end = source.indexOf('\nconst mustRotate', start);
  let guard, current;
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    app: { use: (base, handler) => { guard = handler; } },
    query: async () => current ? [current] : [],
    twoFactorSessionBinding: sessionBinding,
  });
  async function check(secret, stamp) {
    current = secret === undefined ? null : { two_factor_secret: secret };
    const req = { originalUrl: '/api/pages', session: { user: { id: 8 }, twoFactorBinding: stamp } };
    req.session.regenerate = done => { req.session = {}; done(); };
    let passed = false, status;
    await guard(req, { status(value) { status = value; return this; }, json() {} }, () => { passed = true; });
    return { passed, status };
  }
  assert.equal((await check(null, undefined)).passed, true);
  assert.equal((await check('new-secret', undefined)).status, 401);
  assert.equal((await check('new-secret', sessionBinding(8, 'new-secret'))).passed, true);
  assert.equal((await check('replacement', sessionBinding(8, 'new-secret'))).status, 401);
  assert.equal((await check(undefined, undefined)).status, 401);
});
