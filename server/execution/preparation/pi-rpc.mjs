// server/execution/preparation/pi-rpc.mjs — the preparation lead's CLI
// transport: a `pi --mode rpc` child driven over newline-delimited JSON on
// stdio (plan KTD2, P3).
//
// This module is the WIRE layer only. It spawns exactly one process per
// instance from an argv/env/cwd plan built by P2's planInvocation (or the
// equivalent lead plan in lead.mjs), correlates request/response frames by
// id, surfaces extension_ui_request events for the durable-question seam,
// and reports process exit honestly. It never interprets model text as
// commands and never fabricates answers: an extension_ui_response is sent
// ONLY when the caller supplies the request id + payload recorded against
// a durable question.
//
// Boundedness: stdin writes are serialized, request() has a bounded wait,
// close() SIGTERMs then SIGKILLs within a grace window, and stderr/stdout
// tails are capped so a chatty child cannot grow memory without bound.
// Human wait is NOT handled here at all — the driver parks the turn while
// a dialog is open instead of running a timer against the user.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { RuntimeError } from '../common.mjs';

const STDERR_CAP = 64 * 1024;
const STDOUT_JUNK_CAP = 64 * 1024;
const FRAME_CAP = 2 * 1024 * 1024;   // a single NDJSON line beyond this is corrupt/abusive
const WRITE_DRAIN_MS = 10_000;

function fail(code, msg, extra = {}) {
  throw new RuntimeError(code, msg, extra);
}

export function createPiRpcTransport({
  argv,                       // [command, ...args] — the full spawn argv
  cwd,
  env,
  transcriptPath = null,      // optional JSONL evidence tee (bounded by caller)
  spawnImpl = spawn,
} = {}) {
  if (!Array.isArray(argv) || !argv.length) {
    fail('invalid_argument', 'createPiRpcTransport: argv must be a non-empty array');
  }

  let child = null;
  let exited = null;            // {code, signal} once the process is gone
  let stderrTail = '';
  let junkTail = '';
  let lineBuf = '';
  const queue = [];             // inbound frames awaiting the pump
  const waiters = [];           // pump waiters {resolve, timer}
  const pending = new Map();    // request id -> {resolve, timer}
  let nextId = 1;
  let writing = Promise.resolve();
  let transcript = null;        // lazy createWriteStream
  let closed = false;

  const record = (dir, obj) => {
    if (!transcriptPath) return;
    try {
      transcript ??= createWriteStream(transcriptPath, { flags: 'a', mode: 0o600 });
      transcript.write(JSON.stringify({ dir, ...obj }) + '\n');
    } catch { /* evidence tee failure must never break the protocol */ }
  };

  const pushFrame = (frame) => {
    record('in', frame);
    // Correlate request responses before the pump sees them — a `response`
    // frame carrying the id of an in-flight request resolves it and stays
    // out of the event stream.
    if (frame && frame.type === 'response' && pending.has(frame.id)) {
      const w = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(w.timer);
      w.resolve(frame);
      return;
    }
    if (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve({ frame });
      return;
    }
    queue.push(frame);
  };

  const markExited = (code, signal) => {
    if (exited) return;
    exited = { code, signal };
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve({ exited });
    }
    for (const [id, w] of pending) {
      clearTimeout(w.timer);
      pending.delete(id);
      w.resolve({ type: 'response', id, success: false, error: 'process exited', exit: exited });
    }
    for (const s of [child?.stdout, child?.stderr, child?.stdin]) {
      try { s?.removeAllListeners('data'); s?.destroy(); } catch { /* gone */ }
    }
  };

  const onStdout = (chunk) => {
    lineBuf += chunk.toString('utf8');
    // Overlong partial line — a corrupt peer; cut it rather than grow.
    if (lineBuf.length > FRAME_CAP && !lineBuf.includes('\n')) {
      junkTail = (junkTail + lineBuf).slice(-STDOUT_JUNK_CAP);
      lineBuf = '';
      return;
    }
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch {
        // Non-JSON stdout noise (banners, warnings) is evidence, not events.
        junkTail = (junkTail + line + '\n').slice(-STDOUT_JUNK_CAP);
        record('in-junk', { line: line.slice(0, 2000) });
        continue;
      }
      pushFrame(frame);
    }
  };

  return {
    kind: 'pi-rpc',

    pid: () => child?.pid ?? null,
    alive: () => !!child && exited === null,
    exited: () => exited,
    stderrTail: () => stderrTail,
    stdoutJunkTail: () => junkTail,

    open() {
      if (child) fail('invalid_state', 'transport already opened');
      if (closed) fail('invalid_state', 'transport already closed');
      try {
        child = spawnImpl(argv[0], argv.slice(1), {
          cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        fail('spawn_failed', `cannot spawn ${argv[0]}: ${e.message}`);
      }
      child.stdout.on('data', onStdout);
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_CAP);
      });
      child.stdin.on('error', () => { /* EPIPE after child death — exit reports it */ });
      child.on('error', (e) => markExited(null, `spawn_error:${e.code ?? e.message}`));
      child.on('exit', (code, signal) => markExited(code, signal));
      child.on('close', (code, signal) => markExited(code, signal));
      return { pid: child.pid ?? null };
    },

    // Serialized stdin writes — a process that died mid-write surfaces via
    // exit; a backpressured pipe waits at most WRITE_DRAIN_MS.
    send(frame) {
      record('out', frame);
      const run = writing.then(() => new Promise((resolve, reject) => {
        if (!child || exited || !child.stdin.writable) {
          reject(new RuntimeError('transport_dead', 'the CLI process is gone'));
          return;
        }
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          reject(new RuntimeError('write_stalled', 'stdin write did not drain in time'));
        }, WRITE_DRAIN_MS);
        timer.unref?.();
        try {
          child.stdin.write(JSON.stringify(frame) + '\n', () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e instanceof RuntimeError ? e : new RuntimeError('write_failed', e.message));
        }
      }));
      writing = run.catch(() => {});
      return run;
    },

    prompt(message) {
      return this.send({ type: 'prompt', message });
    },

    // A response frame to an extension_ui_request — the ONLY outbound frame
    // carrying a foreign request id (it answers the CLI's request, it does
    // not open a new one).
    respond(requestId, fields = {}) {
      return this.send({ type: 'extension_ui_response', id: requestId, ...fields });
    },

    abort() {
      return this.send({ type: 'abort' }).catch(() => {});
    },

    // Correlated request → {type:'response', id}. Returns the whole response
    // frame; callers inspect .success/.data. Bounded by timeoutMs; a dead
    // process resolves the waiter as success:false.
    request(command, params = {}, timeoutMs = 10_000) {
      const id = `r${nextId++}`;
      const frame = { type: command, id, ...params };
      return this.send(frame).then(() => new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ type: 'response', id, success: false, error: 'request_timeout', command });
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, timer });
      }));
    },

    getState(timeoutMs = 10_000) {
      return this.request('get_state', {}, timeoutMs).then((r) => r?.data ?? null);
    },

    // The pump's read: next frame, bounded wait, or process death. Dead +
    // drained queue → {exited}. timeoutMs=null waits forever (the driver
    // uses this only when the turn is blocked on a human — never a runtime
    // timeout).
    nextFrame(timeoutMs = null) {
      if (queue.length) return Promise.resolve({ frame: queue.shift() });
      if (exited) return Promise.resolve({ exited });
      return new Promise((resolve) => {
        const w = { resolve, timer: null };
        if (timeoutMs !== null) {
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            resolve({ timeout: true });
          }, timeoutMs);
          w.timer.unref?.();
        }
        waiters.push(w);
      });
    },

    async close() {
      if (closed) return { exited: exited ?? { code: null, signal: 'closed' } };
      closed = true;
      const c = child;
      if (!c) return { exited: { code: null, signal: 'never_started' } };
      try { c.stdin.destroy(); } catch { /* gone */ }
      if (!exited) {
        try { c.kill('SIGTERM'); } catch { /* already gone */ }
        const deadline = Date.now() + 2_000;
        while (!exited && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
        if (!exited) {
          try { c.kill('SIGKILL'); } catch { /* already gone */ }
          const d2 = Date.now() + 1_000;
          while (!exited && Date.now() < d2) {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
      }
      markExited(exited?.code ?? null, exited?.signal ?? 'closed');
      try { transcript?.end(); } catch { /* evidence only */ }
      return { exited };
    },
  };
}
