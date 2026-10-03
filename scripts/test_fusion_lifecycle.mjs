import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPanelDriver } from '../server/execution/fusion/controller.mjs';
import { createHandoffDriver } from '../server/execution/fusion/handoff.mjs';

const owner = { runnerId: 'runner', instanceId: 'instance' };
function fixture(role, overrides = {}) {
  const att = { id: 'attempt', role, participantId: 'p', status: 'running', porchRunId: 'porch', owner, createdAt: Date.now() };
  const run = { id: 'run-test', status: 'active', phase: 'hold', attempts: [att], fusion: {
    owner, fingerprint: 'f', resultKind: 'document', limits: { timeoutMin: 45 },
    snapshot: { task: { versionId: 'task', sha256: 'a' }, project: { projectRoot: '/project', snapshotSha: 'b' } },
    participants: [{ id: 'p', status: 'running', profileId: 'profile', profile: {} }],
    judge: { profileId: 'profile', profile: {} }, integrator: { profileId: 'profile', profile: {} },
    workOrders: [{ artifactId: 'wo', versionId: 'wo_v1' }],
  } };
  const commands = []; let starts = 0;
  const runtime = { wait: async () => ({ outcome: 'observer_timeout' }),
    cancel: async () => ({ ok: true, requested: true }),
    launchRecord: async () => ({ missing: true }), reconcile: async () => ({ ok: true, matches: [], workers: [] }),
    start: async () => { starts++; return { ok: false, phase: 'launch_uncertain' }; }, ...overrides };
  const deps = { runtime, self: () => owner, getRun: async () => run, getDocument: async () => ({ content: 'task' }),
    getArtifact: async () => ({ contentBase64: Buffer.from('order').toString('base64') }),
    ensureWorkspace: async () => ({ ok: true }), recordEvent: async () => {},
    send: async (_card, type, payload) => { commands.push({ type, payload });
      if (type === 'resolve_attempt') att.status = payload.outcome;
      if (type === 'bind_attempt') { att.porchRunId = payload.porchRunId; att.status = 'running'; }
    },
  };
  const driver = (role === 'panelist' ? createPanelDriver : createHandoffDriver)(deps);
  return { run, att, runtime, deps, driver, commands, starts: () => starts, drive: () => driver.drive({ cardId: 'card' }, structuredClone(run)) };
}
for (const role of ['panelist', 'judge', 'integrator']) {
  test(`${role}: observer timeout never resolves a live attempt`, async () => {
    const f = fixture(role); await f.drive(); assert.equal(f.att.status, 'running');
    assert.equal(f.commands.some(c => c.type === 'resolve_attempt'), false);
  });
  for (const failure of ['throws', 'refused']) test(`${role}: cancel ${failure} retries until confirmed`, async () => {
    let calls = 0; const f = fixture(role, { cancel: async () => { calls++; if (calls === 1) {
      if (failure === 'throws') throw new Error('controller unavailable'); return { ok: false, requested: false };
    } return { ok: true, requested: true }; } });
    f.att.status = 'cancelling'; f.att.cancel = { reason: 'stop' };
    await f.drive(); await f.drive(); await f.drive(); assert.equal(calls, 2); assert.equal(f.att.status, 'cancelling');
  });
  test(`${role}: flattened launch binding recovers without registry scan`, async () => {
    const f = fixture(role, { launchRecord: async () => ({ phase: 'launched', porchRunId: 'recovered', missing: false }),
      reconcile: async () => { throw new Error('registry unavailable'); } });
    f.att.status = 'launching'; delete f.att.porchRunId; await f.drive(); assert.equal(f.att.porchRunId, 'recovered');
  });
  test(`${role}: unreadable launch record never proves absence`, async () => {
    const f = fixture(role, { launchRecord: async () => { throw new Error('disk failure'); } });
    f.att.status = 'cancelling'; delete f.att.porchRunId; f.att.cancel = { reason: 'stop' };
    await f.drive(); assert.equal(f.att.status, 'cancelling'); assert.equal(f.starts(), 0);
  });
  test(`${role}: stop arriving during missing-record observation fences recovery launch`, async () => {
    const f = fixture(role); f.att.status = 'launching'; delete f.att.porchRunId;
    f.runtime.launchRecord = async () => { f.run.status = 'stopping'; f.att.cancel = { reason: 'stop' }; return { missing: true }; };
    await f.drive(); assert.equal(f.starts(), 0);
  });
  test(`${role}: thrown start remains uncertain for reconciliation`, async () => {
    const f = fixture(role, { start: async () => { throw new Error('response lost'); } });
    f.att.status = 'launching'; delete f.att.porchRunId; await f.drive(); assert.equal(f.att.status, 'launching');
  });
  test(`${role}: multiple registry matches never choose an arbitrary run`, async () => {
    const f = fixture(role, { launchRecord: async () => ({ phase: 'launch_uncertain', missing: false }),
      reconcile: async () => ({ ok: true, matches: [{ runId: 'one' }, { runId: 'two' }], workers: [] }) });
    f.att.status = 'launching'; delete f.att.porchRunId; await f.drive(); assert.equal(f.att.porchRunId, undefined);
  });
  test(`${role}: fresh begin followed by stop never starts a worker`, async () => {
    const f = fixture(role); f.run.attempts = [];
    f.run.phase = role === 'panelist' ? 'panel' : role === 'judge' ? 'judge' : 'integrate';
    f.run.fusion.participants[0].status = 'pending';
    f.deps.send = async (_card, type, payload) => {
      f.commands.push({ type, payload });
      if (['panel_begin', 'judge_begin', 'integrate_begin'].includes(type)) {
        f.run.attempts.push({ id: payload.attemptId, role, owner, status: 'cancelling', cancel: { reason: 'stop' } });
        f.run.status = 'stopping';
      }
    };
    const driver = (role === 'panelist' ? createPanelDriver : createHandoffDriver)(f.deps);
    await driver.drive({ cardId: 'card' }, structuredClone(f.run));
    assert.equal(f.commands.some(c => c.type.endsWith('_begin')), true);
    assert.equal(f.starts(), 0);
  });
  test(`${role}: in-flight launch cannot be resolved from an absent record`, async () => {
    let entered; const began = new Promise(resolve => { entered = resolve; });
    let release; const pending = new Promise(resolve => { release = resolve; });
    const f = fixture(role, { start: async () => { entered(); return pending; } });
    f.att.status = 'launching'; delete f.att.porchRunId;
    const first = f.drive(); await began;
    f.run.status = 'stopping'; f.att.status = 'cancelling'; f.att.cancel = { reason: 'stop' };
    await f.drive(); assert.equal(f.commands.some(c => c.type === 'resolve_attempt'), false);
    release({ ok: false, phase: 'launch_uncertain' }); await first;
  });
  test(`${role}: flattened timestamp and explicit worker absence prove an orphan`, async () => {
    const f = fixture(role, { launchRecord: async () => ({ phase: 'launch_uncertain', missing: false,
      launchStartedAt: '2020-01-01T00:00:00.000Z' }),
      reconcile: async () => ({ ok: true, matches: [], workers: [{ gone: true }] }) });
    f.att.status = 'launching'; delete f.att.porchRunId;
    await f.drive(); assert.equal(f.att.status, 'failed');
    assert.match(f.commands.find(c => c.type === 'resolve_attempt').payload.reason, /orphaned/);
  });

}
