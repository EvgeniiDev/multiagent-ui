// server/execution/fusion/panel-spec.mjs — F2 panel spec model.
//
// Pure module: validates/normalizes the `fusion` block of a `start` (or
// `continue`) payload into the durable run.fusion snapshot, computes the
// panel input fingerprint (R9 reuse key), and derives the panel settle
// state (partial failure math, judge eligibility).
//
// Every RuntimeError raised here is mapped to a CommandError by the
// domain boundary — this module never imports the domain.

import { RuntimeError, SAFE_ID_RE } from '../common.mjs';
import {
  validateAgentProfile, profileDigest,
} from '../environment/agent-profile.mjs';

export const FUSION_RESULT_KINDS = new Set(['document', 'implementation']);

export const MIN_PANELISTS = 2;
export const MAX_PANELISTS = 10;
// KTD4/R1: the panel requires at least two DIFFERENT explicitly chosen
// model identities — a panel of N copies of one model is not a panel.
export const MIN_DISTINCT_MODELS = 2;

// Per-participant attempt budget: "две попытки на роль" — the panel phase
// never auto-launches a third; an exhausted participant parks at
// 'awaiting_decision' until an explicit retry_participant/exclude_panelist.
export const DEFAULT_MAX_ATTEMPTS = 2;
export const MAX_ATTEMPTS_LIMIT = 5;
export const DEFAULT_TIMEOUT_MIN = 45;
export const MAX_TIMEOUT_MIN = 24 * 60;
// F3 handoff roles get the same per-role budget — a failed judge or
// integrator attempt consumes it; fixes are bounded by the review gate.
export const DEFAULT_JUDGE_ATTEMPTS = 2;
export const DEFAULT_INTEGRATOR_ATTEMPTS = 2;
export const DEFAULT_REVIEW_ATTEMPTS = 2;
export const MAX_HANDOFF_ATTEMPTS = 5;

// Participant lifecycle. 'pending' means launchable work exists (an
// attempt may still be issued); 'awaiting_decision' is the parked state
// after the attempt budget is exhausted (user must retry or exclude).
export const PARTICIPANT_LIVE_ATTEMPT = new Set(['launching', 'running']);
export const PARTICIPANT_TERMINAL = new Set(['answered', 'excluded']);
export const PARTICIPANT_STATUSES = new Set([
  'pending', 'launching', 'running', 'answered', 'awaiting_decision', 'excluded',
]);

const fail = (code, msg, extra = {}) => {
  throw new RuntimeError(code, msg, extra);
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function clampInt(v, lo, hi, def, what) {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    fail('panel_invalid', `fusion.limits.${what} must be an integer ${lo}..${hi}: ${v}`);
  }
  return n;
}

// One panelist: {id?, label?, profile} — the profile is a FULL effective
// AgentProfile; its digest covers model/image/tools/extensions/allowlist/
// search/launch, so any composition change changes the recorded digest.
function validatePanelist(raw, i, seenIds) {
  if (!isObj(raw)) fail('panel_invalid', `fusion.panelists[${i}] must be an object`);
  const id = raw.id === undefined ? `p${i + 1}` : raw.id;
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    fail('panel_invalid', `fusion.panelists[${i}].id must match ${SAFE_ID_RE}: ${JSON.stringify(id)}`);
  }
  if (seenIds.has(id)) fail('panel_invalid', `duplicate panelist id ${id}`);
  seenIds.add(id);
  const label = raw.label === undefined || raw.label === null ? id
    : String(raw.label).slice(0, 64);
  let profile;
  try {
    profile = validateAgentProfile(raw.profile);
  } catch (e) {
    fail('panel_invalid', `panelist ${id}: invalid profile — ${e.message}`);
  }
  return {
    id,
    label,
    profileId: profile.profileId,
    provider: profile.provider,
    model: profile.model,
    profileDigest: profileDigest(profile),
    profile,
  };
}

// A handoff role ({profile}) — judge or integrator. Same full-profile
// rule as panelists: the recorded digest covers the whole effective
// profile, so a launch can never drift from the recorded composition.
function validateRoleProfile(raw, name) {
  if (!isObj(raw)) {
    fail('panel_invalid', `fusion.${name} must be an object {profile}`);
  }
  let profile;
  try {
    profile = validateAgentProfile(raw.profile);
  } catch (e) {
    fail('panel_invalid', `fusion.${name}: invalid profile — ${e.message}`);
  }
  return {
    profileId: profile.profileId,
    provider: profile.provider,
    model: profile.model,
    profileDigest: profileDigest(profile),
    profile,
  };
}

// Normalize + validate the fusion block of a start payload. The returned
// participants carry the FULL validated profile so a launch can never
// drift from the recorded digest.
export function validateFusionSpec(raw) {
  if (!isObj(raw)) fail('panel_invalid', 'payload.fusion must be an object');
  const resultKind = raw.resultKind;
  if (typeof resultKind !== 'string' || !FUSION_RESULT_KINDS.has(resultKind)) {
    fail('panel_invalid',
      `fusion.resultKind must be one of ${[...FUSION_RESULT_KINDS].join('|')}`);
  }
  const list = Array.isArray(raw.panelists) ? raw.panelists : null;
  if (!list || list.length < MIN_PANELISTS || list.length > MAX_PANELISTS) {
    fail('panel_invalid',
      `fusion.panelists must hold ${MIN_PANELISTS}..${MAX_PANELISTS} entries (got ${list ? list.length : 'none'})`);
  }
  const seenIds = new Set();
  const participants = list.map((p, i) => validatePanelist(p, i, seenIds));
  const models = new Set(participants.map((p) => p.model));
  if (models.size < MIN_DISTINCT_MODELS) {
    fail('panel_incompatible',
      `the panel requires at least ${MIN_DISTINCT_MODELS} different explicitly chosen models — got ${models.size} (${[...models].join(', ') || 'none'})`,
      { models: [...models] });
  }
  const searchEnabled = isObj(raw.search) ? raw.search.enabled === true : raw.search === true;
  if (searchEnabled) {
    // R4: search ON requires EVERY panelist to declare a search-enabled
    // profile — a mixed-capability panel is rejected before start, never
    // silently downgraded.
    const incapable = participants.filter((p) => p.profile.search.enabled !== true);
    if (incapable.length) {
      fail('panel_incompatible',
        `fusion search requires every panelist to declare search.enabled — not declared: ${incapable.map((p) => p.id).join(', ')}`,
        { participants: incapable.map((p) => p.id) });
    }
  }
  // F3 roles: the judge is optional for a 'document' run (a panel without
  // one keeps the F2 terminal state) and REQUIRED for 'implementation' —
  // that kind is undeliverable without a work order, an integrator, and
  // the core reviewer/checker pair.
  const judge = raw.judge === undefined || raw.judge === null
    ? null
    : validateRoleProfile(raw.judge, 'judge');
  const integrator = raw.integrator === undefined || raw.integrator === null
    ? null
    : validateRoleProfile(raw.integrator, 'integrator');
  const review = raw.review === undefined || raw.review === null
    ? null
    : (() => {
        if (!isObj(raw.review)) {
          fail('panel_invalid', 'fusion.review must be an object {reviewer,checker}');
        }
        // Member shape ({cli,model,effort?,params?}) is validated by the
        // domain against the CLI-compat doc — spec keeps the raw members.
        for (const r of ['reviewer', 'checker']) {
          if (!isObj(raw.review[r])) {
            fail('panel_invalid', `fusion.review.${r} must be an object {cli,model}`);
          }
        }
        return { reviewer: raw.review.reviewer, checker: raw.review.checker };
      })();
  if (resultKind === 'implementation') {
    if (!judge) {
      fail('panel_invalid', 'implementation requires fusion.judge {profile} — the work order is mandatory');
    }
    if (!integrator) {
      fail('panel_invalid', 'implementation requires fusion.integrator {profile}');
    }
    if (!review) {
      fail('panel_invalid', 'implementation requires fusion.review {reviewer,checker} — the core gates are inherited');
    }
  }
  if (resultKind === 'document' && (integrator || review)) {
    fail('panel_invalid',
      'a document run carries no integrator/review — its result is the work order only');
  }
  const limits = isObj(raw.limits) ? raw.limits : {};
  return {
    resultKind,
    search: { enabled: searchEnabled },
    limits: {
      maxAttemptsPerParticipant: clampInt(
        limits.maxAttemptsPerParticipant ?? raw.maxAttempts,
        1, MAX_ATTEMPTS_LIMIT, DEFAULT_MAX_ATTEMPTS, 'maxAttemptsPerParticipant'),
      timeoutMin: clampInt(
        limits.timeoutMin, 1, MAX_TIMEOUT_MIN, DEFAULT_TIMEOUT_MIN, 'timeoutMin'),
      judgeAttempts: clampInt(
        limits.judgeAttempts, 1, MAX_HANDOFF_ATTEMPTS, DEFAULT_JUDGE_ATTEMPTS, 'judgeAttempts'),
      integratorAttempts: clampInt(
        limits.integratorAttempts, 1, MAX_HANDOFF_ATTEMPTS, DEFAULT_INTEGRATOR_ATTEMPTS, 'integratorAttempts'),
      reviewAttemptsPerRole: clampInt(
        limits.reviewAttemptsPerRole, 1, 10, DEFAULT_REVIEW_ATTEMPTS, 'reviewAttemptsPerRole'),
    },
    participants,
    judge,
    integrator,
    review,
  };
}

// ---- derived panel state --------------------------------------------------

export function participantAttempts(run, participantId) {
  return (run?.attempts || []).filter((a) => a && a.participantId === participantId);
}

export function participantLiveAttempt(run, participantId, isLive) {
  return participantAttempts(run, participantId).find((a) => isLive(a.status)) ?? null;
}

// Attempts still launchable for this participant right now?
export function participantAttemptsLeft(run, p) {
  const limit = (run?.fusion?.limits?.maxAttemptsPerParticipant ?? DEFAULT_MAX_ATTEMPTS)
    + (p.extraAttempts || 0);
  return (p.attemptsUsed || 0) < limit;
}

// Executable work = a live attempt OR a 'pending' participant (which by
// construction still has attempts left — resolve paths demote exhausted
// participants to awaiting_decision instead).
export function panelState(run, { isLiveAttempt } = {}) {
  const fz = run?.fusion ?? {};
  const parts = Array.isArray(fz.participants) ? fz.participants : [];
  const liveAtts = (run?.attempts || []).filter((a) => a && isLiveAttempt?.(a.status));
  const pending = parts.filter((p) => p.status === 'pending');
  const working = parts.filter((p) => PARTICIPANT_LIVE_ATTEMPT.has(p.status));
  const awaiting = parts.filter((p) => p.status === 'awaiting_decision');
  const answered = parts.filter((p) => p.status === 'answered' && p.answer);
  const excluded = parts.filter((p) => p.status === 'excluded');
  const answeredModels = new Set(answered.map((p) => p.model));
  // Distinct model identities among participants still in the panel
  // (answered or still able to produce an answer).
  const remainingModels = new Set(
    parts.filter((p) => p.status !== 'excluded').map((p) => p.model));
  return {
    participants: parts,
    liveAttempts: liveAtts,
    pending,
    working,
    awaitingDecision: awaiting,
    answered,
    answeredModels,
    excluded,
    remainingModels,
    executable: pending.length + liveAtts.length + working.length > 0
      && (pending.length > 0 || liveAtts.length > 0),
    quorum: answeredModels.size >= MIN_DISTINCT_MODELS,
  };
}

// What a settle decision must derive to — the caller's claim is never
// trusted; the domain recomputes this from the durable participant set.
export function derivedSettleOutcome(run, { isLiveAttempt } = {}) {
  const s = panelState(run, { isLiveAttempt });
  if (s.liveAttempts.length || s.working.length) return { ok: false, code: 'attempt_active' };
  if (s.pending.length) return { ok: false, code: 'work_pending' };
  if (s.awaitingDecision.length) return { ok: true, outcome: 'decision_pending' };
  return { ok: true, outcome: s.quorum ? 'complete' : 'quorum_failed' };
}
