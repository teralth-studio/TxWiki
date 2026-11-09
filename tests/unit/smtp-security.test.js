const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const express = require('express');
const { requirePrimaryAdmin, resolveSmtpPassword } = require('../../scripts/smtp-security');

test('stored SMTP credentials are reused only for the same endpoint, TLS mode and identity', () => {
  const saved = { host: 'smtp.example.test', port: 465, secure: true, user: 'user', password: 'stored-secret' };
  assert.equal(resolveSmtpPassword({ ...saved, password: '' }, saved), 'stored-secret');
  for (const change of [
    { host: 'attacker.example.test' }, { port: 587 }, { secure: false }, { user: 'other' },
  ]) {
    assert.throws(() => resolveSmtpPassword({ ...saved, ...change, password: '' }, saved), error => error.status === 400);
    assert.equal(resolveSmtpPassword({ ...saved, ...change, password: 'new-secret' }, saved), 'new-secret');
  }
  assert.equal(resolveSmtpPassword({ ...saved, user: '', password: '' }, saved), '');
});

test('SMTP endpoints require the current database user to be the primary administrator', async () => {
  const users = new Map([['1', { is_primary_admin: 1 }], ['2', { is_primary_admin: 0 }]]);
  const app = express();
  app.use((req, res, next) => { req.session = { user: { id: req.get('x-user') } }; next(); });
  const gate = requirePrimaryAdmin(async id => {
    if (id === '3') throw new Error('database unavailable');
    return users.get(id);
  });
  app.all('/smtp', gate, (req, res) => res.sendStatus(204));
  app.use((error, req, res, next) => res.sendStatus(500));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/smtp`;
    for (const method of ['GET', 'POST', 'PUT']) {
      for (const [id, status] of [['1', 204], ['2', 403], ['unknown', 403], ['3', 500]]) {
        assert.equal((await fetch(url, { method, headers: { 'x-user': id } })).status, status);
      }
    }
    users.set('1', { is_primary_admin: 0 });
    assert.equal((await fetch(url, { headers: { 'x-user': '1' } })).status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('all SMTP administration routes enforce the primary administrator gate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  for (const declaration of [
    "app.get('/api/admin/smtp', auth, primaryAdminOnly,",
    "app.post('/api/admin/smtp/test', auth, primaryAdminOnly,",
    "app.put('/api/admin/smtp', auth, primaryAdminOnly,",
  ]) assert.ok(source.includes(declaration));
});

test('installer SMTP test uses an English subject for both interface languages', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'launcher.js'), 'utf8');
  const start = source.indexOf("  app.post('/api/setup/test-smtp'");
  const end = source.indexOf("\n  app.post('/api/setup/install'", start);
  assert.ok(start >= 0 && end > start);
  const sent = [];
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (...args) => { handler = args.at(-1); } },
    setupLimiter() {}, authorizeSetup() {},
    validPort: () => true, validEmail: () => true, validSender: () => true,
    nodemailer: { createTransport: () => ({
      verify: async () => {},
      sendMail: async mail => { sent.push(mail); return { accepted: [mail.to] }; },
      close() {},
    }) },
    rememberSignature() {}, verifiedEmailSignatures: new Set(), emailSignature: () => 'signature',
  });
  for (const language of ['es', 'en']) {
    const req = { body: { smtpHost: 'smtp.example.test', smtpPort: 587, smtpTestEmail: 'person@example.test', smtpFrom: 'wiki@example.test', language } };
    const res = { json(value) { this.body = value; } };
    await handler(req, res);
    assert.equal(res.body.ok, true);
    assert.equal(sent.at(-1).subject, 'Teralth Studio SMTP test');
    assert.match(sent.at(-1).text, language === 'es' ? /Este es un correo/ : /This is a test email/);
  }
});
