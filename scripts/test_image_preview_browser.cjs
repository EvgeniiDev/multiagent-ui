// Image preview in staged attachments and replayed chat history.
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
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ lastCwd: '/tmp', telemetryEnabled: false }));
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
      const image = fs.readFileSync(path.join(__dirname, '../public/pwa-512.png'));
      let socket;
      const update = update => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'e2e', update } }));
      await page.routeWebSocket(/wss?:\/\//, ws => {
        ws.onMessage(message => {
          for (const line of String(message).split('\n')) {
            let q; try { q = JSON.parse(line); } catch { continue; }
            if (!q.method || q.id == null) continue;
            let result = {};
            if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] };
            if (q.method === 'session/list') result = { sessions: [] };
            if (q.method === 'session/load') {
              socket = ws;
              update({ sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data: image.toString('base64') } });
            }
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
          }
        });
      });
      await page.goto(`${base}/chat?s=E2E%3A%3Ae2e`, { waitUntil: 'domcontentloaded' });
      const history = page.locator('.chat-view:visible .attachment-block');
      const trigger = history.getByRole('button', { name: /^Preview / });
      await trigger.waitFor();
      const preview = page.getByRole('dialog', { name: 'Image preview' });
      const close = preview.getByRole('button', { name: 'Close image preview' });
      async function checkPreview(opener) {
        await opener.click();
        await preview.waitFor();
        await page.waitForFunction(() => {
          const img = document.querySelector('dialog .preview-image');
          return img?.complete && img.naturalWidth > 0;
        });
        assert.equal(await preview.locator('.preview-image').evaluate(e => e.naturalWidth), 512);
        if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `image-preview-${width}.png`) });
        const r = await preview.boundingBox();
        assert(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= 844, 'preview fits viewport');
        assert.equal(await preview.evaluate(e => e.matches(':modal')), true, 'native modal traps focus');
        await close.focus();
        await page.keyboard.press('Tab');
        assert(await preview.evaluate(e => e.contains(document.activeElement) || document.activeElement === document.body), 'Tab cannot reach background controls');
        await close.focus();
        if (width < 800) {
          const box = await close.boundingBox();
          assert(box.width >= 44 && box.height >= 44, 'close has touch target');
        }
        await page.keyboard.press('Escape');
        await preview.waitFor({ state: 'detached' });
        assert(await opener.evaluate(e => e === document.activeElement), 'focus returns to opener');
      }
      await checkPreview(trigger);
      // Reload uses the actual session/load replay path again.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await trigger.waitFor();
      await checkPreview(trigger);
      await page.locator('.chat-view:visible .file-input').setInputFiles({ name: 'my-picture.png', mimeType: 'image/png', buffer: image });
      const staged = page.locator('.chat-view:visible .attach-tray');
      const stagedTrigger = staged.getByRole('button', { name: 'Preview my-picture.png', exact: true });
      await checkPreview(stagedTrigger);
      assert.equal(await staged.locator('.attach-chip').count(), 1, 'preview does not remove draft attachment');
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        await stagedTrigger.focus();
        assert.equal(await stagedTrigger.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
        await stagedTrigger.hover();
        await stagedTrigger.click();
        await close.click();
        await preview.waitFor({ state: 'detached' });
      }
      await stagedTrigger.click();
      await preview.waitFor();
      await page.mouse.click(1, 1);
      await preview.waitFor({ state: 'detached' });
      await stagedTrigger.click();
      await preview.waitFor();
      await preview.locator('.preview-image').dispatchEvent('error');
      await preview.getByRole('alert').waitFor();
      await close.click();
      await staged.getByRole('button', { name: 'Remove attachment' }).click();
      assert.equal(await staged.count(), 0, 'removal still works');
      assert.deepEqual(errors, []);
      assert.deepEqual(failedHttp, []);
      console.log(`PASS ${width}px: staged/history/reload, full image, focus/Tab/Escape, outside/close, error, removal, themes, touch`);
      await context.close();
    }
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
