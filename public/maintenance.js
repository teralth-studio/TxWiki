'use strict';

(() => {
  const stages = {
    receiving: ['Preparando el paquete de actualización…', 'Preparing the update package…'],
    preparing: ['Preparando el entorno…', 'Preparing the environment…'],
    verifying: ['Verificando firma, clave y archivos…', 'Verifying the signature, key, and files…'],
    preflight: ['Comprobando el entorno de instalación…', 'Checking the installation environment…'],
    verified: ['Verificación completa. Iniciando instalación…', 'Verification complete. Starting installation…'],
    backup: ['Creando una copia de seguridad…', 'Creating a backup…'],
    'backup-complete': ['Copia de seguridad lista. Preparando archivos…', 'Backup ready. Preparing files…'],
    staging: ['Preparando los archivos de actualización…', 'Preparing update files…'],
    'installing-files': ['Instalando los archivos verificados…', 'Installing verified files…'],
    migrations: ['Aplicando cambios de base de datos…', 'Applying database changes…'],
    finalizing: ['Finalizando la actualización…', 'Finalizing the update…'],
    complete: ['Actualización completa. Recargando el sitio…', 'Update complete. Reloading the site…'],
    failed: ['No se pudo completar la actualización. El sitio se abrirá pronto.', 'The update could not be completed. The site will reopen shortly.'],
  };
  const phases = [
    { id: 'preparation', labels: ['Preparación', 'Preparation'] },
    { id: 'verification', labels: ['Verificación', 'Verification'] },
    { id: 'installation', labels: ['Instalación', 'Installation'] },
    { id: 'finalization', labels: ['Finalización', 'Finalization'] },
  ];
  const stagePhases = {
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
  let hasSeenActiveUpdate = false;
  let polling = false;

  function isSpanish() {
    return document.documentElement.lang === 'es';
  }

  function setProgress(value, stage, phase, phaseProgress) {
    const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const activePhase = phase || stagePhases[stage] || 'preparation';
    const phaseAmount = Math.max(
      0,
      Math.min(100, Math.round(Number(phaseProgress ?? value) || 0)),
    );
    const spanish = isSpanish();
    const ring = document.getElementById('maintenanceProgress');
    const arc = document.getElementById('maintenanceArc');
    const percent = document.getElementById('maintenancePercent');
    const message = document.getElementById('maintenanceStage');
    if (ring) ring.setAttribute('aria-valuenow', String(progress));
    if (arc) arc.setAttribute('stroke-dashoffset', String(100 - progress));
    if (percent) percent.textContent = `${progress}%`;
    if (message) message.textContent = stages[stage]?.[spanish ? 0 : 1] || stages.preparing[spanish ? 0 : 1];

    const activeIndex = phases.findIndex((item) => item.id === activePhase);
    for (const [index, item] of phases.entries()) {
      const card = document.getElementById(`maintenancePhase-${item.id}`);
      const state = document.getElementById(`maintenancePhaseState-${item.id}`);
      const bar = document.getElementById(`maintenancePhaseBar-${item.id}`);
      if (!card || !state || !bar) continue;
      const complete = stage === 'complete' || index < activeIndex;
      const current = index === activeIndex && stage !== 'complete';
      card.classList.toggle('is-complete', complete);
      card.classList.toggle('is-active', current);
      card.classList.toggle('is-failed', current && stage === 'failed');
      state.textContent = complete
        ? spanish ? 'Completada' : 'Complete'
        : current
          ? spanish ? 'En curso' : 'In progress'
          : spanish ? 'Pendiente' : 'Pending';
      const amount = complete ? 100 : current ? phaseAmount : 0;
      bar.setAttribute('aria-valuenow', String(amount));
      bar.firstElementChild.style.width = `${amount}%`;
    }

    const currentBar = document.getElementById('maintenanceCurrentPhaseBar');
    const currentBarText = document.getElementById('maintenanceCurrentPhasePercent');
    if (currentBar) {
      currentBar.setAttribute('aria-valuenow', String(phaseAmount));
      currentBar.firstElementChild.style.width = `${phaseAmount}%`;
    }
    if (currentBarText) currentBarText.textContent = `${phaseAmount}%`;
    const phaseLabel = document.getElementById('maintenanceCurrentPhase');
    if (phaseLabel) {
      const current = phases.find((item) => item.id === activePhase) || phases[0];
      phaseLabel.textContent = current.labels[spanish ? 0 : 1];
    }
  }

  function enter() {
    const language = localStorage.getItem('wiki-language') === 'es' ? 'es' : 'en';
    document.documentElement.lang = language;
    document.title = language === 'es' ? 'Actualizando…' : 'Updating...';
    document.body.className = 'maintenance-body';
    document.body.innerHTML =
      '<main class="maintenance-card" aria-labelledby="maintenanceTitle"><div class="maintenance-mark" aria-hidden="true"><i></i><i></i><i></i></div><h1 id="maintenanceTitle">Updating...</h1><p class="maintenance-message">The site is temporarily unavailable.</p><div class="maintenance-progress" id="maintenanceProgress" role="progressbar" aria-label="Update progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="maintenance-track" cx="60" cy="60" r="52"></circle><circle class="maintenance-arc" id="maintenanceArc" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"></circle></svg><span id="maintenancePercent">0%</span></div><p class="maintenance-stage" id="maintenanceStage" role="status" aria-live="polite">Preparing the update...</p><div class="maintenance-current-phase"><span id="maintenanceCurrentPhase">Preparation</span><strong id="maintenanceCurrentPhasePercent">0%</strong></div><div class="maintenance-phase-track" id="maintenanceCurrentPhaseBar" role="progressbar" aria-label="Current phase progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div><ol class="maintenance-phases"><li id="maintenancePhase-preparation"><span>Preparation</span><small id="maintenancePhaseState-preparation">Pending</small><div class="maintenance-phase-item-track" id="maintenancePhaseBar-preparation" role="progressbar" aria-label="Preparation phase" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li><li id="maintenancePhase-verification"><span>Verification</span><small id="maintenancePhaseState-verification">Pending</small><div class="maintenance-phase-item-track" id="maintenancePhaseBar-verification" role="progressbar" aria-label="Verification phase" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li><li id="maintenancePhase-installation"><span>Installation</span><small id="maintenancePhaseState-installation">Pending</small><div class="maintenance-phase-item-track" id="maintenancePhaseBar-installation" role="progressbar" aria-label="Installation phase" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li><li id="maintenancePhase-finalization"><span>Finalization</span><small id="maintenancePhaseState-finalization">Pending</small><div class="maintenance-phase-item-track" id="maintenancePhaseBar-finalization" role="progressbar" aria-label="Finalization phase" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li></ol><span class="maintenance-rule" aria-hidden="true"></span><p class="maintenance-footnote">Please keep this page open.</p></main>';
    if (language === 'es') {
      document.getElementById('maintenanceTitle').textContent = 'Actualizando…';
      document.querySelector('.maintenance-message').textContent = 'El sitio estará temporalmente no disponible.';
      document.querySelector('.maintenance-footnote').textContent = 'Mantén esta página abierta.';
      for (const item of phases)
        document.querySelector(`#maintenancePhase-${item.id} > span`).textContent = item.labels[0];
      for (const item of phases)
        document.querySelector(`#maintenancePhaseBar-${item.id}`).setAttribute('aria-label', `${item.labels[0]}: progreso`);
      document.getElementById('maintenanceCurrentPhaseBar').setAttribute('aria-label', 'Progreso de la fase actual');
      document.getElementById('maintenanceProgress').setAttribute('aria-label', 'Progreso de actualización');
    }
    setProgress(0, 'preparing', 'preparation', 0);
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
            setProgress(status.progress, status.stage, status.phase, status.phaseProgress);
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
