(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const icons = { google: 'fa-brands fa-google', discord: 'fa-brands fa-discord', github: 'fa-brands fa-github' };
  function renderProfileIdentity(avatar, username) {
    const brand = $('.sidebar .admin-brand');
    if (!brand) return;
    const initials = document.createElement('span');
    initials.className = 'admin-brand-initials';
    initials.textContent = String(username || '').slice(0, 2).toUpperCase();
    let mark = initials;
    if (/^\/media\/(?:[A-Za-z0-9_-]{16}|[a-f0-9-]{36})\.(?:png|jpg|gif|webp)$/.test(avatar || '')) {
      mark = document.createElement('img');
      mark.className = 'admin-brand-logo';
      mark.alt = '';
      mark.width = 34;
      mark.height = 34;
      mark.onerror = () => mark.replaceWith(initials);
      mark.src = avatar;
    }
    brand.querySelector('.admin-brand-initials, .admin-brand-logo')?.remove();
    brand.prepend(mark);
    $('strong', brand).textContent = username;
  }
  async function adminConnections(root, { api, t, esc, Swal, notify }) {
    const result = await api('/api/admin/connections');
    root.innerHTML = `<section class="admin-section"><div class="section-heading"><div><h2>${t('Lista de conexiones', 'Connection list')}</h2><p>${t('Configura los proveedores disponibles para vincular e iniciar sesión.', 'Configure providers for account linking and sign-in.')}</p></div><button class="primary-button" id="addConnection">${t('Añadir conexión', 'Add connection')}</button></div><div id="connectionRows">${result.connections.map(item => `<div class="profile-connection-row"><strong><i class="${icons[item.provider]}" aria-hidden="true"></i> ${esc(result.providers.find(provider => provider.provider === item.provider)?.name || item.provider)}</strong><div><button class="secondary-button" data-edit-connection="${esc(item.provider)}">${t('Editar', 'Edit')}</button> <button class="danger-button" data-delete-connection="${esc(item.provider)}">${t('Eliminar', 'Delete')}</button></div></div>`).join('') || `<p>${t('No hay conexiones configuradas.', 'No connections configured.')}</p>`}</div></section>`;
    const edit = async existing => {
      const available = existing ? result.providers.filter(item => item.provider === existing.provider) : result.providers.filter(item => !result.connections.some(connection => connection.provider === item.provider));
      if (!available.length) return notify({ icon: 'info', title: t('Todos los proveedores están configurados.', 'All providers are configured.') });
      const response = await Swal.fire({
        title: existing ? t('Editar conexión', 'Edit connection') : t('Añadir conexión', 'Add connection'),
        html: `<div class="profile-dialog-form"><label>${t('Proveedor', 'Provider')}<select id="connectionProvider">${available.map(item => `<option value="${item.provider}">${esc(item.name)}</option>`).join('')}</select></label><label>Client ID<input id="connectionClient" maxlength="255" value="${esc(existing?.clientId || '')}" autocomplete="off"></label><label>Client Secret<input id="connectionSecret" type="password" maxlength="4096" autocomplete="new-password" placeholder="${existing ? t('Dejar vacío para conservar', 'Leave blank to keep current secret') : ''}"></label><label>Redirect URI<input id="connectionRedirect" readonly></label><p>${t('Registra esta URL exacta en la consola del proveedor. Los secretos guardados nunca se muestran.', 'Register this exact URL in the provider console. Saved secrets are never displayed.')}</p></div>`,
        showCancelButton: true, confirmButtonText: t('Guardar cambios', 'Save changes'), cancelButtonText: t('Cancelar', 'Cancel'), focusConfirm: false,
        didOpen: () => { const popup = Swal.getPopup(); const update = () => { $('#connectionRedirect', popup).value = available.find(item => item.provider === $('#connectionProvider', popup).value).redirectUri; }; $('#connectionProvider', popup).onchange = update; update(); },
        preConfirm: async () => {
          const popup = Swal.getPopup(), provider = $('#connectionProvider', popup).value;
          try { await api(`/api/admin/connections/${provider}`, { method: 'PUT', body: JSON.stringify({ clientId: $('#connectionClient', popup).value, clientSecret: $('#connectionSecret', popup).value, redirectUri: $('#connectionRedirect', popup).value }) }); return true; }
          catch (error) { Swal.showValidationMessage(esc(error.message)); return false; }
        },
      });
      if (response.isConfirmed) { notify({ icon: 'success', title: t('Conexión guardada', 'Connection saved') }); await adminConnections(root, { api, t, esc, Swal, notify }); }
    };
    $('#addConnection', root).onclick = () => edit();
    root.querySelectorAll('[data-edit-connection]').forEach(button => { button.onclick = () => edit(result.connections.find(item => item.provider === button.dataset.editConnection)); });
    root.querySelectorAll('[data-delete-connection]').forEach(button => { button.onclick = async () => {
      const response = await Swal.fire({ icon: 'warning', title: t('¿Eliminar conexión?', 'Delete connection?'), text: t('También se eliminarán las vinculaciones de usuarios que dependen de esta conexión.', 'User integrations linked to this connection will also be removed.'), showCancelButton: true, confirmButtonText: t('Eliminar', 'Delete'), cancelButtonText: t('Cancelar', 'Cancel') });
      if (!response.isConfirmed) return;
      try { await api(`/api/admin/connections/${button.dataset.deleteConnection}`, { method: 'DELETE' }); await adminConnections(root, { api, t, esc, Swal, notify }); }
      catch (error) { notify({ icon: 'error', title: error.message }); }
    }; });
  }
  async function profile(section, deps) {
    const { api, t, esc, Swal, notify, state, setView, setAuthLink, createCaptchaController, checkPassword } = deps;
    const sections = [['summary', t('Resumen', 'Summary'), 'user'], ['notifications', t('Notificaciones', 'Notifications'), 'bell'], ['connections', t('Conexiones', 'Connections'), 'plug'], ['settings', t('Ajustes de perfil', 'Profile settings'), 'cog'], ['security', t('Seguridad', 'Security'), 'shield']];
    if (!sections.some(([key]) => key === section)) section = 'summary';
    setView('adminPanel');
    document.body.classList.add('profile-mode');
    $('#adminNavigation').hidden = false;
    $('#adminNavigation').innerHTML = sections.map(([key, title, icon]) => `<button type="button" class="admin-nav-item${key === section ? ' active' : ''}" data-profile-section="${key}"${key === section ? ' aria-current="page"' : ''}><i class="fa-solid fa-${icon}" aria-hidden="true"></i><span>${esc(title)}</span></button>`).join('');
    document.querySelectorAll('[data-profile-section]').forEach(button => { button.onclick = () => { location.href = `/profile/${button.dataset.profileSection}`; }; });
    $('.brand-row').className = 'brand-row admin-brand-row';
    $('.brand-row').innerHTML = `<div class="admin-brand"><span class="admin-brand-initials">${esc(state.user.username.slice(0, 2).toUpperCase())}</span><div><strong>${esc(state.user.username)}</strong><span>${t('Mi cuenta', 'My account')}</span></div></div><button class="icon-button mobile-close" id="closeSidebar" aria-label="${t('Cerrar menú', 'Close menu')}"><i class="fa-solid fa-xmark"></i></button>`;
    $('#closeSidebar').onclick = deps.closeMobileNav;
    const title = sections.find(([key]) => key === section)[1];
    $('#breadcrumbs').innerHTML = `<span>${t('Mi cuenta', 'My account')}</span><i class="fa-solid fa-chevron-right"></i><span>${esc(title)}</span>`;
    $('#adminPanel').innerHTML = `<div class="admin-heading"><h1>${esc(title)}</h1></div><div id="profileContent"></div>`;
    const root = $('#profileContent'), data = await api('/api/profile');
    renderProfileIdentity(data.profile.avatar || data.user.avatar, data.user.username);
    const success = () => notify({ icon: 'success', title: t('Cambios guardados', 'Changes saved') });
    const field = (label, name, type = 'text', value = '') => `<label class="field"><span>${label}</span><input class="settings-input" name="${name}" type="${type}" value="${esc(value)}" ${type === 'password' ? 'autocomplete="current-password"' : ''}></label>`;
    const passwordPrompt = async (title, text = '') => Swal.fire({ title, text, input: 'password', inputAttributes: { autocomplete: 'current-password' }, showCancelButton: true, confirmButtonText: t('Confirmar', 'Confirm'), cancelButtonText: t('Cancelar', 'Cancel'), inputValidator: value => !value ? t('Ingresa tu contraseña actual.', 'Enter your current password.') : undefined });
    const submit = (form, callback) => { form.onsubmit = async event => { event.preventDefault(); const button = form.querySelector('button[type="submit"]'); button.disabled = true; try { await callback(new FormData(form)); } catch (error) { notify({ icon: 'error', title: error.message }); } finally { button.disabled = false; } }; };
    if (section === 'summary') {
      const date = new Date(data.user.createdAt);
      const formattedDate = Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: state.config.site.timeZone }).format(date);
      const roleColor = /^#[0-9a-f]{6}$/i.test(data.user.roleColor || '') ? data.user.roleColor : '#64748b';
      root.innerHTML = `<div class="dashboard-metrics"><section class="dashboard-metric"><span>${t('Nombre de usuario', 'Username')}</span><strong>${esc(data.user.username)}</strong></section><section class="dashboard-metric"><span>${t('Rol', 'Role')}</span><span class="profile-role">${esc(data.user.roleName)}</span></section><section class="dashboard-metric"><span>${t('Fecha de registro', 'Registration date')}</span><strong>${esc(formattedDate)}</strong></section></div><section class="admin-section"><h2><i class="fa-solid fa-user" aria-hidden="true"></i> ${t('Información de la cuenta', 'Account information')}</h2><dl class="profile-account-details"><div><dt>${t('Correo electrónico', 'Email address')}</dt><dd>${esc(data.user.email)}</dd></div><div><dt>${t('Autenticación', 'Authentication')}</dt><dd>${data.user.twoFactorEnabled ? t('2FA activado', '2FA enabled') : t('2FA desactivado', '2FA disabled')}</dd></div></dl></section>`;
      const roleBadge = $('.profile-role', root);
      roleBadge.classList.add('role-badge');
      roleBadge.style.setProperty('--role-color', roleColor);
    }
    if (section === 'notifications') {
      root.innerHTML = `<form id="notificationPreferences"><section class="admin-section profile-connection-row"><div><h2>${t('Notificaciones de inicio de sesión', 'Sign-in notifications')}</h2><p>${t('Recibe un correo cuando se inicie sesión en tu cuenta.', 'Receive an email when someone signs in to your account.')}</p></div><label><input type="checkbox" role="switch" name="loginNotifications" ${data.profile.loginNotifications ? 'checked' : ''}><span>${t('Activar', 'Enable')}</span></label></section><button type="submit" class="primary-button">${t('Guardar cambios', 'Save changes')}</button></form>`;
      submit($('#notificationPreferences'), async values => { await api('/api/profile/notifications', { method: 'PUT', body: JSON.stringify({ loginNotifications: values.has('loginNotifications') }) }); success(); });
    }
    if (section === 'connections') {
      root.innerHTML = data.connections.map(connection => `<section class="admin-section profile-connection-row"><div><h2><i class="${icons[connection.provider]}" aria-hidden="true"></i> ${esc(connection.name)}</h2><p>${connection.linked ? `${t('Sesión iniciada como:', 'Signed in as:')} ${esc(connection.linked.displayName)}` : t('Conexión no configurada', 'Connection not configured')}</p></div><button type="button" class="${connection.linked ? 'danger-button' : 'success-button primary-button'}" data-profile-provider="${connection.provider}" data-linked="${Boolean(connection.linked)}">${connection.linked ? t('Desvincular', 'Unlink') : t('Vincular', 'Link')}</button></section>`).join('') || `<section class="admin-section"><p>${t('No hay proveedores configurados por el administrador.', 'Your administrator has not configured any providers.')}</p></section>`;
      root.querySelectorAll('[data-profile-provider]').forEach(button => { button.onclick = async () => {
        const unlink = button.dataset.linked === 'true';
        const response = await passwordPrompt(unlink ? t('Desvincular conexión', 'Unlink connection') : t('Vincular conexión', 'Link connection'));
        if (!response.isConfirmed) return;
        try {
          const result = await api(`/api/profile/connections/${button.dataset.profileProvider}${unlink ? '' : '/start'}`, { method: unlink ? 'DELETE' : 'POST', body: JSON.stringify({ password: response.value }) });
          if (unlink) await profile(section, deps); else location.assign(result.url);
        } catch (error) { notify({ icon: 'error', title: error.message }); }
      }; });
    }
    if (section === 'settings') {
      root.innerHTML = `<form id="profileSettings" class="admin-section"><h2><i class="fa-solid fa-user-gear"></i> ${t('Ajustes generales', 'General settings')}</h2><label class="field">${t('Avatar (JPEG o PNG, máximo 2 MB)', 'Avatar (JPEG or PNG, up to 2 MB)')}<input type="file" name="avatar" accept="image/jpeg,image/png"></label>${data.profile.avatar ? `<img class="profile-avatar" src="${esc(data.profile.avatar)}" alt="">` : ''}${field(t('Nombre de usuario', 'Username'), 'username', 'text', data.user.username)}${field(t('Nombre completo', 'Full name'), 'fullName', 'text', data.profile.fullName)}<label class="field">${t('Idioma preferido', 'Preferred language')}<select name="preferredLanguage" class="settings-input">${state.config.languages.map(language => `<option value="${esc(language)}" ${language === data.profile.preferredLanguage ? 'selected' : ''}>${esc(language)}</option>`).join('')}</select></label><button type="submit" class="primary-button">${t('Guardar cambios', 'Save changes')}</button></form><form id="profileEmail" class="admin-section"><h2><i class="fa-solid fa-envelope"></i> ${t('Cambiar correo', 'Change email')}</h2>${field(t('Correo electrónico', 'Email address'), 'email', 'email', data.user.email)}${field(t('Contraseña actual', 'Current password'), 'password', 'password')}<p>${t('Debes confirmar el nuevo correo antes de aplicar el cambio.', 'Confirm the new email address before the change is applied.')}</p><button type="submit" class="primary-button">${t('Cambiar correo', 'Change email')}</button></form>`;
      submit($('#profileSettings'), async values => {
        const avatar = values.get('avatar');
        if (avatar?.size) { if (avatar.size > 2097152 || !['image/jpeg', 'image/png'].includes(avatar.type)) throw new Error(t('Selecciona un JPEG o PNG de hasta 2 MB.', 'Choose a JPEG or PNG up to 2 MB.')); const form = new FormData(); form.append('avatar', avatar); const result = await api('/api/profile/avatar', { method: 'POST', body: form }); data.profile.avatar = result.avatar; state.user.avatar = result.avatar; renderProfileIdentity(result.avatar, state.user.username); }
        await api('/api/profile', { method: 'PUT', body: JSON.stringify({ username: values.get('username'), fullName: values.get('fullName'), preferredLanguage: values.get('preferredLanguage') }) });
        const languageChanged = state.lang !== values.get('preferredLanguage');
        state.user.username = values.get('username'); state.lang = values.get('preferredLanguage'); localStorage.setItem('wiki-language', state.lang); setAuthLink();
        renderProfileIdentity(data.profile.avatar || data.user.avatar, state.user.username);
        await success();
        if (languageChanged) location.reload();
      });
      submit($('#profileEmail'), async values => { await api('/api/profile/email', { method: 'POST', body: JSON.stringify({ email: values.get('email'), password: values.get('password') }) }); $('#profileEmail [name=password]').value = ''; notify({ icon: 'success', title: t('Revisa el nuevo correo para confirmar.', 'Check your new email to confirm.') }); });
      const emailToken = new URLSearchParams(location.search).get('email-token');
      if (emailToken) {
        history.replaceState({}, '', '/profile/settings');
        const response = await Swal.fire({ title: t('¿Confirmar nuevo correo?', 'Confirm new email address?'), text: t('Se cerrarán las sesiones de tu cuenta.', 'Your account sessions will be signed out.'), showCancelButton: true });
        if (response.isConfirmed) { await api('/api/profile/email/confirm', { method: 'POST', body: JSON.stringify({ token: emailToken }) }); location.href = '/login'; }
      }
    }
    if (section === 'security') {
      root.innerHTML = `<form class="admin-section" id="profilePassword"><h2><i class="fa-solid fa-key"></i> ${t('Cambiar contraseña', 'Change password')}</h2>${field(t('Contraseña actual', 'Current password'), 'currentPassword', 'password')}${field(t('Nueva contraseña', 'New password'), 'password', 'password')}${field(t('Confirmar nueva contraseña', 'Confirm new password'), 'confirm', 'password')}${state.config.captcha?.enabled ? '<div class="captcha-wrap"><div class="captcha-slot"></div><div class="captcha-status" role="alert" hidden></div></div>' : ''}<button type="submit" class="primary-button">${t('Guardar cambios', 'Save changes')}</button></form><section class="admin-section"><h2><i class="fa-solid fa-shield"></i> ${t('Autenticación de dos factores', 'Two-factor authentication')}</h2><p class="profile-security-alert ${data.user.twoFactorEnabled ? 'enabled' : ''}">${data.user.twoFactorEnabled ? t('La autenticación de dos factores está habilitada en tu cuenta.', 'Two-factor authentication is enabled on your account.') : t('La autenticación de dos factores no está habilitada en tu cuenta.', 'Two-factor authentication is not enabled on your account.')}</p><div class="profile-actions">${data.user.twoFactorEnabled ? `<button class="danger-button" id="profileDisable2fa">${t('Deshabilitar autenticación de dos factores', 'Disable two-factor authentication')}</button><button class="secondary-button" id="profileRecovery">${t('Códigos de respaldo', 'Recovery codes')}</button>` : `<button class="primary-button success-button" id="profileEnable2fa">${t('Habilitar autenticación de dos factores', 'Enable two-factor authentication')}</button>`}</div></section>`;
      $('#profilePassword [name=password]').autocomplete = 'new-password'; $('#profilePassword [name=confirm]').autocomplete = 'new-password';
      const captcha = createCaptchaController($('#profilePassword'), 'change');
      submit($('#profilePassword'), async values => {
        const checks = checkPassword(values.get('password'), values.get('confirm'));
        if (Object.values(checks).some(value => !value)) throw new Error(t('Revisa los requisitos y la confirmación de contraseña.', 'Check the password requirements and confirmation.'));
        try { const captchaToken = state.config.captcha?.enabled ? await captcha.token() : ''; const response = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: values.get('currentPassword'), password: values.get('password'), captchaToken }) }); state.csrf = response.csrfToken || state.csrf; $('#profilePassword').reset(); success(); } finally { captcha.reset(); }
      });
      const showCodes = codes => Swal.fire({ title: t('Códigos de respaldo', 'Recovery codes'), html: `<p>${t('Guárdalos ahora. Solo se muestran una vez. Los códigos anteriores dejan de funcionar.', 'Save them now. They are shown only once. Previous codes no longer work.')}</p><ul class="two-factor-codes">${codes.map(code => `<li><code>${esc(code)}</code></li>`).join('')}</ul>` });
      if (data.user.twoFactorEnabled) {
        $('#profileDisable2fa').onclick = async () => { const response = await passwordPrompt(t('¿Deshabilitar 2FA?', 'Disable 2FA?')); if (!response.isConfirmed) return; try { await api('/api/auth/two-factor/disable', { method: 'POST', body: JSON.stringify({ password: response.value }) }); state.user.twoFactorEnabled = false; await profile(section, deps); } catch (error) { notify({ icon: 'error', title: error.message }); } };
        $('#profileRecovery').onclick = async () => { const response = await passwordPrompt(t('Generar nuevos códigos', 'Generate new recovery codes'), t('Se invalidarán los códigos anteriores.', 'Previous codes will be invalidated.')); if (!response.isConfirmed) return; try { const result = await api('/api/auth/two-factor/recovery', { method: 'POST', body: JSON.stringify({ password: response.value }) }); await showCodes(result.codes); } catch (error) { notify({ icon: 'error', title: error.message }); } };
      } else $('#profileEnable2fa').onclick = async () => {
        try {
          const setup = await api('/api/auth/two-factor/setup', { method: 'POST', body: '{}' });
          const response = await Swal.fire({ title: t('Habilitar 2FA', 'Enable 2FA'), html: `<img class="two-factor-qr" src="${esc(setup.qr)}" alt="${t('Código QR para autenticador', 'Authenticator QR code')}"><p class="two-factor-secret">${esc(setup.secret)}</p><label>${t('Código de autenticación', 'Authentication code')}<input id="profileTotp" class="swal2-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>`, showCancelButton: true, confirmButtonText: t('Habilitar', 'Enable'), cancelButtonText: t('Cancelar', 'Cancel'), preConfirm: async () => { try { return await api('/api/auth/two-factor/activate', { method: 'POST', body: JSON.stringify({ code: $('#profileTotp', Swal.getPopup()).value }) }); } catch (error) { Swal.showValidationMessage(esc(error.message)); return false; } } });
          if (response.isConfirmed) { state.user.twoFactorEnabled = true; await showCodes(response.value.codes); await profile(section, deps); }
        } catch (error) { notify({ icon: 'error', title: error.message }); }
      };
    }
    if (new URLSearchParams(location.search).get('notice') === 'oauth-failed') notify({ icon: 'error', title: t('No se pudo vincular la conexión. Vuelve a intentarlo.', 'Could not link the connection. Try again.') });
  }
  window.TxWikiProfile = { profile, adminConnections };
})();
