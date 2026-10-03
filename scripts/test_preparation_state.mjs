// scripts/test_preparation_state.mjs — P1 idea-preparation session/state tests.
//   node --test scripts/test_preparation_state.mjs
//
// Everything runs through createStateService's REAL request surface and
// serialized write queue (no listener, no compose). The lead turn is driven
// by a fake-runtime adapter: each durable session attempt maps to a real
// fake-runtime run (start → wait → terminal) whose outcome is delivered
// through the internal prep_result seam — exactly the contract a P3 lead
// driver will consume. Crash injection uses the service's deterministic
// fault seams (board.json flush fails AFTER the aggregate commit).
//
// Scenarios covered (from the P1 brief):
//   1. concurrent/tab-equivalent start_preparation → one session, idempotent
//   2. version/hash-bound approvals cannot replay onto another version
//   3. read-only status paths write nothing
//   4. intent restatement invalidates dependent gates only
//   5. early draft + blocking open questions; assistant end ≠ ready
//   6. crash between durable doc write and projection update → healed/blocked
//   7. cancelled/stale attempts and late results can never replace newer state
//   8. SkillGate missing / stale digest / changed document / unsupported
//      binding all fail closed with structured results

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createFakeRuntime } from '../server/execution/fake-runtime.mjs';
import { loadAggregate } from '../server/execution/execution-store.mjs';
import { buildManifest } from '../server/execution/preparation/skills/registry.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---- fixtures ---------------------------------------------------------------

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

async function mkProject() {
  const dir = join(tmpdir(), `p1-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
const myGid = typeof process.getgid === 'function' ? process.getgid() : null;

// A test-local SkillBinding registry: real skill directories on tmpfs, pinned
// via the P0 buildManifest factory — the same data the production registry
// carries. Bindings cover every stage plus a candidate and an unsupported
// route for the fail-closed checks.
async function mkRegistry(root) {
  const skillsDir = join(root, 'skills');
  const mk = async (name) => {
    const dir = join(skillsDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: test ${name}\n---\n# ${name}\n`, 'utf-8');
    await fs.writeFile(join(dir, 'helper.txt'), `helper ${name}\n`, 'utf-8');
    return dir;
  };
  const defs = [
    ['test-grill', 'intent', 'available'],
    ['test-grill-alt', 'intent', 'available'],
    ['test-brainstorm', 'requirements', 'available'],
    ['test-arch', 'design', 'available'],
    ['test-plan', 'plan', 'available'],
    ['test-review', 'review', 'available'],
    ['test-candidate', 'intent', 'candidate'],
    ['test-unsupported', 'plan', 'unsupported'],
  ];
  // P2: an available binding declares its full runtime contract — adapter,
  // capabilities, gate contract, result acquisition. These mirror the
  // production bindings' shape (pi-skill adapter, stage-appropriate gates).
  const contractFor = (stage) => ({
    intent: {
      gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
      result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
    },
    requirements: {
      gateContract: [{ type: 'artifact_confirm', stage: 'requirements' }],
      result: { mode: 'workspace_artifact', docKind: 'requirements', importAs: 'document', artifacts: [], handoffs: [] },
    },
    design: {
      gateContract: [{ type: 'artifact_confirm', stage: 'design' }],
      result: { mode: 'workspace_artifact', docKind: 'design', importAs: 'document', artifacts: [], handoffs: [] },
    },
    plan: {
      gateContract: [{ type: 'artifact_confirm', stage: 'plan' }],
      result: { mode: 'workspace_artifact', docKind: 'plan', importAs: 'document', artifacts: [], handoffs: [] },
    },
    review: {
      gateContract: [],
      result: { mode: 'review_report', importAs: 'none', artifacts: [], handoffs: [] },
    },
  })[stage];
  const bindings = [];
  for (const [bindingId, stage, status] of defs) {
    const dir = await mk(bindingId);
    const b = {
      bindingId, stage, status,
      title: `Test ${bindingId}`,
      provider: 'test',
      adapterId: 'pi-skill',
      adapterVersion: 'pi-skill-1',
      skillDirs: [dir],
      extraResources: [],
      questionChannel: 'chat',
      tools: ['read', 'write'],
      requires: [],
      readOnlyRoots: [],
      skillNames: [bindingId],
      expect: { artifacts: [], frontmatter: {}, minChatQuestions: 0, minUiRequests: 0 },
    };
    if (status === 'available') {
      const c = contractFor(stage);
      b.gateContract = c.gateContract;
      b.result = c.result;
    }
    if (status === 'unsupported') {
      b.unsupported = { reason: 'implementation_authority_denied', detail: 'test route', route: '' };
      delete b.adapterId;
      delete b.adapterVersion;
    }
    b.resourceManifest = await buildManifest(b);
    bindings.push(b);
  }
  const registryPath = join(root, 'bindings.json');
  await fs.writeFile(registryPath, J({
    schemaVersion: 1,
    pi: { binary: 'pi', version: '0.85.1' },
    bindings,
  }), 'utf-8');
  return { registryPath, skillsDir, bindings };
}

async function mkEnv({ faults, registryPath } = {}) {
  const root = join(tmpdir(), `p1-state-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const stateDir = join(root, 'state');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
  if (!registryPath) registryPath = (await mkRegistry(root)).registryPath;
  const svc = await createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer'),
      ACP_WORKSPACE_DIR: join(root, 'wsroot'),
      ROOT_DIR: root,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    faults,
    features: { start: true, validation: true, fusion: true, preparation: true },
    preparation: { registryPath },
  });
  return { root, stateDir, projectDir, svc, registryPath };
}

// ---- request helpers ---------------------------------------------------------

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
const getPrep = (svc, id) => req(svc, 'GET', `/api/execution/cards/${id}/preparation`);
const getDoc = (svc, id, versionId) => req(svc, 'GET', `/api/execution/cards/${id}/documents/${versionId}`);
const readBoard = async (svc) => (await req(svc, 'GET', '/api/state/board.json')).json;

function boardWith(cards) { return { version: 2, cards }; }
function cardFixture(id, over = {}) {
  return { id, title: id, stage: 'spec', status: 'in_progress', project: 'proj-x', order: 10, ...over };
}
async function seedBase(svc, projectDir, cards = [cardFixture('card-a')]) {
  const p = await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  assert.equal(p.status, 200, J(p.json));
  const b = await putDoc(svc, 'board.json', boardWith(cards));
  assert.equal(b.status, 200, J(b.json));
}

async function enable(svc, cardId = 'card-a', commandId = `en-${randomUUID().slice(0, 6)}`) {
  const r = await cmd(svc, cardId, { commandId, type: 'enable' });
  assert.equal(r.status, 200, J(r.json));
}

// A user command at the card's current revision; refuses to hide failures.
async function ucmd(svc, cardId, type, payload = {}, commandId = `c-${randomUUID().slice(0, 8)}`) {
  const c = await getCard(svc, cardId);
  const r = await cmd(svc, cardId, {
    commandId, type,
    expectedControlRevision: c.json.controlRevision,
    payload,
  });
  return r;
}

async function startPrep(svc, cardId, payload, commandId = `sp-${randomUUID().slice(0, 8)}`) {
  return ucmd(svc, cardId, 'start_preparation', payload, commandId);
}
async function mustStartPrep(svc, cardId, payload, commandId) {
  const r = await startPrep(svc, cardId, payload, commandId);
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}

async function attachDoc(svc, cardId, kind, text, extra = {}) {
  const r = await ucmd(svc, cardId, 'attach_document',
    { kind, source: { type: 'text', text }, ...extra });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result; // {attached|versionId, sha256, ...}
}
async function approve(svc, cardId, type, { versionId, sha256 }) {
  const r = await ucmd(svc, cardId, type, { versionId, sha256 });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
async function savePreset(svc, cardId) {
  const member = { cli: 'devin', model: 'swe-2-max' };
  const r = await ucmd(svc, cardId, 'save_preset', {
    preset: {
      name: 'p1',
      members: { implementer: member, reviewer: member, checker: member },
    },
  });
  assert.equal(r.status, 200, J(r.json));
}
async function confirmGate(svc, cardId, gateId) {
  const r = await ucmd(svc, cardId, 'confirm_gate', { gateId });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
async function prepView(svc, cardId) {
  const r = await getPrep(svc, cardId);
  assert.equal(r.status, 200, J(r.json));
  return r.json.preparation;
}

// The internal prep_result seam (the P3 lead driver channel), driven over the
// production service's internalCommand path with CAS + dedup.
async function prepResult(svc, cardId, attemptId, body, { commandId, rev } = {}) {
  const card = rev === undefined ? (await getCard(svc, cardId)).json : { internalRevision: rev };
  return svc.internalCommand(cardId, {
    commandId: commandId ?? `pr-${randomUUID().slice(0, 8)}`,
    type: 'prep_result',
    expectedInternalRevision: card.internalRevision,
    payload: { attemptId, result: body },
  });
}

// A lead-turn adapter over the fake runtime: each durable session attempt is
// a real fake-runtime run; the terminal outcome is delivered through
// prep_result. This exercises the same durable-attempt/late-result contract
// a live lead driver will.
function createLead(root) {
  const rt = createFakeRuntime({
    rootDir: join(root, 'lead-runtime'),
    namespace: 'prep-lead',
  });
  return {
    rt,
    // Runs the attempt to a terminal state, then delivers `result` through
    // the internal seam. `result` is the turn payload or a fn of the wait
    // outcome.
    async drive(svc, cardId, projectDir, attemptId, result) {
      const launch = await rt.start({
        attemptId,
        profileId: 'prep-lead',
        cwd: projectDir,
        prompt: 'preparation turn',
        config: { fake: true, profile: 'prep-lead' },
      });
      assert.equal(launch.ok, true, J(launch));
      const w = await rt.wait(launch.porchRunId, { timeoutSec: 5 });
      assert.equal(w.outcome, 'terminal', J(w));
      const body = typeof result === 'function' ? result(w) : result;
      return prepResult(svc, cardId, attemptId, body);
    },
  };
}

function gateIds(view, pred = () => true) {
  return (view?.gates || []).filter(pred).map((g) => g.gateId);
}
const blockerCodes = (view) => new Set((view?.blockers || []).map((b) => b.code));

// Drive a session fully to readiness: requirements+plan attached, approved at
// exact version/hash, every minted gate confirmed. Returns the inputs used.
async function driveToReady(svc, cardId) {
  const reqDoc = await attachDoc(svc, cardId, 'requirements', '# Requirements\n\nBuild the thing.\n');
  const planDoc = await attachDoc(svc, cardId, 'plan', '# Plan\n\n1. Step\n\n```acp-checks\n{"checks":[{"run":"node --version","timeoutSec":60}]}\n```\n');
  await approve(svc, cardId, 'approve_requirements', reqDoc);
  await approve(svc, cardId, 'approve_plan', planDoc);
  const view = await prepView(svc, cardId);
  for (const g of view.gates) {
    if (g.status === 'pending' || g.status === 'invalidated') {
      await confirmGate(svc, cardId, g.gateId);
    }
  }
  const ready = await prepView(svc, cardId);
  assert.equal(ready.ready, true, `expected ready; blockers: ${J(ready.blockers)}`);
  return { reqDoc, planDoc, view: ready };
}

// ============================================================================
// Scenario 1 — concurrent/tab-equivalent start: one session, idempotent
// ============================================================================

test('S1: concurrent + repeated start_preparation produce one durable session', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);

  // Two tab-equivalent starts in flight with the SAME commandId and the SAME
  // observed revision: the write queue serializes them; the second is a
  // dedup replay of the first (dedup precedes the revision check).
  const payload = { intent: 'add a CSV export to the dashboard' };
  const shared = 'sp-shared-1';
  const c0 = (await getCard(svc, 'card-a')).json;
  const mkStart = () => cmd(svc, 'card-a', {
    commandId: shared, type: 'start_preparation',
    expectedControlRevision: c0.controlRevision, payload,
  });
  const [r1, r2] = await Promise.all([mkStart(), mkStart()]);
  assert.equal(r1.status, 200, J(r1.json));
  assert.equal(r2.status, 200, J(r2.json));
  assert.equal(r1.json.result.sessionId, r2.json.result.sessionId);
  assert.ok(r1.json.idempotent === true || r2.json.idempotent === true,
    'one of the racing starts must be a dedup replay');

  // A replay of the same command returns the recorded outcome verbatim.
  const c3 = await getCard(svc, 'card-a');
  const replay = await cmd(svc, 'card-a', {
    commandId: shared, type: 'start_preparation',
    expectedControlRevision: 999, // stale on purpose — dedup precedes revision
    payload,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.result.sessionId, r1.json.result.sessionId);

  // A second tab with a DIFFERENT commandId but the same intent reuses the
  // live session — the same durable outcome, not a fork.
  const r4 = await startPrep(svc, 'card-a', payload);
  assert.equal(r4.status, 200, J(r4.json));
  assert.equal(r4.json.result.sessionId, r1.json.result.sessionId);
  assert.equal(r4.json.result.reused, true);
  assert.equal(r4.json.result.created, false);

  // Same commandId + different payload conflicts (idempotency contract).
  const conflict = await cmd(svc, 'card-a', {
    commandId: shared, type: 'start_preparation',
    expectedControlRevision: c3.json.controlRevision,
    payload: { intent: 'a different idea' },
  });
  assert.equal(conflict.status, 409, J(conflict.json));
  assert.equal(conflict.json.code, 'command_conflict');

  // A genuinely different intent under a fresh commandId is refused — one
  // active preparation per card.
  const other = await startPrep(svc, 'card-a', { intent: 'a different idea' });
  assert.equal(other.status, 409, J(other.json));
  assert.equal(other.json.code, 'preparation_active');

  const agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(typeof agg.preparation.sessionId, 'string');
  assert.equal(agg.preparation.status, 'active');
  assert.equal((agg.preparationHistory || []).length, 0);
});

// ============================================================================
// Scenario 2 — version/hash-bound acceptance cannot replay onto other versions
// ============================================================================

test('S2: hash-bound approvals refuse mismatches and never replay onto a newer version', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  const session = await mustStartPrep(svc, 'card-a', {
    intent: 'versioned docs test',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm' },
  });

  const v1 = await attachDoc(svc, 'card-a', 'requirements', '# Req v1\n');
  // Wrong hash for the presented version — refused, nothing bound.
  const badSha = await ucmd(svc, 'card-a', 'approve_requirements', {
    versionId: v1.versionId, sha256: sha('definitely not the doc'),
  });
  assert.equal(badSha.status, 409, J(badSha.json));
  assert.equal(badSha.json.code, 'hash_mismatch');

  // Correct hash — bound to v1 exactly.
  const okCmd = `ap-req-${randomUUID().slice(0, 6)}`;
  const c = await getCard(svc, 'card-a');
  const okApprove = await cmd(svc, 'card-a', {
    commandId: okCmd, type: 'approve_requirements',
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId: v1.versionId, sha256: v1.sha256 },
  });
  assert.equal(okApprove.status, 200, J(okApprove.json));
  assert.equal(okApprove.json.result.approval.versionId, v1.versionId);
  assert.equal(okApprove.json.result.approval.sha256, v1.sha256);

  // A newer version arrives — the approval is revoked (core lifecycle
  // unchanged), and the session's presented pointer follows.
  const v2 = await attachDoc(svc, 'card-a', 'requirements', '# Req v2\n');
  let agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.approvals.requirements, null, 'new version must revoke the bound approval');
  assert.equal(agg.preparation.presented.requirements.versionId, v2.versionId);

  // Replaying the recorded approval CANNOT re-bind it to v1 nor apply to v2:
  // it returns the historical outcome only.
  const replay = await cmd(svc, 'card-a', {
    commandId: okCmd, type: 'approve_requirements',
    expectedControlRevision: 999, // dedup precedes revision check
    payload: { versionId: v1.versionId, sha256: v1.sha256 },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.approvals.requirements, null, 'replay must not resurrect the revoked approval');

  // Approving v1 AGAIN under a new commandId is refused: v1 is not current.
  const stale = await ucmd(svc, 'card-a', 'approve_requirements', {
    versionId: v1.versionId, sha256: v1.sha256,
  });
  assert.equal(stale.status, 409, J(stale.json));
  assert.equal(stale.json.code, 'stale_version');

  // And the session is still reachable — the session id was stable across
  // all of the above.
  const view = await prepView(svc, 'card-a');
  assert.equal(view.sessionId, session.sessionId);
});

// ============================================================================
// Scenario 3 — read-only status writes nothing
// ============================================================================

test('S3: status/read-only queries leave aggregate, board, and documents untouched', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'read-only surface test',
    bindings: { intent: 'test-grill' },
  });
  const doc = await attachDoc(svc, 'card-a', 'requirements', '# Stable doc\n');

  const aggBefore = await fs.readFile(join(stateDir, 'execution', 'state', 'cards', 'card-a.json'), 'utf-8');
  const boardBefore = await readBoard(svc);
  const cardBefore = (await getCard(svc, 'card-a')).json;

  // Every read-only surface the session exposes.
  const p1 = await getPrep(svc, 'card-a');
  assert.equal(p1.status, 200, J(p1.json));
  const c1 = await getCard(svc, 'card-a');
  assert.equal(c1.status, 200);
  const d1 = await getDoc(svc, 'card-a', doc.versionId);
  assert.equal(d1.status, 200, J(d1.json));
  assert.equal(d1.json.sha256, doc.sha256);
  const b1 = await readBoard(svc);
  assert.equal(typeof b1.rev, 'number');
  // And again — reads must not accrue state.
  await getPrep(svc, 'card-a');
  await getCard(svc, 'card-a');

  const aggAfterReads = await fs.readFile(join(stateDir, 'execution', 'state', 'cards', 'card-a.json'), 'utf-8');
  const boardAfterReads = await readBoard(svc);
  const cardAfterReads = (await getCard(svc, 'card-a')).json;

  assert.equal(aggAfterReads, aggBefore, 'aggregate file must be byte-identical after reads');
  assert.equal(boardAfterReads.rev, boardBefore.rev, 'board.json rev must not move on reads');
  assert.equal(cardAfterReads.controlRevision, cardBefore.controlRevision);
  assert.equal(cardAfterReads.internalRevision, cardBefore.internalRevision);
  assert.equal(cardAfterReads.commandsProcessed, cardBefore.commandsProcessed,
    'reads must not record commands');

  // A conversational status question (the plan's "status question" case):
  // continuity records the turn, but documents, hashes, approvals and gates
  // must not move.
  const docsBefore = JSON.parse(aggBefore).documents;
  const approvalsBefore = JSON.parse(aggBefore).approvals;
  const gatesBefore = JSON.parse(aggBefore).preparation.gates;
  const attemptsBefore = JSON.parse(aggBefore).preparation.attempts.length;
  const q = await ucmd(svc, 'card-a', 'continue_discussion', {
    text: 'how is this looking — are we ready yet?',
  });
  assert.equal(q.status, 200, J(q.json));
  const aggQ = JSON.parse(
    await fs.readFile(join(stateDir, 'execution', 'state', 'cards', 'card-a.json'), 'utf-8'));
  assert.deepEqual(aggQ.documents, docsBefore,
    'a status question must not create or modify any document');
  assert.deepEqual(aggQ.approvals, approvalsBefore,
    'a status question must not touch approvals');
  assert.deepEqual(aggQ.preparation.gates, gatesBefore,
    'a status question must not mint/invalidate gates');
  assert.equal(aggQ.preparation.presented.requirements.versionId, doc.versionId);
  assert.equal(aggQ.preparation.presented.requirements.sha256, doc.sha256);
  assert.equal(aggQ.preparation.attempts.length, attemptsBefore + 1,
    'the question is recorded as a turn — recorded, not mutating artifacts');
});

// ============================================================================
// Scenario 4 — intent restatement invalidates dependent gates only
// ============================================================================

test('S4: intent restatement invalidates dependent gates; artifacts need reaffirm + re-confirm', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'a dashboard CSV export',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
  });
  const { reqDoc, planDoc } = await driveToReady(svc, 'card-a');

  // Sanity: ready means start actually passes the prep gate — and mints a run.
  const pre = await ucmd(svc, 'card-a', 'start');
  // No composition yet: the core gate fires first; prep gate is last.
  assert.equal(pre.status, 422, J(pre.json));
  assert.equal(pre.json.code, 'composition_missing');
  await savePreset(svc, 'card-a');

  // Change the intent — dependent gates invalidate; approvals stand (the
  // documents did not change).
  const restate = await ucmd(svc, 'card-a', 'continue_discussion', {
    intent: { restate: 'a dashboard CSV export AND a JSON export' },
  });
  assert.equal(restate.status, 200, J(restate.json));
  assert.equal(restate.json.result.intentChanged, true);
  assert.ok(restate.json.result.invalidatedGates.length >= 3,
    `intent+2 artifact gates should invalidate: ${J(restate.json.result.invalidatedGates)}`);

  let view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  const codes = blockerCodes(view);
  assert.ok(codes.has('gate_reconfirm'), `expected gate_reconfirm in ${J(view.blockers)}`);
  assert.ok(codes.has('artifact_stale'), `expected artifact_stale in ${J(view.blockers)}`);

  // The core approvals are untouched — the docs did not change.
  const agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.approvals.requirements?.versionId, reqDoc.versionId);
  assert.equal(agg.approvals.plan?.versionId, planDoc.versionId);

  // Start is refused — the session gate owns the refusal now.
  const startBlocked = await ucmd(svc, 'card-a', 'start');
  assert.equal(startBlocked.status, 422, J(startBlocked.json));
  assert.equal(startBlocked.json.code, 'preparation_not_ready');

  // Re-anchor the still-current docs to the new intent, then re-confirm the
  // invalidated gates against the same presented versions.
  const reaffirm = await ucmd(svc, 'card-a', 'continue_discussion', {
    reaffirm: ['requirements', 'plan'],
  });
  assert.equal(reaffirm.status, 200, J(reaffirm.json));
  view = await prepView(svc, 'card-a');
  assert.ok(!blockerCodes(view).has('artifact_stale'), J(view.blockers));
  for (const g of view.gates) {
    if (g.status === 'invalidated') await confirmGate(svc, 'card-a', g.gateId);
  }
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));
  assert.equal(view.phase, 'ready');

  // A restatement to the SAME text is a no-op (idempotent).
  const current = view.intent.current.text;
  const noop = await ucmd(svc, 'card-a', 'continue_discussion', {
    intent: { restate: current },
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.json.result.intentChanged, false);
});

// ============================================================================
// Scenario 5 — early draft preserves open questions; assistant end ≠ ready
// ============================================================================

test('S5: a draft with blocking open questions stays blocked — the turn ending proves nothing', async () => {
  const { svc, projectDir, root } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'streaming export',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm' },
  });
  const lead = createLead(root);
  const view0 = await prepView(svc, 'card-a');
  const kickoffAttempt = view0.attempts.find((a) => a.kind === 'kickoff');
  assert.ok(kickoffAttempt, 'the kickoff attempt must be durable');

  // The lead's first turn ends with a DRAFT requirements document carrying a
  // blocking open question — the assistant "ended" but nothing is settled.
  const res = await lead.drive(svc, 'card-a', projectDir, kickoffAttempt.attemptId, {
    note: 'first pass',
    document: {
      kind: 'requirements',
      draft: true,
      text: '# Draft requirements\n\n- export streaming\n- TBD target formats\n',
      openQuestions: [
        { text: 'Which formats beyond CSV?', blocking: true },
        { text: 'Any size cap?', blocking: false },
      ],
    },
  });
  assert.equal(res.status, 200, J(res.body));
  assert.equal(res.body.result.applied, true);
  assert.equal(res.body.result.status, 'awaiting_answer');
  assert.equal(res.body.result.document.draft, true);
  assert.equal(res.body.result.questions.length, 2);

  const view = await prepView(svc, 'card-a');
  assert.equal(view.phase, 'requirements');
  assert.equal(view.ready, false);
  const codes = blockerCodes(view);
  assert.ok(codes.has('open_questions'), J(view.blockers));
  assert.ok(codes.has('requirements_unapproved'), J(view.blockers));
  assert.ok(codes.has('plan_unapproved'), J(view.blockers));
  assert.ok(codes.has('gate_pending'), J(view.blockers));
  const blockingQ = view.checkpoint.openQuestions.find((q) => q.blocking === true);
  const nonBlockingQ = view.checkpoint.openQuestions.find((q) => q.blocking === false);
  assert.ok(blockingQ && nonBlockingQ, 'both questions must be preserved verbatim');
  const docRef = view.presented.requirements;
  assert.equal(docRef.draft, true);

  // Answer the blocking question — the session moves forward but approvals
  // and gates are still owed. Answering with the same answer is idempotent.
  const ans = await ucmd(svc, 'card-a', 'answer_question', {
    questionId: blockingQ.questionId, answer: 'CSV and JSON',
  });
  assert.equal(ans.status, 200, J(ans.json));
  const ansReplay = await ucmd(svc, 'card-a', 'answer_question', {
    questionId: blockingQ.questionId, answer: 'CSV and JSON',
  });
  assert.equal(ansReplay.status, 200);
  assert.equal(ansReplay.json.result.alreadyAnswered, true);
  const different = await ucmd(svc, 'card-a', 'answer_question', {
    questionId: blockingQ.questionId, answer: 'only CSV actually',
  });
  assert.equal(different.status, 409, J(different.json));
  assert.equal(different.json.code, 'question_closed');

  // Defer the non-blocking question — preserved as a decision.
  const defer = await ucmd(svc, 'card-a', 'continue_discussion', {
    defer: [nonBlockingQ.questionId],
  });
  assert.equal(defer.status, 200, J(defer.json));
  const view2 = await prepView(svc, 'card-a');
  assert.ok(!blockerCodes(view2).has('open_questions'), J(view2.blockers));
  assert.equal(view2.ready, false);
  assert.ok(blockerCodes(view2).has('gate_pending'), J(view2.blockers));

  // Approving the draft + confirming gates → ready. The draft flag never
  // blocked on its own — binding to the exact hash did.
  const planDoc = await attachDoc(svc, 'card-a', 'plan',
    '# Plan\n\n```acp-checks\n{"checks":[{"run":"node --version","timeoutSec":60}]}\n```\n');
  await approve(svc, 'card-a', 'approve_requirements', { versionId: docRef.versionId, sha256: docRef.sha256 });
  await approve(svc, 'card-a', 'approve_plan', planDoc);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  const view3 = await prepView(svc, 'card-a');
  assert.equal(view3.ready, true, J(view3.blockers));
});

// ============================================================================
// Scenario 6 — crash between durable write and projection update
// ============================================================================

test('S6: crash after aggregate commit but before board flush heals on restart', async () => {
  // The fault set is passed BY REFERENCE so the test can arm/disarm the
  // crash window around a single flush — the documented mechanism.
  const armed = new Set();
  const env = await mkEnv({ faults: { docNames: armed } });
  const { svc, projectDir, stateDir, registryPath, root } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  const started = await mustStartPrep(svc, 'card-a', {
    intent: 'crash-recovery idea', bindings: { intent: 'test-grill' },
  });
  const sessionId = started.sessionId;
  const boardRevBefore = (await readBoard(svc)).rev;

  // Arm the crash window: the attach_document commit sequence is
  //   blob write → aggregate save (durable, command recorded, pending intent
  //   journaled) → board.json flush  ← injected crash lands HERE.
  armed.add('board.json');
  const crashed = await ucmd(svc, 'card-a', 'attach_document', {
    kind: 'requirements', source: { type: 'text', text: '# Req under crash\n' },
  }, 'at-crash-1');
  assert.equal(crashed.status, 500, J(crashed.json));
  assert.match(crashed.json.error, /injected persistence fault/);

  // Post-crash durable truth: aggregate committed with the version, the
  // presented pointer, the recorded command, and the journaled intent.
  let agg = await loadAggregate(stateDir, 'card-a');
  const docV = agg.documents.requirements.current;
  const docSha = agg.documents.requirements.versions.find((v) => v.versionId === docV).sha256;
  assert.equal(agg.preparation.presented.requirements.versionId, docV,
    'the presented pointer must survive the crash');
  assert.equal(agg.commands['at-crash-1'].status, 200,
    'the durable command record holds the committed outcome');
  assert.ok((agg.pendingWrites || []).some((i) => i.type === 'board_projection'),
    'the board_projection intent must be journaled');
  // The blob is durable independent of the projection.
  const blob = await fs.readFile(
    join(stateDir, 'execution', 'state', 'blobs', `${docSha}.md`), 'utf-8');
  assert.equal(blob, '# Req under crash\n');
  // The board did NOT move — that is the crashed effect (the projection write
  // never landed; the rev is still the pre-crash one).
  const boardAtCrash = JSON.parse(await fs.readFile(join(stateDir, 'board.json.json'), 'utf-8'));
  assert.equal(boardAtCrash.rev, boardRevBefore);

  // ---- restart: a fresh service on the same stateDir repairs the intents --
  const svc2 = await createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer2'),
      ACP_WORKSPACE_DIR: join(root, 'wsroot2'),
      ROOT_DIR: root,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    features: { start: true, validation: true, fusion: true, preparation: true },
    preparation: { registryPath },
  });

  // The replayed crashed command returns the SAME durable outcome.
  const replay = await cmd(svc2, 'card-a', {
    commandId: 'at-crash-1', type: 'attach_document',
    expectedControlRevision: 0,
    payload: { kind: 'requirements', source: { type: 'text', text: '# Req under crash\n' } },
  });
  assert.equal(replay.status, 200, J(replay.json));
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.result.sha256, docSha);

  // The session view is fully consistent: presented doc, blob content, gate —
  // and critically, NOT ready (nothing approved, gate pending).
  const view = await prepView(svc2, 'card-a');
  assert.equal(view.sessionId, sessionId);
  assert.equal(view.presented.requirements.versionId, docV);
  assert.equal(view.presented.requirements.sha256, docSha);
  const docRead = await getDoc(svc2, 'card-a', docV);
  assert.equal(docRead.status, 200, J(docRead.json));
  assert.equal(docRead.json.content, '# Req under crash\n');
  assert.equal(view.ready, false, 'a recovered session must never be phantom-ready');
  assert.ok(blockerCodes(view).has('gate_pending'), J(view.blockers));

  // The board projection was healed from aggregate truth (rev moved past the
  // pre-crash value) and carries the server-owned preparation summary.
  const boardAfter = await readBoard(svc2);
  assert.ok(boardAfter.rev > boardRevBefore, 'repair must land the projection');
  const row = boardAfter.data.cards.find((c) => c.id === 'card-a');
  assert.equal(row.execution?.managed, true);
  assert.equal(row.preparation?.sessionId, sessionId);
  assert.equal(row.preparation?.status, 'active');
  assert.equal(row.preparation?.ready, false);
});

// ============================================================================
// Scenario 7 — stale/cancelled attempts can never replace or authorize newer
// ============================================================================

test('S7: cancelled attempts and late results are refused/ignored; replays idempotent', async () => {
  const { svc, projectDir, root } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', { intent: 'attempt ordering' });
  const lead = createLead(root);
  const view0 = await prepView(svc, 'card-a');
  const kickoff = view0.attempts.find((a) => a.kind === 'kickoff');

  // A draft request mints attempt D1 (and supersedes the still-running
  // kickoff — a newer instruction makes its result stale).
  const d1Req = await ucmd(svc, 'card-a', 'request_draft', { kind: 'requirements' });
  assert.equal(d1Req.status, 200, J(d1Req.json));
  const d1 = d1Req.json.result.attemptId;
  const viewA = await prepView(svc, 'card-a');
  const kRec = viewA.attempts.find((a) => a.attemptId === kickoff.attemptId);
  assert.equal(kRec.status, 'cancelled', 'the newer instruction supersedes the running kickoff');

  // A late result for the superseded kickoff — refused as applied:false, no
  // document lands.
  const lateKick = await lead.drive(svc, 'card-a', projectDir, kickoff.attemptId, {
    document: { kind: 'requirements', text: '# from the stale kickoff\n' },
  });
  assert.equal(lateKick.status, 200, J(lateKick.body));
  assert.equal(lateKick.body.result.applied, false);
  assert.equal(lateKick.body.result.reason, 'attempt_cancelled');
  let agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.documents.requirements.versions.length, 0,
    'a cancelled attempt result must never mint a document');

  // D1 completes and lands v1; D2 (a newer draft request) supersedes nothing
  // (D1 already terminal) and lands v2.
  await lead.drive(svc, 'card-a', projectDir, d1, {
    document: { kind: 'requirements', text: '# v1 from D1\n' },
  });
  const d2Req = await ucmd(svc, 'card-a', 'request_draft', { kind: 'requirements' });
  const d2 = d2Req.json.result.attemptId;
  await lead.drive(svc, 'card-a', projectDir, d2, {
    document: { kind: 'requirements', text: '# v2 from D2\n' },
  });
  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.documents.requirements.versions.length, 2);
  const v2 = agg.preparation.presented.requirements.versionId;

  // A REPLAYED result for D2 (same commandId) returns the recorded outcome —
  // it cannot double-apply or mint a third version.
  const cardNow = (await getCard(svc, 'card-a')).json;
  const dupe = await svc.internalCommand('card-a', {
    commandId: `dup-${randomUUID().slice(0, 8)}`, type: 'prep_result',
    expectedInternalRevision: cardNow.internalRevision,
    payload: { attemptId: d2, result: { document: { kind: 'requirements', text: '# phantom v3\n' } } },
  });
  assert.equal(dupe.status, 200, J(dupe.body));
  assert.equal(dupe.body.result.applied, false);
  assert.equal(dupe.body.result.reason, 'attempt_terminal');
  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.documents.requirements.versions.length, 2, 'late/duplicate result must not mint a version');
  assert.equal(agg.preparation.presented.requirements.versionId, v2);

  // The same commandId replayed: idempotent response, still applied:false.
  const cardNow2 = (await getCard(svc, 'card-a')).json;
  const dupeId = `dup2-${randomUUID().slice(0, 8)}`;
  const first = await svc.internalCommand('card-a', {
    commandId: dupeId, type: 'prep_result',
    expectedInternalRevision: cardNow2.internalRevision,
    payload: { attemptId: d2, result: { note: 'harmless' } },
  });
  assert.equal(first.body.result.applied, false);
  const cardNow3 = (await getCard(svc, 'card-a')).json;
  const again = await svc.internalCommand('card-a', {
    commandId: dupeId, type: 'prep_result',
    expectedInternalRevision: cardNow3.internalRevision + 500,
    payload: { attemptId: d2, result: { note: 'harmless' } },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true, 'internal dedup must replay the stored outcome');
  assert.equal(again.body.result.applied, false);

  // A question parked by a live turn, then that turn is superseded → the
  // question's answer channel closes (stale_attempt), though the question
  // record is preserved.
  const turn = await ucmd(svc, 'card-a', 'continue_discussion', { text: 'what next?' });
  const turnAttempt = turn.json.result.attemptId;
  const qRes = await lead.drive(svc, 'card-a', projectDir, turnAttempt, {
    questions: [{ text: 'Pick a target branch?', blocking: true }],
  });
  assert.equal(qRes.status, 200, J(qRes.body));
  const qid = qRes.body.result.questions[0];
  // A newer turn supersedes the parked one.
  const turn2 = await ucmd(svc, 'card-a', 'continue_discussion', { text: 'actually never mind, new direction' });
  assert.equal(turn2.status, 200);
  const staleAns = await ucmd(svc, 'card-a', 'answer_question', {
    questionId: qid, answer: 'main',
  });
  assert.equal(staleAns.status, 409, J(staleAns.json));
  assert.equal(staleAns.json.code, 'stale_attempt');
  const viewB = await prepView(svc, 'card-a');
  const qRec = viewB.checkpoint.openQuestions.find((q) => q.questionId === qid);
  assert.equal(qRec.status, 'open', 'the question record is preserved as evidence');

  // Session stop cancels every live attempt; late results are ignored and a
  // repeated stop is idempotent.
  const stop1 = await ucmd(svc, 'card-a', 'stop_preparation', { reason: 'user asked' });
  assert.equal(stop1.status, 200, J(stop1.json));
  assert.equal(stop1.json.result.status, 'stopped');
  const stop2 = await ucmd(svc, 'card-a', 'stop_preparation', {});
  assert.equal(stop2.status, 200);
  assert.equal(stop2.json.result.alreadyStopped, true);

  const lateFinal = await lead.drive(svc, 'card-a', projectDir, turn2.json.result.attemptId, {
    document: { kind: 'requirements', text: '# post-stop clobber attempt\n' },
  });
  assert.equal(lateFinal.status, 200);
  assert.equal(lateFinal.body.result.applied, false);
  assert.equal(lateFinal.body.result.reason, 'session_stopped');
  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.documents.requirements.versions.length, 2,
    'a post-stop result must never mint or replace a document');
  assert.equal(agg.preparation.status, 'stopped');

  // A fresh start after stop archives the stopped session — provenance is
  // kept (R10), and the new session gets its own kickoff attempt; results
  // aimed at the archived session's attempts are refused as unknown.
  const stoppedId = agg.preparation.sessionId;
  await mustStartPrep(svc, 'card-a', { intent: 'fresh direction' });
  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.notEqual(agg.preparation.sessionId, stoppedId);
  assert.equal(agg.preparation.status, 'active');
  assert.equal(agg.preparationHistory.length, 1);
  assert.equal(agg.preparationHistory[0].sessionId, stoppedId);
  assert.equal(agg.preparationHistory[0].status, 'stopped');
  // The archived session kept its documents/questions — evidence survives.
  assert.ok(agg.preparationHistory[0].checkpoint.openQuestions.length >= 1);
  const orphan = await svc.internalCommand('card-a', {
    commandId: `orph-${randomUUID().slice(0, 8)}`, type: 'prep_result',
    expectedInternalRevision: (await getCard(svc, 'card-a')).json.internalRevision,
    payload: { attemptId: d2, result: { document: { kind: 'requirements', text: '# archived-attempt clobber\n' } } },
  });
  assert.equal(orphan.body.result.applied, false);
  assert.equal(orphan.body.result.reason, 'attempt_unknown',
    'an attempt of an archived session cannot act on the new one');
  assert.equal((await loadAggregate(svc.stateDir, 'card-a'))
    .documents.requirements.versions.length, 2);
});

// ============================================================================
// Scenario 8 — SkillGate fail-closed surface
// ============================================================================

test('S8: unsupported/candidate/unknown bindings and gate violations fail closed', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);

  // Unsupported binding → refused at route selection, with reason.
  let r = await startPrep(svc, 'card-a', {
    intent: 'x', bindings: { plan: 'test-unsupported' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'route_unsupported');
  assert.equal(r.json.reason, 'implementation_authority_denied');

  // Candidate binding → unproven, refused.
  r = await startPrep(svc, 'card-a', {
    intent: 'x', bindings: { intent: 'test-candidate' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'route_unproven');

  // Unknown binding → refused.
  r = await startPrep(svc, 'card-a', {
    intent: 'x', bindings: { intent: 'no-such-binding' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'unknown_binding');

  // Stage mismatch → refused.
  r = await startPrep(svc, 'card-a', {
    intent: 'x', bindings: { plan: 'test-grill' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'binding_stage_mismatch');

  // A clean start with real bindings mints the required gates.
  const started = await mustStartPrep(svc, 'card-a', {
    intent: 'gated flow',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
  });
  assert.equal(started.gates.length, 3, J(started.gates));

  // Readiness before any confirmation: gate_pending blockers, structured.
  let view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  const pending = view.blockers.filter((b) => b.code === 'gate_pending');
  assert.equal(pending.length, 3, J(view.blockers));
  for (const b of pending) {
    assert.ok(b.gateId && b.bindingId && b.type, `blocker must carry actionable detail: ${J(b)}`);
  }

  // confirm_gate on a bogus id → structured 422.
  r = await ucmd(svc, 'card-a', 'confirm_gate', { gateId: 'pg_nope' });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'gate_unknown');

  // An artifact gate binds the CURRENTLY presented document — confirming the
  // requirements gate before a requirements doc exists is refused.
  const reqGate = view.gates.find((g) => g.stage === 'requirements');
  r = await ucmd(svc, 'card-a', 'confirm_gate', { gateId: reqGate.gateId });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'gate_subject_absent');

  // The intent gate binds the current restatement.
  const intentGate = view.gates.find((g) => g.type === 'intent_confirm');
  const c1 = await confirmGate(svc, 'card-a', intentGate.gateId);
  assert.equal(c1.subject.kind, 'intent_restatement');
  assert.equal(c1.subject.sha256, view.intent.current.sha256);

  // Docs approved + all gates confirmed → ready; then a requirements change
  // invalidates the requirements+plan gates AND the approvals (core) — the
  // intent gate survives (independent of the document mutation).
  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# R\n');
  const planDoc = await attachDoc(svc, 'card-a', 'plan',
    '# P\n\n```acp-checks\n{"checks":[{"run":"node --version","timeoutSec":60}]}\n```\n');
  await approve(svc, 'card-a', 'approve_requirements', reqDoc);
  await approve(svc, 'card-a', 'approve_plan', planDoc);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));

  // A NEW requirements version: the confirmed requirements gate (and the
  // plan gate, downstream) invalidate; the intent gate stays confirmed.
  await attachDoc(svc, 'card-a', 'requirements', '# R changed\n');
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  const byCode = (code) => view.blockers.filter((b) => b.code === code);
  assert.ok(byCode('gate_reconfirm').length >= 2, J(view.blockers));
  const intentRec = view.gates.find((g) => g.gateId === intentGate.gateId);
  assert.equal(intentRec.status, 'confirmed',
    'intent gate is independent of the requirements document mutation');
  assert.ok(byCode('requirements_unapproved').length === 1, 'new version revoked the approval');
});

test('S8b: registry repin → stale digest; drifted resources fail at the start gate', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'digest drift',
    bindings: { intent: 'test-grill' },
  });
  await savePreset(svc, 'card-a');
  const { } = await driveToReady(svc, 'card-a');

  let view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true);

  // Repin: touch a skill resource and rebuild the registry manifest — the
  // recorded assignment digest no longer matches the registry's.
  const reg = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
  const grill = reg.bindings.find((b) => b.bindingId === 'test-grill');
  await fs.appendFile(join(grill.skillDirs[0], 'helper.txt'), 'drift\n', 'utf-8');
  grill.resourceManifest = await buildManifest(grill);
  await fs.writeFile(registryPath, J(reg), 'utf-8');

  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  assert.ok([...blockerCodes(view)].some((c) => c === 'binding_digest_changed'),
    `expected binding_digest_changed, got ${J(view.blockers)}`);

  // Gate confirmation under a stale digest is refused.
  const gateId = view.gates[0].gateId;
  const gc = await ucmd(svc, 'card-a', 'confirm_gate', { gateId });
  assert.equal(gc.status, 409, J(gc.json));
  assert.equal(gc.json.code, 'gate_digest_stale');

  // start is refused with the structured blocker list.
  const st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 422, J(st.json));
  assert.equal(st.json.code, 'preparation_not_ready');
  assert.ok((st.json.blockers || []).some((b) => b.code === 'binding_digest_changed'),
    J(st.json));

  // change_skill_binding re-pins to the new digest — old gates invalidate, a
  // fresh pending gate is minted.
  const rebind = await ucmd(svc, 'card-a', 'change_skill_binding', {
    stage: 'intent', bindingId: 'test-grill',
  });
  assert.equal(rebind.status, 200, J(rebind.json));
  assert.equal(rebind.json.result.changed, true);
  view = await prepView(svc, 'card-a');
  const fresh = view.gates.find((g) => g.bindingId === 'test-grill' && g.status === 'pending');
  assert.ok(fresh, 'a fresh gate must be minted against the new digest');
  await confirmGate(svc, 'card-a', fresh.gateId);
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));

  // Now drift a resource WITHOUT repinning — the pinned manifest stays
  // consistent with the registry record but the on-disk bytes moved. The
  // summary read stays green; the start gate's verifyManifest catches it.
  await fs.appendFile(join(grill.skillDirs[0], 'helper.txt'), 'silent drift\n', 'utf-8');
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, 'digest-level read stays consistent');
  const st2 = await ucmd(svc, 'card-a', 'start');
  assert.equal(st2.status, 422, J(st2.json));
  assert.equal(st2.json.code, 'preparation_not_ready');
  assert.ok((st2.json.blockers || []).some((b) => b.code === 'binding_resources_drifted'),
    J(st2.json));

  // Restore the resource to the bytes pinned at re-binding
  // ('helper test-grill\n' + the 'drift\n' line that was repinned) → the
  // manifest verifies again and a real start is admitted.
  const helperPath = join(grill.skillDirs[0], 'helper.txt');
  await fs.writeFile(helperPath, 'helper test-grill\ndrift\n', 'utf-8');
  const st3 = await ucmd(svc, 'card-a', 'start');
  assert.equal(st3.status, 200, `start should pass the full gate: ${J(st3.json)}`);
  assert.ok(st3.json.result.runId, 'a run was minted');
});

// ============================================================================
// Full-path: zero-binding session is ready on approvals alone (R9)
// ============================================================================

test('plain lead path: a session without skill bindings is gated on approvals only', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', { intent: 'no skills needed' });
  await savePreset(svc, 'card-a');

  // Start is blocked while unapproved — the core approval lifecycle owns it.
  let r = await ucmd(svc, 'card-a', 'start');
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'requirements_unapproved');

  const reqDoc = await attachDoc(svc, 'card-a', 'requirements', '# R\n');
  const planDoc = await attachDoc(svc, 'card-a', 'plan',
    '# P\n\n```acp-checks\n{"checks":[{"run":"node --version","timeoutSec":60}]}\n```\n');
  await approve(svc, 'card-a', 'approve_requirements', reqDoc);
  await approve(svc, 'card-a', 'approve_plan', planDoc);

  const view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));
  assert.equal(view.phase, 'ready');

  r = await ucmd(svc, 'card-a', 'start');
  assert.equal(r.status, 200, J(r.json));
  assert.equal(r.json.result.inputs.requirements.sha256, reqDoc.sha256);
});

// ============================================================================
// Preparation is feature-gated; prep_result is internal-channel only
// ============================================================================

test('feature gate: prep commands 501 when disabled; prep_result never reaches the user channel', async () => {
  const { svc, projectDir, root } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);

  // User-channel request for an internal type — refused by the domain's
  // channel split, not by a payload detail.
  const c = await getCard(svc, 'card-a');
  const internalOverUser = await cmd(svc, 'card-a', {
    commandId: 'x1', type: 'prep_result',
    expectedControlRevision: c.json.controlRevision,
    payload: { attemptId: 'pa_x', result: {} },
  });
  assert.equal(internalOverUser.status, 400, J(internalOverUser.json));
  assert.equal(internalOverUser.json.code, 'bad_command');

  // A second service with the flag OFF: every prep command answers 501
  // BEFORE any session logic runs, and the refusal is durable-recorded.
  const svcOff = await createStateService({
    stateDir: svc.stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer2'),
      ACP_WORKSPACE_DIR: join(root, 'wsroot2'),
      ROOT_DIR: root,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    features: { start: true, validation: true, fusion: true, preparation: false },
  });
  const c2 = await getCard(svcOff, 'card-a');
  const off = await cmd(svcOff, 'card-a', {
    commandId: 'p1', type: 'start_preparation',
    expectedControlRevision: c2.json.controlRevision,
    payload: { intent: 'x' },
  });
  assert.equal(off.status, 501, J(off.json));
  assert.equal(off.json.code, 'command_unavailable');
  const agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.preparation, null, 'a gated-off command must not create a session');

  // Same for the internal seam with the flag off.
  const offInternal = await svcOff.internalCommand('card-a', {
    commandId: 'pi1', type: 'prep_result',
    expectedInternalRevision: agg.internalRevision,
    payload: { attemptId: 'pa_x', result: {} },
  });
  assert.equal(offInternal.status, 501, J(offInternal.body));
  assert.equal(offInternal.body.code, 'command_unavailable');

  // The read surface reports a structured unavailable, not a 404 or a stub.
  const offView = await getPrep(svcOff, 'card-a');
  assert.equal(offView.status, 501, J(offView.json));
  assert.equal(offView.json.code, 'unavailable');
});
