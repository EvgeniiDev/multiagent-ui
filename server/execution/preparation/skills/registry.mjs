// server/execution/preparation/skills/registry.mjs — SkillBinding registry
// for idea-preparation feasibility (P0). Covers plan KTD3–KTD7:
//
//   * A SkillBinding pins the upstream skill's full resource set (every file
//     under the skill directories plus explicitly referenced extra files) by
//     sha256. `pin` is a deliberate registration step; `probe`/`verify`
//     recompute and refuse on any drift — bindings are fail-closed.
//   * `status` is honest: `candidate` (registered, unproven),
//     `available` (a real probe produced the declared route's result), or
//     `unsupported` (proven/refused route — never silently substituted).
//   * Containment: each binding declares writeRoots (the private document
//     workspace plus the skill's own documented scratch prefix) and
//     readRoots (workspace, skill dirs, optional read-only project root).
//     checkToolCall() is the shared policy evaluated by the probe driver;
//     the pi extension enforces the same policy in-process BEFORE tool
//     execution. Nothing here spawns or writes at module load.

import { createHash } from 'node:crypto';
import { promises as fs, realpathSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeError, SAFE_ID_RE } from '../../common.mjs';

export const BINDING_SCHEMA_VERSION = 1;
export const STAGES = new Set(['intent', 'requirements', 'design', 'plan', 'review']);
export const QUESTION_CHANNELS = new Set(['chat', 'extension_ui']);
export const STATUSES = new Set(['candidate', 'available', 'unsupported']);
// P2 (KTD3): SkillGate types a binding's declared contract may mint.
// intent_confirm binds the current intent restatement; artifact_confirm
// binds a presented document of the gate's stage. The session module
// consumes these; they live here so the registry schema owns the contract
// vocabulary (no import cycle: session imports registry, not vice versa).
export const GATE_TYPES = new Set(['intent_confirm', 'artifact_confirm']);
// Stages that bind a document kind in the preparation phase machine.
export const DOC_STAGES = new Set(['requirements', 'design', 'plan']);
// How a binding's route delivers its outcome (KTD3 "способ получения
// результата"): conversation = answers/decisions in the checkpoint;
// workspace_artifact = real files in the document workspace (optionally
// imported as a document); review_report = a structured non-interactive
// review result.
export const RESULT_MODES = new Set(['conversation', 'workspace_artifact', 'review_report']);
export const RESULT_IMPORTS = new Set(['document', 'draft', 'none']);
// A route's terminal handoffs are RECORDED options, never self-dispatched
// (KTD5): host_choice = the host offers the registered target as an
// explicit user choice; recorded = noted, not offered; denied = declared
// out of scope (e.g. implementation authority).
export const HANDOFF_MODES = new Set(['host_choice', 'recorded', 'denied']);
// Capability reference vocabulary (capabilities.mjs owns host membership):
// question.<channel>, tool.<name>, workspace.<git|documents|project_ro>,
// scratch.<name>, runtime.<name>, native.<surface> (a native CLI feature —
// e.g. intra-skill dispatch — the host either provides or the binding
// cannot claim it).
export const CAPABILITY_RE = /^(question|tool|workspace|scratch|runtime|native)\.[a-z0-9][a-z0-9._-]{0,60}$/;

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

function fail(code, msg, extra = {}) {
  throw new RuntimeError(code, msg, extra);
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function reqStr(v, what, re) {
  if (typeof v !== 'string' || !re.test(v)) fail('invalid_registry', `${what} malformed: ${JSON.stringify(v)}`);
  return v;
}

// ---------------------------------------------------------------------------
// Registry loading + validation
// ---------------------------------------------------------------------------

export async function loadRegistry(registryPath) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  } catch (e) {
    fail('registry_unreadable', `cannot load registry ${registryPath}: ${e.message}`);
  }
  return validateRegistry(raw, registryPath);
}

export function validateRegistry(raw, source = 'registry') {
  if (!isObj(raw)) fail('invalid_registry', `${source}: top level must be an object`);
  if (raw.schemaVersion !== BINDING_SCHEMA_VERSION) {
    fail('invalid_registry', `${source}: schemaVersion must be ${BINDING_SCHEMA_VERSION}`);
  }
  const pi = isObj(raw.pi) ? raw.pi : {};
  const bindings = (raw.bindings ?? []).map((b, i) => validateBinding(b, `${source} bindings[${i}]`));
  const seen = new Set();
  for (const b of bindings) {
    if (seen.has(b.bindingId)) fail('invalid_registry', `duplicate bindingId ${b.bindingId}`);
    seen.add(b.bindingId);
  }
  // Handoffs point at OTHER registered bindings — a dangling target is a
  // declared route to nowhere, refused at load time.
  for (const b of bindings) {
    for (const h of b.result?.handoffs ?? []) {
      if (!seen.has(h.to)) {
        fail('invalid_registry',
          `binding ${b.bindingId}: handoff target ${JSON.stringify(h.to)} is not a registered binding`);
      }
    }
  }
  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    pi: {
      binary: typeof pi.binary === 'string' ? pi.binary : 'pi',
      version: reqStr(pi.version ?? '0.85.1', 'pi.version', /^\d+\.\d+\.\d+$/),
    },
    bindings,
  };
}

function validateBinding(b, what) {
  if (!isObj(b)) fail('invalid_registry', `${what}: binding must be an object`);
  const bindingId = reqStr(b.bindingId, `${what}.bindingId`, SAFE_ID_RE);
  const stage = b.stage;
  if (!STAGES.has(stage)) fail('invalid_registry', `${what}: stage must be one of ${[...STAGES].join('|')}`);
  const status = b.status;
  if (!STATUSES.has(status)) fail('invalid_registry', `${what}: status must be one of ${[...STATUSES].join('|')}`);
  if (status === 'unsupported' && !isObj(b.unsupported)) {
    fail('invalid_registry', `${what}: unsupported binding requires an unsupported{} record`);
  }
  const skillDirs = (b.skillDirs ?? []).map((d, i) => {
    if (typeof d !== 'string' || !path.isAbsolute(d)) {
      fail('invalid_registry', `${what}.skillDirs[${i}] must be absolute: ${JSON.stringify(d)}`);
    }
    return d;
  });
  const extraResources = (b.extraResources ?? []).map((d, i) => {
    if (typeof d !== 'string' || !path.isAbsolute(d)) {
      fail('invalid_registry', `${what}.extraResources[${i}] must be absolute: ${JSON.stringify(d)}`);
    }
    return d;
  });
  if (status !== 'unsupported' && !skillDirs.length) {
    fail('invalid_registry', `${what}: non-unsupported binding needs at least one skillDir`);
  }
  const questionChannel = b.questionChannel ?? 'chat';
  if (!QUESTION_CHANNELS.has(questionChannel)) {
    fail('invalid_registry', `${what}: questionChannel must be ${[...QUESTION_CHANNELS].join('|')}`);
  }
  const tools = b.tools === undefined ? null : b.tools;
  if (tools !== null) {
    if (!Array.isArray(tools) || !tools.length || !tools.every((t) => typeof t === 'string' && SAFE_NAME_RE.test(t))) {
      fail('invalid_registry', `${what}.tools must be a non-empty array of safe names or null`);
    }
  }
  // P2: the binding declares its adapter module, required host
  // capabilities, gate contract, and result acquisition (KTD3). An
  // `available` binding must declare the full runtime contract — you
  // cannot promise a route you cannot describe; `candidate` registrations
  // may still be discovering it (adapterId is still required — a route
  // with no adapter can never be probed); `unsupported` routes keep the
  // fields optional (they are documentation of a refused route).
  const adapterId = b.adapterId === undefined || b.adapterId === null
    ? null
    : reqStr(b.adapterId, `${what}.adapterId`, SAFE_NAME_RE);
  if (status !== 'unsupported' && !adapterId) {
    fail('invalid_registry', `${what}: non-unsupported binding needs adapterId`);
  }
  const requires = validateRequires(b.requires, what);
  const gateContract = validateGateContract(b.gateContract, what);
  const result = validateResult(b.result, what);
  if (status === 'available' && (!gateContract || !result)) {
    fail('invalid_registry',
      `${what}: an available binding must declare gateContract and result (KTD3)`);
  }
  // A route imports only the document of its own stage — a requirements
  // binding cannot mint a design document.
  if (result && result.importAs !== 'none' && result.docKind !== stage) {
    fail('invalid_registry',
      `${what}: result.docKind ${JSON.stringify(result.docKind)} must equal the binding's ` +
      `stage ${JSON.stringify(stage)} when importAs=${result.importAs}`);
  }
  const expect = validateExpect(b.expect, what);
  const probe = validateProbe(b.probe, what);
  const manifest = validateManifest(b.resourceManifest, what);
  const unsupported = (b.unsupported === undefined || b.unsupported === null) ? null : {
    reason: reqStr(b.unsupported.reason, `${what}.unsupported.reason`, SAFE_NAME_RE),
    detail: typeof b.unsupported.detail === 'string' ? b.unsupported.detail : '',
    route: typeof b.unsupported.route === 'string' ? b.unsupported.route : '',
  };
  return {
    bindingId, stage, status,
    title: typeof b.title === 'string' ? b.title : bindingId,
    provider: typeof b.provider === 'string' ? b.provider : '',
    adapterId,
    adapterVersion: reqStr(b.adapterVersion ?? 'p0-probe-1', `${what}.adapterVersion`, SAFE_NAME_RE),
    skillDirs, extraResources, questionChannel, tools,
    requires, gateContract, result,
    readOnlyRoots: (b.readOnlyRoots ?? []).map((d, i) => {
      if (typeof d !== 'string' || !path.isAbsolute(d)) {
        fail('invalid_registry', `${what}.readOnlyRoots[${i}] must be absolute`);
      }
      return d;
    }),
    skillNames: (b.skillNames ?? []).map((n, i) =>
      reqStr(n, `${what}.skillNames[${i}]`, SKILL_NAME_RE)),
    expect, probe, resourceManifest: manifest, unsupported,
  };
}

// `requires`: host capabilities the route needs beyond the ones derived
// from questionChannel/tools (capabilities.mjs resolves membership).
// Entries are pattern-validated, deduplicated, sorted for a stable
// configDigest.
function validateRequires(r, what) {
  if (r === undefined || r === null) return [];
  if (!Array.isArray(r)) fail('invalid_registry', `${what}.requires must be an array`);
  const out = [];
  for (const [i, c] of r.entries()) {
    if (typeof c !== 'string' || !CAPABILITY_RE.test(c)) {
      fail('invalid_registry',
        `${what}.requires[${i}] must match ${CAPABILITY_RE} — got ${JSON.stringify(c)}`);
    }
    if (!out.includes(c)) out.push(c);
  }
  return out.sort();
}

// The binding's declared SkillGate contract (P2 supersedes P1's
// stage-derived override map): which explicit user confirmations the
// route's contract requires. [] is a valid declaration (a route with no
// user gate — e.g. a non-interactive review); absent (null) means the
// session falls back to the P1 stage-derived contract for compatibility.
function validateGateContract(g, what) {
  if (g === undefined || g === null) return null;
  if (!Array.isArray(g)) fail('invalid_registry', `${what}.gateContract must be an array`);
  return g.map((spec, i) => {
    if (!isObj(spec) || !GATE_TYPES.has(spec.type)) {
      fail('invalid_registry',
        `${what}.gateContract[${i}].type must be one of ${[...GATE_TYPES].join('|')}`);
    }
    if (spec.type === 'intent_confirm' && spec.stage !== 'intent') {
      fail('invalid_registry',
        `${what}.gateContract[${i}]: intent_confirm binds the intent restatement — stage must be 'intent'`);
    }
    if (spec.type === 'artifact_confirm' && !DOC_STAGES.has(spec.stage)) {
      fail('invalid_registry',
        `${what}.gateContract[${i}]: artifact_confirm needs a document stage (${[...DOC_STAGES].join('|')})`);
    }
    return { type: spec.type, stage: spec.stage };
  });
}

// How the route's outcome is obtained (KTD3). mode selects the channel;
// docKind+importAs describe the document a workspace_artifact route may
// deliver (importAs 'none' = artifacts are workspace evidence only);
// handoffs are the route's declared terminal handoff menu — recorded
// options keyed to OTHER registered bindings, never self-dispatched.
function validateResult(r, what) {
  if (r === undefined || r === null) return null;
  if (!isObj(r)) fail('invalid_registry', `${what}.result must be an object`);
  if (!RESULT_MODES.has(r.mode)) {
    fail('invalid_registry',
      `${what}.result.mode must be one of ${[...RESULT_MODES].join('|')}`);
  }
  const docKind = r.docKind === undefined || r.docKind === null ? null : r.docKind;
  if (docKind !== null && !DOC_STAGES.has(docKind)) {
    fail('invalid_registry',
      `${what}.result.docKind must be ${[...DOC_STAGES].join('|')} or null`);
  }
  const importAs = r.importAs === undefined ? 'none' : r.importAs;
  if (!RESULT_IMPORTS.has(importAs)) {
    fail('invalid_registry',
      `${what}.result.importAs must be one of ${[...RESULT_IMPORTS].join('|')}`);
  }
  if (importAs !== 'none' && docKind === null) {
    fail('invalid_registry',
      `${what}.result: importAs=${importAs} requires a docKind to import into`);
  }
  if (r.mode === 'conversation' && importAs !== 'none') {
    fail('invalid_registry',
      `${what}.result: conversation routes deliver no artifact — importAs must be 'none'`);
  }
  const handoffs = (r.handoffs ?? []).map((h, i) => {
    if (!isObj(h) || typeof h.to !== 'string' || !SAFE_NAME_RE.test(h.to)) {
      fail('invalid_registry', `${what}.result.handoffs[${i}].to must be a binding id`);
    }
    if (!HANDOFF_MODES.has(h.mode)) {
      fail('invalid_registry',
        `${what}.result.handoffs[${i}].mode must be one of ${[...HANDOFF_MODES].join('|')}`);
    }
    return {
      to: h.to, mode: h.mode,
      reason: typeof h.reason === 'string' ? h.reason : null,
      detail: typeof h.detail === 'string' ? h.detail : '',
    };
  });
  return {
    mode: r.mode,
    docKind,
    importAs,
    artifacts: (r.artifacts ?? []).map((g, i) =>
      reqStr(g, `${what}.result.artifacts[${i}]`, /^[A-Za-z0-9][A-Za-z0-9._\/\*-]{0,200}$/)),
    handoffs,
  };
}

function validateExpect(e, what) {
  if (e === undefined || e === null) return null;
  if (!isObj(e)) fail('invalid_registry', `${what}.expect must be an object`);
  const out = {
    artifacts: (e.artifacts ?? []).map((g, i) =>
      reqStr(g, `${what}.expect.artifacts[${i}]`, /^[A-Za-z0-9][A-Za-z0-9._\/\*-]{0,200}$/)),
    frontmatter: isObj(e.frontmatter) ? { ...e.frontmatter } : {},
    gitCommit: e.gitCommit === true,
    minChatQuestions: Number.isInteger(e.minChatQuestions) ? e.minChatQuestions : 0,
    minUiRequests: Number.isInteger(e.minUiRequests) ? e.minUiRequests : 0,
    finalTextPattern: typeof e.finalTextPattern === 'string' ? e.finalTextPattern : null,
  };
  return out;
}

function validateProbe(p, what) {
  if (p === undefined || p === null) return null;
  if (!isObj(p)) fail('invalid_registry', `${what}.probe must be an object`);
  const out = {
    prompt: typeof p.prompt === 'string' ? p.prompt : null,
    answers: Array.isArray(p.answers) ? p.answers.map(String) : [],
    ui: isObj(p.ui) ? { ...p.ui } : {},
    seed: Array.isArray(p.seed) ? p.seed.map((s, i) => {
      if (!isObj(s) || typeof s.path !== 'string' || typeof s.content !== 'string') {
        fail('invalid_registry', `${what}.probe.seed[${i}] must be {path, content}`);
      }
      if (path.isAbsolute(s.path) || s.path.split('/').includes('..')) {
        fail('invalid_registry', `${what}.probe.seed[${i}].path must be workspace-relative: ${s.path}`);
      }
      return { path: s.path, content: s.content };
    }) : [],
    interruptTest: p.interruptTest === true,
    maxPrompts: Number.isInteger(p.maxPrompts) && p.maxPrompts > 0 ? p.maxPrompts : 12,
    timeoutMs: Number.isInteger(p.timeoutMs) && p.timeoutMs >= 5000 ? p.timeoutMs : 600_000,
  };
  return out;
}

function validateManifest(m, what) {
  if (m === undefined || m === null) return null;
  if (!isObj(m)) fail('invalid_registry', `${what}.resourceManifest must be an object`);
  if (m.algo !== 'sha256') fail('invalid_registry', `${what}.resourceManifest.algo must be sha256`);
  if (!Array.isArray(m.files)) fail('invalid_registry', `${what}.resourceManifest.files must be an array`);
  const files = m.files.map((f, i) => {
    if (!isObj(f) || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) ||
        !Number.isInteger(f.bytes) || f.bytes < 0) {
      fail('invalid_registry', `${what}.resourceManifest.files[${i}] malformed`);
    }
    return { path: f.path, sha256: f.sha256, bytes: f.bytes };
  });
  if (!/^[0-9a-f]{64}$/.test(m.digest ?? '')) {
    fail('invalid_registry', `${what}.resourceManifest.digest must be sha256 hex`);
  }
  return { algo: 'sha256', digest: m.digest, files, pinnedAt: m.pinnedAt ?? null };
}

export function bindingById(registry, bindingId) {
  const b = registry.bindings.find((x) => x.bindingId === bindingId);
  if (!b) fail('unknown_binding', `no binding named ${JSON.stringify(bindingId)}`);
  return b;
}

export function assertRouteAvailable(binding) {
  if (binding.status === 'unsupported') {
    fail('route_unsupported',
      `binding ${binding.bindingId} is unsupported: ${binding.unsupported?.reason}` +
      (binding.unsupported?.detail ? ` — ${binding.unsupported.detail}` : ''),
      { bindingId: binding.bindingId, reason: binding.unsupported?.reason });
  }
  if (binding.status === 'candidate') {
    fail('route_unproven', `binding ${binding.bindingId} is a candidate — no successful probe on record`,
      { bindingId: binding.bindingId });
  }
  return binding;
}

// ---------------------------------------------------------------------------
// Binding version identity (P2, KTD4)
// ---------------------------------------------------------------------------
//
// A SkillBinding's runtime contract has TWO pinned identities, both
// snapshotted onto the session's binding reference at assignment:
//
//   * resourceManifest.digest — the sha256 over the exact resource set
//     (paths+content+size). Drift on disk or a repin changes it.
//   * configDigest — sha256 over the binding's runtime contract fields:
//     which adapter serves the route and at which contract version, the
//     question channel, tool allowlist, declared capabilities, gate
//     contract and result acquisition. An adapter/contract edit with
//     untouched resources still changes the version identity — the session
//     sees `binding_config_changed` and migrates explicitly via
//     change_skill_binding rather than silently absorbing it.
//
// Canonical serialization (sorted keys, array order preserved) makes the
// digest stable across registry rewrites that only reorder keys.

function canonJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonJson).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function bindingConfigDigest(binding) {
  return createHash('sha256').update(canonJson({
    stage: binding.stage,
    adapterId: binding.adapterId ?? null,
    adapterVersion: binding.adapterVersion,
    provider: binding.provider,
    questionChannel: binding.questionChannel,
    tools: binding.tools,
    requires: binding.requires ?? [],
    gateContract: binding.gateContract ?? null,
    result: binding.result ?? null,
    skillDirs: binding.skillDirs,
    extraResources: binding.extraResources,
    skillNames: binding.skillNames,
    readOnlyRoots: binding.readOnlyRoots,
  })).digest('hex');
}

// ---------------------------------------------------------------------------
// Resource manifest: pin + verify
// ---------------------------------------------------------------------------

const sha256File = async (abs) =>
  createHash('sha256').update(await fs.readFile(abs)).digest('hex');

// Enumerate every regular file under the skill directories plus explicit
// extra files. Paths are stored ABSOLUTE: the manifest is a snapshot of an
// installed plugin location, and a moved source is a different source.
export async function buildManifest(binding) {
  const files = [];
  const seen = new Set();
  const addFile = async (abs) => {
    const real = path.resolve(abs);
    if (seen.has(real)) return; // an extraResource inside a skillDir counts once
    seen.add(real);
    const st = await fs.stat(real).catch(() => null);
    if (!st || !st.isFile()) fail('resource_missing', `skill resource missing: ${abs}`, { path: abs });
    files.push({ path: real, sha256: await sha256File(real), bytes: st.size });
  };
  for (const dir of binding.skillDirs) {
    const root = path.resolve(dir);
    const st = await fs.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) fail('resource_missing', `skill dir missing: ${root}`, { path: root });
    const walk = async (d) => {
      for (const ent of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile()) await addFile(p);
        else if (ent.isSymbolicLink()) {
          // A symlink inside a skill dir is still resolved and pinned —
          // pinning the link target's content catches silent retargets.
          const real = await fs.realpath(p);
          const rst = await fs.stat(real);
          if (rst.isFile()) await addFile(real);
        }
      }
    };
    await walk(root);
  }
  for (const f of binding.extraResources) await addFile(path.resolve(f));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.path}\0${f.sha256}\0${f.bytes}\n`);
  return {
    algo: 'sha256',
    digest: h.digest('hex'),
    files,
    pinnedAt: new Date().toISOString(),
  };
}

// Fail-closed integrity check: every pinned file must still exist with the
// same content, and no file may have appeared or vanished under the roots.
export async function verifyManifest(binding) {
  if (!binding.resourceManifest) {
    fail('resources_unpinned', `binding ${binding.bindingId} has no pinned resource manifest`,
      { bindingId: binding.bindingId });
  }
  const current = await buildManifest(binding);
  const pinned = new Map(binding.resourceManifest.files.map((f) => [f.path, f]));
  const missing = [], changed = [], added = [];
  for (const f of current.files) {
    const p = pinned.get(f.path);
    if (!p) { added.push(f.path); continue; }
    if (p.sha256 !== f.sha256 || p.bytes !== f.bytes) changed.push(f.path);
  }
  for (const f of binding.resourceManifest.files) {
    if (!current.files.some((c) => c.path === f.path)) missing.push(f.path);
  }
  if (missing.length || changed.length || added.length) {
    fail('resource_mismatch',
      `binding ${binding.bindingId} resources drifted: ` +
      `missing=${missing.length} changed=${changed.length} added=${added.length}`,
      { bindingId: binding.bindingId, missing, changed, added });
  }
  return { ok: true, digest: binding.resourceManifest.digest, fileCount: binding.resourceManifest.files.length };
}

// ---------------------------------------------------------------------------
// Containment policy (shared with the in-process pi extension via env config)
// ---------------------------------------------------------------------------

// Default scratch prefix ce-* skills create themselves (documented upstream):
// <tmp>/compound-engineering-<uid>. Only the current uid's dir is allowed.
export function ceScratchRoot(env = process.env) {
  const tmp = env.TMPDIR || os.tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(tmp, `compound-engineering-${uid}`);
}

// Canonical filesystem view of a path: every existing component is followed
// through symlinks; a non-existent tail keeps its normalized shape under the
// canonical nearest existing ancestor — exactly where the kernel would
// create it. A symlink whose own target is missing is still followed (the
// kernel resolves the link first). Throws on resolution errors (ELOOP,
// EACCES, …) — callers fail closed.
export function realpathNearest(p, depth = 0) {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch (e) {
    if (e.code !== 'ENOENT' || depth > 40) throw e;
    // `abs` is missing — but if it exists as a symlink the kernel still
    // follows the link; resolve the link target, not the pathname.
    let st = null;
    try { st = lstatSync(abs); } catch (e2) { if (e2.code !== 'ENOENT') throw e2; }
    if (st?.isSymbolicLink()) {
      return realpathNearest(path.resolve(path.dirname(abs), readlinkSync(abs)), depth + 1);
    }
    const parent = path.dirname(abs);
    if (parent === abs) throw e;
    return path.join(realpathNearest(parent, depth + 1), path.basename(abs));
  }
}

// All roots a binding may touch. writeRoots: the private document workspace
// + the skill's own scratch convention. readRoots additionally cover skill
// dirs (references/scripts are read via the read tool) and declared
// read-only project inputs. Workspace is always both. All roots are
// canonicalized through the real filesystem so symlink components inside a
// root cannot alias it to somewhere else (and vice versa).
export function resolveRoots(binding, workspaceRoot, { scratch = true } = {}) {
  const ws = realpathNearest(workspaceRoot);
  const write = [ws];
  if (scratch) write.push(realpathNearest(ceScratchRoot()));
  const read = new Set([...write, ...binding.skillDirs.map(realpathNearest), ...binding.extraResources.map((f) =>
    // a pinned file contributes its directory as the readable root
    realpathNearest(path.dirname(f))), ...binding.readOnlyRoots.map(realpathNearest)]);
  return { workspaceRoot: ws, writeRoots: write, readRoots: [...read] };
}

function underRoot(root, p) {
  const r = path.resolve(root);
  const t = path.resolve(p);
  return t === r || t.startsWith(r + path.sep);
}

const ABS_PATH_TOKEN = /(?:^|[\s'"`=;(])\/[A-Za-z0-9._~+@%=-][A-Za-z0-9._\/~+@%=-]*/g;
// git verbs that mutate a repository; their path targets must be write roots.
const GIT_MUTATING = /\bgit\b[^|;&]*\b(commit|add|push|pull|fetch|merge|rebase|reset|clean|checkout|switch|restore|tag|branch\s+(-[a-zA-Z]*\s*)?[^\s|;&]+|apply|am|mv|rm|init|worktree|config|remote|stash|cherry-pick|revert|update-index|write-tree|commit-tree|mktree|hash-object)\b/;
const BASH_DENY = /\b(sudo|doas|curl|wget|nc|ncat|socat|ssh|scp|rsync|ftp|telnet|docker|podman|systemctl|apt|apt-get|dpkg|snap|flatpak|pip|pip3|crontab|mount|umount|mkfs|chown|killall|pkill|eval)\b|npm\s+(install|publish|link)|pnpm\s+(install|publish)|yarn\s+(install|publish)|gem\s+install|cargo\s+install|chmod\s+777|dd\s+if=|git\s+(push|remote|config|worktree|submodule|bundle|gc)\b/;

// --- bash segment audit ------------------------------------------------------
// A command line is split on shell separators (pipes, conditionals,
// subshells, substitutions) so each program sees its own operand audit. `cd`
// is tracked across segments so relative paths resolve where they would
// actually run. Every non-flag word is a candidate path: canonicalized via
// realpathNearest and required to resolve under the registered roots — read
// floor for plain words, write floor for redirect targets and the operands
// of file-mutating commands. Words that are program text rather than paths
// (interpreter -c/-e payloads, watch/xargs strings, find -exec) are not
// auditable and fail closed.

const SEGMENT_SPLIT = /&&|\|\||[|;&()\n`]+/;
const WORD_RE = /"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HOME_TOK = /^~([A-Za-z0-9_-]*)(\/|$)/;   // ~ or ~user — expands outside roots
const HEREDOC_MARK = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// Commands whose operands always mutate the filesystem (or mint links):
// every operand must resolve under a write root.
const MUT_ALL = new Set(['ln', 'link', 'symlink', 'mv', 'rename', 'rm', 'rmdir', 'unlink',
  'mkdir', 'mkfifo', 'mknod', 'mktemp', 'touch', 'truncate', 'shred', 'chmod', 'chattr',
  'chown', 'chgrp', 'tee']);
// Copy-like: destination operand (last) must be a write root, sources need
// only be readable — except link-preserving flags, which re-mint whatever the
// source resolves to and therefore require write scope end-to-end.
const COPY_LIKE = new Set(['cp', 'install']);
const CP_LINK_FLAGS = /^-[a-zA-Z]*[sldPa]|^--(symbolic-link|link|no-dereference|preserve|archive|backup)/;
// Archive/extraction commands: the operand consumed by a dir flag is a write target.
const DIRFLAG_CMDS = new Set(['tar', 'bsdtar', 'unzip', '7z', '7zz', 'jar']);
const CONSUME_WRITE = new Set(['-t', '--target-directory', '-C', '--directory', '-d', '-o', '--output', '--out']);
const GIT_DIR_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--exec-path']);
const WRITE_EQ_FLAG = /^-{1,2}(o|out|output|output-file|to|t|target-directory|directory|d|git-dir|work-tree|exec-path)$/;
// -i / --in-place turns editors into writers.
const INPLACE = /^-[^-]*i|^--in-place/;
const INPLACE_CMDS = new Set(['sed', 'gsed', 'perl']);

// Code-execution surfaces where operands are programs, not paths — an
// un-auditable laundering channel, so they fail closed.
const ALWAYS_BLOCK = new Set(['awk', 'gawk', 'mawk', 'nawk', 'busybox', 'tclsh', 'expect', 'jjs',
  'osascript', 'screen', 'tmux', 'at', 'batch', 'systemd-run', 'su', 'newgrp', 'sg', 'chroot',
  'unshare', 'nsenter', 'gdb', 'lldb', 'strace', 'ltrace', 'npx', 'bunx', 'pnpx', 'make', 'rake',
  'mvn', 'mvnw', 'gradle', 'gradlew', 'ant', 'just', 'task']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'ksh', 'csh', 'tcsh', 'fish', 'pwsh', 'powershell', 'sash']);
const INTERPRETERS = new Set([...SHELLS, 'perl', 'php', 'lua', 'luajit', 'node', 'nodejs', 'deno',
  'bun', 'ruby', 'julia', 'groovy', 'elixir', 'erl', 'r', 'rscript', 'python', 'python2', 'python3']);
const EVAL_FLAG = /^-[a-zA-Z]*[ecpmirs]|^--(?:eval|command|module)/;
const STDIN_ARG = new Set(['-', '-s', '-i', '--stdin', '--interactive']);
const RUNNER_SUBS = {
  npm: ['run', 'exec', 'test', 'start', 'restart', 'stop', 'init', 'create', 'add', 'i', 'x', 'explore'],
  pnpm: ['run', 'exec', 'test', 'start', 'dlx', 'create', 'add', 'i', 'x'],
  yarn: ['run', 'dlx', 'test', 'start', 'exec', 'create', 'add', 'node'],
  bun: ['run', 'x', 'test', 'create', 'exec', 'eval', 'add'],
  deno: ['eval', 'task', 'test', 'bench', 'run', 'compile'],
  cargo: ['run', 'test', 'bench', 'install', 'script', 'build', 'doc'],
  go: ['run', 'test', 'generate', 'tool', 'install', 'build'],
};
// Command runners that re-execute a nested program: audit the inner command
// as its own segment; quoted program strings fail closed.
const WRAPPERS = new Set(['env', 'nice', 'ionice', 'taskset', 'chrt', 'numactl', 'timeout', 'watch',
  'stdbuf', 'nohup', 'setsid', 'command', 'builtin', 'exec', 'time', 'xargs', 'parallel']);
const KNOWN_CMDS = new Set([...INTERPRETERS, ...ALWAYS_BLOCK, ...MUT_ALL, ...COPY_LIKE,
  ...DIRFLAG_CMDS, ...WRAPPERS, ...Object.keys(RUNNER_SUBS),
  'cd', 'pushd', 'popd', 'git', 'find', 'sed', 'cat', 'source', '.', 'ls', 'grep', 'head', 'tail']);
const FIND_DANGER = /^-(exec|execdir|ok|okdir|delete|fprintf|fprint)$/;

function unquote(w) {
  return w.length >= 2 && ((w[0] === '"' && w.endsWith('"')) || (w[0] === "'" && w.endsWith("'")))
    ? w.slice(1, -1) : w;
}

// Audit one tool-call bash command. ctx supplies canonical roots + cwd and
// the inWrite/inRead membership tests. Returns a decision object.
function auditBashCommand(cmd, ctx) {
  const { mutating } = ctx;
  const fail = (kind, reason, extra = {}) => ({ block: true, kind, reason, ...extra });

  // Absolute path tokens anywhere in the command — canonicalized through
  // the real filesystem (a token under a symlinked workspace path resolves
  // to its true target).
  const tokens = cmd.match(ABS_PATH_TOKEN) ?? [];
  for (const raw of tokens) {
    const tok = raw.replace(/^[\s'"`=;(]+/, '');
    if (!tok.startsWith('/') || tok === '/dev/null') continue; // sink is not a file
    let real;
    try { real = realpathNearest(tok); }
    catch (e) { return fail('bash_path', `bash: cannot resolve path ${tok} (${e.code ?? e.message})`); }
    if (mutating ? !ctx.inWrite(real) : !ctx.inRead(real)) {
      return fail(mutating ? 'bash_git_scope' : 'bash_path',
        `bash: ${mutating ? 'mutating git op targets' : 'path'} ${tok} outside allowed roots`, { resolved: real });
    }
  }

  const state = { cwd: ctx.wsRoot };
  for (const seg of cmd.split(SEGMENT_SPLIT)) {
    const words = (seg.match(WORD_RE) ?? []).map(unquote).filter((w) => w.length);
    const bad = auditSegment(words, state, ctx);
    if (bad) return bad;
  }
  return { allow: true };
}

function auditSegment(words, state, ctx, depth = 0) {
  const { mutating } = ctx;
  const fail = (kind, reason, extra = {}) => ({ block: true, kind, reason, ...extra });
  const checkPath = (word, write, label) => {
    // /dev/null is a sink/source device, not a file — discarding or EOF-ing
    // through it is not filesystem access.
    if (word === '/dev/null') return null;
    if (HOME_TOK.test(word)) {
      return fail('bash_path', `bash: ${label} ${word} expands outside registered roots`);
    }
    let real;
    try {
      real = realpathNearest(path.isAbsolute(word) ? word : path.resolve(state.cwd, word));
    } catch (e) {
      return fail('bash_path', `bash: cannot resolve ${label} ${word} (${e.code ?? e.message})`);
    }
    if (!(write ? ctx.inWrite(real) : ctx.inRead(real))) {
      return fail('bash_path', `bash: ${label} ${word} resolves outside allowed roots`, { resolved: real });
    }
    return null;
  };

  let s = 0;
  while (s < words.length && ASSIGN_RE.test(words[s])) {
    // leading FOO=path assignments — check the RHS too
    const rhs = words[s].slice(words[s].indexOf('=') + 1);
    if (rhs.length) {
      const bad = checkPath(rhs, false, 'env assignment'); if (bad) return bad;
    }
    s++;
  }
  if (s >= words.length) return null;             // pure assignment segment
  const cmdName = path.basename(words[s]);
  const ops = words.slice(s + 1);

  // Redirect targets: > >> (write floor) and < << <<< (read floor).
  for (let j = s; j < words.length; j++) {
    const w = words[j];
    for (const m of w.matchAll(/>>?(&\d+)?([^\s<>&]*)/g)) {
      if (m[1]) continue;                          // fd duplication >&2
      const t = m[2] || words[j + 1];
      if (t === undefined || t === '/dev/null') continue;          // sink — not a file
      const bad = checkPath(t, true, 'redirect target'); if (bad) return bad;
    }
    for (const m of w.matchAll(/<<<?(&\d+)?([^\s<>&]*)/g)) {
      if (m[1]) continue;                          // fd duplication <&0
      if (m[0].startsWith('<<<')) continue;        // herestring — text, not a path
      const t = m[2] || words[j + 1];
      if (t === undefined || t === '/dev/null') continue;
      if (m[0].startsWith('<<') && HEREDOC_MARK.test(t)) continue; // heredoc marker
      const bad = checkPath(t, false, 'redirect source'); if (bad) return bad;
    }
  }

  // Command-name dispatch: un-auditable surfaces fail closed.
  if (ALWAYS_BLOCK.has(cmdName)) return fail('bash_deny', `bash: ${cmdName} is not auditable`);
  const subs = RUNNER_SUBS[cmdName];
  if (subs) {
    const first = ops.find((w) => !w.startsWith('-'));
    if (first && subs.includes(first)) {
      return fail('bash_deny', `bash: ${cmdName} ${first} executes workspace-defined commands`);
    }
  }
  if (INTERPRETERS.has(cmdName)) {
    const evalFlag = ops.some((w) => EVAL_FLAG.test(w) || STDIN_ARG.has(w));
    const script = ops.find((w) => !w.startsWith('-'));
    if (evalFlag || !script) {
      return fail('bash_eval', `bash: ${cmdName} inline/stdin code is not auditable`);
    }
  }
  if (cmdName === 'find' && ops.some((w) => FIND_DANGER.test(w))) {
    return fail('bash_eval', 'bash: find -exec/-delete is not auditable');
  }
  if (WRAPPERS.has(cmdName)) {
    if (depth > 8 || ops.some((w) => /\s/.test(w))) {
      return fail('bash_eval', `bash: ${cmdName} program string is not auditable`);
    }
    const inner = ops.findIndex((w) => KNOWN_CMDS.has(path.basename(w)));
    if (inner >= 0) {
      const bad = auditSegment(ops.slice(inner), state, ctx, depth + 1);
      if (bad) return bad;
    }
  }

  // Operand classification. Flag values (--x=v) contribute the RHS; flags
  // that consume the NEXT operand as a write target are tracked in order.
  const hasLinkFlag = COPY_LIKE.has(cmdName) && ops.some((w) => CP_LINK_FLAGS.test(w));
  const hasInPlace = INPLACE_CMDS.has(cmdName) && ops.some((w) => INPLACE.test(w));
  const plain = ops.filter((w) => !w.startsWith('-'));

  if (cmdName === 'cd' || cmdName === 'pushd') {
    const t = plain[0];
    if (t === undefined || t === '-' || HOME_TOK.test(t)) {
      return fail('bash_path', `bash: ${cmdName} target is outside registered roots`);
    }
    let real;
    try { real = realpathNearest(path.isAbsolute(t) ? t : path.resolve(state.cwd, t)); }
    catch (e) { return fail('bash_path', `bash: cannot resolve ${cmdName} target ${t} (${e.code ?? e.message})`); }
    if (!ctx.inRead(real)) {
      return fail('bash_path', `bash: ${cmdName} ${t} resolves outside allowed roots`, { resolved: real });
    }
    state.cwd = real;
  } else if (cmdName === 'popd') {
    return fail('bash_path', 'bash: popd target is not auditable');
  }

  let pendingWrite = false;
  for (let i = 0; i < ops.length; i++) {
    const w = ops[i];
    if (w.startsWith('-')) {
      if (GIT_DIR_FLAGS.has(w) && (mutating || cmdName !== 'git') && CONSUME_WRITE.has(w)) pendingWrite = true;
      else if (CONSUME_WRITE.has(w) && (cmdName !== 'git' || mutating)) pendingWrite = true;
      else if (DIRFLAG_CMDS.has(cmdName) && CONSUME_WRITE.has(w)) pendingWrite = true;
      const eq = w.indexOf('=');
      if (eq > 1) {
        const flag = w.slice(0, eq);
        const rhs = w.slice(eq + 1);
        const write = mutating || WRITE_EQ_FLAG.test(flag) || MUT_ALL.has(cmdName);
        const bad = checkPath(rhs, write, 'flag value'); if (bad) return bad;
      }
      continue;
    }
    if (pendingWrite && ASSIGN_RE.test(w)) pendingWrite = false;
    const isAssign = ASSIGN_RE.test(w);
    const word = isAssign ? w.slice(w.indexOf('=') + 1) : w;
    if (isAssign && !word.length) continue;
    const needWrite = pendingWrite
      || (mutating && cmdName === 'git')
      || MUT_ALL.has(cmdName)
      || hasInPlace
      || cmdName === 'tee'
      || (COPY_LIKE.has(cmdName) && (hasLinkFlag || w === plain[plain.length - 1]));
    pendingWrite = false;
    const bad = checkPath(word, needWrite, 'path'); if (bad) return bad;
  }
  return null;
}

// Evaluate one tool call against the binding's containment policy.
// Returns { allow: true } or { block: true, reason, kind }.
// Pure function — the same decision is auditable from the driver and
// enforceable in-process by the pi extension. Paths are compared AFTER
// canonicalization through the real filesystem: a symlink inside the
// workspace pointing outside the registered roots does not launder an
// escape, and workspace-relative paths still work.
export function checkToolCall(toolName, input, roots) {
  const name = String(toolName || '');
  const args = isObj(input) ? input : {};
  // Canonicalize roots defensively — callers may hand-build the set. A root
  // that cannot be resolved collapses to its lexical form (still fail-closed:
  // targets are always canonicalized before comparison).
  const canonRoot = (p) => { try { return realpathNearest(p); } catch { return path.resolve(p); } };
  const wsRoot = canonRoot(roots.workspaceRoot);
  const writeRoots = (roots.writeRoots ?? []).map(canonRoot);
  const readSet = [...writeRoots, ...(roots.readRoots ?? []).map(canonRoot)];
  const inWrite = (p) => writeRoots.some((r) => underRoot(r, p));
  const inRead = (p) => readSet.some((r) => underRoot(r, p));

  if (name === 'write' || name === 'edit') {
    const p = args.path ?? args.file ?? args.filePath ?? args.target_file;
    if (typeof p !== 'string' || !p.length) {
      return { block: true, kind: 'path', reason: `${name}: missing target path` };
    }
    let resolved;
    try {
      resolved = realpathNearest(path.isAbsolute(p) ? p : path.resolve(wsRoot, p));
    } catch (e) {
      return { block: true, kind: 'path', reason: `${name}: cannot resolve ${p} (${e.code ?? e.message})` };
    }
    if (!inWrite(resolved)) {
      return { block: true, kind: 'path', resolved,
        reason: `${name}: ${p} resolves outside the document workspace` };
    }
    return { allow: true, resolved };
  }

  if (name === 'read') {
    const p = args.path ?? args.file ?? args.filePath;
    if (typeof p !== 'string' || !p.length) return { allow: true };
    let resolved;
    try {
      resolved = realpathNearest(path.isAbsolute(p) ? p : path.resolve(wsRoot, p));
    } catch (e) {
      return { block: true, kind: 'path', reason: `read: cannot resolve ${p} (${e.code ?? e.message})` };
    }
    if (!inRead(resolved)) {
      return { block: true, kind: 'path', resolved,
        reason: `read: ${p} resolves outside registered roots` };
    }
    return { allow: true, resolved };
  }

  if (name === 'bash') {
    const cmd = String(args.command ?? '');
    const deny = cmd.match(BASH_DENY);
    if (deny) return { block: true, kind: 'bash_deny', reason: `bash: denied operation "${deny[0]}"` };
    return auditBashCommand(cmd, { mutating: GIT_MUTATING.test(cmd), wsRoot, inWrite, inRead });
  }

  // Unknown/non-filesystem tools (ask_user, list/read-only helpers) pass;
  // the probe still records them for the audit log.
  return { allow: true };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export function verdictFor(binding, evidence) {
  const failures = [];
  const exp = binding.expect ?? {};
  const arts = evidence.artifacts ?? {};
  for (const glob of exp.artifacts ?? []) {
    if (!(arts[glob] ?? []).length) failures.push(`missing artifact ${glob}`);
  }
  for (const [k, v] of Object.entries(exp.frontmatter ?? {})) {
    if (evidence.frontmatter?.[k] !== v) {
      failures.push(`frontmatter ${k}: want ${JSON.stringify(v)}, got ${JSON.stringify(evidence.frontmatter?.[k])}`);
    }
  }
  if (exp.gitCommit && !evidence.gitCommits?.length) failures.push('no git commit in document workspace');
  if ((exp.minChatQuestions ?? 0) > (evidence.chatQuestions ?? 0)) {
    failures.push(`chat questions ${evidence.chatQuestions ?? 0} < ${exp.minChatQuestions}`);
  }
  if ((exp.minUiRequests ?? 0) > (evidence.uiRequests ?? 0)) {
    failures.push(`extension_ui requests ${evidence.uiRequests ?? 0} < ${exp.minUiRequests}`);
  }
  if (exp.finalTextPattern) {
    const re = new RegExp(exp.finalTextPattern, 'i');
    const text = evidence.finalText ?? evidence.lastText ?? '';
    if (!re.test(text)) failures.push(`final text lacks /${exp.finalTextPattern}/`);
  }
  if (evidence.containmentViolations?.length) {
    failures.push(`containment violations: ${evidence.containmentViolations.length}`);
  }
  return { ok: failures.length === 0, failures };
}
