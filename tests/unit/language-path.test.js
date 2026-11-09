'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('const validLanguageCode');
const end = source.indexOf('\nasync function writeLanguageFile', start);
assert.ok(start >= 0 && end > start);
const languagePaths = vm.runInNewContext(
  source.slice(start, end) + '\n({ validLanguageCode, languageFile })',
  { __dirname: root, path },
);

test('language file paths accept locale codes and reject path-like input', () => {
  const expected = path.join(root, 'languages', 'language_pt-BR.json');
  assert.equal(languagePaths.validLanguageCode('pt-BR'), true);
  assert.equal(languagePaths.languageFile('pt-BR'), expected);
  assert.equal(path.dirname(languagePaths.languageFile('de')), path.join(root, 'languages'));
  for (const invalid of ['../secret', 'en/../../secret', 'en\\..\\secret', '', 'language_en']) {
    assert.equal(languagePaths.validLanguageCode(invalid), false, invalid);
    assert.throws(() => languagePaths.languageFile(invalid), /Invalid language code/);
  }
});
