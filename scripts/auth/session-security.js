const SESSION_IDLE_MS = 30 * 60 * 1000;

function rejectLegacySessions(req, res, next) {
  if (!req.session || req.session.cookie.originalMaxAge === SESSION_IDLE_MS) return next();
  req.session.regenerate(error => {
    if (error) return next(error);
    return next();
  });
}

module.exports = { SESSION_IDLE_MS, rejectLegacySessions };
