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
      await page.locator('.session-row[data-session-id="newer"] .session-open').click();
      update('older', 'Background output before reading');
      await directory();
      await page.waitForFunction(() => window.__session.openTabs.some(t => t.unread));
      assert.equal(await page.getByText('Unread reply', { exact: true }).count(), 0);
      await row.locator('.session-open').click();
      await directory();
      assert.equal(await page.getByText('Unread reply', { exact: true }).count(), 0);
      assert.equal(await row.locator('.row-status.completed').count(), 0, 'reading output cannot imply completion');
      assert.equal(await page.locator('[title="Unread reply"]').count(), 0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
      await directory();
      assert.equal(await page.getByText('Unread reply', { exact: true }).count(), 0);

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
      await row.locator('.session-open').click();
      await page.getByRole('button', { name: 'Stop response', exact: true }).click();
      await directory();
      const cancelled = pending.shift();
      cancelled.ws.send(JSON.stringify({ jsonrpc: '2.0', id: cancelled.q.id, result: { stopReason: 'cancelled' } }));
      await page.waitForFunction(() => window.__session.openTabs.every(t => !t.isLoading));
      assert.equal(await completed.count(), 0, 'cancellation is not completion');
      const issue = row.locator('.row-status.error');
      await issue.waitFor();
      assert.equal(await issue.textContent(), '× Cancelled');
      assert.equal(await issue.evaluate(e => getComputedStyle(e).color), 'rgb(240, 145, 165)');
      if (width >= 800) await page.locator('.tab-badge.err[aria-label="Cancelled"]').waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
      await directory();
      await issue.waitFor();
      assert.equal(await issue.textContent(), '× Cancelled', 'cancelled state survives reload');

      await row.locator('.session-open').click();
      await directory();
      await issue.waitFor();
      await row.locator('.session-open').click();
      await page.locator('.chat-view:visible textarea').fill('Fail this test turn');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await directory();
      await row.locator('.row-status.working').waitFor();
      assert.equal(await issue.count(), 0, 'new prompt clears cancellation');
      const failing = pending.shift();
      failing.ws.send(JSON.stringify({ jsonrpc: '2.0', id: failing.q.id, error: { code: -32000, message: 'Test turn failed' } }));
      await issue.waitFor();
      assert.equal(await issue.textContent(), 'Error');
      assert.match(await issue.getAttribute('title'), /Test turn failed/);
      assert.equal(await issue.evaluate(e => getComputedStyle(e).color), 'rgb(240, 145, 165)');
      await page.screenshot({ path: `/tmp/acp-session-error-${width}.png`, fullPage: true });
      await row.locator('.session-open').click();
      await page.locator('.chat-view:visible textarea').fill('Retry successfully');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      assert.equal(await page.locator('.chat-view:visible [data-pending-id]').count(), 2, 'failed delivery pauses the new retry');
      assert(await page.getByRole('button', { name: 'Resume queue', exact: true }).isDisabled(), 'uncertain failed delivery cannot automatically retry');
      await page.locator('.chat-view:visible [data-pending-id]').filter({ hasText: 'Fail this test turn' }).getByRole('button', { name: 'Remove pending message', exact: true }).click();
      await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
      await directory();
      await row.locator('.row-status.working').waitFor();
      assert.equal(await issue.count(), 0, 'new prompt clears prior error');
      const retry = pending.shift();
      retry.ws.send(JSON.stringify({ jsonrpc: '2.0', id: retry.q.id, result: { stopReason: 'end_turn' } }));
      await completed.waitFor();
      if (width >= 800) {
        await page.locator('.session-tab').filter({ has: page.locator('.tab-completed') }).locator('.tab-close').click();
        await completed.waitFor();
        assert.equal(await page.locator('.tab-completed').count(), 0, 'closed tab keeps result in session list');
        await row.locator('.session-open').click();
        await page.locator('.tab-completed').waitFor();
        await directory();
        await completed.waitFor();
      }
      assert.equal(await page.locator('.session-row[data-session-id="newer"] .row-status.completed').count(), 0, 'other session stays independent');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
      await directory();
      await row.locator('.row-status.completed').waitFor();
      assert.equal(await page.locator('.row-status.completed').count(), 1, 'confirmed completion survives reload');
      assert.equal(await page.locator('.row-status.error').count(), 0, 'reload has no stale errors');
      assert.deepEqual(errors, []);
      assert.deepEqual(failed, []);
      console.log(`PASS ${width}px: replay, intermediate output, background completion, green/red computed styles, reading, restart, cancellation, RPC error, successful retry, persistent read/close/reopen/reload, session isolation`);
      await context.close();
    }
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
