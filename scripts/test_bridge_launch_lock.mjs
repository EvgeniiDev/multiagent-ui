import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testEnv, startBridge, boundPort, finish, cleanupBridge } from './bridge-test-harness.mjs';

// Two launchers with opposite selectors share the same per-bridge kernel lock.
// The second must never bind while the first owner is still alive.
const root = await mkdtemp(path.join(os.tmpdir(), 'acp-lock-exclusion-'));
const lockDir = path.join(root, 'locks');
const dockerDir = path.join(root, 'docker');
const hostDir = path.join(root, 'host');
await mkdir(lockDir); await mkdir(dockerDir); await mkdir(hostDir);
await writeFile(path.join(lockDir, 'hermes.lock'), '', { mode: 0o660 });
const dockerEnv = { ...await testEnv(dockerDir, 'docker'), ACP_BRIDGE_LOCK_DIR: lockDir, TEST_REQUIRED_MODE: 'docker' };
const hostEnv = { ...await testEnv(hostDir, 'host'), ACP_BRIDGE_LOCK_DIR: lockDir, TEST_REQUIRED_MODE: 'host' };
let first, second;
try {
  first = startBridge(dockerDir, dockerEnv);
  const dockerPort = await boundPort(first);
  second = startBridge(hostDir, hostEnv);
  const rival = await Promise.race([
    boundPort(second).then((port) => ({ kind: 'listen', port }), (error) => ({ kind: 'exit', error })),
    second.closed.then((code) => ({ kind: 'exit', code })),
  ]);
  assert.equal(rival.kind, 'exit', `host launcher bypassed Docker's held bridge lease; it listened on :${rival.port} while Docker owner served :${dockerPort}`);
  assert.equal(rival.code, 78, rival.error?.message || second.output);

  first.child.kill('SIGTERM');
  assert.equal(await finish(first), 0, first.output);
  second = startBridge(hostDir, hostEnv);
  assert.ok(await boundPort(second), 'host may acquire the lease after Docker shuts down');
  first = startBridge(dockerDir, dockerEnv);
  const dockerRival = await Promise.race([
    boundPort(first).then((port) => ({ kind: 'listen', port }), (error) => ({ kind: 'exit', error })),
    first.closed.then((code) => ({ kind: 'exit', code })),
  ]);
  assert.equal(dockerRival.kind, 'exit', `Docker launcher bypassed Host's held bridge lease; it listened on :${dockerRival.port}`);
  assert.equal(dockerRival.code, 78, dockerRival.error?.message || first.output);
  second.child.kill('SIGINT');
  assert.equal(await finish(second), 0, second.output);
  first = startBridge(dockerDir, dockerEnv);
  assert.ok(await boundPort(first), 'Docker may acquire the lease after Host shuts down');
  first.child.kill('SIGTERM');
  assert.equal(await finish(first), 0, first.output);
  console.log('PASS opposite-mode launchers exclude one another in both directions and release leases on shutdown');
} finally {
  if (second) await cleanupBridge(second, hostDir);
  if (first) await cleanupBridge(first, dockerDir);
  await rm(root, { recursive: true, force: true });
}
