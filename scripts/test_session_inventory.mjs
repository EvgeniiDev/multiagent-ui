import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { loadKvStore, __resetWebKvForTests } = await import('../src/lib/host/storage.ts');
const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval;
const session = id => ({ id, sessionId: id, agentName: 'Codex', title: id, lastUpdated: 1 });
let poll;
afterEach(async () => { await __resetWebKvForTests(); globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval; });
function backend() {
 let remote = {rev:1,updatedAt:1,data:{sessions:[session('old')]}};
 globalThis.setInterval = fn => { poll = fn; return originalInterval(fn, 999999); };
 globalThis.fetch = async (url, init = {}) => {
  if(String(url).endsWith('/health')) return Response.json({ok:true});
  if(init.method !== 'PUT') return Response.json(remote);
  const body=JSON.parse(init.body);
  if(body.rev!==remote.rev) return Response.json({}, {status:409});
  remote={rev:remote.rev+1,updatedAt:remote.updatedAt+1,data:body.data};
  return Response.json(remote);
 };
 return { read:()=>remote, add(id) {remote={rev:remote.rev+1,updatedAt:Date.now()+100,data:{...remote.data,sessions:[...remote.data.sessions,session(id)]}};} };
}
test('an already open phone receives new desktop sessions from the remote poll', async () => {
 const server=backend(), store=await loadKvStore('sessions.json');
 let seen=[];
 store.subscribe(data=>{seen=data.sessions.map(s=>s.id);});
 server.add('desktop'); await poll(); await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(seen,['old','desktop']);
});
test('a stale device saving its own new session cannot overwrite desktop sessions',async()=>{
 const server=backend(),store=await loadKvStore('sessions.json');
 await store.set('sessions',[session('old'),session('phone')]);
 server.add('desktop'); await store.save();
 assert.deepEqual(server.read().data.sessions.map(s=>s.id).sort(),['desktop','old','phone']);
});
test('a stale device closing tabs preserves remotely edited session metadata',async()=>{
 const server=backend(),store=await loadKvStore('sessions.json');
 server.add('desktop');server.read().data.sessions[0].title='Renamed on desktop';
 await store.set('sessions',[session('old')]);await store.set('openTabs',[]);await store.save();
 assert.equal(server.read().data.sessions.find(s=>s.id==='old').title,'Renamed on desktop');
 assert.equal(server.read().data.sessions.length,2);
});

test('conflict merge keeps remote additions while applying explicit local deletion and archive',async()=>{
 const {mergeSessionInventory}=await import('../src/lib/sessionInventory.ts');
 const first=session('first'),second=session('second');
 const result=mergeSessionInventory({sessions:[first,second]}, {sessions:[{...second,archivedAt:123}]}, {sessions:[{...first,title:'Remote title'},second,session('desktop')]});
 assert.deepEqual(result.sessions.map(s=>s.id).sort(),['desktop','second']);
 assert.equal(result.sessions.find(s=>s.id==='second').archivedAt,123);
});
test('a remote deletion is not resurrected by saving unchanged local metadata',async()=>{
 const {mergeSessionInventory}=await import('../src/lib/sessionInventory.ts');
 const original={sessions:[session('old')]};
 assert.deepEqual(mergeSessionInventory(original,original,{sessions:[]}).sessions,[]);
});
