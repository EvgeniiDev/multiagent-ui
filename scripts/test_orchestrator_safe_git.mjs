import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {safeGit} from '../server/execution/orchestrator/safe-git.mjs';
const native=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
test('host Git never executes worker hooks, fsmonitor or arbitrary clean filters',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'git-proof-'));const repo=path.join(root,'repo');await fs.mkdir(repo);
 try{
  native(repo,'init','-q');native(repo,'config','user.name','test');native(repo,'config','user.email','test@local');
  await fs.writeFile(path.join(repo,'base'),'base');native(repo,'add','-A');native(repo,'commit','-qm','base');
  const marker=path.join(root,'executed');const script=path.join(root,'worker-script');await fs.writeFile(script,`#!/bin/sh\ntouch '${marker}'\ncat\n`);await fs.chmod(script,0o755);
  native(repo,'config','core.fsmonitor',script);native(repo,'config','filter.arbitrary.clean',script);native(repo,'config','filter.arbitrary.required','true');
  await fs.writeFile(path.join(repo,'.git/hooks/pre-commit'),`#!/bin/sh\ntouch '${marker}'\n`);await fs.chmod(path.join(repo,'.git/hooks/pre-commit'),0o755);
  await fs.writeFile(path.join(repo,'.gitattributes'),'*.dat filter=arbitrary\n');await fs.writeFile(path.join(repo,'new.dat'),Buffer.from([0,255,10,13]));
  const status=await safeGit(repo,['status','--porcelain']);assert.equal(status.code,0);assert.equal((await safeGit(repo,['add','-A'])).code,0);
  const commit=await safeGit(repo,['-c','user.name=trusted','-c','user.email=trusted@local','commit','-qm','frozen']);assert.equal(commit.code,0,commit.stderr);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  const bytes=await safeGit(repo,['show','HEAD:new.dat'],{binary:true});assert.deepEqual(bytes.stdout,Buffer.from([0,255,10,13]));
  assert.match(native(repo,'-c','core.fsmonitor=false','log','-1','--format=%s'),/frozen/);
  assert.equal((await safeGit(repo,['status','--porcelain'])).stdout,'');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('safe Git reads a linked source worktree without its hooks/configuration',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'git-linked-'));const repo=path.join(root,'repo'),linked=path.join(root,'linked');await fs.mkdir(repo);
 try{native(repo,'init','-q');await fs.writeFile(path.join(repo,'file'),'source');native(repo,'add','-A');native(repo,'-c','user.name=test','-c','user.email=test@local','commit','-qm','base');native(repo,'worktree','add','-q','-b','linked',linked);
 const head=native(repo,'rev-parse','HEAD');assert.equal((await safeGit(linked,['rev-parse','HEAD'])).stdout.trim(),head);
 const archive=await safeGit(linked,['archive',head],{binary:true});assert.equal(archive.code,0);assert(archive.stdout.length>512);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
