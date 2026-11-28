const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const sharp = require('sharp');
const { providers, createSecretStore, validateConnection, providerIdentity } = require('./oauth-providers');
const { binding } = require('./two-factor');
const { credentialBinding } = require('./session-security');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const save = session => new Promise((resolve, reject) => session.save(error => error ? reject(error) : resolve()));
const regenerate = session => new Promise((resolve, reject) => session.regenerate(error => error ? reject(error) : resolve()));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function registerProfileRoutes(app, deps) {
  const { pool, query, auth, limiter, requirePermission, sessionSecret, baseUrl, bcrypt, token, userView, publicUserView, invalidateUserSessions, notifySuccessfulLogin, enqueueMail, mediaRoot, verifyCaptcha, activeLanguages } = deps;
  const secrets = createSecretStore(sessionSecret);
  const resolveIdentity = deps.resolveIdentity || providerIdentity;
  const wrap = callback => (req, res, next) => Promise.resolve(callback(req, res)).catch(error => {
    if (error.code === 'ER_DUP_ENTRY' || String(error.code).startsWith('SQLITE_CONSTRAINT')) error = fail('That username, email or connection is already in use.');
    next(error);
  });
  const user = async req => (await query('SELECT * FROM users WHERE id=?', [req.session.user.id]))[0];
  const passwordCheck = async (req, account) => {
    const password = String(req.body.password || '');
    if (!password || Buffer.byteLength(password, 'utf8') > 72 || !(await bcrypt.compare(password, account.password_hash))) throw fail('The current password is incorrect.', 403);
  };
  const ensureProfile = async id => query('INSERT IGNORE INTO user_profiles (user_id) VALUES (?)', [id]);
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  app.use('/api/profile', noStore);
  app.use('/api/admin/connections', noStore);

  app.get('/api/auth/connections', noStore, wrap(async (req, res) => {
    res.json({ connections: (await query('SELECT provider FROM oauth_connections ORDER BY provider')).filter(row => Object.hasOwn(providers, row.provider)).map(row => ({ provider: row.provider, name: providers[row.provider].name })) });
  }));
  app.get('/api/admin/connections', auth, requirePermission('connections.manage'), wrap(async (req, res) => {
    const connections = await query('SELECT provider,client_id AS clientId,redirect_uri AS redirectUri FROM oauth_connections ORDER BY provider');
    res.json({ connections, providers: Object.entries(providers).map(([provider, config]) => ({ provider, name: config.name, redirectUri: new URL(`/auth/oauth/${provider}/callback`, baseUrl(req)).href })) });
  }));
  app.put('/api/admin/connections/:provider', auth, limiter, requirePermission('connections.manage'), wrap(async (req, res) => {
    const [existing] = await query('SELECT client_id,secret_ciphertext FROM oauth_connections WHERE provider=?', [req.params.provider]);
    if (existing && req.body.clientId !== existing.client_id && !req.body.clientSecret) throw fail('Enter the Client Secret when changing Client ID.');
    const input = validateConnection({ ...req.body, provider: req.params.provider }, baseUrl(req), existing?.secret_ciphertext);
    const encrypted = input.secret ? secrets.encrypt(input.secret) : existing.secret_ciphertext;
    await query('INSERT INTO oauth_connections (provider,client_id,secret_ciphertext,redirect_uri) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE client_id=VALUES(client_id),secret_ciphertext=VALUES(secret_ciphertext),redirect_uri=VALUES(redirect_uri)', [input.provider, input.clientId, encrypted, input.redirectUri]);
    res.json({ ok: true });
  }));
  app.delete('/api/admin/connections/:provider', auth, limiter, requirePermission('connections.manage'), wrap(async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT provider FROM oauth_connections WHERE provider=? FOR UPDATE', [req.params.provider]);
      await connection.execute('DELETE FROM oauth_identities WHERE provider=?', [req.params.provider]);
      await connection.execute('DELETE FROM oauth_connections WHERE provider=?', [req.params.provider]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    res.json({ ok: true });
  }));

  app.get('/api/profile', auth, wrap(async (req, res) => {
    const account = await user(req);
    await ensureProfile(account.id);
    const [profile] = await query('SELECT full_name AS fullName,avatar,preferred_language AS preferredLanguage,login_notifications AS loginNotifications FROM user_profiles WHERE user_id=?', [account.id]);
    const linked = await query('SELECT provider,display_name AS displayName FROM oauth_identities WHERE user_id=?', [account.id]);
    const configured = await query('SELECT provider FROM oauth_connections ORDER BY provider');
    res.json({ user: { ...await publicUserView(account), createdAt: account.created_at }, profile: { ...profile, loginNotifications: Boolean(profile.loginNotifications) }, connections: configured.filter(row => Object.hasOwn(providers, row.provider)).map(row => ({ provider: row.provider, name: providers[row.provider].name, linked: linked.find(item => item.provider === row.provider) || null })) });
  }));
  app.put('/api/profile', auth, limiter, wrap(async (req, res) => {
    const username = String(req.body.username || '').trim(), fullName = String(req.body.fullName || '').trim(), language = String(req.body.preferredLanguage || '');
    if (!/^[\p{L}\p{N}_-]{2,60}$/u.test(username) || !/^[\p{L}\p{M} ]{0,120}$/u.test(fullName) || !(await activeLanguages()).includes(language)) throw fail('Check your username, full name and preferred language.');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [taken] = await conn.execute('SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>? LIMIT 1', [username, req.session.user.id]);
      if (taken.length) throw fail('That username is already in use.');
      await conn.execute('UPDATE users SET username=? WHERE id=?', [username, req.session.user.id]);
      await conn.execute('INSERT INTO user_profiles (user_id,full_name,preferred_language) VALUES (?,?,?) ON DUPLICATE KEY UPDATE full_name=VALUES(full_name),preferred_language=VALUES(preferred_language)', [req.session.user.id, fullName, language]);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
    req.session.user.username = username;
    await save(req.session);
    res.json({ ok: true });
  }));
  app.put('/api/profile/notifications', auth, limiter, wrap(async (req, res) => {
    if (typeof req.body.loginNotifications !== 'boolean') throw fail('Choose a notification preference.');
    await ensureProfile(req.session.user.id);
    await query('UPDATE user_profiles SET login_notifications=? WHERE user_id=?', [Number(req.body.loginNotifications), req.session.user.id]);
    res.json({ ok: true });
  }));
  const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } }).single('avatar');
  app.post('/api/profile/avatar', auth, limiter, (req, res, next) => avatarUpload(req, res, error => {
    if (error) return res.status(400).json({ error: 'Choose one JPEG or PNG image, up to 2 MB.' });
    next();
  }), wrap(async (req, res) => {
    if (!req.file || !['image/jpeg', 'image/png'].includes(req.file.mimetype)) throw fail('Choose a JPEG or PNG image.');
    let buffer;
    try {
      const image = sharp(req.file.buffer, { limitInputPixels: 16000000, animated: false });
      const metadata = await image.metadata();
      if (!['jpeg', 'png'].includes(metadata.format)) throw fail('Invalid image.');
      buffer = await image.rotate().resize(256, 256, { fit: 'cover' }).png().toBuffer();
    } catch { throw fail('The image could not be processed.'); }
    const filename = `${crypto.randomBytes(8).toString('hex')}.png`;
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    await fs.promises.writeFile(path.join(mediaRoot, filename), buffer, { flag: 'wx', mode: 0o600 });
    await ensureProfile(req.session.user.id);
    const avatar = `/media/${filename}`;
    await query('UPDATE user_profiles SET avatar=? WHERE user_id=?', [avatar, req.session.user.id]);
    res.json({ avatar });
  }));
  app.post('/api/profile/email', auth, limiter, wrap(async (req, res) => {
    const account = await user(req); await passwordCheck(req, account);
    const email = String(req.body.email || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === account.email.toLowerCase()) throw fail('Enter a different valid email address.');
    const [taken] = await query('SELECT id FROM users WHERE LOWER(email)=LOWER(?)', [email]);
    if (taken) throw fail('This email address is unavailable.');
    const raw = token(), link = new URL('/profile/settings', baseUrl(req));
    link.searchParams.set('email-token', raw);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('INSERT INTO profile_email_changes (user_id,email,token_hash,expires_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE email=VALUES(email),token_hash=VALUES(token_hash),expires_at=VALUES(expires_at)', [account.id, email, digest(raw), Date.now() + 3600000]);
      await enqueueMail(email, 'Confirm your new email address', `<p>Confirm your new TxWiki email address. This link expires in one hour.</p><p><a href="${escape(link.href)}">Confirm email address</a></p>`, conn);
      await enqueueMail(account.email, 'Email change requested', '<p>A change to your TxWiki email address was requested. If this was not you, change your password and contact your administrator.</p>', conn);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
    res.json({ ok: true });
  }));
  app.post('/api/profile/email/confirm', auth, limiter, wrap(async (req, res) => {
    const raw = String(req.body.token || '');
    if (!raw || raw.length > 200) throw fail('The confirmation link has expired or is invalid.');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute('SELECT email,token_hash,expires_at FROM profile_email_changes WHERE user_id=? FOR UPDATE', [req.session.user.id]);
      const entry = rows[0];
      if (!entry || entry.expires_at <= Date.now() || entry.token_hash !== digest(raw)) throw fail('The confirmation link has expired or is invalid.');
      await conn.execute('UPDATE users SET email=?,verified_at=CURRENT_TIMESTAMP WHERE id=?', [entry.email, req.session.user.id]);
      await conn.execute('DELETE FROM profile_email_changes WHERE user_id=?', [req.session.user.id]);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
    await invalidateUserSessions(req.session.user.id);
    await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.json({ ok: true });
  }));

  const start = mode => wrap(async (req, res) => {
    const provider = req.params.provider;
    if (!Object.hasOwn(providers, provider)) throw fail('Connection unavailable.', 404);
    let accountBinding = null;
    if (mode === 'link') {
      const account = await user(req);
      await passwordCheck(req, account);
      if (!account.verified_at || account.must_change_password) throw fail('Complete account verification before linking.', 403);
      accountBinding = binding(account);
    }
    else {
      if (req.session.user) throw fail('Sign out before starting a new login.');
      if (!(await verifyCaptcha(req, 'login'))) throw fail('Complete the CAPTCHA verification.');
    }
    const [connection] = await query('SELECT * FROM oauth_connections WHERE provider=?', [provider]);
    if (!connection) throw fail('Connection unavailable.', 404);
    const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(32).toString('base64url');
    req.session.oauthPending = { provider, state, verifier, mode, userId: req.session.user?.id || null, accountBinding, fingerprint: digest(connection.client_id + connection.secret_ciphertext + connection.redirect_uri), expires: Date.now() + 600000 };
    await save(req.session);
    const url = new URL(providers[provider].authorize);
    for (const [key, value] of Object.entries({ client_id: connection.client_id, redirect_uri: connection.redirect_uri, response_type: 'code', scope: providers[provider].scope, state })) url.searchParams.set(key, value);
    if (providers[provider].pkce) {
      url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    res.json({ url: url.href });
  });
  app.post('/api/profile/connections/:provider/start', auth, limiter, start('link'));
  app.post('/api/auth/oauth/:provider/start', limiter, start('login'));
  app.get('/auth/oauth/:provider/callback', noStore, (req, res) => {
    if (!Object.hasOwn(providers, req.params.provider)) return res.sendStatus(404);
    // Load a same-origin document before completion so Strict session cookies remain protected.
    res.set('Referrer-Policy', 'no-referrer').type('html').send('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Completing sign-in</title><link rel="stylesheet" href="/errors.css"><script src="/oauth-complete.js" defer></script></head><body><main class="tx-error-screen" role="status">Completing sign-in…</main></body></html>');
  });
  app.get('/auth/oauth/:provider/finish', limiter, noStore, wrap(async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const pending = req.session.oauthPending;
    delete req.session.oauthPending;
    await save(req.session);
    const state = String(req.query.state || ''), code = String(req.query.code || '');
    if (!pending || pending.expires < Date.now() || pending.provider !== req.params.provider || !state || Buffer.byteLength(state) !== Buffer.byteLength(pending.state) || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state)) || !code || code.length > 4096 || req.query.error)
      return res.redirect(303, '/login?notice=oauth-failed');
    const [connection] = await query('SELECT * FROM oauth_connections WHERE provider=?', [pending.provider]);
    if (!connection || pending.fingerprint !== digest(connection.client_id + connection.secret_ciphertext + connection.redirect_uri)) return res.redirect(303, '/login?notice=oauth-failed');
    let identity;
    try { identity = await resolveIdentity(pending.provider, connection, code, pending.verifier, secrets.decrypt(connection.secret_ciphertext)); }
    catch { return res.redirect(303, pending.mode === 'link' ? '/profile/connections?notice=oauth-failed' : '/login?notice=oauth-failed'); }
    if (pending.mode === 'link') {
      if (!req.session.user || req.session.user.id !== pending.userId) return res.redirect(303, '/login?notice=oauth-failed');
      const account = await user(req);
      if (!account?.verified_at || account.must_change_password || pending.accountBinding !== binding(account)) throw fail('Your account security changed. Start again.', 403);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [current] = await conn.execute('SELECT secret_ciphertext FROM oauth_connections WHERE provider=? FOR UPDATE', [pending.provider]);
        if (!current[0] || current[0].secret_ciphertext !== connection.secret_ciphertext) throw fail('Connection configuration changed. Start again.');
        await conn.execute('INSERT INTO oauth_identities (provider,subject,user_id,display_name) VALUES (?,?,?,?)', [pending.provider, identity.subject, account.id, identity.displayName]);
        await conn.commit();
      } catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY' || String(error.code).startsWith('SQLITE_CONSTRAINT')) return res.redirect(303, '/profile/connections?notice=oauth-failed'); throw error; }
      finally { conn.release(); }
      return res.redirect(303, '/profile/connections');
    }
    const [account] = await query('SELECT u.* FROM users u JOIN oauth_identities i ON i.user_id=u.id WHERE i.provider=? AND i.subject=?', [pending.provider, identity.subject]);
    if (!account || !account.verified_at || account.must_change_password) return res.redirect(303, '/login?notice=oauth-unlinked');
    await regenerate(req.session);
    req.session.csrfToken = token();
    if (account.two_factor_secret) req.session.pendingTwoFactor = { id: account.id, binding: binding(account), expires: Date.now() + 600000 };
    else {
      req.session.user = userView(account);
      req.session.credentialBinding = credentialBinding(account.id, account.password_hash);
      req.session.authenticatedAt = Date.now();
      notifySuccessfulLogin(account, req);
    }
    await save(req.session);
    res.redirect(303, account.two_factor_secret ? '/two-factor' : '/');
  }));
  app.delete('/api/profile/connections/:provider', auth, limiter, wrap(async (req, res) => {
    await passwordCheck(req, await user(req));
    await query('DELETE FROM oauth_identities WHERE user_id=? AND provider=?', [req.session.user.id, req.params.provider]);
    res.json({ ok: true });
  }));
}
module.exports = { registerProfileRoutes };
