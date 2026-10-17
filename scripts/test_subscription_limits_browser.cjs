const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const live = process.env.LIVE_URL;
  try {
    for (const width of live ? [1440, 390] : [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 800, ignoreHTTPSErrors: true });
      const errors = [], failures = [];
      let resolveLimits, fail = false, calls = 0;
      const gate = new Promise(resolve => { resolveLimits = resolve; });
      if (!live) {
        assert(process.env.BUILD);
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/api/subscription-limits') {
            calls++; await gate;
            if (fail) return route.fulfill({ status: 503, json: { error: 'offline' } });
            return route.fulfill({ json: { updatedAt: Date.now(), providers: [
              { id: 'codex', name: 'Codex', status: 'ready', windows: [
                { id: 'primary', label: '5-hour', usedPercent: 20, resetsAt: Date.now() + 3600000 },
                { id: 'secondary', label: 'Weekly', usedPercent: 95, resetsAt: Date.now() + 86400000 },
              ] },
              { id: 'opencode', name: 'OpenCode Go', status: 'ready', windows: [
                { id: 'rolling', label: '5-hour', usedPercent: 0, resetsAt: Date.now() + 10000 },
                { id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: null },
                { id: 'monthly', label: 'Monthly', usedPercent: 25, resetsAt: Date.now() - 1000 },
              ] },
              { id: 'claude', name: 'Claude', status: 'not_connected', message: 'Claude is not connected yet.', windows: [] },
            ] } });
          }
          if (url.pathname === '/api/usage') return route.fulfill({ json: { usage: [], sources: [] } });
          if (url.pathname === '/health') return route.fulfill({ json: { ok: true } });
          if (url.pathname.startsWith('/api/state/')) return route.fulfill({ json: { rev: 1, data: {} } });
          if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { cards: [], sessions: [], projects: [] } });
          const file = path.join(process.env.BUILD, url.pathname.startsWith('/assets/') ? url.pathname : 'index.html');
          return route.fulfill({ body: fs.readFileSync(file), contentType: { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream' });
        });
        await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(raw => {
          const q = JSON.parse(String(raw));
          if (q.id != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: q.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { sessions: [] } }));
        }));
      }
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.url().includes('/api/subscription-limits') && r.status() >= 400) failures.push(r.status()); });
      await page.goto(live || 'http://127.0.0.1:25808/chat', { waitUntil: 'domcontentloaded' });
      if (width < 800) await page.getByRole('button', { name: /Expand sidebar|Open menu/ }).first().click();
      await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
      const section = page.getByTestId('subscription-limits');
      await section.waitFor();
      const button = section.getByRole('button');
      if (!live) {
        await page.getByText('Loading subscription limits…', { exact: true }).waitFor();
        assert(await button.isDisabled()); assert.equal(calls, 1);
        assert.equal(await button.evaluate(e => getComputedStyle(e).opacity), '0.5');
        resolveLimits();
      }
      await page.getByTestId('limits-codex').waitFor({ timeout: 35000 });
      if (!live) {
        assert.match(await section.innerText(), /80% left/);
        assert.match(await section.innerText(), /5% left/);
        assert.match(await section.innerText(), /100% left/);
        assert.match(await section.innerText(), /0% left/);
        assert.match(await section.innerText(), /Awaiting update/);
        const color = await section.locator('progress').first().evaluate(e => getComputedStyle(e, '::-webkit-progress-value').backgroundColor);
        assert.notEqual(color, 'rgba(0, 0, 0, 0)');
      } else {
        assert.match(await page.getByTestId('limits-codex').innerText(), /Weekly/);
        assert.equal(await page.getByTestId('limits-codex').locator('progress').count(), 1);
        assert.match(await page.getByTestId('limits-opencode').innerText(), /active Go subscription/);
      }
      assert.match(await page.getByTestId('limits-claude').innerText(), /not connected yet/);
      await page.keyboard.press('Tab');
      await button.focus();
      assert.equal(await button.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
      if (width < 800) assert((await button.boundingBox()).height >= 44);
      if (width === 1440) {
        const color = await button.evaluate(e => getComputedStyle(e).backgroundColor);
        await button.hover();
        assert.notEqual(await button.evaluate(e => getComputedStyle(e).backgroundColor), color);
      }
      assert(await section.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'no overflow');
      await page.screenshot({ path: `/tmp/subscription-${live ? 'live' : 'fixture'}-${width}.png`, fullPage: true });
      if (!live) {
        fail = true; await button.click();
        await section.getByRole('alert').waitFor();
        assert.match(await section.innerText(), /Previous values/);
        fail = false; await button.click();
        await section.getByRole('alert').waitFor({ state: 'hidden' });
        assert.deepEqual(failures, [503]);
      } else assert.deepEqual(failures, []);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('limits-codex').waitFor({ timeout: 35000 });
      assert.deepEqual(errors, []);
      console.log(`PASS ${live ? 'production' : 'fixture'} ${width}px: account data, pending/error/recovery, layout and controls`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
