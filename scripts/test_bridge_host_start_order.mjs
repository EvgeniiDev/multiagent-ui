#!/usr/bin/env node
// Regression: host-mode controller start must be serialized — one blocking
// `systemctl --user start <unit>` per bridge, in bridge order — never a single
// parallel start of all units. Parallel activation leaves peers in
// `activating` with MainPID=0, which the direct-start inventory gate
// correctly fails closed on; the controller must never create that state
// itself. Uses a stubbed systemctl and a temp mode file; no real service
// actions run.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controller = await import('./acp-bridges.mjs');
assert.equal(typeof controller.startMode, 'function',
  'acp-bridges.mjs must export startMode so serialized host start is testable without real systemctl');
const { startMode, BRIDGES } = controller;

const dir = await mkdtemp(path.join(os.tmpdir(), 'acp-host-start-order-'));
const savedPath = process.env.PATH;
const savedModeFile = process.env.ACP_BRIDGE_MODE_FILE;
try {
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const log = path.join(dir, 'systemctl.log');
  await writeFile(path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  const modeFile = path.join(dir, 'selected');
  await writeFile(modeFile, 'host\n');
  process.env.ACP_BRIDGE_MODE_FILE = modeFile;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  await startMode('host');
  const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, BRIDGES.length,
    `host start must invoke systemctl once per bridge unit (blocking, serialized); saw ${lines.length} invocation(s): ${lines.join(' | ') || '<none>'}`);
  BRIDGES.forEach((bridge, index) => {
    assert.equal(lines[index], `--user start ${bridge.unit}`,
      `invocation ${index + 1} must be a blocking start of exactly one unit (${bridge.unit}); peer starts must wait`);
  });
  console.log('PASS host start serializes one blocking systemctl start per bridge unit, in order');
} finally {
  process.env.PATH = savedPath;
  if (savedModeFile === undefined) delete process.env.ACP_BRIDGE_MODE_FILE;
  else process.env.ACP_BRIDGE_MODE_FILE = savedModeFile;
  await rm(dir, { recursive: true, force: true });
}
