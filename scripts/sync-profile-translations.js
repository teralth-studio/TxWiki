const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'profile-ui.js'), 'utf8');
const pairs = new Map([
  ['Profile settings', 'Ajustes de perfil'], ['Connections', 'Conexiones'],
  ['Configure OAuth connections', 'Configurar conexiones OAuth'],
  ['Continue with', 'Continuar con'], ['My account', 'Mi cuenta'],
  ['Configured an OAuth connection', 'Configuró una conexión OAuth'],
  ['Deleted an OAuth connection', 'Eliminó una conexión OAuth'],
]);
for (const match of source.matchAll(/\bt\('((?:\\.|[^'\\])*)',\s*'((?:\\.|[^'\\])*)'\)/g)) {
  const decode = text => text.replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  pairs.set(decode(match[2]), decode(match[1]));
}
for (const file of fs.readdirSync(path.join(root, 'languages'))) {
  if (!/^language_[A-Za-z0-9-]+\.json$/.test(file)) continue;
  const target = path.join(root, 'languages', file), values = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const [english, spanish] of pairs) {
    if (!Object.hasOwn(values, english)) values[english] = file === 'language_es.json' ? spanish : english;
  }
  fs.writeFileSync(target, JSON.stringify(values, null, 2) + '\n');
}
