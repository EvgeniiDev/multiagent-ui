// Pure presentation + gating helpers for the managed execution UI (U6).
// No Vue/Pinia/DOM imports — node:test exercises this module directly, and
// CardDrawer/ExecutionPanel render from its verdicts.
//
// Every gate here mirrors a REAL server rule from
// server/execution/execution-domain.mjs — the server remains authoritative;
// these produce the disabled-reason text the user sees instead of a dead
// click, and they never invent permissions the server does not enforce.

import type {
  ExecCardView,
  ExecCheck,
  ExecDocKind,
  ExecDocState,
  ExecDocVersion,
  ExecPresetInput,
  ExecPresetMember,
  ExecPrepView,
  ExecRun,
  ExecRunSummary,
  FusionParticipant,
  FusionPendingAction,
  FusionResultKind,
  FusionState,
  FusionWorkOrder,
  OrchestratorState,
  OrchPendingAction,
  OrchTask,
  PrepBindingInfo,
  PrepBindingRef,
  PrepCompletenessCounters,
  PrepCompletenessState,
  PrepCompletenessValue,
  PrepGate,
  PrepQuestion,
  PrepStage,
  SwarmDecision,
  SwarmMessage,
  SwarmParticipant,
  SwarmPendingAction,
  SwarmState,
} from './api.ts';

// Run statuses the server treats as still-in-flight for `start` admission
// (mirrors RUN_NONTERMINAL). For `continue` the inflight rule is narrower
// (a parked active run is admissible) — see canContinue.
export const RUN_LIVE_STATUSES = new Set([
  'queued',
  'active',
  'stopping',
  'awaiting_acceptance',
]);
export const ATTEMPT_LIVE_STATUSES = new Set(['launching', 'running', 'cancelling']);
const PARKED_PHASES = new Set(['awaiting_validation', 'awaiting_acceptance']);

export interface GateResult {
  ok: boolean;
  /** Human-readable reason the action is unavailable; empty when ok. */
  reason: string;
}

const ok: GateResult = { ok: true, reason: '' };
const no = (reason: string): GateResult => ({ ok: false, reason });

/** Runs holding a live process reservation — the card view's `reserved`
 * flag is authoritative here (live attempt OR active/unproven validation;
 * a terminal-status run can still carry one). */
export function reservedRuns(view: ExecCardView): ExecRunSummary[] {
  return (view.runs ?? []).filter((r) => r.reserved === true);
}

/** Runs still in flight by status — distinct from `reserved`: a parked run
 * ('active' + awaiting_validation/awaiting_acceptance, zero live attempts,
 * no validation reservation) is nonterminal yet admissible as a continue
 * predecessor. `reserved` remains the evidence of actual live work. */
export function inflightRuns(view: ExecCardView): ExecRunSummary[] {
  return (view.runs ?? []).filter(
    (r) => r.reserved === true || (typeof r.status === 'string' && RUN_LIVE_STATUSES.has(r.status)),
  );
}

/** The run summary the card currently points at, if any. */
export function currentRunSummary(view: ExecCardView): ExecRunSummary | null {
  if (!view.currentRunId) return null;
  return (view.runs ?? []).find((r) => r.id === view.currentRunId) ?? null;
}

export function docState(view: ExecCardView, kind: ExecDocKind): ExecDocState {
  return view.documents?.[kind] ?? { current: null, versions: [] };
}

export function currentVersion(view: ExecCardView, kind: ExecDocKind): ExecDocVersion | null {
  const docs = docState(view, kind);
  if (!docs.current) return null;
  return docs.versions.find((v) => v.versionId === docs.current) ?? null;
}

/** The approval pair must exist AND still bind the CURRENT document
 * versions — attaching a newer version revokes approvals server-side, but
 * the UI also refuses a stale approval rather than sending a command the
 * server is guaranteed to reject. */
export function inputsApproved(view: ExecCardView): GateResult {
  const reqA = view.approvals?.requirements ?? null;
  if (!reqA) return no('approve the current requirements first');
  if (docState(view, 'requirements').current !== reqA.versionId) {
    return no('the approved requirements are not the current version — approve again');
  }
  const planA = view.approvals?.plan ?? null;
  if (!planA) return no('approve the current plan first');
  if (docState(view, 'plan').current !== planA.versionId) {
    return no('the approved plan is not the current version — approve again');
  }
  if (planA.requirementsVersionId !== reqA.versionId || planA.requirementsSha256 !== reqA.sha256) {
    return no('the approved plan was prepared for different requirements — re-approve the plan');
  }
  return ok;
}

// -- action gates --------------------------------------------------------------

/** `start` (cmdStart): approved inputs + bound composition + zero live
 * reservations or in-flight runs anywhere on the card. P5: an ACTIVE
 * preparation session additionally gates start to derived readiness —
 * mirrors prepAssertStartReady (a stopped/absent session gates nothing). */
export function canStart(view: ExecCardView): GateResult {
  const inputs = inputsApproved(view);
  if (!inputs.ok) return inputs;
  if (!view.composition?.preset) return no('save an execution team (preset) for this card first');
  const prep = view.preparation;
  if (prep && prep.status === 'active' && prep.ready !== true) {
    return no(
      `preparation is not ready — resolve ${prep.blockerCount} blocker(s) in the Preparation section first`,
    );
  }
  const live = inflightRuns(view);
  if (live.length) {
    return no(`run ${live[0].id} is still live — stop it and let it settle first`);
  }
  return ok;
}

/** `stop`: reachable whenever anything is still live — the backend never
 * gates stop; without live runs there is nothing to stop. */
export function canStop(view: ExecCardView): GateResult {
  if (!(view.runs ?? []).length) return no('no run yet');
  const live = inflightRuns(view);
  if (!live.length) return no('nothing live — every run has finished or is awaiting a decision');
  return ok;
}

/** `continue` (cmdContinue): the card must have a previous run, no run may
 * hold a live reservation (`reserved` — live attempt or active/unproven
 * validation), no run may be queued/stopping/in-flight active, and the
 * CURRENT run must be parked (active + awaiting_validation /
 * awaiting_acceptance) or terminal. The same approved-inputs and
 * composition gates as `start` apply — continue never bypasses them.
 * `run` is the loaded detail of the current run (its phase proves the
 * parked state summaries cannot express); without it an active-status
 * current run is conservatively inadmissible. */
export function canContinue(view: ExecCardView, run: ExecRun | null): GateResult {
  const cur = currentRunSummary(view);
  if (!cur) return no('no run to continue from');
  // A fusion predecessor mints a continuation panel run — it re-resolves
  // its own task/input binding server-side (document runs have no approved
  // pair at all), so the solo input gates do not apply.
  const isFusionPrev = (run && run.id === cur.id && run.mode === 'fusion') || cur.mode === 'fusion';
  if (!isFusionPrev) {
    const inputs = inputsApproved(view);
    if (!inputs.ok) return no(`continue requires freshly approved inputs — ${inputs.reason}`);
    if (!view.composition?.preset) return no('save an execution team (preset) for this card first');
    // P5: continue passes through the same prepAssertStartReady gate as
    // start — an active unready preparation session blocks it too.
    const prep = view.preparation;
    if (prep && prep.status === 'active' && prep.ready !== true) {
      return no(`preparation is not ready — ${prep.blockerCount} blocker(s) open`);
    }
  }
  for (const r of view.runs ?? []) {
    if (r.reserved === true) {
      return no(`run ${r.id} still holds a live reservation — it must drain first`);
    }
    if (r.status === 'queued' || r.status === 'stopping') {
      return no(`run ${r.id} is ${r.status} — wait for it to settle`);
    }
    if (r.status === 'active') {
      const phase = run && run.id === r.id ? run.phase : null;
      if (phase === null || !PARKED_PHASES.has(phase)) {
        return no(`run ${r.id} is still in flight — only a parked or terminal run may precede a continuation`);
      }
    }
  }
  return ok;
}

/** `accept_result` (cmdAcceptResult): the CURRENT run parked at
 * awaiting_acceptance, its recorded result hash present, no live
 * reservation on it, the bound workspace still ready and owned by this
 * run, and the currently approved inputs still exactly the pair the run
 * was launched with. */
export function canAccept(view: ExecCardView, run: ExecRun | null): GateResult {
  const cur = currentRunSummary(view);
  if (!cur) return no('no run to accept');
  if (!run || run.id !== cur.id) {
    return no('open the current run to review its verified result');
  }
  if (run.status !== 'awaiting_acceptance' || !run.acceptance) {
    return no('the run has not passed its checks/review gate yet');
  }
  if (!/^[0-9a-f]{64}$/.test(run.acceptance.resultSha256 ?? '')) {
    return no('the recorded result hash is missing — evidence is incomplete');
  }
  if (cur.reserved === true) {
    return no('the run still holds a live reservation — nothing may be accepted under it');
  }
  const reqA = view.approvals?.requirements;
  const planA = view.approvals?.plan;
  const inReq = run.inputs?.requirements;
  const inPlan = run.inputs?.plan;
  if (!reqA || !planA || !inReq || !inPlan
    || reqA.versionId !== inReq.versionId || reqA.sha256 !== inReq.sha256
    || planA.versionId !== inPlan.versionId || planA.sha256 !== inPlan.sha256) {
    return no('the approved inputs changed since this run started — its accepted basis is stale');
  }
  const ws = run.workspaceId ? view.workspaces?.[run.workspaceId] : null;
  if (!ws || ws.status !== 'ready' || ws.runId !== run.id) {
    return no('the reviewed workspace is no longer bound to this run — acceptance refused');
  }
  return ok;
}

/** `change_requirements`: always reachable on a managed card — it revokes
 * both approvals and halts live work in one commit. */
export function canChangeRequirements(_view: ExecCardView): GateResult {
  return ok;
}

// -- enable eligibility (client-side pre-check; the server decides) ------------

export interface EnableEligibility {
  ok: boolean;
  reasons: string[];
}

/** Pre-flight reasons an unmanaged card cannot be enabled. The server is
 * authoritative (it also checks git root + legacy claims); this only spares
 * the user a guaranteed refusal. `projectResolvable` comes from the board
 * store's projectIdForCard. */
export function enableEligibility(opts: {
  cancelled: boolean;
  projectResolvable: boolean;
  projectLabel: string;
}): EnableEligibility {
  const reasons: string[] = [];
  if (opts.cancelled) reasons.push('a cancelled card cannot be managed');
  if (!opts.projectResolvable) {
    reasons.push(
      opts.projectLabel.trim()
        ? `project "${opts.projectLabel}" is not a registered project`
        : 'set the card project to a registered project first',
    );
  }
  return { ok: reasons.length === 0, reasons };
}

// -- payload builders ------------------------------------------------------------

export type DocSourceInput =
  | { type: 'text'; text: string }
  | { type: 'import'; path: string; projectId?: string };

export function attachDocPayload(
  kind: ExecDocKind,
  source: DocSourceInput,
  opts: { requirementsVersionId?: string; checks?: ExecCheck[] } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = { kind, source };
  if (opts.requirementsVersionId) payload.requirementsVersionId = opts.requirementsVersionId;
  if (opts.checks) payload.checks = opts.checks;
  return payload;
}

export function approvePayload(
  version: ExecDocVersion,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { versionId: version.versionId, sha256: version.sha256, ...extra };
}

export function presetCommandPayload(preset: ExecPresetInput): Record<string, unknown> {
  return { preset };
}

export function startPayload(opts: { baseRef?: string; freshWorkspace?: boolean } = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (opts.baseRef?.trim()) payload.baseRef = opts.baseRef.trim();
  if (opts.freshWorkspace) payload.freshWorkspace = true;
  return payload;
}

export function stopPayload(reason?: string): Record<string, unknown> {
  return reason?.trim() ? { reason: reason.trim().slice(0, 500) } : {};
}

export function continuePayload(note?: string): Record<string, unknown> {
  return note?.trim() ? { note: note.trim().slice(0, 2000) } : {};
}

export function acceptPayload(run: ExecRun): Record<string, unknown> | null {
  const hash = run.acceptance?.resultSha256;
  if (!hash) return null;
  return { runId: run.id, resultSha256: hash };
}

// -- check rows (structured plan checks editor) -----------------------------------

export interface CheckRow {
  run: string;
  cwd: string;
  timeoutSec: string;
  setup: boolean;
}

export function checksToRows(checks: ExecCheck[] | undefined | null): CheckRow[] {
  return (checks ?? []).map((c) => ({
    run: c.run ?? '',
    cwd: c.cwd ?? '',
    timeoutSec: c.timeoutSec === undefined ? '' : String(c.timeoutSec),
    setup: c.setup === true,
  }));
}

/** Convert editor rows to a validated checks array (mirrors
 * validateChecksArray — the server re-validates authoritatively). */
export function rowsToChecks(rows: CheckRow[]): { ok: boolean; problems: string[]; checks: ExecCheck[] } {
  const problems: string[] = [];
  const checks: ExecCheck[] = [];
  rows.forEach((r, i) => {
    const at = `check ${i + 1}`;
    const run = r.run.trim();
    if (!run) {
      problems.push(`${at}: command is required`);
      return;
    }
    if (run.length > 2000) {
      problems.push(`${at}: command exceeds 2000 chars`);
      return;
    }
    const cwd = r.cwd.trim();
    if (cwd && (cwd.startsWith('/') || cwd.split(/[\\/]+/).includes('..'))) {
      problems.push(`${at}: cwd must be a project-relative path without '..'`);
      return;
    }
    let timeoutSec: number | undefined;
    if (r.timeoutSec.trim()) {
      const t = Number(r.timeoutSec.trim());
      if (!Number.isFinite(t) || t <= 0 || t > 24 * 3600) {
        problems.push(`${at}: timeout must be a number of seconds up to ${24 * 3600}`);
        return;
      }
      timeoutSec = t;
    }
    const check: ExecCheck = { run };
    if (cwd) check.cwd = cwd;
    if (timeoutSec !== undefined) check.timeoutSec = timeoutSec;
    if (r.setup) check.setup = true;
    checks.push(check);
  });
  return { ok: problems.length === 0, problems, checks };
}

/** The check set a plan approval would snapshot, in the server's precedence:
 * explicit editor rows > attach-time payload checks > document fence. */
export function effectivePlanChecks(
  version: ExecDocVersion | null,
  editedRows: CheckRow[] | null,
): { checks: ExecCheck[]; source: string; problems: string[] } {
  if (editedRows !== null) {
    const v = rowsToChecks(editedRows);
    return { checks: v.checks, source: 'approval_payload', problems: v.problems };
  }
  if (version?.checks?.checks?.length) {
    return { checks: version.checks.checks, source: 'attach_payload', problems: [] };
  }
  if (version?.checksFromDocument?.ok && version.checksFromDocument.checks?.length) {
    return { checks: version.checksFromDocument.checks, source: 'document_block', problems: [] };
  }
  return {
    checks: [],
    source: 'none',
    problems: version?.checksFromDocument && !version.checksFromDocument.ok
      ? version.checksFromDocument.problems ?? ['invalid acp-checks block']
      : ['no check commands yet — add at least one'],
  };
}

// -- display helpers -----------------------------------------------------------------

export function fmtSha(sha: string | null | undefined, len = 12): string {
  return typeof sha === 'string' && sha ? sha.slice(0, len) : '—';
}

export function fmtTs(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  const m = /^(?:run_|att_|v_|val_|ws_|preset_)?([0-9a-f]{8})/.exec(id);
  return m ? m[1] : id.slice(0, 12);
}

const PHASE_LABELS: Record<string, string> = {
  prepare: 'preparing',
  implement: 'implementing',
  verify: 'verifying',
  review: 'review',
  check_review: 'checker review',
  fix: 'fixing findings',
  awaiting_validation: 'awaiting validation',
  awaiting_acceptance: 'awaiting your acceptance',
  // fusion phases (F4)
  panel: 'panel deliberation',
  judge: 'judge — drafting work order',
  integrate: 'integrating work order',
};

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'queued',
  active: 'running',
  stopping: 'stopping…',
  awaiting_acceptance: 'awaiting acceptance',
  succeeded: 'accepted',
  failed: 'failed',
  blocked: 'blocked',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
};

export function runStatusLabel(status: string | null | undefined): string {
  return RUN_STATUS_LABELS[status ?? ''] ?? status ?? '—';
}

export function phaseLabel(phase: string | null | undefined): string {
  return PHASE_LABELS[phase ?? ''] ?? phase ?? '';
}

export function docKindLabel(kind: ExecDocKind): string {
  return kind === 'requirements' ? 'Requirements' : kind === 'plan' ? 'Plan' : 'Design';
}

/** Which checks detail to show for an approval decision on a plan version. */
export function planBindingNote(version: ExecDocVersion, view: ExecCardView): string | null {
  const bound = version.requirements;
  if (!bound) return null;
  const approved = view.approvals?.requirements;
  if (approved && approved.versionId === bound.versionId && approved.sha256 === bound.sha256) {
    return null; // bound to the approved requirements — nothing to warn about
  }
  return `prepared for requirements ${shortId(bound.versionId)} — not the currently approved requirements`;
}

// == fusion panel (F4) =========================================================
//
// Presentation + gating for run.fusion — the durable state written by
// server/execution/fusion/domain.mjs. Every gate mirrors a server rule:
// retry/exclude require participant 'awaiting_decision' on a
// live-or-blocked run; exclusion must keep >=2 distinct models among the
// non-excluded; a work order is approvable only while its versionId is the
// recorded pending action (a stale version is refused server-side anyway).
// The server remains authoritative — these produce disabled-reason text.

export function isFusion(run: ExecRun | null | undefined): boolean {
  return run?.mode === 'fusion' && !!run.fusion;
}

export function fusion(run: ExecRun | null | undefined): FusionState | null {
  return isFusion(run) ? (run!.fusion ?? null) : null;
}

export function fusionParticipants(run: ExecRun | null | undefined): FusionParticipant[] {
  return fusion(run)?.participants ?? [];
}

export function participantById(
  run: ExecRun | null | undefined,
  participantId: string,
): FusionParticipant | null {
  return fusionParticipants(run).find((p) => p.id === participantId) ?? null;
}

export function fusionPendingActions(run: ExecRun | null | undefined): FusionPendingAction[] {
  return fusion(run)?.pendingActions ?? [];
}

/** Work orders newest-last; the current version is the LAST entry. */
export function fusionWorkOrders(run: ExecRun | null | undefined): FusionWorkOrder[] {
  return fusion(run)?.workOrders ?? [];
}

export function currentWorkOrder(run: ExecRun | null | undefined): FusionWorkOrder | null {
  const list = fusionWorkOrders(run);
  return list.length ? list[list.length - 1] : null;
}

const FUSION_STATUS_LABELS: Record<string, string> = {
  open: 'collecting answers',
  decision_pending: 'awaiting your decision',
  complete: 'panel complete',
  quorum_failed: 'quorum failed',
  cancelled: 'cancelled',
};

export function fusionStatusLabel(s: string | null | undefined): string {
  return FUSION_STATUS_LABELS[s ?? ''] ?? s ?? '—';
}

const PARTICIPANT_STATUS_LABELS: Record<string, string> = {
  pending: 'pending',
  launching: 'launching',
  running: 'running',
  answered: 'answered',
  awaiting_decision: 'needs your decision',
  excluded: 'excluded',
};

export function participantStatusLabel(s: string | null | undefined): string {
  return PARTICIPANT_STATUS_LABELS[s ?? ''] ?? s ?? '—';
}

export function resultKindLabel(kind: FusionResultKind | string | null | undefined): string {
  return kind === 'document' ? 'document (work order is the result)'
    : kind === 'implementation' ? 'implementation (work order → integrate → gates)'
    : kind ?? '—';
}

export function verdictLabel(v: string | null | undefined): string {
  return v === 'in_plan' ? 'in plan — within approved scope'
    : v === 'scope_change' ? 'scope change — outside approved plan'
    : v === 'uncertain' ? 'uncertain — cannot route'
    : v ?? '—';
}

const WO_APPROVAL_REASONS: Record<string, string> = {
  acceptance: 'the work order needs your approval',
  scope_change: 'judge ruled this a scope change — approve to implement anyway',
  uncertain: 'judge could not route the order — approve to implement anyway',
  inputs_changed: 'the approved inputs changed since the order was drafted',
  behavior_change: 'the integrator declared a behavior change — approve to continue',
};

/** One-line text for a durable pending action (the required-action banner). */
export function pendingActionText(a: FusionPendingAction, run?: ExecRun | null): string {
  if (a.type === 'participant_decision') {
    const p = run ? participantById(run, a.participantId) : null;
    const who = p ? `${p.id} (${p.model})` : a.participantId;
    const err = p?.lastError?.reason ? ` — ${p.lastError.reason.slice(0, 120)}` : '';
    return `participant ${who} exhausted its attempts — retry or exclude${err}`;
  }
  if (a.type === 'work_order_approval') {
    return `work order ${a.versionId} awaits approval`
      + (a.reason ? ` — ${WO_APPROVAL_REASONS[a.reason] ?? a.reason}` : '');
  }
  return `action required: ${(a as { type: string }).type}`;
}

// -- fusion action gates -----------------------------------------------------

/** Run states in which the server still accepts a participant decision or
 * work-order approval (fusionRunForDecision): queued | active | blocked. */
const FUSION_DECIDABLE_RUN = new Set(['queued', 'active', 'blocked']);

export function canRetryParticipant(run: ExecRun | null, participantId: string): GateResult {
  if (!isFusion(run)) return no('not a fusion run');
  if (!FUSION_DECIDABLE_RUN.has(run!.status)) {
    return no(`run is ${run!.status} — participant decisions apply only to live or blocked-panel runs`);
  }
  const p = participantById(run, participantId);
  if (!p) return no(`participant ${participantId} is not in this panel`);
  if (p.status !== 'awaiting_decision') {
    return no(`participant ${p.id} is ${p.status} — only an exhausted participant may be retried`);
  }
  return ok;
}

export function canExcludePanelist(run: ExecRun | null, participantId: string): GateResult {
  const retry = canRetryParticipant(run, participantId);
  if (!retry.ok) return retry;
  // Mirror cmdExcludePanelist: excluding must keep >=2 distinct models
  // among the non-excluded remainder.
  const remaining = fusionParticipants(run)
    .filter((x) => x.id !== participantId && x.status !== 'excluded');
  const remainingModels = new Set(remaining.map((x) => x.model));
  if (remainingModels.size < 2) {
    return no(`excluding this participant leaves ${remainingModels.size} distinct model(s) — the panel requires at least 2`);
  }
  return ok;
}

/** `approve_work_order`: the run must hold a matching pending action AND
 * the version must be the CURRENT (newest) work order. */
export function canApproveWorkOrder(run: ExecRun | null, versionId?: string): GateResult {
  if (!isFusion(run)) return no('not a fusion run');
  if (!FUSION_DECIDABLE_RUN.has(run!.status)) {
    return no(`run is ${run!.status} — work-order approval applies only to live or blocked runs`);
  }
  const pending = fusionPendingActions(run).find(
    (a) => a.type === 'work_order_approval' && (versionId === undefined || a.versionId === versionId));
  if (!pending || pending.type !== 'work_order_approval') {
    const other = fusionPendingActions(run).find((a) => a.type === 'work_order_approval');
    return no(other && other.type === 'work_order_approval'
      ? `the run awaits approval of ${other.versionId} — refresh for the current version`
      : 'the run is not waiting on a work-order approval');
  }
  const cur = currentWorkOrder(run);
  if (cur && cur.versionId !== pending.versionId) {
    return no(`work order ${cur.versionId} is newer — only the current version is approvable`);
  }
  const wo = fusionWorkOrders(run).find((w) => w.versionId === pending.versionId);
  if (wo?.approved) return no(`work order ${wo.versionId} is already approved`);
  return ok;
}

// -- fusion command payloads ---------------------------------------------------

export function retryParticipantPayload(run: ExecRun, participantId: string): Record<string, unknown> {
  return { runId: run.id, participantId };
}

export function excludePanelistPayload(
  run: ExecRun,
  participantId: string,
  reason?: string,
): Record<string, unknown> {
  const p: Record<string, unknown> = { runId: run.id, participantId };
  if (reason?.trim()) p.reason = reason.trim().slice(0, 500);
  return p;
}

/** The approval binds the exact recorded version — versionId + sha256
 * (the server refuses a hash mismatch, so we always send both). */
export function approveWorkOrderPayload(
  run: ExecRun,
  wo?: FusionWorkOrder,
): Record<string, unknown> | null {
  const target = wo ?? currentWorkOrder(run);
  if (!target?.versionId || !/^[0-9a-f]{64}$/.test(target.sha256 ?? '')) return null;
  return { runId: run.id, versionId: target.versionId, sha256: target.sha256 };
}

// -- fusion run composition (start payload) -----------------------------------
//
// The UI composes the fusion block from durable choices ONLY: provider/
// model pairs come from the compat table's pi entry (the F1 worker runtime
// is pi-only), profiles are synthesized to the AgentProfile contract
// (validateAgentProfile) — nothing client-side is authoritative; the
// server re-validates every field.

/** pi version pinned for synthesized worker profiles (the F1 worker image). */
export const FUSION_PI_VERSION = '0.85.1';
export const FUSION_WORKER_IMAGE = 'worker';

/** Tool allowlists per fusion role — explicit, never "all tools". */
export const FUSION_ROLE_TOOLS: Record<string, string[]> = {
  panelist: ['read', 'bash', 'grep', 'find', 'ls'],
  judge: ['read', 'bash', 'grep', 'find', 'ls'],
  integrator: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
};

export interface FusionProfilePick {
  profileId: string;
  provider: string;
  model: string;
  role: 'panelist' | 'judge' | 'integrator';
  thinking?: string | null;
  search?: boolean;
}

/** A provider-qualified model string ('zen-relay/x-y') → {provider,model}. */
export function splitModelRef(model: string): { provider: string; model: string } {
  const i = model.indexOf('/');
  return i > 0
    ? { provider: model.slice(0, i), model }
    : { provider: 'zen-relay', model };
}

/** Synthesize a valid AgentProfile for a container-bound fusion role. */
export function fusionProfile(pick: FusionProfilePick): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: pick.profileId,
    pi: { version: FUSION_PI_VERSION },
    image: FUSION_WORKER_IMAGE,
    provider: pick.provider,
    model: pick.model,
    thinking: pick.thinking ?? null,
    skills: [],
    extensions: pick.search
      ? [{ resource: 'piExt', rel: 'pi-web-access' }]
      : [],
    tools: pick.search
      ? [...new Set([...(FUSION_ROLE_TOOLS[pick.role] ?? FUSION_ROLE_TOOLS.panelist), 'web_search'])].sort()
      : [...(FUSION_ROLE_TOOLS[pick.role] ?? FUSION_ROLE_TOOLS.panelist)],
    search: pick.search
      ? { enabled: true, provider: 'duckduckgo', params: {} }
      : { enabled: false, provider: null, params: {} },
    launch: { progress: 'none', extraFlags: [] },
    systemPromptFile: null,
  };
}

export interface FusionPanelistDraft {
  id?: string;
  label?: string;
  /** Provider-qualified model ('zen-relay/x'). */
  model: string;
  thinking?: string | null;
}

export interface FusionDraft {
  resultKind: FusionResultKind;
  panelists: FusionPanelistDraft[];
  judgeModel?: string | null;
  integratorModel?: string | null;
  review?: { reviewer: ExecPresetMember | null; checker: ExecPresetMember | null } | null;
  search?: boolean;
  /** Required for 'document' — the pinned task document version. For
   * 'implementation' omit to default to the approved requirements.
   * kind is limited to the task-bindable kinds (requirements|design). */
  task?: { kind: 'requirements' | 'design'; versionId: string; sha256: string } | null;
  limits?: {
    maxAttemptsPerParticipant?: number;
    timeoutMin?: number;
    judgeAttempts?: number;
    integratorAttempts?: number;
    reviewAttemptsPerRole?: number;
  };
  baseRef?: string;
}

/** Client-side mirror of validateFusionSpec + buildFusionRun's input gates —
 * returns the problems the server would refuse, for display before POST. */
export function fusionDraftProblems(view: ExecCardView, d: FusionDraft): string[] {
  const problems: string[] = [];
  const list = d.panelists ?? [];
  if (list.length < 2) problems.push('a panel needs at least 2 panelists');
  if (list.length > 10) problems.push('a panel may hold at most 10 panelists');
  const models = new Set(list.map((p) => (p.model ?? '').trim()).filter(Boolean));
  if (list.some((p) => !(p.model ?? '').trim())) problems.push('every panelist needs a model pick');
  if (models.size > 0 && models.size < 2 && list.length >= 2) {
    problems.push('the panel requires at least 2 different models');
  }
  const ids = new Set<string>();
  for (const p of list) {
    const id = p.id?.trim();
    if (id && ids.has(id)) problems.push(`duplicate panelist id ${id}`);
    if (id) ids.add(id);
  }
  if (d.resultKind === 'document') {
    if (!d.task?.versionId || !d.task.sha256) {
      problems.push('a document run pins a task document version — pick requirements/design');
    }
  }
  if (d.resultKind === 'implementation') {
    const inputs = inputsApproved(view);
    if (!inputs.ok) problems.push(`implementation requires approved inputs — ${inputs.reason}`);
    if (!d.judgeModel) problems.push('implementation requires a judge model');
    if (!d.integratorModel) problems.push('implementation requires an integrator model');
    if (!d.review?.reviewer || !d.review?.checker) {
      problems.push('implementation requires reviewer + checker members');
    }
  }
  const live = inflightRuns(view);
  if (live.length) {
    problems.push(`run ${live[0].id} is still live — stop it and let it settle first`);
  }
  return problems;
}

export function canStartFusion(view: ExecCardView, d: FusionDraft): GateResult {
  if (view.features?.fusion !== true) return no('fusion mode is not enabled on this deployment');
  const problems = fusionDraftProblems(view, d);
  return problems.length ? no(problems[0]) : ok;
}

/** The `start` payload for mode 'fusion' — mirrors validateFusionSpec:
 * document runs carry task+panelists(+optional judge)+search+limits and
 * NEVER integrator/review; implementation carries the full handoff set. */
export function fusionStartPayload(d: FusionDraft): Record<string, unknown> {
  const panelists = d.panelists.map((p, i) => {
    const id = p.id?.trim() || `p${i + 1}`;
    const { provider, model } = splitModelRef(p.model);
    return {
      id,
      label: p.label?.trim() || id,
      profile: fusionProfile({
        profileId: `f4-panel-${id}`, provider, model,
        role: 'panelist', thinking: p.thinking ?? null, search: d.search === true,
      }),
    };
  });
  const role = (modelRef: string | null | undefined, roleName: 'judge' | 'integrator') => {
    if (!modelRef) return null;
    const { provider, model } = splitModelRef(modelRef);
    return {
      profile: fusionProfile({
        profileId: `f4-${roleName}`, provider, model, role: roleName,
      }),
    };
  };
  const fusion: Record<string, unknown> = {
    resultKind: d.resultKind,
    panelists,
    search: { enabled: d.search === true },
  };
  const judge = role(d.judgeModel, 'judge');
  if (judge) fusion.judge = judge;
  if (d.resultKind === 'implementation') {
    const integrator = role(d.integratorModel, 'integrator');
    if (integrator) fusion.integrator = integrator;
    if (d.review?.reviewer && d.review?.checker) {
      fusion.review = { reviewer: d.review.reviewer, checker: d.review.checker };
    }
  }
  if (d.task?.versionId) {
    fusion.task = { kind: d.task.kind ?? 'requirements', versionId: d.task.versionId, sha256: d.task.sha256 };
  }
  const limits = d.limits ?? {};
  const L: Record<string, number> = {};
  for (const k of [
    'maxAttemptsPerParticipant', 'timeoutMin', 'judgeAttempts',
    'integratorAttempts', 'reviewAttemptsPerRole',
  ] as const) {
    const v = limits[k];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) L[k] = v;
  }
  if (Object.keys(L).length) fusion.limits = L;
  const payload: Record<string, unknown> = { mode: 'fusion', fusion };
  if (d.baseRef?.trim()) payload.baseRef = d.baseRef.trim();
  return payload;
}

// == idea preparation (P5) =====================================================
//
// Presentation + gating for the durable preparation session (GET
// /api/execution/cards/:id/preparation). Every gate here mirrors a server
// rule from server/execution/preparation/session.mjs — the server remains
// authoritative; these produce the disabled-reason text.
//
// Mode selection: the run modes a prepared package may target are the four
// HANDOFF_MODES (solo|fusion|orchestrator|swarm). The server marks each
// with `implemented` — solo/fusion are live on this build, orchestrator
// and swarm have no consumer yet (HANDOFF_IMPLEMENTED). Helpers below keep
// unavailable modes visible-but-gated: selectable for recording an offer,
// never presented as launchable, and start payloads for them are refused
// client-side with the reason instead of a POST the server would reject.

export const PREP_STAGES: PrepStage[] = ['intent', 'requirements', 'design', 'plan', 'review'];

/** Downstream run modes a handoff offer may name. Orchestrator/swarm are
 * recorded-but-unimplemented until their backend lands — the UI must show
 * them as such, never as startable. */
export type PrepDownstreamMode = 'solo' | 'fusion' | 'orchestrator' | 'swarm';

export const PREP_DOWNSTREAM_MODES: PrepDownstreamMode[] = [
  'solo', 'fusion', 'orchestrator', 'swarm',
];

/** Modes the user may actually START a run in on this build — the
 * server-controlled availability behind each mode (backend-ui-contract
 * §10: keep modes disabled until reported available). Solo/fusion have
 * server-side start paths; orchestrator/swarm start commands land only in
 * deployments whose `features` advertise them. */
export const PREP_STARTABLE_MODES: PrepDownstreamMode[] = ['solo', 'fusion'];

/** Modes the card view's `features` flag as available for START. Mirrors
 * the fusion gate convention (`features.fusion === true`): an absent or
 * false flag hides the editor and refuses the POST — never a
 * frontend-only illusion of execution. */
export function startableModes(view: ExecCardView): PrepDownstreamMode[] {
  const out: PrepDownstreamMode[] = ['solo', 'fusion'];
  if (view.features?.orchestrator === true) out.push('orchestrator');
  if (view.features?.swarm === true) out.push('swarm');
  return out;
}

export interface PrepHandoffTarget {
  mode: string;
  implemented: boolean;
}

/** An unimplemented mode stays selectable in the handoff picker (the offer
 * is durable data), but Start for it is refused with this reason. */
export function unimplementedModeReason(mode: string): string {
  return `mode "${mode}" is recorded as a handoff offer only — no run backend exists on this deployment, nothing would execute`;
}

/** Gate a downstream-mode START choice: startable modes (solo/fusion,
 * plus orchestrator/swarm once the card view's `features` advertise
 * them) pass through to the normal run gates; anything else refuses
 * without a POST — no frontend-only execution. */
export function canStartInMode(mode: string, view?: ExecCardView | null): GateResult {
  if ((PREP_STARTABLE_MODES as string[]).includes(mode)) return ok;
  if (view && (startableModes(view) as string[]).includes(mode)) return ok;
  if ((PREP_DOWNSTREAM_MODES as string[]).includes(mode)) {
    return no(unimplementedModeReason(mode));
  }
  return no(`unknown downstream mode ${JSON.stringify(mode)} — expected one of ${PREP_DOWNSTREAM_MODES.join('|')}`);
}

/** Completeness state label for a document kind — the server sends a state
 * string per kind ('absent'|'draft'|'presented'|'confirmed'|'approved'),
 * counts for assumptions/decisions, an object for openQuestions. */
export function prepCompletenessState(
  view: ExecPrepView | null | undefined,
  kind: string,
): PrepCompletenessState | null {
  const v: PrepCompletenessValue | undefined = view?.completeness?.[kind];
  return typeof v === 'string' ? (v as PrepCompletenessState) : null;
}

export function prepOpenQuestionCounts(
  view: ExecPrepView | null | undefined,
): PrepCompletenessCounters {
  const v: PrepCompletenessValue | undefined = view?.completeness?.['openQuestions'];
  if (v && typeof v === 'object') {
    const c = v as Partial<PrepCompletenessCounters>;
    return {
      open: c.open ?? 0,
      blocking: c.blocking ?? 0,
      answered: c.answered ?? 0,
      deferred: c.deferred ?? 0,
    };
  }
  const open = prepQuestions(view).filter((q) => q.status === 'open');
  return {
    open: open.length,
    blocking: open.filter((q) => q.blocking === true).length,
    answered: prepQuestions(view).filter((q) => q.status === 'answered').length,
    deferred: 0,
  };
}

const PREP_PHASE_LABELS: Record<string, string> = {
  clarify: 'clarifying the idea',
  requirements: 'requirements',
  design: 'design',
  plan: 'plan',
  ready: 'ready for implementation',
};

export function prepPhaseLabel(phase: string | null | undefined): string {
  return PREP_PHASE_LABELS[phase ?? ''] ?? phase ?? '—';
}

const PREP_STAGE_LABELS: Record<string, string> = {
  intent: 'interview',
  requirements: 'requirements',
  design: 'design',
  plan: 'plan',
  review: 'review',
};

export function prepStageLabel(stage: string | null | undefined): string {
  return PREP_STAGE_LABELS[stage ?? ''] ?? stage ?? '—';
}

const PREP_STATUS_LABELS: Record<string, string> = {
  active: 'active',
  stopped: 'stopped',
  completed: 'handed off',
};

export function prepStatusLabel(s: string | null | undefined): string {
  return PREP_STATUS_LABELS[s ?? ''] ?? s ?? '—';
}

const PREP_GATE_TYPE_LABELS: Record<string, string> = {
  intent_confirm: 'intent confirmation',
  artifact_confirm: 'document confirmation',
};

export function prepGateLabel(g: PrepGate): string {
  const kind = PREP_GATE_TYPE_LABELS[g.type] ?? g.type;
  const docKind = (g.subject as { docKind?: string } | null)?.docKind;
  return docKind ? `${kind} — ${docKindLabel(docKind as ExecDocKind)}` : kind;
}

/** One-line human text for a readiness blocker (code + server detail). */
export function prepBlockerText(b: { code: string; detail?: string }): string {
  return b.detail ? `${b.code}: ${b.detail}` : b.code;
}

// -- discussion / questions ----------------------------------------------------

export function prepQuestions(view: ExecPrepView | null | undefined): PrepQuestion[] {
  return view?.checkpoint?.openQuestions ?? [];
}

export function prepOpenQuestions(
  view: ExecPrepView | null | undefined,
): PrepQuestion[] {
  return prepQuestions(view).filter((q) => q.status === 'open');
}

export function prepBlockingQuestions(
  view: ExecPrepView | null | undefined,
): PrepQuestion[] {
  return prepOpenQuestions(view).filter((q) => q.blocking === true);
}

/** The discussion transcript the card renders: answered + open questions in
 * order, then decisions/assumptions — one conversation, derived records. */
export function prepConversation(
  view: ExecPrepView | null | undefined,
): { kind: 'question' | 'decision' | 'assumption'; text: string; ref?: PrepQuestion }[] {
  if (!view) return [];
  const out: { kind: 'question' | 'decision' | 'assumption'; text: string; ref?: PrepQuestion }[] = [];
  for (const q of prepQuestions(view)) {
    if (q.status === 'superseded') continue;
    out.push({ kind: 'question', text: q.text, ref: q });
  }
  for (const d of view.checkpoint?.decisions ?? []) {
    out.push({ kind: 'decision', text: String(d?.text ?? '') });
  }
  for (const a of view.checkpoint?.assumptions ?? []) {
    out.push({ kind: 'assumption', text: String(a?.text ?? '') });
  }
  return out;
}

// -- bindings ------------------------------------------------------------------

/** Registry rows bindable at `stage` — available first, then unsupported
 * rows (shown with their refusal reason, never silently dropped). */
export function prepBindingsForStage(
  bindings: PrepBindingInfo[] | null | undefined,
  stage: PrepStage,
): PrepBindingInfo[] {
  const rows = (bindings ?? []).filter((b) => b.stage === stage);
  return [...rows].sort((a, b) => {
    const ua = a.status === 'available' ? 0 : 1;
    const ub = b.status === 'available' ? 0 : 1;
    return ua - ub || a.bindingId.localeCompare(b.bindingId);
  });
}

/** Why an assigned binding row is not healthy — stale pin, drift, or an
 * unsupported status recorded on the assignment. */
export function prepBindingProblem(ref: PrepBindingRef | null | undefined): string | null {
  if (!ref) return null;
  if (ref.stale === true) {
    return 'the registry pin changed since assignment — re-confirm or switch binding (AE4)';
  }
  if (ref.configDrift === true) {
    return 'the binding contract changed since assignment — re-confirm or switch binding';
  }
  if (ref.resourceDrift?.length) {
    return `pinned resources drifted: ${ref.resourceDrift.join(', ')}`;
  }
  return null;
}

// -- action gates ----------------------------------------------------------------

/** `start_preparation`: the feature must be on, the card managed, and no
 * ACTIVE session may exist — a stopped session opens a new one (the
 * server refuses a second active session outright). */
export function canStartPrep(view: ExecCardView): GateResult {
  if (view.features?.preparation !== true) {
    return no('idea preparation is not enabled on this deployment');
  }
  const p = view.preparation;
  if (p && p.status === 'active') {
    return no(`a preparation session is already active (${p.sessionId})`);
  }
  return ok;
}

/** `stop_preparation`: an active session only — a stopped session is already
 * parked (its state is preserved, restart is not a command). */
export function canStopPrep(view: ExecCardView): GateResult {
  const p = view.preparation;
  if (!p) return no('no preparation session');
  if (p.status !== 'active') return no(`the session is already ${p.status}`);
  return ok;
}

/** `answer_question` / `continue_discussion` / `request_draft`: the session
 * must be active; a stopped session preserves state but accepts no input. */
export function canTalkPrep(view: ExecCardView): GateResult {
  const p = view.preparation;
  if (!p) return no('no preparation session');
  if (p.status !== 'active') {
    return no(`the session is ${p.status} — the conversation is closed`);
  }
  return ok;
}

/** `confirm_gate`: pending gates exist and the session is active. */
export function canConfirmGate(view: ExecCardView, gate: PrepGate): GateResult {
  const talk = canTalkPrep(view);
  if (!talk.ok) return talk;
  if (gate.status === 'confirmed') return no('already confirmed');
  if (gate.status === 'invalidated') {
    return no(`invalidated (${gate.invalidationReason ?? 'unknown'}) — the subject must be re-derived`);
  }
  return ok;
}

/** `change_skill_binding`: the session must be active; `null` unbinds the
 * stage explicitly. An unsupported route stays selectable — the server
 * answers binding_unavailable and the refusal is shown verbatim. */
export function canChangePrepBinding(
  view: ExecCardView,
  _stage: PrepStage,
  bindingId: string | null,
): GateResult {
  const talk = canTalkPrep(view);
  if (!talk.ok) return talk;
  if (bindingId !== null && !bindingId.trim()) return no('choose a binding');
  return ok;
}

/** `handoff_preparation`: readiness must hold — the recorded handoff
 * package binds exactly the approved inputs (the server re-derives it; a
 * not-ready session gets 422 preparation_not_ready). Implementation start
 * stays a separate `start` action — this command only RECORDS the handoff. */
export function canPrepHandoff(view: ExecCardView): GateResult {
  const p = view.preparation;
  if (!p) return no('no preparation session');
  if (p.status !== 'active') return no(`the session is ${p.status}`);
  if (p.ready !== true) {
    return no(
      `not ready — ${p.blockerCount} blocker(s): approvals, gates and open questions must all resolve`,
    );
  }
  return ok;
}

// -- preparation command payloads ----------------------------------------------

export function prepStartPayload(
  intent: string,
  bindings?: Partial<Record<PrepStage, string | null>>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { intent };
  if (bindings && Object.keys(bindings).length) payload.bindings = bindings;
  return payload;
}

export function prepAnswerPayload(questionId: string, answer: string): Record<string, unknown> {
  return { questionId, answer };
}

export function prepDraftPayload(docKind: ExecDocKind, note?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { kind: docKind };
  if (note?.trim()) payload.note = note.trim().slice(0, 2000);
  return payload;
}

export function prepContinuePayload(text?: string): Record<string, unknown> {
  return text?.trim() ? { text: text.trim().slice(0, 2000) } : {};
}

export function prepStopPayload(reason?: string): Record<string, unknown> {
  return reason?.trim() ? { reason: reason.trim().slice(0, 500) } : {};
}

export function prepBindPayload(stage: PrepStage, bindingId: string | null): Record<string, unknown> {
  return { stage, bindingId };
}

export function prepGatePayload(gateId: string): Record<string, unknown> {
  return { gateId };
}

/** `handoff_preparation` payload — mode is REQUIRED server-side (one of
 * solo|fusion|orchestrator|swarm); it names the downstream mode the offer
 * is recorded for and never launches it. */
export function prepHandoffPayload(mode: string, note?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { mode };
  if (note?.trim()) payload.note = note.trim().slice(0, 500);
  return payload;
}

// == orchestrator run graph (backend-ui-contract §§4–5) =====================
//
// Presentation + gating for run.orchestrator. Every gate mirrors a server
// rule from the contract's command table: the spec-approval binds the
// exact pending sha256; answer/grant/retry address a waiting/failed task
// by taskId; stop/continue halt/resume ALL participants atomically. The
// server remains authoritative — these produce disabled-reason text.

export function isOrchestrator(run: ExecRun | null | undefined): boolean {
  return run?.mode === 'orchestrator' && !!run.orchestrator;
}

export function orchestrator(run: ExecRun | null | undefined): OrchestratorState | null {
  return isOrchestrator(run) ? (run!.orchestrator ?? null) : null;
}

export function orchTasks(run: ExecRun | null | undefined): OrchTask[] {
  return (orchestrator(run)?.tasks ?? []).map((row) => {
    const state = row.state;
    const fixing = state.status === 'returned';
    return {
      taskId: row.id, title: row.title, status: state.status,
      deps: row.dependsOn, profile: row.worker.profileId, boundary: row.boundary,
      inputCommit: state.inputCommit, snapshotOf: state.snapshotOf,
      resultCommit: state.resultCommit, resultSha256: state.resultSha256,
      waiting: state.waiting,
      evidence: state.evidence ? {
        verdict: state.evidence.verdict, verifyArtifactId: state.evidence.verdictArtifactId,
      } : null,
      budget: {
        used: fixing ? state.fixesUsed : state.attemptsUsed,
        limit: fixing ? row.limits.maxFixCycles + (state.extraFixes ?? 0)
          : row.limits.maxAttempts + (state.extraAttempts ?? 0),
      },
      attempts: state.attempts.flatMap((id) => {
        const attempt = run?.attempts?.find((a) => a.id === id);
        return attempt ? [{ ...attempt, kind: String(attempt.kind ?? attempt.role) }] : [];
      }),
    };
  });
}

export function orchTask(
  run: ExecRun | null | undefined,
  taskId: string,
): OrchTask | null {
  return orchTasks(run).find((t) => t.taskId === taskId) ?? null;
}

export function orchPendingActions(run: ExecRun | null | undefined): OrchPendingAction[] {
  return orchestrator(run)?.pendingActions ?? [];
}

const ORCH_TASK_LABELS: Record<string, string> = {
  pending: 'pending',
  ready: 'ready — launchable',
  running: 'running',
  verifying: 'verifying',
  returned: 'returned — fix round queued',
  accepted: 'accepted',
  failed: 'failed',
  blocked: 'blocked',
  waiting: 'waiting on you',
  cancelled: 'cancelled',
};

export function orchTaskStatusLabel(s: string | null | undefined): string {
  return ORCH_TASK_LABELS[s ?? ''] ?? s ?? '—';
}

const ORCH_PHASE_LABELS: Record<string, string> = {
  decompose: 'decomposing',
  approval: 'awaiting spec approval',
  work: 'working',
  integrate: 'integrating',
  validate: 'validating',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
};

export function orchPhaseLabel(s: string | null | undefined): string {
  return ORCH_PHASE_LABELS[s ?? ''] ?? s ?? '—';
}

/** One-line text for a durable orchestrator pending action — the
 * required-action banner. */
export function orchPendingActionText(a: OrchPendingAction): string {
  if (a.type === 'spec_approval') {
    return `decomposition spec ${fmtSha(a.specSha256, 12)}… awaits your approval — ready tasks promote only after it freezes`;
  }
  if (a.type === 'question') {
    return `task ${a.taskId} asks: ${a.question ?? 'a question awaits your answer'}`;
  }
  if (a.type === 'grant') {
    return `task ${a.taskId} exhausted its attempts (${a.reason ?? 'attempts_exhausted'}) — grant budget or decide`;
  }
  return `input change ${a.proposalId} (${a.kind}) affects ${a.fields.join(', ')} — approve or reject the proposal`;
}

/** Run states in which the server still accepts an orchestrator user
 * decision — live or stopped work, never a finished/failed run. */
const ORCH_DECIDABLE_RUN = new Set(['queued', 'active', 'blocked']);

function orchDecidable(run: ExecRun | null): GateResult {
  if (!isOrchestrator(run)) return no('not an orchestrator run');
  if (!ORCH_DECIDABLE_RUN.has(run!.status)) {
    return no(`run is ${run!.status} — orchestrator decisions apply only to live or blocked runs`);
  }
  return ok;
}

/** `orch_approve`: a matching spec_approval pending action AND the sha256
 * must be the CURRENT spec version (a stale approval is refused
 * server-side anyway). */
export function canOrchApprove(run: ExecRun | null, specSha256?: string): GateResult {
  const d = orchDecidable(run);
  if (!d.ok) return d;
  const o = orchestrator(run)!;
  if (o.graph?.pendingApproval) return no('resolve the pending input-change proposal first');
  const pending = (o.pendingActions ?? []).find((a) => a.type === 'spec_approval');
  if (!pending || pending.type !== 'spec_approval') {
    return no('the run is not waiting on a spec approval');
  }
  const want = specSha256 ?? o.spec?.sha256 ?? null;
  if (want && want !== pending.specSha256) {
    return no('a newer spec version is pending — only the current version is approvable');
  }
  if ((o.spec?.status ?? 'pending') !== 'pending') {
    return no(`the spec is ${o.spec?.status} — only a pending spec may be approved`);
  }
  return ok;
}

/** `orch_answer`: the task must be waiting on a question (or carry a
 * matching question pending action). */
export function canOrchAnswer(run: ExecRun | null, taskId: string): GateResult {
  const d = orchDecidable(run);
  if (!d.ok) return d;
  const t = orchTask(run, taskId);
  if (!t) return no(`task ${taskId} is not in this run`);
  const waitingQuestion = t.status === 'waiting' && (t.waiting?.reason ?? 'question') === 'question';
  const pending = orchPendingActions(run).some(
    (a) => a.type === 'question' && (a as { taskId: string }).taskId === taskId);
  if (!waitingQuestion && !pending) {
    return no(`task ${taskId} is ${t.status} — only a task waiting on a question may be answered`);
  }
  return ok;
}

/** `orch_grant`: the task exhausted its budget (failed, or waiting on a
 * grant) — adds attempts and re-readies it. */
export function canOrchGrant(run: ExecRun | null, taskId: string): GateResult {
  const d = orchDecidable(run);
  if (!d.ok) return d;
  const t = orchTask(run, taskId);
  if (!t) return no(`task ${taskId} is not in this run`);
  const grantPending = orchPendingActions(run).some(
    (a) => a.type === 'grant' && (a as { taskId: string }).taskId === taskId);
  if (!['failed', 'blocked', 'waiting'].includes(t.status) && !grantPending
    && !(t.status === 'waiting' && t.waiting?.reason === 'attempts_exhausted')) {
    return no(`task ${taskId} is ${t.status} — only an attempts-exhausted task may be granted budget`);
  }
  return ok;
}

/** `orch_retry`: the task failed but still holds budget (contract: "with
 * budget left" — the UI reads budget.used < budget.limit when present;
 * absent budget figures defer to the server). */
export function canOrchRetry(run: ExecRun | null, taskId: string): GateResult {
  const d = orchDecidable(run);
  if (!d.ok) return d;
  const t = orchTask(run, taskId);
  if (!t) return no(`task ${taskId} is not in this run`);
  if (!['failed', 'returned', 'waiting'].includes(t.status)) {
    return no(`task ${taskId} is ${t.status} — only failed/returned/waiting tasks may be retried`);
  }
  const used = t.budget?.used;
  const limit = t.budget?.limit;
  if (typeof used === 'number' && typeof limit === 'number' && used >= limit) {
    return no(`task ${taskId} exhausted its budget (${used}/${limit}) — grant attempts first`);
  }
  return ok;
}

export function canOrchDecide(run: ExecRun | null, proposalId: string): GateResult {
  const d = orchDecidable(run);
  if (!d.ok) return d;
  const o = orchestrator(run)!;
  if (o.graph?.pendingApproval?.proposalId !== proposalId
    || !orchPendingActions(run).some((a) => a.type === 'decision' && a.proposalId === proposalId)) {
    return no('this input-change proposal is no longer pending');
  }
  return ok;
}

export function orchDecidePayload(run: ExecRun, proposalId: string, decision: 'approve' | 'reject'): Record<string, unknown> {
  return { runId: run.id, proposalId, decision };
}

export function orchApprovePayload(run: ExecRun, specSha256: string): Record<string, unknown> {
  return { runId: run.id, specSha256 };
}

export function orchAnswerPayload(run: ExecRun, taskId: string, answer: string): Record<string, unknown> {
  return { runId: run.id, taskId, answer };
}

export function orchGrantPayload(run: ExecRun, taskId: string, attempts: number, fixCycles?: number): Record<string, unknown> {
  return { runId: run.id, taskId, attempts, ...(fixCycles === undefined ? {} : { fixCycles }) };
}

export function orchRetryPayload(run: ExecRun, taskId: string): Record<string, unknown> {
  return { runId: run.id, taskId };
}

// -- orchestrator start composition (backend-ui-contract §3) ------------------
//
// The UI composes the orchestrator block from durable choices: worker
// model picks from the compat table, synthesized into inline full profiles
// for decomposer/verifier/integrator and workers, validated by the server.

export interface OrchWorkerDraft {
  name: string;
  profileId: string;
}

export interface OrchDraft {
  decomposer: string;
  verifier: string;
  integrator: string;
  workers: OrchWorkerDraft[];
  limits?: {
    taskAttempts?: number;
    maxIntegratorAttempts?: number;
    maxSubtasks?: number;
    requireSpecApproval?: boolean;
  };
  baseRef?: string;
}

/** Client-side mirror of the contract's start-shape gates — problems the
 * server would refuse, for display before POST. */
export function orchDraftProblems(view: ExecCardView, d: OrchDraft): string[] {
  const problems: string[] = [];
  if (!d.decomposer?.trim()) problems.push('a decomposer profile is required');
  if (!d.verifier?.trim()) problems.push('a verifier profile is required');
  if (!d.integrator?.trim()) problems.push('an integrator profile is required');
  if (!(d.workers ?? []).length) problems.push('at least one worker pool profile is required');
  const names = new Set<string>();
  for (const w of d.workers ?? []) {
    if (!w.name?.trim()) problems.push('every worker entry needs a name');
    else if (names.has(w.name.trim())) problems.push(`duplicate worker name ${w.name.trim()}`);
    else names.add(w.name.trim());
    if (!w.profileId?.trim()) problems.push(`worker ${w.name?.trim() || '?'} needs a profile`);
  }
  const live = inflightRuns(view);
  if (live.length) {
    problems.push(`run ${live[0].id} is still live — stop it and let it settle first`);
  }
  return problems;
}

export function canStartOrchestrator(view: ExecCardView, d: OrchDraft): GateResult {
  if (view.features?.orchestrator !== true) {
    return no('orchestrator mode is not enabled on this deployment');
  }
  const g = canStartInMode('orchestrator', view);
  if (!g.ok) return g;
  const problems = orchDraftProblems(view, d);
  return problems.length ? no(problems[0]) : ok;
}

/** Models come from the same pi compatibility list as fusion; profiles are inline. */
function modeProfile(modelRef: string, profileId: string, role: FusionProfilePick['role']): Record<string, unknown> {
  const { provider, model } = splitModelRef(modelRef.trim());
  return fusionProfile({ profileId, provider, model, role });
}

/** The `start` payload for mode 'orchestrator' (contract §3). */
export function orchStartPayload(d: OrchDraft): Record<string, unknown> {
  const workers: Record<string, { profile: Record<string, unknown> }> = {};
  for (const w of d.workers ?? []) {
    if (w.name?.trim() && w.profileId?.trim()) workers[w.name.trim()] = { profile: modeProfile(w.profileId, `orch-worker-${w.name.trim()}`, 'integrator') };
  }
  const orchestrator: Record<string, unknown> = {
    decomposer: { profile: modeProfile(d.decomposer, 'orch-decomposer', 'judge') },
    verifier: { profile: modeProfile(d.verifier, 'orch-verifier', 'judge') },
    integrator: { profile: modeProfile(d.integrator, 'orch-integrator', 'integrator') },
    workers,
  };
  const L = d.limits ?? {};
  const limits: Record<string, unknown> = {};
  if (typeof L.taskAttempts === 'number' && L.taskAttempts > 0) {
    limits.taskAttempts = Math.floor(L.taskAttempts);
  }
  if (typeof L.maxIntegratorAttempts === 'number' && L.maxIntegratorAttempts > 0) {
    limits.maxIntegratorAttempts = Math.floor(L.maxIntegratorAttempts);
  }
  if (typeof L.maxSubtasks === 'number' && L.maxSubtasks > 0) {
    limits.maxSubtasks = Math.floor(L.maxSubtasks);
  }
  if (typeof L.requireSpecApproval === 'boolean') limits.requireSpecApproval = L.requireSpecApproval;
  if (Object.keys(limits).length) orchestrator.limits = limits;
  const payload: Record<string, unknown> = { mode: 'orchestrator', orchestrator };
  if (d.baseRef?.trim()) payload.baseRef = d.baseRef.trim();
  return payload;
}

// == swarm run state (backend-ui-contract §§6–7) ==============================
//
// Presentation + gating for run.swarm. Every gate mirrors a server rule:
// input steers/answers a participant (or all); extend grants turns on
// exhaustion; decide settles a broker-escalated contested decision by id;
// stop/continue freeze-all/resume. While frozen (verify/review/
// awaiting_acceptance) the UI disables apply expectations and shows the
// freeze reason — the broker rejects those edits anyway.

export function isSwarm(run: ExecRun | null | undefined): boolean {
  return run?.mode === 'swarm' && !!run.swarm;
}

export function swarm(run: ExecRun | null | undefined): SwarmState | null {
  return isSwarm(run) ? (run!.swarm ?? null) : null;
}

export function swarmParticipants(run: ExecRun | null | undefined): SwarmParticipant[] {
  return swarm(run)?.participants ?? [];
}

export function swarmParticipant(
  run: ExecRun | null | undefined,
  participantId: string,
): SwarmParticipant | null {
  return swarmParticipants(run).find((p) => p.participantId === participantId) ?? null;
}

export function swarmMessages(run: ExecRun | null | undefined): SwarmMessage[] {
  return [...(swarm(run)?.messages ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export function swarmDecisions(run: ExecRun | null | undefined): SwarmDecision[] {
  return swarm(run)?.decisions ?? [];
}

export function swarmDecision(
  run: ExecRun | null | undefined,
  decisionId: string,
): SwarmDecision | null {
  return swarmDecisions(run).find((d) => d.id === decisionId) ?? null;
}

export function swarmPendingActions(run: ExecRun | null | undefined): SwarmPendingAction[] {
  return swarm(run)?.pendingActions ?? [];
}

const SWARM_PHASE_LABELS: Record<string, string> = {
  prepare: 'preparing',
  implement: 'implementing',
  verify: 'verifying',
  review: 'review',
  awaiting_acceptance: 'awaiting your acceptance',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
};

export function swarmPhaseLabel(s: string | null | undefined): string {
  return SWARM_PHASE_LABELS[s ?? ''] ?? s ?? '—';
}

const SWARM_STATUS_LABELS: Record<string, string> = {
  active: 'active',
  waiting: 'waiting on you',
  exhausted: 'turns exhausted',
  stopped: 'stopped',
  done: 'done',
};

export function swarmStatusLabel(s: string | null | undefined): string {
  return SWARM_STATUS_LABELS[s ?? ''] ?? s ?? '—';
}

/** True while the broker rejects new edits — the UI disables apply
 * expectations and shows the freeze reason instead. */
export function swarmFrozen(run: ExecRun | null | undefined): { frozen: boolean; reason: string } {
  const s = swarm(run);
  if (s?.freeze?.active === true) {
    return { frozen: true, reason: s.freeze.reason ?? 'frozen' };
  }
  if (s && ['verify', 'review', 'awaiting_acceptance'].includes(s.phase ?? '')) {
    return { frozen: true, reason: s.phase ?? 'frozen' };
  }
  return { frozen: false, reason: '' };
}

/** One-line text for a durable swarm pending action. */
export function swarmPendingActionText(
  a: SwarmPendingAction,
  run?: ExecRun | null,
): string {
  if (a.type === 'decision') {
    const d = run ? swarmDecision(run, a.decisionId) : null;
    const what = d
      ? `${d.kind ?? 'decision'} on ${(d.paths ?? []).join(', ') || 'shared paths'}${d.rationale ? ` — ${d.rationale.slice(0, 120)}` : ''}`
      : `decision ${a.decisionId}`;
    return `contested decision needs you: ${what}`;
  }
  if (a.type === 'question') {
    const p = run ? swarmParticipant(run, a.participantId) : null;
    const who = p ? `${p.callsign ?? p.participantId} (${p.participantId})` : a.participantId;
    return `participant ${who} asks: ${a.question ?? 'a question awaits your answer'}`;
  }
  const who = a.participantId ? `participant ${a.participantId}` : 'the swarm';
  return `${who} exhausted its turns (${a.reason ?? 'turns_exhausted'}) — extend the budget or stop`;
}

/** Run states in which the server still accepts a swarm user decision. */
const SWARM_DECIDABLE_RUN = new Set(['queued', 'active', 'blocked']);

function swarmDecidable(run: ExecRun | null): GateResult {
  if (!isSwarm(run)) return no('not a swarm run');
  if (!SWARM_DECIDABLE_RUN.has(run!.status)) {
    return no(`run is ${run!.status} — swarm decisions apply only to live or blocked runs`);
  }
  return ok;
}

/** `swarm_input`: steer/answer one participant, or 'all' to broadcast.
 * Frozen runs refuse — the broker would reject the steer anyway. */
export function canSwarmInput(
  run: ExecRun | null,
  participantId: string,
  text?: string,
): GateResult {
  const d = swarmDecidable(run);
  if (!d.ok) return d;
  const frozen = swarmFrozen(run);
  if (frozen.frozen) return no(`the swarm is frozen (${frozen.reason}) — input is held until it clears`);
  if (participantId !== 'all' && !swarmParticipant(run, participantId)) {
    return no(`participant ${participantId} is not in this swarm`);
  }
  if (text !== undefined && !text.trim()) return no('write the message first');
  return ok;
}

/** `swarm_extend`: the named participant (or the swarm when omitted)
 * exhausted its turns — grants more. */
export function canSwarmExtend(run: ExecRun | null, participantId?: string | null): GateResult {
  const d = swarmDecidable(run);
  if (!d.ok) return d;
  if (participantId) {
    const p = swarmParticipant(run, participantId);
    if (!p) return no(`participant ${participantId} is not in this swarm`);
    const extendPending = swarmPendingActions(run).some(
      (a) => a.type === 'extend'
        && ((a as { participantId?: string | null }).participantId ?? null) === participantId);
    if (p.status !== 'exhausted' && !extendPending) {
      return no(`participant ${participantId} is ${p.status} — only an exhausted participant may be extended`);
    }
  }
  return ok;
}

/** `swarm_decide`: settle a broker-escalated contested decision by id. */
export function canSwarmDecide(run: ExecRun | null, decisionId: string): GateResult {
  const d = swarmDecidable(run);
  if (!d.ok) return d;
  const dec = swarmDecision(run, decisionId);
  if (!dec) return no(`decision ${decisionId} is not in this swarm`);
  if (dec.status !== 'pending') {
    return no(`decision ${decisionId} is ${dec.status} — only a pending decision may be settled`);
  }
  const escalated = swarmPendingActions(run).some(
    (a) => a.type === 'decision' && (a as { decisionId: string }).decisionId === decisionId);
  if (!escalated) {
    return no(`decision ${decisionId} is not escalated to you — nothing to settle`);
  }
  return ok;
}

export function swarmInputPayload(
  run: ExecRun,
  participantId: string,
  text: string,
): Record<string, unknown> {
  return { runId: run.id, participantId, text };
}

export function swarmExtendPayload(
  run: ExecRun,
  turns: number,
  participantId?: string | null,
): Record<string, unknown> {
  const p: Record<string, unknown> = { runId: run.id, turns };
  if (participantId) p.participantId = participantId;
  return p;
}

export function swarmDecidePayload(
  run: ExecRun,
  decisionId: string,
  outcome: 'approve' | 'reject',
  note?: string,
): Record<string, unknown> {
  const p: Record<string, unknown> = { runId: run.id, decisionId, outcome };
  if (note?.trim()) p.note = note.trim().slice(0, 500);
  return p;
}

// -- swarm start composition (backend-ui-contract §3) -------------------------

export interface SwarmParticipantDraft {
  participantId: string;
  callsign: string;
  profileId: string;
  ownedPaths: string;
}

export interface SwarmDraft {
  participants: SwarmParticipantDraft[];
  shared?: Record<string, string>;
  limits?: {
    maxTurnsPerParticipant?: number;
    maxRounds?: number;
    maxMessages?: number;
    verifyRequired?: boolean;
  };
  baseRef?: string;
}

/** Client-side mirror of the contract's swarm start-shape gates. */
export function swarmDraftProblems(view: ExecCardView, d: SwarmDraft): string[] {
  const problems: string[] = [];
  const list = d.participants ?? [];
  if (list.length < 2) problems.push('a swarm needs at least 2 participants');
  if (list.length > 3) problems.push('a swarm holds at most 3 participants');
  const ids = new Set<string>();
  for (const p of list) {
    if (!p.participantId?.trim()) problems.push('every participant needs an id');
    else if (ids.has(p.participantId.trim())) problems.push(`duplicate participant id ${p.participantId.trim()}`);
    else ids.add(p.participantId.trim());
    if (!p.profileId?.trim()) problems.push(`participant ${p.participantId?.trim() || '?'} needs a profile`);
    if (!(p.ownedPaths ?? '').split(',').map((s) => s.trim()).filter(Boolean).length) {
      problems.push(`participant ${p.participantId?.trim() || '?'} needs owned paths`);
    }
  }
  const live = inflightRuns(view);
  if (live.length) {
    problems.push(`run ${live[0].id} is still live — stop it and let it settle first`);
  }
  return problems;
}

export function canStartSwarm(view: ExecCardView, d: SwarmDraft): GateResult {
  if (view.features?.swarm !== true) return no('swarm mode is not enabled on this deployment');
  const g = canStartInMode('swarm', view);
  if (!g.ok) return g;
  const problems = swarmDraftProblems(view, d);
  return problems.length ? no(problems[0]) : ok;
}

/** The `start` payload for mode 'swarm' (contract §3). */
export function swarmStartPayload(d: SwarmDraft): Record<string, unknown> {
  const participants = (d.participants ?? []).map((p) => ({
    participantId: p.participantId.trim(),
    callsign: p.callsign?.trim() || p.participantId.trim(),
    profile: modeProfile(p.profileId, `swarm-${p.participantId.trim()}`, 'integrator'),
    ownedPaths: p.ownedPaths.split(',').map((s) => s.trim()).filter(Boolean),
  }));
  const swarm: Record<string, unknown> = { participants };
  if (d.shared && Object.keys(d.shared).length) swarm.shared = { ...d.shared };
  const L = d.limits ?? {};
  const limits: Record<string, unknown> = {};
  if (typeof L.maxTurnsPerParticipant === 'number' && L.maxTurnsPerParticipant > 0) {
    limits.maxTurnsPerParticipant = Math.floor(L.maxTurnsPerParticipant);
  }
  if (typeof L.maxRounds === 'number' && L.maxRounds > 0) limits.maxRounds = Math.floor(L.maxRounds);
  if (typeof L.maxMessages === 'number' && L.maxMessages > 0) limits.maxMessages = Math.floor(L.maxMessages);
  if (typeof L.verifyRequired === 'boolean') limits.verifyRequired = L.verifyRequired;
  if (Object.keys(limits).length) swarm.limits = limits;
  const payload: Record<string, unknown> = { mode: 'swarm', swarm };
  if (d.baseRef?.trim()) payload.baseRef = d.baseRef.trim();
  return payload;
}
