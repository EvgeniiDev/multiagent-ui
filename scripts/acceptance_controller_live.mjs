// Explicit opt-in proof against the existing authenticated Compose controller.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnvironmentConfig } from '../server/execution/environment/env-config.mjs';
import { createControllerClient } from '../server/execution/environment/controller-client.mjs';
import { profileDigest } from '../server/execution/environment/agent-profile.mjs';
assert(process.argv.includes('--live'), 'Pass --live for real Docker controller acceptance');
const evidence = path.resolve(process.env.ACP_ACCEPTANCE_DIR || '.agent-tmp/controller-live');
await fs.mkdir(evidence, {recursive:true,mode:0o700});
const config = await loadEnvironmentConfig('deploy/execution/environment.config.json',{view:'client',env:process.env});
const client = createControllerClient({socketPath:config.environment.socketPath,tokenFile:config.environment.tokenFile});
const source = '/home/hermes/projects/acp-acceptance-20261003';
const projectRoot = 'acp-acceptance-20261003';
const snapshotSha = execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const id = `ctl-${Date.now().toString(36)}`;
const profile = {schemaVersion:1,profileId:'live-controller-proof',pi:{version:'0.85.1'},image:'worker',provider:'zen-relay',model:'zen-relay/muse-spark-1.3-contributor-free',thinking:'low',skills:[],extensions:[],tools:['read','bash','write'],search:{enabled:false,provider:null,params:{}},launch:{progress:'none',extraFlags:[]},systemPromptFile:null};
const workers=[],receipts=[];
const record = name=>{receipts.push(name);console.log(`PASS ${name}`);};
const prepare = async(n,materials)=>{const workerId=`w-${id}-${n}`;workers.push(workerId);return client.workerPrepare({workerId,attemptId:`${id}-${n}`,role:'swarm-participant',profileId:profile.profileId,profile,profileDigest:profileDigest(profile),prompt:'Controller acceptance, no model launched.',materials});};
try {
 const canonical = await client.canonicalPrepare({canonicalId:id,projectRoot,snapshotSha});
 assert(canonical.ok);const dir=path.join(canonical.canonical.hostDir,'worktree');
 const first=await client.swarmSnapshot({canonicalId:id,generation:0});assert(first.materials.snapshotId);record('registered immutable base snapshot');
 await prepare('one',{...first.materials,scratch:{id:`${id}-one`,mount:'/work/scratch'}});
 await assert.rejects(client.swarmSnapshot({canonicalId:id,generation:1}));record('running namespace blocks snapshot');
 await client.workerFreeze(workers[0]);let status=await client.workerStatus(workers[0]);assert.equal(status.state,'paused');assert.equal(status.namespaceAlive,true);record('real Docker pause leaves live namespace');
 await fs.writeFile(path.join(dir,'binary.dat'),Buffer.from([0,255,128,4]));await fs.writeFile(path.join(dir,'executable.sh'),'#!/bin/sh\necho snapshot\n');await fs.chmod(path.join(dir,'executable.sh'),0o755);await fs.unlink(path.join(dir,'README.md'));
 const changed=await client.swarmSnapshot({canonicalId:id,generation:1});assert.notEqual(changed.treeSha,first.treeSha);assert.equal((await client.swarmSnapshot({canonicalId:id,generation:1})).snapshotSha,changed.snapshotSha);record('dirty binary/new/deleted/mode tree snapshotted and replayed');
 await fs.writeFile(path.join(dir,'extra.txt'),'changed');await assert.rejects(client.swarmSnapshot({canonicalId:id,generation:1}));await fs.unlink(path.join(dir,'extra.txt'));record('same generation rejects changed current tree');
 await client.workerThaw(workers[0]);assert.equal((await client.workerStatus(workers[0])).state,'running');record('real Docker unpause verified');
 await client.workerStop(workers[0]);assert(['stopped','gone'].includes((await client.workerStatus(workers[0])).state));
 const stoppedRecord=(await client.registrySnapshot()).registry.workers[workers[0]];
 assert(stoppedRecord.resourcesReleasedAt && stoppedRecord.state==='gone');
 assert((await fs.stat(stoppedRecord.workerDir)).isDirectory());
 const netGone=(()=>{try{execFileSync('docker',['network','inspect',stoppedRecord.netName],{stdio:'pipe'});return false;}catch(e){return e.status===1;}})();
 assert(netGone,'terminal worker network must be physically absent');
 record('terminal worker releases Docker network and preserves artifact directory and identity record');
 await prepare('two',{...changed.materials,scratch:{id:`${id}-two`,mount:'/work/scratch'}});
 const check=await client.exec({workerId:workers[1],template:'debug',cwdKey:'home',args:["node -e \"const fs=require('fs');if(fs.existsSync('/work/project/README.md'))throw Error('deleted file');if(fs.readFileSync('/work/project/binary.dat').toString('hex')!=='00ff8004')throw Error('binary');if((fs.statSync('/work/project/executable.sh').mode&511)!==493)throw Error('executable mode');if((fs.statSync('/work/project/binary.dat').mode&511)!==420)throw Error('regular mode');fs.writeFileSync('/work/scratch/own','ok');try{fs.writeFileSync('/work/project/forbidden','bad');process.exit(3)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e}console.log('SNAPSHOT-AND-SCRATCH-OK')\""],timeoutMs:30000});assert.equal(check.exitCode,0,JSON.stringify(check));assert(check.stdout.includes('SNAPSHOT-AND-SCRATCH-OK'));record('actual new worker gets byte-exact readonly snapshot with canonical 0644/0755 modes and private writable scratch');
 await client.workerFreeze(workers[1]);await client.workerStop(workers[1]);assert.equal((await client.workerStatus(workers[1])).state,'gone');await assert.rejects(client.workerThaw(workers[1]));record('paused worker cancellation proves gone and never resurrects');
 await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify({status:'pass',canonicalId:id,snapshotSha:changed.snapshotSha,treeSha:changed.treeSha,receipts},null,2));
} catch(error){await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify({status:'fail',error:error.message,receipts},null,2));throw error;}
finally {for(const workerId of workers)await client.workerRemove(workerId).catch(()=>{});}
