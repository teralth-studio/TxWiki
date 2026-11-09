const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { senderEmailAddress, validEmailAddress } = require('../../scripts/auth/email-address');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
function route(pathname, nextPath, dependencies) {
  const start = source.indexOf(`app.post('${pathname}'`);
  const end = source.indexOf(`\napp.post('${nextPath}'`, start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const context = {
    app: { post: (...args) => { handler = args.at(-1); } },
    loginLimiter() {},
    senderEmailAddress,
    validEmailAddress,
    ...dependencies,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return handler;
}
function response() {
  return {
    code: 200,
    status(value) { this.code = value; return this; },
    set() { return this; },
    json(value) { this.body = value; return this; },
  };
}
test('password recovery queues a single-use link without changing the existing password', async () => {
  const sql = [], mails = [], invalidations = [];
  let matched = true, committed = false;
  const conn = {
    async beginTransaction() {},
    async execute(statement, params) { sql.push({ statement, params }); return [[]]; },
    async commit() { committed = true; },
    async rollback() {},
    release() {},
  };
  const handler = route('/api/auth/forgot', '/api/auth/reset', {
    verifyCaptcha: async () => true,
    mailer: {},
    query: async () => matched ? [{ id: 8, email: 'account@example.test', username: 'test' }] : [],
    token: () => 'reset-token',
    hash: value => `hash:${value}`,
    pool: { getConnection: async () => conn },
    enqueueMail: async (...args) => { mails.push(args); },
    emailTemplate: (name, values) => ({ name, values }),
    baseUrl: () => 'https://wiki.example.test',
    invalidateUserSessions: id => invalidations.push(id),
    Intl, Date,
  });
  let failure;
  const req = { body: { email: 'account@example.test', username: 'test' } }, res = response();
  await handler(req, res, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(committed, true);
  assert.equal(sql.some(item => /UPDATE users/i.test(item.statement)), false);
  assert.ok(sql.some(item => item.statement.includes('INSERT INTO account_tokens') && item.params[1] === 'hash:reset-token'));
  assert.equal(mails[0][2].name, 'password_reset.html');
  assert.equal(mails[0][1], 'Reset your password');
  assert.equal(mails[0][2].values.reset_link, 'https://wiki.example.test/reset?token=reset-token');
  assert.equal(invalidations.length, 0);
  matched = false;
  const missing = response();
  await handler(req, missing, error => { failure = error; });
  assert.equal(missing.body.message, res.body.message);
  assert.equal(mails.length, 1);
});

test('reset token is consumed atomically and old sessions are invalidated only after success', async () => {
  const sql = [], invalidated = [], notified = [];
  let tokenValid = true, committed = false;
  const conn = {
    async beginTransaction() {},
    async execute(statement) {
      sql.push(statement);
      if (statement.startsWith('SELECT id,user_id')) return [tokenValid ? [{ id: 1, user_id: 8 }] : []];
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() {},
    release() {},
  };
  const handler = route('/api/auth/reset', '/api/auth/reset-account', {
    verifyCaptcha: async () => true,
    pool: { getConnection: async () => conn },
    hash: value => value,
    bcrypt: { hash: async () => 'hash' },
    invalidateUserSessions: async id => { invalidated.push(id); },
    notifyPasswordReset: async id => { notified.push(id); },
    Buffer,
  });
  const req = { body: { token: 'valid', password: 'Valid123!' } }, res = response();
  let failure;
  await handler(req, res, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(committed, true);
  assert.deepEqual(invalidated, [8]);
  assert.deepEqual(notified, [8]);
  assert.ok(sql.some(statement => statement.includes('used_at=NOW()')));
  assert.ok(sql.some(statement => statement.includes('previous_password_hash=NULL')));
  tokenValid = false;
  committed = false;
  const expired = response();
  await handler(req, expired, error => { failure = error; });
  assert.equal(expired.code, 400);
  assert.equal(committed, false);
  assert.deepEqual(invalidated, [8]);
  assert.deepEqual(notified, [8]);
});

test('pending verification sessions are restricted to verification and session endpoints', () => {
  const start = source.indexOf("app.use('/api', (req, res, next) => {\n  if (!req.session.pendingVerification)");
  const end = source.indexOf('\napp.use(', start + 1);
  assert.ok(start >= 0 && end > start);
  let guard;
  vm.runInNewContext(source.slice(start, end), { app: { use: (path, handler) => { guard = handler; } } });
  for (const [url, allowed] of [['/api/auth/me', true], ['/api/auth/verify', true], ['/api/auth/resend-verification', true], ['/api/pages', false], ['/api/admin/users', false]]) {
    const res = response();
    let passed = false;
    guard({ session: { pendingVerification: 8 }, originalUrl: url }, res, () => { passed = true; });
    assert.equal(passed, allowed, url);
    if (!allowed) assert.equal(res.code, 403);
  }
});

test('verification resend requires a pending session and queues a fresh token transactionally', async () => {
  const sql = [], mails = [];
  let captchaCalls = 0, committed = false;
  const conn = {
    async beginTransaction() {},
    async execute(statement, params) {
      sql.push({ statement, params });
      if (statement.startsWith('SELECT id,email')) return [[{ id: 8, email: 'account@example.test', username: 'test', verified_at: null }]];
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() {},
    release() {},
  };
  const handler = route('/api/auth/resend-verification', '/api/auth/login', {
    verifyCaptcha: async () => { captchaCalls++; return true; },
    mailer: {},
    pool: { getConnection: async () => conn },
    token: () => 'verification-token',
    hash: value => `hash:${value}`,
    enqueueMail: async (...args) => { mails.push(args); },
    emailTemplate: (name, values) => ({ name, values }),
    baseUrl: () => 'https://wiki.example.test',
    Intl, Date,
  });
  let failure;
  const denied = response();
  await handler({ session: {}, body: {} }, denied, error => { failure = error; });
  assert.equal(denied.code, 401);
  assert.equal(captchaCalls, 0);
  const result = response();
  await handler({ session: { pendingVerification: 8 }, body: {} }, result, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(committed, true);
  assert.ok(sql.some(item => item.statement.includes("purpose='verify' AND used_at IS NULL")));
  assert.ok(sql.some(item => item.statement.includes('INSERT INTO account_tokens') && item.params[1] === 'hash:verification-token'));
  assert.equal(mails[0][2].name, 'register.html');
  assert.equal(mails[0][1], 'Confirm your account');
  assert.equal(mails[0][2].values.verify_link, 'https://wiki.example.test/verify?token=verification-token');
});

test('registration commits account, verification token and mail before creating a restricted session', async () => {
  const statements = [], events = [];
  const conn = {
    async beginTransaction() { events.push('begin'); },
    async execute(statement) {
      statements.push(statement);
      return [statement.startsWith('INSERT INTO users') ? { insertId: 8 } : { affectedRows: 1 }];
    },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
  };
  const handler = route('/api/auth/register', '/api/auth/resend-verification', {
    verifyCaptcha: async () => true,
    query: async statement => statement.includes('registration_enabled') ? [{ setting_value: true }] : [],
    json: value => value,
    mailer: {},
    bcrypt: { hash: async () => 'password-hash' },
    pool: { getConnection: async () => conn },
    token: () => 'random-token',
    hash: () => 'token-hash',
    enqueueMail: async (...args) => { assert.equal(args[1], 'Confirm your account'); assert.equal(args[3], conn); events.push('enqueue'); },
    emailTemplate: () => 'html',
    baseUrl: () => 'https://wiki.example.test',
    Buffer, Intl, Date,
  });
  const session = {
    regenerate(callback) { events.push('regenerate'); callback(); },
    save(callback) { events.push('save'); callback(); },
  };
  const result = response();
  let failure;
  await handler({ body: { email: 'account@example.test', username: 'test', password: 'Valid123!' }, session }, result, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(result.code, 202);
  assert.equal(result.body.pendingVerification.email, 'account@example.test');
  assert.equal(session.pendingVerification, 8);
  assert.equal(session.user, undefined);
  assert.ok(statements.some(statement => statement.includes('INSERT INTO account_tokens')));
  assert.deepEqual(events, ['begin', 'enqueue', 'commit', 'regenerate', 'save', 'release']);
});

test('password change requires a verified account and correct current password even when rotation is required', async () => {
  let verified = true, matches = false;
  const handler = route('/api/auth/password', '/api/auth/forgot', {
    auth() {},
    verifyCaptcha: async () => true,
    query: async () => [{
      id: 8, password_hash: 'hash', verified_at: verified ? 'date' : null,
      must_change_password: true, temporaryExpired: false,
    }],
    bcrypt: { compare: async () => matches },
    Buffer,
  });
  let failure;
  const req = { session: { user: { id: 8 } }, body: { currentPassword: 'wrong', password: 'Valid123!' } };
  const rejected = response();
  await handler(req, rejected, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(rejected.code, 400);
  verified = false;
  matches = true;
  const unverified = response();
  await handler(req, unverified, error => { failure = error; });
  assert.equal(unverified.code, 400);
});

test('successful password change queues the account notification and keeps its result', async () => {
  const notifications = [], invalidations = [];
  const user = { id: 8, username: 'Alice', email: 'person@example.test', password_hash: 'hash', verified_at: 'date' };
  const handler = route('/api/auth/password', '/api/auth/forgot', {
    auth() {},
    verifyCaptcha: async () => true,
    query: async statement => statement.startsWith('SELECT') ? [user] : [],
    bcrypt: { compare: async () => true, hash: async () => 'new-hash' },
    notifySecurityChange: async (...args) => { notifications.push(args); return true; },
    invalidateUserSessions: async id => { invalidations.push(id); },
    userView: value => ({ id: value.id }),
    token: () => 'csrf',
    Buffer,
  });
  const req = { body: { currentPassword: 'old', password: 'Valid123!' }, session: { user: { id: 8 } } };
  req.session.regenerate = done => { req.session = { save: callback => callback() }; done(); };
  const res = response();
  let failure;
  await handler(req, res, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(res.body.notificationQueued, true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0].email, user.email);
  assert.equal(notifications[0][0].username, user.username);
  assert.equal(notifications[0][1], 'password_changed.html');
  assert.equal(notifications[0][2], 'Password updated');
  assert.deepEqual(invalidations, [8]);
});

test('administrator password recovery queues an English subject', async () => {
  const start = source.indexOf("app.post(\n  '/api/admin/users/:id/reset-password'");
  const end = source.indexOf("\napp.get(\n  '/api/admin/users'", start);
  assert.ok(start >= 0 && end > start);
  const mails = [];
  const conn = {
    async beginTransaction() {},
    async execute(statement) {
      return statement.startsWith('SELECT')
        ? [[{ password_hash: 'old', previous_password_hash: null, must_change_password: false }]]
        : [{ affectedRows: 1 }];
    },
    async commit() {}, async rollback() {}, release() {},
  };
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (...args) => { handler = args.at(-1); } },
    auth() {}, adminRecoveryLimiter() {}, requirePermission: () => () => {},
    mailer: {}, query: async () => [[{ id: 8, email: 'person@example.test', username: 'Alice', is_primary_admin: false }]],
    generateTemporaryPassword: () => 'temporary', bcrypt: { hash: async () => 'hash' },
    pool: { getConnection: async () => conn },
    enqueueMail: async (...args) => mails.push(args), emailTemplate: name => name,
    invalidateUserSessions: async () => {}, Intl, Date,
  });
  let failure;
  const res = response();
  await handler({ params: { id: '8' } }, res, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(res.body.ok, true);
  assert.equal(mails[0][1], 'Temporary password');
  assert.equal(mails[0][2], 'temporary_password.html');
});
