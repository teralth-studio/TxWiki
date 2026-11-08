const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const express = require('express');
const { composeAppScript, publicScripts, publicStaticOnly, sendPublicHtml } = require('../../scripts/public-scripts');

function conditionalGet(url, etag) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'If-None-Match': etag } }, response => {
      response.resume();
      response.on('end', () => resolve(response));
    }).on('error', reject);
  });
}

test('mobile documentation search opens navigation and focuses the search input', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf("$('#mobileDocsSearch').onclick =");
  const end = source.indexOf("\n$('#closeSidebar').onclick", start);
  assert.ok(start >= 0 && end > start);
  const search = {};
  const sidebar = { clickCount: 0, click() { this.clickCount++; } };
  const input = { focused: false, focus() { this.focused = true; } };
  const elements = { '#mobileDocsSearch': search, '#openSidebar': sidebar, '#searchInput': input };
  vm.runInNewContext(source.slice(start, end), { $: selector => elements[selector] });
  search.onclick();
  assert.equal(sidebar.clickCount, 1);
  assert.equal(input.focused, true);
});

test('application bundle initializes the updates module before the app code', () => {
  const updatesSource = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin-updates.js'), 'utf8');
  const bundle = composeAppScript('window.appSawUpdates = typeof window.TeralthAdminUpdates.render;', updatesSource);
  const context = { window: {} };
  vm.runInNewContext(bundle, context);
  assert.equal(context.window.appSawUpdates, 'function');
});

test('served obfuscated app bundle exposes the updates renderer', async () => {
  const app = express();
  app.use(publicScripts);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/app.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    const context = {
      window: {},
      document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } },
      localStorage: { getItem() { return 'en'; } },
      location: { pathname: '/', search: '', hash: '', origin: 'http://127.0.0.1' },
      navigator: {},
      history: { pushState() {}, replaceState() {} },
      fetch() { return Promise.resolve({ ok: true, json: async () => ({}) }); },
      URL,
      URLSearchParams,
      console,
      setTimeout,
      clearTimeout,
      Promise,
      Map,
      Set,
      FormData,
      XMLHttpRequest: function () {},
    };
    try {
      vm.runInNewContext(await response.text(), context, { timeout: 5000 });
    } catch {
      // The app expects the full browser DOM; the update module is initialized before app startup.
    }
    assert.equal(typeof context.window.TeralthAdminUpdates?.render, 'function');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('support card visibility follows the persisted site setting', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function renderSupportCard()');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const elements = Object.fromEntries(
    ['#supportCard', '#supportTitle', '#supportDescription', '#supportLink', '#supportLinkText']
      .map(selector => [selector, { style: {}, textContent: '' }]),
  );
  const context = {
    state: { config: { site: { supportUrl: '' } }, lang: 'en', translations: {} },
    $: selector => elements[selector],
    setSupportCardAppearance() {},
    location: { origin: 'https://wiki.example.test' },
    URL,
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.renderSupportCard();
  assert.equal(elements['#supportCard'].hidden, false);
  context.state.config.site.support = { enabled: false };
  context.renderSupportCard();
  assert.equal(elements['#supportCard'].hidden, true);
  context.state.config.site.support.enabled = true;
  context.renderSupportCard();
  assert.equal(elements['#supportCard'].hidden, false);
});

test('fatal error message includes a sanitized code in brackets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function showCouldNotStart(');
  const end = source.indexOf('\nfunction isUserError(', start);
  assert.ok(start >= 0 && end > start);
  const makeElement = () => ({
    children: [],
    setAttribute() {},
    append(...children) { this.children.push(...children); },
  });
  const body = makeElement();
  const context = {
    document: {
      body,
      getElementById() { return null; },
      createElement: makeElement,
    },
    reportClientError() {},
    t(es, en) { return en; },
  };
  vm.runInNewContext(source.slice(start, end) + '\nshowCouldNotStart({ code: "TEST_FAILURE" });', context);
  const [title, text] = body.children[0].children[0].children;
  assert.equal(title.textContent, '[TEST_FAILURE] An error ocurred');
  assert.equal(text.textContent, 'If you are the server administrator, please check the console');
});

test('form errors stay inline while internal errors use the fatal screen', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function isUserError(');
  const end = source.indexOf('\nasync function confirmUnsaved(', start);
  assert.ok(start >= 0 && end > start);
  const box = { hidden: true, textContent: '', setAttribute(name, value) { this[name] = value; } };
  const form = { tagName: 'FORM' };
  const fatal = [];
  const context = {
    document: { addEventListener() {} },
    $: (selector, target) => target === form && selector === '.form-message' ? box : null,
    localizedMessage: message => `translated: ${message}`,
    showCouldNotStart: error => fatal.push(error),
    window: {},
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.showError(form, context.validationError('Complete the CAPTCHA verification.'));
  assert.equal(box.hidden, false);
  assert.equal(box.textContent, 'Complete the CAPTCHA verification.');
  assert.equal(box.role, 'alert');
  assert.equal(fatal.length, 0);
  context.showError(form, Object.assign(new Error('Invalid credentials'), { status: 401 }));
  assert.equal(box.textContent, 'translated: Invalid credentials');
  context.showError(form, new Error('Internal failure'));
  assert.equal(fatal.length, 1);
});

test('image uploads handle JSON, proxy errors and malformed successful responses', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function responseError(');
  const end = source.indexOf('\nfunction userErrorText(', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(source.slice(start, end), context);
  const response = (body, status) => new Response(body, {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const valid = await context.imageUploadResponse(response(
    JSON.stringify({ url: '/media/abcdefghijklmnop.webp', mime: 'image/webp', alt: 'sample' }), 201,
  ));
  assert.equal(valid.url, '/media/abcdefghijklmnop.webp');
  await assert.rejects(context.imageUploadResponse(response('<html>too large</html>', 413)), error =>
    error.status === 413 && error.message === 'Image upload failed (HTTP 413).');
  await assert.rejects(context.imageUploadResponse(response(
    JSON.stringify({ error: 'El archivo no puede pesar más de 5 MB.' }), 413,
  )), error => error.status === 413 && error.message === 'El archivo no puede pesar más de 5 MB.');
  await assert.rejects(context.imageUploadResponse(response('', 502)), error =>
    error.status === 502 && error.message === 'Image upload failed (HTTP 502).');
  for (const body of ['<html>invalid</html>', '{}', '{"url":"https://example.test/a.webp"}']) {
    await assert.rejects(context.imageUploadResponse(response(body, 200)), error =>
      error.code === 'IMAGE_UPLOAD_RESPONSE_INVALID');
  }
  const localizeStart = source.indexOf('function localizedMessage(');
  const localizeEnd = source.indexOf('\nfunction showCouldNotStart(', localizeStart);
  assert.ok(localizeStart >= 0 && localizeEnd > localizeStart);
  const localization = { state: { lang: 'en' } };
  vm.runInNewContext(source.slice(localizeStart, localizeEnd), localization);
  assert.match(localization.localizedMessage('Image upload failed (HTTP 413).'), /server or proxy size limit/);
  localization.state.lang = 'es';
  assert.match(localization.localizedMessage('Image upload failed (HTTP 413).'), /límite de tamaño del servidor o del proxy/);
  assert.equal(localization.localizedMessage('El archivo no puede pesar más de 12 MB.'), 'El archivo no puede pesar más de 12 MB.');
  localization.state.lang = 'en';
  assert.equal(localization.localizedMessage('El archivo no puede pesar más de 12 MB.'), 'The file must be 12 MB or smaller.');
});

test('registration confirmation translates as a success message in every supported language', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function localizedMessage(');
  const end = source.indexOf('\nfunction showCouldNotStart(', start);
  assert.ok(start >= 0 && end > start);
  const message = 'Si los datos son válidos, recibirás un correo para confirmar tu cuenta.';
  const key = 'If the details are valid, you will receive an email to confirm your account.';
  for (const locale of ['en', 'es', 'de', 'fr', 'pt-BR']) {
    const translations = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'languages', `language_${locale}.json`), 'utf8'));
    assert.ok(translations[key]);
    const context = { state: { lang: locale, translations } };
    vm.runInNewContext(source.slice(start, end), context);
    assert.equal(context.localizedMessage(message), locale === 'es' ? message : translations[key]);
  }
});

test('admin upload requests leave multipart content type to the browser', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('async function api(path, options = {})');
  const end = source.indexOf('\nfunction localizedMessage(', start);
  assert.ok(start >= 0 && end > start);
  const form = new FormData();
  form.append('package', new Blob(['zip']), 'update.zip');
  let captured;
  const context = {
    document: { activeElement: null },
    FormData,
    form,
    state: { space: 'main', csrf: 'token' },
    beginButtonLoading: () => () => {},
    request: async (url, options) => {
      captured = { url, options };
      return new Response('{}', { status: 200 });
    },
  };
  await vm.runInNewContext(source.slice(start, end) + "\napi('/api/admin/updates', { method: 'POST', body: form });", context);
  assert.equal(captured.url, '/api/admin/updates');
  assert.equal(captured.options.headers['X-CSRF-Token'], 'token');
  assert.equal(Object.hasOwn(captured.options.headers, 'Content-Type'), false);
  assert.equal(captured.options.body, form);
});

test('update admin page validates the selected package before opening maintenance', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin-updates.js'), 'utf8');
  let submit;
  const file = new File(['zip'], 'release.zip');
  const button = { disabled: false };
  const uploaded = [];
  const sequence = [];
  const progressBar = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
  };
  const progress = {
    hidden: true,
    classList: { toggle() {}, contains() { return false; } },
  };
  const progressStage = { textContent: '' };
  const progressPercent = { textContent: '' };
  const progressFill = { style: {} };
  const progressNote = { textContent: '' };
  const errorBox = { hidden: true, textContent: '' };
  class MockRequest {
    constructor() {
      this.upload = { addEventListener() {} };
      this.headers = {};
      this.listeners = {};
      this.status = 202;
      this.responseText = '{"ok":true,"token":"validated-token","version":"1.0.1"}';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }
    send(body) {
      uploaded.push({ method: this.method, url: this.url, headers: this.headers, body });
      sequence.push('validate');
      this.listeners.load();
    }
  }
  const root = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '#siteUpdateForm') return { addEventListener: (event, handler) => (submit = handler) };
      if (selector === '#siteUpdateFile') return { files: [file] };
      if (selector === '#applySiteUpdate') return button;
      if (selector === '#updateValidation') return progress;
      if (selector === '#updateValidationStage') return progressStage;
      if (selector === '#updateValidationPercent') return progressPercent;
      if (selector === '#updateValidationBar') return progressBar;
      if (selector === '#updateValidationFill') return progressFill;
      if (selector === '#updateValidationNote') return progressNote;
      if (selector === '.update-validation-error') return errorBox;
      return null;
    },
  };
  const requests = [];
  const alerts = [];
  const context = {
    document: { querySelector: () => ({}), head: { append() {} }, createElement: () => ({}) },
    window: {
      Swal: { fire: async (alert) => (alerts.push(alert), { isConfirmed: true }) },
      TeralthMaintenance: { enter() { sequence.push('maintenance'); }, setProgress() {} },
      setTimeout,
    },
    XMLHttpRequest: MockRequest,
    FormData,
  };
  vm.runInNewContext(source, context);
  await context.window.TeralthAdminUpdates.render(root, {
    api: async (url, options) => {
      requests.push([url, options]);
      if (url === '/api/admin/updates/validation-progress')
        return { active: false, progress: 0, stage: 'idle' };
      if (url === '/api/admin/updates/install') {
        sequence.push('install');
        return { ok: true };
      }
      return { configured: true, currentVersion: '1.0.0', updates: [] };
    },
    t: (spanish, english) => english,
    esc: (value) => String(value),
    showError: (_target, error) => { throw error; },
    csrf: 'csrf-token',
  });
  assert.match(root.innerHTML, /Site updates/);
  assert.match(root.innerHTML, /1\.0\.0/);
  assert.match(root.innerHTML, /id="updateValidation"/);
  await submit({ preventDefault() {} });
  assert.equal(uploaded[0].url, '/api/admin/updates/validate');
  assert.equal(uploaded[0].method, 'POST');
  assert.equal(uploaded[0].headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(uploaded[0].body.get('package').name, file.name);
  const install = requests.find(([url]) => url === '/api/admin/updates/install');
  assert.deepEqual(JSON.parse(install[1].body), { token: 'validated-token' });
  assert.deepEqual(sequence, ['validate', 'maintenance', 'install']);
  assert.equal(progress.hidden, false);
  assert.equal(progressPercent.textContent, '100%');
  assert.match(progressNote.textContent, /no static check can guarantee that it has no malicious behavior/);
  assert.equal(button.disabled, true);
  assert.equal(alerts.length, 1);
});

test('password change messages describe the outcome without internal delivery details', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function passwordChangeNotificationText(');
  const end = source.indexOf('\nconst captchaScriptLoads', start);
  assert.ok(start >= 0 && end > start);
  const context = { t: (es, en) => en };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.passwordChangeNotificationText(true), '');
  assert.equal(context.passwordChangeNotificationText(false), 'The password was saved, but the email could not be sent.');
  assert.equal((source.match(/text: passwordChangeNotificationText\(result\.notificationQueued\)/g) || []).length, 2);
  assert.doesNotMatch(source, /The security notice was queued for delivery/);
  for (const locale of ['en', 'es', 'de', 'fr', 'pt-BR']) {
    const translations = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'languages', `language_${locale}.json`), 'utf8'));
    assert.ok(translations['The password was saved, but the email could not be sent.']);
    assert.ok(translations['Verification email requested']);
  }
});

test('verification screen displays an escaped read-only account email and keeps resend interactive', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function verificationWall(');
  const end = source.indexOf('\nfunction checkPassword(', start);
  assert.ok(start >= 0 && end > start);
  const panel = {}, form = {}, box = { hidden: true };
  const calls = [], notices = [];
  const context = {
    setView() {},
    state: { config: { site: { name: 'Example' }, captcha: { enabled: false } } },
    t: (es, en) => en,
    esc: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    $: (selector) => selector === '#authPanel' ? panel : selector === '#verificationForm' ? form : box,
    createCaptchaController: () => ({ token() { throw new Error('CAPTCHA is disabled'); }, reset() {} }),
    api: async (...args) => { calls.push(args); },
    notify(options) { notices.push(options); },
    showError: (target, error) => { throw error; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.verificationWall('user+"test"@example.test');
  assert.match(panel.innerHTML, /<label for="verificationEmail">You registered with this email:<\/label>/);
  assert.match(panel.innerHTML, /value="user\+&quot;test&quot;@example\.test" readonly/);
  assert.match(panel.innerHTML, /class="verification-notice"/);
  await form.onsubmit({ preventDefault() {} });
  assert.equal(calls[0][0], '/api/auth/resend-verification');
  assert.equal(notices[0].title, 'Verification email requested');
});

test('success and error notifications receive their own toast classes without modifying other icons', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function notify(');
  const end = source.indexOf('\nfunction setNotice(', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = { Swal: { fire: options => { calls.push(options); } } };
  vm.runInNewContext(source.slice(start, end), context);
  context.notify({ icon: 'success', customClass: { popup: 'custom' } });
  context.notify({ icon: 'error' });
  context.notify({ icon: 'warning' });
  assert.match(calls[0].customClass.popup, /custom wiki-toast wiki-toast-success/);
  assert.match(calls[1].customClass.popup, /wiki-toast-error/);
  assert.equal(calls[0].iconHtml, '<i class="fa-regular fa-circle-check" aria-hidden="true"></i>');
  assert.equal(calls[1].iconHtml, '<i class="fa-regular fa-circle-xmark" aria-hidden="true"></i>');
  assert.equal(calls[2].iconHtml, undefined);
  assert.doesNotMatch(calls[2].customClass.popup, /wiki-toast-(success|error)/);
  assert.ok(calls.every(call => call.position === 'top-end'));
});

test('return URLs cannot redirect outside the current origin', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function safeLocalReturn(');
  const end = source.indexOf('\nfunction renderSpaces(', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL, location: { origin: 'https://wiki.example.test' } };
  vm.runInNewContext(source.slice(start, end), context);
  for (const value of [
    '//attacker.example.test/path', 'https://wiki.example.test//attacker.example.test/path',
    'https://attacker.example.test/', '/\\attacker.example.test', 'javascript:alert(1)',
  ]) assert.equal(context.safeLocalReturn(value), '/', value);
  assert.equal(context.safeLocalReturn('/docs?lang=es#section'), '/docs?lang=es#section');
  assert.equal(context.safeLocalReturn('https://wiki.example.test/docs'), '/docs');
});

test('external page redirects require a visible link while same-origin redirects stay automatic', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function renderExternalRedirect(');
  const end = source.indexOf('\nasync function loadWiki()', start);
  assert.ok(start >= 0 && end > start);
  async function loadRedirect(url) {
    const article = { innerHTML: '' };
    const reactions = { hidden: false };
    const toc = { hidden: false };
    const state = {
      pages: [{ slug: 'redirect', page_type: 'redirect', redirect_url: url, titles: { en: 'External destination' } }],
      lang: 'en',
      space: 'main',
      config: { site: { name: 'Wiki' }, spaces: [{ slug: 'main', name: 'Wiki' }] },
    };
    const locations = [];
    const context = {
      state,
      location: {
        origin: 'https://wiki.example.test',
        assign: destination => locations.push(destination),
      },
      URL,
      esc: value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
      t: (_spanish, english) => english,
      $: selector => ({ '#article': article, '#reactions': reactions, '#toc': toc })[selector],
      $$: () => [],
      renderPage() {},
      renderExternalRedirect(target) {
        article.innerHTML = `<a href="${target.href}">${target.hostname}</a>`;
        reactions.hidden = true;
        toc.hidden = true;
      },
    };
    vm.runInNewContext(`let pageRequestSequence = 0;\n${source.slice(start, end)}`, context);
    await context.loadPage('redirect');
    return { article, locations, reactions, toc };
  }
  const external = await loadRedirect('https://outside.example/path');
  assert.deepEqual(external.locations, []);
  assert.match(external.article.innerHTML, /outside\.example/);
  assert.equal(external.reactions.hidden, true);
  const internal = await loadRedirect('/docs/next');
  assert.deepEqual(internal.locations, ['https://wiki.example.test/docs/next']);
});

test('table of contents renders nested headings as visible links without dropdown controls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function buildTocTree(');
  const end = source.indexOf('\nlet tocActiveCleanup', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    t: (es, en) => en,
    esc: value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
  };
  vm.runInNewContext(source.slice(start, end), context);
  for (const prefix of ['section', 'edit-section']) {
    const heads = [
      { tagName: 'H1', textContent: 'Title <one>' },
      { tagName: 'H2', textContent: 'Child' },
      { tagName: 'H3', textContent: 'Grandchild' },
      { tagName: 'H1', textContent: 'Other' },
    ];
    const html = context.buildTocTree(heads, prefix);
    assert.match(html, /Title &lt;one&gt;/);
    assert.match(html, /toc-tree-children/);
    assert.equal((html.match(/data-toc-index=/g) || []).length, 4);
    assert.deepEqual(heads.map(item => item.id), heads.map((_, index) => `${prefix}-${index}`));
    assert.doesNotMatch(html, /data-toc-toggle|<button|hidden|fa-chevron/);
  }
});

test('browser title follows the active page and its available translation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const pageStart = source.indexOf('function renderPage(');
  const pageEnd = source.indexOf('\nfunction paintReactions(', pageStart);
  const titleStart = source.indexOf('function updateBrowserTitle(');
  const titleEnd = source.indexOf('\nfunction updateBrand(', titleStart);
  assert.ok(pageStart >= 0 && pageEnd > pageStart && titleStart >= 0 && titleEnd > titleStart);
  const article = {
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
    },
  }, breadcrumbs = {}, reactions = {};
  const context = {
    state: {
      page: { titles: { en: 'Home', es: 'Inicio' }, content: {}, slug: 'home' },
      lang: 'en', space: 'main', config: { site: { pageTitle: 'Example Wiki' }, spaces: [] },
    },
    document: { title: '', querySelector: () => null }, loadingDepth: 0, browserTitle: 'Teralth Wiki',
    $: selector => ({ '#article': article, '#breadcrumbs': breadcrumbs, '#reactions': reactions }[selector]),
    $$: () => [], editorHtmlFromMarkup: () => '', highlightCodeBlock() {}, renderLastEdited() {}, renderToc() {},
    paintReactions() {}, esc: value => value, t: (es, en) => en, requestAnimationFrame: callback => callback(),
  };
  vm.runInNewContext(source.slice(titleStart, titleEnd) + '\n' + source.slice(pageStart, pageEnd), context);
  context.renderPage();
  assert.equal(context.document.title, 'Home • Example Wiki');
  assert.equal(article.classList.values.has('article-enter'), true);
  context.state.lang = 'es';
  context.renderPage();
  assert.equal(context.document.title, 'Inicio • Example Wiki');
  context.state.lang = 'es-MX';
  context.renderPage();
  assert.equal(context.document.title, 'Inicio • Example Wiki');
  context.state.page.titles = {};
  context.renderPage();
  assert.equal(context.document.title, 'home • Example Wiki');
  context.updateBrowserTitle('Admin');
  assert.equal(context.document.title, 'Admin • Example Wiki');
});

test('browser title stays Loading... until all loaders finish and restores the latest title', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const loadingStart = source.indexOf('function showLoading()');
  const loadingEnd = source.indexOf('\nconst esc =', loadingStart);
  const titleStart = source.indexOf('function updateBrowserTitle(');
  const titleEnd = source.indexOf('\nfunction updateBrand(', titleStart);
  assert.ok(loadingStart >= 0 && loadingEnd > loadingStart && titleStart >= 0 && titleEnd > titleStart);
  const loader = { hidden: true };
  const context = {
    loadingDepth: 0, browserTitle: 'Teralth Wiki',
    state: { config: { site: { pageTitle: 'Example Wiki' } } },
    document: { title: 'Home • Example Wiki', querySelector: () => null },
    $: () => loader,
  };
  vm.runInNewContext(source.slice(loadingStart, loadingEnd) + '\n' + source.slice(titleStart, titleEnd), context);
  context.showLoading();
  assert.equal(context.document.title, 'Loading...');
  assert.equal(loader.hidden, false);
  context.showLoading();
  context.updateBrowserTitle('Next page');
  assert.equal(context.document.title, 'Loading...');
  context.hideLoading();
  assert.equal(context.document.title, 'Loading...');
  assert.equal(loader.hidden, false);
  context.hideLoading();
  assert.equal(context.document.title, 'Next page • Example Wiki');
  assert.equal(loader.hidden, true);
  context.showLoading();
  context.hideLoading();
  assert.equal(context.document.title, 'Next page • Example Wiki');
});

test('initial application HTML exposes the configured site title to crawlers', async () => {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = source.indexOf('const escapeHeadValue =');
  const end = source.indexOf("\napp.get(['/login'", start);
  assert.ok(start >= 0 && end > start);
  let transform;
  vm.runInNewContext(source.slice(start, end), {
    sendPublicHtml: (name, callback) => { transform = callback; },
    query: async () => [{ setting_value: { pageTitle: 'Example Wiki' } }],
    json: value => value, process,
  });
  const result = await transform(html, { path: '/admin' });
  assert.match(result, /<title>Example Wiki<\/title>/);
  assert.match(result, /<meta name="application-name" content="Example Wiki">/);
  assert.match(result, /<meta property="og:title" content="Example Wiki">/);
});

test('SEO metadata is escaped and canonical URLs follow the requested page', async () => {
    const root = path.join(__dirname, '..', '..');
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const start = source.indexOf('const escapeHeadValue =');
    const end = source.indexOf("\napp.get(['/login'", start);
    let transform;
    const site = {
      name: 'Site & Wiki',
      pageTitle: 'Legacy title',
      seo: {
        description: 'Useful "docs" <here>', socialTitle: 'Shared & title',
        socialDescription: 'Shared description', socialImage: '/media/abcdefghijklmnop.webp',
        canonicalBase: 'https://example.test/docs', indexable: true,
      },
    };
    vm.runInNewContext(source.slice(start, end), {
      sendPublicHtml: (name, callback) => { transform = callback; },
      query: async () => [{ setting_value: site }], json: value => value, process, URL,
    });
    const result = await transform(html, { path: '/guide' });
    assert.match(result, /name="application-name" content="Site &amp; Wiki"/);
    assert.match(result, /<title>Site &amp; Wiki<\/title>/);
    assert.match(result, /property="og:title" content="Shared &amp; title"/);
    assert.match(result, /name="description" content="Useful &quot;docs&quot; &lt;here&gt;"/);
    assert.match(result, /property="og:image" content="https:\/\/example.test\/media\/abcdefghijklmnop.webp"/);
    assert.match(result, /rel="canonical" href="https:\/\/example.test\/docs\/guide"/);
    const privatePage = await transform(html, { path: '/admin' });
    assert.match(privatePage, /name="robots" content="noindex, nofollow"/);
    assert.doesNotMatch(privatePage, /rel="canonical"/);
    site.seo.indexable = false;
    assert.match(await transform(html, { path: '/' }), /name="robots" content="noindex, nofollow"/);
});

test('registered user rows show role by name and localized verification badges', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function registeredUserRow(');
  const end = source.indexOf('\nasync function usersTab(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    esc: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    t: (es, en) => en,
    can: () => true,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const roles = [{ roleKey: 'user', name: 'User', color: '#64748b' }];
  const user = { id: 1, username: '<user>', email: 'user@example.test', role: 'user', verified_at: '2026-01-01' };
  const verified = context.registeredUserRow(user, roles);
  assert.match(verified, /<strong>&lt;user&gt;<\/strong><span class="role-badge"/);
  assert.match(verified, /user-verification-badge is-verified">Verified<\/span>/);
  assert.doesNotMatch(verified, /role-select" data-id="1" disabled/);
  const pending = context.registeredUserRow({ ...user, verified_at: null }, roles);
  assert.match(pending, /user-verification-badge is-pending">Pending<\/span>/);
  assert.match(pending, /role-select" data-id="1" disabled/);
  const primary = context.registeredUserRow({ ...user, isPrimaryAdmin: true }, roles);
  assert.match(primary, /role-select" data-id="1" disabled/);
  for (const locale of ['en', 'es', 'fr', 'de', 'pt-BR']) {
    const translations = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'languages', `language_${locale}.json`), 'utf8'));
    assert.ok(translations.Verified);
    assert.ok(translations.Pending);
  }
});

test('authentication forms validate required fields and password rules before sending', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function checkPassword(');
  const end = source.indexOf('\nfunction navUrl(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    $$: (selector, form) => form.fields,
    t: (es, en) => en,
    validationError: message => Object.assign(new Error(message), { status: 400 }),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const field = value => ({ value, validity: { valid: true } });
  const username = field('user');
  const password = field('');
  const confirmation = field('Valid123!');
  const form = {
    fields: [username, password, confirmation],
    querySelector(selector) { return selector.startsWith('#regPass') ? password : confirmation; },
  };
  assert.throws(() => context.validateAuthForm(form), /Complete all fields/);
  password.value = 'invalid';
  assert.throws(() => context.validateAuthForm(form), /Passwords do not match/);
  confirmation.value = 'invalid';
  assert.throws(() => context.validateAuthForm(form), /Check the password requirements/);
  password.value = confirmation.value = 'Valid123!';
  assert.doesNotThrow(() => context.validateAuthForm(form));
  username.validity.valid = false;
  username.type = 'email';
  username.validity.typeMismatch = true;
  username.focus = () => {};
  assert.throws(() => context.validateAuthForm(form), /Enter a valid email address/);
  username.type = 'text';
  username.name = 'username';
  username.validity = { valid: false, tooShort: true };
  assert.throws(() => context.validateAuthForm(form), /between 2 and 60/);
});

test('login, registration and password change show correctable errors in their form', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const authStart = source.indexOf('function authForm(');
  const authEnd = source.indexOf('\nfunction navUrl(', authStart);
  const errorStart = source.indexOf('function isUserError(');
  const errorEnd = source.indexOf('\nasync function confirmUnsaved(', errorStart);
  assert.ok(authStart >= 0 && authEnd > authStart && errorStart >= 0 && errorEnd > errorStart);
  for (const mode of ['login', 'register', 'change']) {
    const box = { hidden: true, textContent: '', setAttribute() {} };
    const input = (value, name) => ({ value, name, validity: { valid: true } });
    const password = input('Valid123!', 'password');
    const confirm = input('Valid123!', '');
    const fields = [input('', mode === 'change' ? 'currentPassword' : 'email'), password];
    if (mode !== 'login') fields.push(confirm);
    const form = {
      tagName: 'FORM',
      fields,
      querySelector(selector) {
        if (selector.startsWith('#regPass')) return mode === 'login' ? null : password;
        if (selector.startsWith('#regConfirm')) return confirm;
        return null;
      },
    };
    const panel = { innerHTML: '' };
    const fatal = [], sent = [];
    let captchaComplete = false;
    const context = {
      state: { config: { registrationEnabled: true, site: { name: 'Test' }, captcha: { enabled: true } }, translations: {} },
      setView() {}, esc: value => value, t: (es, en) => en, watchPassword() {},
      $: (selector, target) => {
        if (selector === '#authPanel') return panel;
        if (selector === '#authForm') return form;
        if (selector === '.form-message') return box;
        if (selector === '#changeConfirm') return confirm;
        throw new Error('Unexpected selector: ' + selector);
      },
      $$: (selector, target) => target.fields,
      document: { addEventListener() {} }, window: {},
      createCaptchaController: () => ({
        async token() {
          if (!captchaComplete) throw context.validationError('Complete the CAPTCHA verification.');
          return 'test-token';
        },
        reset() {},
      }),
      FormData: class {
        constructor(current) { this.entries = () => current.fields.filter(field => field.name).map(field => [field.name, field.value]); }
      },
      api: async () => {
        sent.push(mode);
        throw Object.assign(new Error(mode === 'login'
          ? 'No se pudo iniciar sesión. Comprueba tus datos y que tu correo esté confirmado.'
          : 'Internal failure'), { status: mode === 'login' ? 401 : 500 });
      },
      localizedMessage: message => message,
      showCouldNotStart: error => fatal.push(error),
    };
    vm.runInNewContext(source.slice(errorStart, errorEnd) + '\n' + source.slice(authStart, authEnd), context);
    context.authForm(mode);
    assert.equal(form.noValidate, true);
    await form.onsubmit({ preventDefault() {} });
    assert.equal(box.textContent, 'Complete all fields.');
    assert.equal(box.hidden, false);
    assert.equal(sent.length, 0);
    fields[0].value = 'user';
    await form.onsubmit({ preventDefault() {} });
    assert.equal(box.textContent, 'Complete the CAPTCHA verification.');
    assert.equal(sent.length, 0);
    captchaComplete = true;
    await form.onsubmit({ preventDefault() {} });
    assert.equal(sent.length, 1);
    if (mode === 'login') {
      assert.match(box.textContent, /^Incorrect username or password\./);
      assert.equal(fatal.length, 0);
    } else {
      assert.equal(fatal.length, 1);
    }
  }
});

test('reCAPTCHA v2 waits for readiness before rendering and v3 before executing', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function createCaptchaController(');
  const end = source.indexOf('\nfunction authForm(', start);
  assert.ok(start >= 0 && end > start);
  for (const variant of ['v2_checkbox', 'v3']) {
    let ready, options, rendered = false, executed = false;
    const api = {
      ready(callback) { ready = callback; },
      render(slot, settings) {
        rendered = true;
        options = settings;
        return 1;
      },
      async execute() {
        executed = true;
        return 'v3-token';
      },
      reset() {},
    };
    const slot = {}, status = { hidden: true, textContent: '' };
    const context = {
      state: { config: { captcha: { enabled: true, provider: 'recaptcha', variant, siteKey: 'test-key' } } },
      window: { grecaptcha: api },
      document: { body: { classList: { contains() { return false; } } } },
      $: selector => selector === '.captcha-slot' ? slot : status,
      t: (es, en) => en,
      loadCaptchaScript: async () => {},
      validationError: message => Object.assign(new Error(message), { status: 400 }),
      setTimeout,
    };
    const createController = vm.runInNewContext(source.slice(start, end) + '\ncreateCaptchaController', context);
    const captcha = createController({}, 'login');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof ready, 'function');
    assert.equal(rendered, false);
    const token = captcha.token();
    const missingToken = variant === 'v2_checkbox'
      ? assert.rejects(token, error => error.status === 400 && error.message === 'Complete the CAPTCHA verification.')
      : null;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executed, false);
    ready();
    if (variant === 'v2_checkbox') {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(rendered, true);
      await missingToken;
      options.callback('v2-token');
      assert.equal(await captcha.token(), 'v2-token');
    } else {
      assert.equal(await token, 'v3-token');
      assert.equal(executed, true);
    }
  }
});

test('public scripts are obfuscated and original files and source maps are not served', async () => {
  const app = express();
  app.use(publicScripts, publicStaticOnly);
  app.get('/verify', sendPublicHtml('index.html'));
  app.get('/setup', sendPublicHtml('installer.html'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const prism = await fetch(origin + '/vendor/prism/prism.js');
    assert.equal(prism.status, 200);
    assert.match(prism.headers.get('content-type'), /javascript/);
    assert.equal(prism.headers.get('cache-control'), 'no-cache');
    const prismSource = await prism.text();
    assert.doesNotThrow(() => new vm.Script(prismSource));
    assert.equal((await conditionalGet(origin + '/vendor/prism/prism.js', prism.headers.get('etag'))).statusCode, 304);
    for (const [url, file, marker] of [
      ['/app.js', 'app.js', 'const lazySweetAlert='],
      ['/admin-updates.js', 'admin-updates.js', 'window.TeralthAdminUpdates'],
      ['/maintenance.js', 'maintenance.js', 'window.TeralthMaintenance'],
      ['/installer.js', 'installer.js', 'document.addEventListener'],
      ['/vendor/sweetalert/sweetalert2.all.min.js', path.join('vendor', 'sweetalert', 'sweetalert2.all.min.js'), 'SweetAlert2']
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8');
      const response = await fetch(origin + url);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      const body = await response.text();
      if (url === '/maintenance.js') {
        assert.equal(body, source);
        assert.ok(body.includes(marker));
      } else if (!url.startsWith('/vendor/')) {
        assert.notEqual(body, source);
        assert.ok(!body.includes(marker));
      }
      assert.ok(!body.includes('sourceMappingURL'));
      if (url === '/app.js') {
        for (const key of ['icon', 'title', 'text', 'login', 'register', 'forgot', 'reset', 'change']) {
          assert.doesNotMatch(body, new RegExp(`['"]${key}['"]\\s*:`), key);
        }
      }
      assert.doesNotThrow(() => new vm.Script(body));
      const second = await fetch(origin + url);
      assert.equal(await second.text(), body);
      const validated = await conditionalGet(origin + url, response.headers.get('etag'));
      assert.equal(validated.statusCode, 304);
      assert.equal(validated.headers['cache-control'], 'no-cache');
      assert.equal(fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8'), source);
    }
    for (const [url, file] of [
      ['/styles.css', 'styles.css'],
      ['/maintenance.css', 'maintenance.css'],
      ['/installer.css', 'installer.css'],
      ['/vendor/fontawesome/css/all.min.css', path.join('vendor', 'fontawesome', 'css', 'all.min.css')],
      ['/vendor/sweetalert/sweetalert2.min.css', path.join('vendor', 'sweetalert', 'sweetalert2.min.css')]
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8');
      const response = await fetch(origin + url);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/css/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.ok(Buffer.byteLength(body) < Buffer.byteLength(source), url);
      assert.equal((await conditionalGet(origin + url, response.headers.get('etag'))).statusCode, 304);
      assert.equal(fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8'), source);
    }
    for (const [url, file, script] of [
      ['/index.html', 'index.html', '/app.js'],
      ['/maintenance.html', 'maintenance.html', '/maintenance.js'],
      ['/verify', 'index.html', '/app.js'],
      ['/installer.html', 'installer.html', '/installer.js'],
      ['/setup', 'installer.html', '/installer.js']
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8');
      const response = await fetch(origin + url);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.ok(Buffer.byteLength(body) < Buffer.byteLength(source), url);
      assert.ok(body.includes(`src="${script}"`), url);
      assert.doesNotMatch(body, /(?:src|href)="[^"]*\?v=/);
      assert.equal(fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8'), source);
    }
    for (const url of ['/app.js.map', '/vendor/sweetalert/sweetalert2.all.min.js.map', '/assets/../app.js.map', '/app.js%2e', '/app.js%3a%24DATA', '/vendor/sweetalert/sweetalert2.all.min.js%20']) {
      assert.equal((await fetch(origin + url)).status, 404, url);
    }
    const index = await (await fetch(origin + '/index.html')).text();
    assert.match(index, /src="\/app\.js"/);
    assert.doesNotMatch(index, /src="\/admin-updates\.js"/);
    assert.equal((await fetch(origin + '/app.js', { method: 'POST' })).status, 404);
    assert.equal((await fetch(origin + '/styles.css', { method: 'POST' })).status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
