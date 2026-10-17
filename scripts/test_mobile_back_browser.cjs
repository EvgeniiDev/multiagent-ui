// Real browser history and shell; isolated state/ACP, no model calls or user writes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  try {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, hasTouch: width < 800 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', r => r.fulfill({ json: r.request().url().includes('/api/state/') ? { rev: 1, updatedAt: Date.now(), data: {} } : { projects: [], cards: [], sessions: [] } }));
      await page.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(raw => {
        const q = JSON.parse(String(raw));
        if (q.id != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: q.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { sessions: [] } }));
      }));
      const base = process.env.UI_TEST_URL || 'https://192.168.1.222:25809';
      if (process.env.BUILD) await page.route('**/*', r => {
        const u = new URL(r.request().url());
        if (u.origin === new URL(base).origin && (['/chat','/projects','/board','/dashboard'].includes(u.pathname) || u.pathname.startsWith('/assets/'))) {
          const file = path.join(process.env.BUILD, u.pathname.startsWith('/assets/') ? u.pathname : 'index.html');
          return r.fulfill({ path: file, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        }
        return r.fallback();
      });
      await page.route('**/back-test-previous', r => r.fulfill({ contentType: 'text/html', body: '<button>Previous document</button>' }));
      await page.goto(base + '/back-test-previous');
      await page.goto(base + '/chat', { waitUntil: 'domcontentloaded' });
      const sidebar = page.locator('#app-sidebar');
      const menu = page.getByRole('button', { name: /Open menu|Expand sidebar/ }).first();
      await sidebar.locator('h1').waitFor({ state: 'attached' });
      if (width < 800) {
        await menu.click();
        await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click();
        const initialLength = await page.evaluate(() => history.length);
        for (let i = 0; i < 3; i++) {
          await page.setViewportSize({ width: 1440, height: 844 });
          await page.waitForTimeout(50);
          await page.setViewportSize({ width, height: 844 });
          await page.waitForTimeout(50);
        }
        assert.equal(await page.evaluate(() => history.length), initialLength, 'orientation/layout changes do not grow history');
        await page.goBack();
        await sidebar.waitFor({ state: 'visible', timeout: 3000 });
        assert.equal(new URL(page.url()).pathname, '/chat', 'Back opens the menu without leaving the page');
        await sidebar.getByRole('button', { name: 'Projects', exact: true }).click();
        await page.waitForURL('**/projects');
        await sidebar.waitFor({ state: 'hidden' });
        await page.goBack();
        await sidebar.waitFor({ state: 'visible' });
        assert.equal(new URL(page.url()).pathname, '/projects', 'Back from a section opens its menu instead of restoring an old chat');
        assert.equal(await sidebar.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-current'), 'page', 'rendered section matches the URL after Back');
        assert.equal(await sidebar.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-current'), 'page', 'rendered section matches the URL after Back');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sidebar.waitFor({ state: 'visible' });
        const length = await page.evaluate(() => history.length);
        for (let i = 0; i < 3; i++) {
          await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click();
          await sidebar.waitFor({ state: 'hidden' });
          await page.goBack();
          await sidebar.waitFor({ state: 'visible' });
        }
        assert.equal(await page.evaluate(() => history.length), length, 'repeated menu use and reload do not grow history');
        await page.goForward();
        await sidebar.waitFor({ state: 'hidden' });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sidebar.waitFor({ state: 'hidden' });
        await page.goBack();
        await sidebar.waitFor({ state: 'visible' });
        await page.goBack();
      } else {
        await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click();
        await page.goBack();
      }
      await page.getByRole('button', { name: 'Previous document' }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: system Back, menu, section, reload, Forward, bounded history, exit`);
      await context.close();
    }
    // Exercise real History + URL helpers across delayed session URL writes.
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage();
    const fs = require('node:fs'), ts = require('typescript');
    await p.route('https://menu-history.test/**', r => {
      const file = new URL(r.request().url()).pathname.slice(1);
      if (['mobileMenuHistory.js', 'sessionUrl.js', 'viewUrl.js', 'platform.js'].includes(file)) {
        const source = fs.readFileSync(path.join(__dirname, '../src/lib', file.replace('.js', '.ts')), 'utf8');
        const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.js'");
        return r.fulfill({ contentType: 'text/javascript', body: code });
      }
      return r.fulfill({ contentType: 'text/html', body: '<button>Activate history</button>' });
    });
    await p.goto('https://menu-history.test/chat?s=pi::old');
    await p.getByRole('button').click();
    await p.evaluate(async () => {
      const { createMobileMenuHistory } = await import('/mobileMenuHistory.js');
      window.qa = { enabled: true, open: false, normalPops: [] };
      qa.controller = createMobileMenuHistory({ enabled: () => qa.enabled, isOpen: () => qa.open, setOpen: open => { qa.open = open; } });
      // App installs the controller before creating stores and route listeners.
      window.addEventListener('popstate', () => qa.normalPops.push(location.pathname));
      qa.controller.sync();
      // A tab is activated first, then session/new resolves asynchronously.
      qa.controller.sync();
      await new Promise(resolve => setTimeout(resolve, 30));
      const { setSessionInUrl } = await import('/sessionUrl.js');
      setSessionInUrl('pi', 'new');
      history.back();
    });
    await p.waitForFunction(() => qa.open);
    assert.equal(new URL(p.url()).searchParams.get('s'), 'pi::new', 'Back retains the newly created session URL');
    assert.equal(await p.evaluate(() => qa.normalPops.length), 0, 'opening the menu does not replay an old session: ' + JSON.stringify(await p.evaluate(() => ({pops:qa.normalPops,state:history.state}))));
    await p.evaluate(async () => {
      const { setSessionInUrl } = await import('/sessionUrl.js');
      setSessionInUrl('pi', 'new-while-menu-open');
      history.forward();
    });
    await p.waitForFunction(() => !qa.open);
    assert.equal(new URL(p.url()).searchParams.get('s'), 'pi::new-while-menu-open', 'Forward retains session created while menu was open');
    await p.evaluate(() => { qa.enabled = false; qa.controller.sync(); });
    await p.setViewportSize({ width: 1440, height: 844 });
    await p.evaluate(async () => { const { setViewInUrl } = await import('/viewUrl.js'); setViewInUrl('projects'); });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.evaluate(() => { qa.enabled = true; qa.controller.sync(); history.back(); });
    await p.waitForFunction(() => qa.open);
    assert.equal(new URL(p.url()).pathname, '/projects', 'Back after desktop navigation reveals the current menu');
    await p.evaluate(() => history.back());
    await p.waitForFunction(() => qa.normalPops.includes('/chat'));
    assert.equal(new URL(p.url()).pathname, '/chat', 'older desktop navigation remains owned by route handlers');
    await p.evaluate(() => qa.controller.dispose());
    await c.close();
    console.log('PASS delayed session URL, no old-session replay, desktop navigation between mobile layouts');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
