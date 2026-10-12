#!/usr/bin/env node
// Minimal ACP child for the bridge shutdown lifecycle test.
import { appendFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const pidFile = process.argv[2];
writeFileSync(pidFile, String(process.pid));
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
// Model real adapters which keep event-loop work alive after stdin closes.
setInterval(() => {}, 60_000);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    appendFileSync(pidFile, `\nsignal=${signal}\n`);
    process.exit(0);
  });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.id == null) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (msg.method === 'session/prompt') {
    // Remain alive while the bridge is asked to shut down.
  } else {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
