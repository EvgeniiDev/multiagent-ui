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
    assert.deepEqual(ui.prepStartPayload(undefined), {});
    assert.deepEqual(ui.prepStartPayload(undefined, { intent: 'grill-me-intent' }), { bindings: { intent: 'grill-me-intent' } });
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

// ============================================================================
// ui-model — downstream mode selection + completeness (first UI slice)
//
// Conservative gating: orchestrator/swarm handoff offers are durable data,
// but no start path exists for them server-side (execution-domain accepts
// only solo|fusion). The UI must refuse a start in those modes without a
// POST — never a frontend-only illusion of execution. Completeness comes
// from the server's per-kind state strings, not from client derivation.
// ============================================================================

describe('ui-model — downstream modes + completeness', () => {
  test('canStartInMode: solo/fusion pass, orchestrator/swarm refuse, unknown refused', () => {
    assert.equal(ui.canStartInMode('solo').ok, true);
    assert.equal(ui.canStartInMode('fusion').ok, true);
    const o = ui.canStartInMode('orchestrator');
    assert.equal(o.ok, false);
    assert.match(o.reason, /no run backend exists/);
    const s = ui.canStartInMode('swarm');
    assert.equal(s.ok, false);
    assert.match(s.reason, /no run backend exists/);
    const u = ui.canStartInMode('fleet');
    assert.equal(u.ok, false);
    assert.match(u.reason, /unknown downstream mode/);
  });

  test('prepCompletenessState reads the server state string verbatim', () => {
    const v = prepView({
      completeness: { requirements: 'approved', design: 'absent', plan: 'draft' },
    });
    assert.equal(ui.prepCompletenessState(v, 'requirements'), 'approved');
    assert.equal(ui.prepCompletenessState(v, 'design'), 'absent');
    assert.equal(ui.prepCompletenessState(v, 'plan'), 'draft');
    assert.equal(ui.prepCompletenessState(prepView({ completeness: {} }), 'plan'), null);
    assert.equal(ui.prepCompletenessState(null, 'plan'), null);
    // A counts-shaped entry is not a kind state — fall back to null, never
    // coerce it into a label.
    const odd = prepView({ completeness: { plan: { open: 2 } } });
    assert.equal(ui.prepCompletenessState(odd, 'plan'), null);
  });

  test('prepOpenQuestionCounts prefers the server counters, falls back to questions', () => {
    const v = prepView({
      completeness: { openQuestions: { open: 3, blocking: 2, answered: 5, deferred: 1 } },
    });
    assert.deepEqual(ui.prepOpenQuestionCounts(v), { open: 3, blocking: 2, answered: 5, deferred: 1 });
    const fallback = prepView({ completeness: {} });
    const c = ui.prepOpenQuestionCounts(fallback);
    assert.equal(c.open, 1, 'one open fixture question');
    assert.equal(c.blocking, 1);
    assert.equal(c.answered, 0);
  });

  test('sibling-run start stays refused while another run is live (no solo bypass)', () => {
    const v = cardView({
      runs: [{ id: 'run_live', status: 'active', reserved: true }],
    });
    assert.equal(ui.canStart(v).ok, false);
    assert.match(ui.canStart(v).reason, /still live/);
  });
});

// ============================================================================
// ui-model — server-flagged modes unlock start; handoff offers stay durable
//
// Backend-ui-contract §10: modes stay disabled until the server reports
// them available. canStartInMode(mode) without a view keeps the old
// conservative behavior (orchestrator/swarm refuse); with a card view
// whose `features` advertise the mode, start passes through to the run
// gates. The PreparationPanel renders the startable set verbatim.
// ============================================================================

describe('ui-model — flagged modes unlock start', () => {
  test('canStartInMode with a flagged view admits orchestrator/swarm', () => {
    // No view: conservative — refuse without a POST.
    assert.equal(ui.canStartInMode('orchestrator').ok, false);
    assert.equal(ui.canStartInMode('swarm').ok, false);
    // Flagged view: admitted (run gates still apply at send time).
    const flagged = cardView({ features: { orchestrator: true, swarm: true } });
    assert.equal(ui.canStartInMode('orchestrator', flagged).ok, true);
    assert.equal(ui.canStartInMode('swarm', flagged).ok, true);
    // Unflagged view: still refused.
    const plain = cardView({ features: {} });
    assert.equal(ui.canStartInMode('orchestrator', plain).ok, false);
    assert.match(ui.canStartInMode('orchestrator', plain).reason, /no run backend/);
    // Unknown modes never admit, with or without a view.
    assert.equal(ui.canStartInMode('fleet', flagged).ok, false);
    assert.match(ui.canStartInMode('fleet', flagged).reason, /unknown downstream mode/);
  });

  test('startableModes mirrors the server features flags', () => {
    assert.deepEqual(ui.startableModes(cardView({ features: {} })), ['solo', 'fusion']);
    assert.deepEqual(
      ui.startableModes(cardView({ features: { orchestrator: true } })),
      ['solo', 'fusion', 'orchestrator'],
    );
    assert.deepEqual(
      ui.startableModes(cardView({ features: { orchestrator: true, swarm: true } })),
      ['solo', 'fusion', 'orchestrator', 'swarm'],
    );
  });
});

// ============================================================================
// PreparationPanel SSR — card draft filling, gate confirm, handoff offer
//
// The brainstorm/grill flow is: start form → live discussion (questions,
// answers, decisions) → presented card drafts per kind → explicit gate
// confirms → handoff offer recording. These render the panel against a
// managed card with a live session and assert each surface exists with
// the exact testids the live e2e suite drives.
// ============================================================================

describe('PreparationPanel SSR — discussion, drafts, gates, handoff', () => {
  beforeEach(async () => {
    const storageMod = await import('../src/lib/host/storage.ts');
    await storageMod.__resetWebKvForTests();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    setActivePinia(createPinia());
  });
  afterEach(() => releaseExec());

  async function renderPrepPanel(cardId, viewOver, prepOver) {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const { useBoardStore } = await import('../src/stores/board.ts');
    const Panel = (await import('../src/features/board/PreparationPanel.vue')).default;
    const exec = useExecutionStore();
    const client = new FakeExec();
    setExecutionClient(client);
    const board = useBoardStore();
    board.cards = [{
      id: cardId, title: 'idea card', description: '', project: 'demo', agent: '',
      priority: 'medium', acceptance: '', verification: '', links: [], session: null,
      stage: 'backlog', status: null, statusByStage: {}, blocked: false,
      blockedReason: '', cancelled: false, touches: [], dependsOn: [],
      blocks: [], conflictsWith: [], order: 1, createdAt: 1, updatedAt: 1,
      execution: { managed: true, internalRevision: 1, controlRevision: 2 },
    }];
    const st = exec.stateFor(cardId);
    st.phase = 'ready';
    st.view = cardView({ cardId, ...viewOver });
    st.preparation = prepOver === null ? null : prepView({ ...prepOver });
    const html = await renderToString(createSSRApp(Panel, { cardId }));
    return html;
  }

  test('existing card starts question discussion without a second idea input', async () => {
    const html = await renderPrepPanel('pc-start', { preparation: null }, null);
    assert.ok(!html.includes('data-testid="prep-intent"'));
    assert.ok(html.includes('data-testid="prep-card-source"'));
    assert.ok(html.includes('Start brainstorming'));
    const button = html.match(/<button[^>]*data-testid="prep-start"[^>]*>/)?.[0];
    assert.ok(button && !button.includes(' disabled'));
    assert.ok(!html.includes('describe the idea first'));
  });

  test('running kickoff shows explicit waiting status instead of a blank discussion', async () => {
    const html = await renderPrepPanel('pc-wait', {}, {
      attempts: [{ attemptId: 'pa-start', kind: 'kickoff', status: 'running', progress: null }],
      checkpoint: { decisions: [], assumptions: [], openQuestions: [] },
    });
    assert.ok(html.includes('data-testid="prep-lead-waiting"'));
    assert.ok(html.includes('The lead is reading your card and preparing the first question'));
    assert.ok(html.includes('aria-busy="true"'));
    assert.ok(!html.includes('no questions yet'));
  });

  test('a pending question has a visible jump back to the discussion', async () => {
    const html = await renderPrepPanel('pc-jump', {}, {});
    assert.ok(html.includes('data-testid="prep-discussion-jump"'));
    assert.ok(html.includes('Answer the lead'));
  });

  test('live discussion renders questions, answers, decisions, gates', async () => {
    const html = await renderPrepPanel('pc1', {}, {
      gates: [
        { gateId: 'g1', type: 'intent_confirm', status: 'pending' },
        { gateId: 'g2', type: 'artifact_confirm', subject: { docKind: 'requirements' }, status: 'confirmed', confirmedAt: now() },
      ],
      checkpoint: {
        revision: 3, updatedAt: now(),
        decisions: [{ text: 'use postgres' }],
        assumptions: [{ text: 'single tenant' }],
        openQuestions: [{
          questionId: 'q-1', text: 'Which store?', blocking: true, status: 'open',
          channel: 'dialog', dialog: { method: 'select', options: ['redis', 'pg'] },
          attemptId: 'pa-1', createdAt: now() - 4000,
        }],
        log: [],
      },
      completeness: { requirements: 'presented', design: 'absent', plan: 'draft' },
      presented: { requirements: { versionId: 'dv_req1', draft: true }, design: null, plan: null },
    });
    assert.ok(html.includes('prep-discussion'), 'discussion surface renders');
    assert.ok(html.includes('prep-q-q-1'), 'open question row renders with its id');
    assert.ok(html.includes('Which store?'), 'question text renders verbatim');
    assert.ok(html.includes('prep-answer-select-q-1'), 'dialog options render as a select');
    assert.ok(html.includes('use postgres'), 'recorded decisions render');
    assert.ok(html.includes('single tenant'), 'recorded assumptions render');
    assert.ok(html.includes('prep-gate-g1'), 'pending gate renders');
    assert.ok(html.includes('prep-gate-confirm-g1'), 'pending gate carries a confirm control');
    assert.ok(html.includes('prep-doc-requirements'), 'per-kind card draft row renders');
    assert.ok(html.includes('prep-draft-requirements'), 'draft control renders');
    assert.ok(html.includes('prep-completeness'), 'server-derived completeness renders');
    assert.ok(html.includes('requirements: presented'), 'kind state renders verbatim');
  });

  test('accepted plan + confirmed gates drive the handoff offer surface', async () => {
    const html = await renderPrepPanel('pc2', {}, {
      ready: true, blockers: [],
      gates: [{ gateId: 'g1', type: 'intent_confirm', status: 'confirmed', confirmedAt: now() }],
      completeness: { requirements: 'approved', design: 'absent', plan: 'approved' },
      presented: {
        requirements: { versionId: 'dv_req1' },
        design: null,
        plan: { versionId: 'dv_plan1' },
      },
      handoffs: [{ handoffId: 'h1', mode: 'solo', implemented: true, at: now() - 1000, stale: false }],
    });
    assert.ok(html.includes('prep-ready'), 'readiness renders when blockers clear');
    assert.ok(html.includes('prep-handoff-mode'), 'handoff mode picker renders');
    assert.ok(html.includes('prep-handoff-btn'), 'handoff offer control renders');
    assert.ok(html.includes('prep-handoff-h1'), 'recorded handoff offer renders');
    assert.ok(html.includes('prep-modes-available'), 'startable-mode line renders');
    assert.ok(html.includes('solo, fusion'), 'solo+fusion startable on this deployment');
  });

  test('draft generation replaces the create action and distinguishes waiting from working', async () => {
    const gates = [{ gateId: 'gi', type: 'intent_confirm', status: 'confirmed' }];
    const creating = await renderPrepPanel('pc-draft-active', {}, {
      gates, attempts: [{ attemptId: 'pd', kind: 'draft', docKind: 'requirements', status: 'running' }],
      checkpoint: { openQuestions: [], decisions: [], assumptions: [] },
    });
    assert.ok(creating.includes('Creating requirements'));
    assert.ok(creating.includes('no need to click again'));
    assert.ok(creating.includes('data-testid="prep-draft-working"'));
    assert.ok(!creating.includes('data-testid="prep-next-draft"'));
    const waiting = await renderPrepPanel('pc-draft-wait', {}, {
      gates, attempts: [{ attemptId: 'pd', kind: 'draft', docKind: 'requirements', status: 'running' }],
    });
    assert.ok(waiting.includes('The lead is waiting for your answer above'));
    assert.ok(waiting.includes('Waiting for your answer'));
    assert.ok(!waiting.includes('data-testid="prep-next-draft"'));
  });

  test('confirmed idea shows requirements as the next action and stops asking for review', async () => {
    const html = await renderPrepPanel('pc-next-requirements', {}, {
      gates: [{ gateId: 'gi', type: 'intent_confirm', status: 'confirmed' }],
      intent: { proposal: { text: 'Extract Reddit data from the browser.' } },
      checkpoint: { openQuestions: [], decisions: [], assumptions: [] },
    });
    assert.ok(html.includes('Create requirements'));
    assert.ok(html.includes('Your idea is confirmed'));
    assert.ok(!html.includes('data-testid="prep-review-jump"'));
    assert.ok(!html.includes('data-testid="prep-intent-review"'));
  });

  test('thread footer distinguishes a working lead from a completed turn awaiting review', async () => {
    const working = await renderPrepPanel('pc-footer-running', {}, {
      attempts: [{ attemptId: 'pa-next', kind: 'turn', status: 'running' }],
      checkpoint: { openQuestions: [], decisions: [], assumptions: [] },
    });
    assert.ok(working.includes('Your answer is saved. The lead is preparing the next turn'));
    assert.ok(!working.includes('data-testid="prep-review-jump"'));
    const finished = await renderPrepPanel('pc-footer-done', {}, {
      attempts: [{ attemptId: 'pa-next', kind: 'turn', status: 'completed' }],
      intent: { proposal: { text: 'Use browser extraction instead of RSS.' } },
      checkpoint: { openQuestions: [], decisions: [], assumptions: [] },
    });
    assert.ok(finished.includes('Discussion complete. Confirm the clarified idea below to proceed to requirements'));
    assert.ok(finished.includes('data-testid="prep-review-jump"'));
    const footer = finished.match(/data-testid="prep-thread-state"[\s\S]*?<\/div>/)?.[0];
    assert.ok(footer && !footer.includes('prep-spinner'));
  });

  test('structured no-progress blocker gives a recoverable message, not raw JSON', async () => {
    const html = await renderPrepPanel('pc-blocked', {}, {
      blocker: { code: 'no_progress', detail: '3 consecutive turns', retryable: true },
    });
    const message = html.match(/data-testid="prep-blocker"[^>]*>([\s\S]*?)<\/p>/)?.[1];
    assert.ok(message?.includes('Your answers are saved'));
    assert.ok(!message.includes('no_progress'));
    assert.ok(!message.includes('retryable'));
  });

  test('review and handoff controls appear only when their subject is ready', async () => {
    const interviewing = await renderPrepPanel('pc-interview', {}, {});
    assert.ok(!interviewing.includes('data-testid="prep-handoff"'));
    assert.ok(!interviewing.includes('data-testid="prep-intent-review"'));
    assert.ok(!interviewing.includes('data-testid="prep-document-review"'));
    const clarified = await renderPrepPanel('pc-clarified', {}, {
      intent: { proposal: { text: 'A local reading queue.' } },
      checkpoint: { openQuestions: [], decisions: [], assumptions: [] },
    });
    assert.ok(clarified.includes('data-testid="prep-intent-review"'));
    assert.ok(clarified.includes('A local reading queue.'));
    assert.ok(!clarified.includes('data-testid="prep-handoff"'));
  });

  test('flagged orchestrator/swarm appear in the startable-mode line', async () => {
    const html = await renderPrepPanel(
      'pc3',
      { features: { start: true, orchestrator: true, swarm: true, preparation: true } },
      { ready: true },
    );
    assert.ok(html.includes('prep-modes-available'), 'startable-mode line renders');
    assert.ok(html.includes('orchestrator'), 'flagged orchestrator is named startable');
    assert.ok(html.includes('swarm'), 'flagged swarm is named startable');
  });
});
