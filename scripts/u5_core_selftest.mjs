// scripts/u5_core_selftest.mjs — U5 result-snapshot / isolated-copy /
// owned-process-group / review-gate regression tests.
//   node --test scripts/u5_core_selftest.mjs
//
// Real temporary git repositories, REAL spawned process groups for
// cancellation proofs. NOTHING opens a listener, touches compose, or
// mutates the live state dir. These are the module-level proofs the
// domain/scheduler integration relies on.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, lstatSync, realpathSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  computeResultManifest, materializeResultCopy, verifyResultCopy,
  resultHashFor, validationDirs, assertValidationDirs,
  procIdentityLocal, procNsOfLocal, procGroupMembers, killOwnedGroup,
  runCheckCommand, isCredentialPath, CHECK_TAIL_MAX,
} from '../server/execution/result-snapshot.mjs';
import {
  parseFindingsDoc, parseVerdictDoc, evaluateReviewGate,
  snapshotReviewRules, ReviewDocError, DEFAULT_MAX_ROUNDS,
} from '../server/execution/review-contract.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanupRoots = new Set();
// Recorded as {pid,starttime} — cleanup re-proves identity before any
// signal, so a recycled pid is never killed by stale bookkeeping.
const cleanupProcs = [];
after(async () => {
  for (const rec of cleanupProcs) {
    const now = procIdentityLocal(rec.pid);
    if (now && now.alive === true && now.starttime === rec.starttime) {
      try { process.kill(rec.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  for (const r of cleanupRoots) {
    await fs.rm(r, { recursive: true, force: true }).catch(() => {});
  }
});
const ownProc = (pid) => {
  cleanupProcs.push({ pid, starttime: procIdentityLocal(pid)?.starttime ?? null });
};

const myEnv = () => ({
  pidNs: procNsOfLocal('pid', process.pid),
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  envInstance: { containerId: 'u5-selftest', initStarttime: 'boot' },
});

async function mkRepo() {
  const dir = join(tmpdir(), `u5-repo-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  await fs.writeFile(join(dir, 'README.md'), '# fixture\n');
  await fs.writeFile(join(dir, 'a.js'), 'export const a = 1;\n');
  execFileSync('git', ['-C', dir, 'add', '-A'], { timeout: 10000 });
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

const baseOf = (dir) => git(dir, 'rev-parse', 'HEAD');

// ---------------------------------------------------------------- snapshot

test('manifest: dirty tracked + new untracked + deleted captured; hash stable, drift changes it', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const m0 = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m0.ok, true);
  assert.equal(m0.resultSha256.length, 64);

  await fs.writeFile(join(repo, 'a.js'), 'export const a = 999;\n'); // dirty
  await fs.writeFile(join(repo, 'new.txt'), 'new file\n');           // untracked
  await fs.rm(join(repo, 'README.md'));                            // deleted
  const m1 = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m1.ok, true);
  assert.notEqual(m1.resultSha256, m0.resultSha256);

  const a = m1.manifest.entries.find((e) => e.path === 'a.js');
  assert.equal(a.kind, 'file');
  // dirty worktree bytes hashed — differs from the committed blob
  const { createHash } = await import('node:crypto');
  assert.equal(a.sha256, createHash('sha256').update('export const a = 999;\n').digest('hex'));
  assert.ok(m1.manifest.entries.some((e) => e.path === 'new.txt'));
  assert.ok(m1.manifest.deleted.includes('README.md'));
  assert.equal(m1.manifest.headCommit, base); // no commit happened
  // recomputation is deterministic
  const m2 = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m2.resultSha256, m1.resultSha256);
});

test('manifest: binary bytes hashed verbatim; mode change captured', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const bin = Buffer.concat([Buffer.from([0, 1, 2, 255, 254, 0]), Buffer.alloc(1024, 0xab)]);
  await fs.writeFile(join(repo, 'blob.bin'), bin);
  await fs.chmod(join(repo, 'a.js'), 0o755);
  const m = await computeResultManifest(repo, { baseCommit: base });
  const b = m.manifest.entries.find((e) => e.path === 'blob.bin');
  const a = m.manifest.entries.find((e) => e.path === 'a.js');
  assert.equal(b.size, bin.length);
  assert.equal(a.mode, 0o755);
});

test('manifest: internal symlink recorded by target; absolute/escaping fail closed', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.writeFile(join(repo, 'real.txt'), 'target\n');
  await fs.symlink('real.txt', join(repo, 'link-ok'));        // internal relative
  await fs.symlink('/etc/passwd', join(repo, 'link-abs'));   // absolute
  await fs.symlink('../escape', join(repo, 'link-esc'));     // escaping
  const m = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m.ok, false, 'unsafe links must fail the capture closed');
  const ok = m.manifest.entries.find((e) => e.path === 'link-ok');
  assert.equal(ok.kind, 'link');
  assert.equal(ok.target, 'real.txt');
  const reasons = new Map(m.manifest.unsupported.map((u) => [u.path, u.reason]));
  assert.equal(reasons.get('link-abs'), 'link_absolute');
  assert.equal(reasons.get('link-esc'), 'link_escape');
  // the link targets are still hash-bound in the unsupported record
  const abs = m.manifest.unsupported.find((u) => u.path === 'link-abs');
  assert.equal(abs.sha256.length, 64);
});

test('manifest: symlinked ancestor on a tracked path fails closed', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.mkdir(join(repo, 'dir'));
  await fs.writeFile(join(repo, 'dir', 'f.js'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'two');
  // replace the dir by a symlink pointing outside — ancestor escape
  await fs.rm(join(repo, 'dir'), { recursive: true });
  const outside = join(tmpdir(), `u5-out-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(outside);
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'f.js'), 'leak\n');
  await fs.symlink(outside, join(repo, 'dir'));
  const m = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m.ok, false);
  assert.ok(m.manifest.unsupported.some((u) => u.path === 'dir/f.js' && u.reason === 'ancestor_unsafe'));
});

test('manifest: captured HEAD binds the hash — a post-snapshot commit invalidates it', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.writeFile(join(repo, 'b.txt'), 'b\n');
  const before = await computeResultManifest(repo, { baseCommit: base });
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'post');
  const after = await computeResultManifest(repo, { baseCommit: base });
  assert.notEqual(after.manifest.headCommit, before.manifest.headCommit);
  assert.notEqual(after.resultSha256, before.resultSha256);
});

test('manifest: a different baseCommit changes the hash binding', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.writeFile(join(repo, 'c.txt'), 'c\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'two');
  const head2 = baseOf(repo);
  const m1 = await computeResultManifest(repo, { baseCommit: base });
  const m2 = await computeResultManifest(repo, { baseCommit: head2 });
  assert.notEqual(m1.resultSha256, m2.resultSha256);
  await assert.rejects(
    () => computeResultManifest(repo, { baseCommit: 'deadbeef' }),
    /baseCommit must be a full sha/);
});

test('manifest: gitlink/submodule fails closed — never materialized empty', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const sub = await mkRepo();
  execFileSync('git', ['-C', repo, '-c', 'protocol.file.allow=always',
    'submodule', '-q', 'add', sub, 'sub'], { timeout: 15000 });
  const m = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m.ok, false);
  assert.ok(m.manifest.unsupported.some((u) => u.reason === 'gitlink' && u.path === 'sub'));
});

test('manifest: unmerged index stage fails closed', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const mainBranch = git(repo, 'branch', '--show-current');
  git(repo, 'checkout', '-q', '-b', 'side');
  await fs.writeFile(join(repo, 'a.js'), 'export const a = 2;\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'side');
  git(repo, 'checkout', '-q', mainBranch);
  await fs.writeFile(join(repo, 'a.js'), 'export const a = 3;\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'main');
  try {
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', 'side');
  } catch { /* conflict expected */ }
  // prove the fixture reached the conflicted index state before asserting
  assert.ok(git(repo, 'ls-files', '-u').length > 0,
    'fixture must produce actual unmerged stages');
  const m = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m.ok, false);
  assert.ok(m.manifest.unsupported.some((u) => u.reason === 'index_unmerged' && u.path === 'a.js'));
});

test('manifest: untracked credential hash-recorded but excluded; tracked credential kept', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.writeFile(join(repo, '.env'), 'SECRET=x\n');          // untracked → excluded
  await fs.writeFile(join(repo, 'id_rsa'), 'KEY\n');
  git(repo, 'add', '.env');                                     // tracked → kept
  const m = await computeResultManifest(repo, { baseCommit: base });
  assert.ok(m.manifest.excluded.some((e) => e.path === 'id_rsa' && e.reason === 'credential'));
  assert.ok(m.manifest.excluded[0].sha256.length === 64);
  assert.ok(m.manifest.entries.some((e) => e.path === '.env'),
    'tracked credential stays in the exact result');
});

test('manifest: ignored paths are outside the result set (documented bound)', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.writeFile(join(repo, '.gitignore'), 'ignored.log\n');
  await fs.writeFile(join(repo, 'ignored.log'), 'noise\n');
  const m = await computeResultManifest(repo, { baseCommit: base });
  assert.ok(!m.manifest.entries.some((e) => e.path === 'ignored.log'));
  assert.ok(m.manifest.entries.some((e) => e.path === '.gitignore'));
});

// ---------------------------------------------------------------- copies

test('copy: dirty+new materialize; deleted absent; internal symlink works; own git repo', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.writeFile(join(repo, 'a.js'), 'dirty\n');
  await fs.writeFile(join(repo, 'fresh.txt'), 'new\n');
  await fs.symlink('fresh.txt', join(repo, 'ln'));
  await fs.rm(join(repo, 'README.md'));
  const m = await computeResultManifest(repo, { baseCommit: base });
  assert.equal(m.ok, true);
  const dest = join(repo, '..', `u5-copy-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(dest);
  const res = await materializeResultCopy(m.manifest, repo, dest, { wsRoot: repo + '/..' });
  assert.equal(res.ok, true);
  assert.equal(await fs.readFile(join(dest, 'a.js'), 'utf-8'), 'dirty\n');
  assert.equal(await fs.readFile(join(dest, 'fresh.txt'), 'utf-8'), 'new\n');
  assert.equal(await fs.readlink(join(dest, 'ln')), 'fresh.txt');
  await assert.rejects(() => fs.lstat(join(dest, 'README.md')));
  assert.ok(lstatSync(join(dest, '.git')).isDirectory(), 'copy is a self-contained repo');
  // copy is independent: source edits after copy do not move the copy
  await fs.writeFile(join(repo, 'a.js'), 'later\n');
  assert.equal(await fs.readFile(join(dest, 'a.js'), 'utf-8'), 'dirty\n');
});

test('copy: separate pristine copies stay independent', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const m = await computeResultManifest(repo, { baseCommit: base });
  const wsRoot = join(repo, '..');
  const revDir = join(wsRoot, `u5-rev-${randomUUID().slice(0, 6)}`);
  const chkDir = join(wsRoot, `u5-chk-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(revDir); cleanupRoots.add(chkDir);
  await materializeResultCopy(m.manifest, repo, revDir, { wsRoot });
  await materializeResultCopy(m.manifest, repo, chkDir, { wsRoot });
  await fs.writeFile(join(revDir, 'a.js'), 'reviewer wrote here\n');
  await fs.writeFile(join(revDir, 'scratch.txt'), 'edit\n');
  assert.equal(await fs.readFile(join(chkDir, 'a.js'), 'utf-8'), 'export const a = 1;\n');
  await assert.rejects(() => fs.lstat(join(chkDir, 'scratch.txt')));
});

test('copy: source mutation between capture and copy fails (result_drift)', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const m = await computeResultManifest(repo, { baseCommit: base });
  await fs.writeFile(join(repo, 'a.js'), 'mutated mid-validation\n');
  const dest = join(repo, '..', `u5-drift-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(dest);
  await assert.rejects(
    () => materializeResultCopy(m.manifest, repo, dest, { wsRoot: repo + '/..' }),
    (e) => e.code === 'result_drift');
});

test('copy: destination through a pre-planted symlinked ancestor refuses + creates nothing outside', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const m = await computeResultManifest(repo, { baseCommit: base });
  const outside = join(tmpdir(), `u5-escape-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(outside);
  await fs.mkdir(outside);
  const wsRoot = join(repo, '..');
  const evil = join(wsRoot, `u5-evil-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(evil);
  await fs.mkdir(evil);
  await fs.symlink(outside, join(evil, 'through'));
  const dest = join(evil, 'through', 'copy');
  await assert.rejects(
    () => materializeResultCopy(m.manifest, repo, dest, { wsRoot }),
    (e) => e.code === 'copy_failed');
  assert.deepEqual(await fs.readdir(outside), [],
    'nothing may be created outside wsRoot on refusal');
});

test('copy: refuses non-empty destination and unsupported/unsafe caller manifests', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  const m = await computeResultManifest(repo, { baseCommit: base });
  const dest = join(repo, '..', `u5-nonempty-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(dest);
  await fs.mkdir(dest);
  await fs.writeFile(join(dest, 'junk'), 'x');
  await assert.rejects(
    () => materializeResultCopy(m.manifest, repo, dest, { wsRoot: repo + '/..' }),
    /not empty/);
  // caller-supplied manifest with unsupported entries refused
  const bad = structuredClone(m.manifest);
  bad.unsupported.push({ path: 'sub', reason: 'gitlink' });
  await assert.rejects(
    () => materializeResultCopy(bad, repo, join(repo, '..', `u5-u-${randomUUID().slice(0, 6)}`), { wsRoot: repo + '/..' }),
    (e) => e.code === 'result_unsupported');
  // escaping path refused
  const bad2 = structuredClone(m.manifest);
  bad2.entries.push({ path: '../x', kind: 'file', sha256: '0'.repeat(64), size: 1 });
  await assert.rejects(
    () => materializeResultCopy(bad2, repo, join(repo, '..', `u5-p-${randomUUID().slice(0, 6)}`), { wsRoot: repo + '/..' }),
    (e) => e.code === 'invalid_argument');
  // absolute link target refused
  const bad3 = structuredClone(m.manifest);
  bad3.entries.push({ path: 'ln', kind: 'link', target: '/etc/passwd' });
  await assert.rejects(
    () => materializeResultCopy(bad3, repo, join(repo, '..', `u5-l-${randomUUID().slice(0, 6)}`), { wsRoot: repo + '/..' }),
    (e) => e.code === 'invalid_argument');
});

test('copy: verifyResultCopy detects content/mode/extra mismatch', async () => {
  const repo = await mkRepo();
  const base = baseOf(repo);
  await fs.chmod(join(repo, 'a.js'), 0o755);
  const m = await computeResultManifest(repo, { baseCommit: base });
  const dest = join(repo, '..', `u5-ver-${randomUUID().slice(0, 6)}`);
  cleanupRoots.add(dest);
  await materializeResultCopy(m.manifest, repo, dest, { wsRoot: repo + '/..' });
  assert.equal((await verifyResultCopy(m.manifest, dest)).ok, true);
  await fs.writeFile(join(dest, 'a.js'), 'tampered\n');
  const v = await verifyResultCopy(m.manifest, dest);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('a.js')));
});

test('dirs: assertValidationDirs refuses a runner-supplied foreign layout', async () => {
  const d = validationDirs('/ws', 'run_1', 'val_1');
  assert.doesNotThrow(() => assertValidationDirs(d, '/ws', 'run_1', 'val_1'));
  const wrong = { ...d, verify: '/tmp/foreign' };
  assert.throws(() => assertValidationDirs(wrong, '/ws', 'run_1', 'val_1'), /validation dir verify/);
});

// ---------------------------------------------------------------- checks

test('check: pass/fail, verbatim shell, durable full log + capped tail', async () => {
  const repo = await mkRepo();
  const logO = join(repo, 'c.out'); const logE = join(repo, 'c.err');
  const n = CHECK_TAIL_MAX + 1000;
  let r = await runCheckCommand(
    { run: `head -c ${n} /dev/zero | tr '\\0' x; echo err >&2`, index: 0 },
    { verifyDir: repo, ourEnv: myEnv(), logOutFile: logO, logErrFile: logE });
  assert.equal(r.status, 'pass');
  assert.equal(r.stdoutTruncated, true);
  // the log file is the child's RAW stdout — report bytes equal output
  // bytes exactly; no header/trailer pollutes the stream evidence
  assert.equal(r.stdoutBytes, n);
  const full = await fs.readFile(logO, 'utf-8');
  assert.equal(full, 'x'.repeat(n), 'full durable log keeps every raw byte');
  assert.equal(await fs.readFile(logE, 'utf-8'), 'err\n');
  const r2 = await runCheckCommand(
    { run: 'exit 3', index: 1 },
    { verifyDir: repo, ourEnv: myEnv(), logOutFile: logO, logErrFile: logE });
  assert.equal(r2.status, 'fail');
  assert.equal(r2.exitCode, 3);
});

test('check: refuses without durable log paths and on cwd escape', async () => {
  const repo = await mkRepo();
  let r = await runCheckCommand({ run: 'echo hi', index: 0 },
    { verifyDir: repo, ourEnv: myEnv() });
  assert.equal(r.status, 'error');
  assert.match(r.error, /durable check logs required/);
  r = await runCheckCommand({ run: 'echo hi', cwd: '../..', index: 1 },
    { verifyDir: repo, ourEnv: myEnv(), logOutFile: join(repo, 'o'), logErrFile: join(repo, 'e') });
  assert.equal(r.status, 'error');
  assert.match(r.error, /escapes the validation copy/);
});

test('check: cancel kills own group; unrelated sentinel survives', async () => {
  const repo = await mkRepo();
  const sentinel = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  sentinel.unref();
  ownProc(sentinel.pid);
  const flag = { v: false };
  setTimeout(() => { flag.v = true; }, 300);
  const r = await runCheckCommand(
    { run: 'sleep 30 & sleep 30', index: 0 },
    {
      verifyDir: repo, ourEnv: myEnv(), isCancelled: () => flag.v,
      logOutFile: join(repo, 'o'), logErrFile: join(repo, 'e'),
      killGraceMs: 200, groupSettleMs: 1500,
    });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.killResult.signalled, true);
  const alive = procIdentityLocal(sentinel.pid);
  assert.equal(alive.alive, true, 'foreign process is never signalled');
});

test('check: leader exit with a captured group member → member killed, clean settle', async () => {
  const repo = await mkRepo();
  // Leader lives long enough for the member scan to capture the child —
  // the survivor is PROVABLE and gets signalled after leader death.
  const r = await runCheckCommand(
    { run: 'sleep 30 & sleep 0.5', index: 0 },
    {
      verifyDir: repo, ourEnv: myEnv(),
      logOutFile: join(repo, 'o'), logErrFile: join(repo, 'e'),
      killGraceMs: 200, groupSettleMs: 1500,
    });
  assert.equal(r.status, 'pass');
  assert.equal(r.groupSurvived, null);
  assert.equal(r.unproven, false);
});

test('check: leader exits instantly with an uncaptured survivor → unproven, reservation retained', async () => {
  const repo = await mkRepo();
  // Deterministic unknown member: the injected memberScan never captures —
  // no timing race with the birth scan. The survivor is a REAL process in
  // the leader's group; settleGroup's real /proc re-scan finds it, the
  // strict kill path refuses it (not in knownMembers) → orphan, unproven.
  const signalled = [];
  const signalSpy = (pid, sig) => {
    signalled.push({ pid, sig });
    return process.kill(pid, sig);
  };
  let r;
  try {
    r = await runCheckCommand(
      { run: 'sleep 30 & exit 0', index: 0 },
      {
        verifyDir: repo, ourEnv: myEnv(),
        logOutFile: join(repo, 'o'), logErrFile: join(repo, 'e'),
        killGraceMs: 200, groupSettleMs: 1200,
        memberScan: () => [],
        signalFn: signalSpy,
      });
    assert.equal(r.status, 'unproven');
    assert.ok(Array.isArray(r.groupSurvived) && r.groupSurvived.length > 0,
      'the survivor is reported, retained, and never silently ignored');
    // The survivor record carries the FULL scanned identity.
    const surv = r.groupSurvived.find((s) => Number.isInteger(s?.pid) && s.pid > 0);
    assert.ok(surv, 'a survivor entry must carry a real pid');
    assert.ok(typeof surv.starttime === 'string' && surv.starttime.length > 0
      && typeof surv.pidNs === 'string' && surv.pidNs.length > 0
      && Number.isInteger(surv.uid) && Number.isInteger(surv.pgrp),
      'survivor record must carry {pid,starttime,pidNs,uid,pgrp} — never a bare pid');
    // The spy proves the unknown member was NEVER signalled — zero
    // TERM/KILL (or any non-probe signal) to its pid.
    const hits = signalled.filter((s) => s.pid === surv.pid && s.sig !== 0);
    assert.deepEqual(hits, [], `unknown member ${surv.pid} must receive zero signals`);
    // Positive proof the real process survived (identity still matches).
    const alive = procIdentityLocal(surv.pid);
    assert.ok(alive && alive.alive === true && alive.starttime === surv.starttime
      && alive.pidNs === surv.pidNs && alive.uid === surv.uid
      && alive.pgrp === surv.pgrp,
      'the unsignalled survivor must still be live under the same identity');
  } finally {
    // Cleanup guards EVERY signal on the full recorded identity — a
    // recycled or foreign pid at the same slot is never killed.
    for (const s of r?.groupSurvived || []) {
      if (!Number.isInteger(s?.pid) || s.pid <= 0) continue;
      const cur = procIdentityLocal(s.pid);
      if (cur && cur.alive === true
        && cur.starttime === s.starttime && cur.pidNs === s.pidNs
        && cur.uid === s.uid && cur.pgrp === s.pgrp) {
        try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  }
});

test('check: onProc persistence failure kills the spawned group, never proceeds', async () => {
  const repo = await mkRepo();
  let seenLeader = null;
  const r = await runCheckCommand(
    { run: 'sleep 30', index: 0 },
    {
      verifyDir: repo, ourEnv: myEnv(),
      logOutFile: join(repo, 'o'), logErrFile: join(repo, 'e'),
      killGraceMs: 100, groupSettleMs: 800, killSettleMs: 300,
      onProc: async (leader) => { seenLeader = leader; throw new Error('disk full'); },
    });
  assert.equal(r.status, 'error');
  assert.match(r.error, /proc identity persistence failed/);
  assert.ok(seenLeader && seenLeader.pid > 0);
  const dead = procIdentityLocal(seenLeader.pid);
  assert.ok(!dead || dead.alive !== true,
    'unpersisted spawned process must be killed — nothing runs unproven');
});

test('group: dead leader + provable member → member signalled; unprovable member → orphan kept', async () => {
  const ourEnv = myEnv();
  // own controlled group: bash(detached) → sleep child
  const leaderChild = spawn('bash', ['-c', 'sleep 30 & sleep 60'], { detached: true, stdio: 'ignore' });
  leaderChild.unref();
  ownProc(leaderChild.pid);
  await sleep(300);
  const leader = {
    pid: leaderChild.pid, pgid: leaderChild.pid,
    starttime: procIdentityLocal(leaderChild.pid).starttime,
    pidNs: procNsOfLocal('pid', leaderChild.pid),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    envInstance: ourEnv.envInstance,
  };
  const members = procGroupMembers(leader.pgid).filter((m) => m.pid !== leader.pid);
  assert.ok(members.length >= 1, 'fixture has a live group member');
  const known = new Map(members.map((m) => [m.pid, m.starttime]));
  leaderChild.kill('SIGKILL'); // leader dies, member survives
  await sleep(200);

  const k1 = killOwnedGroup(leader, { signal: 'SIGKILL', ourEnv, knownMembers: known });
  assert.equal(k1.signalled, true, 'provable member is signalled');
  assert.equal(k1.orphans.length, 0);

  // second fixture: same shape but member NOT captured → unprovable
  const leader2 = spawn('bash', ['-c', 'sleep 30 & sleep 60'], { detached: true, stdio: 'ignore' });
  leader2.unref();
  ownProc(leader2.pid);
  await sleep(300);
  const l2 = {
    pid: leader2.pid, pgid: leader2.pid,
    starttime: procIdentityLocal(leader2.pid).starttime,
    pidNs: procNsOfLocal('pid', leader2.pid),
    uid: leader.uid,
    envInstance: ourEnv.envInstance,
  };
  const members2 = procGroupMembers(l2.pgid).filter((m) => m.pid !== l2.pid);
  for (const m of members2) ownProc(m.pid);
  leader2.kill('SIGKILL');
  await sleep(200);
  const k2 = killOwnedGroup(l2, { signal: 'SIGKILL', ourEnv, knownMembers: new Map() });
  assert.equal(k2.signalled, false, 'unprovable member is never signalled');
  assert.ok(k2.orphans.length >= 1, 'survivor retained as orphan');
  for (const m of members2) { try { process.kill(m.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('group: missing/foreign bindings refuse — ZERO probes and ZERO signals', async () => {
  const ourEnv = myEnv();
  let probeCalls = 0;
  let signalCalls = 0;
  let scanCalls = 0;
  const spy = {
    probe: (...a) => { probeCalls += 1; return procIdentityLocal(...a); },
    signalFn: (...a) => { signalCalls += 1; return process.kill(...a); },
    scan: (...a) => { scanCalls += 1; return procGroupMembers(...a); },
  };
  const zero = () => {
    assert.equal(probeCalls, 0, 'foreign/missing record must never be probed');
    assert.equal(signalCalls, 0, 'foreign/missing record must never be signalled');
    assert.equal(scanCalls, 0);
  };
  // foreign namespace
  let k = killOwnedGroup({
    pid: process.pid, pgid: process.pid, starttime: 'x', pidNs: 'foreign',
    uid: ourEnv.uid, envInstance: ourEnv.envInstance,
  }, { ourEnv, ...spy });
  assert.equal(k.refused, true);
  assert.equal(k.reason, 'foreign_namespace');
  zero();
  // foreign environment instance
  k = killOwnedGroup({
    pid: 1, pgid: 1, starttime: 'x', pidNs: ourEnv.pidNs,
    uid: ourEnv.uid, envInstance: { containerId: 'other', initStarttime: 'i' },
  }, { ourEnv, ...spy });
  assert.equal(k.refused, true);
  assert.equal(k.reason, 'foreign_environment');
  zero();
  // missing leader fields
  k = killOwnedGroup({ pid: process.pid }, { ourEnv, ...spy });
  assert.equal(k.refused, true);
  assert.equal(k.reason, 'leader_binding_incomplete');
  zero();
  // incomplete caller env — even with a well-formed record
  k = killOwnedGroup({
    pid: 1, pgid: 1, starttime: 'x', pidNs: ourEnv.pidNs,
    uid: ourEnv.uid, envInstance: ourEnv.envInstance,
  }, { ourEnv: {}, ...spy });
  assert.equal(k.refused, true);
  assert.equal(k.reason, 'caller_binding_incomplete');
  zero();
});

// ---------------------------------------------------------------- gate

const mkFindings = (list) => ({ version: 1, round: 1, findings: list });
const mkVerdicts = (list) => ({ version: 1, round: 1, verdicts: list });
const rules = snapshotReviewRules(null, {});

test('gate: checks pass + EMPTY verified findings + EMPTY verdicts → awaiting_acceptance', () => {
  const g = evaluateReviewGate({
    round: 1, checksVerdict: 'pass',
    findings: mkFindings([]), verdicts: mkVerdicts([]), rules,
  });
  assert.equal(g.decision, 'awaiting_acceptance');
});

test('gate: missing evidence NEVER opens — undefined docs throw, never pass', () => {
  assert.throws(() => evaluateReviewGate({
    round: 1, checksVerdict: 'pass', findings: undefined, verdicts: undefined, rules,
  }), ReviewDocError);
  assert.throws(() => evaluateReviewGate({
    round: 1, checksVerdict: 'pass', findings: mkFindings([]), verdicts: null, rules,
  }), /verdicts doc required/);
  // checksVerdict must be exactly 'pass'|'fail'
  for (const cv of [undefined, null, 'yes', true, 'passed']) {
    assert.throws(() => evaluateReviewGate({
      round: 1, checksVerdict: cv, findings: mkFindings([]), verdicts: mkVerdicts([]), rules,
    }), ReviewDocError, `checksVerdict ${JSON.stringify(cv)} must not pass`);
  }
});

test('gate: boardctl parity — open critical/major gate; rejected clears; minor/nit never gate', () => {
  const F = (id, severity, status = 'open') => ({ id, round: 1, severity, status, text: 't', where: '' });
  // open critical unvetted → fix
  let g = evaluateReviewGate({ round: 1, checksVerdict: 'pass',
    findings: mkFindings([F('f1', 'critical')]), verdicts: mkVerdicts([]), rules });
  assert.equal(g.decision, 'fix');
  assert.deepEqual(g.unvetted, ['f1']);
  // disputed/confirmed still gate; rejected does not
  g = evaluateReviewGate({ round: 1, checksVerdict: 'pass',
    findings: mkFindings([F('f1', 'major')]),
    verdicts: mkVerdicts([{ findingId: 'f1', verdict: 'confirmed' }]), rules });
  assert.equal(g.decision, 'fix');
  g = evaluateReviewGate({ round: 1, checksVerdict: 'pass',
    findings: mkFindings([F('f1', 'major')]),
    verdicts: mkVerdicts([{ findingId: 'f1', verdict: 'rejected' }]), rules });
  assert.equal(g.decision, 'awaiting_acceptance');
  // minor open stays visible, never gates
  g = evaluateReviewGate({ round: 1, checksVerdict: 'pass',
    findings: mkFindings([F('n1', 'nit')]), verdicts: mkVerdicts([]), rules });
  assert.equal(g.decision, 'awaiting_acceptance');
  assert.equal(g.nonBlocking.length, 1);
  // closed finding never gates
  g = evaluateReviewGate({ round: 1, checksVerdict: 'pass',
    findings: mkFindings([F('f1', 'critical', 'closed')]), verdicts: mkVerdicts([]), rules });
  assert.equal(g.decision, 'awaiting_acceptance');
});

test('gate: failing checks → fix; at maxRounds → blocked', () => {
  let g = evaluateReviewGate({ round: 1, checksVerdict: 'fail',
    findings: mkFindings([]), verdicts: mkVerdicts([]), rules });
  assert.equal(g.decision, 'fix');
  g = evaluateReviewGate({ round: rules.maxRounds, checksVerdict: 'fail',
    findings: mkFindings([]), verdicts: mkVerdicts([]), rules });
  assert.equal(g.decision, 'blocked');
  g = evaluateReviewGate({ round: rules.maxRounds, checksVerdict: 'pass',
    findings: mkFindings([{ id: 'f', round: 1, severity: 'critical', status: 'open', text: 'x', where: '' }]),
    verdicts: mkVerdicts([]), rules });
  assert.equal(g.decision, 'blocked');
  assert.match(g.reason, /round limit/);
});

test('docs: stale round / unknown findingId / stale result hash are rejected', () => {
  const doc = { version: 1, round: 2, findings: [] };
  assert.throws(() => parseFindingsDoc(doc, { round: 1 }), /round/);
  assert.throws(() => parseFindingsDoc(
    { version: 1, round: 1, resultSha256: 'a'.repeat(64), findings: [] },
    { round: 1, resultSha256: 'b'.repeat(64) }), /resultSha256/);
  assert.throws(() => parseVerdictDoc(
    { version: 1, round: 9, verdicts: [] }, { round: 1 }), /round/);
  assert.throws(() => parseVerdictDoc(
    { version: 1, verdicts: [{ findingId: 'ghost', verdict: 'rejected' }] },
    { round: 1, findingIds: new Set(['real']) }), /unknown finding/);
  // verdict entry missing round inherits doc/caller round but must match
  assert.throws(() => parseVerdictDoc(
    { version: 1, verdicts: [{ findingId: 'f1', verdict: 'confirmed', round: 2 }] },
    { round: 1 }), /round/);
});

test('rules: snapshotted from preset limits + role review vocabulary', () => {
  const r1 = snapshotReviewRules(null, { maxReviewRounds: 5 });
  assert.equal(r1.maxRounds, 5);
  const roles = {
    stageRoles: { reviewtest: 'r1' },
    roles: [{ id: 'r1', review: { severities: ['sev-hi', 'sev-lo'], blocking: ['sev-hi'], backlog: ['sev-lo'], maxRounds: 2 } }],
  };
  const r2 = snapshotReviewRules(roles, null);
  assert.deepEqual(r2.blocking, ['sev-hi']);
  assert.equal(r2.maxRounds, 2);
  const r3 = snapshotReviewRules(null, null);
  assert.equal(r3.maxRounds, DEFAULT_MAX_ROUNDS);
});
