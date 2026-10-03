// Deterministic real-Git cache and explicit integration authorization tests.
// These do not claim live container/model acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { immutableDependencyBasis, createOrchDriver } from '../server/execution/orchestrator/controller.mjs';
import { parseIntegrationDeclarations, workerMaterials } from '../server/execution/orchestrator/prompt.mjs';
import * as ws from '../server/execution/orchestrator/workspaces.mjs';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const frame = (v) => '```acp-orchestrator-integration\n'+JSON.stringify(v)+'\n```\nSTATUS: DONE';

test('assembler explicit declarations fail closed on malformed, duplicate or unsafe paths', () => {
  const valid = { additionalPaths: ['src/new.js'], resolvedPaths: ['src/shared.js'] };
  assert.deepEqual(parseIntegrationDeclarations(frame(valid)), valid);
  assert.deepEqual(parseIntegrationDeclarations(JSON.stringify(valid)), valid);
  for (const input of [undefined, 'STATUS: DONE', '{}', frame(valid)+'\n'+frame(valid),
    frame({...valid, additionalPaths:['../escape']}), frame({...valid, resolvedPaths:['a//b']}),
    frame({...valid, additionalPaths:['.git/config']}), frame({...valid, additionalPaths:['x','x']}),
    frame({...valid, additionalPaths:['src/shared.js']}), frame({...valid, inferred:true})]) {
    assert.throws(() => parseIntegrationDeclarations(input));
  }
});

test('worker materials preserve immutable candidate descriptor without mutable canonical seeding', () => {
  const materials = workerMaterials({projectRoot:'registered', snapshotSha:'a'.repeat(40), snapshotId:'immutable', canonicalId:'task-canonical'});
  assert.equal(materials.snapshotId,'immutable');
  assert.equal(materials.canonicalId,'task-canonical');
  assert.equal(materials.fromCanonical,undefined);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'orch-basis-repair-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const sourcePath = path.join(dir,'source'), baseDir = path.join(dir,'projects'), cacheDir=path.join(dir,'cache');
  await fs.mkdir(sourcePath); await fs.mkdir(baseDir);
  git(sourcePath,'init','-q');
  await fs.writeFile(path.join(sourcePath,'base.txt'),'base\n');
  git(sourcePath,'add','-A');git(sourcePath,'-c','user.name=t','-c','user.email=t@t','commit','-qm','base');
  const baseCommit=git(sourcePath,'rev-parse','HEAD');
  const identity={runId:'run-1',taskId:'child',sourcePath,baseCommit,order:['parent'],parents:[{taskId:'parent',resultCommit:baseCommit,patchSha256:'b'.repeat(64)}]};
  let calls=0;
  const assemble=async(name)=>{calls++;const r=await ws.createPrivateRepo({sourcePath,baseCommit,name,baseDir});return {...r,inputCommit:git(r.repoPath,'rev-parse','HEAD')};};
  return { args:{identity,baseDir,cacheDir,storage:ws,assemble}, calls:()=>calls };
}

test('published dependency basis is stable across retries and concurrent creators',async(t)=>{
  const f=await fixture(t);
  const [a,b]=await Promise.all([immutableDependencyBasis(f.args),immutableDependencyBasis(f.args)]);
  assert.deepEqual(a,b,'atomic publication selects exactly one immutable basis');
  const calls=f.calls();
  assert.deepEqual(await immutableDependencyBasis({...f.args,assemble:()=>{throw Error('must reuse');}}),a);
  assert.equal(f.calls(),calls);
  const other=await immutableDependencyBasis({...f.args,identity:{...f.args.identity,order:['other']}});
  assert.notEqual(other.key,a.key,'exact ancestor order is part of identity');
  assert.notEqual(other.projectRoot,a.projectRoot);
});

test('published basis rejects changed repository and tampered identity instead of rebuilding',async(t)=>{
  const f=await fixture(t), a=await immutableDependencyBasis(f.args);
  await fs.writeFile(path.join(a.repoPath,'base.txt'),'untrusted change\n');
  await assert.rejects(immutableDependencyBasis(f.args),/was changed/);
  await fs.writeFile(path.join(a.repoPath,'base.txt'),'base\n');
  const file=path.join(f.args.cacheDir,`${a.key}.json`);
  await fs.writeFile(file,JSON.stringify({...a,identity:{...a.identity,taskId:'wrong'}}));
  await assert.rejects(immutableDependencyBasis(f.args),/identity mismatch/);
});

test('unpublished crashed assembly never blocks or masquerades as a durable basis',async(t)=>{
  const f=await fixture(t);
  await assert.rejects(immutableDependencyBasis({...f.args,assemble:async(name)=>{await f.args.assemble(name);throw Error('crash before publication');}}),/crash/);
  const a=await immutableDependencyBasis(f.args);
  assert.equal(git(a.repoPath,'rev-parse','HEAD'),a.inputCommit);
  assert.equal((await fs.readdir(f.args.cacheDir)).filter(n=>n.endsWith('.json')).length,1);
});


test('historical terminal rows cannot complete stop without physical namespace proof', async () => {
  const run = { id: 'run-historical', status: 'stopping', phase: 'decompose',
    orchestrator: { tasks: [], graph: {} },
    attempts: [{ id: 'old-attempt', role: 'decomposer', status: 'completed' }] };
  const commands = [];
  let proven = false;
  const runtime = { forAttempt: () => ({
    workerStatus: async () => proven ? { ok: true, state: 'stopped' }
      : { ok: false, error: { code: 'unknown_worker' } },
    stopWorker: async () => ({ ok: true }),
  }) };
  const driver = createOrchDriver({ runtime, getRun: async () => run,
    self: () => ({ runnerId: 'runner', instanceId: 'instance' }),
    send: async (_, type, payload) => {
      commands.push(type);
      if (type === 'orch_worker_settled') run.attempts[0].namespace = { state: payload.state };
      if (type === 'complete_run') run.status = payload.status;
    } });
  assert.equal(await driver.drive({ cardId: 'c' }, run), 'namespace_settlement_pending');
  assert.equal(run.status, 'stopping');
  assert.deepEqual(commands, [], 'unknown registry and stop success do not prove absence');
  proven = true;
  assert.equal(await driver.drive({ cardId: 'c' }, run), 'stopped');
  assert.deepEqual(commands, ['orch_worker_settled','complete_run']);
  assert.equal(run.status, 'cancelled');
});
