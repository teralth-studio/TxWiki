'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const { readRegularFileNoFollow } = require('./safe-file');

const ARCHIVE_NAME = 'teralth-default-theme-source.zip';
const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
const ARCHIVE_README = `Teralth Wiki — Default page source

This editable source bundle contains the public page shell and its stylesheet,
plus the Default theme settings and stylesheet. It intentionally excludes
server code, secrets, dependencies, and executable JavaScript.

Files:
- public/index.html: page structure and interface landmarks.
- public/styles.css: page and responsive styles.
- theme/settings.json: settings displayed in the Themes panel.
- theme/theme.css: scoped Default theme stylesheet.

Keep the IDs and data attributes used by the application when editing the HTML.
The panel's installable theme ZIP format remains settings.json + theme.css at
the archive root; this bundle is the editable full-page source reference.
`;

async function readProjectFile(projectRoot, relativePath) {
  const absolutePath = path.resolve(projectRoot, ...relativePath.split('/'));
  const relative = path.relative(projectRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('THEME_SOURCE_PATH_INVALID');
  let current = projectRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('THEME_SOURCE_SYMLINK_NOT_ALLOWED');
  }
  const { content } = await readRegularFileNoFollow(absolutePath);
  if (content.length > MAX_SOURCE_FILE_BYTES) throw new Error('THEME_SOURCE_FILE_TOO_LARGE');
  return content;
}

async function writeThemeSourceArchive(projectRoot = path.resolve(__dirname, '..'), destination) {
  const root = await fs.promises.realpath(projectRoot);
  const themesDirectory = path.join(root, 'themes');
  await fs.promises.mkdir(themesDirectory, { recursive: true, mode: 0o750 });
  const target = destination || path.join(themesDirectory, ARCHIVE_NAME);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(themesDirectory + path.sep)) throw new Error('THEME_SOURCE_PATH_INVALID');
  const archive = new yazl.ZipFile();
  const sources = [
    ['public/index.html', 'public/index.html'],
    ['public/styles.css', 'public/styles.css'],
    ['scripts/default-theme/settings.json', 'theme/settings.json'],
    ['scripts/default-theme/theme.css', 'theme/theme.css'],
  ];
  try {
    for (const [source, archivePath] of sources)
      archive.addBuffer(await readProjectFile(root, source), archivePath, { mode: 0o600, compress: true });
    archive.addBuffer(Buffer.from(ARCHIVE_README, 'utf8'), 'README.txt', { mode: 0o600, compress: true });
    archive.end();
    const temporary = `${resolvedTarget}.partial-${crypto.randomUUID()}`;
    try {
      await pipeline(archive.outputStream, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await fs.promises.rename(temporary, resolvedTarget);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return resolvedTarget;
  } catch (error) {
    archive.end();
    throw error;
  }
}

async function ensureThemeSourceArchive(themesDirectory) {
  const root = await fs.promises.realpath(themesDirectory);
  const target = path.join(root, ARCHIVE_NAME);
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isFile() && !stat.isSymbolicLink()) return target;
    throw new Error('THEME_SOURCE_ARCHIVE_INVALID');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return writeThemeSourceArchive(path.resolve(__dirname, '..'), target);
}

module.exports = { ARCHIVE_NAME, ensureThemeSourceArchive, writeThemeSourceArchive };

if (require.main === module) {
  writeThemeSourceArchive()
    .then((archivePath) => console.log(`Editable theme source created: ${path.relative(process.cwd(), archivePath)}`))
    .catch((error) => {
      console.error('Editable theme source creation failed:', error.code || 'THEME_SOURCE_BUILD_FAILED');
      process.exitCode = 1;
    });
}
