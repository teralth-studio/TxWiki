'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = __dirname;
const packageLockPath = path.join(root, 'package-lock.json');
const markerPath = path.join(root, 'node_modules', '.teralth-package-lock-hash');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal || `code ${code}`}.`));
    });
  });
}

async function main() {
  const packageLock = await fs.promises.readFile(packageLockPath);
  const lockHash = crypto.createHash('sha256').update(packageLock).digest('hex');
  let installedHash = '';
  try {
    installedHash = (await fs.promises.readFile(markerPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (installedHash !== lockHash) {
    await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
    await fs.promises.writeFile(markerPath, `${lockHash}\n`, { mode: 0o600 });
  }

  const server = spawn(process.execPath, ['launcher.js'], { cwd: root, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
  server.once('error', error => {
    console.error(`Could not start Teralth Wiki: ${error.message}`);
    process.exitCode = 1;
  });
  server.once('close', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch(error => {
  console.error(`Pterodactyl startup failed: ${error.message}`);
  process.exitCode = 1;
});
