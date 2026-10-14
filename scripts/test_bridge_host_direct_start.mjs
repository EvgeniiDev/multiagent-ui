import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { testEnv, startBridge, boundPort, finish, cleanupBridge } from './bridge-test-harness.mjs';

const hostUnit = await readFile(new URL('../deploy/systemd/acp-ui-bridge-host@.service', import.meta.url), 'utf8');
assert.match(hostUnit, /^ExecStartPre=.*acp-bridges\.mjs preflight --mode host$/m,
  'direct host systemd starts must run full host preflight');
assert.match(hostUnit, /^ExecStartPre=.*acp-bridges\.mjs guard-start --mode host --bridge %i$/m,
  'direct host systemd starts must verify selected mode and live owners before launch');
const selected = process.env.CASE || 'docker-owner';
if (!['docker-owner', 'bind-failure'].includes(selected)) throw new Error(`unknown CASE: ${selected}`);
const root = await mkdtemp(path.join(os.tmpdir(), 'acp-direct-start-'));
let holder;
let docker;
let host;
let target;
try {
  if (selected === 'docker-owner') {
    const lockDir = path.join(root, 'locks');
    const dockerDir = path.join(root, 'docker');
    const hostDir = path.join(root, 'host');
    await mkdir(lockDir); await mkdir(dockerDir); await mkdir(hostDir);
    await writeFile(path.join(lockDir, 'hermes.lock'), '', { mode: 0o660 });
    const dockerEnv = { ...await testEnv(dockerDir, 'docker'), ACP_BRIDGE_LOCK_DIR: lockDir, TEST_REQUIRED_MODE: 'docker' };
    const hostEnv = { ...await testEnv(hostDir, 'host'), ACP_BRIDGE_LOCK_DIR: lockDir, TEST_REQUIRED_MODE: 'host' };
    docker = startBridge(dockerDir, dockerEnv);
    const dockerPort = await boundPort(docker);
    host = startBridge(hostDir, hostEnv);
    const outcome = await Promise.race([
      boundPort(host).then((port) => ({ kind: 'listen', port }), (error) => ({ kind: 'exit', error })),
      host.closed.then((code) => ({ kind: 'exit', code })),
    ]);
    assert.equal(outcome.kind, 'exit', `direct host start listened on :${outcome.port} despite Docker owner :${dockerPort}`);
    assert.equal(outcome.code, 78, outcome.error?.message || host.output);
    assert.doesNotMatch(host.output, /listening on/);
    console.log('PASS docker-owner: direct host start refuses shared lease before serving');
  } else {
    const dir = path.join(root, 'bridge');
    await mkdir(dir);
    const env = await testEnv(dir);
    holder = net.createServer();
    await new Promise((resolve, reject) => { holder.once('error', reject); holder.listen(0, '127.0.0.1', resolve); });
    target = startBridge(dir, { ...env, TEST_PORT: String(holder.address().port) });
    const code = await finish(target, 2500);
    assert.equal(code, 78, target.output);
    assert.doesNotMatch(target.output, /Unhandled 'error' event/);
    assert.match(target.output, /EADDRINUSE/);
    console.log('PASS bind-failure: startup exits without an unhandled listen error');
  }
} finally {
  if (target) await cleanupBridge(target, path.join(root, 'bridge'));
  if (host) await cleanupBridge(host, path.join(root, 'host'));
  if (docker) await cleanupBridge(docker, path.join(root, 'docker'));
  if (holder) await new Promise((resolve) => holder.close(resolve));
  await rm(root, { recursive: true, force: true });
}
