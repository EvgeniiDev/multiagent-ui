// S4 scheduler adapter: all authority-changing effects are durable commands.
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createEditBroker} from './edit-broker.mjs';
import {LIVE,SWARM_ROLE,WRITE_PHASES,decisionsAgreedFor} from './domain.mjs';
import {buildSwarmPrompt,parseSwarmResult} from './prompt.mjs';
import {sha256,writeStagedArtifact} from '../execution-store.mjs';
import {gitRepo} from '../workspaces.mjs';
export function createSwarmDriver(deps) {
 const {runtime,send,getRun,getDocument,ensureWorkspace,self,stateDir,canLaunch=()=>true,adoptionProofFor=()=>null,now=Date.now,brokerFactory=createEditBroker}=deps;
 const _inflight=new Map(),brokers=new Map();let closed=false;
 const fresh=id=>getRun(id), own=r=>({...self(),runId:r.id});
 const command=(card,run,type,payload,key)=>send(card,type,{...own(run),...payload},`sw-${sha256(JSON.stringify([run.id,self().instanceId??null,type,key]))}`);
 const ours=o=>o?.runnerId===self().runnerId && (!o.instanceId||o.instanceId===self().instanceId);
 const launchable=r=>!closed&&canLaunch()&&!r.stopIntent&&['queued','active'].includes(r.status);
 const workerId=a=>a.launch?.workerId??runtime.workerIdForAttempt?.(a.id)??`w-${a.id}`;
 async function physical(ids,freeze,run=null){
  for(const id of ids){
   const att=run?.attempts.find(a=>a.id===id.attemptId&&workerId(a)===id.workerId);
   if(att?.namespace?.workerId===id.workerId&&att.namespace.settledAt!==undefined&&['stopped','gone'].includes(att.namespace.state))continue;
   const fn=freeze?runtime.freezeWorker:runtime.thawWorker;
   if(typeof fn!=='function')throw Object.assign(new Error('Physical worker barrier unavailable'),{code:'barrier_unwired'});
   let proof;
   try {proof=await fn.call(runtime,id.workerId);}
   catch(e){
    // A prior recovery may have recorded a reader before its admission.
    // Exclude it only when this owner has not started the exact attempt,
    // the durable launch record is absent, and the controller confirms
    // the exact worker is absent too. Unknown workers alone fail closed.
    if(e.code!=='unknown_worker'||att?.status!=='launching'||att.porchRunId||!ours(att.owner))throw e;
    const rec=await runtime.launchRecord?.(att.id),scoped=runtime.forAttempt?.(att.id);
    if(rec?.attemptId!==att.id||rec.missing!==true||typeof scoped?.workerStatus!=='function')throw e;
    let absent=false;
    try {absent=(await scoped.workerStatus())?.state==='gone';}
    catch(statusError){if(statusError.code!=='unknown_worker')throw statusError;absent=true;}
    if(!absent)throw e;
    continue;
   }
   if(proof?.ok!==true)throw Object.assign(new Error('Physical worker barrier unproven'),{code:'barrier_unproven'});
  }
 }
 async function broker(card,run){
  if(brokers.has(run.id))return brokers.get(run.id);
  if(!stateDir||typeof runtime.canonicalPrepare!=='function')throw Object.assign(new Error('Canonical/broker persistence unavailable'),{code:'swarm_unwired'});
  const canonicalId=run.swarm.canonicalId??`sw-${run.id}`;
  const cp=await runtime.canonicalPrepare({canonicalId,projectRoot:run.swarm.project.projectRoot,snapshotSha:run.baseCommit,branch:`acp/swarm/${canonicalId}`});
  if(!cp?.ok||!cp.canonical?.hostDir)throw Object.assign(new Error('Canonical unavailable'),{code:'canonical_unprepared'});
  const treeDir=join(cp.canonical.hostDir,'worktree');
  const b=brokerFactory({rootDir:join(stateDir,'swarm',run.id),treeDir,clock:now,hooks:{
   readerIdentities:async()=>{const r=await fresh(run.id);return r.attempts.filter(a=>LIVE.has(a.status)&&a.role===SWARM_ROLE).map(a=>({workerId:workerId(a),attemptId:a.id,runId:a.porchRunId}));},
   onFreeze:async ids=>{const r=await fresh(run.id);await physical(ids,true,r);await command(card,r,'swarm_freeze',{active:true,physicalConfirmed:true,identities:ids,reason:'broker'},`freeze-${r.swarm.epoch}-${sha256(JSON.stringify(ids)).slice(0,12)}`);},
   onThaw:async ids=>{const r=await fresh(run.id);await physical(ids,false,r);await command(card,r,'swarm_freeze',{active:false,physicalConfirmed:true},`thaw-${r.swarm.epoch}-${sha256(JSON.stringify(ids)).slice(0,12)}`);},
   onEvent:async e=>{const r=await fresh(run.id);if(!e.eventId||!(r.events??[]).some(old=>old.eventId===e.eventId||old.data?.eventId===e.eventId))await deps.recordEvent?.(card,r,`swarm_broker_${e.kind}`,{...e,eventId:e.eventId},e.attemptId);},
  }});
  const entry={b,canonicalId,treeDir};brokers.set(run.id,entry);return entry;
 }
 async function recover(card,run,entry){
  const recovery=await entry.b.recover();
  if(!recovery.blocked?.length)for(const receipt of recovery.recovered??[]){
   if(receipt.outcome!=='already_applied')continue;
   run=await fresh(run.id);const edit=Object.values(run.swarm.edits).find(e=>e.command.commandId===receipt.commandId&&e.status!=='applied');
   if(!edit)continue;
   // Only an existing committed journal entry reaches this replay. submit
   // verifies the complete payload against its durable idempotency hash.
   const result=await entry.b.submit(edit.command,{});
   await command(card,run,'swarm_apply_result',{editId:edit.id,result},`recovered-applied-${edit.id}`);
  }
  run=await fresh(run.id);await command(card,run,'swarm_freeze',{recovery},`recovery-${sha256(JSON.stringify(recovery))}-${self().instanceId??''}`);return !recovery.blocked?.length;
 }
 async function apply(card,run,att,id,ops,entry){
  if(!run.swarm.edits[id])await command(card,run,'swarm_apply_intent',{attemptId:att.id,editId:id,ops},`intent-${id}`);
  run=await fresh(run.id);const edit=run.swarm.edits[id];if(edit.status!=='pending')return;
  const gate={currentLease:async(pid,aid)=>{const r=await fresh(run.id),a=r.attempts.find(x=>x.id===aid),l=r.swarm.protocol.participants[pid]?.activeTurn;
   if(!a||!l||a.cancel||!LIVE.has(a.status)||r.stopIntent||now()>=a.deadlineAt)return null;
   return {runId:r.id,participantId:pid,attemptId:a.id,turnId:l.turnId,generation:l.generation,terminal:false,phase:r.swarm.phase};},
   ownershipFor:async path=>{const r=await fresh(run.id),f=r.swarm.protocol.files[path];return f?{owner:f.owner,reservedBy:f.reservedBy??null,version:f.version}:null;},
   decisionsAgreed:decisionsAgreedFor(run.swarm,Object.keys(edit.command.ownership)),phase:run.swarm.phase,runGeneration:att.generation};
  try {const result=await entry.b.submit(edit.command,gate);await command(card,run,'swarm_apply_result',{editId:id,result},`applied-${id}`);}
  catch(e){if(['recovery_blocked','crash_mid_apply','freeze_failed','thaw_failed'].includes(e.code))throw e;await command(card,run,'swarm_apply_result',{editId:id,error:{code:e.code??'broker_error',message:e.message}},`rejected-${id}`);throw e;}
 }
 async function drainWorker(card,run,att){
  if(att.namespace?.settledAt!==undefined)return true;const scoped=runtime.forAttempt?.(att.id);if(!scoped?.stopWorker||!scoped?.workerStatus)throw Object.assign(new Error('Worker namespace drain unavailable'),{code:'namespace_unwired'});
  let proof;
  try {await scoped.stopWorker();proof=await scoped.workerStatus();}
  catch(e){
   if(e.code!=='unknown_worker')throw e;
   const rec=await runtime.launchRecord?.(att.id);
   if(rec?.attemptId!==att.id||rec.workerId!==workerId(att)||rec.phase!=='launch_failed'||rec.spawned!==false||rec.worker!==null)throw e;
   // A missing controller registry entry alone never settles a namespace.
   // Require its exact absence plus the durable pre-spawn failure record.
   try {proof=await scoped.workerStatus();}catch(statusError){if(statusError.code!=='unknown_worker')throw statusError;proof={state:'gone'};}
  }
  if(!['stopped','gone'].includes(proof?.state))return false;
  await command(card,run,'swarm_worker_settled',{attemptId:att.id,workerId:workerId(att),state:proof.state},`namespace-${att.id}`);return true;
 }
 async function settle(card,run,att,wt,entry){
  const cancelled=!!att.cancel||!!run.attempts.find(a=>a.id===att.id)?.cancel||now()>=att.deadlineAt||run.status==='stopping'||run.stopIntent;
  let outcome=cancelled?'cancelled':wt.status==='completed'&&(wt.runExitCode??wt.exitCode)===0?'completed':'failed';let proposal=null,reason=`participant ${outcome}`;
  if(outcome==='completed'){
   const parsed=parseSwarmResult(wt.finalText);if(!parsed.ok){outcome='failed';reason=parsed.error;}
   else{
    const name=`swarm-${att.id}.md`,artifactId=`swarm-${att.id}`,staged=await writeStagedArtifact(stateDir,att.id,name,wt.finalText);
    await command(card,run,'commit_artifact',{attemptId:att.id,artifact:{id:artifactId,kind:'swarm-result',file:name,bytes:staged.bytes,sha256:staged.sha256},stagedPath:staged.stagedPath},`artifact-${att.id}`);
    try {for(const [i,c] of parsed.result.commands.entries()) {const id=`frame-${att.id}-${i}`;if(c.type==='apply')await apply(card,await fresh(run.id),att,id,c.ops,entry);else await command(card,run,'swarm_protocol',{attemptId:att.id,commandId:id,command:c},`protocol-${id}`);}
    await command(card,run,'swarm_turn_result',{attemptId:att.id,artifactId},`frame-${att.id}`);proposal={artifactId,sha256:staged.sha256,bytes:staged.bytes};
    }catch(e){const r=await fresh(run.id);if(Object.values(r.swarm.edits).some(e=>e.attemptId===att.id&&e.status==='pending'))throw e;outcome='failed';reason=`result command rejected: ${e.code??e.message}`;}
   }
  }
  if(outcome!=='completed')await command(card,run,'swarm_observed',{attemptId:att.id,outcome,reason},`observed-${att.id}-${outcome}`);
  if(!await drainWorker(card,run,att))return 'namespace_unproven';
  await command(card,run,'resolve_attempt',{attemptId:att.id,outcome,reason,...(proposal?{proposal}:{})},`resolve-${att.id}-${outcome}`);return 'resolved';
 }
 async function supervise(card,run,att,entry){
  if(!ours(att.owner)){const proof=await adoptionProofFor(att.owner);if(!proof)return 'foreign_owner';await command(card,run,'adopt_attempt',{attemptId:att.id,proof},`adopt-${att.id}-${self().instanceId}`);att=(await fresh(run.id)).attempts.find(a=>a.id===att.id);}
  if(att.frameApplied||att.observedTerminal){if(!await drainWorker(card,run,att))return 'namespace_unproven';const art=run.artifacts?.[att.resultArtifactId],outcome=att.frameApplied?'completed':att.observedTerminal.outcome;await command(card,run,'resolve_attempt',{attemptId:att.id,outcome,reason:att.observedTerminal?.reason??'Recovered committed turn',...(art?{proposal:{artifactId:art.id,sha256:art.sha256,bytes:art.bytes}}:{})},`resolve-${att.id}-${outcome}`);return 'resolved';}
  if(!att.porchRunId){
   const rec=await runtime.launchRecord(att.id);if(rec?.corrupt)return 'launch_unreadable';
   if(rec?.porchRunId&&rec.phase==='launched'){await command(card,run,'bind_attempt',{attemptId:att.id,porchRunId:rec.porchRunId},`bind-${att.id}`);return 'bound';}
   if(rec?.phase==='launch_failed'&&rec.spawned===false){await command(card,run,'resolve_attempt',{attemptId:att.id,outcome:'failed',reason:rec.error?.message??'launch_failed'},`launch-failed-${att.id}`);return 'launch_failed';}
   if(!rec?.missing){const reconciled=await runtime.reconcile?.({attemptId:att.id});const match=reconciled?.matches?.find(m=>m.runId);if(match){await command(card,run,'bind_attempt',{attemptId:att.id,porchRunId:match.runId},`bind-${att.id}`);return 'bound';}if(reconciled?.workers?.length&&reconciled.workers.every(w=>w.gone===true)&&now()-att.createdAt>(deps.launchOrphanMs??600000)){await command(card,run,'resolve_attempt',{attemptId:att.id,outcome:'failed',reason:'Exact launch workers positively absent'},`orphan-${att.id}`);return 'launch_orphaned';}return 'launch_uncertain';}
   run=await fresh(run.id);if(!launchable(run)||att.cancel){if(run.stopIntent||run.status==='stopping'||att.cancel){const proof=await runtime.reconcile?.({attemptId:att.id});if(!proof?.workers?.length||!proof.workers.every(w=>w.gone===true)||proof.matches?.some(m=>!m.terminal))return 'launch_uncertain';await command(card,run,'resolve_attempt',{attemptId:att.id,outcome:'cancelled',reason:'No runtime launch record; launch admission fenced'},`cancel-unlaunched-${att.id}`);return 'cancelled';}return 'launch_fenced';}
   const x=await runtime.start({attemptId:att.id,profileId:att.launch.profileId,profile:run.swarm.participants.find(p=>p.participantId===att.participantId).profile,role:'swarm-participant',prompt:att.launch.prompt,materials:att.launch.materials,launchTimeoutMs:60_000});
   if(!x?.porchRunId&&!x?.runId)return 'launch_uncertain';await command(card,run,'bind_attempt',{attemptId:att.id,porchRunId:x.porchRunId??x.runId},`bind-${att.id}`);return 'bound';
  }
  if(run.status==='stopping'||run.stopIntent||att.cancel||now()>=att.deadlineAt){
   if(!att.cancel)await command(card,run,'cancel_attempt',{attemptId:att.id,reason:'swarm stop or deadline'},`cancel-${att.id}`);
   if(entry){await entry.b.stop();} // rollback/publish and thaw before cancellation
   const observed=await runtime.wait(att.porchRunId,{timeoutSec:0});
   if(observed?.outcome==='terminal')return settle(card,await fresh(run.id),att,observed,entry);
   const cancelled=await runtime.cancel(att.porchRunId);if(cancelled?.ok===false)return 'cancel_unproven';
  }
  if(!att.cancel&&now()<att.deadlineAt&&!run.stopIntent&&run.status!=='stopping'&&typeof runtime.participantCommands==='function'){
   const channel=await runtime.participantCommands({attemptId:att.id,cursor:att.commandCursor??0});
   if(channel?.ok===true){for(const row of channel.commands??[]){if(typeof row.id!=='string'||!row.command)throw new Error('Invalid scoped participant command');const id=`stream-${att.id}-${row.id}`;if(row.command.type==='apply')await apply(card,run,att,id,row.command.ops,entry);else await command(card,run,'swarm_protocol',{attemptId:att.id,commandId:id,command:row.command},`protocol-${id}`);}
    if(channel.nextCursor!==undefined)await command(card,run,'swarm_cursor',{attemptId:att.id,cursor:channel.nextCursor},`cursor-${att.id}-${channel.nextCursor}`);}
  }
  const wt=await runtime.wait(att.porchRunId,{timeoutSec:0});
  if(!wt||wt.outcome==='observer_timeout'||wt.outcome==='timeout'||wt.outcome==='error')return 'observer_timeout';
  if(wt.outcome!=='terminal')return 'observer_timeout';
  return settle(card,await fresh(run.id),att,wt,entry);
 }
 async function documents(card,run){const q=run.inputs.requirements,p=run.inputs.plan;const req=await getDocument(card.id??card.cardId,q.versionId),plan=await getDocument(card.id??card.cardId,p.versionId);if(req?.sha256!==q.sha256||plan?.sha256!==p.sha256)throw Object.assign(new Error('Approved input mismatch'),{code:'input_drift'});return {requirements:req.content,plan:plan.content};}
 async function issue(card,run,p,entry){
  if(!launchable(run))return 'launch_fenced';
  const snapshotOperation=randomUUID();
  const readers=run.attempts.filter(a=>a.role===SWARM_ROLE&&LIVE.has(a.status)).map(a=>({workerId:workerId(a),attemptId:a.id,runId:a.porchRunId}));
  if(readers.length){await command(card,run,'swarm_freeze',{active:true,physicalConfirmed:false,intent:true,identities:readers,reason:'snapshot_admission',operationId:snapshotOperation},`snapshot-intent-${snapshotOperation}`);await physical(readers,true);}
  const snapshot=await runtime.swarmSnapshot({canonicalId:entry.canonicalId,workspacePath:entry.treeDir,generation:run.swarm.epoch});
  if(!snapshot?.ok||!snapshot.materials?.snapshotId)return 'snapshot_unproven';
  if(readers.length){await physical(readers,false);await command(card,run,'swarm_freeze',{active:false,physicalConfirmed:true},`snapshot-release-${snapshotOperation}`);}
  const docs=await documents(card,run),prompt=buildSwarmPrompt({run,participant:p,...docs}),attemptId=`sp-${randomUUID()}`;
  const materials={...snapshot.materials,inputs:Object.entries({task:prompt,brief:JSON.stringify(run.inputs),messages:JSON.stringify(run.swarm.protocol.messages),decisions:JSON.stringify(run.swarm.protocol.decisions),ownership:JSON.stringify(run.swarm.protocol.files)}).map(([name,content])=>({name,content})),scratch:{id:attemptId,mount:'/work/scratch'}};
  run=await fresh(run.id);if(!launchable(run))return 'launch_fenced';
  await command(card,run,'swarm_participant_begin',{participantId:p.participantId,attemptId,launch:{profileId:p.profileId,profileDigest:p.profileDigest,promptSha256:sha256(prompt),snapshotEpoch:snapshot.generation ?? run.swarm.epoch,prompt,materials,workerId:`w-${attemptId}`}},`begin-${attemptId}`);
  return 'turn_begun';
 }
 async function materialize(card,run,entry){
  await command(card,run,'swarm_freeze',{active:true,physicalConfirmed:true,identities:[],reason:'verify'},`verify-freeze-${run.swarm.epoch}`);
  const snap=await runtime.swarmSnapshot({canonicalId:entry.canonicalId,workspacePath:entry.treeDir,generation:run.swarm.epoch});if(!snap?.ok)return 'snapshot_unproven';
  const wr=await ensureWorkspace(card,run);if(!wr?.ok)return wr?.code??'workspace_unresolved';
  for(const args of [['fetch','--no-tags',join(entry.treeDir,'..','repo.git'),snap.snapshotSha],['reset','--hard',snap.snapshotSha],['clean','-fdq']]){const x=await gitRepo(wr.ws.path,args);if(x.code!==0)return 'materialize_failed';}
  await command(card,run,'swarm_materialized',{epoch:run.swarm.epoch,commitSha:snap.snapshotSha,treeSha:snap.treeSha,canonicalId:entry.canonicalId},`materialized-${run.swarm.epoch}`);
  await command(card,await fresh(run.id),'swarm_phase',{phase:'awaiting_validation'},`verify-${run.swarm.epoch}`);return 'awaiting_validation';
 }
 async function step(card,initial){
  let run=await fresh(initial.id)??initial;
  if(!['queued','active','blocked','stopping'].includes(run.status)&&!run.attempts.some(a=>a.role===SWARM_ROLE&&LIVE.has(a.status)))return 'terminal';
  // Supervise bound attempts even during quiescence; no new work is admitted.
  if(closed){for(const a of run.attempts.filter(a=>a.role===SWARM_ROLE&&LIVE.has(a.status)))return supervise(card,run,a,brokers.get(run.id));return 'quiesced';}
  if(!ours(run.swarm.owner)){const proof=run.swarm.owner?await adoptionProofFor(run.swarm.owner):null;if(run.swarm.owner&&!proof)return 'foreign_owner';await command(card,run,'swarm_claim',{...(proof?{adopt:true,proof}:{})},`claim-${self().instanceId}`);run=await fresh(run.id);}
  const entry=await broker(card,run);if(!await recover(card,run,entry))return 'recovery_blocked';run=await fresh(run.id);
  if(run.swarm.freeze?.reason==='snapshot_admission'){const ids=run.swarm.freeze.identities;if(run.stopIntent||run.status==='stopping'){await entry.b.stop();await physical(ids,false);await command(card,run,'swarm_freeze',{active:false,physicalConfirmed:true},`snapshot-stop-release-${run.swarm.freeze.operationId}`);return 'snapshot_released_for_stop';}await physical(ids,true);const snap=await runtime.swarmSnapshot({canonicalId:entry.canonicalId,workspacePath:entry.treeDir,generation:run.swarm.epoch});if(!snap?.ok)return 'snapshot_unproven';await physical(ids,false);await command(card,run,'swarm_freeze',{active:false,physicalConfirmed:true},`snapshot-recovered-${run.swarm.freeze.operationId}`);return 'snapshot_recovered';}
  for(const e of Object.values(run.swarm.edits).filter(e=>e.status==='pending')){const att=run.attempts.find(a=>a.id===e.attemptId);await apply(card,run,att,e.id,e.command.ops,entry);return 'edit_recovered';}
  let uncertain=null;
  for(const a of run.attempts.filter(a=>a.role===SWARM_ROLE&&LIVE.has(a.status)).sort((a,b)=>Number(!!a.porchRunId)-Number(!!b.porchRunId))) {const tag=await supervise(card,run,a,entry);if(['launch_uncertain','launch_unreadable','foreign_owner'].includes(tag)){uncertain=tag;continue;}if(tag!=='observer_timeout')return tag;}
  if(uncertain)return uncertain;
  run=await fresh(run.id);
  for(const a of run.attempts.filter(a=>a.role===SWARM_ROLE&&!LIVE.has(a.status)&&!a.namespace)){if(!await drainWorker(card,run,a))return 'namespace_unproven';return 'namespace_recovered';}

  if(run.status==='stopping'||run.stopIntent){await entry.b.stop();if(run.attempts.some(a=>LIVE.has(a.status)))return 'observer_timeout';if(['active','unproven'].includes(run.validation?.status))return 'core_validation_draining';await command(card,run,'complete_run',{status:'cancelled',reason:'All Swarm workers and broker settled'},'stop-complete');return 'stopped_drained';}
  if(!launchable(run))return 'launch_fenced';
  if(run.fixContext&&run.swarm.fixRound!==run.fixContext.round&&['awaiting_fix','catch_up','awaiting_validation','awaiting_acceptance'].includes(run.phase)&&!['active','unproven'].includes(run.validation?.status)){await command(card,run,'swarm_phase',{phase:'catch_up'},`catch-up-${run.fixContext.round}`);await command(card,await fresh(run.id),'swarm_freeze',{active:false,physicalConfirmed:true},`catch-up-thaw-${run.fixContext.round}`);return 'catch_up';}
  if(['awaiting_validation','awaiting_acceptance'].includes(run.phase))return 'core_validation';
  const s=run.swarm;
  const coordinationReady=s.phase==='coordinate'&&s.participants.every(p=>p.declaration)&&Object.values(s.protocol.decisions).some(d=>d.scope?.kind==='global'&&d.status==='agreed')&&Object.values(s.protocol.decisions).every(d=>['agreed','superseded'].includes(d.status));
  if(coordinationReady){if(run.attempts.some(a=>a.role===SWARM_ROLE&&LIVE.has(a.status)))return 'coordination_draining';await command(card,run,'swarm_phase',{phase:'implement'},`implement`);return 'implement';}
  if(!run.attempts.some(a=>a.role===SWARM_ROLE&&LIVE.has(a.status))&&WRITE_PHASES.has(s.phase)&&s.participants.every(p=>p.ready)&&Object.values(s.protocol.decisions).every(d=>['agreed','superseded'].includes(d.status)))return materialize(card,run,entry);
  const p=[...s.participants].sort((a,b)=>a.budget.turnsUsed-b.budget.turnsUsed).find(p=>!run.attempts.some(a=>a.participantId===p.participantId&&LIVE.has(a.status))&&!p.ready&&!p.waiting&&p.budget.turnsUsed<p.budget.turnsLimit&&(s.phase!=='coordinate'||p.coordinationUsed<s.limits.maxRounds)&&(s.phase!=='catch_up'||s.fixParticipants.includes(p.participantId)));
  if(p)return issue(card,run,p,entry);
  if(run.attempts.some(a=>a.role===SWARM_ROLE&&LIVE.has(a.status)))return 'observer_timeout';
  await command(card,run,'swarm_phase',{phase:'blocked',reason:'Needs participant answer, agreement or explicit budget extension'},`blocked-${s.epoch}-${s.limits.turnsUsed}`);return 'blocked';
 }
 function drive(card,run){const prior=_inflight.get(run.id)??Promise.resolve();const work=prior.catch(()=>{}).then(()=>step(card,run));_inflight.set(run.id,work);work.finally(()=>{if(_inflight.get(run.id)===work)_inflight.delete(run.id);}).catch(()=>{});return work;}
 return {drive,_inflight,quiesce(){closed=true;},async drain(){await Promise.allSettled([..._inflight.values()]);}};
}
