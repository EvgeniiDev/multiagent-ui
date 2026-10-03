// scripts/u3_core_selftest.mjs — deterministic U3 core tests.
//   node --test scripts/u3_core_selftest.mjs
//
// Everything runs through createStateService's real request/queue path plus
// createInternalClient against the REAL routed internal surface (injected
// transport → svc.request, token auth included). Fixture projects are REAL
// git repositories; workspaces are REAL git worktrees under a scratch root.
// NOTHING opens a listener, touches compose, or uses the live state dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createFakeRuntime } from '../server/execution/fake-runtime.mjs';
import { createManagedScheduler } from '../server/execution/managed-scheduler.mjs';
import { createInternalClient, ensureInternalToken } from '../server/execution/internal-transport.mjs';
import { paths } from '../server/execution/execution-store.mjs';
import { projectKeyFor, workspacePath, ensureWorkspaceRootAccess }
  from '../server/execution/workspaces.mjs';
import { isManagedCard, legacyCardDispatchable }
  from '../server/execution/legacy-guard.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);

// ---- fixtures ---------------------------------------------------------------

async function mkProject() {
  const dir = join(tmpdir(), `u3-proj-${randomUUID().slice(0, 8)}`);
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

async function mkEnv({ faults, features = { start: true } } = {}) {
  const root = join(tmpdir(), `u3-state-${randomUUID().slice(0, 8)}`);
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
const internal = (svc, cardId, body) => svc.internalCommand(cardId, body);
const getCard = (svc, id) => req(svc, 'GET', `/api/execution/cards/${id}`);
const getRun = (svc, id) => req(svc, 'GET', `/api/execution/runs/${id}`);
const getEvents = (svc, id, qs = '') =>
  req(svc, 'GET', `/api/execution/runs/${id}/events${qs}`);

// Real internal client → real routed internal surface (token auth included).
function mkClient(svc, stateDir) {
  return createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : JSON.stringify(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
}

function mkSched(env, {
  registry, behavior, behaviors, instanceId = `inst-${randomUUID().slice(0, 8)}`,
  runnerId = 'host-runner', environment, hooks,
} = {}) {
  const runtime = createFakeRuntime({
    registry,
    rootDir: join(env.root, 'fake-exec'),
    environment,
    behaviors: behaviors || (behavior ? { default: behavior } : {}),
  });
  const sched = createManagedScheduler({
    client: mkClient(env.svc, env.stateDir),
    runtime, runnerId, instanceId,
    env: { ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root },
    hooks,
  });
  return { sched, runtime, instanceId };
}

const ownerOf = (instanceId, over = {}) => ({
  runnerId: 'host-runner', instanceId, pid: 99001, pidStarttime: 'st-99001',
  envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'fake-bootid', pidNs: 'fake-pidns' },
  ...over,
});

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
// Full pipeline: enable → approved req+plan → preset → start → queued run.
async function mkManagedRun(svc, cardId = 'card-a', { preset } = {}) {
  await enable(svc, cardId);
  const req = await attachDoc(svc, cardId, 'requirements', `# Req ${cardId}`);
  await approve(svc, cardId, 'approve_requirements', req);
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

// ==========================================================================
// start gate + durable run
// ==========================================================================

test('start gate: default-off returns 501 command_unavailable naming the gate', async () => {
  const env = await mkEnv({ features: {} });
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const req1 = await attachDoc(svc, 'card-a', 'requirements', '# Req');
  await approve(svc, 'card-a', 'approve_requirements', req1);
  const plan = await attachDoc(svc, 'card-a', 'plan', '# Plan',
    { checks: [{ run: 'npm test', timeoutSec: 300 }] });
  await approve(svc, 'card-a', 'approve_plan', plan);
  await savePreset(svc, 'card-a');
  const c = await getCard(svc, 'card-a');
  const r = await cmd(svc, 'card-a', {
    commandId: 'st-gate', type: 'start', expectedControlRevision: c.json.controlRevision,
  });
  assert.equal(r.status, 501);
  assert.equal(r.json.code, 'command_unavailable');
  assert.equal(r.json.gate, 'ACP_EXEC_START');
});

test('happy path: queued → workspace → durable attempt → launch → bound running', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const baseCommit = git(projectDir, 'rev-parse', 'HEAD');

  const { sched, runtime } = mkSched(env, { instanceId: 'inst-happy' });
  const out = await sched.tick();
  assert.equal(out.launched, 1, J(out));

  const run = await runView(svc, runId);
  assert.equal(run.status, 'active');
  assert.equal(run.baseCommit, baseCommit);
  assert.equal(run.attempts.length, 1);
  const att = run.attempts[0];
  assert.equal(att.status, 'running');
  assert.equal(att.role, 'implementer');
  assert.ok(att.porchRunId, 'attempt bound to a porch run id');
  assert.equal(att.owner.runnerId, 'host-runner');
  assert.equal(att.owner.instanceId, 'inst-happy');

  // Real worktree: path canonical under wsRoot, HEAD+branch verified,
  // common dir is the source repo's object store.
  const card = (await getCard(svc, 'card-a')).json;
  const ws = card.workspaces[run.workspaceId];
  assert.equal(ws.status, 'ready');
  assert.equal(ws.runId, runId);
  const wantPath = workspacePath(
    await fs.realpath(wsRoot), projectKeyFor(projectDir), 'card-a', ws.id);
  assert.equal(ws.path, wantPath);
  assert.equal(git(ws.path, 'rev-parse', 'HEAD'), baseCommit);
  assert.equal(git(ws.path, 'symbolic-ref', '--short', 'HEAD'), ws.branch);
  assert.match(ws.branch, /^acp\/card-a\//);
  const commonDir = git(ws.path, 'rev-parse', '--git-common-dir');
  const resolvedCommon = commonDir.startsWith('/')
    ? commonDir : join(ws.path, commonDir);
  assert.equal(await fs.realpath(resolvedCommon),
    await fs.realpath(join(projectDir, '.git')));
  // The source checkout was not touched.
  assert.equal(git(projectDir, 'status', '--porcelain'), '');
  // One launch, cwd = the worktree.
  assert.equal(starts(runtime).length, 1);
  assert.equal(starts(runtime)[0].cwd, ws.path);
});

test('ordering: attempt row is durable BEFORE runtime.start fires', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  let seen = null;
  const { sched, runtime } = mkSched(env, {
    hooks: {
      onAttemptDurable: async ({ attemptId }) => {
        const run = (await getRun(svc, runId)).json;
        seen = {
          attempt: run.attempts.find((a) => a.id === attemptId)?.status ?? null,
          started: starts(runtime).length,
        };
      },
    },
  });
  await sched.tick();
  assert.deepEqual(seen, { attempt: 'launching', started: 0 });
});

test('dirty source refuses: tracked+untracked dirt, source untouched, run blocked', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Dirty AFTER queueing: worktree must refuse without touching the source.
  await fs.writeFile(join(projectDir, 'src', 'a.js'), 'dirty\n');
  await fs.writeFile(join(projectDir, 'untracked.tmp'), 'x\n');
  const before = git(projectDir, 'status', '--porcelain');
  const { sched, runtime } = mkSched(env);
  const out = await sched.tick();
  assert.equal(out.source_dirty, 1, J(out));
  assert.equal(starts(runtime).length, 0);
  assert.equal(git(projectDir, 'status', '--porcelain'), before);
  const run = await runView(svc, runId);
  assert.equal(run.status, 'blocked');
  const card = (await getCard(svc, 'card-a')).json;
  assert.equal(card.workspaces[run.workspaceId].status, 'failed');
});

test('concurrent schedulers: exactly one durable attempt + one launch', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const registry = undefined; // separate runtimes, shared service authority
  const s1 = mkSched(env, { instanceId: 'inst-c1' });
  const s2 = mkSched(env, { instanceId: 'inst-c2' });
  await Promise.all([s1.sched.tick(), s2.sched.tick()]);
  const run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  const totalStarts = starts(s1.runtime).length + starts(s2.runtime).length;
  assert.equal(totalStarts, 1);
});

// ==========================================================================
// ownership: foreign instance can never mutate or launch under it
// ==========================================================================

async function liveRun(env, { instanceId = 'inst-A', envOverrides, behavior } = {}) {
  const s = mkSched(env, { instanceId, environment: envOverrides, behavior });
  await s.sched.tick();
  return s;
}

test('foreign instance same env+runnerId: no adopt, no event, no mutation', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Shared fake registry: B observes the same process table as A. The
  // recorded owner pid (this test process) is explicitly marked LIVE —
  // a missing procs entry would be a valid 'absent' death finding.
  const registry = createFakeRuntime({})._registry;
  const A = mkSched(env, { instanceId: 'inst-A', registry });
  await A.sched.tick();
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  assert.equal(att.owner.instanceId, 'inst-A');
  const wsId = run.workspaceId;
  registry.procs.set(att.owner.pid, {
    exists: true, state: 'R', starttime: att.owner.pidStarttime,
    pidNs: 'fake-pidns', readable: true,
  });

  // inst-B: same runnerId, same envKey (default fake env) — still foreign.
  const B = mkSched(env, { instanceId: 'inst-B', registry });
  const out = await B.sched.tick();
  assert.equal(starts(B.runtime).length, 0);
  assert.ok((out.foreign || out.observed || out['adopted-observing']) !== undefined
    || out.cards === 1, J(out));

  // Direct domain probes from inst-B — every owned surface refuses.
  const fk = { runnerId: 'host-runner', instanceId: 'inst-B', pid: 88001,
    pidStarttime: 'st-88001', envKey: att.owner.envKey };
  const wf = await internal(svc, 'card-a', {
    commandId: 'wf-b', type: 'workspace_failed',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId, ...fk },
  });
  assert.equal(wf.status, 409, J(wf.body));
  const cr = await internal(svc, 'card-a', {
    commandId: 'cr-b', type: 'complete_run',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { runId, status: 'failed', ...fk },
  });
  assert.equal(cr.status, 409, J(cr.body));
  const ev = await internal(svc, 'card-a', {
    commandId: 'ev-b', type: 'record_event',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { runId, type: 'note', data: 'forged', ...fk },
  });
  assert.equal(ev.status, 409, J(ev.body));
  // Owner unchanged; attempt still running; zero foreign runtime calls.
  const run2 = await runView(svc, runId);
  assert.equal(run2.attempts[0].owner.instanceId, 'inst-A');
  assert.equal(run2.attempts[0].status, 'running');
  assert.equal(cancels(A.runtime).length, 0);
  assert.equal(cancels(B.runtime).length, 0);
});

test('dead owner + live supervisor: adopt, observe, retain slot — no second launch', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Shared registry across both runtimes: B sees A's runs AND procs table.
  // outcome 'never': the supervisor stays live across ticks — this test pins
  // adoption+observation, not the (U4) terminal-resolve path.
  const registry = createFakeRuntime({})._registry;
  const A = mkSched(env, {
    instanceId: 'inst-A', registry,
    environment: { pid: 99001, pidStarttime: 'st-99001' },
    behavior: { outcome: 'never' },
  });
  await A.sched.tick();
  let run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'running');
  assert.equal(A.runtime._runs.size, 1);
  // Owner Node dies; detached supervisor stays alive in the registry.
  registry.procs.set(99001, { exists: false });
  const B = mkSched(env, { instanceId: 'inst-B', registry, behavior: { outcome: 'never' } });
  const out = await B.sched.tick();
  assert.equal(out['adopted-observing'], 1, J(out));
  run = await runView(svc, runId);
  assert.equal(run.attempts[0].owner.instanceId, 'inst-B');
  assert.equal(run.attempts[0].status, 'running');      // reservation retained
  assert.equal(starts(B.runtime).length, 0);            // never a second launch
  assert.equal(starts(A.runtime).length + starts(B.runtime).length, 1);
  assert.equal(B.runtime._runs.size, 1);                // one supervisor
});

test('dead owner while launching + supervisor appears later: adopt → reconcile → bind', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const registry = createFakeRuntime({})._registry;
  const A = mkSched(env, {
    instanceId: 'inst-A', registry,
    environment: { pid: 99002, pidStarttime: 'st-99002' },
    behavior: { launch: 'uncertain', launcherAlive: true, uncertainRegisters: false },
  });
  await A.sched.tick(); // att stays 'launching' — live launcher, no match
  let run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'launching');
  // Supervisor registers late (controller had died before seeing it).
  const att = run.attempts[0];
  const wsPath = (await getCard(svc, 'card-a')).json.workspaces[run.workspaceId].path;
  const artifactsDir = att.launch.artifactsDir;
  const runId2 = `run_fake-late`;
  registry.runs.set(runId2, {
    runId: runId2, attemptId: att.id, profileId: att.launch.profileId,
    cwd: wsPath, artifactsDir, status: 'running', exitCode: null, error: null,
    startedAt: new Date().toISOString(), finishedAt: null,
    events: [], waiters: [], timer: null, onCancel: 'cancel',
    finalText: null, finalAvailable: false, pid: 81234, pidAlive: true,
  });
  registry.procs.set(99002, { exists: false });
  const B = mkSched(env, { instanceId: 'inst-B', registry });
  const out = await B.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'running', J(run.attempts[0]));
  assert.equal(run.attempts[0].porchRunId, runId2);
  assert.equal(run.attempts[0].owner.instanceId, 'inst-B');
  assert.equal(starts(B.runtime).length, 0);
});

test('environment_lost (bootId change): attempt AND run interrupted; no auto-relaunch', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const A = mkSched(env, {
    instanceId: 'inst-A',
    environment: { pid: 99003, pidStarttime: 'st-99003', pidNs: 'ns-old', bootId: 'boot-old' },
  });
  await A.sched.tick();
  let run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'running');
  // New container: different namespace AND different boot → old env is gone.
  const B = mkSched(env, {
    instanceId: 'inst-B',
    environment: { pidNs: 'ns-new', bootId: 'boot-new' },
  });
  await B.sched.tick(); // adopt → resolve interrupted → run interrupted
  run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].status, 'interrupted');
  assert.equal(run.status, 'interrupted');
  // Restart policy is U4's explicit continue — repeated ticks must NOT
  // auto-launch a fresh attempt inside the interrupted run.
  await B.sched.tick();
  await B.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.status, 'interrupted');
  assert.equal(starts(B.runtime).length, 0); // never launched
  assert.equal(cancels(B.runtime).length, 0); // old pid never signaled
});

test('second container, same bootId: foreign env ≠ dead env — no adoption, no launch', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const A = mkSched(env, {
    instanceId: 'inst-A',
    environment: { pid: 99004, pidStarttime: 'st-99004', pidNs: 'ns-1' },
  });
  await A.sched.tick();
  // inst-B in ANOTHER pid namespace but the SAME boot: owner could be live.
  const B = mkSched(env, {
    instanceId: 'inst-B', environment: { pidNs: 'ns-2' },
  });
  const out = await B.sched.tick();
  assert.equal(out.foreign, 1, J(out));
  const run = await runView(svc, runId);
  assert.equal(run.attempts[0].owner.instanceId, 'inst-A');
  assert.equal(run.attempts[0].status, 'running');
  assert.equal(starts(B.runtime).length, 0);
  assert.equal(cancels(B.runtime).length, 0);
});

// ==========================================================================
// adoption proof (domain-level)
// ==========================================================================

test('adopt_attempt rejects weak/forged process_dead proofs', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  await liveRun(env, { instanceId: 'inst-A', environment: { pid: 99005, pidStarttime: 'st-99005' } });
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  const rev = async () => (await getCard(svc, 'card-a')).json.internalRevision;
  const adopt = (proof, id) => internal(svc, 'card-a', {
    commandId: id, type: 'adopt_attempt', expectedInternalRevision: undefined,
    payload: { runId, attemptId: att.id, proof,
      runnerId: 'host-runner', instanceId: 'inst-B', pid: 88002,
      pidStarttime: 'st-88002', envKey: att.owner.envKey },
  }).then(async (p) => {
    // fresh revision each call — resend with CAS
    const r = await internal(svc, 'card-a', {
      commandId: id, type: 'adopt_attempt', expectedInternalRevision: await rev(),
      payload: { runId, attemptId: att.id, proof,
        runnerId: 'host-runner', instanceId: 'inst-B', pid: 88002,
        pidStarttime: 'st-88002', envKey: att.owner.envKey },
    });
    return r;
  });
  // No proof at all.
  let r = await adopt(undefined, 'adp-0');
  assert.equal(r.status, 409, J(r.body));
  // PID-only claim.
  r = await adopt({ kind: 'process_dead', pid: 99005 }, 'adp-1');
  assert.equal(r.status, 409, J(r.body));
  // Owner pid named but observed ALIVE.
  r = await adopt({ kind: 'process_dead', pid: 99005, starttime: 'st-99005',
    pidNs: 'fake-pidns', finding: 'alive' }, 'adp-2');
  assert.equal(r.status, 409, J(r.body));
  // Wrong starttime = a different process entirely.
  r = await adopt({ kind: 'process_dead', pid: 99005, starttime: 'OTHER',
    pidNs: 'fake-pidns', finding: 'absent' }, 'adp-3');
  assert.equal(r.status, 409, J(r.body));
  // Foreign pid namespace cannot witness the original process.
  r = await adopt({ kind: 'process_dead', pid: 99005, starttime: 'st-99005',
    pidNs: 'ns-foreign', finding: 'absent' }, 'adp-4');
  assert.equal(r.status, 409, J(r.body));
  // 'unknown'/'foreign' findings are not termination evidence.
  r = await adopt({ kind: 'process_dead', pid: 99005, starttime: 'st-99005',
    pidNs: 'fake-pidns', finding: 'unknown' }, 'adp-5');
  assert.equal(r.status, 409, J(r.body));
  // Different pid entirely.
  r = await adopt({ kind: 'process_dead', pid: 1, starttime: 'st-99005',
    pidNs: 'fake-pidns', finding: 'absent' }, 'adp-6');
  assert.equal(r.status, 409, J(r.body));
  // Attempt untouched through all of it.
  const run2 = await runView(svc, runId);
  assert.equal(run2.attempts[0].owner.instanceId, 'inst-A');
  assert.equal(run2.attempts[0].status, 'running');
});

test('adopt_workspace: exact reservation retained, re-verified, reused — no second worktree', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const wsId = `ws-${runId}`;
  const branch = `acp/card-a/${wsId}`;
  const baseCommit = git(projectDir, 'rev-parse', 'HEAD');
  const wpath = workspacePath(await fs.realpath(wsRoot), projectKeyFor(projectDir), 'card-a', wsId);
  // inst-A reserves the workspace but dies before filesystem allocation.
  const bw = await internal(svc, 'card-a', {
    commandId: 'bw-1', type: 'begin_workspace',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId, branch, baseCommit, path: wpath,
      runnerId: 'host-runner', instanceId: 'inst-A', pid: 99006,
      pidStarttime: 'st-99006',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'fake-bootid', pidNs: 'fake-pidns' } },
  });
  assert.equal(bw.status, 200, J(bw.body));
  // Foreign replay of the same reservation is refused.
  const foreign = await internal(svc, 'card-a', {
    commandId: 'bw-2', type: 'begin_workspace',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId, branch, baseCommit, path: wpath,
      runnerId: 'host-runner', instanceId: 'inst-B', pid: 88003,
      pidStarttime: 'st-88003',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'fake-bootid', pidNs: 'fake-pidns' } },
  });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.code, 'workspace_foreign');
  // inst-B adopts with structured proof (owner pid dead in its namespace).
  const ad = await internal(svc, 'card-a', {
    commandId: 'adw-1', type: 'adopt_workspace',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId,
      proof: { kind: 'process_dead', pid: 99006, starttime: 'st-99006',
        pidNs: 'fake-pidns', finding: 'absent' },
      runnerId: 'host-runner', instanceId: 'inst-B', pid: 88003,
      pidStarttime: 'st-88003',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'fake-bootid', pidNs: 'fake-pidns' } },
  });
  assert.equal(ad.status, 200, J(ad.body));
  assert.equal(ad.body.result.adopted, true);
  const card = (await getCard(svc, 'card-a')).json;
  const ws = card.workspaces[wsId];
  assert.equal(ws.owner.instanceId, 'inst-B');
  assert.equal(ws.path, wpath);        // exact reservation retained
  assert.equal(ws.branch, branch);
  assert.equal(ws.runId, runId);
  assert.equal(ws.status, 'creating'); // adopter must still allocate/verify
  // A second begin_workspace under inst-B now replays idempotently.
  const again = await internal(svc, 'card-a', {
    commandId: 'bw-3', type: 'begin_workspace',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId, branch, baseCommit, path: wpath,
      runnerId: 'host-runner', instanceId: 'inst-B', pid: 88003,
      pidStarttime: 'st-88003',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'fake-bootid', pidNs: 'fake-pidns' } },
  });
  assert.equal(again.status, 200, J(again.body));
  assert.equal(again.body.result.idempotent, true);
  // inst-B now drives allocation through the scheduler — one worktree only.
  const B = mkSched(env, { instanceId: 'inst-B' });
  await B.sched.tick();
  const dirs = await fs.readdir(join(await fs.realpath(wsRoot), projectKeyFor(projectDir)));
  assert.deepEqual(dirs, [`card-a--${wsId}`]);
  assert.equal(git(dirs.length ? join(await fs.realpath(wsRoot), projectKeyFor(projectDir), dirs[0]) : '.', 'rev-parse', 'HEAD'), baseCommit);
});

test('workspace id collision across cards is refused', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a'), cardFixture('card-b')]);
  const wsId = 'ws-shared-1';
  const mk = async (cardId, runId, cmdId) => {
    const wpath = workspacePath(await fs.realpath(wsRoot), projectKeyFor(projectDir), cardId, wsId);
    return internal(svc, cardId, {
      commandId: cmdId, type: 'begin_workspace',
      expectedInternalRevision: (await getCard(svc, cardId)).json.internalRevision,
      payload: { workspaceId: wsId, runId, branch: `acp/${cardId}/${wsId}`,
        baseCommit: git(projectDir, 'rev-parse', 'HEAD'), path: wpath,
        runnerId: 'host-runner', instanceId: 'inst-X', pid: 1, pidStarttime: 'x',
        envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' } },
    });
  };
  // card-a needs a live run to bind.
  const runA = await mkManagedRun(svc, 'card-a');
  const a = await mk('card-a', runA, 'bw-a');
  assert.equal(a.status, 200, J(a.body));
  const runB = await mkManagedRun(svc, 'card-b');
  const b = await mk('card-b', runB, 'bw-b');
  assert.equal(b.status, 409);
  assert.equal(b.body.code, 'workspace_conflict');
});

test('one run binds one workspace; alternate wsId conflicts until failed', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const baseCommit = git(projectDir, 'rev-parse', 'HEAD');
  const idem = async (wsId, cid) => internal(svc, 'card-a', {
    commandId: cid, type: 'begin_workspace',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId, branch: `acp/card-a/${wsId}`,
      baseCommit, path: workspacePath(await fs.realpath(wsRoot), projectKeyFor(projectDir), 'card-a', wsId),
      runnerId: 'host-runner', instanceId: 'inst-A', pid: 1, pidStarttime: 'x',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' } },
  });
  const first = await idem('ws-one', 'bw-a1');
  assert.equal(first.status, 200, J(first.body));
  const second = await idem('ws-two', 'bw-a2');
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'workspace_conflict');
  // After the bound ws is marked failed, a new wsId may be reserved.
  const card = (await getCard(svc, 'card-a')).json;
  const wf = await internal(svc, 'card-a', {
    commandId: 'wf-a', type: 'workspace_failed', expectedInternalRevision: card.internalRevision,
    payload: { workspaceId: 'ws-one', runId, reason: 'probe',
      runnerId: 'host-runner', instanceId: 'inst-A', pid: 1, pidStarttime: 'x',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' } },
  });
  assert.equal(wf.status, 200, J(wf.body));
  const third = await idem('ws-two', 'bw-a3');
  assert.equal(third.status, 200, J(third.body));
});

// ==========================================================================
// attempts: ready ws required, canonical cwd, global id uniqueness, limits
// ==========================================================================

test('begin_attempt requires an existing READY workspace + canonical cwd', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const basePayload = {
    runId, attemptId: 'att-x1', role: 'implementer', phase: 'implement', leaseMs: 60000,
    launch: {
      profileId: 'acp-implementer', cwd: '/tmp/anywhere',
      attemptDir: '/tmp/ad', artifactsDir: '/tmp/ad/artifacts',
      promptSha256: 'a'.repeat(64), configSha256: 'b'.repeat(64),
    },
    runnerId: 'host-runner', instanceId: 'inst-A', pid: 1, pidStarttime: 'x',
    envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' },
  };
  // No workspace at all.
  let r = await internal(svc, 'card-a', {
    commandId: 'ba-n1', type: 'begin_attempt',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: basePayload,
  });
  assert.equal(r.status, 422, J(r.body));
  assert.equal(r.body.code, 'workspace_not_ready');
  const wsId = `ws-${runId}`;
  const wpath = workspacePath(await fs.realpath(env.wsRoot), projectKeyFor(projectDir), 'card-a', wsId);
  const bw = await internal(svc, 'card-a', {
    commandId: 'bw-r1', type: 'begin_workspace',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId, branch: `acp/card-a/${wsId}`,
      baseCommit: git(projectDir, 'rev-parse', 'HEAD'), path: wpath,
      runnerId: 'host-runner', instanceId: 'inst-W', pid: 1, pidStarttime: 'x',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' } },
  });
  assert.equal(bw.status, 200, J(bw.body));
  // Still 'creating' — not ready.
  r = await internal(svc, 'card-a', {
    commandId: 'ba-n2', type: 'begin_attempt',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { ...basePayload, attemptId: 'att-x2',
      launch: { ...basePayload.launch, cwd: wpath } },
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'workspace_not_ready');
  // Ready but wrong cwd refuses.
  const wr = await internal(svc, 'card-a', {
    commandId: 'wr-r1', type: 'workspace_ready',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { workspaceId: wsId, runId, head: git(projectDir, 'rev-parse', 'HEAD'),
      runnerId: 'host-runner', instanceId: 'inst-W', pid: 1, pidStarttime: 'x',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' } },
  });
  assert.equal(wr.status, 200, J(wr.body));
  r = await internal(svc, 'card-a', {
    commandId: 'ba-n3', type: 'begin_attempt',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { ...basePayload, attemptId: 'att-x3' },
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'launch_mismatch');
});

test('attemptId is globally unique across runs and cards', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a'), cardFixture('card-b')]);
  const runA = await mkManagedRun(svc, 'card-a');
  const runB = await mkManagedRun(svc, 'card-b');
  // Raise caps so the duplicate-id assertion isn't masked by slot limits.
  await fs.mkdir(join(paths(stateDir).root), { recursive: true });
  await fs.writeFile(paths(stateDir).schedulerFile,
    J({ limits: { global: 10, roles: { implementer: 10 } } }));
  // Bring both workspaces to ready through real scheduler allocation.
  const sA = mkSched(env, { instanceId: 'inst-A' });
  const sB = mkSched(env, { instanceId: 'inst-B' });
  await sA.sched.tick();
  await sB.sched.tick();
  // Both launched with generated ids; now try a dup id on card-b.
  const runViewB = await runView(svc, runB);
  const wsB = runViewB.workspaceId;
  const payloadB = {
    runId: runB, attemptId: 'att-dup', role: 'implementer', phase: 'implement', leaseMs: 60000,
    launch: {
      profileId: 'acp-implementer',
      cwd: (await getCard(svc, 'card-b')).json.workspaces[wsB].path,
      attemptDir: '/tmp/ad2', artifactsDir: '/tmp/ad2/artifacts',
      promptSha256: 'a'.repeat(64), configSha256: 'b'.repeat(64),
    },
    runnerId: 'host-runner', instanceId: 'inst-B', pid: 1, pidStarttime: 'x',
    envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' },
  };
  // First use on card-a via a fresh run? card-a's run is active with att1.
  // Use card-b: first 'att-dup' is allowed only if no live attempt blocks —
  // card-b already has a live attempt, so expect attempt_active first.
  const dup = await internal(svc, 'card-b', {
    commandId: 'ba-dup', type: 'begin_attempt',
    expectedInternalRevision: (await getCard(svc, 'card-b')).json.internalRevision,
    payload: payloadB,
  });
  assert.equal(dup.status, 409);
  assert.ok(['attempt_active', 'attempt_exists'].includes(dup.body.code), J(dup.body));
  // Record att-dup on a THIRD card? Use card-b's own attempt id on card-a.
  const attA = (await runView(svc, runA)).attempts[0].id;
  const dupId = await internal(svc, 'card-b', {
    commandId: 'ba-dup2', type: 'begin_attempt',
    expectedInternalRevision: (await getCard(svc, 'card-b')).json.internalRevision,
    payload: { ...payloadB, attemptId: attA },
  });
  assert.equal(dupId.status, 409);
  assert.equal(dupId.body.code, 'attempt_exists');
});

test('global + role slot limits are authoritative across cards', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a'), cardFixture('card-b')]);
  const runA = await mkManagedRun(svc, 'card-a');
  const runB = await mkManagedRun(svc, 'card-b');
  // limits: global 1 — second card must not launch while the first holds a slot.
  await fs.mkdir(join(paths(stateDir).root), { recursive: true });
  await fs.writeFile(paths(stateDir).schedulerFile,
    J({ limits: { global: 1, roles: { implementer: 1 } } }));
  const A = mkSched(env, { instanceId: 'inst-A' });
  await A.sched.tick();
  const B = mkSched(env, { instanceId: 'inst-B' });
  const out = await B.sched.tick();
  assert.equal(starts(B.runtime).length, 0);
  const runBNow = await runView(svc, runB);
  assert.equal(runBNow.attempts.length, 0); // no attempt reserved under the cap
  assert.equal(runBNow.status, 'queued');
});

// ==========================================================================
// launch crash/retry matrix
// ==========================================================================

test('launch_uncertain with registry match binds the exact supervisor', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = mkSched(env, { behavior: { launch: 'uncertain', uncertainRegisters: true } });
  await S.sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'running');
  assert.ok(run.attempts[0].porchRunId);
  assert.equal(starts(S.runtime).length, 1);
});

test('launch_uncertain + dead launcher + no match → resolve failed → retry bound', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Attempt 1 dies in the handshake with a dead launcher and no supervisor;
  // attempt 2 launches cleanly.
  const S = mkSched(env, {
    behaviors: {
      default: { launch: 'ok' },
      byAttempt: {
        [`att-${runId}-1`]: {
          launch: 'uncertain', launcherAlive: false, uncertainRegisters: false,
        },
      },
    },
  });
  await S.sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.attempts.length, 2, J(run.attempts.map((a) => a.status)));
  assert.equal(run.attempts[0].status, 'failed');
  assert.equal(run.attempts[1].status, 'running');
  assert.equal(starts(S.runtime).length, 2);
});

test('launch_uncertain + live launcher + no match → stays launching, never relaunches', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = mkSched(env, {
    behavior: { launch: 'uncertain', launcherAlive: true, uncertainRegisters: false },
  });
  await S.sched.tick();
  await S.sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].status, 'launching');
  assert.equal(starts(S.runtime).length, 1); // no duplicate launch
});

test('missing launch record blocks (unknown, never "no spawn")', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = mkSched(env, { behavior: { launch: 'throw', launcherAlive: true } });
  await S.sched.tick();
  let run = await runView(svc, runId);
  const att = run.attempts[0];
  assert.equal(att.status, 'launching');
  // Controller returns with NO record — ambiguous, must block.
  S.runtime._records.delete(att.id);
  const out = await S.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'launching');  // reservation retained
  assert.equal(run.diagnostic?.code, 'launcher_unproven');
  assert.equal(starts(S.runtime).length, 1);
});

test('unreadable registry entries block zero-match retry', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = mkSched(env, {
    behavior: { launch: 'uncertain', launcherAlive: false, uncertainRegisters: false },
  });
  S.runtime._registry.unreadable.push({ runId: 'run_corrupt', reason: 'EACCES' });
  await S.sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].status, 'launching');
  assert.equal(run.diagnostic?.code, 'registry_incomplete');
  assert.equal(starts(S.runtime).length, 1);
});

test('two registry matches block (ambiguous supervisor set)', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = mkSched(env, {
    behavior: { launch: 'uncertain', launcherAlive: true, uncertainRegisters: false },
  });
  await S.sched.tick(); // launching, no match, live launcher
  let run = await runView(svc, runId);
  const att = run.attempts[0];
  const wsPath = (await getCard(svc, 'card-a')).json.workspaces[run.workspaceId].path;
  for (const rid of ['run_fake-d1', 'run_fake-d2']) {
    S.runtime._runs.set(rid, {
      runId: rid, attemptId: att.id, profileId: att.launch.profileId,
      cwd: wsPath, artifactsDir: att.launch.artifactsDir, status: 'running',
      exitCode: null, error: null, startedAt: new Date().toISOString(),
      finishedAt: null, events: [], waiters: [], timer: null,
      onCancel: 'cancel', finalText: null, finalAvailable: false,
      pid: 83000, pidAlive: true,
    });
  }
  await S.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'launching');
  assert.equal(run.diagnostic?.code, 'registry_ambiguous');
  assert.equal(starts(S.runtime).length, 1);
});

test('launch record without environment attestation blocks (unknown ≠ dead)', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = mkSched(env, { behavior: { launch: 'throw', launcherAlive: true } });
  await S.sched.tick();
  let run = await runView(svc, runId);
  const att = run.attempts[0];
  // The record exists with a launcher pid, but its environment attestation
  // was lost — process-death inference is not allowed without it.
  const rec = S.runtime._records.get(att.id);
  assert.ok(rec?.launcher?.pid, 'fixture needs a recorded launcher');
  rec.environment = null;
  await S.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'launching');
  assert.equal(run.diagnostic?.code, 'launcher_unproven');
  assert.equal(starts(S.runtime).length, 1);
});

test('EACCES-style unverifiable process probe blocks retry', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = mkSched(env, { behavior: { launch: 'throw', launcherAlive: true } });
  await S.sched.tick();
  let run = await runView(svc, runId);
  const att = run.attempts[0];
  const rec = S.runtime._records.get(att.id);
  // Launcher pid exists in the table but the probe cannot verify it.
  S.runtime._procs.set(rec.launcher.pid, { exists: null });
  await S.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts[0].status, 'launching');
  assert.equal(run.diagnostic?.code, 'launcher_unproven');
  assert.equal(starts(S.runtime).length, 1);
});

test('input-hash mismatch refuses launch (immutable approved inputs)', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Skew the run PROJECTION (what the scheduler actually reads) so its
  // recorded input hash disagrees with the approved blob — the scheduler
  // must refuse before any workspace/attempt mutation.
  const runFile = join(paths(stateDir).runsDir, `${runId}.json`);
  const proj = JSON.parse(await fs.readFile(runFile, 'utf-8'));
  proj.inputs.requirements.sha256 = 'f'.repeat(64);
  await fs.writeFile(runFile, J(proj));
  const S = mkSched(env);
  const out = await S.sched.tick();
  assert.ok(out.errors?.length >= 1, J(out));
  assert.match(out.errors[0].error, /does not match approved sha256/);
  const run = await runView(svc, runId);
  assert.equal(run.attempts.length, 0);
  assert.equal(starts(S.runtime).length, 0);
  // No workspace was allocated: the ws root holds no worktree dir.
  const keyDir = join(await fs.realpath(env.wsRoot), projectKeyFor(projectDir));
  const dirs = await fs.readdir(keyDir).catch(() => []);
  assert.deepEqual(dirs, []);
});

test('launch_failed observed exit + zero match → retry; a registered match binds', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Attempt 1 fails at the porch CLI (observed exit code), attempt 2 is ok.
  const att1 = `att-${runId}-1`;
  const S = mkSched(env, {
    behaviors: {
      default: { launch: 'ok' },
      byAttempt: { [att1]: { launch: 'fail' } },
    },
  });
  await S.sched.tick();
  let run = await runView(svc, runId);
  assert.equal(run.attempts.length, 2, J(run.attempts.map((a) => a.status)));
  assert.equal(run.attempts[0].status, 'failed');
  assert.equal(run.attempts[1].status, 'running');
});

test('attempt budget exhaustion marks the run failed durably', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc, 'card-a',
    { preset: goodPreset({ maxAttemptsPerRole: 1 }) });
  const S = mkSched(env, {
    behavior: { launch: 'uncertain', launcherAlive: false, uncertainRegisters: false },
  });
  await S.sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error || '', /attempt budget/);
});

// ==========================================================================
// durable events: ownership, seq stability, torn repair, pagination
// ==========================================================================

test('record_event: owner-gated, stable seq, cursor paging, canonical read', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const S = await liveRun(env, { instanceId: 'inst-A' });
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  const rec = async (type, data, id, owner = {
    runnerId: 'host-runner', instanceId: 'inst-A', pid: process.pid,
    pidStarttime: 'x', envKey: att.owner.envKey }) =>
    internal(svc, 'card-a', {
      commandId: id, type: 'record_event',
      expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
      payload: { runId, attemptId: att.id, type, data, ...owner },
    });
  const e0 = await rec('progress', 'p0', 'ev-0');
  assert.equal(e0.status, 200, J(e0.body));
  const e1 = await rec('progress', 'p1', 'ev-1');
  assert.equal(e1.status, 200);
  const e2 = await rec('progress', 'p2', 'ev-2');
  assert.equal(e2.status, 200);
  // Foreign instance cannot append.
  const bad = await rec('forged', 'x', 'ev-bad', {
    runnerId: 'host-runner', instanceId: 'inst-B', pid: 1, pidStarttime: 'x',
    envKey: att.owner.envKey });
  assert.equal(bad.status, 409);
  const page = await getEvents(svc, runId, '?limit=2');
  assert.equal(page.status, 200);
  assert.equal(page.json.events.length, 2);
  assert.deepEqual(page.json.events.map((e) => e.seq), [0, 1]);
  assert.equal(page.json.nextCursor, 2);
  const page2 = await getEvents(svc, runId, `?cursor=${page.json.nextCursor}`);
  assert.deepEqual(page2.json.events.map((e) => e.seq), [2]);
  assert.equal(page2.json.corrupt, 0);
});

test('torn final JSONL line is repaired; accepted events keep stable seqs', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  await liveRun(env, { instanceId: 'inst-A' });
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  const sendEv = (data, id) => internal(svc, 'card-a', {
    commandId: id, type: 'record_event',
    expectedInternalRevision: undefined, payload: { runId, attemptId: att.id, type: 'progress', data,
      runnerId: 'host-runner', instanceId: 'inst-A', pid: process.pid,
      pidStarttime: 'x', envKey: att.owner.envKey },
  });
  // two accepted events first
  const r1 = await internal(svc, 'card-a', {
    commandId: 'te-1', type: 'record_event',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { runId, attemptId: att.id, type: 'progress', data: 'one',
      runnerId: 'host-runner', instanceId: 'inst-A', pid: process.pid,
      pidStarttime: 'x', envKey: att.owner.envKey },
  });
  assert.equal(r1.status, 200, J(r1.body));
  // Simulate crash mid-append: truncate the jsonl into a partial line.
  const eventsFile = join(paths(stateDir).runsDir, `${runId}.events.jsonl`);
  const raw = await fs.readFile(eventsFile, 'utf-8');
  await fs.writeFile(eventsFile, raw.slice(0, Math.floor(raw.length / 2)));
  // Next record_event must repair the projection (aggregate is authoritative).
  const r2 = await internal(svc, 'card-a', {
    commandId: 'te-2', type: 'record_event',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { runId, attemptId: att.id, type: 'progress', data: 'two',
      runnerId: 'host-runner', instanceId: 'inst-A', pid: process.pid,
      pidStarttime: 'x', envKey: att.owner.envKey },
  });
  assert.equal(r2.status, 200, J(r2.body));
  const ev = await getEvents(svc, runId);
  const seqs = ev.json.events.map((e) => e.seq);
  assert.deepEqual(seqs, [0, 1], J(ev.json.events));
  assert.deepEqual(ev.json.events.map((e) => e.data), ['one', 'two']);
  // Restart/replay keeps the canonical order.
  const svc2 = await createStateService({ stateDir, env: { ACP_WORKSPACE_DIR: env.wsRoot } });
  const ev2 = await getEvents(svc2, runId);
  assert.deepEqual(ev2.json.events.map((e) => e.seq), [0, 1]);
});

test('run projection write failure → durable intent → restart repair → read', async () => {
  const failRuns = new Set();
  const env = await mkEnv({ faults: { runs: failRuns } });
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  failRuns.add(runId); // arm the crash window at the projection boundary
  // record_event stages run + run_events intents; the run write fails at
  // the REAL persistence boundary — the command reports failure but the
  // aggregate already committed with pendingWrites intact.
  const doomed = await internal(svc, 'card-a', {
    commandId: 'ev-f1', type: 'record_event',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { runId, type: 'progress', data: 'durable',
      runnerId: 'host-runner', instanceId: 'inst-A', pid: 1, pidStarttime: 'x',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' } },
  }).catch((e) => ({ status: 500, body: { error: String(e?.message || e), code: e.code } }));
  assert.ok(doomed.status >= 400 || doomed.body?.ok === false,
    `expected failure, got ${J(doomed.body ?? doomed)}`);
  failRuns.delete(runId); // disarm — simulate restart recovery
  const healed = await getRun(svc, runId); // repair runs inside the queue
  assert.equal(healed.status, 200, J(healed.json));
  assert.equal(healed.json.events.at(-1)?.data, 'durable');
  // The events projection was also drained.
  const evs = await getEvents(svc, runId);
  assert.ok(evs.json.events.some((e) => e.data === 'durable'));
});

test('run_events projection failure → intents retained → repair rewrites canonical jsonl', async () => {
  const failEv = new Set();
  const env = await mkEnv({ faults: { runEvents: failEv } });
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  await liveRun(env, { instanceId: 'inst-A' });
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  failEv.add(runId);
  const r = await internal(svc, 'card-a', {
    commandId: 'ev-g1', type: 'record_event',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { runId, attemptId: att.id, type: 'progress', data: 'kept',
      runnerId: 'host-runner', instanceId: 'inst-A', pid: process.pid,
      pidStarttime: 'x', envKey: att.owner.envKey },
  }).catch((e) => ({ status: 500, body: { code: e.code } }));
  assert.ok(r.status >= 400 || r.body?.ok === false, J(r.body ?? r));
  failEv.delete(runId);
  const evs = await getEvents(svc, runId); // repair inside queue first
  assert.ok(evs.json.events.some((e) => e.data === 'kept'), J(evs.json));
  assert.equal(evs.json.corrupt, 0);
});

// ==========================================================================
// internal transport auth
// ==========================================================================

test('internal route: missing token 401, wrong token 403, right token 200', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const card = (await getCard(svc, 'card-a')).json;
  const body = J({
    commandId: 'hb-t', type: 'heartbeat', expectedInternalRevision: card.internalRevision,
    payload: { runnerId: 'r', instanceId: 'i' },
  });
  const noTok = await svc.request({ method: 'POST', path: '/api/internal/cards/card-a/commands', bodyText: body, headers: {} });
  assert.equal(noTok.status, 401);
  const badTok = await svc.request({ method: 'POST', path: '/api/internal/cards/card-a/commands', bodyText: body,
    headers: { 'x-acp-internal-token': 'wrong' } });
  assert.equal(badTok.status, 403);
  const token = await fs.readFile(join(stateDir, 'execution', 'internal-token'), 'utf-8');
  const good = await svc.request({ method: 'POST', path: '/api/internal/cards/card-a/commands', bodyText: body,
    headers: { 'x-acp-internal-token': token.trim() } });
  assert.equal(good.status, 200, J(good.json));
  // The user channel cannot reach internal commands.
  const forged = await cmd(svc, 'card-a', {
    commandId: 'hb-forged', type: 'heartbeat', channel: 'internal',
    expectedInternalRevision: card.internalRevision,
    payload: { runnerId: 'r', instanceId: 'i' },
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.json.code, 'internal_forbidden');
  // Token never leaks: not in card views, runs, events, or errors.
  assert.ok(!J(card).includes(token.trim()));
  assert.ok(!J(noTok.json).includes(token.trim()));
  assert.ok(!J(badTok.json).includes(token.trim()));
});

// ==========================================================================
// containment / filesystem safety
// ==========================================================================

test('symlinked projectKey parent dir is refused (workspace_path_escape)', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Pre-plant a symlink where the projectKey dir would be created.
  const realRoot = await fs.realpath(wsRoot);
  const keyDir = join(realRoot, projectKeyFor(projectDir));
  const outside = join(env.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(realRoot, { recursive: true });
  await fs.symlink(outside, keyDir);
  const S = mkSched(env);
  const out = await S.sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.status, 'blocked', J(run.diagnostic ?? {}));
  assert.equal((await fs.readdir(outside)).length, 0);
  assert.equal(starts(S.runtime).length, 0);
});

test('workspace_ready requires owner instance; heartbeat renews only owned attempts', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const wsId = `ws-${runId}`;
  const wpath = workspacePath(await fs.realpath(wsRoot), projectKeyFor(projectDir), 'card-a', wsId);
  const ownerA = { runnerId: 'host-runner', instanceId: 'inst-A', pid: 1,
    pidStarttime: 'x', envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' } };
  const ownerB = { ...ownerA, instanceId: 'inst-B', pid: 2 };
  const rev = async () => (await getCard(svc, 'card-a')).json.internalRevision;
  const bw = await internal(svc, 'card-a', {
    commandId: 'bw-o', type: 'begin_workspace', expectedInternalRevision: await rev(),
    payload: { workspaceId: wsId, runId, branch: `acp/card-a/${wsId}`,
      baseCommit: git(projectDir, 'rev-parse', 'HEAD'), path: wpath, ...ownerA },
  });
  assert.equal(bw.status, 200, J(bw.body));
  const wrB = await internal(svc, 'card-a', {
    commandId: 'wr-o', type: 'workspace_ready', expectedInternalRevision: await rev(),
    payload: { workspaceId: wsId, runId, head: git(projectDir, 'rev-parse', 'HEAD'), ...ownerB },
  });
  assert.equal(wrB.status, 409);
  assert.equal(wrB.body.code, 'not_workspace_owner');
  // Heartbeat foreign attempt → 409.
  const S = await liveRun(env, { instanceId: 'inst-A2' });
  void S;
  const run = await runView(svc, runId);
  const att = run.attempts[0];
  const hb = await internal(svc, 'card-a', {
    commandId: 'hb-o', type: 'heartbeat', expectedInternalRevision: await rev(),
    payload: { runnerId: 'host-runner', instanceId: 'inst-B', pid: 2,
      pidStarttime: 'x', envKey: att.owner.envKey,
      attempts: [{ runId, attemptId: att.id }], leaseMs: 60000 },
  });
  assert.equal(hb.status, 409);
  assert.equal(hb.body.code, 'not_attempt_owner');
});

// ==========================================================================
// Concurrency, dedup, barrier, crash-window, and provisioning coverage
// ==========================================================================

test('slots >=2: card-b launches while card-a stays running', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a'), cardFixture('card-b')]);
  const runA = await mkManagedRun(svc, 'card-a');
  const runB = await mkManagedRun(svc, 'card-b');
  await fs.mkdir(paths(stateDir).root, { recursive: true });
  // Cap 1: exactly one card launches, the other is refused a durable attempt.
  await fs.writeFile(paths(stateDir).schedulerFile,
    J({ limits: { global: 1, roles: { implementer: 1 } } }));
  // outcome 'never': the launched supervisor stays live across ticks so the
  // slot-occupancy assertions exercise running reservations, not resolution.
  const S = mkSched(env, { instanceId: 'inst-S', behavior: { outcome: 'never' } });
  await S.sched.tick();
  let a = await runView(svc, runA);
  let b = await runView(svc, runB);
  const aUp = a.attempts[0]?.status === 'running';
  const bUp = b.attempts[0]?.status === 'running';
  assert.ok(aUp !== bUp, 'exactly one card holds the single global slot');
  assert.equal(starts(S.runtime).length, 1);
  // Raising the cap lets the queued card launch while the first stays running.
  await fs.writeFile(paths(stateDir).schedulerFile,
    J({ limits: { global: 2, roles: { implementer: 2 } } }));
  await S.sched.tick();
  a = await runView(svc, runA);
  b = await runView(svc, runB);
  assert.equal(a.attempts.length, 1);
  assert.equal(b.attempts.length, 1);
  assert.equal(a.attempts[0].status, 'running');
  assert.equal(b.attempts[0].status, 'running');
  assert.equal(starts(S.runtime).length, 2);
  // Steady state: further ticks observe, never relaunch.
  await S.sched.tick();
  assert.equal(starts(S.runtime).length, 2);
  assert.equal((await runView(svc, runA)).attempts.length, 1);
  assert.equal((await runView(svc, runB)).attempts.length, 1);
});

test('legacy stageRoles barrier: managed card excluded from legacy dispatch', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  await putDoc(svc, 'roles.json', {
    version: 1,
    roles: [{ id: 'implementer', cli: 'pi', model: 'm', maxConcurrent: 4 }],
    stageRoles: { spec: 'implementer' },
  });
  await putDoc(svc, 'claims.json', { version: 1, claims: {}, attempts: {} });
  await putDoc(svc, 'board.json', boardWith([
    cardFixture('card-legacy'),
    cardFixture('card-m'),
  ]));
  // Both rows sit on a stage bound by stageRoles — legacy-dispatchable shape.
  let board = (await req(svc, 'GET', '/api/state/board.json')).json.data;
  const legacyRow = board.cards.find((c) => c.id === 'card-legacy');
  assert.equal(isManagedCard(legacyRow), false);
  assert.equal(legacyCardDispatchable(legacyRow), true); // legacy machinery still sees it
  // Enabling (inside the pipeline) projects execution.managed onto the BOARD
  // row — the exact field acp-runner's dispatch loop checks via the guard.
  const runM = await mkManagedRun(svc, 'card-m');
  board = (await req(svc, 'GET', '/api/state/board.json')).json.data;
  const managedRow = board.cards.find((c) => c.id === 'card-m');
  assert.equal(isManagedCard(managedRow), true);
  assert.equal(legacyCardDispatchable(managedRow), false); // barrier holds even with stageRoles
  const S = mkSched(env, { instanceId: 'inst-S' });
  await S.sched.tick();
  const run = await runView(svc, runM);
  assert.equal(run.attempts[0].status, 'running');
  assert.equal(starts(S.runtime).length, 1);
  const boardAfter = (await req(svc, 'GET', '/api/state/board.json')).json.data;
  const legacyAfter = boardAfter.cards.find((c) => c.id === 'card-legacy');
  assert.equal(legacyAfter.execution?.managed ?? false, false);
  const claims = (await req(svc, 'GET', '/api/state/claims.json')).json.data;
  assert.equal(claims.claims?.['card-legacy'], undefined);
});

test('duplicate user start dedups; a second start on a live run is refused', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const req1 = await attachDoc(svc, 'card-a', 'requirements', '# Req');
  await approve(svc, 'card-a', 'approve_requirements', req1);
  const plan = await attachDoc(svc, 'card-a', 'plan', '# Plan',
    { checks: [{ run: 'npm test', timeoutSec: 300 }] });
  await approve(svc, 'card-a', 'approve_plan', plan);
  await savePreset(svc, 'card-a');
  let c = await getCard(svc, 'card-a');
  const startBody = {
    commandId: 'st-dup-1', type: 'start',
    expectedControlRevision: c.json.controlRevision, payload: {},
  };
  const s1 = await cmd(svc, 'card-a', startBody);
  assert.equal(s1.status, 200, J(s1.json));
  const runId = s1.json.result.runId;
  // Exact replay: the recorded outcome is returned — no second run created.
  const s2 = await cmd(svc, 'card-a', startBody);
  assert.equal(s2.status, 200);
  assert.equal(s2.json.result.runId, runId);
  // A different commandId is a NEW user intent: refused while a run is live.
  c = await getCard(svc, 'card-a');
  const s3 = await cmd(svc, 'card-a', {
    commandId: 'st-dup-2', type: 'start',
    expectedControlRevision: c.json.controlRevision, payload: {},
  });
  assert.equal(s3.status, 409);
  assert.equal(s3.json.code, 'run_active');
  // Scheduler drives exactly one attempt for the one durable run.
  const S = mkSched(env, { instanceId: 'inst-S' });
  await S.sched.tick();
  const run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(starts(S.runtime).length, 1);
  const card = await getCard(svc, 'card-a');
  assert.equal((card.json.runs || []).length, 1);
});

test('crash after durable attempt, before runtime.start: restart blocks conservatively', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  const registry = createFakeRuntime({})._registry;
  // Hook fires AFTER begin_attempt committed, BEFORE runtime.start — the
  // controller dies in that window (hook throw = the crash seam).
  const A = mkSched(env, {
    instanceId: 'inst-A', registry,
    environment: { pid: 99050, pidStarttime: 'st-99050' },
    hooks: { onAttemptDurable: () => { throw new Error('controller died'); } },
  });
  const out1 = await A.sched.tick();
  assert.equal((out1.errors || []).length, 1, J(out1));
  assert.equal(starts(A.runtime).length, 0); // runtime.start never ran
  let run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].status, 'launching');
  // Owner Node is provably dead. The restart adopts the attempt, finds NO
  // launch record and NO registry match — conservative block, never a
  // duplicate attempt, never a second launch.
  registry.procs.set(99050, { exists: false });
  const B = mkSched(env, { instanceId: 'inst-B', registry });
  await B.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].status, 'launching');
  assert.equal(run.attempts[0].owner.instanceId, 'inst-B');
  assert.equal(run.diagnostic?.code, 'launcher_unproven');
  assert.equal(starts(B.runtime).length, 0);
  // A further tick stays blocked — the reservation is retained, not retried.
  await B.sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.diagnostic?.code, 'launcher_unproven');
  assert.equal(starts(B.runtime).length, 0);
});

test('scheduler events land with strictly advancing seqs (result.seq envelope)', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Live launcher, no registry match: every tick records one launcher_alive
  // event through the REAL {internalRevision,result:{seq}} envelope.
  const S = mkSched(env, {
    instanceId: 'inst-A',
    behavior: { launch: 'uncertain', launcherAlive: true, uncertainRegisters: false },
  });
  await S.sched.tick();
  await S.sched.tick();
  await S.sched.tick();
  const ev = await getEvents(svc, runId);
  assert.equal(ev.status, 200, J(ev.json));
  assert.deepEqual(ev.json.events.map((e) => e.seq), [0, 1, 2]);
  assert.ok(ev.json.events.every((e) => e.type === 'launcher_alive'));
  const run = await runView(svc, runId);
  assert.equal(run.eventsCursor, 3);
  assert.equal(run.attempts[0].status, 'launching');
});

test('workspace root access: foreign-uid non-writable root fails closed', async () => {
  if (myUid === null) return; // uid semantics unavailable
  const foreignUid = myUid + 40000;
  const foreignGid = (myGid ?? myUid) + 40000;
  // Existing root not writable by the configured runner uid → refuse.
  const ro = join(tmpdir(), `u3-ro-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(ro, { mode: 0o555 });
  const forbidden = (e) => {
    assert.equal(e.code, 'workspace_root_forbidden');
    return true;
  };
  await assert.rejects(
    ensureWorkspaceRootAccess(ro, { ownerUid: foreignUid, ownerGid: foreignGid }),
    forbidden);
  // o+w grants access to a foreign runner uid.
  await fs.chmod(ro, 0o777);
  const st = await ensureWorkspaceRootAccess(ro, { ownerUid: foreignUid, ownerGid: foreignGid });
  assert.ok(st.isDirectory());
  // Self-owned root passes for our own uid without foreign-grant bits.
  const own = join(tmpdir(), `u3-own-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(own, { mode: 0o700 });
  const st2 = await ensureWorkspaceRootAccess(own, { ownerUid: myUid, ownerGid: myGid });
  assert.ok(st2.isDirectory());
  // Missing root: created; for a foreign uid a non-root process cannot chown
  // → fail closed. As root the chown happens and access verifies.
  const missing = join(tmpdir(), `u3-miss-${randomUUID().slice(0, 8)}`);
  if (myUid === 0) {
    const st3 = await ensureWorkspaceRootAccess(missing, { ownerUid: foreignUid, ownerGid: foreignGid });
    assert.equal(st3.uid, foreignUid);
  } else {
    await assert.rejects(
      ensureWorkspaceRootAccess(missing, { ownerUid: foreignUid, ownerGid: foreignGid }),
      forbidden);
  }
});

test('source git common-dir failure aborts allocation (fail closed)', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir);
  const runId = await mkManagedRun(svc);
  // Stub git: everything delegates to the real binary EXCEPT the
  // `--git-common-dir` probe, which now fails — a repo we can rev-parse
  // but whose object store cannot be positively resolved must NOT fall
  // back to unverified allocation.
  const binDir = join(env.root, 'stubbin');
  await fs.mkdir(binDir, { recursive: true });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
  await fs.writeFile(join(binDir, 'git'),
    '#!/bin/sh\nfor a in "$@"; do [ "$a" = "--git-common-dir" ] && { echo "common-dir probe failed" >&2; exit 3; }; done\nexec "' + realGit + '" "$@"\n');
  await fs.chmod(join(binDir, 'git'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  let out;
  try {
    const S = mkSched(env, { instanceId: 'inst-S' });
    out = await S.sched.tick();
  } finally {
    process.env.PATH = oldPath;
  }
  assert.ok((out.errors || []).some((e) => /common dir/.test(e.error)), J(out));
  const run = await runView(svc, runId);
  assert.equal(run.attempts.length, 0);         // no attempt without a proven ws
  const card = await getCard(svc, 'card-a');
  const wsIds = Object.keys(card.json.workspaces || {});
  for (const wsId of wsIds) {
    const ws = card.json.workspaces[wsId];
    const exists = await fs.stat(ws.path).then(() => true).catch(() => false);
    assert.equal(exists, false, `no directory may exist at ${ws.path}`);
  }
});

test('internal token: EACCES/ENOTDIR diagnosed, never treated as absent', async () => {
  if (myUid === null || myUid === 0) return; // EACCES semantics need a non-root uid
  const root = join(tmpdir(), `u3-tok-${randomUUID().slice(0, 8)}`);
  // Case 1: token dir is a regular FILE → mkdir ENOTDIR is a diagnostic.
  const stateDir1 = join(root, 's1');
  await fs.mkdir(stateDir1, { recursive: true });
  await fs.writeFile(join(stateDir1, 'execution'), 'not-a-dir');
  const r1 = await ensureInternalToken(stateDir1, { readerUid: myUid, readerGid: myGid });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'token_dir_unwritable', J(r1));
  // Case 2: token dir exists but is inaccessible → lstat EACCES, not absent.
  const stateDir2 = join(root, 's2');
  await fs.mkdir(join(stateDir2, 'execution'), { recursive: true });
  await fs.chmod(join(stateDir2, 'execution'), 0o000);
  const r2 = await ensureInternalToken(stateDir2, { readerUid: myUid, readerGid: myGid });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'token_stat_failed', J(r2));
  // Heal: restoring access provisions normally.
  await fs.chmod(join(stateDir2, 'execution'), 0o700);
  const r3 = await ensureInternalToken(stateDir2, { readerUid: myUid, readerGid: myGid });
  assert.equal(r3.ok, true, J({ code: r3.code, message: r3.message }));
  assert.ok(r3.token && r3.token.length >= 32);
});
