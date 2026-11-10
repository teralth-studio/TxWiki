const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');
const crypto = require('node:crypto');
const { DEFAULT_THEME, listThemes, safeThemeSlug } = require('../theme-manager');

const maxArchiveEntries = 10_000;
const maxDatabaseBytes = 100 * 1024 * 1024;
const maxImageBytes = 25 * 1024 * 1024;
const maxTotalImageBytes = 500 * 1024 * 1024;
const imagePattern = /^[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/i;

function validateThemeArchivePath(archivePath) {
  const marker = 'application/themes/';
  const index = archivePath.lastIndexOf(marker);
  if (index < 0) return;
  const themePath = archivePath.slice(index + marker.length);
  if (!/^(?!default\/)[a-z0-9][a-z0-9_-]{0,47}\/(?:settings\.json|theme\.css|preview\.png|assets\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp|avif|woff2?|ttf|otf))$/.test(themePath))
    throw new Error('BACKUP_THEME_PATH_INVALID');
}

async function addSource(zip, source, archivePath) {
  let sourceStat;
  try { sourceStat = await fs.promises.lstat(source); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (sourceStat.isSymbolicLink()) throw new Error('BACKUP_SYMLINK_NOT_ALLOWED');
  if (!sourceStat.isDirectory() && !sourceStat.isFile()) throw new Error('BACKUP_FILE_TYPE_NOT_ALLOWED');
  const realRoot = sourceStat.isDirectory()
    ? await fs.promises.realpath(source)
    : await fs.promises.realpath(path.dirname(source));

  async function addFile(absolute, relativePath) {
    const stat = await fs.promises.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('BACKUP_SYMLINK_NOT_ALLOWED');
    if (!stat.isFile()) throw new Error('BACKUP_FILE_TYPE_NOT_ALLOWED');
    const resolved = await fs.promises.realpath(absolute);
    if (!resolved.startsWith(realRoot + path.sep)) throw new Error('BACKUP_PATH_INVALID');
    const entryPath = relativePath ? `${archivePath}/${relativePath}` : archivePath;
    if (entryPath.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('BACKUP_PATH_INVALID');
    validateThemeArchivePath(entryPath);
    zip.addFile(absolute, entryPath, { mode: 0o600, compress: true });
  }

  if (sourceStat.isFile()) {
    const basename = path.basename(source);
    if (basename === 'setup.key' || /^\.env(?:\..*)?$/.test(basename)) return;
    await addFile(source, '');
    return;
  }

  async function visit(folder, relativeFolder = '') {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'setup.key' ||
          /^\.env(?:\..*)?$/.test(entry.name) || /^\.restore-[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const absolute = path.join(folder, entry.name);
      const relativePath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
      const currentArchiveDirectory = relativeFolder
        ? `${archivePath}/${relativeFolder}`
        : archivePath;
      // These are distributable template assets, not user themes. They ship
      // with application code and are regenerated/replaced by releases.
      if (
        currentArchiveDirectory.endsWith('/application/themes') &&
        (entry.name === 'README.md' || entry.name === 'teralth-default-theme-source.zip')
      ) continue;
      if (entry.name === DEFAULT_THEME &&
          (currentArchiveDirectory === 'application/themes' ||
            currentArchiveDirectory.endsWith('/application/themes'))) continue;
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('BACKUP_SYMLINK_NOT_ALLOWED');
      if (stat.isDirectory()) await visit(absolute, relativePath);
      else await addFile(absolute, relativePath);
    }
  }
  await visit(source);
}

async function createBackupZipStream(directory, archiveRoot) {
  const zip = new yazl.ZipFile();
  await addSource(zip, directory, archiveRoot);
  zip.end();
  return zip.outputStream;
}

async function createBackupZipStreamFromSources(archiveRoot, sources, encryptedDatabase) {
  if (!Buffer.isBuffer(encryptedDatabase) || encryptedDatabase.length > maxDatabaseBytes)
    throw new Error('BACKUP_DATABASE_TOO_LARGE');
  const zip = new yazl.ZipFile();
  for (const item of sources) await addSource(zip, item.source, `${archiveRoot}/${item.archivePath}`);
  zip.addBuffer(encryptedDatabase, `${archiveRoot}/database.json.enc`, { mode: 0o600, compress: true });
  zip.end();
  return zip.outputStream;
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function readEntry(zip, entry, target, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > maxBytes) {
      reject(new Error('BACKUP_ENTRY_TOO_LARGE'));
      return;
    }
    zip.openReadStream(entry, async (error, stream) => {
      if (error) return reject(error);
      try {
        if (target) {
          await pipeline(stream, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          resolve(null);
          return;
        }
        const chunks = [];
        let size = 0;
        stream.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) stream.destroy(new Error('BACKUP_ENTRY_TOO_LARGE'));
          else chunks.push(chunk);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks, size)));
      } catch (streamError) {
        reject(streamError);
      }
    });
  });
}

async function readBackupZip(file, imageStage, themesRoot) {
  const zip = await openZip(file);
  let database = null;
  let entriesSeen = 0;
  let imageBytes = 0;
  let themeStage = null;
  const themeSlugs = new Set(), themePaths = new Set();
  let themeEntryCount = 0, themeBytes = 0;
  if (themesRoot) {
    await fs.promises.mkdir(themesRoot, { recursive: true, mode: 0o750 });
    themeStage = path.join(themesRoot, `.restore-${crypto.randomUUID()}`);
    await fs.promises.mkdir(themeStage, { mode: 0o700 });
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = error => {
      if (finished) return;
      finished = true;
      zip.close();
      if (themeStage) fs.promises.rm(themeStage, { recursive: true, force: true }).catch(() => {});
      reject(error);
    };
    zip.on('error', fail);
    zip.on('end', async () => {
      if (finished) return;
      try {
        if (!database) throw new Error('BACKUP_DATABASE_MISSING');
        if (themeStage) {
          const validThemes = await listThemes(themeStage);
          if (validThemes.length !== themeSlugs.size + 1) throw new Error('BACKUP_THEMES_INVALID');
        }
        finished = true;
        resolve({ database, imageStage, themeStage });
      } catch (error) {
        finished = true;
        zip.close();
        if (themeStage) await fs.promises.rm(themeStage, { recursive: true, force: true }).catch(() => {});
        reject(error);
      }
    });
    zip.on('entry', entry => {
      (async () => {
        entriesSeen += 1;
        if (entriesSeen > maxArchiveEntries) throw new Error('BACKUP_TOO_MANY_ENTRIES');
        const name = entry.fileName;
        if (typeof name !== 'string' || !name || name.length > 512 || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').filter((part, index, parts) => !(index === parts.length - 1 && part === '' && name.endsWith('/'))).some(part => !part || part === '..' || part === '.')) throw new Error('BACKUP_PATH_INVALID');
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) throw new Error('BACKUP_SYMLINK_NOT_ALLOWED');
        if (name.endsWith('/')) {
          zip.readEntry();
          return;
        }
        const parts = name.split('/');
        if (parts[1] === 'application' && parts[2] === 'themes') {
          if (!themeStage || parts.length < 5 || !safeThemeSlug(parts[3])) throw new Error('BACKUP_THEME_PATH_INVALID');
          const relative = parts.slice(4).join('/');
          if (!/^(?:settings\.json|theme\.css|preview\.png|assets\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp|avif|woff2?|ttf|otf))$/.test(relative))
            throw new Error('BACKUP_THEME_PATH_INVALID');
          // Backups created by older versions may contain this folder. Ignore
          // it so an archive cannot replace the application's bundled theme.
          if (parts[3] === DEFAULT_THEME) {
            zip.readEntry();
            return;
          }
          const key = `${parts[3]}/${relative}`.toLowerCase();
          if (themePaths.has(key)) throw new Error('BACKUP_THEME_DUPLICATE');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > 20 * 1024 * 1024)
            throw new Error('BACKUP_THEME_ENTRY_TOO_LARGE');
          themePaths.add(key);
          themeSlugs.add(parts[3]);
          themeEntryCount++;
          themeBytes += entry.uncompressedSize;
          if (themeEntryCount > 300 || themeBytes > 100 * 1024 * 1024) throw new Error('BACKUP_THEMES_TOO_LARGE');
          const destination = path.resolve(themeStage, parts[3], ...parts.slice(4));
          if (!destination.startsWith(themeStage + path.sep)) throw new Error('BACKUP_THEME_PATH_INVALID');
          await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await readEntry(zip, entry, destination, 20 * 1024 * 1024);
          zip.readEntry();
          return;
        }
        if (/(?:^|\/)database\.json\.enc$/.test(name)) {
          if (database) throw new Error('BACKUP_DATABASE_DUPLICATE');
          database = await readEntry(zip, entry, null, maxDatabaseBytes);
        } else {
          const imageMatch = name.match(/(?:^|\/)application\/images\/([A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp))$/i);
          if (imageMatch) {
            const imageName = imageMatch[1];
            const destination = path.join(imageStage, imageName);
            if (!imagePattern.test(imageName) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > maxImageBytes) throw new Error('BACKUP_IMAGE_TOO_LARGE_OR_INVALID');
            imageBytes += entry.uncompressedSize;
            if (imageBytes > maxTotalImageBytes) throw new Error('BACKUP_IMAGES_TOO_LARGE');
            await readEntry(zip, entry, destination, maxImageBytes);
          }
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

module.exports = { createBackupZipStream, createBackupZipStreamFromSources, readBackupZip };
