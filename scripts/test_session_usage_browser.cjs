// Mocked ACP/state isolate the session UI; LIVE_LIMITS=1 reads the real quota API.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: width < 800, isMobile: width < 800, viewport: { width, height: 844 } });
      await context.grantPermissions(['local-network-access']);
      await context.addInitScript(() => {
        const saved = { sessions: [{ id: 'usage-e2e', agentName: 'Codex', sessionId: 'usage-e2e', cwd: '/tmp', title: 'Usage display check', supportsLoadSession: true, lastUpdated: Date.now() }] };
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify(saved));
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { Codex: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false, lastCwd: '/tmp' }));
      });
      const page = await context.newPage();
      const errors = [], rpcCalls = [], quotaFailures = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.url().includes('/api/subscription-limits') && r.status() >= 400) quotaFailures.push(r.status()); });
      if (process.env.BUILD) await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.port === '25809' && (url.pathname === '/chat' || url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
          const file = path.join(process.env.BUILD, url.pathname.startsWith('/assets/') ? url.pathname : 'index.html');
          return route.fulfill({ path: file, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        }
        return route.continue();
      });
      let quotaRequests = 0, release, fail = false;
      const quotaGate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/subscription-limits') {
          quotaRequests++;
          if (process.env.LIVE_LIMITS) return route.continue();
          await quotaGate;
          return route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: 'offline' } : {
            updatedAt: Date.now(), providers: [
              { id: 'codex', name: 'Codex', status: 'ready', windows: [
                { id: 'primary', label: '5-hour', usedPercent: 20, resetsAt: Date.now() + 3600000 },
                { id: 'secondary', label: 'Weekly', usedPercent: 64, resetsAt: Date.now() + 86400000 },
              ] },
              { id: 'opencode', name: 'OpenCode Go', status: 'unavailable', message: 'Requires subscription', windows: [] },
              { id: 'claude', name: 'Claude', status: 'not_connected', message: 'Not connected', windows: [] },
            ],
          } });
        }
        if (url.pathname === '/api/usage') return route.fulfill({ json: { usage: [], sources: [] } });
        if (url.pathname.startsWith('/api/state/')) return route.fulfill({ json: { rev: 1, updatedAt: Date.now(), data: url.pathname.endsWith('sessions.json') ? { sessions: [{ id: 'usage-e2e', agentName: 'Codex', sessionId: 'usage-e2e', cwd: '/tmp', title: 'Usage display check', supportsLoadSession: true, lastUpdated: Date.now() }] } : {} } });
        return route.fulfill({ json: { projects: [], cards: [], sessions: [] } });
      });
      let socket;
      const usage = used => socket?.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'usage-e2e', update: { sessionUpdate: 'usage_update', used, size: 200000 } } }));
      await page.routeWebSocket(/wss?:\/\//, ws => {
        socket = ws;
        ws.onMessage(raw => {
          const q = JSON.parse(String(raw));
          if (!q.method || q.id == null) return;
          rpcCalls.push(q.method);
          const result = q.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'Codex', version: 'test' } }
            : q.method === 'session/list' ? { sessions: [{ sessionId: 'usage-e2e', cwd: '/tmp', title: 'Usage display check' }] } : {};
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
        });
      });
      await page.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=Codex%3A%3Ausage-e2e`, { waitUntil: 'domcontentloaded' });
      const meter = page.locator('.chat-view:visible .context-meter');
      await meter.waitFor({ timeout: 20000 });
      assert.equal(await meter.evaluate(e => e.tagName), 'BUTTON', 'context meter must open quota details');
      assert.equal(await meter.innerText(), 'Limits', 'quota is reachable before the first context update');
      usage(45000);
      await page.waitForFunction(() => document.querySelector('.chat-view:not([style*="display: none"]) .context-meter')?.textContent === '45k/200k');
      assert.equal(quotaRequests, 0, 'closed meters do not poll');
      const initial = await meter.boundingBox();
      const popup = page.getByRole('dialog', { name: 'Session usage' });
      if (width === 1440) await meter.hover();
      else await meter.tap();
      await popup.waitFor();
      if (!process.env.LIVE_LIMITS) {
        await popup.getByText('Loading subscription limits…', { exact: true }).waitFor();
        assert(await popup.getByRole('button', { name: 'Refreshing…' }).isDisabled());
        assert.equal(quotaRequests, 1);
        release();
      }
      await popup.getByTestId('limits-codex').waitFor({ timeout: 35000 });
      assert.match(await popup.innerText(), /Context: 23%/);
      assert.equal(await popup.getByTestId('limits-opencode').count(), 0);
      assert.equal(await popup.getByTestId('limits-claude').count(), 0);
      if (!process.env.LIVE_LIMITS) assert.match(await popup.innerText(), /36% left/);
      else assert.match(await popup.innerText(), /Weekly/);
      if (width === 1440) {
        await popup.hover(); await page.waitForTimeout(250);
        assert(await popup.isVisible(), 'hover card remains readable when entering it');
        await page.mouse.move(8, 8);
        await popup.waitFor({ state: 'hidden' });
        await meter.click();
        await popup.waitFor();
        await page.mouse.move(8, 8); await page.waitForTimeout(300);
        assert(await popup.isVisible(), 'click pins the card');
      }
      const box = await popup.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width + 1);
      assert(box.y >= 0 && box.y + box.height <= 845);
      assert(await popup.evaluate(e => e.scrollWidth <= e.clientWidth + 1));
      await page.screenshot({ path: `/tmp/session-usage-${process.env.LIVE_LIMITS ? 'live' : 'fixture'}-${width}.png` });
      await meter.click();
      await popup.waitFor({ state: 'hidden' });
      await meter.click(); await popup.waitFor();
      await popup.getByRole('button', { name: 'Close usage details' }).click();
      await popup.waitFor({ state: 'hidden' });
      await page.keyboard.press('Tab'); await meter.focus();
      assert.equal(await meter.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
      await page.keyboard.press('Enter'); await popup.waitFor();
      await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
      assert(await meter.evaluate(e => e === document.activeElement));
      await meter.click(); await popup.waitFor();
      await page.locator('.chat-view:visible textarea').click();
      await popup.waitFor({ state: 'hidden' });
      assert.equal(await meter.getAttribute('aria-expanded'), 'false');
      const after = await meter.boundingBox();
      assert.equal(after.width, initial.width, 'closing restores the same compact footprint');
      if (width < 800) assert(after.height >= 44);
      if (!process.env.LIVE_LIMITS) {
        fail = true;
        await meter.click(); await popup.waitFor();
        await popup.getByRole('alert').waitFor();
        fail = false;
        await popup.getByRole('button', { name: 'Refresh', exact: true }).click();
        await popup.getByTestId('limits-codex').waitFor();
        assert.deepEqual(quotaFailures, [503]);
      } else assert.deepEqual(quotaFailures, []);
      if (await popup.isVisible()) await popup.getByRole('button', { name: 'Close usage details' }).click();
      await page.evaluate(() => { window.__session.activeRuntime.isLoading = true; });
      const workingMeter = width < 800 ? page.locator('.chat-view:visible .loading-indicator .context-meter') : meter;
      await workingMeter.waitFor();
      assert.equal(await page.locator('.chat-view:visible .context-meter').count(), 1, 'one context control while working');
      await workingMeter.click();
      await popup.waitFor();
      await popup.getByTestId('limits-codex').waitFor({ timeout: 35000 });
      assert.match(await popup.innerText(), /45k\/200k/);
      if (width < 800) await page.getByRole('button', { name: /Expand sidebar|Open menu/ }).first().click();
      await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
      await popup.waitFor({ state: 'hidden' });
      await page.evaluate(() => { const runtime = window.__session.activeRuntime; if (runtime) runtime.isLoading = false; });
      assert.equal(rpcCalls.filter(method => method === 'session/prompt' || method === 'session/new').length, 0, 'reading usage never starts model work');
      assert.deepEqual(errors, []);
      console.log(`PASS session usage ${width}px: compact trigger, hover/tap, keyboard/outside, provider isolation, ${process.env.LIVE_LIMITS ? 'real quota API' : 'loading/error/retry'}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
