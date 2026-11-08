const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const dotenv = require('dotenv');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'launcher.js'), 'utf8');

function saveEnvironment(existing, environment = {}) {
  const start = source.indexOf('function saveEnvironment(');
  const end = source.indexOf('\nif (isConfigured)', start);
  assert.ok(start >= 0 && end > start);
  let written;
  const context = {
    root: 'test-root', envPath: 'test-env', dotenv, path,
    crypto: { randomUUID: () => 'test' },
    process: { env: { ...environment } },
    fs: {
      existsSync: () => existing !== undefined,
      readFileSync: () => existing,
      writeFileSync: (file, content) => { written = content; },
      renameSync() {}, chmodSync() {},
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.saveEnvironment({ SITE_NAME: 'Example' });
  return dotenv.parse(written);
}

test('installer writes the default image upload limit without overriding existing values', () => {
  assert.equal(saveEnvironment().IMAGE_UPLOAD_MAX_MB, '50');
  assert.equal(saveEnvironment('IMAGE_UPLOAD_MAX_MB=100\n').IMAGE_UPLOAD_MAX_MB, '100');
  assert.equal(saveEnvironment(undefined, { IMAGE_UPLOAD_MAX_MB: '75' }).IMAGE_UPLOAD_MAX_MB, '75');
});
