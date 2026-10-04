#!/usr/bin/env node
// Run against the installed pinned bundle, not a recreated adapter implementation.
// node scripts/test_pi_acp_multisession.mjs /path/to/pi-acp/dist/index.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { patchPiAcp } from '../deploy/patch-pi-acp-multisession.mjs';
const bundlePath = process.argv[2];
assert.ok(bundlePath, 'pass actual installed pi-acp bundle path');
const raw = readFileSync(bundlePath, 'utf8');
assert.throws(() => patchPiAcp(raw, '0.0.34'), /unsupported/);
assert.throws(() => patchPiAcp(raw.replaceAll('closeAllExcept?.', 'differentShape?.'), '0.0.33'), /shape changed/);
const patched = patchPiAcp(raw, '0.0.33');
assert.equal(patchPiAcp(patched, '0.0.33'), patched, 'patch is idempotent');
function methods(source, names = ['loadSession','loadSessionRetainingPeers','loadingSessions']) {
  const ast = ts.createSourceFile('adapter.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'PiAcpAgent') {
      result = node.initializer.members.filter(m => names.includes(m.name?.getText(ast))).map(m => m.getText(ast)).join('\n');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, 'actual PiAcpAgent class located');
  return result;
}
function adapter(source) {
  const disposed = [];
  const sessions = new Map();
  let reads = 0, finish, fail;
  const proc = {getMessages() {reads++;return new Promise((resolve,reject) => {finish=()=>resolve({messages:[]});fail=()=>reject(new Error('read failed'));});}};
  for (const id of ['A','B']) sessions.set(id, {sessionId:id,proc,publishContextUsage:async()=>{}});
  const context = {Map, JSON, isAbsolute3:p=>p.startsWith('/'),
    RequestError3:{invalidParams:message=>new Error(message)},
    getEnableSkillCommands:()=>false, loadSlashCommands:()=>[],
    getSessionConfiguration:async()=>({}), setTimeout:()=>0,
  };
  const Agent = vm.runInNewContext(`(class {${methods(source)}})`, context);
  const a = new Agent();
  a.sessions = {close(id){disposed.push(id);sessions.delete(id);},closeAllExcept(id){for(const key of [...sessions.keys()])if(key!==id)this.close(key);}};
  a.findStoredSession = id => ({sessionFile:id+'.jsonl'});
  a.restoreSession = async id => sessions.get(id) ?? {sessionId:id,proc,publishContextUsage:async()=>{}};
  a.store = {upsert(){}};
  a.conn = {sessionUpdate:async()=>{}};
  return {a,disposed,reads:()=>reads,finish:()=>finish(),fail:()=>fail()};
}
const params={sessionId:'A',cwd:'/tmp',mcpServers:[]};
const legacy=adapter(raw);
const oldLoad=legacy.a.loadSession(params);
while(!legacy.reads())await new Promise(resolve=>setImmediate(resolve));
assert.ok(legacy.disposed.includes('A') && legacy.disposed.includes('B'), 'original bundle actually evicts both active and peer processes');
legacy.finish();await oldLoad;
const fixed=adapter(patched);
const first=fixed.a.loadSession(params), concurrent=fixed.a.loadSession(params);
while(!fixed.reads())await new Promise(resolve=>setImmediate(resolve));
assert.equal(fixed.reads(),1,'concurrent same-session replay coalesces');
assert.deepEqual(fixed.disposed,[],'reload preserves own and peer processes');
fixed.finish();await Promise.all([first,concurrent]);
assert.equal(fixed.a.loadingSessions.size,0,'success releases single-flight key');
const broken=fixed.a.loadSession(params);
while(fixed.reads()<2)await new Promise(resolve=>setImmediate(resolve));
fixed.fail();await assert.rejects(broken,/read failed/);
assert.equal(fixed.a.loadingSessions.size,0,'failure releases single-flight key');
const retry=fixed.a.loadSession(params);
while(fixed.reads()<3)await new Promise(resolve=>setImmediate(resolve));
fixed.finish();await retry;
console.log('PASS actual pinned bundle: legacy eviction reproduced; peers retained; same-ID loads coalesced; success/failure cleanup and retry verified');

function restoreScenario(source, deadChild) {
  const disposed = [], spawned = [];
  const healthy = {sessionId:'B',proc:{child:{exitCode:null,signalCode:null,killed:false}}};
  const initial = {sessionId:'A',cwd:'/tmp',mcpServers:[],proc:{child:deadChild}};
  const entries = new Map([['A',initial],['B',healthy]]);
  const context = {Map, process:{env:{}}, loadSlashCommands:()=>[],
    PiRpcProcess:{async spawn(params){spawned.push(params);return {child:{exitCode:null,signalCode:null,killed:false}};}},
    RequestError3:{invalidParams:msg=>new Error(msg)},
  };
  const Agent=vm.runInNewContext(`(class {${methods(source,['restoreSession','restoringSessions','validateRestoredSessionOptions'])}})`,context);
  const a=new Agent();
  a.sessions={maybeGet:id=>entries.get(id),close(id){disposed.push(id);entries.delete(id);},
    getOrCreate(id,args){const session={sessionId:id,...args};entries.set(id,session);return session;}};
  a.findStoredSession=id=>({cwd:'/tmp',sessionFile:id+'.jsonl'});
  a.store={upsert(){}};
  a.conn={};
  return {a,disposed,spawned,entries,initial,healthy};
}
const live=restoreScenario(patched,{exitCode:null,signalCode:null,killed:false});
assert.equal(await live.a.restoreSession('A'),live.initial,'healthy own process reused');
assert.deepEqual(live.disposed,[]);
assert.equal(live.spawned.length,0);
for(const child of [
  {exitCode:143,signalCode:null,killed:false},
  {exitCode:null,signalCode:'SIGTERM',killed:false},
  {exitCode:null,signalCode:null,killed:true},
]){
  const dead=restoreScenario(patched,child);
  const fresh=await dead.a.restoreSession('A');
  assert.notEqual(fresh,dead.initial,'terminated own process replaced');
  assert.deepEqual(dead.disposed,['A'],'only own dead process disposed');
  assert.equal(dead.entries.get('B'),dead.healthy,'healthy peer retained');
  assert.equal(dead.spawned.length,1,'fresh process spawned');
  assert.equal(dead.a.restoringSessions.size,0,'restore cleanup completed');
}
console.log('PASS actual restoreSession: healthy own/peer retained; exit code, signal and killed own process recreated');

await assert.rejects(live.a.restoreSession('A',{cwd:'/different',mcpServers:[]}),/different working directory/);
await assert.rejects(live.a.restoreSession('A',{cwd:'/tmp',mcpServers:[{name:'different'}]}),/different MCP servers/);
assert.deepEqual(live.disposed,[],'option mismatch never disposes live own or peers');
assert.equal(live.spawned.length,0,'option mismatch never spawns replacement');
const coalesced=restoreScenario(patched,{exitCode:null,signalCode:null,killed:false});
coalesced.entries.delete('A');
coalesced.a.restoringSessions.set('A',Promise.resolve(coalesced.initial));
await assert.rejects(coalesced.a.restoreSession('A',{cwd:'/different',mcpServers:[]}),/different working directory/);
await assert.rejects(coalesced.a.restoreSession('A',{cwd:'/tmp',mcpServers:[{name:'different'}]}),/different MCP servers/);
assert.equal(await coalesced.a.restoreSession('A',{cwd:'/tmp',mcpServers:[]}),coalesced.initial);
assert.deepEqual(coalesced.disposed,[]);
console.log('PASS healthy and in-flight reuse reject changed cwd/MCP without touching live processes');
