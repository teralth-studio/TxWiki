const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

function registerRoute(startMarker, endMarker, context) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not locate route beginning with ${startMarker}`);
  vm.runInNewContext(source.slice(start, end), context);
  return context.handler;
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(body) { this.body = body; return this; },
  };
}

test('backups endpoint reports empty and pending job lists without throwing', async () => {
  let rows = [];
  const context = {};
  Object.assign(context, {
    app: { get(_route, ...handlers) { context.handler = handlers.at(-1); } },
    auth() {},
    requireAnyPermission() { return () => {}; },
    backupCronExpression: '0 0 * * *',
    backupRetentionCount: 5,
    backupTimeZone: 'UTC',
    backupTimeZones: ['UTC'],
    nextCronDate: () => new Date('2026-11-15T00:00:00.000Z'),
    query: async () => rows,
    listBackups: async () => [],
    canUser: async () => true,
  });
  const handler = registerRoute(
    "app.get(\n  '/api/admin/backups'",
    "\napp.post(\n  '/api/admin/backups/create'",
    context,
  );
  const req = { session: { user: { id: 1 } } };

  const emptyResponse = response();
  await handler(req, emptyResponse, error => { throw error; });
  assert.equal(emptyResponse.body.creating, false);

  rows = [{ id: 19 }];
  const pendingResponse = response();
  await handler(req, pendingResponse, error => { throw error; });
  assert.equal(pendingResponse.body.creating, true);
});

test('manual backup creation rejects an existing job and queues when none exists', async () => {
  let rows = [];
  let queued = 0;
  const context = {};
  Object.assign(context, {
    app: { post(_route, ...handlers) { context.handler = handlers.at(-1); } },
    auth() {},
    requirePermission() { return () => {}; },
    backupCreateLimiter() {},
    backupRetentionCount: 5,
    query: async () => rows,
    enqueueJob: async () => { queued += 1; return true; },
    crypto,
  });
  const handler = registerRoute(
    "app.post(\n  '/api/admin/backups/create'",
    "\napp.get('/api/admin/updates'",
    context,
  );
  const req = { session: { user: { id: 1 } } };

  rows = [{ id: 19 }];
  const pendingResponse = response();
  await handler(req, pendingResponse, error => { throw error; });
  assert.equal(pendingResponse.statusCode, 409);
  assert.equal(queued, 0);

  rows = [];
  const createdResponse = response();
  await handler(req, createdResponse, error => { throw error; });
  assert.equal(createdResponse.statusCode, 202);
  assert.equal(createdResponse.body.queued, true);
  assert.equal(queued, 1);
  context.backupRetentionCount = 0;
  const disabled = response();
  await handler(req, disabled, error => { throw error; });
  assert.equal(disabled.statusCode, 409);
  assert.equal(queued, 1);
});
