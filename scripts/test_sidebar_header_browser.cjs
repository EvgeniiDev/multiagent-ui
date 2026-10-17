// Candidate or published UI, isolated local fixtures; no live state writes or model calls.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const base = process.env.UI_TEST_URL || 'https://192.168.1.222:25809';
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox', '--ignore-certificate-errors'] });
  try {
    for (const width of [320, 390, 430, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: width < 800, viewport: { width, height: 844 } });
      await context.addInitScript(() => {
        if (sessionStorage.getItem('sidebar-header-fixture')) return;
        sessionStorage.setItem('sidebar-header-fixture', '1');
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: {} }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
        localStorage.setItem('acp-ui:projects.json', JSON.stringify({ version: 1, activeProjectId: 'all', projects: [
          { id: 'common', name: 'Common', path: '/home/hermes/projects', createdAt: 1 },
          { id: 'alpha', name: 'A project with a longer name', path: '/tmp/sidebar-alpha', createdAt: 1 },
        ] }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ openTabs: [], sessions: [
          { id: 'one', sessionId: 'one', agentName: 'Codex', supportsLoadSession: true, title: 'Проверка работы проекта', cwd: '/tmp/sidebar-alpha', lastUpdated: Date.now() },
          { id: 'two', sessionId: 'two', agentName: 'Pi', supportsLoadSession: true, title: 'Обсуждение следующего шага', cwd: '/tmp/sidebar-alpha', lastUpdated: Date.now() - 10000 },
          { id: 'three', sessionId: 'three', agentName: 'Codex', supportsLoadSession: true, title: 'Общие задачи', cwd: '/tmp/another', lastUpdated: Date.now() - 20000 },
        ] }));
      });
      await context.route('**/health', route => route.fulfill({ json: { ok: false } }));
      await context.route('**/api/**', route => route.fulfill({ json: { root: '/tmp', dirs: [], projects: [], sessions: [], cards: [] } }));
      if (process.env.BUILD) await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(base).origin && (['/', '/chat', '/projects', '/board', '/dashboard'].includes(url.pathname) || url.pathname.startsWith('/assets/'))) {
          const file = path.join(process.env.BUILD, url.pathname.startsWith('/assets/') ? url.pathname : 'index.html');
          return route.fulfill({ path: file, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        }
        return route.fallback();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [], failedResponses = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      await page.goto(base + '/chat', { waitUntil: 'domcontentloaded' });
      const sidebar = page.locator('#app-sidebar');
      async function openMenu() {
        if (!await sidebar.isVisible()) await page.getByRole('button', { name: /Expand sidebar|Open menu/, exact: true }).first().click();
        await sidebar.waitFor();
      }
      await openMenu();
      await sidebar.locator('.session-row').first().waitFor();
      const header = sidebar.locator('.sidebar-header');
      const settings = header.getByRole('button', { name: 'Settings', exact: true });
      assert.equal(await header.locator('.ds-button').count(), 3, 'all header actions use shared buttons');
      const selector = sidebar.getByRole('button', { name: /^Project scope:/ });
      assert.match(await selector.textContent(), /All projects/);
      async function chooseProject(name) {
        await selector.click();
        await page.getByRole('listbox', { name: 'Project scope' }).getByRole('option', { name, exact: true }).click();
      }
      assert.equal(await sidebar.locator('.drawer-project-scope > label:not(.scope-selector)').count(), 0, 'no duplicate Project heading');
      const row = await sidebar.locator('.session-row').first().boundingBox();
      if (width < 800) {
        const nav = sidebar.getByRole('navigation', { name: 'Main views' });
        for (const name of ['Chat', 'Projects', 'Board', 'Dashboard']) {
          const button = nav.getByRole('button', { name, exact: true });
          assert.equal(await button.innerText(), name, 'each navigation icon has its own visible label');
          const rect = await button.boundingBox();
          assert(rect.width >= 44 && rect.height >= 44);
          assert.equal(await button.evaluate(e => getComputedStyle(e).flexDirection), 'column');
        }
        const listHead = await sidebar.locator('.list-head').boundingBox();
        assert(listHead.y < 230 && row.y - listHead.y <= 64, 'sessions start promptly after their 44px touch actions');
        assert((await settings.boundingBox()).height >= 44);
      }
      const bounds = await sidebar.boundingBox();
      for (const control of [header, selector]) {
        const rect = await control.boundingBox();
        assert(rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width, 'header and project controls stay inside sidebar');
      }
      if (width < 800) assert.equal(await sidebar.evaluate(e => e.scrollWidth > e.clientWidth), false, 'mobile drawer has no horizontal overflow');
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        await page.mouse.move(0, 0);
        assert.equal(await settings.evaluate(e => getComputedStyle(e).borderTopColor), 'rgba(0, 0, 0, 0)', 'header actions do not have heavy frames');
        await settings.hover();
        assert.notEqual(await settings.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
      }
      await page.keyboard.press('Tab'); await settings.focus();
      assert.equal(await settings.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
      if (process.env.ARTIFACT_DIR) {
        fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
        await settings.blur(); await page.mouse.move(0, 0);
        await sidebar.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `sidebar-${width}.png`) });
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `sidebar-header-${width}.png`), clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.min(350, bounds.height) } });
      }
      await chooseProject('A project with a longer name');
      await page.waitForFunction(() => document.querySelectorAll('#app-sidebar .session-row').length === 2);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openMenu();
      await page.waitForFunction(() => document.querySelector('#app-sidebar [aria-haspopup="listbox"]')?.textContent.includes('A project with a longer name'));
      await chooseProject('All projects');
      if (width < 800) {
        for (const name of ['Projects', 'Board', 'Dashboard', 'Chat']) {
          await sidebar.getByRole('navigation', { name: 'Main views' }).getByRole('button', { name, exact: true }).click();
          await page.waitForFunction(() => document.querySelector('#app-sidebar').style.display === 'none');
          await openMenu();
          assert.equal(await sidebar.getByRole('navigation', { name: 'Main views' }).getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'page');
        }
      }
      await settings.click();
      await page.locator('.settings-overlay').waitFor();
      await page.keyboard.press('Escape');
      // Close settings through its explicit control if Escape belongs to the shell.
      if (await page.locator('.settings-overlay').isVisible()) await page.locator('.settings-header button').click();
      await openMenu();
      await header.getByRole('button', { name: 'ACP Traffic Monitor', exact: true }).click();
      await page.locator('.traffic-monitor').waitFor();
      assert.deepEqual(errors, []); assert.deepEqual(failedResponses, []);
      console.log(`PASS sidebar ${width}px: labelled navigation, compact layout, shared focus/hover/touch, project filter and persistence, settings and traffic, no JS/HTTP failures`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
