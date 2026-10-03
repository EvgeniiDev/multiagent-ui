// server/execution/preparation/lead.mjs — the single durable preparation
// lead driver (P3; plan KTD2, R2–R4, R6, R9–R10).
//
// One lead, one discussion: every live session has at most one driving
// state here; the discussion identity (session.discussion || prep-<id>)
// is the CLI session name across EVERY process — a respawned CLI session
// is the same discussion, never a second interview. The durable session
// (checkpoint, questions, attempts, bindings) is the source of truth; the
// CLI process is a replaceable renderer.
//
// Turn protocol (KTD2):
//   * a mid-turn native dialog (extension_ui_request) is minted durably via
//     prep_question BEFORE its rpc request id is bound; an answer recorded
//     by answer_question is delivered as extension_ui_response to THAT
//     request id on THAT process — never as another prompt;
//   * a question returned at turn end (result.questions, channel 'prompt')
//     is answered through the NEXT prompt;
//   * process loss mid-dialog: the durable question record is re-presented
//     by the resumed turn and REBOUND to the fresh rpc request id — the
//     stale id is never answered;
//   * a re-asked question whose answer is already recorded under the same
//     intent epoch dedupes to the existing record and the recorded answer
//     is delivered immediately — accepted answers are never re-asked;
//   * stale answers never mutate a stopped/superseded attempt — the
//     durable layer refuses them and this driver never sends them.
//
// Result contract: the lead's turn produces DATA ONLY — a fenced
// ```acp-prep JSON block on the final assistant text plus (for bound
// routes) real workspace artifacts. The payload is validated through the
// P2 result whitelist (assertResultChannels / translateResult) before it
// can reach prep_result; a bound workspace_artifact route's document is the
// REAL matched file, never a claimed text. Nothing the model emits is
// executed or treated as a command.
//
// Bounds: frames, turn wall-clock, idle-without-frames, process restarts,
// consecutive no-progress turns, and drive-loop steps are all bounded.
// Human waiting is never a runtime timeout: an unanswered dialog PARKS
// the drive entirely — no timer runs while the user thinks.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../common.mjs';
import {
  bindingById, bindingConfigDigest,
} from './skills/registry.mjs';
import {
  planInvocation, translateResult, assertResultChannels,
  PREPARATION_BRIDGE_PATH,
} from './skills/adapters.mjs';
import { preflightContract } from './skills/preflight.mjs';
import { defaultHostCapabilities } from './skills/capabilities.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const LEAD_DEFAULT_LIMITS = {
  turnTimeoutMs: 10 * 60_000,   // wall clock per prompt→settle turn
  idleTimeoutMs: 120_000,       // no frames from a live process while it works
  startTimeoutMs: 30_000,       // prompt sent, agent never started
  rpcTimeoutMs: 10_000,         // correlated rpc requests (get_state, …)
  maxFrames: 400,               // frames per pump() call
  maxDriveSteps: 24,            // iterations of the drive() loop
  noProgressLimit: 3,           // consecutive completed turns with nothing new
  maxRestarts: 2,               // CLI respawns per attempt
  docPromptBytes: 24 * 1024,    // presented-document text embedded per doc
  questionTailBytes: 4000,
  internalRetries: 8,           // CAS attempts per internal command
};

// The CLI dialog methods that are blocking questions (ask_user). Everything
// else pi may request is a non-interactive surface — honestly dismissed.
const UI_DIALOG_METHODS = new Set(['select', 'input', 'confirm', 'editor']);
// A stage hint per derived phase — which binding the next turn rides.
const PHASE_STAGE = {
  clarify: 'intent', requirements: 'requirements',
  design: 'design', plan: 'plan', ready: 'plan',
};

const ATTEMPT_LIVE = new Set(['running', 'awaiting_answer']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const tailOf = (s, n) => {
  const t = String(s ?? '');
  return t.length <= n ? t : `…${t.slice(-n)}`;
};

function questionTextOf(frame) {
  // ask_user → ctx.ui.select/confirm/input emit `title` as the question;
  // other dialog producers may use `question`/`message`.
  return String(frame.title ?? frame.question ?? frame.message ?? '').trim();
}

// Shape the extension_ui_response for a recorded answer. 'confirm' dialogs
// want a boolean — parse the recorded text; an answer that is neither
// clearly affirmative nor negative is passed through as {value} (the
// extension resolves it as "no answer", never a fabricated boolean).
export function uiResponseFor(answer, method) {
  const text = typeof answer === 'string' ? answer : String(answer?.text ?? '');
  if (method === 'confirm') {
    const t = text.trim();
    if (/^(y|yes|true|ok|okay|sure|confirm|approve|agree|proceed|да|конечно)\b/i.test(t)) {
      return { confirmed: true, value: text };
    }
    if (/^(n|no|false|cancel|decline|stop|нет|отмена)\b/i.test(t)) {
      return { confirmed: false, value: text };
    }
    return { value: text };
  }
  return { value: text };
}

// The lead's final text may carry one fenced ```acp-prep JSON result block
// — the same data-not-code pattern as ```acp-checks. At most one block;
// malformed JSON is evidence left in the note, not a turn result.
// JSON strings may contain Markdown fences (especially acp-checks in a
// development plan). Only standalone fence lines delimit the result.
const PREP_FENCE_RE = /^[ \t]*```acp-prep[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gm;
export function extractLeadResult(text) {
  const blocks = [...String(text ?? '').matchAll(PREP_FENCE_RE)].map((m) => m[1]);
  if (!blocks.length) return { present: false };
  if (blocks.length > 1) {
    return { present: true, malformed: `multiple acp-prep blocks (${blocks.length})` };
  }
  try {
    return { present: true, result: JSON.parse(blocks[0]) };
  } catch (e) {
    return { present: true, malformed: `acp-prep block is not valid JSON: ${e.message}` };
  }
}

const frameText = (f) => {
  const msg = f?.message;
  if (Array.isArray(msg?.content)) {
    const t = msg.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text).join('\n');
    if (t.trim()) return t;
  }
  return typeof f?.text === 'string' && f.text.trim() ? f.text : null;
};

// A turn that ended without a structured block may still end ON a question
// in plain chat — the durable record is better than a lost ask. Conservative:
// only when the turn minted nothing else, and only the question-bearing tail.
function tailQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const tail = t.split(/\n{2,}|\n/).pop().trim();
  if (!/\?\s*$/.test(tail)) return null;
  return tailOf(tail, 4000);
}

// Consecutive terminal turns that added nothing new — the durable record of
// a no-progress loop, so a restarted driver sees the same count. Counts only
// 'completed' attempts; a cancelled attempt is user steering, not lead
// no-progress; a failed/blocked attempt already surfaces its own record.
export function trailingNoProgress(view) {
  let n = 0;
  // newest → oldest: count consecutive COMPLETED turns that added nothing.
  // Live attempts (the one about to be driven) and cancelled/steered ones
  // are skipped without breaking the streak — the no-progress evidence is
  // the completed turns themselves.
  for (const a of [...(view?.attempts ?? [])].reverse()) {
    if (a.status === 'completed') {
      if (a.progress === false) n += 1;
      else break;
    }
  }
  return n;
}

export function stageForAttempt(view, attempt) {
  if (attempt?.docKind) return attempt.docKind;
  return PHASE_STAGE[view?.phase] ?? 'intent';
}

const sanitizeName = (s) =>
  String(s ?? '').replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 80) || 'prep';

export function discussionName(view) {
  return sanitizeName(view?.discussion || `prep-${view?.sessionId ?? 'x'}`);
}

// ---------------------------------------------------------------------------
// Runtime dirs + the unbound-lead invocation plan
// ---------------------------------------------------------------------------

// Where a session's CLI/discussion runtime state lives. The caller supplies
// the root (state dir in production, tmp in tests). One dir per session —
// the discussion identity is stable across CLI session changes.
export function prepRunDirs(root, sessionId) {
  const base = path.join(path.resolve(root), sanitizeName(sessionId));
  return {
    workspace: path.join(base, 'workspace'),
    sessionDir: path.join(base, 'pi-sessions'),
    agentDir: path.join(base, 'pi-agent'),
    transcriptPath: path.join(base, 'transcript.jsonl'),
    auditPath: path.join(base, 'audit.jsonl'),
  };
}

async function ensureRunDirs(dirs, { gitInit = true } = {}) {
  for (const d of [dirs.workspace, dirs.sessionDir, dirs.agentDir]) {
    await fs.mkdir(d, { recursive: true });
  }
  if (gitInit !== false) {
    try {
      await fs.mkdir(path.join(dirs.workspace, '.git'), { recursive: false });
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['-C', dirs.workspace, 'init', '-q'], { timeout: 10_000 });
      execFileSync('git', ['-C', dirs.workspace, '-c', 'user.email=prep@acp', '-c', 'user.name=prep',
        'commit', '-qm', 'init', '--allow-empty'], { timeout: 10_000 });
    } catch { /* git init is a convenience for ce-* scratch, never required */ }
  }
  return dirs;
}

// The plain-lead invocation: pi --mode rpc with the preparation bridge
// (ask_user + containment) and NO skills — the lead works the discussion
// itself. The document workspace is writable; the project root mounts
// read-only when supplied (preparation roles never edit the project).
export function leadPlan({
  piBinary = 'pi', model = {}, sessionDir, agentDir, workspace,
  auditPath = null, extensionPath = PREPARATION_BRIDGE_PATH,
  name = 'prep-lead', readOnlyRoots = [],
} = {}) {
  const ws = path.resolve(workspace);
  const writeRoots = [ws];
  const readRoots = [...new Set([ws, ...readOnlyRoots.map((r) => path.resolve(r))])];
  const args = [
    '--mode', 'rpc',
    ...(model.provider ? ['--provider', model.provider] : []),
    ...(model.id ? ['--model', model.id] : []),
    ...(model.thinking ? ['--thinking', model.thinking] : []),
    '--session-dir', sessionDir,
    '--name', name,
    '--no-extensions', '-e', extensionPath,
    '--no-skills',
    '--no-context-files', '--no-prompt-templates', '--no-themes', '-na',
    '--tools', 'read,bash',
  ];
  const env = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: '1',
    ACP_PREP_WRITE_ROOTS: JSON.stringify(writeRoots),
    ACP_PREP_READ_ROOTS: JSON.stringify(readRoots),
    ACP_PREP_BINDING: 'lead',
  };
  if (auditPath) env.ACP_PREP_AUDIT = auditPath;
  return {
    command: piBinary, args, cwd: ws, env,
    roots: { workspaceRoot: ws, writeRoots, readRoots },
    skillDirs: [],
  };
}

// ---------------------------------------------------------------------------
// Prompt composition — the durable session state rendered for the lead.
// Every turn prompt carries: goal/stage/documents/decisions/checkpoint/new
// answers. The SAME discussion continues regardless of which CLI process
// renders it.
// ---------------------------------------------------------------------------

const SECTION_CAP = 48 * 1024;

function pushSection(lines, title, body) {
  if (body === null || body === undefined || body === '') return;
  const b = typeof body === 'string' ? body : String(body);
  lines.push(`## ${title}`, '', tailOf(b, SECTION_CAP), '');
}

export function composeLeadPrompt({
  view, attempt, stage, binding, resume, newAnswers = [], docTexts = {},
  skillTrigger = null,
}) {
  const lines = [];
  const s = view;
  lines.push('# Idea preparation — one durable discussion', '');
  if (resume) {
    lines.push(
      'NOTE: the CLI session for this discussion was replaced/restarted. ' +
      'The checkpoint below is the durable record — CONTINUE this same ' +
      'discussion. Do not re-ask questions that already have recorded ' +
      'answers; open questions are still awaiting the user.');
    lines.push('');
  }
  lines.push(
    'You are the single discussion lead for this card. There is exactly ' +
    'one conversation with the user — questions you ask become durable ' +
    'records answered asynchronously.');
  lines.push('');

  pushSection(lines, 'Goal (raw intent)', s.intent?.raw);
  if (s.intent?.current && s.intent.current.text !== s.intent?.raw) {
    pushSection(lines, 'Current intent restatement', s.intent.current.text);
  }
  if (s.intent?.proposal) {
    pushSection(lines, 'Proposed restatement awaiting user confirmation', s.intent.proposal.text);
  }

  const stageLine = [
    `phase: ${s.phase}`, `attempt: ${attempt.attemptId} (${attempt.kind})`,
    `stage: ${stage}`,
    binding ? `skill binding: ${binding.bindingId}@${String(binding.resourceManifest?.digest ?? '').slice(0, 12)}` : 'no skill bound for this stage — you are the lead',
  ].join('; ');
  pushSection(lines, 'Stage', stageLine);
  if (attempt.docKind) {
    pushSection(lines, 'Requested draft', `The user asked for a ${attempt.docKind} document.`);
  }
  if (attempt.input) {
    pushSection(lines, 'User instruction for this turn', attempt.input);
  }

  // Current documents — the presented set with content where the host can
  // supply it (bounded).
  const presented = s.presented ?? {};
  const kinds = ['requirements', 'design', 'plan'];
  const docList = kinds
    .map((k) => {
      const p = presented[k];
      if (!p) return `- ${k}: (none presented)`;
      return `- ${k}: ${p.versionId} sha256=${String(p.sha256).slice(0, 16)}…` +
        `${p.draft ? ' draft' : ''} via ${p.via}`;
    })
    .join('\n');
  pushSection(lines, 'Current documents', docList);
  for (const k of kinds) {
    const p = presented[k];
    if (!p) continue;
    const text = docTexts[k];
    if (typeof text === 'string' && text) {
      pushSection(lines, `${k} ${p.versionId} — current content`,
        tailOf(text, LEAD_DEFAULT_LIMITS.docPromptBytes));
    }
  }

  const cp = s.checkpoint ?? {};
  if (cp.decisions?.length) {
    pushSection(lines, 'Decisions (durable record — do not revisit)',
      cp.decisions.slice(-80).map((d) => `- ${d.text}`).join('\n'));
  }
  if (cp.assumptions?.length) {
    pushSection(lines, 'Assumptions',
      cp.assumptions.slice(-80).map((a) => `- ${a.text}`).join('\n'));
  }
  const questions = cp.openQuestions ?? [];
  if (questions.length) {
    const body = questions.slice(-120).map((q) => {
      const st = q.status === 'answered' ? `answered → ${q.answer}`
        : q.status === 'open' ? 'OPEN — awaiting the user'
        : q.status;
      return `- [${q.status === 'open' ? 'open' : q.status}] ${q.text}\n  ${st}`;
    }).join('\n');
    pushSection(lines, 'Questions — every ask is a durable record', body);
  }

  if (newAnswers.length) {
    pushSection(lines, 'Answers recorded since your last turn',
      newAnswers.map((q) => `- ${q.text}\n  → ${q.answer}`).join('\n'));
  }

  // The output contract — data only.
  const contract = [
    'End this turn with exactly one fenced block reporting its outcome:',
    '',
    '```acp-prep',
    '{"note":"what happened","questions":[{"text":"…","blocking":true}],' +
      '"decisions":["…"],"assumptions":["…"],"proposal":{"intentRestatement":"…"},' +
      '"blocker":{"code":"…","detail":"…"}}',
    '```',
    '',
    '- Omit empty keys. A turn that adds nothing is no-progress — the host ' +
      'counts consecutive no-progress turns and stops the discussion.',
    '- NEVER re-ask a question with a recorded answer. A question listed ' +
      'under "questions" is returned after this turn ends and is answered ' +
      'in the NEXT prompt; a blocking question you need answered NOW goes ' +
      'through the ask_user dialog, not the block.',
    binding?.result?.importAs && binding.result.importAs !== 'none'
      ? `- This route's document is a WORKSPACE ARTIFACT: write the real file ` +
        `under ${(binding.result.artifacts ?? []).join(', ') || 'the workspace'} — ` +
        'the host imports the file itself; a document claim without the file is dropped.'
      : '- To return a document directly use {"document":{"kind":"requirements|design|plan","text":"…","draft":true}}.',
    '- A "blocker" ends the turn with a structured cannot-proceed reason. ' +
      'Use it only when you cannot advance at all.',
    '- The block is DATA for the host — never emit commands, tool calls, or ' +
      'other top-level keys.',
  ].join('\n');
  pushSection(lines, 'Output contract (data only)', contract);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Glob → RegExp (artifact matching; same pattern set as the P0 probe)
// ---------------------------------------------------------------------------

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '').replace(/\*/g, '[^/]*').replace(//g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

async function listFilesRec(root, cap = 2000) {
  const out = [];
  const walk = async (dir, rel) => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= cap) return;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk(root, '');
  return out;
}

// ---------------------------------------------------------------------------
// Service bindings — how the driver reaches the durable layer.
// `internal` commands are CAS'd on internalRevision with bounded retries.
// ---------------------------------------------------------------------------

// In-process binding for tests and an in-process runner: drives the REAL
// createStateService request surface + internalCommand seam.
export function serviceFromService(svc) {
  const getJson = async (p) => svc.request({
    method: 'GET', path: p, query: new URLSearchParams(),
  });
  return {
    async view(cardId) {
      const r = await getJson(`/api/execution/cards/${cardId}/preparation`);
      if (r.status === 404) return null;
      if (r.status !== 200) {
        throw new RuntimeError('service_error',
          `GET preparation -> ${r.status}: ${r.json?.error ?? 'unknown'}`);
      }
      return r.json.preparation ?? null;
    },
    async internal(cardId, type, payload) {
      const L = LEAD_DEFAULT_LIMITS;
      for (let i = 0; i < L.internalRetries; i++) {
        const card = await getJson(`/api/execution/cards/${cardId}`);
        if (card.status !== 200) {
          throw new RuntimeError('service_error', `GET card -> ${card.status}`);
        }
        const r = await svc.internalCommand(cardId, {
          commandId: `p3-${randomUUID()}`,
          type,
          expectedInternalRevision: card.json.internalRevision,
          payload,
        });
        if (r.status === 200) return r.body.result;
        const code = r.body?.code ?? 'internal_error';
        if (code === 'revision_conflict' && i + 1 < L.internalRetries) continue;
        const err = new RuntimeError(code, r.body?.error ?? `internal ${type} -> ${r.status}`);
        err.status = r.status;
        err.details = r.body;
        throw err;
      }
      throw new RuntimeError('revision_conflict', 'internal command lost the CAS race repeatedly');
    },
    async readDocument(cardId, versionId) {
      const r = await getJson(
        `/api/execution/cards/${cardId}/documents/${versionId}`);
      if (r.status !== 200) return null;
      return typeof r.json.content === 'string' ? r.json.content : null;
    },
  };
}

// Runner-side binding over the authenticated internal transport client
// (createInternalClient) — the same reads/commands over HTTP.
export function serviceFromClient(client) {
  return {
    async view(cardId) {
      const r = await client.getPreparation(cardId).catch((e) => {
        if (e?.status === 404) return null;
        throw e;
      });
      return r?.preparation ?? null;
    },
    async internal(cardId, type, payload) {
      const L = LEAD_DEFAULT_LIMITS;
      for (let i = 0; i < L.internalRetries; i++) {
        const card = await client.getCard(cardId);
        try {
          const r = await client.command(cardId, {
            commandId: `p3-${randomUUID()}`,
            type,
            expectedInternalRevision: card.internalRevision,
            payload,
          });
          return r.result;
        } catch (e) {
          if (e?.code === 'revision_conflict' && i + 1 < L.internalRetries) continue;
          throw e;
        }
      }
      throw new RuntimeError('revision_conflict', 'internal command lost the CAS race repeatedly');
    },
    async readDocument(cardId, versionId) {
      const d = await client.getDocument(cardId, versionId).catch(() => null);
      return typeof d?.content === 'string' ? d.content : null;
    },
  };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export function createPreparationLead({
  service,            // {view, internal, readDocument}
  registry,           // () => registry (sync/async) — binding truth
  dirsFor,            // (view) => {workspace, sessionDir, agentDir, ...}
  transportFactory,   // (plan, ctx) => transport — injected (pi-rpc or fake)
  verify = null,      // (binding) => manifest re-verify (fail-closed); null → planInvocation's own checks only
  adapters,           // adapter map override (planInvocation seam)
  model = {},
  piBinary = 'pi',
  extensionPath = PREPARATION_BRIDGE_PATH,
  hostCapabilities = defaultHostCapabilities(),
  readOnlyRoots = [], // e.g. the card's project root — read-only mount
  limits = {},
  now = () => Date.now(),
} = {}) {
  const L = { ...LEAD_DEFAULT_LIMITS, ...limits };
  const sessions = new Map();   // sessionId -> runtime state
  const cardToSession = new Map();
  const chains = new Map();     // cardId -> drive() serialization

  const sessionState = (view, cardId) => {
    let st = sessions.get(view.sessionId);
    if (!st) {
      st = {
        sessionId: view.sessionId,
        transport: null,
        planKey: null,
        binding: null,          // binding object the live process runs under
        dirs: null,
        stage: null,
        attemptId: null,
        turnInFlight: false,
        sawStart: false,
        lastText: '',
        pending: new Map(),        // rpc requestId -> {questionId, method}
        mintedThisTurn: new Set(), // questionIds minted since the last prompt
        promptsSent: 0,
        restarts: 0,
        drivenAttempts: new Set(),
        sentAnswers: new Set(),    // answers already carried by a prompt on THIS process
        dismissedUi: 0,
      };
      sessions.set(view.sessionId, st);
    }
    cardToSession.set(cardId, view.sessionId);
    return st;
  };

  const teardown = async (st) => {
    const t = st.transport;
    st.transport = null;
    st.turnInFlight = false;
    st.pending.clear();
    if (t) {
      try { await t.abort?.(); } catch { /* gone */ }
      try { await t.close?.(); } catch { /* gone */ }
    }
  };

  // ---- internal command helpers -------------------------------------------

  const internal = async (cardId, type, payload) =>
    service.internal(cardId, type, payload);

  const deliverResult = async (cardId, attemptId, body) => {
    const r = await internal(cardId, 'prep_result', { attemptId, ...body });
    return r ?? { applied: false, reason: 'no_response' };
  };

  // ---- plan resolution ----------------------------------------------------

  async function resolvePlan(view, attempt) {
    const stage = stageForAttempt(view, attempt);
    const ref = view.bindings?.[stage] ?? null;
    const dirs = await ensureRunDirs(dirsFor(view));
    const name = discussionName(view);
    // The card's own project is read-only context for every lead turn —
    // preparation may ground questions in project state, never write it
    // (KTD7). A missing root is omitted, not a spawn failure.
    const projectRoots = (view.projectPath && existsSync(view.projectPath))
      ? [view.projectPath] : [];
    if (!ref) {
      return {
        key: 'lead', stage, binding: null, dirs,
        plan: leadPlan({
          piBinary, model, sessionDir: dirs.sessionDir, agentDir: dirs.agentDir,
          workspace: dirs.workspace, auditPath: dirs.auditPath ?? null,
          extensionPath, name,
          readOnlyRoots: [...readOnlyRoots, ...projectRoots],
        }),
      };
    }
    const reg = typeof registry === 'function' ? await registry() : registry;
    const binding = bindingById(reg, ref.bindingId);           // unknown_binding
    // The full contract recheck at drive time: route availability, adapter
    // presence/compatibility, capability satisfaction, pinned resources.
    preflightContract(binding, { hostCapabilities, adapters }); // route_unproven/adapter_*/capability_missing
    if ((binding.resourceManifest?.digest ?? null) !== ref.digest) {
      throw new RuntimeError('binding_digest_changed',
        `binding ${ref.bindingId} repinned since assignment — migrate via change_skill_binding`,
        { bindingId: ref.bindingId });
    }
    if (ref.configDigest != null && bindingConfigDigest(binding) !== ref.configDigest) {
      throw new RuntimeError('binding_config_changed',
        `binding ${ref.bindingId} contract changed since assignment — migrate via change_skill_binding`,
        { bindingId: ref.bindingId });
    }
    if (verify) await verify(binding);                          // resource_mismatch …
    const plan = planInvocation(binding, {
      piBinary, model,
      sessionDir: dirs.sessionDir, agentDir: dirs.agentDir,
      workspace: dirs.workspace, auditPath: dirs.auditPath ?? null,
      extensionPath, name, adapters,
      extraReadRoots: projectRoots,
    });
    return {
      key: `binding:${ref.bindingId}@${ref.digest}/${ref.configDigest ?? '-'}`,
      stage, binding, dirs, plan,
    };
  }

  // ---- turn pump -----------------------------------------------------------

  async function pump(st, ctx) {
    const deadline = now() + L.turnTimeoutMs;
    let frames = 0;
    for (;;) {
      if (++frames > L.maxFrames) return { kind: 'frame_cap' };
      const left = deadline - now();
      if (left <= 0) return { kind: 'turn_timeout' };
      const wait = st.sawStart
        ? Math.min(L.idleTimeoutMs, left)
        : Math.min(L.startTimeoutMs, left);
      const item = await st.transport.nextFrame(wait);
      if (item.exited) return { kind: 'exited', exit: item.exited };
      if (item.timeout) {
        return { kind: st.sawStart ? 'idle_timeout' : 'never_started' };
      }
      const f = item.frame;
      switch (f.type) {
        case 'agent_start':
        case 'turn_start':
          st.sawStart = true;
          break;
        case 'turn_end':
        case 'turn_boundary': {
          const t = frameText(f);
          if (t) st.lastText = t;
          break;
        }
        case 'extension_ui_request': {
          const r = await uiRequest(st, ctx, f);
          if (r.park) return { kind: 'awaiting_user', questionId: r.questionId };
          if (r.superseded) return { kind: 'superseded', reason: r.reason };
          break;
        }
        case 'agent_settled':
        case 'agent_end': {
          // A settle frame is authoritative only when get_state confirms the
          // agent loop is actually idle (probed: response may beat agent_start).
          try {
            const gs = typeof st.transport.getState === 'function'
              ? await st.transport.getState(L.rpcTimeoutMs) : null;
            if (!gs || gs.isStreaming !== true) return { kind: 'settled' };
          } catch {
            return { kind: 'settled' };
          }
          break;
        }
        case 'tool_execution_end':
        case 'extension_error':
          if (f.type === 'extension_error') {
            st.extensionErrors = (st.extensionErrors ?? 0) + 1;
          }
          break;
        default:
          break; // every other frame is evidence, not control
      }
    }
  }

  async function uiRequest(st, ctx, frame) {
    const method = typeof frame.method === 'string' ? frame.method : '';
    if (!UI_DIALOG_METHODS.has(method)) {
      // Non-interactive UI surfaces (notify/setStatus/setWidget/…) — the host
      // does not render them; dismiss honestly so the tool resolves as
      // "no answer", never a fabricated value.
      st.dismissedUi += 1;
      await st.transport.respond(frame.id, { cancelled: true }).catch(() => {});
      return { park: false };
    }
    const text = questionTextOf(frame);
    if (!text) {
      await st.transport.respond(frame.id, { cancelled: true }).catch(() => {});
      return { park: false };
    }
    const options = Array.isArray(frame.options)
      ? frame.options.slice(0, 24).map((o) =>
        typeof o === 'string' ? o : String(o?.label ?? o?.value ?? '')).filter(Boolean)
      : undefined;
    const res = await internal(ctx.cardId, 'prep_question', {
      attemptId: st.attemptId,
      question: {
        text, blocking: true, channel: 'dialog',
        dialog: { requestId: frame.id, method, ...(options ? { options } : {}) },
      },
    });
    // The attempt is gone (stopped/superseded) — the durable layer refused;
    // this process's output is stale from here on.
    if (!res || !res.questionId) {
      return { superseded: true, reason: res?.reason ?? 'refused' };
    }
    st.mintedThisTurn.add(res.questionId);
    if (res.answered === true) {
      // The checkpoint already holds this answer — deliver it to THIS fresh
      // rpc request immediately; the recovered answer never re-asks.
      await st.transport.respond(frame.id, uiResponseFor(res.answer, method)).catch(() => {});
      return { park: false, questionId: res.questionId };
    }
    st.pending.set(frame.id, { questionId: res.questionId, method });
    return { park: true, questionId: res.questionId };
  }

  // ---- result assembly ------------------------------------------------------

  // Snapshot the declared artifact set before a turn — rel path → mtime.
  // At settle, a matching file counts as THIS turn's output only when it is
  // new or its mtime advanced past the baseline; a file the turn inherited
  // unchanged is stale evidence, not output.
  async function artifactBaseline(workspace, globs) {
    const map = new Map();
    if (!workspace || !Array.isArray(globs) || !globs.length) return map;
    const files = await listFilesRec(workspace).catch(() => []);
    for (const rel of files) {
      if (!globs.some((g) => globToRe(g).test(rel))) continue;
      const stt = await fs.stat(path.join(workspace, rel)).catch(() => null);
      if (stt?.isFile()) map.set(rel, stt.mtimeMs);
    }
    return map;
  }

  async function findContractArtifact(workspace, globs, baseline = null) {
    if (!workspace || !Array.isArray(globs) || !globs.length) return null;
    const files = await listFilesRec(workspace).catch(() => []);
    const matches = [];
    for (const rel of files) {
      if (globs.some((g) => globToRe(g).test(rel))) matches.push(rel);
    }
    if (!matches.length) return null;
    let best = null;
    for (const rel of matches) {
      const p = path.join(workspace, rel);
      const stt = await fs.stat(p).catch(() => null);
      if (!stt?.isFile()) continue;
      if (baseline && baseline.has(rel) && !(stt.mtimeMs > baseline.get(rel))) continue;
      if (!best || stt.mtimeMs > best.mtimeMs) best = { path: p, rel, mtimeMs: stt.mtimeMs };
    }
    if (!best) return null;
    const raw = await fs.readFile(best.path, 'utf8').catch(() => null);
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return { rel: best.rel, text: raw.length > 512 * 1024 ? raw.slice(0, 512 * 1024) : raw };
  }

  // Assemble the settled turn's result and deliver it through prep_result.
  async function deliverSettled(st, ctx) {
    const { cardId } = ctx;
    const binding = st.binding;
    const workspace = st.dirs?.workspace ?? null;
    const attemptId = st.attemptId;
    let lastText = st.lastText ?? '';
    if (typeof st.transport.request === 'function') {
      try {
        const lt = await st.transport.request('get_last_assistant_text', {}, L.rpcTimeoutMs);
        if (lt?.success && typeof lt?.data?.text === 'string' && lt.data.text) {
          lastText = lt.data.text;
        }
      } catch { /* capture stays with turn_end text */ }
    }
    st.turnInFlight = false;
    st.lastText = '';
    const block = extractLeadResult(lastText);
    const raw = block.present && !block.malformed ? block.result : { note: lastText || null };

    let result;
    try {
      if (binding) {
        // Bound route — the P2 contract enforcement path.
        result = translateResult(binding, raw).result;
      } else {
        // Unbound lead — same whitelist, no route contract.
        assertResultChannels(raw);
        result = {};
        for (const k of ['note', 'questions', 'decisions', 'assumptions',
          'document', 'proposal', 'handoff', 'blocker']) {
          if (raw[k] !== undefined) result[k] = raw[k];
        }
      }
    } catch (e) {
      // Refused at the injection boundary — the turn failed, nothing applied.
      return deliverResult(cardId, attemptId, {
        outcome: 'failed',
        result: { note: `${e.code ?? 'result_error'}: ${e.message}` },
      });
    }

    // A workspace_artifact route's document is the real file — the model's
    // fenced document claim is dropped when the declared artifact is absent.
    const contract = binding?.result ?? null;
    if (contract?.mode === 'workspace_artifact' && contract.importAs && contract.importAs !== 'none') {
      const art = await findContractArtifact(
        workspace, contract.artifacts ?? [], st.artifactBaseline ?? null);
      if (art) {
        result.document = { kind: contract.docKind, text: art.text };
        result.note = [result.note, `[imported artifact ${art.rel}]`].filter(Boolean).join('\n');
      } else if (result.document) {
        result.note = [result.note,
          `[dropped document claim — no declared artifact under ${(contract.artifacts ?? []).join(', ')}]`]
          .filter(Boolean).join('\n');
        delete result.document;
      }
    }

    // A settled turn that asked something in plain chat (no block, no
    // dialogs minted, nothing else) still mints the question — as a
    // post-turn 'prompt' question answered by the next prompt.
    if (!block.present && !st.mintedThisTurn.size && !result.document
        && !result.proposal && !(result.questions ?? []).length) {
      const q = tailQuestion(lastText);
      if (q) result.questions = [{ text: q, blocking: false }];
    }
    st.mintedThisTurn.clear();

    const outcome = result.blocker ? 'blocked' : 'completed';
    return deliverResult(cardId, attemptId, { outcome, result });
  }

  // ---- the drive loop -------------------------------------------------------

  async function deliverPendingAnswers(st, ctx) {
    // Route every recorded answer to the rpc request it belongs to — the
    // same request id, the same process, the same attempt. Anything stale
    // (rebound/vanished record, deferred) is handled honestly and never
    // answered for another attempt.
    const view = ctx.view;
    const qById = new Map(
      (view.checkpoint?.openQuestions ?? []).map((q) => [q.questionId, q]));
    for (const [rpcId, dlg] of [...st.pending]) {
      const q = qById.get(dlg.questionId);
      if (!q || q.attemptId !== st.attemptId) {
        // The durable record moved to another attempt or vanished — this
        // dialog is dead; never confirm it from a stale binding.
        st.pending.delete(rpcId);
        await st.transport.respond(rpcId, { cancelled: true }).catch(() => {});
        continue;
      }
      if (q.status === 'answered') {
        st.pending.delete(rpcId);
        await st.transport.respond(rpcId, uiResponseFor(q.answer, dlg.method)).catch(() => {});
        continue;
      }
      if (q.status === 'deferred') {
        st.pending.delete(rpcId);
        await st.transport.respond(rpcId, { cancelled: true }).catch(() => {});
        continue;
      }
      // still open — waiting on the user
      return { waiting: dlg.questionId };
    }
    return { waiting: null };
  }

  async function driveOnce(cardId) {
    for (let step = 0; step < L.maxDriveSteps; step++) {
      const view = await service.view(cardId);
      if (!view) {
        const st = cardToSession.has(cardId) ? sessions.get(cardToSession.get(cardId)) : null;
        if (st) { await teardown(st); sessions.delete(st.sessionId); }
        return { status: 'no_session' };
      }
      if (view.status !== 'active') {
        const st = sessions.get(view.sessionId);
        if (st) { await teardown(st); sessions.delete(view.sessionId); }
        return { status: 'session_stopped', sessionId: view.sessionId };
      }
      const st = sessionState(view, cardId);
      const attempts = view.attempts ?? [];
      const running = attempts.find((a) => a.status === 'running');

      // A live process bound to an attempt that is no longer running is
      // stale only when that attempt DIED (cancelled/failed/blocked) — it
      // must never answer for or mutate another attempt. A process bound
      // to a parked (awaiting_answer) or cleanly completed attempt stays:
      // it IS the durable discussion's CLI session — later attempts reuse
      // it whenever the plan is unchanged.
      if (st.transport && st.attemptId !== running?.attemptId) {
        const bound = attempts.find((a) => a.attemptId === st.attemptId);
        if (!bound
            || (!ATTEMPT_LIVE.has(bound.status) && bound.status !== 'completed')) {
          await teardown(st);
        }
      }

      // (1) Deliver recorded answers to pending dialogs on the live process.
      if (st.transport?.alive?.() && st.pending.size) {
        const w = await deliverPendingAnswers(st, { cardId, view });
        if (w.waiting) {
          const bound = attempts.find((a) => a.attemptId === st.attemptId);
          if (!bound || bound.status !== 'running') { await teardown(st); continue; }
          return { status: 'awaiting_user', questionId: w.waiting, attemptId: st.attemptId };
        }
      }

      // (2) A turn is in flight on the live process — keep pumping.
      if (st.turnInFlight && st.transport?.alive?.()) {
        const out = await pump(st, { cardId, view });
        const r = await settleOutcome(st, out, { cardId, view });
        if (r?.continue) continue;
        return r;
      }
      if (st.turnInFlight && !st.transport?.alive?.()) {
        // The process died while we were parked — resume from checkpoint.
        // Pending rpc ids die with the process; the durable question
        // records rebind to fresh request ids on the resumed turn.
        st.turnInFlight = false;
        st.transport = null;
        st.pending.clear();
      }

      // (3) A running attempt with no in-flight turn → drive a turn.
      if (running) {
        if (st.attemptId !== running.attemptId) {
          st.attemptId = running.attemptId;
          st.restarts = 0;
          st.mintedThisTurn.clear();
        }
        const np = trailingNoProgress(view);
        if (np >= L.noProgressLimit) {
          const r = await deliverResult(cardId, running.attemptId, {
            outcome: 'blocked',
            result: {
              blocker: {
                code: 'no_progress',
                detail: `${np} consecutive turns produced no new questions, ` +
                  'decisions, or documents — the discussion needs a different ' +
                  'instruction or the user\'s input.',
                retryable: true,
              },
            },
          });
          return { status: 'blocked', reason: r.applied === false ? r.reason : 'no_progress', attemptId: running.attemptId };
        }

        let planned;
        try {
          planned = await resolvePlan(view, running);
        } catch (e) {
          // A bound route that cannot be served is a structured blocker —
          // shown as unsupported, never silently imitated (R9).
          const r = await deliverResult(cardId, running.attemptId, {
            outcome: 'blocked',
            result: {
              blocker: {
                code: e.code ?? 'route_unavailable',
                detail: e.message ?? String(e),
                retryable: e.code === 'resource_mismatch' || e.code === 'registry_unreadable',
              },
            },
          });
          return { status: 'blocked', reason: r.applied === false ? r.reason : e.code, attemptId: running.attemptId };
        }

        // Reuse the live process only while it is bound to THIS attempt's
        // plan — a different binding is a new CLI session under the SAME
        // discussion identity, never a new interview.
        const freshProcess = !st.transport?.alive?.() || st.planKey !== planned.key;
        // "Ever spawned" is captured BEFORE marking: the resume flag and
        // the restart bound key on whether a PRIOR drive touched the attempt.
        let wasDriven = false;
        if (freshProcess) {
          wasDriven = st.drivenAttempts.has(running.attemptId);
          // A respawn of an already-driven attempt counts against the
          // restart bound — whether it died mid-turn or while parked on a
          // dialog. Beyond the cap the attempt fails cli_lost honestly.
          if (wasDriven) {
            st.restarts += 1;
            if (st.restarts > L.maxRestarts) {
              await deliverResult(cardId, running.attemptId, {
                outcome: 'failed',
                result: { note: `cli_lost: the discussion process died ${st.restarts} times on this attempt` },
              });
              return { status: 'failed', code: 'cli_lost', attemptId: running.attemptId };
            }
          }
          if (st.transport) await teardown(st);
          // Mark at spawn DECISION, not after the prompt: a factory, open()
          // or prompt() failure is still a drive of this attempt —
          // otherwise an always-failing spawn respawns forever, unbounded.
          st.drivenAttempts.add(running.attemptId);
          try {
            st.transport = await transportFactory(planned.plan, {
              cardId, view, attempt: running, stage: planned.stage,
              binding: planned.binding, dirs: planned.dirs,
            });
            await st.transport.open?.();
          } catch (e) {
            const t = st.transport;
            st.transport = null;
            await t?.close?.().catch(() => {});
            // Deterministic configuration faults — the CLI binary cannot
            // be spawned or the agent profile carries no auth — are NOT
            // transient CLI loss. Blocking the attempt surfaces the real
            // cause and stops the respawn churn a cli_lost path would run.
            if (e?.code === 'prep_agent_dir_unprovisioned' || e?.code === 'spawn_failed') {
              await deliverResult(cardId, running.attemptId, {
                outcome: 'blocked',
                result: {
                  blocker: {
                    code: e.code, detail: e.message ?? String(e), retryable: false,
                  },
                },
              });
              return { status: 'blocked', reason: e.code, attemptId: running.attemptId };
            }
            throw e;
          }
          st.planKey = planned.key;
          st.promptsSent = 0;
          st.sentAnswers.clear();
          st.pending.clear();
          st.sawStart = false;
          st.lastText = '';
        }
        st.binding = planned.binding;
        st.dirs = planned.dirs;
        st.stage = planned.stage;

        const cp = view.checkpoint ?? {};
        const resume = freshProcess
          && (wasDriven
            || (cp.openQuestions ?? []).length > 0
            || (cp.decisions ?? []).length > 0
            || (cp.assumptions ?? []).length > 0
            || Object.values(view.presented ?? {}).some(Boolean));
        const newAnswers = (cp.openQuestions ?? []).filter(
          (q) => q.status === 'answered'
            && q.attemptId === running.attemptId
            && !st.sentAnswers.has(q.questionId));
        const docTexts = {};
        if (typeof service.readDocument === 'function') {
          for (const [k, p] of Object.entries(view.presented ?? {})) {
            if (!p?.versionId) continue;
            const t = await service.readDocument(cardId, p.versionId).catch(() => null);
            if (typeof t === 'string') docTexts[k] = t;
          }
        }
        const prompt = composeLeadPrompt({
          view, attempt: running, stage: planned.stage,
          binding: planned.binding, resume, newAnswers, docTexts,
        });
        const trigger = planned.binding?.skillNames?.length
          ? `/skill:${planned.binding.skillNames[0]} ` : '';
        const msg = (freshProcess ? trigger : '') + prompt;
        if (msg.length > 256 * 1024) {
          return { status: 'error', code: 'prompt_too_large' };
        }
        // Snapshot declared artifacts BEFORE the turn — only new or changed
        // files can back a settled document claim.
        st.artifactBaseline = await artifactBaseline(
          planned.dirs.workspace, planned.binding?.result?.artifacts ?? []);
        await st.transport.prompt(msg);
        st.turnInFlight = true;
        st.turnStartedAt = now();
        st.sawStart = false;
        st.promptsSent += 1;
        for (const q of newAnswers) st.sentAnswers.add(q.questionId);

        const out = await pump(st, { cardId, view });
        const r = await settleOutcome(st, out, { cardId, view });
        if (r?.continue) continue;
        return r;
      }

      // (4) Nothing running.
      const awaiting = attempts.find((a) => a.status === 'awaiting_answer');
      if (awaiting) {
        return {
          status: 'awaiting_user', attemptId: awaiting.attemptId,
          questionIds: awaiting.questionIds,
        };
      }
      return { status: 'idle' };
    }
    return { status: 'error', code: 'drive_loop_cap' };
  }

  // Translate a pump outcome into session truth.
  async function settleOutcome(st, out, ctx) {
    const { cardId, view } = ctx;
    switch (out.kind) {
      case 'settled': {
        const r = await deliverSettled(st, { cardId, view });
        if (r?.applied === false) {
          // The attempt is gone — stale process torn down, loop re-reads.
          await teardown(st);
          return { continue: true };
        }
        return { continue: true, delivered: r };
      }
      case 'awaiting_user':
        return { status: 'awaiting_user', questionId: out.questionId, attemptId: st.attemptId };
      case 'superseded':
        await teardown(st);
        return { continue: true };
      case 'exited':
      case 'never_started': {
        // The process is gone — the durable checkpoint is the resume
        // source; the next loop iteration respawns on the same attempt
        // (restart bounds are accounted at spawn).
        await teardown(st);
        return { continue: true };
      }
      case 'idle_timeout':
      case 'turn_timeout':
      case 'frame_cap': {
        await teardown(st);
        await deliverResult(cardId, st.attemptId, {
          outcome: 'failed',
          result: { note: `${out.kind}: the discussion process stopped making progress` },
        });
        return { status: 'failed', code: out.kind, attemptId: st.attemptId };
      }
      default:
        await teardown(st);
        return { status: 'error', code: 'unknown_pump_outcome' };
    }
  }

  // ---- public surface -------------------------------------------------------

  async function drive(cardId) {
    const prev = chains.get(cardId) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(async () => {
      try {
        return await driveOnce(cardId);
      } catch (e) {
        // Internal-command/service failures never leave a stale live
        // transport answering for an attempt that no longer matches.
        const sid = cardToSession.get(cardId);
        const st = sid ? sessions.get(sid) : null;
        if (st) await teardown(st);
        return {
          status: 'error',
          code: e?.code ?? 'driver_error',
          message: e?.message ?? String(e),
        };
      }
    });
    chains.set(cardId, p);
    try {
      return await p;
    } finally {
      if (chains.get(cardId) === p) chains.delete(cardId);
    }
  }

  // Transport-level stop: cancel the ACTIVE preparation attempt's process
  // only — the durable attempt/session state is the command layer's call
  // (stop_preparation). Returns what it actually did.
  async function stop(cardId) {
    const sid = cardToSession.get(cardId);
    const st = sid ? sessions.get(sid) : null;
    if (!st?.transport) return { stopped: false };
    const wasAlive = st.transport.alive?.() ?? false;
    await teardown(st);
    sessions.delete(st.sessionId);
    cardToSession.delete(cardId);
    return { stopped: true, aborted: wasAlive, sessionId: st.sessionId };
  }

  async function dispose() {
    for (const st of sessions.values()) await teardown(st);
    sessions.clear();
    cardToSession.clear();
  }

  // Test/evidence surface: which transport generation drives which attempt.
  function driverState(cardId) {
    const sid = cardToSession.get(cardId);
    const st = sid ? sessions.get(sid) : null;
    if (!st) return null;
    return {
      sessionId: st.sessionId, attemptId: st.attemptId, planKey: st.planKey,
      turnInFlight: st.turnInFlight, promptsSent: st.promptsSent,
      pending: [...st.pending.keys()], restarts: st.restarts,
      transportAlive: st.transport?.alive?.() ?? false,
    };
  }

  return { drive, stop, dispose, driverState };
}
