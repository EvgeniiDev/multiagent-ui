import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertRestartCallerOutside } from './acp-bridges.mjs';
test('bridge controller refuses to kill the agent hosting its own deployment', async () => {
 const root = await mkdtemp(path.join(tmpdir(), 'acp-restart-ancestry-'));
 try {
  for (const [pid, parent] of [[10, 8], [8, 3], [3, 1], [1, 0]]) {
   await mkdir(path.join(root, String(pid))); await writeFile(path.join(root, String(pid), 'status'), `PPid:\t${parent}\n`);
  }
  await assert.rejects(assertRestartCallerOutside(3, { procRoot: root, callerPid: 10 }), /hosting this session/);
  await assertRestartCallerOutside(20, { procRoot: root, callerPid: 10 });
 } finally { await rm(root, { recursive: true, force: true }); }
});
