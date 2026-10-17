// Contextual composer actions; mocked ACP/state/STT, actual browser microphone.
// VOICE_WAV is a 16kHz mono speech/pause/speech WAV; STT_REAL=1 uses the live recognizer.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {voicePress,voicePointer}=require('./browser_voice_gestures.cjs');
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
assert.equal(await group.locator('button').count(),1,'empty composer has one combined voice/send control');assert(await primary.isEnabled());
await field.fill('Following draft');assert.equal(await primary.getAttribute('aria-label'),'Send');assert(await primary.isEnabled());
for(const theme of ['light','dark']){await p.mouse.move(0,0);await p.emulateMedia({colorScheme:theme});assert.equal(await primary.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(222, 222, 222)','send preserves graphite theme');await primary.hover();assert.equal(await primary.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');}
await p.keyboard.press('Tab');await primary.focus();assert.equal(await primary.evaluate(e=>getComputedStyle(e).outlineWidth),'2px');
await field.fill('');await p.evaluate(()=>window.__session.activeRuntime.isLoading=true);
assert.equal(await group.locator('button').count(),1,'generation with no draft reuses the combined button for Stop');assert.equal(await primary.getAttribute('aria-label'),'Stop response');assert(await primary.isEnabled());assert(await mic.isEnabled());assert.equal(await p.locator('.chat-view:visible .send-btn').count(),0);
if(process.env.ARTIFACT_DIR)await p.locator('.chat-view:visible .input-container').screenshot({path:path.join(process.env.ARTIFACT_DIR,'contextual-stop-'+width+'.png')});
const cancelCount=rpcCalls.filter(q=>q.method==='session/cancel').length;await primary.click();await p.waitForTimeout(200);assert.equal(rpcCalls.filter(q=>q.method==='session/cancel').length,cancelCount+1);assert.equal(await field.inputValue(),'');
await p.evaluate(()=>window.__session.activeRuntime.isLoading=true);await field.fill('Prepared follow-up');
assert.equal(await primary.getAttribute('aria-label'),'Send');assert.equal(await group.locator('button').count(),2,'a prepared follow-up keeps its independent Stop action');
const extraStop=group.locator('.stop-btn:not(.composer-primary)');assert.equal(await extraStop.count(),1);assert(await mic.isEnabled());
if(width<800){for(const button of [mic,primary,extraStop]){const r=await button.boundingBox();assert(r.width>=44&&r.height>=44,'touch actions remain at least 44px');}}
await extraStop.click();await p.waitForTimeout(200);assert.equal(await field.inputValue(),'Prepared follow-up','stopping generation keeps the next draft');
await p.evaluate(()=>window.__session.activeRuntime.isLoading=false);await field.fill('');
const promptsBeforeVoice=rpcCalls.filter(q=>q.method==='session/prompt').length;
await mic.click();await p.waitForTimeout(450);
assert.equal(await mic.getAttribute('aria-pressed'),'false','a short empty tap never starts the mic');
const held=await voicePress(p,mic,{lock:false});
assert.equal(await group.locator('button').count(),1,'held recording uses the single primary action');
await p.waitForTimeout(1400);await held.release();
await p.waitForFunction(n=>window.__session.activeRuntime.messages.some(m=>m.role==='user')&&document.querySelector('.chat-view:not([style*="display: none"]) textarea').value==='',{},{timeout:20000});
assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,promptsBeforeVoice+1,'release sends exactly one voice message');
await voicePress(p,mic);
assert.equal(await mic.getAttribute('aria-label'),'Send voice message','upward swipe locks recording');
assert(await group.getByRole('button',{name:'Cancel voice recording'}).isVisible());
await p.waitForTimeout(1400);
assert.equal(await mic.getAttribute('aria-pressed'),'true','recording continues with the finger lifted');
assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,promptsBeforeVoice+1,'locking never sends');
await mic.click();
await p.waitForFunction(()=>!document.querySelector('.chat-view:not([style*="display: none"]) .voice-overlay'),{},{timeout:20000});
await p.waitForTimeout(150);
assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,promptsBeforeVoice+2,'tap sends exactly once after locking');
await field.fill('Keep this draft');await voicePress(p,mic);await p.waitForTimeout(800);
await group.getByRole('button',{name:'Cancel voice recording'}).click();
assert.equal(await field.inputValue(),'Keep this draft','cancel preserves the typed draft');
assert.equal(await mic.getAttribute('aria-pressed'),'false');
assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,promptsBeforeVoice+2,'cancel sends nothing');
await field.fill('');await voicePress(p,mic);await p.waitForTimeout(1200);await p.keyboard.press('Escape');
await p.waitForFunction(()=>!document.querySelector('.chat-view:not([style*="display: none"]) .voice-overlay'));
assert((await field.inputValue()).length>0,'Escape keeps recognized text as an unsent draft');
await field.fill('Send this draft');const prompts=rpcCalls.filter(q=>q.method==='session/prompt').length;await primary.click();await p.waitForTimeout(200);assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,prompts+1);assert.equal(await field.inputValue(),'');
if(width===390){
  const sentBeforeEdges=rpcCalls.filter(q=>q.method==='session/prompt').length;
  await field.fill('Never send this draft accidentally');
  await p.evaluate(()=>{window.qaOriginalMic=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.qaMicCalls=0;navigator.mediaDevices.getUserMedia=(...args)=>{window.qaMicCalls++;return window.qaOriginalMic(...args);};});
  const flick=await voicePointer(p,mic);await flick.moveTo(flick.x,flick.y-64);await flick.release();await p.waitForTimeout(450);
  assert.equal(await p.evaluate(()=>window.qaMicCalls),0,'a quick swipe cannot start the microphone');
  assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,sentBeforeEdges,'a quick swipe cannot send a draft');
  assert.equal(await field.inputValue(),'Never send this draft accidentally');
  await p.evaluate(()=>{navigator.mediaDevices.getUserMedia=async(...args)=>{const stream=await window.qaOriginalMic(...args);window.qaPendingStream=stream;await new Promise(resolve=>window.qaGrantMic=resolve);return stream;};});
  const pending=await voicePress(p,mic,{lock:false,waitForListening:false});
  await p.waitForFunction(()=>typeof window.qaGrantMic==='function');
  await pending.release();
  assert.equal(await field.inputValue(),'Never send this draft accidentally','release before permission preserves draft');
  assert.equal(await mic.getAttribute('aria-pressed'),'false');
  await p.evaluate(()=>window.qaGrantMic());
  await p.waitForFunction(()=>window.qaPendingStream.getTracks().every(t=>t.readyState==='ended'));
  assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,sentBeforeEdges,'late microphone grant cannot send');
  await p.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied by fixture','NotAllowedError');};});
  const denied=await voicePress(p,mic,{lock:false,waitForListening:false});await denied.release();
  await p.locator('.chat-view:visible .voice-status.is-error').filter({hasText:'denied'}).waitFor();
  assert.equal(await field.inputValue(),'Never send this draft accidentally','permission denial preserves draft');
  assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,sentBeforeEdges,'permission denial never sends typed text');
  await p.evaluate(()=>{navigator.mediaDevices.getUserMedia=window.qaOriginalMic;delete window.qaOriginalMic;});
  const interrupted=await voicePress(p,mic,{lock:false});await p.waitForTimeout(1200);await interrupted.cancel();
  await p.waitForFunction(()=>!document.querySelector('.chat-view:not([style*="display: none"]) .voice-overlay'));
  assert((await field.inputValue()).startsWith('Never send this draft accidentally'),'pointer cancellation preserves typed draft');
  assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,sentBeforeEdges,'pointer cancellation never sends');
  await field.fill('Original tab draft');await voicePress(p,mic);await p.waitForTimeout(1200);
  if(process.env.ARTIFACT_DIR)await p.screenshot({path:path.join(process.env.ARTIFACT_DIR,'voice-locked-390.png')});
  async function selectSession(id, index) {
    if (width < 800) {
      await p.getByRole('button', { name: 'Open menu', exact: true }).click();
      await p.locator(`.session-row[data-session-id="${id}"] .session-open`).click();
    } else await p.locator('.tab-strip [role="tab"]').nth(index).click();
  }
  await selectSession('other', 1);
  await p.waitForFunction(()=>!document.querySelector('.voice-overlay'));
  assert.equal(await field.inputValue(),'','switching tabs does not copy the voice draft');
  await selectSession('e2e', 0);
  assert((await field.inputValue()).startsWith('Original tab draft'),'recording stays with the original tab');
  assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,sentBeforeEdges,'switching an active recording sends nothing');
  console.log('PASS quick flick, pending permission, stale grant cleanup, mic denial, pointercancel, and tab isolation');
}
assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
console.log(JSON.stringify({width,controls:'one voice/send action, contextual Stop, hold/release, swipe lock, cancel',errors}));await c.close();
}
await b.close();console.log('PASS one combined action, hold/release, swipe lock, tap-to-send, cancel, Escape, contextual Stop, preserved drafts, focus, touch, graphite');
})().catch(async error=>{console.error(error);await globalThis.qaBrowser?.close();process.exit(1)});
