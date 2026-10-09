// Browser regression for mobile navigation scrolling. Uses mocked ACP/state; never prompts a model.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
globalThis.qaBrowser=b;
for (const width of [320,390,1440]) {
const c=await b.newContext({ignoreHTTPSErrors:true,hasTouch:width<800,isMobile:width<800,viewport:{width,height:844}});
await c.grantPermissions(['local-network-access']);
await c.addInitScript(()=>{localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:['e2e','other'].map(id=>({id,agentName:'E2E',sessionId:id,cwd:'/tmp',title:id,supportsLoadSession:true,lastUpdated:Date.now()})),openTabs:[{agentName:'E2E',sessionId:'e2e'},{agentName:'E2E',sessionId:'other'}]}));localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{E2E:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false,lastCwd:'/tmp'}));});
const p=await c.newPage();const errors=[];p.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
if(process.env.BUILD) await p.route('**/*',r=>{const u=new URL(r.request().url());if(u.port==='25809' && (u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}return r.continue();});
await p.route('**/api/**',r=>r.request().url().includes('/api/state/')?r.fulfill({json:{rev:1,updatedAt:Date.now(),data:r.request().url().includes('sessions.json')?{sessions:['e2e','other'].map(id=>({id,agentName:'E2E',sessionId:id,cwd:'/tmp',title:id,supportsLoadSession:true,lastUpdated:Date.now()})),openTabs:[{agentName:'E2E',sessionId:'e2e'},{agentName:'E2E',sessionId:'other'}]}:{}}}):r.fulfill({json:r.request().url().includes('/fs/root')?{root:'/tmp'}:r.request().url().includes('/fs/')?{path:'/tmp',root:'/tmp',dirs:[]}:{projects:[],sessions:[],cards:[]}}));
await p.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{for(const line of String(msg).split('\n')){let q;try{q=JSON.parse(line)}catch{continue}if(!q.method||q.id==null)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[],agentInfo:{name:'E2E',version:'0'}};if(q.method==='session/list')result={sessions:[{sessionId:'e2e',cwd:'/tmp',title:'Layout check'}]};if(q.method==='session/load'||q.method==='session/new'){result={};ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:q.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:Array.from({length:150},(_,i)=>`Scroll line ${i}\n\n`).join('')}}}}));ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}}));}setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result})),50);if(q.method==='session/load'||q.method==='session/new')setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}})),300);}}));
await p.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=E2E%3A%3Ae2e`,{waitUntil:'domcontentloaded',timeout:15000});
try{await p.waitForSelector('.chat-view:visible .context-meter',{state:'attached',timeout:20000});}catch(e){console.log('URL',p.url(),'TEXT',(await p.locator('body').textContent()).slice(-3500));await p.screenshot({path:'/tmp/acp-context-debug.png'});throw e;}
console.log('CHECK',width);const nav=p.locator('.session-navigation');assert.equal(await nav.count(),1,'shared navigation row exists');
await p.waitForSelector('.chat-view:visible .messages-container');
const feed=p.locator('.chat-view:visible .messages-container');
// A replayed background tab must not expand its whole history while hidden.
await p.evaluate(()=>{const rt=window.__session.openTabs.find(t=>t.id!==window.__session.activeTabId);window.qaHiddenOriginal={rt,messages:rt.messages};rt.messages=Array.from({length:1000},(_,i)=>({id:'hidden-fixture-'+i,role:i%2?'assistant':'user',content:'History fixture '+i,timestamp:Date.now()}));});
await p.waitForTimeout(100);
assert((await p.locator('.chat-view[style*="display: none"] .message').count())<=30,'hidden history stays bounded to the latest 30 rows');
await p.evaluate(()=>{qaHiddenOriginal.rt.messages=qaHiddenOriginal.messages;delete window.qaHiddenOriginal;});

await feed.evaluate(e=>e.scrollTop=500);await p.waitForTimeout(250);
assert.equal(await p.locator('.tab-strip [role="tab"]').count(),2);
if(width<800){
  assert.equal(await p.locator('[aria-label="Open menu"]').isVisible(),true,'menu visible initially');
  assert.equal(await p.locator('.mobile-view-tabs button').count(),0,'only session tabs appear beside the menu');
  assert.equal(await nav.getAttribute('inert'),null);
  const draft=p.locator('.chat-view:visible textarea');
  await draft.fill('Draft preserved while the viewport changes');
  const available=684;
  await p.evaluate(height=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:height});window.visualViewport.dispatchEvent(new Event('resize'));},available);
  await p.waitForTimeout(100);
  let composer=await p.locator('.chat-view:visible .composer-box').boundingBox();
  assert(composer.y+composer.height<=available,'composer fits the visible viewport after browser chrome changes');
  assert.equal(await draft.inputValue(),'Draft preserved while the viewport changes');
  await p.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'));});
  await p.waitForTimeout(100);
  const before=(await feed.boundingBox()).height;
  const cdp=await c.newCDPSession(p);
  async function swipe(from,to){const r=await feed.boundingBox();const x=r.x+r.width/2;await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:from}]});for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:from+(to-from)*i/6}]});await p.waitForTimeout(25);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(250);}
  await swipe(550,350);console.log('SCROLL_DOWN',await nav.getAttribute('inert'));
  assert.equal(await nav.getAttribute('inert'),'','scroll down hides navigation');
  assert.equal((await nav.boundingBox()).height,0,'fully collapsed');
  assert((await feed.boundingBox()).height>before,'space returns to feed');
  await swipe(350,550);console.log('SCROLL_UP',await nav.getAttribute('inert'));
  assert.equal(await nav.getAttribute('inert'),null,'scroll up shows navigation');
  assert.equal(await p.locator('[aria-label="Open menu"]').isVisible(),true);
  await feed.evaluate(e=>e.scrollTop+=100);await p.waitForTimeout(250);
  assert.equal(await nav.getAttribute('inert'),null,'automatic scrolling keeps navigation');
  await cdp.detach();
  for(const theme of ['light','dark']){
    await p.emulateMedia({colorScheme:theme});
    const menu=p.locator('[aria-label="Open menu"]');const r=await menu.boundingBox();
    assert(r.width>=44&&r.height>=44);assert(await menu.isEnabled());
    await menu.focus();
    assert.equal(await menu.evaluate(e=>getComputedStyle(e).outlineWidth),'2px','menu has visible keyboard focus');
    const activeBefore=await p.evaluate(()=>window.__session.activeTabId);
    await menu.tap();await p.waitForSelector('.drawer-backdrop');
    assert.equal(await p.evaluate(()=>window.__session.activeTabId),activeBefore,'menu opens the drawer without changing sessions');
    await p.locator('[aria-label="Collapse sidebar"]').click();
  }
  const tabs=p.locator('.tab-strip [role="tab"]');
  await tabs.nth(1).click();
  await p.waitForFunction(()=>window.__session.activeRuntime.descriptor.sessionId==='other');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true');
  await p.locator('.chat-view:visible textarea').fill('Other session draft');
  await tabs.nth(0).click();
  await p.waitForFunction(()=>window.__session.activeRuntime.descriptor.sessionId==='e2e');
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'),'true');
  assert.equal(await draft.inputValue(),'Draft preserved while the viewport changes','session switching preserves the chat draft');
  await p.evaluate(()=>window.__session.closeTab(window.__session.openTabs.find(t=>t.id!==window.__session.activeTabId).id));
  assert.equal(await p.locator('.tab-strip [role="tab"]').count(),1,'single open chat still has a tab');
  await p.locator('.navigation-items').evaluate(e=>e.scrollLeft=e.scrollWidth);
  const tab=await p.locator('.tab-strip [role="tab"]').boundingBox();
  assert(tab.x+tab.width<=width,'session tab reachable by horizontal scrolling');
}else{await feed.hover();await p.mouse.wheel(0,200);await p.waitForTimeout(250);assert.equal(await nav.getAttribute('inert'),null,'desktop tabs stay visible');}
assert.deepEqual(errors,[]);await p.screenshot({path:`/tmp/acp-navigation-${width}.png`});await c.close();
}
await b.close();console.log('PASS scroll up shows menu/tabs, scroll down hides, composer fits visible viewport, desktop unchanged');
})().catch(async e=>{console.error(e);await globalThis.qaBrowser?.close();process.exit(1)});
