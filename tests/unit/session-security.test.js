const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const session = require('express-session');
const { SESSION_IDLE_MS, rejectLegacySessions } = require('../../scripts/session-security');
const { createSiteRateLimiter } = require('../../scripts/site-rate-limit');

async function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('sessions roll for 30 minutes, expire server-side, and discard legacy sessions', async () => {
  const app = express();
  const store = new session.MemoryStore();
  app.use(session({
    name: 'test.sid',
    secret: 'integration-test-secret-not-used-in-production',
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', maxAge: SESSION_IDLE_MS }
  }));
  app.use(rejectLegacySessions);
  app.post('/login', (req, res) => {
    req.session.regenerate(error => {
      if (error) return res.sendStatus(500);
      req.session.user = { id: 1 };
      return res.json({ id: req.sessionID });
    });
  });
  app.get('/private', (req, res) => res.sendStatus(req.session.user ? 204 : 401));
  const server = await listen(app);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(SESSION_IDLE_MS, 1800000);
    const login = await fetch(url + '/login', { method: 'POST' });
    const id = (await login.json()).id;
    const cookieHeader = login.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Strict/i);
    const cookie = cookieHeader.split(';')[0];
    const privateResponse = await fetch(url + '/private', { headers: { cookie } });
    assert.equal(privateResponse.status, 204);
    assert.ok(privateResponse.headers.get('set-cookie'));
    const stored = JSON.parse(store.sessions[id]);
    assert.equal(stored.cookie.originalMaxAge, SESSION_IDLE_MS);
    stored.cookie.expires = new Date(Date.now() - 1).toISOString();
    store.sessions[id] = JSON.stringify(stored);
    assert.equal((await fetch(url + '/private', { headers: { cookie } })).status, 401);

    const legacyLogin = await fetch(url + '/login', { method: 'POST' });
    const legacyId = (await legacyLogin.json()).id;
    const legacyCookie = legacyLogin.headers.get('set-cookie').split(';')[0];
    const legacy = JSON.parse(store.sessions[legacyId]);
    legacy.cookie.originalMaxAge = 8 * 60 * 60 * 1000;
    store.sessions[legacyId] = JSON.stringify(legacy);
    assert.equal((await fetch(url + '/private', { headers: { cookie: legacyCookie } })).status, 401);
    assert.equal(store.sessions[legacyId], undefined);
  } finally {
    await close(server);
  }
});

test('site rate limiter enforces request limits per client IP', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(createSiteRateLimiter(2));
  app.get('/', (req, res) => res.sendStatus(204));
  const server = await listen(app);
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const request = ip => fetch(url, { headers: { 'x-forwarded-for': ip } });
    assert.equal((await request('192.0.2.1')).status, 204);
    assert.equal((await request('192.0.2.1')).status, 204);
    const rejected = await request('192.0.2.1');
    assert.equal(rejected.status, 429);
    assert.ok(rejected.headers.get('retry-after'));
    assert.equal((await request('192.0.2.2')).status, 204);
  } finally {
    await close(server);
  }
});
