import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeSessionStatuses } from '../deploy/bridge-session-statuses.mjs';
import { testEnv, WebSocket, ROOT, runCommand, boundPort, waitFor, stopTestBridge } from './bridge-test-harness.mjs';
const prompt = (id, sid) => ({ id, method: 'session/prompt', params: { sessionId: sid } });
const end = id => ({ id, result: { stopReason: 'end_turn' } });

test('bridge correlates lifecycle independently of sockets and ignores replay and stale results', async () => {
 const tracker = new BridgeSessionStatuses();
 tracker.outbound(prompt(101, 'a')); tracker.outbound(prompt(102, 'b'));
 assert.equal(tracker.snapshot().a.status, 'working');
 tracker.inbound(end(101)); assert.equal(tracker.snapshot().a.status, 'completed');
 assert.equal(tracker.snapshot().b.status, 'working');
 tracker.outbound({ id: 103, method: 'session/load', params: { sessionId: 'a' } });
 tracker.inbound({ method: 'session/update', params: { sessionId: 'a' } });
 assert.equal(tracker.snapshot().a.status, 'completed');
 tracker.outbound(prompt(104, 'a')); tracker.outbound({ method: 'session/cancel', params: { sessionId: 'a' } });
 tracker.inbound(end(104)); assert.equal(tracker.snapshot().a.status, 'cancelled');
 tracker.outbound(prompt(105, 'a')); tracker.outbound(prompt(106, 'a'));
 tracker.inbound(end(105)); assert.equal(tracker.snapshot().a.status, 'working');
 tracker.inbound({ id: 106, error: { message: 'failed' } }); assert.equal(tracker.snapshot().a.status, 'error');
 tracker.failAll(); assert.equal(tracker.snapshot().b.status, 'error');
});

test('bridge restores terminal results without reviving old working claims and retries failed persistence', async () => {
 let calls = 0, saved;
 const tracker = new BridgeSessionStatuses({ load: async () => ({ a: { status: 'working', at: 1 }, b: { status: 'completed', at: 2 } }),
  save: async snapshot => { calls++; saved = snapshot; return calls > 1; } });
 await tracker.restore(); assert.equal(tracker.snapshot().a.status, null); assert.equal(tracker.snapshot().b.status, 'completed');
 tracker.outbound(prompt(1, 'a')); await tracker.flush(); await tracker.flush();
 assert.equal(saved.a.status, 'working'); assert(calls >= 2);
});

test('real bridge retains outcome after originating WebSocket closes, observer replay cannot change it', async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'acp-bridge-status-')); let bridge, socket, observer;
 try {
  const env = await testEnv(dir);
  bridge = runCommand(path.join(ROOT, 'deploy/acp-bridge-launcher.sh'), ['hermes', process.execPath, path.join(ROOT, 'deploy/acp-ws-bridge.mjs'), '--port', '0', '--bind', '127.0.0.1', '--required-mode', 'host', '--root', dir, '--cmd', `${process.execPath} ${path.join(ROOT, 'scripts/e2e_bridge_status_agent.mjs')}`], env);
  const port = await boundPort(bridge), url = `http://127.0.0.1:${port}/api/sessions/status`;
  const status = async sid => (await (await fetch(url)).json()).statuses[sid]?.status;
  socket = new WebSocket(`ws://127.0.0.1:${port}/`); await new Promise(resolve => socket.once('open', resolve));
  socket.send(JSON.stringify({ jsonrpc: '2.0', ...prompt(1, 'a') }));
  await waitFor(async () => await status('a') === 'working', 'bridge sees real request');
  await new Promise(resolve => { socket.once('close', resolve); socket.close(); });
  observer = new WebSocket(`ws://127.0.0.1:${port}/`); await new Promise(resolve => observer.once('open', resolve));
  let replies = 0;
  observer.on('message', data => { const frame = JSON.parse(String(data)); if (frame.id === 1 && !frame.method) replies++; });
  await new Promise(resolve => setTimeout(resolve, 200));
  observer.send(JSON.stringify({ jsonrpc: '2.0', ...prompt(1, 'b') }));
  await waitFor(async () => await status('a') === 'completed', 'orphaned prompt completion');
  assert.equal(replies, 0, 'orphaned request id must not reach another socket');
  await waitFor(async () => await status('b') === 'completed', 'second socket completion');
  assert.equal(replies, 1);
  const replay = new Promise(resolve => observer.on('message', data => { if (JSON.parse(String(data)).id === 2) resolve(); }));
  observer.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'a' } }));
  await replay; assert.equal(await status('a'), 'completed');
 } finally { socket?.terminate(); observer?.terminate(); if (bridge) await stopTestBridge(bridge.child); await rm(dir, { recursive: true, force: true }); }
});

test('Hermes steering ACK cannot complete or supersede the original turn', () => {
 const tracker = new BridgeSessionStatuses({ commandSteering: true });
 tracker.outbound(prompt(1, 'a'));
 tracker.outbound({ ...prompt(2, 'a'), params: { sessionId: 'a', prompt: [{ type: 'text', text: '/steer keep going' }] } });
 tracker.inbound(end(2)); assert.equal(tracker.snapshot().a.status, 'working');
 tracker.inbound(end(1)); assert.equal(tracker.snapshot().a.status, 'completed');
});
