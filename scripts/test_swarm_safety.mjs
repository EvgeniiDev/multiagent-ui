import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditBroker, sha256Bytes } from '../server/execution/swarm/edit-broker.mjs';
const lease = { runId: 'r', participantId: 'a', attemptId: 'at', turnId: 't', generation: 1 };
const proof = { owner: 'a', reservedBy: null, version: 1 };
const command = (id, ops, extra = {}) => ({ commandId: id, lease, phase: 'implement', ops, ownership: Object.fromEntries(ops.flatMap(o => [o.path, o.to].filter(Boolean)).map(p => [p, proof])), ...extra });
const gate = { currentLease: () => ({ ...lease, phase: 'implement', terminal: false }), ownershipFor: () => proof, decisionsAgreed: true };
async function fixture(t, files = { 'a': 'old', 'b': 'second' }) {
    const root = await fs.mkdtemp(join(tmpdir(), 'swarm-safety-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const tree = join(root, 'tree');
    await fs.mkdir(tree);
    for (const [p, data] of Object.entries(files)) {
        await fs.mkdir(join(tree, p, '..'), { recursive: true });
        await fs.writeFile(join(tree, p), data);
    }
    const events = [], barriers = [];
    const hooks = { readerIdentities: () => ['reader'], onFreeze: () => barriers.push('freeze'), onThaw: () => barriers.push('thaw'), onEvent: e => events.push(e) };
    return { root, tree, events, barriers, hooks, open: extra => createEditBroker({ rootDir: join(root, 'journal-root'), treeDir: tree, hooks, ...extra }) };
}
test('SIGKILL between every mutation kind and its marker restores exact beforeimages', async (t) => {
  for(const op of [
    {kind:'write',path:'a',bytes:'NEW'}, {kind:'delete',path:'a'},
    {kind:'rename',path:'a',to:'b'}, {kind:'chmod',path:'a',mode:0o100755},
    {kind:'create',path:'new',bytes:'NEW'},
  ]) {
    const f = await fixture(t);
    const beforeMode = (await fs.stat(join(f.tree,'a'))).mode & 0o777;
    const moduleUrl = new URL('../server/execution/swarm/edit-broker.mjs', import.meta.url).href;
    const src = `import {promises as fs} from 'node:fs';import {createEditBroker} from ${JSON.stringify(moduleUrl)};const original=fs.rename;fs.rename=async(...args)=>{if(args[1].endsWith('applied-0.json'))process.kill(process.pid,'SIGKILL');return original(...args)};const b=createEditBroker({rootDir:${JSON.stringify(join(f.root, 'journal-root'))},treeDir:${JSON.stringify(f.tree)},hooks:{readerIdentities:()=>[],onFreeze:()=>{},onThaw:()=>{}}});await b.submit(${JSON.stringify(command('kill', [op], {allowOverwrite:true}))},{currentLease:()=>(${JSON.stringify({ ...lease, phase: 'implement', terminal: false })}),ownershipFor:()=>(${JSON.stringify(proof)}),decisionsAgreed:true});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', src], { timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL');
    const recovery = await f.open().recover();
    assert.deepEqual(recovery.blocked, []);
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'old');
    assert.equal(await fs.readFile(join(f.tree, 'b'), 'utf8'), 'second');
    assert.equal((await fs.stat(join(f.tree, 'a'))).mode & 0o777, beforeMode);
    assert.equal(await fs.access(join(f.tree, 'new')).then(()=>true,()=>false),false);
  }
});
test('index failure after commit never rolls back a committed result', async (t) => {
    const f = await fixture(t);
    const b = f.open();
    const orig = fs.rename;
    let fail = true;
    fs.rename = async (...args) => { if (fail && args[1] === join(f.root, 'journal-root', 'seen.json'))
        throw Error('index unavailable'); return orig(...args); };
    t.after(() => { fs.rename = orig; });
    const cmd = command('commit', [{ kind: 'write', path: 'a', bytes: 'NEW' }]);
    await assert.rejects(b.submit(cmd, gate));
    fail = false;
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'NEW');
    const replay = await b.submit(cmd, gate);
    assert.equal(replay.status, 'applied');
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'NEW');
    assert.equal(new Set(f.events.filter(e => e.kind === 'applied').map(e => e.eventId)).size, 1);
});
test('partial apply retains a physical barrier until deterministic recovery', async (t) => {
    const f = await fixture(t);
    const at = new Set(['after_op_0']);
    const b = f.open({ fsFail: { at } });
    await assert.rejects(b.submit(command('partial', [{ kind: 'write', path: 'a', bytes: 'NEW' }, { kind: 'write', path: 'b', bytes: 'NEW' }]), gate));
    assert.equal(b.isFrozen(), true);
    assert.equal(f.barriers.includes('thaw'), false);
    at.clear();
    const rec = await b.recover();
    assert.deepEqual(rec.blocked, []);
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'old');
    assert.equal(b.isFrozen(), false);
});
test('failed rollback blocks submit and stop across process restart', async (t) => {
    const f = await fixture(t);
    const at = new Set(['after_op_0', 'rollback']);
    const b = f.open({ fsFail: { at } });
    await assert.rejects(b.submit(command('partial', [{ kind: 'write', path: 'a', bytes: 'NEW' }]), gate));
    const restarted = f.open({ fsFail: { at } });
    const rec = await restarted.recover();
    assert.equal(rec.blocked.length, 1);
    assert.equal(restarted.isFrozen(), true);
    await assert.rejects(restarted.submit(command('other', [{ kind: 'write', path: 'b', bytes: 'wrong' }]), gate), e => e.code === 'recovery_blocked');
    await assert.rejects(restarted.stop(), e => e.code === 'recovery_blocked');
    at.clear();
    assert.deepEqual((await restarted.recover()).blocked, []);
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'old');
});
test('ancestor swap cannot redirect edits to an outside tree', async (t) => {
    const f = await fixture(t, { 'd/sub/a': 'old' });
    const outside = join(f.root, 'outside');
    await fs.mkdir(join(outside, 'sub'), { recursive: true });
    await fs.writeFile(join(outside, 'sub/a'), 'victim');
    let swapped = false;
    const b = f.open({ hooks: { ...f.hooks, onFreeze: async () => { await fs.rename(join(f.tree, 'd'), join(f.tree, 'backup')); await fs.symlink(outside, join(f.tree, 'd')); swapped = true; } } });
    try {
        await b.submit(command('swap', [{ kind: 'write', path: 'd/sub/a', bytes: 'NEW' }]), gate);
    }
    catch (e) {
        assert.ok(e);
    }
    assert.equal(swapped, true);
    assert.equal(await fs.readFile(join(outside, 'sub/a'), 'utf8'), 'victim');
});
test('rollback preserves binary bytes and an overwritten rename destination', async (t) => {
    const raw = Buffer.from([0, 255, 128, 13, 10]);
    const f = await fixture(t, { a: raw, b: Buffer.from([254, 1]), c: 'third' });
    const b = f.open({ fsFail: { at: new Set(['delete']) } });
    await assert.rejects(b.submit(command('binary', [{ kind: 'rename', path: 'a', to: 'b' }, { kind: 'delete', path: 'c' }], { allowOverwrite: true }), gate));
    assert.deepEqual(await fs.readFile(join(f.tree, 'a')), raw);
    assert.deepEqual(await fs.readFile(join(f.tree, 'b')), Buffer.from([254, 1]));
    assert.equal(await fs.readFile(join(f.tree, 'c'), 'utf8'), 'third');
});
test('missing authority and forged owner/version proofs fail closed', async (t) => {
    const f = await fixture(t);
    const b = f.open();
    const cmd = command('auth', [{ kind: 'write', path: 'a', bytes: 'NEW' }]);
    await assert.rejects(b.submit(cmd));
    await assert.rejects(b.submit(cmd, { ...gate, currentLease: () => null }));
    await assert.rejects(b.submit(cmd, { ...gate, currentLease: () => ({ ...lease, runId: 'other' }) }));
    await assert.rejects(b.submit(cmd, { ...gate, ownershipFor: () => ({ ...proof, version: 2 }) }));
    await assert.rejects(b.submit(cmd, { ...gate, ownershipFor: () => ({ ...proof, owner: 'b' }) }));
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'old');
});
test('expected executable mode is enforced before edits', async (t) => {
    const f = await fixture(t);
    const b = f.open();
    await assert.rejects(b.submit(command('mode', [{ kind: 'write', path: 'a', bytes: 'NEW', expected: { mode: 0o100755 } }]), gate), e => e.code === 'stale_mode');
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'old');
});
test('file and directory fsync precede applied publication, including tree and journal entries', async (t) => {
    const f = await fixture(t);
    const synced = [];
    const original = fs.open;
    fs.open = async (...args) => { const handle = await original(...args); const sync = handle.sync.bind(handle); handle.sync = async () => { const st = await handle.stat(); if (st.isDirectory())
        synced.push(await fs.realpath(`/proc/self/fd/${handle.fd}`)); return sync(); }; return handle; };
    t.after(() => { fs.open = original; });
    const b = f.open({ hooks: { ...f.hooks, onEvent: e => { if (e.kind === 'applied') {
                assert.ok(synced.includes(f.tree));
                assert.ok(synced.includes(join(f.root, 'journal-root', 'results')));
                assert.ok(synced.some(p => p.includes('/journal/txn-')));
            } } } });
    await b.submit(command('fsync', [{ kind: 'write', path: 'a', bytes: 'NEW' }]), gate);
});
test('failure syncing result directory after rename preserves committed bytes and recovers', async (t) => {
    const f = await fixture(t);
    const original = fs.open;
    let fail = true;
    fs.open = async (...args) => { const h = await original(...args); const sync = h.sync.bind(h); h.sync = async () => { const st = await h.stat(); if (fail && st.isDirectory()) {
        const p = await fs.realpath(`/proc/self/fd/${h.fd}`);
        if (p.includes('/journal/txn-') && await fs.access(join(p, 'result.json')).then(() => true, () => false)) {
            throw Error('directory sync failed');
        }
    } return sync(); }; return h; };
    t.after(() => { fs.open = original; });
    const b = f.open(), cmd = command('dirsync', [{ kind: 'write', path: 'a', bytes: 'NEW' }]);
    await assert.rejects(b.submit(cmd, gate));
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'NEW');
    assert.equal(b.isFrozen(), true);
    fail = false;
    assert.equal((await b.submit(cmd, gate)).status, 'applied');
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'NEW');
});
test('trusted lease phase and decision eligibility cannot be omitted', async (t) => {
    const f = await fixture(t);
    const b = f.open(), cmd = command('eligible', [{ kind: 'write', path: 'a', bytes: 'NEW' }]);
    await assert.rejects(b.submit(cmd, { ...gate, currentLease: () => ({ ...lease, terminal: false }) }), e => e.code === 'bad_phase');
    await assert.rejects(b.submit(cmd, { ...gate, decisionsAgreed: undefined }), e => e.code === 'decisions_pending');
    await assert.rejects(b.submit(cmd, { ...gate, currentLease: () => ({ ...lease, terminal: false, phase: 'coordinate' }) }), e => e.code === 'bad_phase');
    assert.equal(await fs.readFile(join(f.tree, 'a'), 'utf8'), 'old');
});

test('SIGKILL before atomic replacement removes broker staging files during recovery',async t=>{
 const f=await fixture(t),moduleUrl=new URL('../server/execution/swarm/edit-broker.mjs',import.meta.url).href;
 const src=`import {promises as fs} from 'node:fs';import {createEditBroker} from ${JSON.stringify(moduleUrl)};const rename=fs.rename;fs.rename=async(...args)=>{if(args[1].startsWith('/proc/self/fd/')&&args[1].endsWith('/a'))process.kill(process.pid,'SIGKILL');return rename(...args)};const b=createEditBroker({rootDir:${JSON.stringify(join(f.root,'journal-root'))},treeDir:${JSON.stringify(f.tree)},hooks:{readerIdentities:()=>[],onFreeze:()=>{},onThaw:()=>{}}});await b.submit(${JSON.stringify(command('stagekill',[{kind:'write',path:'a',bytes:'NEW'}]))},{currentLease:()=>(${JSON.stringify({...lease,phase:'implement',terminal:false})}),ownershipFor:()=>(${JSON.stringify(proof)}),decisionsAgreed:true});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',src],{timeout:15000});assert.equal(child.signal,'SIGKILL');assert.deepEqual((await f.open().recover()).blocked,[]);assert.deepEqual((await fs.readdir(f.tree)).sort(),['a','b']);assert.equal(await fs.readFile(join(f.tree,'a'),'utf8'),'old');
});
