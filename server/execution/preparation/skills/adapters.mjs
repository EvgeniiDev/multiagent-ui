// server/execution/preparation/skills/adapters.mjs — P2 skill adapters
// (plan KTD3/KTD5–KTD7).
//
// An adapter is the code that turns a registered SkillBinding into a
// concrete runtime invocation and translates the route's outcome back into
// the preparation result schema. Invariants:
//
//   * registered/probed routes only — adapterFor() and planInvocation()
//     refuse candidate/unsupported bindings before anything is spawned
//     (assertRouteAvailable runs inside the adapter seam too, so a caller
//     that skips preflight still cannot plan a refused route);
//   * no silent fallback — an unregistered adapterId, an adapterVersion
//     outside the adapter's supported contracts, a question channel or
//     result mode the adapter does not implement, or a tool the adapter
//     cannot serve all fail with structured refusals;
//   * results are DATA, not authority — translateResult() imports exactly
//     the whitelisted fields the session's prep_result seam consumes and
//     refuses outright on any command/API/tool-shaped channel. Skill
//     resources can never mint ACP UI commands (KTD6);
//   * resources are the ORIGINAL pinned files — the launch plan passes
//     each skillDir to pi via --skill (pi loads the upstream SKILL.md
//     itself); no skill text is inlined, rewritten, or substituted.
//
// The pi-skill plan is THE probed invocation — the P0 probe driver builds
// its argv through planInvocation so what was proven is what would run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeError } from '../../common.mjs';
import { assertRouteAvailable, resolveRoots, realpathNearest } from './registry.mjs';

function fail(code, msg, extra = {}) {
  throw new RuntimeError(code, msg, extra);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const PREPARATION_BRIDGE_PATH = fileURLToPath(
  new URL('./pi-ext/preparation-bridge.ts', import.meta.url));

// ---------------------------------------------------------------------------
// Result translation — the injection boundary (KTD6)
// ---------------------------------------------------------------------------
//
// A skill's output is untrusted data. The ONLY thing an adapter may hand
// the preparation session is the whitelisted result payload; any other
// top-level key — however named — refuses the whole result with a
// structured `result_channel_unsupported` error rather than being silently
// dropped or, worse, executed.

const RESULT_KEYS = new Set([
  'note', 'questions', 'decisions', 'assumptions', 'document', 'proposal', 'handoff',
  'blocker',   // P3: the lead's structured "cannot proceed" outcome
]);
const DOCUMENT_KEYS = new Set(['kind', 'text', 'draft', 'openQuestions', 'requirementsVersionId']);
const PROPOSAL_KEYS = new Set(['intentRestatement']);
const HANDOFF_KEYS = new Set(['to', 'detail']);
const BLOCKER_KEYS = new Set(['code', 'detail', 'retryable']);
const SAFE_BLOCKER_CODE = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const DOC_KINDS = new Set(['requirements', 'design', 'plan']);

function checkKeys(obj, allowed, what) {
  const offending = Object.keys(obj).filter((k) => !allowed.has(k));
  if (offending.length) {
    fail('result_channel_unsupported',
      `${what}: unsupported result channel(s) ${offending.map((k) => JSON.stringify(k)).join(', ')} — ` +
      'skill output is data; it cannot issue commands, API calls, or tool invocations',
      { offending });
  }
}

// The injection boundary at the session seam: any top-level result channel
// outside the whitelisted vocabulary — `commands`, `api`, `toolCalls`,
// `exec`, … — refuses the whole result with a structured error rather than
// being silently dropped or, worse, executed. Known sub-objects are
// whitelisted too so a `document: {run: ...}` style smuggle fails the same
// way. Skill resources never mint ACP UI commands (KTD6).
export function assertResultChannels(raw) {
  const r = isObj(raw) ? raw : {};
  checkKeys(r, RESULT_KEYS, 'skill result');
  if (isObj(r.proposal)) checkKeys(r.proposal, PROPOSAL_KEYS, 'result.proposal');
  if (isObj(r.document)) checkKeys(r.document, DOCUMENT_KEYS, 'result.document');
  if (isObj(r.handoff)) checkKeys(r.handoff, HANDOFF_KEYS, 'result.handoff');
  if (isObj(r.blocker)) checkKeys(r.blocker, BLOCKER_KEYS, 'result.blocker');
}

// Validate + sanitize a raw adapter-side skill outcome into the payload
// prep_result consumes. Throws RuntimeError — callers propagate.
export function translateResult(binding, raw) {
  const r = isObj(raw) ? raw : {};
  checkKeys(r, RESULT_KEYS, `binding ${binding.bindingId} result`);
  const out = {};
  if (r.note !== undefined) {
    if (typeof r.note !== 'string') fail('result_malformed', 'result.note must be a string');
    out.note = r.note;
  }
  for (const [key, what] of [['questions', 'result.questions'], ['decisions', 'result.decisions'], ['assumptions', 'result.assumptions']]) {
    if (r[key] === undefined) continue;
    if (!Array.isArray(r[key])) fail('result_malformed', `${what} must be an array`);
    out[key] = r[key];
  }
  if (r.proposal !== undefined) {
    if (!isObj(r.proposal)) fail('result_malformed', 'result.proposal must be an object');
    checkKeys(r.proposal, PROPOSAL_KEYS, `binding ${binding.bindingId} result.proposal`);
    out.proposal = { ...r.proposal };
  }
  if (r.document !== undefined && r.document !== null) {
    const doc = r.document;
    if (!isObj(doc)) fail('result_malformed', 'result.document must be an object');
    checkKeys(doc, DOCUMENT_KEYS, `binding ${binding.bindingId} result.document`);
    const contract = binding.result;
    if (!contract || contract.importAs === 'none') {
      fail('result_off_contract',
        `binding ${binding.bindingId} has no document contract (importAs=${contract?.importAs ?? 'none'}) — ` +
        'a document result is off-contract and refused, not silently imported',
        { bindingId: binding.bindingId });
    }
    if (!DOC_KINDS.has(doc.kind)) {
      fail('result_malformed',
        `result.document.kind must be one of ${[...DOC_KINDS].join('|')}`);
    }
    if (contract.docKind && doc.kind !== contract.docKind) {
      fail('result_off_contract',
        `binding ${binding.bindingId} imports ${contract.docKind} documents, not ${doc.kind}`,
        { bindingId: binding.bindingId, contractDocKind: contract.docKind });
    }
    out.document = { ...doc };
    // The binding's declared import mode wins over whatever the result
    // claimed — a 'draft' contract always imports as draft.
    out.document.draft = contract.importAs === 'draft' ? true : doc.draft === true;
  }
  if (r.handoff !== undefined && r.handoff !== null) {
    const h = r.handoff;
    if (!isObj(h)) {
      fail('result_malformed', 'result.handoff must be {to: <bindingId>}');
    }
    checkKeys(h, HANDOFF_KEYS, `binding ${binding.bindingId} result.handoff`);
    if (typeof h.to !== 'string' || !h.to) {
      fail('result_malformed', 'result.handoff must be {to: <bindingId>}');
    }
    const declared = (binding.result?.handoffs ?? []).find((x) => x.to === h.to);
    if (!declared) {
      fail('result_off_contract',
        `binding ${binding.bindingId} declares no handoff to ${JSON.stringify(h.to)} — ` +
        'undeclared route transitions are refused, not dispatched',
        { bindingId: binding.bindingId, to: h.to });
    }
    // The declared mode sticks: a 'denied' handoff stays denied — it is
    // recorded as route evidence, never dispatched.
    out.handoff = { to: declared.to, mode: declared.mode, reason: declared.reason };
  }
  // P3: a structured blocker is a supported lead/route output — the route
  // declaring it cannot proceed, with a code the host surfaces verbatim.
  if (r.blocker !== undefined && r.blocker !== null) {
    const bl = r.blocker;
    if (!isObj(bl)) fail('result_malformed', 'result.blocker must be an object');
    checkKeys(bl, BLOCKER_KEYS, `binding ${binding.bindingId} result.blocker`);
    if (typeof bl.code !== 'string' || !SAFE_BLOCKER_CODE.test(bl.code)) {
      fail('result_malformed',
        `result.blocker.code must be a short stable id — got ${JSON.stringify(bl.code)}`);
    }
    out.blocker = {
      code: bl.code,
      detail: typeof bl.detail === 'string' ? bl.detail : '',
      retryable: bl.retryable === true,
    };
  }
  return { ok: true, result: out };
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------
//
// `pi-skill` — runs the binding's pinned skill directories under
// `pi --mode rpc` with the preparation-bridge extension (ask_user +
// containment). All six P0-proven routes run through this adapter; their
// differences live in the binding's declared fields (questionChannel,
// tools, gateContract, result), not in per-skill code forks.

const PI_CONTRACTS = new Set(['p0-probe-1', 'pi-skill-1']);

const PI_SKILL = {
  adapterId: 'pi-skill',
  adapterVersion: 'pi-skill-1',
  // Runtime surfaces the adapter itself needs from the host.
  hostRequirements: ['runtime.pi'],
  // Question channels the bridge extension can serve.
  questionChannels: new Set(['chat', 'extension_ui']),
  // Tools the adapter can expose to the skill process (pi builtins behind
  // --tools plus the bridge's ask_user).
  providesTools: new Set(['read', 'write', 'edit', 'bash', 'ask_user']),
  resultModes: new Set(['conversation', 'workspace_artifact', 'review_report']),

  assertCompatible(binding) {
    if (!PI_CONTRACTS.has(binding.adapterVersion)) {
      fail('adapter_version_unsupported',
        `binding ${binding.bindingId} pins adapterVersion ${JSON.stringify(binding.adapterVersion)} — ` +
        `adapter pi-skill supports ${[...PI_CONTRACTS].join(', ')}; re-probe under a supported contract`,
        { bindingId: binding.bindingId, adapterVersion: binding.adapterVersion });
    }
    if (!this.questionChannels.has(binding.questionChannel)) {
      fail('adapter_unsafe',
        `adapter pi-skill cannot serve questionChannel ${JSON.stringify(binding.questionChannel)} ` +
        `for binding ${binding.bindingId}`,
        { bindingId: binding.bindingId, questionChannel: binding.questionChannel });
    }
    const mode = binding.result?.mode;
    if (mode && !this.resultModes.has(mode)) {
      fail('adapter_unsafe',
        `adapter pi-skill does not implement result mode ${JSON.stringify(mode)} ` +
        `for binding ${binding.bindingId}`,
        { bindingId: binding.bindingId, mode });
    }
    const unservable = (binding.tools ?? []).filter((t) => !this.providesTools.has(t));
    if (unservable.length) {
      fail('adapter_unsafe',
        `adapter pi-skill cannot serve tool(s) ${unservable.join(', ')} ` +
        `required by binding ${binding.bindingId}`,
        { bindingId: binding.bindingId, unservable });
    }
    return true;
  },
};

export const ADAPTERS = {
  'pi-skill': PI_SKILL,
};

// Resolve the binding's declared adapter. Absent/unregistered ids refuse —
// an available route must name a real adapter (registry schema already
// requires adapterId for non-unsupported bindings; this stays fail-closed
// for hand-built registries). `adapters` is the resolved map — the ctx
// seam supplies it (default ADAPTERS; tests may inject fakes — each must
// still implement the assertCompatible contract).
export function adapterFor(binding, adapters = ADAPTERS) {
  const id = binding?.adapterId ?? null;
  if (!id) {
    fail('adapter_unavailable',
      `binding ${binding?.bindingId ?? '?'} declares no adapterId`,
      { bindingId: binding?.bindingId ?? null });
  }
  const adapter = isObj(adapters) ? adapters[id] : null;
  if (!adapter) {
    fail('adapter_unavailable',
      `no adapter registered as ${JSON.stringify(id)} (binding ${binding.bindingId}); ` +
      `registered: ${isObj(adapters) ? Object.keys(adapters).join(', ') : 'none'}`,
      { bindingId: binding.bindingId, adapterId: id });
  }
  return adapter;
}

// The launch plan for one binding invocation — argv/env/cwd as DATA. The
// caller (probe driver now, the P3 lead driver later) owns the spawn;
// planning itself spawns nothing and writes nothing. Defense in depth:
// the route guard re-runs here so an unprobed route can never be planned.
export function planInvocation(binding, {
  piBinary = 'pi',
  model = {},
  sessionDir,
  agentDir,
  workspace,
  auditPath = null,
  extensionPath = PREPARATION_BRIDGE_PATH,
  name = null,
  scratch = true,
  adapters,
  // Host-added read-only mounts beyond the binding's own declaration (P5:
  // the card's project root). They widen the READ set only — never the
  // write set — and are canonicalized like every declared root.
  extraReadRoots = [],
} = {}) {
  assertRouteAvailable(binding);
  const adapter = adapterFor(binding, adapters);
  if (typeof adapter.assertCompatible !== 'function') {
    fail('adapter_unavailable',
      `adapter ${binding.adapterId} for binding ${binding.bindingId} does not implement ` +
      'assertCompatible — the adapter contract is incomplete',
      { bindingId: binding.bindingId, adapterId: binding.adapterId });
  }
  adapter.assertCompatible(binding);
  if (!binding.resourceManifest) {
    fail('resources_unpinned',
      `binding ${binding.bindingId} has no pinned resource manifest — refusing to plan`,
      { bindingId: binding.bindingId });
  }
  for (const [k, v] of [['sessionDir', sessionDir], ['agentDir', agentDir], ['workspace', workspace]]) {
    if (typeof v !== 'string' || !path.isAbsolute(v)) {
      fail('invalid_argument', `planInvocation: ${k} must be an absolute path`);
    }
  }
  const roots = resolveRoots(binding, workspace, { scratch });
  if (extraReadRoots.length) {
    roots.readRoots = [...new Set([
      ...roots.readRoots, ...extraReadRoots.map(realpathNearest)])];
  }
  const args = [
    '--mode', 'rpc',
    ...(model.provider ? ['--provider', model.provider] : []),
    ...(model.id ? ['--model', model.id] : []),
    ...(model.thinking ? ['--thinking', model.thinking] : []),
    '--session-dir', sessionDir,
    '--name', name ?? `prep-${binding.bindingId}`,
    '--no-extensions', '-e', extensionPath,
    '--no-skills',
    ...binding.skillDirs.flatMap((d) => ['--skill', d]),
    '--no-context-files', '--no-prompt-templates', '--no-themes', '-na',
  ];
  if (binding.tools) args.push('--tools', binding.tools.join(','));
  const env = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: '1',
    ACP_PREP_WRITE_ROOTS: JSON.stringify(roots.writeRoots),
    ACP_PREP_READ_ROOTS: JSON.stringify(roots.readRoots),
    ACP_PREP_BINDING: binding.bindingId,
  };
  if (auditPath) env.ACP_PREP_AUDIT = auditPath;
  return {
    command: piBinary,
    args,
    cwd: roots.workspaceRoot,
    env,
    roots,
    skillDirs: [...binding.skillDirs],
  };
}
