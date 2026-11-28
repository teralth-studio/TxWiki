const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const express = require('express');
const sanitize = require('sanitize-html');
const { SqlitePool } = require('../../scripts/database');
const { ensureProfileSchema } = require('../../scripts/profile-schema');
const { normalizeTags, publicationInput, publicPage, ensurePublicationSchema, registerPublicationRoutes } = require('../../scripts/page-publication');
const { capturePageRevision } = require('../../scripts/page-revisions');
const root = path.join(__dirname, '../..');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const safePageContent = value => Object.fromEntries(Object.entries(parse(value) || {}).map(([lang, value]) => [lang, sanitize(String(value))]));

test('publication fields reject malformed tags and flags and disable tags/WIP for redirects', () => {
  assert.deepEqual(normalizeTags([' Guide ', 'guide', 'Setup']), ['Guide', 'Setup']);
  for (const value of [['<script>'], [''], [42], Array(21).fill('x'), ['x'.repeat(51)]]) assert.throws(() => normalizeTags(value), { status: 400 });
  assert.throws(() => publicationInput({ isWip: 'false' }), { status: 400 });
  assert.throws(() => publicationInput({ publicationStatus: 'hidden' }), { status: 400 });
  assert.deepEqual(publicationInput({ pageType: 'redirect', isWip: true, tags: ['Guide'] }), { status: 'published', isWip: 0, tags: [] });
});

test('publication schema repairs legacy pages and revisions idempotently', async () => {
  const pool = new SqlitePool(':memory:');
  try {
    await pool.query('CREATE TABLE pages (id INTEGER PRIMARY KEY)');
    await pool.query('CREATE TABLE page_revisions (id INTEGER PRIMARY KEY)');
    await ensurePublicationSchema(pool); await ensurePublicationSchema(pool);
    for (const table of ['pages', 'page_revisions']) {
      await pool.query(`INSERT INTO ${table}(id) VALUES(1)`);
      const [[row]] = await pool.query(`SELECT * FROM ${table}`);
      assert.equal(row.publication_status, 'published'); assert.equal(row.is_wip, 0); assert.equal(row.tags, null);
    }
    const migrations = fs.readdirSync(path.join(root, 'migrations')).filter(file => /^20261127-publication-/.test(file));
    assert.equal(migrations.length, 6);
    const { singleSqlStatement } = require('../../scripts/site-updater');
    for (const file of migrations) assert.doesNotThrow(() => singleSqlStatement(fs.readFileSync(path.join(root, 'migrations', file), 'utf8')));
  } finally { await pool.end(); }
});

test('drafts remain private, WIP content is redacted, tags search stays in its space, and editors can publish drafts', async () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'txwiki-publication-'));
  const pool = new SqlitePool(path.join(directory, 'test.sqlite'));
  let server;
  try {
    for (const statement of fs.readFileSync(path.join(root, 'schema.sqlite.sql'), 'utf8').split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
    await ensureProfileSchema(pool);
    const query = async (sql, values = []) => (await pool.query(sql, values))[0];
    await query("INSERT INTO spaces(slug,name,icon,sort_order) VALUES('main','Main','fa-book',0),('other','Other','fa-book',1)");
    await query("INSERT INTO users(id,username,email,password_hash,role) VALUES(1,'Editor','editor@example.test','unused','administrator')");
    for (const [slug,space,status,wip,text] of [['guide','main','published',0,'Visible searchable body'],['draft','main','draft',0,'DRAFT_SECRET'],['wip','main','published',1,'WIP_SECRET'],['other','other','published',0,'OTHER_SECRET']])
      await query('INSERT INTO pages(space_slug,slug,titles,content,tags,publication_status,is_wip) VALUES(?,?,?,?,?,?,?)', [space,slug,JSON.stringify({ en: slug }),JSON.stringify({ en: '<p>'+text+'</p>' }),JSON.stringify(['Documentation']),status,wip]);
    await query("INSERT INTO settings(setting_key,setting_value) VALUES('site',?)", [JSON.stringify({ wipContent: { en: '<h1>Under maintenance</h1><script>unsafe()</script>' } })]);
    const app = express(); app.use(express.json());
    app.use((req,res,next) => { req.session = { user: req.get('X-Test-Editor') ? { id: 1, role: 'administrator', isPrimaryAdmin: true } : null }; next(); });
    const auth = (req,res,next) => req.session.user ? next() : res.status(401).json({ error: 'Unauthorized' });
    const requirePermission = () => (req,res,next) => req.session.user ? next() : res.status(403).json({ error: 'Forbidden' });
    const activeSpace = req => req.get('X-Wiki-Space') || 'main';
    registerPublicationRoutes(app, { query, auth, requirePermission, activeSpace, safePageContent });
    const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const context = { app, pool, query, auth, requirePermission, activeSpace, publicationInput, publicPage, safePageContent, activeDatabaseType: 'sqlite', json: parse, clean: value => sanitize(value), languageKeys: async()=>['en'], validLanguageCode: value => value === 'en', slugify: value => value, capturePageRevision, hash: value => crypto.createHash('sha256').update(value).digest('hex'), crypto, backupTimeZone: 'UTC', process: { env: { SESSION_SECRET: 'test-only' } }, console };
    const publicStart = source.indexOf('let lastDashboardRetention = 0;'), publicEnd = source.indexOf("app.post('/api/pages/:id/reactions'", publicStart);
    vm.runInNewContext(source.slice(publicStart, publicEnd), context);
    const saveStart = source.indexOf("app.put('/api/admin/pages/:slug'"), saveEnd = source.indexOf('\napp.get(', saveStart);
    vm.runInNewContext(source.slice(saveStart, saveEnd), context);
    app.use((error,req,res,next) => res.status(error.status || 500).json({ error: error.message }));
    server = await new Promise(resolve => { const listener = app.listen(0,'127.0.0.1',()=>resolve(listener)); });
    const origin = 'http://127.0.0.1:'+server.address().port;
    const request = async (url, options) => { const response = await fetch(origin+url,options); return { status: response.status, body: await response.json() }; };
    const listing = await request('/api/pages');
    assert.equal(listing.status, 200, JSON.stringify(listing.body)); assert.deepEqual(listing.body.pages.map(page => page.slug).sort(), ['guide','wip']);
    assert.equal((await request('/api/pages/draft')).status, 404);
    assert.equal((await request('/api/pages/draft', { headers: { 'X-Test-Editor': 'yes' } })).status, 404);
    const requestedDraft = await request('/api/pages?slug=draft', { headers: { 'X-Test-Editor': 'yes' } });
    assert.equal(requestedDraft.body.page, null); assert.doesNotMatch(JSON.stringify(requestedDraft.body), /DRAFT_SECRET/);
    const wip = await request('/api/pages/wip'); assert.match(wip.body.page.content.en, /Under maintenance/); assert.doesNotMatch(JSON.stringify(wip.body), /WIP_SECRET|script|unsafe/);
    assert.doesNotMatch(JSON.stringify((await request('/api/pages?slug=wip')).body), /WIP_SECRET|script|unsafe/);
    const search = await request('/api/search?q=secret'); assert.deepEqual(search.body.results, []);
    assert.equal((await request('/api/search?q=searchable&tag=Documentation')).body.results[0].slug, 'guide');
    assert.deepEqual((await request('/api/search?q=searchable', { headers: { 'X-Wiki-Space': 'other' } })).body.results, []);
    assert.equal((await request('/api/admin/pages')).status, 401);
    assert.equal((await request('/api/admin/pages/draft')).status, 401);
    const headers = { 'X-Test-Editor': 'yes', 'Content-Type': 'application/json' };
    assert.equal((await request('/api/admin/pages', { headers })).body.pages.length, 3);
    assert.match((await request('/api/admin/pages/wip', { headers })).body.page.content.en, /WIP_SECRET/);
    const body = { titles: { en: 'Saved draft' }, content: {}, pageType: 'content', publicationStatus: 'draft', tags: ['Guide'], isWip: false };
    const savedDraft = await request('/api/admin/pages/new', { method: 'PUT', headers, body: JSON.stringify(body) });
    assert.equal(savedDraft.status, 200, JSON.stringify(savedDraft.body));
    assert.equal((await request('/api/pages/new')).status, 404);
    const published = await request('/api/admin/pages/new', { method: 'PUT', headers, body: JSON.stringify({ ...body, publicationStatus: 'published', content: { en: '<p>Now public</p>' } }) });
    assert.equal(published.status, 200); assert.match((await request('/api/pages/new')).body.page.content.en, /Now public/);
    const revision = (await query("SELECT * FROM page_revisions WHERE page_slug='new'"))[0]; assert.equal(revision.publication_status, 'draft'); assert.equal(revision.tags, '["Guide"]');
    assert.equal((await request('/api/admin/pages/new', { method: 'PUT', headers, body: JSON.stringify({ ...body, tags: ['<script>'] }) })).status, 400);
  } finally { if(server) await new Promise(resolve => server.close(resolve)); await pool.end(); for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory,file)); fs.rmdirSync(directory); }
});
