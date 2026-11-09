const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const {
  decryptBackupArchive,
  encryptBackupArchive,
} = require('../../scripts/backup-crypto');

const secret = 'backup-test-secret-with-at-least-32-bytes';

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('backup archives are encrypted at rest and decrypt as authenticated streams', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'txwiki-backup-crypto-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'backup.enc');
  const plaintext = Buffer.from('backup files and user media');

  await encryptBackupArchive(Readable.from([plaintext]), archivePath, secret);
  const stored = await fs.promises.readFile(archivePath);
  assert.equal(stored.subarray(0, 5).toString(), 'TWBA1');
  assert.equal(stored.includes(plaintext), false);
  assert.deepEqual(await collect(await decryptBackupArchive(archivePath, secret)), plaintext);
});

test('backup archive decryption rejects an incorrect key and altered ciphertext', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'txwiki-backup-crypto-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'backup.enc');
  await encryptBackupArchive(Readable.from([Buffer.from('backup payload')]), archivePath, secret);

  await assert.rejects(
    collect(await decryptBackupArchive(archivePath, 'incorrect-key-with-at-least-32-bytes')),
  );
  const altered = await fs.promises.readFile(archivePath);
  altered[altered.length - 1] ^= 1;
  await fs.promises.writeFile(archivePath, altered);
  await assert.rejects(collect(await decryptBackupArchive(archivePath, secret)));
});

test('backup archive decryption rejects malformed headers', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'txwiki-backup-crypto-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'backup.enc');
  await fs.promises.writeFile(archivePath, Buffer.alloc(40));
  await assert.rejects(decryptBackupArchive(archivePath, secret), /BACKUP_ARCHIVE_FORMAT_INVALID/);
});
