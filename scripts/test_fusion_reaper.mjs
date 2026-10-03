import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerReaper } from '../server/execution/fusion/reaper.mjs';

const RUN_ID = 'run-bound';
const ATTEMPT_ID = 'attempt-1';

function fixture(rows) {
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
          return { state: 'running' };
        },
        async registryRuns() { return { ok: true, complete: true, rows }; },
        async processIdentity(pid) {
          calls.push(`probe:${pid}`);
          return { exists: false };
        },
        async writeReap() {},
        async stopWorker() { calls.push('worker.stop'); },
        async removeWorker() { calls.push('worker.remove'); },
      };
    },
  };
  const reaper = createWorkerReaper({ runtime, getRun: async () => null });
  const att = {
    id: ATTEMPT_ID,
    status: 'completed',
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
