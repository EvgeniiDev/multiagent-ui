// Browser lifecycle + real frontend transport/runtime. ACP and state are
// isolated fixtures: no production sessions, bridges or model prompts change.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  for(const width of (process.env.QA_WIDTHS||'1440,390').split(',').map(Number)){
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width,height:844},isMobile:width<800,hasTouch:width<800});
   await context.grantPermissions(['local-network-access']);
   await context.addInitScript(()=>{
    const sessions=Array.from({length:8},(_,i)=>({id:'foreground-'+i,sessionId:'foreground-'+i,agentName:'Foreground QA',cwd:'/tmp',title:'Chat '+i,lastUpdated:1,supportsLoadSession:true}));
    localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{'Foreground QA':{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));
    localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions,openTabs:sessions.map(s=>({agentName:s.agentName,sessionId:s.sessionId})),activeTab:{agentName:'Foreground QA',sessionId:'foreground-7'}}));
    localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false}));
   });
   const page=await context.newPage(),errors=[],prompts=[],loads=[],probes=[],sockets=new Map();
   let silent=false,returnedAt=0;
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>{
    const u=new URL(r.request().url());
    if(process.env.BUILD&&u.port==='25809'&&(u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){
     const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');
     return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    }
    if(u.pathname==='/health')return r.fulfill({json:{ok:false}});
    if(u.pathname.startsWith('/api/'))return r.fulfill({json:{sessions:[],projects:[],cards:[],root:'/tmp',dirs:[]}});
    return r.continue();
   });
   const update=(ws,sid,text)=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}}));
   await page.routeWebSocket(/wss?:\/\//,ws=>{
    let sid;
    ws.onMessage(raw=>{
     for(const line of String(raw).trim().split('\n')){
      const q=JSON.parse(line);
      if(q.method==='$/ping'){
       if(silent)probes.push({sid,at:Date.now()-returnedAt});
       else ws.send(JSON.stringify({jsonrpc:'2.0',method:'$/pong',params:q.params}));
       continue;
      }
      if(q.method==='session/prompt')prompts.push(q);
      if(q.id==null)continue;
      const reply=result=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
      if(q.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
      else if(q.method==='session/load'){
       sid=q.params.sessionId;sockets.set(sid,ws);loads.push({sid,recovery:silent,at:Date.now()-returnedAt});
       const finish=()=>{update(ws,sid,`History for ${sid}${silent?' · caught up after background':''}`);reply({});};
       if(silent&&sid!=='foreground-7')setTimeout(finish,600);else finish();
      }else reply({});
     }
    });
   });
   await page.goto(`${process.env.UI_TEST_URL||'https://192.168.1.222:25809'}/chat?s=Foreground%20QA%3A%3Aforeground-7`);
   await page.waitForFunction(()=>window.__session?.openTabs.length===8&&window.__session.openTabs.every(t=>t.isConnected&&!t.isRestoringHistory));
   await page.evaluate(()=>window.__session.tryReconnect()); // prove each peer pong-capable
   const cdp=await context.newCDPSession(page);
   // A suspended page with an intact socket drains its queued messages on
   // return, without replaying the entire transcript.
   await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
   update(sockets.get('foreground-7'),'foreground-7',' · words received while frozen');
   const healthyStart=Date.now();
   await cdp.send('Page.setWebLifecycleState',{state:'active'});
   await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow')));
   await page.waitForFunction(()=>window.__session.activeRuntime.messages.some(m=>m.content.includes('words received while frozen')));
   const healthyMs=Date.now()-healthyStart;
   assert.equal(loads.length,8,'healthy foreground return must not reload history');
   // Simulate the OS/network leaving OPEN sockets that no longer deliver
   // traffic. The eighth, visible chat must not await seven background probes.
   await cdp.send('Page.setWebLifecycleState',{state:'frozen'});silent=true;
   returnedAt=Date.now();await cdp.send('Page.setWebLifecycleState',{state:'active'});
   await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow')));
   try{
    await page.waitForFunction(()=>window.__session.activeRuntime.messages.some(m=>m.content.includes('caught up after background'))&&!window.__session.activeRuntime.isReconnecting,{},{timeout:Number(process.env.RECOVERY_DEADLINE_MS||2000)});
   }catch(error){console.log(JSON.stringify({width,healthyMs,elapsedMs:Date.now()-returnedAt,probes,recovered:loads.filter(l=>l.recovery)}));throw error;}
   const recoveryMs=Date.now()-returnedAt;
   await page.waitForFunction(()=>window.__session.openTabs.every(t=>t.isConnected&&!t.isRestoringHistory&&!t.isReconnecting),{},{timeout:10000});
   assert.equal(loads.length,16,'each chat replays only once');
   if(!process.env.MEASURE_BASELINE)assert.equal(probes[0].sid,'foreground-7','current chat gets the first liveness check');
   assert.deepEqual(errors,[]);assert.deepEqual(prompts,[]);
   assert.equal(await page.evaluate(()=>window.__session.activeRuntime.error),null);
   console.log(JSON.stringify({width,healthyMs,recoveryMs,firstProbe:probes[0].sid,replayCount:loads.filter(l=>l.recovery).length,errors,prompts:prompts.length}));
   await cdp.detach();await page.unrouteAll({behavior:'ignoreErrors'});await context.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
