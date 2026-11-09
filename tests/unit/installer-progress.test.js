const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'launcher.js'), 'utf8');

function installHandler(overrides = {}) {
  const start = source.indexOf("  app.post('/api/setup/install'");
  const end = source.indexOf("\n  app.get('/',", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const calls = [];
  class SetupInputError extends Error {}
  const context = {
    app: { post: (...args) => { handler = args.at(-1); } },
    setupLimiter() {}, authorizeSetup() {}, SetupInputError,
    validateInstall: () => ({ DATA_DIR: 'data' }),
    databaseSignature: () => 'db', emailSignature: () => 'smtp',
    verifiedDbSignatures: new Set(['db']), verifiedEmailSignatures: new Set(['smtp']),
    validateDatabase: () => ({}),
    verifyDatabase: async () => { calls.push('database'); },
    saveInstallerImages: async () => ({ result: { logo: '/media/abcdefghijklmnop.webp' }, saved: [] }),
    saveEnvironment: config => { calls.push(['saved', config.SITE_LOGO, config.SITE_FAVICON]); },
    fs: { rmSync() {}, promises: { unlink: async () => {} } },
    root: 'root', setupKeyPath: 'key', path,
    installSaved: false, installInProgress: false,
    setTimeout: () => ({ unref() {} }), installerServer: { close() {} }, startWiki() {},
    console: { error() {} },
    ...overrides,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { handler, calls, context };
}
function response() {
  return {
    headersSent: false, lines: [], statusCode: 200,
    set() { return this; },
    write(line) { this.headersSent = true; this.lines.push(JSON.parse(line)); },
    end(line) { if (line) this.lines.push(JSON.parse(line)); return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

test('installer emits progress only after actual validation, database check and environment save', async () => {
  const { handler, calls, context } = installHandler();
  const res = response();
  await handler({ body: {} }, res);
  assert.deepEqual(res.lines.map(item => [item.progress, item.stage]), [[25, 'validated'], [50, 'database'], [75, 'starting']]);
  assert.deepEqual(calls, ['database', ['saved', '/media/abcdefghijklmnop.webp', '/assets/favicon.svg']]);
  assert.equal(context.installSaved, true);
  assert.equal(context.installInProgress, false);
});

test('installer stops progress and reports failure instead of claiming success', async () => {
  const { handler, context } = installHandler({ verifyDatabase: async () => { throw new Error('database unavailable'); } });
  const res = response();
  await handler({ body: {} }, res);
  assert.equal(res.lines[0].progress, 25);
  assert.equal(res.lines[1].status, 500);
  assert.equal(res.lines.some(item => item.stage === 'starting'), false);
  assert.equal(context.installSaved, false);
  assert.equal(context.installInProgress, false);
});

test('installer rejects unverified connection settings before streaming or saving', async () => {
  const { handler, calls } = installHandler({ verifiedEmailSignatures: new Set() });
  const res = response();
  await handler({ body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.lines.length, 0);
  assert.equal(calls.length, 0);
});
