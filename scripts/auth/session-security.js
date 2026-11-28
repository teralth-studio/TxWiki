const crypto = require('node:crypto');
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

// Bind authentication to the credential actually checked at sign-in. Deleting
// stored sessions alone cannot revoke an already loaded request that saves later.
function credentialBinding(userId, passwordHash) {
  if (typeof passwordHash !== 'string' || !passwordHash) return null;
  return crypto.createHash('sha256').update(`${userId}:${passwordHash}`).digest('hex');
}

function rejectLegacySessions(req, res, next) {
  if (!req.session || req.session.cookie.originalMaxAge === SESSION_IDLE_MS) return next();
  req.session.regenerate(error => {
    if (error) return next(error);
    return next();
  });
}

function enforceAbsoluteSessionLifetime(req, res, next) {
  if (!req.session?.user) return next();

  const now = Date.now();
  if (!Number.isFinite(req.session.authenticatedAt)) {
    req.session.authenticatedAt = now;
    return next();
  }
  if (now - req.session.authenticatedAt < SESSION_ABSOLUTE_MS) return next();

  req.session.regenerate(error => {
    if (error) return next(error);
    res.clearCookie('teralth.sid', { path: '/' });
    return next();
  });
}

module.exports = {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  credentialBinding,
  enforceAbsoluteSessionLifetime,
  rejectLegacySessions,
};
