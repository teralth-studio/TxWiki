const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { loginDetails } = require('../../scripts/login-details');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const templates = {
  'register.html': ['username', 'verify_link'],
  'login_success.html': ['username', 'email', 'date', 'hour', 'login_ip', 'login_platform', 'login_device'],
  'password_changed.html': ['username', 'email'],
  'password_reset.html': ['username', 'email', 'reset_link'],
  'temporary_password.html': ['username', 'email', 'temporary_password', 'expires_at'],
  'two_factor_enabled.html': ['username', 'email', 'date', 'hour', 'login_ip', 'login_platform', 'login_device'],
  'two_factor_disabled.html': ['username', 'email', 'date', 'hour', 'login_ip', 'login_platform', 'login_device'],
};

function helpers(overrides = {}) {
  const start = source.indexOf('const emailTemplate =');
  const end = source.indexOf('\nconst auth =', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    fs, path, __dirname: root, Intl, Date, loginDetails,
    mailer: {},
    enqueueMail: async () => {},
    query: async () => [{ email: 'person@example.test', username: 'Alice' }],
    console: { warn() {}, error() {} },
    ...overrides,
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.render = emailTemplate; this.notify = notifySecurityChange; this.reset = notifyPasswordReset;', context);
  return context;
}

test('password change notification follows the account notification design', () => {
  const { render } = helpers();
  const html = render('password_changed.html', {
    username: 'Alice <Admin>', email: 'person@example.test', date: 'DATE', hour: 'TIME',
  });
  assert.match(html, /Teralth Studio/);
  assert.match(html, /System Notifications/);
  assert.match(html, /Password changed/);
  assert.match(html, /Hi, Alice &lt;Admin&gt;! Your password was changed\./);
  assert.match(html, /<strong>person@example\.test<\/strong>/);
  assert.doesNotMatch(html, /\{\{[a-z_]+\}\}/);
});

test('password reset email renders both working reset links and the expiry notice', () => {
  const { render } = helpers();
  const url = 'https://wiki.example.test/reset?token=abc&source=mail';
  const html = render('password_reset.html', {
    username: 'Alice <Admin>', email: 'person@example.test', reset_link: url,
  });
  assert.match(html, /Password change request/);
  assert.match(html, /Alice &lt;Admin&gt;/);
  assert.match(html, /<strong>person@example\.test<\/strong>/);
  assert.equal((html.match(/href="https:\/\/wiki\.example\.test\/reset\?token=abc&amp;source=mail"/g) || []).length, 2);
  assert.match(html, /This link expires in one hour/);
  assert.match(html, /If you did not request this change/);
  assert.doesNotMatch(html, /\{\{[a-z_]+\}\}/);
});

test('temporary password email renders escaped account details and expiration', () => {
  const { render } = helpers();
  const html = render('temporary_password.html', {
    username: 'Alice <Admin>', email: 'person@example.test',
    temporary_password: 'Pass<&123', expires_at: '12:30',
  });
  assert.match(html, /Teralth Studio/);
  assert.match(html, /Password reset/);
  assert.match(html, /Hi, Alice &lt;Admin&gt;!/);
  assert.match(html, /<strong>Email:<\/strong> person@example\.test/);
  assert.match(html, /<strong>Password:<\/strong> Pass&lt;&amp;123/);
  assert.match(html, /<strong>Expiration:<\/strong> 12:30 \(Ecuador time\)/);
  assert.match(html, /Sign in before it expires and choose a new password/);
  assert.doesNotMatch(html, /\{\{[a-z_]+\}\}/);
});

test('2FA notifications render the action details in the login notification design', () => {
  const { render } = helpers();
  for (const action of ['enabled', 'disabled']) {
    const html = render(`two_factor_${action}.html`, {
      username: 'Alice <Admin>', email: 'person@example.test', date: 'DATE', hour: 'TIME',
      login_ip: '192.0.2.9', login_platform: 'Chrome<&', login_device: 'Windows',
    });
    assert.match(html, /Teralth Studio/);
    assert.match(html, /System Notifications/);
    assert.ok(html.includes(`Two-factor authentication ${action}`));
    assert.match(html, /Hi, Alice &lt;Admin&gt;!/);
    assert.match(html, /<strong>Email:<\/strong> person@example\.test/);
    assert.match(html, /<strong>IP:<\/strong> 192\.0\.2\.9/);
    assert.match(html, /<strong>Platform:<\/strong> Chrome&lt;&amp; Windows/);
    assert.match(html, /<strong>Date:<\/strong> DATE TIME/);
    assert.doesNotMatch(html, /\{\{[a-z_]+\}\}/);
  }
});

test('all mail templates use their expected variables and escape interpolated values', () => {
  const { render } = helpers();
  for (const [name, keys] of Object.entries(templates)) {
    const template = fs.readFileSync(path.join(root, 'emails', name), 'utf8');
    const actual = [...new Set([...template.matchAll(/\{\{([a-z_]+)\}\}/g)].map(match => match[1]))].sort();
    assert.deepEqual(actual, [...keys].sort(), name);
    const values = Object.fromEntries(keys.map(key => [key, `value-${key}<&"'`]));
    const result = render(name, values);
    assert.doesNotMatch(result, /\{\{[a-z_]+\}\}/, name);
    for (const key of keys) assert.ok(result.includes(`value-${key}&lt;&amp;&quot;&#39;`), `${name}: ${key}`);
  }
  const result = render('password_changed.html', { username: 'Alice', email: '{{date}}@example.test', date: 'TODAY', hour: '12:00' });
  assert.ok(result.includes('{{date}}@example.test'));
});

test('security notifications queue account details, and log queue failures without failing the action', async () => {
  const sent = [], errors = [], warnings = [];
  const h = helpers({
    enqueueMail: async (...args) => { sent.push(args); },
    console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
  });
  const user = { username: 'Alice', email: 'person@example.test' };
  const req = {
    ip: '192.0.2.9',
    get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  };
  for (const name of ['two_factor_enabled.html', 'two_factor_disabled.html', 'password_changed.html']) {
    assert.equal(await h.notify(user, name, 'Test', name.startsWith('two_factor_') ? req : undefined), true);
    const [recipient, subject, html] = sent.at(-1);
    assert.equal(recipient, user.email);
    assert.equal(subject, 'Test');
    assert.match(html, /Alice/);
    assert.match(html, /person@example\.test/);
    assert.doesNotMatch(html, /\{\{/);
    if (name.startsWith('two_factor_')) {
      assert.match(html, /192\.0\.2\.9/);
      assert.match(html, /Chrome Windows/);
    }
  }
  assert.equal(await h.reset(8), true);
  assert.equal(sent.length, 4);
  assert.equal(sent.at(-1)[1], 'Password updated');
  const broken = helpers({
    enqueueMail: async () => { throw Object.assign(new Error('private data'), { code: 'TEST_FAILURE' }); },
    console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
  });
  assert.equal(await broken.notify(user, 'two_factor_enabled.html', 'Test'), false);
  assert.equal(errors.at(-1)[1], 'TEST_FAILURE');
  const noMailer = helpers({ mailer: null, console: { error() {}, warn: (...args) => warnings.push(args) } });
  assert.equal(await noMailer.notify(user, 'two_factor_enabled.html', 'Test'), false);
  assert.equal(warnings.length, 1);
});
