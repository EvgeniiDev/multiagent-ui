// Orchestrator continuation through actual state-service commands; no listener or model.
//   node --test scripts/test_orchestrator_domain.mjs
//
// Everything runs through createStateService's real request/queue path plus
// createInternalClient against the real routed internal surface (the same
// route+token channel the runner uses). No listener, no compose, no live
// state dir. These are DETERMINISTIC domain tests — they exercise the durable
// command contract, gating, ownership, and mode isolation; they are not live
// runtime acceptance.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
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


async function stoppedOrchestrator() {
  const env = await mkEnv();
  await seedBase(env.svc,env.projectDir);await enable(env.svc);await seedApproved(env.svc);
  const started=await startOrch(env.svc,'card-a');assert.equal(started.status,200,J(started.json));
  const id=started.json.result.runId;
  const card=await getCard(env.svc,'card-a');
  const stopped=await cmd(env.svc,'card-a',{commandId:'stop-original',type:'stop',expectedControlRevision:card.json.controlRevision,payload:{reason:'continuation fixture'}});
  assert.equal(stopped.status,200,J(stopped.json));
  const client=mkClient(env.svc,env.stateDir);
  const drained=await icmd(client,env.svc,'card-a',{commandId:'drain-original',type:'complete_run',payload:{runId:id,status:'cancelled',...SELF}});
  assert.equal(drained.status,200,J(drained.json));
  return {...env,id,client};
}
async function continueRun(svc,payload={}) {
  const card=await getCard(svc,'card-a');
  return cmd(svc,'card-a',{commandId:`continue-${randomUUID().slice(0,8)}`,type:'continue',expectedControlRevision:card.json.controlRevision,payload});
}

test('continue preserves Orchestrator mode/composition while re-pinning approved inputs and fresh base',async()=>{
  const f=await stoppedOrchestrator(), before=await runView(f.svc,f.id);
  const requirements=await attachDoc(f.svc,'card-a','requirements','# Updated requirements\n');
  await approve(f.svc,'card-a','approve_requirements',requirements);
  const plan=await attachDoc(f.svc,'card-a','plan','# Updated plan\n',{requirementsVersionId:requirements.versionId});
  await approve(f.svc,'card-a','approve_plan',plan,{checks:[{run:'node --check src/a.js'}]});
  await fs.writeFile(join(f.projectDir,'src','a.js'),'export const a = 3;\n');
  git(f.projectDir,'add','-A');git(f.projectDir,'-c','user.name=t','-c','user.email=t@t','commit','-qm','new project base');
  const r=await continueRun(f.svc,{note:'Re-decompose using the updated requirements'});
  assert.equal(r.status,200,J(r.json));
  const run=await runView(f.svc,r.json.result.runId);
  assert.notEqual(run.id,before.id);assert.equal(run.mode,'orchestrator');assert.equal(run.phase,'decompose');
  assert.equal(run.status,'queued');assert.equal(run.workspaceId,null);
  assert.equal(run.baseCommit,git(f.projectDir,'rev-parse','HEAD'));assert.notEqual(run.baseCommit,before.baseCommit);
  assert.equal(run.inputs.requirements.versionId,requirements.versionId);assert.equal(run.inputs.plan.versionId,plan.versionId);
  assert.equal(run.orchestrator.graph.inputs.baseCommit,run.baseCommit);
  assert.equal(run.orchestrator.graph.status,'awaiting_decomposition');
  assert.equal(run.orchestrator.spec,null);assert.deepEqual(run.orchestrator.tasks,[]);assert.deepEqual(run.attempts,[]);
  assert.equal(run.orchestrator.owner,null);assert.equal(run.orchestrator.decomposeUsed,0);assert.equal(run.orchestrator.integrate,null);
  for(const key of ['decomposer','verifier','integrator','workers','limits'])assert.deepEqual(run.orchestrator[key],before.orchestrator[key]);
  assert.deepEqual(run.composition,before.composition);
  assert.equal(run.continuation.fromRunId,before.id);assert.equal(run.continuation.carryPolicy,'fresh_decomposition');
  assert.equal(run.continuation.userNote,'Re-decompose using the updated requirements');
  assert.deepEqual(await runView(f.svc,before.id),before,'historical run evidence is not mutated');
});

test('continue never launches before stop drains or with unapproved current inputs',async()=>{
  const env=await mkEnv();await seedBase(env.svc,env.projectDir);await enable(env.svc);await seedApproved(env.svc);
  const start=await startOrch(env.svc,'card-a');assert.equal(start.status,200);
  let r=await continueRun(env.svc);assert.equal(r.status,409,J(r.json));assert.equal(r.json.code,'run_active');
  const f=await stoppedOrchestrator();
  await attachDoc(f.svc,'card-a','requirements','# Unapproved change\n');
  r=await continueRun(f.svc);assert.equal(r.status,422,J(r.json));assert.equal(r.json.code,'requirements_unapproved');
  const card=await getCard(f.svc,'card-a');assert.equal(card.json.currentRunId,f.id);
});

test('continue refuses disabled Orchestrator after a real persisted predecessor',async()=>{
  const f=await stoppedOrchestrator();
  const gated=await createStateService({stateDir:f.stateDir,features:{...ALL_FEATURES,orchestrator:false},env:{ROOT_DIR:f.root}});
  const r=await continueRun(gated);assert.equal(r.status,501,J(r.json));assert.equal(r.json.code,'command_unavailable');
  const card=await getCard(gated,'card-a');assert.equal(card.json.currentRunId,f.id);
});
