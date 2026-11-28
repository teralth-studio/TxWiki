const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'public', 'errors');
const pages = new Map();
for (const file of fs.readdirSync(root)) {
  if (/^[45]\d{2}\.html$/.test(file)) pages.set(Number(file.slice(0, 3)), fs.readFileSync(path.join(root, file), 'utf8'));
}
function sendErrorPage(res, status) {
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const fallback = code >= 500 ? 500 : 400;
  const body = pages.get(code) || pages.get(fallback).replaceAll(`${fallback},`, `${code},`);
  return res.status(code).set('Cache-Control', 'no-store').type('html').send(body);
}
module.exports = { sendErrorPage };
