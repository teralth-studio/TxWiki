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

function missingDependencies(dependencies, resolveDependency = name => require.resolve(name, { paths: [root] })) {
  return Object.keys(dependencies).filter((name) => {
    try {
      resolveDependency(name);
      return false;
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return true;
      throw error;
    }
  });
}

function shouldInstallDependencies(installedHash, lockHash, missing) {
  return installedHash !== lockHash || missing.length > 0;
}

async function main() {
  const packageJson = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
  const packageLock = await fs.promises.readFile(packageLockPath);
  const lockHash = crypto.createHash('sha256').update(packageLock).digest('hex');
  let installedHash = '';
  try {
    installedHash = (await fs.promises.readFile(markerPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (shouldInstallDependencies(installedHash, lockHash, missingDependencies(packageJson.dependencies || {}))) {
    await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
    const missing = missingDependencies(packageJson.dependencies || {});
    if (missing.length) {
      throw new Error(`npm ci completed, but these runtime dependencies are unavailable: ${missing.join(', ')}.`);
    }
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

if (require.main === module) {
  main().catch(error => {
    console.error(`Pterodactyl startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { missingDependencies, shouldInstallDependencies };
