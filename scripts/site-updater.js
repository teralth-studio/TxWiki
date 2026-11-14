'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yauzl = require('yauzl');
const { readRegularFileNoFollow } = require('./safe-file');

const maxEntries = 1200;
const maxManifestBytes = 128 * 1024;
const maxEntryBytes = 20 * 1024 * 1024;
const maxExpandedBytes = 100 * 1024 * 1024;
const manifestName = 'manifest.json';
const signatureName = 'manifest.sig';
const publicKeyName = 'manifest.pub';
const updateFormat = 'teralth-wiki-update-v1';

class UpdateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UpdateError';
    this.status = status;
  }
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => (error ? reject(error) : resolve(zip)),
    );
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxEntryBytes) stream.destroy(new UpdateError('Un archivo del paquete excede el límite.'));
        else chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks, size)));
    });
  });
}

function safeArchiveName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 512 &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.startsWith('/') &&
    !/^[A-Za-z]:/.test(name) &&
    name.split('/').every((part, index, parts) => {
      if (index === parts.length - 1 && part === '' && name.endsWith('/')) return true;
      return Boolean(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part);
    })
  );
}

function safeFilePath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
  )
    return false;
  return (
    value === 'server.js' ||
    value === 'launcher.js' ||
    value === 'pterodactyl-start.js' ||
    /^public\/(?:app|admin-updates|installer|maintenance)\.js$/.test(value) ||
    /^public\/(?:styles|installer|maintenance)\.css$/.test(value) ||
    /^public\/(?:index|installer|maintenance)\.html$/.test(value) ||
    /^languages\/language_[A-Za-z0-9-]+\.json$/.test(value) ||
    /^scripts\/[A-Za-z0-9._/-]+\.js$/.test(value) ||
    /^scripts\/default-theme\/(?:settings\.json|theme\.css)$/.test(value) ||
    value === 'themes/README.md' ||
    value === 'themes/default.zip' ||
    /^emails\/[A-Za-z0-9._/-]+\.(?:js|html)$/.test(value) ||
    /^themes\/[a-z0-9][a-z0-9_-]{0,47}\/(?:settings\.json|theme\.css|preview\.png|assets\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp|avif|woff2?|ttf|otf)|source\/public\/(?:index\.html|styles\.css))$/.test(value)
  );
}

function safeInstallationPath(value) {
  const parts = typeof value === 'string' ? value.split('/') : [];
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    parts.some(
      (part, index) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:node_modules|update_zips|updates_zip|releases|data|images|work|\.git)$/i.test(part) ||
        (index === 0 && /^backup$/i.test(part)) ||
        (/^\.env(?:$|[.-])/i.test(part) && !/^\.env\.example$/i.test(part)) ||
        /(?:^|\.)(?:pem|key|p12|pfx|sqlite)$/i.test(part),
    )
  )
    return false;
  if (
    parts.length === 1 &&
    ['manifest.json', 'manifest.sig', 'manifest.pub', 'files', 'migrations'].includes(value.toLowerCase())
  )
    return false;
  return true;
}

function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function parseUpdatePublicKey(value) {
  const text = String(value).trim();
  if (text.startsWith('-----BEGIN')) return crypto.createPublicKey(text.replaceAll('\\n', '\n'));
  if (text.length > 1024) throw new Error('SSH public key is too long.');
  const [algorithm, encoded] = text.split(/\s+/, 3);
  if (algorithm !== 'ssh-ed25519' || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error('Unsupported SSH public key format.');
  const blob = Buffer.from(encoded, 'base64');
  if (blob.toString('base64') !== encoded) throw new Error('Malformed SSH public key encoding.');
  let offset = 0;
  const readSshString = () => {
    if (offset + 4 > blob.length) throw new Error('Malformed SSH public key.');
    const length = blob.readUInt32BE(offset);
    offset += 4;
    if (length > blob.length - offset) throw new Error('Malformed SSH public key.');
    const value = blob.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const embeddedAlgorithm = readSshString().toString('ascii');
  const rawKey = readSshString();
  if (offset !== blob.length || embeddedAlgorithm !== 'ssh-ed25519' || rawKey.length !== 32)
    throw new Error('Malformed SSH Ed25519 public key.');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, rawKey]),
    format: 'der',
    type: 'spki',
  });
}

function sshPublicKeyBlob(publicKey) {
  const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const algorithm = Buffer.from('ssh-ed25519');
  const addLength = (value) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  return Buffer.concat([addLength(algorithm), addLength(rawKey)]);
}

function formatSshPublicKey(publicKey, comment = 'teralth-wiki-release') {
  return `ssh-ed25519 ${sshPublicKeyBlob(publicKey).toString('base64')} ${comment}`;
}

function validateManifest(manifest, entries) {
  const legacyKeys = ['format', 'id', 'version', 'files', 'migrations'];
  const releaseKeys = [...legacyKeys, 'installation'];
  if (
    !(hasExactKeys(manifest, legacyKeys) || hasExactKeys(manifest, releaseKeys)) ||
    manifest.format !== updateFormat ||
    typeof manifest.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.id) ||
    typeof manifest.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.version) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.migrations) ||
    manifest.files.length + manifest.migrations.length === 0 ||
    manifest.files.length > 1000 ||
    manifest.migrations.length > 200 ||
    (manifest.installation !== undefined &&
      (!Array.isArray(manifest.installation) || manifest.installation.length > 1000))
  )
    throw new UpdateError('El manifiesto del paquete no es válido.');

  const expected = new Set([manifestName, signatureName, publicKeyName]);
  const filePaths = new Set();
  for (const file of manifest.files) {
    const normalizedPath = typeof file.path === 'string' ? file.path.toLowerCase() : '';
    if (
      !hasExactKeys(file, ['path', 'sha256']) ||
      !safeFilePath(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      filePaths.has(normalizedPath)
    )
      throw new UpdateError('La lista de archivos del paquete no es válida.');
    filePaths.add(normalizedPath);
    expected.add(`files/${file.path}`);
  }
  const migrationIds = new Set();
  const migrationPaths = new Set();
  for (const migration of manifest.migrations) {
    const normalizedId = typeof migration.id === 'string' ? migration.id.toLowerCase() : '';
    const normalizedPath = typeof migration.path === 'string' ? migration.path.toLowerCase() : '';
    if (
      !hasExactKeys(migration, ['id', 'path', 'sha256']) ||
      typeof migration.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(migration.id) ||
      typeof migration.path !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.sql$/.test(migration.path) ||
      !/^[a-f0-9]{64}$/.test(migration.sha256) ||
      migrationIds.has(normalizedId) ||
      migrationPaths.has(normalizedPath)
    )
      throw new UpdateError('La lista de migraciones del paquete no es válida.');
    migrationIds.add(normalizedId);
    migrationPaths.add(normalizedPath);
    expected.add(`migrations/${migration.path}`);
  }

  const installationPaths = new Set();
  for (const file of manifest.installation || []) {
    const normalizedPath = typeof file.path === 'string' ? file.path.toLowerCase() : '';
    if (
      !hasExactKeys(file, ['path', 'sha256']) ||
      !safeInstallationPath(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      installationPaths.has(normalizedPath)
    )
      throw new UpdateError('La lista de archivos de instalación no es válida.');
    installationPaths.add(normalizedPath);
    expected.add(file.path);
  }

  const allowedDirectories = new Set(['files/', 'migrations/', 'installation/']);
  for (const name of entries.keys())
    if (!expected.has(name) && !allowedDirectories.has(name))
      throw new UpdateError('El ZIP contiene archivos que no están declarados en el manifiesto.');
  for (const name of expected)
    if (!entries.has(name)) throw new UpdateError('Falta un archivo declarado en el manifiesto.');
}

async function verifyUpdatePackage(file, publicKeyValue, { onProgress = () => {} } = {}) {
  if (!publicKeyValue)
    throw new UpdateError('El administrador del servidor debe configurar UPDATE_PUBLIC_KEY.', 503);
  let publicKey;
  try {
    publicKey = parseUpdatePublicKey(publicKeyValue);
  } catch {
    throw new UpdateError('La clave pública configurada para actualizaciones no es una clave Ed25519 válida.', 503);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519')
    throw new UpdateError('UPDATE_PUBLIC_KEY debe ser una clave Ed25519.', 503);

  let zip;
  try {
    zip = await openZip(file);
  } catch {
    throw new UpdateError('No se pudo leer el ZIP. Comprueba que el paquete no esté dañado.');
  }
  const entries = new Map();
  let totalBytes = 0;
  try {
    await new Promise((resolve, reject) => {
      let count = 0;
      let finished = false;
      const fail = (error) => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (finished) return;
        finished = true;
        resolve();
      });
      zip.on('entry', (entry) => {
        (async () => {
          count++;
          onProgress(8 + Math.min(count, 7));
          if (count > maxEntries) throw new UpdateError('El ZIP contiene demasiados archivos.');
          if (!safeArchiveName(entry.fileName))
            throw new UpdateError('El ZIP contiene una ruta no permitida.');
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) throw new UpdateError('El ZIP no puede contener enlaces simbólicos.');
          if (entry.fileName.endsWith('/')) {
            if (!['files/', 'migrations/'].includes(entry.fileName))
              throw new UpdateError('El ZIP contiene un directorio no permitido.');
            if (entries.has(entry.fileName)) throw new UpdateError('El ZIP contiene rutas duplicadas.');
            entries.set(entry.fileName, null);
            zip.readEntry();
            return;
          }
          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0 ||
            entry.uncompressedSize > maxEntryBytes
          )
            throw new UpdateError('Un archivo del paquete excede el límite.');
          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxExpandedBytes) throw new UpdateError('El paquete expandido excede el límite.');
          if (entries.has(entry.fileName)) throw new UpdateError('El ZIP contiene rutas duplicadas.');
          entries.set(entry.fileName, await readEntry(zip, entry));
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError('El ZIP no se puede leer o está dañado.');
  } finally {
    zip.close();
  }

  const manifestBytes = entries.get(manifestName),
    packagePublicKey = entries.get(publicKeyName),
    signatureText = entries.get(signatureName)?.toString('ascii').trim();
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > maxManifestBytes)
    throw new UpdateError('El paquete debe incluir un manifiesto de actualización válido.');
  if (!Buffer.isBuffer(packagePublicKey) || packagePublicKey.length > 1024)
    throw new UpdateError('El paquete no incluye la clave pública SSH esperada.');
  try {
    const packagePublicKeyText = packagePublicKey.toString('ascii').trim();
    if (!packagePublicKeyText.startsWith('ssh-ed25519 '))
      throw new Error('The package key must use OpenSSH format.');
    if (!sshPublicKeyBlob(parseUpdatePublicKey(packagePublicKeyText)).equals(sshPublicKeyBlob(publicKey)))
      throw new Error('Key mismatch.');
  } catch {
    throw new UpdateError('La clave pública SSH del paquete no coincide con la clave oficial.');
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureText || ''))
    throw new UpdateError('La firma del paquete no tiene un formato válido.');
  const signature = Buffer.from(signatureText, 'base64');
  if (signature.length !== 64 || !crypto.verify(null, manifestBytes, publicKey, signature))
    throw new UpdateError('La firma del paquete no es válida.');
  onProgress(16);

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new UpdateError('El manifiesto del paquete no contiene JSON válido.');
  }
  validateManifest(manifest, entries);

  const files = manifest.files.map(({ path: target, sha256 }) => {
      const content = entries.get(`files/${target}`);
      if (!Buffer.isBuffer(content) || crypto.createHash('sha256').update(content).digest('hex') !== sha256)
        throw new UpdateError(`La verificación del archivo ${target} falló.`);
      return { path: target, content };
    }),
    migrations = manifest.migrations.map(({ id, path: name, sha256 }) => {
      const content = entries.get(`migrations/${name}`);
      if (
        !Buffer.isBuffer(content) ||
        crypto.createHash('sha256').update(content).digest('hex') !== sha256
      )
        throw new UpdateError(`La verificación de la migración ${name} falló.`);
      return { id, path: name, sha256, sql: content.toString('utf8') };
    });
  const installation = (manifest.installation || []).map(({ path: target, sha256 }) => {
    const content = entries.get(target);
    if (
      !Buffer.isBuffer(content) ||
      crypto.createHash('sha256').update(content).digest('hex') !== sha256
    )
      throw new UpdateError(`La verificación del archivo de instalación ${target} falló.`);
    return { path: target, content };
  });
  for (const migration of migrations) singleSqlStatement(migration.sql);
  onProgress(18);
  return { id: manifest.id, version: manifest.version, files, migrations, installation };
}

async function preflightUpdatePackage(pkg, { root, connection, onProgress = () => {} }) {
  const realRoot = await fs.promises.realpath(root);
  let requiredBytes = 0;
  for (const [index, file] of pkg.files.entries()) {
    if (!safeFilePath(file.path) || !Buffer.isBuffer(file.content))
      throw new UpdateError('El paquete contiene un archivo no válido.');
    requiredBytes += file.content.length;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.content);
    } catch {
      throw new UpdateError(`El archivo ${file.path} no contiene texto UTF-8 válido.`);
    }
    if (text.includes('\0')) throw new UpdateError(`El archivo ${file.path} contiene datos no válidos.`);
    const extension = path.extname(file.path).toLowerCase();
    try {
      if (extension === '.js') new vm.Script(text, { filename: path.basename(file.path), displayErrors: false });
      else if (extension === '.json') JSON.parse(text);
      else if (extension === '.css')
        require('lightningcss').transform({ filename: file.path, code: file.content, minify: false });
    } catch {
      throw new UpdateError(`La validación de sintaxis falló para ${file.path}.`);
    }
    let current = realRoot,
      writableDirectory = realRoot;
    const parts = file.path.split('/');
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try {
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw new UpdateError(`La ruta de destino de ${file.path} no es segura.`);
        writableDirectory = current;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        break;
      }
    }
    await fs.promises.access(writableDirectory, fs.constants.W_OK);
    const target = path.join(realRoot, ...parts);
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new UpdateError(`La ruta de destino de ${file.path} no es segura.`);
      await fs.promises.access(target, fs.constants.W_OK);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    onProgress('preflight', 18 + Math.floor(((index + 1) / Math.max(pkg.files.length, 1)) * 8));
  }
  for (const migration of pkg.migrations) singleSqlStatement(migration.sql);
  const [health] = await connection.query('SELECT 1 AS ready');
  if (Number(health[0]?.ready) !== 1)
    throw new UpdateError('La comprobación de la base de datos no se completó.', 503);
  const stats = await fs.promises.statfs(realRoot);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < requiredBytes * 2 + 5 * 1024 * 1024)
    throw new UpdateError('No hay suficiente espacio disponible para instalar el paquete.', 507);
  onProgress('preflight', 28);
}

function singleSqlStatement(sql) {
  let quote = '',
    lineComment = false,
    blockComment = false,
    statementEnded = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index],
      next = sql[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === quote) {
        if (next === quote) index++;
        else quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '#' || (char === '-' && next === '-' && /\s/.test(sql[index + 2] || '')))
      lineComment = true;
    else if (char === '/' && next === '*') {
      blockComment = true;
      index++;
    } else if (char === ';') {
      if (statementEnded || sql.slice(index + 1).replace(/(?:--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|\s)/g, ''))
        throw new UpdateError('Cada archivo SQL debe contener una sola sentencia.');
      statementEnded = true;
    } else if (statementEnded && !/\s/.test(char))
      throw new UpdateError('Cada archivo SQL debe contener una sola sentencia.');
  }
  if (quote || blockComment) throw new UpdateError('Una migración SQL tiene comillas o comentarios sin cerrar.');
  const statement = sql.trim().replace(/;$/, '').trim();
  if (!statement) throw new UpdateError('Una migración SQL está vacía.');
  return statement;
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number),
    b = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function ensureUpdateTables(pool) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS wiki_updates (update_id VARCHAR(128) NOT NULL PRIMARY KEY,release_version VARCHAR(32) NOT NULL,applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB',
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS wiki_update_migrations (migration_id VARCHAR(128) NOT NULL PRIMARY KEY,update_id VARCHAR(128) NOT NULL,sha256 CHAR(64) NOT NULL,applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB',
  );
}

async function ensureSafeDirectory(root, relativeDirectory) {
  let current = root;
  for (const part of relativeDirectory.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new UpdateError('La ruta de destino de la actualización no es segura.', 500);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.promises.mkdir(current, { mode: 0o750 });
    }
  }
  return current;
}

async function applyUpdatePackage({
  pkg,
  root,
  pool,
  createBackup,
  restart,
  installedVersion,
  onProgress = () => {},
}) {
  await ensureUpdateTables(pool);
  const [priorUpdate] = await pool.execute('SELECT update_id FROM wiki_updates WHERE update_id=?', [pkg.id]);
  if (priorUpdate.length) throw new UpdateError('Este paquete ya se instaló.', 409);
  const [priorHistory] = await pool.query('SELECT release_version FROM wiki_updates');
  const priorVersion = priorHistory.reduce(
    (latest, row) => (compareVersions(row.release_version, latest) > 0 ? row.release_version : latest),
    installedVersion,
  );
  if (compareVersions(pkg.version, priorVersion) <= 0)
    throw new UpdateError('La versión debe ser superior a la ya instalada.', 409);
  const lockConnection = await pool.getConnection();
  let lockAcquired = false;
  const appliedFiles = [];
  try {
    const [lockRows] = await lockConnection.query("SELECT GET_LOCK('teralth-site-update',0) AS acquired");
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) throw new UpdateError('Ya hay una actualización en curso.', 409);

    await preflightUpdatePackage(pkg, { root, connection: lockConnection, onProgress });
    const [existingUpdate] = await lockConnection.execute(
      'SELECT update_id FROM wiki_updates WHERE update_id=?',
      [pkg.id],
    );
    if (existingUpdate.length) throw new UpdateError('Este paquete ya se instaló.', 409);
    const [history] = await lockConnection.query('SELECT release_version FROM wiki_updates');
    const currentVersion = history.reduce(
      (latest, row) => (compareVersions(row.release_version, latest) > 0 ? row.release_version : latest),
      installedVersion,
    );
    if (compareVersions(pkg.version, currentVersion) <= 0)
      throw new UpdateError('La versión debe ser superior a la ya instalada.', 409);

    onProgress('backup', 30);
    const backup = await createBackup((progress) =>
      onProgress('backup', 30 + Math.floor((progress / 100) * 18)),
    );
    onProgress('backup-complete', 48);
    const realRoot = await fs.promises.realpath(root);
    for (const [index, file] of pkg.files.entries()) {
      const parts = file.path.split('/'),
        directory = await ensureSafeDirectory(realRoot, parts.slice(0, -1).join('/')),
        target = path.join(directory, parts.at(-1)),
        relativeTarget = path.relative(realRoot, target);
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget))
        throw new UpdateError('La ruta de destino de la actualización no es segura.', 400);
      let prior = null;
      try {
        const existing = await readRegularFileNoFollow(target);
        prior = { content: existing.content, mode: existing.mode };
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (error.code === 'ERR_NOT_REGULAR_FILE' || error.code === 'ELOOP')
            throw new UpdateError('La ruta de destino de la actualización no es segura.', 400);
          throw error;
        }
      }
      appliedFiles.push({ target, prior, staged: `${target}.update-${crypto.randomUUID()}.tmp` });
      await fs.promises.writeFile(appliedFiles.at(-1).staged, file.content, {
        flag: 'wx',
        mode: prior?.mode || 0o640,
      });
      onProgress('staging', 48 + Math.floor(((index + 1) / Math.max(pkg.files.length, 1)) * 15));
    }

    for (const [index, entry] of appliedFiles.entries()) {
      if (entry.prior) {
        entry.rollback = `${entry.target}.rollback-${crypto.randomUUID()}`;
        await fs.promises.rename(entry.target, entry.rollback);
      }
      await fs.promises.rename(entry.staged, entry.target);
      entry.installed = true;
      onProgress('installing-files', 63 + Math.floor(((index + 1) / Math.max(appliedFiles.length, 1)) * 12));
    }

    for (const [index, migration] of pkg.migrations.entries()) {
      const [existing] = await lockConnection.execute(
        'SELECT sha256 FROM wiki_update_migrations WHERE migration_id=?',
        [migration.id],
      );
      if (existing.length) {
        if (existing[0].sha256 !== migration.sha256)
          throw new UpdateError(`El identificador de migración ${migration.id} ya existe con otro contenido.`, 409);
        continue;
      }
      await lockConnection.query(singleSqlStatement(migration.sql));
      await lockConnection.execute(
        'INSERT INTO wiki_update_migrations (migration_id,update_id,sha256) VALUES (?,?,?)',
        [migration.id, pkg.id, migration.sha256],
      );
      onProgress('migrations', 75 + Math.floor(((index + 1) / Math.max(pkg.migrations.length, 1)) * 15));
    }
    onProgress('finalizing', 95);
    await lockConnection.execute('INSERT INTO wiki_updates (update_id,release_version) VALUES (?,?)', [
      pkg.id,
      pkg.version,
    ]);
    for (const entry of appliedFiles)
      if (entry.rollback) await fs.promises.unlink(entry.rollback);
    onProgress('complete', 100);
    await restart();
    return { version: pkg.version, backup: backup.name };
  } catch (error) {
    for (const entry of appliedFiles.reverse()) {
      await fs.promises.unlink(entry.staged).catch(() => {});
      if (entry.installed) await fs.promises.unlink(entry.target).catch(() => {});
      if (entry.rollback) await fs.promises.rename(entry.rollback, entry.target).catch(() => {});
      else if (entry.prior && !entry.installed)
        await fs.promises.writeFile(entry.target, entry.prior.content, { mode: entry.prior.mode }).catch(() => {});
    }
    throw error;
  } finally {
    if (lockAcquired) await lockConnection.query("SELECT RELEASE_LOCK('teralth-site-update')").catch(() => {});
    lockConnection.release();
  }
}

module.exports = {
  UpdateError,
  applyUpdatePackage,
  compareVersions,
  ensureUpdateTables,
  formatSshPublicKey,
  parseUpdatePublicKey,
  sshPublicKeyBlob,
  preflightUpdatePackage,
  safeInstallationPath,
  safeFilePath,
  singleSqlStatement,
  verifyUpdatePackage,
};
