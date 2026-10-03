// U6 behavioral tests — execution API request engine, UI-model gates, the
// execution store's concurrency/lifecycle rules, board managed persistence,
// and the card-draft machine. Everything runs against the REAL modules with
// real wire shapes (fixtures mirror server/execution/state-service.mjs's
// cardView + the verbatim run record and review-contract docs).
//
//   node --experimental-strip-types scripts/test_execution_ui.mjs
//   (node >=22.7 strips types natively; the loader hooks resolve the
//    repo's bundler-style extensionless imports and .vue SFCs)

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

register(new URL('./test_sfc_loader.mjs', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared real wire fixtures (mirroring state-service.mjs cardView() + the
// verbatim run record; review docs mirror review-contract.mjs)
// ---------------------------------------------------------------------------

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const now = () => Date.now();

function docVersion(over = {}) {
  return {
    versionId: 'dv_req1',
    sha256: SHA,
    bytes: 12,
    createdAt: now() - 10_000,
    source: 'text',
    path: null,
    ...over,
  };
}

function cardView(over = {}) {
  const reqV = docVersion();
  const planV = docVersion({
    versionId: 'dv_plan1',
    sha256: SHA2,
    checksFromDocument: {
      ok: true,
      checks: [{ run: 'npm test', cwd: 'app', timeoutSec: 60, setup: true }],
      problems: [],
    },
  });
  return {
    cardId: 'card_1',
    managed: true,
    schemaVersion: 1,
    enabledAt: now() - 50_000,
    controlRevision: 7,
    internalRevision: 3,
    project: { id: 'p1', label: 'demo', path: '/srv/demo' },
    session: null,
    currentRunId: null,
    workspaceId: 'ws1',
    composition: {
      preset: {
        id: 'pr1',
        name: 'solo',
        members: {
          implementer: { cli: 'pi', model: 'm1' },
          reviewer: { cli: 'pi', model: 'm1' },
          checker: { cli: 'pi', model: 'm1' },
        },
        limits: { maxAttemptsPerRole: 1, timeoutMin: 60, maxReviewRounds: 3 },
      },
      at: now() - 40_000,
    },
    pendingWrites: null,
    documents: {
      requirements: { current: reqV.versionId, versions: [reqV] },
      plan: { current: planV.versionId, versions: [planV] },
      design: { current: null, versions: [] },
    },
    approvals: {
      requirements: { versionId: reqV.versionId, sha256: reqV.sha256, at: now() - 9000, by: 'user' },
      plan: {
        versionId: planV.versionId,
        sha256: planV.sha256,
        requirementsVersionId: reqV.versionId,
        requirementsSha256: reqV.sha256,
        checks: [{ run: 'npm test', cwd: 'app', timeoutSec: 60, setup: true }],
        at: now() - 8000,
        by: 'user',
      },
      design: null,
    },
    runs: [],
    workspaces: {
      ws1: {
        id: 'ws1', status: 'ready', runId: null,
        path: '/srv/demo/.worktrees/ws1', branch: 'managed/card-1', owner: null,
      },
    },
    commandsProcessed: 4,
    projection: { stage: 'in_progress', status: 'implementing' },
    ...over,
  };
}

function runRecord(over = {}) {
  return {
    id: 'run_1',
    cardId: 'card_1',
    mode: 'solo',
    status: 'active',
    phase: 'awaiting_validation',
    createdAt: now() - 30_000,
    finishedAt: null,
    inputs: {
      requirements: { versionId: 'dv_req1', sha256: SHA },
      plan: {
        versionId: 'dv_plan1', sha256: SHA2, requirementsVersionId: 'dv_req1',
        checks: [{ run: 'npm test', cwd: 'app', timeoutSec: 60, setup: true }],
      },
      design: null,
    },
    composition: cardView().composition,
    baseRef: 'main',
    baseCommit: 'deadbeef'.repeat(8),
    workspaceId: 'ws1',
    attempts: [{
      id: 'att_1', runId: 'run_1', role: 'implementer', phase: 'implement',
      n: 1, status: 'completed', createdAt: now() - 25_000,
      startedAt: now() - 24_000, finishedAt: now() - 20_000,
      result: { status: 'done', exitCode: 0, finalArtifactId: 'art_out', durationS: 240, summary: 'implemented the thing' },
      error: null,
    }],
    result: { status: 'done', exitCode: 0, finalArtifactId: 'art_out', durationS: 240, summary: 'implemented the thing', attemptId: 'att_1', role: 'implementer', at: now() - 20_000 },
    acceptance: null,
    validation: {
      id: 'val_1', status: 'active', phase: 'verify', round: 1,
      resultSha256: SHA,
      checks: {
        status: 'settled', verdict: 'pass',
        reports: [{
          index: 0, status: 'pass', exitCode: 0,
          stdoutTail: 'ok', stderrTail: '', stdoutBytes: 4, stderrBytes: 0,
          logOutArtifactId: 'art_stdout', logErrArtifactId: 'art_stderr',
          logSha256Out: 'c'.repeat(64), logSha256Err: 'd'.repeat(64), at: now() - 15_000,
        }],
      },
      reports: {
        findings: {
          doc: {
            version: 1, round: 1, resultSha256: SHA,
            findings: [
              { id: 'f1', round: 1, severity: 'major', text: 'missing guard on empty input', where: 'src/x.ts:12', status: 'open' },
              { id: 'f2', round: 1, severity: 'nit', text: 'naming', where: '', status: 'open' },
            ],
          },
          attemptId: 'att_r1', artifactId: 'art_find', artifactSha256: 'e'.repeat(64), at: now() - 10_000,
        },
        verdicts: {
          doc: {
            version: 1, round: 1,
            verdicts: [
              { findingId: 'f1', round: 1, verdict: 'confirmed', reason: 'real defect' },
              { findingId: 'f2', round: 1, verdict: 'rejected', reason: 'style only' },
            ],
          },
          attemptId: 'att_c1', artifactId: 'art_verd', artifactSha256: 'f'.repeat(64), at: now() - 8000,
        },
      },
      procs: {}, dirs: {}, endedAt: null,
    },
    rounds: [],
    fixContext: null,
    continuation: null,
    artifacts: {
      art_out: { kind: 'output', file: 'out.md', stored: 'out.md', sha256: 'ab'.repeat(32), bytes: 100 },
      art_stdout: { kind: 'check_stdout', file: 'c0.out', stored: 'c0.out', sha256: 'c'.repeat(64), bytes: 4 },
      art_stderr: { kind: 'check_stderr', file: 'c0.err', stored: 'c0.err', sha256: 'd'.repeat(64), bytes: 0 },
    },
    ...over,
  };
}

const ev = (seq, type = 'note') => ({ seq, type, at: 1700000000000 + seq });

// Minimal fetch Response stand-in honoring the AbortController signal.
function fakeRes(status, body, { bodyDelayMs = 0, neverBody = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: (init) => {
      const signal = init?.signal ?? fakeRes._signal;
      if (neverBody) {
        return new Promise((_res, rej) => {
          signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          if (typeof body === 'string') {
            try { res(JSON.parse(body)); } catch (e) { rej(e); }
          } else res(body);
        }, bodyDelayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    },
  };
}

// A fetch that hands its signal to the fake response (mirrors real fetch:
// res.json() fails with AbortError when the controller fires).
function wireFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const out = handler(url, init);
    const res = await Promise.resolve(out);
    if (res && typeof res.json === 'function') {
      const signal = init.signal;
      const origJson = res.json.bind(res);
      res.json = () => origJson({ signal });
    }
    return res;
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// 1. request engine
// ---------------------------------------------------------------------------

const { ExecClient, ExecApiError } = await import('../src/lib/execution/api.ts');

describe('ExecClient request engine', () => {
  test('malformed 200 JSON is a transport failure, not a typed result', async () => {
    const fetchFn = wireFetch(() => fakeRes(200, '{not json'));
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn });
    await assert.rejects(c.getCard('x'), (e) => e instanceof ExecApiError && e.status === 200);
    assert.equal(fetchFn.calls.length, 1); // no retry
  });

  test('headers-200 + stalled body aborts as timeout — never a typed success', async () => {
    const fetchFn = wireFetch(() => fakeRes(200, null, { neverBody: true }));
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn, timeoutMs: 40 });
    const err = await c.getCard('x').then(() => null, (e) => e);
    assert.ok(err instanceof ExecApiError);
    assert.equal(err.status, 0);
    assert.equal(err.details?.cause, 'timeout');
  });

  test('non-JSON error body keeps the HTTP status and classified error', async () => {
    const fetchFn = wireFetch(() => fakeRes(500, '<html>oops</html>'));
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn });
    await assert.rejects(c.getCard('x'), (e) => e instanceof ExecApiError && e.status === 500);
  });

  test('sendCommand sends the envelope verbatim — one POST, one commandId', async () => {
    let body = null;
    const fetchFn = wireFetch((_u, init) => {
      body = JSON.parse(init.body);
      return fakeRes(200, { ok: true, result: { status: 'enabled' } });
    });
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn });
    const env = { commandId: 'uc_1', type: 'enable', payload: {} };
    const r = await c.sendCommand('card_9', env);
    assert.equal(r.result.status, 'enabled');
    assert.deepEqual(body, env);
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].init.method, 'POST');
    assert.equal(fetchFn.calls[0].url, 'http://t/api/execution/cards/card_9/commands');
  });

  test('probe() bounds the whole read — a stalled body resolves false', async () => {
    const fetchFn = wireFetch(() => fakeRes(200, null, { neverBody: true }));
    const c = new ExecClient({ baseUrl: 'http://t', fetchFn });
    const r = await Promise.race([c.probe(), sleep(4500).then(() => 'wedged')]);
    assert.equal(r, false);
  });
});

// ---------------------------------------------------------------------------
// 2. ui-model gates on real wire fixtures
// ---------------------------------------------------------------------------

const {
  canStart, canStop, canContinue, canAccept, reservedRuns,
  checksToRows, rowsToChecks, effectivePlanChecks, enableEligibility,
  acceptPayload, docState,
  // F4 fusion surface
  isFusion, fusionParticipants, fusionPendingActions, fusionWorkOrders,
  currentWorkOrder, pendingActionText, participantStatusLabel, fusionStatusLabel,
  canRetryParticipant, canExcludePanelist, canApproveWorkOrder, canStartFusion,
  fusionDraftProblems, fusionStartPayload,
  retryParticipantPayload, excludePanelistPayload, approveWorkOrderPayload,
} = await import('../src/lib/execution/ui-model.ts');

describe('ui-model gates (real wire fixtures)', () => {
  test('canStart happy path: approved req+plan+composition, no live work', () => {
    const g = canStart(cardView());
    assert.equal(g.ok, true, g.reason);
  });

  test('canStart refuses revoked/missing approvals and missing composition', () => {
    const v = cardView();
    v.approvals.plan = null;
    assert.equal(canStart(v).ok, false);
    const v2 = cardView({ composition: null });
    const g2 = canStart(v2);
    assert.equal(g2.ok, false);
    assert.match(g2.reason, /composition|preset|team/i);
  });

  test('canStart refuses when the approved version is no longer current', () => {
    const v = cardView();
    v.documents.requirements.current = 'dv_newer';
    v.documents.requirements.versions.push(docVersion({ versionId: 'dv_newer' }));
    const g = canStart(v);
    assert.equal(g.ok, false);
    assert.match(g.reason, /version|stale|current/i);
  });

  test('terminal run with reserved=true still blocks continue', () => {
    const v = cardView({
      runs: [{ id: 'run_dead', status: 'failed', reserved: true }],
      currentRunId: 'run_dead',
    });
    const g = canContinue(v, null);
    assert.equal(g.ok, false);
    assert.match(g.reason, /reservation|reserved|live/i);
  });

  test('parked active+awaiting_validation run with reserved=false can continue', () => {
    const v = cardView({
      runs: [{ id: 'run_parked', status: 'active', reserved: false }],
      currentRunId: 'run_parked',
    });
    // the loaded run detail carries the phase that proves the parked state
    const detail = runRecord({ id: 'run_parked', status: 'active', phase: 'awaiting_validation' });
    const g = canContinue(v, detail);
    assert.equal(g.ok, true, g.reason);
    // without the loaded detail an active-status run is conservatively refused
    assert.equal(canContinue(v, null).ok, false);
  });

  test('an unrelated inflight run blocks continue', () => {
    const v = cardView({
      runs: [
        { id: 'run_done', status: 'awaiting_acceptance', reserved: false },
        { id: 'run_other', status: 'active', reserved: true },
      ],
      currentRunId: 'run_done',
    });
    const g = canContinue(v, null);
    assert.equal(g.ok, false);
  });

  test('canAccept needs an awaiting_acceptance run with a recorded hash and no reservation', () => {
    const v = cardView({
      runs: [{ id: 'run_aa', status: 'awaiting_acceptance', reserved: false }],
      currentRunId: 'run_aa',
    });
    v.workspaces.ws1.runId = 'run_aa';
    const run = runRecord({
      id: 'run_aa',
      status: 'awaiting_acceptance', phase: 'awaiting_acceptance',
      acceptance: { resultSha256: SHA, round: 1, at: now() },
    });
    const g = canAccept(v, run);
    assert.equal(g.ok, true, g.reason);
    const payload = acceptPayload(run);
    assert.equal(payload.runId, 'run_aa');
    assert.equal(payload.resultSha256, SHA);
  });

  test('canAccept refuses a live reservation / missing hash / rebound workspace', () => {
    const v = cardView({ runs: [{ id: 'run_1', status: 'awaiting_acceptance', reserved: true }], currentRunId: 'run_1' });
    v.workspaces.ws1.runId = 'run_1';
    const run = runRecord({ status: 'awaiting_acceptance', acceptance: { resultSha256: SHA, round: 1, at: now() } });
    assert.equal(canAccept(v, run).ok, false);
    const runNoHash = runRecord({ status: 'awaiting_acceptance', phase: 'awaiting_acceptance', acceptance: null });
    const v2 = cardView({ runs: [{ id: 'run_1', status: 'awaiting_acceptance', reserved: false }], currentRunId: 'run_1' });
    v2.workspaces.ws1.runId = 'run_1';
    assert.equal(canAccept(v2, runNoHash).ok, false);
    // a workspace no longer bound to this run refuses acceptance
    v2.workspaces.ws1.runId = 'run_other';
    const runOk = runRecord({ status: 'awaiting_acceptance', phase: 'awaiting_acceptance', acceptance: { resultSha256: SHA, round: 1, at: now() } });
    assert.equal(canAccept(v2, runOk).ok, false);
  });

  test('check row round-trip and validation', () => {
    const checks = [{ run: 'npm test', cwd: 'app', timeoutSec: 60, setup: true }];
    const rows = checksToRows(checks);
    assert.equal(rows[0].run, 'npm test');
    const back = rowsToChecks(rows);
    assert.equal(back.ok, true);
    assert.deepEqual(back.checks, checks);
    const bad = rowsToChecks([{ run: '', cwd: '', timeoutSec: '', setup: false }]);
    assert.equal(bad.ok, false);
    const badNum = rowsToChecks([{ run: 'x', cwd: '', timeoutSec: 'abc', setup: false }]);
    assert.equal(badNum.ok, false);
  });

  test('effectivePlanChecks precedence: editor rows > attach-time > document', () => {
    const v = cardView();
    const planV = v.documents.plan.versions[0];
    const docSet = effectivePlanChecks(planV, null);
    assert.equal(docSet.source, 'document_block');
    const edited = effectivePlanChecks(planV, checksToRows([{ run: 'make lint' }]));
    assert.equal(edited.source, 'approval_payload');
    assert.equal(edited.checks[0].run, 'make lint');
    const attach = effectivePlanChecks(
      { ...planV, checksFromDocument: { ok: false }, checks: { checks: [{ run: 'x' }] } },
      null,
    );
    assert.equal(attach.source, 'attach_payload');
  });

  test('enableEligibility explains a cancelled/unprojected card', () => {
    assert.equal(enableEligibility({ cancelled: false, projectResolvable: true }).ok, true);
    const g = enableEligibility({ cancelled: true, projectResolvable: false, projectLabel: 'ghost' });
    assert.equal(g.ok, false);
    assert.ok(g.reasons.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// 3. execution store — Pinia + controlled client
// ---------------------------------------------------------------------------

// Fail-closed global fetch: installed BEFORE any store/module code runs.
// board.syncManagedRows / persistManagedBoard / the KV seam all go through
// globalThis.fetch — anything unrouted is a hard error, never real network.
let remoteState = null;
const fetchCalls = [];
function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, init });
  const remote = remoteState;
  if (!remote) throw new Error(`fail-closed fetch: no remote installed for ${u}`);
  const j = jsonRes;
  // When a real in-process state service is installed, delegate every
  // legacy route — GET/PUT rev semantics are the service's own.
  if (remote.svc) {
    const parsed = new URL(u);
    const res = await remote.svc.request({
      method: init.method ?? 'GET',
      path: parsed.pathname,
      query: parsed.searchParams,
      bodyText: init.body,
      headers: {},
    });
    return j(res.status, res.json);
  }
  if (u.endsWith('/health')) return j(200, { ok: true });
  const m = /\/api\/state\/([^/?]+)/.exec(u);
  if (m && decodeURIComponent(m[1]) === 'board.json') {
    const applyPut = (body) => {
      if (body.rev !== remote.doc.rev) return j(409, { code: 'rev_conflict', error: 'rev conflict', rev: remote.doc.rev });
      remote.doc = { name: 'board.json', rev: remote.doc.rev + 1, updatedAt: Date.now(), data: body.data };
      return j(200, { name: 'board.json', rev: remote.doc.rev, updatedAt: remote.doc.updatedAt });
    };
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      if (typeof remote.putGate === 'function') {
        const g = remote.putGate(body);
        const finish = (x) => (x ? j(x.status, x.body) : applyPut(body));
        return g instanceof Promise ? g.then(finish) : finish(g);
      }
      return applyPut(body);
    }
    return remote.missing ? j(404, { code: 'not_found' }) : j(200, remote.doc);
  }
  throw new Error(`fail-closed fetch: unrouted ${init.method ?? 'GET'} ${u}`);
};
function installFetchRouter(remote) {
  remoteState = remote;
}
// default: an empty board doc so stray store reads stay deterministic
installFetchRouter({ doc: { name: 'board.json', rev: 1, updatedAt: 1, data: { version: 2, cards: [] } }, missing: false, putGate: null });

const { setActivePinia, createPinia } = await import('pinia');
const execMod = await import('../src/stores/execution.ts');
const { useExecutionStore, setExecutionClient } = execMod;
const boardMod = await import('../src/stores/board.ts');
const { useBoardStore } = boardMod;
const { useWorkflowStore } = await import('../src/stores/workflow.ts');
const storageMod = await import('../src/lib/host/storage.ts');
const { __resetWebKvForTests } = storageMod;

/** Controllable ExecClient stand-in — every call is logged and each method
 * can be given a queue of responses or a function. */
class FakeExec {
  constructor() {
    this.calls = [];
    this.handlers = {};
  }
  on(method, handler) { this.handlers[method] = handler; }
  queue(method, items) {
    const q = [...items];
    this.on(method, (...a) => (q.length ? q.shift()() : Promise.reject(new Error(`${method} exhausted`))));
  }
  _call(method, args) {
    this.calls.push({ method, args });
    const h = this.handlers[method];
    if (!h) return Promise.reject(new Error(`no handler for ${method}`));
    return Promise.resolve().then(() => h(...args));
  }
  getCard(id) { return this._call('getCard', [id]); }
  getRun(id) { return this._call('getRun', [id]); }
  getRunEvents(id, cursor, limit) { return this._call('getRunEvents', [id, cursor, limit]); }
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
}

const deferred = () => {
  let res, rej;
  const p = new Promise((r, j) => { res = r; rej = j; });
  return { p, res, rej };
};

let activeExec = null;
function freshPinia() {
  setActivePinia(createPinia());
  const exec = useExecutionStore();
  activeExec = exec;
  const client = new FakeExec();
  setExecutionClient(client);
  const board = useBoardStore();
  return { exec, client, board };
}

/** Release every held watcher/focus so no poll interval outlives a test —
 * the suite must exit cleanly on its own handles. */
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

describe('execution store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => releaseExec());

  test('watchCard → refreshCard adopts the real card view; unwatch drops state', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView());
    exec.watchCard('card_1');
    await sleep(0);
    const st = exec.stateFor('card_1');
    assert.equal(st.phase, 'ready');
    assert.equal(st.view.controlRevision, 7);
    assert.equal(exec.online, true);
    exec.unwatchCard('card_1');
    assert.equal(exec.cards['card_1'], undefined);
    // a late response must not resurrect the entry
    assert.equal(exec.stateFor('card_1').phase, 'idle');
    exec.unwatchCard('card_1'); // balance the stateFor-created entry
  });

  test('stateFor returns the reactive entry even on the create path', async () => {
    const { isReactive } = await import('vue');
    const { exec } = freshPinia();
    // Regression (U7 browser-on): stateFor previously returned the RAW
    // freshState object on the create path — `cards.value[id] = st; return
    // st`. ExecutionPanel's `st = computed(() => exec.stateFor(cardId))`
    // could cache that raw object; `run = computed(() => st.value.run)`
    // then read .run through a non-reactive surface — store-side writes
    // never re-triggered it, so the panel stayed stuck with run-status
    // absent while the card view rendered live (raw objects still reflect
    // proxy writes when re-read).
    const st = exec.stateFor('card_raw');
    assert.equal(isReactive(st), true,
                 'first access must already hand out the reactive proxy');
    assert.equal(st, exec.cards['card_raw'],
                 'the handed-out object must BE the live reactive entry');
    const stC = computed(() => exec.stateFor('card_raw'));
    const runC = computed(() => stC.value.run);
    assert.equal(runC.value, null);
    st.run = { id: 'run_x' };
    assert.equal(runC.value?.id, 'run_x',
                 'a computed over stateFor must track later .run writes');
    exec.unwatchCard('card_raw'); // drops the entry (watchers 0→0)
  });

  test('double command click issues exactly one POST', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView());
    const postD = deferred();
    const posts = [];
    client.on('sendCommand', (_id, env) => {
      posts.push(env);
      return postD.p;
    });
    exec.watchCard('card_1');
    await sleep(0);
    const p1 = exec.sendCommand('card_1', 'stop'); // acquires busy, refreshes, POSTs
    await sleep(0); // let the first command reach the in-flight POST
    const p2 = exec.sendCommand('card_1', 'stop'); // must refuse 'busy'
    postD.res({ ok: true, result: {} });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].type, 'stop');
    const results = [r1, r2];
    assert.ok(results.some((r) => r?.ok === true));
    assert.ok(results.some((r) => r?.code === 'busy'));
    exec.unwatchCard('card_1');
  });

  test('a failed refresh refuses the command — no POST while offline', async () => {
    const { exec, client } = freshPinia();
    let okReads = 0;
    client.on('getCard', () => {
      okReads += 1;
      if (okReads === 1) return cardView();
      const e = new Error('unreachable'); e.status = 0;
      throw e;
    });
    let posted = 0;
    client.on('sendCommand', () => { posted += 1; return { ok: true }; });
    exec.watchCard('card_1');
    // settle the initial refresh explicitly — a later failure must be a
    // DISTINCT read, not the first one still in flight
    await exec.stateFor('card_1').cardInflight;
    assert.equal(okReads, 1);
    assert.equal(exec.stateFor('card_1').phase, 'ready');
    const r = await exec.sendCommand('card_1', 'stop');
    assert.equal(okReads, 2); // a distinct failed fresh read
    assert.equal(r.ok, false);
    assert.equal(posted, 0);
    exec.unwatchCard('card_1');
  });

  test('unwatch during the fresh GET: a landed view cannot issue the command', async () => {
    const { exec, client } = freshPinia();
    const read = deferred();
    client.on('getCard', () => read.p);
    let posted = 0;
    client.on('sendCommand', () => { posted += 1; return { ok: true }; });
    exec.watchCard('card_1');
    await sleep(0);
    // now the card is ready; next sendCommand does its own fresh read
    const cmd = exec.sendCommand('card_1', 'stop');
    await sleep(0);
    exec.unwatchCard('card_1'); // drawer closed mid-flight
    read.res(cardView());
    const r = await cmd;
    assert.equal(posted, 0);
    assert.equal(r.ok, false);
  });

  test('A→B→A run selection: an old A response cannot overwrite the new A', async () => {
    const { exec, client } = freshPinia();
    const view = cardView({ currentRunId: 'run_a', runs: [{ id: 'run_a', status: 'active', reserved: true }, { id: 'run_b', status: 'active', reserved: true }] });
    client.on('getCard', () => view);
    const aReads = [deferred(), deferred()];
    let aIdx = 0;
    client.on('getRun', (id) => {
      if (id === 'run_a') return aReads[aIdx++].p;
      return runRecord({ id: 'run_b' }); // B resolves immediately
    });
    client.on('getRunEvents', () => ({ runId: 'x', events: [], nextCursor: 0, limit: 200, remaining: 0, total: 0, corrupt: 0 }));
    exec.watchCard('card_1');
    await sleep(0);
    exec.stateFor('card_1').selectedRunId = 'run_a';
    const ra1 = exec.refreshRun('card_1');     // A flight #1 — left pending
    await exec.selectRun('card_1', 'run_b');   // B lands first
    assert.equal(exec.stateFor('card_1').run?.id, 'run_b');
    const selA2 = exec.selectRun('card_1', 'run_a'); // A flight #2 pending
    aReads[0].res(runRecord({ id: 'run_a', phase: 'stale_marker' })); // STALE A lands — must be discarded
    await ra1;
    await sleep(0);
    assert.equal(exec.stateFor('card_1').run, null); // still loading the new A
    aReads[1].res(runRecord({ id: 'run_a', phase: 'fresh_marker' })); // the real new A answer
    await selA2;
    assert.equal(exec.stateFor('card_1').run?.id, 'run_a');
    assert.equal(exec.stateFor('card_1').run?.phase, 'fresh_marker'); // not the stale payload
    assert.equal(exec.stateFor('card_1').runInflight, null); // old flight's finally did not clear the new one
    exec.unwatchCard('card_1');
  });

  test('current run transitions active→terminal: detail is refreshed, final state adopted', async () => {
    const { exec, client } = freshPinia();
    const live = cardView({ currentRunId: 'run_1', runs: [{ id: 'run_1', status: 'active', reserved: true }] });
    const term = cardView({ currentRunId: 'run_1', runs: [{ id: 'run_1', status: 'succeeded', reserved: false }] });
    let cardReads = 0;
    client.on('getCard', () => (cardReads++ === 0 ? live : term));
    client.on('getRun', () => runRecord({ id: 'run_1', status: 'succeeded', phase: null, finishedAt: now() }));
    client.on('getRunEvents', () => ({ runId: 'run_1', events: [], nextCursor: 0, limit: 200, remaining: 0, total: 0, corrupt: 0 }));
    exec.watchCard('card_1');
    await sleep(0);
    exec.stateFor('card_1').selectedRunId = 'run_1';
    exec.stateFor('card_1').run = runRecord({ id: 'run_1', status: 'active' }); // stale active detail
    await exec.refreshCard('card_1'); // summary now terminal → must pull fresh detail
    assert.equal(exec.stateFor('card_1').run?.status, 'succeeded');
    exec.unwatchCard('card_1');
  });

  test('event history drains multiple pages; out-of-order pages never regress the cursor', async () => {
    const { exec, client } = freshPinia();
    const view = cardView({ currentRunId: 'run_1', runs: [{ id: 'run_1', status: 'succeeded', reserved: false }] });
    client.on('getCard', () => view);
    client.on('getRun', () => runRecord({ id: 'run_1', status: 'succeeded' }));
    const pages = [
      { events: Array.from({ length: 200 }, (_, i) => ev(i)), nextCursor: 200, remaining: 250, total: 450 },
      { events: Array.from({ length: 200 }, (_, i) => ev(200 + i)), nextCursor: 400, remaining: 50, total: 450 },
      { events: Array.from({ length: 50 }, (_, i) => ev(400 + i)), nextCursor: 450, remaining: 0, total: 450 },
    ];
    client.queue('getRunEvents', pages.map((p) => () => ({ runId: 'run_1', limit: 200, corrupt: 0, ...p })));
    exec.watchCard('card_1');
    // the initial refresh auto-follows currentRunId and drains its history;
    // the run flight is a separate async chain past cardInflight — wait for
    // it to settle (bounded) rather than racing it
    await exec.stateFor('card_1').cardInflight;
    const st = exec.stateFor('card_1');
    let waits = 0;
    while (st.runInflight && waits++ < 50) await sleep(5);
    assert.equal(st.selectedRunId, 'run_1');
    assert.equal(st.events.length, 450);
    assert.equal(st.eventsCursor, 450);
    assert.equal(st.eventsPending, false);
    // A duplicate older page must not roll the cursor back or duplicate events
    client.on('getRunEvents', () => ({ runId: 'run_1', events: [ev(10), ev(11)], nextCursor: 12, remaining: 0, total: 450, corrupt: 0, limit: 200 }));
    st.eventsPending = true; // force one more drain cycle
    await exec.refreshRun('card_1');
    assert.equal(exec.stateFor('card_1').events.length, 450);
    assert.ok(exec.stateFor('card_1').eventsCursor >= 450);
    exec.unwatchCard('card_1');
  });

  test('openManagedRun focus balances watches; switching cards releases the old one', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView());
    client.on('getRun', (id) => runRecord({ id }));
    client.on('getRunEvents', () => ({ runId: 'x', events: [], nextCursor: 0, limit: 200, remaining: 0, total: 0, corrupt: 0 }));
    exec.openManagedRun('card_1', 'run_1');
    assert.equal(exec.stateFor('card_1').watchers, 1);
    exec.openManagedRun('card_1', 'run_2'); // same card, different run — no extra watch
    assert.equal(exec.stateFor('card_1').watchers, 1);
    exec.openManagedRun('card_2', 'run_9'); // different card — swap
    assert.equal(exec.cards['card_1'], undefined); // released fully
    assert.equal(exec.stateFor('card_2').watchers, 1);
    exec.clearFocus();
    assert.equal(exec.focused, null);
    assert.equal(exec.cards['card_2'], undefined);
    exec.unwatchCard('card_2');
  });

  test('a deferred command failure does not flip online after a newer healthy read', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView());
    const postD = deferred();
    client.on('sendCommand', () => postD.p);
    exec.watchCard('card_1');
    await sleep(0);
    const cmd = exec.sendCommand('card_1', 'stop');
    await sleep(0);
    // a healthy read lands WHILE the command is in flight
    await exec.refreshCard('card_1');
    assert.equal(exec.online, true);
    const e = new ExecApiError(0, null, 'dropped');
    postD.rej(e);
    await cmd;
    // The old failure may still report offline — but a subsequent healthy
    // read (issued later) must restore it and never be reverted.
    await exec.refreshCard('card_1');
    assert.equal(exec.online, true);
    exec.unwatchCard('card_1');
  });
});

// ---------------------------------------------------------------------------
// 4. board store managed persistence (stubbed state server over fetch)
// ---------------------------------------------------------------------------

function mkCard(over = {}) {
  return {
    id: over.id ?? `c_${Math.random().toString(36).slice(2, 10)}`,
    title: 't', description: '', project: '', agent: '', priority: 'medium',
    acceptance: '', verification: '', links: [], session: null,
    stage: 'backlog', status: null, statusByStage: {},
    blocked: false, blockedReason: '', cancelled: false,
    touches: [], dependsOn: [], blocks: [], conflictsWith: [],
    order: 1024, createdAt: 1, updatedAt: 1, execution: null,
    ...over,
  };
}

const managedMarker = (over = {}) => ({ managed: true, internalRevision: 1, controlRevision: 2, ...over });

describe('board store — managed persistence', () => {
  let remote;
  beforeEach(async () => {
    remote = { doc: { name: 'board.json', rev: 1, updatedAt: 1, data: { version: 2, cards: [] } }, missing: false, putGate: null };
    installFetchRouter(remote);
    // each case owns a clean KV view + remote doc; the reset tears down the
    // previous case's RemoteKVStore poll timer
    await __resetWebKvForTests();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    setActivePinia(createPinia());
  });
  afterEach(async () => {
    await __resetWebKvForTests(); // dispose this case's poll timer
  });

  test('field-level merge: a stale save sends only the edited field, preserving another writer\'s', async () => {
    const board = useBoardStore();
    remote.doc.data.cards = [mkCard({ id: 'c1', title: 'old title', description: 'remote desc', execution: managedMarker() })];
    await board.initBoardStore();
    await sleep(0);
    // local edit of title only (simulating a stale tab)
    const r = board.updateCard('c1', { title: 'new title' });
    assert.equal(r.ok, true);
    await board.adoptRemoteBoard(); // unrelated remote field arrives meanwhile
    remote.doc.data.cards[0].description = 'tab B description'; // other tab's save landed
    await board.persistManagedBoard();
    const sent = remote.doc.data.cards[0];
    assert.equal(sent.title, 'new title');
    assert.equal(sent.description, 'tab B description'); // preserved, not the stale ''
  });

  test('delayed PUT + a second edit during flight both persist', async () => {
    const board = useBoardStore();
    remote.doc.data.cards = [mkCard({ id: 'c1', title: 't', execution: managedMarker() })];
    const gate = deferred();
    let puts = 0;
    remote.putGate = (body) => {
      puts += 1;
      if (puts === 1) return gate.p.then(() => null); // hold the first PUT open
      return null;
    };
    await board.initBoardStore();
    await sleep(0);
    board.updateCard('c1', { title: 'first' });
    const p = board.persistManagedBoard(); // in-flight PUT #1
    await sleep(0);
    board.updateCard('c1', { description: 'second edit' }); // mid-flight edit
    gate.res();
    await p;
    // the in-flight save shipped title only; the second edit stayed dirty →
    // the follow-up save must carry it
    await board.persistManagedBoard();
    assert.equal(remote.doc.data.cards[0].title, 'first');
    assert.equal(remote.doc.data.cards[0].description, 'second edit');
    assert.ok(puts >= 2);
  });

  test('remote deletion is not resurrected; dirty fields overlay remote rows', async () => {
    const board = useBoardStore();
    remote.doc.data.cards = [
      mkCard({ id: 'keep', title: 'k' }),
      mkCard({ id: 'gone', title: 'g' }),
    ];
    await board.initBoardStore();
    await sleep(0);
    assert.ok(board.cards.some((c) => c.id === 'gone'));
    // the server deleted it meanwhile
    remote.doc.data.cards = [mkCard({ id: 'keep', title: 'k2' })];
    await board.adoptRemoteBoard();
    assert.ok(!board.cards.some((c) => c.id === 'gone'));
    assert.equal(board.cards.find((c) => c.id === 'keep').title, 'k2');
  });

  test('applyManagedProjection overlays server-owned fields only; syncManagedRows reports read success', async () => {
    const board = useBoardStore();
    remote.doc.data.cards = [mkCard({ id: 'c1', stage: 'done', execution: managedMarker() })];
    await board.initBoardStore();
    await sleep(0);
    board.updateCard('c1', { title: 'user edit' }); // pending user delta
    board.applyManagedProjection(cardView({
      cardId: 'c1',
      // real wire projection: {stage, status} in BOARD vocabulary
      // (lifecycleStage: queued/active run → dev/in_progress)
      projection: { stage: 'dev', status: 'in_progress' },
    }));
    const c = board.cards.find((x) => x.id === 'c1');
    assert.equal(c.stage, 'dev');
    assert.equal(c.status, 'in_progress');
    assert.equal(c.title, 'user edit'); // pending edit preserved
    const ok = await board.syncManagedRows();
    assert.equal(ok, true); // success even when nothing changed
    remote.missing = true;
    const fail = await board.syncManagedRows();
    assert.equal(fail, false);
    remote.missing = false;
  });

  test('lifecycle mutations on a managed card are refused with reasons', () => {
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'c1', execution: managedMarker() })];
    assert.equal(board.moveCard('c1', 'done').ok, false);
    assert.equal(board.setCardStatus('c1', 'implementing').ok, false);
    assert.equal(board.setCardFlag('c1', 'blocked', true).ok, false);
    assert.equal(board.removeCard('c1').ok, false);
    assert.equal(board.updateCard('c1', { stage: 'done' }).ok, false);
    // user fields still allowed
    assert.equal(board.updateCard('c1', { title: 'x' }).ok, true);
  });
});

// ---------------------------------------------------------------------------
// 5. card-draft machine (the exact composable CardDrawer runs)
// ---------------------------------------------------------------------------

const { useCardDraft, draftFromCard } = await import('../src/features/board/useCardDraft.ts');
const { ref, computed, reactive, nextTick, effectScope, onScopeDispose } = await import('vue');

function draftHarness(cards, cardIdRef, saveMs = 15) {
  const writes = [];
  const refusals = [];
  const scope = effectScope();
  let d;
  scope.run(() => {
    d = useCardDraft({
      card: computed(() => cards.find((c) => c.id === cardIdRef.value) ?? null),
      cardId: computed(() => cardIdRef.value),
      findCard: (id) => cards.find((c) => c.id === id) ?? null,
      moveCard: (id, stage) => { writes.push(['moveCard', id, stage]); return { ok: true }; },
      setCardStatus: (id, s) => { writes.push(['setCardStatus', id, s]); return { ok: true }; },
      setCardFlag: (id, f, v, r) => { writes.push(['setCardFlag', id, f, v, r]); return { ok: true }; },
      updateCard: (id, patch) => {
        writes.push(['updateCard', id, patch]);
        const c = cards.find((x) => x.id === id);
        if (c) Object.assign(c, patch);
        return { ok: true };
      },
      onRefused: (r) => refusals.push(r),
      saveMs,
      onDispose: (fn) => onScopeDispose(fn), // bound to `scope` — runs inside scope.run
    });
  });
  return { d, writes, refusals, scope };
}

describe('useCardDraft — the drawer autosave machine', () => {
  test('edit on A flushed to A when switching to B before the debounce', async () => {
    const cards = reactive([mkCard({ id: 'A', title: 'A t' }), mkCard({ id: 'B', title: 'B t' })]);
    const cardId = ref('A');
    const { d, writes } = draftHarness(cards, cardId);
    d.draft.value.title = 'A edited';
    d.markDirty('title'); // 15ms pending
    cardId.value = 'B';   // switch before it fires
    await nextTick();
    await sleep(40);
    const upd = writes.filter((w) => w[0] === 'updateCard');
    assert.equal(upd.length, 1);
    assert.equal(upd[0][1], 'A');
    assert.deepEqual(upd[0][2], { title: 'A edited' });
    assert.equal(cards.find((c) => c.id === 'B').title, 'B t'); // untouched
    assert.equal(d.draft.value.title, 'B t'); // draft shows B
  });

  test('dispose flushes the pending write (unmount path)', async () => {
    const cards = reactive([mkCard({ id: 'A' })]);
    const cardId = ref('A');
    const scope = effectScope();
    const writes = [];
    let d;
    scope.run(() => {
      d = useCardDraft({
        card: computed(() => cards.find((c) => c.id === cardId.value) ?? null),
        cardId: computed(() => cardId.value),
        findCard: (id) => cards.find((c) => c.id === id) ?? null,
        moveCard: () => ({ ok: true }),
        setCardStatus: () => ({ ok: true }),
        setCardFlag: () => ({ ok: true }),
        updateCard: (id, patch) => { writes.push(patch); return { ok: true }; },
        onRefused: () => {},
        saveMs: 5000, // long — only dispose may flush
        onDispose: (fn) => onScopeDispose(fn),
      });
    });
    d.draft.value.title = 'typed at unmount';
    d.markDirty('title');
    scope.stop(); // unmount
    assert.equal(writes.length, 1);
    assert.equal(writes[0].title, 'typed at unmount');
  });

  test('only edited fields are sent — untouched draft fields never write', async () => {
    const cards = reactive([mkCard({ id: 'A', title: 't', description: 'd0' })]);
    const cardId = ref('A');
    const { d, writes } = draftHarness(cards, cardId);
    // another writer moved the description on the card itself
    cards[0].description = 'fresh remote desc';
    d.draft.value.title = 'just title';
    d.markDirty('title');
    await sleep(50);
    const upd = writes.find((w) => w[0] === 'updateCard');
    assert.deepEqual(upd[2], { title: 'just title' }); // no description key
  });

  test('same-card managed projection refresh: server-owned fields update, user edits survive, nothing persisted', async () => {
    const cards = reactive([mkCard({
      id: 'A', stage: 'backlog', status: null, blocked: false, cancelled: false,
      project: '', session: null, execution: managedMarker(),
    })]);
    const cardId = ref('A');
    const { d, writes } = draftHarness(cards, cardId);
    // user edits pending
    d.draft.value.title = 'my title';
    d.draft.value.description = 'my desc';
    d.markDirty('title');
    d.markDirty('description');
    // the poll lands a new projection on the SAME card — mutate through the
    // reactive proxy so the draft's deep watch observes it (raw-object writes
    // bypass instrumentation entirely)
    cards[0].stage = 'dev';
    cards[0].status = 'in_progress';
    cards[0].blocked = true;
    cards[0].blockedReason = 'card_dep';
    cards[0].project = 'demo';
    cards[0].session = { agentName: 'pi', sessionId: 's9' };
    await nextTick();
    await sleep(5);
    assert.equal(d.draft.value.stage, 'dev');
    assert.equal(d.draft.value.status, 'in_progress');
    assert.equal(d.draft.value.blocked, true);
    assert.equal(d.draft.value.blockedReason, 'card_dep');
    assert.equal(d.draft.value.project, 'demo');
    assert.equal(d.draft.value.sessionKey, 'pi::s9');
    // user edits untouched
    assert.equal(d.draft.value.title, 'my title');
    assert.equal(d.draft.value.description, 'my desc');
    await sleep(40); // the flush fires — must not send managed fields
    const upd = writes.find((w) => w[0] === 'updateCard');
    assert.ok(upd);
    const patchKeys = Object.keys(upd[2]).sort();
    assert.deepEqual(patchKeys, ['description', 'title']);
    assert.equal(writes.filter((w) => w[0] !== 'updateCard').length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. real component setup/render — the compiled SFC under SSR executes setup
//    (immediate watchers included — the TDZ regression class)
// ---------------------------------------------------------------------------

describe('CardDrawer/ExecutionPanel setup+render (SSR)', () => {
  beforeEach(async () => {
    installFetchRouter({ doc: { name: 'board.json', rev: 1, updatedAt: 1, data: { version: 2, cards: [] } }, missing: false, putGate: null });
    await __resetWebKvForTests();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    setActivePinia(createPinia());
  });
  afterEach(async () => {
    releaseExec();
    await __resetWebKvForTests();
  });

  test('CardDrawer mounts against an unmanaged card without setup errors', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'cd1', title: 'plain card' })];
    const app = createSSRApp(CardDrawer, { cardId: 'cd1' });
    const html = await renderToString(app);
    assert.ok(html.includes('card-drawer'));
    assert.ok(html.includes('plain card'));
  });

  test('CardDrawer mounts a managed card — ExecutionPanel renders unmanaged→managed states', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'cd2', title: 'managed card', execution: managedMarker() })];
    const app = createSSRApp(CardDrawer, { cardId: 'cd2' });
    const html = await renderToString(app);
    assert.ok(html.includes('card-drawer'));
    assert.ok(html.includes('execution-panel'));
  });

  test('WorkflowPanel renders managed run detail + FULL event history beside the porch section', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const WorkflowPanel = (await import('../src/components/WorkflowPanel.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'wfc1', title: 'wf card', execution: managedMarker() })];

    // Seed a focused card: a historical + current run, 30 events with
    // distinct first/last payloads — well past the old slice(-12) cutoff.
    const st = exec.stateFor('wfc1');
    st.phase = 'ready';
    st.view = cardView({
      cardId: 'wfc1',
      currentRunId: 'run_new',
      runs: [
        { id: 'run_old', status: 'succeeded', reserved: false },
        { id: 'run_new', status: 'active', reserved: false },
      ],
    });
    st.selectedRunId = 'run_new';
    st.run = runRecord({ id: 'run_new', cardId: 'wfc1', status: 'active', phase: 'implementing' });
    st.events = [
      { seq: 1, type: 'spawn', at: 1, data: { agent: 'pi', first: 'marker-alpha' } },
      ...Array.from({ length: 28 }, (_, i) => ({ seq: i + 2, type: 'note', at: 2 + i })),
      { seq: 30, type: 'checkpoint', at: 99, data: { last: 'marker-omega' } },
    ];
    st.eventsCursor = 30;
    st.eventsTotal = 30;
    exec.focused = { cardId: 'wfc1', runId: 'run_new' };
    // porch half stays present even with zero porch state
    const wf = useWorkflowStore();
    wf.porchUp = false;

    const app = createSSRApp(WorkflowPanel);
    const html = await renderToString(app);

    // managed detail: run selector lists BOTH runs (historical selectable),
    // full history renders first AND last events with their payloads — the
    // removed slice(-12) would have hidden seq 1 entirely
    assert.ok(html.includes('managed-run-select'));
    assert.ok(html.includes('run_old'));
    assert.ok(html.includes('run_new'));
    assert.ok(html.includes('#1'), 'first event must render');
    assert.ok(html.includes('marker-alpha'), 'first event payload detail must render');
    assert.ok(html.includes('#30'), 'last event must render');
    assert.ok(html.includes('marker-omega'), 'last event payload detail must render');
    assert.ok(!html.includes('loading run detail'));
    // porch section still renders its own truthful state — managed did not
    // replace it
    assert.ok(html.includes('Porch endpoint unreachable'));
  });

  test('WorkflowPanel renders run error + retry instead of a permanent loading state', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const WorkflowPanel = (await import('../src/components/WorkflowPanel.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'wfc2', title: 'err card', execution: managedMarker() })];

    const st = exec.stateFor('wfc2');
    st.phase = 'ready';
    st.view = cardView({
      cardId: 'wfc2',
      currentRunId: 'run_x',
      runs: [{ id: 'run_x', status: 'active', reserved: false }],
    });
    st.selectedRunId = 'run_x';
    st.run = null;
    st.runError = 'run read failed: HTTP 500';
    exec.focused = { cardId: 'wfc2', runId: 'run_x' };
    const wf = useWorkflowStore();
    wf.porchUp = false;

    const html = await renderToString(createSSRApp(WorkflowPanel));
    assert.ok(html.includes('managed-run-error'));
    assert.ok(html.includes('run read failed: HTTP 500'));
    assert.ok(html.includes('managed-run-retry'));
    assert.ok(!html.includes('loading run detail'));
    assert.ok(html.includes('Porch endpoint unreachable'));
  });
});

// ---------------------------------------------------------------------------
// 6b. F4 fusion surface — gates/payloads on the durable run.fusion record,
//     plus SSR render of the card drawer + workflow managed sections.
// ---------------------------------------------------------------------------

function fusionParticipant(id, over = {}) {
  return {
    id,
    label: `Panelist ${id.slice(1)}`,
    profileId: `f4-panel-${id}`,
    provider: 'zen-relay',
    model: `zen-relay/model-${id}`,
    profileDigest: `pd_${id}`,
    status: 'pending',
    attemptsUsed: 0,
    extraAttempts: 0,
    answer: null,
    exclusion: null,
    lastError: null,
    ...over,
  };
}

/** The durable fusion run record as buildFusionRun + the panel driver write
 * it — all display state lives under run.fusion. */
function fusionRun(over = {}) {
  const fz = {
    resultKind: 'document',
    fingerprint: 'f'.repeat(64),
    snapshot: {
      task: { kind: 'requirements', versionId: 'dv_req1', sha256: SHA },
      project: { projectRoot: 'proj-a', snapshotSha: 'e'.repeat(64) },
      search: { enabled: false },
    },
    limits: {
      maxAttemptsPerParticipant: 2, timeoutMin: 45,
      judgeAttempts: 2, integratorAttempts: 2, reviewAttemptsPerRole: 2,
    },
    participants: [
      fusionParticipant('p1', { status: 'answered', attemptsUsed: 1, answer: { attemptId: 'att_p1', artifactId: 'ans-att_p1', sha256: SHA, bytes: 40 } }),
      fusionParticipant('p2', { status: 'answered', attemptsUsed: 1, answer: { attemptId: 'att_p2', artifactId: 'ans-att_p2', sha256: SHA2, bytes: 42 } }),
      fusionParticipant('p3', {
        status: 'awaiting_decision', attemptsUsed: 2,
        lastError: { outcome: 'failed', reason: 'model exploded twice', attemptId: 'att_p3b', at: now() - 500 },
      }),
    ],
    exclusions: [],
    pendingActions: [{ type: 'participant_decision', participantId: 'p3' }],
    status: 'decision_pending',
    judgeEligible: null,
    settledAt: null,
    judge: { profileId: 'f4-judge', provider: 'anymodel', model: 'anymodel/cc/claude-opus-5-5', profileDigest: 'pd_j' },
    integrator: null,
    review: null,
    workOrders: [],
    workOrder: null,
    integrate: null,
    integratorReport: null,
    fixAttempts: [],
    ...(over.fusion ?? {}),
  };
  return {
    id: 'run_f1',
    cardId: 'card_1',
    mode: 'fusion',
    status: 'blocked',
    phase: 'panel',
    createdAt: now() - 30_000,
    finishedAt: null,
    inputs: { task: { kind: 'requirements', versionId: 'dv_req1', sha256: SHA } },
    composition: null,
    baseRef: 'HEAD',
    baseCommit: 'a'.repeat(64),
    workspaceId: null,
    attempts: [],
    result: null,
    events: [],
    eventsCursor: 0,
    ...over,
    fusion: fz,
  };
}

function fusionWorkOrder(versionId = 'wo_v1', over = {}) {
  return {
    versionId, artifactId: `wo-att_j1`, sha256: '7'.repeat(64), bytes: 900,
    verdict: 'in_plan', sections: { goal: 'x' }, steps: ['- do x'],
    attemptId: 'att_j1', at: now() - 1000, approved: null,
    decision: { routed: 'auto', reason: 'in_plan', at: now() - 900 },
    ...over,
  };
}

describe('fusion ui-model gates + payloads', () => {
  test('pendingActionText names the decision + participant', () => {
    const run = fusionRun();
    const acts = fusionPendingActions(run);
    assert.equal(acts.length, 1);
    const txt = pendingActionText(acts[0], run);
    assert.match(txt, /p3/);
    assert.match(txt, /retry or exclude/i);
  });

  test('canRetryParticipant — only an awaiting_decision participant on a decidable run', () => {
    const run = fusionRun();
    assert.equal(canRetryParticipant(run, 'p3').ok, true);
    assert.equal(canRetryParticipant(run, 'p1').ok, false); // answered
    assert.equal(canRetryParticipant(run, 'nobody').ok, false);
    assert.equal(canRetryParticipant(fusionRun({ status: 'succeeded' }), 'p3').ok, false);
    assert.equal(canRetryParticipant(runRecord(), 'p1').ok, false); // solo run
  });

  test('canExcludePanelist mirrors the model-quorum refusal', () => {
    // p3=model-p3 excluded → p1,p2 models remain (2) → ok
    assert.equal(canExcludePanelist(fusionRun(), 'p3').ok, true);
    // two participants sharing one model + one awaiting → excluding drops to 1
    const thin = fusionRun({
      fusion: {
        participants: [
          fusionParticipant('p1', { status: 'answered', attemptsUsed: 1, answer: { attemptId: 'a1', artifactId: 'x', sha256: SHA, bytes: 1 } }),
          fusionParticipant('p2', { model: 'zen-relay/model-p1', status: 'pending' }),
          fusionParticipant('p3', { status: 'awaiting_decision', attemptsUsed: 2 }),
        ],
      },
    });
    // excluding p3 leaves models {model-p1} (p2 same model) → 1 → refuse
    const g = canExcludePanelist(thin, 'p3');
    assert.equal(g.ok, false);
    assert.match(g.reason, /distinct model/i);
  });

  test('canApproveWorkOrder — current version + matching pending only', () => {
    const wo = fusionWorkOrder('wo_v1');
    const run = fusionRun({
      status: 'blocked',
      fusion: {
        workOrders: [wo],
        pendingActions: [{ type: 'work_order_approval', versionId: 'wo_v1', reason: 'acceptance' }],
        status: 'complete',
      },
    });
    assert.equal(canApproveWorkOrder(run, 'wo_v1').ok, true);
    assert.equal(canApproveWorkOrder(run).ok, true);
    // a stale version is refused
    assert.equal(canApproveWorkOrder(run, 'wo_v0').ok, false);
    // already approved
    const runApproved = fusionRun({
      status: 'succeeded',
      fusion: { workOrders: [fusionWorkOrder('wo_v1', { approved: { at: now(), by: 'user' } })], pendingActions: [] },
    });
    assert.equal(canApproveWorkOrder(runApproved, 'wo_v1').ok, false);
    // no pending action at all
    assert.equal(canApproveWorkOrder(fusionRun(), 'wo_v1').ok, false);
  });

  test('fusion command payloads bind the exact records', () => {
    const run = fusionRun();
    assert.deepEqual(retryParticipantPayload(run, 'p3'), { runId: 'run_f1', participantId: 'p3' });
    assert.deepEqual(
      excludePanelistPayload(run, 'p3', 'keeps failing'),
      { runId: 'run_f1', participantId: 'p3', reason: 'keeps failing' },
    );
    const wo = fusionWorkOrder('wo_v9', { sha256: '9'.repeat(64) });
    const runWo = fusionRun({ fusion: { workOrders: [wo] } });
    assert.deepEqual(approveWorkOrderPayload(runWo, wo), {
      runId: 'run_f1', versionId: 'wo_v9', sha256: '9'.repeat(64),
    });
    assert.equal(approveWorkOrderPayload(fusionRun(), null), null);
  });

  test('canContinue skips solo input gates for a fusion predecessor', () => {
    const v = cardView({
      approvals: { requirements: null, plan: null, design: null },
      runs: [{ id: 'run_f1', status: 'cancelled', mode: 'fusion', reserved: false, pending: 0 }],
      currentRunId: 'run_f1',
    });
    const g = canContinue(v, fusionRun({ status: 'cancelled' }));
    assert.equal(g.ok, true, g.reason);
    // a solo predecessor under revoked approvals is still refused
    const v2 = cardView({
      approvals: { requirements: null, plan: null, design: null },
      runs: [{ id: 'run_s', status: 'cancelled', mode: 'solo', reserved: false }],
      currentRunId: 'run_s',
    });
    assert.equal(canContinue(v2, runRecord({ id: 'run_s', status: 'cancelled' })).ok, false);
  });

  test('fusionStartPayload — document run: task pinned, panelists carry full profiles', () => {
    const p = fusionStartPayload({
      resultKind: 'document',
      panelists: [
        { id: 'p1', label: 'A', model: 'zen-relay/muse-spark-1.3-contributor-free' },
        { id: 'p2', label: 'B', model: 'zen-relay/deepseek-v4-flash-free' },
      ],
      judgeModel: 'anymodel/cc/claude-opus-5-5',
      task: { kind: 'requirements', versionId: 'dv_req1', sha256: SHA },
      limits: { maxAttemptsPerParticipant: 2, timeoutMin: 45 },
    });
    assert.equal(p.mode, 'fusion');
    const f = p.fusion;
    assert.equal(f.resultKind, 'document');
    assert.equal(f.panelists.length, 2);
    assert.equal(f.panelists[0].profile.provider, 'zen-relay');
    assert.equal(f.panelists[0].profile.model, 'zen-relay/muse-spark-1.3-contributor-free');
    assert.equal(f.panelists[0].profile.search.enabled, false);
    assert.ok(Array.isArray(f.panelists[0].profile.tools) && f.panelists[0].profile.tools.length > 0);
    assert.equal(f.panelists[1].profile.provider, 'zen-relay');
    assert.equal(f.judge.profile.provider, 'anymodel');
    assert.deepEqual(f.task, { kind: 'requirements', versionId: 'dv_req1', sha256: SHA });
    assert.equal('integrator' in f, false, 'document runs must not carry integrator');
    assert.equal('review' in f, false, 'document runs must not carry review');
    assert.equal(f.limits.maxAttemptsPerParticipant, 2);
  });

  test('fusionStartPayload — implementation run carries judge+integrator+review', () => {
    const p = fusionStartPayload({
      resultKind: 'implementation',
      panelists: [
        { model: 'zen-relay/muse' },
        { model: 'zen-relay/flash' },
      ],
      judgeModel: 'anymodel/cc/claude-opus-5-5',
      integratorModel: 'anymodel/cx/gpt-6-astra',
      review: {
        reviewer: { cli: 'pi', model: 'zen-relay/muse' },
        checker: { cli: 'pi', model: 'zen-relay/flash' },
      },
    });
    const f = p.fusion;
    assert.equal(f.judge.profile.model, 'anymodel/cc/claude-opus-5-5');
    assert.equal(f.integrator.profile.provider, 'anymodel');
    assert.equal(f.review.reviewer.cli, 'pi');
    assert.equal(f.review.checker.model, 'zen-relay/flash');
    assert.equal('task' in f, false, 'impl defaults to approved requirements');
  });

  test('fusionDraftProblems mirrors the spec refusals', () => {
    const v = cardView({ features: { fusion: true } });
    // document needs a task binding
    const doc = { resultKind: 'document', panelists: [{ model: 'zen-relay/a' }, { model: 'zen-relay/b' }], task: null };
    assert.ok(fusionDraftProblems(v, doc).some((s) => /task/i.test(s)));
    // fewer than two distinct models
    const same = { resultKind: 'document', panelists: [{ model: 'zen-relay/a' }, { model: 'zen-relay/a' }], task: { kind: 'requirements', versionId: 'dv_req1', sha256: SHA } };
    assert.ok(fusionDraftProblems(v, same).some((s) => /different models/i.test(s)));
    // implementation without the full handoff set
    const impl = { resultKind: 'implementation', panelists: [{ model: 'zen-relay/a' }, { model: 'zen-relay/b' }] };
    const probs = fusionDraftProblems(v, impl);
    assert.ok(probs.some((s) => /judge/i.test(s)) && probs.some((s) => /integrator/i.test(s)));
    // a live run blocks a fresh start
    const busy = cardView({
      features: { fusion: true },
      runs: [{ id: 'run_live', status: 'active', reserved: true }],
    });
    const okDraft = { ...same, panelists: [{ model: 'zen-relay/a' }, { model: 'zen-relay/b' }] };
    assert.ok(fusionDraftProblems(busy, okDraft).some((s) => /still live/i.test(s)));
    // feature gate off
    const off = cardView({ features: { fusion: false } });
    assert.equal(canStartFusion(off, okDraft).ok, false);
    assert.match(canStartFusion(off, okDraft).reason, /not enabled/i);
  });

  test('labels are informative', () => {
    assert.equal(participantStatusLabel('awaiting_decision'), 'needs your decision');
    assert.equal(fusionStatusLabel('decision_pending'), 'awaiting your decision');
  });
});

describe('fusion SSR render — card drawer + workflow', () => {
  beforeEach(async () => {
    installFetchRouter({ doc: { name: 'board.json', rev: 1, updatedAt: 1, data: { version: 2, cards: [] } }, missing: false, putGate: null });
    await __resetWebKvForTests();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    setActivePinia(createPinia());
  });
  afterEach(async () => {
    releaseExec();
    await __resetWebKvForTests();
  });

  test('ExecutionPanel renders fusion composition, participants, pending decision + retry/exclude controls', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'cf1', title: 'fusion card', execution: managedMarker() })];

    const st = exec.stateFor('cf1');
    st.phase = 'ready';
    st.view = cardView({
      cardId: 'cf1',
      features: { start: true, validation: true, fusion: true },
      currentRunId: 'run_f1',
      runs: [{ id: 'run_f1', status: 'blocked', mode: 'fusion', reserved: false, pending: 1 }],
    });
    st.selectedRunId = 'run_f1';
    st.run = fusionRun({ cardId: 'cf1' });

    const html = await renderToString(createSSRApp(CardDrawer, { cardId: 'cf1' }));
    assert.ok(html.includes('exec-fusion'), 'fusion block renders when the gate is on');
    assert.ok(html.includes('fusion-actions'), 'required-action banner renders');
    assert.ok(html.includes('fusion-participant-p1'), 'participant rows render');
    assert.ok(html.includes('Panelist 3'));
    assert.ok(html.includes('fusion-retry-p3'), 'retry control renders');
    assert.ok(html.includes('fusion-exclude-p3'), 'exclude control renders');
    assert.ok(html.includes('anymodel/cc/claude-opus-5-5'), 'judge role renders');
    assert.ok(html.includes('decision'), 'panel state text renders');
    assert.ok(html.includes('fusion · '), 'run line marks the mode');
  });

  test('ExecutionPanel hides the fusion surface when the gate is off', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'cf2', title: 'gated card', execution: managedMarker() })];
    const st = exec.stateFor('cf2');
    st.phase = 'ready';
    st.view = cardView({ cardId: 'cf2', features: { start: true, validation: true, fusion: false } });
    const html = await renderToString(createSSRApp(CardDrawer, { cardId: 'cf2' }));
    assert.ok(!html.includes('exec-fusion'), 'fusion block hidden when the gate is off');
  });

  test('WorkflowPanel renders the focused fusion summary + pending action controls beside porch', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const WorkflowPanel = (await import('../src/components/WorkflowPanel.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'wff1', title: 'fusion card', execution: managedMarker() })];

    const st = exec.stateFor('wff1');
    st.phase = 'ready';
    st.view = cardView({
      cardId: 'wff1',
      features: { fusion: true },
      currentRunId: 'run_f1',
      runs: [{ id: 'run_f1', status: 'blocked', mode: 'fusion', reserved: false, pending: 1 }],
    });
    st.selectedRunId = 'run_f1';
    st.run = fusionRun({ cardId: 'wff1' });
    exec.focused = { cardId: 'wff1', runId: 'run_f1' };
    exec.managedIndex = [{
      cardId: 'wff1', controlRevision: 9, currentRunId: 'run_f1', managed: true,
      currentRun: { id: 'run_f1', status: 'blocked', mode: 'fusion', pending: 1 },
    }];
    const wf = useWorkflowStore();
    wf.porchUp = false;

    const html = await renderToString(createSSRApp(WorkflowPanel));
    assert.ok(html.includes('managed-fusion'), 'fusion summary renders');
    assert.ok(html.includes('managed-fusion-participants'), 'participant roll-up renders');
    assert.ok(html.includes('managed-action-participant_decision'), 'pending action renders');
    assert.ok(html.includes('managed-retry-p3'), 'retry control renders');
    assert.ok(html.includes('managed-pending-wff1'), 'index badge renders');
    assert.ok(html.includes('Porch endpoint unreachable'), 'porch section untouched');
  });
});

// ---------------------------------------------------------------------------
// 7. Real state-service handler — a listener-free user flow through the REAL
//    ExecClient request engine into the REAL service router. Fixtures are not
//    hand-maintained: version ids / sha256 / approval records / the projection
//    all come back from the handlers. No HTTP listener, no runtime launch.
// ---------------------------------------------------------------------------

const { createStateService } = await import('../server/execution/state-service.mjs');

describe('real state-service handler — user flow contract', () => {
  const cleanup = [];
  afterEach(async () => {
    releaseExec();
    setExecutionClient(null);
    installFetchRouter({ doc: { name: 'board.json', rev: 1, updatedAt: 1, data: { version: 2, cards: [] } }, missing: false, putGate: null });
    while (cleanup.length) {
      const d = cleanup.pop();
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  /** ExecClient → service.request adapter: the real req() pipeline (envelope
   * verbatim, body bounding, status mapping) over the real router. */
  function handlerFetch(svc) {
    return async (url, init = {}) => {
      const u = new URL(String(url));
      const res = await svc.request({
        method: init.method ?? 'GET',
        path: u.pathname,
        query: u.searchParams,
        bodyText: init.body,
        headers: init.headers ?? {},
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.json, // the service's ok() returns {status, json}
      };
    };
  }

  const svcReq = (svc, method, path, body) => {
    const u = new URL(path, 'http://svc');
    return svc.request({
      method,
      path: u.pathname,
      query: u.searchParams,
      bodyText: body === undefined ? undefined : JSON.stringify(body),
      headers: {},
    });
  };

  async function mkSvcEnv() {
    const root = join(tmpdir(), `u6svc-${randomUUID().slice(0, 8)}`);
    cleanup.push(root);
    const stateDir = join(root, 'state');
    const projectDir = join(root, 'proj');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    execFileSync('git', ['init', '-q', projectDir], { timeout: 15000 });
    const env = {
      PORCH_STEER_DIR: join(root, 'steer'),
      ACP_WORKSPACE_DIR: join(root, 'ws'),
      ROOT_DIR: root,
    };
    if (typeof process.getuid === 'function') env.ACP_EXEC_TOKEN_UID = String(process.getuid());
    if (typeof process.getgid === 'function') env.ACP_EXEC_TOKEN_GID = String(process.getgid());
    const svc = await createStateService({ stateDir, env });
    return { svc, projectDir };
  }

  test('production store over the real handler: watchCard+sendCommand for enable/docs/preset; direct stale envelope → 409; store converges', async () => {
    const { exec } = freshPinia();
    const { svc, projectDir } = await mkSvcEnv();
    const cardId = 'u6card';

    // Seed the real docs a deployment would have — through the real PUT path.
    let r = await svcReq(svc, 'PUT', '/api/state/projects.json', {
      data: { projects: [{ id: 'p1', name: 'demo', path: projectDir }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await svcReq(svc, 'PUT', '/api/state/board.json', {
      data: {
        version: 2,
        cards: [{
          id: cardId, title: 'managed me', project: 'demo', stage: 'spec',
          status: 'in_progress', statusByStage: {}, blocked: false,
          blockedReason: '', cancelled: false, description: '', links: [],
          session: null, order: 10, createdAt: 1, updatedAt: 1,
          agent: '', priority: 'medium', acceptance: '', verification: '',
          touches: [], dependsOn: [], blocks: [], conflictsWith: [],
        }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    // The REAL client drives the REAL handler; the store's every read/write
    // (card view, board sync, presets) goes through it or the real service.
    const client = new ExecClient({ baseUrl: 'http://svc', fetchFn: handlerFetch(svc) });
    setExecutionClient(client);
    installFetchRouter({ svc });

    const st = () => exec.stateFor(cardId);
    const settle = async () => { if (st().cardInflight) await st().cardInflight; };

    // --- watch + fresh read prove the card is NOT managed yet ---------------
    exec.watchCard(cardId);
    await settle();
    assert.equal(st().phase, 'unmanaged');

    // --- enable via the production command path ------------------------------
    let r2 = await exec.sendCommand(cardId, 'enable', {});
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.result.managed, true);
    await settle();
    assert.equal(st().phase, 'ready');
    assert.equal(st().view.managed, true);

    // --- requirements through sendCommand (store supplies the CAS rev) -------
    r2 = await exec.sendCommand(cardId, 'attach_document', {
      kind: 'requirements',
      source: { type: 'text', text: '# Requirements\n\n- build the thing\n' },
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const reqV = r2.result.attached;
    assert.ok(reqV.versionId && /^[0-9a-f]{64}$/.test(reqV.sha256));
    r2 = await exec.sendCommand(cardId, 'approve_requirements', {
      versionId: reqV.versionId, sha256: reqV.sha256,
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.result.approval.versionId, reqV.versionId);
    await settle();

    // --- plan (checks arrive inside the document fence) ----------------------
    r2 = await exec.sendCommand(cardId, 'attach_document', {
      kind: 'plan',
      source: {
        type: 'text',
        text:
          '# Plan\n\n```acp-checks\n' +
          '{"checks":[{"run":"npm test","cwd":".","timeoutSec":90,"setup":false}]}\n```\n',
      },
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const planV = r2.result.attached;
    assert.deepEqual(r2.result.requirementsBound, { versionId: reqV.versionId, sha256: reqV.sha256 });
    r2 = await exec.sendCommand(cardId, 'approve_plan', {
      versionId: planV.versionId, sha256: planV.sha256,
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.result.approval.checksSource, 'document_block');
    assert.equal(r2.result.approval.requirementsSha256, reqV.sha256);
    await settle();

    // --- composition through the production path ------------------------------
    const member = { cli: 'pi', model: 'zen-relay/muse-spark-1.3-contributor-free' };
    r2 = await exec.sendCommand(cardId, 'save_preset', {
      preset: {
        id: 'u6preset',
        name: 'solo',
        members: { implementer: { ...member }, reviewer: { ...member }, checker: { ...member } },
        limits: { maxAttemptsPerRole: 1, timeoutMin: 60, maxReviewRounds: 3 },
      },
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.result.composition.preset.id, 'u6preset');
    await settle();

    // --- the store-adopted view must satisfy the UI gate ----------------------
    const g = canStart(st().view);
    assert.equal(g.ok, true, g.reason);
    // projection is server-computed vocabulary, not a frontend guess
    assert.deepEqual(st().view.projection, { stage: 'plan', status: 'done' });
    assert.equal(st().view.approvals.plan.versionId, planV.versionId);
    assert.equal(st().view.documents.requirements.current, reqV.versionId);
    assert.equal(st().view.documents.plan.current, planV.versionId);

    // --- registry through the store's own loader ------------------------------
    await exec.loadPresets();
    assert.ok(exec.presets.some((p) => p.id === 'u6preset'));
    assert.ok(exec.compatibility && 'pi' in exec.compatibility);

    // --- input change invalidates BOTH approvals (store adopts server truth) --
    r2 = await exec.sendCommand(cardId, 'attach_document', {
      kind: 'requirements',
      source: { type: 'text', text: '# Requirements v2\n\n- changed scope\n' },
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const reqV2 = r2.result.attached;
    await settle();
    assert.equal(st().view.approvals.requirements, null);
    assert.equal(st().view.approvals.plan, null);
    assert.equal(canStart(st().view).ok, false);

    // --- an intentionally STALE envelope sent directly — proves the client
    // classifies a real 409 revision_conflict (the store would never send
    // one: sendCommand refreshes first and always ships the live rev) ------
    const staleRev = st().view.controlRevision;
    await assert.rejects(
      client.sendCommand(cardId, {
        commandId: `uc_${randomUUID().slice(0, 12)}`,
        type: 'approve_requirements',
        payload: { versionId: reqV2.versionId, sha256: reqV2.sha256 },
        expectedControlRevision: staleRev - 1,
      }),
      (e) => e instanceof ExecApiError && e.status === 409 && e.code === 'revision_conflict',
    );

    // --- production retry: fresh read → live revision → lands; the store's
    // authoritative refresh adopts it ---------------------------------------
    r2 = await exec.sendCommand(cardId, 'approve_requirements', {
      versionId: reqV2.versionId, sha256: reqV2.sha256,
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    await settle();
    assert.ok(st().view.controlRevision > staleRev);
    assert.equal(st().view.approvals.requirements.versionId, reqV2.versionId);
    assert.equal(st().commandError, null);
  });
});

// ---------------------------------------------------------------------------
// 6c. Orchestrator + swarm surface — gates/payloads on the durable
//     run.orchestrator / run.swarm records (backend-ui-contract §§4–7),
//     plus SSR render of editors + run detail. The backend for these modes
//     does not exist yet server-side: every gate test pins the
//     server-controlled `features` flag behavior (absent = refused, never
//     a frontend-only execution).
// ---------------------------------------------------------------------------

const {
  isOrchestrator, orchestrator: orchState, orchTasks, orchTask,
  orchPendingActions, orchTaskStatusLabel, orchPhaseLabel,
  orchPendingActionText, canOrchApprove, canOrchAnswer, canOrchGrant,
  canOrchRetry, orchApprovePayload, orchAnswerPayload, orchGrantPayload,
  orchRetryPayload, orchDraftProblems, canStartOrchestrator, orchStartPayload,
  isSwarm, swarm: swarmState, swarmParticipants, swarmMessages,
  swarmDecisions, swarmPendingActions, swarmPhaseLabel, swarmStatusLabel,
  swarmFrozen, swarmPendingActionText, canSwarmInput, canSwarmExtend,
  canSwarmDecide, swarmInputPayload, swarmExtendPayload, swarmDecidePayload,
  swarmDraftProblems, canStartSwarm, swarmStartPayload, startableModes,
} = await import('../src/lib/execution/ui-model.ts');

function orchRun(over = {}) {
  const oz = {
    spec: {
      version: 1, sha256: SHA, status: 'pending', approvedAt: null,
      by: null, artifactId: 'art_spec',
    },
    phase: 'approval',
    tasks: [
      {
        taskId: 'st-1', title: 'scaffold', status: 'accepted',
        deps: [], profile: 'default', boundary: ['src/a/**'],
        inputCommit: 'c'.repeat(40), snapshotOf: [],
        attempts: [{ id: 'att_1', n: 1, kind: 'work', status: 'completed', resultCommit: 'c'.repeat(40) }],
        resultCommit: 'c'.repeat(40), resultSha256: SHA,
        evidence: { verifyArtifactId: 'art_ver', verdict: 'accept', findingsArtifactId: null },
        waiting: null, budget: { used: 1, limit: 3 },
      },
      {
        taskId: 'st-2', title: 'wire up', status: 'waiting',
        deps: ['st-1'], profile: 'default', boundary: ['src/b/**'],
        inputCommit: 'c'.repeat(40), snapshotOf: ['st-1'],
        attempts: [{ id: 'att_2', n: 1, kind: 'work', status: 'completed' }],
        resultCommit: null, resultSha256: null, evidence: null,
        waiting: { reason: 'question', question: 'which store?', since: now() - 1000 },
        budget: { used: 1, limit: 3 },
      },
      {
        taskId: 'st-3', title: 'broken', status: 'failed',
        deps: [], profile: 'default', boundary: ['src/c/**'],
        inputCommit: 'c'.repeat(40), snapshotOf: [],
        attempts: [
          { id: 'att_3', n: 1, kind: 'work', status: 'failed', error: 'boom' },
          { id: 'att_4', n: 2, kind: 'fix', status: 'failed', error: 'boom again' },
          { id: 'att_5', n: 3, kind: 'fix', status: 'failed', error: 'boom x3' },
        ],
        resultCommit: null, resultSha256: null, evidence: null,
        waiting: null, budget: { used: 3, limit: 3 },
      },
    ],
    integrate: null,
    pendingActions: [
      { type: 'spec_approval', specSha256: SHA },
      { type: 'question', taskId: 'st-2', question: 'which store?' },
      { type: 'grant', taskId: 'st-3', reason: 'attempts_exhausted' },
    ],
    stats: { tasks: 3, accepted: 1, running: 0, failed: 1 },
    owner: { runnerId: 'r1', instanceId: null },
    ...(over.orchestrator ?? {}),
  };
  // Model the actual HTTP task rows, including references into run.attempts.
  const attempts = [];
  oz.graph ??= { status: 'approval_pending', pendingApproval: null };
  oz.tasks = oz.tasks.map((t) => {
    if (t.state) return t;
    attempts.push(...(t.attempts ?? []));
    return {
      id: t.taskId, title: t.title, dependsOn: t.deps ?? [], boundary: t.boundary,
      worker: { profileId: t.profile ?? 'default' },
      limits: { maxAttempts: t.budget?.limit ?? 3, maxFixCycles: 3 },
      state: {
        status: t.status, attemptsUsed: t.budget?.used ?? 0, fixesUsed: 0,
        extraAttempts: 0, extraFixes: 0,
        attempts: (t.attempts ?? []).map((a) => a.id),
        inputCommit: t.inputCommit, snapshotOf: t.snapshotOf,
        resultCommit: t.resultCommit, resultSha256: t.resultSha256,
        evidence: t.evidence ? { verdictArtifactId: t.evidence.verifyArtifactId, verdict: t.evidence.verdict } : null,
        waiting: t.waiting,
      },
    };
  });
  return {
    id: 'run_o1',
    cardId: 'card_1',
    mode: 'orchestrator',
    status: 'active',
    phase: 'work',
    createdAt: now() - 30_000,
    finishedAt: null,
    inputs: {
      requirements: { versionId: 'dv_req1', sha256: SHA },
      plan: { versionId: 'dv_plan1', sha256: SHA2, requirementsVersionId: 'dv_req1', checks: [] },
      design: null,
    },
    composition: null,
    baseRef: 'main',
    baseCommit: 'a'.repeat(64),
    workspaceId: null,
    attempts,
    result: null,
    acceptance: { resultSha256: SHA, round: 1, at: now() - 1000 },
    events: [],
    eventsCursor: 0,
    ...over,
    orchestrator: oz,
  };
}

function swarmRun(over = {}) {
  const sw = {
    phase: 'implement',
    round: 2,
    participants: [
      {
        participantId: 'p1', callsign: 'A', profileId: 'zen-relay/m-a',
        status: 'active', ownedPaths: ['src/a/**'],
        attempt: { id: 'att_p1', status: 'running', porchRunId: 'porch_1' },
        budget: { turnsUsed: 3, turnsLimit: 8 },
        waiting: null, cursor: { lastSeenSeq: 41 },
      },
      {
        participantId: 'p2', callsign: 'B', profileId: 'zen-relay/m-b',
        status: 'exhausted', ownedPaths: ['src/b/**'],
        attempt: null,
        budget: { turnsUsed: 8, turnsLimit: 8 },
        waiting: { reason: 'turn', detail: 'turns_exhausted' },
        cursor: { lastSeenSeq: 40 },
      },
    ],
    ownership: [
      { path: 'src/a/**', owner: 'p1', since: now() - 9000, contested: false },
      { path: 'src/shared/**', owner: 'p1', since: now() - 8000, contested: true },
    ],
    decisions: [
      {
        id: 'd1', kind: 'contested', proposer: 'p1', paths: ['src/shared/**'],
        status: 'pending', at: now() - 5000, rationale: 'shared helper lives here',
      },
      { id: 'd0', kind: 'apply', proposer: 'p2', paths: ['src/b/**'], status: 'approved', at: now() - 9000 },
    ],
    messages: [
      { id: 'm1', seq: 1, from: 'p1', to: 'all', kind: 'proposal', text: 'i take shared', at: now() - 7000 },
      { id: 'm2', seq: 2, from: 'broker', to: 'user', kind: 'notice', text: 'd1 escalated', at: now() - 6000 },
    ],
    freeze: { active: false, reason: null, since: null },
    findings: [{ id: 'f1', owner: 'p1', text: 'racy helper', severity: 'major', status: 'open' }],
    limits: { turnsUsed: 11, turnsLimit: 16, round: 2, maxRounds: 4, messagesUsed: 2, maxMessages: 200 },
    pendingActions: [
      { type: 'decision', decisionId: 'd1' },
      { type: 'extend', participantId: 'p2', reason: 'turns_exhausted' },
    ],
    owner: { runnerId: 'r1', instanceId: 'i1' },
    ...(over.swarm ?? {}),
  };
  return {
    id: 'run_s1',
    cardId: 'card_1',
    mode: 'swarm',
    status: 'active',
    phase: 'implement',
    createdAt: now() - 30_000,
    finishedAt: null,
    inputs: {
      requirements: { versionId: 'dv_req1', sha256: SHA },
      plan: { versionId: 'dv_plan1', sha256: SHA2, requirementsVersionId: 'dv_req1', checks: [] },
      design: null,
    },
    composition: null,
    baseRef: 'main',
    baseCommit: 'a'.repeat(64),
    workspaceId: null,
    attempts: [],
    result: null,
    acceptance: null,
    events: [],
    eventsCursor: 0,
    ...over,
    swarm: sw,
  };
}

describe('orchestrator ui-model gates + payloads', () => {
  test('isOrchestrator requires mode + slice; labels are verbatim', () => {
    assert.equal(isOrchestrator(orchRun()), true);
    assert.equal(isOrchestrator(swarmRun()), false);
    assert.equal(isOrchestrator(null), false);
    assert.equal(orchTaskStatusLabel('waiting'), 'waiting on you');
    assert.equal(orchPhaseLabel('approval'), 'awaiting spec approval');
    assert.equal(orchTasks(orchRun()).length, 3);
    assert.equal(orchTask(orchRun(), 'st-2').title, 'wire up');
    assert.equal(orchPendingActions(orchRun()).length, 3);
    assert.match(orchPendingActionText({ type: 'spec_approval', specSha256: SHA }), /awaits your approval/);
    assert.match(orchPendingActionText({ type: 'question', taskId: 'st-2', question: 'which store?' }), /st-2.*which store/);
    assert.match(orchPendingActionText({ type: 'grant', taskId: 'st-3' }), /exhausted/);
  });

  test('canOrchApprove binds the pending spec sha; stale spec refused', () => {
    const r = orchRun();
    assert.equal(canOrchApprove(r).ok, true);
    assert.equal(canOrchApprove(r, SHA).ok, true);
    assert.equal(canOrchApprove(r, SHA2).ok, false, 'a stale sha never approves');
    const done = orchRun({ orchestrator: { spec: { version: 1, sha256: SHA, status: 'approved' }, pendingActions: [] } });
    assert.equal(canOrchApprove(done).ok, false, 'no pending action → nothing to approve');
    const term = orchRun({ status: 'failed' });
    assert.equal(canOrchApprove(term).ok, false, 'terminal run takes no decisions');
  });

  test('answer/grant/retry address waiting/failed tasks only', () => {
    const r = orchRun();
    assert.equal(canOrchAnswer(r, 'st-2').ok, true, 'waiting-on-question is answerable');
    assert.equal(canOrchAnswer(r, 'st-1').ok, false, 'an accepted task is not answerable');
    assert.equal(canOrchAnswer(r, 'st-x').ok, false, 'unknown task refused');
    assert.equal(canOrchGrant(r, 'st-3').ok, true, 'exhausted failed task takes a grant');
    assert.equal(canOrchGrant(r, 'st-1').ok, false, 'accepted task takes no grant');
    assert.equal(canOrchRetry(r, 'st-3').ok, false, 'budget exhausted → grant first, not retry');
    const retryable = orchRun({
      orchestrator: {
        tasks: [{ taskId: 'st-9', title: 'flaky', status: 'failed', deps: [], attempts: [], budget: { used: 1, limit: 3 } }],
        pendingActions: [],
      },
    });
    assert.equal(canOrchRetry(retryable, 'st-9').ok, true);
    assert.deepEqual(orchRetryPayload(retryable, 'st-9'), { runId: 'run_o1', taskId: 'st-9' });
    assert.deepEqual(orchGrantPayload(retryable, 'st-9', 2), { runId: 'run_o1', taskId: 'st-9', attempts: 2 });
    assert.deepEqual(orchAnswerPayload(retryable, 'st-9', 'pg'), { runId: 'run_o1', taskId: 'st-9', answer: 'pg' });
    assert.deepEqual(orchApprovePayload(retryable, SHA), { runId: 'run_o1', specSha256: SHA });
  });

  test('orchestrator start composition: flag-gated, shape-checked, payload exact', () => {
    const draft = {
      decomposer: 'zen-relay/d', verifier: 'zen-relay/v', integrator: 'zen-relay/i',
      workers: [{ name: 'default', profileId: 'zen-relay/w' }],
      limits: { taskAttempts: 3, maxIntegratorAttempts: 2, maxSubtasks: 16, requireSpecApproval: true },
      baseRef: 'main',
    };
    const off = cardView({ features: {} });
    assert.equal(canStartOrchestrator(off, draft).ok, false);
    assert.match(canStartOrchestrator(off, draft).reason, /not enabled/);
    const on = cardView({ features: { orchestrator: true } });
    assert.equal(canStartOrchestrator(on, draft).ok, true, 'flag on + valid draft starts');
    assert.ok(orchDraftProblems(on, { ...draft, decomposer: '' }).some((s) => /decomposer/i.test(s)));
    assert.ok(orchDraftProblems(on, { ...draft, workers: [] }).some((s) => /worker pool/i.test(s)));
    assert.ok(orchDraftProblems(on, {
      ...draft, workers: [{ name: 'd', profileId: 'x' }, { name: 'd', profileId: 'y' }],
    }).some((s) => /duplicate/i.test(s)));
    const p = orchStartPayload(draft);
    assert.equal(p.mode, 'orchestrator');
    assert.equal(p.orchestrator.workers.default.profile.model, 'zen-relay/w');
    assert.equal(p.orchestrator.decomposer.profile.model, 'zen-relay/d');
    assert.equal(p.baseRef, 'main');
  });

  test('startableModes: server flags open orchestrator/swarm; absent stays shut', () => {
    assert.deepEqual(startableModes(cardView({ features: {} })), ['solo', 'fusion']);
    assert.deepEqual(
      startableModes(cardView({ features: { orchestrator: true, swarm: true } })),
      ['solo', 'fusion', 'orchestrator', 'swarm'],
    );
  });
});

describe('swarm ui-model gates + payloads', () => {
  test('isSwarm requires mode + slice; freeze is explicit', () => {
    assert.equal(isSwarm(swarmRun()), true);
    assert.equal(isSwarm(orchRun()), false);
    assert.equal(swarmParticipants(swarmRun()).length, 2);
    assert.equal(swarmMessages(swarmRun())[0].id, 'm1', 'messages sort by seq');
    assert.equal(swarmDecisions(swarmRun()).length, 2);
    assert.equal(swarmPhaseLabel('implement'), 'implementing');
    assert.equal(swarmStatusLabel('exhausted'), 'turns exhausted');
    assert.equal(swarmFrozen(swarmRun()).frozen, false);
    const frozen = swarmRun({ swarm: { phase: 'verify', freeze: { active: true, reason: 'verify' } } });
    assert.equal(swarmFrozen(frozen).frozen, true);
    assert.match(swarmFrozen(frozen).reason, /verify/);
    assert.match(swarmPendingActionText({ type: 'decision', decisionId: 'd1' }, swarmRun()), /contested/);
    assert.match(swarmPendingActionText({ type: 'extend', participantId: 'p2' }, swarmRun()), /exhausted/);
  });

  test('input refused while frozen; extend/decide need escalation', () => {
    const r = swarmRun();
    assert.equal(canSwarmInput(r, 'p1', 'go').ok, true);
    assert.equal(canSwarmInput(r, 'all', 'go team').ok, true);
    assert.equal(canSwarmInput(r, 'px', 'go').ok, false, 'unknown participant refused');
    assert.equal(canSwarmInput(r, 'p1', '  ').ok, false, 'empty steer refused');
    const frozen = swarmRun({ swarm: { phase: 'review', freeze: { active: true, reason: 'review' } } });
    assert.equal(canSwarmInput(frozen, 'p1', 'go').ok, false, 'frozen runs refuse input');
    assert.equal(canSwarmExtend(r, 'p2').ok, true, 'exhausted participant takes an extension');
    assert.equal(canSwarmExtend(r, 'p1').ok, false, 'an active participant takes no extension');
    assert.equal(canSwarmExtend(r, 'px').ok, false, 'unknown participant refused');
    assert.equal(canSwarmDecide(r, 'd1').ok, true, 'escalated pending decision settles');
    assert.equal(canSwarmDecide(r, 'd0').ok, false, 'an approved decision never re-settles');
    assert.equal(canSwarmDecide(r, 'dx').ok, false, 'unknown decision refused');
    assert.deepEqual(swarmInputPayload(r, 'p1', 'go'), { runId: 'run_s1', participantId: 'p1', text: 'go' });
    assert.deepEqual(swarmInputPayload(r, 'all', 'go'), { runId: 'run_s1', participantId: 'all', text: 'go' });
    assert.deepEqual(swarmExtendPayload(r, 4, 'p2'), { runId: 'run_s1', turns: 4, participantId: 'p2' });
    assert.deepEqual(
      swarmDecidePayload(r, 'd1', 'approve', 'lgtm'),
      { runId: 'run_s1', decisionId: 'd1', outcome: 'approve', note: 'lgtm' },
    );
  });

  test('swarm start composition: 2..3 participants, flag-gated, payload exact', () => {
    const draft = {
      participants: [
        { participantId: 'p1', callsign: 'A', profileId: 'zen-relay/a', ownedPaths: 'src/a/**' },
        { participantId: 'p2', callsign: 'B', profileId: 'zen-relay/b', ownedPaths: 'src/b/**' },
      ],
      limits: { maxTurnsPerParticipant: 8, maxRounds: 4, maxMessages: 200, verifyRequired: true },
      baseRef: '',
    };
    const off = cardView({ features: {} });
    assert.equal(canStartSwarm(off, draft).ok, false);
    assert.match(canStartSwarm(off, draft).reason, /not enabled/);
    const on = cardView({ features: { swarm: true } });
    assert.equal(canStartSwarm(on, draft).ok, true);
    assert.ok(swarmDraftProblems(on, { participants: [draft.participants[0]] }).some((s) => /at least 2/i.test(s)));
    assert.ok(swarmDraftProblems(on, {
      participants: [...draft.participants, { participantId: 'p3', callsign: 'C', profileId: 'z', ownedPaths: 'x' },
        { participantId: 'p4', callsign: 'D', profileId: 'z', ownedPaths: 'x' }],
    }).some((s) => /at most 3/i.test(s)));
    assert.ok(swarmDraftProblems(on, {
      participants: [{ ...draft.participants[0], ownedPaths: '  ' }, draft.participants[1]],
    }).some((s) => /owned paths/i.test(s)));
    const p = swarmStartPayload(draft);
    assert.equal(p.mode, 'swarm');
    assert.equal(p.swarm.participants.length, 2);
    assert.deepEqual(p.swarm.participants[0].ownedPaths, ['src/a/**']);
    assert.equal(p.swarm.limits.maxRounds, 4);
  });
});

describe('orchestrator/swarm SSR render — drawer editors + run detail', () => {
  beforeEach(async () => {
    installFetchRouter({ doc: { name: 'board.json', rev: 1, updatedAt: 1, data: { version: 2, cards: [] } }, missing: false, putGate: null });
    await __resetWebKvForTests();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    setActivePinia(createPinia());
  });
  afterEach(async () => {
    releaseExec();
    await __resetWebKvForTests();
  });

  test('orchestrator editor renders only behind the flag; hidden otherwise', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'co1', title: 'orch card', execution: managedMarker() })];
    const st = exec.stateFor('co1');
    st.phase = 'ready';
    st.view = cardView({ cardId: 'co1', features: { start: true, orchestrator: true } });
    let html = await renderToString(createSSRApp(CardDrawer, { cardId: 'co1' }));
    assert.ok(html.includes('exec-orchestrator'), 'orchestrator block renders when the gate is on');
    assert.ok(html.includes('orch-configure'), 'configure affordance renders');
    assert.ok(!html.includes('exec-swarm'), 'swarm block stays hidden without its flag');
    releaseExec();
    setActivePinia(createPinia());
    setExecutionClient(new FakeExec());
    const exec2 = useExecutionStore();
    const board2 = useBoardStore();
    board2.cards = [mkCard({ id: 'co2', title: 'gated card', execution: managedMarker() })];
    const st2 = exec2.stateFor('co2');
    st2.phase = 'ready';
    st2.view = cardView({ cardId: 'co2', features: {} });
    html = await renderToString(createSSRApp(CardDrawer, { cardId: 'co2' }));
    assert.ok(!html.includes('exec-orchestrator'), 'orchestrator block hidden when the gate is off');
    assert.ok(!html.includes('orch-configure'), 'no configure affordance when gated off');
  });

  test('orchestrator run detail renders spec, tasks, attempts, hash, pending actions + controls', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'co3', title: 'orch run card', execution: managedMarker() })];
    const st = exec.stateFor('co3');
    st.phase = 'ready';
    st.view = cardView({
      cardId: 'co3',
      features: { start: true, orchestrator: true },
      currentRunId: 'run_o1',
      runs: [{ id: 'run_o1', status: 'active', mode: 'orchestrator', reserved: false, pending: 3 }],
    });
    st.selectedRunId = 'run_o1';
    st.run = orchRun({ cardId: 'co3' });
    st.run.orchestrator.graph.pendingApproval = {proposalId:'ip1',kind:'amend',fields:['plan']};
    st.run.orchestrator.pendingActions.push({type:'decision',proposalId:'ip1',kind:'amend',fields:['plan']});
    const html = await renderToString(createSSRApp(CardDrawer, { cardId: 'co3' }));
    assert.ok(html.includes('orch-actions'), 'required-action banner renders');
    assert.ok(html.includes('orch-pending-spec_approval'), 'spec approval pending renders');
    assert.ok(html.includes('orch-approve-spec'), 'approve control renders');
    assert.ok(html.includes('orch-task-st-1'), 'accepted task renders');
    assert.ok(html.includes('orch-task-st-2'), 'waiting task renders');
    assert.ok(html.includes('orch-waiting-st-2'), 'waiting reason renders');
    assert.ok(html.includes('orch-answer-send-st-2'), 'answer control renders');
    assert.ok(html.includes('orch-grant-st-3'), 'grant control renders');
    assert.ok(html.includes('orch-decide-approve-ip1'), 'input-change approval renders');
    assert.ok(html.includes('orch-decide-reject-ip1'), 'input-change rejection renders');
    assert.ok(html.includes('input change ip1'), 'proposal is identified for review');
    assert.ok(!html.includes('orch-retry-st-3'), 'budget-exhausted task shows grant, not retry');
    assert.ok(html.includes('orch-attempt-att_3'), 'task attempts render');
    assert.ok(html.includes('orch-result-st-1'), 'accepted result commit + hash render');
    assert.ok(html.includes('orch-acceptance'), 'acceptance hash renders');
    assert.ok(html.includes('orchestrator · '), 'run line marks the mode');
  });

  test('candidate awaiting verifier budget renders an enabled grant while still verifying', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    useBoardStore().cards = [mkCard({ id: 'co-verify', title: 'verifier budget', execution: managedMarker() })];
    const st = exec.stateFor('co-verify');
    st.phase = 'ready';
    st.view = cardView({cardId:'co-verify',features:{start:true,orchestrator:true},currentRunId:'run_o1',runs:[{id:'run_o1',status:'active',mode:'orchestrator'}]});
    st.selectedRunId = 'run_o1';
    st.run = orchRun({cardId:'co-verify',orchestrator:{graph:{status:'active',pendingApproval:null},pendingActions:[{type:'grant',taskId:'st-3',reason:'verify_attempts_exhausted'}]}});
    const task = st.run.orchestrator.tasks.find(t => t.id === 'st-3');
    task.state.status = 'verifying';
    task.state.verifyUsed = 2;
    task.state.resultCandidate = {commit:SHA,attemptId:'worker-1'};
    assert.equal(canOrchGrant(st.run,'st-3').ok,true);
    const html = await renderToString(createSSRApp(CardDrawer,{cardId:'co-verify'}));
    const button = html.match(/<button[^>]*data-testid="orch-grant-st-3"[^>]*>/)?.[0];
    assert.ok(button,'pending verifier grant must be actionable from the real panel');
    assert.ok(!button.includes('disabled'),'valid pending grant is enabled');
    assert.ok(!html.includes('orch-retry-st-3'),'imported candidate must not be queued as new worker');
  });

  test('orchestrator commands POST the exact user-channel envelope via the store', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView({ features: { orchestrator: true } }));
    const posted = [];
    client.on('sendCommand', (id, env) => {
      posted.push(env);
      return { ok: true, cardId: id, controlRevision: 8, result: {} };
    });
    exec.watchCard('card_1');
    await sleep(0);
    const r = await exec.sendCommand('card_1', 'orch_retry', { runId: 'run_o1', taskId: 'st-9' });
    assert.equal(r.ok, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'orch_retry');
    assert.equal(posted[0].expectedControlRevision, 7, 'CAS revision from the fresh read');
    assert.deepEqual(posted[0].payload, { runId: 'run_o1', taskId: 'st-9' });
    exec.unwatchCard('card_1');
  });

  test('swarm editor renders only behind the flag; run detail shows claims/messages/decisions/limits', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'cs1', title: 'swarm card', execution: managedMarker() })];
    const st = exec.stateFor('cs1');
    st.phase = 'ready';
    st.view = cardView({
      cardId: 'cs1',
      features: { start: true, swarm: true },
      currentRunId: 'run_s1',
      runs: [{ id: 'run_s1', status: 'active', mode: 'swarm', reserved: false, pending: 2 }],
    });
    st.selectedRunId = 'run_s1';
    st.run = swarmRun({ cardId: 'cs1' });
    const html = await renderToString(createSSRApp(CardDrawer, { cardId: 'cs1' }));
    assert.ok(html.includes('exec-swarm'), 'swarm block renders when the gate is on');
    assert.ok(html.includes('swarm-actions'), 'required-action banner renders');
    assert.ok(html.includes('swarm-pending-decision'), 'decision pending renders');
    assert.ok(html.includes('swarm-participant-p1'), 'participant claims render');
    assert.ok(html.includes('swarm-limits'), 'limits line renders');
    assert.ok(html.includes('swarm-ownership'), 'ownership claims render');
    assert.ok(html.includes('swarm-decision-d1'), 'contested decision renders');
    assert.ok(html.includes('swarm-decide-approve-d1'), 'approve control renders');
    assert.ok(html.includes('swarm-decide-reject-d1'), 'reject control renders');
    assert.ok(html.includes('swarm-msg-m1'), 'message bus renders');
    assert.ok(html.includes('swarm-broadcast'), 'broadcast affordance renders');
    assert.ok(html.includes('swarm-extend-btn-p2'), 'extend control renders on the exhausted participant');
    assert.ok(html.includes('swarm · '), 'run line marks the mode');
  });

  test('swarm commands POST the exact user-channel envelope via the store', async () => {
    const { exec, client } = freshPinia();
    client.on('getCard', () => cardView({ features: { swarm: true } }));
    const posted = [];
    client.on('sendCommand', (id, env) => {
      posted.push(env);
      return { ok: true, cardId: id, controlRevision: 8, result: {} };
    });
    exec.watchCard('card_1');
    await sleep(0);
    const r = await exec.sendCommand('card_1', 'swarm_decide', { runId: 'run_s1', decisionId: 'd1', outcome: 'approve' });
    assert.equal(r.ok, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'swarm_decide');
    assert.equal(posted[0].expectedControlRevision, 7, 'CAS revision from the fresh read');
    exec.unwatchCard('card_1');
  });

  test('frozen swarm shows the freeze banner and refuses input client-side', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const exec = useExecutionStore();
    setExecutionClient(new FakeExec());
    const CardDrawer = (await import('../src/features/board/CardDrawer.vue')).default;
    const board = useBoardStore();
    board.cards = [mkCard({ id: 'cs2', title: 'frozen swarm', execution: managedMarker() })];
    const st = exec.stateFor('cs2');
    st.phase = 'ready';
    st.view = cardView({
      cardId: 'cs2',
      features: { swarm: true },
      currentRunId: 'run_s1',
      runs: [{ id: 'run_s1', status: 'active', mode: 'swarm', reserved: false }],
    });
    st.selectedRunId = 'run_s1';
    st.run = swarmRun({ cardId: 'cs2', swarm: { phase: 'verify', freeze: { active: true, reason: 'verify' } } });
    const html = await renderToString(createSSRApp(CardDrawer, { cardId: 'cs2' }));
    assert.ok(html.includes('swarm-freeze'), 'freeze banner renders with the reason');
  });
});


describe('execution modes published backend contract regression', () => {
  test('orchestrator and swarm starts carry full validated inline profiles', async () => {
    const { validateAgentProfile } = await import('../server/execution/environment/agent-profile.mjs');
    const draft = { decomposer: 'zen-relay/d', verifier: 'zen-relay/v', integrator: 'zen-relay/i',
      workers: [{name:'default', profileId:'zen-relay/w'}], limits: {taskAttempts:4} };
    const p = orchStartPayload(draft);
    for (const entry of [p.orchestrator.decomposer, p.orchestrator.verifier,
      p.orchestrator.integrator, p.orchestrator.workers.default]) {
      assert.equal(validateAgentProfile(entry.profile).provider, 'zen-relay');
    }
    assert.equal(p.orchestrator.limits.taskAttempts, 4);
    assert.ok(p.orchestrator.workers.default.profile.tools.includes('edit'));
    assert.deepEqual(p.orchestrator.decomposer.profile.tools, ['read','bash','grep','find','ls']);
    assert.deepEqual(p.orchestrator.verifier.profile.tools, ['read','bash','grep','find','ls']);
    const sw = swarmStartPayload({participants:[
      {participantId:'p1',callsign:'A',profileId:'zen-relay/a',ownedPaths:'src/a/**'},
      {participantId:'p2',callsign:'B',profileId:'zen-relay/b',ownedPaths:'src/b/**'},
    ]});
    for (const row of sw.swarm.participants) {
      assert.equal(validateAgentProfile(row.profile).provider, 'zen-relay');
      assert.ok(row.profile.tools.includes('write'));
      assert.equal(row.profileId, undefined);
    }
  });

  test('durable nested tasks retain identity, real attempts, evidence and unblock gates', () => {
    const r = orchRun({ attempts:[{id:'att_real',n:1,role:'worker',kind:'work',status:'failed',error:'boom'}],
      orchestrator:{graph:{status:'active',pendingApproval:null},tasks:[
        {id:'st-q',title:'question',dependsOn:['st-a'],worker:{profileId:'default'},limits:{maxAttempts:2,maxFixCycles:1},
          state:{status:'waiting',attemptsUsed:1,extraAttempts:0,fixesUsed:0,extraFixes:0,
            attempts:['att_real'],waiting:{reason:'question',question:'which store?'},
            evidence:{verdict:'return',verdictArtifactId:'art_real'}}},
        {id:'st-blocked',title:'exhausted',dependsOn:[],worker:{profileId:'default'},limits:{maxAttempts:1,maxFixCycles:1},
          state:{status:'blocked',attemptsUsed:1,attempts:[],waiting:{reason:'grant'}}},
      ],pendingActions:[{type:'question',taskId:'st-q',question:'which store?'},{type:'grant',taskId:'st-blocked'}]}});
    const t = orchTask(r,'st-q');
    assert.equal(t.status,'waiting');
    assert.deepEqual(t.deps,['st-a']);
    assert.equal(t.attempts[0].id,'att_real');
    assert.equal(t.evidence.verifyArtifactId,'art_real');
    assert.equal(canOrchAnswer(r,'st-q').ok,true);
    assert.equal(canOrchGrant(r,'st-blocked').ok,true);
    assert.equal(canOrchRetry(r,'st-blocked').ok,false);
    assert.deepEqual(orchGrantPayload(r,'st-blocked',1,2),{runId:r.id,taskId:'st-blocked',attempts:1,fixCycles:2});
  });

  test('input-change proposals have an exact user decision command', async () => {
    const {canOrchDecide,orchDecidePayload} = await import('../src/lib/execution/ui-model.ts');
    const r = orchRun({orchestrator:{graph:{status:'approval_pending',pendingApproval:{proposalId:'ip1',kind:'amend',fields:['plan']}},
      pendingActions:[{type:'decision',proposalId:'ip1',kind:'amend',fields:['plan']}]}});
    assert.equal(canOrchDecide(r,'ip1').ok,true);
    assert.equal(canOrchApprove(r).ok,false);
    assert.deepEqual(orchDecidePayload(r,'ip1','reject'),{runId:r.id,proposalId:'ip1',decision:'reject'});
    assert.equal(canOrchDecide(r,'old').ok,false);
    assert.ok((await import('../src/lib/execution/api.ts')).USER_COMMAND_TYPES.includes('orch_decide'));
  });
});
