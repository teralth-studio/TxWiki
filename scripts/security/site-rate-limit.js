const { rateLimit } = require('express-rate-limit');

function createSiteRateLimiter(limit = 600) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes. Inténtalo más tarde.' }
  });
}

module.exports = { createSiteRateLimiter };
