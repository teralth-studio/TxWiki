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
  app.use(publicScripts);
  app.get('/', (req, res) => res.send('<!doctype html><html><body></body></html>'));
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

test('maintenance screen initializes and updates progress', async ({ page }) => {
  await page.goto(origin);
  await page.addScriptTag({ url: `${origin}/maintenance.js` });
  await expect
    .poll(() => page.evaluate(() => typeof window.TeralthMaintenance?.enter))
    .toBe('function');
  await page.evaluate(() => window.TeralthMaintenance.enter());
  await expect(page.locator('#maintenancePercent')).toHaveText('0%');
  await expect(page.locator('#maintenanceStage')).toHaveText('Preparing the environment…');
  await expect(page.locator('.maintenance-phases li')).toHaveCount(4);
  await page.evaluate(() =>
    window.TeralthMaintenance.setProgress(56, 'staging', 'installation', 34),
  );
  await expect(page.locator('#maintenancePercent')).toHaveText('56%');
  await expect(page.locator('#maintenanceCurrentPhase')).toHaveText('Installation');
  await expect(page.locator('#maintenanceCurrentPhaseBar')).toHaveAttribute('aria-valuenow', '34');
});
