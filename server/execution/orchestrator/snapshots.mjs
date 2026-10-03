// server/execution/orchestrator/snapshots.mjs — O2 dependency snapshots +
// immutable result freeze (KTD2/KTD4).
//
// A dependent worker starts on a snapshot assembled from the UNIQUE
// transitive predecessor set: stable topological order, diamond ancestors
// included exactly once. Assembly applies each parent's OWN exported diff
// (workspaces.exportWorkerDiff — patch text, never object access) onto a
// fresh private repo, one commit per parent. A patch that does not apply
// is a `snapshot_conflict`: the dependent does NOT launch, nothing is left
// behind, and the integrator later records the resolution as an
// IntegrationArtifact (integration-artifacts.mjs).
//
// freezeResult turns a worker's live repo — including dirty tracked edits,
// new untracked files, deletions, and mode changes — into an immutable
// {resultCommit, resultHash, report}. resultHash binds content (tree), the
// result commit, the input commit, and the provenance record; generation
// helpers reject stale acceptances.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeGit } from './safe-git.mjs';
import { RuntimeError, normPath } from '../common.mjs';
import { invalid, conflict } from './errors.mjs';
import { sha256, canonicalJson } from './canonical.mjs';
import { topoOrder } from './subtask.mjs';
import {
  createPrivateRepo, verifyPrivateRepo, treeHashFor, COMMIT_RE, diffFileEntries,
} from './workspaces.mjs';

export const SNAPSHOT_VERSION = 1;

const byId = (tasks) => new Map(tasks.map((t) => [t.id, t]));

// Stable topological UNIQUE transitive predecessors of taskId: the full
// closure (diamond ancestors once) ordered by the declaration-tied topo
// order — the same graph always yields the same build order.
export function transitivePredecessors(tasks, taskId) {
  if (!Array.isArray(tasks) || !tasks.length) {
    throw invalid('invalid_argument', 'tasks must be a non-empty array');
  }
  const map = byId(tasks);
  if (!map.has(taskId)) {
    throw invalid('task_unknown', `unknown subtask "${taskId}"`, { taskId });
  }
  const closure = new Set();
  const stack = [...(map.get(taskId).dependsOn ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (closure.has(id)) continue;
    const t = map.get(id);
    if (!t) {
      throw invalid('dependency_unknown', `"${taskId}" transitively depends on unknown "${id}"`);
    }
    closure.add(id);
    for (const d of t.dependsOn ?? []) stack.push(d);
  }
  return topoOrder(tasks).filter((id) => closure.has(id));
}

function gitArgs(cwd, args) { return safeGit(cwd, args); }

async function mustGit(cwd, args, what) {
  const res = await gitArgs(cwd, args);
  if (res.code !== 0) {
    throw new RuntimeError('git_failed',
      `${what}: git ${args[0]} exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`);
  }
  return res.stdout.trim();
}

// Assemble the dependent's private repo: fresh private repo seeded from
// baseCommit, then each parent's own-diff patch applied in stable topo
// order (one commit per parent). Returns {repoPath, inputCommit,
// parents, provenance}. A patch that fails `--check` throws
// snapshot_conflict BEFORE any worker launches; the half-built repo is
// removed so a retry starts clean.
export async function assembleDependencySnapshot({
  sourcePath, baseCommit, taskId, tasks, parentDiffs, name, baseDir,
}) {
  if (typeof sourcePath !== 'string' || !sourcePath) {
    throw invalid('invalid_argument', 'sourcePath must be a non-empty path');
  }
  if (typeof baseCommit !== 'string' || !COMMIT_RE.test(baseCommit)) {
    throw invalid('commit_invalid', 'baseCommit must be a 40-hex commit sha');
  }
  const order = transitivePredecessors(tasks, taskId);
  const diffByTask = new Map((parentDiffs ?? []).map((d) => [d.taskId, d]));
  for (const id of order) {
    if (!diffByTask.has(id)) {
      throw conflict('snapshot_parent_missing',
        `no accepted diff for predecessor "${id}" of "${taskId}"`, { taskId, dependency: id });
    }
  }
  const { repoPath } = await createPrivateRepo({ sourcePath, baseCommit, name, baseDir });
  try {
    const parents = [];
    for (const id of order) {
      const diff = diffByTask.get(id);
      if (typeof diff.formatPatch !== 'string') {
        throw invalid('invalid_argument', `parent "${id}" carries no formatPatch`);
      }
      if (!diff.formatPatch.length) {
        // Empty own diff = accepted no-op: the parent changed nothing, so
        // there is nothing to apply — still one allow-empty parent commit
        // + provenance entry, keeping order and parents[] exact.
        await mustGit(repoPath,
          ['-c', 'user.name=acp-orchestrator', '-c', 'user.email=acp-orchestrator@localhost',
            'commit', '-q', '--allow-empty', '-m', `parent ${id} ${diff.resultCommit ?? ''} no-op`.trim()],
          `commit parent ${id}`);
        parents.push({
          taskId: id,
          resultCommit: diff.resultCommit ?? null,
          patchSha256: diff.patchSha256 ?? sha256(''),
        });
        continue;
      }
      // `git apply --check` first: a patch that does not apply is a
      // snapshot_conflict thrown BEFORE any worker launches.
      const checked = await safeGit(repoPath, ['apply', '--check', '-'], { input: diff.formatPatch });
      const applied = { code: checked.code, err: checked.stderr };
      if (applied.code !== 0) {
        throw conflict('snapshot_conflict',
          `predecessor "${id}" does not apply onto the assembled base of "${taskId}": ${
            applied.err.trim().slice(0, 300)}`,
          { taskId, dependency: id });
      }
      const appliedResult = await safeGit(repoPath, ['apply', '-'], { input: diff.formatPatch });
      if (appliedResult.code !== 0) throw new RuntimeError('git_failed', `git apply exited ${appliedResult.code}`);
      await mustGit(repoPath, ['add', '-A'], `stage parent ${id}`);
      await mustGit(repoPath,
        ['-c', 'user.name=acp-orchestrator', '-c', 'user.email=acp-orchestrator@localhost',
          'commit', '-q', '--allow-empty', '-m', `parent ${id} ${diff.resultCommit ?? ''}`.trim()],
        `commit parent ${id}`);
      parents.push({
        taskId: id,
        resultCommit: diff.resultCommit ?? null,
        patchSha256: diff.patchSha256 ?? sha256(diff.formatPatch),
      });
    }
    const inputCommit = await mustGit(repoPath, ['rev-parse', 'HEAD'], 'read inputCommit');
    const treeHash = await treeHashFor(repoPath, inputCommit);
    const provenance = {
      version: SNAPSHOT_VERSION,
      kind: 'dependency-snapshot',
      taskId,
      baseCommit,
      order,
      parents,
      treeHash,
    };
    const check = await verifyPrivateRepo(repoPath);
    if (!check.ok) {
      throw new RuntimeError('repo_isolation',
        `assembled snapshot fails isolation: ${check.problems.join('; ')}`);
    }
    return { repoPath: normPath(repoPath), inputCommit, parents, provenance };
  } catch (e) {
    await fs.rm(repoPath, { recursive: true, force: true });
    throw e;
  }
}

// Freeze a worker's live repo into an immutable accepted result. `git add
// -A` captures exactly the full actual state: dirty tracked modifications,
// new untracked files (non-ignored), deletions, and mode changes. When the
// tree is already clean at HEAD no new commit is minted — resultCommit is
// HEAD. Returns {resultCommit, resultHash, report}; the report is the
// acceptance binding (KTD4: generation + exact dependency snapshot).
export async function freezeResult({
  repoPath, taskId, inputCommit, generation, parentCommits = {}, note = null,
}) {
  if (typeof taskId !== 'string' || !taskId) {
    throw invalid('invalid_argument', 'taskId must be a non-empty string');
  }
  if (typeof inputCommit !== 'string' || !COMMIT_RE.test(inputCommit)) {
    throw invalid('commit_invalid', 'inputCommit must be a 40-hex commit sha');
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw invalid('invalid_argument', 'generation must be a positive integer');
  }
  const real = await fs.realpath(repoPath).catch(() => {
    throw invalid('invalid_argument', `repoPath does not resolve: ${repoPath}`);
  });
  // Validate the input SHA BEFORE touching the repo: it must resolve and
  // be an ancestor of (or equal to) HEAD. A nonexistent inputCommit with
  // an empty diff previously froze successfully — fail closed instead, and
  // leave the repo untouched (no staging happened yet).
  const resolves = await gitArgs(real, ['cat-file', '-e', `${inputCommit}^{commit}`]);
  if (resolves.code !== 0) {
    throw invalid('commit_invalid', `inputCommit ${inputCommit} does not resolve in this repo`);
  }
  const headPre = await mustGit(real, ['rev-parse', 'HEAD'], 'read HEAD');
  const ancestor = await gitArgs(real, ['merge-base', '--is-ancestor', inputCommit, headPre]);
  if (ancestor.code !== 0) {
    throw conflict('diff_not_ancestor',
      `inputCommit ${inputCommit} is not an ancestor of ${headPre} — freeze undefined`);
  }
  const status = await mustGit(real, ['status', '--porcelain', '--untracked-files=all'], 'read status');
  const dirtyPaths = status.split('\n').filter(Boolean);
  await mustGit(real, ['add', '-A'], 'stage result');
  const staged = await gitArgs(real, ['diff', '--cached', '--quiet']);
  let resultCommit;
  if (staged.code === 0) {
    resultCommit = await mustGit(real, ['rev-parse', 'HEAD'], 'read HEAD');
  } else {
    await mustGit(real,
      ['-c', 'user.name=acp-orchestrator', '-c', 'user.email=acp-orchestrator@localhost',
        'commit', '-q', '-m', `result ${taskId} gen ${generation}`],
      'commit result');
    resultCommit = await mustGit(real, ['rev-parse', 'HEAD'], 'read resultCommit');
  }
  const treeHash = await treeHashFor(real, resultCommit);
  const changedRes = await gitArgs(real, ['diff', '--name-only', '-z', `${inputCommit}..${resultCommit}`]);
  const changed = changedRes.code === 0 ? changedRes.stdout.split('\0').filter(Boolean).sort() : [];
  // Op-aware detail per changed path (modes/deletions/binary visible) —
  // the report consumer sees WHAT changed, not just which names.
  const entries = await diffFileEntries(real, inputCommit, resultCommit);
  const fileDetails = entries.map((e) => ({
    path: e.path, op: e.op, modeBefore: e.modeBefore, modeAfter: e.modeAfter, binary: e.binary,
  }));
  const report = {
    version: SNAPSHOT_VERSION,
    kind: 'worker-result',
    taskId,
    inputCommit,
    resultCommit,
    generation,
    parentCommits: { ...parentCommits },
    dirtyPaths,
    changed,
    fileDetails,
    treeHash,
    note: typeof note === 'string' ? note.slice(0, 500) : null,
  };
  // Acceptance binding over STABLE fields only: dirtyPaths is transient
  // `git status` output (ordering/wording varies run to run) and note is
  // free text — hashing them made identical re-freezes hash differently.
  // fileDetails (op/mode/binary, no hashes of content — treeHash binds
  // content) + changed + treeHash carry the acceptance signal.
  const stable = {
    version: report.version,
    kind: report.kind,
    taskId: report.taskId,
    inputCommit: report.inputCommit,
    resultCommit: report.resultCommit,
    generation: report.generation,
    parentCommits: report.parentCommits,
    changed: report.changed,
    fileDetails: report.fileDetails,
    treeHash: report.treeHash,
  };
  const resultHash = sha256(canonicalJson(stable));
  return { resultCommit, resultHash, report: { ...report, resultHash } };
}

// Versioned provenance: every accepted result records the generation of
// its inputs. A verdict/acceptance naming an older generation — or older
// parent commits — is stale and must never open dependents (KTD4).
export function provenanceFor({ taskId, generation, parentCommits = {} }) {
  return { version: SNAPSHOT_VERSION, taskId, generation, parentCommits: { ...parentCommits } };
}

export function assertProvenanceCurrent(record, { generation, parentCommits = {} }) {
  if (!record || typeof record !== 'object') {
    throw invalid('provenance_invalid', 'provenance record must be an object');
  }
  if (record.generation !== generation) {
    throw conflict('stale_generation',
      `"${record.taskId ?? '?'}": record generation ${record.generation} != current ${generation}`,
      { taskId: record.taskId ?? null });
  }
  // Full-set equality: a parent REMOVED since the record (present in the
  // record, missing now) or ADDED since (present now, missing in the
  // record) both invalidate — the dependency set the verdict was computed
  // against no longer exists.
  const recorded = record.parentCommits ?? {};
  for (const task of Object.keys(recorded)) {
    if (!(task in parentCommits)) {
      throw conflict('stale_input',
        `"${record.taskId ?? '?'}": parent "${task}" removed since this record`,
        { taskId: record.taskId ?? null, parent: task });
    }
  }
  for (const [task, commit] of Object.entries(parentCommits)) {
    if (!(task in recorded)) {
      throw conflict('stale_input',
        `"${record.taskId ?? '?'}": parent "${task}" added since this record`,
        { taskId: record.taskId ?? null, parent: task });
    }
    if (recorded[task] !== commit) {
      throw conflict('stale_input',
        `"${record.taskId ?? '?'}": parent "${task}" moved since this record`,
        { taskId: record.taskId ?? null, parent: task });
    }
  }
  return true;
}
