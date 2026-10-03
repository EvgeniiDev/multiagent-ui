// server/execution/fusion/domain.mjs — F2 panel domain logic.
//
// These handlers run INSIDE execution-domain's serialized command queue.
// They never import the domain module (no cycle): the domain assembles a
// deps bag `D` (CommandError, regexes, attempt/owner helpers, storage
// ctx) and calls these functions with it.
//
//   user channel:     retry_participant, exclude_panelist
//   internal channel: panel_claim, panel_begin, panel_settle
//   hooks:            buildFusionRun / buildFusionContinuation (start/
//                     continue), onPanelistResolved (resolve_attempt)
//
// Invariants enforced here:
//   * a panelist attempt is DURABLE (panel_begin) before any runtime call;
//   * launches are bound to the recorded profileDigest — a different
//     effective profile can never mint an attempt under this participant;
//   * runStatus/runPhase are never set by a participant resolve — the run
//     only terminalizes through panel_settle (or the generic stop path);
//   * exclusion/quorum math is recomputed from the durable participant
//     set — caller claims are never trusted.

import { randomUUID } from 'node:crypto';
import { RuntimeError, SAFE_ID_RE } from '../common.mjs';
import { sha256 } from '../execution-store.mjs';
import { canonicalJson } from '../environment/agent-profile.mjs';
import { validateRecordedAnswer } from './answer.mjs';
import {
  validateRecordedWorkOrder, validateRecordedReport,
  parseWorkOrder, parseIntegratorReport, workOrderContractText,
} from './work-order.mjs';
import {
  validateFusionSpec,
  MIN_DISTINCT_MODELS, MAX_PANELISTS,
  participantAttempts, participantAttemptsLeft,
  derivedSettleOutcome, panelState,
} from './panel-spec.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const DOC_TASK_KINDS = new Set(['requirements', 'design']);

// F3: the declared launch-input names per handoff role — the deploy
// config mirrors them for worker prepare (extra names never mount).
const JUDGE_INPUTS = new Set(['task', 'answers', 'rubric']);
const INTEGRATOR_INPUTS = new Set(['task', 'work-order', 'requirements', 'plan', 'design', 'results']);
const WORK_ORDER_RUBRIC = workOrderContractText();

// Wrap spec-validation RuntimeErrors as 422 CommandErrors with the same
// code — callers see the domain's standard shape.
function wrapSpecError(D, e) {
  if (e instanceof RuntimeError) {
    return new D.CommandError(422, e.code, e.message, e.extra ?? {});
  }
  return e;
}

// ---- task binding -----------------------------------------------------------

// The task is a PINNED document version {kind,versionId,sha256}: the
// recorded version must exist in aggregate.documents and its blob must
// verify NOW — a queued run never references evidence that is missing at
// launch time. For resultKind 'implementation' the task defaults to the
// approved requirements version.
async function resolveTaskBinding(D, ctx, aggregate, raw, { reqA = null, requireTask = true } = {}) {
  if (raw === undefined || raw === null) {
    if (reqA) return { kind: 'requirements', versionId: reqA.versionId, sha256: reqA.sha256 };
    if (requireTask) {
      throw new D.CommandError(422, 'panel_invalid',
        'fusion.task {kind,versionId,sha256} is required for a document run');
    }
    return null;
  }
  if (!isObj(raw)) {
    throw new D.CommandError(422, 'panel_invalid', 'fusion.task must be an object');
  }
  const kind = raw.kind === undefined ? 'requirements' : raw.kind;
  if (!DOC_TASK_KINDS.has(kind)) {
    throw new D.CommandError(422, 'panel_invalid',
      `fusion.task.kind must be one of ${[...DOC_TASK_KINDS].join('|')}`);
  }
  const versionId = D.reqStr(raw.versionId, 'fusion.task.versionId');
  const wantSha = D.reqStr(raw.sha256, 'fusion.task.sha256');
  if (!D.SHA256_RE.test(wantSha)) {
    throw new D.CommandError(422, 'invalid_argument', 'fusion.task.sha256 must be a sha256 hex');
  }
  const docKind = aggregate.documents?.[kind];
  const ver = (docKind?.versions || []).find((v) => v && v.versionId === versionId);
  if (!ver) {
    throw new D.CommandError(422, 'task_unbound',
      `fusion.task ${kind}/${versionId} does not name an attached document version`);
  }
  if (ver.sha256 !== wantSha) {
    throw new D.CommandError(409, 'task_mismatch',
      `fusion.task sha256 does not match the stored ${kind} version — pin the exact version`);
  }
  await ctx.requireBlob(ver.sha256, `${kind} task document`);
  return { kind, versionId, sha256: ver.sha256 };
}

// ---- run construction --------------------------------------------------------

function fusionParticipant(spec) {
  return {
    id: spec.id,
    label: spec.label,
    profileId: spec.profileId,
    provider: spec.provider,
    model: spec.model,
    profileDigest: spec.profileDigest,
    profile: spec.profile,
    status: 'pending',
    attemptsUsed: 0,
    extraAttempts: 0,
    answer: null,
    exclusion: null,
    lastError: null,
  };
}

async function resolveProjectSnapshot(D, ctx, aggregate, payload, prevBaseRef) {
  const baseRef = typeof payload?.baseRef === 'string' && payload.baseRef.trim()
    ? payload.baseRef.trim()
    : (prevBaseRef ?? 'HEAD');
  try {
    return {
      baseRef,
      snapshotSha: await D.resolveBaseCommit(aggregate.projectPath, baseRef),
    };
  } catch (e) {
    if (e instanceof RuntimeError
      && (e.code === 'git_unavailable' || e.code === 'git_ownership')) {
      throw new D.CommandError(503, e.code, e.message);
    }
    throw new D.CommandError(422, 'base_ref_invalid',
      e instanceof RuntimeError ? e.message : String(e));
  }
}

// The registered-projects root relative name the container runtime
// mounts as /work/project — defaults to the card project path basename.
function fusionProjectRoot(D, aggregate, rawSpec) {
  const explicit = rawSpec?.projectRoot;
  if (explicit === undefined || explicit === null) {
    return D.projectKeyFor(aggregate.projectPath);
  }
  if (typeof explicit !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(explicit)
    || explicit.includes('..')) {
    throw new D.CommandError(422, 'panel_invalid',
      'fusion.projectRoot must be a safe relative path inside the projects root');
  }
  return D.normPath(explicit);
}

function computeFingerprint({ inputsSha256 = null, task, project, spec }) {
  return sha256(canonicalJson({
    taskSha256: task.sha256,
    inputsSha256,
    projectRoot: project.projectRoot,
    snapshotSha: project.snapshotSha,
    searchEnabled: spec.search.enabled === true,
    resultKind: spec.resultKind,
  }));
}

export async function buildFusionRun(D, ctx, aggregate, payload, now) {
  let spec;
  try {
    spec = validateFusionSpec(payload.fusion);
  } catch (e) {
    throw wrapSpecError(D, e);
  }
  // Inputs: 'implementation' requires the approved requirements+plan pair
  // (same gate as solo); 'document' only pins the task document version.
  let inputs = {};
  let reqA = null;
  if (spec.resultKind === 'implementation') {
    const approved = await D.requireApprovedInputs(ctx, aggregate, 'start');
    reqA = approved.reqA;
    inputs = D.runInputsSnapshot(aggregate, approved.reqA, approved.planA);
  }
  const task = await resolveTaskBinding(D, ctx, aggregate,
    payload.fusion?.task, { reqA, requireTask: spec.resultKind === 'document' });
  inputs.task = task;
  const design = D.currentDesignInput?.(aggregate) ?? null;
  if (design) inputs.design = design;
  const project = await resolveProjectSnapshot(D, ctx, aggregate, payload, null);
  project.projectRoot = fusionProjectRoot(D, aggregate, payload.fusion);
  const inputsSha256 = spec.resultKind === 'implementation'
    ? sha256(canonicalJson(inputs)) : null;
  const fingerprint = computeFingerprint({ inputsSha256, task, project, spec });
  // F3: an implementation run inherits the core reviewer/checker gate —
  // the members are validated against the CLI-compat doc and snapshotted
  // into a synthetic composition so the U5 launch surface reads a shape
  // identical to a solo run's.
  let composition = null;
  let reviewRules = null;
  let review = null;
  if (spec.resultKind === 'implementation') {
    const compat = await ctx.compat();
    review = {
      reviewer: D.validateMember('reviewer', spec.review.reviewer, compat),
      checker: D.validateMember('checker', spec.review.checker, compat),
    };
    const presetLimits = { maxAttemptsPerRole: spec.limits.reviewAttemptsPerRole };
    composition = { preset: { members: review, limits: presetLimits } };
    reviewRules = D.snapshotReviewRules(await ctx.getDoc('roles.json'), presetLimits);
  }
  const run = {
    id: `run_${randomUUID()}`,
    mode: 'fusion',
    status: 'queued',
    phase: 'panel',
    createdAt: now,
    inputs,
    composition,
    reviewRules,
    baseRef: project.baseRef,
    baseCommit: project.snapshotSha,
    workspaceId: null,
    fusion: {
      resultKind: spec.resultKind,
      owner: null,
      fingerprint,
      snapshot: {
        task,
        project: { projectRoot: project.projectRoot, snapshotSha: project.snapshotSha },
        search: spec.search,
      },
      limits: spec.limits,
      participants: spec.participants.map(fusionParticipant),
      exclusions: [],
      pendingActions: [],
      status: 'open',
      judgeEligible: null,
      settledAt: null,
      // F3 handoff state — durable, never derived.
      judge: spec.judge,
      integrator: spec.integrator,
      review,
      workOrders: [],
      workOrder: null,
      integrate: null,
      integratorReport: null,
      fixAttempts: [],
    },
    attempts: [],
    result: null,
    events: [],
    eventsCursor: 0,
  };
  return run;
}

// A fusion continuation: SAME panel composition (copied from the
// predecessor — continue never re-specifies participants), re-resolved
// task/project snapshot, and R9 reuse: a participant's accepted answer
// carries forward ONLY when the new fingerprint equals the old AND the
// participant's profileDigest is unchanged. Exclusions persist across a
// continuation (the user's decision stands; a changed-input run simply
// launches no attempt for them).
export async function buildFusionContinuation(D, ctx, aggregate, payload, prev, now) {
  const fz = prev.fusion;
  // Inputs re-resolved the same way start resolves them — for
  // 'implementation' the CURRENTLY approved pair is mandatory again.
  let inputs = {};
  let reqA = null;
  if (fz.resultKind === 'implementation') {
    const approved = await D.requireApprovedInputs(ctx, aggregate, 'continue');
    reqA = approved.reqA;
    inputs = D.runInputsSnapshot(aggregate, approved.reqA, approved.planA);
  }
  let task;
  if (payload?.fusion?.task !== undefined) {
    // An explicit override re-pins the task to a CURRENT document version.
    task = await resolveTaskBinding(D, ctx, aggregate, payload.fusion.task, { reqA });
  } else if (reqA) {
    task = { kind: 'requirements', versionId: reqA.versionId, sha256: reqA.sha256 };
  } else {
    // The pinned binding carries forward verbatim — and must still verify.
    task = fz.snapshot?.task ?? null;
    if (!task) {
      throw new D.CommandError(422, 'task_unbound',
        'the continued panel carries no task binding');
    }
    await ctx.requireBlob(task.sha256, `${task.kind} task document`);
  }
  inputs.task = task;
  const design = D.currentDesignInput?.(aggregate) ?? null;
  if (design) inputs.design = design;
  const project = await resolveProjectSnapshot(D, ctx, aggregate, payload, prev.baseRef);
  project.projectRoot = fz.snapshot?.project?.projectRoot
    ?? fusionProjectRoot(D, aggregate, null);
  const inputsSha256 = fz.resultKind === 'implementation'
    ? sha256(canonicalJson(inputs)) : null;
  const fingerprint = computeFingerprint({
    inputsSha256, task, project,
    spec: { resultKind: fz.resultKind, search: fz.snapshot?.search ?? { enabled: false } },
  });
  // F3 handoff composition carries forward verbatim from the predecessor
  // (continue never re-specifies it); an implementation run re-validates
  // the review members against the CURRENT CLI-compat doc.
  let composition = null;
  let reviewRules = null;
  let review = null;
  if (fz.resultKind === 'implementation') {
    const compat = await ctx.compat();
    review = {
      reviewer: D.validateMember('reviewer', fz.review?.reviewer, compat),
      checker: D.validateMember('checker', fz.review?.checker, compat),
    };
    const presetLimits = { maxAttemptsPerRole: fz.limits?.reviewAttemptsPerRole ?? 2 };
    composition = { preset: { members: review, limits: presetLimits } };
    reviewRules = D.snapshotReviewRules(await ctx.getDoc('roles.json'), presetLimits);
  }
  const reuse = fingerprint === fz.fingerprint;
  const participants = (fz.participants || []).map((p) => {
    const next = fusionParticipant({
      id: p.id, label: p.label, profileId: p.profileId,
      provider: p.provider, model: p.model,
      profileDigest: p.profileDigest, profile: p.profile,
    });
    if (p.status === 'excluded') {
      next.status = 'excluded';
      next.exclusion = { ...(p.exclusion ?? {}), carriedFrom: prev.id };
      return next;
    }
    if (reuse && p.status === 'answered' && p.answer
      && p.profileDigest === next.profileDigest) {
      next.status = 'answered';
      next.answer = {
        ...structuredClone(p.answer),
        reusedFrom: { runId: prev.id, attemptId: p.answer.attemptId ?? null },
      };
    }
    return next;
  });
  const run = {
    id: `run_${randomUUID()}`,
    mode: 'fusion',
    status: 'queued',
    phase: 'panel',
    createdAt: now,
    inputs,
    composition,
    reviewRules,
    baseRef: project.baseRef,
    baseCommit: project.snapshotSha,
    workspaceId: null,
    fusion: {
      resultKind: fz.resultKind,
      owner: null,
      fingerprint,
      snapshot: {
        task,
        project: { projectRoot: project.projectRoot, snapshotSha: project.snapshotSha },
        search: structuredClone(fz.snapshot?.search ?? { enabled: false }),
      },
      limits: structuredClone(fz.limits ?? {}),
      participants,
      exclusions: (fz.exclusions || []).map((x) => ({ ...structuredClone(x), carriedFrom: prev.id })),
      pendingActions: [],
      status: 'open',
      judgeEligible: null,
      settledAt: null,
      continuedFrom: prev.id,
      inputReused: reuse,
      // F3: same judge/integrator/review composition as the predecessor;
      // work orders never carry — a new panel deserves a new judgement.
      judge: structuredClone(fz.judge ?? null),
      integrator: structuredClone(fz.integrator ?? null),
      review,
      workOrders: [],
      workOrder: null,
      integrate: null,
      integratorReport: null,
      fixAttempts: [],
    },
    attempts: [],
    result: null,
    events: [],
    eventsCursor: 0,
  };
  return run;
}

// ---- derived panel state (durable fields) ------------------------------------

// pendingActions + coarse fusion.status are written durably whenever a
// participant moves — a restart/crash can never lose the "a decision is
// owed" marker. Terminal fusion.status values are set by panel_settle
// only; transitions here never overwrite them.
export function syncPanelDerived(run) {
  const fz = run.fusion;
  const pending = (fz.participants || [])
    .filter((p) => p.status === 'awaiting_decision').map((p) => p.id);
  // Non-participant actions (work-order approval, behavior change) are
  // written by the F3 handoff and must survive a participant sync.
  const keep = (fz.pendingActions || [])
    .filter((a) => a && a.type && a.type !== 'participant_decision');
  fz.pendingActions = [
    ...keep,
    ...pending.map((id) => ({ type: 'participant_decision', participantId: id })),
  ];
  if (fz.status !== 'complete' && fz.status !== 'quorum_failed' && fz.status !== 'cancelled') {
    fz.status = pending.length ? 'decision_pending' : 'open';
  }
}

function participantOf(run, participantId) {
  const p = (run.fusion?.participants || []).find((x) => x && x.id === participantId);
  return p ?? null;
}

// resolve_attempt hook: fold the terminal outcome into the participant.
// 'completed' carries a validated answer descriptor; anything else
// consumes the attempt — the participant drops to 'pending' while its
// budget lasts, 'awaiting_decision' once exhausted (never an automatic
// third attempt).
export function onPanelistResolved(D, run, att, outcome, answer, payload, now) {
  const p = participantOf(run, att.participantId);
  if (!p) {
    throw new D.CommandError(422, 'participant_unknown',
      `attempt ${att.id} names unknown participant ${att.participantId}`);
  }
  if (outcome === 'completed') {
    p.status = 'answered';
    p.answer = {
      attemptId: att.id,
      artifactId: answer.artifactId,
      sha256: answer.sha256,
      bytes: answer.bytes,
      sections: answer.sections,
      model: p.model,
      profileDigest: p.profileDigest,
      at: now,
    };
    p.lastError = null;
  } else {
    p.status = participantAttemptsLeft(run, p) ? 'pending' : 'awaiting_decision';
    p.lastError = {
      outcome,
      reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 300) : null,
      attemptId: att.id,
      at: now,
    };
  }
  syncPanelDerived(run);
}

// Validate the answer descriptor presented on a 'completed' panelist
// resolve: shape, hash format, and a HARD binding to a committed,
// hash-verified artifact owned by this attempt.
export function checkPanelAnswer(D, run, att, answer) {
  const v = validateRecordedAnswer(answer);
  if (!v.ok) {
    throw new D.CommandError(422, 'answer_invalid',
      `panel answer invalid: ${v.problems.join('; ')}`, { problems: v.problems });
  }
  const art = run.artifacts?.[answer.artifactId];
  if (!art || art.attemptId !== att.id
    || art.sha256 !== answer.sha256 || art.bytes !== answer.bytes) {
    throw new D.CommandError(422, 'answer_unbound',
      'answer.artifactId must reference this attempt\'s committed answer artifact with identical sha256/bytes');
  }
}

// ---- F3: judge / work order / integrator -------------------------------------

export function handoffAttempts(run, role) {
  return (run?.attempts || []).filter((a) => a && a.role === role);
}

// The current work-order record — the only version downstream decisions
// may bind (an older version is historical evidence, never approvable).
export function currentWorkOrder(run) {
  const list = run?.fusion?.workOrders || [];
  return list.length ? list[list.length - 1] : null;
}

// Validate + hard-bind the work-order descriptor on a 'completed' judge
// resolve — and re-parse the committed artifact bytes so the controller's
// parse result is never the proof.
export async function checkJudgeWorkOrder(D, ctx, run, att, wo) {
  const v = validateRecordedWorkOrder(wo);
  if (!v.ok) {
    throw new D.CommandError(422, 'work_order_invalid',
      `work order invalid: ${v.problems.join('; ')}`, { problems: v.problems });
  }
  const art = run.artifacts?.[wo.artifactId];
  if (!art || art.attemptId !== att.id || art.kind !== 'work-order'
    || art.sha256 !== wo.sha256 || art.bytes !== wo.bytes) {
    throw new D.CommandError(422, 'work_order_unbound',
      'workOrder.artifactId must reference this attempt\'s committed work-order artifact with identical sha256/bytes');
  }
  const { text } = await ctx.readArtifactText(run.id, art.stored ?? art.file);
  const parsed = parseWorkOrder(text);
  if (!parsed.ok) {
    throw new D.CommandError(422, 'work_order_invalid',
      `committed work-order artifact fails the contract: ${parsed.reason}`
        + `${parsed.problems?.length ? ` (${parsed.problems.join('; ')})` : ''}`,
      { problems: parsed.problems ?? [] });
  }
  if (parsed.verdict !== wo.verdict) {
    throw new D.CommandError(422, 'work_order_mismatch',
      `workOrder.verdict ${wo.verdict} does not match the artifact verdict ${parsed.verdict}`);
  }
  return parsed;
}

// Routing decision once a work order is minted — deterministic from the
// durable record only:
//   document        → park for user acceptance (never auto-approves).
//   implementation  → 'in_plan' + unchanged approved inputs auto-routes to
//                     the integrator; anything else parks for the user —
//                     including a scope_change/uncertain verdict and a
//                     requirements/plan drift since the run started.
export function routeWorkOrder(D, aggregate, run, wo, now) {
  const fz = run.fusion;
  // A freshly minted version replaces every prior work-order pending
  // action — only the CURRENT version is ever approvable.
  fz.pendingActions = (fz.pendingActions || [])
    .filter((a) => !(a && a.type === 'work_order_approval'));
  if (fz.resultKind === 'document') {
    wo.decision = { routed: 'user', reason: 'acceptance', at: now };
    (fz.pendingActions ??= []).push(
      { type: 'work_order_approval', versionId: wo.versionId, reason: 'acceptance' });
    run.status = 'blocked';
    run.finishedAt = now;
    run.error = 'work order awaiting user acceptance';
    return;
  }
  const reqNow = aggregate.approvals?.requirements ?? null;
  const planNow = aggregate.approvals?.plan ?? null;
  const inputsUnchanged = !!reqNow && !!planNow
    && !!run.inputs?.requirements && !!run.inputs?.plan
    && reqNow.versionId === run.inputs.requirements.versionId
    && reqNow.sha256 === run.inputs.requirements.sha256
    && planNow.versionId === run.inputs.plan.versionId
    && planNow.sha256 === run.inputs.plan.sha256;
  if (wo.verdict === 'in_plan' && inputsUnchanged) {
    wo.decision = { routed: 'auto', reason: 'in_plan', at: now };
    fz.integrate = {
      workOrderVersionId: wo.versionId,
      workOrderSha256: wo.sha256,
      canonicalId: null,
      import: null,
      auto: true,
      at: now,
    };
    run.status = 'active';
    run.phase = 'integrate';
    run.error = null;
    return;
  }
  const reason = wo.verdict === 'in_plan' ? 'inputs_changed' : wo.verdict;
  wo.decision = { routed: 'user', reason, at: now };
  (fz.pendingActions ??= []).push(
    { type: 'work_order_approval', versionId: wo.versionId, reason });
  run.status = 'blocked';
  run.finishedAt = now;
  run.error = reason === 'inputs_changed'
    ? 'work order is in-plan, but requirements/plan changed since start — approval of the current version is required'
    : `work order verdict ${wo.verdict} — explicit user approval required`;
}

// resolve_attempt hook for the judge. A 'completed' resolve carries the
// bound+parsed work order (checkJudgeWorkOrder ran first) and mints the
// next durable version; every other outcome only consumes the attempt.
export function onJudgeResolved(D, aggregate, run, att, outcome, wo, parsed, now) {
  if (outcome !== 'completed') return;
  const fz = run.fusion;
  const versionId = `wo_v${(fz.workOrders || []).length + 1}`;
  const launchInputs = new Map((att.launch?.inputs || []).map((i) => [i.name, i.sha256]));
  const entry = {
    versionId,
    artifactId: wo.artifactId,
    sha256: wo.sha256,
    bytes: wo.bytes,
    verdict: parsed.verdict,
    sections: parsed.sections,
    steps: parsed.steps,
    affectedParts: parsed.affectedParts,
    criteria: parsed.criteria,
    // Provenance: the work order binds the exact inputs it judged —
    // the pinned task document, the chosen project snapshot, the answers
    // bundle sha, the rubric sha, and the result kind.
    inputs: {
      taskSha256: launchInputs.get('task') ?? null,
      answersSha256: launchInputs.get('answers') ?? null,
      rubricSha256: launchInputs.get('rubric') ?? null,
      snapshotSha: fz.snapshot?.project?.snapshotSha ?? null,
      resultKind: fz.resultKind,
    },
    attemptId: att.id,
    at: now,
    approved: null,
    decision: null,
  };
  (fz.workOrders ??= []).push(entry);
  att.result = {
    kind: 'work-order', versionId, artifactId: wo.artifactId,
    sha256: wo.sha256, verdict: parsed.verdict,
  };
  routeWorkOrder(D, aggregate, run, entry, now);
}

// Validate + bind the integrator report descriptor on a 'completed'
// integrator resolve; returns the re-parsed report.
export async function checkIntegratorReport(D, ctx, run, att, report) {
  const v = validateRecordedReport(report);
  if (!v.ok) {
    throw new D.CommandError(422, 'report_invalid',
      `integrator report invalid: ${v.problems.join('; ')}`, { problems: v.problems });
  }
  const art = run.artifacts?.[report.artifactId];
  if (!art || art.attemptId !== att.id || art.kind !== 'integrator-report'
    || art.sha256 !== report.sha256 || art.bytes !== report.bytes) {
    throw new D.CommandError(422, 'report_unbound',
      'report.artifactId must reference this attempt\'s committed integrator-report artifact with identical sha256/bytes');
  }
  const { text } = await ctx.readArtifactText(run.id, art.stored ?? art.file);
  const parsed = parseIntegratorReport(text);
  if (!parsed.ok) {
    throw new D.CommandError(422, 'report_invalid',
      `committed integrator-report artifact fails the contract: ${parsed.reason}`
        + `${parsed.problems?.length ? ` (${parsed.problems.join('; ')})` : ''}`,
      { problems: parsed.problems ?? [] });
  }
  if (parsed.behaviorChange !== report.behaviorChange) {
    throw new D.CommandError(422, 'report_mismatch',
      'report.behaviorChange does not match the committed artifact');
  }
  return parsed;
}

// resolve_attempt hook for the integrator. 'completed' records the report
// durably (mismatches + behavior-change flag are judge-facing evidence);
// the driver then performs the canonical import and records the result.
export function onIntegratorResolved(D, run, att, outcome, report, parsed, now) {
  if (outcome !== 'completed') return;
  const fz = run.fusion;
  fz.integratorReport = {
    attemptId: att.id,
    artifactId: report.artifactId,
    sha256: report.sha256,
    bytes: report.bytes,
    changes: parsed.sections.changes,
    mismatches: parsed.mismatches,
    behaviorChange: parsed.behaviorChange,
    fix: att.fix ?? null,
    at: now,
  };
  att.result = {
    kind: 'integrator-report', artifactId: report.artifactId, sha256: report.sha256,
    behaviorChange: parsed.behaviorChange,
  };
  // A completed fix attempt consumed the recorded fixContext — same rule
  // as the solo implementer: the context stays only as evidence while the
  // run re-enters validation for the new round.
  if (att.fix !== undefined && att.fix !== null) run.fixContext = null;
}

// The panel-evidence blocklist: sha256 of EVERY artifact committed by a
// panelist attempt on this run — answers AND any panel logs/evidence.
// This is the hard boundary the integrator can never cross: its declared
// input hashes are checked against this set at mint time, so no panel
// material can reach it by content-address.
function panelArtifactShas(run) {
  const panelistAtts = new Set(
    (run?.attempts || []).filter((a) => a && a.role === 'panelist').map((a) => a.id));
  const out = new Set();
  for (const art of Object.values(run?.artifacts || {})) {
    if (art && panelistAtts.has(art.attemptId) && typeof art.sha256 === 'string') {
      out.add(art.sha256);
    }
  }
  return out;
}

// Shared authority + slot accounting for judge_begin/integrate_begin —
// identical rules to panel_begin: the attempt is durable before any
// runtime call, the fusion owner (or the live attempt's owner) is the
// only minter, global+role caps come from the scheduler limits doc.
async function handoffSlotCheck(D, ctx, aggregate, run, role) {
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
      if (r?.validation && (r.validation.status === 'active' || r.validation.status === 'unproven')) {
        runActive = true;
      }
      if (runActive) globalActive += 1;
    }
  }
  const thisRunActive = (run.attempts || []).some((a) => a && D.ATTEMPT_NONTERMINAL.has(a.status));
  const ownUnit = thisRunActive ? 1 : 0;
  if (globalActive - ownUnit >= limits.global) {
    throw new D.CommandError(409, 'limit_reached',
      `global attempt limit reached (${globalActive}/${limits.global})`,
      { scope: 'global', active: globalActive, limit: limits.global });
  }
  const roleCap = limits.roles?.[role] ?? 1;
  if (roleActive >= roleCap) {
    throw new D.CommandError(409, 'limit_reached',
      `${role} attempt limit reached (${roleActive}/${roleCap})`,
      { scope: 'role', role, active: roleActive, limit: roleCap });
  }
  return { limits, globalActive, roleActive, roleCap };
}

// Shared launch-record validation — the profile digest binds to the
// RECORDED role spec, prompt/material digests must be sha256, dirs
// absolute. `spec` is the run.fusion.<role> entry.
function checkHandoffLaunch(D, launch, spec, role) {
  if (!isObj(launch)) {
    throw new D.CommandError(422, 'invalid_argument', 'payload.launch must be an object');
  }
  if (typeof launch.profileId !== 'string' || !SAFE_ID_RE.test(launch.profileId)
    || launch.profileId !== spec.profileId) {
    throw new D.CommandError(422, 'invalid_argument',
      `launch.profileId must equal the recorded ${role} profileId`);
  }
  if (typeof launch.profileDigest !== 'string' || !D.SHA256_RE.test(launch.profileDigest)) {
    throw new D.CommandError(422, 'invalid_argument', 'launch.profileDigest must be a sha256 hex');
  }
  if (launch.profileDigest !== spec.profileDigest) {
    throw new D.CommandError(409, 'profile_digest_mismatch',
      `launch digest does not match the recorded ${role} profile — the run launches the recorded composition only`);
  }
  for (const k of ['promptSha256', 'materialsSha256']) {
    if (typeof launch[k] !== 'string' || !D.SHA256_RE.test(launch[k])) {
      throw new D.CommandError(422, 'invalid_argument', `launch.${k} must be a sha256 hex`);
    }
  }
  for (const k of ['cwd', 'artifactsDir', 'attemptDir']) {
    if (typeof launch[k] !== 'string' || !launch[k].startsWith('/')) {
      throw new D.CommandError(422, 'invalid_argument', `launch.${k} must be an absolute path`);
    }
    launch[k] = D.normPath(launch[k]);
  }
  if (launch.workerId !== undefined
    && (typeof launch.workerId !== 'string' || !SAFE_ID_RE.test(launch.workerId))) {
    throw new D.CommandError(422, 'invalid_argument', `launch.workerId must match ${SAFE_ID_RE}`);
  }
}

// Declared launch inputs: every entry is {name, sha256} — the name must be
// whitelisted, the sha must bind to the recorded durable source (never a
// caller claim). `bind` maps input name → required sha256 | null
// (null = record-only). answerShas is the hard integrator boundary.
function checkHandoffInputs(D, launch, allowed, bind, answerShas, role) {
  const inputs = launch.inputs;
  if (!Array.isArray(inputs)) {
    throw new D.CommandError(422, 'invalid_argument', 'launch.inputs must be an array');
  }
  for (const inp of inputs) {
    if (!isObj(inp) || typeof inp.name !== 'string' || !allowed.has(inp.name)) {
      throw new D.CommandError(422, 'invalid_argument',
        `${role} input ${JSON.stringify(inp?.name)} is not declared for this role`);
    }
    if (typeof inp.sha256 !== 'string' || !D.SHA256_RE.test(inp.sha256)) {
      throw new D.CommandError(422, 'invalid_argument',
        `${role} input ${inp.name}.sha256 must be a sha256 hex`);
    }
    const want = bind.get(inp.name);
    if (want !== undefined && want !== null && want !== inp.sha256) {
      throw new D.CommandError(409, 'input_sha_mismatch',
        `${role} input ${inp.name} sha256 does not match the recorded source — launch binds the durable bytes only`);
    }
    if (answerShas.has(inp.sha256)) {
      // R2/KTD4: a declared integrator input whose bytes equal ANY panel
      // answer artifact is panel evidence — refused regardless of name.
      throw new D.CommandError(409, 'panel_evidence_forbidden',
        `${role} input ${inp.name} binds to a panel-answer artifact — the integrator never reads the panel`);
    }
  }
}

function mintHandoffAttempt(D, run, payload, role, phase, n, leaseMs, now, extra = {}) {
  const attemptId = D.reqStr(payload.attemptId, 'attemptId');
  if (!SAFE_ID_RE.test(attemptId)) {
    throw new D.CommandError(422, 'invalid_argument', `attemptId must match ${SAFE_ID_RE}`);
  }
  const attempt = {
    id: attemptId,
    runId: run.id,
    role,
    phase,
    n,
    status: 'launching',
    owner: D.newOwner(payload, now, leaseMs),
    launch: payload.launch,
    porchRunId: null,
    workspaceId: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    outcome: null,
    error: null,
    ...extra,
  };
  run.attempts.push(attempt);
  return attempt;
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
            `attemptId ${attemptId} is already recorded on card ${other.cardId} run ${r.id}`);
        }
      }
    }
  }
}

// judge_begin — the ONLY way a judge attempt enters the durable record.
// Authority: the fusion owner (or the live judge attempt's owner). The
// judge launches only while the run sits in phase 'judge'.
export async function cmdJudgeBegin(D, ctx, aggregate, payload, now) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  if (!['queued', 'active'].includes(run.status)) {
    throw new D.CommandError(409, 'run_not_launchable',
      `run ${run.id} is ${run.status} — the judge launches only from queued|active`);
  }
  if (run.phase !== 'judge') {
    throw new D.CommandError(409, 'phase_mismatch',
      `the judge launches only in phase 'judge' — run is ${run.phase}`);
  }
  const fz = run.fusion;
  if (!fz.judge) {
    throw new D.CommandError(422, 'judge_unconfigured', `run ${run.id} carries no judge profile`);
  }
  const liveJudge = handoffAttempts(run, 'judge')
    .find((a) => D.ATTEMPT_NONTERMINAL.has(a.status));
  const auth = liveJudge
    ? D.ownsResource(liveJudge.owner, payload)
    : (fz.owner && D.ownsResource(fz.owner, payload));
  if (!auth) {
    throw new D.CommandError(409, 'not_panel_owner',
      'judge_begin requires the run\u2019s fusion owner instance');
  }
  if (liveJudge) {
    throw new D.CommandError(409, 'attempt_active',
      `judge attempt ${liveJudge.id} is ${liveJudge.status} — resolve it first`);
  }
  const used = handoffAttempts(run, 'judge').length;
  const limit = fz.limits?.judgeAttempts ?? 2;
  if (used >= limit) {
    throw new D.CommandError(409, 'attempts_exhausted',
      `judge used ${used}/${limit} attempts`,
      { used, limit });
  }
  const attemptId = D.reqStr(payload.attemptId, 'attemptId');
  await assertFreshAttemptId(D, ctx, aggregate, attemptId);
  const slots = await handoffSlotCheck(D, ctx, aggregate, run, 'judge');
  checkHandoffLaunch(D, payload.launch, fz.judge, 'judge');
  checkHandoffInputs(D, payload.launch, JUDGE_INPUTS, new Map([
    ['task', fz.snapshot?.task?.sha256 ?? null],
    ['rubric', sha256(WORK_ORDER_RUBRIC)],
    ['answers', null],
  ]), new Set(), 'judge');
  const leaseMs = D.clampLeaseMs(payload.leaseMs);
  const att = mintHandoffAttempt(D, run, payload, 'judge', 'judge', used + 1, leaseMs, now);
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: {
      attemptId: att.id, runId: run.id, status: att.status,
      slots: {
        global: { active: slots.globalActive + 1, limit: slots.limits.global },
        role: { role: 'judge', active: slots.roleActive + 1, limit: slots.roleCap },
      },
    },
  };
}

// integrate_begin — the ONLY way an integrator attempt enters the record.
// Phase 'integrate' (initial work) or 'awaiting_validation' with a
// recorded fixContext (the fix attempt — marked attempt.fix = round).
export async function cmdIntegrateBegin(D, ctx, aggregate, payload, now) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  if (!['queued', 'active'].includes(run.status)) {
    throw new D.CommandError(409, 'run_not_launchable',
      `run ${run.id} is ${run.status} — the integrator launches only from queued|active`);
  }
  const fz = run.fusion;
  if (!fz.integrator) {
    throw new D.CommandError(422, 'integrator_unconfigured', `run ${run.id} carries no integrator profile`);
  }
  const isFix = payload.fix === true;
  if (run.phase === 'integrate') {
    if (isFix) {
      throw new D.CommandError(422, 'invalid_argument',
        'a fix attempt launches only from awaiting_validation with a recorded fixContext');
    }
  } else if (run.phase === 'awaiting_validation' && run.fixContext) {
    if (!isFix) {
      throw new D.CommandError(422, 'invalid_argument',
        'payload.fix must be true for the fix-cycle integrator attempt');
    }
  } else {
    throw new D.CommandError(409, 'phase_mismatch',
      `the integrator launches in phase 'integrate' (or a recorded fix round) — run is ${run.phase}`);
  }
  // The work order binds EVERY integrator attempt — initial and fix.
  const woReq = isObj(payload.workOrder) ? payload.workOrder : null;
  const curWo = currentWorkOrder(run);
  if (!curWo) {
    throw new D.CommandError(409, 'work_order_missing', `run ${run.id} has no work order yet`);
  }
  if (!woReq || woReq.versionId !== curWo.versionId) {
    throw new D.CommandError(409, 'work_order_stale',
      `integrate_begin must bind the current work order ${curWo.versionId} — got ${woReq?.versionId ?? 'none'}`);
  }
  if (woReq.sha256 !== curWo.sha256) {
    throw new D.CommandError(409, 'hash_mismatch',
      'workOrder.sha256 does not match the current work-order record');
  }
  if (!isFix && (!fz.integrate || fz.integrate.workOrderVersionId !== curWo.versionId)) {
    // Routing to the integrator requires the routing record — the run
    // must have been auto-routed (in_plan) or explicitly approved first.
    throw new D.CommandError(409, 'work_order_unapproved',
      `work order ${curWo.versionId} has not been routed to the integrator — approval is required first`);
  }
  const liveInt = handoffAttempts(run, 'integrator')
    .find((a) => D.ATTEMPT_NONTERMINAL.has(a.status));
  const auth = liveInt
    ? D.ownsResource(liveInt.owner, payload)
    : (fz.owner && D.ownsResource(fz.owner, payload));
  if (!auth) {
    throw new D.CommandError(409, 'not_panel_owner',
      'integrate_begin requires the run\u2019s fusion owner instance');
  }
  if (liveInt) {
    throw new D.CommandError(409, 'attempt_active',
      `integrator attempt ${liveInt.id} is ${liveInt.status} — resolve it first`);
  }
  const integAttempts = handoffAttempts(run, 'integrator');
  if (isFix) {
    // One fix attempt per recorded fixContext — the round gate already
    // bounds the cycles; a failed fix terminalizes the run.
    const round = run.fixContext?.round;
    if ((fz.fixAttempts || []).includes(round)) {
      throw new D.CommandError(409, 'fix_attempt_exists',
        `the fix attempt for round ${round} was already consumed`);
    }
  } else {
    const used = integAttempts.filter((a) => !a.fix).length;
    const limit = fz.limits?.integratorAttempts ?? 2;
    if (used >= limit) {
      throw new D.CommandError(409, 'attempts_exhausted',
        `integrator used ${used}/${limit} attempts`, { used, limit });
    }
  }
  const attemptId = D.reqStr(payload.attemptId, 'attemptId');
  await assertFreshAttemptId(D, ctx, aggregate, attemptId);
  const slots = await handoffSlotCheck(D, ctx, aggregate, run, 'integrator');
  checkHandoffLaunch(D, payload.launch, fz.integrator, 'integrator');
  // Canonical binding: first mint wins, later attempts must match — the
  // private-repo ↔ canonical pairing survives restart without re-import.
  const cid = payload.launch.canonicalId;
  if (typeof cid !== 'string' || !SAFE_ID_RE.test(cid)) {
    throw new D.CommandError(422, 'invalid_argument', `launch.canonicalId must match ${SAFE_ID_RE}`);
  }
  if (fz.integrate?.canonicalId && fz.integrate.canonicalId !== cid) {
    throw new D.CommandError(409, 'canonical_mismatch',
      `canonicalId ${cid} does not match the recorded binding ${fz.integrate.canonicalId}`);
  }
  // Input bindings: task → pinned task doc sha, work-order → the current
  // WO artifact sha, source docs → the run's recorded input shas.
  const bind = new Map([
    ['task', fz.snapshot?.task?.sha256 ?? null],
    ['work-order', curWo.sha256],
    ['requirements', run.inputs?.requirements?.sha256 ?? null],
    ['plan', run.inputs?.plan?.sha256 ?? null],
    ['design', run.inputs?.design?.sha256 ?? null],
    ['results', null],
  ]);
  checkHandoffInputs(D, payload.launch, INTEGRATOR_INPUTS, bind, panelArtifactShas(run), 'integrator');
  const leaseMs = D.clampLeaseMs(payload.leaseMs);
  const extra = isFix ? { fix: run.fixContext.round } : {};
  const att = mintHandoffAttempt(D, run, payload, 'integrator', 'integrate',
    integAttempts.length + 1, leaseMs, now, extra);
  if (isFix) (fz.fixAttempts ??= []).push(run.fixContext.round);
  if (fz.integrate && !fz.integrate.canonicalId) fz.integrate.canonicalId = cid;
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: {
      attemptId: att.id, runId: run.id, status: att.status, fix: isFix,
      slots: {
        global: { active: slots.globalActive + 1, limit: slots.limits.global },
        role: { role: 'integrator', active: slots.roleActive + 1, limit: slots.roleCap },
      },
    },
  };
}

// record_integrate_result — lands after the controller imported the
// integrator's private repo into the canonical worktree and materialized
// it into the bound workspace. The run then rides the U5 gate.
export async function cmdRecordIntegrateResult(D, ctx, aggregate, payload, now) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  // The initial integrate records from phase 'integrate'; a fix attempt's
  // import records from 'awaiting_validation' (resolve consumed the
  // fixContext already — the round is open).
  const att = (run.attempts || []).find(
    (a) => a && a.id === D.reqStr(payload.attemptId, 'attemptId'));
  const isFix = att?.fix !== undefined && att?.fix !== null;
  const wantPhase = isFix ? 'awaiting_validation' : 'integrate';
  if (run.status !== 'active' || run.phase !== wantPhase) {
    throw new D.CommandError(409, 'phase_mismatch',
      `record_integrate_result requires active+${wantPhase} — run is ${run.status}/${run.phase}`);
  }
  const fz = run.fusion;
  const lastAtt = (run.attempts || [])[run.attempts.length - 1] ?? null;
  const auth = (fz.owner && D.ownsResource(fz.owner, payload))
    || (lastAtt && D.ownsResource(lastAtt.owner, payload));
  if (!auth) {
    throw new D.CommandError(409, 'not_panel_owner',
      'record_integrate_result requires the run\u2019s fusion owner instance');
  }
  if (!att || att.role !== 'integrator' || att.status !== 'completed') {
    throw new D.CommandError(422, 'integrate_unproven',
      'record_integrate_result names a completed integrator attempt — none found');
  }
  const imp = isObj(payload.import) ? payload.import : null;
  if (!imp || typeof imp.commitSha !== 'string' || !imp.commitSha.length
    || imp.commitSha.length > 128) {
    throw new D.CommandError(422, 'invalid_argument', 'import.commitSha must be a non-empty string');
  }
  if (imp.treeSha !== undefined
    && (typeof imp.treeSha !== 'string' || !imp.treeSha.length || imp.treeSha.length > 128)) {
    throw new D.CommandError(422, 'invalid_argument', 'import.treeSha must be a non-empty string');
  }
  fz.integrate ??= {};
  fz.integrate.import = {
    attemptId: att.id,
    fix: isFix ? att.fix : null,
    canonicalId: att.launch?.canonicalId ?? fz.integrate.canonicalId ?? null,
    treeSha: imp.treeSha ?? null,
    commitSha: imp.commitSha,
    changed: imp.changed === true,
    diffStat: typeof imp.diffStat === 'string' ? imp.diffStat.slice(0, 4000) : null,
    at: now,
  };
  // A declared behavior change parks for the user BEFORE validation —
  // the imported result never gates silently. Bound to THIS attempt's
  // recorded report — never an older or newer one.
  if (fz.integratorReport?.attemptId === att.id
    && fz.integratorReport?.behaviorChange === true) {
    const cur = currentWorkOrder(run);
    const already = (fz.pendingActions || []).some(
      (a) => a && a.type === 'work_order_approval' && a.versionId === cur?.versionId);
    if (!already && cur) {
      (fz.pendingActions ??= []).push(
        { type: 'work_order_approval', versionId: cur.versionId, reason: 'behavior_change' });
    }
    run.status = 'blocked';
    run.finishedAt = now;
    run.error = 'integrator declared a behavior change — user approval required before verification';
    D.stageRun(aggregate, run, ctx);
    return { aggregate, refreshProjection: true, result: { runId: run.id, status: 'blocked' } };
  }
  run.status = 'active';
  run.phase = 'awaiting_validation';
  run.error = null;
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: { runId: run.id, status: run.status, phase: run.phase },
  };
}

// annul_acceptance — the workspace's result hash drifted after the gate
// already parked the run at awaiting_acceptance (a new edit landed). The
// recorded gate stays as evidence; the run re-enters validation honestly.
export async function cmdAnnulAcceptance(D, ctx, aggregate, payload, now) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  if (run.status !== 'awaiting_acceptance') {
    throw new D.CommandError(409, 'acceptance_state',
      `run ${run.id} is ${run.status} — only awaiting_acceptance can be annulled`);
  }
  const fz = run.fusion;
  const lastAtt = (run.attempts || [])[run.attempts.length - 1] ?? null;
  const auth = (fz.owner && D.ownsResource(fz.owner, payload))
    || (lastAtt && D.ownsResource(lastAtt.owner, payload));
  if (!auth) {
    throw new D.CommandError(409, 'not_panel_owner',
      'annul_acceptance requires the run\u2019s fusion owner instance');
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
  const ev = {
    seq: run.eventsCursor ?? 0, at: now, type: 'acceptance_annulled',
    data: { priorSha256: prior?.resultSha256 ?? null, round: prior?.round ?? null },
  };
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push(ev);
  run.eventsCursor = (run.eventsCursor ?? 0) + 1;
  ctx.appendRunEvent(run.id, run.events);
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: { runId: run.id, status: run.status, phase: run.phase },
  };
}

// ---- user commands (F3) -------------------------------------------------------

// approve_work_order — the user's acceptance of the CURRENT work order.
// Document runs complete here; implementation runs route to the
// integrator (or resume verification after a declared behavior change).
// The binding is exact: only the version the run is currently waiting on
// is approvable — a stale versionId or hash refuses.
export async function cmdApproveWorkOrder(D, ctx, aggregate, payload, now) {
  const run = fusionRunForDecision(D, aggregate, payload);
  const fz = run.fusion;
  const versionId = D.reqStr(payload.versionId, 'versionId');
  const wantSha = D.reqStr(payload.sha256, 'sha256');
  const wo = (fz.workOrders || []).find((w) => w && w.versionId === versionId);
  if (!wo) {
    throw new D.CommandError(404, 'work_order_not_found',
      `work order ${JSON.stringify(versionId)} is not recorded on run ${run.id}`);
  }
  if (wo.sha256 !== wantSha) {
    throw new D.CommandError(409, 'hash_mismatch',
      'workOrder.sha256 does not match the recorded version');
  }
  const pending = (fz.pendingActions || []).find(
    (a) => a && a.type === 'work_order_approval' && a.versionId === versionId);
  if (!pending) {
    const other = (fz.pendingActions || []).find(
      (a) => a && a.type === 'work_order_approval');
    throw new D.CommandError(409, other ? 'stale_version' : 'no_pending_approval',
      other
        ? `the run awaits approval of ${other.versionId} — ${versionId} is not the current version`
        : `run ${run.id} is not waiting on a work-order approval`);
  }
  const reason = pending.reason;
  fz.pendingActions = (fz.pendingActions || [])
    .filter((a) => !(a && a.type === 'work_order_approval' && a.versionId === versionId));
  wo.approved = { at: now, by: 'user' };
  fz.workOrder = { versionId, sha256: wo.sha256, approvedAt: now, by: 'user', reason };
  run.error = null;
  if (fz.resultKind === 'document') {
    // The accepted work order IS the document result — it never becomes
    // an approved plan, it just lands as the run result.
    run.status = 'succeeded';
    run.finishedAt = now;
    run.result = {
      kind: 'document',
      workOrder: { versionId, sha256: wo.sha256 },
      at: now,
    };
  } else if (reason === 'behavior_change') {
    // The imported result was already staged; approval resumes the gate.
    run.status = 'active';
    run.phase = 'awaiting_validation';
  } else {
    run.status = 'active';
    run.phase = 'integrate';
    fz.integrate = {
      workOrderVersionId: versionId,
      workOrderSha256: wo.sha256,
      canonicalId: null,
      import: null,
      auto: false,
      at: now,
    };
  }
  D.stageRun(aggregate, run, ctx);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      runId: run.id, status: run.status, phase: run.phase ?? null,
      workOrder: { versionId, sha256: wo.sha256, reason },
    },
  };
}

// Run-level execution authority for fusion — the workspace-owner analog.
// A run with zero attempts (a composition rejected before first launch,
// or a pre-launch stop) can still be completed/settled by its claimed
// owner. Adoption takes the same structured proof as attempts.
export async function cmdPanelClaim(D, ctx, aggregate, payload, now) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  if (!D.RUN_NONTERMINAL.has(run.status)) {
    throw new D.CommandError(409, 'run_terminal', `run ${run.id} is ${run.status}`);
  }
  const fz = run.fusion;
  const leaseMs = D.clampLeaseMs(payload.leaseMs);
  if (!fz.owner) {
    fz.owner = D.newOwner(payload, now, leaseMs);
    D.stageRun(aggregate, run, ctx);
    return { aggregate, result: { runId: run.id, claimed: true } };
  }
  if (D.ownsResource(fz.owner, payload)) {
    fz.owner.leaseUntil = now + leaseMs;
    D.stageRun(aggregate, run, ctx);
    return { aggregate, result: { runId: run.id, claimed: true, renewed: true } };
  }
  if (payload.adopt !== true) {
    throw new D.CommandError(409, 'not_panel_owner',
      `run ${run.id} panel is owned by another runner instance — adopt with proof first`);
  }
  const envs = ctx.loadEnvironments ? await ctx.loadEnvironments() : null;
  D.checkAdoptionProof(fz, payload, envs);
  const prevOwner = fz.owner;
  fz.owner = D.newOwner(payload, now, leaseMs, prevOwner?.runnerId ?? null);
  (fz.adoptions ??= []).push({
    kind: payload.proof?.kind ?? null,
    from: {
      runnerId: prevOwner?.runnerId ?? null,
      instanceId: prevOwner?.instanceId ?? null,
      pid: prevOwner?.pid ?? null,
      envKey: prevOwner?.envKey ?? null,
      envInstance: prevOwner?.envInstance ?? null,
    },
    to: { runnerId: payload.runnerId ?? null, instanceId: payload.instanceId ?? null },
    at: now,
  });
  D.stageRun(aggregate, run, ctx);
  return { aggregate, result: { runId: run.id, claimed: true, adopted: true } };
}

// panel_begin — the ONLY way a panelist attempt enters the durable record.
// The attempt exists before any runtime call (the durable-write-before-
// launch invariant); everything after it is reconcile/resolve.
export async function cmdPanelBegin(D, ctx, aggregate, payload, now) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  if (!['queued', 'active'].includes(run.status)) {
    throw new D.CommandError(409, 'run_not_launchable',
      `run ${run.id} is ${run.status} — panelists launch only from queued|active`);
  }
  if (run.phase !== null && run.phase !== 'panel') {
    throw new D.CommandError(409, 'phase_mismatch',
      `fusion panel attempts launch only in phase 'panel' — run is ${run.phase}`);
  }
  const p = participantOf(run, D.reqStr(payload.participantId, 'participantId'));
  if (!p) {
    throw new D.CommandError(404, 'participant_not_found',
      `participant ${JSON.stringify(payload.participantId)} is not in this panel`);
  }
  if (p.status !== 'pending') {
    throw new D.CommandError(409, 'participant_not_pending',
      `participant ${p.id} is ${p.status} — a new attempt requires 'pending'`);
  }
  if (!participantAttemptsLeft(run, p)) {
    throw new D.CommandError(409, 'attempts_exhausted',
      `participant ${p.id} used ${p.attemptsUsed} attempts — an explicit retry_participant grants more`);
  }
  if (participantAttempts(run, p.id).some((a) => D.ATTEMPT_NONTERMINAL.has(a.status))) {
    throw new D.CommandError(409, 'attempt_active',
      `participant ${p.id} already holds a live attempt — resolve it first`);
  }
  const attemptId = D.reqStr(payload.attemptId, 'attemptId');
  if (!SAFE_ID_RE.test(attemptId)) {
    throw new D.CommandError(422, 'invalid_argument', `attemptId must match ${SAFE_ID_RE}`);
  }
  // Attempt ids are durable public history — reject reuse on ANY run of
  // ANY card (same rule as begin_attempt).
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
            `attemptId ${attemptId} is already recorded on card ${other.cardId} run ${r.id}`);
        }
      }
    }
  }
  // Slot accounting identical to begin_attempt: the reservation unit is
  // the RUN (a live panelist attempt marks the run active globally), while
  // 'panelist' role attempts get their own cap (default = max panel size).
  const limits = await ctx.loadSchedulerLimits();
  let globalActive = 0;
  let roleActive = 0;
  for (const agg of await ctx.listAggregates()) {
    for (const r of agg.runs || []) {
      let runActive = false;
      for (const a of r?.attempts || []) {
        if (a && D.ATTEMPT_NONTERMINAL.has(a.status)) {
          runActive = true;
          if (a.role === 'panelist') roleActive += 1;
        }
      }
      if (r?.validation && (r.validation.status === 'active' || r.validation.status === 'unproven')) {
        runActive = true;
      }
      if (runActive) globalActive += 1;
    }
  }
  const thisRunActive = (run.attempts || []).some((a) => a && D.ATTEMPT_NONTERMINAL.has(a.status));
  const ownUnit = thisRunActive ? 1 : 0;
  if (globalActive - ownUnit >= limits.global) {
    throw new D.CommandError(409, 'limit_reached',
      `global attempt limit reached (${globalActive}/${limits.global})`,
      { scope: 'global', active: globalActive, limit: limits.global });
  }
  const roleCap = limits.roles?.panelist ?? MAX_PANELISTS;
  if (roleActive >= roleCap) {
    throw new D.CommandError(409, 'limit_reached',
      `panelist attempt limit reached (${roleActive}/${roleCap})`,
      { scope: 'role', role: 'panelist', active: roleActive, limit: roleCap });
  }
  const launch = payload.launch;
  if (!isObj(launch)) {
    throw new D.CommandError(422, 'invalid_argument', 'payload.launch must be an object');
  }
  if (typeof launch.profileId !== 'string' || !SAFE_ID_RE.test(launch.profileId)) {
    throw new D.CommandError(422, 'invalid_argument', `launch.profileId must match ${SAFE_ID_RE}`);
  }
  // HARD BINDING: the launch's declared digest must equal the participant's
  // recorded profile digest — a launch for a different effective profile
  // is a different agent and is refused.
  if (typeof launch.profileDigest !== 'string' || !D.SHA256_RE.test(launch.profileDigest)) {
    throw new D.CommandError(422, 'invalid_argument', 'launch.profileDigest must be a sha256 hex');
  }
  if (launch.profileDigest !== p.profileDigest) {
    throw new D.CommandError(409, 'profile_digest_mismatch',
      `launch digest does not match participant ${p.id}'s recorded profile — the panel launches the recorded composition only`);
  }
  for (const k of ['promptSha256', 'materialsSha256']) {
    if (typeof launch[k] !== 'string' || !D.SHA256_RE.test(launch[k])) {
      throw new D.CommandError(422, 'invalid_argument', `launch.${k} must be a sha256 hex`);
    }
  }
  for (const k of ['cwd', 'artifactsDir', 'attemptDir']) {
    if (typeof launch[k] !== 'string' || !launch[k].startsWith('/')) {
      throw new D.CommandError(422, 'invalid_argument', `launch.${k} must be an absolute path`);
    }
    launch[k] = D.normPath(launch[k]);
  }
  if (launch.workerId !== undefined
    && (typeof launch.workerId !== 'string' || !SAFE_ID_RE.test(launch.workerId))) {
    throw new D.CommandError(422, 'invalid_argument', `launch.workerId must match ${SAFE_ID_RE}`);
  }
  const leaseMs = D.clampLeaseMs(payload.leaseMs);
  const attempt = {
    id: attemptId,
    runId: run.id,
    role: 'panelist',
    participantId: p.id,
    phase: 'panel',
    n: p.attemptsUsed + 1,
    status: 'launching',
    owner: D.newOwner(payload, now, leaseMs),
    launch,
    porchRunId: null,
    workspaceId: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    outcome: null,
    error: null,
  };
  run.attempts.push(attempt);
  p.status = 'launching';
  p.attemptsUsed += 1;
  syncPanelDerived(run);
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: {
      attemptId, runId: run.id, participantId: p.id, status: attempt.status,
      slots: {
        global: { active: globalActive + 1, limit: limits.global },
        role: { role: 'panelist', active: roleActive + 1, limit: roleCap },
      },
    },
  };
}

// panel_settle — the ONLY panel-phase terminalizer. The outcome is never
// claimed by the caller: the domain re-derives it from the durable
// participant set. Live attempts or launchable pending work refuse the
// settle outright — the run stays active while anything can still run.
export async function cmdPanelSettle(D, ctx, aggregate, payload, now) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  if (!D.RUN_NONTERMINAL.has(run.status)) {
    if (run.status === 'blocked' && run.fusion?.settledAt) {
      return { aggregate, result: { runId: run.id, outcome: run.fusion.status, idempotent: true } };
    }
    throw new D.CommandError(409, 'run_terminal', `run ${run.id} is ${run.status}`);
  }
  if (run.status === 'stopping') {
    throw new D.CommandError(409, 'run_stopping',
      `run ${run.id} is stopping — the halt drains before any settle`);
  }
  // Authority: the claimed panel owner, or the last attempt's owner.
  const fz = run.fusion;
  const lastAtt = (run.attempts || [])[run.attempts.length - 1] ?? null;
  const auth = (fz.owner && D.ownsResource(fz.owner, payload))
    || (lastAtt && D.ownsResource(lastAtt.owner, payload));
  if (!auth) {
    throw new D.CommandError(409, 'not_panel_owner',
      'panel_settle requires the run\u2019s panel owner instance');
  }
  const derived = derivedSettleOutcome(run, { isLiveAttempt: (s) => D.ATTEMPT_NONTERMINAL.has(s) });
  if (!derived.ok) {
    throw new D.CommandError(409, 'settle_premature',
      `the panel still holds executable work (${derived.code}) — settle only when nothing can run`,
      { code: derived.code });
  }
  const outcome = derived.outcome;
  fz.status = outcome;
  fz.settledAt = now;
  fz.judgeEligible = outcome === 'complete';
  syncPanelDerived(run);
  if (outcome === 'complete' && fz.judge) {
    // F3: the accepted answers + exclusions are immutable now — the run
    // hands off to the judge phase (status stays live, phase drives).
    run.status = 'active';
    run.phase = 'judge';
    run.error = null;
  } else {
    run.status = 'blocked';
    run.finishedAt = now;
    run.error = outcome === 'decision_pending'
      ? 'panel awaits participant decisions (retry_participant / exclude_panelist)'
      : outcome === 'complete'
        ? 'panel complete — quorum of distinct models reached; no judge configured'
        : 'panel quorum failed — fewer than two distinct models produced accepted answers';
  }
  // Durable panel-settled event in the run's own event stream.
  const st = panelState(run, { isLiveAttempt: (s) => D.ATTEMPT_NONTERMINAL.has(s) });
  const ev = {
    seq: run.eventsCursor ?? 0, at: now, type: 'panel_settled',
    data: {
      outcome,
      judgeEligible: fz.judgeEligible,
      answered: st.answered.map((p) => p.id),
      models: [...st.answeredModels],
      excluded: (fz.exclusions || []).map((x) => x.participantId),
      pendingDecisions: st.awaitingDecision.map((p) => p.id),
    },
  };
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push(ev);
  run.eventsCursor = (run.eventsCursor ?? 0) + 1;
  ctx.appendRunEvent(run.id, run.events);
  D.stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      runId: run.id, outcome, judgeEligible: fz.judgeEligible,
      pendingActions: fz.pendingActions,
      answeredModels: [...st.answeredModels],
      status: run.status,
    },
  };
}

// ---- user commands -------------------------------------------------------------

// Shared gate for retry/exclude: the named run is this card's fusion run,
// and no OTHER run on the card holds a live reservation (a second live run
// would make participant mutation unsafe).
function fusionRunForDecision(D, aggregate, payload) {
  const run = D.runOf(aggregate, D.reqStr(payload.runId, 'runId'));
  if (!run) throw new D.CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.mode !== 'fusion') {
    throw new D.CommandError(409, 'not_fusion', `run ${run.id} is not a fusion run`);
  }
  if (!['active', 'queued', 'blocked'].includes(run.status)) {
    throw new D.CommandError(409, 'run_terminal',
      `run ${run.id} is ${run.status} — participant decisions apply only to live or blocked-panel runs`);
  }
  const others = D.liveReservations(aggregate).filter((x) => x.run.id !== run.id);
  if (others.length) {
    throw new D.CommandError(409, 'run_active',
      `${D.describeReservation(others)} — another live run holds the card`);
  }
  return run;
}

// retry_participant — grants the failed participant exactly ONE extra
// attempt and reopens it ('pending'). Reactivates a panel-blocked run so
// the scheduler may drive the new attempt.
export async function cmdRetryParticipant(D, ctx, aggregate, payload, now) {
  const run = fusionRunForDecision(D, aggregate, payload);
  const p = participantOf(run, D.reqStr(payload.participantId, 'participantId'));
  if (!p) {
    throw new D.CommandError(404, 'participant_not_found',
      `participant ${JSON.stringify(payload.participantId)} is not in this panel`);
  }
  if (p.status !== 'awaiting_decision') {
    throw new D.CommandError(409, 'participant_not_decidable',
      `participant ${p.id} is ${p.status} — only an exhausted (awaiting_decision) participant may be retried`);
  }
  p.status = 'pending';
  p.extraAttempts = (p.extraAttempts || 0) + 1;
  p.lastError = null;
  if (run.status === 'blocked') {
    run.status = 'active';
    run.phase = 'panel';
    run.finishedAt = null;
    run.error = null;
    run.resumedAt = now;
    run.fusion.settledAt = null;
    run.fusion.judgeEligible = null;
  }
  syncPanelDerived(run);
  D.stageRun(aggregate, run, ctx);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: { runId: run.id, participantId: p.id, status: p.status, extraAttempts: p.extraAttempts },
  };
}

// exclude_panelist — durable removal of a failed participant from the
// panel. The quorum must survive: fewer than two distinct models among
// the remaining non-excluded participants refuses the exclusion outright.
// The exclusion record lands in run.fusion.exclusions — the judge-facing
// list (F3 consumes it verbatim).
export async function cmdExcludePanelist(D, ctx, aggregate, payload, now) {
  const run = fusionRunForDecision(D, aggregate, payload);
  const p = participantOf(run, D.reqStr(payload.participantId, 'participantId'));
  if (!p) {
    throw new D.CommandError(404, 'participant_not_found',
      `participant ${JSON.stringify(payload.participantId)} is not in this panel`);
  }
  if (p.status !== 'awaiting_decision') {
    throw new D.CommandError(409, 'participant_not_decidable',
      `participant ${p.id} is ${p.status} — only an exhausted (awaiting_decision) participant may be excluded`);
  }
  const remaining = (run.fusion.participants || [])
    .filter((x) => x.id !== p.id && x.status !== 'excluded');
  const remainingModels = new Set(remaining.map((x) => x.model));
  if (remainingModels.size < MIN_DISTINCT_MODELS) {
    throw new D.CommandError(409, 'panel_below_minimum',
      `excluding ${p.id} leaves ${remainingModels.size} distinct model(s) — the panel requires at least ${MIN_DISTINCT_MODELS}`);
  }
  const reason = typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.slice(0, 500) : null;
  const by = typeof payload.by === 'string' && payload.by.trim()
    ? payload.by.trim().slice(0, 64) : 'user';
  p.status = 'excluded';
  p.exclusion = { at: now, by, reason, attemptsUsed: p.attemptsUsed };
  run.fusion.exclusions = Array.isArray(run.fusion.exclusions) ? run.fusion.exclusions : [];
  run.fusion.exclusions.push({
    participantId: p.id, model: p.model, profileDigest: p.profileDigest,
    attemptsUsed: p.attemptsUsed, reason, by, at: now,
  });
  syncPanelDerived(run);
  // If the run was parked on this decision and nothing executable remains,
  // the panel settles NOW (quorum math is derived, never claimed).
  const derived = derivedSettleOutcome(run, { isLiveAttempt: (s) => D.ATTEMPT_NONTERMINAL.has(s) });
  if (run.status === 'blocked' && derived.ok && derived.outcome !== 'decision_pending') {
    const fz = run.fusion;
    fz.status = derived.outcome;
    fz.settledAt = now;
    fz.judgeEligible = derived.outcome === 'complete';
    if (derived.outcome === 'complete' && fz.judge) {
      run.status = 'active';
      run.phase = 'judge';
      run.error = null;
      run.finishedAt = null;
    } else {
      run.error = derived.outcome === 'complete'
        ? 'panel complete — quorum of distinct models reached; no judge configured'
        : 'panel quorum failed — fewer than two distinct models produced accepted answers';
    }
    const st = panelState(run, { isLiveAttempt: (s) => D.ATTEMPT_NONTERMINAL.has(s) });
    const ev = {
      seq: run.eventsCursor ?? 0, at: now, type: 'panel_settled',
      data: {
        outcome: derived.outcome,
        judgeEligible: fz.judgeEligible,
        answered: st.answered.map((x) => x.id),
        models: [...st.answeredModels],
        excluded: (fz.exclusions || []).map((x) => x.participantId),
        pendingDecisions: [],
      },
    };
    run.events = Array.isArray(run.events) ? run.events : [];
    run.events.push(ev);
    run.eventsCursor = (run.eventsCursor ?? 0) + 1;
    ctx.appendRunEvent(run.id, run.events);
  }
  D.stageRun(aggregate, run, ctx);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      runId: run.id, participantId: p.id, status: 'excluded',
      exclusions: run.fusion.exclusions.length,
      remainingModels: [...remainingModels],
      fusionStatus: run.fusion.status,
    },
  };
}
