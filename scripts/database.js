'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const BetterSqlite3 = require('better-sqlite3');

const sqliteLockOwner = crypto.randomBytes(16).toString('hex');

function databaseType(env = process.env) {
  const type = String(env.DB_TYPE || 'mysql').trim().toLowerCase();
  if (type !== 'sqlite' && type !== 'mysql')
    throw Object.assign(new Error('DB_TYPE must be mysql or sqlite.'), { code: 'DATABASE_TYPE_INVALID' });
  return type;
}

function resolveSqlitePath(env = process.env, root = process.cwd()) {
  const dataDirectory = path.resolve(root, env.DATA_DIR || './data');
  const filename = String(env.DB_SQLITE_PATH || path.join(env.DATA_DIR || './data', 'teralth-wiki.sqlite'));
  const absolute = path.resolve(root, filename);
  const relative = path.relative(dataDirectory, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep))
    throw Object.assign(new Error('SQLite database must be a filename inside DATA_DIR.'), { code: 'SQLITE_PATH_INVALID' });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:sqlite|sqlite3|db)$/i.test(relative))
    throw Object.assign(new Error('SQLite database filename is invalid.'), { code: 'SQLITE_PATH_INVALID' });
  for (const candidate of [dataDirectory, absolute]) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || (candidate === dataDirectory ? !stat.isDirectory() : !stat.isFile()))
        throw Object.assign(new Error('SQLite database path is not a regular local file.'), { code: 'SQLITE_PATH_INVALID' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { dataDirectory, filename: absolute };
}

function normalizeSql(sql, state, params) {
  let source = String(sql).trim();
  if (!source) return { sql: source, params };
  const addIndex = source.match(/^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+(?:INDEX|KEY)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s*;?$/i);
  if (addIndex) return { createIndex: addIndex, sql: source, params };
  if (/^ALTER\s+TABLE\s+\w+\s+(?:MODIFY|CHANGE)\s+/i.test(source))
    return { noop: true, sql: source, params };
  if (/^ALTER\s+TABLE\s+\w+\s+ADD\s+CONSTRAINT\s+/i.test(source))
    return { noop: true, sql: source, params };
  if (/^SET\s+FOREIGN_KEY_CHECKS\s*=\s*0\s*$/i.test(source))
    return { pragma: 'defer_foreign_keys = ON', sql: source, params };
  if (/^SET\s+FOREIGN_KEY_CHECKS\s*=\s*1\s*$/i.test(source))
    return { pragma: 'foreign_keys = ON', sql: source, params };
  if (/^SET\s+(?:TIME_ZONE|TRANSACTION\s+ISOLATION\s+LEVEL)\b/i.test(source))
    return { noop: true, sql: source, params };
  if (/information_schema\.KEY_COLUMN_USAGE/i.test(source)) return { metadata: 'foreign-keys', sql: source, params };
  if (/information_schema\.COLUMNS/i.test(source)) return { metadata: 'columns', sql: source, params };
  if (/information_schema\.TABLES/i.test(source)) return { metadata: 'tables', sql: source, params };
  const lock = source.match(/^SELECT\s+(GET_LOCK|RELEASE_LOCK)\s*\(\s*'([^']+)'\s*,?\s*\d*\s*\)\s+AS\s+([A-Za-z0-9_]+)/i);
  if (lock) return { lock: { action: lock[1].toLowerCase(), key: lock[2], alias: lock[3] }, sql: source, params };

  const args = [...params];
  source = source.replace(/\?\?/g, () => {
    const identifier = args.shift();
    const names = Array.isArray(identifier) ? identifier : [identifier];
    if (!names.length || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))))
      throw Object.assign(new Error('Invalid SQL identifier.'), { code: 'SQLITE_IDENTIFIER_INVALID' });
    return names.map((name) => `"${String(name).replaceAll('"', '""')}"`).join(',');
  });
  source = source.replace(/\bLOCATE\s*\(\s*LOWER\(\?\)\s*,\s*LOWER\(([A-Za-z_][A-Za-z0-9_]*)\)\s*\)/gi,
    'instr(LOWER($1),LOWER(?))');
  source = source
    .replace(/^INSERT\s+IGNORE\s+INTO\b/i, 'INSERT OR IGNORE INTO')
    .replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i, 'ON CONFLICT DO UPDATE SET')
    .replace(/\bVALUES\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi, 'excluded.$1')
    .replace(/JSON_ARRAY_APPEND\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*'\$'\s*,/gi, 'json_insert($1,\'$[#]\',')
    .replace(/\bUTC_TIMESTAMP\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\bNOW\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\bDATABASE\s*\(\s*\)/gi, "'sqlite'")
    .replace(/\bLAST_INSERT_ID\s*\(/gi, 'LAST_INSERT_ID(')
    .replace(/\bIF\s*\(/gi, 'iif(')
    .replace(/\bGREATEST\s*\(/gi, 'max(')
    .replace(/\bLOCATE\s*\(\s*([^,]+),\s*([^,)]+)\s*\)/gi, 'instr($2,$1)')
    .replace(/\bFOR\s+UPDATE\b/gi, '');
  source = source.replace(/DATE_FORMAT\(\s*([^,]+),\s*'([^']+)'\s*\)/gi, (_match, value, format) => {
    const sqliteFormat = format.replaceAll('%i', '%M').replaceAll('%s', '%S');
    return `strftime('${sqliteFormat}', ${value.trim()})`;
  });
  source = source.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP/gi, '');

  source = source.replace(/DATE_ADD\(\s*CURRENT_TIMESTAMP\s*,\s*INTERVAL\s+(\?)\s+(SECOND|MINUTE|HOUR|DAY)\s*\)/gi,
    (_match, _placeholder, unit) => `datetime('now', printf('%+d ${unit.toLowerCase()}s', ?))`);
  source = source.replace(/DATE_ADD\(\s*CURRENT_TIMESTAMP\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY)\s*\)/gi,
    (_match, amount, unit) => `datetime('now', '+${amount} ${unit.toLowerCase()}s')`);
  source = source.replace(/DATE_SUB\(\s*CURRENT_TIMESTAMP\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY)\s*\)/gi,
    (_match, amount, unit) => `datetime('now', '-${amount} ${unit.toLowerCase()}s')`);
  if (/^\s*(?:CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(source)) {
    source = source.replace(/\s+ENGINE\s*=\s*InnoDB\b/gi, '').replace(/\s+DEFAULT\s+CHARSET\s*=\s*\w+/gi, '');
    source = source.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:BIGINT|INT)(?:\s+UNSIGNED)?\s+NOT\s+NULL\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi,
      '$1 INTEGER PRIMARY KEY AUTOINCREMENT');
    source = source.replace(/\bUNIQUE\s+KEY\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]+)\)/gi, 'UNIQUE ($1)');
    source = source.replace(/\b(?:BIGINT|INT|SMALLINT)(?:\s+UNSIGNED)?\b/gi, 'INTEGER')
      .replace(/\bVARCHAR\s*\(\s*\d+\s*\)/gi, 'TEXT')
      .replace(/\bCHAR\s*\(\s*\d+\s*\)/gi, 'TEXT')
      .replace(/\bMEDIUMTEXT\b/gi, 'TEXT')
      .replace(/\bDATETIME\b/gi, 'TEXT')
      .replace(/\bTIMESTAMP\b/gi, 'TEXT')
      .replace(/\bJSON\b/gi, 'TEXT')
      .replace(/\bENUM\s*\([^)]*\)/gi, 'TEXT')
      .replace(/\bAUTO_INCREMENT\b/gi, '')
      .replace(/\bUNSIGNED\b/gi, '')
      .replace(/\s+CHARACTER\s+SET\s+\w+/gi, '')
      .replace(/\s+COLLATE\s+\w+/gi, '');
    // Translate MySQL inline index declarations in CREATE TABLE to SQLite constraints.
    source = source.replace(/^\s*(?:KEY|INDEX)\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)\s*,?\s*$/gim, '');
  }
  return { sql: source, params: args };
}

function parameterValue(value) {
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value))
    return value.replace('T', ' ').replace(/\.\d+Z$/, '');
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function metadataRows(db, query) {
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((row) => row.name);
  if (query.metadata === 'tables') return tableNames.map((TABLE_NAME) => ({ TABLE_NAME }));
  if (query.metadata === 'foreign-keys') return [];
  const placeholders = query.params.filter((value) => typeof value === 'string');
  const requested = placeholders.length ? new Set(placeholders) : null;
  const rows = [];
  for (const table of tableNames) {
    if (requested && !requested.has(table)) continue;
    const escaped = table.replaceAll("'", "''");
    for (const column of db.prepare(`PRAGMA table_info('${escaped}')`).all())
      rows.push({ TABLE_NAME: table, COLUMN_NAME: column.name });
  }
  if (/SELECT\s+COLUMN_NAME/i.test(query.sql)) {
    const table = placeholders.at(-1);
    return rows.filter((row) => row.TABLE_NAME === table).map(({ COLUMN_NAME }) => ({ COLUMN_NAME }));
  }
  return rows;
}

function buildSqliteConnection(db, state) {
  const execute = async (sql, values = []) => {
    const normalized = normalizeSql(sql, state, Array.isArray(values) ? values : [values]);
    if (normalized.noop) return [{ affectedRows: 0, insertId: state.lastInsertId || 0 }, undefined];
    if (normalized.pragma) {
      db.pragma(normalized.pragma);
      return [{ affectedRows: 0, insertId: state.lastInsertId || 0 }, undefined];
    }
    if (normalized.createIndex) {
      const [, table, name, columns] = normalized.createIndex;
      const safeColumnList = columns.split(',').map((column) => column.trim());
      if (safeColumnList.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)))
        throw Object.assign(new Error('Invalid index definition.'), { code: 'SQLITE_INDEX_INVALID' });
      const result = db.prepare(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${safeColumnList.map((column) => `"${column}"`).join(',')})`).run();
      return [{ affectedRows: result.changes, insertId: state.lastInsertId || 0 }, undefined];
    }
    if (normalized.lock) {
      const { action, key, alias } = normalized.lock;
      let acquired = false;
      if (action === 'get_lock') {
        db.prepare('DELETE FROM txwiki_locks WHERE lock_name=? AND expires_at<=?').run(key, Date.now());
        acquired = db.prepare('INSERT OR IGNORE INTO txwiki_locks(lock_name,owner,expires_at) VALUES (?,?,?)')
          .run(key, sqliteLockOwner, Date.now() + 30 * 60 * 1000).changes > 0;
      } else {
        acquired = db.prepare('DELETE FROM txwiki_locks WHERE lock_name=? AND owner=?').run(key, sqliteLockOwner).changes > 0;
      }
      return [[{ [alias]: acquired ? 1 : 0 }], undefined];
    }
    if (normalized.metadata) return [metadataRows(db, normalized), undefined];
    const params = normalized.params.map(parameterValue);
    try {
      const statement = db.prepare(normalized.sql);
      if (statement.reader) return [statement.all(...params), undefined];
      const result = statement.run(...params);
      if (result.lastInsertRowid && !/\bLAST_INSERT_ID\s*\(/i.test(normalized.sql))
        state.lastInsertId = Number(result.lastInsertRowid);
      return [{ affectedRows: result.changes, changedRows: result.changes, insertId: Number(result.lastInsertRowid || state.lastInsertId || 0) }, undefined];
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message)) error.code = 'ER_DUP_ENTRY';
      else if (/FOREIGN KEY constraint failed/i.test(error.message)) error.code = 'ER_NO_REFERENCED_ROW_2';
      throw error;
    }
  };
  return {
    query: execute,
    execute,
    escapeId(value) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value))) throw new Error('Invalid SQL identifier.');
      return `"${String(value).replaceAll('"', '""')}"`;
    },
    async beginTransaction() { db.exec('BEGIN IMMEDIATE'); },
    async commit() { db.exec('COMMIT'); },
    async rollback() { db.exec('ROLLBACK'); },
    release() { db.close(); },
  };
}

class SqlitePool {
  constructor(filename) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.state = { lastInsertId: 0 };
    this.db = this.open(this.state);
    this.db.exec('CREATE TABLE IF NOT EXISTS txwiki_locks(lock_name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL)');
    this.connection = buildSqliteConnection(this.db, this.state);
  }
  open(state = { lastInsertId: 0 }) {
    const db = new BetterSqlite3(this.filename, { timeout: 10_000 });
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 10000');
    db.function('LAST_INSERT_ID', { varargs: true }, (...values) => {
      if (values.length) state.lastInsertId = Number(values[0]) || 0;
      return state.lastInsertId;
    });
    db.function('JSON_CONTAINS', { deterministic: true }, (document, candidate) => {
      try {
        const values = JSON.parse(document);
        const expected = JSON.parse(candidate);
        return Array.isArray(values) ? Number(values.some((value) => JSON.stringify(value) === JSON.stringify(expected))) : 0;
      } catch { return 0; }
    });
    try { fs.chmodSync(this.filename, 0o600); } catch {}
    return db;
  }
  query(sql, params) { return this.connection.query(sql, params); }
  execute(sql, params) { return this.connection.execute(sql, params); }
  async getConnection() {
    const state = { lastInsertId: 0 };
    const db = this.open(state);
    return buildSqliteConnection(db, state);
  }
  on() { return this; }
  async end() { this.db.close(); }
}

function createDatabase(env = process.env, root = process.cwd()) {
  if (databaseType(env) === 'sqlite') {
    const { filename } = resolveSqlitePath(env, root);
    return new SqlitePool(filename);
  }
  return mysql.createPool({
    timezone: 'Z',
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: Math.min(10, Math.max(1, Number(env.DB_POOL_LIMIT || 5))),
    maxIdle: 2,
    idleTimeout: 20000,
    queueLimit: 20,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000,
    charset: 'utf8mb4',
  });
}

module.exports = { SqlitePool, createDatabase, databaseType, resolveSqlitePath };
