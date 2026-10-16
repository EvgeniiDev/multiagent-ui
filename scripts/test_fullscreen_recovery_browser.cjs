// Browser regression for mobile navigation scrolling. Uses mocked ACP/state; never prompts a model.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
globalThis.qaBrowser=b;
for (const width of [390,780]) {
const c=await b.newContext({ignoreHTTPSErrors:true,hasTouch:width<800,isMobile:width<800,userAgent:width===430?'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1':undefined,viewport:{width,height:844}});
await c.grantPermissions(['local-network-access','microphone']);
await c.addInitScript(()=>{localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:['e2e','other'].map(id=>({id,agentName:'E2E',sessionId:id,cwd:'/tmp',title:id,supportsLoadSession:true,lastUpdated:Date.now()})),openTabs:[{agentName:'E2E',sessionId:'e2e'},{agentName:'E2E',sessionId:'other'}]}));localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{E2E:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false,lastCwd:'/tmp'}));});
const p=await c.newPage();const errors=[],rpcCalls=[];p.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
if(process.env.BUILD) await p.route('**/*',r=>{const u=new URL(r.request().url());if(u.port==='25809' && (u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}return r.continue();});
await p.route('**/openapi.json',r=>r.fulfill({json:{paths:{'/v1/audio/transcriptions':{post:{}}}}}));
await p.route('**/v1/audio/transcriptions',r=>r.fulfill({json:{text:'Dictated follow-up while the model works'}}));
await p.route('**/api/**',r=>r.request().url().includes('/api/state/')?r.fulfill({json:{rev:1,updatedAt:Date.now(),data:r.request().url().includes('sessions.json')?{sessions:['e2e','other'].map(id=>({id,agentName:'E2E',sessionId:id,cwd:'/tmp',title:id,supportsLoadSession:true,lastUpdated:Date.now()})),openTabs:[{agentName:'E2E',sessionId:'e2e'},{agentName:'E2E',sessionId:'other'}]}:{}}}):r.fulfill({json:r.request().url().includes('/fs/root')?{root:'/tmp'}:r.request().url().includes('/fs/')?{path:'/tmp',root:'/tmp',dirs:[]}:{projects:[],sessions:[],cards:[]}}));
await p.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{for(const line of String(msg).split('\n')){let q;try{q=JSON.parse(line)}catch{continue}if(q.method)rpcCalls.push(q);if(!q.method||q.id==null)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[],agentInfo:{name:'E2E',version:'0'}};if(q.method==='session/list')result={sessions:[{sessionId:'e2e',cwd:'/tmp',title:'Layout check'}]};if(q.method==='session/load'||q.method==='session/new'){result={};ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:q.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:Array.from({length:150},(_,i)=>`Scroll line ${i}\n\n`).join('')}}}}));ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}}));}setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result})),50);if(q.method==='session/load'||q.method==='session/new')setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}})),300);}}));
await p.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=E2E%3A%3Ae2e`,{waitUntil:'domcontentloaded',timeout:15000});
try{await p.waitForSelector('.chat-view:visible .context-meter',{state:'attached',timeout:20000});}catch(e){console.log('URL',p.url(),'TEXT',(await p.locator('body').textContent()).slice(-3500));await p.screenshot({path:'/tmp/acp-context-debug.png'});throw e;}

const cdp=await c.newCDPSession(p);
async function swipe(){await p.waitForTimeout(5500);let active;for(let i=0;i<10;i++){active=await cdp.send('Runtime.evaluate',{expression:'navigator.userActivation.isActive',userGesture:false,returnByValue:true});if(!active.result.value)break;await p.waitForTimeout(500);}assert.equal(active.result.value,false,'no automation activation before the gesture');await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2,y:550}]});for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width/2,y:550-25*i}]});await p.waitForTimeout(25);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(300);}
async function entered(){await p.waitForFunction(()=>document.fullscreenElement===document.documentElement,{},{timeout:2500});}
async function externalExit(){await p.evaluate(()=>document.exitFullscreen());await p.waitForFunction(()=>!document.fullscreenElement);}
const field=p.locator('.chat-view:visible textarea');await field.fill('Preserved recovery draft');await p.evaluate(()=>window.scrollTo(0,500));
if(!process.env.RECOVERY_CASE||process.env.RECOVERY_CASE==='exit'){
 await swipe();await entered();await externalExit();await swipe();await entered();
 assert.equal(await field.inputValue(),'Preserved recovery draft','fullscreen recovery keeps the typed draft');
 console.log('PASS',width,'browser exit recovers on next downward gesture');
 // A deliberate exit in our control opts out. Manual reentry opts back in.
 const settings=p.locator('.chat-view:visible .settings-toggle'),toggle=p.locator('.chat-view:visible .fullscreen-toggle');
 await settings.tap();await toggle.click();await p.waitForFunction(()=>!document.fullscreenElement);await settings.tap();await swipe();assert.equal(await p.evaluate(()=>!!document.fullscreenElement),false,'explicit exit does not immediately reenter');
 await settings.tap();await toggle.click();await entered();await settings.tap();await externalExit();await swipe();await entered();await externalExit();
 console.log('PASS',width,'explicit opt-out and manual reenable');
}
if(!process.env.RECOVERY_CASE||process.env.RECOVERY_CASE==='denied'){
 await p.reload({waitUntil:'domcontentloaded'});await p.waitForSelector('.chat-view:visible textarea');await p.evaluate(()=>{window.scrollTo(0,500);window.qaFullscreen=document.documentElement.requestFullscreen;document.documentElement.requestFullscreen=()=>Promise.reject(new DOMException('Temporary denial','NotAllowedError'));});
 await swipe();assert.equal(await p.evaluate(()=>!!document.fullscreenElement),false,'denial never claims fullscreen');
 await p.evaluate(()=>{document.documentElement.requestFullscreen=window.qaFullscreen;delete window.qaFullscreen;});await swipe();await entered();await externalExit();
 console.log('PASS',width,'transient denial can retry on a new gesture');
}
if(!process.env.RECOVERY_CASE||process.env.RECOVERY_CASE==='button'){
 await p.evaluate(x=>{window.scrollTo(0,500);const feed=document.querySelector('.chat-view:not([style*="display: none"]) .messages-container');const button=document.createElement('button');button.type='button';button.textContent='Expandable tool card';button.style.cssText=`position:fixed;left:${x-70}px;top:530px;width:140px;height:40px;z-index:1`;window.qaToolClicks=0;button.onclick=()=>qaToolClicks++;feed.append(button);window.qaToolButton=button;},width/2);
 await swipe();await entered();assert.equal(await p.evaluate(()=>qaToolClicks),0,'dragging a tool card must not activate its button');
 await p.evaluate(()=>qaToolButton.remove());console.log('PASS',width,'swipe starting on a tool card');
}
const box=await p.locator('.chat-view:visible .composer-box').boundingBox();assert(box.y>=0&&box.y+box.height<=await p.evaluate(()=>visualViewport.offsetTop+visualViewport.height));assert.deepEqual(errors,[]);await c.close();
}
await b.close();console.log('PASS fullscreen recovery, retry, tool cards, manual exit, fixed composer');
})().catch(async error=>{console.error(error);await globalThis.qaBrowser?.close();process.exit(1)});
