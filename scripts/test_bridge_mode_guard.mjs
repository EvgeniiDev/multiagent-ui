import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-bridge-guard-'));
const modeFile = path.join(temp, 'selected');
const port = 0;
try {
  await writeFile(modeFile, 'docker\n');
  const child = spawn(process.execPath, [
    path.join(root, 'deploy/acp-ws-bridge.mjs'), '--port', String(port),
    '--bind', '127.0.0.1', '--cmd', `${process.execPath} ${path.join(root, 'scripts/e2e_bridge_shutdown_agent.mjs')}`,
    '--required-mode', 'host',
  ], { env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '/home/hermes/.local/lib/node_modules', ACP_TOKEN_METER: '0', PATH: temp, ACP_BRIDGE_LOCK_DIR: path.join(temp, 'locks'), ACP_BRIDGE_MODE_FILE: modeFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
    setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bridge did not fail closed promptly')); }, 3000).unref();
  });
  assert.equal(code, 78, output);
  assert.match(output, /selected mode is docker; refusing to start host bridge/);
  console.log('PASS bridge refuses to bind when its required mode is not selected');
} finally {
  await rm(temp, { recursive: true, force: true });
}
