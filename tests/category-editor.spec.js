import { test, expect } from '@playwright/test';
import express from 'express';
import path from 'node:path';

let server, origin;
const image = '/media/abcdefghijklmnop.webp';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
test.beforeAll(async () => {
  const app = express();
  app.use('/languages', express.static(path.join(process.cwd(), 'languages')));
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.get(/^\/.*$/, (req, res) => res.sendFile(path.join(process.cwd(), 'public/index.html')));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

for (const theme of ['light', 'dark']) test(`categories create and edit preserve translations and all three brand modes in ${theme}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('wiki-theme', theme), theme);
  const categories = [], requests = [];
  let rejectParent = false;
  await page.addInitScript(() => { document.cookie = 'teralth_cookie_consent=accepted; path=/'; });
  await page.route('**/media/**', route => route.fulfill({ contentType: 'image/png', body: pixel }));
  await page.route('**/api/**', async route => {
    const request = route.request(), endpoint = new URL(request.url()).pathname;
    requests.push(endpoint);
    let data = { ok: true };
    if (endpoint === '/api/auth/me') data = { user: { id: 1, username: 'Admin', role: 'administrator', isPrimaryAdmin: true }, csrfToken: 'test' };
    else if (endpoint === '/api/config') data = { site: { name: 'Wiki' }, spaces: [{ slug: 'main', name: 'Documentation' }], languages: ['en', 'es'], captcha: { enabled: false } };
    else if (endpoint === '/api/admin/categories' && request.method() === 'GET') data = { categories };
    else if (endpoint === '/api/admin/uploads') data = { url: image };
    else if (endpoint.startsWith('/api/admin/categories') && ['POST', 'PUT'].includes(request.method())) {
      if (rejectParent) return route.fulfill({ status: 400, json: { error: 'Invalid parent category.' } });
      const body = request.postDataJSON();
      const category = { id: 1, names: body.names, icon: body.icon, parent_id: body.parentId, is_open: body.isOpen };
      if (categories.length) categories[0] = category; else categories.push(category);
    }
    await route.fulfill({ json: data });
  });
  await page.goto(origin + '/admin/categories');
  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  const dialog = page.locator('.swal2-popup');
  const checkParentLayout = async () => {
    await expect(dialog.locator('.brand-fields')).toBeVisible();
    await expect(dialog.locator('#categoryParent')).toBeVisible();
    const { brand, parent, expanded } = await dialog.evaluate(element => {
      const bounds = selector => element.querySelector(selector).getBoundingClientRect().toJSON();
      return { brand: bounds('.brand-fields'), parent: bounds('#categoryParent'), expanded: bounds('.category-open-default') };
    });
    expect(parent.y).toBeGreaterThanOrEqual(brand.y + brand.height);
    expect(Math.abs(parent.x - brand.x)).toBeLessThan(2);
    expect(Math.abs(parent.width - brand.width)).toBeLessThan(2);
    expect(expanded.y).toBeGreaterThanOrEqual(parent.y + parent.height);
  };
  await checkParentLayout();
  await expect(dialog.locator('.swal2-actions')).toContainText('Cancel');
  await expect(dialog.locator('.swal2-actions')).toContainText('Create category');
  await page.locator('#newCategoryName').fill('Guide');
  await dialog.locator('.swal2-confirm').click();
  await expect(dialog.locator('.swal2-validation-message')).toContainText('every active language');
  await page.locator('#newCategoryLanguage').selectOption('es');
  await page.locator('#newCategoryName').fill('Guía');
  await page.locator('#newCategoryLanguage').selectOption('en');
  await expect(page.locator('#newCategoryName')).toHaveValue('Guide');
  await page.locator('#categoryBrandMode').selectOption('none');
  await expect(dialog.locator('[data-brand-disabled]')).toBeDisabled();
  await expect(dialog.locator('[data-brand-preview]')).toBeHidden();
  await dialog.locator('.swal2-confirm').click();
  await expect(dialog).toBeHidden();
  expect(categories[0]).toMatchObject({ names: { en: 'Guide', es: 'Guía' }, icon: 'none' });

  await page.locator('.edit-category').click();
  await expect(page.locator('#categoryBrandMode')).toHaveValue('none');
  await checkParentLayout();
  await expect(page.locator('#categoryParent option[value="1"]')).toHaveCount(0);
  await page.locator('#newCategoryLanguage').selectOption('es');
  await expect(page.locator('#newCategoryName')).toHaveValue('Guía');
  await page.locator('#categoryBrandMode').selectOption('icon');
  const dialogBackground = await dialog.evaluate(element => getComputedStyle(element).backgroundColor);
  await dialog.locator('[data-brand-pick]').click();
  await expect(dialog.getByRole('heading', { name: 'Choose icon', exact: true })).toBeVisible();
  await expect(dialog).toHaveCSS('background-color', dialogBackground);
  await dialog.locator('.swal2-cancel').click();
  await expect(page.locator('#newCategoryName')).toHaveValue('Guía');
  await dialog.locator('[data-brand-pick]').click();
  await dialog.locator('[data-icon-name="book"]').click();
  await expect(dialog.getByRole('heading', { name: 'Edit category', exact: true })).toBeVisible();
  await expect(page.locator('#newCategoryName')).toHaveValue('Guía');
  await expect(dialog.locator('[data-brand-preview] .fa-book')).toBeVisible();
  rejectParent = true;
  await dialog.locator('.swal2-confirm').click();
  await expect(dialog.locator('.swal2-validation-message')).toContainText('The request could not be completed.');
  rejectParent = false;
  await dialog.locator('.swal2-confirm').click();
  await expect(dialog).toBeHidden();
  expect(categories[0].icon).toBe('fa-solid fa-book');

  await page.locator('.edit-category').click();
  await page.locator('#categoryBrandMode').selectOption('image');
  await dialog.locator('[data-brand-file]').setInputFiles({ name: 'category.png', mimeType: 'image/png', buffer: pixel });
  await expect(dialog.locator('[data-brand-preview] img')).toHaveAttribute('src', image);
  await dialog.locator('.swal2-confirm').click();
  await expect(dialog).toBeHidden();
  expect(categories[0].icon).toBe(image);
  await page.locator('.edit-category').click();
  await expect(page.locator('#categoryBrandMode')).toHaveValue('image');
  await expect(dialog.locator('[data-brand-preview] img')).toHaveAttribute('src', image);
  await dialog.locator('.swal2-cancel').click();
  expect(requests).not.toContain('/api/pages');
  expect(requests).not.toContain('/api/admin/pages');
});
