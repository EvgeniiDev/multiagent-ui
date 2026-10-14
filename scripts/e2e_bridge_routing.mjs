#!/usr/bin/env node
// E2E: per-session routing in deploy/acp-ws-bridge.mjs.
//
// One bridge, one shared agent child, TWO WebSocket clients — the real
// deployment shape behind the "second tab hangs" bug: before routing,
// broadcast() delivered every agent frame to every socket, so tab A's
// `session/load` replay stormed into tab B's chat.
//
//   client A: initialize -> session/load sess-a (mock drips 60 chunks)
//   client B: connects mid-replay -> initialize -> session/new -> prompt
//
// Asserts:
//   * B receives ZERO session/update frames for sess-a
//   * A receives ZERO session/update frames for B's session (symmetric)
//   * B's initialize/new/prompt all resolve WHILE A's replay still streams
//   * A receives the full 60-chunk replay and its load response
//   * a session/update for an UNCLAIMED session still reaches both
//     (broadcast fallback unchanged)
//
// Usage: node scripts/e2e_bridge_routing.mjs
// Prints PASS/FAIL per assertion, exits non-zero on any failure.

import { testEnv, stopTestBridge } from './bridge-test-harness.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'deploy', 'acp-ws-bridge.mjs');
const AGENT = path.join(ROOT, 'scripts', 'e2e_bridge_routing_agent.mjs');

const REPLAY_CHUNKS = 60; // keep in sync with the mock agent
const PROMPT_CHUNKS = 3;

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
  : path.dirname(wsEntry); // resolved to a bare dir — ws sits next to it anyway

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One JSON-RPC client on the bridge socket; records every inbound frame.
 * The socket is created lazily in open() — a WebSocket built in the
 * constructor would connect before the caller wants it on the wire. */
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
  sessionUpdates(sessionId) {
    return this.frames.filter(
      (f) => f.method === 'session/update' && f.params?.sessionId === sessionId
    );
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-routing-'));
  const env = await testEnv(temp, 'docker');
  let port;
  const bridge = spawn(
    process.execPath,
    [BRIDGE, '--port', '0', '--bind', '127.0.0.1', '--required-mode', 'docker', '--cmd', `${process.execPath} ${AGENT}`,
     '--root', os.tmpdir()],
    {
      env: {
        ...env,
        NODE_PATH: WS_NODE_MODULES,
        ACP_TOKEN_METER: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  let output = '';
  try { await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('bridge never listened')), 10000);
    bridge.stdout.on('data', (d) => {
      output += d.toString();
      process.stdout.write(`[bridge] ${d}`);
      if (d.toString().includes('listening')) {
        clearTimeout(to);
        resolve();
      }
    });
    bridge.once('exit', (c) => reject(new Error(`bridge exited early code=${c}`)));
  });

  } catch (error) { await stopTestBridge(bridge); await rm(temp, { recursive: true, force: true }); throw error; }
  port = Number(output.match(/listening on :(\d+)/)[1]);
  const a = new Client(port, 'A');
  const b = new Client(port, 'B');
  const tryCall = (p) => p.then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, r: e }));
  try {
    await a.open();
    const initA = await tryCall(a.call('initialize', { protocolVersion: 1 }));
    check('A: initialize resolves', initA.ok && initA.r?.protocolVersion === 1);

    // A starts the long replay; B joins mid-stream.
    const loadDone = a.call('session/load', { sessionId: 'sess-a' });
    await sleep(300); // ~15 replay chunks in — the flood is in flight

    await b.open();
    const initB = await tryCall(b.call('initialize', { protocolVersion: 1 }));
    check('B: initialize resolves during A replay',
      initB.ok && initB.r?.protocolVersion === 1, initB.ok ? '' : String(initB.r));

    const newRes = await tryCall(b.call('session/new', { cwd: os.tmpdir(), mcpServers: [] }));
    const bSid = newRes.r?.sessionId;
    check('B: session/new resolves during A replay',
      newRes.ok && typeof bSid === 'string', newRes.ok ? bSid : String(newRes.r));

    const t0 = Date.now();
    const promptRes = await tryCall(b.call('session/prompt', {
      sessionId: bSid,
      prompt: [{ type: 'text', text: 'ping' }],
    }));
    check('B: session/prompt resolves during A replay',
      promptRes.ok && promptRes.r?.stopReason === 'end_turn',
      promptRes.ok ? `${Date.now() - t0}ms` : String(promptRes.r));

    const loadRes = await tryCall(loadDone);
    check('A: session/load resolves', loadRes.ok, loadRes.ok ? '' : String(loadRes.r));

    // Let any straggler frames land before counting.
    await sleep(300);

    const foreignOnB = b.sessionUpdates('sess-a').length;
    check('B: zero foreign session/update frames (sess-a)',
      foreignOnB === 0, `${foreignOnB} leaked`);

    const ownOnB = b.sessionUpdates(bSid).length;
    check('B: own prompt chunks routed to B', ownOnB >= PROMPT_CHUNKS,
      `${ownOnB} frames`);

    const replayOnA = a.sessionUpdates('sess-a').length;
    check('A: full replay received on its own socket',
      replayOnA === REPLAY_CHUNKS, `${replayOnA}/${REPLAY_CHUNKS}`);

    const foreignOnA = a.sessionUpdates(bSid).length;
    check('A: zero foreign session/update frames (B session)',
      foreignOnA === 0, `${foreignOnA} leaked`);

    // Unclaimed session -> broadcast fallback for everyone.
    const unclaimedOnA = a.sessionUpdates('sess-nobody').length;
    const unclaimedOnB = b.sessionUpdates('sess-nobody').length;
    check('unclaimed session still broadcasts to both clients',
      unclaimedOnA >= 1 && unclaimedOnB >= 1,
      `A=${unclaimedOnA} B=${unclaimedOnB}`);
  } finally {
    a.close();
    b.close();
    await stopTestBridge(bridge);
    await rm(temp, { recursive: true, force: true });
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.log(`FAIL  ${e.message}`);
  process.exit(1);
});
