'use strict';

(() => {
  const stageLabels = {
    receiving: 'Receiving the update package...',
    verifying: 'Verifying package signature and files...',
    preflight: 'Checking the installation environment...',
    backup: 'Creating a secure backup...',
    'backup-complete': 'Backup created. Preparing files...',
    staging: 'Preparing update files...',
    'installing-files': 'Installing verified files...',
    migrations: 'Applying database changes...',
    finalizing: 'Finishing the update...',
    complete: 'Update complete. Restarting the site...',
    failed: 'The update could not be completed. The site will reopen shortly.',
  };
  let hasSeenActiveUpdate = false;
  let polling = false;

  function setProgress(value, stage) {
    const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const ring = document.getElementById('maintenanceProgress');
    const arc = document.getElementById('maintenanceArc');
    const percent = document.getElementById('maintenancePercent');
    const message = document.getElementById('maintenanceStage');
    if (ring) ring.setAttribute('aria-valuenow', String(progress));
    if (arc) arc.setAttribute('stroke-dashoffset', String(100 - progress));
    if (percent) percent.textContent = `${progress}%`;
    if (message) message.textContent = stageLabels[stage] || 'Preparing the update...';
  }

  function enter() {
    document.documentElement.lang = 'en';
    document.title = 'Updating...';
    document.body.className = 'maintenance-body';
    document.body.innerHTML =
      '<main class="maintenance-card" aria-labelledby="maintenanceTitle"><div class="maintenance-mark" aria-hidden="true"><i></i><i></i><i></i></div><h1 id="maintenanceTitle">Updating...</h1><p class="maintenance-message">The site is temporarily unavailable.</p><div class="maintenance-progress" id="maintenanceProgress" role="progressbar" aria-label="Update progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="maintenance-track" cx="60" cy="60" r="52"></circle><circle class="maintenance-arc" id="maintenanceArc" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"></circle></svg><span id="maintenancePercent">0%</span></div><p class="maintenance-stage" id="maintenanceStage" role="status" aria-live="polite">Preparing the update...</p><span class="maintenance-rule" aria-hidden="true"></span><p class="maintenance-footnote">Please keep this page open.</p></main>';
    setProgress(3, 'receiving');
    poll();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    while (document.getElementById('maintenanceProgress')) {
      try {
        const response = await fetch('/api/updates/progress', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const status = await response.json();
          if (status.active) {
            hasSeenActiveUpdate = true;
            setProgress(status.progress, status.stage);
          } else if (hasSeenActiveUpdate) {
            location.reload();
            return;
          }
        }
      } catch {
        // The server may be restarting; keep the maintenance screen and retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    polling = false;
  }

  window.TeralthMaintenance = { enter, setProgress };
  if (document.getElementById('maintenanceProgress')) poll();
})();
