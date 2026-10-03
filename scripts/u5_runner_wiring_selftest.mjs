#!/usr/bin/env node
// u5_runner_wiring_selftest.mjs — U5 production-runner wiring tests.
//
// Covers the managed driver + tick pump inside server/acp-runner.mjs:
//   * import safety — importing the runner installs nothing, spawns nothing;
//   * default-off gate — no scheduler/client/runtime is built unless
//     ACP_EXEC_START=1 (or enabled is injected);
//   * concurrent ticking — managed ticks keep firing while the legacy pass
//     is blocked inside a long runCard (the starvation fix);
//   * serialization — a tick slower than the interval never overlaps;
//   * failure isolation — a throwing tick never kills the pump or the legacy
//     pass, and a legacy failure never stops the pump;
//   * --once bounded semantics — pump runs during the pass, bounded drain on
//     exit, no terminalization;
//   * --serve shutdown — injected SIGTERM stops scheduling and drains; a wedged
//     in-flight tick cannot hang shutdown;
//   * API-down — the pump keeps driving tick() (the scheduler itself decides
//     not to launch; covered by the scheduler's own tests).
//
// Real Compose/HTTP proof is U7 — everything here is injected/in-process.
// Run: node scripts/u5_runner_wiring_selftest.mjs

import assert from 'node:assert/strict';
import {
  createManagedDriver,
  createManagedPump,
  runOnce,
  runServe,
} from '../server/acp-runner.mjs';

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`FAIL ${name}: ${e?.stack || e}`);
  }
}

// Deterministic timer wheel: setTimeout callbacks fire only when advance()
// moves the clock. Handles mimic the unref'd Node Timeout interface.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const queue = new Map();
  const setTimeoutFn = (fn, ms) => {
    const id = ++seq;
    queue.set(id, { at: now + (Number(ms) || 0), fn });
    return { id, unref() {} };
  };
  const clearTimeoutFn = (t) => { if (t) queue.delete(t.id); };
  const advance = (ms) => {
    const target = now + ms;
    for (;;) {
      let nid = null;
      let at = Infinity;
      for (const [id, t] of queue) {
        if (t.at <= target && t.at < at) { at = t.at; nid = id; }
      }
      if (nid === null) break;
      now = at;
      const f = queue.get(nid).fn;
      queue.delete(nid);
      f();
    }
    now = target;
  };
  return {
    now: () => now,
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    pending: () => queue.size,
  };
}

// Let queued microtasks/async continuations settle between timer advances.
const flush = () => new Promise((r) => setImmediate(r));

function fakeClient() {
  return { kind: 'fake-client', calls: [] };
}
function fakeRuntime() {
  return { kind: 'fake-runtime' };
}

await test('import side-effect free: no signal listeners, fast import', async () => {
  const before = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
  const m = await import('../server/acp-runner.mjs');
  const after = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
  assert.deepEqual(after, before, 'import must not install signal handlers');
  assert.equal(typeof m.createManagedDriver, 'function');
});

await test('gate off: no scheduler/client/runtime/pump construction', async () => {
  let built = [];
  const d = await createManagedDriver({
    env: {}, // ACP_EXEC_START unset
    schedulerFactory: () => { built.push('scheduler'); return {}; },
    runtimeFactory: () => { built.push('runtime'); return {}; },
    clientFactory: () => { built.push('client'); return {}; },
  });
  assert.equal(d.enabled, false);
  assert.deepEqual(built, []);
  assert.equal(d.scheduler, null);
  assert.equal(d.pump, null);
  await d.start(); // no-op
  await d.stop();
  assert.deepEqual(d.describe().state, 'disabled');
});

await test('gate on: wires client+runtime+scheduler+pump, tick reaches scheduler', async () => {
  const seen = { client: null, runtime: null, schedulerOpts: null };
  let ticked = 0;
  const d = await createManagedDriver({
    env: { ACP_EXEC_START: '1', ACP_EXEC_VALIDATION: '1' },
    clientFactory: (opts) => { seen.client = opts; return fakeClient(); },
    runtimeFactory: (opts) => { seen.runtime = opts; return fakeRuntime(); },
    schedulerFactory: (opts) => {
      seen.schedulerOpts = opts;
      return { instanceId: 'inst-1', runnerId: opts.runnerId, tick: async () => { ticked++; } };
    },
    stateDir: '/tmp/acp-test-state',
    runnerId: 'host-runner',
  });
  assert.equal(d.enabled, true);
  assert.ok(seen.client, 'internal client built');
  assert.equal(seen.client.baseUrl, 'http://127.0.0.1:25900');
  assert.equal(seen.client.stateDir, '/tmp/acp-test-state');
  assert.ok(seen.runtime, 'porch runtime built');
  assert.equal(seen.schedulerOpts.runnerId, 'host-runner');
  // The resolved gate reaches the scheduler — never a null that would
  // silently disable validation while the log claims it on.
  assert.equal(seen.schedulerOpts.validationEnabled, true);
  assert.equal(seen.schedulerOpts.stateDir, '/tmp/acp-test-state');
  await d.tickOnce();
  assert.equal(ticked, 1);
  assert.deepEqual(d.describe().validation, 'on');
});

// One fake-clock interval + one real microtask turn = one serialized tick.
// Async ticks never settle inside a synchronous advance() — the interleave
// IS the honest serialization model (one in flight at a time, always).
async function drive(t, steps, per) {
  for (let i = 0; i < steps; i++) {
    t.advance(per);
    await flush();
  }
}

await test('pump ticks while the legacy pass is blocked', async () => {
  const t = fakeTimers();
  let ticks = 0;
  const pump = createManagedPump({
    tick: async () => { ticks++; },
    intervalMs: 1000,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: () => {},
  });
  pump.start();
  await flush();
  assert.equal(ticks, 1, 'first tick fires immediately on start');
  // Legacy pass is blocked — the pump is an independent timer chain.
  await drive(t, 10, 1000);
  assert.ok(ticks >= 10, `expected >=10 ticks across 10 intervals, got ${ticks}`);
  const res = await pump.stop();
  assert.equal(res.drained, true);
  const after = ticks;
  t.advance(5000);
  await flush();
  assert.equal(ticks, after, 'no ticks after stop');
});

await test('no overlapping ticks: slow tick serializes', async () => {
  const t = fakeTimers();
  let active = 0;
  let maxActive = 0;
  let ticks = 0;
  let release = null;
  const pump = createManagedPump({
    tick: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      ticks++;
      await new Promise((r) => { release = r; });
      active--;
    },
    intervalMs: 100,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: () => {},
  });
  pump.start();
  await flush();
  assert.equal(active, 1, 'one tick in flight');
  t.advance(50_000); // interval fires many times — must queue nothing concurrent
  await flush();
  assert.equal(maxActive, 1, 'never overlapped');
  assert.equal(t.pending(), 0, 'no pending timer while tick in flight');
  const same = pump.fire(); // explicit fire during in-flight must not spawn a second
  await flush();
  assert.equal(active, 1, 'manual fire() joined the in-flight tick');
  assert.equal(ticks, 1);
  release();
  await flush();
  assert.equal(ticks, 1);
  t.advance(300);
  await flush();
  assert.ok(ticks >= 2, 'chain resumes after the slow tick settles');
  release(); // release the second tick so stop() drains instantly
  await flush();
  const res = await pump.stop({ drainMs: 500 });
  assert.equal(res.drained, true);
});

await test('failure isolation: throwing ticks never stop the pump', async () => {
  const t = fakeTimers();
  let ticks = 0;
  const errs = [];
  const pump = createManagedPump({
    tick: async () => { ticks++; if (ticks % 2 === 0) throw new Error('tick boom'); },
    intervalMs: 100,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: (e) => errs.push(String(e.message)),
  });
  pump.start();
  await flush();
  await drive(t, 10, 100);
  assert.ok(ticks >= 10, `pump kept going (${ticks})`);
  assert.ok(errs.length >= 4, `errors surfaced (${errs.length})`);
  assert.equal(pump.errors(), errs.length);
  await pump.stop();
});

await test('sync-throwing tick cannot stall the pump', async () => {
  // Regression: a tick that throws SYNCHRONOUSLY used to leave `inFlight`
  // pinned to a completed promise — every later fire() saw "busy" and the
  // pump never ticked again.
  const t = fakeTimers();
  let ticks = 0;
  const pump = createManagedPump({
    tick: () => { ticks++; if (ticks === 1) throw new Error('sync boom'); },
    intervalMs: 100,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: () => {},
  });
  pump.start();
  await flush();
  assert.equal(ticks, 1);
  await drive(t, 5, 100);
  assert.ok(ticks >= 5, `pump recovered from the sync throw (${ticks})`);
  await pump.stop();
});

await test('sync-settling tick cannot stall the pump either', async () => {
  const t = fakeTimers();
  let ticks = 0;
  const pump = createManagedPump({
    tick: () => { ticks++; }, // returns undefined — settles synchronously
    intervalMs: 100,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: () => {},
  });
  pump.start();
  await flush();
  await drive(t, 5, 100);
  assert.ok(ticks >= 5, `chain kept going (${ticks})`);
  await pump.stop();
});

await test('stateDir derivation: ACP_EXEC_DIR parent, STATE_DIR wins, inconsistent pair fails', async () => {
  const { resolveManagedStateDir } = await import('../server/acp-runner.mjs');
  assert.equal(
    resolveManagedStateDir({ ACP_EXEC_DIR: '/x/state/execution' }),
    '/x/state',
    'exec dir implies its parent');
  assert.equal(
    resolveManagedStateDir({ STATE_DIR: '/y/state', ACP_EXEC_DIR: '/y/state/execution' }),
    '/y/state',
    'consistent pair');
  // ACP_EXEC_DIR alone under another name must NOT derive a parent —
  // that would put the token at /x/execution while porch uses /x/custom.
  assert.throws(
    () => resolveManagedStateDir({ ACP_EXEC_DIR: '/x/custom' }),
    /inconsistent|split store/,
    'lone non-*/execution ACP_EXEC_DIR is a split store');
  assert.throws(
    () => resolveManagedStateDir({ STATE_DIR: '/a/state', ACP_EXEC_DIR: '/b/exec' }),
    /inconsistent|split store/);
  await assert.rejects(
    () => createManagedDriver({
      enabled: true,
      env: { STATE_DIR: '/a/state', ACP_EXEC_DIR: '/b/exec' },
      client: fakeClient(), runtime: fakeRuntime(),
      scheduler: { instanceId: 'i', tick: async () => {} },
    }),
    /inconsistent/);
  // An explicit dep bypasses derivation (test seam).
  const d = await createManagedDriver({
    enabled: true,
    env: { STATE_DIR: '/a/state', ACP_EXEC_DIR: '/b/exec' },
    stateDir: '/injected/state',
    client: fakeClient(), runtime: fakeRuntime(),
    scheduler: { instanceId: 'i', tick: async () => {} },
  });
  assert.equal(d.enabled, true);
});

await test('runOnce with managed enabled refuses before constructing anything', async () => {
  let built = 0;
  let passRan = false;
  const driver = await createManagedDriver({
    enabled: true,
    clientFactory: () => { built++; return fakeClient(); },
    runtimeFactory: () => { built++; return fakeRuntime(); },
    schedulerFactory: () => { built++; return { instanceId: 'i', tick: async () => {} }; },
  });
  assert.ok(built >= 1, 'sanity: enabled driver did construct');
  // runOnce must refuse BEFORE the pass ever runs.
  const origErr = console.error;
  const origExit = process.exitCode;
  const errs = [];
  console.error = (s) => errs.push(String(s));
  try {
    await runOnce({
      env: { ACP_EXEC_START: '1' },
      passOnceImpl: async () => { passRan = true; return []; },
    });
  } finally {
    console.error = origErr;
    process.exitCode = origExit;
  }
  assert.equal(passRan, false, 'no legacy pass when managed would be orphaned');
  assert.ok(errs.some((s) => s.includes('--serve')), 'refusal points at --serve');
  // And an already-built enabled driver is refused the same way.
  let pass2 = false;
  console.error = () => {};
  try {
    await runOnce({ driver, passOnceImpl: async () => { pass2 = true; return []; } });
  } finally {
    console.error = origErr;
    process.exitCode = origExit;
  }
  assert.equal(pass2, false);
  assert.equal(driver.pump.ticks(), 0, 'refusal never started the pump');
});

await test('runOnce disabled: legacy pass only, zero managed construction', async () => {
  let built = 0;
  let passRan = false;
  const origLog = console.log;
  let printed = null;
  console.log = (s) => { printed = s; };
  try {
    await runOnce({
      env: {},
      passOnceImpl: async () => { passRan = true; return []; },
      driver: await createManagedDriver({
        env: {},
        clientFactory: () => { built++; return fakeClient(); },
      }),
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(passRan, true);
  assert.equal(built, 0, 'disabled driver built nothing');
  const out = JSON.parse(printed);
  assert.equal(out.managed.enabled, false);
});

await test('runServe: pump ticks during blocked pass; injected SIGTERM stops, never terminalizes', async () => {
  const t = fakeTimers();
  let ticks = 0;
  const calls = [];
  const scheduler = {
    instanceId: 'inst-serve',
    tick: async () => { ticks++; calls.push('tick'); },
  };
  const driver = await createManagedDriver({
    enabled: true,
    client: fakeClient(),
    runtime: fakeRuntime(),
    scheduler,
    tickMs: 250,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onTickError: () => {},
  });
  let onSig = null;
  let passCount = 0;
  let releasePass = null;
  const p = runServe({
    passOnceImpl: async () => {
      passCount++;
      if (passCount === 1) {
        // First pass sits blocked like a long runCard — managed ticks must flow.
        await new Promise((r) => { releasePass = r; });
      }
      return [];
    },
    driver,
    pollImpl: async () => 1000,
    setTimeoutFn: t.setTimeoutFn,
    registerSignals: (fn) => { onSig = fn; return () => {}; },
  });
  await flush();
  await drive(t, 8, 250); // pump ticks while the legacy pass is blocked
  assert.ok(ticks >= 8, `ticks while legacy pass blocked: ${ticks}`);
  // SIGTERM lands while the legacy pass is STILL blocked — the pump must
  // quiesce immediately, not when the pass returns.
  onSig('SIGTERM');
  await flush();
  const atSignal = ticks;
  await drive(t, 6, 1000); // pass still blocked — zero new managed ticks
  assert.equal(ticks, atSignal,
    'pump kept ticking after the signal while the pass was blocked');
  releasePass();          // let the legacy pass finish → loop sees stopped
  await drive(t, 2, 1500);
  await p;
  assert.ok(passCount >= 1);
  assert.deepEqual([...new Set(calls)], ['tick'],
    'scheduler only ever saw tick() — shutdown never terminalized anything');
  await drive(t, 4, 1000);
  assert.equal(ticks, atSignal, 'no ticks after shutdown');
});

await test('stop before the deferred first tick runs zero work', async () => {
  // start() queues the first tick as a microtask — a stop landing before it
  // must drop it: nothing was ever launched, so nothing is owed.
  const t = fakeTimers();
  let ticks = 0;
  const pump = createManagedPump({
    tick: async () => { ticks++; },
    intervalMs: 100,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: () => {},
  });
  pump.start();
  await pump.stop();       // lands before the microtask runs
  await flush();
  assert.equal(ticks, 0, 'queued-but-unstarted tick must not run after stop');
  await drive(t, 5, 100);
  assert.equal(ticks, 0);
  // The explicit seam still works post-stop (test/diagnostic use).
  await pump.fire();
  await flush();
  assert.equal(ticks, 1, 'manual fire() stays available after stop');
});

await test('stop drains a wedged tick within the bound', async () => {
  const t = fakeTimers();
  let started = 0;
  const pump = createManagedPump({
    tick: () => { started++; return new Promise(() => {}); }, // never settles
    intervalMs: 100,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: () => {},
  });
  pump.start();
  await flush();
  assert.equal(started, 1);
  // Real-clock bound so the test itself cannot hang.
  const t0 = Date.now();
  const res = await pump.stop({ drainMs: 50 });
  assert.ok(Date.now() - t0 < 2000, 'bounded drain returned promptly');
  assert.equal(res.drained, false, 'wedged tick reported, not waited on');
});

await test('driver.stop: quiesce BEFORE pump stop, drain inside one budget', async () => {
  const order = [];
  let pumpBudget = null;
  let drainBudget = null;
  let spentByPump = 0;
  const driver = await createManagedDriver({
    enabled: true,
    env: { STATE_DIR: '/x/state' },
    stateDir: '/x/state',
    client: fakeClient(), runtime: fakeRuntime(),
    scheduler: {
      instanceId: 'i', tick: async () => ({}),
      quiesce: () => order.push('quiesce'),
      drain: async (ms) => { order.push('drain'); drainBudget = ms; return { drained: 1, pending: 0 }; },
    },
    pump: {
      start: () => {}, fire: async () => {},
      stop: async ({ drainMs }) => {
        order.push('pump.stop');
        pumpBudget = drainMs;
        // Consume REAL time so the shared-deadline deduction is observable.
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 150));
        spentByPump = Date.now() - t0;
        return { drained: true };
      },
      ticks: () => 0, errors: () => 0,
    },
  });
  const t0 = Date.now();
  const res = await driver.stop({ drainMs: 5000 });
  const elapsed = Date.now() - t0;
  assert.deepEqual(order, ['quiesce', 'pump.stop', 'drain'],
    'fence up before the pump stops; task drain last');
  assert.ok(pumpBudget <= 5000, `pump allowance within budget: ${pumpBudget}`);
  assert.ok(drainBudget <= 5000 - spentByPump + 25,
    `drain allowance reduced by actual elapsed: drainBudget=${drainBudget} spent=${spentByPump}`);
  assert.ok(elapsed < 5000, `total stop stayed inside the shared bound: ${elapsed}ms`);
  assert.equal(res.tasks?.pending, 0, 'drain result surfaced');
});

await test('API down: tick errors are contained, pump survives to retry', async () => {
  const t = fakeTimers();
  let ticks = 0;
  const pump = createManagedPump({
    tick: async () => {
      ticks++;
      const e = new Error('connect ECONNREFUSED');
      e.status = undefined; // transport-class outage
      throw e;
    },
    intervalMs: 200,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onError: () => {},
  });
  pump.start();
  await flush();
  await drive(t, 10, 200);
  assert.ok(ticks >= 10, `pump retried through outage: ${ticks}`);
  assert.equal(pump.errors(), ticks, 'every tick errored but the pump lived');
  await pump.stop();
});

await test('legacy pass failure does not kill the pump (runServe loop)', async () => {
  const t = fakeTimers();
  let ticks = 0;
  const driver = await createManagedDriver({
    enabled: true,
    client: fakeClient(),
    runtime: fakeRuntime(),
    scheduler: { instanceId: 'inst-err', tick: async () => { ticks++; } },
    tickMs: 250,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    onTickError: () => {},
  });
  const origErr = console.error;
  const errs = [];
  console.error = (s) => errs.push(String(s));
  let onSig = null;
  let passes = 0;
  try {
    const p = runServe({
      passOnceImpl: async () => { passes++; throw new Error('legacy boom'); },
      driver,
      pollImpl: async () => 500,
      setTimeoutFn: t.setTimeoutFn,
      registerSignals: (fn) => { onSig = fn; return () => {}; },
    });
    await drive(t, 6, 600); // poll waits + pump ticks interleave
    assert.ok(errs.some((s) => s.includes('legacy boom')), 'legacy error logged');
    assert.ok(ticks >= 4, `pump kept ticking through legacy failures (${ticks})`);
    onSig('SIGTERM');
    await drive(t, 2, 600);
    await p;
  } finally {
    console.error = origErr;
  }
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
