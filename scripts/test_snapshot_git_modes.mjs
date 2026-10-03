import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitArchiveExtract} from '../deploy/execution/tarx.mjs';
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
test('worker snapshot export matches canonical Git file modes and bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'snapshot-modes-'));
 try{
  const repo=join(root,'repo');await mkdir(join(repo,'nested'),{recursive:true});git(repo,'init','-q');
  const bytes=Buffer.from([0,255,128,10]);await writeFile(join(repo,'nested','binary'),bytes);await chmod(join(repo,'nested','binary'),0o644);
  await writeFile(join(repo,'run.sh'),'#!/bin/sh\nprintf ok\\n\n');await chmod(join(repo,'run.sh'),0o755);
  git(repo,'add','-A');git(repo,'-c','user.name=test','-c','user.email=test@example.invalid','commit','-qm','fixture');const sha=git(repo,'rev-parse','HEAD');
  for(const [name,source,config] of [['immutable',join(root,'snapshot.git'),null],['configured',repo,'0000']]){
   if(name==='immutable')execFileSync('git',['clone','-q','--bare',repo,source]);
   if(config)git(source,'config','tar.umask',config);
   const output=join(root,name);await mkdir(output);await gitArchiveExtract(source,sha,output);
   for(const row of git(source,'ls-tree','-r',sha).split('\n')){
    const [meta,file]=row.split('\t');const mode=parseInt(meta.split(' ')[0],8);
    assert.equal((await stat(join(output,file))).mode & 0o777,mode & 0o777,`${name}: ${file} must preserve Git mode`);
   }
   assert.deepEqual(await readFile(join(output,'nested','binary')),bytes);
   assert.equal(await readFile(join(output,'run.sh'),'utf8'),await readFile(join(repo,'run.sh'),'utf8'));
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
