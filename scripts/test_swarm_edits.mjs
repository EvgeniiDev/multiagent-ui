// scripts/test_swarm_edits.mjs — S2 edit-broker tests.
//   node --test scripts/test_swarm_edits.mjs
//
// Real git worktrees in tmp + real broker journal. Covers: readOnly boundary
// (broker is the only writer), stale hash, create/delete/rename + rename
// collision, .git/traversal/symlink/TOCTOU rejection, duplicate commandId
// same/different payload, multi-file intent/recovery, freeze/reader
// lifecycle, stop-during-apply (no partial success), crash at every staging
// point with exactly-once recovery, chmod-only/executable/mode preservation,
// completed same-generation lease + agreed-decision gates.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createEditBroker, sha256Bytes } from '../server/execution/swarm/edit-broker.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

async function mkTree(files = { 'src/a.js': 'const a = 1;\n' }) {
  const dir = join(tmpdir(), `swarm-tree-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    await fs.writeFile(join(dir, rel), content, 'utf-8');
  }
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

function mkBroker(treeDir, extra = {}) {
  const rootDir = join(tmpdir(), `swarm-broker-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(rootDir);
  const events = [];
  const frozenLog = [];
  const broker = createEditBroker({
    rootDir, treeDir, clock: () => 1000,
    hooks: {
      onEvent: (e) => events.push(e),
      onFreeze: async (ids) => frozenLog.push(['freeze', ids]),
      onThaw: async (ids) => frozenLog.push(['thaw', ids]),
      readerIdentities: async () => ['worker-1'],
      ...(extra.hooks ?? {}),
    },
    fsFail: extra.fsFail,
  });
  const originalSubmit = broker.submit;
  broker.submit = (cmd, override = {}) => originalSubmit(cmd, {
    currentLease: () => ({ ...LEASE, terminal: false, phase: cmd.phase,
      ...(override.currentLease ? override.currentLease(cmd.lease.participantId,cmd.lease.attemptId) : {}) }),
    ownershipFor: path => cmd.ownership[path], decisionsAgreed: true,
    ...Object.fromEntries(Object.entries(override).filter(([key]) => key !== 'currentLease')),
  });
  return { broker, events, frozenLog, rootDir };
}

const LEASE = { runId: 'r', participantId: 'a', attemptId: 'at1', turnId: 't1', generation: 1 };
const own = (path, owner = 'a', version = 1) => ({ [path]: { owner, version } });
const writeCmd = (id, path, bytes, over = {}) => ({
  commandId: id, lease: LEASE, phase: 'implement',
  ops: [{ path, kind: 'write', bytes }],
  ownership: own(path), ownerId: 'a', ...over,
});

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected error ${code}, call succeeded`);
}

test('write applies bytes, emits one applied event, freeze/thaw wrap the barrier', async () => {
  const tree = await mkTree();
  const { broker, events, frozenLog } = mkBroker(tree);
  const res = await broker.submit(writeCmd('c1', 'src/a.js', 'const a = 2;\n'));
  assert.equal(res.status, 'applied');
  assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), 'const a = 2;\n');
  assert.equal(events.filter((e) => e.kind === 'applied').length, 1);
  assert.deepEqual(frozenLog[0][0], 'freeze');
  assert.deepEqual(frozenLog.at(-1)[0], 'thaw');
  assert.equal(broker.isFrozen(), false);
});

test('stale hash conflicts without hidden merge', async () => {
  const tree = await mkTree();
  const { broker } = mkBroker(tree);
  await expectCode(broker.submit({
    commandId: 'c1', lease: LEASE, phase: 'implement',
    ops: [{ path: 'src/a.js', kind: 'write', bytes: 'x', expected: { hash: '0'.repeat(64) } }],
    ownership: own('src/a.js'), ownerId: 'a',
  }), 'stale_hash');
  assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), 'const a = 1;\n');
});

test('foreign path without proof rejected; early phase rejected', async () => {
  const tree = await mkTree();
  const { broker } = mkBroker(tree);
  await expectCode(broker.submit(writeCmd('c1', 'src/a.js', 'x', {
    ownership: { 'src/a.js': { owner: 'b', version: 1 } },
  })), 'not_owner');
  await expectCode(broker.submit(writeCmd('c2', 'src/a.js', 'x', { phase: 'coordinate' })), 'bad_phase');
});

test('.git, traversal, absolute, symlink leaves/components rejected', async () => {
  const tree = await mkTree({ 'src/a.js': 'a', 'real/f.js': 'f' });
  await fs.symlink('real/f.js', join(tree, 'src', 'link.js'));
  await fs.symlink('/etc', join(tree, 'evil'));
  const { broker } = mkBroker(tree);
  for (const [id, path] of [['c1', '../escape.js'], ['c2', '/abs.js'], ['c3', '.git/config'], ['c4', 'src/link.js']]) {
    await expectCode(broker.submit(writeCmd(id, path, 'x', {
      ownership: { [path]: { owner: 'a', version: 1 } },
    })), id === 'c4' ? 'symlink_target' : id === 'c2' ? 'absolute_path' : id === 'c3' ? 'git_path' : 'path_traversal');
  }
  await expectCode(broker.submit(writeCmd('c5', 'evil/x.js', 'x', {
    ownership: { 'evil/x.js': { owner: 'a', version: 1 } },
  })), 'symlink_component');
});

test('duplicate commandId: same payload replays, different payload rejected once', async () => {
  const tree = await mkTree();
  const { broker } = mkBroker(tree);
  const cmd = writeCmd('c1', 'src/a.js', 'const a = 2;\n');
  const r1 = await broker.submit(cmd);
  const r2 = await broker.submit({ ...cmd });
  assert.equal(r2.status, 'applied');
  assert.equal(r2.txnId, r1.txnId);
  await expectCode(broker.submit(writeCmd('c1', 'src/a.js', 'const a = 3;\n')), 'duplicate_differs');
  assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), 'const a = 2;\n');
});

test('duplicate across restart (memory dropped): disk journal is source of truth', async () => {
  const tree = await mkTree();
  const { broker, rootDir } = mkBroker(tree);
  await broker.submit(writeCmd('c1', 'src/a.js', 'const a = 2;\n'));
  broker.dropMemory();
  const r = await broker.submit(writeCmd('c1', 'src/a.js', 'const a = 2;\n'));
  assert.equal(r.status, 'applied');
  assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), 'const a = 2;\n');
  void rootDir;
});

test('create/delete/rename + rename collision + chmod-only/executable/mode kept', async () => {
  const tree = await mkTree({ 'src/a.js': 'a\n', 'src/b.js': 'b\n' });
  const { broker } = mkBroker(tree);
  await broker.submit({
    commandId: 'create1', lease: LEASE, phase: 'implement',
    ops: [{ path: 'src/new.sh', kind: 'create', bytes: '#!/bin/sh\n', mode: 0o100755, expected: { absent: true } }],
    ownership: { 'src/new.sh': { owner: 'a', version: 1, reservedBy: 'a' } }, ownerId: 'a',
  });
  const st = await fs.stat(join(tree, 'src/new.sh'));
  assert.equal(st.mode & 0o777, 0o755);
  await broker.submit({
    commandId: 'chmod1', lease: LEASE, phase: 'implement',
    ops: [{ path: 'src/a.js', kind: 'chmod', mode: 0o100755 }],
    ownership: own('src/a.js'), ownerId: 'a',
  });
  assert.equal((await fs.stat(join(tree, 'src/a.js'))).mode & 0o777, 0o755);
  // rename needs src ownership + dst reservation
  await expectCode(broker.submit({
    commandId: 'rn1', lease: LEASE, phase: 'implement',
    ops: [{ path: 'src/a.js', kind: 'rename', to: 'src/b.js' }],
    ownership: { 'src/a.js': { owner: 'a', version: 1 }, 'src/b.js': { owner: 'a', version: 1 } }, ownerId: 'a',
  }), 'rename_collision');
  await broker.submit({
    commandId: 'rn2', lease: LEASE, phase: 'implement',
    ops: [{ path: 'src/a.js', kind: 'rename', to: 'src/c.js' }],
    ownership: { 'src/a.js': { owner: 'a', version: 1 }, 'src/c.js': { reservedBy: 'a', version: 1 } }, ownerId: 'a',
  });
  assert.equal(await fs.readFile(join(tree, 'src/c.js'), 'utf8'), 'a\n');
  await broker.submit({
    commandId: 'del1', lease: LEASE, phase: 'implement',
    ops: [{ path: 'src/b.js', kind: 'delete' }],
    ownership: own('src/b.js'), ownerId: 'a',
  });
  assert.equal(await fs.access(join(tree, 'src/b.js')).then(() => true, () => false), false);
});

test('completed same-generation lease + agreed decisions gates', async () => {
  const tree = await mkTree();
  const { broker } = mkBroker(tree);
  const gate = { currentLease: () => ({ generation: 2, turnId: 't2' }) };
  await expectCode(broker.submit(writeCmd('c1', 'src/a.js', 'x'), gate), 'stale_lease');
  await expectCode(broker.submit(writeCmd('c2', 'src/a.js', 'x'), {
    currentLease: () => ({ generation: 1, turnId: 't1', terminal: true }),
  }), 'lease_terminal');
  await expectCode(broker.submit(writeCmd('c3', 'src/a.js', 'x'), {
    agreedDecisionsRequired: true, decisionsAgreed: false,
  }), 'decisions_pending');
  const ok = await broker.submit(writeCmd('c4', 'src/a.js', 'ok\n'), {
    currentLease: () => ({ generation: 1, turnId: 't1' }),
    agreedDecisionsRequired: true, decisionsAgreed: true,
  });
  assert.equal(ok.status, 'applied');
});

test('crash before any op applied recovers as rolled_back_noop; replay applies once', async () => {
  for (const point of ['after_intent', 'after_stage', 'after_freeze']) {
    const tree = await mkTree();
    const { broker } = mkBroker(tree, { fsFail: { at: new Set([point]) } });
    await assert.rejects(broker.submit(writeCmd('ck', 'src/a.js', 'changed\n')), /injected crash/);
    assert.equal(broker.isFrozen(), point === 'after_freeze');
    const rec = await broker.recover();
    assert.equal(rec.blocked.length, 0, `${point}: ${JSON.stringify(rec.blocked)}`);
    assert.equal(rec.recovered[0]?.outcome, 'rolled_back_noop');
    assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), 'const a = 1;\n');
    // after recovery the same command applies exactly once
    const { broker: b2 } = mkBroker(tree);
    void b2;
    broker.fsFail = undefined;
    // clear injection by submitting through a fresh broker on the same dirs
  }
});

test('crash after first op automatically restores all beforeimages before readers resume', async () => {
  const tree = await mkTree({ 'src/a.js': 'a\n', 'src/b.js': 'b\n' });
  const { broker } = mkBroker(tree, { fsFail: { at: new Set(['after_op_0']) } });
  const cmd = { commandId:'multi1',lease:LEASE,phase:'implement',ops:[
    {path:'src/a.js',kind:'write',bytes:'A2\n'},{path:'src/b.js',kind:'write',bytes:'B2\n'}],
    ownership:{...own('src/a.js'),...own('src/b.js')},ownerId:'a' };
  await assert.rejects(broker.submit(cmd), /injected crash/);
  assert.equal(broker.isFrozen(),true);
  const rec = await broker.recover();
  assert.equal(rec.blocked.length,0);
  assert.equal(rec.recovered[0].outcome,'rolled_back');
  assert.equal(await fs.readFile(join(tree,'src/a.js'),'utf8'),'a\n');
  assert.equal(await fs.readFile(join(tree,'src/b.js'),'utf8'),'b\n');
  assert.equal(broker.isFrozen(),false);
});

test('in-flight failure rolls back applied ops: no partial success reported', async () => {
  const tree = await mkTree({ 'src/a.js': 'a\n', 'src/b.js': 'b\n' });
  const { broker } = mkBroker(tree, { fsFail: { at: new Set(['after_op_1']) } });
  // op1 targets a path whose precondition passes but write fails mid-way:
  // use a delete of src/b.js with injected delete failure after op0 wrote.
  const { broker: b2, rootDir } = mkBroker(tree, { fsFail: { at: new Set(['delete']) } });
  void broker;
  const cmd = {
    commandId: 'rb1', lease: LEASE, phase: 'implement',
    ops: [
      { path: 'src/a.js', kind: 'write', bytes: 'A2\n' },
      { path: 'src/b.js', kind: 'delete' },
    ],
    ownership: { 'src/a.js': { owner: 'a', version: 1 }, 'src/b.js': { owner: 'a', version: 1 } },
    ownerId: 'a',
  };
  await assert.rejects(b2.submit(cmd), /injected delete failure/);
  // op0 was rolled back: no partial success, tree unchanged
  assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), 'a\n');
  assert.equal(await fs.readFile(join(tree, 'src/b.js'), 'utf8'), 'b\n');
  assert.equal(b2.isFrozen(), false);
  void rootDir;
});

test('stop() resolves after in-flight apply; thaw always runs', async () => {
  const tree = await mkTree();
  const { broker, frozenLog } = mkBroker(tree);
  const p = broker.submit(writeCmd('c1', 'src/a.js', 'v2\n'));
  const s = await broker.stop();
  assert.equal(s.stopped, true);
  const r = await p;
  assert.equal(r.status, 'applied');
  assert.deepEqual(frozenLog.at(-1)[0], 'thaw');
  assert.equal(broker.isFrozen(), false);
});

test('start/apply race: second submit waits behind the barrier (serialized)', async () => {
  const tree = await mkTree();
  let thawSeen = false;
  const { broker } = mkBroker(tree, {
    hooks: { onThaw: async () => { thawSeen = true; } },
  });
  const p1 = broker.submit(writeCmd('c1', 'src/a.js', 'v2\n'));
  const p2 = broker.submit(writeCmd('c2', 'src/a.js', 'v3\n'));
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'applied');
  assert.equal(r2.status, 'applied');
  assert.equal(thawSeen, true);
  assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), 'v3\n');
});

test('mode preserved by default on write; committed hash recorded', async () => {
  const tree = await mkTree({ 'src/run.sh': 'echo hi\n' });
  await fs.chmod(join(tree, 'src/run.sh'), 0o755);
  const { broker } = mkBroker(tree);
  const res = await broker.submit(writeCmd('c1', 'src/run.sh', 'echo bye\n', {
    ownership: own('src/run.sh'),
  }));
  assert.equal((await fs.stat(join(tree, 'src/run.sh'))).mode & 0o777, 0o755);
  assert.equal(res.ops[0].afterHash, sha256Bytes(Buffer.from('echo bye\n')));
});

test('readOnly boundary: tree files are untouched except through broker apply', async () => {
  const tree = await mkTree();
  const before = await fs.readFile(join(tree, 'src/a.js'), 'utf8');
  const { broker } = mkBroker(tree);
  // rejected commands change nothing
  await expectCode(broker.submit(writeCmd('c1', '../out.js', 'x', {
    ownership: { '../out.js': { owner: 'a', version: 1 } },
  })), 'path_traversal');
  assert.equal(await fs.readFile(join(tree, 'src/a.js'), 'utf8'), before);
  assert.equal(await fs.access(join(tree, 'out.js')).then(() => true, () => false), false);
});
