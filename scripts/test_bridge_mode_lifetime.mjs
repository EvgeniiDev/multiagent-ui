import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, rename, symlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { testEnv, startBridge, boundPort, finish, cleanupBridge, waitFor, WebSocket } from './bridge-test-harness.mjs';
async function replaceSelector(file, value) {
  const temp = `${file}.replacement`;
  await writeFile(temp, value);
  await rename(temp, file);
}
const cases = {
  change: { mode: 'host', revoke: (f) => replaceSelector(f, 'docker\n'), reason: /selected mode is docker/ },
  reverse: { mode: 'docker', revoke: (f) => replaceSelector(f, 'host\n'), reason: /selected mode is host/ },
  missing: { mode: 'docker', revoke: (f) => rm(f), reason: /ENOENT|missing/ },
  invalid: { mode: 'docker', revoke: (f) => replaceSelector(f, 'invalid\n'), reason: /invalid bridge mode/ },
  unreadable: { mode: 'docker', revoke: async (f) => { await mkdir(`${f}.directory`); await symlink(`${f}.directory`, `${f}.replacement`); await rename(`${f}.replacement`, f); }, reason: /EISDIR|directory/ },
};
for (const [name, scenario] of Object.entries(cases)) {
  if (process.env.CASE && process.env.CASE !== name) continue;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'acp-lifetime-'));
  const env = await testEnv(dir, scenario.mode);
  const bridge = startBridge(dir, { ...env, TEST_REQUIRED_MODE: scenario.mode });
  const sockets = [];
  try {
    const port = await boundPort(bridge);
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(ws);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    }
    await waitFor(async () => { try { return await readFile(path.join(dir, 'agent.pid'), 'utf8'); } catch { return false; } }, 'owned CLI');
    const raw = net.connect(port, '127.0.0.1');
    sockets.push(raw);
    await new Promise((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject); });
    // An incomplete HTTP handshake exercises draining sockets outside wss.clients.
    raw.write('GET / HTTP/1.1\r\n');
    const closed = sockets.map((s) => new Promise((resolve) => s.once('close', resolve)));
    await scenario.revoke(env.ACP_BRIDGE_MODE_FILE);
    assert.equal(await finish(bridge), 78, bridge.output);
    assert.match(bridge.output, scenario.reason);
    await Promise.all(closed);
    const events = await readFile(path.join(dir, 'agent.pid'), 'utf8');
    assert.match(events, /signal=SIGTERM/, 'owned CLI must receive a real signal on revocation');
    const probe = net.connect(port, '127.0.0.1');
    const opened = await new Promise((resolve) => { probe.once('connect', () => resolve(true)); probe.once('error', () => resolve(false)); });
    probe.destroy();
    assert.equal(opened, false, 'listener must be drained');
    console.log(`PASS ${name}: revocation drains listener, two sockets, raw handshake, and owned CLI; exit 78`);
  } finally {
    for (const socket of sockets) { socket.terminate?.(); socket.destroy?.(); }
    await cleanupBridge(bridge, dir);
    await rm(dir, { recursive: true, force: true });
  }
}
