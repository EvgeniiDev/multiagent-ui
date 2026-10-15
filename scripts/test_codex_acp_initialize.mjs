#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// The mock reproduces Codex app-server's one-initialize-per-process contract.
if (process.argv.includes('--mock')) {
  let initialized = false;
  let calls = 0;
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      calls++;
      console.log(JSON.stringify({ jsonrpc: '2.0', method: '_auth/status_update',
        params: { authStatus: { status: 'authenticated' } } }));
      if (msg.id === 1) console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        method: 'session/request_permission', params: { sessionId: 'mock-session' } }));
      if (initialized || msg.params.fail) {
        setTimeout(() => console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
          error: { code: -32603, message: initialized ? 'Already initialized' : 'Retry me' } })), 30);
      } else {
        initialized = true;
        setTimeout(() => console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: 1, agentInfo: { name: 'mock' } } })), 30);
      }
    } else if (msg.method === 'stats') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { calls } }));
    } else if (msg.method === 'quit') {
      process.exit(7);
    } else {
      // Echo requests, notifications and agent-response-shaped input verbatim.
      console.log(line);
    }
  });
} else {
  const thisFile = fileURLToPath(import.meta.url);
  const wrapper = fileURLToPath(new URL('../deploy/codex-acp.mjs', import.meta.url));
  function client() {
    const child = spawn(process.execPath, process.env.DIRECT_ADAPTER
      ? [thisFile, '--mock'] : [wrapper, process.execPath, thisFile, '--mock']);
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const replies = new Map();
    const waiters = new Map();
    const closed = new Promise(resolve => child.on('close', resolve));
    createInterface({ input: child.stdout }).on('line', line => {
      const msg = JSON.parse(line);
      const key = JSON.stringify(msg.id ?? msg.method);
      if (waiters.has(key)) { waiters.get(key)(msg); waiters.delete(key); }
      else replies.set(key, msg);
    });
    function receive(id) {
      const key = JSON.stringify(id);
      if (replies.has(key)) { const msg = replies.get(key); replies.delete(key); return Promise.resolve(msg); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(key);
          reject(new Error(`Timed out: ${key}; ${stderr}`));
        }, 3000);
        waiters.set(key, msg => { clearTimeout(timer); resolve(msg); });
      });
    }
    return { child, closed, receive, send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); } };
  }
  const first = client();
  try {
    first.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    first.send({ jsonrpc: '2.0', id: 'second-tab', method: 'initialize', params: {} });
    assert.equal((await first.receive('_auth/status_update')).params.authStatus.status,
      'authenticated', 'child auth notifications pass through');
    assert.equal((await first.receive(1)).method, 'session/request_permission',
      'child requests with the initialization id must not be consumed as responses');
    const a = await first.receive(1);
    const b = await first.receive('second-tab');
    assert.ok(a.result, 'first initialize succeeds');
    assert.deepEqual(b, { ...a, id: 'second-tab' }, 'concurrent initialize succeeds with its own id');
    first.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    assert.deepEqual(await first.receive(0), { ...a, id: 0 }, 'later initialize reuses successful handshake');
    first.send({ jsonrpc: '2.0', id: 'stats', method: 'stats', params: {} });
    assert.equal((await first.receive('stats')).result.calls, 1, 'adapter sees exactly one initialize');
    first.send({ jsonrpc: '2.0', id: 'different-client', method: 'initialize',
      params: { clientCapabilities: { fs: { readTextFile: true } } } });
    assert.equal((await first.receive('different-client')).error.code, -32602,
      'incompatible client capabilities are rejected rather than silently cached');
    for (const msg of [
      { jsonrpc: '2.0', id: 22, method: 'session/load', params: { sessionId: 'other-tab' } },
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'other-tab' } },
      { jsonrpc: '2.0', id: 'permission-response', result: { outcome: 'approved' } },
    ]) {
      first.send(msg);
      assert.deepEqual(await first.receive(msg.id ?? msg.method), msg, 'non-initialize frame passes through');
    }
    first.send({ jsonrpc: '2.0', id: 99, method: 'quit', params: {} });
    assert.equal(await first.closed, 7, 'adapter exit terminates wrapper with same status');
  } finally { first.child.kill(); }
  const second = client();
  try {
    for (const [index, params] of [null, [], 'invalid', 1, false].entries()) {
      const id = `invalid-${index}`;
      second.send({ jsonrpc: '2.0', id, method: 'initialize', params });
      assert.equal((await second.receive(id)).error?.code, -32602,
        'invalid initialize params are rejected without crashing the process');
    }
    second.send({ jsonrpc: '2.0', id: 'fail1', method: 'initialize', params: { fail: true } });
    second.send({ jsonrpc: '2.0', id: 'fail2', method: 'initialize', params: {} });
    const failed = await second.receive('fail1');
    assert.equal(failed.error.message, 'Retry me');
    assert.deepEqual(await second.receive('fail2'), { ...failed, id: 'fail2' });
    second.send({ jsonrpc: '2.0', id: 'retry', method: 'initialize', params: {} });
    assert.ok((await second.receive('retry')).result, 'failed initialize is not cached');
    second.send({ jsonrpc: '2.0', id: 'stats', method: 'stats', params: {} });
    assert.equal((await second.receive('stats')).result.calls, 2, 'failed handshake permits one fresh retry');
  } finally { second.child.kill(); await second.closed; }
  const reordered = client();
  try {
    reordered.send({ jsonrpc: '2.0', id: 'order1', method: 'initialize', params: {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    } });
    const response = await reordered.receive('order1');
    reordered.send({ jsonrpc: '2.0', id: 'order2', method: 'initialize', params: {
      clientCapabilities: { terminal: true, fs: { writeTextFile: false, readTextFile: false } }, protocolVersion: 1,
    } });
    assert.deepEqual(await reordered.receive('order2'), { ...response, id: 'order2' },
      'equivalent capability objects match regardless of key order');
  } finally { reordered.child.kill(); await reordered.closed; }
  // Both probe-first and browser-first handshakes must share one adapter.
  for (const variants of [
    [{}, { fs: {} }, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }],
    [{ fs: { readTextFile: false, writeTextFile: false } }, {}],
  ]) {
    const normalized = client();
    try {
      variants.forEach((clientCapabilities, id) => normalized.send({
        jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities },
      }));
      for (let id = 0; id < variants.length; id++) {
        assert.ok((await normalized.receive(id)).result,
          'omitted and explicitly disabled capabilities must share initialization');
      }
      normalized.send({ jsonrpc: '2.0', id: 'cached', method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} } });
      assert.ok((await normalized.receive('cached')).result, 'normalized cached handshake succeeds');
      for (const [id, params] of [
        ['version', { protocolVersion: 2, clientCapabilities: {} }],
        ['fs', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } }],
        ['terminal', { protocolVersion: 1, clientCapabilities: { terminal: true } }],
        ['extension', { protocolVersion: 1, clientCapabilities: { custom: false } }],
      ]) {
        normalized.send({ jsonrpc: '2.0', id, method: 'initialize', params });
        assert.equal((await normalized.receive(id)).error?.code, -32602,
          'different versions, enabled capabilities and unknown fields remain incompatible');
      }
      normalized.send({ jsonrpc: '2.0', id: 'stats', method: 'stats', params: {} });
      assert.equal((await normalized.receive('stats')).result.calls, 1);
    } finally { normalized.child.kill(); await normalized.closed; }
  }
  console.log('PASS Codex initialize coalescing, cached ids, pass-through, failure retry and child exit');
}
