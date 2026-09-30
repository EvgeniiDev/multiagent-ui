// server/execution/fake-runtime.mjs — deterministic in-memory backend.
//
// Same surface as createPorchRuntime so the future controller (U3+) can be
// exercised without porch, processes, or model calls. Behavior is scripted
// per attempt/profile; defaults complete immediately. Import-safe: no fs,
// no timers until start() is called.

import os from 'node:os';
import path from 'node:path';
import {
  RuntimeError, errResult, assertSafeId, assertRunId, normPath, RUN_ID_RE,
} from './common.mjs';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const DEFAULT_BEHAVIOR = {
  launch: 'ok',              // 'ok' | 'fail' | 'uncertain'
  launchError: 'fake launch refused',
  outcome: 'completed',      // 'completed' | 'failed' | 'never'
  delayMs: 5,                // time until outcome applies
  finalText: 'fake result',
  error: null,
  exitCode: null,            // defaults derived from outcome
  events: null,              // extra scripted events appended after start
  onCancel: 'cancel',        // 'cancel' | 'ignore'
};

export function createFakeRuntime(options = {}) {
  const behaviors = options.behaviors || {};
  const rootDir = options.rootDir || path.join(os.tmpdir(), 'fake-exec');
  const namespace = options.namespace || 'fake';
  const runs = new Map();
  const usedAttempts = new Set();
  let seq = 0;

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
      pidStarttime: null,
      pidNs: null,
      hostname: os.hostname(),
      bootId: null,
      platform: process.platform,
      node: process.version,
      rootDir, steerDir: null, outputDir: null, attemptsDir: null,
      porchPath: null,
    };
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
    const base = {
      attemptId, attemptDir, artifactsDir,
      porchRunId: null,
      environment: environment(),
      diagnostics: { exitCode: null, signal: null, timedOut: false, durationMs: 0 },
      launchRecord: null,
      recordPersisted: true,
    };
    if (typeof params.prompt !== 'string' || !params.prompt.length) {
      if (!params.promptFile) {
        return { ...base, ok: false, phase: 'launch_failed',
          error: { code: 'invalid_argument',
            message: 'start requires prompt or promptFile' } };
      }
    }
    if (!params.config && !params.configPath) {
      return { ...base, ok: false, phase: 'launch_failed',
        error: { code: 'config_required',
          message: 'start requires an explicit profile snapshot' } };
    }
    if (b.launch === 'fail') {
      return { ...base, ok: false, phase: 'launch_failed',
        error: { code: 'cli_error', message: b.launchError } };
    }
    if (b.launch === 'uncertain') {
      // Uncertain = "maybe a run exists". Reflect that honestly: register an
      // unlisted-able run record only when scripted (reconcile may find it).
      const runId = `run_fake-${++seq}`;
      if (b.uncertainRegisters !== false) {
        const run = {
          runId, attemptId, profileId, cwd: params.cwd, artifactsDir,
          status: 'running', exitCode: null, error: null,
          startedAt: new Date().toISOString(), finishedAt: null,
          events: [], waiters: [], timer: null, onCancel: b.onCancel,
          finalText: null, finalAvailable: false, pid: process.pid, pidAlive: true,
        };
        runs.set(runId, run);
        scheduleOutcome(run, b);
      }
      return { ...base, ok: false, phase: 'launch_uncertain',
        error: { code: 'launch_timeout', message: 'fake handshake timeout' } };
    }
    const runId = `run_fake-${++seq}`;
    const run = {
      runId, attemptId, profileId, cwd: params.cwd, artifactsDir,
      status: 'running', exitCode: null, error: null,
      startedAt: new Date().toISOString(), finishedAt: null,
      events: [], waiters: [], timer: null, onCancel: b.onCancel,
      finalText: null, finalAvailable: false, pid: process.pid, pidAlive: true,
    };
    runs.set(runId, run);
    pushEvent(run, 'run_started', `profile=${profileId}`);
    for (const ev of b.events || []) pushEvent(run, ev.type || 'progress', ev.data || '');
    scheduleOutcome(run, b);
    return { ...base, ok: true, phase: 'launched', porchRunId: runId };
  }

  function getRun(runId) {
    assertRunId(runId);
    return runs.get(runId) || null;
  }

  async function status(runId) {
    const run = getRun(runId);
    if (!run) return { runId, ...errResult('unknown_run', `unknown run: ${runId}`) };
    return {
      ok: true, runId, status: run.status, terminal: TERMINAL_STATUSES.has(run.status),
      exitCode: run.exitCode, error: run.error, agentId: run.profileId,
      backend: 'fake', model: null, pid: run.pid, childPid: null,
      process: null, startedAt: run.startedAt, updatedAt: run.finishedAt || run.startedAt,
      finishedAt: run.finishedAt, mailboxClosed: TERMINAL_STATUSES.has(run.status),
      registryRecovered: false, state: { status: run.status },
    };
  }

  async function events(runId, { cursor = 0, maxEvents = 50 } = {}) {
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

  // Same AND semantics as the porch backend: every supplied selector must match.
  async function reconcile(match = {}) {
    const wantCwd = match.cwd ? normPath(match.cwd) : null;
    const wantArt = match.artifactsDir ? normPath(match.artifactsDir) : null;
    const wantIds = Array.isArray(match.runIds) && match.runIds.length
      ? new Set(match.runIds) : null;
    if (!wantCwd && !wantArt && !wantIds) {
      throw new RuntimeError('invalid_argument',
        'reconcile requires cwd, artifactsDir, or runIds');
    }
    const listed = await listRuns();
    const matches = listed.runs.filter((r) => {
      if (wantIds && !(r.runId && wantIds.has(r.runId))) return false;
      if (wantArt && !(r.artifactsDir && normPath(r.artifactsDir) === wantArt)) return false;
      if (wantCwd && !(r.cwd && normPath(r.cwd) === wantCwd)) return false;
      return true;
    });
    return { ok: true, scannedAt: new Date().toISOString(),
      totalRuns: listed.runs.length, matches };
  }

  return {
    kind: 'fake',
    rootDir,
    environment, start, status, events, wait, cancel, listRuns, reconcile,
    _runs: runs,
    _force(runId, patch) {
      const r = runs.get(runId);
      if (!r) return false;
      if (patch.status) setStatus(r, patch.status, patch);
      return true;
    },
  };
}

export const _internals = { DEFAULT_BEHAVIOR, RUN_ID_RE };
