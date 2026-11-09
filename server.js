require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const sanitizeHtml = require('sanitize-html');
const sharp = require('sharp');
sharp.concurrency(Math.max(1, Math.min(2, Number(process.env.IMAGE_PROCESSING_CONCURRENCY || 2))));
sharp.cache({ memory: 64, files: 20, items: 100 });
const { rateLimit } = require('express-rate-limit');
const proxyaddr = require('proxy-addr');
const { encryptBackupDatabase } = require('./scripts/backup-crypto');
const { decryptBackupDatabase } = require('./scripts/backup-crypto');
const { requireCurrentAdminSession } = require('./scripts/admin-session');
const { requirePrimaryAdmin, resolveSmtpPassword } = require('./scripts/smtp-security');
const { SESSION_IDLE_MS, rejectLegacySessions } = require('./scripts/session-security');
const { createSiteRateLimiter } = require('./scripts/site-rate-limit');
const { loginDetails } = require('./scripts/login-details');
const { registerTwoFactorRoutes, binding: twoFactorBinding, sessionBinding: twoFactorSessionBinding, LIFETIME: TWO_FACTOR_LIFETIME } = require('./scripts/two-factor');
const { publicScripts, publicStaticOnly, sendPublicHtml } = require('./scripts/public-scripts');
const { normalizeSiteOptions, normalizeSupportUrl } = require('./scripts/site-settings');
const { HEADER_LINK_LIMIT, normalizeHeaderLink, normalizeHeaderLinks } = require('./scripts/header-links');
const { migrateSitePermissions } = require('./scripts/role-permissions');
const { createUpdateMaintenance } = require('./scripts/update-maintenance');
const {
  UpdateError,
  applyUpdatePackage,
  compareVersions,
  ensureUpdateTables,
  preflightUpdatePackage,
  verifyUpdatePackage,
} = require('./scripts/site-updater');
const updatePublicKey = process.env.UPDATE_PUBLIC_KEY || require('./scripts/update-public-key');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { createBackupZipStream, readBackupZip } = require('./scripts/backup-zip');
const {
  DEFAULT_TIME_ZONE,
  TIME_ZONES: backupTimeZones,
  validateTimeZone,
  validateBackupCron,
  nextCronDate,
} = require('./scripts/backup-cron');

const required = ['SESSION_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'ADMIN_INITIAL_PASSWORD'];
for (const key of required) if (!process.env[key]) throw new Error(`Falta configurar ${key} en .env`);
if (process.env.SESSION_SECRET.length < 32)
  throw new Error('SESSION_SECRET debe tener al menos 32 caracteres.');
if (process.env.NODE_ENV === 'production' && !process.env.BASE_URL)
  throw new Error('BASE_URL es obligatorio en producción.');
if (process.env.NODE_ENV === 'production') {
  let origin;
  try {
    origin = new URL(process.env.BASE_URL);
  } catch {
    throw new Error('BASE_URL debe ser el origen HTTPS público de la wiki.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      'En producción, BASE_URL debe contener solo el origen HTTPS público, sin ruta, credenciales ni parámetros.',
    );
}
const app = express();
let httpServer = null;
const maintenance = createUpdateMaintenance({
  page: fs.readFileSync(path.join(__dirname, 'public', 'maintenance.html')),
});
const updateMaintenance = maintenance.state;
const setUpdateMaintenance = maintenance.set;
const failUpdateMaintenance = maintenance.fail;
const updateValidationState = { active: false, progress: 0, stage: 'idle' };
let updateValidationBusy = false,
  pendingValidatedUpdate = null;
function setUpdateValidation(stage, progress) {
  updateValidationState.active = stage !== 'verified' && stage !== 'failed';
  updateValidationState.stage = stage;
  updateValidationState.progress = Math.max(0, Math.min(100, Math.round(progress)));
}
function clearPendingValidatedUpdate() {
  if (!pendingValidatedUpdate) return;
  clearTimeout(pendingValidatedUpdate.expiry);
  pendingValidatedUpdate = null;
}
const defaultProxyConfig = {
  mode: 'hops',
  hops: 1,
  addresses: '',
  upstream: `http://127.0.0.1:${Number(process.env.PORT || process.env.SERVER_PORT || 3000)}`,
};
let reverseProxyConfig = { ...defaultProxyConfig };
function validateReverseProxy(input = {}) {
  const mode = String(input.mode || 'hops');
  if (!['disabled', 'hops', 'addresses'].includes(mode))
    throw Object.assign(new Error('Selecciona un modo de proxy válido.'), { status: 400 });
  const hops = Number(input.hops ?? 1);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10)
    throw Object.assign(new Error('El número de proxies debe estar entre 1 y 10.'), { status: 400 });
  const addresses = String(input.addresses || '').trim();
  if (addresses.length > 2000 || /[\r\n\0]/.test(addresses))
    throw Object.assign(new Error('Revisa las direcciones de proxy.'), { status: 400 });
  let addressList = [];
  if (mode === 'addresses') {
    addressList = addresses
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !addressList.length ||
      addressList.length > 50 ||
      addressList.some((value) => value === '*' || value === '0.0.0.0/0' || value === '::/0')
    )
      throw Object.assign(
        new Error(
          'Añade entre 1 y 50 IP o subredes concretas; no se permite confiar en cualquier dirección.',
        ),
        { status: 400 },
      );
    try {
      proxyaddr.compile(addressList);
    } catch {
      throw Object.assign(new Error('Una IP o subred no es válida.'), { status: 400 });
    }
  }
  const upstream = String(input.upstream || defaultProxyConfig.upstream).trim();
  let parsed;
  try {
    parsed = new URL(upstream);
  } catch {
    throw Object.assign(new Error('La dirección upstream no es válida.'), { status: 400 });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw Object.assign(
      new Error('Usa una URL upstream HTTP(S) sin ruta ni credenciales, por ejemplo http://127.0.0.1:3000.'),
      { status: 400 },
    );
  return { mode, hops, addresses: addressList.join(', '), upstream };
}
function applyReverseProxyTrust(config) {
  reverseProxyConfig = config;
  if (config.mode === 'disabled') app.set('trust proxy', false);
  else if (config.mode === 'hops') app.set('trust proxy', config.hops);
  else
    app.set(
      'trust proxy',
      proxyaddr.compile(
        config.addresses
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
}
const pool = mysql.createPool({
  timezone: 'Z',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  waitForConnections: true,
  connectionLimit: Math.min(10, Math.max(1, Number(process.env.DB_POOL_LIMIT || 5))),
  maxIdle: 2,
  idleTimeout: 20000,
  queueLimit: 20,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 10000,
  charset: 'utf8mb4',
});
pool.on('connection', (connection) =>
  connection.query("SET time_zone = '+00:00'", (error) => {
    if (error)
      console.error('No se pudo fijar UTC en una conexión MySQL:', error.code || error.name || 'Error');
  }),
);
const store = new MySQLStore({ createDatabaseTable: true }, pool);
const expectedTables = [
  'users',
  'spaces',
  'categories',
  'pages',
  'settings',
  'reactions',
  'account_tokens',
  'sessions',
  'roles',
  'background_jobs',
  'rate_limit_buckets',
];
let schemaRepairPromise = null;
let lastSchemaCheck = 0;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-user-password', 12);
const smtpEnvConfig = {
  host: String(process.env.SMTP_HOST || ''),
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  user: String(process.env.SMTP_USER || ''),
  password: String(process.env.SMTP_PASS || ''),
  from: String(process.env.SMTP_FROM || ''),
};
let smtpConfig = { ...smtpEnvConfig };
const buildMailer = (config) =>
  config?.host && config?.from
    ? nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.password } : undefined,
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000,
      })
    : null;
let mailer = buildMailer(smtpConfig);
const smtpProofs = new Map();
const langs = ['en', 'es'];
const validFontAwesomeIcon = (value) =>
  typeof value === 'string' &&
  value.length <= 80 &&
  /^(?:(?:fa-solid|fa-regular|fa-brands)\s+)?fa-[a-z0-9-]+$/.test(value);
const validStoredIcon = (value) =>
  validFontAwesomeIcon(value) ||
  (typeof value === 'string' && /^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/.test(value));

const htmlPolicy = {
  allowedTags: [
    'a',
    'address',
    'article',
    'aside',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'del',
    'details',
    'div',
    'em',
    'figcaption',
    'figure',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'iframe',
    'li',
    'ol',
    'p',
    'pre',
    's',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'input',
  ],
  allowedAttributes: {
    '*': ['class'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    input: ['type', 'checked', 'disabled'],
    iframe: ['src', 'title', 'loading', 'allowfullscreen'],
    span: ['data-language', 'style'],
    p: ['style'],
    div: ['style'],
  },
  allowedStyles: {
    span: {
      'font-style': [/^(normal|italic|oblique)$/i],
      color: [/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i, /^inherit$/i],
      'background-color': [/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i, /^transparent$/i],
      'font-family': [
        /^(Arial|Courier New|Georgia|Lucida Sans Unicode|Tahoma|Times New Roman|Trebuchet MS|Verdana|inherit)$/i,
      ],
    },
    p: { 'text-align': [/^(left|center|right|justify)$/] },
    div: {
      'text-align': [/^(left|center|right|justify)$/],
      width: [/^(?:1[2-9]\d|[2-9]\d{2}|1\d{3})px$/],
      'max-width': [/^100%$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedIframeHostnames: ['www.youtube-nocookie.com'],
  disallowedTagsMode: 'discard',
};

app.disable('x-powered-by');
applyReverseProxyTrust(reverseProxyConfig);
app.use(createSiteRateLimiter());
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure)
    return res.redirect(308, `${new URL(process.env.BASE_URL).origin}${req.originalUrl}`);
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://www.google.com/recaptcha/',
          'https://www.gstatic.com/recaptcha/',
          'https://js.hcaptcha.com',
          'https://hcaptcha.com',
          'https://*.hcaptcha.com',
          'https://challenges.cloudflare.com',
        ],
        imgSrc: ["'self'", 'data:', 'https:'],
        frameSrc: [
          'https://www.youtube-nocookie.com',
          'https://www.google.com/recaptcha/',
          'https://recaptcha.google.com/recaptcha/',
          'https://hcaptcha.com',
          'https://*.hcaptcha.com',
          'https://challenges.cloudflare.com',
        ],
        frameAncestors: ["'none'"],
        connectSrc: [
          "'self'",
          'https://www.google.com/recaptcha/',
          'https://www.gstatic.com/recaptcha/',
          'https://hcaptcha.com',
          'https://*.hcaptcha.com',
          'https://challenges.cloudflare.com',
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        scriptSrcAttr: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '5mb', type: 'application/json' }));
const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: SESSION_IDLE_MS,
  path: '/',
};
app.use((req, res, next) => {
  if (
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|backup|data|images|node_modules|AGENTS)(?:\/|$)/i.test(req.path) ||
    /^\/(?:setup\.key|server\.js|launcher\.js|package(?:-lock)?\.json|schema\.sql|\.npmrc|\.htaccess)(?:\/|$)/i.test(
      req.path,
    )
  )
    return res.sendStatus(404);
  next();
});
app.use(maintenance.middleware);
app.use(publicScripts);
app.use(
  '/languages',
  express.static(path.join(__dirname, 'languages'), {
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);
app.use(publicStaticOnly);
app.use(
  session({
    name: 'teralth.sid',
    secret: process.env.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: sessionCookieOptions,
  }),
);
app.use(rejectLegacySessions);
app.use('/api/admin/uploads', uploadDiagnostics);
app.use('/api/admin/spaces/:slug/logo', uploadDiagnostics);
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (!origin) return res.status(403).json({ error: 'Origen no permitido.' });
    try {
      const source = new URL(origin);
      if (!['http:', 'https:'].includes(source.protocol) || source.host !== req.get('host'))
        return res.status(403).json({ error: 'Origen no permitido.' });
    } catch {
      return res.status(403).json({ error: 'Origen no permitido.' });
    }
    if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken)
      return res.status(403).json({ error: 'La sesión expiró. Actualiza la página e inténtalo de nuevo.' });
  }
  next();
});
const imageUploadLimitValue = process.env.IMAGE_UPLOAD_MAX_MB ?? '50';
const imageUploadLimitMb = Number(imageUploadLimitValue);
if (!/^[1-9]\d*$/.test(imageUploadLimitValue) ||
    !Number.isSafeInteger(imageUploadLimitMb * 1024 * 1024))
  throw new Error('IMAGE_UPLOAD_MAX_MB debe ser un número entero positivo de MB.');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: imageUploadLimitMb * 1024 * 1024, files: 1 },
});
function uploadDiagnostics(req, res, next) {
  let reason = '';
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body.error === 'string') reason = body.error;
    return originalJson(body);
  };
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    console.error(
      '[Teralth Wiki] Falló una solicitud de imagen o archivo',
      JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        reason: reason || 'La solicitud terminó con error antes de devolver un detalle JSON.',
        fileBytes: /^\d+$/.test(req.get('content-length') || '') ? Number(req.get('content-length')) : null,
      }),
    );
  });
  next();
}
function uploadImageMiddleware(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: `El archivo no puede pesar más de ${imageUploadLimitMb} MB.` });
      if (error.code === 'LIMIT_FILE_COUNT')
        return res.status(400).json({ error: 'Sube un archivo por vez.' });
      if (error.code === 'LIMIT_UNEXPECTED_FILE')
        return res
          .status(400)
          .json({ error: 'El campo de archivo no es válido. Selecciona la imagen otra vez.' });
      return res
        .status(400)
        .json({ error: 'No se pudo procesar el archivo. Comprueba que sea una imagen válida.' });
    }
    return next(error);
  });
}

const query = async (sql, params = []) => {
  const run = () => pool.execute(sql, params);
  let result;
  try {
    result = await run();
  } catch (error) {
    if (
      !['ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST'].includes(error.code) ||
      !/^\s*SELECT\b/i.test(sql)
    )
      throw error;
    result = await run();
  }
  return result[0];
};
const schemaIndexStatements = [
  "ALTER TABLE pages ADD COLUMN page_type ENUM('content','redirect') NOT NULL DEFAULT 'content'",
  'ALTER TABLE pages ADD COLUMN redirect_url VARCHAR(2048) NULL',
  'ALTER TABLE spaces ADD COLUMN home_page_slug VARCHAR(150) NULL',
  'ALTER TABLE spaces ADD COLUMN logo VARCHAR(500) NULL',
  'ALTER TABLE users ADD INDEX idx_users_temporary_expiration (must_change_password,temporary_password_expires_at)',
  "ALTER TABLE users MODIFY role VARCHAR(64) NOT NULL DEFAULT 'user'",
  'ALTER TABLE users ADD COLUMN is_primary_admin BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE users ADD COLUMN two_factor_secret TEXT NULL',
  'ALTER TABLE users ADD COLUMN two_factor_recovery_codes JSON NULL',
  'ALTER TABLE users ADD COLUMN two_factor_last_step BIGINT NULL',
  'ALTER TABLE reactions ADD COLUMN user_id BIGINT UNSIGNED NULL',
  'ALTER TABLE reactions ADD INDEX idx_reactions_page_user (page_id,user_id)',
  'ALTER TABLE reactions ADD INDEX idx_reactions_space_page_mood (space_slug,page_id,mood,user_id,ip_hash)',
  'ALTER TABLE categories ADD INDEX idx_categories_space_order (space_slug,sort_order,id)',
  'ALTER TABLE pages ADD INDEX idx_pages_space_navigation (space_slug,category_id,sort_order,slug)',
  'ALTER TABLE reactions ADD INDEX idx_reactions_page_mood (page_id,mood)',
  'ALTER TABLE account_tokens ADD INDEX idx_token_expiration (purpose,expires_at,used_at)',
];
async function ensureReactionUserForeignKey() {
  const existing = await query(
    "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='reactions' AND COLUMN_NAME='user_id' AND REFERENCED_TABLE_NAME='users' AND REFERENCED_COLUMN_NAME='id' LIMIT 1",
  );
  if (existing.length) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const constraint = 'fk_rx_uid_' + crypto.randomBytes(8).toString('hex');
    try {
      await pool.query(
        'ALTER TABLE reactions ADD CONSTRAINT `' +
          constraint +
          '` FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL',
      );
      return;
    } catch (error) {
      if (
        error.code === 'ER_FK_DUP_NAME' ||
        (error.code === 'ER_CANT_CREATE_TABLE' &&
          /errno:\s*121/i.test(String(error.sqlMessage || error.message)))
      )
        continue;
      error.teralthSchemaStatement =
        'ALTER TABLE reactions ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL';
      throw error;
    }
  }
  throw Object.assign(new Error('No se pudo elegir un nombre único para la clave foránea de reacciones.'), {
    code: 'ER_FK_DUP_NAME',
    teralthSchemaStatement:
      'ALTER TABLE reactions ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL',
  });
}
async function applySchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const statement of schema
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)) {
    try {
      await pool.query(statement);
    } catch (error) {
      error.teralthSchemaStatement = statement;
      throw error;
    }
  }
  for (const statement of schemaIndexStatements) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (!['ER_DUP_KEYNAME', 'ER_DUP_FIELDNAME', 'ER_FK_DUP_NAME'].includes(error.code)) {
        error.teralthSchemaStatement = statement;
        throw error;
      }
    }
  }
  await ensureReactionUserForeignKey();
  try {
    await store.createDatabaseTable();
  } catch (error) {
    error.teralthSchemaStatement = 'CREATE TABLE sessions (express-mysql-session schema)';
    throw error;
  }
}
async function repairMissingTables(force = false) {
  if (!force && Date.now() - lastSchemaCheck < 1000) return [];
  if (schemaRepairPromise) return schemaRepairPromise;
  schemaRepairPromise = (async () => {
    const tableNames = [...new Set(expectedTables)],
      placeholders = tableNames.map(() => '?').join(','),
      metadata = await query(
        `SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${placeholders})`,
        tableNames,
      ),
      existing = new Set(metadata.map((row) => row.TABLE_NAME)),
      columnsByTable = new Map();
    for (const row of metadata) {
      const columns = columnsByTable.get(row.TABLE_NAME) || new Set();
      columns.add(row.COLUMN_NAME);
      columnsByTable.set(row.TABLE_NAME, columns);
    }
    const missing = expectedTables.filter((name) => !existing.has(name)),
      missingUserColumns = ['is_primary_admin', 'two_factor_secret', 'two_factor_recovery_codes', 'two_factor_last_step'].filter((name) => !columnsByTable.get('users')?.has(name)),
      missingReactionColumns = ['user_id'].filter((name) => !columnsByTable.get('reactions')?.has(name)),
      missingPageColumns = ['page_type', 'redirect_url'].filter(
        (name) => !columnsByTable.get('pages')?.has(name),
      ),
      missingSpaceColumns = ['home_page_slug', 'logo'].filter(
        (name) => !columnsByTable.get('spaces')?.has(name),
      );
    if (
      force ||
      missing.length ||
      missingPageColumns.length ||
      missingSpaceColumns.length ||
      missingUserColumns.length ||
      missingReactionColumns.length
    ) {
      await applySchema();
      if (missing.length) console.warn(`Se restauraron tablas MySQL faltantes: ${missing.join(', ')}`);
      if (missingPageColumns.length)
        console.warn(`Se restauraron columnas de páginas faltantes: ${missingPageColumns.join(', ')}`);
      if (missingSpaceColumns.length)
        console.warn(`Se restauraron columnas de espacios faltantes: ${missingSpaceColumns.join(', ')}`);
      if (missingUserColumns.length)
        console.warn(`Se restauraron columnas de usuarios faltantes: ${missingUserColumns.join(', ')}`);
      if (missingReactionColumns.length)
        console.warn(`Se restauraron columnas de reacciones faltantes: ${missingReactionColumns.join(', ')}`);
    }
    lastSchemaCheck = Date.now();
    return missing;
  })();
  try {
    return await schemaRepairPromise;
  } finally {
    schemaRepairPromise = null;
  }
}
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const slugify = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
const spaceSlugify = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const smtpEncryptionKey = () =>
  crypto
    .createHash('sha256')
    .update('teralth-smtp:' + process.env.SESSION_SECRET)
    .digest();
const captchaVariants = {
  hcaptcha: new Set(['checkbox', 'invisible']),
  recaptcha: new Set(['v2_checkbox', 'v2_invisible', 'v3']),
  turnstile: new Set(['managed']),
};
const captchaEncryptionKey = () =>
  crypto
    .createHash('sha256')
    .update('teralth-captcha:' + process.env.SESSION_SECRET)
    .digest();
function encryptCaptchaSecret(value) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', captchaEncryptionKey(), iv),
    ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}
function decryptCaptchaSecret(value) {
  if (!value) return '';
  const [version, iv, tag, ciphertext] = String(value).split(':');
  if (version !== 'v1') throw new Error('CAPTCHA_SECRET_FORMAT_INVALID');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    captchaEncryptionKey(),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
async function loadCaptchaConfig() {
  const [row] = await query(
    "SELECT setting_value FROM settings WHERE setting_key='captcha_settings' LIMIT 1",
  );
  const stored = row ? json(row.setting_value) : {};
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}
function publicCaptchaConfig(config) {
  return {
    enabled: config.enabled === true,
    provider: config.enabled ? config.provider : '',
    variant: config.enabled ? config.variant : '',
    siteKey: config.enabled ? String(config.siteKey || '') : '',
    minScore: Number(config.minScore) || 0.5,
  };
}
function captchaServiceError(code, reason) {
  const error = new Error(`CAPTCHA verification unavailable: ${reason}`);
  error.code = code;
  return error;
}
async function verifyCaptcha(req, action) {
  let provider = 'unknown',
    timeout;
  try {
    const config = await loadCaptchaConfig();
    if (config.enabled !== true) return true;
    provider = config.provider;
    const variant = config.variant;
    if (!captchaVariants[provider]?.has(variant) || !config.siteKey || !config.secretCiphertext)
      throw captchaServiceError('CAPTCHA_CONFIGURATION_ERROR', 'invalid provider configuration');
    const responseToken = String(req.body?.captchaToken || '');
    if (!responseToken) return false;
    if (responseToken.length > 4096) {
      console.warn('[Teralth Wiki] CAPTCHA rejected: token exceeds the size limit');
      return false;
    }
    let secret;
    try {
      secret = decryptCaptchaSecret(config.secretCiphertext);
    } catch {
      throw captchaServiceError('CAPTCHA_CONFIGURATION_ERROR', 'unable to decrypt configured secret');
    }
    let endpoint;
    const fields = new URLSearchParams({ secret, response: responseToken });
    if (provider === 'hcaptcha') {
      endpoint = 'https://api.hcaptcha.com/siteverify';
      fields.set('sitekey', String(config.siteKey));
    } else if (provider === 'recaptcha') endpoint = 'https://www.google.com/recaptcha/api/siteverify';
    else endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 8000);
    const result = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fields,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!result.ok) throw captchaServiceError('CAPTCHA_PROVIDER_ERROR', `provider returned HTTP ${result.status}`);
    const text = await result.text();
    if (Buffer.byteLength(text) > 65536)
      throw captchaServiceError('CAPTCHA_PROVIDER_ERROR', 'provider response too large');
    const data = JSON.parse(text);
    if (typeof data.success !== 'boolean')
      throw captchaServiceError('CAPTCHA_PROVIDER_ERROR', 'invalid provider response');
    if (data.success !== true) {
      const knownCodes = new Set([
        'missing-input-secret', 'invalid-input-secret', 'missing-input-response',
        'invalid-input-response', 'bad-request', 'timeout-or-duplicate',
        'expired-input-response', 'already-seen-response',
        'invalid-input-sitekey', 'sitekey-secret-mismatch', 'internal-error',
      ]);
      const codes = Array.isArray(data['error-codes'])
        ? data['error-codes'].filter((code) => knownCodes.has(code))
        : [];
      if (codes.some((code) => ['missing-input-secret', 'invalid-input-secret', 'invalid-input-sitekey',
        'sitekey-secret-mismatch', 'bad-request', 'internal-error'].includes(code)))
        throw captchaServiceError('CAPTCHA_CONFIGURATION_ERROR', `${provider}: ${codes.join(', ')}`);
      console.warn('[Teralth Wiki] CAPTCHA rejected', JSON.stringify({
        provider, reason: codes.length ? codes.join(', ') : 'provider rejected response',
      }));
      return false;
    }
    // hCaptcha documents hostname as browser-derived, informational and sometimes unavailable.
    if (provider !== 'hcaptcha') {
      const expectedHost = (
          process.env.BASE_URL ? new URL(process.env.BASE_URL).hostname : req.hostname
        ).toLowerCase(),
        verifiedHost = String(data.hostname || '').toLowerCase();
      if (!verifiedHost || verifiedHost !== expectedHost) {
        const safeHost = (host) => /^[a-z0-9.:[\]-]{1,253}$/.test(host) ? host : '[invalid]';
        console.warn('[Teralth Wiki] CAPTCHA rejected: hostname mismatch', JSON.stringify({
          expected: safeHost(expectedHost),
          verified: safeHost(verifiedHost),
          source: process.env.BASE_URL ? 'BASE_URL' : 'request hostname',
        }));
        return false;
      }
    }
    if (
      provider === 'recaptcha' &&
      variant === 'v3' &&
      (data.action !== action ||
        !Number.isFinite(Number(data.score)) ||
        Number(data.score) < (Number(config.minScore) || 0.5))
    )
      return false;
    if (provider === 'turnstile' && data.action && data.action !== action) return false;
    return true;
  } catch (error) {
    if (error.code === 'CAPTCHA_CONFIGURATION_ERROR' || error.code === 'CAPTCHA_PROVIDER_ERROR') throw error;
    throw captchaServiceError('CAPTCHA_PROVIDER_ERROR', error.name === 'AbortError' ? 'provider timeout' : 'provider or configuration unavailable');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function encryptSmtpPassword(value) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', smtpEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}
function decryptSmtpPassword(value) {
  if (!value) return '';
  const [version, iv, tag, ciphertext] = String(value).split(':');
  if (version !== 'v1') throw new Error('La contraseña SMTP guardada no se puede descifrar.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', smtpEncryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
const smtpSignature = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const generateTemporaryPassword = () => {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*'];
  return Array.from({ length: 3 }, () =>
    sets.map((chars) => chars[crypto.randomInt(chars.length)]).join(''),
  ).join('');
};
const clean = (value) => sanitizeHtml(String(value || ''), htmlPolicy);
const safePageContent = (value) => {
  const content = json(value);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {};
  return Object.fromEntries(
    Object.entries(content)
      .filter(([, html]) => typeof html === 'string')
      .map(([language, html]) => [language, clean(html)]),
  );
};
const redactDiagnostic = (error, secrets = []) => {
  let message = String(error?.message || error || 'Request failed')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 800);
  for (const secret of secrets
    .filter(Boolean)
    .map(String)
    .sort((a, b) => b.length - a.length))
    message = message.split(secret).join('[redacted]');
  return message;
};
const userView = (u) =>
  u && {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    isPrimaryAdmin: !!u.is_primary_admin,
    mustChangePassword: !!u.must_change_password,
    twoFactorEnabled: !!u.two_factor_secret,
  };
const rolePermissionsDefault = [
  'captcha.configure',
  'admin.view',
  'pages.create_edit',
  'pages.delete',
  'categories.create_edit',
  'categories.delete',
  'settings.identity',
  'settings.support',
  'settings.seo',
  'settings.sidebar_label',
  'languages.create',
  'languages.edit',
  'languages.delete',
  'spaces.create',
  'spaces.edit',
  'spaces.delete',
  'users.registration',
  'users.edit',
  'users.delete',
  'users.role',
  'users.reset_password',
  'reverse_proxy.configure',
  'smtp.configure',
  'roles.manage',
  'backups.import',
  'backups.export',
  'backups.schedule',
  'updates.install',
  'header_links.create_edit',
  'header_links.delete',
];
const rolePermissionsEmpty = [];
async function permissionsFor(user) {
  if (!user) return [];
  if (user.is_primary_admin || user.role === 'administrator') return [...rolePermissionsDefault];
  const [row] = await query('SELECT permissions FROM roles WHERE role_key=?', [user.role]);
  return row ? json(row.permissions) : [];
}
async function canUser(userId, permission) {
  const [row] = await query(
    'SELECT u.role,u.is_primary_admin,r.permissions FROM users u LEFT JOIN roles r ON r.role_key=u.role WHERE u.id=?',
    [userId],
  );
  return (
    !!row &&
    (!!row.is_primary_admin ||
      row.role === 'administrator' ||
      (row.permissions && json(row.permissions).includes(permission)))
  );
}
const requirePermission = (permission) => (req, res, next) => {
  canUser(req.session.user?.id, permission)
    .then((allowed) =>
      allowed ? next() : res.status(403).json({ error: 'No tienes permiso para esta acción.' }),
    )
    .catch(next);
};
const primaryAdminOnly = requirePrimaryAdmin(async (userId) => {
  const [user] = await query('SELECT is_primary_admin FROM users WHERE id=?', [userId]);
  return user;
});
const requireAnyPermission = (permissions) => (req, res, next) =>
  Promise.all(permissions.map((permission) => canUser(req.session.user?.id, permission)))
    .then((results) =>
      results.some(Boolean) ? next() : res.status(403).json({ error: 'No tienes permiso para esta acción.' }),
    )
    .catch(next);
async function publicUserView(user) {
  if (!user) return null;
  const [role] = await query('SELECT name,color,permissions FROM roles WHERE role_key=?', [user.role]);
  const permissions =
    user.is_primary_admin || user.role === 'administrator'
      ? [...rolePermissionsDefault]
      : Array.isArray(role?.permissions)
        ? role.permissions
        : json(role?.permissions) || [];
  return {
    ...userView(user),
    roleName: role?.name || user.role,
    roleColor: role?.color || '#64748b',
    permissions,
  };
}

async function getRoleCatalog() {
  const roles = await query(
    'SELECT role_key AS roleKey,name,color,permissions,is_system AS isSystem FROM roles ORDER BY is_system DESC,name',
  );
  return roles.map((role) =>
    role.roleKey === 'administrator'
      ? { ...role, permissions: [...rolePermissionsDefault], isSystem: true }
      : role,
  );
}
const languageKeys = async () => {
  const [row] = await query("SELECT setting_value FROM settings WHERE setting_key='languages'");
  return row ? json(row.setting_value) : ['en', 'es'];
};
const defaultLanguageCatalog = [
  { code: 'en', name: 'English', enabled: true },
  { code: 'es', name: 'Español', enabled: true },
  { code: 'de', name: 'Deutsch', enabled: false },
  { code: 'fr', name: 'Français', enabled: false },
  { code: 'pt-BR', name: 'Português (Brasil)', enabled: false },
];
const validLanguageCode = (code) =>
  typeof code === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(code);
const languageFile = (code) => path.join(__dirname, 'languages', 'language_' + code + '.json');
async function writeLanguageFile(entry, previousCode = '') {
  const destination = languageFile(entry.code);
  let data = null;
  for (const sourceCode of [previousCode, entry.code, 'en']) {
    if (!sourceCode) continue;
    try {
      data = JSON.parse(
        (await fs.promises.readFile(languageFile(sourceCode), 'utf8')).replace(/^\uFEFF/, ''),
      );
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  data._meta = { code: entry.code, name: entry.name, enabled: entry.enabled };
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + '.tmp-' + crypto.randomUUID();
  await fs.promises.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o640 });
  await fs.promises.rename(temporary, destination);
  return destination;
}

async function invalidateUserSessions(userId, exceptSessionId = null) {
  const candidates = await query('SELECT session_id,data FROM sessions WHERE data LIKE ?', [
    `%\"id\":${Number(userId)}%`,
  ]);
  for (const row of candidates) {
    try {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (row.session_id !== exceptSessionId &&
          (Number(data.user?.id) === Number(userId) || Number(data.pendingTwoFactor?.id) === Number(userId)))
        await query('DELETE FROM sessions WHERE session_id=?', [row.session_id]);
    } catch (error) {
      console.error('[Teralth Wiki] No se pudo invalidar una sesión:', error.code || error.name);
      throw error;
    }
  }
}
async function restoreExpiredTemporaryPassword(userId) {
  await query(
    'UPDATE users SET password_hash=COALESCE(previous_password_hash,password_hash),previous_password_hash=NULL,must_change_password=FALSE,temporary_password_expires_at=NULL WHERE id=? AND must_change_password=TRUE AND temporary_password_expires_at IS NOT NULL AND temporary_password_expires_at<=UTC_TIMESTAMP()',
    [userId],
  );
  await invalidateUserSessions(userId);
}
async function expireTemporaryPasswords() {
  const rows = await query(
    'SELECT id FROM users WHERE must_change_password=TRUE AND temporary_password_expires_at IS NOT NULL AND temporary_password_expires_at<=UTC_TIMESTAMP()',
  );
  for (const row of rows) {
    const [result] = await pool.execute(
      'UPDATE users SET password_hash=COALESCE(previous_password_hash,password_hash),previous_password_hash=NULL,must_change_password=FALSE,temporary_password_expires_at=NULL WHERE id=? AND must_change_password=TRUE AND temporary_password_expires_at<=UTC_TIMESTAMP()',
      [row.id],
    );
    if (result.affectedRows) await invalidateUserSessions(row.id);
  }
}
const baseUrl = (req, space = '') =>
  `${process.env.BASE_URL || `${req.protocol}://${req.get('host')}`}${space ? `/${encodeURIComponent(space)}` : ''}`;
const activeSpace = (req) => {
  const requested = req.get('x-wiki-space');
  if (requested && /^[A-Za-z0-9-]{1,100}$/.test(requested)) return requested;
  const first = req.path.split('/').filter(Boolean)[0];
  return ['api', 'login', 'register', 'reset', 'verify', 'admin'].includes(first)
    ? 'main'
    : spaceSlugify(first || 'main') || 'main';
};
class MySqlRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.windowMs = 60_000;
  }
  init(options) {
    this.windowMs = Number(options.windowMs) || this.windowMs;
  }
  bucket(key) {
    return crypto.createHash('sha256').update(`${this.prefix}:${key}`).digest('hex');
  }
  async increment(key) {
    const connection = await pool.getConnection(),
      now = Date.now(),
      resetAt = now + this.windowMs,
      bucket = this.bucket(key);
    try {
      await connection.execute(
        'INSERT INTO rate_limit_buckets (bucket_key,total_hits,reset_at) VALUES (?,LAST_INSERT_ID(1),?) ON DUPLICATE KEY UPDATE total_hits=IF(reset_at<=?,LAST_INSERT_ID(1),LAST_INSERT_ID(total_hits+1)),reset_at=IF(reset_at<=?,VALUES(reset_at),reset_at)',
        [bucket, resetAt, now, now],
      );
      const [rows] = await connection.query(
        'SELECT LAST_INSERT_ID() AS totalHits,reset_at FROM rate_limit_buckets WHERE bucket_key=?',
        [bucket],
      );
      return {
        totalHits: Number(rows[0]?.totalHits || 1),
        resetTime: new Date(Number(rows[0]?.reset_at || resetAt)),
      };
    } finally {
      connection.release();
    }
  }
  async decrement(key) {
    await pool.execute(
      'UPDATE rate_limit_buckets SET total_hits=GREATEST(total_hits-1,0) WHERE bucket_key=?',
      [this.bucket(key)],
    );
  }
  async resetKey(key) {
    await pool.execute('DELETE FROM rate_limit_buckets WHERE bucket_key=?', [this.bucket(key)]);
  }
}
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new MySqlRateLimitStore('auth'),
});
function loginAccountLimitKey(req) {
  const identifier = String(req.body?.email || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .slice(0, 254);
  return crypto.createHash('sha256').update(identifier).digest('hex');
}
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: loginAccountLimitKey,
  store: new MySqlRateLimitStore('auth-account'),
});
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.session.pendingTwoFactor?.id || req.session.user.id}`,
  store: new MySqlRateLimitStore('two-factor'),
  handler: (req, res) => res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' }),
});
const reactionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new MySqlRateLimitStore('reactions'),
});
const adminRecoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new MySqlRateLimitStore('admin-recovery'),
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new MySqlRateLimitStore('uploads'),
});
const backupImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 2,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new MySqlRateLimitStore('backup-import'),
});
const updateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 2,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.session.user.id}`,
  store: new MySqlRateLimitStore('site-update'),
  handler: (req, res) =>
    res.status(429).json({ error: 'Se alcanzó el límite de actualizaciones. Inténtalo más tarde.' }),
});
const backupExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new MySqlRateLimitStore('backup-export'),
});
const mail = async (to, subject, html) => {
  if (!mailer) throw new Error('SMTP no está configurado.');
  await mailer.sendMail({ from: smtpConfig.from, to, subject, html });
};
const jobEncryptionKey = () =>
  crypto
    .createHash('sha256')
    .update('teralth-jobs:' + process.env.SESSION_SECRET)
    .digest();
function encryptJobPayload(payload) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', jobEncryptionKey(), iv),
    encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}
function decryptJobPayload(value) {
  const [version, iv, tag, data] = String(value || '').split(':');
  if (version !== 'v1') throw new Error('JOB_PAYLOAD_INVALID');
  const decipher = crypto.createDecipheriv('aes-256-gcm', jobEncryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'),
  );
}
async function enqueueJob(type, payload = null, dedupeKey = null, executor = pool) {
  const encrypted = payload === null ? null : encryptJobPayload(payload);
  const [result] = await executor.execute(
    'INSERT IGNORE INTO background_jobs (job_type,dedupe_key,payload) VALUES (?,?,?)',
    [type, dedupeKey, encrypted],
  );
  return Number(result.affectedRows) > 0;
}
async function enqueueMail(to, subject, html, executor = pool) {
  if (!mailer) throw new Error('SMTP no está configurado.');
  return enqueueJob('mail', { to: String(to), subject: String(subject), html: String(html) }, null, executor);
}
const emailTemplate = (name, values) => {
  const html = fs.readFileSync(path.join(__dirname, 'emails', name), 'utf8');
  return html.replace(/\{\{([a-z_]+)\}\}/g, (placeholder, key) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key]).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      )
      : placeholder,
  );
};
async function notifySecurityChange(user, template, subject, req) {
  if (!mailer) {
    console.warn('[Teralth Wiki] Security notification not queued: SMTP is not configured.');
    return false;
  }
  try {
    const now = new Date();
    const date = new Intl.DateTimeFormat('es-EC', { dateStyle: 'long', timeZone: 'America/Guayaquil' }).format(now);
    const hour = new Intl.DateTimeFormat('es-EC', { timeStyle: 'short', timeZone: 'America/Guayaquil' }).format(now);
    await enqueueMail(user.email, subject, emailTemplate(template, {
      username: user.username, email: user.email, date, hour, ...(req ? loginDetails(req) : {}),
    }));
    return true;
  } catch (error) {
    console.error('[Teralth Wiki] Security notification could not be queued:', error.code || error.name || 'Error');
    return false;
  }
}
async function notifyPasswordReset(userId) {
  try {
    const [user] = await query('SELECT email,username FROM users WHERE id=?', [userId]);
    if (!user) throw new Error('USER_NOT_FOUND');
    return await notifySecurityChange(user, 'password_changed.html', 'Password updated');
  } catch (error) {
    console.error('[Teralth Wiki] Password change notification could not be queued:', error.code || error.name || 'Error');
    return false;
  }
}
const auth = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  next();
};

app.use('/api', async (req, res, next) => {
  if (!req.session.user) return next();
  try {
    const [current] = await query('SELECT two_factor_secret FROM users WHERE id=?', [req.session.user.id]);
    if (current && twoFactorSessionBinding(req.session.user.id, current.two_factor_secret) === (req.session.twoFactorBinding || null))
      return next();
    req.session.regenerate((error) => {
      if (error) return next(error);
      if (['/api/auth/me', '/api/config'].includes(req.originalUrl.split('?')[0])) return next();
      res.status(401).json({ error: 'La sesión expiró. Actualiza la página e inténtalo de nuevo.' });
    });
  } catch (error) { next(error); }
});
const mustRotate = async (req, res, next) => {
  try {
    if (!req.session.user?.mustChangePassword) return next();
    const [u] = await query(
      'SELECT must_change_password,(temporary_password_expires_at IS NOT NULL AND temporary_password_expires_at<=UTC_TIMESTAMP()) AS temporaryExpired FROM users WHERE id=?',
      [req.session.user.id],
    );
    if (u?.must_change_password && u.temporaryExpired) {
      await restoreExpiredTemporaryPassword(req.session.user.id);
      return req.session.destroy(() =>
        res
          .clearCookie('teralth.sid', {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
          })
          .status(401)
          .json({ error: 'La contraseña temporal venció. Se restauró la anterior; inicia sesión de nuevo.' }),
      );
    }
    if (
      u?.must_change_password &&
      !['/api/auth/password', '/api/auth/me', '/api/config'].includes(req.originalUrl.split('?')[0])
    )
      return res.status(428).json({ error: 'Cambia tu contraseña para continuar.' });
    next();
  } catch (e) {
    next(e);
  }
};
app.use('/api', mustRotate);
app.use('/api', (req, res, next) => {
  if (!req.session.pendingVerification) return next();
  const allowed = ['/api/auth/me', '/api/config', '/api/auth/verify', '/api/auth/resend-verification', '/api/auth/logout'];
  if (allowed.includes(req.originalUrl.split('?')[0])) return next();
  res.status(403).json({ error: 'Primero debes verificar tu cuenta.' });
});
app.use('/api', (req, res, next) => {
  if (!req.session.pendingTwoFactor) return next();
  const allowed = ['/api/auth/me', '/api/config', '/api/auth/two-factor/verify', '/api/auth/logout'];
  if (allowed.includes(req.originalUrl.split('?')[0])) return next();
  res.status(403).json({ error: 'Primero debes verificar tu código 2FA.' });
});
app.use(
  '/api/admin',
  requireCurrentAdminSession(async (userId) => {
    const [user] = await query('SELECT must_change_password FROM users WHERE id=?', [userId]);
    return user;
  }),
);

async function initialize() {
  await store.onReady();
  await repairMissingTables(true);
  const [proxySetting] = await query("SELECT setting_value FROM settings WHERE setting_key='reverse_proxy'");
  if (proxySetting) applyReverseProxyTrust(validateReverseProxy(json(proxySetting.setting_value)));
  const [savedSmtp] = await query("SELECT setting_value FROM settings WHERE setting_key='smtp'");
  if (savedSmtp) {
    const stored = json(savedSmtp.setting_value);
    smtpConfig = {
      host: String(stored.host || ''),
      port: Number(stored.port || 587),
      secure: stored.secure === true,
      user: String(stored.user || ''),
      password: stored.passwordEncrypted ? decryptSmtpPassword(stored.passwordEncrypted) : '',
      from: String(stored.from || ''),
    };
    mailer = buildMailer(smtpConfig);
  }
  const [savedBackups] = await query(
    "SELECT setting_value FROM settings WHERE setting_key='backup_settings'",
  );
  if (savedBackups) {
    try {
      const preferences = json(savedBackups.setting_value);
      backupCronExpression = validateBackupCron(preferences.cron);
      backupTimeZone = validateTimeZone(preferences.timeZone || DEFAULT_TIME_ZONE);
      const retention = Number(preferences.retention);
      if (Number.isInteger(retention) && retention >= 1 && retention <= 30) backupRetentionCount = retention;
    } catch {
      console.error(
        '[Teralth Wiki] Configuración CRON de backups inválida; se usará el valor predeterminado.',
      );
    }
  }
  await query("INSERT IGNORE INTO spaces (slug,name,icon,sort_order) VALUES ('main',?,'fa-book-open',0)", [
    process.env.SITE_NAME || 'Teralth Wiki',
  ]);
  await query(
    "INSERT IGNORE INTO roles (role_key,name,color,permissions,is_system) VALUES ('administrator','Administrator','#5865f2',?,TRUE),('user','User','#64748b',JSON_ARRAY(),TRUE)",
    [JSON.stringify(rolePermissionsDefault)],
  );
  await query("UPDATE roles SET permissions=? WHERE role_key='administrator' AND is_system=TRUE", [
    JSON.stringify(rolePermissionsDefault),
  ]);
  await migrateSitePermissions(pool);
  await query("UPDATE users SET role='administrator' WHERE role='admin'");
  await query("DELETE FROM roles WHERE role_key='admin' AND is_system=TRUE");
  const existing = await query('SELECT id FROM users WHERE username = ? LIMIT 1', [
    process.env.ADMIN_USERNAME || 'admin',
  ]);
  if (!existing.length) {
    const initialPassword = String(process.env.ADMIN_INITIAL_PASSWORD || '');
    if (
      Buffer.byteLength(initialPassword, 'utf8') < 16 ||
      Buffer.byteLength(initialPassword, 'utf8') > 72 ||
      !/[A-Z]/.test(initialPassword) ||
      !/[a-z]/.test(initialPassword) ||
      !/[0-9]/.test(initialPassword) ||
      !/[^A-Za-z0-9]/.test(initialPassword)
    )
      throw new Error(
        'ADMIN_INITIAL_PASSWORD debe tener 16 a 72 bytes e incluir mayúscula, minúscula, número y símbolo.',
      );
    const passwordHash = await bcrypt.hash(process.env.ADMIN_INITIAL_PASSWORD, 12);
    await query(
      "INSERT INTO users (email,username,password_hash,role,verified_at,must_change_password,is_primary_admin) VALUES (?,?,?,'administrator',NOW(),TRUE,TRUE)",
      [process.env.ADMIN_EMAIL || 'admin@example.com', process.env.ADMIN_USERNAME || 'admin', passwordHash],
    );
  }
  await query(
    "UPDATE users SET role='administrator',is_primary_admin=TRUE WHERE username=? AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM users WHERE is_primary_admin=TRUE) AS primary_admin)",
    [process.env.ADMIN_USERNAME || 'admin'],
  );
  const pages = await query("SELECT id FROM pages WHERE space_slug='main' AND slug='inicio' LIMIT 1");
  if (!pages.length)
    await query(
      "INSERT INTO pages (space_slug,slug,icon,titles,content) VALUES ('main','inicio','fa-house',?,?)",
      [
        JSON.stringify({ es: 'Inicio', en: 'Home' }),
        JSON.stringify({
          es: '<h1>Bienvenido a tu wiki</h1><p>Este espacio está listo para documentar tus proyectos. Selecciona una sección a la izquierda o inicia sesión para editar.</p><h2>Primeros pasos</h2><p>Desde el panel de administración podrás crear páginas, traducir el contenido y configurar los espacios de documentación.</p>',
          en: '<h1>Welcome to your wiki</h1><p>This space is ready for your project documentation. Choose a section on the left or sign in to edit.</p><h2>Getting started</h2><p>Use the administration panel to create pages, translate content, and configure documentation spaces.</p>',
        }),
      ],
    );
  await query("UPDATE spaces SET home_page_slug='inicio' WHERE slug='main' AND home_page_slug IS NULL");
  await query(
    "INSERT IGNORE INTO settings (setting_key,setting_value) VALUES ('languages',JSON_ARRAY('en','es')),('site',JSON_OBJECT('name',?,'logo',?,'favicon',?)),('registration_enabled',FALSE)",
    [
      process.env.SITE_NAME || 'Teralth Wiki',
      /^\/media\/[A-Za-z0-9_-]{16}\.webp$/.test(process.env.SITE_LOGO || '') ? process.env.SITE_LOGO : '',
      /^\/media\/[A-Za-z0-9_-]{16}\.webp$/.test(process.env.SITE_FAVICON || '')
        ? process.env.SITE_FAVICON : '/assets/favicon.svg',
    ],
  );
  const [catalogRow] = await query("SELECT setting_value FROM settings WHERE setting_key='language_catalog'");
  if (!catalogRow) {
    const previousLanguages = new Set(await languageKeys());
    const known = new Set(defaultLanguageCatalog.map((item) => item.code.toLowerCase()));
    const catalog = [
      ...defaultLanguageCatalog.map((item) => ({
        ...item,
        enabled: item.code === 'en' || item.code === 'es' || previousLanguages.has(item.code),
      })),
      ...Array.from(previousLanguages)
        .filter((code) => !known.has(String(code).toLowerCase()))
        .map((code) => ({ code, name: code, enabled: true })),
    ];
    const active = catalog.filter((item) => item.enabled).map((item) => item.code);
    await query(
      "INSERT INTO settings (setting_key,setting_value) VALUES ('language_catalog',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
      [JSON.stringify(catalog)],
    );
    await query(
      "INSERT INTO settings (setting_key,setting_value) VALUES ('languages',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
      [JSON.stringify(active)],
    );
  }
  const [languageCatalogRow] = await query(
    "SELECT setting_value FROM settings WHERE setting_key='language_catalog'",
  );
  for (const entry of json(languageCatalogRow.setting_value)) await writeLanguageFile(entry);
}

const backupRoot = path.join(__dirname, 'backup');
let backupTimeZone = DEFAULT_TIME_ZONE,
  backupCronExpression = '0 2 * * *',
  backupRetentionCount = 5,
  backupScheduleTimer = null;
function zoneParts(date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: backupTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}
function backupName(date) {
  const parts = zoneParts(date),
    zoneTag = backupTimeZone.replaceAll('/', '-').replace(/[^A-Za-z0-9_-]/g, '_');
  return `teralth-studio_${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}_${zoneTag}`;
}
async function secureBackupTree(directory) {
  await fs.promises.chmod(directory, 0o700).catch(() => {});
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await secureBackupTree(file);
    else await fs.promises.chmod(file, 0o600).catch(() => {});
  }
}
function isInsideBackup(target) {
  const resolved = path.resolve(target),
    base = path.resolve(backupRoot) + path.sep;
  return resolved.startsWith(base);
}
async function pruneBackups() {
  await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const entry of await fs.promises.readdir(backupRoot, { withFileTypes: true })) {
    const target = path.join(backupRoot, entry.name);
    if (!isInsideBackup(target)) continue;
    const stats = await fs.promises.stat(target);
    if (/^\.(?:partial-|restore-|upload-)/.test(entry.name) && stats.mtimeMs < Date.now() - 86400000) {
      await fs.promises.rm(target, { recursive: true, force: true });
      continue;
    }
    if (
      !entry.isDirectory() ||
      !/^teralth-studio_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[A-Za-z0-9_-]{1,100}$/.test(entry.name)
    )
      continue;
    entries.push({ target, mtime: stats.mtimeMs });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const old of entries.slice(backupRetentionCount))
    if (isInsideBackup(old.target)) await fs.promises.rm(old.target, { recursive: true, force: true });
}
async function createBackup(onProgress = () => {}) {
  await repairMissingTables();
  await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const now = new Date(),
    name = backupName(now),
    finalPath = path.join(backupRoot, name),
    workingPath = path.join(backupRoot, `.partial-${crypto.randomUUID()}`);
  await fs.promises.mkdir(workingPath, { mode: 0o700 });
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction();
    const [tables] = await connection.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
    );
    const database = {
      database: process.env.DB_NAME,
      createdAt: now.toISOString(),
      timezone: backupTimeZone,
      tables: {},
    };
    const volatileTables = new Set(['sessions', 'account_tokens', 'rate_limit_buckets', 'background_jobs']);
    const persistentTables = tables.filter((row) => !volatileTables.has(row.TABLE_NAME));
    for (const [index, row] of persistentTables.entries()) {
      const tableName = row.TABLE_NAME;
      const [rows] = await connection.query('SELECT * FROM ??', [tableName]);
      database.tables[tableName] = rows;
      onProgress(Math.floor(((index + 1) / Math.max(persistentTables.length, 1)) * 45));
    }
    await connection.commit();
    const appDir = path.join(workingPath, 'application');
    await fs.promises.mkdir(appDir, { recursive: true, mode: 0o700 });
    const applicationItems = [
      'launcher.js',
      'server.js',
      'schema.sql',
      'package.json',
      'package-lock.json',
      '.env.example',
      'public',
      'scripts',
      'emails',
      'languages',
    ];
    for (const [index, item] of applicationItems.entries()) {
      const source = path.join(__dirname, item);
      try {
        await fs.promises.access(source);
        await fs.promises.cp(source, path.join(appDir, item), { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      onProgress(45 + Math.floor(((index + 1) / applicationItems.length) * 40));
    }
    const uploads = path.join(__dirname, 'images');
    try {
      await fs.promises.access(uploads);
      await fs.promises.cp(uploads, path.join(appDir, 'images'), { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    onProgress(90);
    const legacyUploads = path.resolve(__dirname, process.env.DATA_DIR || 'data', 'uploads');
    try {
      await fs.promises.access(legacyUploads);
      await fs.promises.mkdir(path.join(appDir, 'data'), { recursive: true });
      await fs.promises.cp(legacyUploads, path.join(appDir, 'data', 'uploads'), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    onProgress(95);
    await fs.promises.writeFile(
      path.join(workingPath, 'database.json.enc'),
      encryptBackupDatabase(
        JSON.stringify(database),
        process.env.BACKUP_ENCRYPTION_KEY || process.env.SESSION_SECRET,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    await secureBackupTree(workingPath);
    await fs.promises.rename(workingPath, finalPath);
    await pruneBackups();
    onProgress(100);
    return { name, path: finalPath };
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (isInsideBackup(workingPath))
      await fs.promises.rm(workingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
let jobWorkerBusy = false,
  lastJobPruneAt = 0;
async function pumpBackgroundJobs() {
  if (jobWorkerBusy) return;
  jobWorkerBusy = true;
  let job = null,
    leaseTimer = null;
  const lockToken = crypto.randomUUID();
  try {
    const [claim] = await pool.execute(
      "UPDATE background_jobs SET status='processing',lock_token=?,locked_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 90 SECOND),attempts=attempts+1 WHERE available_at<=UTC_TIMESTAMP() AND (status='queued' OR (status='processing' AND locked_until<=UTC_TIMESTAMP())) ORDER BY id LIMIT 1",
      [lockToken],
    );
    if (!claim.affectedRows) return;
    const [claimedJob] = await query(
      "SELECT id,job_type,payload,attempts FROM background_jobs WHERE lock_token=? AND status='processing' LIMIT 1",
      [lockToken],
    );
    job = claimedJob;
    if (!job) throw new Error('CLAIMED_JOB_NOT_FOUND');
    leaseTimer = setInterval(
      () =>
        pool
          .execute(
            "UPDATE background_jobs SET locked_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 90 SECOND) WHERE id=? AND lock_token=? AND status='processing'",
            [job.id, lockToken],
          )
          .catch((error) =>
            console.error('No se pudo renovar el lease de la tarea:', error.code || error.name || 'Error'),
          ),
      30_000,
    );
    leaseTimer.unref();
    if (job.job_type === 'mail') {
      const message = decryptJobPayload(job.payload);
      if (!mailer) throw new Error('SMTP_UNAVAILABLE');
      await mail(message.to, message.subject, message.html);
    } else if (job.job_type === 'backup') {
      const result = await createBackup();
      console.log(`Backup creado exitosamente: ${result.name}`);
    } else throw new Error('JOB_TYPE_UNSUPPORTED');
    await pool.execute(
      "UPDATE background_jobs SET status='done',payload=NULL,locked_until=NULL,lock_token=NULL,last_error=NULL,completed_at=UTC_TIMESTAMP() WHERE id=? AND lock_token=?",
      [job.id, lockToken],
    );
  } catch (error) {
    if (job) {
      const attempts = Number(job.attempts) || 1,
        terminal = attempts >= 5,
        delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
      await pool
        .execute(
          'UPDATE background_jobs SET status=?,payload=IF(?,NULL,payload),available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),locked_until=NULL,lock_token=NULL,last_error=? WHERE id=? AND lock_token=?',
          [
            terminal ? 'failed' : 'queued',
            terminal,
            delaySeconds,
            String(error.code || error.name || 'JOB_FAILED').slice(0, 120),
            job.id,
            lockToken,
          ],
        )
        .catch((updateError) =>
          console.error('No se pudo reprogramar una tarea:', updateError.code || updateError.name || 'Error'),
        );
      console.error(
        '[Teralth Wiki] Background job failed',
        JSON.stringify({
          id: job.id,
          type: job.job_type,
          attempt: attempts,
          error: error.code || error.name || 'JOB_FAILED',
        }),
      );
    } else console.error('[Teralth Wiki] Background job claim failed:', error.code || error.message || 'JOB_FAILED');
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    jobWorkerBusy = false;
    if (Date.now() - lastJobPruneAt > 86_400_000) {
      lastJobPruneAt = Date.now();
      query(
        "DELETE FROM background_jobs WHERE status IN ('done','failed') AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)",
      ).catch((error) =>
        console.error('No se pudo limpiar la cola de tareas:', error.code || error.name || 'Error'),
      );
    }
  }
}
function startBackgroundJobWorker() {
  pumpBackgroundJobs().catch((error) =>
    console.error('No se pudo iniciar la cola de tareas:', error.code || error.name || 'Error'),
  );
  const timer = setInterval(
    () =>
      pumpBackgroundJobs().catch((error) =>
        console.error('Error en la cola de tareas:', error.code || error.name || 'Error'),
      ),
    2000,
  );
  timer.unref();
}
function scheduleBackupJob() {
  if (backupScheduleTimer) clearTimeout(backupScheduleTimer);
  const next = nextCronDate(backupCronExpression, new Date(), backupTimeZone),
    delay = Math.max(1000, Math.min(2_147_000_000, next.getTime() - Date.now())),
    timer = setTimeout(async () => {
      try {
        const [pending] = await query(
          "SELECT id FROM background_jobs WHERE job_type='backup' AND status IN ('queued','processing') LIMIT 1",
        );
        if (!pending) {
          const created = await enqueueJob('backup', null, 'scheduled-backup:' + next.toISOString());
          if (created) console.log('Backup programado añadido a la cola.');
        }
      } catch (error) {
        console.error('No se pudo añadir el backup a la cola:', error.code || error.name || 'Error');
      }
      scheduleBackupJob();
    }, delay);
  backupScheduleTimer = timer;
  timer.unref();
}

const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => {
      fs.promises
        .mkdir(backupRoot, { recursive: true, mode: 0o700 })
        .then(() => callback(null, backupRoot), callback);
    },
    filename: (req, file, callback) => callback(null, '.upload-' + crypto.randomUUID() + '.zip'),
  }),
  limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!/\.zip$/i.test(file.originalname || ''))
      return callback(Object.assign(new Error('BACKUP_ZIP_REQUIRED'), { status: 400 }));
    if (
      !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.mimetype)
    )
      return callback(Object.assign(new Error('BACKUP_ZIP_REQUIRED'), { status: 400 }));
    callback(null, true);
  },
});
const updateUploadRoot = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'), 'updates');
const updateUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) =>
      fs.promises
        .mkdir(updateUploadRoot, { recursive: true, mode: 0o700 })
        .then(() => callback(null, updateUploadRoot), callback),
    filename: (req, file, callback) => callback(null, 'package-' + crypto.randomUUID() + '.zip'),
  }),
  limits: { fileSize: 64 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!/\.zip$/i.test(file.originalname || ''))
      return callback(new UpdateError('Selecciona un paquete .zip válido.'));
    if (
      file.mimetype &&
      !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.mimetype)
    )
      return callback(new UpdateError('Selecciona un paquete .zip válido.'));
    callback(null, true);
  },
});
const backupPersistentTables = ['users', 'spaces', 'categories', 'pages', 'settings', 'reactions', 'roles'];
async function listBackups() {
  await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const rows = [];
  for (const entry of await fs.promises.readdir(backupRoot, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^teralth-studio_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[A-Za-z0-9_-]{1,100}$/.test(entry.name)
    )
      continue;
    const stat = await fs.promises.stat(path.join(backupRoot, entry.name));
    rows.push({ name: entry.name, createdAt: stat.mtime.toISOString() });
  }
  rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return rows.slice(0, backupRetentionCount);
}
async function restoreDatabaseSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !snapshot.tables ||
    typeof snapshot.tables !== 'object' ||
    Array.isArray(snapshot.tables) ||
    !Number.isFinite(Date.parse(snapshot.createdAt || ''))
  )
    throw new Error('BACKUP_DATABASE_INVALID');
  for (const table of backupPersistentTables)
    if (!Array.isArray(snapshot.tables[table])) throw new Error('BACKUP_DATABASE_INVALID');
  let rowsTotal = 0;
  for (const table of backupPersistentTables) {
    const rows = snapshot.tables[table];
    rowsTotal += rows.length;
    if (
      rows.length > 500000 ||
      rowsTotal > 1_000_000 ||
      rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    )
      throw new Error('BACKUP_DATABASE_INVALID');
  }
  const primaryAdmins = snapshot.tables.users.filter((user) => Boolean(Number(user.is_primary_admin)));
  if (
    !snapshot.tables.spaces.some((space) => space.slug === 'main') ||
    !snapshot.tables.roles.some(
      (role) => role.role_key === 'administrator' && Boolean(Number(role.is_system)),
    ) ||
    primaryAdmins.length !== 1 ||
    primaryAdmins[0].role !== 'administrator'
  )
    throw new Error('BACKUP_PRIMARY_ADMIN_INVALID');
  await repairMissingTables();
  const connection = await pool.getConnection();
  let transaction = false;
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    await connection.beginTransaction();
    transaction = true;
    const columnsByTable = new Map();
    for (const table of backupPersistentTables) {
      const [columns] = await connection.execute(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
        [table],
      );
      const names = new Set(columns.map((item) => item.COLUMN_NAME));
      if (!names.size) throw new Error('BACKUP_SCHEMA_MISMATCH');
      columnsByTable.set(table, names);
    }
    for (const table of ['reactions', 'pages', 'categories', 'spaces', 'users', 'roles', 'settings'])
      await connection.query('DELETE FROM ??', [table]);
    for (const table of backupPersistentTables) {
      const allowed = columnsByTable.get(table),
        records = snapshot.tables[table];
      for (let offset = 0; offset < records.length; offset += 200) {
        const batch = records
          .slice(offset, offset + 200)
          .map((record) =>
            Object.fromEntries(Object.entries(record).filter(([column]) => allowed.has(column))),
          );
        if (batch.some((record) => !Object.keys(record).length)) throw new Error('BACKUP_SCHEMA_MISMATCH');
        const columns = [...new Set(batch.flatMap((record) => Object.keys(record)))],
          quotedTable = connection.escapeId(table),
          quotedColumns = columns.map((column) => connection.escapeId(column)).join(','),
          rowPlaceholder = '(' + columns.map(() => '?').join(',') + ')',
          placeholders = batch.map(() => rowPlaceholder).join(','),
          values = batch.flatMap((record) =>
            columns.map((column) =>
              Object.prototype.hasOwnProperty.call(record, column) ? record[column] : null,
            ),
          );
        await connection.execute(
          'INSERT INTO ' + quotedTable + ' (' + quotedColumns + ') VALUES ' + placeholders,
          values,
        );
      }
    }
    for (const table of ['sessions', 'account_tokens', 'rate_limit_buckets', 'background_jobs'])
      await connection.query('DELETE FROM ??', [table]);
    await connection.commit();
    transaction = false;
  } catch (error) {
    if (transaction) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS=1').catch(() => {});
    connection.release();
  }
}
async function validateStagedBackupImages(directory) {
  const files = await fs.promises.readdir(directory);
  for (const filename of files) {
    if (!/^[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/i.test(filename)) throw new Error('BACKUP_IMAGE_INVALID');
    const imagePath = path.join(directory, filename),
      metadata = await sharp(imagePath, { animated: true, limitInputPixels: 16_000_000 }).metadata(),
      expected = { jpg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' }[
        filename.split('.').pop().toLowerCase()
      ];
    if (
      metadata.format !== expected ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 16_000_000
    )
      throw new Error('BACKUP_IMAGE_INVALID');
  }
}
async function applyStagedBackupImages(directory) {
  const destination = path.join(__dirname, 'images');
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o750 });
  for (const filename of await fs.promises.readdir(directory)) {
    const target = path.join(destination, filename);
    await fs.promises.copyFile(path.join(directory, filename), target);
    await fs.promises.chmod(target, 0o640).catch(() => {});
    const cached = path.resolve(__dirname, process.env.DATA_DIR || 'data', 'media-cache', filename + '.webp');
    await fs.promises.unlink(cached).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
app.get('/api/config', async (req, res, next) => {
  try {
    const settings = await query(
        "SELECT setting_key,setting_value FROM settings WHERE setting_key IN ('site','languages','language_catalog','registration_enabled','captcha_settings','header_links')",
      ),
      spaces = await query('SELECT slug,name,icon,logo FROM spaces ORDER BY sort_order,name'),
      registration = settings.find((item) => item.setting_key === 'registration_enabled'),
      languageCatalogRow = settings.find((item) => item.setting_key === 'language_catalog'),
      headerLinksRow = settings.find((item) => item.setting_key === 'header_links'),
      siteRow = settings.find((item) => item.setting_key === 'site'),
      languages = settings.find((item) => item.setting_key === 'languages')
        ? json(settings.find((item) => item.setting_key === 'languages').setting_value)
        : ['en', 'es'],
      storedSite = siteRow ? json(siteRow.setting_value) : {},
      site = {
        ...storedSite,
        name: String(storedSite.name || process.env.SITE_NAME || 'Teralth Wiki'),
        pageTitle: String(storedSite.name || storedSite.pageTitle || process.env.SITE_NAME || 'Teralth Wiki'),
        favicon: String(storedSite.favicon || '/assets/favicon.svg'),
        supportUrl: storedSite.supportUrl || process.env.SUPPORT_URL || '',
        sidebarLabel: storedSite.sidebarLabel || 'Documentation',
      },
      languageCatalog = languageCatalogRow ? json(languageCatalogRow.setting_value) : defaultLanguageCatalog;
    res.json({
      site,
      languages,
      languageCatalog,
      headerLinks: headerLinksRow
        ? normalizeHeaderLinks(json(headerLinksRow.setting_value), languages)
        : [],
      spaces,
      registrationEnabled: registration ? Boolean(json(registration.setting_value)) : false,
      captcha: publicCaptchaConfig(
        settings.find((item) => item.setting_key === 'captcha_settings')
          ? json(settings.find((item) => item.setting_key === 'captcha_settings').setting_value)
          : {},
      ),
    });
  } catch (error) {
    next(error);
  }
});
app.get('/api/admin/captcha', auth, requirePermission('captcha.configure'), async (req, res, next) => {
  try {
    const config = await loadCaptchaConfig();
    res
      .set('Cache-Control', 'private, no-store')
      .json({
        captcha: {
          ...publicCaptchaConfig({ ...config, enabled: false }),
          enabled: config.enabled === true,
          provider: String(config.provider || ''),
          variant: String(config.variant || ''),
          siteKey: String(config.siteKey || ''),
          minScore: Number(config.minScore) || 0.5,
          secretConfigured: Boolean(config.secretCiphertext),
        },
      });
  } catch (error) {
    next(error);
  }
});
app.put('/api/admin/captcha', auth, requirePermission('captcha.configure'), async (req, res, next) => {
  try {
    const enabled = req.body.enabled,
      provider = String(req.body.provider || ''),
      variant = String(req.body.variant || ''),
      siteKey = String(req.body.siteKey || '').trim(),
      secret = String(req.body.secret || ''),
      clearSecret = req.body.clearSecret === true,
      minScore = Number(req.body.minScore ?? 0.5);
    if (
      typeof enabled !== 'boolean' ||
      !captchaVariants[provider]?.has(variant) ||
      siteKey.length > 512 ||
      !Number.isFinite(minScore) ||
      minScore < 0.1 ||
      minScore > 0.9 ||
      secret.length > 2048
    )
      return res.status(400).json({ error: 'Revisa proveedor, versión, claves y umbral de verificación.' });
    const previous = await loadCaptchaConfig(),
      secretCiphertext = secret
        ? encryptCaptchaSecret(secret)
        : clearSecret
          ? ''
          : String(previous.secretCiphertext || '');
    if (enabled && (!/^[A-Za-z0-9._-]{8,512}$/.test(siteKey) || !secretCiphertext))
      return res
        .status(400)
        .json({ error: 'Para activar CAPTCHA se requiere una clave del sitio y un secreto válidos.' });
    const config = { enabled, provider, variant, siteKey, secretCiphertext, minScore };
    await query(
      "INSERT INTO settings (setting_key,setting_value) VALUES ('captcha_settings',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
      [JSON.stringify(config)],
    );
    res
      .set('Cache-Control', 'private, no-store')
      .json({
        ok: true,
        captcha: { ...publicCaptchaConfig(config), secretConfigured: Boolean(secretCiphertext) },
      });
  } catch (error) {
    next(error);
  }
});
app.put(
  '/api/admin/settings/registration',
  auth,
  requirePermission('users.registration'),
  async (req, res, next) => {
    try {
      if (typeof req.body.enabled !== 'boolean')
        return res.status(400).json({ error: 'Selecciona si los registros están habilitados.' });
      await query(
        "INSERT INTO settings (setting_key,setting_value) VALUES ('registration_enabled',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
        [JSON.stringify(req.body.enabled)],
      );
      res.json({ ok: true, registrationEnabled: req.body.enabled });
    } catch (e) {
      next(e);
    }
  },
);
const clientLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.post('/api/client-log', clientLogLimiter, (req, res) => {
  const clean = (value, max) =>
    String(value ?? '')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, max);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  console.error(
    '[Teralth Wiki] Browser error',
    JSON.stringify({
      source: clean(body.source, 60),
      message: clean(body.message, 500),
      status: Number.isInteger(body.status) ? body.status : undefined,
      method: clean(body.method, 10),
      path: clean(body.path, 200),
      page: clean(body.page, 200),
      file: clean(body.filename, 200),
      line: Number.isInteger(body.line) ? body.line : undefined,
      column: Number.isInteger(body.column) ? body.column : undefined,
      stack: clean(body.stack, 2000),
    }),
  );
  res.sendStatus(204);
});
app.get('/api/auth/me', async (req, res, next) => {
  try {
    if (!req.session.csrfToken) req.session.csrfToken = token();
    const [current] = req.session.user
      ? await query(
          'SELECT id,email,username,role,is_primary_admin,must_change_password,two_factor_secret FROM users WHERE id=?',
          [req.session.user.id],
        )
      : [null];
    if (current) req.session.user = { ...req.session.user, ...userView(current) };
    const [pending] = req.session.pendingVerification
      ? await query('SELECT email,verified_at FROM users WHERE id=?', [req.session.pendingVerification])
      : [null];
    if (req.session.pendingVerification && (!pending || pending.verified_at)) delete req.session.pendingVerification;
    res.json({
      user: await publicUserView(current),
      pendingVerification: pending && !pending.verified_at ? { email: pending.email } : null,
      pendingTwoFactor: !!req.session.pendingTwoFactor,
      csrfToken: req.session.csrfToken,
    });
  } catch (error) {
    next(error);
  }
});
app.post('/api/auth/register', loginLimiter, async (req, res, next) => {
  let conn;
  try {
    const captchaValid = await verifyCaptcha(req, 'register');
    if (!captchaValid)
      return res.status(400).json({ error: 'Completa la verificación CAPTCHA e inténtalo de nuevo.' });
    const registrationSetting = await query(
      "SELECT setting_value FROM settings WHERE setting_key='registration_enabled' LIMIT 1",
    );
    if (!registrationSetting[0] || !Boolean(json(registrationSetting[0].setting_value)))
      return res.status(403).json({ error: 'Los registros públicos están deshabilitados.' });
    if (!mailer)
      return res
        .status(503)
        .json({ error: 'El registro estará disponible cuando se configure el servidor SMTP.' });
    const email = String(req.body.email || '')
        .trim()
        .toLowerCase(),
      username = String(req.body.username || '').trim(),
      password = String(req.body.password || '');
    if (
      !/^\S+@\S+\.\S+$/.test(email) ||
      email.length > 254 ||
      !/^[\p{L}\p{N}_-]{2,60}$/u.test(username) ||
      password.length < 8 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[!@#$%^&*(),.?":{}|<>_+\-=\[\]\\/]/.test(password)
    )
      return res
        .status(400)
        .json({ error: 'Revisa el correo, nombre de usuario y requisitos de contraseña.' });
    const dup = await query('SELECT id FROM users WHERE email=? OR username=? LIMIT 1', [email, username]);
    if (dup.length)
      return res.status(409).json({ error: 'Ese correo o nombre de usuario ya está registrado.' });
    const passwordHash = await bcrypt.hash(password, 12);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const result = await conn.execute('INSERT INTO users (email,username,password_hash) VALUES (?,?,?)', [
      email,
      username,
      passwordHash,
    ]);
    const userId = result[0].insertId,
      raw = token();
    await conn.execute(
      "INSERT INTO account_tokens (user_id,token_hash,purpose,expires_at) VALUES (?,?,'verify',DATE_ADD(NOW(),INTERVAL 24 HOUR))",
      [userId, hash(raw)],
    );
    const now = new Date(),
      date = new Intl.DateTimeFormat('es-EC', { dateStyle: 'long', timeZone: 'America/Guayaquil' }).format(
        now,
      ),
      hour = new Intl.DateTimeFormat('es-EC', { timeStyle: 'short', timeZone: 'America/Guayaquil' }).format(
        now,
      );
    await enqueueMail(
        email,
        'Confirm your account',
        emailTemplate('register.html', {
          username,
          email,
          date,
          hour,
          verify_link: `${baseUrl(req)}/verify?token=${encodeURIComponent(raw)}`,
        }),
        conn,
      );
    await conn.commit();
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.pendingVerification = userId;
    req.session.csrfToken = token();
    req.session.save((error) => error ? next(error) : res.status(202).json({
      pendingVerification: { email },
      csrfToken: req.session.csrfToken,
    }));
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    if (e.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'Ese correo o nombre de usuario ya está registrado.' });
    next(e);
  } finally {
    conn?.release();
  }
});
app.post('/api/auth/resend-verification', loginLimiter, async (req, res, next) => {
  let conn;
  try {
    if (!req.session.pendingVerification)
      return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    if (!(await verifyCaptcha(req, 'verify')))
      return res.status(400).json({ error: 'Completa la verificación CAPTCHA e inténtalo de nuevo.' });
    if (!mailer) throw new Error('SMTP no está configurado.');
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT id,email,username,verified_at FROM users WHERE id=? FOR UPDATE', [req.session.pendingVerification]);
    const user = rows[0];
    if (!user || user.verified_at) {
      await conn.rollback();
      return res.status(400).json({ error: 'La cuenta ya está verificada o no existe.' });
    }
    const raw = token(), now = new Date();
    await conn.execute("UPDATE account_tokens SET used_at=NOW() WHERE user_id=? AND purpose='verify' AND used_at IS NULL", [user.id]);
    await conn.execute("INSERT INTO account_tokens (user_id,token_hash,purpose,expires_at) VALUES (?,?,'verify',DATE_ADD(NOW(),INTERVAL 24 HOUR))", [user.id, hash(raw)]);
    await enqueueMail(user.email, 'Confirm your account', emailTemplate('register.html', {
      username: user.username, email: user.email,
      date: new Intl.DateTimeFormat('es-EC', { dateStyle: 'long', timeZone: 'America/Guayaquil' }).format(now),
      hour: new Intl.DateTimeFormat('es-EC', { timeStyle: 'short', timeZone: 'America/Guayaquil' }).format(now),
      verify_link: `${baseUrl(req)}/verify?token=${encodeURIComponent(raw)}`,
    }), conn);
    await conn.commit();
    res.json({ ok: true });
  } catch (error) {
    if (conn) await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn?.release();
  }
});
function notifySuccessfulLogin(u, req) {
  if (!mailer) return;
  try {
    const now = new Date();
    const date = new Intl.DateTimeFormat('es-EC', { dateStyle: 'long', timeZone: 'America/Guayaquil' }).format(now);
    const hour = new Intl.DateTimeFormat('es-EC', { timeStyle: 'short', timeZone: 'America/Guayaquil' }).format(now);
    enqueueMail(u.email, 'New sign-in', emailTemplate('login_success.html', {
      username: u.username, email: u.email, date, hour, ...loginDetails(req),
    })).catch((error) =>
      console.error('No se pudo encolar el aviso de inicio de sesión:', error.code || error.name || 'Error'),
    );
  } catch (error) {
    console.error('No se pudo preparar el aviso de inicio de sesión:', error.code || error.name || 'Error');
  }
}
app.post('/api/auth/login', loginLimiter, loginAccountLimiter, async (req, res, next) => {
  try {
    const captchaValid = await verifyCaptcha(req, 'login');
    if (!captchaValid)
      return res.status(400).json({ error: 'Completa la verificación CAPTCHA e inténtalo de nuevo.' });
    const identifier = String(req.body.email || '')
        .trim()
        .toLowerCase(),
      password = String(req.body.password || '');
    let rows =
      identifier.length <= 254
        ? await query(
            'SELECT id,email,username,password_hash,role,is_primary_admin,verified_at,must_change_password,previous_password_hash,temporary_password_expires_at,two_factor_secret,(must_change_password=1 AND temporary_password_expires_at IS NOT NULL AND temporary_password_expires_at<=UTC_TIMESTAMP()) AS temporaryExpired FROM users WHERE email=? OR username=? LIMIT 1',
            [identifier, identifier],
          )
        : [];
    let u = rows[0];
    if (u?.temporaryExpired) {
      await restoreExpiredTemporaryPassword(u.id);
      rows = await query(
        'SELECT id,email,username,password_hash,role,is_primary_admin,verified_at,must_change_password,previous_password_hash,temporary_password_expires_at,two_factor_secret FROM users WHERE id=?',
        [u.id],
      );
      u = rows[0];
    }
    const passwordWithinLimit = Buffer.byteLength(password, 'utf8') <= 72,
      validPassword = await bcrypt.compare(
        passwordWithinLimit ? password : 'oversized-password-input',
        u?.password_hash || DUMMY_HASH,
      );
    if (!u || !passwordWithinLimit || !validPassword || u.temporaryExpired)
      return res
        .status(401)
        .json({ error: 'No se pudo iniciar sesión. Comprueba tus datos y que tu correo esté confirmado.' });
    await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
    if (!u.verified_at) {
      req.session.pendingVerification = u.id;
      req.session.csrfToken = token();
      return req.session.save((e) => e ? next(e) : res.json({
        pendingVerification: { email: u.email }, csrfToken: req.session.csrfToken,
      }));
    }
    if (u.two_factor_secret) {
      req.session.pendingTwoFactor = { id: u.id, binding: twoFactorBinding(u), expires: Date.now() + TWO_FACTOR_LIFETIME };
      req.session.csrfToken = token();
      return req.session.save((e) => e ? next(e) : res.json({
        pendingTwoFactor: true, csrfToken: req.session.csrfToken,
      }));
    }
    req.session.user = userView(u);
    req.session.csrfToken = token();
    req.session.save(async (e) => {
      if (e) return next(e);
      notifySuccessfulLogin(u, req);
      res.json({ user: req.session.user, csrfToken: req.session.csrfToken });
    });
  } catch (e) {
    next(e);
  }
});
app.post('/api/auth/logout', async (req, res, next) => {
  req.session.destroy((e) =>
    e
      ? next(e)
      : res
          .clearCookie('teralth.sid', {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
          })
          .json({ ok: true }),
  );
});
registerTwoFactorRoutes(app, {
  pool, query, auth, limiter: twoFactorLimiter, bcrypt, sessionSecret: process.env.SESSION_SECRET,
  token, userView, invalidateUserSessions, notifySuccessfulLogin, notifySecurityChange,
});
app.post('/api/auth/password', auth, loginLimiter, async (req, res, next) => {
  try {
    const captchaValid = await verifyCaptcha(req, 'change');
    if (!captchaValid)
      return res.status(400).json({ error: 'Completa la verificación CAPTCHA e inténtalo de nuevo.' });
    const current = String(req.body.currentPassword || ''),
      password = String(req.body.password || '');
    const [u] = await query(
      'SELECT id,email,username,password_hash,role,is_primary_admin,verified_at,must_change_password,previous_password_hash,temporary_password_expires_at,two_factor_secret,(temporary_password_expires_at IS NOT NULL AND temporary_password_expires_at<=UTC_TIMESTAMP()) AS temporaryExpired FROM users WHERE id=?',
      [req.session.user.id],
    );
    if (u?.must_change_password && u.temporaryExpired)
      return res.status(428).json({ error: 'La contraseña temporal venció. Solicita una nueva.' });
    if (!u || !u.verified_at || !(await bcrypt.compare(current, u.password_hash)))
      return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    if (
      password.length < 8 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[!@#$%^&*(),.?":{}|<>_+\-=\[\]\\/]/.test(password)
    )
      return res
        .status(400)
        .json({ error: 'Usa 8 caracteres o más con mayúscula, minúscula, número y símbolo.' });
    await query(
      'UPDATE users SET password_hash=?,must_change_password=FALSE,previous_password_hash=NULL,temporary_password_expires_at=NULL WHERE id=?',
      [await bcrypt.hash(password, 12), u.id],
    );
    const notificationQueued = await notifySecurityChange(
      u, 'password_changed.html', 'Password updated',
    );
    const previousTwoFactorBinding = req.session.twoFactorBinding;
    await invalidateUserSessions(u.id);
    await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
    req.session.user = { ...userView(u), mustChangePassword: false };
    if (previousTwoFactorBinding) req.session.twoFactorBinding = previousTwoFactorBinding;
    req.session.csrfToken = token();
    req.session.save((e) =>
      e ? next(e) : res.json({ ok: true, csrfToken: req.session.csrfToken, notificationQueued }),
    );
  } catch (e) {
    next(e);
  }
});
app.post('/api/auth/forgot', loginLimiter, async (req, res, next) => {
  const generic = {
    message: 'Si el correo y el nombre de usuario coinciden, recibirás un enlace para restablecer tu contraseña.',
  };
  try {
    const captchaValid = await verifyCaptcha(req, 'forgot');
    if (!captchaValid)
      return res.status(400).json({ error: 'Completa la verificación CAPTCHA e inténtalo de nuevo.' });
    if (!mailer)
      return res.status(503).json({ error: 'El restablecimiento requiere que SMTP esté configurado.' });
    const email = String(req.body.email || '')
        .trim()
        .toLowerCase(),
      username = String(req.body.username || '').trim();
    const [u] =
      email.length <= 254 && username.length <= 60
        ? await query(
            'SELECT id,email,username FROM users WHERE email=? AND username=? AND verified_at IS NOT NULL',
            [email, username],
          )
        : [null];
    if (u && mailer) {
      const raw = token(),
        conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [u.id]);
        await conn.execute(
          "UPDATE account_tokens SET used_at=NOW() WHERE user_id=? AND purpose='reset' AND used_at IS NULL",
          [u.id],
        );
        await conn.execute(
          "INSERT INTO account_tokens (user_id,token_hash,purpose,expires_at) VALUES (?,?,'reset',DATE_ADD(NOW(),INTERVAL 1 HOUR))",
          [u.id, hash(raw)],
        );
        const date = new Intl.DateTimeFormat('es-EC', {
            dateStyle: 'long',
            timeZone: 'America/Guayaquil',
          }).format(new Date()),
          hour = new Intl.DateTimeFormat('es-EC', {
            timeStyle: 'short',
            timeZone: 'America/Guayaquil',
          }).format(new Date());
        await enqueueMail(
          u.email,
          'Reset your password',
          emailTemplate('password_reset.html', {
            username: u.username,
            email: u.email,
            date,
            hour,
            reset_link: `${baseUrl(req)}/reset?token=${encodeURIComponent(raw)}`,
          }),
          conn,
        );
        await conn.commit();
      } catch (error) {
        await conn.rollback().catch(() => {});
        console.error('[Teralth Wiki] Password recovery could not be queued:', error.code || error.name || 'Error');
        return res.json(generic);
      } finally {
        conn.release();
      }
    }
    res.json(generic);
  } catch (e) {
    next(e);
  }
});
app.post('/api/auth/reset', loginLimiter, async (req, res, next) => {
  let conn;
  try {
    const captchaValid = await verifyCaptcha(req, 'reset');
    if (!captchaValid)
      return res.status(400).json({ error: 'Completa la verificación CAPTCHA e inténtalo de nuevo.' });
    const raw = String(req.body.token || ''),
      password = String(req.body.password || '');
    if (
      !raw ||
      raw.length > 200 ||
      password.length < 8 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[!@#$%^&*(),.?":{}|<>_+\-=\[\]\\/]/.test(password)
    )
      return res
        .status(400)
        .json({ error: 'El enlace no es válido o la contraseña no cumple los requisitos.' });
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id,user_id FROM account_tokens WHERE token_hash=? AND purpose='reset' AND used_at IS NULL AND expires_at>NOW() LIMIT 1 FOR UPDATE",
      [hash(raw)],
    );
    const entry = rows[0];
    if (!entry) {
      await conn.rollback();
      return res.status(400).json({ error: 'El enlace venció o ya fue utilizado. Solicita otro.' });
    }
    const [used] = await conn.execute(
      'UPDATE account_tokens SET used_at=NOW() WHERE id=? AND used_at IS NULL',
      [entry.id],
    );
    if (!used.affectedRows) {
      await conn.rollback();
      return res.status(400).json({ error: 'El enlace ya fue utilizado. Solicita otro.' });
    }
    await conn.execute('UPDATE users SET password_hash=?,must_change_password=FALSE,previous_password_hash=NULL,temporary_password_expires_at=NULL WHERE id=?', [
      await bcrypt.hash(password, 12),
      entry.user_id,
    ]);
    await conn.execute(
      "UPDATE account_tokens SET used_at=NOW() WHERE user_id=? AND purpose='reset' AND used_at IS NULL",
      [entry.user_id],
    );
    await conn.commit();
    conn.release();
    conn = null;
    await invalidateUserSessions(entry.user_id);
    await notifyPasswordReset(entry.user_id);
    res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    next(e);
  } finally {
    conn?.release();
  }
});
app.post('/api/auth/reset-account', loginLimiter, async (req, res, next) => {
  try {
    const raw = String(req.body.token || '');
    if (!raw || raw.length > 200) return res.status(400).json({ error: 'El enlace venció o no es válido.' });
    const [entry] = await query(
      "SELECT u.email FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose='reset' AND t.used_at IS NULL AND t.expires_at>NOW() AND u.verified_at IS NOT NULL LIMIT 1",
      [hash(raw)],
    );
    if (!entry) return res.status(400).json({ error: 'El enlace venció o no es válido.' });
    res.set('Cache-Control', 'no-store').json({ email: entry.email });
  } catch (error) {
    next(error);
  }
});
app.post('/api/auth/verify', async (req, res, next) => {
  let conn;
  try {
    const raw = String(req.body.token || '');
    if (!raw || raw.length > 200) return res.status(400).json({ error: 'El enlace venció o no es válido.' });
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id,user_id FROM account_tokens WHERE token_hash=? AND purpose='verify' AND used_at IS NULL AND expires_at>NOW() LIMIT 1 FOR UPDATE",
      [hash(raw)],
    );
    const entry = rows[0];
    if (!entry) {
      await conn.rollback();
      return res.status(400).json({ error: 'El enlace venció o no es válido.' });
    }
    await conn.execute('UPDATE users SET verified_at=NOW() WHERE id=?', [entry.user_id]);
    const [used] = await conn.execute(
      'UPDATE account_tokens SET used_at=NOW() WHERE id=? AND used_at IS NULL',
      [entry.id],
    );
    if (!used.affectedRows) {
      await conn.rollback();
      return res.status(400).json({ error: 'El enlace ya fue utilizado.' });
    }
    await conn.commit();
    if (Number(req.session.pendingVerification) === Number(entry.user_id)) delete req.session.pendingVerification;
    res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    next(e);
  } finally {
    conn?.release();
  }
});

app.get('/api/pages', async (req, res, next) => {
  try {
    const space = activeSpace(req),
      userId = req.session.user ? Number(req.session.user.id) : 0,
      ipHash = userId ? '' : hash(req.ip + ':' + process.env.SESSION_SECRET),
      requestedSlug = String(req.query.slug || '').trim(),
      pageColumns =
        'p.id,p.slug,p.icon,p.page_type,p.redirect_url,p.titles,p.content,p.category_id,p.sort_order,p.updated_at,p.updated_by,u.username AS updated_by_name';
    const selectedPageSql = requestedSlug
      ? `SELECT ${pageColumns} FROM pages p LEFT JOIN users u ON u.id=p.updated_by WHERE p.space_slug=? AND p.slug=? LIMIT 1`
      : `SELECT ${pageColumns} FROM pages p LEFT JOIN users u ON u.id=p.updated_by LEFT JOIN spaces s ON s.slug=p.space_slug WHERE p.space_slug=? ORDER BY (p.slug=s.home_page_slug) DESC,p.sort_order,p.slug LIMIT 1`;
    const selectedParams = requestedSlug ? [space, slugify(requestedSlug)] : [space];
    const [pages, categories, spaces, selectedRows] = await Promise.all([
      query(
        'SELECT id,slug,icon,page_type,redirect_url,titles,category_id,sort_order FROM pages WHERE space_slug=? ORDER BY category_id,sort_order,slug',
        [space],
      ),
      query(
        'SELECT id,parent_id,icon,names,sort_order,is_open FROM categories WHERE space_slug=? ORDER BY sort_order,id',
        [space],
      ),
      query('SELECT home_page_slug FROM spaces WHERE slug=?', [space]),
      query(selectedPageSql, selectedParams),
    ]);
    const selected = selectedRows[0];
    let reactions = [],
      myReaction = null;
    if (selected) {
      const identityColumn = userId ? 'user_id' : 'ip_hash',
        identityValue = userId || ipHash;
      const [counts, ownRows] = await Promise.all([
        query('SELECT mood,COUNT(*) AS count FROM reactions WHERE page_id=? GROUP BY mood', [selected.id]),
        query(`SELECT mood FROM reactions WHERE page_id=? AND ${identityColumn}=? LIMIT 1`, [
          selected.id,
          identityValue,
        ]),
      ]);
      reactions = counts.map((row) => ({ mood: row.mood, count: Number(row.count) }));
      myReaction = ownRows[0]?.mood || null;
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({
      pages: pages.map((page) => ({ ...page, titles: json(page.titles) })),
      categories: categories.map((category) => ({ ...category, names: json(category.names) })),
      homePageSlug: spaces[0]?.home_page_slug || null,
      page: selected
        ? { ...selected, titles: json(selected.titles), content: safePageContent(selected.content) }
        : null,
      reactions,
      myReaction,
    });
  } catch (error) {
    next(error);
  }
});
app.get('/api/pages/:slug', async (req, res, next) => {
  try {
    const space = activeSpace(req),
      [p] = await query(
        'SELECT p.id,p.slug,p.icon,p.page_type,p.redirect_url,p.titles,p.content,p.category_id,p.updated_at,p.updated_by,u.username AS updated_by_name FROM pages p LEFT JOIN users u ON u.id=p.updated_by WHERE p.space_slug=? AND p.slug=? LIMIT 1',
        [space, slugify(req.params.slug)],
      );
    if (!p) return res.status(404).json({ error: 'No encontramos esa página.' });
    const identityColumn = req.session.user ? 'user_id' : 'ip_hash',
      identityValue = req.session.user
        ? req.session.user.id
        : hash(`${req.ip}:${process.env.SESSION_SECRET}`);
    const [reactions, own] = await Promise.all([
      query('SELECT mood,COUNT(*) AS count FROM reactions WHERE page_id=? GROUP BY mood', [p.id]),
      query(`SELECT mood FROM reactions WHERE page_id=? AND ${identityColumn}=? LIMIT 1`, [
        p.id,
        identityValue,
      ]),
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.json({
      page: { ...p, titles: json(p.titles), content: safePageContent(p.content) },
      reactions: reactions.map((row) => ({ mood: row.mood, count: Number(row.count) })),
      myReaction: own[0]?.mood || null,
    });
  } catch (e) {
    next(e);
  }
});
app.post('/api/pages/:id/reactions', reactionLimiter, async (req, res, next) => {
  let conn;
  try {
    const mood = String(req.body.mood);
    if (!['happy', 'neutral', 'sad'].includes(mood))
      return res.status(400).json({ error: 'Reacción no válida.' });
    const space = activeSpace(req),
      [page] = await query('SELECT id FROM pages WHERE id=? AND space_slug=?', [req.params.id, space]);
    if (!page) return res.status(404).json({ error: 'Página no encontrada.' });
    const logged = Boolean(req.session.user),
      ipHash = logged
        ? hash(`registered-user:${req.session.user.id}:${process.env.SESSION_SECRET}`)
        : hash(`${req.ip}:${process.env.SESSION_SECRET}`);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const lookupSql = logged
      ? 'SELECT id,mood,created_at FROM reactions WHERE page_id=? AND user_id=? LIMIT 1 FOR UPDATE'
      : 'SELECT id,mood,created_at FROM reactions WHERE page_id=? AND ip_hash=? AND user_id IS NULL LIMIT 1 FOR UPDATE';
    const lookupValue = logged ? req.session.user.id : ipHash;
    const [rows] = await conn.execute(lookupSql, [page.id, lookupValue]);
    const existing = rows[0];
    if (existing && existing.mood === mood) {
      if (logged) await conn.execute('DELETE FROM reactions WHERE id=?', [existing.id]);
      else
        await conn.execute(
          'DELETE FROM reactions WHERE id=? AND created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 60 MINUTE)',
          [existing.id],
        );
    } else if (existing) {
      if (!logged && new Date(existing.created_at).getTime() < Date.now() - 60 * 60 * 1000) {
        await conn.rollback();
        return res
          .status(403)
          .json({ error: 'Ya venció el plazo de 60 minutos para modificar esta reacción.' });
      }
      await conn.execute('UPDATE reactions SET mood=? WHERE id=?', [mood, existing.id]);
    } else {
      await conn.execute(
        'INSERT INTO reactions (space_slug,page_id,ip_hash,user_id,mood) VALUES (?,?,?,?,?)',
        [space, page.id, ipHash, logged ? req.session.user.id : null, mood],
      );
    }
    await conn.commit();
    const counts = await query('SELECT mood,COUNT(*) count FROM reactions WHERE page_id=? GROUP BY mood', [
      page.id,
    ]);
    const identityColumn = logged ? 'user_id' : 'ip_hash',
      identityValue = logged ? req.session.user.id : ipHash;
    const [own] = await query(`SELECT mood FROM reactions WHERE page_id=? AND ${identityColumn}=? LIMIT 1`, [
      page.id,
      identityValue,
    ]);
    res.json({ reactions: counts, myReaction: own?.mood || null });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    next(e);
  } finally {
    conn?.release();
  }
});
app.get('/api/admin/reverse-proxy', auth, requirePermission('reverse_proxy.configure'), (req, res) =>
  res.json({ config: reverseProxyConfig }),
);
app.get('/api/admin/reverse-proxy/status', auth, requirePermission('reverse_proxy.configure'), (req, res) =>
  res.json({
    protocol: req.protocol,
    secure: req.secure,
    host: req.get('host'),
    clientIp: req.ip,
    trustMode: reverseProxyConfig.mode,
  }),
);
app.put(
  '/api/admin/reverse-proxy',
  auth,
  requirePermission('reverse_proxy.configure'),
  async (req, res, next) => {
    try {
      const config = validateReverseProxy(req.body);
      await query(
        "INSERT INTO settings (setting_key,setting_value) VALUES ('reverse_proxy',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
        [JSON.stringify(config)],
      );
      applyReverseProxyTrust(config);
      res.json({ ok: true, config });
    } catch (e) {
      next(e);
    }
  },
);
app.get(
  '/api/admin/backups',
  auth,
  requireAnyPermission(['backups.import', 'backups.export', 'backups.schedule']),
  async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'private, no-store')
        .json({
          cron: backupCronExpression,
          retention: backupRetentionCount,
          timeZone: backupTimeZone,
          timeZones: backupTimeZones,
          nextRunAt: nextCronDate(backupCronExpression, new Date(), backupTimeZone).toISOString(),
          backups: await listBackups(),
          permissions: {
            import: await canUser(req.session.user.id, 'backups.import'),
            export: await canUser(req.session.user.id, 'backups.export'),
            schedule: await canUser(req.session.user.id, 'backups.schedule'),
          },
        });
    } catch (error) {
      next(error);
    }
  },
);
app.get('/api/admin/updates', auth, requirePermission('updates.install'), async (req, res, next) => {
  try {
    await ensureUpdateTables(pool);
    const [rows] = await pool.execute(
      'SELECT update_id,release_version,applied_at FROM wiki_updates ORDER BY applied_at DESC LIMIT 10',
    );
    res.set('Cache-Control', 'private, no-store').json({
      configured: Boolean(updatePublicKey),
      currentVersion: rows[0]?.release_version || require('./package.json').version,
      updates: rows,
    });
  } catch (error) {
    next(error);
  }
});
app.get('/api/updates/progress', maintenance.progress);
app.post(
  '/api/admin/updates/validate',
  auth,
  requirePermission('updates.install'),
  updateLimiter,
  (req, res, next) => {
    if (updateMaintenance.active) return res.status(409).json({ error: 'Ya hay una actualización en curso.' });
    if (updateValidationBusy)
      return res.status(409).json({ error: 'Ya se está validando otro paquete de actualización.' });
    updateValidationBusy = true;
    clearPendingValidatedUpdate();
    setUpdateValidation('receiving', 1);
    next();
  },
  (req, res, next) =>
    updateUpload.single('package')(req, res, (error) => {
      if (error?.code === 'LIMIT_FILE_SIZE') {
        updateValidationBusy = false;
        setUpdateValidation('failed', updateValidationState.progress);
        return res.status(413).json({ error: 'El paquete no puede superar los 64 MB.' });
      }
      if (error?.code === 'LIMIT_FILE_COUNT' || error?.code === 'LIMIT_UNEXPECTED_FILE') {
        updateValidationBusy = false;
        setUpdateValidation('failed', updateValidationState.progress);
        return res.status(400).json({ error: 'Selecciona un solo paquete .zip.' });
      }
      if (error) {
        updateValidationBusy = false;
        setUpdateValidation('failed', updateValidationState.progress);
        if (error instanceof UpdateError)
          return res.status(error.status).json({ error: error.message });
        return next(error);
      }
      next();
    }),
  async (req, res, next) => {
    let connection;
    try {
      if (!req.file) {
        setUpdateValidation('failed', updateValidationState.progress);
        return res.status(400).json({ error: 'Selecciona un paquete .zip.' });
      }
      setUpdateValidation('verifying', 8);
      const pkg = await verifyUpdatePackage(req.file.path, updatePublicKey, {
        onProgress: (progress) => setUpdateValidation('verifying', 8 + Math.floor((progress / 18) * 62)),
      });
      await ensureUpdateTables(pool);
      const [priorUpdate] = await pool.execute('SELECT update_id FROM wiki_updates WHERE update_id=?', [pkg.id]);
      if (priorUpdate.length) throw new UpdateError('Este paquete ya se instaló.', 409);
      const [history] = await pool.query('SELECT release_version FROM wiki_updates');
      const priorVersion = history.reduce(
        (latest, row) => (compareVersions(row.release_version, latest) > 0 ? row.release_version : latest),
        require('./package.json').version,
      );
      if (compareVersions(pkg.version, priorVersion) <= 0)
        throw new UpdateError('La versión debe ser superior a la ya instalada.', 409);

      setUpdateValidation('preflight', 72);
      connection = await pool.getConnection();
      await preflightUpdatePackage(pkg, {
        root: __dirname,
        connection,
        onProgress: (_stage, progress) =>
          setUpdateValidation('preflight', 72 + Math.floor(((progress - 18) / 10) * 27)),
      });

      const validationToken = crypto.randomUUID(),
        expiry = setTimeout(() => {
          if (pendingValidatedUpdate?.token === validationToken) {
            pendingValidatedUpdate = null;
            setUpdateValidation('idle', 0);
          }
        }, 5 * 60 * 1000);
      expiry.unref();
      pendingValidatedUpdate = {
        token: validationToken,
        userId: req.session.user.id,
        pkg,
        expiresAt: Date.now() + 5 * 60 * 1000,
        expiry,
      };
      setUpdateValidation('verified', 100);
      res.json({ ok: true, token: validationToken, version: pkg.version });
    } catch (error) {
      setUpdateValidation('failed', updateValidationState.progress);
      if (error instanceof UpdateError)
        return res.status(error.status).json({ error: error.message });
      next(error);
    } finally {
      connection?.release();
      updateValidationBusy = false;
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    }
  },
);
app.get(
  '/api/admin/updates/validation-progress',
  auth,
  requirePermission('updates.install'),
  (req, res) =>
    res.set('Cache-Control', 'private, no-store').json({
      active: updateValidationState.active,
      progress: updateValidationState.progress,
      stage: updateValidationState.stage,
    }),
);
app.post(
  '/api/admin/updates/install',
  auth,
  requirePermission('updates.install'),
  async (req, res, next) => {
    try {
      if (updateMaintenance.active)
        return res.status(409).json({ error: 'Ya hay una actualización en curso.' });
      const tokenValue = typeof req.body?.token === 'string' ? req.body.token : '',
        validated = pendingValidatedUpdate;
      if (
        !validated ||
        validated.token !== tokenValue ||
        validated.userId !== req.session.user.id ||
        validated.expiresAt <= Date.now()
      )
        return res.status(400).json({ error: 'El paquete validado venció o ya no está disponible. Valídalo de nuevo.' });
      clearPendingValidatedUpdate();

      setUpdateMaintenance('preflight', 28);
      let restartRequested = false;
      const result = await applyUpdatePackage({
        pkg: validated.pkg,
        root: __dirname,
        pool,
        createBackup,
        installedVersion: require('./package.json').version,
        onProgress: (stage, progress) =>
          setUpdateMaintenance(stage, stage === 'preflight' ? 28 + Math.floor(((progress - 18) / 10) * 2) : progress),
        restart: async () => {
          restartRequested = true;
        },
      });
      setUpdateMaintenance('complete', 100);
      res.status(202).json({
        ok: true,
        version: result.version,
        backup: result.backup,
        message: 'Actualización instalada. El servidor se reiniciará en unos segundos.',
      });
      if (restartRequested) {
        setUpdateMaintenance('complete', 100);
        setTimeout(() => {
          if (!httpServer) return process.exit(75);
          httpServer.close((error) => {
            if (error) console.error('Error al cerrar el servidor tras la actualización:', error.message);
            pool
              .end()
              .catch((closeError) =>
                console.error('Error al cerrar la conexión de base de datos:', closeError.message),
              )
              .finally(() => process.exit(75));
          });
          httpServer.closeIdleConnections?.();
          const forceClose = setTimeout(() => {
            httpServer.closeAllConnections?.();
            process.exit(75);
          }, 10000);
          forceClose.unref();
        }, 1200);
      }
    } catch (error) {
      failUpdateMaintenance();
      if (error instanceof UpdateError)
        return res.status(error.status).json({ error: error.message });
      next(error);
    }
  },
);
app.put(
  '/api/admin/backups/schedule',
  auth,
  requirePermission('backups.schedule'),
  async (req, res, next) => {
    try {
      const cron = validateBackupCron(req.body.cron),
        timeZone = validateTimeZone(req.body.timeZone || DEFAULT_TIME_ZONE),
        retention = Number(req.body.retention);
      if (!Number.isInteger(retention) || retention < 1 || retention > 30)
        return res.status(400).json({ error: 'La retención debe estar entre 1 y 30 copias.' });
      nextCronDate(cron, new Date(), timeZone);
      await query(
        "INSERT INTO settings (setting_key,setting_value) VALUES ('backup_settings',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
        [JSON.stringify({ cron, retention, timeZone })],
      );
      backupCronExpression = cron;
      backupTimeZone = timeZone;
      backupRetentionCount = retention;
      await pruneBackups();
      scheduleBackupJob();
      res.json({
        ok: true,
        cron,
        retention,
        timeZone,
        nextRunAt: nextCronDate(backupCronExpression, new Date(), backupTimeZone).toISOString(),
      });
    } catch (error) {
      if (error.message === 'TIME_ZONE_INVALID')
        return res.status(400).json({ error: 'Selecciona una zona horaria disponible.' });
      if (error.message === 'CRON_INVALID' || error.message === 'CRON_NO_NEXT_RUN')
        return res
          .status(400)
          .json({ error: 'La expresión CRON debe tener cinco campos válidos y una próxima ejecución.' });
      next(error);
    }
  },
);
app.get(
  '/api/admin/backups/:name/export',
  auth,
  requirePermission('backups.export'),
  backupExportLimiter,
  async (req, res, next) => {
    try {
      const name = String(req.params.name || '');
      if (
        !/^teralth-studio_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[A-Za-z0-9_-]{1,100}$/.test(name) ||
        (await listBackups()).every((item) => item.name !== name)
      )
        return res.status(404).json({ error: 'Copia de seguridad no encontrada.' });
      const directory = path.join(backupRoot, name),
        zip = await createBackupZipStream(directory, name);
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + name + '.zip"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      zip.on('error', (error) => {
        if (!res.headersSent) next(error);
        else res.destroy(error);
      });
      zip.pipe(res);
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  '/api/admin/backups/import',
  auth,
  requirePermission('backups.import'),
  backupImportLimiter,
  (req, res, next) =>
    backupUpload.single('backup')(req, res, (error) => {
      if (!error) return next();
      const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      res
        .status(status)
        .json({
          error:
            error.code === 'LIMIT_FILE_SIZE'
              ? 'El ZIP no puede superar 250 MB.'
              : 'Selecciona un archivo ZIP válido.',
        });
    }),
  async (req, res, next) => {
    let stage = '',
      databaseRestored = false;
    try {
      if (!req.file)
        return res.status(400).json({ error: 'Selecciona el archivo ZIP que quieres importar.' });
      stage = path.join(backupRoot, '.restore-' + crypto.randomUUID());
      await fs.promises.mkdir(stage, { mode: 0o700 });
      const parsed = await readBackupZip(req.file.path, stage);
      let snapshot;
      try {
        snapshot = JSON.parse(
          decryptBackupDatabase(
            parsed.database,
            process.env.BACKUP_ENCRYPTION_KEY || process.env.SESSION_SECRET,
          ),
        );
      } catch {
        throw new Error('BACKUP_DECRYPTION_FAILED');
      }
      await validateStagedBackupImages(stage);
      await restoreDatabaseSnapshot(snapshot);
      databaseRestored = true;
      await applyStagedBackupImages(stage);
      const [restoredSchedule] = await query(
        "SELECT setting_value FROM settings WHERE setting_key='backup_settings'",
      );
      if (restoredSchedule) {
        const preferences = json(restoredSchedule.setting_value);
        backupCronExpression = validateBackupCron(preferences.cron);
        backupTimeZone = validateTimeZone(preferences.timeZone || DEFAULT_TIME_ZONE);
        if (
          Number.isInteger(Number(preferences.retention)) &&
          Number(preferences.retention) >= 1 &&
          Number(preferences.retention) <= 30
        )
          backupRetentionCount = Number(preferences.retention);
      } else
        await query(
          "INSERT INTO settings (setting_key,setting_value) VALUES ('backup_settings',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
          [
            JSON.stringify({
              cron: backupCronExpression,
              retention: backupRetentionCount,
              timeZone: backupTimeZone,
            }),
          ],
        );
      scheduleBackupJob();
      await pruneBackups();
      req.session.destroy((error) => {
        if (error) return next(error);
        res
          .clearCookie('teralth.sid', {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
          })
          .json({ ok: true });
      });
    } catch (error) {
      console.error(
        '[Teralth Wiki] Falló la importación de backup',
        JSON.stringify({
          code:
            error.code ||
            (/^[A-Z0-9_]{1,80}$/.test(error.message || '')
              ? error.message
              : error.name || 'BACKUP_IMPORT_FAILED'),
        }),
      );
      const message = databaseRestored
        ? 'La base de datos se restauró, pero algunos archivos de imagen no pudieron completarse. Revisa el espacio y los permisos del servidor.'
        : ['BACKUP_DECRYPTION_FAILED', 'BACKUP_FORMAT_INVALID'].includes(error.message)
          ? 'El ZIP no corresponde a esta instalación o la clave de cifrado no coincide.'
          : 'No se pudo importar el ZIP; comprueba que sea un respaldo válido y que tenga espacio disponible.';
      if (!res.headersSent) {
        if (databaseRestored && req.session)
          await new Promise((resolve) => req.session.destroy(() => resolve()));
        const response = res.status(databaseRestored ? 500 : 400);
        if (databaseRestored)
          response.clearCookie('teralth.sid', {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
          });
        response.json({ error: message });
      }
    } finally {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      if (stage && stage.startsWith(backupRoot + path.sep))
        await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  },
);
const rolePermissionKeys = [
  'captcha.configure',
  'admin.view',
  'pages.create_edit',
  'pages.delete',
  'categories.create_edit',
  'categories.delete',
  'settings.identity',
  'settings.support',
  'settings.seo',
  'settings.sidebar_label',
  'languages.create',
  'languages.edit',
  'languages.delete',
  'spaces.create',
  'spaces.edit',
  'spaces.delete',
  'users.registration',
  'users.edit',
  'users.delete',
  'users.role',
  'users.reset_password',
  'reverse_proxy.configure',
  'roles.manage',
  'backups.import',
  'backups.export',
  'backups.schedule',
  'updates.install',
  'header_links.create_edit',
  'header_links.delete',
];
async function activeHeaderLanguages() {
  const [row] = await query("SELECT setting_value FROM settings WHERE setting_key='languages'");
  const languages = row ? json(row.setting_value) : ['en', 'es'];
  return Array.isArray(languages) && languages.length ? languages : ['en', 'es'];
}
app.get('/api/admin/header-links', auth, async (req, res, next) => {
  try {
    const userId = req.session.user.id,
      allowed =
        (await canUser(userId, 'header_links.create_edit')) ||
        (await canUser(userId, 'header_links.delete'));
    if (!allowed) return res.status(403).json({ error: 'No tienes permiso para gestionar los enlaces.' });
    const [row] = await query("SELECT setting_value FROM settings WHERE setting_key='header_links'");
    res.json({
      links: normalizeHeaderLinks(row ? json(row.setting_value) : [], await activeHeaderLanguages()),
    });
  } catch (error) {
    next(error);
  }
});
app.post(
  '/api/admin/header-links',
  auth,
  requirePermission('header_links.create_edit'),
  async (req, res, next) => {
    let conn;
    try {
      const link = normalizeHeaderLink(req.body, await activeHeaderLanguages());
      conn = await pool.getConnection();
      await conn.beginTransaction();
      await conn.query("INSERT IGNORE INTO settings (setting_key,setting_value) VALUES ('header_links',?)", [
        JSON.stringify([]),
      ]);
      const [rows] = await conn.query(
        "SELECT setting_value FROM settings WHERE setting_key='header_links' FOR UPDATE",
      );
      const links = normalizeHeaderLinks(json(rows[0].setting_value), await activeHeaderLanguages());
      if (links.length >= HEADER_LINK_LIMIT) {
        await conn.rollback();
        return res.status(400).json({ error: 'No se pueden crear más de 5 enlaces.' });
      }
      const saved = [...links, { id: crypto.randomUUID(), ...link }];
      await conn.query("UPDATE settings SET setting_value=? WHERE setting_key='header_links'", [
        JSON.stringify(saved),
      ]);
      await conn.commit();
      res.json({ ok: true, links: saved });
    } catch (error) {
      if (conn) await conn.rollback();
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    } finally {
      if (conn) conn.release();
    }
  },
);
app.put(
  '/api/admin/header-links/:id',
  auth,
  requirePermission('header_links.create_edit'),
  async (req, res, next) => {
    let conn;
    try {
      const id = String(req.params.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id))
        return res.status(400).json({ error: 'El identificador del enlace no es válido.' });
      const link = normalizeHeaderLink(req.body, await activeHeaderLanguages());
      conn = await pool.getConnection();
      await conn.beginTransaction();
      await conn.query("INSERT IGNORE INTO settings (setting_key,setting_value) VALUES ('header_links',?)", [
        JSON.stringify([]),
      ]);
      const [rows] = await conn.query(
        "SELECT setting_value FROM settings WHERE setting_key='header_links' FOR UPDATE",
      );
      const links = normalizeHeaderLinks(json(rows[0].setting_value), await activeHeaderLanguages()),
        index = links.findIndex((item) => item.id === id);
      if (index < 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Enlace no encontrado.' });
      }
      links[index] = { id, ...link };
      await conn.query("UPDATE settings SET setting_value=? WHERE setting_key='header_links'", [
        JSON.stringify(links),
      ]);
      await conn.commit();
      res.json({ ok: true, links });
    } catch (error) {
      if (conn) await conn.rollback();
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    } finally {
      if (conn) conn.release();
    }
  },
);
app.delete(
  '/api/admin/header-links/:id',
  auth,
  requirePermission('header_links.delete'),
  async (req, res, next) => {
    let conn;
    try {
      const id = String(req.params.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id))
        return res.status(400).json({ error: 'El identificador del enlace no es válido.' });
      conn = await pool.getConnection();
      await conn.beginTransaction();
      await conn.query("INSERT IGNORE INTO settings (setting_key,setting_value) VALUES ('header_links',?)", [
        JSON.stringify([]),
      ]);
      const [rows] = await conn.query(
        "SELECT setting_value FROM settings WHERE setting_key='header_links' FOR UPDATE",
      );
      const links = normalizeHeaderLinks(json(rows[0].setting_value), await activeHeaderLanguages()),
        remaining = links.filter((item) => item.id !== id);
      if (remaining.length === links.length) {
        await conn.rollback();
        return res.status(404).json({ error: 'Enlace no encontrado.' });
      }
      await conn.query("UPDATE settings SET setting_value=? WHERE setting_key='header_links'", [
        JSON.stringify(remaining),
      ]);
      await conn.commit();
      res.json({ ok: true, links: remaining });
    } catch (error) {
      if (conn) await conn.rollback();
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    } finally {
      if (conn) conn.release();
    }
  },
);
app.get('/api/admin/roles', auth, requirePermission('roles.manage'), async (req, res, next) => {
  try {
    res.json({ roles: await getRoleCatalog() });
  } catch (error) {
    next(error);
  }
});
app.put('/api/admin/roles', auth, requirePermission('roles.manage'), async (req, res, next) => {
  let conn;
  try {
    const roles = req.body.roles;
    if (!Array.isArray(roles) || roles.length < 2 || roles.length > 50)
      return res.status(400).json({ error: 'Agrega entre 2 y 50 roles.' });
    if (roles.some((role) => !role || typeof role !== 'object' || Array.isArray(role)))
      return res.status(400).json({ error: 'Un rol enviado no es válido.' });
    const submitted = roles.filter((role) => role.roleKey !== 'administrator' && role.roleKey !== 'user');
    if (
      roles.filter((role) => role.roleKey === 'administrator').length !== 1 ||
      roles.filter((role) => role.roleKey === 'user').length !== 1
    )
      return res.status(400).json({ error: 'Los roles base no se pueden quitar.' });
    for (const role of submitted) {
      if (
        !role ||
        typeof role.name !== 'string' ||
        !role.name.trim() ||
        role.name.trim().length > 80 ||
        !/^#[0-9a-fA-F]{6}$/.test(role.color) ||
        !Array.isArray(role.permissions) ||
        role.permissions.some((permission) => !rolePermissionKeys.includes(permission)) ||
        new Set(role.permissions).size !== role.permissions.length
      )
        return res.status(400).json({ error: 'Revisa el nombre, color y permisos de cada rol.' });
    }
    const names = submitted.map((role) => role.name.trim().toLocaleLowerCase());
    if (new Set(names).size !== names.length || names.includes('administrator') || names.includes('user'))
      return res.status(400).json({ error: 'Los nombres de los roles deben ser únicos.' });
    const [actor] = await query(
      'SELECT u.role,u.is_primary_admin,r.permissions FROM users u LEFT JOIN roles r ON r.role_key=u.role WHERE u.id=?',
      [req.session.user.id],
    );
    const actorPermissions =
      actor?.is_primary_admin || actor?.role === 'administrator'
        ? rolePermissionsDefault
        : actor?.permissions
          ? json(actor.permissions)
          : [];
    if (
      submitted.some((role) => role.permissions.some((permission) => !actorPermissions.includes(permission)))
    )
      return res.status(403).json({ error: 'No puedes conceder permisos que no tienes.' });
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [existingRows] = await conn.query('SELECT role_key,is_system FROM roles');
    const known = new Map(existingRows.map((row) => [row.role_key, row]));
    const activeKeys = new Set(['administrator', 'user']);
    for (const item of submitted) {
      let roleKey = String(item.roleKey || '').trim();
      if (!roleKey || !known.has(roleKey)) {
        const base = spaceSlugify(item.name).toLowerCase().slice(0, 48) || 'role';
        roleKey = base;
        let suffix = 2;
        while (known.has(roleKey) || activeKeys.has(roleKey)) {
          roleKey = base + '-' + suffix++;
        }
      } else if (known.get(roleKey).is_system)
        throw Object.assign(new Error('Ese rol predeterminado no se puede modificar.'), { status: 400 });
      activeKeys.add(roleKey);
      await conn.execute(
        'INSERT INTO roles (role_key,name,color,permissions,is_system) VALUES (?,?,?,?,FALSE) ON DUPLICATE KEY UPDATE name=VALUES(name),color=VALUES(color),permissions=VALUES(permissions)',
        [roleKey, item.name.trim(), item.color, JSON.stringify(item.permissions)],
      );
    }
    for (const [roleKey, meta] of known) {
      if (activeKeys.has(roleKey) || meta.is_system) continue;
      const [assigned] = await conn.execute('SELECT COUNT(*) AS count FROM users WHERE role=?', [roleKey]);
      if (Number(assigned[0].count))
        throw Object.assign(new Error('Reasigna los usuarios de ese rol antes de eliminarlo.'), {
          status: 409,
        });
      await conn.execute('DELETE FROM roles WHERE role_key=?', [roleKey]);
    }
    await conn.commit();
    res.json({ ok: true, roles: await getRoleCatalog() });
  } catch (error) {
    if (conn) await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn?.release();
  }
});
app.get('/api/admin/smtp', auth, primaryAdminOnly, async (req, res, next) => {
  try {
    res.json({
      smtp: {
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        user: smtpConfig.user,
        from: smtpConfig.from,
        passwordConfigured: Boolean(smtpConfig.password),
        configured: Boolean(mailer),
      },
    });
  } catch (error) {
    next(error);
  }
});
app.post('/api/admin/smtp/test', auth, primaryAdminOnly, async (req, res, next) => {
  try {
    const host = String(req.body.host || '').trim(),
      port = Number(req.body.port || 587),
      secure = req.body.secure === true,
      user = String(req.body.user || '').trim(),
      password = resolveSmtpPassword({ host, port, secure, user, password: String(req.body.password || '') }, smtpConfig),
      from = String(req.body.from || '').trim(),
      testEmail = String(req.body.testEmail || '')
        .trim()
        .toLowerCase();
    if (
      !host ||
      host.length > 255 ||
      /[\r\n\0]/.test(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      /[\r\n\0]/.test(user) ||
      user.length > 255 ||
      password.length > 1024 ||
      /[\r\n\0]/.test(from) ||
      from.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail) ||
      testEmail.length > 254
    )
      return res
        .status(400)
        .json({ error: 'Revisa el host, puerto, seguridad, usuario, remitente y correo de prueba.' });
    if (Boolean(user) !== Boolean(password))
      return res
        .status(400)
        .json({ error: 'Completa tanto el usuario SMTP como su contraseña, o deja ambos vacíos.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from.match(/<([^>]+)>/)?.[1] || from))
      return res.status(400).json({ error: 'El remitente debe contener un correo válido.' });
    const nextConfig = { host, port, secure, user, password, from },
      transport = buildMailer(nextConfig);
    if (!transport) return res.status(400).json({ error: 'Los datos SMTP están incompletos.' });
    await transport.verify();
    await transport.sendMail({
      from,
      to: testEmail,
      subject: 'Teralth Wiki SMTP test',
      text: 'This is a test message confirming that Teralth Wiki can send email with this SMTP configuration.',
    });
    const proof = crypto.randomBytes(32).toString('base64url'),
      proofData = {
        signature: smtpSignature({ ...nextConfig, testEmail }),
        expires: Date.now() + 5 * 60 * 1000,
      };
    smtpProofs.set(req.sessionID, { proof, ...proofData });
    res.json({ ok: true, proof, expiresIn: 300 });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    const details = redactDiagnostic(error, [
      req.body?.host,
      req.body?.user,
      req.body?.password,
      smtpConfig.password,
      req.body?.from,
      req.body?.testEmail,
    ]);
    const code =
        String(error?.code || error?.name || 'SMTP_ERROR')
          .replace(/[^A-Za-z0-9_-]/g, '')
          .slice(0, 80) || 'SMTP_ERROR',
      command = String(error?.command || '')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 40),
      responseCode = Number.isInteger(Number(error?.responseCode)) ? Number(error.responseCode) : undefined;
    console.error(
      '[Teralth Wiki] SMTP test failed',
      JSON.stringify({ code, command, responseCode, details }),
    );
    res.status(502).json({ error: 'No se pudo verificar SMTP ni enviar el correo de prueba.', details });
  }
});
app.put('/api/admin/smtp', auth, primaryAdminOnly, async (req, res, next) => {
  try {
    const host = String(req.body.host || '').trim(),
      port = Number(req.body.port || 587),
      secure = req.body.secure === true,
      user = String(req.body.user || '').trim(),
      password = resolveSmtpPassword({ host, port, secure, user, password: String(req.body.password || '') }, smtpConfig),
      from = String(req.body.from || '').trim(),
      testEmail = String(req.body.testEmail || '')
        .trim()
        .toLowerCase(),
      proof = smtpProofs.get(req.sessionID),
      nextConfig = { host, port, secure, user, password, from };
    if (
      !proof ||
      proof.proof !== String(req.body.proof || '') ||
      proof.expires < Date.now() ||
      proof.signature !== smtpSignature({ ...nextConfig, testEmail })
    )
      return res
        .status(428)
        .json({
          error: 'Primero realiza y confirma el envío de un correo de prueba con estos mismos valores.',
        });
    await query(
      "INSERT INTO settings (setting_key,setting_value) VALUES ('smtp',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
      [
        JSON.stringify({
          host,
          port,
          secure,
          user,
          from,
          passwordEncrypted: password ? encryptSmtpPassword(password) : '',
        }),
      ],
    );
    smtpConfig = nextConfig;
    mailer = buildMailer(smtpConfig);
    smtpProofs.delete(req.sessionID);
    res.json({
      ok: true,
      smtp: {
        host,
        port,
        secure,
        user,
        from,
        passwordConfigured: Boolean(password),
        configured: Boolean(mailer),
      },
    });
  } catch (error) {
    next(error);
  }
});
app.delete('/api/admin/users/:id', auth, requirePermission('users.delete'), async (req, res, next) => {
  let conn;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Usuario no válido.' });
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT id,is_primary_admin FROM users WHERE id=? FOR UPDATE', [id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (rows[0].is_primary_admin) {
      await conn.rollback();
      return res.status(403).json({ error: 'La cuenta principal del sitio no se puede eliminar.' });
    }
    await conn.execute('DELETE FROM users WHERE id=?', [id]);
    await conn.commit();
    await invalidateUserSessions(id);
    if (id === Number(req.session.user.id))
      return req.session.destroy((error) =>
        error
          ? next(error)
          : res
              .clearCookie('teralth.sid', {
                httpOnly: true,
                sameSite: 'strict',
                secure: process.env.NODE_ENV === 'production',
              })
              .json({ ok: true, selfDeleted: true }),
      );
    res.json({ ok: true });
  } catch (error) {
    if (conn) await conn.rollback().catch(() => {});
    next(error);
  } finally {
    conn?.release();
  }
});
app.post(
  '/api/admin/users/:id/reset-password',
  auth,
  adminRecoveryLimiter,
  requirePermission('users.reset_password'),
  async (req, res, next) => {
    let conn;
    try {
      if (!mailer)
        return res
          .status(503)
          .json({ error: 'SMTP debe estar configurado para enviar una contraseña temporal.' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Usuario no válido.' });
      const [rows] = await query('SELECT id,email,username,is_primary_admin FROM users WHERE id=?', [id]);
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
      if (user.is_primary_admin)
        return res
          .status(403)
          .json({ error: 'La recuperación administrativa de esta cuenta está desactivada.' });
      const temporaryPassword = generateTemporaryPassword(),
        passwordHash = await bcrypt.hash(temporaryPassword, 12);
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [oldRows] = await conn.execute(
        'SELECT password_hash,previous_password_hash,must_change_password FROM users WHERE id=? FOR UPDATE',
        [id],
      );
      const prior = oldRows[0];
      const previousHash =
        prior.must_change_password && prior.previous_password_hash
          ? prior.previous_password_hash
          : prior.password_hash;
      await conn.execute(
        'UPDATE users SET previous_password_hash=?,password_hash=?,must_change_password=TRUE,temporary_password_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR) WHERE id=?',
        [previousHash, passwordHash, id],
      );
      const date = new Intl.DateTimeFormat('es-EC', {
          dateStyle: 'long',
          timeZone: 'America/Guayaquil',
        }).format(new Date()),
        hour = new Intl.DateTimeFormat('es-EC', { timeStyle: 'short', timeZone: 'America/Guayaquil' }).format(
          new Date(),
        ),
        expiresAt = new Intl.DateTimeFormat('es-EC', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'America/Guayaquil',
        }).format(new Date(Date.now() + 3600000));
      await enqueueMail(
        user.email,
        'Temporary password',
        emailTemplate('temporary_password.html', {
          username: user.username,
          email: user.email,
          date,
          hour,
          temporary_password: temporaryPassword,
          expires_at: expiresAt,
        }),
        conn,
      );
      await conn.commit();
      await invalidateUserSessions(id);
      res.json({ ok: true });
    } catch (error) {
      if (conn) await conn.rollback().catch(() => {});
      next(error);
    } finally {
      conn?.release();
    }
  },
);
app.get(
  '/api/admin/users',
  auth,
  requireAnyPermission(['users.edit', 'users.delete', 'users.role', 'users.reset_password']),
  async (req, res, next) => {
    try {
      res.json({
        users: await query(
          'SELECT id,email,username,role,verified_at,created_at,is_primary_admin AS isPrimaryAdmin FROM users ORDER BY created_at DESC',
        ),
        roles: await getRoleCatalog(),
      });
    } catch (e) {
      next(e);
    }
  },
);
app.patch('/api/admin/users/:id/role', auth, requirePermission('users.role'), async (req, res, next) => {
  try {
    const roleKey = String(req.body.roleKey || '');
    if (roleKey.length < 1 || roleKey.length > 64) return res.status(400).json({ error: 'Rol no válido.' });
    const targetId = Number(req.params.id);
    const [target] = await query('SELECT id,is_primary_admin FROM users WHERE id=?', [targetId]);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (target.is_primary_admin)
      return res.status(403).json({ error: 'El rol de la cuenta principal no se puede modificar.' });
    const [role] = await query('SELECT role_key,permissions FROM roles WHERE role_key=?', [roleKey]);
    if (!role) return res.status(400).json({ error: 'Selecciona un rol existente.' });
    const [actor] = await query(
      'SELECT u.role,u.is_primary_admin,r.permissions FROM users u LEFT JOIN roles r ON r.role_key=u.role WHERE u.id=?',
      [req.session.user.id],
    );
    const actorPermissions =
        actor?.is_primary_admin || actor?.role === 'administrator'
          ? rolePermissionsDefault
          : actor?.permissions
            ? json(actor.permissions)
            : [],
      targetPermissions = json(role.permissions);
    if (targetPermissions.some((permission) => !actorPermissions.includes(permission)))
      return res.status(403).json({ error: 'No puedes asignar un rol con permisos superiores a los tuyos.' });
    const [result] = await pool.execute('UPDATE users SET role=? WHERE id=? AND verified_at IS NOT NULL', [
      roleKey,
      targetId,
    ]);
    if (!result.affectedRows)
      return res.status(404).json({ error: 'Usuario no verificado o no encontrado.' });
    if (targetId === Number(req.session.user.id)) {
      const previousTwoFactorBinding = req.session.twoFactorBinding;
      await invalidateUserSessions(targetId);
      await new Promise((resolve, reject) =>
        req.session.regenerate((error) => (error ? reject(error) : resolve())),
      );
      const [updated] = await query(
        'SELECT id,email,username,role,is_primary_admin,must_change_password,two_factor_secret FROM users WHERE id=?',
        [targetId],
      );
      req.session.user = userView(updated);
      if (previousTwoFactorBinding) req.session.twoFactorBinding = previousTwoFactorBinding;
      req.session.csrfToken = token();
      await new Promise((resolve, reject) =>
        req.session.save((error) => (error ? reject(error) : resolve())),
      );
      return res.json({ ok: true, csrfToken: req.session.csrfToken, user: await publicUserView(updated) });
    }
    await invalidateUserSessions(targetId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
async function editableLanguageCode(code) {
  if (!validLanguageCode(code) || ['en', 'es'].includes(code.toLowerCase())) return null;
  const [row] = await query("SELECT setting_value FROM settings WHERE setting_key='language_catalog'");
  const catalog = row ? json(row.setting_value) : [];
  return catalog.find((item) => item.code.toLowerCase() === code.toLowerCase())?.code || null;
}
app.get(
  '/api/admin/languages/:code/translations',
  auth,
  requirePermission('languages.edit'),
  async (req, res, next) => {
    try {
      const code = await editableLanguageCode(String(req.params.code));
      if (!code) return res.status(403).json({ error: 'Este idioma no se puede editar.' });
      const dictionary = JSON.parse(await fs.promises.readFile(languageFile(code), 'utf8'));
      if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary))
        return res.status(500).json({ error: 'El archivo de idioma no tiene un formato válido.' });
      res.json({
        code,
        translations: Object.fromEntries(
          Object.entries(dictionary).filter(([key, value]) => key !== '_meta' && typeof value === 'string'),
        ),
      });
    } catch (error) {
      if (error.code === 'ENOENT')
        return res.status(404).json({ error: 'No existe el archivo JSON de este idioma.' });
      next(error);
    }
  },
);
app.put(
  '/api/admin/languages/:code/translations',
  auth,
  requirePermission('languages.edit'),
  async (req, res, next) => {
    try {
      const code = await editableLanguageCode(String(req.params.code));
      if (!code) return res.status(403).json({ error: 'Este idioma no se puede editar.' });
      const file = languageFile(code),
        dictionary = JSON.parse(await fs.promises.readFile(file, 'utf8')),
        submitted = req.body.translations;
      if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted))
        return res.status(400).json({ error: 'Las traducciones enviadas no tienen un formato válido.' });
      const keys = Object.keys(dictionary).filter(
          (key) => key !== '_meta' && typeof dictionary[key] === 'string',
        ),
        submittedKeys = Object.keys(submitted);
      if (
        keys.length > 1000 ||
        submittedKeys.length !== keys.length ||
        keys.some((key) => !Object.prototype.hasOwnProperty.call(submitted, key))
      )
        return res.status(400).json({ error: 'El conjunto de claves no coincide con el archivo de idioma.' });
      for (const key of keys)
        if (typeof submitted[key] !== 'string' || submitted[key].length > 12000)
          return res
            .status(400)
            .json({ error: 'Cada traducción debe ser texto y no superar 12 000 caracteres.' });
      const output = {
        ...dictionary,
        ...Object.fromEntries(keys.map((key) => [key, submitted[key]])),
        _meta: { ...(dictionary._meta || {}), code },
      };
      const temporary = file + '.tmp-' + crypto.randomUUID();
      await fs.promises.writeFile(temporary, JSON.stringify(output, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o640,
      });
      await fs.promises.rename(temporary, file);
      res.json({ ok: true, code, updatedKeys: keys.length });
    } catch (error) {
      if (error.code === 'ENOENT')
        return res.status(404).json({ error: 'No existe el archivo JSON de este idioma.' });
      next(error);
    }
  },
);
app.put('/api/admin/languages', auth, async (req, res, next) => {
  try {
    const languages = req.body.languages;
    if (!Array.isArray(languages) || languages.length < 2 || languages.length > 30)
      return res.status(400).json({ error: 'Agrega entre 2 y 30 idiomas.' });
    const codes = new Set();
    for (const entry of languages) {
      if (
        !entry ||
        !validLanguageCode(entry.code) ||
        typeof entry.name !== 'string' ||
        !entry.name.trim() ||
        entry.name.trim().length > 80 ||
        typeof entry.enabled !== 'boolean'
      )
        return res.status(400).json({ error: 'Revisa el código, nombre y estado de cada idioma.' });
      const normalized = entry.code.toLowerCase();
      if (codes.has(normalized)) return res.status(400).json({ error: 'Hay códigos de idioma duplicados.' });
      codes.add(normalized);
    }
    const hasEnglish = languages.some((item) => item.code.toLowerCase() === 'en' && item.enabled),
      hasSpanish = languages.some((item) => item.code.toLowerCase() === 'es' && item.enabled);
    if (!hasEnglish || !hasSpanish)
      return res.status(400).json({ error: 'English and Spanish must remain enabled.' });
    const [priorRow] = await query("SELECT setting_value FROM settings WHERE setting_key='language_catalog'");
    const priorCatalog = priorRow ? json(priorRow.setting_value) : [];
    for (const item of languages) {
      const previousCode = String(item.previousCode || item.code),
        old = priorCatalog.find((entry) => entry.code.toLowerCase() === previousCode.toLowerCase());
      if (!old) {
        if (!(await canUser(req.session.user.id, 'languages.create')))
          return res.status(403).json({ error: 'No tienes permiso para crear idiomas.' });
      } else {
        const changed =
          old.code !== item.code || old.name !== item.name.trim() || Boolean(old.enabled) !== item.enabled;
        if (changed && !(await canUser(req.session.user.id, 'languages.edit')))
          return res.status(403).json({ error: 'No tienes permiso para editar idiomas.' });
      }
    }
    for (const old of priorCatalog)
      if (
        !languages.some((item) => item.code.toLowerCase() === old.code.toLowerCase()) &&
        !(await canUser(req.session.user.id, 'languages.delete'))
      )
        return res.status(403).json({ error: 'No tienes permiso para eliminar idiomas.' });
    if (
      languages.some(
        (item) => item.previousCode && !priorCatalog.some((old) => old.code === item.previousCode),
      )
    )
      return res.status(400).json({ error: 'Un código de idioma anterior no es válido.' });
    const prepared = languages.map((item) => ({
      code: ['en', 'es'].includes(item.code.toLowerCase()) ? item.code.toLowerCase() : item.code.trim(),
      name: item.name.trim(),
      enabled: ['en', 'es'].includes(item.code.toLowerCase()) ? true : item.enabled,
      previousCode: String(item.previousCode || '').trim(),
    }));
    for (const item of prepared) {
      const previous = item.previousCode && priorCatalog.find((old) => old.code === item.previousCode);
      await writeLanguageFile(item, previous && previous.code !== item.code ? previous.code : '');
    }
    const active = prepared.filter((item) => item.enabled).map((item) => item.code),
      catalog = prepared.map(({ code, name, enabled }) => ({ code, name, enabled }));
    await query(
      "INSERT INTO settings (setting_key,setting_value) VALUES ('language_catalog',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
      [JSON.stringify(catalog)],
    );
    await query(
      "INSERT INTO settings (setting_key,setting_value) VALUES ('languages',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
      [JSON.stringify(active)],
    );
    for (const item of prepared) {
      if (!item.previousCode || item.previousCode === item.code) continue;
      for (const row of await query('SELECT id,titles,content FROM pages')) {
        let titles = json(row.titles),
          content = json(row.content),
          changed = false;
        if (Object.prototype.hasOwnProperty.call(titles, item.previousCode)) {
          titles[item.code] = titles[item.previousCode];
          delete titles[item.previousCode];
          changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(content, item.previousCode)) {
          content[item.code] = content[item.previousCode];
          delete content[item.previousCode];
          changed = true;
        }
        if (changed)
          await query('UPDATE pages SET titles=?,content=? WHERE id=?', [
            JSON.stringify(titles),
            JSON.stringify(content),
            row.id,
          ]);
      }
      for (const row of await query('SELECT id,names FROM categories')) {
        const names = json(row.names);
        if (Object.prototype.hasOwnProperty.call(names, item.previousCode)) {
          names[item.code] = names[item.previousCode];
          delete names[item.previousCode];
          await query('UPDATE categories SET names=? WHERE id=?', [JSON.stringify(names), row.id]);
        }
      }
    }
    for (const old of priorCatalog) {
      if (!validLanguageCode(old.code) || ['en', 'es'].includes(String(old.code).toLowerCase())) continue;
      if (!prepared.some((item) => item.code.toLowerCase() === String(old.code).toLowerCase()))
        await fs.promises.unlink(languageFile(old.code)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
    for (const item of prepared) {
      if (
        item.previousCode &&
        validLanguageCode(item.previousCode) &&
        item.previousCode.toLowerCase() !== item.code.toLowerCase() &&
        !['en', 'es'].includes(item.previousCode.toLowerCase()) &&
        !prepared.some((other) => other.code.toLowerCase() === item.previousCode.toLowerCase())
      )
        await fs.promises.unlink(languageFile(item.previousCode)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
    res.json({ ok: true, languages: active, languageCatalog: catalog });
  } catch (e) {
    next(e);
  }
});
app.patch('/api/admin/spaces/:slug/logo', auth, requirePermission('spaces.edit'), async (req, res, next) => {
  try {
    const slug = spaceSlugify(req.params.slug),
      logo = String(req.body.logo || '');
    if (!slug || (logo && !/^\/media\/[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/.test(logo)))
      return res.status(400).json({ error: 'El logotipo del espacio no es válido.' });
    const [spaces] = await query('SELECT slug FROM spaces WHERE slug=?', [slug]);
    if (!spaces.length) return res.status(404).json({ error: 'Espacio de documentación no encontrado.' });
    await query('UPDATE spaces SET logo=? WHERE slug=?', [logo, slug]);
    res.json({ ok: true, logo });
  } catch (error) {
    next(error);
  }
});
app.put('/api/admin/settings', auth, async (req, res, next) => {
  try {
    const { name, logo, spaces, supportUrl } = req.body,
      pageTitle = req.body.pageTitle,
      favicon = req.body.favicon,
      sidebarLabel = req.body.sidebarLabel;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 120 ||
      !Array.isArray(spaces) ||
      spaces.length > 100 ||
      (pageTitle !== undefined &&
        (typeof pageTitle !== 'string' || !pageTitle.trim() || pageTitle.trim().length > 120)) ||
      (favicon !== undefined && typeof favicon !== 'string') ||
      (sidebarLabel !== undefined &&
        (typeof sidebarLabel !== 'string' || !sidebarLabel.trim() || sidebarLabel.trim().length > 80))
    )
      return res
        .status(400)
        .json({ error: 'Revisa los nombres del sitio, el título de página y la lista de espacios.' });
    const preUsedSlugs = new Set(),
      preReserved = new Set(['api', 'login', 'register', 'reset', 'admin', 'verify', 'media', 'two-factor', 'two-factor-setup']);
    for (const sp of spaces) {
      if (!sp || typeof sp !== 'object' || Array.isArray(sp))
        return res.status(400).json({ error: 'Uno de los espacios no es válido o está duplicado.' });
      const normalized = spaceSlugify(sp.slug || sp.name);
      if (
        !validFontAwesomeIcon(String(sp.icon || 'fa-book-open')) ||
        (String(sp.logo || '') && !/^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/.test(String(sp.logo)))
      )
        return res
          .status(400)
          .json({ error: 'Cada espacio debe usar un ícono Font Awesome válido o una imagen local subida.' });
      if (
        !normalized ||
        preReserved.has(normalized.toLowerCase()) ||
        preUsedSlugs.has(normalized) ||
        typeof sp.name !== 'string' ||
        !sp.name.trim() ||
        sp.name.length > 120
      )
        return res.status(400).json({ error: 'Uno de los espacios no es válido o está duplicado.' });
      preUsedSlugs.add(normalized);
    }
    const [siteRow] = await query("SELECT setting_value FROM settings WHERE setting_key='site'");
    const oldSite = siteRow ? json(siteRow.setting_value) : {};
    const options = normalizeSiteOptions(req.body, oldSite);
    const normalizedSupportUrl = normalizeSupportUrl(supportUrl === undefined ? String(oldSite.supportUrl || '') : supportUrl);
    const normalizedPageTitle = name.trim(),
      normalizedFavicon = String(
        favicon === undefined ? oldSite.favicon || '/assets/favicon.svg' : favicon,
      ).trim();
    if (
      normalizedFavicon !== '/assets/favicon.svg' &&
      !/^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/.test(normalizedFavicon)
    )
      return res.status(400).json({ error: 'Sube un favicon local válido o elige el icono predeterminado.' });
    if (
      (name.trim() !== String(oldSite.name || '') ||
        String(logo || '') !== String(oldSite.logo || '') ||
        normalizedFavicon !== String(oldSite.favicon || '/assets/favicon.svg')) &&
      !(await canUser(req.session.user.id, 'settings.identity'))
    )
      return res.status(403).json({ error: 'No tienes permiso para cambiar la identidad del sitio.' });
    if (
      (normalizedSupportUrl !== String(oldSite.supportUrl || '') ||
        JSON.stringify(options.support || null) !== JSON.stringify(oldSite.support || null)) &&
      !(await canUser(req.session.user.id, 'settings.support'))
    )
      return res.status(403).json({ error: 'No tienes permiso para cambiar el bloque de soporte.' });
    if (
      JSON.stringify(options.seo || null) !== JSON.stringify(oldSite.seo || null) &&
      !(await canUser(req.session.user.id, 'settings.seo'))
    )
      return res.status(403).json({ error: 'No tienes permiso para cambiar el SEO.' });
    if (
      sidebarLabel !== undefined &&
      sidebarLabel.trim() !== String(oldSite.sidebarLabel || 'Documentation') &&
      !(await canUser(req.session.user.id, 'settings.sidebar_label'))
    )
      return res
        .status(403)
        .json({ error: 'No tienes permiso para cambiar el contenido del pie de página.' });
    const oldSpaces = await query('SELECT slug,name,icon,logo,sort_order FROM spaces');
    const oldSpaceMap = new Map(oldSpaces.map((item) => [item.slug, item]));
    const nextSpaceMap = new Map(spaces.map((item) => [spaceSlugify(item.slug || item.name), item]));
    for (const [slug, item] of nextSpaceMap) {
      const old = oldSpaceMap.get(slug);
      if (!old && !(await canUser(req.session.user.id, 'spaces.create')))
        return res.status(403).json({ error: 'No tienes permiso para crear espacios de documentación.' });
      if (
        old &&
        (old.name !== String(item.name || '').trim() ||
          old.icon !== String(item.icon || 'fa-book-open') ||
          String(old.logo || '') !== String(item.logo || '') ||
          Number(old.sort_order) !== spaces.indexOf(item)) &&
        !(await canUser(req.session.user.id, 'spaces.edit'))
      )
        return res.status(403).json({ error: 'No tienes permiso para editar espacios de documentación.' });
    }
    for (const old of oldSpaces)
      if (
        old.slug !== 'main' &&
        !nextSpaceMap.has(old.slug) &&
        !(await canUser(req.session.user.id, 'spaces.delete'))
      )
        return res.status(403).json({ error: 'No tienes permiso para eliminar espacios de documentación.' });
    await query(
      "INSERT INTO settings (setting_key,setting_value) VALUES ('site',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
      [
        JSON.stringify({
          ...oldSite,
          name: name.trim(),
          pageTitle: normalizedPageTitle,
          logo: String(logo || '').slice(0, 500),
          favicon: normalizedFavicon,
          supportUrl: normalizedSupportUrl,
          sidebarLabel:
            sidebarLabel === undefined
              ? String(oldSite.sidebarLabel || 'Documentation')
              : sidebarLabel.trim(),
          ...options,
        }),
      ],
    );
    const usedSlugs = new Set();
    const reserved = new Set(['api', 'login', 'register', 'reset', 'admin', 'verify', 'media', 'two-factor', 'two-factor-setup']);
    for (let i = 0; i < spaces.length; i++) {
      const sp = spaces[i],
        slug = spaceSlugify(sp.slug || sp.name);
      if (
        !slug ||
        reserved.has(slug.toLowerCase()) ||
        usedSlugs.has(slug) ||
        typeof sp.name !== 'string' ||
        !sp.name.trim() ||
        sp.name.length > 120
      )
        return res.status(400).json({ error: 'Uno de los espacios no es válido o está duplicado.' });
      usedSlugs.add(slug);
      const spaceLogo = String(sp.logo || '');
      if (spaceLogo && !/^\/media\/[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/.test(spaceLogo))
        return res.status(400).json({ error: 'El logotipo del espacio debe ser una imagen local subida.' });
      await query(
        'INSERT INTO spaces (slug,name,icon,logo,sort_order) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),icon=VALUES(icon),logo=VALUES(logo),sort_order=VALUES(sort_order)',
        [slug, sp.name.trim(), String(sp.icon || 'fa-book-open').slice(0, 80), spaceLogo.slice(0, 500), i],
      );
    }
    const allowed = new Set(spaces.map((sp) => spaceSlugify(sp.slug || sp.name)));
    for (const row of await query('SELECT slug FROM spaces'))
      if (row.slug !== 'main' && !allowed.has(row.slug))
        await query('DELETE FROM spaces WHERE slug=?', [row.slug]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.put('/api/admin/pages/:slug', auth, requirePermission('pages.create_edit'), async (req, res, next) => {
  const space = activeSpace(req);
  let slug = '';
  try {
    slug = slugify(req.params.slug);
    const titles = req.body.titles,
      content = req.body.content || {},
      pageType = req.body.pageType === 'redirect' ? 'redirect' : 'content',
      redirectUrl = String(req.body.redirectUrl || '').trim();
    if (
      !slug ||
      !titles ||
      typeof titles !== 'object' ||
      Array.isArray(titles) ||
      !content ||
      typeof content !== 'object' ||
      Array.isArray(content)
    )
      return res.status(400).json({ error: 'La página no tiene un nombre o contenido válido.' });
    const languages = await languageKeys(),
      keys = Object.keys(titles);
    if (
      keys.some(
        (language) =>
          !validLanguageCode(language) ||
          !languages.includes(language) ||
          typeof titles[language] !== 'string' ||
          titles[language].length > 150,
      ) ||
      !Object.values(titles).some((value) => value.trim())
    )
      return res.status(400).json({ error: 'Completa al menos un título en un idioma activo.' });
    let safeRedirect = null;
    if (pageType === 'redirect') {
      if (!redirectUrl || redirectUrl.length > 2048)
        return res.status(400).json({ error: 'Ingresa una URL de redirección válida.' });
      try {
        const target = new URL(redirectUrl, 'https://wiki.invalid');
        if (!['http:', 'https:'].includes(target.protocol) || redirectUrl.startsWith('//')) throw new Error();
        safeRedirect = redirectUrl;
      } catch {
        return res.status(400).json({ error: 'La URL debe usar http://, https:// o una ruta local válida.' });
      }
    } else if (
      Object.entries(content).some(
        ([language, value]) =>
          !validLanguageCode(language) || !languages.includes(language) || typeof value !== 'string',
      ) ||
      !Object.values(content).some((value) => value.trim())
    )
      return res.status(400).json({ error: 'Agrega contenido en al menos un idioma activo.' });
    const categoryId = pageType === 'content' && req.body.categoryId ? Number(req.body.categoryId) : null;
    if (categoryId) {
      const [category] = await query('SELECT id FROM categories WHERE id=? AND space_slug=?', [
        categoryId,
        space,
      ]);
      if (!category) return res.status(400).json({ error: 'La categoría no pertenece a esta wiki.' });
    }
    const safeContent =
      pageType === 'content'
        ? Object.fromEntries(Object.entries(content).map(([language, value]) => [language, clean(value)]))
        : {};
    await query(
      'INSERT INTO pages (space_slug,category_id,slug,icon,page_type,redirect_url,titles,content,updated_by) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE category_id=VALUES(category_id),icon=VALUES(icon),page_type=VALUES(page_type),redirect_url=VALUES(redirect_url),titles=VALUES(titles),content=VALUES(content),updated_by=VALUES(updated_by)',
      [
        space,
        categoryId,
        slug,
        String(req.body.icon || 'fa-file-lines').slice(0, 80),
        pageType,
        safeRedirect,
        JSON.stringify(titles),
        JSON.stringify(safeContent),
        req.session.user.id,
      ],
    );
    const [saved] = await query(
      'SELECT slug,space_slug,titles,content,updated_at FROM pages WHERE space_slug=? AND slug=? LIMIT 1',
      [space, slug],
    );
    if (!saved)
      throw Object.assign(new Error('Page write could not be confirmed'), {
        code: 'PAGE_WRITE_NOT_CONFIRMED',
      });
    res
      .set('Cache-Control', 'private, no-store')
      .json({
        ok: true,
        slug: saved.slug,
        space: saved.space_slug,
        page: {
          slug: saved.slug,
          titles: json(saved.titles),
          content: json(saved.content),
          updated_at: saved.updated_at,
        },
      });
  } catch (e) {
    console.error(
      '[Teralth Wiki] Page save failed',
      JSON.stringify({
        space,
        slug,
        code: String(e.code || e.name || 'Error'),
        status: Number(e.status) || 500,
      }),
    );
    next(e);
  }
});
app.put('/api/admin/home-page', auth, requirePermission('pages.create_edit'), async (req, res, next) => {
  try {
    const space = activeSpace(req),
      pageSlug = String(req.body.pageSlug || '').trim();
    if (pageSlug) {
      const slug = slugify(pageSlug),
        [page] = await query('SELECT slug FROM pages WHERE space_slug=? AND slug=?', [space, slug]);
      if (!page) return res.status(400).json({ error: 'Selecciona una página del espacio actual.' });
      await query('UPDATE spaces SET home_page_slug=? WHERE slug=?', [slug, space]);
      return res.json({ ok: true, homePageSlug: slug });
    }
    await query('UPDATE spaces SET home_page_slug=NULL WHERE slug=?', [space]);
    res.json({ ok: true, homePageSlug: null });
  } catch (e) {
    next(e);
  }
});
app.delete('/api/admin/pages/:slug', auth, requirePermission('pages.delete'), async (req, res, next) => {
  try {
    const space = activeSpace(req),
      slug = slugify(req.params.slug),
      result = await pool.execute('DELETE FROM pages WHERE space_slug=? AND slug=?', [space, slug]);
    if (!result[0].affectedRows) return res.status(404).json({ error: 'Página no encontrada.' });
    await query('UPDATE spaces SET home_page_slug=NULL WHERE slug=? AND home_page_slug=?', [space, slug]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.put(
  '/api/admin/navigation/order',
  auth,
  requirePermission('pages.create_edit'),
  async (req, res, next) => {
    const items = req.body.items,
      space = activeSpace(req);
    if (
      !Array.isArray(items) ||
      items.length > 500 ||
      items.some(
        (item) =>
          !item ||
          !Number.isSafeInteger(Number(item.id)) ||
          Number(item.id) < 1 ||
          (item.categoryId !== null &&
            item.categoryId !== '' &&
            (!Number.isSafeInteger(Number(item.categoryId)) || Number(item.categoryId) < 1)),
      ) ||
      new Set(items.map((item) => Number(item.id))).size !== items.length
    )
      return res.status(400).json({ error: 'El orden recibido no es válido.' });
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [pageRows] = await conn.execute('SELECT id FROM pages WHERE space_slug=? FOR UPDATE', [space]);
      const existing = new Set(pageRows.map((row) => Number(row.id))),
        submitted = new Set(items.map((item) => Number(item.id)));
      if (existing.size !== submitted.size || [...existing].some((id) => !submitted.has(id)))
        throw Object.assign(
          new Error('La lista de páginas cambió. Actualiza la página e inténtalo de nuevo.'),
          { status: 409 },
        );
      for (let index = 0; index < items.length; index++) {
        const item = items[index],
          categoryId = item.categoryId ? Number(item.categoryId) : null;
        if (categoryId) {
          const [categories] = await conn.execute('SELECT id FROM categories WHERE id=? AND space_slug=?', [
            categoryId,
            space,
          ]);
          if (!categories.length)
            throw Object.assign(new Error('La categoría no pertenece a esta wiki.'), { status: 400 });
        }
        await conn.execute('UPDATE pages SET sort_order=?,category_id=? WHERE id=? AND space_slug=?', [
          index,
          categoryId,
          Number(item.id),
          space,
        ]);
      }
      await conn.commit();
      res.json({ ok: true });
    } catch (error) {
      if (conn) await conn.rollback().catch(() => {});
      next(error);
    } finally {
      conn?.release();
    }
  },
);
app.post(
  '/api/admin/categories',
  auth,
  requirePermission('categories.create_edit'),
  async (req, res, next) => {
    try {
      const names = req.body.names,
        space = activeSpace(req),
        languages = await languageKeys(),
        icon = String(req.body.icon || 'fa-folder');
      if (!validStoredIcon(icon))
        return res
          .status(400)
          .json({
            error:
              'El ícono debe ser una clase Font Awesome válida o una imagen que se haya subido al servidor.',
          });
      if (
        !names ||
        typeof names !== 'object' ||
        Array.isArray(names) ||
        languages.some(
          (language) =>
            typeof names[language] !== 'string' || !names[language].trim() || names[language].length > 120,
        ) ||
        Object.entries(names).some(
          ([language, value]) =>
            !validLanguageCode(language) || typeof value !== 'string' || value.length > 120,
        )
      )
        return res.status(400).json({ error: 'Completa el nombre de la categoría en todos los idiomas.' });
      const parentId = req.body.parentId ? Number(req.body.parentId) : null;
      if (parentId) {
        const [parent] = await query('SELECT id FROM categories WHERE id=? AND space_slug=?', [
          parentId,
          space,
        ]);
        if (!parent)
          return res.status(400).json({ error: 'La categoría principal no pertenece a esta wiki.' });
      }
      const result = await pool.execute(
        'INSERT INTO categories (space_slug,parent_id,icon,names,sort_order,is_open) VALUES (?,?,?,?,?,?)',
        [
          space,
          parentId,
          icon,
          JSON.stringify(names),
          Number(req.body.order || 0),
          req.body.isOpen === false ? 0 : 1,
        ],
      );
      res.status(201).json({ id: result[0].insertId });
    } catch (e) {
      next(e);
    }
  },
);
app.delete(
  '/api/admin/categories/:id',
  auth,
  requirePermission('categories.delete'),
  async (req, res, next) => {
    try {
      const result = await pool.execute('DELETE FROM categories WHERE id=? AND space_slug=?', [
        req.params.id,
        activeSpace(req),
      ]);
      if (!result[0].affectedRows) return res.status(404).json({ error: 'Categoría no encontrada.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
app.put(
  '/api/admin/categories/order',
  auth,
  requirePermission('categories.create_edit'),
  async (req, res, next) => {
    const categoryIds = req.body.categoryIds,
      space = activeSpace(req);
    if (
      !Array.isArray(categoryIds) ||
      categoryIds.length > 500 ||
      categoryIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1) ||
      new Set(categoryIds.map(Number)).size !== categoryIds.length
    )
      return res.status(400).json({ error: 'El orden de las categorías no es válido.' });
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [rows] = await conn.execute('SELECT id FROM categories WHERE space_slug=? FOR UPDATE', [space]);
      const existing = new Set(rows.map((row) => Number(row.id))),
        submitted = new Set(categoryIds.map(Number));
      if (existing.size !== submitted.size || [...existing].some((id) => !submitted.has(id)))
        throw Object.assign(
          new Error('La lista de categorías cambió. Actualiza la página e inténtalo de nuevo.'),
          { status: 409 },
        );
      for (let index = 0; index < categoryIds.length; index++)
        await conn.execute('UPDATE categories SET sort_order=? WHERE id=? AND space_slug=?', [
          index,
          Number(categoryIds[index]),
          space,
        ]);
      await conn.commit();
      res.json({ ok: true });
    } catch (error) {
      if (conn) await conn.rollback().catch(() => {});
      next(error);
    } finally {
      conn?.release();
    }
  },
);
app.put(
  '/api/admin/categories/:id',
  auth,
  requirePermission('categories.create_edit'),
  async (req, res, next) => {
    try {
      const names = req.body.names,
        space = activeSpace(req),
        languages = await languageKeys(),
        parentId = req.body.parentId ? Number(req.body.parentId) : null,
        icon = String(req.body.icon || 'fa-folder');
      if (!validStoredIcon(icon))
        return res
          .status(400)
          .json({
            error:
              'El ícono debe ser una clase Font Awesome válida o una imagen que se haya subido al servidor.',
          });
      if (
        !names ||
        typeof names !== 'object' ||
        Array.isArray(names) ||
        languages.some(
          (language) =>
            typeof names[language] !== 'string' || !names[language].trim() || names[language].length > 120,
        ) ||
        Object.entries(names).some(
          ([language, value]) =>
            !validLanguageCode(language) || typeof value !== 'string' || value.length > 120,
        )
      )
        return res.status(400).json({ error: 'Completa los nombres de categoría en todos los idiomas.' });
      if (parentId) {
        let ancestorId = parentId,
          seen = new Set();
        while (ancestorId) {
          if (ancestorId === Number(req.params.id))
            return res.status(400).json({ error: 'Una categoría no puede estar dentro de sí misma.' });
          if (seen.has(ancestorId))
            return res.status(400).json({ error: 'La jerarquía de categorías contiene un ciclo.' });
          seen.add(ancestorId);
          const [ancestor] = await query('SELECT id,parent_id FROM categories WHERE id=? AND space_slug=?', [
            ancestorId,
            space,
          ]);
          if (!ancestor)
            return res.status(400).json({ error: 'La categoría principal no pertenece a esta wiki.' });
          ancestorId = ancestor.parent_id ? Number(ancestor.parent_id) : null;
        }
      }
      const result = await pool.execute(
        'UPDATE categories SET names=?,icon=?,parent_id=?,sort_order=?,is_open=? WHERE id=? AND space_slug=?',
        [
          JSON.stringify(names),
          icon,
          parentId,
          Number(req.body.order || 0),
          req.body.isOpen === false ? 0 : 1,
          req.params.id,
          space,
        ],
      );
      if (!result[0].affectedRows) return res.status(404).json({ error: 'Categoría no encontrada.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
app.post(
  '/api/admin/uploads',
  auth,
  uploadLimiter,
  requireAnyPermission([
    'settings.identity',
    'settings.seo',
    'spaces.create',
    'spaces.edit',
    'pages.create_edit',
    'categories.create_edit',
  ]),
  uploadImageMiddleware,
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo de imagen.' });
      const b = req.file.buffer;
      let metadata;
      try {
        metadata = await sharp(b, { animated: true, limitInputPixels: 16000000 }).metadata();
      } catch {
        return res
          .status(400)
          .json({
            error: 'El archivo está dañado o no contiene una imagen compatible. Usa PNG, JPG, GIF o WebP.',
          });
      }
      if (
        !['png', 'jpeg', 'jpg', 'gif', 'webp'].includes(metadata.format) ||
        !metadata.width ||
        !metadata.height
      )
        return res.status(415).json({ error: 'Formato no compatible. Usa una imagen PNG, JPG, GIF o WebP.' });
      if (metadata.width * metadata.height > 16000000)
        return res.status(413).json({ error: 'La imagen supera el máximo de 16 megapíxeles.' });
      let optimized;
      try {
        optimized = await sharp(b, { animated: Number(metadata.pages || 1) > 1, limitInputPixels: 16000000 })
          .rotate()
          .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82, effort: 4, smartSubsample: true })
          .toBuffer();
      } catch {
        return res
          .status(400)
          .json({ error: 'No se pudo convertir esta imagen. Prueba con otro archivo PNG, JPG, GIF o WebP.' });
      }
      const alt = String(req.body.alt || '')
          .trim()
          .slice(0, 300),
        dir = path.resolve(__dirname, 'images');
      await fs.promises.mkdir(dir, { recursive: true });
      let filename,
        saved = false;
      for (let attempt = 0; attempt < 5 && !saved; attempt++) {
        filename = `${crypto.randomBytes(12).toString('base64url').slice(0, 16)}.webp`;
        try {
          await fs.promises.writeFile(path.join(dir, filename), optimized, { flag: 'wx', mode: 0o640 });
          saved = true;
        } catch (error) {
          if (error.code === 'EEXIST' && attempt < 4) continue;
          if (error.code === 'ENOSPC')
            return res
              .status(507)
              .json({ error: 'El servidor no tiene espacio disponible para guardar la imagen.' });
          if (['EACCES', 'EPERM', 'EROFS'].includes(error.code))
            return res
              .status(500)
              .json({
                error: 'El servidor no tiene permiso para guardar archivos en la carpeta de imágenes.',
              });
          throw error;
        }
      }
      if (!saved) throw new Error('No se pudo generar un nombre disponible para la imagen.');
      res.status(201).json({ url: `/media/${filename}`, mime: 'image/webp', alt });
    } catch (error) {
      const code = String(error.code || '');
      if (['ENOSPC', 'EDQUOT'].includes(code)) {
        console.error('[Teralth Wiki] Image upload storage full', JSON.stringify({ code }));
        return res
          .status(507)
          .json({ error: 'El almacenamiento del servidor está lleno; no se pudo guardar la imagen.' });
      }
      if (['EACCES', 'EPERM', 'EROFS'].includes(code)) {
        console.error('[Teralth Wiki] Image upload folder is not writable', JSON.stringify({ code }));
        return res
          .status(500)
          .json({ error: 'El servidor no tiene permisos de escritura en la carpeta images del proyecto.' });
      }
      if (['EIO', 'EMFILE', 'ENFILE'].includes(code)) {
        console.error('[Teralth Wiki] Image upload I/O failure', JSON.stringify({ code }));
        return res
          .status(500)
          .json({
            error: 'El servidor tuvo un problema de disco o de recursos al guardar la imagen (' + code + ').',
          });
      }
      console.error(
        '[Teralth Wiki] Image upload failed',
        JSON.stringify({
          code: code || 'UNKNOWN',
          name: String(error.name || 'Error'),
          message: String(error.message || 'Error')
            .replace(/[\r\n\t]+/g, ' ')
            .slice(0, 500),
        }),
      );
      return res
        .status(500)
        .json({
          error:
            'El servidor no pudo completar la carga de la imagen por un error interno (' +
            (code || 'UNKNOWN') +
            '). Revisa la consola del servidor.',
        });
    }
  },
);
app.get('/media/:filename', async (req, res, next) => {
  try {
    const filename = String(req.params.filename);
    let file;
    if (/^[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/.test(filename)) {
      file = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads', filename);
      try {
        await fs.promises.access(file);
      } catch {
        file = path.join(__dirname, 'images', filename);
      }
    } else if (/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(filename))
      file = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads', filename);
    else return res.sendStatus(404);
    let extension = filename.split('.').pop(),
      type = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[extension];
    if (extension !== 'webp') {
      const cacheDir = path.resolve(__dirname, process.env.DATA_DIR || 'data', 'media-cache'),
        cacheFile = path.join(cacheDir, path.basename(filename) + '.webp');
      await fs.promises.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      try {
        await fs.promises.access(cacheFile);
      } catch {
        const optimized = await sharp(file, { animated: true, limitInputPixels: 16000000 })
          .rotate()
          .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82, effort: 4, smartSubsample: true })
          .toBuffer();
        try {
          await fs.promises.writeFile(cacheFile, optimized, { flag: 'wx', mode: 0o640 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      file = cacheFile;
      type = 'image/webp';
    }
    res.set({
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (e) {
    next(e);
  }
});
const escapeHeadValue = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const sendAppIndex = sendPublicHtml('index.html', async (html, req) => {
  const [row] = await query("SELECT setting_value FROM settings WHERE setting_key='site' LIMIT 1"),
    site = row ? json(row.setting_value) : {},
    name = String(site.name || site.pageTitle || process.env.SITE_NAME || 'Teralth Wiki')
      .trim()
      .slice(0, 120),
    favicon = /^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/.test(String(site.favicon || ''))
      ? String(site.favicon)
      : '/assets/favicon.svg',
    seo = site.seo || {},
    privatePage = /^\/(?:admin|login|register|reset|verify|change-password|two-factor(?:-setup)?)(?:\/|$)/.test(req.path || ''),
    meta = (key, value, attr = 'name') =>
      `<meta ${attr}="${key}" content="${escapeHeadValue(value)}">`;
  let head = meta('robots', privatePage || seo.indexable === false ? 'noindex, nofollow' : 'index, follow');
  if (seo.description) head += meta('description', seo.description);
  if (seo.socialDescription || seo.description)
    head += meta('og:description', seo.socialDescription || seo.description, 'property');
  if (seo.socialImage) {
    const imageBase = seo.canonicalBase || process.env.BASE_URL;
    const image = seo.socialImage.startsWith('/') && imageBase ? new URL(seo.socialImage, imageBase).href : seo.socialImage;
    head += meta('og:image', image, 'property');
  }
  if (!privatePage && seo.canonicalBase) {
    const base = new URL(seo.canonicalBase);
    const canonical = base.origin + base.pathname.replace(/\/$/, '') + (req.path || '/');
    head += `<link rel="canonical" href="${escapeHeadValue(canonical)}">`;
  }
  return html
    .replace('</head>', head + '</head>')
    .replace(/<title>[^<]*<\/title>/i, '<title>' + escapeHeadValue(name) + '</title>')
    .replace(
      /<meta name="application-name" content="[^"]*"\s*\/?\s*>/i,
      '<meta name="application-name" content="' + escapeHeadValue(name) + '">',
    )
    .replace(
      /<meta property="og:title" content="[^"]*"\s*\/?\s*>/i,
      '<meta property="og:title" content="' + escapeHeadValue(seo.socialTitle || name) + '">',
    )
    .replace(
      /<link id="siteFavicon"[^>]*>/i,
      '<link id="siteFavicon" rel="icon" type="' +
        (favicon.startsWith('/media/') ? 'image/webp' : 'image/svg+xml') +
        '" href="' +
        escapeHeadValue(favicon) +
        '">',
    );
});
app.get(['/login', '/register', '/reset', '/verify'], sendAppIndex);
const adminPanelPermissions = ['admin.view'];
app.get(/^\/admin(?:\/.*)?$/, async (req, res, next) => {
  if (!req.session.user) return res.redirect(303, '/login?next=%2Fadmin');
  try {
    const [current] = await query('SELECT must_change_password FROM users WHERE id=?', [req.session.user.id]);
    if (!current) return res.redirect(303, '/login?next=%2Fadmin');
    if (current.must_change_password) return res.redirect(303, '/change-password');
    const allowed = await Promise.all(
      adminPanelPermissions.map((permission) => canUser(req.session.user.id, permission)),
    );
    if (!allowed[0]) return res.sendStatus(404);
    return sendAppIndex(req, res, next);
  } catch (error) {
    next(error);
  }
});
app.get(/^\/(?:[^/]+(?:\/[^/]+)*)?\/?$/, sendAppIndex);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = String(err.code || err.name || 'Error'),
    message = String(err.sqlMessage || err.message || 'Request failed')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 1200),
    status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  if (status === 404 && code === 'ENOENT' && req.path.startsWith('/media/')) return res.sendStatus(404);
  if (status >= 500)
    console.error(
      '[Teralth Wiki] Request error',
      JSON.stringify({
        method: req.method,
        path: req.path,
        status,
        code,
        message,
        stack: String(err.stack || '').slice(0, 3000),
      }),
    );
  const publicCode =
    status >= 500 && /^[A-Z0-9_]{1,60}$/.test(String(err.code || ''))
      ? String(err.code)
      : status >= 500
        ? 'INTERNAL_SERVER_ERROR'
        : undefined;
  res
    .status(status)
    .json({
      ...(publicCode ? { code: publicCode } : {}),
      error:
        status >= 500
          ? 'Ocurrió un error. Inténtalo de nuevo.'
          : String(err.message || 'No se pudo completar la solicitud.'),
    });
});

initialize()
  .then(async () => {
    await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await pruneBackups();
    const timer = setInterval(
      () =>
        expireTemporaryPasswords().catch((error) =>
          console.error(
            'No se pudo revisar el vencimiento de contraseñas temporales:',
            error.code || error.name || 'Error',
          ),
        ),
      60_000,
    );
    timer.unref();
    const rateLimitCleanupTimer = setInterval(
      () =>
        pool
          .execute('DELETE FROM rate_limit_buckets WHERE reset_at<?', [Date.now()])
          .catch((error) =>
            console.error(
              'No se pudo limpiar los límites de solicitudes:',
              error.code || error.name || 'Error',
            ),
          ),
      3_600_000,
    );
    rateLimitCleanupTimer.unref();
    const schemaTimer = setInterval(
      () =>
        repairMissingTables().catch((error) =>
          console.error('No se pudo revisar el esquema MySQL:', error.code || error.name || 'Error'),
        ),
      2_000,
    );
    schemaTimer.unref();
    expireTemporaryPasswords().catch(() => {});
    startBackgroundJobWorker();
    scheduleBackupJob();
    const port = Number(process.env.PORT || 3000);
    const host =
      process.env.NODE_ENV === 'production' && ['127.0.0.1', 'localhost'].includes(process.env.HOST)
        ? '0.0.0.0'
        : process.env.HOST || '127.0.0.1';
    httpServer = app.listen(port, host, () => console.log(`Teralth Wiki escucha en ${host}:${port}`));
  })
  .catch((err) => {
    console.error('No fue posible iniciar la aplicación:', err.code || err.message);
    if (err.sqlMessage || err.message)
      console.error('Detalle MySQL:', String(err.sqlMessage || err.message).slice(0, 1200));
    if (err.teralthSchemaStatement)
      console.error('Operación de esquema:', String(err.teralthSchemaStatement).slice(0, 700));
    process.exitCode = 1;
  });
