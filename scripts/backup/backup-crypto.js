const crypto = require('node:crypto');

const MAGIC = Buffer.from('TWBK1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(secret) {
  const value = String(secret || '');
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 32 bytes.');
  }
  return crypto.createHash('sha256')
    .update('teralth-backup-database:v1\0')
    .update(value, 'utf8')
    .digest();
}

function encryptBackupDatabase(serialized, secret) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
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
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), data.subarray(ivStart, tagStart));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(data.subarray(tagStart, encryptedStart));
  return Buffer.concat([decipher.update(data.subarray(encryptedStart)), decipher.final()]).toString('utf8');
}

module.exports = { encryptBackupDatabase, decryptBackupDatabase };
