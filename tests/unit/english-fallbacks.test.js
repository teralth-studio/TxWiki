const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function runApplicationHelper(startText, endText, name, state) {
  const start = appSource.indexOf(startText);
  const end = appSource.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Could not find ${name} in public/app.js`);
  const context = { state };
  vm.runInNewContext(`${appSource.slice(start, end)}\nglobalThis.result = ${name};`, context);
  return { context, helper: context.result };
}

test('inline UI copy uses English when the selected language has no translation', () => {
  const { context, helper: translate } = runApplicationHelper(
    'const t = (es, en) => {',
    '\nfunction hasCookieConsent()',
    't',
    { lang: 'fr', translations: {} },
  );
  assert.equal(translate('Texto en español', 'English fallback'), 'English fallback');

  context.state.translations['English fallback'] = 'Traduction française';
  assert.equal(translate('Texto en español', 'English fallback'), 'Traduction française');
});

test('untranslated API errors use English instead of Spanish for other locales', () => {
  const { context, helper: localizedMessage } = runApplicationHelper(
    'function localizedMessage(message) {',
    '\nfunction showCouldNotStart(',
    'localizedMessage',
    { lang: 'de', translations: {} },
  );
  assert.equal(
    localizedMessage('No encontramos esa página.'),
    'We could not find that page.',
  );
  assert.equal(
    localizedMessage('Un error nuevo sin traducción en languages.'),
    'The request could not be completed. Check the information and try again.',
  );

  context.state.translations['We could not find that page.'] = 'Seite nicht gefunden.';
  assert.equal(localizedMessage('No encontramos esa página.'), 'Seite nicht gefunden.');
});

test('public HTML shell uses English for static fallback copy', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const phrase of [
    'Cerrar menú',
    'Documentación',
    'Buscar documentación',
    'Iniciar sesión',
    'Cambiar contraseña',
    'Cerrar sesión',
    '¿Te resultó útil esta página?',
  ]) assert.ok(!html.includes(phrase), `Public HTML still has the Spanish fallback: ${phrase}`);
  assert.match(html, /Search documentation/);
  assert.match(html, /Was this page helpful\?/);
});
