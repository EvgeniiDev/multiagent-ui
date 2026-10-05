// server/execution/preparation/session.mjs — P1 idea-preparation session
// domain (plan: docs/plans/agent-idea-preparation-plan.md, unit P1).
//
// Runs INSIDE execution-domain's serialized command queue — the module
// decides, the service persists. Like fusion/domain.mjs it never imports
// execution-domain (no cycle): the domain assembles a deps bag `D` and calls
// these handlers. Registry binding data reaches the module only through ctx
// seams (ctx.preparationRegistry / ctx.preparationVerify) so the module stays
// fs-pure and every decision is reproducible in tests.
//
//   user channel:     start_preparation, answer_question, request_draft,
//                     continue_discussion, stop_preparation,
//                     change_skill_binding, confirm_gate,
//                     handoff_preparation
//   internal channel: prep_result (the lead transport delivers attempt
//                     outcomes; P3 drives it — P1 owns the durable seam),
//                     prep_question (P3: a mid-turn native dialog becomes a
//                     durable question BEFORE its rpc request id is bound)
//   hooks:            prepAfterAttach (attach_document),
//                     prepAfterRequirementsChanged (change_requirements),
//                     prepAssertStartReady (start/continue input gate)
//
// Invariants:
//   * ONE active preparation session per card — the command queue
//     serializes concurrent starts; an equivalent start reuses the live
//     session, never forks.
//   * Readiness is DERIVED from durable state — approved current
//     requirements+plan (the core approval lifecycle, unchanged) PLUS every
//     required SkillGate of the bindings actually used PLUS no unresolved
//     blocking open questions. A lead's final message or model confidence
//     never flips ready.
//   * A SkillGate binds {bindingId, resource digest, gate type, presented
//     subject (document versionId+sha256 or intent-restatement sha256),
//     explicit user confirmation}. Gate confirmation is a dedicated user
//     command — approvals of other documents never satisfy a gate.
//   * Artifact/binding mutation invalidates only DEPENDENT gates; intent
//     restatement invalidates the intent gate and every confirmed artifact
//     gate whose presented entry was produced under a superseded
//     restatement.
//   * Attempts are durable before results may land; a cancelled/stopped/
//     terminal attempt's late result or stale answer is refused or ignored
//     idempotently and can never mint a document, answer a question, or
//     authorize a different attempt.
//   * The core approval lifecycle is untouched: approvals still bind
//     (versionId, sha256); preparation ADDS gate/freshness checks on top.
//   * Unsupported/unproven bindings are fail-closed: route selection calls
//     the P0 availability guard at assignment time, and readiness/start
//     re-verify status + pinned digest (and, at the start gate, the full
//     resource manifest).

import { randomUUID } from 'node:crypto';
import { isTerminalRoutingMenu } from './routing-menu.mjs';
import { sha256 } from '../execution-store.mjs';
import { bindingById, assertRouteAvailable, bindingConfigDigest } from './skills/registry.mjs';
import { ADAPTERS, assertResultChannels } from './skills/adapters.mjs';
import { defaultHostCapabilities } from './skills/capabilities.mjs';
import { preflightContract } from './skills/preflight.mjs';
import { RuntimeError } from '../common.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const PREP_SCHEMA_VERSION = 1;
// Plan KTD1 phases: clarify → requirements → (design) → plan → ready.
export const PREP_PHASES = new Set(['clarify', 'requirements', 'design', 'plan', 'ready']);
export const PREP_SESSION_STATUSES = new Set(['active', 'stopped']);
// The registry's stage vocabulary (skills/registry.mjs STAGES).
export const PREP_STAGES = new Set(['intent', 'requirements', 'design', 'plan', 'review']);
export const PREP_COMMANDS = new Set([
  'start_preparation',
  'answer_question',
  'request_draft',
  'continue_discussion',
  'stop_preparation',
  'change_skill_binding',
  // confirm_gate implements R5/KTD8: intent/design (and artifact) gates are
  // separate user confirmations of a concrete presented result — they are
  // not implied by document approvals, so they need their own verb.
  'confirm_gate',
  // handoff_preparation implements P4/R11: a durable OFFER of the accepted
  // package to a named downstream mode. It records evidence + the exact
  // inputs snapshot; it never mints a run or dispatches a mode.
  'handoff_preparation',
]);
export const PREP_INTERNAL_COMMANDS = new Set(['prep_result', 'prep_question']);

export const GATE_TYPES = new Set(['intent_confirm', 'artifact_confirm']);
// 'blocked' is a terminal attempt status too — the lead parked the attempt
// with a structured blocker (P3); only ATTEMPT_LIVE entries may take a
// result or mint questions.
const ATTEMPT_LIVE = new Set(['running', 'awaiting_answer']);
// P3: how a durable question was presented — 'dialog' is a native
// extension_ui request (answer rides a matching extension_ui_response),
// 'prompt' is a post-turn question (answer rides the next prompt).
const QUESTION_CHANNELS = new Set(['dialog', 'prompt']);
const RESULT_OUTCOMES = new Set(['completed', 'failed', 'blocked']);
const DOC_KINDS_PREP = ['requirements', 'design', 'plan'];

const MAX_TEXT = 64 * 1024;
const LOG_CAP = 400;
const HISTORY_CAP = 5;
const QUESTIONS_CAP = 200;
const HANDOFFS_CAP = 50;
// P4 (R11): the modes a prepared package may be OFFERED to. Recording the
// offer is data — `implemented` marks which modes this build can actually
// launch. Deployment feature flags still gate starting any downstream run.
export const HANDOFF_MODES = new Set(['solo', 'fusion', 'orchestrator', 'swarm']);
export const HANDOFF_IMPLEMENTED = new Set(['solo', 'fusion', 'orchestrator', 'swarm']);

// ---------------------------------------------------------------------------
// Gate contract
// ---------------------------------------------------------------------------
//
// Which SkillGates a used binding requires. P2 makes this a DECLARED field:
// the binding's `gateContract` — snapshotted onto the session's binding ref
// at assignment — lists every SkillGate the route's contract requires ([] is
// a valid declaration: a non-interactive route like ce-doc-review carries no
// user gate). Binding refs minted before P2 carry no declared contract and
// derive it from stage exactly as P1 did — the seam preserves semantics, it
// never invents a contract. An unrecognised binding stage fails closed
// (requiredGatesFor → null → gate_contract_unknown blocker).
//
// The contract stays honest per binding — a gate is never renamed into an
// approval and an approval never satisfies a gate.

export function requiredGatesFor(binding) {
  if (!binding || typeof binding !== 'object') return null;
  if (Array.isArray(binding.gateContract)) {
    // Declared contract (P2). [] is a real contract — a route with no
    // user-facing gate, not a missing declaration.
    return binding.gateContract.map((g) => ({ type: g.type, stage: g.stage }));
  }
  // P1 compatibility: no declared contract → the stage-derived default.
  switch (binding.stage) {
    case 'intent':
      return [{ type: 'intent_confirm', stage: 'intent' }];
    case 'requirements':
    case 'design':
    case 'plan':
      return [{ type: 'artifact_confirm', stage: binding.stage }];
    case 'review':
      return [];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(D, status, code, message, details = {}) {
  throw new D.CommandError(status, code, message, details);
}

function text(v, D, tag, { max = MAX_TEXT, required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) fail(D, 422, 'invalid_argument', `payload.${tag} is required`);
    return null;
  }
  if (typeof v !== 'string' || !v.trim()) {
    fail(D, 422, 'invalid_argument', `payload.${tag} must be a non-empty string`);
  }
  const t = v.trim();
  if (t.length > max) {
    fail(D, 422, 'invalid_argument', `payload.${tag} exceeds ${max} chars`);
  }
  return t;
}

export function sessionOf(aggregate) {
  const s = aggregate?.preparation;
  return s && typeof s === 'object' ? s : null;
}

function requireSession(D, aggregate) {
  const s = sessionOf(aggregate);
  if (!s) {
    fail(D, 422, 'no_preparation',
      'card has no preparation session — start_preparation first');
  }
  return s;
}

function requireActiveSession(D, aggregate) {
  const s = requireSession(D, aggregate);
  if (s.status !== 'active') {
    fail(D, 409, 'session_not_active',
      `preparation session ${s.sessionId} is ${s.status} — start_preparation opens a new one`,
      { sessionId: s.sessionId, status: s.status });
  }
  return s;
}

function findAttempt(session, attemptId) {
  return (session.attempts || []).find((a) => a && a.attemptId === attemptId) ?? null;
}

function findQuestion(session, questionId) {
  return (session.checkpoint.openQuestions || []).find(
    (q) => q && q.questionId === questionId) ?? null;
}

function findGate(session, gateId) {
  return (session.gates || []).find((g) => g && g.gateId === gateId) ?? null;
}

function bumpCheckpoint(session, now) {
  session.checkpoint.revision += 1;
  session.checkpoint.updatedAt = now;
  session.updatedAt = now;
}

function logEvent(session, now, type, data = {}) {
  const log = session.checkpoint.log;
  if (log.length >= LOG_CAP) {
    const drop = log.length - LOG_CAP + 1;
    log.splice(0, drop);
    session.checkpoint.droppedLog = (session.checkpoint.droppedLog || 0) + drop;
  }
  log.push({ seq: session.checkpoint.nextSeq++, at: now, type, ...data });
}

function mintAttempt(session, kind, now, extra = {}) {
  const attempt = {
    attemptId: `pa_${randomUUID()}`,
    kind,                      // 'kickoff' | 'turn' | 'draft'
    status: 'running',
    createdAt: now,
    answers: {},
    questionIds: [],
    result: null,
    finishedAt: null,
    cancel: null,
  };
  // P3: the durable inputs the lead's next turn is built from — the user's
  // instruction text (turn/draft note) and, for drafts, the contract kind.
  if (typeof extra.input === 'string' && extra.input) attempt.input = extra.input;
  if (typeof extra.docKind === 'string' && extra.docKind) attempt.docKind = extra.docKind;
  session.attempts.push(attempt);
  // A fresh user instruction supersedes a lead-reported blocker — the user
  // has spoken; the blocker record stays in the log.
  session.blocker = null;
  logEvent(session, now, 'attempt_minted', { attemptId: attempt.attemptId, kind });
  return attempt;
}

// A new conversational instruction makes every still-live prior attempt
// stale: a parked/running turn's late result must never overwrite the state
// a newer turn produced (KTD2). Cancelled attempts keep their question and
// answer records as evidence; their results are ignored from here on.
function supersedeLiveAttempts(session, now) {
  for (const a of session.attempts) {
    if (a && ATTEMPT_LIVE.has(a.status)) {
      a.status = 'cancelled';
      a.finishedAt = now;
      a.cancel = {
        requestedAt: now, by: 'system',
        reason: 'superseded by a newer instruction',
      };
      logEvent(session, now, 'attempt_superseded', { attemptId: a.attemptId });
    }
  }
}

function restatementHash(session) {
  return session.intent.current?.sha256 ?? null;
}

const normQuestionText = (s) =>
  String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// P3 dedupe: an already-ANSWERED question under the same intent restatement
// is never re-minted — accepted answers are not repeated (R3). A still-OPEN
// record with the same text is reused (re-presented/rebound), not
// duplicated — one outstanding question, one durable record. Open matches
// win over answered ones (a genuinely outstanding ask takes precedence).
// After an intent restatement a prior answer is a different epoch's answer —
// re-asking is legitimate and mints a fresh record.
function findQuestionDup(session, text) {
  const norm = normQuestionText(text);
  let answered = null;
  for (const q of session.checkpoint.openQuestions || []) {
    if (!q || normQuestionText(q.text) !== norm) continue;
    if (q.status === 'open') return { kind: 'open', question: q };
    if (q.status === 'answered'
        && (q.intentSha256 ?? null) === restatementHash(session)
        && !answered) {
      answered = { kind: 'answered', question: q };
    }
  }
  return answered;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function gateSubjectMatches(session, gate) {
  const subj = gate.subject;
  if (!subj) return false;
  if (subj.kind === 'intent_restatement') {
    return subj.sha256 === restatementHash(session);
  }
  if (subj.kind === 'document') {
    const p = session.presented[subj.docKind];
    return !!p && p.versionId === subj.versionId && p.sha256 === subj.sha256
      && p.intentSha256 === restatementHash(session);
  }
  return false;
}

// Invalidate every gate matching `pred` that is not already invalidated.
// Returns the ids touched — reported to callers so an invalidation is
// visible, never silent.
function invalidateGates(session, pred, reason, now) {
  const out = [];
  for (const g of session.gates) {
    if (g.status === 'invalidated' || !pred(g)) continue;
    g.status = 'invalidated';
    g.invalidatedAt = now;
    g.invalidationReason = reason;
    out.push(g.gateId);
    logEvent(session, now, 'gate_invalidated',
      { gateId: g.gateId, type: g.type, bindingId: g.bindingId, reason });
  }
  return out;
}

function mintGatesForBinding(D, session, bindingRef, now) {
  const required = requiredGatesFor(bindingRef);
  if (required === null) {
    fail(D, 422, 'gate_contract_unknown',
      `no SkillGate contract for stage ${JSON.stringify(bindingRef.stage)} of binding ${bindingRef.bindingId}`);
  }
  for (const spec of required) {
    const gate = {
      gateId: `pg_${randomUUID()}`,
      bindingId: bindingRef.bindingId,
      digest: bindingRef.digest,
      configDigest: bindingRef.configDigest ?? null,
      adapterVersion: bindingRef.adapterVersion,
      type: spec.type,
      stage: spec.stage,
      subject: null,          // bound at confirmation, to the presented thing
      status: 'pending',
      createdAt: now,
      confirmedAt: null,
      confirmedBy: null,
      invalidatedAt: null,
      invalidationReason: null,
    };
    session.gates.push(gate);
    logEvent(session, now, 'gate_minted',
      { gateId: gate.gateId, type: gate.type, bindingId: gate.bindingId, stage: gate.stage });
  }
}

// Confirmed-gate invalidation cascades DOWNSTREAM only: requirements feed
// design and plan; design feeds plan; plan depends on nothing upstream.
// Pending gates survive — they carry no bound subject yet and bind whatever
// is current at confirmation.
const STAGE_DEPENDENTS = {
  requirements: ['requirements', 'design', 'plan'],
  design: ['design', 'plan'],
  plan: ['plan'],
};

function invalidateDocumentGates(session, kind, now) {
  const stages = new Set(STAGE_DEPENDENTS[kind] || [kind]);
  return invalidateGates(session,
    (g) => g.status === 'confirmed' && stages.has(g.stage),
    'document_changed', now);
}

// The document kind a gate's stage binds, if any.
const STAGE_DOC_KIND = { requirements: 'requirements', design: 'design', plan: 'plan' };

function gateSubjectFor(D, session, gate) {
  if (gate.type === 'intent_confirm') {
    const cur = session.intent.current;
    if (!cur) {
      fail(D, 422, 'gate_subject_absent',
        'no intent restatement is currently presented — nothing to confirm');
    }
    return { kind: 'intent_restatement', sha256: cur.sha256 };
  }
  const kind = STAGE_DOC_KIND[gate.stage];
  if (!kind) {
    fail(D, 422, 'gate_contract_unknown',
      `gate ${gate.gateId} has stage ${JSON.stringify(gate.stage)} with no document kind`);
  }
  const p = session.presented[kind];
  if (!p) {
    fail(D, 422, 'gate_subject_absent',
      `no ${kind} document is currently presented — the gate cannot bind to nothing`);
  }
  return { kind: 'document', docKind: kind, versionId: p.versionId, sha256: p.sha256 };
}

// ---------------------------------------------------------------------------
// Document attach (session path) — same invariants as attach_document:
// immutable blob, version push, current pointer, approval revocation on new
// inputs. Approvals are NEVER created here — this only attaches evidence.
// ---------------------------------------------------------------------------

async function attachSessionDocument(D, ctx, aggregate, session, {
  kind, body, sourceRecord, meta, requirementsVersionId, now,
}) {
  const bytes = D.checkMarkdown(body);
  let boundRequirements = null;
  if (kind === 'plan') {
    // P4 (R5/R11): the session may mint a plan ONLY against the requirements
    // version the user has already accepted — the preparation never produces
    // or accepts an implementation plan with no approved current
    // requirements, and never binds a plan to a draft/superseded one. An
    // explicit requirementsVersionId naming anything but the approved
    // version is refused, not silently rebound.
    const reqDocs = aggregate.documents.requirements;
    const reqA = aggregate.approvals?.requirements ?? null;
    if (!reqA || reqDocs.current !== reqA.versionId) {
      fail(D, 422, 'requirements_unapproved',
        'a preparation plan requires an accepted requirements version — ' +
        'approve the current requirements before the plan stage imports a plan');
    }
    if (requirementsVersionId !== undefined && requirementsVersionId !== reqA.versionId) {
      fail(D, 409, 'plan_binding_stale',
        `plan declares requirements ${requirementsVersionId} but the accepted ` +
        `requirements are ${reqA.versionId} — re-run the plan stage against the ` +
        'current requirements',
        { requirementsVersionId, approved: reqA.versionId });
    }
    boundRequirements = { versionId: reqA.versionId, sha256: reqA.sha256 };
  } else if (requirementsVersionId !== undefined) {
    fail(D, 422, 'document_invalid',
      'requirementsVersionId binding only applies to kind=plan');
  }
  const blob = await ctx.writeBlob(body);
  const version = {
    versionId: `v_${randomUUID()}`,
    kind,
    sha256: blob.sha256,
    bytes,
    createdAt: now,
    source: sourceRecord,
    ...(meta ? { meta } : {}),
  };
  if (kind === 'plan') {
    version.requirements = boundRequirements;
    const fromDoc = D.extractPlanChecks(body);
    if (fromDoc) {
      version.checksFromDocument = fromDoc.ok
        ? { ok: true, checks: fromDoc.checks }
        : { ok: false, problems: fromDoc.problems };
    }
  }
  aggregate.documents[kind].versions.push(version);
  aggregate.documents[kind].current = version.versionId;
  // Same revocation rules as cmdAttachDocument: a new requirements/plan
  // input revokes its approval; a requirements change also revokes the
  // approval of the plan bound to it.
  if (kind === 'requirements' || kind === 'plan') {
    aggregate.approvals[kind] = null;
    if (kind === 'requirements') aggregate.approvals.plan = null;
  }
  return version;
}

function presentVersion(session, kind, version, now, via, attemptId = null) {
  session.presented[kind] = {
    versionId: version.versionId,
    sha256: version.sha256,
    at: now,
    via,
    sourceType: version?.source?.type ?? null,
    attemptId,
    draft: version.meta?.draft === true,
    intentSha256: restatementHash(session),
  };
  invalidateDocumentGates(session, kind, now);
}

// Hook: a document version landed while a preparation session was active
// (attach_document user command — prep_result has its own path). Keeps the
// session's presented pointer on the newest version and invalidates gates
// bound to what it replaced.
export function prepAfterAttach(D, aggregate, { kind, version, now, via = 'attach_document' }) {
  const session = sessionOf(aggregate);
  if (!session || session.status !== 'active') return;
  presentVersion(session, kind, version, now, via, version?.source?.attemptId ?? null);
  logEvent(session, now, 'document_presented', {
    kind, versionId: version.versionId, sha256: version.sha256, via,
  });
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate);
}

// Hook: change_requirements — the core already revoked both approvals; the
// documents the confirmed gates bound are being revised, so their confirmed
// gates are void until re-confirmed against the replacement.
export function prepAfterRequirementsChanged(D, aggregate, now) {
  const session = sessionOf(aggregate);
  if (!session || session.status !== 'active') return;
  const inv = invalidateGates(session,
    (g) => g.status === 'confirmed'
      && (STAGE_DEPENDENTS.requirements.includes(g.stage) || g.type === 'intent_confirm'),
    'requirements_changed', now);
  logEvent(session, now, 'requirements_changed', { invalidatedGates: inv });
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate);
}

// Intent restatement: installs a new current restatement and invalidates the
// gates that depended on the old one — every confirmed intent gate (its
// subject is the superseded restatement) and every confirmed artifact gate
// whose presented entry was produced under a different restatement.
// Artifact freshness itself is derived (presented.intentSha256 vs current).
function applyIntentRestatement(D, session, aggregate, restateText, now, origin) {
  const hash = sha256(restateText);
  const cur = session.intent.current;
  if (cur && cur.sha256 === hash) return { changed: false, sha256: hash };
  if (cur) {
    session.intent.history.push({ ...cur, supersededAt: now });
    if (session.intent.history.length > 20) {
      session.intent.history.splice(0, session.intent.history.length - 20);
    }
  }
  session.intent.current = {
    text: restateText, sha256: hash, at: now, origin,
    seq: (cur?.seq ?? 0) + 1,
  };
  const inv = invalidateGates(session,
    (g) => g.status === 'confirmed'
      && (g.type === 'intent_confirm'
        || (g.type === 'artifact_confirm' && g.subject?.kind === 'document'
          && session.presented[g.subject.docKind]
          && session.presented[g.subject.docKind].intentSha256 !== hash)),
    'intent_changed', now);
  logEvent(session, now, 'intent_restated', { sha256: hash, origin, invalidatedGates: inv });
  return { changed: true, sha256: hash, invalidatedGates: inv };
}

// ---------------------------------------------------------------------------
// Phase + readiness derivation
// ---------------------------------------------------------------------------
//
// phase is DERIVED, never asserted: the furthest stage with a presented
// artifact; 'ready' only when the synchronous readiness conditions hold.
// The stored session.phase is a cache refreshed on every mutation; read
// surfaces recompute.

export function derivePhase(aggregate) {
  const s = sessionOf(aggregate);
  if (!s) return null;
  if (evaluateReadinessSync(aggregate).ready) return 'ready';
  if (s.presented?.plan) return 'plan';
  if (s.presented?.design) return 'design';
  if (s.presented?.requirements) return 'requirements';
  return 'clarify';
}

function approvalBlockers(aggregate, blockers) {
  const reqA = aggregate.approvals?.requirements;
  if (!reqA) {
    blockers.push({ code: 'requirements_unapproved', detail: 'no approved requirements version' });
  } else if (aggregate.documents?.requirements?.current !== reqA.versionId) {
    blockers.push({
      code: 'requirements_approval_stale',
      detail: `approved ${reqA.versionId} is not current (${aggregate.documents?.requirements?.current})`,
    });
  }
  const planA = aggregate.approvals?.plan;
  if (!planA) {
    blockers.push({ code: 'plan_unapproved', detail: 'no approved plan version' });
  } else {
    if (aggregate.documents?.plan?.current !== planA.versionId) {
      blockers.push({
        code: 'plan_approval_stale',
        detail: `approved ${planA.versionId} is not current (${aggregate.documents?.plan?.current})`,
      });
    }
    if (reqA && (planA.requirementsVersionId !== reqA.versionId
      || planA.requirementsSha256 !== reqA.sha256)) {
      blockers.push({
        code: 'plan_binding_stale',
        detail: 'approved plan is not bound to the approved requirements version',
      });
    }
  }
}

// Required SkillGate specs for the session's CURRENT binding assignments —
// derivable without the registry because the binding ref records its
// stage+digest at assignment.
function requiredGateSpecs(session) {
  const specs = [];
  for (const ref of Object.values(session.bindings || {})) {
    if (!ref) continue;
    const req = requiredGatesFor(ref);
    if (req === null) {
      specs.push({ type: null, stage: ref.stage, bindingId: ref.bindingId, contractUnknown: true });
      continue;
    }
    for (const spec of req) {
      specs.push({ ...spec, bindingId: ref.bindingId, digest: ref.digest, configDigest: ref.configDigest ?? null });
    }
  }
  return specs;
}

// Synchronous readiness — everything decidable from aggregate state alone:
// session active, both approvals present/current/bound to each other, every
// required gate covered by a confirmed record with a still-current subject,
// presented artifacts fresh against the current intent, no unresolved
// blocking questions. Registry/digest truth is layered on by
// evaluateReadiness (async), and the filesystem re-verify only runs at the
// implementation start gate.
export function evaluateReadinessSync(aggregate) {
  const blockers = [];
  const session = sessionOf(aggregate);
  if (!session) {
    return { ready: false, blockers: [{ code: 'no_preparation', detail: 'no preparation session' }] };
  }
  if (session.status !== 'active') {
    blockers.push({ code: 'session_stopped', detail: `session ${session.sessionId} is stopped` });
    return { ready: false, blockers };
  }
  approvalBlockers(aggregate, blockers);
  for (const spec of requiredGateSpecs(session)) {
    if (spec.contractUnknown) {
      blockers.push({
        code: 'gate_contract_unknown', stage: spec.stage, bindingId: spec.bindingId,
        detail: `no SkillGate contract for binding stage ${spec.stage}`,
      });
      continue;
    }
    const sameKey = (g) => g && g.bindingId === spec.bindingId && g.type === spec.type;
    const rec = (session.gates || []).find((g) => sameKey(g) && g.digest === spec.digest)
      ?? [...(session.gates || [])].reverse().find(sameKey) ?? null;
    if (!rec) {
      blockers.push({
        code: 'gate_missing', stage: spec.stage, bindingId: spec.bindingId, type: spec.type,
        detail: 'required SkillGate was never minted for this binding assignment',
      });
      continue;
    }
    if (rec.digest !== spec.digest
      || (spec.configDigest != null && rec.configDigest != null && rec.configDigest !== spec.configDigest)) {
      blockers.push({
        code: 'gate_digest_stale', gateId: rec.gateId, stage: spec.stage,
        bindingId: spec.bindingId, type: spec.type,
        detail: `gate pinned to digest ${rec.digest?.slice(0, 12)}… but binding is ${spec.digest?.slice(0, 12)}…`,
      });
      continue;
    }
    if (rec.status === 'invalidated') {
      blockers.push({
        code: 'gate_reconfirm', gateId: rec.gateId, stage: spec.stage,
        bindingId: rec.bindingId, type: rec.type,
        detail: rec.invalidationReason ?? 'invalidated — confirm_gate again',
      });
      continue;
    }
    if (rec.status !== 'confirmed') {
      blockers.push({
        code: 'gate_pending', gateId: rec.gateId, stage: spec.stage,
        bindingId: rec.bindingId, type: rec.type,
        detail: 'required SkillGate awaits explicit user confirmation',
      });
      continue;
    }
    if (!gateSubjectMatches(session, rec)) {
      blockers.push({
        code: 'gate_subject_stale', gateId: rec.gateId, stage: spec.stage,
        bindingId: rec.bindingId, type: rec.type,
        detail: 'confirmed subject no longer matches the presented artifact',
      });
    }
  }
  const curHash = restatementHash(session);
  for (const kind of DOC_KINDS_PREP) {
    const p = session.presented?.[kind];
    if (p && p.intentSha256 !== curHash) {
      blockers.push({
        code: 'artifact_stale', kind,
        detail: `presented ${kind} ${p.versionId} was produced under a superseded intent`,
        versionId: p.versionId,
      });
    }
  }
  const open = (session.checkpoint?.openQuestions || []).filter(
    (q) => q && q.status === 'open' && q.blocking === true);
  if (open.length) {
    blockers.push({
      code: 'open_questions',
      detail: `${open.length} blocking question(s) still open`,
      questionIds: open.map((q) => q.questionId),
    });
  }
  return { ready: blockers.length === 0, blockers };
}

// Full readiness — sync conditions PLUS the registry truth for the bindings
// actually used: the binding must still exist, be `available`, and its
// pinned manifest digest must still equal the digest recorded at
// assignment. With {verify:true} each assigned binding's resources are
// re-hashed from disk (P0 verifyManifest) — drift fails closed.
export async function evaluateReadiness(D, ctx, aggregate, { verify = false } = {}) {
  const out = evaluateReadinessSync(aggregate);
  const session = sessionOf(aggregate);
  if (!session || session.status !== 'active') return out;
  const blockers = out.blockers;
  let registry = null;
  try {
    registry = await ctx.preparationRegistry();
  } catch (e) {
    blockers.push({
      code: 'registry_unavailable',
      detail: `cannot load the binding registry: ${e?.message ?? e}`,
    });
    return { ready: false, blockers };
  }
  const seen = new Set();
  for (const [stage, ref] of Object.entries(session.bindings || {})) {
    if (!ref) continue; // explicit "no skill for this stage"
    const refKey = `${ref.bindingId}@${ref.digest}/${ref.configDigest ?? '-'}`;
    if (seen.has(refKey)) continue;
    seen.add(refKey);
    let binding = null;
    try {
      binding = bindingById(registry, ref.bindingId);
    } catch {
      blockers.push({
        code: 'binding_unknown', stage, bindingId: ref.bindingId,
        detail: `assigned binding ${ref.bindingId} is not in the registry`,
      });
      continue;
    }
    if (binding.status !== 'available') {
      blockers.push({
        code: binding.status === 'unsupported' ? 'binding_unsupported' : 'binding_unproven',
        stage, bindingId: ref.bindingId,
        detail: binding.unsupported?.reason ?? `binding status is ${binding.status}`,
      });
      continue;
    }
    const currentDigest = binding.resourceManifest?.digest ?? null;
    if (ref.digest !== currentDigest) {
      blockers.push({
        code: 'binding_digest_changed', stage, bindingId: ref.bindingId,
        detail: `pinned digest ${ref.digest?.slice(0, 12)}… != registry digest ${currentDigest?.slice(0, 12)}…`,
      });
      continue;
    }
    // P2: the binding's runtime contract is pinned too — an adapter/contract
    // repin with untouched resources still staleness-marks the assignment;
    // the session migrates explicitly via change_skill_binding.
    if (ref.configDigest != null && ref.configDigest !== bindingConfigDigest(binding)) {
      blockers.push({
        code: 'binding_config_changed', stage, bindingId: ref.bindingId,
        detail: `binding config digest ${ref.configDigest.slice(0, 12)}… != registry ` +
          `${bindingConfigDigest(binding).slice(0, 12)}… — migrate via change_skill_binding`,
      });
      continue;
    }
    if (verify) {
      try {
        await ctx.preparationVerify(binding);
      } catch (e) {
        blockers.push({
          code: 'binding_resources_drifted', stage, bindingId: ref.bindingId,
          detail: e?.message ?? String(e),
        });
        continue;
      }
    }
    // requiredGatesFor has no per-registry surprises here — the sync pass
    // already covered contract/records; this binding is digest-consistent.
  }
  return { ready: blockers.length === 0, blockers };
}

// The start/continue seam: when the card carries an ACTIVE preparation
// session, readiness must hold in the same commit that admits the run — the
// core approval checks already ran (requireApprovedInputs calls this last).
// A stopped/absent session gates nothing: stopping is an explicit exit from
// the preparation workflow and leaves the card on the plain core lifecycle
// (the approvals remain mandatory there).
export async function prepAssertStartReady(D, ctx, aggregate, commandName = 'start') {
  const session = sessionOf(aggregate);
  if (!session || session.status !== 'active') return;
  const evald = await evaluateReadiness(D, ctx, aggregate, { verify: true });
  if (!evald.ready) {
    fail(D, 422, 'preparation_not_ready',
      `${commandName} is blocked: the active preparation session ${session.sessionId} is not ready — ` +
      `resolve ${evald.blockers.length} blocker(s) first`,
      { sessionId: session.sessionId, blockers: evald.blockers });
  }
}

// ---------------------------------------------------------------------------
// Commands (user channel)
// ---------------------------------------------------------------------------

function validateBindingSelection(D, raw) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) {
    fail(D, 422, 'invalid_argument', 'payload.bindings must be an object {stage: bindingId|null}');
  }
  for (const [stage, v] of Object.entries(raw)) {
    if (!PREP_STAGES.has(stage)) {
      fail(D, 422, 'invalid_argument',
        `payload.bindings key must be a stage (${[...PREP_STAGES].join('|')}) — got ${JSON.stringify(stage)}`);
    }
    if (v !== null) text(v, D, `bindings.${stage}`, { max: 200 });
    out[stage] = v;
  }
  return out;
}

// The host capability surface for binding preflight. The ctx seam is the
// truth when present (state-service provides the real descriptor, tests may
// inject a reduced one); absent a seam this module declares its own
// capabilities — the same surface the pi-skill adapter + bridge provide.
async function hostCapabilities(ctx) {
  if (typeof ctx.preparationCapabilities === 'function') {
    return ctx.preparationCapabilities();
  }
  return defaultHostCapabilities();
}

async function bindingAdapters(ctx) {
  if (typeof ctx.preparationAdapters === 'function') {
    return ctx.preparationAdapters();
  }
  return ADAPTERS;
}

// Binding assignment preflight (P2, KTD3): nothing is minted for a route
// that cannot safely serve it. Runs BEFORE any ref/gate/attempt exists —
// route availability, adapter presence+compatibility, declared host
// capabilities, declared gate contract, and the pinned manifest's presence.
// The filesystem truth is layered via ctx.preparationVerify — a missing or
// drifted pinned resource refuses the assignment outright (P1 verified only
// at the start gate; assignment is the earlier, better refusal point).
async function resolveBindingRef(D, ctx, stage, bindingId, now) {
  const registry = await ctx.preparationRegistry();
  let binding;
  try {
    binding = bindingById(registry, bindingId);
  } catch (e) {
    fail(D, 422, e.code ?? 'unknown_binding', e.message, { bindingId, stage });
  }
  if (binding.stage !== stage) {
    fail(D, 422, 'binding_stage_mismatch',
      `binding ${bindingId} serves stage ${binding.stage}, not ${stage}`,
      { bindingId, stage, bindingStage: binding.stage });
  }
  let pf;
  try {
    pf = preflightContract(binding, {
      hostCapabilities: await hostCapabilities(ctx),
      adapters: await bindingAdapters(ctx),
    });
  } catch (e) {
    if (e instanceof RuntimeError) {
      const { name, code, ...rest } = e; // structured extras ride along
      fail(D, 422, code, e.message, { bindingId, stage, ...rest });
    }
    throw e;
  }
  try {
    await ctx.preparationVerify(binding); // the pinned resources are real, now
  } catch (e) {
    if (e instanceof RuntimeError) {
      const { name, code, ...rest } = e; // missing/changed/added ride along
      fail(D, 422, code, e.message, { bindingId, stage, ...rest });
    }
    throw e;
  }
  // The version snapshot: BOTH digests — the pinned resource set and the
  // binding's runtime contract — plus the declared gate/result contracts the
  // session will enforce. A registry repin or contract edit moves one of
  // them and the assignment surfaces as stale (binding_digest_changed /
  // binding_config_changed) until an explicit migration refreshes it.
  return {
    bindingId, stage,
    digest: pf.digest,
    configDigest: pf.configDigest,
    adapterId: pf.adapterId,
    adapterVersion: pf.adapterVersion,
    questionChannel: pf.questionChannel,
    gateContract: binding.gateContract ?? null,
    result: binding.result ?? null,
    assignedAt: now,
  };
}

async function cmdStartPreparation(D, ctx, aggregate, payload, now, cardId) {
  // Read inside the serialized command queue: edits saved after enable are
  // the idea being discussed, not a stale managed-aggregate snapshot.
  const fromCard = payload?.intent === undefined || payload?.intent === null;
  let intent;
  if (fromCard) {
    const board = await ctx.getDoc('board.json');
    const card = (board?.cards || []).find((c) => c && c.id === cardId);
    if (!card) fail(D, 404, 'card_not_found', `unknown card ${cardId}`);
    const value = (key) => typeof card[key] === 'string' ? card[key].trim() : '';
    if (!value('title') && !value('description')) {
      fail(D, 422, 'card_idea_missing', 'Add an idea to the card title or description before starting preparation');
    }
    intent = text([
      ['Card title', 'title'], ['Idea', 'description'],
      ['Acceptance criteria', 'acceptance'], ['Verification', 'verification'],
    ].filter(([, key]) => value(key)).map(([label, key]) => `## ${label}\n${value(key)}`).join('\n\n'), D, 'intent');
  } else {
    // Preserve existing API clients that supply an explicit intent.
    intent = text(payload.intent, D, 'intent');
  }
  const selection = validateBindingSelection(D, payload?.bindings);
  const existing = sessionOf(aggregate);
  if (existing && existing.status === 'active') {
    // One active preparation per card: a tab-equivalent start with the same
    // intent and no contradictory binding request reuses the live session —
    // the same durable outcome, no fork. A different intent is a conflict.
    if (existing.intent.raw !== intent) {
      fail(D, 409, 'preparation_active',
        `card ${cardId} already has an active preparation session ${existing.sessionId} — ` +
        'continue it, or stop_preparation before starting over',
        { sessionId: existing.sessionId, phase: derivePhase(aggregate) });
    }
    for (const stage of PREP_STAGES) {
      if (!Object.prototype.hasOwnProperty.call(selection, stage)) continue;
      const want = selection[stage];
      const cur = existing.bindings?.[stage]?.bindingId ?? null;
      if (want !== cur) {
        fail(D, 409, 'preparation_active',
          `active session ${existing.sessionId} has ${stage} binding ${cur ?? '∅'}, ` +
          `requested ${want ?? '∅'} — use change_skill_binding`,
          { sessionId: existing.sessionId, stage });
      }
    }
    logEvent(existing, now, 'start_reused', { sessionId: existing.sessionId });
    bumpCheckpoint(existing, now);
    return {
      aggregate,
      refreshProjection: true,
      result: {
        sessionId: existing.sessionId, created: false, reused: true,
        phase: derivePhase(aggregate),
        status: existing.status,
      },
    };
  }

  // Resolve every requested binding BEFORE the session exists — an
  // unsupported/unproven route refuses cleanly (fail-closed, nothing half
  // created).
  const bindingRefs = {};
  for (const stage of PREP_STAGES) bindingRefs[stage] = null;
  for (const [stage, bindingId] of Object.entries(selection)) {
    if (bindingId === null) continue; // explicit "no skill for this stage" (R9)
    bindingRefs[stage] = await resolveBindingRef(D, ctx, stage, bindingId, now);
  }

  if (existing && existing.status === 'stopped') {
    aggregate.preparationHistory = aggregate.preparationHistory || [];
    aggregate.preparationHistory.push({ ...structuredClone(existing), archivedAt: now });
    if (aggregate.preparationHistory.length > HISTORY_CAP) {
      aggregate.preparationHistory.splice(
        0, aggregate.preparationHistory.length - HISTORY_CAP);
    }
  }

  const restatement = { text: intent, sha256: sha256(intent), at: now, origin: 'user', seq: 1 };
  const session = {
    schemaVersion: PREP_SCHEMA_VERSION,
    sessionId: `prep_${randomUUID()}`,
    status: 'active',
    phase: 'clarify',
    createdAt: now,
    updatedAt: now,
    cardId,
    discussion: typeof payload?.discussionRef === 'string'
      ? payload.discussionRef.slice(0, 200) : (aggregate.session ?? null),
    intent: {
      raw: intent,
      source: fromCard ? 'card' : 'explicit',
      current: restatement,
      proposal: null,
      history: [],
    },
    bindings: bindingRefs,
    presented: { requirements: null, design: null, plan: null },
    gates: [],
    attempts: [],
    // Only accepted human input resets the bounded automatic retry window.
    noProgressEpoch: 0,
    // P4: durable handoff offers — one per (mode, accepted-inputs) pair.
    // Evidence only: nothing here mints a run or dispatches a mode.
    handoffs: [],
    // P3: the lead's structured blocker (cannot proceed + why), when the
    // last terminal attempt outcome was 'blocked'. Cleared by the next
    // minted attempt; the log keeps the event.
    blocker: null,
    checkpoint: {
      revision: 1,
      updatedAt: now,
      nextSeq: 1,
      droppedLog: 0,
      log: [],
      decisions: [],
      assumptions: [],
      openQuestions: [],
    },
  };
  aggregate.preparation = session;

  // Continuity (R6): documents already attached to the card are adopted as
  // the session's presented set under the initial intent — they were
  // written for this idea; a later restatement still invalidates them.
  for (const kind of DOC_KINDS_PREP) {
    const cur = aggregate.documents?.[kind]?.current;
    const v = cur ? aggregate.documents[kind].versions.find((x) => x && x.versionId === cur) : null;
    if (v) {
      session.presented[kind] = {
        versionId: v.versionId, sha256: v.sha256, at: now,
        via: 'adopted', sourceType: v.source?.type ?? null, attemptId: null,
        draft: v.meta?.draft === true,
        intentSha256: restatement.sha256,
      };
    }
  }

  logEvent(session, now, 'session_started', {
    sessionId: session.sessionId, intent: intent.slice(0, 2000),
    bindings: Object.fromEntries(
      Object.entries(bindingRefs).filter(([, r]) => r).map(([s, r]) => [s, r.bindingId])),
  });
  for (const ref of Object.values(bindingRefs)) {
    if (ref) mintGatesForBinding(D, session, ref, now);
  }
  // The kickoff attempt is the durable anchor for the lead's first turn —
  // minted in the same commit as the session so a late/duplicate result can
  // always be bound or refused.
  mintAttempt(session, 'kickoff', now);
  session.phase = derivePhase(aggregate);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      sessionId: session.sessionId, created: true, reused: false,
      phase: session.phase,
      bindings: Object.fromEntries(
        Object.entries(bindingRefs).filter(([, r]) => r)
          .map(([s, r]) => [s, { bindingId: r.bindingId, digest: r.digest }])),
      gates: session.gates.map((g) => ({
        gateId: g.gateId, type: g.type, stage: g.stage,
        bindingId: g.bindingId, status: g.status,
      })),
    },
  };
}

async function cmdAnswerQuestion(D, ctx, aggregate, payload, now) {
  const session = requireActiveSession(D, aggregate);
  const questionId = text(payload?.questionId, D, 'questionId', { max: 200 });
  const answer = payload?.answer;
  const answerText = typeof answer === 'string' ? answer.trim()
    : isObj(answer) && typeof answer.text === 'string' ? answer.text.trim() : null;
  if (!answerText) {
    fail(D, 422, 'invalid_argument', 'payload.answer must be a non-empty string or {text}');
  }
  if (answerText.length > MAX_TEXT) {
    fail(D, 422, 'invalid_argument', `payload.answer exceeds ${MAX_TEXT} chars`);
  }
  const q = findQuestion(session, questionId);
  if (!q) {
    fail(D, 422, 'question_unknown',
      `question ${questionId} does not exist in session ${session.sessionId}`,
      { questionId, sessionId: session.sessionId });
  }
  const attempt = findAttempt(session, q.attemptId);
  if (attempt && attempt.status === 'cancelled') {
    // A stopped attempt's question is dead — the answer can never be routed
    // to it (KTD2), and the user must see a refusal, not a silent drop. The
    // preserved open question is evidence, not a live prompt.
    fail(D, 409, 'stale_attempt',
      `question ${questionId} belongs to cancelled attempt ${q.attemptId} — ` +
      'its answer can no longer be applied; re-ask on a live attempt',
      { questionId, attemptId: q.attemptId });
  }
  if (q.status === 'answered') {
    if (q.answer === answerText) {
      return {
        aggregate,
        result: {
          questionId, answered: true, alreadyAnswered: true,
          channel: q.channel ?? 'prompt', attemptId: q.attemptId,
        },
      };
    }
    fail(D, 409, 'question_closed',
      `question ${questionId} is already answered — a different answer is a new statement, ` +
      'record it with continue_discussion',
      { questionId });
  }
  if (q.status !== 'open') {
    fail(D, 409, 'question_closed',
      `question ${questionId} is ${q.status} and cannot be answered`, { questionId });
  }
  q.status = 'answered';
  q.answer = answerText;
  q.answeredAt = now;
  session.noProgressEpoch = (session.noProgressEpoch ?? 0) + 1;
  if (attempt) {
    attempt.answers[questionId] = answerText;
    if (attempt.status === 'awaiting_answer') attempt.status = 'running';
  }
  let intentChange = null;
  if (payload?.intent && payload.intent.restate !== undefined) {
    intentChange = applyIntentRestatement(
      D, session, aggregate, text(payload.intent.restate, D, 'intent.restate'), now, 'user');
  }
  // Explicit closures ride along: the user may defer other open questions in
  // the same breath — recorded as decisions, never silently dropped.
  const deferred = [];
  for (const qid of Array.isArray(payload?.defer) ? payload.defer : []) {
    const dq = findQuestion(session, qid);
    if (dq && dq.status === 'open') {
      dq.status = 'deferred';
      dq.answeredAt = now;
      deferred.push(qid);
    }
  }
  logEvent(session, now, 'answer_recorded', {
    questionId, attemptId: q.attemptId, answer: answerText.slice(0, 2000),
    intentChanged: intentChange?.changed === true, deferred,
  });
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      questionId, answered: true, alreadyAnswered: false,
      // P3 routing evidence: 'dialog' answers are delivered to the live turn
      // as extension_ui_response by the lead driver; 'prompt' answers ride
      // the next prompt. The durable record decides — nothing else may.
      channel: q.channel ?? 'prompt',
      attemptId: q.attemptId,
      intentChanged: intentChange?.changed === true,
      invalidatedGates: intentChange?.invalidatedGates ?? [],
      deferred,
    },
  };
}

async function cmdRequestDraft(D, ctx, aggregate, payload, now) {
  const session = requireActiveSession(D, aggregate);
  const kind = text(payload?.kind, D, 'kind', { max: 40 });
  if (!D.DOC_KINDS.includes(kind)) {
    fail(D, 422, 'invalid_argument', `payload.kind must be one of ${D.DOC_KINDS.join(', ')}`);
  }
  // P4: never PRODUCE a plan before the requirements are accepted — the
  // draft attempt would mint an implementation plan bound to nothing the
  // user approved. Requirements/design drafts are unrestricted.
  if (kind === 'plan') {
    const reqA = aggregate.approvals?.requirements ?? null;
    if (!reqA || aggregate.documents?.requirements?.current !== reqA.versionId) {
      fail(D, 422, 'requirements_unapproved',
        'a plan draft requires an accepted current requirements version — ' +
        'approve requirements first, then request the plan');
    }
  }
  const note = payload?.note !== undefined ? text(payload.note, D, 'note') : null;
  // A new explicit drafting request starts a fresh progress epoch; prior
  // stalled turns must not prevent a user-directed retry.
  session.noProgressEpoch = (session.noProgressEpoch ?? 0) + 1;
  supersedeLiveAttempts(session, now);
  const attempt = mintAttempt(session, 'draft', now, { docKind: kind, input: note });
  logEvent(session, now, 'draft_requested', { attemptId: attempt.attemptId, kind, note });
  bumpCheckpoint(session, now);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: { attemptId: attempt.attemptId, kind, status: attempt.status },
  };
}

async function cmdContinueDiscussion(D, ctx, aggregate, payload, now) {
  const session = requireActiveSession(D, aggregate);
  const hasMessage = typeof payload?.text === 'string' && payload.text.trim().length > 0;
  const hasRestate = payload?.intent && payload.intent.restate !== undefined;
  const reaffirm = Array.isArray(payload?.reaffirm) ? payload.reaffirm : [];
  const defer = Array.isArray(payload?.defer) ? payload.defer : [];
  const decisions = Array.isArray(payload?.decisions) ? payload.decisions : [];
  if (!hasMessage && !hasRestate && !reaffirm.length && !defer.length && !decisions.length) {
    fail(D, 422, 'invalid_argument',
      'continue_discussion needs at least one of {text, intent.restate, reaffirm[], defer[], decisions[]}');
  }
  const messageText = hasMessage ? text(payload.text, D, 'text') : null;
  let intentChange = null;
  if (hasRestate) {
    intentChange = applyIntentRestatement(
      D, session, aggregate, text(payload.intent.restate, D, 'intent.restate'), now, 'user');
  }
  // Reaffirm: the user re-anchors presented artifacts to the current intent
  // after reviewing them — the document versions are unchanged (the core
  // approvals on their hashes stand), only the freshness anchor moves.
  const reaffirmed = [];
  for (const kind of reaffirm) {
    if (!DOC_KINDS_PREP.includes(kind)) {
      fail(D, 422, 'invalid_argument',
        `payload.reaffirm entries must be document kinds — got ${JSON.stringify(kind)}`);
    }
    const p = session.presented[kind];
    if (!p) {
      fail(D, 422, 'invalid_argument', `cannot reaffirm ${kind} — nothing is presented for it`);
    }
    const h = restatementHash(session);
    if (p.intentSha256 !== h) {
      p.intentSha256 = h;
      reaffirmed.push(kind);
    }
  }
  const deferred = [];
  for (const qid of defer) {
    const dq = findQuestion(session, qid);
    if (!dq) {
      fail(D, 422, 'question_unknown', `cannot defer unknown question ${qid}`);
    }
    if (dq.status === 'open') {
      dq.status = 'deferred';
      dq.answeredAt = now;
      deferred.push(qid);
      session.checkpoint.decisions.push({
        id: `d_${session.checkpoint.nextSeq}`,
        text: `deferred question ${qid}: ${dq.text.slice(0, 200)}`,
        at: now, source: 'user',
      });
    }
  }
  for (const d of decisions) {
    const t = text(d, D, 'decisions[]', { max: 2000 });
    session.checkpoint.decisions.push({
      id: `d_${session.checkpoint.nextSeq}`, text: t, at: now, source: 'user',
    });
  }
  session.noProgressEpoch = (session.noProgressEpoch ?? 0) + 1;
  // A message or a restatement is new conversational input — it mints the
  // next lead turn (superseding every still-live prior attempt). Pure
  // bookkeeping (reaffirm/defer/decisions alone) does not consume an
  // attempt.
  let attempt = null;
  if (hasMessage || hasRestate) {
    supersedeLiveAttempts(session, now);
    attempt = mintAttempt(session, 'turn', now, { input: messageText });
  }
  logEvent(session, now, 'message', {
    attemptId: attempt?.attemptId ?? null,
    text: messageText ? messageText.slice(0, 2000) : null,
    intentChanged: intentChange?.changed === true,
    reaffirmed, deferred,
    decisions: decisions.length,
  });
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      attemptId: attempt?.attemptId ?? null,
      intentChanged: intentChange?.changed === true,
      invalidatedGates: intentChange?.invalidatedGates ?? [],
      reaffirmed, deferred,
      phase: session.phase,
    },
  };
}

async function cmdStopPreparation(D, ctx, aggregate, payload, now) {
  const session = requireSession(D, aggregate);
  if (session.status === 'stopped') {
    return {
      aggregate,
      result: { sessionId: session.sessionId, status: 'stopped', alreadyStopped: true },
    };
  }
  const reason = typeof payload?.reason === 'string' ? payload.reason.slice(0, 500) : null;
  const cancelled = [];
  for (const a of session.attempts || []) {
    if (a && ATTEMPT_LIVE.has(a.status)) {
      a.status = 'cancelled';
      a.finishedAt = now;
      a.cancel = { requestedAt: now, by: 'user', reason: reason ?? 'stop requested' };
      cancelled.push(a.attemptId);
    }
  }
  session.status = 'stopped';
  session.stoppedAt = now;
  session.stopReason = reason;
  logEvent(session, now, 'session_stopped', { reason, cancelledAttempts: cancelled });
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate); // never 'ready' — session stopped
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      sessionId: session.sessionId, status: 'stopped',
      cancelledAttempts: cancelled,
      // State is preserved, not erased — checkpoint/documents stay on the
      // aggregate; open questions remain recorded (R10).
      openQuestions: (session.checkpoint.openQuestions || [])
        .filter((q) => q.status === 'open').length,
    },
  };
}

async function cmdChangeSkillBinding(D, ctx, aggregate, payload, now) {
  const session = requireActiveSession(D, aggregate);
  const stage = text(payload?.stage, D, 'stage', { max: 40 });
  if (!PREP_STAGES.has(stage)) {
    fail(D, 422, 'invalid_argument',
      `payload.stage must be one of ${[...PREP_STAGES].join('|')}`);
  }
  const bindingId = payload?.bindingId === null ? null
    : payload?.bindingId !== undefined ? text(payload.bindingId, D, 'bindingId', { max: 200 })
    : undefined;
  if (bindingId === undefined) {
    fail(D, 422, 'invalid_argument', 'payload.bindingId is required (null clears the stage binding)');
  }
  const previous = session.bindings[stage] ?? null;
  if (bindingId === null) {
    if (!previous) {
      return { aggregate, result: { stage, bindingId: null, changed: false } };
    }
    session.bindings[stage] = null;
    const inv = invalidateGates(session,
      (g) => g.stage === stage || g.bindingId === previous.bindingId,
      'binding_cleared', now);
    logEvent(session, now, 'binding_changed', {
      stage, from: previous.bindingId, to: null, invalidatedGates: inv });
    bumpCheckpoint(session, now);
    session.phase = derivePhase(aggregate);
    D.bumpControl(aggregate, now);
    return {
      aggregate,
      refreshProjection: true,
      result: { stage, bindingId: null, changed: true, invalidatedGates: inv },
    };
  }
  if (previous && previous.bindingId === bindingId) {
    let currentDigest = null;
    let currentConfig = null;
    try {
      const registry = await ctx.preparationRegistry();
      const b = bindingById(registry, bindingId);
      currentDigest = b.resourceManifest?.digest ?? null;
      currentConfig = bindingConfigDigest(b);
    } catch { /* resolution below re-reports precisely */ }
    if (previous.digest === currentDigest
      && (previous.configDigest ?? null) === currentConfig) {
      return {
        aggregate,
        result: { stage, bindingId, digest: previous.digest, changed: false },
      };
    }
    // Same id, re-pinned resources or a contract edit: treated as a binding
    // refresh — the recorded digests move, dependent gates invalidate (KTD4).
    // This is the explicit migration event: the checkpoint, decisions,
    // questions and presented documents are untouched — only the binding
    // version snapshot and its dependent gates move.
  }
  const ref = await resolveBindingRef(D, ctx, stage, bindingId, now);
  session.bindings[stage] = ref;
  const migrated = previous && previous.bindingId === bindingId;
  const inv = invalidateGates(session,
    (g) => (g.stage === stage || (previous && g.bindingId === previous.bindingId))
      && !(g.bindingId === ref.bindingId && g.digest === ref.digest
        && (g.configDigest ?? null) === (ref.configDigest ?? null)),
    migrated
      ? (previous.digest === ref.digest ? 'binding_reconfigured' : 'binding_repinned')
      : 'binding_changed', now);
  mintGatesForBinding(D, session, ref, now);
  logEvent(session, now, migrated ? 'binding_migrated' : 'binding_changed', {
    stage, from: previous?.bindingId ?? null, to: bindingId,
    digest: ref.digest, configDigest: ref.configDigest ?? null,
    fromDigest: previous?.digest ?? null, fromConfigDigest: previous?.configDigest ?? null,
    invalidatedGates: inv });
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      stage, bindingId, digest: ref.digest, changed: true,
      invalidatedGates: inv,
      gates: session.gates.filter((g) => g.bindingId === bindingId && g.digest === ref.digest)
        .map((g) => ({ gateId: g.gateId, type: g.type, status: g.status })),
    },
  };
}

async function cmdConfirmGate(D, ctx, aggregate, payload, now) {
  const session = requireActiveSession(D, aggregate);
  const gateId = text(payload?.gateId, D, 'gateId', { max: 200 });
  const gate = findGate(session, gateId);
  if (!gate) {
    fail(D, 422, 'gate_unknown',
      `gate ${gateId} does not exist in session ${session.sessionId}`, { gateId });
  }
  // The binding must still be assigned at the recorded digest at
  // confirmation time — confirming a gate whose skill resources or contract
  // moved is confirming a different thing than was presented.
  const assignment = Object.values(session.bindings || {}).find(
    (r) => r && r.bindingId === gate.bindingId && r.digest === gate.digest
      && (gate.configDigest == null || r.configDigest === gate.configDigest));
  if (!assignment) {
    fail(D, 409, 'gate_binding_stale',
      `gate ${gateId} was minted under binding ${gate.bindingId}@${gate.digest.slice(0, 12)}… ` +
      'which is no longer the assignment — change_skill_binding refreshed it',
      { gateId, bindingId: gate.bindingId });
  }
  const registry = await ctx.preparationRegistry();
  let binding;
  try {
    binding = bindingById(registry, gate.bindingId);
  } catch (e) {
    fail(D, 422, e.code ?? 'unknown_binding', e.message, { bindingId: gate.bindingId });
  }
  try {
    assertRouteAvailable(binding);
  } catch (e) {
    fail(D, 422, e.code ?? 'route_unavailable', e.message, { bindingId: gate.bindingId });
  }
  if ((binding.resourceManifest?.digest ?? null) !== gate.digest
    || (gate.configDigest != null && bindingConfigDigest(binding) !== gate.configDigest)) {
    fail(D, 409, 'gate_digest_stale',
      `binding ${gate.bindingId} was re-pinned — the gate must be re-minted ` +
      'via change_skill_binding before it can confirm',
      { gateId, bindingId: gate.bindingId });
  }
  const subject = gateSubjectFor(D, session, gate); // binds what is presented NOW
  // A combined document approval + SkillGate confirmation must not approve a
  // replacement presented between its two commands. Legacy callers may omit
  // the pin; callers supplying it bind exactly the subject they reviewed.
  if (payload && Object.hasOwn(payload, 'expectedSubject')) {
    const expected = payload.expectedSubject;
    const keys = Object.keys(subject);
    const matches = expected !== null && typeof expected === 'object'
      && !Array.isArray(expected) && Object.keys(expected).length === keys.length
      && keys.every((key) => Object.hasOwn(expected, key) && expected[key] === subject[key]);
    if (!matches) {
      fail(D, 409, 'gate_subject_changed',
        'the presented subject changed — review the current idea or document before confirming',
        { gateId, subject });
    }
  }
  const alreadyConfirmed = gate.status === 'confirmed'
    && JSON.stringify(gate.subject) === JSON.stringify(subject);
  gate.subject = subject;
  gate.status = 'confirmed';
  gate.confirmedAt = now;
  gate.confirmedBy = typeof payload?.by === 'string' ? payload.by.slice(0, 64) : 'user';
  gate.invalidatedAt = null;
  gate.invalidationReason = null;
  logEvent(session, now, 'gate_confirmed', {
    gateId, type: gate.type, bindingId: gate.bindingId, subject, alreadyConfirmed });
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: { gateId, status: 'confirmed', subject, alreadyConfirmed, phase: session.phase },
  };
}

// ---------------------------------------------------------------------------
// P4 handoff — handoff_preparation (R11, KTD8)
// ---------------------------------------------------------------------------
//
// A handoff is a durable OFFER of the accepted package to a named downstream
// mode — never a launch. The record freezes the exact inputs the readiness
// gate just proved (approved requirements+plan version/hash, optional design
// version, intent hash, agreed check commands) plus the discussion context a
// consumer needs so no new interview is required. Nothing here mints a run,
// claims a workspace, or dispatches another mode; implementation starts only
// through the core `start` lifecycle, which re-checks every condition at its
// own gate.

// The frozen inputs a handoff offers — the same shape the implementation
// start binds (requirements/plan approval pins, optional design pointer,
// the agreed check commands, and the intent hash the package was built
// under).
function handoffInputs(aggregate, session) {
  const reqA = aggregate.approvals?.requirements ?? null;
  const planA = aggregate.approvals?.plan ?? null;
  const designCur = aggregate.documents?.design?.current ?? null;
  const designV = designCur
    ? (aggregate.documents.design.versions || []).find((v) => v && v.versionId === designCur)
    : null;
  return {
    requirements: reqA ? { versionId: reqA.versionId, sha256: reqA.sha256 } : null,
    plan: planA
      ? {
          versionId: planA.versionId, sha256: planA.sha256,
          requirementsVersionId: planA.requirementsVersionId ?? null,
          requirementsSha256: planA.requirementsSha256 ?? null,
          checks: structuredClone(planA.checks || []),
          checksSource: planA.checksSource ?? null,
        }
      : null,
    design: designV ? { versionId: designV.versionId, sha256: designV.sha256 } : null,
    intentSha256: restatementHash(session),
  };
}

// The discussion context the package carries — what an implementation mode
// would otherwise re-ask. Bounded by the existing checkpoint caps.
function handoffContext(session) {
  const cp = session.checkpoint || {};
  return {
    intentRaw: session.intent?.raw ?? null,
    restatement: session.intent?.current?.text ?? null,
    decisions: (cp.decisions || []).map((d) => ({ id: d.id, text: d.text })),
    assumptions: (cp.assumptions || []).map((a) => ({ id: a.id, text: a.text })),
    openQuestions: (cp.openQuestions || []).map((q) => ({
      questionId: q.questionId, text: q.text,
      status: q.status, blocking: q.blocking === true,
    })),
  };
}

function handoffView(h) {
  return {
    handoffId: h.handoffId, mode: h.mode, implemented: h.implemented === true,
    at: h.at, by: h.by ?? null, note: h.note ?? null,
    inputs: h.inputs, context: h.context,
    supersededBy: h.supersededBy ?? null, supersededAt: h.supersededAt ?? null,
  };
}

async function cmdHandoffPreparation(D, ctx, aggregate, payload, now) {
  const session = requireSession(D, aggregate);
  const mode = text(payload?.mode, D, 'mode', { max: 40 });
  if (!HANDOFF_MODES.has(mode)) {
    fail(D, 422, 'invalid_argument',
      `payload.mode must be one of ${[...HANDOFF_MODES].join('|')} — ` +
      'a handoff names a downstream mode but never starts it');
  }
  const note = payload?.note !== undefined ? text(payload.note, D, 'note', { max: 500 }) : null;
  // The offer exists only when the package is actually complete — the same
  // readiness the implementation start gate re-proves (registry digests and
  // a fresh filesystem verify of every pinned binding resource included).
  const evald = await evaluateReadiness(D, ctx, aggregate, { verify: true });
  if (!evald.ready) {
    fail(D, 422, 'preparation_not_ready',
      `handoff to ${mode} is blocked: preparation ${session.sessionId} is not ready — ` +
      `resolve ${evald.blockers.length} blocker(s) first`,
      { sessionId: session.sessionId, mode, blockers: evald.blockers });
  }
  const inputs = handoffInputs(aggregate, session);
  const inputsKey = JSON.stringify(inputs);
  const priorSame = (session.handoffs || []).filter((h) => h && h.mode === mode);
  const same = priorSame.find(
    (h) => !h.supersededBy && JSON.stringify(h.inputs) === inputsKey);
  if (same) {
    // Same mode + the same accepted inputs → the recorded offer stands;
    // re-offering is a no-op, not a second package.
    return {
      aggregate,
      result: { handoff: handoffView(same), reused: true, mode },
    };
  }
  const rec = {
    handoffId: `ph_${randomUUID()}`,
    sessionId: session.sessionId,
    mode,
    implemented: HANDOFF_IMPLEMENTED.has(mode),
    at: now,
    by: typeof payload?.by === 'string' ? payload.by.slice(0, 64) : 'user',
    inputs,
    context: handoffContext(session),
    note,
    supersededBy: null,
    supersededAt: null,
  };
  session.handoffs = session.handoffs || [];
  for (const h of priorSame) {
    if (!h.supersededBy) {
      h.supersededBy = rec.handoffId;
      h.supersededAt = now;
    }
  }
  session.handoffs.push(rec);
  if (session.handoffs.length > HANDOFFS_CAP) {
    session.handoffs.splice(0, session.handoffs.length - HANDOFFS_CAP);
  }
  logEvent(session, now, 'handoff_offered', {
    handoffId: rec.handoffId, mode, implemented: rec.implemented,
    requirements: inputs.requirements?.versionId ?? null,
    plan: inputs.plan?.versionId ?? null,
  });
  bumpCheckpoint(session, now);
  D.bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: { handoff: handoffView(rec), reused: false, mode },
  };
}

// ---------------------------------------------------------------------------
// Internal channel: prep_result — the lead runtime's durable result seam.
// ---------------------------------------------------------------------------
//
// The lead driver (P3) reports an attempt outcome through here. Every check
// is re-derived from durable state — the attempt must exist on the CURRENT
// session and still be live. Results for cancelled/terminal/foreign
// attempts are recorded as ignored outcomes (idempotent, never applied):
// they can never mint a document, answer a question, or move the phase.

async function cmdPrepResult(D, ctx, aggregate, payload, now) {
  const session = sessionOf(aggregate);
  const attemptId = typeof payload?.attemptId === 'string' ? payload.attemptId : null;
  const ignored = (reason, extra = {}) => ({
    aggregate,
    result: { applied: false, reason, attemptId, ...extra },
  });
  if (!attemptId) {
    fail(D, 422, 'invalid_argument', 'payload.attemptId is required');
  }
  if (!session) return ignored('no_session');
  const attempt = findAttempt(session, attemptId);
  if (!attempt) return ignored('attempt_unknown');           // foreign/archived session
  if (session.status !== 'active') return ignored('session_stopped');
  if (attempt.status === 'cancelled') return ignored('attempt_cancelled');
  if (!ATTEMPT_LIVE.has(attempt.status)) return ignored('attempt_terminal');

  const result = isObj(payload?.result) ? payload.result : {};
  const outcome = payload?.outcome ?? 'completed';
  if (!RESULT_OUTCOMES.has(outcome)) {
    fail(D, 422, 'invalid_argument',
      `payload.outcome must be one of ${[...RESULT_OUTCOMES].join('|')} — got ${JSON.stringify(outcome)}`);
  }

  // P2 (KTD6): a skill result is DATA — the channel vocabulary is
  // whitelisted. Any other top-level channel (commands/api/toolCalls/exec/…)
  // or unknown keys inside document/proposal/handoff/blocker refuse the
  // result outright with a structured error — never executed, never
  // silently dropped, and the refusal itself is the audit trail.
  try {
    assertResultChannels(result);
  } catch (e) {
    if (e instanceof RuntimeError) {
      const { name, code, ...rest } = e;
      fail(D, 422, code, e.message, rest);
    }
    throw e;
  }

  // A failed turn applies NOTHING — the attempt records the failure and the
  // session is otherwise untouched.
  if (outcome === 'failed') {
    attempt.status = 'failed';
    attempt.finishedAt = now;
    attempt.result = {
      error: typeof result.note === 'string' ? result.note.slice(0, 500) : 'lead reported failure',
      progress: false,
    };
    logEvent(session, now, 'attempt_failed', { attemptId });
    bumpCheckpoint(session, now);
    session.phase = derivePhase(aggregate);
    return {
      aggregate,
      refreshProjection: true,
      result: { applied: true, attemptId, status: 'failed' },
    };
  }

  // P3: a blocked turn applies NO state changes except the structured
  // blocker record — the lead declared it cannot proceed (repeated
  // no-progress, an unservable binding, missing input). The blocker is
  // durable session evidence and surfaces in the view; the next user
  // instruction (a minted attempt) supersedes it.
  if (outcome === 'blocked') {
    const bl = isObj(result.blocker) ? result.blocker : null;
    if (!bl || typeof bl.code !== 'string' || !bl.code) {
      fail(D, 422, 'result_malformed',
        'a blocked outcome requires result.blocker {code, detail}');
    }
    attempt.status = 'blocked';
    attempt.finishedAt = now;
    attempt.result = {
      blocker: { code: bl.code, detail: bl.detail ?? '', retryable: bl.retryable === true },
      progress: false,
    };
    session.blocker = {
      code: bl.code, detail: String(bl.detail ?? '').slice(0, 2000),
      retryable: bl.retryable === true, attemptId, at: now,
    };
    logEvent(session, now, 'attempt_blocked', {
      attemptId, code: bl.code, detail: session.blocker.detail.slice(0, 500) });
    bumpCheckpoint(session, now);
    session.phase = derivePhase(aggregate);
    return {
      aggregate,
      refreshProjection: true,
      result: { applied: true, attemptId, status: 'blocked', blocker: session.blocker },
    };
  }

  // A declared blocker under a 'completed' outcome is a contradiction —
  // refusing is honest; silently applying the rest and dropping the
  // blocker is not.
  if (result.blocker !== undefined && result.blocker !== null) {
    fail(D, 422, 'result_malformed',
      'result.blocker requires outcome "blocked" — a blocker is a terminal outcome, not side data');
  }

  const applied = {
    questions: [], openQuestionIds: [], deduped: 0,
    decisions: 0, assumptions: 0, document: null, proposal: null, handoff: null,
  };

  if (result.proposal !== undefined) {
    const p = isObj(result.proposal) ? result.proposal : {};
    if (p.intentRestatement !== undefined) {
      const t = text(p.intentRestatement, D, 'result.proposal.intentRestatement');
      // A lead-proposed restatement becomes the presented intent — but
      // nothing is approved or gate-confirmed by it; the intent gate still
      // needs the explicit user confirmation, and prior confirmations of a
      // superseded restatement invalidate.
      const change = applyIntentRestatement(D, session, aggregate, t, now, 'lead');
      session.intent.proposal = { text: t, sha256: change.sha256, at: now, attemptId };
      applied.proposal = { intentSha256: change.sha256, changed: change.changed };
    }
  }
  // P3: one minting path for every question the lead reports. Result
  // questions arrive AFTER the turn ended → channel 'prompt' (the answer
  // rides the next prompt). Mid-turn native dialogs are minted earlier via
  // prep_question (channel 'dialog'); the same-text dedupe here means a
  // question the turn already asked as a dialog is never double-minted by
  // the result block.
  const pushQuestion = (raw, tag, { channel = 'prompt', dialog = null } = {}) => {
    const qt = text(isObj(raw) ? raw.text : raw, D, tag, { max: 4000 });
    const blocking = isObj(raw) ? raw.blocking !== false : true;
    const dup = findQuestionDup(session, qt);
    if (dup?.kind === 'answered') {
      applied.deduped += 1;
      logEvent(session, now, 'question_deduped', {
        questionId: dup.question.questionId, attemptId, state: 'answered' });
      return { record: dup.question, minted: false, open: false };
    }
    if (dup?.kind === 'open') {
      const q = dup.question;
      if (q.attemptId !== attemptId) {
        // The still-open question is re-presented by the live attempt —
        // rehome it so its answer applies here (the prior attempt kept
        // evidence of having asked first via the log).
        logEvent(session, now, 'question_rebound',
          { questionId: q.questionId, fromAttemptId: q.attemptId, attemptId });
        q.attemptId = attemptId;
      }
      if (!attempt.questionIds.includes(q.questionId)) {
        attempt.questionIds.push(q.questionId);
      }
      if (channel === 'dialog' && dialog) {
        q.channel = 'dialog';
        q.dialog = dialog;
      }
      applied.deduped += 1;
      applied.openQuestionIds.push(q.questionId);
      logEvent(session, now, 'question_represented',
        { questionId: q.questionId, attemptId, channel });
      return { record: q, minted: false, open: true };
    }
    if ((session.checkpoint.openQuestions || []).length >= QUESTIONS_CAP) {
      fail(D, 422, 'question_cap', `session openQuestions cap ${QUESTIONS_CAP} reached`);
    }
    const rec = {
      questionId: `pq_${randomUUID()}`,
      text: qt,
      blocking,
      status: 'open',
      channel,               // 'prompt' (post-turn) or 'dialog' (native ui)
      dialog,                // {requestId, method} for channel 'dialog'
      askedAt: now,
      answeredAt: null,
      answer: null,
      attemptId,
      intentSha256: restatementHash(session),
    };
    session.checkpoint.openQuestions.push(rec);
    attempt.questionIds.push(rec.questionId);
    applied.questions.push(rec.questionId);
    applied.openQuestionIds.push(rec.questionId);
    logEvent(session, now, 'question_opened',
      { questionId: rec.questionId, attemptId, blocking, channel, text: qt.slice(0, 500) });
    return { record: rec, minted: true, open: true };
  };
  for (const q of Array.isArray(result.questions) ? result.questions : []) {
    pushQuestion(q, 'result.questions[].text');
  }
  for (const d of Array.isArray(result.decisions) ? result.decisions : []) {
    const t = text(isObj(d) ? d.text : d, D, 'result.decisions[]', { max: 2000 });
    // P3: replay-safe — a restarted turn that re-reports the same decision
    // records nothing new (exact-text dedupe against the checkpoint).
    if (session.checkpoint.decisions.some((x) => x && x.text === t)) continue;
    session.checkpoint.decisions.push({
      id: `d_${session.checkpoint.nextSeq}`, text: t, at: now, source: `attempt:${attemptId}`,
    });
    applied.decisions += 1;
  }
  for (const a of Array.isArray(result.assumptions) ? result.assumptions : []) {
    const t = text(isObj(a) ? a.text : a, D, 'result.assumptions[]', { max: 2000 });
    if (session.checkpoint.assumptions.some((x) => x && x.text === t)) continue;
    session.checkpoint.assumptions.push({
      id: `a_${session.checkpoint.nextSeq}`, text: t, at: now, source: `attempt:${attemptId}`,
    });
    applied.assumptions += 1;
  }
  if (result.document !== undefined && result.document !== null) {
    const doc = result.document;
    if (!isObj(doc)) {
      fail(D, 422, 'invalid_argument', 'result.document must be an object {kind, text, ...}');
    }
    const kind = doc.kind;
    if (!D.DOC_KINDS.includes(kind)) {
      fail(D, 422, 'document_invalid', `result.document.kind must be one of ${D.DOC_KINDS.join(', ')}`);
    }
    // A draft attempt is contract-bound to the kind it was minted for —
    // a request_draft for requirements that returns a plan is off-contract.
    if (attempt.docKind && kind !== attempt.docKind) {
      fail(D, 422, 'result_off_contract',
        `draft attempt ${attemptId} was minted for a ${attempt.docKind} document — ` +
        `a ${kind} result is off-contract`,
        { attemptId, expected: attempt.docKind, kind });
    }
    // P2: the stage's assigned binding declares its result contract. A
    // contract-bound route may only deliver what it declared — a document
    // where the contract is conversation/review-only (importAs 'none') is
    // refused, not silently imported; a 'draft' contract imports as draft
    // regardless of the flag the result carried. A stage with NO binding
    // (the plain lead) keeps the P1 semantics — no contract applies.
    const stageRef = session.bindings?.[kind] ?? null;
    const contract = stageRef?.result ?? null;
    if (contract) {
      if (contract.importAs === 'none') {
        fail(D, 422, 'result_off_contract',
          `binding ${stageRef.bindingId} declares no document import (importAs=none) — ` +
          `a ${kind} document result is off-contract`,
          { bindingId: stageRef.bindingId, kind });
      }
      if (contract.docKind && contract.docKind !== kind) {
        fail(D, 422, 'result_off_contract',
          `binding ${stageRef.bindingId} imports ${contract.docKind} documents, not ${kind}`,
          { bindingId: stageRef.bindingId, kind, contractDocKind: contract.docKind });
      }
      if (contract.importAs === 'draft') doc.draft = true;
    }
    const draft = doc.draft === true;
    const docQuestionIds = [];
    if (doc.openQuestions !== undefined) {
      if (!Array.isArray(doc.openQuestions)) {
        fail(D, 422, 'document_invalid', 'result.document.openQuestions must be an array');
      }
      for (const q of doc.openQuestions) {
        const rec = pushQuestion(q, 'result.document.openQuestions[]');
        docQuestionIds.push(rec.record.questionId);
      }
    }
    const version = await attachSessionDocument(D, ctx, aggregate, session, {
      kind,
      body: typeof doc.text === 'string' ? doc.text : '',
      sourceRecord: {
        type: 'preparation',
        sessionId: session.sessionId,
        attemptId,
      },
      meta: {
        draft,
        openQuestionIds: docQuestionIds,
        intentSha256: restatementHash(session),
        // Provenance for contract-bound imports: which binding version
        // produced this document.
        ...(stageRef ? {
          bindingId: stageRef.bindingId,
          bindingDigest: stageRef.digest,
          bindingConfigDigest: stageRef.configDigest ?? null,
        } : {}),
      },
      requirementsVersionId: doc.requirementsVersionId,
      now,
    });
    presentVersion(session, kind, version, now, 'prep_result', attemptId);
    applied.document = {
      kind, versionId: version.versionId, sha256: version.sha256, draft,
      openQuestionIds: docQuestionIds,
      // P4: a plan's exact requirements binding is part of the import
      // evidence — the approved version+hash it was written for.
      ...(kind === 'plan' ? { requirements: version.requirements ?? null } : {}),
    };
    logEvent(session, now, 'document_presented', {
      kind, versionId: version.versionId, sha256: version.sha256,
      draft, via: 'prep_result', attemptId });
  }

  // Host-only recovery of a skill's terminal routing menu after an actual
  // document import. Never fabricate an answer or retire product questions.
  if (payload.closeRoutingQuestionIds !== undefined) {
    const ids = payload.closeRoutingQuestionIds;
    const contract = session.bindings?.[attempt.docKind]?.result;
    if (!Array.isArray(ids) || !applied.document || attempt.kind !== 'draft'
        || contract?.mode !== 'workspace_artifact') {
      fail(D, 422, 'result_off_contract', 'routing closure requires an imported draft artifact');
    }
    for (const id of ids) {
      const q = session.checkpoint.openQuestions.find((q) => q.questionId === id);
      if (!q || q.attemptId !== attemptId || q.status !== 'open'
          || !isTerminalRoutingMenu(q.text, q.dialog?.method, q.dialog?.options)) {
        fail(D, 422, 'result_off_contract', "only this draft's terminal routing menu may be closed");
      }
      q.status = 'deferred';
      logEvent(session, now, 'routing_menu_closed', { questionId: id, attemptId,
        reason: 'document_imported_host_owns_handoff' });
    }
  }

  // P2 (KTD5): a declared route handoff is RECORDED evidence — the menu
  // option the skill offered, with the mode the binding declared
  // (host_choice/recorded/denied). It is never dispatched from here; an
  // undeclared transition is refused outright.
  if (result.handoff !== undefined && result.handoff !== null) {
    const h = result.handoff;
    if (!isObj(h) || typeof h.to !== 'string' || !h.to) {
      fail(D, 422, 'result_malformed', 'result.handoff must be {to: <bindingId>}');
    }
    const declaring = Object.values(session.bindings || {}).find(
      (r) => r && (r.result?.handoffs ?? []).some((x) => x.to === h.to));
    const decl = declaring?.result?.handoffs?.find((x) => x.to === h.to) ?? null;
    if (!decl) {
      fail(D, 422, 'result_off_contract',
        `result.handoff.to ${JSON.stringify(h.to)} is declared by no assigned binding — ` +
        'undeclared route transitions are refused, not dispatched',
        { to: h.to });
    }
    applied.handoff = {
      to: decl.to, mode: decl.mode, reason: decl.reason, offeredBy: declaring.bindingId,
    };
    logEvent(session, now, 'handoff_recorded', {
      to: decl.to, mode: decl.mode, offeredBy: declaring.bindingId,
      detail: typeof h.detail === 'string' ? h.detail.slice(0, 500) : '',
    });
  }

  // Turn bookkeeping: a result that leaves open questions (minted or
  // re-presented) parks the attempt in awaiting_answer (the lead waits);
  // otherwise the turn completes.
  attempt.status = applied.openQuestionIds.length ? 'awaiting_answer' : 'completed';
  attempt.finishedAt = attempt.status === 'completed' ? now : null;
  // P3: `progress` is the durable no-progress accounting the lead driver
  // reads — an attempt counts as progress when any of its turns added something NEW
  // (a minted question, a document, a proposal, decisions/assumptions, a
  // handoff). A bare note or all-deduped questions do not advance the
  // discussion.
  const progress = applied.questions.length > 0 || !!applied.document
    || !!applied.proposal || applied.decisions > 0 || applied.assumptions > 0
    || !!applied.handoff;
  attempt.result = {
    note: typeof result.note === 'string' ? result.note.slice(0, 1000) : null,
    questions: applied.questions,
    deduped: applied.deduped,
    document: applied.document,
    // An attempt can span question/answer turns. Never erase substantive
    // progress from an earlier turn when its continuation repeats or is empty.
    progress: attempt.result?.progress === true || progress,
    progressEpoch: session.noProgressEpoch ?? 0,
  };
  logEvent(session, now, 'result_applied', {
    attemptId, status: attempt.status,
    questions: applied.questions.length, deduped: applied.deduped,
    document: applied.document?.kind ?? null, progress,
  });
  // A repeated answered question is filtered above, but filtering must not
  // silently terminate the discussion after the user's answer. Schedule a
  // corrective turn atomically with the rejected repeat. Attempts containing
  // only repeats retain progress=false, so the durable no-progress bound stops a
  // model that keeps repeating instead of spending indefinitely. A bare
  // completion, an actual decision/proposal/document, or an open question
  // does not trigger another turn. Native dialog answers keep their routing.
  let continuationAttemptId = null;
  if (!progress && attempt.status === 'completed' && applied.deduped > 0
      && !session.checkpoint.openQuestions.some((q) => q.status === 'open')) {
    const followup = mintAttempt(session, 'turn', now, {
      input: 'Your previous result repeated an already answered question and was discarded. ' +
        'Read the recorded questions and answers in the checkpoint. Continue from the recorded user ' +
        'answer: ask the next unresolved question, or propose the clarified intent for explicit ' +
        'confirmation. Do not repeat an answered question or start implementation.',
    });
    continuationAttemptId = followup.attemptId;
  }
  bumpCheckpoint(session, now);
  session.phase = derivePhase(aggregate);
  return {
    aggregate,
    refreshProjection: true,
    result: { applied: true, attemptId, status: attempt.status, ...applied, continuationAttemptId },
  };
}

// ---------------------------------------------------------------------------
// Internal channel: prep_question — a mid-turn native dialog becomes a
// durable question BEFORE the lead driver binds its rpc request id (P3,
// KTD2). The durable record is what answer_question addresses; the rpc
// request id is a rebindable presentation detail on it. Minting a question
// mid-turn does NOT park the attempt — the turn is still in flight on the
// CLI; the attempt keeps 'running'.
// ---------------------------------------------------------------------------

async function cmdPrepQuestion(D, ctx, aggregate, payload, now) {
  const session = sessionOf(aggregate);
  const attemptId = typeof payload?.attemptId === 'string' ? payload.attemptId : null;
  const ignored = (reason, extra = {}) => ({
    aggregate,
    result: { minted: false, reason, attemptId, questionId: null, ...extra },
  });
  if (!attemptId) {
    fail(D, 422, 'invalid_argument', 'payload.attemptId is required');
  }
  if (!session) return ignored('no_session');
  const attempt = findAttempt(session, attemptId);
  if (!attempt) return ignored('attempt_unknown');
  if (session.status !== 'active') return ignored('session_stopped');
  if (attempt.status === 'cancelled') return ignored('attempt_cancelled');
  if (!ATTEMPT_LIVE.has(attempt.status)) return ignored('attempt_terminal');

  const q = isObj(payload?.question) ? payload.question : {};
  const qt = text(q.text, D, 'question.text', { max: 4000 });
  const blocking = q.blocking !== false;
  const channel = q.channel === undefined ? 'prompt' : q.channel;
  if (!QUESTION_CHANNELS.has(channel)) {
    fail(D, 422, 'invalid_argument',
      `question.channel must be one of ${[...QUESTION_CHANNELS].join('|')} — ` +
      'a question is either a live native dialog or a post-turn prompt entry');
  }
  let dialog = null;
  if (channel === 'dialog') {
    const d = isObj(q.dialog) ? q.dialog : {};
    const requestId = d.requestId;
    if ((typeof requestId !== 'string' || !requestId.length)
        && typeof requestId !== 'number') {
      fail(D, 422, 'invalid_argument',
        'a dialog question requires question.dialog.requestId (the rpc request identity)');
    }
    const method = typeof d.method === 'string' && d.method
      ? d.method.slice(0, 40) : 'input';
    dialog = { requestId, method };
    // A select dialog's options are part of what was presented — keep them
    // so the question card renders the same choices on re-presentation.
    if (Array.isArray(d.options) && d.options.length) {
      dialog.options = d.options.slice(0, 24).map((o) => String(o).slice(0, 200));
    }
  }

  // Dedupe BEFORE minting: the durable question record survives process
  // loss; a re-presented ask rebinds to the FRESH rpc request id rather
  // than minting a second question card. An answer recorded while the
  // process was down satisfies the re-ask immediately.
  const dup = findQuestionDup(session, qt);
  if (dup?.kind === 'answered') {
    logEvent(session, now, 'question_deduped',
      { questionId: dup.question.questionId, attemptId, state: 'answered', channel });
    bumpCheckpoint(session, now);
    return {
      aggregate,
      result: {
        minted: false, deduped: 'answered', questionId: dup.question.questionId,
        attemptId, answered: true, answer: dup.question.answer,
      },
    };
  }
  if (dup?.kind === 'open') {
    const rec = dup.question;
    if (rec.attemptId !== attemptId) {
      logEvent(session, now, 'question_rebound',
        { questionId: rec.questionId, fromAttemptId: rec.attemptId, attemptId });
      rec.attemptId = attemptId;
    }
    if (!attempt.questionIds.includes(rec.questionId)) {
      attempt.questionIds.push(rec.questionId);
    }
    const rebound = channel === 'dialog' && dialog
      && JSON.stringify(rec.dialog) !== JSON.stringify(dialog);
    if (channel === 'dialog' && dialog) {
      rec.channel = 'dialog';
      rec.dialog = dialog;
    }
    logEvent(session, now, 'question_represented', {
      questionId: rec.questionId, attemptId, channel, rebound });
    bumpCheckpoint(session, now);
    return {
      aggregate,
      result: {
        minted: false, deduped: 'open', questionId: rec.questionId,
        attemptId, rebound, answered: false,
      },
    };
  }

  if ((session.checkpoint.openQuestions || []).length >= QUESTIONS_CAP) {
    fail(D, 422, 'question_cap', `session openQuestions cap ${QUESTIONS_CAP} reached`);
  }
  const rec = {
    questionId: `pq_${randomUUID()}`,
    text: qt,
    blocking,
    status: 'open',
    channel,
    dialog,
    askedAt: now,
    answeredAt: null,
    answer: null,
    attemptId,
    intentSha256: restatementHash(session),
  };
  session.checkpoint.openQuestions.push(rec);
  attempt.questionIds.push(rec.questionId);
  attempt.result = { ...attempt.result, progress: true, progressEpoch: session.noProgressEpoch ?? 0 };
  logEvent(session, now, 'question_opened',
    { questionId: rec.questionId, attemptId, blocking, channel, text: qt.slice(0, 500) });
  bumpCheckpoint(session, now);
  return {
    aggregate,
    result: {
      minted: true, questionId: rec.questionId, attemptId,
      channel, answered: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

export function preparationSummary(aggregate) {
  const s = sessionOf(aggregate);
  if (!s) return null;
  const sync = evaluateReadinessSync(aggregate);
  const gates = { pending: 0, confirmed: 0, invalidated: 0 };
  for (const g of s.gates || []) gates[g.status] = (gates[g.status] ?? 0) + 1;
  const openQuestions = (s.checkpoint?.openQuestions || []).filter((q) => q && q.status === 'open');
  // Live-attempt counts let a list row (and the runner-side supervisor's
  // sweep) see "this session has work to drive" without loading the full
  // preparation view — a minted running attempt is exactly the durable
  // signal that the lead owes the card a turn.
  const attempts = { running: 0, awaitingAnswer: 0 };
  for (const a of s.attempts || []) {
    if (a?.status === 'running') attempts.running += 1;
    else if (a?.status === 'awaiting_answer') attempts.awaitingAnswer += 1;
  }
  return {
    sessionId: s.sessionId,
    status: s.status,
    phase: derivePhase(aggregate),
    ready: sync.ready,
    blockerCount: sync.blockers.length,
    gates,
    openQuestions: {
      open: openQuestions.length,
      blocking: openQuestions.filter((q) => q.blocking === true).length,
    },
    attempts,
    handoffs: (s.handoffs || []).filter((h) => h && !h.supersededBy).length,
    updatedAt: s.updatedAt,
  };
}

// Per-kind completeness + the discussion counters — the surface a card needs
// to show WHAT is missing, never a synthetic confidence number (R4).
function completenessView(aggregate, s) {
  const out = {};
  for (const kind of DOC_KINDS_PREP) {
    const p = s.presented?.[kind] ?? null;
    if (!p) {
      out[kind] = 'absent';
      continue;
    }
    if (kind === 'design') {
      // Design has no core approval (R5) — its acceptance signal is a
      // confirmed artifact gate bound to the PRESENTED version; a bare
      // presented design is 'presented', a gated one 'confirmed'.
      const confirmed = (s.gates || []).some(
        (g) => g && g.status === 'confirmed' && g.subject?.kind === 'document'
          && g.subject.docKind === 'design'
          && g.subject.versionId === p.versionId && g.subject.sha256 === p.sha256);
      out[kind] = p.draft === true && !confirmed ? 'draft'
        : confirmed ? 'confirmed' : 'presented';
      continue;
    }
    const approved = aggregate.approvals?.[kind]?.versionId === p.versionId
      && aggregate.documents?.[kind]?.current === p.versionId;
    out[kind] = p.draft === true && !approved ? 'draft'
      : approved ? 'approved' : 'presented';
  }
  const oqs = s.checkpoint?.openQuestions || [];
  out.assumptions = (s.checkpoint?.assumptions || []).length;
  out.decisions = (s.checkpoint?.decisions || []).length;
  out.openQuestions = {
    open: oqs.filter((q) => q && q.status === 'open').length,
    blocking: oqs.filter((q) => q && q.status === 'open' && q.blocking === true).length,
    answered: oqs.filter((q) => q && q.status === 'answered').length,
    deferred: oqs.filter((q) => q && q.status === 'deferred').length,
  };
  return out;
}

export function gateView(g) {
  return {
    gateId: g.gateId, bindingId: g.bindingId, digest: g.digest,
    type: g.type, stage: g.stage, status: g.status,
    subject: g.subject ?? null,
    confirmedAt: g.confirmedAt ?? null,
    invalidatedAt: g.invalidatedAt ?? null,
    invalidationReason: g.invalidationReason ?? null,
  };
}

// The GET /preparation view — everything a card drawer/chat needs, plus the
// full async readiness (registry digest compare included; the filesystem
// re-verify runs at the implementation start gate).
export async function preparationView(D, ctx, aggregate) {
  const s = sessionOf(aggregate);
  if (!s) return null;
  const readiness = await evaluateReadiness(D, ctx, aggregate, { verify: false });
  // Handoff staleness is DERIVED: a record is current only while its frozen
  // inputs still equal what the approvals+intent now bind. New versions,
  // restatements, or revoked approvals mark every record stale — nothing
  // inherits validity (P4).
  const curInputs = handoffInputs(aggregate, s);
  const curInputsKey = JSON.stringify(curInputs);
  return {
    sessionId: s.sessionId,
    schemaVersion: s.schemaVersion,
    status: s.status,
    phase: derivePhase(aggregate),
    ready: readiness.ready,
    blockers: readiness.blockers,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    stoppedAt: s.stoppedAt ?? null,
    stopReason: s.stopReason ?? null,
    blocker: s.blocker ?? null,
    noProgressEpoch: s.noProgressEpoch ?? 0,
    discussion: s.discussion ?? null,
    // P5: the card's registered project root — the lead read-mounts it into
    // its turns (preparation reads project context, never writes it), and
    // the UI can name which project the session prepares against.
    projectPath: aggregate.projectPath ?? null,
    intent: {
      raw: s.intent.raw,
      source: s.intent.source ?? 'explicit',
      current: s.intent.current,
      proposal: s.intent.proposal ?? null,
      restatements: s.intent.history.length + 1,
    },
    bindings: s.bindings,
    presented: s.presented,
    gates: (s.gates || []).map(gateView),
    attempts: (s.attempts || []).map((a) => ({
      attemptId: a.attemptId, kind: a.kind, status: a.status,
      docKind: a.docKind ?? null,
      input: typeof a.input === 'string' ? a.input : null,
      progress: a.result?.progress ?? null,
      progressEpoch: a.result?.progressEpoch ?? 0,
      createdAt: a.createdAt, finishedAt: a.finishedAt,
      questionIds: a.questionIds, cancelled: !!a.cancel,
    })),
    checkpoint: {
      revision: s.checkpoint.revision,
      updatedAt: s.checkpoint.updatedAt,
      decisions: s.checkpoint.decisions,
      assumptions: s.checkpoint.assumptions,
      openQuestions: s.checkpoint.openQuestions,
      droppedLog: s.checkpoint.droppedLog ?? 0,
      log: s.checkpoint.log.slice(-50),
    },
    // P4: per-kind completeness + discussion counters, the named downstream
    // targets (with honest `implemented` flags), the recorded offers, and —
    // only while readiness holds — the package a consumer would receive.
    completeness: completenessView(aggregate, s),
    handoffTargets: [...HANDOFF_MODES].map(
      (m) => ({ mode: m, implemented: HANDOFF_IMPLEMENTED.has(m) })),
    handoffs: (s.handoffs || []).map((h) => ({
      ...handoffView(h),
      stale: JSON.stringify(h.inputs) !== curInputsKey,
    })),
    package: readiness.ready
      ? { inputs: curInputs, context: handoffContext(s) }
      : null,
  };
}

export const PREP_HANDLERS = {
  start_preparation: cmdStartPreparation,
  answer_question: cmdAnswerQuestion,
  request_draft: cmdRequestDraft,
  continue_discussion: cmdContinueDiscussion,
  stop_preparation: cmdStopPreparation,
  change_skill_binding: cmdChangeSkillBinding,
  confirm_gate: cmdConfirmGate,
  handoff_preparation: cmdHandoffPreparation,
};

export const PREP_INTERNAL_HANDLERS = {
  prep_result: cmdPrepResult,
  prep_question: cmdPrepQuestion,
};
