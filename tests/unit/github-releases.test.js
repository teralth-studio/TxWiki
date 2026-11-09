'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  countVersionsBehind,
  downloadReleasePackage,
  getLatestRelease,
  maxPackageBytes,
  parseVersion,
} = require('../../scripts/updates/github-releases');

function release(tag, overrides = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    assets: [
      {
        id: 12,
        name: `${tag}.zip`,
        size: 4,
        state: 'uploaded',
      },
    ],
    ...overrides,
  };
}

test('latest release lookup selects the highest stable version and counts later releases', async () => {
  const fetchCalls = [];
  const latest = await getLatestRelease(async (url, options) => {
    fetchCalls.push([String(url), options]);
    return new Response(
      JSON.stringify([
        release('v1.4.0'),
        release('v1.5.0-rc.1'),
        release('v1.3.8'),
        release('v2.0.0', { draft: true }),
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  assert.equal(latest.tag, 'v1.4.0');
  assert.equal(latest.version, '1.4.0');
  assert.equal(latest.asset.name, 'v1.4.0.zip');
  assert.equal(countVersionsBehind(latest, '1.2.0'), 2);
  assert.equal(countVersionsBehind(latest, '1.4.0'), 0);
  assert.equal(countVersionsBehind(latest, 'invalid'), null);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0][0], /api\.github\.com\/repos\/teralth-studio\/TxWiki\/releases/);
  assert.equal(fetchCalls[0][1].redirect, 'error');
});

test('release lookup rejects malformed and oversized GitHub responses', async () => {
  await assert.rejects(getLatestRelease(async () => new Response('not json')), /invalid release list/);
  await assert.rejects(
    getLatestRelease(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))),
    /exceeds the allowed size/,
  );
  assert.equal(parseVersion('v1.2.3')?.join('.'), '1.2.3');
  assert.equal(parseVersion('1.02.3'), null);
});

test('official asset download follows only trusted HTTPS redirects and writes a private temporary file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'txwiki-release-'));
  const content = Buffer.from('zip!');
  const calls = [];
  try {
    const downloaded = await downloadReleasePackage(
      { tag: 'v1.4.0', asset: { id: 12, name: 'v1.4.0.zip', size: content.length } },
      directory,
      {
        fetchImpl: async (url, options) => {
          calls.push([String(url), options]);
          if (calls.length === 1)
            return new Response(null, {
              status: 302,
              headers: { Location: 'https://release-assets.githubusercontent.com/package.zip' },
            });
          return new Response(content, {
            status: 200,
            headers: { 'Content-Length': String(content.length) },
          });
        },
      },
    );
    assert.equal(downloaded.originalname, 'v1.4.0.zip');
    assert.equal(downloaded.size, content.length);
    assert.deepEqual(await fs.readFile(downloaded.path), content);
    if (process.platform !== 'win32') assert.equal((await fs.stat(downloaded.path)).mode & 0o777, 0o600);
    assert.equal(calls[0][1].redirect, 'manual');
    assert.match(calls[0][0], /github\.com\/teralth-studio\/TxWiki\/releases\/download\/v1\.4\.0\/v1\.4\.0\.zip$/);
    await fs.rm(downloaded.path);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('automatic download rejects untrusted redirects and assets larger than the updater limit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'txwiki-release-'));
  const asset = { id: 12, name: 'v1.4.0.zip', size: 4 };
  try {
    await assert.rejects(
      downloadReleasePackage({ tag: 'v1.4.0', asset }, directory, {
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://example.com/package.zip' },
          }),
      }),
      /untrusted host/,
    );
    await assert.rejects(
      downloadReleasePackage(
        { tag: 'v1.4.0', asset: { ...asset, size: maxPackageBytes + 1 } },
        directory,
      ),
      /unavailable/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
