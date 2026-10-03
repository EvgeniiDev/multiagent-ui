import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyCardCommand} from '../server/execution/execution-domain.mjs';
for(const mode of ['swarm','orchestrator'])test(`${mode} run events follow adopted mode owner while attempt and validation authority stays exact`,async()=>{
 const current={runnerId:'runner',instanceId:'new'},old={runnerId:'runner',instanceId:'old'};
 const run={id:'run-event',mode,status:'active',attempts:[{id:'historical',status:'failed',owner:old}],events:[],eventsCursor:0,[mode]:{owner:current}};
 const aggregate={cardId:'card',runs:[run],commands:{},internalRevision:0,controlRevision:0};
 const ctx={features:{swarm:true,orchestrator:true},loadAggregate:async()=>aggregate,saveAggregate:async()=>{},putRun:()=>{},appendRunEvent:()=>{},pendingIntents:()=>[],flushStaged:async()=>{}};
 let n=0;const emit=(identity,extra={})=>applyCardCommand(ctx,'card',{commandId:`event-${++n}`,expectedInternalRevision:aggregate.internalRevision,type:'record_event',payload:{runId:run.id,type:'swarm_broker_applied',data:{eventId:'durable-operation'},...identity,...extra}},{channel:'internal'});
 await emit(current);assert.equal(run.events.length,1);
 await assert.rejects(emit(old),e=>e.code==='not_mode_owner');
 await assert.rejects(emit(current,{attemptId:'historical'}),e=>e.code==='not_attempt_owner');
 await emit(old,{attemptId:'historical'});assert.equal(run.events.length,2);
 run.validation={status:'active',owner:old};
 await assert.rejects(emit(current),e=>e.code==='not_validation_owner');
 await emit(old);assert.equal(run.events.length,3);
});
