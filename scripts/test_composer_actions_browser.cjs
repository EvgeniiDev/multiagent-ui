// Contextual composer actions; mocked ACP/state/STT, actual browser microphone.
// VOICE_WAV is a 16kHz mono speech/pause/speech WAV; STT_REAL=1 uses the live recognizer.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+process.env.VOICE_WAV,'--autoplay-policy=no-user-gesture-required']});
globalThis.qaBrowser=b;
for (const width of [320,390,1440]) {
const c=await b.newContext({ignoreHTTPSErrors:true,hasTouch:width<800,isMobile:width<800,viewport:{width,height:844}});
await c.grantPermissions(['local-network-access','microphone']);
await c.addInitScript(()=>{localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:['e2e','other'].map(id=>({id,agentName:'E2E',sessionId:id,cwd:'/tmp',title:id,supportsLoadSession:true,lastUpdated:Date.now()})),openTabs:[{agentName:'E2E',sessionId:'e2e'},{agentName:'E2E',sessionId:'other'}]}));localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{E2E:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false,lastCwd:'/tmp'}));});
const p=await c.newPage();const errors=[],rpcCalls=[];p.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
if(process.env.BUILD) await p.route('**/*',r=>{const u=new URL(r.request().url());if(u.port==='25809' && (u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}return r.continue();});
if(!process.env.STT_REAL)await p.route('**/openapi.json',r=>r.fulfill({json:{paths:{'/v1/audio/transcriptions':{post:{}}}}}));
const requests=[];
if(!process.env.STT_REAL)await p.route('**/v1/audio/transcriptions',async r=>{const id=requests.length+1;const body=r.request().postDataBuffer();requests.push({id,bytes:body.length,status:200});await new Promise(resolve=>setTimeout(resolve,250));return r.fulfill({contentType:'text/plain',body:'Фраза '+id});});
else p.on('response',async r=>{if(new URL(r.url()).pathname==='/v1/audio/transcriptions')requests.push({status:r.status(),text:await r.text().catch(()=>null)});});
await p.route('**/api/**',r=>r.request().url().includes('/api/state/')?r.fulfill({json:{rev:1,updatedAt:Date.now(),data:r.request().url().includes('sessions.json')?{sessions:['e2e','other'].map(id=>({id,agentName:'E2E',sessionId:id,cwd:'/tmp',title:id,supportsLoadSession:true,lastUpdated:Date.now()})),openTabs:[{agentName:'E2E',sessionId:'e2e'},{agentName:'E2E',sessionId:'other'}]}:{}}}):r.fulfill({json:r.request().url().includes('/fs/root')?{root:'/tmp'}:r.request().url().includes('/fs/')?{path:'/tmp',root:'/tmp',dirs:[]}:{projects:[],sessions:[],cards:[]}}));
await p.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{for(const line of String(msg).split('\n')){let q;try{q=JSON.parse(line)}catch{continue}if(q.method)rpcCalls.push(q);if(!q.method||q.id==null)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[],agentInfo:{name:'E2E',version:'0'}};if(q.method==='session/prompt')result={stopReason:'end_turn'};if(q.method==='session/list')result={sessions:[{sessionId:'e2e',cwd:'/tmp',title:'Layout check'}]};if(q.method==='session/load'||q.method==='session/new'){result={};ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:q.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:Array.from({length:150},(_,i)=>`Scroll line ${i}\n\n`).join('')}}}}));ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}}));}setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result})),50);if(q.method==='session/load'||q.method==='session/new')setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}})),300);}}));
await p.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=E2E%3A%3Ae2e`,{waitUntil:'domcontentloaded',timeout:15000});
try{await p.waitForSelector('.chat-view:visible .context-meter',{state:'attached',timeout:20000});}catch(e){console.log('URL',p.url(),'TEXT',(await p.locator('body').textContent()).slice(-3500));await p.screenshot({path:'/tmp/acp-context-debug.png'});throw e;}


const field=p.locator('.chat-view:visible textarea'),group=p.locator('.chat-view:visible .composer-actions'),primary=p.locator('.chat-view:visible .composer-primary'),mic=p.locator('.chat-view:visible .voice-btn');
assert.equal(await group.count(),1,'recording and primary action share one compact group');
assert.equal(await group.locator('button').count(),2,'empty idle composer has two primary controls');assert(await primary.isDisabled());
await field.fill('Following draft');assert.equal(await primary.getAttribute('aria-label'),'Send');assert(await primary.isEnabled());
for(const theme of ['light','dark']){await p.mouse.move(0,0);await p.emulateMedia({colorScheme:theme});assert.equal(await primary.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(222, 222, 222)','send preserves graphite theme');await primary.hover();assert.equal(await primary.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');}
await p.keyboard.press('Tab');await primary.focus();assert.equal(await primary.evaluate(e=>getComputedStyle(e).outlineWidth),'2px');
await field.fill('');await p.evaluate(()=>window.__session.activeRuntime.isLoading=true);
assert.equal(await group.locator('button').count(),2,'generation with no draft reuses Send for Stop');assert.equal(await primary.getAttribute('aria-label'),'Stop response');assert(await primary.isEnabled());assert(await mic.isEnabled());assert.equal(await p.locator('.chat-view:visible .send-btn').count(),0);
if(process.env.ARTIFACT_DIR)await p.locator('.chat-view:visible .input-container').screenshot({path:path.join(process.env.ARTIFACT_DIR,'contextual-stop-'+width+'.png')});
const cancelCount=rpcCalls.filter(q=>q.method==='session/cancel').length;await primary.click();await p.waitForTimeout(200);assert.equal(rpcCalls.filter(q=>q.method==='session/cancel').length,cancelCount+1);assert.equal(await field.inputValue(),'');
await p.evaluate(()=>window.__session.activeRuntime.isLoading=true);await field.fill('Prepared follow-up');
assert.equal(await primary.getAttribute('aria-label'),'Send');assert.equal(await group.locator('button').count(),3,'a prepared follow-up keeps its independent Stop action');
const extraStop=group.locator('.stop-btn:not(.composer-primary)');assert.equal(await extraStop.count(),1);assert(await mic.isEnabled());
if(width<800){for(const button of [mic,primary,extraStop]){const r=await button.boundingBox();assert(r.width>=44&&r.height>=44,'touch actions remain at least 44px');}}
await extraStop.click();await p.waitForTimeout(200);assert.equal(await field.inputValue(),'Prepared follow-up','stopping generation keeps the next draft');
await p.evaluate(()=>window.__session.activeRuntime.isLoading=false);await field.fill('');await mic.click();await p.waitForFunction(()=>document.querySelector('.chat-view:not([style*="display: none"]) .voice-btn')?.getAttribute('aria-pressed')==='true');
assert.equal(await primary.getAttribute('aria-label'),'Send');assert(await primary.isEnabled(),'Send can finish recording before its first hypothesis');assert.equal(await group.locator('button').count(),2);
await p.waitForTimeout(1400);await mic.click();await p.waitForFunction(()=>!document.querySelector('.chat-view:not([style*="display: none"]) .voice-overlay'));assert((await field.inputValue()).length>0,'mic Stop retains recognized text');
await field.fill('Send this draft');const prompts=rpcCalls.filter(q=>q.method==='session/prompt').length;await primary.click();await p.waitForTimeout(200);assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,prompts+1);assert.equal(await field.inputValue(),'');
assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
console.log(JSON.stringify({width,controls:'two main actions, contextual Stop, rare follow-up Stop',errors}));await c.close();
}
await b.close();console.log('PASS contextual actions, mic stop, generation stop, preserved drafts, send, focus, touch, graphite');
})().catch(async error=>{console.error(error);await globalThis.qaBrowser?.close();process.exit(1)});
