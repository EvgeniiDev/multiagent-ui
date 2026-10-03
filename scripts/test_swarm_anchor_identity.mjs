import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, renameSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEditBroker } from '../server/execution/swarm/edit-broker.mjs';
const lease = { runId:'r', participantId:'p', attemptId:'a', turnId:'t', generation:1 };
const ownership = { owner:'p', version:1 };
const gate = { currentLease:()=>({...lease,phase:'implement',terminal:false}), ownershipFor:()=>ownership, decisionsAgreed:true };
const command = id => ({ commandId:id,lease,phase:'implement',ops:[{kind:'write',path:'d/sub/a',bytes:'NEW'}],ownership:{'d/sub/a':ownership} });
for (const kind of ['directory','symlink']) for (const point of ['freeze','write','after_mutation_0','before_result']) {
  test(`${kind} ancestor replacement at ${point} blocks persistently until original identity returns`, async t => {
    const root = await fs.mkdtemp(join(tmpdir(),'swarm-identity-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const tree = join(root,'tree'), outside = join(root,'outside'), state = join(root,'state');
    await fs.mkdir(join(tree,'d/sub'),{recursive:true}); await fs.writeFile(join(tree,'d/sub/a'),'old');
    await fs.mkdir(join(outside,'sub'),{recursive:true}); await fs.writeFile(join(outside,'sub/a'),'victim');
    let swapped = false, thaws = 0;
    const swap = () => {
      if (swapped) return; swapped = true;
      renameSync(join(tree,'d'),join(tree,'original'));
      if (kind === 'symlink') symlinkSync(outside,join(tree,'d'));
      else { mkdirSync(join(tree,'d/sub'),{recursive:true}); writeFileSync(join(tree,'d/sub/a'),'POISON'); }
    };
    const at = new Set(); at.has = p => { if (p === point) swap(); return false; };
    const hooks = { readerIdentities:()=>['worker'],onFreeze:()=>{if(point==='freeze')swap();},onThaw:()=>{thaws++;} };
    const open = () => createEditBroker({rootDir:state,treeDir:tree,hooks,fsFail:{at}});
    const broker = open();
    await assert.rejects(broker.submit(command('swap'),gate),e=>e.code==='anchor_identity_changed'||e.code==='recovery_blocked');
    assert.equal(broker.isFrozen(),true); assert.equal(thaws,0);
    assert.equal(await fs.readFile(join(tree,'d/sub/a'),'utf8'),kind==='symlink'?'victim':'POISON');
    assert.equal(await fs.readFile(join(outside,'sub/a'),'utf8'),'victim');
    const restarted = open();
    assert.equal((await restarted.recover()).blocked.length,1);
    await assert.rejects(restarted.stop(),{code:'recovery_blocked'});
    await assert.rejects(restarted.submit(command('later'),gate),{code:'recovery_blocked'});
    assert.equal(thaws,0);
    await fs.rm(join(tree,'d'),{recursive:true,force:true}); await fs.rename(join(tree,'original'),join(tree,'d'));
    assert.deepEqual((await restarted.recover()).blocked,[]);
    assert.equal(await fs.readFile(join(tree,'d/sub/a'),'utf8'),'old');
    assert.equal(restarted.isFrozen(),false);
    assert.equal((await restarted.submit(command('valid'),gate)).status,'applied');
  });
}
for (const scope of ['root','parent']) test(`pre-start crash recovery refuses a replaced ${scope} without a prior blocked marker`, async t => {
  const root = await fs.mkdtemp(join(tmpdir(),'swarm-identity-crash-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const tree = join(root,'tree'), state = join(root,'state');
  await fs.mkdir(join(tree,'d/sub'),{recursive:true}); await fs.writeFile(join(tree,'d/sub/a'),'old');
  const target = scope==='root' ? tree : join(tree,'d');
  const backup = scope==='root' ? join(root,'original') : join(tree,'original');
  let swapped = false, thaws = 0;
  const hooks = { readerIdentities:()=>['worker'], onThaw:()=>{thaws++;}, onFreeze:async()=>{
    if(swapped)return; swapped=true; await fs.rename(target,backup);
    await fs.mkdir(join(tree,'d/sub'),{recursive:true}); await fs.writeFile(join(tree,'d/sub/a'),'POISON');
  } };
  const broker = createEditBroker({rootDir:state,treeDir:tree,hooks,fsFail:{at:new Set(['after_freeze'])}});
  await assert.rejects(broker.submit(command('crash'),gate),/injected crash after_freeze/);
  const [txn] = await fs.readdir(broker.paths().journalDir);
  await assert.rejects(fs.stat(join(broker.paths().journalDir,txn,'started.json')),{code:'ENOENT'});
  await assert.rejects(fs.stat(join(broker.paths().journalDir,txn,'blocked.json')),{code:'ENOENT'});
  const restarted = createEditBroker({rootDir:state,treeDir:tree,hooks});
  assert.equal((await restarted.recover()).blocked.length,1);
  assert.equal(await fs.readFile(join(tree,'d/sub/a'),'utf8'),'POISON'); assert.equal(thaws,0);
  await fs.rm(target,{recursive:true,force:true}); await fs.rename(backup,target);
  assert.deepEqual((await restarted.recover()).blocked,[]);
  assert.equal(await fs.readFile(join(tree,'d/sub/a'),'utf8'),'old'); assert.equal(restarted.isFrozen(),false);
});
