// server/execution/orchestrator/integration-artifacts.mjs — O2 canonical
// conflict IntegrationArtifacts (KTD3).
//
// When two accepted parents do not merge cleanly, NO worker launches on the
// conflict and the server NEVER silently picks a side. The resolution is a
// separate immutable IntegrationArtifact, canonical for the key of exact
// input resultCommits + stable topological build order: two parallel
// dependents needing the same base MUST reuse one artifact, and the final
// integration MUST reproduce the recorded resolution, never re-resolve the
// same conflict differently.
//
// The resolution TEXT is caller-supplied (the integrator participant writes
// it inside the plan; the module never invents approvals or discards diff).
// This module is the deterministic bookkeeping around it: key computation,
// idempotent durable store (atomic writes), exact-key reuse, and the
// overlap-compatibility gate — merging two artifacts whose input sets
// overlap but whose resolutions disagree requires a fresh joint resolution
// and invalidates consumers of the old versions.
//
// Layout under storeDir (controller-owned, durable):
//   <key>.json — the artifact record, written atomically, never mutated.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeError, normPath, ensureDir } from '../common.mjs';
import { exclusiveCreateArtifact } from './durable-artifact.mjs';
import { invalid, conflict } from './errors.mjs';
import { sha256, canonicalJson, SHA256_RE } from './canonical.mjs';
import { COMMIT_RE, treeHashFor, blobAt } from './workspaces.mjs';

export const ARTIFACT_VERSION = 1;

const ARTIFACT_KEYS = new Set([
  'version', 'kind', 'key', 'inputs', 'order', 'baseTree',
  'resolution', 'resolvedPaths', 'supersedes', 'resultCommit', 'resultTree', 'createdAt',
]);

// Canonical key: exact input resultCommits in stable topological build
// order. Same parents + same order = same key; any commit change or order
// change = a different conflict = a different artifact.
export function artifactKey(inputs, order) {
  if (!Array.isArray(inputs) || !inputs.length) {
    throw invalid('invalid_argument', 'inputs must be a non-empty array');
  }
  if (!Array.isArray(order) || !order.length) {
    throw invalid('invalid_argument', 'order must be a non-empty array');
  }
  const byId = new Map(inputs.map((i) => [i.taskId, i.resultCommit]));
  for (const id of order) {
    if (!byId.has(id)) {
      throw invalid('artifact_key_invalid', `order entry "${id}" has no input`);
    }
    if (!COMMIT_RE.test(byId.get(id))) {
      throw invalid('commit_invalid', `input "${id}" resultCommit must be a 40-hex sha`);
    }
  }
  if (order.length !== new Set(order).size || order.length !== inputs.length) {
    throw invalid('artifact_key_invalid', 'order must list each input exactly once');
  }
  return `ia_${sha256(canonicalJson({ commits: order.map((id) => byId.get(id)), order }))}`;
}

function artifactPath(storeDir, key) {
  if (!/^ia_[0-9a-f]{64}$/.test(key)) {
    throw invalid('artifact_key_invalid', `bad artifact key: ${key}`);
  }
  return path.join(storeDir, `${key}.json`);
}

// Record a caller-supplied resolution. Content proof is per-FILE and
// op-aware (parentDiffs entries carry `files[]` from exportWorkerDiff —
// `changed[]`-only entries are rejected):
//   added/modified → the resolution's bytes-hash MUST equal the parent's
//     `after` hash. A resolution tree holding the UNCHANGED base bytes at
//     that path is REJECTED (it drops the parent's change, and path
//     existence alone would have accepted it).
//   deleted → the path MUST be absent in the resolution (legitimate
//     deletion is accepted, never resolution_incomplete).
//   modechange → bytes MUST equal parent `after` AND the mode must match.
// A path both parents changed to DIFFERENT bytes is a true conflict: the
// caller MUST list it in `resolvedPaths[]` (explicit conflict-resolution
// evidence, required ONLY there — uncontested paths carry exact parent
// bytes and need no declaration). Unchanged-base content anywhere else is
// fine (resolution = base + both sides), but it never counts as a side's
// presence.
export async function recordResolution({
  storeDir, inputs, order, baseTree, repoPath, parentDiffs = [],
  resolvedPaths = [], resolutionNote = null, supersedes = [],
  now = () => new Date().toISOString(),
}) {
  const key = artifactKey(inputs, order);
  if (typeof baseTree !== 'string' || !SHA256_RE.test(baseTree)) {
    throw invalid('invalid_argument', 'baseTree must be a sha256 hex (treeHashFor of the base)');
  }
  const real = await fs.realpath(repoPath).catch(() => {
    throw invalid('invalid_argument', `repoPath does not resolve: ${repoPath}`);
  });
  const run = (args) => new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd: real, shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new RuntimeError('git_unavailable',
      `git binary unavailable: ${e.message}`)));
    child.on('close', (code) => resolvePromise({ code, stdout: out, stderr: err }));
  });
  const headRes = await run(['rev-parse', 'HEAD']);
  if (headRes.code !== 0) {
    throw new RuntimeError('git_failed', `cannot read resolution HEAD: ${headRes.stderr.slice(0, 200)}`);
  }
  const resultCommit = headRes.stdout.trim();
  // Every input must be an ancestor of the resolution — the resolution
  // contains all sides, never silently drops one. Cross-repo SHAs can
  // never be ancestors (each private repo mints its own commits), so the
  // caller supplies the parents' OWN exported diffs (changed paths +
  // patch text) and we verify CONTENT: each side's changed paths must
  // exist in the resolved tree, and where a patch still reverse-applies
  // cleanly its content must be present verbatim.
  const diffByTask = new Map((parentDiffs ?? []).map((d) => [d.taskId, d]));
  // Op-aware proof per parent file. changed[]-only entries are rejected:
  // path existence cannot prove content presence.
  const afterByPath = new Map(); // path -> {taskIds:Set, after:Set<hash|null>}
  for (const i of inputs) {
    const d = diffByTask.get(i.taskId);
    if (!d || !Array.isArray(d.files) || !d.files.length) {
      throw conflict('resolution_incomplete',
        `resolution has no parent file proof for input "${i.taskId}" — supply files[] from exportWorkerDiff`,
        { taskId: i.taskId });
    }
    for (const f of d.files) {
      if (!f || typeof f.path !== 'string') {
        throw invalid('invalid_argument', `parent "${i.taskId}" files[] holds a bad entry`);
      }
      if (f.op === 'added' || f.op === 'modified' || f.op === 'modechange') {
        if (typeof f.after !== 'string' || !SHA256_RE.test(f.after)) {
          throw invalid('invalid_argument',
            `parent "${i.taskId}" file "${f.path}" lacks an after bytes-hash`);
        }
      }
      // deleted parents carry after:null — nothing to hash.
      if (f.op === 'deleted' && f.after !== null) {
        throw invalid('invalid_argument',
          `parent "${i.taskId}" file "${f.path}" deleted must carry after:null`);
      }
      let e = afterByPath.get(f.path);
      if (!e) { e = { taskIds: new Set(), after: new Set(), ops: new Map() }; afterByPath.set(f.path, e); }
      e.taskIds.add(i.taskId);
      e.after.add(f.after);
      e.ops.set(i.taskId, f);
    }
  }
  const resolved = new Set(resolvedPaths ?? []);
  for (const p of resolved) {
    if (typeof p !== 'string' || !p) {
      throw invalid('invalid_argument', 'resolvedPaths must hold non-empty path strings');
    }
  }
  for (const [filePath, e] of afterByPath) {
    const got = await blobAt(real, resultCommit, filePath);
    if (e.after.size > 1) {
      // True conflict: both sides changed the same path differently (or
      // one side deleted what the other changed). Only an explicit
      // resolvedPaths declaration accepts it — and the resolution must
      // differ from EVERY side (a silent pick of one side is rejected).
      if (!resolved.has(filePath)) {
        throw conflict('resolution_incomplete',
          `path "${filePath}" changed differently by ${[...e.taskIds].join(',')} — ` +
          `declare it in resolvedPaths with a hand-merged result`,
          { path: filePath });
      }
      if (got === null) {
        // Deletion chosen as the resolution: allowed only when some parent
        // deleted it (a delete-vs-change conflict resolved by deleting).
        if (!e.after.has(null)) {
          throw conflict('resolution_incomplete',
            `resolved path "${filePath}" deleted but no parent deletes it`,
            { path: filePath });
        }
        continue;
      }
      if (e.after.has(got.hash)) {
        throw conflict('resolution_incomplete',
          `resolved path "${filePath}" copies one side instead of merging`,
          { path: filePath });
      }
      continue;
    }
    const want = [...e.after][0];
    if (want === null) {
      // Uncontested deletion: path must be absent (B2 — legitimate
      // deletion is accepted, never resolution_incomplete).
      if (got !== null) {
        throw conflict('resolution_incomplete',
          `resolution HEAD resurrects deleted path "${filePath}"`,
          { path: filePath });
      }
      continue;
    }
    // Uncontested add/modify/modechange: exact parent bytes required —
    // unchanged-base content (same path, base bytes) is REJECTED.
    if (got === null) {
      throw conflict('resolution_incomplete',
        `resolution HEAD drops files from input "${[...e.taskIds][0]}": ${filePath}`,
        { taskId: [...e.taskIds][0] });
    }
    if (got.hash !== want) {
      throw conflict('resolution_incomplete',
        `resolution path "${filePath}" does not carry input "${[...e.taskIds][0]}" content`,
        { taskId: [...e.taskIds][0], path: filePath });
    }
    const op = [...e.ops.values()][0].op;
    if (op === 'modechange') {
      const wantMode = [...e.ops.values()][0].modeAfter;
      if (got.mode !== wantMode) {
        throw conflict('resolution_incomplete',
          `resolution path "${filePath}" mode ${got.mode} != parent mode ${wantMode}`,
          { path: filePath });
      }
    }
  }
  const resultTree = await treeHashFor(real, resultCommit);
  const resolution = typeof resolutionNote === 'string' ? resolutionNote.slice(0, 2000) : null;
  const supList = [...(supersedes ?? [])];
  for (const k of supList) {
    if (typeof k !== 'string' || !/^ia_[0-9a-f]{64}$/.test(k)) {
      throw invalid('invalid_argument', `supersedes holds a bad artifact key: ${k}`);
    }
  }
  const record = {
    version: ARTIFACT_VERSION,
    kind: 'integration-artifact',
    key,
    inputs: inputs.map((i) => ({ taskId: i.taskId, resultCommit: i.resultCommit })),
    order: [...order],
    baseTree,
    resolution,
    resolvedPaths: [...resolved].sort(),
    supersedes: supList,
    resultCommit,
    resultTree,
    createdAt: now(),
  };
  await ensureDir(storeDir, 0o700);
  const file = artifactPath(normPath(storeDir), key);
  // Fail closed on damage (R3): only ENOENT is absence. A corrupt record
  // must NEVER read as "no artifact yet" and be overwritten — and two
  // racing publishers MUST NOT both succeed. Exclusive O_EXCL create
  // decides the winner: the loser reads the canonical file; identical
  // content = idempotent return, anything else = artifact_mismatch.
  let existingRaw = null;
  try {
    existingRaw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw new RuntimeError('artifact_corrupt',
        `artifact ${key} unreadable: ${e.code ?? e.message}`);
    }
  }
  if (existingRaw !== null) {
    let existing;
    try {
      existing = JSON.parse(existingRaw);
      validateArtifact(existing, key);
    } catch (e) {
      if (e.code === 'artifact_corrupt') throw e;
      throw new RuntimeError('artifact_corrupt', `artifact ${key} unparseable: ${e.message}`);
    }
    if (existing.resultCommit !== resultCommit || existing.resultTree !== resultTree) {
      throw conflict('artifact_mismatch',
        `artifact ${key} already records ${existing.resultCommit} — refusing to overwrite with ${resultCommit}`,
        { key });
    }
    return existing;
  }
  try {
    await exclusiveCreateArtifact(file, canonicalJson(record) + '\n', 0o600);
  } catch (e) {
    if (e.code === 'file_exists') {
      // Lost the race: the winner's record is canonical (read it back
      // through the same validating path — damage fails closed).
      const winner = await loadArtifact(normPath(storeDir), inputs, order);
      if (winner.resultCommit !== resultCommit || winner.resultTree !== resultTree) {
        throw conflict('artifact_mismatch',
          `artifact ${key} already records ${winner.resultCommit} — refusing to overwrite with ${resultCommit}`,
          { key });
      }
      return winner;
    }
    throw e;
  }
  return record;
}

// Exact-key reuse: load the ONE artifact for these inputs+order, or null
// when no resolution was recorded yet. ONLY ENOENT is absence — any other
// read failure, unparseable content, missing key, bad type/hash shape, or
// a recomputed key mismatch throws artifact_corrupt (fail closed, never
// treat damage as "no artifact yet").
export async function loadArtifact(storeDir, inputs, order) {
  const key = artifactKey(inputs, order);
  const file = artifactPath(normPath(storeDir), key);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new RuntimeError('artifact_corrupt',
      `artifact ${key} unreadable: ${e.code ?? e.message}`);
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (e) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} unparseable: ${e.message}`);
  }
  validateArtifact(rec, key);
  return rec;
}

function validateArtifact(rec, key) {
  if (!rec || typeof rec !== 'object') {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} is not an object`);
  }
  for (const k of ARTIFACT_KEYS) {
    if (!(k in rec)) throw new RuntimeError('artifact_corrupt', `artifact ${key} lacks ${k}`);
  }
  if (rec.key !== key) throw new RuntimeError('artifact_corrupt', `artifact key mismatch in ${key}`);
  if (rec.version !== ARTIFACT_VERSION) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} version ${rec.version} unsupported`);
  }
  if (rec.kind !== 'integration-artifact') {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} kind ${rec.kind} unexpected`);
  }
  if (!Array.isArray(rec.inputs) || !rec.inputs.length
    || rec.inputs.some((i) => typeof i?.taskId !== 'string'
      || typeof i?.resultCommit !== 'string' || !COMMIT_RE.test(i.resultCommit))) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} inputs damaged`);
  }
  if (!Array.isArray(rec.order) || rec.order.some((o) => typeof o !== 'string')) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} order damaged`);
  }
  if (typeof rec.baseTree !== 'string' || !SHA256_RE.test(rec.baseTree)
    || typeof rec.resultCommit !== 'string' || !COMMIT_RE.test(rec.resultCommit)
    || typeof rec.resultTree !== 'string' || !SHA256_RE.test(rec.resultTree)
    || typeof rec.createdAt !== 'string'
    || (rec.resolution !== null && typeof rec.resolution !== 'string')
    || !Array.isArray(rec.resolvedPaths) || !Array.isArray(rec.supersedes)) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} value shapes damaged`);
  }
  // The filename key must EXACTLY equal the key recomputed from the
  // record's own inputs+order — a record filed under the wrong key (copy
  // error, manual plant) is damage, not data.
  const recomputed = artifactKey(rec.inputs, rec.order);
  if (recomputed !== key) {
    throw new RuntimeError('artifact_corrupt',
      `artifact ${key} contents recompute to ${recomputed}`);
  }
}

// Overlap compatibility: two artifacts whose input sets overlap MUST agree
// wherever they overlap — same shared input commits AND the same recorded
// resolution (resultTree AND resultCommit). The ONLY bypass is explicit
// proven preservation: the superseding side lists the other's key in its
// `supersedes[]` — a recorded joint resolution, not a silent fork. A
// superset input set with a different baseTree is still a conflicting
// overlap unless that explicit supersedes link exists: conservative reject,
// fresh joint resolution + invalidation of old consumers (scheduler's job).
export function checkCompatible(a, b) {
  const commits = (rec) => new Map(rec.inputs.map((i) => [i.taskId, i.resultCommit]));
  const ca = commits(a);
  const cb = commits(b);
  const shared = [...ca.keys()].filter((k) => cb.has(k));
  const disagreements = shared.filter((k) => ca.get(k) !== cb.get(k));
  if (disagreements.length) {
    throw conflict('incompatible_overlap',
      `artifacts ${a.key} and ${b.key} disagree on shared inputs: ${disagreements.join(', ')}`,
      { keys: [a.key, b.key], disagreements });
  }
  if (shared.length && (a.resultTree !== b.resultTree || a.resultCommit !== b.resultCommit)) {
    const supA = new Set(a.supersedes ?? []);
    const supB = new Set(b.supersedes ?? []);
    if (!(supA.has(b.key) || supB.has(a.key))) {
      throw conflict('incompatible_overlap',
        `artifacts ${a.key} and ${b.key} resolve the same inputs differently`,
        { keys: [a.key, b.key] });
    }
  }
  return { compatible: true, shared };
}
