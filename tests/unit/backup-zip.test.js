const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const yauzl = require('yauzl');
const {
  decryptBackupArchive,
  encryptBackupArchive,
} = require('../../scripts/backup-crypto');
const {
  createBackupZipStream,
  createBackupZipStreamFromSources,
} = require('../../scripts/backup/backup-zip');
const secret = 'backup-zip-test-secret-with-at-least-32-bytes';

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function listZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        entries.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

test('backup archives include selected source files and the encrypted database', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'txwiki-backup-zip-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const legacyDefault = path.join(directory, 'themes', 'default');
  const customTheme = path.join(directory, 'themes', 'custom');
  await fs.promises.mkdir(legacyDefault, { recursive: true });
  await fs.promises.mkdir(customTheme, { recursive: true });
  await fs.promises.writeFile(path.join(legacyDefault, 'settings.json'), '{}');
  await fs.promises.writeFile(path.join(legacyDefault, 'theme.css'), 'body { color: black; }');
  await fs.promises.writeFile(path.join(customTheme, 'settings.json'), '{}');
  await fs.promises.writeFile(path.join(customTheme, 'theme.css'), 'body { color: black; }');

  const stream = await createBackupZipStreamFromSources(
    'fixture',
    [{ source: path.join(directory, 'themes'), archivePath: 'application/themes' }],
    Buffer.from('encrypted-database'),
  );
  const encryptedPath = path.join(directory, 'fixture.enc');
  await encryptBackupArchive(stream, encryptedPath, secret);
  const entries = await listZipEntries(await collect(await decryptBackupArchive(encryptedPath, secret)));

  assert.deepEqual(entries.sort(), [
    'fixture/application/themes/custom/settings.json',
    'fixture/application/themes/custom/theme.css',
    'fixture/database.json.enc',
  ]);
});

test('legacy backup migration skips the bundled Default theme under an archive prefix', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'txwiki-legacy-backup-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const themeRoot = path.join(directory, 'application', 'themes');
  for (const slug of ['default', 'custom']) {
    const themeDirectory = path.join(themeRoot, slug);
    await fs.promises.mkdir(themeDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(themeDirectory, 'settings.json'), '{}');
    await fs.promises.writeFile(path.join(themeDirectory, 'theme.css'), 'body { color: black; }');
  }

  const stream = await createBackupZipStream(directory, 'legacy-backup');
  const entries = await listZipEntries(await collect(stream));

  assert.deepEqual(entries.sort(), [
    'legacy-backup/application/themes/custom/settings.json',
    'legacy-backup/application/themes/custom/theme.css',
  ]);
});
