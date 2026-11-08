const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

test('CAPTCHA verifies tokens and distinguishes rejected tokens from service errors', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('function captchaServiceError(');
  const end = source.indexOf('\nfunction encryptSmtpPassword(', start);
  assert.ok(start >= 0 && end > start);
  let config = {
    enabled: true, provider: 'recaptcha', variant: 'v2_checkbox',
    siteKey: 'example-site-key', secretCiphertext: 'example-ciphertext',
  };
  let response = { success: true, hostname: 'wiki.example' };
  let request;
  const warnings = [];
  const context = {
    loadCaptchaConfig: async () => config,
    captchaVariants: { recaptcha: new Set(['v2_checkbox', 'v3']) },
    decryptCaptchaSecret: () => 'example-secret',
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, text: async () => JSON.stringify(response) };
    },
    process: { env: { BASE_URL: 'https://wiki.example' } },
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const req = { body: { captchaToken: 'example-token' }, hostname: 'wiki.example' };
  assert.equal(await context.verifyCaptcha(req, 'login'), true);
  assert.equal(request.options.body.get('response'), 'example-token');
  assert.equal(request.options.body.get('secret'), 'example-secret');
  assert.match(request.url, /google\.com\/recaptcha\/api\/siteverify$/);

  response = { success: false, 'error-codes': ['timeout-or-duplicate'] };
  assert.equal(await context.verifyCaptcha(req, 'login'), false);
  assert.match(warnings.at(-1), /timeout-or-duplicate/);
  response = { success: true, hostname: 'other.example' };
  assert.equal(await context.verifyCaptcha(req, 'login'), false);
  assert.match(warnings.at(-1), /hostname/);
  assert.match(warnings.at(-1), /wiki\.example/);
  assert.match(warnings.at(-1), /other\.example/);
  response = { success: true, hostname: 'example-token\ninjected' };
  assert.equal(await context.verifyCaptcha(req, 'login'), false);
  assert.doesNotMatch(warnings.at(-1), /example-token/);
  response = { success: false, 'error-codes': ['invalid-input-secret', 'example-secret'] };
  await assert.rejects(context.verifyCaptcha(req, 'login'), error =>
    error.code === 'CAPTCHA_CONFIGURATION_ERROR' && !error.message.includes('example-secret'));
  response = {};
  await assert.rejects(context.verifyCaptcha(req, 'login'), error => error.code === 'CAPTCHA_PROVIDER_ERROR');
  context.fetch = async () => { throw new Error('example-secret example-token'); };
  await assert.rejects(context.verifyCaptcha(req, 'login'), error =>
    error.code === 'CAPTCHA_PROVIDER_ERROR' && !error.message.includes('example-secret'));
  config = { enabled: true, provider: 'recaptcha', variant: 'v2_checkbox' };
  await assert.rejects(context.verifyCaptcha(req, 'login'), error => error.code === 'CAPTCHA_CONFIGURATION_ERROR');
  assert.equal(warnings.join(' ').includes('example-token'), false);
  assert.equal(warnings.join(' ').includes('example-secret'), false);
  config = { enabled: false };
  assert.equal(await context.verifyCaptcha(req, 'login'), true);
});

test('hCaptcha verifies the token and sitekey without trusting its informational hostname', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('function captchaServiceError(');
  const end = source.indexOf('\nfunction encryptSmtpPassword(', start);
  assert.ok(start >= 0 && end > start);
  const config = {
    enabled: true, provider: 'hcaptcha', variant: 'checkbox',
    siteKey: 'wiki-site-key', secretCiphertext: 'ciphertext',
  };
  let response = {}, request;
  const warnings = [];
  const context = {
    loadCaptchaConfig: async () => config,
    captchaVariants: { hcaptcha: new Set(['checkbox', 'invisible']) },
    decryptCaptchaSecret: () => 'secret',
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, text: async () => JSON.stringify(response) };
    },
    process: { env: { BASE_URL: 'https://docs.studio.example.com' } },
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const req = { body: { captchaToken: 'token' }, hostname: 'docs.studio.example.com' };
  for (const variant of ['checkbox', 'invisible']) {
    config.variant = variant;
    for (const hostname of ['docs.studio.example.com', 'example.com', 'not-provided', undefined]) {
      response = { success: true, hostname };
      assert.equal(await context.verifyCaptcha(req, 'login'), true, `${variant}: ${hostname}`);
      assert.equal(request.url, 'https://api.hcaptcha.com/siteverify');
      assert.equal(request.options.body.get('sitekey'), 'wiki-site-key');
      assert.equal(request.options.body.get('secret'), 'secret');
      assert.equal(request.options.body.get('response'), 'token');
    }
    for (const code of ['invalid-input-response', 'expired-input-response', 'already-seen-response']) {
      response = { success: false, 'error-codes': [code] };
      assert.equal(await context.verifyCaptcha(req, 'login'), false);
      assert.match(warnings.at(-1), new RegExp(code));
    }
    response = { success: false, 'error-codes': ['sitekey-secret-mismatch'] };
    await assert.rejects(context.verifyCaptcha(req, 'login'), error => error.code === 'CAPTCHA_CONFIGURATION_ERROR');
    req.body.captchaToken = '';
    assert.equal(await context.verifyCaptcha(req, 'login'), false);
    req.body.captchaToken = 'token';
  }
});

test('reCAPTCHA and Turnstile retain strict hostname and action checks', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('function captchaServiceError(');
  const end = source.indexOf('\nfunction encryptSmtpPassword(', start);
  assert.ok(start >= 0 && end > start);
  const config = {
    enabled: true, provider: 'recaptcha', variant: 'v2_checkbox',
    siteKey: 'site-key', secretCiphertext: 'ciphertext', minScore: 0.5,
  };
  let response;
  const context = {
    loadCaptchaConfig: async () => config,
    captchaVariants: {
      recaptcha: new Set(['v2_checkbox', 'v2_invisible', 'v3']),
      turnstile: new Set(['managed']),
    },
    decryptCaptchaSecret: () => 'secret',
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(response) }),
    process: { env: { BASE_URL: 'https://docs.studio.example.com' } },
    console: { warn() {} },
    URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const req = { body: { captchaToken: 'token' }, hostname: 'docs.studio.example.com' };
  for (const [provider, variant] of [
    ['recaptcha', 'v2_checkbox'], ['recaptcha', 'v2_invisible'],
    ['recaptcha', 'v3'], ['turnstile', 'managed'],
  ]) {
    config.provider = provider;
    config.variant = variant;
    response = { success: true, hostname: 'docs.studio.example.com', action: 'login', score: 0.9 };
    assert.equal(await context.verifyCaptcha(req, 'login'), true, variant);
    response.hostname = 'example.com';
    assert.equal(await context.verifyCaptcha(req, 'login'), false, variant);
    response.hostname = 'other.example.com';
    assert.equal(await context.verifyCaptcha(req, 'login'), false, variant);
    response.hostname = '';
    assert.equal(await context.verifyCaptcha(req, 'login'), false, variant);
    response.hostname = 'docs.studio.example.com';
    if (variant === 'v3' || provider === 'turnstile') {
      response.action = 'register';
      assert.equal(await context.verifyCaptcha(req, 'login'), false, variant);
    }
    if (variant === 'v3') {
      response.action = 'login';
      response.score = 0.4;
      assert.equal(await context.verifyCaptcha(req, 'login'), false);
    }
  }
});
