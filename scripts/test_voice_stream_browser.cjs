// Dictation browser regression: actual microphone pipeline; ACP/state mocked, no model prompts.
// VOICE_WAV is a 16kHz mono speech/pause/speech WAV; STT_REAL=1 uses the live recognizer.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {voicePress}=require('./browser_voice_gestures.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+process.env.VOICE_WAV,'--autoplay-policy=no-user-gesture-required']});
globalThis.qaBrowser=b;
for (const width of [390,1440]) {
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
await p.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{for(const line of String(msg).split('\n')){let q;try{q=JSON.parse(line)}catch{continue}if(q.method)rpcCalls.push(q);if(!q.method||q.id==null)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[],agentInfo:{name:'E2E',version:'0'}};if(q.method==='session/list')result={sessions:[{sessionId:'e2e',cwd:'/tmp',title:'Layout check'}]};if(q.method==='session/load'||q.method==='session/new'){result={};ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:q.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:Array.from({length:150},(_,i)=>`Scroll line ${i}\n\n`).join('')}}}}));ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}}));}setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result})),50);if(q.method==='session/load'||q.method==='session/new')setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'usage_update',used:45000,size:200000}}})),300);}}));
await p.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=E2E%3A%3Ae2e`,{waitUntil:'domcontentloaded',timeout:15000});
try{await p.waitForSelector('.chat-view:visible .context-meter',{state:'attached',timeout:20000});}catch(e){console.log('URL',p.url(),'TEXT',(await p.locator('body').textContent()).slice(-3500));await p.screenshot({path:'/tmp/acp-context-debug.png'});throw e;}

const field=p.locator('.chat-view:visible textarea'),mic=p.locator('.chat-view:visible .voice-btn');
await field.fill('До После');await field.evaluate(e=>e.setSelectionRange(3,3));
await voicePress(p,mic);await p.waitForFunction(()=>document.querySelector('.chat-view:not([style*="display: none"]) .voice-btn')?.getAttribute('aria-pressed')==='true');
await p.waitForFunction(()=>!!document.querySelector('.chat-view:not([style*="display: none"]) .voice-commit')?.textContent.trim(),{},{timeout:25000});
const first=await p.locator('.chat-view:visible .voice-commit').innerText();
assert.equal(await mic.getAttribute('aria-pressed'),'true','first phrase arrives before Stop');
assert.equal(await field.inputValue(),'До После','live speech overlay never overwrites typed draft');
await field.fill('Ручное До После');await p.waitForTimeout(100);
await p.waitForFunction(first=>document.querySelector('.chat-view:not([style*="display: none"]) .voice-commit')?.textContent.startsWith(first+' '),first,{timeout:25000});
const committed=await p.locator('.chat-view:visible .voice-commit').innerText();assert(committed.length>first.length);
assert.equal(await mic.getAttribute('aria-pressed'),'true','both phrases are processed while still recording');
await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('.chat-view:not([style*="display: none"]) .voice-overlay'),{},{timeout:25000});
const final=await field.inputValue();
assert(final.startsWith('Ручное До '+committed),'committed phrases keep their order and typed prefix');
assert(final.endsWith(' После'),'typed suffix survives final recognition');
if(!process.env.STT_REAL){const ids=[...final.matchAll(/Фраза (\d+)/g)].map(m=>Number(m[1]));assert.deepEqual(ids,[...new Set(ids)].sort((a,b)=>a-b),'finalized phrases occur once in capture order; disposable previews may be skipped');assert(ids.every(id=>requests.some(r=>r.id===id)));}
assert.equal(await mic.getAttribute('aria-pressed'),'false');assert(await mic.isEnabled());
assert.equal(await p.locator('.chat-view:visible .voice-status.is-error').count(),0,'successful dictation leaves no error');
assert(requests.length>=2,'recognition starts during recording');assert(requests.every(r=>r.status===200));assert.deepEqual(errors,[]);
const palette=await p.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg-main').trim());assert.equal(palette,'#202020');
console.log(JSON.stringify({width,realStt:!!process.env.STT_REAL,requests,first,final,errors}));
if(width===390&&!process.env.STT_REAL){
  const beforeFailure=await field.inputValue();let failureCalls=0,releaseFailure;const failureGate=new Promise(resolve=>releaseFailure=resolve);
  await p.route('**/v1/audio/transcriptions',async r=>{const call=++failureCalls;if(call>2)await failureGate;return r.fulfill({status:call<=2?200:503,contentType:'text/plain',body:call<=2?'Сохранённая фраза':'inference unavailable'});});
  await voicePress(p,mic);await p.waitForFunction(()=>document.querySelector('.chat-view:not([style*="display: none"]) .voice-commit')?.textContent==='Сохранённая фраза',{},{timeout:20000});
  for(let i=0;i<300&&failureCalls<3;i++)await p.waitForTimeout(100);assert(failureCalls>=3,'second phrase reached the service before Send');
  await p.locator('.chat-view:visible .send-btn').click();releaseFailure();
  await p.waitForFunction(()=>document.querySelector('.chat-view:not([style*="display: none"]) .voice-status.is-error')?.textContent.includes('503'),{},{timeout:20000});
  assert.equal(await p.locator('.chat-view:visible .voice-overlay').count(),0);
  assert.equal((await field.inputValue()).replaceAll('Сохранённая фраза ',''),beforeFailure,'failed dictation preserves the draft plus recognized words');
  assert.equal(rpcCalls.filter(q=>q.method==='session/prompt').length,0,'Send must wait and stop on a transcription failure');
  console.log('PASS partial text retained after final chunk failure, no incomplete message sent');
}
await c.close();
}
await b.close();console.log('PASS live text before Stop, ordered phrases, draft edits, final insertion, mobile/desktop');
})().catch(async error=>{console.error(error);await globalThis.qaBrowser?.close();process.exit(1)});
