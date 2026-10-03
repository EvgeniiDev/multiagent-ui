// scripts/test_preparation_ui.mjs — P5 frontend surface for idea
// preparation: API client routes, ui-model gates/payloads, and the
// execution store's preparation poll/bindings integration.
//   node --test scripts/test_preparation_ui.mjs
//
// In-process only — real browser proof lives in scripts/e2e_preparation.py.
// Every assertion is over wire paths, payloads, or store state — never
// source text.

import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./test_sfc_loader.mjs', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ---- fetch/router plumbing (same contract as test_execution_ui.mjs) -----------

function wireFetch(fn) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return fn(url, init); };
  f.calls = calls;
  return f;
}
function fakeRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  };
}

// A fake WebSocket/transport-free ExecClient surface for store tests.
class FakeExec {
  constructor() {
    this.calls = [];
    this.handlers = {};
  }
  on(method, handler) { this.handlers[method] = handler; }
  _call(method, args) {
    this.calls.push({ method, args });
    const h = this.handlers[method];
    if (!h) return Promise.reject(new Error(`no handler for ${method}`));
    return Promise.resolve().then(() => h(...args));
  }
  getCard(id) { return this._call('getCard', [id]); }
  getRun(id) { return this._call('getRun', [id]); }
  getRunEvents(id, c, l) { return this._call('getRunEvents', [id, c, l]); }
  getDocument(id, v) { return this._call('getDocument', [id, v]); }
  getArtifact(r, a) { return this._call('getArtifact', [r, a]); }
  listCards() { return this._call('listCards', []); }
  listPresets() {
    return this.handlers.listPresets
      ? this._call('listPresets', [])
      : Promise.resolve({ presets: [], rev: 0, compatibility: null, compatError: null });
  }
  sendCommand(id, env) { return this._call('sendCommand', [id, env]); }
  createPreset(p) { return this._call('createPreset', [p]); }
  updatePreset(id, p, rev) { return this._call('updatePreset', [id, p, rev]); }
  deletePreset(id) { return this._call('deletePreset', [id]); }
  getPreparation(id) { return this._call('getPreparation', [id]); }
  getPreparationBindings() { return this._call('getPreparationBindings', []); }
}

// The board store reads /api/state/* through global fetch — install a
// fail-closed router with an empty board doc so stray reads stay
// deterministic (same contract as test_execution_ui.mjs).
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith('/health')) return fakeRes(200, { ok: true });
  const m = /\/api\/state\/([^/?]+)/.exec(u);
  if (m && decodeURIComponent(m[1]) === 'board.json') {
    if (init.method === 'PUT') return fakeRes(200, { name: 'board.json', rev: 2 });
    return fakeRes(200, { name: 'board.json', rev: 1, updatedAt: 1, data: { version: 2, cards: [] } });
  }
  throw new Error(`fail-closed fetch: unrouted ${init.method ?? 'GET'} ${u}`);
};

const { ExecClient, ExecApiError } = await import('../src/lib/execution/api.ts');
const ui = await import('../src/lib/execution/ui-model.ts');
const { setActivePinia, createPinia } = await import('pinia');
const { useExecutionStore, setExecutionClient } = await import('../src/stores/execution.ts');

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

function cardView(over = {}) {
  return {
    cardId: 'card_1',
    managed: true,
    schemaVersion: 3,
    enabledAt: now() - 50_000,
    controlRevision: 7,
    internalRevision: 3,
    project: { id: 'p1', label: 'demo', path: '/srv/demo' },
    session: null,
    currentRunId: null,
    workspaceId: 'ws1',
    composition: {
      preset: {
        id: 'pr1', name: 'solo',
        members: { implementer: { cli: 'pi', model: 'm1' } },
        limits: { maxAttemptsPerRole: 1, timeoutMin: 60, maxReviewRounds: 3 },
      },
      at: now() - 40_000,
    },
    pendingWrites: null,
    documents: {
      requirements: { current: 'dv_req1', versions: [{ versionId: 'dv_req1', sha256: SHA }] },
      plan: { current: 'dv_plan1', versions: [{ versionId: 'dv_plan1', sha256: SHA2 }] },
      design: { current: null, versions: [] },
    },
    approvals: {
      requirements: { versionId: 'dv_req1', sha256: SHA, at: now() - 9000, by: 'user' },
      plan: {
        versionId: 'dv_plan1', sha256: SHA2,
        requirementsVersionId: 'dv_req1', requirementsSha256: SHA,
        checks: [{ run: 'npm test', cwd: 'app', timeoutSec: 60, setup: true }],
        at: now() - 8000, by: 'user',
      },
      design: null,
    },
    runs: [],
    workspaces: {
      ws1: { id: 'ws1', status: 'ready', runId: null, path: '/srv/demo/.worktrees/ws1', branch: 'b', owner: null },
    },
    commandsProcessed: 4,
    projection: { stage: 'in_progress', status: 'implementing' },
    features: { start: true, validation: true, fusion: false, preparation: true },
    ...over,
  };
}

function prepView(over = {}) {
  return {
    sessionId: 'prep-1', schemaVersion: 1, status: 'active', phase: 'clarify',
    ready: false,
    blockers: [{ code: 'open_questions', detail: '1 blocking question open' }],
    createdAt: now() - 60000, updatedAt: now() - 1000,
    stoppedAt: null, stopReason: null, blocker: null,
    discussion: 'prep-card_1', projectPath: '/srv/demo',
    intent: { raw: 'build the thing', current: null, proposal: null, restatements: 1 },
    bindings: {},
    presented: { requirements: null, design: null, plan: null },
    gates: [],
    attempts: [{
      attemptId: 'pa-1', kind: 'interview', status: 'awaiting_answer',
      docKind: null, input: null, progress: null, createdAt: now() - 5000,
    }],
    checkpoint: {
      revision: 2, updatedAt: now() - 1000,
      decisions: [], assumptions: [],
      openQuestions: [{
        questionId: 'q-1', text: 'Which store?', blocking: true, status: 'open',
        channel: 'dialog', dialog: { method: 'select', options: ['redis', 'pg'] },
        attemptId: 'pa-1', createdAt: now() - 4000,
      }],
      log: [],
    },
    completeness: {},
    handoffTargets: [
      { mode: 'solo', implemented: true },
      { mode: 'fusion', implemented: true },
      { mode: 'orchestrator', implemented: false },
      { mode: 'swarm', implemented: false },
    ],
    handoffs: [],
    package: null,
    ...over,
  };
}

// ============================================================================
// API client routes
// ============================================================================

describe('ExecClient — preparation routes', () => {
  test('getPreparation hits the card preparation route', async () => {
    const fetchFn = wireFetch(() => fakeRes(200, { cardId: 'card_1', preparation: prepView() }));
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn });
    const r = await c.getPreparation('card_1');
    assert.equal(fetchFn.calls[0].url, 'http://t/api/execution/cards/card_1/preparation');
    assert.equal(r.preparation.sessionId, 'prep-1');
  });

  test('getPreparationBindings hits the registry listing', async () => {
    const fetchFn = wireFetch(() => fakeRes(200, {
      pi: { binary: 'pi', version: '0.85.1' },
      bindings: [{ bindingId: 'b1', stage: 'intent', status: 'available' }],
    }));
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn });
    const r = await c.getPreparationBindings();
    assert.equal(fetchFn.calls[0].url, 'http://t/api/execution/preparation/bindings');
    assert.equal(r.bindings[0].bindingId, 'b1');
  });

  test('404/501 propagate as ExecApiError with status — the store maps them', async () => {
    const fetchFn = wireFetch(() => fakeRes(404, { error: 'card is not managed', code: 'card_not_found' }));
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn });
    await assert.rejects(() => c.getPreparation('card_1'), (e) => {
      assert.ok(e instanceof ExecApiError);
      assert.equal(e.status, 404);
      assert.equal(e.code, 'card_not_found');
      return true;
    });
  });
});

// ============================================================================
// ui-model — gates
// ============================================================================

describe('ui-model — preparation gates', () => {
  test('canStartPrep: feature off → refuse; existing session → refuse', () => {
    const off = cardView({ features: { start: true, preparation: false } });
    assert.equal(ui.canStartPrep(off).ok, false);
    assert.match(ui.canStartPrep(off).reason, /not enabled/);

    const existing = cardView({ preparation: { sessionId: 's1', status: 'active', ready: false } });
    const g = ui.canStartPrep(existing);
    assert.equal(g.ok, false);
    assert.match(g.reason, /already active/);

    const stopped = cardView({ preparation: { sessionId: 's1', status: 'stopped', ready: false } });
    assert.equal(ui.canStartPrep(stopped).ok, true,
      'a stopped session must allow starting a new one');

    const clean = cardView({ preparation: null });
    assert.equal(ui.canStartPrep(clean).ok, true);
  });

  test('canStart (implementation) refuses while an active session is not ready', () => {
    const v = cardView({
      preparation: {
        sessionId: 's1', status: 'active', ready: false, blockerCount: 3,
        gates: { pending: 1, confirmed: 0, invalidated: 0 },
        openQuestions: { open: 1, blocking: 1 },
        attempts: { running: 0, awaitingAnswer: 1 }, handoffs: 0, updatedAt: now(),
      },
    });
    const g = ui.canStart(v);
    assert.equal(g.ok, false);
    assert.match(g.reason, /preparation is not ready/);

    const ready = cardView({
      preparation: {
        sessionId: 's1', status: 'active', ready: true, blockerCount: 0,
        gates: { pending: 0, confirmed: 2, invalidated: 0 },
        openQuestions: { open: 0, blocking: 0 },
        attempts: { running: 0, awaitingAnswer: 0 }, handoffs: 0, updatedAt: now(),
      },
    });
    assert.equal(ui.canStart(ready).ok, true);

    // A stopped session never blocks start — the durable record is preserved,
    // the card returns to the plain managed lifecycle.
    const stopped = cardView({
      preparation: {
        sessionId: 's1', status: 'stopped', ready: false, blockerCount: 2,
        gates: { pending: 0, confirmed: 0, invalidated: 1 },
        openQuestions: { open: 0, blocking: 0 },
        attempts: { running: 0, awaitingAnswer: 0 }, handoffs: 0, updatedAt: now(),
      },
    });
    assert.equal(ui.canStart(stopped).ok, true);
  });

  test('canTalkPrep / canStopPrep follow the session status', () => {
    const none = cardView({ preparation: null });
    assert.equal(ui.canTalkPrep(none).ok, false);
    assert.equal(ui.canStopPrep(none).ok, false);

    const active = cardView({ preparation: { sessionId: 's', status: 'active' } });
    assert.equal(ui.canTalkPrep(active).ok, true);
    assert.equal(ui.canStopPrep(active).ok, true);

    const stopped = cardView({ preparation: { sessionId: 's', status: 'stopped' } });
    assert.equal(ui.canTalkPrep(stopped).ok, false);
    assert.match(ui.canTalkPrep(stopped).reason, /stopped/);
  });

  test('canPrepHandoff requires ready; canConfirmGate refuses terminal gates', () => {
    const notReady = cardView({
      preparation: { sessionId: 's', status: 'active', ready: false, blockerCount: 2 },
    });
    const g = ui.canPrepHandoff(notReady);
    assert.equal(g.ok, false);
    assert.match(g.reason, /2 blocker/);

    const ready = cardView({
      preparation: { sessionId: 's', status: 'active', ready: true, blockerCount: 0 },
    });
    assert.equal(ui.canPrepHandoff(ready).ok, true);

    const pending = { gateId: 'g1', type: 'intent_confirm', status: 'pending' };
    assert.equal(ui.canConfirmGate(ready, pending).ok, true);
    const inv = { gateId: 'g2', type: 'intent_confirm', status: 'invalidated', invalidationReason: 'intent_changed' };
    const gi = ui.canConfirmGate(ready, inv);
    assert.equal(gi.ok, false);
    assert.match(gi.reason, /intent_changed/);
  });

  test('payloads match the server contract field names', () => {
    assert.deepEqual(ui.prepAnswerPayload('q-9', 'redis'), { questionId: 'q-9', answer: 'redis' });
    assert.deepEqual(ui.prepDraftPayload('requirements'), { kind: 'requirements' });
    assert.deepEqual(ui.prepDraftPayload('plan', ' go '), { kind: 'plan', note: 'go' });
    assert.deepEqual(ui.prepContinuePayload('  more context  '), { text: 'more context' });
    assert.deepEqual(ui.prepContinuePayload('   '), {});
    assert.deepEqual(ui.prepBindPayload('intent', 'b-1'), { stage: 'intent', bindingId: 'b-1' });
    assert.deepEqual(ui.prepBindPayload('plan', null), { stage: 'plan', bindingId: null });
    assert.deepEqual(ui.prepGatePayload('g-3'), { gateId: 'g-3' });
    assert.deepEqual(ui.prepHandoffPayload('fusion'), { mode: 'fusion' });
    assert.deepEqual(ui.prepStartPayload('idea', { intent: 'b-1' }),
      { intent: 'idea', bindings: { intent: 'b-1' } });
    assert.deepEqual(ui.prepStartPayload('idea'), { intent: 'idea' });
  });

  test('prepBindingsForStage sorts available first and keeps refused rows visible', () => {
    const rows = [
      { bindingId: 'z-unsupported', stage: 'intent', status: 'unsupported', unsupported: { reason: 'r' } },
      { bindingId: 'a-ok', stage: 'intent', status: 'available' },
      { bindingId: 'm-candidate', stage: 'intent', status: 'candidate' },
      { bindingId: 'other-stage', stage: 'plan', status: 'available' },
    ];
    const out = ui.prepBindingsForStage(rows, 'intent');
    assert.deepEqual(out.map((b) => b.bindingId), ['a-ok', 'm-candidate', 'z-unsupported']);
    assert.equal(out.length, 3, 'non-available rows stay listed — the UI shows their reason');
  });
});

// ============================================================================
// store — preparation poll + bindings + command CAS
// ============================================================================

let activeExec = null;
function freshPinia() {
  setActivePinia(createPinia());
  const exec = useExecutionStore();
  activeExec = exec;
  const client = new FakeExec();
  setExecutionClient(client);
  return { exec, client };
}
function releaseExec() {
  const exec = activeExec;
  if (!exec) return;
  try {
    exec.clearFocus?.();
    for (const id of Object.keys(exec.cards)) {
      const st = exec.cards[id];
      while (st && st.watchers > 0) exec.unwatchCard(id);
    }
    exec.stopPolling?.();
  } catch { /* best effort */ }
}

describe('execution store — preparation', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => releaseExec());

  test('features.preparation → the card poll also fetches the session view', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView());
    client.on('getPreparation', (id) => ({ cardId: id, preparation: prepView() }));
    exec.watchCard('card_1');
    await sleep(0);
    const st = exec.stateFor('card_1');
    assert.equal(st.preparation.sessionId, 'prep-1');
    assert.equal(st.preparation.checkpoint.openQuestions[0].questionId, 'q-1');
    assert.equal(st.prepError, null);
    exec.unwatchCard('card_1');
  });

  test('a card without a session maps 404 → preparation null, no error', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView());
    client.on('getPreparation', () => {
      throw new ExecApiError(404, { error: 'card is not managed', code: 'card_not_found' });
    });
    exec.watchCard('card_1');
    await sleep(0);
    const st = exec.stateFor('card_1');
    assert.equal(st.preparation, null);
    assert.equal(st.prepError, null);
    exec.unwatchCard('card_1');
  });

  test('feature off → getPreparation is never called', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView({ features: { start: true, preparation: false } }));
    let prepCalls = 0;
    client.on('getPreparation', () => { prepCalls++; return { preparation: null }; });
    exec.watchCard('card_1');
    await sleep(0);
    assert.equal(prepCalls, 0);
    assert.equal(exec.stateFor('card_1').preparation, null);
    exec.unwatchCard('card_1');
  });

  test('a failed prep fetch keeps the last view and marks it stale', async () => {
    const { exec, client } = freshPinia();
    let okPrep = true;
    client.on('getCard', () => cardView());
    client.on('getPreparation', () => {
      if (okPrep) return { preparation: prepView() };
      throw new ExecApiError(0, null, 'connection refused');
    });
    exec.watchCard('card_1');
    await sleep(0);
    assert.equal(exec.stateFor('card_1').preparation?.sessionId, 'prep-1');
    okPrep = false;
    await exec.refreshCard('card_1');
    const st = exec.stateFor('card_1');
    assert.equal(st.preparation?.sessionId, 'prep-1', 'last known view kept');
    assert.match(st.prepError, /connection refused/, 'stale marker recorded');
    exec.unwatchCard('card_1');
  });

  test('loadPrepBindings populates the registry; error surfaces on prepBindingsError', async () => {
    const { exec, client } = freshPinia();
    client.on('getPreparationBindings', () => ({
      pi: { binary: 'pi', version: '0.85.1' },
      bindings: [{ bindingId: 'b1', stage: 'intent', status: 'available' }],
    }));
    await exec.loadPrepBindings();
    assert.equal(exec.prepBindings.length, 1);
    assert.equal(exec.prepPi.version, '0.85.1');
    assert.equal(exec.prepBindingsError, null);

    client.on('getPreparationBindings', () => {
      throw new ExecApiError(503, { error: 'registry unreadable', code: 'registry_unreadable' });
    });
    await exec.loadPrepBindings(true);
    assert.match(exec.prepBindingsError, /registry unreadable/);
    assert.equal(exec.prepBindings.length, 1, 'the last good listing is kept');
  });

  test('start_preparation POSTs the CAS envelope; 409 surfaces as commandError', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView());
    const posted = [];
    client.on('sendCommand', (id, env) => {
      posted.push(env);
      throw new ExecApiError(409, { error: 'control revision mismatch', code: 'revision_conflict' });
    });
    exec.watchCard('card_1');
    await sleep(0);
    const r = await exec.sendCommand('card_1', 'start_preparation', { intent: 'build it' });
    assert.equal(r.ok, false);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'start_preparation');
    assert.equal(posted[0].expectedControlRevision, 7, 'CAS revision from the fresh read');
    assert.deepEqual(posted[0].payload, { intent: 'build it' });
    assert.equal(exec.stateFor('card_1').commandError.code, 'revision_conflict');
    exec.unwatchCard('card_1');
  });

  test('offline → preparation commands refuse without a POST', async () => {
    const { exec, client } = freshPinia();
    let reads = 0;
    client.on('getCard', () => {
      reads++;
      if (reads === 1) return cardView();
      throw new ExecApiError(0, null, 'unreachable');
    });
    let posts = 0;
    client.on('sendCommand', () => { posts++; return { ok: true }; });
    exec.watchCard('card_1');
    await sleep(0);
    const r = await exec.sendCommand('card_1', 'answer_question', { questionId: 'q-1', answer: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'offline');
    assert.equal(posts, 0, 'no optimistic write while offline');
    exec.unwatchCard('card_1');
  });
});
