import { test, expect } from '@playwright/test';
import express from 'express';
import path from 'path';

let server;
let origin;
const pageData = {
  id: 1, slug: 'home', titles: { en: 'Home' },
  content: { en: '<h1>Home</h1><h2>Getting started</h2><p>Documentation.</p>' },
};

test.beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.get('/api/config', (req, res) => res.json({
    site: { name: 'Teralth Wiki' }, spaces: [{ slug: 'main', name: 'Documentation' }],
    languages: ['en'], languageCatalog: [], captcha: { enabled: false },
  }));
  app.get('/api/auth/me', (req, res) => res.json({
    user: { username: 'Admin', role: 'administrator', isPrimaryAdmin: true }, csrfToken: 'test',
  }));
  app.get('/api/pages', (req, res) => res.json({
    pages: [pageData], categories: [], homePageSlug: 'home', page: pageData, reactions: [],
  }));
  app.get('/api/pages/:slug', (req, res) => res.json({ page: pageData, reactions: [] }));
  app.put('/api/admin/pages/:slug', (req, res) => res.json({ ok: true, slug: req.params.slug, space: 'main' }));
  app.use('/languages', express.static(path.join(process.cwd(), 'languages')));
  app.use('/vendor/prism', express.static(path.join(process.cwd(), 'node_modules', 'prismjs')));
  app.use('/vendor/fontawesome', express.static(path.join(process.cwd(), 'node_modules', '@fortawesome', 'fontawesome-free')));
  app.get(/^\/admin(?:\/.*)?$/, (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));
  app.use(express.static(path.join(process.cwd(), 'public')));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.Swal = { fire: async () => ({ isConfirmed: true }) };
    document.cookie = 'teralth_cookie_consent=accepted; path=/';
  });
});

test('editor markup keeps external-link fields inert and rejects unsafe link protocols', async ({ page }) => {
  await page.goto(`${origin}/admin`);
  const result = await page.evaluate(() => {
    const unsafeTitle = '<img src=x onerror=window.__editorXss=true>';
    const encoded = encodeURIComponent(unsafeTitle);
    const markup =
      `[external-link-v2 title="${encoded}" description="" url="${encodeURIComponent('javascript:alert(1)')}" target="blank"]` +
      '[/external-link-v2]' +
      '[external-link title="&lt;img src=x onerror=window.__editorXss=true&gt;" description="" url="javascript:alert(1)" target="blank"][/external-link]';
    const holder = document.createElement('div');
    holder.innerHTML = window.editorHtmlFromMarkup(markup);
    const unsafe = document.createElement('div');
    unsafe.innerHTML = window.editorHtmlFromMarkup(
      '<script>window.__editorXss=true</script>' +
      '<img src="javascript:alert(1)" onerror="window.__editorXss=true">' +
      '<svg onload="window.__editorXss=true"><text>unsafe</text></svg>' +
      '<a href="javascript:alert(1)" onclick="window.__editorXss=true">unsafe link</a>',
    );
    return {
      text: holder.textContent,
      images: holder.querySelectorAll('img').length,
      links: [...holder.querySelectorAll('a')].map(link => ({
        href: link.getAttribute('href'),
        eventHandler: link.getAttribute('onerror'),
      })),
      unsafe: {
        scripts: unsafe.querySelectorAll('script,svg').length,
        eventHandlers: unsafe.querySelectorAll('[onerror],[onload],[onclick]').length,
        imageSource: unsafe.querySelector('img')?.getAttribute('src') || null,
        linkHref: unsafe.querySelector('a')?.getAttribute('href') || null,
      },
    };
  });
  expect(result.text).toContain('<img src=x onerror=window.__editorXss=true>');
  expect(result.images).toBe(0);
  expect(result.links).toHaveLength(2);
  expect(result.links).toEqual([
    { href: null, eventHandler: null },
    { href: null, eventHandler: null },
  ]);
  expect(result.unsafe).toEqual({
    scripts: 0,
    eventHandlers: 0,
    imageSource: null,
    linkHref: null,
  });
  expect(await page.evaluate(() => window.__editorXss)).toBeUndefined();
});

  test('users paginate in groups of 15 and controls still work on later pages', async ({ page }) => {
    const users = Array.from({ length: 166 }, (_, i) => ({
      id: i + 1, username: `User ${i + 1}`, email: `user${i + 1}@example.test`,
      role: 'user', verified_at: '2026-01-01',
    }));
    await page.route('**/api/admin/users', route => route.fulfill({
      json: { users, roles: [{ roleKey: 'user', name: 'User' }, { roleKey: 'editor', name: 'Editor' }] },
    }));
    let updated;
    await page.route('**/api/admin/users/*/role', route => {
      updated = route.request().url();
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(`${origin}/admin`);
    await page.locator('#adminNavigation [data-tab="users"]').click();
    const pager = page.locator('.user-pagination');
    await expect(page.locator('.user-row:visible')).toHaveCount(15);
    await expect(pager.getByRole('button', { name: 'Start' })).toBeDisabled();
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('.user-row:visible').first()).toContainText('User 16');
    await page.locator('.user-row:visible').first().locator('select').selectOption('editor');
    await expect.poll(() => updated).toContain('/16/role');
    await pager.getByRole('button', { name: 'End' }).click();
    await expect(page.locator('.user-row:visible')).toHaveCount(1);
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(pager.getByRole('button', { name: 'End' })).toBeDisabled();
    await pager.getByRole('button', { name: 'Previous' }).click();
    await expect(page.locator('.user-row:visible')).toHaveCount(15);
    await pager.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('.user-row:visible').first()).toContainText('User 1');
  });

  test('spoiler editor creates, renames, preserves nested widgets through source mode and saves', async ({ page }) => {
    await page.goto(`${origin}/admin`);
    await page.locator('#pageRows .edit-page').click();
    await page.evaluate(() => {
      let spoilerPromptCount = 0;
      window.Swal.fire = async options => options.html?.includes('data-spoiler-title')
        ? { isConfirmed: true, value: spoilerPromptCount++ ? 'Renamed <spoiler>' : 'Reveal details' }
        : { isConfirmed: true, value: { language: 'text' } };
    });
    await page.locator('#editContent').click();
    await page.locator('[data-command="spoiler"]').click();
    const spoiler = page.locator('#editContent .wiki-spoiler');
    await expect(spoiler).toHaveCount(1);
    await spoiler.locator('summary').click();
    await expect(spoiler.locator('.spoiler-title')).toHaveText('Renamed <spoiler>');
    const body = spoiler.locator('.spoiler-body');
    await body.locator('p').click();
    await page.locator('[data-command="hint-success"]').click();
    await expect(body.locator('.hint.success')).toHaveCount(1);
    await body.locator('p').last().click();
    await page.locator('[data-command="code"]').click();
    await expect(body.locator('.code-block')).toHaveCount(1);
    await page.locator('[data-source-toggle]').click();
    await page.locator('[data-source-toggle]').click();
    await expect(spoiler.locator('.hint.success')).toHaveCount(1);
    await expect(spoiler.locator('.code-block')).toHaveCount(1);
    const saved = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/admin/pages/'));
    await page.locator('#savePage').click();
    const content = (await saved).postDataJSON().content.en;
    expect(content).toContain('Renamed &lt;spoiler&gt;');
    expect(content).toContain('class="wiki-spoiler"');
    expect(content).toContain('hint success');
    expect(content).toContain('code-block');
    expect(content).not.toContain('editor-spoiler-delete');
    expect(content).not.toContain(' open');
  });

  test('spoiler deletion removes only the chosen block', async ({ page }) => {
    await page.goto(`${origin}/admin`);
    await page.locator('#pageRows .edit-page').click();
    await page.evaluate(() => { window.Swal.fire = async () => ({ isConfirmed: true, value: 'Details' }); });
    await page.locator('#editContent').click();
    await page.locator('[data-command="spoiler"]').click();
    await expect(page.locator('#editContent .wiki-spoiler')).toHaveCount(1);
    await page.locator('.editor-spoiler-delete').click();
    await expect(page.locator('#editContent .wiki-spoiler')).toHaveCount(0);
    await expect(page.locator('#editContent')).toContainText('Documentation.');
  });

  test('spoiler title input aligns with the code block format field', async ({ page }) => {
    await page.goto(`${origin}/admin`);
    await page.locator('#pageRows .edit-page').click();
    await page.locator('#editContent').click();
    await page.locator('[data-command="spoiler"]').click();
    const spoilerDialog = page.locator('.editor-swal-popup:visible'),
      spoilerInput = spoilerDialog.locator('[data-spoiler-title]');
    await expect(spoilerInput).toBeVisible();
    const inputBox = await spoilerInput.boundingBox();
    const spoilerCancel = spoilerDialog.locator('.swal2-cancel');
    await spoilerCancel.click();

    await page.locator('[data-command="code"]').click();
    const codeDialog = page.locator('.editor-swal-popup:visible'),
      codeFormat = codeDialog.locator('.editor-swal-select-trigger');
    await expect(codeFormat).toBeVisible();
    const formatBox = await codeFormat.boundingBox();
    expect(Math.abs((inputBox.x + inputBox.width / 2) - (formatBox.x + formatBox.width / 2))).toBeLessThan(1);
    await codeDialog.locator('.swal2-cancel').click();
  });

for (const width of [1440, 390]) {
  test(`administration navigation and separate page editor at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/admin`);
    await expect(page.locator('#pageRows .edit-page')).toBeVisible();
    if (width < 680) await page.locator('#openSidebar').click();
    await expect(page.locator('#adminNavigation [data-tab]')).toHaveCount(14);
    await expect(page.locator('#spacePicker')).toBeHidden();
    await expect(page.locator('#searchInput')).toBeHidden();
    await expect(page.locator('#supportCard')).toBeHidden();
    await page.locator('#adminNavigation [data-tab="categories"]').click();
    await expect(page.locator('#adminNavigation [data-tab="categories"]')).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(/\/admin\/categories\?space=main$/);
    await expect(page.locator('#adminContent')).toContainText('Navigation categories');
    if (width < 680) await page.locator('#openSidebar').click({ timeout: 5000 });
    await page.locator('#adminNavigation [data-tab="pages"]').click();
    await expect(page).toHaveURL(/\/admin\/pages\?space=main$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/categories\?space=main$/);
    await expect(page.locator('#adminNavigation [data-tab="categories"]')).toHaveAttribute('aria-current', 'page');
    await page.goForward();
    await expect(page).toHaveURL(/\/admin\/pages\?space=main$/);
    if (width < 680) await page.locator('#openSidebar').click({ timeout: 5000 });
    await page.locator('#adminNavigation [data-tab="pages"]').click({ timeout: 5000 });
    await page.locator('#pageRows .edit-page').click({ timeout: 5000 });
    await expect(page.locator('#editorHeading')).toHaveText('Editing file: Home');
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('#pageRows')).toBeHidden();
    await expect(page.locator('#tocLinks')).toContainText('Getting started');
    if (width > 940) {
      const editor = await page.locator('#pageEditor').boundingBox();
      const toc = await page.locator('#toc').boundingBox();
      expect(toc.x).toBeGreaterThan(editor.x + editor.width);
    }
    await page.locator('#editTitle').fill('Updated');
    await expect(page.locator('#editorHeading')).toHaveText('Editing file: Updated');
    const savedRequest = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/admin/pages/'));
    await page.locator('#savePage').click({ timeout: 5000 });
    expect((await savedRequest).postDataJSON().titles.en).toBe('Updated');
    await expect(page.locator('#pageRows')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/editor-mode/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });

}

test('admin section URL opens the requested tab and keeps its space', async ({ page }) => {
  await page.route('**/api/admin/users', route => route.fulfill({ json: { users: [], roles: [] } }));
  await page.goto(`${origin}/admin/users?space=main`);
  await expect(page.locator('#adminNavigation [data-tab="users"]')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/\/admin\/users\?space=main$/);
});

test('activity logs search only on click and paginate ten records at a time', async ({ page }) => {
  const requests = [];
  await page.route('**/api/admin/logs*', async route => {
    const url = new URL(route.request().url()),
      pageNumber = Number(url.searchParams.get('page') || 1),
      search = url.searchParams.get('search') || '';
    requests.push({ page: pageNumber, search });
    const total = search ? 1 : 120,
      logs = search
        ? [{ id: 120, occurredAt: '2026-11-08T12:00:00Z', username: 'Admin', actionKey: 'captcha.enabled', detail: 'Cloudflare Turnstile' }]
        : Array.from({ length: 10 }, (_, index) => ({
            id: 120 - (pageNumber - 1) * 10 - index,
            occurredAt: '2026-11-08T12:00:00Z',
            username: `Admin ${pageNumber}`,
            actionKey: 'smtp.tested',
            detail: '',
          }));
    await route.fulfill({ json: { logs, page: pageNumber, total, totalPages: Math.ceil(total / 10) } });
  });
  await page.goto(`${origin}/admin`);
  await page.locator('#adminNavigation [data-tab="logs"]').click();
  await expect(page.getByRole('columnheader', { name: 'Log #' })).toBeVisible();
  await expect(page.locator('#auditLogRows tr')).toHaveCount(10);
  await expect(page.locator('#auditLogPagination')).toContainText('12');
  await page.locator('#auditLogPagination').getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => requests.at(-1)?.page).toBe(2);
  await expect(page.locator('#auditLogRows')).toContainText('Admin 2');
  const search = page.locator('#auditLogSearch');
  await search.fill('admin');
  await search.press('Enter');
  await expect.poll(() => requests.length).toBe(2);
  await page.locator('#auditLogSearchButton').click();
  await expect.poll(() => requests.at(-1)).toEqual({ page: 1, search: 'admin' });
  await expect(page.locator('#auditLogRows tr')).toHaveCount(1);
  await expect(page.locator('#auditLogRows')).toContainText('Enabled CAPTCHA verification with Cloudflare Turnstile.');
});

test('administration navigation respects permissions', async ({ page }) => {
    await page.route('**/api/auth/me', route => route.fulfill({
      json: { user: { username: 'Editor', permissions: ['admin.view', 'pages.create_edit'] }, csrfToken: 'test' },
    }));
    await page.goto(`${origin}/admin`);
    await expect(page.locator('#adminNavigation [data-tab]')).toHaveCount(1);
    await expect(page.locator('#adminNavigation [data-tab="pages"]')).toBeVisible();
    await expect(page.locator('#adminNavigation [data-tab="users"]')).toHaveCount(0);
});

test('general settings and languages retain their existing controls', async ({ page }) => {
    await page.goto(`${origin}/admin`);
    await page.locator('#adminNavigation [data-tab="settings"]').click({ timeout: 5000 });
    await expect(page.locator('#siteName')).toBeVisible();
    await expect(page.locator('#saveSettings')).toBeVisible();
    await page.locator('#adminNavigation [data-tab="languages"]').click({ timeout: 5000 });
    await expect(page.locator('#addLanguage')).toBeVisible();
    await expect(page.locator('#saveLanguages')).toBeVisible();
});

test('administration header stays available while scrolling settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(`${origin}/admin`);
  await page.locator('#adminNavigation [data-tab="settings"]').click();
  await page.evaluate(() => window.scrollTo({ top: 500, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  expect(Math.abs((await page.locator('.topbar').boundingBox()).y)).toBeLessThan(1);
  await page.locator('#accountLink').click();
  await expect(page.locator('#userMenu')).toBeVisible();
});

for (const permission of ['settings.identity', 'settings.support', 'settings.seo']) {
  test(`general settings exposes only ${permission} to a limited role`, async ({ page }) => {
    await page.route('**/api/auth/me', route => route.fulfill({
      json: { user: { username: 'Editor', permissions: ['admin.view', permission] }, csrfToken: 'test' },
    }));
    await page.goto(`${origin}/admin`);
    await page.locator('#adminNavigation [data-tab="settings"]').click();
    await expect(page.locator('#siteName')).toBeVisible({ visible: permission === 'settings.identity' });
    await expect(page.locator('#supportTitleInput')).toBeVisible({ visible: permission === 'settings.support' });
    await expect(page.locator('#seoDescription')).toBeVisible({ visible: permission === 'settings.seo' });
    let submitted;
    await page.route('**/api/admin/settings', route => {
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true } });
    });
    if (permission === 'settings.identity') await page.locator('#siteName').fill('Updated');
    if (permission === 'settings.support') await page.locator('#supportTitleInput').fill('Support');
    if (permission === 'settings.seo') await page.locator('#seoDescription').fill('Description');
    await page.locator('#saveSettings').click();
    await expect.poll(() => submitted).toBeTruthy();
    expect(Boolean(submitted.support)).toBe(permission === 'settings.support');
    expect(Boolean(submitted.seo)).toBe(permission === 'settings.seo');
  });
}

test('role editor groups current permissions and preserves selection on save', async ({ page }) => {
  const roles = [
    { roleKey: 'administrator', name: 'Administrator', color: '#5865f2', permissions: [], isSystem: true },
    { roleKey: 'user', name: 'User', color: '#64748b', permissions: [], isSystem: true },
    { roleKey: 'editor', name: 'Editor', color: '#64748b', permissions: ['admin.view', 'settings.identity'], isSystem: false },
  ];
  await page.route('**/api/admin/roles', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { roles } }) : route.fulfill({ json: { ok: true } }));
  await page.goto(`${origin}/admin`);
  await page.locator('#adminNavigation [data-tab="roles"]').click();
  const editor = page.locator('[data-role-key="editor"]');
  await editor.locator('.edit-role').click();
  await expect(editor.locator('[data-permission="logs.view"]')).toBeVisible();
  await expect(editor.locator('[data-permission-group="languages"]')).toBeVisible();
  await expect(editor.locator('[data-permission="settings.identity"]')).toBeChecked();
  await editor.locator('[data-permission="settings.support"]').check();
  await editor.locator('[data-permission="settings.seo"]').check();
  await expect(page.locator('.roles-intro')).toContainText('SMTP is available only to the primary administrator');
  const save = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/api/admin/roles'));
  await page.locator('#saveRoles').click();
  const saved = (await save).postDataJSON().roles.find(role => role.roleKey === 'editor');
  expect(saved.permissions).toEqual(expect.arrayContaining(['admin.view', 'settings.identity', 'settings.support', 'settings.seo']));
});

test('SMTP and CAPTCHA settings keep their controls after grouping', async ({ page }) => {
  await page.route('**/api/admin/smtp', route => route.fulfill({ json: { smtp: {
    host: 'smtp.example.com', port: 587, user: 'user', from: 'user@example.com',
    secure: false, passwordConfigured: true,
  } } }));
  await page.route('**/api/admin/captcha', route => route.fulfill({ json: { captcha: {
    enabled: false, provider: 'recaptcha', variant: 'v3', siteKey: '', secretConfigured: false, minScore: 0.5,
  } } }));
  await page.goto(`${origin}/admin`);
  await page.locator('#adminNavigation [data-tab="smtp"]').click();
  await expect(page.getByRole('heading', { name: 'Mail server' })).toBeVisible();
  await expect(page.locator('#smtpHost')).toHaveValue('smtp.example.com');
  await page.locator('#toggleSmtpPassword').click();
  await expect(page.locator('#smtpPassword')).toBeVisible();
  await page.locator('#toggleTestEmail').click();
  await expect(page.locator('#smtpTestEmail')).toBeVisible();
  await page.locator('#adminNavigation [data-tab="captcha"]').click();
  await expect(page.getByRole('heading', { name: 'Provider and type' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keys' })).toBeVisible();
  await expect(page.locator('#captchaScore')).toBeVisible();
  await page.locator('#captchaProvider').selectOption('hcaptcha');
  await expect(page.locator('#captchaScore')).toBeHidden();
});

for (const width of [1440, 390]) {
  test(`installer groups website fields and upload controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/setup/status', route => route.fulfill({ json: { host: '0.0.0.0', port: 3000 } }));
    await page.route('**/api/setup/test-db', route => route.fulfill({ json: { ok: true } }));
    await page.route('**/api/setup/test-smtp', route => route.fulfill({ json: { ok: true } }));
    await page.goto(`${origin}/installer.html`);
    await page.locator('#testDatabase').click();
    await page.locator('#nextDatabase').click();
    await page.locator('#testSmtp').click();
    await page.locator('#nextSmtp').click();
    const identity = page.locator('.setup-group').filter({ has: page.locator('#siteLogo') });
    await expect(identity.getByRole('heading', { name: 'Visual identity' })).toBeVisible();
    await expect(identity.locator('#siteFavicon')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

for (const width of [1440, 390]) {
  test(`identity uploads are consistent and grouped at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/admin`);
    if (width < 680) await page.locator('#openSidebar').click();
    await page.locator('#adminNavigation [data-tab="settings"]').click();
    const logo = page.locator('#siteLogoFile'), favicon = page.locator('#faviconFile');
    const styles = async element => element.evaluate(el => {
      const style = getComputedStyle(el);
      return { height: style.minHeight, border: style.borderStyle, background: style.backgroundColor };
    });
    expect(await styles(logo)).toEqual(await styles(favicon));
    const group = page.locator('.settings-group').filter({ has: logo });
    await expect(group.getByRole('heading', { name: 'Visual identity' })).toBeVisible();
    await expect(group.locator('#faviconFile')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator('#themeToggle').click();
    expect(await styles(logo)).toEqual(await styles(favicon));
  });
}

test('support translations and SEO settings are saved and applied', async ({ page }) => {
  let config = {
    site: { name: 'Teralth Wiki', sidebarLabel: 'Documentation' },
    spaces: [{ slug: 'main', name: 'Documentation', icon: 'fa-solid fa-book-open' }],
    languages: ['en', 'es'], languageCatalog: [], captcha: { enabled: false },
  };
  await page.route('**/api/config', route => route.fulfill({ json: config }));
  let submitted;
  await page.route('**/api/admin/settings', route => {
    submitted = route.request().postDataJSON();
    config = { ...config, site: { ...config.site, ...submitted } };
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${origin}/admin`);
  await page.locator('#adminNavigation [data-tab="settings"]').click();
  await expect(page.locator('#pageTitle')).toHaveCount(0);
  await expect(page.locator('#faviconFile')).toBeVisible();
  await page.locator('#siteName').fill('Example');
  await page.locator('#sidebarLabelInput').fill('Footer label');
  await page.locator('#supportTitleInput').fill('Help');
  await page.locator('#supportButtonInput').fill('Contact');
  await expect(page.locator('#supportPreviewTitle')).toHaveText('Help');
  await expect(page.locator('#supportPreviewButtonText')).toHaveText('Contact');
  await page.locator('#supportLanguage').selectOption('es');
  await expect(page.locator('#supportPreviewTitle')).toHaveText('¿Necesitas Ayuda?');
  await page.locator('#supportTitleInput').fill('Ayuda');
  await expect(page.locator('#supportPreviewTitle')).toHaveText('Ayuda');
  await page.locator('#supportDescriptionInput').fill('Estamos aquí');
  await expect(page.locator('#supportPreviewDescription')).toHaveText('Estamos aquí');
  await page.locator('#supportBackground').fill('#112233');
  await page.locator('#supportBackgroundEnd').fill('#445566');
  await page.locator('#supportButtonBackground').fill('#334455');
  await expect(page.locator('#supportPreviewCard')).toHaveCSS('background-image', /linear-gradient/);
  await expect(page.locator('#supportPreviewButton')).toHaveCSS('background-color', 'rgb(51, 68, 85)');
  await page.locator('#supportLanguage').selectOption('en');
  await expect(page.locator('#supportPreviewTitle')).toHaveText('Help');
  await page.locator('#supportLanguage').selectOption('es');
  await expect(page.locator('#supportPreviewDescription')).toHaveText('Estamos aquí');
  await page.locator('#seoDescription').fill('Site description');
  await page.locator('#seoCanonical').fill('https://example.test/docs');
  await page.locator('#seoIndexable').uncheck();
  await page.locator('#saveSettings').click();
  await expect.poll(() => submitted).toBeTruthy();
  expect(submitted.support.translations.en.title).toBe('Help');
  expect(submitted.support.translations.es.title).toBe('Ayuda');
  expect(submitted.seo).toMatchObject({ description: 'Site description', canonicalBase: 'https://example.test/docs', indexable: false });
  await expect(page.locator('#footerContent')).toHaveText('Footer label');
  await expect(page.locator('#footerCopyright')).toContainText('Example · All rights reserved.');
  await expect(page.locator('#supportTitle')).toHaveText('Help');
  await expect(page.locator('#supportCard')).toHaveCSS('background-image', /linear-gradient/);
  await expect(page.locator('#supportLink')).toHaveCSS('background-color', 'rgb(51, 68, 85)');
});

for (const width of [1440, 390]) {
  test(`support preview adapts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/admin`);
    if (width < 680) await page.locator('#openSidebar').click();
    await page.locator('#adminNavigation [data-tab="settings"]').click();
    await expect(page.locator('#supportPreviewCard')).toBeVisible();
    const form = await page.locator('.support-editor-fields').boundingBox();
    const preview = await page.locator('.support-preview').boundingBox();
    if (width > 1100) expect(preview.x).toBeGreaterThanOrEqual(form.x + form.width);
    else expect(preview.y).toBeGreaterThanOrEqual(form.y + form.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator('#themeToggle').click();
    await expect(page.locator('#supportPreviewCard')).toBeVisible();
  });
}

test('light theme keeps the administration and editor usable', async ({ page }) => {
  await page.goto(`${origin}/admin`);
  await expect(page.locator('#sidebar')).toHaveCSS('background-color', 'rgb(18, 18, 18)');
  await page.locator('#themeToggle').click();
  await expect(page.locator('body')).toHaveClass(/light/);
  await expect(page.locator('#sidebar')).toHaveCSS('background-color', 'rgb(245, 245, 245)');
  await page.locator('#accountLink').click();
  await expect(page.locator('#userMenu')).toBeVisible();
  await page.locator('#accountLink').click();
  await page.locator('#newPage').click();
  await expect(page.locator('#toc')).toBeVisible();
  await expect(page.locator('#savePage')).toBeVisible();
  await page.locator('#cancelEditor').click();
  await expect(page.locator('#pageRows')).toBeVisible();
});

test('editor back confirms unsaved changes and creation keeps its fields', async ({ page }) => {
  await page.goto(`${origin}/admin`);
  await page.locator('#newPage').click();
  await expect(page.locator('#editorHeading')).toHaveText('New page');
  await expect(page.locator('#editIconMode')).toBeVisible();
  await expect(page.locator('#editLanguage')).toBeVisible();
  await expect(page.locator('#editPageType')).toBeVisible();
  await page.locator('#editTitle').fill('Draft');
  await page.evaluate(() => { window.Swal.fire = async () => ({ isConfirmed: false }); });
  await page.locator('#cancelEditor').click();
  await expect(page.locator('#pageEditor')).toBeVisible();
  await page.evaluate(() => { window.Swal.fire = async () => ({ isConfirmed: true }); });
  await page.locator('#cancelEditor').click();
  await expect(page.locator('#pageRows')).toBeVisible();
});
