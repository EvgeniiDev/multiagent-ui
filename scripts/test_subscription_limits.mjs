import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createSubscriptionReader, normalizeCodex, normalizeOpenCode, readCodexLimits } from '../server/usage/subscription-limits.mjs';
import { createRequestHandler } from '../server/acp-state-server.mjs';

test('Codex identifies windows by duration, handles weekly-only and multiple buckets', () => {
  const result = normalizeCodex({ rateLimits: { primary: { usedPercent: 53, windowDurationMins: 10080, resetsAt: 1792649611 }, secondary: null } });
  assert.equal(result.windows.length, 1);
  assert.deepEqual(result.windows[0], { id: 'codex-primary', label: 'Weekly', usedPercent: 53, resetsAt: 1792649611000 });
  const multi = normalizeCodex({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0, windowDurationMins: 300 } },
    review: { primary: { usedPercent: 100, windowDurationMins: 10080 } },
  } });
  assert.deepEqual(multi.windows.map(w => w.label), ['codex · 5-hour', 'review · Weekly']);
  assert.equal(normalizeCodex({}).status, 'unavailable');
  assert.equal(normalizeCodex({ rateLimits: { primary: { usedPercent: null } } }).windows.length, 0);
});

test('Go maps real percentages and reset dates; missing windows are not zero', () => {
  const data = normalizeOpenCode({ usage: { rolling: { percent: 0, resetsAt: '2026-10-18T00:00:00Z' }, weekly: { percent: 120 }, monthly: { percent: '15' } } });
  assert.deepEqual(data.windows.map(w => [w.label, w.usedPercent]), [['5-hour', 0], ['Weekly', 100]]);
  assert.equal(data.windows[0].resetsAt, Date.parse('2026-10-18T00:00:00Z'));
});

test('concurrent reads share requests and cache expires; never return credentials or provider errors', async () => {
  let clock = 1000, calls = 0;
  const reader = createSubscriptionReader({ now: () => clock,
    codexReader: async () => { calls++; return { rateLimits: { primary: { usedPercent: 10 } } }; },
    read: async () => JSON.stringify({ 'opencode-go': { key: 'SECRET' } }),
    fetcher: async (url, options) => {
      assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
      assert.equal(options.headers.Authorization, 'Bearer SECRET');
      return { ok: false, status: 403 };
    },
  });
  const [a, b] = await Promise.all([reader(), reader()]);
  assert.equal(a, b); assert.equal(calls, 1);
  assert.equal(a.providers[1].status, 'unavailable');
  assert.match(a.providers[1].message, /Go subscription/);
  assert(!JSON.stringify(a).includes('SECRET'));
  await reader(); assert.equal(calls, 1);
  clock += 60001; await reader(); assert.equal(calls, 2);
});

test('provider failures remain independent and missing auth is explicit', async () => {
  const reader = createSubscriptionReader({ codexReader: async () => { throw Error('SECRET'); }, read: async () => { throw Error('ENOENT'); }, fetcher: () => { throw Error('must not fetch'); } });
  const result = await reader();
  assert.deepEqual(result.providers.map(p => p.status), ['unavailable', 'not_connected', 'not_connected']);
  assert(!JSON.stringify(result).includes('SECRET'));
});

test('Codex helper sends only initialize and account read, and terminates its own child', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.exitCode = 0;
  const sent = []; let killed = false;
  child.kill = () => { killed = true; };
  child.stdin = new Writable({ write(chunk, _, done) {
    const request = JSON.parse(String(chunk)); sent.push(request.method);
    if (request.id) setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, result: request.id === 1 ? {} : { rateLimits: {} } }) + '\n'));
    done();
  } });
  await readCodexLimits({ spawnProcess: () => child });
  assert.deepEqual(sent, ['initialize', 'initialized', 'account/rateLimits/read']);
  assert(killed);
});

test('a stalled account read times out and waits for its own helper to close', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.exitCode = null; child.pid = 1;
  child.stdin = new Writable({ write(_, __, done) { done(); } });
  let closed = false;
  child.kill = () => { setImmediate(() => { closed = true; child.exitCode = 0; child.emit('close'); }); };
  await assert.rejects(readCodexLimits({ spawnProcess: () => child, timeoutMs: 10 }), /timeout/);
  assert(closed);
});

test('GET subscription limits is read-only and cache-control is private to the server reader', async () => {
  const data = { updatedAt: 1, providers: [] }; let status, body; const headers = {};
  const handler = createRequestHandler({ request() { throw Error('must not write state'); } }, { limitsReader: async () => data });
  await handler({ method: 'GET', url: '/api/subscription-limits' }, {
    setHeader(k, v) { headers[k] = v; }, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); },
  });
  assert.equal(status, 200); assert.deepEqual(body, data); assert.equal(headers['cache-control'], 'no-store');
});
