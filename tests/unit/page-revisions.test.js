'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { capturePageRevision } = require('../../scripts/page-revisions');

test('page revision snapshots preserve the previous page state and revision actor', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE page_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_slug TEXT,
    page_slug TEXT,
    category_id INTEGER,
    icon TEXT,
    page_type TEXT,
    redirect_url TEXT,
    sort_order INTEGER,
    titles TEXT,
    content TEXT,
    updated_by INTEGER,
    page_updated_at TEXT,
    revision_by INTEGER,
    publication_status TEXT,
    is_wip INTEGER,
    tags TEXT
  )`);
  const connection = {
    execute: async (sql, values) => {
      const result = db.prepare(sql).run(...values);
      return [{ insertId: Number(result.lastInsertRowid) }];
    },
  };
  const page = {
    space_slug: 'main',
    slug: 'welcome',
    category_id: 3,
    icon: 'fa-file-lines',
    page_type: 'content',
    redirect_url: null,
    sort_order: 2,
    titles: '{"en":"Welcome"}',
    content: '{"en":"<p>Previous text</p>"}',
    updated_by: 7,
    updated_at: '2026-11-14 12:00:00',
    publication_status: 'draft', is_wip: 1, tags: '["Documentation"]',
  };

  try {
    const revisionId = await capturePageRevision(connection, page, 9);
    const revision = db.prepare('SELECT * FROM page_revisions WHERE id=?').get(revisionId);
    assert.equal(revision.page_slug, 'welcome');
    assert.equal(revision.titles, page.titles);
    assert.equal(revision.content, page.content);
    assert.equal(revision.updated_by, page.updated_by);
    assert.equal(revision.revision_by, 9);
    assert.equal(revision.publication_status, 'draft');
    assert.equal(revision.is_wip, 1);
    assert.equal(revision.tags, page.tags);
    await capturePageRevision(connection, { ...page, titles: JSON.parse(page.titles), content: JSON.parse(page.content), tags: ['Documentation'] }, 10);
    const objectRevision = db.prepare('SELECT * FROM page_revisions WHERE revision_by=10').get();
    assert.equal(objectRevision.titles, page.titles);
    assert.equal(objectRevision.content, page.content);
    assert.equal(objectRevision.tags, page.tags);
  } finally {
    db.close();
  }
});
