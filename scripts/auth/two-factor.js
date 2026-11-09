const crypto = require('node:crypto');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');

const LIFETIME = 10 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const binding = user => digest(`${user.id}:${user.password_hash}:${user.two_factor_secret}`);
const sessionBinding = (userId, secret) => secret ? digest(`${userId}:${secret}`) : null;
const save = session => new Promise((resolve, reject) => session.save(error => error ? reject(error) : resolve()));
const regenerate = session => new Promise((resolve, reject) => session.regenerate(error => error ? reject(error) : resolve()));

function createTwoFactor(secretKey) {
  const key = crypto.createHash('sha256').update('teralth-two-factor-v1:').update(secretKey).digest();
  function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
  }
  function decrypt(value) {
    const [version, iv, tag, ciphertext, extra] = String(value).split(':');
    if (version !== 'v1' || !iv || !tag || !ciphertext || extra) throw new Error('TWO_FACTOR_SECRET_INVALID');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64url')), cipher.final()]).toString('utf8');
  }
  function totp(secret, label = '') {
    return new OTPAuth.TOTP({ issuer: 'Teralth Wiki', label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  }
  function verify(secret, code, lastStep = null, now = Date.now()) {
    if (!/^\d{6}$/.test(code)) return null;
    const delta = totp(secret).validate({ token: code, timestamp: now, window: 1 });
    if (delta === null) return null;
    const step = Math.floor(now / 30000) + delta;
    return lastStep !== null && step <= Number(lastStep) ? null : step;
  }
  return { encrypt, decrypt, totp, verify };
}

function registerTwoFactorRoutes(app, { pool, query, auth, limiter, bcrypt, sessionSecret, token, userView, invalidateUserSessions, notifySuccessfulLogin, notifySecurityChange }) {
  const security = createTwoFactor(sessionSecret);
  const requirePending = (req, res, next) => {
    if (!req.session.pendingTwoFactor) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    next();
  };
  const failCode = res => res.status(400).json({ error: 'El código no es válido o ya fue utilizado.' });
  const noCache = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  app.post('/api/auth/two-factor/setup', auth, limiter, noCache, async (req, res, next) => {
    try {
      const [user] = await query('SELECT email,verified_at,two_factor_secret FROM users WHERE id=?', [req.session.user.id]);
      if (!user || !user.verified_at) return res.status(403).json({ error: 'Primero debes verificar tu cuenta.' });
      if (user.two_factor_secret) return res.status(400).json({ error: '2FA ya está activado.' });
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const qr = await QRCode.toDataURL(security.totp(secret, user.email).toString(), { errorCorrectionLevel: 'M', margin: 2, width: 240 });
      req.session.twoFactorSetup = { secret: security.encrypt(secret), expires: Date.now() + LIFETIME };
      await save(req.session);
      res.json({ secret, qr });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/two-factor/activate', auth, limiter, noCache, async (req, res, next) => {
    let conn, transaction = false;
    try {
      const setup = req.session.twoFactorSetup;
      if (!setup || !Number.isSafeInteger(setup.expires) || setup.expires <= Date.now()) {
        delete req.session.twoFactorSetup;
        return res.status(400).json({ error: 'La configuración de 2FA venció. Comienza de nuevo.' });
      }
      const step = security.verify(security.decrypt(setup.secret), String(req.body.code || '').trim());
      if (step === null) return failCode(res);
      const codes = Array.from({ length: 10 }, () => crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'));
      conn = await pool.getConnection();
      await conn.beginTransaction(); transaction = true;
      const [rows] = await conn.execute('SELECT email,username,verified_at,two_factor_secret FROM users WHERE id=? FOR UPDATE', [req.session.user.id]);
      if (!rows[0] || !rows[0].verified_at || rows[0].two_factor_secret) {
        await conn.rollback(); transaction = false;
        return res.status(400).json({ error: '2FA ya está activado o la cuenta no está disponible.' });
      }
      await conn.execute('UPDATE users SET two_factor_secret=?,two_factor_recovery_codes=?,two_factor_last_step=? WHERE id=?',
        [setup.secret, JSON.stringify(codes.map(code => digest(code.replace(/-/g, '')))), step, req.session.user.id]);
      await conn.commit(); transaction = false;
      conn.release(); conn = null;
      delete req.session.twoFactorSetup;
      req.session.user.twoFactorEnabled = true;
      req.session.twoFactorBinding = sessionBinding(req.session.user.id, setup.secret);
      await invalidateUserSessions(req.session.user.id, req.sessionID);
      await save(req.session);
      await notifySecurityChange(rows[0], 'two_factor_enabled.html', '2FA enabled', req);
      res.json({ codes });
    } catch (error) { if (transaction) await conn.rollback(); next(error); }
    finally { if (conn) conn.release(); }
  });

  app.post('/api/auth/two-factor/verify', requirePending, limiter, noCache, async (req, res, next) => {
    let conn, transaction = false;
    try {
      const pending = req.session.pendingTwoFactor;
      if (!Number.isSafeInteger(pending.expires) || pending.expires <= Date.now()) {
        delete req.session.pendingTwoFactor;
        await save(req.session);
        return res.status(401).json({ error: 'La sesión de 2FA venció. Inicia sesión de nuevo.' });
      }
      conn = await pool.getConnection();
      await conn.beginTransaction(); transaction = true;
      const [rows] = await conn.execute('SELECT id,email,username,role,is_primary_admin,verified_at,must_change_password,password_hash,two_factor_secret,two_factor_recovery_codes,two_factor_last_step FROM users WHERE id=? FOR UPDATE', [pending.id]);
      const user = rows[0];
      if (!user || !user.verified_at || !user.two_factor_secret || binding(user) !== pending.binding) {
        await conn.rollback(); transaction = false;
        conn.release(); conn = null;
        delete req.session.pendingTwoFactor;
        await save(req.session);
        return res.status(401).json({ error: 'La sesión de 2FA venció. Inicia sesión de nuevo.' });
      }
      const code = String(req.body.code || '').trim();
      const normalizedRecoveryCode = code.toUpperCase().replace(/-/g, '');
      let recoveryIndex = -1;
      if (/^[A-F0-9]{32}$/.test(normalizedRecoveryCode)) {
        const codes = typeof user.two_factor_recovery_codes === 'string' ? JSON.parse(user.two_factor_recovery_codes) : user.two_factor_recovery_codes;
        if (!Array.isArray(codes)) throw new Error('TWO_FACTOR_RECOVERY_DATA_INVALID');
        recoveryIndex = codes.indexOf(digest(normalizedRecoveryCode));
        if (recoveryIndex >= 0) {
          codes.splice(recoveryIndex, 1);
          await conn.execute('UPDATE users SET two_factor_recovery_codes=? WHERE id=?', [JSON.stringify(codes), user.id]);
        }
      }
      if (recoveryIndex < 0) {
        const step = security.verify(security.decrypt(user.two_factor_secret), code, user.two_factor_last_step);
        if (step === null) { await conn.rollback(); transaction = false; return failCode(res); }
        await conn.execute('UPDATE users SET two_factor_last_step=? WHERE id=?', [step, user.id]);
      }
      await conn.commit(); transaction = false;
      conn.release(); conn = null;
      await regenerate(req.session);
      req.session.user = userView(user);
      req.session.twoFactorBinding = sessionBinding(user.id, user.two_factor_secret);
      req.session.csrfToken = token();
      await save(req.session);
      notifySuccessfulLogin(user, req);
      res.json({ user: req.session.user, csrfToken: req.session.csrfToken });
    } catch (error) { if (transaction) await conn.rollback(); next(error); }
    finally { if (conn) conn.release(); }
  });

  app.post('/api/auth/two-factor/disable', auth, limiter, noCache, async (req, res, next) => {
    let conn, transaction = false;
    try {
      const password = String(req.body.password || '');
      conn = await pool.getConnection();
      await conn.beginTransaction(); transaction = true;
      const [rows] = await conn.execute('SELECT email,username,password_hash,two_factor_secret FROM users WHERE id=? FOR UPDATE', [req.session.user.id]);
      if (!rows[0] || !rows[0].two_factor_secret) {
        await conn.rollback(); transaction = false;
        return res.status(400).json({ error: '2FA no está activado.' });
      }
      if (Buffer.byteLength(password, 'utf8') > 72 || !(await bcrypt.compare(password, rows[0].password_hash))) {
        await conn.rollback(); transaction = false;
        return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
      }
      await conn.execute('UPDATE users SET two_factor_secret=NULL,two_factor_recovery_codes=NULL,two_factor_last_step=NULL WHERE id=?', [req.session.user.id]);
      await conn.commit(); transaction = false;
      conn.release(); conn = null;
      req.session.user.twoFactorEnabled = false;
      delete req.session.twoFactorBinding;
      await invalidateUserSessions(req.session.user.id, req.sessionID);
      await save(req.session);
      await notifySecurityChange(rows[0], 'two_factor_disabled.html', '2FA disabled', req);
      res.json({ ok: true });
    } catch (error) { if (transaction) await conn.rollback(); next(error); }
    finally { if (conn) conn.release(); }
  });
}

module.exports = { createTwoFactor, registerTwoFactorRoutes, binding, sessionBinding, LIFETIME };
