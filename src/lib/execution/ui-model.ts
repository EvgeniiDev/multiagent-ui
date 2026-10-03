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
  PrepBindingInfo,
  PrepBindingRef,
  PrepGate,
  PrepQuestion,
  PrepStage,
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

export const PREP_STAGES: PrepStage[] = ['intent', 'requirements', 'design', 'plan', 'review'];

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
