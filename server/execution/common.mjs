// server/execution/common.mjs — shared primitives for execution runtimes.
//
// Zero dependencies, import-safe: nothing here spawns, binds, or touches the
// filesystem at module load. Used by porch-runtime.mjs and fake-runtime.mjs.
// Contract: server/execution/runtime-contract.md.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

// porch run ids are `run_<word>-<word>-<hex>` (human_id) or `run_<hex32>`
// (uuid fallback). Registry itself rejects ids containing '/', '\', '..' or
// a leading '.', so we accept only a strict safe superset shape.
export const RUN_ID_RE = /^run_[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class RuntimeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function errResult(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

export function assertSafeId(kind, value) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new RuntimeError('invalid_argument', `${kind} must match ${SAFE_ID_RE}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new RuntimeError('invalid_run_id', `invalid porch run id: ${JSON.stringify(runId)}`);
  }
  return runId;
}

export async function assertAbsDir(kind, p) {
  if (typeof p !== 'string' || !p.startsWith('/')) {
    throw new RuntimeError('invalid_argument', `${kind} must be an absolute path: ${JSON.stringify(p)}`);
  }
  const st = await fs.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new RuntimeError('invalid_argument', `${kind} is not an existing directory: ${p}`);
  }
  return p;
}

export async function assertAbsFile(kind, p) {
  if (typeof p !== 'string' || !p.startsWith('/')) {
    throw new RuntimeError('invalid_argument', `${kind} must be an absolute path: ${JSON.stringify(p)}`);
  }
  const st = await fs.stat(p).catch(() => null);
  if (!st || !st.isFile()) {
    throw new RuntimeError('invalid_argument', `${kind} is not an existing file: ${p}`);
  }
  return p;
}

export async function ensureDir(dir, mode = DIR_MODE) {
  await fs.mkdir(dir, { recursive: true, mode });
  await fs.chmod(dir, mode).catch(() => {});
  return dir;
}

export async function atomicWriteFile(path, data, mode = FILE_MODE) {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${path.split(sep).pop()}.${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, { mode });
  try {
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  await fs.chmod(path, mode).catch(() => {});
}

export function atomicWriteJson(path, obj, mode = FILE_MODE) {
  return atomicWriteFile(path, JSON.stringify(obj, null, 2) + '\n', mode);
}

export function tailOf(text, max = 4000) {
  const s = String(text ?? '');
  return s.length <= max ? s : `…[truncated ${s.length - max} chars] ` + s.slice(-max);
}

// Normalize a path for equality checks without touching the filesystem:
// absolute resolution + trailing-separator strip only (no realpath — the
// caller's namespace may not share our mounts).
export function normPath(p) {
  if (typeof p !== 'string' || !p) return '';
  const r = resolve(p);
  return r === sep ? r : r.replace(/[\\/]+$/, '');
}

// Classify porch control-command stderr into stable error codes.
export function classifyCliError(stderr) {
  const s = String(stderr || '');
  if (/run is terminal/i.test(s)) return 'already_terminal';
  if (/invalid run id/i.test(s)) return 'invalid_run_id';
  if (/unknown run/i.test(s)) return 'unknown_run';
  if (/supervisor pid .* (is )?dead|supervisor_dead/i.test(s)) return 'supervisor_dead';
  if (/owned by different uid|owner uid .* !=|dir owner .* !=/i.test(s)) return 'uid_mismatch';
  if (/symlink/i.test(s)) return 'unsafe_symlink';
  if (/corrupt (meta|state)|cannot read delegate events/i.test(s)) return 'corrupt_registry';
  if (/config not found|invalid JSON|unknown agent id|cannot delegate|review-only/i.test(s)) return 'config_error';
  if (/no task prompt|prompt source not readable|requires/i.test(s)) return 'usage_error';
  return 'cli_error';
}

// Run argv[0] with args — never through a shell. Captures stdout/stderr with
// hard byte caps and a wall-clock bound. On timeout the DIRECT child is
// SIGTERMed then SIGKILLed; we never signal a process group, so a detached
// porch supervisor (setsid'd, disowned) is untouched — the caller reports
// launch uncertainty instead of pretending a kill happened.
//
// Settlement is also bounded: 'exit' means the child is dead even when a
// detached descendant still holds the inherited pipe write-ends open, which
// would stall 'close' forever. After exit we drain pipes only for
// settleGraceMs, then destroy them and report observationCut so a truncated
// tail is never mistaken for complete output.
export function spawnBounded(argv, opts = {}) {
  const {
    cwd = undefined,
    env = undefined,
    timeoutMs = 30_000,
    killGraceMs = 2_000,
    settleGraceMs = 2_000,
    maxStdout = 256 * 1024,
    maxStderr = 256 * 1024,
    input = undefined,
    // Synchronous hook invoked the moment a child handle exists — callers use
    // it to durably record the launcher's identity (pid) BEFORE the handshake
    // resolves; a supervisor may only be registered after this point, so the
    // record is the anchor for post-crash termination proof.
    onSpawn = undefined,
  } = opts;
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolvePromise({ ok: false, spawnError: e.message, code: null, signal: null,
        timedOut: false, observationCut: false, stdout: '', stderr: '',
        stdoutTruncated: false, stderrTruncated: false,
        durationMs: Date.now() - startedAt });
      return;
    }
    const childPid = child.pid ?? null;
    if (onSpawn) {
      try { onSpawn(child); } catch { /* observers never break the child */ }
    }
    let out = Buffer.alloc(0), err = Buffer.alloc(0);
    let outTrunc = false, errTrunc = false;
    let timedOut = false, settled = false;
    let killTimer = null, settleTimer = null;
    const append = (buf, chunk, max, truncated) => {
      if (truncated) return [buf, true];
      const next = Buffer.concat([buf, chunk]);
      return next.length <= max ? [next, false] : [next.subarray(0, max), true];
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      // Drop pipe handles so held-open descendant fds cannot keep us (or the
      // event loop) alive past settlement.
      for (const s of [child.stdout, child.stderr, child.stdin]) {
        try { s?.removeAllListeners('data'); s?.destroy(); } catch { /* ignore */ }
      }
      resolvePromise({ durationMs: Date.now() - startedAt, ...result });
    };
    const payload = (code, signal, observationCut) => ({
      ok: true, code, signal, timedOut, observationCut, pid: childPid,
      stdout: out.toString('utf8'), stderr: err.toString('utf8'),
      stdoutTruncated: outTrunc, stderrTruncated: errTrunc,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => { [out, outTrunc] = append(out, d, maxStdout, outTrunc); });
    child.stderr.on('data', (d) => { [err, errTrunc] = append(err, d, maxStderr, errTrunc); });
    // EPIPE/destroy while writing input to a child that exited early is
    // reported through the exit/close path, not as an unhandled stream error.
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish({
      ok: false, spawnError: e.message, code: null, signal: null,
      timedOut, observationCut: false, pid: childPid,
      stdout: out.toString('utf8'), stderr: err.toString('utf8'),
      stdoutTruncated: outTrunc, stderrTruncated: errTrunc,
    }));
    child.on('exit', (code, signal) => {
      // Our stdin write-end is a pipe 'close' waits on; a dead child leaves
      // it broken (EPIPE) rather than closed — destroy it so a routine exit
      // resolves through 'close' instead of burning the settle window.
      try { child.stdin.destroy(); } catch { /* ignore */ }
      settleTimer = setTimeout(() => finish(payload(code, signal, true)), settleGraceMs);
      settleTimer.unref?.();
    });
    child.on('close', (code, signal) => finish(payload(code, signal, false)));
    try {
      if (input !== undefined) {
        child.stdin.write(input, () => { try { child.stdin.end(); } catch { /* gone */ } });
      } else {
        child.stdin.end();
      }
    } catch { /* child already gone; exit/close reports the outcome */ }
  });
}
