// Browser regression for context visibility. Uses mocked ACP/state; never prompts a model.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
for (const width of [320,390,1440]) {
const c=await b.newContext({ignoreHTTPSErrors:true,hasTouch:width<800,isMobile:width<800,viewport:{width,height:844}});
await c.grantPermissions(['local-network-access']);
await c.addInitScript(()=>{localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:[{id:'e2e',agentName:'E2E',sessionId:'e2e',cwd:'/tmp',title:'Layout check',supportsLoadSession:true,lastUpdated:Date.now()}]}));localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{E2E:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false,lastCwd:'/tmp'}));});
const p=await c.newPage();const errors=[];p.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
if(process.env.BUILD) await p.route('**/*',r=>{const u=new URL(r.request().url());if(u.port==='25809' && (u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}return r.continue();});
await p.route('**/api/**',r=>r.request().url().includes('/api/state/')?r.fulfill({json:{rev:1,updatedAt:Date.now(),data:r.request().url().includes('sessions.json')?{sessions:[{id:'e2e',agentName:'E2E',sessionId:'e2e',cwd:'/tmp',title:'Layout check',supportsLoadSession:true,lastUpdated:Date.now()}]}:{}}}):r.fulfill({json:r.request().url().includes('/fs/root')?{root:'/tmp'}:r.request().url().includes('/fs/')?{path:'/tmp',root:'/tmp',dirs:[]}:{projects:[],sessions:[],cards:[]}}));
await p.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{for(const line of String(msg).split('\n')){let q;try{q=JSON.parse(line)}catch{continue}if(!q.method||q.id==null)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[],agentInfo:{name:'E2E',version:'0'}};if(q.method==='session/list')result={sessions:[{sessionId:'e2e',cwd:'/tmp',title:'Layout check'}]};if(q.method==='session/load'||q.method==='session/new'){result={sessionId:'e2e'};ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}}));}setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result})),50);if(q.method==='session/load'||q.method==='session/new')setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}})),300);}}));
await p.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=E2E%3A%3Ae2e`,{waitUntil:'domcontentloaded',timeout:15000});
try{await p.waitForSelector('.chat-view:visible .context-meter',{state:'attached',timeout:20000});}catch(e){console.log('URL',p.url(),'TEXT',(await p.locator('body').textContent()).slice(-3500));await p.screenshot({path:'/tmp/acp-context-debug.png'});throw e;}
for(const theme of ['light','dark']){
await p.emulateMedia({colorScheme:theme});
const meter=p.locator('.chat-view:visible .context-meter');
const m=await meter.evaluate(e=>({text:e.textContent,panel:!!e.closest('.settings-panel'),rect:e.getBoundingClientRect().toJSON(),color:getComputedStyle(e).color,overflow:document.documentElement.scrollWidth>innerWidth}));
console.log(width,theme,m);assert.equal(m.panel,false,'context stays outside settings');assert.equal(m.text,'45k/200k');assert(m.rect.width>0);assert(m.rect.x>=0&&m.rect.right<=width);assert.equal(m.overflow,false);
if(width<800){const toggle=p.locator('.chat-view:visible .settings-toggle');await toggle.tap();await p.waitForTimeout(100);assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert(await meter.isVisible());await toggle.tap();assert(await meter.isVisible());}
}
assert.deepEqual(errors,[]);await p.screenshot({path:`/tmp/acp-context-${width}.png`});await c.close();
}
await b.close();console.log('PASS context visible, settings interaction, widths, themes, no pageerror');
})().catch(e=>{console.error(e);process.exit(1)});
