const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
let language = localStorage.getItem('installer-language') === 'es' ? 'es' : 'en';
let currentStep = 0, furthestStep = 0, databasePassed = false, emailPassed = false;
let databaseTestRun = 0, emailTestRun = 0, installing = false;
const databaseFields = ['dbType', 'dbSqliteFile', 'dbHost', 'dbPort', 'dbName', 'dbUser', 'dbPassword', 'dbSsl'];
const emailFields = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'smtpFrom', 'smtpTestEmail', 'smtpSecure'];
const fields = [...databaseFields, ...emailFields, 'siteName', 'baseUrl', 'nodeEnv', 'appHost', 'appPort',
  'adminUsername', 'adminEmail', 'adminPassword', 'adminPasswordConfirm'];
const t = (es, en) => language === 'es' ? es : en;
const collect = (ids = fields) => Object.fromEntries(ids.map((id) => {
  const element = $('#' + id);
  return [id, element.type === 'checkbox' ? element.checked : element.type === 'password' ? element.value : element.value.trim()];
}));
const fingerprint = (ids) => JSON.stringify(collect(ids));

function setLanguage(next) {
  language = next;
  localStorage.setItem('installer-language', language);
  document.documentElement.lang = language;
  $$('[data-es][data-en]').forEach((element) => { element.textContent = element.dataset[language]; });
  $('#languageToggle').textContent = language === 'es' ? 'EN' : 'ES';
  $('#languageToggle').setAttribute('aria-label', t('Cambiar idioma', 'Change language'));
  $('#progressRing').setAttribute('aria-label', t('Progreso de instalación', 'Installation progress'));
}
function showFatal(code) {
  if ($('#fatalBox')) return;
  const overlay = document.createElement('div'), card = document.createElement('div');
  overlay.id = 'fatalBox';
  overlay.className = 'fatal-box';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  card.className = 'fatal-box-card';
  const title = document.createElement('h1'), text = document.createElement('p');
  title.textContent = `[${code}] An error ocurred`;
  text.textContent = 'If you are the server administrator, please check the console';
  card.append(title, text);
  overlay.append(card);
  document.body.append(overlay);
}
function renderSteps() {
  $$('.setup-page').forEach((page, index) => { page.hidden = index !== currentStep; });
  $$('.aside-step').forEach((button, index) => {
    const done = index < currentStep && (index !== 1 || databasePassed) && (index !== 2 || emailPassed);
    button.classList.toggle('active', index === currentStep);
    button.classList.toggle('done', done);
    button.disabled = installing || index > furthestStep || index === 5 ||
      (index > 1 && !databasePassed) || (index > 2 && !emailPassed);
    if (index === currentStep) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    $('.step-indicator', button).textContent = done ? '✓' : String(index + 1);
  });
  $('#nextDatabase').disabled = !databasePassed;
  $('#nextSmtp').disabled = !emailPassed;
}
function goToStep(index) {
  currentStep = index;
  furthestStep = Math.max(furthestStep, index);
  renderSteps();
  const heading = $(`.setup-page[data-page="${index}"] h1`);
  heading.setAttribute('tabindex', '-1');
  heading.focus();
}
function invalidateDatabase() {
  databaseTestRun++;
  databasePassed = false;
  $('#dbMessage').hidden = true;
  $('#testDatabase').disabled = false;
  renderSteps();
}
function invalidateEmail() {
  emailTestRun++;
  emailPassed = false;
  $('#smtpMessage').hidden = true;
  $('#testSmtp').disabled = false;
  renderSteps();
}
function message(selector, text, good = false) {
  const box = $(selector);
  box.textContent = text;
  box.className = 'inline-message ' + (good ? 'good' : 'bad');
  box.hidden = false;
}
async function send(path, payload) {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Setup-Key': $('#setupCode').value.trim() },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.details = data.details;
    throw error;
  }
  return response;
}
function firstErrorLine(error) {
  return String(error.details?.message || error.message || 'Connection failed').split(/[\r\n]/, 1)[0];
}
async function testConnection(kind) {
  const db = kind === 'db', ids = db ? databaseFields : emailFields;
  const selector = db ? '#dbMessage' : '#smtpMessage';
  const button = $(db ? '#testDatabase' : '#testSmtp');
  if (db) invalidateDatabase(); else invalidateEmail();
  const run = db ? databaseTestRun : emailTestRun, tested = fingerprint(ids);
  const payload = { ...collect(ids), language };
  button.disabled = true;
  try {
    await send(db ? '/api/setup/test-db' : '/api/setup/test-smtp', payload);
    if (run !== (db ? databaseTestRun : emailTestRun)) return;
    const passed = tested === fingerprint(ids);
    if (db) databasePassed = passed; else emailPassed = passed;
    if (passed) message(selector, db
      ? (collect(['dbType']).dbType === 'sqlite'
          ? t('Archivo SQLite accesible y listo para instalar.', 'SQLite file is accessible and ready for installation.')
          : t('Conexión a MySQL/MariaDB correcta.', 'MySQL/MariaDB connected successfully.'))
      : t('Conexión SMTP correcta. Se envió el correo de prueba.', 'SMTP connected successfully. Test email sent.'), true);
  } catch (error) {
    if (run !== (db ? databaseTestRun : emailTestRun)) return;
    if (error.status >= 500) {
      console.error('[Teralth Wiki] Installer connection test failed:', error.status);
      return showFatal('SETUP_CONNECTION_ERROR');
    }
    message(selector, `[${db ? ($('#dbType').value === 'sqlite' ? 'SQLite' : 'MySQL/MariaDB') : 'SMTP'}] ${t('Ocurrió un error', 'An error occurred')}: ${firstErrorLine(error)}`);
  } finally {
    if (run === (db ? databaseTestRun : emailTestRun)) {
      button.disabled = false;
      renderSteps();
    }
  }
}
function checkWebsite() {
  const inputs = $$('.setup-page[data-page="3"] input[required]');
  const invalid = inputs.find((input) => !input.value.trim() || !input.validity.valid);
  if (invalid) {
    invalid.focus();
    message('#websiteMessage', t('Completa los campos del sitio con valores válidos.', 'Complete the website fields with valid values.'));
    return false;
  }
  let url;
  try { url = new URL($('#baseUrl').value); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || ($('#nodeEnv').value === 'production' && url.protocol !== 'https:')) {
    message('#websiteMessage', t('Usa solo el origen público; en producción debe usar HTTPS.', 'Use only the public origin; production requires HTTPS.'));
    $('#baseUrl').focus();
    return false;
  }
  for (const id of ['siteLogo', 'siteFavicon']) {
    const file = $('#' + id).files[0];
    if (file && (file.size > 2 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) {
      message('#websiteMessage', t('Elige imágenes PNG, JPEG, GIF o WebP de hasta 2 MB.', 'Choose PNG, JPEG, GIF or WebP images up to 2 MB.'));
      $('#' + id).focus();
      return false;
    }
  }
  $('#websiteMessage').hidden = true;
  return true;
}
function passwordChecks() {
  const value = $('#adminPassword').value, confirm = $('#adminPasswordConfirm').value;
  return {
    length: value.length >= 16 && new TextEncoder().encode(value).length <= 72,
    upper: /[A-Z]/.test(value), lower: /[a-z]/.test(value), number: /[0-9]/.test(value),
    special: /[^A-Za-z0-9]/.test(value), match: value.length > 0 && value === confirm,
  };
}
function updatePassword() {
  const checks = passwordChecks();
  $$('[data-check]').forEach((item) => item.classList.toggle('ok', checks[item.dataset.check]));
  $('#adminMessage').hidden = true;
}
function checkAdmin() {
  const username = $('#adminUsername'), email = $('#adminEmail');
  if (!/^[\p{L}\p{N}_.-]{2,60}$/u.test(username.value.trim())) {
    message('#adminMessage', t('Introduce un usuario válido de 2 a 60 caracteres.', 'Enter a valid username of 2 to 60 characters.'));
    username.focus();
    return false;
  }
  if (!email.value.trim() || !email.validity.valid) {
    message('#adminMessage', t('Introduce un correo válido.', 'Enter a valid email address.'));
    email.focus();
    return false;
  }
  if (Object.values(passwordChecks()).some((value) => !value)) {
    message('#adminMessage', t('Revisa los requisitos de la contraseña y su confirmación.', 'Check the password requirements and confirmation.'));
    $('#adminPassword').focus();
    return false;
  }
  $('#adminMessage').hidden = true;
  return true;
}
function randomPassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*_-'];
  const randomIndex = (limit) => {
    const range = 0x100000000;
    const ceiling = Math.floor(range / limit) * limit;
    let value;
    do {
      value = crypto.getRandomValues(new Uint32Array(1))[0];
    } while (value >= ceiling);
    return value % limit;
  };
  const choose = (chars) => chars[randomIndex(chars.length)];
  const chars = groups.map(choose), all = groups.join('');
  while (chars.length < 20) chars.push(choose(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  $('#adminPassword').value = chars.join('');
  $('#adminPasswordConfirm').value = chars.join('');
  $('#adminPassword').type = 'text';
  updatePassword();
  $('#adminPassword').focus();
}
function readImage(id) {
  const file = $('#' + id).files[0];
  if (!file) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
}
function progress(value, stage) {
  $('#progressArc').setAttribute('stroke-dashoffset', String(100 - value));
  $('#progressRing').setAttribute('aria-valuenow', String(value));
  $('#progressValue').textContent = `${value}%`;
  const labels = {
    preparing: t('Preparando la instalación…', 'Preparing installation…'),
    validated: t('Configuración validada.', 'Configuration validated.'),
    database: t('Permisos de la base de datos comprobados.', 'Database permissions checked.'),
    starting: t('Configuración guardada. Iniciando la wiki…', 'Configuration saved. Starting the wiki…'),
    ready: t('La wiki está lista.', 'The wiki is ready.'),
  };
  $('#progressMessage').textContent = labels[stage] || '';
}
async function waitForWiki() {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        const config = await response.json();
        if (config.site) {
          progress(100, 'ready');
          location.href = '/';
          return;
        }
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  console.error('[Teralth Wiki] Installer: wiki did not become ready.');
  showFatal('SETUP_STARTUP_TIMEOUT');
}
async function runInstall() {
  installing = true;
  goToStep(5);
  progress(0, 'preparing');
  $('#installError').hidden = true;
  $('#retryInstall').hidden = true;
  try {
    const payload = { ...collect(), siteLogo: await readImage('siteLogo'), siteFavicon: await readImage('siteFavicon') };
    const response = await send('/api/setup/install', payload);
    if (!response.body) throw new Error('Installation progress stream unavailable.');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', started = false;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines.filter((item) => item.trim())) {
        const event = JSON.parse(line);
        if (event.error) {
          const error = new Error(event.error);
          error.status = event.status;
          throw error;
        }
        if (event.progress && event.stage) {
          progress(event.progress, event.stage);
          if (event.stage === 'starting') started = true;
        }
      }
      if (done) break;
    }
    if (!started) throw new Error('Installation ended without a completion event.');
    await waitForWiki();
  } catch (error) {
    installing = false;
    if (error.status >= 400 && error.status < 500) {
      message('#installError', error.message);
      $('#retryInstall').hidden = false;
      renderSteps();
    } else {
      console.error('[Teralth Wiki] Installer failed:', error.message);
      showFatal('SETUP_INSTALL_ERROR');
    }
  }
}
async function initialize() {
  try {
    const response = await fetch('/api/setup/status');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    $('#appPort').value = status.port;
    $('#appHost').value = status.host;
    if (status.environment === 'production' || status.pterodactyl) $('#nodeEnv').value = 'production';
    if ($('#nodeEnv').value === 'development') $('#baseUrl').value = `http://127.0.0.1:${status.port}`;
  } catch (error) {
    console.error('[Teralth Wiki] Installer initialization failed:', error.message);
    showFatal('SETUP_INIT_ERROR');
  }
}
$('#languageToggle').addEventListener('click', () => setLanguage(language === 'es' ? 'en' : 'es'));
$('#generatePassword').addEventListener('click', randomPassword);
for (const id of databaseFields) {
  $('#' + id).addEventListener('input', invalidateDatabase);
  $('#' + id).addEventListener('change', invalidateDatabase);
}
for (const id of emailFields) {
  $('#' + id).addEventListener('input', invalidateEmail);
  $('#' + id).addEventListener('change', invalidateEmail);
}
for (const id of ['adminPassword', 'adminPasswordConfirm']) $('#' + id).addEventListener('input', updatePassword);
for (const id of ['adminUsername', 'adminEmail']) $('#' + id).addEventListener('input', () => { $('#adminMessage').hidden = true; });
$$('.setup-page[data-page="3"] input, .setup-page[data-page="3"] select').forEach((input) =>
  input.addEventListener('change', () => { $('#websiteMessage').hidden = true; }));
$('#testDatabase').addEventListener('click', () => testConnection('db'));
$('#testSmtp').addEventListener('click', () => testConnection('smtp'));
$('#nextSetupKey').addEventListener('click', () => {
  if (!$('#setupCode').value.trim()) {
    message('#keyMessage', t('Introduce el código que está en setup.key.', 'Enter the code stored in setup.key.'));
    $('#setupCode').focus();
    return;
  }
  $('#keyMessage').hidden = true;
  goToStep(1);
});
function renderDatabaseFields() {
  const sqlite = $('#dbType').value === 'sqlite';
  $('#sqliteFields').hidden = !sqlite;
  $('#mysqlFields').hidden = sqlite;
  $('#dbSslRow').hidden = sqlite;
  $('#sqliteWarning').hidden = !sqlite;
  for (const id of ['dbHost','dbPort','dbName','dbUser','dbPassword']) $('#' + id).required = !sqlite;
  $('#dbSqliteFile').required = sqlite;
}
$('#dbType').addEventListener('change', () => {
  renderDatabaseFields();
  invalidateDatabase();
});
$('#nextDatabase').addEventListener('click', () => { if (databasePassed) goToStep(2); });
$('#nextSmtp').addEventListener('click', () => { if (databasePassed && emailPassed) goToStep(3); });
$('#nextWebsite').addEventListener('click', () => { if (databasePassed && emailPassed && checkWebsite()) goToStep(4); });
$$('.back').forEach((button) => button.addEventListener('click', () => goToStep(currentStep - 1)));
$$('.aside-step').forEach((button) => button.addEventListener('click', () => goToStep(Number(button.dataset.step))));
$('#retryInstall').addEventListener('click', () => goToStep(4));
$('#setupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (currentStep !== 4 || installing) return;
  if (!databasePassed) return goToStep(1);
  if (!emailPassed) return goToStep(2);
  if (!checkWebsite()) return goToStep(3);
  if (checkAdmin()) runInstall();
});
setLanguage(language);
renderDatabaseFields();
renderSteps();
initialize();
$('#setupCode').focus();
