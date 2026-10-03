// server/execution/workspaces.mjs — managed workspace allocation.
//
// A managed run works in an isolated git worktree created from a CLEAN
// source checkout, under a designated projects workspace root — never under
// the state store. Branches are named acp/<cardId>/<workspaceId>.
//
// Safety contract:
//   * the designated root is realpath-validated; every workspace path must
//     provably resolve INSIDE it (symlink escape impossible);
//   * a dirty source (tracked or untracked changes) refuses creation and is
//     left byte-identical — we never stash/reset/clean foreign edits;
//   * base ref resolves to an existing commit before anything is created;
//   * after `git worktree add` we verify HEAD, branch and git-dir linkage.
//
// All git access goes through spawnBounded — no listeners, no shell.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RuntimeError, spawnBounded, normPath,
} from './common.mjs';

export const WS_ID_RE = /^ws-[A-Za-z0-9._-]{1,60}$/;
export const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/~^@{}-]{0,199}$/;

const GIT_TIMEOUT_MS = 60_000;
const PORCELAIN_CAP = 50; // dirty-path preview limit

export function workspaceRoot(env = process.env) {
  if (env.ACP_WORKSPACE_DIR) return path.resolve(env.ACP_WORKSPACE_DIR);
  const root = env.ROOT_DIR || path.join(os.homedir(), 'projects');
  return path.join(root, '.acp-workspaces');
}

export function workspaceBranch(cardId, wsId) {
  return `acp/${cardId}/${wsId}`;
}

// <root>/<projectKey>/<cardId>--<wsId> — flat, greppable, collision-free.
export function workspacePath(root, projectKey, cardId, wsId) {
  return path.join(root, projectKey, `${cardId}--${wsId}`);
}

export function projectKeyFor(sourcePath) {
  const base = path.basename(normPath(sourcePath));
  const key = base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  return key || 'project';
}

export function assertWsId(wsId) {
  if (typeof wsId !== 'string' || !WS_ID_RE.test(wsId)) {
    throw new RuntimeError('invalid_argument', `bad workspaceId: ${wsId}`);
  }
  return wsId;
}

// Resolve + realpath the designated root. It must exist (caller creates it
// with ensureDir first); anything that resolves outside is rejected.
export async function validateWorkspaceRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw new RuntimeError('invalid_argument',
      `workspace root must be an absolute path: ${root}`);
  }
  const resolved = await fs.realpath(root).catch((e) => {
    throw new RuntimeError('workspace_root_invalid',
      `workspace root does not resolve: ${root} (${e.code || e.message})`);
  });
  return resolved;
}

// Create the designated root if missing, then prove the configured managed
// uid can allocate inside it. When the caller is root (the state service)
// and a managed-runner uid is configured, a root we JUST created is handed
// to that uid — the runner must be able to mkdir worktrees under it. An
// existing root is never widened: it must already grant the owner write
// (uid-owned+w, group+g+w, or o+w); anything else fails closed.
export async function ensureWorkspaceRootAccess(rootDir,
  { ownerUid = null, ownerGid = null } = {}) {
  let st = await fs.lstat(rootDir).catch((e) => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (st === null) {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o755 });
    if (process.getuid?.() === 0 && Number.isInteger(ownerUid)) {
      await fs.chown(rootDir, ownerUid, Number.isInteger(ownerGid) ? ownerGid : ownerUid);
    }
    st = await fs.lstat(rootDir);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new RuntimeError('workspace_root_invalid',
      `workspace root is not a directory: ${rootDir}`);
  }
  if (Number.isInteger(ownerUid) && process.getuid?.() !== ownerUid) {
    const writable =
      (st.uid === ownerUid && (st.mode & 0o200)) ||
      (Number.isInteger(ownerGid) && st.gid === ownerGid && (st.mode & 0o020)) ||
      (st.mode & 0o002);
    if (!writable) {
      throw new RuntimeError('workspace_root_forbidden',
        `workspace root ${rootDir} is not writable by managed uid ${ownerUid}`);
    }
  }
  return st;
}

// A workspace path is accepted only if its lexical path sits inside the
// resolved root AND, once it exists, its realpath stays inside. Both halves
// are required: a symlinked path could pass the lexical check alone.
export function assertInsideRoot(rootResolved, p) {
  const norm = normPath(p);
  if (norm !== rootResolved && !norm.startsWith(rootResolved + '/')) {
    throw new RuntimeError('invalid_argument',
      `path escapes workspace root: ${p}`);
  }
  return norm;
}

async function git(cwd, args, { timeoutMs = GIT_TIMEOUT_MS, safeDirs = [] } = {}) {
  const flags = [];
  for (const d of safeDirs) flags.push('-c', `safe.directory=${d}`);
  const res = await spawnBounded(['git', ...flags, '-C', cwd, ...args],
    { timeoutMs, maxStdout: 1024 * 1024, maxStderr: 256 * 1024 });
  if (res.spawnError) {
    throw new RuntimeError('git_unavailable',
      `git binary unavailable: ${res.spawnError} (state image rebuild required)`);
  }
  return res;
}

// Git under a foreign-owned repo (state service runs as root; registered
// project repos are uid-1001 owned) is refused as "dubious ownership".
// We never touch global/system config and never use `safe.directory=*`:
// the whitelist is passed per-invocation and scoped to VALIDATED realpaths —
// the caller's own realpath first. If git reports a distrusted repo path,
// it is trusted only when it CONTAINS the caller realpath (the enclosing
// repo of a registered path). An unrelated stderr-derived path — including
// a foreign linked-worktree common-dir — is never auto-trusted.
// Exported for the U5 snapshot/validation-copy path — same scoped-ownership
// rules apply when git runs inside a managed worktree or a result copy.
export async function gitRepo(cwd, args, opts = {}) {
  const safeDirs = new Set();
  const rp = await fs.realpath(cwd).catch(() => null);
  if (rp) safeDirs.add(rp);
  let res = await git(cwd, args, { ...opts, safeDirs: [...safeDirs] });
  if (res.code !== 0 && /dubious ownership/.test(res.stderr)) {
    const m = /dubious ownership[^']*'([^']+)'/.exec(res.stderr);
    const named = m ? await fs.realpath(m[1]).catch(() => null) : null;
    if (named && !safeDirs.has(named)
      && (named === rp || (rp && rp.startsWith(named + '/')))) {
      safeDirs.add(named);
      res = await git(cwd, args, { ...opts, safeDirs: [...safeDirs] });
    }
    if (res.code !== 0 && /dubious ownership/.test(res.stderr)) {
      throw new RuntimeError('git_ownership',
        `git refuses ${cwd}: dubious ownership persists for registered realpath `
        + `(${res.stderr.trim().slice(0, 200)})`);
    }
  }
  return res;
}

// Probe: is `p` a usable git work tree for the managed flow? Same scoped
// ownership handling; missing git binary and ownership refusal are
// diagnostics (throw), genuine "not a repository" returns false.
export async function isGitWorkTree(p) {
  const res = await gitRepo(p, ['rev-parse', '--is-inside-work-tree']);
  if (res.code !== 0) return false;
  return res.stdout.trim() === 'true';
}

async function gitStdout(cwd, args, code, what) {
  const res = await gitRepo(cwd, args);
  if (res.code !== 0) {
    throw new RuntimeError(code,
      `${what}: git ${args[0]} exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`);
  }
  return res.stdout.trim();
}

// Resolve a user-supplied base ref to a full commit sha in the source repo.
// The ref must exist and point at a commit; '--' ref forms are rejected by
// the charset above, and `^{commit}` forces a commit (not a tag/blob).
export async function resolveBaseCommit(sourcePath, ref = 'HEAD') {
  if (typeof ref !== 'string' || !ref.length || ref.startsWith('-')
    || !SAFE_REF_RE.test(ref) || ref.includes('..')) {
    throw new RuntimeError('base_ref_invalid',
      `unsafe or malformed base ref: ${ref}`);
  }
  const sha = await gitStdout(sourcePath,
    ['rev-parse', '--verify', `${ref}^{commit}`],
    'base_ref_invalid', `base ref does not resolve to a commit: ${ref}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new RuntimeError('base_ref_invalid',
      `base ref resolved to non-commit sha: ${sha}`);
  }
  return sha;
}

// git rev-parse --show-toplevel of the given path; null if not a repo.
// Ownership/auth failures are diagnostics, not "not a repo".
export async function sourceGitRoot(sourcePath) {
  const res = await gitRepo(sourcePath, ['rev-parse', '--show-toplevel']);
  if (res.code !== 0) return null; // genuine "not a git repository"
  return normPath(await fs.realpath(res.stdout.trim()).catch(() => res.stdout.trim()));
}

// Porcelain dirt = any tracked modification/stage or untracked entry.
// Returns the first N dirty paths, or null when clean.
export async function sourceDirtyPaths(sourcePath) {
  const res = await gitRepo(sourcePath, ['status', '--porcelain', '--untracked-files=all']);
  if (res.code !== 0) {
    throw new RuntimeError('source_not_git',
      `cannot inspect source tree: ${res.stderr.trim().slice(0, 200)}`);
  }
  const lines = res.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  return lines.length ? lines.slice(0, PORCELAIN_CAP) : null;
}

// Create the worktree. Preconditions (root validated, source clean, base
// resolved) are the caller's job; this performs the atomic-ish act and then
// VERIFIES the result: path, branch, HEAD commit, git-dir ownership.
export async function createWorkspace({ sourcePath, targetPath, branch, baseCommit }) {
  if (await exists(targetPath)) {
    throw new RuntimeError('workspace_exists',
      `workspace path already exists: ${targetPath}`);
  }
  const res = await gitRepo(sourcePath,
    ['worktree', 'add', targetPath, '-b', branch, baseCommit]);
  if (res.code !== 0) {
    const err = res.stderr.trim();
    throw new RuntimeError(
      /already exists/.test(err) ? 'workspace_exists' : 'worktree_failed',
      `git worktree add failed (${res.code}): ${err.slice(0, 300)}`);
  }
  return verifyWorkspace({ targetPath, branch, baseCommit });
}

// Resolved realpath of a repo's git common dir (the real object store —
// for linked worktrees this is the SOURCE repo's .git, not the worktree's).
export async function gitCommonDir(repoPath) {
  const rel = await gitStdout(repoPath, ['rev-parse', '--git-common-dir'],
    'worktree_failed', 'git common-dir');
  const resolved = path.resolve(repoPath, rel);
  return normPath(await fs.realpath(resolved).catch(() => resolved));
}

export async function verifyWorkspace({ targetPath, branch, baseCommit, expectCommonDir }) {
  const problems = [];
  const real = await fs.realpath(targetPath).catch(() => null);
  if (!real) problems.push('workspace_path_missing');
  const head = real
    ? await gitStdout(real, ['rev-parse', 'HEAD'], 'worktree_failed', 'verify HEAD')
      .catch(() => null)
    : null;
  if (head !== baseCommit) problems.push(`head_mismatch:${head}`);
  const curBranch = real
    ? await gitStdout(real, ['symbolic-ref', '--short', 'HEAD'],
      'worktree_failed', 'verify branch').catch(() => null)
    : null;
  if (curBranch !== branch) problems.push(`branch_mismatch:${curBranch}`);
  // git-dir linkage: the worktree's toplevel must equal its own path
  const top = real
    ? await gitStdout(real, ['rev-parse', '--show-toplevel'],
      'worktree_failed', 'verify toplevel').catch(() => null)
    : null;
  if (real && top && normPath(top) !== normPath(real)) {
    problems.push(`gitdir_mismatch:${top}`);
  }
  // Source association: a recovered worktree must belong to the source
  // repository it was registered for — a foreign worktree at the right
  // path is not a match.
  if (real && expectCommonDir) {
    const common = await gitCommonDir(real).catch(() => null);
    if (!common || normPath(common) !== normPath(expectCommonDir)) {
      problems.push(`common_dir_mismatch:${common}`);
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    path: real,
    head,
    branch: curBranch,
  };
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}
