// server/execution/execution-store.mjs — durable store for the managed-card
// execution model (plan: docs/plans/agent-core-implementation-plan.md, U2).
//
// Layout under <STATE_DIR>/execution/state/ — deliberately OUTSIDE the flat
// /api/state/:name namespace (doc names can't contain '/') and apart from the
// runner's runtime artifacts (steer/, outputs/, attempts/ under the same
// execution/ root per the plan):
//
//   state/cards/<cardId>.json      — the card aggregate (source of truth)
//   state/blobs/<sha256>.md        — immutable document contents
//   state/presets.json             — participant-composition registry
//   state/runs/<runId>.json        — run record (written by U3+)
//   state/runs/<runId>.events.jsonl — run events (written by U3+)
//
// Every JSON write is tmp+rename atomic. Blob write precedes the aggregate
// that references it, so a crash can leave an unreferenced blob but never a
// reference to a missing blob. Zero dependencies, import-safe.
//
// The store performs no locking of its own — callers must serialize writers
// (state-service.mjs does).

import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  SAFE_ID_RE,
  RuntimeError,
} from './common.mjs';

export const EXECUTION_SUBDIR = join('execution', 'state');
export const AGGREGATE_VERSION = 1;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const DOC_KINDS = ['requirements', 'plan', 'design'];

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function paths(stateDir) {
  const root = join(stateDir, EXECUTION_SUBDIR);
  return {
    root,
    cardsDir: join(root, 'cards'),
    blobsDir: join(root, 'blobs'),
    runsDir: join(root, 'runs'),
    presetsFile: join(root, 'presets.json'),
    compatFile: join(root, 'cli-compat.json'),
    schedulerFile: join(root, 'scheduler.json'),
  };
}

export async function ensureStore(stateDir) {
  const p = paths(stateDir);
  await ensureDir(p.cardsDir);
  await ensureDir(p.blobsDir);
  await ensureDir(p.runsDir);
  return p;
}

// --- aggregates ---------------------------------------------------------------

function cardPath(stateDir, cardId) {
  if (typeof cardId !== 'string' || !SAFE_ID_RE.test(cardId)) {
    throw new RuntimeError('invalid_card_id', `invalid card id: ${JSON.stringify(cardId)}`);
  }
  const p = paths(stateDir);
  return join(p.cardsDir, `${cardId}.json`);
}

export async function loadAggregate(stateDir, cardId) {
  let p;
  try {
    p = cardPath(stateDir, cardId);
  } catch {
    return null; // an unusable id is simply not a managed card
  }
  let raw;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // absent is fine
    throw e;
  }
  // An EXISTING aggregate that cannot be parsed fails closed: the card stays
  // managed, every write touching it errors, and nothing may delete or
  // re-enable it silently. Only absent files read as null.
  let agg;
  try {
    agg = JSON.parse(raw);
  } catch (e) {
    throw new RuntimeError('corrupt_store', `aggregate ${cardId} unreadable: ${e.message}`);
  }
  if (!agg || typeof agg !== 'object' || agg.cardId !== cardId) {
    throw new RuntimeError('corrupt_store', `aggregate ${cardId} has malformed identity`);
  }
  return agg;
}

export async function saveAggregate(stateDir, aggregate) {
  await atomicWriteJson(cardPath(stateDir, aggregate.cardId), aggregate);
  return aggregate;
}

/** The managed set is the set of aggregate files — no separate index that
 * could drift. Card counts are small; a readdir per write is cheap and keeps
 * the directory listing itself the recovery anchor. */
export async function listManagedCardIds(stateDir) {
  const p = paths(stateDir);
  let entries = [];
  try {
    entries = await fs.readdir(p.cardsDir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const cardId = ent.name.slice(0, -'.json'.length);
    if (SAFE_ID_RE.test(cardId)) out.push(cardId);
  }
  out.sort();
  return out;
}

export async function listAggregates(stateDir) {
  const ids = await listManagedCardIds(stateDir);
  const out = [];
  for (const id of ids) {
    const agg = await loadAggregate(stateDir, id);
    if (agg) out.push(agg);
  }
  return out;
}

// --- blobs (immutable, content-addressed) --------------------------------------

export async function writeBlob(stateDir, content) {
  const hash = sha256(content);
  const p = join(paths(stateDir).blobsDir, `${hash}.md`);
  try {
    const st = await fs.stat(p);
    if (st.isFile()) {
      // Content-addressed reuse still verifies: a file at the hash name that
      // does not hold the content is corruption, never a cache hit.
      const existing = await fs.readFile(p, 'utf-8');
      if (sha256(existing) !== hash) {
        throw new RuntimeError('corrupt_store', `blob ${hash} exists but content does not match its name`);
      }
      return { sha256: hash, bytes: st.size, existed: true };
    }
  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    if (!e || e.code !== 'ENOENT') throw e;
  }
  await atomicWriteFile(p, content, 0o444);
  return { sha256: hash, bytes: Buffer.byteLength(content, 'utf8'), existed: false };
}

// Returns null only when the blob is absent or the name is malformed. A
// present blob whose bytes do not hash to its name is corruption and throws.
export async function readBlob(stateDir, hash) {
  if (typeof hash !== 'string' || !SHA256_RE.test(hash)) return null;
  let text;
  try {
    text = await fs.readFile(join(paths(stateDir).blobsDir, `${hash}.md`), 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  if (sha256(text) !== hash) {
    throw new RuntimeError('corrupt_store', `blob ${hash} content does not match its name`);
  }
  return text;
}

/** Assert the blob exists and hashes correctly — used before anything binds
 * to the hash (approvals) or serves it as evidence. */
export async function requireBlob(stateDir, hash, what = 'document') {
  const text = await readBlob(stateDir, hash);
  if (text === null) {
    throw new RuntimeError('corrupt_store', `${what} blob ${hash} is missing — referenced but not stored`);
  }
  return text;
}

// --- presets -------------------------------------------------------------------

function emptyPresets() {
  return { version: 1, rev: 0, updatedAt: 0, presets: [] };
}

export async function loadPresets(stateDir) {
  let raw;
  try {
    raw = await fs.readFile(paths(stateDir).presetsFile, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyPresets();
    throw e;
  }
  // Same fail-closed rule as aggregates: an existing registry that cannot be
  // parsed or fails its shape check is corruption, never an empty registry —
  // overwriting it would silently delete every preset.
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new RuntimeError('corrupt_store', `presets.json unreadable: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.presets)) {
    throw new RuntimeError('corrupt_store', 'presets.json has a malformed registry shape');
  }
  return {
    version: 1,
    rev: Number(doc.rev) || 0,
    updatedAt: Number(doc.updatedAt) || 0,
    presets: doc.presets,
  };
}

export async function savePresets(stateDir, doc) {
  await atomicWriteJson(paths(stateDir).presetsFile, doc);
  return doc;
}

// --- runs (populated by U3+; read routes exist in U2) ----------------------------

export async function loadRun(stateDir, runId) {
  if (typeof runId !== 'string' || !SAFE_ID_RE.test(runId)) return null;
  try {
    const raw = await fs.readFile(join(paths(stateDir).runsDir, `${runId}.json`), 'utf-8');
    const run = JSON.parse(raw);
    return run && typeof run === 'object' ? run : null;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new RuntimeError('corrupt_store', `run ${runId} unreadable: ${e.message}`);
  }
}

export async function saveRun(stateDir, run) {
  await atomicWriteJson(join(paths(stateDir).runsDir, `${run.id}.json`), run);
  return run;
}

// --- run events (jsonl, canonical atomic projection) ------------------------------
//
// The AUTHORITATIVE event list lives on the aggregate (run.events). This
// file is only its projection, so writes are a full canonical rewrite —
// tmp+rename atomic — which makes torn writes un-representable: a crash can
// leave a stale file but never a half-line to corrupt the next event.
// Rebuilds merge existing valid lines with the authoritative set keyed by
// seq (the existing side preserves anything an older writer accepted), so
// replaying an intent cannot lose or duplicate an accepted event.

export function runEventsPath(stateDir, runId) {
  if (typeof runId !== 'string' || !SAFE_ID_RE.test(runId)) {
    throw new RuntimeError('invalid_run_id', `invalid run id: ${JSON.stringify(runId)}`);
  }
  return join(paths(stateDir).runsDir, `${runId}.events.jsonl`);
}

export async function readRunEvents(stateDir, runId) {
  const file = runEventsPath(stateDir, runId);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ type: 'unparsed', raw: line });
    }
  }
  return out;
}

// Parse the existing log into a seq-keyed map. Only complete '\n'-terminated
// JSON lines with an integer seq are durable evidence; anything else is a
// torn/corrupt line — counted and excluded from the rewrite (an accepted
// event is always re-supplied from the aggregate side of the merge).
function parseEventFile(raw) {
  const bySeq = new Map();
  let corrupt = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { corrupt += 1; continue; }
    if (!e || typeof e !== 'object' || !Number.isInteger(e.seq)) {
      corrupt += 1;
      continue;
    }
    if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
    else corrupt += 1; // duplicate seq inside the stored file — malformed
  }
  return { bySeq, corrupt };
}

// Merge authoritative `events` into the file and rewrite it atomically.
// Returns diagnostics — callers surface droppedCorrupt/conflicts instead of
// absorbing them silently. A seq collision with different content keeps the
// STORED line (durable wins) and reports a conflict.
export async function writeRunEvents(stateDir, runId, events) {
  const file = runEventsPath(stateDir, runId);
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  const { bySeq, corrupt } = parseEventFile(raw);
  let conflicts = 0;
  for (const ev of events || []) {
    if (!ev || !Number.isInteger(ev.seq)) {
      throw new RuntimeError('invalid_argument', 'run event missing integer seq');
    }
    const prev = bySeq.get(ev.seq);
    if (prev) {
      if (JSON.stringify(prev) !== JSON.stringify(ev)) conflicts += 1;
      continue;
    }
    bySeq.set(ev.seq, ev);
  }
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  await ensureDir(paths(stateDir).runsDir);
  await atomicWriteFile(file,
    merged.map((e) => JSON.stringify(e)).join('\n') + (merged.length ? '\n' : ''),
    0o640);
  return { written: merged.length, droppedCorrupt: corrupt, conflicts };
}

// --- scheduler limits (operator-editable, fail-closed parse) ---------------------
//
// <state>/scheduler.json: {limits: {global: N, roles: {implementer: N, ...}}}.
// Absent -> defaults; present-but-malformed throws — silently defaulting a
// corrupt limits file would let unbounded concurrency through exactly when
// the operator meant to cap it.
export const DEFAULT_LIMITS = {
  global: 2,
  roles: { implementer: 1, reviewer: 1, checker: 1 },
};

export async function loadSchedulerLimits(stateDir) {
  const file = paths(stateDir).schedulerFile;
  let raw;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return structuredClone(DEFAULT_LIMITS);
    }
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new RuntimeError('corrupt_store', `scheduler.json unreadable: ${e.message}`);
  }
  const lim = doc && typeof doc === 'object' ? doc.limits : null;
  if (!lim || typeof lim !== 'object') {
    throw new RuntimeError('corrupt_store', 'scheduler.json must be {limits:{global,roles}}');
  }
  const num = (v, tag) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      throw new RuntimeError('corrupt_store', `scheduler.json ${tag} must be an integer in [0,1000]`);
    }
    return n;
  };
  const roles = {};
  if (lim.roles !== undefined) {
    if (!lim.roles || typeof lim.roles !== 'object' || Array.isArray(lim.roles)) {
      throw new RuntimeError('corrupt_store', 'scheduler.json limits.roles must be an object');
    }
    for (const [role, v] of Object.entries(lim.roles)) {
      if (!SAFE_ID_RE.test(role)) {
        throw new RuntimeError('corrupt_store', `scheduler.json limits.roles has bad role key ${role}`);
      }
      roles[role] = num(v, `limits.roles.${role}`);
    }
  }
  return {
    global: num(lim.global ?? DEFAULT_LIMITS.global, 'limits.global'),
    roles: { ...structuredClone(DEFAULT_LIMITS.roles), ...roles },
  };
}

export async function saveSchedulerLimits(stateDir, limits) {
  await atomicWriteJson(paths(stateDir).schedulerFile, { version: 1, limits });
  return limits;
}

// --- environment ledger (U4) -----------------------------------------------------
//
// <state>/environments.json records which environment instance currently owns
// each runner SLOT (v1 deployment: one container per slot). An envInstance is
// {containerId, initStarttime} — stable across a same-container Node restart
// and different after a container recreate even on the same host boot.
//
// The ledger records IDENTITY only. slot.current changing proves a new
// registration, never the old container's death — a second container may
// register the same slot while the first still runs. Positive retirement
// evidence lives in `retirements[]`: an ops-verified record (bound to the
// exact envInstance+registration generation) written only through the ops
// credential by the host management helper after the exact container is
// confirmed stopped/removed. Nothing here ever signals a pid.
//
// Fail-closed like presets/aggregates: absent file means an empty ledger,
// but a PRESENT malformed ledger throws — silently coercing a bad
// `commands`/`retirements`/`slots` shape would lose dedup and unprove death.

export function environmentsFile(stateDir) {
  return join(paths(stateDir).root, 'environments.json');
}

export function emptyEnvironments() {
  return { version: 1, rev: 0, updatedAt: 0, slots: {}, retirements: [], commands: {} };
}

const ENV_INSTANCE_OK = (v) => v && typeof v === 'object' && !Array.isArray(v)
  && (v.containerId === null || typeof v.containerId === 'string')
  && (v.initStarttime === null || typeof v.initStarttime === 'string');

function envEntryOk(e) {
  return e && typeof e === 'object' && !Array.isArray(e)
    && ENV_INSTANCE_OK(e.envInstance)
    && Number.isInteger(e.generation) && e.generation >= 1
    && typeof e.runnerId === 'string'
    && typeof e.instanceId === 'string'
    && typeof e.registeredAt === 'number'
    && typeof e.lastSeenAt === 'number';
}

function envRetirementOk(r) {
  return r && typeof r === 'object' && !Array.isArray(r)
    && typeof r.retirementId === 'string'
    && typeof r.slot === 'string'
    && ENV_INSTANCE_OK(r.envInstance)
    && Number.isInteger(r.generation) && r.generation >= 1
    && typeof r.by === 'string'
    && r.evidence && typeof r.evidence === 'object'
    && r.evidence.source === 'compose_lifecycle'
    && typeof r.evidence.containerId === 'string'
    && (r.evidence.state === 'stopped' || r.evidence.state === 'removed')
    && r.evidence.observedAt !== undefined
    && typeof r.retiredAt === 'number';
}

export function validateEnvironments(doc) {
  const bad = (msg) => new RuntimeError('corrupt_store', `environments.json malformed: ${msg}`);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw bad('not an object');
  }
  if (doc.version !== 1) throw bad(`version ${JSON.stringify(doc.version)}`);
  if (!Number.isInteger(doc.rev) || doc.rev < 0) throw bad(`rev ${JSON.stringify(doc.rev)}`);
  if (!(typeof doc.updatedAt === 'number' && doc.updatedAt >= 0)) {
    throw bad(`updatedAt ${JSON.stringify(doc.updatedAt)}`);
  }
  if (!doc.slots || typeof doc.slots !== 'object' || Array.isArray(doc.slots)) {
    throw bad('slots must be an object');
  }
  for (const [slot, s] of Object.entries(doc.slots)) {
    if (!SAFE_ID_RE.test(slot)) throw bad(`bad slot id ${JSON.stringify(slot)}`);
    if (!s || typeof s !== 'object' || !envEntryOk(s.current)) {
      throw bad(`slot ${slot}: bad current registration`);
    }
    if (!Array.isArray(s.history) || !s.history.every((h) => envEntryOk(h))) {
      throw bad(`slot ${slot}: bad history`);
    }
  }
  if (!Array.isArray(doc.retirements) || !doc.retirements.every(envRetirementOk)) {
    throw bad('retirements must be an array of validated records');
  }
  if (!doc.commands || typeof doc.commands !== 'object' || Array.isArray(doc.commands)) {
    throw bad('commands must be an object');
  }
  for (const [cid, c] of Object.entries(doc.commands)) {
    if (!c || typeof c !== 'object' || typeof c.type !== 'string'
      || typeof c.payloadHash !== 'string' || typeof c.at !== 'number') {
      throw bad(`bad command record ${JSON.stringify(cid)}`);
    }
  }
  return doc;
}

export async function loadEnvironments(stateDir) {
  let raw;
  try {
    raw = await fs.readFile(environmentsFile(stateDir), 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyEnvironments();
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new RuntimeError('corrupt_store', `environments.json unreadable: ${e.message}`);
  }
  return validateEnvironments(doc);
}

export async function saveEnvironments(stateDir, doc) {
  validateEnvironments(doc);
  await atomicWriteJson(environmentsFile(stateDir), doc);
  return doc;
}

// --- run artifacts (U4) -------------------------------------------------------------
//
// Stored under <state>/artifacts/<runId>/<file> and served by the managed
// artifact route (server-mediated; a client never supplies a path). `name`
// must be a bare filename — no separators, no traversal. Content is capped
// by the caller (runtime result payloads are bounded upstream); secrets must
// never be written here — callers pass agent-visible output only.

export const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function runArtifactsDir(stateDir, runId) {
  if (typeof runId !== 'string' || !SAFE_ID_RE.test(runId)) {
    throw new RuntimeError('invalid_run_id', `invalid run id: ${JSON.stringify(runId)}`);
  }
  return join(paths(stateDir).root, 'artifacts', runId);
}

// Staging area for runner-produced artifact content: the runner writes to
// <state>/execution/staged/<attemptId>/<file> (shared mount, OUTSIDE the
// serialized store), then asks the service over the internal channel to
// import it. The service verifies hash+binding inside its write queue before
// the file lands under artifacts/<runId>/ — the runner never writes the
// serialized store directly.
export function artifactStagingDir(stateDir) {
  return join(stateDir, 'execution', 'staged');
}

// Final-output artifacts are bounded: an oversize result is an explicit
// `artifact_too_large` failure, never a silent truncation passed off as the
// full result. 4 MiB leaves generous headroom over real agent finals while
// staying under the document ceiling.
export const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;

export async function writeStagedArtifact(stateDir, attemptId, name, content) {
  if (typeof attemptId !== 'string' || !SAFE_ID_RE.test(attemptId)) {
    throw new RuntimeError('invalid_argument', `invalid attemptId: ${JSON.stringify(attemptId)}`);
  }
  if (typeof name !== 'string' || !ARTIFACT_NAME_RE.test(name)) {
    throw new RuntimeError('invalid_argument', `artifact name must match ${ARTIFACT_NAME_RE}`);
  }
  const contentBytes = Buffer.isBuffer(content)
    ? content.length : Buffer.byteLength(String(content ?? ''), 'utf8');
  if (contentBytes > ARTIFACT_MAX_BYTES) {
    throw new RuntimeError('artifact_too_large',
      `artifact ${name} exceeds the ${ARTIFACT_MAX_BYTES}-byte accepted bound`);
  }
  const dir = join(artifactStagingDir(stateDir), attemptId);
  await ensureDir(dir);
  const file = join(dir, name);
  const resolved = resolve(dir, name);
  if (resolved !== file || name.includes('/') || name.includes('\\')) {
    throw new RuntimeError('invalid_argument', `artifact name escapes the staging dir: ${name}`);
  }
  await atomicWriteFile(file, content, 0o640);
  const buf = await fs.readFile(file);
  return { stagedPath: file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

// Service-side import, called INSIDE the serialized queue: verifies the
// staged path is inside the staging root, verifies the recorded sha256
// against actual content, then moves it into artifacts/<runId>/.
export async function importStagedArtifact(stateDir, { runId, file, sha256: wantSha, stagedPath }) {
  const stageRoot = resolve(artifactStagingDir(stateDir));
  const src = resolve(stagedPath);
  if (!src.startsWith(`${stageRoot}${sep}`)) {
    throw new RuntimeError('artifact_path_escape', `staged path ${stagedPath} escapes the staging root`);
  }
  const content = await fs.readFile(src);
  const gotSha = createHash('sha256').update(content).digest('hex');
  if (wantSha && gotSha !== wantSha) {
    throw new RuntimeError('artifact_hash_mismatch',
      `staged artifact sha256 ${gotSha} != recorded ${wantSha}`);
  }
  const dir = runArtifactsDir(stateDir, runId);
  await ensureDir(dir);
  await atomicWriteFile(join(dir, file), content, 0o640);
  await fs.rm(src, { force: true }).catch(() => {});
  return { file, bytes: content.length, sha256: gotSha };
}

export async function writeRunArtifact(stateDir, runId, name, content) {
  if (typeof name !== 'string' || !ARTIFACT_NAME_RE.test(name)) {
    throw new RuntimeError('invalid_argument', `artifact name must match ${ARTIFACT_NAME_RE}: ${JSON.stringify(name)}`);
  }
  const dir = runArtifactsDir(stateDir, runId);
  await ensureDir(dir);
  const file = join(dir, name);
  const resolved = resolve(dir, name);
  if (resolved !== join(dir, name) || name.includes('/') || name.includes('\\')) {
    throw new RuntimeError('invalid_argument', `artifact name escapes the run dir: ${name}`);
  }
  await atomicWriteFile(file, content, 0o640);
  const buf = await fs.readFile(file);
  return {
    file: name,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

// --- operator-editable CLI/model compatibility ---------------------------------
// Shape: { "cli": {"models":[...], "effort":[...]|null, "params":[...]} } —
// a bare array value is shorthand for {models:[...]}. Absent file -> null
// (seed table only). A malformed or wrongly shaped override throws
// compat_invalid: silently falling back to the seed could let unsupported
// model/settings through or mask a misconfigured deployment.

export async function loadCompatOverride(stateDir) {
  let raw;
  try {
    raw = await fs.readFile(paths(stateDir).compatFile, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new RuntimeError('compat_invalid', `cli-compat.json is not valid JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new RuntimeError('compat_invalid', 'cli-compat.json must be an object {cli: {...}}');
  }
  const arrOk = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string' && s.length > 0);
  for (const [cli, v] of Object.entries(doc)) {
    const o = Array.isArray(v) ? { models: v } : v;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      throw new RuntimeError('compat_invalid', `cli-compat.json[${cli}] must be an object or a model array`);
    }
    for (const key of Object.keys(o)) {
      if (!['models', 'effort', 'params'].includes(key)) {
        throw new RuntimeError('compat_invalid', `cli-compat.json[${cli}] has unknown key "${key}"`);
      }
    }
    if (o.models !== undefined && !arrOk(o.models)) {
      throw new RuntimeError('compat_invalid', `cli-compat.json[${cli}].models must be a non-empty-string array`);
    }
    if (o.effort !== undefined && o.effort !== null && !arrOk(o.effort)) {
      throw new RuntimeError('compat_invalid', `cli-compat.json[${cli}].effort must be a string array or null`);
    }
    if (o.params !== undefined && !arrOk(o.params)) {
      throw new RuntimeError('compat_invalid', `cli-compat.json[${cli}].params must be a string array`);
    }
  }
  return doc;
}
