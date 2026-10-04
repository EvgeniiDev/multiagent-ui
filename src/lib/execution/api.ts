// Managed execution API client (U6) — the typed user-channel surface of
// server/execution/state-service.mjs. Erasable-TS only so node:test can run
// it directly (same convention as src/lib/porch/api.ts).
//
// Wire contract (all under the state server base, e.g. http://host:25900):
//   GET    /api/execution/cards                              → {cards: [summary]}
//   GET    /api/execution/cards/:cardId                      → ExecCardView
//   GET    /api/execution/cards/:cardId/documents/:versionId → ExecDocVersion & {content}
//   POST   /api/execution/cards/:cardId/commands             → {ok,cardId,controlRevision,result}
//   GET    /api/execution/presets                            → {presets,rev,compatibility,compatError}
//   POST   /api/execution/presets                            → {ok,preset,rev}
//   PUT    /api/execution/presets/:presetId                  → {ok,preset,rev}
//   DELETE /api/execution/presets/:presetId                  → {ok,deleted,rev}
//   GET    /api/execution/runs/:runId                        → ExecRun
//   GET    /api/execution/runs/:runId/events?cursor&limit    → {runId,events,nextCursor,remaining,total,corrupt}
//   GET    /api/execution/runs/:runId/artifacts/:artifactId  → {artifactId,kind,bytes,sha256,content,contentBase64}
//
// Every card mutation is a command envelope {commandId, type, payload,
// expectedControlRevision}; the server dedups commandId BEFORE the revision
// check, so replaying an id returns the recorded result and reusing an id
// with a different payload answers 409 command_conflict. Lifecycle commands
// are never queued or retried automatically — one deliberate user action
// generates one commandId.

import { toSecureUrl } from '../host/secure.ts';

// ---------------------------------------------------------------------------
// Types mirrored from server/execution/execution-domain.mjs
// ---------------------------------------------------------------------------

export const DOC_KINDS = ['requirements', 'plan', 'design'] as const;
export type ExecDocKind = (typeof DOC_KINDS)[number];

export const EXEC_ROLES = ['implementer', 'reviewer', 'checker'] as const;
export type ExecRole = (typeof EXEC_ROLES)[number];

/** One check command bound into a plan approval. Data only — never
 * templated or executed client-side. */
export interface ExecCheck {
  run: string;
  cwd?: string;
  timeoutSec?: number;
  setup?: boolean;
}

export interface ExecDocSource {
  type: 'text' | 'import';
  /** import only: registered project id (defaults to the card's project). */
  projectId?: string;
  /** import only: path relative to the project root. */
  path?: string;
  /** import only: resolved absolute path echoed back by the server. */
  resolvedPath?: string;
}

export interface ExecDocVersion {
  versionId: string;
  kind: ExecDocKind;
  sha256: string;
  bytes: number;
  createdAt: number;
  source: ExecDocSource;
  /** plan only: the requirements version this plan was prepared for. */
  requirements?: { versionId: string; sha256: string } | null;
  /** plan only: structured checks attached with the version payload. */
  checks?: { source: string; checks: ExecCheck[] };
  /** plan only: parse result of the document's ```acp-checks block. */
  checksFromDocument?: {
    ok: boolean;
    checks?: ExecCheck[];
    problems?: string[];
  };
}

export interface ExecDocState {
  /** versionId of the current version, or null before the first attach. */
  current: string | null;
  versions: ExecDocVersion[];
}

export interface ExecDocVersionContent extends ExecDocVersion {
  content: string;
}

export interface ExecApproval {
  versionId: string;
  sha256: string;
  at: number;
  by: string;
}

export interface ExecPlanApproval extends ExecApproval {
  requirementsVersionId: string;
  requirementsSha256: string;
  checks: ExecCheck[];
  checksSource: string;
}

export interface ExecApprovals {
  requirements: ExecApproval | null;
  plan: ExecPlanApproval | null;
}

export interface ExecPresetMember {
  cli: string;
  model: string;
  effort?: string;
  params?: Record<string, string | number | boolean>;
}

export interface ExecPresetLimits {
  maxAttemptsPerRole: number;
  timeoutMin: number;
  maxReviewRounds: number;
}

export interface ExecPreset {
  id: string;
  name: string;
  members: Record<ExecRole, ExecPresetMember>;
  limits: ExecPresetLimits;
  revision?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** The input accepted by POST/PUT /presets and the save_preset command:
 * the stored record minus server-assigned bookkeeping. */
export interface ExecPresetInput {
  id?: string;
  name: string;
  members: Record<ExecRole, ExecPresetMember>;
  limits: Partial<ExecPresetLimits>;
}

export interface ExecCompatEntry {
  models: string[];
  /** null = the CLI carries no separate effort knob. */
  effort: string[] | null;
  params: string[];
}

export type ExecCompatibility = Record<string, ExecCompatEntry>;

export interface ExecComposition {
  presetId: string;
  preset: ExecPreset;
  boundAt: number;
}

export interface ExecRunSummary {
  id: string;
  status: string | null;
  /** A live attempt or active/unproven validation still reserves the run —
   * never infer activity from `status` alone. */
  reserved: boolean;
  /** 'solo' | 'fusion' — absent only on legacy pre-F4 summaries. */
  mode?: string;
  /** Count of durable fusion pendingActions — >0 means the run is waiting
   * on a USER decision (participant retry/exclude, work-order approval). */
  pending?: number;
}

export interface ExecWorkspaceView {
  id: string;
  status: string;
  runId: string | null;
  path: string;
  branch: string;
  owner: {
    runnerId: string;
    instanceId: string | null;
    pid: number | null;
    pidStarttime: string | null;
    envKey: unknown;
  } | null;
}

/** The card view's projection field carries ONLY {stage, status} — the full
 * managed lifecycle (flags, project, session, order, the execution marker)
 * lives on the board.json row the server itself maintains via its
 * board_projection writes; the client adopts that authoritative row, never
 * fabricates it. */
export interface ExecProjection {
  stage: string;
  status: string | null;
}

export interface ExecCardView {
  cardId: string;
  managed: true;
  schemaVersion: number;
  enabledAt: number;
  controlRevision: number;
  internalRevision: number;
  project: { id: string; label: string; path: string };
  session: { agentName: string; sessionId: string } | null;
  currentRunId: string | null;
  workspaceId: string | null;
  composition: ExecComposition | null;
  pendingWrites: unknown;
  documents: Partial<Record<ExecDocKind, ExecDocState>>;
  approvals: ExecApprovals;
  runs: ExecRunSummary[];
  workspaces: Record<string, ExecWorkspaceView>;
  commandsProcessed: number;
  projection: ExecProjection | null;
  /** Server-side feature gates — the UI keys gated surfaces off this;
   * the commands themselves stay server-gated regardless. `orchestrator`
   * and `swarm` follow the backend-ui-contract §10 rule: the modes stay
   * disabled until the server reports them available. */
  features?: {
    start?: boolean;
    validation?: boolean;
    fusion?: boolean;
    preparation?: boolean;
    orchestrator?: boolean;
    swarm?: boolean;
  };
  /** Compact preparation summary (sessions.mjs:preparationSummary) — null
   * when the card has no preparation session or the feature is off. */
  preparation?: ExecPrepSummary | null;
}

// -- idea preparation (P5) ----------------------------------------------------
// The preparation session turns a raw idea into approved requirements + plan
// through ONE durable lead discussion. These types mirror
// server/execution/preparation/session.mjs's preparationView/preparationSummary
// and the registry listing served at /api/execution/preparation/bindings.

export type PrepSessionStatus = 'active' | 'stopped' | 'completed';
export type PrepPhase = 'clarify' | 'requirements' | 'design' | 'plan' | 'ready';
export type PrepStage =
  | 'intent'
  | 'requirements'
  | 'design'
  | 'plan'
  | 'review';

export interface ExecPrepSummary {
  sessionId: string;
  status: PrepSessionStatus;
  phase: PrepPhase | null;
  ready: boolean;
  blockerCount: number;
  gates: { pending: number; confirmed: number; invalidated: number };
  openQuestions: { open: number; blocking: number };
  attempts: { running: number; awaitingAnswer: number };
  handoffs: number;
  updatedAt: number;
}

export interface PrepBindingRef {
  bindingId: string;
  stage: PrepStage | string;
  status?: string;
  assignedAt?: number;
  digest?: string | null;
  configDigest?: string | null;
  /** True when the registry's current pin no longer matches what was
   * assigned — the pinned/current choice must be explicit (AE4). */
  stale?: boolean;
  resourceDrift?: string[];
  configDrift?: boolean;
  reason?: string | null;
}

export interface PrepGate {
  gateId: string;
  type: string;
  stage?: PrepStage | string;
  subject?: unknown;
  status: 'pending' | 'confirmed' | 'invalidated';
  confirmedAt?: number | null;
  invalidatedAt?: number | null;
  invalidationReason?: string | null;
}

export interface PrepQuestion {
  questionId: string;
  text: string;
  kind?: string;
  blocking: boolean;
  status: 'open' | 'answered' | 'superseded' | string;
  /** 'dialog' questions came from a live CLI ui request and are answered
   * through the same durable record — the lead re-binds the rpc id. */
  channel?: 'prompt' | 'dialog' | string;
  dialog?: { method?: string; options?: string[] } | null;
  attemptId?: string;
  answer?: string | null;
  createdAt?: number;
  answeredAt?: number;
  supersededAt?: number;
  intentSha256?: string;
}

export interface PrepAttempt {
  attemptId: string;
  kind: string;
  status: string;
  docKind?: string | null;
  input?: string | null;
  progress?: boolean | string | null;
  progressEpoch?: number;
  createdAt: number;
  finishedAt?: number | null;
  questionIds?: string[];
  cancelled?: boolean;
}

export interface PrepDocPointer {
  versionId: string;
  sha256?: string;
  at?: number;
  via?: string;
  sourceType?: string | null;
  attemptId?: string | null;
  draft?: boolean;
  intentSha256?: string;
}

export interface PrepHandoff {
  handoffId: string;
  mode: string;
  /** False when the named downstream mode does not exist on this
   * deployment — the offer is still recorded, honestly marked. */
  implemented?: boolean;
  at: number;
  by?: string | null;
  note?: string | null;
  inputs?: unknown;
  context?: unknown;
  supersededBy?: string | null;
  supersededAt?: number | null;
  /** Derived at view time: the record is stale when the frozen inputs no
   * longer equal what approvals+intent now bind. */
  stale?: boolean;
}

export type PrepCompletenessState =
  | 'absent'
  | 'draft'
  | 'presented'
  | 'confirmed'
  | 'approved';

export interface PrepCompletenessCounters {
  open: number;
  blocking: number;
  answered: number;
  deferred: number;
}

/** Per-kind value from completenessView(): a state string for
 * requirements/design/plan, a count for assumptions/decisions, an object
 * for openQuestions. Unknown future shapes stay readable via `unknown`. */
export type PrepCompletenessValue =
  | PrepCompletenessState
  | number
  | PrepCompletenessCounters
  | unknown;

export interface PrepCompletenessItem {
  present?: boolean;
  currentVersionId?: string | null;
  approved?: boolean;
  currentSha256?: string | null;
  boundRequirementsVersionId?: string | null;
  boundRequirementsSha256?: string | null;
  draft?: boolean;
  stale?: boolean;
  [k: string]: unknown;
}

export interface ExecPrepView {
  sessionId: string;
  schemaVersion: number;
  status: PrepSessionStatus;
  phase: PrepPhase | null;
  ready: boolean;
  blockers: { code: string; detail?: string }[];
  createdAt: number;
  updatedAt: number;
  stoppedAt?: number | null;
  stopReason?: string | null;
  blocker?: string | { code: string; detail?: string; retryable?: boolean; attemptId?: string; at?: number } | null;
  noProgressEpoch?: number;
  discussion: string | null;
  projectPath?: string | null;
  intent: {
    raw: string;
    source?: 'card' | 'explicit';
    current?: { text: string; sha256?: string; at?: number; seq?: number } | null;
    proposal?: { text: string; [k: string]: unknown } | null;
    restatements: number;
  };
  bindings: Partial<Record<PrepStage | string, PrepBindingRef | null>>;
  presented: Partial<Record<string, PrepDocPointer | null>>;
  gates: PrepGate[];
  attempts: PrepAttempt[];
  checkpoint: {
    revision: number;
    updatedAt: number;
    decisions: { text?: string; seq?: number; [k: string]: unknown }[];
    assumptions: { text?: string; [k: string]: unknown }[];
    openQuestions: PrepQuestion[];
    droppedLog?: number;
    log: { event?: string; at?: number; [k: string]: unknown }[];
  };
  completeness: Record<string, PrepCompletenessValue>;
  handoffTargets: { mode: string; implemented: boolean }[];
  handoffs: PrepHandoff[];
  /** The handoff package — present only while readiness holds. */
  package: { inputs: unknown; context: unknown } | null;
}

/** One registry row as listed by GET /api/execution/preparation/bindings —
 * host paths are deliberately not exposed; digests let the UI show the
 * pinned/current relationship. */
export interface PrepBindingInfo {
  bindingId: string;
  stage: PrepStage | string;
  status: string;
  title?: string | null;
  provider?: string | null;
  adapterId?: string | null;
  adapterVersion?: string | null;
  questionChannel?: string | null;
  tools?: string[];
  digest?: string | null;
  configDigest?: string | null;
  unsupported?: { reason: string; route?: string; detail?: string } | null;
}

export interface ExecCardSummary {
  cardId: string;
  controlRevision: number;
  currentRunId: string | null;
  managed: true;
  /** The current run's public summary — lets the managed index badge a
   * card whose fusion run is waiting on a user decision without fetching
   * every card view. */
  currentRun?: {
    id: string;
    status: string | null;
    mode?: string;
    pending?: number;
  } | null;
  /** Preparation summary — the runner's lead supervisor and any managed
   * index badge read this without loading every card view. */
  preparation?: ExecPrepSummary | null;
}

export type ExecRunStatus =
  | 'queued'
  | 'active'
  | 'stopping'
  | 'awaiting_acceptance'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'cancelled'
  | string;

export type ExecRunPhase =
  | 'prepare'
  | 'implement'
  | 'verify'
  | 'review'
  | 'check_review'
  | 'fix'
  | 'awaiting_validation'
  | 'awaiting_acceptance'
  | 'panel'
  | 'judge'
  | 'integrate'
  | string;

export interface ExecAttempt {
  id: string;
  runId: string;
  /** Core roles plus fusion roles ('panelist' | 'judge' | 'integrator'). */
  role: ExecRole | 'panelist' | 'judge' | 'integrator' | (string & {});
  phase: string;
  /** Orchestrator task linkage; worker/fix/verifier attempts remain in run.attempts. */
  taskId?: string;
  kind?: 'work' | 'fix' | 'verify';
  validationId?: string;
  round?: number;
  n: number;
  /** launching|running|cancelling are live; completed|failed|cancelled|
   * interrupted|blocked are terminal. */
  status: string;
  owner?: { runnerId?: string; instanceId?: string | null } | null;
  launch?: { cwd?: string; profileId?: string; [k: string]: unknown };
  porchRunId?: string | null;
  workspaceId?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  outcome?: unknown;
  /** Bounded result descriptor (validateAttemptResult): status, exitCode,
   * finalArtifactId, durationS, summary — the full agent output lives in
   * the finalArtifact file, never inline. */
  result?: ExecAttemptResult | null;
  error?: string | null;
  cancel?: { requestedAt: number; by: string; reason: string | null };
}

export interface ExecAttemptResult {
  status?: string;
  exitCode?: number | null;
  finalArtifactId?: string | null;
  durationS?: number | null;
  summary?: string | null;
  [k: string]: unknown;
}

/** A recorded check outcome — `index` names the approved check at
 * run.inputs.plan.checks[index]; stdout/stderr evidence lands in the
 * imported log artifacts bound by sha256. */
export interface ExecCheckReport {
  index: number;
  status: string;
  exitCode?: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  stdoutBytes?: number | null;
  stderrBytes?: number | null;
  logOutArtifactId?: string | null;
  logErrArtifactId?: string | null;
  logSha256Out?: string | null;
  logSha256Err?: string | null;
  at?: number;
  [k: string]: unknown;
}

// ---- verified review evidence (server/execution/review-contract.mjs) ---------

export interface ExecFinding {
  id: string;
  round: number;
  /** critical | major | minor | nit (or a snapshotted vocabulary). */
  severity: string;
  text: string;
  where?: string;
  status: 'open' | 'closed';
  closedInRound?: number;
  truncated?: boolean;
}

export interface ExecFindingsDoc {
  version: 1;
  round: number;
  resultSha256?: string;
  findings: ExecFinding[];
}

export interface ExecVerdict {
  findingId: string;
  round: number;
  /** confirmed | rejected | disputed — latest-per-finding wins. */
  verdict: string;
  reason?: string;
  truncated?: boolean;
}

export interface ExecVerdictsDoc {
  version: 1;
  round?: number;
  resultSha256?: string;
  verdicts: ExecVerdict[];
}

/** A verified report record — the parsed doc is bound to {round,
 * attemptId, artifact sha256} by record_report; immutable once stored. */
export interface ExecReport {
  doc: ExecFindingsDoc | ExecVerdictsDoc;
  attemptId: string;
  artifactId: string;
  artifactSha256?: string;
  at: number;
}

export interface ExecValidation {
  id: string;
  status: string;
  phase: string | null;
  round: number;
  resultSha256?: string | null;
  checks?: {
    status?: string;
    verdict?: string | null;
    reports?: ExecCheckReport[];
  };
  reports?: {
    findings?: ExecReport | null;
    verdicts?: ExecReport | null;
  };
  procs?: Record<string, { state?: string; [k: string]: unknown }>;
  dirs?: { review?: string; check?: string; [k: string]: unknown };
  cancel?: { requestedAt: number; by: string; reason: string | null };
  endedAt?: number | null;
  [k: string]: unknown;
}

export interface ExecRound {
  round: number;
  resultSha256: string;
  checksVerdict: string | null;
  decision: string;
  reason: string | null;
  blocking: string[];
  nonBlocking: string[];
  unvetted: string[];
  findingsArtifactId: string | null;
  verdictsArtifactId: string | null;
  findingsAttemptId: string | null;
  verdictsAttemptId: string | null;
  at: number;
}

export interface ExecArtifact {
  kind?: string | null;
  file?: string | null;
  stored?: string | null;
  sha256?: string | null;
  bytes?: number;
  attemptId?: string;
  [k: string]: unknown;
}

// ---- orchestrator run state (backend-ui-contract §§4–5) ----------------------
// The durable `run.orchestrator` slice: decomposition spec version,
// subtask records with attempts/evidence/waiting, the integrate import,
// the authoritative user-unblock list (pendingActions), stats and the
// supervisor claim (owner — read-only for the UI). User commands:
// orch_approve | orch_answer | orch_grant | orch_retry (stop/continue shared).

export type OrchTaskStatus =
  | 'pending' | 'ready' | 'running' | 'verifying' | 'returned'
  | 'accepted' | 'failed' | 'blocked' | 'waiting' | 'cancelled';

export interface OrchAttempt {
  id: string;
  n: number;
  kind: 'work' | 'fix' | 'verify' | string;
  status: string;
  resultCommit?: string | null;
  error?: string | null;
  [k: string]: unknown;
}

export interface OrchTask {
  taskId: string;
  title: string;
  status: OrchTaskStatus | string;
  deps?: string[];
  profile?: string | null;
  boundary?: string[];
  inputCommit?: string | null;
  snapshotOf?: string[];
  attempts?: OrchAttempt[];
  resultCommit?: string | null;
  resultSha256?: string | null;
  evidence?: {
    verifyArtifactId?: string | null;
    verdict?: string | null;
    findingsArtifactId?: string | null;
  } | null;
  waiting?: { reason?: string | null; question?: string | null; since?: number | null } | null;
  budget?: { used?: number; limit?: number } | null;
  [k: string]: unknown;
}

/** Durable task row returned by the backend; attempts are references to run.attempts. */
export interface OrchTaskRecord {
  id: string;
  title: string;
  dependsOn: string[];
  boundary?: string[];
  worker: { profileId: string };
  limits: { maxAttempts: number; maxFixCycles: number };
  state: {
    status: string;
    attemptsUsed: number;
    fixesUsed: number;
    extraAttempts?: number;
    extraFixes?: number;
    attempts: string[];
    inputCommit?: string | null;
    snapshotOf?: string[];
    resultCommit?: string | null;
    resultSha256?: string | null;
    evidence?: { verdictArtifactId?: string | null; verdict?: string | null; findings?: unknown[] } | null;
    waiting?: OrchTask['waiting'];
  };
}

export type OrchPendingAction =
  | { type: 'spec_approval'; specSha256: string }
  | { type: 'question'; taskId: string; question?: string | null }
  | { type: 'grant'; taskId: string; reason?: string | null }
  | { type: 'decision'; proposalId: string; kind: 'decompose' | 'amend'; fields: string[] };

export interface OrchestratorState {
  spec?: {
    version?: number;
    sha256?: string | null;
    status?: 'pending' | 'approved' | 'superseded' | 'rejected' | string;
    approvedAt?: number | null;
    by?: string | null;
    artifactId?: string | null;
  } | null;
  phase?: 'decompose' | 'approval' | 'work' | 'integrate' | 'validate' | 'done' | 'stopped' | 'failed' | string;
  graph?: { status: string; revision?: number; pendingApproval?: { proposalId: string; kind?: string; fields?: string[] } | null };
  tasks?: OrchTaskRecord[];
  integrate?: {
    canonicalId?: string | null;
    attemptId?: string | null;
    import?: { commitSha?: string | null; treeSha?: string | null; changed?: boolean | null; diffStat?: string | null } | null;
  } | null;
  pendingActions?: OrchPendingAction[];
  stats?: { tasks?: number; accepted?: number; running?: number; failed?: number } | null;
  owner?: { runnerId?: string | null; instanceId?: string | null } | null;
  [k: string]: unknown;
}

// ---- swarm run state (backend-ui-contract §§6–7) ---------------------------
// The durable `run.swarm` slice: participants with turn budget/attempt/
// waiting, contested path ownership, broker-escalated decisions, the
// message bus, freeze state, findings and the authoritative user-unblock
// list (pendingActions). User commands: swarm_input | swarm_extend |
// swarm_decide (stop/continue shared). New edits while frozen are
// broker-rejected — the UI disables apply expectations and shows why.

export interface SwarmParticipant {
  participantId: string;
  callsign?: string | null;
  profileId?: string | null;
  status?: 'active' | 'waiting' | 'exhausted' | 'stopped' | 'done' | string;
  ownedPaths?: string[];
  attempt?: { id?: string | null; status?: string | null; porchRunId?: string | null } | null;
  budget?: { turnsUsed?: number; turnsLimit?: number } | null;
  waiting?: { reason?: string | null; detail?: string | null } | null;
  cursor?: { lastSeenSeq?: number | null } | null;
  [k: string]: unknown;
}

export interface SwarmDecision {
  id: string;
  kind?: 'apply' | 'interface' | 'contested' | string;
  proposer?: string | null;
  paths?: string[];
  status?: 'pending' | 'approved' | 'rejected' | 'superseded' | string;
  at?: number | null;
  rationale?: string | null;
  artifactId?: string | null;
  [k: string]: unknown;
}

export interface SwarmMessage {
  id: string;
  seq?: number | null;
  from?: string | null;
  to?: string | null;
  kind?: 'question' | 'answer' | 'proposal' | 'notice' | string;
  text?: string | null;
  at?: number | null;
  [k: string]: unknown;
}

export interface SwarmFinding {
  id: string;
  owner?: string | null;
  text?: string | null;
  severity?: string | null;
  status?: 'open' | 'fixed' | 'wontfix' | string;
  [k: string]: unknown;
}

export type SwarmPendingAction =
  | { type: 'decision'; decisionId: string }
  | { type: 'question'; participantId: string; question?: string | null }
  | { type: 'extend'; participantId?: string | null; reason?: string | null };

export interface SwarmState {
  phase?: 'prepare' | 'implement' | 'verify' | 'review' | 'awaiting_acceptance' | 'done' | 'stopped' | 'failed' | string;
  round?: number | null;
  participants?: SwarmParticipant[];
  ownership?: { path?: string | null; owner?: string | null; since?: number | null; contested?: boolean }[];
  decisions?: SwarmDecision[];
  messages?: SwarmMessage[];
  freeze?: { active?: boolean; reason?: string | null; since?: number | null } | null;
  findings?: SwarmFinding[];
  limits?: {
    turnsUsed?: number; turnsLimit?: number;
    round?: number; maxRounds?: number;
    messagesUsed?: number; maxMessages?: number;
  } | null;
  pendingActions?: SwarmPendingAction[];
  owner?: { runnerId?: string | null; instanceId?: string | null } | null;
  [k: string]: unknown;
}

// ---- fusion panel (F2/F3 durable state — server/execution/fusion/domain.mjs)
// ---------------------------------------------------------------------------

export type FusionResultKind = 'document' | 'implementation';

export type FusionParticipantStatus =
  | 'pending'
  | 'launching'
  | 'running'
  | 'answered'
  | 'awaiting_decision'
  | 'excluded';

/** Coarse durable panel state (syncPanelDerived / panel_settle). */
export type FusionStatus =
  | 'open'
  | 'decision_pending'
  | 'complete'
  | 'quorum_failed'
  | 'cancelled';

export interface FusionParticipantAnswer {
  attemptId: string;
  artifactId: string;
  sha256: string;
  bytes: number;
  sections?: Record<string, string>;
  model?: string;
  profileDigest?: string;
  at?: number;
  reusedFrom?: { runId: string; attemptId: string | null };
}

export interface FusionParticipant {
  id: string;
  label: string;
  profileId: string;
  provider: string;
  model: string;
  profileDigest: string;
  status: FusionParticipantStatus;
  attemptsUsed: number;
  extraAttempts?: number;
  answer?: FusionParticipantAnswer | null;
  exclusion?: { at: number; by: string; reason: string | null; attemptsUsed: number } | null;
  lastError?: { outcome: string; reason: string | null; attemptId: string; at: number } | null;
  [k: string]: unknown;
}

export interface FusionExclusion {
  participantId: string;
  model: string;
  profileDigest?: string;
  attemptsUsed?: number;
  reason: string | null;
  by: string;
  at: number;
  carriedFrom?: string;
}

/** A durable "the run is waiting on the user" marker. participant_decision
 * entries are synced from participants at 'awaiting_decision';
 * work_order_approval entries are written by the F3 routing and name the
 * CURRENT work-order version (a stale versionId is refused). */
export type FusionPendingAction =
  | { type: 'participant_decision'; participantId: string }
  | { type: 'work_order_approval'; versionId: string; reason?: string };

export interface FusionWorkOrder {
  versionId: string;
  artifactId: string;
  sha256: string;
  bytes?: number;
  verdict?: string | null;
  sections?: Record<string, string>;
  steps?: string[];
  affectedParts?: string[];
  criteria?: string[];
  inputs?: {
    taskSha256?: string | null;
    answersSha256?: string | null;
    rubricSha256?: string | null;
    snapshotSha?: string | null;
    resultKind?: string;
  };
  attemptId?: string;
  at?: number;
  /** Set by approve_work_order — {at, by:'user'}. */
  approved?: { at: number; by: string } | null;
  /** The recorded routing decision: 'auto' (in_plan + unchanged inputs)
   * or 'user' (acceptance/scope_change/uncertain/inputs_changed/
   * behavior_change). */
  decision?: { routed: 'auto' | 'user'; reason: string; at: number } | null;
}

export interface FusionRoleSpec {
  profileId: string;
  provider: string;
  model: string;
  profileDigest: string;
  profile?: Record<string, unknown>;
}

export interface FusionState {
  resultKind: FusionResultKind;
  fingerprint?: string;
  snapshot?: {
    task?: { kind: string; versionId: string; sha256: string } | null;
    project?: { projectRoot?: string; snapshotSha?: string };
    search?: { enabled?: boolean };
  };
  limits?: {
    maxAttemptsPerParticipant?: number;
    timeoutMin?: number;
    judgeAttempts?: number;
    integratorAttempts?: number;
    reviewAttemptsPerRole?: number;
  };
  participants: FusionParticipant[];
  exclusions: FusionExclusion[];
  pendingActions: FusionPendingAction[];
  status: FusionStatus | string;
  judgeEligible?: boolean | null;
  settledAt?: number | null;
  judge?: FusionRoleSpec | null;
  integrator?: FusionRoleSpec | null;
  review?: { reviewer: ExecPresetMember; checker: ExecPresetMember } | null;
  workOrders?: FusionWorkOrder[];
  /** The ACCEPTED work order — {versionId, sha256, approvedAt, by, reason}. */
  workOrder?: {
    versionId: string;
    sha256: string;
    approvedAt: number;
    by: string;
    reason?: string;
  } | null;
  integrate?: {
    workOrderVersionId: string;
    workOrderSha256: string;
    canonicalId?: string | null;
    import?: {
      attemptId: string;
      fix?: number | null;
      canonicalId?: string | null;
      treeSha: string | null;
      commitSha: string;
      changed: boolean;
      diffStat?: string | null;
      at: number;
    } | null;
    auto?: boolean;
    at?: number;
  } | null;
  integratorReport?: {
    artifactId: string;
    sha256: string;
    bytes?: number;
    attemptId?: string;
    behaviorChange?: boolean;
    mismatches?: string[] | null;
    at?: number;
  } | null;
  fixAttempts?: unknown[];
  continuedFrom?: string | null;
  inputReused?: boolean;
  [k: string]: unknown;
}

export interface ExecRun {
  id: string;
  cardId: string;
  mode: 'solo' | 'fusion' | string;
  status: ExecRunStatus;
  phase: ExecRunPhase | null;
  createdAt: number;
  finishedAt?: number | null;
  acceptedAt?: number | null;
  error?: string | null;
  /** Solo runs always carry requirements+plan; a fusion run's inputs depend
   * on resultKind — 'document' pins only `task`, 'implementation' binds
   * the approved pair like solo. `task` is the pinned document version
   * every panelist saw. */
  inputs: {
    requirements?: { versionId: string; sha256: string } | null;
    plan?: {
      versionId: string;
      sha256: string;
      requirementsVersionId?: string;
      checks?: ExecCheck[];
      checksSource?: string;
    } | null;
    design?: { versionId: string; sha256: string } | null;
    task?: { kind: string; versionId: string; sha256: string } | null;
  };
  fusion?: FusionState | null;
  /** Orchestrator run detail (backend-ui-contract §4) — null unless
   * mode==='orchestrator'. Rendered by the run-graph section; the
   * pendingActions list is the ONLY user-unblock surface. */
  orchestrator?: OrchestratorState | null;
  /** Swarm run detail (backend-ui-contract §6) — null unless
   * mode==='swarm'. Claims/messages/decisions/limits render verbatim. */
  swarm?: SwarmState | null;
  composition: ExecComposition | null;
  reviewRules?: unknown;
  baseRef: string;
  baseCommit: string | null;
  workspaceId: string | null;
  attempts: ExecAttempt[];
  /** The last recorded attempt result — {...ExecAttemptResult, attemptId,
   * role, at}. Reviewer/checker resolves overwrite it; the canonical
   * implementer result for a fix round lives on fixContext.priorResult. */
  /** For solo runs this is the accepted attempt's result; for a fusion
   * implementation run it is the integrator's; for a fusion document run
   * it is `{kind:'document', workOrder}` — read `run.fusion` for the
   * authoritative shape. */
  result: (ExecAttemptResult & { attemptId: string; role: ExecRole | (string & {}); at: number }) | null;
  acceptance: { resultSha256: string; round: number; at: number } | null;
  validation?: ExecValidation | null;
  rounds?: ExecRound[];
  /** A 'fix' decision's carry-forward evidence: the verified findings/
   * verdicts docs, open finding texts, check diagnostics and artifact
   * provenance of the prior round. */
  fixContext?: {
    round: number;
    validationId: string;
    resultSha256: string;
    checksVerdict: string | null;
    priorResult: (ExecAttemptResult & { attemptId: string; role: ExecRole; at: number | null }) | null;
    openFindings: { id: string; severity?: string; text?: string; where?: string }[];
    findingsDoc: ExecFindingsDoc | null;
    verdictsDoc: ExecVerdictsDoc | null;
    findingsArtifactId?: string | null;
    verdictsArtifactId?: string | null;
    findingsArtifactSha256?: string | null;
    verdictsArtifactSha256?: string | null;
    findingsAttemptId?: string | null;
    verdictsAttemptId?: string | null;
    checkReports: ExecCheckReport[];
    priorAttempts: { id: string; role: ExecRole; n: number | null; outcome: unknown; error: string | null }[];
    reason: string | null;
    at: number;
  } | null;
  diagnostic?: { type?: string | null; code?: string | null; at?: number | null; detail?: string | null } | null;
  continuation?: {
    fromRunId: string;
    fromStatus: string;
    fromFinishedAt: number | null;
    fromError: string | null;
    fromResult: unknown;
    priorAttempts: unknown[];
    priorArtifacts: unknown[];
    openFindings: unknown[];
    userNote: string | null;
  };
  stopIntent?: { at: number; by: string; reason: string | null };
  priorTerminal?: string;
  artifacts?: Record<string, ExecArtifact>;
  eventsCursor?: number;
  [k: string]: unknown;
}

export interface ExecRunEvent {
  seq: number;
  type: string;
  at?: number;
  ts?: number;
  attemptId?: string;
  data?: unknown;
  [k: string]: unknown;
}

export interface ExecEventsPage {
  runId: string;
  events: ExecRunEvent[];
  nextCursor: number;
  limit: number;
  remaining: number;
  total: number;
  corrupt: number;
}

export interface ExecArtifactContent {
  artifactId: string;
  runId: string;
  kind: string | null;
  bytes: number;
  sha256: string | null;
  contentBase64: string;
  content: string;
}

// -- commands ----------------------------------------------------------------

export const USER_COMMAND_TYPES = [
  'enable',
  'attach_document',
  'approve_requirements',
  'approve_plan',
  'save_preset',
  'change_requirements',
  'start',
  'stop',
  'continue',
  'accept_result',
  'retry_participant',
  'exclude_panelist',
  'approve_work_order',
  // Orchestrator user commands (backend-ui-contract §5) — gated on
  // features.orchestrator server-side; the UI mirrors the flag.
  'orch_approve',
  'orch_decide',
  'orch_answer',
  'orch_grant',
  'orch_retry',
  // Swarm user commands (backend-ui-contract §7) — gated on
  // features.swarm server-side; the UI mirrors the flag.
  'swarm_input',
  'swarm_extend',
  'swarm_decide',
  // P5: idea-preparation commands — minted on the managed card, dispatched
  // through the SAME revision-checked envelope as every lifecycle command.
  'start_preparation',
  'answer_question',
  'request_draft',
  'continue_discussion',
  'stop_preparation',
  'change_skill_binding',
  'confirm_gate',
  'handoff_preparation',
] as const;
export type ExecCommandType = (typeof USER_COMMAND_TYPES)[number];

export interface ExecCommandEnvelope {
  commandId: string;
  type: ExecCommandType;
  payload: Record<string, unknown>;
  /** Required for every managed-card mutation; `enable` on an unmanaged
   * card takes 0 or omits it. */
  expectedControlRevision?: number;
}

export interface ExecCommandSuccess {
  ok: true;
  cardId: string;
  controlRevision: number;
  result: unknown;
  /** present when the commandId replayed a recorded outcome. */
  idempotent?: boolean;
}

// ---------------------------------------------------------------------------
// Errors — the server body is {error, code, ...details} (errorBody()).
// ---------------------------------------------------------------------------

export class ExecApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, body: unknown, fallback: string) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    super(typeof b.error === 'string' ? b.error : fallback);
    this.name = 'ExecApiError';
    this.status = status;
    this.code = typeof b.code === 'string' ? b.code : 'unknown';
    const { error: _e, code: _c, ...rest } = b;
    this.details = rest;
  }

  /** Card-command stale controlRevision — refresh and resubmit deliberately. */
  get isRevisionConflict(): boolean {
    return this.status === 409 && this.code === 'revision_conflict';
  }

  /** Preset-registry stale rev (PUT /presets/:id uses code `rev_conflict`;
   * the legacy KV PUT uses `rev_conflict` too — distinct from the command
   * channel's `revision_conflict`). Reload the registry before retrying. */
  get isRevConflict(): boolean {
    return this.status === 409 && this.code === 'rev_conflict';
  }

  /** The commandId was already consumed with a different payload. */
  get isCommandConflict(): boolean {
    return this.status === 409 && this.code === 'command_conflict';
  }

  /** The card has no managed aggregate (enable required / wrong card). */
  get isCardNotFound(): boolean {
    return this.status === 404 && this.code === 'card_not_found';
  }

  /** A live run/attempt/validation reservation refuses the action. */
  get isReservationConflict(): boolean {
    return (
      this.status === 409 &&
      (this.code === 'run_active' ||
        this.code === 'attempt_active' ||
        this.code === 'reservation_live' ||
        this.code === 'validation_active')
    );
  }
}

/** true for errors produced by transport failure (no HTTP status). */
export function isOfflineError(e: unknown): boolean {
  return e instanceof ExecApiError && e.status === 0;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ExecClientOptions {
  /** Overrides the whole base (tests / VITE_STATE_URL-style overrides). */
  baseUrl?: string;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 8000;
/** Health probes fail fast — a wedged health read must not pin `online`. */
const HEALTH_TIMEOUT_MS = 3000;

/** Base URL of the state server that hosts the execution API — the same
 * convention as src/lib/host/storage.ts's stateServerBase(). */
export function execBase(): string {
  const env = import.meta.env?.VITE_STATE_URL as string | undefined;
  if (env) return env.replace(/\/+$/, '');
  const hostname =
    (typeof location !== 'undefined' && location.hostname) || '127.0.0.1';
  return toSecureUrl(`http://${hostname}:25900`);
}

export class ExecClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ExecClientOptions = {}) {
    this.base = (opts.baseUrl ?? execBase()).replace(/\/+$/, '');
    // window.fetch detached onto the instance calls with this===ExecClient —
    // Chromium throws "Illegal invocation". The arrow keeps the global
    // receiver; an injected fetchFn (tests) passes through untouched.
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    // The timeout bounds the WHOLE request — headers AND body — so a stalled
    // or half-delivered response can never wedge the caller's polling.
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof Error && e.name === 'AbortError';
      const err = new ExecApiError(
        0,
        null,
        aborted
          ? `state server did not answer within ${this.timeoutMs}ms`
          : `state server unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
      err.details.cause = aborted ? 'timeout' : 'network';
      throw err;
    }
    let parsed: unknown;
    try {
      // Error bodies parse best-effort (a non-JSON 500 page still yields a
      // classified ExecApiError). A SUCCESS body must actually parse — an
      // aborted or malformed 200 is a transport failure, never a typed
      // result the caller could adopt as authoritative state.
      parsed = res.ok ? await res.json() : await res.json().catch(() => null);
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof Error && e.name === 'AbortError';
      const err = aborted
        ? new ExecApiError(0, null, `state server did not finish responding within ${this.timeoutMs}ms`)
        : new ExecApiError(
            res.status,
            null,
            `state server returned an unreadable response body: ${e instanceof Error ? e.message : String(e)}`,
          );
      err.details.cause = aborted ? 'timeout' : 'bad_body';
      throw err;
    }
    clearTimeout(timer);
    if (!res.ok) {
      throw new ExecApiError(res.status, parsed, `HTTP ${res.status}`);
    }
    return parsed as T;
  }

  // -- reads -------------------------------------------------------------------

  async probe(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${this.base}/health`, { signal: ctrl.signal });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      return body?.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  listCards(): Promise<{ cards: ExecCardSummary[] }> {
    return this.req('GET', '/api/execution/cards');
  }

  getCard(cardId: string): Promise<ExecCardView> {
    return this.req('GET', `/api/execution/cards/${encodeURIComponent(cardId)}`);
  }

  getDocument(cardId: string, versionId: string): Promise<ExecDocVersionContent> {
    return this.req(
      'GET',
      `/api/execution/cards/${encodeURIComponent(cardId)}/documents/${encodeURIComponent(versionId)}`,
    );
  }

  getRun(runId: string): Promise<ExecRun> {
    return this.req('GET', `/api/execution/runs/${encodeURIComponent(runId)}`);
  }

  getRunEvents(runId: string, cursor = 0, limit = 200): Promise<ExecEventsPage> {
    return this.req(
      'GET',
      `/api/execution/runs/${encodeURIComponent(runId)}/events?cursor=${cursor}&limit=${limit}`,
    );
  }

  getArtifact(runId: string, artifactId: string): Promise<ExecArtifactContent> {
    return this.req(
      'GET',
      `/api/execution/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  }

  // -- idea preparation ---------------------------------------------------------
  //
  // getPreparation is the FULL session view (checkpoint, gates, attempts,
  // presented pointers, handoff package). A card without a session 404s —
  // callers map that to null; a feature-off server 501s.

  getPreparation(cardId: string): Promise<{ preparation: ExecPrepView | null }> {
    return this.req(
      'GET',
      `/api/execution/cards/${encodeURIComponent(cardId)}/preparation`,
    );
  }

  /** The bindable skill routes for the pickers — includes unsupported rows
   * with their recorded refusal reason so the UI can show WHY a route is
   * closed rather than hiding it. */
  getPreparationBindings(): Promise<{
    pi: { binary: string; version: string } | null;
    bindings: PrepBindingInfo[];
  }> {
    return this.req('GET', '/api/execution/preparation/bindings');
  }

  // -- presets -------------------------------------------------------------------

  listPresets(): Promise<{
    presets: ExecPreset[];
    rev: number;
    compatibility: ExecCompatibility | null;
    compatError: string | null;
  }> {
    return this.req('GET', '/api/execution/presets');
  }

  createPreset(preset: ExecPresetInput): Promise<{ ok: true; preset: ExecPreset; rev: number }> {
    return this.req('POST', '/api/execution/presets', { preset });
  }

  updatePreset(
    presetId: string,
    preset: ExecPresetInput,
    rev: number | null,
  ): Promise<{ ok: true; preset: ExecPreset; rev: number }> {
    return this.req('PUT', `/api/execution/presets/${encodeURIComponent(presetId)}`, {
      preset,
      rev,
    });
  }

  deletePreset(presetId: string): Promise<{ ok: true; deleted: string; rev: number }> {
    return this.req('DELETE', `/api/execution/presets/${encodeURIComponent(presetId)}`);
  }

  // -- commands -------------------------------------------------------------------

  /** One deliberate user action = one call = one commandId. The store layer
   * is responsible for a fresh expectedControlRevision; this client sends
   * the envelope verbatim and never retries or queues. */
  sendCommand(cardId: string, envelope: ExecCommandEnvelope): Promise<ExecCommandSuccess> {
    return this.req('POST', `/api/execution/cards/${encodeURIComponent(cardId)}/commands`, envelope);
  }
}

let shared: ExecClient | null = null;

/** The default client bound to this host's state server. */
export function execClient(): ExecClient {
  if (!shared) shared = new ExecClient();
  return shared;
}
