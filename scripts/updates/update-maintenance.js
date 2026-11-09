'use strict';

function createUpdateMaintenance({ page, reopenDelay = 10000 }) {
  const state = {
    active: false,
    progress: 0,
    stage: 'idle',
    phase: 'preparation',
    phaseProgress: 0,
  };
  let timer = null;

  function set(stage, progress, phaseProgress = progress) {
    const phases = {
      receiving: 'preparation',
      preparing: 'preparation',
      verifying: 'verification',
      preflight: 'verification',
      verified: 'verification',
      backup: 'installation',
      'backup-complete': 'installation',
      staging: 'installation',
      'installing-files': 'installation',
      migrations: 'installation',
      finalizing: 'finalization',
      complete: 'finalization',
    };
    state.active = true;
    state.stage = stage;
    state.progress = Math.max(0, Math.min(100, Math.round(progress)));
    if (phases[stage]) state.phase = phases[stage];
    state.phaseProgress = Math.max(0, Math.min(100, Math.round(phaseProgress)));
  }

  function fail() {
    set('failed', state.progress, state.phaseProgress);
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.active = false;
      state.stage = 'idle';
      state.progress = 0;
      state.phase = 'preparation';
      state.phaseProgress = 0;
    }, reopenDelay);
    timer.unref();
  }

  function progress(req, res) {
    return res
      .set({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      })
      .json({
        active: state.active,
        progress: state.progress,
        stage: state.stage,
        phase: state.phase,
        phaseProgress: state.phaseProgress,
      });
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
