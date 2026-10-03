// scripts/test_preparation_skills.mjs — P2 SkillBinding/compatibility tests.
//   node --test scripts/test_preparation_skills.mjs
//
// Deterministic coverage for the P2 contract (plan KTD3–KTD7):
//   * declared binding contracts — adapterId/requires/gateContract/result —
//     validated fail-closed at registry load (validateRegistry is the
//     production factory; nothing here constructs a registry bypass);
//   * capability preflight + adapter compatibility at ASSIGNMENT time through
//     the real createStateService command surface (start_preparation /
//     change_skill_binding), including the injected capability/adapter ctx
//     seams the production service exposes;
//   * version snapshots: resource digest AND config digest pinned per
//     assignment; registry repin vs contract edit are distinct stale
//     blockers; same-id change_skill_binding is the explicit migration that
//     retains the checkpoint and remints dependent gates;
//   * result containment: skill output is data — command/api/tool/exec
//     channels refuse outright (top level AND nested), documents/handoffs
//     are enforced against the binding's declared result contract, declared
//     handoffs are recorded as evidence and never dispatched;
//   * original resources: loadBindingResources serves the exact pinned
//     bytes (re-hashed per file), planInvocation passes the pinned dirs to
//     pi via --skill — nothing is rewritten or imitated;
//   * provider/upstream sources are untouched: every production binding's
//     manifest digest + config digest is snapshotted before and after the
//     suite and must be identical, and verifyManifest re-hash stays green.
//
// No network, no pi spawn, no listeners; tmpfs fixtures only.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { loadAggregate } from '../server/execution/execution-store.mjs';
import {
  loadRegistry, validateRegistry, buildManifest, verifyManifest,
  bindingById, bindingConfigDigest,
} from '../server/execution/preparation/skills/registry.mjs';
import { preflightContract, preflightBinding } from '../server/execution/preparation/skills/preflight.mjs';
import {
  ADAPTERS, adapterFor, planInvocation, translateResult, assertResultChannels,
} from '../server/execution/preparation/skills/adapters.mjs';
import {
  defaultHostCapabilities, requiredCapabilities, missingCapabilities,
} from '../server/execution/preparation/skills/capabilities.mjs';
import { loadBindingResources, resourceSnapshot } from '../server/execution/preparation/skills/resources.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PROD_REGISTRY = join(ROOT, 'server/execution/preparation/skills/bindings.json');
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
const J = (o) => JSON.stringify(o);

// ---- fixtures ---------------------------------------------------------------

const cleanupRoots = new Set();
after(async () => {
  for (const r of cleanupRoots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
const myGid = typeof process.getgid === 'function' ? process.getgid() : null;

async function mkProject() {
  const dir = join(tmpdir(), `p2-proj-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(dir);
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['init', '-q', dir], { timeout: 10000 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

const GATE_CONTRACT_FOR = {
  intent: [{ type: 'intent_confirm', stage: 'intent' }],
  requirements: [{ type: 'artifact_confirm', stage: 'requirements' }],
  design: [{ type: 'artifact_confirm', stage: 'design' }],
  plan: [{ type: 'artifact_confirm', stage: 'plan' }],
  review: [],
};
const RESULT_FOR = {
  intent: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
  requirements: {
    mode: 'workspace_artifact', docKind: 'requirements', importAs: 'document',
    artifacts: ['docs/requirements-*.md'], handoffs: [],
  },
  design: {
    mode: 'workspace_artifact', docKind: 'design', importAs: 'document',
    artifacts: ['docs/design-*.md'], handoffs: [],
  },
  plan: {
    mode: 'workspace_artifact', docKind: 'plan', importAs: 'document',
    artifacts: ['docs/plans/*.md'], handoffs: [],
  },
  review: { mode: 'review_report', importAs: 'none', artifacts: [], handoffs: [] },
};

// Test-local SkillBinding registry: real skill dirs on tmpfs pinned via the
// production buildManifest — same data shape as bindings.json. Several
// bindings exist ONLY to be refused (missing capability, ghost adapter,
// old contract, unservable tool, unpinned resources) — their refusal IS
// the tested behavior.
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
      handoffs: [{ to: 'test-brainstorm', mode: 'host_choice', reason: 'scope frozen → draft requirements' }],
    }],
    ['test-grill-alt', 'intent', 'available', {}],
    ['test-brainstorm', 'requirements', 'available', {}],
    ['test-recorder', 'requirements', 'available', {
      // Contract-bound route that does NOT import documents — results with a
      // document for this stage must refuse as off-contract.
      result: { mode: 'workspace_artifact', docKind: 'requirements', importAs: 'none', artifacts: [], handoffs: [] },
    }],
    ['test-silent', 'requirements', 'available', {
      // Declared EMPTY gate contract — a route that carries no user gate.
      gateContract: [],
    }],
    ['test-arch', 'design', 'available', {}],
    ['test-plan', 'plan', 'available', {}],
    ['test-review', 'review', 'available', {}],
    ['test-native', 'intent', 'available', { requires: ['native.mindmeld'] }],
    ['test-ghost', 'intent', 'available', { adapterId: 'ghost-adapter' }],
    ['test-oldver', 'intent', 'available', { adapterVersion: 'v0-ancient' }],
    ['test-laser', 'intent', 'available', { tools: ['read', 'laser'] }],
    ['test-unpinned', 'intent', 'available', { unpinned: true }],
    ['test-candidate', 'intent', 'candidate', {}],
    ['test-unsupported', 'plan', 'unsupported', {}],
  ];
  const bindings = [];
  for (const [bindingId, stage, status, extra] of defs) {
    const b = {
      bindingId, stage, status,
      title: `Test ${bindingId}`,
      provider: 'test',
      adapterId: 'pi-skill',
      adapterVersion: 'pi-skill-1',
      skillDirs: [await mk(bindingId)],
      extraResources: [],
      questionChannel: 'chat',
      tools: ['read', 'write'],
      requires: [],
      readOnlyRoots: [],
      skillNames: [bindingId],
      expect: { artifacts: [], frontmatter: {}, minChatQuestions: 0, minUiRequests: 0 },
    };
    if (status === 'available') {
      b.gateContract = extra.gateContract ?? GATE_CONTRACT_FOR[stage];
      b.result = extra.result ?? {
        ...RESULT_FOR[stage],
        handoffs: extra.handoffs ?? RESULT_FOR[stage].handoffs,
      };
    }
    if (extra.requires) b.requires = extra.requires;
    if (extra.adapterId) b.adapterId = extra.adapterId;
    if (extra.adapterVersion) b.adapterVersion = extra.adapterVersion;
    if (extra.tools) b.tools = extra.tools;
    if (status === 'unsupported') {
      b.unsupported = { reason: 'implementation_authority_denied', detail: 'test route', route: '' };
      delete b.adapterId;
      delete b.adapterVersion;
    }
    if (!extra.unpinned) b.resourceManifest = await buildManifest(b);
    bindings.push(b);
  }
  const registryPath = join(root, 'bindings.json');
  await fs.writeFile(registryPath, J({
    schemaVersion: 1, pi: { binary: 'pi', version: '0.85.1' }, bindings,
  }), 'utf-8');
  return { registryPath, skillsDir, bindings };
}

async function mkEnv({ preparation } = {}) {
  const root = join(tmpdir(), `p2-state-${randomUUID().slice(0, 8)}`);
  cleanupRoots.add(root);
  const stateDir = join(root, 'state');
  const projectDir = await mkProject();
  await fs.mkdir(stateDir, { recursive: true });
  const registryPath = preparation?.registryPath ?? (await mkRegistry(root)).registryPath;
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
    preparation: { ...preparation, registryPath },
  });
  return { root, stateDir, projectDir, svc, registryPath };
}

// ---- request helpers (same production request surface as P1) ----------------

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
const blockerCodes = (view) => new Set((view?.blockers || []).map((b) => b.code));

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
    commandId, type, expectedControlRevision: c.json.controlRevision, payload,
  });
}
async function mustStartPrep(svc, cardId, payload) {
  const r = await ucmd(svc, cardId, 'start_preparation', payload);
  assert.equal(r.status, 200, J(r.json));
  return r.json.result;
}
async function prepView(svc, cardId) {
  const r = await getPrep(svc, cardId);
  assert.equal(r.status, 200, J(r.json));
  return r.json.preparation;
}
// internalCommand returns {status, body} — success body is {result},
// failure body is {error, code, ...structured details}.
async function prepResult(svc, cardId, attemptId, body) {
  const card = (await getCard(svc, cardId)).json;
  return svc.internalCommand(cardId, {
    commandId: `pr-${randomUUID().slice(0, 8)}`,
    type: 'prep_result',
    expectedInternalRevision: card.internalRevision,
    payload: { attemptId, result: body },
  });
}
const kickoffId = async (svc, cardId) =>
  (await prepView(svc, cardId)).attempts.find((a) => a.kind === 'kickoff').attemptId;

// ============================================================================
// Registry contract — declared fields validate fail-closed at load
// ============================================================================

test('registry: production bindings carry the full declared contract', async () => {
  const reg = await loadRegistry(PROD_REGISTRY);
  assert.equal(reg.bindings.length, 12);
  const available = reg.bindings.filter((b) => b.status === 'available');
  assert.equal(available.length, 6);
  for (const b of available) {
    assert.equal(b.adapterId, 'pi-skill', `${b.bindingId} needs adapterId`);
    assert.equal(typeof b.adapterVersion, 'string', `${b.bindingId} needs adapterVersion`);
    assert.ok(Array.isArray(b.requires), `${b.bindingId} needs requires[]`);
    assert.ok(Array.isArray(b.gateContract), `${b.bindingId} needs a declared gateContract`);
    assert.ok(b.result && typeof b.result === 'object', `${b.bindingId} needs a result contract`);
    assert.ok(b.resourceManifest?.digest, `${b.bindingId} needs a pinned manifest digest`);
    // declared handoff targets resolve to registered bindings
    for (const h of b.result.handoffs) {
      assert.ok(reg.bindings.some((x) => x.bindingId === h.to),
        `${b.bindingId} handoff target ${h.to} must be registered`);
    }
  }
  for (const b of reg.bindings.filter((x) => x.status === 'unsupported')) {
    assert.ok(b.unsupported?.reason, `${b.bindingId} needs a refusal reason`);
  }
});

test('registry: an available binding without a declared contract is refused', async () => {
  const mk = (over) => ({
    schemaVersion: 1, pi: { version: '0.85.1' },
    bindings: [{
      bindingId: 'bad', stage: 'intent', status: 'available',
      adapterId: 'pi-skill', adapterVersion: 'pi-skill-1',
      skillDirs: ['/x'], extraResources: [], skillNames: ['x'],
      questionChannel: 'chat', tools: ['read'], readOnlyRoots: [],
      ...over,
    }],
  });
  // No gateContract → an available route cannot omit its gate declaration.
  assert.throws(() => validateRegistry(mk({
    result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
  })), (e) => e.code === 'invalid_registry' && /gateContract/.test(e.message));
  // No result contract.
  assert.throws(() => validateRegistry(mk({
    gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
  })), (e) => e.code === 'invalid_registry' && /result/.test(e.message));
  // Malformed gate contract shape.
  assert.throws(() => validateRegistry(mk({
    gateContract: { type: 'intent_confirm' },
    result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
  })), (e) => e.code === 'invalid_registry');
  // A gate type the vocabulary does not know.
  assert.throws(() => validateRegistry(mk({
    gateContract: [{ type: 'auto_approve', stage: 'intent' }],
    result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
  })), (e) => e.code === 'invalid_registry' && /gateContract/.test(e.message));
  // An artifact gate must name a document stage.
  assert.throws(() => validateRegistry(mk({
    gateContract: [{ type: 'artifact_confirm', stage: 'intent' }],
    result: { mode: 'conversation', importAs: 'none', artifacts: [], handoffs: [] },
  })), (e) => e.code === 'invalid_registry');
  // A document result for a stage other than the binding's own.
  assert.throws(() => validateRegistry(mk({
    gateContract: [{ type: 'intent_confirm', stage: 'intent' }],
    result: { mode: 'workspace_artifact', docKind: 'plan', importAs: 'document', artifacts: [], handoffs: [] },
  })), (e) => e.code === 'invalid_registry' && /docKind/.test(e.message));
});

test('registry: a handoff to an unregistered binding refuses at load', async () => {
  assert.throws(() => validateRegistry({
    schemaVersion: 1, pi: { version: '0.85.1' },
    bindings: [{
      bindingId: 'h', stage: 'intent', status: 'available',
      adapterId: 'pi-skill', adapterVersion: 'pi-skill-1',
      skillDirs: ['/x'], extraResources: [], skillNames: ['x'],
      questionChannel: 'chat', tools: ['read'], readOnlyRoots: [],
      gateContract: [],
      result: {
        mode: 'conversation', importAs: 'none', artifacts: [],
        handoffs: [{ to: 'never-registered', mode: 'host_choice' }],
      },
    }],
  }), (e) => e.code === 'invalid_registry' && /handoff target/.test(e.message));
});

test('config digest: canonical across key order, moves with any contract field', async () => {
  const reg = await loadRegistry(PROD_REGISTRY);
  const b = bindingById(reg, 'ce-plan');
  const d1 = bindingConfigDigest(b);
  const d2 = bindingConfigDigest(b);
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
  // Key-order permutations serialize identically.
  const shuffled = JSON.parse(J(b));
  shuffled.result = { handoffs: b.result.handoffs, artifacts: b.result.artifacts, importAs: b.result.importAs, docKind: b.result.docKind, mode: b.result.mode };
  assert.equal(bindingConfigDigest(shuffled), d1);
  // Each contract field is inside the digest.
  const otherChannel = b.questionChannel === 'chat' ? 'extension_ui' : 'chat';
  for (const mut of [
    { adapterVersion: 'other' }, { questionChannel: otherChannel },
    { requires: ['scratch.extra'] }, { gateContract: [] },
    { tools: ['read'] },
  ]) {
    assert.notEqual(bindingConfigDigest({ ...b, ...mut }), d1, `mutation ${J(mut)} must move the digest`);
  }
  // A result-contract edit moves the digest too.
  const resultMut = { ...b, result: { ...b.result, importAs: 'draft' } };
  assert.notEqual(bindingConfigDigest(resultMut), d1);
  // The resource manifest is a SEPARATE identity — a repin does not pretend
  // to be a config change and vice versa.
  assert.equal(bindingConfigDigest({ ...b, resourceManifest: { digest: 'x'.repeat(64) } }), d1);
});

// ============================================================================
// Preflight — every failure mode refuses before anything commits
// ============================================================================

test('preflight: unsupported/candidate routes refuse before planning', async () => {
  const reg = await loadRegistry(PROD_REGISTRY);
  const unsupported = bindingById(reg, 'ce-work');
  for (const fn of [
    () => preflightContract(unsupported),
    () => planInvocation(unsupported, {
      sessionDir: '/tmp/x', agentDir: '/tmp/y', workspace: '/tmp/z',
    }),
  ]) {
    assert.throws(fn, (e) => e.code === 'route_unsupported'
      && e.bindingId === 'ce-work'
      && e.reason === 'implementation_authority_denied');
  }
  // adapterFor is the adapter-resolution seam — route truth is upstream of
  // it; an unsupported binding still cannot resolve (it declares no adapter).
  assert.throws(() => adapterFor(unsupported),
    (e) => e.code === 'adapter_unavailable' && e.bindingId === 'ce-work');
  const { registryPath } = await mkRegistry(join(tmpdir(), `p2-pre-${randomUUID().slice(0, 8)}`));
  cleanupRoots.add(join(registryPath, '..'));
  const treg = await loadRegistry(registryPath);
  const cand = bindingById(treg, 'test-candidate');
  assert.throws(() => preflightContract(cand), (e) => e.code === 'route_unproven');
});

test('preflight: missing capability / adapter failures carry structured details', async () => {
  const { registryPath } = await mkRegistry(join(tmpdir(), `p2-cap-${randomUUID().slice(0, 8)}`));
  cleanupRoots.add(join(registryPath, '..'));
  const reg = await loadRegistry(registryPath);
  const host = defaultHostCapabilities();

  // Declared native capability this host does not provide.
  assert.throws(
    () => preflightContract(bindingById(reg, 'test-native'), { hostCapabilities: host }),
    (e) => e.code === 'capability_missing'
      && e.bindingId === 'test-native'
      && J(e.missing) === J(['native.mindmeld'])
      && e.required.includes('native.mindmeld'));

  // Unregistered adapter id.
  assert.throws(
    () => preflightContract(bindingById(reg, 'test-ghost'), { hostCapabilities: host }),
    (e) => e.code === 'adapter_unavailable' && e.adapterId === 'ghost-adapter');

  // Declared adapter contract version the adapter does not support.
  assert.throws(
    () => preflightContract(bindingById(reg, 'test-oldver'), { hostCapabilities: host }),
    (e) => e.code === 'adapter_version_unsupported' && e.adapterVersion === 'v0-ancient');

  // A tool the adapter cannot serve → adapter_unsafe.
  assert.throws(
    () => preflightContract(bindingById(reg, 'test-laser'), { hostCapabilities: host }),
    (e) => e.code === 'adapter_unsafe' && J(e.unservable) === J(['laser']));

  // No pinned manifest → resources_unpinned.
  assert.throws(
    () => preflightContract(bindingById(reg, 'test-unpinned'), { hostCapabilities: host }),
    (e) => e.code === 'resources_unpinned');

  // Reduced host descriptor: tools surface shrinks → capability_missing.
  const reduced = { question: ['chat'], tools: ['read'], workspace: ['git'], scratch: [], runtime: ['pi'], native: [] };
  assert.throws(
    () => preflightContract(bindingById(reg, 'test-grill'), { hostCapabilities: reduced }),
    (e) => e.code === 'capability_missing' && J(e.missing) === J(['tool.write']));

  // An injected adapter map that lacks the binding's adapter → unavailable.
  assert.throws(
    () => preflightContract(bindingById(reg, 'test-grill'), { hostCapabilities: host, adapters: {} }),
    (e) => e.code === 'adapter_unavailable');

  // A healthy binding resolves cleanly and reports BOTH digests.
  const pf = await preflightBinding(bindingById(reg, 'test-grill'), { hostCapabilities: host, fsCheck: false });
  assert.equal(pf.adapterId, 'pi-skill');
  assert.equal(pf.digest, bindingById(reg, 'test-grill').resourceManifest.digest);
  assert.equal(pf.configDigest, bindingConfigDigest(bindingById(reg, 'test-grill')));
  assert.deepEqual(pf.gateContract, [{ type: 'intent_confirm', stage: 'intent' }]);
  assert.equal(pf.capabilities.satisfied, true);
});

test('preflight: drifted pinned resource refuses the full check', async () => {
  const { registryPath, bindings } = await mkRegistry(join(tmpdir(), `p2-drift-${randomUUID().slice(0, 8)}`));
  const reg = await loadRegistry(registryPath);
  const b = bindingById(reg, 'test-arch');
  await fs.appendFile(join(b.skillDirs[0], 'helper.txt'), 'tampered\n', 'utf-8');
  await assert.rejects(
    preflightBinding(b, { hostCapabilities: defaultHostCapabilities(), fsCheck: false }),
    (e) => e.code === 'resource_mismatch' && e.changed.length === 1);
  // A missing resource is a distinct refusal.
  const gone = { ...bindings.find((x) => x.bindingId === 'test-plan') };
  await fs.rm(join(gone.skillDirs[0], 'helper.txt'));
  await assert.rejects(
    preflightBinding(gone, { hostCapabilities: defaultHostCapabilities(), fsCheck: false }),
    (e) => e.code === 'resource_mismatch' && e.missing.length === 1);
});

// ============================================================================
// Original resources — the pinned bytes are what runs
// ============================================================================

test('resources: loader serves the exact pinned bytes; drift refuses', async () => {
  const { registryPath } = await mkRegistry(join(tmpdir(), `p2-res-${randomUUID().slice(0, 8)}`));
  cleanupRoots.add(join(registryPath, '..'));
  const reg = await loadRegistry(registryPath);
  const b = bindingById(reg, 'test-brainstorm');

  const loaded = await loadBindingResources(b, { includeText: true });
  assert.equal(loaded.digest, b.resourceManifest.digest);
  assert.equal(loaded.files.length, b.resourceManifest.files.length);
  // Every loaded byte string equals the file's true content — nothing is
  // rewritten, templated, or imitated.
  for (const f of loaded.files) {
    const raw = await fs.readFile(f.path, 'utf-8');
    assert.equal(f.text, raw, `${f.path} must be the original bytes`);
    const pinned = b.resourceManifest.files.find((x) => x.path === f.path);
    assert.equal(f.sha256, pinned.sha256);
  }
  // entries[] are the skill entry points — the SKILL.md per skillDir,
  // proven from the pinned set.
  assert.equal(loaded.entries.length, b.skillDirs.length);
  assert.equal(loaded.entries[0].name, 'test-brainstorm');
  const snap = resourceSnapshot(b);
  assert.equal(snap.digest, b.resourceManifest.digest);
  assert.equal(snap.fileCount, b.resourceManifest.files.length);

  // Drift is caught per-file on load — a changed file never reaches runtime.
  await fs.appendFile(join(b.skillDirs[0], 'helper.txt'), 'tampered\n', 'utf-8');
  await assert.rejects(
    loadBindingResources(b),
    (e) => e.code === 'resource_mismatch' && e.changed.length === 1);
});

test('adapter plan: argv passes the pinned dirs via --skill; refuses bad inputs', async () => {
  const { registryPath } = await mkRegistry(join(tmpdir(), `p2-plan-${randomUUID().slice(0, 8)}`));
  cleanupRoots.add(join(registryPath, '..'));
  const reg = await loadRegistry(registryPath);
  const b = bindingById(reg, 'test-brainstorm');
  const ws = join(tmpdir(), `p2-ws-${randomUUID().slice(0, 8)}`);
  const plan = planInvocation(b, {
    piBinary: 'pi',
    model: { provider: 'openai-codex', id: 'gpt-5.1-codex-mini', thinking: 'low' },
    sessionDir: join(ws, '.sessions'),
    agentDir: join(ws, '.agent'),
    workspace: ws,
    auditPath: join(ws, 'audit.jsonl'),
  });
  // The pinned skill directories are handed to pi verbatim — the provider's
  // own loader reads the original SKILL.md; no prompt text is inlined.
  for (const d of b.skillDirs) {
    const i = plan.args.indexOf('--skill');
    assert.ok(i >= 0 && plan.args[i + 1] === d, '--skill must name the pinned dir');
  }
  assert.ok(plan.args.includes('--no-skills'), 'implicit skills stay off');
  assert.ok(plan.args.includes('--no-context-files'));
  assert.ok(plan.args.includes('--no-extensions'));
  const ei = plan.args.indexOf('-e');
  assert.ok(ei >= 0 && /preparation-bridge\.ts$/.test(plan.args[ei + 1]), 'the bridge extension is attached');
  const ti = plan.args.indexOf('--tools');
  assert.equal(plan.args[ti + 1], 'read,write');
  assert.equal(plan.cwd, ws);
  assert.equal(plan.env.PI_OFFLINE, '1');
  assert.equal(plan.env.PI_CODING_AGENT_DIR, join(ws, '.agent'));
  assert.ok(J(plan.env.ACP_PREP_WRITE_ROOTS).includes(ws));
  assert.equal(plan.env.ACP_PREP_BINDING, 'test-brainstorm');
  assert.deepEqual(plan.skillDirs, b.skillDirs);

  // Planning is pure — it must refuse the same refuse-first failures.
  assert.throws(() => planInvocation({ ...b, adapterVersion: 'bogus' }, {
    sessionDir: '/tmp/x', agentDir: '/tmp/y', workspace: ws,
  }), (e) => e.code === 'adapter_version_unsupported');
  assert.throws(() => planInvocation({ ...b, resourceManifest: undefined }, {
    sessionDir: '/tmp/x', agentDir: '/tmp/y', workspace: ws,
  }), (e) => e.code === 'resources_unpinned');
  assert.throws(() => planInvocation(b, { agentDir: '/tmp/y', workspace: ws }),
    (e) => e.code === 'invalid_argument');
});

// ============================================================================
// Result channels — skill output can never mint commands (KTD6)
// ============================================================================

test('result channels: command/api/tool/exec keys refuse outright', () => {
  const bad = [
    { commands: [{ type: 'enable' }] },
    { api: { method: 'POST', path: '/api/execution' } },
    { toolCalls: [{ tool: 'bash', args: { command: 'rm -rf /' } }] },
    { exec: 'rm -rf ~' },
    { admin: true },
    { note: 'ok', commands: [] },
  ];
  for (const r of bad) {
    assert.throws(() => assertResultChannels(r),
      (e) => e.code === 'result_channel_unsupported' && e.offending?.length >= 1,
      `${J(r)} must refuse`);
  }
  // Nested smuggles inside whitelisted objects refuse the same way.
  assert.throws(() => assertResultChannels({ document: { kind: 'plan', text: 'x', exec: 'rm' } }),
    (e) => e.code === 'result_channel_unsupported' && J(e.offending) === J(['exec']));
  assert.throws(() => assertResultChannels({ proposal: { intentRestatement: 'x', api: {} } }),
    (e) => e.code === 'result_channel_unsupported' && J(e.offending) === J(['api']));
  assert.throws(() => assertResultChannels({ handoff: { to: 'x', toolCalls: [] } }),
    (e) => e.code === 'result_channel_unsupported');
  // The whitelisted vocabulary passes.
  assertResultChannels({
    note: 'n', questions: [], decisions: [], assumptions: [],
    document: { kind: 'plan', text: 'x' }, proposal: { intentRestatement: 'r' },
    handoff: { to: 'b', detail: 'd' },
  });
});

test('translateResult: contract enforcement + declared handoffs only', async () => {
  const { registryPath } = await mkRegistry(join(tmpdir(), `p2-tr-${randomUUID().slice(0, 8)}`));
  cleanupRoots.add(join(registryPath, '..'));
  const reg = await loadRegistry(registryPath);
  const grill = bindingById(reg, 'test-grill');
  const brainstorm = bindingById(reg, 'test-brainstorm');

  // conversation binding must not mint a document.
  assert.throws(() => translateResult(grill, { document: { kind: 'requirements', text: 'x' } }),
    (e) => e.code === 'result_off_contract');
  // doc-kind must match the binding's declared docKind.
  assert.throws(() => translateResult(brainstorm, { document: { kind: 'plan', text: 'x' } }),
    (e) => e.code === 'result_off_contract' && e.contractDocKind === 'requirements');
  // undeclared handoff refused; declared handoff records the declared mode.
  assert.throws(() => translateResult(grill, { handoff: { to: 'test-arch' } }),
    (e) => e.code === 'result_off_contract' && e.to === 'test-arch');
  const ok = translateResult(grill, { handoff: { to: 'test-brainstorm', detail: 'ready' }, note: 'done' });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.handoff.to, 'test-brainstorm');
  assert.equal(ok.result.handoff.mode, 'host_choice');
  // command-shaped channels refuse through translateResult too.
  assert.throws(() => translateResult(brainstorm, { note: 'x', api: { call: 'enable' } }),
    (e) => e.code === 'result_channel_unsupported');
});

// ============================================================================
// Session integration — assignment preflight through the real service
// ============================================================================

test('assignment: unsupported/capability/adapter/resource refusals are fail-closed', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);

  // Unsupported route: refused before anything is minted.
  let r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { plan: 'test-unsupported' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'route_unsupported');
  assert.equal(r.json.reason, 'implementation_authority_denied');
  assert.equal((await getCard(svc, 'card-a')).json.preparation, null, 'no session minted');

  // Missing native capability.
  r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { intent: 'test-native' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'capability_missing');
  assert.deepEqual(r.json.missing, ['native.mindmeld']);
  assert.ok(r.json.required.includes('runtime.pi'));

  // Unregistered adapter.
  r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { intent: 'test-ghost' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'adapter_unavailable');

  // Unsupported adapter contract version.
  r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { intent: 'test-oldver' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'adapter_version_unsupported');

  // Tool the adapter cannot serve.
  r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { intent: 'test-laser' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'adapter_unsafe');
  assert.deepEqual(r.json.unservable, ['laser']);

  // Unpinned resources.
  r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { intent: 'test-unpinned' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'resources_unpinned');

  // No session was created by any of the refusals.
  assert.equal((await getCard(svc, 'card-a')).json.preparation, null);
});

test('assignment: a missing on-disk resource refuses at binding time', async () => {
  const { svc, projectDir, registryPath } = await mkEnv();
  const reg = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
  const grill = reg.bindings.find((b) => b.bindingId === 'test-grill');
  // Remove a pinned file: the manifest stays recorded but the bytes are gone.
  await fs.rm(join(grill.skillDirs[0], 'helper.txt'));

  await seedBase(svc, projectDir);
  await enable(svc);
  const r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { intent: 'test-grill' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'resource_mismatch');
  assert.equal(r.json.missing.length, 1, J(r.json));
  assert.equal((await getCard(svc, 'card-a')).json.preparation, null);
});

test('assignment: reduced host capabilities refuse through the ctx seam', async () => {
  const { svc, projectDir } = await mkEnv({
    preparation: {
      capabilities: {
        question: ['chat'], tools: ['read'], workspace: ['git'],
        scratch: [], runtime: ['pi'], native: [],
      },
    },
  });
  await seedBase(svc, projectDir);
  await enable(svc);
  const r = await ucmd(svc, 'card-a', 'start_preparation', {
    intent: 'x', bindings: { intent: 'test-grill' },
  });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'capability_missing');
  assert.deepEqual(r.json.missing, ['tool.write']);
});

test('assignment: binding refs snapshot digest + configDigest + contracts', async () => {
  const { svc, projectDir, stateDir, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'snapshot me', bindings: { intent: 'test-grill', requirements: 'test-brainstorm' },
  });
  const agg = await loadAggregate(stateDir, 'card-a');
  const ref = agg.preparation.bindings.intent;
  const reg = await loadRegistry(registryPath);
  const b = bindingById(reg, 'test-grill');
  assert.equal(ref.digest, b.resourceManifest.digest);
  assert.equal(ref.configDigest, bindingConfigDigest(b));
  assert.equal(ref.adapterId, 'pi-skill');
  assert.equal(ref.adapterVersion, 'pi-skill-1');
  assert.deepEqual(ref.gateContract, b.gateContract);
  assert.deepEqual(ref.result, b.result);
  // Gates minted carry the same version snapshot.
  const gate = agg.preparation.gates.find((g) => g.bindingId === 'test-grill');
  assert.ok(gate, 'the declared intent_confirm gate must be minted');
  assert.equal(gate.digest, ref.digest);
  assert.equal(gate.configDigest, ref.configDigest);
});

test('substitution: swap to another registered binding; phase machine unchanged', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'swap me', bindings: { intent: 'test-grill', requirements: 'test-brainstorm' },
  });
  const view0 = await prepView(svc, 'card-a');
  const grillGate = view0.gates.find((g) => g.bindingId === 'test-grill');
  await ucmd(svc, 'card-a', 'confirm_gate', { gateId: grillGate.gateId });

  // Substitution only through registered routes.
  let r = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'intent', bindingId: 'no-such' });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'unknown_binding');
  r = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'intent', bindingId: 'test-candidate' });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'route_unproven');
  // test-unsupported serves stage plan — assign it there to reach the route
  // guard (an intent assignment correctly fails earlier as a stage mismatch).
  r = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'plan', bindingId: 'test-unsupported' });
  assert.equal(r.status, 422, J(r.json));
  assert.equal(r.json.code, 'route_unsupported');

  // The real substitution.
  r = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'intent', bindingId: 'test-grill-alt' });
  assert.equal(r.status, 200, J(r.json));
  assert.equal(r.json.result.changed, true);
  assert.equal(r.json.result.bindingId, 'test-grill-alt');

  const view = await prepView(svc, 'card-a');
  // Old binding's gate invalidated; a fresh gate minted under the new ref.
  const stale = view.gates.find((g) => g.gateId === grillGate.gateId);
  assert.equal(stale.status, 'invalidated');
  assert.equal(stale.invalidationReason, 'binding_changed');
  const fresh = view.gates.find((g) => g.bindingId === 'test-grill-alt' && g.status === 'pending');
  assert.ok(fresh, 'a fresh gate mints for the new binding');
  // The phase machine is untouched: requirements stage still gated,
  // approvals still required — the session's other obligations stand.
  assert.equal(view.ready, false);
  assert.ok(blockerCodes(view).has('gate_pending'));
  const agg = await loadAggregate(stateDir, 'card-a');
  assert.equal(agg.preparation.bindings.intent.bindingId, 'test-grill-alt');
  assert.equal(agg.preparation.status, 'active');

  // No-op rebind: same id + unchanged digests → not a migration.
  r = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'intent', bindingId: 'test-grill-alt' });
  assert.equal(r.status, 200, J(r.json));
  assert.equal(r.json.result.changed, false);

  // The declared-empty contract mints NO gate (distinct from "missing").
  r = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'requirements', bindingId: 'test-silent' });
  assert.equal(r.status, 200, J(r.json));
  const view2 = await prepView(svc, 'card-a');
  assert.equal(view2.gates.filter((g) => g.bindingId === 'test-silent').length, 0,
    'a declared [] gate contract mints no gates');
  const reqBlockers = view2.blockers.filter(
    (b) => (b.stage === 'requirements' || b.bindingId === 'test-silent') && /gate/.test(b.code));
  assert.equal(reqBlockers.length, 0, J(view2.blockers));
});

test('config drift: contract edit → binding_config_changed; explicit migration restores', async () => {
  const { svc, projectDir, registryPath, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'config drift', bindings: { intent: 'test-grill', requirements: 'test-brainstorm' },
  });
  // Establish checkpoint state that must survive migration: a blocking
  // question + a decision recorded via the kickoff result.
  const kid = await kickoffId(svc, 'card-a');
  const pr = await prepResult(svc, 'card-a', kid, {
    questions: [{ text: 'which scope?', blocking: true }],
    decisions: [{ text: 'keep it simple' }],
  });
  assert.equal(pr.status ?? 200, 200, J(pr.body ?? pr));
  assert.equal(pr.body.result.applied, true, J(pr.body));
  const before = await loadAggregate(stateDir, 'card-a');
  const questionsBefore = before.preparation.checkpoint.openQuestions.length;
  const decisionsBefore = before.preparation.checkpoint.decisions.length;
  assert.ok(questionsBefore >= 1);

  // Contract edit WITHOUT a resource change: the resource digest stays, the
  // config digest moves → a distinct staleness surface.
  const reg = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
  const grill = reg.bindings.find((b) => b.bindingId === 'test-grill');
  grill.requires = ['scratch.ce'];
  grill.result.handoffs = [
    ...grill.result.handoffs,
    { to: 'test-arch', mode: 'recorded', reason: 'offer a design pass' },
  ];
  await fs.writeFile(registryPath, J(reg), 'utf-8');

  let view = await prepView(svc, 'card-a');
  assert.equal(view.ready, false);
  assert.ok(blockerCodes(view).has('binding_config_changed'),
    `expected binding_config_changed, got ${J(view.blockers)}`);
  assert.ok(!blockerCodes(view).has('binding_digest_changed'),
    'resource digest did not move — the blocker is the CONFIG change');

  // The unchanged requirements binding stays clean.
  const reqRef = (await loadAggregate(stateDir, 'card-a')).preparation.bindings.requirements;
  assert.equal(reqRef.bindingId, 'test-brainstorm');
  assert.ok(!view.blockers.some((b) => b.bindingId === 'test-brainstorm' && b.code === 'binding_config_changed'));

  // Explicit migration: same-id change_skill_binding re-pins the contract.
  const mig = await ucmd(svc, 'card-a', 'change_skill_binding', { stage: 'intent', bindingId: 'test-grill' });
  assert.equal(mig.status, 200, J(mig.json));
  assert.equal(mig.json.result.changed, true);
  assert.ok(mig.json.result.invalidatedGates.length >= 1, 'old-contract gates invalidate');

  const agg = await loadAggregate(stateDir, 'card-a');
  const ref = agg.preparation.bindings.intent;
  const newReg = await loadRegistry(registryPath);
  assert.equal(ref.configDigest, bindingConfigDigest(bindingById(newReg, 'test-grill')));
  // Checkpoint retained across migration.
  assert.equal(agg.preparation.checkpoint.openQuestions.length, questionsBefore,
    'open questions survive the migration');
  assert.equal(agg.preparation.checkpoint.decisions.length, decisionsBefore,
    'decisions survive the migration');
  // The migration is logged as a distinct event.
  assert.ok(agg.preparation.checkpoint.log.some((e) => e.type === 'binding_migrated'));

  // The fresh gate carries the NEW config digest; confirming it works.
  view = await prepView(svc, 'card-a');
  const fresh = view.gates.find((g) => g.bindingId === 'test-grill' && g.status === 'pending');
  assert.ok(fresh, 'a fresh gate mints under the new contract');
  const conf = await ucmd(svc, 'card-a', 'confirm_gate', { gateId: fresh.gateId });
  assert.equal(conf.status, 200, J(conf.json));
  assert.ok(!blockerCodes(await prepView(svc, 'card-a')).has('binding_config_changed'));
});

test('config drift: stale gates cannot confirm under the moved contract', async () => {
  const { svc, projectDir, registryPath } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'x', bindings: { intent: 'test-grill' },
  });
  const gateId = (await prepView(svc, 'card-a')).gates.find((g) => g.bindingId === 'test-grill').gateId;
  // Move ONLY the contract.
  const reg = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
  reg.bindings.find((b) => b.bindingId === 'test-grill').requires = ['scratch.ce'];
  await fs.writeFile(registryPath, J(reg), 'utf-8');
  const gc = await ucmd(svc, 'card-a', 'confirm_gate', { gateId });
  assert.equal(gc.status, 409, J(gc.json));
  assert.equal(gc.json.code, 'gate_digest_stale');
});

// ============================================================================
// Session result containment — through the real prep_result seam
// ============================================================================

test('prep_result: injection channels refuse; the session state is untouched', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'injection', bindings: { requirements: 'test-brainstorm' },
  });
  const kid = await kickoffId(svc, 'card-a');
  const agg0 = await loadAggregate(stateDir, 'card-a');

  for (const [tag, body] of [
    ['commands', { commands: [{ type: 'start' }] }],
    ['api', { api: { route: '/admin' } }],
    ['toolCalls', { toolCalls: [{ tool: 'bash' }] }],
    ['exec', { exec: 'rm -rf /' }],
    ['arbitrary', { takeover: { escalate: true } }],
    ['nested-document', { document: { kind: 'requirements', text: 'x', exec: 'rm' } }],
    ['nested-handoff', { handoff: { to: 'test-arch', api: {} } }],
    ['mixed', { note: 'fine', commands: [] }],
  ]) {
    const r = await prepResult(svc, 'card-a', kid, body);
    assert.equal(r.status, 422, `${tag}: ${J(r.body ?? r)}`);
    const err = r.body ?? r;
    assert.equal(err.code, 'result_channel_unsupported', `${tag}: ${J(err)}`);
    assert.ok(err.offending?.length >= 1, `${tag}: offending must name the channel`);
  }
  const agg1 = await loadAggregate(stateDir, 'card-a');
  assert.equal(agg1.preparation.checkpoint.openQuestions.length,
    agg0.preparation.checkpoint.openQuestions.length, 'no questions minted');
  assert.equal(agg1.preparation.checkpoint.decisions.length,
    agg0.preparation.checkpoint.decisions.length, 'no decisions minted');
  const docCount = (agg) => ['requirements', 'design', 'plan']
    .reduce((n, k) => n + (agg.documents?.[k]?.versions?.length ?? 0), 0);
  assert.equal(docCount(agg1), docCount(agg0), 'no documents minted');

  // A whitelisted result still applies — the refusal was surgical.
  const ok = await prepResult(svc, 'card-a', kid, {
    note: 'kickoff done', decisions: [{ text: 'use the contract' }],
  });
  assert.equal(ok.body.result.applied, true, J(ok.body));
});

test('prep_result: document/handoff enforce the binding result contract', async () => {
  const { svc, projectDir, stateDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'contracts', bindings: { intent: 'test-grill', requirements: 'test-brainstorm' },
  });
  const kid = await kickoffId(svc, 'card-a');

  // The undeclared handoff is refused — never dispatched.
  let r = await prepResult(svc, 'card-a', kid, { handoff: { to: 'test-arch', detail: 'go' } });
  assert.equal(r.status, 422, J(r.body ?? r));
  assert.equal((r.body ?? r).code, 'result_off_contract');
  const aggMid = await loadAggregate(stateDir, 'card-a');
  assert.equal(aggMid.preparation.bindings.design ?? null, null,
    'an undeclared handoff cannot assign a binding');

  // The DECLARED handoff (test-grill → test-brainstorm) is recorded as
  // evidence — and changes nothing else. This result has no questions, so
  // the kickoff attempt completes with it — anything further needs a new
  // turn.
  r = await prepResult(svc, 'card-a', kid, { handoff: { to: 'test-brainstorm', detail: 'draft reqs' } });
  assert.equal(r.status, 200, J(r.body ?? r));
  assert.equal(r.body.result.applied, true, J(r.body));
  assert.deepEqual(r.body.result.handoff, {
    to: 'test-brainstorm', mode: 'host_choice',
    reason: 'scope frozen → draft requirements', offeredBy: 'test-grill',
  });
  const aggAfter = await loadAggregate(stateDir, 'card-a');
  assert.ok(aggAfter.preparation.checkpoint.log.some((e) => e.type === 'handoff_recorded'));
  assert.equal(aggAfter.preparation.bindings.requirements.bindingId, 'test-brainstorm',
    'a recorded handoff never mutates the assignment');

  // A draft attempt is contract-bound to the kind it was minted for:
  // request_draft('requirements') returning a plan document is off-contract.
  const draft = await ucmd(svc, 'card-a', 'request_draft', { kind: 'requirements' });
  assert.equal(draft.status, 200, J(draft.json));
  const draftId = draft.json.result.attemptId;
  r = await prepResult(svc, 'card-a', draftId, {
    document: { kind: 'plan', text: '# sneaky plan\n' },
  });
  assert.equal(r.status, 422, J(r.body ?? r));
  const derr = r.body ?? r;
  assert.equal(derr.code, 'result_off_contract');
  assert.equal(derr.expected, 'requirements');
  assert.equal(derr.kind, 'plan');

  // The requirements import works and carries binding provenance.
  const doc = await prepResult(svc, 'card-a', draftId, {
    document: { kind: 'requirements', text: '# Requirements v1\n' },
  });
  assert.equal(doc.status, 200, J(doc.body ?? doc));
  const dres = doc.body.result;
  assert.equal(dres.applied, true, J(dres));
  assert.equal(dres.document.kind, 'requirements');
  const aggDoc = await loadAggregate(stateDir, 'card-a');
  const ver = (aggDoc.documents?.requirements?.versions ?? []).find(
    (v) => v.versionId === dres.document.versionId);
  assert.ok(ver, 'the imported document is durable');
  assert.equal(ver.meta?.bindingId, 'test-brainstorm', J(ver.meta));
  assert.equal(ver.meta?.bindingDigest, aggDoc.preparation.bindings.requirements.digest);
  assert.equal(ver.meta?.bindingConfigDigest, aggDoc.preparation.bindings.requirements.configDigest);
});

test('prep_result: importAs=none contract refuses a document outright', async () => {
  const { svc, projectDir } = await mkEnv();
  await seedBase(svc, projectDir);
  await enable(svc);
  await mustStartPrep(svc, 'card-a', {
    intent: 'no imports', bindings: { requirements: 'test-recorder' },
  });
  const kid = await kickoffId(svc, 'card-a');
  const r = await prepResult(svc, 'card-a', kid, {
    document: { kind: 'requirements', text: '# not declared\n' },
  });
  assert.equal(r.status, 422, J(r.body ?? r));
  const err = r.body ?? r;
  assert.equal(err.code, 'result_off_contract');
  assert.equal(err.bindingId, 'test-recorder');
});

// ============================================================================
// Provider source integrity — digests identical before and after the suite
// ============================================================================

const providerSnapshot = { at: null, digests: null };

before(async () => {
  const reg = await loadRegistry(PROD_REGISTRY);
  providerSnapshot.at = new Date().toISOString();
  providerSnapshot.digests = Object.fromEntries(reg.bindings.map((b) => [
    b.bindingId, {
      resource: b.resourceManifest?.digest ?? null,
      config: bindingConfigDigest(b),
    },
  ]));
});

test('provider digests: registry pins and on-disk bytes unchanged by the suite', async () => {
  assert.ok(providerSnapshot.digests, 'before() must have run');
  const reg = await loadRegistry(PROD_REGISTRY);
  for (const b of reg.bindings) {
    const snap = providerSnapshot.digests[b.bindingId];
    assert.ok(snap, `${b.bindingId} missing from the before-snapshot`);
    assert.equal(b.resourceManifest?.digest ?? null, snap.resource,
      `${b.bindingId} resource pin moved`);
    assert.equal(bindingConfigDigest(b), snap.config, `${b.bindingId} config digest moved`);
  }
  // The on-disk truth behind every available pin still verifies — the suite
  // (and the implementation) did not touch provider resources.
  for (const b of reg.bindings.filter((x) => x.status === 'available')) {
    const v = await verifyManifest(b);
    assert.equal(v.ok, true, `${b.bindingId} manifest drifted: ${J(v)}`);
  }
});

test('bounded real-registry preflight: available bindings pass; unsupported refuse', async () => {
  const reg = await loadRegistry(PROD_REGISTRY);
  const host = defaultHostCapabilities();
  const refused = [];
  for (const b of reg.bindings) {
    try {
      const pf = await preflightBinding(b, { hostCapabilities: host, fsCheck: true, workspace: '/tmp' });
      assert.equal(b.status, 'available', `${b.bindingId} passed preflight but is not available`);
      assert.equal(pf.digest, b.resourceManifest.digest);
      assert.equal(pf.configDigest, bindingConfigDigest(b));
    } catch (e) {
      refused.push({ bindingId: b.bindingId, code: e.code });
      assert.equal(b.status, 'unsupported', `${b.bindingId} refused unexpectedly: ${e.code} ${e.message}`);
      assert.equal(e.code, 'route_unsupported', `${b.bindingId} must refuse as route_unsupported, got ${e.code}`);
    }
  }
  assert.equal(refused.length, 6, J(refused));
});
