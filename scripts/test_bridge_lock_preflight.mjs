import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridges = ['hermes', 'opencode', 'devin', 'pi', 'codex'];
const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-lock-preflight-'));
function runPreflight(lockDir) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/acp-bridges.mjs'), 'preflight', '--mode', 'docker'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: temp, ACP_BRIDGE_LOCK_DIR: lockDir,
      ACP_BRIDGE_MODE_FILE: path.join(temp, 'selected') },
  });
}
try {
  const locks = path.join(temp, 'locks');
  await mkdir(locks, { mode: 0o2770 }); await chmod(locks, 0o2770);
  for (const name of bridges) {
    const file = path.join(locks, `${name}.lock`);
    await writeFile(file, '', { mode: 0o660 }); await chmod(file, 0o660);
  }

  await rm(path.join(locks, 'codex.lock'));
  let result = runPreflight(locks);
  assert.notEqual(result.status, 0, JSON.stringify(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /lock file missing.*codex\.lock/i);

  const target = path.join(temp, 'real-locks');
  await mkdir(target, { mode: 0o2770 }); await chmod(target, 0o2770);
  await symlink(target, path.join(temp, 'locks-alias'));
  result = runPreflight(path.join(temp, 'locks-alias'));
  assert.notEqual(result.status, 0, JSON.stringify(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /unsafe bridge lock directory|symlink/i);

  const codex = path.join(locks, 'codex.lock');
  await writeFile(codex, '', { mode: 0o600 }); await chmod(codex, 0o600);
  result = runPreflight(locks);
  assert.notEqual(result.status, 0, JSON.stringify(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /unsafe bridge lock file.*codex\.lock/i);
  console.log('PASS lock preflight rejects missing, aliased, and wrong-mode lock paths');
} finally { await rm(temp, { recursive: true, force: true }); }
