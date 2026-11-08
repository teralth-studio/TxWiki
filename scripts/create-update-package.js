'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yazl = require('yazl');
const {
  formatSshPublicKey,
  parseUpdatePublicKey,
  safeInstallationPath,
  safeFilePath,
  singleSqlStatement,
} = require('./site-updater');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(root, 'releases');

function safeSourcePath(value) {
  const parts = typeof value === 'string' ? value.split('/') : [];
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !parts.some(
      (part, index) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:update_zips|updates_zip|releases|node_modules|data)$/i.test(part) ||
        (index === 0 && /^backup$/i.test(part)) ||
        (/^\.env(?:$|[.-])/i.test(part) && !/^\.env\.example$/i.test(part)) ||
        /\.(?:pem|key|sqlite)(?:$|[-.])/i.test(part),
    )
  );
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function readReleaseFile(projectRoot, relativePath) {
  if (!safeSourcePath(relativePath)) throw new Error(`Unsafe release file path: ${relativePath}`);
  const absoluteRoot = await fs.promises.realpath(projectRoot);
  const absolutePath = path.resolve(absoluteRoot, ...relativePath.split('/'));
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Release file escapes project root.');
  let current = absoluteRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in release files: ${relativePath}`);
  }
  const fileStat = await fs.promises.lstat(absolutePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Not a regular release file: ${relativePath}`);
  return fs.promises.readFile(absolutePath);
}

async function createUpdatePackage({
  id,
  version,
  files,
  migrations = [],
  installationFiles = [],
  signingKeyPath = process.env.UPDATE_SIGNING_KEY_PATH,
  destinationDirectory = outputDirectory,
  projectRoot = root,
  trustedPublicKey = process.env.UPDATE_PUBLIC_KEY || require('./update-public-key'),
}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    throw new Error('Invalid update package id.');
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version))
    throw new Error('Invalid update version.');
  if (
    !Array.isArray(files) ||
    !Array.isArray(migrations) ||
    !Array.isArray(installationFiles) ||
    files.length + migrations.length === 0
  )
    throw new Error('At least one file or migration is required.');

  if (typeof signingKeyPath !== 'string' || !path.isAbsolute(signingKeyPath))
    throw new Error('Set UPDATE_SIGNING_KEY_PATH to an absolute path outside the project root.');
  const projectRootRealPath = await fs.promises.realpath(projectRoot);
  const signingKeyRealPath = await fs.promises.realpath(signingKeyPath);
  const relativeSigningKeyPath = path.relative(projectRootRealPath, signingKeyRealPath);
  if (
    !relativeSigningKeyPath ||
    (relativeSigningKeyPath !== '..' &&
      !relativeSigningKeyPath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeSigningKeyPath))
  )
    throw new Error('The update signing key must be stored outside the project root.');
  const privateKey = crypto.createPrivateKey(await fs.promises.readFile(signingKeyRealPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The update signing key must be Ed25519.');
  const publicKey = crypto.createPublicKey(privateKey);
  const trustedKey = parseUpdatePublicKey(trustedPublicKey);
  if (!publicKey.export({ type: 'spki', format: 'der' }).equals(trustedKey.export({ type: 'spki', format: 'der' })))
    throw new Error('The signing key does not match the configured trusted update key.');
  const publicKeyText = formatSshPublicKey(publicKey);

  const fileRecords = [];
  const contents = [];
  const targetPaths = new Set();
  for (const target of files) {
    if (!safeFilePath(target) || targetPaths.has(target.toLowerCase()))
      throw new Error(`Invalid or duplicate update file path: ${target}`);
    targetPaths.add(target.toLowerCase());
    const content = await readReleaseFile(projectRoot, target);
    fileRecords.push({ path: target, sha256: digest(content) });
    contents.push({ archivePath: `files/${target}`, content });
  }

  const migrationRecords = [];
  const migrationIds = new Set();
  const migrationPaths = new Set();
  for (const migration of migrations) {
    if (
      !migration ||
      typeof migration.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(migration.id) ||
      typeof migration.path !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.sql$/.test(migration.path) ||
      typeof migration.source !== 'string' ||
      !/\.sql$/i.test(migration.source) ||
      migrationIds.has(migration.id.toLowerCase()) ||
      migrationPaths.has(migration.path.toLowerCase())
    )
      throw new Error('Invalid or duplicate update migration.');
    migrationIds.add(migration.id.toLowerCase());
    migrationPaths.add(migration.path.toLowerCase());
    const content = await readReleaseFile(projectRoot, migration.source);
    singleSqlStatement(content.toString('utf8'));
    migrationRecords.push({ id: migration.id, path: migration.path, sha256: digest(content) });
    contents.push({ archivePath: `migrations/${migration.path}`, content });
  }

  const installationRecords = [];
  const installationPaths = new Set();
  for (const relativePath of installationFiles) {
    const normalizedPath = typeof relativePath === 'string' ? relativePath.toLowerCase() : '';
    if (!safeInstallationPath(relativePath) || installationPaths.has(normalizedPath))
      throw new Error(`Invalid or duplicate installation file path: ${relativePath}`);
    installationPaths.add(normalizedPath);
    const content = await readReleaseFile(projectRoot, relativePath);
    installationRecords.push({ path: relativePath, sha256: digest(content) });
    contents.push({ archivePath: relativePath, content });
  }

  const manifest = {
    format: 'teralth-wiki-update-v1',
    id,
    version,
    files: fileRecords,
    migrations: migrationRecords,
    ...(installationRecords.length ? { installation: installationRecords } : {}),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, manifestBytes, privateKey).toString('base64');
  await fs.promises.mkdir(destinationDirectory, { recursive: true });
  const destination = path.join(destinationDirectory, `${version}-${id}.zip`);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile();
      const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      output.once('error', reject);
      output.once('close', resolve);
      zip.outputStream.once('error', reject);
      zip.outputStream.pipe(output);
      zip.addBuffer(manifestBytes, 'manifest.json');
      zip.addBuffer(Buffer.from(signature), 'manifest.sig');
      zip.addBuffer(Buffer.from(publicKeyText), 'manifest.pub');
      for (const entry of contents) zip.addBuffer(entry.content, entry.archivePath);
      zip.end();
    });
    await fs.promises.link(temporary, destination);
    await fs.promises.unlink(temporary);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
}

async function main() {
  const descriptorPath = process.argv[2];
  if (!descriptorPath) throw new Error('Usage: node scripts/create-update-package.js <release.json>');
  const descriptor = JSON.parse(await fs.promises.readFile(path.resolve(root, descriptorPath), 'utf8'));
  const packagePath = await createUpdatePackage(descriptor);
  console.log(`Signed update package created: ${path.relative(root, packagePath)}`);
}

if (require.main === module)
  main().catch((error) => {
    console.error(`Update package creation failed: ${error.message}`);
    process.exitCode = 1;
  });

module.exports = { createUpdatePackage };
