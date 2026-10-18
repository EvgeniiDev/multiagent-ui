// Real sidebar/tabs with deterministic ACP and revisioned state; no provider calls.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
 let server,browser;
 try {
  let base=process.env.UI_TEST_URL;
  if(!base){
   assert(process.env.BUILD,'Set BUILD or UI_TEST_URL');
   server=createServer((req,res)=>{const u=new URL(req.url,'http://localhost').pathname;const f=path.join(process.env.BUILD,u.startsWith('/assets/')?u:'index.html');try{res.setHeader('Content-Type',{'.js':'text/javascript','.css':'text/css','.html':'text/html'}[path.extname(f)]||'application/octet-stream');res.end(fs.readFileSync(f));}catch{res.writeHead(404);res.end();}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  }
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const width of [1440,390]){
   const c=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width,height:900}});
   const sessions=['one','two'].map((id,i)=>({id,sessionId:id,agentName:'E2E',cwd:i?'/work/senkuro_bot':'/work/acp-ui',title:i?'senkuro_bot':'acp-ui',supportsLoadSession:true,lastUpdated:i+1}));
   let data={sessions,openTabs:[{agentName:'E2E',sessionId:'one'}]},rev=1;
   await c.addInitScript(()=>localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{E2E:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}})));
   await c.route('**/api/**',r=>{
    if(r.request().url().endsWith('/sessions.json')){
     if(r.request().method()==='PUT'){const b=r.request().postDataJSON();if(b.rev!==rev)return r.fulfill({status:409,json:{}});data=b.data;rev++;}
     return r.fulfill({json:{rev,data}});
    }
    return r.fulfill({json:r.request().url().includes('/api/state/')?{rev:1,data:{}}:{sessions:[],projects:[],cards:[]}});
   });
   await c.route('**/health',r=>r.fulfill({json:{ok:false}}));
   let socket;let listedTitle='Agent list title',loadTitle='Agent replay title';const lists=[];
   const update=(ws,id,title)=>ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:id,update:{sessionUpdate:'session_info_update',title}}}));
   await c.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(raw=>{
    const q=JSON.parse(String(raw));if(q.id==null||!q.method)return;let result={};
    if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{}}},authMethods:[]};
    if(q.method==='session/load'){socket=ws;update(ws,q.params.sessionId,loadTitle);}
    if(q.method==='session/list'){lists.push(q.params);result={sessions:sessions.filter(s=>!q.params.cwd||s.cwd===q.params.cwd).map(s=>({sessionId:s.sessionId,cwd:s.cwd,title:s.sessionId==='two'?(q.params.cwd?'Other workspace agent title':null):listedTitle})).concat(q.params.cwd?[]:[{sessionId:'untitled',cwd:'/work/folder-name',title:null}])};}
    if(q.method==='session/prompt'){listedTitle='Agent title after answer';}
    ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
   }));
   const p=await c.newPage();p.setDefaultTimeout(10000);const errors=[],httpErrors=[];p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()>=400)httpErrors.push(r.status())});
   await p.goto(`${base}/chat?s=E2E%3A%3Aone`);
   const row=p.locator('.session-row[data-session-id="one"] .row-title');
   await p.waitForFunction(()=>document.querySelector('.session-row[data-session-id="one"] .row-title')?.textContent==='Agent list title');
   await p.waitForTimeout(100);assert(lists.some(q=>q.cwd==='/work/acp-ui'),'resume refresh must scope metadata to the session cwd');
   update(socket,'one','Live agent title');
   await p.waitForFunction(()=>document.querySelector('.session-row[data-session-id="one"] .row-title')?.textContent==='Live agent title');
   await p.waitForTimeout(100);assert.equal(data.sessions.find(s=>s.sessionId==='one').title,'Live agent title','metadata-only changes persist');
   if(width>=800)assert.equal(await p.locator('.tab-title').first().innerText(),'Live agent title');
   update(socket,'two','Wrong session');update(socket,'one',null);
   await p.waitForTimeout(100);assert.equal(await row.textContent(),'Live agent title');
   listedTitle='';
   // Opening the refresh action is independent of whether mobile navigation hides the sidebar.
   if(width<800)await p.getByRole('button',{name:'Open menu',exact:true}).click();
   await p.getByRole('button',{name:'Load sessions from all agents'}).click();await p.waitForTimeout(200);
   assert.equal(await p.locator('.session-row[data-session-id="two"] .row-title').textContent(),'Other workspace agent title','global refresh repairs another workspace without opening it');
   assert.equal(await p.locator('.row-title').filter({hasText:'New session'}).first().textContent(),'New session');
   assert.equal(await row.textContent(),'Live agent title','empty agent metadata cannot replace the title with a folder');
   loadTitle='Title after reload';listedTitle='';await p.reload();
   await p.waitForFunction(()=>document.querySelector('.session-row[data-session-id="one"] .row-title')?.textContent==='Title after reload');
   assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);console.log(`PASS titles ${width}: scoped list, replay/live rename, persistence, empty/foreign updates, reload`);
   await c.close();
  }
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
