// server/execution/porch-runtime.mjs — process backend: porch delegate CLI.
//
// One adapter object per execution root. All control of a run happens through
// the public `porch delegate` subcommands in the same OS namespace and UID as
// the launch — porch itself enforces run-dir owner_uid == current uid, so a
// runtime created under a different uid can only observe, not steer.
//
// Import-safe: no spawn, listener, or fs write at module load. Every mutating
// step is explicit in start()/cancel(). See runtime-contract.md.

import { promises as fs, readFileSync, readlinkSync, statSync } from 'node:fs';
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

function procNsOf(ns, pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/${ns}`);
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

// /proc/<pid>/syscall — first token is either 'running' or the syscall
// number (e.g. 232 = epoll_wait on x86_64). Used by the stuck detector: a
// supervisor parked in a wait-syscall with zero IO/CPU delta is evidence;
// 'running' or an unreadable probe is never evidence.
const IDLE_WAIT_SYSCALLS = new Set(['7', '23', '61', '232', '270', '271', '407']);
function procSyscall(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/syscall`, 'utf8').trim();
    if (!raw) return { token: null, readable: false };
    const token = raw.split(/\s+/)[0] ?? null;
    return { token, readable: true };
  } catch (e) {
    return { token: null, readable: false, code: e?.code ?? null };
  }
}

function procIo(pid) {
  // Every counter /proc/<pid>/io exposes — the delta check must see ALL io,
  // not just byte streams (a stalled-on-write process still shows syscw).
  try {
    const raw = readFileSync(`/proc/${pid}/io`, 'utf8');
    let sum = 0;
    for (const line of raw.split('\n')) {
      const m = /^[a-z_]+:\s*(\d+)/.exec(line);
      if (m) sum += Number(m[1]);
    }
    return { sum, readable: true };
  } catch (e) {
    return { sum: null, readable: false, code: e?.code ?? null };
  }
}

// utime+stime (fields 14+15) from /proc/<pid>/stat — CPU jiffies consumed.
function procCpu(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return { cpu: null, readable: false };
    const fields = stat.slice(close + 2).split(' ');
    const utime = Number(fields[11]); // field 14 overall
    const stime = Number(fields[12]); // field 15 overall
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
      return { cpu: null, readable: false };
    }
    return { cpu: utime + stime, readable: true };
  } catch (e) {
    return { cpu: null, readable: false, code: e?.code ?? null };
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
  // Test seam: the porch subprocess boundary. Tests inject a canned spawn
  // result so start() exercises the REAL record/persist/session-dir path
  // without a porch binary.
  const spawn = options.spawn || spawnBounded;

  function environment() {
    // Per-container-instance identity: the hostname is the Docker container
    // id (compose default), and PID 1 inside our pid namespace is the
    // container init — its starttime changes on every recreate/restart even
    // when the hostname is pinned. The pair {containerId, initStarttime} is
    // stable across a same-container Node restart.
    const containerId = os.hostname() || null;
    const initStarttime = procStarttime(1);
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
      containerId,
      initStarttime,
      envInstance: { containerId, initStarttime },
      platform: process.platform,
      node: process.version,
      rootDir, steerDir, outputDir, attemptsDir,
      porchPath,
    };
  }

  // Identity of a possibly-foreign process (e.g. a supervisor pid read from
  // registry meta, or our own recorded launcher). PID alone is never proof —
  // callers compare pid + starttime + pid namespace, and must distinguish:
  //   exists=false                -> clean ENOENT: process is gone (proof)
  //   exists=null                 -> EACCES/EPERM/EIO on the probe itself:
  //                                  UNVERIFIABLE, never counts as absent
  //   exists,state='Z'            -> zombie: defunct, counts as terminated
  //   exists,readable=false       -> /proc/pid exists but stat unreadable:
  //                                  UNVERIFIABLE, not dead
  //   exists,starttime mismatch   -> pid was recycled (termination proof)
  // `alive` only means "a live entry exists"; it is never a termination proof.
  function processIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // statSync distinguishes errno; existsSync would fold EACCES into "absent".
    let exists;
    try {
      statSync(`/proc/${pid}`);
      exists = true;
    } catch (e) {
      exists = e && e.code === 'ENOENT' ? false : null;
    }
    let state = null;
    let starttime = null;
    let readable = false;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close >= 0) {
        const fields = stat.slice(close + 2).split(' ');
        state = fields[0] || null;
        starttime = fields[19] || null; // field 22 overall
        readable = true;
      }
    } catch (e) {
      // A clean ENOENT here is independent absence evidence; anything else
      // stays unverifiable.
      if (e && e.code === 'ENOENT' && exists !== true) exists = false;
    }
    return {
      pid,
      exists,   // true | false | null(unverifiable)
      state,
      starttime,
      pidNs: procNsOf('pid', pid),
      readable,
      alive: exists === true && state !== 'Z',
    };
  }

  function controlEnv(extra = {}) {
    return buildChildEnv(baseEnv, { steerDir, outputDir, extra }).env;
  }

  async function porchCtl(args, { timeoutMs = controlTimeoutMs, maxBytes = controlMaxBytes } = {}) {
    const res = await spawn([porchPath, 'delegate', ...args], {
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
      // Durable spawn marker. `false` is only ever persisted by pre-spawn
      // rejection paths, which provably never invoked spawnBounded; onSpawn
      // flips it to true at fork. A record showing phase 'launching' with
      // spawned=false is a crash window — nothing is proven either way.
      spawned: false,
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
        // The observer's session-log probe must resolve the dir the LAUNCHED
        // pi actually writes — computed once from the effective launchEnv
        // (base + params.env), persisted here; process.env at read time is
        // never consulted (contract mirrors installed pi session-manager:
        // ENV_SESSION_DIR flat > agentDir/sessions/--<resolved-cwd-slug>--).
        pi: { sessionId: launchEnv.PORCH_PI_SESSION_ID, sessionDir: piSessionDirFor(launchEnv, cwd) },
      };
      await persist();
    } catch (e) {
      return await failPreLaunch(e.code || 'error', e.message);
    }

    // --- launch handshake: porch exits 0 with the run id on stdout, or the
    // outcome is failed / uncertain. From here on a failure of OUR bookkeeping
    // must never downgrade a possibly-live supervisor to retryable 'failed'.
    //
    // The launcher's own identity is captured in onSpawn — synchronously at
    // fork — and persisted into launch.json immediately, so that a controller
    // that dies mid-handshake leaves positive evidence about WHICH process
    // must be proven dead before any retry is legal.
    let launcherWrite = null;
    const res = await spawn(
      [porchPath, 'delegate', '-a', record.profileId, '--detach',
        '--prompt-file', record.promptFile],
      { cwd, env: launchEnv, timeoutMs: params.launchTimeoutMs ?? launchTimeoutMs,
        maxStdout: LAUNCH_MAX_BYTES, maxStderr: LAUNCH_MAX_BYTES,
        onSpawn: (child) => {
          record.spawned = true;
          record.launch.launcher = {
            pid: child.pid ?? null,
            starttime: procStarttime(child.pid),
            pidNs: procNsOf('pid', child.pid),
            capturedAt: new Date().toISOString(),
          };
          launcherWrite = persist().catch(() => false);
        } },
    );
    if (launcherWrite) await launcherWrite;
    const diag = {
      exitCode: res.code, signal: res.signal, timedOut: res.timedOut,
      observationCut: !!res.observationCut,
      durationMs: res.durationMs,
      stdoutTail: tailOf(res.stdout), stderrTail: tailOf(res.stderr),
      stdoutTruncated: res.stdoutTruncated, stderrTruncated: res.stderrTruncated,
    };
    record.launch.finishedAt = new Date().toISOString();
    record.launch.diagnostics = diag;
    if (!record.launch.launcher && Number.isInteger(res.pid)) {
      // 'error'-event spawn path still reports the child pid — keep whatever
      // identity we have; a record without it is "unknown", never "no spawn".
      record.launch.launcher = { pid: res.pid, starttime: null, pidNs: null,
        capturedAt: new Date().toISOString() };
    }

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
      // The recorded childPID is retained verbatim — but a null/absent
      // child_pid is never proof of no child (the serialized status emits
      // the key unconditionally). A positive no-child attestation exists
      // only when the payload carries an explicit `child_spawned:false`.
      childPid: parsed.child_pid ?? null,
      childSpawned: Number.isInteger(parsed.child_pid) ? true
        : (parsed.child_spawned === false ? false : undefined),
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
    // Unreadable registry entries must surface, not vanish: a scan that met
    // unreadable entries is incomplete, and zero clean matches is only
    // meaningful under a complete scan.
    const unreadable = listed.runs
      .filter((r) => r.unreadable)
      .map((r) => ({ runId: r.runId ?? null, unreadable: r.unreadable }));
    return {
      ok: true,
      scannedAt: new Date().toISOString(),
      totalRuns: listed.runs.length,
      matches,
      unreadable,
    };
  }

  // Read our own per-attempt launch record (attempts/<id>/launch.json) —
  // the durable launcher-identity evidence written before/at spawn. A
  // missing or corrupt record is reported as such; it is never proof that
  // no launcher existed.
  async function launchRecord(attemptId) {
    assertSafeId('attemptId', attemptId);
    const file = path.join(attemptsDir, attemptId, 'launch.json');
    let raw;
    try { raw = await fs.readFile(file, 'utf-8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') return { attemptId, missing: true, corrupt: false };
      throw e;
    }
    let rec;
    try { rec = JSON.parse(raw); }
    catch { return { attemptId, missing: false, corrupt: true }; }
    return {
      attemptId, missing: false, corrupt: false, file,
      schemaVersion: rec.schemaVersion ?? null,
      phase: rec.phase ?? null,
      spawned: rec.spawned === true ? true : rec.spawned === false ? false : null,
      porchRunId: rec.porchRunId ?? null,
      launcher: rec.launch?.launcher ?? null,
      diagnostics: rec.launch?.diagnostics ?? null,
      error: rec.error ?? null,
      environment: rec.environment ?? null,
      cwd: rec.launch?.cwd ?? null,
      pi: rec.launch?.pi ?? null,
    };
  }

  // Point-in-time activity probe of a process IN OUR namespace (same /proc).
  // Returns syscall token + IO + CPU counters — a caller compares two samples
  // spaced over the idle window. exists uses the errno-aware tri-state:
  // EACCES/EPERM stay unverifiable, never "absent".
  async function activity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return { pid, exists: null, readable: false };
    let exists;
    try {
      statSync(`/proc/${pid}`);
      exists = true;
    } catch (e) {
      exists = e && e.code === 'ENOENT' ? false : null;
    }
    if (exists !== true) {
      return { pid, exists, readable: false, syscall: null, idleWait: null, ioSum: null, cpuSum: null };
    }
    const sc = procSyscall(pid);
    const io = procIo(pid);
    const cpu = procCpu(pid);
    return {
      pid,
      exists: true,
      readable: sc.readable || io.readable || cpu.readable,
      syscall: sc.token,
      idleWait: sc.readable ? (sc.token === 'running' ? false : IDLE_WAIT_SYSCALLS.has(sc.token)) : null,
      ioSum: io.readable ? io.sum : null,   // null = unreadable, NEVER zero
      cpuSum: cpu.readable ? cpu.cpu : null,
    };
  }

  // Attempt dir presence — the dir is created early inside start(), but a
  // missing dir is NOT by itself proof that start never ran: a live Node
  // may hold an in-flight async start() before its mkdir completes, and a
  // dir may be deleted/unreadable. The only honest never-entered proof is
  // the caller's OWN knowledge (this instance never invoked start for this
  // attemptId, and has no in-flight start) combined with a clean zero-match
  // registry scan; for a FOREIGN owner's attempt, absence is usable only
  // after that owner is positively proven dead.
  async function attemptDirState(attemptId) {
    assertSafeId('attemptId', attemptId);
    const dir = path.join(attemptsDir, attemptId);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      if (e && e.code === 'ENOENT') return { attemptId, exists: false, files: [] };
      return { attemptId, exists: null, files: [], error: e.code || 'unreadable' };
    }
    return { attemptId, exists: true, files: entries };
  }

  // The Pi session jsonl bound to THIS attempt — launches pass the supported
  // `pi --mode rpc --session-id acp-<attemptId>` (see porch
  // backend_run.sh/pi_rpc_oneshot.py); pi writes
  // <sessions-root>/--<cwd-slug>--/<ts>_acp-<attemptId>.jsonl. Used ONLY as a
  // growth metric by the stuck heuristic: the file must live in the dir that
  // encodes the attempt's OWN workspace cwd — a same-named file under another
  // cwd is not this attempt's log. Any read failure, ambiguity, or missing
  // file is `ok:false` (unknown), never zero-growth evidence.
  // Mirrors installed pi session-manager.getDefaultSessionDirPath: the cwd
  // slug is `--${resolvePath(cwd) with / \ : -> -}--` under
  // <agentDir>/sessions. PI_CODING_AGENT_SESSION_DIR (= ENV_SESSION_DIR,
  // honored by installed pi main.js like --session-dir) is a FLAT override —
  // no cwd slug is appended. The porch pi adapter passes the whole env to
  // the pi child unchanged, so whatever reaches launchEnv here is what the
  // launched pi resolves. `~` binds the LAUNCHED HOME and a relative path
  // binds the launch cwd — the same expansion pi applies inside the child.
  const piNormalizePath = (p, { home, cwd }) => {
    const s = String(p);
    if (s === '~') return path.resolve(home);
    if (s.startsWith('~/')) return path.join(path.resolve(home), s.slice(2));
    return path.isAbsolute(s) ? path.resolve(s) : path.resolve(cwd, s);
  };
  const piSessionDirFor = (launchEnv, cwd) => {
    const home = launchEnv.HOME || os.homedir();
    const explicit = launchEnv.PI_CODING_AGENT_SESSION_DIR;
    if (explicit) return piNormalizePath(explicit, { home, cwd });
    const agentDir = launchEnv.PI_CODING_AGENT_DIR
      ? piNormalizePath(launchEnv.PI_CODING_AGENT_DIR, { home, cwd })
      : path.join(home, '.pi', 'agent');
    const slug = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    return path.join(agentDir, 'sessions', slug);
  };
  // Reads the session jsonl for attempt `attemptId` — ONLY through the dir
  // recorded at launch (immutable evidence), never the mutable process env.
  async function sessionLog(attemptId) {
    try {
      assertSafeId('attemptId', attemptId);
    } catch {
      return { ok: false, code: 'invalid_attempt_id' };
    }
    const rec = await launchRecord(attemptId).catch(() => null);
    const dir = rec?.pi?.sessionDir;
    if (typeof dir !== 'string' || !dir.startsWith('/')) {
      // A record predating the pi block (or missing/corrupt) cannot prove a
      // location — unknown, never zero-growth evidence.
      return { ok: false, code: 'session_dir_unrecorded' };
    }
    const suffix = `_${rec.pi.sessionId || `acp-${attemptId}`}.jsonl`;
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      return { ok: false, code: e?.code === 'ENOENT' ? 'session_log_missing' : 'sessions_unreadable' };
    }
    const hits = [];
    for (const e of entries) {
      if (!e.endsWith(suffix)) continue;
      const p = path.join(dir, e);
      try {
        const st = await fs.stat(p);
        if (st.isFile()) hits.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch { /* raced unlink — skip */ }
    }
    if (hits.length !== 1) {
      return { ok: false, code: hits.length ? 'session_log_ambiguous' : 'session_log_missing' };
    }
    return { ok: true, ...hits[0] };
  }

  return {
    kind: 'porch-process',
    rootDir, steerDir, outputDir, attemptsDir, porchPath,
    environment, processIdentity, start, status, events, wait, cancel,
    listRuns, reconcile, launchRecord, activity, attemptDirState, sessionLog,
    IDLE_WAIT_SYSCALLS,
  };
}

// Test seam: env construction and id extraction are pure helpers, exported
// for offline verification without launching porch.
export const _internals = { buildChildEnv, defaultRootDir, defaultPorchPath, extractRunId, SCRUB_ENV };
