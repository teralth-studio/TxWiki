'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readRegularFileNoFollow } = require('../../scripts/safe-file');

test('reads an open regular file and rejects directories', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'txwiki-safe-file-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'release.txt');
  await fs.writeFile(file, 'release data');

  const result = await readRegularFileNoFollow(file);
  assert.equal(result.content.toString(), 'release data');
  assert.notEqual(result.mode & 0o400, 0);
  await assert.rejects(readRegularFileNoFollow(directory), { code: 'ERR_NOT_REGULAR_FILE' });
});
