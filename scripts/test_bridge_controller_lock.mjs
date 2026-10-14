import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(os.tmpdir(), 'acp-controller-lock-'));
process.env.HOME = home;
await mkdir(path.join(home, '.config', 'acp-ui-bridge-state'), { recursive: true, mode: 0o700 });
try {
  const { withLock } = await import('./acp-bridges.mjs');
  let release;
  const holder = withLock(() => new Promise((resolve) => { release = resolve; }));
  for (let attempt = 0; !release && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof release, 'function', 'first controller acquired the lease');
  await assert.rejects(withLock(async () => {}), /another bridge mode operation holds the controller lock/);
  release();
  await holder;
  await withLock(async () => {});
  console.log('PASS controller flock serializes mutations and releases after completion');
} finally { await rm(home, { recursive: true, force: true }); }
