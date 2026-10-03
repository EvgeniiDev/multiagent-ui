// server/execution/orchestrator/workspaces.mjs — O2 private dependency workspaces.
//
// The trusted controller owns every repository a worker touches (KTD2/O2).
// A worker NEVER edits another repo: each worker gets a PRIVATE, autonomous
// Git repository — `git init`, no alternates, no hardlinks, no shared
// git-dir, no worktree linkage back to the source. The controller seeds the
// base tree in and exports result diffs out; the worker's repo is the only
// thing the worker writes.
//
// Seeding uses `git archive <baseCommit> | tar -x` — a byte copy of the
// tree, never a clone/fetch from the source object store, so no foreign
// ref or object can leak in. Isolation is VERIFIED after creation:
//   * `rev-parse --git-common-dir` resolves inside the private repo;
//   * no `objects/info/alternates` file exists;
//   * `for-each-ref` shows only refs the controller created;
//   * `worktree list --porcelain` shows only the repo itself;
//   * a LATER commit in the source repo is unresolvable here (no shared store).
//
// Errors are orchestrator-closed (errors.mjs): 422 invalid_* for malformed
// input, 409 conflict_* for state conflicts. No secrets are ever accepted.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeError, normPath, ensureDir } from '../common.mjs';
import { invalid, conflict } from './errors.mjs';
import { sha256, canonicalJson } from './canonical.mjs';

export const PRIVATE_REPO_VERSION = 1;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const RESULT_HASH_RE = /^[0-9a-f]{64}$/;
export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const GIT_TIMEOUT_MS = 60_000;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'acp-orchestrator',
  GIT_AUTHOR_EMAIL: 'acp-orchestrator@localhost',
  GIT_COMMITTER_NAME: 'acp-orchestrator',
  GIT_COMMITTER_EMAIL: 'acp-orchestrator@localhost',
};

function gitEnv(extra = {}) {
  return { ...process.env, ...GIT_IDENTITY, ...extra };
}

// Minimal argv runner — never through a shell. Rejects on spawn failure;
// resolves {code, stdout, stderr} otherwise; callers map nonzero exits.
function runGit(cwd, args, { env = gitEnv(), input = undefined } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env, shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new RuntimeError('git_unavailable',
      `git binary unavailable: ${e.message}`)));
    child.on('close', (code) => resolvePromise({ code, stdout: out, stderr: err }));
    try {
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    } catch { /* child already gone; close reports */ }
  });
}

async function mustClean(cwd, args, what) {
  const res = await runGit(cwd, args);
  if (res.code !== 0) {
    throw new RuntimeError('git_failed',
      `${what}: git ${args[0]} exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`);
  }
  return res.stdout.trim();
}

function assertRepoName(name) {
  if (typeof name !== 'string' || !REPO_NAME_RE.test(name)) {
    throw invalid('repo_name_invalid', `repo name must match ${REPO_NAME_RE}`);
  }
  return name;
}

function assertCommitSha(sha, what = 'commit') {
  if (typeof sha !== 'string' || !COMMIT_RE.test(sha)) {
    throw invalid('commit_invalid', `${what} must be a 40-hex commit sha`);
  }
  return sha;
}

// A private repo path is a fresh non-existent path under an absolute base
// dir the controller owns. Nothing is created here — creation is atomic in
// createPrivateRepo.
export function privateRepoPath(baseDir, name) {
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) {
    throw invalid('invalid_argument', 'baseDir must be an absolute path');
  }
  assertRepoName(name);
  return path.join(normPath(baseDir), name);
}

// Create the private repo and seed it with the EXACT tree of baseCommit
// from the source repo — via `git archive`, never clone/fetch. Returns
// {repoPath, inputCommit} where inputCommit is the private repo's own
// `base <source-sha>` commit. The source HEAD may advance afterwards; the
// private repo never sees it.
export async function createPrivateRepo({ sourcePath, baseCommit, name, baseDir }) {
  assertCommitSha(baseCommit, 'baseCommit');
  const repoPath = privateRepoPath(
    baseDir ?? path.join(os.tmpdir(), 'acp-orch-workspaces'), name);
  if (await fs.lstat(repoPath).catch(() => null)) {
    throw conflict('repo_exists', `private repo path already exists: ${repoPath}`);
  }
  await ensureDir(path.dirname(repoPath), 0o700);

  // The source commit must exist BEFORE anything is created.
  const tree = await mustClean(sourcePath, ['rev-parse', `${baseCommit}^{tree}`], 'resolve baseCommit')
    .catch((e) => {
      throw invalid('base_unknown', `source repo has no commit ${baseCommit}: ${e.message}`);
    });

  await fs.mkdir(repoPath, { mode: 0o700 });
  try {
    await mustClean(repoPath, ['init', '-q'], 'git init');
    // Stream the source tree in: archive stdout → tar extract. No refs,
    // no objects, no alternates travel with a tarball.
    await new Promise((resolvePromise, reject) => {
      const archive = spawn('git', ['archive', baseCommit], { cwd: sourcePath, shell: false });
      const untar = spawn('tar', ['-x', '-C', repoPath], { shell: false });
      archive.on('error', (e) => reject(new RuntimeError('git_unavailable',
        `git archive unavailable: ${e.message}`)));
      untar.on('error', (e) => reject(new RuntimeError('copy_failed',
        `tar extract unavailable: ${e.message}`)));
      archive.stdout.on('data', (d) => { untar.stdin.write(d); });
      archive.on('close', (code) => {
        untar.stdin.end();
        if (code !== 0) reject(new RuntimeError('git_failed', `git archive exited ${code}`));
      });
      untar.on('close', (code) => {
        if (code !== 0) reject(new RuntimeError('copy_failed', `tar extract exited ${code}`));
        else resolvePromise();
      });
    });
    await mustClean(repoPath, ['add', '-A'], 'stage base tree');
    const gotTree = await mustClean(repoPath, ['write-tree'], 'write base tree');
    if (gotTree !== tree) {
      throw new RuntimeError('seed_mismatch',
        `seeded tree ${gotTree} != source tree ${tree} — abort, repo is unusable`);
    }
    await runGit(repoPath, [
      'commit', '-q', '--allow-empty', '-m', `base ${baseCommit}`,
    ]);
    const inputCommit = await mustClean(repoPath, ['rev-parse', 'HEAD'], 'read inputCommit');
    assertCommitSha(inputCommit, 'inputCommit');
    const check = await verifyPrivateRepo(repoPath);
    if (!check.ok) {
      throw new RuntimeError('repo_isolation',
        `fresh private repo fails isolation: ${check.problems.join('; ')}`);
    }
    return { repoPath, inputCommit };
  } catch (e) {
    await fs.rm(repoPath, { recursive: true, force: true });
    throw e;
  }
}

// Verify a private repo is STILL autonomous: common-dir inside itself, no
// alternates, no foreign refs, no linked worktrees. Returns
// {ok, problems, head}.
export async function verifyPrivateRepo(repoPath) {
  const problems = [];
  const real = await fs.realpath(repoPath).catch(() => null);
  if (!real) return { ok: false, problems: ['repo_path_missing'], head: null };
  let head = null;
  try {
    head = await mustClean(real, ['rev-parse', 'HEAD'], 'read HEAD');
  } catch {
    problems.push('head_unresolvable');
  }
  try {
    const common = await mustClean(real, ['rev-parse', '--git-common-dir'], 'common dir');
    const resolved = normPath(path.resolve(real, common));
    if (resolved !== normPath(path.join(real, '.git'))) {
      problems.push(`common_dir_foreign:${resolved}`);
    }
  } catch {
    problems.push('common_dir_unresolvable');
  }
  const alternates = path.join(real, '.git', 'objects', 'info', 'alternates');
  if (await fs.lstat(alternates).catch(() => null)) {
    problems.push('alternates_present');
  }
  try {
    const refs = await mustClean(real, ['for-each-ref', '--format=%(refname)'], 'list refs');
    for (const r of refs.split('\n').filter(Boolean)) {
      if (!r.startsWith('refs/heads/')) problems.push(`foreign_ref:${r}`);
    }
  } catch {
    problems.push('refs_unlistable');
  }
  try {
    const wt = await mustClean(real, ['worktree', 'list', '--porcelain'], 'worktree list');
    const paths = wt.split('\n').filter((l) => l.startsWith('worktree '));
    if (paths.length !== 1 || normPath(paths[0].slice(9)) !== normPath(real)) {
      problems.push('worktree_linked');
    }
  } catch {
    problems.push('worktree_unlistable');
  }
  return { ok: problems.length === 0, problems, head };
}

// Prove a sha is FOREIGN to this repo (unresolvable here) — the negative
// isolation check: a commit made in the source AFTER seeding must not exist
// in the private object store.
export async function assertForeignUnresolvable(repoPath, sha) {
  assertCommitSha(sha, 'sha');
  const res = await runGit(repoPath, ['cat-file', '-e', `${sha}^{commit}`]);
  if (res.code === 0) {
    throw new RuntimeError('repo_isolation',
      `foreign commit ${sha} resolves inside the private repo — stores are shared`);
  }
  return true;
}

// Export the worker's OWN diff: inputCommit..resultCommit (default HEAD) as
// changed paths + diffstat + unified patch. Ancestor diffs are the caller's
// problem — snapshots.mjs guarantees each result carries only its own diff
// because each snapshot repo is seeded from assembled parents.
export async function exportWorkerDiff({ repoPath, inputCommit, resultCommit = null }) {
  assertCommitSha(inputCommit, 'inputCommit');
  const real = await fs.realpath(repoPath).catch(() => {
    throw invalid('invalid_argument', `repoPath does not resolve: ${repoPath}`);
  });
  const head = resultCommit ?? await mustClean(real, ['rev-parse', 'HEAD'], 'read HEAD');
  assertCommitSha(head, 'resultCommit');
  const baseCheck = await runGit(real, ['merge-base', '--is-ancestor', inputCommit, head]);
  if (baseCheck.code !== 0) {
    throw conflict('diff_not_ancestor',
      `inputCommit ${inputCommit} is not an ancestor of ${head} — own-diff undefined`);
  }
  const names = await mustClean(real,
    ['diff', '--name-only', '-z', `${inputCommit}..${head}`], 'list changed');
  const changed = names.split('\0').filter(Boolean).sort();
  const stat = await mustClean(real,
    ['diff', '--stat', `${inputCommit}..${head}`], 'diffstat');
  const patchRes = await runGit(real,
    ['diff', '--full-index', `${inputCommit}..${head}`]);
  if (patchRes.code !== 0) {
    throw new RuntimeError('git_failed', `diff patch failed: ${patchRes.stderr.slice(0, 200)}`);
  }
  const patchSha256 = sha256(patchRes.stdout);
  return {
    version: PRIVATE_REPO_VERSION,
    repoPath: real,
    inputCommit,
    resultCommit: head,
    changed,
    diffStat: stat,
    formatPatch: patchRes.stdout,
    patchSha256,
  };
}

// Content hash of a commit's tree — the stale-acceptance binding: two
// freezes of identical content share resultHash even though commit shas
// (timestamps) differ.
export async function treeHashFor(repoPath, commitSha) {
  assertCommitSha(commitSha, 'commitSha');
  const tree = await mustClean(repoPath, ['rev-parse', `${commitSha}^{tree}`], 'resolve tree');
  return sha256(canonicalJson({ tree }));
}
