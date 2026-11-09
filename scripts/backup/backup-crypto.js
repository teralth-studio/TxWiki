const crypto = require('node:crypto');
const fs = require('node:fs');
const { PassThrough, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAGIC = Buffer.from('TWBK1');
const ARCHIVE_MAGIC = Buffer.from('TWBA1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(secret, purpose) {
  const value = String(secret || '');
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 32 bytes.');
  }
  return crypto.createHash('sha256')
    .update(`teralth-backup-${purpose}:v1\0`)
    .update(value, 'utf8')
    .digest();
}

function encryptBackupDatabase(serialized, secret) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret, 'database'), iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(String(serialized), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function decryptBackupDatabase(payload, secret) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const minimumLength = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (data.length < minimumLength || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('BACKUP_FORMAT_INVALID');
  }
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const encryptedStart = tagStart + TAG_BYTES;
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret, 'database'), data.subarray(ivStart, tagStart));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(data.subarray(tagStart, encryptedStart));
  return Buffer.concat([decipher.update(data.subarray(encryptedStart)), decipher.final()]).toString('utf8');
}

function createBackupArchiveEncryptor(secret) {
  const iv = crypto.randomBytes(IV_BYTES);
  const header = Buffer.concat([ARCHIVE_MAGIC, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret, 'archive'), iv);
  cipher.setAAD(ARCHIVE_MAGIC);
  let headerWritten = false;

  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        if (!headerWritten) {
          this.push(header);
          headerWritten = true;
        }
        this.push(cipher.update(chunk));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        if (!headerWritten) this.push(header);
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

async function encryptBackupArchive(source, target, secret) {
  try {
    await pipeline(
      source,
      createBackupArchiveEncryptor(secret),
      fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    await fs.promises.rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

async function decryptBackupArchive(file, secret) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY);
  let streamOwnsHandle = false;
  try {
    const { size } = await handle.stat();
    const headerLength = ARCHIVE_MAGIC.length + IV_BYTES;
    const tagStart = size - TAG_BYTES;
    if (size <= headerLength + TAG_BYTES) throw new Error('BACKUP_ARCHIVE_FORMAT_INVALID');

    const header = Buffer.alloc(headerLength);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length || !header.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC))
      throw new Error('BACKUP_ARCHIVE_FORMAT_INVALID');
    const tag = Buffer.alloc(TAG_BYTES);
    const tagRead = await handle.read(tag, 0, tag.length, tagStart);
    if (tagRead.bytesRead !== tag.length) throw new Error('BACKUP_ARCHIVE_FORMAT_INVALID');

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret, 'archive'),
      header.subarray(ARCHIVE_MAGIC.length),
    );
    decipher.setAAD(ARCHIVE_MAGIC);
    decipher.setAuthTag(tag);
    const source = handle.createReadStream({
      start: headerLength,
      end: tagStart - 1,
      autoClose: true,
    });
    const output = new PassThrough();
    streamOwnsHandle = true;
    pipeline(source, decipher, output).catch((error) => output.destroy(error));
    return output;
  } finally {
    if (!streamOwnsHandle) await handle.close();
  }
}

module.exports = {
  decryptBackupArchive,
  decryptBackupDatabase,
  encryptBackupArchive,
  encryptBackupDatabase,
};
