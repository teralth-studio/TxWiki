'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AUDIT_INSERT,
  cleanAuditDetail,
  describeAdminAction,
  createAdminAuditMiddleware,
} = require('../../scripts/admin-audit-log');

test('audit descriptions identify admin changes without recording secret fields', () => {
  assert.deepEqual(describeAdminAction('PUT', '/api/admin/captcha', {
    enabled: true, provider: 'turnstile', secret: 'never-store-this', siteKey: 'never-store-this-either',
  }), { actionKey: 'captcha.enabled', detail: 'Cloudflare Turnstile' });
  assert.deepEqual(describeAdminAction('PUT', '/api/admin/captcha', {
    enabled: false, provider: 'hcaptcha', secret: 'never-store-this',
  }), { actionKey: 'captcha.disabled', detail: '' });
  assert.deepEqual(describeAdminAction('POST', '/api/admin/smtp/test', {
    password: 'secret', testEmail: 'private@example.test',
  }), { actionKey: 'smtp.tested', detail: '' });
  assert.deepEqual(describeAdminAction('POST', '/api/admin/pages', {
    titles: { en: 'About us' }, content: { en: 'private text' },
  }), { actionKey: 'pages.created', detail: 'About us' });
});

test('audit details remove markup and control characters and stay bounded', () => {
  assert.equal(cleanAuditDetail('  <b>SMTP</b>\n\t updated  '), 'SMTP updated');
  assert.equal(cleanAuditDetail('a'.repeat(250)).length, 180);
  assert.equal(cleanAuditDetail({ secret: 'value' }), '');
});

test('admin audit middleware writes a successful mutation before returning its response', async () => {
  const calls = [];
  const pool = { async execute(sql, params) { calls.push([sql, params]); } };
  const middleware = createAdminAuditMiddleware(pool, { onError() {} });
  let response;
  const req = {
    method: 'PUT', path: '/api/admin/settings', body: { smtpPassword: 'do-not-log' },
    session: { user: { id: 8, username: 'admin' } },
  };
  const res = {
    statusCode: 200,
    json(payload) { response = payload; return this; },
  };
  middleware(req, res, () => res.json({ ok: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], AUDIT_INSERT);
  assert.deepEqual(calls[0][1], [8, 'admin', 'site.settings.updated', '']);
});

test('audit middleware skips errors, reads, and paths outside the admin API', async () => {
  let writes = 0;
  const middleware = createAdminAuditMiddleware({ async execute() { writes++; } }, { onError() {} });
  const invoke = async (method, path, statusCode) => {
    let responded = false;
    const req = { method, path, body: {}, session: { user: { id: 1, username: 'admin' } } };
    const res = { statusCode, json() { responded = true; return this; } };
    middleware(req, res, () => res.json({ ok: true }));
    await new Promise(resolve => setImmediate(resolve));
    return responded;
  };
  await invoke('PUT', '/api/admin/settings', 400);
  await invoke('GET', '/api/admin/logs', 200);
  await invoke('POST', '/api/auth/login', 200);
  assert.equal(writes, 0);
});
