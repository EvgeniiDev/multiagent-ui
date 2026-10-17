// Browser regression: mouse resize/persistence, compact rows, and mobile isolation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  assert(process.env.BUILD, 'BUILD must point at the candidate web build');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(process.env.BUILD, ['/', '/chat'].includes(url) ? 'index.html' : url);
    try {
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      if (sessionStorage.getItem('sidebar-fixture')) return;
      sessionStorage.setItem('sidebar-fixture', '1');
      localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: {} }));
      localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
      localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [{ id: 'layout-session', sessionId: 'layout-session', agentName: 'Codex', supportsLoadSession: true, title: 'A long session title that needs more horizontal space', cwd: '/home/hermes/projects', lastUpdated: Date.now() }], openTabs: [] }));
    });
    await context.route('**/health', r => r.fulfill({ json: { ok: false } }));
    await context.route('**/api/**', r => r.fulfill({ json: { root: '/home/hermes', dirs: [], projects: [], cards: [], sessions: [] } }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/chat`, { waitUntil: 'domcontentloaded' });
    const sidebar = page.locator('#app-sidebar');
    const separator = page.getByRole('separator', { name: 'Resize chat sidebar' });
    await sidebar.waitFor();
    assert.equal(await separator.count(), 1, 'desktop sidebar exposes a resize separator');
    await page.locator('.session-row').first().waitFor();
    const width = async () => Math.round((await sidebar.boundingBox()).width);
    const initial = await width();
    await separator.dispatchEvent('keydown', { key: 'ArrowRight' });
    assert.equal(await width(), initial, 'arrow keys do not change width');
    const output = process.env.SHOTS || '/tmp/acp-sidebar-resize';
    fs.mkdirSync(output, { recursive: true });
    const row = await page.locator('.session-row').first().boundingBox();
    const aside = await sidebar.boundingBox();
    assert(aside.x + aside.width - row.x - row.width <= 16, 'row uses the space up to the scrollbar');
    const start = await separator.boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + 200);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + 150, start.y + 200, { steps: 12 });
    await page.mouse.up();
    assert.equal(await width(), initial + 150, 'mouse drag widens the sidebar');
    await page.screenshot({ path: path.join(output, 'desktop-sidebar-wide.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await separator.waitFor();
    assert.equal(await width(), initial + 150, 'width survives reload');
    const expanded = await separator.boundingBox();
    await page.mouse.move(expanded.x + expanded.width / 2, expanded.y + 200);
    await page.mouse.down();
    await page.mouse.move(1200, expanded.y + 200, { steps: 10 });
    await page.mouse.up();
    const maximum = await width();
    assert(maximum <= 560, 'maximum keeps room for the chat');
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForFunction(() => document.querySelector('#app-sidebar').getBoundingClientRect().width <= 480);
    assert(await width() <= 480, 'sidebar is clamped when window shrinks');
    assert(await page.locator('.main-content').evaluate(e => e.getBoundingClientRect().width >= 350), 'chat keeps usable width');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(expected => Math.round(document.querySelector('#app-sidebar').getBoundingClientRect().width) === expected, maximum);
    assert.equal(await width(), maximum, 'preferred width returns on a wider window');
    const wide = await separator.boundingBox();
    await page.mouse.move(wide.x + wide.width / 2, wide.y + 200);
    await page.mouse.down();
    await page.mouse.move(50, wide.y + 200, { steps: 10 });
    await page.mouse.up();
    const minimum = await width();
    assert(minimum >= 240, 'minimum fits sidebar header');
    assert(await sidebar.locator('.sidebar-content').evaluate(e => e.scrollWidth <= e.clientWidth), 'no horizontal scrollbar inside sidebar');
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    assert(!await separator.isVisible());
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    assert.equal(await width(), minimum, 'collapse preserves width');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await separator.count(), 0, 'mobile has no resize handle');
    if (!await sidebar.isVisible()) await page.getByRole('button', { name: 'Open menu' }).click();
    assert.equal((await sidebar.boundingBox()).width, 390, 'mobile sessions page fills the viewport independently of desktop width');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no mobile horizontal overflow');
    await page.setViewportSize({ width: 1440, height: 900 });
    if (!await sidebar.isVisible()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await separator.waitFor();
    await separator.dblclick();
    assert.equal(await width(), initial, 'double-click resets width');
    await page.screenshot({ path: path.join(output, 'desktop-sidebar.png') });
    assert.deepEqual(errors, []);
    console.log('PASS mouse resize, bounds, persistence, reset, compact rows, collapse, and mobile isolation');
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
