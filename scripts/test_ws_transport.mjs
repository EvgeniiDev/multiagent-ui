#!/usr/bin/env node
// Unit-level e2e for src/lib/transport/websocket.ts client-side liveness:
//
//   * a `$/pong` frame is swallowed (never reaches onMessage listeners)
//   * probe() resolves true on a `$/pong` … and on ANY inbound frame
//   * a pong-capable peer that goes silent is convicted: 2 missed
//     heartbeat intervals -> synthesized close ("half-open")
//   * probe() on a pong-capable peer that stopped answering times out,
//     aborts the socket, and resolves false
//   * a peer that NEVER pongs (native ACP-over-WS agent / old bridge) is
//     degraded gracefully: probes resolve by socket state and nothing is
//     ever aborted — the graceful-degradation rule
//
// Node 26 type-strips .ts natively but won't resolve the extensionless
// `./types` specifier, so the source is copied byte-for-byte into a temp
// dir with that one specifier rewritten to './types.ts' (types.ts itself
// has no relative imports).
//
// Usage: node scripts/test_ws_transport.mjs

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'lib', 'transport');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ws-transport-'));
writeFileSync(
  path.join(tmp, 'websocket.ts'),
  readFileSync(path.join(SRC, 'websocket.ts'), 'utf8').replace(
    "from './types'",
    "from './types.ts'"
  )
);
writeFileSync(path.join(tmp, 'types.ts'), readFileSync(path.join(SRC, 'types.ts'), 'utf8'));

const { WebSocketTransport } = await import(path.join(tmp, 'websocket.ts'));

const results = [];
function check(name, ok, extra = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal fake DOM WebSocket: auto-opens, optionally auto-pongs $/ping. */
let lastSocket = null;
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sent = [];
    this.autoPong = false;
    lastSocket = this;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1; // OPEN
      this.emit('open', {});
    });
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, ev) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  /** Deliver an inbound text frame, as the browser would. */
  receive(text) {
    this.emit('message', { data: text });
  }
  send(data) {
    this.sent.push(data);
    if (this.autoPong && data.includes('$/ping')) {
      this.receive('{"jsonrpc":"2.0","method":"$/pong","params":{"ts":1}}');
    }
  }
  close() {
    this.readyState = 3; // never emit 'close' — simulates a dead socket
  }
}

const HB = 40; // heartbeatMs — fast ticks keep the test under a second

async function scenarioPonging() {
  const t = await WebSocketTransport.connect({
    url: 'ws://fake', WebSocketCtor: FakeSocket, heartbeatMs: HB,
  });
  const ws = lastSocket;
  const received = [];
  const closes = [];
  t.onMessage((m) => received.push(m));
  t.onClose((r) => closes.push(r));
  ws.autoPong = true;

  // probe resolves on the pong.
  const probed = await t.probe(500);
  check('probe() resolves true on $/pong', probed === true);

  // Let several heartbeats run — pongs must be swallowed, socket healthy.
  await sleep(HB * 3);
  check('$/pong swallowed below the listener layer',
    received.every((l) => !l.includes('$/pong')) && ws.sent.length >= 2,
    `sent=${ws.sent.length} received=${received.length}`);

  // probe resolves on ANY inbound frame, not only pongs.
  ws.autoPong = false;
  const p2 = t.probe(500);
  await sleep(30);
  ws.receive('{"jsonrpc":"2.0","method":"session/update","params":{}}');
  const anyFrame = await p2;
  check('probe() resolves on any inbound frame', anyFrame === true);

  // Now total silence: 2 missed intervals on a proven-ponging peer convict.
  await new Promise((r) => setTimeout(r, HB * 5));
  check('2 missed intervals on a pong-capable peer -> half-open close',
    closes.length === 1 && /half-open/.test(closes[0]),
    closes[0] ?? 'no close');
  const sendAfter = await t.send('{}').then(() => 'sent').catch((e) => e.message);
  check('transport is closed after the conviction', /closed/.test(sendAfter));
}

async function scenarioProbeTimeout() {
  // Heartbeat disabled so the probe's own timer is the only clock — at HB
  // ticks the missed-pong conviction legitimately fires first (that's the
  // heartbeat's job). pongCapable is a private field only at compile time;
  // seeding it simulates "peer already proven to pong".
  const t = await WebSocketTransport.connect({
    url: 'ws://fake', WebSocketCtor: FakeSocket, heartbeatMs: 0,
  });
  const ws = lastSocket;
  const closes = [];
  t.onClose((r) => closes.push(r));
  t.pongCapable = true;
  ws.autoPong = false;
  const failed = await t.probe(200);
  check('probe() timeout on pong-capable peer resolves false', failed === false);
  check('probe() timeout aborts the socket',
    closes.length === 1 && /probe timed out/.test(closes[0]), closes[0] ?? 'no close');
}

async function scenarioNativeAgent() {
  const t = await WebSocketTransport.connect({
    url: 'ws://fake', WebSocketCtor: FakeSocket, heartbeatMs: HB,
  });
  const ws = lastSocket;
  const closes = [];
  t.onClose((r) => closes.push(r));
  // Never pongs. A probe times out but resolves by socket state — silence
  // proves nothing against a peer that cannot pong.
  const unknown = await t.probe(200);
  check('probe() on never-ponged peer answers by socket state', unknown === true);
  // Past the grace window the peer is marked non-capable; heartbeats keep
  // flowing as keepalives and nothing is convicted — graceful degradation.
  await sleep(HB * 6);
  check('non-ponging peer is never aborted (graceful degradation)',
    closes.length === 0 && ws.sent.length >= 5, `closes=${closes.length} sent=${ws.sent.length}`);
  const still = await t.probe(50);
  check('probe() on marked-non-capable peer resolves true fast', still === true);
  await t.close();
}

await scenarioPonging();
await scenarioProbeTimeout();
await scenarioNativeAgent();

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length ? 1 : 0);
