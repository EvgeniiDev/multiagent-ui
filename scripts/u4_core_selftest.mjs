// scripts/u4_core_selftest.mjs — deterministic U4 observer/stop/recovery tests.
//   node --test scripts/u4_core_selftest.mjs
//
// Everything runs through createStateService's real request/queue path plus
// createInternalClient against the REAL routed internal surface (injected
// transport → svc.request, token auth included). Fixture projects are REAL
// git repositories; workspaces are REAL git worktrees under a scratch root.
// NOTHING opens a listener, touches compose, or uses the live state dir.
//
// U4 only: observation/stop/cancellation/API-outage recovery/environment
// retirement. U5 acceptance/checker loops are intentionally out of scope —
// completed implementer attempts park at active+awaiting_validation.

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
import { createInternalClient, loadInternalToken } from '../server/execution/internal-transport.mjs';
import {
  loadAggregate, saveAggregate, loadRun, saveRun, runArtifactsDir,
  saveSchedulerLimits, sha256,
} from '../server/execution/execution-store.mjs';
import { createPorchRuntime } from '../server/execution/porch-runtime.mjs';
import {
  verifyLifecycle, identityRule, classifyDockerError, parseInspectStdout,
  parseIdListStdout, findRecordedEntry, buildRetireCommand, readOpsTokenFile,
  receiptPath, loadReceipt, writeReceiptAtomic, main as retireMain,
} from './retire-environment.mjs';
import { saveEnvironments, loadEnvironments } from '../server/execution/execution-store.mjs';

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
  const dir = join(tmpdir(), `u4-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  await fs.writeFile(join(dir, 'README.md'), '# fixture\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
const myGid = typeof process.getgid === 'function' ? process.getgid() : null;

async function mkEnv({ faults, features = { start: true }, envExtra = {} } = {}) {
  const root = join(tmpdir(), `u4-state-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const stateDir = join(root, 'state');
  const wsRoot = join(root, 'wsroot');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(wsRoot, { recursive: true });
  const svc = await createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer'),
      ACP_WORKSPACE_DIR: wsRoot,
      ROOT_DIR: root,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
      ...envExtra,
    },
    faults,
    features,
  });
  return { root, stateDir, wsRoot, projectDir, svc };
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
const getEvents = (svc, id, qs = '') =>
  req(svc, 'GET', `/api/execution/runs/${id}/events${qs}`);

// Real internal client → real routed internal surface (token auth included).
// `sw.down` flips every request into a transport failure = state-API outage.
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

// Multi-instance fixtures need DISTINCT instance pids: the shared registry's
// procs table is the /proc substitute — each scheduler registers its own row
// so "owner dead" probes are real lookups, not a shared process.pid.
let pidSeq = 90000;
function mkInstanceProc(registry, pid, alive = true) {
  registry.procs.set(pid, {
    exists: alive, state: 'R', starttime: `st-${pid}`, readable: true,
  });
}

function mkSched(env, {
  registry, behavior, behaviors, instanceId = `inst-${randomUUID().slice(0, 8)}`,
  runnerId = 'host-runner', environment, hooks, sw, leaseMs, stuckMs, now,
} = {}) {
  // A distinct fake pid per instance — snapshot liveness probes mean nothing
  // if every instance reports the same real process.pid.
  const instPid = ++pidSeq;
  const envOv = { pid: instPid, pidStarttime: `st-${instPid}`, ...(environment || {}) };
  const runtime = createFakeRuntime({
    registry,
    rootDir: join(env.root, 'fake-exec'),
    environment: envOv,
    behaviors: behaviors || (behavior ? { default: behavior } : {}),
  });
  if (registry) mkInstanceProc(registry, instPid, true);
  const sched = createManagedScheduler({
    client: mkClient(env.svc, env.stateDir, sw),
    runtime, runnerId, instanceId, leaseMs, stuckMs, now,
    stateDir: env.stateDir,
    env: { ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root },
    hooks,
  });
  return { sched, runtime, instanceId, instPid };
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
const MEMBER = { cli: 'pi', model: 'zen-relay/muse-spark-1.3-contributor-free' };
function goodPreset(limits = {}) {
  return {
    id: `preset-${randomUUID().slice(0, 8)}`, name: 't',
    members: { implementer: { ...MEMBER }, reviewer: { ...MEMBER }, checker: { ...MEMBER } },
    limits: { maxAttemptsPerRole: 3, ...limits },
  };
}
async function savePreset(svc, cardId, preset = goodPreset()) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `ps-${randomUUID().slice(0, 6)}`, type: 'save_preset',
    expectedControlRevision: c.json.controlRevision,
    payload: { preset },
  });
  assert.equal(r.status, 200, J(r.json));
}
async function mkManagedRun(svc, cardId = 'card-a', { preset } = {}) {
  await enable(svc, cardId);
  const req1 = await attachDoc(svc, cardId, 'requirements', `# Req ${cardId}`);
  await approve(svc, cardId, 'approve_requirements', req1);
  const plan = await attachDoc(svc, cardId, 'plan', `# Plan ${cardId}`,
    { checks: [{ run: 'npm test', timeoutSec: 300 }] });
  await approve(svc, cardId, 'approve_plan', plan);
  await savePreset(svc, cardId, preset);
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c.json.controlRevision, payload: {},
  });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result.runId;
}

async function runView(svc, runId) {
  const r = await getRun(svc, runId);
  assert.equal(r.status, 200, J(r.json));
  return r.json;
}
const attemptsOf = (run) => run.attempts || [];
const starts = (rt) => rt._calls.filter((c) => c.m === 'start');
const cancels = (rt) => rt._calls.filter((c) => c.m === 'cancel');
const userCmd = (svc, cardId, type, payload = {}) => getCard(svc, cardId).then((c) =>
  cmd(svc, cardId, {
    commandId: `uc-${randomUUID().slice(0, 6)}`, type,
    expectedControlRevision: c.json.controlRevision, payload,
  }));
const waitFake = () => sleep(15); // default outcome timer is 5ms
// Two schedulers driving distinct implementers need raised limits.
async function allowTwoImplementers(env) {
  await saveSchedulerLimits(env.stateDir, {
    global: 4, roles: { implementer: 2, reviewer: 1, checker: 1 },
  });
}

// ==========================================================================
// 1. Happy observer path
// ==========================================================================

test('observer: implementer completion parks at active+awaiting_validation; no relaunch; accept 501', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env);

  const t1 = await sched.tick();
  assert.equal(starts(runtime).length, 1, J(t1));
  const attId = attemptsOf(await runView(svc, runId))[0].id;

  await waitFake();
  const t2 = await sched.tick();
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  assert.equal(att.status, 'completed', J(t2));
  assert.equal(run.status, 'active', 'run stays active — validation is a U5 gate');
  assert.equal(run.phase, 'awaiting_validation', J(run.phase));
  assert.ok(att.result?.finalArtifactId, 'final artifact committed through the service boundary');
  assert.equal(att.result?.summary, 'fake result');

  await sched.tick();
  await sched.tick();
  assert.equal(starts(runtime).length, 1, 'awaiting_validation must not relaunch');

  const acc = await userCmd(svc, 'card-a', 'accept_result', {});
  assert.equal(acc.status, 501, J(acc.json));

  const artDir = runArtifactsDir(env.stateDir, runId);
  const artStored = (await runView(svc, runId)).artifacts?.[`art-${attId}`]?.stored;
  assert.ok(artStored, 'committed artifact carries its physical stored name');
  const text = await fs.readFile(join(artDir, artStored), 'utf8');
  assert.equal(text, 'fake result');
});

test('observer: long final output (>32KiB) is preserved whole through the artifact path', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const big = 'X'.repeat(40 * 1024);
  const { sched } = mkSched(env, { behavior: { finalText: big } });

  await sched.tick();
  await waitFake();
  await sched.tick();
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  assert.equal(att.status, 'completed', J(run.diagnostic));
  const artDir = runArtifactsDir(env.stateDir, runId);
  const artStored = run.artifacts?.[`art-${att.id}`]?.stored;
  assert.ok(artStored, 'committed artifact carries its physical stored name');
  const text = await fs.readFile(join(artDir, artStored), 'utf8');
  assert.equal(text.length, big.length, 'full result preserved — no silent truncation');
  assert.equal(text, big);
});

// ==========================================================================
// 2. Stop intents
// ==========================================================================

test('stop: queued run cancelled with zero launches', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env);

  const r = await userCmd(svc, 'card-a', 'stop', { reason: 'test stop' });
  assert.equal(r.status, 200, J(r.json));
  assert.equal(r.json.result.status, 'stopping');

  await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.status, 'cancelled');
  assert.equal(starts(runtime).length, 0, 'stop must fence the queued launch');
});

test('stop: running attempt → intent durable → cancel by runId only → terminal proof → cancelled', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env, { behavior: { outcome: 'never' } });

  await sched.tick();
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');

  const r = await userCmd(svc, 'card-a', 'stop', { reason: 'user halt' });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(run.status, 'stopping');
  assert.ok(attemptsOf(run)[0].cancel, 'durable cancel intent recorded');

  await sched.tick(); // cancel dispatched (intent → runtime.cancel by runId)
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'cancelling',
    'a dispatched cancel is not yet proof — the attempt stays reserved');
  assert.equal(run.status, 'stopping');

  await sched.tick(); // terminal observed + process proof → resolve
  run = await runView(svc, runId);
  assert.equal(run.status, 'cancelled');
  assert.equal(attemptsOf(run)[0].status, 'cancelled');
  assert.equal(cancels(runtime).length, 1);
  assert.ok(cancels(runtime)[0].runId, 'cancel addressed by runId');
  assert.equal(cancels(runtime)[0].pid, undefined, 'no pid signalling');
});

test('stop: launch fence — stop landing after begin_attempt never spawns', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env, {
    hooks: {
      onAttemptDurable: async () => { await userCmd(svc, 'card-a', 'stop', {}); },
    },
  });
  await sched.tick();   // stop lands between begin_attempt and runtime.start
  await sched.tick();   // never-entered resolve landed last tick; run finalizes now
  const run = await runView(svc, runId);
  assert.equal(starts(runtime).length, 0, 'fenced: no spawn under stop intent');
  assert.equal(run.status, 'cancelled');
  assert.equal(attemptsOf(run)[0].status, 'cancelled');
});

test('stop: blocked run with a live attempt is reachable; restores prior terminal status', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env, { behavior: { outcome: 'never' } });
  await sched.tick();
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');

  // Stranded-attempt fixture (legacy/pre-terminal doc state): run 'blocked'
  // while its attempt is still 'running'. Constructed inside the serialized
  // queue — the store is the authority.
  await svc.enqueueWrite(async () => {
    const agg = await loadAggregate(stateDir, 'card-a');
    const r = agg.runs.find((x) => x.id === runId);
    r.status = 'blocked';
    await saveAggregate(stateDir, agg);
  });

  const r = await userCmd(svc, 'card-a', 'stop', {});
  assert.equal(r.status, 200, 'stop must reach a blocked run holding a live attempt: ' + J(r.json));
  await sched.tick();
  await sched.tick();
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'cancelled');
  assert.equal(run.status, 'blocked', 'prior terminal status restored — not papered over with cancelled');
  assert.equal(cancels(runtime).length, 1);
});

test('stop: isolation — stopping card-a never touches card-b', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a', projectDir), cardFixture('card-b', projectDir)]);
  await allowTwoImplementers(env);
  const runA = await mkManagedRun(svc, 'card-a');
  const runB = await mkManagedRun(svc, 'card-b');
  const { sched, runtime } = mkSched(env, { behavior: { outcome: 'never' } });
  await sched.tick();
  assert.equal(starts(runtime).length, 2, 'both implementers live under raised limits');

  await userCmd(svc, 'card-a', 'stop', {});
  await sched.tick();
  await sched.tick();
  const ra = await runView(svc, runA);
  const rb = await runView(svc, runB);
  assert.equal(ra.status, 'cancelled');
  assert.equal(attemptsOf(ra)[0].status, 'cancelled');
  assert.equal(rb.status, 'active', 'card-b untouched');
  assert.equal(attemptsOf(rb)[0].status, 'running');
});

// ==========================================================================
// 3. Continue
// ==========================================================================

test('continue: refused while a prior attempt is live', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await mkManagedRun(svc);
  const { sched } = mkSched(env, { behavior: { outcome: 'never' } });
  await sched.tick();

  const r = await userCmd(svc, 'card-a', 'continue', { note: 'go again' });
  assert.equal(r.status, 409, J(r.json));
  assert.equal(r.json.code ?? r.json.error?.code, 'run_active');
});

test('continue: after terminal → new run retains workspace, changes, and prior context in the prompt', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const marker = `MK-${randomUUID().slice(0, 6)}`;
  const tail = `TAIL-MARKER-${marker}`;
  // Head + >4KiB padding + tail marker: the prompt must carry the COMPLETE
  // verified artifact — a truncated excerpt must not silently drop the tail.
  const priorText = `RESULT-TEXT-${marker}\n${'p'.repeat(4500)}\n${tail}`;
  const { sched } = mkSched(env, { behavior: { finalText: priorText } });
  await sched.tick();
  await waitFake();
  await sched.tick();
  const before = await runView(svc, runId);
  assert.equal(before.status, 'active');
  assert.equal(before.phase, 'awaiting_validation');
  const wsId = before.workspaceId;

  const card = (await getCard(svc, 'card-a')).json;
  const ws = card.workspaces[wsId];
  const dirtyFile = join(ws.path, 'src', 'dirty.txt');
  await fs.writeFile(dirtyFile, `dirty-${marker}\n`, 'utf8');

  const r = await userCmd(svc, 'card-a', 'continue', { note: `NOTE-${marker}` });
  assert.equal(r.status, 200, J(r.json));
  const newRunId = r.json.result.runId;
  assert.notEqual(newRunId, runId);
  assert.equal(r.json.result.workspaceId, wsId, 'same workspace allocation retained');

  // currentRunId supersedes; the parked run's history is NOT rewritten.
  const cardAfter = (await getCard(svc, 'card-a')).json;
  assert.equal(cardAfter.currentRunId, newRunId);
  const after = await runView(svc, runId);
  assert.equal(after.status, 'active');
  assert.equal(after.phase, 'awaiting_validation');
  assert.equal(after.attempts.length, before.attempts.length);
  assert.deepEqual(after.attempts[0].result, before.attempts[0].result,
    'prior run evidence untouched by the continuation');

  const run2 = await runView(svc, newRunId);
  assert.equal(run2.status, 'queued');
  assert.equal(run2.continuation?.fromRunId, runId);
  assert.equal(run2.baseCommit, before.baseCommit, 'retained base identity');

  // The launch prompt must carry the REAL context: prior run id, prior
  // result text, the operator note, prior attempt outcome.
  const { sched: s2, runtime: rt2 } = mkSched(env, { behavior: { outcome: 'never' } });
  await s2.tick();
  assert.equal(starts(rt2).length, 1, 'the continued run actually launches');
  const prompt = starts(rt2)[0].prompt;
  assert.match(prompt, new RegExp(runId), 'prompt names the prior run id');
  assert.match(prompt, new RegExp(`RESULT-TEXT-${marker}`),
    'prompt embeds the prior final result text');
  assert.match(prompt, new RegExp(tail),
    'COMPLETE artifact embedded — tail beyond 4KiB is never silently dropped');
  assert.match(prompt, new RegExp(`NOTE-${marker}`), 'prompt carries the operator note');
  assert.match(prompt, /completed/, 'prior attempt outcome visible in context');
  assert.match(prompt, new RegExp(before.baseCommit.slice(0, 12)), 'base commit identity in prompt');

  const dirty = await fs.readFile(dirtyFile, 'utf8');
  assert.equal(dirty, `dirty-${marker}\n`, 'retained workspace keeps dirty changes — never reset');
});

test('continue: corrupted prior artifact → explicit UNAVAILABLE marker + durable diagnostic', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const marker = `MK-${randomUUID().slice(0, 6)}`;
  const { sched } = mkSched(env, { behavior: { finalText: `GOOD-${marker}` } });
  await sched.tick();
  await waitFake();
  await sched.tick();
  const before = await runView(svc, runId);
  const attId = before.attempts[0].id;
  assert.equal(before.attempts[0].result?.finalArtifactId, `art-${attId}`);

  // Corrupt the artifact's STORED bytes: `file` is logical metadata that
  // recurs across rounds; the physical blob is named by the record's
  // `stored` field (the artifact id). Resolve it from the record, never
  // guess the logical name.
  const artRec = before.artifacts?.[`art-${attId}`];
  assert.ok(artRec?.stored, 'committed artifact carries its physical stored name');
  const artPath = join(runArtifactsDir(stateDir, runId), artRec.stored);
  assert.equal(sha256(await fs.readFile(artPath)), artRec.sha256,
    'pre-tamper bytes verify — the fault injection hits real evidence');
  await fs.writeFile(artPath, `CORRUPTED-${marker}`, 'utf8');
  assert.notEqual(sha256(await fs.readFile(artPath)), artRec.sha256,
    'stored bytes genuinely changed');

  const r = await userCmd(svc, 'card-a', 'continue', { note: 'try again' });
  assert.equal(r.status, 200, J(r.json));
  const { sched: s2, runtime: rt2 } = mkSched(env, { behavior: { outcome: 'never' } });
  await s2.tick();
  assert.equal(starts(rt2).length, 1);
  const prompt = starts(rt2)[0].prompt;
  assert.doesNotMatch(prompt, /CORRUPTED/, 'corrupt bytes are never fed as verified history');
  assert.doesNotMatch(prompt, /GOOD-/,
    'unverified content is not presented — even its real prior text is withheld');
  assert.match(prompt, /UNAVAILABLE/, 'prompt carries the explicit unavailable marker');
  const run2 = await runView(svc, r.json.result.runId);
  const evs = (await getEvents(svc, run2.id)).json;
  assert.ok((evs.events || []).some((e) => e.type === 'artifact_corrupt'),
    'durable artifact_corrupt diagnostic on the new run');
});

// ==========================================================================
// 4. Terminal-proof gate (seq12 matrix — production path)
// ==========================================================================

async function launchRunning(env, { behavior } = {}) {
  const { svc, projectDir } = env;
  const runId = await mkManagedRun(svc);
  const m = mkSched(env, { behavior: { outcome: 'never', ...behavior } });
  await m.sched.tick();
  const run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  return { runId, attId: att.id, porchRunId: att.porchRunId, ...m };
}

test('proof: terminal metadata + live supervisor retains the reservation', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env);
  const pid = runtime._runs.get(porchRunId).pid;
  runtime._force(porchRunId, { status: 'completed' });
  runtime._setProc(pid, { exists: true, state: 'R', starttime: `st-${pid}`, readable: true });

  const out = await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running', 'live supervisor blocks terminalization');
  assert.equal(out.terminal_unproven, 1, J(out));
  const evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some((e) => e.type === 'terminal_unproven'),
    'durable terminal_unproven diagnostic');
});

test('proof: unreadable supervisor probe retains (never dead by default)', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env);
  const pid = runtime._runs.get(porchRunId).pid;
  runtime._force(porchRunId, { status: 'completed' });
  runtime._setProc(pid, { exists: null, readable: false }); // EACCES-style unverifiable

  await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');
});

test('proof: recycled supervisor pid (different starttime) resolves', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env);
  const pid = runtime._runs.get(porchRunId).pid;
  // Identity was recorded while live (launch-tick observe) — this proc row
  // with a DIFFERENT starttime is a positively recycled pid, not the original.
  runtime._force(porchRunId, { status: 'completed', finalText: 'fake result' });
  runtime._setProc(pid, { exists: true, state: 'R', starttime: `RECYCLED-${pid}`, readable: true });

  await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'completed', J(run.diagnostic));
  assert.equal(run.phase, 'awaiting_validation');
});

test('proof: zombie supervisor counts as dead', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env);
  const pid = runtime._runs.get(porchRunId).pid;
  runtime._force(porchRunId, { status: 'completed', finalText: 'fake result' });
  runtime._setProc(pid, { exists: true, state: 'Z' });
  await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'completed', J(run.diagnostic));
});

test('proof: terminal + mailboxClosed but no supervisor identity → retained', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env);
  runtime._force(porchRunId, { status: 'completed' });
  const fakeRun = runtime._runs.get(porchRunId);
  fakeRun.pid = null;
  fakeRun.childPid = null;

  const out = await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'mailboxClosed without process identity is never death proof');
  assert.equal(out.terminal_unproven, 1, J(out));
});

test('proof: live recorded child blocks; absent child (ENOENT) resolves', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir,
    [cardFixture('card-a', projectDir), cardFixture('card-b', projectDir)]);
  await allowTwoImplementers(env);

  // card-a: supervisor + child both dead → resolve.
  const { runId, porchRunId, sched, runtime } = await launchRunning(env, {
    behavior: { childPid: 89999 },
  });
  const pid = runtime._runs.get(porchRunId).pid;
  // First the identity must be RECORDED while live — one observe tick before
  // the terminal, so the supervisor+child identity lands durably.
  runtime._setProc(pid, { exists: true, state: 'R', starttime: `st-${pid}` });
  await sched.tick();
  runtime._setProc(89999, { exists: false, readable: false }); // real ENOENT in our ns
  runtime._force(porchRunId, { status: 'completed', finalText: 'fake result' });
  await sched.tick();
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'completed', J(run.diagnostic));

  // card-b: child stays alive → retained (with finalText present, the ONLY
  // blocker is the live child).
  const runB = await mkManagedRun(svc, 'card-b');
  const m2 = mkSched(env, {
    behavior: { outcome: 'never', childPid: 88888 }, instanceId: 'instBB',
  });
  await m2.sched.tick();      // launch + record supervisor/child identity live
  const att2 = attemptsOf(await runView(svc, runB))[0];
  m2.runtime._force(att2.porchRunId, { status: 'completed', finalText: 'fake result' });
  // The run's terminal transition marked the child dead — re-arm it alive.
  m2.runtime._setProc(88888, {
    exists: true, state: 'R', starttime: 'cst-88888', pidNs: 'fake-pidns', readable: true,
  });
  const outB = await m2.sched.tick();
  run = await runView(svc, runB);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'a live recorded child blocks terminalization: ' + J(run.diagnostic));
  assert.equal(outB.terminal_unproven, 1, J(outB));
});

test('proof: mismatched status child id → retained diagnostic', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env, {
    behavior: { childPid: 89998 },
  });
  await sched.tick(); // record identity while everything is live
  runtime._force(porchRunId, { status: 'completed' });
  runtime._runs.get(porchRunId).childPid = 77777; // status now reports a stranger
  await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');
});

// U7 codex regression: porch writes meta.child_pid in a second meta update
// after adapter.start(); a status read inside that gap latches
// supervisor.childPid=null, and every later terminal check stranded on
// child_unproven (observed: run_wild-kestrel-4a83, codex-cli/gpt-5.6-sol).
// The fill-once path records a live-disclosed child under a verified-same
// supervisor — never from a terminal status, never over a childNone
// attestation.
test('proof: late-disclosed child fills while supervisor verified live', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  // behavior.childSpawnedUndeclared → status emits NO child_spawned and
  // childPid:null — exactly what a raced meta.child_pid read looks like.
  const { runId, porchRunId, sched, runtime } = await launchRunning(env, {
    behavior: { childSpawnedUndeclared: true },
  });
  const runRec = runtime._runs.get(porchRunId);
  const pid = runRec.pid;
  let att = attemptsOf(await runView(svc, runId))[0];
  assert.equal(att.supervisor?.pid, pid);
  assert.equal(att.supervisor?.childPid ?? null, null);
  assert.notEqual(att.supervisor?.childNone, true);

  runRec.childPid = 81234; // meta update lands; next live status discloses it
  runtime._procs.set(81234, {
    exists: true, state: 'R', starttime: 'cst-81234',
    pidNs: runRec.pidNs ?? 'fake-pidns', readable: true,
  });
  await sched.tick();
  att = attemptsOf(await runView(svc, runId))[0];
  assert.equal(att.supervisor?.childPid, 81234,
    'live-disclosed child filled under verified-same supervisor');
  assert.equal(att.supervisor?.childPidNs != null, true);

  // Now terminal with the SAME child, recorded dead → the run resolves
  // instead of stranding on child_unproven forever.
  runtime._procs.set(81234, { exists: false, readable: false });
  runtime._setProc(pid, { exists: false, readable: false });
  runtime._force(porchRunId, { status: 'completed', finalText: 'real result' });
  const out = await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'completed', J(run.diagnostic));
  assert.notEqual(out.terminal_unproven, 1, J(out));
});

test('proof: child first disclosed at TERMINAL stays unproven', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env, {
    behavior: { childSpawnedUndeclared: true },
  });
  const runRec = runtime._runs.get(porchRunId);
  const pid = runRec.pid;
  // sup was recorded during launch with no child and no attestation.
  // The child appears ONLY in the terminal status — never live-bound.
  runRec.childPid = 84567;
  runtime._setProc(pid, { exists: false, readable: false });
  runtime._setProc(84567, { exists: false, readable: false });
  runtime._force(porchRunId, { status: 'completed', finalText: 'x' });
  const out = await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'a child disclosed only at terminal can never be bound — honest retain');
  assert.equal(out.terminal_unproven, 1, J(out));
});

test('proof: foreign recorded environment is never probed or cancelled', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(), procs: new Map(), seq: 0 };
  const A = mkSched(env, {
    registry,
    environment: { pidNs: 'ns-A', bootId: 'fake-bootid', containerId: 'cont-A', initStarttime: 'init-A' },
    behavior: { outcome: 'never' },
  });
  await A.sched.tick();
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');

  const B = mkSched(env, {
    registry,
    environment: { pidNs: 'ns-B', bootId: 'fake-bootid', containerId: 'cont-B', initStarttime: 'init-B' },
    instanceId: 'instBB',
  });
  const out = await B.sched.tick();
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'foreign attempt never adopted, probed, or resolved');
  assert.equal(cancels(B.runtime).length, 0, 'no cancel calls against a foreign attempt');
  assert.ok((out.foreign ?? 0) >= 1, J(out));
});

test('proof: vanished registry + dead recorded supervisor + immutable no-child attestation → interrupted', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env);
  // Identity is recorded while everything is live — one observe tick before
  // the registry entry disappears. The fake status carries the explicit
  // immutable spawn attestation (childSpawned:false) → sup.childNone.
  await sched.tick();
  runtime._vanish(porchRunId); // registry gone; recorded sup pid reads ENOENT

  const out = await sched.tick();
  assert.equal(out.resolved, 1, J(out));
  const run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  assert.equal(att.status, 'interrupted', J(att));
  assert.equal(run.status, 'interrupted',
    'positive death terminalizes the run — never parked active');
  assert.equal(cancels(runtime).length, 0, 'vanish resolution signals nothing');
});

test('proof: vanished registry + live or unverifiable recorded child → retained', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env, {
    behavior: { childPid: 86666 },
  });
  await sched.tick(); // supervisor+child identity recorded while live
  runtime._vanish(porchRunId); // sup pid ENOENT + registry record gone

  // Recorded child still ALIVE in its recorded namespace — a dead supervisor
  // alone never proves the workload died.
  const out1 = await sched.tick();
  assert.equal(out1.vanished, 1, J(out1));
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'live recorded child retains the reservation — never resolved');
  assert.equal(run.status, 'active');
  const evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some((e) => e.type === 'supervisor_vanished'),
    'durable supervisor_vanished diagnostic');
  assert.ok((evs.events || []).some(
    (e) => e.type === 'vanished_unproven' && e.data?.code === 'child_alive'),
    'vanished_unproven names the live recorded child: ' + J(evs.events?.slice(-3)));

  // Unverifiable child evidence (EACCES-style exists:null) retains the same
  // way — unknown is never death proof.
  runtime._setProc(86666, { exists: null, readable: false });
  const out2 = await sched.tick();
  assert.equal(out2.vanished, 1, J(out2));
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running', 'unknown child evidence retains');
  assert.equal(run.status, 'active');
  assert.equal(cancels(runtime).length, 0, 'vanished retention never dispatches cancels');
});

test('proof: vanished registry + missing/foreign recorded namespace → retained, ZERO probes', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env, { behavior: { outcome: 'never' } });
  await sched.tick(); // launch
  await sched.tick(); // record supervisor identity while live
  let run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  const supPid = att.supervisor?.pid;
  assert.ok(Number.isInteger(supPid), 'supervisor identity recorded live');
  const probesOf = (pid) =>
    runtime._calls.filter((c) => c.m === 'processIdentity' && c.pid === pid).length;
  runtime._vanish(att.porchRunId); // registry record gone
  const probesBefore = probesOf(supPid);

  // Same container, recorded supervisor WITHOUT a pid namespace — an
  // unbound recorded pid is NEVER probed, let alone trusted. The mutation
  // lands on BOTH durable views (aggregate + run projection) — the
  // scheduler reads the projection.
  await svc.enqueueWrite(async () => {
    const agg = await loadAggregate(stateDir, 'card-a');
    const r = agg.runs.find((x) => x.id === runId);
    r.attempts[0].supervisor.pidNs = null;
    await saveAggregate(stateDir, agg);
    const proj = await loadRun(stateDir, runId);
    proj.attempts[0].supervisor.pidNs = null;
    await saveRun(stateDir, proj);
  });
  const out1 = await sched.tick();
  assert.equal(out1.vanished, 1, J(out1));
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'missing recorded namespace retains — never resolves');
  assert.equal(probesOf(supPid), probesBefore,
    'recorded pid was never probed while its namespace was unbound');
  let evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some(
    (e) => e.type === 'vanished_unproven' && e.data?.code === 'foreign_ns'),
    'durable diagnostic names the unbound namespace: ' + J(evs.events?.slice(-3)));

  // Foreign recorded environment — the namespace binding fails BEFORE any
  // probe; nothing foreign is ever looked up.
  await svc.enqueueWrite(async () => {
    const agg = await loadAggregate(stateDir, 'card-a');
    const r = agg.runs.find((x) => x.id === runId);
    r.attempts[0].supervisor.pidNs = 'ns-foreign';
    r.attempts[0].owner.envKey.pidNs = 'ns-foreign';
    await saveAggregate(stateDir, agg);
    const proj = await loadRun(stateDir, runId);
    proj.attempts[0].supervisor.pidNs = 'ns-foreign';
    proj.attempts[0].owner.envKey.pidNs = 'ns-foreign';
    await saveRun(stateDir, proj);
  });
  const out2 = await sched.tick();
  assert.equal(out2.vanished, 1, J(out2));
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running', 'foreign env retains');
  assert.equal(probesOf(supPid), probesBefore,
    'a foreign recorded pid is never probed');
  assert.equal(cancels(runtime).length, 0, 'no signalling across env boundary');
  evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some(
    (e) => e.type === 'vanished_unproven' && e.data?.code === 'foreign_env'),
    'durable diagnostic names the foreign environment: ' + J(evs.events?.slice(-3)));
});

test('proof: vanished registry + null child field WITHOUT spawn attestation → retained', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env, { behavior: { outcome: 'never' } });
  // Model a runtime whose status carries the serialized child key as null
  // but NEVER attests spawn state (real porch today: child_pid always
  // emitted, often null). Wrap BEFORE the launch tick — the launch path
  // records the identity on its immediate first observation.
  const origStatus = runtime.status.bind(runtime);
  runtime.status = async (rid) => {
    const st = await origStatus(rid);
    if (st?.ok) delete st.childSpawned;
    return st;
  };
  await sched.tick(); // launch + immediate first observation (no attestation)
  let run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  const porchRunId = att.porchRunId;
  assert.ok(att.supervisor?.pid, 'supervisor recorded at launch observation');
  assert.notEqual(att.supervisor?.childNone, true,
    'no immutable no-child attestation was recorded');
  runtime._vanish(porchRunId);
  // A hidden child could still exist (its procs row is live in the shared
  // namespace) — the supervisor being dead is not the whole workload.
  const out = await sched.tick();
  assert.equal(out.vanished, 1, J(out));
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'unattested child state retains — a null field is not a no-child proof');
  const evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some(
    (e) => e.type === 'vanished_unproven' && e.data?.code === 'child_unknown'),
    'vanished_unproven names the unknown child state: ' + J(evs.events?.slice(-3)));
});

test('proof: terminal metadata + dead supervisor but NO spawn attestation → retained; attestation resolves', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched, runtime } = mkSched(env, { behavior: { outcome: 'never' } });
  // A porch-like runtime: serialized child_pid but NO spawn attestation
  // (child_spawned absent). The stricter gate must NOT infer no-child.
  const origStatus = runtime.status.bind(runtime);
  let attest = false;
  runtime.status = async (rid) => {
    const st = await origStatus(rid);
    if (st?.ok && !attest) delete st.childSpawned;
    return st;
  };
  await sched.tick();                    // launch; sup bound WITHOUT childNone
  const att = attemptsOf(await runView(svc, runId))[0];
  assert.ok(att.supervisor?.pid, 'supervisor bound at launch');
  assert.equal(att.supervisor.childPid ?? null, null);
  assert.notEqual(att.supervisor.childNone, true,
    'no immutable no-child attestation was recorded');
  const pid = runtime._runs.get(att.porchRunId).pid;
  runtime._force(att.porchRunId, { status: 'completed', finalText: 'done' });
  runtime._setProc(pid, { exists: false });   // recorded supervisor provably dead
  for (let i = 0; i < 3; i += 1) await sched.tick();
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'terminal metadata with an unattested child state never resolves');
  const evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some(
    (e) => e.type === 'terminal_unproven' && e.data?.code === 'child_unknown'),
    'durable diagnostic names the unattested child state: ' + J(evs.events?.slice(-3)));
  // Positive attestation restores discharge of the same terminal run.
  attest = true;
  await sched.tick();
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'completed',
    'the same run resolves once the runtime attests no child (childSpawned:false)');
});

test('outage: journaled resolve — unrecorded child retains; already-terminal still requires proof', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const swx = { down: false };
  const { sched, runtime, instanceId } = mkSched(env, { sw: swx, behavior: { outcome: 'never' } });
  await sched.tick();                          // launch; sup bound WITH childNone:true
  const att = attemptsOf(await runView(svc, runId))[0];
  const porchRunId = att.porchRunId;
  const supPid = runtime._runs.get(porchRunId).pid;
  swx.down = true;
  runtime._force(porchRunId, { status: 'completed', finalText: 'fake result' });
  runtime._setProc(supPid, { exists: false }); // supervisor dead mid-outage
  await sched.tick();                          // terminal proof passed → resolve journaled
  const jrnl = await fs.readFile(sched._journalFile, 'utf8');
  assert.match(jrnl, /"kind":"resolve"/, 'resolve duty journaled during outage');
  const resolveEntry = jrnl.split('\n').find((l) => l.includes('"kind":"resolve"'));
  assert.ok(resolveEntry, 'resolve entry captured for re-append');

  // The runtime now reports a child pid that was NEVER recorded while live —
  // journaled resolve must retain: the unrecorded child is never probed.
  const fakeChild = 99177;
  runtime._runs.get(porchRunId).childPid = fakeChild;
  runtime._procs.set(fakeChild, {
    exists: true, readable: true, state: 'R',
    starttime: 'cst-unrecorded', pidNs: 'ns-foreign-to-recording',
  });
  const probesOf = (pid) =>
    runtime._calls.filter((c) => c.m === 'processIdentity' && c.pid === pid).length;
  swx.down = false;
  for (let i = 0; i < 4; i += 1) await sched.tick();
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'a status-reported but never-recorded child retains the journaled resolve');
  const jrnl2 = await fs.readFile(sched._journalFile, 'utf8');
  assert.match(jrnl2, /"kind":"resolve"/, 'the duty is retained, not dropped');
  const evs2 = (await getEvents(svc, runId)).json;
  assert.ok((evs2.events || []).some(
    (e) => e.type === 'journal_retain'
      && /child_unproven|child_unknown/.test(e.data?.code ?? '')),
    'durable retain diagnostic names the unproven child: ' + J(evs2.events?.slice(-4)));
  assert.equal(probesOf(fakeChild), 0,
    'an unrecorded child pid is NEVER probed');
  assert.equal(cancels(runtime).length, 0, 'nothing is signalled');

  // Restore the no-child truth — explicit attestation discharges the duty.
  runtime._runs.get(porchRunId).childPid = null;
  await sched.tick();
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'completed',
    'explicit no-child attestation discharges the journaled resolve');

  // Re-append the same entry and let a RESTARTED same-instance scheduler
  // pick it up (a journal is loaded once per process). The attempt is now
  // already terminal in the authoritative record — an unproven child must
  // STILL retain: terminal metadata alone never substitutes for proof.
  const sameInstance = createManagedScheduler({
    client: mkClient(env.svc, env.stateDir, swx),
    runtime, runnerId: 'host-runner', instanceId,
    stateDir: env.stateDir,
    env: { ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root },
  });
  await fs.appendFile(sched._journalFile, resolveEntry + '\n');
  runtime._runs.get(porchRunId).childPid = fakeChild;
  await sameInstance.tick();
  const jrnl3 = await fs.readFile(sched._journalFile, 'utf8');
  assert.match(jrnl3, /"kind":"resolve"/,
    'already-terminal + unproven child retains — metadata alone never discharges');
  assert.equal(probesOf(fakeChild), 0, 'still zero probes of the unrecorded child');

  // With the truth restored, the identical already-terminal entry discharges
  // by exact evidence equivalence — no impersonation, no re-resolve.
  runtime._runs.get(porchRunId).childPid = null;
  await sameInstance.tick();
  const jrnl4 = await fs.readFile(sched._journalFile, 'utf8');
  assert.ok(!jrnl4.includes('"kind":"resolve"'),
    'already-terminal + exact evidence + proven child discharges the retained duty');
});

test('proof: late cancel race preserves the observed completed result', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched } = mkSched(env); // outcome completed after 5ms
  await sched.tick();
  await waitFake();
  await userCmd(svc, 'card-a', 'stop', {});
  await sched.tick(); // terminal-first path: observed completed wins
  const run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  assert.equal(att.status, 'completed', 'observed outcome wins over the cancel intent');
  assert.equal(run.status, 'cancelled', 'run-level status still honors the stop');
});

test('proof: completed but result temporarily unreadable → retained, resolves when readable', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env);
  runtime._force(porchRunId, { status: 'completed', finalText: 'fake result' });
  const origWait = runtime.wait.bind(runtime);
  runtime.wait = async () => ({ ok: false, error: { code: 'cli_gone', message: 'wait failed' } });
  const out = await sched.tick();
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'a terminal run whose result cannot be harvested stays retained');
  assert.equal(out.result_unavailable, 1, J(out));
  runtime.wait = origWait;
  await sched.tick();
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'completed', 'resolves once evidence harvests');
  assert.equal(attemptsOf(run)[0].result?.summary, 'fake result');
});

test('proof: artifact commit failure keeps the reservation; recovery commits the FULL text', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const big = 'Y'.repeat(50 * 1024);
  const { sched, runtime } = mkSched(env, { behavior: { finalText: big } });
  await sched.tick();
  await waitFake();
  const { porchRunId } = attemptsOf(await runView(svc, runId))[0]
    ? { porchRunId: attemptsOf(await runView(svc, runId))[0].porchRunId } : {};
  void porchRunId;
  // Make staging unwritable: a file sits where the staging dir must be.
  const stagedRoot = join(stateDir, 'execution', 'staged');
  await fs.rm(stagedRoot, { recursive: true, force: true });
  await fs.writeFile(stagedRoot, 'blocked', 'utf8');
  for (let i = 0; i < 6; i += 1) {
    const out = await sched.tick();
    const run = await runView(svc, runId);
    assert.equal(attemptsOf(run)[0].status, 'running',
      `tick ${i}: evidence-less resolve is never committed`);
    if (i >= 5) assert.equal(out.artifact_blocked, 1, J(out));
  }
  const evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some((e) => e.type === 'artifact_write_failed'),
    'durable artifact_write_failed diagnostic present');
  // Operator remedies storage → the resolve completes with the full result.
  await fs.rm(stagedRoot, { force: true });
  await sched.tick();
  const run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  assert.equal(att.status, 'completed');
  assert.equal(att.result?.finalArtifactId, `art-${att.id}`);
  const artRec = run.artifacts?.[`art-${att.id}`];
  assert.ok(artRec?.stored, 'committed artifact carries its physical stored name');
  const text = await fs.readFile(
    join(runArtifactsDir(stateDir, runId), artRec.stored), 'utf8');
  assert.equal(text, big, 'the FULL pre-fault result text lands intact');
  void runtime;
});

// ==========================================================================
// 5. API outage: journal → restart → replay
// ==========================================================================

test('outage: no launches, local supervision continues, terminal resolved via staged artifact on recovery', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a', projectDir), cardFixture('card-b', projectDir)]);
  await allowTwoImplementers(env);
  const runId = await mkManagedRun(svc, 'card-a');
  const swx = { down: false };
  const m = mkSched(env, { sw: swx, behavior: { delayMs: 5 } });
  await m.sched.tick();                          // card-a launches
  const preStarts = starts(m.runtime).length;
  assert.equal(preStarts, 1, 'card-a launched');
  // Card-b gets a queued run WHILE the API is down (user commands are local).
  swx.down = true;
  const runB = await mkManagedRun(svc, 'card-b');
  void runB;
  const o1 = await m.sched.tick();
  assert.equal(o1.outage, true, J(o1));
  await waitFake();                              // card-a completes mid-outage
  const o2 = await m.sched.tick();
  assert.equal(o2.outage, true, J(o2));
  assert.equal(starts(m.runtime).length, preStarts, 'no launches during outage');
  const jrnl = await fs.readFile(m.sched._journalFile, 'utf8');
  assert.match(jrnl, /"kind":"observe"/);
  assert.match(jrnl, /"kind":"resolve"/);
  assert.match(jrnl, /"stagedArtifact":/);
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running', 'API down → nothing resolved yet');
  const runBNow = await runView(svc, runB);
  assert.equal(runBNow.status, 'queued', 'card-b run queued but never launched during outage');

  swx.down = false;
  await m.sched.tick();
  run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  assert.equal(att.status, 'completed', 'replayed resolve preserves the OBSERVED outcome');
  assert.equal(run.phase, 'awaiting_validation');
  assert.ok(att.result?.finalArtifactId, 'staged artifact committed on replay');
  const artRec2 = run.artifacts?.[`art-${att.id}`];
  assert.ok(artRec2?.stored, 'replayed commit carries its physical stored name');
  const art = await fs.readFile(
    join(runArtifactsDir(stateDir, runId), artRec2.stored), 'utf8');
  assert.equal(art, 'fake result');
});

test('outage: restart mid-outage — new instance inherits dead predecessor spool + tracked duty', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const swx = { down: false };
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(), procs: new Map(), seq: 0 };
  const A = mkSched(env, { sw: swx, registry, instanceId: 'instAA', behavior: { outcome: 'never' } });
  await A.sched.tick();
  let run = await runView(svc, runId);
  const attId = attemptsOf(run)[0].id;

  swx.down = true;
  await A.sched.tick();                          // A journals an observe + writes its snapshot
  assert.ok(A.sched._tracked.has(attId), 'A tracked its attempt');
  const aJrnl = await fs.readFile(A.sched._journalFile, 'utf8');
  assert.match(aJrnl, /"kind":"observe"/);

  // A dies hard: its recorded owner pid vanishes from the shared namespace.
  registry.procs.set(A.instPid, { exists: false });

  const B = mkSched(env, { sw: swx, registry, instanceId: 'instBB', behavior: { outcome: 'never' } });
  const ob1 = await B.sched.tick();
  assert.equal(ob1.outage, true, J(ob1));
  assert.ok(B.sched._tracked.has(attId), 'B inherited the dead predecessor\'s tracked duty');
  assert.equal(cancels(B.runtime).length, 0, 'inherited entries are never cancelled');

  swx.down = false;
  await B.sched.tick();                          // adopt (owner dead) + replay A's spool
  await B.sched.tick();
  run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  assert.ok(['running', 'cancelling'].includes(att.status), `adopted, observing: ${att.status}`);
});

test('outage: lease expiry cancels OWNED handles only; requested nonterminal stays reserved until terminal proof', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const swx = { down: false };
  let clock = Date.now();
  const m = mkSched(env, {
    sw: swx, leaseMs: 1000, now: () => clock,
    behavior: { outcome: 'never', onCancel: 'ignore' },
  });
  await m.sched.tick(); // launch + immediate first observation (sup recorded)
  let run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  const attId = att.id;
  const porchRunId = att.porchRunId;
  const supPid = att.supervisor?.pid;
  assert.ok(Number.isInteger(supPid), 'supervisor identity recorded at launch');

  // The tracked lease must equal the SERVER-RECORDED durable lease (the
  // domain clamps leaseMs to >=5s on ITS clock) — a snapshot never invents
  // one from local time. A second healthy tick refreshes it via heartbeat.
  const leaseUntil = att.owner?.leaseUntil;
  assert.ok(Number.isInteger(leaseUntil), `durable leaseUntil: ${J(att.owner)}`);
  assert.equal(m.sched._tracked.get(attId)?.leaseUntil, leaseUntil,
    'tracked lease is the authoritative server value');
  const o0 = await m.sched.tick(); // heartbeat renews → tracked lease moves forward
  assert.notEqual(o0.outage, true, J(o0));
  const lease2 = m.sched._tracked.get(attId)?.leaseUntil;
  assert.ok(Number.isInteger(lease2) && lease2 >= leaseUntil,
    `refreshed lease ${lease2} >= ${leaseUntil}`);

  // A tracked FOREIGN entry (inherited duty — owned:false) whose lease is
  // already expired must NEVER be signalled by this instance.
  m.sched._tracked.set('att-foreign', {
    cardId: 'card-a', runId: 'run-foreign', attemptId: 'att-foreign',
    porchRunId: 'no-such-run', leaseUntil: clock - 1, owned: false,
  });

  swx.down = true;
  clock = lease2 + 1; // the last SUCCESSFUL lease is now expired — API unreachable
  const o1 = await m.sched.tick();
  assert.equal(o1.outage, true, J(o1));
  const cxs = cancels(m.runtime);
  assert.equal(cxs.length, 1, 'exactly one cancel — the OWNED handle only');
  assert.equal(cxs[0].runId, porchRunId, 'cancel targeted our own runId');
  const jrnl = await fs.readFile(m.sched._journalFile, 'utf8');
  assert.match(jrnl, /"kind":"cancel"/);
  assert.match(jrnl, /lease expired during state-API outage/);
  // Cancel REQUESTED but the run is not terminal (onCancel:'ignore') — the
  // attempt stays tracked/reserved; nothing resolves, nothing relaunches.
  assert.ok(m.sched._tracked.has(attId), 'attempt still tracked');
  assert.equal(m.sched._tracked.get(attId).cancelSent, true);
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'server-side still running — the slot stays reserved');
  assert.equal(starts(m.runtime).length, 1, 'no relaunch while reserved');

  // Still nonterminal next outage tick — a requested cancel never
  // re-dispatches and the reservation is held.
  const o2 = await m.sched.tick();
  assert.equal(o2.outage, true, J(o2));
  assert.equal(cancels(m.runtime).length, 1, 'cancel request is not re-dispatched');
  assert.ok(m.sched._tracked.has(attId), 'still reserved while nonterminal');

  // The run finally lands terminal mid-outage: positive terminal + process
  // proof → a resolve intent is JOURNALED (never committed unproven).
  m.runtime._force(porchRunId, { status: 'cancelled', exitCode: 130 });
  m.runtime._setProc(supPid, { exists: false });
  const o3 = await m.sched.tick();
  assert.equal(o3.outage, true, J(o3));
  const jrnl2 = await fs.readFile(m.sched._journalFile, 'utf8');
  assert.match(jrnl2, /"kind":"resolve"/);
  assert.match(jrnl2, /lease-expiry cancel reached terminal during outage/);
  assert.equal(m.sched._tracked.has(attId), false, 'resolve journaled — duty discharged');
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'still reserved server-side — journal replay pending');

  swx.down = false;
  await m.sched.tick(); // replay applies the journaled intents THEN resolves
  run = await runView(svc, runId);
  const fin = attemptsOf(run)[0];
  // The journaled entries must have ACTUALLY replayed — distinguishable from
  // an online re-resolve by the preserved lease cause: the journal's own
  // reason strings land durably on the records.
  assert.equal(fin.status, 'cancelled', J(fin));
  assert.match(fin.cancel?.reason ?? '', /lease expired during state-API outage/,
    'journaled cancel intent applied with its lease cause');
  assert.match(fin.error ?? '', /lease-expiry cancel reached terminal during outage/,
    'journaled resolve applied — the lease cause is the durable reason');
  // Run mapping mirrors the online terminal policy: a cancelled attempt
  // under NO recorded user stop intent is a system interrupt, not a user
  // cancellation — 'interrupted', never 'cancelled'.
  assert.equal(run.status, 'interrupted', J({ s: run.status, e: run.error }));
  // Every entry was applied — the journal drains; no known-valid kind may
  // dead-letter (only irrecoverably corrupt bytes / unknown kinds may).
  const remaining = await fs.readFile(m.sched._journalFile, 'utf8').catch(() => '');
  assert.equal(remaining.trim(), '', 'journal fully drained — nothing retained');
  const dead = await fs.readFile(m.sched._deadFile, 'utf8').catch(() => '');
  assert.ok(!/"kind":"(cancel|resolve|observe|bind)"/.test(dead),
    `no valid-kind entry dead-lettered: ${dead.slice(0, 300)}`);
  assert.equal(starts(m.runtime).length, 1,
    'the terminalized run is never auto-relaunched');
});

test('events: cursor pages drain in order; a faulted drain keeps the cursor and dedups on re-read', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { runId, porchRunId, sched, runtime } = await launchRunning(env, {
    behavior: { outcome: 'never' },
  });
  const seen = () => {
    const evs = getEvents(svc, runId).then((r) => r.json);
    return evs.then((j) => (j.events || []).filter((e) => e.type === 'agent_note'));
  };
  // Page 1: five agent events land under cursor order.
  for (let i = 0; i < 5; i++) runtime._pushEvent(porchRunId, 'agent_note', `n${i}`);
  await sched.tick();
  let run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  const cursor1 = att.observer?.cursor ?? 0;
  assert.ok(cursor1 > 0, `cursor advanced: ${J(att.observer)}`);
  const first = await seen();
  assert.equal(first.length, 5, 'first page mirrored: ' + J(first.map((e) => e.data)));

  // Faulted drain: runtime.events errors are NOT cursor movement — the next
  // tick re-reads from the recorded cursor, no loss, no duplication.
  const origEvents = runtime.events.bind(runtime);
  runtime.events = async (id, opts) => {
    const r = await origEvents(id, opts);
    if (r.ok) return { ...r, ok: false, error: { code: 'injected_events_fault' } };
    return r;
  };
  for (let i = 5; i < 8; i++) runtime._pushEvent(porchRunId, 'agent_note', `n${i}`);
  await sched.tick(); // drain attempted, faulted — cursor must not move
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].observer?.cursor, cursor1,
    'faulted drain never advances the durable cursor');
  runtime.events = origEvents;

  await sched.tick(); // the same window is re-read and applied once
  run = await runView(svc, runId);
  assert.ok(attemptsOf(run)[0].observer?.cursor > cursor1, 'cursor advanced after retry');
  const all = await seen();
  assert.equal(all.length, 8, `all events exactly once: ${J(all.map((e) => e.data))}`);
  assert.deepEqual(all.map((e) => e.data), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'],
    'order preserved across the fault retry');

  // Idle drain: no events → no observer churn, no duplicates.
  const cursor2 = attemptsOf(run)[0].observer?.cursor;
  await sched.tick();
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].observer?.cursor, cursor2, 'empty page does not move the cursor');
  assert.equal((await seen()).length, 8, 'no duplicates on idle re-drain');
});

test('outage: journal write fault is fail-closed — tracked retained, tick errors, no resolve', async () => {
  const env = await mkEnv();
  const { svc, projectDir, root } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const swx = { down: false };
  const { sched } = mkSched(env, { sw: swx, behavior: { outcome: 'never' } });
  await sched.tick();
  const attId = attemptsOf(await runView(svc, runId))[0].id;
  // Break the journal dir: a regular FILE sits where the dir must be.
  await fs.rm(join(root, 'fake-exec', 'journal'), { recursive: true, force: true });
  await fs.writeFile(join(root, 'fake-exec', 'journal'), 'not a dir', 'utf8');
  swx.down = true;
  await assert.rejects(() => sched.tick(),
    (e) => e?.code === 'journal_write_failed',
    'structured journal_write_failed code');
  assert.ok(sched._tracked.has(attId), 'tracked entry retained across the persist failure');
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running', 'nothing resolved while the journal is broken');
});

test('outage: torn journal tail survives restart — preserved as corrupt, dead-lettered on replay', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const swx = { down: false };
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(), procs: new Map(), seq: 0 };
  const A = mkSched(env, { sw: swx, registry, instanceId: 'instAA', behavior: { outcome: 'never' } });
  await A.sched.tick();
  swx.down = true;
  await A.sched.tick();
  // A crashed mid-append: partial last line left in ITS spool.
  await fs.appendFile(A.sched._journalFile, '{"kind":"observe","cardId":"card-a","runId":"run_');
  registry.procs.set(A.instPid, { exists: false });

  const B = mkSched(env, { sw: swx, registry, instanceId: 'instBB', behavior: { outcome: 'never' } });
  await B.sched.tick();   // inherits A's spool including the torn tail
  swx.down = false;
  await B.sched.tick();   // adopts + replays
  await B.sched.tick();
  const dead = await fs.readFile(B.sched._deadFile, 'utf8').catch(() => '');
  assert.match(dead, /unparseable/, 'torn tail dead-lettered, never silently dropped');
  void runId;
});

test('outage: dead-letter write failure retains the original entry', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const swx = { down: false };
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(), procs: new Map(), seq: 0 };
  const A = mkSched(env, { sw: swx, registry, instanceId: 'instAA', behavior: { outcome: 'never' } });
  await A.sched.tick();
  swx.down = true;
  await A.sched.tick();          // A journals its observe into its own spool
  // Corruption lands while A is DOWN (predecessor file), never by overwriting
  // a live scheduler's authoritative in-memory list.
  await fs.appendFile(A.sched._journalFile,
    '{"kind":"bogus_kind","cardId":"card-a","runId":"r","attemptId":"a"}\n');
  registry.procs.set(A.instPid, { exists: false });

  const B = mkSched(env, { sw: swx, registry, instanceId: 'instBB', behavior: { outcome: 'never' } });
  await B.sched.tick();          // B inherits A's spool including the bogus entry
  // The deadletter path itself is broken: the dead file is a DIRECTORY.
  await fs.rm(B.sched._deadFile, { force: true });
  await fs.mkdir(B.sched._deadFile);
  swx.down = false;
  await B.sched.tick();          // replay: real entries apply; bogus → deadletter → fails → retained
  const spool = await fs.readFile(A.sched._journalFile, 'utf8');
  assert.match(spool, /bogus_kind/,
    'a deadletter failure never deletes the source spool entry');
  void runId;
});

test('outage: unproven terminal entries never expire (retained across many ticks)', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const swx = { down: false };
  const { sched, runtime } = mkSched(env, { sw: swx, behavior: { outcome: 'never' } });
  await sched.tick();
  const att = attemptsOf(await runView(svc, runId))[0];
  const pid = runtime._runs.get(att.porchRunId).pid;
  swx.down = true;
  await sched.tick();
  // Terminal metadata arrives but the supervisor is still ALIVE.
  runtime._force(att.porchRunId, { status: 'completed' });
  runtime._setProc(pid, { exists: true, state: 'R', starttime: `st-${pid}`, readable: true });
  await sched.tick();
  const jrnl = await fs.readFile(sched._journalFile, 'utf8');
  assert.match(jrnl, /terminal_unproven/, 'unproven terminal diagnosed into the journal');
  swx.down = false;
  // Recovery: the resolve is journaled only after REAL proof — with a live
  // supervisor there is none, so nothing resolves no matter how many ticks.
  for (let i = 0; i < 9; i += 1) await sched.tick();
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running',
    'an unproven terminal stays retained indefinitely — never expiring into a resolve');
});

// ==========================================================================
// 6. Snapshots: foreign / live predecessor isolation
// ==========================================================================

test('snapshot: a live same-runner snapshot is never adopted or signalled', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(), procs: new Map(), seq: 0 };
  const X = mkSched(env, { registry, instanceId: 'instXX', behavior: { outcome: 'never' } });
  await X.sched.tick(); // X launches + writes recovery-host-runner-instXX.json; X stays live
  const attId = attemptsOf(await runView(svc, runId))[0].id;
  assert.ok(X.sched._tracked.has(attId));

  const B = mkSched(env, { registry, instanceId: 'instBB', behavior: { outcome: 'never' } });
  await B.sched.tick(); // X's pid still exists in the table → no adoption, no spool take-over
  assert.ok(!B.sched._tracked.has(attId), 'live predecessor snapshot grants nothing');
  assert.equal(cancels(B.runtime).length, 0);
  const run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');
});

test('snapshot: same-runner corrupt/unreadable file degrades — never silently skipped', async () => {
  const env = await mkEnv();
  const { svc, projectDir, root } = env;
  await seedBase(svc, projectDir);
  await mkManagedRun(svc);
  const jrnlDir = join(root, 'fake-exec', 'journal');
  await fs.mkdir(jrnlDir, { recursive: true });
  await fs.writeFile(join(jrnlDir, 'recovery-host-runner-deadbeef1.json'), '{broken json', 'utf8');
  const { sched } = mkSched(env);
  const out = await sched.tick();
  assert.equal(out.journal_degraded, true, 'corrupt same-runner snapshot must degrade, not skip: ' + J(out));
  assert.equal(out.launched ?? 0, 0, 'degraded journal blocks launches');
});

// ==========================================================================
// 7. Environment registration + ops-verified retirement
// ==========================================================================

test('environments: two live same-slot registrations coexist; retirement needs exact identity', async () => {
  const env = await mkEnv({ envExtra: {} });
  const { svc, projectDir, stateDir, root } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const internalToken = await loadInternalToken(stateDir);
  const opsFile = join(root, 'ops-key');
  await fs.writeFile(opsFile, `${'ab'.repeat(24)}\n`, 'utf8');
  // A second service binding the ops key into THIS state dir (the state
  // container is the one that mounts the key).
  const svcOps = await createStateService({
    stateDir,
    env: {
      ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: root,
      ACP_OPS_TOKEN_FILE: opsFile,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    features: { start: true },
  });
  const opsToken = (await fs.readFile(opsFile, 'utf8')).trim();

  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(), procs: new Map(), seq: 0 };
  const envA = { pidNs: 'ns-A', bootId: 'fake-bootid', containerId: 'cont-A', initStarttime: 'init-A' };
  const A = mkSched(env, { registry, environment: envA, instanceId: 'instAA', behavior: { outcome: 'never' } });
  await A.sched.tick();                          // registers slot gen 1 + launches
  let run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');

  // Second live registrant on the SAME slot — a different container.
  const envB = { pidNs: 'ns-B', bootId: 'fake-bootid', containerId: 'cont-B', initStarttime: 'init-B' };
  const B = mkSched(env, { registry, environment: envB, instanceId: 'instBB', behavior: { outcome: 'never' } });
  await B.sched.tick();                          // registers slot gen 2; A's attempt untouched

  const ledger = await svc.loadEnvironments();
  const slot = ledger.slots['host-runner'];
  assert.ok(slot, J(ledger));
  assert.equal(slot.current.generation, 2, 'B registered as generation 2');
  assert.equal(slot.history.length, 1, 'gen-1 registration retained in history');
  const gen1 = slot.history[0];
  assert.equal(gen1.generation, 1);
  assert.equal(gen1.envInstance.containerId, 'cont-A');

  // A's attempt remains live+owned — registration alone never retires.
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'running');
  assert.equal(cancels(B.runtime).length, 0, 'B issued no control calls against A\'s attempt');

  // Retirement via the RUNNER credential is refused unconditionally.
  let r = await req(svcOps, 'POST', '/api/internal/environments/retire', {
    commandId: `rt-${randomUUID().slice(0, 6)}`,
    payload: {
      slot: 'host-runner', by: 'ops',
      target: { envInstance: gen1.envInstance, generation: 1 },
      evidence: { source: 'compose_lifecycle', containerId: 'cont-A', state: 'removed', observedAt: Date.now() },
    },
  }, { 'x-acp-ops-token': internalToken });
  assert.equal(r.status, 403, 'runner token is not an ops credential: ' + J(r.json));

  // Wrong generation for the exact envInstance → refused.
  r = await req(svcOps, 'POST', '/api/internal/environments/retire', {
    commandId: `rt-${randomUUID().slice(0, 6)}`,
    payload: {
      slot: 'host-runner', by: 'ops',
      target: { envInstance: gen1.envInstance, generation: 2 },
      evidence: { source: 'compose_lifecycle', containerId: 'cont-A', state: 'removed', observedAt: Date.now() },
    },
  }, { 'x-acp-ops-token': opsToken });
  assert.equal(r.status, 409, 'generation mismatch refuses: ' + J(r.json));

  // Wrong slot binding → refused.
  r = await req(svcOps, 'POST', '/api/internal/environments/retire', {
    commandId: `rt-${randomUUID().slice(0, 6)}`,
    payload: {
      slot: 'other-slot', by: 'ops',
      target: { envInstance: gen1.envInstance, generation: 1 },
      evidence: { source: 'compose_lifecycle', containerId: 'cont-A', state: 'removed', observedAt: Date.now() },
    },
  }, { 'x-acp-ops-token': opsToken });
  assert.equal(r.status, 409, 'wrong slot refuses: ' + J(r.json));

  // Wrong envInstance for the recorded generation → refused.
  r = await req(svcOps, 'POST', '/api/internal/environments/retire', {
    commandId: `rt-${randomUUID().slice(0, 6)}`,
    payload: {
      slot: 'host-runner', by: 'ops',
      target: { envInstance: { containerId: 'cont-WRONG', initStarttime: 'init-A' }, generation: 1 },
      evidence: { source: 'compose_lifecycle', containerId: 'cont-WRONG', state: 'removed', observedAt: Date.now() },
    },
  }, { 'x-acp-ops-token': opsToken });
  assert.equal(r.status, 409, 'wrong envInstance refuses: ' + J(r.json));

  // The exact record → accepted + idempotent.
  const retireBody = {
    commandId: `rt-${randomUUID().slice(0, 6)}`,
    payload: {
      slot: 'host-runner', by: 'ops',
      target: { envInstance: gen1.envInstance, generation: 1 },
      evidence: { source: 'compose_lifecycle', containerId: 'cont-A', state: 'removed', observedAt: Date.now() },
    },
  };
  r = await req(svcOps, 'POST', '/api/internal/environments/retire', retireBody, { 'x-acp-ops-token': opsToken });
  assert.equal(r.status, 200, 'exact retirement accepted: ' + J(r.json));
  const retId = r.json.result?.retirementId;
  r = await req(svcOps, 'POST', '/api/internal/environments/retire', retireBody, { 'x-acp-ops-token': opsToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.result?.retirementId, retId, 'duplicate retire is idempotent');

  // Now B may adopt A's attempt as interrupted — never relaunched.
  await B.sched.tick();
  run = await runView(svc, runId);
  assert.equal(attemptsOf(run)[0].status, 'interrupted', J(attemptsOf(run)[0]));
  assert.equal(run.status, 'interrupted', 'env-retired run parks interrupted — explicit continue governs');
  assert.equal(cancels(B.runtime).length, 0, 'retirement path never signals old pids');
});

test('environments: ops route closed without a key; identical keys fail closed', async () => {
  const env = await mkEnv();
  const { svc, stateDir } = env;
  const internalToken = await loadInternalToken(stateDir);
  // No ops key configured → route closed regardless of presented credential.
  let r = await req(svc, 'POST', '/api/internal/environments/retire',
    { commandId: 'rt-x', payload: {} }, { 'x-acp-ops-token': 'anything' });
  assert.equal(r.status, 503, J(r.json));
  r = await req(svc, 'POST', '/api/internal/environments/retire',
    { commandId: 'rt-y', payload: {} });
  assert.equal(r.status, 503, 'unconfigured route never reaches auth: ' + J(r.json));

  // Ops file content identical to THIS dir's internal token → route closed.
  const opsFile = join(env.root, 'ops-same');
  await fs.writeFile(opsFile, `${internalToken}\n`, 'utf8');
  const svc2 = await createStateService({
    stateDir,
    env: {
      ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root,
      ACP_OPS_TOKEN_FILE: opsFile,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    features: { start: true },
  });
  r = await req(svc2, 'POST', '/api/internal/environments/retire',
    { commandId: 'rt-z', payload: {} }, { 'x-acp-ops-token': internalToken });
  assert.equal(r.status, 503, 'identical ops+internal keys → route closed: ' + J(r.json));
  assert.equal(r.json.code ?? r.json.error?.code ?? r.json.detail,
    'ops_unavailable', J(r.json));

  // A CONFIGURED service with a distinct key: missing credential → 401.
  const opsFile2 = join(env.root, 'ops-real');
  await fs.writeFile(opsFile2, `${'cd'.repeat(24)}\n`, 'utf8');
  const svc3 = await createStateService({
    stateDir,
    env: {
      ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root,
      ACP_OPS_TOKEN_FILE: opsFile2,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    features: { start: true },
  });
  r = await svc3.request({
    method: 'POST', path: '/api/internal/environments/retire',
    query: new URLSearchParams(), bodyText: J({ commandId: 'rt-w', payload: {} }),
    headers: {}, // no ops header at all
  });
  assert.equal(r.status, 401, 'configured route: missing credential is 401: ' + J(r.json));
});

// ==========================================================================
// 8. change_requirements atomics
// ==========================================================================

test('change_requirements on a live run: approvals invalidated + stop intent atomically', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const { sched } = mkSched(env, { behavior: { outcome: 'never' } });
  await sched.tick();
  const cardBefore = (await getCard(svc, 'card-a')).json;
  assert.ok(cardBefore.approvals?.requirements?.versionId, 'approval bound before');

  const r = await userCmd(svc, 'card-a', 'change_requirements', { note: 'scope moved' });
  assert.equal(r.status, 200, J(r.json));
  const run = await runView(svc, runId);
  assert.equal(run.status, 'stopping', 'live run gets the stop intent');
  const card = (await getCard(svc, 'card-a')).json;
  assert.equal(card.approvals?.requirements ?? null, null,
    'requirements approval record invalidated');
  assert.equal(card.approvals?.plan ?? null, null, 'plan approval invalidated too');
  await sched.tick();
  await sched.tick();
  const run2 = await runView(svc, runId);
  assert.equal(run2.status, 'cancelled');
  // New work requires fresh approval — start refuses.
  const c2 = await getCard(svc, 'card-a');
  const st = await cmd(svc, 'card-a', {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c2.json.controlRevision, payload: {},
  });
  assert.equal(st.status, 422, 'unapproved start refused after change_requirements: ' + J(st.json));
  assert.equal(st.json.code, 'requirements_unapproved', J(st.json));
});

// ==========================================================================
// 9. Registration-gated launches
// ==========================================================================

test('registration: failed/absent generation blocks launches; retry recovers with exact generation', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const internalToken = await loadInternalToken(stateDir);

  // Registration refused (401): wrong internal token → no launch.
  const badClient = createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      if (path === '/api/internal/environments/register') {
        return { status: 401, body: { error: 'unauthorized', code: 'unauthorized' } };
      }
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : J(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
  const rt1 = createFakeRuntime({ rootDir: join(env.root, 'fake-exec') });
  const s1 = createManagedScheduler({
    client: badClient, runtime: rt1, runnerId: 'host-runner',
    instanceId: 'instNR', stateDir, env: { ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root },
  });
  const o1 = await s1.tick();
  assert.equal(starts(rt1).length, 0, 'unregistered environment must not launch');
  assert.equal(o1.registration_blocked, 1, J(o1));
  let run = await runView(svc, runId);
  assert.equal(run.status, 'queued', 'run stays queued — the launch is held, not failed');
  const evs1 = (await getEvents(svc, runId)).json;
  assert.ok((evs1.events || []).some(
    (e) => e.type === 'launch_blocked' && e.data?.code === 'environment_unregistered'),
    'durable environment_unregistered diagnostic: ' + J(evs1).slice(0, 400));

  // A 4xx LOCAL/DOMAIN refusal (422) is a launch-blocked diagnostic too.
  const unprocClient = createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      if (path === '/api/internal/environments/register') {
        return { status: 422, body: { error: 'bad slot', code: 'invalid_argument' } };
      }
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : J(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
  const s3 = createManagedScheduler({
    client: unprocClient, runtime: rt1, runnerId: 'host-runner',
    instanceId: 'instNR3', stateDir, env: { ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root },
  });
  const o3 = await s3.tick();
  assert.equal(o3.registration_blocked, 1, J(o3));
  assert.equal(starts(rt1).length, 0);

  // Registration 500s (corrupt ledger / server fault): transport-class —
  // classified as OUTAGE (>=500), held launches, owned supervision continues.
  const failClient = createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      if (path === '/api/internal/environments/register') {
        return { status: 500, body: { error: 'boom', code: 'corrupt_store' } };
      }
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : J(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
  const s2 = createManagedScheduler({
    client: failClient, runtime: rt1, runnerId: 'host-runner',
    instanceId: 'instNR2', stateDir, env: { ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root },
  });
  const o2 = await s2.tick();
  assert.equal(o2.outage, true, '5xx is transport-class outage, not a domain refusal: ' + J(o2));
  assert.equal(starts(rt1).length, 0, 'no launches during registration outage');

  // Healthy scheduler → registers, gets generation 1, launches; the owner
  // record carries that EXACT generation.
  const { sched, runtime } = mkSched(env, { behavior: { outcome: 'never' } });
  await sched.tick();
  assert.equal(starts(runtime).length, 1, 'registered scheduler launches');
  run = await runView(svc, runId);
  const owner = attemptsOf(run)[0].owner;
  assert.equal(owner.envGeneration, 1, J(owner));
  assert.equal(owner.envSlot, 'host-runner');
  assert.equal(owner.envInstance?.containerId, 'fake-container');
  void internalToken;
});

// --- seq25: Pi-specific stuck detection -------------------------------------
// Pi attempt parked in a verified epoll wait with zero IO/CPU/session-jsonl
// growth over the configured window is recovered via the normal cancel path.
// The probe target is the RECORDED immutable child identity (pid+starttime+
// namespace), never the porch supervisor. Any unknown evidence resets the
// window durably. Injectible clock — no wall-clock waits. (Fake runtime: this
// proves the helper's evidence logic, NOT live pi /proc behavior — U7 covers
// the real Compose integration.)

test('timeout: implementer role timeout cancels the owned attempt with a durable reason; reviewer launch refused (U5)', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir,
    [cardFixture('card-a', projectDir), cardFixture('card-b', projectDir)]);
  // timeoutMin lands on run.composition.preset.limits via save_preset.
  const runId = await mkManagedRun(svc, 'card-a', { preset: goodPreset({ timeoutMin: 1 }) });
  let clock = Date.now();
  const m = mkSched(env, { now: () => clock, behavior: { outcome: 'never' } });
  await m.sched.tick(); // launch + first observation; att.startedAt recorded
  let run = await runView(svc, runId);
  const attId = attemptsOf(run)[0].id;
  const porchRunId = attemptsOf(run)[0].porchRunId;
  assert.equal(cancels(m.runtime).length, 0);

  clock += 61_000; // past the 1-minute role timeout — no wall-clock wait
  await m.sched.tick();
  const cxs = cancels(m.runtime);
  assert.equal(cxs.length, 1, 'role timeout dispatched exactly one cancel');
  assert.equal(cxs[0].runId, porchRunId);
  let evs = (await getEvents(svc, runId)).json;
  assert.ok((evs.events || []).some(
    (e) => e.type === 'role_timeout' && e.data?.timeoutMin === 1),
    'durable role_timeout event carries the limit: ' + J(evs.events?.slice(-4)));

  // The fake honours the cancel → terminal on next observe → resolves
  // 'cancelled' with the durable role-timeout reason (user-stop semantics
  // preserved for non-user stops: reason names the timeout, not a user).
  await m.sched.tick();
  run = await runView(svc, runId);
  const att = attemptsOf(run)[0];
  assert.equal(att.status, 'cancelled', J(att));
  assert.equal(run.status, 'cancelled');
  assert.match(att.cancel?.reason ?? '', /role timeout 1min/,
    'durable cancel reason names the role timeout');
  assert.equal(starts(m.runtime).length, 1, 'no relaunch after timeout');

  // U5: reviewer is launchable ONLY bound to an active validation in
  // 'review' phase. A fully-formed reviewer begin_attempt on a run with no
  // live validation must refuse phase_mismatch — and never record an
  // attempt.
  const runB = await mkManagedRun(svc, 'card-b');
  const cardB = await getCard(svc, 'card-b');
  const cli = mkClient(svc, env.stateDir);
  const refusal = await cli.command('card-b', {
    commandId: `ba-review-${randomUUID().slice(0, 6)}`, type: 'begin_attempt',
    expectedInternalRevision: cardB.json.internalRevision,
    payload: {
      runId: runB, attemptId: `att-${randomUUID().slice(0, 8)}`,
      role: 'reviewer', phase: 'review', validationId: 'val-none',
      leaseMs: 1000,
      launch: {
        profileId: 'acp-reviewer', cwd: '/tmp/v/review',
        attemptDir: '/tmp/ad-r', artifactsDir: '/tmp/ad-r/artifacts',
        promptSha256: 'a'.repeat(64), configSha256: 'b'.repeat(64),
      },
      runnerId: 'host-runner', instanceId: 'inst-R', pid: 1, pidStarttime: 'x',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' },
    },
  }).catch((e) => ({ status: e.status ?? 0, code: e.code, msg: e.message }));
  assert.equal(refusal.status, 409, J(refusal));
  assert.equal(refusal.code, 'phase_mismatch', J(refusal));
  const runBAfter = await runView(svc, runB);
  assert.equal((runBAfter.attempts || []).length, 0, 'no attempt row may be recorded');
});

// Seed the recorded child's procs row with fully-known stalled evidence.
function parkChild(rt, childPid, patch = {}) {
  rt._procs.set(childPid, {
    exists: true, readable: true, state: 'S',
    starttime: `cst-${childPid}`, pidNs: 'fake-pidns',
    syscall: 'epoll_wait', ioSum: 100, cpuSum: 50, ...patch,
  });
}

test('stuck: pi child epoll-parked with zero IO/CPU and no session-log growth is cancelled after the window', async () => {
  const env = await mkEnv();
  const childPid = 91011;
  let tNow = Date.now();
  const { sched, runtime } = mkSched(env, {
    now: () => tNow, stuckMs: 120_000,
    behavior: { outcome: 'never', childPid },
  });
  await seedBase(env.svc, env.projectDir);
  const runId = await mkManagedRun(env.svc, 'card-a');
  await sched.tick();                              // launch + record-once identity
  parkChild(runtime, childPid);                    // post-launch: procs row exists now
  await sched.tick();                              // baseline probe sample
  tNow += 150_000; await sched.tick();             // stalled sample -> stuckSince armed
  let run = await runView(env.svc, runId);
  const att = attemptsOf(run)[0];
  assert.ok(att.observer?.stuckSince > 0, `window armed: ${J(att.observer)}`);
  assert.equal(att.status, 'running', J(att));
  tNow += 150_000; await sched.tick();             // 300s continuous stall -> stuck
  await sched.tick();                              // cancel dispatched + resolved
  run = await runView(env.svc, runId);
  assert.equal(run.status, 'cancelled', J(run.status));
  assert.equal(cancels(runtime).length, 1, 'exactly one cancel dispatched');
  const evt = (run.events || []).find((e) => e.type === 'stuck_detected');
  assert.ok(evt, 'durable stuck_detected event recorded');
  assert.equal(evt.data?.pid, childPid, 'evidence names the recorded PI CHILD pid');
});

test('stuck: non-pi member never gets pi-specific stuck recovery', async () => {
  const env = await mkEnv();
  const childPid = 91022;
  let tNow = Date.now();
  const { sched, runtime } = mkSched(env, {
    now: () => tNow, stuckMs: 120_000,
    behavior: { outcome: 'never', childPid },
  });
  const codexPreset = goodPreset();
  for (const k of Object.keys(codexPreset.members)) {
    codexPreset.members[k] = { cli: 'codex', model: 'gpt-5.6' };
  }
  await seedBase(env.svc, env.projectDir);
  const runId = await mkManagedRun(env.svc, 'card-a', { preset: codexPreset });
  await sched.tick();
  parkChild(runtime, childPid);
  await sched.tick();
  for (let i = 0; i < 4; i++) { tNow += 150_000; await sched.tick(); }
  const run = await runView(env.svc, runId);
  assert.equal(run.status, 'active', `codex attempt must not be stuck-cancelled: ${J(run.status)}`);
  assert.equal(cancels(runtime).length, 0);
  const att = attemptsOf(run)[0];
  assert.ok(!att.observer?.stuckSince, 'no pi stuck window recorded for non-pi cli');
});

test('stuck: an unknown/unreadable gap durably resets the window — idle restarts from fresh samples only', async () => {
  const env = await mkEnv();
  const childPid = 91033;
  let tNow = Date.now();
  const { sched, runtime } = mkSched(env, {
    now: () => tNow, stuckMs: 120_000,
    behavior: { outcome: 'never', childPid },
  });
  await seedBase(env.svc, env.projectDir);
  const runId = await mkManagedRun(env.svc, 'card-a');
  await sched.tick();
  parkChild(runtime, childPid);
  await sched.tick();                              // baseline
  tNow += 150_000; await sched.tick();             // armed
  let run = await runView(env.svc, runId);
  assert.ok(attemptsOf(run)[0].observer?.stuckSince > 0, 'armed before gap');
  // Gap: child unreadable — the armed window must NOT survive.
  runtime._procs.set(childPid, { ...runtime._procs.get(childPid), readable: false });
  tNow += 300_000; await sched.tick();             // unknown sample -> reset
  run = await runView(env.svc, runId);
  assert.equal(run.status, 'active', 'unknown evidence can never cancel');
  assert.equal(Number(attemptsOf(run)[0].observer?.stuckSince) || 0, 0,
    'stuckSince durably reset by the gap');
  // Resume: fresh baseline needed — the unknown span is not counted as idle.
  runtime._procs.set(childPid, { ...runtime._procs.get(childPid), readable: true });
  tNow += 300_000; await sched.tick();             // baseline again (prev was unreadable-era nulls? no — prev row persists) — either way re-arms, no cancel
  run = await runView(env.svc, runId);
  assert.equal(run.status, 'active', 'no cancel until a fresh full window elapses');
  assert.equal(cancels(runtime).length, 0);
  tNow += 300_000; await sched.tick();             // now the fresh window completes
  await sched.tick();
  run = await runView(env.svc, runId);
  assert.equal(run.status, 'cancelled', J(run.status));
});

// ---- U4: operator retirement helper (docker seams injected — no daemon) ----
// The helper is import-safe; every docker/proc call is a thunk. Refusals
// must fail CLOSED: running recorded instance, daemon/permission errors,
// malformed docker output, ambiguous or unbound identity never produce
// retirement evidence.

const HEX12 = 'a1b2c3d4e5f6';
const FULLID = `${HEX12}${'f'.repeat(52)}`;
assert.equal(FULLID.length, 64, 'fixture must be a full 64-hex docker id');
const STOPPED_AT = '2026-09-30T23:59:00.000000000Z';
const ins = (over) => ({
  id: FULLID, name: '/acp-state-1', hostname: HEX12,
  status: 'exited', pid: 0, startedAt: '2026-09-30T12:00:00Z',
  finishedAt: STOPPED_AT, ...over,
});
const dockerErr = (msg, code = 1) => { const e = new Error(`x: ${msg}`); e.stderr = msg; e.exitCode = code; return e; };
const retireLedger = (slot = 'exec-0', containerId = HEX12, initStarttime = '424242', generation = 7) => ({
  version: 1, rev: 1, updatedAt: 1, retirements: [], commands: {},
  slots: {
    [slot]: {
      current: {
        slot, runnerId: 'r', instanceId: 'i', envKey: 'k',
        envInstance: { containerId, initStarttime },
        pid: 1, pidStarttime: 's', registeredAt: 1, lastSeenAt: 1, generation,
      },
      history: [],
    },
  },
});
const inspectJson = (i) => J([{
  Id: i.id, Name: i.name, Config: { Hostname: i.hostname },
  State: { Status: i.status, Pid: i.pid, StartedAt: i.startedAt, FinishedAt: i.finishedAt },
}]);

test('retire: identity rules — exact id, short-id+hostname, receipt, hostname-only, no bind', () => {
  assert.equal(identityRule(FULLID, ins()), 'exact_id');
  assert.equal(identityRule(HEX12, ins()), 'short_id');
  assert.equal(identityRule(HEX12, ins({ hostname: 'other' })), null,
    'id-prefix alone does not bind — the recorded value is the in-container hostname');
  assert.equal(identityRule('custom-host', ins({ hostname: 'custom-host' })), 'hostname');
  assert.equal(identityRule('custom-host', ins({ hostname: 'other' })), null);
  assert.equal(
    identityRule('custom-host', ins({ id: 'b'.repeat(64), hostname: 'custom-host' }), 'b'.repeat(64)),
    'receipt');
  assert.equal(
    identityRule('custom-host', ins({ id: 'b'.repeat(64), hostname: 'WRONG' }), 'b'.repeat(64)), null,
    'receipt dockerId with a changed hostname does not bind');
});

test('retire: docker error classes — harder failures win over embedded NoSuch text', () => {
  assert.equal(classifyDockerError(dockerErr('Error: No such container: abc')), 'no_such_container');
  assert.equal(classifyDockerError(dockerErr('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')), 'daemon_unavailable');
  assert.equal(classifyDockerError(dockerErr('Got permission denied while trying to connect')), 'permission_denied');
  assert.equal(
    classifyDockerError(dockerErr('Got permission denied ... No such container: abc')),
    'permission_denied', 'embedded NoSuch inside a permission failure is NOT absence');
  assert.equal(classifyDockerError(dockerErr('multiple IDs found with prefix a1b2')), 'ambiguous');
  const spawn = new Error('spawn docker ENOENT'); spawn.code = 'ENOENT';
  assert.equal(classifyDockerError(spawn), 'docker_missing');
  assert.equal(classifyDockerError(dockerErr('some other failure')), 'docker_failed');
});

test('retire: strict docker output parsing — malformed/empty/multi/non-full-id all refuse', () => {
  const good = inspectJson(ins());
  assert.equal(parseInspectStdout(good).id, FULLID);
  assert.throws(() => parseInspectStdout('not json'), /malformed/);
  assert.throws(() => parseInspectStdout('[]'), /exactly one/);
  assert.throws(() => parseInspectStdout(J([{ Id: FULLID }, { Id: FULLID }])), /exactly one/);
  assert.throws(() => parseInspectStdout(J([{ Id: 'short', State: { Status: 'exited' } }])), /full Id/);
  assert.throws(() => parseInspectStdout(J([{ Id: FULLID }])), /State/);
  assert.deepEqual(parseIdListStdout(`${FULLID}\n${'e'.repeat(64)}\n`), [FULLID, 'e'.repeat(64)]);
  assert.throws(() => parseIdListStdout('a1b2c3d4e5f6\n'), /non-full id/,
    'a truncated id list must fail closed, never enumerate wrongly');
});

test('retire: stopped identity-bearing container -> stopped; no carrier -> removed', async () => {
  const map = new Map([[FULLID, ins()]]);
  const seams = {
    inspect: async (ref) => (map.has(ref) ? map.get(ref)
      : [...map.values()].find((c) => c.id.startsWith(ref)) || (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [...map.keys()],
    hostProcStarttime: () => { throw new Error('must not probe a stopped container'); },
  };
  const v1 = await verifyLifecycle({ recorded: HEX12, initStarttime: '424242', ...seams });
  assert.equal(v1.ok, true); assert.equal(v1.state, 'stopped');
  assert.equal(v1.observedAt, STOPPED_AT, 'stopped evidence carries the immutable FinishedAt');
  const v2 = await verifyLifecycle({
    recorded: HEX12, initStarttime: '424242',
    inspect: async () => { throw dockerErr('No such container'); },
    listIds: async () => ['e'.repeat(64)],
    hostProcStarttime: () => null,
  });
  assert.equal(v2.ok, true); assert.equal(v2.state, 'removed',
    'the recorded id-prefix absent from every container = the recorded instance is gone');
  map.set('c'.repeat(64), ins({ id: 'c'.repeat(64), hostname: 'other', status: 'running', pid: 900 }));
  const v3 = await verifyLifecycle({ recorded: HEX12, initStarttime: '424242', ...seams });
  assert.equal(v3.ok, true); assert.equal(v3.state, 'stopped');
});

test('retire: live recorded refuses; bound live successor proves removed; unreadable proc refuses', async () => {
  const live = ins({ status: 'running', pid: 5150, finishedAt: null });
  const seams = {
    inspect: async (ref) => (ref === HEX12 || ref === FULLID ? live : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [FULLID],
    hostProcStarttime: (pid) => (pid === 5150 ? '424242' : null),
  };
  const v1 = await verifyLifecycle({ recorded: HEX12, initStarttime: '424242', ...seams });
  assert.equal(v1.ok, false); assert.equal(v1.code, 'live_recorded');
  const v2 = await verifyLifecycle({
    recorded: HEX12, initStarttime: '424242',
    inspect: seams.inspect, listIds: seams.listIds, hostProcStarttime: () => '999999',
  });
  assert.equal(v2.ok, true); assert.equal(v2.state, 'removed');
  assert.match(v2.detail, /DIFFERENT live instance/);
  const v3 = await verifyLifecycle({
    recorded: HEX12, initStarttime: '424242',
    inspect: seams.inspect, listIds: seams.listIds, hostProcStarttime: () => null,
  });
  assert.equal(v3.ok, false); assert.equal(v3.code, 'live_unverifiable');
});

test('retire: daemon errors, malformed records, ambiguity, unknown status, unbound hostname all refuse', async () => {
  const base = { recorded: HEX12, initStarttime: '424242', hostProcStarttime: () => null };
  const v1 = await verifyLifecycle({
    ...base,
    inspect: async () => { throw dockerErr('Cannot connect to the Docker daemon'); },
    listIds: async () => [],
  });
  assert.equal(v1.ok, false); assert.match(v1.code, /^docker_daemon_unavailable$/);
  const v2 = await verifyLifecycle({
    ...base,
    inspect: async () => { throw dockerErr('No such container'); },
    listIds: async () => { throw dockerErr('Got permission denied'); },
  });
  assert.equal(v2.ok, false); assert.match(v2.code, /^docker_permission_denied$/);
  // Malformed inspect record (non-full id) is not "absence".
  const v3 = await verifyLifecycle({
    ...base,
    inspect: async () => ({ id: 'short', hostname: HEX12, status: 'exited', pid: 0 }),
    listIds: async () => [],
  });
  assert.equal(v3.ok, false); assert.equal(v3.code, 'docker_malformed');
  // Two distinct containers BOTH binding by exact docker identity (same
  // 12-hex id prefix = docker's ambiguous-prefix case) -> refuse.
  const a = ins();
  const b = ins({ id: `${HEX12}${'b'.repeat(52)}` });
  const v4 = await verifyLifecycle({
    ...base,
    inspect: async (ref) => (ref === HEX12 ? a : ref === a.id ? a : ref === b.id ? b : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [a.id, b.id],
  });
  assert.equal(v4.ok, false); assert.equal(v4.code, 'ambiguous_identity');
  // A bound stopped carrier + a merely hostname-matched stranger is NOT
  // ambiguous — the bound identity is authoritative; stranger recorded.
  const stranger = ins({ id: 'b'.repeat(64) }); // same hostname, foreign id
  const v4b = await verifyLifecycle({
    ...base,
    inspect: async (ref) => {
      if (ref === HEX12 || ref === a.id) return a;
      if (ref === stranger.id) return stranger;
      throw dockerErr('No such container');
    },
    listIds: async () => [a.id, stranger.id],
  });
  assert.equal(v4b.ok, true); assert.equal(v4b.state, 'stopped');
  assert.equal(v4b.candidates.length, 2, 'the stranger is surfaced in candidates, not silently dropped');
  // Unknown status is never silently bucketed as stopped.
  const weird = ins({ status: 'removing' });
  const v5 = await verifyLifecycle({
    ...base,
    inspect: async (ref) => (ref === HEX12 || ref === FULLID ? weird : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [FULLID],
  });
  assert.equal(v5.ok, false); assert.equal(v5.code, 'status_unknown');
  // Custom hostname WITHOUT a receipt: nothing proves identity — refuses
  // even when no container bears the hostname at all.
  const v6 = await verifyLifecycle({
    recorded: 'custom-host', initStarttime: '424242',
    inspect: async () => { throw dockerErr('No such container'); },
    listIds: async () => [], hostProcStarttime: () => null,
  });
  assert.equal(v6.ok, false); assert.equal(v6.code, 'unbound_custom_hostname');
  const stoppedCustom = ins({ id: 'd'.repeat(64), hostname: 'custom-host', status: 'exited' });
  const v7 = await verifyLifecycle({
    recorded: 'custom-host', initStarttime: '424242',
    inspect: async (ref) => (ref === 'd'.repeat(64) ? stoppedCustom : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => ['d'.repeat(64)], hostProcStarttime: () => null,
  });
  assert.equal(v7.ok, false); assert.equal(v7.code, 'unbound_custom_hostname');
});

test('retire: receipt-bound lifecycle — stopped/removed/live-verdicts via pinned docker Id', async () => {
  const rid = 'd'.repeat(64);
  const receipt = { containerId: 'custom-host', initStarttime: '424242', dockerId: rid, bootId: 'boot-1' };
  const stoppedC = ins({ id: rid, hostname: 'custom-host', status: 'exited' });
  const v1 = await verifyLifecycle({
    recorded: 'custom-host', initStarttime: '424242', receipt,
    inspect: async (ref) => (ref === rid ? stoppedC : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [rid], hostProcStarttime: () => null,
  });
  assert.equal(v1.ok, true); assert.equal(v1.state, 'stopped');
  const v2 = await verifyLifecycle({
    recorded: 'custom-host', initStarttime: '424242', receipt,
    inspect: async () => { throw dockerErr('No such container'); },
    listIds: async () => [], hostProcStarttime: () => null,
  });
  assert.equal(v2.ok, true); assert.equal(v2.state, 'removed');
  // Live receipt-bound container with a DIFFERENT init starttime = a
  // successor holds the bound identity -> recorded instance gone.
  const liveC = ins({ id: rid, hostname: 'custom-host', status: 'running', pid: 777 });
  const v3 = await verifyLifecycle({
    recorded: 'custom-host', initStarttime: '424242', receipt,
    inspect: async (ref) => (ref === rid ? liveC : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [rid], hostProcStarttime: () => '999',
  });
  assert.equal(v3.ok, true); assert.equal(v3.state, 'removed');
  const v4 = await verifyLifecycle({
    recorded: 'custom-host', initStarttime: '424242', receipt,
    inspect: async (ref) => (ref === rid ? liveC : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [rid], hostProcStarttime: () => '424242',
  });
  assert.equal(v4.ok, false); assert.equal(v4.code, 'live_recorded');
  // Receipt envInstance mismatch -> refuse before docker.
  const v5 = await verifyLifecycle({
    recorded: 'custom-host', initStarttime: '424242',
    receipt: { ...receipt, initStarttime: 'OTHER' },
    inspect: async () => { throw new Error('docker must not be called'); },
    listIds: async () => [], hostProcStarttime: () => null,
  });
  assert.equal(v5.ok, false); assert.equal(v5.code, 'receipt_mismatch');
});

test('retire: real route — command envelope applied via production service, CLI-retry dedup, wrong ops token refused', async () => {
  const opsDir = join(tmpdir(), `u4-ops-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(opsDir);
  await fs.mkdir(opsDir, { recursive: true });
  const opsFile = join(opsDir, 'ops-token');
  const opsTok = 'f'.repeat(48);
  await fs.writeFile(opsFile, `${opsTok}\n`, { mode: 0o600 });
  const env = await mkEnv({ envExtra: { ACP_OPS_TOKEN_FILE: opsFile } });
  await saveEnvironments(env.stateDir, retireLedger());   // canonical writer
  let postCalls = 0;
  const post = async (_url, body, tok) => {
    postCalls += 1;
    const r = await env.svc.request({
      method: 'POST', path: '/api/internal/environments/retire',
      query: new URLSearchParams(), bodyText: J(body),
      headers: { 'x-acp-ops-token': tok },
    });
    return { status: r.status, body: r.json };
  };
  const docker = {
    inspect: async (ref) => (ref === HEX12 || ref === FULLID ? ins() : (() => { throw dockerErr('No such container'); })()),
    listIds: async () => [FULLID],
  };
  let printed = '';
  const out = (s) => { printed += `${s}\n`; };
  const argv = ['--slot', 'exec-0', '--container-id', HEX12, '--init-starttime', '424242',
    '--generation', '7', '--command-id', 'ret-u4test-1', '--state-dir', env.stateDir];
  // 1) wrong ops token -> route 403 -> exit 4, nothing written.
  const c0 = await retireMain(argv, {
    inspect: docker.inspect, listIds: docker.listIds, hostProcStarttime: () => null,
    opsToken: 'a'.repeat(48), post, stdout: out, stderr: out,
  });
  assert.equal(c0, 4);
  let doc = await loadEnvironments(env.stateDir);
  assert.equal(doc.retirements.length, 0, 'a forbidden post writes no retirement');
  // 2) correct token -> applied: retirement record + command dedup entry.
  const c1 = await retireMain(argv, {
    inspect: docker.inspect, listIds: docker.listIds, hostProcStarttime: () => null,
    opsToken: opsTok, post, stdout: out, stderr: out,
  });
  assert.equal(c1, 0, printed);
  assert.match(printed, /commandId=ret-u4test-1/);
  doc = await loadEnvironments(env.stateDir);
  assert.equal(doc.retirements.length, 1);
  const rec = doc.retirements[0];
  assert.equal(rec.slot, 'exec-0');
  assert.deepEqual(rec.envInstance, { containerId: HEX12, initStarttime: '424242' });
  assert.equal(rec.generation, 7);
  assert.equal(rec.evidence.source, 'compose_lifecycle');
  assert.equal(rec.evidence.state, 'stopped');
  assert.equal(rec.evidence.observedAt, STOPPED_AT, 'deterministic evidence timestamp from docker');
  assert.equal(doc.slots['exec-0'].current.retiredAt, doc.retirements[0].retiredAt);
  assert.ok(doc.commands['ret-u4test-1'], 'commandId recorded for replay dedup');
  // 3) CLI twice with the SAME command-id: the second run sees the durable
  //    retirement and short-circuits BEFORE docker/post — retry is a clean
  //    no-op even though evidence timestamps could differ.
  const postsAfterFirst = postCalls;
  printed = '';
  const c2 = await retireMain(argv, {
    inspect: docker.inspect, listIds: docker.listIds, hostProcStarttime: () => null,
    opsToken: opsTok, post, stdout: out, stderr: out,
  });
  assert.equal(c2, 0);
  assert.match(printed, /already retired/);
  assert.equal(postCalls, postsAfterFirst, 'idempotent retry never reaches the route');
  doc = await loadEnvironments(env.stateDir);
  assert.equal(doc.retirements.length, 1);
  // 4) domain replay path itself: posting the EXACT same command body again
  //    returns the recorded response (commandId+payloadHash dedup).
  const cmdBody = buildRetireCommand({
    slot: 'exec-0', by: 't', envInstance: { containerId: HEX12, initStarttime: '424242' },
    generation: 7, evidence: { source: 'compose_lifecycle', containerId: HEX12, state: 'stopped', observedAt: STOPPED_AT },
    commandId: 'ret-u4test-2',
  });
  const r1 = await post(null, cmdBody, opsTok);
  const r2 = await post(null, cmdBody, opsTok);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(r2.body.ok, true);
  doc = await loadEnvironments(env.stateDir);
  assert.equal(doc.retirements.length, 1, 'replayed commandId adds no second record');
  // 5) same commandId + DIFFERENT payload -> 409 command_conflict.
  const r3 = await post(null, { ...cmdBody, payload: { ...cmdBody.payload, by: 'other' } }, opsTok);
  assert.equal(r3.status, 409); assert.equal(r3.body.code, 'command_conflict');
  // 6) ops key absent on the service -> route closed 503 -> exit 4.
  const env2 = await mkEnv();
  await saveEnvironments(env2.stateDir, retireLedger());
  const c4 = await retireMain(
    [...argv.slice(0, -2), '--state-dir', env2.stateDir],
    {
      inspect: docker.inspect, listIds: docker.listIds, hostProcStarttime: () => null,
      opsToken: opsTok, stdout: out, stderr: out,
      post: async (_u, body, tok) => {
        const r = await env2.svc.request({
          method: 'POST', path: '/api/internal/environments/retire',
          query: new URLSearchParams(), bodyText: J(body),
          headers: { 'x-acp-ops-token': tok },
        });
        return { status: r.status, body: r.json };
      },
    });
  assert.equal(c4, 4);
});

test('retire: ledger binding precedes docker; dry-run prints command, writes nothing', async () => {
  let dockerCalls = 0;
  const neverDocker = async () => { dockerCalls += 1; throw dockerErr('No such container'); };
  const c1 = await retireMain(
    ['--slot', 'exec-0', '--container-id', HEX12, '--init-starttime', '424242', '--generation', '8'],
    { ledger: retireLedger(), runDocker: neverDocker, stdout: () => {}, stderr: () => {} });
  assert.equal(c1, 2); assert.equal(dockerCalls, 0, 'no docker call before ledger binding');
  const c1b = await retireMain(
    ['--slot', '../etc', '--container-id', HEX12, '--init-starttime', '424242', '--generation', '7'],
    { ledger: retireLedger(), runDocker: neverDocker, stdout: () => {}, stderr: () => {} });
  assert.equal(c1b, 2); assert.equal(dockerCalls, 0);
  const c1d = await retireMain(
    ['--slot', 'exec-0', '--container-id', HEX12, '--bogus-flag', 'x'],
    { ledger: retireLedger(), runDocker: neverDocker, stdout: () => {}, stderr: () => {} });
  assert.equal(c1d, 2); assert.equal(dockerCalls, 0, 'unknown flag refuses before everything');
  // Malformed ledger via canonical loader -> exit 2.
  const badDir = join(tmpdir(), `u4-badledger-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(badDir);
  const canon = join(badDir, 'execution', 'state');
  await fs.mkdir(canon, { recursive: true });
  await fs.writeFile(join(canon, 'environments.json'), '{"version":99}');
  const c1c = await retireMain(
    ['--slot', 'exec-0', '--container-id', HEX12, '--init-starttime', '424242', '--generation', '7',
      '--state-dir', badDir],
    { runDocker: neverDocker, stdout: () => {}, stderr: () => {} });
  assert.equal(c1c, 2); assert.equal(dockerCalls, 0);
  // Dry-run over real docker seams: stopped -> command printed, zero writes.
  const chunks = []; let posted = null;
  const docker = async (_bin, args) => {
    if (args[0] === 'inspect') return { stdout: inspectJson(ins()) };
    if (args[0] === 'ps') return { stdout: `${FULLID}\n` };
    throw new Error('unexpected docker args');
  };
  const c2 = await retireMain(
    ['--slot', 'exec-0', '--container-id', HEX12, '--init-starttime', '424242', '--generation', '7',
      '--dry-run', '--command-id', 'ret-dry-1'],
    {
      ledger: retireLedger(), runDocker: docker, hostProcStarttime: () => null,
      stdout: (s) => chunks.push(s), stderr: () => {},
      post: async () => { posted = true; return { status: 500, body: null }; },
    });
  assert.equal(c2, 0);
  assert.equal(posted, null, 'dry-run never posts');
  // The command body is the single stdout chunk that is a JSON object.
  const cmdJson = JSON.parse(chunks.find((c) => c.trim().startsWith('{') && c.includes('retire_environment')));
  assert.equal(cmdJson.commandId, 'ret-dry-1');
  assert.equal(cmdJson.type, 'retire_environment');
  assert.equal(cmdJson.payload.slot, 'exec-0');
  assert.deepEqual(cmdJson.payload.target.envInstance, { containerId: HEX12, initStarttime: '424242' });
  assert.equal(cmdJson.payload.target.generation, 7);
  assert.equal(cmdJson.payload.evidence.source, 'compose_lifecycle');
  assert.equal(cmdJson.payload.evidence.state, 'stopped');
  assert.equal(cmdJson.payload.evidence.observedAt, STOPPED_AT);
  // Live recorded instance -> exit 3, no post.
  const liveDocker = async (_bin, args) => {
    if (args[0] === 'inspect') return { stdout: inspectJson(ins({ status: 'running', pid: 5150, finishedAt: null })) };
    if (args[0] === 'ps') return { stdout: `${FULLID}\n` };
    throw new Error('unexpected');
  };
  const c3 = await retireMain(
    ['--slot', 'exec-0', '--container-id', HEX12, '--init-starttime', '424242', '--generation', '7'],
    {
      ledger: retireLedger(), runDocker: liveDocker, hostProcStarttime: () => '424242',
      stdout: () => {}, stderr: () => {},
      post: async () => { posted = true; return { status: 200, body: {} }; },
    });
  assert.equal(c3, 3); assert.equal(posted, null, 'live recorded instance never posts');
});

test('retire: --record binds only a verified unique live instance; dry-run writes nothing', async () => {
  const dir = join(tmpdir(), `u4-receipts-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  const ledger = retireLedger('exec-1', 'custom-host', '777', 2);
  const runningCustom = ins({ id: 'd'.repeat(64), name: '/acp-runner', hostname: 'custom-host', status: 'running', pid: 7770, finishedAt: null });
  const docker = async (_bin, args) => {
    if (args[0] === 'inspect') return { stdout: inspectJson(runningCustom) };
    if (args[0] === 'ps') return { stdout: `${'d'.repeat(64)}\n` };
    throw new Error('unexpected');
  };
  // Custom hostname via unique enumeration + live starttime match -> receipt.
  const c1 = await retireMain(
    ['--slot', 'exec-1', '--container-id', 'custom-host', '--init-starttime', '777', '--generation', '2',
      '--record', '--receipts-dir', dir],
    { ledger, runDocker: docker, hostProcStarttime: () => '777', bootId: 'boot-1', stdout: () => {}, stderr: () => {} });
  assert.equal(c1, 0);
  const rp = receiptPath(dir, 'exec-1', 2);
  const receipt = JSON.parse(await fs.readFile(rp, 'utf8'));
  assert.equal(receipt.dockerId, 'd'.repeat(64));
  assert.equal(receipt.bootId, 'boot-1');
  assert.equal((await fs.lstat(rp)).mode & 0o777, 0o600);
  // --docker-id path pins the exact identity without hostname lookup.
  const c1b = await retireMain(
    ['--slot', 'exec-1', '--container-id', 'custom-host', '--init-starttime', '777', '--generation', '2',
      '--record', '--receipts-dir', dir, '--docker-id', 'd'.repeat(64)],
    { ledger, runDocker: docker, hostProcStarttime: () => '777', bootId: 'boot-1', stdout: () => {}, stderr: () => {} });
  assert.equal(c1b, 0);
  // Stopped container can NEVER mint a binding.
  const stoppedDocker = async (_bin, args) => {
    if (args[0] === 'inspect') return { stdout: inspectJson({ ...runningCustom, status: 'exited', pid: 0 }) };
    if (args[0] === 'ps') return { stdout: `${'d'.repeat(64)}\n` };
    throw new Error('unexpected');
  };
  const c2 = await retireMain(
    ['--slot', 'exec-1', '--container-id', 'custom-host', '--init-starttime', '777', '--generation', '2',
      '--record', '--receipts-dir', join(dir, 'sub2'), '--docker-id', 'd'.repeat(64)],
    { ledger, runDocker: stoppedDocker, hostProcStarttime: () => null, bootId: 'boot-1', stdout: () => {}, stderr: () => {} });
  assert.equal(c2, 2);
  assert.ok(!(await fs.stat(join(dir, 'sub2')).then(() => true).catch(() => false)), 'no receipt for a stopped container');
  // Mismatched live init starttime -> refuse.
  const c3 = await retireMain(
    ['--slot', 'exec-1', '--container-id', 'custom-host', '--init-starttime', '777', '--generation', '2',
      '--record', '--receipts-dir', join(dir, 'sub3'), '--docker-id', 'd'.repeat(64)],
    { ledger, runDocker: docker, hostProcStarttime: () => '888', bootId: 'boot-1', stdout: () => {}, stderr: () => {} });
  assert.equal(c3, 2);
  // Two containers bearing the hostname -> ambiguous, refuse.
  const e64 = 'e'.repeat(64); const d64 = 'd'.repeat(64);
  const twoDocker = async (_bin, args) => {
    if (args[0] === 'inspect') {
      const rec = args[1] === d64 ? runningCustom : ins({ ...runningCustom, id: e64 });
      return { stdout: inspectJson(rec) };
    }
    if (args[0] === 'ps') return { stdout: `${d64}\n${e64}\n` };
    throw new Error('unexpected');
  };
  const c4 = await retireMain(
    ['--slot', 'exec-1', '--container-id', 'custom-host', '--init-starttime', '777', '--generation', '2',
      '--record', '--receipts-dir', join(dir, 'sub4')],
    { ledger, runDocker: twoDocker, hostProcStarttime: () => '777', bootId: 'boot-1', stdout: () => {}, stderr: () => {} });
  assert.equal(c4, 2);
  // dry-run --record prints but never writes.
  const c5 = await retireMain(
    ['--slot', 'exec-1', '--container-id', 'custom-host', '--init-starttime', '777', '--generation', '2',
      '--record', '--receipts-dir', join(dir, 'sub5'), '--dry-run', '--docker-id', 'd'.repeat(64)],
    { ledger, runDocker: docker, hostProcStarttime: () => '777', bootId: 'boot-1', stdout: () => {}, stderr: () => {} });
  assert.equal(c5, 0);
  assert.ok(!(await fs.stat(join(dir, 'sub5')).then(() => true).catch(() => false)), 'dry-run --record writes nothing');
  const tokFile = join(dir, 'ops-token');
  await fs.writeFile(tokFile, `${'a'.repeat(48)}\n`);
  assert.equal(readOpsTokenFile(tokFile), 'a'.repeat(48));
  await fs.writeFile(tokFile, 'short\n');
  assert.throws(() => readOpsTokenFile(tokFile), /malformed/);
});

test('retire: receipt load — absent ok, corrupt/foreign/symlink/broad-mode/boot-mismatch all refuse', async () => {
  const dir = join(tmpdir(), `u4-rcpt-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(dir, { recursive: true });
  const ctx = { slot: 'exec-1', envInstance: { containerId: 'custom-host', initStarttime: '777' }, generation: 2, bootId: 'boot-1' };
  const good = { format: 'acp-env-receipt/1', slot: 'exec-1', generation: 2, containerId: 'custom-host', initStarttime: '777', dockerId: 'd'.repeat(64), bootId: 'boot-1' };
  let r = loadReceipt(join(dir, 'none.json'), ctx);
  assert.equal(r.ok, false); assert.equal(r.code, 'receipt_absent');
  const f = join(dir, 'good.json');
  writeReceiptAtomic(f, good);
  r = loadReceipt(f, ctx);
  assert.equal(r.ok, true); assert.equal(r.receipt.dockerId, 'd'.repeat(64));
  assert.equal(loadReceipt(f, { ...ctx, slot: 'exec-2' }).code, 'receipt_mismatch');
  assert.equal(loadReceipt(f, { ...ctx, generation: 9 }).code, 'receipt_mismatch');
  assert.equal(loadReceipt(f, { ...ctx, envInstance: { containerId: 'other', initStarttime: '777' } }).code, 'receipt_mismatch');
  assert.equal(loadReceipt(f, { ...ctx, bootId: 'boot-2' }).code, 'receipt_mismatch');
  assert.equal(loadReceipt(f, { ...ctx, bootId: null }).code, 'boot_id_unknown');
  await fs.chmod(f, 0o644);
  assert.equal(loadReceipt(f, ctx).code, 'receipt_unsafe');
  await fs.chmod(f, 0o600);
  const link = join(dir, 'link.json');
  await fs.symlink(f, link);
  assert.equal(loadReceipt(link, ctx).code, 'receipt_unsafe');
  const bad = join(dir, 'bad.json');
  await fs.writeFile(bad, '{oops', { mode: 0o600 });
  assert.equal(loadReceipt(bad, ctx).code, 'receipt_corrupt');
  const short = join(dir, 'short.json');
  writeReceiptAtomic(short, { ...good, dockerId: 'abc123' });
  assert.equal(loadReceipt(short, ctx).code, 'receipt_corrupt');
  // A symlink at the receipt TARGET is replaced by the atomic write, not followed.
  const tgt = join(dir, 'tgt.json');
  const victim = join(dir, 'victim.json');
  await fs.writeFile(victim, 'ORIGINAL', { mode: 0o600 });
  await fs.symlink(victim, tgt);
  writeReceiptAtomic(tgt, good);
  assert.equal((await fs.readFile(victim, 'utf8')), 'ORIGINAL', 'rename must not follow a symlinked target');
  assert.equal(loadReceipt(tgt, ctx).ok, true);
});

// ---- U4: pi session-log seam — real start() record drives the reader ----
// The reader resolves ONLY through the launch record's persisted pi.sessionDir
// (computed from the EFFECTIVE launch env incl. params.env). Installed pi
// contract: PI_CODING_AGENT_SESSION_DIR flat > PI_CODING_AGENT_DIR/sessions/
// --<resolved-cwd-slug>-- > $HOME/.pi/agent/sessions/--<slug>--. Synthetic
// files stand in for a real pi run — live jsonl growth proof is U7.

const fakePorchSpawn = (captured) => async (argv, opts) => {
  captured.push({ argv, env: opts.env });
  opts.onSpawn?.({ pid: 0xbeef });
  return {
    code: 0, signal: null, timedOut: false, observationCut: false,
    durationMs: 1, stdout: 'run_pi_fake1\n', stderr: '', spawnError: null,
  };
};

test('pi: sessionLog reads the persisted launch-time session dir across a runtime restart', async () => {
  const root = join(tmpdir(), `u4-pisess-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const execRoot = join(root, 'exec');
  const home = join(root, 'home');
  const cwd = join(root, 'ws-alpha');
  await fs.mkdir(cwd, { recursive: true });
  const captured = [];
  const rt = createPorchRuntime({
    env: { HOME: home, PATH: '/usr/bin' }, rootDir: execRoot,
    porchPath: '/fake/porch', spawn: fakePorchSpawn(captured),
  });
  const st = await rt.start({ attemptId: 'att77', profileId: 'pi-default', cwd, prompt: 'do it', config: { backend: 'pi-cli' } });
  assert.equal(st.ok, true, J(st.error));
  // The recorded dir = launch-time resolved $HOME/.pi/agent/sessions/<slug>/.
  const rec = await rt.launchRecord('att77');
  const expectDir = join(home, '.pi', 'agent', 'sessions', `--${cwd.slice(1).replace(/[/\\:]/g, '-')}--`);
  assert.equal(rec.pi.sessionDir, expectDir);
  assert.equal(rec.pi.sessionId, 'acp-att77');
  const logPath = join(expectDir, '1700000000000_acp-att77.jsonl');
  await fs.mkdir(expectDir, { recursive: true });
  await fs.writeFile(logPath, '{"x":1}\n');
  // A RECREATED runtime (restart) with a DIFFERENT base env still resolves
  // through the immutable record — never process.env or new baseEnv.
  const rt2 = createPorchRuntime({ env: { HOME: join(root, 'WRONG') }, rootDir: execRoot, spawn: fakePorchSpawn([]) });
  const r1 = await rt2.sessionLog('att77');
  assert.equal(r1.ok, true); assert.equal(r1.path, logPath);
  // process.env pointing at a foreign sessions root is never consulted.
  const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'foreign');
  try {
    const r2 = await rt2.sessionLog('att77');
    assert.equal(r2.ok, true); assert.equal(r2.path, logPath);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prev;
  }
});

test('pi: params.env overrides resolve at launch — custom agent dir, flat session dir, colon cwd', async () => {
  const root = join(tmpdir(), `u4-pisess2-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const execRoot = join(root, 'exec');
  const home = join(root, 'home');
  const cwd = join(root, 'ws-beta');
  await fs.mkdir(cwd, { recursive: true });
  const rt = createPorchRuntime({
    env: { HOME: home, PATH: '/usr/bin' }, rootDir: execRoot,
    porchPath: '/fake/porch', spawn: fakePorchSpawn([]),
  });
  // PI_CODING_AGENT_DIR override via params.env (per-attempt env, not baseEnv).
  const agentDir = join(root, 'custom-agent');
  const st1 = await rt.start({
    attemptId: 'att88', profileId: 'pi-default', cwd, prompt: 'x',
    config: { backend: 'pi-cli' }, env: { PI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(st1.ok, true, J(st1.error));
  const rec1 = await rt.launchRecord('att88');
  const dir1 = join(agentDir, 'sessions', `--${cwd.slice(1).replace(/[/\\:]/g, '-')}--`);
  assert.equal(rec1.pi.sessionDir, dir1);
  await fs.mkdir(dir1, { recursive: true });
  const p1 = join(dir1, '1700000000001_acp-att88.jsonl');
  await fs.writeFile(p1, '{}\n');
  assert.equal((await rt.sessionLog('att88')).path, p1);
  // PI_CODING_AGENT_SESSION_DIR is a FLAT dir (installed pi --session-dir
  // semantics) — no cwd slug appended.
  const flat = join(root, 'flat-sessions');
  const st2 = await rt.start({
    attemptId: 'att99', profileId: 'pi-default', cwd, prompt: 'x',
    config: { backend: 'pi-cli' }, env: { PI_CODING_AGENT_DIR: join(root, 'ignored'), PI_CODING_AGENT_SESSION_DIR: flat },
  });
  assert.equal(st2.ok, true, J(st2.error));
  const rec2 = await rt.launchRecord('att99');
  assert.equal(rec2.pi.sessionDir, flat);
  await fs.mkdir(flat, { recursive: true });
  const p2 = join(flat, '1700000000002_acp-att99.jsonl');
  await fs.writeFile(p2, '{}\n');
  assert.equal((await rt.sessionLog('att99')).path, p2);
  // cwd containing ':' — the installed slug maps ':' to '-' too.
  const colonCwd = join(root, 'ws:gamma');
  await fs.mkdir(colonCwd, { recursive: true });
  const st3 = await rt.start({ attemptId: 'att55', profileId: 'pi-default', cwd: colonCwd, prompt: 'x', config: { backend: 'pi-cli' } });
  assert.equal(st3.ok, true);
  const rec3 = await rt.launchRecord('att55');
  const dir3 = join(home, '.pi', 'agent', 'sessions', `--${colonCwd.slice(1).replace(/[/\\:]/g, '-')}--`);
  assert.equal(rec3.pi.sessionDir, dir3);
  await fs.mkdir(dir3, { recursive: true });
  const p3 = join(dir3, 't_acp-att55.jsonl');
  await fs.writeFile(p3, '{}\n');
  assert.equal((await rt.sessionLog('att55')).path, p3);
});

test('pi: sessionLog failure semantics — unrecorded, missing, ambiguous, unreadable, bad ids', async () => {
  const root = join(tmpdir(), `u4-pisess3-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const execRoot = join(root, 'exec');
  const home = join(root, 'home');
  const cwd = join(root, 'ws-x');
  await fs.mkdir(cwd, { recursive: true });
  const rt = createPorchRuntime({
    env: { HOME: home, PATH: '/usr/bin' }, rootDir: execRoot,
    porchPath: '/fake/porch', spawn: fakePorchSpawn([]),
  });
  // No launch record at all -> unrecorded, never missing-as-zero-growth.
  const r0 = await rt.sessionLog('att-nope');
  assert.equal(r0.ok, false); assert.equal(r0.code, 'session_dir_unrecorded');
  const st = await rt.start({ attemptId: 'att66', profileId: 'pi-default', cwd, prompt: 'x', config: { backend: 'pi-cli' } });
  assert.equal(st.ok, true);
  const rec = await rt.launchRecord('att66');
  // Recorded dir has no file -> missing.
  const r1 = await rt.sessionLog('att66');
  assert.equal(r1.ok, false); assert.equal(r1.code, 'session_log_missing');
  const dir = rec.pi.sessionDir;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'a_acp-att66.jsonl'), '{}\n');
  await fs.writeFile(join(dir, 'b_acp-att66.jsonl'), '{}\n');
  const r2 = await rt.sessionLog('att66');
  assert.equal(r2.ok, false); assert.equal(r2.code, 'session_log_ambiguous');
  await fs.rm(join(dir, 'b_acp-att66.jsonl'));
  assert.equal((await rt.sessionLog('att66')).ok, true);
  await fs.chmod(dir, 0o000);
  try {
    const r3 = await rt.sessionLog('att66');
    assert.equal(r3.ok, false); assert.equal(r3.code, 'sessions_unreadable');
  } finally { await fs.chmod(dir, 0o700); }
  const r4 = await rt.sessionLog('../escape');
  assert.equal(r4.ok, false); assert.equal(r4.code, 'invalid_attempt_id');
});
