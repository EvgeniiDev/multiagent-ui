#!/usr/bin/env node
// pi-rpc-boundary.mjs — same-process Pi RPC turn-boundary compatibility layer.
//
// Why this exists: the installed pragmatic-orchestration porch Pi adapter
// (scripts/lib/steer/adapters/pi.py) treats BOTH `turn_end` and `agent_end`
// as completion boundaries. Pi legitimately emits `turn_end` after every
// model turn; a tool-use turn ends with message.stopReason=="toolUse" and a
// new `turn_start` follows. Porch therefore finalized the run at the first
// tool turn ("empty final text", exit 1) and pushed `abort` into a live
// next turn. Observed: run_stony-pine-8669, attempt
// att-run_3d8bc803-9c3a-4d57-9b43-b56d37e47c7d-1.
//
// External plugin sources are read-only, so the boundary adaptation lives
// here instead: porch launches THIS file as the pi binary (PORCH_BIN_PI),
// we become the real pi in-process (dynamic import of the installed cli.js),
// and adapt only the completion-boundary semantics on the stdout event
// stream:
//
//   - `turn_end` frames are held pending disambiguation.
//   - A following `turn_start` means mid-loop: the held frame is re-emitted
//     with type renamed to `turn_boundary` (full original payload preserved,
//     including message.stopReason and toolResults). Porch maps it to a
//     progress event; it cannot trigger completion.
//   - `agent_end`/`agent_settled` means the agent loop is over: the held
//     `turn_end` is emitted VERBATIM (real terminal assistant message text)
//     first, then the agent frame. Porch completes exactly at the real
//     boundary.
//   - Process exit emits a still-held frame as `turn_boundary` (diagnostic
//     evidence only — NEVER verbatim `turn_end`: a crash before `agent_end`
//     must not let porch declare completion, success or otherwise). Porch
//     sees the real exit code and honest failure/abort handling.
//
// Identity contract: there is NO wrapper child. Popen execs this file's
// shebang into node; we import the real pi bundle in the same process, so
// porch's recorded child PID IS the pi process (same pgid, /proc starttime,
// CPU/IO/ep_poll). stdin (prompt/steer/abort/extension_ui responses),
// stderr, and signals are completely untouched; stdout is the only adapted
// fd and only in `--mode rpc`.
//
// Backpressure: pi serializes writes through rawStdoutWriteTail callbacks;
// our patch acknowledges every write immediately and buffers internally, so
// the tail chain can never deadlock behind a held frame. Real fd
// backpressure is still honored (drain queue) for what we emit.
//
// Version guard: the real cli path resolves from PI_RPC_BOUNDARY_REAL_CLI,
// known install locations, or `which pi`. The package version must be
// 0.85.x unless PI_RPC_BOUNDARY_ALLOW_ANY_PI=1; otherwise exit 2 loudly —
// never fake success.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PKG_SUFFIX = '@earendil-works/pi-coding-agent';
const CLI_REL = 'dist/bundle/cli.js';

function fail(msg) {
  try { process.stderr.write(`pi-rpc-boundary: ${msg}\n`); } catch { /* dead stderr */ }
  process.exit(2);
}

function resolveRealCli() {
  const candidates = [];
  if (process.env.PI_RPC_BOUNDARY_REAL_CLI) candidates.push(process.env.PI_RPC_BOUNDARY_REAL_CLI);
  for (const prefix of ['/usr/lib/node_modules', '/usr/local/lib/node_modules']) {
    candidates.push(path.join(prefix, PKG_SUFFIX, CLI_REL));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return fs.realpathSync(c);
  }
  try {
    const which = execFileSync('/usr/bin/which', ['pi'], { encoding: 'utf8' }).trim();
    if (which && fs.existsSync(which)) {
      const real = fs.realpathSync(which);
      if (path.basename(real) === 'cli.js') return real;
    }
  } catch { /* which unavailable */ }
  return null;
}

// Only 0.85.1 is verified (Dockerfile.node pin + host install). Other
// versions fail closed; PI_RPC_BOUNDARY_ALLOW_ANY_PI=1 is the documented
// escape hatch for deliberate re-verification after a pi upgrade.
const VERIFIED_PI_VERSION = '0.85.1';

function guardVersion(cliPath) {
  const pkgPath = path.join(path.dirname(cliPath), '..', '..', 'package.json');
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || version; } catch { /* keep unknown */ }
  const ok = version === VERIFIED_PI_VERSION;
  if (!ok && process.env.PI_RPC_BOUNDARY_ALLOW_ANY_PI !== '1') {
    fail(`unverified pi version ${version} at ${cliPath} (verified pin: ` +
      `${VERIFIED_PI_VERSION}; set PI_RPC_BOUNDARY_ALLOW_ANY_PI=1 to override)`);
  }
  process.stderr.write(`pi-rpc-boundary: active, real pi ${version} at ${cliPath}, pid ${process.pid}\n`);
  return version;
}

function installBoundaryPatch() {
  const origWrite = process.stdout.write.bind(process.stdout);
  const OUTQ_CAP = 32 * 1024 * 1024; // bounded memory if porch stops reading
  let tail = Buffer.alloc(0);   // incomplete-line bytes
  let held = null;              // held turn_end line (Buffer, no trailing \n)
  const outQ = [];              // queued real-stdout writes
  let outQBytes = 0;
  let waitingDrain = false;

  function pump() {
    while (outQ.length && !waitingDrain) {
      const b = outQ.shift();
      outQBytes -= b.length;
      try {
        if (!origWrite(b)) {
          waitingDrain = true;
          process.stdout.once('drain', () => { waitingDrain = false; pump(); });
        }
      } catch { /* dead pipe: porch is gone; nothing honest left to do */ }
    }
  }
  function push(...bufs) {
    for (const b of bufs) { outQ.push(b); outQBytes += b.length; }
    if (outQBytes > OUTQ_CAP) {
      try { process.stderr.write(`pi-rpc-boundary: stdout backlog ${outQBytes}B exceeds cap; aborting\n`); } catch { /* dead */ }
      process.exit(3);
    }
    pump();
  }
  const emit = (line) => push(line, Buffer.from('\n'));

  function heldAsBoundary() {
    const o = JSON.parse(held.toString('utf8'));
    o.type = 'turn_boundary';
    emit(Buffer.from(JSON.stringify(o)));
    held = null;
  }
  const heldVerbatim = () => { emit(held); held = null; };

  function handleLine(line) {
    let t = null;
    try { t = JSON.parse(line.toString('utf8'))?.type; } catch { /* non-JSON */ }
    if (t === 'turn_end') {
      if (held) heldAsBoundary(); // two turn_ends in a row: first was mid-loop
      held = line;
      return;
    }
    if (t === 'turn_start') { if (held) heldAsBoundary(); emit(line); return; }
    if (t === 'agent_end' || t === 'agent_settled') {
      if (held) heldVerbatim();
      emit(line);
      return;
    }
    emit(line);
  }

  process.stdout.write = function patched(chunk, encOrCb, cb) {
    const done = typeof encOrCb === 'function' ? encOrCb : cb;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    tail = Buffer.concat([tail, buf]);
    for (;;) {
      const i = tail.indexOf(0x0a);
      if (i < 0) break;
      const line = tail.subarray(0, i);
      tail = tail.subarray(i + 1);
      try { handleLine(line); } catch { emit(line); } // never swallow a frame
    }
    if (done) queueMicrotask(() => { try { done(); } catch { /* caller cb */ } });
    return true;
  };

  process.on('exit', () => {
    // Synchronous final flush, in order: queued writes, partial tail, then a
    // still-held turn_end as turn_boundary. Verbatim release on exit would
    // falsely look like completion if the turn carried assistant text —
    // success requires the real agent_end/agent_settled boundary.
    const chunks = [...outQ];
    outQ.length = 0;
    // A truncated mid-frame tail + synthetic newline would emit invalid
    // JSONL on porch's reader. Only release it if it parses standalone;
    // otherwise report it on stderr as corruption evidence.
    if (tail.length) {
      let ok = false;
      try { JSON.parse(tail.toString('utf8')); ok = true; } catch { /* truncated */ }
      if (ok) chunks.push(tail, Buffer.from('\n'));
      else {
        try { process.stderr.write(`pi-rpc-boundary: dropped ${tail.length}B incomplete stdout tail\n`); } catch { /* dead */ }
      }
    }
    if (held) {
      try {
        const o = JSON.parse(held.toString('utf8'));
        o.type = 'turn_boundary';
        chunks.push(Buffer.from(JSON.stringify(o)), Buffer.from('\n'));
      } catch {
        chunks.push(held, Buffer.from('\n'));
      }
    }
    for (const c of chunks) { try { fs.writeSync(1, c); } catch { /* dead */ } }
  });
}

const argv = process.argv.slice(2);
const isRpc = argv.some((a, i) => a === '--mode' && argv[i + 1] === 'rpc') ||
  argv.includes('--mode=rpc');

// F1: environment-declared profile flags. When PI_PROFILE_FLAGS_FILE points
// at a JSON array of strings (written by the trusted controller from the
// validated AgentProfile), those flags are APPENDED to argv — they come
// after any caller-supplied options so deployment-mandated constraints
// (--no-extensions, -e allowlist, --tools, --thinking…) always win. The
// file is read-only inside the worker; a malformed file is a hard fail.
function profileFlagsFromEnv() {
  const f = process.env.PI_PROFILE_FLAGS_FILE;
  if (!f) return [];
  let doc;
  try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { fail(`PI_PROFILE_FLAGS_FILE unreadable/malformed: ${e.message}`); }
  if (!Array.isArray(doc) || !doc.every((s) => typeof s === 'string' && s.length)) {
    fail('PI_PROFILE_FLAGS_FILE must be a JSON array of non-empty strings');
  }
  return doc;
}
const profileFlags = profileFlagsFromEnv();

const realCli = resolveRealCli();
if (!realCli) fail('no real pi cli.js found (PI_RPC_BOUNDARY_REAL_CLI, system paths, or which pi)');
guardVersion(realCli);
if (isRpc) installBoundaryPatch();
// Present argv identically to a direct `node cli.js ...` invocation.
process.argv[1] = realCli;
if (profileFlags.length) process.argv.push(...profileFlags);
await import(pathToFileURL(realCli).href);
