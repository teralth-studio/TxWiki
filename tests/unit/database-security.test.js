'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SqlitePool } = require('../../scripts/database');

test('SQLite binds untrusted values and rejects unsafe identifiers', async () => {
  const pool = new SqlitePool(':memory:');
  const payload = "'); DROP TABLE messages; --";
  try {
    await pool.execute('CREATE TABLE messages (body TEXT NOT NULL)');
    await pool.execute('INSERT INTO messages(body) VALUES(?)', [payload]);
    const [rows] = await pool.execute('SELECT body FROM messages');
    assert.deepEqual(rows, [{ body: payload }]);
    await assert.rejects(
      pool.execute('SELECT * FROM ??', ['messages; DROP TABLE messages']),
      { code: 'SQLITE_IDENTIFIER_INVALID' },
    );
    const [afterRejectedIdentifier] = await pool.execute('SELECT body FROM messages');
    assert.deepEqual(afterRejectedIdentifier, [{ body: payload }]);
  } finally {
    await pool.end();
  }
});
