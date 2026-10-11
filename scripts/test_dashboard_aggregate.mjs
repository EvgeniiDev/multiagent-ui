import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { aggregateUsage, localDayKey } = await import('../src/features/dashboard/aggregate.ts');
const row = (tokens, extra = {}) => ({ at: 1000, agentName: 'Pi', sessionId: 'same', cwd: '/project', model: 'M', provider: 'P', source: 'agent', tokens, ...extra });
test('all breakdowns conserve spend and keep agent/session identity and currencies', () => {
  const r = aggregateUsage([row(100, {cost:1,currency:'USD'}),row(200,{agentName:'Codex',cost:2,currency:'EUR'}),row(50,{source:'estimate',at:2000})],[]);
  assert.equal(r.total.tokens,350);assert.equal(r.total.sessions,2);assert.equal(r.total.estTokens,50);
  assert.deepEqual(r.total.costs,[{currency:'EUR',amount:2},{currency:'USD',amount:1}]);
  for(const key of ['models','projects','agents','sessions','days']) assert.equal(r[key].reduce((n,x)=>n+x.tokens,0),350,key);
});
test('latest activity and titles survive grouping without dropping zero-usage histories', () => {
  const e = [{id:'a',at:4000,kind:'turn-end',agentName:'Pi',sessionId:'same',cwd:'/project',title:'Latest title'},
    {id:'b',at:2000,kind:'turn-end',agentName:'Pi',sessionId:'same',cwd:'/project',title:'Older title'}];
  const r=aggregateUsage([row(100),row(50,{at:3000})],e,[{agentName:'Devin',status:'ready',samples:0}]);
  assert.equal(r.sessions[0].name,'Latest title');assert.equal(r.sessions[0].lastAt,3000);
  assert.equal(r.total.turns,2);assert.equal(r.models[0].turns,2);
  assert.equal(r.agents.find(x=>x.name==='Devin').tokens,0);
});
test('provider and local date boundaries have separate buckets and absent costs stay unknown', () => {
  const first=new Date(2026,9,7,23,59).getTime(),second=new Date(2026,9,8,0,1).getTime();
  const r=aggregateUsage([row(100,{at:first}),row(200,{at:second,provider:'P2'})],[]);
  assert.equal(r.models.length,2);assert.equal(r.days.length,2);
  assert.equal(r.days[1].key,localDayKey(second));assert.deepEqual(r.total.costs,[]);
});
const { toCsv } = await import('../src/features/dashboard/exportData.ts');
test('CSV preserves separate currencies and distinguishes unavailable cost from reported zero', () => {
  const csv=toCsv([
    {day:'2026-10-07',tokens:100,turns:1,cost:null,costs:[{currency:'USD',amount:1},{currency:'EUR',amount:.5}]},
    {day:'2026-10-06',tokens:50,turns:1,cost:null,costs:[]},
    {day:'2026-10-05',tokens:20,turns:1,cost:0,costs:[{currency:'USD',amount:0}]},
  ]);
  assert.equal(csv,'day,tokens,cost,turns,currency,reported_costs\n2026-10-07,100,,1,,1 USD | 0.5 EUR\n2026-10-06,50,,1,,\n2026-10-05,20,0,1,USD,0 USD\n');
});
test('token mix buckets aggregate per group and total', () => {
  const r = aggregateUsage([row(360,{input:100,output:40,cacheRead:200,cacheWrite:20}),row(50,{agentName:'Codex',input:50,output:0})],[]);
  assert.equal(r.total.input,150);assert.equal(r.total.output,40);assert.equal(r.total.cacheRead,200);assert.equal(r.total.cacheWrite,20);
  assert.equal(r.agents.find(x=>x.name==='Pi').cacheRead,200);
});
