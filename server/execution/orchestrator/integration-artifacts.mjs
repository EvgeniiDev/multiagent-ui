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
import { safeGit } from './safe-git.mjs';
import { RuntimeError, normPath, ensureDir } from '../common.mjs';
import { exclusiveCreateArtifact } from './durable-artifact.mjs';
import { invalid, conflict } from './errors.mjs';
import { sha256, canonicalJson, SHA256_RE } from './canonical.mjs';
import { COMMIT_RE, treeHashFor, blobAt, exportWorkerDiff, diffFileEntries } from './workspaces.mjs';

export const ARTIFACT_VERSION = 2;

const ARTIFACT_KEYS = new Set([
  'version', 'kind', 'key', 'inputs', 'order', 'baseTree',
  'baseCommit', 'parentProofs', 'additionalPaths', 'resolution', 'resolvedPaths', 'supersedes', 'resultCommit', 'resultTree', 'createdAt',
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

// Verify complete exported parent ranges against their actual commits. Empty
// ranges are valid. Causal successors must carry earlier bytes/mode in their
// input tree; parallel conflicts require an explicit hand-merged result.
// All base-to-result mutations outside parent paths require additionalPaths.
export async function recordResolution({
  storeDir, inputs, order, baseTree, baseCommit, repoPath, parentDiffs = [],
  additionalPaths = [],
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
  const run = (args) => safeGit(real, args);
  const headRes = await run(['rev-parse', 'HEAD']);
  if (headRes.code !== 0) {
    throw new RuntimeError('git_failed', `cannot read resolution HEAD: ${headRes.stderr.slice(0, 200)}`);
  }
  const resultCommit = headRes.stdout.trim();
  if (!COMMIT_RE.test(baseCommit ?? '') || await treeHashFor(real, baseCommit) !== baseTree) {
    throw invalid('base_proof_invalid', 'baseCommit must resolve to the declared baseTree');
  }
  if ((await run(['merge-base', '--is-ancestor', baseCommit, resultCommit])).code !== 0) {
    throw invalid('base_proof_invalid', 'baseCommit must be an ancestor of the resolution result');
  }
  const byId = new Map(inputs.map(i => [i.taskId, i]));
  const position = new Map(order.map((id, n) => [id, n]));
  const ancestors = new Map();
  for (const id of order) {
    const i = byId.get(id);
    if (!COMMIT_RE.test(i.inputCommit ?? '') || !Array.isArray(i.dependsOn ?? [])) {
      throw invalid('parent_proof_invalid', `input ${id} requires authoritative inputCommit and dependsOn array`);
    }
    const prior = new Set();
    for (const dep of i.dependsOn ?? []) {
      if (!position.has(dep) || position.get(dep) >= position.get(id)) {
        throw invalid('parent_proof_invalid', `dependency ${dep} must precede ${id} in order`);
      }
      prior.add(dep);
      for (const ancestor of ancestors.get(dep)) prior.add(ancestor);
    }
    ancestors.set(id, prior);
  }
  if (!Array.isArray(parentDiffs) || parentDiffs.length !== inputs.length
    || new Set(parentDiffs.map(d => d?.taskId)).size !== inputs.length) {
    throw invalid('parent_proof_invalid', 'supply exactly one complete exported proof per input');
  }
  const proofs = new Map();
  const afterByPath = new Map();
  for (const i of inputs) {
    const d = parentDiffs.find(d => d.taskId === i.taskId);
    if (!d || typeof d.repoPath !== 'string' || d.inputCommit !== i.inputCommit
      || d.resultCommit !== i.resultCommit || !Array.isArray(d.files)) {
      throw invalid('parent_proof_invalid', `parent ${i.taskId} lacks commit-bound exportWorkerDiff proof`);
    }
    const actual = await exportWorkerDiff({repoPath:d.repoPath, inputCommit:i.inputCommit, resultCommit:i.resultCommit});
    if (canonicalJson(actual.files) !== canonicalJson(d.files)
      || (d.patchSha256 !== undefined && d.patchSha256 !== actual.patchSha256)
      || (d.changed !== undefined && canonicalJson(d.changed) !== canonicalJson(actual.changed))) {
      throw invalid('parent_proof_invalid', `parent ${i.taskId} proof differs from actual committed diff`);
    }
    proofs.set(i.taskId, actual);
    for (const f of actual.files) {
      if (!afterByPath.has(f.path)) afterByPath.set(f.path, []);
      afterByPath.get(f.path).push({taskId:i.taskId, file:f});
    }
  }
  const pathList = (items, name) => {
    if (!Array.isArray(items) || items.some(p => typeof p !== 'string' || !p || path.isAbsolute(p)
      || p.split('/').some(s => !s || s === '.' || s === '..') || p.includes('\0'))) {
      throw invalid('invalid_argument', `${name} requires canonical relative paths`);
    }
    return new Set(items);
  };
  const resolved = pathList(resolvedPaths, 'resolvedPaths');
  const additional = pathList(additionalPaths, 'additionalPaths');
  // Entire base-to-result inventory is checked, including untouched paths.
  // Extra assembler edits require an explicit declaration, never silent loss.
  for (const f of await diffFileEntries(real, baseCommit, resultCommit)) {
    if (!afterByPath.has(f.path) && !additional.has(f.path)) {
      throw conflict('resolution_incomplete', `resolution changes undeclared base path ${f.path}`, {path:f.path});
    }
  }
  const same = (got, f) => f.after === null ? got === null
    : got !== null && got.hash === f.after && got.mode === f.modeAfter;
  for (const [filePath, entries] of afterByPath) {
    // Retain full proofs. A causal successor may supersede a prior edit only
    // when its real input tree contains those exact bytes AND executable mode.
    const effective = [];
    for (const entry of entries.sort((a,b) => position.get(a.taskId)-position.get(b.taskId))) {
      for (let n = effective.length - 1; n >= 0; n--) {
        const earlier = effective[n];
        if (ancestors.get(entry.taskId).has(earlier.taskId)) {
          const d = proofs.get(entry.taskId);
          const inputBlob = await blobAt(d.repoPath, d.inputCommit, filePath);
          if (same(inputBlob, earlier.file)) effective.splice(n, 1);
        }
      }
      effective.push(entry);
    }
    const variants = new Map(effective.map(e => [canonicalJson([e.file.after,e.file.modeAfter]), e.file]));
    const got = await blobAt(real, resultCommit, filePath);
    if (variants.size === 1) {
      if (!same(got, [...variants.values()][0])) {
        throw conflict('resolution_incomplete', `resolution drops content or mode at ${filePath}`, {path:filePath});
      }
    } else {
      if (!resolved.has(filePath) || (got === null && !effective.some(e => e.file.after === null))
        || (got !== null && effective.some(e => same(got,e.file)))) {
        throw conflict('resolution_incomplete', `resolution requires explicit merged result at ${filePath}`, {path:filePath});
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
    inputs: inputs.map((i) => ({ taskId: i.taskId, inputCommit: i.inputCommit, resultCommit: i.resultCommit, dependsOn: [...(i.dependsOn ?? [])] })),
    baseCommit,
    parentProofs: order.map(taskId => ({taskId, files: proofs.get(taskId).files, patchSha256: proofs.get(taskId).patchSha256})),
    additionalPaths: [...additional].sort(),
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
    if (existing.resultCommit !== resultCommit || existing.resultTree !== resultTree
      || canonicalJson(existing.inputs) !== canonicalJson(record.inputs) || existing.baseCommit !== baseCommit
      || canonicalJson(existing.additionalPaths) !== canonicalJson(record.additionalPaths)) {
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
      if (winner.resultCommit !== resultCommit || winner.resultTree !== resultTree
        || canonicalJson(winner.inputs) !== canonicalJson(record.inputs) || winner.baseCommit !== baseCommit
        || canonicalJson(winner.additionalPaths) !== canonicalJson(record.additionalPaths)) {
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
  for (const input of inputs) {
    const stored = rec.inputs.find(i => i.taskId === input.taskId);
    if ((input.inputCommit !== undefined && input.inputCommit !== stored.inputCommit)
      || (input.dependsOn !== undefined && canonicalJson(input.dependsOn) !== canonicalJson(stored.dependsOn))) {
      throw conflict('artifact_mismatch', `artifact ${key} input provenance differs for ${input.taskId}`);
    }
  }
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
      || !COMMIT_RE.test(i.inputCommit ?? '') || !Array.isArray(i.dependsOn)
      || typeof i?.resultCommit !== 'string' || !COMMIT_RE.test(i.resultCommit))) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} inputs damaged`);
  }
  if (!Array.isArray(rec.order) || rec.order.some((o) => typeof o !== 'string')) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} order damaged`);
  }
  if (!COMMIT_RE.test(rec.baseCommit ?? '') || !Array.isArray(rec.parentProofs) || !Array.isArray(rec.additionalPaths)
    || typeof rec.baseTree !== 'string' || !SHA256_RE.test(rec.baseTree)
    || typeof rec.resultCommit !== 'string' || !COMMIT_RE.test(rec.resultCommit)
    || typeof rec.resultTree !== 'string' || !SHA256_RE.test(rec.resultTree)
    || typeof rec.createdAt !== 'string'
    || (rec.resolution !== null && typeof rec.resolution !== 'string')
    || !Array.isArray(rec.resolvedPaths) || !Array.isArray(rec.supersedes)) {
    throw new RuntimeError('artifact_corrupt', `artifact ${key} value shapes damaged`);
  }
  const proofIds = new Set();
  for (const proof of rec.parentProofs) {
    if (!proof || !rec.inputs.some(i => i.taskId === proof.taskId) || proofIds.has(proof.taskId)
      || !SHA256_RE.test(proof.patchSha256 ?? '') || !Array.isArray(proof.files)) {
      throw new RuntimeError('artifact_corrupt', `artifact ${key} parent proofs damaged`);
    }
    proofIds.add(proof.taskId);
    const filePaths = new Set();
    for (const f of proof.files) {
      if (!f || typeof f.path !== 'string' || !f.path || filePaths.has(f.path)
        || !['added','modified','deleted','modechange'].includes(f.op)
        || (f.before !== null && !SHA256_RE.test(f.before ?? ''))
        || (f.after !== null && !SHA256_RE.test(f.after ?? ''))
        || !/^(000000|100644|100755|120000|160000)$/.test(f.modeBefore ?? '')
        || !/^(000000|100644|100755|120000|160000)$/.test(f.modeAfter ?? '')) {
        throw new RuntimeError('artifact_corrupt', `artifact ${key} file proof damaged`);
      }
      filePaths.add(f.path);
    }
  }
  if (proofIds.size !== rec.inputs.length) throw new RuntimeError('artifact_corrupt', `artifact ${key} missing parent proof`);
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
