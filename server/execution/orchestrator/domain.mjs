// server/execution/orchestrator/domain.mjs — O-unit durable orchestrator
// domain logic.
//
// These handlers run INSIDE execution-domain's serialized command queue.
// They never import the domain module (no cycle): the domain assembles a
// deps bag `D` (CommandError, regexes, attempt/owner helpers, storage ctx)
// and calls these functions with it — the same seam style as fusion.
//
//   user channel:     orch_approve, orch_decide, orch_grant, orch_retry,
//                     orch_answer
//   internal channel: orch_claim, orch_decompose_begin, orch_task_begin,
//                     orch_task_settle, orch_integrate_begin,
//                     orch_integrate_record, orch_annul
//   hooks:            buildOrchestratorRun (start), checkDecompositionSpec /
//                     onDecomposerResolved / checkTaskVerdict /
//                     onVerifierResolved (resolve_attempt), orchOnStop (stop)
//
// Invariants enforced here:
//   * an attempt is DURABLE before any runtime call;
//   * every launch is bound to the recorded profileDigest — a different
//     effective profile can never mint an attempt;
//   * accepted task results are immutable hash-bound records — a late or
//     foreign settle can never rewrite them;
//   * task/graph transitions derive from the durable record only — caller
//     claims (status/outcome) are never trusted.

import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../common.mjs';
import { sha256 } from '../execution-store.mjs';
import {
  validateAgentProfile, profileDigest, canonicalJson,
} from '../environment/agent-profile.mjs';
import {
  isObj, assertNoSecrets, boundedJson,
  validateSubtaskSet,
} from './subtask.mjs';
import {
  validateInputs, validateInputChanges, deepFreeze,
} from './graph.mjs';

export const ORCH_COMMANDS = [
  'orch_approve', 'orch_decide', 'orch_grant', 'orch_retry', 'orch_answer',
];
export const ORCH_INTERNAL_COMMANDS = [
  'orch_claim', 'orch_decompose_begin',
  'orch_task_begin', 'orch_task_settle',
  'orch_integrate_begin', 'orch_integrate_record', 'orch_annul',
  'orch_worker_settled',
];
// Attempt roles minted by this module. They are NOT in EXEC_ROLES (the solo
// begin_attempt path) and must never move run.phase/run.status on generic
// bind/resolve — the orch commands own every run transition.
export const ORCH_ATTEMPT_ROLES = new Set([
  'decomposer', 'worker', 'verifier', 'assembler',
]);

const ORCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const TASK_LIVE = new Set(['pending', 'ready', 'running', 'verifying', 'returned', 'waiting']);

// ---- spec/payload validation ---------------------------------------------------

function wrapErr(D, e) {
  if (e instanceof RuntimeError || (e && e.status === 422)) {
    return new D.CommandError(422, e.code || 'invalid_argument', e.message, e.details ?? e.extra ?? {});
  }
  if (e && e.status === 409) {
    return new D.CommandError(409, e.code || 'conflict', e.message, e.details ?? e.extra ?? {});
  }
  return e;
}

function validateProfileEntry(D, raw, what) {
  if (!isObj(raw)) {
    throw new D.CommandError(422, 'orchestrator_invalid', `orchestrator.${what} must be an object {profile}`);
  }
  let profile;
  try {
    profile = validateAgentProfile(raw.profile);
  } catch (e) {
    throw new D.CommandError(422, 'orchestrator_invalid',
      `orchestrator.${what}: invalid profile — ${e.message}`);
  }
  return {
    profileId: profile.profileId,
    provider: profile.provider,
    model: profile.model,
    profileDigest: profileDigest(profile),
    profile,
  };
}

function validateOrchestratorSpec(D, raw) {
  if (!isObj(raw)) {
    throw new D.CommandError(422, 'orchestrator_invalid',
      'payload.orchestrator {decomposer,verifier,integrator,workers,limits?} is required for mode orchestrator');
  }
  const out = {
    decomposer: validateProfileEntry(D, raw.decomposer, 'decomposer'),
    verifier: validateProfileEntry(D, raw.verifier, 'verifier'),
    integrator: validateProfileEntry(D, raw.integrator, 'integrator'),
  };
  if (!isObj(raw.workers) || !Object.keys(raw.workers).length) {
    throw new D.CommandError(422, 'orchestrator_invalid',
      'orchestrator.workers must be a non-empty object {name: {profile}}');
  }
  const names = Object.keys(raw.workers);
  if (names.length > 8) {
    throw new D.CommandError(422, 'orchestrator_invalid',
      `orchestrator.workers exceeds 8 entries (${names.length})`);
  }
  out.workers = {};
  for (const name of names) {
    if (!ORCH_ID_RE.test(name)) {
      throw new D.CommandError(422, 'orchestrator_invalid',
        `orchestrator.workers key ${JSON.stringify(name)} must match ${ORCH_ID_RE}`);
    }
    out.workers[name] = validateProfileEntry(D, raw.workers[name], `workers.${name}`);
  }
  const lim = isObj(raw.limits) ? raw.limits : {};
  const intIn = (k, lo, hi, dflt) => {
    const v = lim[k];
    if (v === undefined) return dflt;
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new D.CommandError(422, 'orchestrator_invalid',
        `orchestrator.limits.${k} must be an integer in [${lo},${hi}]`);
    }
    return v;
  };
  out.limits = {
    maxSubtasks: intIn('maxSubtasks', 1, 200, 32),
    requireSpecApproval: lim.requireSpecApproval !== false,
    decomposerAttempts: intIn('decomposerAttempts', 1, 5, 2),
    maxIntegratorAttempts: intIn('maxIntegratorAttempts', 1, 5, 2),
    taskAttempts: intIn('taskAttempts', 1, 10, 3),
    verifyAttempts: intIn('verifyAttempts', 1, 5, 2),
    timeoutMin: intIn('timeoutMin', 5, 240, 45),
  };
  return out;
}

// ---- run construction ----------------------------------------------------------

export async function buildOrchestratorRun(D, ctx, aggregate, payload, now) {
  const { reqA, planA } = await D.requireApprovedInputs(ctx, aggregate, 'start');
  const spec = validateOrchestratorSpec(D, payload.orchestrator);
  const baseRef =
    typeof payload?.baseRef === 'string' && payload.baseRef.trim()
      ? payload.baseRef.trim() : 'HEAD';
  let baseCommit;
  try {
    baseCommit = await D.resolveBaseCommit(aggregate.projectPath, baseRef);
  } catch (e) {
    if (e instanceof RuntimeError
      && (e.code === 'git_unavailable' || e.code === 'git_ownership')) {
      throw new D.CommandError(503, e.code, e.message);
    }
    throw new D.CommandError(422, 'base_ref_invalid',
      e instanceof RuntimeError ? e.message : String(e));
  }
  const workspaceId = payload?.freshWorkspace ? null : D.retainableWorkspaceId(aggregate);
  const inputs = D.runInputsSnapshot(aggregate, reqA, planA);
  const run = {
    id: `run_${randomUUID()}`,
    mode: 'orchestrator',
    status: 'queued',
    phase: 'decompose',
    createdAt: now,
    inputs,
    composition: structuredClone(aggregate.composition),
    reviewRules: D.snapshotReviewRules(
      await ctx.getDoc('roles.json'), aggregate.composition?.preset?.limits),
    baseRef,
    baseCommit,
    workspaceId,
    attempts: [],
    result: null,
    events: [],
    eventsCursor: 0,
    orchestrator: {
      // The composition is FULL validated profiles — a launch binds the
      // recorded digest; a different effective profile can never mint.
      decomposer: spec.decomposer,
      verifier: spec.verifier,
      integrator: spec.integrator,
      workers: spec.workers,
      limits: spec.limits,
      // projectRoot: the registered projects-root name every runtime
      // launch resolves; sourcePath: the host path every storage call
      // (snapshots/freezes/diffs) reads and writes.
      project: {
        projectRoot: D.projectKeyFor(aggregate.projectPath),
        sourcePath: aggregate.projectPath,
      },
      owner: null,
      // The decomposition graph — a durable projection of the O1 contract.
      graph: {
        version: 1,
        status: 'awaiting_decomposition',
        inputs: deepFreeze({
          requirements: {
            versionId: inputs.requirements.versionId, sha256: inputs.requirements.sha256,
          },
          plan: {
            versionId: inputs.plan.versionId, sha256: inputs.plan.sha256,
            requirementsVersionId: inputs.plan.requirementsVersionId,
            checks: inputs.plan.checks || [],
          },
          ...(inputs.design ? { design: inputs.design } : {}),
          baseCommit,
        }),
        pendingApproval: null,
        revision: 1,
      },
      spec: null,          // {version,sha256,artifactId,status,proposedAt,approvedAt,by,subtasks}
      specHistory: [],
      tasks: [],           // task records (see registerTasks)
      order: [],           // deterministic topo order
      pendingActions: [],
      integrate: null,     // {canonicalId, attemptId, import}
      decomposeUsed: 0,
      proposalSeq: 0,
      stats: { tasks: 0, accepted: 0, running: 0, failed: 0 },
    },
  };
  return run;
}

// ---- shared helpers --------------------------------------------------------------

export function orchestratorRun(D, aggregate, payload) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'orchestrator' || !run.orchestrator) {
    throw new D.CommandError(409, 'not_orchestrator', `run ${run.id} is not an orchestrator run`);
  }
  return run;
}

export const taskById = (oz, taskId) =>
  (oz.tasks || []).find((t) => t && t.id === taskId) ?? null;

export function orchAttempts(run, taskId, kind = null) {
  return (run.attempts || []).filter(
    (a) => a && a.taskId === taskId && (kind === null || a.kind === kind));
}

// ONE durable run event — same shape as every other run event ({seq,at,type,data}).
function emit(ctx, run, type, data, now) {
  run.events = Array.isArray(run.events) ? run.events : [];
  const ev = { seq: run.eventsCursor ?? 0, at: now, type, data };
  run.eventsCursor = (run.eventsCursor ?? 0) + 1;
  run.events.push(ev);
  if (typeof ctx.appendRunEvent === 'function') ctx.appendRunEvent(run.id, run.events);
  return ev;
}

function setTaskStatus(ctx, run, task, to, cause, now) {
  if (task.state.status === to) return;
  const from = task.state.status;
  task.state.status = to;
  emit(ctx, run, 'task_status', { taskId: task.id, from, to, cause }, now);
}

function setGraphStatus(ctx, run, to, cause, now) {
  const g = run.orchestrator.graph;
  if (g.status === to) return;
  const from = g.status;
  g.status = to;
  emit(ctx, run, 'graph_status', { from, to, cause }, now);
}

function syncStats(run) {
  const oz = run.orchestrator;
  const s = { tasks: oz.tasks.length, accepted: 0, running: 0, failed: 0 };
  for (const t of oz.tasks) {
    if (t.state.status === 'accepted') s.accepted += 1;
    if (['running', 'verifying'].includes(t.state.status)) s.running += 1;
    if (['failed', 'blocked'].includes(t.state.status)) s.failed += 1;
  }
  oz.stats = s;
}

// Rebuild the user-action list from the durable record — never additive,
// a restart or replay always derives the same list.
export function syncOrchPendingActions(run) {
  const oz = run.orchestrator;
  const keep = (oz.pendingActions || [])
    .filter((a) => a && a.type && !['spec_approval', 'question', 'grant', 'decision'].includes(a.type));
  const out = [...keep];
  if (oz.spec && oz.spec.status === 'pending') {
    out.push({ type: 'spec_approval', specSha256: oz.spec.sha256, version: oz.spec.version });
  }
  if (oz.graph?.pendingApproval) {
    const p = oz.graph.pendingApproval;
    out.push({ type: 'decision', proposalId: p.proposalId, kind: p.kind, fields: [...(p.fields || [])] });
  }
  for (const t of oz.tasks || []) {
    const w = t.state?.waiting;
    if (!w) continue;
    if (w.reason === 'question') {
      out.push({ type: 'question', taskId: t.id, question: w.question ?? null });
    } else if (w.reason === 'grant' || t.state.status === 'blocked') {
      out.push({ type: 'grant', taskId: t.id, reason: 'attempts_exhausted' });
    } else {
      out.push({ type: 'decision', taskId: t.id, reason: w.reason });
    }
  }
  for (const t of oz.tasks || []) {
    if (t.state?.status === 'blocked' && !t.state.waiting) {
      out.push({ type: 'grant', taskId: t.id, reason: 'attempts_exhausted' });
    }
  }
  oz.pendingActions = out;
}

const depsAccepted = (oz, task) =>
  task.dependsOn.every((d) => taskById(oz, d)?.state.status === 'accepted');

// Deterministic promotion: pending → ready once every dep is accepted.
// Walks the fixed topo order only — the same record always yields the
// same promotions.
export function promoteReady(ctx, run, cause, now) {
  const oz = run.orchestrator;
  if (oz.graph.status !== 'active') return;
  for (const id of oz.order) {
    const t = taskById(oz, id);
    if (t && t.state.status === 'pending' && depsAccepted(oz, t)) {
      setTaskStatus(ctx, run, t, 'ready', cause, now);
    }
  }
}

// Task budget — spec limits + explicit user grants.
const taskAttemptBudget = (task) =>
  task.limits.maxAttempts + (task.state.extraAttempts ?? 0);
const taskFixBudget = (task) => task.limits.maxFixCycles + (task.state.extraFixes ?? 0);

// Register a validated subtask set as durable task records. Contract fields
// are deep-frozen; mutable execution state lives under `state`.
export function registerTasks(ctx, run, set, now) {
  const oz = run.orchestrator;
  oz.tasks = set.tasks.map((t) => {
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
        status: 'pending',
        attemptsUsed: 0,
        fixesUsed: 0,
        verifyUsed: 0,
        extraAttempts: 0,
        extraFixes: 0,
        attempts: [],
        inputCommit: null,
        snapshotOf: [],
        resultCommit: null,
        resultSha256: null,
        patchSha256: null,
        diffArtifactId: null,
        canonicalId: null,
        canonicalCommit: null,
        evidence: null,
        waiting: null,
        lastError: null,
      },
    };
    for (const k of Object.keys(rec)) if (k !== 'state') deepFreeze(rec[k]);
    return rec;
  });
  oz.order = [...set.order];
  for (const id of oz.order) {
    const t = taskById(oz, id);
    emit(ctx, run, 'task_registered',
      { taskId: id, status: t.state.status, dependsOn: [...t.dependsOn] }, now);
    if (!t.dependsOn.length) setTaskStatus(ctx, run, t, 'ready', 'dependency_met', now);
  }
  syncStats(run);
}

// ---- internal commands -------------------------------------------------------------

// orch_claim — the run-level execution authority. Exactly one scheduler
// instance may drive orchestration; a foreign instance adopts only with
// positive proof of the recorded owner's death.
export async function cmdOrchClaim(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  if (!D.RUN_NONTERMINAL.has(run.status)) {
    throw new D.CommandError(409, 'run_terminal', `run ${run.id} is ${run.status} — nothing to claim`);
  }
  const oz = run.orchestrator;
  const leaseMs = D.clampLeaseMs(payload.leaseMs);
  if (!oz.owner) {
    oz.owner = D.newOwner(payload, now, leaseMs);
    emit(ctx, run, 'orch_claimed', { runnerId: payload.runnerId, instanceId: payload.instanceId }, now);
    D.stageRun(aggregate, run, ctx);
    return { aggregate, result: { runId: run.id, claimed: true } };
  }
  if (D.ownsResource(oz.owner, payload)) {
    oz.owner.leaseUntil = now + leaseMs;
    D.stageRun(aggregate, run, ctx);
    return { aggregate, result: { runId: run.id, claimed: true, renewed: true } };
  }
  D.checkAdoptionProof(oz, payload,
    ctx.loadEnvironments ? await ctx.loadEnvironments() : null);
  const prev = { runnerId: oz.owner.runnerId, instanceId: oz.owner.instanceId };
  oz.owner = D.newOwner(payload, now, leaseMs, oz.owner);
  emit(ctx, run, 'orch_adopted', { from: prev, runnerId: payload.runnerId, instanceId: payload.instanceId }, now);
  D.stageRun(aggregate, run, ctx);
  return { aggregate, result: { runId: run.id, claimed: true, adoptedFrom: prev } };
}

// Mint a durable attempt row bound to a task (or run-level role). One row =
// one reservation; the budget gates are evaluated against THIS record only.
function mintOrchAttempt(D, run, payload, { role, phase, taskId = null, kind = null, n, inputCommit = null, snapshotOf = [] }, now) {
  const launch = payload.launch;
  if (!isObj(launch)) {
    throw new D.CommandError(422, 'invalid_argument', 'payload.launch must be an object');
  }
  const att = {
    id: D.reqStr(payload.attemptId, 'attemptId'),
    runId: run.id,
    role,
    phase,
    ...(taskId ? { taskId, kind: kind ?? 'work' } : {}),
    n,
    status: 'launching',
    owner: D.newOwner(payload, now, D.clampLeaseMs(payload.leaseMs)),
    launch: {
      profileId: launch.profileId,
      profileDigest: launch.profileDigest,
      promptSha256: launch.promptSha256,
      materialsSha256: launch.materialsSha256 ?? null,
      cwd: launch.cwd,
      artifactsDir: launch.artifactsDir,
      attemptDir: launch.attemptDir,
      ...(inputCommit ? { inputCommit, snapshotOf: [...snapshotOf] } : {}),
      ...(launch.canonicalId ? { canonicalId: launch.canonicalId } : {}),
      ...(launch.fromCanonical === true ? { fromCanonical: true } : {}),
      // Registered bindings the supervisor must rebuild materials from after
      // a restart — the candidate snapshot for verifiers, the project/snap
      // names for work/fix launches.
      ...(launch.projectRoot ? { projectRoot: launch.projectRoot } : {}),
      ...(launch.snapshotSha ? { snapshotSha: launch.snapshotSha } : {}),
      ...(launch.snapshotId ? { snapshotId: launch.snapshotId } : {}),
    },
    porchRunId: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    outcome: null,
    error: null,
  };
  run.attempts.push(att);
  return att;
}

function checkOrchLaunch(D, launch, profileEntry, what) {
  for (const [k, label] of [['profileId', 'launch.profileId'], ['profileDigest', 'launch.profileDigest'],
    ['promptSha256', 'launch.promptSha256'], ['cwd', 'launch.cwd'],
    ['artifactsDir', 'launch.artifactsDir'], ['attemptDir', 'launch.attemptDir']]) {
    if (typeof launch[k] !== 'string' || !launch[k].length) {
      throw new D.CommandError(422, 'invalid_argument', `${label} must be a non-empty string`);
    }
  }
  if (launch.profileId !== profileEntry.profileId) {
    throw new D.CommandError(422, 'launch_mismatch',
      `${what}: launch.profileId ${launch.profileId} != recorded ${profileEntry.profileId}`);
  }
  if (launch.profileDigest !== profileEntry.profileDigest) {
    throw new D.CommandError(422, 'launch_mismatch',
      `${what}: launch.profileDigest does not match the recorded digest — profile drift refused`);
  }
  if (!D.SHA256_RE.test(launch.promptSha256)) {
    throw new D.CommandError(422, 'invalid_argument', 'launch.promptSha256 must be a sha256 hex');
  }
  if (launch.materialsSha256 !== undefined && !D.SHA256_RE.test(launch.materialsSha256)) {
    throw new D.CommandError(422, 'invalid_argument', 'launch.materialsSha256 must be a sha256 hex');
  }
}

// Global slot accounting — identical unit model as begin_attempt: one live
// reservation per run counts once against the global budget; the role cap
// counts live attempts of that role across all aggregates.
async function orchSlotCheck(D, ctx, aggregate, role) {
  const limits = await ctx.loadSchedulerLimits();
  let globalActive = 0;
  let roleActive = 0;
  for (const agg of await ctx.listAggregates()) {
    for (const r of agg.runs || []) {
      let runActive = false;
      for (const a of r?.attempts || []) {
        if (a && D.ATTEMPT_NONTERMINAL.has(a.status)) {
          runActive = true;
          if (a.role === role) roleActive += 1;
        }
      }
      const v = r?.validation;
      if (v && (v.status === 'active' || v.status === 'unproven')) runActive = true;
      if (runActive) globalActive += 1;
    }
  }
  const roleCap = limits.roles?.[role] ?? limits.global;
  return { limits, globalActive, roleActive, roleCap };
}

async function assertFreshAttemptId(D, ctx, aggregate, attemptId) {
  for (const r of aggregate.runs || []) {
    for (const a of r?.attempts || []) {
      if (a && a.id === attemptId) {
        throw new D.CommandError(409, 'attempt_exists',
          `attemptId ${attemptId} is already recorded on run ${r.id}`);
      }
    }
  }
  for (const entry of await ctx.listAggregates()) {
    const other = entry && entry.aggregate ? entry.aggregate : entry;
    if (!other || other.cardId === aggregate.cardId) continue;
    for (const r of other.runs || []) {
      for (const a of r?.attempts || []) {
        if (a && a.id === attemptId) {
          throw new D.CommandError(409, 'attempt_exists',
            `attemptId ${attemptId} is already recorded on card ${other.cardId}`);
        }
      }
    }
  }
}

// orch_decompose_begin — mints the decomposer attempt. Phase-gated: only
// while the graph awaits (re-)decomposition and within the decomposer budget.
export async function cmdOrchDecomposeBegin(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  if (!['queued', 'active'].includes(run.status)) {
    throw new D.CommandError(409, 'run_not_launchable',
      `run ${run.id} is ${run.status} — the decomposer launches only from queued|active`);
  }
  if (run.phase !== 'decompose' || oz.graph.status !== 'awaiting_decomposition') {
    throw new D.CommandError(409, 'phase_mismatch',
      `decompose launches only while the graph awaits decomposition — run is ${run.phase}/${oz.graph.status}`);
  }
  const auth = oz.owner && D.ownsResource(oz.owner, payload);
  if (!auth) {
    throw new D.CommandError(409, 'not_orch_owner',
      'orch_decompose_begin requires the run\u2019s orchestrator owner instance');
  }
  const live = (run.attempts || []).find(
    (a) => a && D.ATTEMPT_NONTERMINAL.has(a.status) && ORCH_ATTEMPT_ROLES.has(a.role));
  if (live) {
    throw new D.CommandError(409, 'attempt_active',
      `attempt ${live.id} is ${live.status} — resolve it before launching another`);
  }
  const used = (run.attempts || []).filter((a) => a && a.role === 'decomposer').length;
  const limit = oz.limits?.decomposerAttempts ?? 2;
  if (used >= limit) {
    throw new D.CommandError(409, 'attempts_exhausted',
      `decomposer used ${used}/${limit} attempts`, { used, limit });
  }
  const attemptId = D.reqStr(payload.attemptId, 'attemptId');
  await assertFreshAttemptId(D, ctx, aggregate, attemptId);
  const slots = await orchSlotCheck(D, ctx, aggregate, 'decomposer');
  if (slots.globalActive >= slots.limits.global) {
    throw new D.CommandError(409, 'limit_reached',
      `global attempt limit reached (${slots.globalActive}/${slots.limits.global})`,
      { scope: 'global', active: slots.globalActive, limit: slots.limits.global });
  }
  if (slots.roleActive >= slots.roleCap) {
    throw new D.CommandError(409, 'limit_reached',
      `decomposer attempt limit reached (${slots.roleActive}/${slots.roleCap})`,
      { scope: 'role', role: 'decomposer', active: slots.roleActive, limit: slots.roleCap });
  }
  checkOrchLaunch(D, payload.launch, oz.decomposer, 'decomposer');
  const att = mintOrchAttempt(D, run, payload,
    { role: 'decomposer', phase: 'decompose', n: used + 1 }, now);
  oz.decomposeUsed = used + 1;
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: {
      attemptId: att.id, runId: run.id, status: att.status,
      slots: {
        global: { active: slots.globalActive + 1, limit: slots.limits.global },
        role: { role: 'decomposer', active: slots.roleActive + 1, limit: slots.roleCap },
      },
    },
  };
}

// ---- resolve_attempt hooks ---------------------------------------------------------

// The decomposer's spec descriptor on a 'completed' resolve: the committed,
// hash-verified spec artifact is re-parsed server-side — the driver's parse
// result is never the proof.
export async function checkDecompositionSpec(D, ctx, run, att, spec) {
  if (!isObj(spec)) {
    throw new D.CommandError(422, 'spec_invalid', 'payload.spec must be an object');
  }
  const artifactId = D.reqStr(spec.artifactId, 'spec.artifactId');
  const art = run.artifacts?.[artifactId];
  if (!art || art.attemptId !== att.id || art.kind !== 'decomposition'
    || art.sha256 !== spec.sha256 || art.bytes !== spec.bytes) {
    throw new D.CommandError(422, 'spec_unbound',
      'spec.artifactId must reference this attempt\'s committed decomposition artifact with identical sha256/bytes');
  }
  const { text } = await ctx.readArtifactText(run.id, art.stored ?? art.file);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new D.CommandError(422, 'spec_invalid',
      `committed decomposition artifact is not JSON: ${e.message}`);
  }
  return doc; // {decomposition:{subtasks:[...]}, proposedInputChanges?}
}

// A completed decomposer: parse+validate the committed spec; on success the
// graph registers (auto-approved or parked for the user), on contract
// violations the attempt resolves but the spec is REJECTED — the driver may
// retry while the decomposer budget lasts; it is never silently accepted.
export function onDecomposerResolved(D, aggregate, run, att, outcome, specDesc, doc, now, ctx) {
  const oz = run.orchestrator;
  if (outcome !== 'completed' || !doc) {
    if (oz.decomposeUsed >= (oz.limits?.decomposerAttempts ?? 2)) {
      run.status = 'failed';
      run.finishedAt = now;
      run.error = `decomposer exhausted ${oz.decomposeUsed} attempts without a valid spec`;
      setGraphStatus(ctx, run, 'stopped', 'decompose_exhausted', now);
    }
    return;
  }
  const dec = isObj(doc.decomposition) ? doc.decomposition : null;
  const specSha = sha256(canonicalJson(doc));
  oz.specHistory ??= [];
  try {
    assertNoSecrets(doc, 'decomposition');
    if (!dec || !Array.isArray(dec.subtasks)) {
      throw new RuntimeError('subtasks_invalid', 'decomposition.subtasks must be an array');
    }
    const set = validateSubtaskSet(dec.subtasks);
    if (set.tasks.length > (oz.limits?.maxSubtasks ?? 32)) {
      throw new RuntimeError('subtasks_invalid',
        `decomposition declares ${set.tasks.length} subtasks over the run limit ${oz.limits.maxSubtasks}`);
    }
    for (const t of set.tasks) {
      if (!oz.workers[t.worker.profileId]) {
        throw new RuntimeError('worker_unknown',
          `subtask ${t.id} names worker ${JSON.stringify(t.worker.profileId)} — not in the run's worker pool`,
          { taskId: t.id, worker: t.worker.profileId });
      }
    }
    const change = doc.proposedInputChanges !== undefined
      ? validateInputChanges(doc.proposedInputChanges, oz.graph.inputs)
      : null;
    const specRec = {
      version: (oz.spec?.version ?? 0) + 1,
      sha256: specSha,
      artifactId: specDesc?.artifactId ?? null,
      subtasks: set.tasks.length,
      proposedAt: now,
      approvedAt: null,
      by: null,
      status: 'pending',
    };
    oz.spec = specRec;
    // The validated set rides the DURABLE record — the approval path never
    // re-parses user input, it registers exactly what the server validated.
    oz.pendingSet = set;
    emit(ctx, run, 'spec_proposed',
      { version: specRec.version, sha256: specSha, subtasks: set.tasks.length, artifactId: specRec.artifactId }, now);
    if (change) {
      // An input-change proposal parks the graph for the user — the accepted
      // pins are never touched until a decision lands.
      const proposal = deepFreeze({
        proposalId: `prop_${++oz.proposalSeq}`,
        kind: 'decompose',
        changes: change.changes,
        fields: change.fields,
        reason: change.reason,
        subtasks: set,
      });
      oz.graph.pendingApproval = proposal;
      specRec.status = 'pending';
      setGraphStatus(ctx, run, 'approval_pending', 'input_change_proposed', now);
      emit(ctx, run, 'input_change_proposed',
        { proposalId: proposal.proposalId, kind: 'decompose', fields: [...proposal.fields], reason: proposal.reason }, now);
    } else if (oz.limits?.requireSpecApproval !== false) {
      setGraphStatus(ctx, run, 'approval_pending', 'spec_approval_required', now);
    } else {
      approveSpec(D, ctx, aggregate, run, now);
    }
    syncOrchPendingActions(run);
  } catch (e) {
    const err = wrapErr(D, e);
    oz.specHistory.push({
      version: oz.spec?.version ?? null,
      sha256: specSha,
      rejected: true,
      code: err.code ?? 'spec_invalid',
      message: String(err.message ?? e).slice(0, 500),
      attemptId: att.id,
      at: now,
    });
    oz.spec = null;
    oz.pendingSet = null;
    emit(ctx, run, 'spec_rejected',
      { sha256: specSha, code: err.code ?? 'spec_invalid', detail: String(err.message ?? e).slice(0, 300), attemptId: att.id }, now);
    if (oz.decomposeUsed >= (oz.limits?.decomposerAttempts ?? 2)) {
      run.status = 'failed';
      run.finishedAt = now;
      run.error = `decomposer exhausted ${oz.decomposeUsed} attempts — last spec rejected: ${err.code ?? 'invalid'}`;
      setGraphStatus(ctx, run, 'stopped', 'decompose_exhausted', now);
    }
  }
}

// Promote a registered spec to 'approved': the graph goes active and
// dependency-free tasks become ready. Shared by the auto-approve path and
// the user's orch_approve.
function approveSpec(D, ctx, aggregate, run, now, by = 'auto') {
  const oz = run.orchestrator;
  const spec = oz.spec;
  if (!spec || spec.status !== 'pending') {
    throw new D.CommandError(409, 'no_pending_spec', 'no pending decomposition spec to approve');
  }
  spec.status = 'approved';
  spec.approvedAt = now;
  spec.by = by;
  // Register the validated subtask set stashed on the durable record — the
  // approval never re-parses caller input.
  if (oz.pendingSet) {
    registerTasks(ctx, run, oz.pendingSet, now);
    oz.pendingSet = null;
  }
  setGraphStatus(ctx, run, 'active', 'spec_approved', now);
  run.phase = 'work';
  emit(ctx, run, 'spec_approved', { version: spec.version, sha256: spec.sha256 }, now);
  syncOrchPendingActions(run);
  syncStats(run);
  D.bumpControl(aggregate, now);
}

// orch_task_begin — mints a work|fix worker attempt or a verifier attempt
// bound to a graph task. Every launch binds the recorded profile digest and
// the dependency snapshot the driver assembled — a task can never launch on
// a snapshot that does not contain ALL of its accepted ancestors.
export async function cmdOrchTaskBegin(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  if (!['queued', 'active'].includes(run.status)) {
    throw new D.CommandError(409, 'run_not_launchable',
      `run ${run.id} is ${run.status} — task launches only from queued|active`);
  }
  if (run.phase !== 'work' || oz.graph.status !== 'active') {
    throw new D.CommandError(409, 'phase_mismatch',
      `task launches require active+work — run is ${run.phase}/${oz.graph.status}`);
  }
  if (!(oz.owner && D.ownsResource(oz.owner, payload))) {
    throw new D.CommandError(409, 'not_orch_owner',
      'orch_task_begin requires the run\u2019s orchestrator owner instance');
  }
  const taskId = D.reqStr(payload.taskId, 'taskId');
  const task = taskById(oz, taskId);
  if (!task) throw new D.CommandError(404, 'task_not_found', `task ${taskId} unknown`);
  const kind = D.reqStr(payload.kind, 'kind');
  if (!['work', 'fix', 'verify'].includes(kind)) {
    throw new D.CommandError(422, 'invalid_argument', 'kind must be work|fix|verify');
  }
  const live = (run.attempts || []).find(
    (a) => a && a.taskId === taskId && D.ATTEMPT_NONTERMINAL.has(a.status));
  if (live) {
    throw new D.CommandError(409, 'attempt_active',
      `attempt ${live.id} is ${live.status} — resolve it before launching another`,
      { attemptId: live.id });
  }
  let role = 'worker';
  let profileEntry = null;
  let n;
  const launch = isObj(payload.launch) ? payload.launch : {};
  if (kind === 'verify') {
    role = 'verifier';
    profileEntry = oz.verifier;
    if (task.state.status !== 'verifying') {
      throw new D.CommandError(409, 'task_state',
        `task ${taskId} is ${task.state.status} — a verifier launches only while the task awaits verdict`);
    }
    if (!task.state.resultCandidate) {
      throw new D.CommandError(409, 'verify_unready',
        `task ${taskId} has no imported result candidate — settle the work attempt first`);
    }
    n = (task.state.verifyUsed ?? 0) + 1;
    if (n > (oz.limits?.verifyAttempts ?? 2)) {
      throw new D.CommandError(409, 'attempts_exhausted',
        `task ${taskId} used ${task.state.verifyUsed}/${oz.limits?.verifyAttempts ?? 2} verifier attempts`);
    }
    task.state.verifyUsed = n;
  } else {
    profileEntry = oz.workers[task.worker.profileId];
    if (!profileEntry) {
      throw new D.CommandError(422, 'worker_unknown',
        `task ${taskId} worker ${task.worker.profileId} is not in the run's worker pool`);
    }
    if (kind === 'work') {
      if (task.state.status !== 'ready') {
        throw new D.CommandError(409, 'task_state',
          `task ${taskId} is ${task.state.status} — a work attempt launches from ready`);
      }
      n = (task.state.attemptsUsed ?? 0) + 1;
      if (n > taskAttemptBudget(task)) {
        throw new D.CommandError(409, 'attempts_exhausted',
          `task ${taskId} used ${task.state.attemptsUsed}/${taskAttemptBudget(task)} attempts`,
          { used: task.state.attemptsUsed, limit: taskAttemptBudget(task) });
      }
      task.state.attemptsUsed = n;
    } else { // fix
      if (task.state.status !== 'returned') {
        throw new D.CommandError(409, 'task_state',
          `task ${taskId} is ${task.state.status} — a fix attempt launches only from returned`);
      }
      n = (task.state.fixesUsed ?? 0) + 1;
      if (n > taskFixBudget(task)) {
        throw new D.CommandError(409, 'attempts_exhausted',
          `task ${taskId} used ${task.state.fixesUsed}/${taskFixBudget(task)} fix cycles`,
          { used: task.state.fixesUsed, limit: taskFixBudget(task) });
      }
      task.state.fixesUsed = n;
    }
    // KTD2: every work/fix launch binds a dependency snapshot that contains
    // ALL accepted ancestors — the exact recorded dep set, in topo order.
    if (task.dependsOn.length && !depsAccepted(oz, task)) {
      throw new D.CommandError(409, 'deps_unmet',
        `task ${taskId} has unaccepted dependencies`, { taskId });
    }
    const inputCommit = D.reqStr(launch.inputCommit, 'launch.inputCommit');
    if (!D.SHA40_RE.test(inputCommit)) {
      throw new D.CommandError(422, 'invalid_argument',
        'launch.inputCommit must be a 40-hex commit sha');
    }
    const snapshotOf = Array.isArray(launch.snapshotOf)
      ? launch.snapshotOf.map((x) => D.reqStr(x, 'launch.snapshotOf[]')) : [];
    const want = oz.order.filter((id) => task.dependsOn.includes(id));
    if (JSON.stringify(snapshotOf) !== JSON.stringify(want)) {
      throw new D.CommandError(409, 'snapshot_mismatch',
        `launch.snapshotOf must equal the accepted dep set ${JSON.stringify(want)} — got ${JSON.stringify(snapshotOf)}`);
    }
    if (kind === 'work') {
      task.state.inputCommit = inputCommit;
      task.state.snapshotOf = snapshotOf;
    }
    setTaskStatus(ctx, run, task, 'running', `${kind}_launch`, now);
    task.state.waiting = null;
  }
  const attemptId = D.reqStr(payload.attemptId, 'attemptId');
  await assertFreshAttemptId(D, ctx, aggregate, attemptId);
  const slots = await orchSlotCheck(D, ctx, aggregate, role);
  if (slots.globalActive >= slots.limits.global) {
    throw new D.CommandError(409, 'limit_reached',
      `global attempt limit reached (${slots.globalActive}/${slots.limits.global})`,
      { scope: 'global', active: slots.globalActive, limit: slots.limits.global });
  }
  if (slots.roleActive >= slots.roleCap) {
    throw new D.CommandError(409, 'limit_reached',
      `${role} attempt limit reached (${slots.roleActive}/${slots.roleCap})`,
      { scope: 'role', role, active: slots.roleActive, limit: slots.roleCap });
  }
  checkOrchLaunch(D, launch, profileEntry, kind === 'verify' ? 'verifier' : `worker ${task.worker.profileId}`);
  const att = mintOrchAttempt(D, run, payload, {
    role, phase: 'work', taskId, kind, n,
    inputCommit: kind !== 'verify' ? launch.inputCommit : (task.state.inputCommit ?? null),
    snapshotOf: kind !== 'verify' ? (launch.snapshotOf ?? []) : (task.state.snapshotOf ?? []),
  }, now);
  task.state.attempts.push(att.id);
  D.stageRun(aggregate, run, ctx);
  syncStats(run);
  return {
    aggregate,
    result: {
      attemptId: att.id, runId: run.id, taskId, kind, status: att.status,
      slots: {
        global: { active: slots.globalActive + 1, limit: slots.limits.global },
        role: { role, active: slots.roleActive + 1, limit: slots.roleCap },
      },
    },
  };
}

// orch_task_settle — records the imported result of a completed worker
// attempt as the task's result candidate and moves it to 'verifying'. The
// candidate binds the attempt that produced it — a late or foreign import
// can never settle a task.
export async function cmdOrchTaskSettle(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  if (!(oz.owner && D.ownsResource(oz.owner, payload))) {
    throw new D.CommandError(409, 'not_orch_owner',
      'orch_task_settle requires the run\u2019s orchestrator owner instance');
  }
  const task = taskById(oz, D.reqStr(payload.taskId, 'taskId'));
  if (!task) throw new D.CommandError(404, 'task_not_found', `task ${payload.taskId} unknown`);
  const att = (run.attempts || []).find(
    (a) => a && a.id === D.reqStr(payload.attemptId, 'attemptId'));
  if (!att || att.taskId !== task.id || att.role !== 'worker') {
    throw new D.CommandError(422, 'settle_unbound',
      'orch_task_settle names a worker attempt of this task — none found');
  }
  if (att.status !== 'completed') {
    throw new D.CommandError(409, 'settle_unproven',
      `attempt ${att.id} is ${att.status} — the result imports only from a completed attempt`);
  }
  if (task.state.status !== 'running' && task.state.status !== 'verifying') {
    throw new D.CommandError(409, 'task_state',
      `task ${task.id} is ${task.state.status} — no result may settle`);
  }
  const resultCommit = D.reqStr(payload.resultCommit, 'resultCommit');
  if (!D.SHA40_RE.test(resultCommit)) {
    throw new D.CommandError(422, 'invalid_argument', 'resultCommit must be a 40-hex commit sha');
  }
  const diffArtifactId = D.reqStr(payload.diffArtifactId, 'diffArtifactId');
  const dart = run.artifacts?.[diffArtifactId];
  if (!dart || dart.attemptId !== att.id || dart.kind !== 'worker-diff'
    || dart.sha256 !== payload.diffSha256) {
    throw new D.CommandError(422, 'diff_unbound',
      'diffArtifactId must reference this attempt\'s committed worker-diff artifact with identical sha256');
  }
  const patchSha256 = D.reqStr(payload.patchSha256, 'patchSha256');
  if (!D.SHA256_RE.test(patchSha256)) {
    throw new D.CommandError(422, 'invalid_argument', 'patchSha256 must be a sha256 hex');
  }
  const resultSha256 = D.reqStr(payload.resultSha256, 'resultSha256');
  if (!D.SHA256_RE.test(resultSha256)) {
    throw new D.CommandError(422, 'invalid_argument', 'resultSha256 must be a sha256 hex');
  }
  task.state.resultCandidate = {
    commit: resultCommit,
    attemptId: att.id,
    kind: att.kind,
    canonicalId: typeof payload.canonicalId === 'string' ? payload.canonicalId : null,
    canonicalCommit: typeof payload.canonicalCommit === 'string' ? payload.canonicalCommit : null,
    diffArtifactId,
    reportArtifactId: typeof payload.reportArtifactId === 'string' ? payload.reportArtifactId : null,
    patchSha256,
    resultSha256,
    diffStat: typeof payload.diffStat === 'string' ? payload.diffStat.slice(0, 4000) : null,
    changed: payload.changed === true,
    at: now,
  };
  setTaskStatus(ctx, run, task, 'verifying', 'result_imported', now);
  emit(ctx, run, 'task_result_imported',
    { taskId: task.id, attemptId: att.id, commit: resultCommit, changed: task.state.resultCandidate.changed }, now);
  D.stageRun(aggregate, run, ctx);
  syncStats(run);
  return {
    aggregate,
    result: { taskId: task.id, status: task.state.status, resultCommit },
  };
}

// orch_integrate_begin — mints the assembler attempt once every task is
// accepted. The canonical binding mints once and can never change.
export async function cmdOrchIntegrateBegin(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  if (!['queued', 'active'].includes(run.status)) {
    throw new D.CommandError(409, 'run_not_launchable',
      `run ${run.id} is ${run.status} — the assembler launches only from queued|active`);
  }
  if (run.phase !== 'integrate' || oz.graph.status !== 'complete') {
    throw new D.CommandError(409, 'phase_mismatch',
      `the assembler launches only at complete+integrate — run is ${run.phase}/${oz.graph.status}`);
  }
  if (!(oz.owner && D.ownsResource(oz.owner, payload))) {
    throw new D.CommandError(409, 'not_orch_owner',
      'orch_integrate_begin requires the run\u2019s orchestrator owner instance');
  }
  const live = (run.attempts || []).find(
    (a) => a && D.ATTEMPT_NONTERMINAL.has(a.status));
  if (live) {
    throw new D.CommandError(409, 'attempt_active',
      `attempt ${live.id} is ${live.status} — resolve it first`);
  }
  const used = (run.attempts || []).filter((a) => a && a.role === 'assembler').length;
  const limit = oz.limits?.maxIntegratorAttempts ?? 2;
  if (used >= limit) {
    throw new D.CommandError(409, 'attempts_exhausted',
      `assembler used ${used}/${limit} attempts`, { used, limit });
  }
  const attemptId = D.reqStr(payload.attemptId, 'attemptId');
  await assertFreshAttemptId(D, ctx, aggregate, attemptId);
  const slots = await orchSlotCheck(D, ctx, aggregate, 'assembler');
  if (slots.globalActive >= slots.limits.global) {
    throw new D.CommandError(409, 'limit_reached',
      `global attempt limit reached (${slots.globalActive}/${slots.limits.global})`);
  }
  const launch = payload.launch;
  checkOrchLaunch(D, launch, oz.integrator, 'assembler');
  const cid = launch.canonicalId;
  if (typeof cid !== 'string' || !cid.length || cid.length > 160) {
    throw new D.CommandError(422, 'invalid_argument', 'launch.canonicalId must be a safe id');
  }
  if (oz.integrate?.canonicalId && oz.integrate.canonicalId !== cid) {
    throw new D.CommandError(409, 'canonical_mismatch',
      `canonicalId ${cid} does not match the recorded binding ${oz.integrate.canonicalId}`);
  }
  const att = mintOrchAttempt(D, run, payload,
    { role: 'assembler', phase: 'integrate', n: used + 1 }, now);
  oz.integrate = {
    canonicalId: cid,
    attemptId: att.id,
    import: null,
    at: now,
  };
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: { attemptId: att.id, runId: run.id, status: att.status, canonicalId: cid },
  };
}

// orch_integrate_record — lands after the driver imported the assembler's
// private repo into the run canonical and materialized it into the bound
// workspace. The run then rides the U5 gate.
export async function cmdOrchIntegrateRecord(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  if (run.status !== 'active' || run.phase !== 'integrate') {
    throw new D.CommandError(409, 'phase_mismatch',
      `orch_integrate_record requires active+integrate — run is ${run.status}/${run.phase}`);
  }
  const lastAtt = (run.attempts || [])[run.attempts.length - 1] ?? null;
  const auth = (oz.owner && D.ownsResource(oz.owner, payload))
    || (lastAtt && D.ownsResource(lastAtt.owner, payload));
  if (!auth) {
    throw new D.CommandError(409, 'not_orch_owner',
      'orch_integrate_record requires the run\u2019s orchestrator owner instance');
  }
  const att = (run.attempts || []).find(
    (a) => a && a.id === D.reqStr(payload.attemptId, 'attemptId'));
  if (!att || att.role !== 'assembler' || att.status !== 'completed') {
    throw new D.CommandError(422, 'integrate_unproven',
      'orch_integrate_record names a completed assembler attempt — none found');
  }
  const imp = isObj(payload.import) ? payload.import : null;
  if (!imp || typeof imp.commitSha !== 'string' || !imp.commitSha.length || imp.commitSha.length > 128) {
    throw new D.CommandError(422, 'invalid_argument', 'import.commitSha must be a non-empty string');
  }
  oz.integrate ??= {};
  oz.integrate.import = {
    attemptId: att.id,
    canonicalId: att.launch?.canonicalId ?? oz.integrate.canonicalId ?? null,
    commitSha: imp.commitSha,
    treeSha: typeof imp.treeSha === 'string' ? imp.treeSha.slice(0, 128) : null,
    changed: imp.changed === true,
    diffStat: typeof imp.diffStat === 'string' ? imp.diffStat.slice(0, 4000) : null,
    at: now,
  };
  run.status = 'active';
  run.phase = 'awaiting_validation';
  run.error = null;
  emit(ctx, run, 'integrate_imported',
    { attemptId: att.id, commitSha: imp.commitSha, changed: imp.changed === true }, now);
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: { runId: run.id, status: run.status, phase: run.phase },
  };
}

// orch_annul — the workspace's result hash drifted after the gate parked
// the run at awaiting_acceptance (a new edit landed). The recorded gate
// stays as evidence; the run re-enters validation honestly.
export async function cmdOrchAnnul(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  if (run.status !== 'awaiting_acceptance') {
    throw new D.CommandError(409, 'acceptance_state',
      `run ${run.id} is ${run.status} — only awaiting_acceptance can be annulled`);
  }
  const lastAtt = (run.attempts || [])[run.attempts.length - 1] ?? null;
  const auth = (oz.owner && D.ownsResource(oz.owner, payload))
    || (lastAtt && D.ownsResource(lastAtt.owner, payload));
  if (!auth) {
    throw new D.CommandError(409, 'not_orch_owner',
      'orch_annul requires the run\u2019s orchestrator owner instance');
  }
  const prior = run.acceptance ?? null;
  run.status = 'active';
  run.phase = 'awaiting_validation';
  run.acceptance = null;
  run.diagnostic = {
    type: 'result_drift',
    at: now,
    detail: 'workspace content changed after the acceptance gate — re-verification required',
    priorSha256: prior?.resultSha256 ?? null,
    observedSha256: typeof payload.observedSha256 === 'string' ? payload.observedSha256 : null,
  };
  emit(ctx, run, 'acceptance_annulled',
    { priorSha256: prior?.resultSha256 ?? null, round: prior?.round ?? null }, now);
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: { runId: run.id, status: run.status, phase: run.phase },
  };
}

// orch_worker_settled — the durable namespace-settle record. The driver
// physically stops the attempt's worker container (worker.stop + positive
// stopped/gone status) BEFORE recording this; once landed the namespace is
// proven unwritable — host repo reads (freeze/export/import) can never
// race a live writer. Idempotent on the same state+workerId.
export async function cmdOrchWorkerSettled(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  const lastAtt = (run.attempts || [])[run.attempts.length - 1] ?? null;
  const auth = (oz.owner && D.ownsResource(oz.owner, payload))
    || (lastAtt && D.ownsResource(lastAtt.owner, payload))
    || D.ownsResource(run.owner ?? null, payload);
  if (!auth) {
    throw new D.CommandError(409, 'not_orch_owner',
      'orch_worker_settled requires the run\u2019s orchestrator owner instance');
  }
  const att = (run.attempts || []).find(
    (a) => a && a.id === D.reqStr(payload.attemptId, 'attemptId'));
  if (!att) throw new D.CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
  const state = D.reqStr(payload.state, 'state');
  if (state !== 'stopped' && state !== 'gone') {
    throw new D.CommandError(422, 'namespace_unproven',
      `state must be 'stopped' or 'gone' — got ${JSON.stringify(state)}`);
  }
  const workerId = D.reqStr(payload.workerId, 'workerId');
  const expected = att.launch?.workerId ?? `w-${att.id}`;
  if (workerId !== expected) {
    throw new D.CommandError(422, 'namespace_unproven',
      `workerId ${workerId} does not match the recorded binding ${expected}`);
  }
  const prior = att.namespace ?? null;
  if (prior && (prior.workerId !== workerId
    || (prior.state === 'gone' && state === 'stopped'))) {
    throw new D.CommandError(409, 'namespace_conflict',
      `attempt ${att.id} already settled as ${prior.state}/${prior.workerId}`);
  }
  att.namespace = { state, workerId, settledAt: now };
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: { runId: run.id, attemptId: att.id, namespace: att.namespace },
  };
}

// ---- resolve_attempt hooks (worker / verifier / assembler) ------------------------

// The verifier's verdict descriptor on a 'completed' resolve — bound to a
// committed, hash-verified artifact exactly like the spec binding.
export function checkTaskVerdict(D, run, att, verdict) {
  if (!isObj(verdict)) {
    throw new D.CommandError(422, 'verdict_invalid', 'payload.verdict must be an object');
  }
  const decision = D.reqStr(verdict.decision, 'verdict.decision');
  if (!['accept', 'return'].includes(decision)) {
    throw new D.CommandError(422, 'verdict_invalid', 'verdict.decision must be accept|return');
  }
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  if (decision === 'return' && !findings.length) {
    throw new D.CommandError(422, 'verdict_invalid', 'a return verdict requires non-empty findings');
  }
  const artifactId = D.reqStr(verdict.artifactId, 'verdict.artifactId');
  const art = run.artifacts?.[artifactId];
  if (!art || art.attemptId !== att.id || art.kind !== 'verdict'
    || art.sha256 !== verdict.sha256 || art.bytes !== verdict.bytes) {
    throw new D.CommandError(422, 'verdict_unbound',
      'verdict.artifactId must reference this attempt\'s committed verdict artifact with identical sha256/bytes');
  }
  return {
    decision,
    artifactId,
    sha256: verdict.sha256,
    findings: findings.slice(0, 32).map((f) => isObj(f)
      ? { id: typeof f.id === 'string' ? f.id.slice(0, 80) : null,
          text: typeof f.text === 'string' ? f.text.slice(0, 1000) : null,
          severity: typeof f.severity === 'string' ? f.severity.slice(0, 32) : null,
          where: typeof f.where === 'string' ? f.where.slice(0, 300) : null }
      : { text: String(f).slice(0, 1000) }),
    summary: typeof verdict.summary === 'string' ? verdict.summary.slice(0, 2000) : null,
  };
}

// A completed verifier: the verdict drives the task transition — accept
// binds the result candidate IMMUTABLY; return queues a fix round while the
// fix budget lasts. A failed verifier attempt consumes verify budget only.
export function onVerifierResolved(D, aggregate, run, att, outcome, verdict, now, ctx) {
  const oz = run.orchestrator;
  const task = taskById(oz, att.taskId);
  if (!task) return; // task was cancelled/reset — the evidence stays on the attempt
  if (task.state.status === 'cancelled') return;
  if (outcome === 'completed' && verdict) {
    const cand = task.state.resultCandidate;
    task.state.evidence = {
      verdictArtifactId: verdict.artifactId,
      verdictSha256: verdict.sha256 ?? null,
      verdict: verdict.decision,
      findings: verdict.findings,
      summary: verdict.summary,
      attemptId: att.id,
      at: now,
    };
    emit(ctx, run, 'task_verdict',
      { taskId: task.id, verdict: verdict.decision, findings: verdict.findings.length, attemptId: att.id }, now);
    if (verdict.decision === 'accept') {
      if (!cand) {
        setTaskStatus(ctx, run, task, 'failed', 'accept_without_result', now);
        task.state.lastError = { reason: 'accept verdict without an imported result candidate', attemptId: att.id, at: now };
      } else {
        task.state.resultCommit = cand.commit;
        task.state.resultSha256 = cand.resultSha256 ?? cand.commit;
        task.state.patchSha256 = cand.patchSha256 ?? null;
        task.state.diffArtifactId = cand.diffArtifactId ?? null;
        task.state.canonicalId = cand.canonicalId ?? null;
        task.state.canonicalCommit = cand.canonicalCommit ?? null;
        task.state.resultCandidate = null;
        setTaskStatus(ctx, run, task, 'accepted', 'verdict_accept', now);
        promoteReady(ctx, run, 'dependency_met', now);
        if (oz.tasks.length && oz.tasks.every((t) => t.state.status === 'accepted')) {
          setGraphStatus(ctx, run, 'complete', 'all_accepted', now);
          run.phase = 'integrate';
          emit(ctx, run, 'graph_complete', { tasks: oz.tasks.length }, now);
        }
      }
    } else { // return
      task.state.lastError = null;
      if ((task.state.fixesUsed ?? 0) < taskFixBudget(task)) {
        setTaskStatus(ctx, run, task, 'returned', 'verdict_return', now);
      } else {
        task.state.waiting = { reason: 'grant', since: now };
        setTaskStatus(ctx, run, task, 'blocked', 'fix_budget_exhausted', now);
      }
    }
  } else {
    // Verifier attempt failed/cancelled — the task stays 'verifying' while
    // the verify budget lasts; exhausted verify budget blocks the task.
    if ((task.state.verifyUsed ?? 0) < (oz.limits?.verifyAttempts ?? 2)) {
      // still 'verifying' — the driver re-launches the verifier
    } else {
      task.state.waiting = { reason: 'grant', since: now };
      setTaskStatus(ctx, run, task, 'blocked', 'verify_budget_exhausted', now);
      task.state.lastError = {
        reason: att.error ?? `verifier ${outcome}`, attemptId: att.id, at: now,
      };
    }
  }
  syncOrchPendingActions(run);
  syncStats(run);
}

// A terminal worker attempt: 'completed' does NOT settle the task — the
// driver imports the private repo, then orch_task_settle records the
// candidate. failed/cancelled consumes the attempt; budget decides retry
// vs block (R5 — exhaustion is never silent).
export function onWorkerResolved(D, aggregate, run, att, outcome, now, ctx) {
  const oz = run.orchestrator;
  const task = taskById(oz, att.taskId);
  if (!task || task.state.status === 'cancelled') return;
  if (outcome === 'completed') return; // awaits orch_task_settle
  task.state.lastError = {
    outcome,
    reason: att.error ?? null,
    attemptId: att.id,
    at: now,
  };
  const used = att.kind === 'fix' ? task.state.fixesUsed : task.state.attemptsUsed;
  const budget = att.kind === 'fix' ? taskFixBudget(task) : taskAttemptBudget(task);
  if (outcome === 'cancelled') {
    setTaskStatus(ctx, run, task, 'cancelled', 'attempt_cancelled', now);
  } else if (used < budget) {
    if (depsAccepted(oz, task)) {
      setTaskStatus(ctx, run, task, 'ready', 'attempt_failed', now);
    } else {
      setTaskStatus(ctx, run, task, 'pending', 'attempt_failed', now);
    }
  } else {
    task.state.waiting = { reason: 'grant', since: now };
    setTaskStatus(ctx, run, task, 'blocked', 'attempts_exhausted', now);
  }
  syncOrchPendingActions(run);
  syncStats(run);
}

// A terminal assembler attempt: 'completed' awaits the driver-side import +
// orch_integrate_record; a failure consumes the assembler budget, then the
// run fails honestly.
export function onAssemblerResolved(D, aggregate, run, att, outcome, now, ctx) {
  const oz = run.orchestrator;
  if (outcome === 'completed') return; // awaits orch_integrate_record
  const used = (run.attempts || []).filter((a) => a && a.role === 'assembler').length;
  if (used >= (oz.limits?.maxIntegratorAttempts ?? 2)) {
    run.status = 'failed';
    run.finishedAt = now;
    run.error = `assembler exhausted ${used} attempts — last: ${att.error ?? outcome}`;
    setGraphStatus(ctx, run, 'stopped', 'integrate_exhausted', now);
    syncStats(run);
  }
}

// ---- user commands --------------------------------------------------------------

// orch_approve — the user's acceptance of the CURRENT spec version. Binding
// is exact: a stale sha256 refuses.
export async function cmdOrchApprove(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  if (oz.graph.status !== 'approval_pending' || oz.graph.pendingApproval) {
    throw new D.CommandError(409, 'approval_state',
      `run ${run.id} is not waiting on a spec approval (graph ${oz.graph.status})`);
  }
  const spec = oz.spec;
  if (!spec || spec.status !== 'pending') {
    throw new D.CommandError(409, 'no_pending_spec', 'no pending decomposition spec');
  }
  const wantSha = D.reqStr(payload.specSha256, 'specSha256');
  if (wantSha !== spec.sha256) {
    throw new D.CommandError(409, 'hash_mismatch',
      `specSha256 does not match the current spec version ${spec.version}`);
  }
  // The spec's validated set was held for approval — register it now.
  if (!oz.pendingSet) {
    // The set was stashed on the durable record at proposal time; a reload
    // reconstructs it — never from the caller.
    throw new D.CommandError(409, 'spec_lost',
      'the spec record lost its subtask set — re-decompose required');
  }
  approveSpec(D, ctx, aggregate, run, now, 'user');
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: { runId: run.id, spec: { version: spec.version, sha256: spec.sha256, status: spec.status }, phase: run.phase },
  };
}

// orch_decide — resolves a pending input-change proposal. approve mints a
// NEW frozen inputs object at revision+1 (old pins never mutate) and
// registers the proposal's subtasks; reject drops the proposal and the
// graph returns to awaiting_decomposition (kind 'decompose') or active
// (kind 'amend').
export async function cmdOrchDecide(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  const g = oz.graph;
  const p = g.pendingApproval;
  if (!p) throw new D.CommandError(409, 'no_pending_approval', 'the graph has no pending input change');
  if (D.reqStr(payload.proposalId, 'proposalId') !== p.proposalId) {
    throw new D.CommandError(409, 'proposal_mismatch', `the pending proposal is ${p.proposalId}`);
  }
  if (payload.decision !== 'approve' && payload.decision !== 'reject') {
    throw new D.CommandError(422, 'decision_invalid', 'decision must be approve|reject');
  }
  if (payload.decision === 'reject') {
    g.pendingApproval = null;
    emit(ctx, run, 'input_change_rejected', { proposalId: p.proposalId }, now);
    // A rejected decompose-time proposal discards the parked spec too — a
    // fresh decomposition under the unchanged inputs may follow.
    if (p.kind === 'decompose') {
      if (oz.spec && oz.spec.status === 'pending') {
        oz.spec.status = 'superseded';
        (oz.specHistory ??= []).push({ ...oz.spec, at: now });
        oz.spec = null;
      }
      oz.pendingSet = null;
      setGraphStatus(ctx, run, 'awaiting_decomposition', 'input_change_rejected', now);
      run.phase = 'decompose';
    } else {
      setGraphStatus(ctx, run, 'active', 'input_change_rejected', now);
    }
    syncOrchPendingActions(run);
    D.stageRun(aggregate, run, ctx);
    D.bumpControl(aggregate, now);
    return { aggregate, refreshProjection: true, result: { decision: 'reject', graphStatus: g.status } };
  }
  // approve: new frozen inputs at revision+1.
  g.inputs = validateInputs({ ...g.inputs, ...p.changes });
  g.revision += 1;
  g.pendingApproval = null;
  emit(ctx, run, 'input_change_approved', { proposalId: p.proposalId, revision: g.revision }, now);
  emit(ctx, run, 'inputs_changed', { revision: g.revision, fields: [...p.fields] }, now);
  if (p.subtasks) {
    // The proposal carried a validated set bound to the new basis — register
    // it (re-decomposition not needed) and approve the spec record.
    if (oz.spec && oz.spec.status === 'pending') {
      oz.spec.status = 'approved';
      oz.spec.approvedAt = now;
      oz.spec.by = 'user';
      emit(ctx, run, 'spec_approved', { version: oz.spec.version, sha256: oz.spec.sha256, via: 'input_change' }, now);
    }
    oz.pendingSet = null;
    registerTasks(ctx, run, p.subtasks, now);
  } else {
    // Approved without a replacement decomposition — accepted evidence
    // never carries across an input change: every live task reverts.
    for (const id of oz.order) {
      const t = taskById(oz, id);
      if (!t || t.state.status === 'cancelled') continue;
      if (t.state.status !== 'pending') {
        setTaskStatus(ctx, run, t, 'pending', 'inputs_changed', now);
      }
      Object.assign(t.state, {
        attemptsUsed: 0, fixesUsed: 0, verifyUsed: 0, extraAttempts: 0, extraFixes: 0,
        attempts: [], inputCommit: null, snapshotOf: [], resultCommit: null,
        resultSha256: null, patchSha256: null, diffArtifactId: null,
        canonicalId: null, canonicalCommit: null,
        evidence: null, waiting: null, lastError: null,
      });
    }
  }
  setGraphStatus(ctx, run, 'active', 'input_change_approved', now);
  run.phase = 'work';
  promoteReady(ctx, run, 'dependency_met', now);
  syncOrchPendingActions(run);
  syncStats(run);
  D.stageRun(aggregate, run, ctx);
  D.bumpControl(aggregate, now);
  return { aggregate, refreshProjection: true, result: { decision: 'approve', revision: g.revision, graphStatus: g.status } };
}

// orch_grant — the ONLY way an exhausted task re-arms: an explicit user
// grant of additional attempts/fix cycles (R5 — never silent).
export async function cmdOrchGrant(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  const task = taskById(oz, D.reqStr(payload.taskId, 'taskId'));
  if (!task) throw new D.CommandError(404, 'task_not_found', `task ${payload.taskId} unknown`);
  if (task.state.status !== 'blocked' && task.state.status !== 'waiting' && task.state.status !== 'failed') {
    throw new D.CommandError(409, 'grant_state',
      `task ${task.id} is ${task.state.status} — grants apply to blocked/waiting/failed tasks`);
  }
  const grant = Number.isInteger(payload.attempts) ? payload.attempts : 1;
  if (grant < 1 || grant > 10) {
    throw new D.CommandError(422, 'invalid_argument', 'attempts must be an integer in [1,10]');
  }
  const fixes = Number.isInteger(payload.fixCycles) ? payload.fixCycles : 0;
  if (fixes < 0 || fixes > 10) {
    throw new D.CommandError(422, 'invalid_argument', 'fixCycles must be an integer in [0,10]');
  }
  task.state.extraAttempts = (task.state.extraAttempts ?? 0) + grant;
  task.state.extraFixes = (task.state.extraFixes ?? 0) + fixes;
  task.state.waiting = null;
  emit(ctx, run, 'task_granted', { taskId: task.id, attempts: grant, fixCycles: fixes }, now);
  if (depsAccepted(oz, task)) {
    setTaskStatus(ctx, run, task, 'ready', 'granted', now);
  } else {
    setTaskStatus(ctx, run, task, 'pending', 'granted', now);
  }
  syncOrchPendingActions(run);
  syncStats(run);
  D.stageRun(aggregate, run, ctx);
  D.bumpControl(aggregate, now);
  return { aggregate, refreshProjection: true, result: { taskId: task.id, status: task.state.status, budget: taskAttemptBudget(task) } };
}

// orch_retry — re-queue a failed/returned task that still has budget.
export async function cmdOrchRetry(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  const task = taskById(oz, D.reqStr(payload.taskId, 'taskId'));
  if (!task) throw new D.CommandError(404, 'task_not_found', `task ${payload.taskId} unknown`);
  if (!['failed', 'returned', 'waiting'].includes(task.state.status)) {
    throw new D.CommandError(409, 'retry_state',
      `task ${task.id} is ${task.state.status} — only failed/returned/waiting tasks retry`);
  }
  const budget = task.state.status === 'returned' ? taskFixBudget(task) : taskAttemptBudget(task);
  const used = task.state.status === 'returned' ? task.state.fixesUsed : task.state.attemptsUsed;
  if (used >= budget) {
    throw new D.CommandError(409, 'attempts_exhausted',
      `task ${task.id} used ${used}/${budget} — an explicit grant is required`);
  }
  task.state.waiting = null;
  if (depsAccepted(oz, task)) {
    setTaskStatus(ctx, run, task, 'ready', 'user_retry', now);
  } else {
    setTaskStatus(ctx, run, task, 'pending', 'user_retry', now);
  }
  syncOrchPendingActions(run);
  D.stageRun(aggregate, run, ctx);
  D.bumpControl(aggregate, now);
  return { aggregate, refreshProjection: true, result: { taskId: task.id, status: task.state.status } };
}

// orch_answer — the user's answer to a task's blocking question.
export async function cmdOrchAnswer(D, ctx, aggregate, payload, now) {
  const run = orchestratorRun(D, aggregate, payload);
  const oz = run.orchestrator;
  const task = taskById(oz, D.reqStr(payload.taskId, 'taskId'));
  if (!task) throw new D.CommandError(404, 'task_not_found', `task ${payload.taskId} unknown`);
  const w = task.state.waiting;
  if (task.state.status !== 'waiting' || !w || w.reason !== 'question') {
    throw new D.CommandError(409, 'no_pending_question',
      `task ${task.id} is not waiting on a question`);
  }
  const answer = D.reqStr(payload.answer, 'answer');
  if (answer.length > 4000) {
    throw new D.CommandError(422, 'invalid_argument', 'answer must be at most 4000 chars');
  }
  task.state.answer = { text: answer.slice(0, 4000), at: now };
  task.state.waiting = null;
  emit(ctx, run, 'task_answered', { taskId: task.id }, now);
  if (depsAccepted(oz, task)) {
    setTaskStatus(ctx, run, task, 'ready', 'answered', now);
  } else {
    setTaskStatus(ctx, run, task, 'pending', 'answered', now);
  }
  syncOrchPendingActions(run);
  D.stageRun(aggregate, run, ctx);
  D.bumpControl(aggregate, now);
  return { aggregate, refreshProjection: true, result: { taskId: task.id, status: task.state.status } };
}

// ---- stop hook ---------------------------------------------------------------

// The card-level stop landed a durable stop intent on every live attempt;
// the graph mirrors it: non-terminal tasks go 'cancelled' (accepted evidence
// survives), the graph parks 'stopped'.
export function orchOnStop(D, ctx, run, now) {
  const oz = run.orchestrator;
  if (!oz || !oz.graph) return;
  for (const t of oz.tasks || []) {
    if (t.state && !['accepted', 'cancelled'].includes(t.state.status)) {
      setTaskStatus(ctx, run, t, 'cancelled', 'stop', now);
      t.state.waiting = null;
    }
  }
  if (oz.graph.pendingApproval) {
    const p = oz.graph.pendingApproval;
    oz.graph.pendingApproval = null;
    emit(ctx, run, 'input_change_rejected', { proposalId: p.proposalId, cause: 'stop' }, now);
  }
  setGraphStatus(ctx, run, 'stopped', 'stop', now);
  syncOrchPendingActions(run);
  syncStats(run);
}
