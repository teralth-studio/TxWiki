const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  readThemeAsset,
  readThemeDefinition,
} = require('../../scripts/theme-manager');

async function createThemeRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'txwiki-theme-manager-'));
  const theme = path.join(root, 'sample');
  await fs.promises.mkdir(theme);
  await fs.promises.writeFile(
    path.join(theme, 'settings.json'),
    JSON.stringify({
      name: 'Sample',
      version: '1.0.0',
      author: 'Test',
      settings: [],
    }),
  );
  await fs.promises.writeFile(path.join(theme, 'theme.css'), 'body { color: #123456; }');
  return { root, theme };
}

test('theme resolution reads files only from enumerated safe theme directories', async (t) => {
  const { root } = await createThemeRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const definition = await readThemeDefinition(root, 'sample');
  assert.equal(definition.definition.name, 'Sample');

  const asset = await readThemeAsset(root, 'sample', 'theme.css');
  assert.match(asset.buffer.toString(), /body\.theme-mode/);
  assert.equal(await readThemeAsset(root, '../sample', 'theme.css'), null);
  assert.equal(await readThemeAsset(root, 'sample', '../settings.json'), null);
  await assert.rejects(readThemeDefinition(root, '../sample'), (error) => error.status === 404);
});

test('theme asset resolution rejects missing and non-file path components', async (t) => {
  const { root, theme } = await createThemeRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(theme, 'assets'));

  assert.equal(await readThemeAsset(root, 'sample', 'assets/missing.woff2'), null);
  assert.equal(await readThemeAsset(root, 'sample', 'assets'), null);
});
