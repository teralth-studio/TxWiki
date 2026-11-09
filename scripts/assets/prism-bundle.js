const fs = require('node:fs/promises');
const path = require('node:path');

const components = [
  'markup', 'css', 'clike', 'javascript', 'markup-templating',
  'yaml', 'json', 'properties', 'toml', 'ini', 'scss', 'less',
  'typescript', 'php', 'python', 'bash', 'batch', 'lua', 'java', 'c',
  'cpp', 'csharp', 'go', 'rust', 'ruby', 'perl', 'sql', 'markdown',
  'docker', 'git', 'log',
];

async function prismBundle() {
  const directory = path.dirname(require.resolve('prismjs/components/prism-core.min.js'));
  const files = ['prism-core.min.js', ...components.map(name => `prism-${name}.min.js`)];
  const sources = await Promise.all(files.map(file => fs.readFile(path.join(directory, file), 'utf8')));
  return sources.join('\n;\n');
}

module.exports = { prismBundle, components };
