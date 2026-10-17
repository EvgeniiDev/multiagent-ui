// Visual regression for Settings. All API/state writes stay inside this browser fixture.
// BUILD=/absolute/build/path PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test_settings_layout_browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  assert(process.env.BUILD, 'BUILD must point at a candidate web build');
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(process.env.BUILD, pathname === '/' || pathname === '/chat' ? 'index.html' : pathname);
    try {
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
    const output = process.env.SHOTS || '/tmp/acp-settings-layout';
    fs.mkdirSync(output, { recursive: true });
    for (const width of [320, 390, 430, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 800 });
      await context.addInitScript(() => {
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { 'Hermes Agent': { transport: 'websocket', url: 'wss://192.168.1.222:25911/' } } }));
        localStorage.setItem('acp-ui:roles.json', JSON.stringify({ version: 1, roles: [{ id: 'qa-role', label: 'Layout verification with a long role name', cli: 'hermes', args: ['--model', 'layout-model'], promptFile: '.acp/roles/layout-verification-prompt.md', maxConcurrent: 1, pollIntervalSec: 10, timeoutMin: 15, maxRetries: 1, idleTimeoutMin: 0 }] }));
        localStorage.setItem('acp-ui:projects.json', JSON.stringify({ version: 1, projects: [
          { id: 'common', name: 'Common', path: '/home/hermes/projects', createdAt: 1 },
          { id: 'long', name: 'acceptance-modes-20261003214157', path: '/home/hermes/projects/acceptance-modes-20261003214157', createdAt: 1 },
        ] }));
      });
      await context.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await context.route('**/api/**', r => r.fulfill({ json: { root: '/home/hermes', path: '/home/hermes', dirs: [], projects: [], cards: [], sessions: [] } }));
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(raw => {
        const q = JSON.parse(String(raw));
        if (q.id != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: q.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { sessions: [] } }));
      }));
      const page = await context.newPage();
      const errors = [], httpErrors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`); });
      await page.goto(`http://127.0.0.1:${server.address().port}/chat`, { waitUntil: 'domcontentloaded' });
      if (width < 800) await page.getByRole('button', { name: /Expand sidebar|Open menu/ }).first().click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const panel = page.locator('.settings-panel');
      await page.locator('[data-testid="project-common"]').waitFor();
      async function fits() {
        const failures = await panel.evaluate(root => [...root.querySelectorAll('input, select, textarea, button, code')].filter(e => {
          const r = e.getBoundingClientRect(), p = root.getBoundingClientRect();
          return r.width && (r.left < p.left - 1 || r.right > p.right + 1);
        }).map(e => e.outerHTML.slice(0, 180)));
        assert.deepEqual(failures, [], `controls and paths fit at ${width}px`);
        assert(await page.locator('.settings-content').evaluate(e => e.scrollWidth <= e.clientWidth + 1), `no horizontal scroll at ${width}px`);
      }
      await fits();
      if (width <= 600) {
        const box = await panel.boundingBox();
        assert.equal(box.x, 0); assert.equal(box.y, 0); assert.equal(box.width, width); assert.equal(box.height, 844);
        for (const selector of ['.project-info', '.agent-info']) {
          const info = await page.locator(selector).first().boundingBox();
          const card = await page.locator(selector === '.project-info' ? '.project-item' : '.agent-item').first().boundingBox();
          assert(info.width >= card.width - 26, `${selector} uses the card width`);
        }
        const undersized = await panel.locator('button, .ui-input').evaluateAll(es => es.filter(e => e.getBoundingClientRect().height < 44).map(e => e.outerHTML.slice(0, 150)));
        assert.deepEqual(undersized, [], 'touch controls are at least 44px high');
      }
      await page.screenshot({ path: path.join(output, `settings-${width}.png`) });
      await page.locator('[data-testid="project-long"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `projects-${width}.png`) });
      assert.equal(await page.locator('.settings-header').evaluate(e => e.getBoundingClientRect().top), (await panel.boundingBox()).y, 'header stays visible during scroll');
      const commonDelete = page.locator('[data-testid="project-common"] [data-testid="project-delete"]');
      assert(await commonDelete.isDisabled(), 'Common remains protected');
      assert.equal(await commonDelete.evaluate(e => getComputedStyle(e).opacity), '0.5');
      if (width === 1440) {
        const button = page.locator('[data-testid="project-long"] [data-testid="project-rename"]');
        const background = await button.evaluate(e => getComputedStyle(e).backgroundColor);
        await button.hover();
        assert.notEqual(await button.evaluate(e => getComputedStyle(e).backgroundColor), background, 'hover is visible');
      }
      const rename = page.locator('[data-testid="project-long"] [data-testid="project-rename"]');
      await rename.click();
      await fits();
      const name = page.locator('[data-testid="project-edit-name"]');
      await name.focus();
      assert.equal(await name.evaluate(e => getComputedStyle(e).outlineStyle), 'solid', 'field focus is visible');
      await page.locator('[data-testid="project-cancel"]').click();
      await page.getByRole('button', { name: 'Browse directories', exact: true }).click();
      await page.locator('.tree-panel').waitFor();
      await fits();
      await page.locator('.tree-close').click();
      await page.locator('.agents-section .edit-btn').first().click();
      await fits();
      assert(await page.locator('.agent-form input').first().isDisabled(), 'existing agent name remains locked');
      await page.locator('.agent-form .add-env-btn').click();
      await fits();
      await page.locator('.agent-form .remove-env-btn').click();
      await page.locator('.agent-form .cancel-btn').click();
      await page.locator('[data-testid="roles-add-toggle"]').click();
      await fits();
      await page.screenshot({ path: path.join(output, `role-form-${width}.png`) });
      await page.locator('[data-testid="role-cancel"]').click();
      await page.keyboard.press('Tab');
      await page.locator('.settings-header button').focus();
      assert.equal(await page.locator('.settings-header button').evaluate(e => getComputedStyle(e).outlineStyle), 'solid', 'button focus is visible');
      if (width <= 600) {
        await page.setViewportSize({ width, height: 480 });
        assert.equal((await panel.boundingBox()).height, 480, 'panel follows the smaller viewport');
      }
      await page.locator('.settings-header button').click();
      assert.equal(await panel.count(), 0, 'settings close');
      assert.deepEqual(errors, []); assert.deepEqual(httpErrors, []);
      console.log(`PASS settings ${width}px`);
      await context.close();
    }
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
