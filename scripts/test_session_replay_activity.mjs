// Run the actual session runtime with deterministic ACP and cache boundaries.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import ts from 'typescript';

let client, entries, cached, cacheWrites;
let seq = 0;
globalThis.__replayRuntimeDeps = {
  ref: vue.ref, computed: vue.computed, watch: vue.watch,
  uuid: () => `test-${++seq}`,
  getAppVersion: async () => 'test',
  trackEvent() {}, trackError() {},
  getTransportKind: () => 'websocket',
  isDesktop: () => false,
  useConfigStore: () => ({ getAgent: () => ({ transport: 'websocket' }) }),
  useActivityStore: () => ({ recordEntry: entry => entries.push(entry), recordUsage() {} }),
  createAcpClient: async () => client,
  AcpClientBridge: class {},
  readHistoryCache: () => cached,
  writeHistoryCache: (...args) => cacheWrites.push(args),
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
const deps = { async requestAuth() { return 'token'; }, async persistSessions() {}, notifyActivity() {} };
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
  entries = []; cached = null; cacheWrites = [];
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
