// Browser regression for context visibility. Uses mocked ACP/state; never prompts a model.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,args:['--no-sandbox']});
for (const width of [320,390,1440]) {
for (const installed of (width < 800 ? [false, true] : [false])) {
const c=await b.newContext({ignoreHTTPSErrors:true,hasTouch:width<800,isMobile:width<800,viewport:{width,height:844}});
if (installed) await c.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
await c.grantPermissions(['local-network-access']);
await c.addInitScript(()=>{localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:[{id:'e2e',agentName:'E2E',sessionId:'e2e',cwd:'/tmp',title:'Layout check',supportsLoadSession:true,lastUpdated:Date.now()}],openTabs:[{agentName:'E2E',sessionId:'e2e'}]}));localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{E2E:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false,lastCwd:'/tmp'}));});
const p=await c.newPage();const errors=[];p.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
if(process.env.BUILD) await p.route('**/*',r=>{const u=new URL(r.request().url());if(u.port==='25809' && (u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}return r.continue();});
await p.route('**/api/**',r=>r.request().url().includes('/api/state/')?r.fulfill({json:{rev:1,updatedAt:Date.now(),data:r.request().url().includes('sessions.json')?{sessions:[{id:'e2e',agentName:'E2E',sessionId:'e2e',cwd:'/tmp',title:'Layout check',supportsLoadSession:true,lastUpdated:Date.now()}],openTabs:[{agentName:'E2E',sessionId:'e2e'}]}:{}}}):r.fulfill({json:r.request().url().includes('/fs/root')?{root:'/tmp'}:r.request().url().includes('/fs/')?{path:'/tmp',root:'/tmp',dirs:[]}:{projects:[],sessions:[],cards:[]}}));
await p.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{for(const line of String(msg).split('\n')){let q;try{q=JSON.parse(line)}catch{continue}if(!q.method||q.id==null)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[],agentInfo:{name:'E2E',version:'0'}};if(q.method==='session/list')result={sessions:[{sessionId:'e2e',cwd:'/tmp',title:'Layout check'}]};if(q.method==='session/load'||q.method==='session/new'){result={sessionId:'e2e'};ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}}));}setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result})),50);if(q.method==='session/load'||q.method==='session/new')setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}})),300);}}));
await p.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=E2E%3A%3Ae2e`,{waitUntil:'domcontentloaded',timeout:15000});
try{await p.waitForSelector('.chat-view:visible .context-meter',{state:'visible',timeout:20000});}catch(e){console.log('URL',p.url(),'TEXT',(await p.locator('body').textContent()).slice(-3500));await p.screenshot({path:'/tmp/acp-context-debug.png'});throw e;}
for(const theme of ['light','dark']){
await p.emulateMedia({colorScheme:theme});
const meter=p.locator('.chat-view:visible .context-meter');
const m=await meter.evaluate(e=>({text:e.textContent,panel:!!e.closest('.settings-panel'),rect:e.getBoundingClientRect().toJSON(),color:getComputedStyle(e).color,overflow:document.documentElement.scrollWidth>innerWidth}));
console.log(width,theme,m);assert.equal(m.panel,false,'context stays outside settings');assert.equal(m.text,'45k/200k');assert(m.rect.width>0);assert(m.rect.x>=0&&m.rect.right<=width);assert.equal(m.overflow,false);
if(width<800){const toggle=p.locator('.chat-view:visible .settings-toggle');await toggle.tap();await p.waitForTimeout(100);assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert(await meter.isVisible());await toggle.tap();assert(await meter.isVisible());}
}
if (width < 800) {
  const field=p.locator('.chat-view:visible textarea');
  const text='Крестик должен убирать чат из истории, сохраняя переписку. '.repeat(40);
  await field.fill(text);
  await p.waitForTimeout(100);
  const cdp=await c.newCDPSession(p);
  for (const y of [250, (await field.boundingBox()).y + 60]) {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2-40,y},{x:width/2+40,y}]});
    for(let i=1;i<=8;i++) { await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width/2-40-i*6,y},{x:width/2+40+i*6,y}]}); await p.waitForTimeout(40); }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await p.waitForTimeout(200);
    const scale=await p.evaluate(()=>visualViewport.scale);
    if(installed) assert.equal(scale,1,'PWA gestures cannot zoom and pan the chat away from the cursor');
    else assert(scale>1.1,'browser pages keep deliberate pinch zoom');
    await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  }
  if(installed) {
    for(const value of [text,'д'.repeat(2000)]) {
      await field.fill(value);
      await p.keyboard.press('End');
      await p.waitForTimeout(100);
      const size=await field.evaluate(e=>({width:e.clientWidth,scrollWidth:e.scrollWidth,height:e.clientHeight,scrollHeight:e.scrollHeight}));
      assert(size.scrollWidth<=size.width,'long drafts wrap inside the field');
      assert(size.height<=200 && size.scrollHeight>size.height,'long drafts scroll vertically after the height cap');
    }
    await p.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:420});visualViewport.dispatchEvent(new Event('resize'));});
    await p.waitForTimeout(100);
    const box=await p.locator('.chat-view:visible .input-container').boundingBox();
    assert(box.x>=0 && box.x+box.width<=width && box.y>=0 && box.y+box.height<=420,'composer fits the keyboard viewport');
    assert.equal(await field.inputValue(),'д'.repeat(2000),'viewport changes preserve the draft');
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  console.log('PASS long drafts, keyboard viewport, pinch policy',width,{installed});
}
assert.deepEqual(errors,[]);await p.screenshot({path:`/tmp/acp-context-${width}.png`});await c.close();
}
}
await b.close();console.log('PASS context visible, settings interaction, widths, themes, no pageerror');
})().catch(e=>{console.error(e);process.exit(1)});
