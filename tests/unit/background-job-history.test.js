'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { SqlitePool } = require('../../scripts/database');
const { ensureBackgroundJobHistory } = require('../../scripts/background-job-history');

test('schema repair creates missing job history and migrates existing queue records idempotently', async () => {
  const pool = new SqlitePool(':memory:');
  try {
    await pool.query(`CREATE TABLE background_jobs (
      id INTEGER PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`);
    await pool.execute(
      'INSERT INTO background_jobs (id,job_type,status,created_at,completed_at) VALUES (?,?,?,?,?)',
      [41, 'mail', 'queued', '2026-11-23 10:00:00', null],
    );
    await pool.execute(
      'INSERT INTO background_jobs (id,job_type,status,created_at,completed_at) VALUES (?,?,?,?,?)',
      [42, 'backup', 'done', '2026-11-23 09:00:00', '2026-11-23 09:02:00'],
    );

    await ensureBackgroundJobHistory(pool, 'sqlite');
    await ensureBackgroundJobHistory(pool, 'sqlite');

    const [rows] = await pool.query('SELECT id,status,category,action,error_code FROM background_job_history ORDER BY id');
    assert.deepEqual(rows, [
      { id: 41, status: 'queued', category: 'SMTP', action: 'Send email', error_code: null },
      { id: 42, status: 'success', category: 'Backups', action: 'Create backup', error_code: null },
    ]);
  } finally {
    await pool.end();
  }
});

test('signed update SQL migration creates the job history table on SQLite', async () => {
  const pool = new SqlitePool(':memory:');
  try {
    const migration = fs.readFileSync(
      path.join(__dirname, '..', '..', 'migrations', '20261123-background-job-history.sql'),
      'utf8',
    );
    await pool.query(migration);
    const [tables] = await pool.query("SELECT name FROM sqlite_master WHERE type='table' AND name='background_job_history'");
    assert.deepEqual(tables, [{ name: 'background_job_history' }]);
  } finally {
    await pool.end();
  }
});

test('admin dashboard migration creates the visitor and trend tables on SQLite', async () => {
  const pool = new SqlitePool(':memory:');
  try {
    for (const schemaFile of ['schema.sql', 'schema.sqlite.sql']) {
      const schema = fs.readFileSync(path.join(__dirname, '..', '..', schemaFile), 'utf8');
      assert.match(schema, /CREATE TABLE IF NOT EXISTS dashboard_visitors/);
      assert.match(schema, /CREATE TABLE IF NOT EXISTS dashboard_stats/);
      assert.match(schema, /visitor_hash/);
      assert.match(schema, /happy_count/);
    }
    const migration = fs.readFileSync(
      path.join(__dirname, '..', '..', 'migrations', '20261127-admin-dashboard.sql'),
      'utf8',
    );
    for (const statement of migration.split(';').map((part) => part.trim()).filter(Boolean))
      await pool.query(statement);
    await pool.query(
      'INSERT OR IGNORE INTO dashboard_visitors (visit_day,visitor_hash) VALUES (?,?)',
      ['2026-11-27', 'a'.repeat(64)],
    );
    await pool.query(
      'INSERT OR IGNORE INTO dashboard_visitors (visit_day,visitor_hash) VALUES (?,?)',
      ['2026-11-27', 'a'.repeat(64)],
    );
    const [visitors] = await pool.query('SELECT COUNT(*) AS total FROM dashboard_visitors');
    assert.equal(visitors[0].total, 1);
    const [tables] = await pool.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dashboard_visitors','dashboard_stats') ORDER BY name",
    );
    assert.deepEqual(tables, [{ name: 'dashboard_stats' }, { name: 'dashboard_visitors' }]);
  } finally {
    await pool.end();
  }
});
