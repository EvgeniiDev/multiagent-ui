// server/execution/execution-domain.mjs — domain logic for managed cards (U2).
//
// Pure-ish: every function receives a `ctx` with storage deps and never does
// IO directly, so the state service controls all reads/writes inside its
// serialized queue. The module decides; the service persists.
//
// Contract (docs/plans/agent-core-implementation-plan.md):
//   - commands carry commandId + expectedControlRevision; dedup by
//     (commandId, payloadHash) runs BEFORE the revision check — a replay with
//     the same payload returns the stored result, a different payload is a
//     conflict. Command outcomes are kept in the aggregate WITHOUT an
//     eviction horizon: replaying a commandId must return its original
//     outcome no matter how many commands followed.
//   - controlRevision moves only on user commands that mutate the aggregate;
//     internal-channel commands (heartbeat) move internalRevision instead.
//   - approvals bind (versionId, sha256) explicitly supplied by the caller —
//     there is no implicit "approve whatever is current". The presented hash
//     must equal the stored version's hash and the blob must verify.
//   - a plan version records which requirements version it was prepared for;
//     approve_plan refuses a plan bound to a requirements version that is not
//     the currently approved one.
//   - plan checks are a STRUCTURED set of commands confirmed in the attach/
//     approve payload ({run, cwd, timeoutSec, setup}), never executed here;
//     a ```acp-checks fenced JSON block in the document is accepted as an
//     import convenience but is never the only valid source.
//   - attaching a new requirements/plan version revokes the corresponding
//     approval (requirements also revokes the plan approval bound to it).
//   - legacy board/claims writes merge around managed fields instead of
//     overwriting them, and reject deletion/claim mutation outright.
//   - start/stop/continue/accept_result exist in the contract but report
//     command_unavailable until U3–U5 land.

import { promises as fs } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AGGREGATE_VERSION,
  ARTIFACT_NAME_RE,
  DOC_KINDS,
  SHA256_RE,
  listManagedCardIds,
  loadAggregate,
  sha256,
} from './execution-store.mjs';
import {
  SAFE_ID_RE, RUN_ID_RE, RuntimeError, normPath,
} from './common.mjs';
import {
  resolveBaseCommit,
  sourceGitRoot,
  workspaceBranch,
  workspacePath,
  projectKeyFor,
  WS_ID_RE,
} from './workspaces.mjs';
import {
  canonicalManifest, assertValidationDirs, validationDirs,
  computeResultManifest, RESULT_HASH_RE, VALIDATION_ID_RE,
} from './result-snapshot.mjs';
import {
  parseFindingsDoc, parseVerdictDoc, evaluateReviewGate,
  snapshotReviewRules, ReviewDocError, REVIEW_REASON_PREFIX,
} from './review-contract.mjs';
import {
  buildFusionRun, buildFusionContinuation, onPanelistResolved,
  checkPanelAnswer, cmdPanelClaim, cmdPanelBegin, cmdPanelSettle,
  cmdRetryParticipant, cmdExcludePanelist,
  checkJudgeWorkOrder, onJudgeResolved,
  checkIntegratorReport, onIntegratorResolved,
  cmdJudgeBegin, cmdIntegrateBegin, cmdRecordIntegrateResult,
  cmdAnnulAcceptance, cmdApproveWorkOrder,
} from './fusion/domain.mjs';
import {
  PREP_COMMANDS, PREP_INTERNAL_COMMANDS, PREP_HANDLERS, PREP_INTERNAL_HANDLERS,
  prepAfterAttach, prepAfterRequirementsChanged, prepAssertStartReady,
  preparationSummary,
} from './preparation/session.mjs';

export const MAX_DOC_BYTES = 512 * 1024;
export const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const COMMANDS = new Set([
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
  // F2 fusion panel: participant-decision commands (retried/excluded after
  // an exhausted participant). Gated on features.fusion.
  'retry_participant',
  'exclude_panelist',
  // F3: the user's work-order approval — the document result lands, or the
  // implementation work order routes to the integrator.
  'approve_work_order',
  // P1 idea preparation: session lifecycle + SkillGate confirmation. All
  // gated on features.preparation (ACP_EXEC_PREPARATION).
  ...PREP_COMMANDS,
]);
// Landed in U3–U5; the contract keeps them addressable so clients get an
// explicit diagnostic instead of silence. `stop` is implemented in U4 and is
// NEVER gated (a stop must always be reachable); `start`/`continue` stay
// behind the start gate (default off until the U5 readiness gate).
export const UNSUPPORTED_COMMANDS = new Set([
  'start',
  'continue',
  'accept_result',
]);
const LAUNCH_GATED = new Set(['start', 'continue']);
// U5 acceptance is gated on its own flag: it requires the validation
// pipeline (result snapshots, checks, reviewer/checker evidence) to exist,
// so `accept_result` answers only when features.validation is on.
const VALIDATION_GATED = new Set(['accept_result']);
const VALIDATION_INTERNAL = new Set([
  'begin_validation', 'record_snapshot', 'validation_progress',
  'end_validation', 'record_report',
]);
// F2 fusion: participant-decision user commands ride the fusion gate; the
// internal panel_* surface has its own internal-channel gate — a scheduler
// without the flag can never mint a panelist attempt.
const FUSION_GATED = new Set(['retry_participant', 'exclude_panelist', 'approve_work_order']);
const FUSION_INTERNAL = new Set([
  'panel_claim', 'panel_begin', 'panel_settle',
  'judge_begin', 'integrate_begin', 'record_integrate_result', 'annul_acceptance',
]);
// P1 idea preparation: user commands ride the preparation gate; the
// internal prep_result seam has its own internal-channel gate — a lead
// driver without the flag can never deliver attempt outcomes.
const PREPARATION_GATED = new Set([...PREP_COMMANDS]);
const PREPARATION_INTERNAL = new Set([...PREP_INTERNAL_COMMANDS]);
// Internal-channel commands: runner bookkeeping only, reachable exclusively
// through the authenticated internal transport (/api/internal/*) or the
// in-process service seam — never through the user channel.
export const INTERNAL_COMMANDS = new Set([
  'heartbeat',
  'begin_workspace',
  'adopt_workspace',
  'workspace_ready',
  'workspace_failed',
  'begin_attempt',
  'bind_attempt',
  'adopt_attempt',
  'resolve_attempt',
  'cancel_attempt',
  'observe_attempt',
  'commit_artifact',
  'complete_run',
  'record_event',
  'begin_validation',
  'record_snapshot',
  'validation_progress',
  'end_validation',
  'record_report',
  'command_receipt',
  // F2 fusion panel: panel-level execution authority (claim), the only
  // panelist-attempt minter (panel_begin), and the panel terminalizer
  // (panel_settle).
  'panel_claim',
  'panel_begin',
  'panel_settle',
  // F3: judge + integrator attempt minting, the canonical-import result
  // record, and the post-gate drift annul.
  'judge_begin',
  'integrate_begin',
  'record_integrate_result',
  'annul_acceptance',
  // P1 idea preparation: the lead runtime's durable result delivery seam.
  ...PREP_INTERNAL_COMMANDS,
]);
// Environment-scoped internal operations (not card commands): routed over
// /api/internal/environments/* and the internalGlobal seam.
const GLOBAL_COMMANDS = new Set(['register_environment', 'retire_environment']);
const ENV_SLOTS_OPS_TOKEN = 'x-acp-ops-token';

// run.diagnostic persists only actionable/notable durable states — pure
// progress events never overwrite it.
const DIAG_EVENT_TYPES = new Set([
  'launch_blocked',
  'workspace_dirty',
  'cancel_pending',
  'stuck_detected',
  'outage',
  'verify_pending',
  'terminal_unproven',
  'supervisor_identity_drift',
  'artifact_write_failed',
  'artifact_unreadable',
  'artifact_corrupt',
  'supervisor_vanished',
  'vanished_unproven',
  'run_finalize_failed',
  'role_timeout',
  'launch_threw',
  'panel_launch_blocked',
]);

// Run lifecycle. queued|active|stopping|awaiting_acceptance are live;
// everything else is terminal.
export const RUN_NONTERMINAL = new Set(['queued', 'active', 'stopping', 'awaiting_acceptance']);
// 'cancelling' is a LIVE state: workspace+slot stay reserved until a
// positive terminal observation — a cancel request is never itself proof of
// process death.
export const ATTEMPT_NONTERMINAL = new Set(['launching', 'running', 'cancelling']);
export const ATTEMPT_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'blocked']);
// 'awaiting_acceptance' is NOT U4-reachable: only the U5 verification gate
// (checks + reviewer/checker roles) may park a run there. A terminal
// implementer in U4 moves run.phase to 'awaiting_validation' while the run
// stays 'active' — an agent exit, even exit 0, is never task acceptance.
const RESOLVE_RUN_STATUSES = new Set(['failed', 'blocked', 'interrupted', 'cancelled']);
const RUN_PHASES = new Set([
  'prepare', 'implement', 'verify', 'review', 'check_review', 'fix',
  'awaiting_validation', 'awaiting_acceptance',
  // F2: the fusion panel phase — panelist attempts launch only here.
  'panel',
  // F3: post-panel handoff phases — judge mints the work order, integrate
  // runs the private-repo integrator. 'awaiting_validation' (already
  // listed) hosts the fusion fix round too.
  'judge', 'integrate',
]);
const EXEC_ROLES = new Set(['implementer', 'reviewer', 'checker']);
// U5: all three roles launch — each only inside its recorded phase and with
// a cwd the domain can prove (canonical workspace for implementer/fix, the
// recorded validation copies for reviewer/checker).
const LAUNCHABLE_ROLES = new Set(['implementer', 'reviewer', 'checker']);
const ROLE_PHASES = new Map([
  ['implementer', new Set(['implement', 'fix'])],
  ['reviewer', new Set(['review'])],
  ['checker', new Set(['check_review'])],
]);
const EVENT_TYPE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const EVENT_MAX_BYTES = 64 * 1024;
const SHA40_RE = /^[0-9a-f]{40}$/;

const ENVKEY_FIELDS = ['uid', 'gid', 'hostname', 'bootId', 'pidNs'];

// Environment identity is what survives a same-container Node restart: uid,
// gid, hostname, bootId, pid namespace — never the process pid. A different
// envKey proves a DIFFERENT environment, not a DEAD one (a second container
// on the shared mount has a different pidNs while the first still runs).
// Only a changed bootId proves the old environment is gone.
export function envKeyEqual(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return ENVKEY_FIELDS.every((k) => a[k] !== null && a[k] !== undefined && a[k] === b[k]);
}

export function envLostProof(oldEnv, newEnv) {
  return !!(oldEnv?.bootId && newEnv?.bootId && oldEnv.bootId !== newEnv.bootId);
}

function normalizeEnvKey(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CommandError(422, 'invalid_argument', 'envKey must be an object {uid,gid,hostname,bootId,pidNs}');
  }
  const out = {};
  for (const k of ENVKEY_FIELDS) out[k] = raw[k] ?? null;
  return out;
}

// envInstance — the per-container-instance identity, stable across a
// same-container Node restart and different after a container recreate even
// on the same host boot: {containerId, initStarttime} (PID 1 starttime inside
// the container's pid namespace is the Docker lifecycle anchor).
const ENV_INSTANCE_FIELDS = ['containerId', 'initStarttime'];

function normalizeEnvInstance(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) {
    throw new CommandError(422, 'invalid_argument',
      'envInstance must be {containerId,initStarttime}');
  }
  const out = {};
  for (const k of ENV_INSTANCE_FIELDS) {
    const v = raw[k];
    out[k] = (typeof v === 'string' && v && v.length <= 256) ? v
      : (Number.isFinite(v) ? String(v) : null);
  }
  return out;
}

export function envInstanceEqual(a, b) {
  return !!(a && b && ENV_INSTANCE_FIELDS.every((k) => a[k] != null && a[k] === b[k]));
}

// Card fields the managed lifecycle owns. A legacy PUT of board.json may
// change anything else (title, description, priority, order, links, ...) but
// these are restored from the aggregate on every write.
export const MANAGED_CARD_FIELDS = [
  'stage',
  'status',
  'statusByStage',
  'blocked',
  'blockedReason',
  'cancelled',
  'project',
  'session',
  'execution',
  // P1: the preparation summary is server-owned — a legacy board write can
  // never forge a session's phase or ready flag.
  'preparation',
];

const STAGE_STATUSES = {
  backlog: [],
  spec: ['in_progress', 'review', 'done'],
  plan: ['in_progress', 'review', 'done'],
  dev: ['in_progress', 'review', 'done'],
  reviewtest: ['in_progress', 'agent_tested', 'accepted'],
  done: [],
};

// Per-CLI compatibility for preset members. `models` is an explicit allowlist;
// `effort` is the set of accepted effort values (null = the CLI carries no
// separate effort knob — devin encodes it in the model id); `params` is the
// allowlist of free-form member.params keys (empty = params must be omitted).
// Seeded from the combinations configured for this deployment's porch
// profiles; operators extend it via <STATE_DIR>/execution/state/cli-compat.json
// ({cli: {models:[...], effort:[...]|null, params:[...]}}), merged per-CLI.
export const CLI_COMPAT_SEED = {
  devin: {
    models: ['swe-2-max', 'swe-2-high'],
    effort: null,
    params: [],
  },
  codex: {
    models: ['gpt-6-luna', 'gpt-6-astra', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    effort: ['none', 'low', 'medium', 'high'],
    params: [],
  },
  pi: {
    models: ['zen-relay/muse-spark-1.3-contributor-free'],
    effort: null,
    params: [],
  },
};

// --- typed errors --------------------------------------------------------------

export class CommandError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'CommandError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(err) {
  return { error: err.message, code: err.code, ...err.details };
}

// --- small helpers --------------------------------------------------------------

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function utf8Ok(text) {
  return typeof text === 'string' && text.isWellFormed();
}

function checkMarkdown(text) {
  if (!utf8Ok(text) || !text.length) {
    throw new CommandError(422, 'document_invalid', 'document must be non-empty well-formed UTF-8 text');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_DOC_BYTES) {
    throw new CommandError(422, 'document_too_large', `document exceeds ${MAX_DOC_BYTES} bytes (${bytes})`, {
      bytes,
      max: MAX_DOC_BYTES,
    });
  }
  return bytes;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function payloadHashOf(type, payload) {
  return sha256(JSON.stringify({ type, payload: payload ?? {} }));
}

// --- structured plan checks -------------------------------------------------------
//
// A check is data — {run: "cmd", cwd?: "project/rel", timeoutSec?: n,
// setup?: true} — stored verbatim on the version and copied into the plan
// approval snapshot. Nothing here executes or interpolates into a shell.

const CHECK_RUN_MAX = 2000;
const CHECK_TIMEOUT_MAX = 24 * 3600;

// Validate a caller-supplied checks array; preserves each entry verbatim
// (unknown extra keys are kept — they are data, but `run` stays a string and
// is never templated).
export function validateChecksArray(raw, tag = 'checks') {
  const problems = [];
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, problems: [`${tag} must be a non-empty array`], checks: [] };
  }
  const checks = [];
  raw.forEach((c, i) => {
    const at = `${tag}[${i}]`;
    if (!isObj(c) || typeof c.run !== 'string' || !c.run.trim()) {
      problems.push(`${at}: missing non-empty "run"`);
      return;
    }
    if (c.run.length > CHECK_RUN_MAX) {
      problems.push(`${at}: run exceeds ${CHECK_RUN_MAX} chars`);
      return;
    }
    if (c.cwd !== undefined) {
      if (typeof c.cwd !== 'string' || isAbsolute(c.cwd) || c.cwd.split(/[\\/]+/).includes('..')) {
        problems.push(`${at}: cwd must be a project-relative path without '..'`);
        return;
      }
    }
    if (c.timeoutSec !== undefined) {
      const t = Number(c.timeoutSec);
      if (!Number.isFinite(t) || t <= 0 || t > CHECK_TIMEOUT_MAX) {
        problems.push(`${at}: timeoutSec must be a number in (0, ${CHECK_TIMEOUT_MAX}]`);
        return;
      }
    }
    if (c.setup !== undefined && c.setup !== true && c.setup !== false) {
      problems.push(`${at}: setup must be a boolean when present`);
      return;
    }
    checks.push(structuredClone(c));
  });
  return { ok: problems.length === 0, problems, checks };
}

// Import convenience: a plan document MAY carry one fenced ```acp-checks JSON
// block ({"checks":[...]}). Parsed and validated like the payload form; the
// block is data, never executed, and never required for approval.
const CHECKS_FENCE_RE = /```acp-checks[^\n]*\n([\s\S]*?)```/g;

export function extractPlanChecks(markdown) {
  const blocks = [...markdown.matchAll(CHECKS_FENCE_RE)].map((m) => m[1]);
  if (!blocks.length) return null; // absent — fine, payload checks may exist
  if (blocks.length > 1) {
    return { ok: false, problems: [`multiple acp-checks blocks (${blocks.length}) — exactly one is allowed`], checks: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(blocks[0]);
  } catch (e) {
    return { ok: false, problems: [`acp-checks block is not valid JSON: ${e.message}`], checks: [] };
  }
  const v = validateChecksArray(parsed?.checks, 'acp-checks.checks');
  return v;
}

// --- project registry -----------------------------------------------------------

// The card's `project` field is a free-text label; match it to the registry
// by name, else by the path's basename — same rule as src/stores/board.ts
// projectIdForCard, scripts/boardctl and server/acp-runner.mjs.
export function resolveProject(projectsDoc, labelOrId) {
  const label = String(labelOrId || '').trim().toLowerCase();
  if (!label) return null;
  const projects = projectsDoc?.projects || [];
  return (
    projects.find((p) => String(p?.id || '') === labelOrId) ||
    projects.find((p) => String(p?.name || '').trim().toLowerCase() === label) ||
    projects.find((p) => {
      const base = String(p?.path || '').split(/[\\/]+/).filter(Boolean).pop() || '';
      return base.toLowerCase() === label;
    }) ||
    null
  );
}

// The project path must be a REAL git work-tree root — `git rev-parse
// --show-toplevel` proves the repository (a planted empty `.git` dir does
// not) and yields the canonical top of linked worktrees (.git file). The
// path itself must equal that top: imports bind to the registered root, not
// some subdirectory of a bigger tree. Bounded, no shell.
//
// Goes through the workspaces helper: foreign-owned repos (uid-1001
// projects under a root state service) get scoped per-invocation
// safe.directory handling, and a missing git binary or persisting
// ownership refusal surfaces as git_unavailable/git_ownership — never a
// generic "not a git root" false.
async function isGitRoot(path) {
  const top = await sourceGitRoot(path);
  if (top === null) return false;
  return top === normPath(await realpathOrSelf(path));
}

async function realpathOrSelf(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return resolve(p);
  }
}

// --- document sources -------------------------------------------------------------

async function readImportSource(ctx, aggregate, source) {
  const rel = typeof source?.path === 'string' ? source.path.trim() : '';
  if (!rel || isAbsolute(rel)) {
    throw new CommandError(422, 'import_invalid', 'source.path must be a non-empty relative path');
  }
  const projectId = source.projectId || aggregate.projectId;
  const projectsDoc = await ctx.getDoc('projects.json');
  const project =
    resolveProject(projectsDoc, projectId) ||
    (projectId === aggregate.projectId
      ? { id: aggregate.projectId, path: aggregate.projectPath, name: aggregate.projectLabel }
      : null);
  if (!project || !project.path) {
    throw new CommandError(422, 'import_invalid', `source project ${JSON.stringify(projectId)} is not registered`);
  }
  const root = await realpathOrSelf(project.path);
  if (!(await isGitRoot(root))) {
    throw new CommandError(422, 'import_invalid', `project root is not a git work tree: ${root}`, {
      project: project.name,
    });
  }
  const candidate = resolve(root, rel);
  const real = await fs.realpath(candidate).catch(() => null);
  if (!real) {
    throw new CommandError(422, 'import_invalid', `import path does not exist: ${rel}`, { path: rel });
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new CommandError(422, 'import_escape', 'import path resolves outside the registered project root', {
      path: rel,
      resolved: real,
      root,
    });
  }
  const st = await fs.stat(real);
  if (!st.isFile()) {
    throw new CommandError(422, 'import_invalid', `import path is not a file: ${rel}`, { path: rel });
  }
  if (st.size > MAX_DOC_BYTES) {
    throw new CommandError(422, 'document_too_large', `imported file exceeds ${MAX_DOC_BYTES} bytes (${st.size})`, {
      bytes: st.size,
      max: MAX_DOC_BYTES,
    });
  }
  const buf = await fs.readFile(real);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new CommandError(422, 'document_invalid', `imported file is not valid UTF-8: ${rel}`, { path: rel });
  }
  return {
    text,
    sourceRecord: { type: 'import', projectId: project.id, path: rel, resolvedPath: real },
  };
}

async function documentFromSource(ctx, aggregate, source) {
  if (!isObj(source)) {
    throw new CommandError(422, 'document_invalid', 'payload.source must be an object');
  }
  if (source.type === 'text') {
    const bytes = checkMarkdown(source.text);
    return { text: source.text, bytes, sourceRecord: { type: 'text' } };
  }
  if (source.type === 'import') {
    const { text, sourceRecord } = await readImportSource(ctx, aggregate, source);
    const bytes = checkMarkdown(text);
    return { text, bytes, sourceRecord };
  }
  if (source.type === 'work_order') {
    // F3 document result: the accepted work order's committed artifact
    // bytes become the document content — a NEW version of the target
    // kind with the standard no-auto-approval semantics.
    const runId = typeof source.runId === 'string' ? source.runId : null;
    const run = runId ? (aggregate.runs || []).find((r) => r && r.id === runId) : null;
    if (!run || run.mode !== 'fusion') {
      throw new CommandError(404, 'run_not_found', `fusion run ${runId} does not exist on this card`);
    }
    const wo = (run.fusion?.workOrders || []).find((w) => w && w.versionId === source.versionId);
    if (!wo) {
      throw new CommandError(422, 'unknown_version',
        `work order ${JSON.stringify(source.versionId)} is not recorded on run ${runId}`);
    }
    const artRec = run.artifacts?.[wo.artifactId];
    const { text } = await ctx.readArtifactText(runId, artRec?.stored ?? artRec?.file ?? wo.artifactId);
    const bytes = checkMarkdown(text);
    // The durable WO record binds the artifact hash — refuse to attach
    // bytes that don't hash to it (corrupt or swapped artifact store).
    if (sha256(Buffer.from(text, 'utf8')) !== wo.sha256) {
      throw new CommandError(409, 'hash_mismatch',
        `work order ${wo.versionId} artifact bytes do not hash to the recorded sha256`);
    }
    return {
      text,
      bytes,
      sourceRecord: {
        type: 'work_order',
        runId,
        versionId: wo.versionId,
        sha256: wo.sha256,
      },
    };
  }
  throw new CommandError(422, 'document_invalid', `unknown source.type ${JSON.stringify(source.type)}`);
}

// --- projection ------------------------------------------------------------------

function currentRun(aggregate) {
  return aggregate.currentRunId
    ? (aggregate.runs || []).find((r) => r && r.id === aggregate.currentRunId) ?? null
    : null;
}

function lifecycleStage(aggregate, run) {
  if (run) {
    switch (run.status) {
      case 'queued':
      case 'active':
        return run.phase === 'verify' || run.phase === 'review' || run.phase === 'check_review'
          ? { stage: 'reviewtest', status: 'in_progress' }
          : { stage: 'dev', status: 'in_progress' };
      case 'stopping':
        return { stage: 'dev', status: 'in_progress' };
      case 'awaiting_acceptance':
        return { stage: 'reviewtest', status: 'agent_tested' };
      case 'succeeded':
        return { stage: 'done', status: null };
      default:
        // cancelled/failed/interrupted/blocked stay in the last working
        // column — keep the card's current stage (already projected).
        return null;
    }
  }
  if (!aggregate.approvals?.requirements) return { stage: 'spec', status: 'in_progress' };
  if (!aggregate.approvals?.plan) return { stage: 'plan', status: 'in_progress' };
  return { stage: 'plan', status: 'done' };
}

// Recompute the server-owned card fields. `boardCard` is the row currently in
// board.json (for order/sibling context); missing on a fresh projection.
export function computeProjection(aggregate, boardCard, boardDoc) {
  const run = currentRun(aggregate);
  const lifecycle = lifecycleStage(aggregate, run);
  const prevStage = aggregate.projection?.stage || boardCard?.stage || 'backlog';
  const stage = lifecycle?.stage ?? prevStage;
  const status = lifecycle
    ? lifecycle.status
    : (STAGE_STATUSES[prevStage] || []).includes(aggregate.projection?.status)
      ? aggregate.projection.status
      : STAGE_STATUSES[prevStage]?.[0] ?? null;
  // statusByStage is authoritative aggregate history: it evolves ONLY from
  // the previous projection (a command transition records where the card was
  // authoritatively), never from the incoming client row — a forged
  // statusByStage/status on a legacy write cannot leak into the projection.
  const statusByStage = { ...(aggregate.projection?.statusByStage || {}) };
  const prior = aggregate.projection;
  if (
    prior &&
    prior.stage !== stage &&
    prior.status &&
    (STAGE_STATUSES[prior.stage] || []).includes(prior.status)
  ) {
    statusByStage[prior.stage] = prior.status;
  }
  let order = boardCard?.order ?? aggregate.projection?.order ?? 10;
  if (boardCard && stage !== boardCard.stage) {
    const siblings = (boardDoc?.cards || []).filter(
      (c) => c && c.id !== aggregate.cardId && c.stage === stage,
    );
    order = siblings.length ? Math.max(...siblings.map((c) => Number(c.order) || 0)) + 10 : 10;
  }
  return {
    stage,
    status,
    statusByStage,
    blocked: false,
    blockedReason: '',
    cancelled: false,
    project: aggregate.projectLabel,
    session: aggregate.session ?? null,
    order,
    execution: {
      managed: true,
      runId: aggregate.currentRunId ?? null,
      runStatus: run?.status ?? null,
      controlRevision: aggregate.controlRevision,
    },
    // P1: the card row carries a compact server-owned preparation summary —
    // derived from aggregate truth, never from client writes.
    preparation: preparationSummary(aggregate),
  };
}

// --- aggregate construction --------------------------------------------------------

function newAggregate(card, { project, projectPath, session, now }) {
  const aggregate = {
    schemaVersion: AGGREGATE_VERSION,
    cardId: card.id,
    managed: true,
    enabledAt: now,
    controlRevision: 0,
    internalRevision: 0,
    projectId: project.id,
    projectLabel: card.project || project.name || '',
    projectPath,
    session: session ?? null,
    documents: Object.fromEntries(DOC_KINDS.map((k) => [k, { current: null, versions: [] }])),
    approvals: { requirements: null, plan: null },
    // commandId -> {type, payloadHash, status, body, at}. NO eviction: dedup
    // semantics are "same id + same payload -> original outcome, forever".
    commands: {},
    currentRunId: null,
    workspaceId: null,
    workspaces: {},
    // Card composition: full validated preset snapshot bound by save_preset —
    // a registry reference alone would let registry edits rewrite the card.
    composition: null,
    // Durable pending external effects; drained idempotently on repair.
    pendingWrites: null,
    runs: [],
    // P1 idea preparation: at most one ACTIVE session per card; stopped
    // sessions are archived (bounded) for provenance.
    preparation: null,
    preparationHistory: [],
    cardSnapshot: null,
    projection: null,
  };
  aggregate.cardSnapshot = { ...card };
  return aggregate;
}

function recordCommand(aggregate, commandId, type, payloadHash, status, body, now) {
  aggregate.commands[commandId] = { type, payloadHash, status, body, at: now };
}

function bumpControl(aggregate, now) {
  aggregate.controlRevision += 1;
  aggregate.updatedAt = now;
}

// --- command handlers ---------------------------------------------------------------

// Classify a card-owned legacy claim for the enable gate.
//   'active'    — lease still live: refuse.
//   'ambiguous' — lease expired but the record carries execution evidence
//                 (child pid, runner pid, or an agent session id). The state
//                 server cannot prove that evidence terminal: pid numbers in
//                 the record belong to the writer's pid namespace (runner and
//                 state server are separate containers), a matching local
//                 /proc entry could be a recycled or foreign pid, and no
//                 recorded namespace/start-time pins the identity. Failing
//                 closed is the only honest answer — the claim is NOT erased
//                 and enable is refused until the owning runner sweeps the
//                 residue itself (its pid checks ARE valid in its own
//                 namespace) or an operator reconciles explicitly
//                 (boardctl release <id> --force).
//   'stale'     — expired marker with no execution evidence at all: safe to
//                 drop as part of enable.
export function classifyLegacyClaim(claim, now) {
  if (!claim || typeof claim !== 'object') return 'stale';
  if (Number(claim.leaseUntil) > now) return 'active';
  const hasEvidence =
    claim.pid != null ||
    claim.runnerPid != null ||
    (typeof claim.sessionId === 'string' && claim.sessionId.length > 0);
  return hasEvidence ? 'ambiguous' : 'stale';
}

async function cmdEnable(ctx, cardId, payload, now) {
  const board = await ctx.getDoc('board.json');
  const card = (board?.cards || []).find((c) => c && c.id === cardId);
  if (!card) {
    throw new CommandError(404, 'card_not_found', `unknown card ${cardId}`);
  }
  if (card.execution && card.execution.managed === true) {
    // Marker without an aggregate: fail loudly — re-enabling would fork the
    // lifecycle while the old aggregate may still exist on disk.
    throw new CommandError(409, 'aggregate_inconsistent',
      'card carries a managed marker but no aggregate exists — manual repair required');
  }
  if (card.cancelled === true) {
    throw new CommandError(422, 'card_cancelled', 'a cancelled card cannot be enabled for managed execution');
  }
  const claims = await ctx.getDoc('claims.json');
  const claim = (claims?.claims || {})[cardId];
  if (claim) {
    const cls = classifyLegacyClaim(claim, now);
    if (cls === 'active') {
      throw new CommandError(409, 'legacy_claim_active',
        `card is held by a live legacy claim (${claim.agentName || 'unknown'}) until ${claim.leaseUntil}`,
        { agentName: claim.agentName ?? null, leaseUntil: claim.leaseUntil ?? null });
    }
    if (cls === 'ambiguous') {
      throw new CommandError(409, 'legacy_claim_unresolved',
        `card's expired legacy claim carries execution evidence that cannot be proven terminal here ` +
          `(pid=${claim.pid ?? '-'} runnerPid=${claim.runnerPid ?? '-'} session=${claim.sessionId ?? '-'}) — ` +
          `enable refused; let the owning runner sweep it or release it explicitly (boardctl release ${cardId} --force)`,
        { agentName: claim.agentName ?? null, leaseUntil: claim.leaseUntil ?? null });
    }
    // 'stale': a bare expired marker — dropped below as part of enable.
  }
  const projectsDoc = await ctx.getDoc('projects.json');
  const project = resolveProject(projectsDoc, card.project);
  if (!project || !project.path) {
    throw new CommandError(422, 'project_unbound',
      `card project label ${JSON.stringify(card.project || '')} does not resolve to a registered project`);
  }
  const projectPath = await realpathOrSelf(project.path);
  if (!(await isGitRoot(projectPath))) {
    throw new CommandError(422, 'project_not_git',
      `project path is not a git work tree: ${projectPath}`, { project: project.name });
  }
  // Card-owned evidence only: a live claim on THIS card blocks enable. An
  // unrelated external porch run sharing the project cwd does not (the
  // workspace allocator handles cwd conflicts when workspaces exist, U3).

  const aggregate = newAggregate(card, {
    project,
    projectPath,
    session: card.session ?? null,
    now,
  });
  bumpControl(aggregate, now); // enable itself is the first control action —
  // bump BEFORE projecting so execution.controlRevision isn't left at 0.
  // The pre-managed status history is legitimate card data — captured ONCE
  // at enable; afterwards statusByStage only evolves via projections.
  aggregate.projection = computeProjection(aggregate, card, board);
  aggregate.projection.statusByStage = { ...(card.statusByStage || {}) };
  if (card.status && (STAGE_STATUSES[card.stage] || []).includes(card.status)) {
    aggregate.projection.statusByStage[card.stage] = card.status;
  }

  // Projection effects: merge the card row and drop the stale/evidence-free
  // legacy claim + attempt residue for this card (live or ambiguous claims
  // were already refused above; the attempts map is optional in legacy docs).
  const claimsNow = await ctx.getDoc('claims.json');
  const claimNow = claimsNow?.claims?.[cardId];
  const attemptNow = claimsNow?.attempts?.[cardId];
  if (claimsNow && (claimNow !== undefined || attemptNow !== undefined)) {
    const nextClaims = structuredClone(claimsNow);
    if (nextClaims.claims) delete nextClaims.claims[cardId];
    if (nextClaims.attempts) delete nextClaims.attempts[cardId];
    ctx.putDoc('claims.json', nextClaims, { type: 'claims_purge', cardId });
  }
  const nextBoard = structuredClone(board);
  nextBoard.cards = (nextBoard.cards || []).map((c) =>
    c && c.id === cardId ? { ...c, ...aggregate.projection } : c);
  aggregate.cardSnapshot = nextBoard.cards.find((c) => c.id === cardId);
  ctx.putDoc('board.json', nextBoard, { type: 'board_projection' });

  return { aggregate, result: { managed: true, cardId, projectId: project.id } };
}

async function cmdAttachDocument(ctx, aggregate, payload, now) {
  const kind = payload?.kind;
  if (!DOC_KINDS.includes(kind)) {
    throw new CommandError(422, 'document_invalid', `kind must be one of ${DOC_KINDS.join(', ')}`);
  }
  // Plan provenance: a plan version records which requirements version it was
  // prepared for — payload may name it explicitly, otherwise the CURRENT
  // requirements version at attach time is bound. There is no silent rebind:
  // approving later requires the bound version to still be the approved one.
  let boundRequirements = null;
  if (kind === 'plan') {
    const reqDocs = aggregate.documents.requirements;
    if (payload?.requirementsVersionId !== undefined) {
      const want = payload.requirementsVersionId;
      const rv = reqDocs.versions.find((v) => v.versionId === want);
      if (!rv) {
        throw new CommandError(422, 'unknown_version',
          `requirements version ${want} does not exist — cannot bind plan to it`, { versionId: want });
      }
      boundRequirements = { versionId: rv.versionId, sha256: rv.sha256 };
    } else if (reqDocs.current) {
      const cur = reqDocs.versions.find((v) => v.versionId === reqDocs.current);
      boundRequirements = cur ? { versionId: cur.versionId, sha256: cur.sha256 } : null;
    }
  } else if (payload?.requirementsVersionId !== undefined) {
    throw new CommandError(422, 'document_invalid',
      'requirementsVersionId binding only applies to kind=plan');
  }
  // Structured check commands: may arrive with the attach payload or at
  // approve time. Attached checks are validated strictly and stored verbatim.
  let checksAttached = null;
  if (payload?.checks !== undefined) {
    if (kind !== 'plan') {
      throw new CommandError(422, 'document_invalid', 'checks only apply to kind=plan');
    }
    const v = validateChecksArray(payload.checks, 'payload.checks');
    if (!v.ok) {
      throw new CommandError(422, 'plan_checks_invalid', 'payload.checks failed validation', {
        problems: v.problems,
      });
    }
    checksAttached = v.checks;
  }

  const { text, bytes, sourceRecord } = await documentFromSource(ctx, aggregate, payload?.source);
  const blob = await ctx.writeBlob(text);
  const version = {
    versionId: `v_${randomUUID()}`,
    kind,
    sha256: blob.sha256,
    bytes,
    createdAt: now,
    source: sourceRecord,
  };
  if (kind === 'plan') {
    version.requirements = boundRequirements;
    if (checksAttached) version.checks = { source: 'payload', checks: checksAttached };
    const fromDoc = extractPlanChecks(text);
    if (fromDoc) {
      version.checksFromDocument = fromDoc.ok
        ? { ok: true, checks: fromDoc.checks }
        : { ok: false, problems: fromDoc.problems };
    }
  }
  aggregate.documents[kind].versions.push(version);
  aggregate.documents[kind].current = version.versionId;
  // New inputs revoke the approvals bound to the old hashes. Requirements
  // also revoke the plan approval (it is bound to the requirements hash).
  if (kind === 'requirements' || kind === 'plan') {
    aggregate.approvals[kind] = null;
    if (kind === 'requirements') aggregate.approvals.plan = null;
  }
  bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      attached: version,
      versionId: version.versionId,
      sha256: version.sha256,
      requirementsBound: boundRequirements,
    },
  };
}

// The approval payload names the version AND its hash explicitly — approving
// "whatever is current" is not a thing. The presented hash must equal the
// stored hash and the blob must verify before anything is bound to it.
async function approvalTarget(ctx, aggregate, kind, payload) {
  const docs = aggregate.documents[kind];
  const versionId = payload?.versionId;
  if (typeof versionId !== 'string' || !versionId) {
    throw new CommandError(422, 'approval_requires_version',
      `payload.versionId is required — approve the exact ${kind} version presented`);
  }
  const sha = payload?.sha256;
  if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
    throw new CommandError(422, 'approval_requires_hash',
      'payload.sha256 is required and must be the presented version content hash');
  }
  const version = docs.versions.find((v) => v.versionId === versionId);
  if (!version) {
    throw new CommandError(422, 'unknown_version', `${kind} version ${versionId} does not exist on this card`);
  }
  if (version.sha256 !== sha) {
    throw new CommandError(409, 'hash_mismatch',
      `presented sha256 does not match ${kind} version ${versionId} — refusing approval of different content`,
      { versionId, expected: version.sha256 });
  }
  if (docs.current !== version.versionId) {
    throw new CommandError(409, 'stale_version',
      `${kind} version ${versionId} is not current (current: ${docs.current}) — approve the current version`,
      { current: docs.current });
  }
  // Evidence must exist and verify before an approval binds to its hash.
  await ctx.requireBlob(version.sha256, `${kind} document`);
  return version;
}

async function cmdApproveRequirements(ctx, aggregate, payload, now) {
  const version = await approvalTarget(ctx, aggregate, 'requirements', payload);
  aggregate.approvals.requirements = {
    versionId: version.versionId,
    sha256: version.sha256,
    at: now,
    by: typeof payload?.by === 'string' ? payload.by : 'user',
  };
  bumpControl(aggregate, now);
  return { aggregate, refreshProjection: true, result: { approval: aggregate.approvals.requirements } };
}

async function cmdApprovePlan(ctx, aggregate, payload, now) {
  const reqApproval = aggregate.approvals.requirements;
  if (!reqApproval) {
    throw new CommandError(422, 'requirements_unapproved',
      'requirements must be approved before the plan');
  }
  const version = await approvalTarget(ctx, aggregate, 'plan', payload);
  // The plan must have been prepared for the requirements version that is
  // approved NOW — a plan bound to reqA cannot be silently approved under
  // reqB; attach a new plan version bound to reqB for reassessment.
  const bound = version.requirements;
  if (!bound || bound.versionId !== reqApproval.versionId || bound.sha256 !== reqApproval.sha256) {
    throw new CommandError(409, 'plan_binding_stale',
      `plan version ${version.versionId} was prepared for requirements ` +
        `${bound ? bound.versionId : '(none)'}, but the approved requirements are ` +
        `${reqApproval.versionId} — attach a plan version bound to the current requirements`,
      { boundTo: bound, approvedRequirements: reqApproval.versionId });
  }
  // Checks confirmed at approval (payload.checks) take precedence, then
  // attach-time payload checks, then a document acp-checks block. The
  // approval stores the EXACT validated snapshot it was shown.
  let checks = null;
  let checksSource = null;
  if (payload?.checks !== undefined) {
    const v = validateChecksArray(payload.checks, 'payload.checks');
    if (!v.ok) {
      throw new CommandError(422, 'plan_checks_invalid', 'payload.checks failed validation', {
        problems: v.problems,
      });
    }
    checks = v.checks;
    checksSource = 'approval_payload';
  } else if (version.checks) {
    checks = version.checks.checks;
    checksSource = 'attach_payload';
  } else if (version.checksFromDocument?.ok) {
    checks = version.checksFromDocument.checks;
    checksSource = 'document_block';
  }
  if (!checks || !checks.length) {
    throw new CommandError(422, 'plan_checks_missing',
      'plan approval requires a confirmed set of check commands — supply payload.checks, ' +
        'attach the plan with checks, or include a valid acp-checks block in the document');
  }
  aggregate.approvals.plan = {
    versionId: version.versionId,
    sha256: version.sha256,
    requirementsVersionId: reqApproval.versionId,
    requirementsSha256: reqApproval.sha256,
    checks,
    checksSource,
    at: now,
    by: typeof payload?.by === 'string' ? payload.by : 'user',
  };
  bumpControl(aggregate, now);
  return { aggregate, refreshProjection: true, result: { approval: aggregate.approvals.plan } };
}

// The durable reservation set: any non-terminal run or any non-terminal
// attempt across ALL runs of this card. A run status alone never proves its
// attempts died (a blocked/failed run could still carry a live attempt), so
// admission checks scan the attempt records, not just run.status.
function liveReservations(aggregate) {
  const live = [];
  for (const r of aggregate.runs || []) {
    if (!r || typeof r !== 'object') continue;
    if (RUN_NONTERMINAL.has(r.status)) live.push({ run: r, attempt: null });
    for (const a of r.attempts || []) {
      if (a && ATTEMPT_NONTERMINAL.has(a.status)) live.push({ run: r, attempt: a });
    }
    // A live validation is a reservation even on a terminal run — a failed
    // role attempt can strand active/unproven groups that only positive
    // proof may release.
    const v = r.validation;
    if (v && (v.status === 'active' || v.status === 'unproven')) {
      live.push({ run: r, validation: v });
    }
  }
  return live;
}

function describeReservation(liveRes) {
  const w = liveRes[0];
  return w.attempt
    ? `attempt ${w.attempt.id} (${w.attempt.status}) on run ${w.run.id}`
    : `run ${w.run.id} (${w.run.status})`;
}

// Stop intent — the ATOMIC halt: every non-terminal run goes 'stopping' and
// every non-terminal attempt gets a durable cancel marker in the same
// commit — INCLUDING an attempt left live under a run whose status is
// already terminal-ish (a blocked run can hold one; run.status alone never
// proves the attempt set died). Such a run is moved to 'stopping' so the
// halt is durable and projected, and its prior status is preserved so the
// completion path restores it rather than papering over the failure.
// From the instant this lands, no new begin_attempt/launch is legal and no
// later step may start; workspaces/slots stay reserved until each attempt
// is positively observed terminal.
function applyStopIntent(aggregate, now, { by = 'user', reason = null } = {}) {
  const stoppedRuns = [];
  const cancelPending = [];
  for (const r of aggregate.runs || []) {
    if (!r || typeof r !== 'object') continue;
    const liveAttempts = (r.attempts || []).filter(
      (a) => a && ATTEMPT_NONTERMINAL.has(a.status));
    const liveVal = r.validation
      && (r.validation.status === 'active' || r.validation.status === 'unproven');
    const runLive = RUN_NONTERMINAL.has(r.status);
    if (!runLive && !liveAttempts.length && !liveVal) continue;
    if (!runLive) r.priorTerminal = r.status; // e.g. blocked/failed with a live attempt
    if (r.status !== 'stopping') r.status = 'stopping';
    r.stopIntent ??= { at: now, by, reason };
    // U5: a live OR unproven validation reservation gets the durable cancel
    // marker in the SAME commit — the check-exec task polls this and kills
    // only its proven process group; an unproven one still drains.
    if (liveVal) {
      r.validation.cancel ??= { requestedAt: now, by, reason: reason ?? 'stop requested' };
    }
    for (const a of liveAttempts) {
      a.cancel ??= { requestedAt: now, by, reason: reason ?? 'stop requested' };
      cancelPending.push(a.id);
    }
    stoppedRuns.push(r.id);
  }
  return { stoppedRuns, cancelPending };
}

async function cmdStop(_ctx, aggregate, payload, now, ctx = _ctx) {
  if (!(aggregate.runs || []).length) {
    throw new CommandError(422, 'nothing_to_stop', 'card has no run to stop');
  }
  const by = typeof payload?.by === 'string' && payload.by.trim()
    ? payload.by.trim().slice(0, 64) : 'user';
  const reason = typeof payload?.reason === 'string' ? payload.reason.slice(0, 500) : null;
  const { stoppedRuns, cancelPending } = applyStopIntent(aggregate, now, { by, reason });
  if (!stoppedRuns.length) {
    const cur = currentRun(aggregate);
    throw new CommandError(409, 'run_terminal',
      `run ${cur?.id} is already ${cur?.status} — nothing live to stop`);
  }
  for (const r of aggregate.runs) {
    if (r && stoppedRuns.includes(r.id)) stageRun(aggregate, r, ctx);
  }
  bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: { status: 'stopping', stoppedRuns, cancelPending },
  };
}

async function cmdChangeRequirements(ctx, aggregate, payload, now) {
  // Requirements changed: invalidate BOTH approvals (the plan was bound to
  // the old requirements) AND set the durable stop intent on anything live —
  // one atomic commit. No new work may be issued until the new inputs are
  // attached and re-approved.
  const { stoppedRuns, cancelPending } =
    applyStopIntent(aggregate, now, { by: 'user', reason: 'requirements_changed' });
  for (const r of aggregate.runs || []) {
    if (r && stoppedRuns.includes(r.id)) stageRun(aggregate, r, ctx);
  }
  const invalidated = [];
  if (aggregate.approvals.requirements) {
    aggregate.approvals.requirements = null;
    invalidated.push('requirements');
  }
  if (aggregate.approvals.plan) {
    aggregate.approvals.plan = null;
    invalidated.push('plan');
  }
  aggregate.requirementsChangedAt = now;
  bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      requirementsChanged: true,
      invalidatedApprovals: invalidated,
      stoppedRuns,
      cancelPending,
    },
  };
}

// --- managed run: start (gated) ---------------------------------------------------
//
// `start` is a USER command, but only when the execution start gate is on
// (ctx.features.start — ACP_EXEC_START=1 or test injection). It validates
// and freezes every input, then persists run {status:'queued'}. It never
// launches anything: the porch call is the scheduler's, through
// begin_attempt on the internal channel.

function runOf(aggregate, runId) {
  return (aggregate.runs || []).find(
    (r) => r && typeof r === 'object' && r.id === runId) ?? null;
}

function liveAttempt(run) {
  return (run?.attempts || []).find(
    (a) => a && ATTEMPT_NONTERMINAL.has(a.status)) ?? null;
}

function attemptsUsed(run, role) {
  return (run?.attempts || []).filter((a) => a && a.role === role).length;
}

// Deps bag for the fusion domain handlers — assembled HERE so the fusion
// module runs inside this serialized queue with the same helpers, never
// importing the domain module (no cycle).
const FUSION_DEPS = {
  CommandError, reqStr, normPath,
  SAFE_ID_RE, SHA256_RE, SHA40_RE,
  runOf, findAttempt, stageRun, bumpControl,
  newOwner, ownsResource, checkAdoptionProof, clampLeaseMs,
  ATTEMPT_NONTERMINAL, ATTEMPT_TERMINAL, RUN_NONTERMINAL,
  liveReservations, describeReservation,
  requireApprovedInputs, runInputsSnapshot, currentDesignInput,
  resolveBaseCommit, projectKeyFor,
  validateMember, snapshotReviewRules,
};

// Deps bag for the P1 preparation module — same seam style as FUSION_DEPS:
// the module runs inside this serialized queue, gets the domain's helpers,
// and never imports the domain (no cycle). Registry truth reaches it only
// through ctx.preparationRegistry/ctx.preparationVerify (state-service).
const PREP_DEPS = {
  CommandError, bumpControl,
  DOC_KINDS, SHA256_RE, COMMAND_ID_RE,
  checkMarkdown, extractPlanChecks,
};

function currentDesignInput(aggregate) {
  const cur = aggregate.documents?.design?.current;
  if (!cur) return null;
  const v = (aggregate.documents.design.versions || []).find(
    (x) => x && x.versionId === cur);
  return v ? { versionId: v.versionId, sha256: v.sha256 } : null;
}

function stageRun(aggregate, run, ctx) {
  // runs/<id>.json is a projection: the aggregate stays the source of truth
  // and the intent lets repair rewrite the file after a mid-commit crash.
  ctx.putRun({ ...structuredClone(run), cardId: aggregate.cardId },
    { type: 'run_projection', runId: run.id });
}

// Gates shared by start and continue: every input must be approved NOW and
// its blob must verify — continue never bypasses the approval gates.
async function requireApprovedInputs(ctx, aggregate, commandName) {
  const reqA = aggregate.approvals?.requirements;
  if (!reqA) {
    throw new CommandError(422, 'requirements_unapproved',
      `${commandName} requires an approved requirements version`);
  }
  const planA = aggregate.approvals?.plan;
  if (!planA) {
    throw new CommandError(422, 'plan_unapproved',
      `${commandName} requires an approved plan version`);
  }
  if (!aggregate.composition?.preset) {
    throw new CommandError(422, 'composition_missing',
      `${commandName} requires a saved composition (save_preset) on this card`);
  }
  // The run binds blobs by hash; they must exist and verify NOW so a queued
  // run can never reference evidence that is missing at launch time.
  await ctx.requireBlob(reqA.sha256, 'requirements document');
  await ctx.requireBlob(planA.sha256, 'plan document');
  // P1: an ACTIVE preparation session additionally owns the readiness gate —
  // SkillGates of the bindings actually used are revalidated together with
  // the core approvals. A stopped/absent session gates nothing here (the
  // card is then on the plain core lifecycle).
  await prepAssertStartReady(PREP_DEPS, ctx, aggregate, commandName);
  return { reqA, planA };
}

function runInputsSnapshot(aggregate, reqA, planA) {
  return {
    requirements: { versionId: reqA.versionId, sha256: reqA.sha256 },
    plan: {
      versionId: planA.versionId,
      sha256: planA.sha256,
      requirementsVersionId: planA.requirementsVersionId,
      checks: structuredClone(planA.checks || []),
      checksSource: planA.checksSource,
    },
    design: currentDesignInput(aggregate),
  };
}

// A run parked at active + awaiting_validation/awaiting_acceptance holds NO
// live attempts — its reservation is historical evidence, not activity. The
// workspace may transfer to a continuation; the parked run is never re-driven
// (the scheduler phase guard prevents relaunch) and its evidence is intact.
function runParked(run) {
  return !!run && run.status === 'active'
    && (run.phase === 'awaiting_validation' || run.phase === 'awaiting_acceptance')
    && !(run.attempts || []).some((a) => a && ATTEMPT_NONTERMINAL.has(a.status))
    // U5: a run holding an ACTIVE or UNPROVEN validation reservation is
    // never parked — continue/workspace reassignment is refused while
    // durable validation work exists (even with zero live attempts). A run
    // with a pending fixContext (gate decided fix, fix attempt not yet
    // launched) holds the same kind of reservation — the workspace still
    // belongs to the pending fix. Only a run with NO validation
    // reservation yet may transfer.
    && !run.fixContext
    && !(run.validation && (run.validation.status === 'active' || run.validation.status === 'unproven'));
}

// The card's workspace may be retained by a NEW run only when its record is
// ready and its recorded run binding is gone/terminal/parked — the
// reservation (path, branch, files, history) is preserved as allocated,
// never recreated.
function retainableWorkspaceId(aggregate) {
  const ws = aggregate.workspaces?.[aggregate.workspaceId];
  if (!ws || ws.status !== 'ready') return null;
  const boundRun = ws.runId ? runOf(aggregate, ws.runId) : null;
  return (!boundRun || !RUN_NONTERMINAL.has(boundRun.status) || runParked(boundRun))
    ? aggregate.workspaceId : null;
}

async function cmdStart(ctx, aggregate, payload, now) {
  const wantMode = payload?.mode === undefined ? 'solo' : payload.mode;
  if (wantMode === 'fusion') return cmdStartFusion(ctx, aggregate, payload, now);
  if (wantMode !== 'solo') {
    throw new CommandError(422, 'invalid_argument',
      `payload.mode must be 'solo' or 'fusion' — got ${JSON.stringify(payload?.mode)}`);
  }
  const { reqA, planA } = await requireApprovedInputs(ctx, aggregate, 'start');
  const liveRes = liveReservations(aggregate);
  if (liveRes.length) {
    throw new CommandError(409, 'run_active',
      `${describeReservation(liveRes)} — stop/resolve it before starting another`);
  }
  const baseRef =
    typeof payload?.baseRef === 'string' && payload.baseRef.trim()
      ? payload.baseRef.trim() : 'HEAD';
  let baseCommit;
  try {
    baseCommit = await resolveBaseCommit(aggregate.projectPath, baseRef);
  } catch (e) {
    // Capability/ownership faults are service diagnostics, not a bad ref.
    if (e instanceof RuntimeError
      && (e.code === 'git_unavailable' || e.code === 'git_ownership')) {
      throw new CommandError(503, e.code, e.message);
    }
    throw new CommandError(422, 'base_ref_invalid',
      e instanceof RuntimeError ? e.message : String(e));
  }
  // Workspace policy: reuse the card's ready workspace unless the caller
  // asked for a fresh one; the scheduler allocates when null.
  const workspaceId = payload?.freshWorkspace ? null : retainableWorkspaceId(aggregate);
  const run = {
    id: `run_${randomUUID()}`,
    mode: 'solo',
    status: 'queued',
    phase: null,
    createdAt: now,
    inputs: runInputsSnapshot(aggregate, reqA, planA),
    composition: structuredClone(aggregate.composition),
    // U5: the effective review vocabulary + limits are snapshotted at START
    // together with the inputs/composition — mid-run role or preset edits
    // can never re-scope this run's gate.
    reviewRules: snapshotReviewRules(
      await ctx.getDoc('roles.json'), aggregate.composition?.preset?.limits),
    baseRef,
    baseCommit,
    workspaceId,
    attempts: [],
    result: null,
    events: [],
    eventsCursor: 0,
  };
  aggregate.runs.push(run);
  aggregate.currentRunId = run.id;
  stageRun(aggregate, run, ctx);
  bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      runId: run.id, status: run.status, baseCommit, workspaceId,
      inputs: run.inputs,
    },
  };
}

// F2: `start` with mode 'fusion' builds the panel-snapshot run instead of
// a solo run. The durable reservation gate is identical; input approvals
// are resolved inside buildFusionRun (a document-kind panel pins a task
// version; an implementation-kind panel requires the approved pair).
async function cmdStartFusion(ctx, aggregate, payload, now) {
  if (ctx.features?.fusion !== true) {
    throw new CommandError(501, 'command_unavailable',
      'fusion mode is gated off — enable ACP_EXEC_FUSION');
  }
  if (!isObj(payload?.fusion)) {
    throw new CommandError(422, 'panel_invalid',
      'payload.fusion {resultKind,panelists[...]} is required for mode fusion');
  }
  const liveRes = liveReservations(aggregate);
  if (liveRes.length) {
    throw new CommandError(409, 'run_active',
      `${describeReservation(liveRes)} — stop/resolve it before starting another`);
  }
  const run = await buildFusionRun(FUSION_DEPS, ctx, aggregate, payload, now);
  aggregate.runs.push(run);
  aggregate.currentRunId = run.id;
  stageRun(aggregate, run, ctx);
  bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      runId: run.id, status: run.status, baseCommit: run.baseCommit,
      fingerprint: run.fusion.fingerprint,
      participants: run.fusion.participants.length,
      inputs: run.inputs,
    },
  };
}

// `continue` — a NEW run carrying forward the retained workspace, the
// previous run's result context, and the CURRENTLY approved inputs (the
// approval gates are never bypassed: after change_requirements the card must
// be re-approved first). Admitted only when every prior run AND attempt is
// positively terminal — `run.status` alone never proves its attempts died.
async function cmdContinue(ctx, aggregate, payload, now) {
  const prev = currentRun(aggregate);
  if (!prev) {
    throw new CommandError(422, 'nothing_to_continue',
      'card has no run to continue from');
  }
  // The gate is ATTEMPT-level: every prior attempt across all runs must be
  // positively terminal. A run parked 'active' + awaiting_validation (or
  // awaiting_acceptance) with all-terminal attempts is continuable — the
  // reservation is the live-attempt set, never the run's status label. A run
  // still in-flight ('queued' — launch pending, 'stopping' — halt in flight,
  // or 'active' in an implementable phase where the scheduler may retry) is
  // not safely continuable even with zero live attempts.
  const liveAtt = liveReservations(aggregate).filter((r) => r.attempt);
  if (liveAtt.length) {
    throw new CommandError(409, 'run_active',
      `${describeReservation(liveAtt)} — continue requires every prior attempt positively terminal`);
  }
  const inflight = (aggregate.runs || []).find((r) => r && typeof r === 'object'
    && (r.status === 'queued' || r.status === 'stopping'
      || (r.status === 'active'
        && r.phase !== 'awaiting_validation' && r.phase !== 'awaiting_acceptance')));
  if (inflight) {
    throw new CommandError(409, 'run_active',
      `run ${inflight.id} is ${inflight.status}${inflight.phase ? `/${inflight.phase}` : ''} — continue requires a parked or terminal predecessor`);
  }
  if (prev.mode === 'fusion') {
    // F2: a fusion continuation mints a NEW panel run — same participant
    // composition, re-resolved inputs/snapshot, R9 answer reuse only when
    // the fingerprint matches. A 'blocked' fusion run is terminal here, so
    // it passed the gates above.
    if (ctx.features?.fusion !== true) {
      throw new CommandError(501, 'command_unavailable',
        'fusion mode is gated off — enable ACP_EXEC_FUSION');
    }
    const fusionRun = await buildFusionContinuation(
      FUSION_DEPS, ctx, aggregate, payload, prev, now);
    aggregate.runs.push(fusionRun);
    aggregate.currentRunId = fusionRun.id;
    stageRun(aggregate, fusionRun, ctx);
    bumpControl(aggregate, now);
    return {
      aggregate,
      refreshProjection: true,
      result: {
        runId: fusionRun.id, status: fusionRun.status,
        continuedFrom: prev.id, fingerprint: fusionRun.fusion.fingerprint,
        inputReused: fusionRun.fusion.inputReused,
        inputs: fusionRun.inputs,
      },
    };
  }
  const { reqA, planA } = await requireApprovedInputs(ctx, aggregate, 'continue');
  const note = typeof payload?.note === 'string' && payload.note.trim()
    ? payload.note.slice(0, 2000) : null;
  const run = {
    id: `run_${randomUUID()}`,
    mode: 'solo',
    status: 'queued',
    phase: null,
    createdAt: now,
    inputs: runInputsSnapshot(aggregate, reqA, planA),
    composition: structuredClone(aggregate.composition),
    // The continuation keeps the ORIGINAL base — the retained workspace's
    // HEAD already carries prior commits; HEAD/base consistency is the
    // scheduler's ready-check concern, never a reset/stash.
    baseRef: prev.baseRef ?? 'HEAD',
    baseCommit: prev.baseCommit ?? null,
    workspaceId: retainableWorkspaceId(aggregate),
    continuation: {
      fromRunId: prev.id,
      fromStatus: prev.status,
      fromFinishedAt: prev.finishedAt ?? null,
      fromError: prev.error ?? null,
      fromResult: prev.result ?? null,
      priorAttempts: (prev.attempts || []).map((a) => ({
        id: a.id, role: a.role, n: a.n, outcome: a.status,
        error: a.error ?? null, finishedAt: a.finishedAt ?? null,
      })),
      priorArtifacts: Object.entries(prev.artifacts || {}).map(([id, a]) => ({
        id, kind: a?.kind ?? null, file: a?.file ?? null,
        stored: a?.stored ?? null, sha256: a?.sha256 ?? null,
      })),
      // U4: no review-finding mechanism exists yet — open findings carry the
      // run's durable diagnostic + attempt errors so the prompt preserves
      // everything known; U5 feeds real findings here.
      openFindings: [prev.diagnostic].filter(Boolean).map((d) => ({
        type: d.type ?? null, code: d.code ?? null, at: d.at ?? null,
        detail: typeof d.detail === 'string' ? d.detail.slice(0, 500) : null,
      })),
      userNote: note,
    },
    attempts: [],
    result: null,
    events: [],
    eventsCursor: 0,
  };
  aggregate.runs.push(run);
  aggregate.currentRunId = run.id;
  stageRun(aggregate, run, ctx);
  bumpControl(aggregate, now);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      runId: run.id, status: run.status, continuedFrom: prev.id,
      workspaceId: run.workspaceId, inputs: run.inputs,
    },
  };
}

// --- managed run: internal commands ------------------------------------------------
//
// Every internal handler is reached only via the authenticated channel and
// moves internalRevision (never controlRevision). Ownership rules are
// enforced HERE, inside the serialized queue — a scheduler's intention alone
// is never authority.

function reqStr(v, tag) {
  if (typeof v !== 'string' || !v.length) {
    throw new CommandError(422, 'invalid_argument', `payload.${tag} must be a non-empty string`);
  }
  return v;
}

function clampLeaseMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60_000;
  return Math.min(600_000, Math.max(5_000, Math.floor(n)));
}

function findAttempt(run, attemptId) {
  return (run?.attempts || []).find((a) => a && a.id === attemptId) ?? null;
}

function newOwner(payload, now, leaseMs, adoptedFrom = null) {
  // runnerId is the configured DISPLAY id (compose RUNNER_ID is fixed);
  // instanceId is the unique per-process-start identity — two Node
  // instances sharing a runnerId are still distinct owners.
  const runnerId = reqStr(payload.runnerId, 'runnerId');
  const instanceId = reqStr(payload.instanceId, 'instanceId');
  const pid = Number(payload.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new CommandError(422, 'invalid_argument',
      'payload.pid must be a positive integer (launcher/owner identity)');
  }
  return {
    runnerId,
    instanceId,
    pid,
    pidStarttime: typeof payload.pidStarttime === 'string' ? payload.pidStarttime : null,
    envKey: normalizeEnvKey(payload.envKey),
    // Per-container-instance identity (see envInstance docs): stable across a
    // same-container Node restart, changed by a container recreate. Never by
    // itself proof of the predecessor's death — the retirement record is.
    envInstance: normalizeEnvInstance(payload.envInstance),
    envSlot: typeof payload.envSlot === 'string' && SAFE_ID_RE.test(payload.envSlot)
      ? payload.envSlot : null,
    envGeneration: Number.isInteger(payload.envGeneration) && payload.envGeneration >= 1
      ? payload.envGeneration : null,
    claimedAt: now,
    ...(leaseMs > 0 ? { leaseUntil: now + leaseMs } : {}),
    ...(adoptedFrom ? { adoptedFrom, adoptedAt: now } : {}),
  };
}

// Is this caller the attempt/workspace owner? Both the configured runnerId
// AND the per-instance identity must match — a second process that merely
// shares RUNNER_ID is a foreign owner and needs adoption proof.
function ownsResource(owner, payload) {
  if (!owner) return false;
  const runnerId = typeof payload.runnerId === 'string' ? payload.runnerId : null;
  const instanceId = typeof payload.instanceId === 'string' ? payload.instanceId : null;
  return owner.runnerId === runnerId && owner.instanceId === instanceId;
}

// Structured adoption proof, validated server-side against the recorded
// owner identity. The state server cannot probe pids in the owner's
// namespace — what it CAN verify is that the caller attests a coherent,
// terminally-classified observation OF THE RECORDED IDENTITY, made in the
// original environment. The finding values that pass are only the ones a
// same-namespace probe yields for a genuinely gone process.
//
//   process_dead:
//     caller envKey === owner envKey (same ns/uid/host/boot — required);
//     proof.pid === owner.pid AND proof.starttime === owner.pidStarttime
//       (the caller names the exact recorded identity, not just the number);
//     proof.finding in:
//       'absent'   — /proc probe ENOENT: pid is gone;
//       'zombie'   — /proc shows state Z: defunct;
//       'recycled' — pid exists but starttime differs: identity replaced
//                    (proof.observedStarttime must differ, non-null);
//     findings 'alive'|'unknown'|'foreign' or a missing/unreadable probe
//     never authorize adoption.
//   environment_lost:
//     owner.envKey.bootId and caller bootId differ — a reboot proves the
//     owning environment cannot still exist.
function checkAdoptionProof(record, payload, envs) {
  const proof = isObj(payload.proof) ? payload.proof : null;
  const callerEnv = normalizeEnvKey(payload.envKey);
  const owner = record.owner;
  if (proof?.kind === 'process_dead') {
    if (!owner || !envKeyEqual(callerEnv, owner.envKey)) {
      throw new CommandError(409, 'ownership_unproven',
        'process_dead proof requires the caller\u2019s envKey to equal the owner\u2019s envKey');
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
      throw new CommandError(409, 'ownership_unproven',
        'owner record carries no pid — death cannot be proven');
    }
    if (proof.pid !== owner.pid) {
      throw new CommandError(409, 'ownership_unproven',
        'proof.pid does not match the recorded owner pid');
    }
    if (!owner.pidStarttime || proof.starttime !== owner.pidStarttime) {
      throw new CommandError(409, 'ownership_unproven',
        'proof.starttime does not match the recorded owner starttime — '
        + 'the probed identity is not the recorded owner');
    }
    if (proof.pidNs && owner.envKey?.pidNs && proof.pidNs !== owner.envKey.pidNs) {
      throw new CommandError(409, 'ownership_unproven',
        'proof was taken in a different pid namespace than the owner');
    }
    const finding = proof.finding;
    if (finding === 'recycled') {
      if (typeof proof.observedStarttime !== 'string' || !proof.observedStarttime
        || proof.observedStarttime === owner.pidStarttime) {
        throw new CommandError(409, 'ownership_unproven',
          'a recycled finding must carry an observedStarttime different from the owner\u2019s');
      }
    } else if (finding !== 'absent' && finding !== 'zombie') {
      throw new CommandError(409, 'ownership_unproven',
        `finding ${JSON.stringify(finding)} is not termination evidence `
        + '(accepted: absent, zombie, recycled-with-different-starttime)');
    }
    return;
  }
  if (proof?.kind === 'environment_lost') {
    if (!envLostProof(owner?.envKey, callerEnv)) {
      throw new CommandError(409, 'ownership_unproven',
        'bootId does not differ — the owning environment is not proven gone');
    }
    return;
  }
  if (proof?.kind === 'environment_retired') {
    // Positive RECORDED evidence only: an ops-verified retirement record for
    // the owner's exact envInstance must exist in the durable ledger. The
    // caller's own slot registration is never evidence — two live containers
    // may register the same slot concurrently.
    const ownerInst = owner?.envInstance ?? null;
    if (!ownerInst?.containerId || !ownerInst?.initStarttime) {
      throw new CommandError(409, 'ownership_unproven',
        'owner carries no envInstance — environment retirement cannot be bound to it');
    }
    const callerInst = normalizeEnvInstance(payload.envInstance);
    if (envInstanceEqual(callerInst, ownerInst)) {
      throw new CommandError(409, 'ownership_unproven',
        'the caller IS the recorded envInstance — a retired environment cannot adopt');
    }
    const list = Array.isArray(envs?.retirements) ? envs.retirements : [];
    const ownerSlot = typeof owner?.envSlot === 'string' ? owner.envSlot : null;
    // The record must bind the owner's exact envInstance AND the generation
    // the owner registered under — a stale record for a prior same-name
    // container instance can never retire this one.
    const rec = list.find((r) => r && envInstanceEqual(r.envInstance, ownerInst)
      && (ownerSlot === null || r.slot === ownerSlot)
      && (owner?.envGeneration == null || r.generation === owner.envGeneration));
    if (!rec) {
      throw new CommandError(409, 'ownership_unproven',
        'no verified retirement record for the recorded owner environment — '
        + 'the exact container must be retired through the ops path first');
    }
    return;
  }
  throw new CommandError(409, 'ownership_unproven',
    'adoption requires proof {kind: process_dead|environment_lost|environment_retired}');
}

// Heartbeat: renews the caller's ownership lease on each listed attempt.
// Only the recorded owner instance may renew — a heartbeat is proof of
// life only for that instance, never for a same-runnerId foreign process.
async function cmdHeartbeat(ctx, aggregate, payload, now) {
  reqStr(payload.runnerId, 'runnerId');
  reqStr(payload.instanceId, 'instanceId');
  const leaseMs = clampLeaseMs(payload.leaseMs);
  const list = Array.isArray(payload.attempts) ? payload.attempts : null;
  const vList = Array.isArray(payload.validations) ? payload.validations : null;
  const renewed = [];
  if (list) {
    // Validate ALL first — a partial renewal that secretly touched a foreign
    // attempt must not be possible.
    const targets = [];
    for (const t of list) {
      const run = runOf(aggregate, t?.runId);
      const att = findAttempt(run, t?.attemptId);
      if (!run || !att) {
        throw new CommandError(404, 'attempt_not_found',
          `heartbeat for unknown attempt ${JSON.stringify(t?.attemptId)}`);
      }
      if (!ATTEMPT_NONTERMINAL.has(att.status)) {
        throw new CommandError(409, 'attempt_terminal',
          `attempt ${att.id} is ${att.status} — cannot heartbeat a terminal attempt`);
      }
      if (!ownsResource(att.owner, payload)) {
        throw new CommandError(409, 'not_attempt_owner',
          `attempt ${att.id} is owned by another runner instance`);
      }
      targets.push(att);
    }
    for (const att of targets) {
      att.owner.leaseUntil = now + leaseMs;
      renewed.push(att.id);
    }
  }
  if (vList) {
    const targets = [];
    for (const t of vList) {
      const run = runOf(aggregate, t?.runId);
      const val = run?.validation;
      if (!run || !val || val.id !== t?.validationId) {
        throw new CommandError(404, 'validation_not_found',
          `heartbeat for unknown validation ${JSON.stringify(t?.validationId)}`);
      }
      if (val.status !== 'active' && val.status !== 'unproven') {
        throw new CommandError(409, 'validation_terminal',
          `validation ${val.id} is ${val.status} — cannot heartbeat a closed validation`);
      }
      if (!ownsResource(val.owner, payload)) {
        throw new CommandError(409, 'not_validation_owner',
          `validation ${val.id} is owned by another runner instance`);
      }
      targets.push(val);
    }
    for (const val of targets) {
      val.owner.leaseUntil = now + leaseMs;
      renewed.push(val.id);
    }
  }
  return { aggregate, result: { ok: true, renewed, leaseUntil: now + leaseMs } };
}

// --- workspace lifecycle -----------------------------------------------------

async function cmdBeginWorkspace(ctx, aggregate, payload, now, cardId) {
  const wsId = reqStr(payload.workspaceId, 'workspaceId');
  if (!WS_ID_RE.test(wsId)) {
    throw new CommandError(422, 'invalid_argument',
      `workspaceId must match ${WS_ID_RE}`);
  }
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (!RUN_NONTERMINAL.has(run.status)) {
    throw new CommandError(409, 'run_terminal', `run ${run.id} is ${run.status}`);
  }
  const branch = reqStr(payload.branch, 'branch');
  const expected = workspaceBranch(cardId, wsId);
  if (branch !== expected) {
    throw new CommandError(422, 'branch_invalid',
      `workspace branch must be ${expected}`);
  }
  const baseCommit = reqStr(payload.baseCommit, 'baseCommit');
  if (!SHA40_RE.test(baseCommit) || baseCommit !== run.baseCommit) {
    throw new CommandError(422, 'base_commit_mismatch',
      'workspace baseCommit must equal the run\u2019s recorded baseCommit');
  }
  // The reported path is validated against the configured workspace root:
  // only the canonical <root>/<projectKey>/<cardId>--<wsId> shape is legal,
  // so a caller cannot register an arbitrary filesystem path as a workspace.
  const root = await ctx.workspaceRoot();
  const wantPath = workspacePath(root, projectKeyFor(aggregate.projectPath), cardId, wsId);
  const gotPath = normPath(reqStr(payload.path, 'path'));
  if (gotPath !== wantPath) {
    throw new CommandError(422, 'workspace_path_invalid',
      `workspace path must be ${wantPath}`, { expected: wantPath });
  }
  aggregate.workspaces ??= {};
  const existing = aggregate.workspaces[wsId];
  if (existing) {
    const sameCoords = existing.path === gotPath && existing.branch === branch
      && existing.baseCommit === baseCommit;
    if (sameCoords && existing.runId !== run.id) {
      // Identical reservation bound to a different (by construction terminal
      // — one live run per card) predecessor run: adoptable via
      // adopt_workspace, which rebinds runId only when legal.
      throw new CommandError(409, 'workspace_foreign',
        `workspace ${wsId} is bound to run ${existing.runId} — adopt_workspace may rebind it`,
        { status: existing.status, runId: existing.runId });
    }
    if (sameCoords) {
      // Idempotent replay returns the reservation ONLY to its owner
      // instance. A foreign caller (even same runnerId/env) must not get a
      // reservation it could allocate filesystem under — adopt it first.
      if (!ownsResource(existing.owner, payload)) {
        throw new CommandError(409, 'workspace_foreign',
          `workspace ${wsId} is reserved by another instance — adopt_workspace with proof first`,
          { status: existing.status });
      }
      return { aggregate, result: { workspace: existing, idempotent: true } };
    }
    throw new CommandError(409, 'workspace_conflict',
      `workspace ${wsId} already exists with different coordinates`);
  }
  // wsIds share the workspace root across cards — reject an id already
  // recorded on another card, else two cards would collide on one path.
  for (const entry of await ctx.listAggregates()) {
    const other = entry && entry.aggregate ? entry.aggregate : entry;
    if (!other || other.cardId === aggregate.cardId) continue;
    if (other.workspaces && other.workspaces[wsId]) {
      throw new CommandError(409, 'workspace_conflict',
        `workspaceId ${wsId} is already recorded on card ${other.cardId}`);
    }
  }
  // First reservation wins: once run.workspaceId is bound, a DIFFERENT wsId
  // is a conflict (two schedulers must not allocate two worktrees for one
  // run); retrying the identical record is idempotent; a failed bound
  // workspace releases the binding so a fresh wsId may be reserved.
  if (run.workspaceId && run.workspaceId !== wsId) {
    const bound = aggregate.workspaces[run.workspaceId];
    if (bound && bound.status !== 'failed') {
      throw new CommandError(409, 'workspace_conflict',
        `run ${run.id} is already bound to workspace ${run.workspaceId} (${bound.status})`);
    }
  }
  const wsRec = {
    id: wsId, path: gotPath, branch, baseCommit,
    projectPath: aggregate.projectPath,
    status: 'creating', createdAt: now, runId: run.id,
    owner: newOwner(payload, now, 0),
  };
  aggregate.workspaces[wsId] = wsRec;
  run.workspaceId = wsId;
  aggregate.workspaceId = wsId;
  stageRun(aggregate, run, ctx);
  return { aggregate, result: { workspace: wsRec } };
}

// Workspace authority is the recorded owner INSTANCE — nothing ambient.
// Same env, same runnerId, or a differing bootId alone never grant
// authority; a non-owner must adopt_workspace with structured proof first
// (the adoption itself is where environment/process verification lives).
function requireWsAuthority(ws, payload) {
  if (!payload.runId || ws.runId !== payload.runId) {
    throw new CommandError(409, 'workspace_conflict',
      `workspace ${ws.id} belongs to run ${ws.runId ?? 'none'}, not ${payload.runId ?? 'none'}`);
  }
  if (!ownsResource(ws.owner, payload)) {
    throw new CommandError(409, 'not_workspace_owner',
      `workspace ${ws.id} is owned by another runner instance — adopt it first`);
  }
}

// Workspace ownership handoff — mirrors adopt_attempt. A non-terminal
// workspace keeps its reservation through adoption: the adopter inherits
// the EXACT worktree record (no second branch/worktree is allocated).
async function cmdAdoptWorkspace(ctx, aggregate, payload, now) {
  const wsId = reqStr(payload.workspaceId, 'workspaceId');
  const ws = aggregate.workspaces?.[wsId];
  if (!ws) throw new CommandError(404, 'workspace_not_found', `workspace ${wsId} unknown`);
  // Rebinding to a different run is legal ONLY when the previously bound
  // run is gone or terminal — at most one live run exists per card, so a
  // live predecessor binding is a hard conflict. Files are preserved; the
  // reservation/branch/path never change.
  const rebind = !!payload.runId && ws.runId !== payload.runId;
  const targetRun = payload.runId ? runOf(aggregate, payload.runId) : null;
  if (rebind) {
    const prev = runOf(aggregate, ws.runId);
    if (prev && RUN_NONTERMINAL.has(prev.status) && !runParked(prev)) {
      throw new CommandError(409, 'workspace_conflict',
        `workspace ${ws.id} belongs to live run ${ws.runId}, not ${payload.runId}`);
    }
    if (targetRun && targetRun.workspaceId && targetRun.workspaceId !== wsId) {
      throw new CommandError(409, 'workspace_conflict',
        `run ${targetRun.id} is already bound to workspace ${targetRun.workspaceId}`);
    }
  } else if (!payload.runId) {
    throw new CommandError(422, 'invalid_argument', 'adopt_workspace requires runId');
  }
  if (ws.status === 'failed') {
    throw new CommandError(409, 'workspace_terminal',
      `workspace ${wsId} is failed — nothing to adopt`);
  }
  const finishRebind = () => {
    if (!rebind) return;
    ws.runId = payload.runId;
    if (targetRun && !targetRun.workspaceId) {
      targetRun.workspaceId = wsId;
      stageRun(aggregate, targetRun, ctx);
    }
  };
  if (ownsResource(ws.owner, payload)) {
    finishRebind();
    return { aggregate, result: { workspaceId: ws.id, adopted: false, renewed: true } };
  }
  checkAdoptionProof(ws, payload,
    ctx.loadEnvironments ? await ctx.loadEnvironments() : null);
  const prev = ws.owner;
  ws.owner = newOwner(payload, now, 0, prev?.runnerId ?? null);
  finishRebind();
  return {
    aggregate,
    result: { workspaceId: ws.id, adopted: true, adoptedFrom: prev?.runnerId ?? null },
  };
}

async function cmdWorkspaceReady(ctx, aggregate, payload, now) {
  const wsId = reqStr(payload.workspaceId, 'workspaceId');
  const ws = aggregate.workspaces?.[wsId];
  if (!ws) throw new CommandError(404, 'workspace_not_found', `workspace ${wsId} unknown`);
  requireWsAuthority(ws, payload);
  const head = reqStr(payload.head, 'head');
  if (!SHA40_RE.test(head) || head !== ws.baseCommit) {
    throw new CommandError(422, 'head_mismatch',
      'workspace head must equal the recorded base commit');
  }
  if (ws.status === 'ready') {
    return { aggregate, result: { workspace: ws, idempotent: true } };
  }
  if (ws.status !== 'creating') {
    throw new CommandError(409, 'workspace_conflict',
      `workspace ${wsId} is ${ws.status} — cannot mark ready`);
  }
  ws.status = 'ready';
  ws.readyAt = now;
  return { aggregate, result: { workspace: ws } };
}

async function cmdWorkspaceFailed(ctx, aggregate, payload, now) {
  const wsId = reqStr(payload.workspaceId, 'workspaceId');
  const ws = aggregate.workspaces?.[wsId];
  if (!ws) throw new CommandError(404, 'workspace_not_found', `workspace ${wsId} unknown`);
  requireWsAuthority(ws, payload);
  if (ws.status === 'ready') {
    throw new CommandError(409, 'workspace_conflict',
      `workspace ${wsId} is already ready — cannot mark failed`);
  }
  ws.status = 'failed';
  ws.failedAt = now;
  ws.error = typeof payload.reason === 'string' ? payload.reason.slice(0, 500) : 'workspace failed';
  return { aggregate, result: { workspace: ws } };
}

// --- attempts -----------------------------------------------------------------

async function cmdBeginAttempt(ctx, aggregate, payload, now, cardId) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (!['queued', 'active'].includes(run.status)) {
    throw new CommandError(409, 'run_not_launchable',
      `run ${run.id} is ${run.status} — attempts start only from queued|active`);
  }
  const attemptId = reqStr(payload.attemptId, 'attemptId');
  if (!SAFE_ID_RE.test(attemptId)) {
    throw new CommandError(422, 'invalid_argument', `attemptId must match ${SAFE_ID_RE}`);
  }
  // Attempt ids are durable public history: reject reuse recorded on ANY
  // run — this card's (including this run) or another card's — a recycled
  // id would corrupt observation/join semantics.
  for (const r of aggregate.runs || []) {
    for (const a of r?.attempts || []) {
      if (a && a.id === attemptId) {
        throw new CommandError(409, 'attempt_exists',
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
          throw new CommandError(409, 'attempt_exists',
            `attemptId ${attemptId} is already recorded on card ${other.cardId} run ${r.id}`);
        }
      }
    }
  }
  const role = reqStr(payload.role, 'role');
  if (!EXEC_ROLES.has(role) || !LAUNCHABLE_ROLES.has(role)) {
    throw new CommandError(422, 'role_unsupported',
      `role ${JSON.stringify(role)} cannot launch`);
  }
  // U5 phase binding: the payload declares the launch's intended phase and
  // the run must be in a state where that role-phase is legal:
  //   implementer: 'implement' for initial work; 'fix' only while a gate
  //     decision left run.fixContext; retries re-enter the same phase.
  //   reviewer:    the active validation must be in 'review' phase.
  //   checker:     the active validation must be in 'check_review' phase.
  const launchPhase = reqStr(payload.phase, 'phase');
  if (!ROLE_PHASES.get(role).has(launchPhase)) {
    throw new CommandError(422, 'phase_mismatch',
      `role ${role} cannot launch phase ${JSON.stringify(launchPhase)}`);
  }
  if (role === 'implementer') {
    const fixing = !!run.fixContext;
    if (launchPhase === 'fix' && !fixing) {
      throw new CommandError(409, 'phase_mismatch',
        'a fix attempt requires a recorded gate fixContext on this run');
    }
    if (launchPhase === 'implement' && fixing) {
      throw new CommandError(409, 'phase_mismatch',
        'run has an open fix context — the next implementer attempt is a fix');
    }
  } else {
    const val = run.validation;
    if (!val || val.status !== 'active' || val.phase !== launchPhase) {
      throw new CommandError(409, 'phase_mismatch',
        `role ${role} requires an active validation in phase ${launchPhase} — got ${
          val ? `${val.status}/${val.phase ?? 'none'}` : 'none'}`);
    }
    const vId = reqStr(payload.validationId, 'validationId');
    if (vId !== val.id) {
      throw new CommandError(409, 'validation_mismatch',
        `attempt validation ${vId} does not match active ${val.id}`);
    }
  }
  const live = liveAttempt(run);
  if (live) {
    throw new CommandError(409, 'attempt_active',
      `attempt ${live.id} is ${live.status} — resolve it before launching another`,
      { attemptId: live.id, status: live.status });
  }
  const used = attemptsUsed(run, role);
  const maxAttempts = Number(run.composition?.preset?.limits?.maxAttemptsPerRole) || 1;
  if (used >= maxAttempts) {
    throw new CommandError(409, 'attempts_exhausted',
      `role ${role} already used ${used}/${maxAttempts} attempts on run ${run.id}`,
      { role, used, limit: maxAttempts });
  }
  // Global + role slot accounting across ALL aggregates inside this
  // serialized queue — the authoritative reservation two runners cannot race.
  const limits = await ctx.loadSchedulerLimits();
  let globalActive = 0;
  let roleActive = 0;
  for (const agg of await ctx.listAggregates()) {
    for (const r of agg.runs || []) {
      // NO run-status shortcut: a terminal run can still hold live attempts
      // or a live/unproven validation — its reservation releases only after
      // positive proof, never because the run row says 'failed'.
      let runActive = false;
      for (const a of r?.attempts || []) {
        if (a && ATTEMPT_NONTERMINAL.has(a.status)) {
          runActive = true;
          if (a.role === role) roleActive += 1;
        }
      }
      const v = r?.validation;
      if (v && (v.status === 'active' || v.status === 'unproven')) {
        runActive = true;
      }
      // Union-per-run: a live attempt plus a live validation on the same
      // run is ONE reservation unit — the role attempt takes over the
      // unit its validation already holds.
      if (runActive) globalActive += 1;
    }
  }
  // An attempt launched inside an active validation (reviewer/checker)
  // inherits the unit that validation already holds — it is not a second
  // reservation and must not deadlock a global=1 deployment.
  const ownUnit = (run.validation
    && (run.validation.status === 'active' || run.validation.status === 'unproven')) ? 1 : 0;
  if (globalActive - ownUnit >= limits.global) {
    throw new CommandError(409, 'limit_reached',
      `global attempt limit reached (${globalActive}/${limits.global})`,
      { scope: 'global', active: globalActive, limit: limits.global });
  }
  const roleCap = limits.roles?.[role] ?? 1;
  if (roleActive >= roleCap) {
    throw new CommandError(409, 'limit_reached',
      `role ${role} attempt limit reached (${roleActive}/${roleCap})`,
      { scope: 'role', role, active: roleActive, limit: roleCap });
  }
  const leaseMs = clampLeaseMs(payload.leaseMs);
  const launch = payload.launch;
  if (!isObj(launch)) {
    throw new CommandError(422, 'invalid_argument', 'payload.launch must be an object');
  }
  for (const [k, re] of [['profileId', SAFE_ID_RE]]) {
    if (typeof launch[k] !== 'string' || !re.test(launch[k])) {
      throw new CommandError(422, 'invalid_argument', `launch.${k} must match ${re}`);
    }
  }
  for (const k of ['cwd', 'artifactsDir', 'attemptDir']) {
    if (typeof launch[k] !== 'string' || !launch[k].startsWith('/')) {
      throw new CommandError(422, 'invalid_argument', `launch.${k} must be an absolute path`);
    }
    launch[k] = normPath(launch[k]);
  }
  for (const k of ['promptSha256', 'configSha256']) {
    if (typeof launch[k] !== 'string' || !SHA256_RE.test(launch[k])) {
      throw new CommandError(422, 'invalid_argument', `launch.${k} must be a sha256 hex`);
    }
  }
  // The attempt's cwd must be the READY workspace bound to this run — no
  // bound workspace, a non-ready record, a foreign run's workspace, or a
  // cwd that isn't the canonical recorded path all refuse the launch.
  const ws = aggregate.workspaces?.[run.workspaceId];
  if (!ws || ws.status !== 'ready') {
    throw new CommandError(422, 'workspace_not_ready',
      `run ${run.id} has no ready workspace bound — launch refused`);
  }
  if (ws.runId !== run.id) {
    throw new CommandError(409, 'workspace_conflict',
      `workspace ${ws.id} belongs to run ${ws.runId ?? 'none'}, not ${run.id}`);
  }
  // cwd must be the PROVABLE location for the role: implementer/fix work in
  // the canonical workspace; reviewer/checker work in the recorded pristine
  // copies under <wsRoot>/.validation/<run>/<val>/ — nothing else is legal.
  if (role === 'implementer') {
    if (launch.cwd !== ws.path) {
      throw new CommandError(422, 'launch_mismatch',
        `launch.cwd ${launch.cwd} is not the recorded workspace ${ws.path}`);
    }
  } else {
    const root = await ctx.workspaceRoot();
    const expected = role === 'reviewer'
      ? run.validation.dirs.review : run.validation.dirs.check;
    assertValidationDirs(run.validation.dirs, root, run.id, run.validation.id);
    if (launch.cwd !== expected) {
      throw new CommandError(422, 'launch_mismatch',
        `launch.cwd ${launch.cwd} is not the recorded ${role} copy ${expected}`);
    }
  }
  const owner = newOwner(payload, now, leaseMs);
  const attempt = {
    id: attemptId,
    runId: run.id,
    role,
    phase: launchPhase,
    ...(role !== 'implementer' ? { validationId: run.validation.id, round: run.round ?? 1 } : {}),
    n: used + 1,
    status: 'launching',
    owner,
    launch,
    porchRunId: null,
    workspaceId: run.workspaceId,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    outcome: null,
    error: null,
  };
  run.attempts.push(attempt);
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: {
      attemptId, runId: run.id, status: attempt.status,
      slots: {
        global: { active: globalActive + 1, limit: limits.global },
        role: { role, active: roleActive + 1, limit: roleCap },
      },
    },
  };
}

async function cmdBindAttempt(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const att = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
  if (!att) throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
  if (!ownsResource(att.owner, payload)) {
    throw new CommandError(409, 'not_attempt_owner',
      `attempt ${att.id} is owned by another runner instance`);
  }
  const porchRunId = reqStr(payload.porchRunId, 'porchRunId');
  if (!RUN_ID_RE.test(porchRunId)) {
    throw new CommandError(422, 'invalid_argument', `porchRunId must match ${RUN_ID_RE}`);
  }
  if (att.status === 'running' || att.status === 'cancelling') {
    if (att.porchRunId === porchRunId) {
      return { aggregate, result: { attemptId: att.id, status: att.status, idempotent: true } };
    }
    throw new CommandError(409, 'attempt_conflict',
      `attempt ${att.id} is already bound to ${att.porchRunId}`);
  }
  if (att.status !== 'launching') {
    throw new CommandError(409, 'attempt_terminal',
      `attempt ${att.id} is ${att.status} — cannot bind`);
  }
  att.porchRunId = porchRunId;
  att.startedAt = now;
  // A bind that lands while a stop/cancel intent is durable must NOT flip
  // the attempt to 'running' — it lands directly in 'cancelling' so the
  // cancel duty is preserved atomically (a late-bound supervisor is then
  // cancelled by id, never left running silently).
  if (run.status === 'stopping' || att.cancel) {
    att.status = 'cancelling';
    att.cancel ??= { requestedAt: now, by: 'stop_intent', reason: 'stop intent predated bind' };
  } else {
    att.status = 'running';
    run.status = 'active';
    // Fusion attempts never move run.phase on bind — the fusion commands
    // (panel_settle / routeWorkOrder / record_integrate_result / gate) own
    // it. A fix integrator binds while the run sits at
    // 'awaiting_validation'; writing att.phase ('integrate') here would
    // strand the import step in a phase_mismatch loop.
    if (att.role !== 'panelist' && att.role !== 'judge' && att.role !== 'integrator') {
      run.phase = att.phase ?? 'implement';
    }
  }
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: { attemptId: att.id, status: att.status, runId: run.id, runStatus: run.status },
  };
}

// Cancel intent on a LIVE attempt. Cancellation is BY RUN IDENTITY ONLY —
// the payload never carries a pid to signal; the runtime resolves the
// supervisor from the recorded porchRunId/reconcile selectors. The attempt
// moves to 'cancelling' and keeps its workspace+slot until a positive
// terminal observation resolves it.
async function cmdCancelAttempt(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const att = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
  if (!att) throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
  if (!ownsResource(att.owner, payload)) {
    throw new CommandError(409, 'not_attempt_owner',
      `attempt ${att.id} is owned by another runner instance`);
  }
  // A late-registered supervisor discovered during reconcile may be bound
  // here so the cancel duty targets the exact run id — it is never accepted
  // as a second launch.
  if (payload.porchRunId !== undefined) {
    const pr = reqStr(payload.porchRunId, 'porchRunId');
    if (!RUN_ID_RE.test(pr)) {
      throw new CommandError(422, 'invalid_argument', `porchRunId must match ${RUN_ID_RE}`);
    }
    if (att.porchRunId && att.porchRunId !== pr) {
      throw new CommandError(409, 'attempt_conflict',
        `attempt ${att.id} is already bound to ${att.porchRunId}`);
    }
    att.porchRunId = pr;
  }
  if (!ATTEMPT_NONTERMINAL.has(att.status)) {
    if (att.status === 'cancelled') {
      return { aggregate, result: { attemptId: att.id, status: 'cancelled', idempotent: true } };
    }
    throw new CommandError(409, 'attempt_terminal',
      `attempt ${att.id} is already ${att.status}`);
  }
  att.cancel = {
    requestedAt: att.cancel?.requestedAt ?? now,
    by: `${payload.runnerId}:${payload.instanceId}`,
    reason: typeof payload.reason === 'string'
      ? payload.reason.slice(0, 500)
      : (att.cancel?.reason ?? 'cancel requested'),
    // The scheduler sets dispatched once the runtime actually accepted the
    // cancel — a dispatched marker is bookkeeping, never terminal evidence.
    dispatched: payload.dispatched === true || att.cancel?.dispatched === true,
  };
  att.status = 'cancelling';
  stageRun(aggregate, run, ctx);
  return { aggregate, result: { attemptId: att.id, status: 'cancelling' } };
}

// Observation write — ONE durable command carries the porch event batch AND
// the cursor/observer state, so they commit or fall together; a replayed
// batch dedups on the recorded source index (src.i). Also captures the
// supervisor's process identity — bound to the attempt's proven launch
// selectors so a caller can never point it at an unrelated cwd/artifactsDir.
const OBSERVER_NUM_FIELDS = [
  'cursor', 'mirrorCursor', 'lastProgressAt', 'idleWarnedAt',
  'stuckSince', 'lastStatusAt', 'lastCancelNoteAt',
];
const OBSERVER_STR_FIELDS = ['lastStatus', 'lastError', 'lastSyscall'];

async function cmdObserveAttempt(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const att = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
  if (!att) throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
  if (!ownsResource(att.owner, payload)) {
    throw new CommandError(409, 'not_attempt_owner',
      `attempt ${att.id} is owned by another runner instance`);
  }
  const o = isObj(payload.observer) ? payload.observer : {};
  const obs = att.observer ??= {};
  if (o.mirrorReset === true) obs.mirrorCursor = 0;
  for (const k of OBSERVER_NUM_FIELDS) {
    if (o[k] !== undefined) {
      // stuckSince supports an explicit null RESET — movement re-arms the
      // stuck window; Math.max could never clear it.
      if (k === 'stuckSince' && o[k] === null) { obs.stuckSince = 0; continue; }
      const n = Number(o[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1e15) {
        throw new CommandError(422, 'invalid_argument', `observer.${k} must be a finite number >= 0`);
      }
      obs[k] = Math.max(Number(obs[k]) || 0, n);
    }
  }
  for (const k of OBSERVER_STR_FIELDS) {
    if (o[k] !== undefined) {
      if (o[k] !== null && typeof o[k] !== 'string') {
        throw new CommandError(422, 'invalid_argument', `observer.${k} must be a string or null`);
      }
      obs[k] = typeof o[k] === 'string' ? o[k].slice(0, 200) : null;
    }
  }
  if (o.probe !== undefined) {
    if (!isObj(o.probe)) {
      throw new CommandError(422, 'invalid_argument', 'observer.probe must be an object');
    }
    // null is the UNREADABLE marker — it must survive. Coercing it to 0
    // would make an unverifiable probe look like "zero IO/CPU", which is
    // exactly the false stuck-detection signal the AGENTS rule forbids.
    for (const k of ['at', 'ioSum', 'cpuSum', 'eventCursor', 'sessionBytes']) {
      if (o.probe[k] !== undefined && o.probe[k] !== null) {
        const n = Number(o.probe[k]);
        if (!Number.isFinite(n) || n < 0) {
          throw new CommandError(422, 'invalid_argument', `observer.probe.${k} must be >= 0 or null`);
        }
      }
    }
    obs.probe = {
      at: o.probe.at === null ? null : Number(o.probe.at) || 0,
      ioSum: o.probe.ioSum === null ? null : Number(o.probe.ioSum) || 0,
      cpuSum: o.probe.cpuSum === null ? null : Number(o.probe.cpuSum) || 0,
      eventCursor: o.probe.eventCursor === null ? null : Number(o.probe.eventCursor) || 0,
      sessionBytes: o.probe.sessionBytes === null || o.probe.sessionBytes === undefined
        ? null : Number(o.probe.sessionBytes) || 0,
      syscall: typeof o.probe.syscall === 'string' ? o.probe.syscall.slice(0, 64) : null,
    };
  }
  if (payload.supervisor !== undefined) {
    if (!isObj(payload.supervisor)) {
      throw new CommandError(422, 'invalid_argument', 'supervisor must be an object');
    }
    const s = payload.supervisor;
    const sup = att.supervisor ??= {};
    if (s.cwd !== undefined) {
      const cwd = normPath(reqStr(s.cwd, 'supervisor.cwd'));
      if (att.launch?.cwd && cwd !== att.launch.cwd) {
        throw new CommandError(422, 'supervisor_mismatch',
          `supervisor.cwd ${cwd} is not the recorded launch cwd ${att.launch.cwd}`);
      }
      sup.cwd = cwd;
    }
    if (s.artifactsDir !== undefined) {
      const dir = normPath(reqStr(s.artifactsDir, 'supervisor.artifactsDir'));
      if (att.launch?.artifactsDir && dir !== att.launch.artifactsDir) {
        throw new CommandError(422, 'supervisor_mismatch',
          `supervisor.artifactsDir ${dir} is not the recorded launch artifactsDir`);
      }
      sup.artifactsDir = dir;
    }
    if (s.pid !== undefined) {
      if (!Number.isInteger(s.pid) || s.pid <= 0) {
        throw new CommandError(422, 'invalid_argument', 'supervisor.pid must be a positive integer');
      }
      sup.pid = s.pid;
    }
    if (s.childPid !== undefined) {
      if (s.childPid !== null && !(Number.isInteger(s.childPid) && s.childPid > 0)) {
        throw new CommandError(422, 'invalid_argument', 'supervisor.childPid must be a positive integer or null');
      }
      sup.childPid = s.childPid;
    }
    // A child pid is only probeable when its full identity is recorded —
    // starttime+namespace let the caller verify the pid was not recycled;
    // a bare number could point at an unrelated live process.
    for (const k of ['starttime', 'pidNs', 'state', 'backend', 'childStarttime', 'childPidNs']) {
      if (s[k] !== undefined) {
        sup[k] = (typeof s[k] === 'string' && s[k].length <= 128) ? s[k] : null;
      }
    }
    // childNone is a positive, immutable no-child attestation — persisted
    // only as an explicit boolean. A serialized null childPid alone is
    // NEVER no-child proof; only this flag may carry that attestation.
    if (s.childNone !== undefined) {
      sup.childNone = s.childNone === true;
    }
    sup.seenAt = now;
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (events.length > 200) {
    throw new CommandError(422, 'invalid_argument', 'events batch is limited to 200 entries');
  }
  let appended = 0;
  let skipped = 0;
  run.events = Array.isArray(run.events) ? run.events : [];
  run.eventsCursor = run.eventsCursor ?? 0;
  for (const e of events) {
    if (!isObj(e)) {
      throw new CommandError(422, 'invalid_argument', 'each event must be an object');
    }
    const type = reqStr(e.type, 'event.type');
    if (!EVENT_TYPE_RE.test(type)) {
      throw new CommandError(422, 'invalid_argument', `event type must match ${EVENT_TYPE_RE}`);
    }
    const bytes = Buffer.byteLength(JSON.stringify(e.data ?? null), 'utf8');
    if (bytes > EVENT_MAX_BYTES) {
      throw new CommandError(413, 'event_too_large', `event data exceeds ${EVENT_MAX_BYTES} bytes`);
    }
    const srcI = e.src?.i;
    if (srcI !== undefined && !(Number.isInteger(srcI) && srcI >= 0)) {
      throw new CommandError(422, 'invalid_argument', 'event.src.i must be an integer >= 0');
    }
    if (Number.isInteger(srcI) && srcI < (obs.mirrorCursor || 0)) {
      skipped += 1;
      continue;
    }
    const ev = { seq: run.eventsCursor, at: now, type, data: e.data ?? null, attemptId: att.id };
    run.eventsCursor += 1;
    if (Number.isInteger(srcI)) {
      ev.src = { i: srcI };
      obs.mirrorCursor = Math.max(Number(obs.mirrorCursor) || 0, srcI + 1);
    }
    run.events.push(ev);
    appended += 1;
    if (DIAG_EVENT_TYPES.has(type)) applyDiag(run, type, e.data, att.id, now);
  }
  if (appended) ctx.appendRunEvent(run.id, run.events);
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: { attemptId: att.id, appended, skipped, mirrorCursor: obs.mirrorCursor ?? 0 },
  };
}

function applyDiag(run, type, data, attemptId, now) {
  const d = data && typeof data === 'object' ? data : {};
  run.diagnostic = {
    type, at: now,
    attemptId: attemptId ?? d.attemptId ?? null,
    code: typeof d.code === 'string' ? d.code.slice(0, 128) : null,
    detail: typeof d.detail === 'string' ? d.detail.slice(0, 500)
      : (d && typeof d === 'object' ? d : null),
  };
}

// Ownership handoff. A foreign runner may adopt a non-terminal attempt only
// with positive proof — and adoption NEVER makes the attempt terminal or
// frees its slot: the adopter inherits the duty to reconcile/observe it.
//   process_dead:     same envKey as the owner + the owner's recorded pid is
//                     what the caller probed (a same-env runner's /proc check
//                     is meaningful; the server can verify env equality, the
//                     caller attests the pid finding).
//   environment_lost: the recorded owner env's bootId differs from the
//                     caller's — a reboot proves the old env cannot exist.
// Anything else — different envKey, missing owner pid, lease expiry alone —
// is 409 ownership_unproven.
async function cmdAdoptAttempt(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const att = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
  if (!att) throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
  if (!ATTEMPT_NONTERMINAL.has(att.status)) {
    throw new CommandError(409, 'attempt_terminal',
      `attempt ${att.id} is ${att.status} — nothing to adopt`);
  }
  const runnerId = reqStr(payload.runnerId, 'runnerId');
  const leaseMs = clampLeaseMs(payload.leaseMs);
  // Same instance re-asserts (lease renew); ANY other caller — including a
  // process sharing the configured runnerId — must carry positive proof.
  if (ownsResource(att.owner, payload)) {
    att.owner.leaseUntil = now + leaseMs;
    stageRun(aggregate, run, ctx);
    return { aggregate, result: { attemptId: att.id, adopted: false, renewed: true } };
  }
  checkAdoptionProof(att, payload,
    ctx.loadEnvironments ? await ctx.loadEnvironments() : null);
  const owner = att.owner;
  att.owner = newOwner(payload, now, leaseMs, owner?.runnerId ?? null);
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: { attemptId: att.id, adopted: true, status: att.status, adoptedFrom: owner?.runnerId ?? null },
  };
}

// Bounded result descriptor — the full agent output lives in an artifact
// file, never inline in the aggregate (and never any secret material).
function validateAttemptResult(raw) {
  if (!isObj(raw)) {
    throw new CommandError(422, 'invalid_argument', 'result must be an object');
  }
  const out = {};
  if (raw.status !== undefined) {
    out.status = reqStr(raw.status, 'result.status').slice(0, 64);
  }
  if (raw.exitCode !== undefined) {
    if (raw.exitCode !== null && !Number.isInteger(raw.exitCode)) {
      throw new CommandError(422, 'invalid_argument', 'result.exitCode must be an integer or null');
    }
    out.exitCode = raw.exitCode;
  }
  if (raw.finalArtifactId !== undefined) {
    if (raw.finalArtifactId !== null
      && (typeof raw.finalArtifactId !== 'string' || !SAFE_ID_RE.test(raw.finalArtifactId))) {
      throw new CommandError(422, 'invalid_argument', 'result.finalArtifactId must be a safe id or null');
    }
    out.finalArtifactId = raw.finalArtifactId;
  }
  if (raw.durationS !== undefined) {
    const n = Number(raw.durationS);
    out.durationS = Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (raw.summary !== undefined) {
    out.summary = typeof raw.summary === 'string' ? raw.summary.slice(0, 2000) : null;
  }
  return out;
}

// Artifact METADATA merge — the file itself was already written under
// artifacts/<runId>/ by the runner over the shared state mount; the domain
// records only safe names/hashes (the artifact route resolves inside the
// run dir; a path can never be smuggled in).
function validateArtifacts(raw, attemptId) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32) {
    throw new CommandError(422, 'invalid_argument', 'artifacts must be an array of <= 32 entries');
  }
  return raw.map((a) => {
    if (!isObj(a)) {
      throw new CommandError(422, 'invalid_argument', 'artifact entries must be objects');
    }
    const id = reqStr(a.id, 'artifacts[].id');
    if (!SAFE_ID_RE.test(id)) {
      throw new CommandError(422, 'invalid_argument', `artifact id must match ${SAFE_ID_RE}`);
    }
    if (typeof a.file !== 'string' || !ARTIFACT_NAME_RE.test(a.file)) {
      throw new CommandError(422, 'invalid_argument',
        `artifact file must match ${ARTIFACT_NAME_RE}`);
    }
    if (a.attemptId !== undefined && a.attemptId !== attemptId) {
      throw new CommandError(422, 'invalid_argument',
        'artifact.attemptId must equal the resolving attempt');
    }
    return {
      id,
      kind: typeof a.kind === 'string' ? a.kind.slice(0, 64) : 'artifact',
      file: a.file,
      bytes: Number.isInteger(a.bytes) && a.bytes >= 0 ? a.bytes : null,
      sha256: typeof a.sha256 === 'string' && SHA256_RE.test(a.sha256) ? a.sha256 : null,
    };
  });
}

// Artifact import — the ONLY way runner-produced content enters the store:
// the runner stages the file under <state>/execution/staged/<attemptId>/ and
// commits it through this internal command; the SERVICE reads, hash-verifies,
// and lands it inside its serialized queue. A mismatch, a missing staged
// file, or a path outside the staging root refuses — the attempt keeps its
// evidence instead of losing the result silently.
async function cmdCommitArtifact(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  // Two bindings: attempt-scoped (the common path — artifact belongs to a
  // role attempt and its owner instance) or VALIDATION-scoped (U5 evidence:
  // manifests/check logs committed by the validation owner, no attempt).
  let bindTo = null;
  if (payload.validationId !== undefined) {
    const val = run.validation;
    if (!val || val.id !== payload.validationId
      || (val.status !== 'active' && val.status !== 'unproven')) {
      throw new CommandError(409, 'validation_mismatch',
        'commit_artifact binds to the CURRENT active validation only');
    }
    await validationAuth(ctx, run, val, payload, now);
    bindTo = { validationId: val.id };
  } else {
    const att = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
    if (!att) throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
    if (!ownsResource(att.owner, payload)) {
      throw new CommandError(409, 'not_attempt_owner',
        `attempt ${att.id} is owned by another runner instance`);
    }
    bindTo = { attemptId: att.id };
  }
  const [a] = validateArtifacts([payload.artifact ?? {}], bindTo.attemptId ?? null);
  const stagedPath = reqStr(payload.stagedPath, 'stagedPath');
  if (!isAbsolute(stagedPath)) {
    throw new CommandError(422, 'invalid_argument', 'stagedPath must be absolute');
  }
  if (typeof ctx.importArtifact !== 'function') {
    throw new CommandError(503, 'artifact_import_unavailable',
      'the state service does not expose artifact import on this deployment');
  }
  run.artifacts ??= {};
  const priorArt = run.artifacts[a.id];
  if (priorArt) {
    // Artifact records are IMMUTABLE evidence: the same id may only ever
    // bind the same file/kind/hash/bytes under the same scope. An exact
    // restatement is an idempotent replay (the bytes were already
    // verified and stored); ANY difference is a refused overwrite.
    const sameBinding = (priorArt.attemptId ?? null) === (bindTo.attemptId ?? null)
      && (priorArt.validationId ?? null) === (bindTo.validationId ?? null);
    const sameEvidence = priorArt.file === a.file && priorArt.kind === a.kind
      && priorArt.sha256 !== null && priorArt.sha256 === a.sha256
      && priorArt.bytes !== null && priorArt.bytes === a.bytes;
    if (!(sameBinding && sameEvidence)) {
      throw new CommandError(409, 'artifact_immutable',
        `artifact ${a.id} already commits different evidence — artifacts are immutable`);
    }
    return { aggregate, result: { artifact: priorArt, idempotent: true } };
  }
  // The PHYSICAL store name is bound to the artifact id — the logical
  // `file` (check-0-stdout.log, result-manifest.json) recurs across
  // rounds/roles and can never name the stored blob, or a later round's
  // commit would silently overwrite an earlier round's evidence bytes.
  const storedName = a.id;
  const clash = Object.values(run.artifacts).find((x) => x
    && x.id !== a.id && (x.stored ?? x.file) === storedName);
  if (clash) {
    throw new CommandError(409, 'artifact_file_conflict',
      `artifact ${a.id} claims the stored file of ${clash.id} — never overwrite evidence`);
  }
  const meta = await ctx.importArtifact({
    runId: run.id, file: storedName, sha256: a.sha256, stagedPath,
  });
  run.artifacts[a.id] = {
    ...a, stored: storedName, bytes: meta.bytes, sha256: meta.sha256, ...bindTo, at: now,
  };
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    result: { artifact: run.artifacts[a.id] },
  };
}

async function cmdResolveAttempt(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const att = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
  if (!att) throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
  if (!ownsResource(att.owner, payload)) {
    throw new CommandError(409, 'not_attempt_owner',
      `attempt ${att.id} is owned by another runner instance`);
  }
  const outcome = reqStr(payload.outcome, 'outcome');
  if (!ATTEMPT_TERMINAL.has(outcome)) {
    throw new CommandError(422, 'invalid_argument',
      `outcome must be one of ${[...ATTEMPT_TERMINAL].join(', ')}`);
  }
  const isPanelist = att.role === 'panelist';
  const isJudge = att.role === 'judge';
  const isIntegrator = att.role === 'integrator';
  let panelAnswer = null;
  let judgeWorkOrder = null;
  let judgeParsed = null;
  let integReport = null;
  let integParsed = null;
  if (isPanelist || isJudge || isIntegrator) {
    // Fusion attempts never move run status/phase on resolve — the panel
    // terminalizes through panel_settle, the handoff through its own
    // commands (routeWorkOrder / record_integrate_result / complete_run).
    if (payload.runStatus !== undefined || payload.runPhase !== undefined) {
      throw new CommandError(422, 'invalid_argument',
        'a fusion-role resolve carries no runStatus/runPhase — the fusion commands own run transitions');
    }
    if (isPanelist) {
      if (outcome === 'completed') {
        checkPanelAnswer(FUSION_DEPS, run, att, payload.answer);
        panelAnswer = payload.answer;
      } else if (payload.answer !== undefined) {
        throw new CommandError(422, 'invalid_argument',
          'payload.answer is only meaningful on a completed panelist resolve');
      }
    } else if (isJudge) {
      if (outcome === 'completed') {
        judgeParsed = await checkJudgeWorkOrder(FUSION_DEPS, ctx, run, att, payload.workOrder);
        judgeWorkOrder = payload.workOrder;
      } else if (payload.workOrder !== undefined) {
        throw new CommandError(422, 'invalid_argument',
          'payload.workOrder is only meaningful on a completed judge resolve');
      }
    } else if (isIntegrator) {
      if (outcome === 'completed') {
        integParsed = await checkIntegratorReport(FUSION_DEPS, ctx, run, att, payload.report);
        integReport = payload.report;
      } else if (payload.report !== undefined) {
        throw new CommandError(422, 'invalid_argument',
          'payload.report is only meaningful on a completed integrator resolve');
      }
    }
  }
  let runStatus = null;
  if (payload.runStatus !== undefined) {
    runStatus = reqStr(payload.runStatus, 'runStatus');
    if (!RESOLVE_RUN_STATUSES.has(runStatus)) {
      throw new CommandError(422, 'invalid_argument',
        `runStatus must be one of ${[...RESOLVE_RUN_STATUSES].join(', ')}`);
    }
  }
  let runPhase = null;
  if (payload.runPhase !== undefined) {
    runPhase = reqStr(payload.runPhase, 'runPhase');
    if (!RUN_PHASES.has(runPhase)) {
      throw new CommandError(422, 'invalid_argument',
        `runPhase must be one of ${[...RUN_PHASES].join(', ')}`);
    }
  }
  const result = payload.result === undefined ? null : validateAttemptResult(payload.result);
  const artifacts = validateArtifacts(payload.artifacts, att.id);
  if (!ATTEMPT_NONTERMINAL.has(att.status)) {
    if (att.status === outcome && (runStatus === null || run.status === runStatus)) {
      return { aggregate, result: { attemptId: att.id, status: att.status, idempotent: true } };
    }
    throw new CommandError(409, 'attempt_terminal',
      `attempt ${att.id} is already ${att.status}`);
  }
  // A run may terminalize only when this resolution leaves NO live attempt —
  // marking a run blocked/failed while a sibling attempt may still run would
  // orphan it. Check BEFORE mutating the attempt.
  if (runStatus) {
    const sibling = (run.attempts || []).find(
      (a) => a && a.id !== att.id && ATTEMPT_NONTERMINAL.has(a.status));
    if (sibling) {
      throw new CommandError(409, 'attempt_active',
        `attempt ${sibling.id} is ${sibling.status} — the run cannot terminalize while it may still run`);
    }
  }
  att.status = outcome;
  att.outcome = outcome;
  att.error = typeof payload.reason === 'string' ? payload.reason.slice(0, 500) : null;
  att.finishedAt = now;
  if (result) {
    att.result = result;
    if (!isPanelist && !isJudge && !isIntegrator) {
      run.result = { ...result, attemptId: att.id, role: att.role, at: now };
    }
  }
  if (artifacts.length) {
    run.artifacts ??= {};
    for (const a of artifacts) {
      const prior = run.artifacts[a.id];
      if (prior) {
        // A resolve-time metadata restatement can never overwrite a
        // committed record: exact same file/kind/hash/bytes under the
        // same attempt — anything else refuses as immutable evidence.
        const same = prior.attemptId === att.id
          && prior.file === a.file && prior.kind === a.kind
          && prior.sha256 === a.sha256 && prior.bytes === a.bytes;
        if (!same) {
          throw new CommandError(409, 'artifact_immutable',
            `artifact ${a.id} already committed under different evidence`);
        }
        continue; // keep the committed record (stored/provenance) verbatim
      }
      // Metadata-only record — no bytes were imported through the staged
      // path, so no `stored` name exists; the artifact route fails closed
      // on it (unbound evidence) rather than serving unverified content.
      run.artifacts[a.id] = { ...a, attemptId: att.id, at: now };
    }
  }
  // A COMPLETED 'fix' attempt CONSUMES the recorded fixContext — it was the
  // input to that attempt. The run then re-enters awaiting_validation for a
  // NEW round; leaving it set would relaunch fix attempts until the role
  // budget exhausted without ever revalidating. A failed/cancelled fix
  // terminalizes the run upstream (runStatus set) — the context stays on
  // the record as evidence, never re-consumed into a fresh round.
  if (att.phase === 'fix' && outcome === 'completed') run.fixContext = null;
  if (isPanelist) {
    onPanelistResolved(FUSION_DEPS, run, att, outcome, panelAnswer, payload, now);
  } else if (isJudge) {
    onJudgeResolved(FUSION_DEPS, aggregate, run, att, outcome, judgeWorkOrder, judgeParsed, now);
  } else if (isIntegrator) {
    onIntegratorResolved(FUSION_DEPS, run, att, outcome, integReport, integParsed, now);
  }
  if (runPhase) run.phase = runPhase;
  if (runStatus) {
    run.status = runStatus;
    run.finishedAt = now;
  }
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: !!(runStatus || runPhase),
    result: { attemptId: att.id, status: att.status, runId: run.id, runStatus: run.status },
  };
}

// Runs a run out of the launchable set without an attempt — used when the
// attempt budget is exhausted or a workspace is permanently broken. Refuses
// while an attempt is live (resolve it first — terminalizing a run under a
// live supervisor would orphan it).
async function cmdCompleteRun(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (!RUN_NONTERMINAL.has(run.status)) {
    if (run.status === payload.status) {
      return { aggregate, result: { runId: run.id, status: run.status, idempotent: true } };
    }
    throw new CommandError(409, 'run_terminal', `run ${run.id} is already ${run.status}`);
  }
  const live = liveAttempt(run);
  if (live) {
    throw new CommandError(409, 'attempt_active',
      `attempt ${live.id} is ${live.status} — resolve it before completing the run`);
  }
  // U5: a run holding a live validation reservation cannot terminalize —
  // the check-exec task and its process group must settle first
  // (end_validation with a terminal/unproven outcome). Cancelling the run
  // under an active validation would orphan owned check processes.
  if (run.validation && (run.validation.status === 'active'
    || run.validation.status === 'unproven')) {
    if (run.validation.cancel) {
      // stopping path: the validation has its durable cancel marker but no
      // terminal validation record yet — the reservation stays; the caller
      // must drive end_validation (cancelled/unproven) first.
      throw new CommandError(409, 'validation_active',
        `validation ${run.validation.id} is ${run.validation.status} — cancel drains through end_validation before the run completes`);
    }
    throw new CommandError(409, 'validation_active',
      `validation ${run.validation.id} is ${run.validation.status} — resolve it first`);
  }
  const status = reqStr(payload.status, 'status');
  if (!RESOLVE_RUN_STATUSES.has(status)) {
    throw new CommandError(422, 'invalid_argument',
      `status must be one of ${[...RESOLVE_RUN_STATUSES].join(', ')}`);
  }
  // Lifecycle authority: the owner instance of the run's last attempt, or —
  // before any attempt exists — the bound workspace's environment owner.
  // A run with neither has no internal authority yet and cannot be
  // completed over the internal channel — EXCEPT the stopping finalize: a
  // run under a durable user stop intent, with nothing live left, is
  // completed by whatever internal caller observes it (the recorded intent
  // is the authority; a dead owner must never deadlock the halt).
  const stoppingFinalize = run.status === 'stopping'
    && (status === 'cancelled' || status === run.priorTerminal);
  const lastAtt = run.attempts[run.attempts.length - 1] ?? null;
  if (!stoppingFinalize) {
    if (lastAtt) {
      if (!ownsResource(lastAtt.owner, payload)) {
        throw new CommandError(409, 'not_attempt_owner',
          'complete_run requires the owner instance of the run\u2019s last attempt');
      }
    } else if (run.mode === 'fusion' && run.fusion?.owner) {
      // F2: a panel run with zero attempts (gate-rejected composition, a
      // pre-launch stop) is completed by its claimed panel owner.
      if (!ownsResource(run.fusion.owner, payload)) {
        throw new CommandError(409, 'not_panel_owner',
          'complete_run requires the run\u2019s panel owner instance');
      }
    } else {
      const ws = aggregate.workspaces?.[run.workspaceId];
      if (!ws || !ownsResource(ws.owner, payload)) {
        throw new CommandError(409, 'run_no_authority',
          'no owner established for this run — nothing may complete it');
      }
    }
  } else {
    run.finishedBy = { runnerId: payload.runnerId ?? null, instanceId: payload.instanceId ?? null };
  }
  if (status === 'cancelled' && run.priorTerminal) {
    // A pre-terminal run (blocked/failed with a stranded live attempt) was
    // moved to 'stopping' for the halt — restore its honest terminal status
    // rather than papering the failure over with 'cancelled'.
    run.status = run.priorTerminal;
    delete run.priorTerminal;
  } else {
    run.status = status;
  }
  run.error = typeof payload.reason === 'string' ? payload.reason.slice(0, 500) : null;
  run.finishedAt = now;
  if (run.mode === 'fusion' && run.fusion
    && run.fusion.status !== 'complete' && run.fusion.status !== 'quorum_failed') {
    // A fusion run terminalized outside panel_settle (halt/failure) — the
    // panel is dead; clear the durable pending-decision markers so nothing
    // downstream treats parked participants as actionable.
    run.fusion.status = 'cancelled';
    run.fusion.pendingActions = [];
    run.fusion.judgeEligible = false;
    run.fusion.settledAt = now;
  }
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: { runId: run.id, status },
  };
}

// --- U5 validation commands ------------------------------------------------------
//
// The validation reservation (run.validation) is DURABLE, OWNED, and SLOT-
// COUNTED: it exists before any copy/check process spawns, carries an owner
// identity (runner+instance+envKey+envInstance+lease) like an attempt, and
// participates in the global scheduler budget. Lifecycle:
//   begin_validation → active/'prepare' → record_snapshot → 'verify'
//   → validation_progress (immutable proc records + check reports)
//   → end_validation('settled'|'failed'|'unproven'|'cancelled')
//   settled + checks pass → 'review' → record_report(findings) →
//   'check_review' → record_report(verdicts) → gate decision.
//
// Release rules are strict: 'settled' requires EVERY recorded proc proven
// settled and a verified report for EVERY approved check; 'failed' and
// 'cancelled' may release the reservation ONLY when no proc was ever
// recorded (provably nothing spawned); anything else is 'unproven' and
// RETAINS the reservation — a second validator never launches over it.
// While status is 'active'/'unproven' the run is never parked, never
// completable, never continuable.

const PROC_LEADER_FIELDS = ['pid', 'pgid', 'starttime', 'pidNs', 'uid', 'envInstance'];
const CHECK_STATUSES = new Set(['pass', 'fail', 'timeout', 'cancelled', 'error', 'unproven']);

function activeValidation(run) {
  const val = run.validation;
  // 'unproven' is a LIVE state — the reservation is retained and progress
  // records remain legal (a later positive proof must be able to drain it);
  // 'failed' stays reachable only for its terminal end_validation.
  if (!val || !['active', 'unproven', 'failed'].includes(val.status)) {
    throw new CommandError(409, 'validation_not_active',
      `run ${run.id} has no live validation (${val ? val.status : 'none'})`);
  }
  return val;
}

function validationOf(run, validationId) {
  const val = activeValidation(run);
  if (reqStr(validationId, 'validationId') !== val.id) {
    throw new CommandError(409, 'validation_mismatch',
      `live validation is ${val.id}, not ${validationId}`);
  }
  return val;
}

// Validation ownership: every validation mutation requires the recorded
// owner instance — or an adoption that proves the recorded owner dead with
// the same structured proof as attempts/workspaces. Adoption rebinds the
// owner durably so later records carry the new provenance.
async function validationAuth(ctx, run, val, payload, now) {
  if (ownsResource(val.owner, payload)) return;
  if (payload.adopt === true) {
    const envs = await ctx.loadEnvironments();
    checkAdoptionProof(val, payload, envs);
    // Immutable adoption evidence: the ORIGINAL owner environment the proof
    // was verified against — envKey/envInstance/slot/generation + the
    // verified proof kind + server time. Proc settlement later binds each
    // proc's recorded origin environment to THIS evidence — a proof for
    // envA can never drain procs recorded under envB, and history is
    // preserved across repeated adoptions (never a sticky global kind).
    (val.adoptions ??= []).push({
      kind: payload.proof?.kind ?? null,
      from: {
        runnerId: val.owner?.runnerId ?? null,
        instanceId: val.owner?.instanceId ?? null,
        pid: val.owner?.pid ?? null,
        pidStarttime: val.owner?.pidStarttime ?? null,
        envKey: val.owner?.envKey ?? null,
        envInstance: val.owner?.envInstance ?? null,
        envSlot: val.owner?.envSlot ?? null,
        envGeneration: val.owner?.envGeneration ?? null,
      },
      to: { runnerId: payload.runnerId ?? null, instanceId: payload.instanceId ?? null },
      at: now,
    });
    val.adoptedProofKind = payload.proof?.kind ?? null; // latest, for callers
    val.owner = newOwner(payload, now, clampLeaseMs(payload.leaseMs), val.owner);
    return;
  }
  throw new CommandError(409, 'not_validation_owner',
    `validation ${val.id} is owned by another runner instance — adopt with proof first`);
}

// Apply a gate decision to the run — the ONLY place a validation round
// closes. Records the round evidence bound to the result hash.
function applyGateDecision(run, val, gate, now) {
  const round = {
    round: val.round,
    resultSha256: val.resultSha256,
    checksVerdict: val.checks.verdict,
    decision: gate.decision,
    reason: gate.reason ?? null,
    blocking: gate.blocking ?? [],
    nonBlocking: gate.nonBlocking ?? [],
    unvetted: gate.unvetted ?? [],
    findingsArtifactId: val.reports.findings?.artifactId ?? null,
    verdictsArtifactId: val.reports.verdicts?.artifactId ?? null,
    findingsAttemptId: val.reports.findings?.attemptId ?? null,
    verdictsAttemptId: val.reports.verdicts?.attemptId ?? null,
    at: now,
  };
  run.rounds ??= [];
  run.rounds.push(round);
  if (gate.decision === 'awaiting_acceptance') {
    run.status = 'awaiting_acceptance';
    run.phase = 'awaiting_acceptance';
    run.acceptance = { resultSha256: val.resultSha256, round: val.round, at: now };
    run.fixContext = null;
  } else if (gate.decision === 'fix') {
    // Fix = implementer attempt in the canonical workspace carrying the
    // full verified prior result + gate evidence forward — the complete
    // verified findings/verdict documents, check diagnostics, and the
    // artifact provenance, never a caller-trimmed projection.
    const findingsById = new Map(
      (val.reports.findings?.doc?.findings || []).map((f) => [f.id, f]));
    run.fixContext = {
      round: val.round,
      validationId: val.id,
      resultSha256: val.resultSha256,
      checksVerdict: val.checks.verdict,
      // The COMPLETE recorded result of the LAST implementer/fix attempt —
      // the attempt whose canonical change this round validated. run.result
      // is NOT used: reviewer/checker resolves overwrite it, so it would
      // name the wrong producer.
      priorResult: (() => {
        const last = [...(run.attempts || [])].reverse()
          .find((a) => a && a.role === 'implementer' && a.result);
        return last
          ? { ...last.result, attemptId: last.id, role: 'implementer', at: last.finishedAt ?? null }
          : null;
      })(),
      openFindings: (gate.blocking || []).map((id) => {
        const f = findingsById.get(id);
        return f ? { id: f.id, severity: f.severity, text: f.text, where: f.where } : { id };
      }),
      // Verified evidence verbatim — the fix agent gets the COMPLETE
      // documents the gate consumed, plus immutable artifact provenance.
      findingsDoc: val.reports.findings?.doc ?? null,
      verdictsDoc: val.reports.verdicts?.doc ?? null,
      findingsArtifactId: val.reports.findings?.artifactId ?? null,
      verdictsArtifactId: val.reports.verdicts?.artifactId ?? null,
      // The report-recorded artifact hashes — hydration cross-binds the
      // artifact record to the report that consumed it, not just to itself.
      findingsArtifactSha256: val.reports.findings?.artifactSha256 ?? null,
      verdictsArtifactSha256: val.reports.verdicts?.artifactSha256 ?? null,
      findingsAttemptId: val.reports.findings?.attemptId ?? null,
      verdictsAttemptId: val.reports.verdicts?.attemptId ?? null,
      checkReports: (val.checks.reports || []).map((r) => ({
        index: r.index, status: r.status, exitCode: r.exitCode ?? null,
        stdoutTail: r.stdoutTail ?? null, stderrTail: r.stderrTail ?? null,
        stdoutBytes: r.stdoutBytes ?? null, stderrBytes: r.stderrBytes ?? null,
        // Durable log provenance — the imported immutable artifacts and
        // their recorded hashes, not a mutable path.
        logOutArtifactId: r.logOutArtifactId ?? null,
        logErrArtifactId: r.logErrArtifactId ?? null,
        logSha256Out: r.logSha256Out ?? null,
        logSha256Err: r.logSha256Err ?? null,
      })),
      priorAttempts: (run.attempts || []).map((a) => ({
        id: a.id, role: a.role, n: a.n ?? null,
        outcome: a.outcome ?? a.status, error: a.error ?? null,
      })),
      reason: gate.reason ?? null,
      at: now,
    };
    run.phase = 'awaiting_validation';
    run.status = 'active';
  } else if (gate.decision === 'blocked') {
    run.status = 'blocked';
    run.phase = 'blocked';
    run.error = gate.reason ?? 'review gate exhausted';
    run.finishedAt = now;
  }
  val.status = 'settled';
  val.endedAt = now;
}

// begin_validation — the durable boundary BEFORE any copy/check process
// exists. Owned like an attempt, counted against the global scheduler
// budget alongside attempts, and refused while a live attempt or a
// live/unproven validation reservation exists.
async function cmdBeginValidation(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.status === 'stopping') {
    throw new CommandError(409, 'run_stopping', `run ${run.id} is stopping — validation cannot begin`);
  }
  if (run.status !== 'active' || run.phase !== 'awaiting_validation') {
    throw new CommandError(409, 'validation_state',
      `validation begins only from active+awaiting_validation — run is ${run.status}/${run.phase ?? 'none'}`);
  }
  const live = liveAttempt(run);
  if (live) {
    throw new CommandError(409, 'attempt_active',
      `attempt ${live.id} is ${live.status} — resolve it before validating`);
  }
  const prev = run.validation;
  if (prev && (prev.status === 'active' || prev.status === 'unproven')) {
    throw new CommandError(409, 'validation_active',
      `validation ${prev.id} is ${prev.status} — a second validator is never launched over an unproven reservation`);
  }
  const validationId = reqStr(payload.validationId, 'validationId');
  if (!VALIDATION_ID_RE.test(validationId)) {
    throw new CommandError(422, 'invalid_argument', `validationId must match ${VALIDATION_ID_RE}`);
  }
  for (const v of run.validationHistory || []) {
    if (v.id === validationId) {
      throw new CommandError(409, 'validation_exists', `validationId ${validationId} already used`);
    }
  }
  const ws = aggregate.workspaces?.[run.workspaceId];
  if (!ws || ws.status !== 'ready' || ws.runId !== run.id) {
    throw new CommandError(422, 'workspace_not_ready',
      `run ${run.id} has no ready bound workspace — validation refused`);
  }
  // Slot accounting: an active validation holds owned process work — it
  // consumes the SAME global budget an attempt does, counted as ONE
  // reservation unit per run (a run's attempt+validation never double-pay).
  const limits = await ctx.loadSchedulerLimits();
  let globalActive = 0;
  let validationActive = 0;
  for (const agg of await ctx.listAggregates()) {
    for (const r of agg.runs || []) {
      // No status shortcut — a terminal run with a live/unproven validation
      // still holds its reservation until positive proof drains it.
      let runActive = false;
      for (const a of r?.attempts || []) {
        if (a && ATTEMPT_NONTERMINAL.has(a.status)) runActive = true;
      }
      const v = r?.validation;
      if (v && (v.status === 'active' || v.status === 'unproven')) {
        runActive = true;
        validationActive += 1;
      }
      if (runActive) globalActive += 1;
    }
  }
  // Union-per-run accounting: a run holding a live attempt AND an active
  // validation is ONE reservation unit — the pipeline's reviewer/checker
  // attempt takes over the unit the validation already holds, so the
  // budget never double-counts or deadlocks a single-slot deployment.
  if (globalActive >= limits.global) {
    throw new CommandError(409, 'limit_reached',
      `global reservation limit reached (${globalActive}/${limits.global}) — validation cannot begin`,
      { scope: 'global', active: globalActive, limit: limits.global });
  }
  const root = await ctx.workspaceRoot();
  const dirs = validationDirs(root, run.id, validationId);
  if (payload.dirs !== undefined) assertValidationDirs(payload.dirs, root, run.id, validationId);
  const round = (run.round ?? 0) + 1;
  // Review rules are snapshotted at cmdStart (run.reviewRules) — they are
  // part of the frozen inputs, never re-read per round.
  if (!run.reviewRules) {
    run.reviewRules = snapshotReviewRules(null, run.composition?.preset?.limits);
  }
  const leaseMs = clampLeaseMs(payload.leaseMs);
  const owner = newOwner(payload, now, leaseMs);
  if (prev) {
    (run.validationHistory ??= []).push(
      { id: prev.id, status: prev.status, endedAt: prev.endedAt ?? null });
  }
  run.validation = {
    id: validationId,
    status: 'active',
    phase: 'prepare',
    owner,
    dirs,
    round,
    resultSha256: null,
    manifest: null,
    manifestArtifactId: null,
    checks: { status: 'pending', verdict: null, reports: [] },
    procs: {},
    reports: {},
    cancel: null,
    startedAt: now,
    endedAt: null,
  };
  run.round = round;
  run.phase = 'verify';
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: true,
    result: {
      runId: run.id, validationId, round, status: 'active', phase: 'prepare',
      slots: { global: { active: globalActive + 1, limit: limits.global } },
      validationActive,
    },
  };
}

// Strict caller-manifest shape validation — fields, types and path safety —
// BEFORE the manifest is recorded. Shared with the materializer's own
// refuse rules; malformed manifests are rejected, never stored "to be safe".
function validateManifestShape(manifest) {
  if (!isObj(manifest) || manifest.schema !== 1) {
    throw new CommandError(422, 'invalid_argument', 'manifest must be schema 1');
  }
  if (typeof manifest.baseCommit !== 'string' || !SHA40_RE.test(manifest.baseCommit)) {
    throw new CommandError(422, 'invalid_argument', 'manifest.baseCommit must be a sha1');
  }
  if (typeof manifest.headCommit !== 'string' || !SHA40_RE.test(manifest.headCommit)) {
    throw new CommandError(422, 'invalid_argument', 'manifest.headCommit must be a sha1');
  }
  for (const key of ['entries', 'deleted', 'excluded', 'unsupported']) {
    if (!Array.isArray(manifest[key])) {
      throw new CommandError(422, 'invalid_argument', `manifest.${key} must be an array`);
    }
  }
  const seen = new Set();
  const checkPath = (p, at) => {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')
      || isAbsolute(p) || p.split('/').some((c) => c === '..' || c === '' || c === '.')
      || p.split('/').includes('.git')) {
      throw new CommandError(422, 'invalid_argument', `${at}: unsafe path ${JSON.stringify(p)}`);
    }
  };
  for (const [i, e] of manifest.entries.entries()) {
    const at = `entries[${i}]`;
    checkPath(e?.path, at);
    if (seen.has(e.path)) {
      throw new CommandError(422, 'invalid_argument', `${at}: duplicate path ${e.path}`);
    }
    seen.add(e.path);
    if (e.kind === 'file') {
      if (!RESULT_HASH_RE.test(e.sha256 ?? '') || !Number.isInteger(e.size)
        || !Number.isInteger(e.mode)) {
        throw new CommandError(422, 'invalid_argument',
          `${at}: file entries require sha256/size/mode`);
      }
    } else if (e.kind === 'link') {
      if (typeof e.target !== 'string' || !e.target.length || e.target.length > 4096
        || !RESULT_HASH_RE.test(e.sha256 ?? '')) {
        throw new CommandError(422, 'invalid_argument', `${at}: link entries require target+sha256`);
      }
    } else {
      throw new CommandError(422, 'invalid_argument', `${at}: unknown kind ${e.kind}`);
    }
  }
  for (const [i, e] of [...manifest.excluded.entries(), ...manifest.unsupported.entries()]) {
    checkPath(e?.path, `excluded/unsupported[${i}]`);
    if (typeof e.reason !== 'string' || !e.reason) {
      throw new CommandError(422, 'invalid_argument', 'excluded/unsupported entries require reason');
    }
  }
  for (const p of manifest.deleted) checkPath(p, 'deleted[]');
}

// record_snapshot — the manifest is recorded ONCE, immutably, bound to a
// committed validation-scoped artifact whose VERIFIED BYTES hash to the
// canonical manifest. The domain re-derives resultSha256 itself — the
// caller's claim is never trusted.
async function cmdRecordSnapshot(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const val = validationOf(run, payload.validationId);
  await validationAuth(ctx, run, val, payload, now);
  if (val.status !== 'active') {
    throw new CommandError(409, 'validation_not_active',
      `validation ${val.id} already terminal (${val.status})`);
  }
  if (val.phase !== 'prepare' && val.phase !== 'verify') {
    throw new CommandError(409, 'validation_phase',
      `snapshot records in prepare/verify — validation is ${val.phase}`);
  }
  const manifest = payload.manifest;
  validateManifestShape(manifest);
  const resultSha256 = sha256(canonicalManifest(manifest));
  if (val.manifest) {
    // Immutable-once: same manifest = idempotent replay; anything else is
    // a post-checks rewrite attempt and refuses.
    if (val.resultSha256 === resultSha256) {
      return { aggregate, result: { runId: run.id, validationId: val.id, resultSha256, idempotent: true } };
    }
    throw new CommandError(409, 'snapshot_immutable',
      `validation ${val.id} already recorded result ${val.resultSha256?.slice(0, 12)}… — a manifest is never replaced`);
  }
  if (typeof payload.resultSha256 === 'string' && payload.resultSha256 !== resultSha256) {
    throw new CommandError(409, 'snapshot_mismatch',
      `caller resultSha256 ${payload.resultSha256} does not equal the manifest-derived ${resultSha256}`);
  }
  if (manifest.baseCommit !== run.baseCommit) {
    throw new CommandError(409, 'base_commit_mismatch',
      `manifest baseCommit ${manifest.baseCommit} != run baseCommit ${run.baseCommit}`);
  }
  // Artifact binding mandatory: the committed artifact's VERIFIED BYTES
  // must hash to exactly the recorded manifest — caller assertions are
  // never evidence.
  const artId = reqStr(payload.manifestArtifactId, 'manifestArtifactId');
  const art = run.artifacts?.[artId];
  if (!art || art.validationId !== val.id) {
    throw new CommandError(422, 'artifact_unbound',
      `manifestArtifactId must reference a committed artifact bound to validation ${val.id}`);
  }
  const stored = await ctx.readArtifactText(run.id, art.stored ?? art.file);
  if (stored.sha256 !== art.sha256) {
    throw new CommandError(422, 'artifact_corrupt',
      `manifest artifact bytes hash ${stored.sha256.slice(0, 12)}… != recorded ${art.sha256.slice(0, 12)}…`);
  }
  let storedManifest;
  try {
    storedManifest = JSON.parse(stored.text);
  } catch (e) {
    throw new CommandError(422, 'artifact_corrupt', `manifest artifact is not JSON: ${e.message}`);
  }
  if (sha256(canonicalManifest(storedManifest)) !== resultSha256) {
    throw new CommandError(409, 'snapshot_mismatch',
      'the caller manifest and the stored artifact disagree — evidence must be identical');
  }
  val.manifest = manifest;
  val.resultSha256 = resultSha256;
  val.manifestArtifactId = artId;
  const ok = (manifest.unsupported || []).length === 0;
  if (!ok) {
    // Fail-closed: the result can never be materialized — recorded as
    // evidence, the validation ends 'failed' (only end_validation may
    // close the reservation).
    val.status = 'failed';
    val.endedAt = now;
    run.diagnostic = {
      type: 'result_unsupported', at: now,
      detail: (manifest.unsupported || []).slice(0, 5)
        .map((u) => `${u.path}:${u.reason}`).join('; '),
    };
    run.phase = 'awaiting_validation';
  } else {
    val.phase = 'verify';
  }
  stageRun(aggregate, run, ctx);
  return {
    aggregate,
    refreshProjection: !ok,
    result: { runId: run.id, validationId: val.id, resultSha256, ok },
  };
}

// validation_progress — durable check reports and proc records.
//   proc records: identity is WRITE-ONCE — {index, leader{…}} recorded at
//     spawn; later records may only move state recorded→settled|unproven
//     (monotonic, never backward) with the identity byte-identical.
//   check reports: index must name an APPROVED run.checks entry and the
//     report's run/cwd/timeoutSec/setup must equal it exactly. A 'pass'
//     report requires logSha256Out/logSha256Err verified against the actual
//     durable files under the recorded logs dir — proof, not assertion.
async function cmdValidationProgress(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const val = validationOf(run, payload.validationId);
  // Terminal evidence is never adopted — refuse the adopt BEFORE auth so a
  // foreign caller cannot rebind ownership of a closed validation.
  if (payload.adopt === true && val.status !== 'active' && val.status !== 'unproven') {
    throw new CommandError(409, 'validation_not_active',
      `validation ${val.id} is ${val.status} — terminal records are not adoptable`);
  }
  // Ownership BEFORE the status gate — a foreign caller gets
  // not_validation_owner on ANY status, never a status leak.
  await validationAuth(ctx, run, val, payload, now);
  if (val.status !== 'active' && val.status !== 'unproven') {
    throw new CommandError(409, 'validation_not_active',
      `validation ${val.id} is ${val.status}`);
  }
  // Under 'unproven' ONLY drain progress is legal: a later positive death
  // proof settles a recorded proc (unproven→settled / recorded→settled).
  // No new copy receipts, intents, or check reports may land — the round's
  // evidence is frozen while the reservation is unresolved.
  const drainingOnly = val.status === 'unproven';
  const approved = run.inputs?.plan?.checks || [];
  const checkIndex = (i, at) => {
    if (!Number.isInteger(i) || i < 0 || i >= approved.length) {
      throw new CommandError(422, 'check_index',
        `${at} index ${i} names no approved check (${approved.length} recorded)`);
    }
  };
  let recorded = payload.adopt === true ? 'adopted' : null;
  if (drainingOnly) {
    // Only proc settlement — everything else is new work over an
    // unresolved reservation.
    if (payload.copiesReady === true || payload.copy !== undefined
      || payload.check !== undefined
      || (payload.proc !== undefined && payload.proc?.state !== 'settled')) {
      throw new CommandError(409, 'validation_unproven',
        'an unproven validation accepts only proc settlement proofs — no new copies/intents/reports');
    }
  }
  if (payload.copiesReady === true) {
    // Durable copy receipt — recorded ONCE, before any check proc may be
    // recorded. A restart that finds this set verifies the dirs on disk and
    // never re-materializes into a non-empty copy.
    if (val.copiesReady) {
      throw new CommandError(409, 'copies_recorded',
        `validation ${val.id} already recorded copiesReady — never re-marked`);
    }
    if (Object.keys(val.procs || {}).length || val.checks.reports.length) {
      throw new CommandError(409, 'copies_late',
        'copiesReady cannot land after proc/check records exist — order matters');
    }
    val.copiesReady = { at: now };
    recorded = 'copiesReady';
  }
  if (payload.proc !== undefined) {
    const p = payload.proc;
    if (!isObj(p)) {
      throw new CommandError(422, 'invalid_argument', 'proc must be an object');
    }
    checkIndex(p.index, 'proc');
    const state = typeof p.state === 'string' ? p.state : 'recorded';
    if (!['intent', 'recorded', 'settled', 'unproven'].includes(state)) {
      throw new CommandError(422, 'invalid_argument',
        'proc.state must be intent|recorded|settled|unproven');
    }
    // 'intent' is the durable PRE-SPAWN boundary: recorded BEFORE exec, with
    // no leader identity yet. A restart finding intent-without-leader knows
    // a spawn MAY have happened — the check is unprovable and NEVER rerun.
    if (state !== 'intent' && state !== 'settled' && !isObj(p.leader)) {
      throw new CommandError(422, 'invalid_argument', 'proc must carry leader identity');
    }
    // A leaderless 'settled' is legal ONLY as a drain of an existing
    // leaderless intent and ONLY under the proof kinds checked below. A
    // first-record 'settled' still fails the spawn-boundary check.
    const existing = val.procs[p.index];
    if (existing) {
      // Identity is immutable — a later record may only advance the state;
      // changing ANY identity field is a different process and refuses.
      if (existing.leader) {
        for (const f of PROC_LEADER_FIELDS) {
          const prev = JSON.stringify(existing.leader?.[f] ?? null);
          const next = JSON.stringify(p.leader?.[f] ?? null);
          if (prev !== next) {
            throw new CommandError(409, 'proc_identity_immutable',
              `proc[${p.index}].leader.${f} is already recorded — identity never changes`);
          }
        }
      }
      // Monotonic: intent→recorded|settled; recorded→settled|unproven;
      // unproven→settled is LEGAL — a later positive death proof must be
      // able to drain the reservation. 'settled' is terminal. An 'intent'
      // without a recorded leader can settle ONLY on positive proof that
      // nothing could have been spawned (see below).
      const allowed =
        (existing.state === 'intent' && ['recorded', 'settled'].includes(state))
        || (existing.state === 'recorded' && ['settled', 'unproven'].includes(state))
        || (existing.state === 'unproven' && state === 'settled');
      if (!allowed || existing.state === state) {
        throw new CommandError(409, 'proc_state_terminal',
          `proc[${p.index}] is ${existing.state} — only intent→recorded|settled, recorded→settled|unproven, unproven→settled are legal`);
      }
      if (state === 'recorded' && !existing.leader) {
        existing.leader = p.leader; // spawn receipt fills the intent slot
      }
      if (state === 'settled') {
        const proof = p.proof;
        const kind = isObj(proof) ? proof.kind : null;
        // Whole-environment death proof: a bare kind string is NOT proof.
        // It must equal the VERIFIED kind of a recorded adoption whose
        // original-owner environment matches THIS proc's recorded origin —
        // a proof for environment A never drains procs launched under B.
        const procOrigin = existing.leader?.envInstance ?? existing.originEnv ?? null;
        const procOriginKey = existing.originEnvKey ?? null;
        const envProof = (kind === 'environment_lost' || kind === 'environment_retired')
          && Array.isArray(val.adoptions)
          && val.adoptions.some((a) => a && a.kind === kind
            && envInstanceEqual(a.from?.envInstance, procOrigin)
            && envKeyEqual(a.from?.envKey ?? null, procOriginKey)
            && (a.from?.envSlot ?? null) === (existing.originSlot ?? null)
            && (a.from?.envGeneration ?? null) === (existing.originGen ?? null));
        if (!existing.leader) {
          // Leaderless intent: no process exists to kill — settlement needs
          // positive evidence nothing can exist:
          //   never_spawned        — attestation bound to the intent's
          //                          ORIGINAL recording owner (the executor
          //                          itself), or a same-env adopter relaying
          //                          the executor's durable spool record;
          //   environment_lost /
          //   environment_retired  — adoption evidence bound to the
          //                          intent's original environment.
          if (kind === 'never_spawned') {
            const originSelf = existing.originOwner?.instanceId === payload.instanceId;
            const relayedSpool = proof?.via === 'spool'
              && envInstanceEqual(existing.originEnv, normalizeEnvInstance(payload.envInstance));
            if (!originSelf && !relayedSpool) {
              throw new CommandError(409, 'proc_unproven',
                `proc[${p.index}] never_spawned must come from the intent's `
                + 'original owner or a same-env adopter relaying its spool');
            }
          } else if (!envProof) {
            throw new CommandError(409, 'proc_unproven',
              `proc[${p.index}] is a leaderless intent — settlement requires `
              + 'never_spawned or a verified whole-environment adoption proof '
              + 'bound to its origin environment');
          }
        } else if (envProof) {
          // Recorded leader in a proven-dead environment: the old PID is
          // unreachable in its dead namespace — the adoption evidence bound
          // to the proc's ORIGIN environment stands in for the group-death
          // probe. No old-namespace probing.
        } else if (!isObj(proof) || proof.groupDead !== true) {
          // Positive group-death proof bound to the recorded identity —
          // never a bare caller claim of "exited".
          throw new CommandError(422, 'proc_proof_required',
            `proc[${p.index}] settling requires proof {groupDead:true,…} bound to the recorded leader`);
        }
        existing.proof = { ...proof, at: now };
      }
      existing.state = state;
      existing.stateAt = now;
    } else {
      // A process record is created ONLY at the durable pre-spawn intent or
      // spawn receipt — a terminal first state cannot bypass the boundary.
      if (state !== 'intent' && state !== 'recorded') {
        throw new CommandError(422, 'proc_spawn_boundary',
          `proc[${p.index}] first record must be 'intent' or 'recorded' — terminal states require a prior spawn record`);
      }
      // Durable origin binding: the recording owner identity + environment
      // are stamped at creation — leaderless intents too. Env-death proofs
      // later bind PER-PROC to the original environment, never globally.
      val.procs[p.index] = {
        ...p, state, at: now,
        originOwner: {
          runnerId: payload.runnerId ?? null,
          instanceId: payload.instanceId ?? null,
        },
        originEnv: normalizeEnvInstance(payload.envInstance),
        originEnvKey: normalizeEnvKey(payload.envKey),
        originSlot: typeof payload.envSlot === 'string' ? payload.envSlot : null,
        originGen: Number.isInteger(payload.envGeneration) ? payload.envGeneration : null,
      };
    }
    recorded = `proc[${p.index}]→${state}`;
  }
  if (payload.copy !== undefined) {
    // Durable PER-COPY receipt — one per pristine copy, bound to the
    // recorded snapshot. Crash recovery verifies a receipted dir against
    // the manifest and refuses a nonempty unreceipted dir.
    const cp = payload.copy;
    const key = typeof cp?.key === 'string' ? cp.key : '';
    if (!['base', 'verify', 'review', 'check'].includes(key)) {
      throw new CommandError(422, 'invalid_argument',
        `copy.key must name a pristine copy (base|verify|review|check) — got ${JSON.stringify(cp?.key)}`);
    }
    if (!val.resultSha256) {
      throw new CommandError(409, 'snapshot_required',
        'copy receipts require the result snapshot first — order matters');
    }
    if (val.copies?.[key]) {
      throw new CommandError(409, 'copy_recorded',
        `copy[${key}] is already receipted — copies are immutable evidence`);
    }
    const rc = cp.receipt;
    if (!isObj(rc) || rc.resultSha256 !== val.resultSha256
      || typeof rc.dir !== 'string' || rc.dir !== val.dirs[key]) {
      throw new CommandError(422, 'copy_binding',
        `copy[${key}].receipt must bind resultSha256 ${val.resultSha256?.slice(0, 12)}… and the recorded dir`);
    }
    (val.copies ??= {})[key] = { receipt: { resultSha256: rc.resultSha256, dir: rc.dir }, at: now };
    recorded = `copy[${key}]`;
  }
  if (payload.check !== undefined) {
    const c = payload.check;
    if (!isObj(c) || !CHECK_STATUSES.has(c.status)) {
      throw new CommandError(422, 'invalid_argument',
        `check report must carry status ${[...CHECK_STATUSES].join('|')}`);
    }
    checkIndex(c.index, 'check');
    const want = approved[c.index];
    for (const f of ['run', 'cwd', 'timeoutSec', 'setup']) {
      const got = c[f] === undefined ? null : c[f];
      const exp = want[f] === undefined ? null : want[f];
      if (JSON.stringify(got) !== JSON.stringify(exp)) {
        throw new CommandError(422, 'check_binding',
          `check[${c.index}].${f} must equal the approved entry (${JSON.stringify(exp)}) — got ${JSON.stringify(got)}`);
      }
    }
    if (val.checks.reports.some((r) => r && r.index === c.index)) {
      throw new CommandError(409, 'check_recorded',
        `check[${c.index}] is already recorded — reports are immutable (replay through dedup)`);
    }
    // EVERY executed check carries full durable logs as VERIFIED imported
    // artifacts — not caller-claimed file paths. A mutable on-disk log is
    // never evidence; the imported bytes are.
    for (const [artField, hashField] of [['logOutArtifactId', 'logSha256Out'], ['logErrArtifactId', 'logSha256Err']]) {
      const artId = c[artField];
      const hash = c[hashField];
      if (typeof artId !== 'string' || typeof hash !== 'string' || !RESULT_HASH_RE.test(hash)) {
        throw new CommandError(422, 'check_log_missing',
          `check[${c.index}] requires ${artField}/${hashField} — the durable logs must be imported artifacts`);
      }
      const art = run.artifacts?.[artId];
      if (!art || art.validationId !== val.id) {
        throw new CommandError(422, 'artifact_unbound',
          `check[${c.index}].${artField} must reference a committed artifact bound to validation ${val.id}`);
      }
      const stored = await ctx.readArtifactText(run.id, art.stored ?? art.file);
      if (stored.sha256 !== art.sha256 || stored.sha256 !== hash) {
        throw new CommandError(409, 'check_log_mismatch',
          `check[${c.index}] ${hashField} does not match the stored log bytes`);
      }
    }
    if (c.status === 'pass' || c.status === 'fail' || c.status === 'timeout') {
      // A finished check requires its spawn receipt present and PROVEN
      // settled — a pass can never outlive an unproven group.
      const proc = val.procs[c.index];
      if (!proc || proc.state !== 'settled') {
        throw new CommandError(409, 'check_proc_unsettled',
          `check[${c.index}] cannot report ${c.status} — its process group is not proven terminal`);
      }
    }
    if (c.status === 'pass') {
      const proc = val.procs[c.index];
      if (!proc?.proof || proc.proof.groupDead !== true) {
        throw new CommandError(409, 'check_proc_unsettled',
          `check[${c.index}] cannot pass without positive group-death proof`);
      }
    }
    val.checks.reports.push({ ...c, at: now });
    recorded = `check[${c.index}]→${c.status}`;
  }
  if (!recorded) {
    throw new CommandError(422, 'invalid_argument', 'nothing to record — pass check and/or proc');
  }
  stageRun(aggregate, run, ctx);
  return { aggregate, result: { runId: run.id, validationId: val.id, recorded } };
}

// end_validation — terminal outcome for the reservation.
//   settled:   every recorded proc is 'settled' AND every approved check
//              has an immutable report — partial evidence never settles.
//   unproven:  RETAINS the reservation — restart/reconcile never launches a
//              second validator over it.
//   failed/cancelled: release ONLY when provably nothing spawned (no proc
//              records); a cancelled or crashed check group is 'unproven',
//              never silently released.
async function cmdEndValidation(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const val = validationOf(run, payload.validationId);
  await validationAuth(ctx, run, val, payload, now);
  const outcome = reqStr(payload.outcome, 'outcome');
  // end_validation only on an OPEN reservation — 'active' or the nonterminal
  // 'unproven' (a later positive proof drains it into a terminal outcome).
  // A closed validation is immutable evidence: never re-ended.
  if (val.status !== 'active' && val.status !== 'unproven') {
    if (val.status === outcome) {
      return { aggregate, result: { runId: run.id, status: val.status, idempotent: true } };
    }
    throw new CommandError(409, 'validation_terminal',
      `validation ${val.id} is ${val.status} — terminal records are immutable`);
  }
  if (!['settled', 'failed', 'unproven', 'cancelled'].includes(outcome)) {
    throw new CommandError(422, 'invalid_argument',
      'outcome must be settled|failed|unproven|cancelled');
  }
  const checks = run.inputs?.plan?.checks || [];
  const procRecords = Object.values(val.procs).filter(Boolean);
  const allProvenDead = procRecords.every((p) => p.state === 'settled');
  if (outcome === 'settled') {
    if (!allProvenDead) {
      const unsettled = procRecords.filter((p) => p.state !== 'settled').length;
      throw new CommandError(409, 'procs_unproven',
        `${unsettled} proc record(s) not positively settled — 'settled' is unreachable; use 'unproven'`);
    }
    const reported = new Set(val.checks.reports.map((r) => r.index));
    if (reported.size !== checks.length || val.checks.reports.length !== checks.length) {
      throw new CommandError(409, 'checks_incomplete',
        `${reported.size}/${checks.length} check reports recorded — 'settled' requires every approved check`);
    }
    val.checks.verdict = val.checks.reports.every((r) => r.status === 'pass') ? 'pass' : 'fail';
    val.checks.status = 'done';
    // The ROUND reservation stays 'active' through review/check_review —
    // only the terminal gate decision (acceptance/fix/blocked), a stopping
    // finalize, or a later failed/cancelled/unproven end closes it. Marking
    // the validation settled here would strand record_report (requires
    // 'active') and every role launch behind a closed reservation.
    if (run.status === 'stopping') {
      // STOP BARRIER: a stopped run never advances the gate — the validation
      // evidence closes, the stopping path finalizes the run. No review
      // launch, no fix issuance, no acceptance from a stopped pipeline.
      val.status = 'settled';
      val.endedAt = now;
      stageRun(aggregate, run, ctx);
      return {
        aggregate, refreshProjection: true,
        result: { runId: run.id, status: 'settled', verdict: val.checks.verdict, finalizing: true },
      };
    }
    applySettledGate(run, val, now);
    stageRun(aggregate, run, ctx);
    return {
      aggregate, refreshProjection: true,
      result: {
        runId: run.id, status: 'settled', verdict: val.checks.verdict,
        decision: val.decision ?? null, phase: run.phase,
      },
    };
  } else if (outcome === 'unproven') {
    val.status = 'unproven';
    val.endedAt = now;
    run.diagnostic = {
      type: 'validation_unproven', at: now,
      detail: typeof payload.reason === 'string' ? payload.reason.slice(0, 500)
        : 'process group unproven — reservation retained',
    };
    stageRun(aggregate, run, ctx);
    return { aggregate, refreshProjection: true, result: { runId: run.id, status: 'unproven' } };
  } else {
    // failed/cancelled: release requires POSITIVE group-death — either
    // nothing was ever recorded (pre-spawn boundary: a spawn with no
    // receipt is a caller-side kill obligation, see runCheckCommand), or
    // every recorded proc is 'settled' with proof. Partial check reports
    // are retained history, not a release barrier — a confirmed stop
    // mid-checks CAN complete once all groups are proven dead.
    if (!allProvenDead) {
      const live = procRecords.filter((p) => p.state !== 'settled').length;
      throw new CommandError(409, 'validation_unproven',
        `${live} proc record(s) not positively dead — ${outcome} cannot release the reservation; report 'unproven' or settle them first`);
    }
    val.status = outcome;
    val.endedAt = now;
    // A failed/cancelled validation terminalizes the run honestly — all
    // recorded groups are proven dead, so no live resource is stranded.
    // An already-terminal run keeps its honest status.
    if (!['failed', 'blocked', 'cancelled', 'succeeded', 'interrupted'].includes(run.status)) {
      run.status = outcome;
      run.error = typeof payload.reason === 'string' ? payload.reason.slice(0, 500)
        : `validation ${val.id} ${outcome}`;
      run.finishedAt = now;
    }
    stageRun(aggregate, run, ctx);
    return { aggregate, refreshProjection: false, result: { runId: run.id, status: val.status } };
  }
}

// The settled gate: checks verdict + (when checks pass) parked review
// phase. Never runs under 'stopping' (guarded by the caller).
function applySettledGate(run, val, now) {
  if (val.checks.verdict === 'fail') {
    const gate = evaluateReviewGate({
      round: val.round, checksVerdict: 'fail',
      findings: null, verdicts: null, rules: run.reviewRules,
    });
    applyGateDecision(run, val, gate, now);
    return;
  }
  val.phase = 'review';
  run.phase = 'review';
}

// record_report — verified reviewer findings / checker verdict documents.
// Authority: a COMPLETED reviewer/checker attempt bound to THIS validation
// + round; the document is read from the COMMITTED ARTIFACT (verified
// bytes), never from caller-supplied payload; reports are immutable once
// recorded.
async function cmdRecordReport(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const val = validationOf(run, payload.validationId);
  await validationAuth(ctx, run, val, payload, now);
  if (val.status !== 'active') {
    throw new CommandError(409, 'validation_not_active', `validation ${val.id} is ${val.status}`);
  }
  const kind = reqStr(payload.kind, 'kind');
  if (kind !== 'findings' && kind !== 'verdicts') {
    throw new CommandError(422, 'invalid_argument', 'kind must be findings|verdicts');
  }
  const att = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
  if (!att) throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
  const wantRole = kind === 'findings' ? 'reviewer' : 'checker';
  if (att.role !== wantRole) {
    throw new CommandError(409, 'report_role',
      `a ${kind} report requires a completed ${wantRole} attempt — ${att.id} is ${att.role}`);
  }
  if (att.status !== 'completed') {
    throw new CommandError(409, 'report_attempt_state',
      `a ${kind} report requires a COMPLETED attempt — ${att.id} is ${att.status}; failed/cancelled attempts produce no evidence`);
  }
  if (att.validationId !== val.id || att.round !== val.round) {
    throw new CommandError(409, 'report_stale',
      `attempt ${att.id} is bound to validation ${att.validationId} round ${att.round} — current is ${val.id} round ${val.round}`);
  }
  // Phase binding: findings land only in 'review', verdicts only in
  // 'check_review' — a late findings doc can never reset a phase the gate
  // already advanced past.
  if (kind === 'findings' && val.phase !== 'review') {
    throw new CommandError(409, 'validation_phase',
      `findings require phase 'review' — validation is ${val.phase}`);
  }
  if (kind === 'verdicts' && val.phase !== 'check_review') {
    throw new CommandError(409, 'validation_phase',
      `verdicts require phase 'check_review' — validation is ${val.phase}`);
  }
  if (kind === 'verdicts' && !val.reports.findings) {
    throw new CommandError(409, 'evidence_order',
      'verdicts cannot precede verified findings — there is nothing to vet');
  }
  const artId = reqStr(payload.artifactId, 'artifactId');
  const art = run.artifacts?.[artId];
  if (!art || art.attemptId !== att.id) {
    throw new CommandError(422, 'artifact_unbound',
      'report artifactId must be a committed artifact of this attempt');
  }
  if (val.reports[kind]) {
    if (val.reports[kind].artifactId === artId) {
      return { aggregate, result: { runId: run.id, recorded: kind, idempotent: true } };
    }
    throw new CommandError(409, 'report_immutable',
      `a ${kind} report is already recorded — reports never change (replay the same artifactId)`);
  }
  // Parse the VERIFIED ARTIFACT BYTES — the caller's payload.doc is never
  // evidence.
  const stored = await ctx.readArtifactText(run.id, art.stored ?? art.file);
  if (stored.sha256 !== art.sha256) {
    throw new CommandError(422, 'artifact_corrupt',
      `artifact bytes hash ${stored.sha256.slice(0, 12)}… != recorded ${art.sha256.slice(0, 12)}…`);
  }
  let doc;
  try {
    doc = JSON.parse(stored.text);
  } catch (e) {
    throw new CommandError(422, 'report_invalid', `${kind} artifact is not JSON: ${e.message}`);
  }
  let parsed;
  try {
    if (kind === 'findings') {
      parsed = parseFindingsDoc(doc, { round: val.round, resultSha256: val.resultSha256 });
    } else {
      parsed = parseVerdictDoc(doc, {
        round: val.round,
        resultSha256: val.resultSha256,
        findingIds: new Set(val.reports.findings.doc.findings.map((f) => f.id)),
      });
    }
  } catch (e) {
    if (e instanceof ReviewDocError) {
      throw new CommandError(422, e.code, e.message);
    }
    throw e;
  }
  val.reports[kind] = {
    doc: parsed, attemptId: att.id, artifactId: artId,
    artifactSha256: art.sha256, at: now,
  };
  if (kind === 'findings') {
    val.phase = 'check_review';
    run.phase = 'check_review';
    stageRun(aggregate, run, ctx);
    return {
      aggregate, refreshProjection: true,
      result: { runId: run.id, recorded: 'findings', count: parsed.findings.length },
    };
  }
  let gate;
  try {
    gate = evaluateReviewGate({
      round: val.round,
      checksVerdict: val.checks.verdict,
      findings: val.reports.findings.doc,
      verdicts: parsed,
      rules: run.reviewRules,
    });
  } catch (e) {
    if (e instanceof ReviewDocError) {
      throw new CommandError(500, 'gate_error', e.message);
    }
    throw e;
  }
  applyGateDecision(run, val, gate, now);
  stageRun(aggregate, run, ctx);
  return {
    aggregate, refreshProjection: true,
    result: { runId: run.id, recorded: 'verdicts', decision: gate.decision, reason: gate.reason },
  };
}

// accept_result — the ONLY path to 'succeeded'. Binds the exact recorded
// resultSha256 AND re-hashes the live workspace at acceptance time; stale
// hash, moved workspace, changed inputs, live reservations or a rebound
// workspace all refuse. Replays of the same commandId return the stored
// outcome via dedup before this runs.
async function cmdAcceptResult(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  if (run.status === 'succeeded') {
    if (run.acceptance?.resultSha256 === payload.resultSha256) {
      return { aggregate, result: { runId: run.id, status: 'succeeded', idempotent: true } };
    }
    throw new CommandError(409, 'stale_result', 'run already succeeded with a different result');
  }
  if (run.status !== 'awaiting_acceptance' || !run.acceptance) {
    throw new CommandError(409, 'not_acceptable',
      `run ${run.id} is ${run.status} — acceptance requires the verified awaiting_acceptance gate`);
  }
  const want = reqStr(payload.resultSha256, 'resultSha256');
  if (!RESULT_HASH_RE.test(want)) {
    throw new CommandError(422, 'invalid_argument', 'resultSha256 must be a 64-hex hash');
  }
  if (want !== run.acceptance.resultSha256) {
    throw new CommandError(409, 'stale_result',
      `resultSha256 ${want.slice(0, 12)}… is not the accepted ${run.acceptance.resultSha256.slice(0, 12)}…`);
  }
  // The inputs must still be the approved pair this run was launched with —
  // a requirements/plan change after start revokes the accepted basis.
  const reqA = aggregate.approvals?.requirements;
  const planA = aggregate.approvals?.plan;
  if (!reqA || !planA
    || reqA.sha256 !== run.inputs?.requirements?.sha256
    || planA.sha256 !== run.inputs?.plan?.sha256
    || reqA.versionId !== run.inputs?.requirements?.versionId
    || planA.versionId !== run.inputs?.plan?.versionId) {
    throw new CommandError(409, 'inputs_changed',
      'the approved inputs changed since this run started — the accepted basis is stale');
  }
  const liveAtt = liveAttempt(run);
  const val = run.validation;
  if (liveAtt || (val && (val.status === 'active' || val.status === 'unproven'))) {
    throw new CommandError(409, 'reservation_live',
      'a live attempt or validation reservation still exists — nothing may be accepted under it');
  }
  // The workspace must still be bound to THIS run — a rebound/transferred
  // workspace is never the accepted result.
  const ws = aggregate.workspaces?.[run.workspaceId];
  if (!ws || ws.status !== 'ready' || ws.runId !== run.id) {
    throw new CommandError(409, 'workspace_not_ready',
      'run workspace is no longer bound to this run — acceptance refused');
  }
  const live = await computeResultManifest(ws.path, { baseCommit: run.baseCommit });
  if (live.resultSha256 !== run.acceptance.resultSha256) {
    throw new CommandError(409, 'workspace_drift',
      'live workspace no longer matches the reviewed result — acceptance refused');
  }
  run.status = 'succeeded';
  run.phase = null;
  run.finishedAt = now;
  run.acceptedAt = now;
  stageRun(aggregate, run, ctx);
  return {
    aggregate, refreshProjection: true,
    result: { runId: run.id, status: 'succeeded', resultSha256: want },
  };
}


async function cmdRecordEvent(ctx, aggregate, payload, now) {
  const run = runOf(aggregate, reqStr(payload.runId, 'runId'));
  if (!run) throw new CommandError(404, 'run_not_found', `run ${payload.runId} does not exist`);
  const type = reqStr(payload.type, 'type');
  if (!EVENT_TYPE_RE.test(type)) {
    throw new CommandError(422, 'invalid_argument', `event type must match ${EVENT_TYPE_RE}`);
  }
  const data = payload.data === undefined ? null : payload.data;
  const bytes = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
  if (bytes > EVENT_MAX_BYTES) {
    throw new CommandError(413, 'event_too_large', `event data exceeds ${EVENT_MAX_BYTES} bytes`);
  }
  // Event authority: an event tied to an attempt requires that attempt's
  // owner instance; a run-level event requires the last attempt's owner
  // (or, before attempts exist, the bound workspace's env authority). A run
  // that has established no authority yet accepts diagnostic events from
  // any authenticated internal caller.
  // Resolved event context — the attempt this diagnostic is attributed to,
  // in scope for applyDiag below.
  let refAtt = null;
  if (payload.attemptId) {
    // Explicit attempt binding: EXACTLY that attempt's owner — never the
    // validation owner, never a predecessor.
    refAtt = findAttempt(run, reqStr(payload.attemptId, 'attemptId'));
    if (!refAtt) {
      throw new CommandError(404, 'attempt_not_found', `attempt ${payload.attemptId} unknown`);
    }
    if (!ownsResource(refAtt.owner, payload)) {
      throw new CommandError(409, 'not_attempt_owner',
        `events on ${refAtt.id} require its owner instance`);
    }
  } else {
    // Run-level event authority, in precedence order:
    //   1. the CURRENT validation reservation owner — after a dead-owner
    //      adoption it holds the run's execution duty even while stale
    //      attempt/workspace records still name the predecessor;
    //   2. the last attempt's owner;
    //   3. the bound workspace's env authority;
    //   (a run with no established authority accepts diagnostics from any
    //   authenticated internal caller).
    const v = run.validation;
    const vOwner = v && (v.status === 'active' || v.status === 'unproven')
      ? v.owner : null;
    refAtt = run.attempts[run.attempts.length - 1] ?? null;
    if (vOwner) {
      if (!ownsResource(vOwner, payload)) {
        throw new CommandError(409, 'not_validation_owner',
          'run-level events during an open validation require its owner instance');
      }
    } else if (refAtt) {
      if (!ownsResource(refAtt.owner, payload)) {
        throw new CommandError(409, 'not_attempt_owner',
          `events on ${refAtt.id} require its owner instance`);
      }
    } else if (run.workspaceId) {
      const ws = aggregate.workspaces?.[run.workspaceId];
      if (ws && ws.owner && !ownsResource(ws.owner, payload)) {
        throw new CommandError(409, 'not_workspace_owner',
          'run-level events require the bound workspace\u2019s owner instance');
      }
    }
  }
  const ev = { seq: run.eventsCursor ?? 0, at: now, type, data };
  run.eventsCursor = (run.eventsCursor ?? 0) + 1;
  // The aggregate is authoritative for events; runs/<id>.events.jsonl is a
  // canonical atomic projection rewritten on flush. A torn/partial file
  // cannot lose an accepted event — the aggregate replays it.
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push(ev);
  ctx.appendRunEvent(run.id, run.events);
  // Blocked/ambiguous diagnostics must be durable on the RUN record itself —
  // the attempt stays nonterminal (reservation retained), but the diagnosis
  // survives restarts and is queryable without paging through events.
  if (DIAG_EVENT_TYPES.has(type)) {
    applyDiag(run, type, data, refAtt?.id ?? null, now);
  }
  stageRun(aggregate, run, ctx);
  return { aggregate, result: { runId: run.id, seq: ev.seq } };
}

// --- presets --------------------------------------------------------------------

// Shape of the operator override (cli-compat.json) and the merged result:
// { cli: { models: [...], effort: [...]|null, params: [...] } }. A bare array
// value is also accepted as shorthand for {models: [...]}.
export function mergedCompat(override) {
  const out = {};
  for (const [cli, c] of Object.entries(CLI_COMPAT_SEED)) {
    out[cli] = { models: [...c.models], effort: c.effort ? [...c.effort] : null, params: [...c.params] };
  }
  if (override && typeof override === 'object') {
    for (const [cli, raw] of Object.entries(override)) {
      const o = Array.isArray(raw) ? { models: raw } : raw;
      if (!o || typeof o !== 'object') continue;
      if (!Object.prototype.hasOwnProperty.call(CLI_COMPAT_SEED, cli)) {
        // Overrides extend known CLIs only — a config cannot conjure a new
        // executor the deployment does not actually support.
        throw new RuntimeError('compat_invalid',
          `cli-compat.json names unknown cli ${JSON.stringify(cli)} (supported: ${Object.keys(CLI_COMPAT_SEED).join(', ')})`);
      }
      const cur = out[cli];
      if (Array.isArray(o.models)) {
        cur.models = [...new Set([...cur.models, ...o.models.filter((m) => typeof m === 'string' && m)])];
      }
      if (o.effort === null) cur.effort = null;
      else if (Array.isArray(o.effort)) {
        cur.effort = [...new Set([...(cur.effort || []), ...o.effort.filter((e) => typeof e === 'string' && e)])];
      }
      if (Array.isArray(o.params)) {
        cur.params = [...new Set([...cur.params, ...o.params.filter((p) => typeof p === 'string' && p)])];
      }
      out[cli] = cur;
    }
  }
  return out;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;

function validateMember(role, member, compat) {
  const tag = `members.${role}`;
  if (!isObj(member)) throw new CommandError(422, 'preset_invalid', `${tag} must be an object`);
  const cli = member.cli;
  if (!Object.prototype.hasOwnProperty.call(compat, cli)) {
    throw new CommandError(422, 'preset_incompatible',
      `${tag}.cli must be one of ${Object.keys(compat).join(', ')}`, { cli });
  }
  const c = compat[cli];
  const model = member.model;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    throw new CommandError(422, 'preset_invalid', `${tag}.model must match ${MODEL_RE}`);
  }
  if (!c.models.includes(model)) {
    throw new CommandError(422, 'preset_incompatible',
      `${tag}: model ${JSON.stringify(model)} is not registered for cli ${JSON.stringify(cli)}`,
      { cli, model, allowed: c.models });
  }
  // Effort is a per-CLI capability — devin encodes it in the model id, so a
  // separate effort field on a devin member is incompatible, not ignored.
  if (member.effort !== undefined) {
    if (!Array.isArray(c.effort) || !c.effort.includes(member.effort)) {
      throw new CommandError(422, 'preset_incompatible',
        `${tag}: cli ${JSON.stringify(cli)} does not support a separate effort setting` +
          (Array.isArray(c.effort) ? ` (allowed: ${c.effort.join(', ')})` : ' (effort is part of the model id)'),
        { cli, effort: member.effort });
    }
  }
  if (member.params !== undefined) {
    if (!isObj(member.params)) {
      throw new CommandError(422, 'preset_invalid', `${tag}.params must be an object when present`);
    }
    for (const [k, v] of Object.entries(member.params)) {
      if (!c.params.includes(k)) {
        throw new CommandError(422, 'preset_incompatible',
          `${tag}: param ${JSON.stringify(k)} is not supported for cli ${JSON.stringify(cli)}`,
          { cli, param: k, allowed: c.params });
      }
      if (!['string', 'number', 'boolean'].includes(typeof v)) {
        throw new CommandError(422, 'preset_invalid',
          `${tag}.params.${k} must be a string, number or boolean`);
      }
    }
  }
  const out = { cli, model };
  if (member.effort !== undefined) out.effort = member.effort;
  if (member.params !== undefined) out.params = member.params;
  return out;
}

export function validatePreset(input, compat, existingId) {
  if (!isObj(input)) throw new CommandError(422, 'preset_invalid', 'preset must be an object');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new CommandError(422, 'preset_invalid', 'preset.name is required');
  const members = input.members || {};
  const out = {
    id:
      existingId ||
      (typeof input.id === 'string' && SAFE_ID_RE.test(input.id) ? input.id : `preset_${randomUUID()}`),
    name,
    members: {
      implementer: validateMember('implementer', members.implementer, compat),
      reviewer: validateMember('reviewer', members.reviewer, compat),
      checker: validateMember('checker', members.checker, compat),
    },
    limits: {},
  };
  const limits = input.limits || {};
  const L = (key, def, min, max) => {
    const v = limits[key] === undefined ? def : Number(limits[key]);
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new CommandError(422, 'preset_invalid', `limits.${key} must be a number in [${min}, ${max}]`);
    }
    out.limits[key] = v;
  };
  L('maxAttemptsPerRole', 1, 1, 10);
  L('timeoutMin', 45, 1, 24 * 60);
  L('maxReviewRounds', 3, 1, 20);
  return out;
}

async function cmdSavePreset(ctx, aggregate, payload, now, compat) {
  const doc = await ctx.loadPresets();
  const preset = validatePreset(payload?.preset, compat);
  const idx = doc.presets.findIndex((p) => p && p.id === preset.id);
  if (idx >= 0) {
    preset.createdAt = doc.presets[idx].createdAt;
    preset.revision = (Number(doc.presets[idx].revision) || 0) + 1;
  } else {
    preset.createdAt = now;
    preset.revision = 1;
  }
  preset.updatedAt = now;
  if (idx >= 0) doc.presets[idx] = preset;
  else doc.presets.push(preset);
  doc.rev = (Number(doc.rev) || 0) + 1;
  doc.updatedAt = now;
  // Two effects: the registry upsert (staged, carries a durable intent so a
  // crash between the aggregate commit and the registry write is repaired,
  // never replayed over a newer registry entry) AND the card's composition —
  // a full snapshot, so later registry edits or deletion cannot change what
  // this card runs with.
  ctx.putPresets(doc, { type: 'preset_upsert', preset: structuredClone(preset) });
  aggregate.composition = { presetId: preset.id, preset: structuredClone(preset), boundAt: now };
  bumpControl(aggregate, now);
  return {
    aggregate,
    result: { presetId: preset.id, revision: preset.revision, composition: aggregate.composition },
  };
}

// --- environment ledger commands (global, not card-scoped) -------------------------
//
// `register_environment` only RECORDS identity — a registration can never
// retire a predecessor (two live containers may legitimately register the
// same slot; ledger.current changing proves a new registration, never the
// old container's death). `retire_environment` is the ONLY retirement path
// and is reachable exclusively over the ops credential (the host management
// helper verifies the exact container is stopped/removed through Docker
// lifecycle before posting); it must bind the exact recorded envInstance AND
// its registration generation — an unrecorded identity stays unknown.

function envRegister(doc, payload, now) {
  const slot = reqStr(payload.slot, 'slot');
  if (!SAFE_ID_RE.test(slot)) {
    throw new CommandError(422, 'invalid_argument', `slot must match ${SAFE_ID_RE}`);
  }
  const runnerId = reqStr(payload.runnerId, 'runnerId');
  const instanceId = reqStr(payload.instanceId, 'instanceId');
  const envInstance = normalizeEnvInstance(payload.envInstance);
  if (!envInstance?.containerId || !envInstance?.initStarttime) {
    throw new CommandError(422, 'invalid_argument',
      'envInstance requires {containerId, initStarttime} — an incomplete identity cannot coordinate retirement');
  }
  const envKey = payload.envKey ? normalizeEnvKey(payload.envKey) : null;
  const pid = Number.isInteger(payload.pid) && payload.pid > 0 ? payload.pid : null;
  const pidStarttime = typeof payload.pidStarttime === 'string' ? payload.pidStarttime : null;
  doc.slots ??= {};
  const cur = doc.slots[slot]?.current;
  if (cur && envInstanceEqual(cur.envInstance, envInstance)) {
    Object.assign(cur, {
      runnerId, instanceId,
      pid: pid ?? cur.pid ?? null,
      pidStarttime: pidStarttime ?? cur.pidStarttime ?? null,
      ...(envKey ? { envKey } : {}),
      lastSeenAt: now,
    });
    return { slot, generation: cur.generation, refreshed: true, superseded: false };
  }
  if (cur) {
    // History is NEVER evicted: an attempt records the owner's registration
    // generation, and retirement must resolve that exact identity for the
    // life of the store. Capping the list could push a long-lived old owner
    // past the window and make it permanently unretirable/unprovable.
    doc.slots[slot].history ??= [];
    doc.slots[slot].history.push({ ...cur, replacedAt: now });
  }
  const generation = (cur?.generation || 0) + 1;
  doc.slots[slot] = {
    ...(doc.slots[slot] || {}),
    history: doc.slots[slot]?.history ?? [],
    current: {
      envInstance, envKey, runnerId, instanceId, pid, pidStarttime,
      registeredAt: now, lastSeenAt: now, generation,
    },
  };
  return { slot, generation, refreshed: false, superseded: !!cur };
}

function envRetire(doc, payload, now) {
  const slot = reqStr(payload.slot, 'slot');
  if (!SAFE_ID_RE.test(slot)) {
    throw new CommandError(422, 'invalid_argument', `slot must match ${SAFE_ID_RE}`);
  }
  const by = reqStr(payload.by, 'by').slice(0, 128);
  const target = isObj(payload.target) ? payload.target : null;
  if (!target) {
    throw new CommandError(422, 'invalid_argument', 'target must be an object {envInstance, generation}');
  }
  const envInstance = normalizeEnvInstance(target.envInstance);
  if (!envInstance?.containerId || !envInstance?.initStarttime) {
    throw new CommandError(422, 'invalid_argument',
      'retirement must bind the exact recorded envInstance {containerId, initStarttime}');
  }
  const generation = Number(target.generation);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new CommandError(422, 'invalid_argument',
      'target.generation must be the recorded registration generation (integer >= 1)');
  }
  const s = doc.slots?.[slot];
  const entries = [s?.current, ...(s?.history || [])].filter(Boolean);
  const hit = entries.find(
    (e) => envInstanceEqual(e.envInstance, envInstance) && e.generation === generation);
  if (!hit) {
    throw new CommandError(409, 'environment_unknown',
      `no recorded environment ${envInstance.containerId}/${envInstance.initStarttime} `
      + `generation ${generation} under slot ${slot} — refusing to retire an unrecorded identity`);
  }
  const evidence = isObj(payload.evidence) ? payload.evidence : null;
  if (evidence?.source !== 'compose_lifecycle') {
    throw new CommandError(422, 'invalid_argument',
      'evidence.source must be compose_lifecycle (the only supported retirement provenance)');
  }
  if (evidence.containerId !== envInstance.containerId) {
    throw new CommandError(409, 'evidence_mismatch',
      'the ops-verified container id must equal the recorded envInstance.containerId');
  }
  if (evidence.state !== 'removed' && evidence.state !== 'stopped') {
    throw new CommandError(422, 'invalid_argument',
      'evidence.state must be removed|stopped — the helper must verify the container is actually gone');
  }
  if (!(typeof evidence.observedAt === 'number' && evidence.observedAt > 0)
    && !(typeof evidence.observedAt === 'string' && evidence.observedAt.length)) {
    throw new CommandError(422, 'invalid_argument',
      'evidence.observedAt is required — the retirement must record when removal was observed');
  }
  const existing = (doc.retirements || []).find((r) => r
    && envInstanceEqual(r.envInstance, envInstance)
    && r.generation === generation && r.slot === slot);
  if (existing) {
    return { slot, retirementId: existing.retirementId, idempotent: true, retiredAt: existing.retiredAt };
  }
  const rec = {
    retirementId: `ret_${randomUUID()}`,
    slot,
    envInstance,
    generation,
    by,
    evidence: {
      source: 'compose_lifecycle',
      containerId: envInstance.containerId,
      state: evidence.state,
      observedAt: evidence.observedAt,
      detail: typeof evidence.detail === 'string' ? evidence.detail.slice(0, 1000) : null,
    },
    retiredAt: now,
  };
  doc.retirements ??= [];
  doc.retirements.push(rec);
  hit.retiredAt = now;
  return { slot, retirementId: rec.retirementId, retiredAt: now };
}

// Applies one environment command to the ledger doc inside the serialized
// queue. Dedup by commandId+payloadHash mirrors the aggregate contract.
export function applyEnvCommand(doc, body, now = Date.now()) {
  if (!isObj(body)) {
    throw new CommandError(400, 'bad_command', 'command body must be an object');
  }
  const { commandId, type } = body;
  if (!GLOBAL_COMMANDS.has(type)) {
    throw new CommandError(400, 'bad_command', `unknown environment command ${JSON.stringify(type)}`);
  }
  if (typeof commandId !== 'string' || !COMMAND_ID_RE.test(commandId)) {
    throw new CommandError(400, 'bad_command', `commandId must match ${COMMAND_ID_RE}`);
  }
  const payload = isObj(body.payload) ? body.payload : {};
  const payloadHash = payloadHashOf(type, payload);
  doc.commands ??= {};
  const prior = doc.commands[commandId];
  if (prior) {
    if (prior.payloadHash === payloadHash) return { doc, response: prior.response, replayed: true };
    throw new CommandError(409, 'command_conflict',
      `commandId ${commandId} was already used with a different payload`);
  }
  const result = type === 'register_environment'
    ? envRegister(doc, payload, now) : envRetire(doc, payload, now);
  doc.commands[commandId] = { type, payloadHash, response: { ok: true, result }, at: now };
  doc.rev = (doc.rev || 0) + 1;
  doc.updatedAt = now;
  return { doc, response: { ok: true, result }, replayed: false };
}

// --- the dispatcher ------------------------------------------------------------------

// Applies one command inside the service's serialized queue. `channel` is
// transport-decided, NEVER taken from the body — the HTTP adapter is always
// 'user'; only the service's internal seam (not routed to sockets) may pass
// 'internal'. A body claiming channel 'internal' over user transport is
// rejected before any mutation.
export async function applyCardCommand(ctx, cardId, body, { channel = 'user' } = {}) {
  if (!isObj(body)) {
    throw new CommandError(400, 'bad_command', 'command body must be an object');
  }
  const { commandId, type } = body;
  if (channel !== 'internal' && body.channel === 'internal') {
    throw new CommandError(403, 'internal_forbidden',
      'the internal command channel is not reachable over the client API');
  }
  if (channel === 'internal' && !INTERNAL_COMMANDS.has(type)) {
    throw new CommandError(400, 'bad_command', `unknown internal command type ${JSON.stringify(type)}`);
  }
  const payload = isObj(body.payload) ? body.payload : {};
  const now = Date.now();

  // Internal types were already gated above; user channel validates here.
  const known = channel === 'internal' || COMMANDS.has(type);
  if (!known) {
    throw new CommandError(400, 'bad_command', `unknown ${channel} command type ${JSON.stringify(type)}`);
  }
  if (channel === 'user' && (typeof commandId !== 'string' || !COMMAND_ID_RE.test(commandId))) {
    throw new CommandError(400, 'bad_command', 'commandId must be a string matching ' + COMMAND_ID_RE);
  }
  if (commandId != null && (typeof commandId !== 'string' || !COMMAND_ID_RE.test(commandId))) {
    throw new CommandError(400, 'bad_command', 'commandId must match ' + COMMAND_ID_RE);
  }

  let aggregate = await ctx.loadAggregate(cardId);
  const payloadHash = commandId ? payloadHashOf(type, payload) : null;
  const dedupKey = channel === 'internal' && commandId ? `i:${commandId}` : commandId;

  if (channel === 'user') {
    if (type === 'enable') {
      if (aggregate) {
        const prior = aggregate.commands[commandId];
        if (prior) {
          if (prior.payloadHash === payloadHash) return replayed(prior);
          throw new CommandError(409, 'command_conflict',
            `commandId ${commandId} was already used with a different payload`);
        }
        throw new CommandError(409, 'already_managed', `card ${cardId} is already managed`);
      }
      if (body.expectedControlRevision !== undefined && body.expectedControlRevision !== 0) {
        throw new CommandError(409, 'revision_conflict',
          `expectedControlRevision ${body.expectedControlRevision} does not match 0 (card not managed)`,
          { controlRevision: 0 });
      }
    } else {
      if (!aggregate) throw new CommandError(404, 'card_not_found', `card ${cardId} is not managed`);
      // Idempotency precedes the revision check: a replayed commandId with
      // the same payload returns the recorded outcome whatever the current
      // revision is; the same id with a different payload conflicts.
      const prior = aggregate.commands[commandId];
      if (prior) {
        if (prior.payloadHash === payloadHash) return replayed(prior);
        throw new CommandError(409, 'command_conflict',
          `commandId ${commandId} was already used with a different payload`);
      }
      const want = body.expectedControlRevision;
      if (want === undefined || want === null || !Number.isInteger(want) || want < 0) {
        throw new CommandError(400, 'bad_command', 'expectedControlRevision (integer >= 0) is required');
      }
      if (want !== aggregate.controlRevision) {
        throw new CommandError(409, 'revision_conflict',
          `expectedControlRevision ${want} does not match current ${aggregate.controlRevision}`,
          { controlRevision: aggregate.controlRevision });
      }
    }
  } else {
    // internal channel — runner bookkeeping; never touches controlRevision.
    if (!aggregate) throw new CommandError(404, 'card_not_found', `card ${cardId} is not managed`);
    if (type === 'command_receipt') {
      // Narrow READ-ONLY dedup receipt lookup for journal replay — never
      // registers a command, never mutates, never requires CAS. Answers
      // "did this exact commandId+type+payload land?" by recomputing the
      // canonical payload hash server-side — the claimed original command's
      // type (a known command name) AND its payload object are REQUIRED;
      // an id-only or partially-claimed lookup is an argument error, never
      // a match. The stored result is exposed only on an exact match.
      const target = reqStr(payload.commandId, 'payload.commandId');
      if (!COMMAND_ID_RE.test(target)) {
        throw new CommandError(422, 'invalid_argument',
          `payload.commandId must match ${COMMAND_ID_RE}`);
      }
      const origType = reqStr(payload.type, 'payload.type');
      if (origType === 'command_receipt'
        || (!INTERNAL_COMMANDS.has(origType) && !COMMANDS.has(origType))) {
        throw new CommandError(422, 'invalid_argument',
          `payload.type must name a known command type — got ${JSON.stringify(payload.type)}`);
      }
      if (!isObj(payload.payload)) {
        throw new CommandError(422, 'invalid_argument',
          'payload.payload must be the original command payload object');
      }
      const wantHash = payloadHashOf(origType, payload.payload);
      const prior = aggregate.commands?.[`i:${target}`]
        ?? aggregate.commands?.[target] ?? null;
      const matched = !!prior && prior.payloadHash === wantHash;
      return {
        status: 200,
        body: {
          ok: true, cardId, internalRevision: aggregate.internalRevision,
          result: {
            exists: !!prior, matched,
            commandType: prior?.type ?? null,
            storedResult: matched ? (prior.body?.result ?? null) : null,
          },
        },
      };
    }
    if (dedupKey) {
      const prior = aggregate.commands[dedupKey];
      if (prior) {
        if (prior.payloadHash === payloadHash) return replayed(prior);
        throw new CommandError(409, 'command_conflict',
          `internal commandId ${commandId} was already used with a different payload`);
      }
    }
    const want = body.expectedInternalRevision;
    if (!Number.isInteger(want) || want < 0) {
      throw new CommandError(400, 'bad_command',
        'internal commands require expectedInternalRevision (integer >= 0)');
    }
    if (want !== aggregate.internalRevision) {
      throw new CommandError(409, 'revision_conflict',
        `expectedInternalRevision ${want} does not match current ${aggregate.internalRevision}`,
        { internalRevision: aggregate.internalRevision });
    }
  }

  // ---- dispatch ------------------------------------------------------------
  // Internal channel: real handlers inside the same serialized queue. They
  // move internalRevision (never controlRevision), stage run/event effects,
  // and follow the same pendingWrites->flush->clear pattern as user commands
  // so a mid-commit crash is repaired rather than lost.
  if (channel === 'internal') {
    // The U5 validation surface is default-OFF on the internal channel too —
    // a scheduler without the flag never sends these, but a stray caller
    // cannot drive them on a deployment that did not opt in.
    if (VALIDATION_INTERNAL.has(type) && ctx.features?.validation !== true) {
      throw new CommandError(501, 'command_unavailable',
        `internal command ${type} is gated off — validation requires ACP_EXEC_VALIDATION`);
    }
    if (FUSION_INTERNAL.has(type) && ctx.features?.fusion !== true) {
      throw new CommandError(501, 'command_unavailable',
        `internal command ${type} is gated off — the fusion panel requires ACP_EXEC_FUSION`);
    }
    if (PREPARATION_INTERNAL.has(type) && ctx.features?.preparation !== true) {
      throw new CommandError(501, 'command_unavailable',
        `internal command ${type} is gated off — idea preparation requires ACP_EXEC_PREPARATION`);
    }
    let outcome;
    switch (type) {
      case 'heartbeat':
        outcome = await cmdHeartbeat(ctx, aggregate, payload, now);
        break;
      case 'begin_workspace':
        outcome = await cmdBeginWorkspace(ctx, aggregate, payload, now, cardId);
        break;
      case 'adopt_workspace':
        outcome = await cmdAdoptWorkspace(ctx, aggregate, payload, now);
        break;
      case 'workspace_ready':
        outcome = await cmdWorkspaceReady(ctx, aggregate, payload, now);
        break;
      case 'workspace_failed':
        outcome = await cmdWorkspaceFailed(ctx, aggregate, payload, now);
        break;
      case 'begin_attempt':
        outcome = await cmdBeginAttempt(ctx, aggregate, payload, now, cardId);
        break;
      case 'bind_attempt':
        outcome = await cmdBindAttempt(ctx, aggregate, payload, now);
        break;
      case 'adopt_attempt':
        outcome = await cmdAdoptAttempt(ctx, aggregate, payload, now);
        break;
      case 'resolve_attempt':
        outcome = await cmdResolveAttempt(ctx, aggregate, payload, now);
        break;
      case 'cancel_attempt':
        outcome = await cmdCancelAttempt(ctx, aggregate, payload, now);
        break;
      case 'observe_attempt':
        outcome = await cmdObserveAttempt(ctx, aggregate, payload, now);
        break;
      case 'commit_artifact':
        outcome = await cmdCommitArtifact(ctx, aggregate, payload, now);
        break;
      case 'complete_run':
        outcome = await cmdCompleteRun(ctx, aggregate, payload, now);
        break;
      case 'begin_validation':
        outcome = await cmdBeginValidation(ctx, aggregate, payload, now);
        break;
      case 'record_snapshot':
        outcome = await cmdRecordSnapshot(ctx, aggregate, payload, now);
        break;
      case 'validation_progress':
        outcome = await cmdValidationProgress(ctx, aggregate, payload, now);
        break;
      case 'end_validation':
        outcome = await cmdEndValidation(ctx, aggregate, payload, now);
        break;
      case 'record_report':
        outcome = await cmdRecordReport(ctx, aggregate, payload, now);
        break;
      case 'record_event':
        outcome = await cmdRecordEvent(ctx, aggregate, payload, now);
        break;
      case 'panel_claim':
        outcome = await cmdPanelClaim(FUSION_DEPS, ctx, aggregate, payload, now);
        break;
      case 'panel_begin':
        outcome = await cmdPanelBegin(FUSION_DEPS, ctx, aggregate, payload, now);
        break;
      case 'panel_settle':
        outcome = await cmdPanelSettle(FUSION_DEPS, ctx, aggregate, payload, now);
        break;
      case 'judge_begin':
        outcome = await cmdJudgeBegin(FUSION_DEPS, ctx, aggregate, payload, now);
        break;
      case 'integrate_begin':
        outcome = await cmdIntegrateBegin(FUSION_DEPS, ctx, aggregate, payload, now);
        break;
      case 'record_integrate_result':
        outcome = await cmdRecordIntegrateResult(FUSION_DEPS, ctx, aggregate, payload, now);
        break;
      case 'annul_acceptance':
        outcome = await cmdAnnulAcceptance(FUSION_DEPS, ctx, aggregate, payload, now);
        break;
      case 'prep_result':
      case 'prep_question':
        outcome = await PREP_INTERNAL_HANDLERS[type](PREP_DEPS, ctx, aggregate, payload, now);
        break;
      default:
        throw new CommandError(400, 'bad_command', `unhandled internal command ${type}`);
    }
    aggregate = outcome.aggregate;
    if (outcome.refreshProjection) {
      const board = ctx.peekDoc('board.json') ?? (await ctx.getDoc('board.json'));
      const card = (board?.cards || []).find((c) => c && c.id === cardId) ?? null;
      aggregate.projection = computeProjection(aggregate, card, board);
      const nextBoard = structuredClone(board);
      nextBoard.cards = (nextBoard.cards || []).map((c) =>
        c && c.id === cardId ? { ...c, ...aggregate.projection } : c);
      aggregate.cardSnapshot = nextBoard.cards.find((c) => c && c.id === cardId) ?? aggregate.cardSnapshot;
      ctx.putDoc('board.json', nextBoard, { type: 'board_projection' });
    }
    aggregate.internalRevision += 1;
    aggregate.lastInternal = { type, at: now, runnerId: payload.runnerId ?? null };
    const intents = ctx.pendingIntents();
    aggregate.pendingWrites = intents.length ? intents : null;
    const resp = {
      ok: true, cardId,
      internalRevision: aggregate.internalRevision,
      result: outcome.result ?? null,
    };
    if (dedupKey) recordCommand(aggregate, dedupKey, type, payloadHash, 200, resp, now);
    await ctx.saveAggregate(aggregate);
    await ctx.flushStaged();
    if (intents.length) {
      aggregate.pendingWrites = null;
      await ctx.saveAggregate(aggregate);
    }
    return { status: 200, body: resp };
  }

  if (UNSUPPORTED_COMMANDS.has(type)
    && !(LAUNCH_GATED.has(type) && ctx.features?.start === true)
    && !(VALIDATION_GATED.has(type) && ctx.features?.validation === true)) {
    const body501 = {
      ok: false,
      error: LAUNCH_GATED.has(type)
        ? `command ${type} is gated off — managed execution requires the U5 readiness gate; `
          + 'the internal surface may be enabled for testing via ACP_EXEC_START=1'
        : VALIDATION_GATED.has(type)
          ? `command ${type} is gated off — managed acceptance requires the U5 validation surface`
          : `command ${type} is not available yet`,
      code: 'command_unavailable',
      command: type,
      ...(LAUNCH_GATED.has(type) ? { gate: 'ACP_EXEC_START' } : {}),
      ...(VALIDATION_GATED.has(type) ? { gate: 'ACP_EXEC_VALIDATION' } : {}),
    };
    recordCommand(aggregate, commandId, type, payloadHash, 501, body501, now);
    await ctx.saveAggregate(aggregate);
    return { status: 501, body: body501 };
  }

  if (FUSION_GATED.has(type) && ctx.features?.fusion !== true) {
    const body501 = {
      ok: false,
      error: `command ${type} is gated off — the fusion panel requires ACP_EXEC_FUSION`,
      code: 'command_unavailable',
      command: type,
      gate: 'ACP_EXEC_FUSION',
    };
    recordCommand(aggregate, commandId, type, payloadHash, 501, body501, now);
    await ctx.saveAggregate(aggregate);
    return { status: 501, body: body501 };
  }

  if (PREPARATION_GATED.has(type) && ctx.features?.preparation !== true) {
    const body501 = {
      ok: false,
      error: `command ${type} is gated off — idea preparation requires ACP_EXEC_PREPARATION`,
      code: 'command_unavailable',
      command: type,
      gate: 'ACP_EXEC_PREPARATION',
    };
    recordCommand(aggregate, commandId, type, payloadHash, 501, body501, now);
    await ctx.saveAggregate(aggregate);
    return { status: 501, body: body501 };
  }

  let outcome;
  switch (type) {
    case 'enable':
      outcome = await cmdEnable(ctx, cardId, payload, now);
      break;
    case 'start':
      outcome = await cmdStart(ctx, aggregate, payload, now);
      break;
    case 'stop':
      outcome = await cmdStop(ctx, aggregate, payload, now);
      break;
    case 'continue':
      outcome = await cmdContinue(ctx, aggregate, payload, now);
      break;
    case 'attach_document':
      outcome = await cmdAttachDocument(ctx, aggregate, payload, now);
      // P1: an attached version becomes the active session's presented
      // artifact and invalidates the gates bound to what it replaced. No-op
      // without an active session.
      prepAfterAttach(PREP_DEPS, outcome.aggregate, {
        kind: payload?.kind, version: outcome.result?.attached, now,
      });
      break;
    case 'approve_requirements':
      outcome = await cmdApproveRequirements(ctx, aggregate, payload, now);
      break;
    case 'approve_plan':
      outcome = await cmdApprovePlan(ctx, aggregate, payload, now);
      break;
    case 'change_requirements':
      outcome = await cmdChangeRequirements(ctx, aggregate, payload, now);
      // P1: the confirmed gates bound to the pre-change requirements/plan
      // are void — they must be re-confirmed against the replacement.
      prepAfterRequirementsChanged(PREP_DEPS, outcome.aggregate, now);
      break;
    case 'accept_result':
      outcome = await cmdAcceptResult(ctx, aggregate, payload, now);
      break;
    case 'save_preset':
      outcome = await cmdSavePreset(ctx, aggregate, payload, now, ctx.compat());
      break;
    case 'retry_participant':
      outcome = await cmdRetryParticipant(FUSION_DEPS, ctx, aggregate, payload, now);
      break;
    case 'exclude_panelist':
      outcome = await cmdExcludePanelist(FUSION_DEPS, ctx, aggregate, payload, now);
      break;
    case 'approve_work_order':
      outcome = await cmdApproveWorkOrder(FUSION_DEPS, ctx, aggregate, payload, now);
      break;
    case 'start_preparation':
    case 'answer_question':
    case 'request_draft':
    case 'continue_discussion':
    case 'stop_preparation':
    case 'change_skill_binding':
    case 'confirm_gate':
    case 'handoff_preparation':
      outcome = await PREP_HANDLERS[type](PREP_DEPS, ctx, aggregate, payload, now, cardId);
      break;
    default:
      throw new CommandError(400, 'bad_command', `unhandled command ${type}`);
  }

  aggregate = outcome.aggregate;
  if (outcome.refreshProjection) {
    const board = ctx.peekDoc('board.json') ?? (await ctx.getDoc('board.json'));
    const card = (board?.cards || []).find((c) => c && c.id === cardId) ?? null;
    aggregate.projection = computeProjection(aggregate, card, board);
    const nextBoard = structuredClone(board);
    nextBoard.cards = (nextBoard.cards || []).map((c) =>
      c && c.id === cardId ? { ...c, ...aggregate.projection } : c);
    aggregate.cardSnapshot = nextBoard.cards.find((c) => c && c.id === cardId) ?? aggregate.cardSnapshot;
    ctx.putDoc('board.json', nextBoard, { type: 'board_projection' });
  }

  // Durable pending intent: the aggregate records every staged external
  // effect BEFORE it is flushed, so a crash between the aggregate commit and
  // the board/claims/presets writes is repaired (semantically, idempotently)
  // instead of leaving a committed command whose effects never landed.
  const intents = ctx.pendingIntents();
  aggregate.pendingWrites = intents.length ? intents : null;

  const body200 = {
    ok: true,
    cardId,
    controlRevision: aggregate.controlRevision,
    result: outcome.result,
  };
  recordCommand(aggregate, commandId, type, payloadHash, 200, body200, now);
  await ctx.saveAggregate(aggregate);
  await ctx.flushStaged();
  if (intents.length) {
    aggregate.pendingWrites = null;
    await ctx.saveAggregate(aggregate);
  }
  return { status: 200, body: body200 };
}

function replayed(prior) {
  return {
    status: prior.status,
    body: { ...(prior.body || {}), idempotent: true },
  };
}

// --- legacy write guards (run inside the queue, before the CAS write) --------------

// Returns the board doc to write, or throws CommandError. For every managed
// card: the row must exist (deletion is refused) and server-owned fields are
// overlaid from the aggregate. `execution` is stripped from rows that are NOT
// managed — the marker is server-owned, never client data.
export async function mergeBoardWrite(ctx, incoming) {
  const managedIds = new Set(await listManagedCardIds(ctx.stateDir));
  const data = structuredClone(incoming ?? {});
  data.cards = Array.isArray(data.cards) ? data.cards : [];
  // A second row carrying a managed id would escape the overlay (the map
  // keeps one, the other survives forged). Refuse the whole write.
  const seen = new Map();
  for (const c of data.cards) {
    if (c && typeof c.id === 'string') seen.set(c.id, (seen.get(c.id) || 0) + 1);
  }
  for (const id of managedIds) {
    if ((seen.get(id) || 0) > 1) {
      throw new CommandError(409, 'duplicate_card_id',
        `board write carries ${seen.get(id)} rows for managed card ${id} — refused`,
        { cardId: id });
    }
  }
  const cardById = new Map(
    data.cards.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]),
  );
  for (const c of data.cards) {
    if (c && typeof c === 'object' && !managedIds.has(c.id) && 'execution' in c) {
      delete c.execution;
    }
  }
  for (const cardId of managedIds) {
    // loadAggregate fails closed on a corrupt existing aggregate — the board
    // write errors instead of silently unprotecting the card.
    const aggregate = await ctx.loadAggregate(cardId);
    const row = cardById.get(cardId);
    if (!row) {
      throw new CommandError(409, 'managed_card_deleted',
        `card ${cardId} is managed — deletion through the legacy board API is refused`,
        { cardId });
    }
    const patch = computeProjection(aggregate, row, data);
    const merged = { ...row, ...patch };
    const idx = data.cards.findIndex((c) => c === row);
    data.cards[idx] = merged;
    // Keep the disaster-restore snapshot fresh: it tracks the latest merged
    // row (user fields included) without touching either revision.
    if (!deepEqual(aggregate.cardSnapshot, merged)) {
      aggregate.cardSnapshot = merged;
      await ctx.saveAggregate(aggregate);
    }
  }
  return data;
}

// claims.json must not gain/change/drop an entry for a managed card — the
// only tolerated state is byte-identical to what is already stored.
export async function guardClaimsWrite(ctx, incoming, current) {
  const managedIds = await listManagedCardIds(ctx.stateDir);
  if (!managedIds.length) return incoming;
  const inClaims = incoming?.claims || {};
  const curClaims = current?.claims || {};
  const inAttempts = incoming?.attempts || {};
  const curAttempts = current?.attempts || {};
  for (const cardId of managedIds) {
    if (!deepEqual(inClaims[cardId], curClaims[cardId])) {
      throw new CommandError(409, 'managed_claim_protected',
        `claim entry for managed card ${cardId} cannot be changed through the legacy claims API`,
        { cardId });
    }
    if (!deepEqual(inAttempts[cardId], curAttempts[cardId])) {
      throw new CommandError(409, 'managed_claim_protected',
        `attempts entry for managed card ${cardId} cannot be changed through the legacy claims API`,
        { cardId });
    }
  }
  return incoming;
}

// board.json DELETE: refused while a managed card is present in the doc.
export async function guardBoardDelete(ctx, current) {
  const managedIds = await listManagedCardIds(ctx.stateDir);
  if (!managedIds.length) return;
  const cards = current?.cards || [];
  const present = managedIds.filter((id) => cards.some((c) => c && c.id === id));
  if (present.length) {
    throw new CommandError(409, 'managed_card_deleted',
      `board.json still carries managed card(s) ${present.join(', ')} — deletion refused`,
      { cardIds: present });
  }
}

export async function guardClaimsDelete(ctx, current) {
  const managedIds = await listManagedCardIds(ctx.stateDir);
  if (!managedIds.length) return;
  const present = managedIds.filter(
    (id) => (current?.claims || {})[id] !== undefined || (current?.attempts || {})[id] !== undefined,
  );
  if (present.length) {
    throw new CommandError(409, 'managed_claim_protected',
      `claims.json still references managed card(s) ${present.join(', ')} — deletion refused`,
      { cardIds: present });
  }
}

// --- projection repair (crash between aggregate and board write) -------------------

// Ensures board.json reflects every aggregate's projection: overlays managed
// fields on present rows, re-inserts missing rows from cardSnapshot, strips
// forged execution markers. Returns true when the doc was rewritten.
export async function repairBoardProjections(ctx) {
  const managedIds = new Set(await listManagedCardIds(ctx.stateDir));
  const board = structuredClone((await ctx.getDoc('board.json')) || { version: 2, cards: [] });
  if (!Array.isArray(board.cards)) board.cards = [];
  let changed = false;
  // Canonicalize duplicates of managed ids (first row wins, extras drop) —
  // the write path refuses them, this heals a doc that predates the guard.
  const seenManaged = new Set();
  board.cards = board.cards.filter((c) => {
    if (c && managedIds.has(c.id)) {
      if (seenManaged.has(c.id)) {
        changed = true;
        return false;
      }
      seenManaged.add(c.id);
    }
    return true;
  });
  for (const c of board.cards) {
    if (c && typeof c === 'object' && !managedIds.has(c.id) && 'execution' in c) {
      delete c.execution;
      changed = true;
    }
  }
  for (const cardId of managedIds) {
    const aggregate = await ctx.loadAggregate(cardId); // throws on corruption
    const idx = board.cards.findIndex((c) => c && c.id === cardId);
    if (idx === -1) {
      const seed = aggregate.cardSnapshot
        ? { ...aggregate.cardSnapshot, ...aggregate.projection }
        : { id: cardId, ...aggregate.projection };
      board.cards.push(seed);
      changed = true;
      continue;
    }
    const merged = { ...board.cards[idx], ...computeProjection(aggregate, board.cards[idx], board) };
    if (!deepEqual(board.cards[idx], merged)) {
      board.cards[idx] = merged;
      changed = true;
    }
  }
  if (changed) {
    board.version = 2;
    ctx.putDoc('board.json', board);
  }
  return changed;
}
