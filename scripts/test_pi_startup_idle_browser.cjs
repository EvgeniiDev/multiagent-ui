// Real composer/runtime; isolated browser state. LIVE_PI=1 uses the live Pi
// bridge and model in fresh /tmp sessions; otherwise only ACP is a fixture.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
 let browser, server;
 try {
  let base = process.env.UI_TEST_URL;
  if (!base) {
   assert(process.env.BUILD);
   server = createServer((req,res) => {
    const name = new URL(req.url,'http://local').pathname;
    const file = path.join(process.env.BUILD, name.startsWith('/assets/') ? name : 'index.html');
    res.setHeader('content-type', {'.js':'text/javascript','.css':'text/css','.html':'text/html'}[path.extname(file)] || 'application/octet-stream');
    try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404);res.end(); }
   });
   await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,args:['--no-sandbox']});
  for (const width of [390,1440]) {
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width,height:900}});
   const docs=new Map(), calls=[], errors=[], failed=[];
   await context.addInitScript(()=>localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{Pi:{transport:'websocket',url:'ws://127.0.0.1:25904/'}}})));
   await context.route('**/health',r=>r.fulfill({json:{ok:true}}));
   await context.route('**/api/**',async r=>{
    const req=r.request(), u=new URL(req.url());
    if(u.pathname.startsWith('/api/state/')) {
     const key=path.basename(u.pathname);
     if(req.method()==='PUT') { const body=req.postDataJSON(); docs.set(key,{rev:(docs.get(key)?.rev??0)+1,data:body.data}); }
     return r.fulfill({json:docs.get(key)??{rev:0,data:{}}});
    }
    return r.fulfill({json:{statuses:{},root:'/tmp',dirs:[],sessions:[],cards:[],projects:[]}});
   });
   await context.routeWebSocket(/wss?:\/\//,ws=>{
    const upstream=process.env.LIVE_PI ? ws.connectToServer() : null;
    if(upstream) upstream.onMessage(m=>{
     if(process.env.PI_TRACE) { try { const q=JSON.parse(String(m));console.log(JSON.stringify({method:q.method,id:q.id,sessionUpdate:q.params?.update?.sessionUpdate,error:q.error})); } catch {} }
     ws.send(m);
    });
    ws.onMessage(raw=>{
     const q=JSON.parse(String(raw)); if(q.method)calls.push(q);
     if(q.method==='session/list'){ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{sessions:[]}}));return;}
     if(upstream){upstream.send(raw);return;}
     if(q.id==null)return;
     let result={};
     if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};
     const update=(sid,update)=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update}}));
     if(q.method==='session/new')result={sessionId:`pi-test-${width}`};
     if(q.method==='session/load') {
      update(q.params.sessionId,{sessionUpdate:'user_message_chunk',content:{type:'text',text:'Reply exactly PI_IDLE_OK'}});
      update(q.params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PI_IDLE_OK'}});
     }
     if(q.method==='session/prompt')update(q.params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PI_IDLE_OK'}});
     if(q.method==='session/prompt')result={stopReason:'end_turn'};
     ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
     if(q.method==='session/new')setTimeout(()=>update(result.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'pi v0.85.1\n---\n\n## Skills\nStartup info'}}),80);
    });
   });
   const page=await context.newPage();page.setDefaultTimeout(30000);
   page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push(`${r.status()} ${new URL(r.url()).pathname}`);});
   await page.goto(`${base}/chat`,{waitUntil:'domcontentloaded'});
   if (width < 800) {
    await page.locator('.list-create').waitFor({state:'attached'});
    if (!await page.locator('.list-create').isVisible()) await page.getByRole('button',{name:'Open menu',exact:true}).click();
    await page.locator('.list-create').click();
   } else await page.locator('.tab-new').click();
   const dialog=page.getByRole('dialog',{name:'New session',exact:true});
   await dialog.locator('select').selectOption('Pi');
   await dialog.locator('.cwd-input').fill('/tmp');
   await dialog.getByRole('button',{name:'Start session',exact:true}).click();
   await page.waitForFunction(()=>window.__session?.activeRuntime?.isConnected);
   console.log(`Connected ${width}: waiting for Pi startup banner`);
   await page.locator('.chat-view:visible .messages').getByText(/pi v[0-9]/).first().waitFor();
   await page.waitForTimeout(200);
   assert.equal(await page.evaluate(()=>window.__session.activeRuntime.turnStatus),null,'Pi greeting must leave the session idle');
   if (process.env.LIVE_PI) await page.evaluate(async()=>{
    const rt=window.__session.activeRuntime;
    if(rt.availableModes.some(m=>m.id==='off')) await rt.setMode('off');
   });
   await page.locator('.chat-view:visible textarea').fill('Reply exactly PI_IDLE_OK');
   await page.getByRole('button',{name:'Send',exact:true}).click();
   console.log(`Sent ${width}: waiting for completion`);
   if (process.env.LIVE_PI_DELIVERY_ONLY) {
    assert(process.env.LIVE_PI, 'delivery-only requires a real Pi bridge');
    await page.waitForTimeout(250);
    assert.equal(calls.filter(q=>q.method==='session/prompt').length,1);
    assert.equal(await page.locator('.chat-view:visible [data-pending-id]').count(),0);
    await page.evaluate(()=>window.__session.activeRuntime.cancelOperation());
    console.log(`PASS live Pi ${width}: new session idle, first Queue message delivered once; own test prompt cancelled, model completion not asserted`);
    await context.close();
    continue;
   }
   try {
    await page.waitForFunction(()=>window.__session.activeRuntime.turnCompleted,{}, {timeout:60000});
   } catch (error) {
    console.log(JSON.stringify({methods:calls.map(q=>q.method),runtime:await page.evaluate(()=>{
     const rt=window.__session.activeRuntime;
     return {connected:rt.isConnected,loading:rt.isLoading,status:rt.turnStatus,error:rt.error,pending:rt.pendingMessages.map(m=>({error:m.error})),roles:rt.messages.map(m=>m.role)};
    })}));
    await page.evaluate(()=>window.__session.activeRuntime.cancelOperation());
    throw error;
   }
   assert.equal(calls.filter(q=>q.method==='session/prompt').length,1,'first Queue message reaches Pi once');
   assert.equal(await page.locator('.chat-view:visible [data-pending-id]').count(),0);
   await page.reload({waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__session?.activeRuntime?.isConnected&&!window.__session.activeRuntime.isLoading);
   assert.equal(calls.filter(q=>q.method==='session/prompt').length,1,'reload never resends');
   assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
   console.log(`PASS ${process.env.LIVE_PI?'live Pi':'ACP fixture'} ${width}: create via menu, greeting idle, Queue delivered once, completion, reload without resend`);
   await context.close();
  }
 } finally {await browser?.close();if(server)await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
