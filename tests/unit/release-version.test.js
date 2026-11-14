const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { syncReleaseVersion, versionFromReleaseTag } = require('../../scripts/sync-release-version');

test('release tag version is synchronized into both npm manifests', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'txwiki-release-version-'));
  try {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'txwiki', version: '1.2.0' }));
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), JSON.stringify({
      name: 'txwiki', version: '1.2.0', packages: { '': { name: 'txwiki', version: '1.2.0' } },
    }));

    assert.equal(syncReleaseVersion('v1.7.8', projectRoot), '1.7.8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, 'version.json'), 'utf8'));
    assert.equal(packageJson.version, '1.7.8');
    assert.equal(packageLock.version, '1.7.8');
    assert.equal(packageLock.packages[''].version, '1.7.8');
    assert.equal(runtime.version, '1.7.8');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('release version parser rejects prerelease and malformed tags', () => {
  assert.equal(versionFromReleaseTag('1.6.5'), '1.6.5');
  for (const tag of ['v1.7.8-beta', 'v01.7.8', 'latest', 'v1.7'])
    assert.throws(() => versionFromReleaseTag(tag), /RELEASE_TAG_INVALID/);
});

test('release workflow synchronizes tag version before packaging dependencies', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
  const syncStep = publishJob.indexOf('node scripts/sync-release-version.js "$RELEASE_TAG"');
  const installStep = publishJob.indexOf('run: npm ci');
  const packageStep = publishJob.indexOf('node scripts/create-release-package.js "$version" "$RELEASE_TAG"');
  assert.ok(syncStep >= 0 && syncStep < installStep, 'version sync must run before npm ci');
  assert.ok(installStep >= 0 && installStep < packageStep, 'dependencies must install before package creation');
});
