// Isolated local bridge tests: no production selector, PATH fallback, or metering.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let wsModule, entry;
for (const candidate of ['ws', path.join(os.homedir(), '.local/lib/node_modules/ws'), '/usr/local/lib/node_modules/ws', '/usr/lib/node_modules/ws']) {
  try { wsModule = require(candidate); entry = require.resolve(candidate); break; }
  catch { /* local module lookup only; no installation or network */ }
}
if (!wsModule) throw new Error('cannot resolve ws; set NODE_PATH');
export const { WebSocket } = wsModule;
const nodePath = entry.includes('/node_modules/') ? entry.split('/node_modules/')[0] + '/node_modules' : path.dirname(entry);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor(predicate, label, ms = 7000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}
export async function testEnv(dir, mode = 'host', { lockDir = path.join(dir, 'locks') } = {}) {
  await mkdir(path.join(dir, 'bin'), { recursive: true });
  await mkdir(lockDir, { recursive: true, mode: 0o2770 });
  await chmod(lockDir, 0o2770);
  const lockFile = path.join(lockDir, 'hermes.lock');
  try { await writeFile(lockFile, '', { flag: 'wx', mode: 0o660 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(lockFile, 0o660);
  await writeFile(path.join(dir, 'selected'), `${mode}\n`);
  return { ...process.env, HOME: dir, PATH: path.join(dir, 'bin'), NODE_PATH: nodePath,
    ACP_TOKEN_METER: '0', ACP_BRIDGE_MODE_FILE: path.join(dir, 'selected'),
    ACP_BRIDGE_LOCK_DIR: lockDir };
}
export function runCommand(bin, args, env) {
  const child = spawn(bin, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { child, output: '', code: undefined };
  child.stdout.on('data', (c) => { result.output += c; });
  child.stderr.on('data', (c) => { result.output += c; });
  result.closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { result.code = code; resolve(code); });
  });
  return result;
}
export function runNode(args, env) { return runCommand(process.execPath, args, env); }
export function startBridge(dir, env, args = []) {
  return runCommand(path.join(ROOT, 'deploy/acp-bridge-launcher.sh'), ['hermes', process.execPath,
    path.join(ROOT, 'deploy/acp-ws-bridge.mjs'), '--port', env.TEST_PORT || '0', '--bind', '127.0.0.1',
    '--required-mode', env.TEST_REQUIRED_MODE || 'host', '--root', dir,
    '--cmd', `${process.execPath} ${path.join(ROOT, 'scripts/e2e_bridge_shutdown_agent.mjs')} ${path.join(dir, 'agent.pid')}`,
    ...args], env);
}
export async function boundPort(result) {
  return waitFor(() => {
    if (result.code !== undefined) throw new Error(`bridge exited ${result.code}\n${result.output}`);
    const match = result.output.match(/listening on :(\d+)/);
    return match && Number(match[1]);
  }, 'bridge loopback listen');
}
export async function finish(result, ms = 7000) {
  try { return await waitFor(() => result.code !== undefined ? { code: result.code } : null, 'bridge exit', ms).then((r) => r.code); }
  catch (error) { throw new Error(`${error.message}\n${result.output}`); }
}
export async function cleanupBridge(result, dir) {
  if (result.child.exitCode === null && result.child.signalCode === null) result.child.kill('SIGKILL');
  await result.closed;
  // Only the PID recorded by this test's own mock adapter may be signalled.
  try {
    const pid = Number((await readFile(path.join(dir, 'agent.pid'), 'utf8')).split('\n')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const argv = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (argv.includes(path.join(ROOT, 'scripts/e2e_bridge_shutdown_agent.mjs')) && argv.includes(path.join(dir, 'agent.pid'))) process.kill(pid, 'SIGKILL');
  } catch { /* test adapter already exited or was never spawned */ }
}

export async function stopTestBridge(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 7000);
    child.once('close', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  });
}
