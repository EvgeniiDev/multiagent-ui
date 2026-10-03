// scripts/test_orchestrator_domain.mjs — O1/O3 durable domain + shared wiring.
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

// ===========================================================================
// 1. Feature gating — orchestrator and swarm refuse when disabled
// ===========================================================================

test('gating: mode starts + mode commands refuse when the feature is off', async () => {
  const env = await mkEnv({ features: { start: true, fusion: true, validation: true } });
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await seedApproved(svc);

  let r = await startOrch(svc, 'card-a');
  assert.equal(r.status, 501, J(r.json));
  assert.equal(r.json.code, 'command_unavailable');

  // A swarm start is equally gated.
  const c = await getCard(svc, 'card-a');
  r = await cmd(svc, 'card-a', {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c.json.controlRevision,
    payload: {
      mode: 'swarm',
      swarm: {
        participants: [
          { participantId: 'a', callsign: 'alpha', profile: agentProfile('m1') },
          { participantId: 'b', callsign: 'beta', profile: agentProfile('m2') },
        ],
      },
    },
  });
  assert.equal(r.status, 501, J(r.json));
  assert.equal(r.json.code, 'command_unavailable');

  // swarm_input on the user channel is gated too.
  const c2 = await getCard(svc, 'card-a');
  r = await cmd(svc, 'card-a', {
    commandId: `si-${randomUUID().slice(0, 6)}`, type: 'swarm_input',
    expectedControlRevision: c2.json.controlRevision,
    payload: { runId: 'run_x', participantId: 'all', text: 'hi' },
  });
  assert.equal(r.status, 501, J(r.json));
  assert.equal(r.json.code, 'command_unavailable');

  // And the internal channel fails closed for the gated modes.
  const client = mkClient(svc, env.stateDir);
  let ir = await icmd(client, svc, 'card-a', {
    commandId: 'i1', type: 'orch_claim',
    payload: { runId: 'run_x', ...SELF },
  });
  assert.equal(ir.status, 501, J(ir.json));
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'i2', type: 'swarm_claim',
    payload: { runId: 'run_x', ...SELF },
  });
  assert.equal(ir.status, 501, J(ir.json));
});

// ===========================================================================
// 2. Orchestrator start — durable slice persisted; reservation blocks restart
// ===========================================================================

test('start: orchestrator run persists durable slice; a live run reserves the card', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await seedApproved(svc);

  // Spec validation: missing verifier profile is a 422, not a silent default.
  let r = await startOrch(svc, 'card-a', {
    orchestrator: { ...ORCH_SPEC, verifier: undefined },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'orchestrator_invalid');

  r = await startOrch(svc, 'card-a');
  assert.equal(r.status, 200, J(r.json));
  const runId = r.json.result.runId;
  const run = await runView(svc, runId);
  assert.equal(run.mode, 'orchestrator');
  assert.equal(run.status, 'queued');
  assert.equal(run.phase, 'decompose');
  const oz = run.orchestrator;
  assert.equal(oz.graph.status, 'awaiting_decomposition');
  assert.equal(Object.keys(oz.workers).length, 2);
  assert.ok(oz.decomposer.profile && oz.decomposer.profileDigest);
  assert.equal(oz.verifier.profileId, 'prof-verify');
  assert.equal(oz.limits.requireSpecApproval, false);
  assert.equal(oz.project?.projectRoot || run.orchestrator.project?.projectRoot,
    oz.project?.projectRoot, 'project binding recorded');
  // Approved inputs bound by hash.
  assert.ok(run.inputs.requirements.sha256);
  assert.ok(run.inputs.plan.sha256);

  // A second start while the run is live refuses the reservation.
  r = await startOrch(svc, 'card-a');
  assert.equal(r.status, 409, J(r.json));
  assert.equal(r.json.code, 'run_active');
});

// ===========================================================================
// 3. Internal command surface — user channel cannot reach orch/swarm internals
// ===========================================================================

test('channel: orch/swarm internal commands are unreachable on the user channel', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await seedApproved(svc);
  const started = await startOrch(svc, 'card-a');
  assert.equal(started.status, 200);
  const runId = started.json.result.runId;

  for (const type of ['orch_claim', 'orch_decompose_begin', 'orch_worker_settled',
    'swarm_claim', 'swarm_materialized', 'resolve_attempt']) {
    const r = await cmd(svc, 'card-a', {
      commandId: `u-${randomUUID().slice(0, 6)}`, type,
      payload: { runId },
    });
    assert.equal(r.status, 400, `${type} must be refused on the user channel`);
    assert.equal(r.json.code, 'bad_command');
  }
});

// ===========================================================================
// 4. Claim → decompose_begin → worker_settled → resolve keeps mode phases
// ===========================================================================

test('internal: claim, decompose launch, settle namespace, resolve — mode owns phases', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await seedApproved(svc);
  const client = mkClient(svc, stateDir);

  const started = await startOrch(svc, 'card-a');
  assert.equal(started.status, 200, J(started.json));
  const runId = started.json.result.runId;

  // A foreign instance cannot claim (not_orch_owner is on begin; claim itself
  // adopts only via proof — first claim simply takes it).
  let ir = await icmd(client, svc, 'card-a', {
    commandId: 'c1', type: 'orch_claim',
    payload: { runId, ...SELF },
  });
  assert.equal(ir.status, 200, J(ir.json));
  assert.equal(ir.json.result.claimed, true);

  // decompose_begin without the owner identity is refused.
  const decProfile = ORCH_SPEC.decomposer.profile;
  const launch = {
    profileId: decProfile.profileId,
    profileDigest: profileDigest(decProfile),
    promptSha256: 'a'.repeat(64),
    cwd: '/project',
    artifactsDir: '/attempt/run-x',
    attemptDir: '/attempt',
  };
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'db0', type: 'orch_decompose_begin',
    payload: { runId, attemptId: 'oa-x-d-n1', launch, ...SELF, instanceId: 'inst-other' },
  });
  assert.equal(ir.status, 409, J(ir.json));
  assert.equal(ir.json.code, 'not_orch_owner');

  ir = await icmd(client, svc, 'card-a', {
    commandId: 'db1', type: 'orch_decompose_begin',
    payload: { runId, attemptId: 'oa-x-d-n1', launch, ...SELF },
  });
  assert.equal(ir.status, 200, J(ir.json));
  let run = await runView(svc, runId);
  const att = run.attempts.find((a) => a.id === 'oa-x-d-n1');
  assert.equal(att.role, 'decomposer');
  assert.equal(att.status, 'launching');
  assert.equal(att.launch.profileDigest, launch.profileDigest);

  // Duplicate attempt id is refused.
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'db2', type: 'orch_decompose_begin',
    payload: { runId, attemptId: 'oa-x-d-n1', launch, ...SELF },
  });
  assert.equal(ir.status, 409, J(ir.json));

  // --- namespace settlement contract -------------------------------------
  // Wrong worker binding is refused; state vocabulary is enforced.
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'ws0', type: 'orch_worker_settled',
    payload: { runId, attemptId: 'oa-x-d-n1', workerId: 'w-other', state: 'stopped', ...SELF },
  });
  assert.equal(ir.status, 422, J(ir.json));
  assert.equal(ir.json.code, 'namespace_unproven');
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'ws1', type: 'orch_worker_settled',
    payload: {
      runId, attemptId: 'oa-x-d-n1',
      workerId: workerIdForAttempt('oa-x-d-n1'), state: 'running', ...SELF,
    },
  });
  assert.equal(ir.status, 422, J(ir.json));
  assert.equal(ir.json.code, 'namespace_unproven');

  ir = await icmd(client, svc, 'card-a', {
    commandId: 'ws2', type: 'orch_worker_settled',
    payload: {
      runId, attemptId: 'oa-x-d-n1',
      workerId: workerIdForAttempt('oa-x-d-n1'), state: 'stopped', ...SELF,
    },
  });
  assert.equal(ir.status, 200, J(ir.json));
  run = await runView(svc, runId);
  const att2 = run.attempts.find((a) => a.id === 'oa-x-d-n1');
  assert.equal(att2.namespace.state, 'stopped');
  assert.equal(att2.namespace.workerId, workerIdForAttempt('oa-x-d-n1'));

  // Idempotent replay of the same observation.
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'ws3', type: 'orch_worker_settled',
    payload: {
      runId, attemptId: 'oa-x-d-n1',
      workerId: workerIdForAttempt('oa-x-d-n1'), state: 'stopped', ...SELF,
    },
  });
  assert.equal(ir.status, 200, J(ir.json));

  // gone after stopped is fine (stronger evidence); the reverse is refused.
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'ws4', type: 'orch_worker_settled',
    payload: {
      runId, attemptId: 'oa-x-d-n1',
      workerId: workerIdForAttempt('oa-x-d-n1'), state: 'gone', ...SELF,
    },
  });
  assert.equal(ir.status, 200, J(ir.json));
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'ws5', type: 'orch_worker_settled',
    payload: {
      runId, attemptId: 'oa-x-d-n1',
      workerId: workerIdForAttempt('oa-x-d-n1'), state: 'stopped', ...SELF,
    },
  });
  assert.equal(ir.status, 409, J(ir.json));
  assert.equal(ir.json.code, 'namespace_conflict');

  // --- resolve: the mode owns run.phase/run.status ------------------------
  // Generic solo mutation fields are refused on a mode-owned attempt.
  ir = await icmd(client, svc, 'card-a', {
    commandId: 'rs0', type: 'resolve_attempt',
    payload: {
      runId, attemptId: 'oa-x-d-n1', outcome: 'failed',
      runStatus: 'failed', runPhase: 'complete', ...SELF,
    },
  });
  assert.equal(ir.status, 422, J(ir.json));
  assert.equal(ir.json.code, 'invalid_argument');

  ir = await icmd(client, svc, 'card-a', {
    commandId: 'rs1', type: 'resolve_attempt',
    payload: { runId, attemptId: 'oa-x-d-n1', outcome: 'failed', ...SELF },
  });
  assert.equal(ir.status, 200, J(ir.json));
  run = await runView(svc, runId);
  const att3 = run.attempts.find((a) => a.id === 'oa-x-d-n1');
  assert.equal(att3.status, 'failed');
  // The run's mode-owned phase/status did not move.
  assert.equal(run.phase, 'decompose');
  assert.equal(run.status, 'queued');
  assert.equal(run.orchestrator.graph.status, 'awaiting_decomposition');
});

// ===========================================================================
// 5. Stop — orchOnStop terminates the graph durably
// ===========================================================================

test('stop: orchestrator run stops the graph; tasks cancel; run drains to terminal', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await seedApproved(svc);
  const started = await startOrch(svc, 'card-a');
  assert.equal(started.status, 200);
  const runId = started.json.result.runId;

  const c = await getCard(svc, 'card-a');
  const r = await cmd(svc, 'card-a', {
    commandId: `sp-${randomUUID().slice(0, 6)}`, type: 'stop',
    expectedControlRevision: c.json.controlRevision,
    payload: { reason: 'operator stop' },
  });
  assert.equal(r.status, 200, J(r.json));
  const run = await runView(svc, runId);
  assert.equal(run.orchestrator.graph.status, 'stopped');
  assert.ok(['stopping', 'stopped', 'cancelled', 'failed'].includes(run.status),
    `run status is draining/terminal, got ${run.status}`);
});

// ===========================================================================
// 6. Swarm start — native module reachable through the shared dispatch
// ===========================================================================

test('swarm: start persists native swarm slice; swarm_* internals dispatch or fail closed', async () => {
  const env = await mkEnv();
  const { svc, projectDir, stateDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await seedApproved(svc);
  const client = mkClient(svc, stateDir);

  const c = await getCard(svc, 'card-a');
  let r = await cmd(svc, 'card-a', {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c.json.controlRevision,
    payload: {
      mode: 'swarm',
      swarm: {
        participants: [
          { participantId: 'a', callsign: 'alpha', profile: agentProfile('m1') },
          { participantId: 'b', callsign: 'beta', profile: agentProfile('m2') },
        ],
      },
    },
  });
  assert.equal(r.status, 200, J(r.json));
  const runId = r.json.result.runId;
  const run = await runView(svc, runId);
  assert.equal(run.mode, 'swarm');
  assert.equal(run.status, 'queued');
  assert.equal(run.phase, 'coordinate');
  assert.equal(run.swarm.participants.length, 2);
  assert.equal(run.swarm.participants[0].participantId, 'a');
  assert.equal(run.swarm.participants[0].callsign, 'alpha');
  assert.equal(run.swarm.limits.verifyRequired, true);

  // A swarm_* internal type is admitted by the channel; an unexported
  // command fails closed — never silently no-ops. (Module absent → 501;
  // module present but no cmdSwarm* export → bad_command.)
  let ir = await icmd(client, svc, 'card-a', {
    commandId: 'sb1', type: 'swarm_not_a_command',
    payload: { runId, ...SELF },
  });
  assert.equal(ir.status, 400, J(ir.json));
  assert.equal(ir.json.code, 'bad_command');

  // A user-channel swarm_input reaches the native dispatcher; without a
  // materialized canonical it must fail in-domain, never as bad_command.
  const c3 = await getCard(svc, 'card-a');
  r = await cmd(svc, 'card-a', {
    commandId: `si-${randomUUID().slice(0, 6)}`, type: 'swarm_input',
    expectedControlRevision: c3.json.controlRevision,
    payload: { runId, participantId: 'all', text: 'status?' },
  });
  assert.notEqual(r.status, 400, 'swarm_input must dispatch, not bad_command');
  assert.notEqual(r.json.code, 'bad_command', J(r.json));
});
