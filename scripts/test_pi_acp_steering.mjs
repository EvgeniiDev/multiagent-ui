#!/usr/bin/env node
// Uses methods extracted from the real pinned bundle; never starts Pi or a model.
// node scripts/test_pi_acp_steering.mjs /path/to/pi-acp/dist/index.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchPiAcpSteering } from '../deploy/patch-pi-acp-steering.mjs';
import { patchPiAcp } from '../deploy/patch-pi-acp-multisession.mjs';
const bundlePath = process.argv[2];
assert.ok(bundlePath, 'pass actual pinned pi-acp bundle path');
const raw = readFileSync(bundlePath, 'utf8');
// Characterize the legacy behavior directly: a busy ACP prompt is queued,
// and no native steering command is exposed by the pristine adapter.
assert.equal(raw.includes('  async acpUiSteering('),false,'legacy adapter lacks steering extension');
const sessionPrompt = raw.slice(raw.indexOf('var PiAcpSession = class {')).match(/^  async prompt\(message, images = \[\]\) \{[\s\S]*?^  \}/m)?.[0];
assert.ok(sessionPrompt);
const LegacySession = vm.runInNewContext(`(class {${sessionPrompt}})`, {expandSlashCommand:text=>text});
const legacy = new LegacySession();
legacy.pendingTurn = {};
legacy.turnQueue = [];
legacy.emit = () => {};
legacy.startTurn = () => {throw new Error('busy turn must not start');};
void legacy.prompt('legacy queued text');
assert.equal(legacy.turnQueue.length,1,'legacy busy prompt enters ACP queue');
assert.equal(legacy.turnQueue[0].message,'legacy queued text');
const patched = patchPiAcpSteering(raw, '0.0.33');
assert.throws(() => patchPiAcpSteering(raw, '0.0.34'), /unsupported/);
assert.equal(patchPiAcpSteering(patched, '0.0.33'), patched, 'idempotent');
assert.throws(() => patchPiAcpSteering(raw.replace('      agentCapabilities: {', '      changedCapabilities: {'), '0.0.33'), /shape changed/);
assert.throws(() => patchPiAcpSteering(patched.replace('type: "steer"', 'type: "prompt"'), '0.0.33'), /shape changed/, 'marker alone cannot bypass validation');
assert.throws(() => patchPiAcpSteering(patched.replace('// acp-ui: native non-interrupting Pi steering (v1)','// removed marker'), '0.0.33'), /shape changed/, 'partial prior patch is rejected');
const multi = patchPiAcp(raw, '0.0.33');
assert.equal(patchPiAcpSteering(multi, '0.0.33'), patchPiAcp(patched, '0.0.33'), 'multisession patches commute');
function method(source, name) {
  const match = source.match(new RegExp(`^  async ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `real method ${name} found`);
  return match[0];
}
const RequestError3 = { invalidParams: message => new Error(message), methodNotFound: method => new Error(`method not found: ${method}`) };
const converter = raw.match(/^function promptToPiMessage\(blocks\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(converter, 'real prompt converter found');
const context = vm.createContext({ RequestError3, Buffer, pkg:{name:'pi-acp',version:'0.0.33'}, getAuthMethods:()=>[], process:{env:{}} });
vm.runInContext(converter, context);
const Agent = vm.runInContext(`(class {${['initialize','extMethod','acpUiSteering'].map(n=>method(patched,n)).join('\n')}})`, context);
const Proc = vm.runInContext(`(class {${method(patched,'steer')}})`, context);
const requests = [];
const entries = new Map();
for (const sessionId of ['A','B']) {
  const proc = new Proc();
  proc.request = async command => { requests.push({sessionId,...command});return {success:true}; };
  entries.set(sessionId, {sessionId,proc,pendingTurn:{},turnQueue:[],cancelRequested:false});
}
const agent = new Agent();
agent.sessions = {maybeGet:id=>entries.get(id),create(){throw new Error('must never create');},getOrCreate(){throw new Error('must never create');}};
agent.restoreSession = () => { throw new Error('must never restore'); };
const result = await agent.initialize({protocolVersion:1,clientCapabilities:{}});
assert.equal(result._meta.steering.supported,true);
assert.equal(result.agentCapabilities.promptCapabilities.image,true);
const text = [{type:'text',text:'Keep working; '},{type:'text',text:'focus here'}];
assert.equal((await agent.extMethod('_session/steering',{sessionId:'A',prompt:text})).outcome,'injected');
assert.deepEqual(JSON.parse(JSON.stringify(requests)),[{sessionId:'A',type:'steer',message:'Keep working; focus here',images:[]}]);
const image = {type:'image',mimeType:'image/png',data:'aGVsbG8='};
await agent.extMethod('_session/steering',{sessionId:'B',prompt:[{type:'text',text:'See this'},image]});
assert.equal(requests[1].sessionId,'B');
assert.equal(requests[1].images[0].data,image.data);
await agent.extMethod('_session/steering',{sessionId:'A',prompt:[image]});
assert.equal(requests[2].message,'','image-only steering supported');
assert.equal(entries.get('A').turnQueue.length,0,'never uses ACP prompt queue');
assert.equal(entries.get('B').turnQueue.length,0);
assert.equal(entries.get('A').cancelRequested,false,'does not cancel pending turn');
assert.equal(requests.every(r=>r.type==='steer'),true,'never aborts, cancels, or sends normal prompt');
// Independent active sessions can steer concurrently without sharing state.
await Promise.all(['A','B'].map(sessionId=>agent.extMethod('_session/steering',{sessionId,prompt:text})));
assert.deepEqual(requests.slice(-2).map(r=>r.sessionId),['A','B']);
const before = requests.length;
for (const params of [
  {},{sessionId:4,prompt:text},{sessionId:'missing',prompt:text},
  {sessionId:'A'},{sessionId:'A',prompt:[]},{sessionId:'A',prompt:[null]},
  {sessionId:'A',prompt:[{type:'text',text:3}]},{sessionId:'A',prompt:[{type:'text',text:'  '}]},
  ...['audio','resource','resource_link','unknown'].map(type=>({sessionId:'A',prompt:[{type,data:'aGVsbG8='}]})),
  ...[{...image,mimeType:'image/svg+xml'},{...image,data:''},{...image,data:'not base64!'}, {type:'image',mimeType:'image/png',uri:'https://example.test/image.png'}].map(block=>({sessionId:'A',prompt:[block]})),
]) await assert.rejects(agent.extMethod('_session/steering',params));
entries.get('A').pendingTurn = null;
await assert.rejects(agent.extMethod('_session/steering',{sessionId:'A',prompt:text}),/active turn/);
assert.equal(requests.length,before,'invalid/unknown/idle requests never reach RPC');
entries.get('A').pendingTurn = {};
entries.get('A').proc.request = async () => ({success:false,error:'provider rejected'});
await assert.rejects(agent.extMethod('_session/steering',{sessionId:'A',prompt:text}),/pi steer failed: provider rejected/);
entries.get('A').proc.request = async () => {throw new Error('closed pipe');};
await assert.rejects(agent.extMethod('_session/steering',{sessionId:'A',prompt:text}),/closed pipe/);
assert.ok(entries.get('A').pendingTurn,'RPC failure leaves pending turn intact');
await assert.rejects(agent.extMethod('_unknown',{}),/method not found/);
// An existing dispatcher (e.g. the installed image-cleanup patch) must survive.
const cleanupSource = raw.includes('  async extMethod(') ? raw : raw.replace('  async deleteSession(params) {', `  async extMethod(method, params) {
    if (method === '_acp-ui/pi/clear_session_images') return this.acpUiClearSessionImages(params ?? {});
    throw RequestError3.methodNotFound(method);
  }
  async deleteSession(params) {`);
const cleanupPatched = patchPiAcpSteering(cleanupSource,'0.0.33');
const CleanupAgent = vm.runInContext(`(class {${method(cleanupPatched,'extMethod')}})`,context);
const cleanup = new CleanupAgent();
cleanup.acpUiClearSessionImages = params => ({removed:3,sessionId:params.sessionId});
assert.deepEqual(await cleanup.extMethod('_acp-ui/pi/clear_session_images',{sessionId:'A'}),{removed:3,sessionId:'A'});
console.log('PASS actual pinned methods: capability, text/images, validation, session scope, active turn, native RPC failures, no cancellation/queue, patch shape/idempotence, multisession and image-cleanup compatibility');
