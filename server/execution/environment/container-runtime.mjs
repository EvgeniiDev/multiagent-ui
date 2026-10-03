// server/execution/environment/container-runtime.mjs — container backend (F1).
//
// Same public surface as porch-runtime.mjs (start/status/events/wait/cancel/
// listRuns/reconcile/launchRecord/environment/processIdentity/activity/
// attemptDirState/sessionLog), but every porch invocation runs INSIDE a
// dedicated worker container via the trusted environment controller —
// `docker exec` through the controller's authenticated channel, never
// through a socket or docker CLI on this side.
//
// One worker per attempt, one UID, porch registry inside the worker's own
// attempt dir. The runtime keeps its OWN launch records on the runner side
// (<envRoot>/runtime/attempts/<attemptId>/launch.json) — identical phases
// and durable-write ordering to the process backend — while the worker's
// materials/home/artifacts live under <envRoot>/workers/<workerId>/.
//
// Public ids stay public: porchRunId is the porch run id inside the worker;
// artifactsDir in results is the CONTAINER path the worker registry records
// (the reconcile selector); hostArtifactsDir is where the runner reads the
// same files on the host filesystem.
//
// Boundaries enforced here (the controller enforces the rest):
//   * params.config is REFUSED — the porch agent config is synthesized from
//     the validated AgentProfile, never accepted verbatim;
//   * params.env is REFUSED — the worker env is fixed by the deployment;
//   * search-enabled profiles are refused without a capability store, and
//     gated on a positive probe for the EXACT profile digest when present;
//   * cancel() only ever reaches the worker that owns the recorded run id.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RuntimeError, errResult, atomicWriteJson, ensureDir,
  assertSafeId, assertRunId, assertAbsFile,
  tailOf, normPath, classifyCliError, RUN_ID_RE, SAFE_ID_RE, DIR_MODE, FILE_MODE,
} from '../common.mjs';
import {
  validateAgentProfile, profileDigest, porchAgentEntry,
} from './agent-profile.mjs';

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 45_000;   // prepare+handshake bound
const WAIT_KILL_GRACE_MS = 8_000;
const CONTROL_MAX_BYTES = 1024 * 1024;
const RESULT_MAX_BYTES = 8 * 1024 * 1024;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Container-side fixed layout — mirrors what the controller mounts.
export const CONTAINER_PATHS = {
  conf: '/work/conf',
  agent: '/work/agent',
  home: '/work/home',
  attempt: '/work/attempt',
  project: '/work/project',
  inputs: '/work/inputs',
  deps: '/work/deps',
  ext: '/work/node_modules',
};

const ROLES = new Set(['panelist', 'judge', 'integrator', 'setup', 'probe']);

export function workerIdForAttempt(attemptId) {
  return `w-${attemptId}`;
}

export function createContainerRuntime({
  config,                    // validated environment config (client view)
  client,                    // createControllerClient result
  env = process.env,
  namespace = 'acp-f1',
  launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  controlTimeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  maxResultBytes = RESULT_MAX_BYTES,
  maxControlBytes = CONTROL_MAX_BYTES,
  capabilityStore = null,    // REQUIRED to launch search-enabled profiles
  envRoot = null,            // client-view env root; defaults to config root
} = {}) {
  if (!config || typeof config.pathFor !== 'function') {
    throw new RuntimeError('invalid_argument', 'container runtime needs a validated env config');
  }
  if (!client) throw new RuntimeError('invalid_argument', 'container runtime needs a controller client');
  const rootDir = envRoot || config.pathFor('env');
  const runtimeAttemptsDir = path.join(rootDir, 'runtime', 'attempts');
  const workersDir = path.join(rootDir, 'workers');
  // Controller identity learned from RPCs — part of environment() so an env
  // restart is distinguishable from a same-container process restart.
  let lastControllerIdentity = null;

  function environment() {
    return {
      namespace,
      backend: 'porch-container',
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      pid: process.pid,
      hostname: os.hostname(),
      rootDir,
      runtimeAttemptsDir,
      workersDir,
      controller: lastControllerIdentity,
      containerPaths: CONTAINER_PATHS,
    };
  }

  // ---- helpers -------------------------------------------------------------

  const workerDir = (workerId) => path.join(workersDir, workerId);
  const workerAttemptDir = (workerId) => path.join(workerDir(workerId), 'attempt');
  const recordFile = (attemptId) => path.join(runtimeAttemptsDir, attemptId, 'launch.json');

  async function readRecord(attemptId) {
    let raw;
    try { raw = await fs.readFile(recordFile(attemptId), 'utf8'); }
    catch (e) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    try { return JSON.parse(raw); }
    catch { return { corrupt: true }; }
  }

  async function writeRecord(attemptId, rec) {
    rec.persistedAt = new Date().toISOString();
    await atomicWriteJson(recordFile(attemptId), rec);
  }

  async function call(method, params, opts) {
    const res = await client.call(method, params, opts);
    if (res && res.controller) lastControllerIdentity = res.controller;
    return res;
  }

  // exec against the worker bound to an attempt. env additions are limited
  // to the controller's declared allowlist; the controller re-validates.
  async function exec(workerId, { template, args = [], cwdKey = 'home', env: envExtra = {}, timeoutMs, maxStdout } = {}) {
    const spec = {
      workerId, template, args, cwdKey, env: envExtra,
      timeoutMs: timeoutMs ?? controlTimeoutMs,
      maxStdout: maxStdout ?? maxControlBytes,
      maxStderr: Math.min(maxStdout ?? maxControlBytes, maxControlBytes),
    };
    const res = await call('worker.exec', spec,
      { timeoutMs: (timeoutMs ?? controlTimeoutMs) + 10_000 });
    return res;
  }

  function porchExecEnv(attemptId) {
    const a = CONTAINER_PATHS.attempt;
    return {
      PORCH_STEER_DIR: `${a}/steer`,
      PORCH_OUTPUT_DIR: `${a}/out`,
      PORCH_SAVE_OUTPUTS: '1',
      PORCH_CONFIG: `${CONTAINER_PATHS.conf}/porch-config.json`,
      PI_CODING_AGENT_SESSION_DIR: `${a}/pi-sessions`,
    };
  }

  // Per-attempt run dir inside the worker — keeps registry artifacts_dir a
  // unique selector across the fleet (every worker's registry is private,
  // but reconcile matches must stay exact when workers are scanned).
  const runDirFor = (attemptId) => `${CONTAINER_PATHS.attempt}/run-${attemptId}`;

  // Map a bounded-exec result onto the same failure lattice spawnBounded
  // gives the process backend: spawnError / timedOut / code+stdout/stderr.
  function execToSpawn(res) {
    if (res.ok === false) {
      return { ok: false, spawnError: res.error?.message || 'exec refused', code: null, signal: null, timedOut: false };
    }
    return {
      ok: true,
      code: res.exitCode ?? null,
      signal: null,
      timedOut: res.timedOut === true,
      observationCut: res.truncated === true,
      pid: res.pid ?? null,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      stdoutTruncated: res.stdoutTruncated === true,
      stderrTruncated: res.stderrTruncated === true,
      durationMs: res.durationMs ?? 0,
    };
  }

  function extractRunId(stdout) {
    for (const line of String(stdout || '').split(/\r?\n/).reverse()) {
      const t = line.trim();
      if (RUN_ID_RE.test(t)) return t;
    }
    return null;
  }

  async function porchCtl(workerId, attemptId, args, { timeoutMs = controlTimeoutMs, maxBytes = maxControlBytes } = {}) {
    let res;
    try {
      res = await exec(workerId, {
        template: 'porch', args,
        cwdKey: 'home', env: porchExecEnv(attemptId),
        timeoutMs, maxStdout: maxBytes,
      });
    } catch (e) {
      // worker gone / exec refused — a control-plane failure, NOT a run
      // outcome. Surface with a stable code; callers treat as unreachable.
      return { res: null, parsed: null,
        failure: errResult(e.code || 'exec_failed',
          `worker exec failed: ${e.message}`, { workerId }) };
    }
    const sp = execToSpawn(res);
    if (sp.spawnError) {
      return { res: sp, parsed: null, failure: errResult('spawn_error', sp.spawnError) };
    }
    if (sp.timedOut) {
      return { res: sp, parsed: null, failure: errResult('command_timeout',
        `porch delegate ${args[0]} exceeded ${timeoutMs}ms in worker ${workerId}`) };
    }
    const text = sp.stdout.trim();
    let parsed = null, parseError = false;
    if (text) { try { parsed = JSON.parse(text); } catch { parseError = true; } }
    return { res: sp, parsed, parseError, failure: null };
  }

  // ---- start ---------------------------------------------------------------
  //
  // params: {
  //   attemptId,                  // unique per attempt (record create is exclusive)
  //   profileId,                  // porch agent id inside the synthesized config
  //   profile,                    // AgentProfile object (REQUIRED, validated)
  //   role,                       // 'panelist' (default) | 'judge' | 'integrator' | 'setup' | 'probe'
  //   prompt | promptFile,        // one required
  //   materials: {                // logical inputs — names, never host paths
  //     projectRoot,              //   registered projects-root subdirectory
  //     snapshotSha,              //   commit the worker project is built from
  //     inputs: [{name, content}],
  //     canonicalId,              //   integrator binding
  //     depSetId,                 //   materialized deps to mount ro
  //   },
  //   launchTimeoutMs,
  // }
  async function start(params = {}) {
    const attemptId = assertSafeId('attemptId', params.attemptId);
    const profileId = assertSafeId('profileId', params.profileId);
    const workerId = workerIdForAttempt(attemptId);
    const env0 = environment();
    const attemptDir = path.join(runtimeAttemptsDir, attemptId);
    const record = {
      schemaVersion: 1,
      kind: 'porch-container',
      attemptId,
      namespace,
      profileId,
      workerId,
      role: null,
      phase: 'prepared',
      spawned: false,
      createdAt: new Date().toISOString(),
      environment: env0,
      error: null,
      launch: null,
      porchRunId: null,
      worker: null,
      pi: null,
    };

    await ensureDir(runtimeAttemptsDir);
    try {
      await fs.mkdir(attemptDir, { mode: DIR_MODE });
    } catch (e) {
      if (e.code === 'EEXIST') {
        throw new RuntimeError('attempt_exists',
          `attempt record dir already exists: ${attemptDir}`);
      }
      throw e;
    }
    const persist = async () => { await writeRecord(attemptId, record); return true; };
    const failPreLaunch = async (code, message) => {
      record.phase = 'launch_failed';
      record.error = { code, message };
      await persist().catch(() => {});
      return {
        ok: false, phase: 'launch_failed', attemptId, attemptDir,
        artifactsDir: null, porchRunId: null, error: record.error,
        environment: env0, launchRecord: recordFile(attemptId),
      };
    };

    // --- pre-launch validation (nothing has run anywhere yet) ---
    let promptText;
    try {
      if (params.config !== undefined) {
        return await failPreLaunch('config_from_profile',
          'container runtime derives the porch config from the AgentProfile; params.config is not accepted');
      }
      if (params.env !== undefined) {
        return await failPreLaunch('env_from_deployment',
          'container runtime env is fixed by the deployment; params.env is not accepted');
      }
      if (params.promptFile) {
        const src = await assertAbsFile('promptFile', params.promptFile);
        promptText = await fs.readFile(src, 'utf8');
      } else if (typeof params.prompt === 'string' && params.prompt.length) {
        promptText = params.prompt;
      } else {
        return await failPreLaunch('invalid_argument', 'start requires prompt or promptFile');
      }
      if (Buffer.byteLength(promptText) > config.environment.maxPromptBytes) {
        return await failPreLaunch('invalid_argument', 'prompt exceeds maxPromptBytes');
      }

      const profile = validateAgentProfile(params.profile);
      const digest = profileDigest(params.profile);
      const role = params.role || 'panelist';
      if (!ROLES.has(role)) {
        return await failPreLaunch('invalid_argument', `unknown role: ${role}`);
      }
      if (!config.roles[role]) {
        return await failPreLaunch('role_not_registered', `role ${role} not in deployment config`);
      }
      // Search gate: enabled search requires a POSITIVE probe for the exact
      // digest of the effective profile. No store wired -> cannot prove.
      if (profile.search.enabled) {
        if (!capabilityStore) {
          return await failPreLaunch('search_gate_unwired',
            'search-enabled profile but no capability store is configured');
        }
        try {
          await capabilityStore.requireSearchAllowed(profile, digest);
        } catch (e) {
          return await failPreLaunch(e.code || 'search_unproven', e.message);
        }
      }

      const materials = params.materials || {};
      const roleSpec = config.roles[role];
      const spec = {
        workerId,
        attemptId,
        role,
        profileId,
        profile,                       // validated object; controller re-checks
        profileDigest: digest,
        porchConfig: { agents: { [profileId]: porchAgentEntry(profile) } },
        prompt: promptText,
        materials: {
          projectRoot: materials.projectRoot ?? null,
          snapshotSha: materials.snapshotSha ?? materials.baseSha ?? null,
          inputs: materials.inputs ?? [],
          canonicalId: materials.canonicalId ?? null,
          fromCanonical: materials.fromCanonical === true,
          depSetId: materials.depSetId ?? null,
          setupId: materials.setupId ?? null,
        },
      };
      record.role = role;
      record.profileDigest = digest;
      record.launch = {
        spec: {
          workerId, role, profileDigest: digest,
          projectRoot: spec.materials.projectRoot,
          snapshotSha: spec.materials.snapshotSha,
          canonicalId: spec.materials.canonicalId,
          depSetId: spec.materials.depSetId,
        },
        argv: ['/work/conf/porch/scripts/porch', 'delegate', '-a', profileId, '--detach',
          '--prompt-file', '/work/conf/prompt.md'],
        startedAt: new Date().toISOString(),
      };
      await persist();

      // --- worker prepare: controller builds materials + container ---
      let prep;
      try {
        prep = await call('worker.prepare', spec,
          { timeoutMs: params.launchTimeoutMs ?? launchTimeoutMs });
      } catch (e) {
        return await failPreLaunch(e.code || 'worker_prepare_failed', e.message);
      }
      record.worker = prep.worker;
      record.phase = 'launching';
      record.spawned = true;   // worker container is live; launch exec follows
      await persist();

      // --- launch handshake: porch delegate --detach inside the worker ---
      const execRes = await exec(workerId, {
        template: 'porch',
        args: ['-a', profileId, '--detach', '--prompt-file', '/work/conf/prompt.md'],
        cwdKey: roleSpec.projectMode === 'none' ? 'home' : 'project',
        env: {
          ...porchExecEnv(attemptId),
          PORCH_RUN_DIR: runDirFor(attemptId),
          PORCH_PI_SESSION_ID: `acp-${attemptId}`,
        },
        timeoutMs: params.launchTimeoutMs ?? launchTimeoutMs,
        maxStdout: 256 * 1024,
      }).catch((e) => ({ ok: false, error: { code: e.code || 'exec_failed', message: e.message } }));
      const sp = execToSpawn(execRes);
      const diag = {
        exitCode: sp.code, signal: sp.signal, timedOut: sp.timedOut,
        observationCut: sp.observationCut, durationMs: sp.durationMs,
        stdoutTail: tailOf(sp.stdout), stderrTail: tailOf(sp.stderr),
        stdoutTruncated: sp.stdoutTruncated, stderrTruncated: sp.stderrTruncated,
        execId: execRes?.execId ?? null,
      };
      record.launch.finishedAt = new Date().toISOString();
      record.launch.diagnostics = diag;
      if (sp.spawnError) {
        record.phase = 'launch_failed';
        record.error = { code: 'spawn_error', message: sp.spawnError };
      } else if (sp.timedOut || sp.signal) {
        record.phase = 'launch_uncertain';
        record.error = { code: 'launch_timeout',
          message: `handshake exceeded ${params.launchTimeoutMs ?? launchTimeoutMs}ms` };
      } else {
        const runId = extractRunId(sp.stdout);
        if (sp.code === 0 && runId) {
          record.phase = 'launched';
          record.porchRunId = runId;
        } else if (sp.code === 0) {
          record.phase = 'launch_uncertain';
          record.error = { code: 'missing_run_id',
            message: 'porch exited 0 but no valid run id on stdout' };
        } else {
          record.phase = 'launch_failed';
          record.error = { code: classifyCliError(sp.stderr),
            message: `porch exited ${sp.code}: ${tailOf(sp.stderr, 1500) || '(no stderr)'}` };
        }
      }
      record.pi = {
        sessionId: `acp-${attemptId}`,
        // Flat session-dir override — container AND host views recorded.
        sessionDir: path.join(workerAttemptDir(workerId), 'pi-sessions'),
        containerSessionDir: `${CONTAINER_PATHS.attempt}/pi-sessions`,
      };
      let persisted = true;
      try { await persist(); } catch (e) { persisted = false; record.persistError = e.message; }
      const cArt = runDirFor(attemptId);
      return {
        ok: record.phase === 'launched',
        phase: record.phase,
        attemptId, attemptDir,
        workerId,
        artifactsDir: cArt,
        hostArtifactsDir: path.join(workerAttemptDir(workerId), `run-${attemptId}`),
        porchRunId: record.porchRunId,
        error: record.error || null,
        diagnostics: diag,
        environment: env0,
        launchRecord: recordFile(attemptId),
        recordPersisted: persisted,
      };
    } catch (e) {
      return await failPreLaunch(e.code || 'error', e.message);
    }
  }

  // Worker binding for control ops: the record maps attempt→worker; run id
  // → worker resolution goes through the bound record's registry scan.
  async function workerForRun(runId) {
    assertRunId(runId);
    // Scan our launch records: the run id is only meaningful inside the
    // worker that registered it. A miss is an unknown run, not a guess.
    let names;
    try { names = await fs.readdir(runtimeAttemptsDir); }
    catch (e) {
      if (e?.code === 'ENOENT') return { runId, ...errResult('unknown_run', `no attempt records for ${runId}`) };
      throw e;
    }
    for (const att of names) {
      const rec = await readRecord(att).catch(() => null);
      if (rec?.porchRunId === runId && rec.workerId) {
        return { attemptId: att, workerId: rec.workerId, record: rec };
      }
    }
    return null;
  }

  async function status(runId) {
    assertRunId(runId);
    const bound = await workerForRun(runId);
    if (!bound) return { runId, ...errResult('unknown_run', `run ${runId} not bound to any worker`) };
    const { res, parsed, failure } = await porchCtl(bound.workerId, bound.attemptId,
      ['status', runId, '--json']);
    if (failure) return { runId, ...failure };
    if (!parsed) {
      return { runId, ...errResult(
        res.code === 0 ? 'parse_error' : classifyCliError(res.stderr),
        `status failed (exit ${res.code})`, { stderrTail: tailOf(res.stderr) }) };
    }
    return {
      ok: true,
      runId: parsed.run_id || runId,
      status: parsed.status ?? null,
      terminal: TERMINAL_STATUSES.has(parsed.status),
      exitCode: parsed.exit_code ?? null,
      error: parsed.error ?? null,
      agentId: parsed.agent_id ?? null,
      backend: parsed.backend ?? null,
      model: parsed.model ?? null,
      effort: parsed.effort ?? null,
      pid: parsed.pid ?? null,
      childPid: parsed.child_pid ?? null,
      childSpawned: Number.isInteger(parsed.child_pid) ? true
        : (parsed.child_spawned === false ? false : undefined),
      process: null,   // see processIdentity — worker-scoped, needs attempt
      workerId: bound.workerId,
      attemptId: bound.attemptId,
      startedAt: parsed.started_at ?? null,
      updatedAt: parsed.updated_at ?? null,
      finishedAt: parsed.finished_at ?? null,
      mailboxClosed: !!parsed.mailbox_closed,
      registryRecovered: !!parsed.registry_recovered,
      state: parsed.state ?? null,
    };
  }

  async function events(runId, { cursor = 0, maxEvents = 50 } = {}) {
    assertRunId(runId);
    const bound = await workerForRun(runId);
    if (!bound) return { runId, ...errResult('unknown_run', `run ${runId} not bound to any worker`) };
    const { res, parsed, failure } = await porchCtl(bound.workerId, bound.attemptId,
      ['events', runId, '--cursor', String(cursor), '--max-events', String(maxEvents)]);
    if (failure) return { runId, ...failure };
    if (!parsed) {
      return { runId, ...errResult(
        res.code === 0 ? 'parse_error' : classifyCliError(res.stderr),
        `events failed (exit ${res.code})`, { stderrTail: tailOf(res.stderr) }) };
    }
    return {
      ok: true,
      runId: parsed.run_id || runId,
      status: parsed.status ?? null,
      terminal: !!parsed.terminal,
      exitCode: parsed.exit_code ?? null,
      cursor: parsed.cursor ?? cursor,
      nextCursor: parsed.next_cursor ?? cursor,
      remaining: parsed.remaining ?? 0,
      cursorReset: !!parsed.cursor_reset,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  }

  async function wait(runId, { timeoutSec = 0 } = {}) {
    assertRunId(runId);
    if (!(timeoutSec >= 0) || !Number.isFinite(timeoutSec)) {
      throw new RuntimeError('invalid_argument', `timeoutSec must be finite >= 0: ${timeoutSec}`);
    }
    const bound = await workerForRun(runId);
    if (!bound) return { runId, outcome: 'error', ...errResult('unknown_run', `run ${runId} not bound to any worker`) };
    const { res, parsed, failure } = await porchCtl(bound.workerId, bound.attemptId,
      ['wait', runId, '--timeout', String(timeoutSec), '--json'],
      { timeoutMs: Math.ceil(timeoutSec * 1000) + WAIT_KILL_GRACE_MS, maxBytes: maxResultBytes });
    if (failure) {
      if (failure.error.code === 'command_timeout') {
        return { runId, ok: false, outcome: 'observer_timeout',
          error: { code: 'command_timeout',
            message: `observer gave up after ${timeoutSec}s + grace; run untouched` } };
      }
      return { runId, outcome: 'error', ...failure };
    }
    if (!parsed) {
      return { runId, ok: false, outcome: 'error',
        error: { code: res.code === 124 ? 'parse_error' : classifyCliError(res.stderr),
          message: `wait failed (exit ${res.code})`, stderrTail: tailOf(res.stderr) } };
    }
    if (res.code === 124 || parsed.timed_out) {
      return {
        ok: true, outcome: 'timeout', runId,
        timedOut: true, terminal: false,
        status: parsed.status ?? null,
        exitCode: null,
        elapsedSeconds: parsed.elapsed_seconds ?? null,
        activeTools: parsed.active_tools ?? null,
        nextCursor: parsed.next_cursor ?? null,
        recentEvents: Array.isArray(parsed.events) ? parsed.events : [],
      };
    }
    return {
      ok: true, outcome: 'terminal', runId,
      timedOut: false, terminal: true,
      status: parsed.status ?? null,
      exitCode: parsed.exit_code ?? null,
      runExitCode: parsed.run_exit_code ?? null,
      error: parsed.error ?? null,
      agentId: parsed.agent_id ?? null,
      backend: parsed.backend ?? null,
      model: parsed.model ?? null,
      startedAt: parsed.started_at ?? null,
      finishedAt: parsed.finished_at ?? null,
      durationS: parsed.duration_s ?? null,
      finalAvailable: !!parsed.final_available,
      finalPath: parsed.final_path ?? null,
      finalText: parsed.final_text ?? null,
      artifactsDir: parsed.artifacts_dir ?? null,
      cwd: parsed.cwd ?? null,
    };
  }

  // Cancel an owned attempt only: the run must resolve to one of OUR
  // recorded worker bindings; the porch registry inside that worker is the
  // only place the cancel lands — there is no cross-worker path.
  async function cancel(runId) {
    assertRunId(runId);
    const bound = await workerForRun(runId);
    if (!bound) {
      return { runId, requested: false,
        ...errResult('unknown_run', `run ${runId} not bound to any worker — refusing cancel`) };
    }
    const { res, parsed, failure } = await porchCtl(bound.workerId, bound.attemptId,
      ['cancel', runId, '--json']);
    if (failure) return { runId, requested: false, ...failure };
    if (res.code === 0 && parsed && parsed.cancel === 'requested') {
      return { ok: true, runId, requested: true, workerId: bound.workerId };
    }
    return { runId, requested: false,
      ...errResult(classifyCliError(res.stderr),
        `cancel failed (exit ${res.code})`, { stderrTail: tailOf(res.stderr) }) };
  }

  async function listRuns({ workerId = null } = {}) {
    // listRuns is per-worker (each worker has its own registry). Without a
    // workerId the union over all live workers is returned, tagged by worker.
    const ids = workerId ? [workerId] : await liveWorkerIds();
    const runs = [];
    const failures = [];
    for (const wid of ids) {
      const rec = await workerRecord(wid);
      const { res, parsed, failure } = await porchCtl(wid, rec?.attemptId ?? '',
        ['list', '--all', '--limit', '0', '--json']);
      if (failure) { failures.push({ workerId: wid, ...failure }); continue; }
      if (!Array.isArray(parsed)) {
        failures.push({ workerId: wid,
          ...errResult('parse_error', 'list output not an array') });
        continue;
      }
      for (const m of parsed) {
        runs.push({
          runId: m.run_id ?? null,
          workerId: wid,
          status: m.status ?? null,
          effectiveStatus: m.effective_status ?? null,
          terminal: TERMINAL_STATUSES.has(m.status),
          agentId: m.agent_id ?? null,
          backend: m.backend ?? null,
          model: m.model ?? null,
          cwd: m.cwd ?? null,
          artifactsDir: m.artifacts_dir ?? null,
          pid: m.pid ?? null,
          startedAt: m.started_at ?? null,
          finishedAt: m.finished_at ?? null,
          exitCode: m.exit_code ?? null,
          error: m.error ?? null,
        });
      }
    }
    return { ok: true, runs, failures };
  }

  async function liveWorkerIds() {
    let names;
    try { names = await fs.readdir(workersDir); }
    catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
    return names.filter((n) => /^w-[A-Za-z0-9]/.test(n));
  }

  async function workerRecord(workerId) {
    try {
      return JSON.parse(await fs.readFile(path.join(workerDir(workerId), 'worker.json'), 'utf8'));
    } catch { return null; }
  }

  // Reconcile: resolve the worker from the match, scan ITS registry, then
  // apply AND-matching on runIds/artifactsDir/cwd — same semantics as the
  // process backend. A vanished worker is "registry unavailable": zero
  // matches, workerState:'gone' — never proof of a live run.
  async function reconcile(match = {}) {
    const wantCwd = match.cwd ? normPath(match.cwd) : null;
    const wantArt = match.artifactsDir ? normPath(match.artifactsDir) : null;
    const wantIds = Array.isArray(match.runIds) && match.runIds.length
      ? new Set(match.runIds) : null;
    if (!wantCwd && !wantArt && !wantIds && !match.workerId && !match.attemptId) {
      throw new RuntimeError('invalid_argument',
        'reconcile requires cwd, artifactsDir, runIds, workerId, or attemptId');
    }
    // resolve workers to scan
    let workerIds = [];
    if (match.workerId) workerIds = [match.workerId];
    else if (match.attemptId) workerIds = [workerIdForAttempt(match.attemptId)];
    else {
      // find the attempt record owning this artifactsDir/cwd
      let names = [];
      try { names = await fs.readdir(runtimeAttemptsDir); } catch { /* empty */ }
      for (const att of names) {
        const rec = await readRecord(att).catch(() => null);
        if (!rec?.workerId) continue;
        const art = runDirFor(att);
        if (wantArt && normPath(art) === wantArt) workerIds.push(rec.workerId);
        else if (wantCwd && rec.worker?.cwdContainer
          && normPath(rec.worker.cwdContainer) === wantCwd) workerIds.push(rec.workerId);
        else if (wantIds && rec.porchRunId && wantIds.has(rec.porchRunId)) workerIds.push(rec.workerId);
      }
    }
    workerIds = [...new Set(workerIds)];
    const matches = [];
    const workers = [];
    for (const wid of workerIds) {
      const wrec = await workerRecord(wid);
      const st = await call('worker.status', { workerId: wid }).catch((e) => ({ error: e.code || e.message }));
      // 'gone' is positive proof a consumer's allGone orphan gate may act
      // on: confirmed absence ('gone') or a dead pid namespace ('stopped'
      // — exited|dead only). inspect_failed, raw transitional states,
      // 'unknown', and failed status calls are unverifiable, not absent —
      // fail closed. Only a 'running' worker can host a porch list anyway.
      const state = st?.state ?? 'unknown';
      const gone = state === 'gone' || state === 'stopped';
      workers.push({ workerId: wid, state, gone });
      if (state !== 'running') continue;
      const listed = await porchCtl(wid, wrec?.attemptId ?? '',
        ['list', '--all', '--limit', '0', '--json']);
      if (listed.failure || !Array.isArray(listed.parsed)) continue;
      for (const m of listed.parsed) {
        const row = {
          runId: m.run_id ?? null, workerId: wid,
          status: m.status ?? null,
          terminal: TERMINAL_STATUSES.has(m.status),
          cwd: m.cwd ?? null, artifactsDir: m.artifacts_dir ?? null,
          pid: m.pid ?? null, exitCode: m.exit_code ?? null,
        };
        if (wantIds && !(row.runId && wantIds.has(row.runId))) continue;
        if (wantArt && !(row.artifactsDir && normPath(row.artifactsDir) === wantArt)) continue;
        if (wantCwd && !(row.cwd && normPath(row.cwd) === wantCwd)) continue;
        matches.push(row);
      }
    }
    return { ok: true, scannedAt: new Date().toISOString(), matches, workers };
  }

  async function launchRecord(attemptId) {
    assertSafeId('attemptId', attemptId);
    const rec = await readRecord(attemptId);
    if (rec === null) return { attemptId, missing: true, corrupt: false };
    if (rec.corrupt) return { attemptId, missing: false, corrupt: true };
    return {
      attemptId, missing: false, corrupt: false,
      file: recordFile(attemptId),
      schemaVersion: rec.schemaVersion ?? null,
      phase: rec.phase ?? null,
      spawned: rec.spawned === true ? true : rec.spawned === false ? false : null,
      porchRunId: rec.porchRunId ?? null,
      workerId: rec.workerId ?? null,
      worker: rec.worker ?? null,
      profileDigest: rec.profileDigest ?? null,
      diagnostics: rec.launch?.diagnostics ?? null,
      error: rec.error ?? null,
      environment: rec.environment ?? null,
      pi: rec.pi ?? null,
    };
  }

  // Process identity INSIDE the bound worker's pid namespace. A bare pid is
  // meaningless without the worker; this probe runs `proc-probe` in the
  // worker via exec — the controller allowlist permits exactly that argv.
  async function processIdentityFor(workerId, pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const res = await exec(workerId, {
      template: 'proc-probe', args: [String(pid)],
      cwdKey: 'home', timeoutMs: 10_000, maxStdout: 16 * 1024,
    }).catch((e) => ({ ok: false, error: { message: e.message } }));
    if (res.ok === false || res.exitCode !== 0) {
      return { pid, exists: null, state: null, starttime: null, pidNs: null,
        readable: false, alive: null, workerId,
        unverifiable: res?.error?.message || `probe exit ${res?.exitCode}` };
    }
    try {
      const p = JSON.parse(res.stdout.trim());
      const t = p.target || {};
      return {
        pid, workerId,
        exists: t.exists ?? null,
        state: t.state ?? null,
        starttime: t.starttime ?? null,
        pidNs: p.pidNs ?? null,
        hostname: p.hostname ?? null,
        uid: p.uid ?? null,
        readable: t.exists === true,
        alive: t.exists === true && t.state !== 'Z' && t.state !== 'X',
        syscall: t.syscall ?? null,
      };
    } catch {
      return { pid, exists: null, readable: false, alive: null, workerId,
        unverifiable: 'probe_parse_error' };
    }
  }

  // Top-level processIdentity needs the attempt scope (a pid is only
  // meaningful inside a specific worker namespace). Callers that carry the
  // attempt — the scheduler paths — use forAttempt(attemptId).processIdentity.
  // Without scope this is honestly unverifiable, never "absent".
  function processIdentity(pid) {
    return { pid, exists: null, state: null, starttime: null, pidNs: null,
      readable: false, alive: null,
      unverifiable: 'worker_scope_required — use forAttempt(attemptId).processIdentity' };
  }

  async function activityFor(workerId, pid) {
    const p = await processIdentityFor(workerId, pid);
    if (!p || p.exists !== true) {
      return { pid, exists: p?.exists ?? null, readable: false,
        syscall: null, idleWait: null, ioSum: null, cpuSum: null };
    }
    return {
      pid, exists: true, readable: p.readable !== false,
      syscall: p.syscall ?? null,
      idleWait: p.idleWait ?? null,
      ioSum: p.ioSum ?? null,
      cpuSum: p.cpuSum ?? null,
    };
  }

  async function attemptDirState(attemptId) {
    assertSafeId('attemptId', attemptId);
    const rec = await readRecord(attemptId);
    const dir = rec?.workerId
      ? workerAttemptDir(rec.workerId)
      : path.join(runtimeAttemptsDir, attemptId);
    let entries;
    try { entries = await fs.readdir(dir); }
    catch (e) {
      if (e?.code === 'ENOENT') return { attemptId, exists: false, files: [], dir };
      return { attemptId, exists: null, files: [], dir, error: e.code || 'unreadable' };
    }
    return { attemptId, exists: true, files: entries, dir };
  }

  // ---- attempt enumeration + reap evidence (F1 D14) -------------------------
  //
  // Every worker this runtime can have spawned is anchored by a launch
  // record; enumeration covers record-less attempt dirs too (a crash between
  // mkdir and the first record write is a real window). Records are durable
  // under <envRoot>/runtime/attempts and are never deleted.
  async function listAttempts() {
    let names;
    try { names = await fs.readdir(runtimeAttemptsDir); }
    catch (e) {
      if (e?.code === 'ENOENT') return { ok: true, complete: true, attempts: [] };
      throw e;
    }
    const attempts = [];
    for (const attemptId of names.sort()) {
      if (!SAFE_ID_RE.test(attemptId)) continue;
      const rec = await readRecord(attemptId).catch((e) => ({ corrupt: true, readError: e?.code }));
      attempts.push({
        attemptId,
        recordPresent: rec !== null,
        corrupt: rec === null ? false : rec.corrupt === true || !!rec.readError,
        phase: rec?.phase ?? null,
        spawned: rec?.spawned ?? null,
        porchRunId: rec?.porchRunId ?? null,
        workerId: rec?.workerId ?? null,
      });
    }
    return { ok: true, complete: true, attempts };
  }

  // Host-side read of the worker's private porch registry — the same
  // meta.json/state.json `porch status` parses inside the worker, retained
  // on the host bind mount after the container stops. complete===false when
  // ANY row is unreadable: a partial registry can never prove what ran.
  async function registryRunsFor(workerId) {
    const runsDir = path.join(workerAttemptDir(workerId), 'steer', 'runs');
    let names;
    try { names = await fs.readdir(runsDir); }
    catch (e) {
      if (e?.code === 'ENOENT') return { ok: true, complete: true, dirExists: false, rows: [] };
      return { ok: false, complete: false, rows: [], error: e.code || 'unreadable' };
    }
    const rows = [];
    let complete = true;
    for (const dir of names.sort()) {
      const runDir = path.join(runsDir, dir);
      const st = await fs.lstat(runDir).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) {
        complete = false;
        rows.push({ runId: dir, corrupt: 'not_a_run_dir' });
        continue;
      }
      let meta = null;
      try { meta = JSON.parse(await fs.readFile(path.join(runDir, 'meta.json'), 'utf8')); }
      catch (e) {
        complete = false;
        rows.push({ runId: dir, corrupt: e?.code || 'meta_unreadable' });
        continue;
      }
      if (!meta || typeof meta !== 'object') {
        complete = false;
        rows.push({ runId: dir, corrupt: 'meta_unreadable' });
        continue;
      }
      let state = null;
      try { state = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf8')); }
      catch { /* state.json is corroborating evidence; meta.json is the record */ }
      rows.push({
        runId: dir,                       // porch addresses runs by dir name
        metaRunId: meta.run_id ?? null,
        status: meta.status ?? null,
        terminal: TERMINAL_STATUSES.has(meta.status),
        exitCode: meta.exit_code ?? null,
        error: meta.error ?? null,
        pid: Number.isInteger(meta.pid) ? meta.pid : null,
        childPid: Number.isInteger(meta.child_pid) ? meta.child_pid : null,
        childRecorded: Number.isInteger(meta.child_pid),
        startedAt: meta.started_at ?? null,
        finishedAt: meta.finished_at ?? null,
        stateStatus: typeof state?.status === 'string' ? state.status : null,
        stateTerminal: TERMINAL_STATUSES.has(state?.status),
      });
    }
    return { ok: true, complete, dirExists: true, rows };
  }

  // Per-attempt reap verdict — durable audit next to launch.json. writeReap
  // REFUSES to create a missing attempt dir: a reaper write must never make
  // a future runtime.start() collide on its exclusive mkdir.
  const reapFile = (attemptId) => path.join(runtimeAttemptsDir, attemptId, 'reap.json');

  async function readReap(attemptId) {
    assertSafeId('attemptId', attemptId);
    let raw;
    try { raw = await fs.readFile(reapFile(attemptId), 'utf8'); }
    catch (e) {
      if (e?.code === 'ENOENT') return { attemptId, missing: true, corrupt: false, record: null };
      throw e;
    }
    try {
      return { attemptId, missing: false, corrupt: false, record: JSON.parse(raw) };
    } catch {
      return { attemptId, missing: false, corrupt: true, record: null };
    }
  }

  async function writeReap(attemptId, rec) {
    assertSafeId('attemptId', attemptId);
    const st = await fs.stat(path.join(runtimeAttemptsDir, attemptId)).catch(() => null);
    if (!st?.isDirectory()) {
      throw new RuntimeError('reap_dir_missing',
        `attempt dir absent for ${attemptId} — a reap record is only written beside launch evidence`);
    }
    rec.persistedAt = new Date().toISOString();
    await atomicWriteJson(reapFile(attemptId), rec);
    return true;
  }

  async function sessionLog(attemptId) {
    try { assertSafeId('attemptId', attemptId); }
    catch { return { ok: false, code: 'invalid_attempt_id' }; }
    const rec = await readRecord(attemptId).catch(() => null);
    const dir = rec?.pi?.sessionDir;
    if (typeof dir !== 'string' || !dir.startsWith('/')) {
      return { ok: false, code: 'session_dir_unrecorded' };
    }
    const suffix = `_${rec.pi.sessionId || `acp-${attemptId}`}.jsonl`;
    let entries;
    try { entries = await fs.readdir(dir); }
    catch (e) {
      return { ok: false, code: e?.code === 'ENOENT' ? 'session_log_missing' : 'sessions_unreadable' };
    }
    const hits = [];
    for (const e of entries) {
      if (!e.endsWith(suffix)) continue;
      const p = path.join(dir, e);
      try {
        const st = await fs.stat(p);
        if (st.isFile()) hits.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch { /* raced unlink */ }
    }
    if (hits.length !== 1) {
      return { ok: false, code: hits.length ? 'session_log_ambiguous' : 'session_log_missing' };
    }
    return { ok: true, ...hits[0] };
  }

  // Attempt-scoped surface — the shape the scheduler paths actually need.
  function forAttempt(attemptId) {
    const workerId = workerIdForAttempt(assertSafeId('attemptId', attemptId));
    return {
      attemptId, workerId,
      processIdentity: (pid) => processIdentityFor(workerId, pid),
      activity: (pid) => activityFor(workerId, pid),
      sessionLog: () => sessionLog(attemptId),
      attemptDirState: () => attemptDirState(attemptId),
      launchRecord: () => launchRecord(attemptId),
      workerStatus: () => call('worker.status', { workerId }),
      reconcile: (match = {}) => reconcile({ ...match, workerId }),
      stopWorker: () => call('worker.stop', { workerId }),
      removeWorker: () => call('worker.remove', { workerId }),
      registryRuns: () => registryRunsFor(workerId),
      readReap: () => readReap(attemptId),
      writeReap: (rec) => writeReap(attemptId, rec),
    };
  }

  return {
    kind: 'porch-container',
    rootDir, runtimeAttemptsDir, workersDir,
    environment, start, status, events, wait, cancel,
    listRuns, reconcile, launchRecord, processIdentity,
    processIdentityFor, activity: activityFor, attemptDirState, sessionLog,
    listAttempts, registryRunsFor, readReap, writeReap,
    forAttempt, workerIdForAttempt,
    // F3 integrator surface: canonical worktree prepare/status and the
    // private-repo → canonical import — same controller channel, same
    // identity rules as worker.prepare.
    canonicalPrepare: (spec) => call('canonical.prepare', spec),
    canonicalStatus: (canonicalId) => call('canonical.status', { canonicalId }),
    repoImport: (workerId) => call('repo.import', { workerId }),
  };
}
