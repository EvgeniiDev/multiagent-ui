#!/usr/bin/env node
// scripts/test_runtime_lifecycle_extensions.mjs — runtime-side lifecycle
// extension tests (controller-extension contract, parent-owned wrappers).
//
// Covers ONLY runner-owned runtime/helper surface:
//   * freezeWorker/thawWorker dispatch worker.freeze/thaw with the exact
//     registered workerId (controller verifies pause/unpause + persists);
//   * swarmSnapshot dispatches swarm.snapshot (canonicalId+generation) and
//     returns materials incl. snapshotId;
//   * prepareDependencies accepts the snapshot form AND the registered
//     canonicalId form (setup allowlist enforced runtime-side);
//   * worker.prepare materials pass snapshotId through ONLY when present
//     (absent key omitted — controller treats a present key as a binding
//     claim) and pass scratch through verbatim;
//   * discovered runId persists BEFORE waits/cancellation: launchRecord
//     carries porchRunId + createdAt/launchStartedAt; wait's
//     observer_timeout preserves worker/run (no failure recorded);
//     workerForRun misses stay unknown (never a guessed binding);
//   * reconcile per-worker registryReadable:true ONLY on a successful
//     complete list parse — list failure on a running worker is
//     registryReadable:false + registryError (never misread as absence),
//     non-running/absent workers are registryReadable:false.
//
// No docker, no network: stub controller client + real runtime code.
// Usage: node scripts/test_runtime_lifecycle_extensions.mjs

import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateEnvironmentConfig } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/env-config.mjs')).href);
const { profileDigest } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/agent-profile.mjs')).href);
const { createContainerRuntime } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/container-runtime.mjs')).href);

const results = [];
let section = '';
function sect(name) { section = name; console.log(`\n== ${name}`); }
function check(name, ok, extra = '') {
  results.push([`${section} :: ${name}`, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'f1-rt-ext-'));

function baseConfig(over = {}) {
  const r = (n) => path.join(tmp, n);
  return {
    schemaVersion: 1,
    environment: {
      socketPath: 'controller/env.sock', tokenFile: 'controller/channel-token',
      registryFile: 'controller/registry.json',
      workerNamePrefix: 'acp-f1-w-', networkNamePrefix: 'acp-f1-n-',
      labelPrefix: 'ai.acp.f1', workerUid: 1001, workerGid: 1001,
      maxExecMs: 60000, maxOutputBytes: 1 << 20, maxInputBytes: 1 << 18,
      maxPromptBytes: 1 << 19, allowDebugExec: true,
      egressGateway: {
        alias: 'egress-gw', proxyPort: 3128, proxyUrl: 'http://egress-gw:3128',
        labelSelector: 'ai.acp.f1=egress-gw',
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
    },
    images: { worker: { ref: 'acp-f1-worker:test' } },
    roles: {
      panelist:   { projectMode: 'snapshot-ro',  inputs: ['task'], deps: false, canonical: false },
      judge:      { projectMode: 'snapshot-ro',  inputs: ['task'], deps: false, canonical: false },
      integrator: { projectMode: 'private-repo', inputs: ['task'], deps: true,  canonical: true },
      setup:      { projectMode: 'workdir-rw',   inputs: [],       deps: false, canonical: false, setup: true },
      probe:      { projectMode: 'none',         inputs: ['task'], deps: false, canonical: false },
      'swarm-participant': { projectMode: 'snapshot-ro', inputs: ['scratch'],
        deps: false, canonical: false },
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
    },
    egress: { allowlist: [{ host: 'anymodel.org', ports: [443], kind: 'provider' }] },
    setups: {
      'node-deps': { argv: ['npm', 'ci', '--ignore-scripts'],
        lockfiles: ['package-lock.json'], depPath: 'node_modules',
        checkArgv: ['node', '-e', '1'] },
    },
  };
}

function baseProfile(over = {}) {
  return {
    schemaVersion: 1, profileId: 'f1-panelist', pi: { version: '0.85.1' },
    image: 'worker', provider: 'zen-relay',
    model: 'zen-relay/muse-spark-1.3-contributor-free', thinking: 'low',
    skills: [], extensions: [], tools: ['read', 'bash'],
    search: { enabled: false, provider: null, params: {} },
    launch: { progress: 'none', extraFlags: [] }, systemPromptFile: null,
    ...over,
  };
}

// Stub controller: records every call, answers the extension RPCs with the
// controller's documented shapes; porch exec answers the launch handshake.
function stubClient(calls, { listMode = 'ok' } = {}) {
  let execSeq = 0;
  return {
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'worker.prepare') {
        return { ok: true, worker: { workerId: params.workerId, state: 'running',
          cwdContainer: '/work/project' }, controller: { bootId: 'b' } };
      }
      if (method === 'worker.status') {
        if (params.workerId === 'w-gone') return { ok: true, state: 'gone',
          workerId: params.workerId, controller: {} };
        return { ok: true, state: 'running', workerId: params.workerId, controller: {} };
      }
      if (method === 'worker.exec') {
        execSeq++;
        const args = params.args || [];
        if (args.includes('--detach') || args[0] === '-a') {
          return { ok: true, execId: `e${execSeq}`, exitCode: 0,
            stdout: `delegated\nrun_test-${execSeq}\n`, stderr: '', durationMs: 5 };
        }
        if (args[0] === 'list') {
          if (listMode === 'fail') {
            return { ok: true, exitCode: 1, stdout: '',
              stderr: 'porch: registry unreadable', durationMs: 5 };
          }
          return { ok: true, exitCode: 0, stderr: '', stdout: '[]' };
        }
        if (args[0] === 'wait') {
          return { ok: true, exitCode: 0, stderr: '',
            stdout: JSON.stringify({ status: 'running', timed_out: true }) };
        }
        return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      }
      if (method === 'worker.freeze') {
        return { ok: true, workerId: params.workerId, state: 'paused',
          frozen: true, controller: { bootId: 'b' } };
      }
      if (method === 'worker.thaw') {
        return { ok: true, workerId: params.workerId, state: 'running',
          frozen: false, controller: { bootId: 'b' } };
      }
      if (method === 'swarm.snapshot') {
        return { ok: true, canonicalId: params.canonicalId,
          generation: params.generation ?? 0,
          snapshotSha: 'ab'.repeat(20), treeSha: 'cd'.repeat(20),
          materials: { projectRoot: 'acp-ui-agent-modes',
            snapshotSha: 'ab'.repeat(20), snapshotId: 'ss-test' },
          controller: { bootId: 'b' } };
      }
      if (method === 'deps.prepare') {
        return { ok: true, depSetId: 'dep-test', cached: false,
          setupId: params.setupId, lockHash: 'lh',
          snapshotSha: params.snapshotSha ?? 'ab'.repeat(20),
          canonicalId: params.canonicalId ?? null, controller: { bootId: 'b' } };
      }
      throw Object.assign(new Error(`no stub for ${method}`), { code: 'unexpected' });
    },
  };
}

const cfg = validateEnvironmentConfig(baseConfig(), { view: 'client' });

sect('freeze/thaw wrappers');
{
  const calls = [];
  const rt = createContainerRuntime({ config: cfg, client: stubClient(calls),
    envRoot: path.join(tmp, 'env1') });
  const fz = await rt.freezeWorker('w-att-1');
  const th = await rt.thawWorker('w-att-1');
  check('freezeWorker dispatches worker.freeze with exact workerId',
    fz.ok === true && fz.state === 'paused' && fz.frozen === true
    && calls[0][0] === 'worker.freeze' && calls[0][1].workerId === 'w-att-1'
    && Object.keys(calls[0][1]).join() === 'workerId', JSON.stringify(calls[0]));
  check('thawWorker dispatches worker.thaw with exact workerId',
    th.ok === true && th.state === 'running' && th.frozen === false
    && calls[1][0] === 'worker.thaw' && calls[1][1].workerId === 'w-att-1');
}

sect('swarm snapshot wrapper');
{
  const calls = [];
  const rt = createContainerRuntime({ config: cfg, client: stubClient(calls),
    envRoot: path.join(tmp, 'env2') });
  const snap = await rt.swarmSnapshot({ canonicalId: 'can-x', generation: 3 });
  check('swarmSnapshot dispatches swarm.snapshot, returns materials',
    snap.ok === true && snap.materials.snapshotId === 'ss-test'
    && snap.materials.snapshotSha === 'ab'.repeat(20)
    && calls[0][0] === 'swarm.snapshot'
    && calls[0][1].canonicalId === 'can-x' && calls[0][1].generation === 3);
}

sect('deps wrapper: snapshot + canonicalId forms');
{
  const calls = [];
  const rt = createContainerRuntime({ config: cfg, client: stubClient(calls),
    envRoot: path.join(tmp, 'env3') });
  let threw = null;
  try { await rt.prepareDependencies({ projectRoot: 'x', snapshotSha: 'y', setupId: 'nope' }); }
  catch (e) { threw = e; }
  check('unregistered setupId rejected runtime-side',
    threw?.code === 'setup_not_registered');
  const snap = await rt.prepareDependencies(
    { projectRoot: 'acp-ui-agent-modes', snapshotSha: 'ab'.repeat(20), setupId: 'node-deps' });
  check('snapshot form delegates to deps.prepare',
    snap.depSetId === 'dep-test' && calls[0][0] === 'deps.prepare'
    && calls[0][1].projectRoot === 'acp-ui-agent-modes'
    && calls[0][1].canonicalId === undefined);
  const can = await rt.prepareDependencies({ setupId: 'node-deps', canonicalId: 'can-x' });
  check('registered canonicalId form delegates (no snapshot keys)',
    can.canonicalId === 'can-x' && calls[1][0] === 'deps.prepare'
    && calls[1][1].canonicalId === 'can-x'
    && calls[1][1].projectRoot === undefined
    && calls[1][1].snapshotSha === undefined);
}

sect('materials passthrough: snapshotId + scratch');
{
  const calls = [];
  const rt = createContainerRuntime({ config: cfg, client: stubClient(calls),
    envRoot: path.join(tmp, 'env4') });
  const r = await rt.start({ attemptId: 'att-mat', profileId: 'f1-panelist',
    prompt: 'hi', role: 'swarm-participant',
    profile: baseProfile(),
    materials: { projectRoot: 'acp-ui-agent-modes', snapshotSha: 'ab'.repeat(20),
      snapshotId: 'ss-abc', scratch: { id: 'own', mount: '/work/scratch' } } });
  const prep = calls.find(([m]) => m === 'worker.prepare');
  check('snapshotId+scratch reach worker.prepare verbatim',
    r.ok === true && prep?.[1]?.materials?.snapshotId === 'ss-abc'
    && prep?.[1]?.materials?.scratch?.id === 'own'
    && prep?.[1]?.materials?.scratch?.mount === '/work/scratch');
  const r2 = await rt.start({ attemptId: 'att-plain', profileId: 'f1-panelist',
    prompt: 'hi', role: 'panelist',
    profile: baseProfile(),
    materials: { projectRoot: 'acp-ui-agent-modes', snapshotSha: 'ab'.repeat(20) } });
  const plain = calls.filter(([m]) => m === 'worker.prepare').pop();
  check('absent snapshotId/scratch keys omitted (no false binding claim)',
    r2.ok === true && !('snapshotId' in (plain?.[1]?.materials ?? {}))
    && !('scratch' in (plain?.[1]?.materials ?? {})));
}

sect('discovery persistence + unknown-run handshake');
{
  const calls = [];
  const rt = createContainerRuntime({ config: cfg, client: stubClient(calls),
    envRoot: path.join(tmp, 'env5') });
  const r = await rt.start({ attemptId: 'att-life', profileId: 'f1-panelist',
    prompt: 'hi', role: 'panelist',
    profile: baseProfile(),
    materials: { projectRoot: 'acp-ui-agent-modes', snapshotSha: 'ab'.repeat(20) } });
  const lr = await rt.launchRecord('att-life');
  check('discovered runId durable BEFORE waits/cancellation',
    lr.phase === 'launched' && lr.porchRunId === r.porchRunId
    && typeof lr.createdAt === 'string' && Date.parse(lr.createdAt) > 0
    && typeof lr.launchStartedAt === 'string'
    && Date.parse(lr.launchStartedAt) > 0);
  const w = await rt.wait(r.porchRunId, { timeoutSec: 0 });
  check('wait timeout preserves worker/run (not failed)',
    (w.outcome === 'timeout' || w.outcome === 'observer_timeout')
    && w.terminal !== true);
  const lr2 = await rt.launchRecord('att-life');
  check('wait leaves durable binding intact',
    lr2.porchRunId === r.porchRunId && lr2.phase === 'launched');
  const unk = await rt.status('run_not-mine');
  check('unknown runId stays unknown (no guessed binding)',
    unk.ok === false && unk.error?.code === 'unknown_run');
  const unkW = await rt.wait('run_not-mine', { timeoutSec: 0 });
  check('unknown wait stays unknown (no guessed binding)',
    unkW.outcome === 'error' && unkW.error?.code === 'unknown_run');
}

sect('reconcile registryReadable');
{
  const callsOk = [];
  const rtOk = createContainerRuntime({ config: cfg, client: stubClient(callsOk),
    envRoot: path.join(tmp, 'env6') });
  const recOk = await rtOk.reconcile({ workerId: 'w-live' });
  check('successful complete list => registryReadable:true',
    recOk.ok === true && recOk.workers[0].registryReadable === true
    && recOk.workers[0].gone === false);
  const callsFail = [];
  const rtFail = createContainerRuntime({
    config: cfg, client: stubClient(callsFail, { listMode: 'fail' }),
    envRoot: path.join(tmp, 'env6') });
  const recFail = await rtFail.reconcile({ workerId: 'w-live' });
  check('list failure on running worker is NOT absence',
    recFail.ok === true && recFail.workers[0].state === 'running'
    && recFail.workers[0].gone === false
    && recFail.workers[0].registryReadable === false
    && typeof recFail.workers[0].registryError === 'string'
    && recFail.matches.length === 0, JSON.stringify(recFail.workers[0]));
  const callsGone = [];
  const rtGone = createContainerRuntime({ config: cfg, client: stubClient(callsGone),
    envRoot: path.join(tmp, 'env6') });
  const recGone = await rtGone.reconcile({ workerId: 'w-gone' });
  check('gone worker: positive absence, registry unreadable',
    recGone.workers[0].state === 'gone' && recGone.workers[0].gone === true
    && recGone.workers[0].registryReadable === false
    && recGone.matches.length === 0);
}

const pass = results.filter(([, ok]) => ok).length;
const fail = results.length - pass;
console.log(`\n========== RUNTIME-EXT: ${pass}/${results.length} checks passed${fail ? `, ${fail} FAILED` : ''}`);
for (const [n, ok] of results.filter(([, ok]) => !ok)) console.log(`  FAILED: ${n}`);
process.exit(fail ? 1 : 0);
