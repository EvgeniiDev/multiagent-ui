// Real state HTTP adapter/CAS storage; only ACP is a fixture. No model calls.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
(async () => {
 let browser, stateServer, webServer;
 const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-status-cas-'));
 try {
  const { createStateService } = await import(pathToFileURL(path.resolve(__dirname, '../server/execution/state-service.mjs')));
  const { createRequestHandler } = await import(pathToFileURL(path.resolve(__dirname, '../server/acp-state-server.mjs')));
  const service = await createStateService({ stateDir, env: {} });
  const { createChatSessionStatusReader } = await import(pathToFileURL(path.resolve(__dirname, '../server/chat-session-statuses.mjs')));
  const nativeRoot = path.join(stateDir, 'codex-sessions');
  const nativeDir = path.join(nativeRoot, '2026/10/18');
  fs.mkdirSync(nativeDir, { recursive: true });
  const nativeFile = path.join(nativeDir, 'rollout-2026-10-18T07-09-54-01a14dd8-7645-70b3-a569-f031dc1aa8ea.jsonl');
  const nativeEvent = (type, at) => JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type, turn_id: 'native-turn' } }) + '\n';
  stateServer = createServer(createRequestHandler(service, { sessionStatusReader: createChatSessionStatusReader({ root: nativeRoot, indexMs: 0 }) }));
  await new Promise(resolve => stateServer.listen(0, '127.0.0.1', resolve));
  const stateBase = `http://127.0.0.1:${stateServer.address().port}`;
  async function read(name) { const r = await fetch(`${stateBase}/api/state/${name}`); if (r.status === 404) return { rev: 0, data: {} }; assert.equal(r.status, 200); return await r.json(); }
  async function put(name, data) {
   for (let attempt = 0; attempt < 8; attempt++) {
    const current = await read(name);
    const r = await fetch(`${stateBase}/api/state/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: current.rev, data }) });
    if (r.status === 409) continue;
    assert.equal(r.status, 200); return;
   }
   assert.fail('state CAS conflicts did not settle');
  }
  let base = process.env.UI_TEST_URL;
  if (!base) {
   assert(process.env.BUILD, 'Set BUILD or UI_TEST_URL');
   webServer = createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(process.env.BUILD, name.startsWith('/assets/') ? name : 'index.html');
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream');
    try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404); res.end(); }
   });
   await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve));
   base = `http://127.0.0.1:${webServer.address().port}`;
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  for (const width of [390, 1440]) {
   const saved = { id: '01a14dd8-7645-70b3-a569-f031dc1aa8ea', sessionId: '01a14dd8-7645-70b3-a569-f031dc1aa8ea', agentName: 'Codex', title: 'Remote persistence', cwd: '/tmp', lastUpdated: 1, supportsLoadSession: true };
   const initial = { sessions: [saved], openTabs: [{ agentName: 'Codex', sessionId: '01a14dd8-7645-70b3-a569-f031dc1aa8ea' }] };
   fs.rmSync(nativeFile, { force: true });
   await put('sessions.json', initial);
   await put('activity.json', { entries: [{ id: 'legacy-start', kind: 'turn-start', at: 1, agentName: 'Codex', sessionId: '01a14dd8-7645-70b3-a569-f031dc1aa8ea' }], usage: [] });
   await put('session-statuses.json', { statuses: { [JSON.stringify(['Codex', '01a14dd8-7645-70b3-a569-f031dc1aa8ea'])]: { status: null, at: 1 } } });
   const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, hasTouch: width < 800, isMobile: width < 800 });
   await context.addInitScript(() => {
    localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { Codex: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
    localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ telemetryEnabled: false }));
   });
   const page = await context.newPage(); page.setDefaultTimeout(12000);
   const errors = []; page.on('pageerror', e => errors.push(e.message));
   await context.route('**/health', async route => route.fulfill({ response: await route.fetch({ url: `${stateBase}/health` }) }));
   await context.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/state/') || u.pathname === '/api/chat-session-statuses') return route.fulfill({ response: await route.fetch({ url: stateBase + u.pathname }) });
    return route.fulfill({ json: { root: '/tmp', dirs: [], projects: [], cards: [], usage: [], sources: [] } });
   });
   let pending, liveSocket;
   await context.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
    const q = JSON.parse(String(message)); if (!q.method || q.id == null) return;
    if (q.method === 'session/prompt') { pending = { ws, q }; return; }
    let result = {};
    if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
    if (q.method === 'session/load') liveSocket = ws;
    if (q.method === 'session/load') ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: '01a14dd8-7645-70b3-a569-f031dc1aa8ea', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Existing transcript' } } } }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
    if (q.method === 'session/load') setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: '01a14dd8-7645-70b3-a569-f031dc1aa8ea', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } })), 40);
   }));
   await page.goto(`${base}/chat?s=Codex%3A%3A01a14dd8-7645-70b3-a569-f031dc1aa8ea`, { waitUntil: 'domcontentloaded' });
   await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected);
   assert.equal(await page.evaluate(() => window.__session.activeRuntime.turnStatus), null, 'missing UI response does not prove the agent is still working');
   await page.locator('.chat-view:visible textarea').fill('Complete the remote persistence test');
   await page.getByRole('button', { name: 'Send', exact: true }).click();
   await page.waitForFunction(() => window.__session.activeRuntime.isLoading);
   assert(pending);
   pending.ws.send(JSON.stringify({ jsonrpc: '2.0', id: pending.q.id, result: { stopReason: 'end_turn' } }));
   await page.waitForFunction(() => window.__session.activeRuntime.turnCompleted);
   // Wait for ordinary saves before reproducing a stale client's inventory write.
   await page.waitForTimeout(1800);
   const doc = await read('sessions.json');
   const stale = structuredClone(doc.data);
   for (const session of stale.sessions) { delete session.lastTurnStatus; delete session.lastTurnStatusAt; }
   await put('sessions.json', stale);
   await page.reload({ waitUntil: 'domcontentloaded' });
   await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected);
   await page.waitForFunction(() => window.__session.activeRuntime.turnCompleted, {}, { timeout: 4000 });
   const row = page.locator('.session-row[data-session-id="01a14dd8-7645-70b3-a569-f031dc1aa8ea"]');
   if (!await row.isVisible()) await page.getByRole('button', { name: width < 800 ? 'Open menu' : 'Expand sidebar', exact: true }).click();
   await row.locator('.row-status.completed').waitFor();
   assert.equal(await page.getByText('Unread reply', { exact: true }).count(), 0);
   assert.equal(await page.locator('[title="Unread reply"]').count(), 0);
   const durable = await read('session-statuses.json');
   assert.equal(durable.data.statuses[JSON.stringify(['Codex', '01a14dd8-7645-70b3-a569-f031dc1aa8ea'])].status, 'completed');
   liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: '01a14dd8-7645-70b3-a569-f031dc1aa8ea', update: { sessionUpdate: 'tool_call', toolCallId: 'continued-work', title: 'Working after reconnect', kind: 'execute', status: 'in_progress' } } }));
   await page.waitForFunction(() => window.__session.activeRuntime.turnCompleted === false);
   assert.equal(await row.locator('.row-status.completed').count(), 0);
   assert.equal(await page.locator('.tab-completed').count(), 0);
   await page.waitForTimeout(300);
   const live = await read('session-statuses.json');
   assert.equal(live.data.statuses[JSON.stringify(['Codex', '01a14dd8-7645-70b3-a569-f031dc1aa8ea'])].status, 'working');
   await row.locator('.row-status.working').waitFor();
   if (width >= 800) await page.locator('.tab-spin').waitFor();
   await page.reload({ waitUntil: 'domcontentloaded' });
   await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected);
   assert.equal(await page.evaluate(() => window.__session.activeRuntime.turnCompleted), false, 'live reset survives reload');
   if (!await row.isVisible()) await page.getByRole('button', { name: width < 800 ? 'Open menu' : 'Expand sidebar', exact: true }).click();
   assert.equal(await row.locator('.row-status.working').count(), 0, 'restored work requires provider evidence');
   await put('session-statuses.json', { statuses: { [JSON.stringify(['Codex', '01a14dd8-7645-70b3-a569-f031dc1aa8ea'])]: { status: 'cancelled', at: 1 } } });
   await page.evaluate(() => localStorage.clear());
   await page.reload({ waitUntil: 'domcontentloaded' });
   await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected && window.__session.activeRuntime.turnIssue === 'cancelled');
   // A fresh page with no local backup can also recover older recorded results
   // from the real shared activity document, without reading transcript text.
   await put('session-statuses.json', { statuses: {} });
   await page.evaluate(() => localStorage.clear());
   await page.reload({ waitUntil: 'domcontentloaded' });
   await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected && window.__session.activeRuntime.turnCompleted);
   const recovered = await read('session-statuses.json');
   assert.equal(recovered.data.statuses[JSON.stringify(['Codex', '01a14dd8-7645-70b3-a569-f031dc1aa8ea'])].status, 'completed');

   const nativeAt = Date.now() - 60000;
   fs.writeFileSync(nativeFile, nativeEvent('task_started', nativeAt - 1000) + nativeEvent('task_complete', nativeAt));
   await put('session-statuses.json', { statuses: { [JSON.stringify(['Codex', '01a14dd8-7645-70b3-a569-f031dc1aa8ea'])]: { status: 'working', at: Date.now() } } });
   await page.evaluate(() => localStorage.clear());
   await page.reload({ waitUntil: 'domcontentloaded' });
   await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected && window.__session.activeRuntime.turnCompleted);
   if (!await row.isVisible()) await page.getByRole('button', { name: width < 800 ? 'Open menu' : 'Expand sidebar', exact: true }).click();
   await row.locator('.row-status.completed').waitFor();
   fs.appendFileSync(nativeFile, nativeEvent('task_started', Date.now()));
   await row.locator('.row-status.working').waitFor();
   fs.appendFileSync(nativeFile, nativeEvent('task_complete', Date.now()));
   await row.locator('.row-status.completed').waitFor();
   await page.reload({ waitUntil: 'domcontentloaded' });
   await page.waitForFunction(() => window.__session?.activeRuntime?.isConnected && window.__session.activeRuntime.turnCompleted);

   assert.deepEqual(errors, []);
   console.log(`PASS ${width}px: real state HTTP/CAS, completion survives reload, live work clears completion durably, no unread status`);
   await context.unrouteAll({ behavior: 'ignoreErrors' });
   await context.close();
  }
 } finally {
  await browser?.close();
  if (webServer) await new Promise(resolve => webServer.close(resolve));
  if (stateServer) await new Promise(resolve => stateServer.close(resolve));
  fs.rmSync(stateDir, { recursive: true, force: true });
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
