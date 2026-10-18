// Real UI with ACP fixtures matching Pi 0.0.33 and Codex configOptions.
// No prompts or user sessions. UI_TEST_URL runs against the served production assets.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
 let server, browser;
 try {
  let base = process.env.UI_TEST_URL;
  if (!base) {
   assert(process.env.BUILD, 'Set BUILD or UI_TEST_URL');
   server = createServer((req,res) => {
    const url = new URL(req.url,'http://localhost').pathname;
    const file = path.join(process.env.BUILD, ['/', '/chat'].includes(url) ? 'index.html' : url);
    try { res.setHeader('Content-Type', {'.js':'text/javascript','.css':'text/css','.html':'text/html'}[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); }
    catch { res.writeHead(404); res.end(); }
   });
   await new Promise(r=>server.listen(0,'127.0.0.1',r)); base=`http://127.0.0.1:${server.address().port}`;
  }
  browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  for (const agent of ['Pi','Codex','Legacy']) for (const width of [1440,390]) {
   const context=await browser.newContext({ignoreHTTPSErrors:true,colorScheme:width<800?'dark':'light',viewport:{width,height:900},hasTouch:width<800,isMobile:width<800});
   await context.addInitScript(({agent})=>{
    localStorage.setItem('acp-ui:agents', JSON.stringify({agents:{[agent]:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));
    localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:[{id:'selector-test',agentName:agent,sessionId:'selector-test',cwd:'/tmp',title:'Selector regression',supportsLoadSession:true,lastUpdated:Date.now()}],openTabs:[{agentName:agent,sessionId:'selector-test'}]}));
   },{agent});
   const page=await context.newPage();page.setDefaultTimeout(10000);
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/health',r=>r.fulfill({json:{ok:false}}));
   await page.route('**/api/**',r=>r.fulfill({json:r.request().url().includes('/api/state/')?{rev:1,data:r.request().url().includes('sessions.json')?{sessions:[{id:'selector-test',agentName:agent,sessionId:'selector-test',cwd:'/tmp',title:'Selector regression',supportsLoadSession:true,lastUpdated:Date.now()}],openTabs:[{agentName:agent,sessionId:'selector-test'}]}:{}}:{sessions:[],projects:[],cards:[]}}));
   let model='model-a', thought='medium', fail=false, socket;
   const calls=[];
   const configs=()=>[
    {id:'model',type:'select',category:'model',name:'Model',currentValue:model,options:[{value:'model-a',name:'Model A'},{value:'model-b',name:'Model B'}]},
    {id:'reasoning',type:'select',category:'thought_level',name:'Reasoning effort',currentValue:thought,options:[{value:'medium',name:'Medium'},{value:'high',name:'High'}]},
   ];
   const update=()=>socket.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'selector-test',update:{sessionUpdate:'config_option_update',configOptions:configs()}}}));
   await page.routeWebSocket(/wss?:\/\//, ws=>ws.onMessage(raw=>{
    for(const line of String(raw).split('\n')) {
     let q;try{q=JSON.parse(line)}catch{continue}if(q.id==null||!q.method)continue;
     let result={};
     if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};
     if(q.method==='session/list')result={sessions:[]};
     if(q.method==='session/load') { socket=ws; result={models:{currentModelId:agent==='Codex'?'model-a[medium]':model,availableModels:agent==='Codex'?[{modelId:'model-a[medium]',name:'Model A (medium)'},{modelId:'model-a[high]',name:'Model A (high)'}]:[{modelId:'model-a',name:'Model A'},{modelId:'model-b',name:'Model B'}]},...(agent==='Pi'?{modes:{currentModeId:thought,availableModes:[{id:'medium',name:'Thinking: Medium'},{id:'high',name:'Thinking: High'}]}}:{}),...(agent==='Legacy'?{}:{configOptions:configs()})}; }
     if(q.method==='session/set_model'||q.method==='session/set_config_option') {
      calls.push(q);
      if(agent==='Pi'&&q.method==='session/set_model') {ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not found'}}));continue;}
      if(fail){ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'Model unavailable'}}));continue;}
      if(q.params.configId==='reasoning')thought=q.params.value;else model=q.params.value||q.params.modelId;
      setTimeout(()=>{if(agent!=='Legacy')update(); ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result:agent==='Legacy'?{}:{configOptions:configs()}}));},400);
      continue;
     }
     ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
    }
   }));
   await page.goto(`${base}/chat?s=${encodeURIComponent(agent+'::selector-test')}`);
   const chat=page.locator('.chat-view:visible');
   async function settings(){if(width<800){const t=chat.getByRole('button',{name:'Chat settings',exact:true});if(await t.getAttribute('aria-expanded')==='false')await t.click();}}
   await chat.locator('.model-button').waitFor({state:'attached'});await settings();
   await chat.locator('.model-button').click();
   assert.equal(await chat.locator('.dropdown-item').count(),2,'one entry per model, reasoning must be separate');
   await chat.locator('.dropdown-item').filter({hasText:'Model B'}).click();
   if(agent!=='Legacy') assert(await chat.locator('.model-button').isDisabled(),'disable model changes while awaiting the agent');
   await page.waitForFunction(()=>document.querySelector('.chat-view .model-name')?.textContent==='Model B');
   assert.equal(calls[0].method,agent==='Legacy'?'session/set_model':'session/set_config_option');
   if(agent!=='Legacy') {
    await settings();if(agent==='Pi')assert.equal(await chat.locator('.mode-picker').count(),1,'thinking appears only once alongside the chat/workflow selector');const reasoning=chat.getByRole('button',{name:'Reasoning effort: Medium',exact:true});await page.keyboard.press('Tab');await reasoning.focus();assert.equal(await reasoning.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');if(width<800)assert((await reasoning.boundingBox()).height>=44);await reasoning.click();
    await page.getByRole('option',{name:'High',exact:true}).click();
    await chat.getByRole('button',{name:'Reasoning effort: High',exact:true}).waitFor();
    assert.equal(calls[1].params.configId,'reasoning');assert.equal(model,'model-b');
    // External/agent changes must update both controls, independently of RPC responses.
    model='model-a';thought='medium';update();
    await page.waitForFunction(()=>document.querySelector('.chat-view .model-name')?.textContent==='Model A');
    await chat.getByRole('button',{name:'Reasoning effort: Medium',exact:true}).waitFor();
    fail=true;await chat.locator('.model-button').click();await chat.locator('.dropdown-item').filter({hasText:'Model B'}).click();
    await page.getByText('Failed to change model: Model unavailable',{exact:true}).waitFor();assert.equal(await chat.locator('.model-name').innerText(),'Model A','rejection keeps server-confirmed model');fail=false;
    await page.reload();await chat.locator('.model-button').waitFor({state:'attached'});await settings();
    await chat.getByRole('button',{name:'Reasoning effort: Medium',exact:true}).waitFor();
   }
   assert.deepEqual(errors,[]);console.log(`PASS ${agent} ${width}: model selection, separate reasoning, notifications, rejection, reload`);
   await context.close();
  }
 } finally {await browser?.close();if(server)await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
