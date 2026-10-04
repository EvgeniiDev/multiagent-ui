// scripts/test_preparation_lead.mjs — P3 lead driver + durable discussion
// tests.   node --test scripts/test_preparation_lead.mjs
//
// Everything runs through createStateService's REAL request surface and
// serialized write queue. The lead is the production createPreparationLead
// driving an in-memory fake transport that emits the exact pi --mode rpc
// frame vocabulary (agent_start/turn_end/agent_end/extension_ui_request/
// get_state). Nothing is asserted off source text — every claim is a
// durable record, a fake-transport observation (prompts[]/responses[]), or
// a refused command.
//
// Scenarios (P3 brief):
//   S1  small/simple task — short route (unbound lead, minimal turns)
//   S2  complex task — additional distinctions (bound chat route, several
//       questions minted as prompt-channel records)
//   S3  accepted answers are never re-asked (dialog dedupe → the recorded
//       answer is delivered to the fresh request immediately)
//   S4  no-progress loop → explicit no_progress blocker, no more spawns
//   S5  human wait is not a runtime timeout (park >> turnTimeoutMs, then
//       answer lands cleanly)
//   S6  native dialog → matching extension_ui_response for the same
//       request id, no extra prompt
//   S7  a question the settled turn returned is answered through the NEXT
//       prompt (channel 'prompt')
//   S8  duplicate answer is idempotent — no hang, no double response
//   S9  supersede while a dialog is open — the dead request is never
//       answered, the old process is aborted, the new attempt drives on
//   S10 CLI loss with an open dialog — resume re-presents the question,
//       rebinds to a FRESH request id, the dead one is never answered
//   S11 foreign/cancelled attempts refuse (prep_result + answer_question)
//   S12 stop cancels ONLY the active attempt — transport aborted, durable
//       session stopped, drive reports session_stopped
//   S13 process/driver loss restores the durable checkpoint — a NEW lead
//       instance resumes the same discussion with prior answers in context
//   S14 binding change preserves intent + prior answers under ONE
//       discussion identity (same --name, new plan key)
//   S15 fail-closed: unsupported result channel → attempt failed with
//       nothing applied; assigned route gone candidate → route_unproven
//       blocker; workspace_artifact imports the REAL file; a document
//       claim with no artifact is dropped; blocker under 'completed'
//       outcome refused at the seam.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { loadAggregate } from '../server/execution/execution-store.mjs';
import { loadRegistry, buildManifest, verifyManifest } from '../server/execution/preparation/skills/registry.mjs';
import {
  createPreparationLead, serviceFromService, prepRunDirs, composeLeadPrompt,
} from '../server/execution/preparation/lead.mjs';
import { createFakePiTransport, fakeTransportFactory } from './fixtures/fake-pi-rpc.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('clarification prompt starts focused grilling from the existing card idea', () => {
  const prompt = composeLeadPrompt({
    view: { phase: 'clarify', intent: { raw: 'Reddit adapters: reuse the authenticated browser' } },
    attempt: { attemptId: 'kickoff', kind: 'kickoff' }, stage: 'intent', binding: null,
  });
  assert.match(prompt, /Reddit adapters: reuse the authenticated browser/);
  assert.match(prompt, /Do not ask the user to repeat or re-enter/);
  assert.match(prompt, /one focused question/);
  assert.match(prompt, /Challenge weak assumptions/);
  assert.match(prompt, /question-and-answer discussion, one question at a time/);
  assert.match(prompt, /Never start implementation/);
});

// ---- fixtures ---------------------------------------------------------------

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

async function mkProject() {
  const dir = join(tmpdir(), `p3-proj-${randomUUID().slice(0, 8)}`);
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

// Test SkillBinding registry — same data shape the production registry
// carries, pinned via the real buildManifest factory.
//   test-grill      intent, chat channel, conversation
//   test-grill-ui   intent, extension_ui channel + ask_user, conversation
//   test-grill-alt  intent, chat — binding-change target
//   test-plan-ws    plan, workspace_artifact → plan document (artifacts glob)
//   test-plan-conv  plan, conversation (importAs none — a document claim
//                   under it is off-contract)
//   test-candidate  intent, candidate (unproven route)
//   test-unsupported plan, unsupported (implementation_authority_denied)
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
    ['test-grill', 'intent', 'available', {
      questionChannel: 'chat', tools: ['read'],
      result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
      gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
    }],
    ['test-grill-ui', 'intent', 'available', {
      questionChannel: 'extension_ui', tools: ['read', 'ask_user'],
      result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
      gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
    }],
    ['test-grill-alt', 'intent', 'available', {
      questionChannel: 'chat', tools: ['read'],
      result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
      gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
    }],
    ['test-plan-ws', 'plan', 'available', {
      questionChannel: 'extension_ui', tools: ['read', 'write', 'ask_user'],
      result: { mode: 'workspace_artifact', docKind: 'plan', importAs: 'document', artifacts: ['plan.md', 'docs/plan.md'], handoffs: [] },
      gateContract: [{ type: 'artifact_confirm', stage: 'plan' }],
    }],
    ['test-plan-conv', 'plan', 'available', {
      questionChannel: 'chat', tools: ['read'],
      result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
      gateContract: [{ type: 'artifact_confirm', stage: 'plan' }],
    }],
    ['test-candidate', 'intent', 'candidate', {
      questionChannel: 'chat', tools: ['read'],
      result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
      gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
    }],
    ['test-unsupported', 'plan', 'unsupported', {
      unsupported: { reason: 'implementation_authority_denied', detail: 'test route', route: '' },
    }],
  ];
  const bindings = [];
  for (const [bindingId, stage, status, extra] of defs) {
    const b = {
      bindingId, stage, status,
      title: `Test ${bindingId}`,
      provider: 'test',
      adapterId: status === 'unsupported' ? undefined : 'pi-skill',
      adapterVersion: status === 'unsupported' ? undefined : 'pi-skill-1',
      skillDirs: [await mk(bindingId)],
      extraResources: [],
      questionChannel: extra.questionChannel ?? 'chat',
      tools: extra.tools ?? ['read'],
      requires: [],
      readOnlyRoots: [],
      skillNames: [bindingId],
      expect: { artifacts: [], frontmatter: {}, minChatQuestions: 0, minUiRequests: 0 },
      gateContract: extra.gateContract,
      result: extra.result,
      unsupported: extra.unsupported,
    };
    if (status !== 'unsupported') b.resourceManifest = await buildManifest(b);
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

async function mkEnv({ faults } = {}) {
  const root = join(tmpdir(), `p3-lead-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const stateDir = join(root, 'state');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
  const { registryPath } = await mkRegistry(root);
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

async function req(svc, method, path, body) {
  const q = new URL(path, 'http://t');
  return svc.request({
    method, path: q.pathname, query: q.searchParams,
    bodyText: body === undefined ? undefined : J(body),
  });
}
const putDoc = (svc, name, data, rev) => req(svc, 'PUT', `/api/state/${name}`, { data, rev });
const cmd = (svc, cardId, body) => req(svc, 'POST', `/api/execution/cards/${cardId}/commands`, body);
const getCard = (svc, id) => req(svc, 'GET', `/api/execution/cards/${id}`);
const getPrep = (svc, id) => req(svc, 'GET', `/api/execution/cards/${id}/preparation`);
const getDoc = (svc, id, versionId) => req(svc, 'GET', `/api/execution/cards/${id}/documents/${versionId}`);
const readAgg = async (stateDir, cardId) => loadAggregate(stateDir, cardId);

function cardFixture(id, over = {}) {
  return { id, title: id, stage: 'spec', status: 'in_progress', project: 'proj-x', order: 10, ...over };
}
async function seedBase(svc, projectDir, cards = [cardFixture('card-a')]) {
  const p = await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  assert.equal(p.status, 200, J(p.json));
  const b = await putDoc(svc, 'board.json', { version: 2, cards });
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
const prepView = async (svc, cardId) => {
  const r = await getPrep(svc, cardId);
  assert.equal(r.status, 200, J(r.json));
  return r.json.preparation;
};
async function startPrep(svc, cardId, payload) {
  const r = await ucmd(svc, cardId, 'start_preparation', payload);
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
async function answerQ(svc, cardId, questionId, answer) {
  return ucmd(svc, cardId, 'answer_question', { questionId, answer });
}
const prepResult = async (svc, cardId, attemptId, body) => {
  const card = (await getCard(svc, cardId)).json;
  return svc.internalCommand(cardId, {
    commandId: `pr-${randomUUID().slice(0, 8)}`,
    type: 'prep_result',
    expectedInternalRevision: card.internalRevision,
    payload: { attemptId, ...body },
  });
};

// The production lead driver over the REAL service seams; the only fake is
// the process transport (deterministic frame scripts per spawn).
function mkLead(svc, { root, registryPath, spawnScripts, limits = {} } = {}) {
  const spawns = [];
  const dirsRoot = join(root, 'lead-runs');
  const lead = createPreparationLead({
    service: serviceFromService(svc),
    registry: () => loadRegistry(registryPath),
    verify: (b) => verifyManifest(b),
    dirsFor: (view) => prepRunDirs(dirsRoot, view.sessionId),
    transportFactory: fakeTransportFactory(spawnScripts, spawns),
    limits: {
      idleTimeoutMs: 80, startTimeoutMs: 80, turnTimeoutMs: 1500,
      rpcTimeoutMs: 80, noProgressLimit: 2, maxRestarts: 2,
      ...limits,
    },
  });
  return { lead, spawns };
}

const PREP = (o) => '```acp-prep\n' + J(o) + '\n```';
const openQ = (view) => (view.checkpoint.openQuestions ?? []).filter((q) => q.status === 'open');

// ============================================================================
// S1 — small/simple task: the lead takes the short route, unbound, minimal turns
// ============================================================================

test('S1: small task — unbound lead drives a short route (2 turns)', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Add a one-line caption under the repo logo in README.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      // turn 1: one blocking question — the ONLY distinction needed
      { type: 'settle', text: PREP({ questions: [{ text: 'Caption text to use?', blocking: true }] }) },
      // turn 2: answer recorded → a decision and done
      { type: 'settle', text: PREP({ note: 'caption settled', decisions: ['caption: "Built with ACP"'] }) },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));          // parked on the question
  let view = await prepView(svc, 'card-a');
  assert.equal(openQ(view).length, 1);
  const q = openQ(view)[0];
  assert.equal(q.channel, 'prompt');

  const ans = await answerQ(svc, 'card-a', q.questionId, 'Built with ACP');
  assert.equal(ans.status, 200, J(ans.json));

  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));                  // turn applied, nothing live
  view = await prepView(svc, 'card-a');
  assert.equal(view.attempts.length, 1);                     // ONE kickoff attempt served both turns
  assert.equal(view.attempts[0].status, 'completed');
  assert.equal(view.checkpoint.decisions.length, 1);
  assert.equal(view.checkpoint.decisions[0].text, 'caption: "Built with ACP"');
  assert.equal(spawns.length, 1);                            // ONE process for the whole discussion
  assert.equal(spawns[0].prompts.length, 2);
  // one discussion identity — the pi --name is stable per session
  assert.match(spawns[0].plan.args.join(' '), /--name prep-prep_/);
  await lead.dispose();
});

// ============================================================================
// S2 — complex task: the bound chat route asks several distinctions; each is
//      a durable question answered through the next prompt.
// ============================================================================

test('S2: complex task — bound chat route requests additional distinctions', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', {
    intent: 'Rework the deployment pipeline for multi-region failover with staged rollouts.',
    bindings: { intent: 'test-grill' },
  });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      // turn 1: chat-style probe — the model ends ON a question (no block)
      { type: 'settle', text: 'Looking at the pipeline. Which regions are in scope for failover?' },
      // turn 2: second distinction
      { type: 'settle', text: PREP({ questions: [{ text: 'Rollback budget per stage — seconds or minutes?', blocking: true }] }) },
      // turn 3: enough — record the decisions
      { type: 'settle', text: PREP({ note: 'distinctions captured', decisions: ['regions: eu-west + us-east', 'rollback budget: minutes'] }) },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  let view = await prepView(svc, 'card-a');
  assert.equal(openQ(view).length, 1);
  // the plain-text question was minted as a durable prompt-channel question
  const q1 = openQ(view)[0];
  assert.match(q1.text, /regions.*scope/i);
  assert.equal(q1.channel, 'prompt');

  await answerQ(svc, 'card-a', q1.questionId, 'eu-west + us-east');
  out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  view = await prepView(svc, 'card-a');
  const q2 = openQ(view).find((q) => q.questionId !== q1.questionId);
  assert.ok(q2, 'second distinction must be a new durable question');

  await answerQ(svc, 'card-a', q2.questionId, 'minutes');
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));

  view = await prepView(svc, 'card-a');
  // ONE kickoff attempt on ONE process drove all three turns — the answers
  // rode the same durable discussion, no re-interview.
  assert.equal(view.attempts.length, 1);
  assert.equal(view.checkpoint.decisions.length, 2);
  // the answers rode in prompts — prompt 3 contains the recorded answers
  const p3 = spawns[0].prompts[2];
  assert.match(p3, /minutes/);
  // bound plan used the skill dir, not the lead plan
  assert.match(spawns[0].plan.args.join(' '), /--skill .*test-grill/);
  await lead.dispose();
});

// ============================================================================
// S3 — an already-answered question re-asked is never re-minted: the durable
//      record dedupes and the recorded answer answers the fresh rpc request.
// ============================================================================

test('S3: re-asked answered question dedupes — recorded answer, no second question', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Choose the store backing for the session cache.', discussionRef: 'sess-disc-1' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      // turn 1: native dialog — blocks mid-turn
      { type: 'dialog', dialog: { method: 'select', title: 'Which store: redis or sqlite?', options: ['redis', 'sqlite'] },
        after: { type: 'settle', text: PREP({ note: 'store chosen', decisions: ['store: redis'] }) } },
      // turn 2 (a new user instruction): the route re-asks THE SAME question —
      // the recorded answer must satisfy the fresh request immediately
      { type: 'dialog', dialog: { method: 'select', title: 'Which store: redis or sqlite?', options: ['redis', 'sqlite'] },
        after: { type: 'settle', text: PREP({ note: 'confirmed again' }) } },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  let view = await prepView(svc, 'card-a');
  assert.equal(openQ(view).length, 1);
  const q = openQ(view)[0];
  assert.equal(q.channel, 'dialog');
  assert.equal(q.dialog.method, 'select');
  assert.deepEqual(q.dialog.options, ['redis', 'sqlite']);

  await answerQ(svc, 'card-a', q.questionId, 'redis');
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));

  // new user instruction mints attempt 2; the route re-asks the same text
  const r = await ucmd(svc, 'card-a', 'continue_discussion', { text: 'double-check the choice' });
  assert.equal(r.status, 200, J(r.json));
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));   // turn finished — never parked

  view = await prepView(svc, 'card-a');
  const all = view.checkpoint.openQuestions;
  assert.equal(all.length, 1, 'the re-asked question must dedupe to the same record');
  assert.equal(all[0].status, 'answered');
  assert.equal(all[0].answer, 'redis');
  // the SECOND dialog — on the SAME durable discussion process — got the
  // recorded answer via extension_ui_response, no re-ask
  assert.equal(spawns.length, 1, 'the new attempt continues the same discussion process');
  assert.equal(spawns[0].responses.length, 2);
  assert.equal(spawns[0].responses[1].fields.value, 'redis');
  await lead.dispose();
});

// ============================================================================
// S4 — repeated no-progress turns end with an explicit blocker, no new spawn
// ============================================================================

test('S4: consecutive no-progress turns → no_progress blocker, no further spawn', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Something ambiguous.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      // every turn reports a bare note — nothing new (progress=false)
      { type: 'settle', text: PREP({ note: 'still thinking' }) },
      { type: 'settle', text: PREP({ note: 'still thinking' }) },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  let view = await prepView(svc, 'card-a');
  assert.equal(view.attempts[0].status, 'completed');
  assert.equal(view.attempts[0].progress, false);

  // user nudges → turn 2, also empty
  const r1 = await ucmd(svc, 'card-a', 'continue_discussion', { text: 'any progress?' });
  assert.equal(r1.status, 200, J(r1.json));
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  view = await prepView(svc, 'card-a');
  assert.equal(view.attempts[1].progress, false);

  // third attempt — the driver must refuse to burn another turn:
  // no_progress blocker, delivered WITHOUT spawning a new process
  const r2 = await ucmd(svc, 'card-a', 'continue_discussion', { text: 'still?' });
  assert.equal(r2.status, 200, J(r2.json));
  const nSpawns = spawns.length;
  out = await lead.drive('card-a');
  assert.equal(out.status, 'blocked', J(out));
  assert.equal(out.reason, 'no_progress');
  assert.equal(spawns.length, nSpawns, 'no new CLI process for the blocked turn');

  view = await prepView(svc, 'card-a');
  assert.equal(view.attempts[2].status, 'blocked');
  assert.equal(view.blocker?.code, 'no_progress');
  assert.match(view.blocker.detail, /no new/);
  await lead.dispose();
});

// ============================================================================
// S5 — a human thinking is not a runtime timeout
// ============================================================================

test('S5: human wait over a dialog outlives turnTimeoutMs — no timeout', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Pick a migration order.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    limits: { turnTimeoutMs: 120 },   // deliberately tiny
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'input', title: 'First service to migrate?' },
        after: { type: 'settle', text: PREP({ note: 'order settled', decisions: ['first: auth'] }) } },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  const view = await prepView(svc, 'card-a');
  const q = openQ(view)[0];

  // the user thinks FAR longer than the turn budget — no timer is running
  // against them; the transport is parked, not timed out
  await sleep(300);
  out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));   // still parked, not failed

  const ans = await answerQ(svc, 'card-a', q.questionId, 'auth');
  assert.equal(ans.status, 200, J(ans.json));
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  assert.equal(spawns[0].responses.length, 1);
  assert.equal(spawns[0].responses[0].fields.value, 'auth');
  await lead.dispose();
});

// ============================================================================
// S6 — mid-turn native dialog gets a matching extension_ui_response; the
//      answer never becomes a stray prompt
// ============================================================================

test('S6: dialog answer routes to the same rpc request id — no extra prompt', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Confirm the migration window.', bindings: { intent: 'test-grill-ui' } });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'confirm', title: 'Deploy during the Friday window?' },
        after: { type: 'settle', text: PREP({ note: 'confirmed', decisions: ['friday window: yes'] }) } },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  const view = await prepView(svc, 'card-a');
  const q = openQ(view)[0];
  const reqId = q.dialog.requestId;

  await answerQ(svc, 'card-a', q.questionId, 'yes');
  const nPrompts = spawns[0].prompts.length;
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  // the answer went to the SAME request id on the SAME process
  assert.deepEqual(spawns[0].responses, [{ id: reqId, fields: { confirmed: true, value: 'yes' } }]);
  // no extra prompt was sent — the response was the answer's only carrier
  assert.equal(spawns[0].prompts.length, nPrompts);
  await lead.dispose();
});

// ============================================================================
// S7 — a question the settled turn returned rides the NEXT prompt
// ============================================================================

test('S7: post-turn question is answered through the next prompt', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Name the new audit artifact.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      { type: 'settle', text: PREP({ questions: [{ text: 'Artifact filename?', blocking: true }] }) },
      { type: 'settle', text: PREP({ note: 'named', decisions: ['artifact: audit-report.md'] }) },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  const view = await prepView(svc, 'card-a');
  const q = openQ(view)[0];
  assert.equal(q.channel, 'prompt');

  await answerQ(svc, 'card-a', q.questionId, 'audit-report.md');
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  // the answer was carried in the NEXT prompt — never as a ui response
  assert.equal(spawns[0].prompts.length, 2);
  assert.match(spawns[0].prompts[1], /audit-report\.md/);
  assert.match(spawns[0].prompts[1], /Artifact filename\?/);
  assert.equal(spawns[0].responses.length, 0);
  await lead.dispose();
});

// ============================================================================
// S8 — duplicate answers are idempotent; the parked turn does not hang
// ============================================================================

test('S8: duplicate answer is a replay — single durable answer, one response', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Pick the cache TTL.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'input', title: 'TTL seconds?' },
        after: { type: 'settle', text: PREP({ note: 'ttl chosen', decisions: ['ttl: 300'] }) } },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  const view = await prepView(svc, 'card-a');
  const q = openQ(view)[0];

  const a1 = await answerQ(svc, 'card-a', q.questionId, '300');
  assert.equal(a1.status, 200, J(a1.json));
  const a2 = await answerQ(svc, 'card-a', q.questionId, '300');   // same retry
  assert.equal(a2.status, 200, J(a2.json));
  assert.equal(a2.json.result.alreadyAnswered, true);
  // a DIFFERENT answer on the closed question is refused — no silent rewrite
  const a3 = await answerQ(svc, 'card-a', q.questionId, '600');
  assert.equal(a3.status, 409, J(a3.json));
  assert.equal(a3.json.code, 'question_closed');

  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  assert.equal(spawns[0].responses.length, 1);                  // one response only
  assert.equal(spawns[0].responses[0].fields.value, '300');
  const after = await prepView(svc, 'card-a');
  const rec = after.checkpoint.openQuestions[0];
  assert.equal(rec.answer, '300');
  await lead.dispose();
});

// ============================================================================
// S9 — superseding the parked attempt never lets the dead dialog answer
// ============================================================================

test('S9: supersede with open dialog — dead request unanswered, new attempt drives', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Choose the queue.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [
      [ // attempt 1 — parks on a dialog forever (after: null → stays blocked)
        { type: 'dialog', dialog: { method: 'select', title: 'sqs or kafka?', options: ['sqs', 'kafka'] }, after: null },
      ],
      [ // attempt 2 — answers the superseding instruction cleanly
        { type: 'settle', text: PREP({ note: 'kafka chosen', decisions: ['queue: kafka'] }) },
      ],
    ],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  let view = await prepView(svc, 'card-a');
  const deadReqId = openQ(view)[0].dialog.requestId;

  // the user supersedes — a new attempt minted, the parked one cancelled
  const r = await ucmd(svc, 'card-a', 'continue_discussion', { text: 'scratch that — use kafka' });
  assert.equal(r.status, 200, J(r.json));
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));

  // the stale process was aborted+closed; its pending rpc got NO response
  assert.equal(spawns[0].aborted(), true);
  assert.equal(spawns[0].alive(), false);
  assert.deepEqual(spawns[0].responses, []);
  // attempt 1 cancelled; its question stays open as evidence but is dead
  view = await prepView(svc, 'card-a');
  const a1 = view.attempts[0];
  assert.equal(a1.status, 'cancelled');
  const a2 = view.attempts[1];
  assert.equal(a2.status, 'completed');
  // and answering the DEAD attempt's question is refused — stale_attempt
  const q = view.checkpoint.openQuestions.find((x) => x.attemptId === a1.attemptId);
  const refused = await answerQ(svc, 'card-a', q.questionId, 'sqs');
  assert.equal(refused.status, 409, J(refused.json));
  assert.equal(refused.json.code, 'stale_attempt');
  // a fresh spawn drove attempt 2 — same discussion, never a new interview
  assert.equal(spawns.length, 2);
  assert.match(spawns[1].prompts[0], /replaced\/restarted/);   // resume framing
  await lead.dispose();
});

// ============================================================================
// S10 — CLI loss with an open dialog: resume re-asks and rebinds; the dead
//       request id is never answered
// ============================================================================

test('S10: CLI loss mid-dialog — rebind to a fresh request id on resume', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Pick the auth library.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [
      [ { type: 'dialog', dialog: { method: 'select', title: 'jwt lib?', options: ['jose', 'jsonwebtoken'] }, after: null } ],
      // after the restart the skill re-asks via ask_user — a FRESH rpc id —
      // then settles once answered
      [ { type: 'dialog', dialog: { method: 'select', title: 'jwt lib?', options: ['jose', 'jsonwebtoken'] },
          after: { type: 'settle', text: PREP({ note: 'jose chosen', decisions: ['jwt: jose'] }) } } ],
    ],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  const view1 = await prepView(svc, 'card-a');
  const q = openQ(view1)[0];
  const deadReqId = q.dialog.requestId;

  // CLI process dies while the dialog is parked
  await spawns[0].close();
  assert.equal(spawns[0].alive(), false);

  out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));          // parked on the rebound dialog
  assert.equal(spawns.length, 2, 'a fresh process resumed the discussion');
  const view2 = await prepView(svc, 'card-a');
  const q2 = openQ(view2).find((x) => x.questionId === q.questionId);
  assert.ok(q2, 'the same durable question record');
  assert.notEqual(q2.dialog.requestId, deadReqId, 'rebound to the fresh rpc id');
  assert.equal(spawns[1].responses.length, 0);
  // the resume prompt re-presented the open question
  assert.match(spawns[1].prompts[0], /jwt lib\?/);

  await answerQ(svc, 'card-a', q.questionId, 'jose');
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  // the answer went to the FRESH process's request id — the dead process
  // never received a response
  assert.equal(spawns[1].responses.length, 1);
  assert.equal(spawns[1].responses[0].fields.value, 'jose');
  assert.equal(spawns[0].responses.length, 0);
  await lead.dispose();
});

// ============================================================================
// S11 — foreign/cancelled attempts refuse: stale answers never mutate
// ============================================================================

test('S11: results and answers on dead/foreign attempts are refused', async () => {
  const { svc, projectDir, root, registryPath, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Two quick prompts then done.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [
      [ { type: 'settle', text: PREP({ questions: [{ text: 'Pick A or B?', blocking: true }] }) } ],
      [ { type: 'settle', text: PREP({ note: 'done' }) } ],
    ],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  let view = await prepView(svc, 'card-a');
  const a1 = view.attempts[0];
  const q = openQ(view)[0];

  // a foreign attempt id is ignored — applied:false, nothing written
  const bogus = await prepResult(svc, 'card-a', 'attempt_zz_foreign', { result: { note: 'x' } });
  assert.equal(bogus.status, 200, J(bogus.body));
  assert.equal(bogus.body.result.applied, false);
  assert.equal(bogus.body.result.reason, 'attempt_unknown');

  // supersede: attempt 1 cancelled → a late prep_result for it is ignored,
  // its open question's answer is refused
  await ucmd(svc, 'card-a', 'continue_discussion', { text: 'skip it' });
  const late = await prepResult(svc, 'card-a', a1.attemptId, { result: { decisions: ['smuggle'] } });
  assert.equal(late.status, 200, J(late.body));
  assert.equal(late.body.result.applied, false);
  assert.equal(late.body.result.reason, 'attempt_cancelled');
  const staleAnswer = await answerQ(svc, 'card-a', q.questionId, 'B');
  assert.equal(staleAnswer.status, 409);
  assert.equal(staleAnswer.json.code, 'stale_attempt');

  // the live attempt still drives to completion — nothing crossed over
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  const agg = await readAgg(stateDir, 'card-a');
  const cancelled = agg.preparation.attempts.find((a) => a.attemptId === a1.attemptId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(agg.preparation.checkpoint.decisions.length, 0, 'no smuggled decision');
  assert.equal(cancelled.result?.decisions, undefined, 'the late result applied nothing');
  await lead.dispose();
});

// ============================================================================
// S12 — stop cancels ONLY the active attempt; transport aborted; drive reports
// ============================================================================

test('S12: stop_preparation cancels the active attempt; lead.stop aborts its process', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Park me mid-dialog.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'input', title: 'still there?' }, after: null },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));

  const stopped = await ucmd(svc, 'card-a', 'stop_preparation', { reason: 'user asked' });
  assert.equal(stopped.status, 200, J(stopped.json));
  assert.equal(stopped.json.result.status, 'stopped');
  assert.equal(stopped.json.result.cancelledAttempts.length, 1);

  // the driver-level stop aborts only this card's transport
  const st = await lead.stop('card-a');
  assert.equal(st.stopped, true);
  assert.equal(spawns[0].aborted(), true);
  assert.equal(spawns[0].alive(), false);

  out = await lead.drive('card-a');
  assert.equal(out.status, 'session_stopped', J(out));
  const view = await prepView(svc, 'card-a');
  assert.equal(view.status, 'stopped');
  assert.equal(view.attempts[0].status, 'cancelled');
  // the pending dialog was never answered
  assert.equal(spawns[0].responses.length, 0);
  await lead.dispose();
});

// ============================================================================
// S13 — driver/process loss: a NEW lead instance resumes from the durable
//       checkpoint with prior answers in context
// ============================================================================

test('S13: restart restores the checkpoint — new driver resumes same discussion', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Sketch the import format.' });

  const spawns = [];
  const mk = (scripts) => createPreparationLead({
    service: serviceFromService(svc),
    registry: () => loadRegistry(registryPath),
    verify: (b) => verifyManifest(b),
    dirsFor: (view) => prepRunDirs(join(root, 'lead-runs'), view.sessionId),
    transportFactory: fakeTransportFactory(scripts, spawns),
    limits: { idleTimeoutMs: 80, turnTimeoutMs: 1500, rpcTimeoutMs: 80 },
  });

  // driver #1: one Q answered, one decision recorded, then "the host dies"
  const lead1 = mk([[
    { type: 'settle', text: PREP({ questions: [{ text: 'CSV or JSON?', blocking: true }] }) },
    { type: 'settle', text: PREP({ note: 'csv', decisions: ['format: CSV'] }) },
  ]]);
  let out = await lead1.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  let view = await prepView(svc, 'card-a');
  const q = openQ(view)[0];
  await answerQ(svc, 'card-a', q.questionId, 'JSON');
  out = await lead1.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  await lead1.dispose();
  await spawns[0].close();                                    // the CLI process dies too

  // user instruction → a new attempt; a FRESH lead instance (no memory) must
  // resume from the durable checkpoint — same discussion name, full context
  await ucmd(svc, 'card-a', 'continue_discussion', { text: 'now the columns' });
  const lead2 = mk([[
    { type: 'settle', text: PREP({ note: 'columns decided', decisions: ['columns: name,ts,value'] }) },
  ]]);
  out = await lead2.drive('card-a');
  assert.equal(out.status, 'idle', J(out));

  assert.equal(spawns.length, 2);
  const resume = spawns[1].prompts[0];
  assert.match(resume, /replaced\/restarted/);                 // resume framing
  assert.match(resume, /format: CSV/);                         // durable decisions
  assert.match(resume, /JSON/);                                // the recorded answer
  assert.match(resume, /CSV or JSON\?/);                       // the question text
  // one discussion identity across CLI/driver change — same --name
  const nameOf = (t) => t.plan.args[t.plan.args.indexOf('--name') + 1];
  assert.equal(nameOf(spawns[0]), nameOf(spawns[1]));
  const after = await prepView(svc, 'card-a');
  assert.equal(after.checkpoint.decisions.length, 2);
  await lead2.dispose();
});

// ============================================================================
// S14 — binding change preserves intent and prior answers; the discussion
//       identity (--name) is unchanged
// ============================================================================

test('S14: change_skill_binding keeps intent/answers under one discussion name', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Choose the rendering stack.', bindings: { intent: 'test-grill' } });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [
      [ { type: 'settle', text: PREP({ questions: [{ text: 'SSR or CSR?', blocking: true }] }) },
        { type: 'settle', text: PREP({ note: 'ssr', decisions: ['render: SSR'] }) } ],
      [ { type: 'settle', text: PREP({ note: 'continued under new skill', decisions: ['hydrate on idle'] }) } ],
    ],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  const view = await prepView(svc, 'card-a');
  await answerQ(svc, 'card-a', openQ(view)[0].questionId, 'SSR');
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  assert.match(spawns[0].plan.args.join(' '), /--skill .*test-grill\b/);

  // user swaps the intent-stage skill — the discussion continues
  const ch = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'intent', bindingId: 'test-grill-alt' });
  assert.equal(ch.status, 200, J(ch.json));
  await ucmd(svc, 'card-a', 'continue_discussion', { text: 'and hydration?' });
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));

  assert.equal(spawns.length, 2);                              // new plan → new process
  assert.match(spawns[1].plan.args.join(' '), /--skill .*test-grill-alt/);
  const nameOf = (t) => t.plan.args[t.plan.args.indexOf('--name') + 1];
  assert.equal(nameOf(spawns[0]), nameOf(spawns[1]), 'one discussion identity');
  // the new process's first prompt carries the durable record — never a
  // fresh interview
  assert.match(spawns[1].prompts[0], /SSR or CSR\?/);
  assert.match(spawns[1].prompts[0], /→ SSR|SSR\b.*answered|answer.*SSR/i);
  const after = await prepView(svc, 'card-a');
  assert.equal(after.intent.raw, 'Choose the rendering stack.');
  assert.equal(after.checkpoint.decisions.length, 2);
  assert.equal(after.bindings.intent.bindingId, 'test-grill-alt');
  await lead.dispose();
});

// ============================================================================
// S15 — fail-closed boundaries
// ============================================================================

test('S15a: unsupported result channel fails the turn closed — nothing applied', async () => {
  const { svc, projectDir, root, registryPath, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Try to smuggle a command channel.' });

  const { lead } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      { type: 'settle', text: PREP({ note: 'ok', commands: [{ type: 'start_run' }], toolCalls: ['rm -rf /'] }) },
    ]],
  });

  const out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));           // the failed result itself applied
  const agg = await readAgg(stateDir, 'card-a');
  const att = agg.preparation.attempts[0];
  assert.equal(att.status, 'failed');
  assert.match(att.result.error, /result_channel_unsupported/);
  assert.equal(agg.preparation.checkpoint.decisions.length, 0);
  assert.equal(agg.preparation.checkpoint.openQuestions.length, 0);
  await lead.dispose();
});

test('S15b: assigned route gone candidate → route_unproven blocker, no spawn', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Drive an unproven route.', bindings: { intent: 'test-grill' } });

  const { lead, spawns } = mkLead(svc, { root, registryPath, spawnScripts: [[{ type: 'settle', text: 'x' }]] });

  // the registry republishes the route as unproven — the drive must refuse
  const reg = await loadRegistry(registryPath);
  const b = reg.bindings.find((x) => x.bindingId === 'test-grill');
  b.status = 'candidate';
  await fs.writeFile(registryPath, J({ schemaVersion: 1, pi: { binary: 'pi', version: '0.85.1' }, bindings: reg.bindings }), 'utf-8');

  const out = await lead.drive('card-a');
  assert.equal(out.status, 'blocked', J(out));
  assert.equal(out.reason, 'route_unproven');
  assert.equal(spawns.length, 0, 'no process for a refused route');
  const view = await prepView(svc, 'card-a');
  assert.equal(view.blocker?.code, 'route_unproven');
  assert.equal(view.attempts[0].status, 'blocked');
  await lead.dispose();
});

test('S15c: workspace_artifact imports the REAL file; a bare claim is dropped', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Draft a rollout plan.', bindings: { plan: 'test-plan-ws' } });

  const spawns = [];
  const docText = '# Rollout Plan\n\n1. canary 5%\n2. stage 50%\n3. full\n';
  const lead = createPreparationLead({
    service: serviceFromService(svc),
    registry: () => loadRegistry(registryPath),
    verify: (b) => verifyManifest(b),
    dirsFor: (view) => prepRunDirs(join(root, 'lead-runs'), view.sessionId),
    transportFactory: fakeTransportFactory([
      // turn: the skill writes the REAL artifact then settles with a note
      [ (ctx) => {
          writeFileSync(join(ctx.spawnCtx.dirs.workspace, 'plan.md'), docText, 'utf-8');
          return { type: 'settle', text: PREP({ note: 'plan written to workspace' }) };
        },
        // second turn, same process: a document CLAIM with no artifact —
        // the claim is dropped, never imported
        { type: 'settle', text: PREP({ note: 'imaginary plan', document: { kind: 'plan', text: '# FAKE\n' } }) } ],
    ], spawns),
    limits: { idleTimeoutMs: 80, turnTimeoutMs: 1500, rpcTimeoutMs: 80 },
  });

  // P4: a plan draft requires an accepted requirements version first —
  // attach + approve one so the plan stage is legal.
  const req = await ucmd(svc, 'card-a', 'attach_document', {
    kind: 'requirements',
    source: { type: 'text', text: '# Requirements\n\nRoll out gradually.\n' },
  });
  assert.equal(req.status, 200, J(req.json));
  const appr = await ucmd(svc, 'card-a', 'approve_requirements', {
    versionId: req.json.result.versionId, sha256: req.json.result.sha256,
  });
  assert.equal(appr.status, 200, J(appr.json));

  // a draft attempt binds the turn to the plan stage's contract
  const draft = await ucmd(svc, 'card-a', 'request_draft', { kind: 'plan' });
  assert.equal(draft.status, 200, J(draft.json));
  const draftAttemptId = draft.json.result.attemptId;

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  let view = await prepView(svc, 'card-a');
  assert.ok(view.presented.plan, 'the real artifact must be imported');
  const got = await getDoc(svc, 'card-a', view.presented.plan.versionId);
  assert.equal(got.status, 200, J(got.json));
  assert.equal(got.json.content, docText, 'imported content is the file, byte for byte');

  // kickoff attempt had no stage binding; the draft did the work
  // now: a document claim WITHOUT the file is dropped with a note marker
  const d2 = await ucmd(svc, 'card-a', 'request_draft', { kind: 'plan' });
  assert.equal(d2.status, 200, J(d2.json));
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  const agg = await readAgg(join(root, 'state'), 'card-a');
  const att2 = agg.preparation.attempts.find((a) => a.attemptId === d2.json.result.attemptId);
  assert.equal(att2.status, 'completed');
  assert.equal(att2.result.document, null, 'the claim was dropped — no artifact existed');
  assert.match(att2.result.note, /dropped document claim/);
  // presented.plan still the first import — the fake claim changed nothing
  view = await prepView(svc, 'card-a');
  assert.equal(view.presented.plan.versionId, got.json.versionId);
  await lead.dispose();
});

test('S15d: a blocker under a non-blocked outcome is refused at the seam', async () => {
  const { svc, projectDir, root, registryPath, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Block without blocking.' });
  const view = await prepView(svc, 'card-a');
  const a1 = view.attempts[0];

  // outcome 'completed' + blocker → refused 422 at the durable seam
  const r = await prepResult(svc, 'card-a', a1.attemptId, {
    outcome: 'completed',
    result: { note: 'x', blocker: { code: 'sneaky', detail: 'd' } },
  });
  assert.equal(r.status, 422, J(r.body));
  assert.equal(r.body.code, 'result_malformed');
  const agg = await readAgg(stateDir, 'card-a');
  const att = agg.preparation.attempts.find((a) => a.attemptId === a1.attemptId);
  assert.equal(att.status, 'running', 'the refused result applied nothing');
});

// ============================================================================
// S16 — a settled turn that ignored the contract (malformed/no block) still
//       delivers an honest result; a malformed block is evidence in the note
// ============================================================================

test('S16: malformed acp-prep block → note preserves the raw text, turn completes', async () => {
  const { svc, projectDir, root, registryPath, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Emit a broken block.' });

  const { lead } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      { type: 'settle', text: 'Some answer text.\n\n```acp-prep\n{not json\n```' },
    ]],
  });

  const out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  const agg = await readAgg(stateDir, 'card-a');
  const att = agg.preparation.attempts[0];
  assert.equal(att.status, 'completed');
  assert.match(att.result.note, /Some answer text/);
  assert.equal(att.result.progress, false);            // nothing new — honest
  await lead.dispose();
});

// ============================================================================
// S17 — idle CLI (frames stop, no settle) → idle_timeout failure, honest
// ============================================================================

test('S17: silent process → idle_timeout fails the turn, attempt records failure', async () => {
  const { svc, projectDir, root, registryPath, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Hang forever.' });

  const { lead } = mkLead(svc, {
    root, registryPath,
    limits: { idleTimeoutMs: 60, turnTimeoutMs: 5000, maxRestarts: 0 },
    spawnScripts: [[ { type: 'silence' } ]],
  });

  const out = await lead.drive('card-a');
  assert.equal(out.status, 'failed', J(out));
  assert.equal(out.code, 'idle_timeout');
  const agg = await readAgg(stateDir, 'card-a');
  const att = agg.preparation.attempts[0];
  assert.equal(att.status, 'failed');
  assert.match(att.result.error, /idle_timeout/);
  await lead.dispose();
});

// ============================================================================
// S18 — CLI loss mid-turn (process dies before settle) → respawn + resume
//       on the SAME attempt; restart cap fails honestly
// ============================================================================

test('S18: process dies mid-turn → respawn resumes same attempt from checkpoint', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Survive a CLI crash.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [
      [ { type: 'die', code: 1 } ],                                       // spawn 1 dies
      [ { type: 'settle', text: PREP({ note: 'recovered', decisions: ['crash: survived'] }) } ],
    ],
  });

  const out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  assert.equal(spawns.length, 2);
  const view = await prepView(svc, 'card-a');
  assert.equal(view.attempts[0].status, 'completed');    // same attempt, one attempt
  assert.equal(view.attempts.length, 1);
  assert.equal(view.checkpoint.decisions.length, 1);
  // the resumed prompt carried resume framing
  assert.match(spawns[1].prompts[0], /replaced\/restarted|NOTE: the CLI session/);
  await lead.dispose();
});

test('S18b: a process that keeps dying exhausts restarts → cli_lost failure', async () => {
  const { svc, projectDir, root, registryPath, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Crash forever.' });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    limits: { maxRestarts: 1, idleTimeoutMs: 60, turnTimeoutMs: 1500, rpcTimeoutMs: 60 },
    spawnScripts: [
      [ { type: 'die', code: 1 } ],
      [ { type: 'die', code: 1 } ],
    ],
  });

  const out = await lead.drive('card-a');
  assert.equal(out.status, 'failed', J(out));
  assert.equal(out.code, 'cli_lost');
  const agg = await readAgg(stateDir, 'card-a');
  assert.equal(agg.preparation.attempts[0].status, 'failed');
  assert.match(agg.preparation.attempts[0].result.error, /cli_lost/);
  await lead.dispose();
});

// ============================================================================
// S19 — question channel binding mismatch: an extension_ui route's dialog is
//       durable regardless of the binding's declared channel (dialog is the
//       wire truth); a chat route's '?' tail mints a prompt question
// ============================================================================

test('S19: question records carry channel+dialog evidence on both transports', async () => {
  const { svc, projectDir, root, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await startPrep(svc, 'card-a', { intent: 'Cover both channels.', bindings: { intent: 'test-grill-ui' } });

  const { lead, spawns } = mkLead(svc, {
    root, registryPath,
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'select', title: 'pick one', options: ['a', 'b'] },
        after: { type: 'settle', text: PREP({ note: 'ok' }) } },
    ]],
  });

  let out = await lead.drive('card-a');
  assert.equal(out.status, 'awaiting_user', J(out));
  const view = await prepView(svc, 'card-a');
  const q = openQ(view)[0];
  assert.equal(q.channel, 'dialog');
  assert.equal(q.dialog.method, 'select');
  assert.equal(q.dialog.requestId, spawns[0].pendingDialogs()[0]);
  await answerQ(svc, 'card-a', q.questionId, 'a');
  out = await lead.drive('card-a');
  assert.equal(out.status, 'idle', J(out));
  await lead.dispose();
});
