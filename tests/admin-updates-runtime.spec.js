import { test, expect } from '@playwright/test';
import express from 'express';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'playwright.config.js'));
const { publicScripts } = require(path.join(process.cwd(), 'scripts', 'public-scripts.js'));
let server;
let origin;

test.beforeAll(async () => {
  const app = express();
  app.get('/', (req, res) => res.send('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main id="updates"></main></body></html>'));
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
