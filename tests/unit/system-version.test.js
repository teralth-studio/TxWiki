const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { systemVersion } = require('../../scripts/system-version');

test('system version reads the updateable version file and falls back to package metadata', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'txwiki-system-version-'));
  const packagePath = path.join(projectRoot, 'package.json');
  const versionPath = path.join(projectRoot, 'version.json');
  try {
    fs.writeFileSync(packagePath, JSON.stringify({ version: '1.6.5' }));
    assert.equal(systemVersion(projectRoot), '1.6.5');

    fs.writeFileSync(versionPath, JSON.stringify({ version: '1.7.8' }));
    assert.equal(systemVersion(projectRoot), '1.7.8');

    fs.writeFileSync(versionPath, '{invalid');
    assert.equal(systemVersion(projectRoot), '1.6.5');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
