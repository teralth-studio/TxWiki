'use strict';

const media = /^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/;
const reserved = new Set(['api','login','register','reset','admin','verify','media','profile','auth','two-factor','two-factor-setup']);
const reject = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function spaceValues(body, languages, validIcon, old) {
  const slug = typeof body.slug === 'string' ? body.slug.replace(/ /g, '-') : '';
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(slug) || reserved.has(slug.toLowerCase()))
    reject('Choose a valid space slug.');
  if (!body.titles || typeof body.titles !== 'object' || Array.isArray(body.titles)) reject('Enter a space title.');
  const oldTitles = typeof old?.titles === 'string' ? JSON.parse(old.titles) : old?.titles || {};
  const titles = Object.fromEntries(Object.entries(oldTitles).filter(([code]) => !languages.includes(code)));
  for (const [code, title] of Object.entries(body.titles)) {
    if (!languages.includes(code) || typeof title !== 'string' || title.trim().length > 120) reject('Invalid translated title.');
    if (title.trim()) titles[code] = title.trim();
  }
  const name = languages.map(code => titles[code]).find(Boolean);
  if (!name) reject('Enter a space title.');
  const logo = body.logo || '', icon = body.icon || 'none';
  if ((logo && !media.test(logo)) || (icon !== 'none' && !validIcon(icon))) reject('Invalid space brand.');
  return { slug, name, titles: JSON.stringify(titles), icon, logo };
}

function orderedItems(items, ids, key) {
  const map = new Map(items.map(item => [item[key], item]));
  if (!Array.isArray(ids) || ids.length !== items.length || new Set(ids).size !== items.length || ids.some(id => !map.has(id)))
    reject('The list changed. Reload it before reordering.', 409);
  return ids.map(id => map.get(id));
}

function registerNavigationRoutes({ app, auth, requirePermission, pool, activeHeaderLanguages, validFontAwesomeIcon }) {
  function mutation(method, path, permission, operation) {
    app[method](path, auth, requirePermission(permission), async (req, res, next) => {
      let conn;
      try {
        const languages = await activeHeaderLanguages();
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const result = await operation(conn, req, languages);
        await conn.commit();
        res.json({ ok: true, ...result });
      } catch (error) {
        if (conn) await conn.rollback();
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      } finally { conn?.release(); }
    });
  }
  mutation('patch', '/api/admin/header-links/order', 'header_links.create_edit', async (conn, req) => {
    const [rows] = await conn.query("SELECT setting_value FROM settings WHERE setting_key='header_links' FOR UPDATE");
    const stored = rows[0]?.setting_value || [];
    const links = orderedItems(typeof stored === 'string' ? JSON.parse(stored) : stored, req.body.ids, 'id');
    await conn.query("UPDATE settings SET setting_value=? WHERE setting_key='header_links'", [JSON.stringify(links)]);
    return { links };
  });
  const lockedSpaces = async conn => (await conn.query('SELECT slug,name,titles,icon,logo,home_page_slug,sort_order,created_at FROM spaces ORDER BY sort_order,name FOR UPDATE'))[0];
  mutation('patch', '/api/admin/spaces/order', 'spaces.edit', async (conn, req) => {
    const spaces = orderedItems(await lockedSpaces(conn), req.body.ids, 'slug');
    for (const [index, space] of spaces.entries())
      await conn.query('UPDATE spaces SET sort_order=? WHERE slug=?', [index, space.slug]);
  });
  async function save(conn, req, languages) {
    const spaces = await lockedSpaces(conn), original = req.params.slug;
    const old = spaces.find(item => item.slug === original);
    if (original && !old) reject('Space not found.', 404);
    if (!old && spaces.length >= 100) reject('The space limit is 100.');
    const { slug, name, titles, icon, logo } = spaceValues(req.body, languages, validFontAwesomeIcon, old);
    if (slug !== original && spaces.some(item => item.slug.toLowerCase() === slug.toLowerCase() && item !== old))
      reject('This space slug is already in use.', 409);
    if (original === 'main' && slug !== original) reject('The main space keeps its root route.');
    if (old && slug === original) {
      await conn.query('UPDATE spaces SET name=?,titles=?,icon=?,logo=? WHERE slug=?', [name,titles,icon,logo,slug]);
      return;
    }
    const order = old?.sort_order ?? (spaces.reduce((max, space) => Math.max(max, space.sort_order), -1) + 1);
    await conn.query('INSERT INTO spaces (slug,name,titles,icon,logo,sort_order,home_page_slug,created_at) VALUES (?,?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP))',
      [slug,name,titles,icon,logo,order,old?.home_page_slug ?? null,old?.created_at ?? null]);
    if (old) {
      for (const table of ['categories','pages','page_revisions','reactions'])
        await conn.query('UPDATE ' + table + ' SET space_slug=? WHERE space_slug=?', [slug,original]);
      await conn.query('DELETE FROM spaces WHERE slug=?', [original]);
    }
  }
  mutation('post','/api/admin/spaces','spaces.create',save);
  mutation('put','/api/admin/spaces/:slug','spaces.edit',save);
  mutation('delete','/api/admin/spaces/:slug','spaces.delete', async (conn, req) => {
    if (req.params.slug === 'main') reject('The main space is required.');
    await conn.query('DELETE FROM spaces WHERE slug=?', [req.params.slug]);
  });
}

module.exports = { registerNavigationRoutes, spaceValues, orderedItems };

