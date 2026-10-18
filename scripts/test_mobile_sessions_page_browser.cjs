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
    for (const width of [320, 390, 780, 1440, 1920]) {
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
      let liveSocket;
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
        const q = JSON.parse(String(message));
        if (!q.method || q.id == null) return;
        if (q.method === 'session/new') {
          setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'Test creation failure' } })), 600);
          return;
        }
        let result = {};
        if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }, authMethods: [] };
        if (q.method === 'session/list') result = { sessions: ['older', 'newer'].map((sessionId, i) => ({ sessionId, title: sessionId, cwd: '/tmp', updatedAt: new Date(1700000000000 + i * 60000).toISOString() })) };
        if (q.method === 'session/load') {
          if (q.params.sessionId === 'older') liveSocket = ws;
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: q.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Existing answer\n\n'.repeat(60) } } } }));
        }
        setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result })), 30);
      }));
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [], failed = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
      await page.goto(`${base}/chat?s=E2E%3A%3Aolder`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
      const field = page.locator('.chat-view:visible textarea');
      await field.fill('Preserved draft');
      await page.evaluate(() => scrollTo(0, 600));
      await page.waitForTimeout(150);
      const historyTop = await page.evaluate(() => scrollY);
      const menu = page.getByRole('button', { name: 'Open menu', exact: true });
      if (width < 800) {
        assert.equal(await page.locator('.tab-strip').count(), 0, 'mobile has no top session tabs');
        assert.equal(await page.locator('.session-navigation [aria-label="New session"]').count(), 0, 'mobile creation is available through the session list');
        await menu.click();
        const sidebar = page.locator('#app-sidebar');
        await sidebar.waitFor();
        const rect = await sidebar.boundingBox();
        assert.equal(Math.round(rect.width), width, 'session page fills the viewport');
        assert.equal(rect.x, 0);
        async function assertPlainSessionList() {
          await page.mouse.move(0, 0);
          assert.equal(await sidebar.locator('.session-row.active').count(), 0, 'mobile list has no selected/current row');
          assert.equal(await sidebar.locator('.session-open[aria-pressed],.session-open[aria-current],.session-open[aria-selected]').count(), 0, 'mobile rows are navigation actions, not selected tabs');
          assert.equal(await sidebar.locator('.row-open,.row-status.open').count(), 0, 'mobile list has no open-tab dots or Open label');
          assert.equal(await sidebar.getByRole('button', { name: 'Close session', exact: true }).count(), 0, 'mobile has no close-tab action');
          for (const row of await sidebar.locator('.session-open').all()) {
            assert.equal(await row.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'no persistent current-session fill');
            assert.equal(await row.evaluate(e => getComputedStyle(e).borderTopColor), 'rgba(0, 0, 0, 0)', 'no current-session outline');
          }
        }
        await assertPlainSessionList();
        assert(await page.locator('.main-area').evaluate(e => e.inert), 'covered chat cannot receive focus');
        assert.equal(await page.locator('.drawer-backdrop').isVisible(), false);
        assert.deepEqual(await page.locator('.row-title').allTextContents(), ['newer', 'older'], 'opening and replay preserve message ordering');
        await page.evaluate(() => {
          const rt = window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer');
          rt.isLoading = true;
        });
        await page.locator('.session-row').filter({ hasText: 'newer' }).locator('.row-status.working').waitFor();
        await page.evaluate(() => {
          const rt = window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer');
          rt.error = 'Test connection failure';
        });
        assert.equal(await page.locator('.row-status.error').getAttribute('title'), 'Test connection failure');
        await page.evaluate(() => { const rt = window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer'); rt.error = null; rt.isLoading = false; rt.unread = true; });
        assert.equal(await page.locator('.row-status.unread').innerText(), 'Unread reply');
        liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'older', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A fresh reply' } } } }));
        await page.waitForFunction(() => document.querySelector('.row-title')?.textContent === 'older');
        if (width === 390) {
          // Continuous output must neither reshuffle every chunk nor defer forever.
          const started = Date.now();
          for (let burst = 0; burst < 6; burst++) {
            await page.evaluate(() => {
              const session = window.__session.savedSessions.find(s => s.id === 'newer');
              session.lastUpdated = session.lastMessageAt = Date.now();
              window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer').isLoading = true;
            });
            await page.waitForTimeout(500);
            assert.equal(await page.locator('.row-title').first().innerText(), 'older', 'streaming cannot immediately move rows');
            assert(await page.locator('.session-row').filter({ hasText: 'newer' }).locator('.row-status.working').isVisible(), 'statuses stay live while ordering waits');
          }
          await page.waitForFunction(() => document.querySelector('.row-title')?.textContent === 'newer', null, { timeout: 3000 });
          assert(Date.now() - started < 6500, 'continuous output is sorted within the next five-second window');
          await page.evaluate(() => {
            const session = window.__session.savedSessions.find(s => s.id === 'older');
            session.lastUpdated = session.lastMessageAt = Date.now();
            window.__session.openTabs.find(t => t.descriptor.sessionId === 'newer').isLoading = false;
          });
          await page.waitForTimeout(500);
          assert.equal(await page.locator('.row-title').first().innerText(), 'newer', 'a second reorder cannot occur inside five seconds');
          await page.waitForFunction(() => document.querySelector('.row-title')?.textContent === 'older');
        }
        await page.getByRole('button', { name: 'Load sessions from all agents', exact: true }).click();
        await page.waitForFunction(() => !window.__session.isSyncingSessions);
        assert.equal(await page.locator('.row-title').first().innerText(), 'older', 'stale inventory cannot override a fresh message');
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('acp-ui:sessions.json')).sessions.find(s => s.id === 'older').lastMessageAt > 1700000060000);
        for (const theme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: theme });
          const close = page.getByRole('button', { name: 'Archive session', exact: true }).first();
          const box = await close.boundingBox();
          assert(box.width >= 44 && box.height >= 44);
          const glyph = close.locator('svg');
          assert.equal(await glyph.count(), 1, 'close uses a readable icon rather than a tiny text glyph');
          const glyphBox = await glyph.boundingBox();
          assert.equal(glyphBox.width, 18, 'close icon stays compact');
          assert.equal(glyphBox.height, 18, 'close icon stays compact');
          assert.match(await glyph.locator('path').getAttribute('d'), /M4 8v12/, 'mobile archive uses an archive icon instead of a tab-close X');
          await close.focus();
          await page.keyboard.press('Tab');
          await close.focus();
          assert.equal(await close.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
          const refresh = page.getByRole('button', { name: 'Load sessions from all agents', exact: true });
          await page.evaluate(() => { window.__session.isSyncingSessions = true; });
          assert(await refresh.isDisabled());
          assert.equal(await refresh.evaluate(e => getComputedStyle(e).opacity), '0.5');
          await page.evaluate(() => { window.__session.isSyncingSessions = false; });
        }
        await page.screenshot({ path: `/tmp/acp-sessions-page-${width}.png` });
        await page.locator('.session-row').filter({ hasText: 'newer' }).locator('.row-title').click();
        await page.waitForFunction(() => window.__session.activeRuntime.descriptor.sessionId === 'newer');
        assert(!await sidebar.isVisible());
        await page.locator('.chat-view:visible textarea').fill('Other draft');
        await menu.click();
        await page.locator('.session-row').filter({ hasText: 'older' }).locator('.row-title').click();
        assert.equal(await field.inputValue(), 'Preserved draft');
        await page.waitForTimeout(150);
        assert(Math.abs(await page.evaluate(() => scrollY) - historyTop) <= 2, 'returning through the sessions page restores history position');
        await page.goBack();
        await sidebar.waitFor();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sidebar.waitFor();
        await page.waitForFunction(() => window.__session?.openTabs.length === 2 && window.__session.openTabs.every(t => t.isConnected));
        assert.equal(Math.round((await sidebar.boundingBox()).width), width, 'session page survives reload');
        await assertPlainSessionList();
        await page.evaluate(() => {
          window.qaOriginalArchive = window.__session.archiveSession;
          window.__session.archiveSession = async () => { await new Promise(resolve => setTimeout(resolve, 300)); throw new Error('Test archive failure'); };
        });
        const archiveButton = page.getByRole('button', { name: 'Archive session', exact: true }).first();
        await archiveButton.click();
        assert(await archiveButton.isDisabled(), 'archive action prevents repeated clicks while pending');
        await page.getByRole('alert').filter({ hasText: 'Test archive failure' }).waitFor();
        assert.equal(await page.locator('.session-row').count(), 2, 'failed archive leaves the session visible');
        await page.evaluate(() => { window.__session.archiveSession = window.qaOriginalArchive; });
        await page.getByRole('button', { name: 'Archive session', exact: true }).first().click({ position: { x: 4, y: 4 } });
        assert(await sidebar.isVisible(), 'archiving does not open the row');
        assert.equal(await page.locator('.session-row').count(), 1, 'archived chat disappears from history');
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('acp-ui:sessions.json')).sessions.some(s => s.archivedAt));
        const archived = await page.evaluate(() => window.__session.savedSessions.find(s => s.archivedAt));
        assert(archived, 'archiving retains metadata instead of deleting history');
        await page.getByRole('button', { name: 'Load sessions from all agents', exact: true }).click();
        await page.waitForFunction(() => !window.__session.isSyncingSessions);
        assert.equal(await page.locator('.session-row').count(), 1, 'inventory refresh cannot resurrect an archived chat');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sidebar.waitFor();
        await page.waitForFunction(() => window.__session?.openTabs.every(t => t.isConnected));
        assert.equal(await page.locator('.session-row').count(), 1, 'archive survives reload');
        assert.equal(await page.evaluate(() => window.__session.openTabs.length), 1, 'archived tab is not restored');
        await page.getByRole('button', { name: 'Show archived sessions', exact: true }).click();
        assert.equal(await page.locator('.session-row').count(), 1);
        assert.equal(await page.locator('.row-title').innerText(), archived.title);
        if (width === 390) await page.screenshot({ path: '/tmp/acp-session-archive-390.png' });
        await page.getByRole('button', { name: 'Restore session', exact: true }).click();
        await page.getByRole('button', { name: 'Show active sessions', exact: true }).click();
        assert.equal(await page.locator('.session-row').count(), 2, 'restore returns history to the main list');
        // A session with no open tab is also archivable.
        await page.locator('.session-row').filter({ hasText: archived.title }).getByRole('button', { name: 'Archive session', exact: true }).click();
        assert.equal(await page.locator('.session-row').count(), 1);
        await page.getByRole('button', { name: 'Show archived sessions', exact: true }).click();
        await page.getByRole('button', { name: 'Restore session', exact: true }).click();
        await page.getByRole('button', { name: 'Show active sessions', exact: true }).click();
        assert.equal(await page.locator('.row-close').count(), 2, 'all history rows have archive controls');
        await page.evaluate(() => { const rt = window.__session.openTabs[0]; rt.session.supportsLoadSession = false; const saved = window.__session.savedSessions.find(s => s.id === rt.session.id); saved.supportsLoadSession = false; saved.title = 'porch-delegate# explicitly restored'; });
        assert.equal(await page.locator('.row-close').count(), 2, 'open non-resumable session remains archivable');
        const unsupportedId = await page.evaluate(() => window.__session.openTabs[0].session.id);
        await page.locator(`[data-session-id="${unsupportedId}"]`).getByRole('button', { name: 'Archive session', exact: true }).click();
        await page.getByRole('button', { name: 'Show archived sessions', exact: true }).click();
        await page.getByRole('button', { name: 'Restore session', exact: true }).click();
        await page.getByRole('button', { name: 'Show active sessions', exact: true }).click();
        const unavailable = page.locator(`[data-session-id="${unsupportedId}"]`);
        assert(await unavailable.isVisible(), 'explicit restore keeps non-resumable and prefix-hidden session discoverable');
        assert.equal(await unavailable.locator('.row-status').innerText(), 'Cannot reopen');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sidebar.waitFor();
        await unavailable.waitFor();
        // With all tabs archived the chat component (and its test seam) is absent.
        // Open a supported history row through the UI before creating a new tab.
        await page.locator('.session-row').filter({ hasText: 'older' }).locator('.row-title').click();
        await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected);
        await menu.click();

        await page.evaluate(() => { window.qaCreation = window.__session.createSession('E2E', '/tmp').catch(() => {}); });
        const creating = page.locator('.session-row').filter({ hasText: 'New session' });
        await creating.locator('.row-status.working').waitFor();
        assert.equal(await sidebar.locator('.startup-progress').count(), 0, 'mobile list does not show a current-tab startup panel');
        await creating.locator('.row-status.error').waitFor();
        assert.equal(await creating.locator('.row-status').getAttribute('title'), 'Test creation failure');
        await page.locator('.session-row').filter({ hasText: 'older' }).locator('.row-title').click();
        await menu.click();
        await creating.locator('.row-title').click();
        assert.equal(await page.locator('.main-area .error-text').innerText(), 'Test creation failure', 'failed new runtime can be opened again');
        await menu.click();
        await creating.getByRole('button', { name: 'Cancel session creation', exact: true }).click();
        assert.equal(await creating.count(), 0, 'failed unsaved session remains closable');
        assert(await page.getByRole('button', { name: 'New session', exact: true }).isVisible());
        await page.getByRole('button', { name: 'New session', exact: true }).click();
        await page.locator('.ns-overlay').waitFor();
        await page.locator('.ns-overlay').getByRole('button', { name: 'Cancel', exact: true }).click();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        if (width === 390) {
          await page.evaluate(() => localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [], openTabs: [] })));
          await page.goto(`${base}/projects`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('button', { name: 'Open menu', exact: true }).waitFor();
          await page.waitForTimeout(250);
          assert(!await page.locator('#app-sidebar').isVisible(), 'direct Projects load is not covered by an empty sessions page');
          await page.goto(`${base}/chat`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('button', { name: 'Open menu', exact: true }).waitFor();
          assert.equal(await page.locator('.welcome-new-session').count(), 0, 'empty mobile chat uses the sessions list for creation');
          await page.getByRole('button', { name: 'Open menu', exact: true }).click();
          await page.locator('#app-sidebar').waitFor();
          assert(await page.getByRole('button', { name: 'New session', exact: true }).isVisible(), 'empty sessions page offers creation');
        }
      } else {
        assert.equal(await page.locator('.tab-strip [role="tab"]').count(), 2, 'desktop tabs retained');
        const activeTab = page.locator('.session-tab').filter({ has: page.locator('[role="tab"][aria-selected="true"]') });
        assert(await activeTab.evaluate(e => e.classList.contains('ui-action-row')), 'tab title and close share the library tile');
        assert.equal(await activeTab.evaluate(e => getComputedStyle(e).borderTopStyle), 'solid', 'the whole tab owns the frame');
        assert.equal(await activeTab.locator('[role="tab"]').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'tab title has no independent fill');
        await page.evaluate(() => { window.__session.activeRuntime.session.title = 'A long session title '.repeat(20); });
        await page.waitForFunction(() => document.querySelector('.tab[aria-selected="true"] .tab-title')?.textContent.length > 100);
        assert(await activeTab.locator('.tab-title').evaluate(e => e.scrollWidth > e.clientWidth), 'long tab titles truncate before the close action');
        const tabBox = await activeTab.boundingBox(), tabClose = await activeTab.locator('.tab-close').boundingBox();
        assert(tabBox.width <= 220, 'the width limit includes the close action');
        assert(tabClose.x >= tabBox.x && tabClose.x + tabClose.width <= tabBox.x + tabBox.width - 1, 'tab cross is inside its frame');
        assert.equal(await page.locator('.session-tab button button').count(), 0, 'tab and close remain separate buttons');
        await page.locator('.tab-strip').screenshot({ path: `/tmp/acp-session-tabs-${width}.png` });
        await page.evaluate(() => { window.__session.activeRuntime.session.title = 'older'; });
        const desktopClose = page.locator('.row-close').first();
        const glyph = await desktopClose.locator('svg').boundingBox();
        assert.equal(glyph.width, 12, 'desktop session close glyph stays small beside session text');
        assert.equal(glyph.height, 12);
        const target = await desktopClose.boundingBox();
        assert(target.width >= 24 && target.height >= 24, 'a smaller glyph retains its button target');
        assert.equal(await page.locator('.session-navigation [aria-label="New session"]').count(), 1, 'desktop creation stays in its tab bar');
        assert.equal(await page.locator('.session-open[aria-pressed="true"]').count(), 1, 'desktop keeps its current-tab selection');
        const selectedRow = page.locator('.session-row.active');
        assert.equal(await selectedRow.evaluate(e => getComputedStyle(e).borderTopStyle), 'solid', 'the session tile owns the selected frame');
        assert.notEqual(await selectedRow.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'selection fills the entire session tile');
        assert.equal(await selectedRow.locator('.session-open').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'primary action has no separate selected tile');
        const tile = await selectedRow.boundingBox(), trailing = await selectedRow.locator('.row-close').boundingBox();
        assert(trailing.x >= tile.x && trailing.x + trailing.width <= tile.x + tile.width - 1, 'the cross is inside the selected tile');
        assert(tile.x + tile.width - trailing.x - trailing.width <= 6, 'no empty strip to the right of the action');
        const insets = await selectedRow.evaluate(row => {
          const tile = row.getBoundingClientRect();
          const content = row.querySelector('.row-content').getBoundingClientRect();
          const svg = row.querySelector('.row-close svg');
          const path = svg.querySelector('path').getBBox();
          const icon = svg.getBoundingClientRect();
          const paintedRight = icon.left + (path.x + path.width) * icon.width / svg.viewBox.baseVal.width;
          return { left: content.left - tile.left, right: tile.right - paintedRight };
        });
        assert(Math.abs(insets.left - insets.right) <= 0.5, `session contents have equal horizontal insets: ${JSON.stringify(insets)}`);
        const stamp = await selectedRow.locator('.row-stamp').boundingBox();
        assert(trailing.x - stamp.x - stamp.width <= 10, 'metadata and trailing action stay close');
        await page.locator('#app-sidebar').screenshot({ path: `/tmp/acp-session-tile-${width}.png` });
        // A classic scrollbar consumes layout width; overlay scrollbars do not.
        // Force overflow to cover long histories even with this two-row fixture.
        const scrollArea = page.locator('#app-sidebar .sidebar-content');
        await scrollArea.evaluate(e => e.style.maxHeight = '100px');
        await selectedRow.scrollIntoViewIfNeeded();
        const outer = await selectedRow.evaluate(row => {
          const sidebar = document.querySelector('#app-sidebar');
          const box = sidebar.getBoundingClientRect(), tile = row.getBoundingClientRect();
          const border = parseFloat(getComputedStyle(sidebar).borderRightWidth);
          const scroll = row.closest('.sidebar-content');
          return { left: tile.left - box.left, right: box.right - border - tile.right,
            overflowing: scroll.scrollHeight > scroll.clientHeight };
        });
        assert(outer.overflowing, 'the spacing check includes an overflowing history');
        assert(Math.abs(outer.left - outer.right) <= 0.5, `outer session margins match with a scrollbar: ${JSON.stringify(outer)}`);
        await scrollArea.evaluate(e => e.style.removeProperty('max-height'));
        const primary = selectedRow.locator('.session-open');
        await page.keyboard.press('Tab'); await primary.focus();
        assert.equal(await primary.evaluate(e => getComputedStyle(e).outlineOffset), '-2px', 'primary focus stays visible inside the shared tile');
        await selectedRow.locator('.row-close').focus();
        assert.equal(await selectedRow.locator('.row-close').evaluate(e => getComputedStyle(e).outlineOffset), '-2px', 'trailing focus stays inside the tile after removing its extra inset');
        assert.equal(await page.locator('.session-row button button').count(), 0, 'tile actions remain separate native buttons');
        assert.equal(await page.locator('.row-open').count(), 2, 'desktop keeps open-tab indicators');
        assert(await page.locator('.row-status.open').count() >= 1, 'desktop keeps open-tab status');
        assert((await page.locator('#app-sidebar').boundingBox()).width < 600);
        const newerTab = page.locator('.session-tab').filter({ has: page.getByRole('tab', { name: 'newer', exact: true }) });
        await newerTab.hover();
        assert.equal(await newerTab.locator('.tab-close').evaluate(e => getComputedStyle(e).opacity), '1', 'hover reveals the close action inside the whole tab');
        await newerTab.locator('.tab-close').focus();
        assert.equal(await newerTab.locator('.tab-close').evaluate(e => getComputedStyle(e).outlineOffset), '-2px', 'tab close focus is not clipped');
        await newerTab.locator('.tab-close').click();
        assert.equal(await page.getByRole('tab').count(), 1);
        assert.equal(await page.getByRole('tab', { name: 'older', exact: true }).getAttribute('aria-selected'), 'true', 'closing an inactive tab preserves the active tab');
        const newerRow = page.locator('.session-row[data-session-id="newer"] .session-open');
        assert(await newerRow.isVisible(), 'closing a tab keeps its session in history');
        await newerRow.click();
        await page.getByRole('tab', { name: 'newer', exact: true }).waitFor();
        await newerTab.locator('.tab-close').click();
        assert.equal(await page.getByRole('tab', { name: 'older', exact: true }).getAttribute('aria-selected'), 'true', 'closing the active tab selects the remaining tab');
        await newerRow.click();
        await page.getByRole('tab', { name: 'newer', exact: true }).waitFor();
        await page.getByRole('tab', { name: 'older', exact: true }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => document.querySelector('.app-container.narrow-layout') && !document.querySelector('.session-open[aria-pressed]'));
        assert.equal(await page.locator('.session-row.active,.row-open,.row-status.open').count(), 0, 'switching to narrow layout removes all tab markers');
        await page.setViewportSize({ width, height: 844 });
        await page.waitForFunction(() => !!document.querySelector('.session-open[aria-pressed="true"]'));
        assert.equal(await page.locator('.row-open').count(), 2, 'desktop tab markers return after widening');
        await page.locator('.session-row').first().hover();
        await page.getByRole('button', { name: 'Archive session', exact: true }).first().click();
        assert.equal(await page.locator('.session-row').count(), 1, 'desktop X also archives');
        await page.getByRole('button', { name: 'Show archived sessions', exact: true }).click();
        assert.equal(await page.locator('.session-row').count(), 1);
        await page.getByRole('button', { name: 'Restore session', exact: true }).click();
        await page.getByRole('button', { name: 'Show active sessions', exact: true }).click();
        assert.equal(await page.locator('.session-row').count(), 2);

      }
      assert.deepEqual(errors, []);
      assert.deepEqual(failed, []);
      await context.close();
      console.log(`PASS ${width}: navigation, statuses, message order, drafts, reload, archive/restore, layout`);
    }
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
