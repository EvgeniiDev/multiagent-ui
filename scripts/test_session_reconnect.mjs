import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
register(new URL('./test_sfc_loader.mjs',import.meta.url));
const {createPinia,setActivePinia}=await import('pinia');
const {useSessionStore}=await import('../src/stores/session.ts');
beforeEach(()=>setActivePinia(createPinia()));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('the active eighth chat recovers without waiting for seven slow background chats',async()=>{
 const store=useSessionStore();const starts=[];let visibleAt;
 const started=performance.now();
 for(let i=0;i<8;i++)store.openTabs.push({id:`tab-${i}`,async tryReconnect(){
  starts.push(i);await delay(i===7?5:40);if(i===7)visibleAt=performance.now()-started;return true;
 }});
 store.activeTabId='tab-7';
 await store.tryReconnect();
 console.log(JSON.stringify({activeRecoveryMs:Math.round(visibleAt),totalMs:Math.round(performance.now()-started),starts}));
 assert.equal(starts[0],7,'foreground chat must be checked first');
 assert(visibleAt<100,'active chat waited behind background recovery');
});
test('one failed background recovery cannot prevent the active chat or other chats from recovering',async()=>{
 const store=useSessionStore();const called=[];
 for(const id of ['broken','other','active'])store.openTabs.push({id,async tryReconnect(){called.push(id);if(id==='broken')throw new Error('failed background probe');return id==='active';}});
 store.activeTabId='active';
 assert.equal(await store.tryReconnect(),true);
 assert.deepEqual(new Set(called),new Set(['broken','other','active']));
});
