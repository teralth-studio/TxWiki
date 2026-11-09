'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const yazl = require('yazl');
const { createUpdatePackage } = require('../../scripts/create-update-package');
const { collectInstallationFiles, createReleasePackage } = require('../../scripts/create-release-package');
const {
  UpdateError,
  applyUpdatePackage,
  preflightUpdatePackage,
  formatSshPublicKey,
  parseUpdatePublicKey,
  safeInstallationPath,
  safeFilePath,
  singleSqlStatement,
  verifyUpdatePackage,
} = require('../../scripts/site-updater');

async function temporaryDirectory(run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teralth-update-test-'));
  try {
    await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function writePackage(directory, manifest, fileEntries = {}, signatureOverride) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = signatureOverride || crypto.sign(null, manifestBytes, privateKey).toString('base64');
  const publicKey = formatSshPublicKey(crypto.createPublicKey(privateKey));
  const file = path.join(directory, 'package.zip');
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(file);
    output.once('error', reject);
    output.once('close', resolve);
    zip.outputStream.once('error', reject);
    zip.outputStream.pipe(output);
    zip.addBuffer(manifestBytes, 'manifest.json');
    zip.addBuffer(Buffer.from(signature), 'manifest.sig');
    zip.addBuffer(Buffer.from(publicKey), 'manifest.pub');
    for (const [name, content] of Object.entries(fileEntries))
      zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    zip.end();
  });
  return { file, publicKey };
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function makePool({ failMigration = false } = {}) {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push(['connection', sql]);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (failMigration && sql === 'CREATE TABLE widgets (id INT)') throw new Error('Migration failed');
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }]];
      return [[], []];
    },
    async execute(sql) {
      calls.push(['connection-execute', sql]);
      return [[], []];
    },
    release() {
      calls.push(['release']);
    },
  };
  return {
    calls,
    async getConnection() {
      return connection;
    },
    async query(sql) {
      calls.push(['pool', sql]);
      if (sql.includes('SELECT release_version')) return [[], []];
      if (sql.includes('CREATE TABLE')) return [{ affectedRows: 0 }, []];
      return [{ affectedRows: 1 }, []];
    },
    async execute(sql) {
      calls.push(['execute', sql]);
      return [[], []];
    },
  };
}

test('signed update packages verify their signature, file hashes, and migration hashes', async () => {
  await temporaryDirectory(async (directory) => {
    const fileContent = 'window.updated = true;';
    const migrationContent = 'CREATE TABLE widgets (id INT);';
    const manifest = {
      format: 'teralth-wiki-update-v1',
      id: 'release-1-0-1',
      version: '1.0.1',
      files: [{ path: 'public/app.js', sha256: digest(fileContent) }],
      migrations: [{ id: 'create-widgets', path: 'create-widgets.sql', sha256: digest(migrationContent) }],
    };
    const archive = await writePackage(directory, manifest, {
      'files/public/app.js': fileContent,
      'migrations/create-widgets.sql': migrationContent,
    });
    const pkg = await verifyUpdatePackage(archive.file, archive.publicKey);
    assert.equal(pkg.version, '1.0.1');
    assert.equal(pkg.files[0].content.toString(), fileContent);
    assert.equal(pkg.migrations[0].sql, migrationContent);
  });
});

test('signed update packages reject invalid signatures, unsafe paths, and changed file contents', async () => {
  await temporaryDirectory(async (directory) => {
    const content = 'safe';
    const manifest = {
      format: 'teralth-wiki-update-v1',
      id: 'release-1-0-1',
      version: '1.0.1',
      files: [{ path: 'public/app.js', sha256: digest(content) }],
      migrations: [],
    };
    const invalidSignature = await writePackage(directory, manifest, { 'files/public/app.js': content }, 'invalid');
    await assert.rejects(verifyUpdatePackage(invalidSignature.file, invalidSignature.publicKey), UpdateError);

    const unsafe = { ...manifest, id: 'unsafe', files: [{ path: '../outside.js', sha256: digest(content) }] };
    const unsafeArchive = await writePackage(directory, unsafe);
    await assert.rejects(
      verifyUpdatePackage(unsafeArchive.file, unsafeArchive.publicKey),
      /lista de archivos del paquete no es válida/,
    );

    const altered = await writePackage(directory, manifest, { 'files/public/app.js': 'changed' });
    await assert.rejects(verifyUpdatePackage(altered.file, altered.publicKey), /verificación del archivo/);
  });
});

test('updates admin status handles an empty update history and populated history', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf("app.get('/api/admin/updates'");
  const end = source.indexOf("\napp.get('/api/updates/progress'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const context = {
    app: { get: (_path, ...args) => { handler = args.at(-1); } },
    auth() {},
    requirePermission: () => () => {},
    ensureUpdateTables: async () => {},
    pool: { execute: async () => [[]] },
    updatePublicKey: require('../../scripts/update-public-key'),
    process: { env: {} },
    require: name => {
      if (name === './package.json') return { version: '1.2.3' };
      throw new Error(`Unexpected require: ${name}`);
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const response = {
    set() { return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await handler({}, response, error => { throw error; });
  assert.equal(response.payload.configured, true);
  assert.equal(response.payload.currentVersion, '1.2.3');
  assert.deepEqual(Array.from(response.payload.updates), []);

  const updates = [{ update_id: 'release-1-2-4', release_version: '1.2.4', applied_at: '2026-11-08' }];
  context.pool.execute = async () => [updates];
  await handler({}, response, error => { throw error; });
  assert.equal(response.payload.currentVersion, '1.2.4');
  assert.deepEqual(Array.from(response.payload.updates), updates);
});

test('bundled update verification key is a valid Ed25519 public key', () => {
  const publicKey = parseUpdatePublicKey(require('../../scripts/update-public-key'));
  assert.equal(publicKey.asymmetricKeyType, 'ed25519');
  assert.match(require('../../scripts/update-public-key'), /^ssh-ed25519 /);
  assert.throws(() => parseUpdatePublicKey('ssh-ed25519 AAAA'), /Malformed SSH public key/);
});

test('update package SSH key must match the configured trusted key', async () => {
  await temporaryDirectory(async directory => {
    const content = 'window.updated = true;';
    const manifest = {
      format: 'teralth-wiki-update-v1',
      id: 'release-1-0-1',
      version: '1.0.1',
      files: [{ path: 'public/app.js', sha256: digest(content) }],
      migrations: [],
    };
    const archive = await writePackage(directory, manifest, { 'files/public/app.js': content });
    await assert.rejects(
      verifyUpdatePackage(archive.file, require('../../scripts/update-public-key')),
      /no coincide con la clave oficial/,
    );
    const verified = await verifyUpdatePackage(archive.file, archive.publicKey);
    assert.equal(verified.version, manifest.version);
  });
});

test('release builder creates a ZIP with the trusted OpenSSH key and valid signature', async () => {
  await temporaryDirectory(async directory => {
    const projectRoot = path.join(directory, 'project');
    const outputDirectory = path.join(directory, 'update_zips');
    const signingKeyPath = path.join(directory, 'release-private.pem');
    await fs.promises.mkdir(path.join(projectRoot, 'public'), { recursive: true });
    await fs.promises.mkdir(path.join(projectRoot, 'work', 'migrations'), { recursive: true });
    await fs.promises.writeFile(path.join(projectRoot, 'public', 'app.js'), 'window.releaseReady = true;');
    await fs.promises.writeFile(
      path.join(projectRoot, 'work', 'migrations', 'feature.sql'),
      'CREATE TABLE feature_flags (id INT);',
    );
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    await fs.promises.writeFile(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const trustedPublicKey = formatSshPublicKey(publicKey);
    const packagePath = await createUpdatePackage({
      id: 'release-1-0-1',
      version: '1.0.1',
      files: ['public/app.js'],
      migrations: [{ id: 'create-feature-flags', path: 'feature-flags.sql', source: 'work/migrations/feature.sql' }],
      projectRoot,
      destinationDirectory: outputDirectory,
      signingKeyPath,
      trustedPublicKey,
    });
    const pkg = await verifyUpdatePackage(packagePath, trustedPublicKey);
    assert.equal(pkg.id, 'release-1-0-1');
    assert.equal(pkg.files[0].content.toString(), 'window.releaseReady = true;');
    assert.equal(pkg.migrations[0].sql, 'CREATE TABLE feature_flags (id INT);');
    const pemOverride = publicKey.export({ type: 'spki', format: 'pem' }).replace(/\n/g, '\\n');
    const verificationOutput = execFileSync(
      process.execPath,
      [path.join(__dirname, '..', '..', 'scripts', 'verify-update-package.js'), packagePath],
      { encoding: 'utf8', env: { ...process.env, UPDATE_PUBLIC_KEY: pemOverride } },
    );
    assert.match(verificationOutput, /Package signature and all declared hashes are valid/);
    assert.match(verificationOutput, /Trusted signer: ed25519 SHA256:/);
    assert.deepEqual((await fs.promises.readdir(outputDirectory)), ['1.0.1-release-1-0-1.zip']);
    const projectSigningKeyPath = path.join(projectRoot, 'release-private.pem');
    await fs.promises.copyFile(signingKeyPath, projectSigningKeyPath);
    await assert.rejects(
      createUpdatePackage({
        id: 'release-in-project-key',
        version: '1.0.1',
        files: ['public/app.js'],
        projectRoot,
        signingKeyPath: projectSigningKeyPath,
        trustedPublicKey,
      }),
      /outside the project root/,
    );
    await assert.rejects(createUpdatePackage({
      id: 'release-1-0-1',
      version: '1.0.1',
      files: ['public/app.js'],
      migrations: [],
      projectRoot,
      destinationDirectory: outputDirectory,
      signingKeyPath,
      trustedPublicKey,
    }), { code: 'EEXIST' });
  });
});

test('one signed release package carries verified installer files and update files without local secrets', async () => {
  await temporaryDirectory(async directory => {
    const projectRoot = path.join(directory, 'project');
    const outputDirectory = path.join(directory, 'update_zips');
    const signingKeyPath = path.join(directory, 'release-private.pem');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const trustedPublicKey = formatSshPublicKey(publicKey);
    await fs.promises.writeFile(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await fs.promises.mkdir(path.join(projectRoot, 'public'), { recursive: true });
    await fs.promises.mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
    await fs.promises.mkdir(path.join(projectRoot, '.github', 'modernize'), { recursive: true });
    await fs.promises.mkdir(path.join(projectRoot, 'update_zips'), { recursive: true });
    await fs.promises.mkdir(path.join(projectRoot, 'data'), { recursive: true });
    await fs.promises.writeFile(path.join(projectRoot, 'server.js'), 'module.exports = true;');
    await fs.promises.writeFile(
      path.join(projectRoot, 'pterodactyl-start.js'),
      "process.stdout.write('start');",
    );
    await fs.promises.writeFile(path.join(projectRoot, '.env.example'), 'DB_HOST=localhost\n');
    await fs.promises.writeFile(path.join(projectRoot, '.env'), 'DB_PASSWORD=secret\n');
    await fs.promises.writeFile(path.join(projectRoot, 'public', 'app.js'), 'window.releaseReady = true;');
    await fs.promises.writeFile(path.join(projectRoot, 'scripts', 'runtime.js'), 'module.exports = 1;');
    await fs.promises.writeFile(path.join(projectRoot, 'scripts', 'runtime.test.js'), 'test secret');
    await fs.promises.mkdir(path.join(projectRoot, 'scripts', 'backup'), { recursive: true });
    await fs.promises.writeFile(
      path.join(projectRoot, 'scripts', 'backup', 'backup-crypto.js'),
      "module.exports = require('./backup-crypto-core');",
    );
    await fs.promises.writeFile(path.join(projectRoot, '.github', 'modernize', 'board.md'), 'local workflow state');
    await fs.promises.writeFile(path.join(projectRoot, 'update_zips', 'update-private.pem'), 'do not include');
    await fs.promises.writeFile(path.join(projectRoot, 'data', 'user-upload.png'), 'user data');
    const installationFiles = await collectInstallationFiles(projectRoot);
    assert.ok(installationFiles.includes('.env.example'));
    assert.ok(installationFiles.includes('server.js'));
    assert.ok(!installationFiles.includes('.env'));
    assert.ok(!installationFiles.some(file => file.startsWith('update_zips/')));
    assert.ok(!installationFiles.some(file => file.startsWith('releases/')));
    assert.ok(!installationFiles.some(file => file.startsWith('data/')));
    assert.ok(!installationFiles.some(file => file.startsWith('.github/modernize/')));
    assert.ok(installationFiles.includes('scripts/backup/backup-crypto.js'));

    const packagePath = await createReleasePackage({
      version: '1.0.1',
      id: 'release-1-0-1',
      projectRoot,
      destinationDirectory: outputDirectory,
      signingKeyPath,
      trustedPublicKey,
    });
    const pkg = await verifyUpdatePackage(packagePath, trustedPublicKey);
    assert.equal(pkg.version, '1.0.1');
    assert.ok(pkg.files.some(file => file.path === 'server.js'));
    assert.ok(pkg.files.some(file => file.path === 'pterodactyl-start.js'));
    assert.ok(pkg.installation.some(file => file.path === '.env.example'));
    assert.ok(pkg.installation.some(file => file.path === 'pterodactyl-start.js'));
    assert.ok(!pkg.installation.some(file => file.path === '.env'));
    assert.ok(!pkg.installation.some(file => file.path.includes('update-private.pem')));
    assert.equal(
      pkg.installation.find(file => file.path === 'public/app.js').content.toString(),
      'window.releaseReady = true;',
    );
    assert.equal(safeInstallationPath('data/credentials.json'), false);
    assert.equal(safeInstallationPath('backup/private.zip'), false);
    assert.equal(safeInstallationPath('scripts/backup/backup-crypto.js'), true);
    assert.equal(safeInstallationPath('releases/unsigned.zip'), false);
    assert.equal(safeInstallationPath('updates_zip/legacy.zip'), false);
    assert.equal(safeInstallationPath('../outside.js'), false);
    assert.equal(safeInstallationPath('.env.example'), true);
    assert.equal(safeFilePath('pterodactyl-start.js'), true);
  });
});

test('a legacy-signed bridge package installs the next trusted update key', async () => {
  await temporaryDirectory(async directory => {
    const projectRoot = path.join(directory, 'project');
    const outputDirectory = path.join(directory, 'releases');
    const signingKeyPath = path.join(directory, 'legacy-signing-key.pem');
    const { privateKey: legacyPrivateKey, publicKey: legacyPublicKey } = crypto.generateKeyPairSync('ed25519');
    const { publicKey: nextPublicKey } = crypto.generateKeyPairSync('ed25519');
    const legacyTrustedKey = formatSshPublicKey(legacyPublicKey);
    const nextTrustedKey = formatSshPublicKey(nextPublicKey);

    await fs.promises.mkdir(path.join(projectRoot, 'public'), { recursive: true });
    await fs.promises.mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
    await fs.promises.writeFile(
      signingKeyPath,
      legacyPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    );
    await fs.promises.writeFile(path.join(projectRoot, 'server.js'), 'module.exports = true;');
    await fs.promises.writeFile(path.join(projectRoot, 'public', 'app.js'), 'window.releaseReady = true;');
    await fs.promises.writeFile(
      path.join(projectRoot, 'scripts', 'update-public-key.js'),
      `module.exports = '${nextTrustedKey}';\n`,
    );

    const packagePath = await createReleasePackage({
      version: '1.0.2',
      id: 'release-1-0-2-bridge',
      projectRoot,
      destinationDirectory: outputDirectory,
      signingKeyPath,
      trustedPublicKey: legacyTrustedKey,
    });
    const bridge = await verifyUpdatePackage(packagePath, legacyTrustedKey);
    assert.ok(bridge.files.some(file => file.path === 'scripts/update-public-key.js'));
    assert.equal(
      bridge.installation.find(file => file.path === 'scripts/update-public-key.js').content.toString(),
      `module.exports = '${nextTrustedKey}';\n`,
    );
  });
});

test('release packages include the complete local module graph of every runtime entrypoint', async () => {
  const projectRoot = path.join(__dirname, '..', '..');
  const installationFiles = new Set(await collectInstallationFiles(projectRoot));
  const visited = new Set();
  const pending = ['server.js', 'launcher.js', 'pterodactyl-start.js'];
  const localRequire = /require\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g;

  while (pending.length) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    assert.ok(installationFiles.has(relativePath), `Installer package omits ${relativePath}`);
    const absolutePath = path.join(projectRoot, relativePath);
    if (!relativePath.endsWith('.js')) continue;
    const source = await fs.promises.readFile(absolutePath, 'utf8');
    const requireFromFile = Module.createRequire(absolutePath);
    for (const match of source.matchAll(localRequire)) {
      const resolved = requireFromFile.resolve(match[2]);
      const dependencyPath = path.relative(projectRoot, resolved).split(path.sep).join('/');
      if (dependencyPath.startsWith('..') || path.isAbsolute(dependencyPath)) continue;
      assert.ok(
        installationFiles.has(dependencyPath),
        `${relativePath} requires ${dependencyPath}, which is absent from the installer package`,
      );
      if (dependencyPath.endsWith('.js')) {
        assert.ok(safeFilePath(dependencyPath), `Updater package cannot include ${dependencyPath}`);
        pending.push(dependencyPath);
      }
    }
  }
});

test('release verifier rejects a modified installation file even when update files are intact', async () => {
  await temporaryDirectory(async directory => {
    const installContent = 'trusted install source';
    const updateContent = 'window.updated = true;';
    const manifest = {
      format: 'teralth-wiki-update-v1',
      id: 'release-1-0-1',
      version: '1.0.1',
      files: [{ path: 'public/app.js', sha256: digest(updateContent) }],
      migrations: [],
      installation: [{ path: 'server.js', sha256: digest(installContent) }],
    };
    const archive = await writePackage(directory, manifest, {
      'files/public/app.js': updateContent,
      'server.js': 'modified install source',
    });
    await assert.rejects(
      verifyUpdatePackage(archive.file, archive.publicKey),
      /verificación del archivo de instalación server\.js falló/,
    );
  });
});

test('update file allowlist and SQL parser reject paths and multiple statements', () => {
  assert.equal(safeFilePath('public/admin-updates.js'), true);
  assert.equal(safeFilePath('public/maintenance.js'), true);
  assert.equal(safeFilePath('public/maintenance.css'), true);
  assert.equal(safeFilePath('public/maintenance.html'), true);
  assert.equal(safeFilePath('schema.sql'), false);
  assert.equal(safeFilePath('public/../server.js'), false);
  assert.equal(singleSqlStatement("INSERT INTO names VALUES ('one;two');"), "INSERT INTO names VALUES ('one;two')");
  assert.equal(
    singleSqlStatement('CREATE TABLE widgets (id INT); -- one statement\n'),
    'CREATE TABLE widgets (id INT); -- one statement',
  );
  assert.throws(() => singleSqlStatement('SELECT 1; DROP TABLE users'), /una sola sentencia/);
  assert.throws(() => singleSqlStatement('   '), /está vacía/);
});

test('update preflight rejects invalid code and tests database and disk readiness before backup', async () => {
  await temporaryDirectory(async (directory) => {
    const calls = [];
    const connection = {
      async query(sql) {
        calls.push(sql);
        return [[{ ready: 1 }]];
      },
    };
    const pkg = {
      files: [{ path: 'public/app.js', content: Buffer.from('window.value = ;') }],
      migrations: [],
    };
    await assert.rejects(
      preflightUpdatePackage(pkg, { root: directory, connection }),
      /sintaxis falló/,
    );
    assert.deepEqual(calls, []);

    pkg.files[0].content = Buffer.from('window.value = true;');
    let progress = 0;
    await preflightUpdatePackage(pkg, {
      root: directory,
      connection,
      onProgress: (stage, value) => {
        assert.equal(stage, 'preflight');
        progress = value;
      },
    });
    assert.deepEqual(calls, ['SELECT 1 AS ready']);
    assert.equal(progress, 28);
  });
});

test('update preflight validates JavaScript syntax without executing package code', async () => {
  await temporaryDirectory(async (directory) => {
    const marker = `__teralth_preflight_${crypto.randomBytes(8).toString('hex')}`;
    const source = `globalThis[${JSON.stringify(marker)}] = true;`;
    const pkg = {
      files: [{ path: 'public/app.js', content: Buffer.from(source) }],
      migrations: [],
    };
    const connection = { async query() { return [[{ ready: 1 }]]; } };
    delete globalThis[marker];
    try {
      await preflightUpdatePackage(pkg, { root: directory, connection });
      assert.equal(globalThis[marker], undefined);
    } finally {
      delete globalThis[marker];
    }
  });
});

test('applying an update creates a backup, installs files, and releases its database lock', async () => {
  await temporaryDirectory(async (directory) => {
    await fs.promises.mkdir(path.join(directory, 'public'));
    await fs.promises.writeFile(path.join(directory, 'public', 'app.js'), 'old content');
    const pool = makePool();
    let restarted = false;
    const result = await applyUpdatePackage({
      pkg: { id: 'release-1-0-1', version: '1.0.1', files: [{ path: 'public/app.js', content: Buffer.from('window.updateReady = true;') }], migrations: [] },
      root: directory,
      pool,
      createBackup: async () => ({ name: 'backup-1' }),
      restart: async () => { restarted = true; },
      installedVersion: '1.0.0',
    });
    assert.equal(
      await fs.promises.readFile(path.join(directory, 'public', 'app.js'), 'utf8'),
      'window.updateReady = true;',
    );
    assert.equal(result.backup, 'backup-1');
    assert.equal(restarted, true);
    assert.ok(pool.calls.some(([owner, sql]) => owner === 'connection' && sql.includes('RELEASE_LOCK')));
    assert.ok(pool.calls.some(([owner]) => owner === 'release'));
  });
});

test('failed migrations restore files installed by the same update', async () => {
  await temporaryDirectory(async (directory) => {
    await fs.promises.mkdir(path.join(directory, 'public'));
    const target = path.join(directory, 'public', 'app.js');
    await fs.promises.writeFile(target, 'previous version');
    const pool = makePool({ failMigration: true });
    await assert.rejects(
      applyUpdatePackage({
        pkg: {
          id: 'release-1-0-1',
          version: '1.0.1',
          files: [{ path: 'public/app.js', content: Buffer.from('window.updateReady = true;') }],
          migrations: [{ id: 'create-widgets', sha256: digest('CREATE TABLE widgets (id INT);'), sql: 'CREATE TABLE widgets (id INT);' }],
        },
        root: directory,
        pool,
        createBackup: async () => ({ name: 'backup-1' }),
        restart: async () => {},
        installedVersion: '1.0.0',
      }),
      /Migration failed/,
    );
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'previous version');
    assert.ok(pool.calls.some(([owner, sql]) => owner === 'connection' && sql.includes('RELEASE_LOCK')));
  });
});
