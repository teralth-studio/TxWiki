const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { loginDetails } = require('../../scripts/login-details');

const chromeWindows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const safariMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const chromeAndroid = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const edgeWindows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';
const request = (ip, agent) => ({ ip, get: name => name === 'user-agent' ? agent : undefined });

test('identifies browsers and operating systems with IPv4 and IPv6 addresses', () => {
  for (const [ip, agent, browser, os] of [
    ['192.0.2.9', chromeWindows, 'Chrome', 'Windows'],
    ['2001:db8::1', safariMac, 'Safari', 'macOS'],
    ['192.0.2.10', chromeAndroid, 'Chrome', 'Android'],
    ['::ffff:192.0.2.11', edgeWindows, 'Microsoft Edge', 'Windows'],
  ]) {
    assert.deepEqual(loginDetails(request(ip, agent)), {
      ip, login_ip: ip, login_platform: browser, login_device: os,
    });
  }
});

test('uses the requested IP fallback and labels unrecognized clients', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    assert.deepEqual(loginDetails(request(undefined, undefined)), {
      ip: '127.0.0.1', login_ip: '127.0.0.1', login_platform: 'Unknown', login_device: 'Unknown',
    });
    assert.equal(loginDetails(request('not-an-ip', 'unrecognized')).login_ip, '127.0.0.1');
    const failed = { get ip() { throw new Error('detection failed'); }, get: () => undefined };
    assert.equal(loginDetails(failed).login_ip, '127.0.0.1');
    assert.equal(warnings.length, 4);
  } finally { console.warn = originalWarn; }
});

test('ordinary password login passes the request to its success notification', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/auth/login'");
  const end = source.indexOf("\napp.post('/api/auth/logout'", start);
  let handler, notification;
  const user = { id: 8, password_hash: 'hash', verified_at: new Date(), two_factor_secret: null };
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (...args) => { handler = args.at(-1); } }, loginLimiter() {}, loginAccountLimiter() {},
    verifyCaptcha: async () => true, query: async () => [user], bcrypt: { compare: async () => true },
    Buffer, DUMMY_HASH: 'dummy', token: () => 'csrf', userView: value => ({ id: value.id }),
    notifySuccessfulLogin: (value, req) => { notification = { value, req }; },
  });
  const req = { body: { email: 'person', password: 'correct' }, session: {} };
  req.session.regenerate = done => { req.session = { save: callback => callback() }; done(); };
  let response, failure;
  await handler(req, { json: value => { response = value; } }, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(response.user.id, user.id);
  assert.equal(notification.value, user);
  assert.equal(notification.req, req);
});

test('login account limiter keys normalized identifiers without exposing them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('function loginAccountLimitKey(');
  const end = source.indexOf('\nconst loginAccountLimiter', start);
  assert.ok(start >= 0 && end > start);
  const context = { crypto: require('node:crypto') };
  vm.runInNewContext(source.slice(start, end), context);
  const key = context.loginAccountLimitKey({ body: { email: '  USER@example.test ' } });
  assert.equal(key, context.loginAccountLimitKey({ body: { email: 'user@example.test' } }));
  assert.notEqual(key, context.loginAccountLimitKey({ body: { email: 'other@example.test' } }));
  assert.doesNotMatch(key, /user|example/i);
  assert.match(source.slice(source.indexOf("app.post('/api/auth/login'"), source.indexOf("\napp.post('/api/auth/logout'")), /loginLimiter,\s*loginAccountLimiter,/);
});

test('successful login notification renders and queues the request details', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('function notifySuccessfulLogin(');
  const end = source.indexOf("\napp.post('/api/auth/login'", start);
  const renderStart = source.indexOf('const emailTemplate =');
  const renderEnd = source.indexOf('\nasync function notifySecurityChange', renderStart);
  assert.ok(start >= 0 && end > start && renderStart >= 0 && renderEnd > renderStart);
  const messages = [];
  const context = {
    fs, path, __dirname: path.join(__dirname, '..', '..'), Intl, Date,
    mailer: {}, loginDetails,
    enqueueMail: async (...args) => { messages.push(args); },
    console,
  };
  vm.runInNewContext(source.slice(renderStart, renderEnd) + '\n' + source.slice(start, end) + '\nthis.notify = notifySuccessfulLogin;', context);
  context.notify({ username: 'Alice', email: 'person@example.test' }, request('192.0.2.9', chromeWindows));
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], 'person@example.test');
  assert.equal(messages[0][1], 'New sign-in');
  assert.match(messages[0][2], /192\.0\.2\.9/);
  assert.match(messages[0][2], /Chrome/);
  assert.match(messages[0][2], /Windows/);
  assert.doesNotMatch(messages[0][2], /\{\{[a-z_]+\}\}/);
});
