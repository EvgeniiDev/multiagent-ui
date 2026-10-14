#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODE_FILE } from '../deploy/bridge-mode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8');
const composeU7 = await readFile(path.join(root, 'compose.u7.yaml'), 'utf8');
const launcher = await readFile(path.join(root, 'deploy/acp-bridge-launcher.sh'), 'utf8');
const unit = await readFile(path.join(root, 'deploy/systemd/acp-ui-bridge-host@.service'), 'utf8');
const install = await readFile(path.join(root, 'deploy/install.sh'), 'utf8');
const dockerfile = await readFile(path.join(root, 'Dockerfile.node'), 'utf8');
const modeDir = path.dirname(DEFAULT_MODE_FILE);
const containerModeDir = '/run/acp-bridge-mode';
const containerLockDir = '/run/acp-bridge-locks';
const bridgeNames = ['hermes', 'opencode', 'devin', 'pi', 'codex'];

assert.ok(compose.includes(`${modeDir}:/run/acp-bridge-mode:ro`));
assert.ok(compose.includes(`ACP_BRIDGE_MODE_FILE: ${containerModeDir}/selected`));
assert.ok(compose.includes(`ACP_BRIDGE_LOCK_DIR: ${containerLockDir}`));
assert.ok(composeU7.includes(`ACP_BRIDGE_LOCK_DIR: ${containerLockDir}`));
for (const name of bridgeNames) {
  assert.equal(compose.split(`${modeDir}/locks/${name}.lock:${containerLockDir}/${name}.lock:rw`).length - 1, 1,
    `${name} container must receive only its pre-provisioned writable lock file`);
}
assert.ok(dockerfile.includes(`mkdir -p ${containerLockDir}`));
assert.ok(dockerfile.includes(`chmod 0555 ${containerLockDir}`), 'lock directory namespace must be immutable to the non-root bridge user');
assert.ok(!compose.includes(`${modeDir}/locks:${modeDir}/locks:rw`), 'never expose the host lock directory as container-writable');
assert.ok(!compose.includes('/home/hermes/.hermes/acp-bridge-mode'));
assert.ok(!composeU7.includes('/home/hermes/.hermes/acp-bridge-mode'));
assert.ok(launcher.includes('.config/acp-ui-bridge-state/locks'));
assert.ok(unit.includes('%h/.config/acp-ui-bridge-state/selected'));
assert.ok(unit.includes('%h/.config/acp-ui-bridge-state/locks'));
assert.ok(install.includes('MODE_DIR="$HOME/.config/acp-ui-bridge-state"'));
console.log('PASS deployment mode and lock paths agree across defaults, Compose, systemd, installer, and launcher');
