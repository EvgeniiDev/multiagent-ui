// scripts/test_o2_repair_probes.mjs — RED probes for the 8 blockers + final-review findings.
// Each test MUST FAIL against the current implementation (proving the bug),
// then PASS after the fix. Real git temp trees, no mocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createPrivateRepo, exportWorkerDiff, treeHashFor,
} from '../server/execution/orchestrator/workspaces.mjs';
import {
  assembleDependencySnapshot, freezeResult, assertProvenanceCurrent, provenanceFor,
} from '../server/execution/orchestrator/snapshots.mjs';
import {
  recordResolution, loadArtifact, checkCompatible,
} from '../server/execution/orchestrator/integration-artifacts.mjs';

const G = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};
let n = 100;
async function mkSource(files = { 'a.txt': 'base\n' }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `o2p-src-${n++}-`));
  G(dir, 'init', '-q');
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    if (Buffer.isBuffer(c)) await fs.writeFile(path.join(dir, p), c);
    else await fs.writeFile(path.join(dir, p), c, { mode: 0o644 });
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'base');
  return { dir, base: G(dir, 'rev-parse', 'HEAD') };
}
const tmpBase = () => fs.mkdtemp(path.join(os.tmpdir(), `o2p-ws-${n++}-`));
const task = (id, dependsOn = []) => ({
  id, title: `t ${id}`, outcome: `o ${id}`, acceptanceCriteria: ['c'],
  dependsOn, boundary: { paths: [`src/${id}/**`] }, worker: { profileId: 'w' },
});
async function parentDiffOnBase(dir, base, baseDir, id, mutate) {
  const { repoPath, inputCommit } = await createPrivateRepo({ sourcePath: dir, baseCommit: base, name: `pp-${id}-${n++}`, baseDir });
  await mutate(repoPath);
  const fr = await freezeResult({ repoPath, taskId: id, inputCommit, generation: 1 });
  const d = await exportWorkerDiff({ repoPath, inputCommit });
  return { taskId: id, ...d, resultCommit: fr.resultCommit };
}

test('B1: unchanged base accepted as resolution drops parent content', async () => {
  const { dir, base } = await mkSource({ 'f.txt': 'base\n' });
  const baseDir = await tmpBase();
  const da = await parentDiffOnBase(dir, base, baseDir, 'a', async (rp) => {
    await fs.writeFile(path.join(rp, 'f.txt'), 'from-a\n');
  });
  // resolution repo = PRISTINE base (integrator forgot to apply anything)
  const { repoPath: ir } = await createPrivateRepo({ sourcePath: dir, baseCommit: base, name: 'b1-res', baseDir });
  const baseCommit = G(ir, 'rev-parse', 'HEAD');
  const baseTree = await treeHashFor(ir, baseCommit);
  const inputs = [{ taskId: 'a', inputCommit: da.inputCommit, resultCommit: da.resultCommit }];
  let code = null;
  try {
    await recordResolution({
      storeDir: path.join(baseDir, 'store'), inputs, order: ['a'], baseTree, baseCommit,
      repoPath: ir, parentDiffs: [da],
    });
  } catch (e) { code = e.code; }
  assert.equal(code, 'resolution_incomplete', 'pristine base must be rejected: it drops parent content');
});

test('B2: legitimate parent deletion accepted', async () => {
  const { dir, base } = await mkSource({ 'gone.txt': 'bye\n', 'keep.txt': 'k\n' });
  const baseDir = await tmpBase();
  const da = await parentDiffOnBase(dir, base, baseDir, 'a', async (rp) => {
    await fs.rm(path.join(rp, 'gone.txt'));
  });
  assert.ok(da.changed.includes('gone.txt'));
  const { repoPath: ir } = await createPrivateRepo({ sourcePath: dir, baseCommit: base, name: 'b2-res', baseDir });
  const baseCommit = G(ir, 'rev-parse', 'HEAD');
  const baseTree = await treeHashFor(ir, baseCommit);
  const ap = spawnSync('git', ['apply', '-'], { cwd: ir, input: da.formatPatch, encoding: 'utf8' });
  assert.equal(ap.status, 0);
  G(ir, 'add', '-A');
  G(ir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apply a (deletion)');
  const rec = await recordResolution({
    storeDir: path.join(baseDir, 'store'),
    inputs: [{ taskId: 'a', inputCommit: da.inputCommit, resultCommit: da.resultCommit }], order: ['a'], baseTree, baseCommit,
    repoPath: ir, parentDiffs: [da],
  });
  assert.ok(rec.resultCommit);
});

test('B3: parallel conflicting recordResolution — exactly one wins', async () => {
  const { dir, base } = await mkSource({ 'f.txt': 'base\n' });
  const baseDir = await tmpBase();
  // Both parents change f.txt differently: a TRUE same-path conflict. Each
  // resolution carries NEITHER side verbatim but a hand-merge (declared in
  // resolvedPaths) — both are VALID but byte-different: exactly one
  // publisher must win, the other gets artifact_mismatch.
  const da = await parentDiffOnBase(dir, base, baseDir, 'a', async (rp) => {
    await fs.writeFile(path.join(rp, 'f.txt'), 'from-a\n');
  });
  const db = await parentDiffOnBase(dir, base, baseDir, 'b', async (rp) => {
    await fs.writeFile(path.join(rp, 'f.txt'), 'from-b\n');
  });
  const resolutionBases = new Map();
  const mkRes = async (name, fContent) => {
    const { repoPath: ir } = await createPrivateRepo({ sourcePath: dir, baseCommit: base, name, baseDir });
    resolutionBases.set(ir, G(ir, 'rev-parse', 'HEAD'));
    const ap = spawnSync('git', ['apply', '-'], { cwd: ir, input: da.formatPatch, encoding: 'utf8' });
    assert.equal(ap.status, 0); // a applies; b conflicts -> hand-merge below
    await fs.writeFile(path.join(ir, 'f.txt'), fContent);
    G(ir, 'add', '-A');
    G(ir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `res ${name}`);
    return ir;
  };
  const ir1 = await mkRes('b3-r1', 'merged one\n');
  const ir2 = await mkRes('b3-r2', 'merged two\n');
  const baseCommit = resolutionBases.get(ir1);
  const baseTree = await treeHashFor(ir1, baseCommit);
  const storeDir = path.join(baseDir, 'store');
  const inputs = [
    { taskId: 'a', inputCommit: da.inputCommit, resultCommit: da.resultCommit },
    { taskId: 'b', inputCommit: db.inputCommit, resultCommit: db.resultCommit },
  ];
  const pd = [
    da,
    db,
  ];
  const results = await Promise.allSettled([
    recordResolution({ storeDir, inputs, order: ['a', 'b'], baseTree, baseCommit, repoPath: ir1, parentDiffs: pd, resolvedPaths: ['f.txt'] }),
    recordResolution({ storeDir, inputs, order: ['a', 'b'], baseTree, baseCommit: resolutionBases.get(ir2), repoPath: ir2, parentDiffs: pd, resolvedPaths: ['f.txt'] }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, `exactly one publisher wins, got ${ok.length}: ${JSON.stringify(bad.map((b) => b.reason?.code + ' ' + b.reason?.message))}`);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.code, 'artifact_mismatch');
  // canonical artifact intact: re-read equals winner
  const re = await loadArtifact(storeDir, inputs, ['a', 'b']);
  assert.equal(re.resultCommit, ok[0].value.resultCommit);
});

test('B4: checkCompatible rejects extending-but-differing resolutions', async () => {
  const t = 't'.repeat(64);
  const a = {
    key: 'ia_a', version: 1, baseTree: t,
    inputs: [{ taskId: 'a', resultCommit: 'a'.repeat(40) }, { taskId: 'b', resultCommit: 'b'.repeat(40) }],
    order: ['a', 'b'], resultCommit: 'c'.repeat(40), resultTree: 'r1',
  };
  const b = {
    key: 'ia_b', version: 1, baseTree: 'u'.repeat(64),
    inputs: [{ taskId: 'a', resultCommit: 'a'.repeat(40) }],
    order: ['a'], resultCommit: 'd'.repeat(40), resultTree: 'r2',
  };
  assert.throws(() => checkCompatible(a, b), (e) => e.code === 'incompatible_overlap');
});

test('B5: empty own diff dependency accepted as no-op', async () => {
  const { dir, base } = await mkSource();
  const baseDir = await tmpBase();
  const tasks = [task('b', ['a']), task('a')];
  const { repoPath: ra, inputCommit: ia } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'b5-a', baseDir,
  });
  const fa = await freezeResult({ repoPath: ra, taskId: 'a', inputCommit: ia, generation: 1 });
  const da = await exportWorkerDiff({ repoPath: ra, inputCommit: ia });
  assert.deepEqual(da.changed, []);
  const snap = await assembleDependencySnapshot({
    sourcePath: dir, baseCommit: base, taskId: 'b', tasks,
    parentDiffs: [{ taskId: 'a', ...da, resultCommit: fa.resultCommit }],
    name: 'b5-b', baseDir,
  });
  assert.equal(snap.provenance.order.length, 1);
  assert.equal(snap.parents.length, 1);
});

test('B6: binary exported diff replays', async () => {
  const { dir, base } = await mkSource({ 'bin.dat': 'text\n' });
  const baseDir = await tmpBase();
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0xfe]);
  const { repoPath: ra, inputCommit: ia } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'b6-a', baseDir,
  });
  await fs.writeFile(path.join(ra, 'bin.dat'), bin);
  const fa = await freezeResult({ repoPath: ra, taskId: 'a', inputCommit: ia, generation: 1 });
  const da = await exportWorkerDiff({ repoPath: ra, inputCommit: ia });
  assert.ok(da.formatPatch.includes('GIT binary patch') || da.formatPatch.includes('Binary'),
    'binary patch must carry binary payload, not a stub');
  const snap = await assembleDependencySnapshot({
    sourcePath: dir, baseCommit: base, taskId: 'b', tasks: [task('b', ['a']), task('a')],
    parentDiffs: [{ taskId: 'a', ...da, resultCommit: fa.resultCommit }],
    name: 'b6-b', baseDir,
  });
  assert.deepEqual(Buffer.from(await fs.readFile(path.join(snap.repoPath, 'bin.dat'))), bin);
});

test('B7: freeze validates input SHA ancestor before staging + reports modes/deletion/binary', async () => {
  const { dir, base } = await mkSource({ 'a.txt': 'base\n', 'del.txt': 'gone\n', 'run.sh': 'x\n' });
  const baseDir = await tmpBase();
  const { repoPath, inputCommit } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'b7', baseDir,
  });
  const before = G(repoPath, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(repoPath, 'dirty.txt'), 'dirty\n');
  let code = null;
  try {
    await freezeResult({ repoPath, taskId: 'a', inputCommit: 'd'.repeat(40), generation: 1 });
  } catch (e) { code = e.code; }
  assert.ok(['commit_invalid', 'diff_not_ancestor'].includes(code), `got ${code}`);
  assert.equal(G(repoPath, 'rev-parse', 'HEAD'), before, 'repo untouched on invalid input');
  assert.equal(G(repoPath, 'status', '--porcelain').includes('dirty.txt'), true);
  // valid freeze reports modes/deletion/binary
  const bin = Buffer.from([0x00, 0x01, 0x02, 0xff]);
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'changed\n');
  await fs.rm(path.join(repoPath, 'del.txt'));
  await fs.chmod(path.join(repoPath, 'run.sh'), 0o755);
  await fs.writeFile(path.join(repoPath, 'blob.bin'), bin);
  // make blob.bin binary in git terms (already is: NUL byte); freeze
  const fr = await freezeResult({ repoPath, taskId: 'a', inputCommit, generation: 1 });
  const det = fr.report.fileDetails ?? [];
  const byPath = new Map(det.map((d) => [d.path, d]));
  assert.equal(byPath.get('del.txt')?.op, 'deleted');
  assert.ok(byPath.get('run.sh')?.modeAfter === '100755' || byPath.get('run.sh')?.op === 'modechange',
    JSON.stringify(byPath.get('run.sh')));
  assert.equal(byPath.get('blob.bin')?.binary, true);
});

test('B8: removed parent fails provenance', async () => {
  const rec = provenanceFor({ taskId: 'd', generation: 1, parentCommits: { a: 'a'.repeat(40), b: 'b'.repeat(40) } });
  assert.throws(() => assertProvenanceCurrent(rec, { generation: 1, parentCommits: { a: 'a'.repeat(40) } }),
    (e) => e.code === 'stale_input');
  // and the reverse: record missing a parent that is now current
  const rec2 = provenanceFor({ taskId: 'd', generation: 1, parentCommits: { a: 'a'.repeat(40) } });
  assert.throws(() => assertProvenanceCurrent(rec2, { generation: 1, parentCommits: { a: 'a'.repeat(40), b: 'b'.repeat(40) } }),
    (e) => e.code === 'stale_input');
});

// ---- final-review additional blockers ----

test('R1: repeated freeze same task/gen/input/resultCommit is resultHash-stable', async () => {
  const { dir, base } = await mkSource({ 'a.txt': 'base\n' });
  const baseDir = await tmpBase();
  const { repoPath, inputCommit } = await createPrivateRepo({
    sourcePath: dir, baseCommit: base, name: 'r1', baseDir,
  });
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'v1\n');
  const f1 = await freezeResult({ repoPath, taskId: 'a', inputCommit, generation: 1 });
  const f2 = await freezeResult({ repoPath, taskId: 'a', inputCommit, generation: 1 });
  assert.equal(f2.resultCommit, f1.resultCommit);
  assert.equal(f2.resultHash, f1.resultHash, 'same stable fields must hash identically');
  assert.equal(f2.report.resultHash, f1.report.resultHash);
});

test('R3: corrupt artifact file fails closed, never reads as absent', async () => {
  const { dir, base } = await mkSource({ 'f.txt': 'base\n' });
  const baseDir = await tmpBase();
  const da = await parentDiffOnBase(dir, base, baseDir, 'a', async (rp) => {
    await fs.writeFile(path.join(rp, 'f.txt'), 'from-a\n');
  });
  const { repoPath: ir } = await createPrivateRepo({ sourcePath: dir, baseCommit: base, name: 'r3-res', baseDir });
  const baseCommit = G(ir, 'rev-parse', 'HEAD');
  const baseTree = await treeHashFor(ir, baseCommit);
  const ap = spawnSync('git', ['apply', '-'], { cwd: ir, input: da.formatPatch, encoding: 'utf8' });
  assert.equal(ap.status, 0);
  G(ir, 'add', '-A');
  G(ir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apply a');
  const storeDir = path.join(baseDir, 'store');
  const inputs = [{ taskId: 'a', inputCommit: da.inputCommit, resultCommit: da.resultCommit }];
  const rec = await recordResolution({
    storeDir, inputs, order: ['a'], baseTree, baseCommit, repoPath: ir,
    parentDiffs: [da],
  });
  await fs.writeFile(path.join(storeDir, `${rec.key}.json`), '{corrupt json');
  let code = null;
  try { await loadArtifact(storeDir, inputs, ['a']); } catch (e) { code = e.code; }
  assert.equal(code, 'artifact_corrupt');
  // and a second recordResolution must NOT silently overwrite the corrupt canonical
  let code2 = null;
  try {
    await recordResolution({
      storeDir, inputs, order: ['a'], baseTree, baseCommit, repoPath: ir,
      parentDiffs: [da],
    });
  } catch (e) { code2 = e.code; }
  assert.equal(code2, 'artifact_corrupt');
});

test('R4: loadArtifact validates types/hashes and recomputed key', async () => {
  const scratch = await tmpBase();
  const inputs = [{ taskId: 'a', resultCommit: 'a'.repeat(40) }];
  const { artifactKey } = await import('../server/execution/orchestrator/integration-artifacts.mjs');
  const key = artifactKey(inputs, ['a']);
  // wrong types
  await fs.writeFile(path.join(scratch, `${key}.json`),
    JSON.stringify({ version: 1, kind: 'integration-artifact', key, inputs, order: ['a'], baseTree: 't'.repeat(64), resolution: null, resultCommit: 'not-a-sha', resultTree: 'r', createdAt: 'x' }));
  await assert.rejects(loadArtifact(scratch, inputs, ['a']), (e) => e.code === 'artifact_corrupt');
  // key mismatch: record whose inputs recompute to a different key
  const other = [{ taskId: 'a', resultCommit: 'b'.repeat(40) }];
  await fs.writeFile(path.join(scratch, `${key}.json`),
    JSON.stringify({ version: 1, kind: 'integration-artifact', key, inputs: other, order: ['a'], baseTree: 't'.repeat(64), resolution: null, resultCommit: 'c'.repeat(40), resultTree: 't'.repeat(64), createdAt: 'x' }));
  await assert.rejects(loadArtifact(scratch, inputs, ['a']), (e) => e.code === 'artifact_corrupt');
});

test('R5: checkCompatible superset+different baseTree still rejects without explicit supersedes', async () => {
  const mk = (extraInputs, order, tree, base) => ({
    key: 'ia_x', version: 1, baseTree: base,
    inputs: extraInputs, order, resultCommit: 'c'.repeat(40), resultTree: tree,
  });
  const sup = mk(
    [{ taskId: 'a', resultCommit: 'a'.repeat(40) }, { taskId: 'b', resultCommit: 'b'.repeat(40) }],
    ['a', 'b'], 'r-new', 'u'.repeat(64));
  sup.supersedes = ['ia_y'];
  const old = mk([{ taskId: 'a', resultCommit: 'a'.repeat(40) }], ['a'], 'r-old', 't'.repeat(64));
  old.key = 'ia_y';
  // explicit supersedes of the exact other key => compatible
  assert.deepEqual(checkCompatible(sup, old).compatible, true);
  // same shape but NO supersedes => reject even though superset + different baseTree
  const sup2 = mk(
    [{ taskId: 'a', resultCommit: 'a'.repeat(40) }, { taskId: 'b', resultCommit: 'b'.repeat(40) }],
    ['a', 'b'], 'r-new', 'u'.repeat(64));
  sup2.key = 'ia_z';
  assert.throws(() => checkCompatible(sup2, old), (e) => e.code === 'incompatible_overlap');
});
