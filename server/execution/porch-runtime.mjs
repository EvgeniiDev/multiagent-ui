// server/execution/porch-runtime.mjs — process backend: porch delegate CLI.
//
// One adapter object per execution root. All control of a run happens through
// the public `porch delegate` subcommands in the same OS namespace and UID as
// the launch — porch itself enforces run-dir owner_uid == current uid, so a
// runtime created under a different uid can only observe, not steer.
//
// Import-safe: no spawn, listener, or fs write at module load. Every mutating
// step is explicit in start()/cancel(). See runtime-contract.md.

import { promises as fs, readFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RuntimeError, errResult, spawnBounded, atomicWriteJson, ensureDir,
  assertSafeId, assertRunId, assertAbsDir, assertAbsFile,
  tailOf, normPath, classifyCliError, RUN_ID_RE, DIR_MODE, FILE_MODE,
} from './common.mjs';

const DEFAULT_CONTROL_TIMEOUT_MS = 20_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const WAIT_KILL_GRACE_MS = 8_000;
const CONTROL_MAX_BYTES = 1024 * 1024;      // status/events/cancel/list payloads
const LAUNCH_MAX_BYTES = 256 * 1024;        // handshake stdout/stderr tail
const RESULT_MAX_BYTES = 8 * 1024 * 1024;   // `wait` carries the full final text

// porch resolves model/effort/binaries from env BEFORE config when these are
// set (backend_contract.py MODEL_ENV/EFFORT_ENV/BIN_ENV). An explicit profile
// snapshot is only meaningful if inherited overrides cannot silently win, so
// they are stripped from every child env — including caller-supplied extras.
// PORCH_* routing is wholesale-owned by this runtime.
const SCRUB_ENV = [
  'ACP_BACKEND',
  'CODEX_MODEL', 'CODEX_EFFORT',
  'CLAUDE_MODEL', 'CLAUDE_EFFORT',
  'OPENCODE_MODEL', 'OPENCODE_EFFORT',
  'GROK_MODEL', 'GROK_EFFORT',
  'GEMINI_MODEL',
  'DEVIN_MODEL',
  'PI_MODEL', 'PI_PROVIDER',
];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function defaultRootDir(env = process.env) {
  if (env.ACP_EXEC_DIR) return env.ACP_EXEC_DIR;
  if (env.STATE_DIR) return path.join(env.STATE_DIR, 'execution');
  return path.join(os.homedir(), '.hermes', 'acp-ui-state', 'execution');
}

function defaultPorchPath(env = process.env) {
  if (env.ACP_PORCH_CLI) return env.ACP_PORCH_CLI;
  return path.join(os.homedir(), '.pi', 'agent', 'skills',
    'pragmatic-orchestration', 'scripts', 'porch');
}

// Child env = caller base minus anything that could redirect registry,
// artifacts, or model resolution. `extra` goes through the same filter: a
// smuggled PORCH_STEER_DIR would split the registry and break reconcile.
function buildChildEnv(base, { steerDir, outputDir, runDir = null, configPath = null, extra = {} }) {
  const env = {};
  const dropped = [];
  const admit = ([k, v]) => {
    if (v === undefined) return;
    if (k.startsWith('PORCH_') || SCRUB_ENV.includes(k)) {
      dropped.push(k);
      return;
    }
    env[k] = v;
  };
  for (const e of Object.entries(base)) admit(e);
  env.PORCH_STEER_DIR = steerDir;
  env.PORCH_OUTPUT_DIR = outputDir;
  env.PORCH_SAVE_OUTPUTS = '1';
  if (runDir) env.PORCH_RUN_DIR = runDir;
  if (configPath) env.PORCH_CONFIG = configPath;
  for (const e of Object.entries(extra || {})) admit(e);
  return { env, dropped };
}

function bootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function procNs(ns) {
  try {
    return readlinkSync(`/proc/self/ns/${ns}`);
  } catch {
    return null;
  }
}

// Field 22 of /proc/<pid>/stat — jiffies since boot. comm may contain spaces
// or ')', so fields are counted from the last ')'.
export function procStarttime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).split(' ');
    return fields[19] || null; // field 22 overall
  } catch {
    return null;
  }
}

function extractRunId(stdout) {
  // `delegate --detach` prints the run id alone on stdout; tolerate stray
  // whitespace but never accept a value porch would reject as a path.
  for (const line of String(stdout || '').split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (RUN_ID_RE.test(t)) return t;
  }
  return null;
}

function parseJsonStdout(res) {
  const text = res.stdout.trim();
  if (!text) return { parsed: null };
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return { parsed: null, parseError: true };
  }
}

export function createPorchRuntime(options = {}) {
  const baseEnv = options.env || process.env;
  const rootDir = path.resolve(options.rootDir || defaultRootDir(baseEnv));
  const steerDir = path.join(rootDir, 'steer');
  const outputDir = path.join(rootDir, 'outputs');
  const attemptsDir = path.join(rootDir, 'attempts');
  const porchPath = options.porchPath || defaultPorchPath(baseEnv);
  const launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const resultMaxBytes = options.maxResultBytes ?? RESULT_MAX_BYTES;
  const controlMaxBytes = options.maxControlBytes ?? CONTROL_MAX_BYTES;
  const namespace = options.namespace || 'acp-ui';

  function environment() {
    return {
      namespace,
      backend: 'porch-process',
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      pid: process.pid,
      pidStarttime: procStarttime(process.pid),
      pidNs: procNs('pid'),
      hostname: os.hostname(),
      bootId: bootId(),
      platform: process.platform,
      node: process.version,
      rootDir, steerDir, outputDir, attemptsDir,
      porchPath,
    };
  }

  // Identity of a possibly-foreign process (e.g. a supervisor pid read from
  // registry meta). PID alone is never ownership proof — compare pid,
  // starttime, and pid namespace together before trusting liveness.
  function processIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      starttime: procStarttime(pid),
      pidNs: (() => {
        try { return readlinkSync(`/proc/${pid}/ns/pid`); } catch { return null; }
      })(),
      alive: procStarttime(pid) !== null,
    };
  }

  function controlEnv(extra = {}) {
    return buildChildEnv(baseEnv, { steerDir, outputDir, extra }).env;
  }

  async function porchCtl(args, { timeoutMs = controlTimeoutMs, maxBytes = controlMaxBytes } = {}) {
    const res = await spawnBounded([porchPath, 'delegate', ...args], {
      env: controlEnv(), timeoutMs, maxStdout: maxBytes, maxStderr: LAUNCH_MAX_BYTES,
    });
    if (res.spawnError) {
      return { res, parsed: null, failure: errResult('spawn_error', res.spawnError) };
    }
    if (res.timedOut) {
      return { res, parsed: null, failure: errResult('command_timeout',
        `porch delegate ${args[0]} exceeded ${timeoutMs}ms`) };
    }
    const { parsed, parseError } = parseJsonStdout(res);
    return { res, parsed, parseError, failure: null };
  }

  async function start(params = {}) {
    const attemptId = assertSafeId('attemptId', params.attemptId);
    const profileId = assertSafeId('profileId', params.profileId);
    const cwd = await assertAbsDir('cwd', params.cwd);
    const env0 = environment();
    const attemptDir = path.join(attemptsDir, attemptId);
    const artifactsDir = path.join(attemptDir, 'artifacts');
    const launchFile = path.join(attemptDir, 'launch.json');
    const record = {
      schemaVersion: 1,
      attemptId,
      namespace,
      profileId,
      cwd: normPath(cwd),
      attemptDir,
      artifactsDir,
      phase: 'prepared',
      createdAt: new Date().toISOString(),
      environment: env0,
      configPath: null,
      promptFile: null,
      promptSource: params.promptFile ? normPath(params.promptFile) : 'inline',
      launch: null,
      porchRunId: null,
    };
    // Parents first (a fresh rootDir must work), then an exclusive create so a
    // reused attemptId never merges two launches into one directory.
    await ensureDir(steerDir);
    await ensureDir(outputDir);
    await ensureDir(attemptsDir);
    try {
      await fs.mkdir(attemptDir, { mode: DIR_MODE });
    } catch (e) {
      if (e.code === 'EEXIST') {
        throw new RuntimeError('attempt_exists',
          `attempt dir already exists: ${attemptDir}`);
      }
      throw e;
    }
    const persist = async () => {
      await atomicWriteJson(launchFile, record);
      record.persistedAt = new Date().toISOString();
      return true;
    };
    const failPreLaunch = async (code, message) => {
      record.phase = 'launch_failed';
      record.error = { code, message };
      await persist().catch(() => {});
      return {
        ok: false, phase: 'launch_failed', attemptId, attemptDir, artifactsDir,
        porchRunId: null, error: record.error, environment: env0,
        launchRecord: launchFile,
      };
    };

    // --- pre-launch validation and attempt files (no porch process yet) ---
    let launchEnv = null;
    try {
      const promptPath = path.join(attemptDir, 'prompt.md');
      if (params.promptFile) {
        const src = await assertAbsFile('promptFile', params.promptFile);
        await fs.copyFile(src, promptPath);
        await fs.chmod(promptPath, FILE_MODE).catch(() => {});
      } else if (typeof params.prompt === 'string' && params.prompt.length) {
        await fs.writeFile(promptPath, params.prompt, { mode: FILE_MODE });
      } else {
        return await failPreLaunch('invalid_argument',
          'start requires prompt or promptFile');
      }
      record.promptFile = promptPath;

      // Explicit model/CLI snapshot is mandatory: falling back to the mutable
      // installed config.json would let a later edit change what this attempt
      // resolves. A caller-supplied path is COPIED into the attempt dir so the
      // record is immune to outside edits.
      if (params.config && typeof params.config === 'object') {
        record.configPath = path.join(attemptDir, 'porch-config.json');
        await atomicWriteJson(record.configPath, params.config);
      } else if (params.configPath) {
        const src = await assertAbsFile('configPath', params.configPath);
        record.configPath = path.join(attemptDir, 'porch-config.json');
        await fs.copyFile(src, record.configPath);
        await fs.chmod(record.configPath, FILE_MODE).catch(() => {});
      } else {
        return await failPreLaunch('config_required',
          'start requires an explicit profile snapshot (config or configPath); '
          + 'the installed global porch config is never used implicitly');
      }

      const { env, dropped } = buildChildEnv(baseEnv, {
        steerDir, outputDir,
        runDir: artifactsDir,
        configPath: record.configPath,
        extra: params.env || {},
      });
      launchEnv = env;
      // pi sessions are keyed by (cwd, session-id) where the id defaults to
      // the artifacts dir basename — always 'artifacts' here. Pin it to the
      // attempt so parallel/retried attempts in one cwd stay isolated.
      launchEnv.PORCH_PI_SESSION_ID = `acp-${attemptId}`;
      record.phase = 'launching';
      record.launch = {
        argv: ['delegate', '-a', profileId, '--detach', '--prompt-file', promptPath],
        cwd,
        envOverridesDropped: dropped,
        startedAt: new Date().toISOString(),
      };
      await persist();
    } catch (e) {
      return await failPreLaunch(e.code || 'error', e.message);
    }

    // --- launch handshake: porch exits 0 with the run id on stdout, or the
    // outcome is failed / uncertain. From here on a failure of OUR bookkeeping
    // must never downgrade a possibly-live supervisor to retryable 'failed'.
    const res = await spawnBounded(
      [porchPath, 'delegate', '-a', record.profileId, '--detach',
        '--prompt-file', record.promptFile],
      { cwd, env: launchEnv, timeoutMs: params.launchTimeoutMs ?? launchTimeoutMs,
        maxStdout: LAUNCH_MAX_BYTES, maxStderr: LAUNCH_MAX_BYTES },
    );
    const diag = {
      exitCode: res.code, signal: res.signal, timedOut: res.timedOut,
      observationCut: !!res.observationCut,
      durationMs: res.durationMs,
      stdoutTail: tailOf(res.stdout), stderrTail: tailOf(res.stderr),
      stdoutTruncated: res.stdoutTruncated, stderrTruncated: res.stderrTruncated,
    };
    record.launch.finishedAt = new Date().toISOString();
    record.launch.diagnostics = diag;

    if (res.spawnError) {
      record.phase = 'launch_failed';
      record.error = { code: 'spawn_error', message: res.spawnError };
    } else if (res.timedOut || res.signal) {
      // We killed (or lost) the launcher mid-handshake. A setsid'd supervisor
      // may still register a run; NEVER report failure or silently retry —
      // reconcile() by artifactsDir/cwd is the only honest resolution.
      record.phase = 'launch_uncertain';
      record.error = { code: res.timedOut ? 'launch_timeout' : 'launch_signalled',
        message: res.timedOut
          ? `handshake exceeded ${params.launchTimeoutMs ?? launchTimeoutMs}ms`
          : `launcher killed by ${res.signal}` };
    } else {
      const runId = extractRunId(res.stdout);
      if (res.code === 0 && runId) {
        record.phase = 'launched';
        record.porchRunId = runId;
      } else if (res.code === 0) {
        record.phase = 'launch_uncertain';
        record.error = { code: 'missing_run_id',
          message: 'porch exited 0 but no valid run id on stdout' };
      } else {
        record.phase = 'launch_failed';
        record.error = { code: classifyCliError(res.stderr),
          message: `porch exited ${res.code}: ${tailOf(res.stderr, 1500) || '(no stderr)'}` };
      }
    }
    let persisted = true;
    try {
      await persist();
    } catch (e) {
      persisted = false;
      record.persistError = e.message;
    }
    return {
      ok: record.phase === 'launched',
      phase: record.phase,
      attemptId, attemptDir, artifactsDir,
      porchRunId: record.porchRunId,
      error: record.error || null,
      diagnostics: diag,
      environment: env0,
      launchRecord: launchFile,
      recordPersisted: persisted,
    };
  }

  async function status(runId) {
    assertRunId(runId);
    const { res, parsed, failure } = await porchCtl(['status', runId, '--json']);
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
      process: processIdentity(parsed.pid),
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
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RuntimeError('invalid_argument', `cursor must be an integer >= 0: ${cursor}`);
    }
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new RuntimeError('invalid_argument', `maxEvents must be an integer > 0: ${maxEvents}`);
    }
    const { res, parsed, failure } = await porchCtl(
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
    // The porch-side deadline bounds observation; our kill deadline is
    // strictly later so a due 124 is read from porch output, not a signal.
    const { res, parsed, failure } = await porchCtl(
      ['wait', runId, '--timeout', String(timeoutSec), '--json'],
      { timeoutMs: Math.ceil(timeoutSec * 1000) + WAIT_KILL_GRACE_MS,
        maxBytes: resultMaxBytes });
    if (failure) {
      if (failure.error.code === 'command_timeout') {
        return { runId, ok: false, outcome: 'observer_timeout',
          error: { code: 'command_timeout',
            message: `observer killed after ${timeoutSec}s + grace; run untouched` } };
      }
      return { runId, outcome: 'error', ...failure };
    }
    if (!parsed) {
      return { runId, ok: false, outcome: 'error',
        error: { code: res.code === 124 ? 'parse_error' : classifyCliError(res.stderr),
          message: `wait failed (exit ${res.code})`,
          stderrTail: tailOf(res.stderr) } };
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
    // Terminal snapshot: porch exits with the run's derived code, so a
    // nonzero process exit here is a run outcome, not a command failure.
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

  // Cancellation is by run id through porch — never by signalling a PID, so a
  // recycled pid or a foreign namespace can never receive our cancel.
  async function cancel(runId) {
    assertRunId(runId);
    const { res, parsed, failure } = await porchCtl(['cancel', runId, '--json']);
    if (failure) return { runId, requested: false, ...failure };
    if (res.code === 0 && parsed && parsed.cancel === 'requested') {
      return { ok: true, runId, requested: true };
    }
    return { runId, requested: false,
      ...errResult(classifyCliError(res.stderr),
        `cancel failed (exit ${res.code})`, { stderrTail: tailOf(res.stderr) }) };
  }

  async function listRuns() {
    const { res, parsed, failure } = await porchCtl(['list', '--all', '--limit', '0', '--json']);
    if (failure) return failure;
    if (!Array.isArray(parsed)) {
      return errResult(res.code === 0 ? 'parse_error' : classifyCliError(res.stderr),
        `list failed (exit ${res.code})`, { stderrTail: tailOf(res.stderr) });
    }
    return {
      ok: true,
      runs: parsed.map((m) => ({
        runId: m.run_id ?? null,
        unreadable: m.unreadable ?? null,
        status: m.status ?? null,
        effectiveStatus: m.effective_status ?? null,
        terminal: TERMINAL_STATUSES.has(m.status),
        agentId: m.agent_id ?? null,
        backend: m.backend ?? null,
        model: m.model ?? null,
        cwd: m.cwd ?? null,
        artifactsDir: m.artifacts_dir ?? null,
        detachLog: m.detach_log ?? null,
        pid: m.pid ?? null,
        pidAlive: m.pid_alive ?? null,
        startedAt: m.started_at ?? null,
        finishedAt: m.finished_at ?? null,
        exitCode: m.exit_code ?? null,
        error: m.error ?? null,
      })),
    };
  }

  // Re-discover runs after an uncertain launch or a restart. EVERY supplied
  // selector must match — an old run in the same worktree is not evidence
  // about the current attempt. The unique per-attempt artifacts dir is the
  // strongest selector; cwd alone only narrows. Zero matches means "no live
  // run found" — it permits a retry only once the launcher is provably gone.
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
    if (!listed.ok) return listed;
    const matches = listed.runs.filter((r) => {
      if (wantIds && !(r.runId && wantIds.has(r.runId))) return false;
      if (wantArt && !(r.artifactsDir && normPath(r.artifactsDir) === wantArt)) return false;
      if (wantCwd && !(r.cwd && normPath(r.cwd) === wantCwd)) return false;
      return true;
    });
    return {
      ok: true,
      scannedAt: new Date().toISOString(),
      totalRuns: listed.runs.length,
      matches,
    };
  }

  return {
    kind: 'porch-process',
    rootDir, steerDir, outputDir, attemptsDir, porchPath,
    environment, processIdentity, start, status, events, wait, cancel,
    listRuns, reconcile,
  };
}

// Test seam: env construction and id extraction are pure helpers, exported
// for offline verification without launching porch.
export const _internals = { buildChildEnv, defaultRootDir, defaultPorchPath, extractRunId, SCRUB_ENV };
