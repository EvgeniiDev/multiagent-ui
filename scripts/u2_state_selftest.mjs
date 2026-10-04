// scripts/u2_state_selftest.mjs — deterministic U2 state/storage tests.
//   node --test scripts/u2_state_selftest.mjs
//
// Everything runs through createStateService / createRequestHandler — the
// real production request path — with fake req/res objects. NOTHING opens a
// listener, touches compose, or uses the live state dir. Fixture projects are
// REAL git repositories (production validates via `git rev-parse`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createRequestHandler, resolveConfig } from '../server/acp-state-server.mjs';
import {
  paths,
  sha256,
  writeBlob,
  loadAggregate,
  listManagedCardIds,
} from '../server/execution/execution-store.mjs';
import { computeProjection } from '../server/execution/execution-domain.mjs';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 10000 }).trim();

// ---- fixtures ---------------------------------------------------------------

async function mkProject() {
  const dir = join(tmpdir(), `u2-proj-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(join(dir, 'docs'), { recursive: true });
  await fs.writeFile(join(dir, 'docs', 'spec.md'), '# imported spec\n', 'utf-8');
  await fs.writeFile(join(dir, 'docs', 'bad.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  await fs.writeFile(join(dir, 'docs', 'big.md'), 'x'.repeat(600 * 1024), 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

async function mkEnv({ faults } = {}) {
  const root = join(tmpdir(), `u2-state-${randomUUID().slice(0, 8)}`);
  const stateDir = join(root, 'state');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
  const svc = await createStateService({
    stateDir,
    env: { PORCH_STEER_DIR: join(root, 'steer') },
    faults,
  });
  return { root, stateDir, projectDir, svc };
}

const J = (o) => JSON.stringify(o);

async function req(svc, method, path, body) {
  const q = new URL(path, 'http://t');
  return svc.request({
    method,
    path: q.pathname,
    query: q.searchParams,
    bodyText: body === undefined ? undefined : J(body),
  });
}
const putDoc = (svc, name, data, rev) => req(svc, 'PUT', `/api/state/${name}`, { data, rev });
const getDoc = (svc, name) => req(svc, 'GET', `/api/state/${name}`);
const cmd = (svc, cardId, body) => req(svc, 'POST', `/api/execution/cards/${cardId}/commands`, body);
const internal = (svc, cardId, body) => svc.internalCommand(cardId, body);
const getCard = (svc, id) => req(svc, 'GET', `/api/execution/cards/${id}`);

// Legacy docs persist as <stateDir>/<name>.json where name keeps its '.json'
// suffix (board.json -> board.json.json) — legacy naming contract.
const docFile = (stateDir, name) => join(stateDir, `${name}.json`);
async function plantDoc(stateDir, name, data) {
  await fs.writeFile(
    docFile(stateDir, name),
    J({ name, rev: 1, updatedAt: Date.now(), data }),
  );
}
async function readDoc(stateDir, name) {
  return JSON.parse(await fs.readFile(docFile(stateDir, name), 'utf-8'));
}
const aggregateFile = (stateDir, cardId) => join(paths(stateDir).cardsDir, `${cardId}.json`);

function boardWith(card) {
  return { version: 2, cards: [card] };
}
function cardA(over = {}) {
  return {
    id: 'card-a',
    title: 'Card A',
    stage: 'spec',
    status: 'in_progress',
    project: 'proj-x',
    order: 10,
    ...over,
  };
}
async function seedBase(svc, projectDir, card = cardA()) {
  await req(svc, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  return putDoc(svc, 'board.json', boardWith(card));
}
async function enable(svc, commandId = 'en1') {
  return cmd(svc, 'card-a', { commandId, type: 'enable' });
}
async function attach(svc, cardId, commandId, kind, text, extra = {}) {
  return cmd(svc, cardId, {
    commandId,
    type: 'attach_document',
    expectedControlRevision: extra.rev,
    payload: { kind, source: { type: 'text', text }, ...extra.payload },
  });
}
async function getCardDoc(svc, cardId) {
  const r = await getDoc(svc, 'board.json');
  return r.json.data.cards.find((c) => c.id === cardId);
}
async function enableSeeded(svc, projectDir, card) {
  await seedBase(svc, projectDir, card);
  const r = await enable(svc);
  assert.equal(r.status, 200, J(r.json));
  return r.json.controlRevision;
}
const checks = [{ run: 'npm test', timeoutSec: 300 }];

// ==========================================================================
// KV serialization

test('kv: concurrent PUTs with the same rev — exactly one wins', async () => {
  const { svc } = await mkEnv();
  const [a, b] = await Promise.all([
    putDoc(svc, 'roles.json', { v: 'A' }, 0),
    putDoc(svc, 'roles.json', { v: 'B' }, 0),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const got = await getDoc(svc, 'roles.json');
  assert.equal(got.json.rev, 1);
});

test('kv: missing-document CAS — rev>0 conflicts, rev 0 creates', async () => {
  const { svc } = await mkEnv();
  const bad = await putDoc(svc, 'claims.json', { claims: {} }, 4);
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, 'rev_conflict');
  const ok0 = await putDoc(svc, 'claims.json', { claims: {} }, 0);
  assert.equal(ok0.status, 200);
  assert.equal(ok0.json.rev, 1);
});

test('kv: stale PUT on existing doc conflicts with live rev', async () => {
  const { svc } = await mkEnv();
  await putDoc(svc, 'x.json', { a: 1 });
  assert.equal((await putDoc(svc, 'x.json', { a: 2 }, 0)).status, 409);
  assert.equal((await putDoc(svc, 'x.json', { a: 2 }, 1)).status, 200);
});

// ==========================================================================
// enable + claims gate

test('enable: binds project, projects card, purges stale claim residue', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  // Bare expired marker — no pid/runner/session evidence → purgeable.
  await putDoc(svc, 'claims.json', {
    claims: { 'card-a': { agentName: 'old', leaseUntil: 1, claimedAt: 1 } },
    attempts: { 'card-a': 2 },
  });
  const r = await enable(svc);
  assert.equal(r.status, 200, J(r.json));
  const claims = (await getDoc(svc, 'claims.json')).json.data;
  assert.equal(claims.claims['card-a'], undefined);
  assert.equal(claims.attempts['card-a'], undefined);
  const row = await getCardDoc(svc, 'card-a');
  assert.equal(row.execution.managed, true);
  assert.equal(row.stage, 'spec');
  assert.equal(row.project, 'proj-x');
  const card = await getCard(svc, 'card-a');
  assert.equal(card.status, 200);
  assert.equal(card.json.project.id, 'proj-x');
  assert.equal(card.json.project.path, await fs.realpath(projectDir));
});

test('enable: live claim and evidence-bearing expired claims refuse', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  const now = Date.now();
  await putDoc(svc, 'claims.json', {
    claims: { 'card-a': { agentName: 'runner:z', leaseUntil: now + 60000, pid: 4242 } },
    attempts: {},
  });
  const live = await enable(svc);
  assert.equal(live.status, 409);
  assert.equal(live.json.code, 'legacy_claim_active');

  // Expired lease + recorded process identity — cannot be proven terminal
  // from this service (separate pid namespaces): fail closed, keep evidence.
  for (const [id, claim] of [
    ['pidrunner', { agentName: 'runner:z', leaseUntil: now - 1000, pid: 4242, runnerPid: 4000 }],
    ['pidonly', { agentName: 'runner:z', leaseUntil: now - 1000, pid: 4242 }],
    ['sessiononly', { agentName: 'x', leaseUntil: now - 1000, sessionId: 'sess-1' }],
  ]) {
    await putDoc(svc, 'claims.json', { claims: { 'card-a': claim }, attempts: {} });
    const r = await enable(svc, `en-${id}`);
    assert.equal(r.status, 409, `${id}: ${J(r.json)}`);
    assert.equal(r.json.code, 'legacy_claim_unresolved');
  }
  // Ambiguous evidence is preserved, not erased.
  const claims = (await getDoc(svc, 'claims.json')).json.data;
  assert.ok(claims.claims['card-a']);

  // claims doc with no `attempts` map at all must not TypeError on purge.
  await putDoc(svc, 'claims.json', { claims: {} });
  assert.equal((await enable(svc, 'en-final')).status, 200);
});

test('enable: fake .git marker and linked worktree — real git check', async () => {
  const { svc, root } = await mkEnv();
  const fake = join(root, 'fake-proj');
  await fs.mkdir(join(fake, '.git'), { recursive: true }); // marker, not a repo
  await req(svc, 'PUT', '/api/state/projects.json', {
    data: {
      version: 1,
      projects: [
        { id: 'fake', name: 'fake', path: fake },
      ],
    },
  });
  await putDoc(svc, 'board.json', boardWith(cardA({ project: 'fake' })));
  const nope = await enable(svc);
  assert.equal(nope.status, 422);
  assert.equal(nope.json.code, 'project_not_git');

  // Real repo + linked worktree both pass the gate.
  const real = join(root, 'real-proj');
  await fs.mkdir(real, { recursive: true });
  execFileSync('git', ['init', '-q', real]);
  git(real, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty');
  const wt = join(root, 'linked-wt');
  execFileSync('git', ['-C', real, 'worktree', 'add', '-q', wt], { timeout: 10000 });
  await req(svc, 'PUT', '/api/state/projects.json', {
    data: {
      version: 1,
      projects: [
        { id: 'real', name: 'real', path: real },
        { id: 'wt', name: 'wt', path: wt },
      ],
    },
  });
  await putDoc(svc, 'board.json', {
    version: 2,
    cards: [cardA({ id: 'card-r', project: 'real' }), cardA({ id: 'card-w', project: 'wt' })],
  });
  assert.equal((await cmd(svc, 'card-r', { commandId: 'er', type: 'enable' })).status, 200);
  const w = await cmd(svc, 'card-w', { commandId: 'ew', type: 'enable' });
  assert.equal(w.status, 200, J(w.json));
});

test('dedup: replay returns original outcome forever, different payload conflicts', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  let c = await getCard(svc, 'card-a');
  const r1 = await attach(svc, 'card-a', 'd1', 'design', '# design v1', { rev: c.json.controlRevision });
  assert.equal(r1.status, 200, J(r1.json));
  const replay = await attach(svc, 'card-a', 'd1', 'design', '# design v1', { rev: 999 });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.result.versionId, r1.json.result.versionId);
  const conflict = await attach(svc, 'card-a', 'd1', 'design', '# different', { rev: 2 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'command_conflict');
});

test('dedup: no eviction horizon — >256 later commands, replay still returns original', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  let c = await getCard(svc, 'card-a');
  const first = await attach(svc, 'card-a', 'first-cmd', 'design', '# first', {
    rev: c.json.controlRevision,
  });
  assert.equal(first.status, 200, J(first.json));
  for (let i = 0; i < 270; i++) {
    c = await getCard(svc, 'card-a');
    const r = await attach(svc, 'card-a', `fill-${i}`, 'design', `n${i}`, {
      rev: c.json.controlRevision,
    });
    assert.equal(r.status, 200, `fill-${i}: ` + J(r.json));
  }
  const replay = await attach(svc, 'card-a', 'first-cmd', 'design', '# first', { rev: 9999 });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.result.versionId, first.json.result.versionId);
});

test('revisions: heartbeat moves only internalRevision via trusted seam', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const before = (await getCard(svc, 'card-a')).json;
  // Browser payload claiming the internal channel is rejected outright.
  const forged = await cmd(svc, 'card-a', {
    commandId: 'hb-forged',
    type: 'heartbeat',
    channel: 'internal',
    expectedInternalRevision: 0,
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.json.code, 'internal_forbidden');
  // The internal seam requires expectedInternalRevision.
  const missing = await internal(svc, 'card-a', { type: 'heartbeat' });
  assert.equal(missing.status, 400);
  const hb = await internal(svc, 'card-a', {
    type: 'heartbeat',
    expectedInternalRevision: before.internalRevision,
    payload: { runnerId: 'runner-1', instanceId: 'inst-hb-1' },
  });
  assert.equal(hb.status, 200, J(hb.body ?? hb.json));
  const after = (await getCard(svc, 'card-a')).json;
  assert.equal(after.internalRevision, before.internalRevision + 1);
  assert.equal(after.controlRevision, before.controlRevision);
  const stale = await internal(svc, 'card-a', { type: 'heartbeat', expectedInternalRevision: 0 });
  assert.equal(stale.status, 409);
});

test('unsupported commands return 501 and are dedup-recorded', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const c = await getCard(svc, 'card-a');
  const r = await cmd(svc, 'card-a', {
    commandId: 'st1', type: 'start',
    expectedControlRevision: c.json.controlRevision,
  });
  assert.equal(r.status, 501);
  assert.equal(r.json.code, 'command_unavailable');
  const replay = await cmd(svc, 'card-a', {
    commandId: 'st1', type: 'start',
    expectedControlRevision: c.json.controlRevision + 99,
  });
  assert.equal(replay.status, 501);
  assert.equal(replay.json.idempotent, true);
});

// ==========================================================================
// documents + approvals

async function attachReqAndApprove(svc, cardId = 'card-a') {
  let c = await getCard(svc, cardId);
  const a = await attach(svc, cardId, `req-${randomUUID().slice(0, 6)}`, 'requirements', '# ReqA', {
    rev: c.json.controlRevision,
  });
  assert.equal(a.status, 200, J(a.json));
  const { versionId, sha256 } = a.json.result;
  c = await getCard(svc, cardId);
  const ap = await cmd(svc, cardId, {
    commandId: `apr-${randomUUID().slice(0, 6)}`,
    type: 'approve_requirements',
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId, sha256 },
  });
  assert.equal(ap.status, 200, J(ap.json));
  return { versionId, sha256 };
}

test('approvals require explicit versionId+sha256; stale versions rejected', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  let c = await getCard(svc, 'card-a');
  const a = await attach(svc, 'card-a', 'r1', 'requirements', '# one', { rev: c.json.controlRevision });
  const { versionId, sha256 } = a.json.result;
  c = await getCard(svc, 'card-a');
  const ap = (payload, id) =>
    cmd(svc, 'card-a', {
      commandId: id, type: 'approve_requirements',
      expectedControlRevision: c.json.controlRevision, payload,
    });
  let r = await ap({}, 'x1');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'approval_requires_version');
  r = await ap({ versionId }, 'x2');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'approval_requires_hash');
  r = await ap({ versionId, sha256: sha256.replace(/.$/, '0') }, 'x3');
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'hash_mismatch');
  r = await ap({ versionId, sha256 }, 'x4');
  assert.equal(r.status, 200, J(r.json));
  c = await getCard(svc, 'card-a');
  await attach(svc, 'card-a', 'r2', 'requirements', '# two', { rev: c.json.controlRevision });
  c = await getCard(svc, 'card-a');
  assert.equal(c.json.approvals.requirements, null);
  r = await cmd(svc, 'card-a', {
    commandId: 'x5', type: 'approve_requirements',
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId, sha256 },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'stale_version');
});

test('plan is bound to the requirements version it was prepared for', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const reqA = await attachReqAndApprove(svc);
  let c = await getCard(svc, 'card-a');
  const planA = await attach(svc, 'card-a', 'pa', 'plan', '# planA', {
    rev: c.json.controlRevision,
    payload: { checks },
  });
  assert.equal(planA.status, 200, J(planA.json));
  assert.equal(planA.json.result.requirementsBound.versionId, reqA.versionId);
  c = await getCard(svc, 'card-a');
  const reqB = await attach(svc, 'card-a', 'rb', 'requirements', '# ReqB', { rev: c.json.controlRevision });
  assert.equal(reqB.status, 200);
  c = await getCard(svc, 'card-a');
  assert.equal(c.json.approvals.requirements, null);
  assert.equal(c.json.approvals.plan, null);
  c = await getCard(svc, 'card-a');
  let ap = await cmd(svc, 'card-a', {
    commandId: 'ap-rb', type: 'approve_requirements',
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId: reqB.json.result.versionId, sha256: reqB.json.result.sha256 },
  });
  assert.equal(ap.status, 200, J(ap.json));
  c = await getCard(svc, 'card-a');
  ap = await cmd(svc, 'card-a', {
    commandId: 'ap-pa', type: 'approve_plan',
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId: planA.json.result.versionId, sha256: planA.json.result.sha256 },
  });
  assert.equal(ap.status, 409);
  assert.equal(ap.json.code, 'plan_binding_stale');
  c = await getCard(svc, 'card-a');
  const planB = await attach(svc, 'card-a', 'pb', 'plan', '# planB', {
    rev: c.json.controlRevision,
    payload: { requirementsVersionId: reqB.json.result.versionId },
  });
  assert.equal(planB.status, 200, J(planB.json));
  c = await getCard(svc, 'card-a');
  ap = await cmd(svc, 'card-a', {
    commandId: 'ap-pb', type: 'approve_plan',
    expectedControlRevision: c.json.controlRevision,
    payload: {
      versionId: planB.json.result.versionId,
      sha256: planB.json.result.sha256,
      checks,
    },
  });
  assert.equal(ap.status, 200, J(ap.json));
  assert.equal(ap.json.result.approval.checksSource, 'approval_payload');
  assert.deepEqual(ap.json.result.approval.checks, checks);
  assert.equal(ap.json.result.approval.requirementsVersionId, reqB.json.result.versionId);
});

test('plan checks: structured payload, document block, or nothing -> diagnostics', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  await attachReqAndApprove(svc);
  const approve = async (versionId, sha256v, payload = {}, id = 'ap-1') => {
    const c = await getCard(svc, 'card-a');
    return cmd(svc, 'card-a', {
      commandId: id, type: 'approve_plan',
      expectedControlRevision: c.json.controlRevision,
      payload: { versionId, sha256: sha256v, ...payload },
    });
  };
  let c = await getCard(svc, 'card-a');
  const p0 = await attach(svc, 'card-a', 'p0', 'plan', '# no checks', { rev: c.json.controlRevision });
  let ap = await approve(p0.json.result.versionId, p0.json.result.sha256, {}, 'ap-p0');
  assert.equal(ap.status, 422);
  assert.equal(ap.json.code, 'plan_checks_missing');

  c = await getCard(svc, 'card-a');
  const withBlock =
    '# plan\n\n```acp-checks\n{"checks":[{"run":"npm test","timeoutSec":300,"setup":true}]}\n```\n';
  const p1 = await attach(svc, 'card-a', 'p1', 'plan', withBlock, { rev: c.json.controlRevision });
  assert.equal(p1.status, 200, J(p1.json));
  ap = await approve(p1.json.result.versionId, p1.json.result.sha256, {}, 'ap-p1');
  assert.equal(ap.status, 200, J(ap.json));
  assert.equal(ap.json.result.approval.checksSource, 'document_block');
  assert.deepEqual(ap.json.result.approval.checks, [
    { run: 'npm test', timeoutSec: 300, setup: true },
  ]);

  c = await getCard(svc, 'card-a');
  const p2 = await attach(svc, 'card-a', 'p2', 'plan', '# another', { rev: c.json.controlRevision });
  ap = await approve(
    p2.json.result.versionId, p2.json.result.sha256,
    { checks: [{ cwd: '/abs' }] }, 'ap-p2',
  );
  assert.equal(ap.status, 422);
  assert.equal(ap.json.code, 'plan_checks_invalid');

  c = await getCard(svc, 'card-a');
  const badBlock = '# plan\n```acp-checks\n{not json\n```\n';
  const p3 = await attach(svc, 'card-a', 'p3', 'plan', badBlock, { rev: c.json.controlRevision });
  ap = await approve(
    p3.json.result.versionId, p3.json.result.sha256,
    { checks: [{ run: 'make check' }] }, 'ap-p3',
  );
  assert.equal(ap.status, 200, J(ap.json));
  assert.equal(ap.json.result.approval.checksSource, 'approval_payload');
});

test('document immutability: imported source file edit cannot rewrite history', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const srcPath = join(projectDir, 'docs', 'spec.md');
  let c = await getCard(svc, 'card-a');
  const a = await cmd(svc, 'card-a', {
    commandId: 'im1', type: 'attach_document',
    expectedControlRevision: c.json.controlRevision,
    payload: { kind: 'design', source: { type: 'import', path: 'docs/spec.md' } },
  });
  assert.equal(a.status, 200, J(a.json));
  const vid = a.json.result.versionId;
  // Mutate the source file on disk — the attached version must be frozen.
  await fs.writeFile(srcPath, '# CHANGED AFTER IMPORT\n');
  const got = await req(svc, 'GET', `/api/execution/cards/card-a/documents/${vid}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.content, '# imported spec\n');
  assert.equal(got.json.sha256, sha256('# imported spec\n'));
});

test('imports: symlink escape, size limit, non-UTF-8 all rejected', async () => {
  const { svc, projectDir, root } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const outside = join(root, 'outside.md');
  await fs.writeFile(outside, '# secret\n');
  await fs.symlink(outside, join(projectDir, 'docs', 'link.md'));
  const attempt = async (path, id) => {
    const c = await getCard(svc, 'card-a');
    return cmd(svc, 'card-a', {
      commandId: id, type: 'attach_document',
      expectedControlRevision: c.json.controlRevision,
      payload: { kind: 'design', source: { type: 'import', path } },
    });
  };
  const esc = await attempt('docs/link.md', 'imp-esc');
  assert.equal(esc.status, 422);
  assert.equal(esc.json.code, 'import_escape');
  assert.equal((await attempt('docs/nope.md', 'imp-miss')).json.code, 'import_invalid');
  assert.equal((await attempt('docs/big.md', 'imp-big')).json.code, 'document_too_large');
  assert.equal((await attempt('docs/bad.bin', 'imp-bin')).json.code, 'document_invalid');
  assert.equal((await attempt('docs/spec.md', 'imp-ok')).status, 200);
});

// ==========================================================================
// legacy write protection

test('board PUT: managed fields restored, forged markers stripped, deletion refused', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const board = (await getDoc(svc, 'board.json')).json.data;
  const del = await putDoc(svc, 'board.json', { version: 2, cards: [] });
  assert.equal(del.status, 409);
  assert.equal(del.json.code, 'managed_card_deleted');
  const forged = structuredClone(board);
  forged.cards[0].stage = 'done';
  forged.cards[0].status = 'accepted';
  forged.cards[0].project = 'other';
  forged.cards[0].blocked = true;
  forged.cards[0].title = 'user edit kept';
  const w = await putDoc(svc, 'board.json', forged);
  assert.equal(w.status, 200, J(w.json));
  const row = await getCardDoc(svc, 'card-a');
  assert.equal(row.stage, 'spec');
  assert.equal(row.status, 'in_progress');
  assert.equal(row.project, 'proj-x');
  assert.equal(row.blocked, false);
  assert.equal(row.title, 'user edit kept');
  assert.equal(row.execution.managed, true);
  const board2 = (await getDoc(svc, 'board.json')).json.data;
  board2.cards.push({ id: 'card-b', title: 'B', stage: 'spec', execution: { managed: true, runId: 'x' } });
  assert.equal((await putDoc(svc, 'board.json', board2)).status, 200);
  assert.equal((await getCardDoc(svc, 'card-b')).execution, undefined);
  const dup = (await getDoc(svc, 'board.json')).json.data;
  dup.cards.push({ id: 'card-a', stage: 'done', status: 'accepted', title: 'forged dup' });
  const wd = await putDoc(svc, 'board.json', dup);
  assert.equal(wd.status, 409);
  assert.equal(wd.json.code, 'duplicate_card_id');
});

test('projection history: statusByStage comes from the aggregate, not the row', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  await attachReqAndApprove(svc);
  const row = await getCardDoc(svc, 'card-a');
  assert.equal(row.stage, 'plan');
  assert.equal(row.statusByStage.spec, 'in_progress');
  const board = (await getDoc(svc, 'board.json')).json.data;
  board.cards[0].statusByStage = { spec: 'done', reviewtest: 'accepted' };
  board.cards[0].status = 'accepted';
  assert.equal((await putDoc(svc, 'board.json', board)).status, 200);
  const row2 = await getCardDoc(svc, 'card-a');
  assert.deepEqual(row2.statusByStage, { spec: 'in_progress' });
  assert.equal(row2.status, 'in_progress');
});

test('claims PUT/DELETE: managed card entries are frozen', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  await putDoc(svc, 'claims.json', { claims: {}, attempts: {} });
  const add = await putDoc(svc, 'claims.json', {
    claims: { 'card-a': { agentName: 'x', leaseUntil: Date.now() + 60000 } },
    attempts: {},
  });
  assert.equal(add.status, 409);
  assert.equal(add.json.code, 'managed_claim_protected');
  const del = await req(svc, 'DELETE', '/api/state/board.json');
  assert.equal(del.status, 409);
  assert.equal(del.json.code, 'managed_card_deleted');
});

// ==========================================================================
// storage integrity: fail closed

test('corrupt aggregate fails closed everywhere but stays managed', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const board = (await getDoc(svc, 'board.json')).json.data; // BEFORE corrupting
  const p = aggregateFile(stateDir, 'card-a');
  await fs.writeFile(p, '{corrupt');
  assert.deepEqual(await listManagedCardIds(stateDir), ['card-a']);
  const w = await putDoc(svc, 'board.json', board);
  assert.equal(w.status, 500);
  assert.equal(w.json.code, 'corrupt_store');
  assert.equal((await getCard(svc, 'card-a')).status, 500);
  const en = await cmd(svc, 'card-a', { commandId: 'en2', type: 'enable' });
  assert.equal(en.status, 500);
  assert.equal(en.json.code, 'corrupt_store');
  await fs.writeFile(p, J({ cardId: 'someone-else' }));
  const w2 = await putDoc(svc, 'board.json', board);
  assert.equal(w2.status, 500);
  assert.equal(w2.json.code, 'corrupt_store');
});

test('corrupt presets registry fails closed and is never overwritten', async () => {
  const { svc, stateDir } = await mkEnv();
  const p = paths(stateDir).presetsFile;
  await fs.writeFile(p, '{broken');
  const l = await req(svc, 'GET', '/api/execution/presets');
  assert.equal(l.status, 500);
  assert.equal(l.json.code, 'corrupt_store');
  const w = await req(svc, 'POST', '/api/execution/presets', { preset: {} });
  assert.equal(w.status, 500);
  assert.equal(await fs.readFile(p, 'utf-8'), '{broken');
  await fs.writeFile(p, J({ presets: 'nope' }));
  const l2 = await req(svc, 'GET', '/api/execution/presets');
  assert.equal(l2.status, 500);
  assert.equal(l2.json.code, 'corrupt_store');
});

test('blob evidence: reuse verifies hash; missing/corrupt blocks approval+serve', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  let c = await getCard(svc, 'card-a');
  const a = await attach(svc, 'card-a', 'doc', 'requirements', '# evidence', { rev: c.json.controlRevision });
  const { versionId, sha256: sha } = a.json.result;
  const blobPath = join(paths(stateDir).blobsDir, `${sha}.md`);
  await fs.chmod(blobPath, 0o644);
  await fs.writeFile(blobPath, 'forged content');
  c = await getCard(svc, 'card-a');
  const ap = await cmd(svc, 'card-a', {
    commandId: 'ap-doc', type: 'approve_requirements',
    expectedControlRevision: c.json.controlRevision,
    payload: { versionId, sha256: sha },
  });
  assert.equal(ap.status, 500);
  assert.equal(ap.json.code, 'corrupt_store');
  const serve = await req(svc, 'GET', `/api/execution/cards/card-a/documents/${versionId}`);
  assert.equal(serve.status, 500);
  // Code is the contract, not the message text.
  await assert.rejects(writeBlob(stateDir, '# evidence'), (e) => e.code === 'corrupt_store');
  await fs.unlink(blobPath);
  const serve2 = await req(svc, 'GET', `/api/execution/cards/card-a/documents/${versionId}`);
  assert.equal(serve2.status, 500);
  assert.equal(serve2.json.code, 'corrupt_store');
});

// ==========================================================================
// injected persistence failures + restart recovery

test('repair: one aggregate read per pass still drains failed effects and refreshes projections', async (t) => {
  const docNames = new Set();
  const { stateDir, projectDir, svc } = await mkEnv({ faults: { docNames } });
  await seedBase(svc, projectDir);
  await putDoc(svc, 'board.json', { version: 2, cards: [cardA(), cardA({ id: 'card-b' })] });
  assert.equal((await cmd(svc, 'card-b', { commandId: 'enable-b', type: 'enable' })).status, 200);
  await plantDoc(stateDir, 'claims.json', {
    claims: { 'card-a': { agentName: 'old', leaseUntil: 1 } },
    attempts: { 'card-a': 3 },
  });
  docNames.add('claims.json');
  assert.equal((await enable(svc, 'enable-a-crash')).status, 500);
  docNames.clear();

  const fileReads = new Map();
  const readFile = fs.readFile;
  const spy = t.mock.method(fs, 'readFile', async function (file, ...args) {
    const path = String(file);
    if (path.startsWith(paths(stateDir).cardsDir + '/')) {
      fileReads.set(path, (fileReads.get(path) || 0) + 1);
    }
    return readFile.call(this, file, ...args);
  });
  await svc.repairNow();
  spy.mock.restore();
  assert.deepEqual([...fileReads.values()], [1, 1], 'unrelated run history must not be parsed twice');
  const aggregate = await loadAggregate(stateDir, 'card-a');
  assert.equal(aggregate.pendingWrites, null);
  const claims = (await readDoc(stateDir, 'claims.json')).data;
  assert.equal(claims.claims['card-a'], undefined);
  assert.equal(claims.attempts['card-a'], undefined);
  const board = (await readDoc(stateDir, 'board.json')).data;
  for (const row of board.cards) {
    assert.equal(row.execution.managed, true);
    assert.equal(row.execution.controlRevision, 1);
  }

  // The optimization is confined to one repair: later disk corruption still fails closed.
  await fs.writeFile(aggregateFile(stateDir, 'card-b'), '{broken');
  await assert.rejects(svc.repairNow(), /unreadable/);
});

test('crash: enable committed but claims purge failed — restart drains intent', async () => {
  const { root, stateDir, projectDir } = await mkEnv();
  // Seed claims with a bare expired marker directly (before any service).
  await seedBase(
    await createStateService({ stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') } }),
    projectDir,
  );
  await plantDoc(stateDir, 'claims.json', {
    claims: { 'card-a': { agentName: 'old', leaseUntil: 1 } },
    attempts: { 'card-a': 3 },
  });
  // Faulted service: every claims.json write fails — enable commits the
  // aggregate (with durable intents) but the purge+projection never land.
  const svcBad = await createStateService({
    stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') },
    faults: { docNames: ['claims.json'] },
  });
  const r = await cmd(svcBad, 'card-a', { commandId: 'en-crash', type: 'enable' });
  assert.equal(r.status, 500, J(r.json));
  const agg = JSON.parse(await fs.readFile(aggregateFile(stateDir, 'card-a'), 'utf-8'));
  assert.ok(agg.pendingWrites.some((i) => i.type === 'claims_purge'));
  assert.ok(agg.pendingWrites.some((i) => i.type === 'board_projection'));
  assert.ok(agg.commands['en-crash']);
  // Restart: fresh service drains the intents during init repair.
  const svc2 = await createStateService({
    stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') },
  });
  const claims = (await readDoc(stateDir, 'claims.json')).data;
  assert.equal(claims.claims['card-a'], undefined);
  assert.equal(claims.attempts['card-a'], undefined);
  const row = (await getDoc(svc2, 'board.json')).json.data.cards.find((c) => c.id === 'card-a');
  assert.equal(row.execution.managed, true);
  // Replaying the same commandId returns the recorded outcome.
  const replay = await cmd(svc2, 'card-a', { commandId: 'en-crash', type: 'enable' });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
});

test('crash: save_preset registry write failed — restart drains; newer registry wins', async () => {
  const { root, stateDir, projectDir } = await mkEnv();
  const svc0 = await createStateService({ stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') } });
  await enableSeeded(svc0, projectDir);
  const preset = {
    name: 'CrashP',
    members: {
      implementer: { cli: 'codex', model: 'gpt-5.6', effort: 'high' },
      reviewer: { cli: 'codex', model: 'gpt-5.6' },
      checker: { cli: 'pi', model: 'zen-relay/muse-spark-1.3-contributor-free' },
    },
  };
  const svcBad = await createStateService({
    stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') }, faults: { presets: true },
  });
  const c = (await getCard(svcBad, 'card-a')).json;
  const r = await cmd(svcBad, 'card-a', {
    commandId: 'sp-crash', type: 'save_preset',
    expectedControlRevision: c.controlRevision,
    payload: { preset },
  });
  assert.equal(r.status, 500, J(r.json));
  const agg = JSON.parse(await fs.readFile(aggregateFile(stateDir, 'card-a'), 'utf-8'));
  assert.ok(agg.pendingWrites.some((i) => i.type === 'preset_upsert'));
  assert.equal(agg.composition.preset.name, 'CrashP');
  // Registry does NOT have it yet (write failed).
  const reg0 = JSON.parse(await fs.readFile(paths(stateDir).presetsFile, 'utf-8').catch(() => 'null'));
  assert.equal(reg0, null);
  // Between crash and repair an operator update lands a NEWER registry entry.
  const intentPreset = agg.pendingWrites.find((i) => i.type === 'preset_upsert').preset;
  await fs.writeFile(paths(stateDir).presetsFile, J({
    version: 1, rev: 3, updatedAt: Date.now(),
    presets: [{ ...intentPreset, name: 'OperatorNewer', updatedAt: intentPreset.updatedAt + 1000 }],
  }));
  const svc2 = await createStateService({ stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') } });
  const reg = (await req(svc2, 'GET', '/api/execution/presets')).json;
  assert.equal(reg.presets.length, 1);
  assert.equal(reg.presets[0].name, 'OperatorNewer'); // never regressed
  const agg2 = JSON.parse(await fs.readFile(aggregateFile(stateDir, 'card-a'), 'utf-8'));
  assert.equal(agg2.pendingWrites, null);
  // The card still carries ITS snapshot; replay returns the recorded outcome.
  assert.equal(agg2.composition.preset.name, 'CrashP');
  const replay = await cmd(svc2, 'card-a', {
    commandId: 'sp-crash', type: 'save_preset',
    expectedControlRevision: 999,
    payload: { preset },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
});

test('crash: attach committed but board projection failed — restart repairs', async () => {
  const { root, stateDir, projectDir } = await mkEnv();
  const svc0 = await createStateService({ stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') } });
  await enableSeeded(svc0, projectDir);
  const svcBad = await createStateService({
    stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') }, faults: { docNames: ['board.json'] },
  });
  const c = (await getCard(svcBad, 'card-a')).json;
  const r = await cmd(svcBad, 'card-a', {
    commandId: 'at-crash', type: 'attach_document',
    expectedControlRevision: c.controlRevision,
    payload: { kind: 'requirements', source: { type: 'text', text: '# crashed mid-flight' } },
  });
  assert.equal(r.status, 500, J(r.json));
  const agg = JSON.parse(await fs.readFile(aggregateFile(stateDir, 'card-a'), 'utf-8'));
  assert.ok(agg.pendingWrites.some((i) => i.type === 'board_projection'));
  // Board.json on disk lacks the projection update (still stage spec, stale
  // revision content) — restart repair re-projects.
  const svc2 = await createStateService({ stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') } });
  const card = (await getCard(svc2, 'card-a')).json;
  assert.equal(card.pendingWrites, null);
  const row = (await getDoc(svc2, 'board.json')).json.data.cards.find((x) => x.id === 'card-a');
  assert.equal(row.execution.managed, true);
  const replay = await cmd(svc2, 'card-a', {
    commandId: 'at-crash', type: 'attach_document',
    expectedControlRevision: 999,
    payload: { kind: 'requirements', source: { type: 'text', text: '# crashed mid-flight' } },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
});

test('crash: aggregate write failure — command not recorded, retry is clean', async () => {
  const { root, stateDir, projectDir } = await mkEnv();
  const svc0 = await createStateService({ stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') } });
  await seedBase(svc0, projectDir);
  const svcBad = await createStateService({
    stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') }, faults: { aggregates: ['card-a'] },
  });
  const r = await cmd(svcBad, 'card-a', { commandId: 'en-ag', type: 'enable' });
  assert.equal(r.status, 500);
  // Nothing committed: card stays unmanaged and the commandId is free.
  assert.deepEqual(await listManagedCardIds(stateDir), []);
  const svc2 = await createStateService({ stateDir, env: { PORCH_STEER_DIR: join(root, 'steer') } });
  const retry = await cmd(svc2, 'card-a', { commandId: 'en-ag', type: 'enable' });
  assert.equal(retry.status, 200, J(retry.json));
  assert.equal(retry.json.idempotent, undefined);
});

test('orphan blob (crash between blob and aggregate write) is benign', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  await writeBlob(stateDir, '# never referenced');
  const c = await getCard(svc, 'card-a');
  const a = await attach(svc, 'card-a', 'n1', 'design', '# never referenced', { rev: c.json.controlRevision });
  assert.equal(a.status, 200);
  assert.equal(a.json.result.sha256, sha256('# never referenced'));
});

test('computeProjection: no unbound run reference; run status maps stage', async () => {
  const base = {
    cardId: 'c1', schemaVersion: 1, controlRevision: 3, internalRevision: 0,
    documents: {}, currentRunId: 'r1',
    runs: [{ id: 'r1', status: 'cancelled', phase: 'implement' }],
    approvals: { requirements: { versionId: 'v', sha256: 'x'.repeat(64) }, plan: null },
    projection: { stage: 'dev', status: 'in_progress', statusByStage: { spec: 'done' }, order: 10 },
  };
  // Cancelled run -> lifecycle null -> keeps authoritative projection stage.
  const p = computeProjection(base, { id: 'c1', stage: 'dev', status: 'in_progress' }, { cards: [] });
  assert.equal(p.stage, 'dev');
  assert.equal(p.status, 'in_progress');
  assert.deepEqual(p.statusByStage, { spec: 'done' });
  // Active run in review phase -> reviewtest/in_progress; transition recorded.
  const withRun = {
    ...base,
    runs: [{ id: 'r1', status: 'active', phase: 'review' }],
  };
  const p2 = computeProjection(withRun, { id: 'c1', stage: 'dev', status: 'in_progress' }, { cards: [] });
  assert.equal(p2.stage, 'reviewtest');
  assert.equal(p2.status, 'in_progress');
  assert.equal(p2.execution.runStatus, 'active');
  assert.equal(p2.statusByStage.dev, 'in_progress'); // prior authoritative stage recorded
});

// ==========================================================================
// presets

const goodPreset = (over = {}) => ({
  name: 'P',
  members: {
    implementer: { cli: 'codex', model: 'gpt-5.6', effort: 'high' },
    reviewer: { cli: 'devin', model: 'swe-2-max' },
    checker: { cli: 'pi', model: 'zen-relay/muse-spark-1.3-contributor-free' },
  },
  ...over,
});

test('presets CRUD + per-CLI compatibility (effort/params are not global)', async () => {
  const { svc } = await mkEnv();
  const bad = (p) => req(svc, 'POST', '/api/execution/presets', { preset: p }).then((r) => r.status);
  const m = goodPreset().members;
  assert.equal(await bad(goodPreset({ members: { ...m, implementer: { cli: 'devin', model: 'swe-2-max', effort: 'high' } } })), 422);
  assert.equal(await bad(goodPreset({ members: { ...m, implementer: { cli: 'codex', model: 'gpt-5.6', params: { turbo: true } } } })), 422);
  assert.equal(await bad(goodPreset({ members: { ...m, checker: { cli: 'pi', model: 'zen-relay/muse-spark-1.3-contributor-free', effort: 'low' } } })), 422);
  assert.equal(await bad(goodPreset({ members: { ...m, reviewer: { cli: 'codex', model: 'nope-9' } } })), 422);
  const c = await req(svc, 'POST', '/api/execution/presets', { preset: goodPreset() });
  assert.equal(c.status, 200, J(c.json));
  const pid = c.json.preset.id;
  const u = await req(svc, 'PUT', `/api/execution/presets/${pid}`, {
    preset: goodPreset({ name: 'P2' }), rev: c.json.rev,
  });
  assert.equal(u.status, 200);
  assert.equal(
    (await req(svc, 'PUT', `/api/execution/presets/${pid}`, { preset: goodPreset(), rev: c.json.rev })).status,
    409,
  );
  assert.equal((await req(svc, 'DELETE', `/api/execution/presets/${pid}`)).status, 200);
});

test('compat override: valid extends, malformed fails closed', async () => {
  const { svc, stateDir } = await mkEnv();
  const f = paths(stateDir).compatFile;
  await fs.writeFile(f, J({ codex: { models: ['gpt-9-fake'], effort: ['ultra'] } }));
  await svc.refreshCompat();
  const m = goodPreset().members;
  const c = await req(svc, 'POST', '/api/execution/presets', {
    preset: goodPreset({ members: { ...m, implementer: { cli: 'codex', model: 'gpt-9-fake', effort: 'ultra' } } }),
  });
  assert.equal(c.status, 200, J(c.json));
  await fs.writeFile(f, '{nope');
  await svc.refreshCompat();
  const bad = await req(svc, 'POST', '/api/execution/presets', { preset: goodPreset() });
  assert.equal(bad.status, 500);
  assert.equal(bad.json.code, 'compat_invalid');
  const l = await req(svc, 'GET', '/api/execution/presets');
  assert.ok(l.json.compatError);
  // Unknown cli in the override is invalid too — no conjuring executors.
  await fs.writeFile(f, J({ claude: { models: ['x'] } }));
  await svc.refreshCompat();
  const bad2 = await req(svc, 'POST', '/api/execution/presets', { preset: goodPreset() });
  assert.equal(bad2.status, 500);
  assert.equal(bad2.json.code, 'compat_invalid');
  await fs.unlink(f);
  await svc.refreshCompat();
  const ok = await req(svc, 'POST', '/api/execution/presets', { preset: goodPreset({ name: 'P-again' }) });
  assert.equal(ok.status, 200);
});

test('save_preset binds a composition snapshot immune to registry edits', async () => {
  const { svc, projectDir } = await mkEnv();
  await enableSeeded(svc, projectDir);
  const c = await getCard(svc, 'card-a');
  const sp = await cmd(svc, 'card-a', {
    commandId: 'sp1', type: 'save_preset',
    expectedControlRevision: c.json.controlRevision,
    payload: { preset: goodPreset({ name: 'Bound' }) },
  });
  assert.equal(sp.status, 200, J(sp.json));
  const pid = sp.json.result.presetId;
  await req(svc, 'PUT', `/api/execution/presets/${pid}`, {
    preset: goodPreset({
      name: 'Renamed',
      members: { ...goodPreset().members, checker: { cli: 'codex', model: 'gpt-6-luna' } },
    }),
  });
  const card = await getCard(svc, 'card-a');
  assert.equal(card.json.composition.preset.name, 'Bound');
  assert.equal(card.json.composition.preset.members.checker.cli, 'pi');
});

// ==========================================================================
// HTTP transport contract (real handler, fake req/res — no listener)

function fakeRes() {
  return {
    chunks: [],
    headers: {},
    statusCode: 0,
    writeHead(s, h) { this.statusCode = s; if (h) Object.assign(this.headers, h); },
    end(b) { if (b) this.chunks.push(Buffer.from(b)); this.finished = true; },
    body() { return Buffer.concat(this.chunks).toString('utf-8'); },
  };
}
function fakeReq(method, path, bodyChunks, headers = {}) {
  const r = new Readable({ read() {} });
  r.method = method;
  r.url = path;
  r.headers = headers;
  if (Array.isArray(bodyChunks)) {
    for (const c of bodyChunks) r.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  } else if (bodyChunks !== undefined) {
    const b = Buffer.isBuffer(bodyChunks) || typeof bodyChunks === 'string' ? bodyChunks : J(bodyChunks);
    r.push(Buffer.from(b));
  }
  r.push(null);
  return r;
}
async function callHttp(handler, method, path, body, headers) {
  const rq = fakeReq(method, path, body, headers);
  const rs = fakeRes();
  await handler(rq, rs);
  const text = rs.body();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: rs.statusCode, json, headers: rs.headers, text };
}

test('http: OPTIONS, CORS `*` + POST, bad URL 400, unknown route 404', async () => {
  const { svc } = await mkEnv();
  const handler = createRequestHandler(svc);
  const opt = await callHttp(handler, 'OPTIONS', '/api/state/board.json');
  assert.equal(opt.status, 204);
  assert.equal(opt.headers['access-control-allow-origin'], '*');
  assert.match(opt.headers['access-control-allow-methods'], /POST/);
  // Absolute-form request targets can genuinely fail URL parsing → 400.
  const bad = await callHttp(handler, 'GET', 'http://[::ffff');
  assert.equal(bad.status, 400);
  // A weird-but-parseable path is a route miss, not an error.
  const weird = await callHttp(handler, 'GET', '/%zz%bad');
  assert.equal(weird.status, 404);
  const nf = await callHttp(handler, 'GET', '/api/nope');
  assert.equal(nf.status, 404);
  const badJson = await callHttp(handler, 'PUT', '/api/state/x.json', '{not');
  assert.equal(badJson.status, 400);
  const put = await callHttp(handler, 'PUT', '/api/state/x.json', { data: { a: 1 } });
  assert.equal(put.status, 200);
  assert.equal(put.headers['access-control-allow-origin'], '*');
});

test('http: over-5MiB bodies -> 413 (declared length and streamed)', async () => {
  const { svc } = await mkEnv();
  const handler = createRequestHandler(svc);
  // Declared content-length beyond limit (body itself need not be that big).
  const declared = await callHttp(handler, 'PUT', '/api/state/x.json', J({ data: {} }), {
    'content-length': String(6 * 1024 * 1024),
  });
  assert.equal(declared.status, 413);
  // Actually streamed past the limit in chunks.
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const bigChunks = Array(6).fill(chunk); // 6 MiB total
  const streamed = await callHttp(handler, 'PUT', '/api/state/x.json', bigChunks);
  assert.equal(streamed.status, 413);
  const post = await callHttp(handler, 'POST', '/api/execution/cards/x/commands', bigChunks);
  assert.equal(post.status, 413);
});

test('config seam: STATE_DIR/PORT legacy env names and defaults', () => {
  const c1 = resolveConfig({ STATE_DIR: '/tmp/custom', PORT: '25901' });
  assert.equal(c1.stateDir, '/tmp/custom');
  assert.equal(c1.port, 25901);
  const c2 = resolveConfig({});
  assert.equal(c2.stateDir, join(homedir(), '.hermes', 'acp-ui-state'));
  assert.equal(c2.port, 25900);
  const c3 = resolveConfig({ STATE_DIR: '   ', PORT: undefined });
  assert.equal(c3.stateDir, join(homedir(), '.hermes', 'acp-ui-state'));
  assert.equal(c3.port, 25900);
});

test('real request handler over fake req/res (no listener)', async () => {
  const { svc, projectDir } = await mkEnv();
  const handler = createRequestHandler(svc);
  const h = await callHttp(handler, 'GET', '/health');
  assert.equal(h.status, 200);
  const p = await callHttp(handler, 'PUT', '/api/state/projects.json', {
    data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: projectDir }] },
  });
  assert.equal(p.status, 200);
  const b = await callHttp(handler, 'PUT', '/api/state/board.json', { data: boardWith(cardA()) });
  assert.equal(b.status, 200);
  const e = await callHttp(handler, 'POST', '/api/execution/cards/card-a/commands', {
    commandId: 'en', type: 'enable',
  });
  assert.equal(e.status, 200, J(e.json));
  const g = await callHttp(handler, 'GET', '/api/execution/cards/card-a');
  assert.equal(g.status, 200);
  assert.equal(g.json.managed, true);
});
