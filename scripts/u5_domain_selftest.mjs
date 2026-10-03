// scripts/u5_domain_selftest.mjs — integrated U5 validation-pipeline tests.
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
  validationEnabled = true, instPid = 90000 + Math.floor(Math.random() * 8000),
} = {}) {
  const runtime = createFakeRuntime({
    registry,
    rootDir: join(env.root, 'fake-exec'),
    environment: {
      pid: instPid, pidStarttime: `st-${instPid}`,
      uid: myUid, gid: myGid, hostname: hostname(),
      pidNs: MY_PIDNS,
      bootId: 'fakeboot',
      envInstance: { containerId: hostname(), initStarttime: procStarttimeLocal(1) },
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

// ============================================================================
// The golden path: begin → snapshot → copies → real check → review →
// check_review → awaiting_acceptance → accept_result → succeeded.
// ============================================================================

test('U5 golden path: full pipeline through the real command surface', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [
    { run: 'test -f src/a.js && echo stdout-proof && echo err-proof >&2', timeoutSec: 30 },
  ]);
  const { sched } = mkSched(env);

  try {
    // Drive to awaiting_validation (implementer completes via fake runtime).
    let run = await drive(svc, sched, runId,
      (r) => r.phase === 'awaiting_validation' && r.status === 'active');

    // Validation begins and runs the REAL check end-to-end.
    run = await drive(svc, sched, runId,
      (r) => r.validation?.phase === 'review' || r.phase === 'review');
    const val = run.validation;
    assert.equal(val.status, 'active', J({ s: val.status, p: val.phase }));
    assert.ok(/^val_/.test(val.id), `validation id ${val.id}`);
    assert.equal(val.checks.verdict, 'pass', 'the real check passed');
    assert.ok(val.resultSha256 && /^[0-9a-f]{64}$/.test(val.resultSha256),
      'a result hash must be recorded before any barrier test is meaningful');
    assert.ok(val.copiesReady, 'durable copy receipt recorded');
    // Proc record carries the real spawned identity, proven dead.
    const proc = Object.values(val.procs)[0];
    assert.equal(proc.state, 'settled', J(proc));
    assert.equal(proc.proof?.groupDead, true);
    assert.ok(proc.leader.pid > 0 && proc.leader.pgid === proc.leader.pid);
    // The check report binds exact approved metadata + verified log artifacts.
    const report = val.checks.reports[0];
    assert.equal(report.status, 'pass');
    assert.equal(report.index, 0);
    assert.match(report.stdoutTail ?? '', /stdout-proof/);
    assert.ok(report.logOutArtifactId && report.logErrArtifactId);
    // Independent pristine copies: each is a real self-contained repo — its
    // .git is a directory and its common-dir realpath is NOT the source's.
    const srcCommon = await fs.realpath(
      git(projectDir, 'rev-parse', '--absolute-git-dir'));
    for (const key of ['base', 'verify', 'review', 'check']) {
      const d = val.dirs[key];
      const gitSt = await fs.lstat(join(d, '.git'));
      assert.ok(gitSt.isDirectory(), `${key} .git must be a real dir, not a worktree link`);
      const copyCommon = await fs.realpath(git(d, 'rev-parse', '--absolute-git-dir'));
      assert.notEqual(copyCommon, srcCommon,
        `${key} shares the source object store — copies must be independent`);
      const copyHead = git(d, 'rev-parse', 'HEAD');
      assert.match(copyHead, /^[0-9a-f]{40}$/);
    }
    assert.ok(
      (await fs.readFile(join(val.dirs.review, 'src', 'a.js'), 'utf-8')).includes('a = 1'),
      'review copy carries the result bytes');

    // Reviewer attempt launches into the review copy; the findings doc is
    // written while the attempt is still live (before its resolve lands).
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'));
    const revAtt = run.attempts.find((a) => a.role === 'reviewer');
    assert.equal(revAtt.validationId, run.validation.id);
    assert.equal(revAtt.phase, 'review');
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      findings: [{
        id: 'f1', round: run.validation.round, severity: 'major',
        text: 'a.js lacks a comment', where: 'src/a.js:1', status: 'open',
      }, {
        id: 'f2', round: run.validation.round, severity: 'minor',
        text: 'naming nit', where: 'src/a.js:2', status: 'open',
      }],
    });
    run = await drive(svc, sched, runId,
      (r) => r.validation?.phase === 'check_review' || r.phase === 'check_review');
    assert.equal(run.validation.reports.findings.doc.findings[0].id, 'f1');
    assert.equal(run.validation.reports.findings.attemptId, revAtt.id);

    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'));
    await writeRoleDoc(run, 'checker', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      verdicts: [{ findingId: 'f1', verdict: 'rejected', reason: 'not a real issue' }],
    });
    run = await drive(svc, sched, runId, (r) => r.status === 'awaiting_acceptance');
    assert.equal(run.phase, 'awaiting_acceptance');
    assert.equal(run.validation.status, 'settled',
      'the gate decision closes the round reservation');
    // The open MINOR finding is retained verbatim in the recorded evidence
    // and never gated acceptance — reported-but-nonblocking is a real state.
    const f2 = run.validation.reports.findings.doc.findings.find((f) => f.id === 'f2');
    assert.equal(f2?.status, 'open', 'open minor retained in the recorded report');
    assert.equal(f2?.severity, 'minor');

    // Wrong-hash acceptance refuses; exact hash accepts.
    const card = await getCard(svc, 'card-a');
    const bad = await cmd(svc, 'card-a', {
      commandId: `acc-bad-${randomUUID().slice(0, 6)}`, type: 'accept_result',
      expectedControlRevision: card.json.controlRevision,
      payload: { runId, resultSha256: '0'.repeat(64) },
    });
    assert.equal(bad.status, 409, J(bad.json));
    assert.equal(bad.json.code, 'stale_result');
    const ok = await cmd(svc, 'card-a', {
      commandId: `acc-ok-${randomUUID().slice(0, 6)}`, type: 'accept_result',
      expectedControlRevision: (await getCard(svc, 'card-a')).json.controlRevision,
      payload: { runId, resultSha256: run.validation.resultSha256 },
    });
    assert.equal(ok.status, 200, J(ok.json));
    run = await runView(svc, runId);
    assert.equal(run.status, 'succeeded', J({ s: run.status, p: run.phase }));
  } finally {
    // Prove every recorded group dead before the temp roots go away — drop
    // tracking only for verified-settled records.
    const last = await runView(svc, runId).catch(() => null);
    for (const p of Object.values(last?.validation?.procs || {})) {
      if (p?.state === 'settled') livePgroups.delete(p);
      else if (p) await killRecordedGroup(p);
      livePgroups.delete(p);
    }
  }
});

// ============================================================================
// Acceptance boundary: a canonical-workspace mutation AFTER the gate parked
// the run at awaiting_acceptance must refuse the correct approved hash —
// the domain recomputes the live manifest; 'workspace_drift' is terminal-safe
// (the run stays parked) and restoring the bytes makes the accept land.
// ============================================================================

test('U5 accept boundary: workspace drift after the gate refuses, restore accepts', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok', timeoutSec: 30 }]);
  const { sched } = mkSched(env);
  try {
    // Drive the full pipeline to awaiting_acceptance (reviewer + checker
    // evidence land through the real .acp-out import path).
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'));
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      findings: [],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'));
    await writeRoleDoc(run, 'checker', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      verdicts: [],
    });
    run = await drive(svc, sched, runId, (r) => r.status === 'awaiting_acceptance');
    const acceptedSha = run.validation.resultSha256;

    // Resolve the canonical workspace from the aggregate — the path the
    // domain's live manifest recomputation reads.
    const agg = await loadAggregate(stateDir, 'card-a');
    const ws = agg.workspaces?.[run.workspaceId];
    assert.ok(ws?.path, 'canonical workspace recorded');
    const driftFile = join(ws.path, 'drift-marker.txt');

    // Mutate the result AFTER the gate: a new untracked file changes the
    // recorded manifest — accept with the ORIGINAL approved hash must fail
    // closed with the exact drift code, leaving the run parked.
    await fs.writeFile(driftFile, 'mutated after acceptance\n');
    const card1 = await getCard(svc, 'card-a');
    const drifted = await cmd(svc, 'card-a', {
      commandId: `acc-drift-${randomUUID().slice(0, 6)}`, type: 'accept_result',
      expectedControlRevision: card1.json.controlRevision,
      payload: { runId, resultSha256: acceptedSha },
    });
    assert.equal(drifted.status, 409, J(drifted.json));
    assert.equal(drifted.json.code, 'workspace_drift',
      `drift must refuse with the exact boundary code: ${J(drifted.json)}`);
    run = await runView(svc, runId);
    assert.equal(run.status, 'awaiting_acceptance',
      'a refused accept never terminalizes — the run stays parked');

    // Restore the result bytes — the recomputed manifest matches again and
    // the SAME approved hash accepts.
    await fs.rm(driftFile);
    const ok = await cmd(svc, 'card-a', {
      commandId: `acc-ok-${randomUUID().slice(0, 6)}`, type: 'accept_result',
      expectedControlRevision: (await getCard(svc, 'card-a')).json.controlRevision,
      payload: { runId, resultSha256: acceptedSha },
    });
    assert.equal(ok.status, 200, J(ok.json));
    assert.equal((await runView(svc, runId)).status, 'succeeded');
  } finally {
    const last = await runView(svc, runId).catch(() => null);
    for (const p of Object.values(last?.validation?.procs || {})) {
      if (p?.state === 'settled') livePgroups.delete(p);
      else if (p) await killRecordedGroup(p);
      livePgroups.delete(p);
    }
  }
});

// ============================================================================
// Stop during a running check: user stop lands mid-execution, the scheduler
// cancels only its proven group, the run finishes cancelled.
// ============================================================================

test('U5 stop during a running check drains the proven group', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  // Gate-held instead of a fixed sleep: the check can never expire or
  // timeout before the stop lands — the kill path is what is being proven.
  const gate = join(stateDir, 'stop-check-gate');
  const runId = await mkValidationRun(svc, 'card-a', [
    { run: `echo start && until [ -f '${gate}' ]; do sleep 0.1; done`, timeoutSec: 90 },
  ]);
  const { sched } = mkSched(env);
  let proc = null;
  try {
    const run = await drive(svc, sched, runId,
      (r) => r.validation?.phase === 'verify'
        && Object.values(r.validation?.procs || {}).some((p) => p?.leader?.pgid > 0));
    proc = Object.values(run.validation.procs)[0];
    assert.equal(proc.state, 'recorded');
    livePgroups.add(proc);

    const c = await getCard(svc, 'card-a');
    const st = await cmd(svc, 'card-a', {
      commandId: `stop-${randomUUID().slice(0, 6)}`, type: 'stop',
      expectedControlRevision: c.json.controlRevision,
      payload: { reason: 'test stop' },
    });
    assert.equal(st.status, 200, J(st.json));

    const after = await drive(svc, sched, runId, (r) => r.status === 'cancelled', { maxTicks: 120 });
    assert.equal(after.validation.status, 'cancelled');
    // Positive group death: the recorded pgid is verifiably gone.
    let dead = false;
    try { process.kill(-proc.leader.pgid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
    assert.ok(dead, 'check process group is verifiably dead');
    livePgroups.delete(proc);
  } finally {
    await fs.writeFile(gate, 'x').catch(() => {}); // release any survivor
    if (proc) { await killRecordedGroup(proc); livePgroups.delete(proc); }
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// U5 incident probe — reproduces the 2026-10-01 05:01 failure shape:
// FIXED `sleep 60` / timeoutSec 90 check stopped mid-run (the gate-held
// variant above was written AFTER the incident). On failure, drive() dumps
// the actual terminal trail (run error/diagnostic, proc states, check
// report exit codes, event tail) — that dump IS the evidence collected.
// ============================================================================

test('U5 incident probe: fixed-sleep check stopped mid-run', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  // Original shape: `sleep 60`, timeout 90 — no gate file, no early release.
  const runId = await mkValidationRun(svc, 'card-a', [
    { run: `sleep 60`, timeoutSec: 90 },
  ]);
  const { sched } = mkSched(env);
  let proc = null;
  const envRoot = dirname(stateDir);
  const dumpForensics = async (label) => {
    // Incident forensics: journal entries, check reports, proc proof, run
    // state — the exact evidence the 0501 failure lacked in the log.
    try {
      const run = await runView(svc, runId);
      const val = run.validation || {};
      console.error(`INCIDENT ${label} run=${run.status}/${run.phase} ` +
        `val=${val.status}/${val.phase} error=${run.error ?? 'null'} ` +
        `diag=${J(run.diagnostic ?? null)}`);
      console.error(`INCIDENT procs=${J(Object.fromEntries(Object.entries(
        val.procs || {}).map(([k, p]) => [k, {
          s: p?.state, pgid: p?.leader?.pgid ?? null,
          proof: p?.proof ?? null }])))}`);
      console.error(`INCIDENT reports=${J((val.checks?.reports || []).map(
        (r) => ({ i: r.index, st: r.status, ec: r.exitCode })))}`);
      for (const p of Object.values(val.procs || {})) {
        if (!p?.leader?.pgid) continue;
        try {
          process.kill(-p.leader.pgid, 0);
          console.error(`INCIDENT pgid ${p.leader.pgid} STILL ALIVE`);
        } catch (e) {
          console.error(`INCIDENT pgid ${p.leader.pgid} dead (${e.code})`);
        }
      }
      for (const jf of (await fs.readdir(envRoot, { recursive: true })
          .catch(() => [])).filter((f) => f.endsWith('.jsonl'))) {
        const p = join(envRoot, jf);
        const lines = (await fs.readFile(p, 'utf8')).trim().split('\n');
        console.error(`INCIDENT journal ${jf} tail=${J(
          lines.slice(-4).map((l) => l.slice(0, 300)))}`);
      }
    } catch (e) {
      console.error(`INCIDENT forensics failed: ${e.message}`);
    }
  };
  try {
    let run;
    try {
      run = await drive(svc, sched, runId,
        (r) => r.validation?.phase === 'verify'
          && Object.values(r.validation?.procs || {}).some((p) => p?.leader?.pgid > 0));
    } catch (e) {
      await dumpForensics('predrive-timeout');
      throw e;
    }
    proc = Object.values(run.validation.procs)[0];
    assert.equal(proc.state, 'recorded');
    livePgroups.add(proc);

    const c = await getCard(svc, 'card-a');
    const st = await cmd(svc, 'card-a', {
      commandId: `stop-${randomUUID().slice(0, 6)}`, type: 'stop',
      expectedControlRevision: c.json.controlRevision,
      payload: { reason: 'incident probe stop' },
    });
    assert.equal(st.status, 200, J(st.json));

    let after;
    try {
      after = await drive(svc, sched, runId, (r) => r.status === 'cancelled', { maxTicks: 120 });
    } catch (e) {
      await dumpForensics('cancel-drain-timeout');
      throw e;
    }
    assert.equal(after.validation.status, 'cancelled');
    let dead = false;
    try { process.kill(-proc.leader.pgid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
    assert.ok(dead, 'check process group is verifiably dead');
    livePgroups.delete(proc);
  } finally {
    if (proc) { await killRecordedGroup(proc); livePgroups.delete(proc); }
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// U5-0501 deterministic fault matrix — the incident signature is
//   run failed/verify, val failed/verify, ZERO procs with a recorded leader.
// Static analysis bounds the cause: complete_run cannot terminalize a run
// holding a live validation (validation_active guard), and a LANDED proc
// intent wedges 'unproven' forever (no spool/env proof to drain it) — so
// the observed 'failed' requires a non-outage fault BEFORE the proc-intent
// send (two-hop 'unproven'→drained→'failed') or a direct 'failed' end
// (wroot/pre-spawn realpath refusals). Each case below injects exactly one
// fault through the REAL internal command transport and asserts the exact
// incident signature plus the fingerprint that would have identified it in
// the original run (run.error / run.diagnostic / event tail / journal).
// ============================================================================

const U5051_OUT = process.env.U5051_CASE_DIR || '/tmp/acp-u5-0501-investigation/cases';
async function dumpU5051Case(name, env, runId, extra = {}) {
  const { svc } = env;
  const dir = join(U5051_OUT, name);
  await fs.mkdir(dir, { recursive: true });
  const run = await runView(svc, runId).catch((e) => ({ error: String(e) }));
  await fs.writeFile(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  let events = null;
  try {
    const ev = await req(svc, 'GET', `/api/execution/runs/${runId}/events`);
    events = ev.json?.events ?? ev.json ?? null;
  } catch (e) { events = { error: String(e) }; }
  await fs.writeFile(join(dir, 'events.json'), JSON.stringify(events, null, 2));
  // Raw journal/spool bytes — the complete durable evidence, never truncated.
  const envRoot = dirname(env.stateDir);
  const journal = {};
  for (const jf of (await fs.readdir(envRoot, { recursive: true }).catch(() => []))
    .filter((f) => f.endsWith('.jsonl'))) {
    journal[jf] = (await fs.readFile(join(envRoot, jf), 'utf8')).trim().split('\n');
  }
  await fs.writeFile(join(dir, 'journal.json'), JSON.stringify(journal, null, 2));
  // Validation tree as it actually stood at case end.
  const tree = [];
  const vroot = join(env.wsRoot, '.validation', runId);
  for (const f of (await fs.readdir(vroot, { recursive: true }).catch(() => []))) {
    const st = await fs.lstat(join(vroot, f)).catch(() => null);
    tree.push({ path: f, type: st?.isDirectory() ? 'dir' : st?.isSymbolicLink() ? 'link' : 'file', size: st?.size ?? null });
  }
  await fs.writeFile(join(dir, 'validation-tree.json'), JSON.stringify(tree, null, 2));
  await fs.writeFile(join(dir, 'summary.json'), JSON.stringify({
    name, runId, at: new Date().toISOString(),
    runStatus: run?.status ?? null, runPhase: run?.phase ?? null,
    runError: run?.error ?? null, runDiagnostic: run?.diagnostic ?? null,
    valStatus: run?.validation?.status ?? null, valPhase: run?.validation?.phase ?? null,
    procs: run?.validation?.procs ?? null,
    reports: run?.validation?.checks?.reports ?? null,
    ...extra,
  }, null, 2));
}

// The original run showed val=failed/VERIFY — record_snapshot is what flips
// val.phase 'prepare'→'verify', so the original fault MUST have landed in
// the post-snapshot → pre-intent window (copy materialization / copiesReady
// / pre-spawn gate / intent send). Inject one non-outage rejection at each
// boundary in that window: every one converges to THE incident signature.
for (const [name, match, label] of [
  ['copy-receipt', (b) => b?.type === 'validation_progress' && b.payload?.copy !== undefined, 'first copy receipt'],
  ['copies-ready', (b) => b?.type === 'validation_progress' && b.payload?.copiesReady === true, 'copiesReady'],
  ['proc-intent', (b) => b?.type === 'validation_progress' && b.payload?.proc?.state === 'intent', 'proc intent'],
]) {
  test(`U5-0501 mechanism: one non-outage rejection at ${label} → failed/verify`, async () => {
    const env = await mkEnv();
    const { svc, projectDir } = env;
    await seedBase(svc, projectDir);
    const runId = await mkValidationRun(svc, 'card-a', [{ run: 'sleep 60', timeoutSec: 90 }]);
    const sw = { reject: [{
      when: match, status: 422, code: `injected_${name}`,
      note: `injected transient rejection at ${label}`, times: 1,
    }] };
    const { sched } = mkSched(env, { sw });
    try {
      const run = await drive(svc, sched, runId, (r) => r.status === 'failed', { maxTicks: 120 });
      const val = run.validation || {};
      // THE incident signature — identical shape to the 0501 drive dump.
      assert.equal(run.phase, 'verify', J({ s: run.status, p: run.phase }));
      assert.equal(val.status, 'failed');
      assert.equal(val.phase, 'verify');
      assert.ok(!Object.values(val.procs || {}).some((p) => p?.leader?.pgid > 0),
        'incident shape: no proc ever carried a recorded leader');
      // The fingerprint that would have named the original cause — the
      // two-hop trail preserves the fault in diagnostic.detail, then drains.
      assert.equal(run.diagnostic?.type, 'validation_unproven',
        `diag=${J(run.diagnostic)}`);
      assert.match(run.diagnostic?.detail ?? '', /validation task faulted: injected transient rejection/);
      assert.equal(run.error, 'unproven reservation drained — evidence incomplete');
      assert.equal(sw.rejected.length, 1, 'the injected command was refused exactly once');
    } finally {
      await dumpU5051Case(name, env, runId, { rejected: sw.rejected }).catch(() => {});
      await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
    }
  });
}

// Falsified window: a non-outage fault BEFORE record_snapshot lands still
// converges run → failed/verify with zero procs, but the validation dies at
// 'prepare' — NOT the original signature (val was failed/verify). These
// cases prove the pre-snapshot window cannot be the original cause.
for (const [name, match, label] of [
  // The validation's commits carry payload.validationId (the implementer's
  // carry attemptId) — the manifest commit precedes record_snapshot.
  ['commit-artifact', (b) => b?.type === 'commit_artifact' && b.payload?.validationId, 'manifest artifact commit'],
  ['record-snapshot', (b) => b?.type === 'record_snapshot', 'record_snapshot'],
]) {
  test(`U5-0501 mechanism: pre-snapshot rejection at ${label} → failed/prepare (falsified)`, async () => {
    const env = await mkEnv();
    const { svc, projectDir } = env;
    await seedBase(svc, projectDir);
    const runId = await mkValidationRun(svc, 'card-a', [{ run: 'sleep 60', timeoutSec: 90 }]);
    const sw = { reject: [{
      when: match, status: 422, code: `injected_${name}`,
      note: `injected transient rejection at ${label}`, times: 1,
    }] };
    const { sched } = mkSched(env, { sw });
    try {
      const run = await drive(svc, sched, runId, (r) => r.status === 'failed', { maxTicks: 120 });
      const val = run.validation || {};
      assert.equal(run.phase, 'verify');
      assert.equal(val.status, 'failed');
      assert.equal(val.phase, 'prepare',
        'pre-snapshot fault cannot produce the failed/verify val signature');
      assert.ok(!Object.values(val.procs || {}).some((p) => p?.leader?.pgid > 0));
      assert.equal(run.diagnostic?.type, 'validation_unproven');
      assert.match(run.diagnostic?.detail ?? '', /validation task faulted: injected transient rejection/);
    } finally {
      await dumpU5051Case(name, env, runId, { rejected: sw.rejected }).catch(() => {});
      await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
    }
  });
}

// External CAS contention may exhaust a turn, but retains the exact duty
// for journal replay rather than failing a valid reservation.
test('U5 CAS contention retains and replays the original receipt without repeated checks', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo hit >> hits.txt', timeoutSec: 5 }]);
  const attempts = [];
  const sw = {};
  sw.reject = [{
    when: b => {
      if (b?.type !== 'validation_progress' || b.payload?.copiesReady !== true) return false;
      attempts.push(structuredClone(b));
      if (attempts.length === 9) sw.down = true;
      return true;
    },
    status: 409, code: 'revision_conflict', note: 'external CAS contention', times: 9,
  }];
  const { sched, instanceId } = mkSched(env, { sw });
  try {
    let run = await drive(svc, sched, runId, () => attempts.length === 9, { maxTicks: 160, delayMs: 20 });
    assert.equal(run.status, 'active'); assert.equal(run.validation.status, 'active');
    assert.equal(Object.keys(run.validation.procs || {}).length, 0, 'no check intent or process yet');
    let duty;
    for (let i = 0; i < 100 && !duty; i++) {
      const raw = await fs.readFile(sched._journalFile, 'utf8').catch(() => '');
      duty = raw.split('\n').filter(Boolean).map(JSON.parse).find(e => e.commandId === attempts[0].commandId);
      if (!duty) await sleep(10);
    }
    assert.ok(duty, 'original receipt duty persisted during contention');
    assert.equal(duty.type, attempts[0].type);
    assert.deepEqual(duty.payload, attempts[0].payload);
    for (const retry of attempts) {
      assert.equal(retry.commandId, duty.commandId);
      assert.deepEqual(retry.payload, duty.payload);
    }
    const unlanded = await loadAggregate(stateDir, 'card-a');
    assert.equal(unlanded.commands[`i:${duty.commandId}`], undefined, 'contention did not apply receipt');
    sw.down = false;
    run = await drive(svc, sched, runId, r => r.validation?.phase === 'review');
    assert.equal(run.status, 'active');
    const replayKey = `jr-${sha256(JSON.stringify({i: instanceId, s: duty.srcInstance ?? instanceId,
      c: duty.commandId, t: duty.type, p: duty.payload})).slice(0,40)}`;
    assert.ok((await loadAggregate(stateDir, 'card-a')).commands[`i:${replayKey}`], 'existing deterministic replay identity applied');
    const receipt = await mkClient(svc, stateDir).command('card-a', {
      commandId: `lookup-${randomUUID()}`, type: 'command_receipt',
      payload: {commandId: replayKey, type: duty.type, payload: duty.payload},
    });
    assert.equal(receipt.result.matched, true, 'replay applied the original exact payload');
    assert.equal(Object.keys(run.validation.procs).length, 1);
    assert.equal(Object.values(run.validation.procs)[0].state, 'settled');
    assert.equal(await fs.readFile(join(run.validation.dirs.verify, 'hits.txt'), 'utf8'), 'hit\n', 'approved check executes once');
  } finally { sw.down = false; await stopAndDrain(svc, sched, runId, 'card-a'); }
});

// Control: an OUTAGE-class failure at the identical boundary does NOT
// produce the signature — the duty is journaled, replayed, and the pipeline
// proceeds to a live recorded check. The fault CLASS is what kills the run.
test('U5-0501 mechanism: outage at copiesReady recovers (control)', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'sleep 60', timeoutSec: 90 }]);
  const sw = { reject: [{
    when: (b) => b?.type === 'validation_progress' && b.payload?.copiesReady === true,
    status: 503, code: 'injected_outage', note: 'injected one-shot outage', times: 1,
  }] };
  const { sched } = mkSched(env, { sw });
  let proc = null;
  try {
    const run = await drive(svc, sched, runId,
      (r) => r.validation?.phase === 'verify'
        && Object.values(r.validation?.procs || {}).some((p) => p?.leader?.pgid > 0),
      { maxTicks: 160 });
    proc = Object.values(run.validation.procs)[0];
    assert.equal(proc.state, 'recorded');
    livePgroups.add(proc);
    const c = await getCard(svc, 'card-a');
    await cmd(svc, 'card-a', {
      commandId: `stop-${randomUUID().slice(0, 6)}`, type: 'stop',
      expectedControlRevision: c.json.controlRevision, payload: { reason: 'control stop' },
    });
    const after = await drive(svc, sched, runId, (r) => r.status === 'cancelled', { maxTicks: 120 });
    assert.equal(after.validation.status, 'cancelled');
    let dead = false;
    try { process.kill(-proc.leader.pgid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
    assert.ok(dead, 'check process group is verifiably dead');
    livePgroups.delete(proc);
  } finally {
    await dumpU5051Case('outage-control', env, runId, { rejected: sw.rejected }).catch(() => {});
    if (proc) { await killRecordedGroup(proc); livePgroups.delete(proc); }
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// Direct-'failed' boundary: the pre-spawn gate refuses when verify/logs
// dirs do not resolve inside the real validation tree — one hop, no
// 'unproven' diagnostic; run.error names the refusal verbatim.
test('U5-0501 mechanism: planted logs-as-file → direct failed/verify', async () => {
  const env = await mkEnv();
  const { svc, projectDir, wsRoot } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'sleep 60', timeoutSec: 90 }]);
  // Round-1 validation id is deterministic: val_<runId>_1 — plant the logs
  // path as a REGULAR FILE before the scheduler starts.
  const valId = `val_${runId}_1`;
  const treeDir = join(wsRoot, '.validation', runId, valId);
  await fs.mkdir(treeDir, { recursive: true });
  await fs.writeFile(join(treeDir, 'logs'), 'planted-not-a-dir');
  const { sched } = mkSched(env);
  try {
    const run = await drive(svc, sched, runId, (r) => r.status === 'failed', { maxTicks: 120 });
    const val = run.validation || {};
    assert.equal(run.phase, 'verify');
    assert.equal(val.status, 'failed');
    assert.equal(val.phase, 'verify');
    assert.ok(!Object.values(val.procs || {}).some((p) => p?.leader?.pgid > 0));
    // Direct 'failed' fingerprint: the refusal reason verbatim, and NO
    // 'validation_unproven' diagnostic — the two-hop never ran.
    assert.match(run.error ?? '', /pre-spawn refused/);
    assert.notEqual(run.diagnostic?.type, 'validation_unproven');
  } finally {
    await dumpU5051Case('planted-logs-file', env, runId).catch(() => {});
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Domain barriers through the REAL authenticated internal path — each call
// carries a fresh expectedInternalRevision so the refusal observed is the
// ownership/evidence gate, not a revision rejection.
// ============================================================================

test('U5 domain barriers: ownership/immutability/evidence via internal client', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  // A gate-held check keeps the validation deterministically 'active'
  // through the probe window — a fixed sleep raced a terminal transition
  // once; the hold is released in finally, before the drain.
  const gate = join(stateDir, 'barrier-check-gate');
  const runId = await mkValidationRun(svc, 'card-a', [{
    run: `until [ -f '${gate}' ]; do sleep 0.1; done`, timeoutSec: 60,
  }]);
  const { sched, instanceId } = mkSched(env);
  try {
    await drive(svc, sched, runId, (r) => !!r.validation?.resultSha256);
    const run = await runView(svc, runId);
    const val = run.validation;
    assert.ok(val.resultSha256, 'snapshot must be recorded before barrier tests');

    const cli = mkClient(svc, stateDir);
    const freshRev = async () => (await getCard(svc, 'card-a')).json.internalRevision;
    // The live validation task heartbeats the card revision concurrently —
    // a revision_conflict is a CAS retry, not a barrier outcome. Replay the
    // SAME commandId+payload with a fresh revision, bounded; the observed
    // refusal must still be the intended gate, never just any 409.
    const cmdRetry = async (body, tries = 8) => {
      let res;
      for (let i = 0; i < tries; i += 1) {
        res = await cli.command('card-a', {
          ...body, expectedInternalRevision: await freshRev(),
        }).catch((e) => ({ status: e.status ?? 0, code: e.code, message: e.message }));
        if (res.code !== 'revision_conflict') return res;
      }
      return res;
    };

    // Wrong OWNER through the authenticated path: a foreign instanceId cannot
    // mutate the validation even with a valid revision — 409 ownership.
    const foreign = await cmdRetry({
      commandId: `ic-${randomUUID().slice(0, 8)}`, type: 'validation_progress',
      payload: {
        runId, validationId: val.id, copiesReady: true,
        runnerId: 'host-runner', instanceId: 'inst-OTHER',
        pid: 4242, pidStarttime: 'x',
        envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' },
        envInstance: { containerId: 'c', initStarttime: 't' },
      },
    });
    assert.equal(foreign.status, 409, J(foreign));
    assert.equal(foreign.code, 'not_validation_owner');

    // Snapshot immutability through the authenticated owner identity: a
    // second manifest for the same validation refuses.
    const tamper = await cmdRetry({
      commandId: `ic-${randomUUID().slice(0, 8)}`, type: 'record_snapshot',
      payload: {
        runId, validationId: val.id,
        manifest: {
          schema: 1, baseCommit: run.baseCommit, headCommit: run.baseCommit,
          entries: [], deleted: [], excluded: [], unsupported: [],
        },
        resultSha256: 'f'.repeat(64), manifestArtifactId: 'art_x',
        runnerId: 'host-runner', instanceId,
        pid: 99991, pidStarttime: 'x',
        envKey: { uid: myUid, gid: myGid, hostname: hostname(), bootId: 'fakeboot', pidNs: MY_PIDNS },
        envInstance: { containerId: hostname(), initStarttime: procStarttimeLocal(1) },
      },
    });
    assert.equal(tamper.status, 409, J(tamper));
    assert.equal(tamper.code, 'snapshot_immutable');
  } finally {
    await fs.writeFile(gate, 'x').catch(() => {}); // release the held check
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// command_receipt — the narrow READ-ONLY dedup receipt journal replay relies
// on. Strict contract: exact known type + full payload object REQUIRED (422
// otherwise), server-recomputed hash, storedResult only on an exact match,
// zero writes. Auth: internal token only — 401/403/user-channel-refused.
// ============================================================================

test('U5 command_receipt: strict contract through the authenticated queue', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  const cli = mkClient(svc, stateDir);
  const token = (await fs.readFile(join(stateDir, 'execution', 'internal-token'), 'utf-8')).trim();
  const internalCmd = (body, hdrs) => req(svc, 'POST', '/api/internal/cards/card-a/commands',
    body, hdrs === null ? {} : { 'x-acp-internal-token': hdrs ?? token });
  const receipt = (over) => internalCmd({
    commandId: `rc-${randomUUID().slice(0, 8)}`, type: 'command_receipt',
    payload: { commandId: 'hb-rcpt-1', type: 'heartbeat', payload: hbPayload, ...over },
  });

  // Land a real internal command so a genuine receipt exists to query.
  const hbPayload = {
    runnerId: 'host-runner', instanceId: 'inst-rcpt', leaseMs: 30000,
    pid: 4242, pidStarttime: 'st-4242',
    envKey: { uid: myUid, gid: myGid, hostname: hostname(), bootId: 'b', pidNs: MY_PIDNS },
    envInstance: { containerId: 'c', initStarttime: 't' },
  };
  const hb = await cli.command('card-a', {
    commandId: 'hb-rcpt-1', type: 'heartbeat',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: hbPayload,
  });
  assert.equal(hb.status ?? 200, 200, J(hb));

  // Full store state BEFORE any receipt lookup — the read-only claim is
  // verified across EVERY call below (auth probes included), not just the
  // last two.
  const blobDir = join(stateDir, 'execution', 'blobs');
  const blobInventory = async () => {
    const names = (await fs.readdir(blobDir).catch(() => [])).sort();
    const inv = {};
    for (const n of names) inv[n] = await fs.readFile(join(blobDir, n), 'utf-8');
    return inv;
  };
  const aggBefore = JSON.stringify(await loadAggregate(stateDir, 'card-a'));
  const blobsBefore = await blobInventory();

  // --- auth: the lookup exists only on the authenticated internal channel.
  const noAuth = await internalCmd({
    commandId: `rc-${randomUUID().slice(0, 8)}`, type: 'command_receipt',
    payload: { commandId: 'hb-rcpt-1', type: 'heartbeat', payload: hbPayload },
  }, null);
  assert.equal(noAuth.status, 401, J(noAuth.json));
  const badTok = await internalCmd({
    commandId: `rc-${randomUUID().slice(0, 8)}`, type: 'command_receipt',
    payload: { commandId: 'hb-rcpt-1', type: 'heartbeat', payload: hbPayload },
  }, 'definitely-wrong-token');
  assert.equal(badTok.status, 403, J(badTok.json));
  const userChan = await cmd(svc, 'card-a', {
    commandId: `rc-${randomUUID().slice(0, 8)}`, type: 'command_receipt',
    payload: { commandId: 'hb-rcpt-1', type: 'heartbeat', payload: hbPayload },
  });
  assert.equal(userChan.status, 400, 'user channel never reaches the receipt lookup');
  assert.equal(userChan.json.code, 'bad_command');

  // --- strict arguments: type AND payload object are required, no defaults.
  for (const [name, over, want] of [
    ['missing type', { type: undefined }, 422],
    ['unknown type', { type: 'not_a_command' }, 422],
    ['recursive target', { type: 'command_receipt' }, 422],
    ['missing payload', { payload: undefined }, 422],
    ['malformed payload', { payload: 'x' }, 422],
    ['missing commandId', { commandId: undefined }, 422],
  ]) {
    const r = await receipt(over);
    assert.equal(r.status, 422, `${name}: ${J(r.json)}`);
    assert.equal(r.json.code, 'invalid_argument', `${name}: ${J(r.json)}`);
  }

  // --- exact match → matched:true exposes the stored result.
  const exact = await receipt();
  assert.equal(exact.status, 200, J(exact.json));
  const ex = exact.json.result;
  assert.equal(ex.exists, true);
  assert.equal(ex.matched, true);
  assert.equal(ex.commandType, 'heartbeat');
  assert.ok(ex.storedResult && typeof ex.storedResult === 'object',
    'exact receipt exposes the stored result');

  // --- altered payload → matched:false, NO storedResult leak.
  const altered = await receipt({ payload: { ...hbPayload, leaseMs: 1 } });
  const al = altered.json.result;
  assert.equal(al.exists, true, 'commandId exists');
  assert.equal(al.matched, false, 'different payload hash never matches');
  assert.equal(al.storedResult, null, 'no stored result on a hash mismatch');

  // --- unknown commandId → exists:false.
  const absent = await receipt({ commandId: 'hb-never-sent' });
  assert.equal(absent.json.result.exists, false);
  assert.equal(absent.json.result.matched, false);

  // --- read-only: the ENTIRE persisted aggregate (revisions, commands map,
  // projections — everything) and the blob store inventory+contents are
  // byte-identical after every lookup above, auth failures included. A
  // receipt call registers no command entry of its own.
  const aggAfter = JSON.stringify(await loadAggregate(stateDir, 'card-a'));
  assert.equal(aggAfter, aggBefore,
    'receipt lookups (incl. 401/403/422) left the aggregate byte-identical');
  assert.deepEqual(await blobInventory(), blobsBefore,
    'receipt lookups wrote no blobs');
});

// ============================================================================
// Global=1 slot accounting: while card-a's validation is ACTIVE a second
// card's run cannot take a unit — no attempt recorded, no runtime launch.
// ============================================================================

test('U5 global slot: active validation blocks a second run (global=1)', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a'), cardFixture('card-b')]);
  await saveSchedulerLimits(stateDir, {
    global: 1, roles: { implementer: 1, reviewer: 1, checker: 1 },
  });
  // card-a holds the unit through a check gated on a file the test releases —
  // a wall-clock sleep raced the card-b drive window once (validation settled
  // before the second card probed the slot). Deterministic hold instead.
  const gateFile = join(stateDir, 'release-check-a');
  const runA = await mkValidationRun(svc, 'card-a', [{
    run: `until [ -f '${gateFile}' ]; do sleep 0.1; done; echo done`,
    timeoutSec: 60,
  }]);
  const { sched, runtime } = mkSched(env);
  const rA = await drive(svc, sched, runA,
    (r) => r.validation?.status === 'active' && r.validation.phase === 'verify');
  assert.equal(rA.validation.status, 'active');
  const rec = Object.values(rA.validation.procs || {})[0];
  if (rec) livePgroups.add(rec);
  try {
    // card-b's run is created AFTER the unit is held — its begin_attempt and
    // begin_validation must both refuse on the global limit.
    const runB = await mkValidationRun(svc, 'card-b', [{ run: 'echo b', timeoutSec: 30 }]);
    const startsBefore = runtime._calls.filter((c) => c.m === 'start').length;
    for (let i = 0; i < 6; i += 1) { await sched.tick(); await sleep(40); }
    const rB = await runView(svc, runB);
    assert.equal((rB.attempts || []).length, 0, 'no attempt may be recorded for card-b');
    assert.ok(!rB.validation, 'no validation may open for card-b');
    assert.equal(runtime._calls.filter((c) => c.m === 'start').length, startsBefore,
      'no runtime launch may be issued for card-b while the unit is held');
    const rA2 = await runView(svc, runA);
    assert.equal(rA2.validation?.status, 'active', 'card-a validation still owns the unit');
  } finally {
    // Release the hold first — the check then completes on its own and the
    // drain observes a settled proc instead of racing a kill.
    await fs.writeFile(gateFile, 'released').catch(() => {});
    await stopAndDrain(svc, sched, runA, 'card-a');
    if (rec) { await killRecordedGroup(rec); livePgroups.delete(rec); }
  }
});

// ============================================================================
// Runner quiesce (production driver.stop path): SIGTERM while the legacy
// pass is blocked and check-0's real process group is held on a gate file —
// the owned group is killed through the cancel path and PROVEN dead, the
// second check never spawns, no role attempt launches, and the validation
// reservation is RETAINED 'active' for successor adoption — never resolved
// by a dying runner.
// ============================================================================

test('U5 quiesce: runServe SIGTERM drains the owned check group, spawns nothing new', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a')]);
  const gate = join(stateDir, 'gate-a');
  const marker2 = join(stateDir, 'check2-ran');
  const runId = await mkValidationRun(svc, 'card-a', [
    { run: `until [ -f '${gate}' ]; do sleep 0.1; done; echo done`, timeoutSec: 60 },
    { run: `echo ran > '${marker2}'`, timeoutSec: 30 },
  ]);
  const { sched, runtime } = mkSched(env);
  // The REAL production driver — injected with the real scheduler+client so
  // d.stop() exercises quiesce → pump stop → bounded task drain.
  const driver = await createManagedDriver({
    enabled: true,
    env: { RUNNER_ID: 'host-runner' },
    stateDir,
    client: mkClient(svc, stateDir),
    runtime,
    scheduler: sched,
    tickMs: 60,
    // Match the injected scheduler's real gate — the startup evidence line
    // must agree with what the scheduler actually runs.
    validationEnabled: true,
  });
  let releasePass;
  const passGate = new Promise((res) => { releasePass = res; });
  let sigFn = null;
  const serve = runServe({
    driver,
    passOnceImpl: async () => { await passGate; return []; },
    registerSignals: (onSig) => { sigFn = onSig; return () => {}; },
    pollImpl: async () => 50,
  });
  let rec = null;
  try {
    // The production pump drives the run — poll until check-0's real group is
    // durably recorded (spawn already happened at that point). Inside try so
    // a missed recording still releases the legacy pass and stops the pump.
    for (let i = 0; i < 300 && !rec; i += 1) {
      const rv = await runView(svc, runId);
      for (const p of Object.values(rv.validation?.procs || {})) {
        if (p?.leader?.pgid) livePgroups.add(p);
      }
      const p0 = rv.validation?.procs?.['0'];
      if (p0?.state === 'recorded') rec = p0;
      if (!rec) await sleep(60);
    }
    assert.ok(rec?.leader?.pgid, 'check-0 group durably recorded before the signal');
    sigFn('SIGTERM'); // legacy pass still blocked — quiesce must not wait for it
    // The scheduler's own drain seam is the post-task barrier: after it, the
    // owned group is settled+reported (or honestly still pending).
    const dr = await sched.drain(20000);
    assert.equal(dr.pending, 0, `in-flight validation task must drain: ${J(dr)}`);
    const v = (await runView(svc, runId)).validation;
    const p0 = v?.procs?.['0'];
    assert.equal(p0?.state, 'settled', `check-0 must settle: ${J(v?.procs)}`);
    assert.equal(p0?.proof?.groupDead, true, 'positive group-death proof required');
    // Direct OS proof — no member of the recorded pgid survives.
    assert.deepEqual(procGroupMembers(p0.leader.pgid) || [], [],
      'recorded process group is verifiably empty');
    livePgroups.delete(rec);
    assert.equal(v.status, 'active',
      'reservation retained for successor adoption — a dying runner never resolves it');
    assert.equal(v.owner.instanceId, sched.instanceId, 'recorded owner unchanged');
    // Check-1 NEVER spawned: no proc, no report, no side-effect marker.
    assert.ok(!v.procs?.['1'], 'check-1 intent/spawn never issued');
    assert.equal((v.checks?.reports || []).length, 1, 'only the cancelled check reported');
    assert.equal(v.checks.reports[0].status, 'cancelled');
    await assert.rejects(fs.access(marker2), /ENOENT/, 'check-2 marker absent');
    // No reviewer/checker/fix attempt ever launched — implementer only.
    const starts = runtime._calls.filter((c) => c.m === 'start');
    assert.equal(starts.length, 1, `only the implementer launched: ${J(starts.map((s) => s.a?.profileId))}`);
    // Pump stopped + quiesced: real time passes, ZERO further launches.
    assert.equal(sched.quiesced(), true);
    await sleep(400);
    assert.equal(runtime._calls.filter((c) => c.m === 'start').length, 1,
      'no fresh launch after quiesce');
  } finally {
    await fs.writeFile(gate, 'x').catch(() => {});
    releasePass();
    await serve;
    if (rec) { await killRecordedGroup(rec); livePgroups.delete(rec); }
  }
});

// The same fence proven from the other side: quiesce landing BETWEEN the
// durable begin_attempt row and runtime.start must still never launch —
// the attempt reconciles through the never-entered contract.
test('U5 quiesce: fence between begin_attempt and runtime.start never launches', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok', timeoutSec: 30 }]);
  const box = {};
  const { sched, runtime } = mkSched(env, {
    hooks: {
      // Deterministic signal point: the durable attempt row exists, the
      // runtime has NOT been invoked — exactly the race window.
      onAttemptDurable: async () => { box.sched.quiesce(); },
    },
  });
  box.sched = sched;
  const r = await drive(svc, sched, runId, (x) => (x.attempts || []).length > 0);
  const att0 = r.attempts[0];
  assert.equal(r.attempts.length, 1, 'the durable attempt row exists');
  assert.match(att0.id, /^att-/, 'durable attempt id');
  assert.equal(att0.role, 'implementer', 'durable role binding');
  // The resolve lands through the never-entered reconcile — wait for the
  // terminal record, never on the transient 'active' snapshot.
  await drive(svc, sched, runId,
    (x) => !['active', 'queued', 'starting'].includes(x.attempts?.[0]?.status ?? 'active'));
  const r2 = await runView(svc, runId);
  const att1 = r2.attempts[0];
  assert.equal(runtime._calls.filter((c) => c.m === 'start').length, 0,
    'runtime.start NEVER invoked');
  assert.equal(att1.id, att0.id, 'same durable row reconciled');
  assert.equal(att1.status, 'failed',
    `never-entered attempt resolved 'failed' honestly: ${att1.status}`);
  assert.match(String(att1.error ?? ''), /never entered/i);
  // Post-quiesce ticks issue zero further work.
  const out = await sched.tick();
  assert.equal(runtime._calls.filter((c) => c.m === 'start').length, 0,
    `still zero launches: ${J(out)}`);
});

// ============================================================================
// Terminal-run reservation drain through the PUBLIC tick boundary: a role
// failure leaves run 'failed' with its validation still live — the unit is
// held until the scheduler drains it; a second card cannot take it first.
// ============================================================================

test('U5 terminal run + live validation holds the slot until drained', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  // card-b listed FIRST (lower order) so its run is evaluated before the
  // drain tick reaches card-a — the block must come from the reservation,
  // never from tick ordering.
  await seedBase(svc, projectDir, [
    cardFixture('card-b', { order: 5 }), cardFixture('card-a', { order: 10 }),
  ]);
  await saveSchedulerLimits(stateDir, {
    global: 1, roles: { implementer: 1, reviewer: 1, checker: 1 },
  });
  const runA = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok', timeoutSec: 30 }]);
  const { sched, runtime } = mkSched(env, {
    behaviors: { byProfile: { 'acp-reviewer': { outcome: 'failed', delayMs: 3 } } },
  });
  // Drive until the reviewer failure terminalizes the run while the
  // validation record is still live — the terminal+live window.
  let rA = null;
  for (let i = 0; i < 200; i += 1) {
    await sched.tick();
    rA = await runView(svc, runA);
    if (rA.status === 'failed' && ['active', 'unproven'].includes(rA.validation?.status)) break;
    await sleep(40);
  }
  assert.equal(rA.status, 'failed', J({ s: rA.status, v: rA.validation?.status }));
  assert.ok(['active', 'unproven'].includes(rA.validation?.status),
    `validation still holds the unit: ${rA.validation?.status}`);

  // The unit is held by a TERMINAL run — a fresh card-b begin_attempt
  // through the authenticated internal queue must hit limit_reached (the
  // global count includes run-a's live validation; no status shortcut).
  const runB = await mkValidationRun(svc, 'card-b', [{ run: 'echo b', timeoutSec: 30 }]);
  const cli = mkClient(svc, stateDir);
  const cardB = await getCard(svc, 'card-b');
  const blocked = await cli.command('card-b', {
    commandId: `probe-${randomUUID().slice(0, 8)}`, type: 'begin_attempt',
    expectedInternalRevision: cardB.json.internalRevision,
    payload: {
      runId: runB, attemptId: `att-probe-${randomUUID().slice(0, 8)}`,
      role: 'implementer', phase: 'implement', leaseMs: 1000,
      launch: {
        profileId: 'acp-implementer', cwd: '/tmp/x', attemptDir: '/tmp/y',
        artifactsDir: '/tmp/z', promptSha256: 'a'.repeat(64), configSha256: 'b'.repeat(64),
      },
      runnerId: 'host-runner', instanceId: 'inst-probe', pid: 1, pidStarttime: 'x',
      envKey: { uid: myUid, gid: myGid, hostname: 'h', bootId: 'b', pidNs: 'n' },
      envInstance: { containerId: 'c', initStarttime: 't' },
    },
  }).catch((e) => ({ status: e.status ?? 0, code: e.code, message: e.message }));
  assert.equal(blocked.status, 409, J(blocked));
  assert.equal(blocked.code, 'limit_reached',
    'terminal run + live validation must still hold the global unit');
  const rB1 = await runView(svc, runB);
  assert.equal((rB1.attempts || []).length, 0, 'no attempt recorded for card-b');
  assert.equal(
    runtime._calls.filter((c) => c.m === 'start' && String(c.attemptId || '').includes(runB)).length,
    0, 'no runtime launch may be issued for card-b while the unit is held');
  assert.equal(runtime._calls.filter((c) => c.m === 'start').length, 2,
    'only card-a work launched so far (implementer + failed reviewer)');

  // The drain reaches the terminal run through a plain sched.tick — the
  // public boundary — and releases the reservation once procs prove dead.
  await sched.tick();
  rA = await runView(svc, runA);
  assert.equal(rA.validation?.status, 'failed',
    `the terminal run's validation drained to 'failed': ${rA.validation?.status}`);

  // Unit released — card-b launches on the next ticks.
  const rB2 = await drive(svc, sched, runB,
    (r) => (r.attempts || []).length > 0, { maxTicks: 20 });
  assert.equal(rB2.attempts[0].role, 'implementer');
  await stopAndDrain(svc, sched, runB, 'card-b');
});

// ============================================================================
// Env-death proof binding: an adoption verified against environment A drains
// only records whose ORIGIN environment is A — a forged kind without adoption
// fails, an envB intent never reuses envA's proof, and never_spawned binds
// the intent's ORIGINAL owner (or a same-env adopter relaying its spool).
// ============================================================================

test('U5 env binding: origin-scoped adoption evidence + never_spawned ownership', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  // Two approved checks → proc indices 0 and 1 are both valid.
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo a' }, { run: 'echo b' }]);
  // The scheduler only reaches awaiting_validation — validation is driven
  // entirely by crafted identities through the real internal command path.
  const { sched } = mkSched(env, { validationEnabled: false });
  try {
    await drive(svc, sched, runId,
      (r) => r.phase === 'awaiting_validation' && r.status === 'active');

    const cli = mkClient(svc, stateDir);
    const freshRev = async () => (await getCard(svc, 'card-a')).json.internalRevision;
    const ic = () => `ic-${randomUUID().slice(0, 8)}`;
    const cmdRetry = async (body, tries = 8) => {
      let res;
      for (let i = 0; i < tries; i += 1) {
        res = await cli.command('card-a', {
          ...body, expectedInternalRevision: await freshRev(),
        }).catch((e) => ({ status: e.status ?? 0, code: e.code, message: e.message }));
        if (res.code !== 'revision_conflict') return res;
      }
      return res;
    };

    const envA = {
      runnerId: 'host-runner', instanceId: 'inst-A',
      pid: 717171, pidStarttime: 'stA',
      envKey: { uid: myUid, gid: myGid, hostname: 'hA', bootId: 'bootA', pidNs: 'nsA' },
      envInstance: { containerId: 'envA', initStarttime: 'tA' },
      envSlot: 'host-runner', envGeneration: 1,
    };
    const envB = {
      runnerId: 'host-runner', instanceId: 'inst-B',
      pid: 727272, pidStarttime: 'stB',
      envKey: { uid: myUid, gid: myGid, hostname: 'hB', bootId: 'bootB', pidNs: 'nsB' },
      envInstance: { containerId: 'envB', initStarttime: 'tB' },
      envSlot: 'host-runner', envGeneration: 1,
    };

    // envA registers in the environment ledger (a real registration entry
    // under slot host-runner) — retirement proof needs the exact binding.
    // The returned generation is whatever the ledger assigned (a prior
    // registration under the same slot makes it >1).
    let envDoc = await loadEnvironments(stateDir);
    let regA;
    ({ doc: envDoc, response: regA } = applyEnvCommand(envDoc, {
      commandId: 'ev-reg-a', type: 'register_environment',
      payload: {
        slot: 'host-runner', runnerId: 'host-runner', instanceId: 'inst-A',
        envInstance: envA.envInstance, envKey: envA.envKey,
        pid: envA.pid, pidStarttime: envA.pidStarttime,
      },
    }));
    await saveEnvironments(stateDir, envDoc);
    envA.envGeneration = regA?.result?.generation ?? 1;

    // begin_validation owned by envA.
    const bv = await cmdRetry({
      commandId: ic(), type: 'begin_validation',
      payload: { runId, validationId: 'val_env_1', leaseMs: 30_000, ...envA },
    });
    assert.equal(bv.ok, true, J(bv));
    assert.equal(bv.result?.status, 'active');

    // A leaderless intent recorded under envA (origin env bound).
    const i0 = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: { runId, validationId: 'val_env_1', proc: { index: 0, state: 'intent' }, ...envA },
    });
    assert.equal(i0.ok, true, J(i0));

    // Forged env_retired settle WITHOUT any adoption evidence → refused.
    const forged = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: {
        runId, validationId: 'val_env_1',
        proc: { index: 0, state: 'settled', proof: { kind: 'environment_retired' } },
        ...envA,
      },
    });
    assert.equal(forged.status, 409, J(forged));
    assert.equal(forged.code, 'proc_unproven', 'a bare kind without adoption evidence never drains');

    // Ops-verified retirement of envA's exact envInstance+generation.
    ({ doc: envDoc } = applyEnvCommand(envDoc, {
      commandId: 'ev-ret-a', type: 'retire_environment',
      payload: {
        slot: 'host-runner', by: 'ops-test',
        target: { envInstance: envA.envInstance, generation: envA.envGeneration },
        evidence: {
          source: 'compose_lifecycle', containerId: 'envA',
          state: 'removed', observedAt: Date.now(),
        },
      },
    }));
    await saveEnvironments(stateDir, envDoc);

    // envB adopts the validation via the verified retirement proof.
    const ad = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: {
        runId, validationId: 'val_env_1',
        adopt: true, proof: { kind: 'environment_retired' }, ...envB,
      },
    });
    assert.equal(ad.ok, true, J(ad));

    // envB must NOT drain envA's intent via never_spawned — the original
    // owner is instA and envB is not a same-env adopter relaying its spool.
    const ns = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: {
        runId, validationId: 'val_env_1',
        proc: { index: 0, state: 'settled', proof: { kind: 'never_spawned' } },
        ...envB,
      },
    });
    assert.equal(ns.status, 409, J(ns));
    assert.equal(ns.code, 'proc_unproven', 'never_spawned binds the original owner, not a later adopter');

    // envB CAN drain envA's intent via the adoption-bound env proof —
    // environment_retired evidence for envA settles records originating in A.
    const d0 = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: {
        runId, validationId: 'val_env_1',
        proc: { index: 0, state: 'settled', proof: { kind: 'environment_retired' } },
        ...envB,
      },
    });
    assert.equal(d0.ok, true, J(d0));

    // envB records a NEW intent (origin envB) — envA's retirement proof must
    // NOT drain it.
    const i1 = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: { runId, validationId: 'val_env_1', proc: { index: 1, state: 'intent' }, ...envB },
    });
    assert.equal(i1.ok, true, J(i1));
    const d1 = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: {
        runId, validationId: 'val_env_1',
        proc: { index: 1, state: 'settled', proof: { kind: 'environment_retired' } },
        ...envB,
      },
    });
    assert.equal(d1.status, 409, J(d1));
    assert.equal(d1.code, 'proc_unproven', 'envA proof never drains an envB-origin intent');

    // The original owner CAN attest never_spawned for its own intent.
    const d2 = await cmdRetry({
      commandId: ic(), type: 'validation_progress',
      payload: {
        runId, validationId: 'val_env_1',
        proc: { index: 1, state: 'settled', proof: { kind: 'never_spawned', via: 'precondition' } },
        ...envB,
      },
    });
    assert.equal(d2.ok, true, J(d2), 'the origin owner (instB) attests its own intent');

    // All procs settled → end_validation('failed') releases the reservation
    // AND terminalizes the run honestly.
    const end = await cmdRetry({
      commandId: ic(), type: 'end_validation',
      payload: { runId, validationId: 'val_env_1', outcome: 'failed', reason: 'test', ...envB },
    });
    assert.equal(end.ok, true, J(end));
    const run2 = await runView(svc, runId);
    assert.equal(run2.validation?.status, 'failed');
    assert.equal(run2.status, 'failed', 'a failed validation terminalizes the run honestly');
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Journal/replay: a durable validation mutation lost to an API outage is
// journaled with its ORIGINAL commandId+payload, then replayed under strict
// provenance — authoritative command_receipt dedup for landed originals,
// positive ownership/dead-owner adoption for unapplied ones. NEVER rerun.
// ============================================================================

test('U5 outage: dropped check-report response replays via receipt dedup — zero rerun', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  // applyDrop executes the command then loses the response; downAfterDrop
  // holds the API down so the journaled entry is observable before replay.
  const sw = { down: false, drop: new Set(), applyDrop: true, downAfterDrop: true, landed: [] };
  const { sched, instanceId } = mkSched(env, { sw });
  let runId = null;
  try {
    runId = await mkValidationRun(svc, 'card-a', [
      { run: 'echo a >> hits.txt' }, { run: 'echo b >> hits.txt' },
    ]);
    const valId = `val_${runId}_1`;
    sw.drop.add(`vp-${valId}-c1`);
    const jrnlPath = join(env.root, 'fake-exec', 'journal',
      `u4-journal-host-runner-${instanceId}.jsonl`);
    const readJournal = async () => (await fs.readFile(jrnlPath, 'utf8').catch(() => ''))
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } });

    // Phase 1: run until the dropped report's entry is on disk (API then
    // stays down — the entry persists durably for observation).
    let sawEntry = null;
    await drive(svc, sched, runId, async () => {
      sawEntry ??= (await readJournal())
        .find((x) => x?.kind === 'command' && x.commandId === `vp-${valId}-c1`) ?? null;
      return sawEntry !== null;
    }, { maxTicks: 160, delayMs: 60 });
    assert.ok(sawEntry, 'the dropped report was journaled as a command entry');
    assert.equal(sawEntry.type, 'validation_progress');
    assert.equal(sawEntry.srcInstance, instanceId, 'entry carries its source instance');
    assert.ok(sw.landed.includes(`vp-${valId}-c1`),
      'the original command DID apply server-side (2xx) — response loss only');
    assert.ok(!(sw.failed || []).some((f) => f.cid === `vp-${valId}-c1`),
      `the dropped command applied cleanly — got ${J(sw.failed || [])}`);
    assert.equal(sw.down, true, 'the outage is real: API stayed down after the drop');
    // While down, the journaled duty is NOT re-executed and the validation
    // simply waits — several real ticks under outage must launch NOTHING:
    // no second check process, no new proc records, no duplicated markers,
    // no end_validation — the evidence sits stable until restore.
    for (let i = 0; i < 4; i += 1) {
      await sched.tick();
      await sleep(80);
    }
    const midRun = await runView(svc, runId);
    const midVal = midRun.validation;
    assert.equal(midVal.status, 'active',
      'an outage never terminalizes the validation on its own');
    assert.equal((midVal.checks?.reports || [])
      .filter((r) => r.index === 1).length, 1,
      'the landed original is recorded exactly once — receipt, not re-execution');
    assert.deepEqual(
      (midVal.checks?.reports || []).map((r) => r.index).sort(), [0, 1],
      'no report lost, none duplicated under outage');
    assert.deepEqual(
      Object.keys(midVal.procs || {}).sort(), ['0', '1'],
      'no fresh intent/proc launch while the control plane is silent');
    const midHits = (await fs.readFile(
      join(midVal.dirs.verify, 'hits.txt'), 'utf8')).trim().split('\n').sort();
    assert.deepEqual(midHits, ['a', 'b'],
      'each check executed exactly once — outage spawned and replayed nothing');
    assert.ok((await readJournal()).some((e) => e?.kind === 'command'),
      'journaled duties stay retained while the API is down');

    // Phase 2: API returns — replay discharges via the authoritative
    // receipt, then the review gate stages docs like the golden path.
    sw.down = false;
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'),
      { maxTicks: 160, delayMs: 60 });
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      findings: [{ id: 'f1', round: run.validation.round, severity: 'major',
        text: 'a.js lacks a comment', where: 'src/a.js:1', status: 'open' }],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'),
      { maxTicks: 160, delayMs: 60 });
    await writeRoleDoc(run, 'checker', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      verdicts: [{ findingId: 'f1', verdict: 'rejected', reason: 'not a real issue' }],
    });
    run = await drive(svc, sched, runId,
      (r) => r.status === 'awaiting_acceptance',
      { maxTicks: 160, delayMs: 60 });
    const leftover = await fs.readFile(jrnlPath, 'utf8').catch(() => '');
    assert.equal(leftover.trim(), '', 'journal empty after replay');
    const reps = run.validation?.checks?.reports || [];
    assert.equal(reps.length, 2, `exactly two reports, replay deduped: ${J(reps.map((r) => r.index))}`);
    assert.equal(reps.filter((r) => r.index === 1).length, 1);
    for (const p of Object.values(run.validation?.procs || {})) {
      assert.equal(p.state, 'settled');
    }
    // Zero rerun: each check ran exactly once (marker lines in the copy).
    const hits = await fs.readFile(join(run.validation.dirs.verify, 'hits.txt'), 'utf8');
    assert.equal(hits.trim().split('\n').length, 2, 'each check executed exactly once');

    // The run is acceptable and accepts with the exact result hash.
    assert.equal(run.status, 'awaiting_acceptance');
    const c = await getCard(svc, 'card-a');
    const acc = await cmd(svc, 'card-a', {
      commandId: `acc-${randomUUID().slice(0, 6)}`, type: 'accept_result',
      expectedControlRevision: c.json.controlRevision,
      payload: { runId, resultSha256: run.acceptance.resultSha256 },
    });
    assert.equal(acc.status, 200, J(acc.json));
  } finally {
    sw.down = false;
    if (runId) await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Lease-cancel during outage + dead-owner restart: the running check group
// (a REAL bash process group) is killed at the AUTHORITATIVE server-recorded
// lease boundary; the spool survives; a new scheduler instance inherits the
// injected-dead predecessor's journal, adopts via positive process-death
// proof, replays the lost settle, and the verified spool supplies the
// report — the check is NEVER re-executed.
//
// Fixture honesty note: scheduler instance A is NOT a real Node process —
// `registry.procs.set(pidA, {exists:false})` injects its owner death into
// the fake runtime's process table so `adoptionProofFor`'s same-env
// process_dead check succeeds. Only the check process group is real.
// ============================================================================

test('U5 restart: lease-cancelled check + dead-owner journal replay — no rerun', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(),
    procs: new Map(), unreadable: new Map(), listFails: 0, seq: 0 };
  const sw = { down: false };
  const pidA = 91001;
  const a = mkSched(env, {
    registry, sw, instanceId: 'instA', instPid: pidA, leaseMs: 400,
  });
  const jrnlA = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instA.jsonl`);
  const jrnlB = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instB.jsonl`);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo run >> hits.txt; sleep 30' }]);
  try {
    // Drive until the check group is recorded and running.
    const run0 = await drive(svc, a.sched, runId,
      (r) => r.validation?.procs?.[0]?.state === 'recorded');
    const leader = run0.validation.procs[0].leader;
    assert.ok(leader?.pid > 0);

    // The AUTHORITATIVE boundary is the server-recorded owner.leaseUntil —
    // clampLeaseMs floors the requested 400ms to the 5000ms server minimum,
    // so this proves kill-at-recorded-lease, never kill-at-400ms.
    const agg0 = await loadAggregate(stateDir, 'card-a');
    const recVal = (agg0.runs || []).find((r) => r.id === runId)?.validation;
    const leaseUntil = recVal?.owner?.leaseUntil;
    assert.ok(Number.isFinite(leaseUntil), 'server recorded an authoritative leaseUntil');
    assert.ok(leaseUntil >= Date.now() + 4000,
      `clamped lease honoured (${leaseUntil} vs now ${Date.now()}) — never the requested 400ms`);

    // API dies. The recorded lease boundary expires → the scheduler kills
    // its own group, spools the result, and journals the settle send — all
    // without the control plane.
    sw.down = true;
    let jrnlEntries = [];
    let deadAt = null;
    for (let i = 0; i < 120; i += 1) {
      await sleep(150);
      jrnlEntries = await fs.readFile(jrnlA, 'utf8')
        .then((raw) => raw.split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }))
        .catch(() => []);
      const cur = procIdentityLocal(leader.pid);
      if (!(cur && cur.alive === true)) { deadAt = Date.now(); break; }
    }
    const deadNow = procIdentityLocal(leader.pid);
    assert.ok(!(deadNow && deadNow.alive === true),
      'the lease-expiry kill reaped the check leader during the outage');
    assert.ok(deadAt === null || deadAt >= leaseUntil,
      `kill respected the recorded lease boundary (dead at ${deadAt}, lease ${leaseUntil})`);
    for (let i = 0; i < 40 && !jrnlEntries.some((e) => e?.kind === 'command'); i += 1) {
      await sleep(150);
      jrnlEntries = await fs.readFile(jrnlA, 'utf8')
        .then((raw) => raw.split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }))
        .catch(() => []);
    }
    assert.ok(jrnlEntries.some((e) => e?.kind === 'command'
      && e.commandId === `vp-val_${runId}_1-p0-settled`),
      `the lost settle command was journaled: ${J(jrnlEntries)}`);

    // A's owner death is INJECTED into the fake runtime's process table
    // (same env, proven-dead pid — scheduler A is not a real Node process;
    // only the check group was real). B boots, inherits A's journal spool,
    // and replays it through real commands.
    registry.procs.set(pidA, { exists: false });
    sw.down = false;
    const b = mkSched(env, {
      registry, sw, instanceId: 'instB', instPid: 92001, leaseMs: 30_000,
    });
    const run1 = await drive(svc, b.sched, runId,
      (r) => ['settled', 'failed', 'cancelled'].includes(r.validation?.status)
        || r.status === 'awaiting_acceptance' || r.status === 'failed',
      { maxTicks: 160, delayMs: 80 });

    const val = run1.validation;
    // A's journal was drained and its spool file acknowledged (removed).
    const spoolGone = await fs.stat(jrnlA).then(() => false).catch(() => true);
    assert.ok(spoolGone, "dead predecessor's journal spool fully replayed and acknowledged");
    // Adoption evidence persisted: process_dead for the recorded envA owner.
    assert.ok((val.adoptions || []).some((x) => x.kind === 'process_dead'),
      'adoption by process_dead proof recorded durably');
    // The check proc settled via the replayed command — never re-executed.
    assert.equal(val.procs?.[0]?.state, 'settled');
    const hits = await fs.readFile(join(val.dirs.verify, 'hits.txt'), 'utf8');
    assert.equal(hits.trim().split('\n').length, 1, 'the killed check was never re-executed');
    // The report was recovered from the verified spool (status cancelled).
    const rep = (val.checks?.reports || []).find((r) => r.index === 0);
    assert.ok(rep, 'check report recovered from the verified spool');
    assert.equal(rep.status, 'cancelled');
    // No stray journaled residue under B either.
    const leftoverB = await fs.readFile(jrnlB, 'utf8').catch(() => '');
    assert.equal(leftoverB.trim(), '');
  } finally {
    await stopAndDrain(svc, a.sched, runId, 'card-a').catch(() => {});
    sw.down = false;
  }
});

// ============================================================================
// Bounded fix pipeline — a failed approved check gates to 'fix'; the fix
// attempt's prompt must carry the COMPLETE verified evidence: full check
// log bytes hydrated from the immutable artifact store (incl. raw non-UTF-8
// bytes), the verbatim findings/verdict docs, the recorded prior result.
// The fix commits a real canonical change → a NEW round with a different
// result hash re-runs the real checks → pass → acceptance.
// ============================================================================

test('U5 fix cycle: check-fail gate → verified-evidence fix → new round → accept', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  // The check emits a distinctive stdout line and INVALID UTF-8 stderr —
  // the durable raw-byte log must survive import, hydration, and render.
  const runId = await mkValidationRun(svc, 'card-a', [{
    run: "echo CHECKLOG-OUT-MARKER; printf '\\xff\\xfe\\x80' >&2; grep -q FIXED src/a.js",
  }]);
  // The fix attempt is deterministically att-<runId>-2 (checks fail → the
  // gate fires 'fix' before any role attempt exists). delayMs opens the
  // workspace-mutation window.
  const { sched, runtime } = mkSched(env, {
    behaviors: { byAttempt: { [`att-${runId}-2`]: { delayMs: 6000 } } },
  });
  try {
    // Round 1: the check fails → gate 'fix' → fixContext recorded.
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.phase === 'fix'),
      { maxTicks: 200, delayMs: 60 });
    const fixAtt = run.attempts.find((a) => a.phase === 'fix');
    assert.equal(fixAtt.role, 'implementer');
    const r1 = (run.rounds || []).find((r) => r.round === 1);
    assert.equal(r1.decision, 'fix', J(r1));
    assert.equal(r1.checksVerdict, 'fail');
    const fx = run.fixContext;
    assert.ok(fx?.resultSha256, 'fixContext carries the verified result hash');
    assert.match(fx.validationId, /^val_/, 'fixContext binds its producing validation');
    // Producer binding: priorResult is the IMPLEMENTER's recorded result,
    // never a role attempt's. In this check-fail round the implementer is
    // the only prior attempt, and the fix context must name it.
    const impl = run.attempts.find((a) => a.role === 'implementer' && a.phase === 'implement');
    assert.equal(fx.priorResult?.attemptId, impl.id,
      'priorResult names the implementer attempt that produced the result');

    // The fix prompt carries the FULL verified check log bytes — hydrated
    // from immutable artifacts, including the non-UTF-8 stderr.
    const call = runtime._calls.find((c) => c.m === 'start' && c.attemptId === fixAtt.id);
    assert.ok(call?.prompt, 'fix attempt prompt recorded');
    assert.match(call.prompt, /Fix context — verified gate evidence/);
    assert.match(call.prompt, /approved checks failed/);
    assert.ok(call.prompt.includes('CHECKLOG-OUT-MARKER'),
      'the prompt embeds the FULL hydrated stdout, not just a tail');
    assert.match(call.prompt, /verified artifact/, 'artifact provenance shown');
    assert.match(call.prompt, /result hash [0-9a-f]{64}/, 'verified result hash bound');

    // The fix performs a REAL canonical mutation while the attempt lives.
    const card = await getCard(svc, 'card-a');
    const wsEntry = Object.values(card.json.workspaces || {})
      .find((w) => w.runId === runId);
    assert.ok(wsEntry?.path, 'canonical workspace recorded');
    await fs.writeFile(join(wsEntry.path, 'src', 'a.js'),
      'export const a = 1; // FIXED\n', 'utf-8');
    git(wsEntry.path, 'add', '-A');
    git(wsEntry.path, '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '-qm', 'fix round 1 finding');

    // Round 2: new snapshot hash, the real check now passes, reviewer and
    // checker gate the round open.
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'),
      { maxTicks: 200, delayMs: 60 });
    assert.equal(run.validation.round, 2, 'fix produced a NEW validation round');
    assert.notEqual(run.validation.resultSha256, r1.resultSha256,
      'canonical mutation produced a DIFFERENT verified result hash');
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: 2, resultSha256: run.validation.resultSha256,
      findings: [],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'),
      { maxTicks: 200, delayMs: 60 });
    await writeRoleDoc(run, 'checker', {
      version: 1, round: 2, resultSha256: run.validation.resultSha256,
      verdicts: [],
    });
    run = await drive(svc, sched, runId, (r) => r.status === 'awaiting_acceptance',
      { maxTicks: 200, delayMs: 60 });
    assert.equal((run.rounds || []).length, 2);
    assert.equal(run.rounds[1].decision, 'awaiting_acceptance');
    // Artifact immutability across rounds: round 2 committed identically
    // NAMED logical files (check-0-stdout.log, result-manifest.json…) under
    // different artifact ids — the physical store name is bound to the id,
    // so every round-1 blob must still verify byte-for-byte.
    const cliArts = mkClient(svc, stateDir);
    const r1Arts = Object.values(run.artifacts || {})
      .filter((a) => a && a.validationId === fx.validationId);
    const r2Arts = Object.values(run.artifacts || {})
      .filter((a) => a && a.validationId === run.validation.id);
    assert.ok(r1Arts.length >= 2, `round-1 artifacts recorded (${r1Arts.length})`);
    assert.ok(r2Arts.length >= 1, `round-2 artifacts recorded (${r2Arts.length})`);
    assert.ok(r1Arts.some((a) => r2Arts.some((b) => b.file === a.file)),
      'the rounds share logical file names — the collision the binding prevents');
    for (const a of [...r1Arts, ...r2Arts]) {
      assert.equal(a.stored, a.id, `artifact ${a.id} stores under its own name`);
      const got = await cliArts.getArtifact(runId, a.id);
      const raw = Buffer.from(got.contentBase64 ?? '', 'base64');
      assert.equal(sha256(raw), a.sha256, `${a.file} (${a.id}) bytes intact`);
      assert.equal(raw.length, a.bytes);
    }
    // The raw stderr bytes provably hydrated: the recorded artifact's
    // sha256 is over the RAW bytes, and the fix prompt still rendered.
    const rep = (run.rounds[0] && (await runView(svc, runId))
      .rounds[0]);
    assert.equal(rep.checksVerdict, 'fail');
    const c = await getCard(svc, 'card-a');
    const acc = await cmd(svc, 'card-a', {
      commandId: `acc-${randomUUID().slice(0, 6)}`, type: 'accept_result',
      expectedControlRevision: c.json.controlRevision,
      payload: { runId, resultSha256: run.acceptance.resultSha256 },
    });
    assert.equal(acc.status, 200, J(acc.json));
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Budget honesty: with maxAttemptsPerRole=1 the initial implementer already
// spent the budget — the gate's 'fix' cannot launch. The run fails with the
// explicit budget reason; the limit is never silently ignored or reset.
// ============================================================================

test('U5 fix budget: maxAttemptsPerRole=1 honestly blocks the fix launch', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'exit 3' }], {
    id: `preset-${randomUUID().slice(0, 8)}`, name: 't',
    members: { implementer: { ...MEMBER }, reviewer: { ...MEMBER }, checker: { ...MEMBER } },
    limits: { maxAttemptsPerRole: 1, maxReviewRounds: 3 },
  });
  const { sched } = mkSched(env);
  try {
    const run = await drive(svc, sched, runId,
      (r) => ['failed', 'blocked', 'cancelled'].includes(r.status),
      { maxTicks: 240, delayMs: 60 });
    assert.equal(run.status, 'failed', J({ s: run.status, e: run.error }));
    assert.match(run.error ?? '', /budget exhausted|attempts/,
      'honest terminal reason — the fix could not launch within budget');
    assert.equal((run.attempts || []).filter((a) => a.role === 'implementer').length, 1,
      'exactly one implementer attempt consumed — the limit held');
    assert.ok(run.rounds?.[0]?.decision === 'fix',
      'the gate did decide fix — the BUDGET refused it');
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Round gate: a confirmed blocking finding at maxReviewRounds=1 is 'blocked'
// — the round gate itself fires (attempt budget was adequate to reach it).
// ============================================================================

test('U5 fix gate: confirmed blocking finding at maxReviewRounds → blocked', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok' }], {
    id: `preset-${randomUUID().slice(0, 8)}`, name: 't',
    members: { implementer: { ...MEMBER }, reviewer: { ...MEMBER }, checker: { ...MEMBER } },
    limits: { maxAttemptsPerRole: 4, maxReviewRounds: 1 },
  });
  const { sched } = mkSched(env);
  try {
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'),
      { maxTicks: 200, delayMs: 60 });
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: 1, resultSha256: run.validation.resultSha256,
      findings: [{ id: 'f1', round: 1, severity: 'major',
        text: 'confirmed defect', where: 'src/a.js:1', status: 'open' }],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'),
      { maxTicks: 200, delayMs: 60 });
    await writeRoleDoc(run, 'checker', {
      version: 1, round: 1, resultSha256: run.validation.resultSha256,
      verdicts: [{ findingId: 'f1', verdict: 'confirmed', reason: 'real defect' }],
    });
    run = await drive(svc, sched, runId,
      (r) => ['blocked', 'failed', 'cancelled'].includes(r.status),
      { maxTicks: 200, delayMs: 60 });
    assert.equal(run.status, 'blocked', J({ s: run.status, e: run.error }));
    assert.equal(run.rounds?.[0]?.decision, 'blocked');
    assert.match(run.rounds?.[0]?.reason ?? '', /round limit|maxRounds/i,
      'the ROUND gate blocked — adequate attempt budget reached it');
    assert.ok(!(run.attempts || []).some((a) => a.phase === 'fix'),
      'no fix attempt launched past the round limit');
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Producer binding through roles: checks PASS, a confirmed blocking finding
// fires the gate — fixContext.priorResult must be the IMPLEMENTER's recorded
// result (the attempt whose canonical change was validated), never the
// checker/reviewer result that overwrote run.result last. Distinguishable
// finalText per role proves it byte-for-byte in the fix prompt.
// ============================================================================

test('U5 fix producer: confirmed-finding fix binds the IMPLEMENTER result', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok' }]);
  // att-<runId>-2 is the reviewer, -3 the checker, -4 the fix implementer
  // (implement -1 → reviewer -2 → checker -3 → fix -4). The fix gets the
  // write window; roles get distinguishable finalText.
  const { sched, runtime } = mkSched(env, {
    behaviors: {
      byProfile: {
        'acp-implementer': { finalText: 'IMPL-FINAL-REPORT' },
        'acp-reviewer': { finalText: 'REV-FINAL-REPORT' },
        'acp-checker': { finalText: 'CHK-FINAL-REPORT' },
      },
      byAttempt: { [`att-${runId}-4`]: { delayMs: 6000 } },
    },
  });
  try {
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'),
      { maxTicks: 200, delayMs: 60 });
    const implAtt = run.attempts.find((a) => a.phase === 'implement');
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: 1, resultSha256: run.validation.resultSha256,
      findings: [{ id: 'f1', round: 1, severity: 'major',
        text: 'missing guard', where: 'src/a.js:1', status: 'open' }],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'),
      { maxTicks: 200, delayMs: 60 });
    const checkerAtt = run.attempts.find((a) => a.role === 'checker');
    await writeRoleDoc(run, 'checker', {
      version: 1, round: 1, resultSha256: run.validation.resultSha256,
      verdicts: [{ findingId: 'f1', verdict: 'confirmed', reason: 'real' }],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.phase === 'fix'),
      { maxTicks: 200, delayMs: 60 });
    const fx = run.fixContext;
    assert.ok(fx, 'confirmed blocking finding fired the fix gate');
    assert.equal(fx.priorResult?.attemptId, implAtt.id,
      'priorResult binds the IMPLEMENTER attempt — not the checker/reviewer');
    assert.notEqual(fx.priorResult?.attemptId, checkerAtt.id);
    assert.equal(fx.priorResult?.role, 'implementer');

    const fixAtt = run.attempts.find((a) => a.phase === 'fix');
    const call = runtime._calls.find((c) => c.m === 'start' && c.attemptId === fixAtt.id);
    assert.ok(call?.prompt.includes('IMPL-FINAL-REPORT'),
      'prompt hydrates the IMPLEMENTER final artifact verbatim');
    assert.ok(!call.prompt.includes('CHK-FINAL-REPORT'),
      'checker final never masquerades as the prior result');
    assert.ok(!call.prompt.includes('REV-FINAL-REPORT'));
    assert.ok(call.prompt.includes('f1') && call.prompt.includes('missing guard'),
      'the verified finding text reaches the fix prompt');
    assert.ok(call.prompt.includes('confirmed'),
      'the verbatim verdicts doc reaches the fix prompt');

    // Complete the fix honestly: canonical mutation → new round → pass.
    const card = await getCard(svc, 'card-a');
    const wsEntry = Object.values(card.json.workspaces || {})
      .find((w) => w.runId === runId);
    await fs.writeFile(join(wsEntry.path, 'src', 'a.js'),
      'export const a = 1; // guarded\n', 'utf-8');
    git(wsEntry.path, 'add', '-A');
    git(wsEntry.path, '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '-qm', 'fix f1');
    // Round-2 role attempts bind THEIR validation id — the accumulated
    // round-1 attempts must not satisfy the wait.
    run = await drive(svc, sched, runId,
      (r) => r.validation?.round === 2
        && (r.attempts || []).some((a) => a.role === 'reviewer'
          && a.validationId === r.validation.id),
      { maxTicks: 200, delayMs: 60 });
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: 2, resultSha256: run.validation.resultSha256,
      findings: [],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'
        && a.validationId === r.validation.id),
      { maxTicks: 200, delayMs: 60 });
    await writeRoleDoc(run, 'checker', {
      version: 1, round: 2, resultSha256: run.validation.resultSha256,
      verdicts: [],
    });
    run = await drive(svc, sched, runId, (r) => r.status === 'awaiting_acceptance',
      { maxTicks: 200, delayMs: 60 });
    assert.equal((run.attempts || []).filter((a) => a.phase === 'fix').length, 1,
      'exactly ONE fix attempt — a completed fix is consumed, never duplicated');
    assert.equal((run.rounds || []).length, 2);
    assert.equal(run.rounds[0].decision, 'fix');
    assert.equal(run.rounds[1].decision, 'awaiting_acceptance');
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Stop during role phases: a stop while a ROLE attempt is live cancels it
// and the whole run — no checker attempt ever launches, no new round opens.
// ============================================================================

test('U5 stop during reviewer: run cancels, no checker, no next round', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok' }]);
  // Keep the reviewer alive long enough to observe the stop mid-flight.
  const { sched } = mkSched(env, {
    behaviors: { byProfile: { 'acp-reviewer': { delayMs: 8000 } } },
  });
  try {
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'
        && !['completed', 'failed', 'cancelled'].includes(a.status)),
      { maxTicks: 200, delayMs: 60 });
    run = await stopAndDrain(svc, sched, runId, 'card-a');
    assert.equal(run.status, 'cancelled', J({ s: run.status, e: run.error }));
    assert.ok(!(run.attempts || []).some((a) => a.role === 'checker'),
      'checker never launched after the stopped reviewer');
    assert.equal((run.rounds || []).length, 0,
      'the gate never ran — no round evidence fabricated on cancellation');
    const rev = run.attempts.find((a) => a.role === 'reviewer');
    assert.ok(['cancelled', 'interrupted'].includes(rev?.status ?? 'cancelled'),
      `the live reviewer was actually cancelled — got ${rev?.status}`);
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

test('U5 stop during fix attempt: run cancels, no new validation round', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'exit 9' }]);
  // att-…-2 is the fix attempt (check-fail gate skips roles) — keep it live.
  const { sched } = mkSched(env, {
    behaviors: { byAttempt: { [`att-${runId}-2`]: { delayMs: 9000 } } },
  });
  try {
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.phase === 'fix'
        && !['completed', 'failed', 'cancelled'].includes(a.status)),
      { maxTicks: 200, delayMs: 60 });
    assert.ok(run.fixContext, 'fixContext was recorded before the stop');
    run = await stopAndDrain(svc, sched, runId, 'card-a');
    assert.equal(run.status, 'cancelled', J({ s: run.status, e: run.error }));
    // The cancelled fix never produced a round-2 validation.
    assert.ok(!(run.rounds || []).some((r) => r.round === 2),
      'a cancelled fix attempt never opens a new round');
    const fixAtt = run.attempts.find((a) => a.phase === 'fix');
    assert.ok(['cancelled', 'interrupted'].includes(fixAtt?.status ?? 'cancelled'),
      `the live fix attempt was actually cancelled — got ${fixAtt?.status}`);
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Stop during the CHECKER role — the confirmed-blocking verdict path is
// never reached; no fixContext, no new round, no acceptance.
// ============================================================================

test('U5 stop during checker: run cancels before verdicts — no fix, no round', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok' }]);
  const { sched } = mkSched(env, {
    behaviors: { byProfile: { 'acp-checker': { delayMs: 8000 } } },
  });
  try {
    let run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'reviewer'),
      { maxTicks: 200, delayMs: 60 });
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: 1, resultSha256: run.validation.resultSha256,
      findings: [{ id: 'f1', round: 1, severity: 'major',
        text: 'would block', where: 'src/a.js:1', status: 'open' }],
    });
    run = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.role === 'checker'
        && !['completed', 'failed', 'cancelled'].includes(a.status)),
      { maxTicks: 200, delayMs: 60 });
    // Stop while the checker attempt is live — a would-be blocking verdict
    // can never materialize into a fixContext or a new round.
    run = await stopAndDrain(svc, sched, runId, 'card-a');
    assert.equal(run.status, 'cancelled', J({ s: run.status, e: run.error }));
    const chk = run.attempts.find((a) => a.role === 'checker');
    assert.ok(['cancelled', 'interrupted'].includes(chk?.status ?? 'cancelled'),
      `the live checker was actually cancelled — got ${chk?.status}`);
    assert.equal(run.fixContext ?? null, null, 'no fixContext fabricated');
    assert.equal((run.rounds || []).length, 0, 'the gate never ran');
    assert.notEqual(run.status, 'awaiting_acceptance');
  } finally {
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Inside-root alias: a symlink under .validation pointing at ANOTHER real
// dir inside the same wsRoot is refused before ANY mutation — the alias
// target stays byte-identical and the validation is unproven, never wiped.
// ============================================================================

test('U5 containment: inside-wsRoot symlink alias refused with zero writes', async () => {
    const env = await mkEnv();
    const { svc, projectDir, wsRoot } = env;
    await seedBase(svc, projectDir);
    const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo ok' }]);
    const valId = `val_${runId}_1`;
    const { sched } = mkSched(env);
    try {
      // Pre-plant the alias BEFORE copies materialize: a symlink at the
      // 'check' copy path pointing at another real dir inside wsRoot.
      const valTree = join(wsRoot, '.validation', runId, valId);
      await fs.mkdir(valTree, { recursive: true });
      const aliasTarget = join(wsRoot, 'other-owned-dir');
      await fs.mkdir(join(aliasTarget, 'precious'), { recursive: true });
      await fs.writeFile(join(aliasTarget, 'precious', 'keep.txt'), 'do not touch\n');
      const targetBefore = await fs.readFile(join(aliasTarget, 'precious', 'keep.txt'), 'utf-8');
      await fs.symlink(aliasTarget, join(valTree, 'check'));

      const run = await drive(svc, sched, runId,
        (r) => r.validation && ['unproven', 'failed', 'settled'].includes(r.validation.status)
          ? true
          : ['failed', 'blocked', 'cancelled', 'awaiting_acceptance'].includes(r.status),
        { maxTicks: 240, delayMs: 60 });
      const val = run.validation;
      // The refusal is the durable evidence: end_validation('unproven')
      // records the diagnostic; the reservation may later drain to failed
      // — either way the recorded reason proves the non-real component
      // was refused, never wiped.
      const diag = run.diagnostic;
      assert.equal(diag?.type, 'validation_unproven',
        `the alias was refused as an unproven reservation — got ${J({ v: val?.status, d: diag })}`);
      assert.match(diag?.detail ?? '', /non-real component/i,
        'the recorded reason names the non-real component');
      // Zero mutation: the alias still exists (never unlinked), the target
      // byte-identical (never touched through the alias).
      const lst = await fs.lstat(join(valTree, 'check'));
      assert.ok(lst.isSymbolicLink(), 'the refused alias was never removed');
      assert.equal(await fs.readFile(join(aliasTarget, 'precious', 'keep.txt'), 'utf-8'),
        targetBefore, 'the aliased dir stayed byte-identical — zero writes through it');
    } finally {
      await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
    }
});

// ============================================================================
// Fix-evidence fail-closed matrix — hydration refuses BEFORE begin_attempt:
//   missing artifact file        → terminal diagnose + complete_run failed
//   corrupt stored bytes         → same
//   record lacking recorded sha  → same
//   API outage mid-hydration     → RETAIN, no launch, no terminal mark; on
//                                  restore the fix proceeds.
// ============================================================================

test('U5 fix evidence: missing/corrupt/unbound artifact refuses pre-launch', async () => {
  for (const mode of ['missing', 'corrupt', 'unbound']) {
    const env = await mkEnv();
    const { svc, projectDir, stateDir } = env;
    await seedBase(svc, projectDir);
    const sw = { dropGet: true }; // artifact-plane barrier from the start:
    // every hydrate read hits the injected fault — the fix can NEVER launch
    // before the tamper lands. Commands/reads elsewhere still work.
    const runId = await mkValidationRun(svc, 'card-a', [{ run: 'exit 3' }]);
    const { sched } = mkSched(env, { sw });
    try {
      const run = await drive(svc, sched, runId, (r) => r.fixContext != null,
        { maxTicks: 240, delayMs: 60 });
      assert.ok(run.fixContext, 'the gate fired fix');
      assert.ok(!(run.attempts || []).some((a) => a.phase === 'fix'),
        `${mode}: no fix attempt exists BEFORE the tamper`);
      const artId = run.fixContext.checkReports?.[0]?.logOutArtifactId;
      assert.ok(artId, 'check log artifact recorded');
      const agg = await loadAggregate(stateDir, 'card-a');
      const runRec = (agg.runs || []).find((r) => r.id === runId);
      const artRec = runRec.artifacts[artId];
      assert.ok(artRec?.file && artRec.sha256 && artRec.stored,
        `${mode}: recorded evidence present (logical file + physical stored + hash)`);
      // `stored` is the commit-bound physical name; `file` is logical
      // metadata that repeats across rounds — tamper the REAL bytes.
      const artPath = join(stateDir, 'execution', 'state', 'artifacts',
        runId, artRec.stored ?? artRec.file);
      const before = await fs.readFile(artPath); // throws if absent — the
      assert.equal(sha256(before), artRec.sha256, // artifact must be REAL
        `${mode}: pre-tamper bytes match the recorded hash`);
      if (mode === 'missing') {
        await fs.rm(artPath);
        await assert.rejects(fs.access(artPath), /ENOENT/, `${mode}: the file is truly gone`);
      } else if (mode === 'corrupt') {
        await fs.writeFile(artPath, 'TAMPERED-BYTES\n', 'utf-8');
        assert.notEqual(sha256(await fs.readFile(artPath)), artRec.sha256,
          `${mode}: on-disk bytes genuinely differ from the recorded hash`);
      } else {
        // 'unbound': the canonical run FILE (loadRun — what the scheduler's
        // run view reads) is the record hydrate trusts; keep the embedded
        // aggregate copy consistent too.
        const runFile = await loadRun(stateDir, runId);
        assert.ok(runFile?.artifacts?.[artId]?.sha256, `${mode}: run-file record present`);
        runFile.artifacts[artId].sha256 = null;
        await saveRun(stateDir, runFile);
        artRec.sha256 = null;
        await saveAggregate(stateDir, agg);
        const recheck = await loadRun(stateDir, runId);
        assert.equal(recheck.artifacts[artId].sha256, null,
          `${mode}: the canonical record now lacks a recorded hash`);
        // The authoritative artifact route fails closed on the unverifiable
        // record BEFORE the barrier lifts (direct service read is ungated).
        const probe = await req(svc, 'GET', `/api/execution/runs/${runId}/artifacts/${artId}`);
        assert.equal(probe.status, 422, `${mode}: unbound record refused: ${J(probe.json)}`);
        assert.equal(probe.json?.code, 'artifact_evidence_unbound');
      }
      sw.dropGet = false; // lift the barrier — hydration reads the faulted evidence
      const fin = await drive(svc, sched, runId,
        (r) => ['failed', 'blocked', 'cancelled'].includes(r.status),
        { maxTicks: 200, delayMs: 60 });
      assert.equal(fin.status, 'failed', `${mode}: ${J({ s: fin.status, e: fin.error })}`);
      assert.match(fin.error ?? '', /fix evidence unavailable/i,
        `${mode}: honest terminal diagnostic`);
      assert.ok(!(fin.attempts || []).some((a) => a.phase === 'fix'),
        `${mode}: no fix attempt launched without verified evidence`);
      const ev = await req(svc, 'GET', `/api/execution/runs/${runId}/events`);
      assert.ok((ev.json?.events || ev.json || [])
        .some((e) => e.type === 'fix_evidence_unavailable'),
        `${mode}: durable diagnostic event recorded`);
    } finally {
      sw.dropGet = false;
      await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
    }
  }
});

test('U5 fix evidence: API outage mid-hydration retains — no launch, no terminal', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  // Artifact-plane outage ONLY — the gate, fixContext and journal commands
  // still land; hydration's artifact reads hit the injected fault.
  const sw = { dropGet: true };
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'exit 3' }]);
  const { sched } = mkSched(env, { sw });
  try {
    const run = await drive(svc, sched, runId, (r) => r.fixContext != null,
      { maxTicks: 240, delayMs: 60 });
    assert.ok(run.fixContext, 'the gate fired fix — commands still land');
    // Several more ticks under the artifact-plane outage: hydration keeps
    // hitting the fault — retained, never terminal, no fix attempt.
    for (let i = 0; i < 6; i += 1) { await sched.tick(); await sleep(60); }
    const mid = await runView(svc, runId);
    assert.ok((sw.getTries || []).length > 0,
      'the injected fault was actually hit — hydration attempted real artifact reads');
    assert.equal(mid.status, 'active', 'outage never terminalizes mid-fix');
    assert.ok(mid.fixContext, 'fixContext retained through the outage');
    assert.ok(!(mid.attempts || []).some((a) => a.phase === 'fix'),
      'no fix attempt launched while the artifact plane was down');
    // Restore — hydration succeeds and the fix attempt launches.
    sw.dropGet = false;
    const fin = await drive(svc, sched, runId,
      (r) => (r.attempts || []).some((a) => a.phase === 'fix'),
      { maxTicks: 200, delayMs: 60 });
    assert.ok(fin.attempts.some((a) => a.phase === 'fix'),
      'the fix attempt launched after the API returned');
  } finally {
    sw.dropGet = false;
    await stopAndDrain(svc, sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Same-environment ownership: a LIVE foreign owner retains its validation
// reservation — the second instance issues no work, adopts nothing, replays
// no journal. Only a POSITIVE death proof (process_dead on the recorded pid)
// releases it; the adopter then inherits the journal and finishes the run
// with zero check re-execution.
// ============================================================================

test('U5 recovery: live foreign owner retained — adopted only after positive death', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(),
    procs: new Map(), unreadable: new Map(), listFails: 0, seq: 0 };
  const pidA = 93001;
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo hit >> hits.txt' }]);
  const valId = `val_${runId}_1`;
  const jrnlA = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instA.jsonl`);
  const sw = { down: false, drop: new Set([`vp-${valId}-c0`]), downOnDrop: true };
  const a = mkSched(env, { registry, sw, instanceId: 'instA', instPid: pidA, leaseMs: 30_000 });
  let b = null;
  const jrnlHas = async (cid) => (await fs.readFile(jrnlA, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).some((l) => {
      try { return JSON.parse(l)?.commandId === cid; } catch { return false; }
    });
  try {
    // A runs the check, spools the result, settles the proc record — then
    // the report send is dropped and the WHOLE api freezes the instant it
    // is attempted: no rebound-key replay can ever land the duty while we
    // inspect the unapplied state.
    let run = await drive(svc, a.sched, runId,
      (r) => r.validation?.procs?.[0]?.state === 'settled', { maxTicks: 200, delayMs: 60 });
    const leader0 = run.validation.procs[0].leader;
    for (let i = 0; i < 60 && !(await jrnlHas(`vp-${valId}-c0`)); i += 1) {
      await a.sched.tick();
      await sleep(40);
    }
    for (let i = 0; i < 5; i += 1) { await a.sched.tick(); await sleep(50); }
    assert.ok(await jrnlHas(`vp-${valId}-c0`), 'the dropped report was journaled, not applied');
    let mid = await runView(svc, runId);
    assert.equal((mid.validation.checks?.reports || []).length, 0,
      'no report recorded — outage holds the replay back');
    // Authoritative absence: NO command in the aggregate applied a c0
    // check report — neither the original id nor any rebound key. Stored
    // body is {ok, result:{runId, validationId, recorded:'check[0]→*'}}.
    const agg0 = await loadAggregate(stateDir, 'card-a');
    const appliedReports = Object.values(agg0.commands || {}).filter((c) => c
      && c.type === 'validation_progress' && c.body?.result?.runId === runId
      && c.body?.result?.validationId === valId
      && typeof c.body?.result?.recorded === 'string'
      && c.body.result.recorded.startsWith('check[0]→'));
    assert.equal(appliedReports.length, 0,
      `zero applied check-0 reports under any key: ${J(Object.keys(agg0.commands || {}))}`);
    assert.equal(mid.status, 'active');

    // B boots in the SAME environment with a HEALTHY transport while A is
    // still LIVE and A's own transport stays dead — retention must come
    // from the ownership record, not from B merely being unreachable.
    const swB = { down: false };
    b = mkSched(env, { registry, sw: swB, instanceId: 'instB', instPid: 93002, leaseMs: 30_000 });
    for (let i = 0; i < 8; i += 1) { await b.sched.tick(); await sleep(50); }
    assert.ok((swB.gets || 0) > 0,
      'B actually READ the api — retention observed under a live transport');
    mid = await runView(svc, runId);
    assert.equal(mid.validation?.owner?.instanceId, 'instA',
      'a live foreign owner keeps its reservation — never adopted on a whim');
    assert.equal((mid.validation?.adoptions || []).length, 0, 'no adoption record fabricated');
    assert.equal((mid.validation?.checks?.reports || []).length, 0,
      'B replayed nothing while the owner was live');
    const hitsLive = await fs.readFile(
      join(mid.validation.dirs.verify, 'hits.txt'), 'utf8');
    assert.equal(hitsLive.trim().split('\n').filter(Boolean).length, 1,
      'B never re-executed the check under a live foreign owner');

    // Positive death proof: A's recorded pid is proven gone. B adopts and
    // recovers the lost report from the VERIFIED spool — the check is
    // never re-executed. (A's transport stays dead; it is never ticked.)
    registry.procs.set(pidA, { exists: false });
    try {
      run = await drive(svc, b.sched, runId,
        (r) => (r.attempts || []).some((x) => x.role === 'reviewer'),
        { maxTicks: 200, delayMs: 60 });
    } catch (e) {
      const dbg = await runView(svc, runId);
      const evs = await req(svc, 'GET', `/api/execution/runs/${runId}/events`)
        .then((r) => r.json?.events || r.json || []).catch(() => []);
      console.log('DBG', J({
        err: dbg.error, diag: dbg.diagnostic,
        val: { status: dbg.validation?.status, phase: dbg.validation?.phase,
          procs: dbg.validation?.procs, reports: dbg.validation?.checks?.reports,
          adoptions: dbg.validation?.adoptions },
        events: (Array.isArray(evs) ? evs : []).map((x) => x.type),
      }));
      throw e;
    }
    const adopted = run.validation?.adoptions || [];
    assert.ok(adopted.some((x) => x.kind === 'process_dead'),
      'adoption recorded under a positive process_dead proof');
    assert.equal(run.validation?.owner?.instanceId, 'instB');
    const reps = run.validation?.checks?.reports || [];
    assert.equal(reps.filter((r) => r.index === 0).length, 1, 'exactly one report for check 0');
    assert.equal(run.validation?.procs?.[0]?.leader?.pid, leader0.pid,
      'the original recorded leader identity is unchanged — zero rerun');
    const hits = await fs.readFile(join(run.validation.dirs.verify, 'hits.txt'), 'utf8');
    assert.equal(hits.trim().split('\n').filter(Boolean).length, 1,
      'the check ran exactly once across the handoff');
    // Gate through to acceptance-ready with staged role docs.
    await writeRoleDoc(run, 'reviewer', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      findings: [],
    });
    run = await drive(svc, b.sched, runId,
      (r) => (r.attempts || []).some((x) => x.role === 'checker'),
      { maxTicks: 160, delayMs: 60 });
    await writeRoleDoc(run, 'checker', {
      version: 1, round: run.validation.round, resultSha256: run.validation.resultSha256,
      verdicts: [],
    });
    run = await drive(svc, b.sched, runId,
      (r) => r.status === 'awaiting_acceptance', { maxTicks: 160, delayMs: 60 });
    assert.equal(run.status, 'awaiting_acceptance');
    const spoolGone = await fs.stat(jrnlA).then(() => false).catch(() => true);
    if (!spoolGone) {
      // Dump BEFORE cleanup: exact retained entries, the recorded report,
      // the replay receipts, and the retain diagnostics — an empty file
      // and a pending duty are different contracts.
      const raw = await fs.readFile(jrnlA, 'utf8');
      const evs = await req(svc, 'GET', `/api/execution/runs/${runId}/events`)
        .then((r) => r.json?.events || []).catch(() => []);
      const aggDump = await loadAggregate(stateDir, 'card-a');
      console.log('JRN-DUMP', J({
        entries: raw.split('\n').filter(Boolean).map((l) => {
          const p = JSON.parse(l);
          return { commandId: p.commandId, type: p.type, kind: p.kind,
            diag: p.diagnosisEvent ?? null };
        }),
        reports: run.validation?.checks?.reports,
        retains: evs.filter((e) => e.type === 'journal_retain')
          .map((e) => e.data),
        jrReceipts: Object.keys(aggDump.commands || {})
          .filter((k) => k.startsWith('jr-') || k.startsWith('vadopt-')),
      }));
    }
    assert.ok(spoolGone, "dead predecessor's journal fully replayed and acknowledged");
  } finally {
    registry.procs.set(pidA, { exists: false });
    sw.down = false; sw.drop?.clear?.();
    await stopAndDrain(svc, a.sched, runId, 'card-a').catch(() => {});
    if (b) await stopAndDrain(svc, b.sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// record_event authority after a real adoption: the CURRENT validation owner
// writes run-level events even though the run's last attempt belonged to the
// dead predecessor; an unrelated instance is refused; an attempt-scoped
// event still requires the exact attempt owner — never the adopter.
// ============================================================================

test('U5 event authority: adopted validation owner writes run-level; attempt events stay exact-owner', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(),
    procs: new Map(), unreadable: new Map(), listFails: 0, seq: 0 };
  const pidA = 93001;
  // A long check keeps the validation genuinely active through the probe.
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'sleep 30', timeoutSec: 60 }]);
  const a = mkSched(env, { registry, instanceId: 'instA', instPid: pidA, leaseMs: 30_000 });
  let b = null;
  try {
    let run = await drive(svc, a.sched, runId,
      (r) => r.validation?.status === 'active'
        && (r.attempts || []).some((x) => x.role === 'implementer'
          && ['completed', 'failed', 'cancelled'].includes(x.status)),
      { maxTicks: 240, delayMs: 60 });
    const implAtt = run.attempts.find((x) => x.role === 'implementer');
    assert.ok(implAtt && implAtt.status === 'completed',
      'the implementer completed under A before the handoff');
    assert.equal(run.validation?.owner?.instanceId, 'instA');

    // Positive death → B adopts the validation.
    registry.procs.set(pidA, { exists: false });
    b = mkSched(env, { registry, instanceId: 'instB', instPid: 93002, leaseMs: 30_000 });
    run = await drive(svc, b.sched, runId,
      (r) => r.validation?.owner?.instanceId === 'instB', { maxTicks: 240, delayMs: 60 });
    assert.ok((run.validation?.adoptions || [])
      .some((x) => x.kind === 'process_dead'), 'B adopted under process_dead proof');

    const cli = mkClient(svc, stateDir);
    const rev = async () => (await getCard(svc, 'card-a')).json.internalRevision;
    const evt = async (body, tries = 8) => {
      let res;
      for (let i = 0; i < tries; i += 1) {
        res = await cli.command('card-a', {
          ...body, expectedInternalRevision: await rev(),
        }).catch((e) => ({ status: e.status ?? 0, code: e.code, message: e.message }));
        if (res?.code !== 'revision_conflict') return res;
      }
      return res;
    };
    const selfOf = (inst) => ({ runnerId: 'host-runner', instanceId: inst });

    // The CURRENT validation owner (B) writes a run-level event — the stale
    // last-attempt owner A must NOT shadow the live reservation authority.
    const okB = await evt({
      commandId: `ev-b-${randomUUID().slice(0, 6)}`, type: 'record_event',
      payload: { runId, type: 'recovery_note',
        data: { note: 'adopter holds the duty' }, ...selfOf('instB') },
    });
    assert.equal(okB.ok, true, `adopter's run-level event accepted: ${J(okB)}`);

    // An unrelated third instance may never write run-level events.
    const noC = await evt({
      commandId: `ev-c-${randomUUID().slice(0, 6)}`, type: 'record_event',
      payload: { runId, type: 'recovery_note',
        data: { note: 'unrelated' }, ...selfOf('instC') },
    });
    assert.equal(noC.status, 409, J(noC));
    assert.equal(noC.code, 'not_validation_owner');

    // An attempt-SCOPED event still binds the exact attempt owner — B is the
    // validation owner but may not write events onto A's implementer attempt.
    const noBAtt = await evt({
      commandId: `ev-ba-${randomUUID().slice(0, 6)}`, type: 'record_event',
      payload: { runId, attemptId: implAtt.id, type: 'recovery_note',
        data: { note: 'not my attempt' }, ...selfOf('instB') },
    });
    assert.equal(noBAtt.status, 409, J(noBAtt));
    assert.equal(noBAtt.code, 'not_attempt_owner');
  } finally {
    registry.procs.set(pidA, { exists: false });
    await stopAndDrain(svc, a.sched, runId, 'card-a').catch(() => {});
    if (b) await stopAndDrain(svc, b.sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Journaled report vs landed report: A's dropped check report is inherited
// by B's journal spool while B's OWN task resend records the same report
// under its resend key. The replay must then decide by TYPED EQUIVALENCE:
// every semantic field + the referenced artifacts' scope/kind/hash + the
// proc's positive proof + re-verified stored bytes — never a blanket
// check_recorded discharge. Exact evidence discharges; an artifact-plane
// outage retains+retries; ANY changed field retains the duty as a durable
// report_conflict.
// ============================================================================

test('U5 recovery: journaled report discharge — exact equivalence only', async () => {
  const variants = [
    'exact',        // identical evidence → replay discharges, spool ack'd
    'outageget',    // artifact-plane loss at discharge → retained+retried → restore discharges
    'exitmismatch', // recorded exitCode changed → retained conflict
    'scopemismatch',// recorded log artifact bound to another validation → retained
    'proofmismatch',// proc settled but its positive proof is gone → retained
  ];
  for (const mode of variants) {
    const env = await mkEnv();
    const { svc, projectDir, stateDir } = env;
    await seedBase(svc, projectDir);
    const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(),
      procs: new Map(), unreadable: new Map(), listFails: 0, seq: 0 };
    const pidA = 96001;
    const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo hit >> hits.txt' }]);
    const valId = `val_${runId}_1`;
    const jrnlA = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instA.jsonl`);
    const sw = { down: false, drop: new Set([`vp-${valId}-c0`]), downOnDrop: true };
    const a = mkSched(env, { registry, sw, instanceId: 'instA', instPid: pidA, leaseMs: 30_000 });
    let b = null;
    const jrnlHas = async (cid) => (await fs.readFile(jrnlA, 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).some((l) => {
        try { return JSON.parse(l)?.commandId === cid; } catch { return false; }
      });
    const spoolGone = async () => !(await fs.stat(jrnlA).then(() => true).catch(() => false));
    try {
      // A runs the check to a settled proc; the report send drops and the
      // whole API freezes — the duty is journaled, never applied.
      let run = await drive(svc, a.sched, runId,
        (r) => r.validation?.procs?.[0]?.state === 'settled', { maxTicks: 200, delayMs: 50 });
      for (let i = 0; i < 80 && !(await jrnlHas(`vp-${valId}-c0`)); i += 1) {
        await a.sched.tick(); await sleep(30);
      }
      assert.ok(await jrnlHas(`vp-${valId}-c0`), `${mode}: the dropped report is journaled`);
      const mid = await runView(svc, runId);
      assert.equal((mid.validation?.checks?.reports || []).length, 0,
        `${mode}: zero reports — verified before death`);
      // A dies positively; B boots healthy with ALL journal-replay keys
      // blocked — B's own task resend records the report first, so the
      // inherited entry later replays INTO check_recorded.
      registry.procs.set(pidA, { exists: false });
      const swB = { down: false, dropPrefix: ['jr-'] };
      b = mkSched(env, { registry, sw: swB, instanceId: 'instB', instPid: 96002, leaseMs: 30_000 });
      run = await drive(svc, b.sched, runId,
        (r) => (r.validation?.checks?.reports || []).length === 1,
        { maxTicks: 220, delayMs: 60 });
      assert.equal(run.validation?.owner?.instanceId, 'instB', `${mode}: B adopted`);
      assert.equal(run.validation?.checks?.reports?.[0]?.index, 0,
        `${mode}: the task resend recorded check[0] under its own key`);
      assert.ok(await jrnlHas(`vp-${valId}-c0`),
        `${mode}: the inherited journal entry survives while replay is blocked`);
      // Capture the ORIGINAL journaled duty verbatim — after discharge the
      // file is gone; the receipt-contract check below needs its payload.
      const capturedJrn = (await fs.readFile(jrnlA, 'utf8').catch(() => ''))
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const hits1 = await fs.readFile(join(run.validation.dirs.verify, 'hits.txt'), 'utf8');
      assert.equal(hits1.trim().split('\n').filter(Boolean).length, 1,
        `${mode}: one execution — the resend reused the verified spool`);
      if (mode !== 'exact' && mode !== 'outageget') {
        // Mutate the AUTHORITATIVE recorded evidence in BOTH projections
        // (canonical run file + aggregate embedded copy) so the replay's
        // typed comparison genuinely sees the change.
        const runFile = await loadRun(stateDir, runId);
        const aggFix = await loadAggregate(stateDir, 'card-a');
        const aggRun = (aggFix.runs || []).find((r) => r.id === runId);
        assert.ok(aggRun?.validation?.checks?.reports?.[0], `${mode}: report exists to tamper`);
        for (const rf of [runFile, aggRun]) {
          const rep0 = rf.validation.checks.reports[0];
          if (mode === 'exitmismatch') rep0.exitCode = 99;
          if (mode === 'scopemismatch') {
            const aid = rep0.logOutArtifactId;
            rf.artifacts[aid].validationId = `val_other_${valId}`;
          }
          if (mode === 'proofmismatch') rf.validation.procs['0'].proof = null;
        }
        await saveRun(stateDir, runFile);
        await saveAggregate(stateDir, aggFix);
        const probed = await runView(svc, runId);
        if (mode === 'exitmismatch') {
          assert.equal(probed.validation.checks.reports[0].exitCode, 99,
            `${mode}: the tampered exit code is served — the fault is real`);
        }
        if (mode === 'scopemismatch') {
          const aid = probed.validation.checks.reports[0].logOutArtifactId;
          assert.equal(probed.artifacts[aid].validationId, `val_other_${valId}`,
            `${mode}: the tampered scope is served`);
        }
        if (mode === 'proofmismatch') {
          assert.equal(probed.validation.procs['0'].proof, null,
            `${mode}: the stripped proof is served`);
        }
      }
      if (mode === 'outageget') {
        // Artifact-plane loss at discharge time: the equivalence check can
        // never swallow a transport outage into a permanent conflict — the
        // entry retains and retried passes stay blocked until restored.
        swB.dropGet = true;
        swB.dropPrefix = []; // replay resumes INTO the artifact-plane outage:
        // command sends land, only the evidence-byte reads are refused
        for (let i = 0; i < 6; i += 1) { await b.sched.tick(); await sleep(50); }
        assert.ok((swB.getTries || []).length > 0,
          'the discharge pass actually attempted artifact reads under the outage');
        assert.ok(!(await spoolGone()),
          'an artifact-plane outage retains the journaled duty — never a blind conflict');
        swB.dropGet = false;
      } else {
        swB.dropPrefix = [];
      }
      for (let i = 0; i < 80 && !(await spoolGone()); i += 1) {
        await b.sched.tick(); await sleep(40);
      }
      const ev = await req(svc, 'GET', `/api/execution/runs/${runId}/events`)
        .then((r) => r.json?.events || []).catch(() => []);
      const gone = await spoolGone();
      if (!gone || !(mode === 'exact' || mode === 'outageget')) {
        const raw = await fs.readFile(jrnlA, 'utf8').catch(() => '');
        console.log('JRN-DUMP', mode, J({
          entries: raw.split('\n').filter(Boolean).map((l) => {
            const p = JSON.parse(l);
            return { commandId: p.commandId, type: p.type, kind: p.kind,
              attemptId: p.attemptId, diag: p.diagnosisEvent ?? null };
          }),
          reports: (await runView(svc, runId)).validation?.checks?.reports,
          retains: ev.filter((e) => e.type === 'journal_retain').map((e) => e.data),
        }));
      }
      if (mode === 'exact' || mode === 'outageget') {
        assert.ok(gone,
          `${mode}: exact equivalent evidence discharged the journaled report`);
      } else {
        assert.ok(!(await spoolGone()),
          `${mode}: mismatched evidence retains the journaled duty — never discharged`);
        assert.ok(ev.some((e) => e.type === 'journal_retain'
            && e.data?.code === 'report_conflict'),
          `${mode}: a durable report_conflict diagnostic was recorded`);
      }
      const hits2 = await fs.readFile(join(run.validation.dirs.verify, 'hits.txt'), 'utf8');
      assert.equal(hits2.trim().split('\n').filter(Boolean).length, 1,
        `${mode}: the check ran exactly once across replay, discharge and conflict`);
      if (mode === 'exact' || mode === 'outageget') {
        // The rebound replay landed under its OWN instance-scoped key — the
        // ORIGINAL commandId must still prove UNAPPLIED: a rebound send can
        // never back-fill the original receipt or impersonate the dead owner.
        const origEntry = capturedJrn?.find((x) => x.commandId === `vp-${valId}-c0`);
        assert.ok(origEntry?.payload, 'the original journaled payload was captured');
        const ic = mkClient(svc, stateDir, null);
        const rc = await ic.command('card-a', {
          commandId: `rcq-${randomUUID().slice(0, 8)}`,
          type: 'command_receipt',
          payload: {
            commandId: origEntry.commandId, type: origEntry.type,
            payload: origEntry.payload,
          },
        });
        const rec = rc?.result ?? rc ?? {};
        assert.equal(rec.exists, false,
          'the original report commandId stayed unapplied — rebound keys never back-fill it');
      }
    } finally {
      registry.procs.set(pidA, { exists: false });
      await stopAndDrain(svc, a.sched, runId, 'card-a').catch(() => {});
      if (b) await stopAndDrain(svc, b.sched, runId, 'card-a').catch(() => {});
    }
  }
});

// ============================================================================
// Predecessor spool readability: a dead owner's journal that is UNREADABLE
// at scan time must degrade + retry — never marked seen — so a restored
// file still feeds the SAME scheduler its real entries, and the tracked
// merge is consumed exactly once (no resurrected duties re-journaled).
// ============================================================================

test('U5 recovery: unreadable predecessor journal — retried, drained on restore', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(),
    procs: new Map(), unreadable: new Map(), listFails: 0, seq: 0 };
  const pidA = 97001;
  const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo hit >> hits.txt' }]);
  const valId = `val_${runId}_1`;
  const jrnlA = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instA.jsonl`);
  const jrnlB = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instB.jsonl`);
  const sw = { down: false, drop: new Set([`vp-${valId}-c0`]), downOnDrop: true };
  const a = mkSched(env, { registry, sw, instanceId: 'instA', instPid: pidA, leaseMs: 30_000 });
  let b = null;
  const jrnlHas = async (cid) => (await fs.readFile(jrnlA, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).some((l) => {
      try { return JSON.parse(l)?.commandId === cid; } catch { return false; }
    });
  const spoolGone = async () => !(await fs.stat(jrnlA).then(() => true).catch(() => false));
  try {
    await drive(svc, a.sched, runId,
      (r) => r.validation?.procs?.[0]?.state === 'settled', { maxTicks: 200, delayMs: 50 });
    for (let i = 0; i < 80 && !(await jrnlHas(`vp-${valId}-c0`)); i += 1) {
      await a.sched.tick(); await sleep(30);
    }
    assert.ok(await jrnlHas(`vp-${valId}-c0`), 'the dropped report is journaled');
    // A dies; its journal becomes UNREADABLE before B can scan it. The
    // scan must degrade + retry — marking the source seen here would
    // orphan the pending duty forever.
    registry.procs.set(pidA, { exists: false });
    await fs.chmod(jrnlA, 0o000);
    const swB = { down: false, dropPrefix: ['jr-'] }; // replay gated — the
    // SCAN's retry behavior is what this window isolates.
    b = mkSched(env, { registry, sw: swB, instanceId: 'instB', instPid: 97002, leaseMs: 30_000 });
    for (let i = 0; i < 8; i += 1) { await b.sched.tick(); await sleep(50); }
    const statA = await fs.stat(jrnlA).catch(() => null);
    assert.ok(statA, 'the unreadable spool file still exists — nothing skipped');
    // Restore readability; the same B must still pick the spool up.
    await fs.chmod(jrnlA, 0o600);
    for (let i = 0; i < 4; i += 1) { await b.sched.tick(); await sleep(50); }
    // Now let the replay run — the duty discharges by its typed equivalent
    // (B's task resend may already have recorded the report) or applies.
    swB.dropPrefix = [];
    for (let i = 0; i < 100 && !(await spoolGone()); i += 1) {
      await b.sched.tick(); await sleep(40);
    }
    assert.ok(await spoolGone(),
      'the restored predecessor journal is inherited and fully drained by the same B');
    // The tracked merge was consumed exactly once: B's OWN journal never
    // gained a resurrected resolve duty for A's already-terminal attempt.
    const rawB = await fs.readFile(jrnlB, 'utf8').catch(() => '');
    const dupResolves = rawB.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return { kind: 'corrupt' }; } })
      .filter((e) => e.kind === 'resolve');
    assert.equal(dupResolves.length, 0,
      `no resurrected tracked duties re-journaled under B: ${J(dupResolves.map((x) => x.attemptId))}`);
    const run = await runView(svc, runId);
    assert.equal((run.validation?.checks?.reports || []).length, 1, 'one report total');
    const hits = await fs.readFile(join(run.validation.dirs.verify, 'hits.txt'), 'utf8');
    assert.equal(hits.trim().split('\n').filter(Boolean).length, 1, 'the check ran exactly once');
  } finally {
    registry.procs.set(pidA, { exists: false });
    await fs.chmod(jrnlA, 0o600).catch(() => {});
    await stopAndDrain(svc, a.sched, runId, 'card-a').catch(() => {});
    if (b) await stopAndDrain(svc, b.sched, runId, 'card-a').catch(() => {});
  }
});

// ============================================================================
// Spool recovery: with the report dropped+unapplied AND the owner's journal
// lost, the check's durable result spool is the only surviving evidence. A
// missing spool fails honestly; a CORRUPT spool — bad vocabulary, an
// impossible attestation combo, a forged/malformed proc, a path-escaping
// log name, a negative byte count — is refused as unproven evidence:
// diagnostic retained, zero rerun, never a manufactured report.
// Fixture note: the dropped c0 send is frozen under a FULL API outage so no
// rebound-key replay can land it; the zero-report state is verified against
// the authoritative aggregate before the owner dies.
// ============================================================================

test('U5 spool recovery: corrupt/missing result spool — retained, never rerun', async () => {
  const variants = [
    ['missing', 'echo hit >> hits.txt', null],
    ['badjson', 'echo hit >> hits.txt', '{unterminated'],
    ['badstatus', 'echo hit >> hits.txt', (r) => ({ ...r, status: 'PASSED' })],
    ['badexit', 'echo hit >> hits.txt', (r) => ({ ...r, exitCode: 'zero' })],
    ['inconsistent', 'echo hit >> hits.txt', (r) => ({
      ...r, exitCode: 7, cancelled: true, timedOut: true, groupDead: false })],
    ['forgedpass', 'echo hit >> hits.txt; exit 3', (r) => ({ ...r, status: 'pass' })],
    ['nospawnpass', 'echo hit >> hits.txt', (r) => ({
      ...r, spawnInvoked: false, childSpawned: false, spawnError: null })],
    ['badprocobj', 'echo hit >> hits.txt', (r) => ({ ...r, proc: { pid: 'garbage' } })],
    ['forgedproc', 'echo hit >> hits.txt', (r) => ({ ...r, proc: { ...r.proc, pid: r.proc.pid + 500 } })],
    ['logescape', 'echo hit >> hits.txt', (r) => ({ ...r, logOut: '../../escape.log' })],
    ['negbytes', 'echo hit >> hits.txt', (r) => ({ ...r, logBytesOut: -7 })],
  ];
  for (const [mode, checkRun, tamper] of variants) {
    const env = await mkEnv();
    const { svc, projectDir, stateDir } = env;
    await seedBase(svc, projectDir);
    const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(),
      procs: new Map(), unreadable: new Map(), listFails: 0, seq: 0 };
    const pidA = 94001;
    const runId = await mkValidationRun(svc, 'card-a', [{ run: checkRun }]);
    const valId = `val_${runId}_1`;
    const jrnlA = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instA.jsonl`);
    const spoolPath = join(stateDir, 'execution', 'spool', valId, 'check-0.json');
    const sw = { down: false, drop: new Set([`vp-${valId}-c0`]), downOnDrop: true };
    const a = mkSched(env, { registry, sw, instanceId: 'instA', instPid: pidA, leaseMs: 30_000 });
    let b = null;
    const jrnlHas = async (cid) => (await fs.readFile(jrnlA, 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).some((l) => {
        try { return JSON.parse(l)?.commandId === cid; } catch { return false; }
      });
    try {
      const run0 = await drive(svc, a.sched, runId,
        (r) => r.validation?.procs?.[0]?.state === 'settled', { maxTicks: 200, delayMs: 50 });
      const leader0 = run0.validation.procs[0].leader;
      for (let i = 0; i < 80 && !(await jrnlHas(`vp-${valId}-c0`)); i += 1) {
        await a.sched.tick(); await sleep(30);
      }
      // The drop froze the WHOLE api the instant the send was attempted —
      // no rebound-key replay could ever land the report.
      for (let i = 0; i < 4; i += 1) { await a.sched.tick(); await sleep(40); }
      assert.ok(await jrnlHas(`vp-${valId}-c0`),
        `${mode}: the dropped report send is journaled — it never applied`);
      const mid = await runView(svc, runId);
      assert.equal((mid.validation?.checks?.reports || []).length, 0,
        `${mode}: zero reports — verified before death, not assumed`);
      const agg0 = await loadAggregate(stateDir, 'card-a');
      assert.equal(Object.values(agg0.commands || {}).filter((c) => c
        && c.type === 'validation_progress' && c.body?.result?.runId === runId
        && c.body?.result?.validationId === valId
        && typeof c.body?.result?.recorded === 'string'
        && c.body.result.recorded.startsWith('check[0]→')).length, 0,
        `${mode}: no check-0 report applied under original OR rebound key`);
      // The genuine spool exists and verifies BEFORE any tamper.
      const honest = JSON.parse(await fs.readFile(spoolPath, 'utf8'));
      assert.equal(honest.validationId, valId, `${mode}: real spool bound to the validation`);
      assert.equal(honest.proc?.pid, leader0.pid, `${mode}: spool binds the recorded leader`);
      // A dies; its journal is LOST with it — the spool is the only report
      // evidence left. Then tamper.
      registry.procs.set(pidA, { exists: false });
      await fs.rm(jrnlA);
      if (mode === 'missing') {
        await fs.rm(spoolPath);
        await assert.rejects(fs.access(spoolPath), /ENOENT/, `${mode}: spool truly gone`);
      } else {
        const mutated = typeof tamper === 'function' ? tamper(honest) : tamper;
        await fs.writeFile(spoolPath,
          typeof mutated === 'string' ? mutated : JSON.stringify(mutated), 'utf8');
      }
      b = mkSched(env, { registry, sw: { down: false }, instanceId: 'instB', instPid: 94002, leaseMs: 30_000 });
      const run = await drive(svc, b.sched, runId,
        (r) => ['failed', 'blocked', 'cancelled'].includes(r.status),
        { maxTicks: 220, delayMs: 60 });
      assert.equal(run.status, 'failed', `${mode}: ${J({ s: run.status, e: run.error })}`);
      assert.equal((run.validation?.checks?.reports || []).length, 0,
        `${mode}: a failed/lost spool never manufactures a check report`);
      assert.equal(run.validation?.procs?.[0]?.leader?.pid, leader0.pid,
        `${mode}: the recorded leader is untouched — zero rerun`);
      const hits = await fs.readFile(
        join(run.validation.dirs.verify, 'hits.txt'), 'utf8');
      assert.equal(hits.trim().split('\n').filter(Boolean).length, 1,
        `${mode}: the check was never re-executed`);
      if (mode === 'missing') {
        assert.match(run.error ?? '', /spool.*missing|missing.*spool/i,
          `${mode}: honest missing-spool diagnostic`);
      } else {
        const ev = await req(svc, 'GET', `/api/execution/runs/${runId}/events`);
        assert.ok((ev.json?.events || ev.json || [])
          .some((e) => e.type === 'validation_spool_corrupt'),
          `${mode}: durable spool-corruption event recorded`);
      }
    } finally {
      registry.procs.set(pidA, { exists: false });
      await stopAndDrain(svc, a.sched, runId, 'card-a').catch(() => {});
      if (b) await stopAndDrain(svc, b.sched, runId, 'card-a').catch(() => {});
    }
  }
});

// ============================================================================
// Intent-repair via spool: a pre-spawn intent whose receipts were lost can
// be repaired ONLY by a spool whose claimed leader positively matches the
// intent's COMPLETE recorded origin (pidNs + uid + containerId + init +
// slot + generation). A stripped origin accepts no foreign receipt; a
// malformed proc object is corrupt — never silently read as 'no child'.
// ============================================================================

test('U5 spool intent repair: verified origin binding or unproven retention', async () => {
  const variants = [
    ['intentrepair', (rec, runFile) => null],          // positive control
    ['missingorigin', (rec, runFile, aggRun) => {      // strip the origin
      // BOTH projections carry the durable origin: the canonical run file
      // AND the aggregate's embedded copy (adoption's stageRun rewrites
      // the run file FROM the aggregate — tampering one is insufficient).
      for (const rf of [runFile, aggRun]) {
        const p = rf?.validation?.procs?.['0'];
        if (!p) continue;
        delete p.originEnvKey; delete p.originEnv;
        delete p.originSlot; delete p.originGen;
      }
    }],
    ['badprocintent', (rec) => ({ ...rec, proc: { pid: 'garbage' } })],
    ['nspawnattest', (rec) => ({                        // honest never-spawn
      ...rec, proc: null, spawnInvoked: false, childSpawned: false,
      spawnError: null, status: 'error', error: 'log precondition refused',
      exitCode: null, groupDead: false,
    })],
  ];
  for (const [mode, mutate] of variants) {
    const env = await mkEnv();
    const { svc, projectDir, stateDir } = env;
    await seedBase(svc, projectDir);
    const registry = { runs: new Map(), records: new Map(), usedAttempts: new Set(),
      procs: new Map(), unreadable: new Map(), listFails: 0, seq: 0 };
    const pidA = 95001;
    const runId = await mkValidationRun(svc, 'card-a', [{ run: 'echo hit >> hits.txt' }]);
    const valId = `val_${runId}_1`;
    const jrnlA = join(env.root, 'fake-exec', 'journal', `u4-journal-host-runner-instA.jsonl`);
    const spoolPath = join(stateDir, 'execution', 'spool', valId, 'check-0.json');
    // Intent lands; the record/settle receipts and report are dropped —
    // the proc stays 'intent', the spool is the only surviving evidence.
    const sw = { down: false, downOnDrop: true, drop: new Set([
      `vp-${valId}-p0-rec`, `vp-${valId}-p0-settled`, `vp-${valId}-p0-unp`,
      `vp-${valId}-c0`,
    ]) };
    const a = mkSched(env, { registry, sw, instanceId: 'instA', instPid: pidA, leaseMs: 30_000 });
    let b = null;
    const jrnlHas = async () => (await fs.readFile(jrnlA, 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).length > 0;
    try {
      await drive(svc, a.sched, runId,
        (r) => r.validation?.procs?.[0]?.state === 'intent'
          && (r.validation?.procs?.[0]?.originEnvKey != null),
        { maxTicks: 200, delayMs: 50 });
      for (let i = 0; i < 80; i += 1) {
        if (await fs.stat(spoolPath).then(() => true).catch(() => false)) break;
        await a.sched.tick(); await sleep(30);
      }
      // The first dropped receipt froze the WHOLE api at attempt time —
      // no rebound-key replay could land it afterwards.
      for (let i = 0; i < 4; i += 1) { await a.sched.tick(); await sleep(40); }
      const mid = await runView(svc, runId);
      assert.equal(mid.validation?.procs?.[0]?.state, 'intent',
        `${mode}: proc still intent — verified before death`);
      assert.equal((mid.validation?.checks?.reports || []).length, 0,
        `${mode}: zero reports — verified, not assumed`);
      const agg0 = await loadAggregate(stateDir, 'card-a');
      // Stored body is {ok, result:{runId, validationId, recorded}} — an
      // applied dropped receipt shows proc[0]→recorded/settled/unproven
      // or a check[0]→* report. proc[0]→intent DID land legitimately.
      assert.equal(Object.values(agg0.commands || {}).filter((c) => {
        const rec = c?.body?.result?.recorded;
        return c?.type === 'validation_progress'
          && c.body?.result?.runId === runId
          && c.body?.result?.validationId === valId
          && typeof rec === 'string'
          && (rec.startsWith('check[0]→')
            || (rec.startsWith('proc[0]→') && rec !== 'proc[0]→intent'));
      }).length, 0, `${mode}: no dropped receipt applied under any key`);
      const honest = JSON.parse(await fs.readFile(spoolPath, 'utf8'));
      assert.ok(honest.proc?.pid > 0, `${mode}: real spool carries the executed leader`);
      registry.procs.set(pidA, { exists: false });
      await fs.rm(jrnlA, { force: true }); // journal lost with the owner
      const runFile = await loadRun(stateDir, runId);
      const aggFix = await loadAggregate(stateDir, 'card-a');
      const aggRun = (aggFix.runs || []).find((r) => r.id === runId);
      // aggregate.runs is an ARRAY — the embedded copy must exist and
      // carry the proc BEFORE mutation, never an undefined no-op.
      assert.ok(aggRun?.validation?.procs?.['0'],
        `${mode}: aggregate embedded run carries proc[0]`);
      const next = mutate(honest, runFile, aggRun);
      if (next) await fs.writeFile(spoolPath, JSON.stringify(next), 'utf8');
      await saveRun(stateDir, runFile);
      await saveAggregate(stateDir, aggFix);
      // The injected fault is REAL in BOTH projections: re-read through
      // the api (the canonical run file GET serves) and a RELOADED
      // aggregate (whose embedded run adoption's stageRun writes from).
      const probed = await runView(svc, runId);
      const pProbe = probed.validation?.procs?.[0];
      assert.equal(pProbe?.state, 'intent', `${mode}: proc still intent after tamper`);
      if (mode === 'missingorigin') {
        assert.ok(pProbe?.originEnvKey == null && pProbe?.originEnv == null,
          `${mode}: the origin strip reached the served run`);
        const aggAfter = await loadAggregate(stateDir, 'card-a');
        assert.ok((aggAfter.runs || []).find((r) => r.id === runId)
          ?.validation?.procs?.['0']?.originEnvKey == null,
          `${mode}: the origin strip persisted in the aggregate projection`);
      }
      b = mkSched(env, { registry, sw: { down: false }, instanceId: 'instB', instPid: 95002, leaseMs: 30_000 });
      const run = await drive(svc, b.sched, runId,
        (r) => r.validation?.status === 'unproven'
          || ['failed', 'blocked', 'cancelled'].includes(r.status)
          || (r.validation?.checks?.reports || []).length > 0,
        { maxTicks: 220, delayMs: 60 });
      const val = run.validation;
      const hits = await fs.readFile(join(val.dirs.verify, 'hits.txt'), 'utf8')
        .catch(() => '');
      assert.equal(hits.trim().split('\n').filter(Boolean).length, 1,
        `${mode}: the check was never re-executed`);
      if (mode === 'intentrepair') {
        assert.equal((val.checks?.reports || []).length, 1,
          'the verified spool repaired the intent and supplied the report');
        assert.equal(val.procs?.[0]?.leader?.pid, honest.proc.pid,
          'the repaired proc binds the SPOOL-attested original leader');
        assert.equal(val.procs?.[0]?.state, 'settled');
      } else if (mode === 'nspawnattest') {
        assert.equal(val.procs?.[0]?.state, 'settled',
          'a verified never-spawned attestation settles the intent');
        const rep0 = (val.checks?.reports || [])[0];
        assert.equal(rep0?.status, 'error', 'the attested error outcome is reported honestly');
      } else {
        // missingorigin / badprocintent: unbound evidence is refused —
        // the intent stays unresolved, the reservation unproven, and the
        // claimed pid is never probed or trusted.
        assert.equal(val.status, 'unproven',
          `${mode}: retained unproven — ${J({ v: val.status, s: run.status })}`);
        assert.equal(val.procs?.[0]?.state, 'intent',
          `${mode}: unverified evidence never settles the proc`);
        assert.equal((val.checks?.reports || []).length, 0,
          `${mode}: no report manufactured`);
      }
    } finally {
      registry.procs.set(pidA, { exists: false });
      await stopAndDrain(svc, a.sched, runId, 'card-a').catch(() => {});
      if (b) await stopAndDrain(svc, b.sched, runId, 'card-a').catch(() => {});
    }
  }
});
