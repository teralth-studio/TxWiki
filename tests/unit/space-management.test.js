'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqlitePool } = require('../../scripts/database');
const { registerNavigationRoutes } = require('../../scripts/space-management');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-spaces-'));
  const pool = new SqlitePool(path.join(directory, 'test.sqlite'));
  pool.db.exec(fs.readFileSync(path.join(__dirname, '../../schema.sqlite.sql'), 'utf8'));
  t.after(async () => { await pool.end(); fs.rmSync(directory, { recursive: true, force: true }); });
  const handlers = new Map(), permissions = new Map();
  const app = Object.fromEntries(['post', 'put', 'patch', 'delete'].map(method => [method,
    (route, ...middleware) => handlers.set(`${method} ${route}`, middleware.at(-1))]));
  registerNavigationRoutes({ app, pool, auth() {},
    requirePermission(permission) { permissions.set(permission, true); return () => {}; },
    activeHeaderLanguages: async () => ['en', 'es'],
    validFontAwesomeIcon: icon => /^fa-solid fa-[a-z-]+$/.test(icon),
  });
  async function call(method, route, body = {}, slug) {
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await handlers.get(`${method} ${route}`)({ body, params: { slug } }, res, error => { throw error; });
    return res;
  }
  await pool.query("INSERT INTO spaces(slug,name,titles) VALUES ('main','Main',?)", [JSON.stringify({ en: 'Main' })]);
  return { pool, call, permissions };
}

test('space routes persist localized branding, reject invalid slugs and reorder complete lists atomically', async t => {
  const { pool, call, permissions } = await fixture(t);
  const create = body => call('post', '/api/admin/spaces', body);
  assert.equal((await create({ slug: 'Guide Space', titles: { en: ' Guide ', es: 'Guía' }, icon: 'none' })).statusCode, 200);
  assert.equal((await create({ slug: 'other', titles: { en: 'Other' }, icon: 'fa-solid fa-book' })).statusCode, 200);
  let [rows] = await pool.query("SELECT * FROM spaces WHERE slug='Guide-Space'");
  assert.equal(rows[0].name, 'Guide');
  assert.deepEqual(JSON.parse(rows[0].titles), { en: 'Guide', es: 'Guía' });
  assert.equal(rows[0].icon, 'none');
  for (const slug of ['admin', 'main', 'GUIDE-SPACE', 'bad/path', 'bad?query']) {
    const res = await create({ slug, titles: { en: 'Invalid' } });
    assert.ok([400, 409].includes(res.statusCode), slug);
  }
  assert.equal((await call('patch', '/api/admin/spaces/order', { ids: ['other', 'Guide-Space', 'main'] })).statusCode, 200);
  [rows] = await pool.query('SELECT slug,sort_order FROM spaces ORDER BY sort_order');
  assert.deepEqual(rows, [{ slug: 'other', sort_order: 0 }, { slug: 'Guide-Space', sort_order: 1 }, { slug: 'main', sort_order: 2 }]);
  for (const ids of [['main'], ['main', 'main', 'other'], ['main', 'other', 'missing']])
    assert.equal((await call('patch', '/api/admin/spaces/order', { ids })).statusCode, 409);
  assert.deepEqual((await pool.query('SELECT slug,sort_order FROM spaces ORDER BY sort_order'))[0], rows);
  assert.ok(permissions.has('spaces.create') && permissions.has('spaces.edit') && permissions.has('spaces.delete'));
});

test('renaming a populated space preserves IDs, hierarchy, history, reactions and home page; deletion cascades', async t => {
  const { pool, call } = await fixture(t);
  await pool.query("INSERT INTO spaces(slug,name,titles,home_page_slug,sort_order,created_at) VALUES ('docs','Docs',?,'home',7,'2026-01-01 00:00:00')", [JSON.stringify({ en: 'Docs', de: 'Dokumente' })]);
  await pool.query("INSERT INTO categories(id,space_slug,names) VALUES (1,'docs','{}')");
  await pool.query("INSERT INTO categories(id,space_slug,parent_id,names) VALUES (2,'docs',1,'{}')");
  await pool.query("INSERT INTO pages(id,space_slug,category_id,slug) VALUES (10,'docs',2,'home')");
  await pool.query("INSERT INTO page_revisions(id,space_slug,page_slug,category_id,icon,page_type,titles,content) VALUES (3,'docs','home',2,'none','content','{}','{}')");
  await pool.query("INSERT INTO reactions(id,space_slug,page_id,ip_hash,mood) VALUES (4,'docs',10,'hash','happy')");
  assert.equal((await call('put', '/api/admin/spaces/:slug', { slug: 'manual', titles: { en: 'Manual', es: 'Manual ES' }, icon: 'none' }, 'docs')).statusCode, 200);
  const [spaces] = await pool.query("SELECT * FROM spaces WHERE slug='manual'");
  assert.deepEqual(JSON.parse(spaces[0].titles), { de: 'Dokumente', en: 'Manual', es: 'Manual ES' });
  assert.equal(spaces[0].home_page_slug, 'home');
  assert.equal(spaces[0].sort_order, 7);
  assert.equal(spaces[0].created_at, '2026-01-01 00:00:00');
  assert.deepEqual((await pool.query('SELECT id,space_slug,parent_id FROM categories ORDER BY id'))[0], [
    { id: 1, space_slug: 'manual', parent_id: null }, { id: 2, space_slug: 'manual', parent_id: 1 },
  ]);
  for (const [table, id] of [['pages', 10], ['page_revisions', 3], ['reactions', 4]])
    assert.deepEqual((await pool.query(`SELECT id,space_slug FROM ${table}`))[0], [{ id, space_slug: 'manual' }]);
  assert.equal((await call('delete', '/api/admin/spaces/:slug', {}, 'manual')).statusCode, 200);
  for (const table of ['categories', 'pages', 'page_revisions', 'reactions'])
    assert.deepEqual((await pool.query(`SELECT * FROM ${table}`))[0], []);
  assert.equal((await call('delete', '/api/admin/spaces/:slug', {}, 'main')).statusCode, 400);
  assert.equal((await call('put', '/api/admin/spaces/:slug', { slug: 'root', titles: { en: 'Root' } }, 'main')).statusCode, 400);
});

test('header order persists complete IDs and rejects stale lists without changing saved links', async t => {
  const { pool, call } = await fixture(t);
  const links = [{ id: 'one', titles: { en: 'One' }, url: '/one' }, { id: 'two', titles: { en: 'Two' }, url: '/two' }];
  await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES ('header_links',?)", [JSON.stringify(links)]);
  assert.equal((await call('patch', '/api/admin/header-links/order', { ids: ['two', 'one'] })).statusCode, 200);
  assert.equal((await call('patch', '/api/admin/header-links/order', { ids: ['two', 'two'] })).statusCode, 409);
  const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='header_links'");
  assert.deepEqual(JSON.parse(rows[0].setting_value), [links[1], links[0]]);
});

test('failed populated space rename rolls back both the inserted space and moved children', async t => {
  const { pool, call } = await fixture(t);
  await pool.query("INSERT INTO spaces(slug,name) VALUES ('docs','Docs')");
  await pool.query("INSERT INTO categories(space_slug,names) VALUES ('docs','{}')");
  await pool.query("INSERT INTO pages(space_slug,slug) VALUES ('docs','home')");
  const originalGetConnection = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const conn = await originalGetConnection(), query = conn.query;
    conn.query = async (sql, params) => {
      if (sql.startsWith('UPDATE pages SET space_slug')) throw new Error('simulated write failure');
      return query(sql, params);
    };
    return conn;
  };
  await assert.rejects(call('put', '/api/admin/spaces/:slug', { slug: 'manual', titles: { en: 'Manual' } }, 'docs'), /simulated write failure/);
  assert.deepEqual((await pool.query('SELECT slug FROM spaces ORDER BY slug'))[0], [{ slug: 'docs' }, { slug: 'main' }]);
  for (const table of ['categories', 'pages'])
    assert.deepEqual((await pool.query(`SELECT space_slug FROM ${table}`))[0], [{ space_slug: 'docs' }]);
});

test('space titles migration preserves legacy names and permits localized updates on SQLite', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-space-migrate-'));
  const pool = new SqlitePool(path.join(directory, 'test.sqlite'));
  t.after(async () => { await pool.end(); fs.rmSync(directory, { recursive: true, force: true }); });
  await pool.query('CREATE TABLE spaces(slug TEXT PRIMARY KEY,name TEXT NOT NULL)');
  await pool.query("INSERT INTO spaces(slug,name) VALUES ('docs','Legacy documentation')");
  const migration = fs.readFileSync(path.join(__dirname, '../../migrations/20261127-space-titles.sql'), 'utf8');
  await pool.query(migration);
  assert.deepEqual((await pool.query('SELECT * FROM spaces'))[0], [{ slug: 'docs', name: 'Legacy documentation', titles: null }]);
  await pool.query('UPDATE spaces SET titles=? WHERE slug=?', [JSON.stringify({ es: 'Documentación' }), 'docs']);
  assert.deepEqual(JSON.parse((await pool.query('SELECT titles FROM spaces'))[0][0].titles), { es: 'Documentación' });
});
