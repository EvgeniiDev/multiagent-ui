// Browser regression for Markdown tables. Uses mocked ACP/state; never prompts a model.
// UI_TEST_URL selects the existing Compose-served site; BUILD optionally intercepts its frontend assets.
// PLAYWRIGHT_MODULE can point to an installed Playwright package. No server is started.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
for (const width of [320,390,1440]) {
const c=await b.newContext({ignoreHTTPSErrors:true,hasTouch:width<800,isMobile:width<800,viewport:{width,height:844}});
await c.grantPermissions(['local-network-access']);
await c.addInitScript(()=>{localStorage.setItem('acp-ui:sessions.json',JSON.stringify({sessions:[{id:'e2e',agentName:'E2E',sessionId:'e2e',cwd:'/tmp',title:'Layout check',supportsLoadSession:true,lastUpdated:Date.now()}]}));localStorage.setItem('acp-ui:agents',JSON.stringify({agents:{E2E:{transport:'websocket',url:'ws://127.0.0.1:25993/'}}}));localStorage.setItem('acp-ui:preferences.json',JSON.stringify({telemetryEnabled:false,lastCwd:'/tmp'}));});
const p=await c.newPage();const errors=[];p.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
if(process.env.BUILD) await p.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin===new URL(process.env.UI_TEST_URL || 'https://192.168.1.222:25809').origin && (u.pathname==='/chat'||u.pathname==='/'||u.pathname.startsWith('/assets/'))){const file=path.join(process.env.BUILD,u.pathname.startsWith('/assets/')?u.pathname:'index.html');return r.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}return r.continue();});
await p.route('**/api/**',r=>r.request().url().includes('/api/state/')?r.fulfill({json:{rev:1,updatedAt:Date.now(),data:r.request().url().includes('sessions.json')?{sessions:[{id:'e2e',agentName:'E2E',sessionId:'e2e',cwd:'/tmp',title:'Layout check',supportsLoadSession:true,lastUpdated:Date.now()}]}:{}}}):r.fulfill({json:r.request().url().includes('/fs/root')?{root:'/tmp'}:r.request().url().includes('/fs/')?{path:'/tmp',root:'/tmp',dirs:[]}:{projects:[],sessions:[],cards:[]}}));
await p.routeWebSocket(/wss?:\/\//,ws=>ws.onMessage(msg=>{for(const line of String(msg).split('\n')){let q;try{q=JSON.parse(line)}catch{continue}if(!q.method||q.id==null)continue;let result={};if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[],agentInfo:{name:'E2E',version:'0'}};if(q.method==='session/list')result={sessions:[{sessionId:'e2e',cwd:'/tmp',title:'Layout check'}]};if(q.method==='session/load'||q.method==='session/new'){result={sessionId:'e2e'};ws.send(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'e2e',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'| Состояние | Как наблюдать |\n| :--- | ---: |\n| Выбор подхода, изменение общего контракта | Проверить решение сразу |\n| Обычная реализация по принятому подходу | Проверять новые изменения реже |\n| Долгий тест или сборка | Дождаться результата программно |\n| Повторные ошибки, смена подхода | Усилить контроль |\n| Нет новых данных | Пропустить модельный вызов |\n\n| Token | Result |\n| --- | --- |\n| `'+ 'WideToken'.repeat(18) +'` | Scroll inside the message |'}}}}));}setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result})),50);}}));
await p.goto(`${process.env.UI_TEST_URL || 'https://192.168.1.222:25809'}/chat?s=E2E%3A%3Ae2e`,{waitUntil:'domcontentloaded',timeout:15000});
await p.waitForSelector('.chat-view:visible .message-content table th',{timeout:20000});
for(const theme of ['light','dark']){
await p.emulateMedia({colorScheme:theme});
const tables=p.locator('.chat-view:visible .message-content table');
assert.equal(await tables.count(),2);
const styles=await tables.evaluateAll(tables=>tables.map(table=>({
  collapse:getComputedStyle(table).borderCollapse,
  overflow:document.documentElement.scrollWidth>innerWidth,
  scrollable:table.scrollWidth>table.clientWidth,
  cells:[...table.querySelectorAll('th,td')].map(cell=>{
    const s=getComputedStyle(cell);
    return {borders:['Top','Right','Bottom','Left'].map(side=>[s['border'+side+'Width'],s['border'+side+'Style'],s['border'+side+'Color']]),padding:s.paddingLeft,background:s.backgroundColor,align:s.textAlign};
  })
})));
console.log(width,theme,'grid',styles[0].cells[0].borders[0],'scrollable',styles[1].scrollable);
for(const t of styles){
assert.equal(t.collapse,'collapse');
assert.equal(t.overflow,false,'table must not widen the page');
for(const cell of t.cells){
for(const [w,s,color] of cell.borders){assert.equal(w,'1px','Markdown cells need visible grid borders');assert.equal(s,'solid');assert.notEqual(color,'rgba(0, 0, 0, 0)');}
assert(parseFloat(cell.padding)>=10,'cells need spacing');
}
assert.notEqual(t.cells[0].background,'rgba(0, 0, 0, 0)','header needs a theme background');
}
assert.match(styles[0].cells[0].align,/left$/);assert.match(styles[0].cells[1].align,/right$/);
if(width<800){assert(styles[1].scrollable,'wide Markdown table scrolls inside the message');await tables.nth(1).evaluate(e=>{e.scrollLeft=e.scrollWidth});assert(await tables.nth(1).evaluate(e=>e.scrollLeft>0));}
await p.screenshot({path:`/tmp/acp-markdown-table-${width}-${theme}.png`});
}
assert.deepEqual(errors,[]);await c.close();
}
await b.close();console.log('PASS Markdown table grid, cell spacing, alignment, themes, narrow-screen scrolling, no pageerror');
})().catch(e=>{console.error(e);process.exit(1)});
