const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { prismBundle } = require('../../scripts/prism-bundle');
const sanitizeHtml = require('sanitize-html');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('all selectable code languages have a local syntax grammar', async () => {
  const start = source.indexOf('const codeLanguages =');
  const end = source.indexOf('\nfunction highlightCodeBlock(', start);
  assert.ok(start >= 0 && end > start);
  const languages = vm.runInNewContext(source.slice(start, end) + '\ncodeLanguages');
  const context = {};
  vm.runInNewContext(await prismBundle(), context);
  for (const [language] of languages) {
    if (language === 'text') continue;
    assert.ok(context.Prism.languages[language === 'env' ? 'bash' : language], language);
  }
  const highlighted = context.Prism.highlight('# comment\nkey: "hello"\nactive: true\n', context.Prism.languages.yaml, 'yaml');
  assert.match(highlighted, /class="token comment"/);
  assert.match(highlighted, /class="token (?:atrule|key atrule)"/);
  assert.match(highlighted, /class="token boolean/);
});

test('editor code text preserves line breaks, blank lines, indentation and literal markup', () => {
  const start = source.indexOf('function codeBlockText(');
  const end = source.indexOf('\nfunction editorToolbarMarkup(', start);
  assert.ok(start >= 0 && end > start);
  const context = { Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 } };
  vm.runInNewContext(source.slice(start, end), context);
  const text = value => ({ nodeType: 3, nodeValue: value });
  const element = (tagName, ...childNodes) => ({ nodeType: 1, tagName, nodeName: tagName, childNodes });
  const code = element('CODE',
    text('# title'), element('DIV', text('  key: "value"')),
    element('DIV', element('BR')), element('DIV', text('<tag>')),
    element('BR'), text('last'),
  );
  assert.equal(context.codeBlockText(code), '# title\n  key: "value"\n\n<tag>\nlast');
});

test('server sanitation retains code blocks without executing their contents', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = server.indexOf('const htmlPolicy =');
  const end = server.indexOf('\n\napp.disable(', start);
  assert.ok(start >= 0 && end > start);
  const policy = vm.runInNewContext(server.slice(start, end) + '\nhtmlPolicy');
  const input = '<div class="code-block"><div class="code-block-heading"><span class="code-format-label" data-language="yaml">YAML</span></div><pre><code># hello\nkey: &lt;script&gt;\n</code></pre></div><script>alert(1)</script>';
  const output = sanitizeHtml(input, policy);
  assert.match(output, /<pre><code># hello\nkey: &lt;script&gt;\n<\/code><\/pre>/);
  assert.match(output, /data-language="yaml"/);
  assert.doesNotMatch(output, /<script>/);
});

test('server sanitation preserves nested spoilers and rich content without unsafe attributes', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = server.indexOf('const htmlPolicy =');
  const end = server.indexOf('\n\napp.disable(', start);
  const policy = vm.runInNewContext(server.slice(start, end) + '\nhtmlPolicy');
  const input = '<details class="wiki-spoiler" open onclick="alert(1)"><summary><i class="spoiler-icon fa-solid fa-eye-slash"></i><span class="spoiler-title">Reveal</span></summary><div class="spoiler-body"><div class="hint success"><span class="hint-body"><strong>Safe</strong></span></div><div class="code-block"><pre><code>&lt;script&gt;</code></pre></div><details class="wiki-spoiler"><summary>Nested</summary><div class="spoiler-body">Hidden</div></details><script>alert(1)</script></div></details>';
  const output = sanitizeHtml(input, policy);
  assert.equal((output.match(/<details class="wiki-spoiler">/g) || []).length, 2);
  assert.match(output, /class="hint success"/);
  assert.match(output, /<pre><code>&lt;script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(output, /onclick|<script>| open/);
});
