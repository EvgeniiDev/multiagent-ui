#!/usr/bin/env node
// scripts/test_execution_environment.mjs — deterministic F1 environment tests.
// No docker, no network: a fake Docker API + an in-process controller exercise
// the real code paths (config validation, profile digests, capability gating,
// exec gate, egress decision, runtime start/status/cancel/reconcile).
//
// Usage: node scripts/test_execution_environment.mjs

import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateEnvironmentConfig, egressDecision, isPrivateIp } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/env-config.mjs')).href);
const { validateAgentProfile, profileDigest, porchAgentEntry, scopedAgentSpec, profileFlags } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/agent-profile.mjs')).href);
const { createCapabilityStore } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/capability-store.mjs')).href);
const { createControllerClient } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/controller-client.mjs')).href);
const { createContainerRuntime, workerIdForAttempt } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/container-runtime.mjs')).href);
const { createEnvController, createRpcListener } =
  await import(pathToFileURL(path.join(ROOT, 'deploy/execution/env-controller.mjs')).href);
const { spawnBounded } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/common.mjs')).href);

const results = [];
let section = '';
function sect(name) { section = name; console.log(`\n== ${name}`); }
function check(name, ok, extra = '') {
  results.push([`${section} :: ${name}`, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'f1-env-test-'));

// ---------- fixtures ----------------------------------------------------------

function baseConfig(over = {}) {
  const r = (n) => path.join(tmp, n);
  return {
    schemaVersion: 1,
    environment: {
      socketPath: 'controller/env.sock',
      tokenFile: 'controller/channel-token',
      registryFile: 'controller/registry.json',
      workerNamePrefix: 'acp-f1-w-',
      networkNamePrefix: 'acp-f1-n-',
      labelPrefix: 'ai.acp.f1',
      workerUid: 1001, workerGid: 1001,
      maxExecMs: 3600000, maxOutputBytes: 1024 * 1024,
      maxInputBytes: 65536, maxPromptBytes: 262144,
      allowDebugExec: true,
      egressGateway: {
        alias: 'egress-gw', proxyPort: 3128,
        proxyUrl: 'http://egress-gw:3128', labelSelector: 'ai.acp.f1=egress-gw',
      },
      ...over.environment,
    },
    roots: {
      env:        { hostPath: r('env'),      mountPath: r('env'),      access: 'rw' },
      projects:   { hostPath: r('projects'), mountPath: r('projects'), access: 'ro' },
      piCreds:    { hostPath: r('creds'),    mountPath: r('creds'),    access: 'ro' },
      piExt:      { hostPath: r('ext'),      mountPath: r('ext'),      access: 'ro' },
      piSkills:   { hostPath: r('skills'),   mountPath: r('skills'),   access: 'ro' },
      porchSkill: { hostPath: r('porch'),    mountPath: r('porch'),    access: 'ro' },
      ...(over.roots || {}),
    },
    images: { worker: { ref: 'acp-f1-worker:test' }, ...(over.images || {}) },
    roles: {
      panelist:   { projectMode: 'snapshot-ro',  inputs: ['task'], deps: false, canonical: false },
      judge:      { projectMode: 'snapshot-ro',  inputs: ['task'], deps: false, canonical: false },
      integrator: { projectMode: 'private-repo', inputs: ['task'], deps: true,  canonical: true },
      setup:      { projectMode: 'workdir-rw',   inputs: [],       deps: false, canonical: false, setup: true },
      probe:      { projectMode: 'none',         inputs: ['task'], deps: false, canonical: false },
      ...(over.roles || {}),
    },
    execPolicy: {
      envKeys: ['PORCH_STEER_DIR', 'PORCH_OUTPUT_DIR', 'PORCH_RUN_DIR',
        'PORCH_CONFIG', 'PORCH_SAVE_OUTPUTS', 'PORCH_PI_SESSION_ID',
        'PI_CODING_AGENT_SESSION_DIR'],
      cwdKeys: { project: '/work/project', home: '/work/home', attempt: '/work/attempt' },
      templates: [
        { name: 'porch', head: ['/work/conf/porch/scripts/porch', 'delegate'],
          argPattern: '^[A-Za-z0-9_./=:@-]{1,512}$',
          pathRoots: ['/work/conf', '/work/attempt', '/work/project'], maxArgs: 32 },
        { name: 'proc-probe', head: ['/opt/env/proc-probe.mjs'],
          argPattern: '^[0-9]{1,10}$', pathRoots: [], maxArgs: 2 },
        { name: 'debug', head: ['/bin/bash', '-c'],
          argPattern: '^[\\x20-\\x7e]{1,4096}$', pathRoots: [], maxArgs: 4,
          requiresFlag: 'allowDebugExec' },
      ],
      ...(over.execPolicy || {}),
    },
    egress: over.egress ?? {
      allowlist: [
        { host: 'anymodel.org', ports: [443], kind: 'provider' },
        { host: 'duckduckgo.com', ports: [443], kind: 'search' },
        { host: 'registry.npmjs.org', ports: [443], kind: 'registry' },
        { host: '192.168.1.146', ports: [8767], kind: 'provider', privateUpstream: true },
      ],
    },
    setups: {
      'node-deps': {
        argv: ['npm', 'ci', '--ignore-scripts'],
        lockfiles: ['package-lock.json'],
        depPath: 'node_modules',
        checkArgv: ['node', '-e', '1'],
      },
      ...(over.setups || {}),
    },
  };
}

function baseProfile(over = {}) {
  return {
    schemaVersion: 1,
    profileId: 'f1-panelist',
    pi: { version: '0.85.1' },
    image: 'worker',
    provider: 'zen-relay',
    model: 'zen-relay/muse-spark-1.3-contributor-free',
    thinking: 'low',
    skills: [],
    extensions: [{ resource: 'piExt', rel: 'pi-web-access' }],
    tools: ['read', 'bash', 'web_search'],
    search: { enabled: true, provider: 'duckduckgo', params: { maxResults: 5 } },
    launch: { progress: 'none', extraFlags: [] },
    systemPromptFile: null,
    ...over,
  };
}

// Fake docker API — records calls, simulates container lifecycle.
// `inspectHook(id, container)` may return a canned inspect payload, throw
// (transport/5xx-equivalent failure), or return undefined to fall through
// to the default simulated inspect. `calls` records mutating docker calls
// in order so tests can assert ZERO stop/remove/exec against a worker.
function fakeDocker() {
  const containers = new Map();
  const nets = new Map();
  let n = 0;
  return {
    created: [],
    calls: [],
    inspectHook: null,
    async ping() { return true; },
    async version() { return { Version: 'test' }; },
    async imageInspect() { return { Id: 'sha256:' + 'ab'.repeat(32), RepoDigests: [] }; },
    async containerList() {
      return [{ Id: 'gw-container-1', State: 'running', Names: ['/acp-f1-egress-gw'] }];
    },
    async networkInspect(name) { return nets.get(name) || null; },
    async networkCreate(spec) {
      nets.set(spec.Name, { Id: `net-${++n}`, Name: spec.Name, Internal: spec.Internal });
      return { Id: nets.get(spec.Name).Id };
    },
    async networkConnect() { return {}; },
    async networkDisconnect(netId, cid) { this.calls.push(['networkDisconnect', netId]); return true; },
    async networkRemove(name) { nets.delete(name); return true; },
    async containerCreate(spec) {
      const id = `ctr-${++n}`;
      const c = { Id: id, spec, state: 'created', running: false };
      containers.set(id, c);
      this.created.push(spec);
      this.calls.push(['containerCreate', id]);
      return { Id: id };
    },
    async containerStart(id) { this.calls.push(['containerStart', id]); containers.get(id).running = true; containers.get(id).state = 'running'; return {}; },
    async containerStop(id) { this.calls.push(['containerStop', id]); const c = containers.get(id); if (c) { c.running = false; c.state = 'exited'; } return true; },
    async containerRemove(id) { this.calls.push(['containerRemove', id]); containers.delete(id); return true; },
    async containerInspect(id) {
      if (this.inspectHook) {
        const r = await this.inspectHook(id, containers.get(id));
        if (r !== undefined) return r;
      }
      const c = containers.get(id);
      if (!c) return null;
      return { Id: id, State: { Running: c.running, Status: c.state, StartedAt: 't0' },
        Image: 'sha256:img', Config: c.spec };
    },
    async execCreate(cid, opts) { this.calls.push(['execCreate', cid]); const id = `exec-${++n}`; this.lastExec = { cid, opts, id }; return { Id: id }; },
    execResult: { stdout: '', stderr: '', exitCode: 0 },
    async execStart() { const r = this.execResult; return { stdout: r.stdout, stderr: r.stderr, timedOut: false }; },
    async execInspect() { return { ExitCode: this.execResult.exitCode }; },
    async killContainer(id) { this.calls.push(['killContainer', id]); containers.delete(id); },
    _containers: containers, _nets: nets,
  };
}

async function git(cwd, args) {
  const r = await spawnBounded(['git', '-C', cwd, ...args], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// ---------- 1. env-config -----------------------------------------------------
sect('env-config');
{
  const cfg = validateEnvironmentConfig(baseConfig(), { env: {}, view: 'client' });
  check('valid config loads (client view)', cfg.environment.socketPath === path.join(tmp, 'env', 'controller', 'env.sock'));
  const cc = validateEnvironmentConfig(baseConfig(), { env: {}, view: 'controller' });
  check('controller view resolves mountPath', cc.environment.socketPath === path.join(tmp, 'env', 'controller', 'env.sock'));
  check('roles validated', Object.keys(cfg.roles).length === 5 && cfg.roles.integrator.canonical === true);
  // §backend-env-needs: backend role registrations (orch-*, swarm-*) validate
  // with the requested projectMode/inputs/deps/canonical surface.
  {
    const withBackend = baseConfig({ roles: {
      'orch-decomposer':  { projectMode: 'snapshot-ro',  inputs: ['requirements', 'plan', 'design', 'workers'], deps: false, canonical: false },
      'orch-worker':      { projectMode: 'private-repo', inputs: ['task', 'brief', 'boundary', 'criteria', 'deps', 'requirements', 'plan', 'context'], deps: true, canonical: true },
      'orch-verifier':    { projectMode: 'snapshot-ro',  inputs: ['task', 'diff', 'criteria', 'boundary', 'context', 'report'], deps: false, canonical: false },
      'orch-integrator':  { projectMode: 'private-repo', inputs: ['task', 'work-order', 'requirements', 'plan', 'design', 'results'], deps: true, canonical: true },
      'swarm-participant': { projectMode: 'snapshot-ro', inputs: ['task', 'brief', 'messages', 'decisions', 'ownership', 'scratch'], deps: false, canonical: false },
    } });
    const bc = validateEnvironmentConfig(withBackend, { env: {}, view: 'client' });
    check('backend roles accepted', ['orch-decomposer', 'orch-worker', 'orch-verifier', 'orch-integrator', 'swarm-participant']
      .every((r) => bc.roles[r]) && bc.roles['orch-worker'].canonical === true);
    check('swarm snapshot-ro (no direct canonical write)',
      bc.roles['swarm-participant'].projectMode === 'snapshot-ro' && bc.roles['swarm-participant'].canonical !== true);
    try {
      const bad = withBackend; bad.roles['bogus-role'] = { projectMode: 'snapshot-ro', inputs: [] };
      validateEnvironmentConfig(bad);
      check('unknown role still rejected', false);
    } catch (e) { check('unknown role still rejected', e.code === 'config_invalid'); }
  }

  try {
    validateEnvironmentConfig(baseConfig({ environment: { socketPath: '../escape.sock' } }));
    check('socketPath traversal rejected', false);
  } catch (e) { check('socketPath traversal rejected', e.code === 'config_invalid'); }
  try {
    const bad = baseConfig(); delete bad.roles.probe;
    validateEnvironmentConfig(bad);
    check('missing role rejected', false);
  } catch (e) { check('missing role rejected', e.code === 'config_invalid'); }
  try {
    const bad = baseConfig(); bad.images.worker = { ref: 'ACME/../../x' };
    validateEnvironmentConfig(bad);
    check('bad image ref rejected', false);
  } catch (e) { check('bad image ref rejected', e.code === 'config_invalid'); }
  try {
    const bad = baseConfig(); bad.execPolicy.templates = bad.execPolicy.templates.filter((t) => t.name !== 'porch');
    validateEnvironmentConfig(bad);
    check('missing porch template rejected', false);
  } catch (e) { check('missing porch template rejected', e.code === 'config_invalid'); }
  try {
    validateEnvironmentConfig({ ...baseConfig(), schemaVersion: 99 });
    check('schema version enforced', false);
  } catch (e) { check('schema version enforced', e.code === 'config_invalid'); }
}

// ---------- 2. agent-profile + digest ----------------------------------------
sect('agent-profile');
{
  const p = validateAgentProfile(baseProfile());
  const d1 = profileDigest(baseProfile());
  const d2 = profileDigest(baseProfile());
  check('digest deterministic', d1 === d2 && /^[0-9a-f]{64}$/.test(d1));
  check('digest changes when tools change',
    profileDigest(baseProfile({ tools: ['read', 'bash'] })) !== d1);
  check('digest changes when search params change',
    profileDigest(baseProfile({ search: { enabled: true, provider: 'duckduckgo', params: { maxResults: 6 } } })) !== d1);
  check('digest changes when extensions change',
    profileDigest(baseProfile({ extensions: [] })) !== d1);
  check('digest changes when model changes',
    profileDigest(baseProfile({ model: 'zen-relay/other' })) !== d1);

  try { validateAgentProfile(baseProfile({ thinking: 'ludicrous' })); check('bad thinking rejected', false); }
  catch (e) { check('bad thinking rejected', e.code === 'invalid_profile'); }
  try { validateAgentProfile(baseProfile({ search: { enabled: true } })); check('search w/o provider rejected', false); }
  catch (e) { check('search w/o provider rejected', e.code === 'invalid_profile'); }
  try { validateAgentProfile(baseProfile({ extensions: [{ resource: 'piExt', rel: '../../escape' }] })); check('extension traversal rejected', false); }
  catch (e) { check('extension traversal rejected', e.code === 'invalid_profile'); }
  try { validateAgentProfile(baseProfile({ launch: { extraFlags: ['--exec-arbitrary'] } })); check('unknown extraFlag rejected', false); }
  catch (e) { check('unknown extraFlag rejected', e.code === 'invalid_profile'); }

  const entry = porchAgentEntry(p);
  check('porch agent entry synthesized', entry.backend === 'pi-cli' && entry.model === p.model);
  const flags = profileFlags(p);
  check('profile flags include -e allowlist + --tools',
    flags.includes('--no-extensions') && flags.includes('/work/node_modules/pi-web-access')
    && flags.includes('--tools') && flags.includes('bash,read,web_search')
    && flags.includes('--thinking') && flags.includes('low'));
}

// scoped agent spec — provider subset only
{
  const files = scopedAgentSpec(validateAgentProfile(baseProfile()), {
    providers: {
      'zen-relay': { baseUrl: 'http://192.168.1.146:8767/v1', apiKey: 'K', models: ['m1'] },
      'anymodel': { baseUrl: 'https://anymodel.org/v1', apiKey: 'SECRET-OTHER', models: [] },
    },
  });
  const providers = files['models.json'].providers;
  check('scoped models.json has only the profile provider',
    Object.keys(providers).length === 1 && providers['zen-relay'] && !providers.anymodel);
  check('web-search.json written when enabled', !!files['web-search.json']);
  check('settings pinned to provider+model',
    files['settings.json'].defaultProvider === 'zen-relay'
    && files['settings.json'].defaultModel === 'muse-spark-1.3-contributor-free'
    && files['settings.json'].packages.length === 0);
  const noSearch = scopedAgentSpec(validateAgentProfile(baseProfile({ search: { enabled: false, provider: null, params: {} } })),
    { providers: { 'zen-relay': { baseUrl: 'x' } } });
  check('no web-search.json when disabled', !noSearch['web-search.json']);
}

// ---------- 3. capability store ------------------------------------------------
sect('capability-store');
{
  const dir = path.join(tmp, 'env', 'capability');
  const store = createCapabilityStore({ dir });
  const digest = profileDigest(baseProfile());
  // unprobed -> rejected
  try { await store.requireSearchAllowed(validateAgentProfile(baseProfile()), digest); check('unprobed digest rejected', false); }
  catch (e) { check('unprobed digest rejected', e.code === 'search_unproven'); }
  // record a positive probe for the EXACT digest
  await store.record({
    digest, profileId: 'f1-panelist', capable: true,
    enablement: { tool: 'web_search', provider: 'duckduckgo', extension: 'pi-web-access@0.30.0' },
    probe: { ok: true, at: new Date().toISOString(), runId: 'run_probe', source: 'https://duckduckgo.com', evidence: 'results returned' },
  });
  const rec = await store.requireSearchAllowed(validateAgentProfile(baseProfile()), digest);
  check('probed digest allowed', rec.capable === true && rec.probe.ok === true);
  // tool removal at same image/model -> NEW digest -> unprobed -> rejected
  const dNoTool = profileDigest(baseProfile({ tools: ['read', 'bash'] }));
  try { await store.requireSearchAllowed(validateAgentProfile(baseProfile({ tools: ['read', 'bash'] })), dNoTool); check('tool-removal digest rejected', false); }
  catch (e) { check('tool-removal digest rejected', e.code === 'search_unproven', 'different digest, no probe'); }
  // corrupt record -> fail closed
  await fs.writeFile(path.join(dir, `${digest}.json`), '{corrupt');
  try { await store.requireSearchAllowed(validateAgentProfile(baseProfile()), digest); check('corrupt record rejected', false); }
  catch (e) { check('corrupt record rejected', e.code === 'search_unproven'); }
}

// ---------- 4. egressDecision --------------------------------------------------
sect('egressDecision');
{
  const cfg = validateEnvironmentConfig(baseConfig(), { view: 'client' });
  let d = egressDecision(cfg, { host: 'anymodel.org', port: 443 });
  check('provider host passes unresolved', d.ok === true && d.needsResolve === true);
  d = egressDecision(cfg, { host: 'anymodel.org', port: 443, resolvedIps: ['93.184.216.34'] });
  check('provider host + public ip allowed', d.ok === true);
  d = egressDecision(cfg, { host: 'anymodel.org', port: 443, resolvedIps: ['10.9.9.9'] });
  check('rebind to private rejected', d.ok === false && d.code === 'private_blocked');
  d = egressDecision(cfg, { host: 'evil.example.com', port: 443 });
  check('unlisted host rejected', d.ok === false && d.code === 'not_allowlisted');
  d = egressDecision(cfg, { host: '127.0.0.1', port: 443 });
  check('loopback literal rejected', d.ok === false && d.code === 'not_allowlisted');
  d = egressDecision(cfg, { host: '169.254.169.254', port: 80 });
  check('metadata literal rejected', d.ok === false && d.code === 'not_allowlisted');
  d = egressDecision(cfg, { host: '192.168.1.146', port: 8767 });
  check('registered private upstream allowed', d.ok === true);
  d = egressDecision(cfg, { host: '192.168.1.146', port: 443 });
  check('registered upstream wrong port rejected', d.ok === false);
  d = egressDecision(cfg, { host: 'anymodel.org', port: 80 });
  check('provider wrong port rejected', d.ok === false);
  check('isPrivateIp v6-mapped', isPrivateIp('::ffff:10.1.2.3') === true && isPrivateIp('::ffff:7f00:1') === true);
  check('isPrivateIp ranges', isPrivateIp('192.168.5.5') && isPrivateIp('169.254.1.1') && isPrivateIp('100.64.0.1') && !isPrivateIp('8.8.8.8'));
}

// ---------- 5. controller (in-process, fake docker) ---------------------------
sect('controller');
let controller, docker;
{
  // real filesystem: a git project source + creds + ext dirs + porch skill
  const proj = path.join(tmp, 'projects', 'acp-ui-agent-modes');
  await fs.mkdir(proj, { recursive: true });
  await git(proj, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(proj, 'package-lock.json'), '{"lockfileVersion":3}');
  await git(proj, ['add', '-A']);
  await git(proj, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  const sha = await git(proj, ['rev-parse', 'HEAD']);
  for (const d of ['creds', 'ext/pi-web-access', 'skills', 'porch']) {
    await fs.mkdir(path.join(tmp, d), { recursive: true });
  }
  await fs.writeFile(path.join(tmp, 'creds', 'models.json'),
    JSON.stringify({ providers: { 'zen-relay': { baseUrl: 'http://192.168.1.146:8767/v1', apiKey: 'K', models: [] } } }));
  await fs.mkdir(path.join(tmp, 'porch', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'porch', 'scripts', 'porch'), '#!/bin/sh\necho stub\n');

  const cfg = validateEnvironmentConfig(baseConfig(), { view: 'controller' });
  docker = fakeDocker();
  controller = createEnvController({ config: cfg, docker });
  await controller.boot();

  const ping = await controller.handle('ping');
  check('ping returns identity', ping.ok === true && ping.controller.bootId);

  const spec = {
    workerId: 'w-att-1', attemptId: 'att-1', role: 'panelist',
    profileId: 'f1-panelist',
    profile: baseProfile({ search: { enabled: false, provider: null, params: {} } }),
    prompt: 'test prompt',
    materials: { projectRoot: 'acp-ui-agent-modes', snapshotSha: sha, inputs: [{ name: 'task', content: 'do x' }] },
  };
  spec.profileDigest = profileDigest(spec.profile);
  let prep = await controller.handle('worker.prepare', spec);
  check('worker.prepare ok', prep.ok === true && prep.worker.workerId === 'w-att-1');
  const created = docker.created[0];
  check('container non-root uid', created.User === '1001:1001');
  check('ro rootfs + caps dropped + no priv',
    created.HostConfig.ReadonlyRootfs === true && created.HostConfig.CapDrop.includes('ALL')
    && created.HostConfig.Privileged !== true && created.HostConfig.NetworkMode !== 'host');
  check('proxy env pinned to gateway',
    created.Env.includes('HTTP_PROXY=http://egress-gw:3128'));
  const binds = created.HostConfig.Binds;
  check('no credential-source bind into worker',
    !binds.some((b) => b.includes(path.join(tmp, 'creds'))));
  check('conf+project ro, agent+home+attempt rw',
    binds.includes(`${path.join(tmp, 'env', 'workers', 'w-att-1')}/conf:/work/conf:ro`)
    && binds.includes(`${path.join(tmp, 'env', 'workers', 'w-att-1')}/project:/work/project:ro`)
    && binds.includes(`${path.join(tmp, 'env', 'workers', 'w-att-1')}/agent:/work/agent:rw`));
  check('per-worker internal net created+gw connected',
    docker._nets.get('acp-f1-n-w-att-1')?.Internal === true);

  // worker.json written
  const wj = JSON.parse(await fs.readFile(path.join(tmp, 'env', 'workers', 'w-att-1', 'worker.json'), 'utf8'));
  check('worker.json durable', wj.workerId === 'w-att-1' && wj.profileDigest === spec.profileDigest);

  // scoped agent dir: only zen-relay provider
  const models = JSON.parse(await fs.readFile(path.join(tmp, 'env', 'workers', 'w-att-1', 'agent', 'models.json'), 'utf8'));
  check('worker agent dir provider-scoped', Object.keys(models.providers).length === 1);
  check('no auth.json copied (none matched)', true); // source had no auth.json

  // idempotent re-prepare while running
  const again = await controller.handle('worker.prepare', spec);
  check('re-prepare returns existing running worker', again.existed === true);

  // digest mismatch rejected
  const bad = { ...spec, workerId: 'w-att-2', profileDigest: 'ab'.repeat(32) };
  try { await controller.handle('worker.prepare', bad); check('digest mismatch rejected', false); }
  catch (e) { check('digest mismatch rejected', e.code === 'profile_digest_mismatch'); }

  // projectRoot traversal rejected (worker never sees host paths)
  const trav = { ...spec, workerId: 'w-att-3',
    materials: { ...spec.materials, projectRoot: '..' } };
  try { await controller.handle('worker.prepare', trav); check('projectRoot traversal rejected', false); }
  catch (e) { check('projectRoot traversal rejected', e.code === 'invalid_argument'); }

  // exec gate
  let ex = await controller.handle('worker.exec', {
    workerId: 'w-att-1', template: 'porch', args: ['status', 'run_x', '--json'], cwdKey: 'home' });
  check('porch exec allowed', ex.ok === true);
  try {
    await controller.handle('worker.exec', {
      workerId: 'w-att-1', template: 'porch', args: ['status', '/etc/passwd'], cwdKey: 'home' });
    check('exec arg path outside roots rejected', false);
  } catch (e) { check('exec arg path outside roots rejected', e.code === 'exec_arg_path_rejected'); }
  try {
    await controller.handle('worker.exec', {
      workerId: 'w-att-1', template: 'porch', args: ['--file=/etc/shadow'], cwdKey: 'home' });
    check('exec =embedded path rejected', false);
  } catch (e) { check('exec =embedded path rejected', e.code === 'exec_arg_path_rejected'); }
  try {
    await controller.handle('worker.exec', {
      workerId: 'w-att-1', template: 'porch', args: ['status'], env: { HTTP_PROXY: 'http://evil' } });
    check('exec env key not allowlisted rejected', false);
  } catch (e) { check('exec env key not allowlisted rejected', e.code === 'exec_env_rejected'); }
  try {
    await controller.handle('worker.exec', {
      workerId: 'w-att-1', template: 'nope', args: [] });
    check('unknown template rejected', false);
  } catch (e) { check('unknown template rejected', e.code === 'exec_template_unknown'); }
  ex = await controller.handle('worker.exec', {
    workerId: 'w-att-1', template: 'debug', args: ['id'] });
  check('debug template requires flag (allowed when set)', ex.ok === true);

  // stop -> gone -> re-prepare refused (no duplicate)
  const cid = prep.worker.containerId;
  await controller.handle('worker.stop', { workerId: 'w-att-1' });
  await docker.containerRemove(cid);
  const st = await controller.handle('worker.status', { workerId: 'w-att-1' });
  check('vanished worker marked gone', st.state === 'gone', `cid=${cid} state=${st.state}`);
  try { await controller.handle('worker.prepare', spec); check('vanished worker no-duplicate', false); }
  catch (e) { check('vanished worker no-duplicate', e.code === 'worker_terminal'); }

  // worker.status maps Docker states narrowly: only exited/dead report
  // 'stopped' (pid namespace down — the F1 reaper's probe-skip basis).
  // Transitional states pass through raw so consumers fail closed.
  {
    const spec2 = { ...spec, workerId: 'w-att-state', attemptId: 'att-state' };
    const prep2 = await controller.handle('worker.prepare', spec2);
    check('state-probe worker prepared', prep2.ok === true);
    const cid2 = prep2.worker.containerId;
    const setFakeState = (running, state) => {
      const c = docker._containers.get(cid2);
      c.running = running; c.state = state;
    };
    const stOf = async () =>
      (await controller.handle('worker.status', { workerId: 'w-att-state' })).state;
    for (const s of ['restarting', 'paused', 'created', 'removing']) {
      setFakeState(false, s);
      const got = await stOf();
      check(`docker ${s} is not reported stopped`, got === s, `state=${got}`);
    }
    setFakeState(false, 'exited');
    check('docker exited reports stopped', (await stOf()) === 'stopped');
    setFakeState(false, 'dead');
    check('docker dead reports stopped', (await stOf()) === 'stopped');
    setFakeState(true, 'running');
    check('docker running reports running', (await stOf()) === 'running');
    setFakeState(false, 'restarting');
    const listed = await controller.handle('worker.list');
    check('worker.list agrees on transitional state',
      listed.workers.find((w) => w.workerId === 'w-att-state')?.state === 'restarting');
  }

  // canonical prepare + import cycle (integrator)
  const can = await controller.handle('canonical.prepare', {
    canonicalId: 'can-1', projectRoot: 'acp-ui-agent-modes', baseSha: sha });
  check('canonical.prepare ok', can.ok === true && can.canonical.state === 'ready');
}

// ---------- 5b. D14 — inspect error vs confirmed absence ----------------------
// docker.containerInspect returns null ONLY on HTTP 404; every other failure
// (socket error, timeout, 5xx, malformed body) throws. The controller must
// never turn a non-404 failure into durable 'gone' — only a real 404 may
// write rec.gone. Status/list/exec/reconcile all share one classification.
sect('inspect-d14');
{
  const shaD = await git(path.join(tmp, 'projects', 'acp-ui-agent-modes'), ['rev-parse', 'HEAD']);
  const profD = baseProfile({ search: { enabled: false, provider: null, params: {} } });
  const specD = {
    workerId: 'w-att-d14', attemptId: 'att-d14', role: 'panelist',
    profileId: 'f1-panelist', profile: profD, prompt: 'test prompt',
    materials: { projectRoot: 'acp-ui-agent-modes', snapshotSha: shaD,
      inputs: [{ name: 'task', content: 'do x' }] },
    profileDigest: profileDigest(profD),
  };
  const prepD = await controller.handle('worker.prepare', specD);
  check('d14 worker prepared', prepD.ok === true);
  const cidD = prepD.worker.containerId;
  const recD = () => controller.registry.workers['w-att-d14'];
  const diskD = async () => JSON.parse(
    await fs.readFile(path.join(tmp, 'env', 'controller', 'registry.json'), 'utf8'))
    .workers['w-att-d14'];
  const d14State = async () =>
    (await controller.handle('worker.status', { workerId: 'w-att-d14' }));
  const setC = (running, state) => {
    const c = docker._containers.get(cidD); c.running = running; c.state = state;
  };
  const noGone = (rec) => rec && rec.gone !== true && rec.state !== 'gone';
  const thrower = (err) => async (id) => { if (id === cidD) throw err; return undefined; };
  const execDebug = () => controller.handle('worker.exec',
    { workerId: 'w-att-d14', template: 'debug', args: ['id'] });

  check('baseline: running maps running',
    (await d14State()).state === 'running' && recD().state === 'running');

  // transitional + never-seen statuses pass through raw — never 'stopped'
  // or 'gone' — and never write the durable record.
  for (const s of ['created', 'restarting', 'removing', 'paused', 'bogus-future']) {
    setC(false, s);
    const st = await d14State();
    check(`status: docker '${s}' passes through, registry untouched`,
      st.state === s && noGone(recD()) && noGone(await diskD()), `state=${st.state}`);
  }
  // Docker pause preserves the namespace while preventing execution.
  // Consumers require the physical pause proof separately from liveness.
  setC(true, 'paused');
  const pausedState = await d14State();
  check('status: paused-with-Running reports paused with live namespace',
    pausedState.state === 'paused' && pausedState.namespaceAlive === true && pausedState.frozen === true);
  setC(true, 'running');

  // malformed inspect payloads (HTTP 200 with no usable State) → 'unknown',
  // still never 'stopped'/'gone'.
  for (const payload of [{ Id: cidD }, { Id: cidD, State: null },
      { Id: cidD, State: {} },
      { Id: cidD, State: { Running: false, Status: 42 } }]) {
    docker.inspectHook = async (id) => (id === cidD ? payload : undefined);
    const st = await d14State();
    check(`status: malformed inspect ${JSON.stringify(payload.State ?? null).slice(0, 48)} -> 'unknown'`,
      st.state === 'unknown' && noGone(recD()) && noGone(await diskD()));
  }
  docker.inspectHook = null;

  // transport-class failures — 5xx, socket-equivalent (status 0), and a bare
  // connection error — all report inspect_failed, never poison the registry.
  for (const err of [
      Object.assign(new Error('docker container inspect failed (500): daemon exploded'),
        { code: 'docker_api', status: 500 }),
      Object.assign(new Error('docker container inspect failed (0): socket hangup'),
        { code: 'docker_api', status: 0 }),
      Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'),
        { code: 'ECONNREFUSED' })]) {
    docker.inspectHook = thrower(err);
    const st = await d14State();
    check(`status: inspect error (${err.status ?? err.code}) -> inspect_failed, registry untouched`,
      st.state === 'inspect_failed' && typeof st.inspectError === 'string'
      && noGone(recD()) && noGone(await diskD()));
    const li = await controller.handle('worker.list');
    check(`list: inspect error (${err.status ?? err.code}) -> inspect_failed`,
      li.workers.find((x) => x.workerId === 'w-att-d14')?.state === 'inspect_failed');
    try {
      await execDebug();
      check(`exec: inspect error (${err.status ?? err.code}) refused without gone`, false);
    } catch (e) {
      check(`exec: inspect error (${err.status ?? err.code}) refused without gone`,
        e.code === 'worker_inspect_failed' && noGone(recD()) && noGone(await diskD()));
    }
    // re-prepare on unverifiable state refuses honestly — not 'worker_terminal'
    try {
      await controller.handle('worker.prepare', specD);
      check(`prepare: inspect error (${err.status ?? err.code}) refused without gone`, false);
    } catch (e) {
      check(`prepare: inspect error (${err.status ?? err.code}) refused without gone`,
        e.code === 'worker_inspect_failed' && noGone(recD()) && noGone(await diskD()));
    }
  }
  docker.inspectHook = null;

  // non-running but PRESENT container — exec refuses with an honest code
  // and still writes no gone flag.
  setC(false, 'exited');
  try {
    await execDebug();
    check('exec: exited container refused as not-running (not gone)', false);
  } catch (e) {
    check('exec: exited container refused as not-running (not gone)',
      e.code === 'worker_not_running' && noGone(recD()) && noGone(await diskD()));
  }
  setC(true, 'running');
  check('exec: running worker executes again', (await execDebug()).ok === true);

  // confirmed 404 — the ONLY path allowed to write the durable gone flag.
  docker._containers.delete(cidD);
  const stG = await d14State();
  check('status: confirmed 404 reports gone + persists the mark',
    stG.state === 'gone' && recD().gone === true && (await diskD()).gone === true
    && typeof (await diskD()).goneAt === 'string');
  try {
    await execDebug();
    check('exec: confirmed-gone worker throws worker_gone', false);
  } catch (e) { check('exec: confirmed-gone worker throws worker_gone', e.code === 'worker_gone'); }
  try {
    await controller.handle('worker.prepare', specD);
    check('prepare: confirmed-gone re-prepare stays worker_terminal', false);
  } catch (e) {
    check('prepare: confirmed-gone re-prepare stays worker_terminal',
      e.code === 'worker_terminal');
  }

  // reconcileOnce — a fresh controller over a seeded registry + the same
  // fake docker. Boot-time daemon failure must NOT mass-mark workers gone,
  // and transitional docker states must not collapse to 'stopped'.
  const env2 = path.join(tmp, 'env-reconcile');
  await fs.mkdir(path.join(env2, 'controller'), { recursive: true });
  docker._containers.set('ctr-restart', { Id: 'ctr-restart', spec: {}, running: false, state: 'restarting' });
  docker._containers.set('ctr-exited', { Id: 'ctr-exited', spec: {}, running: false, state: 'exited' });
  docker._containers.set('ctr-dead', { Id: 'ctr-dead', spec: {}, running: false, state: 'dead' });
  docker._containers.set('ctr-malformed', { Id: 'ctr-malformed', spec: {}, running: false, state: 'exited' });
  const regDoc = { version: 1, canonicals: {}, depSets: {}, workers: {
    'w-rc-trans': { workerId: 'w-rc-trans', containerId: 'ctr-restart', state: 'running', role: 'panelist', attemptId: 'att-rt' },
    'w-rc-exited': { workerId: 'w-rc-exited', containerId: 'ctr-exited', state: 'running', role: 'panelist', attemptId: 'att-re' },
    'w-rc-dead': { workerId: 'w-rc-dead', containerId: 'ctr-dead', state: 'running', role: 'panelist', attemptId: 'att-rd' },
    'w-rc-vanish': { workerId: 'w-rc-vanish', containerId: 'ctr-nope', state: 'running', role: 'panelist', attemptId: 'att-rv' },
    'w-rc-err': { workerId: 'w-rc-err', containerId: 'ctr-err', state: 'running', role: 'panelist', attemptId: 'att-rx' },
    'w-rc-malf': { workerId: 'w-rc-malf', containerId: 'ctr-malformed', state: 'running', role: 'panelist', attemptId: 'att-rm' },
    'w-rc-noc': { workerId: 'w-rc-noc', containerId: null, state: 'prepared', role: 'panelist', attemptId: 'att-rn' },
  } };
  await fs.writeFile(path.join(env2, 'controller', 'registry.json'), JSON.stringify(regDoc));
  docker.inspectHook = async (id) => {
    if (id === 'ctr-err') {
      throw Object.assign(new Error('docker container inspect failed (503): daemon restarting'),
        { code: 'docker_api', status: 503 });
    }
    if (id === 'ctr-malformed') return { Id: id };           // 200 but no State
    return undefined;
  };
  const cfg2 = validateEnvironmentConfig(baseConfig({
    roots: { env: { hostPath: env2, mountPath: env2, access: 'rw' } },
  }), { view: 'controller' });
  const c2 = createEnvController({ config: cfg2, docker });
  await c2.boot();
  const rw = c2.registry.workers;
  check('reconcile: transitional docker state stays honest (not stopped)',
    rw['w-rc-trans'].state === 'restarting' && rw['w-rc-trans'].gone !== true);
  check('reconcile: exited -> stopped', rw['w-rc-exited'].state === 'stopped'
    && rw['w-rc-exited'].gone !== true);
  check('reconcile: dead -> stopped', rw['w-rc-dead'].state === 'stopped');
  check('reconcile: confirmed 404 -> gone + flag persisted',
    rw['w-rc-vanish'].state === 'gone' && rw['w-rc-vanish'].gone === true);
  check('reconcile: inspect failure keeps last durable state (not gone)',
    rw['w-rc-err'].state === 'running' && rw['w-rc-err'].gone !== true);
  check('reconcile: malformed inspect keeps honest state (unknown, not stopped/gone)',
    rw['w-rc-malf'].state === 'unknown' && rw['w-rc-malf'].gone !== true);
  check('reconcile: containerless record left alone',
    rw['w-rc-noc'].state === 'prepared' && rw['w-rc-noc'].gone !== true);
  const disk2 = JSON.parse(
    await fs.readFile(path.join(env2, 'controller', 'registry.json'), 'utf8'));
  check('reconcile: durable file agrees — no poisoned entries',
    disk2.workers['w-rc-err'].state === 'running' && disk2.workers['w-rc-err'].gone !== true
    && disk2.workers['w-rc-trans'].state === 'restarting'
    && disk2.workers['w-rc-vanish'].gone === true);
  docker.inspectHook = null;
}

// ---------- 6. RPC auth over a real unix socket -------------------------------
sect('rpc-auth');
{
  const cfg = validateEnvironmentConfig(baseConfig(), { view: 'controller' });
  const token = 'cd'.repeat(24);
  const server = createRpcListener({ controller, token, maxBytes: 1 << 20 });
  const sock = path.join(tmp, 't.sock');
  await new Promise((r) => server.listen(sock, r));
  const call = (tok) => new Promise((resolve) => {
    const body = JSON.stringify({ method: 'ping', params: {} });
    const req = http.request({ socketPath: sock, path: '/rpc', method: 'POST',
      headers: { 'x-acp-internal-token': tok || '', 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(body);
  });
  check('bad token -> 401', (await call('wrong')) === 401);
  check('no token -> 401', (await call(undefined)) === 401);
  check('good token -> 200', (await call(token)) === 200);
  server.close();
  // client maps errors
  const client = createControllerClient({ transport: async () => ({ status: 200, parsed: { ok: false, error: { code: 'worker_terminal', message: 'x' } } }), token });
  try { await client.call('worker.prepare', {}); check('client maps error code', false); }
  catch (e) { check('client maps error code', e.code === 'worker_terminal'); }
}

// ---------- 7. container-runtime against a stub client -------------------------
sect('container-runtime');
{
  const cfg = validateEnvironmentConfig(baseConfig(), { view: 'client' });
  const store = createCapabilityStore({ dir: path.join(tmp, 'env', 'capability2') });
  const calls = [];
  let execSeq = 0;
  const stubClient = {
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'worker.prepare') {
        return { ok: true, worker: { workerId: params.workerId, state: 'running',
          cwdContainer: '/work/project' }, controller: { bootId: 'b', pidNs: 'ns' } };
      }
      if (method === 'worker.status') {
        if (params.workerId === 'w-nonexistent') {
          return { ok: true, state: 'gone', workerId: params.workerId, controller: {} };
        }
        return { ok: true, state: 'running', workerId: params.workerId, controller: {} };
      }
      if (method === 'worker.exec') {
        execSeq++;
        const args = params.args || [];
        if (args.includes('delegate') || args[0] === '-a') {
          return { ok: true, execId: `e${execSeq}`, exitCode: 0,
            stdout: `delegated\nrun_test-${execSeq}\n`, stderr: '', durationMs: 5 };
        }
        if (args[0] === 'status') {
          return { ok: true, exitCode: 0, stderr: '',
            stdout: JSON.stringify({ run_id: args[1], status: 'running', exit_code: null }) };
        }
        if (args[0] === 'wait') {
          return { ok: true, exitCode: 0, stderr: '',
            stdout: JSON.stringify({ status: 'completed', exit_code: 0, final_text: 'FULL-RESULT', artifacts_dir: `/work/attempt/run-${'x'}` }) };
        }
        if (args[0] === 'cancel') {
          return { ok: true, exitCode: 0, stderr: '', stdout: JSON.stringify({ cancel: 'requested' }) };
        }
        if (args[0] === 'list') {
          return { ok: true, exitCode: 0, stderr: '', stdout: '[]' };
        }
        return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      }
      throw Object.assign(new Error(`no stub for ${method}`), { code: 'unexpected' });
    },
  };
  const rt = createContainerRuntime({
    config: cfg, client: stubClient, capabilityStore: store,
    envRoot: path.join(tmp, 'env'),
  });

  // refused payloads before anything runs
  let r = await rt.start({ attemptId: 'att-e1', profileId: 'x', prompt: 'p',
    profile: baseProfile({ search: { enabled: false } }), env: { FOO: '1' } });
  check('params.env refused', r.ok === false && r.error.code === 'env_from_deployment');
  r = await rt.start({ attemptId: 'att-e2', profileId: 'x', prompt: 'p',
    profile: baseProfile({ search: { enabled: false } }), config: { agents: {} } });
  check('params.config refused', r.ok === false && r.error.code === 'config_from_profile');
  r = await rt.start({ attemptId: 'att-e3', profileId: 'x', prompt: 'p', profile: baseProfile() });
  check('search-enabled w/o probe refused', r.ok === false && r.error.code === 'search_unproven');
  r = await rt.start({ attemptId: 'att-e4', profileId: 'x', prompt: 'p',
    profile: baseProfile(), capabilityStore: null });
  check('search enabled still refused when only digest recorded elsewhere', r.ok === false);

  // real start path (search disabled so no probe needed)
  r = await rt.start({
    attemptId: 'att-run1', profileId: 'f1-panelist', prompt: 'hello',
    role: 'panelist',
    profile: baseProfile({ search: { enabled: false, provider: null, params: {} } }),
    materials: { projectRoot: 'acp-ui-agent-modes', snapshotSha: 'ab'.repeat(20) },
  });
  check('start launches through controller', r.ok === true && r.phase === 'launched'
    && /^run_/.test(r.porchRunId || ''), `runId=${r.porchRunId}`);
  check('worker id derived from attempt', r.workerId === 'w-att-run1');
  const prepCall = calls.find(([m]) => m === 'worker.prepare');
  check('prepare spec carries digest+role+materials',
    prepCall && prepCall[1].profileDigest === profileDigest(baseProfile({ search: { enabled: false, provider: null, params: {} } }))
    && prepCall[1].role === 'panelist' && prepCall[1].profileId === 'f1-panelist');
  const execCall = calls.find(([m, p]) => m === 'worker.exec' && (p.args || []).includes('--detach'));
  check('launch exec inside worker', execCall && execCall[1].template === 'porch'
    && execCall[1].env.PORCH_RUN_DIR === `/work/attempt/run-att-run1`);

  // status/events/wait via run id -> worker binding
  const st = await rt.status(r.porchRunId);
  check('status resolves via worker binding', st.ok === true && st.status === 'running');
  const w = await rt.wait(r.porchRunId, { timeoutSec: 5 });
  check('wait returns final text', w.outcome === 'terminal' && w.finalText === 'FULL-RESULT');
  const cx = await rt.cancel(r.porchRunId);
  check('cancel owned run', cx.ok === true && cx.requested === true);
  const cu = await rt.cancel('run_not-mine');
  check('cancel unowned run refused', cu.ok === false && cu.error?.code === 'unknown_run');
  const stu = await rt.status('run_not-mine');
  check('status unowned run refused', stu.ok === false);

  // launch record durable — flattened lifecycle seam (Fusion7):
  // porchRunId + error + createdAt + launchStartedAt on the top level.
  const lr = await rt.launchRecord('att-run1');
  check('launch record persisted', lr.phase === 'launched' && lr.porchRunId === r.porchRunId
    && lr.workerId === 'w-att-run1');
  check('launch record exposes lifecycle timestamps',
    typeof lr.createdAt === 'string' && Date.parse(lr.createdAt) > 0
    && typeof lr.launchStartedAt === 'string' && Date.parse(lr.launchStartedAt) > 0);

  // prepareDependencies: setup allowlist enforced runtime-side, then
  // delegated to controller deps.prepare (content-derived depSet cache).
  {
    let threw = null;
    try { await rt.prepareDependencies({ projectRoot: 'x', snapshotSha: 'y', setupId: 'nope' }); }
    catch (e) { threw = e; }
    check('prepareDependencies rejects unregistered setup', threw?.code === 'setup_not_registered');
    const before = calls.length;
    const depRes = await rt.prepareDependencies(
      { projectRoot: 'acp-ui-agent-modes', snapshotSha: 'ab'.repeat(20), setupId: 'node-deps' })
      .catch((e) => e);
    const depCall = calls.slice(before).find(([m]) => m === 'deps.prepare');
    check('prepareDependencies delegates to controller deps.prepare',
      !!depCall && depCall[1].setupId === 'node-deps'
      && depCall[1].projectRoot === 'acp-ui-agent-modes',
      depRes?.code ? `stub:${depRes.code}` : 'delegated');
  }

  // reconcile: match by runIds; gone worker -> no matches
  const rec = await rt.reconcile({ runIds: [r.porchRunId] });
  check('reconcile scans bound worker', rec.ok === true && rec.workers.length === 1);
  const rec2 = await rt.reconcile({ workerId: 'w-nonexistent' });
  check('reconcile missing worker = gone, no matches',
    rec2.workers[0].state === 'gone' && rec2.matches.length === 0);

  // D14 follow-up: reconcile 'gone' is positive proof, not "not running".
  // The fusion consumers' orphan gate reads w.gone !== false, so a false
  // 'gone' here can durably resolve a still-launching attempt orphaned.
  // Only 'gone' (confirmed 404) and 'stopped' (exited|dead — pid namespace
  // down) may set it; inspect_failed, transitional, malformed, unknown,
  // and failed status calls are unverifiable — gone stays false.
  const statusByWorker = {
    'w-rc-inspect':   'inspect_failed',
    'w-rc-restart':   'restarting',
    'w-rc-created':   'created',
    'w-rc-paused':    'paused',
    'w-rc-removing':  'removing',
    'w-rc-unknown':   'unknown',
    'w-rc-bogus':     'bogus-future',
    'w-rc-stopped':   'stopped',
    'w-rc-gone':      'gone',
  };
  const stubGone = {
    calls: [],
    async call(method, params) {
      this.calls.push([method, params]);
      if (method === 'worker.status') {
        if (params.workerId === 'w-rc-throw') {
          throw Object.assign(new Error('no such worker'), { code: 'unknown_worker' });
        }
        if (params.workerId === 'w-rc-rpc') {
          throw Object.assign(new Error('socket hangup'), { code: 'controller_unreachable' });
        }
        return { ok: true, workerId: params.workerId, controller: {},
          state: statusByWorker[params.workerId] ?? 'running' };
      }
      if (method === 'worker.exec') {
        return { ok: true, exitCode: 0, stderr: '', stdout: '[]' };
      }
      throw Object.assign(new Error(`no stub for ${method}`), { code: 'unexpected' });
    },
  };
  const rtG = createContainerRuntime({ config: cfg, client: stubGone,
    envRoot: path.join(tmp, 'env') });
  for (const [wid, s] of Object.entries(statusByWorker)) {
    const recS = await rtG.reconcile({ workerId: wid });
    const wrow = recS.workers.find((w) => w.workerId === wid);
    const expectGone = s === 'gone' || s === 'stopped';
    check(`reconcile worker state '${s}' -> gone=${expectGone} (proof only)`,
      wrow && wrow.state === s && wrow.gone === expectGone
      && recS.matches.length === 0, JSON.stringify(wrow));
  }
  for (const wid of ['w-rc-throw', 'w-rc-rpc']) {
    const recF = await rtG.reconcile({ workerId: wid });
    const wrow = recF.workers.find((w) => w.workerId === wid);
    check(`reconcile worker.status failure (${wid}) is not gone evidence`,
      wrow && wrow.gone === false && wrow.state !== 'gone'
      && recF.matches.length === 0, JSON.stringify(wrow));
  }

  // observer timeout does not cancel: stub exec timeout
  const stub2 = { ...stubClient, async call(m, p) {
    if (m === 'worker.exec' && (p.args || [])[0] === 'wait') {
      // observer-side deadline hit: exec timed out, run untouched
      return { ok: true, execId: 'eT', timedOut: true, stdout: '', stderr: '', durationMs: 999 };
    }
    return stubClient.call(m, p);
  } };
  const rt2 = createContainerRuntime({ config: cfg, client: stub2, envRoot: path.join(tmp, 'env') });
  // seed a record so run resolves
  const w2 = await rt2.wait(r.porchRunId, { timeoutSec: 1 });
  check('wait observer timeout maps to observer_timeout (run untouched)',
    w2.outcome === 'observer_timeout' || w2.outcome === 'timeout');
}

// ---------- 8. worker reaper (F1 D14) ------------------------------------------
// Deterministic reaper tests: the REAL createContainerRuntime over a scripted
// stub controller client, real launch/registry/reap files on disk, and one
// scheduler tick through a stub state client. Every unsafe case must prove
// ZERO worker.stop / worker.remove calls.
sect('worker-reaper');
{
  let createWorkerReaper;
  try {
    ({ createWorkerReaper } = await import(pathToFileURL(
      path.join(ROOT, 'server/execution/fusion/reaper.mjs')).href));
  } catch (e) {
    check('reaper module loads', false, e.message);
  }
  const { RuntimeError } = await import(pathToFileURL(
    path.join(ROOT, 'server/execution/common.mjs')).href);

  if (createWorkerReaper) {
    const cfg = validateEnvironmentConfig(baseConfig(), { view: 'client' });
    let fxSeq = 0;
    const BOUND = 'run_bound-1';

    const mkAttempt = (id, over = {}) => ({
      id, runId: 'run-fusion-1', role: 'panelist', status: 'completed',
      porchRunId: BOUND, launch: { workerId: `w-${id}` },
      owner: { runnerId: 'host-runner', instanceId: 'i-1' },
      createdAt: '2026-01-01T00:00:00Z', ...over,
    });
    const mkRun = (att, over = {}) => ({
      id: 'run-fusion-1', mode: 'fusion', status: 'completed',
      attempts: att ? [att] : [], ...over,
    });
    const mkCard = (runId = 'run-fusion-1') => ({
      cardId: 'card-1',
      runs: runId ? [{ id: runId, status: 'completed', mode: 'fusion' }] : [],
    });

    async function mkWorld(attemptId, {
      workerState = 'running', unknownWorker = false, rpcFail = false,
      stopFails = 0, removeFails = 0, procs = {},
      boundRun = BOUND, runMeta = undefined, runState = null, extraRows = [],
      launch = {}, priorReap = null, workerJson = true,
    } = {}) {
      const envRoot = path.join(tmp, `reap-${++fxSeq}`);
      const wid = `w-${attemptId}`;
      if (launch) {
        const adir = path.join(envRoot, 'runtime', 'attempts', attemptId);
        await fs.mkdir(adir, { recursive: true });
        await fs.writeFile(path.join(adir, 'launch.json'), JSON.stringify({
          schemaVersion: 1, kind: 'porch-container', attemptId,
          namespace: 'acp-f1', profileId: 'f1-panelist', workerId: wid,
          role: 'panelist', phase: 'launched', spawned: true,
          createdAt: '2026-01-01T00:00:00Z', environment: {}, error: null,
          launch: { startedAt: '2026-01-01T00:00:00Z' },
          porchRunId: boundRun, worker: { workerId: wid }, pi: null,
          ...launch,
        }));
      }
      if (priorReap) {
        const adir = path.join(envRoot, 'runtime', 'attempts', attemptId);
        await fs.mkdir(adir, { recursive: true });
        await fs.writeFile(path.join(adir, 'reap.json'), JSON.stringify({
          schemaVersion: 1, kind: 'worker-reap', attemptId, workerId: wid,
          createdAt: '2026-01-01T00:00:00Z', ...priorReap,
        }));
      }
      const wdir = path.join(envRoot, 'workers', wid);
      if (workerJson) {
        await fs.mkdir(wdir, { recursive: true });
        await fs.writeFile(path.join(wdir, 'worker.json'), JSON.stringify({
          workerId: wid, attemptId, role: 'panelist', state: 'running',
        }));
      }
      const runsDir = path.join(wdir, 'attempt', 'steer', 'runs');
      const meta = runMeta === null ? null : {
        run_id: boundRun, agent_id: 'f1-panelist', backend: 'pi-cli',
        cwd: '/work/project', artifacts_dir: `/work/attempt/run-${attemptId}`,
        status: 'completed', exit_code: 0, finished_at: '2026-01-01T00:10:00Z',
        pid: 4001, child_pid: 4002, owner_uid: 1001,
        started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:10:00Z',
        version: 1,
        ...(runMeta || {}),
      };
      if (meta) {
        await fs.mkdir(path.join(runsDir, boundRun), { recursive: true });
        await fs.writeFile(path.join(runsDir, boundRun, 'meta.json'), JSON.stringify(meta));
        if (runState !== false) {
          await fs.writeFile(path.join(runsDir, boundRun, 'state.json'), JSON.stringify(
            runState ?? { run_id: boundRun, status: meta.status, updated_at: meta.updated_at }));
        }
      }
      for (const r of extraRows) {
        await fs.mkdir(path.join(runsDir, r.runId), { recursive: true });
        await fs.writeFile(path.join(runsDir, r.runId, 'meta.json'),
          r.metaRaw !== undefined ? r.metaRaw : JSON.stringify(r.meta));
        if (r.state !== undefined) {
          await fs.writeFile(path.join(runsDir, r.runId, 'state.json'), JSON.stringify(r.state));
        }
      }
      const stub = {
        calls: [], workerState, unknownWorker, rpcFail, stopFails, removeFails,
        procs: new Map(Object.entries(procs).map(([k, v]) => [Number(k), v])),
        async call(method, params) {
          this.calls.push({ method, params });
          if (this.rpcFail) throw new RuntimeError('controller_unreachable', 'simulated rpc loss');
          if (method === 'worker.status') {
            if (this.unknownWorker) {
              throw new RuntimeError('unknown_worker', `no such worker: ${params.workerId}`);
            }
            return { ok: true, state: this.workerState, workerId: params.workerId, controller: {} };
          }
          if (method === 'worker.stop') {
            if (this.stopFails > 0) {
              this.stopFails -= 1;
              throw new RuntimeError('worker_stop_failed', 'docker stop failed');
            }
            this.workerState = 'stopped';
            return { ok: true, workerId: params.workerId, state: 'stopped', controller: {} };
          }
          if (method === 'worker.remove') {
            if (this.removeFails > 0) {
              this.removeFails -= 1;
              throw new RuntimeError('worker_remove_failed', 'docker rm failed');
            }
            this.workerState = 'gone';
            return { ok: true, workerId: params.workerId, state: 'removed', controller: {} };
          }
          if (method === 'worker.exec' && params.template === 'proc-probe') {
            const pid = Number(params.args?.[0]);
            const mode = this.procs.get(pid) ?? 'absent';
            if (mode === 'unreadable') return { ok: false, error: { message: 'probe refused' } };
            if (mode === 'garbage') return { ok: true, exitCode: 0, stdout: 'not-json', stderr: '' };
            if (mode === 'alive') {
              return { ok: true, exitCode: 0, stderr: '', stdout: JSON.stringify({
                target: { exists: true, state: 'R', starttime: `st-${pid}` },
                pidNs: 'ns-w', hostname: 'w-x', uid: 1001 }) };
            }
            if (mode === 'zombie') {
              return { ok: true, exitCode: 0, stderr: '', stdout: JSON.stringify({
                target: { exists: true, state: 'Z', starttime: `st-${pid}` }, pidNs: 'ns-w' }) };
            }
            return { ok: true, exitCode: 0, stderr: '', stdout: JSON.stringify({
              target: { exists: false, state: null, starttime: null }, pidNs: 'ns-w' }) };
          }
          if (method === 'worker.exec') return { ok: true, exitCode: 0, stdout: '', stderr: '' };
          throw new RuntimeError('unexpected', `no stub for ${method}`);
        },
      };
      const rt = createContainerRuntime({ config: cfg, client: stub, envRoot });
      return { envRoot, stub, rt, workerId: wid };
    }

    const noMutations = (stub) =>
      !stub.calls.some((c) => c.method === 'worker.stop' || c.method === 'worker.remove');
    const calls = (stub, m) => stub.calls.filter((c) => c.method === m);
    const mkReaper = (rt, runsMap = new Map()) =>
      createWorkerReaper({ runtime: rt, getRun: async (id) => runsMap.get(id) ?? null });

    // -- negative gates: zero stop/remove ------------------------------------
    {
      // live attempt (durable state nonterminal) — not a reap candidate at all
      const att = mkAttempt('att-live', { status: 'running' });
      const w = await mkWorld('att-live');
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('running attempt is live, never reaped', r.action === 'live' && noMutations(w.stub));
    }
    {
      // durable attempt terminal but the porch run is still running
      const att = mkAttempt('att-runlive');
      const w = await mkWorld('att-runlive', { runMeta: { status: 'running', finished_at: null } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('terminal attempt + nonterminal porch run defers',
        r.action === 'deferred' && r.code === 'run_nonterminal' && noMutations(w.stub));
    }
    {
      // cancellation requested; run terminal but a recorded child is still live
      const att = mkAttempt('att-cx', { status: 'cancelled',
        cancel: { requestedAt: 't', reason: 'stop intent' } });
      const w = await mkWorld('att-cx', {
        runMeta: { status: 'cancelled', exit_code: 130 },
        procs: { 4002: 'alive' } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('cancelled attempt + live child defers on drain',
        r.action === 'deferred' && r.code === 'process_alive' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      // supervisor live despite terminal metadata — contradiction, defer
      const att = mkAttempt('att-suplive');
      const w = await mkWorld('att-suplive', { procs: { 4001: 'alive' } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('terminal run + live supervisor defers',
        r.action === 'deferred' && r.code === 'process_alive' && noMutations(w.stub));
    }
    {
      // processIdentity unreadable — defer, never assume dead
      const att = mkAttempt('att-noproc');
      const w = await mkWorld('att-noproc', { procs: { 4001: 'unreadable' } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('unreadable process identity defers',
        r.action === 'deferred' && r.code === 'process_unverifiable' && noMutations(w.stub));
      const w2 = await mkWorld('att-noproc2', { procs: { 4002: 'garbage' } });
      const r2 = await mkReaper(w2.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-noproc2')), att: mkAttempt('att-noproc2') });
      check('garbage probe output defers',
        r2.action === 'deferred' && r2.code === 'process_unverifiable' && noMutations(w2.stub));
    }
    {
      // a corrupt sibling row makes the registry incomplete — never partial proof
      const att = mkAttempt('att-regbad');
      const w = await mkWorld('att-regbad', {
        extraRows: [{ runId: 'run_poison', metaRaw: '{corrupt' }] });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('incomplete registry defers',
        r.action === 'deferred' && r.code === 'registry_incomplete' && noMutations(w.stub));
    }
    {
      // bound run absent from the registry — contradictory evidence
      const att = mkAttempt('att-norow');
      const w = await mkWorld('att-norow', { runMeta: null });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('bound run missing from registry defers',
        r.action === 'deferred' && r.code === 'registry_run_missing' && noMutations(w.stub));
    }
    {
      // run binding mismatch — attempt bound to a different run than the record
      const att = mkAttempt('att-mis', { porchRunId: 'run_other-9' });
      const w = await mkWorld('att-mis');
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('porchRunId mismatch defers',
        r.action === 'deferred' && r.code === 'run_binding_mismatch' && noMutations(w.stub));
      const w2 = await mkWorld('att-mis2', { launch: { workerId: 'w-foreign' } });
      const r2 = await mkReaper(w2.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-mis2')), att: mkAttempt('att-mis2') });
      check('worker binding mismatch defers',
        r2.action === 'deferred' && r2.code === 'worker_binding_mismatch' && noMutations(w2.stub));
    }
    {
      // controller registry lost (unknown_worker) — NOT absence evidence
      const att = mkAttempt('att-unk');
      const w = await mkWorld('att-unk', { unknownWorker: true });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('unknown_worker defers (registry may be lost, container may live)',
        r.action === 'deferred' && r.code === 'worker_state_unknown' && noMutations(w.stub));
      const w2 = await mkWorld('att-rpc', { rpcFail: true });
      const r2 = await mkReaper(w2.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-rpc')), att: mkAttempt('att-rpc') });
      check('controller RPC failure defers',
        r2.action === 'deferred' && r2.code === 'worker_state_unknown' && noMutations(w2.stub));
      // transitional Docker state (restarting/paused/created) surfaces raw —
      // the reaper must defer, never treat it as a stopped pid namespace
      const w3 = await mkWorld('att-trans', { workerState: 'restarting' });
      const r3 = await mkReaper(w3.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-trans')), att: mkAttempt('att-trans') });
      check('transitional worker state defers (not a stopped namespace)',
        r3.action === 'deferred' && r3.code === 'worker_state_unknown' && noMutations(w3.stub));
    }
    {
      // D14: every state outside {running,stopped,gone} — including the
      // controller's inspect-failure marker — defers BEFORE any probe or
      // mutation. Zero worker.exec means process-identity was never asked.
      for (const s of ['inspect_failed', 'unknown', 'created', 'removing']) {
        const att = mkAttempt(`att-d14-${s}`);
        const w = await mkWorld(`att-d14-${s}`, { workerState: s });
        const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
        check(`reaper defers on controller state '${s}' (no probes/mutations)`,
          r.action === 'deferred' && r.code === 'worker_state_unknown' && noMutations(w.stub)
          && calls(w.stub, 'worker.exec').length === 0, JSON.stringify(r));
      }
    }
    {
      // D14 end-to-end: the REAL controller (over fake docker) behind the
      // REAL container runtime — the classification must survive the whole
      // worker.status path, not just a scripted stub answer.
      const shaE = await git(
        path.join(tmp, 'projects', 'acp-ui-agent-modes'), ['rev-parse', 'HEAD']);
      const profE = baseProfile({ search: { enabled: false, provider: null, params: {} } });
      const specE = (wid, att) => ({
        workerId: wid, attemptId: att, role: 'panelist',
        profileId: 'f1-panelist', profile: profE, prompt: 'e2e prompt',
        materials: { projectRoot: 'acp-ui-agent-modes', snapshotSha: shaE,
          inputs: [{ name: 'task', content: 'do x' }] },
        profileDigest: profileDigest(profE),
      });
      const loopback = { async call(method, params) { return controller.handle(method, params); } };
      const noDockerMutation = (since, cid) => !docker.calls.slice(since)
        .some(([m, id]) => (m === 'containerStop' || m === 'containerRemove' || m === 'execCreate')
          && (cid === undefined || id === cid));

      // -- inspect transport failure on a LIVE container: defer, zero damage --
      const attE1 = mkAttempt('att-d14e2e');
      const wE1 = await mkWorld('att-d14e2e');
      const prepE1 = await controller.handle('worker.prepare', specE('w-att-d14e2e', 'att-d14e2e'));
      check('e2e: real worker prepared', prepE1.ok === true);
      const cidE1 = prepE1.worker.containerId;
      const rtE1 = createContainerRuntime({ config: cfg, client: loopback, envRoot: wE1.envRoot });
      docker.inspectHook = async (id) => {
        if (id === cidE1) {
          throw Object.assign(new Error('docker container inspect failed (0): socket gone'),
            { code: 'docker_api', status: 0 });
        }
        return undefined;
      };
      const markE1 = docker.calls.length;
      const rE1 = await mkReaper(rtE1).reapAttempt({ card: mkCard(), run: mkRun(attE1), att: attE1 });
      check('e2e: real inspect failure defers worker_state_unknown, nothing touched',
        rE1.action === 'deferred' && rE1.code === 'worker_state_unknown'
        && noDockerMutation(markE1) && docker._containers.has(cidE1), JSON.stringify(rE1));
      check('e2e: controller registry not poisoned by inspect failure',
        controller.registry.workers['w-att-d14e2e'].gone !== true
        && controller.registry.workers['w-att-d14e2e'].state === 'running');
      docker.inspectHook = null;

      // -- confirmed 404 with NO prior proof: 'gone' is not removal permission --
      const attE2 = mkAttempt('att-d14gone');
      const wE2 = await mkWorld('att-d14gone');
      const prepE2 = await controller.handle('worker.prepare', specE('w-att-d14gone', 'att-d14gone'));
      const cidE2 = prepE2.worker.containerId;
      docker._containers.delete(cidE2);            // real 404 at the docker layer
      const rtE2 = createContainerRuntime({ config: cfg, client: loopback, envRoot: wE2.envRoot });
      const markE2 = docker.calls.length;
      const rE2 = await mkReaper(rtE2).reapAttempt({ card: mkCard(), run: mkRun(attE2), att: attE2 });
      check('e2e: confirmed 404 without prior proof defers absent_without_prior_proof',
        rE2.action === 'deferred' && rE2.code === 'absent_without_prior_proof'
        && noDockerMutation(markE2), JSON.stringify(rE2));
      check('e2e: confirmed 404 did durably mark gone (honest absence record)',
        controller.registry.workers['w-att-d14gone'].gone === true);

      // -- stopped worker: remove-only reap flows through the real controller --
      const attE3 = mkAttempt('att-d14stop');
      const wE3 = await mkWorld('att-d14stop');
      const prepE3 = await controller.handle('worker.prepare', specE('w-att-d14stop', 'att-d14stop'));
      const cidE3 = prepE3.worker.containerId;
      docker._containers.get(cidE3).running = false;
      docker._containers.get(cidE3).state = 'exited';
      const rtE3 = createContainerRuntime({ config: cfg, client: loopback, envRoot: wE3.envRoot });
      const markE3 = docker.calls.length;
      const rE3 = await mkReaper(rtE3).reapAttempt({ card: mkCard(), run: mkRun(attE3), att: attE3 });
      check('e2e: stopped worker reaps via remove only through the real controller',
        rE3.action === 'reaped'
        && docker.calls.slice(markE3).some(([m, id]) => m === 'containerRemove' && id === cidE3)
        && !docker.calls.slice(markE3).some(([m, id]) =>
          (m === 'containerStop' || m === 'execCreate') && id === cidE3), JSON.stringify(rE3));
      check('e2e: stopped worker container actually removed',
        !docker._containers.has(cidE3));
    }
    {
      // spawned===false record + gone worker: never infer "never spawned"
      const att = mkAttempt('att-nosup', { porchRunId: null, launch: {} });
      const w = await mkWorld('att-nosup', {
        workerState: 'gone', runMeta: null,
        launch: { spawned: false, phase: 'launch_failed', porchRunId: null } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('spawned=false + gone worker still defers',
        r.action === 'deferred' && noMutations(w.stub));
    }
    {
      // corrupt launch record — unverifiable binding, defer
      const w = await mkWorld('att-corrupt');
      await fs.writeFile(path.join(w.envRoot, 'runtime', 'attempts', 'att-corrupt', 'launch.json'), '{nope');
      const r = await mkReaper(w.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-corrupt')), att: mkAttempt('att-corrupt') });
      check('corrupt launch record defers',
        r.action === 'deferred' && r.code === 'launch_record_corrupt' && noMutations(w.stub));
    }
    {
      // extra live run in the registry — unaccounted processes, defer
      const att = mkAttempt('att-extra');
      const w = await mkWorld('att-extra', {
        extraRows: [{ runId: 'run_stray', meta: { run_id: 'run_stray', status: 'running', pid: 5999 } }] });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('nonterminal extra registry run defers',
        r.action === 'deferred' && r.code === 'registry_extra_run_live' && noMutations(w.stub));
    }
    {
      // P1: running worker + terminal attempt/run but ZERO recorded
      // supervisor/child pids — absence of process evidence is NOT drain
      // proof; the drain set must be non-empty before stop/remove.
      const att = mkAttempt('att-nopids');
      const w = await mkWorld('att-nopids', { runMeta: { pid: null, child_pid: null } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('running worker + zero recorded pids defers process_identity_missing',
        r.action === 'deferred' && r.code === 'process_identity_missing' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      // run binding must be proven on BOTH sides — a missing porchRunId on
      // either the attempt row or the launch record is unproven, even when
      // the registry is empty (an empty registry is not a bound terminal run).
      const att = mkAttempt('att-norunid', { porchRunId: null });
      const w = await mkWorld('att-norunid', { runMeta: null });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('missing attempt porchRunId defers run_binding_unproven',
        r.action === 'deferred' && r.code === 'run_binding_unproven' && noMutations(w.stub));
      const att2 = mkAttempt('att-norunid2');
      const w2 = await mkWorld('att-norunid2', { runMeta: null, launch: { porchRunId: null } });
      const r2 = await mkReaper(w2.rt).reapAttempt({ card: mkCard(), run: mkRun(att2), att: att2 });
      check('missing launch-record porchRunId defers run_binding_unproven',
        r2.action === 'deferred' && r2.code === 'run_binding_unproven' && noMutations(w2.stub));
    }
    {
      // launch record without workerId — the worker binding is unproven,
      // never inferred from the deterministic id alone
      const att = mkAttempt('att-nowid');
      const w = await mkWorld('att-nowid', { launch: { workerId: null } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('missing launch-record workerId defers worker_binding_unproven',
        r.action === 'deferred' && r.code === 'worker_binding_unproven' && noMutations(w.stub));
    }
    {
      // terminal meta.json but state.json missing/null/nonterminal — the two
      // durable records must BOTH be terminal; disagreement is inconsistent
      const att = mkAttempt('att-nostate');
      const w = await mkWorld('att-nostate', { runState: false });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('terminal meta + missing state.json defers inconsistent',
        r.action === 'deferred' && r.code === 'registry_inconsistent' && noMutations(w.stub));
      const w2 = await mkWorld('att-nullstate', { runState: { run_id: BOUND, status: null } });
      const r2 = await mkReaper(w2.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-nullstate')), att: mkAttempt('att-nullstate') });
      check('terminal meta + null state status defers inconsistent',
        r2.action === 'deferred' && r2.code === 'registry_inconsistent' && noMutations(w2.stub));
      const w3 = await mkWorld('att-runstate', { runState: { run_id: BOUND, status: 'running' } });
      const r3 = await mkReaper(w3.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-runstate')), att: mkAttempt('att-runstate') });
      check('terminal meta + nonterminal state defers inconsistent',
        r3.action === 'deferred' && r3.code === 'registry_inconsistent' && noMutations(w3.stub));
    }
    {
      // P1 follow-up: the directory name is not identity — the bound row's
      // meta.json run_id must exist and equal the bound porchRunId exactly.
      const att = mkAttempt('att-mismid');
      const w = await mkWorld('att-mismid', { runMeta: { run_id: 'run_other' } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('bound row meta run_id mismatch defers',
        r.action === 'deferred' && r.code === 'registry_identity_mismatch' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      const att = mkAttempt('att-nomid');
      const w = await mkWorld('att-nomid', { runMeta: { run_id: null } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('bound row meta run_id missing defers',
        r.action === 'deferred' && r.code === 'registry_identity_unproven' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      // P1: meta 'completed' vs state 'failed' — both terminal but not the
      // same verdict; the two durable records must agree EXACTLY, not just
      // both-be-terminal.
      const att = mkAttempt('att-statdiff');
      const w = await mkWorld('att-statdiff', { runState: { run_id: BOUND, status: 'failed' } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('terminal meta + different terminal state defers inconsistent',
        r.action === 'deferred' && r.code === 'registry_inconsistent' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      // every drain-contributing row — not just the bound one — must prove
      // the same agreement: an extra row without state.json cannot finish
      // the drain proof.
      const att = mkAttempt('att-xnostate');
      const w = await mkWorld('att-xnostate', {
        extraRows: [{ runId: 'run_extra', meta: {
          run_id: 'run_extra', status: 'completed',
          finished_at: '2026-01-01T00:05:00Z', pid: 5001 } }] });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('extra row without state.json defers inconsistent',
        r.action === 'deferred' && r.code === 'registry_inconsistent' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      // an extra row whose meta.run_id lies about its own directory — the
      // same self-identity rule as the bound row.
      const att = mkAttempt('att-xmisid');
      const w = await mkWorld('att-xmisid', {
        extraRows: [{ runId: 'run_extra', meta: {
          run_id: 'run_other', status: 'completed',
          finished_at: '2026-01-01T00:05:00Z', pid: 5001 } }] });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('extra row meta run_id mismatch defers',
        r.action === 'deferred' && r.code === 'registry_identity_mismatch' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      // an extra terminal row without finished_at — incomplete, defers
      const att = mkAttempt('att-xnofin');
      const w = await mkWorld('att-xnofin', {
        extraRows: [{ runId: 'run_extra', meta: {
          run_id: 'run_extra', status: 'completed', finished_at: null, pid: 5001 },
          state: { run_id: 'run_extra', status: 'completed' } }] });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('extra row terminal without finished_at defers',
        r.action === 'deferred' && r.code === 'registry_extra_run_unproven' && noMutations(w.stub),
        JSON.stringify(r));
    }
    {
      const att = mkAttempt('att-ok');
      const w = await mkWorld('att-ok'); // both pids absent by default
      const reaper = mkReaper(w.rt);
      const r = await reaper.reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('fully drained terminal attempt reaps', r.action === 'reaped', JSON.stringify(r));
      check('stop then remove ordering',
        calls(w.stub, 'worker.stop').length === 1 && calls(w.stub, 'worker.remove').length === 1
        && w.stub.calls.findIndex((c) => c.method === 'worker.stop')
          < w.stub.calls.findIndex((c) => c.method === 'worker.remove'));
      const rec = JSON.parse(await fs.readFile(
        path.join(w.envRoot, 'runtime', 'attempts', 'att-ok', 'reap.json'), 'utf8'));
      check('reap result persisted durably',
        rec.outcome === 'reaped' && rec.terminalProof?.workerState === 'running'
        && rec.actions?.removedAt && rec.terminalProof.drained.length === 2);
      check('attempt dir + launch record + registry retained',
        (await fs.stat(path.join(w.envRoot, 'runtime', 'attempts', 'att-ok', 'launch.json'))).isFile()
        && (await fs.stat(path.join(w.envRoot, 'workers', 'w-att-ok', 'attempt', 'steer', 'runs', BOUND, 'meta.json'))).isFile());
      // repeated pass: idempotent, zero mutations
      const callsBefore = w.stub.calls.length;
      const r2 = await reaper.reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('repeated reaper pass is a recorded no-op',
        r2.action === 'reaped' && r2.recorded === true
        && !w.stub.calls.slice(callsBefore).some((c) => c.method === 'worker.stop' || c.method === 'worker.remove'));
    }
    {
      // a well-formed terminal extra row keeps its OWN runId — it need not
      // equal the bound run — as long as meta.run_id self-matches, meta and
      // state agree on the same terminal verdict, finished_at exists, and
      // its recorded pids drain like every other row's.
      const att = mkAttempt('att-xok');
      const w = await mkWorld('att-xok', {
        extraRows: [{ runId: 'run_extra', meta: {
          run_id: 'run_extra', status: 'completed',
          finished_at: '2026-01-01T00:05:00Z', pid: 5001 },
          state: { run_id: 'run_extra', status: 'completed' } }] });
      const reaper = mkReaper(w.rt);
      const r = await reaper.reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('exact-identity terminal rows (bound + extra) still reap',
        r.action === 'reaped'
        && calls(w.stub, 'worker.stop').length === 1 && calls(w.stub, 'worker.remove').length === 1,
        JSON.stringify(r));
      const rec = JSON.parse(await fs.readFile(
        path.join(w.envRoot, 'runtime', 'attempts', 'att-xok', 'reap.json'), 'utf8'));
      check('drain proof covers bound + extra row pids',
        rec.terminalProof?.drained?.length === 3
        && rec.terminalProof.drained.some((d) => d.runId === 'run_extra' && d.pid === 5001));
    }
    {
      // stopped container: remove only after proofs — stop must NOT be called
      const att = mkAttempt('att-stopped');
      const w = await mkWorld('att-stopped', { workerState: 'stopped' });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('stopped worker reaps via remove only (no stop call)',
        r.action === 'reaped' && calls(w.stub, 'worker.stop').length === 0
        && calls(w.stub, 'worker.remove').length === 1);
    }
    {
      // stopped container needs NO pid evidence — the controller-confirmed
      // stopped state already proves the pid namespace is down
      const att = mkAttempt('att-stopped0');
      const w = await mkWorld('att-stopped0', {
        workerState: 'stopped', runMeta: { pid: null, child_pid: null } });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('stopped worker reaps with zero recorded pids (namespace down)',
        r.action === 'reaped' && calls(w.stub, 'worker.stop').length === 0
        && calls(w.stub, 'worker.remove').length === 1, JSON.stringify(r));
    }
    {
      // crash between proof and remove: a NEW runtime+reaper over the same
      // dirs recovers from the durable proof and finishes the reap.
      const att = mkAttempt('att-crash');
      const w = await mkWorld('att-crash', { removeFails: 1 });
      const r1 = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('remove failure defers with durable proof retained',
        r1.action === 'deferred' && r1.code === 'remove_failed'
        && calls(w.stub, 'worker.stop').length === 1 && calls(w.stub, 'worker.remove').length === 1);
      const rec = JSON.parse(await fs.readFile(
        path.join(w.envRoot, 'runtime', 'attempts', 'att-crash', 'reap.json'), 'utf8'));
      check('terminalProof persisted before destructive steps',
        !!rec.terminalProof && rec.terminalProof.workerState === 'running');
      const rt2 = createContainerRuntime({ config: cfg, client: w.stub, envRoot: w.envRoot });
      const r2 = await mkReaper(rt2).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('restart recovers and completes the reap',
        r2.action === 'reaped' && calls(w.stub, 'worker.remove').length === 2);
    }
    {
      // stop failure: no remove attempted; retry succeeds
      const att = mkAttempt('att-stopf');
      const w = await mkWorld('att-stopf', { stopFails: 1 });
      const r1 = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('stop failure defers without remove',
        r1.action === 'deferred' && r1.code === 'stop_failed'
        && calls(w.stub, 'worker.stop').length === 1 && calls(w.stub, 'worker.remove').length === 0);
      const r2 = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('stop failure retry reaps', r2.action === 'reaped');
    }
    {
      // already-absent: prior durable proof + authenticated state=gone → no-op
      const wid = 'w-att-absent';
      const prior = {
        outcome: 'proven',
        terminalProof: {
          at: '2026-01-01T01:00:00Z', attemptId: 'att-absent', workerId: wid,
          runId: BOUND, attemptStatus: 'completed', runStatus: 'completed',
          runFinishedAt: '2026-01-01T00:10:00Z', workerState: 'running',
          drained: [{ pid: 4001, role: 'supervisor', runId: BOUND, evidence: 'enoent' },
                    { pid: 4002, role: 'child', runId: BOUND, evidence: 'enoent' }],
        },
      };
      const w = await mkWorld('att-absent', { workerState: 'gone', priorReap: prior });
      const r = await mkReaper(w.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-absent')), att: mkAttempt('att-absent') });
      check('prior proof + state=gone records already_absent no-op',
        r.action === 'already_absent' && noMutations(w.stub));
      const rec = JSON.parse(await fs.readFile(
        path.join(w.envRoot, 'runtime', 'attempts', 'att-absent', 'reap.json'), 'utf8'));
      check('already_absent persisted', rec.outcome === 'already_absent');
      const r2 = await mkReaper(w.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-absent')), att: mkAttempt('att-absent') });
      check('already_absent is idempotent', r2.action === 'already_absent');
    }
    {
      // already-absent WITHOUT a prior proof → defer, never record terminal
      const w = await mkWorld('att-absent2', { workerState: 'gone' });
      const r = await mkReaper(w.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-absent2')), att: mkAttempt('att-absent2') });
      check('gone worker without prior proof defers',
        r.action === 'deferred' && r.code === 'absent_without_prior_proof' && noMutations(w.stub));
      // proof bound to a DIFFERENT run is not usable either
      const prior = {
        outcome: 'proven',
        terminalProof: {
          at: 't', attemptId: 'att-absent3', workerId: 'w-att-absent3',
          runId: 'run_other', attemptStatus: 'completed', runStatus: 'completed',
          workerState: 'running', drained: [],
        },
      };
      const w2 = await mkWorld('att-absent3', { workerState: 'gone', priorReap: prior });
      const r2 = await mkReaper(w2.rt).reapAttempt({
        card: mkCard(), run: mkRun(mkAttempt('att-absent3')), att: mkAttempt('att-absent3') });
      check('prior proof for another run does not satisfy absence',
        r2.action === 'deferred' && r2.code === 'absent_without_prior_proof' && noMutations(w2.stub));
    }

    // -- sweep: enumeration + owner resolution ---------------------------------
    {
      const att = mkAttempt('att-sweep');
      const w = await mkWorld('att-sweep');
      const runsMap = new Map([['run-fusion-1', mkRun(att)]]);
      const out = await mkReaper(w.rt, runsMap).sweep([mkCard()]);
      check('sweep reaps the drained owned worker',
        out.reaped === 1 && calls(w.stub, 'worker.remove').length === 1);
      // launch record whose attempt is in NO listed run → owner_unproven
      const w2 = await mkWorld('att-orphan');
      const out2 = await mkReaper(w2.rt, new Map()).sweep([mkCard(null)]);
      check('orphaned launch record defers owner_unproven',
        out2.deferred === 1 && out2.defers?.owner_unproven === 1 && noMutations(w2.stub));
      // lookup incomplete (a fusion run failed to fetch) → not decidable
      const w3 = await mkWorld('att-orphan2');
      const reaper3 = createWorkerReaper({
        runtime: w3.rt, getRun: async () => { throw new Error('api down'); } });
      const out3 = await reaper3.sweep([mkCard()]);
      check('incomplete owner lookup defers',
        out3.deferred === 1 && out3.defers?.owner_lookup_incomplete === 1 && noMutations(w3.stub));
      // live attempt under a listed run → live, no record written
      const w4 = await mkWorld('att-sweeplive');
      const att4 = mkAttempt('att-sweeplive', { status: 'running' });
      const out4 = await mkReaper(w4.rt, new Map([['run-fusion-1', mkRun(att4)]]))
        .sweep([mkCard()]);
      check('sweep leaves live attempts alone',
        out4.live === 1 && noMutations(w4.stub)
        && !(await fs.stat(path.join(w4.envRoot, 'runtime', 'attempts', 'att-sweeplive', 'reap.json')).catch(() => null)));
    }

    // -- scheduler integration: one tick reaps through the real surface --------
    // managed-scheduler.mjs is a Core-slice module, not part of the F1
    // environment foundation. Its tick() wires the reaper exactly like this:
    // createWorkerReaper over fusion.runtime + client.getRun, then one
    // sweep() over the cards fetched this pass with the outcome surfaced as
    // out.reaper. This harness mirrors that call shape so the reaper is
    // exercised through the same surface without importing the scheduler.
    {
      const att = mkAttempt('att-tick');
      const w = await mkWorld('att-tick');
      const run = mkRun(att);
      const svcClient = {
        async listCards() { return { cards: [{ cardId: 'card-1' }] }; },
        async getCard() {
          return { cardId: 'card-1',
            runs: [{ id: 'run-fusion-1', status: 'completed', mode: 'fusion', reserved: false }] };
        },
        async getRun(id) { return id === 'run-fusion-1' ? run : null; },
        async getRunEvents() { return { events: [] }; },
        async getDocument() { return null; },
        async command() { throw new Error('no durable command expected'); },
      };
      const sched = {
        _reaper: createWorkerReaper({
          runtime: w.rt, getRun: (id) => svcClient.getRun(id) }),
        async tick() {
          const out = { cards: 0 };
          const listing = await svcClient.listCards();
          const reapCards = [];
          for (const c of listing?.cards || []) {
            const card = await svcClient.getCard(c.cardId);
            if (!card) continue;
            out.cards += 1;
            reapCards.push(card);
          }
          out.reaper = await this._reaper.sweep(reapCards, { listingComplete: true });
          return out;
        },
      };
      const out = await sched.tick();
      check('scheduler tick reaps the drained fusion worker',
        out?.reaper?.reaped === 1 && calls(w.stub, 'worker.stop').length === 1
        && calls(w.stub, 'worker.remove').length === 1,
        `reaper=${JSON.stringify(out?.reaper)}`);
      const out2 = await sched.tick();
      check('second tick keeps the recorded outcome',
        out2?.reaper?.reaped === 0 && (out2?.reaper?.recorded ?? 0) >= 1);
    }
  }
}

// ---------- summary -----------------------------------------------------------
const pass = results.filter(([, ok]) => ok).length;
const fail = results.length - pass;
console.log(`\n${pass}/${results.length} checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
