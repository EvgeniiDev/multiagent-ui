import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBridgeMode, readBridgeMode, writeBridgeMode } from '../deploy/bridge-mode.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-bridge-mode-'));
const filePath = path.join(temp, 'mode');
try {
  assert.equal(await readBridgeMode({ filePath }), 'docker', 'fresh config defaults to Docker');
  await assert.rejects(() => assertBridgeMode('docker', { filePath }), /ENOENT|missing/);
  await writeBridgeMode('host', { filePath });
  assert.equal(await readBridgeMode({ filePath }), 'host');
  await assertBridgeMode('host', { filePath });
  await assert.rejects(() => assertBridgeMode('docker', { filePath }), /selected mode is host/);
  assert.equal((await readFile(filePath, 'utf8')).trim(), 'host');
  await assert.rejects(() => writeBridgeMode('automatic', { filePath }), /must be exactly docker or host/);
  assert.equal(await readBridgeMode({ filePath }), 'host', 'invalid selection must not modify persisted mode');
  await writeFile(filePath, 'fallback\n');
  await assert.rejects(() => readBridgeMode({ filePath }), /invalid bridge mode/);
  await writeFile(filePath, ' host \n');
  await assert.rejects(() => readBridgeMode({ filePath }), /invalid bridge mode/);
  await assert.rejects(() => assertBridgeMode(undefined, { filePath }), /expected mode must be exactly docker or host/);
  console.log('PASS bridge mode config defaults, validates, writes atomically, and fails closed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
