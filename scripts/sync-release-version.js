const fs = require('node:fs');
const path = require('node:path');

function versionFromReleaseTag(tag) {
  const match = String(tag || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) throw new Error('RELEASE_TAG_INVALID');
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function syncReleaseVersion(tag, projectRoot = path.join(__dirname, '..')) {
  const version = versionFromReleaseTag(tag);
  const packagePath = path.join(projectRoot, 'package.json');
  const lockPath = path.join(projectRoot, 'package-lock.json');
  const systemVersionPath = path.join(projectRoot, 'version.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (!packageLock.packages || !packageLock.packages['']) throw new Error('PACKAGE_LOCK_INVALID');

  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[''].version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  fs.writeFileSync(systemVersionPath, `${JSON.stringify({ version }, null, 2)}\n`);
  return version;
}

if (require.main === module) {
  try {
    const version = syncReleaseVersion(process.argv[2]);
    console.log(`Runtime version synchronized to ${version}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { syncReleaseVersion, versionFromReleaseTag };
