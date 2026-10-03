// Durable legacy exhausted states travel through the actual authenticated
// state-service command queue. No listener, runtime launch, or live model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStateService} from '../server/execution/state-service.mjs';
import {createInternalClient} from '../server/execution/internal-transport.mjs';
import {saveAggregate,saveRun,loadAggregate} from '../server/execution/execution-store.mjs';
const SELF={runnerId:'runner',instanceId:'instance',pid:123,envKey:{uid:1000,gid:1000,hostname:'test',bootId:'boot',pidNs:'pidns'}};
async function fixture(status='verifying'){
 const root=await mkdtemp(join(tmpdir(),'orch-verify-budget-')),stateDir=join(root,'state');
 const svc=await createStateService({stateDir,env:{ROOT_DIR:root,PORCH_STEER_DIR:join(root,'steer'),ACP_WORKSPACE_DIR:join(root,'ws'),ACP_EXEC_TOKEN_UID:String(process.getuid()),ACP_EXEC_TOKEN_GID:String(process.getgid())},features:{orchestrator:true}});
 const request=async(method,path,body,headers)=>{const u=new URL(path,'http://test');return svc.request({method,path:u.pathname,query:u.searchParams,bodyText:body===undefined?undefined:JSON.stringify(body),headers});};
 await request('PUT','/api/state/board.json',{data:{version:2,cards:[{id:'card',title:'budget',stage:'development',status:'in_progress'}]}});
 const candidate={resultCommit:'a'.repeat(40),resultSha256:'b'.repeat(64),diffArtifactId:'diff'};
 const task={id:'task',title:'budget',dependsOn:[],worker:{profileId:'worker'},limits:{maxAttempts:2,maxFixCycles:2},state:{status,verifyUsed:2,attemptsUsed:2,fixesUsed:0,extraAttempts:0,extraFixes:0,attempts:['verify-1','verify-2'],resultCandidate:candidate,lastError:{attemptId:'verify-2',reason:'invalid verdict'},waiting:status==='blocked'?{reason:'grant'}:null}};
 const verifier={profileId:'verifier',profileDigest:'c'.repeat(64)};
 const run={id:'run_budget',mode:'orchestrator',status:'active',phase:'work',attempts:[1,2].map(n=>({id:`verify-${n}`,taskId:'task',role:'verifier',kind:'verify',n,status:'failed'})),events:[],artifacts:{},orchestrator:{owner:{...SELF,leaseUntil:9999999999999},limits:{verifyAttempts:2},verifier,workers:{worker:{profileId:'worker',profileDigest:'d'.repeat(64)}},tasks:[task],order:['task'],pendingActions:[],graph:{status:'active'},stats:{}}};
 const aggregate={schemaVersion:1,cardId:'card',enabledAt:0,controlRevision:0,internalRevision:0,currentRunId:run.id,runs:[run],commands:{},documents:{requirements:[],plan:[]},approvals:{},projectPath:root,cardSnapshot:{id:'card',title:'budget',stage:'development',status:'in_progress'}};
 await saveAggregate(stateDir,aggregate);await saveRun(stateDir,run);
 const client=createInternalClient({stateDir,transport:async({method,path,body,headers})=>{const r=await request(method,path,body,headers);return{status:r.status,body:r.json};}});
 let seq=0;const read=()=>loadAggregate(stateDir,'card');
 const internal=async(type,payload={})=>{const a=await read();return client.command('card',{commandId:`i-${++seq}`,type,payload:{runId:run.id,...SELF,...payload},expectedInternalRevision:a.internalRevision});};
 const grant=async(attempts=1)=>{const a=await read();return request('POST','/api/execution/cards/card/commands',{commandId:`g-${++seq}`,type:'orch_grant',expectedControlRevision:a.controlRevision,payload:{runId:run.id,taskId:'task',attempts}});};
 const begin=(id,kind='verify')=>internal('orch_task_begin',{taskId:'task',attemptId:id,kind,launch:{profileId:kind==='verify'?'verifier':'worker',profileDigest:(kind==='verify'?'c':'d').repeat(64),promptSha256:'e'.repeat(64),cwd:'/work/project',artifactsDir:'/work/attempt',attemptDir:'/work/attempt',inputCommit:'a'.repeat(40),snapshotOf:[]}});
 return {read,internal,grant,begin,candidate,cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('authenticated claim exposes legacy exhausted verifier and grant retains candidate with monotonic attempt',async()=>{
 const f=await fixture();try{
  await f.internal('orch_claim');let a=await f.read();assert.deepEqual(a.runs[0].orchestrator.pendingActions,[{type:'grant',taskId:'task',reason:'verify_attempts_exhausted'}]);
  const r=await f.grant(2);assert.equal(r.status,200,JSON.stringify(r.json));a=await f.read();let s=a.runs[0].orchestrator.tasks[0].state;
  assert.equal(s.status,'verifying');assert.equal(s.extraVerifyAttempts,2);assert.equal(s.verifyUsed,2);assert.equal(s.extraAttempts,0);assert.equal(s.attemptsUsed,2);assert.deepEqual(s.resultCandidate,f.candidate);assert.deepEqual(a.runs[0].orchestrator.pendingActions,[]);
  await f.begin('verify-3');a=await f.read();s=a.runs[0].orchestrator.tasks[0].state;assert.equal(s.verifyUsed,3);assert.equal(a.runs[0].attempts.at(-1).n,3);assert.equal(a.runs[0].attempts.at(-1).kind,'verify');assert.deepEqual(s.resultCandidate,f.candidate);
  await assert.rejects(f.begin('verify-4'),{code:'attempt_active'});
  await f.internal('resolve_attempt',{attemptId:'verify-3',outcome:'failed',reason:'invalid verdict'});
  a=await f.read();assert.equal(a.runs[0].orchestrator.tasks[0].state.status,'verifying');
  await f.begin('verify-4');await f.internal('resolve_attempt',{attemptId:'verify-4',outcome:'failed',reason:'invalid verdict'});
  a=await f.read();s=a.runs[0].orchestrator.tasks[0].state;assert.equal(s.verifyUsed,4);assert.equal(s.status,'blocked');assert.equal(s.waiting.budget,'verify');assert.equal(a.runs[0].orchestrator.pendingActions[0].reason,'verify_attempts_exhausted');
  await assert.rejects(f.begin('verify-5'),{code:'task_state'});
  assert.deepEqual(s.resultCandidate,f.candidate);
 }finally{await f.cleanup();}
});
test('blocked exhausted verifier grant resumes verification, ordinary worker grant stays work',async()=>{
 for(const verify of [true,false]){const f=await fixture('blocked');try{
  if(!verify){const a=await f.read();a.runs[0].orchestrator.tasks[0].state.resultCandidate=null;await saveAggregate(join((await f.read()).projectPath,'state'),a);}
  const r=await f.grant();assert.equal(r.status,200,JSON.stringify(r.json));const a=await f.read(),s=a.runs[0].orchestrator.tasks[0].state;
  assert.equal(s.status,verify?'verifying':'ready');assert.equal(s.extraAttempts,verify?0:1);assert.equal(s.extraVerifyAttempts??0,verify?1:0);assert.equal(s.verifyUsed,2);await f.begin(verify?'verify-3':'work-3',verify?'verify':'work');
 }finally{await f.cleanup();}}
});
test('claim and grant do not expose or increase verifier budget while an attempt is live',async()=>{
 const f=await fixture();try{const a=await f.read();a.runs[0].attempts[1].status='running';await saveAggregate(join(a.projectPath,'state'),a);await f.internal('orch_claim');assert.deepEqual((await f.read()).runs[0].orchestrator.pendingActions,[]);assert.equal((await f.grant()).status,409);}finally{await f.cleanup();}
});

test('a fix-budget grant retains ordinary worker semantics even with an old candidate',async()=>{
 const f=await fixture('blocked');try{
  let a=await f.read();let s=a.runs[0].orchestrator.tasks[0].state;s.lastError=null;s.fixesUsed=2;await saveAggregate(join(a.projectPath,'state'),a);
  const r=await f.grant();assert.equal(r.status,200,JSON.stringify(r.json));a=await f.read();s=a.runs[0].orchestrator.tasks[0].state;assert.equal(s.status,'ready');assert.equal(s.extraAttempts,1);assert.equal(s.extraVerifyAttempts??0,0);assert.deepEqual(s.resultCandidate,f.candidate);
 }finally{await f.cleanup();}
});
