'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { SqlitePool } = require('../../scripts/database');
const { resolveSmtpPassword } = require('../../scripts/smtp-security');
const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8').replace(/\r\n/g, '\n');
function route(startMarker, endMarker, context) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), context);
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}
const next = error => { throw error; };

test('system role names and colors save to SQLite while submitted permissions stay immutable', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-role-test-'));
  const pool = new SqlitePool(path.join(directory, 'test.sqlite'));
  pool.db.exec(fs.readFileSync(path.join(__dirname, '../../schema.sqlite.sql'), 'utf8'));
  t.after(async () => { await pool.end(); fs.rmSync(directory, { recursive: true, force: true }); });
  const query = async (...args) => (await pool.query(...args))[0];
  await query("INSERT INTO roles(role_key,name,color,permissions,is_system) VALUES ('administrator','Administrator','#112233','[\"admin.view\"]',1),('user','User','#445566','[]',1)");
  await query("INSERT INTO users(id,email,username,password_hash,role,is_primary_admin) VALUES (1,'admin@example.test','admin','hash','administrator',1)");
  let handler;
  route("app.put('/api/admin/roles'", "\napp.get('/api/admin/smtp'", {
    app: { put: (...args) => { handler = args.at(-1); } }, auth() {}, requirePermission: () => () => {},
    query, pool, json: JSON.parse, rolePermissionKeys: ['admin.view'], rolePermissionsDefault: ['admin.view'],
    spaceSlugify: value => value.toLowerCase().replaceAll(' ', '-'),
    getRoleCatalog: () => query('SELECT role_key,name,color,permissions,is_system FROM roles ORDER BY role_key'),
  });
  const res = response();
  await handler({ session: { user: { id: 1 } }, body: { roles: [
    { roleKey: 'administrator', name: ' Owner ', color: '#abcdef', permissions: [] },
    { roleKey: 'user', name: ' Reader ', color: '#fedcba', permissions: ['admin.view'] },
  ] } }, res, next);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await query('SELECT role_key,name,color,permissions,is_system FROM roles ORDER BY role_key'), [
    { role_key: 'administrator', name: 'Owner', color: '#abcdef', permissions: '["admin.view"]', is_system: 1 },
    { role_key: 'user', name: 'Reader', color: '#fedcba', permissions: '[]', is_system: 1 },
  ]);
});

test('SMTP disable persists encrypted credentials and re-enable requires fresh proof', async () => {
  let handler, stored;
  const config = { enabled: true, host: 'smtp.example.test', port: 587, secure: false, user: 'sender', password: 'secret', from: 'wiki@example.test' };
  const context = {
    app: { put: (...args) => { handler = args.at(-1); } }, auth() {}, primaryAdminOnly() {},
    smtpConfig: { ...config }, mailer: {}, smtpProofs: new Map(), resolveSmtpPassword,
    query: async (_sql, args) => { stored = JSON.parse(args[0]); },
    encryptSmtpPassword: password => `encrypted:${password}`,
    smtpSignature: value => JSON.stringify(value), buildMailer: value => value.enabled === false ? null : {},
  };
  route("app.put('/api/admin/smtp'", "\napp.delete('/api/admin/users/:id'", context);
  await handler({ sessionID: 'session', body: { enabled: false } }, response(), next);
  assert.equal(stored.enabled, false);
  assert.equal(stored.passwordEncrypted, 'encrypted:secret');
  assert.equal(stored.password, undefined);
  assert.equal(context.mailer, null);
  const body = { enabled: true, ...config, password: '', testEmail: 'test@example.test' };
  const unproved = response();
  await handler({ sessionID: 'session', body }, unproved, next);
  assert.equal(unproved.statusCode, 428);
  assert.equal(stored.enabled, false);
  const { enabled, ...signatureConfig } = config;
  context.smtpProofs.set('session', { proof: 'proof', expires: Date.now() + 60000,
    signature: context.smtpSignature({ ...signatureConfig, testEmail: body.testEmail }) });
  const enabledResponse = response();
  await handler({ sessionID: 'session', body: { ...body, proof: 'proof' } }, enabledResponse, next);
  assert.equal(enabledResponse.statusCode, 200);
  assert.notEqual(stored.enabled, false);
  assert.equal(stored.passwordEncrypted, 'encrypted:secret');
  assert.ok(context.mailer);
  assert.equal(context.smtpProofs.has('session'), false);
});

test('backup schedule persists retention zero and the general settings zone; rejected retention does not write', async () => {
  let handler, stored, scheduled = 0;
  const context = {
    app: { put: (...args) => { handler = args.at(-1); } }, auth() {}, requirePermission: () => () => {},
    backupTimeZone: 'America/Guayaquil', backupRetentionCount: 5, backupCronExpression: '0 2 * * *',
    validateBackupCron: value => value, nextCronDate: () => new Date('2026-12-01T07:00:00Z'),
    query: async (_sql, args) => { stored = JSON.parse(args[0]); },
    pruneBackups: async () => {}, scheduleBackupJob: () => { scheduled++; },
  };
  const start = source.indexOf("app.put(\n  '/api/admin/backups/schedule'");
  const end = source.indexOf('\napp.', start + 1);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), context);
  const disabled = response();
  await handler({ body: { cron: '0 3 * * *', retention: 0, timeZone: 'UTC' } }, disabled, next);
  assert.deepEqual(stored, { cron: '0 3 * * *', retention: 0, timeZone: 'America/Guayaquil' });
  assert.equal(disabled.body.nextRunAt, null);
  assert.equal(context.backupRetentionCount, 0);
  assert.equal(scheduled, 1);
  for (const retention of [-1, 31, 1.5, 'invalid']) {
    const res = response();
    await handler({ body: { cron: '0 3 * * *', retention } }, res, next);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(scheduled, 1);
});
