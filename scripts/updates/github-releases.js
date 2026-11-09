'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const repository = 'teralth-studio/TxWiki';
const apiUrl = `https://api.github.com/repos/${repository}/releases?per_page=100`;
const maxPackageBytes = 64 * 1024 * 1024;
const maxApiResponseBytes = 2 * 1024 * 1024;
const allowedDownloadHosts = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value || '');
  return match && match.slice(1).every((part) => part.length <= 18)
    ? match.slice(1).map(BigInt)
    : null;
}

function compareReleaseVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Invalid release version.');
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function readBoundedBody(response, limit) {
  if (!response.body) throw new Error('GitHub returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('GitHub response exceeds the allowed size.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchReleaseList(fetchImpl) {
  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TxWiki-Updater',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`);
  const body = await readBoundedBody(response, maxApiResponseBytes);
  let releases;
  try {
    releases = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('GitHub returned an invalid release list.');
  }
  if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list.');
  return releases;
}

function releaseAsset(release) {
  const tag = release.tag_name;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matching = assets.filter((asset) => asset?.name === `${tag}.zip`);
  if (matching.length !== 1) return null;
  const [asset] = matching;
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id < 1 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > maxPackageBytes ||
    asset.state !== 'uploaded'
  )
    return null;
  return { id: asset.id, name: asset.name, size: asset.size };
}

async function getLatestRelease(fetchImpl = globalThis.fetch) {
  const releases = await fetchReleaseList(fetchImpl);
  const stable = releases
    .filter((release) => {
      return (
        release &&
        release.draft !== true &&
        release.prerelease !== true &&
        typeof release.tag_name === 'string' &&
        parseVersion(release.tag_name)
      );
    })
    .sort((left, right) => compareReleaseVersions(right.tag_name, left.tag_name));
  if (!stable.length) throw new Error('No stable versioned releases were found on GitHub.');

  const latest = stable[0];
  const versions = [...new Set(stable.map((release) => release.tag_name.replace(/^v/, '')))];
  return {
    tag: latest.tag_name,
    version: latest.tag_name.replace(/^v/, ''),
    publishedAt: typeof latest.published_at === 'string' ? latest.published_at : null,
    asset: releaseAsset(latest),
    versions,
  };
}

function releaseDownloadUrl(release) {
  if (
    !release ||
    typeof release.tag !== 'string' ||
    !parseVersion(release.tag) ||
    !release.asset ||
    release.asset.name !== `${release.tag}.zip` ||
    !Number.isSafeInteger(release.asset.size) ||
    release.asset.size < 1 ||
    release.asset.size > maxPackageBytes
  )
    throw new Error('The official release package is unavailable.');
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(release.asset.name)}`;
}

async function openReleaseDownload(fetchImpl, initialUrl) {
  let url = new URL(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !allowedDownloadHosts.has(url.hostname)
    )
      throw new Error('GitHub redirected the package to an untrusted host.');
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'TxWiki-Updater' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 3) throw new Error('GitHub package download has too many redirects.');
    url = new URL(location, url);
  }
  throw new Error('GitHub package download has too many redirects.');
}

async function downloadReleasePackage(
  release,
  directory,
  { fetchImpl = globalThis.fetch, onProgress = () => {} } = {},
) {
  const url = releaseDownloadUrl(release);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `package-${crypto.randomUUID()}.zip`;
  const destination = path.join(directory, filename);
  let file;
  try {
    const response = await openReleaseDownload(fetchImpl, url);
    if (!response.ok) throw new Error(`GitHub package download failed (HTTP ${response.status}).`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      (declaredLength > maxPackageBytes || declaredLength !== release.asset.size)
    )
      throw new Error('The GitHub package size does not match the release metadata.');
    if (!response.body) throw new Error('GitHub returned an empty package.');

    file = await fs.open(destination, 'wx', 0o600);
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxPackageBytes || size > release.asset.size)
        throw new Error('The GitHub package exceeds its allowed size.');
      await file.writeFile(chunk);
      onProgress(Math.floor((size / release.asset.size) * 100));
    }
    if (size !== release.asset.size) throw new Error('The downloaded package size is incomplete.');
    await file.sync();
    return {
      filename,
      path: destination,
      destination: directory,
      originalname: release.asset.name,
      mimetype: 'application/zip',
      size,
    };
  } catch (error) {
    if (file) {
      await file.close();
      file = null;
    }
    await fs.unlink(destination).catch((cleanupError) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  } finally {
    if (file) await file.close();
  }
}

function countVersionsBehind(release, currentVersion) {
  if (!parseVersion(currentVersion)) return null;
  return release.versions.filter((version) => compareReleaseVersions(version, currentVersion) > 0).length;
}

module.exports = {
  compareReleaseVersions,
  countVersionsBehind,
  downloadReleasePackage,
  getLatestRelease,
  maxPackageBytes,
  parseVersion,
};
