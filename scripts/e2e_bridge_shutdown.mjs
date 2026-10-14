#!/usr/bin/env node
// E2E: SIGTERM of the bridge must also stop its owned ACP child before
// switching placement (e.g. Docker -> host) can safely release the port.
import { testEnv } from './bridge-test-harness.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'deploy', 'acp-ws-bridge.mjs');
const AGENT = path.join(ROOT, 'scripts', 'e2e_bridge_shutdown_agent.mjs');
const req = createRequire(import.meta.url);
const { WebSocket } = req('ws');
const wsEntry = req.resolve('ws');
const nodeModules = wsEntry.includes(`${path.sep}node_modules${path.sep}`)
  ? wsEntry.split(`${path.sep}node_modules${path.sep}`)[0] + `${path.sep}node_modules`
  : path.dirname(wsEntry);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function processAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z';
  } catch {
    return false;
  }
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'acp-bridge-shutdown-'));
const pidFile = path.join(tempDir, 'agent.pid');
const signal = process.argv[2] || 'SIGTERM';
assert.ok(['SIGTERM', 'SIGINT'].includes(signal), `unsupported signal ${signal}`);
let port;
const bridge = spawn(process.execPath, [
  BRIDGE, '--port', '0', '--bind', '127.0.0.1', '--required-mode', 'docker', '--cmd', `${process.execPath} ${AGENT} ${pidFile}`,
  '--root', tempDir, '--idle-timeout-ms', '60000',
], {
  env: { ...await testEnv(tempDir, 'docker'), NODE_PATH: nodeModules },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeOutput = '';
bridge.stdout.on('data', (chunk) => { bridgeOutput += chunk.toString(); });
bridge.stderr.on('data', (chunk) => { bridgeOutput += chunk.toString(); });
let ws;
let lateWs;
let childPid;
try {
  await waitFor(() => bridgeOutput.includes('listening'), 8000, 'bridge listen');

  port = Number(bridgeOutput.match(/listening on :(\d+)/)[1]);
  ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(() => {
    try { childPid = Number(readFileSync(pidFile, 'utf8')); return childPid > 0; }
    catch { return false; }
  }, 5000, 'ACP child startup');

  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('initialize response timed out')), 3000);
    ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        try {
          if (JSON.parse(line).id === 1) { clearTimeout(timeout); resolve(); }
        } catch { /* next line */ }
      }
    });
  });

  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'shutdown-test' } }) + '\n');
  const wsClosed = new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const bridgeExited = new Promise((resolve) => bridge.once('exit', resolve));
  bridge.kill(signal);
  await waitFor(() => bridgeOutput.includes(`shutting down on ${signal}`), 2000, 'shutdown state transition');
  lateWs = new WebSocket(`ws://127.0.0.1:${port}/`);
  const lateSocketOpened = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), 1500);
    lateWs.once('open', () => { clearTimeout(timeout); resolve(true); });
    lateWs.once('error', () => { clearTimeout(timeout); resolve(false); });
    lateWs.once('close', () => { clearTimeout(timeout); resolve(false); });
  });
  assert.equal(lateSocketOpened, false, 'a socket arriving during shutdown must not complete its handshake');
  await Promise.race([
    bridgeExited,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error(`bridge did not exit after ${signal}; output=${bridgeOutput}`)), 7000);
      timeout.unref();
    }),
  ]);
  await waitFor(() => !processAlive(childPid), 5000, `owned ACP child ${childPid} to exit`);
  const childEvents = readFileSync(pidFile, 'utf8');
  assert.ok(childEvents.includes(`signal=${signal}`), `agent child did not receive ${signal}`);
  const closeInfo = await wsClosed;
  assert.equal(closeInfo.code, 1012, `expected service-restart close code, got ${JSON.stringify(closeInfo)}`);
  assert.equal(closeInfo.reason, 'bridge shutting down');
  console.log(`PASS ${signal} bridge shutdown stopped child pid=${childPid}; WS closed 1012`);
} finally {
  try { ws?.terminate(); } catch { /* already closed */ }
  try { lateWs?.terminate(); } catch { /* already closed */ }
  if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL');
  if (childPid && processAlive(childPid)) {
    try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(tempDir, { recursive: true, force: true });
}
