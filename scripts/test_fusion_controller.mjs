// scripts/test_fusion_controller.mjs — deterministic F2 fusion-panel tests.
//   node --test scripts/test_fusion_controller.mjs
//
// Everything runs through createStateService's real request/queue path plus
// createInternalClient against the real routed internal surface, exactly like
// the U4/U5 selftests. The panelist runtime is a deterministic fake of the F1
// constrained container-runtime interface (start/status/wait/cancel/
// launchRecord/reconcile/processIdentity) — with scripted crash windows
// between the durable attempt write and the launch handshake. NOTHING opens
// a listener, touches compose, or uses the live state dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createFakeRuntime } from '../server/execution/fake-runtime.mjs';
import { createManagedScheduler } from '../server/execution/managed-scheduler.mjs';
import { createInternalClient } from '../server/execution/internal-transport.mjs';
import { createCapabilityStore } from '../server/execution/environment/capability-store.mjs';
import { profileDigest } from '../server/execution/environment/agent-profile.mjs';
import { buildPanelPrompt, panelMaterials, sha256Hex } from '../server/execution/fusion/prompt.mjs';
import { canonicalJson } from '../server/execution/environment/agent-profile.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures ---------------------------------------------------------------

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

async function mkProject() {
  const dir = join(tmpdir(), `f2-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
const myGid = typeof process.getgid === 'function' ? process.getgid() : null;

async function mkEnv({ faults, features = { start: true, fusion: true, validation: true }, envExtra = {} } = {}) {
  const root = join(tmpdir(), `f2-state-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const stateDir = join(root, 'state');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
  const capDir = join(root, 'capability');
  const svc = await createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer'),
      ACP_WORKSPACE_DIR: join(root, 'wsroot'),
      ROOT_DIR: root,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
      ...envExtra,
    },
    faults,
    features,
  });
  return { root, stateDir, projectDir, svc, capDir };
}

async function req(svc, method, path, body, headers) {
  const q = new URL(path, 'http://t');
  return svc.request({
    method, path: q.pathname, query: q.searchParams,
    bodyText: body === undefined ? undefined : J(body), headers,
  });
}
const putDoc = (svc, name, data, rev) => req(svc, 'PUT', `/api/state/${name}`, { data, rev });
const cmd = (svc, cardId, body) => req(svc, 'POST', `/api/execution/cards/${cardId}/commands`, body);
const getCard = (svc, id) => req(svc, 'GET', `/api/execution/cards/${id}`);
const getRun = (svc, id) => req(svc, 'GET', `/api/execution/runs/${id}`);
const getEvents = (svc, id) => req(svc, 'GET', `/api/execution/runs/${id}/events`);

function mkClient(svc, stateDir, sw = null) {
  return createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      if (sw?.down) {
        return Promise.reject(new Error('connect ECONNREFUSED — simulated outage'));
      }
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : JSON.stringify(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
}

// ---- the deterministic fake of the F1 container runtime ----------------------
//
// Mirrors createContainerRuntime's client-facing surface the panel driver uses:
//   start / launchRecord / status / wait / events / cancel / reconcile.
// `behaviors` match by attemptId substring: 'p2' covers 'pa-...-p2-n1'.
//   { preLaunchFail: '<code>' }            — start returns launch_failed
//   { dropStart: true }                    — NOTHING recorded (crash between
//                                            panel_begin and runtime.start)
//   { lostBind: true }                     — record 'launched'+runId written,
//                                            but the driver never sees it
//   { runMs: n }                           — ms until the run goes terminal
//   { runStatus: 'completed'|'failed' }    — terminal status (default completed)
//   { finalText }                          — the panelist's final text
//   { hang: true }                         — never goes terminal on its own;
//                                            _finish() resolves it manually
//   { cancelMs: n }                        — ms until a cancel request kills
//   { transientStartFails: n }             — first n start calls return
//                                            launch_failed (retryable path)
//   { stuckLaunch: true }                  — record 'launching' lands (old
//                                            startedAt, no porchRunId) but
//                                            the handshake never completes
//   { scan: { matches, workers } }         — reconcile returns this scan
//                                            verbatim (gone-evidence shapes)

function makeAnswer(tag) {
  return [
    `## Proposal\n\nAnswer from ${tag}: do X.\n`,
    `## Rationale\n\nBecause Y for ${tag}.\n`,
    `## Affected files\n\n- src/${tag}.js\n`,
    `## Downsides\n\nCost ${tag}.\n`,
    `## Excluded actions\n\nNo z ${tag}.\n`,
  ].join('\n');
}

function createFakeContainerRuntime({ behaviors = {}, registry = null } = {}) {
  const calls = [];
  const records = new Map(); // attemptId -> launch record
  const runs = new Map();    // runId -> run state
  const transientFails = new Map(); // attemptId -> remaining transient fails
  let seq = 0;

  const behaviorOf = (attemptId) => {
    if (behaviors[attemptId]) return behaviors[attemptId];
    for (const [k, v] of Object.entries(behaviors)) {
      if (k !== 'default' && k.length && attemptId.includes(k)) return v;
    }
    return behaviors.default ?? {};
  };
  const finish = (run, { status = 'completed', exitCode = 0, runExitCode = 0, finalText = null } = {}) => {
    run.status = status;
    run.terminal = true;
    run.exitCode = exitCode;
    run.runExitCode = runExitCode;
    run.finalText = finalText ?? run.behavior.finalText ?? null;
    run.finishedAt = new Date().toISOString();
  };

  async function start(params = {}) {
    const { attemptId } = params;
    calls.push({ m: 'start', params });
    const b = behaviorOf(attemptId);
    if (b.dropStart) {
      // The durable attempt row exists; the launch never reached the
      // controller — no record at all (reconcile must re-issue the start).
      return {
        ok: false, phase: 'launch_uncertain', attemptId,
        error: { code: 'controller_lost', message: 'simulated launch-path crash' },
        porchRunId: null,
      };
    }
    if (b.preLaunchFail) {
      const rec = {
        phase: 'launch_failed', attemptId, porchRunId: null,
        error: { code: b.preLaunchFail, message: `prelaunch ${b.preLaunchFail}` },
        launch: { startedAt: new Date().toISOString() },
      };
      records.set(attemptId, rec);
      return { ok: false, phase: 'launch_failed', attemptId, error: rec.error, porchRunId: null };
    }
    if (b.stuckLaunch) {
      // The launch record lands at phase 'launching' — then the driver dies
      // before the porch handshake. The record is already past the orphan
      // age bound, so reconcile()'s worker evidence decides the attempt.
      if (!records.has(attemptId)) {
        const at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        records.set(attemptId, {
          phase: 'launching', attemptId, porchRunId: null,
          launch: { startedAt: at }, createdAt: at,
          worker: { workerId: `w-${attemptId}` },
        });
      }
      return {
        ok: false, phase: 'launch_uncertain', attemptId,
        error: { code: 'handshake_lost', message: 'worker never confirmed the launch' },
        porchRunId: null,
      };
    }
    if (records.has(attemptId)) {
      throw new Error(`attempt record dir already exists: ${attemptId}`);
    }
    const left = transientFails.get(attemptId) ?? b.transientStartFails ?? 0;
    if (left > 0) {
      transientFails.set(attemptId, left - 1);
      const rec = {
        phase: 'launch_failed', attemptId, porchRunId: null,
        error: { code: 'spawn_error', message: 'transient spawn failure' },
        launch: { startedAt: new Date().toISOString() },
      };
      records.set(attemptId, rec);
      return { ok: false, phase: 'launch_failed', attemptId, error: rec.error, porchRunId: null };
    }
    const runId = `run_p${++seq}`;
    const rec = {
      phase: 'launched', attemptId, porchRunId: runId,
      launch: { startedAt: new Date().toISOString() },
      worker: { workerId: `w-${attemptId}` },
    };
    records.set(attemptId, rec);
    const run = {
      runId, attemptId, workerId: `w-${attemptId}`,
      status: 'running', terminal: false, exitCode: null, runExitCode: null,
      finalText: null, behavior: b, startedAt: new Date().toISOString(),
    };
    runs.set(runId, run);
    if (!b.hang) {
      const delay = b.runMs ?? 5;
      setTimeout(() => {
        if (!run.terminal) {
          finish(run, {
            status: b.runStatus ?? 'completed',
            exitCode: b.exitCode ?? 0,
            runExitCode: b.runExitCode ?? b.exitCode ?? 0,
          });
        }
      }, delay).unref?.();
    }
    if (b.lostBind) {
      // Crash AFTER the record landed, BEFORE the driver saw the run id —
      // the reconcile path must recover the binding from durable evidence.
      return {
        ok: false, phase: 'launch_uncertain', attemptId,
        error: { code: 'response_lost', message: 'driver lost the handshake response' },
        porchRunId: null,
      };
    }
    return {
      ok: true, phase: 'launched', attemptId,
      attemptDir: `/fake/attempt/${attemptId}`, workerId: run.workerId,
      artifactsDir: `/work/attempt/run-${attemptId}`,
      porchRunId: runId, error: null, recordPersisted: true,
    };
  }

  async function launchRecord(attemptId) {
    calls.push({ m: 'launchRecord', attemptId });
    const rec = records.get(attemptId);
    if (rec === undefined) return { attemptId, missing: true, corrupt: false };
    return { attemptId, missing: false, corrupt: false, record: structuredClone(rec) };
  }

  const runFor = (runId) => runs.get(runId) ?? null;
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

  async function status(runId) {
    calls.push({ m: 'status', runId });
    const run = runFor(runId);
    if (!run) return { runId, ok: false, error: { code: 'unknown_run', message: 'no run' } };
    return {
      ok: true, runId, status: run.status, terminal: TERMINAL.has(run.status),
      exitCode: run.exitCode, error: run.error ?? null,
      workerId: run.workerId, attemptId: run.attemptId,
      startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
    };
  }

  async function events(runId, { cursor = 0 } = {}) {
    calls.push({ m: 'events', runId });
    const run = runFor(runId);
    if (!run) return { runId, ok: false, error: { code: 'unknown_run', message: 'no run' } };
    return {
      ok: true, runId, status: run.status, terminal: run.terminal,
      events: [], cursor, nextCursor: cursor, remaining: 0,
    };
  }

  async function wait(runId) {
    calls.push({ m: 'wait', runId });
    const run = runFor(runId);
    if (!run) {
      return { runId, ok: false, outcome: 'error', error: { code: 'unknown_run', message: 'no run' } };
    }
    if (!run.terminal) {
      return { ok: true, outcome: 'timeout', runId, timedOut: true, terminal: false, status: run.status };
    }
    return {
      ok: true, outcome: 'terminal', runId, timedOut: false, terminal: true,
      status: run.status, exitCode: run.exitCode, runExitCode: run.runExitCode,
      error: run.error ?? null, finalText: run.finalText,
      finalAvailable: run.finalText !== null,
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      artifactsDir: `/work/attempt/run-${run.attemptId}`, cwd: '/work/project',
    };
  }

  async function cancel(runId) {
    calls.push({ m: 'cancel', runId });
    const run = runFor(runId);
    if (!run) {
      return { runId, requested: false, error: { code: 'unknown_run', message: 'no run' } };
    }
    const b = run.behavior;
    setTimeout(() => {
      if (!run.terminal) finish(run, { status: 'cancelled', exitCode: 130, runExitCode: 130 });
    }, b.cancelMs ?? 2).unref?.();
    return { ok: true, runId, requested: true, workerId: run.workerId };
  }

  async function reconcile(match = {}) {
    calls.push({ m: 'reconcile', match });
    // Model the worker registry: a launch record with a porchRunId and a
    // live run reports a match; missing record reports worker 'gone'.
    const attemptId = match.attemptId;
    const b = attemptId ? behaviorOf(attemptId) : {};
    if (b.scan) {
      // Scripted scan evidence — drives the consumer's allGone orphan gate
      // with incomplete/non-boolean `gone` rows.
      return {
        ok: true, scannedAt: new Date().toISOString(),
        matches: b.scan.matches ?? [], workers: b.scan.workers ?? [],
      };
    }
    const rec = attemptId ? records.get(attemptId) : null;
    if (!attemptId || !rec) {
      return {
        ok: true, scannedAt: new Date().toISOString(), matches: [],
        workers: [{ workerId: `w-${attemptId}`, state: 'gone', gone: true }],
      };
    }
    const run = rec.porchRunId ? runs.get(rec.porchRunId) : null;
    return {
      ok: true, scannedAt: new Date().toISOString(),
      matches: run ? [{ runId: run.runId, workerId: run.workerId, status: run.status, terminal: run.terminal }] : [],
      workers: [{ workerId: `w-${attemptId}`, state: run ? 'running' : 'gone', gone: !run }],
    };
  }

  function processIdentity(pid) {
    const rec = registry?.procs?.get(pid);
    if (rec && rec.exists) {
      return { pid, exists: true, state: rec.state ?? 'R', starttime: rec.starttime ?? null, pidNs: 'ns-f2', readable: true };
    }
    if (rec && !rec.exists) {
      return { pid, exists: false, state: 'X', starttime: rec.starttime ?? null, pidNs: 'ns-f2', readable: true };
    }
    return { pid, exists: false, state: null, starttime: null, pidNs: 'ns-f2', readable: true };
  }

  return {
    start, launchRecord, status, events, wait, cancel, reconcile, processIdentity,
    _calls: calls, _records: records, _runs: runs,
    _finish: (runId, o) => { const r = runs.get(runId); if (r) finish(r, o); },
    _runIds: () => [...runs.keys()],
  };
}

// ---- scheduler + env helpers --------------------------------------------------

let pidSeq = 70000;
function mkSched(env, {
  registry, behaviors, instanceId = `inst-${randomUUID().slice(0, 8)}`,
  runnerId = 'host-runner', capabilityStore, now, fusionOnlyRuntime = null,
} = {}) {
  const instPid = ++pidSeq;
  const procRuntime = createFakeRuntime({
    registry,
    rootDir: join(env.root, 'fake-exec'),
    environment: { pid: instPid, pidStarttime: `st-${instPid}`, pidNs: 'ns-f2' },
    behaviors: { default: {} },
  });
  if (registry) {
    registry.procs.set(instPid, {
      exists: true, state: 'R', starttime: `st-${instPid}`, readable: true,
    });
  }
  const contRuntime = fusionOnlyRuntime ?? createFakeContainerRuntime({ behaviors });
  const sched = createManagedScheduler({
    client: mkClient(env.svc, env.stateDir),
    runtime: procRuntime,
    runnerId, instanceId,
    stateDir: env.stateDir,
    env: { ACP_WORKSPACE_DIR: join(env.root, 'wsroot'), ROOT_DIR: env.root },
    now,
    fusion: { runtime: contRuntime, capabilityStore },
  });
  return { sched, runtime: contRuntime, procRuntime, instanceId, instPid };
}

function boardWith(cards) { return { version: 2, cards }; }
function cardFixture(id, projectDir, over = {}) {
  return { id, title: id, stage: 'spec', status: 'in_progress', project: 'proj-x', order: 10, ...over };
}
async function seedBase(svc, projectDir, cards = [cardFixture('card-a')]) {
  await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  return putDoc(svc, 'board.json', boardWith(cards));
}
async function enable(svc, cardId = 'card-a', commandId = `en-${randomUUID().slice(0, 6)}`) {
  const r = await cmd(svc, cardId, { commandId, type: 'enable' });
  assert.equal(r.status, 200, J(r.json));
}
async function attachDoc(svc, cardId, kind, text, extra = {}) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `at-${randomUUID().slice(0, 6)}`, type: 'attach_document',
    expectedControlRevision: c.json.controlRevision,
    payload: { kind, source: { type: 'text', text }, ...extra },
  });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result; // {versionId, sha256}
}
async function approve(svc, cardId, type, { versionId, sha256 }) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `ap-${randomUUID().slice(0, 6)}`, type,
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId, sha256 },
  });
  assert.equal(r.status, 200, J(r.json));
}

function fusionProfile(model, over = {}) {
  return {
    schemaVersion: 1,
    profileId: `prof-${model}`,
    pi: { version: '0.85.1' },
    image: 'worker',
    provider: 'zen-relay',
    model,
    thinking: 'low',
    skills: [],
    extensions: [],
    tools: ['read', 'bash'],
    search: { enabled: false, provider: null, params: {} },
    launch: { progress: 'none', extraFlags: [] },
    systemPromptFile: null,
    ...over,
  };
}

async function mkPanelists(...profiles) {
  return profiles.map((profile, i) => ({
    id: `p${i + 1}`, label: `Panelist ${i + 1}`, profile,
  }));
}

async function startFusion(svc, cardId, { task, panelists, search = false, resultKind = 'document', maxAttempts = 2, timeoutMin = 45, baseRef } = {}) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c.json.controlRevision,
    payload: {
      mode: 'fusion',
      ...(baseRef ? { baseRef } : {}),
      fusion: {
        resultKind,
        task,
        panelists,
        search: { enabled: search },
        limits: { maxAttemptsPerParticipant: maxAttempts, timeoutMin },
      },
    },
  });
  return r;
}
async function mustStartFusion(...a) {
  const r = await startFusion(...a);
  assert.equal(r.status, 200, J(r.json));
  return r.json.result.runId;
}

async function runView(svc, runId) {
  const r = await getRun(svc, runId);
  assert.equal(r.status, 200, J(r.json));
  return r.json;
}
const eventsOf = async (svc, runId) => {
  const r = await getEvents(svc, runId);
  assert.equal(r.status, 200, J(r.json));
  return r.json.events;
};
const participants = (run) => run.fusion?.participants ?? [];
const part = (run, id) => participants(run).find((p) => p.id === id);
const startsCalls = (rt) => rt._calls.filter((c) => c.m === 'start');
const waitFake = () => sleep(15);

// Drive the panel to a quiescent point: ticks while the run reports
// progress, bounded.
async function driveUntil(svc, sched, runId, pred, { maxTicks = 30 } = {}) {
  let run = await runView(svc, runId);
  for (let i = 0; i < maxTicks && !pred(run); i += 1) {
    await sched.tick();
    await waitFake();
    run = await runView(svc, runId);
  }
  return run;
}

// ==========================================================================
// 1. Panel start: snapshot persisted, spec validation
// ==========================================================================

test('start: fusion run persists panel snapshot; spec validation rejects bad panels', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task text here\n');
  const p = await mkPanelists(fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));

  // --- spec validation FIRST (a queued live run would block later starts) ---
  const same = await mkPanelists(fusionProfile('model-a'), fusionProfile('model-a'));
  let r = await startFusion(svc, 'card-a', { task: reqDoc, panelists: same });
  assert.equal(r.status, 422, 'single-model panel must be refused');
  assert.equal(r.json.code, 'panel_incompatible');

  const one = await mkPanelists(fusionProfile('model-a'));
  r = await startFusion(svc, 'card-a', { task: reqDoc, panelists: one });
  assert.equal(r.status, 422, 'a one-member panel must be refused');
  assert.equal(r.json.code, 'panel_invalid');

  // stale control revision — the "stale approval" guard for starts
  const c0 = await getCard(svc, 'card-a');
  r = await cmd(svc, 'card-a', {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c0.json.controlRevision - 1,
    payload: { mode: 'fusion', fusion: { resultKind: 'document', task: reqDoc, panelists: p } },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'revision_conflict');

  // missing task binding for document kind
  r = await startFusion(svc, 'card-a', { task: undefined, panelists: p });
  assert.equal(r.status, 422);

  // Now the real start.
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });

  const run = await runView(svc, runId);
  assert.equal(run.mode, 'fusion');
  assert.equal(run.status, 'queued');
  assert.equal(run.phase, 'panel');
  assert.equal(run.fusion.resultKind, 'document');
  assert.equal(run.fusion.snapshot.task.sha256, reqDoc.sha256);
  assert.equal(run.fusion.snapshot.project.snapshotSha, run.baseCommit);
  assert.equal(run.fusion.participants.length, 3);
  assert.ok(run.fusion.fingerprint);
  assert.deepEqual(new Set(run.fusion.participants.map((x) => x.model)),
    new Set(['model-a', 'model-b', 'model-c']));
  assert.ok(run.fusion.participants.every((x) => x.profileDigest && x.profile));
});

// ==========================================================================
// 2. Happy path: parallel independent launch, identical inputs, valid answers
// ==========================================================================

test('panel: parallel independent launch — identical task+project+prompt, all answer, quorum settles complete', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# The task\n');
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });
  const { sched, runtime } = mkSched(env, { behaviors: {
    default: { runMs: 5, finalText: makeAnswer('x') },
  } });

  // Tick 1: claim. Tick 2: gate + 3x panel_begin + parallel start.
  let t1 = await sched.tick();
  let run = await runView(svc, runId);
  assert.ok(run.fusion.owner, 'panel_claim must record the owner');
  t1 = await sched.tick();
  run = await runView(svc, runId);
  assert.equal(startsCalls(runtime).length, 3, 'three panelists launched');
  assert.equal(run.attempts.length, 3);

  // Identical inputs: every start got the SAME prompt bytes + materials.
  const prompts = startsCalls(runtime).map((c) => c.params.prompt);
  const mats = startsCalls(runtime).map((c) => c.params.materials);
  assert.equal(new Set(prompts).size, 1, 'prompt text is byte-identical across the panel');
  assert.equal(new Set(mats.map((m) => canonicalJson(m))).size, 1,
    'materials are identical across the panel');
  assert.equal(mats[0].snapshotSha, run.baseCommit);
  assert.equal(mats[0].projectRoot, run.fusion.snapshot.project.projectRoot);
  // Every launch recorded the same prompt/material digests.
  const launches = run.attempts.map((a) => a.launch);
  assert.equal(new Set(launches.map((l) => l.promptSha256)).size, 1);
  assert.equal(new Set(launches.map((l) => l.materialsSha256)).size, 1);
  // And the digests match the actual prompt/material bytes.
  const expectedPrompt = buildPanelPrompt({
    taskText: '# The task\n',
    snapshotSha: run.baseCommit,
    projectRoot: run.fusion.snapshot.project.projectRoot,
    resultKind: 'document',
  });
  assert.equal(prompts[0], expectedPrompt, 'driver prompt equals the pure builder output');
  assert.equal(launches[0].promptSha256, sha256Hex(expectedPrompt));
  const expectedMats = panelMaterials({
    projectRoot: run.fusion.snapshot.project.projectRoot,
    snapshotSha: run.baseCommit,
    taskText: '# The task\n',
  });
  assert.equal(launches[0].materialsSha256, sha256Hex(canonicalJson(expectedMats)));
  // Distinct model identities + distinct profile digests.
  assert.deepEqual(new Set(run.attempts.map((a) => a.launch.profileDigest)).size, 3);

  // Drive to completion — all three answer with valid sections.
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && r.fusion?.settledAt);
  assert.equal(run.status, 'blocked');
  assert.equal(run.fusion.status, 'complete');
  assert.equal(run.fusion.judgeEligible, true);
  assert.equal(participants(run).every((x) => x.status === 'answered'), true);
  assert.equal(new Set(participants(run).map((x) => x.answer.model)).size, 3);
  assert.deepEqual(run.fusion.exclusions, []);
  // Panel-settled event recorded with the judge-facing model set.
  const evs = await eventsOf(svc, runId);
  const settle = evs.find((e) => e.type === 'panel_settled');
  assert.ok(settle, 'panel_settled event recorded');
  assert.deepEqual(new Set(settle.data.models), new Set(['model-a', 'model-b', 'model-c']));
});

// ==========================================================================
// 3. Answer contract: exit-0 without full sections is NOT a result
// ==========================================================================

test('answer contract: a completed run with an incomplete answer is failed work', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });
  // p2's agent "asks a question" — exit 0 but no structured answer.
  const { sched } = mkSched(env, { behaviors: {
    'p2': { runMs: 5, finalText: 'What do you want me to do about X? Please clarify.\n' },
    default: { runMs: 5, finalText: makeAnswer('ok') },
  } });

  await sched.tick(); // claim
  await sched.tick(); // launch all three
  await waitFake();
  let run = await driveUntil(svc, sched, runId, (r) =>
    part(r, 'p2')?.status === 'awaiting_decision');
  run = await runView(svc, runId);

  // The bad-answer participant consumed BOTH attempts (each resolves
  // 'failed' with answer_invalid) and parked — the others are answered and
  // the run is still active (executable work existed until settle).
  assert.equal(part(run, 'p2').status, 'awaiting_decision');
  assert.equal(part(run, 'p2').attemptsUsed, 2);
  assert.equal(part(run, 'p2').lastError.outcome, 'failed');
  assert.match(part(run, 'p2').lastError.reason, /answer_invalid/);
  assert.equal(part(run, 'p1').status, 'answered');
  assert.equal(part(run, 'p3').status, 'answered');
  // No automatic third attempt: exactly two attempts for p2 forever.
  const p2Atts = (run.attempts || []).filter((a) => a.participantId === 'p2');
  assert.equal(p2Atts.length, 2);
  // And a repeated drive never mints a third.
  await sched.tick();
  run = await runView(svc, runId);
  assert.equal((run.attempts || []).filter((a) => a.participantId === 'p2').length, 2);
  // Run is blocked with the durable pending decision exposed.
  assert.equal(run.status, 'blocked');
  assert.equal(run.fusion.status, 'decision_pending');
  assert.deepEqual(run.fusion.pendingActions.map((x) => x.participantId), ['p2']);
});

// ==========================================================================
// 4. Partial failure: retry / exclude; successful answers preserved
// ==========================================================================

test('partial failure: answers survive a failed participant; exclusion keeps quorum, run completes', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });
  const { sched } = mkSched(env, { behaviors: {
    'p2': { runMs: 5, runStatus: 'failed', exitCode: 7 },
    default: { runMs: 5, finalText: makeAnswer('ok') },
  } });

  await sched.tick(); await sched.tick();
  let run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && part(r, 'p2')?.status === 'awaiting_decision');
  assert.equal(run.status, 'blocked');
  assert.equal(run.fusion.status, 'decision_pending');
  assert.equal(part(run, 'p1').status, 'answered');
  assert.equal(part(run, 'p3').status, 'answered');
  assert.equal(part(run, 'p2').status, 'awaiting_decision');
  assert.equal(part(run, 'p2').attemptsUsed, 2);
  // The successful answers are durable artifacts, not just statuses.
  for (const id of ['p1', 'p3']) {
    const a = part(run, id).answer;
    assert.ok(a.artifactId && a.sha256 && a.sections?.proposal);
    assert.equal(run.artifacts[a.artifactId].sha256, a.sha256);
  }

  // Excluding p2: model-a + model-c remain — quorum survives.
  const card = await getCard(svc, 'card-a');
  const r = await cmd(svc, 'card-a', {
    commandId: `ex-${randomUUID().slice(0, 6)}`, type: 'exclude_panelist',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, participantId: 'p2', reason: 'kept failing', by: 'user' },
  });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(part(run, 'p2').status, 'excluded');
  assert.equal(run.fusion.exclusions.length, 1);
  assert.equal(run.fusion.exclusions[0].participantId, 'p2');
  // The run settled on the spot: two distinct answered models → complete.
  assert.equal(run.fusion.status, 'complete');
  assert.equal(run.fusion.judgeEligible, true);
  assert.equal(run.status, 'blocked');
  assert.deepEqual(run.fusion.pendingActions, []);
  // Exclusion is recorded for the judge.
  const evs = await eventsOf(svc, runId);
  const settle = evs.filter((e) => e.type === 'panel_settled').pop();
  assert.ok(settle);
  assert.deepEqual(settle.data.excluded, ['p2']);
});

test('partial failure: retry_participant reopens one extra attempt; no automatic retry', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });
  // p2 fails both attempts, then the retry succeeds.
  const p2Behavior = { runMs: 5, runStatus: 'failed', exitCode: 3 };
  const { sched, runtime } = mkSched(env, { behaviors: {
    'p2': p2Behavior,
    default: { runMs: 5, finalText: makeAnswer('ok') },
  } });
  await sched.tick(); await sched.tick();
  let run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && part(r, 'p2')?.status === 'awaiting_decision');
  assert.equal(part(run, 'p2').attemptsUsed, 2);
  assert.equal(part(run, 'p1').status, 'answered');
  // No third attempt was ever minted.
  assert.equal((run.attempts || []).filter((a) => a.participantId === 'p2').length, 2);

  // Retry the failed participant — exactly one new attempt.
  const card = await getCard(svc, 'card-a');
  const commandId = `rt-${randomUUID().slice(0, 6)}`;
  let r = await cmd(svc, 'card-a', {
    commandId, type: 'retry_participant',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, participantId: 'p2' },
  });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(part(run, 'p2').status, 'pending');
  assert.equal(run.status, 'active');

  // Repeating the same commandId replays — NO second extra attempt.
  r = await cmd(svc, 'card-a', {
    commandId, type: 'retry_participant',
    expectedControlRevision: card.json.controlRevision + 1,
    payload: { runId, participantId: 'p2' },
  });
  assert.equal(r.status, 200, J(r.json));
  assert.equal(r.json.idempotent, true);
  run = await runView(svc, runId);
  assert.equal(part(run, 'p2').attemptsUsed, 2, 'repeat commandId consumed nothing');
  assert.equal(part(run, 'p2').extraAttempts, 1, 'exactly one extra attempt granted');

  // Now make p2's third attempt succeed.
  p2Behavior.runStatus = 'completed';
  p2Behavior.exitCode = 0;
  p2Behavior.finalText = makeAnswer('p2-retry');
  run = await driveUntil(svc, sched, runId,
    (r) => r.fusion?.settledAt != null);
  assert.equal(part(run, 'p2').status, 'answered');
  assert.equal(part(run, 'p2').attemptsUsed, 3);
  assert.equal(run.fusion.status, 'complete');
  assert.equal(run.fusion.judgeEligible, true);
});

test('exclude_panelist refused when fewer than two distinct models remain', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  // Two panelists with DIFFERENT models; p1 answers, p2 fails twice.
  const p = await mkPanelists(fusionProfile('model-a'), fusionProfile('model-b'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });
  const { sched } = mkSched(env, { behaviors: {
    'p2': { runMs: 5, runStatus: 'failed', exitCode: 3 },
    default: { runMs: 5, finalText: makeAnswer('ok') },
  } });
  await sched.tick(); await sched.tick();
  let run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && part(r, 'p2')?.status === 'awaiting_decision');
  assert.equal(part(run, 'p1').status, 'answered');

  // Excluding p2 leaves ONE model — refused, quorum preserved.
  const card = await getCard(svc, 'card-a');
  const r = await cmd(svc, 'card-a', {
    commandId: `ex-${randomUUID().slice(0, 6)}`, type: 'exclude_panelist',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, participantId: 'p2' },
  });
  assert.equal(r.status, 409, J(r.json));
  assert.equal(r.json.code, 'panel_below_minimum');
  run = await runView(svc, runId);
  assert.equal(part(run, 'p2').status, 'awaiting_decision',
    'the refused exclusion changed nothing');
  assert.equal(run.fusion.status, 'decision_pending');
});

// ==========================================================================
// 5. Search gate + full-profile digest invalidation
// ==========================================================================

test('search gate: unproven digest blocks before any attempt; digest change re-probes', async () => {
  const env = await mkEnv();
  const { svc, projectDir, capDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  const searchProfile = (model, over = {}) => fusionProfile(model, {
    tools: ['read', 'bash', 'web_search'],
    search: { enabled: true, provider: 'duckduckgo', params: { maxResults: 3 } },
    ...over,
  });
  const p = await mkPanelists(searchProfile('model-a'), searchProfile('model-b'));
  const runId = await mustStartFusion(svc, 'card-a', {
    task: reqDoc, panelists: p, search: true,
  });
  const capStore = createCapabilityStore({ dir: capDir });
  const { sched, runtime } = mkSched(env, { capabilityStore: capStore, behaviors: {
    default: { runMs: 5, finalText: makeAnswer('ok') },
  } });

  await sched.tick(); // claim
  const t2 = await sched.tick(); // gate must refuse
  assert.equal(t2.gate_blocked, 1, J(t2));
  let run = await runView(svc, runId);
  assert.equal(run.status, 'failed');
  assert.equal(startsCalls(runtime).length, 0, 'no panelist ever launched');
  const evs = await eventsOf(svc, runId);
  assert.ok(evs.some((e) => e.type === 'panel_launch_blocked'
    && (e.data.code === 'search_unproven' || e.data.code === 'search_uncapable')));

  // Now record a positive probe for ONLY one digest — still refused.
  const [pa, pb] = p;
  await capStore.record({
    digest: pa.profileDigest = profileDigest(pa.profile),
    capable: true,
    probe: { ok: true, at: new Date().toISOString(), runId: 'probe-1', attemptId: 'a1', source: 'probe', evidence: 'ok' },
  });
  // Wait — pa.profileDigest wasn't stored back into the run (run snapshot
  // already made). Use the recorded digest from the run instead:
  const run0 = await runView(svc, runId);
  void run0;

  // Same-panel restart on a NEW run needs BOTH digests probed. Probe p1's
  // recorded digest + p2's recorded digest, then continue.
  const run1 = await runView(svc, runId);
  for (const part of run1.fusion.participants) {
    await capStore.record({
      digest: part.profileDigest, capable: true,
      probe: { ok: true, at: new Date().toISOString(), runId: 'probe-1', attemptId: 'a1', source: 'probe', evidence: 'ok' },
    });
  }

  // Continue → new run; both digests proven → launches happen.
  const c = await getCard(svc, 'card-a');
  const rc = await cmd(svc, 'card-a', {
    commandId: `ct-${randomUUID().slice(0, 6)}`, type: 'continue',
    expectedControlRevision: c.json.controlRevision, payload: {},
  });
  assert.equal(rc.status, 200, J(rc.json));
  const runId2 = rc.json.result.runId;
  await sched.tick(); await sched.tick();
  let run2 = await runView(svc, runId2);
  assert.equal(startsCalls(runtime).length, 2, 'both probed panelists launched');

  // Digest invalidation: same image+model, different tools → NEW digest →
  // the third panelist (added via a fresh start) is unproven again.
  const drifted = searchProfile('model-c', { tools: ['read', 'bash'] }); // tools differ -> digest differs
  const p3 = await mkPanelists(
    searchProfile('model-a'), searchProfile('model-b'), drifted);
  // First settle run2 so the card can take a new run.
  run2 = await driveUntil(svc, sched, runId2, (r) => r.fusion?.settledAt != null);
  assert.equal(run2.fusion.status, 'complete');

  const r3 = await startFusion(svc, 'card-a', { task: reqDoc, panelists: p3, search: true });
  assert.equal(r3.status, 200, J(r3.json));
  const runId3 = r3.json.result.runId;
  await sched.tick(); // claim
  const tg = await sched.tick(); // gate
  assert.equal(tg.gate_blocked, 1, J(tg));
  const run3 = await runView(svc, runId3);
  assert.equal(run3.status, 'failed');
  assert.equal(startsCalls(runtime).length, 2, 'the drifted third panelist blocked the whole launch');
});

test('search gate: search enabled requires EVERY panelist declared capable', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  // One panelist's profile doesn't declare search — rejected at START.
  const mixed = await mkPanelists(
    fusionProfile('model-a', { tools: ['read', 'bash', 'web_search'], search: { enabled: true, provider: 'ddg', params: {} } }),
    fusionProfile('model-b'), // no search declared
  );
  const r = await startFusion(svc, 'card-a', { task: reqDoc, panelists: mixed, search: true });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'panel_incompatible');
});

// ==========================================================================
// 6. Launch-handshake crash windows
// ==========================================================================

test('durable-write→launch crash windows: record-lost start reissues; lost bind reconciles to bound', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  const p = await mkPanelists(fusionProfile('model-a'), fusionProfile('model-b'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });

  // p1: record written but bind response lost. p2: nothing recorded at all
  // (the launch-path crash between panel_begin and runtime.start).
  const behaviors = {
    'p1': { lostBind: true, runMs: 400, finalText: makeAnswer('p1') },
    'p2': { dropStart: true, runMs: 5, finalText: makeAnswer('p2') },
    'p2-n2': { runMs: 5, finalText: makeAnswer('p2-n2') },
  };
  const { sched, runtime } = mkSched(env, { behaviors });
  await sched.tick(); // claim
  await sched.tick(); // begin + start: p1 lost-bind, p2 dropped entirely
  let run = await runView(svc, runId);
  // p1's attempt is still 'launching' (the bind never landed), p2's too.
  const att1 = run.attempts.find((a) => a.participantId === 'p1');
  const att2 = run.attempts.find((a) => a.participantId === 'p2');
  assert.equal(att1.status, 'launching');
  assert.equal(att2.status, 'launching');
  assert.equal(startsCalls(runtime).length, 2);

  // Drop the p2 crash so the reconcile-driven re-start can succeed.
  behaviors['p2'] = { runMs: 5, finalText: makeAnswer('p2') };

  await sched.tick(); // reconcile: p1 binds from its durable record; p2 re-starts
  run = await runView(svc, runId);
  const att1b = run.attempts.find((a) => a.id === att1.id);
  assert.equal(att1b.status, 'running', 'lost bind recovered via launch record');
  assert.equal(att1b.porchRunId, runtime._records.get(att1.id).porchRunId);
  // p2 consumed no extra attempt — the SAME n1 attempt was re-started.
  assert.equal(startsCalls(runtime).length, 3, 'p2 n1 re-issued after missing record');
  assert.equal(run.attempts.length, 2, 'still exactly two durable attempts');

  run = await driveUntil(svc, sched, runId, (r) => r.fusion?.settledAt != null);
  assert.equal(run.fusion.status, 'complete');
  assert.equal(part(run, 'p1').status, 'answered');
  assert.equal(part(run, 'p2').status, 'answered');
});

test('launch orphan gate fails closed: only explicit gone:true resolves launch_orphaned', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'),
    fusionProfile('model-c'), fusionProfile('model-d'));
  const runId = await mustStartFusion(svc, 'card-a', {
    task: reqDoc, panelists: p, maxAttempts: 1,
  });
  // Every panelist's launch record is stuck at 'launching' past the orphan
  // age bound (stuckLaunch) and reconcile() finds no registered run — the
  // only difference is the worker `gone` evidence:
  //   p1 — the row carries NO `gone` key at all
  //   p2 — gone: null (the worker status call was unreadable) beside an
  //        explicit gone:false
  //   p3 — one proven-gone worker plus a sibling with a truthy non-boolean
  //        `gone` — every() must still refuse the array
  //   p4 — the real shape: a computed gone === true (positive control)
  const behaviors = {
    'p1': { stuckLaunch: true,
      scan: { workers: [{ workerId: 'w-p1', state: 'unknown' }] } },
    'p2': { stuckLaunch: true,
      scan: { workers: [
        { workerId: 'w-p2', state: 'gone', gone: null },
        { workerId: 'w-p2b', state: 'running', gone: false },
      ] } },
    'p3': { stuckLaunch: true,
      scan: { workers: [
        { workerId: 'w-p3a', state: 'gone', gone: true },
        { workerId: 'w-p3b', state: 'gone', gone: 'gone' },
      ] } },
    'p4': { stuckLaunch: true },
  };
  const { sched, runtime } = mkSched(env, { behaviors });
  await sched.tick(); // claim
  await sched.tick(); // panel_begin + starts — all four stuck 'launching'
  let run = await runView(svc, runId);
  assert.equal(run.attempts.length, 4);
  assert.ok(run.attempts.every((a) => a.status === 'launching'), J(run.attempts.map((a) => a.status)));

  // p4's positive proof resolves on the first reconcile pass; p1–p3 must
  // NEVER orphan-resolve — incomplete evidence is not proof of absence.
  run = await driveUntil(svc, sched, runId, (r) =>
    (r.attempts || []).some((a) => a.participantId === 'p4' && a.status === 'failed'));
  await sched.tick(); await sched.tick();
  run = await runView(svc, runId);
  const attOf = (pid) => run.attempts.find((a) => a.participantId === pid);
  for (const pid of ['p1', 'p2', 'p3']) {
    assert.equal(attOf(pid).status, 'launching',
      `${pid}: missing/null/non-boolean gone is not absence evidence`);
    assert.equal(part(run, pid).status, 'launching');
    assert.equal(
      startsCalls(runtime).filter((c) => c.params.attemptId === attOf(pid).id).length, 1,
      `${pid}: never re-launched — the durable launch record exists`);
  }
  const att4 = attOf('p4');
  assert.equal(att4.status, 'failed');
  assert.match(att4.error ?? '', /orphaned/);
  assert.equal(part(run, 'p4').status, 'awaiting_decision', 'the spent budget leaves a decision');
  assert.match(part(run, 'p4').lastError?.reason ?? '', /orphaned/);

  // Flip p1's worker row to real positive proof — the SAME attempt resolves
  // orphaned on the next pass: the gate still works when evidence is real.
  behaviors['p1'].scan.workers = [{ workerId: 'w-p1', state: 'gone', gone: true }];
  run = await driveUntil(svc, sched, runId,
    (r) => (r.attempts || []).find((a) => a.participantId === 'p1')?.status === 'failed');
  run = await runView(svc, runId);
  assert.match(attOf('p1').error ?? '', /orphaned/);
  // p2/p3 remain pending forever — and no extra attempts were ever minted.
  await sched.tick();
  run = await runView(svc, runId);
  assert.equal(attOf('p2').status, 'launching');
  assert.equal(attOf('p3').status, 'launching');
  assert.equal(run.attempts.length, 4);
});

// ==========================================================================
// 7. Input change invalidates reuse (R9); identical inputs reuse answers
// ==========================================================================

test('continue: identical inputs reuse answers; changed task drops them', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task v1\n');
  const p = await mkPanelists(fusionProfile('model-a'), fusionProfile('model-b'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });
  const { sched, runtime } = mkSched(env, { behaviors: {
    default: { runMs: 5, finalText: makeAnswer('ok') },
  } });
  let run = await driveUntil(svc, sched, runId, (r) => r.fusion?.settledAt != null);
  assert.equal(run.fusion.status, 'complete');

  // Continuation with the SAME inputs → answers carry over, nothing launches.
  let c = await getCard(svc, 'card-a');
  let rc = await cmd(svc, 'card-a', {
    commandId: `ct-${randomUUID().slice(0, 6)}`, type: 'continue',
    expectedControlRevision: c.json.controlRevision, payload: {},
  });
  assert.equal(rc.status, 200, J(rc.json));
  const runId2 = rc.json.result.runId;
  assert.equal(rc.json.result.inputReused, true);
  assert.equal(rc.json.result.fingerprint, run.fusion.fingerprint);
  const startsBefore = startsCalls(runtime).length;
  run = await driveUntil(svc, sched, runId2, (r) => r.fusion?.settledAt != null);
  assert.equal(run.fusion.status, 'complete');
  assert.equal(startsCalls(runtime).length, startsBefore, 'no new attempts — answers reused');
  assert.equal(part(run, 'p1').answer.reusedFrom.runId, runId);

  // Continuation with a CHANGED task → new fingerprint, fresh panel.
  const reqDoc2 = await attachDoc(svc, 'card-a', 'requirements', '# Task v2 — changed\n');
  c = await getCard(svc, 'card-a');
  rc = await cmd(svc, 'card-a', {
    commandId: `ct-${randomUUID().slice(0, 6)}`, type: 'continue',
    expectedControlRevision: c.json.controlRevision,
    payload: { fusion: { task: reqDoc2 } },
  });
  assert.equal(rc.status, 200, J(rc.json));
  const runId3 = rc.json.result.runId;
  assert.equal(rc.json.result.inputReused, false, 'changed task invalidates reuse');
  assert.notEqual(rc.json.result.fingerprint, run.fusion.fingerprint);
  run = await driveUntil(svc, sched, runId3, (r) => r.fusion?.settledAt != null);
  assert.equal(run.fusion.status, 'complete');
  assert.equal(startsCalls(runtime).length, startsBefore + 2, 'a fresh panel launched');
  assert.equal(part(run, 'p1').status, 'answered');
  assert.equal(part(run, 'p1').answer.reusedFrom, undefined);
});

// ==========================================================================
// 8. Active vs blocked; stale control revision on decisions
// ==========================================================================

test('active vs blocked: run stays active while work executes; blocked parks for decisions; stale revision rejected', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task\n');
  const p = await mkPanelists(fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const runId = await mustStartFusion(svc, 'card-a', { task: reqDoc, panelists: p });
  // p1 hangs (never terminal); p2 fails both attempts; p3 answers.
  const { sched, runtime } = mkSched(env, { behaviors: {
    'p1': { hang: true },
    'p2': { runMs: 5, runStatus: 'failed', exitCode: 2 },
    'p3': { runMs: 5, finalText: makeAnswer('p3') },
  } });
  await sched.tick(); await sched.tick();
  await waitFake();
  // p2 burns through attempts while p1 still runs — run stays ACTIVE.
  let run = await driveUntil(svc, sched, runId,
    (r) => part(r, 'p2')?.status === 'awaiting_decision');
  run = await runView(svc, runId);
  assert.equal(run.status, 'active', 'live attempt p1 keeps the run active');
  assert.equal(part(run, 'p2').status, 'awaiting_decision');
  assert.equal(part(run, 'p3').status, 'answered');
  assert.ok(run.fusion.pendingActions.length >= 1);

  // A stale expectedControlRevision on retry is rejected (stale approval).
  const r = await cmd(svc, 'card-a', {
    commandId: `rt-${randomUUID().slice(0, 6)}`, type: 'retry_participant',
    expectedControlRevision: 0,
    payload: { runId, participantId: 'p2' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'revision_conflict');

  // Finish the hanging p1 — the run now drains to blocked decision_pending.
  const att1 = run.attempts.find((a) => a.participantId === 'p1');
  const prunId = runtime._records.get(att1.id).porchRunId;
  runtime._finish(prunId, { status: 'completed', exitCode: 0, runExitCode: 0, finalText: makeAnswer('p1') });
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && r.fusion?.settledAt != null);
  assert.equal(run.status, 'blocked');
  assert.equal(run.fusion.status, 'decision_pending');
  assert.deepEqual(run.fusion.pendingActions.map((x) => x.participantId), ['p2']);
  // A blocked run is no longer driven — a tick now reports no panel action.
  const tick = await sched.tick();
  assert.ok(!tick.panel_settled && !tick.launched, J(tick));
});
