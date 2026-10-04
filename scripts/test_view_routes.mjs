import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
register(new URL('./test_sfc_loader.mjs',import.meta.url));
const {createPinia,setActivePinia}=await import('pinia');
const {useUiStore}=await import('../src/stores/ui.ts');
const {useSessionStore}=await import('../src/stores/session.ts');
const {viewFromUrl,setViewInUrl}=await import('../src/lib/viewUrl.ts');
const {setSessionInUrl}=await import('../src/lib/sessionUrl.ts');
const {__resetWebKvForTests}=await import('../src/lib/host/storage.ts');
let originals,events,pushes;
beforeEach(async()=>{
 originals={location:globalThis.location,history:globalThis.history,window:globalThis.window,fetch:globalThis.fetch};
 events={};pushes=[];
 globalThis.location={href:'https://example.test/board?s=Pi%3A%3AA&keep=1'};
 globalThis.history={state:{preserved:true},pushState(state,unused,url){pushes.push(String(url));location.href=String(url);},replaceState(state,unused,url){location.href=String(url);}};
 globalThis.window={addEventListener(name,callback){(events[name]??=[]).push(callback);}};
 globalThis.fetch=async url=>new Response(JSON.stringify(String(url).endsWith('/health')?{ok:true}:{rev:1,data:{activeView:'chat'}}),{status:200});
 await __resetWebKvForTests();setActivePinia(createPinia());
});
afterEach(async()=>{await __resetWebKvForTests();Object.assign(globalThis,originals);});
test('explicit route is immediately ready and wins over conflicting saved preference',async()=>{
 const ui=useUiStore();assert.equal(ui.ready,true);assert.equal(ui.activeView,'board');
 await ui.initUiStore();assert.equal(ui.activeView,'board');assert.equal(pushes.length,0);
});
test('navigation pushes once and Back/Forward adopt URL without pushing another entry',async()=>{
 const ui=useUiStore();await ui.initUiStore();await ui.setView('projects');
 assert.equal(new URL(location.href).pathname,'/projects');assert.equal(pushes.length,1);
 assert.equal(new URL(location.href).searchParams.get('keep'),'1');
 location.href='https://example.test/board?s=Pi%3A%3AA';for(const cb of events.popstate)cb();
 assert.equal(ui.activeView,'board');assert.equal(pushes.length,1);
 location.href='https://example.test/projects';for(const cb of events.popstate)cb();
 assert.equal(ui.activeView,'projects');assert.equal(pushes.length,1);
});
test('root legacy session link uses saved view and retains session parameter during canonicalization',async()=>{
 location.href='https://example.test/?s=Pi%3A%3AA';const ui=useUiStore();assert.equal(ui.ready,false);
 await ui.initUiStore();assert.equal(ui.activeView,'chat');assert.equal(new URL(location.href).pathname,'/chat');
 assert.equal(new URL(location.href).searchParams.get('s'),'Pi::A');
});
test('all supported routes parse; unknown paths and native protocol do not become a view',()=>{
 for(const v of ['board','chat','projects','dashboard'])assert.equal(viewFromUrl(`https://example.test/${v}/?s=x`),v);
 assert.equal(viewFromUrl('https://example.test/unknown'),null);assert.equal(viewFromUrl('tauri://localhost/board'),null);
});
test('background session updates preserve Board URL; Chat updates retain pathname and other query fields',()=>{
 const before=location.href;setSessionInUrl('Pi','B');assert.equal(location.href,before);
 setViewInUrl('chat');setSessionInUrl('Pi','B');
 assert.equal(new URL(location.href).pathname,'/chat');assert.equal(new URL(location.href).searchParams.get('s'),'Pi::B');
 assert.equal(new URL(location.href).searchParams.get('keep'),'1');
});

test('switching to Chat retains the focused session even while its load is pending',async()=>{
 const ui=useUiStore();const sessions=useSessionStore();
 sessions.openTabs=[{id:'pending-tab',descriptor:{agentName:'Pi',sessionId:'pending-session'},session:null}];
 sessions.activeTabId='pending-tab';
 await ui.setView('chat');
 assert.equal(new URL(location.href).pathname,'/chat');
 assert.equal(new URL(location.href).searchParams.get('s'),'Pi::pending-session');
});
