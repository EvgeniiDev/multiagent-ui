// server/execution/fake-runtime.mjs — deterministic in-memory backend.
//
// Same surface as createPorchRuntime so the controller (U3+) can be
// exercised without porch, processes, or model calls. Behavior is scripted
// per attempt/profile; defaults complete immediately. Import-safe: no fs,
// no timers until start() is called.
//
// Fault-injection seams mirror the process backend faithfully rather than
// shortcutting it:
//   * options.registry — shared registry across several runtime objects,
//     modelling two scheduler processes/containers over one steer store.
//     {runs, records, usedAttempts, procs, unreadable, listFails, seq}
//   * registry.records — per-attempt launch records in the SAME shapes the
//     porch backend leaves on disk (phase, spawned, launcher, diagnostics),
//     so reconcile/recovery tests go through runtime.launchRecord().
//   * registry.procs — the fake /proc table: pid -> {exists, state,
//     starttime, pidNs, readable}. Missing entry = clean ENOENT.
//   * registry.unreadable — injected unreadable registry entries that make
//     any scan incomplete.
//   * options.environment — overrides for environment() (pidNs/bootId/uid
//     etc.) to model a foreign container over the shared registry.
//   * behavior.launch — 'ok' | 'fail' | 'uncertain' | 'pre_spawn_fail' |
//     'throw'; 'throw' leaves the record at phase 'launching' (controller
//     died mid-handshake) and raises.
//   * behavior.launcherAlive — whether the fake launcher stays live in the
//     procs table after start() returns (default true for 'uncertain',
//     false otherwise).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RuntimeError, errResult, assertSafeId, assertRunId, normPath, RUN_ID_RE,
} from './common.mjs';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const DEFAULT_BEHAVIOR = {
  launch: 'ok',              // 'ok' | 'fail' | 'uncertain' | 'pre_spawn_fail' | 'throw'
  launchError: 'fake launch refused',
  launcherAlive: null,       // null -> derived from launch kind
  outcome: 'completed',      // 'completed' | 'failed' | 'never'
  delayMs: 5,                // time until outcome applies
  finalText: 'fake result',
  error: null,
  exitCode: null,            // defaults derived from outcome
  events: null,              // extra scripted events appended after start
  onCancel: 'cancel',        // 'cancel' | 'ignore'
};

function freshRegistry() {
  return {
    runs: new Map(),
    records: new Map(),
    usedAttempts: new Set(),
    procs: new Map(),
    unreadable: [],
    listFails: 0,
    seq: 0,
  };
}

export function createFakeRuntime(options = {}) {
  const behaviors = options.behaviors || {};
  const rootDir = options.rootDir || path.join(os.tmpdir(), 'fake-exec');
  const namespace = options.namespace || 'fake';
  const registry = options.registry || freshRegistry();
  const runs = registry.runs;
  const usedAttempts = registry.usedAttempts;
  const envOverride = options.environment || null;
  const calls = [];
  const logCall = (m, extra = {}) => calls.push({ m, ...extra });

  // The fake /proc table must reflect the pid this runtime claims as its own
  // controller process: a real process in a pid namespace always observes
  // ITSELF live in /proc. environment() reports options.environment.pid or
  // the real process.pid — without the row, a same-env peer scheduler in the
  // same test process reads the recorded owner pid as ENOENT and adopts live
  // foreign work on a false process_dead proof. The seed mirrors the exact
  // recorded identity (pidStarttime/pidNs from environment()) so probes
  // classify 'alive', and it NEVER overwrites an existing row — a scripted
  // death/`exists` entry stays authoritative. Suites that model distinct
  // processes keep passing explicit per-instance pids (u4/u5 convention);
  // this row is the own-process truth every real /proc carries anyway.
  {
    const e = environment();
    if (Number.isInteger(e.pid) && e.pid > 0 && !registry.procs.has(e.pid)) {
      registry.procs.set(e.pid, {
        exists: true, state: 'R', readable: true,
        starttime: e.pidStarttime ?? null, pidNs: e.pidNs ?? null,
      });
    }
  }

  function nextSeq() { registry.seq += 1; return registry.seq; }

  function behaviorFor(p) {
    return {
      ...DEFAULT_BEHAVIOR,
      ...(behaviors.default || {}),
      ...(behaviors.byProfile?.[p.profileId] || {}),
      ...(behaviors.byAttempt?.[p.attemptId] || {}),
    };
  }

  function pushEvent(run, type, data = '') {
    run.events.push({ ts: new Date().toISOString(), type, agent_id: run.profileId, data });
  }

  function setStatus(run, status, { exitCode = null, error = null } = {}) {
    // Terminal states are immutable: a pending outcome timer or a second
    // transition must never resurrect or rewrite a finished run.
    if (TERMINAL_STATUSES.has(run.status)) return;
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    run.status = status;
    run.exitCode = exitCode;
    run.error = error;
    run.finishedAt = new Date().toISOString();
    pushEvent(run, `run_${status}`, error || '');
    if (TERMINAL_STATUSES.has(status)) {
      // A finished run's supervisor (and scripted child) exits — the procs
      // table reflects reality so the terminal-proof gate sees real death,
      // not a zombie-free terminal status. Tests that need a STUCK or
      // detached-alive supervisor re-arm the pid via _setProc.
      run.pidAlive = false;
      const p = registry.procs.get(run.pid);
      if (p) registry.procs.set(run.pid, { ...p, exists: false });
      if (run.childPid != null) {
        const c = registry.procs.get(run.childPid);
        if (c) registry.procs.set(run.childPid, { ...c, exists: false });
      }
    }
    for (const waiter of run.waiters.splice(0)) waiter();
  }

  function scheduleOutcome(run, b) {
    if (b.outcome === 'never') return;
    run.timer = setTimeout(() => {
      run.timer = null;
      if (b.outcome === 'completed') {
        run.finalText = b.finalText;
        run.finalAvailable = b.finalText !== null;
        setStatus(run, 'completed', { exitCode: b.exitCode ?? 0 });
      } else {
        setStatus(run, 'failed', {
          exitCode: b.exitCode ?? 1,
          error: b.error || 'fake failure',
        });
      }
    }, Math.max(0, b.delayMs));
    // Ref'd: a scheduled run outcome is live work, like the real supervisor.
  }

  function environment() {
    return {
      namespace,
      backend: 'fake',
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      pid: process.pid,
      pidStarttime: 'fake-starttime',
      pidNs: 'fake-pidns',
      hostname: os.hostname(),
      bootId: 'fake-bootid',
      // envInstance is set below from overrides when absent — tests model a
      // recreated container by passing environment.containerId/initStarttime.
      containerId: envOverride?.containerId ?? 'fake-container',
      initStarttime: envOverride?.initStarttime ?? 'fake-init-1',
      platform: process.platform,
      node: process.version,
      rootDir, steerDir: null, outputDir: null,
      attemptsDir: path.join(rootDir, 'attempts'),
      porchPath: null,
      ...(envOverride || {}),
    };
  }

  // envInstance must reflect the envOverride when one is supplied.
  function envInstance() {
    const e = environment();
    return e.envInstance && typeof e.envInstance === 'object'
      ? e.envInstance
      : { containerId: e.containerId ?? null, initStarttime: e.initStarttime ?? null };
  }

  // Fake /proc probe. A pid absent from the table is a clean ENOENT;
  // {exists:null} models an EACCES-style unverifiable probe.
  function processIdentity(pid) {
    logCall('processIdentity', { pid });
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const p = registry.procs.get(pid);
    if (!p) {
      return { pid, exists: false, state: null, starttime: null,
        pidNs: null, readable: false, alive: false };
    }
    const exists = p.exists === undefined ? true : p.exists;
    const state = p.state ?? 'R';
    return {
      pid,
      exists,
      state,
      starttime: p.starttime ?? null,
      pidNs: p.pidNs !== undefined ? p.pidNs : environment().pidNs,
      readable: p.readable !== false,
      alive: exists === true && state !== 'Z',
    };
  }

  // A fake launcher pid + procs row. `alive` controls post-launch liveness.
  function spawnLauncher(alive) {
    const pid = 60000 + nextSeq();
    const starttime = `lt-${pid}`;
    registry.procs.set(pid, { exists: true, state: 'R', starttime });
    return { pid, starttime, pidNs: environment().pidNs,
      capturedAt: new Date().toISOString(), _alive: alive };
  }

  function retireLauncher(launcher, alive) {
    if (!launcher || !Number.isInteger(launcher.pid)) return;
    const cur = registry.procs.get(launcher.pid);
    if (!alive) registry.procs.set(launcher.pid, { exists: false });
    else if (cur) registry.procs.set(launcher.pid, { ...cur, exists: true });
  }

  async function start(params = {}) {
    const attemptId = assertSafeId('attemptId', params.attemptId);
    const profileId = assertSafeId('profileId', params.profileId);
    if (typeof params.cwd !== 'string' || !params.cwd.startsWith('/')) {
      throw new RuntimeError('invalid_argument', `cwd must be absolute: ${params.cwd}`);
    }
    // Same invariants as the process backend: an attempt id is consumed once
    // (real backend: exclusive mkdir), and a launch without an explicit
    // profile/model snapshot is refused.
    if (usedAttempts.has(attemptId)) {
      throw new RuntimeError('attempt_exists',
        `attempt already used: ${attemptId}`);
    }
    usedAttempts.add(attemptId);
    const b = behaviorFor(params);
    const attemptDir = path.join(rootDir, 'attempts', attemptId);
    const artifactsDir = path.join(attemptDir, 'artifacts');
    // Durable per-attempt record — same phases/markers the process backend
    // persists in launch.json, so recovery tests exercise the real read path.
    const rec = {
      schemaVersion: 1, attemptId, namespace, profileId,
      cwd: normPath(params.cwd), attemptDir, artifactsDir,
      phase: 'prepared', spawned: false,
      createdAt: new Date().toISOString(),
      environment: environment(),
      launcher: null, diagnostics: null,
      porchRunId: null, error: null,
    };
    registry.records.set(attemptId, rec);
    logCall('start', { attemptId, profileId, cwd: params.cwd, prompt: params.prompt });

    const base = {
      attemptId, attemptDir, artifactsDir,
      porchRunId: null,
      environment: rec.environment,
      launchRecord: attemptId,
      recordPersisted: true,
    };
    const failPreSpawn = (code, message) => {
      rec.phase = 'launch_failed';          // spawned stays false: proven
      rec.error = { code, message };        // pre-spawn rejection
      return { ...base, ok: false, phase: 'launch_failed',
        error: rec.error };
    };

    if (typeof params.prompt !== 'string' || !params.prompt.length) {
      if (!params.promptFile) {
        return failPreSpawn('invalid_argument', 'start requires prompt or promptFile');
      }
    }
    if (!params.config && !params.configPath) {
      return failPreSpawn('config_required',
        'start requires an explicit profile snapshot');
    }
    if (b.launch === 'pre_spawn_fail') {
      return failPreSpawn('cli_refused', b.launchError);
    }

    // From here the launcher exists: record phase 'launching' + launcher
    // identity exactly like the process backend's onSpawn hook.
    const launcherAlive = b.launcherAlive ?? (b.launch === 'uncertain' || b.launch === 'throw');
    const launcher = spawnLauncher(launcherAlive);
    delete launcher._alive;
    rec.phase = 'launching';
    rec.spawned = true;
    rec.launcher = launcher;

    if (b.launch === 'throw') {
      // Controller died mid-handshake: record stays 'launching', result is
      // never delivered. A run may still exist per uncertainRegisters.
      retireLauncher(launcher, launcherAlive);
      if (b.uncertainRegisters) {
        const runId = `run_fake-${nextSeq()}`;
        runs.set(runId, mkRun(runId, attemptId, profileId, params, artifactsDir, b));
      }
      throw new RuntimeError('controller_crash',
        'simulated controller death during launch handshake');
    }

    const runId = `run_fake-${nextSeq()}`;
    if (b.launch === 'uncertain') {
      const registered = b.uncertainRegisters !== false;
      if (registered) {
        const run = mkRun(runId, attemptId, profileId, params, artifactsDir, b);
        runs.set(runId, run);
        scheduleOutcome(run, b);
      }
      rec.phase = 'launch_uncertain';
      rec.diagnostics = { exitCode: null, signal: 'SIGKILL',
        timedOut: true, durationMs: 0 };
      rec.error = { code: 'launch_timeout', message: 'fake handshake timeout' };
      retireLauncher(launcher, launcherAlive);
      return { ...base, ok: false, phase: 'launch_uncertain',
        launcher: rec.launcher, diagnostics: rec.diagnostics,
        error: rec.error };
    }
    if (b.launch === 'fail') {
      rec.phase = 'launch_failed';   // observed nonzero exit => diagnostics
      rec.diagnostics = { exitCode: 1, signal: null, timedOut: false,
        durationMs: 0, stderrTail: b.launchError };
      rec.error = { code: 'cli_error', message: b.launchError };
      retireLauncher(launcher, launcherAlive);
      return { ...base, ok: false, phase: 'launch_failed',
        launcher: rec.launcher, diagnostics: rec.diagnostics,
        error: rec.error };
    }

    const run = mkRun(runId, attemptId, profileId, params, artifactsDir, b);
    runs.set(runId, run);
    pushEvent(run, 'run_started', `profile=${profileId}`);
    // Write the real session-log header — pi writes `{type:'session',id,...}`
    // first; the file exists from session start, byte-growth is genuine.
    if (run.sessionLog) {
      await fs.mkdir(path.dirname(run.sessionLog.path), { recursive: true });
      await fs.appendFile(run.sessionLog.path, JSON.stringify({
        type: 'session', id: `acp-${attemptId}`, cwd: run.cwd, timestamp: run.startedAt,
      }) + '\n').catch(() => {});
    }
    for (const ev of b.events || []) pushEvent(run, ev.type || 'progress', ev.data || '');
    scheduleOutcome(run, b);
    rec.phase = 'launched';
    rec.porchRunId = runId;
    rec.diagnostics = { exitCode: 0, signal: null, timedOut: false, durationMs: 0 };
    retireLauncher(launcher, launcherAlive);
    return { ...base, ok: true, phase: 'launched', porchRunId: runId,
      launcher: rec.launcher, diagnostics: rec.diagnostics };
  }

  function mkRun(runId, attemptId, profileId, params, artifactsDir, b) {
    const pid = 80000 + nextSeq();
    registry.procs.set(pid, { exists: true, readable: true, state: 'R', starttime: `st-${pid}` });
    // Optional scripted agent child — pid + own procs identity so the
    // terminal gate's recorded-child check can be exercised.
    let childPid = null;
    if (b.childPid !== undefined) {
      childPid = b.childPid;
      registry.procs.set(childPid, {
        exists: true, readable: true, state: 'R',
        starttime: `cst-${childPid}`, pidNs: environment().pidNs,
      });
    }
    return {
      runId, attemptId, profileId, cwd: params.cwd, artifactsDir,
      status: 'running', exitCode: null, error: null,
      startedAt: new Date().toISOString(), finishedAt: null,
      events: [], waiters: [], timer: null, onCancel: b.onCancel,
      finalText: null, finalAvailable: false, pid, childPid, pidAlive: true,
      // The bound Pi session jsonl — a real file under the fake's sessions
      // root (mirroring pi's --<cwd-slug>--/<ts>_acp-<id>.jsonl layout); the
      // stuck heuristic reads real byte-growth from it. b.sessionLog ===
      // 'absent' models a CLI that never created its log.
      sessionLog: b.sessionLog === 'absent' ? null : {
        path: path.join(
          rootDir, 'sessions', piSlug(params.cwd),
          `t-${runId}_acp-${attemptId}.jsonl`),
      },
      // Immutable spawn-time identity — the record's own evidence, immune to
      // later procs-table edits (a recycled pid never overwrites it).
      pidStarttime: `st-${pid}`, pidNs: environment().pidNs,
      // Immutable child spawn identity — same record-once contract.
      childStarttime: childPid != null ? `cst-${childPid}` : null,
      childPidNs: childPid != null ? environment().pidNs : null,
      // b.childSpawnedUndeclared emulates real porch: status omits
      // child_spawned entirely, so a null childPid attests NOTHING
      // (the codex meta.child_pid write race needs this to reproduce).
      childSpawnedUndeclared: b.childSpawnedUndeclared === true,
    };
  }

  function getRun(runId) {
    assertRunId(runId);
    return runs.get(runId) || null;
  }

  async function status(runId) {
    logCall('status', { runId });
    const run = getRun(runId);
    if (!run) return { runId, ...errResult('unknown_run', `unknown run: ${runId}`) };
    return {
      ok: true, runId, status: run.status, terminal: TERMINAL_STATUSES.has(run.status),
      exitCode: run.exitCode, error: run.error, agentId: run.profileId,
      backend: 'fake', model: null, pid: run.pid, childPid: run.childPid ?? null,
      // Explicit immutable spawn attestation: the fake run record knows
      // whether a child was scripted at spawn — an explicit boolean, NOT a
      // null childPid field (a null field alone never proves no child).
      // run.childSpawnedUndeclared emulates real porch, whose status never
      // carries child_spawned: a null child_pid then attests NOTHING.
      childSpawned: run.childSpawnedUndeclared ? undefined
        : run.childPid != null,
      childStarttime: run.childStarttime ?? null,
      childPidNs: run.childPidNs ?? null,
      process: processIdentity(run.pid), startedAt: run.startedAt,
      recordedPidStarttime: run.pidStarttime ?? null,
      updatedAt: run.finishedAt || run.startedAt,
      finishedAt: run.finishedAt, mailboxClosed: TERMINAL_STATUSES.has(run.status),
      registryRecovered: false, state: { status: run.status },
    };
  }

  async function events(runId, { cursor = 0, maxEvents = 50 } = {}) {
    logCall('events', { runId });
    const run = getRun(runId);
    if (!run) return { runId, ...errResult('unknown_run', `unknown run: ${runId}`) };
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RuntimeError('invalid_argument', `cursor must be >= 0: ${cursor}`);
    }
    const total = run.events.length;
    const startIdx = Math.min(cursor, total);
    const page = run.events.slice(startIdx, startIdx + maxEvents);
    return {
      ok: true, runId, status: run.status, terminal: TERMINAL_STATUSES.has(run.status),
      exitCode: run.exitCode, cursor: startIdx,
      nextCursor: startIdx + page.length, remaining: total - startIdx - page.length,
      cursorReset: cursor > total, events: page,
    };
  }

  async function wait(runId, { timeoutSec = 0 } = {}) {
    logCall('wait', { runId });
    const run = getRun(runId);
    if (!run) {
      return { runId, ok: false, outcome: 'error',
        error: { code: 'unknown_run', message: `unknown run: ${runId}` } };
    }
    const deadline = Date.now() + timeoutSec * 1000;
    while (!TERMINAL_STATUSES.has(run.status)) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      // Ref'd timer on purpose: an in-flight wait is real work and must keep
      // the process alive; an unref'd poll could leave this promise pending
      // forever if the event loop otherwise drains.
      await new Promise((resolveWait) => {
        let t = null;
        const wake = () => {
          if (t) clearTimeout(t);
          resolveWait();
        };
        t = setTimeout(() => {
          const i = run.waiters.indexOf(wake);
          if (i >= 0) run.waiters.splice(i, 1);
          resolveWait();
        }, Math.min(left, 25));
        run.waiters.push(wake);
      });
    }
    if (!TERMINAL_STATUSES.has(run.status)) {
      return {
        ok: true, outcome: 'timeout', runId, timedOut: true, terminal: false,
        status: run.status, exitCode: null,
        elapsedSeconds: (Date.now() - new Date(run.startedAt).getTime()) / 1000,
        activeTools: null, nextCursor: run.events.length,
        recentEvents: run.events.slice(-5),
      };
    }
    return {
      ok: true, outcome: 'terminal', runId, timedOut: false, terminal: true,
      status: run.status, exitCode: run.status === 'completed' ? 0
        : run.status === 'cancelled' ? 130 : (run.exitCode ?? 1),
      runExitCode: run.exitCode, error: run.error, agentId: run.profileId,
      backend: 'fake', model: null, startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationS: (new Date(run.finishedAt) - new Date(run.startedAt)) / 1000,
      finalAvailable: run.finalAvailable, finalPath: null,
      finalText: run.finalText, artifactsDir: run.artifactsDir, cwd: run.cwd,
    };
  }

  async function cancel(runId) {
    logCall('cancel', { runId });
    const run = getRun(runId);
    if (!run) {
      return { runId, requested: false,
        ...errResult('unknown_run', `unknown run: ${runId}`) };
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      return { runId, requested: false,
        ...errResult('already_terminal', `run is terminal (${run.status})`) };
    }
    pushEvent(run, 'cancel_requested', '');
    if (run.onCancel !== 'ignore') {
      setStatus(run, 'cancelled', { exitCode: 130 });
    }
    return { ok: true, runId, requested: true };
  }

  async function listRuns() {
    logCall('listRuns');
    if (registry.listFails > 0) {
      registry.listFails -= 1;
      return errResult('command_timeout', 'injected registry list failure');
    }
    return {
      ok: true,
      runs: [...runs.values()].map((r) => ({
        runId: r.runId, unreadable: null, status: r.status,
        effectiveStatus: r.status, terminal: TERMINAL_STATUSES.has(r.status),
        agentId: r.profileId, backend: 'fake', model: null,
        cwd: r.cwd, artifactsDir: r.artifactsDir, detachLog: null,
        pid: r.pid, pidAlive: r.pidAlive, startedAt: r.startedAt,
        finishedAt: r.finishedAt, exitCode: r.exitCode, error: r.error,
      })),
    };
  }

  // Same AND semantics as the porch backend: every supplied selector must
  // match. Injected unreadable entries mark the whole scan incomplete —
  // zero clean matches under an incomplete scan authorizes nothing.
  async function reconcile(match = {}) {
    logCall('reconcile', { ...match });
    const wantCwd = match.cwd ? normPath(match.cwd) : null;
    const wantArt = match.artifactsDir ? normPath(match.artifactsDir) : null;
    const wantIds = Array.isArray(match.runIds) && match.runIds.length
      ? new Set(match.runIds) : null;
    if (!wantCwd && !wantArt && !wantIds) {
      throw new RuntimeError('invalid_argument',
        'reconcile requires cwd, artifactsDir, or runIds');
    }
    const listed = await listRuns();
    if (!listed.ok) return listed;
    const matches = listed.runs.filter((r) => {
      if (wantIds && !(r.runId && wantIds.has(r.runId))) return false;
      if (wantArt && !(r.artifactsDir && normPath(r.artifactsDir) === wantArt)) return false;
      if (wantCwd && !(r.cwd && normPath(r.cwd) === wantCwd)) return false;
      return true;
    });
    return { ok: true, scannedAt: new Date().toISOString(),
      totalRuns: listed.runs.length, matches,
      unreadable: [...registry.unreadable] };
  }

  // Per-attempt launch record, normalized like the process backend's.
  // Missing/corrupt entries are reported, never treated as "no spawn".
  async function launchRecord(attemptId) {
    assertSafeId('attemptId', attemptId);
    logCall('launchRecord', { attemptId });
    const rec = registry.records.get(attemptId);
    if (rec === undefined) return { attemptId, missing: true, corrupt: false };
    if (typeof rec !== 'object' || rec === null) {
      return { attemptId, missing: false, corrupt: true };
    }
    return {
      attemptId, missing: false, corrupt: false,
      schemaVersion: rec.schemaVersion ?? null,
      phase: rec.phase ?? null,
      spawned: rec.spawned === true ? true : rec.spawned === false ? false : null,
      porchRunId: rec.porchRunId ?? null,
      launcher: rec.launcher ?? null,
      diagnostics: rec.diagnostics ?? null,
      error: rec.error ?? null,
      environment: rec.environment ?? null,
    };
  }

  // Fake /proc activity probe — registry.procs entries may carry
  // {syscall, rchar, wchar, cpu} to model epoll_park/no-progress; absent
  // fields read as a running process doing real work.
  async function activity(pid) {
    logCall('activity', { pid });
    if (!Number.isInteger(pid) || pid <= 0) {
      return { pid, exists: null, readable: false };
    }
    const p = registry.procs.get(pid);
    if (!p) {
      return { pid, exists: false, readable: false, syscall: null, idleWait: null, ioSum: null, cpuSum: null };
    }
    const exists = p.exists === undefined ? true : p.exists;
    if (exists !== true) {
      return { pid, exists, readable: false, syscall: null, idleWait: null, ioSum: null, cpuSum: null };
    }
    const syscall = p.syscall !== undefined ? p.syscall : 'running';
    // Missing metrics stay null (unknown) — coercing them to 0 would let a
    // stuck check read "zero IO/CPU" from a process we never measured.
    const ioSum = p.ioSum !== undefined ? p.ioSum : null;
    const cpuSum = p.cpuSum !== undefined ? p.cpuSum : null;
    return {
      pid, exists: true,
      // Exact positive evidence only — an unreadable/unknown procs row must
      // NOT read as readable, or a stuck check would trust zero-ish metrics.
      readable: p.readable === true,
      syscall,
      idleWait: syscall === 'running' ? false
        : ['7', '23', '61', '232', '270', '271', '407'].includes(String(syscall)),
      ioSum, cpuSum,
    };
  }

  // The attempt "dir" in the fake backend is the durable record — created
  // exactly where the process backend mkdirs attempts/<id> before spawn.
  // Same honesty rule as the porch backend: absence is never alone proof of
  // no-spawn (an in-flight async start precedes the record).
  async function attemptDirState(attemptId) {
    assertSafeId('attemptId', attemptId);
    const rec = registry.records.get(attemptId);
    if (rec === undefined && !usedAttempts.has(attemptId)) {
      return { attemptId, exists: false, files: [] };
    }
    return { attemptId, exists: true, files: rec !== undefined ? ['launch.json'] : [] };
  }

  // The bound Pi session log for an attempt — a REAL file under the fake
  // root recorded at launch (sessions/<--cwd-slug-->/<created>_acp-<id>.jsonl),
  // mirroring the porch/pi contract where the dir is persisted into the
  // launch record and read back immutably. _pushEvent appends a real jsonl
  // line (genuine byte growth); a run with no recorded log is 'missing' —
  // never zero-growth evidence.
  const piSlug = (cwd) => `--${String(cwd).split('/').filter(Boolean).join('-')}--`;
  async function sessionLog(attemptId) {
    const run = [...runs.values()].find((r) => r.attemptId === attemptId) || null;
    const sl = run?.sessionLog;
    if (!sl) return { ok: false, code: 'session_log_missing' };
    try {
      const st = await fs.stat(sl.path);
      return { ok: true, path: sl.path, bytes: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      return { ok: false, code: e?.code === 'ENOENT' ? 'session_log_missing' : 'session_log_unreadable' };
    }
  }

  return {
    kind: 'fake',
    rootDir,
    environment, envInstance, processIdentity, start, status, events, wait, cancel,
    listRuns, reconcile, launchRecord, activity, attemptDirState, sessionLog,
    _runs: runs,
    _procs: registry.procs,
    _records: registry.records,
    _calls: calls,
    _registry: registry,
    // Remove a run from the registry entirely — the "vanished CLI" case:
    // meta/state gone while the attempt record still says running.
    _vanish(runId) {
      const r = runs.get(runId);
      if (r) {
        const p = registry.procs.get(r.pid);
        if (p) registry.procs.set(r.pid, { ...p, exists: false });
        runs.delete(runId);
        return true;
      }
      return false;
    },
    // Append an event to a live run — models in-flight agent progress; the
    // bound session log grows by a real jsonl line, so the stuck heuristic's
    // "no growth" signal is honest, not a counter.
    _pushEvent(runId, type, data = '') {
      const r = runs.get(runId);
      if (!r) return false;
      pushEvent(r, type, data);
      if (r.sessionLog) {
        fs.mkdir(path.dirname(r.sessionLog.path), { recursive: true })
          .then(() => fs.appendFile(r.sessionLog.path,
            JSON.stringify({ type: 'session_event', kind: type, at: Date.now() }) + '\n'))
          .catch(() => {});
      }
      return true;
    },
    _setProc(pid, patch) {
      const p = registry.procs.get(pid);
      if (!p) return false;
      registry.procs.set(pid, { ...p, ...patch });
      return true;
    },
    _force(runId, patch) {
      const r = runs.get(runId);
      if (!r) return false;
      // Final-result evidence is patched BEFORE the status transition so the
      // terminal-proof gate sees a coherent record (wait() must harvest a
      // completed run's real finalText — a bare status flip has none).
      if (patch.finalText !== undefined) {
        r.finalText = patch.finalText;
        r.finalAvailable = patch.finalText !== null;
      }
      if (patch.status) setStatus(r, patch.status, patch);
      return true;
    },
  };
}

export const _internals = { DEFAULT_BEHAVIOR, RUN_ID_RE, freshRegistry };
