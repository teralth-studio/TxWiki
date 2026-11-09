const $ = (selector, root = document) => root.querySelector(selector);
document.addEventListener('click', async (event) => {
  const copy = event.target.closest('.code-copy-button');
  if (copy && !$('#pageEditor')?.contains(copy)) {
    event.preventDefault();
    const code = copy.closest('.code-block')?.querySelector('pre code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(codeBlockText(code));
      copy.classList.add('copied');
      setTimeout(() => copy.classList.remove('copied'), 1100);
    } catch {}
  }
});
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  translations: {},
  config: null,
  user: null,
  csrf: '',
  pages: [],
  categories: [],
  page: null,
  homePageSlug: null,
  lang: localStorage.getItem('wiki-language') || 'en',
  space: 'main',
  adminTab: 'pages',
  editPage: null,
  returnTo: '/',
  dirty: false,
};
let loadingDepth = 0,
  browserTitle = 'Teralth Wiki',
  pageRequestSequence = 0,
  searchDebounceTimer = 0,
  searchMatches = [],
  searchSelection = -1;
let sweetAlertLoadPromise = null;
const lazySweetAlert = {
  fire(...args) {
    if (!sweetAlertLoadPromise) {
      sweetAlertLoadPromise = new Promise((resolve, reject) => {
        const stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = '/vendor/sweetalert/sweetalert2.min.css';
        let cssReady;
        const cssLoaded = new Promise((resolve) => {
          cssReady = resolve;
        });
        stylesheet.onload = cssReady;
        stylesheet.onerror = cssReady;
        document.head.append(stylesheet);
        const script = document.createElement('script');
        script.src = '/vendor/sweetalert/sweetalert2.all.min.js';
        script.async = true;
        script.onload = () =>
          cssLoaded.then(() =>
            window.Swal !== lazySweetAlert
              ? resolve(window.Swal)
              : reject(new Error('SweetAlert did not initialize.')),
          );
        script.onerror = () => reject(new Error('SweetAlert could not be loaded.'));
        document.head.append(script);
      });
    }
    return sweetAlertLoadPromise.then((library) => library.fire(...args));
  },
};
window.Swal = lazySweetAlert;
function showLoading() {
  if (loadingDepth === 0 && document.title !== 'Loading...') browserTitle = document.title;
  loadingDepth++;
  document.title = 'Loading...';
  const loader = $('#globalLoader');
  if (loader) loader.hidden = false;
}
function hideLoading() {
  loadingDepth = Math.max(0, loadingDepth - 1);
  const loader = $('#globalLoader');
  if (loadingDepth === 0) {
    if (loader) loader.hidden = true;
    document.title = browserTitle;
  }
}
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const iconClass = (value) => (/^[a-z0-9-]+$/.test(value || '') ? value : 'fa-file-lines');
function setPageIconUploadStatus(element, url) {
  element.replaceChildren();
  if (!/^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/.test(String(url || ''))) {
    element.textContent = t('No hay imagen subida', 'No image uploaded');
    return;
  }
  const image = document.createElement('img');
  image.className = 'category-image-preview';
  image.src = url;
  image.alt = '';
  const link = document.createElement('a');
  link.href = url;
  link.textContent = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  element.append(image, link);
}
const pageIconMarkup = (value, cls = '') =>
  /^\/media\/[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/.test(value || '')
    ? '<img class="page-icon-image ' + cls + '" src="' + esc(value) + '" alt="">'
    : '<i class="' +
      esc(
        /^(?:fa-(?:solid|regular|brands)\s+)?fa-[a-z0-9-]+$/.test(value || '')
          ? value.startsWith('fa-') && /^fa-(?:solid|regular|brands)\s/.test(value)
            ? value
            : 'fa-solid ' + value
          : 'fa-solid fa-file-lines',
      ) +
      ' ' +
      cls +
      '"></i>';
const spaceMarkMarkup = (space) =>
  /^\/media\/[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/.test(space?.logo || '')
    ? '<img class="space-logo-image" src="' + esc(space.logo) + '" alt="">'
    : pageIconMarkup(space?.icon || 'fa-book-open');
const t = (es, en) => {
  const english = en ?? es,
    locale = String(state.lang || 'en').toLowerCase(),
    value = String(state.translations?.[english] ?? (locale.startsWith('en') ? english : es));
  return value.replace(/[<>\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
};
function hasCookieConsent() {
  return document.cookie.split(';').some((cookie) => cookie.trim() === 'teralth_cookie_consent=accepted');
}
function renderCookieNotice() {
  const notice = $('#cookieNotice'),
    text = $('#cookieNoticeText'),
    button = $('#acceptCookies');
  if (!notice || !text || !button) return;
  notice.hidden = hasCookieConsent();
  text.textContent = t(
    'Usamos cookies necesarias para que la wiki funcione y recordar tus preferencias.',
    'We use essential cookies to make the wiki work and remember your preferences.',
  );
  button.textContent = t('Aceptar', 'Accept');
  button.onclick = () => {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = 'teralth_cookie_consent=accepted; Max-Age=31536000; Path=/; SameSite=Lax' + secure;
    notice.hidden = true;
  };
}
const tr = (key, fallback = '') => String(state.translations?.[key] ?? fallback);
const can = (permission) =>
  Boolean(
    state.user &&
    (permission !== 'smtp.configure' || state.user.isPrimaryAdmin) &&
    (state.user.isPrimaryAdmin ||
      state.user.role === 'administrator' ||
      state.user.permissions?.includes(permission)),
  );
const canAny = (permissions) => permissions.some(can);
const rolePermissionKeys = [
  'captcha.configure',
  'admin.view',
  'pages.create_edit',
  'pages.delete',
  'categories.create_edit',
  'categories.delete',
  'settings.identity',
  'settings.support',
  'settings.seo',
  'settings.sidebar_label',
  'languages.create',
  'languages.edit',
  'languages.delete',
  'spaces.create',
  'spaces.edit',
  'spaces.delete',
  'users.registration',
  'users.edit',
  'users.delete',
  'users.role',
  'users.reset_password',
  'reverse_proxy.configure',
  'roles.manage',
  'backups.import',
  'backups.export',
  'backups.schedule',
  'updates.install',
  'header_links.create_edit',
  'header_links.delete',
];
let clientErrorsSent = 0;
const reportClientError = (source, error, context = {}) => {
  try {
    if (clientErrorsSent >= 20 || !state.csrf) return;
  } catch {
    return;
  }
  clientErrorsSent++;
  const text = (value, max) => String(value ?? '').slice(0, max);
  const payload = {
    source: text(source, 60),
    message: text(error?.message ?? error, 500),
    stack: text(error?.stack, 2000),
    status: Number.isInteger(context.status) ? context.status : undefined,
    method: text(context.method, 10),
    path: text(context.path, 200),
    filename: text(context.filename, 200),
    line: Number.isInteger(context.line) ? context.line : undefined,
    column: Number.isInteger(context.column) ? context.column : undefined,
    page: text(location.pathname, 200),
  };
  fetch('/api/client-log', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
    body: JSON.stringify(payload),
  }).catch(() => {});
};
window.addEventListener('error', (event) => {
  event.preventDefault();
  showCouldNotStart(event.error || event.message, 'window.error', {
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  showCouldNotStart(event.reason, 'unhandledrejection');
});
async function getTranslations(lang) {
  const codes = [...new Set(['en', lang, ...(lang.includes('-') ? [lang.split('-')[0]] : [])])];
  const results = await Promise.all(
    codes.map(async (code) => {
      try {
        const response = await fetch('/languages/language_' + encodeURIComponent(code) + '.json', {
          cache: 'no-cache',
        });
        if (response.ok) {
          const data = await response.json();
          if (data && typeof data === 'object' && !Array.isArray(data)) return data;
        }
      } catch {}
      return {};
    }),
  );
  const base = results[0] || {},
    translated = results.slice(1).find((data) => Object.keys(data).length) || {};
  return { ...base, ...translated };
}
async function loadTranslations(lang) {
  state.translations = await getTranslations(lang);
  renderCookieNotice();
}
const pendingButtonLoads = new WeakMap();
function beginButtonLoading(button) {
  if (!button || button.tagName !== 'BUTTON') return () => {};
  let current = pendingButtonLoads.get(button);
  if (current) {
    current.count++;
    return () => endButtonLoading(button, current);
  }
  current = {
    count: 1,
    wasDisabled: button.disabled,
    ariaBusy: button.getAttribute('aria-busy'),
    icon: button.querySelector('i'),
    iconClass: button.querySelector('i')?.className || '',
    inserted: null,
  };
  if (current.wasDisabled) return () => {};
  if (current.icon) current.icon.className = 'fa-solid fa-circle-notch button-loading-spinner';
  else {
    current.inserted = document.createElement('i');
    current.inserted.className = 'fa-solid fa-circle-notch button-loading-spinner';
    current.inserted.setAttribute('aria-hidden', 'true');
    button.prepend(current.inserted);
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  pendingButtonLoads.set(button, current);
  return () => endButtonLoading(button, current);
}
function endButtonLoading(button, current) {
  if (pendingButtonLoads.get(button) !== current) return;
  if (--current.count > 0) return;
  if (current.icon?.isConnected) current.icon.className = current.iconClass;
  current.inserted?.remove();
  button.disabled = current.wasDisabled;
  if (current.ariaBusy === null) button.removeAttribute('aria-busy');
  else button.setAttribute('aria-busy', current.ariaBusy);
  pendingButtonLoads.delete(button);
}
function applySupportBackground(element, textElements, start, end) {
    if (!/^#[\da-f]{6}$/i.test(start || '') || (end && !/^#[\da-f]{6}$/i.test(end))) {
      element.style.removeProperty('background');
      textElements.forEach(item => item.style.removeProperty('color'));
      return;
    }
    element.style.background = end ? `linear-gradient(100deg, ${start}, ${end})` : start;
    const luminance = (hex) => {
      const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    };
    const levels = [luminance(start), luminance(end || start)];
    const black = Math.min(...levels.map(value => (value + 0.05) / 0.05));
    const white = Math.min(...levels.map(value => 1.05 / (value + 0.05)));
    textElements.forEach(item => { item.style.color = black > white ? '#111111' : '#ffffff'; });
}
function setSupportCardAppearance(card, title, description, button, buttonText, localized, support, translations) {
  title.textContent = localized.title || translations['support.title'] || 'Need Help?';
  description.textContent = localized.description || translations['support.description'] ||
    'Our support team is available 24/7 to help with any questions.';
  buttonText.textContent = localized.button || translations['support.contact'] || 'Contact Support';
  applySupportBackground(card, [title, description], support.background, support.backgroundEnd);
  applySupportBackground(button, [button], support.buttonBackground, support.buttonBackgroundEnd);
}
function renderSupportCard() {
  const card = $('#supportCard');
  if (!card) return;
  const support = state.config?.site?.support || {},
    localized = support.translations?.[state.lang] || support.translations?.[state.lang.split('-')[0]] || {};
  card.hidden = support.enabled === false;
  setSupportCardAppearance(card, $('#supportTitle'), $('#supportDescription'), $('#supportLink'), $('#supportLinkText'),
    localized, support, state.translations);
  const raw = String(state.config?.site?.supportUrl || '').trim();
  let target = '';
  try {
    const value = /^[a-z0-9.!#$%&'*+_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) ? 'mailto:' + raw : raw;
    const parsed = new URL(value, location.origin);
    if (['https:', 'http:', 'mailto:'].includes(parsed.protocol) && !raw.startsWith('//'))
      target = raw.startsWith('/') ? parsed.href : value;
  } catch {}
  const link = $('#supportLink');
  link.href = target || '#';
  link.target = target && !target.startsWith('mailto:') ? '_blank' : '_self';
  link.rel = 'noopener noreferrer';
  link.onclick = (event) => {
    if (!target) {
      event.preventDefault();
      notify({
        icon: 'info',
        title: tr('support.title', t('¿Necesitas Ayuda?', 'Need Help?')),
        text: tr(
          'support.notConfigured',
          t(
            'El contacto de soporte todavía no está configurado.',
            'The support contact has not been configured yet.',
          ),
        ),
      });
    }
  };
}
const pathParts = () => {
  try {
    return location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return ['__invalid_path__', 'not-found'];
  }
};
const adminTabKeys = ['pages', 'categories', 'header-links', 'settings', 'spaces', 'languages', 'users', 'roles', 'proxy', 'smtp', 'backups', 'captcha', 'updates'];
function adminUrl(tab = 'pages', space = state.space) {
  const section = adminTabKeys.includes(tab) ? tab : 'pages';
  return `/admin/${section}?space=${encodeURIComponent(space || 'main')}`;
}
function route() {
  const p = pathParts(),
    spaces = state.config?.spaces || [];
  if (!p.length) return { page: 'home', space: 'main', slug: null };
  if (p[0] === 'admin') {
    const requested = new URLSearchParams(location.search).get('space') || 'main',
      match = spaces.find((item) => item.slug.toLowerCase() === requested.toLowerCase());
    return {
      page: 'admin',
      space: match?.slug || 'main',
      slug: null,
      tab: adminTabKeys.includes(p[1]) && p.length === 2 ? p[1] : 'pages',
    };
  }
  if (['login', 'register', 'reset', 'admin', 'verify', 'change-password', 'two-factor-setup', 'two-factor'].includes(p[0]) && p.length === 1) {
    return { page: p[0], space: 'main', slug: null };
  }
  const matchedSpace = spaces.find((item) => item.slug.toLowerCase() === p[0].toLowerCase());
  if (matchedSpace)
    return { page: 'home', space: matchedSpace.slug, slug: p.length > 1 ? p.slice(1).join('/') : null };
  if (p.length > 1) return { page: 'notfound', space: 'main', slug: '__unknown_space_404__' };
  return { page: 'home', space: 'main', slug: p[0] };
}
async function api(path, options = {}) {
  const button = document.activeElement?.closest?.('button'),
    stopLoading = beginButtonLoading(button);
  try {
    const headers = {
      ...(typeof FormData !== 'undefined' && options.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      'X-Wiki-Space': state.space,
      ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}),
      ...(options.headers || {}),
    };
    const response = await request(path, { credentials: 'same-origin', ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const e = new Error(body.error || t('Ocurrió un error.', 'Something went wrong.'));
      if (typeof body.details === 'string') e.details = body.details;
      e.status = response.status;
      if (typeof body.code === 'string') e.code = body.code;
      if (response.status >= 500)
        reportClientError('api.response', e, {
          method: options.method || 'GET',
          path,
          status: response.status,
        });
      e.clientReported = true;
      throw e;
    }
    return body;
  } finally {
    stopLoading();
  }
}
function localizedMessage(message) {
  const translations = {
    'Revisa el contacto de soporte.': 'Check the support contact.',
    'Revisa el bloque de soporte.': 'Check the support card.',
    'Revisa las traducciones del bloque de soporte.': 'Check the support card translations.',
    'Hay demasiadas traducciones de soporte.': 'There are too many support translations.',
    'Revisa los colores de soporte.': 'Check the support colors.',
    'Selecciona el color inicial del degradado.': 'Select the starting color for the gradient.',
    'Revisa los ajustes de SEO.': 'Check the SEO settings.',
    'Revisa la URL canónica.': 'Check the canonical URL.',
    'La URL canónica no puede tener parámetros ni fragmentos.': 'The canonical URL cannot contain a query or fragment.',
    'Revisa la imagen para redes sociales.': 'Check the social media image.',
    'Revisa la descripción SEO.': 'Check the SEO description.',
    'Revisa el título para redes sociales.': 'Check the social media title.',
    'Revisa la descripción para redes sociales.': 'Check the social media description.',
    'Revisa el título de soporte.': 'Check the support title.',
    'Revisa la descripción de soporte.': 'Check the support description.',
    'Revisa el texto del botón.': 'Check the button text.',
    'El código no es válido o ya fue utilizado.': 'The code is invalid or has already been used.',
    'La configuración de 2FA venció. Comienza de nuevo.': '2FA setup expired. Start again.',
    'La sesión de 2FA venció. Inicia sesión de nuevo.': 'The 2FA session expired. Sign in again.',
    '2FA ya está activado.': '2FA is already enabled.',
    '2FA no está activado.': '2FA is not enabled.',
    '2FA ya está activado o la cuenta no está disponible.': '2FA is already enabled or the account is unavailable.',
    'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.': 'Too many attempts. Wait 15 minutes and try again.',
    'Primero debes verificar tu código 2FA.': 'Verify your 2FA code first.',
    'La contraseña actual no es correcta.': 'The current password is incorrect.',
    'Completa la verificación CAPTCHA e inténtalo de nuevo.':
      'Complete the CAPTCHA verification and try again.',
    'Usa 8 caracteres o más con mayúscula, minúscula, número y símbolo.':
      'Use at least 8 characters with uppercase, lowercase, number, and symbol.',
    'La contraseña temporal venció. Se restauró la anterior; inicia sesión de nuevo.':
      'The temporary password expired. Your previous password was restored; sign in again.',
    'La contraseña temporal venció. Solicita una nueva.':
      'The temporary password expired. Request a new one.',
    'Cambia tu contraseña para continuar.': 'Change your password to continue.',
    'No se pudo iniciar sesión. Comprueba tus datos y que tu correo esté confirmado.':
      'Sign in failed. Check your details and confirm your email address.',
    'Origen no permitido.': 'Request origin not allowed.',
    'Inicia sesión para continuar.': 'Sign in to continue.',
    'No encontramos esa página.': 'We could not find that page.',
    'Completa los nombres de categoría en todos los idiomas.':
      'Enter the category name in every active language.',
    'La categoría principal no pertenece a esta wiki.':
      'Choose a parent category from this documentation space.',
    'El ícono debe ser una clase Font Awesome válida o una imagen que se haya subido al servidor.':
      'Choose a valid Font Awesome icon or upload a category image.',
    'El enlace venció o ya fue utilizado. Solicita otro.':
      'That link expired or was already used. Request another one.',
    'El enlace venció o no es válido.': 'That link expired or is invalid.',
    'La sesión expiró. Actualiza la página e inténtalo de nuevo.':
      'Your session expired. Refresh the page and try again.',
    'El registro estará disponible cuando se configure el servidor SMTP.':
      'Registration will be available after SMTP is configured.',
    'Introduce la contraseña SMTP al cambiar el servidor, puerto, seguridad o usuario.':
      'Enter the SMTP password when changing the server, port, security, or username.',
    'Si los datos son válidos, recibirás un correo para confirmar tu cuenta.':
      'If the details are valid, you will receive an email to confirm your account.',
    'Si el correo y el nombre de usuario coinciden, recibirás un enlace para restablecer tu contraseña.':
      'If the email and username match, you will receive a password reset link.',
    'Completa el título y contenido en todos los idiomas activos.':
      'Add a title and content for every active language.',
    'Completa al menos un título en un idioma activo.': 'Add a title in at least one language.',
    'Agrega contenido en al menos un idioma activo.': 'Add content in at least one language.',
    'Si el correo y el nombre de usuario coinciden, recibirás una contraseña temporal.':
      'If the email and username match, you will receive a temporary password.',
    'La URL debe usar http://, https:// o una ruta local válida.':
      'Use an http:// or https:// URL, or a local path.',
    'Los registros públicos están deshabilitados.': 'Public registration is disabled.',
    'Ingresa una URL de redirección válida.': 'Enter a valid redirect URL.',
    'Selecciona un modo de proxy válido.': 'Select a valid proxy mode.',
    'Selecciona una zona horaria disponible.': 'Select an available time zone.',
    'El número de proxies debe estar entre 1 y 10.': 'The number of proxies must be between 1 and 10.',
    'Revisa las direcciones de proxy.': 'Check the proxy addresses.',
    'Añade entre 1 y 50 IP o subredes concretas; no se permite confiar en cualquier dirección.':
      'Add 1 to 50 specific IP addresses or subnets; trusting any address is not allowed.',
    'Una IP o subred no es válida.': 'An IP address or subnet is invalid.',
    'La dirección upstream no es válida.': 'The upstream address is invalid.',
    'Usa una URL upstream HTTP(S) sin ruta ni credenciales, por ejemplo http://127.0.0.1:3000.':
      'Use an HTTP(S) upstream URL without a path or credentials, for example http://127.0.0.1:3000.',
    'Selecciona una página del espacio actual.': 'Select a page from the current space.',
    'Este idioma no se puede editar.': 'This language cannot be edited.',
    'El archivo de idioma tiene un formato no válido.': 'The language file has an invalid format.',
    'No existe el archivo JSON de este idioma.': 'The JSON file for this language does not exist.',
    'Las traducciones enviadas tienen un formato no válido.':
      'The submitted translations have an invalid format.',
    'Las claves de traducción no coinciden con el archivo de idioma.':
      'The translation keys do not match the language file.',
    'Cada traducción debe ser texto y no superar 12 000 caracteres.':
      'Each translation must be text and cannot exceed 12,000 characters.',
    'Agrega entre 2 y 50 roles.': 'Add between 2 and 50 roles.',
    'Un rol enviado no es válido.': 'A submitted role is invalid.',
    'Los roles base no se pueden quitar.': 'The built-in roles cannot be removed.',
    'Revisa el nombre, color y permisos de cada rol.': 'Check each role name, color, and permissions.',
    'Los nombres de los roles deben ser únicos.': 'Role names must be unique.',
    'No puedes conceder permisos que no tienes.': 'You cannot grant permissions you do not have.',
    'Ese rol predeterminado no se puede modificar.': 'That built-in role cannot be changed.',
    'Reasigna los usuarios de ese rol antes de eliminarlo.':
      'Reassign the users in this role before deleting it.',
    'Every role needs a name.': 'Every role needs a name.',
    'El archivo no puede pesar más de 5 MB.': 'The file must be 5 MB or smaller.',
    'Sube un archivo por vez.': 'Upload one file at a time.',
    'El campo de archivo no es válido. Selecciona la imagen otra vez.':
      'The file field is invalid. Select the image again.',
    'No se pudo procesar el archivo. Comprueba que sea una imagen válida.':
      'The file could not be processed. Check that it is a valid image.',
    'Selecciona un archivo de imagen.': 'Select an image file.',
    'El archivo está dañado o no contiene una imagen compatible. Usa PNG, JPG, GIF o WebP.':
      'The file is damaged or is not a supported image. Use PNG, JPG, GIF, or WebP.',
    'Formato no compatible. Usa una imagen PNG, JPG, GIF o WebP.':
      'Unsupported format. Use a PNG, JPG, GIF, or WebP image.',
    'La imagen supera el máximo de 16 megapíxeles.': 'The image exceeds the 16-megapixel limit.',
    'No se pudo convertir esta imagen. Prueba con otro archivo PNG, JPG, GIF o WebP.':
      'This image could not be converted. Try another PNG, JPG, GIF, or WebP file.',
    'El servidor no tiene espacio disponible para guardar la imagen.':
      'The server does not have enough storage space to save this image.',
    'El servidor no tiene permiso para guardar archivos en la carpeta de imágenes.':
      'The server cannot write files to the image folder.',
    'El servidor no tiene permisos de escritura en la carpeta images del proyecto.':
      'The server cannot write to the project images folder.',
    'El almacenamiento del servidor está lleno; no se pudo guardar la imagen.':
      'The server storage is full and could not save the image.',
    'El servidor devolvió una respuesta no válida al subir la imagen.':
      'The server returned an invalid response while uploading the image.',
    'The server returned an invalid response while uploading the image.':
      'The server returned an invalid response while uploading the image.',
  };
  const locale = String(state.lang || 'en').toLowerCase();
  const imageSizeLimit = message.match(/^El archivo no puede pesar más de (\d+) MB\.$/);
  if (imageSizeLimit) {
    if (locale.startsWith('es')) return message;
    const template = 'The file must be {limit} MB or smaller.';
    const translated = locale.startsWith('en') ? template : state.translations?.[template] || template;
    return translated.replace('{limit}', imageSizeLimit[1]);
  }
  const uploadStatus = message.match(
    /^No se pudo subir la imagen\. Código HTTP: (\d+)\.$|^Image upload failed \(HTTP (\d+)\)\.$/,
  );
  if (uploadStatus) {
    const status = Number(uploadStatus[1] || uploadStatus[2]);
    const es =
      status === 413
        ? 'La carga superó el límite de tamaño del servidor o del proxy (HTTP 413).'
        : status === 415
          ? 'El servidor rechazó el formato de la imagen (HTTP 415). Usa PNG, JPG, GIF o WebP.'
          : status === 401
            ? 'La sesión venció. Inicia sesión de nuevo para subir archivos.'
            : status === 403
              ? 'Tu cuenta no tiene permiso para subir archivos.'
              : status === 429
                ? 'Se alcanzó el límite de cargas. Espera un momento e inténtalo otra vez.'
                : status >= 500
                  ? 'El servidor falló al procesar o guardar la imagen (HTTP ' +
                    status +
                    '). Revisa el registro del servidor.'
                  : 'El servidor rechazó la carga (HTTP ' + status + ').';
    const en =
      status === 413
        ? 'The upload exceeds the server or proxy size limit (HTTP 413).'
        : status === 415
          ? 'The server rejected this image format (HTTP 415). Use PNG, JPG, GIF, or WebP.'
          : status === 401
            ? 'Your session expired. Sign in again to upload files.'
            : status === 403
              ? 'Your account does not have permission to upload files.'
              : status === 429
                ? 'The upload rate limit was reached. Wait a moment and try again.'
                : status >= 500
                  ? 'The server failed to process or save the image (HTTP ' +
                    status +
                    '). Check the server log.'
                  : 'The server rejected the upload (HTTP ' + status + ').';
    return locale.startsWith('es') ? es : en;
  }
  const uploadInternal = message.match(
    /^El servidor no pudo completar la carga de la imagen por un error interno \(([^)]+)\)\. Revisa la consola del servidor\.$/,
  );
  if (uploadInternal)
    return locale.startsWith('es')
      ? message
      : 'The server could not complete the image upload due to an internal error (' +
          uploadInternal[1] +
          '). Check the server console.';
  const uploadIo = message.match(
    /^El servidor tuvo un problema de disco o de recursos al guardar la imagen \(([^)]+)\)\.$/,
  );
  if (uploadIo)
    return locale.startsWith('es')
      ? message
      : 'The server had a disk or resource error while saving the image (' + uploadIo[1] + ').';
  if (locale.startsWith('es')) return message;
  const english =
    translations[message] || 'The request could not be completed. Check the information and try again.';
  return locale.startsWith('en') ? english : state.translations?.[english] || message;
}
function showCouldNotStart(error, source = 'handled', context = {}) {
  if (!(error && typeof error === 'object' && error.clientReported))
    reportClientError(source, error, context);
  if (document.getElementById('fatalBox')) return;
  const rawCode = String(error?.code || (error?.name && error.name !== 'Error' ? error.name : 'CLIENT_ERROR')),
    code = rawCode.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60) || 'CLIENT_ERROR';
  const overlay = document.createElement('div');
  overlay.id = 'fatalBox';
  overlay.className = 'fatal-box';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  const card = document.createElement('div');
  card.className = 'fatal-box-card';
  const title = document.createElement('h1');
  title.textContent = `[${code}] ${t('Ocurrió un error.', 'An error ocurred')}`;
  const text = document.createElement('p');
  text.textContent = t(
    'Si administras el servidor, revisa la consola.',
    'If you are the server administrator, please check the console',
  );
  card.append(title, text);
  overlay.append(card);
  document.body.append(overlay);
}
function isUserError(error) {
  return Boolean(error) && Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
}
function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.localized = true;
  return error;
}
function responseError(response, message) {
  const error = new Error(message);
  error.status = response.status;
  return error;
}
async function request(path, options) {
  try {
    return await fetch(path, options);
  } catch (error) {
    if (error?.name !== 'TypeError') throw error;
    throw validationError(
      t('No se pudo conectar. Comprueba tu conexión e inténtalo de nuevo.',
        'Could not connect. Check your connection and try again.'),
    );
  }
}
async function imageUploadResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (error.name !== 'SyntaxError') throw error;
  }
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error.trim()
      ? data.error
      : `Image upload failed (HTTP ${response.status}).`;
    const error = responseError(response, message);
    if (typeof data?.code === 'string') error.code = data.code;
    throw error;
  }
  if (!data || typeof data.url !== 'string' ||
      !/^\/media\/[A-Za-z0-9_-]{16}\.webp$/.test(data.url) ||
      (data.alt !== undefined && typeof data.alt !== 'string')) {
    const error = new Error('Invalid image upload response.');
    error.code = 'IMAGE_UPLOAD_RESPONSE_INVALID';
    throw error;
  }
  return data;
}
function userErrorText(error) {
  const detail = typeof error?.details === 'string' ? error.details.trim() : '';
  const message = error.message || String(error);
  return (error.localized ? message : localizedMessage(message)) + (detail ? ' — ' + detail : '');
}
let lastFormAction = null;
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button) lastFormAction = button;
}, true);
document.addEventListener('submit', (event) => {
  lastFormAction = event.submitter || event.target.querySelector('button[type=submit]');
}, true);
function showError(target, error) {
  if (!isUserError(error)) {
    showCouldNotStart(error, 'handled', { path: target?.id || target?.className || 'unknown' });
    return;
  }
  const message = userErrorText(error);
  let box = target?.tagName === 'FORM' ? $('.form-message', target) : null;
  if (!box && target !== document && lastFormAction?.isConnected && target.contains(lastFormAction)) {
    box = lastFormAction.previousElementSibling;
    if (!box?.classList.contains('form-message')) {
      box = document.createElement('div');
      box.className = 'form-message auth-error';
      box.setAttribute('role', 'alert');
      lastFormAction.before(box);
    }
  }
  if (!box) box = $('.form-message', target) || $('.admin-message', target);
  if (box) {
    box.setAttribute('role', 'alert');
    box.textContent = message;
    box.hidden = false;
    return;
  }
  if (window.Swal)
    notify({ icon: 'error', title: t('No se pudo completar', 'Could not complete'), text: message });
}
async function confirmUnsaved() {
  if (!state.dirty) return true;
  const result = await Swal.fire({
    icon: 'warning',
    title: t('Hay cambios sin guardar', 'Unsaved changes'),
    text: t('¿Quieres continuar y descartar los cambios?', 'Continue and discard these changes?'),
    showCancelButton: true,
    confirmButtonText: t('Descartar cambios', 'Discard changes'),
    cancelButtonText: t('Seguir editando', 'Keep editing'),
    reverseButtons: true,
  });
  if (result.isConfirmed) state.dirty = false;
  return result.isConfirmed;
}
function notify(options) {
  const icons = {
    success: '<i class="fa-regular fa-circle-check" aria-hidden="true"></i>',
    error: '<i class="fa-regular fa-circle-xmark" aria-hidden="true"></i>',
  };
  const iconHtml = icons[options.icon];
  const popup = [options.customClass?.popup, 'wiki-toast', iconHtml ? `wiki-toast-${options.icon}` : ''].filter(Boolean).join(' ');
  return Swal.fire({
    ...options,
    ...(iconHtml ? { iconHtml } : {}),
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: options.timer ?? 2600,
    timerProgressBar: true,
    width: 'min(420px, calc(100vw - 24px))',
    customClass: { ...(options.customClass || {}), popup },
  });
}
function setNotice(text, kind = 'success') {
  if (kind === 'error') {
    if (window.Swal) return notify({ icon: 'error', title: text });
    const notice = $('#notice');
    notice.textContent = text;
    notice.className = 'notice error';
    notice.hidden = false;
    return;
  }
  if (window.Swal) notify({ icon: 'success', title: text });
  else {
    const notice = $('#notice');
    notice.textContent = text;
    notice.className = `notice ${kind}`;
    notice.hidden = false;
    setTimeout(() => {
      notice.hidden = true;
    }, 6000);
  }
}
function setAuthLink() {
  const link = $('#accountLink'),
    menu = $('#userMenu');
  if (state.user) {
    link.innerHTML =
      '<i class="fa-solid fa-user"></i><span>' +
      esc(state.user.username) +
      '</span><i class="fa-solid fa-ellipsis menu-caret"></i>';
    link.classList.add('signed-in');
    link.setAttribute('aria-expanded', 'false');
    link.onclick = (e) => {
      e.preventDefault();
      const open = menu.classList.toggle('open');
      link.setAttribute('aria-expanded', String(open));
    };
    menu.innerHTML =
      (can('admin.view')
        ? '<button data-user-action="admin"><i class="fa-solid fa-gear"></i> ' +
          t('Administración', 'Administration') +
          '</button>'
        : '') +
      '<button data-user-action="password"><i class="fa-solid fa-key"></i> ' +
      t('Cambiar contraseña', 'Change password') +
      '</button><button data-user-action="two-factor"><i class="fa-solid fa-shield-halved"></i> ' +
      (state.user.twoFactorEnabled ? t('Desactivar 2FA', 'Disable 2FA') : t('Activar 2FA', 'Enable 2FA')) +
      '</button><button class="user-menu-logout" data-user-action="logout"><i class="fa-solid fa-arrow-right-from-bracket"></i> ' +
      t('Cerrar sesión', 'Sign out') +
      '</button>';
    menu.classList.add('has-user');
  } else {
    link.innerHTML =
      '<i class="fa-solid fa-arrow-right-to-bracket"></i><span>' + t('Iniciar sesión', 'Sign in') + '</span>';
    link.classList.remove('signed-in');
    link.setAttribute('aria-expanded', 'false');
    link.onclick = () => {
      const current = location.pathname + location.search;
      const next = ['/login', '/register', '/reset'].includes(location.pathname) ? '/' : current;
      location.href = '/login?next=' + encodeURIComponent(next);
    };
    menu.classList.remove('open', 'has-user');
  }
  $$('[data-user-action]', menu).forEach(
    (button) =>
      (button.onclick = () => {
        if (button.dataset.userAction === 'admin') {
          if (state.dirty) return confirmUnsaved().then((confirmed) => confirmed && (location.href = adminUrl('pages')));
          location.href = adminUrl('pages');
          return;
        }
        if (button.dataset.userAction === 'logout') return logout();
        if (button.dataset.userAction === 'two-factor') return state.user.twoFactorEnabled ? disableTwoFactor() : (location.href = '/two-factor-setup');
        return changePassword();
      }),
  );
}
function twoFactorBrand() {
  return `<div class="auth-brand"><span class="brand-mark"><i class="fa-solid fa-shield-halved"></i></span><strong>${esc(state.config.site.name)}</strong></div>`;
}
async function twoFactorSetup() {
  setView('authPanel');
  const panel = $('#authPanel');
  panel.innerHTML = `${twoFactorBrand()}<h1>${t('Activar 2FA', 'Enable 2FA')}</h1><p>${t('Preparando la configuración...', 'Preparing setup...')}</p>`;
  try {
    const setup = await api('/api/auth/two-factor/setup', { method: 'POST', body: '{}' });
    panel.innerHTML = `${twoFactorBrand()}<h1>${t('Activar 2FA', 'Enable 2FA')}</h1><p>${t('Escanea el código con tu aplicación de autenticación o introduce la clave manualmente.', 'Scan the code with your authenticator app or enter the key manually.')}</p><div class="two-factor-qr"><img src="${esc(setup.qr)}" width="240" height="240" alt="${t('Código QR de 2FA', '2FA QR code')}"><span>${t('Clave manual', 'Manual key')}</span><code>${esc(setup.secret)}</code></div><form id="twoFactorForm"><div class="field"><label for="twoFactorCode">${t('Ingresa el código de tu aplicación', 'Enter the code from your app')}</label><input id="twoFactorCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div><div class="form-message auth-error" hidden></div><button type="submit" class="primary-button">${t('Activar 2FA', 'Enable 2FA')}</button><button type="button" class="secondary-button auth-cancel">${t('Cancelar', 'Cancel')}</button></form>`;
    const form = $('#twoFactorForm', panel);
    $('.auth-cancel', form).onclick = () => { location.href = '/'; };
    form.onsubmit = async event => {
      event.preventDefault();
      $('.form-message', form).hidden = true;
      try {
        const code = $('#twoFactorCode', form).value.trim();
        if (!code) throw validationError(t('Completa todos los campos.', 'Complete all fields.'));
        const result = await api('/api/auth/two-factor/activate', { method: 'POST', body: JSON.stringify({ code }) });
        state.user.twoFactorEnabled = true;
        twoFactorRecoveryCodes(result.codes);
      } catch (error) { showError(form, error); }
    };
  } catch (error) { showError(panel, error); }
}
function twoFactorRecoveryCodes(codes) {
  const panel = $('#authPanel');
  panel.innerHTML = `${twoFactorBrand()}<h1>${t('Códigos de respaldo', 'Recovery codes')}</h1><p>${t('Guarda estos códigos en un lugar seguro. Cada código solo puede usarse una vez y no volverá a mostrarse.', 'Save these codes somewhere safe. Each code can be used once and will not be shown again.')}</p><ul class="two-factor-codes">${codes.map(code => `<li><code>${esc(code)}</code></li>`).join('')}</ul><button type="button" class="primary-button" id="downloadRecovery">${t('Descargar códigos', 'Download codes')}</button><button type="button" class="secondary-button auth-cancel" id="acceptRecovery">${t('Aceptar', 'Accept')}</button>`;
  $('#downloadRecovery', panel).onclick = () => {
    const url = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'teralth-recovery-codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('#acceptRecovery', panel).onclick = () => { location.href = '/'; };
}
function twoFactorChallenge(recovery = false) {
  setView('authPanel');
  const panel = $('#authPanel');
  const heading = recovery ? t('Ingresa un código de respaldo', 'Enter a recovery code') : t('Ingresa el código 2FA', 'Enter your 2FA code');
  const label = recovery ? t('Ingresa tu código de respaldo', 'Enter your recovery code') : t('Ingresa el código de tu aplicación', 'Enter the code from your app');
  panel.innerHTML = `${twoFactorBrand()}<h1>${heading}</h1><form id="twoFactorForm"><div class="field"><label for="twoFactorCode">${label}</label><input id="twoFactorCode" name="code" ${recovery ? 'autocomplete="off" maxlength="39"' : 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"'} required></div><div class="form-message auth-error" hidden></div><button type="submit" class="primary-button">${t('Verificar', 'Verify')}</button><button type="button" class="secondary-button auth-cancel" id="twoFactorAlternate">${recovery ? t('Usar 2FA', 'Use 2FA') : t('Cancelar y cerrar sesión', 'Cancel and sign out')}</button></form>${recovery ? '' : `<a class="auth-link" href="#" id="useRecovery">${t('¿No tienes tu código? Usa un código de respaldo.', 'No code? Use a recovery code.')}</a>`}`;
  const form = $('#twoFactorForm', panel);
  $('#twoFactorAlternate', form).onclick = async () => {
    if (recovery) return twoFactorChallenge();
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      location.href = '/login';
    } catch (error) { showError(form, error); }
  };
  if (!recovery) $('#useRecovery', panel).onclick = event => { event.preventDefault(); twoFactorChallenge(true); };
  form.onsubmit = async event => {
    event.preventDefault();
    $('.form-message', form).hidden = true;
    try {
      const code = $('#twoFactorCode', form).value.trim();
      if (!code) throw validationError(t('Completa todos los campos.', 'Complete all fields.'));
      const result = await api('/api/auth/two-factor/verify', { method: 'POST', body: JSON.stringify({ code, recovery }) });
      state.user = result.user;
      state.csrf = result.csrfToken;
      location.href = '/';
    } catch (error) { showError(form, error); }
  };
}
async function disableTwoFactor() {
  let internalError;
  const result = await Swal.fire({
    icon: 'question',
    title: t('Desactivar 2FA', 'Disable 2FA'),
    text: t('Introduce tu contraseña para confirmar.', 'Enter your password to confirm.'),
    input: 'password',
    inputAttributes: { autocomplete: 'current-password' },
    showCancelButton: true,
    confirmButtonText: t('Desactivar 2FA', 'Disable 2FA'),
    cancelButtonText: t('Cancelar', 'Cancel'),
    preConfirm: async password => {
      if (!password) {
        Swal.showValidationMessage(t('Completa todos los campos.', 'Complete all fields.'));
        return false;
      }
      try {
        await api('/api/auth/two-factor/disable', { method: 'POST', body: JSON.stringify({ password }) });
        return true;
      } catch (error) {
        if (!isUserError(error)) { internalError = error; Swal.close(); return false; }
        Swal.showValidationMessage(userErrorText(error));
        return false;
      }
    },
  });
  if (internalError) return showCouldNotStart(internalError, 'handled', { path: 'twoFactorDisable' });
  if (result.isConfirmed) {
    state.user.twoFactorEnabled = false;
    setAuthLink();
    await notify({ icon: 'success', title: t('2FA desactivado', '2FA disabled') });
  }
}
async function logout() {
  const result = await Swal.fire({
    icon: 'question',
    title: t('¿Cerrar sesión?', 'Sign out?'),
    text: state.dirty
      ? t(
          'Tienes cambios sin guardar. Se descartarán al cerrar sesión.',
          'You have unsaved changes. They will be discarded when you sign out.',
        )
      : t('Tu sesión se cerrará en este dispositivo.', 'Your session will end on this device.'),
    showCancelButton: true,
    confirmButtonText: t('Cerrar sesión', 'Sign out'),
    cancelButtonText: t('Cancelar', 'Cancel'),
    reverseButtons: true,
  });
  if (!result.isConfirmed) return;
  state.dirty = false;
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    state.user = null;
    state.csrf = '';
    state.dirty = false;
    $('#userMenu').classList.remove('open', 'has-user');
    await notify({
      icon: 'success',
      title: t('Sesión cerrada', 'Signed out'),
      timer: 1500,
      showConfirmButton: false,
    });
    await render();
  } catch (error) {
    showError(document, error);
  }
}
async function changePassword() {
  state.returnTo = location.pathname + location.search;
  if (['/login', '/register', '/reset', '/admin', '/change-password'].includes(location.pathname))
    state.returnTo = '/';
  history.pushState({}, '', '/change-password');
  authForm('change');
}
function passwordChangeNotificationText(notificationQueued) {
  return notificationQueued
    ? ''
    : t(
        'La contraseña se guardó, pero no se pudo enviar el correo.',
        'The password was saved, but the email could not be sent.',
      );
}
const captchaScriptLoads = new Map();
function loadCaptchaScript(src) {
  if (captchaScriptLoads.has(src)) return captchaScriptLoads.get(src);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => {
      captchaScriptLoads.delete(src);
      reject(
        validationError(
          t(
            'No se pudo cargar el CAPTCHA. Revisa la conexión y la configuración.',
            'Could not load CAPTCHA. Check the connection and configuration.',
          ),
        ),
      );
    };
    document.head.append(script);
  });
  captchaScriptLoads.set(src, promise);
  return promise;
}
function createCaptchaController(form, action) {
  const config = state.config?.captcha;
  if (!config?.enabled) return { token: async () => '', reset: () => {} };
  let widgetId = null,
    tokenValue = '',
    apiObject = null;
  const slot = $('.captcha-slot', form),
    status = $('.captcha-status', form);
  if (!slot)
    return {
      token: async () => {
        throw new Error(t('No se encontró el espacio del CAPTCHA.', 'CAPTCHA container is missing.'));
      },
      reset: () => {},
    };
  const setStatus = (message) => {
    if (status) {
      status.textContent = message || '';
      status.hidden = !message;
    }
  };
  const ready = (async () => {
    try {
      const provider = config.provider,
        variant = config.variant;
      if (provider === 'recaptcha') {
        const src =
          variant === 'v3'
            ? 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(config.siteKey)
            : 'https://www.google.com/recaptcha/api.js?render=explicit';
        await loadCaptchaScript(src);
        apiObject = window.grecaptcha;
        if (!apiObject) throw new Error('CAPTCHA_API_UNAVAILABLE');
        await new Promise((resolve) => apiObject.ready(resolve));
        if (variant !== 'v3')
          widgetId = apiObject.render(slot, {
            sitekey: config.siteKey,
            size: variant === 'v2_invisible' ? 'invisible' : 'normal',
            callback: (value) => {
              tokenValue = value;
              setStatus('');
            },
            'expired-callback': () => {
              tokenValue = '';
              setStatus(
                t('La verificación venció. Inténtalo de nuevo.', 'Verification expired. Please try again.'),
              );
            },
            'error-callback': () =>
              setStatus(t('No se pudo completar la verificación.', 'Verification could not be completed.')),
          });
      } else if (provider === 'hcaptcha') {
        await loadCaptchaScript('https://js.hcaptcha.com/1/api.js?render=explicit');
        apiObject = window.hcaptcha;
        if (!apiObject) throw new Error('CAPTCHA_API_UNAVAILABLE');
        widgetId = apiObject.render(slot, {
          sitekey: config.siteKey,
          size: variant === 'invisible' ? 'invisible' : 'normal',
          callback: (value) => {
            tokenValue = value;
            setStatus('');
          },
          'expired-callback': () => {
            tokenValue = '';
            setStatus(
              t('La verificación venció. Inténtalo de nuevo.', 'Verification expired. Please try again.'),
            );
          },
          'error-callback': () =>
            setStatus(t('No se pudo completar la verificación.', 'Verification could not be completed.')),
        });
      } else if (provider === 'turnstile') {
        await loadCaptchaScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
        apiObject = window.turnstile;
        if (!apiObject) throw new Error('CAPTCHA_API_UNAVAILABLE');
        widgetId = apiObject.render(slot, {
          sitekey: config.siteKey,
          action: action,
          theme: document.body.classList.contains('light') ? 'light' : 'dark',
          callback: (value) => {
            tokenValue = value;
            setStatus('');
          },
          'expired-callback': () => {
            tokenValue = '';
            setStatus(
              t('La verificación venció. Inténtalo de nuevo.', 'Verification expired. Please try again.'),
            );
          },
          'error-callback': () =>
            setStatus(t('No se pudo completar la verificación.', 'Verification could not be completed.')),
        });
      } else throw new Error('CAPTCHA_PROVIDER_INVALID');
    } catch (error) {
      setStatus(
        t(
          'No se pudo cargar el CAPTCHA. Revisa la configuración y conexión.',
          'Could not load CAPTCHA. Check configuration and connectivity.',
        ),
      );
      return error;
    }
  })();
  const waitToken = () =>
    new Promise((resolve, reject) => {
      const started = Date.now(),
        poll = () => {
          if (tokenValue) return resolve(tokenValue);
          if (Date.now() - started > 120000)
            return reject(
              validationError(t('Completa la verificación CAPTCHA.', 'Complete the CAPTCHA verification.')),
            );
          setTimeout(poll, 150);
        };
      poll();
    });
  return {
    async token() {
      const loadError = await ready;
      if (loadError) throw loadError;
      setStatus('');
      if (config.provider === 'recaptcha' && config.variant === 'v3') {
        const value = await apiObject.execute(config.siteKey, { action: action });
        if (!value) throw new Error(t('No se pudo validar el CAPTCHA.', 'Could not verify CAPTCHA.'));
        return value;
      }
      if (
        (config.provider === 'recaptcha' && config.variant === 'v2_invisible') ||
        (config.provider === 'hcaptcha' && config.variant === 'invisible')
      ) {
        apiObject.execute(widgetId);
        return waitToken();
      }
      if (!tokenValue)
        throw validationError(t('Completa la verificación CAPTCHA.', 'Complete the CAPTCHA verification.'));
      const value = tokenValue;
      tokenValue = '';
      return value;
    },
    reset() {
      tokenValue = '';
      try {
        if (config.provider === 'recaptcha' && config.variant !== 'v3') apiObject?.reset(widgetId);
        else if (config.provider === 'hcaptcha') apiObject?.reset(widgetId);
        else if (config.provider === 'turnstile') apiObject?.reset(widgetId);
      } catch {}
    },
  };
}
function authForm(mode, resetEmail = '') {
  if (mode === 'register' && !state.config?.registrationEnabled) {
    history.replaceState({}, '', '/login');
    authForm('login');
    notify({
      icon: 'error',
      title: t('Registro no disponible', 'Registration unavailable'),
      text: t('Los registros públicos están deshabilitados.', 'Public registration is disabled.'),
    });
    return;
  }
  setView('authPanel');
  const panel = $('#authPanel');
  const labels = {
    login: [
      t('Iniciar sesión', 'Sign in'),
      t('Accede para editar la documentación.', 'Sign in to edit documentation.'),
    ],
    register: [
      t('Crear una cuenta', 'Create an account'),
      t('Confirma tu correo para activar la cuenta.', 'Confirm your email to activate the account.'),
    ],
    forgot: [
      t('Recuperar contraseña', 'Recover password'),
      t(
        'Se enviará un correo con un enlace para restablecer tu contraseña.',
        'An email with a password reset link will be sent.',
      ),
    ],
    reset: [
      t('Recuperar contraseña', 'Recover password'),
      t('Elige una contraseña segura para tu cuenta.', 'Choose a secure password for your account.'),
    ],
    change: [
      t('Cambiar contraseña', 'Change password'),
      t(
        'Confirma tu contraseña actual y elige una nueva.',
        'Confirm your current password and choose a new one.',
      ),
    ],
  };
  const [heading, subtitle] = labels[mode];
  let fields = '';
  if (mode === 'login')
    fields = `<div class="field"><label for="loginId">${t('Correo o nombre de usuario', 'Email or username')}</label><input id="loginId" name="email" autocomplete="username" required></div><div class="field"><label for="loginPass">${t('Contraseña', 'Password')}</label><input id="loginPass" name="password" type="password" autocomplete="current-password" required></div>`;
  if (mode === 'register')
    fields = `<div class="field"><label>${t('Correo electrónico', 'Email address')}</label><input name="email" type="email" autocomplete="email" required></div><div class="field"><label>${t('Nombre de usuario', 'Username')}</label><input name="username" autocomplete="username" minlength="2" maxlength="60" required></div><div class="field"><label>${t('Contraseña', 'Password')}</label><input id="regPass" name="password" type="password" autocomplete="new-password" required></div><div class="field"><label>${t('Repite la contraseña', 'Repeat password')}</label><input id="regConfirm" type="password" autocomplete="new-password" required></div>${passwordChecklist()}`;
  if (mode === 'forgot')
    fields = `<div class="field"><label>${t('Correo registrado', 'Registered email')}</label><input name="email" type="email" autocomplete="email" required></div><div class="field"><label>${t('Nombre de usuario', 'Username')}</label><input name="username" autocomplete="username" required></div>`;
  if (mode === 'reset')
    fields = `<div class="field"><label>${t('Correo de la cuenta', 'Account email')}</label><input type="email" value="${esc(resetEmail)}" disabled></div><div class="field"><label>${t('Contraseña nueva', 'New password')}</label><input id="resetPass" name="password" type="password" autocomplete="new-password" required></div><div class="field"><label>${t('Repite la contraseña', 'Repeat password')}</label><input id="resetConfirm" type="password" autocomplete="new-password" required></div>${passwordChecklist()}`;
  if (mode === 'change')
    fields = `<div class="field"><label>${t('Contraseña anterior', 'Current password')}</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label>${t('Nueva contraseña', 'New password')}</label><input id="changePass" name="password" type="password" autocomplete="new-password" required></div><div class="field"><label>${t('Repetir nueva contraseña', 'Repeat new password')}</label><input id="changeConfirm" type="password" autocomplete="new-password" required></div>${passwordChecklist()}`;
  const links =
    mode === 'login'
      ? `<a class="auth-link" href="/reset">${t('¿Olvidaste la contraseña?', 'Forgot your password?')}</a>${state.config?.registrationEnabled ? `<a class="auth-link" href="/register">${t('¿No tienes cuenta? Regístrate', 'Need an account? Register')}</a>` : ''}`
      : mode === 'register'
        ? `<a class="auth-link" href="/login">${t('¿Ya tienes cuenta? Inicia sesión.', 'Already have an account? Sign in.')}</a>`
        : mode === 'forgot' || mode === 'reset'
          ? `<a class="auth-link" href="/login">${t('Volver a iniciar sesión', 'Back to sign in')}</a>`
          : '';
  const buttonText =
    mode === 'login'
      ? t('Iniciar sesión', 'Sign in')
      : mode === 'register'
        ? t('Registrarse', 'Register')
        : mode === 'forgot'
          ? t('Enviar enlace', 'Send link')
          : mode === 'reset'
            ? t('Guardar contraseña', 'Save password')
            : t('Guardar contraseña', 'Save password');
  panel.innerHTML = `<div class="auth-brand"><span class="brand-mark"><i class="fa-solid fa-book-open"></i></span><strong>${esc(state.config.site.name)}</strong></div><h1>${heading}</h1><p>${subtitle}</p><form id="authForm">${fields}${state.config?.captcha?.enabled ? '<div class="captcha-wrap"><div class="captcha-slot"></div><div class="captcha-status" role="alert" hidden></div></div>' : ''}<div class="form-message auth-error" hidden></div><div class="auth-success form-success" hidden></div><button class="primary-button" type="submit">${buttonText}</button>${['forgot', 'reset', 'change'].includes(mode) ? `<button class="secondary-button auth-cancel" type="button">${t('Cancelar', 'Cancel')}</button>` : ''}</form>${links}`;
  const form = $('#authForm', panel),
    captcha = createCaptchaController(form, mode);
  form.noValidate = true;
  const cancel = form.querySelector('.auth-cancel');
  if (cancel) cancel.onclick = () => { location.href = mode === 'change' ? safeLocalReturn(state.returnTo || '/') : '/login'; };
  if (['register', 'reset', 'change'].includes(mode)) watchPassword(form, mode);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form),
      payload = Object.fromEntries(data.entries());
    $('.form-message', form).hidden = true;
    let captchaAttempted = false;
    try {
      validateAuthForm(form);
      if (state.config?.captcha?.enabled && mode !== 'forgot') {
        captchaAttempted = true;
        payload.captchaToken = await captcha.token();
      }
      if (mode === 'login') {
        const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
        if (result.pendingVerification) {
          state.csrf = result.csrfToken;
          verificationWall(result.pendingVerification.email);
          return;
        }
        if (result.pendingTwoFactor) {
          state.csrf = result.csrfToken;
          history.replaceState({}, '', '/two-factor');
          twoFactorChallenge();
          return;
        }
        state.user = result.user;
        state.csrf = result.csrfToken;
        setAuthLink();
        if (state.user.mustChangePassword) {
          history.replaceState({}, '', '/change-password');
          forcePassword(payload.password);
          return;
        }
        await notify({
          icon: 'success',
          title: t('Sesión iniciada', 'Signed in'),
          text: t('Acceso concedido.', 'You are now signed in.'),
          timer: 1200,
          showConfirmButton: false,
        });
        location.href = state.returnTo || '/';
      } else if (mode === 'register') {
        const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
        state.csrf = result.csrfToken;
        verificationWall(result.pendingVerification.email);
      } else if (mode === 'forgot') {
        if (state.config?.captcha?.enabled) {
          captchaAttempted = true;
          payload.captchaToken = await captcha.token();
        }
        const result = await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify(payload) });
        await notify({
          icon: 'success',
          title: t('Solicitud enviada', 'Request sent'),
          text: localizedMessage(result.message),
          confirmButtonText: t('Entendido', 'Got it'),
        });
      } else if (mode === 'reset') {
        if (payload.password !== $('#resetConfirm', form).value)
          throw validationError(t('Las contraseñas no coinciden.', 'Passwords do not match.'));
        await api('/api/auth/reset', {
          method: 'POST',
          body: JSON.stringify({
            token: new URLSearchParams(location.search).get('token'),
            password: payload.password,
            captchaToken: payload.captchaToken,
          }),
        });
        await notify({
          icon: 'success',
          title: t('Contraseña actualizada', 'Password updated'),
          confirmButtonText: t('Entendido', 'Got it'),
        });
        location.href = '/login';
      } else {
        if (payload.password !== $('#changeConfirm', form).value)
          throw validationError(t('Las contraseñas nuevas no coinciden.', 'The new passwords do not match.'));
        const result = await api('/api/auth/password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: payload.currentPassword,
            password: payload.password,
            captchaToken: payload.captchaToken,
          }),
        });
        state.user.mustChangePassword = false;
        await notify({
          icon: 'success',
          title: t('Contraseña actualizada', 'Password updated'),
          text: passwordChangeNotificationText(result.notificationQueued),
          confirmButtonText: t('Entendido', 'Got it'),
        });
        location.assign('/');
      }
    } catch (err) {
      if (captchaAttempted) captcha.reset();
      if (mode === 'login' && err.status === 401 &&
          err.message === 'No se pudo iniciar sesión. Comprueba tus datos y que tu correo esté confirmado.')
        err = validationError(t(
          'Usuario o contraseña incorrectos. Comprueba también que tu correo esté confirmado.',
          'Incorrect username or password. Also check that your email is confirmed.',
        ));
      showError(form, err);
    }
  };
}
function passwordChecklist() {
  return `<div class="checklist" aria-live="polite"><span data-check="length">${t('8 caracteres como mínimo', 'At least 8 characters')}</span><span data-check="special">${t('Un carácter especial', 'One special character')}</span><span data-check="number">${t('Un número', 'One number')}</span><span data-check="upper">${t('Una letra mayúscula', 'One uppercase letter')}</span><span data-check="lower">${t('Una letra minúscula', 'One lowercase letter')}</span><span data-check="match">${t('Las contraseñas coinciden', 'Passwords match')}</span></div>`;
}
function verificationWall(email) {
  setView('authPanel');
  const panel = $('#authPanel');
  panel.innerHTML = `<div class="auth-brand"><span class="brand-mark"><i class="fa-solid fa-book-open"></i></span><strong>${esc(state.config.site.name)}</strong></div><h1>${t('Primero debes verificar la cuenta', 'First, verify your account')}</h1><p>${t('Revisa tu correo electrónico para verificar tu cuenta.', 'Check your email to verify your account.')}</p><form id="verificationForm" class="verification-form"><div class="field"><label for="verificationEmail">${t('Te registraste con este correo:', 'You registered with this email:')}</label><input id="verificationEmail" type="email" value="${esc(email)}" readonly></div>${state.config?.captcha?.enabled ? '<div class="captcha-wrap"><div class="captcha-slot"></div><div class="captcha-status" role="alert" hidden></div></div>' : ''}<div class="form-message auth-error" hidden></div><button class="primary-button" type="submit">${t('Reenviar correo', 'Resend email')}</button><div class="verification-notice">${t('¿No llega el correo? No olvides revisar tu carpeta de SPAM.', 'Did not receive the email? Check your spam folder.')}</div></form>`;
  const form = $('#verificationForm', panel), captcha = createCaptchaController(form, 'verify');
  form.onsubmit = async (event) => {
    event.preventDefault();
    $('.form-message', form).hidden = true;
    let attempted = false;
    try {
      let captchaToken = '';
      if (state.config?.captcha?.enabled) {
        attempted = true;
        captchaToken = await captcha.token();
      }
      await api('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ captchaToken }) });
      notify({ icon: 'success', title: t('Solicitud de verificación enviada', 'Verification email requested') });
    } catch (error) {
      showError(form, error);
    } finally {
      if (attempted) captcha.reset();
    }
  };
}
function checkPassword(value, repeat) {
  return {
    length: value.length >= 8,
    special: /[!@#$%^&*(),.?":{}|<>_+\-=\[\]\\/]/.test(value),
    number: /\d/.test(value),
    upper: /[A-Z]/.test(value),
    lower: /[a-z]/.test(value),
    match: value === repeat && value.length > 0,
  };
}
function validateAuthForm(form) {
  const fields = $$('input[required]', form);
  if (fields.some((field) => !field.value.trim()))
    throw validationError(t('Debes completar todos los campos.', 'Complete all fields.'));
  const invalid = fields.find((field) => !field.validity.valid);
  if (invalid) {
    invalid.focus();
    if (invalid.validity.typeMismatch && invalid.type === 'email')
      throw validationError(t('Introduce un correo electrónico válido.', 'Enter a valid email address.'));
    if (invalid.name === 'username' && (invalid.validity.tooShort || invalid.validity.tooLong))
      throw validationError(t('El nombre de usuario debe tener entre 2 y 60 caracteres.', 'The username must be between 2 and 60 characters.'));
    throw validationError(t('Revisa la información introducida.', 'Check the information entered.'));
  }
  const password = form.querySelector('#regPass,#resetPass,#rotatePass,#changePass');
  if (password) {
    const confirmation = form.querySelector('#regConfirm,#resetConfirm,#rotateConfirm,#changeConfirm');
    const checks = checkPassword(password.value, confirmation.value);
    if (!checks.match)
      throw validationError(t('Las contraseñas no coinciden.', 'Passwords do not match.'));
    if (Object.values(checks).some((valid) => !valid))
      throw validationError(t('Revisa los requisitos de la contraseña.', 'Check the password requirements.'));
  }
}
function navUrl(space, slug) {
  return space === 'main'
    ? `/${encodeURIComponent(slug)}`
    : `/${encodeURIComponent(space)}/${encodeURIComponent(slug)}`;
}
function safeLocalReturn(value) {
  try {
    const target = new URL(String(value || '/'), location.origin);
    return target.origin === location.origin && !target.pathname.startsWith('//')
      ? target.pathname + target.search + target.hash
      : '/';
  } catch {
    return '/';
  }
}
function renderSpaces() {
  const spaces = state.config.spaces || [];
  if (!spaces.some((s) => s.slug === state.space)) state.space = spaces[0]?.slug || 'main';
  const current = spaces.find((s) => s.slug === state.space) || spaces[0];
  if (!current) return;
  $('#spaceCurrentName').textContent = current.name;
  $('.space-symbol').innerHTML = spaceMarkMarkup(current);
  const menu = $('#spaceDropdownMenu');
  menu.innerHTML = spaces
    .map(
      (space) =>
        `<button type="button" role="option" aria-selected="${space.slug === state.space}" class="space-option ${space.slug === state.space ? 'selected' : ''}" data-space="${esc(space.slug)}">${spaceMarkMarkup(space)}<span class="space-option-copy"><span>${esc(space.name)}</span><small>${space.slug === 'main' ? '/' : '/' + esc(space.slug)}</small></span>${space.slug === state.space ? '<i class="fa-solid fa-check space-check"></i>' : ''}</button>`,
    )
    .join('');
  $$('.space-option', menu).forEach(
    (button) =>
      (button.onclick = async () => {
        if (!(await confirmUnsaved())) return;
        state.space = button.dataset.space;
        $('#spaceDropdownButton').setAttribute('aria-expanded', 'false');
        $('#spacePicker').classList.remove('open');
        $('#spaceDropdownMenu').classList.remove('open');
        history.pushState({}, '', state.space === 'main' ? '/' : '/' + encodeURIComponent(state.space));
        await loadWiki();
      }),
  );
}
function renderLanguageMenu() {
  const box = $('#languageMenu');
  const trigger = $('#languageButton');
  const languageName = (code) => {
    const item = (state.config.languageCatalog || []).find((entry) => entry.code === code);
    if (item?.name) return item.name;
    try {
      return new Intl.DisplayNames([code], { type: 'language' }).of(code) || code;
    } catch {
      return code;
    }
  };
  const languageFlag = (code) => {
    const [language, region] = String(code || '').split('-');
    const regionFlags = {
      en: '🇬🇧',
      es: '🇪🇸',
      fr: '🇫🇷',
      de: '🇩🇪',
      pt: '🇧🇷',
      it: '🇮🇹',
      ja: '🇯🇵',
      zh: '🇨🇳',
      ru: '🇷🇺',
      ar: '🇸🇦',
      ko: '🇰🇷',
      hi: '🇮🇳',
      nl: '🇳🇱',
      pl: '🇵🇱',
      tr: '🇹🇷',
    };
    const country = region?.toUpperCase();
    if (country && /^[A-Z]{2}$/.test(country)) {
      return String.fromCodePoint(...[...country].map((letter) => letter.charCodeAt(0) + 127397));
    }
    return regionFlags[language.toLowerCase()] || '🌐';
  };
  const languages = state.config.languages || ['en', 'es'];
  const selectedLanguage = languages.includes(state.lang) ? state.lang : languages[0] || 'en';
  const currentName = languageName(selectedLanguage);
  trigger.querySelector('.language-current-flag').textContent = languageFlag(selectedLanguage);
  trigger.querySelector('.language-current-name').textContent = currentName;
  trigger.setAttribute('aria-label', `${t('Cambiar idioma', 'Change language')}: ${currentName}`);
  box.innerHTML = languages
    .map((code) => {
      const label = languageName(code);
      const selected = selectedLanguage === code;
      return `<button class="language-option${selected ? ' active' : ''}" data-lang="${esc(code)}" role="menuitemradio" aria-checked="${selected}"><span class="language-option-flag" aria-hidden="true">${languageFlag(code)}</span><span>${esc(label)}</span>${selected ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}</button>`;
    })
    .join('');
  $$('button', box).forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmUnsaved())) return;
        state.lang = b.dataset.lang;
        localStorage.setItem('wiki-language', state.lang);
        await loadTranslations(state.lang);
        box.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        render();
      }),
  );
}
function foldSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}
function filterNav(value = '') {
  const nav = $('#navTree');
  if (!nav) return;
  const term = foldSearch(value.trim());
  nav.classList.toggle('search-active', Boolean(term));
  $$('.nav-link', nav).forEach((link) => {
    const haystack = foldSearch(link.textContent + ' ' + link.dataset.slug);
    link.hidden = Boolean(term) && !haystack.includes(term);
  });
  const groups = $$('.nav-group[data-category]', nav).reverse();
  for (const group of groups) {
    const direct = [...group.children].filter((child) => child.matches?.('.nav-link')),
      directVisible = direct.some((link) => !link.hidden),
      children = group.querySelector(':scope > .nav-subgroups'),
      nested = children
        ? [...children.children].filter((child) => child.classList.contains('nav-group'))
        : [],
      nestedVisible = nested.some((child) => !child.hidden);
    group.hidden = Boolean(term) && !directVisible && !nestedVisible;
  }
  const defaultEmpty = nav.querySelector('.empty-state:not(#navSearchEmpty)');
  if (defaultEmpty) defaultEmpty.hidden = Boolean(term);
  let empty = $('#navSearchEmpty', nav);
  const matching = $$('.nav-link', nav).some((link) => !link.hidden);
  if (term && !matching) {
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'navSearchEmpty';
      empty.className = 'empty-state';
      nav.append(empty);
    }
    empty.textContent = t('No hay resultados.', 'No results.');
    empty.hidden = false;
  } else if (empty) empty.remove();
}
function renderSearchSuggestions(value = '') {
  const box = $('#searchSuggestions'),
    input = $('#searchInput');
  if (!box || !input) return;
  const term = foldSearch(value.trim());
  if (term.length < 2) {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    searchMatches = [];
    searchSelection = -1;
    return;
  }
  searchMatches = (state.pages || [])
    .map((page) => ({
      page,
      label:
        page.titles[state.lang] ||
        page.titles[state.lang.split('-')[0]] ||
        Object.values(page.titles)[0] ||
        page.slug,
    }))
    .filter((item) => foldSearch(item.label + ' ' + item.page.slug).includes(term))
    .slice(0, 8);
  searchSelection = -1;
  box.innerHTML = searchMatches.length
    ? searchMatches
        .map(
          ({ page, label }, index) =>
            `<button type="button" class="search-suggestion" role="option" aria-selected="false" data-index="${index}" data-slug="${esc(page.slug)}"><i class="fa-solid fa-file-lines" aria-hidden="true"></i><span>${esc(label)}</span><small>/${esc(page.slug)}</small></button>`,
        )
        .join('')
    : `<div class="search-suggestion-empty">${t('No hay resultados.', 'No results.')}</div>`;
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}
async function navigateToPage(slug) {
  if (!(await confirmUnsaved())) return;
  history.pushState({}, '', navUrl(state.space, slug));
  $('#searchSuggestions').hidden = true;
  $('#searchInput').setAttribute('aria-expanded', 'false');
  closeMobileNav();
  showLoading();
  try {
    await loadPage(slug);
  } catch (error) {
    showError(document, error);
  } finally {
    hideLoading();
  }
}
function renderNav() {
  const nav = $('#navTree'),
    cats = state.categories,
    pages = state.pages,
    pagesByCategory = new Map(),
    childrenByParent = new Map();
  for (const page of pages) {
    if (!page.category_id) continue;
    const key = String(page.category_id),
      list = pagesByCategory.get(key) || [];
    list.push(page);
    pagesByCategory.set(key, list);
  }
  for (const category of cats) {
    const key = String(category.parent_id || ''),
      list = childrenByParent.get(key) || [];
    list.push(category);
    childrenByParent.set(key, list);
  }
  const renderCategory = (category) => {
    const label =
        category.names[state.lang] ||
        category.names[state.lang.split('-')[0]] ||
        Object.values(category.names)[0] ||
        'Section',
      kids = pagesByCategory.get(String(category.id)) || [],
      children = childrenByParent.get(String(category.id)) || [],
      opened = Boolean(category.is_open),
      toggle =
        children.length || kids.length
          ? '<button type="button" class="category-toggle" aria-label="' +
            t('Expandir o contraer', 'Expand or collapse') +
            '" aria-expanded="' +
            (opened ? 'true' : 'false') +
            '"><i class="fa-solid fa-chevron-' +
            (opened ? 'down' : 'right') +
            '"></i></button>'
          : '';
    return (
      '<section class="nav-group ' +
      (opened ? '' : 'collapsed') +
      '" data-category="' +
      category.id +
      '"><div class="nav-group-title" tabindex="0" role="button" aria-expanded="' +
      (opened ? 'true' : 'false') +
      '" aria-label="' +
      esc(label) +
      ' — ' +
      t('Expandir o contraer', 'Expand or collapse') +
      '">' +
      pageIconMarkup(category.icon) +
      ' ' +
      esc(label) +
      toggle +
      '</div><div class="nav-subgroups">' +
      kids.map(navItem).join('') +
      children.map(renderCategory).join('') +
      '</div></section>'
    );
  };
  const loose = pages.filter((page) => !page.category_id);
  let html = loose.map(navItem).join('') + (childrenByParent.get('') || []).map(renderCategory).join('');
  if (!html)
    html =
      '<div class="empty-state">' +
      t('Todavía no hay páginas.', 'No pages yet.') +
      (can('pages.create_edit')
        ? '<br><a href="/admin/pages?space=' + encodeURIComponent(state.space) + '">' + t('Crear una página', 'Create a page') + '</a>'
        : '') +
      '</div>';
  nav.innerHTML = html;
  const toggleCategory = (group) => {
    const toggle = $('.category-toggle', group);
    if (!toggle) return;
    group.classList.toggle('collapsed');
    const collapsed = group.classList.contains('collapsed'),
      icon = $('i', toggle);
    icon.className = collapsed ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  nav.onclick = async (event) => {
    const heading = event.target.closest('.nav-group-title');
    if (heading) {
      toggleCategory(heading.closest('.nav-group'));
      return;
    }
    const link = event.target.closest('.nav-link');
    if (link) {
      event.preventDefault();
      await navigateToPage(link.dataset.slug);
    }
  };
  nav.onkeydown = (event) => {
    const heading = event.target.closest('.nav-group-title');
    if (!heading || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    toggleCategory(heading.closest('.nav-group'));
  };
  filterNav($('#searchInput')?.value || '');
  renderSearchSuggestions($('#searchInput')?.value || '');
}
function navItem(p) {
  const label =
    p.titles[state.lang] || p.titles[state.lang.split('-')[0]] || Object.values(p.titles)[0] || p.slug;
  return (
    '<a class="nav-link" draggable="false" data-id="' +
    p.id +
    '" data-slug="' +
    esc(p.slug) +
    '">' +
    pageIconMarkup(p.icon) +
    '<span>' +
    esc(label) +
    '</span></a>'
  );
}
function buildTocTree(heads, prefix) {
  const roots = [],
    stack = [];
  heads.forEach((heading, index) => {
    const level = Number(heading.tagName.slice(1)),
      item = { heading, index, level, id: prefix + '-' + index, children: [] };
    heading.id = item.id;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(item);
    stack.push(item);
  });
  const render = (items) =>
    items
      .map((item) => {
        const label = String(item.heading.textContent || t('Sin título', 'Untitled section')).trim(),
          hasChildren = item.children.length > 0;
        return (
          '<div class="toc-tree-item toc-level-' +
          item.level +
          '"><div class="toc-tree-row">' +
          '<a href="#' +
          esc(item.id) +
          '" data-toc-index="' +
          item.index +
          '">' +
          esc(label) +
          '</a></div>' +
          (hasChildren ? '<div class="toc-tree-children">' + render(item.children) + '</div>' : '') +
          '</div>'
        );
      })
      .join('');
  return render(roots);
}
let tocActiveCleanup = null;
function watchTocHeadings(heads, toc, scrollTarget = window) {
  tocActiveCleanup?.();
  if (!heads.length) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    const threshold =
      scrollTarget === window
        ? window.innerHeight * 0.3
        : scrollTarget.getBoundingClientRect().top + Math.min(120, scrollTarget.clientHeight * 0.28);
    let activeIndex = 0;
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top <= threshold) activeIndex = i;
      else break;
    }
    const links = $$('a[data-toc-index]', toc);
    links.forEach((link) => {
      const active = Number(link.dataset.tocIndex) === activeIndex;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  // The article column may scroll independently inside the reading layout.
  // Capture phase observes scrolls from nested scrollers as well.
  scrollTarget.addEventListener('scroll', schedule, { passive: true, capture: true });
  if (scrollTarget !== window) window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  tocActiveCleanup = () => {
    scrollTarget.removeEventListener('scroll', schedule, true);
    if (scrollTarget !== window) window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
  update();
}
function renderToc() {
  const toc = $('#tocLinks'),
    title = $('#tocTitle');
  if (title) title.textContent = t('En esta página', 'On this page');
  const heads = $$('#article h1,#article h2,#article h3');
  toc.innerHTML = buildTocTree(heads, 'section');
  $$('a[data-toc-index]', toc).forEach((link) => {
    link.addEventListener('click', () => {
      let parent = heads[Number(link.dataset.tocIndex)]?.parentElement;
      while (parent && parent !== $('#article')) {
        if (parent.matches('details.wiki-spoiler')) parent.open = true;
        parent = parent.parentElement;
      }
    });
  });
  watchTocHeadings(heads, toc, $('#readingLayout') || window);
  $('#toc').hidden = heads.length === 0 && $('#lastEdited')?.hidden !== false;
}
function renderEditorToc(content) {
  const lastEdited = $('#lastEdited');
  if (lastEdited) lastEdited.hidden = true;
  const toc = $('#tocLinks'),
    title = $('#tocTitle');
  if (title) title.textContent = t('En esta página', 'On this page');
  toc.setAttribute('data-empty-label', t('Añade encabezados para crear el índice.', 'Add headings to create an outline.'));
  const heads = $$('h1,h2,h3', content);
  toc.innerHTML = buildTocTree(heads, 'edit-section');
  $$('a[data-toc-index]', toc).forEach(
    (link) =>
      (link.onclick = (event) => {
        event.preventDefault();
        heads[Number(link.dataset.tocIndex)]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }),
  );
  watchTocHeadings(heads, toc, content);
  $('#toc').hidden = false;
}
function renderLastEdited() {
  const panel = $('#lastEdited'),
    page = state.page;
  if (!panel) return;
  if (!page?.updated_at) {
    panel.hidden = true;
    return;
  }
  const date = new Date(page.updated_at);
  if (Number.isNaN(date.getTime())) {
    panel.hidden = true;
    return;
  }
  const formatted = new Intl.DateTimeFormat(
    String(state.lang || 'en')
      .toLowerCase()
      .startsWith('es')
      ? 'es'
      : 'en-US',
    { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Guayaquil' },
  ).format(date);
  panel.innerHTML = `<span class="last-edited-label">${t('Última edición por', 'Last edited by')}</span><strong>${esc(page.updated_by_name || t('Sistema', 'System'))}</strong><time datetime="${date.toISOString()}">${esc(formatted)}</time>`;
  panel.hidden = false;
}
function renderPage(initialReactions = [], initialMine = '') {
  const title = state.page?.titles?.[state.lang] || '';
  const article = $('#article');
  updateBrowserTitle(
    title || state.page?.titles?.[state.lang.split('-')[0]] ||
      Object.values(state.page?.titles || {})[0] || state.page?.slug || t('Página', 'Page'),
  );
  article.classList.remove('article-enter');
  article.innerHTML = editorHtmlFromMarkup(state.page?.content?.[state.lang] || '');
  requestAnimationFrame(() => article.classList.add('article-enter'));
  $$('.wiki-spoiler', $('#article')).forEach((spoiler) => {
    const icon = spoiler.querySelector(':scope > summary .spoiler-icon');
    const update = () => {
      if (icon) icon.className = 'spoiler-icon fa-solid ' + (spoiler.open ? 'fa-eye' : 'fa-eye-slash');
    };
    spoiler.addEventListener('toggle', update);
    update();
  });
  $$('.code-block', $('#article')).forEach(highlightCodeBlock);
  renderLastEdited();
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.slug === state.page?.slug));
  const activeSpace = state.config.spaces.find((space) => space.slug === state.space);
  $('#breadcrumbs').innerHTML =
    `<span>${esc(activeSpace?.name || state.config.site.name)}</span><i class="fa-solid fa-chevron-right"></i><span>${esc(title)}</span>`;
  $('#lastUpdated')?.remove();
  renderToc();
  $('#reactions').hidden = !state.page;
  let currentCounts = initialReactions,
    currentMood = initialMine || '';
  paintReactions(currentCounts, currentMood);
  $$('.reaction-buttons button').forEach(
    (button) =>
      (button.onclick = async () => {
        if (!state.page) return;
        const priorCounts = currentCounts,
          priorMood = currentMood,
          nextMood = currentMood === button.dataset.mood ? '' : button.dataset.mood,
          map = Object.fromEntries(currentCounts.map((item) => [item.mood, Number(item.count)]));
        if (priorMood) map[priorMood] = Math.max(0, (map[priorMood] || 0) - 1);
        if (nextMood) map[nextMood] = (map[nextMood] || 0) + 1;
        currentCounts = Object.entries(map)
          .filter(([, count]) => count > 0)
          .map(([mood, count]) => ({ mood, count }));
        currentMood = nextMood;
        paintReactions(currentCounts, currentMood);
        $$('.reaction-buttons button').forEach((item) => (item.disabled = true));
        try {
          const result = await api(`/api/pages/${state.page.id}/reactions`, {
            method: 'POST',
            body: JSON.stringify({ mood: button.dataset.mood }),
          });
          currentCounts = result.reactions;
          currentMood = result.myReaction || '';
          paintReactions(currentCounts, currentMood);
          setNotice(t('Reacción enviada.', 'Reaction submitted.'));
        } catch (error) {
          currentCounts = priorCounts;
          currentMood = priorMood;
          paintReactions(currentCounts, currentMood);
          if (isUserError(error)) setNotice(userErrorText(error), 'error');
          else showCouldNotStart(error, 'reaction');
        } finally {
          $$('.reaction-buttons button').forEach((item) => (item.disabled = false));
        }
      }),
  );
}
function paintReactions(counts = [], selected = '') {
  const map = Object.fromEntries(counts.map((x) => [x.mood, Number(x.count)]));
  $$('.reaction-buttons button').forEach((b) => {
    b.classList.toggle('selected', b.dataset.mood === selected);
    $('span', b).textContent = map[b.dataset.mood] || 0;
  });
}
function renderExternalRedirect(target) {
  $('#article').innerHTML =
    `<div class="not-found-page external-redirect-notice"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><h1>${t('Enlace externo', 'External link')}</h1><p>${t('Esta página abre un sitio externo. Comprueba la dirección antes de continuar:', 'This page opens an external site. Check the address before continuing:')} <strong>${esc(target.host)}</strong></p><a class="secondary-button" href="${esc(target.href)}" rel="noopener noreferrer">${t('Continuar a', 'Continue to')} ${esc(target.hostname)}</a></div>`;
  $('#reactions').hidden = true;
  $('#toc').hidden = true;
}
async function loadPage(slug, prefetched = null, prefetchedReactions = null, prefetchedMine = '') {
  const sequence = ++pageRequestSequence,
    page = slug
      ? state.pages.find((item) => item.slug === slug)
      : state.pages.find((item) => item.slug === state.homePageSlug) || state.pages[0];
  if (!page) {
    state.page = null;
    updateBrowserTitle(t('Página no encontrada', 'Page not found'));
    const activeSpace = state.config.spaces.find((space) => space.slug === state.space);
    $('#article').innerHTML =
      `<div class="not-found-page"><span class="not-found-code">404</span><h1>${t('Página no encontrada', 'Page not found')}</h1><p>${t('No existe una página con esa ruta en este espacio.', 'There is no page at this route in this space.')}</p><a class="secondary-button" href="${state.space === 'main' ? '/' : '/' + encodeURIComponent(state.space)}"><i class="fa-solid fa-arrow-left"></i> ${t('Volver a', 'Back to')} ${esc(activeSpace?.name || t('la documentación', 'documentation'))}</a></div>`;
    $('#breadcrumbs').innerHTML =
      `<span>${esc(activeSpace?.name || state.config.site.name)}</span><i class="fa-solid fa-chevron-right"></i><span>404</span>`;
    $('#reactions').hidden = true;
    $('#toc').hidden = true;
    return;
  }
  if (page.page_type === 'redirect' && page.redirect_url) {
    let target;
    try {
      target = new URL(page.redirect_url, location.origin);
    } catch {
      target = null;
    }
    if (target && ['http:', 'https:'].includes(target.protocol) && target.origin === location.origin) {
      location.assign(target.href);
      return;
    }
    state.page = { ...page, content: {} };
    renderPage([], '');
    if (!target || !['http:', 'https:'].includes(target.protocol)) {
      $('#article').innerHTML =
        `<div class="not-found-page"><h1>${t('Enlace no disponible', 'Link unavailable')}</h1><p>${t('El destino de esta página no es válido.', 'This page has an invalid destination.')}</p></div>`;
      $('#reactions').hidden = true;
      $('#toc').hidden = true;
      return;
    }
    renderExternalRedirect(target);
    return;
  }
  let detail = prefetched,
    reactions = prefetchedReactions || [],
    mine = prefetchedMine;
  if (!detail) {
    const result = await api('/api/pages/' + encodeURIComponent(page.slug));
    detail = result.page;
    reactions = result.reactions || [];
    mine = result.myReaction || '';
  }
  if (sequence !== pageRequestSequence) return;
  if (!detail) {
    state.page = null;
    return loadPage('__missing_page__');
  }
  state.page = detail;
  renderPage(reactions, mine || '');
  for (const image of $$('img', $('#article'))) {
    image.loading = 'lazy';
    image.decoding = 'async';
  }
  for (const frame of $$('iframe', $('#article'))) frame.loading = 'lazy';
}
async function loadWiki() {
  showLoading();
  try {
    state.space = route().space;
    renderSpaces();
    const target = route().slug,
      endpoint = '/api/pages' + (target ? '?slug=' + encodeURIComponent(target) : ''),
      result = await api(endpoint);
    state.pages = result.pages;
    state.categories = result.categories;
    state.homePageSlug = result.homePageSlug || null;
    renderNav();
    await loadPage(target, result.page, result.reactions, result.myReaction);
  } finally {
    hideLoading();
  }
}
function renderHeaderLinks() {
  const nav = $('#headerLinks');
  nav.setAttribute('aria-label', t('Enlaces del encabezado', 'Header links'));
  nav.replaceChildren();
  for (const link of state.config?.headerLinks || []) {
    const title =
      link.titles?.[state.lang] ||
      link.titles?.[state.lang.split('-')[0]] ||
      Object.values(link.titles || {}).find(Boolean) ||
      link.url;
    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.textContent = title;
    if (link.external) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
    nav.append(anchor);
  }
  nav.hidden = !nav.childElementCount;
}
function setView(view) {
  for (const id of ['articleWrap', 'authPanel', 'adminPanel', 'passwordWall'])
    $('#' + id).hidden = id !== view;
  document.body.classList.toggle('wiki-mode', view === 'articleWrap');
  document.body.classList.toggle('admin-mode', view === 'adminPanel');
  document.body.classList.remove('editor-mode');
  $('#adminNavigation').hidden = view !== 'adminPanel';
  const fullScreen = ['authPanel', 'passwordWall'].includes(view);
  document.body.classList.toggle('auth-fullscreen', fullScreen);
  $('#toc').hidden = view !== 'articleWrap';
  $('#notice').hidden = true;
}
function watchPassword(form) {
  const pass = form.querySelector('#regPass,#resetPass,#rotatePass,#changePass'),
    confirm = form.querySelector('#regConfirm,#resetConfirm,#rotateConfirm,#changeConfirm'),
    current = form.querySelector('#rotateCurrent,#currentPassword'),
    submit = form.querySelector('button[type=submit],button:not([type])');
  if (!pass || !confirm || !submit)
    throw new Error('No se encontraron los campos del formulario de contraseña.');
  const update = () => {
    const checks = checkPassword(pass.value, confirm.value);
    $$('[data-check]', form).forEach((el) => {
      el.classList.toggle('ok', !!checks[el.dataset.check]);
      el.classList.toggle(
        'invalid',
        (pass.value.length > 0 || confirm.value.length > 0) && !checks[el.dataset.check],
      );
    });
  };
  for (const field of [pass, confirm, current].filter(Boolean))
    for (const event of ['input', 'change', 'keyup', 'blur']) field.addEventListener(event, update);
  update();
  for (const delay of [50, 250, 700, 1500]) setTimeout(update, delay);
}
function forcePassword(currentPassword = '') {
  if (location.pathname !== '/change-password') history.replaceState({}, '', '/change-password');
  setView('passwordWall');
  const wall = $('#passwordWall');
  wall.innerHTML = `<div class="password-card"><div class="auth-brand"><span class="brand-mark"><i class="fa-solid fa-lock"></i></span><strong>${esc(state.config?.site?.name || 'Teralth Studio')}</strong></div><h1>${t('Cambia tu contraseña', 'Change your password')}</h1><p>${t('Antes de continuar, define una contraseña nueva y confírmala.', 'Before continuing, set a new password and confirm it.')}</p><form id="rotateForm"><div class="field"><label for="rotateCurrent">${t('Contraseña anterior', 'Previous password')}</label><input id="rotateCurrent" type="password" autocomplete="current-password" required></div><div class="field"><label for="rotatePass">${t('Nueva contraseña', 'New password')}</label><input id="rotatePass" type="password" autocomplete="new-password" required></div><div class="field"><label for="rotateConfirm">${t('Repetir nueva contraseña', 'Repeat new password')}</label><input id="rotateConfirm" type="password" autocomplete="new-password" required></div><div class="checklist" aria-live="polite"><span data-check="length">${t('8 caracteres como mínimo', 'At least 8 characters')}</span><span data-check="special">${t('Un carácter especial', 'One special character')}</span><span data-check="number">${t('Un número', 'One number')}</span><span data-check="upper">${t('Una mayúscula', 'One uppercase letter')}</span><span data-check="lower">${t('Una minúscula', 'One lowercase letter')}</span><span data-check="match">${t('Las contraseñas coinciden', 'Passwords match')}</span></div>${state.config?.captcha?.enabled ? `<div class="captcha-wrap"><div class="captcha-slot"></div><div class="captcha-status" role="alert" hidden></div></div>` : ''}<div class="form-message auth-error" hidden></div><button class="primary-button" type="submit" disabled>${t('Guardar contraseña', 'Save password')}</button></form></div>`;
  $('#rotateCurrent').value = currentPassword;
  const captcha = createCaptchaController($('#rotateForm'), 'change');
  $('#rotateForm').noValidate = true;
  $('#rotateForm button[type=submit]').disabled = false;
  watchPassword($('#rotateForm'));
  $('#rotateForm').onsubmit = async (e) => {
    e.preventDefault();
    $('.form-message', $('#rotateForm')).hidden = true;
    let captchaAttempted = false;
    try {
      validateAuthForm($('#rotateForm'));
      const password = $('#rotatePass').value;
      let captchaToken = '';
      if (state.config?.captcha?.enabled) {
        captchaAttempted = true;
        captchaToken = await captcha.token();
      }
      if (password !== $('#rotateConfirm').value)
        throw validationError(t('Las contraseñas nuevas no coinciden.', 'The new passwords do not match.'));
      const result = await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: $('#rotateCurrent').value, password, captchaToken }),
      });
      state.csrf = result.csrfToken;
      state.user.mustChangePassword = false;
      await notify({
        icon: 'success',
        title: t('Contraseña actualizada', 'Password updated'),
        text: passwordChangeNotificationText(result.notificationQueued),
        confirmButtonText: t('Entendido', 'Got it'),
      });
      location.assign('/');
    } catch (err) {
      if (captchaAttempted) captcha.reset();
      showError($('#rotateForm'), err);
    }
  };
}
async function loadUsers() {
  const result = await api('/api/admin/users');
  return result.users;
}
let adminUpdatesLoadPromise = null;
function loadAdminUpdatesModule() {
  if (typeof window.TeralthAdminUpdates?.render === 'function')
    return Promise.resolve(window.TeralthAdminUpdates);
  if (!adminUpdatesLoadPromise) {
    adminUpdatesLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/admin-updates.js';
      script.async = true;
      script.onload = () => {
        if (typeof window.TeralthAdminUpdates?.render === 'function') resolve(window.TeralthAdminUpdates);
        else reject(new Error('The update administration module did not initialize.'));
      };
      script.onerror = () => reject(new Error('The update administration module could not be loaded.'));
      document.head.append(script);
    }).catch((error) => {
      adminUpdatesLoadPromise = null;
      throw error;
    });
  }
  return adminUpdatesLoadPromise;
}
async function adminView(tab = 'pages', { replaceUrl = false } = {}) {
  showLoading();
  const tabDefs = [
      ['pages', t('Páginas', 'Pages'), ['pages.create_edit', 'pages.delete']],
      ['categories', t('Categorías', 'Categories'), ['categories.create_edit', 'categories.delete']],
      ['header-links', t('Enlaces del encabezado', 'Header Links'), ['header_links.create_edit', 'header_links.delete']],
      [
        'settings',
        t('Sitio general', 'General settings'),
        ['settings.identity', 'settings.support', 'settings.seo', 'settings.sidebar_label'],
      ],
      ['spaces', t('Espacios de documentación', 'Documentation spaces'), ['spaces.create', 'spaces.edit', 'spaces.delete']],
      ['languages', t('Idiomas', 'Languages'), ['languages.create', 'languages.edit', 'languages.delete']],
      [
        'users',
        t('Usuarios', 'Users'),
        ['users.registration', 'users.edit', 'users.delete', 'users.role', 'users.reset_password'],
      ],
      ['roles', t('Roles', 'Roles'), ['roles.manage']],
      ['proxy', t('Proxy inverso', 'Reverse Proxy'), ['reverse_proxy.configure']],
      ['smtp', t('SMTP', 'SMTP'), ['smtp.configure']],
      [
        'backups',
        t('Copias de seguridad', 'Backups'),
        ['backups.import', 'backups.export', 'backups.schedule'],
      ],
      ['captcha', t('Captcha', 'Captcha'), ['captcha.configure']],
      ['updates', t('Update', 'Update'), ['updates.install']],
    ],
    visible = tabDefs.filter(([, label, permissions]) => canAny(permissions));
  if (!visible.some(([key]) => key === tab)) tab = visible[0]?.[0] || 'pages';
  const targetUrl = adminUrl(tab);
  if (location.pathname + location.search !== targetUrl) {
    if (replaceUrl) history.replaceState({}, '', targetUrl);
    else history.pushState({}, '', targetUrl);
  }
  setView('adminPanel');
  updateBrowserTitle(t('Admin', 'Admin'));
  state.adminTab = tab;
  const activeSpace = state.config.spaces.find((space) => space.slug === state.space),
    tabLabels = Object.fromEntries(tabDefs.map(([key, label]) => [key, label]));
  $('#breadcrumbs').innerHTML =
    `<span>${esc(activeSpace?.name || state.config.site.name)}</span><i class="fa-solid fa-chevron-right"></i><span>${t('Administración', 'Admin')}</span><i class="fa-solid fa-chevron-right"></i><span>${tabLabels[tab] || tabLabels.pages}</span>`;
  const panel = $('#adminPanel');
  panel.innerHTML = `<div class="admin-heading"><div><h1>${t('Administración', 'Administration')}</h1><p>${t('Configura tus espacios, páginas e idiomas.', 'Manage your spaces, pages, and languages.')}</p></div><a class="secondary-button" href="${state.space === 'main' ? '/' : '/' + encodeURIComponent(state.space)}"><i class="fa-solid fa-arrow-left"></i> ${t('Volver a la wiki', 'Back to wiki')}</a></div><div class="admin-message auth-error" hidden></div><div id="adminContent"></div>`;
  const icons = {
    pages: 'file-lines', categories: 'folder-tree', 'header-links': 'link', settings: 'sliders', spaces: 'layer-group', languages: 'language',
    users: 'users', roles: 'user-shield', proxy: 'network-wired', smtp: 'envelope',
    backups: 'database', captcha: 'shield-halved', updates: 'cloud-arrow-up',
  };
  const navigation = $('#adminNavigation');
  navigation.setAttribute('aria-label', t('Administración', 'Administration'));
  navigation.innerHTML = visible.map(([key, label]) =>
    `<button type="button" data-tab="${key}" class="admin-nav-item${tab === key ? ' active' : ''}"${tab === key ? ' aria-current="page"' : ''}><i class="fa-solid fa-${icons[key]}" aria-hidden="true"></i><span>${esc(label)}</span>${key === 'updates' ? '<span class="admin-nav-beta">BETA</span>' : ''}</button>`).join('');
  $$('[data-tab]', navigation).forEach(
    (button) =>
      (button.onclick = async () => {
        if (!(await confirmUnsaved())) return;
        closeMobileNav();
        await adminView(button.dataset.tab);
      }),
  );
  const content = $('#adminContent');
  try {
    if (tab === 'settings') await settingsTab(content);
    if (tab === 'spaces') await spacesTab(content);
    if (tab === 'languages') await languagesTab(content);
    if (tab === 'users') await usersTab(content);
    if (tab === 'roles') await rolesTab(content);
    if (tab === 'proxy') await reverseProxyTab(content);
    if (tab === 'smtp') await smtpTab(content);
    if (tab === 'captcha') await captchaTab(content);
    if (tab === 'backups') await backupsTab(content);
    if (tab === 'updates') {
      const updatesModule = await loadAdminUpdatesModule();
      await updatesModule.render(content, { api, t, esc, showError, csrf: state.csrf });
    }
    if (tab === 'pages') await pagesTab(content);
    if (tab === 'categories') await categoriesTab(content);
    if (tab === 'header-links') await headerLinksTab(content);
  } catch (error) {
    showError(panel, error);
  } finally {
    hideLoading();
  }
}
function settingsGroup(title, ...elements) {
  const section = document.createElement('section');
  section.className = 'settings-group';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading, ...elements);
  return section;
}
async function settingsTab(root) {
  const config = state.config;
  root.innerHTML = `<section class="admin-section"><h2>${t('Identidad del sitio', 'Site identity')}</h2><p>${t('Nombre y logotipo visibles en la wiki.', 'Name and logo shown in the wiki.')}</p><div class="settings-row"><label><span class="admin-label">${t('Nombre del sitio', 'Site name')}</span><input class="settings-input" id="siteName" maxlength="120" value="${esc(config.site.name)}"></label><label><span class="admin-label">${t('Contacto de soporte', 'Support contact URL or email')}</span><input class="settings-input" id="supportUrl" maxlength="500" placeholder="https://... o mailto:ayuda@..." value="${esc(config.site.supportUrl || '')}"></label><label><span class="admin-label">${t('Subir logotipo', 'Upload logo')}</span><input class="settings-input" id="siteLogo" type="hidden" value="${esc(config.site.logo || '')}"><input id="siteLogoFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><span id="siteLogoStatus">${esc(config.site.logo || '')}</span></label></div></section><section class="admin-section browser-identity-section" id="browserIdentitySettings"><h2>${t('Título del navegador y favicon', 'Browser title and favicon')}</h2><p>${t('Configura el título de la pestaña y el icono del sitio, separados del logotipo de la wiki.', 'Set the browser tab title and site icon separately from the wiki logo.')}</p><div class="browser-identity-grid"><label><span class="admin-label">${t('Título del navegador', 'Browser title')}</span><input class="settings-input" id="pageTitle" maxlength="120" required value="${esc(config.site.pageTitle || config.site.name)}" ${can('settings.identity') ? '' : 'disabled'}></label><div class="favicon-field"><span class="admin-label">${t('Favicon del sitio', 'Site favicon')}</span><div class="favicon-controls"><img id="faviconPreview" src="${esc(config.site.favicon || '/assets/favicon.svg')}" alt="" width="32" height="32"><input class="settings-input" id="faviconPath" type="hidden" value="${esc(config.site.favicon || '/assets/favicon.svg')}"><input id="faviconFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp" ${can('settings.identity') ? '' : 'disabled'}><button type="button" class="secondary-button" id="resetFavicon" ${can('settings.identity') ? '' : 'disabled'}>${t('Usar predeterminado', 'Use default')}</button></div><span class="favicon-status" id="faviconStatus">${esc(config.site.favicon || '/assets/favicon.svg')}</span></div></div></section><section class="admin-section" id="sidebarLabelSettings"><h2>${t('Etiqueta de la barra lateral', 'Sidebar label')}</h2><p>${t('Texto que aparece junto al selector de tema claro y oscuro.', 'Text shown beside the light and dark theme switch.')}</p><label><span class="admin-label">${t('Texto visible', 'Display text')}</span><input class="settings-input" id="sidebarLabelInput" maxlength=80 required value="${esc(config.site.sidebarLabel || t('Documentación', 'Documentation'))}" ${can('settings.sidebar_label') ? '' : 'disabled'}></label></section><section class="admin-section"><h2>${t('Espacios de documentación', 'Documentation spaces')}</h2><p>${t('Cada espacio tendrá su propia ruta, por ejemplo /ThJumpPads.', 'Each space has its own route, for example /ThJumpPads.')}</p><div id="spaceRows">${config.spaces.map((sp) => spaceRow(sp)).join('')}</div><button class="secondary-button" id="addSpace"><i class="fa-solid fa-plus"></i> ${t('Añadir espacio', 'Add space')}</button></section><button class="primary-button" id="saveSettings"><i class="fa-solid fa-floppy-disk"></i> ${t('Guardar cambios', 'Save changes')}</button>`;
  $('#spaceRows', root)?.closest('.admin-section')?.remove();
  const sections = $$('.admin-section', root);
  const identity = sections[0],
    supportUrlField = $('#supportUrl', root).closest('label'),
    faviconField = $('.favicon-field', root),
    seoSection = $('#browserIdentitySettings', root),
    storedSupport = config.site.support || {},
    supportDraft = structuredClone(storedSupport.translations || {}),
    seo = config.site.seo || {};
  $('#pageTitle', root).closest('label').remove();
  const siteNameField = $('#siteName', root).closest('label'),
    siteLogoField = $('#siteLogoFile', root).closest('label'),
    brandFields = document.createElement('div');
  supportUrlField.remove();
  brandFields.className = 'settings-group-grid';
  brandFields.append(siteLogoField, faviconField);
  $('.settings-row', identity).remove();
  identity.append(
    settingsGroup(t('Datos del sitio', 'Site details'), siteNameField),
    settingsGroup(t('Identidad visual', 'Visual identity'), brandFields),
  );
  const supportSection = document.createElement('section');
  supportSection.className = 'admin-section support-settings';
  supportSection.innerHTML = `
    <h2>${t('Bloque de soporte', 'Support card')}</h2>
    <p>${t('Personaliza el contenido por idioma y los colores del bloque.', 'Customize the content for each language and the card colors.')}</p>
    <div class="support-enabled-control">
      <span class="support-enabled-copy">
        <label for="supportCardEnabled"><strong>${t('Mostrar bloque de soporte', 'Show support card')}</strong></label>
        <small>${t('Visible en la barra lateral de la documentación.', 'Visible on the documentation sidebar.')}</small>
      </span>
      <label class="language-switch" for="supportCardEnabled">
        <input type="checkbox" id="supportCardEnabled" ${storedSupport.enabled === false ? '' : 'checked'} ${can('settings.support') ? '' : 'disabled'}>
        <span class="language-switch-track"></span>
      </label>
    </div>
    <div class="support-editor">
      <div class="support-editor-fields">
        <section class="support-editor-group">
          <h3>${t('Contenido', 'Content')}</h3>
          <div class="support-fields">
            <label class="support-field-wide"><span class="admin-label">${t('Idioma', 'Language')}</span><select class="settings-input" id="supportLanguage">${config.languages.map(code => `<option value="${esc(code)}">${esc(code)}</option>`).join('')}</select></label>
            <label class="support-field-wide"><span class="admin-label">${t('Título', 'Title')}</span><input class="settings-input" id="supportTitleInput" maxlength="120"></label>
            <label class="support-field-wide"><span class="admin-label">${t('Descripción', 'Description')}</span><textarea class="settings-input" id="supportDescriptionInput" maxlength="500" rows="3"></textarea></label>
          </div>
        </section>
        <section class="support-editor-group">
          <h3>${t('Botón de contacto', 'Contact button')}</h3>
          <div class="support-fields" id="supportContactFields">
            <label><span class="admin-label">${t('Texto del botón', 'Button text')}</span><input class="settings-input" id="supportButtonInput" maxlength="80"></label>
          </div>
        </section>
        <section class="support-editor-group">
          <h3>${t('Apariencia', 'Appearance')}</h3>
          <p>${t('Usa colores hexadecimales; deja los campos vacíos para usar los colores predeterminados.', 'Use hex colors; leave fields empty for the default colors.')}</p>
          <div class="support-fields support-colors">
            <label><span class="admin-label">${t('Fondo del bloque', 'Card background')}</span><span class="support-color-input"><input class="settings-input" id="supportBackground" placeholder="#171b2b" maxlength="7" value="${esc(storedSupport.background || '')}"></span></label>
            <label><span class="admin-label">${t('Segundo color del bloque (opcional)', 'Card gradient end (optional)')}</span><span class="support-color-input"><input class="settings-input" id="supportBackgroundEnd" placeholder="#15161b" maxlength="7" value="${esc(storedSupport.backgroundEnd || '')}"></span></label>
            <label><span class="admin-label">${t('Fondo del botón', 'Button background')}</span><span class="support-color-input"><input class="settings-input" id="supportButtonBackground" placeholder="#813cf0" maxlength="7" value="${esc(storedSupport.buttonBackground || '')}"></span></label>
            <label><span class="admin-label">${t('Segundo color del botón (opcional)', 'Button gradient end (optional)')}</span><span class="support-color-input"><input class="settings-input" id="supportButtonBackgroundEnd" placeholder="#514ee4" maxlength="7" value="${esc(storedSupport.buttonBackgroundEnd || '')}"></span></label>
          </div>
        </section>
      </div>
      <aside class="support-preview" aria-label="${t('Vista previa', 'Preview')}">
        <div class="support-preview-heading"><h3>${t('Vista previa', 'Preview')}</h3><span>${t('En tiempo real', 'Live')}</span></div>
        <div class="support-preview-canvas" id="supportPreviewCanvas" data-disabled-label="${t('El bloque está oculto en la documentación.', 'The card is hidden on the documentation site.')}">
          <div class="support-card" id="supportPreviewCard">
            <div class="support-card-heading"><span class="support-status-dot"></span><strong id="supportPreviewTitle"></strong></div>
            <p id="supportPreviewDescription"></p>
            <span class="support-card-link" id="supportPreviewButton"><span id="supportPreviewButtonText"></span></span>
          </div>
        </div>
      </aside>
    </div>`;
  $('#supportContactFields', supportSection).append(supportUrlField);
  identity.after(supportSection);
  for (const [id, fallback] of [
    ['supportBackground', '#171b2b'], ['supportBackgroundEnd', '#15161b'],
    ['supportButtonBackground', '#813cf0'], ['supportButtonBackgroundEnd', '#514ee4'],
  ]) {
    const field = $('#' + id, root),
      picker = document.createElement('input');
    picker.type = 'color';
    picker.value = /^#[\da-f]{6}$/i.test(field.value) ? field.value : fallback;
    picker.setAttribute('aria-label', field.closest('label').querySelector('.admin-label').textContent);
    picker.addEventListener('input', () => { field.value = picker.value; });
    field.addEventListener('input', () => { if (/^#[\da-f]{6}$/i.test(field.value)) picker.value = field.value; });
    field.after(picker);
  }
  const supportLanguage = $('#supportLanguage', root);
  const readSupport = () => ({
    title: $('#supportTitleInput', root).value,
    description: $('#supportDescriptionInput', root).value,
    button: $('#supportButtonInput', root).value,
  });
  const fillSupport = (code) => {
    const item = supportDraft[code] || {};
    $('#supportTitleInput', root).value = item.title || '';
    $('#supportDescriptionInput', root).value = item.description || '';
    $('#supportButtonInput', root).value = item.button || '';
    supportLanguage.dataset.current = code;
  };
  let previewTranslations = state.translations, previewRequest = 0;
  const updateSupportPreview = () => {
    const preview = $('#supportPreviewCard', root);
    preview.hidden = !$('#supportCardEnabled', root).checked;
    $('#supportPreviewCanvas', root).dataset.disabled = String(preview.hidden);
    const support = {
      background: $('#supportBackground', root).value.trim(),
      backgroundEnd: $('#supportBackgroundEnd', root).value.trim(),
      buttonBackground: $('#supportButtonBackground', root).value.trim(),
      buttonBackgroundEnd: $('#supportButtonBackgroundEnd', root).value.trim(),
    };
    setSupportCardAppearance($('#supportPreviewCard', root), $('#supportPreviewTitle', root),
      $('#supportPreviewDescription', root), $('#supportPreviewButton', root), $('#supportPreviewButtonText', root),
      readSupport(), support, previewTranslations);
  };
  const updatePreviewLanguage = async (code) => {
    const request = ++previewRequest;
    const translations = code === state.lang ? state.translations : await getTranslations(code);
    if (request !== previewRequest) return;
    previewTranslations = translations;
    updateSupportPreview();
  };
  supportSection.addEventListener('input', updateSupportPreview);
  supportLanguage.onchange = () => {
    supportDraft[supportLanguage.dataset.current] = readSupport();
    fillSupport(supportLanguage.value);
    void updatePreviewLanguage(supportLanguage.value);
    updateSupportPreview();
  };
  fillSupport(config.languages.includes(state.lang) ? state.lang : config.languages[0]);
  supportLanguage.value = supportLanguage.dataset.current;
  updateSupportPreview();
  if (state.lang !== supportLanguage.value) void updatePreviewLanguage(supportLanguage.value);
  seoSection.innerHTML = `<h2>SEO</h2><p>${t('Configura cómo aparece el sitio en buscadores y redes sociales.', 'Configure how the site appears in search engines and social media.')}</p><div class="settings-row"><label><span class="admin-label">${t('Descripción del sitio', 'Site description')}</span><input class="settings-input" id="seoDescription" maxlength="320" value="${esc(seo.description || '')}"></label><label><span class="admin-label">${t('Título para redes sociales', 'Social media title')}</span><input class="settings-input" id="seoSocialTitle" maxlength="120" value="${esc(seo.socialTitle || '')}"></label><label><span class="admin-label">${t('Descripción para redes sociales', 'Social media description')}</span><input class="settings-input" id="seoSocialDescription" maxlength="320" value="${esc(seo.socialDescription || '')}"></label><label><span class="admin-label">${t('Imagen para redes sociales (URL o imagen subida)', 'Social media image (URL or uploaded image)')}</span><input class="settings-input" id="seoSocialImage" maxlength="2048" value="${esc(seo.socialImage || '')}"><input type="file" id="seoImageFile" accept="image/png,image/jpeg,image/gif,image/webp"></label><label><span class="admin-label">${t('URL canónica base', 'Canonical base URL')}</span><input class="settings-input" id="seoCanonical" type="url" maxlength="2048" value="${esc(seo.canonicalBase || '')}"></label></div><label class="seo-indexing"><input id="seoIndexable" type="checkbox" ${seo.indexable === false ? '' : 'checked'}> ${t('Permitir indexación por buscadores', 'Allow search engine indexing')}</label>`;
  const seoSearchFields = document.createElement('div'),
    seoSocialFields = document.createElement('div');
  seoSearchFields.className = 'settings-group-grid';
  seoSocialFields.className = 'settings-group-grid';
  seoSearchFields.append($('#seoDescription', root).closest('label'), $('#seoCanonical', root).closest('label'));
  seoSocialFields.append($('#seoSocialTitle', root).closest('label'), $('#seoSocialDescription', root).closest('label'),
    $('#seoSocialImage', root).closest('label'));
  $('.settings-row', seoSection).remove();
  const seoIndexing = $('.seo-indexing', seoSection);
  seoSection.append(
    settingsGroup(t('Buscadores', 'Search engines'), seoSearchFields, seoIndexing),
    settingsGroup(t('Redes sociales', 'Social media'), seoSocialFields),
  );
  $('#seoImageFile', root).onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.disabled = true;
    try {
      const body = new FormData();
      body.append('image', file);
      body.append('alt', 'Social media image');
      const response = await request('/api/admin/uploads', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf }, body,
      });
      $('#seoSocialImage', root).value = (await imageUploadResponse(response)).url;
      setNotice(t('Imagen subida. Guarda los cambios para aplicarla.', 'Image uploaded. Save changes to apply it.'));
    } catch (error) {
      showError($('#adminPanel'), error);
    } finally {
      event.target.disabled = false;
      event.target.value = '';
    }
  };
  $('#sidebarLabelSettings h2', root).textContent = t('Contenido del pie de página', 'Footer content');
  $('#sidebarLabelSettings p', root).textContent = t('Texto que aparece en el pie de página.', 'Text shown in the footer.');
  if (sections[0]) sections[0].hidden = !can('settings.identity');
  supportSection.hidden = !can('settings.support');
  $('#browserIdentitySettings', root).hidden = !can('settings.seo');
  if ($('#sidebarLabelSettings', root))
    $('#sidebarLabelSettings', root).hidden = !can('settings.sidebar_label');
  $('#saveSettings', root).hidden = !canAny([
    'settings.identity',
    'settings.support',
    'settings.seo',
    'settings.sidebar_label',
  ]);
  $('#faviconFile', root).onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const input = e.target,
      status = $('#faviconStatus', root),
      preview = $('#faviconPreview', root);
    input.disabled = true;
    status.textContent = t('Subiendo favicon…', 'Uploading favicon…');
    try {
      const body = new FormData();
      body.append('image', file);
      body.append('alt', 'Site favicon');
      const response = await request('/api/admin/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf },
        body,
      });
      const data = await imageUploadResponse(response);
      $('#faviconPath', root).value = data.url;
      preview.src = data.url;
      status.textContent = data.url;
      setNotice(
        t(
          'Favicon subido. Guarda los cambios para aplicarlo.',
          'Favicon uploaded. Save changes to apply it.',
        ),
      );
    } catch (error) {
      status.textContent = '';
      showError($('#adminPanel'), error);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  };
  $('#resetFavicon', root).onclick = () => {
    $('#faviconPath', root).value = '/assets/favicon.svg';
    $('#faviconPreview', root).src = '/assets/favicon.svg';
    $('#faviconStatus', root).textContent = t('Favicon predeterminado', 'Default favicon');
  };
  $('#siteLogoFile', root).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const body = new FormData();
      body.append('image', file);
      body.append('alt', config.site.name);
      const response = await request('/api/admin/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf },
        body,
      });
      const data = await imageUploadResponse(response);
      $('#siteLogo', root).value = data.url;
      $('#siteLogoStatus', root).textContent = data.url;
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
  $('#saveSettings', root).onclick = async () => {
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          name: $('#siteName', root).value,
          favicon: $('#faviconPath', root).value,
          logo: $('#siteLogo', root).value,
          supportUrl: can('settings.support') ? $('#supportUrl', root).value : config.site.supportUrl,
          ...(can('settings.support') ? {
            support: {
              enabled: $('#supportCardEnabled', root).checked,
              translations: { ...supportDraft, [supportLanguage.value]: readSupport() },
              background: $('#supportBackground', root).value.trim(),
              backgroundEnd: $('#supportBackgroundEnd', root).value.trim(),
              buttonBackground: $('#supportButtonBackground', root).value.trim(),
              buttonBackgroundEnd: $('#supportButtonBackgroundEnd', root).value.trim(),
            },
          } : {}),
          ...(can('settings.seo') ? {
            seo: {
              description: $('#seoDescription', root).value,
              indexable: $('#seoIndexable', root).checked,
              socialTitle: $('#seoSocialTitle', root).value,
              socialDescription: $('#seoSocialDescription', root).value,
              socialImage: $('#seoSocialImage', root).value,
              canonicalBase: $('#seoCanonical', root).value,
            },
          } : {}),
          sidebarLabel: can('settings.sidebar_label')
            ? $('#sidebarLabelInput', root).value
            : config.site.sidebarLabel,
        }),
      });
      state.config = await api('/api/config');
      renderSpaces();
      renderLanguageMenu();
      updateBrand();
      renderSupportCard();
      await notify({
        icon: 'success',
        title: t('Configuración guardada', 'Settings saved'),
        confirmButtonText: t('Entendido', 'Got it'),
      });
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
}
async function spacesTab(root) {
  const config = state.config;
  root.innerHTML = `<section class="admin-section spaces-admin-section"><div class="section-heading"><div><h2><i class="fa-solid fa-layer-group" aria-hidden="true"></i> ${t('Espacios de documentación', 'Documentation spaces')}</h2><p>${t('Cada espacio tiene su propia ruta, navegación y logotipo.', 'Each space has its own route, navigation, and logo.')}</p></div></div><div id="spaceRows">${(config.spaces || []).map(spaceRow).join('')}</div><div class="language-admin-actions"><button class="secondary-button" id="addSpace" type="button"><i class="fa-solid fa-plus"></i> ${t('Añadir espacio', 'Add space')}</button><button class="primary-button" id="saveSpaces" type="button"><i class="fa-solid fa-floppy-disk"></i> ${t('Guardar cambios', 'Save changes')}</button></div></section>`;
  const rows = $('#spaceRows', root);
  $('#addSpace', root).hidden = !can('spaces.create');
  $('#saveSpaces', root).hidden = !canAny(['spaces.create', 'spaces.edit', 'spaces.delete']);
  if (!can('spaces.delete')) $$('.remove-space', root).forEach((button) => { button.hidden = true; });
  if (!can('spaces.edit')) $$('.space-admin-row', root).forEach((row) => {
    if ($('[data-field=slug]', row).value) {
      $$('[data-field]', row).forEach((input) => { input.disabled = true; });
      $('[data-space-mode]', row).disabled = true;
      $('.space-logo-file', row).disabled = true;
      $('.space-drag-handle', row).disabled = true;
    }
  });
  $('#addSpace', root).onclick = () => rows.insertAdjacentHTML('beforeend', spaceRow({
    slug: '', name: '', icon: 'fa-solid fa-book-open', logo: '',
  }));
  rows.onchange = async (event) => {
    const mode = event.target.closest('[data-space-mode]');
    if (mode) {
      const row = mode.closest('.space-admin-row'), imageMode = mode.value === 'image';
      $('.space-icon-field', row).hidden = imageMode;
      $('.space-logo-upload', row).hidden = !imageMode;
      $('[data-field=logo]', row).disabled = !imageMode;
      $('.space-logo-file', row).disabled = !imageMode;
      if (!imageMode) {
        $('[data-field=logo]', row).value = '';
        setSpaceLogoStatus(row, '');
      }
      return;
    }
    const input = event.target.closest('.space-logo-file'), file = input?.files?.[0];
    if (!file) return;
    const row = input.closest('.space-admin-row'), status = $('.space-logo-status', row);
    input.disabled = true;
    status.textContent = t('Subiendo imagen…', 'Uploading image…');
    try {
      const body = new FormData();
      body.append('image', file);
      body.append('alt', $('[data-field=name]', row).value.trim());
      const response = await request('/api/admin/uploads', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf }, body,
      });
      const data = await imageUploadResponse(response);
      $('[data-field=logo]', row).value = data.url;
      setSpaceLogoStatus(row, data.url);
      setNotice(t('Imagen subida. Guarda cambios para aplicar el logo.', 'Image uploaded. Save changes to apply the logo.'));
    } catch (error) {
      status.textContent = '';
      showError($('#adminPanel'), error);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  };
  rows.onclick = (event) => {
    const remove = event.target.closest('.remove-space');
    if (remove && can('spaces.delete')) remove.closest('.space-admin-row').remove();
  };
  let dragged = null;
  rows.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.space-drag-handle');
    if (!handle || !can('spaces.edit')) { event.preventDefault(); return; }
    dragged = handle.closest('.space-admin-row');
    dragged.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'space');
  });
  rows.addEventListener('dragover', (event) => {
    const target = event.target.closest('.space-admin-row');
    if (!target || !dragged || target === dragged) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    rows.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
  });
  rows.addEventListener('drop', (event) => { if (dragged) event.preventDefault(); });
  rows.addEventListener('dragend', () => {
    if (dragged) dragged.classList.remove('dragging');
    dragged = null;
  });
  $('#saveSpaces', root).onclick = async () => {
    try {
      const spaces = $$('.space-admin-row', root).map((row) => {
        if ($('[data-space-mode]', row).value === 'image' && !$('[data-field=logo]', row).value)
          throw validationError(t('Sube una imagen para cada espacio configurado en modo imagen.', 'Upload an image for each space set to image mode.'));
        return {
          slug: $('[data-field=slug]', row).value.trim(),
          name: $('[data-field=name]', row).value.trim(),
          icon: $('[data-field=icon]', row).value.trim(),
          logo: $('[data-field=logo]', row).value.trim(),
        };
      });
      await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          name: config.site.name,
          pageTitle: config.site.pageTitle || config.site.name,
          logo: config.site.logo || '',
          favicon: config.site.favicon || '/assets/favicon.svg',
          supportUrl: config.site.supportUrl || '',
          sidebarLabel: config.site.sidebarLabel || 'Documentation',
          spaces,
        }),
      });
      state.config = await api('/api/config');
      renderSpaces();
      updateBrand();
      await notify({ icon: 'success', title: t('Espacios guardados', 'Documentation spaces saved'), confirmButtonText: t('Entendido', 'Got it') });
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
}

function languageRow(item, isNew) {
  const code = String(item.code || ''),
    primary = ['en', 'es'].includes(code.toLowerCase()),
    canEdit = can('languages.edit'),
    canDelete = can('languages.delete');
  return (
    '<div class="language-admin-row" data-original-code="' +
    esc(isNew ? '' : code) +
    '"><label><span class="admin-label">' +
    t('Código', 'Code') +
    '</span><input class="settings-input" data-language-code maxlength="24" placeholder="NS" value="' +
    esc(code) +
    '" ' +
    (primary ? 'readonly' : '') +
    '></label><label><span class="admin-label">' +
    t('Nombre completo', 'Full name') +
    '</span><input class="settings-input" data-language-name maxlength="80" placeholder="Español" value="' +
    esc(item.name || '') +
    '"></label><div class="language-enabled-wrap"><span class="admin-label">' +
    t('Activo', 'Enabled') +
    '</span><label class="language-switch"><input type="checkbox" data-language-enabled ' +
    (item.enabled ? 'checked ' : '') +
    (primary || (!canEdit && !(isNew && can('languages.create'))) ? 'disabled' : '') +
    '><span class="language-switch-track"></span></label></div><div class="language-actions"><button type="button" class="icon-button edit-language" data-code="' +
    esc(code) +
    '" title="' +
    (primary
      ? t('Idioma principal protegido', 'Primary language is protected')
      : t('Editar traducciones', 'Edit translations')) +
    '" ' +
    (primary || isNew || !canEdit ? 'disabled' : '') +
    '><i class="fa-solid ' +
    (primary ? 'fa-lock' : 'fa-pen') +
    '"></i></button>' +
    (primary || !canDelete
      ? '<span class="language-required-mark" title="' +
        t('Idioma principal obligatorio', 'Primary language cannot be removed') +
        '"><i class="fa-solid fa-lock"></i></span>'
      : '<button type="button" class="icon-button remove-language" title="' +
        t('Quitar idioma', 'Remove language') +
        '"><i class="fa-solid fa-trash"></i></button>') +
    '</div></div>'
  );
}
async function languagesTab(root) {
  const config = state.config;
  root.innerHTML = `<section class="admin-section languages-admin-section"><h2>${t('Idiomas', 'Languages')}</h2><p>${t('Administra los idiomas disponibles y edita sus traducciones de interfaz. Los idiomas inglés y español son principales y no se pueden editar.', 'Manage available languages and edit their interface translations. English and Spanish are primary languages and cannot be edited.')}</p><div id="languageRows">${(config.languageCatalog || []).map((item) => languageRow(item, false)).join('')}</div><div class="language-admin-actions"><button class="secondary-button" id="addLanguage"><i class="fa-solid fa-plus"></i> ${t('Añadir idioma', 'Add language')}</button><button class="primary-button" id="saveLanguages"><i class="fa-solid fa-floppy-disk"></i> ${t('Guardar idiomas', 'Save languages')}</button></div></section>`;
  $('#addLanguage', root).hidden = !can('languages.create');
  $('#saveLanguages', root).hidden = !canAny(['languages.create', 'languages.edit', 'languages.delete']);
  if (!can('languages.edit'))
    $$('.language-admin-row', root).forEach((row) => {
      if (row.dataset.originalCode) {
        $('[data-language-code]', row).disabled = true;
        $('[data-language-name]', row).disabled = true;
      }
    });
  $('#addLanguage', root).onclick = () =>
    $('#languageRows', root).insertAdjacentHTML(
      'beforeend',
      languageRow({ code: '', name: '', enabled: false }, true),
    );
  $('#languageRows', root).onclick = async (event) => {
    const remove = event.target.closest('.remove-language');
    if (remove) {
      remove.closest('.language-admin-row').remove();
      return;
    }
    const edit = event.target.closest('.edit-language');
    if (edit && !edit.disabled) await editLanguageTranslations(edit.dataset.code);
  };
  $('#saveLanguages', root).onclick = async () => {
    try {
      const languages = $$('.language-admin-row', root).map((row) => ({
        code: $('[data-language-code]', row).value.trim(),
        name: $('[data-language-name]', row).value.trim(),
        enabled: $('[data-language-enabled]', row).checked,
        previousCode: row.dataset.originalCode || '',
      }));
      if (languages.some((item) => !item.code || !item.name))
        throw validationError(
          t(
            'Completa el código y el nombre de cada idioma.',
            'Enter a code and full name for every language.',
          ),
        );
      await api('/api/admin/languages', { method: 'PUT', body: JSON.stringify({ languages }) });
      state.config = await api('/api/config');
      if (!state.config.languages.includes(state.lang)) {
        state.lang = state.config.languages.includes('en') ? 'en' : 'es';
        localStorage.setItem('wiki-language', state.lang);
        await loadTranslations(state.lang);
      }
      renderLanguageMenu();
      updateBrand();
      await adminView('languages');
      await notify({
        icon: 'success',
        title: t('Idiomas guardados.', 'Languages saved.'),
        confirmButtonText: t('Entendido', 'Got it'),
      });
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
}
async function editLanguageTranslations(code) {
  try {
    const result = await api('/api/admin/languages/' + encodeURIComponent(code) + '/translations');
    const entries = Object.entries(result.translations);
    const html =
      '<div class="language-translation-editor">' +
      entries
        .map(
          ([key, value], index) =>
            '<label class="language-translation-field"><span>' +
            esc(key) +
            '</span><textarea data-translation-index="' +
            index +
            '" rows="' +
            (value.length > 140 ? 4 : 2) +
            '" maxlength="12000">' +
            esc(value) +
            '</textarea></label>',
        )
        .join('') +
      '</div>';
    const choice = await Swal.fire({
      title: t('Editar traducciones', 'Edit translations') + ' · ' + esc(code),
      html,
      width: 'min(1000px, calc(100vw - 32px))',
      showCancelButton: true,
      buttonsStyling: false,
      customClass: {
        popup: 'wiki-swal-popup language-editor-popup',
        title: 'wiki-swal-title',
        htmlContainer: 'wiki-swal-body language-editor-body',
        confirmButton: 'primary-button',
        cancelButton: 'secondary-button',
      },
      confirmButtonText: t('Guardar traducciones', 'Save translations'),
      cancelButtonText: t('Cancelar', 'Cancel'),
      preConfirm: () => {
        const translations = {};
        $$('[data-translation-index]', Swal.getHtmlContainer()).forEach(
          (input) => (translations[entries[Number(input.dataset.translationIndex)][0]] = input.value),
        );
        return translations;
      },
    });
    if (!choice.isConfirmed) return;
    await api('/api/admin/languages/' + encodeURIComponent(code) + '/translations', {
      method: 'PUT',
      body: JSON.stringify({ translations: choice.value }),
    });
    if (code.toLowerCase() === String(state.lang).toLowerCase()) await loadTranslations(state.lang);
    await notify({
      icon: 'success',
      title: t('Traducciones guardadas', 'Translations saved'),
      text: t('El archivo JSON del idioma se actualizó.', 'The language JSON file was updated.'),
      confirmButtonText: t('Entendido', 'Got it'),
    });
    if (code.toLowerCase() === String(state.lang).toLowerCase()) await adminView('languages');
  } catch (error) {
    showError($('#adminPanel'), error);
  }
}
function spaceLogoStatusMarkup(url) {
  const value = String(url || '');
  if (!/^\/media\/[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/.test(value))
    return (
      '<small class="space-logo-status">' +
      esc(t('Icono si no hay imagen', 'Icon used when no image')) +
      '</small>'
    );
  return (
    '<small class="space-logo-status"><img class="space-logo-preview" src="' +
    esc(value) +
    '" alt=""><a href="' +
    esc(value) +
    '" target="_blank" rel="noopener noreferrer">' +
    esc(value) +
    '</a></small>'
  );
}
function setSpaceLogoStatus(row, url) {
  const status = $('.space-logo-status', row);
  if (!status) return;
  const replacement = document.createElement('small');
  replacement.className = 'space-logo-status';
  if (/^\/media\/[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp)$/.test(url || '')) {
    const image = document.createElement('img');
    image.className = 'space-logo-preview';
    image.src = url;
    image.alt = '';
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    replacement.append(image, link);
  } else replacement.textContent = url || t('Icono si no hay imagen', 'Icon used when no image');
  status.replaceWith(replacement);
}
function spaceRow(sp) {
  const imageMode = Boolean(sp.logo);
  return `<div class="space-admin-row" draggable="true"><button type="button" class="drag-handle space-drag-handle" draggable="true" aria-label="${t('Arrastrar espacio', 'Drag space')}" title="${t('Arrastrar para ordenar', 'Drag to reorder')}"><i class="fa-solid fa-grip-vertical"></i></button><label><span class="sr-only">URL</span><input class="settings-input" data-field="slug" placeholder="slug (ThJumpPads)" value="${esc(sp.slug)}"></label><label><span class="sr-only">${t('Nombre', 'Name')}</span><input class="settings-input" data-field="name" placeholder="${t('Nombre', 'Name')}" value="${esc(sp.name)}"></label><label><span class="admin-label">${t('Tipo de marca', 'Brand type')}</span><select class="settings-input" data-space-mode><option value="icon" ${imageMode ? '' : 'selected'}>${t('Insertar un ícono', 'Insert an icon')}</option><option value="image" ${imageMode ? 'selected' : ''}>${t('Subir una imagen', 'Upload an image')}</option></select></label><label class="space-icon-field" ${imageMode ? 'hidden' : ''}><span class="admin-label">${t('Ícono Font Awesome', 'Font Awesome icon')}</span><input class="settings-input" data-field="icon" placeholder="fa-solid fa-book-open" value="${esc(sp.icon || 'fa-solid fa-book-open')}"></label><label class="space-logo-upload" ${imageMode ? '' : 'hidden'}><span class="sr-only">${t('Logotipo del espacio', 'Space logo')}</span><input class="space-logo-hidden" data-field="logo" type="hidden" value="${esc(sp.logo || '')}" ${imageMode ? '' : 'disabled'}><input class="space-logo-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="${t('Subir logotipo del espacio', 'Upload space logo')}" ${imageMode ? '' : 'disabled'}>${spaceLogoStatusMarkup(sp.logo)}</label><button class="icon-button remove-space" type="button" title="${t('Quitar', 'Remove')}"><i class="fa-solid fa-trash"></i></button></div>`;
}
function registeredUserRow(user, roles) {
  const primary = Boolean(user.isPrimaryAdmin),
    role = roles.find((item) => item.roleKey === user.role),
    verified = Boolean(user.verified_at);
  return `<div class="user-row"><div class="user-identity"><div class="user-heading"><strong>${esc(user.username)}</strong><span class="role-badge" style="--role-color:${esc(role?.color || '#64748b')}">${esc(role?.name || user.role)}</span></div><div class="sidebar-version">${esc(user.email)}</div></div><span class="user-verification-badge ${verified ? 'is-verified' : 'is-pending'}">${verified ? t('Verificado', 'Verified') : t('Pendiente', 'Pending')}</span>${can('users.role') ? `<select class="settings-input role-select" data-id="${user.id}" ${primary || !verified ? 'disabled' : ''}>${roles.map((item) => `<option value="${esc(item.roleKey)}" ${item.roleKey === user.role ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>` : ''}${can('users.reset_password') ? `<button type="button" class="secondary-button reset-user-password" data-id="${user.id}" title="${t('Restablecer contraseña', 'Reset password')}" ${primary ? 'disabled' : ''}><i class="fa-solid fa-key"></i></button>` : ''}${can('users.delete') ? `<button type="button" class="danger-button delete-user" data-id="${user.id}" title="${t('Eliminar cuenta', 'Delete account')}" ${primary ? 'disabled' : ''}><i class="fa-solid fa-trash"></i></button>` : ''}</div>`;
}
async function usersTab(root) {
  const enabled = Boolean(state.config.registrationEnabled),
    canList = canAny(['users.edit', 'users.delete', 'users.reset_password', 'users.role']);
  let users = [],
    roles = [];
  if (canList) {
    const result = await api('/api/admin/users');
    users = result.users;
    roles = result.roles;
  }
  const registrationSection = can('users.registration')
    ? `<section class="admin-section"><h2>${t('Registro de usuarios', 'User registration')}</h2><p>${t('Permite que las personas creen una cuenta desde la página de registro.', 'Allow people to create an account from the registration page.')}</p><label class="category-open-default"><input id="registrationEnabled" type="checkbox" ${enabled ? 'checked' : ''}> ${t('Permitir registros públicos', 'Allow public registration')}</label><button class="primary-button" id="saveRegistration">${t('Guardar configuración', 'Save setting')}</button></section>`
    : '';
  const userRows = canList
    ? `<section class="admin-section"><h2>${t('Usuarios registrados', 'Registered users')}</h2><p>${t('Administra roles y cuentas de usuarios.', 'Manage user roles and accounts.')}</p>${
        users.length
          ? users.map((user) => registeredUserRow(user, roles)).join('')
          : '<div class="empty-state">' + t('No hay usuarios.', 'No users yet.') + '</div>'
      }<nav class="user-pagination" aria-label="${t('Páginas de usuarios', 'User pages')}"></nav></section>`
    : '';
  root.innerHTML = registrationSection + userRows;
  if (canList && users.length) {
    const rows = $$('.user-row', root), pager = $('.user-pagination', root),
      total = Math.ceil(rows.length / 15);
    let current = Math.min(Math.max(1, state.userPage || 1), total);
    const renderPager = () => {
      state.userPage = current;
      rows.forEach((row, index) => { row.hidden = Math.floor(index / 15) !== current - 1; });
      const numbers = [...new Set([1, 2, 3, current - 1, current, current + 1, total - 2, total - 1, total]
        .filter((number) => number >= 1 && number <= total))].sort((a, b) => a - b);
      const control = (label, target, disabled) => `<button type="button" class="secondary-button" data-user-page="${target}" ${disabled ? 'disabled' : ''}>${label}</button>`;
      pager.innerHTML = control(t('Inicio', 'Start'), 1, current === 1) +
        control(t('Anterior', 'Previous'), current - 1, current === 1) +
        numbers.map((number, index) => (index && number > numbers[index - 1] + 1 ? '<span aria-hidden="true">…</span>' : '') +
          `<button type="button" class="secondary-button${number === current ? ' active' : ''}" data-user-page="${number}"${number === current ? ' aria-current="page"' : ''}>${number}</button>`).join('') +
        control(t('Siguiente', 'Next'), current + 1, current === total) +
        control(t('Fin', 'End'), total, current === total);
    };
    pager.onclick = (event) => {
      const button = event.target.closest('[data-user-page]');
      if (!button || button.disabled) return;
      current = Number(button.dataset.userPage);
      renderPager();
    };
    renderPager();
  }
  if (can('users.registration'))
    $('#saveRegistration', root).onclick = async () => {
      try {
        const result = await api('/api/admin/settings/registration', {
          method: 'PUT',
          body: JSON.stringify({ enabled: $('#registrationEnabled', root).checked }),
        });
        state.config.registrationEnabled = result.registrationEnabled;
        await notify({
          icon: 'success',
          title: t('Configuración guardada', 'Settings saved'),
          confirmButtonText: t('Entendido', 'Got it'),
        });
      } catch (error) {
        showError($('#adminPanel'), error);
      }
    };
  $$('.role-select', root).forEach(
    (select) =>
      (select.onchange = async () => {
        const selectedRole = select.value,
          isSelf = Number(select.dataset.id) === Number(state.user.id);
        try {
          const updated = await api(`/api/admin/users/${select.dataset.id}/role`, {
            method: 'PATCH',
            body: JSON.stringify({ roleKey: selectedRole }),
          });
          if (isSelf) {
            state.user = updated.user;
            state.csrf = updated.csrfToken;
            setAuthLink();
          }
          await notify({
            icon: 'success',
            title: t('Rol actualizado', 'Role updated'),
            confirmButtonText: t('Entendido', 'Got it'),
          });
          if (
            isSelf &&
            !canAny([
              'pages.create_edit',
              'pages.delete',
              'categories.create_edit',
              'categories.delete',
              'settings.identity',
              'settings.support',
              'settings.seo',
              'settings.sidebar_label',
              'languages.create',
              'languages.edit',
              'languages.delete',
              'spaces.create',
              'spaces.edit',
              'spaces.delete',
              'users.registration',
              'users.edit',
              'users.delete',
              'users.role',
              'users.reset_password',
              'reverse_proxy.configure',
              'smtp.configure',
              'roles.manage',
              'backups.import',
              'backups.export',
              'backups.schedule',
              'captcha.configure',
              'updates.install',
              'header_links.create_edit',
              'header_links.delete',
            ])
          )
            location.assign('/');
          else await adminView('users');
        } catch (error) {
          showError($('#adminPanel'), error);
        }
      }),
  );
  $$('.delete-user', root).forEach(
    (button) =>
      (button.onclick = async () => {
        const user = users.find((item) => String(item.id) === button.dataset.id),
          choice = await Swal.fire({
            icon: 'warning',
            title: t('¿Eliminar esta cuenta permanentemente?', 'Permanently delete this account?'),
            text: t(
              'Se eliminarán la cuenta y sus sesiones. Esta acción no se puede deshacer.',
              'The account and its sessions will be deleted. This action cannot be undone.',
            ),
            showCancelButton: true,
            confirmButtonText: t('Eliminar cuenta', 'Delete account'),
            cancelButtonText: t('Cancelar', 'Cancel'),
            reverseButtons: true,
          });
        if (!choice.isConfirmed) return;
        try {
          await api(`/api/admin/users/${button.dataset.id}`, { method: 'DELETE' });
          await notify({
            icon: 'success',
            title: t('Cuenta eliminada', 'Account deleted'),
            text: user?.username || '',
            confirmButtonText: t('Entendido', 'Got it'),
          });
          if (Number(button.dataset.id) === Number(state.user.id)) {
            state.user = null;
            state.csrf = '';
            location.assign('/');
          } else await adminView('users');
        } catch (error) {
          showError($('#adminPanel'), error);
        }
      }),
  );
  $$('.reset-user-password', root).forEach(
    (button) =>
      (button.onclick = async () => {
        const user = users.find((item) => String(item.id) === button.dataset.id),
          choice = await Swal.fire({
            icon: 'warning',
            title: t('¿Enviar contraseña temporal?', 'Send a temporary password?'),
            text:
              t(
                'Se enviará una contraseña temporal al correo de esta cuenta y será válida durante una hora.',
                'A temporary password will be sent to this account email and will be valid for one hour.',
              ) +
              ' ' +
              esc(user?.email || ''),
            showCancelButton: true,
            confirmButtonText: t('Enviar contraseña', 'Send password'),
            cancelButtonText: t('Cancelar', 'Cancel'),
            reverseButtons: true,
          });
        if (!choice.isConfirmed) return;
        try {
          await api(`/api/admin/users/${button.dataset.id}/reset-password`, { method: 'POST', body: '{}' });
          await notify({
            icon: 'success',
            title: t('Correo de restablecimiento en cola', 'Reset email queued'),
            text: t(
              'Se enviará la contraseña temporal al usuario; deberá cambiarla al iniciar sesión.',
              'The temporary password email is queued; the user must change it after signing in.',
            ),
            confirmButtonText: t('Entendido', 'Got it'),
          });
        } catch (error) {
          showError($('#adminPanel'), error);
        }
      }),
  );
}
const ROLE_PERMISSION_GROUPS = [
  [
    'pages',
    'Sección de páginas wiki',
    'Wiki page section',
    [
      ['pages.create_edit', 'Crear y editar páginas', 'Create and edit pages'],
      ['pages.delete', 'Eliminar páginas', 'Delete pages'],
    ],
  ],
  [
    'categories',
    'Sección de categorías',
    'Categories section',
    [
      ['categories.create_edit', 'Crear y editar categorías', 'Create and edit categories'],
      ['categories.delete', 'Eliminar categorías', 'Delete categories'],
    ],
  ],
  [
    'header-links',
    'Enlaces del encabezado',
    'Header Links',
    [
      ['header_links.create_edit', 'Crear y editar enlaces del encabezado', 'Create and edit header links'],
      ['header_links.delete', 'Eliminar enlaces del encabezado', 'Delete header links'],
    ],
  ],
  [
    'settings',
    'Ajustes generales',
    'General settings',
    [
      ['settings.identity', 'Cambiar nombre, logotipo y favicon', 'Change site name, logo, and favicon'],
      ['settings.support', 'Cambiar el bloque de soporte', 'Change support card'],
      ['settings.seo', 'Cambiar ajustes de SEO', 'Change SEO settings'],
      ['settings.sidebar_label', 'Cambiar contenido del pie de página', 'Change footer content'],
      ['spaces.create', 'Crear espacios de documentación', 'Create documentation spaces'],
      ['spaces.edit', 'Editar espacios de documentación', 'Edit documentation spaces'],
      ['spaces.delete', 'Eliminar espacios de documentación', 'Delete documentation spaces'],
    ],
  ],
  [
    'languages',
    'Idiomas',
    'Languages',
    [
      ['languages.create', 'Crear idiomas', 'Create languages'],
      ['languages.edit', 'Editar idiomas', 'Edit languages'],
      ['languages.delete', 'Eliminar idiomas', 'Delete languages'],
    ],
  ],
  [
    'users',
    'Usuarios',
    'Users',
    [
      ['users.registration', 'Cambiar el registro de usuarios', 'Change user registration'],
      ['users.edit', 'Ver usuarios registrados', 'View registered users'],
      ['users.delete', 'Eliminar cuentas', 'Delete accounts'],
      ['users.role', 'Cambiar roles de usuario', 'Change user roles'],
      ['users.reset_password', 'Restablecer contraseñas', 'Reset passwords'],
    ],
  ],
  [
    'proxy',
    'Proxy inverso',
    'Reverse Proxy',
    [['reverse_proxy.configure', 'Configurar Reverse Proxy', 'Configure Reverse Proxy']],
  ],
  [
    'roles',
    'Roles',
    'Roles',
    [['roles.manage', 'Crear, editar y eliminar roles', 'Create, edit, and delete roles']],
  ],
  [
    'captcha',
    'Protección de Captcha',
    'Captcha protection',
    [['captcha.configure', 'Configurar Captcha', 'Configure Captcha']],
  ],
  [
    'backups',
    'Copias de seguridad',
    'Backups',
    [
      ['backups.import', 'Importar backup', 'Import backups'],
      ['backups.export', 'Exportar backups', 'Export backups'],
      ['backups.schedule', 'Editar CRON y retención', 'Edit backup schedule and retention'],
    ],
  ],
  [
    'updates',
    'Actualizaciones',
    'Updates',
    [['updates.install', 'Instalar paquetes de actualización', 'Install update packages']],
  ],
];
async function headerLinksTab(root) {
  const canEdit = can('header_links.create_edit'),
    canDelete = can('header_links.delete'),
    result = await api('/api/admin/header-links');
  let links = Array.isArray(result.links) ? result.links : [],
    editingId = null,
    titles = {};
  root.innerHTML = `<section class="admin-section header-links-admin"><div class="section-heading"><div><h2>${t('Enlaces del encabezado', 'Header Links')}</h2><p>${t('Añade hasta cinco enlaces internos o externos. Los títulos se pueden traducir por idioma.', 'Add up to five internal or external links. Titles can be translated per language.')}</p></div><span class="header-link-count" id="headerLinkCount"></span></div><div class="header-link-list" id="headerLinkRows"></div></section>${canEdit ? `<section class="admin-section header-link-editor"><h2 id="headerLinkFormHeading">${t('Añadir enlace', 'Add link')}</h2><form id="headerLinkForm"><div class="header-link-form-grid"><label><span class="admin-label">${t('Idioma del título', 'Title language')}</span><select class="settings-input" id="headerLinkLanguage">${state.config.languages.map(code => `<option value="${esc(code)}">${esc(code)}</option>`).join('')}</select></label><label><span class="admin-label">${t('Título', 'Title')}</span><input class="settings-input" id="headerLinkTitle" maxlength="80" required></label><label class="header-link-url-field"><span class="admin-label">${t('URL', 'URL')}</span><input class="settings-input" id="headerLinkUrl" type="text" maxlength="2048" required placeholder="/ruta o https://ejemplo.com"></label><label class="header-link-external"><input id="headerLinkExternal" type="checkbox"><span>${t('Enlace externo', 'External link')}</span></label></div><div class="form-message auth-error" hidden></div><div class="header-link-actions"><button class="primary-button" id="saveHeaderLink" type="submit"><i class="fa-solid fa-plus"></i> ${t('Añadir enlace', 'Add link')}</button><button class="secondary-button" id="cancelHeaderLink" type="button" hidden>${t('Cancelar', 'Cancel')}</button></div></form></section>` : ''}`;
  const rows = $('#headerLinkRows', root);
  const renderRows = () => {
    $('#headerLinkCount', root).textContent = `${links.length}/5`;
    rows.innerHTML = links.length
      ? links
          .map((link) => {
            const title =
              link.titles?.[state.lang] ||
              link.titles?.[state.lang.split('-')[0]] ||
              Object.values(link.titles || {}).find(Boolean) ||
              link.url;
            return `<div class="header-link-row"><div class="header-link-row-main"><strong>${esc(title)}</strong><span>${esc(link.url)}</span><small>${link.external ? t('Externo', 'External') : t('Interno', 'Internal')}</small></div>${canEdit ? `<button type="button" class="secondary-button edit-header-link" data-id="${esc(link.id)}"><i class="fa-solid fa-pen"></i> ${t('Editar', 'Edit')}</button>` : ''}${canDelete ? `<button type="button" class="danger-button delete-header-link" data-id="${esc(link.id)}" aria-label="${t('Eliminar enlace', 'Delete link')}"><i class="fa-solid fa-trash"></i></button>` : ''}</div>`;
          })
          .join('')
      : `<p class="header-links-empty">${t('Todavía no hay enlaces en el encabezado.', 'There are no header links yet.')}</p>`;
  };
  renderRows();
  if (!canEdit) {
    rows.onclick = async (event) => {
      const remove = event.target.closest('.delete-header-link');
      if (!remove) return;
      const answer = await Swal.fire({
        icon: 'warning',
        title: t('¿Eliminar este enlace?', 'Delete this link?'),
        showCancelButton: true,
        confirmButtonText: t('Eliminar', 'Delete'),
        cancelButtonText: t('Cancelar', 'Cancel'),
        reverseButtons: true,
      });
      if (!answer.isConfirmed) return;
      try {
        const updated = await api(`/api/admin/header-links/${encodeURIComponent(remove.dataset.id)}`, { method: 'DELETE' });
        links = updated.links;
        renderRows();
      } catch (error) {
        showError($('#adminPanel'), error);
      }
    };
    return;
  }
  const form = $('#headerLinkForm', root),
    language = $('#headerLinkLanguage', form),
    titleInput = $('#headerLinkTitle', form),
    urlInput = $('#headerLinkUrl', form),
    externalInput = $('#headerLinkExternal', form),
    syncTitle = () => {
      titleInput.value = titles[language.value] || '';
    },
    resetForm = () => {
      editingId = null;
      titles = {};
      form.reset();
      language.value = state.config.languages[0] || 'en';
      titleLanguage = language.value;
      syncTitle();
      $('#headerLinkFormHeading', root).textContent = t('Añadir enlace', 'Add link');
      $('#saveHeaderLink', root).innerHTML = `<i class="fa-solid fa-plus"></i> ${t('Añadir enlace', 'Add link')}`;
      $('#cancelHeaderLink', root).hidden = true;
      $('.form-message', form).hidden = true;
    };
  let titleLanguage = language.value;
  language.onchange = () => {
    titles[titleLanguage] = titleInput.value;
    titleLanguage = language.value;
    syncTitle();
  };
  titleInput.oninput = () => {
    titles[language.value] = titleInput.value;
  };
  $('#cancelHeaderLink', root).onclick = resetForm;
  rows.onclick = async (event) => {
    const edit = event.target.closest('.edit-header-link'),
      remove = event.target.closest('.delete-header-link');
    if (edit) {
      const link = links.find((item) => item.id === edit.dataset.id);
      if (!link) return;
      editingId = link.id;
      titles = { ...link.titles };
      language.value = Object.keys(titles).find((code) => state.config.languages.includes(code)) || state.config.languages[0];
      titleLanguage = language.value;
      syncTitle();
      urlInput.value = link.url;
      externalInput.checked = link.external;
      $('#headerLinkFormHeading', root).textContent = t('Editar enlace', 'Edit link');
      $('#saveHeaderLink', root).innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${t('Guardar cambios', 'Save changes')}`;
      $('#cancelHeaderLink', root).hidden = false;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      titleInput.focus();
      return;
    }
    if (!remove) return;
    const answer = await Swal.fire({
      icon: 'warning',
      title: t('¿Eliminar este enlace?', 'Delete this link?'),
      showCancelButton: true,
      confirmButtonText: t('Eliminar', 'Delete'),
      cancelButtonText: t('Cancelar', 'Cancel'),
      reverseButtons: true,
    });
    if (!answer.isConfirmed) return;
    try {
      const updated = await api(`/api/admin/header-links/${encodeURIComponent(remove.dataset.id)}`, { method: 'DELETE' });
      links = updated.links;
      if (editingId === remove.dataset.id) resetForm();
      renderRows();
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    titles[language.value] = titleInput.value;
    const payload = {
      titles: Object.fromEntries(Object.entries(titles).filter(([, value]) => value.trim())),
      url: urlInput.value,
      external: externalInput.checked,
    };
    try {
      const saved = await api(
        editingId ? `/api/admin/header-links/${encodeURIComponent(editingId)}` : '/api/admin/header-links',
        { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) },
      );
      links = saved.links;
      renderRows();
      resetForm();
    } catch (error) {
      showError(form, error);
    }
  };
}
function roleEditorRow(role, expanded = false) {
  const permissions = Array.isArray(role.permissions) ? role.permissions.filter((permission) => rolePermissionKeys.includes(permission)) : [],
    system = Boolean(role.isSystem),
    rowId = esc(role.roleKey || ''),
    name = esc(role.name || t('Nuevo rol', 'New role')),
    color = /^#[0-9a-fA-F]{6}$/.test(role.color || '') ? role.color : '#64748b';
  const descriptions = {
    pages: t(
      'Permisos para crear, editar y quitar páginas.',
      'Permissions to create, edit, and remove pages.',
    ),
    categories: t(
      'Controla la estructura de navegación de la wiki.',
      'Controls the wiki navigation structure.',
    ),
    settings: t(
      'Identidad, soporte, SEO, pie de página y espacios.',
      'Identity, support, SEO, footer, and documentation spaces.',
    ),
    languages: t('Administración de idiomas y traducciones.', 'Manage languages and translations.'),
    users: t(
      'Registro, cuentas, roles y recuperación de contraseña.',
      'Registration, accounts, roles, and password recovery.',
    ),
    proxy: t(
      'Cabeceras confiables y configuración de proxy inverso.',
      'Trusted headers and reverse proxy configuration.',
    ),
    smtp: t('Acceso a la configuración del servidor de correo.', 'Access to mail server settings.'),
    roles: t('Administración de roles y permisos.', 'Role and permission administration.'),
    backups: t(
      'Importación, exportación y programación de copias.',
      'Backup import, export, and scheduling.',
    ),
    captcha: t('Configuración de Captcha y sus claves.', 'Configure Captcha and its keys.'),
    updates: t(
      'Instala paquetes de actualización firmados.',
      'Install signed update packages.',
    ),
  };
  return `<article class="role-editor-card" data-role-key="${rowId}" data-system="${system}"><div class="role-line"><div class="role-line-identity"><span class="role-badge role-line-badge" style="--role-color:${esc(color)}">${name}</span>${system ? `<span class="role-system-lock"><i class="fa-solid fa-lock"></i> ${t('Rol del sistema', 'System role')}</span>` : ''}</div><div class="role-line-actions"><button type="button" class="secondary-button edit-role" aria-expanded="${expanded}"><i class="fa-solid fa-pen"></i> ${t('Editar', 'Edit')}</button>${system ? '' : `<button type="button" class="danger-button remove-role"><i class="fa-solid fa-trash"></i></button>`}</div></div><div class="role-edit-panel" ${expanded ? '' : 'hidden'}><div class="role-editor-fields"><label><span class="admin-label">${t('Nombre del rol', 'Role name')}</span><input class="settings-input" data-role-name maxlength="80" value="${esc(role.name || '')}" ${system ? 'readonly' : ''}></label><label><span class="admin-label">${t('Color del badge', 'Badge color')}</span><input type="color" data-role-color value="${esc(color)}" ${system ? 'disabled' : ''}></label><span class="role-badge role-preview" style="--role-color:${esc(color)}">${name}</span></div><label class="role-permission-all"><input type="checkbox" data-permission-all ${permissions.length === rolePermissionKeys.length ? 'checked' : ''} ${system ? 'disabled' : ''}><strong>${t('Todos los permisos', 'All permissions')}</strong></label><label class="role-permission-admin-view"><input type="checkbox" data-permission="admin.view" ${permissions.includes('admin.view') ? 'checked' : ''} ${system ? 'disabled' : ''}><span><strong>${t('Ver panel de administrador', 'View administrator panel')}</strong><small>${t('Mostrar el engranaje y permitir el acceso al panel.', 'Show the gear and allow access to the admin panel.')}</small></span></label><div class="role-permissions">${ROLE_PERMISSION_GROUPS.map(
    ([key, es, en, items]) => {
      const checked = items.every(([permission]) => permissions.includes(permission));
      return `<fieldset class="role-permission-group"><legend><label><input type="checkbox" data-permission-group="${key}" ${checked ? 'checked' : ''} ${system ? 'disabled' : ''}> ${t(es, en)}</label></legend><p class="role-permission-description">${descriptions[key] || ''}</p>${items.map(([permission, labelEn, labelEs]) => `<label class="role-permission-item"><input type="checkbox" data-permission="${permission}" ${permissions.includes(permission) ? 'checked' : ''} ${system ? 'disabled' : ''}><span>${t(labelEn, labelEs)}</span></label>`).join('')}</fieldset>`;
    },
  ).join('')}</div></div></article>`;
}
async function rolesTab(root) {
  const result = await api('/api/admin/roles');
  const roles = result.roles;
  root.innerHTML = `<section class="admin-section roles-intro"><h2>${t('Roles y permisos', 'Roles and permissions')}</h2><p>${t('Cada rol ocupa una fila. Edita sus permisos por secciones y configura el color de su badge. Administrator conserva todos los permisos.', 'Roles appear in a compact list. Edit permissions by section and set the badge color. Administrator keeps every permission.')}</p><p>${t('SMTP solo está disponible para la cuenta administradora principal y no puede concederse mediante roles.', 'SMTP is available only to the primary administrator and cannot be granted through roles.')}</p><div id="roleRows" class="role-list">${roles.map((role) => roleEditorRow(role)).join('')}</div><div class="role-actions"><button type="button" class="secondary-button" id="addRole"><i class="fa-solid fa-plus"></i> ${t('Añadir rol', 'Add role')}</button><button type="button" class="primary-button" id="saveRoles"><i class="fa-solid fa-floppy-disk"></i> ${t('Guardar roles', 'Save roles')}</button></div></section>`;
  const rows = $('#roleRows', root);
  $('#addRole', root).onclick = () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = roleEditorRow(
      { roleKey: '', name: '', color: '#64748b', permissions: [], isSystem: false },
      true,
    );
    const card = wrapper.firstElementChild;
    rows.append(card);
    $('[data-role-name]', card).focus();
  };
  rows.onclick = async (event) => {
    const edit = event.target.closest('.edit-role');
    if (edit) {
      const panel = $('.role-edit-panel', edit.closest('.role-editor-card'));
      panel.hidden = !panel.hidden;
      edit.setAttribute('aria-expanded', String(!panel.hidden));
      return;
    }
    const remove = event.target.closest('.remove-role');
    if (!remove) return;
    const choice = await Swal.fire({
      icon: 'warning',
      title: t('¿Quitar este rol?', 'Remove this role?'),
      text: t(
        'El cambio se aplicará al guardar los roles.',
        'This change will take effect when you save the roles.',
      ),
      showCancelButton: true,
      confirmButtonText: t('Eliminar', 'Delete'),
      cancelButtonText: t('Cancelar', 'Cancel'),
      reverseButtons: true,
    });
    if (choice.isConfirmed) remove.closest('.role-editor-card').remove();
  };
  rows.addEventListener('change', (event) => {
    const card = event.target.closest('.role-editor-card');
    if (!card || card.dataset.system === 'true') return;
    if (event.target.matches('[data-permission-all]')) {
      $$('[data-permission]', card).forEach((input) => (input.checked = event.target.checked));
      ROLE_PERMISSION_GROUPS.forEach((group) => {
        const groupInput = $(`[data-permission-group="${group[0]}"]`, card);
        if (groupInput) groupInput.checked = event.target.checked;
      });
    }
    if (event.target.matches('[data-permission-group]')) {
      const group = ROLE_PERMISSION_GROUPS.find((item) => item[0] === event.target.dataset.permissionGroup);
      if (group)
        group[3].forEach(([permission]) => {
          const input = $(`[data-permission="${permission}"]`, card);
          if (input) input.checked = event.target.checked;
        });
      const all = $('[data-permission-all]', card);
      if (all) all.checked = $$('[data-permission]', card).every((input) => input.checked);
    }
    if (event.target.matches('[data-permission]')) {
      const group = ROLE_PERMISSION_GROUPS.find((item) =>
        item[3].some((permission) => permission[0] === event.target.dataset.permission),
      );
      if (group) {
        const checks = group[3].map(([permission]) => $(`[data-permission="${permission}"]`, card));
        const groupInput = $(`[data-permission-group="${group[0]}"]`, card);
        if (groupInput) groupInput.checked = checks.every((input) => input.checked);
      }
      const all = $('[data-permission-all]', card);
      if (all) all.checked = $$('[data-permission]', card).every((input) => input.checked);
    }
  });
  rows.addEventListener('input', (event) => {
    const card = event.target.closest('.role-editor-card');
    if (!card) return;
    if (event.target.matches('[data-role-name]')) {
      const value = event.target.value || t('Nuevo rol', 'New role');
      $('.role-line-badge', card).textContent = value;
      $('.role-preview', card).textContent = value;
    }
    if (event.target.matches('[data-role-color]')) {
      const value = event.target.value;
      $('.role-line-badge', card).style.setProperty('--role-color', value);
      $('.role-preview', card).style.setProperty('--role-color', value);
    }
  });
  $('#saveRoles', root).onclick = async () => {
    try {
      const payload = [...$$('.role-editor-card', rows)].map((card) => ({
        roleKey: card.dataset.roleKey,
        name: $('[data-role-name]', card).value.trim(),
        color: $('[data-role-color]', card).value,
        permissions: [
          ...$$('[data-permission]:checked', card).map((input) => input.dataset.permission),
          ...(roles.find((role) => role.roleKey === card.dataset.roleKey)?.permissions?.includes('smtp.configure')
            ? ['smtp.configure'] : []),
        ],
        isSystem: card.dataset.system === 'true',
      }));
      if (payload.some((role) => !role.name))
        throw validationError(t('Cada rol debe tener un nombre.', 'Every role needs a name.'));
      await api('/api/admin/roles', { method: 'PUT', body: JSON.stringify({ roles: payload }) });
      await notify({
        icon: 'success',
        title: t('Roles guardados', 'Roles saved'),
        confirmButtonText: t('Entendido', 'Got it'),
      });
      await adminView('roles');
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
}
async function captchaTab(root) {
  const result = await api('/api/admin/captcha'),
    cfg = result.captcha;
  const variants = {
    hcaptcha: [
      ['checkbox', t('Casilla de verificación', 'Checkbox')],
      ['invisible', t('Invisible', 'Invisible')],
    ],
    recaptcha: [
      ['v2_checkbox', 'reCAPTCHA v2: casilla', 'reCAPTCHA v2: checkbox'],
      ['v2_invisible', 'reCAPTCHA v2: invisible', 'reCAPTCHA v2: invisible'],
      ['v3', 'reCAPTCHA v3', 'reCAPTCHA v3'],
    ],
    turnstile: [['managed', t('Administrado por Cloudflare', 'Cloudflare managed')]],
  };
  const providerOptions = [
    ['hcaptcha', 'hCaptcha'],
    ['recaptcha', 'Google reCAPTCHA'],
    ['turnstile', 'Cloudflare Turnstile'],
  ]
    .map(
      ([value, label]) =>
        '<option value="' +
        value +
        '" ' +
        (cfg.provider === value ? 'selected' : '') +
        '>' +
        label +
        '</option>',
    )
    .join('');
  root.innerHTML =
    '<section class="admin-section captcha-settings"><h2>Captcha</h2><p>' +
    t(
      'Protege el inicio de sesión, registro y formularios de contraseña con verificación en el servidor.',
      'Protect sign-in, registration, and password forms with server-side verification.',
    ) +
    '</p><label class="captcha-enable"><input id="captchaEnabled" type="checkbox" ' +
    (cfg.enabled ? 'checked' : '') +
    '> ' +
    t('Habilitar Captcha', 'Enable Captcha') +
    '</label><div class="captcha-config-grid"><label><span class="admin-label">' +
    t('Proveedor', 'Provider') +
    '</span><select class="settings-input" id="captchaProvider">' +
    providerOptions +
    '</select></label><label><span class="admin-label">' +
    t('Versión o tipo', 'Version or type') +
    '</span><select class="settings-input" id="captchaVariant"></select></label><label><span class="admin-label">' +
    t('Clave del sitio', 'Site key') +
    '</span><input class="settings-input" id="captchaSiteKey" autocomplete="off" maxlength="512" value="' +
    esc(cfg.siteKey || '') +
    '"></label><label><span class="admin-label">' +
    t('Clave secreta', 'Secret key') +
    '</span><input class="settings-input" id="captchaSecret" type="password" autocomplete="new-password" maxlength="2048" placeholder="' +
    (cfg.secretConfigured
      ? t('Guardada; déjala vacía para conservarla', 'Saved; leave blank to keep it')
      : t('Pega la clave secreta', 'Enter the secret key')) +
    '"></label><label id="captchaScoreWrap"><span class="admin-label">' +
    t('Puntuación mínima de reCAPTCHA v3', 'reCAPTCHA v3 minimum score') +
    '</span><input class="settings-input" id="captchaScore" type="number" min="0.1" max="0.9" step="0.1" value="' +
    Number(cfg.minScore || 0.5) +
    '"></label><label class="captcha-clear-secret"><input id="captchaClearSecret" type="checkbox"> ' +
    t('Eliminar la clave secreta guardada', 'Clear saved secret key') +
    '</label></div><div class="admin-actions"><button class="primary-button" id="saveCaptcha">' +
    t('Guardar configuración', 'Save configuration') +
    '</button></div></section>';
  const captchaGrid = $('.captcha-config-grid', root),
    captchaProviderFields = document.createElement('div'),
    captchaKeyFields = document.createElement('div');
  captchaProviderFields.className = captchaKeyFields.className = 'captcha-config-grid';
  captchaProviderFields.append($('#captchaProvider', root).closest('label'), $('#captchaVariant', root).closest('label'),
    $('#captchaScoreWrap', root));
  captchaKeyFields.append($('#captchaSiteKey', root).closest('label'), $('#captchaSecret', root).closest('label'),
    $('.captcha-clear-secret', root));
  captchaGrid.replaceWith(
    settingsGroup(t('Proveedor y tipo', 'Provider and type'), captchaProviderFields),
    settingsGroup(t('Claves', 'Keys'), captchaKeyFields),
  );
  const provider = $('#captchaProvider', root),
    variant = $('#captchaVariant', root),
    scoreWrap = $('#captchaScoreWrap', root);
  const refreshVariants = () => {
    const items = variants[provider.value] || [];
    variant.innerHTML = items
      .map(
        (item) =>
          '<option value="' +
          item[0] +
          '">' +
          (item[1] && item[2] ? t(item[1], item[2]) : item[1]) +
          '</option>',
      )
      .join('');
    if (items.some((item) => item[0] === cfg.variant)) variant.value = cfg.variant;
    scoreWrap.hidden = provider.value !== 'recaptcha' || variant.value !== 'v3';
  };
  provider.onchange = refreshVariants;
  variant.onchange = () => (scoreWrap.hidden = provider.value !== 'recaptcha' || variant.value !== 'v3');
  refreshVariants();
  $('#saveCaptcha', root).onclick = async () => {
    const button = $('#saveCaptcha', root),
      stop = beginButtonLoading(button);
    try {
      const saved = await api('/api/admin/captcha', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: $('#captchaEnabled', root).checked,
          provider: provider.value,
          variant: variant.value,
          siteKey: $('#captchaSiteKey', root).value.trim(),
          secret: $('#captchaSecret', root).value,
          clearSecret: $('#captchaClearSecret', root).checked,
          minScore: Number($('#captchaScore', root).value),
        }),
      });
      state.config.captcha = saved.captcha;
      await notify({
        icon: 'success',
        title: t('Configuración guardada', 'Settings saved'),
        timer: 1200,
        showConfirmButton: false,
      });
    } catch (error) {
      showError(root, error);
    } finally {
      stop();
    }
  };
}
async function smtpTab(root) {
  const response = await api('/api/admin/smtp'),
    smtp = response.smtp;
  root.innerHTML = `<section class="admin-section smtp-settings"><h2>${t('Configuración del correo SMTP', 'SMTP email settings')}</h2><p>${t('Completa los datos del servidor y envía un correo de prueba. Los cambios solo se guardarán después de confirmar que el mensaje llegó.', 'Enter the mail server details and send a test email. Settings can only be saved after the message is confirmed sent.')}</p><div class="smtp-fields"><label><span class="admin-label">SMTP Host</span><input class="settings-input" id="smtpHost" maxlength="255" required value="${esc(smtp.host)}" placeholder="smtp.example.com"></label><label><span class="admin-label">${t('Puerto', 'Port')}</span><input class="settings-input" id="smtpPort" type="number" min="1" max="65535" value="${Number(smtp.port) || 587}" required></label><label><span class="admin-label">${t('Usuario SMTP', 'SMTP username')}</span><input class="settings-input" id="smtpUser" maxlength="255" autocomplete="off" value="${esc(smtp.user)}"></label><label><span class="admin-label">${t('Correo remitente', 'Sender email')}</span><input class="settings-input" id="smtpFrom" maxlength="254" type="text" required value="${esc(smtp.from)}" placeholder="Teralth Wiki <wiki@example.com>"></label></div><label class="category-open-default smtp-secure-toggle"><input id="smtpSecure" type="checkbox" ${smtp.secure ? 'checked' : ''}> ${t('Conexión TLS segura', 'Secure TLS connection')}</label><div class="smtp-password-row"><span>${smtp.passwordConfigured ? t('La contraseña SMTP está guardada.', 'SMTP password is saved.') : t('No hay una contraseña SMTP guardada.', 'No SMTP password is saved.')}</span><button type="button" class="secondary-button" id="toggleSmtpPassword">${t('Cambiar contraseña SMTP', 'Change SMTP password')}</button></div><div class="field smtp-password-field" id="smtpPasswordWrap" hidden><label for="smtpPassword">${t('Nueva contraseña SMTP', 'New SMTP password')}</label><input class="settings-input" id="smtpPassword" type="password" autocomplete="new-password" maxlength="1024"></div><div class="smtp-test-email-control"><button type="button" class="secondary-button" id="toggleTestEmail"><i class="fa-solid fa-envelope"></i> ${t('Ingresar correo de prueba', 'Enter test email')}</button><div class="field" id="smtpTestEmailWrap" hidden><label for="smtpTestEmail">${t('Correo de prueba (obligatorio)', 'Test email (required)')}</label><input class="settings-input" id="smtpTestEmail" type="email" required autocomplete="email" value="" placeholder="you@example.com"></div></div><div class="smtp-actions"><button type="button" class="secondary-button" id="testSmtp"><i class="fa-solid fa-paper-plane"></i> ${t('Enviar correo de prueba', 'Send test email')}</button><button type="button" class="primary-button" id="saveSmtp" disabled><i class="fa-solid fa-floppy-disk"></i> ${t('Guardar configuración SMTP', 'Save SMTP settings')}</button></div><div class="form-message auth-error" id="smtpError" hidden></div></section>`;
  const smtpSection = $('.smtp-settings', root),
    smtpFields = $('.smtp-fields', root),
    smtpSecurity = settingsGroup(t('Seguridad y credenciales', 'Security and credentials'),
      $('.smtp-secure-toggle', root), $('.smtp-password-row', root), $('#smtpPasswordWrap', root)),
    smtpTest = settingsGroup(t('Verificación', 'Verification'),
      $('.smtp-test-email-control', root), $('.smtp-actions', root), $('#smtpError', root));
  const smtpServer = settingsGroup(t('Servidor de correo', 'Mail server'));
  smtpFields.replaceWith(smtpServer);
  smtpServer.append(smtpFields);
  smtpSection.append(smtpSecurity, smtpTest);
  let proof = '';
  const getValues = () => ({
    host: $('#smtpHost', root).value.trim(),
    port: Number($('#smtpPort', root).value),
    secure: $('#smtpSecure', root).checked,
    user: $('#smtpUser', root).value.trim(),
    password: $('#smtpPassword', root).value,
    from: $('#smtpFrom', root).value.trim(),
    testEmail: $('#smtpTestEmail', root).value.trim(),
  });
  const invalidate = () => {
    proof = '';
    $('#saveSmtp', root).disabled = true;
  };
  $('#toggleSmtpPassword', root).onclick = () => {
    $('#smtpPasswordWrap', root).hidden = !$('#smtpPasswordWrap', root).hidden;
  };
  $('#toggleTestEmail', root).onclick = () => {
    $('#smtpTestEmailWrap', root).hidden = !$('#smtpTestEmailWrap', root).hidden;
    if (!$('#smtpTestEmailWrap', root).hidden) $('#smtpTestEmail', root).focus();
  };
  $$('input', root).forEach((input) => input.addEventListener('input', invalidate));
  $$('input[type=checkbox]', root).forEach((input) => input.addEventListener('change', invalidate));
  $('#testSmtp', root).onclick = async () => {
    try {
      invalidate();
      if (!$('#smtpTestEmail', root).value.trim()) {
        $('#smtpTestEmailWrap', root).hidden = false;
        $('#smtpTestEmail', root).focus();
        throw validationError(
          t('Ingresa el correo de prueba antes de continuar.', 'Enter the test email before continuing.'),
        );
      }
      const tested = await api('/api/admin/smtp/test', { method: 'POST', body: JSON.stringify(getValues()) });
      proof = tested.proof;
      $('#saveSmtp', root).disabled = false;
      await notify({
        icon: 'success',
        title: t('Correo de prueba enviado', 'Test email sent'),
        text: t(
          'Se confirmó el envío con el servidor SMTP. Ya puedes guardar la configuración.',
          'The SMTP server accepted the test email. You can now save these settings.',
        ),
        confirmButtonText: t('Entendido', 'Got it'),
      });
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
  $('#saveSmtp', root).onclick = async () => {
    try {
      if (!proof) throw validationError(t('Primero envía el correo de prueba.', 'Send the test email first.'));
      await api('/api/admin/smtp', { method: 'PUT', body: JSON.stringify({ ...getValues(), proof }) });
      proof = '';
      await notify({
        icon: 'success',
        title: t('SMTP guardado', 'SMTP settings saved'),
        confirmButtonText: t('Entendido', 'Got it'),
      });
      await adminView('smtp');
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
}

async function reverseProxyTab(root) {
  const { config } = await api('/api/admin/reverse-proxy');
  const host = /^[A-Za-z0-9.-]+$/.test(location.hostname) ? location.hostname : '_';
  const upstream = String(config.upstream || 'http://127.0.0.1:3000').replace(/\/$/, '');
  root.innerHTML = `<section class="admin-section proxy-intro"><h2>${t('Proxy inverso', 'Reverse Proxy')}</h2><p>${t('Configura qué proxy puede reenviar cabeceras a Express y genera ejemplos para tu servidor web.', 'Configure which proxy may forward headers to Express and generate examples for your web server.')}</p><div class="proxy-security-note"><i class="fa-solid fa-shield-halved"></i><span>${t('El proxy debe reemplazar las cabeceras X-Forwarded-* y el puerto interno de Node no debe quedar abierto a Internet. Esta pantalla no modifica Nginx, Apache ni Cloudflare; copia el bloque y aplícalo en ese servicio.', 'Your proxy must overwrite X-Forwarded-* headers and Node’s internal port must not be exposed to the Internet. This screen cannot edit Nginx, Apache, or Cloudflare; copy and apply the configuration on that service.')}</span></div></section><section class="admin-section proxy-settings"><h2>${t('Confianza del proxy', 'Proxy trust')}</h2><div class="proxy-fields"><label><span class="admin-label">${t('Modo de confianza', 'Trust mode')}</span><select class="settings-input" id="proxyMode"><option value="hops" ${config.mode === 'hops' ? 'selected' : ''}>${t('Número de saltos', 'Number of hops')}</option><option value="addresses" ${config.mode === 'addresses' ? 'selected' : ''}>${t('IP o subredes de confianza', 'Trusted IPs or subnets')}</option><option value="disabled" ${config.mode === 'disabled' ? 'selected' : ''}>${t('Sin proxy', 'No proxy')}</option></select></label><label id="proxyHopsWrap"><span class="admin-label">${t('Proxies entre internet y wiki', 'Proxies between the internet and the wiki')}</span><input class="settings-input" type="number" min="1" max="10" id="proxyHops" value="${Number(config.hops) || 1}"></label><label id="proxyAddressesWrap"><span class="admin-label">${t('IPs/subredes confiables (separadas por coma)', 'Trusted IPs/subnets (comma separated)')}</span><input class="settings-input" id="proxyAddresses" maxlength="2000" placeholder="127.0.0.1, 10.0.0.0/8" value="${esc(config.addresses || '')}"></label><label><span class="admin-label">${t('Dirección del servidor Node (upstream)', 'Node server address (upstream)')}</span><input class="settings-input" id="proxyUpstream" maxlength="300" value="${esc(upstream)}" placeholder="http://127.0.0.1:3000"></label></div><div class="proxy-actions"><button class="primary-button" id="saveProxy"><i class="fa-solid fa-floppy-disk"></i> ${t('Guardar configuración', 'Save configuration')}</button><button class="secondary-button" id="checkProxy"><i class="fa-solid fa-vial"></i> ${t('Comprobar cabeceras actuales', 'Check current headers')}</button></div><p class="proxy-help">${t('Usa “Número de saltos” solo si todas las rutas de acceso tienen la misma cantidad de proxies. Si no, especifica las IP/subredes exactas del proxy que se conecta directamente a Node.', 'Use “Number of hops” only when every access path has the same number of proxies. Otherwise, enter the exact IP/subnets of the proxy that connects directly to Node.')}</p></section><section class="admin-section proxy-snippets"><div class="section-heading"><div><h2>${t('Configuración para el proxy', 'Proxy configuration')}</h2><p>${t('Dominio actual:', 'Current domain:')} <code>${esc(location.hostname)}</code></p></div></div><div class="proxy-snippet-block"><div class="proxy-snippet-heading"><strong>Nginx</strong><button class="secondary-button" data-copy-snippet="nginxProxySnippet"><i class="fa-regular fa-copy"></i> ${t('Copiar', 'Copy')}</button></div><pre><code id="nginxProxySnippet"></code></pre></div><div class="proxy-snippet-block"><div class="proxy-snippet-heading"><strong>Apache HTTP Server</strong><button class="secondary-button" data-copy-snippet="apacheProxySnippet"><i class="fa-regular fa-copy"></i> ${t('Copiar', 'Copy')}</button></div><pre><code id="apacheProxySnippet"></code></pre></div><div class="proxy-cloudflare-note"><strong>Cloudflare</strong><p>${t('Si Cloudflare está delante de Nginx, activa Full (strict), permite en el firewall solo los rangos de Cloudflare y configura Nginx real_ip con CF-Connecting-IP usando únicamente esos rangos confiables. Mantén actualizados sus rangos.', 'If Cloudflare sits in front of Nginx, use Full (strict), allow only Cloudflare ranges through the firewall, and configure Nginx real_ip with CF-Connecting-IP using only those trusted ranges. Keep the ranges updated.')}</p></div></section>`;
  const refresh = () => {
    const proxyUpstream = String($('#proxyUpstream', root).value || 'http://127.0.0.1:3000')
      .trim()
      .replace(/\/$/, '');
    const nginx = `server {\n    listen 443 ssl;\n    server_name ${host};\n    # Configure ssl_certificate and ssl_certificate_key for this hostname.\n\n    location / {\n        proxy_pass ${proxyUpstream};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Host $host;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Forwarded-Port $server_port;\n    }\n}`;
    const apache = `# Enable mod_proxy, mod_proxy_http, mod_headers, and mod_ssl.\n<VirtualHost *:443>\n    ServerName ${host}\n    SSLEngine on\n    # Configure SSLCertificateFile and SSLCertificateKeyFile.\n\n    ProxyRequests Off\n    ProxyPreserveHost On\n    RequestHeader set X-Forwarded-Proto "https"\n    RequestHeader set X-Forwarded-Port "443"\n    ProxyPass "/" "${proxyUpstream}/"\n    ProxyPassReverse "/" "${proxyUpstream}/"\n</VirtualHost>`;
    $('#nginxProxySnippet', root).textContent = nginx;
    $('#apacheProxySnippet', root).textContent = apache;
    const mode = $('#proxyMode', root).value;
    $('#proxyHopsWrap', root).hidden = mode !== 'hops';
    $('#proxyAddressesWrap', root).hidden = mode !== 'addresses';
  };
  $('#proxyMode', root).onchange = refresh;
  $('#proxyUpstream', root).oninput = refresh;
  refresh();
  $('#saveProxy', root).onclick = async () => {
    try {
      const result = await api('/api/admin/reverse-proxy', {
        method: 'PUT',
        body: JSON.stringify({
          mode: $('#proxyMode', root).value,
          hops: Number($('#proxyHops', root).value),
          addresses: $('#proxyAddresses', root).value,
          upstream: $('#proxyUpstream', root).value,
        }),
      });
      setNotice(t('Configuración del proxy guardada.', 'Proxy configuration saved.'));
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
  $('#checkProxy', root).onclick = async () => {
    try {
      const status = await api('/api/admin/reverse-proxy/status');
      await Swal.fire({
        title: t('Cabeceras recibidas por Express', 'Headers seen by Express'),
        html: '<pre class="proxy-status-output">' + esc(JSON.stringify(status, null, 2)) + '</pre>',
        confirmButtonText: t('Entendido', 'Got it'),
        buttonsStyling: false,
        customClass: { popup: 'wiki-swal-popup', title: 'wiki-swal-title', confirmButton: 'primary-button' },
      });
    } catch (error) {
      showError($('#adminPanel'), error);
    }
  };
  $$('[data-copy-snippet]', root).forEach(
    (button) =>
      (button.onclick = async () => {
        try {
          await navigator.clipboard.writeText($('#' + button.dataset.copySnippet, root).textContent);
          setNotice(t('Configuración copiada.', 'Configuration copied.'));
        } catch {
          setNotice(t('No se pudo copiar la configuración.', 'Could not copy the configuration.'), 'error');
        }
      }),
  );
}

async function changeAdminSpace(nextSpace, tab, root) {
  const requestId = (state.adminSpaceRequest || 0) + 1;
  state.adminSpaceRequest = requestId;
  state.space = nextSpace;
  history.replaceState({}, '', adminUrl(tab, nextSpace));
  renderSpaces();
  state.pages = [];
  state.categories = [];
  state.homePageSlug = null;
  if (tab === 'pages') renderPageRows(root);
  try {
    const result = await api('/api/pages', { headers: { 'X-Wiki-Space': nextSpace } });
    if (state.adminSpaceRequest !== requestId || state.space !== nextSpace || !root.isConnected) return;
    state.pages = Array.isArray(result.pages) ? result.pages : [];
    state.categories = Array.isArray(result.categories) ? result.categories : [];
    state.homePageSlug = result.homePageSlug || null;
    renderNav();
    await adminView(tab);
  } catch (error) {
    if (state.adminSpaceRequest === requestId && root.isConnected) showError($('#adminPanel'), error);
  }
}
async function pagesTab(root) {
  const spaces = state.config.spaces || [],
    options = spaces
      .map(
        (space) =>
          `<option value="${esc(space.slug)}" ${space.slug === state.space ? 'selected' : ''}>${esc(space.name)} (${space.slug === 'main' ? '/' : '/' + space.slug})</option>`,
      )
      .join('');
  root.innerHTML = `<section class="admin-section workspace-selector-section"><div><h2>${t('Espacio de trabajo', 'Working space')}</h2><p>${t('Elige el espacio donde se crearán y editarán las páginas.', 'Choose the space where pages will be created and edited.')}</p></div><label class="workspace-select-label"><span class="admin-label">${t('Espacio de documentación', 'Documentation space')}</span><select class="settings-input" id="pagesSpaceSelect">${options}</select></label></section><section class="admin-section page-management-section"><div class="section-heading"><div><h2>${t('Páginas', 'Pages')}</h2><p>${t('Crea páginas de contenido o redirecciones dentro del espacio seleccionado. Arrastra el control de seis puntos para reordenar o cambiar de categoría.', 'Create content pages or redirects in the selected space. Drag the six-dot handle to reorder or change categories.')}</p></div><button class="primary-button" id="newPage"><i class="fa-solid fa-plus"></i> ${t('Crear una página', 'Create page')}</button></div><div id="pageRows" class="page-category-groups"></div></section><section class="admin-section page-editor-section" id="pageEditor" hidden></section>`;
  renderPageRows(root);
  $('#newPage', root).hidden = !can('pages.create_edit');
  if (can('pages.create_edit')) $('#newPage', root).onclick = () => openEditor(root, null);
  $('#pagesSpaceSelect', root).onchange = async (event) => {
    if (!(await confirmUnsaved())) {
      event.target.value = state.space;
      return;
    }
    await changeAdminSpace(event.target.value, 'pages', root);
  };
}

function renderPageRows(root) {
  const rows = $('#pageRows', root),
    canOrder = can('pages.create_edit'),
    canHome = can('pages.create_edit'),
    canEdit = can('pages.create_edit'),
    canDelete = can('pages.delete'),
    pagesByCategory = new Map(),
    childrenByParent = new Map();
  for (const page of state.pages) {
    const key = page.category_id ? String(page.category_id) : '';
    const list = pagesByCategory.get(key) || [];
    list.push(page);
    pagesByCategory.set(key, list);
  }
  for (const category of state.categories) {
    const key = String(category.parent_id || ''),
      list = childrenByParent.get(key) || [];
    list.push(category);
    childrenByParent.set(key, list);
  }
  const renderPage = (page) => {
    const title =
      page.titles[state.lang] ||
      page.titles[state.lang.split('-')[0]] ||
      Object.values(page.titles)[0] ||
      page.slug;
    return `<div class="page-row" draggable="false" data-page-id="${Number(page.id)}" data-slug="${esc(page.slug)}"><button type="button" class="drag-handle page-row-drag-handle" draggable="${canOrder ? 'true' : 'false'}" aria-label="${t('Arrastrar página', 'Drag page')}" title="${t('Arrastrar para ordenar o cambiar categoría', 'Drag to reorder or change category')}" ${canOrder ? '' : 'hidden'}><i class="fa-solid fa-grip-vertical"></i></button><div class="page-row-main">${pageIconMarkup(page.icon)}<div><strong>${esc(title)}</strong><div class="sidebar-version">${esc(navUrl(state.space, page.slug))}</div></div></div>${canHome ? `<button type="button" class="home-page-button ${state.homePageSlug === page.slug ? 'active' : ''}" data-slug="${esc(page.slug)}" title="${state.homePageSlug === page.slug ? t('Página de inicio', 'Home page') : t('Establecer como página de inicio', 'Set as home page')}" aria-label="${t('Establecer como página de inicio', 'Set as home page')}"><i class="fa-solid fa-house"></i></button>` : ''}${canEdit ? `<button class="secondary-button edit-page" data-slug="${esc(page.slug)}"><i class="fa-solid fa-pen"></i> ${t('Editar', 'Edit')}</button>` : ''}${canDelete ? `<button class="danger-button delete-page" data-slug="${esc(page.slug)}" aria-label="${t('Eliminar página', 'Delete page')}"><i class="fa-solid fa-trash"></i></button>` : ''}</div>`;
  };
  const renderPageList = (categoryId, list) =>
    `<div class="page-list" data-drop-category="${categoryId === null ? '' : Number(categoryId)}">${list.length ? list.map(renderPage).join('') : `<div class="empty-drop-hint">${canOrder ? t('Arrastra páginas aquí', 'Drop pages here') : t('Sin páginas', 'No pages')}</div>`}</div>`;
  const renderCategory = (category) => {
    const id = Number(category.id),
      kids = childrenByParent.get(String(id)) || [],
      directPages = pagesByCategory.get(String(id)) || [],
      label =
        category.names[state.lang] ||
        category.names[state.lang.split('-')[0]] ||
        Object.values(category.names)[0] ||
        t('Categoría', 'Category');
    return `<section class="page-category-group" data-category-id="${id}"><div class="page-category-heading">${pageIconMarkup(category.icon)}<strong>${esc(label)}</strong><span class="page-category-count">${directPages.length}</span></div>${renderPageList(id, directPages)}${kids.length ? `<div class="page-category-children">${kids.map(renderCategory).join('')}</div>` : ''}</section>`;
  };
  const roots = childrenByParent.get('') || [],
    loose = pagesByCategory.get('') || [];
  rows.innerHTML = `<section class="page-general-section"><div class="page-general-heading"><i class="fa-solid fa-layer-group"></i><strong>${t('General', 'General')}</strong><span class="page-category-count">${loose.length}</span></div>${renderPageList(null, loose)}</section>${roots.map(renderCategory).join('')}`;
  let dragged = null,
    dropSaving = false;
  const listForTarget = (target) => {
    const list = target.closest('.page-list');
    if (list) return list;
    const heading = target.closest('.page-category-heading,.page-general-heading');
    return heading ? heading.parentElement.querySelector(':scope > .page-list') : null;
  };
  rows.addEventListener('dragstart', (event) => {
    const pageRow = event.target.closest('.page-row'),
      handle = event.target.closest('.page-row-drag-handle');
    if (!pageRow || !handle || !canOrder || state.dirty) {
      event.preventDefault();
      if (state.dirty)
        setNotice(
          t(
            'Guarda o descarta la edición actual antes de reordenar.',
            'Save or discard the current edit before reordering.',
          ),
          'error',
        );
      return;
    }
    dragged = pageRow;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', pageRow.dataset.pageId);
    requestAnimationFrame(() => pageRow.classList.add('dragging'));
  });
  rows.addEventListener('dragover', (event) => {
    if (!dragged || dropSaving) return;
    const list = listForTarget(event.target);
    if (!list) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    $$('.page-list.drop-active', rows).forEach((item) => item.classList.remove('drop-active'));
    list.classList.add('drop-active');
    const target = event.target.closest('.page-row');
    if (target && target !== dragged && target.parentElement === list) {
      const rect = target.getBoundingClientRect();
      list.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
    } else if (!target) list.append(dragged);
  });
  rows.addEventListener('drop', async (event) => {
    if (!dragged || dropSaving) return;
    const list = listForTarget(event.target);
    if (!list) return;
    event.preventDefault();
    const items = $$('.page-list', rows).flatMap((pageList) =>
      $$(':scope > .page-row', pageList).map((row) => ({
        id: Number(row.dataset.pageId),
        categoryId: pageList.dataset.dropCategory ? Number(pageList.dataset.dropCategory) : null,
      })),
    );
    if (items.length !== state.pages.length) {
      renderPageRows(root);
      return;
    }
    dropSaving = true;
    $$('.page-list.drop-active', rows).forEach((item) => item.classList.remove('drop-active'));
    try {
      await api('/api/admin/navigation/order', { method: 'PUT', body: JSON.stringify({ items }) });
      await loadWiki();
      renderPageRows(root);
      setNotice(t('Orden y categoría de páginas guardados.', 'Page order and category saved.'));
    } catch (error) {
      showError($('#adminPanel'), error);
      renderPageRows(root);
    } finally {
      dropSaving = false;
    }
  });
  rows.addEventListener('dragend', () => {
    $$('.page-row.dragging', rows).forEach((row) => row.classList.remove('dragging'));
    $$('.page-list.drop-active', rows).forEach((list) => list.classList.remove('drop-active'));
    dragged = null;
  });
  $$('.home-page-button', rows).forEach(
    (button) =>
      (button.onclick = async () => {
        if (state.homePageSlug === button.dataset.slug) return;
        try {
          const result = await api('/api/admin/home-page', {
            method: 'PUT',
            body: JSON.stringify({ pageSlug: button.dataset.slug }),
          });
          state.homePageSlug = result.homePageSlug;
          renderPageRows(root);
          setNotice(t('Página de inicio actualizada.', 'Home page updated.'));
        } catch (error) {
          showError($('#adminPanel'), error);
        }
      }),
  );
  $$('.edit-page', rows).forEach(
    (button) =>
      (button.onclick = () =>
        openEditor(
          root,
          state.pages.find((page) => page.slug === button.dataset.slug),
        )),
  );
  $$('.delete-page', rows).forEach(
    (button) =>
      (button.onclick = async () => {
        const choice = await Swal.fire({
          icon: 'warning',
          title: t('¿Eliminar esta página?', 'Delete this page?'),
          text: t(
            'Esta acción eliminará el contenido de forma permanente.',
            'This permanently removes the page content.',
          ),
          showCancelButton: true,
          confirmButtonText: t('Eliminar', 'Delete'),
          cancelButtonText: t('Cancelar', 'Cancel'),
          reverseButtons: true,
        });
        if (!choice.isConfirmed) return;
        try {
          await api(`/api/admin/pages/${button.dataset.slug}`, { method: 'DELETE' });
          await loadWiki();
          renderPageRows(root);
        } catch (error) {
          showError($('#adminPanel'), error);
        }
      }),
  );
}
async function openEditor(root, page) {
  if (page && !Object.prototype.hasOwnProperty.call(page, 'content')) {
    const workspace = state.space;
    showLoading();
    try {
      const result = await api('/api/pages/' + encodeURIComponent(page.slug));
      if (workspace !== state.space) return;
      page = { ...page, ...result.page };
    } catch (error) {
      showError($('#adminPanel'), error);
      return;
    } finally {
      hideLoading();
    }
  }
  const editor = $('#pageEditor', root);
  editor.hidden = false;
  document.body.classList.add('editor-mode');
  closeMobileNav();
  state.editPage = page;
  const langs = state.config.languages;
  const first = page?.titles[state.lang] || Object.values(page?.titles || {})[0] || '';
  const currentSlug = page?.slug || '',
    pageIconIsImage = /^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/.test(page?.icon || '');
  editor.innerHTML = `<h2 id="editorHeading">${page ? t('Editar página', 'Edit page') : t('Nueva página', 'New page')}${first ? ' — ' + esc(first) : ''}</h2><div class="editor-top"><input class="settings-input" id="editTitle" placeholder="${t('Título de la página', 'Page title')}" value="${esc(first)}"><label class="page-icon-mode-control"><span class="admin-label">${t('Tipo de marca', 'Brand type')}</span><select class="settings-input" id="editIconMode"><option value="icon" ${pageIconIsImage ? '' : 'selected'}>${t('Insertar un ícono', 'Insert an icon')}</option><option value="image" ${pageIconIsImage ? 'selected' : ''}>${t('Subir una imagen', 'Upload an image')}</option></select></label><label id="editIconWrap" class="page-icon-mode-control" ${pageIconIsImage ? 'hidden' : ''}><span class="admin-label">${t('Ícono Font Awesome', 'Font Awesome icon')}</span><input class="settings-input" id="editIcon" placeholder="fa-solid fa-book-open" value="${esc(pageIconIsImage ? 'fa-file-lines' : page?.icon || 'fa-file-lines')}"></label><label id="editIconImageWrap" class="page-icon-mode-control page-icon-image-control" ${pageIconIsImage ? '' : 'hidden'}><span class="admin-label">${t('Subir una imagen', 'Upload an image')}</span><input id="uploadPageIcon" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><input id="editIconImagePath" type="hidden" value="${pageIconIsImage ? esc(page.icon) : ''}"><small id="pageIconStatus">${pageIconIsImage ? '<img class="category-image-preview" src="' + esc(page.icon) + '" alt="><a href="' + esc(page.icon) + '" target="_blank" rel="noopener noreferrer">' + esc(page.icon) + '</a>' : t('No hay imagen subida', 'No image uploaded')}</small></label><select class="settings-input editor-language" id="editLanguage">${langs.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select></div><div class="field page-type-field"><label for="editPageType">${t('Tipo de página', 'Page type')}</label><select class="settings-input" id="editPageType"><option value="content" ${page?.page_type !== 'redirect' ? 'selected' : ''}>${t('Página de contenido', 'Content page')}</option><option value="redirect" ${page?.page_type === 'redirect' ? 'selected' : ''}>${t('Página de redirección (URL)', 'Redirect page (URL)')}</option></select></div><div id="redirectPageFields" ${page?.page_type === 'redirect' ? '' : 'hidden'}><div class="field"><label for="redirectUrl">URL</label><input class="settings-input" id="redirectUrl" type="url" maxlength="2048" placeholder="https://example.com/docs" value="${esc(page?.redirect_url || '')}"></div></div><div id="contentPageFields" ${page?.page_type === 'redirect' ? 'hidden' : ''}><div class="admin-label" style="margin:8px 0">${t('Formato', 'Formatting')}</div><div class="editor-toolbar">${editorToolbarMarkup()}</div><div id="editContent" class="editor-content" contenteditable="true" aria-label="${t('Contenido de la página', 'Page content')}"></div><textarea class="editor-source" aria-label="${t('Contenido en formato de código', 'Source format')}" hidden spellcheck="false"></textarea><div class="field"><label>${t('Categoría', 'Category')}</label><select class="settings-input" id="editCategory"><option value="">${t('Sin categoría', 'No category')}</option>${state.categories.map((c) => `<option value="${c.id}" ${page?.category_id === c.id ? 'selected' : ''}>${esc(c.names[state.lang] || Object.values(c.names)[0])}</option>`).join('')}</select></div></div><div class="form-message auth-error" hidden></div><div style="display:flex;gap:8px;margin-top:14px"><button type="button" class="primary-button" id="savePage"><i class="fa-solid fa-floppy-disk"></i> ${t('Guardar cambios', 'Save changes')}</button><button class="secondary-button" id="cancelEditor">${t('Cancelar', 'Cancel')}</button></div>`;
  const editorHeader = document.createElement('div');
  editorHeader.className = 'editor-page-header';
  const backButton = $('#cancelEditor', editor);
  backButton.innerHTML = `<i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${t('Volver', 'Back')}`;
  editorHeader.append(backButton, $('#editorHeading', editor));
  editor.prepend(editorHeader);
  $('#savePage', editor).parentElement.className = 'editor-page-actions';
  const updateEditorHeading = (title) => {
    $('#editorHeading', editor).textContent = page
      ? t('Editando el archivo:', 'Editing file:') + ' ' + (title || first || currentSlug)
      : t('Nueva página', 'New page');
  };
  const content = $('#editContent', editor),
    source = $('.editor-source', editor),
    language = $('#editLanguage', editor),
    draftTitles = { ...(page?.titles || {}) },
    draftContent = { ...(page?.content || {}) };
  const fill = (lang) => {
    $('#editTitle').value = draftTitles[lang] || '';
    content.innerHTML = editorHtmlFromMarkup(draftContent[lang] || '');
    editorInlineCodeToText(content);
    prepareEditorWidgets(content);
    content.querySelectorAll('.code-format-label').forEach((label) => {
      label.contentEditable = 'false';
      highlightCodeBlock(label.closest('.code-block'));
    });
    source.value = editorMarkupFromHtml(content.innerHTML);
    source.hidden = true;
    content.hidden = false;
    updateEditorHeading(draftTitles[lang]);
    language.dataset.current = lang;
  };
  language.onchange = () => {
    const previous = language.dataset.current;
    draftTitles[previous] = $('#editTitle').value;
    draftContent[previous] = source.hidden ? editorContentHtml(content) : source.value;
    fill(language.value);
    renderEditorToc(content);
  };
  fill(language.value);
  renderEditorToc(content);
  content.oninput = () => {
    prepareEditorWidgets(content);
    source.value = editorMarkupFromHtml(content.innerHTML);
    draftContent[language.value] = editorContentHtml(content);
    state.dirty = true;
    renderEditorToc(content);
  };
  content.addEventListener('focusout', (event) => {
    const code = event.target.closest?.('.code-block pre code');
    if (code && !code.contains(event.relatedTarget)) highlightCodeBlock(code.closest('.code-block'));
  });
  source.oninput = () => {
    content.innerHTML = editorHtmlFromMarkup(source.value);
    editorInlineCodeToText(content);
    prepareEditorWidgets(content);
    draftContent[language.value] = editorContentHtml(content);
    state.dirty = true;
    renderEditorToc(content);
  };
  source.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const value = source.value,
      caret = source.selectionStart,
      opens = ['[code type="', '[info]', '[success]', '[warning]', '[error]', '<blockquote'],
      closes = {
        code: '[/code]',
        info: '[/info]',
        success: '[/success]',
        warning: '[/warning]',
        error: '[/error]',
        quote: '</blockquote>',
      };
    let markerIndex = -1,
      kind = '';
    for (const marker of opens) {
      const index = value.lastIndexOf(marker, caret);
      if (index > markerIndex) {
        markerIndex = index;
        kind = marker === '[code type="' ? 'code' : marker === '<blockquote' ? 'quote' : marker.slice(1, -1);
      }
    }
    if (markerIndex < 0) return;
    const openEnd = value.indexOf(']', markerIndex) + 1;
    if (caret < openEnd) return;
    const closeToken = closes[kind],
      closeStart = value.toLowerCase().indexOf(closeToken, openEnd);
    if (closeStart < caret) return;
    event.preventDefault();
    const closeEnd = closeStart + closeToken.length;
    if (value[closeEnd] === '\n') source.setSelectionRange(closeEnd + 1, closeEnd + 1);
    else source.setRangeText('\n\n', closeEnd, closeEnd, 'end');
    source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
  });
  $('[data-source-toggle]', editor).onclick = (event) => {
    const inSource = !source.hidden,
      toolbar = $('.editor-toolbar', editor);
    if (inSource) {
      content.innerHTML = editorHtmlFromMarkup(source.value);
      editorInlineCodeToText(content);
      prepareEditorWidgets(content);
      $$('.code-block', content).forEach(highlightCodeBlock);
      source.hidden = true;
      content.hidden = false;
      event.currentTarget.classList.remove('active');
      content.focus();
    } else {
      source.value = editorMarkupFromHtml(editorContentHtml(content));
      source.hidden = false;
      content.hidden = true;
      event.currentTarget.classList.add('active');
      source.focus();
    }
    toolbar.classList.toggle('source-mode', !inSource);
    $$('button:not([data-source-toggle]),select', toolbar).forEach((control) => {
      control.disabled = !inSource;
    });
    draftContent[language.value] = content.innerHTML;
    refreshToolbarState();
  };
  $('#editTitle').oninput = () => {
    draftTitles[language.value] = $('#editTitle').value;
    updateEditorHeading($('#editTitle').value);
    state.dirty = true;
  };
  $('#editPageType').onchange = () => {
    const redirect = $('#editPageType').value === 'redirect';
    $('#redirectPageFields').hidden = !redirect;
    $('#contentPageFields').hidden = redirect;
    state.dirty = true;
  };
  $('#editIconMode').onchange = () => {
    const image = $('#editIconMode').value === 'image';
    $('#editIconWrap').hidden = image;
    $('#editIconImageWrap').hidden = !image;
    state.dirty = true;
  };
  $('#editIcon').oninput = () => (state.dirty = true);
  $('#uploadPageIcon').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $('#pageIconStatus');
    try {
      status.textContent = t('Subiendo imagen…', 'Uploading image…');
      const body = new FormData();
      body.append('image', file);
      body.append('alt', $('#editTitle').value);
      const response = await request('/api/admin/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf },
        body,
      });
      const data = await imageUploadResponse(response);
      $('#editIconImagePath').value = data.url;
      setPageIconUploadStatus(status, data.url);
      state.dirty = true;
    } catch (err) {
      status.textContent = '';
      showError(editor, err);
    } finally {
      e.target.value = '';
    }
  };
  $('#editCategory').onchange = () => (state.dirty = true);
  let savedRange = null;
  editor.querySelector('.editor-toolbar').addEventListener('mousedown', (event) => {
    const selection = getSelection();
    if (selection?.rangeCount && content.contains(selection.anchorNode))
      savedRange = selection.getRangeAt(0).cloneRange();
  });
  const restoreRange = () => {
    if (!savedRange) return;
    content.focus();
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(savedRange);
  };
  $$('[data-command]', editor).forEach((button) => {
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = async () => {
      restoreRange();
      const cmd = button.dataset.command;
      if (!source.hidden && ['undo', 'redo'].includes(cmd)) {
        source.focus();
        document.execCommand(cmd === 'undo' ? 'undo' : 'redo');
      } else if (
        !source.hidden &&
        ['strike', 'heading', 'text-color', 'highlight', 'font', 'alignment', 'clear-format'].includes(cmd)
      ) {
        if (cmd === 'strike') addSourceMarkup(source, 'strike');
        else if (cmd === 'heading') addSourceMarkup(source, $('[data-tool=heading]', editor).value);
        else if (cmd === 'text-color' || cmd === 'highlight') {
          const property = cmd === 'text-color' ? 'color' : 'mark';
          Swal.fire({
            title:
              cmd === 'text-color'
                ? t('Color de letra', 'Text color')
                : t('Resaltado de texto', 'Text highlight'),
            input: 'color',
            showCancelButton: true,
            buttonsStyling: false,
            customClass: {
              popup: 'wiki-swal-popup editor-swal-popup',
              confirmButton: 'primary-button',
              cancelButton: 'secondary-button',
            },
            confirmButtonText: t('Aplicar', 'Apply'),
            cancelButtonText: t('Cancelar', 'Cancel'),
          }).then((result) => {
            if (result.isConfirmed) addSourceMarkup(source, property + '="' + result.value + '"');
          });
        } else if (cmd === 'clear-format') addSourceMarkup(source, 'clear-format');
        else
          addSourceMarkup(
            source,
            cmd === 'font'
              ? 'font="' + $('[data-tool=font]', editor).value + '"'
              : 'align="' + $('[data-tool=alignment]', editor).value + '"',
          );
      } else if (cmd === 'strike') document.execCommand('strikeThrough');
      else if (
        [
          'text-color',
          'highlight',
          'font',
          'heading',
          'alignment',
          'undo',
          'redo',
          'indent',
          'outdent',
          'unlink',
          'clear-format',
          'special-chars',
          'emoji',
          'image',
        ].includes(cmd)
      )
        runEditorAdvancedTool(cmd, content);
      else await runEditorCommand(cmd, content);
      refreshToolbarState();
    };
  });
  $$('[data-tool]', editor).forEach(
    (control) =>
      (control.onchange = () => {
        restoreRange();
        if (!source.hidden) {
          const value =
            control.dataset.tool === 'heading'
              ? control.value
              : control.dataset.tool === 'alignment'
                ? 'align="' + control.value + '"'
                : 'font="' + control.value + '"';
          addSourceMarkup(source, value);
        } else runEditorAdvancedTool(control.dataset.tool, content);
        refreshToolbarState();
      }),
  );
  const refreshToolbarState = () => {
    if (!source.hidden) {
      $$('.editor-toolbar .active', editor).forEach((button) => {
        if (!button.matches('[data-source-toggle]')) button.classList.remove('active');
      });
      return;
    }
    const selection = getSelection(),
      anchor =
        selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? selection.anchorNode
          : selection?.anchorNode?.parentElement,
      link = anchor?.closest?.('a');
    editor.querySelector('[data-command="unlink"]').disabled = !link;
    editor.querySelector('[data-command="clear-format"]').disabled = false;
    editor.querySelector('[data-command="undo"]').disabled = !document.queryCommandEnabled('undo');
    editor.querySelector('[data-command="redo"]').disabled = !document.queryCommandEnabled('redo');
    for (const [command, stateName] of [
      ['bold', 'bold'],
      ['italic', 'italic'],
      ['underline', 'underline'],
      ['strikeThrough', 'strikeThrough'],
    ])
      editor
        .querySelector('[data-command="' + (stateName === 'strikeThrough' ? 'strike' : stateName) + '"]')
        ?.classList.toggle('active', Boolean(document.queryCommandState?.(command)));
    editor.querySelector('[data-command="link"]')?.classList.toggle('active', Boolean(link));
    const block = anchor?.closest?.('h1,h2,h3,h4,h5,h6,p'),
      headingControl = editor.querySelector('[data-tool="heading"]');
    editor.querySelector('[data-command="indent"]')?.classList.toggle('active', Boolean(anchor?.closest?.('.editor-indent')));
    if (headingControl && block) headingControl.value = block.tagName.toLowerCase();
    const align = anchor?.closest?.('[style*="text-align"]')?.style.textAlign || 'left',
      alignControl = editor.querySelector('[data-tool="alignment"]');
    if (alignControl) {
      alignControl.value = ['left', 'center', 'right', 'justify'].includes(align) ? align : 'left';
      const icon = alignControl.parentElement.querySelector('i');
      if (icon) icon.className = 'fa-solid fa-align-' + alignControl.value;
    }
    const styled = anchor?.closest?.('span[style]'),
      colorButton = editor.querySelector('[data-command="text-color"]'),
      highlightButton = editor.querySelector('[data-command="highlight"]'),
      fontControl = editor.querySelector('[data-tool="font"]');
    colorButton?.classList.toggle('active', Boolean(styled?.style.color));
    highlightButton?.classList.toggle('active', Boolean(styled?.style.backgroundColor));
    if (fontControl) {
      const family = styled?.style.fontFamily || '';
      fontControl.value = [...fontControl.options].some((option) => option.text === family) ? family : '';
      fontControl.parentElement.classList.toggle('active', Boolean(family));
    }
  };
  content.addEventListener('keyup', refreshToolbarState);
  content.addEventListener('mouseup', refreshToolbarState);
  content.addEventListener('input', refreshToolbarState);
  let selectedMedia = null;
  const placeCaretBesideMedia = (media, after = true) => {
    if (!media?.isConnected) return false;
    let paragraph = after
      ? (media.nextElementSibling?.matches('p') ? media.nextElementSibling : null)
      : (media.previousElementSibling?.matches('p') ? media.previousElementSibling : null);
    if (!paragraph) {
      paragraph = document.createElement('p');
      paragraph.append(document.createElement('br'));
      after ? media.after(paragraph) : media.before(paragraph);
    }
    media.classList.remove('editor-media-selected');
    selectedMedia = null;
    content.focus();
    const caretRange = document.createRange();
    caretRange.selectNodeContents(paragraph);
    caretRange.collapse(!after);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(caretRange);
    return true;
  };
  const removeSelectedMedia = (direction = -1) => {
    if (!selectedMedia?.isConnected) {
      selectedMedia = null;
      return false;
    }
    const media = selectedMedia;
    const previous = media.previousElementSibling?.matches('p') ? media.previousElementSibling : null;
    const next = media.nextElementSibling?.matches('p') ? media.nextElementSibling : null;
    media.remove();
    selectedMedia = null;
    const target = direction < 0 ? previous || next : next || previous;
    if (target) {
      content.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(direction > 0);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    content.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const deleteAdjacentMedia = (direction) => {
    const selection = getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!content.contains(range.startContainer)) return false;
    let media = null;
    if (!selection.isCollapsed && !selection.toString()) {
      media = [...content.querySelectorAll('.editor-image-component,.editor-image-resize,.editor-video-component,.video-embed')]
        .find((node) => {
          try { return range.intersectsNode(node); } catch { return false; }
        }) || null;
    } else if (selection.isCollapsed) {
      media = editorAtomicMediaAtCaret(content, range, direction);
    }
    if (!media) return false;
    const nextParagraph = media.nextElementSibling?.matches('p') ? media.nextElementSibling : null;
    const previousParagraph = media.previousElementSibling?.matches('p') ? media.previousElementSibling : null;
    media.remove();
    const caretTarget = direction < 0 ? previousParagraph || nextParagraph : nextParagraph || previousParagraph;
    if (caretTarget?.isConnected) {
      const caretRange = document.createRange();
      caretRange.selectNodeContents(caretTarget);
      caretRange.collapse(direction > 0);
      selection.removeAllRanges();
      selection.addRange(caretRange);
    }
    content.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  content.addEventListener('beforeinput', (event) => {
    if (selectedMedia?.isConnected && ['insertText', 'insertParagraph', 'insertLineBreak'].includes(event.inputType)) {
      placeCaretBesideMedia(selectedMedia, true);
      return;
    }
    if (!['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) return;
    const direction = event.inputType === 'deleteContentBackward' ? -1 : 1;
    if (deleteAdjacentMedia(direction)) event.preventDefault();
  });
  content.addEventListener('keydown', (event) => {
    if (selectedMedia?.isConnected) {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (removeSelectedMedia(event.key === 'Backspace' ? -1 : 1)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        placeCaretBesideMedia(selectedMedia, event.key === 'ArrowRight');
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) {
        placeCaretBesideMedia(selectedMedia, true);
      }
    }
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    if (deleteAdjacentMedia(event.key === 'Backspace' ? -1 : 1)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  content.addEventListener('click', (event) => {
    if (event.target.closest('.editor-image-resize-handle')) return;
    const media = event.target.closest('.editor-image-component,.editor-image-resize,.editor-video-component,.video-embed');
    if (!media || !content.contains(media)) {
      if (selectedMedia) selectedMedia.classList.remove('editor-media-selected');
      selectedMedia = null;
      return;
    }
    content.querySelectorAll('.editor-media-selected').forEach((node) => node.classList.remove('editor-media-selected'));
    media.classList.add('editor-media-selected');
    selectedMedia = media.matches('.editor-image-resize') && media.parentElement?.matches('.editor-image-component')
      ? media.parentElement
      : media;
    content.focus();
  });
  let imageResizeStart = null;
  content.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.editor-image-resize-handle');
    if (!handle) return;
    const wrapper = handle.closest('.editor-image-resize,.editor-video-component'),
      media = wrapper?.querySelector('img,iframe');
    if (!media || !content.contains(wrapper)) return;
    const rect = media.getBoundingClientRect();
    imageResizeStart = { media, wrapper, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height, aspect: rect.width / Math.max(1, rect.height), pointerId: event.pointerId };
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
  });
  content.addEventListener('pointermove', (event) => {
    if (!imageResizeStart || imageResizeStart.pointerId !== event.pointerId) return;
    const { media, wrapper, startX, startY, width, height, aspect } = imageResizeStart;
    const fromX = width + event.clientX - startX, fromY = width + (event.clientY - startY) * aspect;
    const nextWidth = Math.max(media.matches('iframe') ? 120 : 24, Math.min(content.clientWidth - 24, Math.abs(fromX - width) >= Math.abs(fromY - width) ? fromX : fromY));
    if (media.matches('img')) {
      media.style.width = Math.round(nextWidth) + 'px';
      media.style.height = 'auto';
    }
    wrapper.style.width = Math.round(nextWidth) + 'px';
    wrapper.style.height = 'auto';
  });
  const finishImageResize = (event) => {
    if (!imageResizeStart || imageResizeStart.pointerId !== event.pointerId) return;
    const { media } = imageResizeStart;
    imageResizeStart = null;
    const nextWidth = Math.round(media.getBoundingClientRect().width);
    if (nextWidth >= 16) {
      if (media.matches('img')) {
        media.dataset.userResized = 'true';
        media.setAttribute('width', String(nextWidth));
        media.removeAttribute('height');
      }
      content.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  content.addEventListener('pointerup', finishImageResize);
  content.addEventListener('pointercancel', finishImageResize);
  refreshToolbarState();
  content.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter') return;
      const selection = getSelection(),
        anchor =
          selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
            ? selection.anchorNode
            : selection?.anchorNode?.parentElement,
        block = anchor?.closest?.('.hint,blockquote,.code-block,pre,.external-link-card');
      if (!block || !content.contains(block)) return;
      if (block.matches('.code-block,pre') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        document.execCommand('insertText', false, '\n');
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (block.matches('.code-block,pre')) document.execCommand('insertText', false, '\n');
        else document.execCommand('insertHTML', false, '<br>');
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      let next = block.nextElementSibling;
      const emptyParagraph =
        next?.matches('p') &&
        !next.textContent.trim() &&
        !next.querySelector('img,table,pre,.hint,.code-block,blockquote');
      if (!emptyParagraph) {
        next = document.createElement('p');
        next.innerHTML = '<br>';
        block.after(next);
      }
      content.focus();
      const range = document.createRange();
      range.selectNodeContents(next);
      range.collapse(true);
      const activeSelection = getSelection();
      activeSelection.removeAllRanges();
      activeSelection.addRange(range);
    },
    true,
  );
  content.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const selection = getSelection(), anchor = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    if (!anchor?.closest?.('.editor-indent')) return;
    setTimeout(() => {
      const currentSelection = getSelection(), currentAnchor = currentSelection?.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? currentSelection.anchorNode
        : currentSelection?.anchorNode?.parentElement,
        currentBlock = currentAnchor?.closest?.('p,h1,h2,h3,h4,h5,h6,li,blockquote');
      if (currentBlock && content.contains(currentBlock) && !currentBlock.closest('.editor-indent')) {
        currentBlock.classList.add('editor-indent');
        content.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 0);
  });
  content.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const selection = getSelection(),
      node =
        selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? selection.anchorNode
          : selection?.anchorNode?.parentElement,
      item = node?.closest('li');
    if (!item || !content.contains(item)) return;
    event.preventDefault();
    const list = item.parentElement,
      parentItem = list.parentElement.closest('li');
    if (event.shiftKey) {
      if (!parentItem) return;
      parentItem.after(item);
      return;
    }
    let depth = 0;
    for (let current = list; current && current !== content; current = current.parentElement)
      if (current.matches('ul,ol')) depth++;
    if (depth >= 5) return;
    let previous = item.previousElementSibling;
    if (!previous) return;
    let nested = [...previous.children].find((child) => child.matches(list.tagName.toLowerCase()));
    if (!nested) {
      nested = document.createElement(list.tagName.toLowerCase());
      previous.append(nested);
    }
    nested.append(item);
  });
  content.addEventListener('click', async (event) => {
    const spoilerDelete = event.target.closest('.editor-spoiler-delete');
    if (spoilerDelete) {
      event.preventDefault();
      const spoiler = spoilerDelete.closest('.wiki-spoiler');
      if (spoiler && content.contains(spoiler)) {
        spoiler.remove();
        content.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    const spoilerSummary = event.target.closest('.wiki-spoiler > summary');
    if (spoilerSummary && content.contains(spoilerSummary)) {
      event.preventDefault();
      const label = spoilerSummary.querySelector('.spoiler-title');
      if (!label) return;
      const title = await promptSpoilerTitle(label.textContent);
      if (title !== null) {
        label.textContent = title;
        content.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    const removeCode = event.target.closest('.editor-code-delete');
    if (removeCode) {
      event.preventDefault();
      const block = removeCode.closest('.code-block');
      if (!block || !content.contains(block)) return;
      let next = block.nextElementSibling;
      if (!next?.matches('p')) {
        next = document.createElement('p');
        next.append(document.createElement('br'));
        block.after(next);
      }
      block.remove();
      content.focus();
      const range = document.createRange(), selection = getSelection();
      range.selectNodeContents(next);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      content.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const externalCard = event.target.closest('.external-link-card');
    if (externalCard) {
      event.preventDefault();
      return;
    }
    const format = event.target.closest('.code-format-label');
    if (format) {
      const block = format.closest('.code-block'),
        current = format.dataset.language || 'text';
      if (!block) return;
      const choice = await Swal.fire({
        title: t('Formato del código', 'Code format'),
        input: 'select',
        inputOptions: Object.fromEntries(codeLanguages),
        inputValue: current,
        showCancelButton: true,
        buttonsStyling: false,
        customClass: {
          popup: 'wiki-swal-popup',
          title: 'wiki-swal-title',
          confirmButton: 'primary-button',
          cancelButton: 'secondary-button',
        },
        confirmButtonText: t('Guardar', 'Save'),
        cancelButtonText: t('Cancelar', 'Cancel'),
      });
      if (choice.isConfirmed) {
        const selected = codeLanguages.find(([id]) => id === choice.value);
        format.dataset.language = choice.value;
        format.textContent = selected?.[1] || choice.value;
        const code = block.querySelector('pre code');
        if (code) {
          code.className = 'language-' + choice.value;
          highlightCodeBlock(block);
        }
        state.dirty = true;
      }
      return;
    }
    if (event.target.closest('.table-edge-plus')) return;
  });
  let tableEdgeContext = null;
  content.addEventListener('pointermove', (event) => {
    if (event.target.closest('.table-edge-plus')) return;
    const cell = event.target.closest('td,th');
    if (!cell) {
      content.querySelector('.table-edge-plus')?.remove();
      tableEdgeContext = null;
      return;
    }
    const cellRect = cell.getBoundingClientRect(),
      table = cell.closest('table'),
      tableRect = table.getBoundingClientRect(),
      contentRect = content.getBoundingClientRect(),
      nearRight = cellRect.right - event.clientX >= 0 && cellRect.right - event.clientX < 9,
      nearBottom = cellRect.bottom - event.clientY >= 0 && cellRect.bottom - event.clientY < 9;
    if (!nearRight && !nearBottom) {
      content.querySelector('.table-edge-plus')?.remove();
      tableEdgeContext = null;
      return;
    }
    const axis = nearRight ? 'column' : 'row',
      button = content.querySelector('.table-edge-plus') || document.createElement('button');
    button.type = 'button';
    button.className = 'table-edge-plus';
    button.textContent = '+';
    button.setAttribute(
      'aria-label',
      axis === 'column' ? t('Añadir columna', 'Add column') : t('Añadir fila', 'Add row'),
    );
    button.style.left =
      (axis === 'column' ? cellRect.right : tableRect.left + tableRect.width / 2) -
      contentRect.left +
      content.scrollLeft -
      11 +
      'px';
    button.style.top =
      (axis === 'column' ? tableRect.top + tableRect.height / 2 : cellRect.bottom) -
      contentRect.top +
      content.scrollTop -
      11 +
      'px';
    if (!button.isConnected) content.append(button);
    tableEdgeContext = { table, cell, axis };
    button.onclick = (click) => {
      click.preventDefault();
      click.stopPropagation();
      const context = tableEdgeContext;
      if (!context) return;
      const { table, cell, axis } = context;
      if (axis === 'column') {
        for (const row of table.rows) {
          const cellNode = document.createElement(row.parentElement.tagName === 'THEAD' ? 'th' : 'td');
          cellNode.textContent =
            row.parentElement.tagName === 'THEAD' ? t('Encabezado', 'Header') : t('Contenido', 'Content');
          row.insertBefore(cellNode, row.cells[cell.cellIndex + 1] || null);
        }
      } else {
        const body = table.tBodies[0] || table.createTBody(),
          rowIndex =
            cell.parentElement.parentElement.tagName === 'THEAD'
              ? 0
              : Math.max(0, cell.parentElement.rowIndex - 1),
          row = body.insertRow(Math.min(rowIndex, body.rows.length));
        for (let col = 0; col < table.rows[0].cells.length; col++) {
          const newCell = row.insertCell();
          newCell.textContent = t('Contenido', 'Content');
        }
      }
      state.dirty = true;
      content.querySelector('.table-edge-plus')?.remove();
      tableEdgeContext = null;
    };
  });
  content.addEventListener('pointerleave', () => {
    content.querySelector('.table-edge-plus')?.remove();
    tableEdgeContext = null;
  });
  const uploadImageInput = $('#uploadImage');
  if (uploadImageInput)
    uploadImageInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const body = new FormData();
        body.append('image', file);
        const altResult = await Swal.fire({
          title: t('Texto alternativo', 'Alternative text'),
          input: 'text',
          inputLabel: t('Describe la imagen para accesibilidad', 'Describe the image for accessibility'),
          inputPlaceholder: t('Descripción breve', 'Short description'),
          showCancelButton: true,
          confirmButtonText: t('Subir', 'Upload'),
          cancelButtonText: t('Cancelar', 'Cancel'),
        });
        if (!altResult.isConfirmed) return;
        body.append('alt', altResult.value || '');
        const response = await request('/api/admin/uploads', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf },
          body,
        });
        const data = await imageUploadResponse(response);
        restoreRange();
        insertImageAndFocus(content, `<img src="${esc(data.url)}" alt="${esc(data.alt || '')}">`);
        state.dirty = true;
      } catch (err) {
        showError(editor, err);
      }
    };
  $('#savePage').onclick = async (event) => {
    event.preventDefault();
    const saveButton = $('#savePage'),
      finishLoading = beginButtonLoading(saveButton);
    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      draftTitles[language.value] = $('#editTitle').value.trim();
      draftContent[language.value] = source.hidden ? editorContentHtml(content) : source.value;
      const titles = Object.fromEntries(
          Object.entries(draftTitles)
            .map(([lang, value]) => [lang, String(value || '').trim()])
            .filter(([, value]) => value),
        ),
        contents = Object.fromEntries(
          Object.entries(draftContent)
            .map(([lang, value]) => [lang, String(value || '')])
            .filter(([, value]) => value.trim()),
        );
      const pageType = $('#editPageType').value;
      if (!Object.keys(titles).length)
        throw validationError(
          t('Agrega un título en al menos un idioma.', 'Add a title in at least one language.'),
        );
      if (pageType === 'content' && !Object.keys(contents).length)
        throw validationError(
          t('Agrega contenido en al menos un idioma.', 'Add content in at least one language.'),
        );
      if (pageType === 'redirect' && !$('#redirectUrl').value.trim())
        throw validationError(t('Ingresa la URL de destino.', 'Enter the destination URL.'));
      const slug = currentSlug || slugFrom(titles[state.lang] || Object.values(titles)[0]);
      const saveSpace = state.space,
        saved = await api(`/api/admin/pages/${encodeURIComponent(slug)}`, {
          method: 'PUT',
          headers: { 'X-Wiki-Space': saveSpace },
          body: JSON.stringify({
            titles,
            content: pageType === 'content' ? contents : {},
            icon: $('#editIconMode').value === 'image' ? $('#editIconImagePath').value : $('#editIcon').value,
            pageType,
            redirectUrl: pageType === 'redirect' ? $('#redirectUrl').value.trim() : null,
            categoryId: pageType === 'content' ? $('#editCategory').value || null : null,
          }),
        });
      if (!saved.ok || saved.slug !== slug || saved.space !== saveSpace)
        throw new Error(
          t(
            'El servidor no confirmó el guardado de la página en el espacio seleccionado.',
            'The server did not confirm saving this page in the selected space.',
          ),
        );
      state.dirty = false;
      editor.hidden = true;
      document.body.classList.remove('editor-mode');
      $('#toc').hidden = true;
      setNotice(t('Página guardada.', 'Page saved.'));
      try {
        const refreshed = await api('/api/pages', { headers: { 'X-Wiki-Space': saveSpace } });
        if (state.space !== saveSpace)
          throw new Error(
            t('El espacio de trabajo cambió durante el guardado.', 'The workspace changed while saving.'),
          );
        state.pages = refreshed.pages;
        state.categories = refreshed.categories;
        state.homePageSlug = refreshed.homePageSlug || null;
        renderNav();
        renderPageRows(root);
      } catch (refreshError) {
        setNotice(
          t(
            'La página se guardó, pero no se pudo actualizar la lista. Recarga para ver los cambios.',
            'The page was saved, but the list could not refresh. Reload to see the changes.',
          ),
          'error',
        );
      }
    } catch (error) {
      showError(editor, error);
    } finally {
      finishLoading();
    }
  };
  $('#cancelEditor').onclick = async () => {
    if (!(await confirmUnsaved())) return;
    state.dirty = false;
    editor.hidden = true;
    document.body.classList.remove('editor-mode');
    $('#toc').hidden = true;
  };
}
async function backupsTab(root) {
  const result = await api('/api/admin/backups'),
    permissions = result.permissions || {},
    formatDate = (value, timeZone = result.timeZone || 'America/Guayaquil') =>
      new Intl.DateTimeFormat(state.lang === 'es' ? 'es-EC' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      }).format(new Date(value)),
    availableZones =
      Array.isArray(result.timeZones) && result.timeZones.length
        ? result.timeZones
        : [
            ...new Set([
              'UTC',
              ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []),
            ]),
          ].sort(),
    selectedZone = availableZones.includes(result.timeZone)
      ? result.timeZone
      : availableZones.includes('America/Guayaquil')
        ? 'America/Guayaquil'
        : availableZones[0],
    zoneOptions = availableZones
      .map(
        (zone) =>
          '<option value="' +
          esc(zone) +
          '" ' +
          (zone === selectedZone ? 'selected' : '') +
          '>' +
          esc(zone) +
          '</option>',
      )
      .join('');
  let currentPage = 1;
  const rows = () => {
    const list = result.backups || [],
      pages = Math.max(1, Math.ceil(list.length / 5)),
      visible = list.slice((currentPage - 1) * 5, currentPage * 5);
    return visible.length
      ? visible
          .map(
            (item) =>
              '<div class="backup-row"><div class="backup-row-info"><strong>' +
              esc(formatDate(item.createdAt)) +
              '</strong><small>' +
              esc(item.name + '.zip') +
              '</small></div>' +
              (permissions.export
                ? '<a class="secondary-button" href="/api/admin/backups/' +
                  encodeURIComponent(item.name) +
                  '/export" download="' +
                  esc(item.name) +
                  '.zip" title="' +
                  t('Exportar backup', 'Export backup') +
                  '"><i class="fa-solid fa-arrow-down"></i> ' +
                  t('Exportar', 'Export') +
                  '</a>'
                : '') +
              '</div>',
          )
          .join('')
      : '<p class="empty-state">' +
          t('Todavía no hay copias de seguridad.', 'No backups have been created yet.') +
          '</p>';
  };
  root.innerHTML =
    '<section class="admin-section backup-schedule-section"><div><h2>' +
    t('Programación y retención', 'Schedule and retention') +
    '</h2><p>' +
    t(
      'El horario de ejecución usa la zona horaria elegida. La retención elimina las copias más antiguas.',
      'Scheduled runs use the selected time zone. Retention deletes the oldest backups.',
    ) +
    '</p></div><div class="backup-settings-grid">' +
    (permissions.schedule
      ? '<label class="backup-timezone-field"><span class="admin-label">' +
        t('Zona horaria', 'Time zone') +
        '</span><select class="settings-input" id="backupTimeZone">' +
        zoneOptions +
        '</select><small>' +
        t(
          'El próximo backup se calculará con esta zona.',
          'The next backup will be scheduled in this zone.',
        ) +
        '</small></label><label><span class="admin-label">' +
        t('Máximo de backups', 'Maximum backups') +
        ' <strong id="backupRetentionValue">' +
        esc(result.retention) +
        '</strong></span><input id="backupRetention" type="range" min="1" max="30" step="1" value="' +
        esc(result.retention) +
        '"><small>' +
        t('Se conservarán los más recientes.', 'The newest backups will be kept.') +
        '</small></label><label><span class="admin-label">CRON</span><input class="settings-input" id="backupCron" maxlength="100" value="' +
        esc(result.cron) +
        '" placeholder="0 2 * * *"><small>' +
        t('Siguiente ejecución: ', 'Next run: ') +
        esc(formatDate(result.nextRunAt)) +
        '</small></label>'
      : '<p>' +
        t(
          'No tienes permiso para cambiar programación y retención.',
          'You cannot edit the schedule or retention.',
        ) +
        '</p>') +
    '</div><details class="cron-cheatsheet"><summary>' +
    t('CRON cheatsheet', 'CRON cheatsheet') +
    '</summary><p>' +
    t(
      'Formato: minuto hora día-del-mes mes día-de-semana. Se aceptan *, pasos */n, rangos y listas con comas.',
      'Format: minute hour day-of-month month day-of-week. Supports *, */n steps, ranges, and comma-separated lists.',
    ) +
    '</p><ul><li><code>0 2 * * *</code> — ' +
    t('Todos los días a las 02:00', 'Every day at 02:00') +
    '</li><li><code>30 4 * * 1</code> — ' +
    t('Cada lunes a las 04:30', 'Every Monday at 04:30') +
    '</li><li><code>0 */6 * * *</code> — ' +
    t('Cada 6 horas', 'Every 6 hours') +
    '</li><li><code>0 2 1 * *</code> — ' +
    t('El primer día de cada mes a las 02:00', 'At 02:00 on the first day of every month') +
    '</li></ul><small>' +
    t(
      'El horario usa cinco campos estándar; el día de semana usa 0–7 (domingo 0 o 7).',
      'The schedule uses five standard fields; weekday uses 0–7 (Sunday is 0 or 7).',
    ) +
    '</small></details>' +
    (permissions.schedule
      ? '<button class="primary-button" id="saveBackupSchedule"><i class="fa-solid fa-floppy-disk"></i> ' +
        t('Guardar programación', 'Save schedule') +
        '</button>'
      : '') +
    '</section><section class="admin-section backup-list-section"><div class="section-heading"><div><h2>' +
    t('Copias recientes', 'Recent backups') +
    '</h2><p>' +
    t(
      'La más reciente aparece primero. Se muestran hasta cinco por página.',
      'Newest first. Up to five backups are shown per page.',
    ) +
    '</p></div><span class="category-count">' +
    (result.backups || []).length +
    ' / ' +
    esc(result.retention) +
    '</span></div><div id="backupRows">' +
    rows() +
    '</div><div class="backup-pagination" id="backupPagination"></div></section><section class="admin-section backup-import-section"><div><h2>' +
    t('Importar backup', 'Import backup') +
    '</h2><p>' +
    t(
      'Sube un ZIP exportado por esta wiki. Se restaurarán los datos y las imágenes. El servidor y su configuración local no se reemplazan.',
      'Upload a ZIP exported by this wiki. Data and images are restored. Server code and local configuration are not replaced.',
    ) +
    '</p></div>' +
    (permissions.import
      ? '<form id="backupImportForm"><label class="backup-file-input"><i class="fa-solid fa-file-zipper"></i><span>' +
        t('Seleccionar backup ZIP', 'Select backup ZIP') +
        '</span><input id="backupFile" type="file" accept=".zip,application/zip" required></label><button class="danger-button" type="submit" id="importBackup"><i class="fa-solid fa-arrow-up"></i> ' +
        t('Importar backup', 'Import backup') +
        '</button></form>'
      : '<p>' + t('No tienes permiso para importar backups.', 'You cannot import backups.') + '</p>') +
    '</section>';
  const renderPagination = () => {
    const list = result.backups || [],
      pages = Math.max(1, Math.ceil(list.length / 5)),
      pager = $('#backupPagination', root);
    if (!pager) return;
    pager.innerHTML =
      pages > 1
        ? '<button type="button" class="secondary-button" data-backup-page="prev" ' +
          (currentPage === 1 ? 'disabled' : '') +
          '>' +
          t('Anterior', 'Previous') +
          '</button><span>' +
          currentPage +
          ' / ' +
          pages +
          '</span><button type="button" class="secondary-button" data-backup-page="next" ' +
          (currentPage === pages ? 'disabled' : '') +
          '>' +
          t('Siguiente', 'Next') +
          '</button>'
        : '';
    pager.onclick = (event) => {
      const action = event.target.closest('[data-backup-page]')?.dataset.backupPage;
      if (!action) return;
      currentPage += action === 'next' ? 1 : -1;
      $('#backupRows', root).innerHTML = rows();
      renderPagination();
    };
  };
  renderPagination();
  $('#backupRetention', root)?.addEventListener(
    'input',
    (event) => ($('#backupRetentionValue', root).textContent = event.target.value),
  );
  $('#saveBackupSchedule', root)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const saved = await api('/api/admin/backups/schedule', {
        method: 'PUT',
        body: JSON.stringify({
          cron: $('#backupCron', root).value.trim(),
          retention: Number($('#backupRetention', root).value),
          timeZone: $('#backupTimeZone', root).value,
        }),
      });
      await notify({
        icon: 'success',
        title: t('Programación guardada', 'Schedule saved'),
        text: t('Próxima ejecución: ', 'Next run: ') + formatDate(saved.nextRunAt, saved.timeZone),
      });
      await adminView('backups');
    } catch (error) {
      showError(root, error);
    } finally {
      button.disabled = false;
    }
  });
  $('#backupImportForm', root)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = $('#backupFile', root).files[0];
    if (!file) return;
    const confirmation = await Swal.fire({
      icon: 'warning',
      title: t('¿Importar y restaurar este backup?', 'Import and restore this backup?'),
      text: t(
        'Los datos actuales de la wiki serán reemplazados y se cerrará la sesión al terminar.',
        'Current wiki data will be replaced and your session will end after import.',
      ),
      showCancelButton: true,
      confirmButtonText: t('Restaurar backup', 'Restore backup'),
      cancelButtonText: t('Cancelar', 'Cancel'),
      reverseButtons: true,
    });
    if (!confirmation.isConfirmed) return;
    const button = $('#importBackup', root);
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + t('Importando…', 'Importing…');
    try {
      const body = new FormData();
      body.append('backup', file);
      const response = await request('/api/admin/backups/import', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-CSRF-Token': state.csrf },
          body,
        }),
        data = await response
          .json()
          .catch(() => ({ error: t('Respuesta inválida del servidor.', 'Invalid server response.') }));
      if (!response.ok)
        throw responseError(response, data.error || t('No se pudo importar el backup.', 'Backup import failed.'));
      await notify({
        icon: 'success',
        title: t('Backup restaurado', 'Backup restored'),
        text: t(
          'Se restauraron los datos y las imágenes. Vuelve a iniciar sesión.',
          'Data and images were restored. Sign in again.',
        ),
      });
      location.assign('/login');
    } catch (error) {
      showError(root, error);
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="fa-solid fa-arrow-up"></i> ' + t('Importar backup', 'Import backup');
    }
  });
}
function slugFrom(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 150);
}
const codeLanguages = [
  ['yaml', 'YAML'],
  ['json', 'JSON'],
  ['properties', 'Java Properties'],
  ['toml', 'TOML'],
  ['ini', 'INI / Config'],
  ['env', 'Environment Variables'],
  ['xml', 'XML'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['scss', 'SCSS'],
  ['less', 'LESS'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['php', 'PHP'],
  ['python', 'Python'],
  ['bash', 'Bash / Shell Script'],
  ['batch', 'Windows Batch'],
  ['lua', 'Lua'],
  ['java', 'Java'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['ruby', 'Ruby'],
  ['perl', 'Perl'],
  ['sql', 'SQL'],
  ['text', 'Texto Plano'],
  ['markdown', 'Markdown'],
  ['dockerfile', 'Dockerfile'],
  ['git', 'Git'],
  ['log', 'Log'],
];
function highlightCodeBlock(block) {
  const code = block?.querySelector('pre code');
  if (!code) return;
  const language = block.querySelector('.code-format-label')?.dataset.language || 'text',
    source = codeBlockText(code),
    prism = window.Prism,
    grammar = language === 'env' ? 'bash' : language;
  code.textContent = source;
  if (language === 'text' || source.length > 200000) return;
  if (!prism || !prism.languages[grammar]) {
    console.error('[Teralth Wiki] Code syntax highlighter unavailable for language:', language);
    return;
  }
  code.innerHTML = prism.highlight(source, prism.languages[grammar], grammar);
}
function codeBlockText(code) {
  const read = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName === 'BR') return '\n';
    const children = [...node.childNodes];
    if (/^(DIV|P)$/.test(node.tagName) && children.length === 1 && children[0].nodeName === 'BR') return '';
    let text = '', previousBlock = false;
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && /^(DIV|P)$/.test(child.tagName);
      if (index && (isBlock || (previousBlock && child.nodeName !== 'BR'))) text += '\n';
      text += read(child);
      previousBlock = isBlock;
    });
    return text;
  };
  return read(code);
}
function editorToolbarMarkup() {
  const english = {
      Negrita: 'Bold',
      Cursiva: 'Italic',
      Subrayado: 'Underline',
      Tachado: 'Strikethrough',
      'Color de letra': 'Text color',
      'Fuente de letra': 'Font family',
      'Resaltar texto': 'Highlight text',
      Encabezado: 'Heading',
      'Eliminar formato': 'Clear formatting',
      'Lista numerada': 'Numbered list',
      'Lista con viñetas': 'Bulleted list',
      Checkbox: 'Checkbox',
      'Añadir sangría': 'Indent',
      'Eliminar sangría': 'Outdent',
      Éxito: 'Success',
      Información: 'Info',
      Advertencia: 'Warning',
      Error: 'Error',
      'Enlace externo': 'External link',
      'Insertar cita': 'Insert quote',
      Spoiler: 'Spoiler',
      'Alinear texto': 'Align text',
      Izquierda: 'Left',
      Centrado: 'Center',
      Derecha: 'Right',
      Justificar: 'Justify',
      'Insertar enlace': 'Insert link',
      'Eliminar enlace': 'Remove link',
      'Insertar tabla': 'Insert table',
      'Caracteres especiales': 'Special characters',
      'Insertar emoji': 'Insert emoji',
      Código: 'Inline code',
      'Bloque de código': 'Code block',
      'Insertar imagen': 'Insert image',
      'Video de YouTube': 'YouTube video',
      Deshacer: 'Undo',
      Rehacer: 'Redo',
    },
    tr = (label) => t(label, english[label] || label),
    button = (command, icon, label, extra = '') =>
      `<button type="button" data-command="${command}" title="${tr(label)}" aria-label="${tr(label)}" ${extra}><i class="${icon.includes(' ') ? icon : 'fa-solid ' + icon}"></i></button>`,
    group = (items) => `<span class="editor-tool-group">${items}</span>`,
    select = (tool, icon, label, options) =>
      `<label class="editor-tool-select" title="${tr(label)}"><i class="fa-solid ${icon}"></i><select data-tool="${tool}" aria-label="${tr(label)}">${options}</select></label>`,
    divider = '<span class="editor-toolbar-divider" aria-hidden="true"></span>';
  return [
    group(
      button('bold', 'fa-bold', 'Negrita') +
        button('italic', 'fa-italic', 'Cursiva') +
        button('underline', 'fa-underline', 'Subrayado') +
        button('strike', 'fa-strikethrough', 'Tachado'),
    ),
    group(
      button('text-color', 'fa-palette', 'Color de letra') +
        select(
          'font',
          'fa-font',
          'Fuente de letra',
          [
            '<option value="">' + t('Por defecto', 'Default') + '</option>',
            ...[
              'Arial',
              'Courier New',
              'Georgia',
              'Lucida Sans Unicode',
              'Tahoma',
              'Times New Roman',
              'Trebuchet MS',
              'Verdana',
            ].map((value) => `<option>${value}</option>`),
          ].join(''),
        ) +
        button('highlight', 'fa-highlighter', 'Resaltar texto') +
        select(
          'heading',
          'fa-text-height',
          'Encabezado',
          [
            '<option value="p">P</option>',
            ...Array.from({ length: 6 }, (_, i) => `<option value="h${i + 1}">H${i + 1}</option>`),
          ].join(''),
        ) +
        button('clear-format', 'fa-text-slash', 'Eliminar formato'),
    ),
    group(
      button('insertOrderedList', 'fa-list-ol', 'Lista numerada') +
        button('insertUnorderedList', 'fa-list-ul', 'Lista con viñetas') +
        button('check', 'fa-square-check', 'Checkbox'),
    ),
    group(
      button('indent', 'fa-indent', 'Añadir sangría') + button('outdent', 'fa-outdent', 'Eliminar sangría'),
    ),
    group(
      button('hint-success', 'fa-circle-check', 'Éxito') +
        button('hint-info', 'fa-circle-info', 'Información') +
        button('hint-warning', 'fa-circle-exclamation', 'Advertencia') +
        button('hint-error', 'fa-circle-xmark', 'Error') +
        button('external-card', 'fa-square-up-right', 'Enlace externo') +
        button('quote', 'fa-quote-left', 'Insertar cita'),
    ),
    group(
      button('spoiler', 'fa-eye-slash', 'Spoiler') +
      select(
        'alignment',
        'fa-align-left',
        'Alinear texto',
        [
          '<option value="left">' + t('Izquierda', 'Left') + '</option>',
          '<option value="center">' + t('Centrado', 'Center') + '</option>',
          '<option value="right">' + t('Derecha', 'Right') + '</option>',
          '<option value="justify">' + t('Justificar', 'Justify') + '</option>',
        ].join(''),
      ) +
        button('link', 'fa-link', 'Insertar enlace') +
        button('unlink', 'fa-link-slash', 'Eliminar enlace', 'disabled'),
    ),
    group(
      button('table', 'fa-table', 'Insertar tabla') +
        button('special-chars', 'fa-s', 'Caracteres especiales') +
        button('emoji', 'fa-face-grin', 'Insertar emoji') +
        button('inlineCode', 'fa-code', 'Código') +
        button('code', 'fa-terminal', 'Bloque de código'),
    ),
    group(
      button('image', 'fa-image', 'Insertar imagen') +
        button('youtube', 'fa-brands fa-youtube', 'Video de YouTube'),
    ),
    group(
      button('undo', 'fa-rotate-left', 'Deshacer', 'disabled') +
        button('redo', 'fa-rotate-right', 'Rehacer', 'disabled'),
    ),
    group(
      `<button type="button" data-source-toggle title="${t('Ver en formato código', 'View as code')}"><i class="fa-solid fa-eye"></i><span>${t('Ver código', 'View Code')}</span></button>`,
    ),
  ].join(divider);
}
function runEditorAdvancedTool(tool, content) {
  content.focus();
  const selection = getSelection(),
    savedSelectionRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null,
    restoreSavedSelection = () => {
      if (!savedSelectionRange) return;
      const current = getSelection();
      current.removeAllRanges();
      current.addRange(savedSelectionRange);
    };
  if (tool === 'heading') {
    document.execCommand('formatBlock', false, $('.editor-toolbar [data-tool="heading"]').value);
    return;
  }
  if (tool === 'alignment') {
    const alignment = $('.editor-toolbar [data-tool="alignment"]').value,
      media = content.querySelector('.editor-media-selected');
    if (media) {
      const image = media.matches('img') ? media : media.querySelector('img'),
        alignedTarget = image || media;
      for (const node of [media, alignedTarget]) {
        if (!node) continue;
        node.classList.remove('editor-align-left', 'editor-align-center', 'editor-align-right', 'editor-align-justify');
        node.classList.add('editor-align-' + alignment);
      }
      content.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    document.execCommand(
      'justify' +
        ({ left: 'Left', center: 'Center', right: 'Right', justify: 'Full' }[
          alignment
        ] || 'Left'),
    );
    return;
  }
  if (tool === 'font') {
    const font = $('.editor-toolbar [data-tool="font"]').value;
    document.execCommand('styleWithCSS', false, true);
    if (font) document.execCommand('fontName', false, font);
    else document.execCommand('removeFormat');
    document.execCommand('styleWithCSS', false, false);
    return;
  }
  if (tool === 'undo' || tool === 'redo') {
    document.execCommand(tool === 'undo' ? 'undo' : 'redo');
    return;
  }
  if (tool === 'indent' || tool === 'outdent') {
    setEditorIndent(content, tool === 'indent');
    return;
  }
  if (tool === 'unlink') {
    document.execCommand('unlink');
    return;
  }
  if (tool === 'clear-format') {
    if (selection?.isCollapsed) leaveInlineFormattingAtCaret(content);
    document.execCommand('removeFormat');
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, 'inherit');
    document.execCommand('hiliteColor', false, 'transparent');
    document.execCommand('fontName', false, 'inherit');
    document.execCommand('styleWithCSS', false, false);
    return;
  }
  if (tool === 'special-chars' || tool === 'emoji') {
    const emojis = [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '😂',
      '🙂',
      '🙃',
      '😉',
      '😊',
      '😍',
      '🥰',
      '😎',
      '🤔',
      '😭',
      '😡',
      '👍',
      '👎',
      '👏',
      '🙏',
      '❤️',
      '🔥',
      '🎉',
      '✅',
      '⚠️',
      '🚀',
      '📚',
    ];
    const chars = [
      '€',
      '£',
      '¥',
      '¢',
      '§',
      '¶',
      '©',
      '®',
      '™',
      '°',
      '±',
      '×',
      '÷',
      '≠',
      '≤',
      '≥',
      '∞',
      '√',
      '∑',
      'π',
      'µ',
      'Ω',
      'α',
      'β',
      'γ',
      'δ',
      '→',
      '←',
      '↑',
      '↓',
      '↔',
      '…',
      '—',
      '–',
      '“',
      '”',
      '‘',
      '’',
      '•',
      '†',
      '‡',
    ];
    const values = tool === 'emoji' ? emojis : chars;
    Swal.fire({
      title:
        tool === 'emoji'
          ? t('Insertar emoji', 'Insert emoji')
          : t('Caracteres especiales', 'Special characters'),
      html: `<div class="editor-symbol-grid ${tool === 'emoji' ? 'emoji-grid' : 'special-char-grid'}">${values
        .map((value) =>
          tool === 'emoji'
            ? `<button type="button" data-symbol="${value}" title="${value}"><img loading="lazy" src="https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@15.1.0/color/svg/${[
                ...value,
              ]
                .map((char) => char.codePointAt(0))
                .filter((code) => code !== 0xfe0f && code !== 0xfe0e)
                .map((code) => code.toString(16).toUpperCase())
                .join('-')}.svg" alt=""> <span>${value}</span></button>`
            : `<button type="button" data-symbol="${value}">${value}</button>`,
        )
        .join(
          '',
        )}</div>${tool === 'emoji' ? '<small class=\"openmoji-credit\"><a href=\"https://openmoji.org/\" target=\"_blank\" rel=\"noopener noreferrer\">OpenMoji · CC BY-SA 4.0</a></small>' : ''}`,
      showConfirmButton: false,
      showCloseButton: true,
      customClass: { popup: 'wiki-swal-popup editor-swal-popup' },
    });
    Swal.getPopup()
      ?.querySelectorAll('[data-symbol]')
      .forEach(
        (button) =>
          (button.onclick = () => {
            content.focus();
            document.execCommand('insertText', false, button.dataset.symbol);
            Swal.close();
          }),
      );
    return;
  }
  if (tool === 'text-color' || tool === 'highlight') {
    const property = tool === 'text-color' ? 'color' : 'background-color',
      palette = [
        '#000000',
        '#555555',
        '#999999',
        '#dddddd',
        '#ffffff',
        '#e74848',
        '#ee9b42',
        '#e7d94b',
        '#86cf45',
        '#38d65c',
        '#43dca4',
        '#46d8d8',
        '#438ee8',
        '#5949e8',
        '#a142e8',
      ];
    Swal.fire({
      title:
        tool === 'text-color' ? t('Color de letra', 'Text color') : t('Resaltado de texto', 'Text highlight'),
      html: `<div class="editor-color-grid">${palette.map((color) => `<button type="button" class="editor-color-swatch" data-color="${color}" style="--swatch:${color}" aria-label="${color}"></button>`).join('')}</div><label class="editor-color-custom">${t('Selector de color', 'Color picker')}<input type="color" data-custom-color value="#526dff"></label><button type="button" class="secondary-button editor-remove-color">${t('Quitar color', 'Remove color')}</button>`,
      showConfirmButton: false,
      showCloseButton: true,
      customClass: { popup: 'wiki-swal-popup editor-swal-popup' },
    });
    const popup = Swal.getPopup();
    const apply = (color) => {
      content.focus();
      restoreSavedSelection();
      const sel = getSelection();
      if (!sel?.rangeCount) return;
      document.execCommand('styleWithCSS', false, true);
      if (sel.isCollapsed)
        document.execCommand(tool === 'text-color' ? 'foreColor' : 'hiliteColor', false, color);
      else {
        const span = document.createElement('span');
        span.setAttribute('style', property + ':' + color);
        try {
          const range = sel.getRangeAt(0);
          span.append(range.extractContents());
          range.insertNode(span);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch {}
      }
      document.execCommand('styleWithCSS', false, false);
      Swal.close();
    };
    popup
      ?.querySelectorAll('[data-color]')
      .forEach((button) => (button.onclick = () => apply(button.dataset.color)));
    popup
      ?.querySelector('[data-custom-color]')
      ?.addEventListener('change', (event) => apply(event.target.value));
    popup?.querySelector('.editor-remove-color')?.addEventListener('click', () => {
      content.focus();
      restoreSavedSelection();
      if (getSelection()?.isCollapsed) leaveInlineFormattingAtCaret(content);
      document.execCommand('removeFormat');
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(
        tool === 'text-color' ? 'foreColor' : 'hiliteColor',
        false,
        tool === 'text-color' ? 'inherit' : 'transparent',
      );
      document.execCommand('styleWithCSS', false, false);
      Swal.close();
    });
    return;
  }
  if (tool === 'image') {
    const html = `<label>${t('Método', 'Method')}<select class="swal2-input" data-image-mode><option value="url">${t('Insertar imagen mediante URL', 'Insert image by URL')}</option><option value="upload">${t('Subir imagen', 'Upload image')}</option></select></label><label class="image-url-field">URL<input class="swal2-input" data-image-url type="url" placeholder="https://"></label><label class="image-upload-field" hidden>${t('Archivo', 'File')}<input class="swal2-file" data-image-file type="file" accept="image/png,image/jpeg,image/gif,image/webp"></label><label>${t('Texto alternativo', 'Alternative text')}<input class="swal2-input" data-image-alt maxlength="300"></label>`;
    Swal.fire({
      title: t('Insertar imagen', 'Insert image'),
      html: `<div class="editor-swal-fields">${html}</div>`,
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: t('Insertar', 'Insert'),
      cancelButtonText: t('Cancelar', 'Cancel'),
      customClass: {
        popup: 'wiki-swal-popup editor-swal-popup',
        confirmButton: 'primary-button',
        cancelButton: 'secondary-button',
      },
      didOpen: () => {
        const mode = Swal.getPopup().querySelector('[data-image-mode]');
        mode.onchange = () => {
          Swal.getPopup().querySelector('.image-url-field').hidden = mode.value !== 'url';
          Swal.getPopup().querySelector('.image-upload-field').hidden = mode.value !== 'upload';
        };
      },
      preConfirm: async () => {
        const popup = Swal.getPopup(),
          mode = popup.querySelector('[data-image-mode]').value,
          alt = popup.querySelector('[data-image-alt]').value.trim();
        if (mode === 'upload') {
          const file = popup.querySelector('[data-image-file]').files[0];
          if (!file) {
            Swal.showValidationMessage(t('Selecciona una imagen.', 'Select an image.'));
            return false;
          }
          const body = new FormData();
          body.append('image', file);
          body.append('alt', alt);
          try {
            const response = await request('/api/admin/uploads', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf },
                body,
              }),
              data = await imageUploadResponse(response);
            return { url: data.url, alt };
          } catch (error) {
            if (isUserError(error)) {
              reportClientError('image-upload', error, { status: error.status });
              Swal.showValidationMessage(userErrorText(error));
            } else showCouldNotStart(error, 'image-upload');
            return false;
          }
        }
        const raw = popup.querySelector('[data-image-url]').value.trim();
        let url;
        try {
          url = new URL(raw);
          if (!['https:', 'http:'].includes(url.protocol)) throw 0;
        } catch {
          Swal.showValidationMessage(
            t('Ingresa una URL HTTP o HTTPS válida.', 'Enter a valid HTTP or HTTPS URL.'),
          );
          return false;
        }
        const image = new Image();
        image.src = url.href;
        try {
          if (image.decode) await image.decode();
          else
            await new Promise((resolve, reject) => {
              image.onload = resolve;
              image.onerror = reject;
            });
          if (!image.naturalWidth || !image.naturalHeight) throw 0;
        } catch {
          Swal.showValidationMessage(
            t('La URL no entrega una imagen compatible.', 'The URL does not return a supported image.'),
          );
          return false;
        }
        return { url: url.href, alt };
      },
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        content.focus();
        restoreSavedSelection();
        insertImageAndFocus(
          content,
          `<img src="${esc(result.value.url)}" alt="${esc(result.value.alt)}" loading="lazy">`,
        );
      }
    });
    return;
  }
}
function setEditorIndent(content, enabled) {
  let selection = getSelection();
  if (!selection?.rangeCount || !content.contains(selection.anchorNode)) return;
  let range = selection.getRangeAt(0);
  const selector = 'p,h1,h2,h3,h4,h5,h6,li,blockquote';
  let blocks = selection.isCollapsed
    ? [range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer.closest(selector)
        : range.startContainer.parentElement?.closest(selector)].filter(Boolean)
    : [...content.querySelectorAll(selector)].filter((block) => {
        try { return range.intersectsNode(block); } catch { return false; }
      });
  blocks = blocks.filter((block) => content.contains(block) && !block.closest('.hint,.code-block,.external-link-card,.editor-image-component,.editor-video-component'));
  if (!blocks.length && selection.isCollapsed) {
    document.execCommand('formatBlock', false, 'p');
    selection = getSelection();
    if (!selection?.rangeCount) return;
    range = selection.getRangeAt(0);
    const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    blocks = [anchor?.closest(selector)].filter(Boolean);
  }
  blocks.forEach((block) => {
    const container = block.closest('.editor-indent');
    if (enabled) {
      if (!container) block.classList.add('editor-indent');
    }
    else (container || block).classList.remove('editor-indent');
  });
  content.dispatchEvent(new Event('input', { bubbles: true }));
}
function editorInlineCodeToText(content) {
  content.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre,.code-block') || code.children.length || code.textContent.includes('`')) return;
    code.replaceWith(document.createTextNode('`' + code.textContent + '`'));
  });
}
function insertImageAndFocus(root, imageHtml) {
  insertAtomicEditorComponent(root, `<div class="editor-image-component">${imageHtml}</div>`);
}
function insertAtomicEditorComponent(root, componentHtml) {
  root.focus();
  const selection = getSelection();
  let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !root.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }
  const block = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer.closest?.('p,h1,h2,h3,h4,h5,h6,blockquote,li')
    : range.startContainer.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,blockquote,li');
  const componentBox = document.createElement('div');
  componentBox.innerHTML = componentHtml;
  const component = componentBox.firstElementChild;
  if (!component) return;
  component.contentEditable = 'false';
  const trailing = document.createElement('p');
  trailing.dataset.editorMediaCaret = 'true';
  trailing.append(document.createElement('br'));
  if (block && root.contains(block) && !block.closest('.hint,.code-block,.external-link-card,.editor-media-component,.editor-image-resize')) {
    const tailRange = range.cloneRange();
    tailRange.setEnd(block, block.childNodes.length);
    const tail = tailRange.extractContents();
    if (tail.textContent || tail.querySelector?.('img,iframe,br,table,ul,ol')) trailing.replaceChildren(tail);
    else if (tail.childNodes.length) trailing.replaceChildren(tail);
    block.after(component, trailing);
    if (!block.textContent.trim() && !block.querySelector('img,iframe,table,ul,ol')) block.remove();
  } else {
    range.deleteContents();
    range.insertNode(trailing);
    trailing.before(component);
  }
  prepareEditorWidgets(root);
  const paragraph = root.querySelector('p[data-editor-media-caret]') || trailing;
  paragraph.removeAttribute('data-editor-media-caret');
  prepareEditorWidgets(root);
  const caretRange = document.createRange(), activeSelection = getSelection();
  caretRange.selectNodeContents(paragraph);
  caretRange.collapse(true);
  activeSelection.removeAllRanges();
  activeSelection.addRange(caretRange);
  root.dispatchEvent(new Event('input', { bubbles: true }));
}
function editorAtomicMediaAtCaret(root, range, direction) {
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    if (direction < 0 && range.startOffset > 0) return null;
    if (direction > 0 && range.startOffset < node.nodeValue.length) return null;
  } else if (direction > 0 && range.startOffset < node.childNodes.length) {
    node = node.childNodes[range.startOffset];
  } else if (direction < 0 && range.startOffset > 0) {
    node = node.childNodes[range.startOffset - 1];
  }
  const step = (current) => {
    if (direction < 0) {
      if (current.previousSibling) {
        current = current.previousSibling;
        while (current.lastChild) current = current.lastChild;
        return current;
      }
      return current.parentNode === root ? null : current.parentNode;
    }
    if (current.nextSibling) {
      current = current.nextSibling;
      while (current.firstChild) current = current.firstChild;
      return current;
    }
    return current.parentNode === root ? null : current.parentNode;
  };
  let candidate = node;
  // From a text boundary, first step to the adjacent sibling; from an element
  // boundary, node already points at the adjacent child when one exists.
  if (node === range.startContainer && node.nodeType === Node.TEXT_NODE) candidate = step(node);
  else if (node === range.startContainer && node.nodeType === Node.ELEMENT_NODE &&
    ((direction < 0 && range.startOffset === 0) || (direction > 0 && range.startOffset === node.childNodes.length))) candidate = step(node);
  for (let count = 0; candidate && candidate !== root && count < 100; count++, candidate = step(candidate)) {
    const media = candidate.nodeType === Node.ELEMENT_NODE
      ? candidate.matches('.editor-image-component,.editor-image-resize,.editor-video-component,.video-embed')
        ? candidate
        : candidate.closest?.('.editor-image-component,.editor-image-resize,.editor-video-component,.video-embed')
      : null;
    if (media && root.contains(media)) return media;
    if (candidate.nodeType === Node.TEXT_NODE && candidate.nodeValue.trim()) return null;
    if (candidate.nodeType === Node.ELEMENT_NODE && !candidate.matches('br,p,div') && candidate.textContent.trim()) return null;
    if (candidate.nodeType === Node.ELEMENT_NODE && candidate.matches('p,div') && candidate.textContent.trim()) return null;
  }
  return null;
}
function prepareEditorWidgets(root) {
  root.querySelectorAll('.wiki-spoiler').forEach((spoiler) => {
    spoiler.open = true;
    spoiler.contentEditable = 'false';
    const summary = spoiler.querySelector(':scope > summary'),
      body = spoiler.querySelector(':scope > .spoiler-body');
    if (body) body.contentEditable = 'true';
    if (summary && !summary.querySelector('.editor-spoiler-delete')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'editor-spoiler-delete';
      button.title = t('Eliminar spoiler', 'Delete spoiler');
      button.setAttribute('aria-label', button.title);
      button.contentEditable = 'false';
      button.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
      summary.append(button);
    }
  });
  root.querySelectorAll('img').forEach((image) => {
    if (image.closest('.editor-image-resize')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'editor-image-resize';
    wrapper.contentEditable = 'false';
    image.contentEditable = 'false';
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'editor-image-resize-handle';
    handle.setAttribute('aria-label', t('Cambiar tamaño de imagen', 'Resize image'));
    handle.title = t('Arrastra para cambiar el tamaño', 'Drag to resize');
    handle.contentEditable = 'false';
    handle.innerHTML = '<span class="editor-image-resize-mark" aria-hidden="true"></span>';
    image.before(wrapper);
    wrapper.append(image, handle);
  });
  root.querySelectorAll('.video-embed').forEach((video) => {
    video.contentEditable = 'false';
    video.classList.add('editor-media-component', 'editor-video-component');
    if (!video.querySelector('.editor-image-resize-handle')) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'editor-image-resize-handle';
      handle.setAttribute('aria-label', t('Cambiar tamaño del video', 'Resize video'));
      handle.title = t('Arrastra para cambiar el tamaño', 'Drag to resize');
      handle.contentEditable = 'false';
      handle.innerHTML = '<span class="editor-image-resize-mark" aria-hidden="true"></span>';
      video.append(handle);
    }
  });
  normalizeEditorMediaBoundaries(root);
  root.querySelectorAll('.hint').forEach((block) => {
    block.removeAttribute('contenteditable');
    const icon = block.querySelector('.hint-icon');
    if (icon) icon.contentEditable = 'false';
    const body = block.querySelector('.hint-body');
    if (body) body.contentEditable = 'true';
    block.onclick = (event) => {
      if (event.target.closest('.hint-body')) return;
      event.preventDefault();
      if (!body) return;
      root.focus();
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };
  });
  normalizeHintContents(root);
  root.querySelectorAll('.code-block').forEach((block) => {
    block.contentEditable = 'false';
    const code = block.querySelector('pre code');
    if (code) code.contentEditable = 'true';
    const heading = block.querySelector('.code-block-heading');
    if (heading && !heading.querySelector('.editor-code-delete')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'editor-code-delete';
      button.title = t('Eliminar bloque de código', 'Delete code block');
      button.setAttribute('aria-label', button.title);
      button.contentEditable = 'false';
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-trash';
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
      heading.append(button);
    }
    block
      .querySelectorAll('.code-format-label,.code-copy-button')
      .forEach((control) => (control.contentEditable = 'false'));
  });
  root.querySelectorAll('.external-link-card').forEach((card) => {
    card.contentEditable = 'false';
    card.querySelectorAll('i').forEach((icon) => (icon.contentEditable = 'false'));
    card.querySelectorAll('strong,small').forEach((text) => (text.contentEditable = 'true'));
  });
  root.querySelectorAll('blockquote').forEach((block) => {
    block.contentEditable = 'false';
    block.querySelectorAll('p').forEach((text) => (text.contentEditable = 'true'));
  });
}
function normalizeHintContents(root) {
  const prefixes = {
    info: /^(?:info|informaci[oó]n)\s*:/i,
    success: /^(?:success|[eé]xito)\s*:/i,
    warning: /^(?:warning|advertencia)\s*:/i,
    error: /^(?:error)\s*:/i,
  };
  root.querySelectorAll('.hint').forEach((hint) => {
    const kind = Object.keys(prefixes).find((name) => hint.classList.contains(name)),
      body = hint.querySelector('.hint-body'),
      next = hint.nextElementSibling;
    if (!kind || !body || body.textContent.trim() || body.querySelector('img,table,iframe') || !next?.matches('p')) return;
    if (!prefixes[kind].test(next.textContent.trim())) return;
    body.replaceChildren(...next.childNodes);
    next.remove();
  });
}
function normalizeEditorMediaBoundaries(root) {
  const widgets = [...root.querySelectorAll('.editor-image-component,.editor-image-resize,.video-embed')]
    .filter((widget) => !(widget.matches('.editor-image-resize') && widget.closest('.editor-image-component')));
  widgets.forEach((widget) => {
    const parent = widget.parentElement;
    if (!parent || !root.contains(parent)) return;
    if (parent.matches('p')) {
      const before = parent.cloneNode(false), after = parent.cloneNode(false);
      let destination = before;
      [...parent.childNodes].forEach((child) => {
        if (child === widget) destination = after;
        else destination.append(child);
      });
      const hasContent = (paragraph) => [...paragraph.childNodes].some((child) =>
        child.nodeType === Node.TEXT_NODE ? Boolean(child.nodeValue.trim()) : !child.matches?.('br'));
      const replacement = document.createDocumentFragment();
      if (hasContent(before)) replacement.append(before);
      replacement.append(widget);
      if (hasContent(after)) replacement.append(after);
      parent.replaceWith(replacement);
    }
    const host = widget.parentElement;
    if (!host) return;
    if (!widget.previousElementSibling?.matches('p')) {
      const paragraph = document.createElement('p');
      paragraph.append(document.createElement('br'));
      widget.before(paragraph);
    }
    if (!widget.nextElementSibling?.matches('p')) {
      const paragraph = document.createElement('p');
      paragraph.append(document.createElement('br'));
      widget.after(paragraph);
    }
  });
}
function leaveInlineFormattingAtCaret(root) {
  const selection = getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return;
  for (let pass = 0; pass < 8; pass++) {
    const range = selection.getRangeAt(0),
      node =
        range.startContainer?.nodeType === Node.ELEMENT_NODE
          ? range.startContainer
          : range.startContainer?.parentElement,
      wrapper = node?.closest?.('b,strong,i,em,u,s,del,span[style]');
    if (!wrapper || !root.contains(wrapper)) break;
    const trailingRange = document.createRange();
    trailingRange.selectNodeContents(wrapper);
    try {
      trailingRange.setStart(range.startContainer, range.startOffset);
    } catch {
      break;
    }
    const trailing = trailingRange.extractContents();
    if (trailing.childNodes.length) {
      const clone = wrapper.cloneNode(false);
      clone.append(trailing);
      wrapper.after(clone);
    }
    const next = document.createRange();
    next.setStartAfter(wrapper);
    next.collapse(true);
    selection.removeAllRanges();
    selection.addRange(next);
  }
}
function editorContentHtml(content) {
  const clone = content.cloneNode(true);
  clone.querySelectorAll('.editor-code-delete,.editor-spoiler-delete').forEach((node) => node.remove());
  clone.querySelectorAll('.wiki-spoiler').forEach((node) => node.removeAttribute('open'));
  clone.querySelectorAll('.code-block pre code').forEach((code) => {
    code.textContent = codeBlockText(code);
  });
  clone.querySelectorAll('.table-edit-tools').forEach((node) => node.remove());
  clone.querySelectorAll('.editor-image-resize-handle').forEach((node) => node.remove());
  clone.querySelectorAll('.editor-image-resize').forEach((wrapper) => {
    while (wrapper.firstChild) wrapper.before(wrapper.firstChild);
    wrapper.remove();
  });
  clone.querySelectorAll('.editor-image-component').forEach((wrapper) => {
    while (wrapper.firstChild) wrapper.before(wrapper.firstChild);
    wrapper.remove();
  });
  clone.querySelectorAll('.editor-media-selected').forEach((node) => node.classList.remove('editor-media-selected'));
  clone.querySelectorAll('.editor-video-component,.editor-media-component').forEach((node) => {
    node.classList.remove('editor-video-component', 'editor-media-component');
  });
  clone.querySelectorAll('[contenteditable],[data-editor-media-caret]').forEach((node) => {
    node.removeAttribute('contenteditable');
    node.removeAttribute('data-editor-media-caret');
  });
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT),
    nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    if (node.parentElement.closest('code,pre,.code-block')) return;
    const text = node.nodeValue,
      pattern = /(?<!`)`([^`\r\n]+)`(?!`)/g;
    let match,
      last = 0,
      fragment;
    while ((match = pattern.exec(text))) {
      if (!fragment) fragment = document.createDocumentFragment();
      fragment.append(document.createTextNode(text.slice(last, match.index)));
      const code = document.createElement('code');
      code.textContent = match[1];
      fragment.append(code);
      last = pattern.lastIndex;
    }
    if (fragment) {
      fragment.append(document.createTextNode(text.slice(last)));
      node.replaceWith(fragment);
    }
  });
  return clone.innerHTML;
}
function editorMarkupFromHtml(html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  const serialize = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.matches('.wiki-spoiler')) {
      const label = node.querySelector(':scope > summary > .spoiler-title'),
        body = node.querySelector(':scope > .spoiler-body');
      return '<details class="wiki-spoiler"><summary><i class="spoiler-icon fa-solid fa-eye-slash"></i><span class="spoiler-title">' +
        esc(label?.textContent || '') + '</span></summary><div class="spoiler-body">' +
        (body ? [...body.childNodes].map(serialize).join('') : '') + '</div></details>';
    }
    const tag = node.tagName.toLowerCase();
    if (node.classList.contains('editor-indent'))
      return '[indent]' + [...node.childNodes].map(serialize).join('') + '[/indent]';
    if (tag === 'div' && node.classList.contains('editor-image-component'))
      return [...node.childNodes]
        .filter((child) => !child.matches?.('.editor-image-resize-handle'))
        .map(serialize)
        .join('');
    if (tag === 'div' && node.classList.contains('editor-video-component')) {
      const classes = [...node.classList].filter((name) => name === 'video-embed' || /^editor-align-(left|center|right|justify)$/.test(name));
      const width = /^(?:1[2-9]\d|[2-9]\d{2}|1\d{3})px$/.test(node.style.width) ? ` style="width:${node.style.width}"` : '';
      return `<div class="${classes.join(' ')}"${width}>${[...node.childNodes].filter((child) => !child.matches?.('.editor-image-resize-handle')).map(serialize).join('')}</div>`;
    }
    if ((tag === 'span' || tag === 'div') && node.classList.contains('editor-image-resize'))
      return [...node.childNodes]
        .filter((child) => !child.matches?.('.editor-image-resize-handle'))
        .map(serialize)
        .join('');
    if (tag === 'div' && node.classList.contains('code-block')) {
      const language = node.querySelector('.code-format-label')?.dataset.language || 'text',
        code = node.querySelector('pre code') ? codeBlockText(node.querySelector('pre code')) : '';
      return '[code type="' + language + '"]' + code + '[/code]';
    }
    if (tag === 'div' && node.classList.contains('hint')) {
      const kind =
          ['info', 'success', 'warning', 'error'].find((value) => node.classList.contains(value)) || 'info',
        body = node.querySelector('.hint-body')?.innerHTML || '';
      return '[' + kind + ']' + body + '[/' + kind + ']';
    }
    if (tag === 'a' && node.classList.contains('external-link-card')) {
      const title = node.querySelector('strong')?.textContent || '',
        description = node.querySelector('small')?.textContent || '',
        url = node.getAttribute('href') || '',
        target = node.target === '_blank' ? 'blank' : 'same',
        attr = (value) =>
          value
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
      return (
        '[external-link title="' +
        attr(title) +
        '" description="' +
        attr(description) +
        '" url="' +
        attr(url) +
        '" target="' +
        target +
        '"][/external-link]'
      );
    }
    if (tag === 'table') {
      const rows = [...node.rows].map((row) =>
        [...row.cells].map((cell) =>
          [...cell.childNodes]
            .map(serialize)
            .join('')
            .replace(/\|/g, '\\|')
            .replace(/[\r\n]/g, ' '),
        ),
      );
      if (!rows.length) return '';
      const separator = '| ' + rows[0].map(() => '----').join(' | ') + ' |';
      return (
        '\n| ' +
        rows[0].join(' | ') +
        ' |\n' +
        separator +
        '\n' +
        rows
          .slice(1)
          .map((row) => '| ' + row.join(' | ') + ' |')
          .join('\n') +
        '\n'
      );
    }
    const content = [...node.childNodes].map(serialize).join('');
    if (tag === 'p' && node.style.textAlign)
      return '[align="' + node.style.textAlign + '"]' + content + '[/align]';
    if (/^h[1-6]$/.test(tag) || tag === 'p') return '[' + tag + ']' + content + '[/' + tag + ']';
    if (tag === 'span') {
      const rawStyle = node.getAttribute('style') || '',
        color = rawStyle.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,8}|inherit)/i)?.[1],
        background = rawStyle.match(/(?:^|;)\s*background-color\s*:\s*(#[0-9a-f]{3,8}|transparent)/i)?.[1],
        font = rawStyle
          .match(/(?:^|;)\s*font-family\s*:\s*([^;]+)/i)?.[1]
          ?.trim()
          .replaceAll('\"', '');
      if (color) return '[color=\"' + color + '\"]' + content + '[/color]';
      if (background) return '[mark=\"' + background + '\"]' + content + '[/mark]';
      if (font) return '[font=\"' + font + '\"]' + content + '[/font]';
    }
    if (tag === 'p' && node.style.textAlign)
      return '[align=\"' + node.style.textAlign + '\"]' + content + '[/align]';
    if (['b', 'strong'].includes(tag)) return '[b]' + content + '[/b]';
    if (['i', 'em'].includes(tag)) return '[i]' + content + '[/i]';
    if (tag === 'u') return '[u]' + content + '[/u]';
    if (tag === 's' || tag === 'del') return '[s]' + content + '[/s]';
    if (tag === 'br') return '<br>';
    if (tag === 'img') {
      const escapeAttr = (value) =>
          String(value || '')
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;'),
        attrs = ['src', 'alt', 'title', 'height', 'loading']
          .filter((name) => node.hasAttribute(name))
          .map((name) => ' ' + name + '="' + escapeAttr(node.getAttribute(name)) + '"'),
        width =
          node.dataset.userResized === 'true'
            ? Number(node.getAttribute('width')) || Math.round(node.getBoundingClientRect().width)
            : Number(node.getAttribute('width'));
      if (Number.isFinite(width) && width >= 16 && width <= 10000) attrs.push(' width="' + width + '"');
      return '<img' + attrs.join('') + '>';
    }
    const attrs = [...node.attributes]
      .filter((attr) =>
        [
          'class',
          'href',
          'target',
          'rel',
          'src',
          'alt',
          'title',
          'width',
          'height',
          'loading',
          'allowfullscreen',
          'type',
          'checked',
          'disabled',
          'data-language',
          'style',
          'loading',
        ].includes(attr.name),
      )
      .map(
        (attr) =>
          ' ' + attr.name + '="' + attr.value.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"',
      )
      .join('');
    return '<' + tag + attrs + '>' + content + '</' + tag + '>';
  };
  return [...box.childNodes].map(serialize).join('');
}
function replaceNestedInlineMarkup(source) {
  const pattern = /\[(b|i|u|s)\]((?:(?!\[(?:b|i|u|s)\]).)*?)\[\/\1\]/gi;
  let value = String(source || '');
  for (let pass = 0; pass < 64; pass++) {
    const replaced = value.replace(pattern, (_, tag, body) => {
      const element = { b: 'strong', i: 'em', u: 'u', s: 'del' }[tag.toLowerCase()];
      return '<' + element + '>' + body + '</' + element + '>';
    });
    if (replaced === value) break;
    value = replaced;
  }
  return value;
}
function editorHtmlFromMarkup(source) {
  const codeBlocks = [];
  let expanded = String(source)
    .replace(/\[code\s+type="([a-z0-9_-]{1,24})"\]([\s\S]*?)\[\/code\]/gi, (_, rawLanguage, rawCode) => {
      const language = codeLanguages.some(([id]) => id === rawLanguage.toLowerCase())
          ? rawLanguage.toLowerCase()
          : 'text',
        label = codeLanguages.find(([id]) => id === language)?.[1] || 'Texto Plano',
        escapeCode = (value) =>
          value.replace(
            /[&<>"']/g,
            (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
          ),
        token = 'WIKICODEBLOCK' + codeBlocks.length + 'TOKEN';
      codeBlocks.push(
        '<div class="code-block"><div class="code-block-heading"><span class="code-format-label" data-language="' +
          language +
          '">' +
          label +
          '</span><span class="code-copy-button" title="Copy code"><i class="fa-regular fa-copy"></i></span></div><pre><code class="language-' +
          language +
          '">' +
          escapeCode(rawCode) +
          '</code></pre></div>',
      );
      return token;
    })
    .replace(
      /\[external-link title="([^"]*)" description="([^"]*)" url="([^"]*)" target="(blank|same)"\]\[\/external-link\]/gi,
      (_, title, description, url, target) =>
        '<a class="external-link-card" href="' +
        url +
        '" ' +
        (target === 'blank' ? 'target="_blank" rel="noopener noreferrer"' : '') +
        '><i class="fa-solid fa-arrow-up-right-from-square"></i><span><strong>' +
        title +
        '</strong>' +
        (description ? '<small>' + description + '</small>' : '') +
        '</span></a>',
    )
    .replace(
      /\[(info|success|warning|error)\]([\s\S]*?)\[\/\1\]/gi,
      (_, kind, body) =>
        '<div class="hint ' +
        kind.toLowerCase() +
        '"><i class="fa-solid ' +
        {
          info: 'fa-circle-info',
          success: 'fa-circle-check',
          warning: 'fa-triangle-exclamation',
          error: 'fa-circle-exclamation',
        }[kind.toLowerCase()] +
        ' hint-icon"></i><div class="hint-body">' +
        body +
        '</div></div>',
    )
    .replace(/\[indent\]([\s\S]*?)\[\/indent\]/gi, '<div class="editor-indent">$1</div>')
    .replace(
      /\[(color|mark|font)=\"(#[0-9a-f]{3,8}|inherit|transparent|Arial|Courier New|Georgia|Lucida Sans Unicode|Tahoma|Times New Roman|Trebuchet MS|Verdana)\"]([\s\S]*?)\[\/\1\]/gi,
      (_, kind, value, body) =>
        kind.toLowerCase() === 'font'
          ? '<span style=\"font-family:' + value + '\">' + body + '</span>'
          : '<span style=\"' +
            (kind.toLowerCase() === 'color' ? 'color' : 'background-color') +
            ':' +
            value +
            '\">' +
            body +
            '</span>',
    )
    .replace(
      /\[align=\"(left|center|right|justify)\"]([\s\S]*?)\[\/align\]/gi,
      (_, align, body) => '<p style=\"text-align:' + align + '\">' + body + '</p>',
    )
    .replace(
      /\[(p|h[1-6])\]([\s\S]*?)\[\/\1\]/gi,
      (_, tag, body) => '<' + tag.toLowerCase() + '>' + body + '</' + tag.toLowerCase() + '>',
    )

    .replace(
      /\[link=(https?:\/\/[^\]\s]+)\]([\s\S]*?)\[\/link\]/gi,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$2</a>',
    )
    .replace(/(?:^|\n)((?:\|[^\n]*\|\n?){2,})(?=\n|$)/g, (_, block) => {
      const rows = block
        .trim()
        .split(/\r?\n/)
        .map((line) =>
          line
            .trim()
            .replace(/^\||\|$/g, '')
            .split(/(?<!\\)\|/)
            .map((cell) => cell.replace(/\\\|/g, '|').trim()),
        );
      if (rows.length < 2) return block;
      const hasSeparator = rows[1].every((cell) => /^:?-{2,}:?$/.test(cell));
      const header = rows[0],
        body = hasSeparator ? rows.slice(2) : rows.slice(1);
      return (
        '<table><thead><tr>' +
        header.map((cell) => '<th>' + cell + '</th>').join('') +
        '</tr></thead><tbody>' +
        body
          .map((row) => '<tr>' + header.map((_, i) => '<td>' + (row[i] || '') + '</td>').join('') + '</tr>')
          .join('') +
        '</tbody></table>'
      );
    });
  expanded = replaceNestedInlineMarkup(expanded);
  const parsed = new DOMParser().parseFromString('<body>' + expanded + '</body>', 'text/html'),
    allowed = new Set([
      'a',
      'address',
      'article',
      'aside',
      'b',
      'blockquote',
      'br',
      'caption',
      'code',
      'del',
      'details',
      'div',
      'em',
      'figcaption',
      'figure',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'i',
      'img',
      'iframe',
      'li',
      'ol',
      'p',
      'pre',
      's',
      'span',
      'strong',
      'sub',
      'summary',
      'sup',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'u',
      'ul',
      'input',
    ]);
  const copySafe = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const tag = node.tagName.toLowerCase();
    if ((tag === 'span' || tag === 'div') && node.classList.contains('editor-image-resize')) {
      const fragment = document.createDocumentFragment();
      [...node.childNodes]
        .filter((child) => !child.matches?.('.editor-image-resize-handle'))
        .forEach((child) => fragment.append(copySafe(child)));
      return fragment;
    }
    if (!allowed.has(tag)) {
      const fragment = document.createDocumentFragment();
      [...node.childNodes].forEach((child) => fragment.append(copySafe(child)));
      return fragment;
    }
    const out = document.createElement(tag);
    if (node.hasAttribute('class')) out.className = node.getAttribute('class').slice(0, 300);
    if (tag === 'a') {
      try {
        const url = new URL(node.getAttribute('href') || '', location.origin);
        if (['http:', 'https:', 'mailto:'].includes(url.protocol)) out.setAttribute('href', url.href);
      } catch {}
      if (node.getAttribute('target') === '_blank') {
        out.target = '_blank';
        out.rel = 'noopener noreferrer';
      }
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      try {
        const url = new URL(src, location.origin);
        if (['http:', 'https:'].includes(url.protocol)) out.src = url.href;
      } catch {}
      for (const key of ['alt', 'title', 'width', 'height'])
        if (node.hasAttribute(key)) out.setAttribute(key, node.getAttribute(key).slice(0, 500));
    }
    if (tag === 'iframe') {
      try {
        const url = new URL(node.getAttribute('src') || '');
        if (url.protocol === 'https:' && url.hostname === 'www.youtube-nocookie.com') out.src = url.href;
      } catch {}
      for (const key of ['title', 'loading'])
        if (node.hasAttribute(key)) out.setAttribute(key, node.getAttribute(key).slice(0, 200));
      if (node.hasAttribute('allowfullscreen')) out.setAttribute('allowfullscreen', '');
    }
    if (['span', 'p', 'div'].includes(tag) && node.hasAttribute('style')) {
      for (const property of ['color', 'background-color', 'font-family', 'font-style', 'text-align', 'width', 'max-width']) {
        const rawStyle = node.getAttribute('style') || '',
          value =
            (rawStyle.match(new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)', 'i')) ||
              [])[1]?.trim() || node.style.getPropertyValue(property).trim();
        if (
          property === 'font-family'
            ? /^(Arial|Courier New|Georgia|Lucida Sans Unicode|Tahoma|Times New Roman|Trebuchet MS|Verdana|inherit)$/i.test(
                value,
              )
            : property === 'font-style'
              ? /^(normal|italic|oblique)$/i.test(value)
              : property === 'text-align'
              ? /^(left|center|right|justify)$/i.test(value)
              : property === 'width'
                ? /^(?:1[2-9]\d|[2-9]\d{2}|1\d{3})px$/i.test(value)
                : property === 'max-width'
                  ? /^100%$/i.test(value)
              : property === 'color'
                ? /^(#[0-9a-f]{3,8}|inherit)$/i.test(value)
                : property === 'background-color'
                  ? /^(#[0-9a-f]{3,8}|transparent)$/i.test(value)
                  : /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
        )
          out.style.setProperty(property, value);
      }
    }
    if (
      tag === 'span' &&
      node.hasAttribute('data-language') &&
      /^[a-z0-9_-]{1,24}$/i.test(node.getAttribute('data-language'))
    )
      out.dataset.language = node.getAttribute('data-language');
    if (tag === 'input' && node.getAttribute('type') === 'checkbox') {
      out.type = 'checkbox';
      out.disabled = true;
      if (node.hasAttribute('checked')) out.checked = true;
    }
    [...node.childNodes].forEach((child) => out.append(copySafe(child)));
    return out;
  };
  const clean = document.createElement('div');
  [...parsed.body.childNodes].forEach((child) => clean.append(copySafe(child)));
  let result = clean.innerHTML;
  codeBlocks.forEach((block, index) => {
    result = result.replace('WIKICODEBLOCK' + index + 'TOKEN', block);
  });
  return result;
}
function addSourceMarkup(textarea, command) {
  if (command === 'indent' || command === 'outdent') {
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    if (command === 'indent') {
      const selected = textarea.value.slice(start, end);
      if (selected) textarea.setRangeText('[indent]' + selected + '[/indent]', start, end, 'select');
      else {
        textarea.setRangeText('[indent][/indent]', start, end, 'end');
        textarea.setSelectionRange(start + 8, start + 8);
      }
    } else if (end > start) {
      const selected = textarea.value.slice(start, end).replace(/^\[indent\]([\s\S]*)\[\/indent\]$/i, '$1');
      textarea.setRangeText(selected, start, end, 'select');
    } else {
      const value = textarea.value, open = value.lastIndexOf('[indent]', start), close = value.indexOf('[/indent]', start);
      if (open >= 0 && close >= start) {
        const inner = value.slice(open + 8, close);
        textarea.setRangeText(inner, open, close + 9, 'end');
        textarea.setSelectionRange(open + inner.length, open + inner.length);
      }
    }
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  if (command === 'clear-format') {
    const start = textarea.selectionStart,
      end = textarea.selectionEnd,
      selected = textarea.value.slice(start, end);
    if (!selected) return;
    textarea.setRangeText(
      selected.replace(/\[\/?(?:b|i|u|s|h[1-6]|p|color|mark|font|align)(?:=\"[^\"]*\")?\]/gi, ''),
      start,
      end,
      'select',
    );
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const bracket =
    /^(color=\"#?[0-9a-f]{3,8}"|mark="#?[0-9a-f]{3,8}"|font="(?:Arial|Courier New|Georgia|Lucida Sans Unicode|Tahoma|Times New Roman|Trebuchet MS|Verdana)"|align="(?:left|center|right|justify)")$/i.exec(
      command,
    );
  if (bracket) {
    const start = textarea.selectionStart,
      end = textarea.selectionEnd,
      selected = textarea.value.slice(start, end) || t('texto', 'text'),
      tag = bracket[1].split('=')[0];
    textarea.setRangeText('[' + bracket[1] + ']' + selected + '[/' + tag + ']', start, end, 'select');
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (['insertOrderedList', 'insertUnorderedList', 'check', 'quote'].includes(command)) {
    const start = textarea.selectionStart,
      end = textarea.selectionEnd,
      selected = textarea.value.slice(start, end) || t('texto', 'text'),
      prefix =
        command === 'insertOrderedList'
          ? '1. '
          : command === 'insertUnorderedList'
            ? '- '
            : command === 'check'
              ? '- [ ] '
              : command === 'quote'
                ? '> '
                : '',
      value = selected
        .split(/\r?\n/)
        .map((line) => prefix + line)
        .join('\n');
    textarea.setRangeText(value, start, end, 'end');
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  if (command === 'unlink') {
    const start = textarea.selectionStart,
      end = textarea.selectionEnd,
      selected = textarea.value.slice(start, end);
    if (selected) {
      textarea.setRangeText(
        selected.replace(/\[link=(https?:\/\/[^\]]+)\]([\s\S]*?)\[\/link\]/gi, '$2'),
        start,
        end,
        'select',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }
  if (command === 'inlineCode') {
    const start = textarea.selectionStart,
      end = textarea.selectionEnd,
      selected = textarea.value.slice(start, end) || t('codigo', 'code');
    textarea.setRangeText('`' + selected + '`', start, end, 'end');
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  const map = { bold: 'b', italic: 'i', underline: 'u', strike: 's' };
  const tag = map[command] || (/^(?:p|h[1-6])$/.test(command) ? command : null);
  if (!tag) return false;
  const start = textarea.selectionStart,
    end = textarea.selectionEnd,
    selected = textarea.value.slice(start, end);
  textarea.setRangeText(`[${tag}]${selected}[/${tag}]`, start, end, 'select');
  textarea.focus();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
async function promptSpoilerTitle(value = '') {
  const result = await Swal.fire({
    title: t('Texto visible del spoiler', 'Visible spoiler text'),
    html: '<div class="editor-swal-fields"><input class="swal2-input" data-spoiler-title type="text" aria-label="' +
      esc(t('Texto visible del spoiler', 'Visible spoiler text')) +
      '"></div>',
    showCancelButton: true,
    buttonsStyling: false,
    customClass: {
      popup: 'wiki-swal-popup editor-swal-popup',
      title: 'wiki-swal-title',
      htmlContainer: 'wiki-swal-body',
      confirmButton: 'primary-button',
      cancelButton: 'secondary-button',
    },
    confirmButtonText: t('Guardar', 'Save'),
    cancelButtonText: t('Cancelar', 'Cancel'),
    didOpen: (popup) => {
      const input = popup.querySelector('[data-spoiler-title]');
      if (!input) throw new Error('No se encontró el campo de texto del spoiler.');
      input.value = value;
      input.focus();
    },
    preConfirm: () => {
      const input = Swal.getPopup().querySelector('[data-spoiler-title]');
      const title = input?.value.trim();
      if (!title) {
        Swal.showValidationMessage(t('Escribe un texto visible.', 'Enter visible text.'));
        return false;
      }
      return title;
    },
  });
  return result.isConfirmed ? result.value.trim() : null;
}
async function runEditorCommand(command, content) {
  const source = content.parentElement.querySelector('.editor-source'),
    initialSelection = getSelection(),
    savedEditorRange =
      initialSelection?.rangeCount && content.contains(initialSelection.anchorNode)
        ? initialSelection.getRangeAt(0).cloneRange()
        : null;
  if (source && !source.hidden && addSourceMarkup(source, command)) return;
  content.focus();
  if (command === 'italic') {
    const selection = getSelection();
    if (selection?.rangeCount && !selection.isCollapsed && content.contains(selection.anchorNode) && content.contains(selection.focusNode)) {
      const range = selection.getRangeAt(0), anchor = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode.parentElement, isItalic = getComputedStyle(anchor).fontStyle === 'italic', wrapper = document.createElement(isItalic ? 'span' : 'em');
      if (isItalic) wrapper.style.fontStyle = 'normal';
      wrapper.append(range.extractContents());
      range.insertNode(wrapper);
      const selected = document.createRange();
      selected.selectNodeContents(wrapper);
      selection.removeAllRanges();
      selection.addRange(selected);
      content.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('italic', false, null);
    return;
  }
  if (['bold', 'underline', 'insertUnorderedList', 'insertOrderedList'].includes(command)) {
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(command, false, null);
    return;
  }
  if (/^h[1-6]$/.test(command)) {
    document.execCommand('formatBlock', false, command);
    return;
  }
  const insert = (html) => {
      if (source && !source.hidden) {
        source.setRangeText(editorMarkupFromHtml(html), source.selectionStart, source.selectionEnd, 'end');
        source.focus();
        source.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      content.focus();
      if (savedEditorRange) {
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(savedEditorRange);
      }
      document.execCommand('insertHTML', false, html);
      prepareEditorWidgets(content);
    },
    modal = async ({ title, fields, validate }) => {
      const result = await Swal.fire({
        position: fields.includes('data-editor-field="language"') ? 'top' : 'center',
        title,
        html: `<div class="editor-swal-fields">${fields}</div>`,
        showCancelButton: true,
        buttonsStyling: false,
        customClass: {
          popup: 'wiki-swal-popup editor-swal-popup',
          title: 'wiki-swal-title',
          htmlContainer: 'wiki-swal-body',
          confirmButton: 'primary-button',
          cancelButton: 'secondary-button',
        },
        confirmButtonText: t('Insertar', 'Insert'),
        cancelButtonText: t('Cancelar', 'Cancel'),
        focusConfirm: false,
        didOpen: (popup) => {
          const select = popup.querySelector('select[data-editor-field="language"]');
          if (!select) return;
          const wrapper = document.createElement('div'), trigger = document.createElement('button'), list = document.createElement('div');
          wrapper.className = 'editor-swal-select';
          trigger.type = 'button';
          trigger.className = 'editor-swal-select-trigger';
          trigger.setAttribute('aria-haspopup', 'listbox');
          trigger.setAttribute('aria-expanded', 'false');
          list.className = 'editor-swal-select-list';
          list.setAttribute('role', 'listbox');
          list.hidden = true;
          const syncTrigger = () => {
            const option = select.options[select.selectedIndex];
            trigger.innerHTML = `<span>${esc(option?.textContent || '')}</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>`;
            [...list.children].forEach((item) => item.setAttribute('aria-selected', String(item.dataset.value === select.value)));
          };
          [...select.options].forEach((option) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'editor-swal-select-option';
            item.dataset.value = option.value;
            item.setAttribute('role', 'option');
            item.textContent = option.textContent;
            item.onclick = () => {
              select.value = option.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              syncTrigger();
              list.hidden = true;
              trigger.setAttribute('aria-expanded', 'false');
              trigger.focus();
            };
            list.append(item);
          });
          trigger.onclick = () => {
            const opening = list.hidden;
            const rect = trigger.getBoundingClientRect(), maxHeight = Math.min(window.innerHeight * 0.44, 320);
            wrapper.classList.toggle('opens-up', opening && window.innerHeight - rect.bottom < maxHeight && rect.top > maxHeight);
            list.hidden = !opening;
            trigger.setAttribute('aria-expanded', String(opening));
            if (opening) list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
          };
          select.classList.add('editor-swal-native-select');
          select.after(wrapper);
          wrapper.append(trigger, list);
          syncTrigger();
          popup.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !list.hidden) {
              list.hidden = true;
              trigger.setAttribute('aria-expanded', 'false');
              trigger.focus();
              event.stopPropagation();
            }
          });
        },
        preConfirm: () => {
          const data = Object.fromEntries(
            [...Swal.getPopup().querySelectorAll('[data-editor-field]')].map((el) => [
              el.dataset.editorField,
              el.type === 'checkbox' ? el.checked : el.value.trim(),
            ]),
          );
          const error = validate(data);
          if (error) {
            Swal.showValidationMessage(error);
            return false;
          }
          return data;
        },
      });
      return result.isConfirmed ? result.value : null;
    };
  const safeUrl = (value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  if (command === 'spoiler') {
    const title = await promptSpoilerTitle();
    if (title !== null) insert('<details class="wiki-spoiler"><summary><i class="spoiler-icon fa-solid fa-eye-slash"></i><span class="spoiler-title">' +
      esc(title) + '</span></summary><div class="spoiler-body"><p><br></p></div></details><p><br></p>');
  } else if (command === 'check') insert('<p><input type="checkbox" disabled> Tarea pendiente</p>');
  else if (command === 'inlineCode') {
    const selection = getSelection(),
      selected = selection && content.contains(selection.anchorNode) ? selection.toString() : '';
    document.execCommand('insertText', false, '`' + (selected || t('codigo', 'code')) + '`');
  } else if (command === 'code') {
    const fields = `<label>${t('Formato del código', 'Code format')}<select class="swal2-input" data-editor-field="language">${codeLanguages.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>`;
    const data = await modal({
      title: t('Insertar bloque de código', 'Insert code block'),
      fields,
      validate: () => null,
    });
    if (data) {
      const label = codeLanguages.find(([id]) => id === data.language)?.[1] || 'Texto Plano';
      insert(
        `<div class="code-block"><div class="code-block-heading"><span class="code-format-label" contenteditable="false" data-language="${data.language}">${label}</span><span class="code-copy-button" data-copy-code="true" title="${t('Copiar código', 'Copy code')}" aria-label="${t('Copiar código', 'Copy code')}"><i class="fa-regular fa-copy"></i></span></div><pre><code class="language-${data.language}">${t('Escribe aquí', 'Write here')}</code></pre></div><p><br></p>`,
      );
    }
  } else if (command === 'link' || command === 'image') {
    const image = command === 'image',
      fields = `<label>${image ? t('URL de la imagen', 'Image URL') : t('Dirección del enlace', 'Link URL')}<input class="swal2-input" data-editor-field="url" type="url" placeholder="https://" required></label>${image ? `<label>${t('Texto alternativo', 'Alternative text')}<input class="swal2-input" data-editor-field="alt" maxlength="300"></label>` : `<label class="editor-toggle"><input data-editor-field="newTab" type="checkbox" checked> ${t('Redireccionar en nueva pestaña', 'Open in a new tab')}</label>`}`;
    const data = await modal({
      title: image
        ? t('Insertar imagen por URL', 'Insert image by URL')
        : t('Insertar enlace', 'Insert link'),
      fields: image ? fields : fields.replace(
        '<label class="editor-toggle">',
        `<label>${t('Texto para reemplazar (opcional)', 'Replacement text (optional)')}<input class="swal2-input" data-editor-field="text" maxlength="500" placeholder="${t('Deja vacío para conservar el texto seleccionado', 'Leave empty to keep the selected text')}"></label><label class="editor-toggle">`,
      ),
      validate: (d) =>
        safeUrl(d.url)
          ? null
          : t('Ingresa una URL válida con http:// o https://.', 'Enter a valid http:// or https:// URL.'),
    });
    if (data) {
      const url = safeUrl(data.url);
      if (image) insert(`<img src="${esc(url)}" alt="${esc(data.alt)}">`);
      else {
        const selectedText = savedEditorRange?.toString() || '', linkText = data.text || selectedText || url;
        insert(`<a href="${esc(url)}" ${data.newTab ? 'target="_blank" rel="noopener noreferrer"' : ''}>${esc(linkText)}</a>`);
      }
    }
  } else if (command === 'youtube') {
    const data = await modal({
      title: t('Insertar video de YouTube', 'Insert YouTube video'),
      fields: `<label>${t('URL de YouTube', 'YouTube URL')}<input class="swal2-input" data-editor-field="url" type="url" placeholder="https://www.youtube.com/watch?v=..." required></label>`,
      validate: (d) =>
        /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/))([\w-]{11})/.test(d.url)
          ? null
          : t('El enlace de YouTube no parece válido.', 'That YouTube link is invalid.'),
    });
    if (data) {
      const id = data.url.match(
        /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/))([\w-]{11})/,
      )[1];
      content.focus();
      if (savedEditorRange) {
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(savedEditorRange);
      }
      insertAtomicEditorComponent(content,
        `<div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube video" loading="lazy" allowfullscreen></iframe></div>`);
    }
  } else if (command.startsWith('hint-')) {
    const type = command.slice(5),
      labelEs = { info: 'Información', success: 'Éxito', warning: 'Advertencia', error: 'Error' }[type],
      label = t(labelEs, { info: 'Info', success: 'Success', warning: 'Warning', error: 'Error' }[type]),
      icon = {
        info: 'fa-circle-info',
        success: 'fa-circle-check',
        warning: 'fa-triangle-exclamation',
        error: 'fa-circle-exclamation',
      }[type];
    insert(
      `<div class="hint ${type}"><i class="fa-solid ${icon} hint-icon" contenteditable="false" aria-hidden="true"></i><div class="hint-body" contenteditable="true"><strong>${label}:</strong> ${t('Escribe el mensaje aquí.', 'Write your message here.')}</div></div><p><br></p>`,
    );
    const hintBody = source?.hidden ? [...content.querySelectorAll('.hint')].at(-1)?.querySelector('.hint-body') : null;
    if (hintBody) {
      content.focus();
      const range = document.createRange(), activeSelection = getSelection();
      range.selectNodeContents(hintBody);
      range.collapse(false);
      activeSelection.removeAllRanges();
      activeSelection.addRange(range);
    }
  } else if (command === 'external-card') {
    const data = await modal({
      title: t('Insertar enlace externo', 'Insert external link'),
      fields: `<label>${t('Título', 'Title')}<input class="swal2-input" data-editor-field="title" maxlength="120" required></label><label>${t('Descripción (opcional)', 'Description (optional)')}<textarea class="swal2-textarea" data-editor-field="description" maxlength="500"></textarea></label><label>${t('Enlace', 'Link')}<input class="swal2-input" data-editor-field="url" type="url" placeholder="https://" required></label><label class="editor-toggle"><input data-editor-field="newTab" type="checkbox" checked> ${t('Redireccionar en nueva pestaña', 'Open in a new tab')}</label>`,
      validate: (d) =>
        !d.title
          ? t('El título es obligatorio.', 'Title is required.')
          : safeUrl(d.url)
            ? null
            : t('Ingresa una URL válida con http:// o https://.', 'Enter a valid http:// or https:// URL.'),
    });
    if (data) {
      const url = safeUrl(data.url);
      insert(
        `<a class="external-link-card" href="${esc(url)}" ${data.newTab ? 'target="_blank" rel="noopener noreferrer"' : ''}><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span><strong>${esc(data.title)}</strong>${data.description ? `<small>${esc(data.description)}</small>` : ''}</span></a><p><br></p>`,
      );
    }
  } else if (command === 'quote')
    insert(
      '<blockquote class="wiki-quote"><p>' +
        t('Escribe la cita aquí.', 'Write the quote here.') +
        '</p></blockquote><p><br></p>',
    );
  else if (command === 'table') {
    const data = await modal({
      title: t('Crear tabla', 'Create table'),
      fields: `<label>${t('Filas', 'Rows')}<input class="swal2-input" data-editor-field="rows" type="number" min="1" max="30" value="2"></label><label>${t('Columnas', 'Columns')}<input class="swal2-input" data-editor-field="columns" type="number" min="1" max="12" value="2"></label>`,
      validate: (d) =>
        Number(d.rows) >= 1 && Number(d.rows) <= 30 && Number(d.columns) >= 1 && Number(d.columns) <= 12
          ? null
          : t('Usa de 1 a 30 filas y de 1 a 12 columnas.', 'Choose 1–30 rows and 1–12 columns.'),
    });
    if (data) {
      const rows = Number(data.rows),
        cols = Number(data.columns);
      insert(
        `<table><thead><tr>${Array.from({ length: cols }, () => '<th>Encabezado</th>').join('')}</tr></thead><tbody>${Array.from({ length: Math.max(0, rows - 1) }, () => `<tr>${Array.from({ length: cols }, () => '<td>Contenido</td>').join('')}</tr>`).join('')}</tbody></table><p><br></p>`,
      );
    }
  }
  state.dirty = true;
}
async function categoriesTab(root) {
  const spaces = state.config.spaces || [],
    spaceOptions = spaces
      .map(
        (space) =>
          `<option value="${esc(space.slug)}" ${space.slug === state.space ? 'selected' : ''}>${esc(space.name)} (${space.slug === 'main' ? '/' : '/' + space.slug})</option>`,
      )
      .join(''),
    langs = state.config.languages,
    languageOptions = langs
      .map(
        (lang) =>
          `<option value="${esc(lang)}" ${lang === state.lang ? 'selected' : ''}>${esc((state.config.languageCatalog || []).find((item) => item.code === lang)?.name || lang)}</option>`,
      )
      .join('');
  const categoryLabel = (c) =>
    c.names[state.lang] ||
    c.names[state.lang.split('-')[0]] ||
    Object.values(c.names)[0] ||
    t('Categoría', 'Category');
  root.innerHTML = `<section class="admin-section workspace-selector-section"><div><h2>${t('Espacio de trabajo', 'Working space')}</h2><p>${t('Elige el espacio cuyas categorías quieres administrar.', 'Choose the space whose categories you want to manage.')}</p></div><label class="workspace-select-label"><span class="admin-label">${t('Espacio de documentación', 'Documentation space')}</span><select class="settings-input" id="categoriesSpaceSelect">${spaceOptions}</select></label></section><section class="admin-section category-manager-section"><div class="section-heading"><div><h2>${t('Categorías de navegación', 'Navigation categories')}</h2><p>${t('Organiza las secciones de este espacio. Arrastra para cambiar el orden.', 'Organize this space. Drag categories to change their order.')}</p></div><span class="category-count">${state.categories.length}</span></div><div id="categoryRows" class="category-rows">${state.categories.map((category, index) => `<div class="category-row" draggable="true" data-category-id="${category.id}"><button type="button" class="drag-handle" aria-label="${t('Arrastrar categoría', 'Drag category')}" title="${t('Arrastrar para ordenar', 'Drag to reorder')}"><i class="fa-solid fa-grip-vertical"></i></button><span class="category-order">${String(index + 1).padStart(2, '0')}</span><span class="category-icon-preview">${pageIconMarkup(category.icon)}</span><strong>${esc(categoryLabel(category))}</strong><span class="category-parent-label">${category.parent_id ? esc(categoryLabel(state.categories.find((item) => Number(item.id) === Number(category.parent_id)) || { names: {} })) : t('Principal', 'Root')}</span><button class="icon-button edit-category" data-id="${category.id}" title="${t('Editar', 'Edit')}"><i class="fa-solid fa-pen"></i></button><button class="icon-button remove-category" data-id="${category.id}" title="${t('Eliminar', 'Delete')}"><i class="fa-solid fa-trash"></i></button></div>`).join('') || `<div class="empty-state">${t('Todavía no hay categorías.', 'No categories yet.')}</div>`}</div><div class="category-create-panel"><h3>${t('Añadir categoría', 'Add category')}</h3><div class="category-name-editor"><label><span class="admin-label">${t('Idioma', 'Language')}</span><select class="settings-input" id="newCategoryLanguage">${languageOptions}</select></label><label><span class="admin-label">${t('Nombre de categoría', 'Category name')}</span><input class="settings-input" id="newCategoryName" maxlength="120" placeholder="${t('Por ejemplo: Guía', 'For example: Guide')}"></label></div><div class="category-fields-grid"><label><span class="admin-label">${t('Tipo de marca', 'Brand type')}</span><select id="categoryMarkMode" class="settings-input"><option value="icon">${t('Insertar un ícono', 'Insert an icon')}</option><option value="image">${t('Subir una imagen', 'Upload an image')}</option></select></label><label id="categoryIconWrap"><span class="admin-label">${t('Ícono Font Awesome', 'Font Awesome icon')}</span><input id="categoryIcon" class="settings-input" value="fa-solid fa-folder" placeholder="fa-solid fa-folder"></label><label id="categoryImageWrap" hidden><span class="admin-label">${t('Subir una imagen', 'Upload an image')}</span><input id="categoryImageFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><input id="categoryImagePath" type="hidden"><small id="categoryImageStatus">${t('No hay imagen subida', 'No image uploaded')}</small></label><label><span class="admin-label">${t('Categoría principal', 'Parent category')}</span><select id="categoryParent" class="settings-input"><option value="">${t('Ninguna', 'None')}</option>${state.categories.map((category) => `<option value="${category.id}">${esc(categoryLabel(category))}</option>`).join('')}</select></label></div><label class="category-open-default"><input id="categoryOpen" type="checkbox" checked> ${t('Mantener abierta la subcategoría al ingresar a la página', 'Keep the subcategory expanded when opening the page')}</label><button class="primary-button" id="createCategory"><i class="fa-solid fa-plus"></i> ${t('Crear categoría', 'Create category')}</button></div></section>`;
  const categoryCreatePanel = $('.category-create-panel', root),
    categoryError = document.createElement('div');
  categoryError.className = 'category-create-error';
  categoryError.setAttribute('role', 'alert');
  categoryError.setAttribute('aria-live', 'assertive');
  categoryError.hidden = true;
  $('h3', categoryCreatePanel).after(categoryError);
  const clearCategoryError = () => {
    categoryError.textContent = '';
    categoryError.hidden = true;
  };
  const showCategoryError = (error) => {
    if (!isUserError(error)) {
      showCouldNotStart(error, 'category-editor', { path: 'category-create' });
      return;
    }
    categoryError.textContent = userErrorText(error);
    categoryError.hidden = false;
  };
  const showCategoryValidation = (message) => {
    categoryError.textContent = message;
    categoryError.hidden = false;
  };
  if (!can('categories.create_edit')) $('.category-create-panel', root).hidden = true;
  if (!can('categories.create_edit')) $$('.edit-category', root).forEach((button) => (button.hidden = true));
  if (!can('categories.create_edit'))
    $$('.category-row', root).forEach((row) => {
      row.draggable = false;
      $('.drag-handle', row).hidden = true;
    });
  if (!can('categories.delete')) $$('.remove-category', root).forEach((button) => (button.hidden = true));
  $('#categoriesSpaceSelect', root).onchange = async (event) => {
    if (!(await confirmUnsaved())) {
      event.target.value = state.space;
      return;
    }
    await changeAdminSpace(event.target.value, 'categories', root);
  };
  let draftNames = {};
  const language = $('#newCategoryLanguage', root),
    name = $('#newCategoryName', root);
  language.dataset.current = language.value;
  language.onchange = () => {
    draftNames[language.dataset.current] = name.value.trim();
    language.dataset.current = language.value;
    name.value = draftNames[language.value] || '';
    clearCategoryError();
  };
  name.addEventListener('input', clearCategoryError);
  $('#categoryMarkMode', root).onchange = () => {
    const image = $('#categoryMarkMode', root).value === 'image';
    $('#categoryIconWrap', root).hidden = image;
    $('#categoryImageWrap', root).hidden = !image;
    clearCategoryError();
  };
  $('#categoryParent', root).addEventListener('change', clearCategoryError);
  $('#categoryImageFile', root).onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const status = $('#categoryImageStatus', root);
    try {
      status.textContent = t('Subiendo imagen…', 'Uploading image…');
      const body = new FormData();
      body.append('image', file);
      body.append('alt', $('#newCategoryName', root).value.trim());
      const response = await request('/api/admin/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf },
        body,
      });
      const data = await imageUploadResponse(response);
      $('#categoryImagePath', root).value = data.url;
      status.innerHTML =
        '<img class="category-image-preview" src="' +
        esc(data.url) +
        '" alt=""><a href="' +
        esc(data.url) +
        '" target="_blank" rel="noopener noreferrer">' +
        esc(data.url) +
        '</a>';
      setNotice(
        t(
          'Imagen subida. Guarda la categoría para aplicarla.',
          'Image uploaded. Save the category to apply it.',
        ),
      );
    } catch (error) {
      status.textContent = '';
      showCategoryError(error);
    } finally {
      event.target.value = '';
    }
  };
  $('#createCategory', root).onclick = async () => {
    try {
      draftNames[language.value] = name.value.trim();
      if ($('#categoryMarkMode', root).value === 'image' && !$('#categoryImagePath', root).value)
        return showCategoryValidation(t('Selecciona un archivo de imagen.', 'Select an image file.'));
      if (langs.some((lang) => !draftNames[lang])) {
        showCategoryValidation(
          t(
            'Completa el nombre de la categoría en todos los idiomas activos.',
            'Enter the category name in every active language.',
          ),
        );
        return;
      }
      clearCategoryError();
      await api('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({
          names: draftNames,
          icon:
            $('#categoryMarkMode', root).value === 'image'
              ? $('#categoryImagePath', root).value
              : $('#categoryIcon', root).value,
          parentId: $('#categoryParent', root).value || null,
          isOpen: $('#categoryOpen', root).checked,
        }),
      });
      await loadWiki();
      await adminView('categories');
    } catch (e) {
      showCategoryError(e);
    }
  };
  $$('.edit-category', root).forEach(
    (button) =>
      (button.onclick = async () => {
        const category = state.categories.find((item) => item.id === Number(button.dataset.id)),
          names = { ...category.names },
          firstLang = langs[0],
          parentOptions =
            `<option value="">${t('Ninguna', 'None')}</option>` +
            state.categories
              .filter((item) => item.id !== category.id)
              .map(
                (item) =>
                  `<option value="${item.id}" ${Number(item.id) === Number(category.parent_id) ? 'selected' : ''}>${esc(categoryLabel(item))}</option>`,
              )
              .join(''),
          html = `<div class="category-edit-grid"><label><span class="swal-label">${t('Idioma', 'Language')}</span><select id="swalCategoryLanguage" class="swal2-input">${langs.map((lang) => `<option value="${esc(lang)}">${esc((state.config.languageCatalog || []).find((item) => item.code === lang)?.name || lang)}</option>`).join('')}</select></label><label><span class="swal-label">${t('Nombre de categoría', 'Category name')}</span><input id="swalCategoryName" class="swal2-input" maxlength="120"></label><label><span class="swal-label">${t('Tipo de marca', 'Brand type')}</span><select id="swalCategoryMode" class="swal2-input"><option value="icon" ${/^\/media\//.test(category.icon) ? '' : 'selected'}>${t('Insertar un ícono', 'Insert an icon')}</option><option value="image" ${/^\/media\//.test(category.icon) ? 'selected' : ''}>${t('Subir una imagen', 'Upload an image')}</option></select></label><label id="swalCategoryIconWrap" ${/^\/media\//.test(category.icon) ? 'hidden' : ''}><span class="swal-label">${t('Ícono Font Awesome', 'Font Awesome icon')}</span><input id="swalCategoryIcon" class="swal2-input" value="${/^\/media\//.test(category.icon) ? 'fa-solid fa-folder' : esc(category.icon)}"></label><label id="swalCategoryImageWrap" ${/^\/media\//.test(category.icon) ? '' : 'hidden'}><span class="swal-label">${t('Subir una imagen', 'Upload an image')}</span><input id="swalCategoryImageFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><input id="swalCategoryImagePath" type="hidden" value="${/^\/media\//.test(category.icon) ? esc(category.icon) : ''}"><small id="swalCategoryImageStatus">${/^\/media\//.test(category.icon) ? '<img class="category-image-preview" src="' + esc(category.icon) + '" alt=""><a href="' + esc(category.icon) + '" target="_blank" rel="noopener noreferrer">' + esc(category.icon) + '</a>' : t('No hay imagen subida', 'No image uploaded')}</small></label><label><span class="swal-label">${t('Categoría principal', 'Parent category')}</span><select id="swalCategoryParent" class="swal2-input">${parentOptions}</select></label><label class="category-open-default"><input id="swalCategoryOpen" type="checkbox" ${category.is_open ? 'checked' : ''}> ${t('Mantener abierta la subcategoría al ingresar a la página', 'Keep the subcategory expanded when opening the page')}</label></div>`;
        const choice = await Swal.fire({
          title: t('Editar categoría', 'Edit category'),
          html,
          showCancelButton: true,
          buttonsStyling: false,
          customClass: {
            popup: 'wiki-swal-popup',
            title: 'wiki-swal-title',
            htmlContainer: 'wiki-swal-body',
            confirmButton: 'primary-button',
            cancelButton: 'secondary-button',
          },
          confirmButtonText: t('Guardar', 'Save'),
          cancelButtonText: t('Cancelar', 'Cancel'),
          didOpen: () => {
            const select = $('#swalCategoryLanguage'),
              input = $('#swalCategoryName'),
              mode = $('#swalCategoryMode');
            mode.onchange = () => {
              const image = mode.value === 'image';
              $('#swalCategoryIconWrap').hidden = image;
              $('#swalCategoryImageWrap').hidden = !image;
            };
            $('#swalCategoryImageFile').onchange = async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const status = $('#swalCategoryImageStatus');
              try {
                status.textContent = t('Subiendo imagen…', 'Uploading image…');
                const body = new FormData();
                body.append('image', file);
                body.append('alt', $('#swalCategoryName').value.trim());
                const response = await request('/api/admin/uploads', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'X-Wiki-Space': state.space, 'X-CSRF-Token': state.csrf },
                  body,
                });
                const data = await imageUploadResponse(response);
                status.innerHTML =
                  '<img class="category-image-preview" src="' +
                  esc(data.url) +
                  '" alt=""><a href="' +
                  esc(data.url) +
                  '" target="_blank" rel="noopener noreferrer">' +
                  esc(data.url) +
                  '</a>';
              } catch (error) {
                status.textContent = '';
                if (isUserError(error)) {
                  reportClientError('image-upload', error, { status: error.status });
                  Swal.showValidationMessage(userErrorText(error));
                } else showCouldNotStart(error, 'image-upload');
              } finally {
                event.target.value = '';
              }
            };
            select.value = firstLang;
            select.dataset.current = firstLang;
            input.value = names[firstLang] || '';
            input.oninput = () => (names[select.value] = input.value.trim());
            select.onchange = () => {
              names[select.dataset.current] = input.value.trim();
              select.dataset.current = select.value;
              input.value = names[select.value] || '';
            };
          },
          preConfirm: () => {
            const select = $('#swalCategoryLanguage'),
              input = $('#swalCategoryName');
            names[select.value] = input.value.trim();
            if (langs.some((lang) => !names[lang])) {
              Swal.showValidationMessage(
                t(
                  'Completa el nombre en todos los idiomas activos.',
                  'Enter a name in every active language.',
                ),
              );
              return false;
            }
            if ($('#swalCategoryMode').value === 'image' && !$('#swalCategoryImagePath').value) {
              Swal.showValidationMessage(
                t('Sube una imagen para la categoría.', 'Upload an image for the category.'),
              );
              return false;
            }
            return {
              names,
              icon:
                $('#swalCategoryMode').value === 'image'
                  ? $('#swalCategoryImagePath').value
                  : $('#swalCategoryIcon').value.trim() || 'fa-solid fa-folder',
              parentId: $('#swalCategoryParent').value || null,
              isOpen: $('#swalCategoryOpen').checked,
            };
          },
        });
        if (!choice.isConfirmed) return;
        try {
          await api('/api/admin/categories/' + category.id, {
            method: 'PUT',
            body: JSON.stringify({
              names: choice.value.names,
              icon: choice.value.icon,
              parentId: choice.value.parentId,
              isOpen: choice.value.isOpen,
            }),
          });
          await loadWiki();
          await adminView('categories');
        } catch (e) {
          showError($('#adminPanel'), e);
        }
      }),
  );
  $$('.remove-category', root).forEach(
    (button) =>
      (button.onclick = async () => {
        const choice = await Swal.fire({
          icon: 'warning',
          title: t('¿Eliminar esta categoría?', 'Delete this category?'),
          text: t(
            'La categoría y sus subcategorías se eliminarán.',
            'The category and its subcategories will be removed.',
          ),
          showCancelButton: true,
          confirmButtonText: t('Eliminar', 'Delete'),
          cancelButtonText: t('Cancelar', 'Cancel'),
          reverseButtons: true,
          buttonsStyling: false,
          customClass: {
            popup: 'wiki-swal-popup',
            title: 'wiki-swal-title',
            confirmButton: 'danger-button',
            cancelButton: 'secondary-button',
          },
        });
        if (!choice.isConfirmed) return;
        try {
          await api('/api/admin/categories/' + button.dataset.id, { method: 'DELETE' });
          await loadWiki();
          await adminView('categories');
        } catch (e) {
          showError($('#adminPanel'), e);
        }
      }),
  );
  const rows = $('#categoryRows', root);
  let dragged = null;
  rows.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.category-row');
    if (!row) return;
    dragged = row;
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.dataset.categoryId);
  });
  rows.addEventListener('dragover', (event) => {
    const target = event.target.closest('.category-row');
    if (!target || !dragged || target === dragged) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    target.parentNode.insertBefore(
      dragged,
      event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling,
    );
  });
  rows.addEventListener('dragend', async () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    const categoryIds = $$('.category-row', rows).map((row) => Number(row.dataset.categoryId));
    try {
      await api('/api/admin/categories/order', { method: 'PUT', body: JSON.stringify({ categoryIds }) });
      await loadWiki();
      await adminView('categories');
      setNotice(t('Orden de categorías guardado.', 'Category order saved.'));
    } catch (error) {
      showError($('#adminPanel'), error);
      await adminView('categories');
    }
  });
}
function closeMobileNav() {
  $('#sidebar').classList.remove('open');
  $('#mobileShade').classList.remove('open');
}
function updateBrowserTitle(context) {
  const siteTitle = String(state.config.site.name || state.config.site.pageTitle || 'Teralth Wiki').trim();
  browserTitle = `${context} • ${siteTitle}`;
  if (loadingDepth === 0) document.title = browserTitle;
  const seo = state.config.site.seo || {};
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && seo.canonicalBase) {
    const base = new URL(seo.canonicalBase);
    canonical.href = base.origin + base.pathname.replace(/\/$/, '') + location.pathname;
  }
}
function updateBrand() {
  const pageTitle = String(state.config.site.name || state.config.site.pageTitle || 'Teralth Wiki').trim(),
    isAdmin = route().page === 'admin',
    context = isAdmin ? t('Admin', 'Admin') : t('Página', 'Page');
  updateBrowserTitle(context);
  const applicationName = $('meta[name="application-name"]'),
    socialTitle = $('meta[property="og:title"]'),
    favicon = $('#siteFavicon');
  if (applicationName) applicationName.content = pageTitle;
  if (socialTitle) socialTitle.content = state.config.site.seo?.socialTitle || pageTitle;
  if (favicon) {
    favicon.href = state.config.site.favicon || '/assets/favicon.svg';
    favicon.type = favicon.href.startsWith('/media/') ? 'image/webp' : 'image/svg+xml';
  }
  $('#footerCopyright').textContent = `© ${new Date().getFullYear()} ${state.config.site.name} · ${tr('footer.rights', t('Todos los derechos reservados.', 'All rights reserved.'))}`;
  $('#footerContent').textContent = String(state.config.site.sidebarLabel || t('Documentación', 'Documentation'));
  $('#brand .brand-name').textContent = state.config.site.name;
  $('#mobileDocsBrand .mobile-docs-name').textContent = state.config.site.name;
  $('#mobileDocsSearch').setAttribute('aria-label', t('Buscar documentación', 'Search documentation'));
  const mark = $('#brand .brand-mark');
  const logo = String(state.config.site.logo || '');
  if (/^(https:\/\/|\/(?!\/))/.test(logo))
    mark.innerHTML =
      '<img src="' +
      esc(logo) +
      '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px">';
  else mark.innerHTML = '<i class="fa-solid fa-book-open"></i>';
  $('#mobileDocsBrand .brand-mark').innerHTML = mark.innerHTML;
}
async function render(knownMe = null) {
  setAuthLink();
  renderHeaderLinks();
  renderLanguageMenu();
  updateBrand();
  renderSupportCard();
  const info = route();
  const returnValue = new URLSearchParams(location.search).get('next');
  if (returnValue) state.returnTo = safeLocalReturn(returnValue);
  state.space = info.space;
  renderSpaces();
  const me = knownMe || (await api('/api/auth/me'));
  state.user = me.user;
  state.csrf = me.csrfToken;
  setAuthLink();
  if (me.pendingTwoFactor) {
    history.replaceState({}, '', '/two-factor');
    twoFactorChallenge();
    return;
  }
  if (me.pendingVerification && info.page !== 'verify') {
    verificationWall(me.pendingVerification.email);
    return;
  }
  if (state.user?.mustChangePassword) {
    history.replaceState({}, '', '/change-password');
    forcePassword();
    return;
  }
  if (info.page === 'two-factor-setup') {
    if (!state.user) { location.href = '/login'; return; }
    if (state.user.twoFactorEnabled) { location.href = '/'; return; }
    await twoFactorSetup();
    return;
  }
  if (info.page === 'two-factor') {
    location.href = state.user ? '/' : '/login';
    return;
  }
  if (info.page === 'change-password') {
    if (state.user) authForm('change');
    else authForm('login');
    return;
  }
  if (info.page === 'login') {
    authForm('login');
    return;
  }
  if (info.page === 'register') {
    authForm('register');
    return;
  }
  if (info.page === 'verify') {
    setView('authPanel');
    const panel = $('#authPanel');
    const verificationToken = new URLSearchParams(location.search).get('token') || '';
    panel.innerHTML = `<div class="auth-brand"><span class="brand-mark"><i class="fa-solid fa-book-open"></i></span><strong>${esc(state.config.site.name)}</strong></div><h1>${t('Confirma tu correo', 'Confirm your email')}</h1><p>${t('Activa tu cuenta para poder iniciar sesión.', 'Activate your account to sign in.')}</p><div class="form-message auth-error" hidden></div><button class="primary-button" id="confirmEmail">${t('Confirmar correo', 'Confirm email')}</button>`;
    $('#confirmEmail').onclick = async () => {
      try {
        await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token: verificationToken }) });
        location.href = '/login?notice=verified';
      } catch (e) {
        showError(panel, e);
      }
    };
    return;
  }
  if (info.page === 'reset') {
    const resetToken = new URLSearchParams(location.search).get('token');
    if (resetToken) {
      try {
        const account = await api('/api/auth/reset-account', { method: 'POST', body: JSON.stringify({ token: resetToken }) });
        authForm('reset', account.email);
      } catch (error) {
        authForm('reset');
        showError($('#authForm'), error);
      }
    } else authForm('forgot');
    return;
  }
  if (info.page === 'admin') {
    if (can('admin.view')) {
      await loadWiki();
      state.adminTab = info.tab;
      await adminView(info.tab, { replaceUrl: true });
      return;
    }
    authForm('login');
    return;
  }
  setView('articleWrap');
  await loadWiki();
}
async function boot() {
  try {
    const requestedLanguage = state.lang;
    const [me, config, translations] = await Promise.all([
      api('/api/auth/me'), api('/api/config'), getTranslations(requestedLanguage),
    ]);
    state.user = me.user;
    state.csrf = me.csrfToken;
    state.config = config;
    if (state.user?.mustChangePassword) {
      updateBrowserTitle(t('Página', 'Page'));
      forcePassword();
      return;
    }
    state.lang = state.config.languages.includes(state.lang) ? state.lang : state.config.languages[0];
    if (state.lang === requestedLanguage) {
      state.translations = translations;
      renderCookieNotice();
    } else await loadTranslations(state.lang);
    if (localStorage.getItem('wiki-theme') === 'light') document.body.classList.add('light');
    state.space = route().space;
    renderSpaces();
    await render(me);
    const notice = new URLSearchParams(location.search).get('notice');
    if (notice === 'verified')
      setNotice(t('Correo confirmado. Ya puedes iniciar sesión.', 'Email confirmed. You can now sign in.'));
    if (notice === 'verify-invalid')
      setNotice(
        t(
          'El enlace de confirmación venció o no es válido.',
          'That confirmation link expired or is invalid.',
        ),
        'error',
      );
  } catch (e) {
    if (e.status === 428) {
      try {
        const me = await api('/api/auth/me');
        if (me.user?.mustChangePassword) {
          state.user = me.user;
          state.csrf = me.csrfToken;
          forcePassword();
          return;
        }
      } catch {}
    }
    if (isUserError(e)) {
      setView('authPanel');
      $('#authPanel').textContent = userErrorText(e);
    } else showCouldNotStart(e, 'startup');
  }
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('.top-user-menu-wrap')) {
    $('#userMenu').classList.remove('open');
    $('#accountLink').setAttribute('aria-expanded', 'false');
  }
});
$('#spaceDropdownButton').onclick = () => {
  const picker = $('#spacePicker'),
    menu = $('#spaceDropdownMenu'),
    open = !menu.classList.contains('open');
  picker.classList.toggle('open', open);
  menu.classList.toggle('open', open);
  $('#spaceDropdownButton').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (event) => {
  if (!event.target.closest('#spacePicker')) {
    $('#spacePicker').classList.remove('open');
    $('#spaceDropdownMenu').classList.remove('open');
    $('#spaceDropdownButton').setAttribute('aria-expanded', 'false');
  }
});
$('#languageButton').onclick = () => {
  const menu = $('#languageMenu');
  const open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  $('#languageButton').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (event) => {
  if (!event.target.closest('.language-control')) {
    $('#languageMenu').classList.remove('open');
    $('#languageButton').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#languageMenu').classList.contains('open')) {
    $('#languageMenu').classList.remove('open');
    $('#languageButton').setAttribute('aria-expanded', 'false');
    $('#languageButton').focus();
  }
});
$('#themeToggle').onclick = () => {
  document.body.classList.toggle('light');
  localStorage.setItem('wiki-theme', document.body.classList.contains('light') ? 'light' : 'dark');
};
$('#searchInput').oninput = (e) => {
  clearTimeout(searchDebounceTimer);
  const value = e.target.value;
  searchDebounceTimer = setTimeout(() => {
    filterNav(value);
    renderSearchSuggestions(value);
  }, 140);
};
$('#searchInput').onkeydown = (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if ($('#searchSuggestions').hidden) return;
    e.preventDefault();
    searchSelection =
      (searchSelection + (e.key === 'ArrowDown' ? 1 : -1) + searchMatches.length) % searchMatches.length;
    $$('.search-suggestion', $('#searchSuggestions')).forEach((item, index) => {
      item.setAttribute('aria-selected', String(index === searchSelection));
      if (index === searchSelection) item.scrollIntoView({ block: 'nearest' });
    });
  } else if (e.key === 'Enter' && !$('#searchSuggestions').hidden && searchMatches.length) {
    e.preventDefault();
    const match = searchMatches[searchSelection >= 0 ? searchSelection : 0];
    if (match) navigateToPage(match.page.slug);
  } else if (e.key === 'Escape') {
    $('#searchSuggestions').hidden = true;
    e.stopPropagation();
  }
};
$('#searchSuggestions').onclick = (event) => {
  const option = event.target.closest('.search-suggestion');
  if (option) navigateToPage(option.dataset.slug);
};
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#searchInput').focus();
  }
  if (e.key === 'Escape') {
    closeMobileNav();
    $('#spacePicker').classList.remove('open');
    $('#spaceDropdownMenu').classList.remove('open');
    $('#spaceDropdownButton').setAttribute('aria-expanded', 'false');
  }
});
$('#openSidebar').onclick = () => {
  $('#sidebar').classList.add('open');
  $('#mobileShade').classList.add('open');
};
$('#mobileDocsSearch').onclick = () => {
  $('#openSidebar').click();
  $('#searchInput').focus();
};
$('#closeSidebar').onclick = closeMobileNav;
$('#mobileShade').onclick = closeMobileNav;
window.addEventListener('popstate', () => {
  showLoading();
  render().finally(hideLoading);
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
renderCookieNotice();
showLoading();
boot().finally(() => {
  loadingDepth = 0;
  hideLoading();
});
