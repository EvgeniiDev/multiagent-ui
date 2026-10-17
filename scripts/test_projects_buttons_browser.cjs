// Shared project action buttons: computed styles, navigation, focus, and touch sizing.
// BUILD selects a candidate build. UI_TEST_URL optionally checks deployed assets.
// ACP/state/filesystem responses are fixtures; no real agent sessions are started.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  let server, browser;
  try {
    let base = process.env.UI_TEST_URL;
    if (!base) {
      assert(process.env.BUILD, 'Set BUILD or UI_TEST_URL');
      server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost').pathname;
        const file = path.join(process.env.BUILD, ['/', '/chat'].includes(url) ? 'index.html' : url);
        try {
          res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream');
          res.end(fs.readFileSync(file));
        } catch { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 844 }, hasTouch: width < 800 });
      await context.addInitScript(() => {
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { E2E: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [], openTabs: [] }));
        localStorage.setItem('acp-ui:projects.json', JSON.stringify({ version: 1, activeProjectId: 'all', projects: [{ id: 'qa-project', name: 'Button QA', path: '/tmp/button-qa', createdAt: Date.now() }] }));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [], failedHttp = [], rpc = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failedHttp.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await page.route('**/api/**', r => r.fulfill({ json: { root: '/tmp', path: '/tmp', dirs: [], projects: [], sessions: [], cards: [] } }));
      await page.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
        for (const line of String(message).split('\n')) {
          let q; try { q = JSON.parse(line); } catch { continue; }
          if (!q.method || q.id == null) continue;
          rpc.push(q);
          let result = {};
          if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
          if (q.method === 'session/list') result = { sessions: [] };
          if (q.method === 'session/new') result = { sessionId: 'project-button-qa' };
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
        }
      }));
      await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await page.locator('.rail-btn[aria-label="Projects"]').click();
      await page.setViewportSize({ width, height: 844 });
      if (width < 800 && await page.locator('#app-sidebar').isVisible()) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      const row = page.locator('.project-row').filter({ hasText: 'Button QA' });
      await row.click();
      const newProject = page.getByRole('button', { name: 'New project', exact: true });
      const newSession = page.getByRole('button', { name: 'New session', exact: true });
      const scoped = page.getByRole('button', { name: 'New session here', exact: true });
      const appearance = e => {
        const s = getComputedStyle(e);
        return { font: s.fontFamily, fontSize: s.fontSize, weight: s.fontWeight, radius: s.borderRadius, border: s.border, background: s.backgroundColor, color: s.color, padding: s.padding, height: s.height };
      };
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        await page.mouse.move(width - 1, 800);
        const expected = await newSession.evaluate(appearance);
        assert.deepEqual(await newProject.evaluate(appearance), expected, 'New project and New session share appearance');
        assert.deepEqual(await scoped.evaluate(appearance), expected, 'project-scoped action shares appearance');
        for (const button of [newProject, newSession, scoped]) {
          assert(await button.evaluate(e => e.classList.contains('ds-button')), 'action uses shared button');
          await button.hover();
          assert.notEqual(await button.evaluate(e => getComputedStyle(e).backgroundColor), expected.background, 'hover has visible feedback');
          await button.focus();
          await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
          assert.equal(await button.evaluate(e => getComputedStyle(e).outlineWidth), '2px', 'keyboard focus is visible');
          if (width < 800) assert((await button.boundingBox()).height >= 44, 'action is touch-sized');
        }
      }
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `projects-buttons-${width}.png`) });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
      await newProject.click();
      await page.getByRole('dialog', { name: 'New project' }).waitFor();
      await page.locator('.np-cancel').click();
      await newSession.click();
      await page.getByRole('dialog', { name: 'New session' }).waitFor();
      assert(await page.locator('.ns-confirm').isEnabled(), 'configured agent permits starting');
      await page.locator('.ns-cancel').click();
      await page.getByRole('button', { name: 'Close project detail' }).click();
      assert.equal(await page.locator('.project-detail').count(), 0, 'close still dismisses detail');
      await row.click();
      await scoped.click();
      await page.locator('.chat-view:visible').waitFor();
      assert.equal(rpc.filter(q => q.method === 'session/new').length, 1);
      assert.equal(rpc.find(q => q.method === 'session/new').params.cwd, '/tmp/button-qa', 'scoped action preserves project path');
      assert.deepEqual(errors, []);
      assert.deepEqual(failedHttp, []);
      console.log(`PASS ${width}px: consistent action styles, focus, touch, dialogs, close, scoped session`);
      await context.close();
    }
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
