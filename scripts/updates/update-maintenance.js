'use strict';

function createUpdateMaintenance({ page, reopenDelay = 10000 }) {
  const state = { active: false, progress: 0, stage: 'idle' };
  let timer = null;

  function set(stage, progress) {
    state.active = true;
    state.stage = stage;
    state.progress = Math.max(0, Math.min(100, Math.round(progress)));
  }

  function fail() {
    set('failed', state.progress);
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.active = false;
      state.stage = 'idle';
      state.progress = 0;
    }, reopenDelay);
    timer.unref();
  }

  function progress(req, res) {
    return res
      .set({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      })
      .json({ active: state.active, progress: state.progress, stage: state.stage });
  }

  function middleware(req, res, next) {
    if (!state.active) return next();
    if (
      (req.method === 'GET' && req.path === '/api/updates/progress') ||
      (['GET', 'HEAD'].includes(req.method) && ['/maintenance.js', '/maintenance.css'].includes(req.path))
    )
      return next();
    return res
      .status(503)
      .set({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Retry-After': '3',
        'X-Robots-Tag': 'noindex, nofollow',
      })
      .type('html')
      .send(page);
  }

  return {
    state,
    set,
    fail,
    progress,
    middleware,
    clear() {
      clearTimeout(timer);
    },
  };
}

module.exports = { createUpdateMaintenance };
