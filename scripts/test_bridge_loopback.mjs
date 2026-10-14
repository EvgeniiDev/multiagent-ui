import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { testEnv, startBridge, boundPort, finish, cleanupBridge } from './bridge-test-harness.mjs';
const dir = await mkdtemp(path.join(os.tmpdir(), 'acp-loopback-'));
const bridge = startBridge(dir, await testEnv(dir));
try {
  const port = await boundPort(bridge);
  assert.ok(port > 0);
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.destroy();
  bridge.child.kill('SIGTERM');
  assert.equal(await finish(bridge), 0);
  console.log('PASS port 0 binds loopback and reports the actual bound port');
} finally { await cleanupBridge(bridge, dir); await rm(dir, { recursive: true, force: true }); }
