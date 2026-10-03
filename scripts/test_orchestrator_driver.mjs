// Driver integration: real state service, artifacts and Git storage; F1-shaped runtime transport.
//   node --test scripts/test_orchestrator_driver.mjs
//
// Everything runs through createStateService's real request/queue path plus
// createInternalClient against the real routed internal surface (the same
// route+token channel the runner uses). No listener, no compose, no live
// state dir. These deterministic driver tests exercise durable command
// contracts, real Git evidence, ownership, and dependency flow; they are not live
// runtime acceptance.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createInternalClient } from '../server/execution/internal-transport.mjs';
import { profileDigest } from '../server/execution/environment/agent-profile.mjs';
import { workerIdForAttempt } from '../server/execution/environment/container-runtime.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);
const SELF = {
  runnerId: 'test-runner', instanceId: 'inst-1', pid: 4242,
  envKey: { uid: 1000, gid: 1000, hostname: 'test-host', bootId: 'boot-1', pidNs: 'pidns-1' },
};

// ---- fixtures ---------------------------------------------------------------

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

async function mkProject() {
  const dir = join(tmpdir(), `o1-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

const ALL_FEATURES = { start: true, fusion: true, validation: true, orchestrator: true, swarm: true };

async function mkEnv({ features = ALL_FEATURES } = {}) {
  const root = join(tmpdir(), `o1-state-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const stateDir = join(root, 'state');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
  const svc = await createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer'),
      ACP_WORKSPACE_DIR: join(root, 'wsroot'),
      ROOT_DIR: root,
      ...(typeof process.getuid === 'function' ? { ACP_EXEC_TOKEN_UID: String(process.getuid()) } : {}),
      ...(typeof process.getgid === 'function' ? { ACP_EXEC_TOKEN_GID: String(process.getgid()) } : {}),
    },
    features,
  });
  return { root, stateDir, projectDir, svc };
}

async function req(svc, method, path, body, headers) {
  const q = new URL(path, 'http://t');
  return svc.request({
    method, path: q.pathname, query: q.searchParams,
    bodyText: body === undefined ? undefined : J(body), headers,
  });
}
const putDoc = (svc, name, data, rev) => req(svc, 'PUT', `/api/state/${name}`, { data, rev });
const cmd = (svc, cardId, body) => req(svc, 'POST', `/api/execution/cards/${cardId}/commands`, body);
const getCard = (svc, id) => req(svc, 'GET', `/api/execution/cards/${id}`);
const getRun = (svc, id) => req(svc, 'GET', `/api/execution/runs/${id}`);

function mkClient(svc, stateDir) {
  return createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : JSON.stringify(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
}

function boardWith(cards) { return { version: 2, cards }; }
function cardFixture(id, projectDir, over = {}) {
  return { id, title: id, stage: 'spec', status: 'in_progress', project: 'proj-x', order: 10, ...over };
}
async function seedBase(svc, projectDir, cards = [cardFixture('card-a')]) {
  await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  return putDoc(svc, 'board.json', boardWith(cards));
}
async function enable(svc, cardId = 'card-a', commandId = `en-${randomUUID().slice(0, 6)}`) {
  const r = await cmd(svc, cardId, { commandId, type: 'enable' });
  assert.equal(r.status, 200, J(r.json));
}
async function attachDoc(svc, cardId, kind, text, extra = {}) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `at-${randomUUID().slice(0, 6)}`, type: 'attach_document',
    expectedControlRevision: c.json.controlRevision,
    payload: { kind, source: { type: 'text', text }, ...extra },
  });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
async function approve(svc, cardId, type, { versionId, sha256 }, extra = {}) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId: `ap-${randomUUID().slice(0, 6)}`, type,
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId, sha256, ...extra },
  });
  assert.equal(r.status, 200, J(r.json));
  return r;
}
const PI_MODEL = 'zen-relay/muse-spark-1.3-contributor-free';
async function savePreset(svc, cardId) {
  const c = await getCard(svc, cardId);
  const member = { cli: 'pi', model: PI_MODEL };
  const r = await cmd(svc, cardId, {
    commandId: `pr-${randomUUID().slice(0, 6)}`, type: 'save_preset',
    expectedControlRevision: c.json.controlRevision,
    payload: {
      preset: {
        name: 'orch-preset',
        members: { implementer: member, reviewer: member, checker: member },
      },
    },
  });
  assert.equal(r.status, 200, J(r.json));
}
// The full approved-inputs + composition gate every mode start requires.
async function seedApproved(svc, cardId = 'card-a') {
  const reqDoc = await attachDoc(svc, cardId, 'requirements', '# Orchestrate this\n');
  await approve(svc, cardId, 'approve_requirements', reqDoc);
  const planDoc = await attachDoc(svc, cardId, 'plan', '# Plan\n', {
    requirementsVersionId: reqDoc.versionId,
  });
  await approve(svc, cardId, 'approve_plan', planDoc, {
    checks: [{ run: 'npm test' }],
  });
  await savePreset(svc, cardId);
}

function agentProfile(id, over = {}) {
  return {
    schemaVersion: 1,
    profileId: `prof-${id}`,
    pi: { version: '0.85.1' },
    image: 'worker',
    provider: 'zen-relay',
    model: id,
    thinking: 'low',
    skills: [],
    extensions: [],
    tools: ['read', 'bash'],
    search: { enabled: false, provider: null, params: {} },
    launch: { progress: 'none', extraFlags: [] },
    systemPromptFile: null,
    ...over,
  };
}
const entry = (id) => ({ profile: agentProfile(id) });

const ORCH_SPEC = {
  decomposer: entry('decomp'),
  verifier: entry('verify'),
  integrator: entry('integr'),
  workers: { w1: entry('worker-a'), w2: entry('worker-b') },
  limits: { requireSpecApproval: false },
};

async function startOrch(svc, cardId, over = {}) {
  const c = await getCard(svc, cardId);
  return cmd(svc, cardId, {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c.json.controlRevision,
    payload: { mode: 'orchestrator', orchestrator: ORCH_SPEC, ...over },
  });
}
async function runView(svc, runId) {
  const r = await getRun(svc, runId);
  assert.equal(r.status, 200, J(r.json));
  return r.json;
}
// Internal-channel commands ride the authenticated client; the client throws
// on >=400 (RuntimeError with .status/.code/.details) — normalize to
// {status, json} for assertions. expectedInternalRevision comes from the card.
async function icmd(client, svc, cardId, body) {
  try {
    if (body.expectedInternalRevision === undefined) {
      const card = await getCard(svc, cardId);
      body = { ...body, expectedInternalRevision: card.json.internalRevision };
    }
    const r = await client.command(cardId, body);
    return { status: 200, json: r };
  } catch (e) {
    return {
      status: e.status ?? 500,
      json: { code: e.code ?? 'error', error: e.message, ...(e.details ?? {}) },
    };
  }
}


import { createOrchDriver } from '../server/execution/orchestrator/controller.mjs';
import * as workspaceStorage from '../server/execution/orchestrator/workspaces.mjs';
import * as snapshotStorage from '../server/execution/orchestrator/snapshots.mjs';
import * as resolutionStorage from '../server/execution/orchestrator/integration-artifacts.mjs';

const taskSpec = (id, dependsOn=[]) => ({id,title:id,outcome:`implement ${id}`,acceptanceCriteria:[`${id} works`],dependsOn,boundary:{paths:[`src/${id}.js`]},worker:{profileId:'w1'}});
async function driverFixture(options={}) {
  const env = await mkEnv(); const {svc,stateDir,projectDir,root} = env;
  await seedBase(svc,projectDir); await enable(svc); await seedApproved(svc);
  const started = await startOrch(svc,'card-a'); assert.equal(started.status,200,J(started.json));
  const runId=started.json.result.runId, client=mkClient(svc,stateDir);
  const workersDir=join(root,'workers'), canonicals=new Map(), snapshots=new Map(), jobs=new Map(), starts=[], trace=[], errors=[];
  await fs.mkdir(workersDir,{recursive:true});
  const exportTree = (source,sha,dest) => {
    const archive=execFileSync('git',['-C',source,'archive',sha]);
    const extracted=spawnSync('tar',['-x','-C',dest],{input:archive}); assert.equal(extracted.status,0,extracted.stderr?.toString());
  };
  const runtime = {
    environment:()=>({workersDir}),
    canonicalPrepare:async params=>{
      if(canonicals.has(params.canonicalId))return {ok:true,canonical:canonicals.get(params.canonicalId)};
      const source=params.projectRoot===basename(projectDir)?projectDir:join(dirname(projectDir),params.projectRoot);
      if(source!==projectDir)cleanupRoots.add(source);
      const hostDir=join(root,'canonical',params.canonicalId), repo=join(hostDir,'repo.git'), worktree=join(hostDir,'worktree');
      await fs.mkdir(hostDir,{recursive:true}); git(source,'clone','-q','--bare',source,repo);
      git(repo,'worktree','add','-q','--detach',worktree,params.snapshotSha);
      const canonical={id:params.canonicalId,hostDir,worktree,projectRoot:params.projectRoot,baseSha:params.snapshotSha,state:'ready'};
      canonicals.set(params.canonicalId,canonical); return {ok:true,canonical};
    },
    canonicalStatus:async id=>{const canonical=canonicals.get(id);return {ok:true,canonical:{...canonical,head:git(canonical.worktree,'rev-parse','HEAD')}};},
    swarmSnapshot:async({canonicalId,generation})=>{
      const canonical=canonicals.get(canonicalId), head=git(canonical.worktree,'rev-parse','HEAD');
      const snapshotId=`snapshot-${canonicalId}-${generation}`;
      if(!snapshots.has(snapshotId)) {
        const repoPath=join(root,snapshotId);git(canonical.worktree,'clone','-q','--bare',canonical.worktree,repoPath);
        snapshots.set(snapshotId,{repoPath,snapshotSha:head,projectRoot:canonical.projectRoot});
      }
      assert.equal(snapshots.get(snapshotId).snapshotSha,head,'snapshot generation is immutable');
      return {ok:true,snapshotSha:head,materials:{projectRoot:canonical.projectRoot,snapshotSha:head,snapshotId}};
    },
    start:async params=>{
      starts.push(params); trace.push(['start',params.attemptId]);
      const workerId=workerIdForAttempt(params.attemptId), repoPath=join(workersDir,workerId,'project');
      if(['orch-worker','orch-integrator'].includes(params.role)) {
        const canonical=canonicals.get(params.materials.canonicalId);
        if(params.materials.fromCanonical && (params.materials.snapshotId || params.materials.projectRoot!==canonical.projectRoot || params.materials.snapshotSha!==git(canonical.worktree,'rev-parse','HEAD')))
          return {ok:false,phase:'launch_failed',error:{code:'canonical_binding_mismatch',message:'source must match exact registered canonical HEAD and projectRoot'}};
        const snapshot=params.materials.snapshotId?snapshots.get(params.materials.snapshotId):null;
        if(snapshot)assert.deepEqual([params.materials.projectRoot,params.materials.snapshotSha],[snapshot.projectRoot,snapshot.snapshotSha]);
        const source=snapshot?snapshot.repoPath:params.materials.fromCanonical?canonical.worktree:(params.materials.projectRoot===basename(projectDir)?projectDir:join(dirname(projectDir),params.materials.projectRoot));
        // F1 seeds private repositories by tree archive, never by refs/history.
        await fs.mkdir(repoPath,{recursive:true});exportTree(source,params.materials.snapshotSha,repoPath);
        git(repoPath,'init','-q');git(repoPath,'add','-A');
        git(repoPath,'-c','user.name=acp-environment','-c','user.email=acp-environment@localhost','commit','-qm','private seed');
      }
      const porchRunId=`run_${params.attemptId}`;
      jobs.set(porchRunId,{params,workerId,repoPath,state:'running',wait:{outcome:'timeout'},createdAt:new Date().toISOString()});
      return {ok:true,porchRunId,workerId};
    },
    wait:async id=>jobs.get(id)?.wait ?? {outcome:'error',error:{code:'unknown_run'}},
    cancel:async id=>{trace.push(['cancel',id]);const job=jobs.get(id);if(!job)return{ok:false,requested:false};job.wait={outcome:'terminal',status:'cancelled',runExitCode:1};return{ok:true,requested:true};},
    launchRecord:async id=>{const job=[...jobs.entries()].find(([,j])=>j.params.attemptId===id);return job?{attemptId:id,phase:'launched',porchRunId:job[0],workerId:job[1].workerId,spawned:true,createdAt:job[1].createdAt}:{attemptId:id,missing:true};},
    reconcile:async({attemptId})=>{const entry=[...jobs.entries()].find(([,j])=>j.params.attemptId===attemptId);return{ok:true,matches:entry?[{runId:entry[0]}]:[],workers:[{workerId:workerIdForAttempt(attemptId),gone:!entry}]};},
    forAttempt:id=>({workerId:workerIdForAttempt(id),workerStatus:async()=>{const job=[...jobs.values()].find(j=>j.params.attemptId===id);return job?{ok:true,state:job.state,namespaceAlive:job.state==='running'}:{ok:false,error:{code:'unknown_worker'}};},stopWorker:async()=>{const job=[...jobs.values()].find(j=>j.params.attemptId===id);trace.push(['stop',id]);if(job)job.state='stopped';return{ok:true,state:'stopped'};}}),
    repoImport:async workerId=>{
      const job=[...jobs.values()].find(j=>j.workerId===workerId); assert.equal(job.state,'stopped','import requires physical namespace settlement');
      const canonical=canonicals.get(job.params.materials.canonicalId), before=git(canonical.worktree,'rev-parse','HEAD');
      for(const leaf of await fs.readdir(canonical.worktree))if(leaf!=='.git')await fs.rm(join(canonical.worktree,leaf),{recursive:true,force:true});
      exportTree(job.repoPath,git(job.repoPath,'rev-parse','HEAD'),canonical.worktree);
      git(canonical.worktree,'add','-A');
      if(spawnSync('git',['-C',canonical.worktree,'diff','--cached','--quiet']).status!==0)git(canonical.worktree,'-c','user.name=test','-c','user.email=test@test','commit','-qm','import result');
      const commitSha=git(canonical.worktree,'rev-parse','HEAD');trace.push(['import',job.params.attemptId]);
      return{ok:true,import:{commitSha,treeSha:git(canonical.worktree,'rev-parse','HEAD^{tree}'),changed:before!==commitSha,diffStat:git(canonical.worktree,'diff','--stat',before,commitSha)}};
    },
  };
  const storage={...workspaceStorage,...snapshotStorage,...resolutionStorage,freezeResult:async args=>{
    const job=[...jobs.values()].find(j=>j.repoPath===args.repoPath);if(job)assert.equal(job.state,'stopped','host freeze requires physical namespace settlement');
    trace.push(['freeze',job?.params.attemptId]);return snapshotStorage.freezeResult(args);
  }};
  const start=runtime.start;
  runtime.start=async params=>{try{return await start(params);}catch(e){errors.push({type:'runtime.start',code:e.code,message:e.message});throw e;}};
  const send=async(card,type,payload,idem)=>{
    trace.push(['command',type,payload]);
    await options.beforeCommand?.({type,payload});
    const current=await client.getCard(card.cardId);
    try{return await client.command(card.cardId,{commandId:idem,type,payload,expectedInternalRevision:current.internalRevision});}
    catch(e){errors.push({type,code:e.code,message:e.message});throw e;}
  };
  const events=[];
  const driverDeps={runtime,send,getRun:id=>client.getRun(id),getDocument:(id,v)=>client.getDocument(id,v),getArtifact:(id,a)=>client.getArtifact(id,a),recordEvent:async(...args)=>events.push(args),stateDir,storage,projectsDir:dirname(projectDir),canLaunch:options.canLaunch??(()=>true),ensureWorkspace:async()=>{
    const wsPath=join(root,'materialized'); if(!await fs.stat(wsPath).catch(()=>null)){git(projectDir,'clone','-q',projectDir,wsPath);}
    return{ok:true,ws:{path:wsPath}};
  }};
  const newDriver=(identity=SELF,adoptionProofFor=null)=>createOrchDriver({...driverDeps,self:()=>identity,instanceId:identity.instanceId,adoptionProofFor});
  const driver=newDriver(options.identity??SELF);
  const run=()=>client.getRun(runId);
  const tick=async()=>driver.drive(await client.getCard('card-a'),await run());
  const complete=async(att,finalText='')=>{jobs.get(att.porchRunId).wait={outcome:'terminal',status:'completed',runExitCode:0,finalText};};
  const decompose=async tasks=>{
    await tick();await tick();let r=await run();const att=r.attempts.find(a=>a.role==='decomposer');assert.ok(att,'driver launched decomposition');
    await complete(att,J({decomposition:{subtasks:tasks}}));await tick();await tick();return run();
  };
  return{...env,runId,run,tick,complete,decompose,driver,newDriver,runtime,jobs,canonicals,snapshots,starts,trace,errors,events,client,send};
}

test('driver: decomposition launches only ready work and settles candidate before verifier',async()=>{
  const f=await driverFixture();let run=await f.decompose([taskSpec('a'),taskSpec('b',['a'])]);
  assert.deepEqual(f.starts.map(s=>s.role),['orch-decomposer','orch-worker'],J({phase:run.phase,tasks:run.orchestrator.tasks,errors:f.errors}));
  const work=run.attempts.find(a=>a.role==='worker'),job=f.jobs.get(work.porchRunId);
  await fs.writeFile(join(job.repoPath,'src/a.js'),'export const a = 2;\n');await f.complete(work);await f.tick();await f.tick();
  run=await f.run();
  assert.equal(run.orchestrator.tasks[0].state.status,'verifying',J({errors:f.errors,events:f.events.map(e=>({type:e[2],data:e[3]}))}));
  assert.ok(run.orchestrator.tasks[0].state.resultCandidate,'real domain recorded the imported candidate');
  assert.ok(f.starts.some(s=>s.role==='orch-verifier'),'driver launches verifier on immutable candidate');
  const settled=run.attempts.find(a=>a.id===work.id);assert.equal(settled.namespace.state,'stopped');
  assert.ok(f.trace.findIndex(e=>e[0]==='stop'&&e[1]===work.id)<f.trace.findIndex(e=>e[0]==='freeze'&&e[1]===work.id));
});

test('driver: returned candidate fix feeds accepted dependency snapshot then assembler materializes all results',async()=>{
  const f=await driverFixture();await f.decompose([taskSpec('a'),taskSpec('b',['a'])]);
  const live=async(role,taskId)=>{const r=await f.run();const a=r.attempts.findLast(a=>a.role===role&&(!taskId||a.taskId===taskId)&&['launching','running','cancelling'].includes(a.status));assert.ok(a,`${role}/${taskId} missing: ${J({phase:r.phase,tasks:r.orchestrator.tasks.map(t=>({id:t.id,state:t.state})),errors:f.errors,events:f.events.map(e=>({type:e[2],data:e[3]}))})}`);return a;};
  const ticks=async()=>{await f.tick();await f.tick();};
  let a=await live('worker','a');await fs.writeFile(join(f.jobs.get(a.porchRunId).repoPath,'src/a.js'),'export const a = 2;\n');await f.complete(a);await ticks();
  let verifier=await live('verifier','a'),run=await f.run();
  assert.equal(f.jobs.get(verifier.porchRunId).params.materials.snapshotSha,run.orchestrator.tasks[0].state.resultCandidate.commit);
  await f.complete(verifier,J({decision:'return',findings:[{id:'f1',severity:'major',text:'a must be 3'}]}));await ticks();
  const fix=await live('worker','a'),fixJob=f.jobs.get(fix.porchRunId);assert.equal(fix.kind,'fix');assert.ok(fixJob,J(f.errors));
  assert.equal(await fs.readFile(join(fixJob.repoPath,'src/a.js'),'utf8'),'export const a = 2;\n','fix starts from imported result');
  await fs.writeFile(join(fixJob.repoPath,'src/a.js'),'export const a = 3;\n');await f.complete(fix);await ticks();
  verifier=await live('verifier','a');run=await f.run();
  assert.equal(run.orchestrator.tasks[0].state.resultCandidate.attemptId,fix.id,'candidate must bind current fix, not historical work');
  const candidate=f.snapshots.get(f.jobs.get(verifier.porchRunId).params.materials.snapshotId);
  assert.equal(git(candidate.repoPath,'show',`${candidate.snapshotSha}:src/a.js`),'export const a = 3;');
  await f.complete(verifier,J({decision:'accept',findings:[]}));await ticks();
  const b=await live('worker','b'),bJob=f.jobs.get(b.porchRunId);
  assert.equal(await fs.readFile(join(bJob.repoPath,'src/a.js'),'utf8'),'export const a = 3;\n','dependency snapshot includes accepted fixed ancestor');
  assert.deepEqual(b.launch.snapshotOf,['a']);await fs.writeFile(join(bJob.repoPath,'src/b.js'),'export const b = 1;\n');await f.complete(b);await ticks();
  verifier=await live('verifier','b');await f.complete(verifier,J({decision:'accept',findings:[]}));await ticks();
  const assembler=await live('assembler'),asmJob=f.jobs.get(assembler.porchRunId);
  const resultInput=asmJob.params.materials.inputs.find(i=>i.name==='results');assert.ok(resultInput,'assembler receives durable parent results');
  for(const match of resultInput.content.matchAll(/```diff\n([\s\S]*?)\n```/g)) {
    if(match[1]!=='(empty diff)'){const applied=spawnSync('git',['-C',asmJob.repoPath,'apply','--index'],{input:match[1],encoding:'utf8'});assert.equal(applied.status,0,applied.stderr);}
  }
  await f.complete(assembler,J({additionalPaths:[],resolvedPaths:[]}));await ticks();run=await f.run();
  assert.equal(run.phase,'awaiting_validation',J({errors:f.errors,tasks:run.orchestrator.tasks}));
  assert.ok(run.orchestrator.integrate.import.commitSha);
  assert.equal(await fs.readFile(join(f.root,'materialized/src/a.js'),'utf8'),'export const a = 3;\n');
  assert.equal(await fs.readFile(join(f.root,'materialized/src/b.js'),'utf8'),'export const b = 1;\n');
  assert.ok(run.attempts.every(a=>a.namespace?.state==='stopped'),'all role namespaces settle before validation');
});

test('driver: stopping waits for physical namespace proof and cancels without another launch',async()=>{
  const f=await driverFixture();await f.tick();await f.tick();let run=await f.run();const dec=run.attempts[0], job=f.jobs.get(dec.porchRunId);
  const card=await f.client.getCard('card-a');const stopped=await cmd(f.svc,'card-a',{commandId:'stop',type:'stop',expectedControlRevision:card.controlRevision,payload:{reason:'test stop'}});assert.equal(stopped.status,200,J(stopped.json));
  const forAttempt=f.runtime.forAttempt;f.runtime.forAttempt=id=>({...forAttempt(id),stopWorker:async()=>({ok:false,error:{code:'unavailable'}})});
  await f.tick();run=await f.run();assert.equal(run.status,'stopping');assert.ok(!run.attempts[0].namespace);assert.equal(job.state,'running');
  f.runtime.forAttempt=forAttempt;await f.tick();run=await f.run();assert.equal(run.status,'cancelled');assert.equal(run.attempts[0].namespace.state,'stopped');assert.equal(f.starts.length,1);
});

test('driver: lost bind recovers from flattened F1 launch record without another launch',async()=>{
  let dropped=false;
  const f=await driverFixture({beforeCommand:({type})=>{if(type==='bind_attempt'&&!dropped){dropped=true;throw new Error('dropped bind');}}});
  await f.tick();await assert.rejects(f.tick(),/dropped bind/);
  let run=await f.run();assert.equal(run.attempts[0].status,'launching');assert.equal(f.starts.length,1);
  const record=await f.runtime.launchRecord(run.attempts[0].id);assert.equal(record.phase,'launched');assert.ok(record.porchRunId);assert.equal(record.record,undefined);
  await f.tick();run=await f.run();assert.equal(run.attempts[0].porchRunId,record.porchRunId);assert.equal(f.starts.length,1);
});

test('driver: observer timeout leaves live attempt and namespace untouched',async()=>{
  const f=await driverFixture();await f.tick();await f.tick();let run=await f.run();
  const att=run.attempts[0],job=f.jobs.get(att.porchRunId);job.wait={outcome:'observer_timeout',error:{code:'observer_timeout'}};
  await f.tick();run=await f.run();assert.equal(run.attempts[0].status,'running');assert.equal(job.state,'running');
  assert.equal(f.trace.some(e=>e[0]==='stop'),false);assert.equal(f.trace.some(e=>e[0]==='command'&&e[1]==='resolve_attempt'),false);
});

test('driver: refused cancellation is retried until request and physical drain are confirmed',async()=>{
  const f=await driverFixture();await f.tick();await f.tick();
  const cancel=f.runtime.cancel;let calls=0;f.runtime.cancel=async id=>++calls===1?{ok:true,requested:false}:cancel(id);
  const card=await f.client.getCard('card-a');const response=await cmd(f.svc,'card-a',{commandId:'retry-stop',type:'stop',expectedControlRevision:card.controlRevision,payload:{reason:'stop'}});assert.equal(response.status,200,J(response.json));
  await f.tick();assert.equal((await f.run()).status,'stopping');assert.equal(calls,1);
  await f.tick();const run=await f.run();assert.equal(calls,2);assert.equal(run.status,'cancelled');assert.equal(run.attempts[0].namespace.state,'stopped');
});

test('driver: restarted owner adopts completed graph only with authenticated matching dead-process proof',async()=>{
  let admit=true;
  const original={...SELF,pidStarttime:'original-start'};
  const f=await driverFixture({identity:original,canLaunch:()=>admit});
  let run=await f.decompose([taskSpec('a')]);const work=run.attempts.find(a=>a.role==='worker');
  await fs.writeFile(join(f.jobs.get(work.porchRunId).repoPath,'src/a.js'),'export const a = 2;\n');await f.complete(work);await f.tick();await f.tick();
  run=await f.run();const verifier=run.attempts.find(a=>a.role==='verifier');assert.ok(verifier);
  admit=false;await f.complete(verifier,J({decision:'accept',findings:[]}));await f.tick();
  run=await f.run();assert.equal(run.phase,'integrate');assert.equal(run.orchestrator.graph.status,'complete');
  const launches=f.starts.length, replacement={...SELF,instanceId:'inst-restarted',pid:4243,pidStarttime:'replacement-start'};
  const tickWith=async driver=>driver.drive(await f.client.getCard('card-a'),await f.run());
  admit=true;
  assert.equal(await tickWith(f.newDriver(replacement)), 'foreign_owner');
  assert.equal(f.starts.length,launches);assert.equal((await f.run()).orchestrator.owner.instanceId,original.instanceId);
  for(const proof of [
    {kind:'process_dead',pid:999,starttime:original.pidStarttime,finding:'absent'},
    {kind:'process_dead',pid:original.pid,starttime:original.pidStarttime,finding:'alive'},
  ]) {
    assert.equal(await tickWith(f.newDriver(replacement,()=>proof)),'foreign_owner');
    assert.equal(f.starts.length,launches);
  }
  const asked=[];
  const restarted=f.newDriver(replacement,owner=>{
    asked.push(owner);
    return{kind:'process_dead',pid:owner.pid,starttime:owner.pidStarttime,pidNs:owner.envKey.pidNs,finding:'absent'};
  });
  await tickWith(restarted);run=await f.run();
  assert.equal(run.orchestrator.owner.instanceId,replacement.instanceId,'durable run owner changes before assembly');
  assert.equal(asked[0].instanceId,original.instanceId);assert.equal(asked[0].pidStarttime,original.pidStarttime);
  assert.ok(run.events.some(e=>e.type==='orch_adopted'));
  const assembler=run.attempts.find(a=>a.role==='assembler');assert.ok(assembler,'adopted complete graph launches assembler');
  assert.equal(assembler.owner.instanceId,replacement.instanceId);assert.equal(f.starts.length,launches+1);
  await tickWith(restarted);assert.equal(f.starts.length,launches+1,'next tick supervises existing assembler');
});

test('driver: decomposition retry carries actual committed-spec rejection and can repair it', async () => {
  const f = await driverFixture();
  await f.tick(); await f.tick();
  let run = await f.run();
  const first = run.attempts.find(a => a.role === 'decomposer');
  const invalid = taskSpec('a'); invalid.boundary.paths = [];
  await f.complete(first, J({ decomposition: { subtasks: [invalid] } }));
  await f.tick(); await f.tick();
  run = await f.run();
  const rejection = run.orchestrator.specHistory.find(r => r.attemptId === first.id);
  assert.equal(rejection.code, 'boundary_missing');
  assert.equal(rejection.message, 'subtasks[0].boundary.paths must be a non-empty array');
  const retry = run.attempts.findLast(a => a.role === 'decomposer');
  assert.notEqual(retry.id, first.id);
  const prompt = f.jobs.get(retry.porchRunId).params.prompt;
  assert.ok(prompt.includes(rejection.message), 'retry sees the actual durable validation diagnostic');
  assert.ok(prompt.includes(rejection.sha256), 'diagnostic binds the rejected committed artifact');
  assert.ok(prompt.includes('verification-only tasks'), 'even read-only tasks require a non-empty declared scope');
  const example = /```json\n([\s\S]*?)\n```/.exec(prompt)[1];
  assert.doesNotThrow(() => JSON.parse(example), 'the illustrative output itself is valid JSON');
  await f.complete(retry, J({ decomposition: { subtasks: [taskSpec('a')] } }));
  await f.tick(); await f.tick();
  run = await f.run();
  assert.equal(run.orchestrator.spec.status, 'approved');
  assert.equal(run.orchestrator.graph.status, 'active');
  assert.equal(run.orchestrator.tasks.length, 1);
  assert.equal(run.orchestrator.specHistory.filter(r => r.rejected).length, 1);
});

test('driver: fresh continuation carries prior rejection diagnostics without importing old graph evidence', async () => {
  const f = await driverFixture();
  await f.tick(); await f.tick();
  for (let n = 0; n < 2; n++) {
    const run = await f.run();
    const att = run.attempts.findLast(a => a.role === 'decomposer');
    const invalid = taskSpec('a'); invalid.boundary.paths = [];
    await f.complete(att, J({ decomposition: { subtasks: [invalid] } }));
    await f.tick(); await f.tick();
  }
  const predecessor = await f.run();
  assert.equal(predecessor.status, 'failed');
  const card = await f.client.getCard('card-a');
  const continued = await cmd(f.svc, 'card-a', {commandId:'continue-rejected-decomposition',type:'continue',expectedControlRevision:card.controlRevision,payload:{note:'Correct the rejected scope'}});
  assert.equal(continued.status,200,J(continued.json));
  const id = continued.json.result.runId;
  const next = await f.client.getRun(id);
  assert.equal(next.orchestrator.specHistory.length,0);
  assert.deepEqual(next.orchestrator.tasks,[]);
  await f.driver.drive(await f.client.getCard('card-a'),next);
  await f.driver.drive(await f.client.getCard('card-a'),await f.client.getRun(id));
  const fresh = await f.client.getRun(id);
  const attempt = fresh.attempts.find(a=>a.role==='decomposer');
  const prompt = f.jobs.get(attempt.porchRunId).params.prompt;
  assert.ok(prompt.includes(predecessor.orchestrator.specHistory.at(-1).message));
  assert.ok(prompt.includes(predecessor.orchestrator.specHistory.at(-1).sha256));
  assert.equal(fresh.orchestrator.specHistory.length,0,'context never becomes current spec approval/proof');
});
