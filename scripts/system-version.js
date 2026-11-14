const fs = require('node:fs');
const path = require('node:path');

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function systemVersion(projectRoot = path.join(__dirname, '..')) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(projectRoot, 'version.json'), 'utf8')).version;
    if (typeof stored === 'string' && VERSION_PATTERN.test(stored)) return stored;
  } catch {}

  const fallback = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  if (typeof fallback !== 'string' || !VERSION_PATTERN.test(fallback)) throw new Error('SYSTEM_VERSION_INVALID');
  return fallback;
}

module.exports = { systemVersion };
