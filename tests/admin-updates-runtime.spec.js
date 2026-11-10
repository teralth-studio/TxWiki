import { test, expect } from '@playwright/test';
import express from 'express';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'playwright.config.js'));
const { publicScripts, sendStandaloneUpdaterHtml } = require(path.join(process.cwd(), 'scripts', 'public-scripts.js'));
let server;
let origin;

test.beforeAll(async () => {
  const app = express();
  app.get('/', (req, res) => res.send('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main id="updates"></main></body></html>'));
  app.get('/admin/updates', (req, res) => res.send('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><nav id="adminNavigation">Administration menu</nav><main id="updates"></main></body></html>'));
  app.get('/admin/updates/progress', sendStandaloneUpdaterHtml());
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.use(publicScripts);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function prepareUpdatePage(page, latest) {
  await page.goto(origin);
  await page.addScriptTag({ url: `${origin}/admin-updates.js` });
  await page.evaluate(async (releaseOverview) => {
    const calls = [];
    window.updateCalls = calls;
    window.api = async (url) => {
      calls.push(url);
      if (url === '/api/admin/updates')
        return { currentVersion: '1.2.0', configured: true, updates: [] };
      if (url === '/api/admin/updates/latest') return releaseOverview;
      if (url === '/api/admin/updates/validation-progress')
        return window.validationStatus || { active: false, progress: 45, stage: 'verified', phase: 'verification', phaseProgress: 100 };
      if (url === '/api/admin/updates/automatic/validate')
        return window.validationPending || { token: 'validated-token' };
      if (url === '/api/admin/updates/install') return { ok: true };
      throw new Error(`Unexpected request: ${url}`);
    };
    window.Swal = { fire: async (options) => {
      window.confirmationOptions = options;
      return window.confirmationResult;
    } };
    window.TeralthMaintenance = {
      enter() { document.body.dataset.maintenanceEntered = 'true'; },
      setProgress() {},
    };
    window.backupNavigation = '';
    window.TeralthAdminUpdates.render(document.getElementById('updates'), {
      api: window.api,
      t: (_spanish, english) => english,
      esc: (value) => String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[char]),
      showError: (_root, error) => { throw error; },
      csrf: 'test-token',
      canManageBackups: true,
      navigate: async (tab) => { window.backupNavigation = tab; },
    });
  }, latest);
}

test('updates page shows an official release and supports automatic and manual updates', async ({ page }) => {
  await prepareUpdatePage(page, {
    currentVersion: '1.2.0',
    latestVersion: '1.4.0',
    releaseTag: 'v1.4.0',
    available: true,
    versionsBehind: 2,
    assetAvailable: true,
  });

  await expect(page.locator('#updateReleaseStatus')).toContainText('2 versions behind');
  await expect(page.locator('#updateVersionBadge')).toHaveClass(/is-available/);
  await expect(page.locator('#applyAutomaticUpdate')).toBeEnabled();
  await expect(page.locator('#siteUpdateFile')).toBeVisible();
  await expect(page.locator('#applySiteUpdate')).toContainText('Update manually');

  await page.evaluate(() => { window.confirmationResult = { isDenied: true, isConfirmed: false }; });
  await page.locator('#applyAutomaticUpdate').click();
  await expect.poll(() => page.evaluate(() => window.backupNavigation)).toBe('backups');
  await expect(page.locator('#applyAutomaticUpdate')).toBeEnabled();

  await page.evaluate(() => { window.confirmationResult = { isDenied: false, isConfirmed: true }; });
  await page.locator('#applyAutomaticUpdate').click();
  await expect(page.locator('body')).toHaveAttribute('data-maintenance-entered', 'true');
  expect(await page.evaluate(() => window.updateCalls)).toContain('/api/admin/updates/automatic/validate');
  expect(await page.evaluate(() => window.updateCalls)).toContain('/api/admin/updates/install');
});

test('updates page keeps manual installation available when no newer release exists', async ({ page }) => {
  await prepareUpdatePage(page, {
    currentVersion: '1.4.0',
    latestVersion: '1.4.0',
    releaseTag: 'v1.4.0',
    available: false,
    versionsBehind: 0,
    assetAvailable: true,
  });

  await expect(page.locator('#updateReleaseStatus')).toContainText('You are on the latest system version');
  await expect(page.locator('#applyAutomaticUpdate')).toBeDisabled();
  await expect(page.locator('#siteUpdateFile')).toBeVisible();
  await expect(page.locator('#applySiteUpdate')).toBeEnabled();
});

async function prepareAdminUpdatePage(page, progressStatus = {
  active: false,
  progress: 0,
  stage: 'idle',
  phase: 'preparation',
  phaseProgress: 0,
}) {
  await page.addInitScript(() => {
    window.TeralthMaintenance = {
      enter() { document.body.dataset.maintenanceEntered = 'true'; },
      setProgress() {},
    };
  });
  await page.route('**/api/auth/me', route => route.fulfill({
    json: {
      user: { username: 'Admin', role: 'administrator', permissions: ['updates.install'] },
      csrfToken: 'test-token',
    },
  }));
  await page.route('**/api/admin/updates/latest', route => route.fulfill({
    json: { currentVersion: '1.2.0', latestVersion: '1.4.0', available: true, versionsBehind: 2, assetAvailable: true },
  }));
  await page.route('**/api/admin/updates', route => route.fulfill({
    json: { currentVersion: '1.2.0', configured: true, updates: [] },
  }));
  await page.route('**/api/admin/updates/validation-progress', route => route.fulfill({
    json: { active: false, progress: 0, stage: 'idle', phase: 'preparation', phaseProgress: 0 },
  }));
  await page.route('**/api/updates/progress', route => route.fulfill({ json: progressStatus }));
  await page.goto(`${origin}/admin/updates`);
  await page.addScriptTag({ url: `${origin}/admin-updates.js` });
  await page.evaluate(() => {
    const t = (_spanish, english) => english;
    window.Swal = { fire: async () => ({ isConfirmed: true }) };
    const api = async (url, options = {}) => {
      const response = await fetch(url, options);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Update request failed');
      return result;
    };
    window.TeralthAdminUpdates.render(document.getElementById('updates'), {
      api,
      t,
      esc: value => String(value),
      showError: (_root, error) => { throw error; },
      csrf: 'test-token',
      canManageBackups: true,
      startSeparateUpdate: update => window.TeralthAdminUpdates.openProgressPage({ ...update, t }),
    });
  });
}

test('the admin keeps its sidebar until an update is confirmed, then opens the separate progress page', async ({ page }) => {
  let installs = 0;
  await page.route('**/api/admin/updates/automatic/validate', route => route.fulfill({ json: { token: 'validated-token' } }));
  await page.route('**/api/admin/updates/install', route => {
    installs++;
    return route.fulfill({ json: { ok: true } });
  });
  await prepareAdminUpdatePage(page, {
    active: true,
    progress: 72,
    stage: 'migrations',
    phase: 'installation',
    phaseProgress: 55,
  });

  await expect(page.locator('#adminNavigation')).toBeVisible();
  await expect(page.locator('#updateReleaseStatus')).toContainText('2 versions behind');
  await expect(page.locator('.standalone-updater-shell')).toHaveCount(0);
  await page.locator('#applyAutomaticUpdate').click();
  await expect(page).toHaveURL(/\/admin\/updates\/progress\?transfer=/);
  await expect(page.locator('.standalone-updater-shell')).toBeVisible();
  await expect(page.locator('#adminNavigation')).toHaveCount(0);
  await expect(page.locator('body')).toHaveClass(/is-updating/);
  await expect(page.locator('.update-phase-list > li')).toHaveCount(4);
  await expect(page.locator('#updateValidationBar')).toBeVisible();
  await expect(page.locator('#updateValidationPercent')).toHaveText('72%');
  await expect(page.locator('#updateValidationStage')).toHaveText('Applying database changes…');
  await expect(page.locator('[data-update-phase="installation"] [role="progressbar"]')).toHaveAttribute('aria-valuenow', '55');
  await expect.poll(() => installs).toBe(1);
});

test('a manually selected package is carried to the separate update page', async ({ page }) => {
  let uploadedPackage = '';
  let installs = 0;
  await page.route('**/api/admin/updates/validate', route => {
    uploadedPackage = route.request().postData() || '';
    return route.fulfill({ json: { token: 'validated-token' } });
  });
  await page.route('**/api/admin/updates/install', route => {
    installs++;
    return route.fulfill({ json: { ok: true } });
  });
  await prepareAdminUpdatePage(page);

  await expect(page.locator('#updateReleaseStatus')).toContainText('2 versions behind');
  await expect(page.locator('#applySiteUpdate')).toBeEnabled();
  await page.locator('#siteUpdateFile').setInputFiles({
    name: 'signed-update.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('signed update package'),
  });
  await page.locator('#applySiteUpdate').click();
  await expect(page).toHaveURL(/\/admin\/updates\/progress\?transfer=/);
  await expect(page.locator('#updateValidation')).toBeVisible();
  await expect.poll(() => uploadedPackage).toContain('signed-update.zip');
  await expect.poll(() => installs).toBe(1);
});

test('update progress places phase cards left of the overall ring and tracks each phase', async ({ page }) => {
  await prepareUpdatePage(page, {
    currentVersion: '1.2.0',
    latestVersion: '1.4.0',
    releaseTag: 'v1.4.0',
    available: true,
    versionsBehind: 2,
    assetAvailable: true,
  });
  await page.evaluate(() => {
    window.validationStatus = { active: true, progress: 34, stage: 'preflight', phase: 'verification', phaseProgress: 65 };
    window.validationPending = new Promise((resolve) => { window.finishUpdateValidation = () => resolve({ token: 'validated-token' }); });
  });
  await expect(page.locator('.update-phase-list > li')).toHaveCount(4);
  await expect(page.locator('.update-phase-list [role="progressbar"]')).toHaveCount(4);
  await page.evaluate(() => { window.confirmationResult = { isDenied: false, isConfirmed: true }; });
  await page.locator('#applyAutomaticUpdate').click();
  await expect(page.locator('#updateValidation')).toBeVisible();
  const phaseCards = await page.locator('.update-phase-list').boundingBox();
  const overallRing = await page.locator('#updateValidationBar').boundingBox();
  expect(phaseCards.x + phaseCards.width).toBeLessThan(overallRing.x);
  await expect(page.locator('[data-update-phase="verification"] [role="progressbar"]')).toHaveAttribute('aria-valuenow', '65');
  await expect(page.locator('[data-update-phase="preparation"] [role="progressbar"]')).toHaveAttribute('aria-valuenow', '100');
  await expect(page.locator('[data-update-phase="installation"] [role="progressbar"]')).toHaveAttribute('aria-valuenow', '0');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCards = await page.locator('.update-phase-list').boundingBox();
  const mobileRing = await page.locator('#updateValidationBar').boundingBox();
  expect(mobileCards.y + mobileCards.height).toBeLessThanOrEqual(mobileRing.y);
  await page.evaluate(() => window.finishUpdateValidation());
  await expect(page.locator('body')).toHaveAttribute('data-maintenance-entered', 'true');
});
