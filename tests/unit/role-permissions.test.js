const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrateSitePermissions } = require('../../scripts/role-permissions');

function fixture(affectedRows, fail = false) {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async query(sql, params) {
      if (sql.startsWith('INSERT')) { calls.push('marker'); return [{ affectedRows }]; }
      calls.push(params[0]);
      if (fail) throw new Error('migration failed');
      return [{}];
    },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
  };
  return { calls, pool: { async getConnection() { return connection; } } };
}

test('site permission migration grants both permissions once and commits atomically', async () => {
  const first = fixture(1);
  await migrateSitePermissions(first.pool);
  assert.deepEqual(first.calls, ['begin', 'marker', 'settings.support', 'settings.seo', 'commit', 'release']);
  const repeated = fixture(0);
  await migrateSitePermissions(repeated.pool);
  assert.deepEqual(repeated.calls, ['begin', 'marker', 'commit', 'release']);
});

test('site permission migration rolls back and reports errors', async () => {
  const failed = fixture(1, true);
  await assert.rejects(migrateSitePermissions(failed.pool), /migration failed/);
  assert.deepEqual(failed.calls, ['begin', 'marker', 'settings.support', 'rollback', 'release']);
});

test('existing identity roles keep access without regranting a later revocation', async () => {
  let marker = false;
  const roles = [
    { system: false, permissions: ['admin.view', 'settings.identity'] },
    { system: false, permissions: ['admin.view', 'settings.sidebar_label'] },
    { system: false, permissions: ['settings.identity', 'settings.support'] },
  ];
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      if (sql.startsWith('INSERT')) {
        const affectedRows = marker ? 0 : 1;
        marker = true;
        return [{ affectedRows }];
      }
      for (const role of roles) {
        if (!role.system && role.permissions.includes('settings.identity') && !role.permissions.includes(params[0]))
          role.permissions.push(params[0]);
      }
      return [{}];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const pool = { async getConnection() { return connection; } };
  await migrateSitePermissions(pool);
  assert.deepEqual(roles[0].permissions, ['admin.view', 'settings.identity', 'settings.support', 'settings.seo']);
  assert.deepEqual(roles[1].permissions, ['admin.view', 'settings.sidebar_label']);
  assert.deepEqual(roles[2].permissions, ['settings.identity', 'settings.support', 'settings.seo']);
  roles[0].permissions = roles[0].permissions.filter(permission => permission !== 'settings.support');
  await migrateSitePermissions(pool);
  assert.ok(!roles[0].permissions.includes('settings.support'));
});
