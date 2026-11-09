const dotenv = require('dotenv');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const helmet = require('helmet');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const { rateLimit } = require('express-rate-limit');
const { createSiteRateLimiter } = require('./scripts/site-rate-limit');
const { senderEmailAddress, validEmailAddress } = require('./scripts/auth/email-address');
const { publicScripts, publicStaticOnly, sendPublicHtml } = require('./scripts/public-scripts');
const { saveInstallerImages } = require('./scripts/installer-images');

const root = __dirname;
const envPath = path.join(root, '.env');
const setupKeyPath = path.join(root, 'setup.key');
dotenv.config({ path: envPath });
const requiredKeys = [
  'SESSION_SECRET',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'ADMIN_INITIAL_PASSWORD',
  'ADMIN_EMAIL',
  'ADMIN_USERNAME',
  'BASE_URL',
];
const hasUnchangedExamples = requiredKeys.some((key) =>
  /^(replace-with|admin@example\.com)$/i.test(String(process.env[key] || '').trim()),
);
const isConfigured =
  requiredKeys.every((key) => Boolean(String(process.env[key] || '').trim())) && !hasUnchangedExamples;
class SetupInputError extends Error {}

function startWiki() {
  let child;
  let stopping = false;
  const stop = (signal) => {
    stopping = true;
    child?.kill(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal));
  const launch = () => {
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      console.error('No fue posible iniciar la wiki:', error.code || error.name);
      process.exitCode = 1;
    });
    child.once('close', (code) => {
      if (code === 75 && !stopping) return launch();
      process.exit(code ?? process.exitCode ?? 0);
    });
  };
  launch();
}

function setupKey() {
  try {
    fs.writeFileSync(setupKeyPath, `${crypto.randomBytes(32).toString('base64url')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  try {
    fs.chmodSync(setupKeyPath, 0o600);
  } catch {}
  return fs.readFileSync(setupKeyPath, 'utf8').trim();
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function cleanText(value, max = 255) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text))
    throw new SetupInputError('Completa todos los campos obligatorios con valores válidos.');
  return text;
}

function validateDatabase(body) {
  const host = cleanText(body.dbHost, 255);
  const database = cleanText(body.dbName, 64);
  const user = cleanText(body.dbUser, 128);
  const password = cleanText(body.dbPassword, 1024);
  const port = Number(body.dbPort);
  if (!validPort(port)) throw new SetupInputError('El puerto MySQL debe estar entre 1 y 65535.');
  return { host, port, database, user, password, ssl: body.dbSsl === true };
}

async function verifyDatabase(credentials, checkSchemaAccess = false) {
  const connection = await mysql.createConnection({
    host: credentials.host,
    port: credentials.port,
    user: credentials.user,
    password: credentials.password,
    database: credentials.database,
    ssl: credentials.ssl ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 8000,
    enableKeepAlive: true,
  });
  let probeName;
  try {
    await connection.query('SELECT 1');
    if (checkSchemaAccess) {
      probeName = `wiki_setup_probe_${crypto.randomBytes(8).toString('hex')}`;
      await connection.query(`CREATE TABLE \`${probeName}\` (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
    }
  } finally {
    if (probeName) await connection.query(`DROP TABLE IF EXISTS \`${probeName}\``).catch(() => {});
    await connection.end();
  }
}

const verifiedDbSignatures = new Set();
const verifiedEmailSignatures = new Set();
const signatureKey = crypto.randomBytes(32);
function rememberSignature(signatures, signature) {
  signatures.delete(signature);
  signatures.add(signature);
  if (signatures.size > 64) signatures.delete(signatures.values().next().value);
}
function requestSignature(value) {
  return crypto.createHmac('sha256', signatureKey).update(JSON.stringify(value)).digest('hex');
}
function databaseSignature(body) {
  return requestSignature(validateDatabase(body));
}
function emailSignature(body) {
  const values = {
    host: String(body.smtpHost ?? '')
      .trim()
      .toLowerCase(),
    port: Number(body.smtpPort || 587),
    user: String(body.smtpUser ?? '').trim(),
    password: String(body.smtpPassword ?? ''),
    from: String(body.smtpFrom ?? '').trim(),
    secure: body.smtpSecure === true,
    testEmail: String(body.smtpTestEmail ?? '')
      .trim()
      .toLowerCase(),
  };
  return requestSignature(values);
}
const validEmail = validEmailAddress;
function validSender(value) {
  return validEmail(senderEmailAddress(value));
}
function diagnosticDetails(error, secrets = []) {
  let message = String(error?.message || error?.code || 'Connection failed')
    .split(/[\r\n]/, 1)[0].replace(/\t/g, ' ')
    .slice(0, 700);
  for (const secret of secrets
    .filter(Boolean)
    .map(String)
    .sort((a, b) => b.length - a.length))
    message = message.split(secret).join('[redacted]');
  const rawCode = String(error?.code || error?.name || 'CONNECTION_ERROR');
  return { code: /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : 'CONNECTION_ERROR', message };
}

function validateInstall(body) {
  const db = validateDatabase(body);
  const name = cleanText(body.siteName, 120);
  const email = cleanText(body.adminEmail, 254).toLowerCase();
  const username = cleanText(body.adminUsername, 60);
  const password = String(body.adminPassword ?? '');
  if (password !== String(body.adminPasswordConfirm ?? ''))
    throw new SetupInputError('Las contraseñas iniciales no coinciden.');
  const baseUrl = cleanText(body.baseUrl, 500).replace(/\/$/, '');
  const nodeEnv = body.nodeEnv === 'production' ? 'production' : 'development';
  const host = cleanText(body.appHost || (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'), 255);
  const port = Number(body.appPort);
  if (!validPort(port)) throw new SetupInputError('El puerto de la aplicación debe estar entre 1 y 65535.');
  if (!/^\S+@\S+\.\S+$/.test(email))
    throw new SetupInputError('Ingresa un correo válido para la cuenta administradora.');
  if (username.length < 2 || !/^[\p{L}\p{N}_.-]+$/u.test(username))
    throw new SetupInputError(
      'El nombre de usuario debe tener entre 2 y 60 letras, números, puntos, guiones o guiones bajos.',
    );
  if (
    password.length < 16 ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  )
    throw new SetupInputError(
      'La contraseña inicial debe tener 16 caracteres como mínimo, con mayúscula, minúscula, número y símbolo.',
    );
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new SetupInputError('Ingresa una URL base válida.');
  }
  if (
    !['http:', 'https:'].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    parsedUrl.pathname !== '/' ||
    (nodeEnv === 'production' && parsedUrl.protocol !== 'https:')
  )
    throw new SetupInputError(
      'Usa solo el origen público de la wiki. En producción debe comenzar con https://.',
    );
  const smtpHost = String(body.smtpHost ?? '').trim();
  const smtpUser = String(body.smtpUser ?? '').trim();
  const smtpPassword = String(body.smtpPassword ?? '');
  const smtpPort = Number(body.smtpPort || 587);
  const smtpFrom = cleanText(body.smtpFrom, 254);
  const smtpTestEmail = cleanText(body.smtpTestEmail, 254).toLowerCase();
  for (const value of [smtpHost, smtpUser, smtpPassword, smtpFrom])
    if (/[\r\n\0]/.test(value)) throw new Error('Revisa los datos SMTP.');
  if (smtpHost.length > 255 || smtpUser.length > 255 || smtpPassword.length > 1024 || smtpFrom.length > 254)
    throw new Error('Uno de los campos SMTP excede el tamaño permitido.');
  if (!smtpHost) throw new SetupInputError('El host SMTP es obligatorio.');
  if (!validPort(smtpPort)) throw new SetupInputError('El puerto SMTP debe estar entre 1 y 65535.');
  if (!validEmail(smtpTestEmail)) throw new SetupInputError('Ingresa un correo de prueba válido.');
  if (!validSender(smtpFrom)) throw new SetupInputError('Ingresa un remitente SMTP con correo válido.');
  if (Boolean(smtpUser) !== Boolean(smtpPassword))
    throw new SetupInputError('Completa tanto el usuario SMTP como su contraseña, o deja ambos vacíos.');
  return {
    NODE_ENV: nodeEnv,
    HOST: host,
    PORT: String(port),
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    SITE_NAME: name,
    ADMIN_EMAIL: email,
    ADMIN_USERNAME: username,
    ADMIN_INITIAL_PASSWORD: password,
    BASE_URL: baseUrl,
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_SSL: String(db.ssl),
    DB_USER: db.user,
    DB_PASSWORD: db.password,
    DB_NAME: db.database,
    DB_POOL_LIMIT: '5',
    DATA_DIR: './data',
    SMTP_HOST: smtpHost,
    SMTP_PORT: String(validPort(smtpPort) ? smtpPort : 587),
    SMTP_SECURE: String(body.smtpSecure === true),
    SMTP_USER: smtpUser,
    SMTP_PASS: smtpPassword,
    SMTP_FROM: smtpFrom,
  };
}

function saveEnvironment(configuration) {
  const oldValues = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
  const values = { IMAGE_UPLOAD_MAX_MB: process.env.IMAGE_UPLOAD_MAX_MB ?? '50', ...oldValues, ...configuration };
  const content = `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join('\n')}\n`;
  const temporaryPath = path.join(root, `.env.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporaryPath, content, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, envPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {}
  Object.assign(process.env, configuration);
}

if (isConfigured) {
  startWiki();
} else {
  const key = setupKey();
  const app = express();
  app.set('trust proxy', 1);
  let installSaved = false, installInProgress = false;
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      frameguard: { action: 'deny' },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
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
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(createSiteRateLimiter(120));
  app.use(express.json({ limit: '6mb', type: 'application/json' }));
  const setupLimiter = rateLimit({
    windowMs: 60_000,
    limit: 8,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const authorizeSetup = (req, res, next) => {
    if (installSaved)
      return res.status(409).json({ error: 'La instalación ya se completó. Reinicia el servidor.' });
    if (installInProgress)
      return res.status(409).json({ error: 'La instalación ya está en curso.' });
    const origin = req.get('origin');
    try {
      if (!origin || new URL(origin).host !== req.get('host'))
        return res.status(403).json({ error: 'Origen no permitido.' });
    } catch {
      return res.status(403).json({ error: 'Origen no permitido.' });
    }
    const submitted = String(req.get('x-setup-key') || '');
    const expected = Buffer.from(key);
    const actual = Buffer.from(submitted);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
      return res.status(403).json({ error: 'El código de instalación no es válido.' });
    next();
  };
  app.get('/api/setup/status', (req, res) => {
    const pterodactyl = Boolean(process.env.P_SERVER_UUID);
    res.json({
      setupRequired: true,
      port: Number(process.env.PORT || process.env.SERVER_PORT || 3000),
      host: pterodactyl
        ? '0.0.0.0'
        : process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
      environment: process.env.NODE_ENV || 'development',
      pterodactyl,
    });
  });
  app.post('/api/setup/test-db', setupLimiter, authorizeSetup, async (req, res) => {
    try {
      const credentials = validateDatabase(req.body);
      await verifyDatabase(credentials);
      rememberSignature(verifiedDbSignatures, databaseSignature(req.body));
      res.json({ ok: true, message: 'Conexión MySQL correcta.' });
    } catch (error) {
      res.status(400).json({
        error:
          'No se pudo conectar a esa base MySQL. Revisa host, puerto, nombre, usuario, contraseña y SSL.',
        details: diagnosticDetails(error, [
          req.body?.dbHost,
          req.body?.dbName,
          req.body?.dbUser,
          req.body?.dbPassword,
        ]),
      });
      console.error(
        '[Teralth Wiki] Installer database test failed:',
        diagnosticDetails(error, [req.body?.dbHost, req.body?.dbName, req.body?.dbUser, req.body?.dbPassword]),
      );
    }
  });
  app.post('/api/setup/test-smtp', setupLimiter, authorizeSetup, async (req, res) => {
    const host = String(req.body.smtpHost || '').trim(),
      user = String(req.body.smtpUser || '').trim(),
      password = String(req.body.smtpPassword || '');
    const port = Number(req.body.smtpPort || 587),
      recipient = String(req.body.smtpTestEmail || '')
        .trim()
        .toLowerCase(),
      from = String(req.body.smtpFrom || '').trim();
    if (
      !host ||
      !validPort(port) ||
      !validEmail(recipient) ||
      !validSender(from) ||
      Boolean(user) !== Boolean(password) ||
      /[\r\n\0]/.test(host + user + password + from + recipient)
    )
      return res.status(400).json({
        error: 'Completa host, puerto, remitente y correo de prueba válidos.',
        details: {
          code: 'INVALID_CONFIGURATION',
          message:
            'Provide a valid SMTP host, port, sender, recipient, and complete authentication credentials.',
        },
      });
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: req.body.smtpSecure === true,
      auth: user ? { user, pass: password } : undefined,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
    });
    try {
      await transport.verify();
      const spanish = req.body.language === 'es',
        sent = await transport.sendMail({
          from,
          to: recipient,
          subject: 'Teralth Studio SMTP test',
          text: spanish
            ? 'Este es un correo de prueba del instalador de Teralth Studio. La entrega SMTP funciona.'
            : 'This is a test email from the Teralth Studio wiki installer. SMTP delivery is working.',
        });
      if (!sent.accepted?.some((address) => String(address).toLowerCase() === recipient))
        throw new Error('Recipient was not accepted');
      rememberSignature(verifiedEmailSignatures, emailSignature(req.body));
      res.json({ ok: true, message: 'Correo de prueba enviado correctamente.' });
    } catch (error) {
      console.error(
        '[Teralth Wiki] Installer SMTP test failed:',
        diagnosticDetails(error, [host, user, password, from, recipient]),
      );
      res.status(400).json({
        error:
          'No se pudo enviar el correo de prueba. Revisa los datos SMTP, el remitente y el correo destinatario.',
        details: diagnosticDetails(error, [host, user, password, from, recipient]),
      });
    } finally {
      transport.close();
    }
  });
  app.post('/api/setup/install', setupLimiter, authorizeSetup, async (req, res) => {
    let savedImages = [];
    try {
      const configuration = validateInstall(req.body);
      if (!verifiedDbSignatures.has(databaseSignature(req.body)))
        throw new SetupInputError('Prueba la conexión MySQL con los datos que vas a guardar.');
      if (!verifiedEmailSignatures.has(emailSignature(req.body)))
        throw new SetupInputError('Envía el correo de prueba con la configuración SMTP que vas a guardar.');
      installInProgress = true;
      res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.set('X-Accel-Buffering', 'no');
      res.write(JSON.stringify({ progress: 25, stage: 'validated' }) + '\n');
      await verifyDatabase(validateDatabase(req.body), true);
      res.write(JSON.stringify({ progress: 50, stage: 'database' }) + '\n');
      const images = await saveInstallerImages(
        { logo: req.body.siteLogo, favicon: req.body.siteFavicon },
        path.resolve(root, configuration.DATA_DIR),
      );
      savedImages = images.saved;
      configuration.SITE_LOGO = images.result.logo || '';
      configuration.SITE_FAVICON = images.result.favicon || '/assets/favicon.svg';
      saveEnvironment(configuration);
      installSaved = true;
      try {
        fs.rmSync(setupKeyPath, { force: true });
      } catch {}
      res.end(JSON.stringify({ progress: 75, stage: 'starting' }) + '\n');
      setTimeout(() => installerServer.close(startWiki), 500).unref();
    } catch (error) {
      for (const file of savedImages) await fs.promises.unlink(file).catch((cleanupError) =>
        console.error('[Teralth Wiki] Installer image cleanup failed:', cleanupError.code || cleanupError.name));
      const userError = error instanceof SetupInputError || error.code === 'SETUP_IMAGE_INVALID';
      if (res.headersSent) {
        if (!userError) console.error('No fue posible completar la instalación:', error.code || error.name || 'Error');
        return res.end(JSON.stringify({
          error: userError ? error.message : 'No se pudo completar la instalación. Revisa la consola del servidor.',
          status: userError ? 400 : 500,
        }) + '\n');
      }
      if (userError) return res.status(400).json({ error: error.message });
      console.error('No fue posible completar la instalación:', error.code || error.name || 'Error');
      res.status(500).json({
        error:
          'No se pudo validar MySQL o guardar la configuración. Revisa los datos de conexión y los permisos del servidor.',
      });
    } finally {
      installInProgress = false;
    }
  });
  app.get('/', sendPublicHtml('installer.html'));
  app.get('/installer.css', publicStaticOnly);
  app.get('/installer.js', publicScripts);
  app.get('/assets/fonts/:filename', publicStaticOnly);
  app.use((req, res, next) => (req.method === 'GET' ? res.redirect('/') : next()));
  app.use((error, req, res, next) => {
    console.error('Solicitud del instalador rechazada:', error.status || error.code || error.name || 'Error');
    if (!res.headersSent)
      res.status(error.status || 500).json({ error: 'No se pudo procesar la solicitud del instalador.' });
  });
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
  const host =
    process.env.HOST ||
    (process.env.NODE_ENV === 'production' || process.env.P_SERVER_UUID ? '0.0.0.0' : '127.0.0.1');
  const installerServer = app.listen(port, host, () =>
    console.log(
      `Instalador Teralth Studio disponible en ${host}:${port}. Consulta el archivo setup.key para autorizar la instalación.`,
    ),
  );
}
