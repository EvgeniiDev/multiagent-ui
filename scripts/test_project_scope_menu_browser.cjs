// Project picker regression: candidate fixtures never write to production state or prompt a model.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/hermes/projects/paseo-src/node_modules/playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(process.env.BUILD, pathname === '/' || pathname === '/chat' ? 'index.html' : pathname);
    try {
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  try {
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 800 });
      await context.addInitScript(() => {
        if (!localStorage.getItem('acp-ui:projects.json')) localStorage.setItem('acp-ui:projects.json', JSON.stringify({ version: 1, activeProjectId: 'all', projects: [
          { id: 'common', name: 'Common', path: '/home/hermes/projects', createdAt: 1 },
          ...Array.from({ length: 25 }, (_, i) => ({ id: `qa-${i}`, name: i === 0 ? 'acceptance-modes-20261003214157-very-long-project-name' : `Project ${i}`, path: `/tmp/qa-${i}`, createdAt: i + 2 })),
        ] }));
      });
      await context.route('**/api/**', r => r.fulfill({ json: { root: '/home/hermes', path: '/home/hermes', dirs: [], projects: [], cards: [], sessions: [] } }));
      await context.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(raw => {
        const q = JSON.parse(String(raw));
        if (q.id != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: q.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { sessions: [] } }));
      }));
      const page = await context.newPage();
      const errors = [], httpErrors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(`http://127.0.0.1:${server.address().port}/chat`, { waitUntil: 'networkidle' });
      if (width < 800 && !await page.getByRole('button', { name: /^Project scope:/ }).isVisible()) await page.getByRole('button', { name: /Open menu|Expand sidebar/ }).first().click();
      const trigger = page.getByRole('button', { name: /^Project scope:/ });
      await trigger.evaluate(e => { e.disabled = true; });
      assert.equal(await trigger.evaluate(e => getComputedStyle(e).opacity), '0.5');
      await trigger.evaluate(e => { e.disabled = false; });
      await trigger.click();
      const menu = page.getByRole('listbox', { name: 'Project scope' });
      await menu.waitFor();
      assert.equal(await page.locator('.scope-selector select').count(), 0, 'no native system picker');
      assert.equal(await menu.getByRole('option').count(), 27);
      assert.equal(await menu.getByRole('option', { selected: true }).textContent().then(s => s.trim()), 'All projects');
      const styles = await menu.evaluate(e => {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return { bg: s.backgroundColor, token: s.getPropertyValue('--bg-sidebar').trim(), height: r.height, left: r.left, right: r.right, bottom: r.bottom, scroll: e.scrollHeight > e.clientHeight };
      });
      assert.equal(styles.bg, 'rgb(23, 23, 23)');
      assert(styles.left >= 0 && styles.right <= width && styles.bottom <= 844 && styles.scroll, JSON.stringify(styles));
      assert((await menu.getByRole('option').first().boundingBox()).height >= 44);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await menu.waitFor({ state: 'hidden' });
      assert.match(await trigger.textContent(), /Project 24/);
      assert.equal(await trigger.evaluate(e => e === document.activeElement), true);
      await trigger.press('ArrowDown');
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert.match(await trigger.textContent(), /Common/);
      await page.reload({ waitUntil: 'networkidle' });
      if (width < 800 && !await page.getByRole('button', { name: /^Project scope:/ }).isVisible()) await page.getByRole('button', { name: /Open menu|Expand sidebar/ }).first().click();
      assert.match(await trigger.textContent(), /Common/);
      await trigger.click();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(e => e === document.activeElement), true);
      await trigger.click();
      await page.mouse.click(width - 2, 842);
      await menu.waitFor({ state: 'hidden' });
      await page.keyboard.press('Tab');
      await trigger.focus();
      assert.equal(await trigger.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
      await trigger.click();
      const long = menu.getByRole('option', { name: /acceptance-modes/ });
      await long.scrollIntoViewIfNeeded();
      assert(await long.evaluate(e => e.scrollWidth <= e.clientWidth));
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        await page.mouse.move(width - 1, 843);
        const before = await long.evaluate(e => getComputedStyle(e).backgroundColor);
        await long.hover();
        assert.notEqual(await long.evaluate(e => getComputedStyle(e).backgroundColor), before);
        assert.equal(await menu.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(23, 23, 23)', 'graphite theme is stable across OS schemes');
      }
      await page.screenshot({ path: `/tmp/acp-project-menu-${width}.png` });
      await long.click();
      assert.match(await trigger.textContent(), /acceptance-modes/);
      await trigger.click();
      await page.keyboard.press('Tab');
      await menu.waitFor({ state: 'hidden' });
      assert(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement.closest('[role=listbox]')));
      await trigger.click();
      await page.keyboard.press('Shift+Tab');
      await menu.waitFor({ state: 'hidden' });
      assert(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement.closest('[role=listbox]')));
      await trigger.click();
      await page.setViewportSize({ width, height: 820 });
      await menu.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []); assert.deepEqual(httpErrors, []);
      console.log(JSON.stringify({ width, styles, keyboard: true, persists: true, outsideDismiss: true, errors, httpErrors }));
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
