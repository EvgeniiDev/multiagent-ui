#!/usr/bin/env node
// E2E: heartbeat, liveness sweep, reconnect re-claim and steer in
// server/acp-ws-bridge.mjs — the companion to e2e_bridge_routing.mjs.
//
//   bridge A (--idle-timeout-ms 4000 --ws-ping-interval-ms 400):
//     1. $/ping notification -> $/pong on the SAME socket only (B sees none);
//        a $/ping carrying an id is answered directly {pong:true}; the mock
//        agent's stdin never sees a $/-method (asserted via debug/seen).
//     3. A healthy ws client auto-pongs protocol pings and stays usable
//        across >=2 sweep intervals.
//     4. A paused (half-open) socket is terminated by the sweep; its session
//        claim is dropped — a cancel-echo for sess-x then reaches B via the
//        broadcast fallback.
//     5. Reconnect re-claim: load sess-a, close, load again on a new socket —
//        the replay goes to the new socket only; other clients see zero.
//     6. Steer: a slow prompt, then session/cancel, then a second prompt —
//        the first resolves 'cancelled', the second 'end_turn', both on the
//        asking socket.
//
//   bridge B (--idle-timeout-ms 3000): watchdog-vs-keepalive —
//     2. $/ping every ~500 ms must NOT mask the watchdog: a prompt the agent
//        never answers still fails with "no traffic for Ns" near the idle
//        limit. Regression test for the keepalive-counts-as-traffic trap.
//
// Usage: node scripts/e2e_bridge_heartbeat.mjs
// Prints PASS/FAIL per assertion, exits non-zero on any failure.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'server', 'acp-ws-bridge.mjs');
const AGENT = path.join(ROOT, 'scripts', 'e2e_bridge_heartbeat_agent.mjs');

const results = [];
function check(name, ok, extra = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

// `ws` is a global/system module on the deploy hosts, not a project dep —
// probe the usual spots, and hand the same node_modules dir to the bridge
// child via NODE_PATH so its own `require('ws')` resolves.
function loadWs() {
  const req = createRequire(import.meta.url);
  const guesses = [
    'ws',
    `${os.homedir()}/.local/lib/node_modules/ws`,
    '/usr/local/lib/node_modules/ws',
    '/usr/lib/node_modules/ws',
  ];
  for (const g of guesses) {
    try {
      const mod = req(g);
      return { mod, entry: req.resolve(g) };
    } catch { /* next */ }
  }
  throw new Error("cannot resolve the 'ws' module — set NODE_PATH and retry");
}

const { mod: wsModule, entry: wsEntry } = loadWs();
const { WebSocket } = wsModule;
const WS_NODE_MODULES = wsEntry.includes(`${path.sep}node_modules${path.sep}`)
  ? wsEntry.split(`${path.sep}node_modules${path.sep}`)[0] + `${path.sep}node_modules`
  : path.dirname(wsEntry);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One JSON-RPC client on the bridge socket; records every inbound frame. */
class Client {
  constructor(port, tag) {
    this.tag = tag;
    this.port = port;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.frames = [];
  }
  open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/`);
    this.ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try { msg = JSON.parse(t); } catch { continue; }
        this.frames.push(msg);
        if (msg.id !== undefined && msg.method === undefined) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        }
      }
    });
    this.ws.on('close', () => {
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error('socket closed'));
      }
    });
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }
  call(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs).unref?.();
    });
  }
  /** A JSON-RPC notification — no id, no response expected. */
  notify(method, params = {}) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  sessionUpdates(sessionId) {
    return this.frames.filter(
      (f) => f.method === 'session/update' && f.params?.sessionId === sessionId
    );
  }
  pongs() {
    return this.frames.filter((f) => f.method === '$/pong');
  }
  /** Poll `frames` until `pred` matches or the deadline passes. */
  async waitFor(pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  }
  async waitForCount(pred, n, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.frames.filter(pred).length >= n) return true;
      await sleep(25);
    }
    return false;
  }
  close() {
    try { this.ws.terminate(); } catch { /* ignore */ }
  }
}

/** Spawn the real bridge + mock agent. Returns { proc, logBuf }. */
async function spawnBridge(port, idleMs, wsPingMs) {
  const proc = spawn(
    process.execPath,
    [BRIDGE, '--port', String(port), '--cmd', `${process.execPath} ${AGENT}`,
     '--root', os.tmpdir(), '--idle-timeout-ms', String(idleMs),
     '--ws-ping-interval-ms', String(wsPingMs)],
    {
      env: { ...process.env, NODE_PATH: WS_NODE_MODULES, ACP_TOKEN_METER: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  proc.stderr.on('data', (d) => process.stderr.write(`[bridge:${port}] ${d}`));
  const log = { text: '' };
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('bridge never listened')), 10000);
    proc.stdout.on('data', (d) => {
      log.text += d.toString();
      process.stdout.write(`[bridge:${port}] ${d}`);
      if (d.toString().includes('listening')) {
        clearTimeout(to);
        resolve();
      }
    });
    proc.once('exit', (c) => reject(new Error(`bridge exited early code=${c}`)));
  });
  return { proc, log };
}

/** Wait until `log.text` gains a line matching `re` after `from` chars. */
async function waitForLog(log, re, from = 0, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = re.exec(log.text.slice(from));
    if (m) return m;
    await sleep(50);
  }
  return null;
}

const tryCall = (p) => p.then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, r: e }));

async function main() {
  // ------------------------------------------------------------------
  // Bridge A: heartbeat routing, sweep, reconnect re-claim, steer.
  // ------------------------------------------------------------------
  const portA = await freePort();
  const A = await spawnBridge(portA, 4000, 400);
  const clients = [];
  const track = (c) => { clients.push(c); return c; };
  try {
    // -- 1. $/ping -> $/pong on the asking socket only -------------------
    const a = track(new Client(portA, 'A'));
    const b = track(new Client(portA, 'B'));
    await a.open();
    await b.open();
    await tryCall(a.call('initialize', { protocolVersion: 1 }));
    await tryCall(b.call('initialize', { protocolVersion: 1 }));

    a.notify('$/ping', { nonce: 'n1' });
    const pong = await a.waitFor((f) => f.method === '$/pong', 2000);
    check('1: $/ping -> $/pong on the asking socket',
      !!pong && pong.params?.nonce === 'n1' && typeof pong.params?.ts === 'number',
      pong ? JSON.stringify(pong.params) : 'no pong');
    await sleep(150);
    check('1: $/pong never leaks to other sockets', b.pongs().length === 0,
      `${b.pongs().length} pongs on B`);

    const pingReq = await tryCall(a.call('$/ping', {}, 3000));
    check('1: $/ping with an id answered directly (no id rewrite)',
      pingReq.ok && pingReq.r?.pong === true, pingReq.ok ? '' : String(pingReq.r));

    const seen = await tryCall(a.call('debug/seen', {}, 3000));
    const methods = seen.r?.methods ?? [];
    check('1: agent stdin never sees a $/-frame',
      seen.ok && Array.isArray(methods) && methods.every((m) => !m.startsWith('$/')),
      seen.ok ? `methods=${JSON.stringify(methods)}` : String(seen.r));

    // -- 3. Sweep keeps healthy sockets ----------------------------------
    // A ws client auto-answers protocol pings; across >=2 sweep intervals a
    // healthy socket must be neither terminated nor wedged.
    const c = track(new Client(portA, 'C'));
    await c.open();
    await sleep(1200); // 3 sweeps at 400 ms
    const initC = await tryCall(c.call('initialize', { protocolVersion: 1 }, 3000));
    check('3: healthy socket still resolves after >=2 sweeps',
      initC.ok && c.ws.readyState === 1, initC.ok ? '' : String(initC.r));
    check('3: sweep terminated nobody',
      !/ws sweep: terminating/.test(A.log.text));

    // -- 4. Half-open socket swept; claim dropped -------------------------
    const d = track(new Client(portA, 'D'));
    await d.open();
    const loadX = await tryCall(d.call('session/load', { sessionId: 'sess-x' }, 3000));
    check('4: D claims sess-x', loadX.ok);
    const logMark = A.log.text.length;
    // Freeze the socket: the client never reads the protocol ping, never
    // pongs — the sweep must convict it within ~2 intervals.
    d.ws._socket.pause();
    const swept = await waitForLog(A.log, /client closed/, logMark, 5000);
    check('4: paused socket terminated by the sweep', !!swept,
      swept ? '' : `no 'client closed' within 5s; log tail: ${A.log.text.slice(-200)}`);
    check('4: sweep logged the termination',
      /ws sweep: terminating/.test(A.log.text.slice(logMark)));
    // The dead claim is gone: a session/cancel for sess-x names a session B
    // never drove, so its echo only reaches B via the broadcast fallback.
    b.notify('session/cancel', { sessionId: 'sess-x' });
    const echo = await b.waitFor(
      (f) => f.method === 'session/update' && f.params?.sessionId === 'sess-x',
      2000
    );
    check('4: dropped claim -> sess-x frame falls back to broadcast', !!echo);

    // -- 5. Reconnect re-claim --------------------------------------------
    const e = track(new Client(portA, 'E'));
    await e.open();
    const loadA1 = await tryCall(e.call('session/load', { sessionId: 'sess-a' }, 3000));
    check('5: E claims sess-a', loadA1.ok);
    const before = A.log.text.length;
    try { e.ws.close(); } catch { /* ignore */ }
    await waitForLog(A.log, /client closed/, before, 3000);
    const e2 = track(new Client(portA, 'E2'));
    await e2.open();
    const loadA2 = await tryCall(e2.call('session/load', { sessionId: 'sess-a' }, 3000));
    check('5: re-load on a fresh socket resolves', loadA2.ok,
      loadA2.ok ? '' : String(loadA2.r));
    check('5: replay routed to the NEW socket',
      e2.sessionUpdates('sess-a').length >= 4,
      `${e2.sessionUpdates('sess-a').length} frames`);
    await sleep(150);
    check('5: zero sess-a frames leaked to bystanders',
      b.sessionUpdates('sess-a').length === 0,
      `${b.sessionUpdates('sess-a').length} leaked`);

    // -- 6. Steer: cancel-then-prompt -------------------------------------
    const f = track(new Client(portA, 'F'));
    await f.open();
    const slow = f.call('session/prompt',
      { sessionId: 'sess-b', prompt: [{ type: 'text', text: 'slow' }], slow: true },
      10000);
    // Wait until the drip is actually running before steering.
    await f.waitForCount(
      (fr) => fr.method === 'session/update' && fr.params?.sessionId === 'sess-b',
      2, 3000
    );
    f.notify('session/cancel', { sessionId: 'sess-b' });
    const second = f.call('session/prompt',
      { sessionId: 'sess-b', prompt: [{ type: 'text', text: 'steered' }] }, 5000);
    const slowRes = await tryCall(slow);
    check('6: cancelled prompt resolves stopReason=cancelled',
      slowRes.ok && slowRes.r?.stopReason === 'cancelled',
      slowRes.ok ? JSON.stringify(slowRes.r) : String(slowRes.r));
    const secondRes = await tryCall(second);
    check('6: second prompt resolves stopReason=end_turn',
      secondRes.ok && secondRes.r?.stopReason === 'end_turn',
      secondRes.ok ? '' : String(secondRes.r));
    await sleep(150);
    check('6: sess-b frames stayed on the asking socket',
      b.sessionUpdates('sess-b').length === 0,
      `${b.sessionUpdates('sess-b').length} leaked`);
  } finally {
    for (const c of clients) c.close();
    A.proc.kill('SIGKILL');
  }

  // ------------------------------------------------------------------
  // Bridge B: the watchdog must not be masked by keepalive pings.
  // ------------------------------------------------------------------
  const portB = await freePort();
  const B = await spawnBridge(portB, 3000, 400);
  const g = new Client(portB, 'G');
  let pingTimer = null;
  try {
    await g.open();
    await tryCall(g.call('initialize', { protocolVersion: 1 }));
    // Keepalives every ~500 ms — the regression trap: these used to re-arm
    // lastTrafficAt forever and make the watchdog unreachable.
    pingTimer = setInterval(() => {
      try { g.notify('$/ping'); } catch { /* socket may be gone */ }
    }, 500);
    const t0 = Date.now();
    const hung = await tryCall(
      g.call('session/prompt',
        { sessionId: 'sess-hang', prompt: [{ type: 'text', text: 'hi' }], hang: true },
        25000)
    );
    const elapsed = Date.now() - t0;
    const msg = hung.r instanceof Error ? hung.r.message : JSON.stringify(hung.r);
    check('2: hung prompt fails "no traffic for Ns" DESPITE flowing $/pings',
      !hung.ok && /no traffic for \d+s/.test(msg),
      `elapsed=${elapsed}ms msg=${msg.slice(0, 120)}`);
    check('2: failure near the idle limit (3000ms)', elapsed >= 2000 && elapsed < 12000,
      `elapsed=${elapsed}ms`);
    check('2: $/pongs were flowing the whole window', g.pongs().length >= 2,
      `${g.pongs().length} pongs`);
    await sleep(300);
    check('2: bridge log shows the watchdog fire',
      /watchdog: no traffic for \d+s/.test(B.log.text));
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    g.close();
    B.proc.kill('SIGKILL');
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.log(`FAIL  ${e.message}`);
  process.exit(1);
});
