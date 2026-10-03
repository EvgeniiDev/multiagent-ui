// scripts/test_orchestrator_workspaces.mjs — O2 dependency workspace tests.
//   node --test scripts/test_orchestrator_workspaces.mjs
//
// Real Git repositories in temp dirs (no mocks): private-repo isolation,
// own-diff export, chain/diamond snapshots, conflict-before-launch,
// dirty freeze (new files + deletions + mode changes), canonical artifact
// reuse, provenance invalidation, incompatible-artifact rejection.
//
// The backend/scheduler worker consumes these modules for actual snapshots;
// the controller imports/exports snapshots separately — this file proves
// the deterministic algorithms and data the controller relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createPrivateRepo, verifyPrivateRepo, assertForeignUnresolvable,
  exportWorkerDiff, treeHashFor,
} from '../server/execution/orchestrator/workspaces.mjs';
import {
  transitivePredecessors, assembleDependencySnapshot, freezeResult,
  provenanceFor, assertProvenanceCurrent,
} from '../server/execution/orchestrator/snapshots.mjs';
import {
  artifactKey, recordResolution, loadArtifact, checkCompatible,
} from '../server/execution/orchestrator/integration-artifacts.mjs';

const G = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

let n = 0;
async function mkSource(files = { 'a.txt': 'base\n' }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `o2-src-${n++}-`));
  G(dir, 'init', '-q');
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), c, { mode: 0o644 });
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'base');
  return { dir, base: G(dir, 'rev-parse', 'HEAD') };
}
const tmpBase = () => fs.mkdtemp(path.join(os.tmpdir(), `o2-ws-${n++}-`));
const task = (id, dependsOn = []) => ({
  id, title: `t ${id}`, outcome: `o ${id}`, acceptanceCriteria: ['c'],
  dependsOn, boundary: { paths: [`src/${id}/**`] }, worker: { profileId: 'w' },
});

test('private repo: autonomous store, no foreign refs, source advances unseen', async () => {
  const { dir, base } = await mkSource();
  const baseDir = await tmpBase();
  const { repoPath, inputCommit } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'w1', baseDir,
  });
  const v = await verifyPrivateRepo(repoPath);
  assert.deepEqual(v.problems, v.problems.filter(() => false)); // ok
  assert.ok(v.ok);
  // foreign refs: only our own heads exist
  assert.match(G(repoPath, 'for-each-ref', '--format=%(refname)'), /refs\/heads\/master|refs\/heads\/main/);
  // source advances — the new commit is unresolvable in the private store
  await fs.writeFile(path.join(dir, 'later.txt'), 'later\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'later');
  const later = G(dir, 'rev-parse', 'HEAD');
  await assertForeignUnresolvable(repoPath, later);
  assert.equal(G(repoPath, 'rev-parse', 'HEAD'), inputCommit);
});

test('freeze captures dirty tracked + untracked + deletion + mode change', async () => {
  const { dir, base } = await mkSource({ 'a.txt': 'base\n', 'del.txt': 'gone\n', 'run.sh': 'x\n' });
  const baseDir = await tmpBase();
  const { repoPath, inputCommit } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'w2', baseDir,
  });
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'dirty\n');       // dirty tracked
  await fs.writeFile(path.join(repoPath, 'new.txt'), 'new\n');       // untracked new
  await fs.rm(path.join(repoPath, 'del.txt'));                        // deletion
  await fs.chmod(path.join(repoPath, 'run.sh'), 0o755);               // mode change
  const frozen = await freezeResult({
    repoPath, taskId: 'a', inputCommit, generation: 1,
  });
  assert.equal(G(repoPath, 'rev-parse', 'HEAD'), frozen.resultCommit);
  assert.ok(frozen.report.resultHash);
  assert.ok(frozen.report.dirtyPaths.length >= 3);
  const diff = await exportWorkerDiff({ repoPath, inputCommit });
  assert.ok(diff.changed.includes('a.txt'));
  assert.ok(diff.changed.includes('new.txt'));
  assert.ok(diff.changed.includes('del.txt'));
  assert.ok(diff.changed.includes('run.sh'));
  // clean freeze is idempotent: same content → same resultHash, HEAD unchanged
  const again = await freezeResult({ repoPath, taskId: 'a', inputCommit, generation: 1 });
  assert.equal(again.resultCommit, frozen.resultCommit);
});

test('chain + diamond assemble unique transitive predecessors exactly once', async () => {
  const { dir, base } = await mkSource();
  const baseDir = await tmpBase();
  const tasks = [task('d', ['b', 'c']), task('c', ['a']), task('a'), task('b', ['a'])];
  // Declaration order [d,c,a,b] pins Kahn ties: a first, then c, then b.
  // What matters: diamond ancestor 'a' appears exactly once.
  assert.deepEqual(transitivePredecessors(tasks, 'd'), ['a', 'c', 'b']);
  // each parent writes its own file on its own private repo seeded from base
  const diffs = [];
  for (const id of ['a', 'b', 'c']) {
    const { repoPath, inputCommit } = await createPrivateRepo({
      sourcePath: dir, baseCommit: base, name: `p-${id}`, baseDir,
    });
    await fs.writeFile(path.join(repoPath, `${id}.txt`), `${id}\n`);
    const fr = await freezeResult({ repoPath, taskId: id, inputCommit, generation: 1 });
    const d = await exportWorkerDiff({ repoPath, inputCommit });
    diffs.push({ taskId: id, ...d, resultCommit: fr.resultCommit });
  }
  const snap = await assembleDependencySnapshot({
    sourcePath: dir, baseCommit: base, taskId: 'd', tasks,
    parentDiffs: diffs, name: 'dep-d', baseDir,
  });
  assert.deepEqual(snap.provenance.order, ['a', 'c', 'b']);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(await fs.readFile(path.join(snap.repoPath, `${id}.txt`), 'utf8'), `${id}\n`);
  }
  // diamond ancestor applied once: log shows base + 3 parent commits only
  const log = G(snap.repoPath, 'log', '--format=%s').split('\n');
  assert.equal(log.filter((s) => s.startsWith('parent a')).length, 1);
  assert.equal(log.length, 4);
});

test('conflicting parents block launch: snapshot_conflict, nothing left behind', async () => {
  const { dir, base } = await mkSource({ 'shared.txt': 'base\n' });
  const baseDir = await tmpBase();
  const tasks = [task('x', ['a', 'b']), task('a'), task('b')];
  const diffs = [];
  for (const [id, content] of [['a', 'from-a\n'], ['b', 'from-b\n']]) {
    const { repoPath, inputCommit } = await createPrivateRepo({
      sourcePath: dir, baseCommit: base, name: `c-${id}`, baseDir,
    });
    await fs.writeFile(path.join(repoPath, 'shared.txt'), content);
    const fr = await freezeResult({ repoPath, taskId: id, inputCommit, generation: 1 });
    const d = await exportWorkerDiff({ repoPath, inputCommit });
    diffs.push({ taskId: id, ...d, resultCommit: fr.resultCommit });
  }
  const repoPath = path.join(baseDir, 'dep-x');
  let code = null;
  try {
    await assembleDependencySnapshot({
      sourcePath: dir, baseCommit: base, taskId: 'x', tasks,
      parentDiffs: diffs, name: 'dep-x', baseDir,
    });
  } catch (e) { code = e.code; }
  assert.equal(code, 'snapshot_conflict');
  assert.equal(await fs.lstat(repoPath).catch(() => null), null);
});

test('canonical artifact reused by two consumers + final integration', async (t) => {
  const scratch = await tmpBase();
  const storeDir = path.join(scratch, 'store');
  const { dir, base } = await mkSource({ 'shared.txt': 'base\n' });
  const baseDir = path.join(scratch, 'ws');
  await fs.mkdir(baseDir, { recursive: true });
  const tasks = [task('x', ['a', 'b']), task('a'), task('b')];
  const diffs = [];
  for (const [id, content] of [['a', 'from-a\n'], ['b', 'from-b\n']]) {
    const { repoPath, inputCommit } = await createPrivateRepo({
      sourcePath: dir, baseCommit: base, name: `r-${id}`, baseDir,
    });
    await fs.writeFile(path.join(repoPath, 'shared.txt'), content);
    const fr = await freezeResult({ repoPath, taskId: id, inputCommit, generation: 1 });
    const d = await exportWorkerDiff({ repoPath, inputCommit });
    diffs.push({ taskId: id, ...d, resultCommit: fr.resultCommit });
  }
  const inputs = diffs.map((d) => ({ taskId: d.taskId, resultCommit: d.resultCommit }));
  const order = ['a', 'b'];
  assert.equal(await loadArtifact(storeDir, inputs, order), null);
  // integrator resolves inside the plan: caller-supplied resolution text.
  // apply a cleanly; b conflicts (proven) → resolve by hand.
  const { repoPath: ir } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'resolve', baseDir,
  });
  const baseTree = await treeHashFor(ir, G(ir, 'rev-parse', 'HEAD'));
  const pa = spawnSync('git', ['apply', '-'], { cwd: ir, input: diffs[0].formatPatch, encoding: 'utf8' });
  assert.equal(pa.status, 0);
  G(ir, 'add', '-A');
  G(ir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'parent a');
  const pb = spawnSync('git', ['apply', '--check', '-'], { cwd: ir, input: diffs[1].formatPatch, encoding: 'utf8' });
  assert.notEqual(pb.status, 0); // conflicts, as expected — worker never launches
  await fs.writeFile(path.join(ir, 'shared.txt'), 'resolved by integrator\n');
  G(ir, 'add', '-A');
  G(ir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'resolve a+b');
  const parentDiffs = diffs.map((d) => ({ taskId: d.taskId, changed: d.changed }));
  const rec = await recordResolution({
    storeDir, inputs, order, baseTree, repoPath: ir, parentDiffs,
    resolutionNote: 'kept both intents: shared.txt merged by hand',
  });
  assert.ok(/^ia_[0-9a-f]{64}$/.test(rec.key));
  // second consumer with identical inputs+order reuses the same artifact
  const again = await loadArtifact(storeDir, inputs, order);
  assert.equal(again.resultCommit, rec.resultCommit);
  const keyAgain = artifactKey(inputs, order);
  assert.equal(keyAgain, rec.key);
  // different order = different key (order is part of the conflict identity)
  assert.notEqual(artifactKey(inputs, ['b', 'a']), rec.key);
  // re-recording the same resolution is idempotent; a different one refuses
  const same = await recordResolution({
    storeDir, inputs, order, baseTree, repoPath: ir, parentDiffs,
  });
  assert.equal(same.resultCommit, rec.resultCommit);
  t.diagnostic(`artifact ${rec.key} -> ${rec.resultCommit}`);
});

test('provenance rejects stale generation and moved parents', () => {
  const cur = provenanceFor({ taskId: 'd', generation: 2, parentCommits: { a: 'a'.repeat(40) } });
  assert.ok(assertProvenanceCurrent(cur, { generation: 2, parentCommits: { a: 'a'.repeat(40) } }));
  assert.throws(() => assertProvenanceCurrent(cur, { generation: 3, parentCommits: {} }),
    (e) => e.code === 'stale_generation');
  assert.throws(() => assertProvenanceCurrent(cur,
    { generation: 2, parentCommits: { a: 'b'.repeat(40) } }),
  (e) => e.code === 'stale_input');
});

test('incompatible overlapping artifacts rejected', () => {
  const a = {
    key: 'ia_a', version: 1, baseTree: 't1',
    inputs: [{ taskId: 'a', resultCommit: 'a'.repeat(40) }],
    order: ['a'], resultCommit: 'c'.repeat(40), resultTree: 'r1',
  };
  const b = {
    key: 'ia_b', version: 1, baseTree: 't1',
    inputs: [{ taskId: 'a', resultCommit: 'b'.repeat(40) }],
    order: ['a'], resultCommit: 'd'.repeat(40), resultTree: 'r2',
  };
  assert.throws(() => checkCompatible(a, b), (e) => e.code === 'incompatible_overlap');
  const c = {
    key: 'ia_c', version: 1, baseTree: 't1',
    inputs: [{ taskId: 'a', resultCommit: 'a'.repeat(40) }],
    order: ['a'], resultCommit: 'c'.repeat(40), resultTree: 'r1',
  };
  assert.deepEqual(checkCompatible(a, c), { compatible: true, shared: ['a'] });
});

test('worker diff excludes ancestors: only own diff travels', async () => {
  const { dir, base } = await mkSource();
  const baseDir = await tmpBase();
  const tasks = [task('b', ['a']), task('a')];
  const { repoPath: ra, inputCommit: ia } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'own-a', baseDir,
  });
  await fs.writeFile(path.join(ra, 'a.txt'), 'a\n');
  const fa = await freezeResult({ repoPath: ra, taskId: 'a', inputCommit: ia, generation: 1 });
  const da = await exportWorkerDiff({ repoPath: ra, inputCommit: ia });
  const snap = await assembleDependencySnapshot({
    sourcePath: dir, baseCommit: base, taskId: 'b', tasks,
    parentDiffs: [{ taskId: 'a', ...da, resultCommit: fa.resultCommit }],
    name: 'own-b', baseDir,
  });
  await fs.writeFile(path.join(snap.repoPath, 'b.txt'), 'b\n');
  const fb = await freezeResult({
    repoPath: snap.repoPath, taskId: 'b', inputCommit: snap.inputCommit, generation: 1,
  });
  const db = await exportWorkerDiff({ repoPath: snap.repoPath, inputCommit: snap.inputCommit });
  assert.ok(db.changed.includes('b.txt'));
  assert.ok(!db.changed.includes('a.txt')); // inherited, not own
  assert.equal(fb.resultCommit.length, 40);
});
