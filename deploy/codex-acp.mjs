#!/usr/bin/env node
// Codex app-server accepts initialize once, while the shared ACP bridge serves
// history scans and tabs using the same adapter process. Coalesce that handshake
// without changing request ids, session traffic or the shared bridge's routing.
// The UI's history/runtime clients both use initializeHandshake(). A client with
// different protocol/capabilities must use a separate bridge process instead.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [command = 'codex-acp', ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let cached = null;
let pending = null;
let contract = null;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function normalizedCapabilities(capabilities = {}) {
  const normalized = { ...capabilities };
  // ACP's optional boolean capabilities default to false. Normalize only known
  // fields so extension metadata and future capabilities remain distinguishable.
  if (normalized.terminal === false) delete normalized.terminal;
  if (normalized.fs && typeof normalized.fs === 'object' && !Array.isArray(normalized.fs)) {
    normalized.fs = { ...normalized.fs };
    for (const key of ['readTextFile', 'writeTextFile']) {
      if (normalized.fs[key] === false) delete normalized.fs[key];
    }
    if (Object.keys(normalized.fs).length === 0) delete normalized.fs;
  }
  return normalized;
}

function handshakeContract(params) {
  return JSON.stringify(canonical({ protocolVersion: params.protocolVersion ?? null,
    clientCapabilities: normalizedCapabilities(params.clientCapabilities ?? {}) }));
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function parse(line) { try { return JSON.parse(line); } catch { return null; } }

createInterface({ input: process.stdin }).on('line', line => {
  const msg = parse(line);
  if (msg?.method !== 'initialize' || !Object.hasOwn(msg, 'id')) {
    child.stdin.write(line + '\n');
    return;
  }
  if (msg.params === null || typeof msg.params !== 'object' || Array.isArray(msg.params)) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602,
      message: 'Codex initialize params must be an object' } });
    return;
  }
  const nextContract = handshakeContract(msg.params);
  if (contract !== null && nextContract !== contract) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602,
      message: 'Codex shared connection requires the same protocol version and client capabilities' } });
  } else if (cached) {
    send({ ...cached, id: msg.id });
  } else if (pending) {
    pending.ids.push(msg.id);
  } else {
    contract = nextContract;
    pending = { firstId: msg.id, ids: [msg.id] };
    child.stdin.write(line + '\n');
  }
}).on('close', () => child.stdin.end());

createInterface({ input: child.stdout }).on('line', line => {
  const msg = parse(line);
  if (pending && msg?.id === pending.firstId && !msg.method
      && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) {
    const ids = pending.ids;
    pending = null;
    if (Object.hasOwn(msg, 'result')) cached = msg;
    else contract = null; // Failed initialization must permit a fresh attempt.
    for (const id of ids) send({ ...msg, id });
  } else {
    process.stdout.write(line + '\n');
  }
});

// A process replacement must renegotiate. Never retain a cache after adapter exit.
child.on('error', error => {
  console.error(`Failed to start Codex ACP adapter: ${error.message}`);
  process.exitCode = 1;
  process.stdin.destroy();
});
child.stdin.on('error', error => {
  if (error.code !== 'EPIPE') console.error(`Codex ACP stdin error: ${error.message}`);
});
child.on('close', (code, signal) => {
  cached = null;
  pending = null;
  process.stdin.destroy();
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
