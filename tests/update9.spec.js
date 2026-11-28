import { test, expect } from '@playwright/test';
import express from 'express';
import path from 'node:path';
let server, origin;
const avatar = '/media/abcdefghijklmnop.webp';
test.beforeAll(async () => {
  const app = express(); app.use('/languages',express.static(path.join(process.cwd(),'languages'))); app.use(express.static(path.join(process.cwd(),'public')));
  app.get(/^\/.*$/, (req,res) => res.sendFile(path.join(process.cwd(),'public/index.html')));
  server = await new Promise(resolve => { const listener = app.listen(0,'127.0.0.1',()=>resolve(listener)); }); origin = 'http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{ if(server) await new Promise(resolve=>server.close(resolve)); });
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{ document.cookie='teralth_cookie_consent=accepted; path=/'; });
  await page.route('**/media/abcdefghijklmnop.webp',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64')}));
  const pages = [{id:1,slug:'home',page_type:'content',titles:{en:'Home'},content:{en:'<h1>Home</h1><h2>Install</h2><h3>Configure</h3><h4>Details</h4><p>Public documentation.</p>'},tags:['Guide'],updated_at:'2026-11-27T12:00:00Z',updated_by_name:'Editor',updated_by_avatar:avatar}];
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),endpoint=url.pathname; let data;
    if(endpoint==='/api/auth/me') data={user:{id:1,username:'Admin',role:'administrator',isPrimaryAdmin:true,avatar},csrfToken:'test'};
    else if(endpoint==='/api/config')data={site:{name:'Teralth Wiki',wipContent:{en:'<h1>Under maintenance</h1>'}},spaces:[{slug:'main',name:'Documentation'}],languages:['en','es'],captcha:{enabled:false},headerLinks:[{url:'https://example.test',titles:{en:'Website'},external:true}]};
    else if(endpoint==='/api/pages'||endpoint==='/api/admin/pages')data={pages:endpoint==='/api/pages'?pages.filter(p=>p.publication_status!=='draft'):pages,categories:[],homePageSlug:'home',page:pages[0],reactions:[]};
    else if(endpoint.startsWith('/api/admin/pages/')&&request.method()==='PUT'){const value=request.postDataJSON(),slug=endpoint.split('/').at(-1),p={id:pages.length+1,slug,titles:value.titles,content:value.content,tags:value.tags,is_wip:value.isWip?1:0,page_type:value.pageType,publication_status:value.publicationStatus};const index=pages.findIndex(p=>p.slug===slug);if(index>=0)pages[index]=p;else pages.push(p);data={ok:true,slug,space:'main'};}
    else if(endpoint.startsWith('/api/pages/')||endpoint.startsWith('/api/admin/pages/')){const p=pages.find(p=>p.slug===endpoint.split('/').at(-1));data={page:p,reactions:[]};}
    else if(endpoint==='/api/search'){const q=url.searchParams.get('q')||'',tag=url.searchParams.get('tag')||'';data={tags:['Guide','API'],results:pages.filter(p=>p.publication_status!=='draft'&&(!tag||p.tags.includes(tag))&&JSON.stringify(p).toLowerCase().includes(q.toLowerCase())).map(p=>({slug:p.slug,title:p.titles.en,excerpt:'Public documentation.'}))};}
    else if(endpoint==='/api/admin/dashboard')data={version:'1.6.5',timeZone:'UTC',updatePermission:false,totals:{users:1,visitors:2,pages:1,reactions:0,happy:0,neutral:0,sad:0},series:[]};
    else data={ok:true};
    await route.fulfill({json:data});
  });
});
for(const width of [390,768,1440])for(const theme of ['light','dark']){
  test(`public navigation, tags and modal search work at ${width}px in ${theme}`,async({page})=>{
    await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('wiki-theme',theme),theme);
    await page.goto(origin); await expect(page.locator('#article h1')).toHaveText('Home');
    await expect(page.locator('#accountLink img')).toHaveAttribute('src',avatar);
    await expect(page.locator('#languageButton .language-current-flag')).toBeHidden();
    await expect(page.locator('#themeToggle svg')).toBeVisible();
    await expect(page.locator('#breadcrumbs')).toBeHidden();
    await expect(page.locator('#tocLinks a')).toHaveCount(4);
    await expect(page.locator('#tocLinks svg, #searchTrigger kbd')).toHaveCount(0);
    await expect(page.locator('#lastEdited .editor-chip img')).toHaveAttribute('src',avatar);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    if(width<=940){
      await expect(page.locator('#sidebar')).toHaveAttribute('inert','');await page.locator('#openSidebar').click();await expect(page.locator('.wiki-sidebar-brand')).toBeVisible();await expect(page.locator('#sidebar')).not.toHaveAttribute('inert','');
      await page.locator('#searchTrigger').click();await expect(page.locator('#searchDialog')).toBeVisible();await page.locator('#closeArticleSearch').click();await page.locator('#closeSidebar').click();await expect(page.locator('#sidebar')).toHaveAttribute('inert','');
    }
    await page.keyboard.press('Control+k');await expect(page.locator('#searchDialog')).toBeVisible();await expect(page.locator('#searchInput')).toBeFocused();
    await expect(page.locator('#searchDialog')).toHaveCSS('background-color',theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(17, 17, 17)');
    await page.locator('#searchInput').fill('Home');await expect(page.locator('#searchSuggestions a')).toHaveCount(1);
    await page.getByRole('button',{name:'API',exact:true}).click();await expect(page.locator('#searchSuggestions')).toContainText('No results.');
    await page.getByRole('button',{name:'API',exact:true}).click();await expect(page.locator('#searchSuggestions a')).toHaveCount(1);
    const box=await page.locator('#searchDialog').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');await expect(page.locator('#searchDialog')).toBeHidden();
    if(width<=940)await page.locator('#readingLayout').evaluate(el=>el.scrollTop=el.scrollHeight);
    await page.locator('[data-article-tag="Guide"]').click();await expect(page.locator('#searchDialog')).toBeVisible();await expect(page.locator('[data-search-tag="Guide"]')).toHaveAttribute('aria-pressed','true');
    await page.locator('#searchInput').fill('Home');await expect(page.locator('#searchSuggestions a')).toHaveCount(1);await page.locator('#searchInput').press('ArrowDown');await page.locator('#searchInput').press('Enter');await expect(page.locator('#searchDialog')).toBeHidden();await expect(page).toHaveURL(/\/home$/);
    await page.locator('#themeToggle').click();await expect(page.locator('#globalLoader')).toHaveCSS('background-color',theme === 'light' ? 'rgb(9, 9, 9)' : 'rgb(255, 255, 255)');
  });
}
test('editor saves tags, drafts and WIP and can publish a saved draft',async({page})=>{
  await page.goto(origin+'/admin/pages');await page.locator('#newPage').click();
  await page.locator('#editTitle').fill('Draft article');await page.locator('#editTags').fill('Guide');await page.locator('#editTags').press('Enter');await expect(page.locator('.tag-chip')).toContainText('Guide');
  await page.locator('#editTags').fill('Remove me');await page.locator('#editTags').press('Enter');await page.getByRole('button',{name:'Remove tag: Remove me'}).click();
  await page.locator('#editWip').check();await page.locator('#saveDraft').click();await expect(page.locator('.draft-badge')).toHaveText('Draft');
  await expect(page.locator('.wip-badge')).toHaveText('WIP');
  const row = page.locator('.page-row[data-slug="draft-article"]');
  await expect(row.locator('.sidebar-version')).toHaveCount(0);
  await expect(row.locator('.page-row-title')).toContainText('Draft article');
  await page.locator('.edit-page[data-slug="draft-article"]').click();await expect(page.locator('#editWip')).toBeChecked();await expect(page.locator('.tag-chip')).toHaveText('Guide×');await page.locator('#editContent').fill('Now published');await page.locator('#savePage').click();await expect(page.locator('.draft-badge')).toHaveCount(0);await expect(page.locator('.wip-badge')).toHaveText('WIP');
  await page.locator('.edit-page[data-slug="draft-article"]').click();await page.locator('#editPageType').selectOption('redirect');await expect(page.locator('#editWip')).toBeHidden();await expect(page.locator('#editTags')).toBeHidden();
});
test('breadcrumbs omit workspaces outside pages/categories and dashboard icons sit on the right',async({page})=>{
  const paths = [];
  page.on('request', request => paths.push(new URL(request.url()).pathname));
  await page.goto(origin+'/admin/dashboard');
  await expect(page.locator('#adminNavigation .fa-gauge')).toBeVisible();
  await expect(page.getByRole('link',{name:'Join Now'})).toHaveAttribute('href','https://discord.gg/n6uDZTJ7QR');
  expect(paths).not.toContain('/api/admin/pages');
  await expect(page.locator('#breadcrumbs')).toHaveText(/Administration.*Dashboard/);await expect(page.locator('#breadcrumbs')).not.toContainText('Documentation');
  const card=page.locator('.dashboard-metric').first(),icon=await card.locator('.dashboard-metric-icon').boundingBox(),label=await card.locator('.dashboard-metric-label').boundingBox();expect(icon.x).toBeGreaterThan(label.x+label.width);
  await page.goto(origin+'/admin/pages');await expect(page.locator('#breadcrumbs')).toContainText('Documentation');
});
test('maintenance content supports separate languages in WIP settings',async({page})=>{
  await page.goto(origin+'/admin/wip');
  await expect(page.locator('#wipContentEditor')).toBeVisible();
  await page.locator('#wipContentEditor').fill('Maintenance in English');
  await page.locator('#wipLanguage').selectOption('es');await page.locator('#wipContentEditor').fill('Mantenimiento en español');
  const saved=page.waitForRequest(request=>request.url().endsWith('/api/admin/settings')&&request.method()==='PUT');
  await page.locator('#saveSettings').click();const body=(await saved).postDataJSON();expect(body.wipContent.en).toContain('Maintenance in English');expect(body.wipContent.es).toContain('Mantenimiento en español');
});
test('WIP articles display maintenance content and hide article reactions',async({page})=>{
  await page.route('**/api/pages',route=>route.fulfill({json:{pages:[{id:1,slug:'home',titles:{en:'Home'}}],categories:[],homePageSlug:'home',page:{id:1,slug:'home',titles:{en:'Home'},content:{en:'<h1>Under maintenance</h1>'},is_wip:1,tags:[]},reactions:[]}}));
  await page.goto(origin);await expect(page.locator('#article h1')).toHaveText('Under maintenance');await expect(page.locator('#reactions')).toBeHidden();
});
test('tags remain available on an article without headings or editing metadata',async({page})=>{
  await page.route('**/api/pages',route=>route.fulfill({json:{pages:[{id:1,slug:'home',titles:{en:'Home'}}],categories:[],homePageSlug:'home',page:{id:1,slug:'home',titles:{en:'Home'},content:{en:'<p>A plain article.</p>'},tags:['Guide']},reactions:[]}}));
  await page.goto(origin);await expect(page.locator('#toc')).toBeVisible();await expect(page.locator('#tocLinks')).toBeHidden();await expect(page.locator('[data-article-tag="Guide"]')).toBeVisible();
});
test('search controls follow the selected interface language',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('wiki-language','es'));
  await page.goto(origin);await expect(page.locator('#searchTrigger')).toHaveText('Documentación');await page.locator('#searchTrigger').click();await expect(page.getByRole('dialog',{name:'Buscar documentación'})).toBeVisible();await expect(page.locator('#closeArticleSearch')).toHaveAttribute('aria-label','Cerrar buscador');
});
test('empty search does not select an article that is not displayed',async({page})=>{
  await page.goto(origin);await page.keyboard.press('Control+k');await expect(page.locator('.search-empty')).toContainText('Start typing to search.');await page.locator('#searchInput').press('Enter');await expect(page.locator('#searchDialog')).toBeVisible();await expect(page).toHaveURL(origin+'/');
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`updated editor pairs fields and previews content at ${width}px in ${theme}`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.addInitScript(theme => localStorage.setItem('wiki-theme',theme), theme);
    await page.goto(origin+'/admin/pages');
    await page.locator('#newPage').click();
    await expect(page.locator('#editLanguage option').first()).toHaveText('English');
    const language = await page.locator('#editLanguage').boundingBox();
    const title = await page.locator('#editTitle').boundingBox();
    expect(Math.abs(language.y-title.y)).toBeLessThan(2);
    expect(title.x).toBeGreaterThan(language.x);
    await page.locator('#editTitle').fill('Editor preview');
    await expect(page.locator('#editorHeading')).toHaveText('Create new page: Editor preview');
    await page.locator('#editIconFields [data-brand-pick]').click();
    await expect(page.locator('.brand-icon-grid button')).toHaveCount(20);
    await page.locator('[data-icon-name="book-open"]').click();
    await expect(page.locator('#editIconIcon')).toHaveValue('fa-solid fa-book-open');
    await page.locator('#editIconMode').selectOption('none');
    await expect(page.locator('#editIconFields [data-brand-disabled]')).toBeDisabled();
    await expect(page.locator('#editIconFields [data-brand-preview]')).toBeHidden();
    await page.locator('#editContent').fill('Previewed content');
    await page.locator('#editTags').fill('Preview tag');
    await page.locator('#addPageTag').click();
    await expect(page.locator('#articleTags')).toContainText('Preview tag');
    await page.locator('#previewPage').click();
    await expect(page.frameLocator('.editor-preview-frame').locator('article')).toContainText('Previewed content');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-popup')).toBeHidden();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    if (width === 1440) {
      const heading = await page.locator('#tocTitle').boundingBox();
      expect(heading.y).toBeLessThan(110);
    }
    await page.locator('#editTitle').scrollIntoViewIfNeeded();
    await page.screenshot({path:`C:/Users/nzoue/AppData/Local/Temp/txwiki-update9-${width}-${theme}.png`,fullPage:true});
  });
}

test('header link editor retains translated titles and supports optional icons', async ({page}) => {
  let saved;
  await page.route('**/api/admin/header-links', route => {
    if(route.request().method()==='GET')return route.fulfill({json:{links:[]}});
    saved=route.request().postDataJSON();
    return route.fulfill({json:{links:[{id:'11111111-1111-1111-1111-111111111111',...saved}]}});
  });
  await page.goto(origin+'/admin/header-links');
  await page.getByRole('button',{name:'Add link',exact:true}).click();
  await expect(page.locator('#navigationBrandMode option')).toHaveCount(2);
  await expect(page.locator('#navigationBrandMode')).toHaveValue('none');
  await page.locator('#navigationTitle').fill('Help');
  await page.locator('#navigationLanguage').selectOption('es');
  await page.locator('#navigationTitle').fill('Ayuda');
  await page.locator('#navigationLanguage').selectOption('en');
  await expect(page.locator('#navigationTitle')).toHaveValue('Help');
  await page.locator('#navigationBrandMode').selectOption('icon');
  await page.locator('#navigationBrandFields [data-brand-pick]').click();
  await expect(page.locator('.brand-icon-grid button')).toHaveCount(20);
  await page.locator('[data-icon-name="link"]').click();
  await page.locator('#navigationRoute').fill('https://example.test/help');
  await page.locator('.swal2-confirm').click();
  await expect(page.locator('#headerLinkRows')).toContainText('Help');
  expect(saved.titles).toEqual({en:'Help',es:'Ayuda'});
  expect(saved.icon).toBe('fa-solid fa-link');
  await page.goto(origin);
  await page.evaluate(() => {
    state.config.headerLinks = [{url:'https://example.test/help',titles:{en:'Help'},icon:'fa-solid fa-link',external:true}];
    renderHeaderLinks();
  });
  const headerLink = page.locator('#headerLinks a').first();
  expect(await headerLink.evaluate(element => element.firstChild.tagName)).toBe('I');
  expect(await headerLink.evaluate(element => parseFloat(getComputedStyle(element).columnGap))).toBeGreaterThanOrEqual(6);
});

test('installed updates paginate five at a time and keep the current version', async ({page})=>{
  await page.route('**/api/admin/updates*', route => {
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/latest'))return route.fulfill({json:{available:false,latestVersion:'1.7.8'}});
    const current=Number(url.searchParams.get('page')||1);
    return route.fulfill({json:{configured:true,currentVersion:'1.7.8',page:current,totalPages:3,updates:Array.from({length:current===3?2:5},(_,i)=>({release_version:`1.7.${13-(current-1)*5-i}`,update_id:`update-${(current-1)*5+i}`,applied_at:'2026-11-27T12:00:00Z'}))}});
  });
  await page.goto(origin+'/admin/updates');
  await expect(page.locator('.update-history-row')).toHaveCount(5);
  await page.locator('.update-history-pagination').getByRole('button',{name:'Next',exact:true}).click();
  await expect(page.locator('.update-history-row').first()).toContainText('1.7.8');
  await page.locator('.update-history-pagination').getByRole('button',{name:'Last',exact:true}).click();
  await expect(page.locator('.update-history-row')).toHaveCount(2);
  await expect(page.locator('#updateVersionBadge')).toContainText('1.7.8');
  await expect(page.locator('.update-install-section')).not.toContainText('The ZIP SSH key must match');
});

test('space dialogs keep localized names and validate shared slugs', async ({page}) => {
  const spaces=[{slug:'main',name:'Documentation',titles:{en:'Documentation'},icon:'fa-solid fa-book-open'}];
  await page.route('**/api/config',route=>route.fulfill({json:{site:{name:'Wiki'},spaces,languages:['en','es'],languageCatalog:[],captcha:{enabled:false},headerLinks:[]}}));
  let saved;
  await page.route('**/api/admin/spaces',route=>{
    saved=route.request().postDataJSON();
    spaces.push({...saved,name:saved.titles.en});
    return route.fulfill({json:{ok:true}});
  });
  await page.goto(origin+'/admin/spaces');
  await page.getByRole('button',{name:'Add space',exact:true}).click();
  await page.locator('#navigationTitle').fill('API guide');
  await page.locator('#navigationLanguage').selectOption('es');
  await page.locator('#navigationTitle').fill('Guía API');
  await page.locator('#navigationRoute').fill('api guide');
  await expect(page.locator('#navigationRoute')).toHaveValue('api-guide');
  await page.locator('#navigationRoute').fill('bad/route');
  await page.locator('.swal2-confirm').click();
  expect(saved).toBeUndefined();
  await page.locator('#navigationRoute').fill('api-guide');
  await page.locator('#navigationBrandMode').selectOption('icon');
  await page.locator('#navigationBrandFields [data-brand-pick]').click();
  await expect(page.getByRole('heading',{name:'Choose icon',exact:true})).toBeVisible();
  await page.locator('.swal2-cancel').click();
  await expect(page.locator('#navigationTitle')).toHaveValue('Guía API');
  await expect(page.locator('#navigationRoute')).toHaveValue('api-guide');
  await page.locator('#navigationBrandFields [data-brand-pick]').click();
  await page.locator('[data-icon-name="book"]').click();
  await expect(page.getByRole('heading',{name:'Add space',exact:true})).toBeVisible();
  await page.locator('.swal2-confirm').click();
  await expect(page.locator('#spaceRows .navigation-row')).toHaveCount(2);
  expect(saved.titles).toEqual({en:'API guide',es:'Guía API'});
  expect(saved.icon).toBe('fa-solid fa-book');
  await page.goto(origin);
  await page.locator('#spaceDropdownButton').click();
  await expect(page.locator('#spaceDropdownMenu .space-option')).toHaveCount(2);
  await expect(page.locator('#spaceDropdownMenu small')).toHaveCount(0);
  const trigger=await page.locator('#spaceDropdownButton').boundingBox();
  const menu=await page.locator('#spaceDropdownMenu').boundingBox();
  expect(menu.y-trigger.y-trigger.height).toBeLessThan(12);
});

test('SMTP can be disabled without configuration and backup retention accepts zero',async({page})=>{
  let smtpSaved, backupSaved;
  await page.route('**/api/admin/smtp',route=>{
    if(route.request().method()==='PUT')smtpSaved=route.request().postDataJSON();
    return route.fulfill({json:{smtp:{enabled:smtpSaved?.enabled!==false,host:'smtp.example.test',port:587,user:'sender',from:'wiki@example.test',secure:false}}});
  });
  await page.route('**/api/admin/backups',route=>route.fulfill({json:{backups:[],permissions:{schedule:true},retention:5,cron:'0 2 * * *',timeZone:'UTC'}}));
  await page.route('**/api/admin/backups/schedule',route=>{
    backupSaved=route.request().postDataJSON();return route.fulfill({json:{ok:true}});
  });
  await page.goto(origin+'/admin/smtp');
  await expect(page.locator('#smtpHost')).toBeVisible();
  await page.locator('#smtpEnabled').uncheck();
  await expect(page.locator('#smtpHost')).toBeHidden();
  const toggle = await page.locator('.smtp-settings > .admin-switch-row').boundingBox();
  const saveButton = await page.locator('#saveSmtp').boundingBox();
  expect(saveButton.y).toBeGreaterThanOrEqual(toggle.y + toggle.height);
  expect(Math.abs(saveButton.x - toggle.x)).toBeLessThan(2);
  await page.locator('#saveSmtp').click();
  await expect.poll(()=>smtpSaved).toEqual({enabled:false});
  await page.goto(origin+'/admin/backups');
  await expect(page.locator('#backupTimeZone')).toHaveCount(0);
  await page.locator('#backupRetention').fill('0');
  await page.getByRole('button',{name:'Save schedule',exact:true}).click();
  await expect.poll(()=>backupSaved?.retention).toBe(0);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`Captcha toggles its settings with an aligned save button at ${width}px in ${theme}`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.addInitScript(theme=>localStorage.setItem('wiki-theme',theme),theme);
    let saved;
    await page.route('**/api/admin/captcha',route=>{
      if(route.request().method()==='PUT')saved=route.request().postDataJSON();
      return route.fulfill({json:{captcha:{enabled:false,provider:'recaptcha',variant:'v3',siteKey:'test-site-key',secretConfigured:true,minScore:0.5,...saved}}});
    });
    await page.goto(origin+'/admin/captcha');
    await expect(page.locator('#captchaProvider')).toBeHidden();
    await expect(page.locator('#captchaSiteKey')).toBeHidden();
    const row=page.locator('.captcha-settings > .admin-switch-row');
    await expect(row).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
    await expect(row).toHaveCSS('border-top-width','0px');
    const switchBox=await row.boundingBox(),button=await page.locator('#saveCaptcha').boundingBox();
    expect(button.y).toBeGreaterThanOrEqual(switchBox.y+switchBox.height);
    expect(Math.abs(button.x-switchBox.x)).toBeLessThan(2);
    await page.locator('#captchaEnabled').check();
    await expect(page.locator('#captchaProvider')).toBeVisible();
    await expect(page.locator('#captchaSiteKey')).toHaveValue('test-site-key');
    await expect(page.locator('#captchaScore')).toBeVisible();
    await page.locator('#captchaProvider').selectOption('turnstile');
    await expect(page.locator('#captchaScore')).toBeHidden();
    await page.locator('#captchaEnabled').uncheck();
    await expect(page.locator('.captcha-settings .settings-group:visible')).toHaveCount(0);
    await page.locator('#saveCaptcha').click();
    await expect.poll(()=>saved?.enabled).toBe(false);
    expect(saved.siteKey).toBe('test-site-key');
    await page.locator('#captchaEnabled').check();
    await expect(page.locator('#captchaProvider')).toHaveValue('turnstile');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  });
}
