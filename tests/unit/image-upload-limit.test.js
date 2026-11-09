const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const multer = require('multer');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function uploadMiddleware(value) {
  const start = source.indexOf('const imageUploadLimitValue =');
  const end = source.indexOf('\nconst query =', start);
  assert.ok(start >= 0 && end > start);
  const env = value === undefined ? {} : { IMAGE_UPLOAD_MAX_MB: value };
  const context = { process: { env }, multer, console };
  vm.runInNewContext(source.slice(start, end) + '\nthis.middleware = uploadImageMiddleware;', context);
  return context.middleware;
}

test('image upload configuration rejects invalid limits', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', '1e3', '999999999999999999999']) {
    assert.throws(() => uploadMiddleware(value), /IMAGE_UPLOAD_MAX_MB/);
  }
  assert.doesNotThrow(() => uploadMiddleware());
  assert.doesNotThrow(() => uploadMiddleware('2'));
});

test('configured image limit is enforced on multipart uploads', async t => {
  const app = express();
  app.post('/upload', uploadMiddleware('1'), (req, res) => res.json({ bytes: req.file.size }));
  app.post('/default', uploadMiddleware(), (req, res) => res.json({ bytes: req.file.size }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  async function send(size, endpoint = '/upload') {
    const form = new FormData();
    form.append('image', new Blob([Buffer.alloc(size)]), 'image.png');
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
      method: 'POST', body: form,
    });
    return { status: response.status, body: await response.json() };
  }
  const allowed = await send(1024 * 1024 - 1);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.bytes, 1024 * 1024 - 1);
  const rejected = await send(1024 * 1024 + 1);
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.error, 'El archivo no puede pesar más de 1 MB.');
  const defaultAllowed = await send(50 * 1024 * 1024 - 1, '/default');
  assert.equal(defaultAllowed.status, 200);
  assert.equal(defaultAllowed.body.bytes, 50 * 1024 * 1024 - 1);
  const defaultRejected = await send(50 * 1024 * 1024 + 1, '/default');
  assert.equal(defaultRejected.status, 413);
  assert.equal(defaultRejected.body.error, 'El archivo no puede pesar más de 50 MB.');
});
