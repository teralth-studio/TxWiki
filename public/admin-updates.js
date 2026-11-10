'use strict';

window.TeralthAdminUpdates = {
  async openProgressPage({ automatic, file, t }) {
    const transferId = await storeUpdateTransfer({ automatic, file, t });
    location.assign(`/admin/updates/progress?transfer=${encodeURIComponent(transferId)}`);
  },
  async render(root, { api, t, esc, showError, csrf, navigate, canManageBackups, startSeparateUpdate, autoStart }) {
    try {
      const result = await api('/api/admin/updates');
      const label = (spanish, english) => esc(t(spanish, english));
      const dateText = (value) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
      };
      root.innerHTML =
        '<section class="admin-section update-overview"><div class="section-heading"><div><h2>' +
        label('Actualización', 'Update') +
        '</h2><p>' +
        label(
          'Consulta e instala versiones oficiales, o carga manualmente un paquete firmado.',
          'Check for and install official releases, or upload a signed package manually.',
        ) +
        '</p></div><div class="update-version-row"><span class="update-version-badge is-checking" id="updateVersionBadge">' +
        label('Versión actual', 'Current version') +
        ' <strong>' +
        esc(result.currentVersion) +
        '</strong></span><button class="secondary-button" id="checkSiteUpdates" type="button"><i class="fa-solid fa-rotate" aria-hidden="true"></i> ' +
        label('Buscar actualizaciones', 'Check for updates') +
        '</button></div></div><p class="update-release-status" id="updateReleaseStatus" role="status" aria-live="polite">' +
        label('Buscando la versión más reciente…', 'Checking for the latest version…') +
        '</p>' +
        (result.configured
          ? ''
          : '<p class="update-notice update-notice-warning" role="status"><i class="fa-solid fa-triangle-exclamation"></i> ' +
            label(
              'El servidor no tiene configurada la clave pública Ed25519. Pide al administrador del servidor que configure UPDATE_PUBLIC_KEY.',
              'The server has no Ed25519 public key configured. Ask the server administrator to configure UPDATE_PUBLIC_KEY.',
            ) +
            '</p>') +
        '</section><section class="admin-section update-automatic-section"><h2>' +
        label('Descargar automáticamente', 'Automatic update') +
        '</h2><p>' +
        label(
          'Descarga la versión oficial más reciente y actualiza el sistema sin subir un ZIP.',
          'Download the latest official release and update the system without uploading a ZIP.',
        ) +
        '</p><p class="update-notice update-notice-info" id="updateAutomaticNotice" role="status"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>' +
        label('Buscando actualizaciones…', 'Checking for updates…') +
        '</span></p><button class="primary-button" id="applyAutomaticUpdate" type="button" disabled><i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i> ' +
        label('Actualizar', 'Update') +
        '</button></section><section class="admin-section update-install-section"><h2>' +
        label('Descargar manualmente', 'Manual update') +
        '</h2><p>' +
        label(
          'Carga un paquete ZIP firmado para actualizar el código o el esquema de la wiki.',
          'Upload a signed ZIP package to update the wiki code or database schema.',
        ) +
        '</p><p class="update-notice update-notice-warning" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ' +
        label(
          'Recomendamos no actualizar manualmente, a no ser que sepas lo que estás haciendo.',
          'Manual updates are not recommended unless you know what you are doing.',
        ) +
        '</p><form id="siteUpdateForm"><label class="update-file-picker"><i class="fa-solid fa-file-zipper" aria-hidden="true"></i><span><strong>' +
        label('Selecciona el paquete ZIP firmado', 'Select a signed ZIP package') +
        '</strong><small>' +
        label('Formato .zip · máximo 64 MB', '.zip format · 64 MB maximum') +
        '</small><input type="file" id="siteUpdateFile" name="package" accept=".zip,application/zip" required ' +
        (result.configured ? '' : 'disabled') +
        '></span></label><p class="update-notice" role="note"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> ' +
        label(
          'Se valida que la clave SSH del ZIP coincida con la oficial, además de comprobar firma, hashes, rutas y sintaxis. El código no se ejecuta durante estas comprobaciones.',
          'The ZIP SSH key must match the official key; its signature, hashes, paths, and syntax are also checked. Package code is not executed during these checks.',
        ) +
        '</p><button class="primary-button" id="applySiteUpdate" type="submit" ' +
        (result.configured ? '' : 'disabled') +
        '><i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i> ' +
        label('Actualizar manualmente', 'Update manually') +
        '</button></form><div class="update-validation" id="updateValidation" hidden><div class="update-validation-heading" role="status" aria-live="polite"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i><span id="updateValidationStage"></span><strong id="updateValidationPercent">0%</strong></div><div class="update-progress-layout"><ol class="update-phase-list"><li data-update-phase="preparation"><div class="update-phase-heading"><span>' +
        label('Preparación', 'Preparation') +
        '</span><small></small></div><div class="update-phase-item-track" role="progressbar" aria-label="' +
        label('Progreso de preparación', 'Preparation progress') +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li><li data-update-phase="verification"><div class="update-phase-heading"><span>' +
        label('Verificación', 'Verification') +
        '</span><small></small></div><div class="update-phase-item-track" role="progressbar" aria-label="' +
        label('Progreso de verificación', 'Verification progress') +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li><li data-update-phase="installation"><div class="update-phase-heading"><span>' +
        label('Instalación', 'Installation') +
        '</span><small></small></div><div class="update-phase-item-track" role="progressbar" aria-label="' +
        label('Progreso de instalación', 'Installation progress') +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li><li data-update-phase="finalization"><div class="update-phase-heading"><span>' +
        label('Finalización', 'Finalization') +
        '</span><small></small></div><div class="update-phase-item-track" role="progressbar" aria-label="' +
        label('Progreso de finalización', 'Finalization progress') +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></li></ol><div class="update-progress-main"><div class="update-overall-progress" id="updateValidationBar" role="progressbar" aria-label="' +
        label('Progreso total de actualización', 'Overall update progress') +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="update-overall-track" cx="60" cy="60" r="52"></circle><circle class="update-overall-arc" id="updateValidationArc" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"></circle></svg><span id="updateValidationRingPercent">0%</span></div><p class="update-current-phase"><span id="updateCurrentPhase"></span><strong id="updateCurrentPhasePercent">0%</strong></p></div></div><div class="form-message auth-error update-validation-error" hidden role="alert"></div></section><section class="admin-section update-history-section"><div class="section-heading"><div><h2>' +
        label('Actualizaciones instaladas', 'Installed updates') +
        '</h2><p>' +
        label('Las diez instalaciones más recientes en este sitio.', 'The ten most recent installations on this site.') +
        '</p></div></div>' +
        (result.updates.length
          ? '<div class="update-history">' +
            result.updates
              .map(
                (update) =>
                  '<div class="update-history-row"><span><strong>' +
                  esc(update.release_version) +
                  '</strong><small>' +
                  esc(update.update_id) +
                  '</small></span><time>' +
                  esc(dateText(update.applied_at)) +
                  '</time></div>',
              )
              .join('') +
            '</div>'
          : '<p class="empty-state">' +
            label('Todavía no se han instalado actualizaciones.', 'No updates have been installed yet.') +
            '</p>') +
        '</section>';

      const refreshButton = root.querySelector('#checkSiteUpdates');
      const automaticButton = root.querySelector('#applyAutomaticUpdate');
      let releaseOverview = null;
      let releaseError = null;

      const renderReleaseOverview = () => {
        const badge = root.querySelector('#updateVersionBadge');
        const status = root.querySelector('#updateReleaseStatus');
        const notice = root.querySelector('#updateAutomaticNotice span');
        if (!releaseOverview && !releaseError) {
          badge.className = 'update-version-badge is-checking';
          badge.innerHTML =
            label('Versión actual', 'Current version') + ' <strong>' + esc(result.currentVersion) + '</strong>';
          status.textContent = t('Buscando la versión más reciente…', 'Checking for the latest version…');
          notice.textContent = status.textContent;
          automaticButton.disabled = true;
          return;
        }
        if (releaseError) {
          badge.className = 'update-version-badge is-unavailable';
          badge.innerHTML =
            label('Versión actual', 'Current version') + ' <strong>' + esc(result.currentVersion) + '</strong>';
          status.textContent = t(
            'No se pudo consultar la versión oficial. Puedes intentarlo de nuevo o actualizar manualmente.',
            'The official version could not be checked. Try again or update manually.',
          );
          notice.textContent = status.textContent;
          automaticButton.disabled = true;
          return;
        }
        const isAvailable = releaseOverview.available;
        badge.className = `update-version-badge ${isAvailable ? 'is-available' : 'is-current'}`;
        badge.innerHTML =
          label('Versión actual', 'Current version') +
          ' <strong>' +
          esc(result.currentVersion) +
          '</strong>';
        status.textContent = isAvailable
          ? t(
              `Estás actualmente a ${releaseOverview.versionsBehind} ${releaseOverview.versionsBehind === 1 ? 'versión' : 'versiones'} de la versión más reciente.`,
              `You are currently ${releaseOverview.versionsBehind} version${releaseOverview.versionsBehind === 1 ? '' : 's'} behind the latest release.`,
            )
          : t(
              'Te encuentras en la versión más reciente del sistema, no hay actualizaciones disponibles.',
              'You are on the latest system version. No updates are available.',
            );
        notice.textContent = isAvailable
          ? t(
              `Se ha detectado una actualización disponible: ${releaseOverview.latestVersion}`,
              `An update is available: ${releaseOverview.latestVersion}`,
            )
          : t('No hay actualizaciones disponibles.', 'No updates are available.');
        automaticButton.disabled = !(
          isAvailable &&
          result.configured &&
          releaseOverview.assetAvailable
        );
        if (isAvailable && !releaseOverview.assetAvailable)
          notice.textContent = t(
            `La release ${releaseOverview.latestVersion} no contiene el ZIP oficial esperado.`,
            `Release ${releaseOverview.latestVersion} does not contain the expected official ZIP.`,
          );
      };

      const refreshReleaseOverview = async () => {
        refreshButton.disabled = true;
        refreshButton.classList.add('is-loading');
        releaseOverview = null;
        releaseError = null;
        renderReleaseOverview();
        try {
          releaseOverview = await api('/api/admin/updates/latest');
        } catch (error) {
          releaseError = error;
        } finally {
          refreshButton.disabled = false;
          refreshButton.classList.remove('is-loading');
          renderReleaseOverview();
        }
      };

      refreshButton.addEventListener('click', refreshReleaseOverview);
      automaticButton.addEventListener('click', async () =>
        runUpdate({
          automatic: true,
          button: automaticButton,
          root,
          api,
          csrf,
          t,
          showError,
          canManageBackups,
          navigate,
          startSeparateUpdate,
        }),
      );
      root.querySelector('#siteUpdateForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = root.querySelector('#siteUpdateFile')?.files?.[0];
        if (!file) return;
        await runUpdate({
          automatic: false,
          file,
          button: root.querySelector('#applySiteUpdate'),
          root,
          api,
          csrf,
          t,
          showError,
          canManageBackups,
          navigate,
          startSeparateUpdate,
        });
      });

      renderReleaseOverview();
      refreshReleaseOverview();
      if (autoStart) {
        await runUpdate({
          ...autoStart,
          confirmed: true,
          button: root.querySelector(autoStart.automatic ? '#applyAutomaticUpdate' : '#applySiteUpdate'),
          root,
          api,
          csrf,
          t,
          showError,
          canManageBackups,
          navigate,
        });
      }
    } catch (error) {
      showError(root, error);
    }
  },
};

const updatePhases = ['preparation', 'verification', 'installation', 'finalization'];
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

function openUpdateTransferDatabase(t) {
  if (!window.indexedDB)
    throw new Error(t('Este navegador no permite preparar la actualización.', 'This browser cannot prepare the update.'));
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open('txwiki-update-transfer', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('transfers'))
        request.result.createObjectStore('transfers', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error(t('No se pudo preparar la actualización.', 'Could not prepare the update.')));
  });
}

async function storeUpdateTransfer({ automatic, file, t }) {
  const packageFile = file
    ? {
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        bytes: await file.arrayBuffer(),
      }
    : null;
  const database = await openUpdateTransferDatabase(t);
  const transferId = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('transfers', 'readwrite');
    transaction.objectStore('transfers').put({ id: transferId, automatic, file: packageFile });
    transaction.oncomplete = () => {
      database.close();
      resolve(transferId);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error(t('No se pudo preparar la actualización.', 'Could not prepare the update.')));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error(t('No se pudo preparar la actualización.', 'Could not prepare the update.')));
    };
  });
}

async function consumeUpdateTransfer(transferId, t) {
  const database = await openUpdateTransferDatabase(t);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('transfers', 'readwrite');
    const store = transaction.objectStore('transfers');
    let transfer = null;
    const request = store.get(transferId);
    request.onsuccess = () => {
      transfer = request.result || null;
      if (transfer) store.delete(transferId);
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(transfer);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error(t('No se pudo abrir la actualización.', 'Could not open the update.')));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error(t('No se pudo abrir la actualización.', 'Could not open the update.')));
    };
  });
}

async function runUpdate({
  automatic,
  file,
  button,
  root,
  api,
  csrf,
  t,
  showError,
  canManageBackups,
  navigate,
  startSeparateUpdate,
  confirmed = false,
}) {
  if (!confirmed) {
    const confirmation = await window.Swal.fire({
      icon: 'warning',
      title: t('¿Estás seguro que deseas actualizar?', 'Are you sure you want to update?'),
      text: t(
        'Antes de realizar una actualización, recuerda tener una copia de seguridad de tu sistema.',
        'Remember to create a backup of your system before updating.',
      ),
      showCancelButton: true,
      showDenyButton: Boolean(canManageBackups),
      confirmButtonText: t('Actualizar', 'Update'),
      denyButtonText: t('Crear backup', 'Create backup'),
      cancelButtonText: t('Cancelar', 'Cancel'),
      reverseButtons: true,
    });
    if (confirmation.isDenied) {
      await navigate?.('backups');
      return;
    }
    if (!confirmation.isConfirmed) return;
  }

  if (startSeparateUpdate) {
    try {
      await startSeparateUpdate({ automatic, file });
    } catch (error) {
      const errorBox = root.querySelector('.update-validation-error');
      if (errorBox) {
        errorBox.textContent = error.message || String(error);
        errorBox.hidden = false;
      } else {
        showError(root, error);
      }
    }
    return;
  }

  const progress = root.querySelector('#updateValidation');
  const stage = root.querySelector('#updateValidationStage');
  const percent = root.querySelector('#updateValidationPercent');
  const overallBar = root.querySelector('#updateValidationBar');
  const ringPercent = root.querySelector('#updateValidationRingPercent');
  const ring = root.querySelector('#updateValidationArc');
  const phaseLabel = root.querySelector('#updateCurrentPhase');
  const phasePercent = root.querySelector('#updateCurrentPhasePercent');
  const errorBox = root.querySelector('.update-validation-error');
  const standaloneUpdater = Boolean(document.querySelector('.standalone-updater-shell')?.isConnected);
  const stageLabels = {
    receiving: t('Preparando el paquete de actualización…', 'Preparing the update package…'),
    preparing: t('Preparando el entorno…', 'Preparing the environment…'),
    verifying: t('Verificando firma, clave y archivos…', 'Verifying the signature, key, and files…'),
    preflight: t('Comprobando el entorno de instalación…', 'Checking the installation environment…'),
    verified: t('Verificación completa. Iniciando instalación…', 'Verification complete. Starting installation…'),
    backup: t('Creando una copia de seguridad…', 'Creating a backup…'),
    'backup-complete': t('Copia de seguridad lista. Preparando archivos…', 'Backup ready. Preparing files…'),
    staging: t('Preparando los archivos de actualización…', 'Preparing update files…'),
    'installing-files': t('Instalando los archivos verificados…', 'Installing verified files…'),
    migrations: t('Aplicando cambios de base de datos…', 'Applying database changes…'),
    finalizing: t('Finalizando la actualización…', 'Finalizing the update…'),
    complete: t('Actualización completa. Reiniciando el sitio…', 'Update complete. Restarting the site…'),
    failed: t('La actualización no pudo completarse. El sitio se abrirá pronto.', 'The update could not be completed. The site will reopen shortly.'),
  };
  const phaseLabels = {
    preparation: t('Preparación', 'Preparation'),
    verification: t('Verificación', 'Verification'),
    installation: t('Instalación', 'Installation'),
    finalization: t('Finalización', 'Finalization'),
  };
  const showProgress = (value, currentStage, phase = stagePhases[currentStage], phaseValue = value) => {
    const overall = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const currentPhase = phase || 'preparation';
    const currentAmount = Math.max(0, Math.min(100, Math.round(Number(phaseValue) || 0)));
    const currentIndex = updatePhases.indexOf(currentPhase);
    progress.hidden = false;
    stage.textContent = stageLabels[currentStage] || stageLabels.verifying;
    percent.textContent = `${overall}%`;
    ringPercent.textContent = `${overall}%`;
    overallBar.setAttribute('aria-valuenow', String(overall));
    ring.setAttribute('stroke-dashoffset', String(100 - overall));
    phaseLabel.textContent = phaseLabels[currentPhase] || phaseLabels.preparation;
    phasePercent.textContent = `${currentAmount}%`;
    for (const [index, phaseName] of updatePhases.entries()) {
      const item = root.querySelector(`[data-update-phase="${phaseName}"]`);
      const state = item?.querySelector('small');
      const complete = currentStage === 'complete' || index < currentIndex;
      const active = index === currentIndex && currentStage !== 'complete';
      const amount = complete ? 100 : active ? currentAmount : 0;
      const phaseBar = item?.querySelector('[role="progressbar"]');
      item?.classList.toggle('is-complete', complete);
      item?.classList.toggle('is-active', active);
      item?.classList.toggle('is-failed', active && currentStage === 'failed');
      phaseBar?.setAttribute('aria-valuenow', String(amount));
      if (phaseBar?.firstElementChild) phaseBar.firstElementChild.style.width = `${amount}%`;
      if (state)
        state.textContent = complete
          ? t('Completada', 'Complete')
          : active
            ? t('En curso', 'In progress')
            : t('Pendiente', 'Pending');
    }
    progress.classList.toggle('is-failed', currentStage === 'failed');
    progress.classList.toggle('is-complete', currentStage === 'complete');
  };

  button.disabled = true;
  errorBox.hidden = true;
  if (document.querySelector('.standalone-updater-shell') && document.body?.classList)
    document.body.classList.add('is-updating');
  showProgress(0, automatic ? 'preparing' : 'receiving', 'preparation', 0);
  let installationStarted = false;
  let validationPolling = true;
  const pollValidation = async () => {
    while (validationPolling) {
      try {
        const status = await api('/api/admin/updates/validation-progress');
        if (status.active || status.stage === 'verified' || status.stage === 'failed')
          showProgress(status.progress, status.stage, status.phase, status.phaseProgress);
      } catch {
        stage.textContent = t(
          'Esperando el estado de validación del servidor…',
          'Waiting for the server validation status…',
        );
      }
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  };
  const validationPoll = pollValidation();
  try {
    let validated;
    if (automatic) {
      validated = await api('/api/admin/updates/automatic/validate', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } else {
      const form = new FormData();
      form.append('package', file);
      validated = await uploadPackage(form, csrf, (amount) =>
        showProgress(10 + Math.floor((amount / 100) * 8), 'receiving', 'preparation', amount),
      );
    }
    validationPolling = false;
    await validationPoll;
    showProgress(45, 'verified', 'verification', 100);
    if (!validated.token)
      throw new Error(t('El servidor no devolvió una autorización de instalación válida.', 'The server did not return a valid installation authorization.'));
    installationStarted = true;
    if (standaloneUpdater) {
      const pollUpdateProgress = async () => {
        let hasSeenActiveUpdate = false;
        while (document.body.contains(root)) {
          try {
            const status = await api('/api/updates/progress');
            if (status.active) {
              hasSeenActiveUpdate = true;
              showProgress(status.progress, status.stage, status.phase, status.phaseProgress);
            } else if (hasSeenActiveUpdate) {
              window.location.assign('/admin/updates?space=main');
              return;
            }
          } catch {
            stage.textContent = t(
              'Esperando que el servidor complete el reinicio…',
              'Waiting for the server to finish restarting…',
            );
          }
          await new Promise((resolve) => window.setTimeout(resolve, 600));
        }
      };
      pollUpdateProgress();
    } else {
      await loadMaintenanceAssets();
      window.TeralthMaintenance.enter();
    }
    await api('/api/admin/updates/install', {
      method: 'POST',
      body: JSON.stringify({ token: validated.token }),
    });
  } catch (error) {
    validationPolling = false;
    await validationPoll;
    if (installationStarted) {
      if (standaloneUpdater) {
        showProgress(
          Number(overallBar.getAttribute('aria-valuenow') || 0),
          'failed',
          updatePhases.find((phaseName) => root.querySelector(`[data-update-phase="${phaseName}"].is-active`)) ||
            'preparation',
          0,
        );
        errorBox.textContent = error.message;
        errorBox.hidden = false;
        button.disabled = false;
      } else {
        window.TeralthMaintenance.setProgress(0, 'failed');
        window.setTimeout(() => window.location.reload(), 11000);
      }
    } else {
      showProgress(
        Number(overallBar.getAttribute('aria-valuenow') || 0),
        'failed',
        updatePhases.find((phaseName) => root.querySelector(`[data-update-phase="${phaseName}"].is-active`)) ||
          'preparation',
        0,
      );
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
      if (error.status >= 500) showError(root, error);
    }
  }
}

function loadMaintenanceAssets() {
  const styles = document.querySelector('link[data-maintenance-style]')
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/maintenance.css';
        link.dataset.maintenanceStyle = 'true';
        link.onload = resolve;
        link.onerror = () => reject(new Error('The maintenance screen could not be loaded.'));
        document.head.append(link);
      });
  const script = window.TeralthMaintenance
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const element = document.createElement('script');
        element.src = '/maintenance.js';
        element.onload = resolve;
        element.onerror = () => reject(new Error('The update progress display could not be loaded.'));
        document.head.append(element);
      });
  return Promise.all([styles, script]);
}

function uploadPackage(form, csrf, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/admin/updates/validate');
    request.withCredentials = true;
    request.timeout = 15 * 60 * 1000;
    request.setRequestHeader('X-CSRF-Token', String(csrf || ''));
    request.setRequestHeader('Accept', 'application/json');
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0)
        onProgress(Math.floor((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => {
      let response = {};
      try {
        response = JSON.parse(request.responseText);
      } catch {
        reject(new Error('The update server returned an invalid response.'));
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(response);
      } else {
        const error = new Error(response.error || `Update failed (HTTP ${request.status}).`);
        error.status = request.status;
        reject(error);
      }
    });
    request.addEventListener('error', () => reject(new Error('The update connection was interrupted.')));
    request.addEventListener('timeout', () => reject(new Error('The update request timed out.')));
    request.addEventListener('abort', () => reject(new Error('The update request was cancelled.')));
    request.send(form);
  });
}

if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('updateApp')) {
  const root = document.getElementById('updateApp');
  const errorBox = document.getElementById('updatePageError');
  let language = localStorage.getItem('wiki-language')?.toLowerCase().startsWith('es') ? 'es' : 'en';
  let csrf = '';
  const t = (spanish, english) => (language === 'es' ? spanish : english);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const showError = (_target, error) => {
    errorBox.textContent = error.message || String(error);
    errorBox.hidden = false;
  };
  const api = async (url, options = {}) => {
    const headers = {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || t('Ocurrió un error.', 'Something went wrong.'));
      error.status = response.status;
      throw error;
    }
    return body;
  };
  const renderLanguage = () => {
    document.documentElement.lang = language;
    document.title = t('Actualizador del sistema', 'System updater');
    document.querySelectorAll('[data-es][data-en]').forEach((element) => {
      element.textContent = element.dataset[language];
    });
    document.getElementById('updateLanguageToggle').textContent = language === 'es' ? 'EN' : 'ES';
  };
  document.getElementById('updateLanguageToggle').addEventListener('click', () => {
    language = language === 'es' ? 'en' : 'es';
    localStorage.setItem('wiki-language', language);
    renderLanguage();
  });
  if (localStorage.getItem('wiki-theme') === 'light') document.body.classList.add('light');
  renderLanguage();
  (async () => {
    const session = await api('/api/auth/me');
    if (!session.user) {
      location.assign('/login?next=%2Fadmin%2Fupdates%2Fprogress');
      return;
    }
    csrf = session.csrfToken;
    const user = session.user;
    const hasPermission = user.isPrimaryAdmin || user.role === 'administrator' ||
      user.permissions?.includes('updates.install');
    if (!hasPermission) throw new Error(t('No tienes permiso para instalar actualizaciones.', 'You do not have permission to install updates.'));
    const canManageBackups = user.isPrimaryAdmin || user.role === 'administrator' ||
      ['backups.import', 'backups.export', 'backups.schedule'].some((permission) => user.permissions?.includes(permission));
    const transferId = new URLSearchParams(location.search).get('transfer');
    const transfer = transferId ? await consumeUpdateTransfer(transferId, t) : null;
    if (transferId && !transfer)
      throw new Error(t('La solicitud de actualización venció. Vuelve al panel e inténtalo otra vez.', 'The update request expired. Return to the admin panel and try again.'));
    if (transfer && !transfer.automatic) {
      if (!transfer.file?.bytes)
        throw new Error(t('No se pudo recuperar el archivo del paquete. Vuelve al panel e inténtalo otra vez.', 'The update package could not be recovered. Return to the admin panel and try again.'));
      transfer.file = new File([transfer.file.bytes], transfer.file.name, {
        type: transfer.file.type,
        lastModified: transfer.file.lastModified,
      });
    }
    await window.TeralthAdminUpdates.render(root, {
      api,
      t,
      esc,
      showError,
      csrf,
      canManageBackups,
      navigate: (tab) => location.assign(`/admin/${tab}?space=main`),
      autoStart: transfer ? { automatic: transfer.automatic, file: transfer.file } : null,
    });
  })().catch((error) => showError(root, error));
}
