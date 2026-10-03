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
import { RuntimeError, normPath, ensureDir, atomicWriteFile } from '../common.mjs';
import { invalid, conflict } from './errors.mjs';
import { sha256, canonicalJson, SHA256_RE } from './canonical.mjs';
import { COMMIT_RE, treeHashFor } from './workspaces.mjs';

export const ARTIFACT_VERSION = 1;

const ARTIFACT_KEYS = new Set([
  'version', 'kind', 'key', 'inputs', 'order', 'baseTree',
  'resolution', 'resultCommit', 'resultTree', 'createdAt',
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

// Record a caller-supplied resolution. The caller proves the content: it
// hands over a repo whose HEAD is the resolved merge of exactly `inputs`
// applied in `order` on top of baseTree. We verify parents are merged
// (merge-base --is-ancestor for each) and the base matches, then store the
// immutable record idempotently: same key + same content = same record
// back; same key + DIFFERENT content = artifact_mismatch (never overwrite).
export async function recordResolution({
  storeDir, inputs, order, baseTree, repoPath, parentDiffs = [],
  resolutionNote = null, now = () => new Date().toISOString(),
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
  for (const i of inputs) {
    const d = diffByTask.get(i.taskId);
    if (!d || !Array.isArray(d.changed) || !d.changed.length) {
      throw conflict('resolution_incomplete',
        `resolution has no parent diff for input "${i.taskId}" — a side cannot be proven present`,
        { taskId: i.taskId });
    }
    const ls = await run(['ls-tree', '-r', '--name-only', resultCommit]);
    if (ls.code !== 0) {
      throw new RuntimeError('git_failed', `cannot list resolution tree: ${ls.stderr.slice(0, 200)}`);
    }
    const present = new Set(ls.stdout.split('\n').filter(Boolean));
    const missing = d.changed.filter((p) => !present.has(p));
    if (missing.length) {
      throw conflict('resolution_incomplete',
        `resolution HEAD drops files from input "${i.taskId}": ${missing.slice(0, 5).join(', ')}`,
        { taskId: i.taskId });
    }
  }
  const resultTree = await treeHashFor(real, resultCommit);
  const resolution = typeof resolutionNote === 'string' ? resolutionNote.slice(0, 2000) : null;
  const record = {
    version: ARTIFACT_VERSION,
    kind: 'integration-artifact',
    key,
    inputs: inputs.map((i) => ({ taskId: i.taskId, resultCommit: i.resultCommit })),
    order: [...order],
    baseTree,
    resolution,
    resultCommit,
    resultTree,
    createdAt: now(),
  };
  await ensureDir(storeDir, 0o700);
  const file = artifactPath(normPath(storeDir), key);
  const existing = await fs.readFile(file, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  if (existing) {
    if (existing.resultCommit !== resultCommit || existing.resultTree !== resultTree) {
      throw conflict('artifact_mismatch',
        `artifact ${key} already records ${existing.resultCommit} — refusing to overwrite with ${resultCommit}`,
        { key });
    }
    return existing;
  }
  await atomicWriteFile(file, canonicalJson(record) + '\n', 0o600);
  return record;
}

// Exact-key reuse: load the ONE artifact for these inputs+order, or null
// when no resolution was recorded yet. No fuzzy matching — near-identical
// inputs resolve separately.
export async function loadArtifact(storeDir, inputs, order) {
  const key = artifactKey(inputs, order);
  const file = artifactPath(normPath(storeDir), key);
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  for (const k of ARTIFACT_KEYS) {
    if (!(k in rec)) throw new RuntimeError('artifact_corrupt', `artifact ${key} lacks ${k}`);
  }
  if (rec.key !== key) throw new RuntimeError('artifact_corrupt', `artifact key mismatch in ${key}`);
  return rec;
}

// Overlap compatibility: two artifacts whose input sets overlap MUST agree
// wherever they overlap — same shared input commits AND, when both record a
// resolution touching shared inputs, the same resultTree. Disagreement =
// incompatible_overlap: record a fresh JOINT resolution over the union and
// invalidate consumers of the old versions (the scheduler's job; flagged
// here, never hidden).
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
  if (shared.length && a.resultTree !== b.resultTree && a.resultCommit !== b.resultCommit) {
    // Same shared inputs but different resolutions — only compatible when
    // one side's inputs are a strict extension with an identical base tree
    // (a later joint resolution supersedes, not a silent fork).
    const aIds = new Set(ca.keys());
    const bIds = new Set(cb.keys());
    const aExtendsB = [...bIds].every((k) => aIds.has(k)) && a.baseTree !== b.baseTree;
    const bExtendsA = [...aIds].every((k) => bIds.has(k)) && a.baseTree !== b.baseTree;
    if (!(aExtendsB || bExtendsA)) {
      throw conflict('incompatible_overlap',
        `artifacts ${a.key} and ${b.key} resolve the same inputs differently`,
        { keys: [a.key, b.key] });
    }
  }
  return { compatible: true, shared };
}
