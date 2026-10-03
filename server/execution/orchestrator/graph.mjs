// server/execution/orchestrator/graph.mjs — O1 graph model: accepted-input
// pinning, the deterministic transition/event contract, and pending approval
// for plan changes (O1/R1/R2/R8/KTD1/KTD5).
//
// The graph is a pure in-memory record mutated ONLY through the functions in
// this file; service.mjs serializes commands and owns idempotent replay.
// Every mutation appends to the run-level event log (ctx.events) with a
// monotonically increasing seq — the SAME command stream against the SAME
// clock always produces the SAME event sequence: no wall-clock ordering, no
// random iteration (dependency order is fixed by topoOrder, ties by
// declaration index).
//
// Accepted inputs ({requirements, plan, baseCommit, ...}) are pinned at
// decompose time and DEEP-FROZEN: no command path mutates them. A change
// arrives only as pendingApproval — explicitly decided — which mints a NEW
// frozen inputs object at revision+1. While an approval is pending the graph
// is frozen for work: no task transitions, no second proposal.

import { SAFE_ID_RE } from '../common.mjs';
import { SHA256_RE, canonicalJson } from './canonical.mjs';
import { invalid, conflict } from './errors.mjs';
import {
  isObj, reqStr, assertOnlyKeys, assertNoSecrets, boundedJson,
  validateSubtaskSet,
} from './subtask.mjs';

export const GRAPH_VERSION = 1;
export const COMMIT_RE = /^[0-9a-f]{40}$/;

export const TASK_STATUSES = Object.freeze([
  'pending', 'ready', 'running', 'failed', 'blocked', 'accepted', 'cancelled',
]);
const TASK_TERMINAL = new Set(['accepted', 'cancelled']);

// The complete legal transition edge set — anything absent is an invalid
// transition, with no implicit edges:
//   pending  → ready once every dependsOn is accepted; else deps_unmet
//   ready    → running spends one attempt of maxAttempts+extraAttempts
//   running  → accepted (requires result.ref) | failed | cancelled
//   failed   → ready while attempt budget remains | blocked | cancelled
//   blocked  → ready only with an explicit grantAttempts — a user decision,
//              never silent (R5)
//   accepted / cancelled — terminal (result invalidation is O2's concern)
export const TASK_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['ready', 'cancelled']),
  ready: Object.freeze(['running', 'cancelled']),
  running: Object.freeze(['accepted', 'failed', 'cancelled']),
  failed: Object.freeze(['ready', 'blocked', 'cancelled']),
  blocked: Object.freeze(['ready', 'cancelled']),
  accepted: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const GRAPH_STATUSES = Object.freeze([
  'awaiting_decomposition', 'active', 'approval_pending', 'complete', 'stopped',
]);

export function deepFreeze(v) {
  if (Array.isArray(v)) {
    v.forEach(deepFreeze);
    return Object.freeze(v);
  }
  if (isObj(v)) {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    return Object.freeze(v);
  }
  return v;
}

export function emit(ctx, type, data, now) {
  const ev = { seq: ++ctx.eventsCursor, type, at: now(), ...data };
  ctx.events.push(ev);
  return ev;
}

function setGraphStatus(ctx, graph, to, cause, now) {
  if (graph.status === to) return;
  const from = graph.status;
  graph.status = to;
  emit(ctx, 'graph_status', { from, to, cause }, now);
}

function setTaskStatus(ctx, task, to, cause, now, commandId) {
  const from = task.state.status;
  task.state.status = to;
  emit(ctx, 'task_status', { taskId: task.id, from, to, cause, commandId }, now);
}

const taskById = (graph, id) => graph.tasks.find((t) => t.id === id);

function depsAccepted(graph, task) {
  return task.dependsOn.every((d) => taskById(graph, d)?.state.status === 'accepted');
}

// Deterministic promotion: walk the fixed topo order; any pending task whose
// dependencies are ALL accepted becomes ready.
function promoteReady(ctx, graph, cause, now, commandId) {
  for (const id of graph.order) {
    const t = taskById(graph, id);
    if (t.state.status === 'pending' && depsAccepted(graph, t)) {
      setTaskStatus(ctx, t, 'ready', cause, now, commandId);
    }
  }
}

function syncGraphStatus(ctx, graph, now) {
  if (graph.status !== 'active') return;
  if (graph.tasks.length && graph.tasks.every((t) => t.state.status === 'accepted')) {
    setGraphStatus(ctx, graph, 'complete', 'all_accepted', now);
  }
}

// ---- accepted inputs ---------------------------------------------------------

const DOC_KEYS = new Set(['versionId', 'sha256', 'requirementsVersionId', 'checks']);
const INPUT_KEYS = new Set(['requirements', 'plan', 'design', 'baseCommit', 'composition', 'limits']);
const CHANGE_KEYS = new Set(['requirements', 'plan', 'design', 'baseCommit', 'reason']);
const RUN_LIMIT_KEYS = new Set(['maxParallel', 'attemptsPerRole', 'maxFixCycles']);

function docVersion(raw, what) {
  if (!isObj(raw)) throw invalid('inputs_invalid', `${what} must be an object`);
  assertOnlyKeys(raw, DOC_KEYS, what);
  const out = {
    versionId: reqStr(raw.versionId, `${what}.versionId`, 160),
    sha256: raw.sha256,
  };
  if (typeof out.sha256 !== 'string' || !SHA256_RE.test(out.sha256)) {
    throw invalid('inputs_invalid', `${what}.sha256 must be a sha256 hex`);
  }
  if (raw.requirementsVersionId !== undefined) {
    out.requirementsVersionId = reqStr(raw.requirementsVersionId, `${what}.requirementsVersionId`, 160);
  }
  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks)) {
      throw invalid('inputs_invalid', `${what}.checks must be an array`);
    }
    out.checks = raw.checks.map((c, i) => reqStr(c, `${what}.checks[${i}]`, 300));
  }
  return out;
}

function runLimits(raw) {
  if (!isObj(raw)) throw invalid('inputs_invalid', 'inputs.limits must be an object');
  assertOnlyKeys(raw, RUN_LIMIT_KEYS, 'inputs.limits');
  const out = {};
  for (const [k, lo, hi] of [['maxParallel', 1, 16], ['attemptsPerRole', 1, 10], ['maxFixCycles', 0, 10]]) {
    if (raw[k] !== undefined) {
      if (!Number.isInteger(raw[k]) || raw[k] < lo || raw[k] > hi) {
        throw invalid('inputs_invalid', `inputs.limits.${k} must be an integer in [${lo},${hi}]`);
      }
      out[k] = raw[k];
    }
  }
  return out;
}

export function validateInputs(raw) {
  if (!isObj(raw)) throw invalid('inputs_invalid', 'inputs must be an object');
  assertNoSecrets(raw, 'inputs');
  assertOnlyKeys(raw, INPUT_KEYS, 'inputs');
  const out = {
    requirements: docVersion(raw.requirements, 'inputs.requirements'),
    plan: docVersion(raw.plan, 'inputs.plan'),
    baseCommit: raw.baseCommit,
  };
  if (typeof out.baseCommit !== 'string' || !COMMIT_RE.test(out.baseCommit)) {
    throw invalid('inputs_invalid', 'inputs.baseCommit must be a 40-hex commit sha');
  }
  if (raw.design !== undefined && raw.design !== null) {
    out.design = docVersion(raw.design, 'inputs.design');
  }
  if (raw.composition !== undefined) {
    out.composition = boundedJson(raw.composition, 'inputs.composition');
  }
  if (raw.limits !== undefined) out.limits = runLimits(raw.limits);
  return deepFreeze(out);
}

// A change set: at least one pinned field, each DIFFERENT from the accepted
// value (no-op "changes" are a smell — rejected), plus a mandatory reason.
export function validateInputChanges(raw, current) {
  if (!isObj(raw)) throw invalid('change_invalid', 'proposedInputChanges must be an object');
  assertNoSecrets(raw, 'proposedInputChanges');
  assertOnlyKeys(raw, CHANGE_KEYS, 'proposedInputChanges');
  const reason = reqStr(raw.reason, 'proposedInputChanges.reason', 1000);
  const changes = {};
  for (const kind of ['requirements', 'plan', 'design']) {
    if (raw[kind] !== undefined) changes[kind] = docVersion(raw[kind], `proposedInputChanges.${kind}`);
  }
  if (raw.baseCommit !== undefined) {
    if (typeof raw.baseCommit !== 'string' || !COMMIT_RE.test(raw.baseCommit)) {
      throw invalid('change_invalid', 'proposedInputChanges.baseCommit must be a 40-hex commit sha');
    }
    changes.baseCommit = raw.baseCommit;
  }
  const fields = Object.keys(changes).sort();
  if (!fields.length) {
    throw invalid('change_invalid', 'proposedInputChanges must change at least one pinned input');
  }
  for (const f of fields) {
    if (canonicalJson(changes[f]) === canonicalJson(current[f] ?? null)) {
      throw invalid('change_noop', `proposedInputChanges.${f} is identical to the accepted input`);
    }
  }
  return { changes: deepFreeze(changes), fields, reason };
}

// ---- graph construction --------------------------------------------------------

function newGraph(ctx, runId, { inputs, status, pendingApproval = null, revision = 1 }) {
  const graph = {
    version: GRAPH_VERSION,
    seq: ++ctx.graphSeq,
    runId,
    revision,
    status,
    inputs,
    pendingApproval,
    tasks: Object.freeze([]),
    order: Object.freeze([]),
    createdSeq: ctx.eventsCursor + 1,
  };
  ctx.graph = graph;
  return graph;
}

// Registers a validated set wholesale: contract fields deep-frozen, mutable
// runtime state kept under the unfrozen `state` slot, registration events in
// deterministic topo order. Dep-free tasks start 'ready', the rest 'pending'.
function registerTasks(ctx, graph, set, now) {
  const tasks = set.tasks.map((t) => {
    const rec = {
      id: t.id,
      title: t.title,
      outcome: t.outcome,
      acceptanceCriteria: t.acceptanceCriteria,
      dependsOn: t.dependsOn,
      boundary: t.boundary,
      worker: t.worker,
      limits: t.limits,
      state: {
        status: t.dependsOn.length ? 'pending' : 'ready',
        attemptsUsed: 0,
        extraAttempts: 0,
        acceptedResult: null,
        lastError: null,
      },
    };
    for (const k of Object.keys(rec)) if (k !== 'state') deepFreeze(rec[k]);
    return Object.freeze(rec);
  });
  graph.tasks = Object.freeze(tasks);
  graph.order = Object.freeze([...set.order]);
  for (const id of set.order) {
    const t = taskById(graph, id);
    emit(ctx, 'task_registered',
      { taskId: id, status: t.state.status, dependsOn: [...t.dependsOn] }, now);
  }
}

// ---- commands (called by service.mjs inside the serialized dispatch) ----------

const DECOMPOSE_KEYS = new Set(['inputs', 'decomposition', 'proposedInputChanges']);
const PROPOSE_KEYS = new Set(['requirements', 'plan', 'design', 'baseCommit', 'reason', 'subtasks']);
const DECIDE_KEYS = new Set(['proposalId', 'decision']);
const TRANSITION_KEYS = new Set(['taskId', 'to', 'reason', 'result', 'grantAttempts']);

// decompose binds the accepted pins and registers the validated subtasks.
// Ordinary decomposition NEVER raises a question — KD1 is user-directed and
// automatic. Only an explicit proposedInputChanges parks the new graph at
// approval_pending, and even then the accepted inputs supplied are frozen
// untouched until a decision lands.
export function decompose(ctx, runId, payload, now) {
  if (!isObj(payload)) throw invalid('malformed', 'decompose payload must be an object');
  assertNoSecrets(payload, 'decompose');
  assertOnlyKeys(payload, DECOMPOSE_KEYS, 'decompose');
  const inputs = validateInputs(payload.inputs);
  const dec = payload.decomposition;
  if (!isObj(dec)) throw invalid('malformed', 'decompose.decomposition must be an object');
  assertOnlyKeys(dec, new Set(['subtasks']), 'decompose.decomposition');
  const set = validateSubtaskSet(dec.subtasks);

  const existing = ctx.graph;
  if (existing && existing.status !== 'awaiting_decomposition') {
    throw conflict('graph_exists',
      `run ${runId} already has decomposition graph seq ${existing.seq} (${existing.status})`);
  }
  if (existing && canonicalJson(existing.inputs) !== canonicalJson(inputs)) {
    // A re-decompose re-pins the SAME accepted inputs. A different pin is a
    // plan change and must go through proposedInputChanges — never silent.
    throw conflict('inputs_changed',
      're-decompose must bind the accepted pins unchanged — use proposedInputChanges');
  }
  const revision = existing?.revision ?? 1;

  const change = payload.proposedInputChanges !== undefined
    ? validateInputChanges(payload.proposedInputChanges, inputs)
    : null;
  if (change) {
    const proposal = deepFreeze({
      proposalId: `prop_${++ctx.proposalSeq}`,
      kind: 'decompose',
      changes: change.changes,
      fields: change.fields,
      reason: change.reason,
      subtasks: set,
    });
    const g = newGraph(ctx, runId, { inputs, status: 'approval_pending', pendingApproval: proposal, revision });
    emit(ctx, 'graph_created',
      { graphSeq: g.seq, status: g.status, revision: g.revision, subtasks: [] }, now);
    emit(ctx, 'input_change_proposed',
      { proposalId: proposal.proposalId, kind: proposal.kind, fields: [...proposal.fields], reason: proposal.reason }, now);
    return { status: 'approval_pending', graphSeq: g.seq, revision: g.revision, proposalId: proposal.proposalId, subtasks: 0 };
  }

  const g = newGraph(ctx, runId, { inputs, status: 'active', revision });
  emit(ctx, 'graph_created',
    { graphSeq: g.seq, status: g.status, revision: g.revision, subtasks: [...set.order] }, now);
  registerTasks(ctx, g, set, now);
  return { status: 'active', graphSeq: g.seq, revision: g.revision, subtasks: set.order.length };
}

// propose_input_change amends a LIVE graph's accepted inputs. The proposal
// parks durably; the accepted pins are NOT touched until approve lands.
// Optionally carries a replacement decomposition bound to the new basis.
export function proposeInputChange(ctx, graph, payload, now) {
  if (!graph) throw conflict('graph_missing', 'no decomposition graph exists');
  if (!isObj(payload)) throw invalid('malformed', 'propose_input_change payload must be an object');
  assertNoSecrets(payload, 'propose_input_change');
  assertOnlyKeys(payload, PROPOSE_KEYS, 'propose_input_change');
  if (graph.status === 'approval_pending') {
    throw conflict('approval_pending',
      `graph already waits on ${graph.pendingApproval?.proposalId}`);
  }
  if (graph.status !== 'active' && graph.status !== 'complete') {
    throw conflict('graph_not_active', `graph is ${graph.status} — no input changes`);
  }
  // validateInputChanges sees only the change document — the payload may
  // also carry a replacement `subtasks` set bound to the new basis.
  const changeDoc = {};
  for (const k of CHANGE_KEYS) if (payload[k] !== undefined) changeDoc[k] = payload[k];
  const change = validateInputChanges(changeDoc, graph.inputs);
  const subtasks = payload.subtasks !== undefined
    ? validateSubtaskSet(payload.subtasks)
    : null;
  const proposal = deepFreeze({
    proposalId: `prop_${++ctx.proposalSeq}`,
    kind: 'amend',
    changes: change.changes,
    fields: change.fields,
    reason: change.reason,
    subtasks,
  });
  graph.pendingApproval = proposal;
  emit(ctx, 'input_change_proposed',
    { proposalId: proposal.proposalId, kind: proposal.kind, fields: [...proposal.fields], reason: proposal.reason }, now);
  setGraphStatus(ctx, graph, 'approval_pending', 'input_change_proposed', now);
  return { status: 'approval_pending', proposalId: proposal.proposalId, revision: graph.revision };
}

// decide_input_change resolves the durable pendingApproval. approve mints a
// NEW frozen inputs object at revision+1 — the old pins were never mutated —
// then either registers the proposal's decomposition or deterministically
// reverts every live task to the new basis (accepted evidence never carries
// across an input change). reject drops the proposal; a decompose-time
// proposal leaves the graph awaiting_decomposition, an amend returns active.
export function decideInputChange(ctx, graph, payload, now, commandId) {
  if (!graph) throw conflict('graph_missing', 'no decomposition graph exists');
  if (!isObj(payload)) throw invalid('malformed', 'decide_input_change payload must be an object');
  assertNoSecrets(payload, 'decide_input_change');
  assertOnlyKeys(payload, DECIDE_KEYS, 'decide_input_change');
  const p = graph.pendingApproval;
  if (!p) throw conflict('no_pending_approval', 'the graph has no pending input change');
  if (payload.proposalId !== p.proposalId) {
    throw conflict('proposal_mismatch', `the pending proposal is ${p.proposalId}`);
  }
  if (payload.decision !== 'approve' && payload.decision !== 'reject') {
    throw invalid('decision_invalid', 'decision must be approve|reject');
  }

  if (payload.decision === 'reject') {
    graph.pendingApproval = null;
    emit(ctx, 'input_change_rejected', { proposalId: p.proposalId }, now);
    setGraphStatus(ctx, graph,
      p.kind === 'decompose' ? 'awaiting_decomposition' : 'active',
      'input_change_rejected', now);
    return { status: graph.status, decision: 'reject', revision: graph.revision };
  }

  graph.inputs = validateInputs({ ...graph.inputs, ...p.changes });
  graph.revision += 1;
  graph.pendingApproval = null;
  emit(ctx, 'input_change_approved', { proposalId: p.proposalId, revision: graph.revision }, now);
  emit(ctx, 'inputs_changed', { revision: graph.revision, fields: [...p.fields] }, now);
  if (p.subtasks) {
    registerTasks(ctx, graph, p.subtasks, now);
  } else {
    for (const id of graph.order) {
      const t = taskById(graph, id);
      if (t.state.status === 'cancelled') continue;
      if (t.state.status !== 'pending') {
        setTaskStatus(ctx, t, 'pending', 'inputs_changed', now, commandId);
      }
      t.state.attemptsUsed = 0;
      t.state.extraAttempts = 0;
      t.state.acceptedResult = null;
      t.state.lastError = null;
    }
    promoteReady(ctx, graph, 'dependency_met', now, commandId);
  }
  setGraphStatus(ctx, graph, 'active', 'input_change_approved', now);
  return { status: 'active', decision: 'approve', revision: graph.revision, graphSeq: graph.seq };
}

// transition_task is the only edge driver. Legality is table-checked first,
// then the edge's guard (deps / budget / result / grant) — every refusal is
// a conflict, never a silent clamp.
export function transitionTask(ctx, graph, payload, now, commandId) {
  if (!graph) throw conflict('graph_missing', 'no decomposition graph exists');
  if (!isObj(payload)) throw invalid('malformed', 'transition_task payload must be an object');
  assertNoSecrets(payload, 'transition_task');
  assertOnlyKeys(payload, TRANSITION_KEYS, 'transition_task');
  const { taskId, to } = payload;
  if (typeof taskId !== 'string' || !SAFE_ID_RE.test(taskId)) {
    throw invalid('task_unknown', `unknown subtask ${JSON.stringify(taskId)}`);
  }
  if (!TASK_STATUSES.includes(to)) {
    throw invalid('invalid_transition', `unknown target status ${JSON.stringify(to)}`);
  }
  if (graph.status !== 'active') {
    throw conflict('graph_not_active', `graph is ${graph.status} — no task transitions`);
  }
  const task = taskById(graph, taskId);
  if (!task) throw invalid('task_unknown', `unknown subtask "${taskId}"`, { taskId });
  const from = task.state.status;
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw conflict('invalid_transition',
      `${taskId}: ${from} → ${to} is not a legal transition`, { taskId, from, to });
  }
  if (payload.reason !== undefined && payload.reason !== null) {
    reqStr(payload.reason, 'transition_task.reason', 500);
  }
  const budget = () => task.limits.maxAttempts + task.state.extraAttempts;

  if (to === 'ready') {
    if (!depsAccepted(graph, task)) {
      throw conflict('deps_unmet', `${taskId} has unmet dependencies`, { taskId });
    }
    if (from === 'blocked') {
      const grant = payload.grantAttempts;
      if (!Number.isInteger(grant) || grant < 1 || grant > 10) {
        throw conflict('grant_required',
          `${taskId} is blocked — re-arming requires grantAttempts (integer 1..10)`, { taskId });
      }
      task.state.extraAttempts += grant;
    } else if (task.state.attemptsUsed >= budget()) {
      throw conflict('attempts_exhausted', `${taskId} exhausted its attempt budget`, { taskId });
    }
  }
  if (to === 'running') {
    if (task.state.attemptsUsed >= budget()) {
      throw conflict('attempts_exhausted', `${taskId} exhausted its attempt budget`, { taskId });
    }
    task.state.attemptsUsed += 1;
  }
  if (to === 'accepted') {
    const res = payload.result;
    if (!isObj(res) || typeof res.ref !== 'string' || !res.ref.trim() || res.ref.trim().length > 300) {
      throw invalid('result_required',
        'accepting a subtask requires result.ref (commit/artifact ref, ≤300 chars)');
    }
    task.state.acceptedResult = deepFreeze({
      ref: res.ref.trim(),
      note: typeof res.note === 'string' ? res.note.slice(0, 500) : null,
    });
  }
  if (to === 'failed') {
    task.state.lastError = {
      reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 500) : null,
      commandId,
    };
  }
  setTaskStatus(ctx, task, to, 'command', now, commandId);
  // Attempt exhaustion never silently waits: failed → blocked is automatic
  // and durable; only an explicit grant re-arms (R5).
  if (to === 'failed' && task.state.attemptsUsed >= budget()) {
    setTaskStatus(ctx, task, 'blocked', 'attempts_exhausted', now, commandId);
  }
  if (to === 'accepted') promoteReady(ctx, graph, 'dependency_met', now, commandId);
  syncGraphStatus(ctx, graph, now);
  return { taskId, to, status: task.state.status, graphStatus: graph.status };
}

// stop cancels every non-terminal task in topo order and parks the graph —
// no further transitions, no second graph (R8). Accepted results survive.
export function stopGraph(ctx, graph, now, commandId) {
  if (!graph) throw conflict('graph_missing', 'no decomposition graph exists');
  if (graph.status === 'stopped') return { status: 'stopped', cancelled: 0 };
  let cancelled = 0;
  for (const id of graph.order) {
    const t = taskById(graph, id);
    if (!TASK_TERMINAL.has(t.state.status)) {
      setTaskStatus(ctx, t, 'cancelled', 'stop', now, commandId);
      cancelled += 1;
    }
  }
  if (graph.pendingApproval) {
    const p = graph.pendingApproval;
    graph.pendingApproval = null;
    emit(ctx, 'input_change_rejected', { proposalId: p.proposalId, cause: 'stop' }, now);
  }
  setGraphStatus(ctx, graph, 'stopped', 'stop', now);
  return { status: 'stopped', cancelled };
}
