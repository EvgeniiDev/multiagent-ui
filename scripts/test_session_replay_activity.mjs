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
function emit(update) { client.onSessionUpdate({ sessionId: saved.sessionId, update }); }
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
  canonicalStatuses = null;
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
