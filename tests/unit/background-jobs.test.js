const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

test('background worker processes a claimed mail job and records delivery failures', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('let jobWorkerBusy = false,');
  const end = source.indexOf('\nfunction startBackgroundJobWorker()', start);
  assert.ok(start >= 0 && end > start);
  for (const fail of [false, true]) {
    const calls = [], messages = [], errors = [];
    const job = { id: 17, job_type: 'mail', payload: 'encrypted', attempts: 1 };
    const context = {
      crypto: { randomUUID: () => 'test-lock' },
      pool: {
        async execute(sql, params) {
          calls.push({ sql, params });
          return [{ affectedRows: 1 }];
        },
      },
      query: async sql => sql.startsWith('SELECT id,job_type') ? [job] : [],
      decryptJobPayload: () => ({ to: 'example', subject: 'subject', html: 'body' }),
      mailer: {},
      mail: async (...args) => {
        messages.push(args);
        if (fail) throw Object.assign(new Error('delivery failure'), { code: 'ETIMEDOUT' });
      },
      console: { error: (...args) => errors.push(args.join(' ')) },
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    };
    vm.runInNewContext(source.slice(start, end), context);
    await context.pumpBackgroundJobs();
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], ['example', 'subject', 'body']);
    if (fail) {
      const retry = calls.find(call => call.sql.includes('SET status=?,payload=IF'));
      assert.ok(retry);
      assert.equal(retry.params[0], 'queued');
      assert.equal(retry.params[3], 'ETIMEDOUT');
      assert.match(errors[0], /ETIMEDOUT/);
    } else {
      assert.ok(calls.some(call => call.sql.includes("SET status='done',payload=NULL")));
      assert.equal(errors.length, 0);
    }
  }
});
