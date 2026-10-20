// Run the actual session runtime with deterministic ACP and cache boundaries.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import ts from 'typescript';
import { HISTORY_TAIL_MESSAGES } from '../src/lib/historyCache.ts';
import { markPromptRecorded } from '../src/lib/promptError.ts';
import { createPromptOutbox } from '../src/lib/promptOutbox.ts';
import { steeringDelivery } from '../src/lib/steeringDelivery.ts';

let client, entries, cached, cacheWrites, sharedReader, notifications;
let seq = 0;
let canonicalStatuses = null;
let remoteEvidence = vue.ref(null);
globalThis.__replayRuntimeDeps = {
  HISTORY_TAIL_MESSAGES,
  ref: vue.ref, computed: vue.computed, watch: vue.watch, markPromptRecorded, createPromptOutbox, steeringDelivery,
  uuid: () => `test-${++seq}`,
  getAppVersion: async () => 'test',
  trackEvent() {}, trackError() {},
  getTransportKind: () => 'websocket',
  isDesktop: () => false,
  useConfigStore: () => ({ getAgent: () => ({ transport: 'websocket' }) }),
  useSessionStatusStore: () => ({
    forSession: (agent, id) => canonicalStatuses?.value[`${agent}:${id}`],
    remoteForSession: () => remoteEvidence.value,
    remoteReadVersion: () => 0,
    refresh: async () => {},
    record(session, status) { if (canonicalStatuses) canonicalStatuses.value = { ...canonicalStatuses.value, [`${session.agentName}:${session.sessionId}`]: { status, at: Date.now() } }; },
  }),
  useActivityStore: () => ({ recordEntry: entry => entries.push(entry), recordUsage() {} }),
  createAcpClient: async () => client,
  AcpClientBridge: class {},
  readHistoryCache: () => cached,
  readSharedHistoryCache: (...args) => sharedReader(...args),
  writeSharedHistoryCache: async () => {},
  storeHistoryCacheEntry() {},
  writeHistoryCache: (...args) => { cacheWrites.push(args); return null; },
  dropHistoryCache() {},
  turnAttachments: () => [], recordTurnAttachments() {},
  resolveCachedBytes: async () => {}, attachmentFromContentBlock: () => null,
  onAgentStderr() {}, spawnAgent() {}, killAgent() {},
};
const source = readFileSync(new URL('../src/lib/sessionRuntime.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText.replace(/^import .*;$/gm, '');
const { createSessionRuntime } = await import('data:text/javascript;base64,' + Buffer.from(
  `const {${Object.keys(globalThis.__replayRuntimeDeps).join(',')}} = globalThis.__replayRuntimeDeps;\n${js}`
).toString('base64'));
const saved = { agentName: 'Pi', sessionId: 'history', cwd: '/work', title: 'existing', supportsLoadSession: true };
const deps = { async requestAuth() { return 'token'; }, async persistSessions() {}, notifyActivity() { notifications++; } };
function emit(update, meta) { client.onSessionUpdate({ sessionId: saved.sessionId, update, ...(meta ? { _meta: meta } : {}) }); }
function replay() {
  emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
  emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
  emit({ sessionUpdate: 'tool_call', toolCallId: 'historical-tool', title: 'old search', kind: 'search', status: 'pending' });
  emit({ sessionUpdate: 'tool_call_update', toolCallId: 'historical-tool', status: 'completed' });
  emit({ sessionUpdate: 'session_info_update', title: 'existing' });
}
function live() {
  emit({ sessionUpdate: 'tool_call', toolCallId: 'live-tool', title: 'new search', kind: 'search', status: 'pending' });
  emit({ sessionUpdate: 'session_info_update', title: 'new title' });
  assert.deepEqual(entries.filter(e => e.kind === 'tool-call' || e.kind === 'sync').map(e => e.title), ['new search', 'new title']);
}
beforeEach(() => {
  canonicalStatuses = null; remoteEvidence.value = null; delete saved.lastTurnStatus;
  notifications = 0; entries = []; cached = null; cacheWrites = []; sharedReader = async () => null;
  client = {
    pendingPermissionRequest: vue.ref(null),
    async initialize() { return {}; },
    async loadSession() { replay(); return {}; },
    async disconnect() {},
  };
});

for (const cache of [false, true]) {
  test(`history restores transcript but adds no fresh activity (${cache ? 'cached' : 'first'} load)`, async () => {
    if (cache) cached = { userTurnBase: 0, messages: [{ id: 'cached-user', role: 'user', content: 'old question', timestamp: 1 }] };
    const rt = createSessionRuntime(deps);
    try {
      await rt.resume({ ...saved });
      assert.deepEqual(entries.map(e => e.kind), ['session-open']);
      assert.equal(notifications, 0, 'replay must not signal unread live work');
      assert.equal(rt.messages.value[0].content, 'old question');
      assert.equal(rt.messages.value[1].content, 'old answer');
      assert.equal(rt.toolCallList.value[0].status, 'completed');
      live();
    } finally { await rt.close(); }
  });
}

test('repeated restores keep historical activity out and retain later live events', async () => {
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved });
    await rt.resume({ ...saved });
    assert.deepEqual(entries.map(e => e.kind), ['session-open', 'session-open']);
    assert.equal(rt.toolCallList.value.length, 1);
    live();
  } finally { await rt.close(); }
});

test('asynchronous frames remain historical until the load promise settles', async () => {
  const rt = createSessionRuntime(deps);
  let finish, started;
  const pending = new Promise(resolve => { started = resolve; });
  client.loadSession = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  try {
    const restoring = rt.resume({ ...saved });
    await pending;
    replay();
    await vue.nextTick();
    assert.deepEqual(entries, []);
    assert.equal(rt.isConnected.value, false);
    finish({});
    await restoring;
    assert.equal(rt.isRestoringHistory.value, false);
    assert.deepEqual(entries.map(e => e.kind), ['session-open']);
    live();
  } finally { await rt.close(); }
});

test('failed restore releases the replay guard; the next restore and live updates work', async () => {
  const rt = createSessionRuntime(deps);
  client.loadSession = async () => { replay(); throw new Error('history transport failed'); };
  try {
    await assert.rejects(rt.resume({ ...saved }), /history transport failed/);
    assert.deepEqual(entries.map(e => e.kind), ['error']);
    // Prove the guard was released on rejection, independently of the next resume.
    live();
    entries = [];
    client.loadSession = async () => { replay(); return {}; };
    await rt.resume({ ...saved });
    assert.deepEqual(entries.map(e => e.kind), ['session-open']);
    live();
  } finally { await rt.close(); }
});

test('both initial and authenticated retry loads suppress historical activity', async () => {
  const rt = createSessionRuntime(deps);
  let loads = 0;
  client.initialize = async () => ({ authMethods: [{ id: 'token', name: 'Token' }] });
  client.authenticate = async () => ({});
  client.loadSession = async () => {
    replay();
    if (++loads === 1) throw new Error('Authentication required');
    return {};
  };
  try {
    await rt.resume({ ...saved });
    assert.equal(loads, 2);
    assert.deepEqual(entries.map(e => e.kind), ['session-open']);
    live();
  } finally { await rt.close(); }
});


test('shared newest tail arrives during replay, never replaced by its older prefix', async () => {
  const tail = { version: 1, savedAt: Date.now(), userTurnBase: 0, messages: [
    { id: 'shared-user', role: 'user', content: 'old question', timestamp: 1 },
    { id: 'shared-agent', role: 'assistant', content: 'old answer', timestamp: 1 },
  ] };
  let deliverShared, finishLoad, beginLoad;
  sharedReader = () => new Promise(resolve => { deliverShared = resolve; });
  const begun = new Promise(resolve => { beginLoad = resolve; });
  client.loadSession = () => { beginLoad(); return new Promise(resolve => { finishLoad = resolve; }); };
  const rt = createSessionRuntime(deps);
  try {
    const restoring = rt.resume({ ...saved });
    await begun;
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
    assert.equal(rt.messages.value.length, 0, 'cold replay prefixes stay off the rendered feed');
    deliverShared(tail);
    await vue.nextTick();
    assert.equal(rt.messages.value.at(-1).content, 'old answer');
    assert.equal(rt.historyCacheNote.value, 'loading');
    assert.equal(cacheWrites.length, 0, 'replay cannot overwrite the newest tail cache');
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
    assert.equal(rt.messages.value.at(-1).id, 'shared-agent');
    finishLoad({}); await restoring;
    assert.equal(rt.messages.value.length, 2);
    assert.equal(rt.messages.value.at(-1).id, 'shared-agent');
    assert.equal(rt.historyCacheNote.value, null);
  } finally { await rt.close(); }
});

test('tool calls split narration into ordered parts instead of gluing text', async () => {
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved });
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first.' } });
    emit({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run ls', kind: 'execute', status: 'pending' });
    emit({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second.' } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' continues' } });
    const m = rt.messages.value.at(-1);
    // The flat field keeps the raw concat (merge/cache compat)…
    assert.equal(m.content, 'first.Second. continues');
    // …while segments keep the arrival order the renderer needs.
    assert.deepEqual(m.segments.map(s => s.kind), ['text', 'tool', 'text']);
    assert.equal(m.segments[0].text, 'first.');
    assert.equal(m.segments[1].toolCallId, 't1');
    assert.equal(m.segments[2].text, 'Second. continues');
    assert.equal(m.toolCalls[0].status, 'completed');
  } finally { await rt.close(); }
});

test('a tool_call_update for an unannounced call materializes the chip', async () => {
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved });
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'intro' } });
    emit({ sessionUpdate: 'tool_call_update', toolCallId: 'orphan', status: 'completed', rawOutput: 'result text' });
    const m = rt.messages.value.at(-1);
    assert.equal(m.toolCalls[0].toolCallId, 'orphan');
    assert.equal(m.toolCalls[0].status, 'completed');
    assert.equal(m.toolCalls[0].rawOutput, 'result text');
    assert.equal(rt.toolCallList.value.at(-1).toolCallId, 'orphan');
    assert.deepEqual(m.segments.map(s => s.kind), ['text', 'tool']);
    // and later updates still merge into the materialized call
    // (rawOutput frames are snapshots — they replace, terminal_output appends)
    emit({ sessionUpdate: 'tool_call_update', toolCallId: 'orphan', rawOutput: 'more' });
    assert.equal(m.toolCalls[0].rawOutput, 'more');
  } finally { await rt.close(); }
});

test('plan updates land as a card pinned where the agent published it', async () => {
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved });
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'planning' } });
    emit({ sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'in_progress' }] });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
    const m = rt.messages.value.at(-1);
    assert.equal(m.plan[0].content, 'step one');
    assert.deepEqual(m.segments.map(s => s.kind), ['text', 'plan', 'text']);
    // a later snapshot refreshes the card in place, it does not add a second one
    emit({ sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'completed' }] });
    assert.deepEqual(m.segments.map(s => s.kind), ['text', 'plan', 'text']);
    assert.equal(m.plan[0].status, 'completed');
  } finally { await rt.close(); }
});

test('late shared snapshot cannot resurrect a closed or settled runtime', async () => {
  let deliver;
  sharedReader = () => new Promise(resolve => { deliver = resolve; });
  const rt = createSessionRuntime(deps);
  await rt.resume({ ...saved });
  await rt.close();
  deliver({ version: 1, savedAt: Date.now(), userTurnBase: 0, messages: [{ id: 'late', role: 'user', content: 'late cached data', timestamp: 1 }] });
  await vue.nextTick();
  assert.equal(rt.messages.value.length, 0);
});

test('session ordering follows messages, never opening, replay, or service events', async () => {
  const rt = createSessionRuntime(deps);
  const session = { ...saved, lastUpdated: 100 };
  try {
    await rt.resume(session);
    assert.equal(session.lastUpdated, 100, 'opening/replaying keeps the original message timestamp');
    emit({ sessionUpdate: 'session_info_update', title: 'Renamed' });
    emit({ sessionUpdate: 'tool_call', toolCallId: 'service-event', title: 'Tool only', kind: 'search', status: 'pending' });
    assert.equal(session.lastUpdated, 100, 'metadata and tools do not affect ordering');
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'New answer' } });
    assert(session.lastUpdated > 100, 'live agent messages update ordering');
    rt.session.value.lastUpdated = 100;
    client.prompt = async () => ({ stopReason: 'end_turn' });
    await rt.sendPrompt('New question');
    assert(session.lastUpdated > 100, 'sending a user message updates ordering');
  } finally { await rt.close(); }
});


test('only a successful latest prompt marks completion, never replay or intermediate output', async () => {
  const rt = createSessionRuntime(deps);
  const pending = [];
  client.prompt = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  client.cancel = async () => {};
  try {
    await rt.resume({ ...saved });
    assert.equal(rt.turnCompleted.value, false, 'history is not a live completion');
    assert.equal(rt.turnIssue.value, null);
    const first = rt.sendPrompt('work');
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } });
    assert.equal(rt.turnCompleted.value, false);
    pending.shift().resolve({ stopReason: 'end_turn' }); await first;
    assert.equal(rt.turnCompleted.value, true);
    assert.equal(rt.turnIssue.value, null);
    const next = rt.sendPrompt('continue');
    assert.equal(rt.turnCompleted.value, false, 'new prompt clears completion');
    pending.shift().resolve({ stopReason: 'cancelled' }); await next;
    assert.equal(rt.turnIssue.value, 'cancelled');
    assert.equal(rt.turnCompleted.value, false);
    for (const stopReason of ['max_tokens', 'max_turn_requests', 'refusal']) {
      const limited = rt.sendPrompt('work');
      assert.equal(rt.turnIssue.value, null, 'new work clears issue');
      pending.shift().resolve({ stopReason }); await limited;
      assert.equal(rt.turnCompleted.value, false, stopReason);
    }
    const old = rt.sendPrompt('old');
    const latest = rt.sendPrompt('latest');
    pending.shift().resolve({ stopReason: 'end_turn' }); await old;
    assert.equal(rt.turnCompleted.value, false, 'older request cannot finish a newer turn');
    pending.shift().reject(new Error('failed')); await assert.rejects(latest, /failed/);
    assert.equal(rt.turnIssue.value, 'error');
    assert.equal(rt.turnCompleted.value, false);
    const cancelled = rt.sendPrompt('cancel');
    await rt.cancelOperation();
    assert.equal(rt.turnIssue.value, 'cancelled');
    pending.shift().resolve({ stopReason: 'end_turn' }); await cancelled;
    assert.equal(rt.turnCompleted.value, false, 'ignored cancel cannot show success');
    const stale = rt.sendPrompt('stale');
    const fresh = rt.sendPrompt('fresh');
    const staleReply = pending.shift();
    pending.shift().resolve({ stopReason: 'end_turn' }); await fresh;
    staleReply.reject(new Error('old failure')); await assert.rejects(stale, /old failure/);
    assert.equal(rt.turnIssue.value, null, 'old failure cannot replace newer success');
    const final = rt.sendPrompt('finish');
    pending.shift().resolve({ stopReason: 'end_turn' }); await final;
    assert.equal(rt.turnCompleted.value, true);
    await rt.resume({ ...rt.session.value });
    assert.equal(rt.turnCompleted.value, true, 'reopening preserves a confirmed completion');
    assert.equal(rt.turnIssue.value, null);
  } finally { await rt.close(); }
});


test('confirmed outcomes survive history replay and closing without promoting old transcript', async () => {
  for (const lastTurnStatus of ['completed', 'cancelled', 'error', 'output']) {
    const record = { ...saved, lastTurnStatus };
    const rt = createSessionRuntime(deps);
    await rt.resume(record);
    assert.equal(rt.turnCompleted.value, lastTurnStatus === 'completed');
    assert.equal(rt.turnIssue.value, ['error', 'cancelled'].includes(lastTurnStatus) ? lastTurnStatus : null);
    await rt.close();
    assert.equal(record.lastTurnStatus, lastTurnStatus, 'close must retain saved outcome');
  }
});
test('reconnect retains the already visible transcript instead of rolling back to an older cache', async () => {
  const rt = createSessionRuntime(deps);
  let finish, restoring;
  try {
    await rt.resume({ ...saved });
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'today question' } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'today answer' } });
    const visible = rt.messages.value.map(m => ({ id: m.id, content: m.content }));
    cached = { version: 1, savedAt: 1, userTurnBase: 0, messages: [
      { id: 'yesterday-cache', role: 'assistant', content: 'yesterday answer', timestamp: 1 },
    ] };
    sharedReader = async () => ({ ...cached, savedAt: Date.now() + 1000 });
    let begin;
    const begun = new Promise(resolve => { begin = resolve; });
    client.loadSession = () => { begin(); return new Promise(resolve => { finish = resolve; }); };
    client.onTransportClose('test disconnected');
    restoring = rt.resume({ ...saved });
    await begun;
    await vue.nextTick();
    assert.deepEqual(rt.messages.value.map(m => ({ id: m.id, content: m.content })), visible,
      'reconnecting an open tab must not replace today with an older local/shared snapshot');
    replay();
    assert.equal(rt.messages.value.at(-1).content, 'today answer', 'old replay prefix remains buffered');
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'today question' } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'today answer' } });
    finish({});
    await restoring;
    assert.equal(rt.messages.value.at(-1).id, visible.at(-1).id);
    assert.equal(rt.messages.value.at(-1).content, 'today answer');
  } finally {
    finish?.({});
    await restoring?.catch(() => {});
    await rt.close();
  }
});

test('updates after replay settles stay live while metadata persistence is pending', async () => {
  let release, begin;
  const begun = new Promise(resolve => { begin = resolve; });
  const pendingSave = new Promise(resolve => { release = resolve; });
  const rt = createSessionRuntime({ ...deps, persistSessions: () => {
    begin(); return pendingSave;
  } });
  const restoring = rt.resume({ ...saved });
  try {
    await begun;
    assert.equal(rt.isConnected.value, true);
    assert.equal(rt.isRestoringHistory.value, true, 'UI still owns a pending restore operation');
    assert.ok(cacheWrites.length > 0, 'settled history must refresh the cache before metadata save finishes');
    entries = []; notifications = 0;
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'genuine live continuation' } });
    live();
    assert.equal(notifications, 3);
    assert.ok(rt.session.value.lastMessageAt > 0);
    release(); await restoring;
    assert.equal(rt.isRestoringHistory.value, false);
  } finally { release?.(); await restoring.catch(() => {}); await rt.close(); }
});

test('retained replay materializes update-only tools instead of matching the old index', async () => {
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved });
    assert.equal(rt.messages.value.at(-1).toolCalls[0].toolCallId, 'historical-tool');
    client.loadSession = async () => {
      emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
      emit({ sessionUpdate: 'tool_call_update', toolCallId: 'historical-tool', title: 'old search', kind: 'search', status: 'completed' });
      return {};
    };
    await rt.resume({ ...saved });
    assert.equal(rt.messages.value.at(-1).toolCalls[0].toolCallId, 'historical-tool');
    assert.equal(rt.messages.value.at(-1).toolCalls[0].status, 'completed');
  } finally { await rt.close(); }
});

for (const update of [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still working' } },
  { sessionUpdate: 'tool_call', toolCallId: 'new-work', title: 'execute', kind: 'execute', status: 'pending' },
  { sessionUpdate: 'tool_call_update', toolCallId: 'new-work', status: 'in_progress' },
  { sessionUpdate: 'plan', entries: [{ content: 'work', priority: 'high', status: 'in_progress' }] },
]) {
  test(`live ${update.sessionUpdate} clears canonical completion after reconnect, replay does not`, async () => {
    canonicalStatuses = vue.ref({ [`${saved.agentName}:${saved.sessionId}`]: { status: 'completed', at: 1 } });
    const rt = createSessionRuntime(deps);
    try {
      await rt.resume({ ...saved, lastTurnStatus: 'completed' });
      assert.equal(rt.turnCompleted.value, true, 'history replay must retain the confirmed result');
      emit(update);
      assert.equal(rt.turnCompleted.value, false, 'live work must invalidate canonical completion');
      assert.equal(canonicalStatuses.value[`${saved.agentName}:${saved.sessionId}`].status, 'working', 'working must survive reload');
    } finally { await rt.close(); }
  });
}


test('Queue waits for remote work after reconnect and releases only on fresh terminal evidence', async () => {
 const rt=createSessionRuntime(deps),sent=[];
 client.prompt=async request=>{sent.push(request);return {stopReason:'end_turn'};};
 try {
  await rt.resume({...saved});
  emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'remote agent still working'}});
  rt.submitMessage('after response',[],'queue');
  await vue.nextTick();
  assert.equal(sent.length,0,'Queue must not become a concurrent prompt/Steer after resume');
  emit({sessionUpdate:'tool_call',toolCallId:'remote-tool',title:'working',status:'completed'});
  await vue.nextTick();assert.equal(sent.length,0,'a finished tool does not finish the response');
  remoteEvidence.value={status:'completed',at:Date.now(),readVersion:1};
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(sent.length,1,'a confirmed response end releases the next turn once');
 }finally{await rt.close();}
});

test('accepted prompt surviving a socket drop leaves the queue after replay and never resends',async()=>{
 const rt=createSessionRuntime(deps);let rejectPrompt,calls=0;
 client.prompt=()=>{calls++;return new Promise((_,reject)=>rejectPrompt=reject);};
 try {
  await rt.resume({...saved});rt.submitMessage('delivered before socket loss');
  await vue.nextTick();client.onTransportClose('lost after delivery');rejectPrompt(new Error('transport closed'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(rt.pendingMessages.value.length,1);
  client.loadSession=async()=>{replay();emit({sessionUpdate:'user_message_chunk',content:{type:'text',text:'delivered before socket loss'}});emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'accepted reply'}});return {};};
  await rt.tryReconnect();
  assert.equal(rt.pendingMessages.value.length,0,'remote user turn confirms delivery despite the missing response');
  assert.equal(calls,1,'reconciliation never reissues the accepted prompt');
 }finally{await rt.close();}
});


test('a lifecycle read begun before remote work cannot release Queue when its stale result arrives later',async()=>{
 const rt=createSessionRuntime(deps),sent=[];
 client.prompt=async request=>{sent.push(request);return {stopReason:'end_turn'};};
 try{
  await rt.resume({...saved});
  emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'new remote work'}});
  rt.submitMessage('wait for new work');
  remoteEvidence.value={status:'completed',at:1,readVersion:0};
  await vue.nextTick();assert.equal(sent.length,0,'the older read is not completion of this work');
  remoteEvidence.value={status:'completed',at:Date.now(),readVersion:1};
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(sent.length,1);
 }finally{await rt.close();}
});

test('Pi startup banner leaves a new session idle and delivers its first queued message', async () => {
  client.newSession = async () => ({ sessionId: saved.sessionId });
  const prompts = [];
  client.prompt = async p => { prompts.push(p); return { stopReason: 'end_turn' }; };
  const rt = createSessionRuntime(deps);
  try {
    await rt.create('Pi', '/tmp');
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pi v0.85.1\n---\n\n## Skills\nStartup info' } });
    assert.equal(rt.turnStatus.value, null, 'startup info is not a model turn');
    assert.match(rt.messages.value.at(-1).content, /Startup info/);
    rt.submitMessage('first question');
    await vue.nextTick();
    assert.equal(prompts.length, 1, 'first Queue message must reach Pi without a nonexistent completion');
    assert.equal(rt.pendingMessages.value.length, 0);
    await vue.nextTick();
    assert.equal(rt.turnCompleted.value, true);
  } finally { await rt.close(); }
});

test('late Pi startup banner on a resumed empty session does not invent remote work', async () => {
  client.loadSession = async () => ({});
  let sent = 0;
  client.prompt = async () => { sent++; return { stopReason: 'end_turn' }; };
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pi startup info' } });
    assert.equal(rt.turnStatus.value, null);
    rt.submitMessage('first question');
    await vue.nextTick();
    assert.equal(sent, 1);
  } finally { await rt.close(); }
});

test('reopening a banner-only Pi session clears the false saved output status', async () => {
  client.loadSession = async () => {
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pi startup info' } });
    return {};
  };
  let sent = 0;
  client.prompt = async () => { sent++; return { stopReason: 'end_turn' }; };
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved, lastTurnStatus: 'output' });
    assert.equal(rt.turnStatus.value, null, 'banner-only replay must not retain the old synthetic output status');
    rt.submitMessage('first question');
    await vue.nextTick();
    assert.equal(sent, 1, 'reopened session must accept its first message');
  } finally { await rt.close(); }
});

test('banner-only replay preserves work independently confirmed by the provider', async () => {
  client.loadSession = async () => ({});
  canonicalStatuses = vue.ref({ 'Pi:history': { status: 'working', at: 1 } });
  remoteEvidence.value = { status: 'working', at: 1, readVersion: 1 };
  let sent = 0;
  client.prompt = async () => { sent++; return { stopReason: 'end_turn' }; };
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved, lastTurnStatus: 'working' });
    rt.submitMessage('wait for actual work');
    await vue.nextTick();
    assert.equal(sent, 0, 'provider-confirmed work must still hold Queue');
    assert.equal(rt.pendingMessages.value.length, 1);
    remoteEvidence.value = { status: 'completed', at: 2, readVersion: 2 };
    await vue.nextTick();
    assert.equal(sent, 1);
  } finally { await rt.close(); }
});

test('agent title updates rename the session, persist without messages and ignore empty/foreign titles', async () => {
  let persisted = 0;
  client.loadSession = async () => ({});
  const rt = createSessionRuntime({ ...deps, async persistSessions() { persisted++; } });
  try {
    await rt.resume({ ...saved, title: 'acp-ui' });
    const baseline = persisted;
    emit({ sessionUpdate: 'session_info_update', title: '  Agent-generated title  ' });
    assert.equal(rt.session.value.title, 'Agent-generated title');
    assert(persisted > baseline, 'metadata-only title updates must be persisted');
    emit({ sessionUpdate: 'session_info_update', title: null });
    emit({ sessionUpdate: 'session_info_update', title: '  ' });
    client.onSessionUpdate({sessionId:'another-session',update:{sessionUpdate:'session_info_update',title:'Foreign title'}});
    assert.equal(rt.session.value.title, 'Agent-generated title');
  } finally { await rt.close(); }
});

test('replay title updates use the descriptor before the session is attached', async () => {
  client.loadSession = async () => {
    emit({ sessionUpdate: 'session_info_update', title: 'Agent replay title' });
    return {};
  };
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved, title: 'acp-ui' });
    assert.equal(rt.session.value.title, 'Agent replay title');
    assert.deepEqual(entries.filter(e => e.kind === 'sync'), [], 'replay metadata is not live activity');
  } finally { await rt.close(); }
});

test('prompt completion refreshes titles in the session cwd and keeps the agent title', async () => {
  client.loadSession = async () => ({});
  client.prompt = async () => {
    emit({ sessionUpdate:'session_info_update', title:'Actual agent title' });
    emit({ sessionUpdate:'agent_message_chunk', content:{type:'text',text:'Answer'} });
    return {stopReason:'end_turn'};
  };
  const refreshed = [];
  const rt = createSessionRuntime({ ...deps, async refreshSessionMetadata(agent,cwd) { refreshed.push([agent,cwd]); } });
  try {
    await rt.resume({ ...saved, title:'acp-ui' });
    await rt.sendPrompt('Do not use this prompt as the title');
    assert.equal(rt.session.value.title,'Actual agent title');
    assert.deepEqual(refreshed, [['Pi','/work'], ['Pi','/work']]);
  } finally { await rt.close(); }
});

test('stale inventory Working cannot permanently queue a restored Devin session with unknown canonical status', async () => {
  canonicalStatuses = vue.ref({ 'Devin:history': { status: null, at: 2 } });
  let sent = 0;
  client.prompt = async () => { sent++; return { stopReason: 'end_turn' }; };
  const rt = createSessionRuntime(deps);
  try {
    await rt.resume({ ...saved, agentName: 'Devin', lastTurnStatus: 'working' });
    assert.equal(rt.turnStatus.value, null);
    rt.submitMessage('next turn', [], 'queue');
    await vue.nextTick();
    assert.equal(sent, 1, 'unknown canonical state supersedes an obsolete saved Working flag');
  } finally { await rt.close(); }
});

test('a message typed while history restores queues instead of failing, then drains on connect', async () => {
  const rt = createSessionRuntime(deps);
  let finishLoad, loadStarted;
  const loadStartedP = new Promise(r => { loadStarted = r; });
  client.loadSession = () => { loadStarted(); return new Promise(r => { finishLoad = r; }); };
  let sent = 0;
  client.prompt = async () => {
    sent++;
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    return { stopReason: 'end_turn' };
  };
  try {
    const restoring = rt.resume({ ...saved });
    await loadStartedP;
    assert.equal(rt.isRestoringHistory.value, true);
    rt.submitMessage('typed while restoring');
    assert.equal(rt.pendingMessages.value.length, 1, 'queued, not refused');
    assert.equal(sent, 0, 'nothing on the wire while load is in flight');
    finishLoad({});
    await restoring;
    for (let i = 0; i < 20 && !sent; i++) await new Promise(r => setTimeout(r, 0));
    assert.equal(sent, 1, 'the queue drains when session/load resolves');
    assert.equal(rt.messages.value.some(m => m.role === 'user' && m.content === 'typed while restoring'), true);
  } finally { await rt.close(); }
});

test('a transient session/load failure retries on the same connection instead of dropping the resume', async () => {
  const rt = createSessionRuntime(deps);
  let attempts = 0;
  client.loadSession = async () => {
    attempts++;
    if (attempts === 1) throw new Error('thread-store conflict: thread X already has an active writer');
    replay();
    return {};
  };
  try {
    await rt.resume({ ...saved });
    assert.equal(attempts, 2);
    assert.equal(rt.isConnected.value, true);
    assert.equal(rt.messages.value[0].content, 'old question');
  } finally { await rt.close(); }
});

test('a permanent load failure is not retried', async () => {
  const rt = createSessionRuntime(deps);
  let attempts = 0;
  client.loadSession = async () => { attempts++; throw new Error('session not found'); };
  try {
    await assert.rejects(rt.resume({ ...saved }));
    assert.equal(attempts, 1);
    assert.equal(rt.isConnected.value, false);
  } finally { await rt.close(); }
});

test('the outbox keeps a message submitted before its session scope restores', () => {
  const memory = new Map();
  const storage = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => { memory.set(k, v); },
    removeItem: (k) => { memory.delete(k); },
  };
  const ob = createPromptOutbox({
    busy: () => true, connected: () => false,
    send: async () => {}, steer: async () => 'injected', storage,
  });
  ob.submit('typed before restore');
  ob.restore('history');
  assert.equal(ob.messages.value.length, 1);
  assert.equal(ob.messages.value[0].text, 'typed before restore');
  assert.equal(memory.has('acp-ui:outbox:history'), true, 'carried item persisted under the new scope');
});

test('a primed tab paints the cached tail before its connection starts', async () => {
  cached = { userTurnBase: 0, messages: [{ id: 'cached-user', role: 'user', content: 'old question', timestamp: 1 }] };
  const rt = createSessionRuntime(deps);
  let loadStarted, finishLoad;
  const loadStartedP = new Promise(r => { loadStarted = r; });
  client.loadSession = () => { loadStarted(); return new Promise(r => { finishLoad = r; }); };
  try {
    rt.primeHistoryCache({ ...saved });
    assert.equal(rt.isRestoringHistory.value, true, 'primed tab shows restoring state');
    assert.equal(rt.messages.value[0]?.content, 'old question', 'cached tail painted before connect');
    const restoring = rt.resume({ ...saved });
    await loadStartedP;
    replay();
    finishLoad({});
    await restoring;
    assert.equal(rt.isConnected.value, true);
  } finally { await rt.close(); }
});

test('a cached replay cursor is sent as acpUIResume and an honored suffix appends', async () => {
  cached = {
    userTurnBase: 0, replaySeq: 4, replayHash: 'chain@4',
    messages: [{ id: 'cached-user', role: 'user', content: 'old question', timestamp: 1 }],
  };
  const rt = createSessionRuntime(deps);
  let sentParams;
  client.loadSession = async (p) => {
    sentParams = p;
    // The bridge withheld frames 1..4 — only the two new frames arrive.
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } },
      { acpUI: { seq: 5, hh: 'chain@5' } });
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'new question' } },
      { acpUI: { seq: 6, hh: 'chain@6' } });
    return { _meta: { acpUI: { frames: 6, skipped: 4, resynced: false } } };
  };
  try {
    await rt.resume({ ...saved });
    assert.deepEqual(sentParams.acpUIResume, { seq: 4, hh: 'chain@4' }, 'resume token rides session/load');
    assert.deepEqual(rt.messages.value.map(m => m.content), ['old question', 'old answer', 'new question'],
      'verified suffix appends to the cached tail');
    const lastWrite = cacheWrites.at(-1)?.[3];
    assert.deepEqual(lastWrite, { seq: 6, hh: 'chain@6' }, 'last replay tag persisted for the next load');
  } finally { await rt.close(); }
});

test('a resumed load that overlaps cached live turns dedups the seam', async () => {
  // Cache written after a live turn: tail already holds the post-replay
  // messages, while the stored cursor still marks the old replay boundary.
  cached = {
    userTurnBase: 0, replaySeq: 4, replayHash: 'chain@4',
    messages: [
      { id: 'cached-user', role: 'user', content: 'old question', timestamp: 1 },
      { id: 'cached-live-q', role: 'user', content: 'live question', timestamp: 2 },
      { id: 'cached-live-a', role: 'assistant', content: 'live answer', timestamp: 3 },
    ],
  };
  const rt = createSessionRuntime(deps);
  client.loadSession = async () => {
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'live question' } },
      { acpUI: { seq: 5, hh: 'chain@5' } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live answer' } },
      { acpUI: { seq: 6, hh: 'chain@6' } });
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'next question' } },
      { acpUI: { seq: 7, hh: 'chain@7' } });
    return { _meta: { acpUI: { frames: 7, skipped: 4, resynced: false } } };
  };
  try {
    await rt.resume({ ...saved });
    assert.deepEqual(rt.messages.value.map(m => m.content),
      ['old question', 'live question', 'live answer', 'next question'],
      'seam overlap deduplicated — no doubled live turn');
  } finally { await rt.close(); }
});

test('a resync-flagged replay replaces the transcript wholesale', async () => {
  cached = {
    userTurnBase: 0, replaySeq: 9, replayHash: 'stale-chain',
    messages: [{ id: 'cached-user', role: 'user', content: 'wrong history', timestamp: 1 }],
  };
  const rt = createSessionRuntime(deps);
  client.loadSession = async () => {
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'real question' } },
      { acpUI: { seq: 1, hh: 'fresh@1', resync: true } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'real answer' } },
      { acpUI: { seq: 2, hh: 'fresh@2' } });
    return { _meta: { acpUI: { frames: 2, skipped: 0, resynced: true } } };
  };
  try {
    await rt.resume({ ...saved });
    assert.deepEqual(rt.messages.value.map(m => m.content), ['real question', 'real answer'],
      'diverged cache replaced, not appended');
    assert.equal(rt.messages.value.some(m => m.content === 'wrong history'), false);
  } finally { await rt.close(); }
});

test('an untagged replay (old bridge) still takes the whole-transcript path', async () => {
  cached = {
    userTurnBase: 0, replaySeq: 4, replayHash: 'chain@4',
    messages: [{ id: 'cached-user', role: 'user', content: 'old question', timestamp: 1 }],
  };
  const rt = createSessionRuntime(deps);
  client.loadSession = async () => {
    replay();
    return {}; // old bridge: no _meta.acpUI on the result
  };
  try {
    await rt.resume({ ...saved });
    assert.equal(rt.messages.value.some(m => m.content === 'old question'), true);
    assert.equal(rt.messages.value.some(m => m.content === 'old answer'), true);
  } finally { await rt.close(); }
});
