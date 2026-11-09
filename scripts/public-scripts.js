const fs = require('node:fs');
const path = require('node:path');
const { obfuscate } = require('js-confuser');
const { minify } = require('html-minifier-terser');
const { transform } = require('lightningcss');
const { prismBundle } = require('./prism-bundle');

const publicRoot = path.join(__dirname, '..', 'public');
const scripts = new Map([
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
  ['/styles.css', 'styles.css'],
  ['/maintenance.css', 'maintenance.css'],
  ['/installer.css', 'installer.css'],
  ['/vendor/fontawesome/css/all.min.css', path.join('vendor', 'fontawesome', 'css', 'all.min.css')],
  ['/vendor/sweetalert/sweetalert2.min.css', path.join('vendor', 'sweetalert', 'sweetalert2.min.css')],
]);
const cache = new Map();
const options = {
  target: 'browser',
  compact: true,
  minify: true,
  renameVariables: true,
  renameGlobals: true,
  stringConcealing: true,
  controlFlowFlattening: 0.15,
  pack: false,
};

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
  let signature = `${stat.size}:${stat.mtimeMs}`;
  if (type === 'js' && file === 'app.js') {
    const updatesStat = await fs.promises.stat(path.join(publicRoot, 'admin-updates.js'));
    signature += `:${updatesStat.size}:${updatesStat.mtimeMs}`;
  }
  const cached = cache.get(key);
  if (!cached || cached.signature !== signature) {
    const compilation = (async () => {
      let source = await fs.promises.readFile(filePath);
      if (type === 'html') {
        return minify(source.toString('utf8'), {
          collapseWhitespace: true,
          conservativeCollapse: true,
          removeComments: true,
        });
      }
      if (type === 'css') {
        return transform({ filename: file, code: source, minify: true }).code.toString('utf8');
      }
      if (file === 'app.js') {
        const updatesSource = await fs.promises.readFile(path.join(publicRoot, 'admin-updates.js'), 'utf8');
        source = Buffer.from(composeAppScript(source.toString('utf8'), updatesSource));
      }
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

function sendPublicHtml(file, transformHtml) {
  if (![...documents.values()].includes(file)) throw new Error('Unknown public HTML file');
  return async (req, res, next) => {
    try {
      let body = await compiledAsset(file, 'html');
      if (transformHtml) body = await transformHtml(body, req);
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.type('html').send(body);
    } catch (error) {
      return next(error);
    }
  };
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
  if (key === '/vendor/prism/prism.js') {
    if (!cache.has('prism-bundle')) {
      const compilation = prismBundle().then(source => obfuscateScript(source));
      cache.set('prism-bundle', { compilation });
      compilation.catch(() => cache.delete('prism-bundle'));
    }
    return cache.get('prism-bundle').compilation
      .then((body) => {
        res.set('Cache-Control', 'no-cache');
        return res.type('js').send(body);
      })
      .catch(next);
  }
  const file = scripts.get(key);
  if (file) {
    return compiledAsset(file, 'js')
      .then((body) => {
        res.set('Cache-Control', 'no-cache');
        return res.type('js').send(body);
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
  if (html) return sendPublicHtml(html)(req, res, next);
  const css = styles.get(pathname);
  if (css) {
    return compiledAsset(css, 'css')
      .then((body) => {
        res.set('Cache-Control', 'no-cache');
        return res.type('css').send(body);
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

module.exports = { composeAppScript, publicScripts, publicStaticOnly, sendPublicHtml };
