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
    for (const width of [390, 1440]) {
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
      const pending = [];
      const sockets = new Map();
      const update = (sessionId, text) => sockets.get(sessionId).send(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update', params: { sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      }));
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
        const q = JSON.parse(String(message));
        if (!q.method || q.id == null) return;
        if (q.method === 'session/prompt') { pending.push({ ws, q }); return; }
        let result = {};
        if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
        if (q.method === 'session/load') {
          sockets.set(q.params.sessionId, ws);
          update(q.params.sessionId, 'Existing answer');
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
      }));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [], failed = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
      await page.goto(`${base}/chat?s=E2E%3A%3Aolder`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
      const row = page.locator('.session-row[data-session-id="older"]');
      async function directory() {
        if (width < 800 && !await row.isVisible()) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
        if (width >= 800 && !await row.isVisible()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      }
      await directory();
      assert.equal(await page.locator('.row-status.completed').count(), 0, 'replay is not completion');
      await row.locator('.session-open').click();
      await page.locator('.chat-view:visible textarea').fill('Complete this test turn');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.waitForFunction(() => window.__session.activeRuntime.isLoading);
      await directory();
      await page.locator('.session-row[data-session-id="newer"] .session-open').click();
      update('older', 'Intermediate progress');
      await directory();
      await row.locator('.row-status.working').waitFor();
      assert.equal(await row.locator('.row-status.completed').count(), 0, 'intermediate output is not completion');
      assert.equal(pending.length, 1);
      const { ws, q } = pending.shift();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { stopReason: 'end_turn' } }));
      const completed = row.locator('.row-status.completed');
      await completed.waitFor();
      assert.equal(await completed.textContent(), '✓ Completed');
      assert.equal(await completed.evaluate(e => getComputedStyle(e).color), 'rgb(129, 201, 155)');
      if (width >= 800) await page.locator('.tab-completed').waitFor();
      await page.screenshot({ path: `/tmp/acp-session-completion-${width}.png`, fullPage: true });
      await row.locator('.session-open').click();
      await directory();
      await completed.waitFor();
      assert.equal(await row.locator('.row-status.unread').count(), 0, 'reading does not erase completion');
      // Exercise a subsequent prompt and its cancelled outcome through the actual runtime/ACP client.
      await row.locator('.session-open').click();
      await page.locator('.chat-view:visible textarea').fill('Next turn');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await directory();
      await row.locator('.row-status.working').waitFor();
      assert.equal(await completed.count(), 0, 'new work resets completion');
      const cancelled = pending.shift();
      cancelled.ws.send(JSON.stringify({ jsonrpc: '2.0', id: cancelled.q.id, result: { stopReason: 'cancelled' } }));
      await page.waitForFunction(() => window.__session.openTabs.every(t => !t.isLoading));
      assert.equal(await completed.count(), 0, 'cancellation is not completion');
      assert.equal(await page.locator('.session-row[data-session-id="newer"] .row-status.completed').count(), 0, 'other session stays independent');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
      await directory();
      assert.equal(await page.locator('.row-status.completed').count(), 0, 'restored history has no false completion');
      assert.deepEqual(errors, []);
      assert.deepEqual(failed, []);
      console.log(`PASS ${width}px: replay, intermediate output, background completion, green computed style, reading, restart, cancellation, reload, session isolation`);
      await context.close();
    }
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
