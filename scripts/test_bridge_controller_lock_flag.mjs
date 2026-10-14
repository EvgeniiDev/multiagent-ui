import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [path.join(root, 'scripts/acp-bridges.mjs'), 'switch', '--mode', 'docker', '--lock-held'], {
  cwd: root, encoding: 'utf8',
});
assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
assert.match(`${result.stdout}\n${result.stderr}`, /unknown option: --lock-held/);
console.log('PASS controller no longer exposes a forgeable lock-bypass flag');
