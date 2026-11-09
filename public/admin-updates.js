'use strict';

window.TeralthAdminUpdates = {
  async render(root, { api, t, esc, showError, csrf }) {
    try {
      const result = await api('/api/admin/updates');
      const label = (spanish, english) => esc(t(spanish, english));
      const dateText = (value) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
      };
      root.innerHTML =
        '<section class="admin-section update-overview"><div class="section-heading"><div><h2>' +
        label('Actualizaciones del sitio', 'Site updates') +
        '</h2><p>' +
        label(
          'Instala un paquete firmado para actualizar el código o el esquema de la wiki.',
          'Install a signed package to update the wiki code or database schema.',
        ) +
        '</p></div><span class="update-version">' +
        label('Versión actual', 'Current version') +
        ' <strong>' +
        esc(result.currentVersion) +
        '</strong></span></div>' +
        (result.configured
          ? ''
          : '<p class="update-notice update-notice-warning" role="status"><i class="fa-solid fa-triangle-exclamation"></i> ' +
            label(
              'El servidor no tiene configurada la clave pública Ed25519. Pide al administrador del servidor que configure UPDATE_PUBLIC_KEY.',
              'The server has no Ed25519 public key configured. Ask the server administrator to configure UPDATE_PUBLIC_KEY.',
            ) +
            '</p>') +
        '</section><section class="admin-section update-install-section"><h2>' +
        label('Instalar un paquete', 'Install a package') +
        '</h2><p>' +
        label(
          'Antes de aplicar la actualización se creará un backup. Al terminar, el servidor se reiniciará automáticamente.',
          'A backup is created before the update is applied. The server restarts automatically when it finishes.',
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
        label('Verificar e instalar', 'Verify and install') +
        '</button><div class="update-validation" id="updateValidation" hidden role="status" aria-live="polite"><div class="update-validation-heading"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i><span id="updateValidationStage"></span><strong id="updateValidationPercent">0%</strong></div><div class="update-validation-track" id="updateValidationBar" role="progressbar" aria-label="' +
        label('Progreso de validación del paquete', 'Package validation progress') +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="updateValidationFill"></span></div></div><div class="form-message auth-error update-validation-error" hidden role="alert"></div></form></section><section class="admin-section update-history-section"><div class="section-heading"><div><h2>' +
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

      root.querySelector('#siteUpdateForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = root.querySelector('#siteUpdateFile')?.files?.[0];
        if (!file) return;
        const confirmation = await window.Swal.fire({
          icon: 'warning',
          title: t('¿Instalar esta actualización?', 'Install this update?'),
          text: t(
            'La wiki se reiniciará al terminar. No cierres esta ventana hasta que confirme que la actualización se instaló.',
            'The wiki will restart after installation. Keep this window open until the update is confirmed.',
          ),
          showCancelButton: true,
          confirmButtonText: t('Instalar actualización', 'Install update'),
          cancelButtonText: t('Cancelar', 'Cancel'),
          reverseButtons: true,
        });
        if (!confirmation.isConfirmed) return;
        const button = root.querySelector('#applySiteUpdate');
        const progress = root.querySelector('#updateValidation'),
          progressStage = root.querySelector('#updateValidationStage'),
          progressPercent = root.querySelector('#updateValidationPercent'),
          progressBar = root.querySelector('#updateValidationBar'),
          progressFill = root.querySelector('#updateValidationFill'),
          errorBox = root.querySelector('.update-validation-error');
        const validationLabels = {
          receiving: t('Subiendo el paquete para validarlo…', 'Uploading the package for validation…'),
          verifying: t('Comprobando firma, clave SSH, hashes y archivos…', 'Checking the signature, SSH key, hashes, and files…'),
          preflight: t('Revisando sintaxis, rutas y disponibilidad del servidor…', 'Checking syntax, paths, and server readiness…'),
          verified: t('Validación completa. Preparando el mantenimiento…', 'Validation complete. Preparing maintenance…'),
          failed: t('La validación falló. El sitio sigue disponible.', 'Validation failed. The site remains available.'),
        };
        const showValidationProgress = (value, stage) => {
          const amount = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
          progress.hidden = false;
          progressStage.textContent = validationLabels[stage] || validationLabels.verifying;
          progressPercent.textContent = `${amount}%`;
          progressBar.setAttribute('aria-valuenow', String(amount));
          progressFill.style.width = `${amount}%`;
          progress.classList.toggle('is-failed', stage === 'failed');
          progress.classList.toggle('is-complete', stage === 'verified');
        };
        button.disabled = true;
        errorBox.hidden = true;
        showValidationProgress(0, 'receiving');
        let maintenanceEntered = false;
        let validationPolling = true;
        const pollValidation = async () => {
          while (validationPolling) {
            try {
              const status = await api('/api/admin/updates/validation-progress');
              if (status.active || status.stage === 'verified' || status.stage === 'failed')
                showValidationProgress(status.progress, status.stage);
            } catch {
              progressStage.textContent = t('Esperando el estado de validación del servidor…', 'Waiting for the server validation status…');
            }
            await new Promise((resolve) => window.setTimeout(resolve, 350));
          }
        };
        const validationPoll = pollValidation();
        try {
          const form = new FormData();
          form.append('package', file);
          const validated = await uploadPackage(form, csrf, (amount, stage) =>
            showValidationProgress(amount, stage),
          );
          validationPolling = false;
          showValidationProgress(100, 'verified');
          if (!validated.token) throw new Error(t('El servidor no devolvió una autorización de instalación válida.', 'The server did not return a valid installation authorization.'));
          await loadMaintenanceAssets();
          window.TeralthMaintenance.enter();
          maintenanceEntered = true;
          await api('/api/admin/updates/install', {
            method: 'POST',
            body: JSON.stringify({ token: validated.token }),
          });
        } catch (error) {
          validationPolling = false;
          await validationPoll;
          if (maintenanceEntered) {
            window.TeralthMaintenance.setProgress(0, 'failed');
            window.setTimeout(() => window.location.reload(), 11000);
          } else {
            showValidationProgress(
              Number(progressBar.getAttribute('aria-valuenow') || 0),
              'failed',
            );
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            button.disabled = false;
            if (error.status >= 500) showError(root, error);
          }
        }
      });
    } catch (error) {
      showError(root, error);
    }
  },
};

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
        onProgress(3 + Math.floor((event.loaded / event.total) * 15), 'receiving');
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
