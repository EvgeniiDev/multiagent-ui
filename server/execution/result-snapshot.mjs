// server/execution/result-snapshot.mjs — U5 immutable result snapshots,
// isolated validation copies, and owned process-group check execution.
//
// Contract (docs/plans/agent-core-implementation-plan.md U5):
//
//   * SNAPSHOT. computeResultManifest(ws, baseCommit) enumerates the exact
//     worktree result: every tracked path at its WORKTREE bytes (dirty
//     included), every non-ignored untracked path (new files), every
//     tracked path missing from the worktree (deleted), symlinks by target
//     text (never followed). Binary content is hashed verbatim.
//     `resultSha256` is sha256 over the canonical manifest — the
//     acceptance binding, including the captured HEAD commit so a
//     post-review commit invalidates acceptance.
//
//   * NOTHING SILENTLY OMITTED. Unsupported entries — gitlinks/submodules,
//     unmerged index stages, fifos/sockets, symlinks whose target is
//     absolute or escapes the workspace, paths under a symlinked ancestor —
//     are recorded in manifest.unsupported and FAIL THE CAPTURE CLOSED:
//     such a result is never materialized "empty but verified".
//     Credential-pattern untracked files are recorded with their content
//     hash in manifest.excluded and are never materialized into copies
//     (tracked matches copy verbatim — their bytes already live in git
//     history; exclusion there would only falsify the result). Paths git
//     ignores are outside the result set entirely — documented, not hidden.
//
//   * COHERENCE. materializeResultCopy re-hashes every source entry at
//     copy time and then re-enumerates the SOURCE manifest afterwards —
//     drift of content, mode, membership, or HEAD between capture and
//     copy is a hard failure; a mixed-generation result is never marked
//     verified.
//
//   * ISOLATED COPIES. Independent pristine copies live under
//     <wsRoot>/.validation/<runId>/<validationId>/ — base + verify +
//     review + check are separate materializations (a reviewer's edit can
//     never contaminate the checker's input). Each gets its own `git init`
//     + single commit — a self-contained repo, never linked to the source.
//     Copies are NOT a security sandbox (same UID, shared fs); strict
//     fs/net isolation is a later group-mode obligation.
//
//   * CHECK EXECUTION. runCheckCommand runs one approved check entry
//     verbatim as `bash -c <run>` — the approved shell language is a
//     single argv element, never concatenated. The child is detached →
//     its own process group, and its stdout/stderr go DIRECTLY to open
//     log-file descriptors — complete durable output by construction, no
//     pipe buffering, no descendant-held-pipe drain problem; `close`
//     follows `exit` promptly. Report tails are read back from the durable
//     files — a capped tail is never the sole record.
//
//   * CANCELLATION. All signals route through killOwnedGroup, which
//     requires the FULL recorded leader identity {pid,pgid,starttime,
//     pidNs,uid,envInstance} AND the caller's own {pidNs,uid,envInstance}
//     to be complete and matching BEFORE any probe — a missing binding
//     (either side) means refusal with zero probes:
//       - leader live + identity match → kill(-pgid) is safe (the live
//         leader pins the pgid — it cannot name a foreign group);
//       - leader dead + proven-empty group (reliable scan AND
//         kill(-pgid,0) ESRCH) → dead;
//       - leader dead + surviving members → members are signalled
//         individually ONLY when their {pid,starttime} was captured while
//         the leader was provably alive, re-verified {pgrp,uid,pidNs,
//         starttime} immediately before the signal; anything else is
//         retained as `orphans` — reported, never signalled, never
//         declared dead. A scan that cannot be read is not emptiness.
//     A leader 'exit' alone never settles the check: the group is waited
//     out, proven survivors get TERM→KILL, unproven survivors keep the
//     reservation and mark the check 'unproven' — never 'pass'. A check
//     that cannot prove its process state cannot be a success.
//
//     Member identities are PROCESS-LOCAL by design: they are provable only
//     while captured under a provably-live leader, and a restart loses the
//     capture — a crash leaves survivors unproven forever, so the
//     validation reservation stays open and blocks. There is no automatic
//     second check launch on an unproven validation.
//
//   * DURABLE LOGS REQUIRED. logOutFile/logErrFile are mandatory — the
//     managed caller must always produce durable full output; a check run
//     without durable logs is refused up front rather than reported on a
//     capped tail alone.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  promises as fs, readFileSync, statSync, readlinkSync, readdirSync,
  openSync, closeSync, fsyncSync,
} from 'node:fs';
import path from 'node:path';
import {
  RuntimeError, normPath, ensureDir,
} from './common.mjs';
import { gitRepo } from './workspaces.mjs';

export const MANIFEST_SCHEMA = 1;
export const RESULT_HASH_RE = /^[0-9a-f]{64}$/;
export const VALIDATION_ID_RE = /^val_[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60_000;
const CHECK_TIMEOUT_MAX_MS = 24 * 3600_000;
const CHECK_KILL_GRACE_MS = 2_000;
const GROUP_SETTLE_MS = 4_000;
const CANCEL_POLL_MS = 150;
// Bounded report tails — read back from the durable per-check log files.
export const CHECK_TAIL_MAX = 32 * 1024;
const SYMLINK_TARGET_MAX = 4096;
const MANIFEST_PATH_MAX = 4096;
const MAX_FILE_BYTES = 512 * 1024 * 1024; // sanity cap on a single hashed file

// Untracked credential-material basenames/dirs are hash-recorded but never
// materialized into validation copies. Diagnostics list excluded paths so a
// check needing one is explainable — never silent.
const CREDENTIAL_BASENAME_RE = /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.git-credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(?:pem|key|p12|pfx|jks|keystore)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|env))$/i;
const SECRET_DIR_RE = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)$/i;

export function isCredentialPath(rel) {
  const parts = String(rel).split('/');
  if (parts.some((p) => SECRET_DIR_RE.test(p))) return true;
  return CREDENTIAL_BASENAME_RE.test(parts[parts.length - 1]);
}

// --- canonical validation layout ------------------------------------------------
// The domain validates these paths EXACTLY — a runner cannot point a
// validation at an arbitrary directory.
export function validationDirs(wsRoot, runId, validationId) {
  const root = path.join(wsRoot, '.validation', runId, validationId);
  return {
    root,
    base: path.join(root, 'base'),
    verify: path.join(root, 'verify'),
    review: path.join(root, 'review'),
    check: path.join(root, 'check'),
    logs: path.join(root, 'logs'),
  };
}

export function assertValidationDirs(dirs, wsRoot, runId, validationId) {
  const expected = validationDirs(normPath(wsRoot), runId, validationId);
  for (const k of ['root', 'base', 'verify', 'review', 'check', 'logs']) {
    if (normPath(dirs?.[k]) !== normPath(expected[k])) {
      throw new RuntimeError('invalid_argument',
        `validation dir ${k} must be ${expected[k]} — got ${dirs?.[k]}`);
    }
  }
  return dirs;
}

// --- process identity (local /proc reads — no runtime dependency) -----------------

export function procStarttimeLocal(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    return stat.slice(close + 2).split(' ')[19] || null;
  } catch {
    return null;
  }
}

export function procNsOfLocal(ns, pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/${ns}`);
  } catch {
    return null;
  }
}

// Identity probe of a possibly-foreign process — same semantics as the
// runtime's processIdentity: exists=false is clean-ENOENT proof of absence;
// exists=null is UNVERIFIABLE and never counts as absent; state 'Z' counts
// as terminated.
export function procIdentityLocal(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let exists;
  try {
    statSync(`/proc/${pid}`);
    exists = true;
  } catch (e) {
    exists = e && e.code === 'ENOENT' ? false : null;
  }
  let state = null;
  let starttime = null;
  let uid = null;
  let pgrp = null;
  let readable = false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close >= 0) {
      const f = stat.slice(close + 2).split(' ');
      state = f[0] || null;
      pgrp = Number(f[2]) || null;  // field 5 overall
      starttime = f[19] || null;    // field 22 overall
      readable = true;
    }
  } catch (e) {
    if (e && e.code === 'ENOENT' && exists !== true) exists = false;
  }
  try {
    uid = statSync(`/proc/${pid}`).uid;
  } catch { /* unreadable stays null */ }
  return {
    pid, exists, state, starttime, uid, pgrp,
    pidNs: procNsOfLocal('pid', pid),
    readable,
    alive: exists === true && state !== 'Z',
  };
}

// Members of a process group. Returns null when /proc is UNREADABLE — a
// failed scan is never proof of emptiness.
export function procGroupMembers(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  let names;
  try {
    names = readdirSync('/proc');
  } catch { return null; }
  const out = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const id = procIdentityLocal(pid);
    if (id && id.alive === true && id.pgrp === pgid) out.push(id);
  }
  return out;
}

function envInstanceStrict(a, b) {
  return !!(a && b
    && typeof a.containerId === 'string' && a.containerId.length > 0
    && typeof a.initStarttime === 'string' && a.initStarttime.length > 0
    && a.containerId === b.containerId && a.initStarttime === b.initStarttime);
}

// The recorded leader binding must be COMPLETE — every field present; a
// partial record is not a proof.
function leaderBindingComplete(leader) {
  return !!leader
    && Number.isInteger(leader.pid) && leader.pid > 0
    && Number.isInteger(leader.pgid) && leader.pgid > 0
    && typeof leader.starttime === 'string' && leader.starttime.length > 0
    && typeof leader.pidNs === 'string' && leader.pidNs.length > 0
    && Number.isInteger(leader.uid)
    && !!leader.envInstance
    && typeof leader.envInstance.containerId === 'string' && leader.envInstance.containerId.length > 0
    && typeof leader.envInstance.initStarttime === 'string' && leader.envInstance.initStarttime.length > 0;
}

// The caller's own environment must also be complete — we never probe a
// record we cannot prove belongs to OUR environment.
function callerEnvComplete(ourEnv) {
  return !!ourEnv
    && typeof ourEnv.pidNs === 'string' && ourEnv.pidNs.length > 0
    && Number.isInteger(ourEnv.uid)
    && !!ourEnv.envInstance
    && typeof ourEnv.envInstance.containerId === 'string' && ourEnv.envInstance.containerId.length > 0
    && typeof ourEnv.envInstance.initStarttime === 'string' && ourEnv.envInstance.initStarttime.length > 0;
}

// Full original binding re-proof — used for every scan, every signal.
function leaderProvenLive(leader) {
  const now = procIdentityLocal(leader.pid);
  return !!now && now.alive === true && now.readable === true
    && now.starttime === leader.starttime
    && now.pidNs === leader.pidNs
    && now.uid === leader.uid
    && now.pgrp === leader.pgid;
}

// Re-verify one group member against the recorded leader binding — member
// must still carry the same starttime, our pgid, our uid, our namespace.
function memberMatchesLeader(member, leader) {
  return !!member && member.alive === true && member.readable === true
    && member.pgrp === leader.pgid
    && member.uid === leader.uid
    && member.pidNs === leader.pidNs
    && typeof member.starttime === 'string' && member.starttime.length > 0;
}

// An orphan record carries the FULL scanned identity — a bare pid is
// never enough for a reader to re-prove or safely clean up later.
function memberIdentity(m) {
  return {
    pid: m.pid, starttime: m.starttime ?? null, pidNs: m.pidNs ?? null,
    uid: m.uid ?? null, pgrp: m.pgrp ?? null,
  };
}

// THE ONLY signal path for check processes. Semantics:
//   * both bindings incomplete → refuse, ZERO probes;
//   * leader live+fully re-proven → kill(-pgid): the live leader pins the
//     pgid, so the group signal reaches exactly our group;
//   * leader gone → never signal the pgid itself (it may be recycled);
//     a reliable empty scan AND kill(-pgid,0) ESRCH = positive death;
//     surviving members are signalled individually ONLY if their
//     {pid,starttime} was captured while the leader was provably alive AND
//     they re-verify {pgrp,uid,pidNs,starttime} right now; the rest stay
//     live in `orphans` — reported, retained, never signalled.
export function killOwnedGroup(leader, {
  signal = 'SIGTERM',
  ourEnv = {},
  knownMembers = null,
  // Injected seams for proof tests — default to the real /proc+kill path;
  // a test can spy on probe/signal to assert ZERO calls on refusal.
  probe = procIdentityLocal,
  signalFn = (pid, sig) => process.kill(pid, sig),
  scan = procGroupMembers,
} = {}) {
  const out = {
    signalled: false, groupDead: false, orphans: [], refused: false, reason: null,
  };
  if (!leaderBindingComplete(leader)) {
    out.refused = true;
    out.reason = 'leader_binding_incomplete';
    return out;
  }
  if (!callerEnvComplete(ourEnv)) {
    out.refused = true;
    out.reason = 'caller_binding_incomplete';
    return out;
  }
  if (!envInstanceStrict(ourEnv.envInstance, leader.envInstance)) {
    out.refused = true;
    out.reason = 'foreign_environment';
    return out;
  }
  if (leader.pidNs !== ourEnv.pidNs) {
    out.refused = true;
    out.reason = 'foreign_namespace';
    return out;
  }
  if (leader.uid !== ourEnv.uid) {
    out.refused = true;
    out.reason = 'foreign_uid';
    return out;
  }

  const liveNow = (l) => {
    const now = probe(l.pid);
    return !!now && now.alive === true && now.readable === true
      && now.starttime === l.starttime
      && now.pidNs === l.pidNs
      && now.uid === l.uid
      && now.pgrp === l.pgid;
  };
  const memberOk = (m) => memberMatchesLeader(m, leader);

  if (liveNow(leader)) {
    try {
      signalFn(-leader.pgid, signal);
      out.signalled = true;
    } catch (e) {
      if (e && e.code === 'ESRCH') out.groupDead = true;
      else { out.refused = true; out.reason = `kill:${e.code || e.message}`; }
    }
    return out;
  }

  const nowLeader = probe(leader.pid);
  if (nowLeader && nowLeader.alive === true) {
    // Live pid at the recorded slot with a DIFFERENT identity = recycled —
    // refuse, zero signals.
    out.refused = true;
    out.reason = 'leader_pid_recycled';
    return out;
  }

  // Leader dead/zombie/unverifiable. Scan for members: null = unreadable
  // scan = NOT emptiness.
  const members = scan(leader.pgid);
  if (members === null) {
    out.refused = true;
    out.reason = 'scan_unverifiable';
    return out;
  }
  if (!members.length) {
    // Reliable empty scan + ESRCH cross-check = positive group death.
    try {
      signalFn(-leader.pgid, 0);
      out.orphans.push({ unknown: true, pgid: leader.pgid });
    } catch (e) {
      if (e && e.code === 'ESRCH') out.groupDead = true;
      else out.orphans.push({ unknown: true, pgid: leader.pgid });
    }
    return out;
  }
  for (const m of members) {
    const provable = typeof knownMembers?.get(m.pid) === 'string'
      && knownMembers.get(m.pid) === m.starttime
      && memberOk(m);
    if (!provable) { out.orphans.push(memberIdentity(m)); continue; }
    // Re-verify identity immediately before the signal — the pid could
    // have turned over since the scan.
    const re = probe(m.pid);
    if (!memberOk(re) || re.starttime !== m.starttime) {
      out.orphans.push(memberIdentity(m));
      continue;
    }
    try {
      signalFn(m.pid, signal);
      out.signalled = true;
    } catch (e) {
      if (!(e && e.code === 'ESRCH')) out.orphans.push(memberIdentity(m));
    }
  }
  return out;
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function gitLs(wsPath, args) {
  const res = await gitRepo(wsPath, args, { timeoutMs: GIT_TIMEOUT_MS });
  if (res.code !== 0) {
    throw new RuntimeError('snapshot_failed',
      `git ls-files failed (${res.code}): ${res.stderr.trim().slice(0, 300)}`);
  }
  return res.stdout;
}

// `git ls-files -sz` rows: "<mode> <sha> <stage>\t<path>" (NUL-terminated).
function parseLsFilesSZ(raw) {
  const rows = [];
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const head = rec.slice(0, tab).split(' ');
    rows.push({ mode: head[0], sha: head[1], stage: head[2], path: rec.slice(tab + 1) });
  }
  return rows;
}

function hasGitComponent(rel) {
  return String(rel).split('/').includes('.git');
}

// A manifest path is a safe relative path — no NUL, no absolute, no '..' or
// '.git' components, bounded length.
function assertManifestPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > MANIFEST_PATH_MAX
    || rel.includes('\0') || path.isAbsolute(rel)
    || rel.split('/').some((c) => c === '..' || c === '' || c === '.')
    || hasGitComponent(rel)) {
    throw new RuntimeError('invalid_argument',
      `unsafe manifest path: ${JSON.stringify(rel)}`);
  }
  return rel;
}

// Every ancestor of `rel` under `root` must be a real directory — a
// symlinked ancestor would let a fixed-looking relative path resolve
// outside the tree at hash/copy time.
async function assertNoSymlinkAncestors(root, rel) {
  const parts = rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = path.join(cur, parts[i]);
    const st = await fs.lstat(cur).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      throw new RuntimeError('snapshot_failed',
        `ancestor ${parts.slice(0, i + 1).join('/')} of ${rel} is not a plain directory`);
    }
  }
}

// Classify a symlink target against a root. Only relative links resolving
// inside the tree may be materialized; absolute links (even ones pointing
// back INTO the canonical workspace — a copy must never link back) and
// escaping links fail the capture closed.
function classifyLink(rootPath, rel, target) {
  if (target.length > SYMLINK_TARGET_MAX) {
    return { ok: false, reason: 'link_target_too_long' };
  }
  if (path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) {
    return { ok: false, reason: 'link_absolute' };
  }
  const resolved = normPath(path.resolve(rootPath, path.dirname(rel), target));
  const root = normPath(rootPath);
  if (resolved !== root && !resolved.startsWith(root + '/')) {
    return { ok: false, reason: 'link_escape' };
  }
  return { ok: true };
}

async function statEntry(wsPath, rel, { tracked }) {
  const abs = path.join(wsPath, rel);
  const st = await fs.lstat(abs).catch((e) => {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  });
  if (!st) return { path: rel, missing: true };
  // Ancestor check AFTER the existence probe (a gone path is 'deleted',
  // not unsafe) — an ancestor that is a symlink or not a real directory
  // records UNSUPPORTED so the capture fails closed with the path in the
  // diagnostic, never aborts silently.
  try {
    await assertNoSymlinkAncestors(wsPath, rel);
  } catch (e) {
    return {
      path: rel, unsupported: true, reason: 'ancestor_unsafe',
      detail: e.message,
    };
  }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs);
    const cls = classifyLink(wsPath, rel, target);
    if (!cls.ok) {
      return {
        path: rel, unsupported: true, reason: cls.reason,
        detail: `symlink target ${JSON.stringify(target.slice(0, 200))}`,
        linkSha256: sha256Buf(Buffer.from(target, 'utf8')),
      };
    }
    return {
      path: rel, kind: 'link', target,
      linkSha256: sha256Buf(Buffer.from(target, 'utf8')),
      size: Buffer.byteLength(target, 'utf8'),
    };
  }
  if (st.isFile()) {
    if (st.size > MAX_FILE_BYTES) {
      return {
        path: rel, unsupported: true, reason: 'file_too_large',
        detail: `${st.size} bytes exceeds the ${MAX_FILE_BYTES}-byte snapshot bound`,
      };
    }
    const buf = await fs.readFile(abs);
    if (!tracked && isCredentialPath(rel)) {
      return {
        path: rel, excluded: true, reason: 'credential',
        sha256: sha256Buf(buf), size: buf.length,
      };
    }
    return {
      path: rel, kind: 'file', sha256: sha256Buf(buf),
      size: buf.length, mode: st.mode & 0o777,
    };
  }
  return {
    path: rel, unsupported: true, reason: 'special_file',
    detail: `mode ${(st.mode & 0o170000).toString(8)}`,
  };
}

// Enumerate + hash the complete worktree result. Returns {manifest,
// resultSha256, ok}; ok=false (unsupported entries present) means the caller
// must fail the validation closed — a partial result is never verified.
export async function computeResultManifest(wsPath, { baseCommit }) {
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(baseCommit)) {
    throw new RuntimeError('invalid_argument', `baseCommit must be a full sha: ${baseCommit}`);
  }
  const ws = await fs.realpath(wsPath).catch((e) => {
    throw new RuntimeError('snapshot_failed',
      `workspace path does not resolve: ${wsPath} (${e.code || e.message})`);
  });
  const headRes = await gitRepo(ws, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  if (headRes.code !== 0 || !/^[0-9a-f]{40}$/.test(headRes.stdout.trim())) {
    throw new RuntimeError('snapshot_failed',
      `cannot resolve HEAD in ${ws}: ${headRes.stderr.trim().slice(0, 200)}`);
  }
  const headCommit = headRes.stdout.trim();

  const [lsIdx, lsOthers, lsDeleted] = await Promise.all([
    gitLs(ws, ['ls-files', '-s', '-z']),
    gitLs(ws, ['ls-files', '--others', '--exclude-standard', '-z']),
    gitLs(ws, ['ls-files', '--deleted', '-z']),
  ]);
  const indexRows = parseLsFilesSZ(lsIdx);
  const deletedSet = new Set(
    lsDeleted.split('\0').filter((p) => p && !hasGitComponent(p)));
  const others = lsOthers.split('\0').filter((p) => p && !hasGitComponent(p));

  const entries = [];
  const excluded = [];
  const unsupported = [];
  const deleted = new Set([...deletedSet]);

  for (const row of indexRows) {
    const rel = row.path;
    if (hasGitComponent(rel)) continue;
    if (deletedSet.has(rel)) continue;
    if (row.stage !== '0') {
      // Unresolved merge index — the worktree result is ambiguous.
      unsupported.push({
        path: rel, reason: 'index_unmerged',
        detail: `index stage ${row.stage} — merge conflict unresolved`,
      });
      continue;
    }
    if (row.mode === '160000') {
      unsupported.push({
        path: rel, reason: 'gitlink', detail: `submodule at index sha ${row.sha}`,
        gitSha: row.sha,
      });
      continue;
    }
    const e = await statEntry(ws, rel, { tracked: true });
    if (e.missing) { deleted.add(rel); continue; }
    if (e.unsupported) { unsupported.push(e); continue; }
    if (e.excluded) { excluded.push(e); continue; }
    entries.push(e);
  }
  for (const rel of others) {
    const e = await statEntry(ws, rel, { tracked: false });
    if (e.missing) continue;
    if (e.unsupported) { unsupported.push(e); continue; }
    if (e.excluded) { excluded.push(e); continue; }
    entries.push(e);
  }

  const deletedList = [...deleted].sort();
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  excluded.sort((a, b) => (a.path < b.path ? -1 : 1));
  unsupported.sort((a, b) => (a.path < b.path ? -1 : 1));

  const manifest = {
    schema: MANIFEST_SCHEMA,
    baseCommit,
    headCommit,
    entries: entries.map((e) => (e.kind === 'link'
      ? { path: e.path, kind: 'link', target: e.target, sha256: e.linkSha256, size: e.size }
      : { path: e.path, kind: 'file', sha256: e.sha256, size: e.size, mode: e.mode })),
    deleted: deletedList,
    excluded: excluded.map((e) => ({
      path: e.path, reason: e.reason, sha256: e.sha256, size: e.size,
    })),
    unsupported: unsupported.map((e) => ({
      path: e.path, reason: e.reason, detail: e.detail ?? null,
      ...(e.gitSha ? { gitSha: e.gitSha } : {}),
      ...(e.linkSha256 ? { sha256: e.linkSha256 } : {}),
    })),
    counts: {
      files: entries.filter((e) => e.kind === 'file').length,
      links: entries.filter((e) => e.kind === 'link').length,
      deleted: deletedList.length,
      excluded: excluded.length,
      unsupported: unsupported.length,
    },
  };
  const resultSha256 = sha256Buf(Buffer.from(canonicalManifest(manifest), 'utf8'));
  return { manifest, resultSha256, ok: unsupported.length === 0 };
}

// The hash covers exactly the content-binding fields — counts are derived.
export function canonicalManifest(manifest) {
  return JSON.stringify({
    schema: manifest.schema,
    baseCommit: manifest.baseCommit,
    headCommit: manifest.headCommit,
    entries: manifest.entries,
    deleted: manifest.deleted,
    excluded: manifest.excluded,
    unsupported: manifest.unsupported,
  });
}

// Validate a caller-supplied manifest for materialization — a malformed or
// capture-failed manifest is refused here too, never trusted because the
// caller said so.
function assertMaterializable(manifest) {
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA
    || !Array.isArray(manifest.entries) || !Array.isArray(manifest.deleted)
    || !Array.isArray(manifest.excluded) || !Array.isArray(manifest.unsupported)) {
    throw new RuntimeError('invalid_argument', 'manifest shape invalid');
  }
  if (manifest.unsupported.length) {
    throw new RuntimeError('result_unsupported',
      `manifest has unsupported entries — refuse to materialize: ${
        manifest.unsupported.slice(0, 3).map((u) => `${u.path}:${u.reason}`).join('; ')}`);
  }
  const seen = new Set();
  for (const e of manifest.entries) {
    assertManifestPath(e.path);
    if (seen.has(e.path)) {
      throw new RuntimeError('invalid_argument', `duplicate manifest path ${e.path}`);
    }
    seen.add(e.path);
    if (e.kind === 'file') {
      if (!RESULT_HASH_RE.test(e.sha256 || '') || !Number.isInteger(e.size)) {
        throw new RuntimeError('invalid_argument', `file entry ${e.path} lacks sha256/size`);
      }
    } else if (e.kind === 'link') {
      if (typeof e.target !== 'string' || !e.target.length
        || e.target.length > SYMLINK_TARGET_MAX) {
        throw new RuntimeError('invalid_argument', `link entry ${e.path} lacks a valid target`);
      }
      // Re-derive safety against a canonical root — never trust the caller:
      // absolute targets and targets resolving outside the tree are refused.
      const resolved = normPath(path.resolve('/copyroot', path.dirname(e.path), e.target));
      if (path.isAbsolute(e.target) || /^[a-zA-Z]:[\\/]/.test(e.target)
        || (resolved !== '/copyroot' && !resolved.startsWith('/copyroot/'))) {
        throw new RuntimeError('invalid_argument',
          `link entry ${e.path} target is not internal-relative: ${JSON.stringify(e.target)}`);
      }
    } else {
      throw new RuntimeError('invalid_argument', `unknown entry kind ${e.kind}`);
    }
  }
}

// Create destDir as a FRESH real directory inside the given root — symlink
// destinations, symlinked ancestors, non-empty or non-dir destinations are
// refused; the resolved path must stay inside the resolved root. The
// containment proof happens BEFORE any mutation: the closest existing
// ancestor chain is realpath'd and must resolve inside the root, so a
// pre-planted symlinked ancestor can never make mkdir write outside the
// tree. On any refusal nothing outside wsRoot was created.
async function freshCopyDir(destDir, rootResolved) {
  const dest = path.resolve(destDir);
  const root = await fs.realpath(rootResolved);
  // Validate the nearest existing ancestor BEFORE creating anything: every
  // existing ancestor must be a real directory, and its realpath must stay
  // inside the root — never create through a chain we haven't proven.
  let probe = dest;
  const missing = [];
  for (;;) {
    const st = await fs.lstat(probe).catch((e) => {
      if (e && e.code === 'ENOENT') return null;
      throw new RuntimeError('copy_failed',
        `cannot inspect copy path ${probe}: ${e.code || e.message}`);
    });
    if (st) break;
    missing.push(probe);
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new RuntimeError('copy_failed', `copy path ${dest} has no existing ancestor`);
    }
    probe = parent;
  }
  const ancReal = await fs.realpath(probe);
  if (ancReal !== root && !ancReal.startsWith(root + path.sep)) {
    throw new RuntimeError('copy_failed',
      `copy destination escapes the workspace root via ancestor ${probe} -> ${ancReal}`);
  }
  const st = await fs.lstat(probe);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new RuntimeError('copy_failed', `copy ancestor is not a real directory: ${probe}`);
  }
  if (probe === dest) {
    // The destination itself already exists — must be a real empty dir.
    const inside = await fs.readdir(dest);
    if (inside.length) {
      throw new RuntimeError('copy_failed', `copy destination is not empty: ${dest}`);
    }
  } else {
    await fs.mkdir(dest, { recursive: true, mode: 0o755 });
    const real = await fs.realpath(dest);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new RuntimeError('copy_failed',
        `copy destination escapes the workspace root: ${dest}`);
    }
    return real;
  }
  return fs.realpath(dest);
}

// Materialize the manifest's exact result into a fresh destDir. Every
// source entry is re-hashed at copy time; afterwards the SOURCE manifest is
// recomputed and must produce an identical result hash — a result that
// drifted in any way (content, mode, membership, HEAD) between capture and
// copy is never marked verified.
export async function materializeResultCopy(manifest, sourceDir, destDir,
  { initGit = true, wsRoot = null } = {}) {
  assertMaterializable(manifest);
  const src = await fs.realpath(sourceDir);
  const dest = await freshCopyDir(destDir, wsRoot || src);
  let copied = 0;
  let linked = 0;
  for (const e of manifest.entries) {
    const rel = e.path;
    await assertNoSymlinkAncestors(src, rel);
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    if (e.kind === 'file') {
      const buf = await fs.readFile(from).catch((err) => {
        throw new RuntimeError('result_drift',
          `cannot read ${rel}: ${err.code || err.message}`);
      });
      if (sha256Buf(buf) !== e.sha256) {
        throw new RuntimeError('result_drift',
          `${rel} changed since snapshot — the result moved under validation`);
      }
      await ensureDir(path.dirname(to), 0o755);
      await fs.writeFile(to, buf);
      if (Number.isInteger(e.mode)) {
        await fs.chmod(to, e.mode).catch((err) => {
          throw new RuntimeError('copy_failed',
            `cannot set mode ${e.mode.toString(8)} on ${rel}: ${err.code || err.message}`);
        });
      }
      copied += 1;
    } else if (e.kind === 'link') {
      const cur = await fs.readlink(from).catch(() => null);
      if (cur !== e.target) {
        throw new RuntimeError('result_drift',
          `symlink ${rel} changed since snapshot`);
      }
      await ensureDir(path.dirname(to), 0o755);
      await fs.symlink(e.target, to);
      linked += 1;
    }
  }
  // Coherence: recompute the source manifest — identical result hash or fail.
  const after = await computeResultManifest(src, { baseCommit: manifest.baseCommit });
  if (after.resultSha256 !== sha256Buf(Buffer.from(canonicalManifest(manifest), 'utf8'))) {
    throw new RuntimeError('result_drift',
      'source result changed during copy — the captured generation is gone');
  }
  if (initGit) {
    const gi = await gitRepo(dest, ['init', '-q']);
    if (gi.code !== 0) {
      throw new RuntimeError('copy_failed', `git init in copy failed: ${gi.stderr.slice(0, 200)}`);
    }
    const add = await gitRepo(dest, ['add', '-A']);
    if (add.code !== 0) {
      throw new RuntimeError('copy_failed', `git add in copy failed: ${add.stderr.slice(0, 200)}`);
    }
    const commit = await gitRepo(dest, [
      '-c', 'user.name=acp-validation', '-c', 'user.email=acp-validation@localhost',
      'commit', '-q', '--allow-empty', '-m', `result snapshot ${manifest.headCommit}`,
    ]);
    if (commit.code !== 0) {
      throw new RuntimeError('copy_failed', `git commit in copy failed: ${commit.stderr.slice(0, 200)}`);
    }
  }
  const verify = await verifyResultCopy(manifest, dest);
  if (!verify.ok) {
    throw new RuntimeError('copy_failed',
      `materialized copy fails manifest verification: ${verify.problems.slice(0, 5).join('; ')}`);
  }
  return { ok: true, copied, linked, destDir: dest };
}

// Re-enumerate a materialized copy and compare it to the manifest exactly —
// content hash, link target AND file mode; extra/missing/mutated entries
// are mismatches.
// `exempt` lists relative path prefixes that may exist in the copy without
// being part of the result manifest — used by the U5 dep supply, which
// links a controller-owned dep set (e.g. node_modules) into the copy AFTER
// receipt. Exempt paths are only excused as EXTRAS: a manifest entry that
// collides with the exempt prefix still verifies normally.
export async function verifyResultCopy(manifest, destDir, { exempt = [] } = {}) {
  const problems = [];
  const copyEntries = new Map();
  const walk = async (dir, relBase) => {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      problems.push(`cannot read copy dir ${relBase || '.'}: ${e.code || e.message}`);
      return;
    }
    for (const it of items) {
      const rel = relBase ? `${relBase}/${it.name}` : it.name;
      if (rel === '.git' || rel.startsWith('.git/')) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(p, rel);
      } else if (it.isSymbolicLink()) {
        const target = await fs.readlink(p);
        copyEntries.set(rel, { kind: 'link', target, sha256: sha256Buf(Buffer.from(target, 'utf8')) });
      } else if (it.isFile()) {
        const buf = await fs.readFile(p);
        const st = await fs.lstat(p);
        copyEntries.set(rel, {
          kind: 'file', sha256: sha256Buf(buf), size: buf.length, mode: st.mode & 0o777,
        });
      } else {
        problems.push(`special file materialized in copy: ${rel}`);
      }
    }
  };
  await walk(destDir, '');
  for (const e of manifest.entries) {
    const got = copyEntries.get(e.path);
    if (!got) { problems.push(`missing in copy: ${e.path}`); continue; }
    if (got.kind !== e.kind || got.sha256 !== e.sha256
      || (e.kind === 'link' && got.target !== e.target)
      || (e.kind === 'file' && Number.isInteger(e.mode) && got.mode !== e.mode)) {
      problems.push(`content mismatch in copy: ${e.path}`);
    }
  }
  for (const rel of copyEntries.keys()) {
    if (exempt.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
    if (!manifest.entries.some((e) => e.path === rel)) {
      problems.push(`extra file in copy: ${rel}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// Acceptance path: re-hash the live workspace and compare to the recorded
// result hash — a post-review edit, file addition, or commit moves it.
export async function resultHashFor(wsPath, baseCommit) {
  const { manifest, resultSha256 } = await computeResultManifest(wsPath, { baseCommit });
  return { manifest, resultSha256 };
}

// --- bounded approved-check execution ---------------------------------------------

async function readTail(file, max) {
  try {
    const st = await fs.stat(file);
    const size = st.size;
    const fh = await fs.open(file, 'r');
    try {
      const len = Math.min(size, max);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, Math.max(0, size - len));
      return { tail: buf.toString('utf8'), bytes: size, truncated: size > max };
    } finally {
      await fh.close();
    }
  } catch {
    return { tail: '', bytes: 0, truncated: false };
  }
}

// Run ONE approved check {run, cwd?, timeoutSec?, setup?} verbatim:
// `bash -c <run>` — one argv element, never concatenated. Detached → own
// process group. stdout/stderr are inherited DIRECTLY by open log-file
// descriptors — complete durable output, no pipe lifetime issues.
//
// Lifecycle guarantees:
//   * listeners install BEFORE the onProc await — a fast exit/error during
//     persistence is never missed;
//   * onProc is awaited; its failure kills the group and reports 'error'
//     (an unpersisted process is unprovable — work never proceeds on it);
//   * while the leader is provably live we sample group members — only
//     these captured identities may be signalled after leader death;
//   * leader 'exit' never settles the check: the group is waited out to
//     emptiness; proven survivors get TERM→KILL through killOwnedGroup;
//     unproven survivors stay live and are reported — status 'unproven',
//     reservation retained, never pass;
//   * timeout/cancel drive ONE bounded TERM→grace→KILL escalation; a
//     process that still refuses to die resolves 'unproven', not a hang.
export async function runCheckCommand(check, {
  verifyDir,
  env = undefined,
  logOutFile = null,
  logErrFile = null,
  onProc = null,          // async (leaderRecord) — must durably persist
  isCancelled = null,
  ourEnv = {},
  killGraceMs = CHECK_KILL_GRACE_MS,
  cancelPollMs = CANCEL_POLL_MS,
  groupSettleMs = GROUP_SETTLE_MS,
  killSettleMs = GROUP_SETTLE_MS,
  now = Date.now,
  // Proof-test seams — same class as killOwnedGroup's probe/signalFn/scan.
  // `memberScan` replaces ONLY the live-capture scan (birth + poll);
  // settlement always re-scans with the real /proc reader, so a seam that
  // hides members produces an UNCAPTURED survivor — never a lost one.
  // `signalFn` receives every signal/probe so a test can spy on what was
  // (and was not) signalled.
  memberScan = procGroupMembers,
  signalFn = (pid, sig) => process.kill(pid, sig),
} = {}) {
  const index = check.index;
  const startedAt = now();
  const report = {
    index, run: check.run, cwd: check.cwd ?? null, setup: check.setup === true,
    status: 'error', exitCode: null, signal: null,
    timedOut: false, cancelled: false, unproven: false,
    durationMs: 0,
    stdoutTail: '', stderrTail: '',
    stdoutTruncated: false, stderrTruncated: false,
    stdoutBytes: 0, stderrBytes: 0,
    // Positive group-death proof — set ONLY by an ESRCH on the recorded
    // pgid (or a spawn that never produced a child). Never inferred from
    // leader exit alone.
    groupDead: null,
    // Spawn attestation — durable proof of whether exec was ever invoked:
    //   spawnInvoked=false → the executor provably never called spawn
    //     (precondition/log-open refusal) — never_spawned attestable;
    //   spawnInvoked=true + childSpawned=false + spawnError → the OS
    //     provably refused the spawn — never_spawned attestable;
    //   childSpawned=true, or invoked with no error yet no proc record →
    //     UNKNOWN — nothing may be attested.
    spawnInvoked: false,
    childSpawned: false,
    spawnError: null,
    logOut: logOutFile ? path.basename(logOutFile) : null,
    logErr: logErrFile ? path.basename(logErrFile) : null,
    error: null,
    killResult: null,
    groupSurvived: null,
    proc: null,
  };

  if (typeof logOutFile !== 'string' || !path.isAbsolute(logOutFile)
    || typeof logErrFile !== 'string' || !path.isAbsolute(logErrFile)) {
    report.error = 'durable check logs required — runCheckCommand refuses to run without logOutFile+logErrFile';
    report.durationMs = now() - startedAt;
    return report;
  }
  const copyRoot = await fs.realpath(verifyDir).catch(() => null);
  if (!copyRoot) {
    report.error = `validation copy does not resolve: ${verifyDir}`;
    report.durationMs = now() - startedAt;
    return report;
  }
  const cwdAbs = path.resolve(copyRoot, check.cwd || '.');
  const cwdReal = await fs.realpath(cwdAbs).catch(() => null);
  if (!cwdReal || (cwdReal !== copyRoot && !cwdReal.startsWith(copyRoot + path.sep))) {
    report.error = `check cwd escapes the validation copy: ${check.cwd ?? '.'}`;
    report.durationMs = now() - startedAt;
    return report;
  }

  const timeoutMs = Math.min(
    Math.max(1, Number(check.timeoutSec ?? (DEFAULT_CHECK_TIMEOUT_MS / 1000)) * 1000),
    CHECK_TIMEOUT_MAX_MS);

  // Durable output files opened BEFORE spawn — an open failure means the
  // check cannot produce durable proof, so it never starts.
  let outFd = null;
  let errFd = null;
  try {
    if (logOutFile) {
      await ensureDir(path.dirname(logOutFile), 0o700);
      outFd = openSync(logOutFile, 'a', 0o600);
    }
    if (logErrFile) {
      await ensureDir(path.dirname(logErrFile), 0o700);
      errFd = openSync(logErrFile, 'a', 0o600);
    }
  } catch (e) {
    report.error = `durable check log unavailable: ${e.code || e.message}`;
    report.durationMs = now() - startedAt;
    if (outFd != null) try { closeSync(outFd); } catch { /* ignore */ }
    if (errFd != null) try { closeSync(errFd); } catch { /* ignore */ }
    return report;
  }
  // The log files carry the child's RAW stdout/stderr bytes ONLY — the
  // run string/cwd/exit metadata live in the durable check report (and a
  // sidecar if the caller wants one), so report.stdoutBytes is the true
  // stdout size and no header can masquerade as check output.
  let logError = null;

  const childEnv = { ...(env || process.env) };
  delete childEnv.ACP_OPS_TOKEN_FILE;
  delete childEnv.ACP_OPS_TOKEN;

  let child;
  report.spawnInvoked = true;
  try {
    child = spawn('bash', ['-c', check.run], {
      cwd: cwdReal,
      env: childEnv,
      shell: false,
      detached: true, // own process group — pgid === child.pid
      stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'],
    });
  } catch (e) {
    if (outFd != null) try { closeSync(outFd); } catch { /* ignore */ }
    if (errFd != null) try { closeSync(errFd); } catch { /* ignore */ }
    report.spawnError = `spawn failed: ${e.message}`;
    report.error = report.spawnError;
    report.durationMs = now() - startedAt;
    return report;
  }
  report.childSpawned = Number.isInteger(child.pid) && child.pid > 0;

  const leader = {
    pid: child.pid ?? null,
    pgid: child.pid ?? null,
    starttime: procStarttimeLocal(child.pid),
    pidNs: procNsOfLocal('pid', child.pid),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    envInstance: ourEnv.envInstance ?? null,
  };
  report.proc = { ...leader };

  // Lifecycle listeners install BEFORE the onProc await — a fast exit or a
  // spawn 'error' during persistence is observed, never missed.
  const knownMembers = new Map();
  let exited = null;    // [code, signal]
  let spawnErr = null;
  let procRecordFailed = null;
  child.on('error', (e) => { spawnErr = e; });
  child.on('exit', (code, signal) => { exited = [code, signal]; });
  child.on('close', () => { /* stdio are files; close follows exit */ });

  const leaderLive = () => leaderBindingComplete(leader) && leaderProvenLive(leader);
  const scanMembers = () => {
    if (!leaderLive()) return;
    const members = memberScan(leader.pgid);
    if (!Array.isArray(members)) return; // unreadable scan adds nothing
    for (const m of members) {
      if (m.pid !== leader.pid) knownMembers.set(m.pid, m.starttime);
    }
  };
  scanMembers(); // capture the leader's own group at birth

  if (onProc) {
    try {
      await onProc(leader);
    } catch (e) {
      procRecordFailed = e;
      // The spawned group is ours and live — kill it; without the durable
      // record the run cannot prove it later.
      report.killResult = killOwnedGroup(leader, { signal: 'SIGKILL', ourEnv, knownMembers, signalFn });
    }
  }

  const result = await new Promise((resolvePromise) => {
    let timedOut = false;
    let cancelled = false;
    let killPhase = 0; // 0 none, 1 TERM sent, 2 KILL sent, 3 bounded-out
    const startKill = () => {
      if (killPhase !== 0) return;
      killPhase = 1;
      report.killResult = killOwnedGroup(leader, { signal: 'SIGTERM', ourEnv, knownMembers, signalFn });
      setTimeout(() => {
        if (exited) return;
        killPhase = 2;
        report.killResult = killOwnedGroup(leader, { signal: 'SIGKILL', ourEnv, knownMembers, signalFn });
        setTimeout(() => {
          if (exited) return;
          killPhase = 3;
          // Leader refused to die within the bounded window — resolve as
          // unproven; the report carries the live reservation honestly and
          // the validation never treats this as a clean outcome.
          report.unproven = true;
          finish();
        }, killSettleMs).unref?.();
      }, killGraceMs).unref?.();
    };
    // The timeout/poll/watcher handles stay REF'd — they are the liveness
    // guarantee for this promise and are all cleared in finish(); the
    // kill-escalation one-shots above are the only unref'd timers.
    const timer = setTimeout(() => { timedOut = true; startKill(); }, timeoutMs);
    const poll = setInterval(() => {
      scanMembers();
      if (!exited && !cancelled && isCancelled && isCancelled()) {
        cancelled = true;
        startKill();
      }
      if (procRecordFailed && !exited) {
        // Persistence failed — we already SIGKILLed the group; settle it out
        // bounded rather than burning the check timeout.
        clearInterval(poll);
        clearTimeout(timer);
        settleGroup().then(finish);
        return;
      }
      if (spawnErr && !exited) {
        // async spawn failure without exit — settle as error
        clearInterval(poll);
        clearTimeout(timer);
        settleGroup().then(finish);
      }
    }, cancelPollMs);

    const settleGroup = async () => {
      // Wait for the group to empty; then handle survivors: proven →
      // TERM→KILL via the strict helper; unproven → reported, retained.
      const deadline = Date.now() + groupSettleMs;
      let members = procGroupMembers(leader.pgid);
      while (members && members.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        members = procGroupMembers(leader.pgid);
      }
      if (members === null) {
        report.unproven = true;
        report.groupSurvived = [{ scanUnverifiable: true, pgid: leader.pgid }];
        return;
      }
      if (!members.length) {
        // A clean scan is still not positive proof alone — cross-check the
        // pgid itself: ESRCH = the group is verifiably gone; a surviving
        // pgid with no readable members is unverifiable, not empty.
        try {
          signalFn(-leader.pgid, 0);
          report.unproven = true;
          report.groupSurvived = [{ pgidHeldNoMembersVisible: true, pgid: leader.pgid }];
        } catch (e) {
          if (e && e.code === 'ESRCH') {
            report.groupDead = true; // positive proof — the pgid is gone
          } else {
            report.unproven = true;
            report.groupSurvived = [{ pgidProbeFailed: true, pgid: leader.pgid }];
          }
        }
        return;
      }
      // One escalation pass through the strict path for what remains.
      report.killResult = killOwnedGroup(leader, { signal: 'SIGTERM', ourEnv, knownMembers, signalFn });
      await new Promise((r) => setTimeout(r, Math.min(killGraceMs, 1000)));
      report.killResult = killOwnedGroup(leader, { signal: 'SIGKILL', ourEnv, knownMembers, signalFn });
      await new Promise((r) => setTimeout(r, 200));
      const rest = procGroupMembers(leader.pgid);
      if (rest === null) {
        report.unproven = true;
        report.groupSurvived = [{ scanUnverifiable: true, pgid: leader.pgid }];
      } else if (rest.length) {
        // Survivors are reported with their FULL scanned identity — a bare
        // pid is not an identity a reader can safely act on later.
        report.unproven = true;
        report.groupSurvived = rest.map((m) => ({
          pid: m.pid, starttime: m.starttime ?? null, pidNs: m.pidNs ?? null,
          uid: m.uid ?? null, pgrp: m.pgrp ?? null,
        }));
      } else {
        // Empty scan after the strict pass — still not positive proof alone;
        // the pgid itself must answer ESRCH in OUR namespace (unreadable or
        // EPERM is not "gone").
        try {
          signalFn(-leader.pgid, 0);
          report.unproven = true;
          report.groupSurvived = [{ pgidHeldNoMembersVisible: true, pgid: leader.pgid }];
        } catch (e) {
          if (e && e.code === 'ESRCH') report.groupDead = true;
          else {
            report.unproven = true;
            report.groupSurvived = [{ pgidProbeFailed: true, pgid: leader.pgid }];
          }
        }
      }
    };

    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      clearInterval(watcher);
      try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* none */ }
      try { child.unref(); } catch { /* ignore */ }
      const [code, signal] = exited || [null, null];
      resolvePromise({ code, signal, timedOut, cancelled });
    };
    // Settle when the leader's stdio fully closes (close follows exit with
    // file-backed stdio), or when the bounded kill path exhausts.
    const watcher = setInterval(() => {
      if (exited) {
        clearInterval(watcher);
        settleGroup().then(finish);
      }
    }, 50);
  });

  // Durability: fsync before close so a crash cannot lose check evidence
  // the report will later claim was written.
  if (outFd != null) {
    try { fsyncSync(outFd); } catch (e) { logError ??= e; }
    try { closeSync(outFd); } catch { /* ignore */ }
  }
  if (errFd != null) {
    try { fsyncSync(errFd); } catch (e) { logError ??= e; }
    try { closeSync(errFd); } catch { /* ignore */ }
  }
  if (logError) report.logError = `check log durability failed: ${logError.code || logError.message}`;

  const outTail = logOutFile ? await readTail(logOutFile, CHECK_TAIL_MAX) : { tail: '', bytes: 0, truncated: false };
  const errTail = logErrFile ? await readTail(logErrFile, CHECK_TAIL_MAX) : { tail: '', bytes: 0, truncated: false };
  report.stdoutTail = outTail.tail;
  report.stderrTail = errTail.tail;
  report.stdoutBytes = outTail.bytes;
  report.stderrBytes = errTail.bytes;
  report.stdoutTruncated = outTail.truncated;
  report.stderrTruncated = errTail.truncated;
  report.exitCode = result.code;
  report.signal = result.signal;
  report.timedOut = result.timedOut;
  report.cancelled = result.cancelled;
  report.durationMs = now() - startedAt;

  if (spawnErr && report.proc?.pid == null) report.groupDead = true;
  if (spawnErr) {
    report.spawnError = `spawn error: ${spawnErr.message}`;
    report.error = report.spawnError;
    report.status = 'error';
  } else if (report.groupDead !== true) {
    // A spawned group whose death was never positively proven outranks
    // every other outcome — pass/fail/cancel/timeout are all impossible
    // to certify while the group state is unknown.
    report.unproven = true;
    report.error = report.error
      || 'process group could not be proven dead — reservation retained';
    report.status = 'unproven';
  } else if (procRecordFailed) {
    report.error = `proc identity persistence failed: ${procRecordFailed.message}`;
    report.status = 'error';
  } else if (report.logError) {
    // The durable log is part of the evidence — its failure is not a pass.
    report.error = report.logError;
    report.status = 'error';
  } else if (report.cancelled) {
    report.status = 'cancelled';
  } else if (report.timedOut) {
    report.status = 'timeout';
  } else if (report.exitCode === 0) {
    report.status = 'pass';
  } else {
    report.status = 'fail';
  }
  return report;
}
