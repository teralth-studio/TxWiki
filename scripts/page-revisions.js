'use strict';

async function capturePageRevision(connection, page, revisionBy) {
  const [result] = await connection.execute(
    'INSERT INTO page_revisions (space_slug,page_slug,category_id,icon,page_type,redirect_url,sort_order,titles,content,updated_by,page_updated_at,revision_by,publication_status,is_wip,tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      page.space_slug,
      page.slug,
      page.category_id,
      page.icon,
      page.page_type,
      page.redirect_url,
      page.sort_order,
      typeof page.titles === 'string' ? page.titles : JSON.stringify(page.titles || {}),
      typeof page.content === 'string' ? page.content : JSON.stringify(page.content || {}),
      page.updated_by,
      page.updated_at,
      revisionBy,
      page.publication_status || 'published', Number(page.is_wip) || 0, typeof page.tags === 'string' ? page.tags : JSON.stringify(page.tags || []),
    ],
  );
  return result.insertId;
}

module.exports = { capturePageRevision };
