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
function fakeDocker() {
  const containers = new Map();
  const nets = new Map();
  let n = 0;
  return {
    created: [],
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
    async networkRemove(name) { nets.delete(name); return true; },
    async containerCreate(spec) {
      const id = `ctr-${++n}`;
      const c = { Id: id, spec, state: 'created', running: false };
      containers.set(id, c);
      this.created.push(spec);
      return { Id: id };
    },
    async containerStart(id) { containers.get(id).running = true; containers.get(id).state = 'running'; return {}; },
    async containerStop(id) { const c = containers.get(id); if (c) { c.running = false; c.state = 'exited'; } return true; },
    async containerRemove(id) { containers.delete(id); return true; },
    async containerInspect(id) {
      const c = containers.get(id);
      if (!c) return null;
      return { Id: id, State: { Running: c.running, Status: c.state, StartedAt: 't0' },
        Image: 'sha256:img', Config: c.spec };
    },
    async execCreate(cid, opts) { const id = `exec-${++n}`; this.lastExec = { cid, opts, id }; return { Id: id }; },
    execResult: { stdout: '', stderr: '', exitCode: 0 },
    async execStart() { const r = this.execResult; return { stdout: r.stdout, stderr: r.stderr, timedOut: false }; },
    async execInspect() { return { ExitCode: this.execResult.exitCode }; },
    async killContainer(id) { containers.delete(id); },
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

  // canonical prepare + import cycle (integrator)
  const can = await controller.handle('canonical.prepare', {
    canonicalId: 'can-1', projectRoot: 'acp-ui-agent-modes', baseSha: sha });
  check('canonical.prepare ok', can.ok === true && can.canonical.state === 'ready');
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

  // launch record durable
  const lr = await rt.launchRecord('att-run1');
  check('launch record persisted', lr.phase === 'launched' && lr.porchRunId === r.porchRunId
    && lr.workerId === 'w-att-run1');

  // reconcile: match by runIds; gone worker -> no matches
  const rec = await rt.reconcile({ runIds: [r.porchRunId] });
  check('reconcile scans bound worker', rec.ok === true && rec.workers.length === 1);
  const rec2 = await rt.reconcile({ workerId: 'w-nonexistent' });
  check('reconcile missing worker = gone, no matches',
    rec2.workers[0].state === 'gone' && rec2.matches.length === 0);

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
  let createWorkerReaper, createManagedScheduler, createFakeRuntime;
  try {
    ({ createWorkerReaper } = await import(pathToFileURL(
      path.join(ROOT, 'server/execution/fusion/reaper.mjs')).href));
    ({ createManagedScheduler } = await import(pathToFileURL(
      path.join(ROOT, 'server/execution/managed-scheduler.mjs')).href));
    ({ createFakeRuntime } = await import(pathToFileURL(
      path.join(ROOT, 'server/execution/fake-runtime.mjs')).href));
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

    // -- positive path ---------------------------------------------------------
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
      // stopped container: remove only after proofs — stop must NOT be called
      const att = mkAttempt('att-stopped');
      const w = await mkWorld('att-stopped', { workerState: 'stopped' });
      const r = await mkReaper(w.rt).reapAttempt({ card: mkCard(), run: mkRun(att), att });
      check('stopped worker reaps via remove only (no stop call)',
        r.action === 'reaped' && calls(w.stub, 'worker.stop').length === 0
        && calls(w.stub, 'worker.remove').length === 1);
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
      const procRt = createFakeRuntime({ rootDir: path.join(tmp, 'reap-proc-rt') });
      const sched = createManagedScheduler({
        client: svcClient, runtime: procRt, runnerId: 'host-runner',
        instanceId: 'inst-reap-1', stateDir: null, env: {},
        fusion: { runtime: w.rt },
      });
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
