// scripts/test_preparation_handoff.mjs — P4 idea-preparation tests:
//   node --test scripts/test_preparation_handoff.mjs
//
// Documents (requirements/design/plan) imported through prep_result land as
// immutable DocumentVersion records bound to provenance and — for plans —
// to the exact ACCEPTED requirements version. Readiness joins core
// approvals, current intent/artifact versions, required SkillGates, and the
// absence of blocking open questions; the implementation start seam
// re-proves all of it. Handoff to solo/Fusion/orchestrator/Swarm is a
// durable OFFER — data only, never a dispatch. A Fusion-returned work
// order attached as a document mints a new UNAPPROVED version.
//
// Everything runs through the REAL createStateService queue + internal
// seams (no listener, no compose). The lead turn is driven directly over
// the internal prep_result channel (the P3 driver contract), and the
// Fusion path through the managed scheduler over the F3-style fake
// container runtime. Crash injection uses the service's fault seams.
//
// Scenarios covered (from the P4 brief):
//   1. AE1 small task: concise requirements then short plan; no design stage
//   2. AE2 complex task: requirements/design/plan with prior answers preserved
//   3. Plan binds the exact ACCEPTED requirements version/hash; no plan
//      produced or accepted without one
//   4. Draft/unaccepted docs and prior-version approvals never permit start
//   5. Approvals alone never bypass open intent/design SkillGates
//   6. AE3: changed restatement/binding invalidates only dependent gates;
//      explicit reconfirmation required
//   7. Accepted package offered to each named mode — data only, no launch
//   8. A Fusion-returned work order mints a new unapproved version
//   9. Crash/restart/idempotency across document import + handoff durable
//      writes

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createFakeRuntime } from '../server/execution/fake-runtime.mjs';
import { createManagedScheduler } from '../server/execution/managed-scheduler.mjs';
import { createInternalClient } from '../server/execution/internal-transport.mjs';
import { loadAggregate } from '../server/execution/execution-store.mjs';
import { buildManifest } from '../server/execution/preparation/skills/registry.mjs';
import { projectKeyFor } from '../server/execution/workspaces.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures ---------------------------------------------------------------

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

async function mkProject() {
  const dir = join(tmpdir(), `p4-proj-${randomUUID().slice(0, 8)}`);
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

// Test-local SkillBinding registry — real skill directories on tmpfs, pinned
// via the production buildManifest factory (same shape the production
// registry carries). Stage bindings declare the P2 contract surface:
// intent→intent_confirm, artifact stages→artifact_confirm; the plan binding
// imports 'plan' documents, requirements 'requirements', design 'design'.
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
    ['test-brainstorm', 'requirements', 'available'],
    ['test-arch', 'design', 'available'],
    ['test-plan', 'plan', 'available'],
  ];
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
    const c = contractFor(stage);
    b.gateContract = c.gateContract;
    b.result = c.result;
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
  const root = join(tmpdir(), `p4-state-${randomUUID().slice(0, 8)}`);
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
const getRun = (svc, id) => req(svc, 'GET', `/api/execution/runs/${id}`);
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
async function enable(svc, cardId = 'card-a') {
  const r = await cmd(svc, cardId, { commandId: `en-${randomUUID().slice(0, 6)}`, type: 'enable' });
  assert.equal(r.status, 200, J(r.json));
}
async function ucmd(svc, cardId, type, payload = {}, commandId = `c-${randomUUID().slice(0, 8)}`) {
  const c = await getCard(svc, cardId);
  return cmd(svc, cardId, {
    commandId, type,
    expectedControlRevision: c.json.controlRevision,
    payload,
  });
}
async function mustStartPrep(svc, cardId, payload) {
  const r = await ucmd(svc, cardId, 'start_preparation', payload);
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
async function attachDoc(svc, cardId, kind, text, extra = {}) {
  const r = await ucmd(svc, cardId, 'attach_document',
    { kind, source: { type: 'text', text }, ...extra });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
async function approve(svc, cardId, type, { versionId, sha256 }) {
  const r = await ucmd(svc, cardId, type, { versionId, sha256 });
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
const MEMBER = { cli: 'devin', model: 'swe-2-max' };
async function savePreset(svc, cardId) {
  const r = await ucmd(svc, cardId, 'save_preset', {
    preset: {
      name: 'p4',
      members: { implementer: { ...MEMBER }, reviewer: { ...MEMBER }, checker: { ...MEMBER } },
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

// The internal prep_result seam — the durable channel the P3 lead driver
// consumes. Driven directly here: the attempt is already minted durable by
// request_draft/continue_discussion/start_preparation, so delivering the
// result exercises the same contract (CAS + command dedup).
async function prepResult(svc, cardId, attemptId, body, { commandId } = {}) {
  const card = (await getCard(svc, cardId)).json;
  return svc.internalCommand(cardId, {
    commandId: commandId ?? `pr-${randomUUID().slice(0, 8)}`,
    type: 'prep_result',
    expectedInternalRevision: card.internalRevision,
    payload: { attemptId, result: body },
  });
}
// Mint a draft attempt and deliver a result for it in one step.
async function draftResult(svc, cardId, kind, result, { note } = {}) {
  const d = await ucmd(svc, cardId, 'request_draft', { kind, ...(note ? { note } : {}) });
  assert.equal(d.status, 200, J(d.json));
  const attemptId = d.json.result.attemptId;
  const res = await prepResult(svc, cardId, attemptId, result);
  return { attemptId, res };
}

const PLAN_CHECKS_FENCE =
  '```acp-checks\n{"checks":[{"run":"node --version","timeoutSec":60}]}\n```\n';
const blockerCodes = (view) => new Set((view?.blockers || []).map((b) => b.code));

// Approve the presented requirements+plan and confirm every open gate —
// the full acceptance path to readiness. Returns the doc version records.
async function driveToReady(svc, cardId) {
  const view0 = await prepView(svc, cardId);
  const reqDoc = view0.presented.requirements;
  const planDoc = view0.presented.plan;
  assert.ok(reqDoc && planDoc, 'driveToReady expects presented requirements+plan');
  await approve(svc, cardId, 'approve_requirements', reqDoc);
  await approve(svc, cardId, 'approve_plan', planDoc);
  for (const g of (await prepView(svc, cardId)).gates) {
    if (g.status === 'pending' || g.status === 'invalidated') {
      await confirmGate(svc, cardId, g.gateId);
    }
  }
  const ready = await prepView(svc, cardId);
  assert.equal(ready.ready, true, `expected ready; blockers: ${J(ready.blockers)}`);
  return { reqDoc, planDoc, view: ready };
}

// ============================================================================
// Scenario 1 — AE1 small task: concise requirements → short plan, no design
// ============================================================================

test('P4-S1 AE1: small task — requirements then plan, no design stage, ready', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'rename the export button',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
    // No design stage — a small task never needs one.
  });

  // The requirements draft lands via the lead's result — the immutable
  // version carries session provenance + the intent it was built under.
  const reqRes = await draftResult(svc, 'card-a', 'requirements', {
    note: 'concise pass',
    document: {
      kind: 'requirements',
      text: '# Requirements\n\n- rename "Export" to "Download CSV"\n',
    },
  });
  assert.equal(reqRes.res.status, 200, J(reqRes.res.body));
  assert.equal(reqRes.res.body.result.applied, true);
  const reqDoc = reqRes.res.body.result.document;
  assert.equal(reqDoc.kind, 'requirements');
  assert.equal(reqDoc.draft, false);

  let view = await prepView(svc, 'card-a');
  assert.equal(view.phase, 'requirements');
  assert.equal(view.presented.requirements.versionId, reqDoc.versionId);
  assert.equal(view.completeness.requirements, 'presented');
  assert.equal(view.completeness.design, 'absent');
  const intentSha = view.intent.current.sha256;

  const agg = await loadAggregate(svc.stateDir, 'card-a');
  const reqVer = agg.documents.requirements.versions.find((v) => v.versionId === reqDoc.versionId);
  assert.equal(reqVer.source.type, 'preparation');
  assert.equal(reqVer.source.sessionId, view.sessionId);
  assert.equal(reqVer.source.attemptId, reqRes.attemptId);
  assert.equal(reqVer.meta.intentSha256, intentSha, 'the version records the intent it was built under');
  assert.equal(reqVer.meta.bindingId, 'test-brainstorm', 'binding provenance recorded');
  assert.ok(reqVer.meta.bindingDigest && reqVer.meta.bindingConfigDigest, 'binding digests pinned');

  // Approve requirements — the plan stage is now legal.
  await approve(svc, 'card-a', 'approve_requirements', reqDoc);

  // The plan draft is produced only after acceptance, binds the EXACT
  // approved requirements version/hash.
  const planRes = await draftResult(svc, 'card-a', 'plan', {
    document: {
      kind: 'plan',
      text: `# Plan\n\n1. Update the label in src/a.js\n\n${PLAN_CHECKS_FENCE}`,
    },
  });
  assert.equal(planRes.res.status, 200, J(planRes.res.body));
  const planDoc = planRes.res.body.result.document;
  assert.equal(planDoc.kind, 'plan');
  assert.deepEqual(planDoc.requirements, { versionId: reqDoc.versionId, sha256: reqDoc.sha256 },
    'the imported plan must bind the approved requirements version/hash verbatim');

  const agg2 = await loadAggregate(svc.stateDir, 'card-a');
  const planVer = agg2.documents.plan.versions.find((v) => v.versionId === planDoc.versionId);
  assert.deepEqual(planVer.requirements, { versionId: reqDoc.versionId, sha256: reqDoc.sha256 });

  await approve(svc, 'card-a', 'approve_plan', planDoc);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));
  assert.equal(view.phase, 'ready');
  assert.equal(view.completeness.design, 'absent', 'design stayed optional for the small task');
  assert.equal(view.completeness.requirements, 'approved');
  assert.equal(view.completeness.plan, 'approved');
  assert.ok(view.package, 'a ready session exposes the accepted package');
  assert.equal(view.package.inputs.requirements.versionId, reqDoc.versionId);
  assert.equal(view.package.inputs.plan.versionId, planDoc.versionId);
  assert.equal(view.package.inputs.design, null);
  assert.equal(view.package.inputs.plan.checks.length, 1, 'the acp-checks block became the agreed checks');
  assert.deepEqual(
    view.handoffTargets.map((t) => [t.mode, t.implemented]),
    [['solo', true], ['fusion', true], ['orchestrator', true], ['swarm', true]]);
});

// ============================================================================
// Scenario 2 — AE2 complex task: requirements + design + plan; prior answers
// preserved in the package
// ============================================================================

test('P4-S2 AE2: complex task — design stage used; decisions/assumptions/answers survive', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'multi-tenant export pipeline with audit log',
    bindings: {
      intent: 'test-grill', requirements: 'test-brainstorm',
      design: 'test-arch', plan: 'test-plan',
    },
  });
  const view0 = await prepView(svc, 'card-a');
  const kickoff = view0.attempts.find((a) => a.kind === 'kickoff');

  // The lead's first turn: clarification questions + recorded decisions and
  // assumptions (the complex-task evidence trail).
  const res1 = await prepResult(svc, 'card-a', kickoff.attemptId, {
    questions: [{ text: 'Which tenants share the export queue?', blocking: true }],
    decisions: [{ text: 'Export format is CSV only for v1' }],
    assumptions: [{ text: 'The audit table exists already' }],
  });
  assert.equal(res1.status, 200, J(res1.body));
  const qid = res1.body.result.questions[0];
  assert.equal(res1.body.result.status, 'awaiting_answer');

  // Answering the question is durable — the package carries the answer.
  const ans = await ucmd(svc, 'card-a', 'answer_question', { questionId: qid, answer: 'tenant-a and tenant-b' });
  assert.equal(ans.status, 200, J(ans.json));

  const reqRes = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', text: '# Requirements\n\n- queue per tenant\n- audit log\n' },
  });
  assert.equal(reqRes.res.status, 200, J(reqRes.res.body));
  await approve(svc, 'card-a', 'approve_requirements', reqRes.res.body.result.document);

  // The design stage is exercised because material alternatives exist —
  // its version is its own artifact, gated independently.
  const desRes = await draftResult(svc, 'card-a', 'design', {
    document: { kind: 'design', text: '# Design\n\nAlternative A: shared queue.\nChoice: per-tenant worker.\n' },
  });
  assert.equal(desRes.res.status, 200, J(desRes.res.body));
  const desDoc = desRes.res.body.result.document;
  let view = await prepView(svc, 'card-a');
  assert.equal(view.presented.design.versionId, desDoc.versionId);
  assert.equal(view.completeness.design, 'presented',
    'a presented-but-ungated design is NOT "confirmed"');

  const planRes = await draftResult(svc, 'card-a', 'plan', {
    document: { kind: 'plan', text: `# Plan\n\n1. worker per tenant\n2. audit sink\n\n${PLAN_CHECKS_FENCE}` },
  });
  assert.equal(planRes.res.status, 200, J(planRes.res.body));
  const planDoc = planRes.res.body.result.document;
  await approve(svc, 'card-a', 'approve_plan', planDoc);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));
  assert.equal(view.completeness.design, 'confirmed', 'the design gate confirmed it');

  // Prior answers/decisions/assumptions are preserved on the session AND
  // shipped in the package context — no new interview needed downstream.
  const q = view.checkpoint.openQuestions.find((x) => x.questionId === qid);
  assert.equal(q.status, 'answered');
  assert.equal(q.answer, 'tenant-a and tenant-b');
  assert.equal(view.package.inputs.design.versionId, desDoc.versionId,
    'the package pins the design version too');
  assert.equal(view.package.context.restatement, view.intent.current.text);
  assert.ok(view.package.context.decisions.some((d) => d.text === 'Export format is CSV only for v1'));
  assert.ok(view.package.context.assumptions.some((a) => a.text === 'The audit table exists already'));
  assert.ok(view.package.context.openQuestions.some(
    (x) => x.questionId === qid && x.status === 'answered' && x.blocking === true));
});

// ============================================================================
// Scenario 3 — plan binding: no plan without ACCEPTED requirements; exact
// version/hash binding; stale explicit binding refused
// ============================================================================

test('P4-S3: a plan is never produced or accepted before requirements acceptance', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'plan gating',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
  });
  const view0 = await prepView(svc, 'card-a');
  const kickoff = view0.attempts.find((a) => a.kind === 'kickoff');

  // Produce-side: request_draft for a plan before acceptance is refused —
  // the session will not even mint the attempt.
  let r = await ucmd(svc, 'card-a', 'request_draft', { kind: 'plan' });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'requirements_unapproved');
  const attemptsBefore = (await prepView(svc, 'card-a')).attempts.length;

  // Import-side: a kickoff turn (no docKind contract) returning a plan is
  // refused BEFORE any version is written — the approval gate exists, the
  // result lands as an attempt failure, no document.
  const bad = await prepResult(svc, 'card-a', kickoff.attemptId, {
    document: { kind: 'plan', text: '# Sneaky plan\n' },
  });
  assert.equal(bad.status, 422, J(bad.body));
  assert.equal(bad.body.code, 'requirements_unapproved');
  let agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.documents.plan.versions.length, 0, 'no plan version was minted');
  assert.equal((await prepView(svc, 'card-a')).attempts.length, attemptsBefore,
    'no attempt was minted by the refused import either');

  // A requirements draft first — still unapproved: the plan gate holds.
  const reqRes = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', text: '# Requirements v1\n\n- scoped\n' },
  });
  assert.equal(reqRes.res.status, 200);
  r = await ucmd(svc, 'card-a', 'request_draft', { kind: 'plan' });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'requirements_unapproved',
    'a merely ATTACHED requirements version does not unlock the plan stage');

  // Acceptance flips the gate: the same draft request is now legal.
  const reqDoc = reqRes.res.body.result.document;
  await approve(svc, 'card-a', 'approve_requirements', reqDoc);
  const d = await ucmd(svc, 'card-a', 'request_draft', { kind: 'plan' });
  assert.equal(d.status, 200, J(d.json));
  const planAttempt = d.json.result.attemptId;

  // An explicit binding to a NON-approved requirements version is refused —
  // not silently rebound. (requirementsVersionId names a stale/draft pin.)
  const stale = await prepResult(svc, 'card-a', planAttempt, {
    document: {
      kind: 'plan',
      text: '# Plan bound to nothing approved\n',
      requirementsVersionId: 'v_does_not_exist',
    },
  });
  assert.equal(stale.status, 409, J(stale.body));
  assert.equal(stale.body.code, 'plan_binding_stale');

  // Naming the approved version explicitly binds it exactly.
  const okRes = await prepResult(svc, 'card-a', planAttempt, {
    document: {
      kind: 'plan',
      text: `# Plan for the accepted requirements\n\n${PLAN_CHECKS_FENCE}`,
      requirementsVersionId: reqDoc.versionId,
    },
  });
  assert.equal(okRes.status, 200, J(okRes.body));
  assert.deepEqual(okRes.body.result.document.requirements,
    { versionId: reqDoc.versionId, sha256: reqDoc.sha256 });
  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.documents.plan.versions.length, 1);
  assert.deepEqual(agg.documents.plan.versions[0].requirements,
    { versionId: reqDoc.versionId, sha256: reqDoc.sha256 });
});

// ============================================================================
// Scenario 4 — version/approval safety: drafts and prior-version approvals
// never permit start; approving v1 cannot approve v2
// ============================================================================

test('P4-S4: drafts and superseded versions never authorize start', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await savePreset(svc, 'card-a'); // composition exists — prep gate is the only blocker
  await mustStartPrep(svc, 'card-a', {
    intent: 'version safety',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
  });

  // v1 requirements lands as a draft import; draft alone is not accepted.
  const v1 = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', draft: true, text: '# Requirements v1 (draft)\n' },
  });
  assert.equal(v1.res.status, 200);
  const v1Doc = v1.res.body.result.document;
  assert.equal(v1Doc.draft, true);
  let view = await prepView(svc, 'card-a');
  assert.equal(view.completeness.requirements, 'draft');

  // Draft presented → start refuses; the CORE approval gate owns the
  // refusal (no requirements approval exists to even reach the prep gate).
  let st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 422, J(st.json));
  assert.equal(st.json.code, 'requirements_unapproved');
  assert.ok(blockerCodes(view).has('requirements_unapproved'));

  // Approve v1, then a plan bound to v1, then v2 requirements lands — the
  // v1 approvals must NOT carry forward.
  await approve(svc, 'card-a', 'approve_requirements', v1Doc);
  const p1 = await draftResult(svc, 'card-a', 'plan', {
    document: { kind: 'plan', text: `# Plan for v1\n\n${PLAN_CHECKS_FENCE}` },
  });
  assert.equal(p1.res.status, 200);
  await approve(svc, 'card-a', 'approve_plan', p1.res.body.result.document);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  assert.equal((await prepView(svc, 'card-a')).ready, true);

  // v2 requirements import — the new version revokes BOTH approvals; the
  // v1-bound plan is not approvable under v2.
  const v2 = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', text: '# Requirements v2 — scope changed\n' },
  });
  assert.equal(v2.res.status, 200);
  const v2Doc = v2.res.body.result.document;
  assert.notEqual(v2Doc.versionId, v1Doc.versionId);
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  const codes = blockerCodes(view);
  assert.ok(codes.has('requirements_unapproved'), J(view.blockers));
  assert.ok(codes.has('plan_unapproved'), J(view.blockers));
  assert.ok(codes.has('gate_reconfirm'), J(view.blockers));

  st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 422);
  assert.equal(st.json.code, 'requirements_unapproved',
    'the revoked approval fails at the core gate before the prep gate even runs');

  // Re-approving v1 is refused — it is no longer current (v1 approval can
  // never bless v2).
  let r = await ucmd(svc, 'card-a', 'approve_requirements',
    { versionId: v1Doc.versionId, sha256: v1Doc.sha256 });
  assert.equal(r.status, 409, J(r.json));
  assert.equal(r.json.code, 'stale_version');

  // The v1-bound plan cannot approve under v2 requirements — the binding is
  // checked at approval, not inherited.
  r = await ucmd(svc, 'card-a', 'approve_plan',
    { versionId: p1.res.body.result.document.versionId, sha256: p1.res.body.result.document.sha256 });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'requirements_unapproved',
    'plan approval is gated on an accepted requirements first');

  await approve(svc, 'card-a', 'approve_requirements', v2Doc);
  // Now the stale-bound plan fails the binding check explicitly.
  r = await ucmd(svc, 'card-a', 'approve_plan',
    { versionId: p1.res.body.result.document.versionId, sha256: p1.res.body.result.document.sha256 });
  assert.equal(r.status, 409, J(r.json));
  assert.equal(r.json.code, 'plan_binding_stale');

  // A fresh plan bound to v2 + re-confirmed gates restores readiness.
  const p2 = await draftResult(svc, 'card-a', 'plan', {
    document: { kind: 'plan', text: `# Plan for v2\n\n${PLAN_CHECKS_FENCE}` },
  });
  assert.equal(p2.res.status, 200);
  assert.deepEqual(p2.res.body.result.document.requirements,
    { versionId: v2Doc.versionId, sha256: v2Doc.sha256 });
  await approve(svc, 'card-a', 'approve_plan', p2.res.body.result.document);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'invalidated') await confirmGate(svc, 'card-a', g.gateId);
  }
  assert.equal((await prepView(svc, 'card-a')).ready, true, 'full re-acceptance restored readiness');
});

// ============================================================================
// Scenario 5 — SkillGate independence: approvals never substitute a gate
// confirmation of the exact presented subject
// ============================================================================

test('P4-S5: requirements/plan approvals do not bypass open intent/design gates', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await savePreset(svc, 'card-a');
  await mustStartPrep(svc, 'card-a', {
    intent: 'gate independence',
    bindings: {
      intent: 'test-grill', requirements: 'test-brainstorm',
      design: 'test-arch', plan: 'test-plan',
    },
  });

  const reqRes = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', text: '# Requirements\n\n- gated\n' },
  });
  const reqDoc = reqRes.res.body.result.document;
  const desRes = await draftResult(svc, 'card-a', 'design', {
    document: { kind: 'design', text: '# Design\n\nOne viable approach.\n' },
  });
  const desDoc = desRes.res.body.result.document;
  await approve(svc, 'card-a', 'approve_requirements', reqDoc);
  const planRes = await draftResult(svc, 'card-a', 'plan', {
    document: { kind: 'plan', text: `# Plan\n\n1. go\n\n${PLAN_CHECKS_FENCE}` },
  });
  const planDoc = planRes.res.body.result.document;
  await approve(svc, 'card-a', 'approve_plan', planDoc);

  // Every core approval is in place — readiness still blocks on the four
  // pending gates (intent + 3 artifact gates), and start refuses.
  let view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  const pend = view.blockers.filter((b) => b.code === 'gate_pending');
  assert.equal(pend.length, 4, J(view.blockers));
  let st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 422);
  assert.equal(st.json.code, 'preparation_not_ready');
  assert.ok((st.json.blockers || []).some((b) => b.code === 'gate_pending'));

  // The design gate binds THE presented design version — a confirm against
  // a different kind's subject is structurally impossible: confirm_gate
  // binds the gate's own declared subject.
  const desGate = view.gates.find((g) => g.stage === 'design' && g.status === 'pending');
  const c = await confirmGate(svc, 'card-a', desGate.gateId);
  assert.equal(c.subject.kind, 'document');
  assert.equal(c.subject.docKind, 'design');
  assert.equal(c.subject.versionId, desDoc.versionId);
  assert.equal(c.subject.sha256, desDoc.sha256,
    'the gate bound the EXACT design version presented — not a document-kind alias');
  view = await prepView(svc, 'card-a');
  assert.equal(view.completeness.design, 'confirmed');
  st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 422, 'remaining gates still block start');

  // The intent gate binds the CURRENT restatement hash.
  const intentGate = view.gates.find((g) => g.type === 'intent_confirm' && g.status === 'pending');
  const c2 = await confirmGate(svc, 'card-a', intentGate.gateId);
  assert.equal(c2.subject.kind, 'intent_restatement');
  assert.equal(c2.subject.sha256, view.intent.current.sha256);

  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));
});

// ============================================================================
// Scenario 6 — AE3: changed restatement/digest invalidates ONLY dependent
// gates; explicit reconfirmation required
// ============================================================================

test('P4-S6: restatement and binding changes invalidate only dependent gates', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await savePreset(svc, 'card-a');
  await mustStartPrep(svc, 'card-a', {
    intent: 'CSV export',
    bindings: {
      intent: 'test-grill', requirements: 'test-brainstorm',
      design: 'test-arch', plan: 'test-plan',
    },
  });
  const reqRes = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', text: '# Requirements\n\n- CSV\n' },
  });
  const reqDoc = reqRes.res.body.result.document;
  const desRes = await draftResult(svc, 'card-a', 'design', {
    document: { kind: 'design', text: '# Design\n\nstream writer\n' },
  });
  await approve(svc, 'card-a', 'approve_requirements', reqDoc);
  const planRes = await draftResult(svc, 'card-a', 'plan', {
    document: { kind: 'plan', text: `# Plan\n\n- build\n\n${PLAN_CHECKS_FENCE}` },
  });
  await approve(svc, 'card-a', 'approve_plan', planRes.res.body.result.document);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  assert.equal((await prepView(svc, 'card-a')).ready, true);

  // Changed restatement: intent gate + every document gate bound under the
  // old restatement invalidate; core approvals stand (documents unchanged).
  const restate = await ucmd(svc, 'card-a', 'continue_discussion', {
    intent: { restate: 'CSV AND JSON export' },
  });
  assert.equal(restate.status, 200, J(restate.json));
  assert.equal(restate.json.result.intentChanged, true);
  let view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  const codes = blockerCodes(view);
  assert.ok(codes.has('gate_reconfirm'), J(view.blockers));
  assert.ok(codes.has('artifact_stale'), J(view.blockers));
  let agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.approvals.requirements.versionId, reqDoc.versionId,
    'restatement alone never revokes document approvals');

  // Start remains blocked until every invalidated gate is re-confirmed
  // against the still-current presented subjects (reaffirm re-anchors the
  // artifacts to the new intent).
  let st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 422);
  assert.equal(st.json.code, 'preparation_not_ready');
  const reaff = await ucmd(svc, 'card-a', 'continue_discussion', { reaffirm: ['requirements', 'design', 'plan'] });
  assert.equal(reaff.status, 200, J(reaff.json));
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'invalidated') await confirmGate(svc, 'card-a', g.gateId);
  }
  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));

  // Binding digest drift: the assigned binding's pinned manifest digest no
  // longer matches the registry — readiness fails closed on the drifted
  // binding only.
  const reg = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
  const planB = reg.bindings.find((b) => b.bindingId === 'test-plan');
  await fs.appendFile(join(planB.skillDirs[0], 'helper.txt'), 'drift\n', 'utf-8');
  planB.resourceManifest = await buildManifest(planB);
  await fs.writeFile(registryPath, J(reg), 'utf-8');

  view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  const driftBlockers = view.blockers.filter((b) => b.code === 'binding_digest_changed');
  assert.equal(driftBlockers.length, 1, J(view.blockers));
  assert.equal(driftBlockers[0].bindingId, 'test-plan',
    'only the drifted binding is marked — independent gates stay confirmed');
  const intentGate = view.gates.find((g) => g.type === 'intent_confirm');
  assert.equal(intentGate.status, 'confirmed');
  st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 422);
  assert.equal(st.json.code, 'preparation_not_ready');

  // Explicit migration re-pins the digest; a FRESH gate must be confirmed —
  // the old confirmation is not inherited.
  const rebind = await ucmd(svc, 'card-a', 'change_skill_binding', {
    stage: 'plan', bindingId: 'test-plan',
  });
  assert.equal(rebind.status, 200, J(rebind.json));
  view = await prepView(svc, 'card-a');
  const fresh = view.gates.find((g) => g.bindingId === 'test-plan' && g.status === 'pending');
  assert.ok(fresh, 'repin minted a fresh pending gate');
  assert.equal(view.ready, false);
  await confirmGate(svc, 'card-a', fresh.gateId);
  assert.equal((await prepView(svc, 'card-a')).ready, true, 'explicit reconfirmation restored readiness');
});

// ============================================================================
// Scenario 7 — handoff: the accepted package offered to every named mode —
// recorded evidence, never a launch
// ============================================================================

test('P4-S7: handoff offers are durable and gate-checked — implementation never auto-starts', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await savePreset(svc, 'card-a');
  await mustStartPrep(svc, 'card-a', {
    intent: 'ship the export',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
  });

  // A handoff before any package exists refuses with the blocker list.
  let r = await ucmd(svc, 'card-a', 'handoff_preparation', { mode: 'solo' });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'preparation_not_ready');
  assert.ok(Array.isArray(r.json.blockers) && r.json.blockers.length > 0);

  // Unknown mode is a validation refusal, never a dispatch.
  r = await ucmd(svc, 'card-a', 'handoff_preparation', { mode: 'quantum' });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'invalid_argument');

  const reqRes = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', text: '# Requirements\n\n- ship it\n' },
    decisions: [{ text: 'single workspace' }],
  });
  const reqDoc = reqRes.res.body.result.document;
  await approve(svc, 'card-a', 'approve_requirements', reqDoc);
  const planRes = await draftResult(svc, 'card-a', 'plan', {
    document: { kind: 'plan', text: `# Plan\n\n- do it\n\n${PLAN_CHECKS_FENCE}` },
  });
  const planDoc = planRes.res.body.result.document;
  await approve(svc, 'card-a', 'approve_plan', planDoc);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc, 'card-a', g.gateId);
  }
  const view = await prepView(svc, 'card-a');
  assert.equal(view.ready, true, J(view.blockers));

  // Offer the accepted package to every named mode — each is recorded with
  // the frozen inputs; all four native consumers now exist in this build.
  const offered = {};
  for (const mode of ['solo', 'fusion', 'orchestrator', 'swarm']) {
    const h = await ucmd(svc, 'card-a', 'handoff_preparation', { mode });
    assert.equal(h.status, 200, `${mode}: ${J(h.json)}`);
    offered[mode] = h.json.result.handoff;
    assert.equal(h.json.result.reused, false);
    assert.equal(offered[mode].inputs.requirements.versionId, reqDoc.versionId);
    assert.equal(offered[mode].inputs.plan.versionId, planDoc.versionId);
    assert.equal(offered[mode].inputs.requirements.sha256, reqDoc.sha256);
    assert.equal(offered[mode].inputs.plan.checks.length, 1);
    assert.equal(offered[mode].inputs.intentSha256, view.intent.current.sha256);
    assert.ok(offered[mode].context.restatement.length > 0);
  }
  assert.equal(offered.solo.implemented, true);
  assert.equal(offered.fusion.implemented, true);
  assert.equal(offered.orchestrator.implemented, true);
  assert.equal(offered.swarm.implemented, true);

  // Recording offers minted NO run and NO implementation attempt — the
  // mode is data on the session, not a dispatch.
  let agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.runs.length, 0, 'handoff must never mint a run');
  assert.equal((agg.preparation.attempts || []).filter((a) => a.status === 'running').length, 0,
    'handoff mints no lead attempt either');

  // Re-offering the same mode against the same inputs is a no-op (reused),
  // and replaying the same commandId is a dedup hit.
  const again = await ucmd(svc, 'card-a', 'handoff_preparation', { mode: 'solo' });
  assert.equal(again.status, 200);
  assert.equal(again.json.result.reused, true);
  assert.equal(again.json.result.handoff.handoffId, offered.solo.handoffId);
  const cmdId = `ho-${randomUUID().slice(0, 6)}`;
  const c0 = (await getCard(svc, 'card-a')).json;
  const h1 = await cmd(svc, 'card-a', {
    commandId: cmdId, type: 'handoff_preparation',
    expectedControlRevision: c0.controlRevision, payload: { mode: 'fusion' },
  });
  assert.equal(h1.status, 200);
  const h2 = await cmd(svc, 'card-a', {
    commandId: cmdId, type: 'handoff_preparation',
    expectedControlRevision: c0.controlRevision + 99, payload: { mode: 'fusion' },
  });
  assert.equal(h2.status, 200);
  assert.equal(h2.json.idempotent, true);

  // A changed input marks the recorded offers stale — the view derives it,
  // nothing is silently re-pointed.
  const v2 = await draftResult(svc, 'card-a', 'requirements', {
    document: { kind: 'requirements', text: '# Requirements v2\n' },
  });
  assert.equal(v2.res.status, 200);
  const staleView = await prepView(svc, 'card-a');
  assert.equal(staleView.package, null, 'not ready → no package is exposed');
  for (const h of staleView.handoffs) {
    assert.equal(h.stale, true, `handoff ${h.mode} must read stale after the input change`);
  }
  // A fresh offer for the same mode supersedes the stale record rather than
  // pretending it still applies — after re-acceptance, of course.
  await approve(svc, 'card-a', 'approve_requirements', v2.res.body.result.document);
  const p2 = await draftResult(svc, 'card-a', 'plan', {
    document: { kind: 'plan', text: `# Plan v2\n\n${PLAN_CHECKS_FENCE}` },
  });
  await approve(svc, 'card-a', 'approve_plan', p2.res.body.result.document);
  for (const g of (await prepView(svc, 'card-a')).gates) {
    if (g.status === 'invalidated') await confirmGate(svc, 'card-a', g.gateId);
  }
  const h3 = await ucmd(svc, 'card-a', 'handoff_preparation', { mode: 'solo' });
  assert.equal(h3.status, 200);
  assert.equal(h3.json.result.reused, false);
  assert.notEqual(h3.json.result.handoff.handoffId, offered.solo.handoffId);
  const finalView = await prepView(svc, 'card-a');
  const oldSolo = finalView.handoffs.find((h) => h.handoffId === offered.solo.handoffId);
  assert.equal(oldSolo.supersededBy, h3.json.result.handoff.handoffId);

  // Handoff never consumed readiness: the real start seam still mints the
  // run through the core lifecycle — and only there.
  const st = await ucmd(svc, 'card-a', 'start');
  assert.equal(st.status, 200, `start should pass: ${J(st.json)}`);
  assert.ok(st.json.result.runId);
  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.runs.length, 1);
});

// ============================================================================
// Scenario 8 — Fusion return: a work order attached as a document is a NEW
// version, never auto-approved, presented to the session with provenance
// ============================================================================

// Minimal F3-style container runtime for a document run: panelists produce
// answers, the judge produces a work order. No canonical ops needed —
// resultKind 'document' never reaches the integrator.
function createDocRunRuntime({ behaviors = {} } = {}) {
  const calls = [];
  const records = new Map();
  const runs = new Map();
  let seq = 0;
  const behaviorOf = (attemptId) => {
    for (const [k, v] of Object.entries(behaviors)) {
      if (k !== 'default' && k.length && attemptId.includes(k)) return v;
    }
    return behaviors.default ?? {};
  };
  const finish = (run, { status = 'completed', exitCode = 0, runExitCode = 0, finalText = null } = {}) => {
    run.status = status;
    run.terminal = true;
    run.exitCode = exitCode;
    run.runExitCode = runExitCode;
    run.finalText = finalText ?? run.behavior.finalText ?? null;
    run.finishedAt = new Date().toISOString();
  };
  async function start(params = {}) {
    const { attemptId } = params;
    calls.push({ m: 'start', params });
    const b = behaviorOf(attemptId);
    const runId = `run_p${++seq}`;
    records.set(attemptId, {
      phase: 'launched', attemptId, porchRunId: runId,
      launch: { startedAt: new Date().toISOString() },
      worker: { workerId: `w-${attemptId}` },
    });
    const run = {
      runId, attemptId, workerId: `w-${attemptId}`,
      status: 'running', terminal: false, exitCode: null, runExitCode: null,
      finalText: null, behavior: b, materials: params.materials ?? null,
      startedAt: new Date().toISOString(),
    };
    runs.set(runId, run);
    if (!b.hang) {
      setTimeout(() => {
        if (!run.terminal) finish(run, { status: b.runStatus ?? 'completed' });
      }, b.runMs ?? 5).unref?.();
    }
    return {
      ok: true, phase: 'launched', attemptId,
      attemptDir: `/fake/attempt/${attemptId}`, workerId: run.workerId,
      artifactsDir: `/work/attempt/run-${attemptId}`,
      porchRunId: runId, error: null, recordPersisted: true,
    };
  }
  async function launchRecord(attemptId) {
    calls.push({ m: 'launchRecord', attemptId });
    const rec = records.get(attemptId);
    if (rec === undefined) return { attemptId, missing: true, corrupt: false };
    return { attemptId, missing: false, corrupt: false, record: structuredClone(rec) };
  }
  const runFor = (runId) => runs.get(runId) ?? null;
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  async function status(runId) {
    calls.push({ m: 'status', runId });
    const run = runFor(runId);
    if (!run) return { runId, ok: false, error: { code: 'unknown_run', message: 'no run' } };
    return {
      ok: true, runId, status: run.status, terminal: TERMINAL.has(run.status),
      exitCode: run.exitCode, error: run.error ?? null,
      workerId: run.workerId, attemptId: run.attemptId,
      startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
    };
  }
  async function events(runId, { cursor = 0 } = {}) {
    calls.push({ m: 'events', runId });
    const run = runFor(runId);
    if (!run) return { runId, ok: false, error: { code: 'unknown_run', message: 'no run' } };
    return {
      ok: true, runId, status: run.status, terminal: run.terminal,
      events: [], cursor, nextCursor: cursor, remaining: 0,
    };
  }
  async function wait(runId) {
    calls.push({ m: 'wait', runId });
    const run = runFor(runId);
    if (!run) {
      return { ok: true, outcome: 'error', error: { code: 'unknown_run', message: 'no run' } };
    }
    if (!run.terminal) {
      return { ok: true, outcome: 'timeout', runId, timedOut: true, terminal: false, status: run.status };
    }
    return {
      ok: true, outcome: 'terminal', runId, timedOut: false, terminal: true,
      status: run.status, exitCode: run.exitCode, runExitCode: run.runExitCode,
      error: run.error ?? null, finalText: run.finalText,
      finalAvailable: run.finalText !== null,
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      artifactsDir: `/work/attempt/run-${run.attemptId}`, cwd: '/work/project',
    };
  }
  async function cancel(runId) {
    calls.push({ m: 'cancel', runId });
    const run = runFor(runId);
    if (!run) return { runId, requested: false, error: { code: 'unknown_run', message: 'no run' } };
    setTimeout(() => {
      if (!run.terminal) finish(run, { status: 'cancelled', exitCode: 130, runExitCode: 130 });
    }, 2).unref?.();
    return { ok: true, runId, requested: true, workerId: run.workerId };
  }
  async function reconcile(match = {}) {
    calls.push({ m: 'reconcile', match });
    const attemptId = match.attemptId;
    const rec = attemptId ? records.get(attemptId) : null;
    const run = rec?.porchRunId ? runs.get(rec.porchRunId) : null;
    return {
      ok: true, scannedAt: new Date().toISOString(),
      matches: run ? [{ runId: run.runId, workerId: run.workerId, status: run.status, terminal: run.terminal }] : [],
      workers: [{ workerId: `w-${attemptId}`, state: run ? 'running' : 'gone', gone: !run }],
    };
  }
  function processIdentity(pid) {
    return { pid, exists: false, state: null, starttime: null, pidNs: 'ns-p4', readable: true };
  }
  return {
    start, launchRecord, status, events, wait, cancel, reconcile, processIdentity,
    workerIdForAttempt: (attemptId) => `w-${attemptId}`,
    _calls: calls, _records: records, _runs: runs,
    _finish: (runId, o) => { const r = runs.get(runId); if (r) finish(r, o); },
  };
}

function makeAnswer(tag) {
  return [
    `## Proposal\n\nAnswer from ${tag}: do X.\n`,
    `## Rationale\n\nBecause Y for ${tag}.\n`,
    `## Affected files\n\n- src/${tag}.js\n`,
    `## Downsides\n\nCost ${tag}.\n`,
    `## Excluded actions\n\nNo z ${tag}.\n`,
  ].join('\n');
}
function makeWorkOrder(verdict = 'in_plan', tag = 'wo') {
  return [
    '## Matches\n\nAll answers agree on the direction.\n',
    '## Contradictions\n\nNone material.\n',
    '## Gaps\n\nError handling is unspecified.\n',
    '## Unique ideas\n\nOne answer proposes caching.\n',
    '## Blind spots\n\nThe project has no test harness; verified by inspection.\n',
    '## Goal\n\nImplement the judged change for ' + tag + '.\n',
    '## Boundaries\n\nOnly src/ modules; no API surface changes.\n',
    '## Steps\n\n- add src/new-module.js\n- wire it into src/a.js\n',
    '## Affected parts\n\n- src/a.js\n- src/new-module.js\n',
    '## Criteria\n\n- the new module exists — verify: test -f src/new-module.js\n- tree builds — verify: node --check src/a.js\n',
    `## Verdict\n\n${verdict}\n`,
  ].join('\n');
}

function fusionProfile(model) {
  return {
    schemaVersion: 1,
    profileId: `prof-${model}`,
    pi: { version: '0.85.1' },
    image: 'worker',
    provider: 'zen-relay',
    model,
    skills: [],
    extensions: [],
    tools: ['read', 'bash'],
    search: { enabled: false, provider: null, params: {} },
    launch: { progress: 'none', extraFlags: [] },
    systemPromptFile: null,
  };
}
function mkPanelists(...profiles) {
  return profiles.map((profile, i) => ({ id: `p${i + 1}`, label: `Panelist ${i + 1}`, profile }));
}
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
let pidSeq = 74000;
function mkSched(env, { behaviors } = {}) {
  const instPid = ++pidSeq;
  const registry = {
    runs: new Map(), records: new Map(), usedAttempts: new Set(),
    procs: new Map(), unreadable: [], listFails: 0, seq: 0,
  };
  const procRuntime = createFakeRuntime({
    registry,
    rootDir: join(env.root, 'fake-exec'),
    environment: { pid: instPid, pidStarttime: `st-${instPid}`, pidNs: 'ns-p4' },
    behaviors: { default: { outcome: 'completed', delayMs: 4 } },
  });
  registry.procs.set(instPid, {
    exists: true, state: 'R', starttime: `st-${instPid}`, readable: true,
  });
  const contRuntime = createDocRunRuntime({ behaviors });
  const sched = createManagedScheduler({
    client: mkClient(env.svc, env.stateDir),
    runtime: procRuntime,
    runnerId: 'host-runner',
    instanceId: `inst-${randomUUID().slice(0, 8)}`,
    stateDir: env.stateDir,
    env: {
      ACP_WORKSPACE_DIR: join(env.root, 'wsroot'), ROOT_DIR: env.root,
      ACP_EXEC_VALIDATION: '1',
    },
    fusion: { runtime: contRuntime },
  });
  return { sched, runtime: contRuntime };
}
const runView = async (svc, runId) => (await getRun(svc, runId)).json;
async function driveUntil(svc, sched, runId, pred, { maxTicks = 80 } = {}) {
  let run = await runView(svc, runId);
  for (let i = 0; i < maxTicks && !pred(run); i += 1) {
    await sched.tick();
    await sleep(12);
    run = await runView(svc, runId);
  }
  return run;
}

test('P4-S8: a Fusion-returned work order mints a new unapproved version presented to the session', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'panel writes the spec',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
  });

  // The task doc the panel judges — presented to the session as usual.
  const taskDoc = await attachDoc(svc, 'card-a', 'requirements', '# Task: compare designs\n');
  const versionsBefore = (await loadAggregate(svc.stateDir, 'card-a'))
    .documents.requirements.versions.length;

  // A document fusion run: panelists answer, the judge writes a work order.
  const c0 = await getCard(svc, 'card-a');
  const startR = await cmd(svc, 'card-a', {
    commandId: `st-${randomUUID().slice(0, 6)}`, type: 'start',
    expectedControlRevision: c0.json.controlRevision,
    payload: {
      mode: 'fusion',
      fusion: {
        resultKind: 'document',
        task: { kind: 'requirements', versionId: taskDoc.versionId, sha256: taskDoc.sha256 },
        panelists: mkPanelists(fusionProfile('model-a'), fusionProfile('model-b')),
        judge: { profile: fusionProfile('model-judge') },
        limits: { maxAttemptsPerParticipant: 2, timeoutMin: 45 },
      },
    },
  });
  assert.equal(startR.status, 200, J(startR.json));
  const runId = startR.json.result.runId;

  const { sched } = mkSched(env, { behaviors: {
    'ja-': { runMs: 4, finalText: makeWorkOrder('in_plan', 'doc') },
    default: { runMs: 4, finalText: makeAnswer('x') },
  } });
  let run = await driveUntil(svc, sched, runId,
    (r) => r.status === 'blocked' && (r.fusion?.workOrders || []).length === 1);
  assert.equal(run.status, 'blocked',
    `run must park at the work-order gate: ${J({ st: run.status, ph: run.phase, fz: run.fusion?.pendingActions })}`);
  const wo = run.fusion.workOrders[0];
  assert.equal(wo.versionId, 'wo_v1');

  // The user accepts the work order — the run completes as a DOCUMENT
  // result; nothing on the card is approved by that acceptance.
  const card = await getCard(svc, 'card-a');
  let r = await cmd(svc, 'card-a', {
    commandId: `apw-${randomUUID().slice(0, 6)}`, type: 'approve_work_order',
    expectedControlRevision: card.json.controlRevision,
    payload: { runId, versionId: 'wo_v1', sha256: wo.sha256 },
  });
  assert.equal(r.status, 200, J(r.json));
  run = await runView(svc, runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.result.kind, 'document');
  let agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.approvals.requirements, null, 'work-order acceptance mints no approval');
  assert.equal(agg.documents.requirements.versions.length, versionsBefore,
    'acceptance alone does not mint a document version either');

  // Attaching the returned work order as a requirements document: a NEW
  // version bound to the artifact hash — unapproved, presented to the
  // session with work_order provenance.
  r = await ucmd(svc, 'card-a', 'attach_document', {
    kind: 'requirements',
    source: { type: 'work_order', runId, versionId: 'wo_v1' },
  });
  assert.equal(r.status, 200, J(r.json));
  const newDoc = r.json.result;
  assert.notEqual(newDoc.versionId, taskDoc.versionId);
  assert.equal(newDoc.attached.source.type, 'work_order');
  assert.equal(newDoc.attached.source.runId, runId);
  assert.equal(newDoc.attached.source.sha256, wo.sha256);

  agg = await loadAggregate(svc.stateDir, 'card-a');
  assert.equal(agg.documents.requirements.versions.length, versionsBefore + 1);
  assert.equal(agg.documents.requirements.current, newDoc.versionId);
  assert.ok(!agg.approvals.requirements || agg.approvals.requirements.versionId !== newDoc.versionId,
    'the Fusion-returned version is NEVER auto-approved');
  const blobRead = await getDoc(svc, 'card-a', newDoc.versionId);
  assert.equal(blobRead.status, 200);
  assert.equal(sha(blobRead.json.content), wo.sha256,
    'the imported document bytes hash to the work-order artifact hash');

  const view = await prepView(svc, 'card-a');
  assert.equal(view.presented.requirements.versionId, newDoc.versionId,
    'the session presents the Fusion-returned version');
  assert.equal(view.presented.requirements.sourceType, 'work_order',
    'provenance of the presented pointer is work_order');
  assert.equal(view.ready, false);
  assert.ok(blockerCodes(view).has('requirements_unapproved'), J(view.blockers));
});

// ============================================================================
// Scenario 9 — crash/restart/idempotency across P4 durable writes
// ============================================================================

test('P4-S9: crash between durable commit and projection flush heals; replays idempotent', async () => {
  const armed = new Set();
  const env = await mkEnv({ faults: { docNames: armed } });
  const { svc, projectDir, stateDir, registryPath, root } = env;
  await seedBase(svc, projectDir);
  await enable(svc);
  await savePreset(svc, 'card-a');
  const started = await mustStartPrep(svc, 'card-a', {
    intent: 'crash-safe import',
    bindings: { intent: 'test-grill', requirements: 'test-brainstorm', plan: 'test-plan' },
  });
  const sessionId = started.sessionId;

  // Arm the crash window: the prep_result commit sequence is
  //   blob write → aggregate save (command recorded, pendingWrites
  //   journaled) → board.json flush  ← injected fault lands HERE.
  const d = await ucmd(svc, 'card-a', 'request_draft', { kind: 'requirements' });
  assert.equal(d.status, 200);
  const attemptId = d.json.result.attemptId;
  // Capture the projection rev AFTER the draft command's own flush — only
  // the crashed command's staged board write may be missing.
  const boardRevBefore = (await readBoard(svc)).rev;
  armed.add('board.json');
  const prId = `pr-crash-${randomUUID().slice(0, 6)}`;
  // internalCommand rejects non-CommandError faults — model the crash as a
  // 500 the same way the HTTP surface would have formatted it.
  const crashed = await prepResult(svc, 'card-a', attemptId, {
    document: { kind: 'requirements', text: '# Imported under crash\n' },
  }, { commandId: prId }).then((r) => r, (e) => ({ status: 500, body: { error: String(e?.message ?? e) } }));
  assert.equal(crashed.status, 500, J(crashed.body));
  assert.match(crashed.body.error ?? '', /injected persistence fault/);

  // Post-crash durable truth: the command recorded its 200 outcome, the
  // version + presented pointer + terminal attempt all committed, and the
  // board_projection intent is journaled for repair.
  let agg = await loadAggregate(stateDir, 'card-a');
  const docV = agg.documents.requirements.current;
  assert.ok(docV, 'the imported version must be durable despite the crash');
  const docSha = agg.documents.requirements.versions.find((v) => v.versionId === docV).sha256;
  assert.equal(agg.preparation.presented.requirements.versionId, docV);
  const att = agg.preparation.attempts.find((a) => a.attemptId === attemptId);
  assert.equal(att.status, 'completed', 'the attempt outcome committed durably');
  assert.ok((agg.pendingWrites || []).some((i) => i.type === 'board_projection'));
  assert.equal(agg.commands[`i:${prId}`].status, 200,
    'the internal channel dedups under the i: namespace');
  const blob = await fs.readFile(
    join(stateDir, 'execution', 'state', 'blobs', `${docSha}.md`), 'utf-8');
  assert.equal(blob, '# Imported under crash\n');
  const boardAtCrash = JSON.parse(
    await fs.readFile(join(stateDir, 'board.json.json'), 'utf-8'));
  assert.equal(boardAtCrash.rev, boardRevBefore,
    'the board projection write is the crashed effect — it never landed');

  // ---- restart: a fresh service on the same stateDir repairs the intents.
  // svc2 carries its OWN armable fault set for the handoff crash below.
  const armed2 = new Set();
  const svc2 = await createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer2'),
      ACP_WORKSPACE_DIR: join(root, 'wsroot2'),
      ROOT_DIR: root,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    faults: { docNames: armed2 },
    features: { start: true, validation: true, fusion: true, preparation: true },
    preparation: { registryPath },
  });
  const boardAfter = await readBoard(svc2);
  assert.ok(boardAfter.rev > boardRevBefore, 'repair must land the projection');
  const row = boardAfter.data.cards.find((c) => c.id === 'card-a');
  assert.equal(row.preparation?.sessionId, sessionId);

  // Replay of the crashed result (identical payload) returns the recorded
  // outcome — it cannot re-import or double-mint a version. The same
  // commandId with a DIFFERENT payload conflicts, never silently applies.
  const replay = await svc2.internalCommand('card-a', {
    commandId: prId, type: 'prep_result',
    expectedInternalRevision: (await getCard(svc2, 'card-a')).json.internalRevision + 77,
    payload: { attemptId, result: { document: { kind: 'requirements', text: '# Imported under crash\n' } } },
  });
  assert.equal(replay.status, 200, J(replay.body));
  assert.equal(replay.body.idempotent, true);
  const conflict = await svc2.internalCommand('card-a', {
    commandId: prId, type: 'prep_result',
    expectedInternalRevision: (await getCard(svc2, 'card-a')).json.internalRevision,
    payload: { attemptId, result: { document: { kind: 'requirements', text: '# swapped payload\n' } } },
  });
  assert.equal(conflict.status, 409, J(conflict.body));
  assert.equal(conflict.body.code, 'command_conflict');
  agg = await loadAggregate(stateDir, 'card-a');
  assert.equal(agg.documents.requirements.versions.length, 1,
    'a replayed result must never mint a second version');
  const view = await prepView(svc2, 'card-a');
  assert.equal(view.ready, false, 'the recovered session is never phantom-ready');

  // Same crash boundary on handoff_preparation: arm the flush, record the
  // offer, crash after commit — the recorded offer is durable, replay is
  // idempotent.
  const reqDoc = view.presented.requirements;
  await approve(svc2, 'card-a', 'approve_requirements', reqDoc);
  const pd = await ucmd(svc2, 'card-a', 'request_draft', { kind: 'plan' });
  assert.equal(pd.status, 200, J(pd.json));
  const pRes = await prepResult(svc2, 'card-a', pd.json.result.attemptId, {
    document: { kind: 'plan', text: `# Plan\n\n${PLAN_CHECKS_FENCE}` },
  });
  assert.equal(pRes.status, 200, J(pRes.body));
  await approve(svc2, 'card-a', 'approve_plan', pRes.body.result.document);
  for (const g of (await prepView(svc2, 'card-a')).gates) {
    if (g.status === 'pending') await confirmGate(svc2, 'card-a', g.gateId);
  }
  assert.equal((await prepView(svc2, 'card-a')).ready, true);

  const hoId = `ho-crash-${randomUUID().slice(0, 6)}`;
  const cNow = (await getCard(svc2, 'card-a')).json;
  armed2.add('board.json');
  const crashedH = await cmd(svc2, 'card-a', {
    commandId: hoId, type: 'handoff_preparation',
    expectedControlRevision: cNow.controlRevision,
    payload: { mode: 'fusion' },
  });
  // The handoff's refreshProjection stages a board write — armed → 500.
  assert.equal(crashedH.status, 500, J(crashedH.json));
  agg = await loadAggregate(stateDir, 'card-a');
  const hoRec = (agg.preparation.handoffs || []).find((h) => h.mode === 'fusion');
  assert.ok(hoRec, 'the handoff offer is durable despite the projection crash');
  assert.equal(hoRec.inputs.plan.versionId, pRes.body.result.document.versionId);
  assert.equal(agg.commands[hoId].status, 200);

  // Restart repairs the projection; replay returns the recorded offer.
  const svc3 = await createStateService({
    stateDir,
    env: {
      PORCH_STEER_DIR: join(root, 'steer3'),
      ACP_WORKSPACE_DIR: join(root, 'wsroot3'),
      ROOT_DIR: root,
      ...(myUid !== null ? { ACP_EXEC_TOKEN_UID: String(myUid) } : {}),
      ...(myGid !== null ? { ACP_EXEC_TOKEN_GID: String(myGid) } : {}),
    },
    features: { start: true, validation: true, fusion: true, preparation: true },
    preparation: { registryPath },
  });
  const replayH = await cmd(svc3, 'card-a', {
    commandId: hoId, type: 'handoff_preparation',
    expectedControlRevision: 0,
    payload: { mode: 'fusion' },
  });
  assert.equal(replayH.status, 200, J(replayH.json));
  assert.equal(replayH.json.idempotent, true);
  assert.equal(replayH.json.result.handoff.handoffId, hoRec.handoffId);
  const v3 = await prepView(svc3, 'card-a');
  assert.equal(v3.handoffs.length, 1, 'the crashed+replayed handoff is still a single record');
  assert.equal(v3.ready, true);
});
