const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { obfuscate } = require('js-confuser');
const { minify } = require('html-minifier-terser');
const lightningcss = require('lightningcss');
const { prismBundle } = require('./prism-bundle');

const publicRoot = path.join(__dirname, '..', 'public');
const scripts = new Map([
  ['/error-screen.js', 'error-screen.js'],
  ['/profile-ui.js', 'profile-ui.js'],
  ['/oauth-complete.js', 'oauth-complete.js'],
  ['/app.js', 'app.js'],
  ['/admin-updates.js', 'admin-updates.js'],
  ['/maintenance.js', 'maintenance.js'],
  ['/installer.js', 'installer.js'],
  ['/vendor/sweetalert/sweetalert2.all.min.js', path.join('vendor', 'sweetalert', 'sweetalert2.all.min.js')],
]);
const documents = new Map([
  ['/index.html', 'index.html'],
  ['/installer.html', 'installer.html'],
  ['/maintenance.html', 'maintenance.html'],
]);
const styles = new Map([
  ['/buttons.css', 'buttons.css'],
  ['/errors.css', 'errors.css'],
  ['/styles.css', 'styles.css'],
  ['/maintenance.css', 'maintenance.css'],
  ['/installer.css', 'installer.css'],
  ['/vendor/fontawesome/css/all.min.css', path.join('vendor', 'fontawesome', 'css', 'all.min.css')],
  ['/vendor/sweetalert/sweetalert2.min.css', path.join('vendor', 'sweetalert', 'sweetalert2.min.css')],
]);
const cache = new Map();
const encodedAssets = new Map();
const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

function encodedAsset(body, encoding) {
  const key = encoding + ':' + crypto.createHash('sha256').update(body).digest('hex');
  if (!encodedAssets.has(key)) {
    const compressed = encoding === 'br'
      ? brotli(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
      : gzip(body, { level: 6 });
    encodedAssets.set(key, compressed);
    compressed.catch(() => encodedAssets.delete(key));
    if (encodedAssets.size > 32) encodedAssets.delete(encodedAssets.keys().next().value);
  }
  return encodedAssets.get(key);
}

async function sendAsset(req, res, body) {
  res.vary('Accept-Encoding');
  res.set('ETag', 'W/"' + crypto.createHash('sha256').update(body).digest('base64url') + '"');
  const encoding = req.acceptsEncodings('br', 'gzip', 'identity');
  if (!encoding) return res.sendStatus(406);
  if (encoding === 'identity' || (Buffer.byteLength(body) < 1024 && req.acceptsEncodings('identity')))
    return res.send(body);
  const compressed = await encodedAsset(body, encoding);
  res.set('Content-Encoding', encoding);
  return res.send(compressed);
}

async function preparePublicAssets({ installer = false } = {}) {
  const files = installer
    ? [['installer.html', 'html'], ['installer.js', 'js'], ['installer.css', 'css']]
    : [['index.html', 'html'], ['app.js', 'js'], ['styles.css', 'css'], ['error-screen.js', 'js'], ['errors.css', 'css'], [styles.get('/vendor/fontawesome/css/all.min.css'), 'css']];
  await Promise.all(files.map(async ([file, type]) => {
    const body = await compiledAsset(file, type);
    if (type !== 'html' && Buffer.byteLength(body) >= 1024)
      await Promise.all([encodedAsset(body, 'br'), encodedAsset(body, 'gzip')]);
  }));
}
const options = {
  target: 'browser',
  compact: true,
  minify: true,
  renameVariables: true,
  renameGlobals: true,
  stringConcealing: false,
  controlFlowFlattening: 0,
  pack: false,
};
// Keep names obfuscated without expensive transforms on the first use of a tool.

function composeAppScript(appSource, updatesSource) {
  return `(function(){\n${updatesSource}\n})();\n${appSource}`;
}

function invalidStaticPath(pathname) {
  return (
    pathname.includes('\\') ||
    pathname.includes(':') ||
    pathname.includes('~') ||
    pathname.split('/').some((part) => part === '.' || part === '..' || /[. ]$/.test(part))
  );
}

async function obfuscateScript(source, isolate = false) {
  const input = isolate ? `(function(){\n${source}\n})();` : source;
  const result = await obfuscate(input, options);
  return result.code;
}

async function compiledAsset(file, type) {
  const key = `${type}:${file}`;
  const filePath = path.join(publicRoot, file);
  const stat = await fs.promises.stat(filePath);
  const dependency = file === 'app.js' ? 'error-screen.js' : file === 'styles.css' ? 'errors.css' : null;
  const dependencyStat = dependency && await fs.promises.stat(path.join(publicRoot, dependency));
  const signature = `${stat.size}:${stat.mtimeMs}:${dependencyStat ? `${dependencyStat.size}:${dependencyStat.mtimeMs}` : ''}`;
  const cached = cache.get(key);
  if (!cached || cached.signature !== signature) {
    const compilation = (async () => {
      let source = await fs.promises.readFile(filePath);
      // Error screens must work with older HTML shells and blocked standalone assets.
      if (dependency) {
        const shared = await fs.promises.readFile(path.join(publicRoot, dependency));
        source = file === 'app.js'
          ? Buffer.from(`${shared.toString('utf8')}\n;\n${source.toString('utf8')}`)
          : Buffer.from(`${source.toString('utf8')}\n${shared.toString('utf8')}`);
      }
      if (type === 'html') {
        return minify(source.toString('utf8'), {
          collapseWhitespace: true,
          conservativeCollapse: true,
          removeComments: true,
        });
      }
      if (type === 'css')
        return lightningcss.transform({ filename: file, code: source, minify: true }).code.toString('utf8');
      return obfuscateScript(source.toString('utf8'), !file.startsWith('vendor'));
    })();
    const entry = { signature, compilation };
    cache.set(key, entry);
    compilation.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
  }
  return cache.get(key).compilation;
}

async function appScriptVersion() {
  const sources = await Promise.all(['app.js', 'error-screen.js'].map(file => fs.promises.readFile(path.join(publicRoot, file))));
  const hash = crypto.createHash('sha256');
  for (const source of sources) hash.update(source).update('\0');
  return hash.digest('hex').slice(0, 16);
}

function sendPublicHtml(file, transformHtml) {
  if (![...documents.values()].includes(file)) throw new Error('Unknown public HTML file');
  return async (req, res, next) => {
    try {
      let body = await compiledAsset(file, 'html');
      if (transformHtml) {
        const transformed = await transformHtml(body, req);
        if (typeof transformed === 'string') body = transformed;
        else if (transformed && typeof transformed.html === 'string') {
          body = transformed.html;
          if (Number.isInteger(transformed.status) && transformed.status >= 100 && transformed.status <= 599)
            res.status(transformed.status);
        }
      }
      if (file === 'index.html') {
        // Both resources are already embedded in the compiled application assets.
        body = body
          .replace(/<link\b[^>]*href=(['"])\/errors\.css\1[^>]*>/i, '')
          .replace(/<script\b[^>]*src=(['"])\/error-screen\.js\1[^>]*>\s*<\/script>/i, '');
        const version = await appScriptVersion();
        let replaced = false;
        body = body.replace(/src=(['"])\/app\.js(?:\?[^'"]*)?\1/i, (_match, quote) => {
          replaced = true;
          return `src=${quote}/app-${version}.js${quote}`;
        });
        if (!replaced) throw new Error('The public page template is missing its app script.');
      }
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.type('html').send(body);
    } catch (error) {
      return next(error);
    }
  };
}

function sendStandaloneUpdaterHtml() {
  return sendPublicHtml('maintenance.html', (html) => {
    const assets =
      '<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">' +
      '<link rel="stylesheet" href="/styles.css">' +
      '<link rel="stylesheet" href="/vendor/sweetalert/sweetalert2.min.css">' +
      '<script src="/vendor/sweetalert/sweetalert2.all.min.js" defer></script>' +
      '<script src="/admin-updates.js" defer></script>';
    const body =
      '<body class="maintenance-body standalone-updater-page">' +
      '<main class="standalone-updater-shell">' +
      '<header class="standalone-updater-header">' +
      '<a class="standalone-updater-brand" href="/admin"><span aria-hidden="true">T</span><strong>Teralth Studio</strong></a>' +
      '<div class="standalone-updater-title"><h1 data-es="Actualizador" data-en="System updater">System updater</h1>' +
      '<p data-es="Actualiza el sistema desde una página independiente." data-en="Update the system from this separate page.">Update the system from this separate page.</p></div>' +
      '<div class="standalone-updater-actions"><button class="standalone-updater-language" id="updateLanguageToggle" type="button">ES</button>' +
      '<a class="standalone-updater-back" href="/admin/updates"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> <span data-es="Volver a administración" data-en="Back to administration">Back to administration</span></a></div>' +
      '</header><div class="standalone-updater-error" id="updatePageError" role="alert" hidden></div>' +
      '<div class="standalone-updater-content" id="updateApp"></div></main>';
    html = html.replace(/<title>[^<]*<\/title>/i, '<title>System updater</title>');
    const headEnd = html.toLowerCase().indexOf('</head>');
    if (headEnd < 0) throw new Error('The standalone updater page template is invalid.');
    html = html.slice(0, headEnd) + assets + html.slice(headEnd);
    const bodyStart = html.toLowerCase().indexOf('<body');
    const bodyOpenEnd = html.indexOf('>', bodyStart);
    const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
    if (bodyStart < 0 || bodyOpenEnd < 0 || bodyEnd < 0)
      throw new Error('The standalone updater page template is invalid.');
    return html.slice(0, bodyStart) + body + html.slice(bodyEnd);
  });
}

function publicScripts(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let pathname;
  try {
    pathname = decodeURIComponent(req.path);
  } catch {
    return res.sendStatus(400);
  }
  if (invalidStaticPath(pathname)) return next();
  const key = pathname.toLowerCase();
  const versionedApp = key.match(/^\/app-([a-f0-9]{16})\.js$/);
  if (versionedApp) {
    return (async () => {
      const version = await appScriptVersion(),
        body = await compiledAsset('app.js', 'js');
      res.set(
        'Cache-Control',
        versionedApp[1] === version ? 'public, max-age=31536000, immutable' : 'no-store, no-cache, must-revalidate',
      );
      return sendAsset(req, res.type('js'), body);
    })().catch(next);
  }
  if (key === '/vendor/prism/prism.js') {
    if (!cache.has('prism-bundle')) {
      const compilation = prismBundle().then(source => obfuscateScript(source));
      cache.set('prism-bundle', { compilation });
      compilation.catch(() => cache.delete('prism-bundle'));
    }
    return cache.get('prism-bundle').compilation
      .then((body) => {
        res.set('Cache-Control', 'no-cache');
        return sendAsset(req, res.type('js'), body);
      })
      .catch(next);
  }
  const file = scripts.get(key);
  if (file) {
    return compiledAsset(file, 'js')
      .then((body) => {
        res.set('Cache-Control', 'no-cache');
        return sendAsset(req, res.type('js'), body);
      })
      .catch(next);
  }
  if (
    /\.(?:js|mjs|cjs|map)$/i.test(pathname) &&
    (/^\/(?:assets|vendor|languages)\//i.test(pathname) || /^\/(?:app|admin-updates|installer|maintenance)\./i.test(pathname))
  ) {
    return res.sendStatus(404);
  }
  return next();
}

function publicStaticOnly(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let pathname;
  try {
    pathname = decodeURIComponent(req.path).toLowerCase();
  } catch {
    return res.sendStatus(400);
  }
  if (invalidStaticPath(pathname)) return next();
  const html = documents.get(pathname);
  if (pathname === '/assets/fonts/roboto-mono-400.ttf')
    return res.type('font/ttf').set('Cache-Control', 'public, max-age=86400').send(require('./error-font').data);
  if (pathname === '/assets/fonts/license-roboto-mono')
    return res.type('text/plain').send(require('./error-font').license);
  if (html) return sendPublicHtml(html)(req, res, next);
  const css = styles.get(pathname);
  if (css) {
    return compiledAsset(css, 'css')
      .then((body) => {
        res.set('Cache-Control', 'no-cache');
        return sendAsset(req, res.type('css'), body);
      })
      .catch(next);
  }
  if (/\.(?:html?|css)$/i.test(pathname) && /^\/(?:assets|vendor)\//i.test(pathname)) {
    return res.sendStatus(404);
  }
  if (/\.(?:js|mjs|cjs|map)$/i.test(pathname) && /^\/(?:assets|vendor|languages)\//i.test(pathname)) {
    return res.sendStatus(404);
  }
  if (
    ['/index.html', '/installer.html', '/installer.css', '/styles.css'].includes(pathname) ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/vendor/') ||
    pathname === '/maintenance.css'
  ) {
    return publicStatic(req, res, next);
  }
  return next();
}

const express = require('express');
const publicStatic = express.static(publicRoot, {
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1y' : 0,
  immutable: process.env.NODE_ENV === 'production',
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(?:html|json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
});

module.exports = {
  composeAppScript,
  publicScripts,
  publicStaticOnly,
  sendPublicHtml,
  sendStandaloneUpdaterHtml,
  preparePublicAssets,
};
