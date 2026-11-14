'use strict';

const session = require('express-session');

class SqliteSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
    this.pruneTimer = setInterval(() => {
      this.pool.execute('DELETE FROM sessions WHERE expires IS NOT NULL AND expires<=?', [Date.now()])
        .catch((error) => console.error('[Teralth Wiki] SQLite session cleanup failed:', error.code || error.name || 'Error'));
    }, 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  async createDatabaseTable() {
    await this.pool.execute(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT NOT NULL PRIMARY KEY,
      expires INTEGER NULL,
      data TEXT NOT NULL
    )`);
    await this.pool.execute('CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires)');
  }

  async onReady() {
    return this.createDatabaseTable();
  }

  expiration(sessionData) {
    const value = sessionData?.cookie?.expires;
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  get(sid, callback = () => {}) {
    this.pool.execute('SELECT data,expires FROM sessions WHERE sid=? LIMIT 1', [sid])
      .then(([rows]) => {
        const record = rows[0];
        if (!record) return callback(null, null);
        if (record.expires !== null && Number(record.expires) <= Date.now()) {
          this.destroy(sid, (error) => callback(error || null, null));
          return;
        }
        let value;
        try { value = JSON.parse(record.data); }
        catch (error) { return callback(error); }
        callback(null, value);
      })
      .catch(callback);
  }

  set(sid, sessionData, callback = () => {}) {
    const expires = this.expiration(sessionData);
    this.pool.execute(
      'INSERT INTO sessions (sid,expires,data) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET expires=excluded.expires,data=excluded.data',
      [sid, expires, JSON.stringify(sessionData)],
    ).then(() => callback(null)).catch(callback);
  }

  touch(sid, sessionData, callback = () => {}) {
    this.pool.execute('UPDATE sessions SET expires=? WHERE sid=?', [this.expiration(sessionData), sid])
      .then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.pool.execute('DELETE FROM sessions WHERE sid=?', [sid])
      .then(() => callback(null)).catch(callback);
  }

  clear(callback = () => {}) {
    this.pool.execute('DELETE FROM sessions').then(() => callback(null)).catch(callback);
  }

  length(callback = () => {}) {
    this.pool.execute('SELECT COUNT(*) AS count FROM sessions WHERE expires IS NULL OR expires>?', [Date.now()])
      .then(([rows]) => callback(null, Number(rows[0]?.count || 0))).catch(callback);
  }

  all(callback = () => {}) {
    this.pool.execute('SELECT data FROM sessions WHERE expires IS NULL OR expires>? ORDER BY sid', [Date.now()])
      .then(([rows]) => callback(null, rows.map((row) => JSON.parse(row.data)))).catch(callback);
  }

  close() {
    clearInterval(this.pruneTimer);
  }
}

module.exports = SqliteSessionStore;
