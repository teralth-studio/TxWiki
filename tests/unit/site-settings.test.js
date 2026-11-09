const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSiteOptions, normalizeSupportUrl } = require('../../scripts/site-settings');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const support = {
  enabled: true,
  translations: { en: { title: 'Help', description: 'Ask us', button: 'Contact' } },
  background: '#112233', backgroundEnd: '#445566', buttonBackground: '#778899', buttonBackgroundEnd: '',
};
const seo = {
  description: 'Docs', indexable: true, socialTitle: '', socialDescription: '',
  socialImage: '/media/abcdefghijklmnop.webp', canonicalBase: 'https://example.test/docs',
};

test('site options validate translations, colors and SEO while preserving omitted settings', () => {
  const normalized = normalizeSiteOptions({ support, seo }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), { support, seo });
  assert.equal(Object.getPrototypeOf(normalized.support.translations), null);
  assert.deepEqual(normalizeSiteOptions({}, { support, seo }), { support, seo });
});

test('support translations are stored in a prototype-free map', () => {
  const translations = JSON.parse('{"en":{"title":"Help","description":"Ask us","button":"Contact"}}');
  const normalized = normalizeSiteOptions({ support: { ...support, translations } }, {});
  assert.equal(Object.getPrototypeOf(normalized.support.translations), null);
  assert.equal(normalized.support.translations.en.title, 'Help');
  assert.throws(
    () => normalizeSiteOptions({
      support: { ...support, translations: JSON.parse('{"__proto__":{"title":"x"}}') },
    }, {}),
    error => error.status === 400,
  );
});

test('support card visibility defaults to enabled and validates the saved toggle', () => {
  assert.equal(normalizeSiteOptions({ support: { ...support, enabled: false } }, {}).support.enabled, false);
  assert.equal(normalizeSiteOptions({ support: { ...support, enabled: true } }, {}).support.enabled, true);
  assert.equal(
    normalizeSiteOptions({ support: { ...support, enabled: undefined } }, { support: { enabled: false } }).support.enabled,
    false,
  );
  assert.equal(
    normalizeSiteOptions({ support: { ...support, enabled: undefined } }, {}).support.enabled,
    true,
  );
  assert.throws(
    () => normalizeSiteOptions({ support: { ...support, enabled: 'false' } }, {}),
    error => error.status === 400,
  );
});

test('support links accept web addresses, local paths and email but reject unsafe URLs', () => {
  for (const value of ['https://example.test/help', '/help', 'help@example.test', 'mailto:help@example.test', ''])
    assert.equal(normalizeSupportUrl(value), value);
  for (const value of ['javascript:alert(1)', '//example.test', 'https://user:pass@example.test', 'not-an-address'])
    assert.throws(() => normalizeSupportUrl(value), error => error.status === 400);
});

test('site options reject unsafe colors, invalid locales and URLs', () => {
  for (const bad of [
    { support: { ...support, background: 'url(https://example.test)' } },
    { support: { ...support, background: '', backgroundEnd: '#112233' } },
    { support: { ...support, translations: { '<script>': support.translations.en } } },
    { seo: { ...seo, canonicalBase: 'javascript:alert(1)' } },
    { seo: { ...seo, canonicalBase: 'https://example.test/?x=1' } },
    { seo: { ...seo, socialImage: '//example.test/image' } },
    { seo: { ...seo, indexable: 'false' } },
  ]) assert.throws(() => normalizeSiteOptions(bad, {}), error => error.status === 400);
});

test('settings endpoint independently enforces identity, support and SEO permissions', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf("app.put('/api/admin/settings'");
  const end = source.indexOf("\napp.put('/api/admin/pages/:slug'", start);
  assert.ok(start >= 0 && end > start);
  const oldSite = { name: 'Old name', logo: '', favicon: '/assets/favicon.svg', sidebarLabel: 'Documentation', extra: 'preserved' };
  let handler, written, allowed = true, permissionSet = null;
  const space = { slug: 'main', name: 'Main', icon: 'fa-solid fa-book-open', logo: '', sort_order: 0 };
  const query = async (sql, args) => {
    if (sql.startsWith('SELECT setting_value')) return [{ setting_value: oldSite }];
    if (sql.startsWith('SELECT slug,name')) return [space];
    if (sql.startsWith('SELECT slug FROM spaces')) return [space];
    if (sql.startsWith('INSERT INTO settings')) written = JSON.parse(args[0]);
    return [];
  };
  vm.runInNewContext(source.slice(start, end), {
    app: { put: (route, auth, fn) => { handler = fn; } }, auth() {}, query,
    json: value => value, normalizeSiteOptions, normalizeSupportUrl,
    canUser: async (_, permission) => allowed && (!permissionSet || permissionSet.has(permission)), spaceSlugify: value => value,
    validFontAwesomeIcon: () => true,
  });
  const request = { session: { user: { id: 1 } }, body: {
    name: 'New name', logo: '', spaces: [space], supportUrl: 'help@example.test',
    sidebarLabel: 'Footer', support, seo,
  } };
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
  const next = error => { throw error; };
  await handler(request, response, next);
  assert.equal(response.statusCode, 200);
  assert.equal(written.name, 'New name');
  assert.equal(written.pageTitle, 'New name');
  assert.equal(written.sidebarLabel, 'Footer');
  assert.equal(written.extra, 'preserved');
  assert.deepEqual(written.support, support);
  assert.deepEqual(written.seo, seo);
  written = undefined;
  await handler({
    ...request,
    body: { ...request.body, support: { ...support, enabled: false } },
  }, response, next);
  assert.equal(written.support.enabled, false);
  allowed = false;
  written = undefined;
  const denied = { ...response, statusCode: 200, body: undefined };
  await handler(request, denied, next);
  assert.equal(denied.statusCode, 403);
  assert.equal(written, undefined);
  allowed = true;
  for (const [permission, changes] of [
    ['settings.identity', { name: 'New name' }],
    ['settings.support', { supportUrl: 'help@example.test', support }],
    ['settings.seo', { seo }],
  ]) {
    const body = { name: oldSite.name, logo: '', spaces: [space], ...changes };
    permissionSet = new Set([permission]);
    const permitted = { ...response, statusCode: 200, body: undefined };
    await handler({ ...request, body }, permitted, next);
    assert.equal(permitted.statusCode, 200, permission);
    permissionSet = new Set();
    const forbidden = { ...response, statusCode: 200, body: undefined };
    await handler({ ...request, body }, forbidden, next);
    assert.equal(forbidden.statusCode, 403, permission);
  }
});
