// Real UI with deterministic ACP/state boundaries; never calls a model.
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
        const name = new URL(req.url, 'http://localhost').pathname;
        const file = path.join(process.env.BUILD, name.startsWith('/assets/') ? name : 'index.html');
        res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream');
        try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
    for (const width of [320, 390, 780, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: width < 800, isMobile: width < 800, viewport: { width, height: 844 } });
      await context.addInitScript(() => {
        if (sessionStorage.getItem('sessions-fixture')) return;
        sessionStorage.setItem('sessions-fixture', '1');
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { E2E: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: ['older', 'newer'].map((id, i) => ({ id, sessionId: id, agentName: 'E2E', cwd: '/tmp', title: id, lastUpdated: 1700000000000 + i * 60000, supportsLoadSession: true })), openTabs: ['older', 'newer'].map(sessionId => ({ agentName: 'E2E', sessionId })) }));
      });
      await context.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await context.route('**/api/**', r => r.fulfill({ json: { root: '/tmp', dirs: [], projects: [], sessions: [], cards: [] } }));
      let liveSocket;
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
        const q = JSON.parse(String(message));
        if (!q.method || q.id == null) return;
        if (q.method === 'session/new') {
          setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'Test creation failure' } })), 600);
          return;
        }
        let result = {};
        if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }, authMethods: [] };
        if (q.method === 'session/list') result = { sessions: ['older', 'newer'].map((sessionId, i) => ({ sessionId, title: sessionId, cwd: '/tmp', updatedAt: new Date(1700000000000 + i * 60000).toISOString() })) };
        if (q.method === 'session/load') {
          if (q.params.sessionId === 'older') liveSocket = ws;
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: q.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Existing answer\n\n'.repeat(60) } } } }));
        }
        setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result })), 30);
      }));
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [], failed = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
      await page.goto(`${base}/chat?s=E2E%3A%3Aolder`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
      const field = page.locator('.chat-view:visible textarea');
      await field.fill('Preserved draft');
      await page.evaluate(() => scrollTo(0, 600));
      await page.waitForTimeout(150);
      const historyTop = await page.evaluate(() => scrollY);
      const menu = page.getByRole('button', { name: 'Open menu', exact: true });
      if (width < 800) {
        assert.equal(await page.locator('.tab-strip').count(), 0, 'mobile has no top session tabs');
        assert.equal(await page.locator('.session-navigation [aria-label="New session"]').count(), 0, 'mobile creation is available through the session list');
        await menu.click();
        const sidebar = page.locator('#app-sidebar');
        await sidebar.waitFor();
        const rect = await sidebar.boundingBox();
        assert.equal(Math.round(rect.width), width, 'session page fills the viewport');
        assert.equal(rect.x, 0);
        assert(await page.locator('.main-area').evaluate(e => e.inert), 'covered chat cannot receive focus');
        assert.equal(await page.locator('.drawer-backdrop').isVisible(), false);
        assert.deepEqual(await page.locator('.row-title').allTextContents(), ['newer', 'older'], 'opening and replay preserve message ordering');
        await page.evaluate(() => {
          const rt = window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer');
          rt.isLoading = true;
        });
        await page.locator('.session-row').filter({ hasText: 'newer' }).locator('.row-status.working').waitFor();
        await page.evaluate(() => {
          const rt = window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer');
          rt.error = 'Test connection failure';
        });
        assert.equal(await page.locator('.row-status.error').getAttribute('title'), 'Test connection failure');
        await page.evaluate(() => { const rt = window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer'); rt.error = null; rt.isLoading = false; rt.unread = true; });
        assert.equal(await page.locator('.row-status.unread').innerText(), 'Unread reply');
        liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'older', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A fresh reply' } } } }));
        await page.waitForFunction(() => document.querySelector('.row-title')?.textContent === 'older');
        if (width === 390) {
          // Continuous output must neither reshuffle every chunk nor defer forever.
          const started = Date.now();
          for (let burst = 0; burst < 6; burst++) {
            await page.evaluate(() => {
              const session = window.__session.savedSessions.find(s => s.id === 'newer');
              session.lastUpdated = session.lastMessageAt = Date.now();
              window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer').isLoading = true;
            });
            await page.waitForTimeout(500);
            assert.equal(await page.locator('.row-title').first().innerText(), 'older', 'streaming cannot immediately move rows');
            assert(await page.locator('.session-row').filter({ hasText: 'newer' }).locator('.row-status.working').isVisible(), 'statuses stay live while ordering waits');
          }
          await page.waitForFunction(() => document.querySelector('.row-title')?.textContent === 'newer', null, { timeout: 3000 });
          assert(Date.now() - started < 6500, 'continuous output is sorted within the next five-second window');
          await page.evaluate(() => {
            const session = window.__session.savedSessions.find(s => s.id === 'older');
            session.lastUpdated = session.lastMessageAt = Date.now();
            window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer').isLoading = false;
          });
          await page.waitForTimeout(500);
          assert.equal(await page.locator('.row-title').first().innerText(), 'newer', 'a second reorder cannot occur inside five seconds');
          await page.waitForFunction(() => document.querySelector('.row-title')?.textContent === 'older');
        }
        await page.getByRole('button', { name: 'Load sessions from all agents', exact: true }).click();
        await page.waitForFunction(() => !window.__session.isSyncingSessions);
        assert.equal(await page.locator('.row-title').first().innerText(), 'older', 'stale inventory cannot override a fresh message');
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('acp-ui:sessions.json')).sessions.find(s => s.id === 'older').lastMessageAt > 1700000060000);
        for (const theme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: theme });
          const close = page.getByRole('button', { name: 'Close session', exact: true }).first();
          const box = await close.boundingBox();
          assert(box.width >= 44 && box.height >= 44);
          const glyph = close.locator('svg');
          assert.equal(await glyph.count(), 1, 'close uses a readable icon rather than a tiny text glyph');
          const glyphBox = await glyph.boundingBox();
          assert.equal(glyphBox.width, 18, 'close icon stays compact');
          assert.equal(glyphBox.height, 18, 'close icon stays compact');
          await close.focus();
          await page.keyboard.press('Tab');
          await close.focus();
          assert.equal(await close.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
          const refresh = page.getByRole('button', { name: 'Load sessions from all agents', exact: true });
          await page.evaluate(() => { window.__session.isSyncingSessions = true; });
          assert(await refresh.isDisabled());
          assert.equal(await refresh.evaluate(e => getComputedStyle(e).opacity), '0.5');
          await page.evaluate(() => { window.__session.isSyncingSessions = false; });
        }
        await page.screenshot({ path: `/tmp/acp-sessions-page-${width}.png` });
        await page.locator('.session-row').filter({ hasText: 'newer' }).locator('.row-title').click();
        await page.waitForFunction(() => window.__session.activeRuntime.descriptor.sessionId === 'newer');
        assert(!await sidebar.isVisible());
        await page.locator('.chat-view:visible textarea').fill('Other draft');
        await menu.click();
        await page.locator('.session-row').filter({ hasText: 'older' }).locator('.row-title').click();
        assert.equal(await field.inputValue(), 'Preserved draft');
        await page.waitForTimeout(150);
        assert(Math.abs(await page.evaluate(() => scrollY) - historyTop) <= 2, 'returning through the sessions page restores history position');
        await page.goBack();
        await sidebar.waitFor();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sidebar.waitFor();
        await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
        assert.equal(Math.round((await sidebar.boundingBox()).width), width, 'session page survives reload');
        await page.getByRole('button', { name: 'Close session', exact: true }).first().click({ position: { x: 4, y: 4 } });
        assert(await sidebar.isVisible(), 'tapping the edge of close does not open the session row');
        assert.equal(await page.locator('.session-row').count(), 2, 'closing keeps history in the list');
        assert.equal(await page.locator('.row-close').count(), 1);
        await page.evaluate(() => { const rt = window.__session.openTabs[0]; rt.session.supportsLoadSession = false; });
        assert.equal(await page.locator('.row-close').count(), 1, 'an open session without load support stays reachable');
        await page.evaluate(() => { window.qaCreation = window.__session.createSession('E2E', '/tmp').catch(() => {}); });
        const creating = page.locator('.session-row').filter({ hasText: 'New session' });
        await creating.locator('.row-status.working').waitFor();
        await creating.locator('.row-status.error').waitFor();
        assert.equal(await creating.locator('.row-status').getAttribute('title'), 'Test creation failure');
        await page.locator('.session-row').filter({ hasText: 'newer' }).locator('.row-title').click();
        await menu.click();
        await creating.locator('.row-title').click();
        assert.equal(await page.locator('.main-area .error-text').innerText(), 'Test creation failure', 'failed new runtime can be opened again');
        await menu.click();
        await creating.getByRole('button', { name: 'Close session', exact: true }).click();
        assert.equal(await creating.count(), 0, 'failed unsaved session remains closable');
        assert(await page.getByRole('button', { name: 'New session', exact: true }).isVisible());
        await page.getByRole('button', { name: 'New session', exact: true }).click();
        await page.locator('.ns-overlay').waitFor();
        await page.locator('.ns-overlay').getByRole('button', { name: 'Cancel', exact: true }).click();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        if (width === 390) {
          await page.evaluate(() => localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [], openTabs: [] })));
          await page.goto(`${base}/projects`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('button', { name: 'Open menu', exact: true }).waitFor();
          await page.waitForTimeout(250);
          assert(!await page.locator('#app-sidebar').isVisible(), 'direct Projects load is not covered by an empty sessions page');
          await page.goto(`${base}/chat`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('button', { name: 'Open menu', exact: true }).waitFor();
          assert.equal(await page.locator('.welcome-new-session').count(), 0, 'empty mobile chat uses the sessions list for creation');
          await page.getByRole('button', { name: 'Open menu', exact: true }).click();
          await page.locator('#app-sidebar').waitFor();
          assert(await page.getByRole('button', { name: 'New session', exact: true }).isVisible(), 'empty sessions page offers creation');
        }
      } else {
        assert.equal(await page.locator('.tab-strip [role="tab"]').count(), 2, 'desktop tabs retained');
        assert.equal(await page.locator('.session-navigation [aria-label="New session"]').count(), 1, 'desktop creation stays in its tab bar');
        assert((await page.locator('#app-sidebar').boundingBox()).width < 600);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(failed, []);
      await context.close();
      console.log(`PASS ${width}: navigation, statuses, message order, drafts, reload, close, layout`);
    }
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
