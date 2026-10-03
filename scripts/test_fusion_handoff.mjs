// scripts/test_fusion_handoff.mjs — deterministic F3 fusion-handoff tests.
//   node --test scripts/test_fusion_handoff.mjs
//
// Covers the post-panel half of fusion (R6–R9): the judge's versioned
// work order, comparison-only rejection, accepted-answer reduction,
// work-order routing (document vs implementation), exact-current-version
// approval, integrator panel isolation, canonical import, the inherited
// U5 reviewer/checker gate, fix rounds, acceptance drift annulment, and
// the durable-write→launch handshake recovery windows — all through the
// real createStateService queue + createInternalClient, with the same
// fake container runtime the F2 tests use (extended with the canonical
// ops the integrator needs). NOTHING opens a listener or touches compose.

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
import { profileDigest } from '../server/execution/environment/agent-profile.mjs';
import { canonicalJson } from '../server/execution/environment/agent-profile.mjs';
import { buildPanelPrompt, sha256Hex } from '../server/execution/fusion/prompt.mjs';
import { buildAnswersBundle, judgeMaterials, integratorMaterials }
  from '../server/execution/fusion/handoff-prompt.mjs';
import { workOrderContractText, parseWorkOrder, parseIntegratorReport }
  from '../server/execution/fusion/work-order.mjs';
import { FINDINGS_FILE, VERDICTS_FILE } from '../server/execution/prompt.mjs';
import { projectKeyFor } from '../server/execution/workspaces.mjs';

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
  const dir = join(tmpdir(), `f3-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  await fs.writeFile(join(dir, 'src', 'b.js'), 'export const b = 2;\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
const myGid = typeof process.getgid === 'function' ? process.getgid() : null;

async function mkEnv({ faults, features = { start: true, fusion: true, validation: true }, envExtra = {} } = {}) {
  const root = join(tmpdir(), `f3-state-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const stateDir = join(root, 'state');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
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
  return { root, stateDir, projectDir, svc };
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
// Internal-channel commands (integrate_begin & friends) ride the
// authenticated internal client — never the user route.
async function internalCmd(env, cardId, body) {
  const cli = mkClient(env.svc, env.stateDir);
  try {
    if (body.expectedInternalRevision === undefined) {
      const card = await getCard(env.svc, cardId);
      body = { ...body, expectedInternalRevision: card.json.internalRevision };
    }
    const r = await cli.command(cardId, body);
    return { status: 200, json: r };
  } catch (e) {
    return {
      status: e.status ?? 500,
      json: { code: e.code ?? 'error', message: e.message, ...(e.details ?? {}) },
    };
  }
}
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

// ---- the F3-extended fake of the F1 container runtime ------------------------
//
// Everything the F2 fake does PLUS the canonical worktree pair
// (canonical.prepare/status + repo.import) the integrator needs — real git,
// so the import is verified by content, never by exit code. Behaviors match
// by attemptId substring ('ja-' judge attempts, 'ia-' integrator attempts):
//   { preLaunchFail, dropStart, lostBind, runMs, runStatus, finalText, hang,
//     cancelMs, transientStartFails, stuckLaunch }   — same as F2
//   { scan: { matches, workers } }              — reconcile returns this scan
//                                               verbatim (gone-evidence shapes)
//   { edits: { write: {rel: text}, delete: [rel] } }
//                                       — repo.import applies these to the
//                                         canonical worktree and commits
//                                         (the private repo's final state).

function makeAnswer(tag) {
  return [
    `## Proposal\n\nAnswer from ${tag}: do X.\n`,
    `## Rationale\n\nBecause Y for ${tag}.\n`,
    `## Affected files\n\n- src/${tag}.js\n`,
    `## Downsides\n\nCost ${tag}.\n`,
    `## Excluded actions\n\nNo z ${tag}.\n`,
  ].join('\n');
}

function makeWorkOrder(verdict = 'in_plan', tag = 'wo') {
  return [
    '## Matches\n\nAll answers agree on the direction.\n',
    '## Contradictions\n\nNone material.\n',
    '## Gaps\n\nError handling is unspecified.\n',
    '## Unique ideas\n\nOne answer proposes caching.\n',
    '## Blind spots\n\nThe project has no test harness; verified by inspection.\n',
    '## Goal\n\nImplement the judged change for ' + tag + '.\n',
    '## Boundaries\n\nOnly src/ modules; no API surface changes.\n',
    '## Steps\n\n- add src/new-module.js\n- wire it into src/a.js\n',
    '## Affected parts\n\n- src/a.js\n- src/new-module.js\n',
    '## Criteria\n\n- the new module exists — verify: test -f src/new-module.js\n- tree builds — verify: node --check src/a.js\n',
    `## Verdict\n\n${verdict}\n`,
  ].join('\n');
}

function makeReport({ behaviorChange = false, mismatches = ['(none)'] } = {}) {
  return [
    '## Changes\n\n- wrote src/new-module.js\n- edited src/a.js\n',
    `## Mismatches\n\n${mismatches.map((m) => `- ${m}`).join('\n')}\n`,
    `## Behavior change\n\n${behaviorChange ? 'yes' : 'no'} — explanation follows.\n`,
  ].join('\n');
}

function createFakeContainerRuntime({ behaviors = {}, canonRoot = null, projectDir = null } = {}) {
  const calls = [];
  const records = new Map();
  const runs = new Map();
  const canonicals = new Map(); // canonicalId -> {id, hostDir, worktree, headSha}
  const transientFails = new Map();
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
      finalText: null, behavior: b, materials: params.materials ?? null,
      startedAt: new Date().toISOString(),
    };
    runs.set(runId, run);
    if (!b.hang) {
      setTimeout(() => {
        if (!run.terminal) {
          finish(run, {
            status: b.runStatus ?? 'completed',
            exitCode: b.exitCode ?? 0,
            runExitCode: b.runExitCode ?? b.exitCode ?? 0,
          });
        }
      }, b.runMs ?? 5).unref?.();
    }
    if (b.lostBind) {
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
    return {
      attemptId, missing: false, corrupt: false,
      phase: rec.phase ?? null, porchRunId: rec.porchRunId ?? null,
      workerId: rec.workerId ?? null, spawned: rec.spawned ?? null,
      error: rec.error ?? null, createdAt: rec.createdAt ?? null,
      launchStartedAt: rec.launch?.startedAt ?? null,
    };
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
    return { pid, exists: false, state: null, starttime: null, pidNs: 'ns-f3', readable: true };
  }

  // ---- F3 canonical ops — REAL git, so the import is content-verified ------

  async function canonicalPrepare(p = {}) {
    calls.push({ m: 'canonicalPrepare', params: p });
    const cid = p.canonicalId;
    const existing = canonicals.get(cid);
    if (existing) return { ok: true, canonical: existing, existed: true };
    const hostDir = join(canonRoot, cid);
    const repoGit = join(hostDir, 'repo.git');
    const worktree = join(hostDir, 'worktree');
    // projectRoot is the mounted basename (projectKeyFor) — the real
    // controller resolves it under its configured projects root; the fake
    // resolves it against the seeded project dir.
    const src = projectDir && p.projectRoot === projectKeyFor(projectDir)
      ? projectDir : p.projectRoot;
    await fs.mkdir(hostDir, { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', src, repoGit], { timeout: 15000 });
    execFileSync('git', ['-C', repoGit, 'worktree', 'add', '-q', '--detach', worktree, p.snapshotSha],
      { timeout: 15000 });
    execFileSync('git', ['-C', worktree, 'checkout', '-qb', p.branch], { timeout: 15000 });
    const headSha = git(worktree, 'rev-parse', 'HEAD');
    const rec = { id: cid, hostDir, worktree, headSha, baseSha: p.snapshotSha, state: 'ready' };
    canonicals.set(cid, rec);
    return { ok: true, canonical: rec, existed: false };
  }

  async function canonicalStatus(canonicalId) {
    calls.push({ m: 'canonicalStatus', canonicalId });
    const c = canonicals.get(canonicalId);
    if (!c) return { ok: false, error: { code: 'unknown_canonical', message: 'no canonical' } };
    return { ok: true, canonical: { ...c, headSha: git(c.worktree, 'rev-parse', 'HEAD') } };
  }

  // Import the worker's private-repo final state into canonical: apply the
  // scripted edits + commit on the canonical branch — the controller's
  // private→canonical diff+commit, content-verified.
  async function repoImport(workerId) {
    calls.push({ m: 'repoImport', workerId });
    const run = [...runs.values()].find((r) => r.workerId === workerId);
    if (!run) return { ok: false, error: { code: 'unknown_worker', message: `no worker ${workerId}` } };
    const b = run.behavior;
    const canonId = run.materials?.canonicalId;
    const c = canonicals.get(canonId);
    if (!c) return { ok: false, error: { code: 'unknown_canonical', message: 'no canonical' } };
    const edits = b.edits ?? {};
    for (const [rel, text] of Object.entries(edits.write ?? {})) {
      const abs = join(c.worktree, rel);
      await fs.mkdir(join(abs, '..'), { recursive: true });
      await fs.writeFile(abs, text, 'utf-8');
    }
    for (const rel of edits.delete ?? []) {
      await fs.rm(join(c.worktree, rel), { force: true });
    }
    git(c.worktree, 'add', '-A');
    const diffStat = git(c.worktree, 'diff', '--cached', '--stat', 'HEAD');
    const changed = git(c.worktree, 'status', '--porcelain').length > 0;
    let commitSha = git(c.worktree, 'rev-parse', 'HEAD');
    if (changed) {
      git(c.worktree, '-c', 'user.email=t@t', '-c', 'user.name=t',
        'commit', '-qm', `import ${run.attemptId}`);
      commitSha = git(c.worktree, 'rev-parse', 'HEAD');
    }
    const treeSha = git(c.worktree, 'rev-parse', 'HEAD^{tree}');
    c.headSha = commitSha;
    return {
      ok: true,
      import: { commitSha, treeSha, changed, diffStat },
      workerId,
    };
  }

  return {
    start, launchRecord, status, events, wait, cancel, reconcile, processIdentity,
    canonicalPrepare, canonicalStatus, repoImport,
    workerIdForAttempt: (attemptId) => `w-${attemptId}`,
    _calls: calls, _records: records, _runs: runs, _canonicals: canonicals,
    _finish: (runId, o) => { const r = runs.get(runId); if (r) finish(r, o); },
  };
}

// ---- scheduler + env helpers --------------------------------------------------

let pidSeq = 70000;
// roleDocs: {reviewer: <findings doc|fn(round)>, checker: <verdicts doc|fn(round)>}
// — the proc runtime writes the .acp-out evidence file when that role's
// attempt launches inside its validation copy.
function mkSched(env, {
  behaviors, instanceId = `inst-${randomUUID().slice(0, 8)}`,
  runnerId = 'host-runner', now, roleDocs = null, fusionOnlyRuntime = null,
} = {}) {
  const instPid = ++pidSeq;
  const canonRoot = join(env.root, 'canon');
  const registry = {
    runs: new Map(), records: new Map(), usedAttempts: new Set(),
    procs: new Map(), unreadable: [], listFails: 0, seq: 0,
  };
  const procRuntime = createFakeRuntime({
    registry,
    rootDir: join(env.root, 'fake-exec'),
    environment: { pid: instPid, pidStarttime: `st-${instPid}`, pidNs: 'ns-f3' },
    behaviors: { default: { outcome: 'completed', delayMs: 4 } },
  });
  registry.procs.set(instPid, {
    exists: true, state: 'R', starttime: `st-${instPid}`, readable: true,
  });
  // Reviewer/checker attempts leave their evidence file in the copy dir —
  // the porch agent's real duty, scripted deterministically.
  if (roleDocs) {
    const fileFor = { 'acp-reviewer': FINDINGS_FILE, 'acp-checker': VERDICTS_FILE };
    const origStart = procRuntime.start.bind(procRuntime);
    procRuntime.start = async (params) => {
      const r = await origStart(params);
      const file = fileFor[params?.profileId];
      if (r?.ok && file) {
        // The validation copy dir is .validation/<run>/val_<run>_<round>/{review,check}
        // — parse the round from the val-dir segment so the doc binds THIS
        // validation's round.
        const seg = params.cwd.split('/').find((s) => /^val_.+_\d+$/.test(s));
        const round = Number(/_(\d+)$/.exec(seg ?? '')?.[1] ?? 1);
        const doc = typeof roleDocs[params.profileId] === 'function'
          ? roleDocs[params.profileId](params, round) : roleDocs[params.profileId];
        if (doc !== undefined) {
          const out = join(params.cwd, '.acp-out');
          await fs.mkdir(out, { recursive: true });
          await fs.writeFile(join(out, file), JSON.stringify(doc));
        }
      }
      return r;
    };
  }
  const contRuntime = fusionOnlyRuntime ?? createFakeContainerRuntime({ behaviors, canonRoot, projectDir: env.projectDir });
  const sched = createManagedScheduler({
    client: mkClient(env.svc, env.stateDir),
    runtime: procRuntime,
    runnerId, instanceId,
    stateDir: env.stateDir,
    env: {
      ACP_WORKSPACE_DIR: join(env.root, 'wsroot'), ROOT_DIR: env.root,
      ACP_EXEC_VALIDATION: '1',
    },
    now,
    fusion: { runtime: contRuntime },
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

function fusionProfile(model, over = {}) {
  return {
    schemaVersion: 1,
    profileId: `prof-${model}`,
    pi: { version: '0.85.1' },
    image: 'worker',
    provider: 'zen-relay',
    model,
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

async function startFusion(svc, cardId, {
  task, panelists, resultKind = 'document',
  judge = null, integrator = null, review = null,
  search = false, maxAttempts = 2, timeoutMin = 45, baseRef,
} = {}) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c.json.controlRevision,
    payload: {
      mode: 'fusion',
      ...(baseRef ? { baseRef } : {}),
      fusion: {
        resultKind, task, panelists,
        ...(judge ? { judge: { profile: judge } } : {}),
        ...(integrator ? { integrator: { profile: integrator } } : {}),
        ...(review ? { review } : {}),
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

async function driveUntil(svc, sched, runId, pred, { maxTicks = 60 } = {}) {
  let run = await runView(svc, runId);
  for (let i = 0; i < maxTicks && !pred(run); i += 1) {
    await sched.tick();
    await waitFake();
    run = await runView(svc, runId);
  }
  return run;
}

// Full impl-card setup: approved requirements + plan (with real checks) +
// preset — the same gates a solo implementation run needs.
async function seedImplCard(svc, { checks = [{ run: 'test -f src/new-module.js', timeoutSec: 30 }] } = {}) {
  await enable(svc, 'card-a');
  const req1 = await attachDoc(svc, 'card-a', 'requirements', '# Requirements\n\nAdd the new module.\n');
  await approve(svc, 'card-a', 'approve_requirements', req1);
  const plan = await attachDoc(svc, 'card-a', 'plan', '# Plan\n\nWire the module.\n',
    { checks });
  await approve(svc, 'card-a', 'approve_plan', plan);
  await savePreset(svc, 'card-a');
  return { req1, plan };
}

function implSpec(svc, reqDoc) {
  return {
    task: reqDoc,
    panelists: null, // filled by caller
    resultKind: 'implementation',
    judge: fusionProfile('model-judge'),
    integrator: fusionProfile('model-integrator'),
    review: { reviewer: { ...MEMBER }, checker: { ...MEMBER } },
  };
}

// ==========================================================================
// 1. Judge: comparison-only rejected; WO minted; document run parks for the user
// ==========================================================================

test('judge: comparison-only rejected; versioned work order; document run parks for user acceptance', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# The task\n');
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const runId = await mustStartFusion(svc, 'card-a', {
    task: reqDoc, panelists: p, resultKind: 'document',
    judge: fusionProfile('model-judge'),
  });
  const { sched, runtime } = mkSched(env, { behaviors: {
    // Judge attempt n1 "compares answers" — the contract rejects it; n2
    // produces a real work order.
    [`ja-${runId.slice(4)}-n1`]: { runMs: 4, finalText: '## Matches\n\nAll three answers are similar. That is all.\n' },
    [`ja-${runId.slice(4)}-n2`]: { runMs: 4, finalText: makeWorkOrder('in_plan', 'doc') },
    'ia-': { runMs: 4, finalText: makeReport({}) },
    default: { runMs: 4, finalText: makeAnswer('x') },
  } });

  await sched.tick(); // claim
  await sched.tick(); // panel attempts
  let run = await driveUntil(svc, sched, runId,
    (r) => r.phase === 'judge' || (r.status === 'blocked' && r.fusion?.settledAt));
  assert.equal(run.phase, 'judge', J(run.fusion));

  // Judge attempt 1: comparison-only → failed with work_order_invalid.
  run = await driveUntil(svc, sched, runId,
    (r) => (r.attempts || []).some((a) => a.role === 'judge' && a.status === 'failed'));
  const j1 = run.attempts.find((a) => a.role === 'judge');
  assert.equal(j1.status, 'failed');
  assert.match(j1.error ?? '', /work_order_invalid|incomplete/, J(j1));
  assert.equal(run.fusion.workOrders?.length ?? 0, 0, 'no work order from a comparison');

  // Judge attempt 2 (fresh mint, never an implicit retry of the same row):
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked'
      && (r.fusion?.workOrders || []).length === 1);
  const jAtts = run.attempts.filter((a) => a.role === 'judge');
  assert.equal(jAtts.length, 2);
  assert.equal(jAtts[1].status, 'completed', J(jAtts[1]) + '\nEV:' + J((await eventsOf(svc, runId)).map((e) => e.type)));
  const wo = run.fusion.workOrders[0];
  assert.equal(wo.versionId, 'wo_v1');
  assert.equal(wo.verdict, 'in_plan');
  assert.ok(wo.artifactId && wo.sha256 && wo.bytes > 0);
  assert.ok(wo.sections?.goal && wo.steps?.length >= 2 && wo.criteria?.length >= 2);
  // The work order binds the exact inputs it judged.
  assert.equal(wo.inputs.resultKind, 'document');
  assert.equal(wo.inputs.snapshotSha, run.baseCommit);
  assert.ok(wo.inputs.taskSha256 && wo.inputs.answersSha256 && wo.inputs.rubricSha256);
  // The committed artifact verifies byte-for-byte against the WO record.
  const art = run.artifacts[wo.artifactId];
  assert.ok(art && art.sha256 === wo.sha256 && art.kind === 'work-order');
  assert.equal(run.status, 'blocked');
  assert.equal(run.phase, 'judge');
  assert.deepEqual(run.fusion.pendingActions.map((x) => x.type),
    ['work_order_approval']);
  assert.equal(run.fusion.pendingActions[0].versionId, 'wo_v1');

  // The judge's materials: ONLY task + answers + rubric — and the answers
  // bundle carries the accepted answers (the reduction is visible).
  const jStart = startsCalls(runtime).find((c) => String(c.params.attemptId).startsWith('ja-'));
  assert.ok(jStart, 'judge launched through the container runtime');
  const names = jStart.params.materials.inputs.map((i) => i.name).sort();
  assert.deepEqual(names, ['answers', 'rubric', 'task']);
  const answersInput = jStart.params.materials.inputs.find((i) => i.name === 'answers');
  for (const pid of ['p1', 'p2', 'p3']) {
    assert.ok(answersInput.content.includes(`Participant ${pid}`),
      `answers bundle names ${pid}`);
    assert.ok(answersInput.content.includes(`Answer from x:`),
      'accepted answer text is IN the bundle');
  }
  assert.ok(answersInput.content.includes('# Excluded participants'));
  // The durable launch input shas bind the recorded sources.
  const jAttempt = jAtts[1];
  const jIn = new Map(jAttempt.launch.inputs.map((i) => [i.name, i.sha256]));
  assert.equal(jIn.get('task'), run.fusion.snapshot.task.sha256);
  assert.equal(jIn.get('rubric'), sha256Hex(workOrderContractText()));
  assert.equal(jIn.get('answers'), wo.inputs.answersSha256);

  // Document result: wrong sha refuses; stale/bogus version refuses;
  // approving the CURRENT version succeeds — and produces NO approved plan.
  const card = await getCard(svc, 'card-a');
  let r = await cmd(svc, 'card-a', {
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, versionId: 'wo_v1', sha256: '0'.repeat(64) },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'hash_mismatch');
  r = await cmd(svc, 'card-a', {
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, versionId: 'wo_v9', sha256: wo.sha256 },
  });
  assert.equal(r.status, 404, J(r.json));
  assert.equal(r.json.code, 'work_order_not_found');
  r = await cmd(svc, 'card-a', {
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, versionId: 'wo_v1', sha256: wo.sha256 },
  });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.result.kind, 'document');
  assert.equal(run.result.workOrder.versionId, 'wo_v1');
  assert.equal(run.result.workOrder.sha256, wo.sha256);
  assert.equal(run.fusion.workOrder.versionId, 'wo_v1');
  // No approval was minted: approvals stay empty, pendingActions cleared.
  const cardDoc = await getCard(svc, 'card-a');
  assert.ok(!cardDoc.json.approvals?.plan, 'document run never auto-approves a plan');
  assert.deepEqual(run.fusion.pendingActions, []);

  // Attaching the work order AS a document creates a NEW version bound to
  // the artifact hash — and still approves nothing.
  const before = (await getCard(svc, 'card-a')).json.controlRevision;
  r = await cmd(svc, 'card-a', {
    commandId: `at-${randomUUID().slice(0, 6)}`, type: 'attach_document',
    expectedControlRevision: before,
    payload: { kind: 'requirements',
      source: { type: 'work_order', runId, versionId: 'wo_v1' } },
  });
  assert.equal(r.status, 200, J(r.json));
  const newVer = r.json.result;
  assert.ok(newVer.versionId && newVer.versionId !== reqDoc.versionId);
  const cardAfter = await getCard(svc, 'card-a');
  assert.ok(!cardAfter.json.approvals?.requirements
      || cardAfter.json.approvals.requirements.versionId !== newVer.versionId,
    'attaching a work order NEVER auto-approves the new version');

  // Durable event tail proves the sequence.
  const evs = await eventsOf(svc, runId);
  const types = evs.map((e) => e.type);
  assert.ok(types.includes('panel_settled'));
  assert.ok(types.includes('handoff_terminal'));
});

// ==========================================================================
// 2. Implementation: in_plan auto-routes; import; U5 gate; edit annuls
// ==========================================================================

test('implementation: in_plan auto-routes to integrator; import materializes; U5 gate parks; new edit annuls readiness', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { req1 } = await seedImplCard(svc);
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const spec = implSpec(svc, req1);
  spec.panelists = p;
  const runId = await mustStartFusion(svc, 'card-a', spec);
  const { sched, runtime } = mkSched(env, {
    behaviors: {
      [`ja-${runId.slice(4)}-n1`]: {
        runMs: 4,
        finalText: makeWorkOrder('in_plan'),
      },
      'ia-': {
        runMs: 4,
        finalText: makeReport({ behaviorChange: false }),
        edits: {
          write: {
            'src/new-module.js': 'export const nm = 42;\n',
            'src/a.js': 'export const a = 1;\nimport { nm } from "./new-module.js";\n',
          },
          delete: ['src/b.js'],
        },
      },
      default: { runMs: 4, finalText: makeAnswer('x') },
    },
    roleDocs: {
      'acp-reviewer': (_p, round) => ({ version: 1, round, findings: [] }),
      'acp-checker': (_p, round) => ({ version: 1, round, verdicts: [] }),
    },
  });

  await sched.tick(); await sched.tick();
  // Panel → judge → WO → auto-route to 'integrate' (no user approval).
  let run = await driveUntil(svc, sched, runId, (r) => r.phase === 'integrate');
  const wo = run.fusion.workOrders[0];
  assert.equal(wo.verdict, 'in_plan');
  assert.equal(wo.decision.routed, 'auto');
  assert.equal(run.fusion.integrate.workOrderVersionId, 'wo_v1');
  assert.equal(run.fusion.integrate.auto, true);
  assert.deepEqual(run.fusion.pendingActions, [], 'in_plan needs no approval');

  // Integrator launch: isolation — no 'answers', no panel material.
  run = await driveUntil(svc, sched, runId,
    (r) => (r.attempts || []).some((a) => a.role === 'integrator'));
  const iStart = startsCalls(runtime).find((c) => String(c.params.attemptId).startsWith('ia-'));
  assert.ok(iStart, 'integrator launched through the container runtime');
  const iNames = iStart.params.materials.inputs.map((i) => i.name).sort();
  assert.ok(!iNames.includes('answers'), 'integrator materials never carry answers');
  assert.ok(!iNames.some((n) => /panel|log/i.test(n)), 'no panel inputs');
  assert.deepEqual(iNames, ['plan', 'requirements', 'task', 'work-order']);
  // The prompt states the isolation invariant verbatim.
  assert.ok(iStart.params.prompt.includes('never saw and never will see the panel'));
  assert.ok(!iStart.params.prompt.includes('Answer from x:'),
    'no accepted-answer text inside the integrator prompt');
  for (const inp of iStart.params.materials.inputs) {
    assert.ok(typeof inp.content === 'string');
    assert.ok(!inp.content.includes('Answer from x:'),
      `integrator input ${inp.name} leaks panel text`);
  }
  assert.equal(iStart.params.materials.canonicalId, `canon-${runId.slice(4)}`);
  assert.ok(!iStart.params.materials.fromCanonical, 'initial integrate is from the snapshot');
  // Canonical worktree prepared BEFORE the attempt launches.
  const prep = runtime._calls.find((c) => c.m === 'canonicalPrepare');
  assert.ok(prep, 'canonical.prepare ran before the integrator attempt');
  assert.equal(prep.params.snapshotSha, run.baseCommit);
  // The durable launch inputs bind the WO + source docs — nothing else.
  const integAtt = run.attempts.find((a) => a.role === 'integrator');
  const iIn = new Map(integAtt.launch.inputs.map((i) => [i.name, i.sha256]));
  assert.equal(iIn.get('work-order'), wo.sha256);
  assert.equal(iIn.get('task'), run.fusion.snapshot.task.sha256);
  assert.equal(iIn.get('requirements'), run.inputs.requirements.sha256);
  assert.equal(iIn.get('plan'), run.inputs.plan.sha256);

  // Attempt completes → report bound → import → materialize →
  // record_integrate_result → 'awaiting_validation' rides the U5 gate.
  run = await driveUntil(svc, sched, runId,
    (r) => r.phase === 'awaiting_validation' || r.status === 'awaiting_acceptance');
  assert.equal(run.fusion.integrate.import.attemptId, integAtt.id);
  assert.ok(run.fusion.integrate.import.commitSha);
  assert.equal(run.fusion.integratorReport.attemptId, integAtt.id);
  assert.equal(run.fusion.integratorReport.behaviorChange, false);

  // The import REALLY landed in the bound workspace: new + modified +
  // deleted files — content-verified, not status-claimed.
  const card1 = await getCard(svc, 'card-a');
  const ws = card1.json.workspaces[run.workspaceId];
  assert.ok(ws && ws.path, 'bound workspace exists');
  const nm = await fs.readFile(join(ws.path, 'src', 'new-module.js'), 'utf-8');
  assert.equal(nm, 'export const nm = 42;\n');
  const a = await fs.readFile(join(ws.path, 'src', 'a.js'), 'utf-8');
  assert.ok(a.includes('new-module.js'));
  await assert.rejects(fs.stat(join(ws.path, 'src', 'b.js')), /ENOENT/,
    'deleted file is gone from the materialized workspace');
  // Canonical HEAD carries the import commit.
  const canonId = `canon-${runId.slice(4)}`;
  const cst = await runtime.canonicalStatus(canonId);
  assert.equal(cst.canonical.headSha, run.fusion.integrate.import.commitSha);
  assert.equal(git(cst.canonical.worktree, 'rev-parse', 'HEAD'), run.fusion.integrate.import.commitSha);

  // The U5 gate: checks (test -f src/new-module.js) + reviewer + checker
  // evidence → awaiting_acceptance with a recorded result hash.
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'awaiting_acceptance' || r.status === 'blocked'
      || r.status === 'failed', { maxTicks: 80 });
  assert.equal(run.status, 'awaiting_acceptance',
    `gate must park for acceptance — run=${J({ s: run.status, e: run.error, v: run.validation?.status, ph: run.validation?.phase })}`);
  assert.ok(run.acceptance?.resultSha256, 'acceptance binds a result hash');
  const val1 = run.validationHistory?.[0] ?? run.validation;
  assert.ok(val1, 'validation round recorded');
  assert.equal(run.round, 1);
  // Reviewer/checker attempts produced durable evidence artifacts.
  const roleAtts = run.attempts.filter((a) => ['reviewer', 'checker'].includes(a.role));
  assert.equal(roleAtts.length, 2, 'one reviewer + one checker attempt');
  for (const ra of roleAtts) {
    assert.equal(ra.status, 'completed');
    assert.equal(ra.validationId, val1.id);
  }
  const arts = Object.values(run.artifacts ?? {});
  assert.ok(arts.some((x) => x.kind === 'evidence' && x.file === FINDINGS_FILE),
    'findings artifact committed');
  assert.ok(arts.some((x) => x.kind === 'evidence' && x.file === VERDICTS_FILE),
    'verdicts artifact committed');
  assert.ok(arts.some((x) => x.kind === 'evidence' && x.file === 'result-manifest.json'),
    'result manifest committed');

  // A NEW EDIT after the checks annuls readiness — the parked acceptance
  // is void and the run re-verifies (same U5 rule as a solo run).
  await fs.writeFile(join(ws.path, 'src', 'sneaky.js'), 'export const s = 1;\n');
  git(ws.path, 'add', '-A');
  git(ws.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'sneaky');
  run = await driveUntil(svc, sched, runId,
    (r) => r.status !== 'awaiting_acceptance' || !r.acceptance);
  assert.equal(run.status, 'active');
  assert.ok(['awaiting_validation', 'verify', 'review', 'check_review']
    .includes(run.phase), `re-verification re-entered the gate — ${J(run.phase)}`);
  assert.ok(!run.acceptance, 'the drifted acceptance is annulled');
  const evs2 = await eventsOf(svc, runId);
  assert.ok(evs2.some((e) => e.type === 'acceptance_annulled'),
    'durable acceptance_annulled event recorded');

  // Re-validation covers the EDITED tree: round 2 runs a fresh snapshot —
  // and since the new file fails no check, it parks again for acceptance
  // with a DIFFERENT result hash (proof the new content was reviewed).
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'awaiting_acceptance' || r.status === 'failed'
      || r.status === 'blocked', { maxTicks: 80 });
  assert.equal(run.status, 'awaiting_acceptance',
    `re-verification parks again — ${J({ s: run.status, e: run.error, v: run.validation?.status })}`);
  const sha2 = run.acceptance.resultSha256;
  assert.notEqual(sha2, run.rounds[0].resultSha256,
    'the second acceptance binds the drifted tree, not the old hash');
  assert.equal(run.round, 2);
  assert.equal(run.rounds.length, 2);

  // User acceptance of EXACTLY the recorded hash succeeds.
  const card2 = await getCard(svc, 'card-a');
  const acc = await cmd(svc, 'card-a', {
    commandId: `ac-${randomUUID().slice(0, 6)}`, type: 'accept_result',
    expectedControlRevision: card2.json.controlRevision,
    payload: { runId, resultSha256: sha2 },
  });
  assert.equal(acc.status, 200, J(acc.json));
  run = await runView(svc, runId);
  assert.equal(run.status, 'succeeded');
});

// ==========================================================================
// 3. Input drift: in_plan verdict parks for approval of the CURRENT version
// ==========================================================================

test('input change requires approval of exactly the current work-order version', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { req1 } = await seedImplCard(svc);
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const spec = implSpec(svc, req1);
  spec.panelists = p;
  const runId = await mustStartFusion(svc, 'card-a', spec);
  // Judge hangs on n1 — the input change lands while the judge is "working".
  const { sched, runtime } = mkSched(env, {
    behaviors: {
      [`ja-${runId.slice(4)}-n1`]: { hang: true },
      'ia-': { runMs: 4, finalText: makeReport({}), edits: { write: { 'src/new-module.js': 'export {};\n' } } },
      default: { runMs: 4, finalText: makeAnswer('x') },
    },
    roleDocs: {
      'acp-reviewer': (_p, round) => ({ version: 1, round, findings: [] }),
      'acp-checker': (_p, round) => ({ version: 1, round, verdicts: [] }),
    },
  });

  await sched.tick(); await sched.tick();
  let run = await driveUntil(svc, sched, runId,
    (r) => (r.attempts || []).some((a) => a.role === 'judge' && a.porchRunId));
  // Requirements drift mid-run: a new version approved while the judge runs.
  const req2 = await attachDoc(svc, 'card-a', 'requirements', '# Requirements v2\n\nBigger scope.\n');
  await approve(svc, 'card-a', 'approve_requirements', req2);
  // The run never restarts: it finishes the judge on the ORIGINAL inputs
  // and parks for approval of exactly wo_v1.
  const jRun = [...runtime._runs.values()].find((r) => r.attemptId.startsWith('ja-'));
  assert.ok(jRun, 'judge porch run registered');
  runtime._finish(jRun.runId, {
    status: 'completed', exitCode: 0, finalText: makeWorkOrder('in_plan'),
  });
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && (r.fusion?.pendingActions || []).length > 0);
  const wo = run.fusion.workOrders[0];
  assert.equal(wo.decision.routed, 'user');
  assert.equal(wo.decision.reason, 'inputs_changed',
    `verdict was in_plan but inputs drifted — ${J(wo.decision)}`);
  assert.equal(run.fusion.pendingActions[0].reason, 'inputs_changed');
  // The run does NOT integrate automatically.
  assert.ok(!run.fusion.integrate?.auto);

  // Hash-mismatch approval refuses; the EXACT current version approves
  // and routes to the integrator.
  const card = await getCard(svc, 'card-a');
  let r = await cmd(svc, 'card-a', {
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, versionId: wo.versionId, sha256: 'f'.repeat(64) },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'hash_mismatch');
  const card2 = await getCard(svc, 'card-a');
  r = await cmd(svc, 'card-a', {
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card2.json.controlRevision,
    payload: { runId, versionId: wo.versionId, sha256: wo.sha256 },
  });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(run.status, 'active');
  assert.equal(run.phase, 'integrate');
  assert.equal(run.fusion.integrate.auto, false, 'explicit approval, not auto-route');
  assert.equal(run.fusion.workOrder.reason, 'inputs_changed');

  // The integrator now runs on the recorded work order and reports.
  run = await driveUntil(svc, sched, runId,
    (r) => r.phase === 'awaiting_validation' || r.status === 'awaiting_acceptance'
      || ['failed', 'blocked'].includes(r.status), { maxTicks: 80 });
  assert.ok(['awaiting_validation', 'awaiting_acceptance'].includes(run.phase)
      || run.status === 'awaiting_acceptance',
    `post-approval integrate must reach the gate — ${J({ s: run.status, ph: run.phase, e: run.error })}`);
});

// ==========================================================================
// 4. scope_change verdict never auto-routes
// ==========================================================================

test('scope_change verdict parks for explicit approval; integrator isolation enforced at mint', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { req1 } = await seedImplCard(svc);
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const spec = implSpec(svc, req1);
  spec.panelists = p;
  const runId = await mustStartFusion(svc, 'card-a', spec);
  const { sched, runtime, instanceId } = mkSched(env, { behaviors: {
    'ja-': { runMs: 4, finalText: makeWorkOrder('scope_change') },
    default: { runMs: 4, finalText: makeAnswer('x') },
  } });
  await sched.tick(); await sched.tick();
  let run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && (r.fusion?.workOrders || []).length === 1);
  const wo = run.fusion.workOrders[0];
  assert.equal(wo.verdict, 'scope_change');
  assert.equal(wo.decision.routed, 'user');
  assert.equal(wo.decision.reason, 'scope_change');
  assert.equal(run.phase, 'judge', 'a scope-change verdict never reaches integrate');
  assert.equal(run.fusion.pendingActions[0].reason, 'scope_change');

  // Direct integrate_begin without approval → work_order_unapproved.
  const attId = `ia-${runId.slice(4)}-n1`;
  const fakeLaunch = {
    profileId: 'prof-model-integrator',
    profileDigest: run.fusion.integrator.profileDigest,
    promptSha256: 'a'.repeat(64), materialsSha256: 'b'.repeat(64),
    cwd: '/work/project', artifactsDir: '/work/attempt', attemptDir: '/work/attempt',
    inputs: [
      { name: 'task', sha256: run.fusion.snapshot.task.sha256 },
      { name: 'work-order', sha256: wo.sha256 },
      { name: 'requirements', sha256: run.inputs.requirements.sha256 },
      { name: 'plan', sha256: run.inputs.plan.sha256 },
    ],
    canonicalId: `canon-${runId.slice(4)}`,
    workerId: `w-${attId}`,
  };
  let r = await internalCmd(env, 'card-a', {
    commandId: `ib-${randomUUID().slice(0, 6)}`, type: 'integrate_begin',
    payload: {
      runId, attemptId: attId, launch: fakeLaunch, fix: false,
      workOrder: { versionId: wo.versionId, sha256: wo.sha256 },
      runnerId: 'host-runner', instanceId, pid: 4242, leaseMs: 60000,
    },
  });
  assert.equal(r.status, 409, J(r.json));
  assert.ok(['work_order_unapproved', 'phase_mismatch', 'not_panel_owner', 'run_not_launchable'].includes(r.json.code),
    `unapproved integrate refused — ${J(r.json)}`);

  // Panel-evidence boundary: an input whose sha equals a panelist's
  // committed artifact is refused by NAME — panel evidence can never be
  // smuggled past the declared-input check.
  const panelSha = Object.values(run.artifacts ?? {})
    .find((a) => a.kind === 'answer')?.sha256;
  assert.ok(panelSha, 'panel answer artifact recorded');
  const evilLaunch = structuredClone(fakeLaunch);
  evilLaunch.inputs = [
    { name: 'task', sha256: run.fusion.snapshot.task.sha256 },
    { name: 'work-order', sha256: wo.sha256 },
    { name: 'requirements', sha256: run.inputs.requirements.sha256 },
    { name: 'plan', sha256: run.inputs.plan.sha256 },
    // The smuggle: 'results' is unbound by the domain — but its declared
    // bytes hash to a PANEL artifact. The blocklist refuses it by hash.
    { name: 'results', sha256: panelSha },
  ];
  const card3 = await getCard(svc, 'card-a');
  r = await cmd(svc, 'card-a', {  // approve the WO first so the input check runs
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card3.json.controlRevision,
    payload: { runId, versionId: wo.versionId, sha256: wo.sha256 },
  });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(run.phase, 'integrate');
  // The handoff driver will mint its own integrator attempt next tick —
  // stop it from launching by keeping the driver from running (no more
  // ticks of THIS sched); fire the forged internal command instead.
  r = await internalCmd(env, 'card-a', {
    commandId: `ib-${randomUUID().slice(0, 6)}`, type: 'integrate_begin',
    payload: {
      runId, attemptId: `ia-forged-${randomUUID().slice(0, 4)}`,
      launch: evilLaunch, fix: false,
      workOrder: { versionId: wo.versionId, sha256: wo.sha256 },
      runnerId: 'host-runner', instanceId, pid: 4242, leaseMs: 60000,
    },
  });
  assert.ok(r.status !== 200, 'forged integrate_begin must refuse');
  assert.equal(r.json.code, 'panel_evidence_forbidden', J(r.json));
});

// ==========================================================================
// 5. Behavior change declared → blocks before validation
// ==========================================================================

test('integrator behavior_change blocks the run for approval before validation', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { req1 } = await seedImplCard(svc);
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const spec = implSpec(svc, req1);
  spec.panelists = p;
  const runId = await mustStartFusion(svc, 'card-a', spec);
  const { sched, runtime } = mkSched(env, {
    behaviors: {
      'ja-': { runMs: 4, finalText: makeWorkOrder('in_plan') },
      'ia-': {
        runMs: 4,
        finalText: makeReport({ behaviorChange: true, mismatches: ['a.js shape differed'] }),
        edits: { write: { 'src/new-module.js': 'export const nm = 1;\n' } },
      },
      default: { runMs: 4, finalText: makeAnswer('x') },
    },
    roleDocs: {
      'acp-reviewer': (_p, round) => ({ version: 1, round, findings: [] }),
      'acp-checker': (_p, round) => ({ version: 1, round, verdicts: [] }),
    },
  });
  await sched.tick(); await sched.tick();
  // Drive through integrate + import — the behavior change parks the run
  // BEFORE validation starts.
  let run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' || r.status === 'awaiting_acceptance'
      || r.status === 'failed');
  assert.equal(run.status, 'blocked',
    `declared behavior change must block — ${J({ s: run.status, ph: run.phase })}`);
  assert.equal(run.fusion.integratorReport.behaviorChange, true);
  const pa = run.fusion.pendingActions.find((x) => x.type === 'work_order_approval');
  assert.ok(pa && pa.reason === 'behavior_change', J(run.fusion.pendingActions));
  assert.equal(pa.versionId, 'wo_v1');
  assert.ok(!run.validation || run.validation.status !== 'active',
    'validation never started while blocked');

  // Approval of exactly the current WO resumes into awaiting_validation.
  const wo = run.fusion.workOrders[0];
  const card = await getCard(svc, 'card-a');
  const r = await cmd(svc, 'card-a', {
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, versionId: wo.versionId, sha256: wo.sha256 },
  });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(run.phase, 'awaiting_validation');
  // Gate then runs to acceptance.
  run = await driveUntil(svc, sched, runId,
    (x) => x.status === 'awaiting_acceptance' || ['failed', 'blocked'].includes(x.status),
    { maxTicks: 80 });
  assert.equal(run.status, 'awaiting_acceptance',
    J({ s: run.status, ph: run.phase, e: run.error,
      vph: run.validation?.phase, reps: run.validation?.reports,
      ev: (await eventsOf(svc, runId)).slice(-12).map((x) => `${x.type}:${x.data?.code ?? ''}:${typeof x.data?.detail === 'string' ? x.data.detail.slice(0, 60) : ''}`),
      atts: run.attempts?.map((a) => ({ id: a.id, st: a.status, err: a.error, prid: a.porchRunId })) }));
});

// ==========================================================================
// 6. Fix round: failed gate → integrator fix from canonical → re-validation
// ==========================================================================

test('fix round: gate failure launches an integrator fix from canonical HEAD and re-validates', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { req1 } = await seedImplCard(svc, {
    checks: [{ run: 'test -f src/new-module.js', timeoutSec: 30 }],
  });
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const spec = implSpec(svc, req1);
  spec.panelists = p;
  const runId = await mustStartFusion(svc, 'card-a', spec);
  // Round 1: reviewer finds a critical issue; checker confirms → fix.
  // Round 2 (fix): empty findings → awaiting_acceptance.
  const { sched, runtime } = mkSched(env, {
    behaviors: {
      'ja-': { runMs: 4, finalText: makeWorkOrder('in_plan') },
      'ia-': {
        runMs: 4,
        finalText: makeReport({}),
        edits: { write: { 'src/new-module.js': 'export const nm = 7;\n' } },
      },
      default: { runMs: 4, finalText: makeAnswer('x') },
    },
    roleDocs: {
      'acp-reviewer': (_p, round) => (round === 1
        ? { version: 1, round, findings: [{ id: 'f1', round, severity: 'critical', status: 'open', text: 'module missing edge case', where: 'src/new-module.js' }] }
        : { version: 1, round, findings: [] }),
      'acp-checker': (_p, round) => (round === 1
        ? { version: 1, round, verdicts: [{ findingId: 'f1', verdict: 'confirmed', round }] }
        : { version: 1, round, verdicts: [] }),
    },
  });
  await sched.tick(); await sched.tick();
  // Drive until the first gate closes — the fix decision writes fixContext.
  let run = await driveUntil(svc, sched, runId,
    (r) => !!r.fixContext || r.status === 'awaiting_acceptance'
      || ['failed', 'blocked'].includes(r.status), { maxTicks: 90 });
  assert.ok(run.fixContext, `gate fix decision expected — ${J({ s: run.status, ph: run.phase, r: run.round, v: run.validation?.status })}`);
  assert.equal(run.fixContext.round, 1);
  assert.equal(run.fixContext.openFindings[0].id, 'f1');
  // Next tick(s): the integrator fix attempt launches from canonical HEAD.
  run = await driveUntil(svc, sched, runId,
    (r) => (r.attempts || []).some((a) => a.role === 'integrator' && a.fix === 1));
  const fxAtt = run.attempts.find((a) => a.role === 'integrator' && a.fix === 1);
  assert.ok(fxAtt, 'integrator fix attempt minted for round 1');
  assert.equal(fxAtt.phase, 'integrate');
  const fxStart = startsCalls(runtime).find((c) => c.params.attemptId === fxAtt.id);
  assert.equal(fxStart.params.materials.fromCanonical, true,
    'fix attempt rebuilds the private repo from canonical HEAD');
  const fxInputs = fxStart.params.materials.inputs.map((i) => i.name).sort();
  assert.ok(fxInputs.includes('results'), 'fix attempt receives the prior results bundle');
  const resInput = fxStart.params.materials.inputs.find((i) => i.name === 'results');
  assert.ok(resInput.content.includes('f1') || resInput.content.includes('critical'),
    'results bundle carries the gate evidence');
  assert.deepEqual(run.fusion.fixAttempts, [1]);

  // The fix attempt finishes → import → re-validation → round 2 gate.
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'awaiting_acceptance' || ['failed', 'blocked'].includes(r.status),
    { maxTicks: 90 });
  assert.equal(run.status, 'awaiting_acceptance',
    `round 2 parks for acceptance — ${J({
      s: run.status, e: run.error, ph: run.phase,
      vid: run.validation?.id, vph: run.validation?.phase, v: run.validation?.status,
      rounds: run.rounds?.map((r) => ({ r: r.round, d: r.decision })),
      acc: run.acceptance, diag: run.diagnostic, fx: !!run.fixContext,
      ev: (await eventsOf(svc, runId)).slice(-14).map((x) => x.type),
      atts: run.attempts?.map((a) => ({ id: a.id.slice(0, 14), st: a.status, fx: a.fix })),
      vh: (run.validationHistory || []).map((x) => ({ id: x.id, st: x.status, d: x.decision })),
    })}`);
  assert.equal(run.round, 2);
  assert.equal(run.rounds[0].decision, 'fix');
  assert.equal(run.rounds[1].decision, 'awaiting_acceptance');
  // The fix import kept the canonical state (the new module is still there).
  const card = await getCard(svc, 'card-a');
  const ws = card.json.workspaces[run.workspaceId];
  assert.equal(await fs.readFile(join(ws.path, 'src', 'new-module.js'), 'utf-8'),
    'export const nm = 7;\n', 'fix round materialized the fixed tree');
  // Accept the result.
  const acc = await cmd(svc, 'card-a', {
    commandId: `ac-${randomUUID().slice(0, 6)}`, type: 'accept_result',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, resultSha256: run.acceptance.resultSha256 },
  });
  assert.equal(acc.status, 200, J(acc.json));
});

// ==========================================================================
// 7. Durable-write→launch crash windows on the F3 handoff path
// ==========================================================================

test('handshake crashes: dropped judge start reissues; lost integrator bind reconciles from the record', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { req1 } = await seedImplCard(svc);
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const spec = implSpec(svc, req1);
  spec.panelists = p;
  const runId = await mustStartFusion(svc, 'card-a', spec);
  const behaviors = {
    // n1 judge: launch record never reached the controller — reconcile
    // re-issues the SAME attempt's start (no duplicate mint).
    [`ja-${runId.slice(4)}-n1`]: { dropStart: true },
    'ja-': { runMs: 4, finalText: makeWorkOrder('in_plan') },
    // Integrator: record lands + run registers, but the response is lost —
    // the next tick binds porchRunId from the durable record.
    'ia-': {
      lostBind: true, runMs: 30,
      finalText: makeReport({}),
      edits: { write: { 'src/new-module.js': 'export {};\n' } },
    },
    default: { runMs: 4, finalText: makeAnswer('x') },
  };
  const { sched, runtime } = mkSched(env, {
    behaviors,
    roleDocs: {
      'acp-reviewer': (_p, round) => ({ version: 1, round, findings: [] }),
      'acp-checker': (_p, round) => ({ version: 1, round, verdicts: [] }),
    },
  });
  await sched.tick(); await sched.tick();
  // dropStart: first drive records ja- attempt 'launching' + start returns
  // launch_uncertain with NO record — the NEXT tick's reconcile must
  // re-issue runtime.start for the SAME attemptId (never a second mint).
  let run = await driveUntil(svc, sched, runId,
    (r) => (r.attempts || []).some((a) => a.role === 'judge')
      && startsCalls(runtime).some((c) => String(c.params.attemptId).startsWith('ja-')));
  behaviors[`ja-${runId.slice(4)}-n1`] = { runMs: 4, finalText: makeWorkOrder('in_plan') };
  run = await driveUntil(svc, sched, runId,
    (r) => r.phase === 'integrate' || (r.fusion?.workOrders || []).length === 1);
  const jAtts = run.attempts.filter((a) => a.role === 'judge');
  assert.equal(jAtts.length, 1,
    'exactly ONE judge attempt exists — the crash never minted a duplicate');
  assert.equal(jAtts[0].status, 'completed');
  const jStarts = startsCalls(runtime).filter(
    (c) => c.params.attemptId === jAtts[0].id);
  assert.ok(jStarts.length >= 2,
    `the same attempt was re-launched after the lost start (got ${jStarts.length})`);
  assert.equal(run.fusion.workOrders.length, 1);

  // Integrator lost-bind: attempt binds porchRunId via reconcile, not via
  // the launch response.
  run = await driveUntil(svc, sched, runId,
    (r) => {
      const i = (r.attempts || []).find((a) => a.role === 'integrator');
      return i && i.porchRunId;
    });
  const iAtt = run.attempts.find((a) => a.role === 'integrator');
  assert.ok(iAtt.porchRunId, 'integrator bound after lost handshake');
  const iStarts = startsCalls(runtime).filter(
    (c) => c.params.attemptId === iAtt.id);
  assert.equal(iStarts.length, 1,
    'the lost-bind attempt was started exactly once — bound from the record');

  // Drive to the gate to prove the recovered attempt produces real work.
  run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'awaiting_acceptance' || ['failed', 'blocked'].includes(r.status),
    { maxTicks: 90 });
  assert.equal(run.status, 'awaiting_acceptance', J({ s: run.status, e: run.error }));
});

test('handoff orphan gate fails closed: only explicit gone:true resolves launch_orphaned', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  const { req1 } = await seedImplCard(svc);
  const p = await mkPanelists(
    fusionProfile('model-a'), fusionProfile('model-b'), fusionProfile('model-c'));
  const spec = implSpec(svc, req1);
  spec.panelists = p;
  const runId = await mustStartFusion(svc, 'card-a', spec);
  const j1 = `ja-${runId.slice(4)}-n1`;
  const j2 = `ja-${runId.slice(4)}-n2`;
  const behaviors = {
    // Judge n1: the record is stuck at 'launching' past the orphan age
    // bound and reconcile finds no run — but the worker rows carry only
    // incomplete `gone` evidence (null + missing). That is NOT absence.
    [j1]: { stuckLaunch: true,
      scan: { workers: [
        { workerId: `w-${j1}`, state: 'gone', gone: null },
        { workerId: `w-${j1}-extra`, state: 'unknown' },
      ] } },
    [j2]: { runMs: 4, finalText: makeWorkOrder('in_plan') },
    default: { runMs: 4, finalText: makeAnswer('x') },
  };
  const { sched, runtime } = mkSched(env, { behaviors });
  await sched.tick(); await sched.tick();
  let run = await driveUntil(svc, sched, runId,
    (r) => r.phase === 'judge' && (r.attempts || []).some((a) => a.role === 'judge'));
  const jAtt = run.attempts.find((a) => a.role === 'judge');
  assert.equal(jAtt.id, j1);
  assert.equal(jAtt.status, 'launching');

  // Stale record + null `gone`: several reconcile passes must NEVER resolve
  // the attempt as orphaned — incomplete evidence is not proof of absence.
  for (let i = 0; i < 3; i += 1) await sched.tick();
  run = await runView(svc, runId);
  assert.equal(run.attempts.find((a) => a.id === j1).status, 'launching',
    'gone:null must not count as positive absence evidence');
  assert.equal(
    startsCalls(runtime).filter((c) => c.params.attemptId === j1).length, 1,
    'the recorded attempt is never re-launched');

  // Positive proof (gone === true): the SAME attempt resolves orphaned on
  // the next pass — the gate still works when the evidence is real.
  behaviors[j1].scan.workers = [{ workerId: `w-${j1}`, state: 'gone', gone: true }];
  run = await driveUntil(svc, sched, runId,
    (r) => (r.attempts || []).find((a) => a.id === j1)?.status === 'failed');
  run = await runView(svc, runId);
  assert.match(run.attempts.find((a) => a.id === j1).error ?? '', /orphaned/);

  // The judge budget mints exactly one replacement attempt — it completes
  // and the work order lands; the fail-closed gate broke nothing else.
  run = await driveUntil(svc, sched, runId,
    (r) => (r.fusion?.workOrders || []).length === 1, { maxTicks: 90 });
  const jAtts = run.attempts.filter((a) => a.role === 'judge');
  assert.equal(jAtts.length, 2, 'exactly one replacement judge attempt within budget');
  assert.equal(jAtts[1].status, 'completed', J(jAtts[1]));
  assert.equal(run.fusion.workOrders.length, 1, J(run.fusion.workOrders));
});

// ==========================================================================
// 8. Comparison-only guard: judge contract unit coverage
// ==========================================================================

test('contract: comparison-only outputs fail the work-order contract; reports parse', () => {
  // Pure contract coverage — the same parse the domain re-runs on the
  // committed artifact bytes.
  const cmp = parseWorkOrder('## Matches\n\nAll answers agree.\n\n## Contradictions\n\nNone.\n');
  assert.equal(cmp.ok, false);
  assert.ok(cmp.missing.includes('goal') && cmp.missing.includes('verdict'));
  const empty = parseWorkOrder('');
  assert.equal(empty.ok, false);
  const bad = parseWorkOrder(makeWorkOrder('maybe'));
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' '), /verdict/);
  const dup = parseWorkOrder(makeWorkOrder('in_plan') + '\n## Matches\n\nAgain.\n');
  assert.equal(dup.ok, false);
  assert.ok(dup.duplicate.includes('matches'));
  const noCrit = parseWorkOrder(
    makeWorkOrder('in_plan').replace(/every criteria item[^`]+/, 'x'));
  const good = parseWorkOrder(makeWorkOrder('in_plan'));
  assert.equal(good.ok, true, J(good));
  assert.equal(good.verdict, 'in_plan');
  assert.equal(good.steps.length, 2);
  assert.equal(good.criteria.length, 2);
  assert.equal(parseWorkOrder(good ? makeWorkOrder('scope_change') : '').verdict, 'scope_change');
  const rep = parseIntegratorReport(makeReport({ behaviorChange: true }));
  assert.equal(rep.ok, true);
  assert.equal(rep.behaviorChange, true);
  const repNo = parseIntegratorReport(makeReport({}));
  assert.equal(repNo.behaviorChange, false);
  assert.deepEqual(repNo.mismatches, []);
  const repBad = parseIntegratorReport('## Changes\n\nx\n## Mismatches\n\n(none)\n## Behavior change\n\nmaybe\n');
  assert.equal(repBad.ok, false);
  // Real integrators answer as a list item — a leading bullet must not
  // defeat the yes/no first-word contract (F4 window 194dd490 e2e).
  const repBullet = parseIntegratorReport(makeReport({}).replace(
    '## Behavior change\n\nno —', '## Behavior change\n\n- no —'));
  assert.equal(repBullet.ok, true, J(repBullet));
  assert.equal(repBullet.behaviorChange, false);
  const repBulletYes = parseIntegratorReport(makeReport({ behaviorChange: true })
    .replace('## Behavior change\n\nyes —', '## Behavior change\n\n- yes —'));
  assert.equal(repBulletYes.ok, true, J(repBulletYes));
  assert.equal(repBulletYes.behaviorChange, true);
  // The judge-facing bundle: accepted only, exclusions metadata-only.
  const bundle = buildAnswersBundle({
    participants: [{ id: 'p1', model: 'm1' }, { id: 'p2', model: 'm2' }],
    answers: new Map([['p1', 'AAA'], ['p2', 'BBB']]),
    exclusions: [{ participantId: 'p3', model: 'm3', reason: 'kept failing', by: 'user', at: 1 }],
  });
  assert.ok(bundle.includes('AAA') && bundle.includes('BBB'));
  assert.ok(bundle.includes('p3') && bundle.includes('kept failing'));
  assert.ok(!bundle.includes('## Participant p3'), 'excluded participants contribute no answer body');
});
