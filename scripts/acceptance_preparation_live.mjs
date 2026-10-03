// Opt-in acceptance: real Pi, real durable domain and authenticated client.
// No listener or production state is used. Evidence remains in the supplied dir.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createStateService } from '../server/execution/state-service.mjs';
import { createInternalClient } from '../server/execution/internal-transport.mjs';
import { createPreparationSupervisor } from '../server/execution/preparation/supervisor.mjs';

assert(process.argv.includes('--live'), 'Pass --live to authorize real model calls');
const root = resolve(process.env.ACP_ACCEPTANCE_DIR || `.agent-tmp/preparation-${randomUUID()}`);
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const project = join(root, 'project');
await fs.mkdir(project, { recursive: true });
await fs.writeFile(join(project, 'README.md'), '# Acceptance fixture\n');
execFileSync('git', ['init', '-q', project]);
execFileSync('git', ['-C', project, 'add', 'README.md']);
execFileSync('git', ['-C', project, '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@local', 'commit', '-qm', 'fixture']);
const stateDir = join(root, 'state');
const svc = await createStateService({ stateDir, env: {
  ACP_WORKSPACE_DIR: join(root, 'workspaces'), ROOT_DIR: root,
  ACP_EXEC_TOKEN_UID: String(process.getuid()), ACP_EXEC_TOKEN_GID: String(process.getgid()),
}, features: { start: true, preparation: true, validation: true } });
const request = (method, path, body, headers) => svc.request({
  method, path, query: new URLSearchParams(), headers,
  bodyText: body === undefined ? undefined : JSON.stringify(body),
});
const client = createInternalClient({ stateDir, transport: async ({ method, path, body, headers }) => {
  const r = await request(method, path, body, headers);
  return { status: r.status, body: r.json };
} });
const cardId = 'release-preparation-fixture';
const intent = 'Add a pure clamp(value, min, max) utility in src/clamp.mjs for Node ES modules. '
  + 'One developer uses it to bound finite numbers. Return min below range, max above range, '
  + 'and the unchanged value inside. Throw TypeError for nonfinite/nonnumber inputs and RangeError '
  + 'when min exceeds max. Include Node built-in unit tests and README usage. No dependencies, '
  + 'network, UI, deployment or other features. Tests: node --test. This scope is settled.';
for (const [name, data] of [
  ['projects.json', { version: 1, projects: [{ id: 'fixture', name: 'fixture', path: project }] }],
  ['board.json', { version: 2, cards: [{ id: cardId, title: 'Release clamp fixture', description: intent,
    stage: 'spec', status: 'in_progress', project: 'fixture', order: 1 }] }],
]) {
  const r = await request('PUT', `/api/state/${name}`, { data });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const card = async () => (await request('GET', `/api/execution/cards/${cardId}`)).json;
const preparation = async () => (await request('GET', `/api/execution/cards/${cardId}/preparation`)).json.preparation;
async function command(type, payload = {}) {
  for (let i = 0; i < 8; i++) {
    const view = type === 'enable' ? {} : await card();
    const r = await request('POST', `/api/execution/cards/${cardId}/commands`, {
      commandId: randomUUID(), type, payload, expectedControlRevision: view.controlRevision,
    });
    if (r.status === 409 && r.json.code === 'revision_conflict') continue;
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.json)}`);
    return r.json.result;
  }
  throw new Error(`${type}: repeated CAS conflict`);
}
const supervisor = createPreparationSupervisor({ client, stateDir,
  model: { provider: 'zen-relay', id: 'muse-spark-1.3-contributor-free', thinking: 'low' },
  limits: { turnTimeoutMs: 300_000, idleTimeoutMs: 150_000 },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, label, attemptId = null) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await supervisor.sweep();
    const view = await preparation();
    if (await predicate(view)) return view;
    const blocker = view?.blocker;
    assert(!blocker, `${label}: ${JSON.stringify(blocker)}`);
    const attempt = (view?.attempts || []).find(a => a.attemptId === attemptId);
    assert(!attempt || !['completed', 'failed', 'blocked', 'cancelled'].includes(attempt.status),
      `${label}: attempt ${attemptId} ended without the requested artifact (${attempt?.status})`);
    await sleep(500);
  }
  throw new Error(`${label}: real model timed out`);
}
const receipts = [];
try {
  await command('enable');
  await command('start_preparation', { intent, bindings: { intent: 'grill-me-intent' } });
  let view = await until(v => (v?.checkpoint?.openQuestions || []).some(q => q.status === 'open')
    || (v?.attempts || []).some(a => a.kind === 'kickoff' && a.status === 'completed'), 'grill discussion');
  const questions = view.checkpoint.openQuestions.filter(q => q.status === 'open');
  receipts.push({ check: 'real skill completed intent discussion', questions: questions.length });
  for (const q of questions) await command('answer_question', {
    questionId: q.questionId, answer: `Confirmed. ${intent} Use inclusive bounds and strict numeric types.`,
  });
  const draftRequirements = await command('request_draft', { kind: 'requirements', note: 'All scope is settled. Produce the complete requirements now in your acp-prep document result. Do not ask further questions.' });
  view = await until(v => !!v?.presented?.requirements, 'generated requirements', draftRequirements.attemptId);
  for (const kind of ['requirements', 'plan']) {
    if (kind === 'plan') {
      const draftPlan = await command('request_draft', { kind, note: 'Produce a concrete development plan for the accepted requirements now. Include file boundaries, implementation tasks, acceptance criteria and verification. Include an acp-checks fenced JSON block with checks:[{run:"node --test",timeoutSec:60}]. Return the complete Markdown in the acp-prep document result. No further questions.' });
      view = await until(v => !!v?.presented?.plan, 'generated development plan', draftPlan.attemptId);
    }
    const version = view.presented[kind];
    const doc = await request('GET', `/api/execution/cards/${cardId}/documents/${version.versionId}`);
    assert.equal(doc.status, 200, JSON.stringify(doc.json));
    assert(doc.json.content.length > 100, `${kind}: empty model artifact`);
    assert(/clamp/i.test(doc.json.content), `${kind}: wrong feature`);
    if (kind === 'plan') assert(doc.json.content.includes('```acp-checks'), 'generated plan must exercise nested fences');
    await fs.writeFile(join(root, `${kind}.md`), doc.json.content);
    await command(kind === 'plan' ? 'approve_plan' : 'approve_requirements', {
      versionId: version.versionId, sha256: version.sha256,
    });
    receipts.push({ check: `real model ${kind} imported and approved`, ...version });
  }
  view = await preparation();
  for (const gate of view.gates || []) {
    if (gate.status === 'pending' || gate.status === 'invalidated') {
      await command('confirm_gate', { gateId: gate.gateId });
    }
  }
  view = await preparation();
  assert.equal(view.ready, true, JSON.stringify(view.blockers));
  receipts.push({ check: 'accepted generated plan is ready for development', phase: view.phase });
  const wholeCard = await card();
  assert(wholeCard.documents.requirements.current, 'card requirements missing');
  assert(wholeCard.documents.plan.current, 'card development plan missing');
  assert.equal(wholeCard.approvals.plan.checksSource, 'document_block', 'approved checks must come from generated plan');
  receipts.push({ check: 'generated versions persisted on card', phase: view.phase });
  await fs.writeFile(join(root, 'card.json'), JSON.stringify(wholeCard, null, 2));
  await fs.writeFile(join(root, 'receipt.json'), JSON.stringify({ status: 'pass', root, receipts }, null, 2));
  console.log(JSON.stringify({ status: 'pass', root, receipts }, null, 2));
} catch (error) {
  await fs.writeFile(join(root, 'receipt.json'), JSON.stringify({ status: 'fail', error: error.message, receipts }, null, 2));
  throw error;
} finally {
  await supervisor.dispose({ drainMs: 15_000 });
}
