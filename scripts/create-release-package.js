'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createUpdatePackage } = require('./create-update-package');
const { safeFilePath, safeInstallationPath } = require('./site-updater');

const root = path.resolve(__dirname, '..');
const includedRootFiles = new Set([
  '.env.example',
  '.gitignore',
  'themes/README.md',
  'themes/default.zip',
  'PTERODACTYL-INSTALL.txt',
  'launcher.js',
  'package-lock.json',
  'package.json',
  'pterodactyl-start.js',
  'playwright.config.js',
  'schema.sql',
  'schema.sqlite.sql',
  'server.js',
]);
const includedDirectories = ['.github', 'emails', 'languages', 'public', 'scripts', 'tests'];
const excludedNames = new Set([
  '.git',
  'backup',
  'data',
  'images',
  'node_modules',
  'releases',
  'update_zips',
  'updates_zip',
  'work',
]);

async function collectInstallationFiles(projectRoot = root) {
  const files = [];
  const addTree = async relativeDirectory => {
    const absoluteDirectory = path.join(projectRoot, ...relativeDirectory.split('/'));
    let entries;
    try {
      entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (relativePath === '.github/modernize') continue;
      if (
        (excludedNames.has(entry.name) && relativePath !== 'scripts/backup') ||
        /^\.env(?:$|[.-])/.test(entry.name)
      )
        continue;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink())
        throw new Error(`Symbolic links are not allowed in release files: ${relativePath}`);
      if (stat.isDirectory()) await addTree(relativePath);
      else if (stat.isFile() && safeInstallationPath(relativePath)) files.push(relativePath);
    }
  };

  for (const name of [...includedRootFiles].sort()) {
    try {
      const stat = await fs.promises.lstat(path.join(projectRoot, name));
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Not a regular release file: ${name}`);
      files.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const directory of includedDirectories) await addTree(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

async function createReleasePackage({
  version,
  id,
  projectRoot = root,
  destinationDirectory,
  signingKeyPath,
  trustedPublicKey,
}) {
  const installationFiles = await collectInstallationFiles(projectRoot);
  const files = installationFiles.filter(
    file =>
      safeFilePath(file) &&
      !file.startsWith('scripts/default-theme/') &&
      file !== 'themes/README.md' &&
      file !== 'themes/default.zip' &&
      !file.endsWith('.test.js'),
  );
  if (!files.length) throw new Error('No update-compatible application files were found.');
  return createUpdatePackage({
    id,
    version,
    files,
    migrations: [],
    installationFiles,
    projectRoot,
    ...(destinationDirectory ? { destinationDirectory } : {}),
    ...(signingKeyPath ? { signingKeyPath } : {}),
    ...(trustedPublicKey ? { trustedPublicKey } : {}),
  });
}

async function main() {
  const [version, id] = process.argv.slice(2);
  if (!version || !id)
    throw new Error('Usage: node scripts/create-release-package.js <version> <id>');
  const packagePath = await createReleasePackage({ version, id });
  console.log(`Signed install/update package created: ${path.relative(root, packagePath)}`);
}

if (require.main === module)
  main().catch(error => {
    console.error(`Release package creation failed: ${error.message}`);
    process.exitCode = 1;
  });

module.exports = { collectInstallationFiles, createReleasePackage };
