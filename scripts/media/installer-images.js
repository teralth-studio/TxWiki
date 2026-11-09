const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const allowedFormats = new Set(['png', 'jpeg', 'gif', 'webp']);

async function saveInstallerImages(images, dataDir) {
  const saved = [];
  const result = {};
  try {
    for (const kind of ['logo', 'favicon']) {
      const value = images[kind];
      if (!value) continue;
      const match = typeof value === 'string' &&
        /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
      if (!match || match[1].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
        throw Object.assign(new Error('Invalid image or image exceeds 2 MB.'), { code: 'SETUP_IMAGE_INVALID' });
      const input = Buffer.from(match[1], 'base64');
      if (!input.length || input.length > MAX_IMAGE_BYTES || input.toString('base64') !== match[1])
        throw Object.assign(new Error('Invalid image or image exceeds 2 MB.'), { code: 'SETUP_IMAGE_INVALID' });
      let output;
      try {
        const image = sharp(input, { animated: true, limitInputPixels: 16_000_000 });
        const metadata = await image.metadata();
        if (!allowedFormats.has(metadata.format)) throw new Error('Unsupported image format');
        output = await image.rotate().resize({
          width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true,
        }).webp({ quality: 85 }).toBuffer();
      } catch {
        throw Object.assign(new Error('Invalid or unsupported image.'), { code: 'SETUP_IMAGE_INVALID' });
      }
      const directory = path.resolve(dataDir, 'uploads');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = `${crypto.randomBytes(12).toString('base64url')}.webp`;
      const file = path.join(directory, filename);
      await fs.writeFile(file, output, { flag: 'wx', mode: 0o600 });
      saved.push(file);
      result[kind] = `/media/${filename}`;
    }
    return { result, saved };
  } catch (error) {
    for (const file of saved) await fs.unlink(file).catch((cleanupError) => {
      console.error('[Teralth Wiki] Installer image cleanup failed:', cleanupError.code || cleanupError.name);
    });
    throw error;
  }
}

module.exports = { MAX_IMAGE_BYTES, saveInstallerImages };
