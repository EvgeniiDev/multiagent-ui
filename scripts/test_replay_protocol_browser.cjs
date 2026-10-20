// Real frontend + real bridge + deterministic ACP child; no provider or state writes.
// PLAYWRIGHT_MODULE selects an installed Playwright; BUILD selects built assets.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const build = process.env.BUILD || path.join(root, 'dist-web');
(async () => {
  const { testEnv, runCommand, boundPort, stopTestBridge } = await import('./bridge-test-harness.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-replay-browser-'));
  const services = [];
  let browser;
  try {
    async function bridge(name, cap) {
      const home = path.join(dir, name); fs.mkdirSync(home);
      const env = { ...await testEnv(home), ...(cap ? { ACP_REPLAY_BUFFER_CAP_BYTES: String(cap) } : {}) };
      const service = runCommand(path.join(root, 'deploy/acp-bridge-launcher.sh'), ['hermes', process.execPath,
        path.join(root, 'deploy/acp-ws-bridge.mjs'), '--port', '0', '--bind', '127.0.0.1', '--required-mode', 'host',
        '--root', home, '--cmd', `${process.execPath} ${path.join(root, 'scripts/e2e_replay_resume_agent.mjs')} ${path.join(home, 'params.log')}`], env);
      services.push(service);
      return boundPort(service);
    }
    const normal = await bridge('normal');
    const capped = await bridge('capped', 128);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    async function scenario(sid, port, expectedResync = false) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.grantPermissions(['local-network-access']);
      await context.addInitScript(({ sid, port }) => {
        const saved = { id: sid, agentName: 'Protocol fixture', sessionId: sid, cwd: '/tmp', title: sid, supportsLoadSession: true, lastUpdated: 1 };
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { 'Protocol fixture': { transport: 'websocket', url: `ws://127.0.0.1:${port}/` } } }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [saved], openTabs: [{ agentName: saved.agentName, sessionId: sid }], activeTab: { agentName: saved.agentName, sessionId: sid } }));
      }, { sid, port });
      let state = {rev:1,updatedAt:1,data:{sessions:[{id:sid,agentName:'Protocol fixture',sessionId:sid,cwd:'/tmp',title:sid,supportsLoadSession:true,lastUpdated:1}],openTabs:[{agentName:'Protocol fixture',sessionId:sid}],activeTab:{agentName:'Protocol fixture',sessionId:sid}}};
      const page = await context.newPage();
      const loads = [], errors = [], rpcErrors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('websocket', socket => {
        const pending = new Map();
        socket.on('framesent', ({ payload }) => { const f = JSON.parse(String(payload)); if (f.method === 'session/load') pending.set(f.id, f.params); });
        socket.on('framereceived', ({ payload }) => {
          const f = JSON.parse(String(payload));
          if (f.error) rpcErrors.push(f.error.message);
          if (!f.method && pending.has(f.id)) { loads.push({ params: pending.get(f.id), meta: f.result?._meta?.acpUI }); pending.delete(f.id); }
        });
      });
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.port === '25808' && (u.pathname === '/chat' || u.pathname === '/' || u.pathname.startsWith('/assets/'))) {
          return route.fulfill({ path: path.join(build, u.pathname.startsWith('/assets/') ? u.pathname : 'index.html') });
        }
        if (u.pathname === '/api/state/sessions.json') {
          if (route.request().method()==='PUT') state={rev:state.rev+1,updatedAt:Date.now(),data:route.request().postDataJSON().data};
          return route.fulfill({json:state});
        }
        if (u.pathname === '/health') return route.fulfill({ json: { ok: false } });
        if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: { error: 'isolated fixture' } });
        return route.continue();
      });
      const snapshot = () => page.evaluate(() => {
        const r = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session').activeRuntime;
        return { text: r.messages.map(m => m.content), incomplete: r.historyIncomplete, commands: r.availableCommands.map(c => c.name) };
      });
      async function ready(number) {
        for (let i = 0; i < 200 && loads.length < number; i++) await page.waitForTimeout(50);
        if(loads.length !== number) console.log('DEBUG', await page.evaluate(()=>({url:location.href,text:document.body.innerText,keys:Object.keys(localStorage)})),errors,rpcErrors);
        assert.equal(loads.length, number);
        await page.waitForFunction(() => {
          const r = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('session')?.activeRuntime;
          return r?.isConnected && !r.isRestoringHistory;
        });
      }
      await page.goto(`http://127.0.0.1:25808/chat?s=${encodeURIComponent('Protocol fixture::' + sid)}`, { waitUntil: 'domcontentloaded' });
      await ready(1);
      assert.equal((await snapshot()).text.length, 12);
      if ((sid === 'sess-grow' || sid === 'sess-failfull') && !expectedResync) {
        // Keep a true prefix checkpoint but only its newest rows: test the
        // client/bridge protocol rather than a reimplementation of it.
        await page.evaluate(() => {
          const key = Object.keys(localStorage).find(k => k.startsWith('acp-ui:history:'));
          const entry = JSON.parse(localStorage.getItem(key));
          entry.userTurnBase += entry.messages.slice(0, 4).filter(m => m.role === 'user').length;
          entry.messages = entry.messages.slice(4);
          localStorage.setItem(key, JSON.stringify(entry));
        });
      }
      await page.reload({ waitUntil: 'domcontentloaded' }); await ready(2);
      assert(loads[1].params.acpUIResume, 'the actual cache emits a verified cursor');
      const warm = await snapshot();
      if (sid === 'sess-grow' && !expectedResync) {
        assert.equal(loads[1].meta.skipped, 12);
        assert.deepEqual(warm.text, Array.from({ length: 12 }, (_, i) => `sess-grow history ${i + 5}`));
        assert.equal(warm.incomplete, true);
        const button = page.getByRole('button', { name: 'Load full history', exact: true });
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          if (width === 390) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
          await button.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
          const style = await button.evaluate(e => ({ height: e.getBoundingClientRect().height, outline: getComputedStyle(e).outlineWidth, focus: e.matches(':focus-visible') }));
          assert(style.height >= (width === 390 ? 44 : 28)); assert.equal(style.outline, '2px'); assert(style.focus);
        }
        await button.click(); await ready(3);
        assert.equal(loads[2].params.acpUIResume, undefined);
        assert.deepEqual((await snapshot()).text, Array.from({ length: 16 }, (_, i) => `sess-grow history ${i + 1}`));
      } else if (sid === 'sess-failfull') {
        const button = page.getByRole('button', {name:'Load full history',exact:true});
        await button.click();
        await page.waitForFunction(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session').activeRuntime.error==='history unavailable');
        await button.waitFor({state:'visible'});
        await page.getByText('history unavailable',{exact:true}).waitFor({state:'visible'});
        assert.equal(await button.isEnabled(),true);
        assert.deepEqual(rpcErrors,['history unavailable']);rpcErrors.length=0;
        await button.click();await ready(4);
        assert.equal(await button.count(),0);
        assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session').activeRuntime.error),null);
      } else if (sid === 'sess-state') {
        assert.deepEqual(warm.commands, ['review']); assert.equal(loads[1].meta.skipped, 12);
      } else {
        assert.equal(loads[1].meta.resynced, true);
        assert.deepEqual(warm.text, Array.from({ length: sid === 'sess-grow' ? 16 : 12 }, (_, i) => `${sid}${sid === 'sess-div' ? ' DIVERGED' : ''} history ${i + 1}`));
      }
      assert.deepEqual(errors, []); assert.deepEqual(rpcErrors, []);
      console.log('PASS real bridge + browser', sid, expectedResync ? 'buffer-cap resync' : 'cursor merge');
      await context.close();
    }
    await scenario('sess-grow', normal);
    await scenario('sess-div', normal);
    await scenario('sess-state', normal);
    await scenario('sess-grow', capped, true);
    await scenario('sess-failfull', normal);
  } finally {
    await browser?.close();
    for (const service of services) await stopTestBridge(service.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
