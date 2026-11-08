const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');

const maxArchiveEntries = 10_000;
const maxDatabaseBytes = 100 * 1024 * 1024;
const maxImageBytes = 25 * 1024 * 1024;
const maxTotalImageBytes = 500 * 1024 * 1024;
const imagePattern = /^[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/i;

async function addTree(zip, directory, archiveRoot) {
  const realRoot = await fs.promises.realpath(directory);
  async function visit(folder) {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'setup.key' || /^\.env(?:\..*)?$/.test(entry.name)) continue;
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('BACKUP_SYMLINK_NOT_ALLOWED');
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error('BACKUP_FILE_TYPE_NOT_ALLOWED');
      const resolved = await fs.promises.realpath(absolute);
      if (!resolved.startsWith(realRoot + path.sep)) throw new Error('BACKUP_PATH_INVALID');
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('BACKUP_PATH_INVALID');
      zip.addFile(absolute, `${archiveRoot}/${relative}`, { mode: 0o600, compress: true });
    }
  }
  await visit(directory);
}

async function createBackupZipStream(directory, archiveRoot) {
  const zip = new yazl.ZipFile();
  await addTree(zip, directory, archiveRoot);
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

async function readBackupZip(file, imageStage) {
  const zip = await openZip(file);
  let database = null;
  let entriesSeen = 0;
  let imageBytes = 0;
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = error => {
      if (finished) return;
      finished = true;
      zip.close();
      reject(error);
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (finished) return;
      finished = true;
      if (!database) return reject(new Error('BACKUP_DATABASE_MISSING'));
      resolve({ database, imageStage });
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

module.exports = { createBackupZipStream, readBackupZip };
