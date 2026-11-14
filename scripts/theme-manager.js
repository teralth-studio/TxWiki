'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const postcss = require('postcss');
const lightningcss = require('lightningcss');
const sharp = require('sharp');
const { ensureThemeSourceArchive } = require('./theme-source-package');

const DEFAULT_THEME = 'default';
const DEFAULT_THEME_ROOT = path.join(__dirname, 'default-theme');
const DEFAULT_THEME_FILES = new Map([
  [
    'settings.json',
    `${JSON.stringify({
      name: 'Default',
      version: '1.0.0',
      author: 'Teralth Wiki',
      support: '',
      settings: [
        { name: 'Primary Color', type: 'color', default: '#91a8ff' },
        { name: 'Secondary Color', type: 'color', default: '#7188e8' },
      ],
    }, null, 2)}\n`,
  ],
  [
    'theme.css',
    `body {
  --accent: color-mix(in srgb, var(--theme-setting-primary-color, #91a8ff) 82%, #ffffff);
  --accent-strong: color-mix(in srgb, var(--theme-setting-secondary-color, #7188e8) 82%, #ffffff);
}

body.light {
  --accent: color-mix(in srgb, var(--theme-setting-primary-color, #91a8ff) 76%, #20232a);
  --accent-strong: color-mix(in srgb, var(--theme-setting-secondary-color, #7188e8) 76%, #20232a);
}
`,
  ],
]);
let defaultThemeFilesPromise;
const loggedDefaultFallbacks = new Set();
const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 300;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_CSS_BYTES = 1024 * 1024;
const THEME_TYPES = new Set([
  'color',
  'number',
  'text',
  'large-text',
  'switch',
  'dropdown',
  'multiple-dropdown',
]);
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf',
]);
const IMAGE_FORMATS = new Map([
  ['.png', 'png'], ['.jpg', 'jpeg'], ['.jpeg', 'jpeg'], ['.gif', 'gif'],
  ['.webp', 'webp'], ['.avif', 'avif'],
]);
const FONT_SIGNATURES = new Map([
  ['.woff', ['wOFF']], ['.woff2', ['wOF2']], ['.ttf', ['\x00\x01\x00\x00', 'true']],
  ['.otf', ['OTTO']],
]);

class ThemeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ThemeError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status = 400) => {
  throw new ThemeError(code, message, status);
};

function safeThemeSlug(value) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9_-]{0,47})$/.test(value);
}

function makeThemeSlug(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return safeThemeSlug(slug) ? slug : 'theme';
}

function settingKey(setting, index) {
  const explicit = typeof setting.key === 'string' ? setting.key.toLowerCase() : '';
  if (explicit && /^[a-z][a-z0-9-]{0,47}$/.test(explicit)) return explicit;
  const generated = String(setting.name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return generated || `setting-${index + 1}`;
}

function isSafeSupport(value) {
  if (typeof value !== 'string' || !value.trim()) return value === '';
  const text = value.trim();
  if (/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(text)) return true;
  if (/^mailto:/i.test(text))
    return /^mailto:[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?:\?.*)?$/i.test(text) &&
      !/[\r\n]/.test(text);
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      !/[\r\n]/.test(text) && text.length <= 500;
  } catch {
    return false;
  }
}

function normalizeThemeDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('THEME_SETTINGS_INVALID', 'The theme settings.json file is invalid.');
  const allowedKeys = new Set(['name', 'version', 'author', 'support', 'settings']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    fail('THEME_SETTINGS_INVALID', 'The theme settings.json file contains unsupported fields.');
  for (const key of ['name', 'version', 'author']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].trim().length > (key === 'version' ? 32 : 80))
      fail('THEME_SETTINGS_INVALID', `The theme ${key} field is missing or too long.`);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(value.version.trim()))
    fail('THEME_SETTINGS_INVALID', 'The theme version contains unsupported characters.');
  const support = value.support === undefined ? '' : value.support;
  if (typeof support !== 'string' || support.length > 500 || !isSafeSupport(support))
    fail('THEME_SUPPORT_INVALID', 'The theme support link must be an HTTPS URL or a valid email link.');
  if (!Array.isArray(value.settings) || value.settings.length > 100)
    fail('THEME_SETTINGS_INVALID', 'The theme settings list is invalid or too large.');

  const keys = new Set();
  const settings = value.settings.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 100 ||
        !/^[A-Za-z][A-Za-z0-9 _().-]*$/.test(entry.name.trim()) ||
        Object.keys(entry).some((key) => !['key', 'name', 'type', 'default', 'options'].includes(key)) ||
        !THEME_TYPES.has(entry.type))
      fail('THEME_SETTING_INVALID', 'A theme setting has an invalid name or type.');
    const key = settingKey(entry, index);
    if (keys.has(key)) fail('THEME_SETTING_DUPLICATE', 'Theme setting names must be unique.');
    keys.add(key);
    const options = entry.options === undefined
      ? []
      : typeof entry.options === 'string'
        ? entry.options.split(';').map((option) => option.trim())
        : entry.options;
    if (!Array.isArray(options) || options.length > 100 || options.some((option) =>
      typeof option !== 'string' || !option.trim() || option.length > 120 || !/^[\p{L}\p{N}_\s#.,%+-]+$/u.test(option)))
      fail('THEME_SETTING_OPTIONS_INVALID', 'Theme dropdown options must be a list of short text values.');
    if (['dropdown', 'multiple-dropdown'].includes(entry.type) && options.length < 2)
      fail('THEME_SETTING_OPTIONS_INVALID', 'Theme dropdown settings need at least two options.');
    if (!['dropdown', 'multiple-dropdown'].includes(entry.type) && options.length)
      fail('THEME_SETTING_OPTIONS_INVALID', 'Only dropdown settings may define options.');
    const setting = { key, name: entry.name.trim(), type: entry.type, default: entry.default, options };
    setting.default = validateSettingValue(setting, setting.default);
    return setting;
  });
  return {
    name: value.name.trim(),
    version: value.version.trim(),
    author: value.author.trim(),
    support: support.trim(),
    settings,
  };
}

function validateSettingValue(setting, value) {
  const bad = () => fail('THEME_SETTING_VALUE_INVALID', `The value for “${setting.name}” is invalid.`);
  if (setting.type === 'color') {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) bad();
    return value.toLowerCase();
  }
  if (setting.type === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > 100000) bad();
    return number;
  }
  if (setting.type === 'switch') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    bad();
  }
  if (setting.type === 'dropdown') {
    if (typeof value !== 'string' || !setting.options.includes(value)) bad();
    return value;
  }
  if (setting.type === 'multiple-dropdown') {
    const values = Array.isArray(value)
      ? value
      : typeof value === 'string' ? value.split(';').map((part) => part.trim()).filter(Boolean) : null;
    if (!values || values.length > setting.options.length ||
        values.some((item) => typeof item !== 'string' || !setting.options.includes(item)) ||
        new Set(values).size !== values.length) bad();
    return values;
  }
  const limit = setting.type === 'large-text' ? 4000 : 240;
  if (typeof value !== 'string' || value.length > limit || /\0/.test(value)) bad();
  return value;
}

function normalizeValues(definition, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    fail('THEME_VALUES_INVALID', 'Theme preferences must be an object.');
  const allowed = new Set(definition.settings.map((setting) => setting.key));
  if (Object.keys(values).some((key) => !allowed.has(key)))
    fail('THEME_VALUES_INVALID', 'Theme preferences contain unknown settings.');
  return Object.fromEntries(definition.settings.map((setting) => [
    setting.key,
    validateSettingValue(setting, Object.hasOwn(values, setting.key) ? values[setting.key] : setting.default),
  ]));
}

function urlAssetsAndRejectUnsafe(decl, slug) {
  const value = decl.value;
  if (/(?:expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|-moz-binding|behavior\s*:|https?:\/\/|image-set\s*\(|-webkit-image-set\s*\()/i.test(value))
    fail('THEME_CSS_UNSAFE', 'The theme stylesheet contains a disallowed CSS value.');
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, quote, raw) => {
    const target = String(raw || '').trim();
    if (!target || target.startsWith('/') || target.startsWith('.') && !target.startsWith('./') ||
        /^(?:[a-z]+:|\/\/)/i.test(target) || /[\\?#%\0\r\n]/.test(target))
      fail('THEME_CSS_EXTERNAL_ASSET', 'Theme CSS may only reference files inside its own assets folder.');
    const normalized = target.startsWith('./') ? target.slice(2) : target;
    const parts = normalized.split('/');
    if (parts.length < 2 || parts[0] !== 'assets' || parts.some((part) =>
      !part || part === '.' || part === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(part)))
      fail('THEME_CSS_EXTERNAL_ASSET', 'Theme CSS may only reference files inside its own assets folder.');
    const extension = path.extname(normalized).toLowerCase();
    if (!ASSET_EXTENSIONS.has(extension))
      fail('THEME_CSS_ASSET_TYPE', 'Theme CSS may only use image and font assets.');
    const safePath = `/theme-assets/${slug}/${normalized}`;
    return `url("${safePath}")`;
  });
}

function scopeThemeCss(source, slug) {
  if (!safeThemeSlug(slug) || typeof source !== 'string' || Buffer.byteLength(source) > MAX_CSS_BYTES)
    fail('THEME_CSS_INVALID', 'The theme stylesheet is missing or exceeds its size limit.');
  let canonicalCss, root;
  try {
    canonicalCss = lightningcss.transform({ filename: 'theme.css', code: Buffer.from(source), minify: false }).code.toString();
    root = postcss.parse(canonicalCss, { from: 'theme.css' });
  } catch {
    fail('THEME_CSS_INVALID', 'The theme stylesheet could not be parsed.');
  }
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (['import', 'namespace', 'document', 'page', 'charset', 'counter-style'].includes(name))
      fail('THEME_CSS_AT_RULE', `The @${name} CSS rule is not allowed in themes.`);
    if (!['media', 'supports', 'container', 'layer', 'font-face', 'keyframes', '-webkit-keyframes'].includes(name))
      fail('THEME_CSS_AT_RULE', `The @${name} CSS rule is not supported in themes.`);
  });
  root.walkDecls((decl) => { decl.value = urlAssetsAndRejectUnsafe(decl, slug); });
  root.walkRules((rule) => {
    let inKeyframes = false;
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) { inKeyframes = true; break; }
    }
    if (inKeyframes) return;
    const selectors = postcss.list.comma(rule.selector).map((entry) => {
      const selector = entry.trim();
      if (!selector) fail('THEME_CSS_SELECTOR_INVALID', 'The theme contains an empty selector.');
      if (/:root\b/.test(selector)) return selector.replace(/:root\b/g, 'body.theme-mode');
      if (/^(?:html|body)(?=$|[\s.#:[>+~])/i.test(selector))
        return selector.replace(/^(?:html|body)\b/i, 'body.theme-mode');
      return `body.theme-mode ${selector}`;
    });
    rule.selector = selectors.join(', ');
  });
  try {
    const compiled = lightningcss.transform({ filename: 'theme.css', code: Buffer.from(root.toString()), minify: true });
    return compiled.code.toString();
  } catch {
    fail('THEME_CSS_INVALID', 'The theme stylesheet could not be compiled.');
  }
}

function safeArchiveName(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name.includes('\\') || name.includes('\0') ||
      name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\r\n]/.test(name)) return false;
  const directory = name.endsWith('/');
  const parts = name.split('/');
  if (directory) parts.pop();
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(part) || part === '.' || part === '..' || /[. ]$/.test(part))) return false;
  if (parts.some((part) => part.startsWith('.'))) return false;
  const file = parts.at(-1).toLowerCase();
  if (directory)
    return parts[0] === 'assets' ||
      (parts[0] === 'source' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'public')));
  return (parts.length === 1 && ['settings.json', 'theme.css', 'preview.png'].includes(file)) ||
    (parts.length === 1 && file === 'readme.txt') ||
    (parts.length >= 2 && parts[0] === 'assets' && ASSET_EXTENSIONS.has(path.extname(file))) ||
    (parts.length === 3 && parts[0] === 'source' && parts[1] === 'public' &&
      ['index.html', 'styles.css'].includes(parts[2].toLowerCase()));
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => error ? reject(error) : resolve(zip));
  });
}

async function findDirectoryEntry(directory, name) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) return null;
  return { entry, path: path.join(directory, entry.name) };
}

async function findFileEntry(directory, name) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry || entry.isSymbolicLink() || !entry.isFile()) return null;
  return { entry, path: path.join(directory, entry.name) };
}

async function readRegularFile(file, maxBytes = MAX_ENTRY_BYTES) {
  let handle;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      fail('THEME_FILE_TYPE_INVALID', 'A theme contains an unsupported file type.');
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}

async function resolveThemeFile(directory, segments) {
  let current = directory;
  for (let index = 0; index < segments.length; index++) {
    const final = index === segments.length - 1;
    const found = final
      ? await findFileEntry(current, segments[index])
      : await findDirectoryEntry(current, segments[index]);
    if (!found) return null;
    current = found.path;
  }
  return current;
}

function extractEntry(zip, entry, target) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_ENTRY_BYTES || size > entry.uncompressedSize)
          stream.destroy(new ThemeError('THEME_ENTRY_SIZE_INVALID', 'A theme file exceeds its allowed size.'));
      });
      stream.on('error', reject);
      const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
      output.on('error', reject);
      output.on('finish', () => size === entry.uncompressedSize
        ? resolve()
        : reject(new ThemeError('THEME_ENTRY_SIZE_INVALID', 'A theme file has an invalid expanded size.')));
      stream.pipe(output);
    });
  });
}

async function verifyImageAsset(buffer, expectedFormat) {
  try {
    const metadata = await sharp(buffer, { limitInputPixels: 16_000_000 }).metadata();
    const actual = metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format;
    if (actual !== expectedFormat || !metadata.width || !metadata.height || metadata.width > 5000 || metadata.height > 5000)
      fail('THEME_IMAGE_INVALID', 'A theme image does not match its extension or exceeds the dimension limit.');
  } catch (error) {
    if (error instanceof ThemeError) throw error;
    fail('THEME_IMAGE_INVALID', 'A theme image file is invalid.');
  }
}

async function validateThemeFiles(directory, slug) {
  const settingsFile = await resolveThemeFile(directory, ['settings.json']);
  if (!settingsFile) fail('THEME_SETTINGS_MISSING', 'The ZIP must contain settings.json in its root.');
  let settingsBuffer;
  try { settingsBuffer = await readRegularFile(settingsFile, MAX_SETTINGS_BYTES); }
  catch (error) {
    if (error.code === 'ENOENT') fail('THEME_SETTINGS_MISSING', 'The ZIP must contain settings.json in its root.');
    throw error;
  }
  if (settingsBuffer.length > MAX_SETTINGS_BYTES)
    fail('THEME_SETTINGS_TOO_LARGE', 'The theme settings.json file exceeds its size limit.');
  let parsed;
  try { parsed = JSON.parse(settingsBuffer.toString('utf8')); }
  catch { fail('THEME_SETTINGS_INVALID', 'The theme settings.json file is not valid JSON.'); }
  const definition = normalizeThemeDefinition(parsed);
  const cssPath = await resolveThemeFile(directory, ['theme.css']);
  if (!cssPath) fail('THEME_STYLESHEET_MISSING', 'The ZIP must contain theme.css in its root.');
  let css;
  try { css = (await readRegularFile(cssPath, MAX_CSS_BYTES)).toString('utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') fail('THEME_STYLESHEET_MISSING', 'The ZIP must contain theme.css in its root.');
    throw error;
  }
  const stylesheet = scopeThemeCss(css, slug);
  const previewPath = await resolveThemeFile(directory, ['preview.png']);
  if (previewPath) {
    const preview = await readRegularFile(previewPath, 10 * 1024 * 1024);
    if (preview.length > 10 * 1024 * 1024 || preview.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      fail('THEME_PREVIEW_INVALID', 'The preview.png file must be a valid PNG under 10 MB.');
    await verifyImageAsset(preview, 'png');
  }
  const assetsRoot = await findDirectoryEntry(directory, 'assets');
  async function verifyAssets(folder) {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('THEME_SYMLINK_NOT_ALLOWED', 'Theme packages cannot contain symbolic links.');
      if (entry.isDirectory()) {
        const child = await findDirectoryEntry(folder, entry.name);
        if (!child) fail('THEME_SYMLINK_NOT_ALLOWED', 'Theme packages cannot contain symbolic links.');
        await verifyAssets(child.path);
        continue;
      }
      if (!entry.isFile()) fail('THEME_FILE_TYPE_INVALID', 'A theme contains an unsupported file type.');
      const file = await findFileEntry(folder, entry.name);
      if (!file) fail('THEME_SYMLINK_NOT_ALLOWED', 'Theme packages cannot contain symbolic links.');
      const buffer = await readRegularFile(file.path);
      const extension = path.extname(entry.name).toLowerCase();
      if (IMAGE_FORMATS.has(extension)) await verifyImageAsset(buffer, IMAGE_FORMATS.get(extension));
      else {
        const signatures = FONT_SIGNATURES.get(extension);
        if (!signatures || !signatures.some((item) => buffer.subarray(0, 4).toString('binary') === item))
          fail('THEME_FONT_INVALID', 'A theme font file has an invalid signature.');
      }
    }
  }
  if (assetsRoot) await verifyAssets(assetsRoot.path);
  const assetReferences = [...stylesheet.matchAll(new RegExp(`url\\(["']?\\/theme-assets\\/${slug}\\/(assets\\/[A-Za-z0-9._/-]+)["']?\\)`, 'g'))];
  for (const [, relative] of assetReferences) {
    const segments = relative.split('/');
    if (segments.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(part) || part === '.' || part === '..'))
      fail('THEME_CSS_ASSET_INVALID', 'The stylesheet references an unsafe theme asset path.');
    const asset = await resolveThemeFile(directory, segments);
    if (!asset) fail('THEME_CSS_ASSET_MISSING', 'The stylesheet references an asset that is missing from the theme ZIP.');
  }
  return { definition, stylesheet };
}

async function ensureDefaultThemeFiles() {
  if (!defaultThemeFilesPromise) {
    defaultThemeFilesPromise = (async () => {
      const parent = await fs.promises.realpath(path.dirname(DEFAULT_THEME_ROOT));
      let directory = await findDirectoryEntry(parent, path.basename(DEFAULT_THEME_ROOT));
      if (!directory) {
        await fs.promises.mkdir(DEFAULT_THEME_ROOT, { mode: 0o750 });
        directory = await findDirectoryEntry(parent, path.basename(DEFAULT_THEME_ROOT));
      }
      if (!directory) fail('THEME_DEFAULT_MISSING', 'The built-in Default theme folder is missing.', 500);
      for (const [name, content] of DEFAULT_THEME_FILES) {
        if (await findFileEntry(directory.path, name)) continue;
        const target = path.join(directory.path, name);
        let handle;
        try {
          handle = await fs.promises.open(
            target,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
            0o640,
          );
          await handle.writeFile(content);
          await handle.sync();
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        } finally {
          await handle?.close();
        }
      }
      return directory;
    })();
  }
  return defaultThemeFilesPromise;
}

function bundledDefaultTheme() {
  const definition = normalizeThemeDefinition(JSON.parse(DEFAULT_THEME_FILES.get('settings.json')));
  return {
    directory: null,
    definition,
    stylesheet: scopeThemeCss(DEFAULT_THEME_FILES.get('theme.css'), DEFAULT_THEME),
  };
}

async function resolveDefaultThemeSource(themesRoot) {
  try {
    const internalTheme = await ensureDefaultThemeFiles();
    const validated = await validateThemeFiles(internalTheme.path, DEFAULT_THEME);
    try { await ensureThemeSourceArchive(themesRoot); }
    catch (error) {
      const code = error instanceof ThemeError ? error.code : 'THEME_SOURCE_ARCHIVE_FAILED';
      console.error('[Teralth Wiki] Could not ensure the Default theme template ZIP.', code);
    }
    return { directory: internalTheme.path, ...validated };
  } catch (error) {
    logDefaultFallback(error);
  }

  return bundledDefaultTheme();
}

function logDefaultFallback(error) {
  const code = error instanceof ThemeError ? error.code : 'THEME_DEFAULT_INVALID';
  if (loggedDefaultFallbacks.has(code)) return;
  loggedDefaultFallbacks.add(code);
  console.error('[Teralth Wiki] Project Default theme unavailable; using bundled fallback.', code);
}

async function installThemeZip(buffer, themesRoot) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ZIP_BYTES)
    fail('THEME_ZIP_SIZE_INVALID', 'The theme ZIP must be between 22 bytes and 25 MB.');
  await fs.promises.mkdir(themesRoot, { recursive: true, mode: 0o750 });
  const rootStat = await fs.promises.lstat(themesRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    fail('THEME_ROOT_INVALID', 'The themes folder is not a safe directory.', 500);
  const staging = path.join(themesRoot, `.install-${require('node:crypto').randomUUID()}`);
  await fs.promises.mkdir(staging, { mode: 0o700 });
  let zip;
  try {
    zip = await openZip(buffer);
    await new Promise((resolve, reject) => {
      let count = 0, total = 0, finished = false;
      const seenPaths = new Set();
      const failZip = (error) => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error);
      };
      zip.on('error', failZip);
      zip.on('end', () => { if (!finished) { finished = true; resolve(); } });
      zip.on('entry', (entry) => {
        (async () => {
          count++;
          if (count > MAX_ENTRIES) fail('THEME_TOO_MANY_FILES', 'The theme ZIP contains too many files.');
          const name = entry.fileName;
          if (!safeArchiveName(name)) fail('THEME_PATH_INVALID', 'The theme ZIP contains an unsafe or unsupported path.');
          const normalizedName = name.toLowerCase();
          if (seenPaths.has(normalizedName)) fail('THEME_DUPLICATE_PATH', 'The theme ZIP contains duplicate paths.');
          seenPaths.add(normalizedName);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) fail('THEME_SYMLINK_NOT_ALLOWED', 'Theme packages cannot contain symbolic links.');
          if (name.endsWith('/')) { zip.readEntry(); return; }
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_ENTRY_BYTES)
            fail('THEME_ENTRY_TOO_LARGE', 'A theme file exceeds the 20 MB limit.');
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES) fail('THEME_EXPANDED_TOO_LARGE', 'The expanded theme exceeds the 100 MB limit.');
          const target = path.resolve(staging, ...name.split('/'));
          if (!target.startsWith(staging + path.sep)) fail('THEME_PATH_INVALID', 'The theme ZIP contains an unsafe path.');
          await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await extractEntry(zip, entry, target);
          zip.readEntry();
        })().catch(failZip);
      });
      zip.readEntry();
    });
    const initialSlug = makeThemeSlug((await validateThemeFiles(staging, 'staging')).definition.name);
    if (initialSlug === DEFAULT_THEME) fail('THEME_RESERVED_NAME', 'The Default theme name is reserved.');
    let slug = initialSlug, suffix = 2;
    while (true) {
      try { await fs.promises.lstat(path.join(themesRoot, slug)); slug = `${initialSlug}-${suffix++}`; }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    const verified = await validateThemeFiles(staging, slug);
    const finalPath = path.join(themesRoot, slug);
    await fs.promises.rename(staging, finalPath);
    return { slug, ...verified.definition, previewUrl: `/theme-assets/${slug}/preview.png` };
  } catch (error) {
    if (zip) zip.close();
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ThemeError) throw error;
    fail('THEME_ZIP_INVALID', 'The theme ZIP is damaged or does not match the required theme structure.');
  }
}

async function readThemeDefinition(themesRoot, slug) {
  if (!safeThemeSlug(slug)) fail('THEME_NOT_FOUND', 'Theme not found.', 404);
  if (slug === DEFAULT_THEME) {
    const { definition, stylesheet } = await resolveDefaultThemeSource(themesRoot);
    return { definition, stylesheet };
  }
  const root = await fs.promises.realpath(themesRoot);
  const found = await findDirectoryEntry(root, slug);
  if (!found) fail('THEME_NOT_FOUND', 'Theme not found.', 404);
  const real = await fs.promises.realpath(found.path);
  if (!real.startsWith(root + path.sep)) fail('THEME_PATH_INVALID', 'The theme directory escapes the themes folder.', 500);
  return validateThemeFiles(real, slug);
}

async function listThemes(themesRoot) {
  await fs.promises.mkdir(themesRoot, { recursive: true, mode: 0o750 });
  const builtIn = await readThemeDefinition(themesRoot, DEFAULT_THEME);
  const result = [{ slug: DEFAULT_THEME, ...builtIn.definition, previewUrl: '' }];
  for (const entry of await fs.promises.readdir(themesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !safeThemeSlug(entry.name) || entry.name === DEFAULT_THEME) continue;
    try {
      const { definition } = await readThemeDefinition(themesRoot, entry.name);
      const directory = await findDirectoryEntry(themesRoot, entry.name);
      let previewUrl = '';
      if (directory && await findFileEntry(directory.path, 'preview.png'))
        previewUrl = `/theme-assets/${entry.name}/preview.png`;
      result.push({ slug: entry.name, ...definition, previewUrl });
    } catch (error) {
      const code = error instanceof ThemeError ? error.code : 'THEME_INVALID';
      console.error('[Teralth Wiki] Theme validation failed', code);
    }
  }
  result.sort((left, right) => left.slug === DEFAULT_THEME ? -1 : right.slug === DEFAULT_THEME ? 1 : left.name.localeCompare(right.name));
  if (!result.some((theme) => theme.slug === DEFAULT_THEME))
    fail('THEME_DEFAULT_MISSING', 'The built-in Default theme is missing or invalid.', 500);
  return result;
}

async function removeTheme(themesRoot, slug) {
  if (!safeThemeSlug(slug) || slug === DEFAULT_THEME)
    fail('THEME_DELETE_FORBIDDEN', 'The built-in Default theme cannot be deleted.', 400);
  const root = await fs.promises.realpath(themesRoot);
  const target = await findDirectoryEntry(root, slug);
  if (!target) fail('THEME_NOT_FOUND', 'Theme not found.', 404);
  await fs.promises.rm(target.path, { recursive: true, force: false });
}

async function readThemeAsset(themesRoot, slug, rawAssetPath) {
  if (!safeThemeSlug(slug)) return null;
  const segments = String(rawAssetPath || '').split('/');
  if (!segments.length || segments.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(part) || part === '.' || part === '..' || part.startsWith('.')))
    return null;
  const relative = segments.join('/');
  if (!(relative === 'theme.css' || relative === 'preview.png' || relative.startsWith('assets/'))) return null;
  if (relative !== 'theme.css' && relative !== 'preview.png' && !ASSET_EXTENSIONS.has(path.extname(relative).toLowerCase())) return null;
  let directory;
  let defaultStylesheet = '';
  if (slug === DEFAULT_THEME) {
    const source = await resolveDefaultThemeSource(themesRoot);
    directory = source.directory;
    defaultStylesheet = source.stylesheet;
  } else {
    const root = await fs.promises.realpath(themesRoot);
    const found = await findDirectoryEntry(root, slug);
    if (!found) return null;
    directory = found.path;
  }
  if (slug === DEFAULT_THEME && !directory && relative === 'theme.css')
    return { buffer: Buffer.from(defaultStylesheet), contentType: 'text/css; charset=utf-8' };
  if (slug === DEFAULT_THEME && !directory) return null;
  const candidate = await resolveThemeFile(directory, segments);
  if (!candidate) return null;
  let buffer;
  try {
    buffer = await readRegularFile(candidate, relative === 'theme.css' ? MAX_CSS_BYTES : MAX_ENTRY_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
    if (error instanceof ThemeError && error.code === 'THEME_FILE_TYPE_INVALID') return null;
    throw error;
  }
  if (relative === 'theme.css') {
    const compiled = scopeThemeCss(buffer.toString('utf8'), slug);
    return { buffer: Buffer.from(compiled), contentType: 'text/css; charset=utf-8' };
  }
  const extension = path.extname(relative).toLowerCase();
  const types = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf',
  };
  return { buffer, contentType: types[extension] };
}

module.exports = {
  DEFAULT_THEME,
  ThemeError,
  installThemeZip,
  listThemes,
  makeThemeSlug,
  normalizeThemeDefinition,
  normalizeValues,
  readThemeAsset,
  readThemeDefinition,
  removeTheme,
  safeThemeSlug,
  scopeThemeCss,
};
