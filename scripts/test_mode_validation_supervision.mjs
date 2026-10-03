// Shared mode validation supervision regression: real state/queue, Git and check process; fake Porch only.
//   node --test scripts/u5_domain_selftest.mjs
//
// Everything runs through createStateService's REAL request/queue path plus
// the REAL scheduler — real git worktrees, real bash check processes in real
// process groups, real artifact import, real CAS/dedup. The only fake is the
// porch runtime (agent supervisors); reviewer/checker EVIDENCE files are
// written by the test into the pristine copies exactly where a real agent
// would write them, WHILE the attempt is still live.
//
// NOTHING opens a listener, touches compose, or uses the live state dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createFakeRuntime } from '../server/execution/fake-runtime.mjs';
import { createManagedDriver, runServe } from '../server/acp-runner.mjs';
import { createManagedScheduler } from '../server/execution/managed-scheduler.mjs';
import { createInternalClient } from '../server/execution/internal-transport.mjs';
import { saveSchedulerLimits, loadEnvironments, saveEnvironments, loadAggregate, saveAggregate, loadRun, saveRun, sha256 } from '../server/execution/execution-store.mjs';
import { applyEnvCommand } from '../server/execution/execution-domain.mjs';
import {
  procStarttimeLocal, procNsOfLocal, procIdentityLocal, procGroupMembers,
} from '../server/execution/result-snapshot.mjs';
import { FINDINGS_FILE, VERDICTS_FILE } from '../server/execution/prompt.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
const myGid = typeof process.getgid === 'function' ? process.getgid() : null;
const MY_PIDNS = procNsOfLocal('pid', process.pid);

const cleanupRoots = new Set();
const livePgroups = new Set(); // recorded leader bindings still owed a cleanup
after(async () => {
  for (const rec of livePgroups) await killRecordedGroup(rec);
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

// Fixture cleanup: signal ONLY processes still provably ours — leader alive
// with the recorded {starttime,pidNs,uid} binds the pgid; a dead leader
// means the pgid slot may be recycled, so members are verified and killed
// individually. Foreign/mismatched identities are never signalled.
async function killRecordedGroup(rec) {
  const leader = rec?.leader ?? rec;
  const pgid = leader?.pgid;
  if (!Number.isInteger(pgid) || pgid <= 0) return;
  const cur = procIdentityLocal(leader.pid);
  const ours = (id) => id && id.alive === true && id.pgrp === pgid
    && id.uid === leader.uid && id.pidNs === leader.pidNs;
  if (cur && cur.alive === true && cur.starttime === leader.starttime && ours(cur)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  const members = procGroupMembers(pgid) || [];
  for (const m of members) {
    if (!ours(m)) continue;
    try { process.kill(m.pid, 'SIGKILL'); } catch { /* dead */ }
  }
}

// ---- fixtures ----------------------------------------------------------------

async function mkEnv({ faults, features = { start: true, validation: true }, envExtra = {} } = {}) {
  const root = join(tmpdir(), `u5d-state-${randomUUID().slice(0, 8)}`);
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
      ACP_EXEC_VALIDATION: '1',
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
      ...envExtra,
    },
    faults,
    features,
  });
  return { root, stateDir, wsRoot, projectDir, svc };
}

async function mkProject() {
  const dir = join(tmpdir(), `u5d-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  await fs.writeFile(join(dir, 'README.md'), '# fixture\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
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

function mkClient(svc, stateDir, sw = null) {
  // sw.down    — every request fails with ECONNREFUSED (full API outage).
  // sw.drop    — Set<commandId>: a specific command fails; with
  //              sw.applyDrop the command EXECUTES first (response lost
  //              after apply — the server dedup/receipt must prove it).
  // sw.landed  — records dropped ids that applied with a real 2xx.
  // sw.failed  — dropped ids whose apply produced a non-2xx: the injection
  //              fired but the command did NOT land.
  // sw.dropPrefix — array of command-id PREFIXES dropped like sw.drop
  //              (journal-replay keys jr-*, adoption keys, …) without
  //              needing the exact deterministic id up front.
  // sw.dropGet — artifact-route GETs fail with ECONNREFUSED (artifact-plane
  //              outage only — commands/reads elsewhere still land); each
  //              intercepted call is recorded in sw.getTries.
  // The injected transport receives `body` as the ORIGINAL object (the
  // client's default transport JSON.stringify's it) — parse it only when a
  // string ever arrives.
  return createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      const cid = body && typeof body === 'object' ? body.commandId ?? null : null;
      if (sw?.dropGet && method === 'GET' && /\/artifacts\//.test(path)) {
        (sw.getTries ??= []).push(path);
        return Promise.reject(new Error('connect ECONNREFUSED — simulated artifact-plane outage'));
      }
      // sw.reject — deterministic domain-class rejections without touching
      // the service: [{when(body), status, code, times, note}] — the first
      // `times` (default 1) matching commands answer {status, body} instead
      // of reaching svc.request. status>=500 surfaces as the outage class
      // (journaled + retried); 4xx is a non-outage rejection — the exact
      // boundary the U5-0501 investigation probes.
      for (const rule of sw?.reject || []) {
        if ((rule.times ?? 1) > 0 && rule.when?.(body)) {
          rule.times = (rule.times ?? 1) - 1;
          (sw.rejected ??= []).push({ cid, code: rule.code });
          return {
            status: rule.status,
            body: { error: rule.note ?? `injected ${rule.code}`, code: rule.code },
          };
        }
      }
      const dropped = cid && (sw?.drop?.has(cid)
        || (sw?.dropPrefix || []).some((px) => cid.startsWith(px)));
      if (sw?.down || dropped) {
        if (!sw?.down && sw?.applyDrop && cid) {
          const u0 = new URL(path, 'http://t');
          const applied = await svc.request({
            method, path: u0.pathname, query: u0.searchParams,
            bodyText: JSON.stringify(body), headers,
          });
          if (applied.status >= 200 && applied.status < 300) {
            (sw.landed ??= []).push(cid);
          } else {
            (sw.failed ??= []).push({ cid, status: applied.status, code: applied.json?.code });
          }
        }
        // freeze the WHOLE api the instant a dropped send is attempted —
        // no rebound-key replay can land the duty while the fixture
        // inspects the unapplied state. applyDrop above still runs first.
        if (sw?.downAfterDrop || sw?.downOnDrop) sw.down = true;
        return Promise.reject(new Error('connect ECONNREFUSED — simulated outage'));
      }
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : JSON.stringify(body), headers,
      });
      if (sw && method === 'GET' && r.status >= 200 && r.status < 300) {
        sw.gets = (sw.gets || 0) + 1; // landed read — proves live transport
      }
      return { status: r.status, body: r.json };
    },
  });
}

// Scheduler with REAL process identity in environment() — the checks it
// spawns are real bash in THIS environment, so the identity it attests must
// be the real one, not a fixture's.
function mkSched(env, {
  registry, behaviors, instanceId = `inst-${randomUUID().slice(0, 8)}`,
  runnerId = 'host-runner', hooks, sw, leaseMs = 30_000, now,
  validationEnabled = true, ownerIsInit = false, instPid = 90000 + Math.floor(Math.random() * 8000),
} = {}) {
  const runtime = createFakeRuntime({
    registry,
    rootDir: join(env.root, 'fake-exec'),
    environment: {
      pid: instPid, pidStarttime: `st-${instPid}`,
      uid: myUid, gid: myGid, hostname: hostname(),
      pidNs: MY_PIDNS,
      bootId: 'fakeboot',
      envInstance: { containerId: hostname(), initStarttime: ownerIsInit ? `st-${instPid}` : procStarttimeLocal(1) },
    },
    behaviors,
  });
  if (registry) {
    registry.procs.set(instPid, { exists: true, state: 'R', starttime: `st-${instPid}`, readable: true });
  }
  const sched = createManagedScheduler({
    client: mkClient(env.svc, env.stateDir, sw),
    runtime, runnerId, instanceId, leaseMs, now,
    stateDir: env.stateDir,
    validationEnabled,
    env: { ACP_WORKSPACE_DIR: env.wsRoot, ROOT_DIR: env.root },
    hooks,
    orchestrator: { runtime: {} },
    swarm: { driver: { drive: async () => "swarm_parked" } },
  });
  return { sched, runtime, instanceId, instPid };
}

function cardFixture(id, over = {}) {
  return { id, title: id, stage: 'spec', status: 'in_progress', project: 'proj-x', order: 10, ...over };
}
async function seedBase(svc, projectDir, cards = [cardFixture('card-a')]) {
  await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  return putDoc(svc, 'board.json', { version: 2, cards });
}
async function enable(svc, cardId = 'card-a') {
  const r = await cmd(svc, cardId, { commandId: `en-${randomUUID().slice(0, 6)}`, type: 'enable' });
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
  return r.json.result;
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
async function savePreset(svc, cardId, preset) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `ps-${randomUUID().slice(0, 6)}`, type: 'save_preset',
    expectedControlRevision: c.json.controlRevision,
    payload: { preset },
  });
  assert.equal(r.status, 200, J(r.json));
}
const MEMBER = { cli: 'pi', model: 'zen-relay/muse-spark-1.3-contributor-free' };

// A managed run whose plan approves REAL executable checks.
async function mkValidationRun(svc, cardId, checks, preset) {
  await enable(svc, cardId);
  const reqDoc = await attachDoc(svc, cardId, 'requirements', `# Req ${cardId}`);
  await approve(svc, cardId, 'approve_requirements', reqDoc);
  const plan = await attachDoc(svc, cardId, 'plan', `# Plan ${cardId}`, { checks });
  await approve(svc, cardId, 'approve_plan', plan);
  await savePreset(svc, cardId, preset ?? {
    id: `preset-${randomUUID().slice(0, 8)}`, name: 't',
    members: { implementer: { ...MEMBER }, reviewer: { ...MEMBER }, checker: { ...MEMBER } },
    limits: { maxAttemptsPerRole: 3 },
  });
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

// The role evidence file lands in the role's pristine copy while the attempt
// is still live — record_report reads committed artifact bytes later.
async function writeRoleDoc(run, role, doc) {
  const dir = role === 'reviewer' ? run.validation.dirs.review : run.validation.dirs.check;
  const name = role === 'reviewer' ? FINDINGS_FILE : VERDICTS_FILE;
  await fs.mkdir(join(dir, '.acp-out'), { recursive: true });
  await fs.writeFile(join(dir, '.acp-out', name), J(doc));
}

// Drive ticks + settle until `pred(run)` holds (or timeout). Long-running
// check groups observed in the record are collected for cleanup.
async function drive(svc, sched, runId, pred, { maxTicks = 80, delayMs = 60 } = {}) {
  for (let i = 0; i < maxTicks; i += 1) {
    await sched.tick();
    const run = await runView(svc, runId);
    for (const p of Object.values(run.validation?.procs || {})) {
      if (p?.leader?.pgid && p.state !== 'settled') livePgroups.add(p);
    }
    if (await pred(run)) return run;
    await sleep(delayMs);
  }
  const run = await runView(svc, runId);
  // Surface the ACTUAL terminal trail on timeout — a load guess helps no one:
  // run.error (failed/cancelled reason), run.diagnostic (unproven etc.),
  // proc/report states, and the durable event tail.
  let events = [];
  try {
    const ev = await req(svc, 'GET', `/api/execution/runs/${runId}/events`);
    events = (ev.json?.events || ev.json || []).slice(-8);
  } catch { /* diag best-effort */ }
  throw new Error(`drive timeout — last run ${run.status}/${run.phase ?? '-'} val=${
    run.validation ? `${run.validation.status}/${run.validation.phase ?? '-'}` : 'none'
  } error=${run.error ?? 'null'} diag=${J(run.diagnostic ?? null)} procs=${J(
    Object.fromEntries(Object.entries(run.validation?.procs || {})
      .map(([k, p]) => [k, { s: p?.state, proof: p?.proof ?? null }])))} reports=${J(
    (run.validation?.checks?.reports || []).map((r) => ({ i: r.index, st: r.status, ec: r.exitCode })))} events=${J(
    events.map((e) => ({ t: e.type, d: e.detail ?? e.code ?? null })))}`);
}

// Ask the run to stop through the real command surface, then drive until the
// run is cancelled — the owned check group must be proven dead first.
async function stopAndDrain(svc, sched, runId, cardId, maxTicks = 120) {
  const c = await getCard(svc, cardId);
  await cmd(svc, cardId, {
    commandId: `stop-${randomUUID().slice(0, 6)}`, type: 'stop',
    expectedControlRevision: c.json.controlRevision,
    payload: { reason: 'test cleanup' },
  }).catch(() => {});
  for (let i = 0; i < maxTicks; i += 1) {
    await sched.tick();
    const r = await runView(svc, runId).catch(() => null);
    if (!r || r.status === 'cancelled' || ['failed', 'succeeded', 'blocked'].includes(r.status)) {
      return r;
    }
    await sleep(50);
  }
  return runView(svc, runId);
}


for (const mode of ['orchestrator', 'swarm']) for (const recovery of ['none', 'lost-bind', 'init-death']) {
  const lostBind = recovery === 'lost-bind';
  const initDeath = recovery === 'init-death';
  test(`${mode}: shared roles settle/import evidence${recovery === "none" ? "" : ` after ${recovery}`}`, async () => {
    const env = await mkEnv();
    await seedBase(env.svc, env.projectDir);
    const runId = await mkValidationRun(env.svc, 'card-a', [{run: 'true', timeoutSec: 5}]);
    const sw = {};
    let {sched, runtime, instPid} = mkSched(env, {sw, ownerIsInit: initDeath});
    await drive(env.svc, sched, runId, r => r.validation?.phase === "review");
    let run = await drive(env.svc, sched, runId, r => r.attempts.some(a => a.role === 'reviewer'));
    // Persist the exact shared-U5 handoff boundary; mode workers are already settled.
    const stored = await loadRun(env.stateDir, runId);
    stored.mode = mode;
    if (initDeath) {
      const attempt = stored.attempts.find(a => a.role === 'reviewer');
      attempt.status = 'running';
      attempt.finishedAt = null;
    }
    if (lostBind) {
      // Crash boundary: runtime has spawned/registered the reviewer, but its
      // durable bind is absent. Recovery must find that same supervisor.
      const attempt = stored.attempts.find(a => a.role === 'reviewer');
      attempt.status = 'launching';
      attempt.porchRunId = null;
      attempt.supervisor = null;
      attempt.finishedAt = null;
    }
    await saveRun(env.stateDir, stored);
    const aggregate = await loadAggregate(env.stateDir, 'card-a');
    aggregate.runs[aggregate.runs.findIndex(r => r.id === runId)] = stored;
    await saveAggregate(env.stateDir, aggregate);
    if (lostBind || initDeath) {
      runtime._registry.procs.set(instPid, {exists: false, readable: true});
      ({sched, runtime} = mkSched(env, {registry: runtime._registry}));
    }
    run = await runView(env.svc, runId);
    const reviewer = run.attempts.find(a => a.role === 'reviewer');
    if (lostBind) {
      assert.equal(reviewer.status, "launching");
      assert.equal(reviewer.porchRunId, null);
    }
    await writeRoleDoc(run, 'reviewer', {version: 1, round: run.validation.round,
      resultSha256: run.validation.resultSha256, findings: []});
    await sleep(25);
    if (initDeath) {
      const status = runtime.status.bind(runtime);
      runtime.status = async () => ({ok: false, error: {code: 'temporary_read_failure'}});
      await sched.tick();
      let retained = await runView(env.svc, runId);
      assert.equal(retained.attempts.find(a => a.id === reviewer.id).owner.instanceId, reviewer.owner.instanceId);
      assert.equal(retained.status, 'active');
      runtime.status = status;
      const wait = runtime.wait.bind(runtime);
      runtime.wait = async () => ({ok: false, error: {code: 'temporary_result_failure'}});
      await sched.tick();
      retained = await runView(env.svc, runId);
      assert.equal(retained.attempts.find(a => a.id === reviewer.id).owner.instanceId, reviewer.owner.instanceId);
      assert.equal(retained.status, 'active');
      runtime.wait = wait;
    }
    run = await drive(env.svc, sched, runId, r => Boolean(r.validation?.reports?.findings), {maxTicks: 8, delayMs: 10});
    assert.equal(run.attempts.find(a => a.id === reviewer.id).status, 'completed');
    assert.equal(run.validation.reports.findings.attemptId, reviewer.id);
    run = await drive(env.svc, sched, runId, r => r.attempts.some(a => a.role === 'checker'));
    await writeRoleDoc(run, 'checker', {version: 1, round: run.validation.round,
      resultSha256: run.validation.resultSha256, verdicts: []});
    run = await drive(env.svc, sched, runId, r => r.status === 'awaiting_acceptance');
    assert.equal(run.validation.status, 'settled');
    for (const role of ['reviewer', 'checker']) {
      assert.equal(run.attempts.filter(a => a.role === role).length, 1, `${role} starts once`);
    }
  });
}
