// Real composer/runtime/ACP transport; only the agent and state boundaries are deterministic.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
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
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
    }
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
    for (const width of [390, 1920]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: width < 800, isMobile: width < 800, viewport: { width, height: 1080 } });
      await context.addInitScript(() => {
        if (sessionStorage.getItem('outbox-fixture')) return;
        sessionStorage.setItem('outbox-fixture', '1');
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { E2E: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: ['one', 'two'].map(id => ({ id, sessionId: id, agentName: 'E2E', cwd: '/tmp', title: id, lastUpdated: 1700000000000, supportsLoadSession: true })), openTabs: ['one', 'two'].map(sessionId => ({ agentName: 'E2E', sessionId })) }));
      });
      await context.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await context.route('**/api/**', r => r.fulfill({ json: { root: '/tmp', dirs: [], projects: [], sessions: [], cards: [] } }));
      const calls = [], pending = [], sockets = new Map();
      let nativeSupported = true;
      const profile = process.env.DELIVERY_PROFILE || 'native';
      await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
        const q = JSON.parse(String(message));
        if (q.method) calls.push(q);
        if (q.params?.sessionId) sockets.set(q.params.sessionId, ws);
        if (!q.method || q.id == null) return;
        if (q.params?.prompt?.some(p => p.text?.includes('bad-steer'))) { ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'Injected steer failure' } })); return; }
        if (q.method === 'session/prompt' && q.params.prompt[0]?.text.startsWith('/steer ')) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { stopReason: 'end_turn' } })); return;
        }
        if (q.method === 'session/prompt') {
          if (q.params.prompt.some(p => p.text === 'fail')) { ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'Injected delivery failure' } })); return; }
          pending.push({ q, ws }); return;
        }
        if (q.method === 'session/load') ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: q.params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: `history-${q.params.sessionId}`, title: 'Replayed tool', status: 'completed' } } }));
        let result = {};
        if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, ...(nativeSupported && profile === 'native' ? { _meta: { steering: { supported: true } } } : {}), agentInfo: !nativeSupported ? { name: 'Unknown' } : profile === 'hermes' ? { name: 'hermes-agent' } : profile === 'opencode' ? { name: 'OpenCode' } : profile === 'devin' ? { name: 'affogato', title: 'Devin Agent' } : { name: 'E2E' }, authMethods: [] };
        if (q.method === '_session/steering') result = { outcome: 'injected' };
        setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result })), 20);
      }));
      const page = await context.newPage(), errors = [], failed = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
      const isSteer = q => q.method === '_session/steering' || (q.method === 'session/prompt' && /^(Steering update:|\/steer )/.test(q.params.prompt[0]?.text ?? ''));
      const promptCalls = () => calls.filter(q => q.method === 'session/prompt' && !isSteer(q));
      const steeringCalls = () => calls.filter(isSteer);
      function emit(sid, update) { sockets.get(sid).send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update } })); }
      function finish(sid) { const turn = pending.filter(p => p.q.params.sessionId === sid); assert(turn.length); for (const { q, ws } of turn) { pending.splice(pending.findIndex(p => p.q.id === q.id && p.ws === ws), 1); ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { stopReason: 'end_turn' } })); } }
      async function waitCount(fn, count) { const end = Date.now() + 5000; while (fn().length !== count && Date.now() < end) await page.waitForTimeout(20); assert.equal(fn().length, count); }
      async function selectSession(sid) {
        if (width < 800) { await page.getByRole('button', { name: 'Open menu', exact: true }).click(); await page.locator(`[data-session-id="${sid}"] .session-open`).click(); }
        else {
          const index = await page.evaluate(id => window.__session.openTabs.findIndex(t => (t.session ?? t.descriptor)?.sessionId === id), sid);
          assert(index >= 0); await page.locator('.tab-strip [role="tab"]').nth(index).click();
        }
      }
      const field = page.locator('.chat-view:visible textarea');
      const mode = page.getByRole('button', { name: /^Send mode:/ });
      async function choose(name) { await mode.click(); await page.getByRole('option', { name: new RegExp('^' + name) }).click(); }
      async function send(text) { await field.fill(text); await page.locator('.chat-view:visible .composer-primary').click(); }
      await page.goto(`${base}/chat?s=E2E%3A%3Aone`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.openTabs.every(t => t.isConnected));
      assert.equal(await mode.count(), 1, 'small dropdown is next to the send button');
      assert.equal(await mode.getAttribute('aria-label'), 'Send mode: Queue', 'Queue is the default');
      await send('work'); await waitCount(promptCalls, 1);
      await page.locator('.chat-view:visible input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment stays queued') });
      await send('later one'); await send('later two');
      assert.equal(await page.locator('.chat-view:visible [data-pending-id]').count(), 2);
      emit('one', { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', status: 'completed' });
      await page.waitForTimeout(100); assert.equal(promptCalls().length, 1, 'Queue ignores tool boundaries');
      await selectSession('two'); await send('other work'); await waitCount(promptCalls, 2);
      finish('one'); await waitCount(promptCalls, 3);
      assert.equal(promptCalls()[2].params.sessionId, 'one', 'a background queue stays with its own session');
      assert(promptCalls()[2].params.prompt.some(p => p.type === 'resource' && p.resource.text.includes('Attachment stays queued')));
      finish('one'); await waitCount(promptCalls, 4); assert.equal(promptCalls()[3].params.prompt[0].text, 'later two'); finish('one');
      await selectSession('one'); await choose('Steer'); await send('work with steer'); await waitCount(promptCalls, 5);
      await page.locator('.chat-view:visible input[type="file"]').setInputFiles({ name: 'steer.txt', mimeType: 'text/plain', buffer: Buffer.from('Steer context file') });
      await send('correct the next step'); await page.waitForTimeout(100); assert.equal(steeringCalls().length, 0);
      sockets.get('one').send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'two',
        update: { sessionUpdate: 'tool_call', toolCallId: 'foreign', title: 'Foreign tool', status: 'completed' } } }));
      await page.waitForTimeout(50); assert.equal(steeringCalls().length, 0, 'another session cannot release this Steer');
      emit('one', { sessionUpdate: 'tool_call', toolCallId: 'run', title: 'Run', status: 'in_progress' });
      await page.waitForTimeout(50); assert.equal(steeringCalls().length, 0, 'Steer does not interrupt a running tool');
      emit('one', { sessionUpdate: 'tool_call_update', toolCallId: 'run', status: 'completed' });
      await waitCount(steeringCalls, 1); assert(steeringCalls()[0].params.prompt[0].text.includes('correct the next step'));
      assert(steeringCalls()[0].params.prompt.some(p => p.text?.includes('Steer context file') || p.resource?.text?.includes('Steer context file')), 'Steer keeps file context');
      if (profile === 'hermes') assert(steeringCalls()[0].params.prompt.every(p => p.type === 'text'), 'Hermes stays on its safe slash-command route');
      assert.equal(calls.filter(q => q.method === 'session/cancel').length, 0, 'Steer never cancels');
      await send('another correction');
      emit('one', { sessionUpdate: 'tool_call_update', toolCallId: 'run', status: 'completed' });
      await page.waitForTimeout(100); assert.equal(steeringCalls().length, 1, 'a repeated terminal frame is not another completed tool');
      emit('one', { sessionUpdate: 'tool_call', toolCallId: 'next', title: 'Next', status: 'failed' });
      await waitCount(steeringCalls, 2);

      await choose('Queue'); await send('after the steered response'); await page.waitForTimeout(100);
      assert.equal(promptCalls().length, 5, 'steering ACK is not turn completion');
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme }); await page.keyboard.press('Tab'); await mode.focus();
        assert.equal(await mode.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
        const trigger = await mode.boundingBox(), primary = await page.locator('.chat-view:visible .composer-primary').boundingBox();
        assert(trigger.x + trigger.width <= primary.x, 'dropdown and Send do not overlap');
        if (width < 800) assert(trigger.height >= 44, 'touch target remains large');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await page.locator('.chat-view:visible .input-container').screenshot({ path: `/tmp/acp-outbox-${width}.png` });
      finish('one'); await waitCount(promptCalls, 6); finish('one'); await page.waitForTimeout(30);
      await send('work to stop'); await waitCount(promptCalls, 7); await send('remove me');
      await page.getByRole('button', { name: 'Remove pending message', exact: true }).click();
      await send('paused followup'); await page.getByRole('button', { name: 'Stop response', exact: true }).click();
      assert.equal(calls.filter(q => q.method === 'session/cancel').length, 1);
      finish('one'); await page.waitForTimeout(100); assert.equal(promptCalls().length, 7, 'Stop keeps the queue paused');
      await page.getByRole('button', { name: 'Resume queue', exact: true }).click(); await waitCount(promptCalls, 8); finish('one');
      await page.waitForTimeout(40); await send('fail'); await waitCount(promptCalls, 9);
      await page.getByRole('alert').filter({ hasText: 'Injected delivery failure' }).waitFor();
      assert(await page.getByRole('button', { name: 'Resume queue', exact: true }).isDisabled(), 'failed delivery never automatically retries');
      await page.getByRole('button', { name: 'Remove pending message', exact: true }).click();
      await send('work with rejection'); await waitCount(promptCalls, 10);
      await send('keep after rejected steer'); await choose('Steer'); await send('bad-steer');
      emit('one', { sessionUpdate: 'tool_call', toolCallId: 'reject', title: 'Rejection boundary', status: 'completed' });
      await page.getByRole('alert').filter({ hasText: 'Injected steer failure' }).waitFor();
      finish('one'); await page.waitForTimeout(100);
      assert.equal(promptCalls().length, 10, 'concurrent Steer rejection pauses before any queued prompt can drain');
      await page.locator('.chat-view:visible [data-pending-id]').filter({ hasText: 'bad-steer' }).getByRole('button', { name: 'Remove pending message' }).click();
      await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
      await waitCount(promptCalls, 11); finish('one'); await choose('Queue');
      await send('work before reload'); await waitCount(promptCalls, 12); await send('saved queue');
      const beforeReload = promptCalls().length;
      nativeSupported = false;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected);
      await page.getByText('Queue restored. Resume when the agent is ready.').waitFor();
      assert.equal(promptCalls().length, beforeReload, 'reload never automatically resends queued messages');
      assert.equal(await mode.getAttribute('aria-label'), 'Send mode: Queue');
      await mode.click(); assert(await page.getByRole('option', { name: /^Steer/ }).isDisabled(), 'unknown agents do not silently fall back to cancel');
      await page.keyboard.press('Escape');
      await page.locator('.chat-view:visible [aria-label^="Send mode:"][aria-expanded="false"]').waitFor();
      assert.deepEqual(errors, []); assert.deepEqual(failed, []);
      await context.close(); console.log(`PASS ${profile} ${width}: Queue default/FIFO/files, Steer boundary/no cancel, session isolation, Stop/remove/failure, reload, theme/focus/touch`);
    }
  } finally { await browser?.close(); if (server) await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
