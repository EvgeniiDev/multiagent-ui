import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerReaper } from '../server/execution/fusion/reaper.mjs';
import * as containerRuntime from '../server/execution/environment/container-runtime.mjs';
import { scopedAgentSpec, validateAgentProfile } from '../server/execution/environment/agent-profile.mjs';

const RUN_ID = 'run-bound';
const ATTEMPT_ID = 'attempt-1';

for (const [description, pid] of [
  ['malformed string', 'not-a-pid'],
  ['zero', 0],
  ['negative', -1],
  ['fractional', 1.5],
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['unsafe integer', 9_007_199_254_740_992],
  ['Linux PID_MAX_LIMIT', 4_194_304],
]) {
  test(`processIdentityFor does not probe ${description} PIDs`, async () => {
    const calls = [];
    const runtime = containerRuntime.createContainerRuntime({
      config: { pathFor: () => '/unused' },
      client: { async call(method, params) {
        calls.push({ method, params });
        return { ok: true, exitCode: 0, stdout: '{"target":{}}' };
      } },
    });

    const result = await runtime.processIdentityFor('w-attempt-1', pid);

    assert.equal(result, null);
    assert.deepEqual(calls, []);
  });
}

function fixture(rows, { workerState = 'running', status = 'completed' } = {}) {
  const calls = [];
  const runtime = {
    forAttempt(attemptId) {
      assert.equal(attemptId, ATTEMPT_ID);
      return {
        workerId: `w-${ATTEMPT_ID}`,
        async readReap() { return null; },
        async launchRecord() {
          return { workerId: `w-${ATTEMPT_ID}`, porchRunId: RUN_ID };
        },
        async workerStatus() {
          calls.push('worker.status');
          return { state: workerState };
        },
        async registryRuns() { return { ok: true, complete: true, rows }; },
        async processIdentity(pid) {
          calls.push(`probe:${pid}`);
          return { exists: false };
        },
        async writeReap() {},
        async stopWorker() { calls.push('worker.stop'); workerState = 'stopped'; },
        async removeWorker() { calls.push('worker.remove'); workerState = 'gone'; },
      };
    },
  };
  const reaper = createWorkerReaper({ runtime, getRun: async () => null });
  const att = {
    id: ATTEMPT_ID,
    status,
    porchRunId: RUN_ID,
    launch: { workerId: `w-${ATTEMPT_ID}` },
  };
  return {
    calls,
    reap: () => reaper.reapAttempt({ att }),
  };
}

function row(runId, overrides = {}) {
  return {
    runId,
    metaRunId: runId,
    status: 'completed',
    stateStatus: 'completed',
    finishedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

test('defers a complete registry scan containing a corrupt sibling row', async () => {
  const f = fixture([
    row(RUN_ID, { pid: 1001 }),
    row('run-corrupt', { pid: 1002, corrupt: true }),
  ]);

  const result = await f.reap();

  assert.equal(result.action, 'deferred');
  assert.equal(result.code, 'registry_row_corrupt');
  assert.ok(!f.calls.includes('worker.stop'));
  assert.ok(!f.calls.includes('worker.remove'));
});

for (const [field, badValue, role] of [
  ['pid', 'not-a-pid', 'supervisor'],
  ['childPid', 0, 'child'],
]) {
  test(`defers when a present invalid ${role} PID makes the drain unverifiable`, async () => {
    const pids = field === 'pid'
      ? { pid: badValue, childPid: 2001 }
      : { pid: 2001, childPid: badValue };
    const f = fixture([row(RUN_ID, pids)]);

    const result = await f.reap();

    assert.equal(result.action, 'deferred');
    assert.equal(result.code, 'process_identity_unverifiable');
    assert.ok(f.calls.includes('probe:2001'), 'the other valid PID was positively probed dead');
    assert.ok(!f.calls.includes('worker.stop'));
    assert.ok(!f.calls.includes('worker.remove'));
  });
}

for (const [field, badValue, marker] of [
  ['pid', 'not-a-pid', 'pidInvalid'],
  ['child_pid', 0, 'childPidInvalid'],
]) {
  test(`container registry adapter preserves invalid present ${field} for reaper`, async () => {
    const normalize = containerRuntime.normalizeRegistryRunRow;
    assert.equal(typeof normalize, 'function', 'production registry normalizer is exported');
    const adapted = normalize(RUN_ID, {
      run_id: RUN_ID,
      status: 'completed',
      pid: field === 'pid' ? badValue : 2001,
      child_pid: field === 'child_pid' ? badValue : 2001,
      finished_at: '2026-01-01T00:00:00Z',
    }, { status: 'completed' });
    assert.equal(adapted[marker], true);
    const f = fixture([adapted]);

    const result = await f.reap();

    assert.equal(result.action, 'deferred');
    assert.equal(result.code, 'process_identity_unverifiable');
    assert.ok(f.calls.includes('probe:2001'), 'the other valid PID was positively probed dead');
    assert.ok(!f.calls.includes('worker.stop'));
    assert.ok(!f.calls.includes('worker.remove'));
  });
}

// Linux pid_max is exclusive; PID_MAX_LIMIT is 2^22 (Linux
// include/linux/threads.h), while every JavaScript PID must also be safe.
for (const [description, badValue] of [
  ['negative', -1],
  ['fractional', 1.5],
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['unsafe integer', 9_007_199_254_740_992],
  ['Linux PID_MAX_LIMIT', 4_194_304],
]) {
  test(`container registry adapter rejects ${description} PIDs`, () => {
    const adapted = containerRuntime.normalizeRegistryRunRow(RUN_ID, {
      run_id: RUN_ID,
      status: 'completed',
      pid: badValue,
      child_pid: 2001,
      finished_at: '2026-01-01T00:00:00Z',
    }, { status: 'completed' });

    assert.equal(adapted.pid, null);
    assert.equal(adapted.pidInvalid, true);
  });

  test(`reaper refuses to drain when a ${description} PID is recorded`, async () => {
    const f = fixture([row(RUN_ID, { pid: badValue, childPid: 2001 })]);

    const result = await f.reap();

    assert.equal(result.action, 'deferred');
    assert.equal(result.code, 'process_identity_unverifiable');
    assert.ok(f.calls.includes('probe:2001'), 'the other valid PID was positively probed dead');
    assert.ok(!f.calls.includes(`probe:${badValue}`));
    assert.ok(!f.calls.includes('worker.stop'));
    assert.ok(!f.calls.includes('worker.remove'));
  });
}

for (const value of [null, undefined]) {
  test(`adapter treats ${value} PID fields as absent`, async () => {
    const meta = {
      run_id: RUN_ID, status: 'completed',
      finished_at: '2026-01-01T00:00:00Z',
      ...(value === null ? { pid: null, child_pid: null } : {}),
    };
    const adapted = containerRuntime.normalizeRegistryRunRow(RUN_ID, meta, { status: 'completed' });
    assert.equal(adapted.pid, null);
    assert.equal(adapted.childPid, null);
    assert.equal(adapted.pidInvalid, false);
    assert.equal(adapted.childPidInvalid, false);

    const running = fixture([adapted]);
    const result = await running.reap();
    assert.equal(result.action, 'deferred');
    assert.equal(result.code, 'process_identity_missing');
    assert.deepEqual(running.calls, ['worker.status']);

    const stopped = fixture([adapted], { workerState: 'stopped' });
    assert.equal((await stopped.reap()).action, 'reaped');
    assert.deepEqual(stopped.calls, ['worker.status', 'worker.remove', 'worker.status']);
  });
}

for (const [field, otherField] of [['pid', 'child_pid'], ['child_pid', 'pid']]) {
  test(`explicit null ${field} permits draining a valid sibling PID`, async () => {
    const adapted = containerRuntime.normalizeRegistryRunRow(RUN_ID, {
      run_id: RUN_ID, status: 'completed',
      [field]: null, [otherField]: 2001,
      finished_at: '2026-01-01T00:00:00Z',
    }, { status: 'completed' });
    const f = fixture([adapted]);
    assert.equal((await f.reap()).action, 'reaped');
    assert.deepEqual(f.calls, [
      'worker.status', 'probe:2001', 'worker.stop', 'worker.status',
      'worker.remove', 'worker.status',
    ]);
  });
}

for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'blocked']) {
  test(`terminal attempt ${status} remains eligible for proof-gated reaping`, async () => {
    const f = fixture([row(RUN_ID, { pid: 2001 })], { status });
    assert.equal((await f.reap()).action, 'reaped');
  });
}

for (const status of ['launching', 'running', 'cancelling', 'unknown']) {
  test(`attempt ${status} never permits worker mutation`, async () => {
    const f = fixture([row(RUN_ID, { pid: 2001 })], { status });
    assert.equal((await f.reap()).action, 'live');
    assert.deepEqual(f.calls, []);
  });
}

for (const workerState of ['stopped', 'gone']) {
  test(`invalid PID defers even when worker is ${workerState}`, async () => {
    const f = fixture([row(RUN_ID, { pid: -1 })], { workerState });
    const result = await f.reap();
    assert.equal(result.action, 'deferred');
    assert.equal(result.code, 'process_identity_unverifiable');
    assert.deepEqual(f.calls, ['worker.status']);
  });
}

function searchProfile(params = {}) {
  return {
    profileId: 'search-profile',
    pi: { version: '1.2.3' },
    image: 'worker-image',
    provider: 'model-provider',
    model: 'model-provider/model-name',
    search: { enabled: true, provider: 'requested-search-provider', params },
  };
}

const sourceModels = { providers: { 'model-provider': { apiKey: 'secret' } } };

test('scoped search config preserves requested provider and authoritative proxy', () => {
  const files = scopedAgentSpec(searchProfile({ safeOption: true }), sourceModels, {
    searchProxy: 'http://egress-proxy:8080',
  });

  assert.deepEqual(files['web-search.json'], {
    provider: 'requested-search-provider',
    proxy: 'http://egress-proxy:8080',
    safeOption: true,
  });
});

test('scoped search config does not add a proxy when none was supplied', () => {
  const files = scopedAgentSpec(searchProfile({ safeOption: true }), sourceModels);

  assert.deepEqual(files['web-search.json'], {
    provider: 'requested-search-provider',
    safeOption: true,
  });
});

for (const key of ['provider', 'proxy']) {
  test(`search profile rejects reserved ${key} params`, () => {
    assert.throws(
      () => validateAgentProfile(searchProfile({ [key]: 'attacker-value' })),
      new RegExp(`search\\.params.*${key}.*reserved`, 'i'),
    );
  });
}
