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
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: width < 800, isMobile: width < 800, viewport: { width, height: 844 } });
      await context.addInitScript(() => {
        if (sessionStorage.getItem('sessions-fixture')) return;
        sessionStorage.setItem('sessions-fixture', '1');
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { E2E: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: ['grouping'].map((id, i) => ({ id, sessionId: id, agentName: 'E2E', cwd: '/tmp', title: id, lastUpdated: 1700000000000 + i * 60000, supportsLoadSession: true })), openTabs: ['grouping'].map(sessionId => ({ agentName: 'E2E', sessionId })) }));
      });
      await context.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await context.route('**/api/**', r => r.fulfill({ json: { root: '/tmp', dirs: [], projects: [], sessions: [], cards: [] } }));
      let socket;
      const update = update => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grouping', update } }));
      const text = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      const tool = (prefix, n, status = 'completed') => update({ sessionUpdate: 'tool_call', toolCallId: `${prefix}-${n}`, title: `${prefix} tool ${n}`, kind: 'execute', status, rawInput: { command: `echo ${prefix}-${n}` }, rawOutput: `Output ${prefix}-${n}` });
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
        const q = JSON.parse(String(message));
        if (!q.method || q.id == null) return;
        let result = {};
        if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
        if (q.method === 'session/load') {
          socket = ws;
          text('Before small run');
          for (let n = 1; n <= 3; n++) tool('Small', n);
          text('Between small and large runs');
          for (let n = 1; n <= 4; n++) tool('Large', n, n === 3 ? 'failed' : n === 4 ? 'in_progress' : 'completed');
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
      }));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [], failedHttp = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failedHttp.push(`${r.status()} ${r.url()}`); });
      await page.goto(`${base}/chat?s=E2E%3A%3Agrouping`, { waitUntil: 'domcontentloaded' });
      const chat = page.locator('.chat-view:visible');
      const group = chat.locator('.tool-call-group').first();
      const toggle = group.locator('.tool-group-toggle');
      await toggle.waitFor();
      assert.equal(await chat.locator('.tool-call-wrap').count(), 3, 'three consecutive calls remain visible');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.match(await toggle.textContent(), /Show 4 tool calls/);
      assert.match(await toggle.textContent(), /1 running/);
      assert.match(await toggle.textContent(), /1 failed/);
      assert.equal(await group.locator('.tool-call-wrap').count(), 0, 'collapsed group avoids rendering hidden calls');
      assert(await toggle.evaluate(e => e.classList.contains('ds-button--transcript')));
      await toggle.focus();
      assert.equal(await toggle.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
      await page.keyboard.press('Enter');
      await group.locator('.tool-call-wrap').nth(3).waitFor();
      const targetId = await toggle.getAttribute('aria-controls');
      assert.equal(await group.locator('.tool-group-body').getAttribute('id'), targetId);
      const firstTool = group.getByRole('button', { name: /Large tool 1/ });
      await firstTool.click();
      await group.locator('.tool-args').waitFor();
      assert.match(await group.locator('.tool-args').textContent(), /echo Large-1/);
      assert.match(await group.locator('.tool-args').textContent(), /Output Large-1/);
      tool('Large', 5);
      await group.getByRole('button', { name: /Hide 5 tool calls/ }).waitFor();
      assert.equal(await group.locator('.tool-call-wrap').count(), 5, 'streaming append keeps group expanded');
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'Large-4', status: 'completed' });
      await page.waitForFunction(() => !document.querySelector('.chat-view .tool-group-toggle')?.textContent.includes('running'));
      await toggle.click();
      assert.equal(await group.locator('.tool-call-wrap').count(), 0);
      await page.keyboard.press('Space');
      await group.locator('.tool-args').waitFor();
      assert.match(await group.locator('.tool-args').textContent(), /echo Large-1/, 'individual disclosure survives collapse/reopen');
      text('A text boundary before another run');
      for (let n = 1; n <= 3; n++) tool('Next', n);
      await chat.getByRole('button', { name: /Next tool 3/ }).waitFor();
      assert.equal(await chat.locator('.tool-call-group').count(), 1, 'three live tools do not fold');
      tool('Next', 4);
      await chat.getByRole('button', { name: /Show 4 tool calls/ }).waitFor();
      assert.equal(await chat.locator('.tool-call-group').count(), 2, 'fourth tool folds only its own run');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'other run expansion survives');
      await toggle.click();
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        const styles = await toggle.evaluate(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return { font: s.fontSize, background: s.backgroundColor, height: r.height, width: r.width, viewport: innerWidth }; });
        assert.equal(styles.font, '11px');
        assert(styles.height >= (width < 800 ? 32 : 24));
        assert(styles.width <= styles.viewport);
        await toggle.hover();
        assert.notEqual(await toggle.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
      }
      assert(await chat.getByText('Between small and large runs', { exact: true }).isVisible());
      await page.screenshot({ path: `/tmp/acp-tool-groups-${width}.png`, fullPage: true });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.chat-view:visible .tool-group-toggle[aria-expanded="false"]').waitFor();
      assert.deepEqual(errors, []);
      assert.deepEqual(failedHttp, []);
      console.log(`PASS ${width}px: 3/4 threshold, history, keyboard, all calls/args/output, streaming, status summary, independent groups, collapse/reopen, themes, reload`);
      await context.close();
    }
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
