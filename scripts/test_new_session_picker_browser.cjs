// Regression: background ACP tool calls must preserve the new-session folder browser.
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
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, hasTouch: width < 800, isMobile: width < 800 });
      await context.addInitScript(() => {
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { E2E: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [{ id: 'e2e', agentName: 'E2E', sessionId: 'e2e', cwd: '/tmp', title: 'Picker regression', supportsLoadSession: true, lastUpdated: Date.now() }], openTabs: [{ agentName: 'E2E', sessionId: 'e2e' }] }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ lastCwd: '/tmp' }));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [], failedHttp = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failedHttp.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await page.route('**/api/**', r => {
        const url = new URL(r.request().url());
        let data = {};
        if (url.pathname.endsWith('/fs/root')) data = { root: '/tmp' };
        else if (url.pathname.endsWith('/fs/list')) {
          const current = url.searchParams.get('path') || '/tmp';
          data = { root: '/tmp', path: current, parent: current === '/tmp' ? '' : '/tmp', dirs: current === '/tmp' ? [{ name: 'projects', path: '/tmp/projects' }] : [] };
        } else if (url.pathname.includes('/api/state/')) data = { rev: 1, updatedAt: Date.now(), data: {} };
        else data = { projects: [], sessions: [], cards: [] };
        return r.fulfill({ json: data });
      });
      let socket;
      const update = update => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'e2e', update } }));
      await page.routeWebSocket(/wss?:\/\//, ws => {
        ws.onMessage(message => {
          for (const line of String(message).split('\n')) {
            let q; try { q = JSON.parse(line); } catch { continue; }
            if (!q.method || q.id == null) continue;
            let result = {};
            if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
            if (q.method === 'session/list') result = { sessions: [] };
            if (q.method === 'session/load') {
              socket = ws;
              update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Background transcript\n\n'.repeat(150) } });
            }
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
          }
        });
      });
      await page.goto(`${base}/chat?s=E2E%3A%3Ae2e`, { waitUntil: 'domcontentloaded' });
      await page.locator('.chat-view:visible .messages').getByText('Background transcript', { exact: false }).first().waitFor();
      await page.waitForTimeout(300);
      async function openNewSession() {
        const action = page.getByRole('button', { name: 'New session', exact: true });
        if (width < 800 && !await action.isVisible()) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
        await action.click();
      }
      await openNewSession();
      const menu = page.locator(width < 800 ? '.ns-dialog' : '.nsm-menu');
      await menu.getByRole('button', { name: 'Browse directories' }).click();
      await menu.locator('.dir-row').filter({ hasText: 'projects' }).click();
      await page.waitForFunction(() => document.querySelector('.selected-path')?.textContent === '/tmp/projects');
      await menu.locator('.hidden-toggle input').check();
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.pickerScrolls = 0;
        window.addEventListener('scroll', e => {
          if (e.target === document || e.target?.classList?.contains('messages-container')) window.pickerScrolls++;
        }, true);
      });
      for (let i = 0; i < 3; i++) {
        update({ sessionUpdate: 'tool_call', toolCallId: `picker-${i}`, title: `Background tool ${i}`, kind: 'execute', status: 'in_progress' });
        await page.getByText(`Background tool ${i}`, { exact: false }).first().waitFor({ state: 'attached' });
        await page.waitForTimeout(100);
        assert(await menu.isVisible(), 'background tool auto-scroll must not dismiss New session');
        assert(await menu.locator('.tree-overlay').isVisible(), 'folder browser stays open');
        assert.equal(await menu.locator('.selected-path').textContent(), '/tmp/projects', 'browsed folder survives background tools');
        assert(await menu.locator('.hidden-toggle input').isChecked(), 'picker options survive');
      }
      if (width < 800) assert.equal(await page.evaluate(() => window.pickerScrolls), 0, 'covered mobile chat must stay still while the session page owns the screen');
      else assert(await page.evaluate(() => window.pickerScrolls > 0), 'desktop fixture must trigger actual chat auto-scroll');
      await menu.getByRole('button', { name: 'Use this directory', exact: true }).click();
      assert.equal(await menu.locator('.cwd-input').inputValue(), '/tmp/projects');
      await menu.locator('.cwd-input').fill('/tmp/manual-draft');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\nMore streamed text\n'.repeat(30) } });
      await page.waitForTimeout(150);
      assert.equal(await menu.locator('.cwd-input').inputValue(), '/tmp/manual-draft', 'typed path survives streamed text');
      await page.keyboard.press('Escape');
      assert(!await menu.isVisible(), 'Escape still closes the menu');
      await openNewSession();
      await page.mouse.click(width - 8, 500);
      assert(!await menu.isVisible(), 'outside click still closes the menu');
      if (width < 800) {
        await page.locator('.session-row[data-session-id="e2e"] .session-open').click();
        await page.getByText('Background tool 2', { exact: false }).first().waitFor();
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(failedHttp, []);
      console.log(`PASS ${width}px: background tool calls, real auto-scroll, preserved folder/options/draft, Escape, outside click`);
      await context.close();
    }
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
