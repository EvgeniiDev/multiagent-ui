// scripts/test_preparation_runner.mjs — P5 runner-side hosting of the
// preparation lead: createPreparationSupervisor + createManagedDriver
// wiring.   node --test scripts/test_preparation_runner.mjs
//
// Two layers, honestly separated:
//
//   W* — createManagedDriver wiring with INJECTED fakes: gate truth,
//        construction, pump lifecycle, shutdown order and drain budget.
//        No state service involved.
//
//   R* — the REAL seam: createPreparationSupervisor over a real
//        createStateService through the REAL createInternalClient (token
//        header routed in-process into svc.request), driving the REAL
//        createPreparationLead. The ONLY fake is the CLI process transport
//        (fixtures/fake-pi-rpc.mjs) — the runner must discover running
//        attempts from list rows, spawn per-session dirs, deliver answers
//        to live dialogs, survive supervisor replacement, fail closed on
//        unspawnable routes, and dispose inside a bounded drain.
//
// Nothing here claims the real `pi` binary ran — that evidence is
// scripts/preparation_skill_smoke.mjs + scripts/e2e_preparation.py.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { createInternalClient } from '../server/execution/internal-transport.mjs';
import { createManagedDriver, createManagedPump } from '../server/acp-runner.mjs';
import { createPreparationSupervisor } from '../server/execution/preparation/supervisor.mjs';
import { loadRegistry, buildManifest, verifyManifest } from '../server/execution/preparation/skills/registry.mjs';
import { createFakePiTransport, fakeTransportFactory } from './fixtures/fake-pi-rpc.mjs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
const myGid = typeof process.getgid === 'function' ? process.getgid() : null;

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

async function mkProject() {
  const dir = join(tmpdir(), `p5-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

// Minimal registry — enough for the supervisor's bound/unbound routes.
async function mkRegistry(root) {
  const skillsDir = join(root, 'skills');
  const mk = async (name) => {
    const dir = join(skillsDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: test ${name}\n---\n# ${name}\n`, 'utf-8');
    return dir;
  };
  const bindings = [];
  const push = async (bindingId, stage, status, extra = {}) => {
    const b = {
      bindingId, stage, status,
      title: `Test ${bindingId}`,
      provider: 'test',
      adapterId: status === 'unsupported' ? undefined : 'pi-skill',
      adapterVersion: status === 'unsupported' ? undefined : 'pi-skill-1',
      skillDirs: [await mk(bindingId)],
      extraResources: [],
      questionChannel: extra.questionChannel ?? 'extension_ui',
      tools: extra.tools ?? ['read', 'ask_user'],
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
  };
  await push('test-grill-ui', 'intent', 'available', {
    result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
    gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
  });
  await push('test-grill-alt', 'intent', 'available', {
    questionChannel: 'chat', tools: ['read'],
    result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
    gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
  });
  await push('test-unsupported', 'intent', 'unsupported', {
    unsupported: { reason: 'implementation_authority_denied', detail: 'test route', route: '' },
  });
  const registryPath = join(root, 'bindings.json');
  await fs.writeFile(registryPath, J({
    schemaVersion: 1,
    pi: { binary: 'pi', version: '0.85.1' },
    bindings,
  }), 'utf-8');
  return { registryPath };
}

async function mkEnv() {
  const root = join(tmpdir(), `p5-runner-${randomUUID().slice(0, 8)}`);
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
    features: { start: true, validation: true, fusion: true, preparation: true },
    preparation: { registryPath },
  });
  return { root, stateDir, projectDir, svc, registryPath };
}

// The REAL internal client — its transport routes into svc.request, so the
// internal token header is provisioned, presented and verified exactly as
// over HTTP.
function mkClient(svc, stateDir) {
  return createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      const u = new URL(path, 'http://t');
      const r = await svc.request({
        method, path: u.pathname, query: u.searchParams,
        bodyText: body === undefined ? undefined : J(body), headers,
      });
      return { status: r.status, body: r.json };
    },
  });
}

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
const prepView = async (svc, cardId) => {
  const r = await getPrep(svc, cardId);
  assert.equal(r.status, 200, J(r.json));
  return r.json.preparation;
};
const ucmd = async (svc, cardId, type, payload = {}) => {
  const c = await getCard(svc, cardId);
  return cmd(svc, cardId, {
    commandId: `c-${randomUUID().slice(0, 8)}`, type,
    expectedControlRevision: c.json.controlRevision, payload,
  });
};

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
async function enable(svc, cardId) {
  const r = await cmd(svc, cardId, { commandId: `en-${randomUUID().slice(0, 6)}`, type: 'enable' });
  assert.equal(r.status, 200, J(r.json));
}
async function startPrep(svc, cardId, payload) {
  const r = await ucmd(svc, cardId, 'start_preparation', payload);
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}

const PREP = (o) => '```acp-prep\n' + J(o) + '\n```';
const SETTLE = (o) => ({ type: 'settle', text: PREP(o) });
const LEAD_LIMITS = {
  idleTimeoutMs: 80, startTimeoutMs: 80, turnTimeoutMs: 1500,
  rpcTimeoutMs: 80, noProgressLimit: 2, maxRestarts: 2,
};

// sweep() DISPATCHES drives (floating) — a drive's observable effect lands
// a tick later. Poll the real state, never assume dispatch === settled.
async function until(pred, { ms = 2000, step = 15 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(step);
  }
  return pred();
}

function mkSupervisor(env, { spawnScripts, limits = {}, ...opts } = {}) {
  const spawns = [];
  const sup = createPreparationSupervisor({
    client: mkClient(env.svc, env.stateDir),
    stateDir: env.stateDir,
    env: {},
    registryPath: env.registryPath,
    transportFactory: fakeTransportFactory(spawnScripts ?? [[]], spawns),
    limits: { ...LEAD_LIMITS, ...limits },
    log: () => {},
    ...opts,
  });
  return { sup, spawns };
}

// ============================================================================
// W — driver wiring (injected fakes; no state service)
// ============================================================================

test('W1: ACP_EXEC_PREPARATION unset — no supervisor, no prep pump', async () => {
  let supBuilt = 0;
  const d = await createManagedDriver({
    env: { ACP_EXEC_START: '1' },
    clientFactory: () => ({ kind: 'fake' }),
    runtimeFactory: () => ({ kind: 'fake' }),
    schedulerFactory: () => ({ instanceId: 'i1', tick: async () => {} }),
    // deps.preparation injects the supervisor OBJECT — when the gate is off
    // it must be ignored entirely.
    preparation: { sweep: () => { supBuilt++; } },
    stateDir: join(tmpdir(), `p5-w1-${randomUUID().slice(0, 6)}`),
  });
  assert.equal(d.enabled, true);
  assert.equal(d.preparation, null);
  assert.equal(d.prepPump, null);
  assert.equal(d.describe().preparation, 'off');
  await d.start();
  await d.stop();
  assert.equal(supBuilt, 0, 'injected supervisor must never be swept when gated off');
});

test('W2: gate on — injected supervisor drives its own pump; stop fences+disposes', async () => {
  const calls = [];
  const sup = {
    sweep: async () => { calls.push('sweep'); return { driven: 0 }; },
    stop: () => { calls.push('sup.stop'); },
    dispose: async ({ drainMs } = {}) => { calls.push(`sup.dispose:${typeof drainMs}`); return { abandoned: 0 }; },
  };
  let prepStarted = 0, prepStopped = 0;
  const d = await createManagedDriver({
    env: { ACP_EXEC_START: '1' },
    preparationEnabled: true,
    preparation: sup,
    clientFactory: () => ({ kind: 'fake' }),
    runtimeFactory: () => ({ kind: 'fake' }),
    schedulerFactory: () => ({ instanceId: 'i1', tick: async () => {} }),
    prepPump: {
      start: () => { calls.push('prepPump.start'); prepStarted++; },
      stop: async () => { calls.push('prepPump.stop'); prepStopped++; return { drained: true }; },
      fire: async () => {},
      ticks: () => 0, errors: () => 0,
    },
    stateDir: join(tmpdir(), `p5-w2-${randomUUID().slice(0, 6)}`),
  });
  assert.equal(d.preparation, sup);
  assert.equal(d.describe().preparation, 'on');
  await d.start();
  assert.equal(prepStarted, 1, 'prep pump started with the driver');
  const res = await d.stop({ drainMs: 500 });
  // Shutdown order: fence the supervisor (no new sweeps) → drain the pump's
  // in-flight sweep → tear down in-memory sessions inside the drain budget.
  const order = calls.filter((c) => c !== 'prepPump.start');
  assert.deepEqual(order, ['sup.stop', 'prepPump.stop', 'sup.dispose:number'],
    `expected sup.stop → prepPump.stop → sup.dispose, got ${order.join(' → ')}`);
  assert.ok(res.preparation, 'stop result carries the preparation drain report');
  assert.equal(res.preparation.abandoned, 0);
});

test('W3: real pump fires supervisor.sweep on its own cadence', async () => {
  let sweeps = 0;
  const t = (() => {
    let now = 0, seq = 0;
    const queue = new Map();
    return {
      setTimeoutFn: (fn, ms) => { const id = ++seq; queue.set(id, { at: now + (ms || 0), fn }); return { id, unref() {} }; },
      clearTimeoutFn: (h) => { if (h) queue.delete(h.id); },
      advance: (ms) => {
        const target = now + ms;
        for (;;) {
          let nid = null, at = Infinity;
          for (const [id, x] of queue) if (x.at <= target && x.at < at) { at = x.at; nid = id; }
          if (nid === null) break;
          now = at;
          const f = queue.get(nid).fn; queue.delete(nid); f();
        }
        now = target;
      },
    };
  })();
  const d = await createManagedDriver({
    env: { ACP_EXEC_START: '1' },
    prepTickMs: 97, // deps bypass the 250ms env floor — the cadence is what we test
    preparationEnabled: true,
    preparation: { sweep: async () => { sweeps++; }, stop: () => {}, dispose: async () => ({}) },
    clientFactory: () => ({ kind: 'fake' }),
    runtimeFactory: () => ({ kind: 'fake' }),
    schedulerFactory: () => ({ instanceId: 'i1', tick: async () => {} }),
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    stateDir: join(tmpdir(), `p5-w3-${randomUUID().slice(0, 6)}`),
  });
  await d.start();
  await new Promise((r) => setImmediate(r));
  assert.ok(sweeps >= 1, 'first sweep fired immediately');
  const n = sweeps;
  // One fake-clock interval + one real microtask turn = one serialized
  // tick: the next timer is only scheduled after the in-flight tick
  // settles, so advance once per interval with a flush between.
  for (let i = 0; i < 4; i += 1) {
    t.advance(97);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(sweeps >= n + 4, `prep pump ticks on its own interval (sweeps=${sweeps})`);
  await d.stop({ drainMs: 100 });
});

// ============================================================================
// R — real service + real client + real lead, fake CLI transport
// ============================================================================

test('R1: sweep discovers the running attempt from the LIST ROW and drives it', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Add a one-line caption under the logo.' });

  // The supervisor's discovery surface is the cards INDEX — assert the row
  // itself advertises the running attempt before any drive.
  const idx = await mkClient(svc, env.stateDir).listCards();
  const row = idx.cards.find((c) => c.cardId === 'card-a');
  assert.ok(row?.preparation, 'list row carries the preparation summary');
  assert.ok(row.preparation.attempts.running >= 1, 'running attempt visible on the index row');

  const { sup, spawns } = mkSupervisor(env, {
    spawnScripts: [[SETTLE({ questions: [{ text: 'What should the caption say?', blocking: true }] })]],
  });
  const r = await sup.sweep();
  assert.equal(r.driven, 1);
  assert.equal(await until(() => spawns.length === 1), true, 'one CLI spawn for the kickoff attempt');
  assert.equal(
    await until(async () => (await prepView(svc, 'card-a'))
      .attempts.some((a) => a.status === 'awaiting_answer')),
    true, 'kickoff attempt parked awaiting_answer',
  );
  const view = await prepView(svc, 'card-a');
  const att = view.attempts.find((a) => a.status === 'awaiting_answer');
  assert.ok(att, `kickoff attempt parked awaiting_answer (got ${view.attempts.map((a) => a.status)})`);
  const openQs = view.checkpoint.openQuestions.filter((q) => q.status === 'open');
  assert.equal(openQs.length, 1);
  assert.match(openQs[0].text, /caption/);
  // Second sweep with nothing running drives nothing.
  const r2 = await sup.sweep();
  assert.equal(r2.driven, 0);
  await sup.dispose();
});

test('R2: dialog question parks the turn; the user answer resumes the LIVE process', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Wire the import dialog.', bindings: { intent: 'test-grill-ui' } });

  const { sup, spawns } = mkSupervisor(env, {
    spawnScripts: [[
      {
        type: 'dialog',
        dialog: { method: 'select', title: 'Which import source?', options: ['csv', 'json'] },
        after: SETTLE({ decisions: ['import source: csv'] }),
      },
    ]],
  });
  await sup.sweep();
  let view = await prepView(svc, 'card-a');
  assert.equal(
    await until(async () => (await prepView(svc, 'card-a'))
      .checkpoint.openQuestions.some((x) => x.status === 'open' && x.channel === 'dialog')),
    true, 'dialog request minted a durable question',
  );
  view = await prepView(svc, 'card-a');
  const q = view.checkpoint.openQuestions.find((x) => x.status === 'open' && x.channel === 'dialog');
  assert.ok(q, 'dialog request minted a durable question');
  assert.equal(q.dialog.method, 'select');
  assert.equal(spawns.length, 1);

  // User answers — the attempt goes running again; next sweep delivers the
  // response to the SAME live transport (no respawn while the plan holds).
  const a = await ucmd(svc, 'card-a', 'answer_question', { questionId: q.questionId, answer: 'csv' });
  assert.equal(a.status, 200, J(a.json));
  await sup.sweep();
  assert.equal(await until(() => spawns[0].responses.length === 1), true,
    'the recorded answer reached the live process');
  assert.equal(spawns.length, 1, 'answer delivered in-process — no respawn');
  assert.match(spawns[0].responses[0].id, /^ui-0-/, 'response bound to the recorded rpc request id');
  assert.equal(spawns[0].responses[0].fields.value ?? spawns[0].responses[0].fields.text, 'csv');

  assert.equal(
    await until(async () => (await prepView(svc, 'card-a'))
      .checkpoint.decisions.some((d) => /csv/.test(d.text ?? ''))),
    true, 'decision landed',
  );
  await sup.dispose();
});

test('R3: supervisor replacement resumes the SAME discussion from the durable checkpoint', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Document the retry policy.' });

  // Supervisor A runs the kickoff turn and is disposed — the runner restart
  // case: in-memory state dies, durable checkpoint survives.
  const a = mkSupervisor(env, {
    spawnScripts: [[SETTLE({ questions: [{ text: 'What is the max retry count?', blocking: true }] })]],
  });
  await a.sup.sweep();
  assert.equal(await until(() => a.spawns.length === 1), true);
  assert.equal(
    await until(async () => (await prepView(svc, 'card-a'))
      .checkpoint.openQuestions.some((x) => x.status === 'open')),
    true,
  );
  await a.sup.dispose();
  assert.equal(a.spawns[0].alive(), false, 'dispose closed the CLI transport');

  // The user answers while NO supervisor exists — the durable record holds it.
  const v1 = await prepView(svc, 'card-a');
  const q = v1.checkpoint.openQuestions.find((x) => x.status === 'open');
  const ar = await ucmd(svc, 'card-a', 'answer_question', { questionId: q.questionId, answer: '3' });
  assert.equal(ar.status, 200, J(ar.json));

  // Supervisor B — a fresh process generation — discovers the work and
  // resumes the SAME discussion identity.
  const b = mkSupervisor(env, {
    spawnScripts: [[SETTLE({ decisions: ['max retries: 3'] })]],
  });
  await b.sup.sweep();
  assert.equal(await until(() => b.spawns.length === 1), true);
  assert.equal(await until(() => (b.spawns[0]?.prompts.length ?? 0) >= 1), true,
    'the resumed turn prompt was sent');
  const prompt = b.spawns[0].prompts[0];
  assert.match(prompt, /CONTINUE this same discussion|checkpoint/i,
    'resume prompt carries the checkpoint note');
  assert.match(prompt, /max retry count/i, 'the open-question context is in the prompt');
  // The plan reuses one discussion name — never a new interview.
  assert.equal(b.spawns[0].plan.args.includes('--name'), true);
  const v2 = await prepView(svc, 'card-a');
  const answered = v2.checkpoint.openQuestions.find((x) => x.questionId === q.questionId);
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, '3');
  await b.sup.dispose();
});

test('R4: per-card failure isolation — one broken card never starves another', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir, [cardFixture('card-a'), cardFixture('card-b', { order: 20 })]);
  await enable(svc, 'card-a');
  await enable(svc, 'card-b');
  await startPrep(svc, 'card-a', { intent: 'card A work' });
  await startPrep(svc, 'card-b', { intent: 'card B work' });

  const spawns = [];
  const sup = createPreparationSupervisor({
    client: mkClient(svc, env.stateDir),
    stateDir: env.stateDir,
    env: {},
    registryPath: env.registryPath,
    transportFactory: (plan, ctx) => {
      if (ctx.cardId === 'card-a') throw new Error('card A factory exploded');
      const t = createFakePiTransport({ turns: [SETTLE({ decisions: ['b done'] })], spawnIndex: spawns.length });
      t.plan = plan; t.spawnCtx = ctx;
      spawns.push(t);
      return t;
    },
    limits: LEAD_LIMITS,
    log: () => {},
  });
  const r = await sup.sweep();
  assert.equal(r.driven, 2, 'both cards dispatched — one card\'s fault never gates the sweep');
  assert.equal(
    await until(async () => (await prepView(svc, 'card-b'))
      .checkpoint.decisions.some((d) => d.text === 'b done')),
    true, 'card B still drove to completion',
  );
  // card-a's drive fault is per-card: the sweep counted it as driven (the
  // drive returned an error status), the card simply doesn't settle.
  const va = await prepView(svc, 'card-a');
  assert.ok(va.attempts.some((a) => a.status === 'running'),
    'card A attempt still running (its drives keep erroring until the restart bound)');
  await sup.dispose();
});

test('R5: always-failing spawn is bounded — cli_lost after the restart cap', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Transcript export.' });

  const sup = createPreparationSupervisor({
    client: mkClient(svc, env.stateDir),
    stateDir: env.stateDir,
    env: {},
    registryPath: env.registryPath,
    transportFactory: () => { throw new Error('generic spawn fault'); },
    limits: { ...LEAD_LIMITS, maxRestarts: 2 },
    log: () => {},
  });
  // maxRestarts=2 → the FIRST drive spawns (not a restart), then 2 respawns
  // are allowed; the 4th drive refuses with cli_lost. Sweeps keep driving
  // while the attempt stays running.
  let att = null;
  for (let i = 0; i < 8; i += 1) {
    await sup.sweep();
    await sleep(60); // let the dispatched drive settle
    const v = await prepView(svc, 'card-a');
    att = v.attempts[v.attempts.length - 1];
    if (att.status !== 'running') break;
  }
  assert.equal(att.status, 'failed', `attempt must fail cli_lost, got ${att?.status}`);
  await sup.dispose();
});

test('R6: deterministic config fault blocks the attempt — no respawn churn', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Needs the profile auth.' });

  // The default transport factory seeds the agent dir — an empty source
  // dir yields prep_agent_dir_unprovisioned → the attempt blocks (not
  // cli_lost), and the card quiesces: no more sweeps drive it.
  const source = join(env.root, 'empty-agent');
  await fs.mkdir(source, { recursive: true });
  const sup = createPreparationSupervisor({
    client: mkClient(svc, env.stateDir),
    stateDir: env.stateDir,
    env: {},
    registryPath: env.registryPath,
    agentDirSource: source,
    spawnImpl: () => { throw new Error('must not be reached'); },
    limits: LEAD_LIMITS,
    log: () => {},
  });
  await sup.sweep();
  assert.equal(
    await until(async () =>
      (await prepView(svc, 'card-a')).attempts.at(-1)?.status === 'blocked'),
    true, 'unprovisioned agent dir blocks the attempt, honestly named',
  );
  const att = (await prepView(svc, 'card-a')).attempts.at(-1);
  const r2 = await sup.sweep();
  assert.equal(r2.driven, 0, 'a blocked attempt is never re-driven');
  const st = sup.stats();
  assert.equal(st.errors, 0, 'the config fault is an attempt result, not a sweep error');
  await sup.dispose();
});

test('R7: dispose inside the drain bound closes a parked transport', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Park me.', bindings: { intent: 'test-grill-ui' } });

  const { sup, spawns } = mkSupervisor(env, {
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'input', title: 'open forever' }, after: null },
    ]],
  });
  await sup.sweep();
  assert.equal(await until(() => spawns.length === 1 && spawns[0].alive()), true,
    'the dialog turn is parked on the live process');
  const t0 = Date.now();
  const res = await sup.dispose({ drainMs: 400 });
  assert.ok(Date.now() - t0 < 1500, 'dispose stayed inside the bound');
  assert.equal(spawns[0].alive(), false, 'dispose closed the parked CLI process');
  assert.ok(res.abandoned >= 0);
});

test('R8: stop fences sweeps; stopped session tears down its live process', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Park then stop.', bindings: { intent: 'test-grill-ui' } });

  const { sup, spawns } = mkSupervisor(env, {
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'input', title: 'q' }, after: null },
    ]],
  });
  await sup.sweep();
  assert.equal(await until(() => spawns.length === 1 && spawns[0].alive()), true);

  // User stops the session — the row still carries a live in-memory driver
  // state, so the next sweep tears the process down honestly.
  const st = await ucmd(svc, 'card-a', 'stop_preparation', {});
  assert.equal(st.status, 200, J(st.json));
  await sup.sweep();
  assert.equal(await until(() => !spawns[0].alive()), true,
    'stopped session released the CLI process');

  sup.stop();
  const r = await sup.sweep();
  assert.equal(r.driven, 0, 'fenced supervisor issues no work');
  await sup.dispose();
});

test('R9: unsupported binding fails closed at start — and at drive time', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  // The server refuses the route at command time.
  const refused = await ucmd(svc, 'card-a', 'start_preparation',
    { intent: 'x', bindings: { intent: 'test-unsupported' } });
  assert.notEqual(refused.status, 200, 'unsupported route refused at start');

  // An available binding that goes CANDIDATE between assignment and drive
  // surfaces route_unproven as an attempt blocker (never silently run).
  await startPrep(svc, 'card-a', { intent: 'Bind me', bindings: { intent: 'test-grill-ui' } });
  // Flip the binding to candidate in the registry file, then drive.
  const reg = await loadRegistry(env.registryPath);
  const b = reg.bindings.find((x) => x.bindingId === 'test-grill-ui');
  b.status = 'candidate';
  await fs.writeFile(env.registryPath, J(reg), 'utf-8');

  const { sup, spawns } = mkSupervisor(env);
  await sup.sweep();
  await sleep(30);
  assert.equal(spawns.length, 0, 'no CLI spawned for an unproven route');
  const view = await prepView(svc, 'card-a');
  const att = view.attempts[view.attempts.length - 1];
  assert.equal(att.status, 'blocked', `expected blocked attempt, got ${att.status}`);
  await sup.dispose();
});

test('R10: default factory seeds a per-session agent dir (auth + model)', async () => {
  const env = await mkEnv();
  const { svc, projectDir, root } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'Seed the profile.' });

  // A source profile carrying auth; spawnImpl returns an inert child that
  // stays open (the drive parks it / dispose closes it).
  const source = join(root, 'pi-agent-src');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(join(source, 'auth.json'), J({ 'zen-relay': { type: 'api_key', key: 'x' } }), { mode: 0o600 });
  await fs.writeFile(join(source, 'models.json'), J({ providers: {} }), 'utf-8');
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    const ee = new EventEmitter();
    ee.stdin = new PassThrough();
    ee.stdout = new PassThrough();
    ee.stderr = new PassThrough();
    ee.pid = 99000 + spawned.length;
    ee.kill = () => { ee.emit('exit', null, 'SIGTERM'); ee.emit('close', null, 'SIGTERM'); return true; };
    spawned.push({ cmd, args, opts, ee });
    return ee;
  };
  const sup = createPreparationSupervisor({
    client: mkClient(svc, env.stateDir),
    stateDir: env.stateDir,
    env: { ACP_PREP_PROVIDER: 'zen-relay', ACP_PREP_MODEL: 'muse-test', ACP_PREP_THINKING: 'low' },
    registryPath: env.registryPath,
    agentDirSource: source,
    spawnImpl,
    limits: { ...LEAD_LIMITS, idleTimeoutMs: 250, startTimeoutMs: 250, turnTimeoutMs: 900 },
    log: () => {},
  });
  await sup.sweep();
  assert.equal(await until(() => spawned.length >= 1), true, 'the real spawn path ran');
  const { cmd, args, opts } = spawned[0];
  assert.equal(cmd, 'pi');
  assert.ok(args.includes('--mode') && args.includes('rpc'), 'rpc mode argv');
  assert.ok(args.includes('--provider') && args.includes('zen-relay'));
  assert.ok(args.includes('--model') && args.includes('muse-test'));
  assert.equal(opts.env.PI_CODING_AGENT_DIR.includes(root), true,
    'per-session agent dir under the execution store, not the host profile');
  const agentDir = opts.env.PI_CODING_AGENT_DIR;
  const auth = await fs.readFile(join(agentDir, 'auth.json'), 'utf-8');
  assert.match(auth, /zen-relay/, 'auth.json seeded from the source profile');
  const settings = JSON.parse(await fs.readFile(join(agentDir, 'settings.json'), 'utf-8'));
  assert.equal(settings.defaultModel, 'muse-test');
  assert.equal(settings.defaultThinkingLevel, 'low');
  // The prompt is on stdin — the wire frame the real transport writes.
  await sup.dispose({ drainMs: 500 });
});

test('R11: concurrent sweeps serialize — one pass at a time', async () => {
  const env = await mkEnv();
  const { svc, projectDir } = env;
  await seedBase(svc, projectDir);
  await enable(svc, 'card-a');
  await startPrep(svc, 'card-a', { intent: 'x' });
  const { sup, spawns } = mkSupervisor(env, {
    spawnScripts: [[
      { type: 'dialog', dialog: { method: 'input', title: 'hold' }, after: null },
    ]],
  });
  const [r1, r2, r3] = await Promise.all([sup.sweep(), sup.sweep(), sup.sweep()]);
  assert.ok(r1.driven <= 1 && r2.driven <= 1 && r3.driven <= 1);
  assert.equal(await until(() => spawns.length === 1), true);
  assert.ok(spawns.length <= 1, `one drive total, spawns=${spawns.length}`);
  await sup.dispose({ drainMs: 500 });
});
