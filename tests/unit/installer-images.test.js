const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const sharp = require('sharp');
const { MAX_IMAGE_BYTES, saveInstallerImages } = require('../../scripts/installer-images');

test('installer images are validated, converted and saved with public media names', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'teralth-setup-test-'));
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#ff0044' } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString('base64')}`;
  let saved = [];
  try {
    const result = await saveInstallerImages({ logo: image, favicon: image }, directory);
    saved = result.saved;
    for (const kind of ['logo', 'favicon']) {
      assert.match(result.result[kind], /^\/media\/[A-Za-z0-9_-]{16}\.webp$/);
      const file = path.join(directory, 'uploads', path.basename(result.result[kind]));
      assert.equal((await sharp(await fs.readFile(file)).metadata()).format, 'webp');
    }
    await assert.rejects(saveInstallerImages({ logo: image, favicon: 'data:image/png;base64,aA==' }, directory),
      error => error.code === 'SETUP_IMAGE_INVALID');
    assert.equal((await fs.readdir(path.join(directory, 'uploads'))).length, 2);
    await assert.rejects(saveInstallerImages({ logo: `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4)}` }, directory),
      error => error.code === 'SETUP_IMAGE_INVALID');
    await assert.rejects(saveInstallerImages({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, directory),
      error => error.code === 'SETUP_IMAGE_INVALID');
  } finally {
    for (const file of saved) await fs.unlink(file);
    await fs.rmdir(path.join(directory, 'uploads'));
    await fs.rmdir(directory);
  }
});
