// Two independent browsers against the real state HTTP/CAS service. ACP is a
// deterministic fixture; creating a session never submits a model prompt.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createServer}=require('node:http');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 let browser,state;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acp-device-state-'));
 try {
  const {createStateService}=await import(path.resolve(__dirname,'../server/execution/state-service.mjs'));
  const {createRequestHandler}=await import(path.resolve(__dirname,'../server/acp-state-server.mjs'));
  const service=await createStateService({stateDir:dir,env:{}});
  const activity={statuses:{'["Codex","existing"]':{status:'completed',at:120}},activity:{'["Codex","existing"]':{at:120},'["Codex","recent"]':{at:300}}};
  state=createServer(createRequestHandler(service,{sessionStatusReader:async()=>activity}));await new Promise(r=>state.listen(0,'127.0.0.1',r));
  const api=`http://127.0.0.1:${state.address().port}`;
  const seed={id:'existing',sessionId:'existing',agentName:'Codex',cwd:'/tmp',title:'Existing desktop session',lastUpdated:900,lastMessageAt:100,supportsLoadSession:true};
  const recent={...seed,id:'recent',sessionId:'recent',title:'Actual recent conversation',lastUpdated:50,lastMessageAt:20};
  await fetch(`${api}/api/state/sessions.json`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rev:0,data:{sessions:[seed,recent],openTabs:[]}})});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const errors=[],prompts=[],sockets=new Map();let serial=0;
  async function device(width){
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width,height:844},isMobile:width<800,hasTouch:width<800});
   await context.addInitScript(()=>{
    localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:[{id:'stale-phone',sessionId:'stale-phone',agentName:'Codex',title:'Stale browser session',lastUpdated:9999999999999,supportsLoadSession:true}],openTabs:[]}));
    localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{Codex:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));
    localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false}));
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   let failHealth=width<800, inventoryDown=false;
   page.setInventoryUnavailable=value=>{inventoryDown=value;};
   await page.route('**/*',async r=>{
    try {
    const u=new URL(r.request().url());
    if(u.pathname==='/api/state/sessions.json'&&inventoryDown)return await r.fulfill({status:503,json:{error:'test outage'}});
    if(u.pathname==='/health'&&failHealth){failHealth=false;return await r.fulfill({status:503,json:{ok:false}});}
    if(u.pathname==='/health'||u.pathname.startsWith('/api/state/')||u.pathname==='/api/chat-session-statuses'){
     const response=await r.fetch({url:api+u.pathname});return await r.fulfill({response});
    }
    if(process.env.BUILD&&u.port==='25809'&&(u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){
     const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return await r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    }
    if(u.pathname.startsWith('/api/'))return await r.fulfill({json:{sessions:[],statuses:[],root:'/tmp',dirs:[]}});
    return await r.continue();
    } catch(error) {
     // Reload may cancel a request while route.fetch is reading its response.
     if(!error.message.includes('Route is already handled!'))throw error;
    }
   });
   await page.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{
    const q=JSON.parse(msg);if(q.method==='session/prompt')prompts.push(q);
    if(q.id==null)return;
    let result={};
    if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{}}},authMethods:[]};
    if(q.method==='session/list')result={sessions:[]};
    if(q.method==='session/new'){result={sessionId:'device-'+(++serial)};sockets.set(result.sessionId,ws);}
    ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
   }));
   await page.goto(`${process.env.UI_TEST_URL||'https://192.168.1.222:25809'}/chat`);
   await page.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('session'));
   await page.evaluate(()=>{window.__session=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');});
   await page.waitForFunction(()=>window.__session?.savedSessions.length===2 && !window.__session.savedSessions.some(s=>s.id==='stale-phone'),{},{timeout:10000});
   await page.waitForFunction(()=>window.__session.visibleSessions[0]?.id==='recent',{},{timeout:10000});
   return page;
  }
  const phone=await device(390),desktop=await device(1440);
  await desktop.evaluate(()=>window.__session.createSession('Codex','/tmp'));
  await phone.waitForFunction(()=>window.__session.savedSessions.some(s=>s.sessionId==='device-1'),{},{timeout:12000});
  assert.equal(await phone.evaluate(()=>window.__session.openTabs.length),0,'sync does not open another device tabs');
  // Use the actual mobile session-page navigation and find the shared entry.
  await phone.evaluate(()=>window.__session.resumeSession(window.__session.savedSessions.find(s=>s.id==='existing')));
  await phone.getByRole('button',{name:'Open menu',exact:true}).click();

  assert(await phone.locator('#app-sidebar').getByText('Existing desktop session',{exact:true}).isVisible());
  await phone.waitForFunction(()=>document.querySelector('.row-title')?.textContent==='tmp');
  assert.equal(await phone.locator('.row-title').first().innerText(),'tmp','desktop-created session sorts above old metadata');
  phone.setInventoryUnavailable(true);
  await phone.evaluate(()=>window.__session.refreshSharedSessions());
  assert(await phone.locator('#app-sidebar [role=alert]').filter({hasText:'Cannot reach the session server'}).isVisible(),'server outage is visible');
  phone.setInventoryUnavailable(false);
  await phone.evaluate(()=>window.__session.refreshSharedSessions());
  assert.equal(await phone.locator('#app-sidebar [role=alert]').count(),0,'server recovery clears the error without reloading');
  // A remote adoption must keep the object held by an already-open runtime.
  await phone.evaluate(()=>window.__session.createSession('Codex','/tmp'));
  await desktop.waitForFunction(()=>window.__session.savedSessions.some(s=>s.sessionId==='device-2'),{},{timeout:12000});
  sockets.get('device-1').send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'device-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fresh reply after remote inventory refresh'}}}}));
  await desktop.waitForFunction(()=>window.__session.savedSessions.find(s=>s.sessionId==='device-1')?.lastMessageAt>0,{},{timeout:8000});
  let persisted;
  for(let i=0;i<40;i++){persisted=await(await fetch(`${api}/api/state/sessions.json`)).json();if(persisted.data.sessions.find(s=>s.sessionId==='device-1')?.lastMessageAt>0)break;await new Promise(r=>setTimeout(r,200));}
  assert(persisted.data.sessions.find(s=>s.sessionId==='device-1')?.lastMessageAt>0,'live activity remains in server inventory after another device refresh');
  await phone.reload();
  await phone.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('session'));
  await phone.evaluate(()=>{window.__session=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');});
  await phone.waitForFunction(()=>window.__session?.savedSessions.some(s=>s.sessionId==='device-1'));
  const remote=await(await fetch(`${api}/api/state/sessions.json`)).json();
  assert.equal(remote.data.sessions.length,4);assert.deepEqual(prompts,[]);assert.deepEqual(errors,[]);
  console.log('PASS server-only inventory ignores stale local data and failed health, true conversation order, live timestamp persistence; desktop-created Codex session appears on already-open phone, mobile list, reload, independent tabs, no model prompts');
 }catch(error){console.error(error);throw error;}finally{for(const context of browser?.contexts()??[])for(const page of context.pages())await page.unrouteAll({behavior:'ignoreErrors'});await browser?.close();state?.closeAllConnections();await new Promise(r=>state?state.close(r):r());fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
