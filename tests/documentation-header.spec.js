import { test, expect } from '@playwright/test';
import express from 'express';
import path from 'path';

let server;
let origin;
const documentPage = {
  id: 1,
  slug: 'home',
  titles: { en: 'Home' },
  content: { en: '<h1>Home</h1><h2>Getting started</h2><p>Documentation.</p>' },
};

test.beforeAll(async () => {
  const app = express();
  app.get('/api/config', (req, res) => res.json({
    site: { name: 'Teralth Wiki' },
    spaces: [{ slug: 'main', name: 'Documentation' }],
    languages: ['en'],
    captcha: { enabled: false },
  }));
  app.get('/api/auth/me', (req, res) => res.json({
    user: { username: 'Administrator', role: 'administrator' },
    csrfToken: 'test',
  }));
  app.get('/api/pages', (req, res) => res.json({
    pages: [documentPage], categories: [], homePageSlug: 'home',
    page: documentPage, reactions: [], myReaction: '',
  }));
  app.use('/languages', express.static(path.join(process.cwd(), 'languages')));
  app.use('/vendor/prism', express.static(path.join(process.cwd(), 'node_modules', 'prismjs')));
  app.use('/vendor/fontawesome', express.static(path.join(process.cwd(), 'node_modules', '@fortawesome', 'fontawesome-free')));
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.get(/^\/admin(?:\/.*)?$/, (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('spoilers are closed by default, work with keyboard, and reveal headings from the outline', async ({ page }) => {
  const content = '<h1>Home</h1><details class="wiki-spoiler"><summary><i class="spoiler-icon fa-solid fa-eye-slash"></i><span class="spoiler-title">Reveal</span></summary><div class="spoiler-body"><h2>Hidden heading</h2><p><strong>Secret</strong></p><div class="hint success"><span class="hint-body">Success</span></div><div class="code-block"><div class="code-block-heading"><span class="code-format-label" data-language="text">Text</span></div><pre><code>hello</code></pre></div></div></details>';
  await page.route('**/api/pages', route => route.fulfill({ json: {
    pages: [documentPage], categories: [], homePageSlug: 'home',
    page: { ...documentPage, content: { en: content } }, reactions: [],
  } }));
  await page.goto(origin);
  const spoiler = page.locator('#article .wiki-spoiler');
  await expect(spoiler).not.toHaveAttribute('open');
  await expect(spoiler.locator('.spoiler-body')).toBeHidden();
  await spoiler.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(spoiler.locator('.spoiler-body')).toBeVisible();
  await expect(spoiler.locator('.spoiler-icon')).toHaveClass(/fa-eye(?:\s|$)/);
  await page.keyboard.press('Enter');
  await expect(spoiler.locator('.spoiler-body')).toBeHidden();
  await page.locator('#tocLinks').getByText('Hidden heading').click();
  await expect(spoiler.locator('.spoiler-body')).toBeVisible();
});

test('startup requests translations concurrently and fetches English only once', async ({ page }) => {
  let configPending = false, overlapping = false, englishRequests = 0;
  await page.route('**/api/config', async route => {
    configPending = true;
    await new Promise(resolve => setTimeout(resolve, 250));
    configPending = false;
    await route.continue();
  });
  await page.route('**/languages/language_en.json', async route => {
    englishRequests++;
    overlapping ||= configPending;
    await route.continue();
  });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  expect(overlapping).toBe(true);
  expect(englishRequests).toBe(1);
});

test('spoiler stays usable on mobile in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const content = '<h1>Home</h1><details class="wiki-spoiler"><summary><i class="spoiler-icon fa-solid fa-eye-slash"></i><span class="spoiler-title">Reveal details</span></summary><div class="spoiler-body"><p>Hidden content</p></div></details>';
  await page.route('**/api/pages', route => route.fulfill({ json: {
    pages: [documentPage], categories: [], homePageSlug: 'home',
    page: { ...documentPage, content: { en: content } }, reactions: [],
  } }));
  await page.goto(origin);
  const spoiler = page.locator('#article .wiki-spoiler');
  await spoiler.locator('summary').click();
  await expect(spoiler.locator('.spoiler-body')).toBeVisible();
  await page.locator('#themeToggle').click();
  await expect(spoiler.locator('.spoiler-body')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('code blocks share the spoiler surface in dark and light themes', async ({ page }) => {
  const content = '<h1>Home</h1><details class="wiki-spoiler"><summary>Reveal</summary><div class="spoiler-body">Hidden</div></details><div class="code-block"><div class="code-block-heading"><span class="code-format-label">Text</span></div><pre><code>hello</code></pre></div>';
  await page.route('**/api/pages', route => route.fulfill({ json: {
    pages: [documentPage], categories: [], homePageSlug: 'home',
    page: { ...documentPage, content: { en: content } }, reactions: [],
  } }));
  await page.goto(origin);
  await expect(page.locator('.article .code-block')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/wiki-mode/);
  const surfaceStyles = () => page.evaluate(() => {
    const style = selector => {
      const element = document.querySelector(selector);
      const computed = getComputedStyle(element);
      return [computed.borderRadius, computed.borderColor, computed.backgroundColor];
    };
    return [style('.wiki-spoiler'), style('.article .code-block')];
  });
  expect(await surfaceStyles()).toEqual([
    ['12px', 'rgb(52, 54, 56)', 'rgb(27, 28, 30)'],
    ['12px', 'rgb(52, 54, 56)', 'rgb(27, 28, 30)'],
  ]);
  await page.locator('#themeToggle').click();
  await expect.poll(async () => (await surfaceStyles())[0][1]).toBe('rgb(216, 216, 211)');
  const light = await surfaceStyles();
  expect(light[0]).toEqual(light[1]);
});

for (const width of [1440, 1024, 940, 390]) {
  test(`header controls work and align at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await expect(page.locator('#article h1')).toBeVisible();
    const account = page.locator('#accountLink');
    await expect(account).toBeVisible();
    const header = await page.locator('.topbar').boundingBox();
    const accountBox = await account.boundingBox();
    expect(accountBox.x + accountBox.width).toBeLessThanOrEqual(width - 8);
    expect(accountBox.y).toBeGreaterThanOrEqual(8);
    expect(accountBox.y + accountBox.height).toBeLessThan(header.y + header.height);

    await account.click();
    await expect(page.locator('#userMenu')).toBeVisible();
    await account.click();
    await expect(page.locator('#userMenu')).toBeHidden();
    if (width > 940) {
      await page.locator('#tocLinks a').last().click();
      await expect(page.locator('#article h2')).toBeInViewport();
    }
    await account.click();
    await page.locator('[data-user-action="admin"]').click();
    await expect(page).toHaveURL(/\/admin\/pages\?space=main$/);
    await expect(page.locator('body')).not.toHaveClass(/wiki-mode/);
  });
}

test('site identity stays in the navbar, separate from the workspace picker', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  const desktopBrand = page.locator('#brand');
  await expect(desktopBrand.locator('.brand-name')).toHaveText('Teralth Wiki');
  await expect(desktopBrand.locator('.brand-mark')).toBeVisible();
  const brandHit = await desktopBrand.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { hit: target === element || element.contains(target), rect: rect.toJSON(), target: target?.outerHTML?.slice(0, 240) };
  });
  expect(brandHit.hit).toBe(true);
  await expect(page.locator('#spaceCurrentName')).toHaveText('Documentation');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBrand = page.locator('#mobileDocsBrand');
  await expect(mobileBrand).toBeVisible();
  await expect(mobileBrand.locator('.mobile-docs-name')).toHaveText('Teralth Wiki');
  await expect(mobileBrand.locator('.brand-mark')).toBeVisible();
  await expect(desktopBrand).toBeHidden();
  await page.locator('#openSidebar').click();
  await expect(page.locator('#spaceDropdownButton')).toBeVisible();
  await expect(page.locator('#spaceCurrentName')).toHaveText('Documentation');
});

test('public links sit beside the site identity on desktop and mobile', async ({ page }) => {
  await page.route('**/api/config', async route => {
    const response = await route.fetch();
    const config = await response.json();
    config.headerLinks = [
      { id: 'internal', url: '/guide', external: false, titles: { en: 'Guide' } },
      { id: 'external', url: 'https://example.test/docs', external: true, titles: { en: 'More docs' } },
    ];
    await route.fulfill({ response, json: config });
  });
  await page.goto(origin);
  const nav = page.locator('#headerLinks');
  await expect(page.locator('#article h1')).toBeVisible();
  await expect(nav).toBeVisible();
  await expect(page.locator('#breadcrumbs')).toBeHidden();
  await expect(nav.getByRole('link', { name: 'Guide' })).toHaveAttribute('href', '/guide');
  await expect(nav.getByRole('link', { name: 'More docs' })).toHaveAttribute('target', '_blank');
  await expect(nav.getByRole('link', { name: 'More docs' })).toHaveAttribute('rel', 'noopener noreferrer');
  const guide = nav.getByRole('link', { name: 'Guide' });
  await guide.hover();
  await expect(guide).toHaveCSS('border-radius', '10px');
  await expect(guide).toHaveCSS('padding-left', '12px');
  await expect(guide).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const brand = page.locator(width <= 680 ? '#mobileDocsBrand' : '#brand');
    await expect(brand).toBeVisible();
    const [brandBox, navBox] = await Promise.all([brand.boundingBox(), nav.boundingBox()]);
    expect(navBox.x).toBeGreaterThanOrEqual(brandBox.x + brandBox.width - 1);
    expect(Math.abs(navBox.y + navBox.height / 2 - brandBox.y - brandBox.height / 2)).toBeLessThanOrEqual(4);
    expect(navBox.width).toBeGreaterThan(0);
    if (width > 680) {
      await expect(page.locator('#brand')).toHaveCSS('border-right-width', '0px');
      expect(navBox.x - (brandBox.x + brandBox.width)).toBeLessThanOrEqual(13);
    }
    if (width <= 680) {
      const [searchBox, menuBox] = await Promise.all([
        page.locator('#mobileDocsSearch').boundingBox(),
        page.locator('#openSidebar').boundingBox(),
      ]);
      expect(searchBox.y).toBeGreaterThanOrEqual(brandBox.y + brandBox.height - 1);
      expect(menuBox.y).toBeGreaterThanOrEqual(brandBox.y + brandBox.height - 1);
    }
  }
});

test('header works without a visible table of contents and in the light theme', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  await page.locator('#themeToggle').click();
  await page.locator('#toc').evaluate(element => { element.hidden = true; });
  await page.locator('#accountLink').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#userMenu')).toBeVisible();
  await page.locator('[data-user-action="admin"]').click();
  await expect(page).toHaveURL(/\/admin\/pages\?space=main$/);
});

test('documentation spaces has its own admin section, separate from general settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  await page.locator('#accountLink').focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-user-action="admin"]').click();
  await expect(page).toHaveURL(/\/admin\/pages\?space=main$/);
  await expect(page.locator('#adminNavigation')).toBeVisible();
  await page.locator('#adminNavigation [data-tab="spaces"]').click();
  await expect(page).toHaveURL(/\/admin\/spaces\?space=main$/);
  await expect(page.locator('#spaceRows')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Documentation spaces' })).toBeVisible();
  await page.locator('#adminNavigation [data-tab="settings"]').click();
  await expect(page).toHaveURL(/\/admin\/settings\?space=main$/);
  await expect(page.locator('#spaceRows')).toHaveCount(0);
  await expect(page.locator('#saveSettings')).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`navigation remains full width while the reading pane scrolls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await expect(page.locator('#article h1')).toBeVisible();
    const header = page.locator('.topbar');
    await expect(header).toHaveCSS('position', 'fixed');
    const before = await header.boundingBox();
    expect(before.x).toBe(0);
    expect(before.width).toBe(width);
    await page.locator('#article').evaluate(element => { element.style.minHeight = '1600px'; });
    await page.locator('#readingLayout').evaluate(element => { element.scrollTop = 500; });
    await expect.poll(() => page.locator('#readingLayout').evaluate(element => element.scrollTop)).toBeGreaterThan(300);
    await expect(page.locator('body')).not.toHaveClass(/wiki-scrolled/);
    const after = await header.boundingBox();
    expect(after.y).toBe(0);
    expect(after.x).toBe(0);
    expect(after.width).toBe(width);
    await expect(page.locator(width <= 680 ? '#mobileDocsBrand' : '#brand')).toBeVisible();
    await page.locator('#readingLayout').evaluate(element => { element.scrollTop = 0; });
    await expect.poll(async () => (await header.boundingBox()).y).toBe(0);
    await expect.poll(async () => (await header.boundingBox()).width).toBe(width);
  });
}

test('documentation uses a neutral near-black palette in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  const colors = async () => page.evaluate(() => {
    const color = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
    return {
      sidebar: color('#sidebar', 'backgroundColor'),
      surface: getComputedStyle(document.querySelector('.shell'), '::before').backgroundColor,
      activeBackground: color('.nav-link.active', 'backgroundColor'),
      activeText: color('.nav-link.active', 'color'),
      article: color('#article', 'color'),
      title: color('#article h1', 'color'),
    };
  });
  await expect(page.locator('body')).toHaveClass(/wiki-mode/);
  expect(await colors()).toEqual({
    sidebar: 'rgb(23, 24, 25)',
    surface: 'rgb(17, 18, 19)',
    activeBackground: 'rgb(41, 42, 44)',
    activeText: 'rgb(229, 229, 225)',
    article: 'rgb(238, 238, 236)',
    title: 'rgb(238, 238, 236)',
  });
  await page.locator('#themeToggle').click();
  await expect.poll(async () => (await colors()).activeBackground).toBe('rgb(229, 229, 225)');
  await expect(page.locator('body')).toHaveClass(/light/);
  expect(await colors()).toEqual({
    sidebar: 'rgb(239, 239, 236)',
    surface: 'rgb(247, 247, 245)',
    activeBackground: 'rgb(229, 229, 225)',
    activeText: 'rgb(37, 38, 35)',
    article: 'rgb(34, 35, 33)',
    title: 'rgb(34, 35, 33)',
  });
});

test('light theme keeps the reader on the same two-column shell grid', async ({ page }) => {
  await page.setViewportSize({ width: 1326, height: 594 });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  const shellGrid = () => page.locator('.shell').evaluate(element => {
    const columns = getComputedStyle(element).gridTemplateColumns.split(/\s+(?![^()]*\))/);
    const reader = document.querySelector('#readingLayout').getBoundingClientRect();
    return { columnCount: columns.length, columns, readerLeft: reader.left, readerRight: reader.right,
      documentWidth: document.documentElement.scrollWidth };
  });
  expect((await shellGrid()).columnCount).toBe(2);
  await page.locator('#themeToggle').click();
  const light = await shellGrid();
  expect(light.columnCount, JSON.stringify(light)).toBe(2);
  expect(light.readerRight, JSON.stringify(light)).toBeGreaterThanOrEqual(1325);
  expect(light.documentWidth).toBeLessThanOrEqual(1326);
});

test('category separators have no background in either public theme', async ({ page }) => {
  await page.route('**/api/pages', route => route.fulfill({ json: {
    pages: [documentPage],
    categories: [{ id: 2, parent_id: null, names: { en: 'A' }, icon: 'fa-folder', is_open: true }],
    homePageSlug: 'home', page: documentPage, reactions: [], myReaction: '',
  } }));
  await page.goto(origin);
  const category = page.locator('#navTree .nav-group-title');
  const activePage = page.locator('#navTree .nav-link.active');
  await expect(category).toContainText('A');
  await expect(activePage).toBeVisible();
  await expect(category).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await category.hover();
  await expect(category).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.locator('#themeToggle').click();
  await expect(category).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const activeBackground = await activePage.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(activeBackground).not.toBe('rgba(0, 0, 0, 0)');
});

test('table of contents highlights the current heading with text and a dot only', async ({ page }) => {
  await page.goto(origin);
  const toc = page.locator('#tocLinks');
  const active = toc.locator('a.active');
  await expect(active).toHaveText('Home');
  const state = async (link) => link.evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    weight: getComputedStyle(element).fontWeight,
    marker: getComputedStyle(element, '::before').content,
    markerBackground: getComputedStyle(element, '::before').backgroundColor,
  }));
  expect(await state(active)).toMatchObject({
    background: 'rgba(0, 0, 0, 0)',
    weight: '700',
    marker: '""',
  });
  expect((await state(active)).markerBackground).not.toBe('rgba(0, 0, 0, 0)');
  await toc.getByText('Getting started').hover();
  await expect(toc.getByText('Getting started')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.locator('#themeToggle').click();
  await expect(active).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const nextHeading = page.locator('#article h2').first();
  await nextHeading.evaluate(element => {
    const spacer = document.createElement('div');
    spacer.style.height = '1000px';
    element.after(spacer);
  });
  await nextHeading.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const nextActive = toc.locator('a.active');
  await expect(nextActive).toContainText('Getting started');
  expect(await state(nextActive)).toMatchObject({
    background: 'rgba(0, 0, 0, 0)',
    weight: '700',
    marker: '""',
  });
  expect((await state(nextActive)).markerBackground).not.toBe('rgba(0, 0, 0, 0)');
});

test('fixed public navbar is opaque so scrolled headings cannot show through it', async ({ page }) => {
  await page.goto(origin);
  const header = page.locator('.topbar');
  await page.locator('#article').evaluate(element => { element.style.minHeight = '1600px'; });
  await page.locator('#readingLayout').evaluate(element => { element.scrollTop = 300; });
  await expect.poll(() => page.locator('#readingLayout').evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await expect(header).toHaveCSS('position', 'fixed');
  const alpha = await header.evaluate(element => {
    const color = getComputedStyle(element).backgroundColor;
    return color.match(/rgba?\([^/]+(?:\/\s*([\d.]+))?\)/)?.[1] ?? '1';
  });
  expect(alpha).toBe('1');
});

for (const width of [1440, 800, 390]) {
  test(`reader pane scrolls to footer without moving the sidebar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => { document.cookie = 'teralth_cookie_consent=accepted; path=/'; });
    await page.goto(origin);
    await expect(page.locator('#article h1')).toBeVisible();
    const short = await page.evaluate(() => {
      const footer = document.querySelector('.site-footer').getBoundingClientRect();
      const support = document.querySelector('#supportCard').getBoundingClientRect();
      return {
        bottom: footer.bottom,
        supportBottom: support.bottom,
        footerTop: footer.top,
      };
    });
    expect(short.bottom).toBeGreaterThan(0);
    if (width > 680) expect(short.supportBottom).toBeLessThanOrEqual(900);
    await page.locator('#article').evaluate(element => { element.style.minHeight = '2200px'; });
    await page.locator('#readingLayout').evaluate(element => { element.scrollTop = 500; });
    await expect.poll(() => page.locator('#readingLayout').evaluate(element => element.scrollTop)).toBeGreaterThan(300);
    const header = await page.locator('.topbar').boundingBox();
    expect(Math.abs(header.y)).toBeLessThan(1);
    if (width > 680) {
      const support = await page.locator('#supportCard').boundingBox();
      expect(support.y).toBeGreaterThanOrEqual(0);
      expect(support.y + support.height).toBeLessThanOrEqual(900);
    }
    await page.locator('#accountLink').click();
    await expect(page.locator('#userMenu')).toBeVisible();
    await page.locator('#accountLink').click();
    await page.locator('#themeToggle').click();
    await expect(page.locator('body')).toHaveClass(/light/);
    await page.locator('#readingLayout').evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
    if (width > 680) {
      const bottom = await page.evaluate(() => {
        const footer = document.querySelector('.site-footer').getBoundingClientRect();
        const support = document.querySelector('#supportCard').getBoundingClientRect();
        return { footerTop: footer.top, supportTop: support.top, supportBottom: support.bottom };
      });
      expect(bottom.supportTop).toBeGreaterThanOrEqual(0);
      expect(bottom.supportBottom).toBeLessThanOrEqual(900);
    }
  });
}

test('sidebar and reading columns scroll independently with long navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  await page.locator('#navTree').evaluate(element => {
    for (let i = 0; i < 50; i++) element.append(document.createElement('p'));
    for (const child of element.querySelectorAll('p')) child.textContent = 'Navigation';
  });
  const reading = page.locator('#readingLayout');
  const before = await reading.evaluate(element => element.scrollTop);
  expect(await page.locator('#sidebar').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.locator('#sidebar').evaluate(element => { element.scrollTop = 300; });
  await expect.poll(() => page.locator('#sidebar').evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  expect(await reading.evaluate(element => element.scrollTop)).toBe(before);
  await page.locator('#sidebar').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('#supportCard')).toBeInViewport();
});

for (const width of [1440, 1326, 1024, 800, 390, 320, 280]) {
  test(`reactions finish before the footer and remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1326 ? 594 : 640 });
    await page.addInitScript(() => { document.cookie = 'teralth_cookie_consent=accepted; path=/'; });
    await page.route('**/api/pages/1/reactions', async route => {
      const { mood } = route.request().postDataJSON();
      const current = page.__reactionMood || '';
      const next = current === mood ? '' : mood;
      page.__reactionMood = next;
      await route.fulfill({ json: {
        reactions: next ? [{ mood: next, count: 1 }] : [],
        myReaction: next,
      } });
    });
    await page.route('**/api/pages', route => route.fulfill({ json: {
      pages: [documentPage], categories: [], homePageSlug: 'home',
      page: { ...documentPage, content: { en: '<h1>Welcome to your wiki</h1><p>This space is ready to document your projects. Choose a section on the left or sign in to edit.</p><h2>Getting started</h2><p>Use the administration panel to create pages, translate content, and configure documentation spaces.</p>' } },
      reactions: [], myReaction: '',
    } }));
    await page.goto(origin);
    await expect(page.locator('#article h1')).toBeVisible();
    await expect(page.locator('#reactions')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const reactions = document.querySelector('#reactions').getBoundingClientRect();
      const footer = document.querySelector('.site-footer').getBoundingClientRect();
      return {
        reactionBottom: reactions.bottom,
        footerTop: footer.top,
        reactionTop: reactions.top,
        mainBottom: document.querySelector('.main-column').getBoundingClientRect().bottom,
        mainHeight: document.querySelector('.main-column').getBoundingClientRect().height,
        mainScrollHeight: document.querySelector('.main-column').scrollHeight,
        articleWrap: document.querySelector('#articleWrap').getBoundingClientRect().toJSON(),
        gridRows: getComputedStyle(document.querySelector('#readingLayout')).gridTemplateRows,
        readingScrollHeight: document.querySelector('#readingLayout').scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry.footerTop, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.reactionBottom - 1);
    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
    await page.locator('#themeToggle').click();
    const lightGeometry = await page.evaluate(() => ({
      reactionBottom: document.querySelector('#reactions').getBoundingClientRect().bottom,
      footerTop: document.querySelector('.site-footer').getBoundingClientRect().top,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(lightGeometry.footerTop, JSON.stringify(lightGeometry)).toBeGreaterThanOrEqual(lightGeometry.reactionBottom - 1);
    expect(lightGeometry.documentWidth).toBeLessThanOrEqual(width);

    const happy = page.locator('.reaction-buttons [data-mood="happy"]');
    await expect(page.locator('.reaction-buttons button')).toHaveCount(3);
    const touchTargetsFit = await page.locator('.reaction-buttons button').evaluateAll((buttons, viewportWidth) =>
      buttons.every(button => {
        const box = button.getBoundingClientRect();
        return box.height >= 40 && box.left >= 0 && box.right <= viewportWidth;
      }), width);
    expect(touchTargetsFit).toBe(true);
    await happy.click();
    await expect(happy).toHaveClass(/selected/);
    await expect(happy.locator('span')).toHaveText('1');
    await expect(page.locator('.swal2-toast').last()).toContainText('Reaction submitted.');
    await happy.click();
    await expect(happy).not.toHaveClass(/selected/);
    await expect(happy.locator('span')).toHaveText('0');
    await expect(page.locator('.swal2-toast').last()).toContainText('Reaction submitted.');
  });
}

for (const width of [1440, 800, 390]) {
  test(`footer follows all wiki columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await expect(page.locator('#article h1')).toBeVisible();
    const positions = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const footer = rect('.site-footer'), main = rect('.main-column'), toc = rect('#toc'), theme = rect('#themeToggle'), account = rect('#accountLink');
      return { footerLeft: footer.left, footerRight: footer.right, footerTop: footer.top,
        mainBottom: main.bottom, tocBottom: toc.bottom, themeRight: theme.right, accountLeft: account.left };
    });
    const sidebarWidth = width > 680 ? (width > 1180 ? 238 : 250) : 0;
    const readingBounds = await page.locator('#readingLayout').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right - (element.offsetWidth - element.clientWidth) };
    });
    expect(positions.footerLeft).toBe(sidebarWidth);
    expect(positions.footerRight).toBe(readingBounds.right);
    expect(positions.footerTop).toBeGreaterThanOrEqual(positions.mainBottom - 1);
    expect(positions.footerTop).toBeGreaterThanOrEqual(positions.tocBottom - 1);
    expect(positions.themeRight).toBeLessThanOrEqual(positions.accountLeft);
    await expect(page.locator('#footerCopyright')).toContainText('Teralth Wiki · All rights reserved.');
    await expect(page.locator('#footerContent')).toHaveText('Documentation');
    await page.locator('#acceptCookies').click({ timeout: 5000 });
    await page.locator('#readingLayout').evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
    const visibility = await page.evaluate(() => {
      const copyright = document.querySelector('#footerCopyright');
      const footerContent = document.querySelector('#footerContent');
      const language = document.querySelector('#languageButton');
      const rect = element => element.getBoundingClientRect();
      const visibleAtCenter = element => {
        const box = rect(element);
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { visible: top === element || element.contains(top), covering: top?.outerHTML.slice(0, 160), box: box.toJSON() };
      };
      const content = rect(footerContent), button = rect(language);
      return {
        copyrightVisible: visibleAtCenter(copyright),
        contentVisible: visibleAtCenter(footerContent),
        contentOverlapsLanguage: content.left < button.right && content.right > button.left &&
          content.top < button.bottom && content.bottom > button.top,
      };
    });
    expect(visibility.copyrightVisible.visible, JSON.stringify(visibility.copyrightVisible)).toBe(true);
    expect(visibility.contentVisible.visible, JSON.stringify(visibility.contentVisible)).toBe(true);
    expect(visibility.contentOverlapsLanguage).toBe(false);
    await page.locator('#languageButton').click({ timeout: 5000 });
    await expect(page.locator('#languageMenu')).toBeVisible();
  });
}

test('footer copyright follows the selected language', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {
    site: { name: 'Teralth Wiki', sidebarLabel: 'Custom footer' },
    spaces: [{ slug: 'main', name: 'Documentation' }], languages: ['en', 'es'], captcha: { enabled: false },
  } }));
  await page.addInitScript(() => localStorage.setItem('wiki-language', 'es'));
  await page.goto(origin);
  await expect(page.locator('#article')).toBeVisible();
  await expect(page.locator('#footerCopyright')).toContainText('Teralth Wiki · Todos los derechos reservados.');
  await expect(page.locator('#footerContent')).toHaveText('Custom footer');
});

test('sign-in button is clickable for visitors', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({
    json: { user: null, csrfToken: 'test' },
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await expect(page.locator('#article h1')).toBeVisible();
  await page.locator('#accountLink').click();
  await expect(page).toHaveURL(/\/login\?next=/);
});
