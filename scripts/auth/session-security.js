const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

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
  enforceAbsoluteSessionLifetime,
  rejectLegacySessions,
};
