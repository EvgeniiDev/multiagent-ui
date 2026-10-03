// scripts/test_orchestrator_graph.mjs — deterministic O1 orchestrator-graph tests.
//   node --test scripts/test_orchestrator_graph.mjs
//
// Exercises the standalone O1 decomposition/graph contract in
// server/execution/orchestrator/: strict server-side validation (fail
// closed), the deterministic transition/event contract, pending approval
// for changes to accepted inputs, and idempotent command replay.
// Everything is in-memory — no runtime, no compose, no listeners.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAFE_ID_RE } from '../server/execution/common.mjs';
import { createOrchestratorService } from '../server/execution/orchestrator/service.mjs';
import * as graphMod from '../server/execution/orchestrator/graph.mjs';

const FIXED = () => '2026-10-03T00:00:00.000Z';
const mk = () => createOrchestratorService({ now: FIXED });

const sha = (ch) => ch.repeat(64);
const COMMIT = 'c'.repeat(40);
let seq = 0;
const cid = (p) => `${p}-${++seq}`;

const inputs = (over = {}) => ({
  requirements: { versionId: 'req-v1', sha256: sha('a') },
  plan: { versionId: 'plan-v1', sha256: sha('b'), requirementsVersionId: 'req-v1' },
  baseCommit: COMMIT,
  ...over,
});

const task = (id, over = {}) => ({
  id,
  title: `title ${id}`,
  outcome: `outcome ${id}`,
  acceptanceCriteria: [`criterion ${id}`],
  dependsOn: [],
  boundary: { paths: [`src/${id}/**`] },
  worker: { profileId: `worker-${id}` },
  ...over,
});

// Declared out of dependency order to prove deterministic topo ordering:
// a is the only root; c,b depend on a; d depends on b,c.
const diamond = () => ([
  task('d', { dependsOn: ['b', 'c'] }),
  task('c', { dependsOn: ['a'] }),
  task('a'),
  task('b', { dependsOn: ['a'] }),
]);

const decompose = (svc, runId, { subs = diamond(), changes, commandId = cid('dec'), ins = inputs() } = {}) =>
  svc.dispatch(runId, {
    commandId,
    type: 'decompose',
    payload: {
      inputs: ins,
      decomposition: { subtasks: subs },
      ...(changes ? { proposedInputChanges: changes } : {}),
    },
  });

const transition = (svc, runId, payload, commandId = cid('tr')) =>
  svc.dispatch(runId, { commandId, type: 'transition_task', payload });

const evTypes = (svc, runId) => svc.events(runId).map((e) => e.type);
const taskOf = (svc, runId, id) => svc.graph(runId).tasks.find((t) => t.id === id);
const statusOf = (svc, runId, id) => taskOf(svc, runId, id).state.status;
const err = (fn) => {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected the call to throw');
};

// ---- creation ---------------------------------------------------------------

test('ordinary decomposition creates an active graph with no user question', () => {
  const svc = mk();
  const r = decompose(svc, 'run_1');
  assert.equal(r.status, 'active');
  assert.equal(r.replayed, false);
  assert.equal(r.subtasks, 4);
  const g = svc.graph('run_1');
  assert.equal(g.status, 'active');
  assert.equal(g.pendingApproval, null);
  // deterministic dependency-first ordering, stable by declaration order
  assert.deepEqual(g.order, ['a', 'c', 'b', 'd']);
  assert.deepEqual(
    evTypes(svc, 'run_1'),
    ['graph_created', 'task_registered', 'task_registered', 'task_registered', 'task_registered'],
  );
  assert.deepEqual(svc.events('run_1').map((e) => e.seq), [1, 2, 3, 4, 5]);
  const reg = svc.events('run_1').slice(1).map((e) => [e.taskId, e.status]);
  assert.deepEqual(reg, [['a', 'ready'], ['c', 'pending'], ['b', 'pending'], ['d', 'pending']]);
  // no approval/question artifacts on the ordinary path
  assert.ok(!evTypes(svc, 'run_1').includes('input_change_proposed'));
});

test('accepted inputs are pinned and deep-frozen', () => {
  const svc = mk();
  decompose(svc, 'run_1');
  const g = svc.graph('run_1');
  assert.ok(Object.isFrozen(g.inputs));
  assert.ok(Object.isFrozen(g.inputs.plan));
  assert.equal(g.inputs.requirements.sha256, sha('a'));
  assert.throws(() => { g.inputs.baseCommit = 'f'.repeat(40); }, TypeError);
});

// ---- validation (fail closed) ------------------------------------------------

test('server validation rejects malformed subtask sets', () => {
  const svc = mk();
  let i = 0;
  const bad = (mut, code) => {
    const subs = diamond();
    mut(subs);
    const runId = `run_bad_${++i}`;
    const e = err(() => decompose(svc, runId, { subs }));
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.equal(e.status, 422);
    assert.equal(svc.graph(runId), null); // nothing persisted
  };
  bad((s) => { s[3].id = s[0].id; }, 'subtask_duplicate');
  bad((s) => { s[0].dependsOn = ['ghost']; }, 'dependency_unknown');
  bad((s) => { s[2].dependsOn = ['d']; }, 'graph_cycle'); // a→d→b→a
  bad((s) => { s[2].acceptanceCriteria = []; }, 'criteria_missing');
  bad((s) => { delete s[2].acceptanceCriteria; }, 'criteria_missing');
  bad((s) => { s[2].acceptanceCriteria = ['   ']; }, 'invalid_argument');
  bad((s) => { delete s[2].boundary; }, 'boundary_missing');
  bad((s) => { s[2].boundary = { paths: ['../escape'] }; }, 'boundary_invalid');
  bad((s) => { delete s[2].worker; }, 'worker_missing');
  bad((s) => { s[2].dependsOn = ['a']; }, 'dependency_self'); // s[2] IS 'a'
  bad((s) => { s[0].surprise = 1; }, 'unexpected_field');
});

test('empty or non-array decomposition is rejected', () => {
  const svc = mk();
  let e = err(() => svc.dispatch('run_e', {
    commandId: cid('c'), type: 'decompose',
    payload: { inputs: inputs(), decomposition: { subtasks: [] } },
  }));
  assert.equal(e.code, 'subtasks_empty');
  e = err(() => svc.dispatch('run_e', {
    commandId: cid('c'), type: 'decompose',
    payload: { inputs: inputs(), decomposition: { subtasks: 'x' } },
  }));
  assert.equal(e.code, 'subtasks_invalid');
});

test('malformed commands and inputs are rejected', () => {
  const svc = mk();
  let e = err(() => svc.dispatch('run_x', { commandId: 'c1', type: 'decompose', payload: 'nope' }));
  assert.equal(e.code, 'malformed');
  e = err(() => svc.dispatch('run_x', { commandId: 'c1', type: 'nope', payload: {} }));
  assert.equal(e.code, 'command_invalid');
  e = err(() => svc.dispatch('run_x', { type: 'decompose', payload: {} }));
  assert.equal(e.code, 'command_invalid');
  e = err(() => svc.dispatch('run_x', { commandId: 'c1', type: 'decompose', payload: {}, extra: 1 }));
  assert.equal(e.code, 'unexpected_field');
  e = err(() => decompose(svc, 'run_y', { ins: { requirements: inputs().requirements, baseCommit: COMMIT } }));
  assert.equal(e.code, 'inputs_invalid'); // plan missing
  e = err(() => decompose(svc, 'run_y', { ins: inputs({ baseCommit: 'short' }) }));
  assert.equal(e.code, 'inputs_invalid');
  e = err(() => decompose(svc, 'run_y', { ins: inputs({ surprise: 1 }) }));
  assert.equal(e.code, 'unexpected_field');
  e = err(() => decompose(svc, 'run_y', { ins: inputs({ plan: { versionId: 'p', sha256: 'nothex' } }) }));
  assert.equal(e.code, 'inputs_invalid');
});

test('secret-shaped keys are never stored', () => {
  const svc = mk();
  let e = err(() => decompose(svc, 'run_s', {
    subs: [task('a', { worker: { profileId: 'w', sessionToken: 'abc' } })],
  }));
  assert.equal(e.code, 'secrets_forbidden');
  e = err(() => decompose(svc, 'run_s', { ins: inputs({ credentials: { password: 'x' } }) }));
  assert.equal(e.code, 'secrets_forbidden');
  e = err(() => transition(svc, 'run_s', { taskId: 'a', to: 'cancelled', apiKey: 'k' }));
  assert.equal(e.code, 'secrets_forbidden');
  // bare credential keys are caught too — not just *_key / auth_* shapes
  e = err(() => transition(svc, 'run_s', { taskId: 'a', to: 'cancelled', authorization: 'Bearer x' }));
  assert.equal(e.code, 'secrets_forbidden');
  e = err(() => transition(svc, 'run_s', { taskId: 'a', to: 'cancelled', bearer: 'x' }));
  assert.equal(e.code, 'secrets_forbidden');
  e = err(() => decompose(svc, 'run_s2', {
    subs: [task('a', { worker: { profileId: 'w', authorization: 'x' } })],
  }));
  assert.equal(e.code, 'secrets_forbidden');
  assert.equal(svc.graph('run_s'), null);
});

// ---- transitions --------------------------------------------------------------

test('deterministic transitions, dependency promotion, invalid edges rejected', () => {
  const svc = mk();
  decompose(svc, 'run_1');
  let e = err(() => transition(svc, 'run_1', { taskId: 'b', to: 'running' }));
  assert.equal(e.code, 'invalid_transition'); // pending → running
  assert.equal(e.status, 409);
  e = err(() => transition(svc, 'run_1', { taskId: 'a', to: 'accepted' }));
  assert.equal(e.code, 'invalid_transition'); // ready → accepted
  e = err(() => transition(svc, 'run_1', { taskId: 'ghost', to: 'running' }));
  assert.equal(e.code, 'task_unknown');
  e = err(() => transition(svc, 'run_1', { taskId: 'b', to: 'ready' }));
  assert.equal(e.code, 'deps_unmet'); // edge legal but a not accepted yet

  transition(svc, 'run_1', { taskId: 'a', to: 'running' });
  assert.equal(statusOf(svc, 'run_1', 'a'), 'running');
  assert.equal(taskOf(svc, 'run_1', 'a').state.attemptsUsed, 1);
  e = err(() => transition(svc, 'run_1', { taskId: 'a', to: 'accepted' }));
  assert.equal(e.code, 'result_required');
  transition(svc, 'run_1', { taskId: 'a', to: 'accepted', result: { ref: 'a'.repeat(40) } });

  assert.equal(statusOf(svc, 'run_1', 'a'), 'accepted');
  assert.equal(statusOf(svc, 'run_1', 'b'), 'ready'); // auto-promoted
  assert.equal(statusOf(svc, 'run_1', 'c'), 'ready');
  assert.equal(statusOf(svc, 'run_1', 'd'), 'pending'); // still needs b AND c
  const tail = svc.events('run_1').slice(-3).map((x) => [x.type, x.taskId, x.from, x.to, x.cause]);
  assert.deepEqual(tail, [
    ['task_status', 'a', 'running', 'accepted', 'command'],
    ['task_status', 'c', 'pending', 'ready', 'dependency_met'],
    ['task_status', 'b', 'pending', 'ready', 'dependency_met'],
  ]);
  e = err(() => transition(svc, 'run_1', { taskId: 'a', to: 'cancelled' }));
  assert.equal(e.code, 'invalid_transition'); // accepted is terminal

  for (const id of ['b', 'c', 'd']) {
    transition(svc, 'run_1', { taskId: id, to: 'running' });
    transition(svc, 'run_1', { taskId: id, to: 'accepted', result: { ref: 'f'.repeat(40) } });
  }
  const g = svc.graph('run_1');
  assert.equal(g.status, 'complete');
  const last = svc.events('run_1').at(-1);
  assert.deepEqual([last.type, last.to], ['graph_status', 'complete']);
});

test('attempt budget: exhaustion auto-blocks, explicit grant re-arms', () => {
  const svc = mk();
  decompose(svc, 'run_2', { subs: [task('x', { limits: { maxAttempts: 1 } }), task('y')] });
  transition(svc, 'run_2', { taskId: 'x', to: 'running' });
  transition(svc, 'run_2', { taskId: 'x', to: 'failed' });
  const tail = svc.events('run_2').slice(-2).map((e) => [e.to, e.cause]);
  assert.deepEqual(tail, [['failed', 'command'], ['blocked', 'attempts_exhausted']]);
  assert.equal(statusOf(svc, 'run_2', 'x'), 'blocked');
  let e = err(() => transition(svc, 'run_2', { taskId: 'x', to: 'ready' }));
  assert.equal(e.code, 'grant_required'); // a user grant is mandatory, never silent
  transition(svc, 'run_2', { taskId: 'x', to: 'ready', grantAttempts: 1 });
  transition(svc, 'run_2', { taskId: 'x', to: 'running' });
  assert.equal(taskOf(svc, 'run_2', 'x').state.attemptsUsed, 2);
  // unrelated task is untouched by the exhaustion
  assert.equal(statusOf(svc, 'run_2', 'y'), 'ready');
});

// ---- pending approval for plan changes -----------------------------------------

test('decompose with proposed changes parks at approval_pending; inputs immutable', () => {
  const svc = mk();
  const r = decompose(svc, 'run_3', {
    changes: { plan: { versionId: 'plan-v2', sha256: sha('d') }, reason: 'split the plan differently' },
  });
  assert.equal(r.status, 'approval_pending');
  const g = svc.graph('run_3');
  assert.equal(g.status, 'approval_pending');
  assert.equal(g.tasks.length, 0);
  assert.equal(g.pendingApproval.proposalId, 'prop_1');
  assert.equal(g.pendingApproval.kind, 'decompose');
  // the accepted pins are untouched — exactly what was supplied
  assert.equal(g.inputs.plan.sha256, sha('b'));
  assert.equal(g.inputs.baseCommit, COMMIT);
  assert.deepEqual(evTypes(svc, 'run_3'), ['graph_created', 'input_change_proposed']);

  const a = svc.dispatch('run_3', {
    commandId: cid('d'), type: 'decide_input_change',
    payload: { proposalId: 'prop_1', decision: 'approve' },
  });
  assert.equal(a.status, 'active');
  const g2 = svc.graph('run_3'); // snapshots must be re-read after a mutation
  assert.equal(g2.revision, 2);
  assert.equal(g2.inputs.plan.sha256, sha('d'));
  assert.equal(g2.inputs.requirements.sha256, sha('a')); // untouched fields preserved
  assert.equal(g2.tasks.length, 4);
  assert.equal(statusOf(svc, 'run_3', 'a'), 'ready');
  assert.deepEqual(evTypes(svc, 'run_3').slice(0, 4),
    ['graph_created', 'input_change_proposed', 'input_change_approved', 'inputs_changed']);
  assert.equal(svc.events('run_3').filter((e) => e.type === 'task_registered').length, 4);
});

test('rejecting a decompose proposal keeps inputs and allows re-decompose', () => {
  const svc = mk();
  decompose(svc, 'run_4', { changes: { baseCommit: 'f'.repeat(40), reason: 'rebase needed' } });
  const r = svc.dispatch('run_4', {
    commandId: cid('d'), type: 'decide_input_change',
    payload: { proposalId: 'prop_1', decision: 'reject' },
  });
  assert.equal(r.status, 'awaiting_decomposition');
  const g = svc.graph('run_4');
  assert.equal(g.pendingApproval, null);
  assert.equal(g.inputs.baseCommit, COMMIT); // accepted input survived unchanged
  assert.equal(g.tasks.length, 0);
  // a re-decompose with a DIFFERENT pin and no proposal is a hidden change — rejected
  const e = err(() => decompose(svc, 'run_4', { ins: inputs({ baseCommit: 'f'.repeat(40) }) }));
  assert.equal(e.code, 'inputs_changed');
  // the honest re-decompose against the unchanged pins succeeds
  const r2 = decompose(svc, 'run_4');
  assert.equal(r2.status, 'active');
  assert.equal(r2.graphSeq, 2);
});

test('amending inputs on a live graph reverts work under a new revision', () => {
  const svc = mk();
  decompose(svc, 'run_5');
  transition(svc, 'run_5', { taskId: 'a', to: 'running' });
  transition(svc, 'run_5', { taskId: 'a', to: 'accepted', result: { ref: 'a'.repeat(40) } });
  assert.equal(statusOf(svc, 'run_5', 'c'), 'ready');

  const p = svc.dispatch('run_5', {
    commandId: cid('p'), type: 'propose_input_change',
    payload: { requirements: { versionId: 'req-v2', sha256: sha('e') }, reason: 'requirements updated' },
  });
  assert.equal(p.status, 'approval_pending');
  const g = svc.graph('run_5');
  assert.equal(g.inputs.requirements.sha256, sha('a')); // unchanged while pending
  let e = err(() => transition(svc, 'run_5', { taskId: 'c', to: 'running' }));
  assert.equal(e.code, 'graph_not_active'); // frozen while the decision is owed
  e = err(() => svc.dispatch('run_5', {
    commandId: cid('p'), type: 'propose_input_change',
    payload: { baseCommit: 'f'.repeat(40), reason: 'second' },
  }));
  assert.equal(e.code, 'approval_pending'); // one pending approval at a time
  e = err(() => svc.dispatch('run_5', {
    commandId: cid('d'), type: 'decide_input_change',
    payload: { proposalId: 'prop_9', decision: 'approve' },
  }));
  assert.equal(e.code, 'proposal_mismatch');

  const a = svc.dispatch('run_5', {
    commandId: cid('d'), type: 'decide_input_change',
    payload: { proposalId: 'prop_1', decision: 'approve' },
  });
  assert.equal(a.status, 'active');
  const g2 = svc.graph('run_5'); // snapshots must be re-read after a mutation
  assert.equal(g2.revision, 2);
  assert.equal(g2.inputs.requirements.sha256, sha('e'));
  // all live tasks reverted to the new basis; accepted evidence did not carry
  assert.equal(taskOf(svc, 'run_5', 'a').state.acceptedResult, null);
  assert.equal(statusOf(svc, 'run_5', 'a'), 'ready');
  assert.equal(statusOf(svc, 'run_5', 'c'), 'pending');
  assert.equal(statusOf(svc, 'run_5', 'd'), 'pending');
});

test('approval carrying a replacement decomposition swaps the task set', () => {
  const svc = mk();
  decompose(svc, 'run_6');
  svc.dispatch('run_6', {
    commandId: cid('p'), type: 'propose_input_change',
    payload: {
      plan: { versionId: 'plan-v2', sha256: sha('d') },
      reason: 'redecomposed under a new plan',
      subtasks: [task('n1'), task('n2', { dependsOn: ['n1'] })],
    },
  });
  svc.dispatch('run_6', {
    commandId: cid('d'), type: 'decide_input_change',
    payload: { proposalId: 'prop_1', decision: 'approve' },
  });
  const g = svc.graph('run_6');
  assert.equal(g.revision, 2);
  assert.deepEqual(g.order, ['n1', 'n2']);
  assert.equal(statusOf(svc, 'run_6', 'n1'), 'ready');
  assert.equal(statusOf(svc, 'run_6', 'n2'), 'pending');
  assert.equal(g.tasks.length, 2);
});

test('decide without a pending proposal fails closed', () => {
  const svc = mk();
  decompose(svc, 'run_8');
  const e = err(() => svc.dispatch('run_8', {
    commandId: cid('d'), type: 'decide_input_change',
    payload: { proposalId: 'prop_1', decision: 'approve' },
  }));
  assert.equal(e.code, 'no_pending_approval');
});

// ---- idempotency / replay -------------------------------------------------------

test('command replay is idempotent; conflicting reuse is rejected', () => {
  const svc = mk();
  const cmd = {
    commandId: 'k1', type: 'decompose',
    payload: { inputs: inputs(), decomposition: { subtasks: diamond() } },
  };
  const r1 = svc.dispatch('run_9', cmd);
  const r2 = svc.dispatch('run_9', cmd);
  assert.equal(r1.replayed, false);
  assert.deepEqual(r2, { ...r1, replayed: true });
  assert.equal(svc.events('run_9').length, 5); // unchanged by the replay
  assert.equal(svc.graph('run_9').seq, 1);

  // a second, different decompose can never mint graph #2
  let e = err(() => svc.dispatch('run_9', {
    commandId: 'k2', type: 'decompose',
    payload: { inputs: inputs(), decomposition: { subtasks: [task('z')] } },
  }));
  assert.equal(e.code, 'graph_exists');
  // same idempotency key, different payload → conflict
  e = err(() => svc.dispatch('run_9', {
    commandId: 'k1', type: 'decompose',
    payload: { inputs: inputs({ baseCommit: 'f'.repeat(40) }), decomposition: { subtasks: diamond() } },
  }));
  assert.equal(e.code, 'command_conflict');
  assert.equal(e.status, 409);

  // transition replay: identical result, no duplicate events
  transition(svc, 'run_9', { taskId: 'a', to: 'running' }, 't1');
  const n = svc.events('run_9').length;
  const rr = svc.dispatch('run_9', { commandId: 't1', type: 'transition_task', payload: { taskId: 'a', to: 'running' } });
  assert.equal(rr.replayed, true);
  assert.equal(svc.events('run_9').length, n);
});

// ---- determinism ------------------------------------------------------------------

test('identical command streams produce identical event logs', () => {
  const run = () => {
    const svc = mk();
    decompose(svc, 'run_d', { commandId: 'dec' });
    transition(svc, 'run_d', { taskId: 'a', to: 'running' }, 'x1');
    transition(svc, 'run_d', { taskId: 'a', to: 'accepted', result: { ref: 'a'.repeat(40) } }, 'x2');
    return svc.events('run_d');
  };
  assert.deepEqual(run(), run());
});

// ---- stop ----------------------------------------------------------------------------

test('stop cancels live work and forbids new transitions', () => {
  const svc = mk();
  decompose(svc, 'run_7');
  transition(svc, 'run_7', { taskId: 'a', to: 'running' });
  const r = svc.dispatch('run_7', { commandId: 'stop1', type: 'stop', payload: {} });
  assert.equal(r.status, 'stopped');
  assert.equal(r.cancelled, 4);
  const g = svc.graph('run_7');
  assert.equal(statusOf(svc, 'run_7', 'a'), 'cancelled');
  assert.equal(statusOf(svc, 'run_7', 'd'), 'cancelled');
  const e = err(() => transition(svc, 'run_7', { taskId: 'a', to: 'failed' }));
  assert.equal(e.code, 'graph_not_active');
});

// ---- snapshot isolation ------------------------------------------------------
// graph()/events() hand out detached read-only snapshots: editing what a read
// returned can never rewrite the run's graph or its event log.

test('graph() returns a detached frozen snapshot — edits cannot rewrite the run', () => {
  const svc = mk();
  decompose(svc, 'run_iso');
  const snap = svc.graph('run_iso');
  assert.notEqual(snap, svc.graph('run_iso')); // every read is a fresh copy
  const taskA = snap.tasks.find((t) => t.id === 'a');
  assert.throws(() => { snap.status = 'stopped'; }, TypeError);
  assert.throws(() => { taskA.state.status = 'accepted'; }, TypeError);
  assert.throws(() => { taskA.state.attemptsUsed = 9; }, TypeError);
  assert.throws(() => { snap.order.push('ghost'); }, TypeError);
  assert.throws(() => { snap.tasks.push({ id: 'ghost' }); }, TypeError);
  assert.throws(() => { snap.inputs.baseCommit = 'f'.repeat(40); }, TypeError);
  // a fresh read shows the run untouched by the tamper attempt
  const g = svc.graph('run_iso');
  assert.equal(g.status, 'active');
  assert.equal(g.tasks.find((t) => t.id === 'a').state.status, 'ready');
  assert.deepEqual(g.order, ['a', 'c', 'b', 'd']);
  assert.equal(g.inputs.baseCommit, COMMIT);
  // command validation still sees the true state: ready → running is only
  // legal because the forged 'accepted' never reached the graph
  const r = transition(svc, 'run_iso', { taskId: 'a', to: 'running' });
  assert.equal(r.status, 'running');
  assert.equal(statusOf(svc, 'run_iso', 'a'), 'running');
});

test('events() returns detached frozen events — edits cannot rewrite the log', () => {
  const svc = mk();
  decompose(svc, 'run_ev');
  const list = svc.events('run_ev');
  const created = list[0];
  assert.throws(() => { created.type = 'tampered'; }, TypeError);
  assert.throws(() => { created.subtasks.push('ghost'); }, TypeError);
  const regA = list.find((e) => e.type === 'task_registered' && e.taskId === 'a');
  assert.throws(() => { regA.status = 'accepted'; }, TypeError);
  assert.throws(() => { regA.dependsOn.push('ghost'); }, TypeError);
  // the returned list itself is a fresh array — local edits to it are inert
  list.push({ seq: 999, type: 'forged' });
  list.length = 0;
  const again = svc.events('run_ev');
  assert.deepEqual(again.map((e) => e.type),
    ['graph_created', 'task_registered', 'task_registered', 'task_registered', 'task_registered']);
  assert.deepEqual(again[0].subtasks, ['a', 'c', 'b', 'd']);
  assert.equal(again.find((e) => e.taskId === 'a').status, 'ready');
  // the seq filter still applies to the true log
  assert.deepEqual(svc.events('run_ev', 4).map((e) => e.seq), [5]);
});

test('mutating a dispatch result cannot rewrite the recorded replay', () => {
  const svc = mk();
  const cmd = {
    commandId: 'led1', type: 'decompose',
    payload: { inputs: inputs(), decomposition: { subtasks: diamond() } },
  };
  const r1 = svc.dispatch('run_led', cmd);
  r1.status = 'forged';
  r1.subtasks = 999;
  const r2 = svc.dispatch('run_led', cmd);
  assert.equal(r2.replayed, true);
  assert.equal(r2.status, 'active');
  assert.equal(r2.subtasks, 4);
});

test('the terminal-state set is not reachable through module exports', () => {
  assert.ok(!('TASK_TERMINAL' in graphMod), 'TASK_TERMINAL must stay module-private');
  for (const [name, v] of Object.entries(graphMod)) {
    assert.ok(!(v instanceof Set) && !(v instanceof Map),
      `export "${name}" leaks a mutable collection`);
  }
  // the public status tables stay frozen
  for (const name of ['TASK_STATUSES', 'TASK_TRANSITIONS', 'GRAPH_STATUSES']) {
    assert.ok(Object.isFrozen(graphMod[name]), `${name} must be frozen`);
    for (const v of Object.values(graphMod[name])) assert.ok(Object.isFrozen(v));
  }
});

test('the decompose prompt documents the exact server id rule', () => {
  const doc = readFileSync(
    new URL('../prompts/execution/orchestrator/decompose.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(SAFE_ID_RE.source),
    `decompose.md must state the server id rule exactly: ${SAFE_ID_RE}`);
});
