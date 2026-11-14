'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const { readRegularFileNoFollow } = require('./safe-file');

const ARCHIVE_NAME = 'default.zip';
const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
const ARCHIVE_README = `Teralth Wiki — Default page source

This editable Default theme template contains its settings and stylesheet at the
archive root, plus copies of the public page shell and stylesheet under source/.
It intentionally excludes
server code, secrets, dependencies, and executable JavaScript.

Files:
- settings.json: theme identity and settings displayed in the Themes panel.
- theme.css: scoped stylesheet used by the theme.
- source/public/index.html: public page shell reference for theme authors.
- source/public/styles.css: full public stylesheet reference for theme authors.

Edit settings.json and theme.css, give the theme a name other than Default, and
upload this ZIP in the Themes panel. The source/public files are retained as editable reference files;
the application continues to render its own public shell and does not execute
or serve uploaded HTML. Do not add scripts, secrets, or external asset URLs.
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
  const outputDirectory = destination
    ? path.resolve(path.dirname(destination))
    : path.join(root, 'themes');
  await fs.promises.mkdir(outputDirectory, { recursive: true, mode: 0o750 });
  const themesStat = await fs.promises.lstat(outputDirectory);
  if (themesStat.isSymbolicLink() || !themesStat.isDirectory()) throw new Error('THEME_SOURCE_ROOT_INVALID');
  const realOutputDirectory = await fs.promises.realpath(outputDirectory);
  if (destination && path.basename(path.resolve(destination)) !== ARCHIVE_NAME)
    throw new Error('THEME_SOURCE_PATH_INVALID');
  const resolvedTarget = path.join(realOutputDirectory, ARCHIVE_NAME);
  const archive = new yazl.ZipFile();
  const sources = [
    ['scripts/default-theme/settings.json', 'settings.json'],
    ['scripts/default-theme/theme.css', 'theme.css'],
    ['public/index.html', 'source/public/index.html'],
    ['public/styles.css', 'source/public/styles.css'],
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
  const rootStat = await fs.promises.lstat(themesDirectory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('THEME_SOURCE_ROOT_INVALID');
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
