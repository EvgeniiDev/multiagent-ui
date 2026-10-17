// Actual browser/worker, mocked notification subscription and state/ACP.
// BUILD tests a candidate on an ephemeral localhost HTTP server. UI_TEST_URL
// tests published assets. No model prompts or user-state writes are performed.
// This UI harness bypasses TLS errors and does not establish installability.
// Run check_pwa_installability.cjs separately against the device-facing origin.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const webpush = require('../server/push/node_modules/web-push');
const key = webpush.generateVAPIDKeys().publicKey;
(async () => {
  let server;
  let base = process.env.UI_TEST_URL;
  if (process.env.BUILD) {
    server = createServer((req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname;
      const file = path.join(process.env.BUILD, ['/', '/chat'].includes(name) ? 'index.html' : name);
      try {
        const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }[path.extname(file)];
        res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox', '--ignore-certificate-errors'] });
  try {
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: width < 800, viewport: { width, height: 844 } });
      await context.grantPermissions(['notifications']);
      let testFailure = false, refreshFailure = false, saved = 0, deleted = 0;
      await context.addInitScript(() => {
        if (!sessionStorage.getItem('pwa-test-initialized')) {
          localStorage.clear();
          localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: {} }));
          sessionStorage.setItem('pwa-test-initialized', '1');
        }
        let subscription = null;
        const permission = Notification.requestPermission.bind(Notification);
        Notification.requestPermission = () => window.__denyPush ? Promise.resolve('denied') : permission();
        PushManager.prototype.getSubscription = async () => subscription;
        function createSubscription() {
          subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/browser-test',
            toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }; },
            async unsubscribe() { subscription = null; localStorage.removeItem('pwa-test-subscribed'); return true; } };
        }
        if (localStorage.getItem('pwa-test-subscribed')) createSubscription();
        PushManager.prototype.subscribe = async () => {
          createSubscription();
          localStorage.setItem('pwa-test-subscribed', '1');
          return subscription;
        };
      });
      await context.route('**/api/**', async route => {
        const u = new URL(route.request().url());
        if (u.pathname === '/api/push/config') return route.fulfill({ json: { publicKey: key } });
        if (u.pathname === '/api/push/subscription') {
          if (route.request().method() === 'DELETE') { deleted++; await new Promise(r => setTimeout(r, 400)); return route.fulfill({ json: { enabled: false } }); }
          saved++; await new Promise(r => setTimeout(r, 200));
          if (refreshFailure) return route.fulfill({ status: 503, json: { error: 'Notifications temporarily unavailable' } });
          return route.fulfill({ json: { token: 'b'.repeat(64) } });
        }
        if (u.pathname === '/api/push/test') return route.fulfill(testFailure
          ? { status: 502, json: { error: 'Push delivery failed. Try again.' } } : { json: { sent: true } });
        return route.fulfill({ json: u.pathname.includes('/api/state/') ? { rev: 1, updatedAt: Date.now(), data: {} } : { projects: [], cards: [], sessions: [] } });
      });
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(raw => {
        try { const q = JSON.parse(String(raw)); if (q.id != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: q.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { sessions: [] } })); } catch {}
      }));
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      let registrations = [];
      cdp.on('ServiceWorker.workerRegistrationUpdated', event => { registrations = event.registrations; });
      await cdp.send('ServiceWorker.enable');
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/chat`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
      assert.equal(manifest.display, 'standalone');
      assert.equal(manifest.start_url, '/chat');
      assert.equal(await page.evaluate(async () => (await caches.keys()).length), 0, 'no offline history/cache');
      const registration = registrations.find(r => r.scopeURL === base + '/');
      assert(registration, 'real service worker is registered');
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId: registration.registrationId,
        data: JSON.stringify({ title: 'PWA worker check', body: 'Response ready', url: '/chat?s=Pi%3A%3Atest', tag: 'pwa-browser-test' }) });
      await page.waitForFunction(async () => (await (await navigator.serviceWorker.ready).getNotifications()).some(n => n.title === 'PWA worker check'));
      await page.evaluate(async () => { for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) notification.close(); });
      if (width < 800) await page.getByRole('button', { name: /Expand sidebar|Open menu/, exact: true }).first().click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const section = page.locator('.pwa-settings');
      await section.waitFor();
      const enable = section.getByRole('button', { name: 'Enable notifications', exact: true });
      await enable.waitFor();
      const reload = section.getByRole('button', { name: 'Reload app', exact: true });
      assert(await reload.isVisible(), 'reload is available before enabling notifications');
      assert(await reload.isEnabled(), 'reload does not require notification permission');
      await page.evaluate(() => { window.__denyPush = true; });
      await enable.click();
      await section.getByRole('alert').filter({ hasText: 'Notifications are blocked' }).waitFor();
      assert.equal(saved, 0);
      await page.evaluate(() => { window.__denyPush = false; });
      await enable.click();
      await section.getByRole('button', { name: 'Enabling…', exact: true }).waitFor();
      assert(await section.getByRole('button', { name: 'Enabling…', exact: true }).isDisabled());
      const test = section.getByRole('button', { name: 'Send test notification', exact: true });
      await test.waitFor();
      assert.equal(saved, 1);
      await section.getByRole('button', { name: 'Reload app', exact: true }).waitFor();
      const close = page.locator('.settings-header button');
      await close.click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await section.getByRole('button', { name: 'Reload app', exact: true }).waitFor();
      await test.waitFor({ state: 'visible' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (width < 800) await page.getByRole('button', { name: /Expand sidebar|Open menu/, exact: true }).first().click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await test.waitFor();
      await page.waitForFunction(() => !document.querySelector('.pwa-settings button[disabled]'));
      assert.equal(await page.evaluate(() => localStorage.getItem('acp-ui:push-device')), 'b'.repeat(64), 'subscription token restored after reload');
      assert(await reload.isVisible(), 'reload remains available after a page reload');
      refreshFailure = true;
      await close.click(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await section.getByRole('alert').filter({ hasText: 'Notifications temporarily unavailable' }).waitFor();
      refreshFailure = false;
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        assert(await test.evaluate(e => getComputedStyle(e).fontSize === '12px' && getComputedStyle(e).borderTopStyle === 'solid'), 'shared button styles');
      }
      await page.keyboard.press('Tab');
      await test.focus();
      assert(await test.evaluate(e => e.matches(':focus-visible') && getComputedStyle(e).outlineStyle === 'solid' && getComputedStyle(e).outlineWidth === '2px'), 'shared keyboard focus');
      if (width < 800) assert((await test.boundingBox()).height >= 44);
      await test.click();
      await section.getByRole('status').filter({ hasText: 'Test notification sent' }).waitFor();
      testFailure = true;
      await test.click();
      await section.getByRole('alert').filter({ hasText: 'Push delivery failed' }).waitFor();
      assert.equal(await section.getByRole('status').count(), 0, 'no stale success after failure');
      if (process.env.ARTIFACT_DIR) {
        fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
        await section.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `pwa-${width}.png`) });
      }
      await section.getByRole('button', { name: 'Disable notifications', exact: true }).click();
      await close.click(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await enable.waitFor(); assert.equal(deleted, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem('acp-ui:push-device')), null);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert(await reload.isVisible(), 'reload remains available after disabling notifications');
      await context.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (width < 800) await page.getByRole('button', { name: /Expand sidebar|Open menu/, exact: true }).first().click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await section.getByText('Push notifications require HTTPS', { exact: false }).waitFor();
      assert(await reload.isVisible(), 'reload is independent of push support');
      assert(await reload.isEnabled(), 'reload works without push support');
      await Promise.all([page.waitForEvent('domcontentloaded'), reload.click()]);
      if (width < 800) await page.getByRole('button', { name: /Expand sidebar|Open menu/, exact: true }).first().click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      assert(await reload.isVisible(), 'reload button navigates and remains available');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: manifest, real worker, no cache, permission denial, enable/pending/error/test/disable, theme, focus, touch, no JS errors`);
      await context.close();
    }
  } finally { await browser.close(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exit(1); });
