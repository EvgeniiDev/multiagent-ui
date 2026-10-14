import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRIDGE_MODES = Object.freeze(['docker', 'host']);
export const DEFAULT_MODE_FILE = path.join(os.homedir(), '.config', 'acp-ui-bridge-state', 'selected');

function modeFile(filePath) {
  return filePath || process.env.ACP_BRIDGE_MODE_FILE || DEFAULT_MODE_FILE;
}

function validateMode(mode, label = 'bridge mode') {
  if (!BRIDGE_MODES.includes(mode)) throw new Error(`${label} must be exactly docker or host`);
  return mode;
}

export async function readBridgeMode({ filePath, allowMissing = true } = {}) {
  const target = modeFile(filePath);
  let value;
  try {
    const raw = await readFile(target, 'utf8');
    value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return 'docker';
    throw error;
  }
  if (!BRIDGE_MODES.includes(value)) {
    throw new Error(`invalid bridge mode in ${target}: expected exactly docker or host`);
  }
  return value;
}

export async function assertBridgeMode(expected, { filePath } = {}) {
  validateMode(expected, 'expected mode');
  const actual = await readBridgeMode({ filePath, allowMissing: false });
  if (actual !== expected) throw new Error(`selected mode is ${actual}; refusing to start ${expected} bridge`);
  return actual;
}

// Runtime checks never use the fresh-install default. Synchronous reads also
// prevent an old async check from authorizing a later socket/message callback.
export function assertBridgeModeSync(expected, { filePath } = {}) {
  validateMode(expected, 'expected mode');
  const target = modeFile(filePath);
  const raw = readFileSync(target, 'utf8');
  const actual = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!BRIDGE_MODES.includes(actual)) throw new Error(`invalid bridge mode in ${target}: expected exactly docker or host`);
  if (actual !== expected) throw new Error(`selected mode is ${actual}; refusing to start ${expected} bridge`);
  return actual;
}

export async function writeBridgeMode(mode, { filePath } = {}) {
  validateMode(mode);
  const target = modeFile(filePath);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.selected.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, `${mode}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return mode;
}
