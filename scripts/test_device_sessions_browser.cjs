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
  state=createServer(createRequestHandler(service));await new Promise(r=>state.listen(0,'127.0.0.1',r));
  const api=`http://127.0.0.1:${state.address().port}`;
  const seed={id:'existing',sessionId:'existing',agentName:'Codex',cwd:'/tmp',title:'Existing desktop session',lastUpdated:1,supportsLoadSession:true};
  await fetch(`${api}/api/state/sessions.json`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rev:0,data:{sessions:[seed],openTabs:[]}})});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const errors=[],prompts=[];let serial=0;
  async function device(width){
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width,height:844},isMobile:width<800,hasTouch:width<800});
   await context.addInitScript(()=>{
    localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{Codex:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));
    localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false}));
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',async r=>{
    const u=new URL(r.request().url());
    if(u.pathname==='/health'||u.pathname.startsWith('/api/state/')){
     const response=await r.fetch({url:api+u.pathname});return r.fulfill({response});
    }
    if(process.env.BUILD&&u.port==='25809'&&(u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){
     const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    }
    if(u.pathname.startsWith('/api/'))return r.fulfill({json:{sessions:[],statuses:[],root:'/tmp',dirs:[]}});
    return r.continue();
   });
   await page.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{
    const q=JSON.parse(msg);if(q.method==='session/prompt')prompts.push(q);
    if(q.id==null)return;
    let result={};
    if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{}}},authMethods:[]};
    if(q.method==='session/list')result={sessions:[]};
    if(q.method==='session/new')result={sessionId:'device-'+(++serial)};
    ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
   }));
   await page.goto(`${process.env.UI_TEST_URL||'https://192.168.1.222:25809'}/chat`);
   await page.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('session'));
   await page.evaluate(()=>{window.__session=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');});
   await page.waitForFunction(()=>window.__session?.savedSessions.length===1);
   return page;
  }
  const phone=await device(390),desktop=await device(1440);
  await desktop.evaluate(()=>window.__session.createSession('Codex','/tmp'));
  await phone.waitForFunction(()=>window.__session.savedSessions.some(s=>s.sessionId==='device-1'),{},{timeout:12000});
  assert.equal(await phone.evaluate(()=>window.__session.openTabs.length),0,'sync does not open another device tabs');
  // Use the actual mobile session-page navigation and find the shared entry.
  await phone.getByRole('button',{name:'Open menu',exact:true}).click();

  assert(await phone.getByText('Existing desktop session',{exact:true}).isVisible());
  await phone.reload();
  await phone.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('session'));
  await phone.evaluate(()=>{window.__session=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');});
  await phone.waitForFunction(()=>window.__session?.savedSessions.some(s=>s.sessionId==='device-1'));
  const remote=await(await fetch(`${api}/api/state/sessions.json`)).json();
  assert.equal(remote.data.sessions.length,2);assert.deepEqual(prompts,[]);assert.deepEqual(errors,[]);
  console.log('PASS desktop-created Codex session appears on already-open phone, mobile list, reload, independent tabs, no model prompts');
 }catch(error){console.error(error);throw error;}finally{await browser?.close();state?.closeAllConnections();await new Promise(r=>state?state.close(r):r());fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
