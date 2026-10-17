// Whole-app UI-library integration, isolated state/ACP fixtures; never starts real work.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(process.env.BUILD, pathname.startsWith('/assets/') || path.extname(pathname) ? pathname : 'index.html');
    try { res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  try {
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, hasTouch: width < 800 });
      await context.addInitScript(() => {
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { E2E: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [{ id: 'e2e', sessionId: 'e2e', agentName: 'E2E', title: 'Library fixture', cwd: '/tmp', supportsLoadSession: true, lastUpdated: Date.now() }], openTabs: [{ agentName: 'E2E', sessionId: 'e2e' }] }));
        localStorage.setItem('acp-ui:projects.json', JSON.stringify({ version: 1, activeProjectId: 'all', projects: [{ id: 'common', name: 'Common', path: '/home/hermes/projects', createdAt: 1 }] }));
        localStorage.setItem('acp-ui:board.json', JSON.stringify({ version: 2, cards: [{ id: 'ui-library-card', title: 'Shared controls fixture', description: 'Browser-only data', project: '', agent: '', priority: 'medium', acceptance: '', verification: '', links: [], session: null, blocked: false, cancelled: false, stage: 'backlog', status: null, order: 0, createdAt: 1, updatedAt: 1 }] }));
      });
      await context.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await context.route('**/api/**', r => {
        const pathname = new URL(r.request().url()).pathname;
        if (/\/execution\/cards\/ui-library-card(?:\/|$)/.test(pathname)) return r.fulfill({ status: 404, json: { error: { code: 'card_not_found', message: 'Fixture card is not managed' } } });
        return r.fulfill({ json: { root: '/tmp', path: '/tmp', dirs: [], cards: [], sessions: [], projects: [], profiles: [], runs: [], events: [], roles: [], locks: [], models: [] } });
      });
      let socket, permissionReply;
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(raw => {
        const q = JSON.parse(String(raw));
        if (q.id === 811 && !q.method) { permissionReply = q; return; }
        if (!q.method || q.id == null) return;
        let result = {};
        if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
        if (q.method === 'session/list') result = { sessions: [] };
        if (q.method === 'session/load') { socket = ws; result = { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'careful', name: 'Careful' }] }, models: { currentModelId: 'alpha', availableModels: [{ modelId: 'alpha', name: 'Alpha' }, { modelId: 'beta', name: 'Beta' }] } }; }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
      }));
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const errors = [], failed = [], expected404 = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) { const item = `${r.status()} ${new URL(r.url()).pathname}`; if (r.status() === 404 && /\/execution\/cards\/ui-library-card(?:\/|$)/.test(new URL(r.url()).pathname)) expected404.push(item); else failed.push(item); } });
      await page.goto(`${process.env.UI_TEST_URL || `http://127.0.0.1:${server.address().port}`}/chat?s=E2E%3A%3Ae2e`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected);
      // Mixed static/expandable transcript rows must remain dense after control migration.
      const update = update => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'e2e', update } }));
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Transcript density fixture' } });
      for (let i = 0; i < 12; i++) update({ sessionUpdate: 'tool_call', toolCallId: `dense-${i}`, title: `Read fixture ${i}`, kind: 'read', status: i < 2 ? 'failed' : i < 4 ? 'in_progress' : 'completed', ...(i % 2 ? {} : { rawInput: { path: '/tmp/fixture.txt' } }) });
      const rows = page.locator('.chat-view:visible .tool-call-inline');
      await rows.nth(11).waitFor();
      const composer = page.locator('.chat-view:visible textarea.ui-input--composer');
      const density = await rows.evaluateAll(nodes => nodes.map(e => ({ height: e.getBoundingClientRect().height, top: e.getBoundingClientRect().top, font: getComputedStyle(e).fontFamily })));
      console.log(JSON.stringify({ width, density }));
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await composer.fill('Проверка фокуса');
        await composer.focus();
        const outline = await composer.evaluate(e => getComputedStyle(e).outlineWidth);
        console.log(JSON.stringify({ width, scheme, composerOutline: outline }));
        await page.waitForFunction(e => getComputedStyle(e.closest('.ui-composer')).borderTopColor === 'rgb(128, 128, 128)', await composer.elementHandle());
        assert.equal(outline, '0px', 'composer uses its frame focus cue, no rectangular textarea outline');
        assert(density.every(row => row.height <= 32), 'transcript disclosure rows stay compact on touch screens');
        assert(density.every(row => /mono/i.test(row.font)), 'static and expandable tool rows share monospace typography');
        for (let i = 1; i < density.length; i++) assert(density[i].top - density[i - 1].top <= 40, 'no large gaps between tool calls');
        await page.screenshot({ path: `/tmp/acp-ui-library-chat-${width}-${scheme}.png` });
      }
      await composer.fill('');
      const backgrounds = await rows.evaluateAll(nodes => nodes.map(e => getComputedStyle(e).backgroundColor));
      assert.equal(backgrounds[0], backgrounds[1], 'failed tool tint matches across static/disclosure rows');
      assert.equal(backgrounds[2], backgrounds[3], 'running tool tint matches across static/disclosure rows');
      assert.notEqual(backgrounds[0], backgrounds[4], 'failed tools retain status tint');
      assert.notEqual(backgrounds[2], backgrounds[4], 'running tools retain status tint');
      await rows.first().hover();
      assert.equal(await rows.first().evaluate(e => getComputedStyle(e).backgroundColor), backgrounds[0], 'hover preserves failed tool tint');
      if (width >= 800) assert.notEqual(await page.getByRole('tab', { name: /Library fixture/ }).evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'session tab retains its panel background');
      const disclosure = rows.filter({ has: page.locator('.tool-chevron') }).first();
      await disclosure.click();
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
      await page.locator('.chat-view:visible .tool-args').first().waitFor();
      await disclosure.focus(); await page.keyboard.press('Enter');
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
      // Permission autofocus, native keyboard activation and actual ACP reply.
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 811, method: 'session/request_permission', params: { sessionId: 'e2e', toolCall: { toolCallId: 'qa-permission', title: 'Read browser fixture', kind: 'read', status: 'pending' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } }));
      const allow = page.getByRole('button', { name: 'Allow once', exact: true }); await allow.waitFor();
      assert(await allow.evaluate(e => e === document.activeElement), 'permission primary action receives focus');
      assert(await allow.evaluate(e => e.classList.contains('ds-button')));
      await page.keyboard.press('Enter');
      await allow.waitFor({ state: 'hidden' });
      assert.match(JSON.stringify(permissionReply), /allow/);
      if (width < 800) await page.getByRole('button', { name: 'Chat settings', exact: true }).click();
      const model = page.locator('.chat-view:visible .model-picker');
      await model.locator('.model-button').click();
      await model.getByRole('searchbox', { name: 'Filter models' }).fill('Beta');
      await model.getByRole('searchbox', { name: 'Filter models' }).press('Enter');
      await page.waitForFunction(() => window.__session.activeRuntime.currentModelId === 'beta');
      const mode = page.locator('.chat-view:visible .mode-picker').first();
      await mode.locator('.mode-button').click();
      await mode.getByRole('button', { name: 'Careful', exact: true }).click();
      await page.waitForFunction(() => window.__session.activeRuntime.currentModeId === 'careful');
      async function navigate(name) {
        if (width < 800 && !await page.locator('#app-sidebar').isVisible()) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
        const nav = page.getByRole('navigation', { name: 'Main views' }).filter({ visible: true }).first();
        await nav.getByRole('button', { name, exact: true }).click();
      }
      if (width >= 800) {
        const runMode = page.locator('.chat-view:visible .mode-picker').last();
        await runMode.locator('.mode-button').click();
        await runMode.getByRole('button', { name: 'Workflow', exact: true }).click();
        const workflow = page.locator('.wf-panel:visible'); await workflow.waitFor();
        for (const tab of await workflow.getByRole('tab').all()) {
          await tab.click(); assert.equal(await tab.getAttribute('aria-selected'), 'true');
        }
      }
      if (!await page.locator('#app-sidebar').isVisible()) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await page.getByRole('button', { name: 'ACP Traffic Monitor', exact: true }).click();
      const traffic = page.locator('.traffic-monitor'); await traffic.waitFor();
      const header = traffic.locator('.monitor-header');
      assert(await header.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'traffic controls fit narrow screens');
      await traffic.getByRole('textbox', { name: 'Search ACP traffic' }).fill('fixture');
      assert(await header.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'traffic search clear action fits too');
      await traffic.getByRole('button', { name: 'Clear search', exact: true }).click();
      await traffic.getByRole('button', { name: 'Pause', exact: true }).click();
      await traffic.getByRole('button', { name: 'Resume', exact: true }).click();
      await traffic.getByRole('combobox').selectOption('requests');
      await page.screenshot({ path: `/tmp/acp-ui-library-traffic-${width}.png` });
      await traffic.getByRole('button', { name: 'Close', exact: true }).click();
      await navigate('Board');
      const card = page.locator('[data-card-id="ui-library-card"]'); await card.waitFor();
      const roleSelect = page.locator('[data-testid="col-role-select"]').first();
      assert.match(await roleSelect.evaluate(e => getComputedStyle(e).fontFamily), /mono/i);
      if (width < 800) assert.equal(await roleSelect.evaluate(e => getComputedStyle(e).fontSize), '16px');
      await roleSelect.evaluate(e => e.setAttribute('aria-invalid', 'true'));
      assert.equal(await roleSelect.evaluate(e => getComputedStyle(e).color), await roleSelect.evaluate(e => getComputedStyle(e).borderTopColor), 'missing-runner field retains its error color');
      await roleSelect.evaluate(e => e.removeAttribute('aria-invalid'));
      const menu = card.getByRole('button', { name: 'Card actions' });
      await page.mouse.move(0, 0);
      if (width >= 800) {
        assert.equal(await menu.evaluate(e => getComputedStyle(e).opacity), '0', 'secondary card action stays quiet until hover/focus');
        await menu.focus();
        assert.equal(await menu.evaluate(e => getComputedStyle(e).opacity), '1', 'keyboard focus reveals secondary action');
        await page.keyboard.press('Tab'); await card.hover();
      }
      assert.equal(await card.evaluate(e => getComputedStyle(e).opacity), '1', 'reveal affects only the secondary action');
      assert.equal(await menu.evaluate(e => getComputedStyle(e).opacity), '1', 'card action remains available to touch/hover');
      await menu.click();
      const blocked = card.getByRole('menuitem', { name: /blocked/ }); assert(await blocked.evaluate(e => e.classList.contains('ds-button')));
      await page.keyboard.press('Escape');
      await card.locator('.card-title').click();
      const drawer = page.locator('.card-drawer'); await drawer.waitFor();
      const high = drawer.getByRole('radio', { name: 'high', exact: true }); await high.click();
      assert.equal(await high.getAttribute('aria-checked'), 'true');
      const medium = drawer.getByRole('radio', { name: 'medium', exact: true });
      assert.notEqual(await high.evaluate(e => getComputedStyle(e).backgroundColor), await medium.evaluate(e => getComputedStyle(e).backgroundColor), 'priority selection is visible');
      const flags = drawer.getByRole('group', { name: 'Card flags' });
      await flags.getByRole('button', { name: 'blocked', exact: true }).click();
      assert.equal(await flags.getByRole('button', { name: 'blocked', exact: true }).getAttribute('aria-pressed'), 'true');
      await drawer.getByRole('button', { name: '+ Add link', exact: true }).click();
      await drawer.getByRole('textbox', { name: 'Link label', exact: true }).fill('UI fixture');
      await drawer.getByRole('button', { name: 'Remove link', exact: true }).click();
      assert.equal(await drawer.getByRole('textbox', { name: 'Link label', exact: true }).count(), 0);
      await drawer.locator('[data-field="title"]').fill('Edited fixture');
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await high.hover();
        await page.keyboard.press('Tab'); await high.focus();
        assert.equal(await high.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
        for (const field of await drawer.locator('input.ui-input:visible,select.ui-input:visible,textarea.ui-input:visible').all()) {
          assert.equal(await field.evaluate(e => getComputedStyle(e).fontFamily.includes('sans-serif') || getComputedStyle(e).fontFamily.includes('monospace')), true);
          if (width < 800) assert((await field.boundingBox()).height >= 44);
        }
      }
      if (width < 800) assert((await drawer.getByRole('button', { name: 'Close card editor' }).boundingBox()).height >= 44);
      assert(await drawer.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'drawer fits narrow screen');
      await page.screenshot({ path: `/tmp/acp-ui-library-board-${width}.png` });
      await drawer.getByRole('button', { name: 'Close card editor' }).click();
      const sections = page.getByRole('navigation', { name: 'Board sections' });
      for (const name of ['Events', 'Links', 'Timeline', 'Agents', 'Tasks']) {
        await sections.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
        await page.mouse.move(0, 0);
        const selected = sections.getByRole('tab', { name: new RegExp(`^${name}`) });
        assert.equal(await selected.getAttribute('aria-selected'), 'true');
        assert.equal(await selected.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'active section uses a quiet underline');
        assert.notEqual(await selected.evaluate(e => getComputedStyle(e).borderBottomColor), 'rgba(0, 0, 0, 0)');
      }
      await sections.getByRole('tab', { name: /^Events/ }).click();
      const eventFilter = page.getByRole('combobox', { name: 'Filter events by kind' }); await eventFilter.waitFor();
      assert(await eventFilter.evaluate(e => e.classList.contains('ui-input')));
      await eventFilter.selectOption('card');
      assert.deepEqual(errors, []); assert.deepEqual(failed, []);
      console.log(JSON.stringify({ width, permissionKeyboard: true, modelAndMode: true, cardMenu: true, drawerFields: true, priority: true, flags: true, links: true, boardTabs: true, errors, failed, expected404 }));
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
