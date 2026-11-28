const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const { publicScripts, publicStaticOnly, sendPublicHtml, preparePublicAssets } = require('../../scripts/public-scripts');

test('prepared assets negotiate compression, retain validators across encodings, and support HEAD', async t => {
  await preparePublicAssets();
  const app = express();
  app.use(publicScripts, publicStaticOnly);
  app.get('/', sendPublicHtml('index.html'));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  const identity = await request('/styles.css', { 'Accept-Encoding': 'identity' });
  for (const encoding of ['gzip', 'br']) {
    const compressed = await request('/styles.css', { 'Accept-Encoding': encoding });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], encoding);
    assert.match(compressed.headers.vary, /Accept-Encoding/i);
    assert.ok(compressed.body.length < identity.body.length / 2);
    assert.deepEqual(encoding === 'br' ? zlib.brotliDecompressSync(compressed.body) : zlib.gunzipSync(compressed.body), identity.body);
    assert.equal(compressed.headers.etag, identity.headers.etag);
    const head = await request('/styles.css', { 'Accept-Encoding': encoding }, 'HEAD');
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], compressed.headers['content-length']);
    const fresh = await request('/styles.css', { 'Accept-Encoding': encoding, 'If-None-Match': identity.headers.etag });
    assert.equal(fresh.status, 304);
    assert.equal(fresh.body.length, 0);
  }
  const refused = await request('/styles.css', { 'Accept-Encoding': 'identity;q=0, gzip;q=0, br;q=0' });
  assert.equal(refused.status, 406);
  const plain = await request('/styles.css', { 'Accept-Encoding': 'gzip;q=0, br;q=0, identity;q=1' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, identity.body);
  const html = (await request('/')).body.toString();
  assert.doesNotMatch(html, /(?:src|href)=["']\/(?:error-screen\.js|errors\.css)/);
  const template = fs.readFileSync(require.resolve('../../public/index.html'), 'utf8');
  assert.doesNotMatch(template, /(?:src|href)=["']\/(?:error-screen\.js|errors\.css)/);
  assert.match(html, /src=["']\/app-[a-f0-9]{16}\.js/);
});

const source = fs.readFileSync(require.resolve('../../server.js'), 'utf8').replace(/\r\n/g, '\n');
test('checking any permission uses one database read and sees later role revocations', async () => {
  let count = 0, granted = ['pages.delete'];
  const start = source.indexOf('async function canUser('), end = source.indexOf('\nconst requirePermission', start);
  const context = { json: JSON.parse, query: async () => { count++; return [{ role: 'editor', is_primary_admin: false, permissions: JSON.stringify(granted) }]; } };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(await context.canUser(1, ['pages.create_edit', 'pages.delete']), true);
  assert.equal(count, 1);
  granted = [];
  assert.equal(await context.canUser(1, ['pages.create_edit', 'pages.delete']), false);
  assert.equal(count, 2);
});

test('configuration loads independent settings, spaces, and theme reads concurrently', async () => {
  let handler;
  const pending = [], calls = [];
  const defer = (name, value) => { calls.push(name); return new Promise(resolve => pending.push(() => resolve(value))); };
  const context = {
    app: { get: (_path, callback) => { handler = callback; } },
    query: sql => sql.includes('FROM spaces') ? defer('spaces', []) : defer('settings', []),
    resolveThemeState: () => defer('theme', { saved: { active: 'default' }, definition: {}, values: {} }),
    json: JSON.parse, backupTimeZone: 'UTC', defaultLanguageCatalog: [], process: { env: {} },
    publicThemeView: () => ({}), publicCaptchaConfig: () => ({}), normalizeHeaderLinks: () => [],
  };
  const start = source.indexOf("app.get('/api/config'"), end = source.indexOf("\napp.get('/api/admin/captcha'", start);
  vm.runInNewContext(source.slice(start, end), context);
  let body;
  const completion = handler({}, { json: value => { body = value; } }, error => { throw error; });
  assert.deepEqual(calls, ['settings', 'spaces', 'theme']);
  pending.forEach(resolve => resolve());
  await completion;
  assert.equal(body.site.timeZone, 'UTC');
  assert.equal(body.site.name, 'Teralth Wiki');
});
