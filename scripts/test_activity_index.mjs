import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { createPinia, setActivePinia } = await import('pinia');
const { computed } = await import('vue');
const { useActivityStore } = await import('../src/stores/activity.ts');
const { runInfoFor, subagentsFor } = await import('../src/features/board/runInfo.ts');
const event = (id, sessionId, over={}) => ({id,at:10,kind:'tool-call',agentName:'Pi',sessionId,title:'shared title',...over});

test('indexed activity preserves session matching, legacy title fallback and delegate outcomes', () => {
 setActivePinia(createPinia()); const activity=useActivityStore();
 activity.entries=[event('foreign','other',{detail:'exit=1',at:99}),event('first','s1'),event('start','s1',{kind:'delegate',subagent:'worker',goal:'task',subState:'running',at:20}),event('finish','s1',{kind:'delegate',subagent:'worker',subState:'done',detail:'done',at:30}),event('end','s1',{detail:'exit=0',at:40})];
 const card={title:'shared title',session:{agentName:'Pi',sessionId:'s1'}};
 const rows=activity.entriesForRun('s1',card.title);
 assert.equal(runInfoFor(card,null,rows,50).endedAt,40);
 assert.equal(runInfoFor(card,null,rows,50).startedAt,10);
 assert.equal(subagentsFor('s1',rows,50)[0].durationMs,10);
 assert.equal(subagentsFor('s1',rows,50)[0].state,'done');
 assert.deepEqual(activity.entriesForRun('',card.title).map(e=>e.id),activity.entries.map(e=>e.id));
 assert.deepEqual(activity.entriesForRun('missing',card.title),[]);
});

test('live append, bounded rollover and remote snapshot replacement update card state', () => {
 setActivePinia(createPinia()); const activity=useActivityStore();
 activity.entries=Array.from({length:5000},(_,i)=>event(String(i),'other'));
 const rows=computed(()=>activity.entriesForRun('live','title'));
 assert.equal(rows.value.length,0);
 activity.recordEntry({kind:'turn-start',agentName:'Pi',sessionId:'live',at:30});
 assert.equal(activity.entries.length,5000);
 assert.equal(rows.value.length,1);
 assert.ok(activity.liveSessions.has('live'));
 activity.recordEntry({kind:'turn-end',agentName:'Pi',sessionId:'live',at:40,detail:'exit=0'});
 assert.equal(rows.value.length,2);
 assert.ok(!activity.liveSessions.has('live'));
 activity.entries=[event('remote','live',{detail:'exit=1',at:60})];
 assert.equal(rows.value.length,1);
 assert.equal(rows.value[0].id,'remote');
});

test('many card lookups and clock ticks do not rescan a 5000-row ledger', () => {
 setActivePinia(createPinia()); const activity=useActivityStore(); let reads=0;
 activity.entries=Array.from({length:5000},(_,i)=>({id:String(i),at:i,kind:'tool-call',agentName:'Pi',title:'title',get sessionId(){reads++;return 's'+(i%47);}}));
 for(let clock=0;clock<3;clock++) for(let card=0;card<47;card++) {
  const rows=activity.entriesForRun('s'+card,'title');
  assert.equal(rows.length,card<18?107:106);
 }
 assert.ok(reads<=10000,`ledger was rescanned per card/tick: ${reads} field reads`);
});
