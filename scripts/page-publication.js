const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const { rateLimit } = require('express-rate-limit');
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.length > 20) invalid('Use up to 20 tags per page.');
  const tags = [], seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') invalid('Tags must be text.');
    const tag = item.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!tag || tag.length > 50 || /[<>\x00-\x1f\x7f]/.test(tag)) invalid('Each tag must contain 1–50 characters without markup.');
    const key = tag.toLocaleLowerCase('en');
    if (!seen.has(key)) { seen.add(key); tags.push(tag); }
  }
  return tags;
}
function publicationInput(body) {
  if (body.publicationStatus !== undefined && !['draft', 'published'].includes(body.publicationStatus)) invalid('Invalid publication status.');
  if (body.isWip !== undefined && typeof body.isWip !== 'boolean') invalid('Invalid WIP setting.');
  const content = body.pageType !== 'redirect';
  return { status: body.publicationStatus || 'published', isWip: content && body.isWip ? 1 : 0, tags: content ? normalizeTags(body.tags) : [] };
}
async function ensurePublicationSchema(pool) {
  const [columns] = await pool.query('SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
  for (const table of ['pages', 'page_revisions']) {
    const names = new Set(columns.filter(row => row.TABLE_NAME === table).map(row => row.COLUMN_NAME));
    if (!names.size) continue;
    for (const [name, definition] of Object.entries({ publication_status: "VARCHAR(16) NOT NULL DEFAULT 'published'", is_wip: 'INTEGER NOT NULL DEFAULT 0', tags: 'JSON NULL' }))
      if (!names.has(name)) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
async function publicPage(page, query, safePageContent) {
  if (!page || page.publication_status === 'draft') return null;
  let content = page.content;
  if (Number(page.is_wip)) {
    const [row] = await query("SELECT setting_value FROM settings WHERE setting_key='site'");
    const configured = (row ? parse(row.setting_value) : {})?.wipContent;
    content = configured && Object.values(configured).some(value => typeof value === 'string' && value.trim())
      ? Object.fromEntries(Object.entries(configured).filter(([, value]) => typeof value === 'string' && value.trim()))
      : { en: '<h1>Page under maintenance</h1><p>This page is being updated. Please check back later.</p>' };
  }
  return { ...page, tags: normalizeTags(parse(page.tags) || []), titles: parse(page.titles), content: safePageContent(content), updated_by_avatar: page.updated_by_avatar || '' };
}
function registerPublicationRoutes(app, { query, auth, requirePermission, activeSpace, safePageContent }) {
  app.get('/api/admin/pages', auth, requirePermission('admin.view'), async (req, res, next) => {
    try {
      const space = activeSpace(req);
      const [pages, categories, spaces] = await Promise.all([
        query('SELECT id,slug,icon,page_type,redirect_url,titles,category_id,sort_order,publication_status,is_wip,tags FROM pages WHERE space_slug=? ORDER BY category_id,sort_order,slug', [space]),
        query('SELECT id,parent_id,icon,names,sort_order,is_open FROM categories WHERE space_slug=? ORDER BY sort_order,id', [space]),
        query('SELECT home_page_slug FROM spaces WHERE slug=?', [space]),
      ]);
      res.set('Cache-Control', 'private, no-store').json({ pages: pages.map(page => ({ ...page, titles: parse(page.titles), tags: parse(page.tags) || [] })), categories: categories.map(category => ({ ...category, names: parse(category.names) })), homePageSlug: spaces[0]?.home_page_slug || null });
    } catch (error) { next(error); }
  });
  app.get('/api/admin/pages/:slug', auth, requirePermission('pages.create_edit'), async (req, res, next) => {
    try {
      const [page] = await query('SELECT * FROM pages WHERE space_slug=? AND slug=? LIMIT 1', [activeSpace(req), req.params.slug]);
      if (!page) return res.status(404).json({ error: 'Page not found.' });
      res.set('Cache-Control', 'private, no-store').json({ page: { ...page, titles: parse(page.titles), tags: parse(page.tags) || [], content: safePageContent(page.content) } });
    } catch (error) { next(error); }
  });
  app.get('/api/search', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false }), async (req, res, next) => {
    try {
      const term = String(req.query.q || '').trim(), tag = String(req.query.tag || '').trim(), lang = String(req.query.lang || 'en');
      if (term.length > 200 || tag.length > 50 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang)) return res.status(400).json({ error: 'Invalid search.' });
      const rows = await query("SELECT id,slug,page_type,titles,content,tags,is_wip FROM pages WHERE space_slug=? AND publication_status='published' ORDER BY sort_order,slug", [activeSpace(req)]);
      const tags = [...new Set(rows.flatMap(row => parse(row.tags) || []))].sort((a,b) => a.localeCompare(b));
      const fold = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const results = [];
      for (const row of rows) {
        const rowTags = parse(row.tags) || [];
        if (tag && !rowTags.some(item => fold(item) === fold(tag))) continue;
        const titles = parse(row.titles), contents = Number(row.is_wip) ? {} : safePageContent(row.content);
        const title = titles[lang] || titles[lang.split('-')[0]] || Object.values(titles)[0] || row.slug;
        const text = String(contents[lang] || contents[lang.split('-')[0]] || Object.values(contents)[0] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (term && !fold(title+' '+row.slug+' '+text+' '+rowTags.join(' ')).includes(fold(term))) continue;
        const offset = term ? Math.max(0, fold(text).indexOf(fold(term)) - 45) : 0;
        results.push({ slug: row.slug, title, tags: rowTags, excerpt: text.slice(offset, offset+180), isWip: Boolean(Number(row.is_wip)) });
        if (results.length >= 50) break;
      }
      res.set('Cache-Control', 'private, no-store').json({ results, tags });
    } catch (error) { next(error); }
  });
}
module.exports = { normalizeTags, publicationInput, publicPage, ensurePublicationSchema, registerPublicationRoutes };
